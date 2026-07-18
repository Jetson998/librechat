'use strict';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const VALID_RANGES = new Set(['7', '30', 'all']);

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function parseQuery(query = {}) {
  const range = VALID_RANGES.has(String(query.range)) ? String(query.range) : '30';
  return {
    range,
    model: typeof query.model === 'string' ? query.model.trim().slice(0, 200) : '',
    conversation:
      typeof query.conversation === 'string' ? query.conversation.trim().slice(0, 200) : '',
    page: clampInteger(query.page, 1, 1, Number.MAX_SAFE_INTEGER),
    limit: clampInteger(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
  };
}

function getCutoff(range, now = new Date()) {
  if (range === 'all') {
    return null;
  }
  const days = Number(range);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function parsePricingCutoff(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parsePricingCutoffModels(value) {
  return String(value || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

function normalizePrice(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function buildPricingIndex(config = {}) {
  const source = config?.endpoints ? config : config?.overrides || config?.config || {};
  const byEndpointModel = new Map();
  const byModel = new Map();
  const ambiguousModels = new Set();
  for (const endpoint of source.endpoints?.custom || []) {
    for (const [model, rates] of Object.entries(endpoint.tokenConfig || {})) {
      const pricing = {
        prompt: normalizePrice(rates?.prompt),
        completion: normalizePrice(rates?.completion),
        cacheRead: normalizePrice(rates?.cacheRead),
        cacheWrite: normalizePrice(rates?.cacheWrite),
      };
      byEndpointModel.set(`${endpoint.name}\u0000${model}`, pricing);
      if (byModel.has(model)) ambiguousModels.add(model);
      else byModel.set(model, pricing);
    }
  }
  for (const model of ambiguousModels) byModel.delete(model);
  return { byEndpointModel, byModel };
}

function resolvePricing(pricingIndex, row) {
  if (!pricingIndex) return null;
  return (
    pricingIndex.byEndpointModel.get(`${row.endpoint}\u0000${row.model}`) ||
    pricingIndex.byModel.get(row.model) ||
    null
  );
}

function decorateCostBreakdown(row, pricingIndex) {
  const result = { ...row };
  if (!row.tokenBreakdownAvailable) {
    return { ...result, costBreakdownAvailable: false, costBreakdownMatches: false };
  }
  const pricing = resolvePricing(pricingIndex, row);
  const components = [
    ['input', row.inputTokens, pricing?.prompt],
    ['cacheRead', row.cacheReadTokens, pricing?.cacheRead],
    ['cacheWrite', row.cacheWriteTokens, pricing?.cacheWrite],
    ['output', row.outputTokens, pricing?.completion],
  ];
  if (!pricing || components.some(([, tokens, rate]) => !Number.isFinite(Number(tokens)) || rate == null)) {
    return { ...result, costBreakdownAvailable: false, costBreakdownMatches: false };
  }
  const costBreakdown = Object.fromEntries(
    components.map(([name, tokens, rate]) => [
      name,
      {
        tokens: Number(tokens),
        rate,
        cost: (Number(tokens) * rate) / 1000000,
      },
    ]),
  );
  const calculatedCost = Object.values(costBreakdown).reduce((total, item) => total + item.cost, 0);
  const actualCost = row.cost == null ? null : Number(row.cost);
  const tolerance = Math.max(0.0001, Math.abs(actualCost || 0) * 0.0005);
  return {
    ...result,
    costBreakdownAvailable: true,
    costBreakdown,
    calculatedCost,
    costBreakdownMatches: actualCost != null && Math.abs(calculatedCost - actualCost) <= tolerance,
  };
}

function buildFilteredMatch(options) {
  const match = {};
  if (options.model) {
    match.model = options.model;
  }
  if (options.conversation) {
    match.conversationId = options.conversation;
  }
  return Object.keys(match).length ? [{ $match: match }] : [];
}

function buildPipeline({
  userId,
  transactionUserId,
  options,
  currencyRate,
  timezone,
  now,
  pricingCutoff,
  pricingCutoffModels = [],
}) {
  const cutoff = getCutoff(options.range, now);
  const filteredMatch = buildFilteredMatch(options);
  const dateMatch = cutoff ? [{ $match: { createdAt: { $gte: cutoff } } }] : [];
  const pricingVisibility =
    pricingCutoff && pricingCutoffModels.length
      ? {
          $or: [
            { model: { $nin: pricingCutoffModels } },
            { createdAt: { $gte: pricingCutoff } },
          ],
        }
      : null;

  const summaryBranch = [
    ...filteredMatch,
    {
      $group: {
        _id: null,
        tokens: { $sum: '$usageTokens' },
        cost: { $sum: { $ifNull: ['$cost', 0] } },
        missingCostRows: { $sum: { $cond: [{ $eq: ['$cost', null] }, 1, 0] } },
        conversationIds: { $addToSet: '$conversationId' },
        conversationTurns: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        tokens: 1,
        cost: 1,
        costIncomplete: { $gt: ['$missingCostRows', 0] },
        conversationInstances: { $size: '$conversationIds' },
        conversationTurns: 1,
        averageContext: {
          $cond: [
            { $gt: [{ $size: '$conversationIds' }, 0] },
            { $divide: ['$tokens', { $size: '$conversationIds' }] },
            0,
          ],
        },
        averageTurns: {
          $cond: [
            { $gt: [{ $size: '$conversationIds' }, 0] },
            { $divide: ['$conversationTurns', { $size: '$conversationIds' }] },
            0,
          ],
        },
      },
    },
  ];

  const trendBranch = [
    ...filteredMatch,
    {
      $group: {
        _id: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone } },
        tokens: { $sum: '$usageTokens' },
        cost: { $sum: { $ifNull: ['$cost', 0] } },
        missingCostRows: { $sum: { $cond: [{ $eq: ['$cost', null] }, 1, 0] } },
        conversationIds: { $addToSet: '$conversationId' },
      },
    },
    {
      $project: {
        _id: 0,
        date: '$_id',
        tokens: 1,
        cost: 1,
        costIncomplete: { $gt: ['$missingCostRows', 0] },
        conversationInstances: { $size: '$conversationIds' },
        averageContext: {
          $cond: [
            { $gt: [{ $size: '$conversationIds' }, 0] },
            { $divide: ['$tokens', { $size: '$conversationIds' }] },
            0,
          ],
        },
      },
    },
    { $sort: { date: 1 } },
  ];

  const logProjection = {
    _id: 0,
    timestamp: '$createdAt',
    model: { $ifNull: ['$model', 'Unknown model'] },
    endpoint: { $ifNull: ['$endpoint', ''] },
    iconURL: { $ifNull: ['$iconURL', ''] },
    conversationId: 1,
    conversationTitle: { $ifNull: [{ $first: '$_conversation.title' }, '未命名对话'] },
    turn: '$turnNumber',
    tokens: '$usageTokens',
    cost: 1,
    tokenBreakdownAvailable: 1,
    inputTokens: 1,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    outputTokens: 1,
  };

  return [
    {
      $match: {
        user: userId,
        isCreatedByUser: false,
        isTemporary: { $ne: true },
        unfinished: { $ne: true },
        $and: [
          ...(pricingVisibility ? [pricingVisibility] : []),
          {
            $or: [
              { error: { $exists: false } },
              { error: null },
              { error: false },
              { error: '' },
            ],
          },
          {
            $or: [
              { text: { $type: 'string', $ne: '' } },
              { 'content.0': { $exists: true } },
              { 'files.0': { $exists: true } },
              { 'attachments.0': { $exists: true } },
            ],
          },
        ],
      },
    },
    {
      $setWindowFields: {
        partitionBy: '$conversationId',
        sortBy: { createdAt: 1 },
        output: { turnNumber: { $documentNumber: {} } },
      },
    },
    ...dateMatch,
    {
      $lookup: {
        from: 'transactions',
        let: { replyMessageId: '$messageId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$messageId', '$$replyMessageId'] },
                  { $eq: ['$user', transactionUserId] },
                  { $eq: ['$context', 'message'] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              rows: { $sum: 1 },
              tokens: { $sum: { $abs: { $ifNull: ['$rawAmount', 0] } } },
              tokenValue: { $sum: { $abs: { $ifNull: ['$tokenValue', 0] } } },
              promptRows: {
                $sum: { $cond: [{ $eq: ['$tokenType', 'prompt'] }, 1, 0] },
              },
              structuredPromptRows: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$tokenType', 'prompt'] },
                        { $ne: [{ $type: '$inputTokens' }, 'missing'] },
                        { $ne: [{ $type: '$readTokens' }, 'missing'] },
                        { $ne: [{ $type: '$writeTokens' }, 'missing'] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              inputTokens: { $sum: { $abs: { $ifNull: ['$inputTokens', 0] } } },
              cacheReadTokens: { $sum: { $abs: { $ifNull: ['$readTokens', 0] } } },
              cacheWriteTokens: { $sum: { $abs: { $ifNull: ['$writeTokens', 0] } } },
              outputTokens: {
                $sum: {
                  $cond: [
                    { $eq: ['$tokenType', 'completion'] },
                    { $abs: { $ifNull: ['$rawAmount', 0] } },
                    0,
                  ],
                },
              },
            },
          },
        ],
        as: '_transactionUsage',
      },
    },
    {
      $lookup: {
        from: 'conversations',
        let: { cid: '$conversationId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$conversationId', '$$cid'] }, { $eq: ['$user', userId] }],
              },
            },
          },
          { $project: { _id: 0, title: 1 } },
          { $limit: 1 },
        ],
        as: '_conversation',
      },
    },
    {
      $addFields: {
        _transactionRows: { $ifNull: [{ $first: '$_transactionUsage.rows' }, 0] },
        _promptRows: { $ifNull: [{ $first: '$_transactionUsage.promptRows' }, 0] },
        _structuredPromptRows: {
          $ifNull: [{ $first: '$_transactionUsage.structuredPromptRows' }, 0],
        },
        inputTokens: { $ifNull: [{ $first: '$_transactionUsage.inputTokens' }, 0] },
        cacheReadTokens: { $ifNull: [{ $first: '$_transactionUsage.cacheReadTokens' }, 0] },
        cacheWriteTokens: { $ifNull: [{ $first: '$_transactionUsage.cacheWriteTokens' }, 0] },
        outputTokens: { $ifNull: [{ $first: '$_transactionUsage.outputTokens' }, 0] },
        _fallbackTokens: {
          $add: [
            { $ifNull: ['$metadata.usage.input', 0] },
            { $ifNull: ['$metadata.usage.output', 0] },
            { $ifNull: ['$metadata.usage.cacheRead', 0] },
            { $ifNull: ['$metadata.usage.cacheWrite', 0] },
          ],
        },
      },
    },
    {
      $addFields: {
        usageTokens: {
          $cond: [
            { $gt: ['$_transactionRows', 0] },
            { $ifNull: [{ $first: '$_transactionUsage.tokens' }, 0] },
            '$_fallbackTokens',
          ],
        },
        cost: {
          $cond: [
            { $gt: ['$_transactionRows', 0] },
            {
              $multiply: [
                { $divide: [{ $ifNull: [{ $first: '$_transactionUsage.tokenValue' }, 0] }, 1000000] },
                currencyRate,
              ],
            },
            null,
          ],
        },
        tokenBreakdownAvailable: {
          $and: [
            { $gt: ['$_transactionRows', 0] },
            { $gt: ['$_promptRows', 0] },
            { $eq: ['$_promptRows', '$_structuredPromptRows'] },
          ],
        },
      },
    },
    {
      $facet: {
        summary: summaryBranch,
        trends: trendBranch,
        models: [
          ...filteredMatch,
          {
            $group: {
              _id: {
                model: { $ifNull: ['$model', 'Unknown model'] },
              },
              tokens: { $sum: '$usageTokens' },
              endpoint: { $first: { $ifNull: ['$endpoint', ''] } },
              iconURL: { $first: { $ifNull: ['$iconURL', ''] } },
            },
          },
          { $sort: { tokens: -1, '_id.model': 1 } },
          {
            $project: {
              _id: 0,
              model: '$_id.model',
              endpoint: 1,
              iconURL: 1,
              tokens: 1,
            },
          },
        ],
        modelOptions: [
          { $group: { _id: { $ifNull: ['$model', 'Unknown model'] } } },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, value: '$_id', label: '$_id' } },
        ],
        conversationOptions: [
          {
            $group: {
              _id: '$conversationId',
              title: { $first: { $ifNull: [{ $first: '$_conversation.title' }, '未命名对话'] } },
              updatedAt: { $max: '$createdAt' },
            },
          },
          { $sort: { updatedAt: -1 } },
          { $limit: 200 },
          { $project: { _id: 0, value: '$_id', label: '$title' } },
        ],
        logs: [
          ...filteredMatch,
          { $sort: { createdAt: -1, _id: -1 } },
          { $skip: (options.page - 1) * options.limit },
          { $limit: options.limit },
          { $project: logProjection },
        ],
        pagination: [...filteredMatch, { $count: 'total' }],
      },
    },
  ];
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatResult(raw, options, currency, pricingIndex = null) {
  const emptySummary = {
    tokens: 0,
    cost: 0,
    costIncomplete: false,
    conversationInstances: 0,
    conversationTurns: 0,
    averageContext: 0,
    averageTurns: 0,
  };
  const summary = { ...emptySummary, ...(raw.summary?.[0] || {}) };
  summary.cost = round(summary.cost, 4);
  summary.averageContext = round(summary.averageContext, 2);
  summary.averageTurns = round(summary.averageTurns, 2);

  const models = raw.models || [];
  const modelTokenTotal = models.reduce((total, item) => total + (item.tokens || 0), 0);

  return {
    currency,
    summary,
    trends: (raw.trends || []).map((item) => ({
      ...item,
      cost: round(item.cost, 4),
      averageContext: round(item.averageContext, 2),
    })),
    models: models.map((item) => ({
      ...item,
      percentage: modelTokenTotal > 0 ? round((item.tokens / modelTokenTotal) * 100, 1) : 0,
    })),
    modelOptions: raw.modelOptions || [],
    conversationOptions: raw.conversationOptions || [],
    logs: (raw.logs || []).map((item) =>
      decorateCostBreakdown(
        { ...item, cost: item.cost == null ? null : round(item.cost, 4) },
        pricingIndex,
      ),
    ),
    pagination: {
      page: options.page,
      limit: options.limit,
      total: raw.pagination?.[0]?.total || 0,
    },
  };
}

