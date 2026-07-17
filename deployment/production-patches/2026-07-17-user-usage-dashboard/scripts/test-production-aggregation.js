'use strict';

const path = require('node:path');
const Module = require('node:module');

process.env.NODE_PATH = ['/app/api/node_modules', '/app/node_modules'].join(':');
Module._initPaths();
require('module-alias')({ base: '/app/api' });
const mongoose = require('mongoose');
require('/app/api/db');

const modulePath = process.argv[2] || '/tmp/lc-usage-dashboard-audit.js';
const { buildPipeline, formatResult, parseQuery } = require(path.resolve(modulePath));

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Message = mongoose.models.Message;
  const [scope] = await Message.aggregate([
    { $match: { isCreatedByUser: false, isTemporary: { $ne: true } } },
    { $group: { _id: '$user', replies: { $sum: 1 } } },
    { $sort: { replies: -1 } },
    { $limit: 1 },
  ]);
  if (!scope?._id || !mongoose.Types.ObjectId.isValid(scope._id)) {
    throw new Error('No valid production usage scope was found');
  }

  const options = parseQuery({ range: 'all', page: 1, limit: 5 });
  const pipeline = buildPipeline({
    userId: String(scope._id),
    transactionUserId: new mongoose.Types.ObjectId(scope._id),
    options,
    currencyRate: 7.2,
    timezone: 'Asia/Singapore',
    now: new Date(),
  });
  const [raw = {}] = await Message.aggregate(pipeline).allowDiskUse(false).exec();
  const result = formatResult(raw, options, 'CNY');

  if (result.pagination.total < result.logs.length) {
    throw new Error('Pagination total is smaller than the returned log page');
  }
  if (result.logs.some((row) => !row.conversationId || !row.model || row.turn < 1)) {
    throw new Error('A production log row is missing its stable identity fields');
  }
  if (result.summary.conversationTurns !== result.pagination.total) {
    throw new Error('Summary turns and successful log total diverged');
  }

  console.log(JSON.stringify({
    aggregation: 'ok',
    summaryTurns: result.summary.conversationTurns,
    conversationInstances: result.summary.conversationInstances,
    trendBuckets: result.trends.length,
    modelBuckets: result.models.length,
    returnedLogs: result.logs.length,
    totalLogs: result.pagination.total,
    costIncomplete: result.summary.costIncomplete,
  }));
})()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
