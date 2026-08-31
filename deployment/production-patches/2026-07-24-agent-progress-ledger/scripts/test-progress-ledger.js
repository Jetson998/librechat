'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const releaseRoot = path.resolve(__dirname, '..');
const ledgerModule = require(path.join(releaseRoot, 'api-patch', 'tool-progress-ledger.cjs'));
const normalizer = require(path.join(releaseRoot, 'api-patch', 'tool-call-normalizer.cjs'));
const recovery = require(path.join(releaseRoot, 'api-patch', 'tool-call-recovery.cjs'));
const contractModule = require(path.join(releaseRoot, 'api-patch', 'code-tool-contract.cjs'));
const mongoConfig = require(path.join(releaseRoot, 'scripts', 'mongo-config.js'));

const {
  ABORT_CODE,
  AgentNoProgressError,
  STOP_CODE,
  WARNING_CODE,
  createToolProgressLedger,
  normalizeContent,
  observationFingerprint,
} = ledgerModule;

const context = (runId) => ({ runId, threadId: `thread-${runId}`, agentId: 'agent-main' });
const call = (id, command) => ({ id, name: 'bash_tool', args: { command } });
const result = (content, artifact) => ({ status: 'success', content, artifact });

assert.equal(
  normalizer.normalizeLegacyClaudeCodeToolCall({ name: 'Bash', args: { command: 'pwd' } }).name,
  'bash_tool',
);
assert.deepEqual(
  normalizer.normalizeLegacyClaudeCodeToolCall({
    name: 'Read',
    args: { file_path: '/mnt/data/a.md' },
  }).args,
  { path: '/mnt/data/a.md' },
);
assert.deepEqual(
  normalizer.normalizeLegacyClaudeCodeToolCall({
    name: 'Read',
    args: '{"file_path":"/mnt/data/a.md"}',
  }).args,
  { path: '/mnt/data/a.md' },
);
for (const name of ['PowerShell', 'Glob']) {
  const call = { name, args: {} };
  assert.equal(normalizer.normalizeLegacyClaudeCodeToolCall(call), call);
}
assert.equal(recovery.getToolCallArgumentError({ name: 'bash_tool', args: { command: 'pwd' } }), null);
assert.equal(recovery.getToolCallArgumentError({ name: 'read_file', args: '{"path":"/mnt/data/a.md"}' }), null);
assert.match(
  recovery.getToolCallArgumentError({ name: 'bash_tool', args: '{"command":"python3 - <<\'PY\'"' }),
  /TOOL_ARGUMENTS_INCOMPLETE/,
);
assert.match(
  recovery.getToolCallArgumentError({ name: 'read_file', args: {} }),
  /只能操作 \/mnt\/data/,
);
assert.equal(recovery.getToolCallArgumentError({ name: 'Grep', args: {} }), null);
assert.match(
  recovery.getUnknownToolErrorMessage('PowerShell', ['bash_tool', 'read_file']),
  /Linux.*PowerShell.*宿主机磁盘.*bash_tool.*\/mnt\/data/s,
);
assert.match(
  recovery.getUnknownToolErrorMessage('Glob', ['bash_tool', 'read_file']),
  /不要重试 `Glob`.*`read_file`.*`bash_tool`/s,
);
assert(!recovery.getUnknownToolErrorMessage('PowerShell', ['bash_tool']).includes('PowerShell->bash_tool'));
assert(!recovery.getUnknownToolErrorMessage('bad\nname', []).includes('\nname'));
assert.match(
  recovery.augmentToolExecutionError('bash_tool', 'bash: syntax error: unexpected end of file'),
  /TOOL_ARGUMENTS_INCOMPLETE.*拆分/s,
);
assert.equal(recovery.augmentToolExecutionError('bash_tool', 'permission denied'), 'permission denied');
const runtimeContract = contractModule.buildCodeToolContract([
  { name: 'bash_tool' },
  { name: 'read_file' },
  { name: 'create_file' },
]);
assert(runtimeContract.includes('Linux and isolated from the host machine'));
assert(runtimeContract.includes('focused and short'));
assert(runtimeContract.includes('create_file'));

const diagnostics = [];
const ledger = createToolProgressLedger({ onDiagnostic: (event) => diagnostics.push(event) });
const fileListA = result('stdout:\n[{"path":"/mnt/data/input.pptx","size":223811}]');
const fileListB = result(
  'stdout:\n[ { "size": 223811, "path": "/mnt/data/input.pptx" } ]',
);

const first = ledger.observe({
  context: context('run-repeat'),
  toolCall: call('call-1', 'find /mnt/data -maxdepth 1 -type f'),
  result: fileListA,
  batchId: 'batch-1',
});
assert.equal(first.action, 'continue');