function createUsageDashboardHandler({ mongoose, logger, now = () => new Date() }) {
  return async function usageDashboardHandler(req, res) {
    try {
      const userId = String(req.user?.id || '');
      if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const Message = mongoose.models.Message;
      if (!Message) {
        throw new Error('Message model is not initialized');
      }

      const options = parseQuery(req.query);
      const currency = String(process.env.USER_USAGE_CURRENCY || 'USD').toUpperCase();
      const currencyRate = Number(process.env.USER_USAGE_USD_RATE || 1);
      const timezone = process.env.USER_USAGE_TIMEZONE || 'Asia/Singapore';
      const pricingCutoff = parsePricingCutoff(process.env.USER_USAGE_PRICING_CUTOFF);
      const pricingCutoffModels = parsePricingCutoffModels(process.env.USER_USAGE_PRICING_CUTOFF_MODELS);
      if (!Number.isFinite(currencyRate) || currencyRate <= 0) {
        throw new Error('USER_USAGE_USD_RATE must be a positive number');
      }

      const pipeline = buildPipeline({
        userId,
        transactionUserId: new mongoose.Types.ObjectId(userId),
        options,
        currencyRate,
        timezone,
        now: now(),
        pricingCutoff,
        pricingCutoffModels,
      });
      const [raw = {}] = await Message.aggregate(pipeline).allowDiskUse(false).exec();
      return res.json(formatResult(raw, options, currency, buildPricingIndex(req.config)));
    } catch (error) {
      logger?.error?.('[usage-dashboard] Failed to aggregate user usage', error);
      return res.status(500).json({ error: 'Unable to load usage statistics' });
    }
  };
}

module.exports = {
  buildPipeline,
  buildPricingIndex,
  createUsageDashboardHandler,
  decorateCostBreakdown,
  formatResult,
  getCutoff,
  parsePricingCutoff,
  parsePricingCutoffModels,
  parseQuery,
};
