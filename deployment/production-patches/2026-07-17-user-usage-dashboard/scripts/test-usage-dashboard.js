'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  buildPipeline,
  createUsageDashboardHandler,
  formatResult,
  buildPricingIndex,
  decorateCostBreakdown,
  parsePricingCutoff,
  parsePricingCutoffModels,
  getCutoff,
  parseQuery,
} = require(path.join(__dirname, '..', 'api', 'usage-dashboard.js'));

const userId = '507f1f77bcf86cd799439011';
const transactionUserId = { objectId: userId };
const options = parseQuery({ range: '7', model: 'gpt-5.6-sol', conversation: 'conversation-1', page: '2', limit: '500' });
assert.deepEqual(options, { range: '7', model: 'gpt-5.6-sol', conversation: 'conversation-1', page: 2, limit: 100 });
assert.equal(parseQuery({ range: 'bad', page: '-1', limit: '0' }).range, '30');
assert.equal(getCutoff('all'), null);
assert.equal(parsePricingCutoff('2026-07-18T12:23:34.480Z').toISOString(), '2026-07-18T12:23:34.480Z');
assert.deepEqual(parsePricingCutoffModels('gpt-5.6-sol, claude-fable-5'), ['gpt-5.6-sol', 'claude-fable-5']);

const pipeline = buildPipeline({
  userId,
  transactionUserId,
  options,
  currencyRate: 1,
  timezone: 'Asia/Singapore',
  now: new Date('2026-07-18T00:00:00+08:00'),
  pricingCutoff: new Date('2026-07-17T00:00:00Z'),
  pricingCutoffModels: ['gpt-5.6-sol', 'claude-fable-5'],
});
assert.equal(pipeline[0].$match.user, userId, 'message query must be user-scoped');
assert.equal(pipeline[0].$match.isCreatedByUser, false, 'only assistant replies are billable rows');
const transactionLookup = pipeline.find((stage) => stage.$lookup?.from === 'transactions').$lookup;
const transactionExpression = JSON.stringify(transactionLookup.pipeline);
assert.match(transactionExpression, /"\$context","message"/, 'title and summarization rows must be excluded');
assert.match(transactionExpression, /objectId/, 'transaction query must be scoped to authenticated user');
assert.match(JSON.stringify(pipeline[0].$match), /gpt-5\.6-sol/, 'pricing cutoff models should be applied');
assert.match(JSON.stringify(pipeline[0].$match), /2026-07-17/, 'pricing cutoff timestamp should be applied');
for (const field of ['inputTokens', 'readTokens', 'writeTokens', 'structuredPromptRows', 'outputTokens']) {
  assert.match(transactionExpression, new RegExp(field), `transaction breakdown must include ${field}`);
}
const facet = pipeline.find((stage) => stage.$facet).$facet;
assert.equal(facet.logs.find((stage) => stage.$skip).$skip, 100);
assert.equal(facet.logs.find((stage) => stage.$limit).$limit, 100);

const formatted = formatResult({
  summary: [{ tokens: 1200, cost: 1.234567, costIncomplete: true, conversationInstances: 2, conversationTurns: 3, averageContext: 600, averageTurns: 1.5 }],
  trends: [{ date: '2026-07-18', tokens: 1200, cost: 1.234567, averageContext: 600 }],
  models: [{ model: 'gpt-5.6-sol', tokens: 900 }, { model: 'claude-fable-5', tokens: 300 }],
  logs: [
    { cost: null, tokenBreakdownAvailable: false },
    {
      cost: 0.123456,
      tokenBreakdownAvailable: true,
      inputTokens: 100,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      outputTokens: 30,
      tokens: 160,
    },
  ],
  pagination: [{ total: 2 }],
}, { page: 1, limit: 20 }, 'USD');
assert.equal(formatted.summary.cost, 1.2346);
assert.equal(formatted.models[0].percentage, 75);
assert.equal(formatted.logs[0].cost, null, 'missing historical cost must remain null');
assert.equal(formatted.logs[1].tokenBreakdownAvailable, true);
assert.equal(
  formatted.logs[1].inputTokens + formatted.logs[1].cacheReadTokens + formatted.logs[1].cacheWriteTokens + formatted.logs[1].outputTokens,
  formatted.logs[1].tokens,
);
const pricingIndex = buildPricingIndex({ endpoints: { custom: [{ name: 'MuskAPI', tokenConfig: { 'gpt-5.6-sol': { prompt: 0.6, completion: 3.6, cacheRead: 0.06, cacheWrite: 0.75 } } }] } });
const decorated = decorateCostBreakdown({ endpoint: 'MuskAPI', model: 'gpt-5.6-sol', cost: 0.01674, tokenBreakdownAvailable: true, inputTokens: 14492, cacheReadTokens: 61952, cacheWriteTokens: 0, outputTokens: 1202 }, pricingIndex);
assert.equal(decorated.costBreakdown.input.rate, 0.6);
assert.equal(decorated.costBreakdown.cacheRead.rate, 0.06);
assert.equal(decorated.costBreakdown.output.rate, 3.6);
assert.equal(decorated.costBreakdown.cacheWrite, undefined, 'zero-Token components must be omitted');
assert.equal(decorated.costBreakdownMatches, true);
const duplicatePricingIndex = buildPricingIndex({ endpoints: { custom: [
  { name: 'MuskAPI', tokenConfig: { 'gpt-5.6-sol': { prompt: 0.6, completion: 3.6, cacheRead: 0.06 } } },
  { name: 'MuskAPI-Secondary', tokenConfig: { 'gpt-5.6-sol': { prompt: 0.6, completion: 3.6, cacheRead: 0.06 } } },
] } });
const duplicateDecorated = decorateCostBreakdown({ endpoint: 'agents', model: 'gpt-5.6-sol', cost: 0.016442, tokenBreakdownAvailable: true, inputTokens: 2010, cacheReadTokens: 166400, cacheWriteTokens: 0, outputTokens: 1459 }, duplicatePricingIndex);
assert.equal(duplicateDecorated.costBreakdownAvailable, true, 'identical duplicate prices must resolve by model');
assert.equal(duplicateDecorated.costBreakdown.cacheWrite, undefined, 'missing zero-Token price must not block detail');
assert.equal(duplicateDecorated.costBreakdownMatches, true);
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