const warning = ledger.observe({
  context: context('run-repeat'),
  toolCall: call('call-2', 'python3 list_files.py'),
  result: fileListB,
  batchId: 'batch-2',
});
assert.equal(warning.action, 'warn');
assert(warning.result.content.includes(`[${WARNING_CODE}]`));
assert.equal(ledger.snapshot('run-repeat').state, 'warned');

const stopped = ledger.observe({
  context: context('run-repeat'),
  toolCall: call('call-3', 'ls -l /mnt/data'),
  result: fileListA,
  batchId: 'batch-3',
});
assert.equal(stopped.action, 'stop');
assert.equal(stopped.result.status, 'error');
assert(stopped.result.errorMessage.includes(`[${STOP_CODE}]`));
assert.equal(ledger.snapshot('run-repeat').state, 'stop_requested');
assert.throws(
  () => ledger.assertCanExecute(context('run-repeat')),
  (error) => error instanceof AgentNoProgressError && error.code === ABORT_CODE,
);

assert.deepEqual(
  diagnostics.map((event) => event.reasonCode),
  [WARNING_CODE, STOP_CODE, ABORT_CODE],
);
const diagnosticText = JSON.stringify(diagnostics);
assert(!diagnosticText.includes('find /mnt/data'));
assert(!diagnosticText.includes('/mnt/data/input.pptx'));
assert(!diagnosticText.includes('223811'));

const resetLedger = createToolProgressLedger();
resetLedger.observe({
  context: context('run-artifact'),
  toolCall: call('scan-1', 'ls /mnt/data'),
  result: fileListA,
  batchId: 'scan-batch-1',
});
assert.equal(
  resetLedger.observe({
    context: context('run-artifact'),
    toolCall: call('scan-2', 'find /mnt/data -type f'),
    result: fileListA,
    batchId: 'scan-batch-2',
  }).action,
  'warn',
);
const write = resetLedger.observe({
  context: context('run-artifact'),
  toolCall: { id: 'write-1', name: 'create_file', args: { path: '/mnt/data/output.pptx' } },
  result: result('Created output.pptx', {
    path: '/mnt/data/output.pptx',
    bytes_written: 400_000,
    version: 1,
  }),
  batchId: 'write-batch',
});
assert.equal(write.action, 'continue');
assert.equal(resetLedger.snapshot('run-artifact').state, 'normal');
assert.equal(resetLedger.snapshot('run-artifact').artifactEpoch, 1);
assert.equal(
  resetLedger.observe({
    context: context('run-artifact'),
    toolCall: call('scan-3', 'ls /mnt/data'),
    result: fileListA,
    batchId: 'scan-batch-3',
  }).action,
  'continue',
  'artifact changes must allow the same verification observation again',
);

const strategyLedger = createToolProgressLedger();
strategyLedger.observe({
  context: context('run-strategy'),
  toolCall: call('strategy-1', 'ls /mnt/data'),
  result: fileListA,
  batchId: 'strategy-batch-1',
});
assert.equal(
  strategyLedger.observe({
    context: context('run-strategy'),
    toolCall: call('strategy-2', 'find /mnt/data -type f'),
    result: fileListA,
    batchId: 'strategy-batch-2',
  }).action,
  'warn',
);
assert.equal(
  strategyLedger.observe({
    context: context('run-strategy'),
    toolCall: { id: 'read-1', name: 'read_file', args: { path: '/mnt/data/input.md' } },
    result: result('new information from another target'),
    batchId: 'strategy-batch-3',
  }).action,
  'continue',
);
assert.equal(strategyLedger.snapshot('run-strategy').state, 'normal');

const errorLedger = createToolProgressLedger();
const missingTool = { status: 'error', content: '', errorMessage: 'Tool image_gen not found' };
errorLedger.observe({
  context: context('run-error'),
  toolCall: { id: 'missing-1', name: 'image_gen', args: {} },
  result: missingTool,
  batchId: 'error-batch-1',
});
assert.equal(
  errorLedger.observe({
    context: context('run-error'),
    toolCall: { id: 'missing-2', name: 'image_gen', args: {} },
    result: missingTool,
    batchId: 'error-batch-2',
  }).action,
  'warn',
);

const parallelLedger = createToolProgressLedger();
parallelLedger.observe({
  context: context('run-parallel'),
  toolCall: call('parallel-1', 'ls /mnt/data'),
  result: fileListA,
  batchSize: 2,
  batchId: 'parallel-batch',
});
assert.equal(
  parallelLedger.observe({
    context: context('run-parallel'),
    toolCall: call('parallel-2', 'find /mnt/data -type f'),
    result: fileListA,
    batchSize: 2,
    batchId: 'parallel-batch',
  }).action,
  'continue',
  'parallel batches must record observations without triggering stop transitions',
);
assert.equal(parallelLedger.snapshot('run-parallel').state, 'normal');

