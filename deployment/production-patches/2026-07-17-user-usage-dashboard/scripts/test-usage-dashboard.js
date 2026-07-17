'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  buildPipeline,
  createUsageDashboardHandler,
  formatResult,
  getCutoff,
  parseQuery,
} = require(path.join(__dirname, '..', 'api', 'usage-dashboard.js'));

const userId = '507f1f77bcf86cd799439011';
const transactionUserId = { objectId: userId };
const options = parseQuery({ range: '7', model: 'gpt-5.6-sol', conversation: 'conversation-1', page: '2', limit: '500' });
assert.deepEqual(options, { range: '7', model: 'gpt-5.6-sol', conversation: 'conversation-1', page: 2, limit: 100 });
assert.equal(parseQuery({ range: 'bad', page: '-1', limit: '0' }).range, '30');
assert.equal(getCutoff('all'), null);

const pipeline = buildPipeline({ userId, transactionUserId, options, currencyRate: 7.2, timezone: 'Asia/Singapore', now: new Date('2026-07-18T00:00:00+08:00') });
assert.equal(pipeline[0].$match.user, userId, 'message query must be user-scoped');
assert.equal(pipeline[0].$match.isCreatedByUser, false, 'only assistant replies are billable rows');
const transactionLookup = pipeline.find((stage) => stage.$lookup?.from === 'transactions').$lookup;
const transactionExpression = JSON.stringify(transactionLookup.pipeline);
assert.match(transactionExpression, /"\$context","message"/, 'title and summarization rows must be excluded');
assert.match(transactionExpression, /objectId/, 'transaction query must be scoped to authenticated user');
const facet = pipeline.find((stage) => stage.$facet).$facet;
assert.equal(facet.logs.find((stage) => stage.$skip).$skip, 100);
assert.equal(facet.logs.find((stage) => stage.$limit).$limit, 100);

const formatted = formatResult({
  summary: [{ tokens: 1200, cost: 1.234567, costIncomplete: true, conversationInstances: 2, conversationTurns: 3, averageContext: 600, averageTurns: 1.5 }],
  trends: [{ date: '2026-07-18', tokens: 1200, cost: 1.234567, averageContext: 600 }],
  models: [{ model: 'gpt-5.6-sol', tokens: 900 }, { model: 'claude-fable-5', tokens: 300 }],
  logs: [{ cost: null }, { cost: 0.123456 }],
  pagination: [{ total: 2 }],
}, { page: 1, limit: 20 }, 'CNY');
assert.equal(formatted.summary.cost, 1.2346);
assert.equal(formatted.models[0].percentage, 75);
assert.equal(formatted.logs[0].cost, null, 'missing historical cost must remain null');
assert.equal(formatted.pagination.total, 2);

let capturedPipeline;
const fakeAggregate = {
  allowDiskUse(value) { assert.equal(value, false); return this; },
  async exec() { return [{}]; },
};
const mongoose = {
  models: { Message: { aggregate(value) { capturedPipeline = value; return fakeAggregate; } } },
  Types: { ObjectId: class ObjectId {
    static isValid(value) { return value === userId; }
    constructor(value) { this.value = value; }
  } },
};
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
}

(async () => {
  const handler = createUsageDashboardHandler({ mongoose, logger: { error() {} }, now: () => new Date('2026-07-18T00:00:00+08:00') });
  const ok = response();
  await handler({ user: { id: userId }, query: { range: '30' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(capturedPipeline[0].$match.user, userId);
  const unauthorized = response();
  await handler({ user: null, query: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  console.log('usage-dashboard tests: ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
