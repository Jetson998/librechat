'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const clientDir = path.join(root, 'client');
const scriptPath = path.join(clientDir, 'context-safety-ui.js');
const stylePath = path.join(clientDir, 'context-safety-ui.css');
const fixturePath = path.join(clientDir, 'context-safety-stage-b-smoke.html');
const contract = require(scriptPath);

assert.equal(contract.version, '2026-07-18-stage-b-v1');
assert.deepEqual(contract.thresholds, { notice: 70, warning: 85, critical: 95 });

const boundaryCases = [
  [-1, 'none'],
  [Number.NaN, 'none'],
  [69.99, 'none'],
  [70, 'notice'],
  [84.99, 'notice'],
  [85, 'warning'],
  [94.99, 'warning'],
  [95, 'critical'],
  [100, 'critical'],
];
for (const [value, expected] of boundaryCases) {
  assert.equal(contract.classifyPercent(value), expected, `classification failed for ${value}`);
}

assert.equal(contract.parseMeterValues('279617', '361000').level, 'notice');
assert.equal(Math.round(contract.parseMeterValues('279617', '361000').percent), 77);
assert.equal(contract.parseMeterValues('95', '100').level, 'critical');
assert.equal(contract.parseMeterValues('1', '0'), null);
assert.equal(contract.parseMeterValues('invalid', '100'), null);

const rawRecursionError =
  'Recursion limit of 50 reached without hitting a stop condition. ' +
  'You can increase the limit by setting recursionLimit.';
assert.equal(contract.isRecursionError(rawRecursionError), true);
assert.equal(contract.isRecursionError('Recursion limit documentation example'), false);
assert.equal(contract.isRecursionError('without hitting a stop condition'), false);

const manyFiles = Array.from({ length: 28 }, (_, index) => `下载 result-${index}.json`);
manyFiles.push('下载 result-0.json', '下载', 'Download', '点击以打开');
const draft = contract.buildHandoffDraft({
  previousUrl: `https://example.test/c/${'a'.repeat(800)}`,
  latestUserRequest: 'x'.repeat(5000),
  fileNames: manyFiles,
});
assert.ok(draft.length <= 6000);
assert.ok(draft.includes('上一对话：'));
assert.ok(draft.includes('最近一次用户要求：'));
assert.ok(draft.includes('result-0.json'));
assert.ok(draft.includes('result-19.json'));
assert.equal(draft.includes('result-20.json'), false);
assert.equal(contract.normalizeFileNames(manyFiles).length, 20);
assert.equal(contract.normalizeFileNames(['下载', 'Download', '打开']).length, 0);
assert.ok(contract.summaryRequest.length < 1000);
assert.ok(contract.summaryRequest.includes('不要调用任何工具'));

const source = fs.readFileSync(scriptPath, 'utf8');
const style = fs.readFileSync(stylePath, 'utf8');
const fixture = fs.readFileSync(fixturePath, 'utf8');

for (const marker of [
  '[data-testid="token-usage"]',
  '[role="meter"]',
  '[data-testid="stop-generation-button"]',
  '[data-testid="send-button"]',
  '#prompt-textarea[data-testid="text-input"]',
  'context-safety-ui-banner',
  'context-safety-recursion-body',
  'sessionStorage',
  'stopImmediatePropagation',
  'aria-valuenow',
  'aria-valuemax',
]) {
  assert.ok(source.includes(marker), `missing client marker: ${marker}`);
}

for (const message of Object.values(contract.messages)) {
  assert.ok(source.includes(message), `missing message: ${message}`);
}

for (const marker of [
  "#context-safety-ui-banner[data-level='notice']",
  "#context-safety-ui-banner[data-level='warning']",
  "#context-safety-ui-banner[data-level='critical']",
  '.context-safety-recursion-details',
  '.context-safety-result-target',
  '@media (max-width: 767px)',
]) {
  assert.ok(style.includes(marker), `missing CSS marker: ${marker}`);
}

for (const marker of [
  'context-safety-stage-b',
  'data-testid="token-usage"',
  'role="meter"',
  'data-testid="stop-generation-button"',
  'data-testid="send-button"',
  'Recursion limit of 50 reached without hitting',
  'file-attachment-container',
]) {
  assert.ok(fixture.includes(marker), `missing fixture marker: ${marker}`);
}

console.log('context_safety_stage_b_contract: ok');