let now = 1_000;
const boundedLedger = createToolProgressLedger({
  now: () => now,
  ttlMs: 100,
  maxActiveRuns: 2,
  maxObservationsPerRun: 2,
});
for (const runId of ['bounded-1', 'bounded-2']) {
  boundedLedger.observe({
    context: context(runId),
    toolCall: call(`${runId}-call`, runId),
    result: result(runId),
    batchId: runId,
  });
}
now += 1;
boundedLedger.observe({
  context: context('bounded-3'),
  toolCall: call('bounded-3-call', 'bounded-3'),
  result: result('bounded-3'),
  batchId: 'bounded-3',
});
assert.equal(boundedLedger.snapshot('bounded-1'), null, 'oldest run must be evicted');
now += 101;
boundedLedger.observe({
  context: context('bounded-4'),
  toolCall: call('bounded-4-call', 'bounded-4'),
  result: result('bounded-4'),
  batchId: 'bounded-4',
});
assert.equal(boundedLedger.snapshot('bounded-2'), null, 'expired runs must be pruned');

assert.equal(
  observationFingerprint(fileListA),
  observationFingerprint(fileListB),
  'equivalent JSON observations must share one fingerprint',
);
assert.equal(normalizeContent('\u001b[31merror\u001b[0m'), 'error');

const fixture = {
  overrides: {
    modelSpecs: {
      list: mongoConfig.TARGET_MODELS.map((name) => ({
        name,
        preset: { promptPrefix: `base prompt for ${name}` },
      })),
    },
  },
};
const configured = mongoConfig.applyContractToDocument(fixture);
mongoConfig.assertConfigured(configured);
const configuredAgain = mongoConfig.applyContractToDocument(configured);
mongoConfig.assertConfigured(configuredAgain);
assert.deepEqual(configuredAgain, configured, 'prompt contract merge must be idempotent');
for (const spec of configured.overrides.modelSpecs.list) {
  assert(spec.preset.promptPrefix.includes('当前产品不支持生成图片'));
  assert(spec.preset.promptPrefix.includes('不得使用 bash_tool'));
  assert(spec.preset.promptPrefix.includes('已有图片'));
}

const apiSource = fs.readFileSync(path.join(releaseRoot, 'api-patch', 'api-index.cjs'), 'utf8');
for (const contract of [
  'require("./code-tool-contract.cjs")',
  'buildCodeToolContract(toolDefinitions)',
  'require("./tool-progress-ledger.cjs")',
  'require("./tool-call-recovery.cjs")',
  'const availableToolNames = getAvailableToolNames(toolMap, mergedConfigurable)',
  'agentToolProgressLedger.assertCanExecute(ledgerContext)',
  'agentToolProgressLedger.observe({',
  'finalizeToolResult(tc, await execute())',
  'finalizeToolResult(tc, await resultPromise)',
  '[tool-progress-ledger]',
]) {
  assert(apiSource.includes(contract), `API integration missing: ${contract}`);
}
const codeToolContractSource = fs.readFileSync(
  path.join(releaseRoot, 'api-patch', 'code-tool-contract.cjs'),
  'utf8',
);
assert(codeToolContractSource.includes('function buildCodeToolContract'));
assert(codeToolContractSource.includes('module.exports'));
const recoverySource = fs.readFileSync(
  path.join(releaseRoot, 'api-patch', 'tool-call-recovery.cjs'),
  'utf8',
);
assert(recoverySource.includes('getUnknownToolErrorMessage'));
assert(recoverySource.includes('TOOL_ARGUMENTS_INCOMPLETE'));

const baseline = fs.readFileSync(path.join(releaseRoot, 'BASELINE_SHA256'), 'utf8').trim();
assert.equal(baseline, '107678877c69dd3ccb7db53e160acad2326819d95e71ae289594140cc5eaa719');
const remoteApply = fs.readFileSync(path.join(releaseRoot, 'scripts', 'remote-apply.sh'), 'utf8');
assert(remoteApply.includes(`expected_baseline="${baseline}"`));
assert(remoteApply.includes('/app/packages/api/dist/code-tool-contract.cjs'));
assert(remoteApply.includes('/app/packages/api/dist/tool-progress-ledger.cjs'));
assert(remoteApply.includes('/app/packages/api/dist/tool-call-recovery.cjs'));
assert(remoteApply.includes('$recovery_hash'));
assert(!remoteApply.includes('AGENT_PROGRESS_LEDGER_MODE'));

console.log('agent progress ledger tests passed');
