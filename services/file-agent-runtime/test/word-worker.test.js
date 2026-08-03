import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodeApiHttpTransport } from '../src/codeapi-transport.js';
import {
  CodeApiWordExecutor,
  DOCX_MIME,
  DeterministicWordProvider,
  getWordTaskPaths,
  normalizeWordAction,
  WORD_VERIFIER_PROFILE,
} from '../src/deterministic-word.js';
import { ExecutorRejectedError } from '../src/executor-adapter.js';
import { FileAgentRuntime } from '../src/runtime.js';
import { FileTaskStore } from '../src/task-store.js';
import { IsolatedCodeApiServer } from './isolated-codeapi.js';
import { writeWordFixture } from './word-fixtures.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function wordAction(worker, parameters, expectedChange, summary = 'Word fixture action') {
  return normalizeWordAction({
    schemaVersion: '1.0',
    objective: 'Apply the requested bounded Word fixture change',
    worker,
    inputRefs: ['input:source-docx'],
    targetRef: 'candidate:working-docx',
    parameters,
    expectedChange,
    verificationProfile: WORD_VERIFIER_PROFILE,
    onFailure: 'replan',
    summary,
  });
}

function taskManifest({ sessionId, fileId, inputHash, wordPlan, intent = 'Modify the authorized Word document' }) {
  return {
    schemaVersion: '1.0',
    taskContractVersion: 'office-file-agent.v1.1',
    taskType: 'office_transform',
    intent,
    model: {
      modelRouteId: 'file-agent-word-test',
      capabilityProfile: 'word-edit-v1',
    },
    execution: {
      executor: 'codeapi',
      sessionId,
      workspaceRoot: '/mnt/data/.agent/{taskId}',
    },
    inputs: [{
      logicalName: 'source.docx',
      mimeType: DOCX_MIME,
      sha256: inputHash,
      codeEnvRef: {
        storage_session_id: sessionId,
        file_id: fileId,
      },
    }],
    limits: {
      maxVisibleArtifacts: 1,
    },
    ...(wordPlan ? { wordPlan } : {}),
  };
}

async function readZipEntry(filePath, entry) {
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-p', filePath, entry], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

class NoRepairProvider extends DeterministicWordProvider {
  async repair() {
    return {
      needsInput: true,
      question: 'The fixture is expected to remain blocked after deterministic verification.',
      actions: [],
    };
  }
}

async function createHarness(
  t,
  { fixtureKind = 'normal', renderBin = 'soffice', wordPlan, provider = new DeterministicWordProvider() } = {},
) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-word-'));
  const fixturePath = path.join(rootDir, `${fixtureKind}.docx`);
  await writeWordFixture(fixturePath, fixtureKind);
  const source = await readFile(fixturePath);
  const codeApi = await new IsolatedCodeApiServer(path.join(rootDir, 'codeapi')).start();
  const sessionId = `word-isolated-${fixtureKind}`;
  const fileId = `word-input-${fixtureKind}`;
  await codeApi.registerFile({ sessionId, fileId, name: 'source.docx', sourcePath: fixturePath });
  const store = new FileTaskStore(path.join(rootDir, 'runtime'));
  const executor = new CodeApiWordExecutor({
    transport: new CodeApiHttpTransport({ baseUrl: codeApi.baseUrl }),
    renderBin,
  });
  const runtime = new FileAgentRuntime({
    store,
    provider,
    executor,
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await codeApi.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const manifest = taskManifest({
    sessionId,
    fileId,
    inputHash: sha256(source),
    wordPlan,
  });
  return { codeApi, executor, fixturePath, manifest, rootDir, runtime, sessionId, source, store };
}

test('Word Worker transforms and publishes one deterministically verified DOCX', async (t) => {
  const harness = await createHarness(t);
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'word-normal-complete',
    manifest: harness.manifest,
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 20_000 },
  );

  assert.equal(completed.verification.passed, true);
  assert.equal(completed.verification.profile, WORD_VERIFIER_PROFILE);
  assert.equal(completed.verification.requiredAssertionCount, 8);
  assert.equal(completed.verification.passedAssertionCodes.length, 8);
  assert.equal(completed.result.artifacts.length, 1);
  assert.equal(completed.result.artifacts[0].mimeType, DOCX_MIME);
  assert.equal(completed.result.artifacts[0].name, 'working.docx');

  const paths = getWordTaskPaths(completed);
  const inputPath = harness.codeApi.virtualPath(harness.sessionId, paths.inputPath);
  const outputPath = harness.codeApi.virtualPath(harness.sessionId, paths.outputPath);
  assert.equal(sha256(await readFile(inputPath)), sha256(harness.source));
  assert.notDeepEqual(await readFile(outputPath), harness.source);

  const history = JSON.parse(await readFile(harness.codeApi.virtualPath(harness.sessionId, paths.historyPath), 'utf8'));
  assert.equal(history.length, 1);
  assert.equal(history[0].workerVersion, 'word-worker-v1.0.0');
  assert.equal(history[0].beforeSha256, sha256(harness.source));
  assert.equal(history[0].afterSha256, completed.verification.artifact.sha256);
  assert.ok(harness.codeApi.requests.length >= 5);
  for (const request of harness.codeApi.requests) {
    assert.equal(harness.codeApi.executionCount(request.item_id), 1);
  }
});

test('Word table transform preserves the input and verifies the required table change', async (t) => {
  const plan = [
    wordAction('word.inspect.v1', { operation: 'inspect' }, ['document.structure'], 'Inspect source'),
    wordAction(
      'word.transform.v1',
      { operation: 'replace_table_cell', tableIndex: 0, rowIndex: 0, columnIndex: 1, text: 'Updated cell' },
      ['table.cell.text'],
      'Update the requested table cell',
    ),
  ];
  const harness = await createHarness(t, { fixtureKind: 'table', wordPlan: plan });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'word-table-complete',
    manifest: harness.manifest,
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 20_000 },
  );

  assert.equal(completed.verification.passed, true);
  assert.equal(completed.verification.metrics.tableCount, 1);
  const paths = getWordTaskPaths(completed);
  const outputPath = harness.codeApi.virtualPath(harness.sessionId, paths.outputPath);
  const output = await readFile(outputPath);
  const documentXml = await readZipEntry(outputPath, 'word/document.xml');
  assert.match(documentXml, /Updated cell/);
});

test('Word inspect covers rich parts and styled paragraph output', async (t) => {
  const plan = [
    wordAction('word.inspect.v1', { operation: 'inspect' }, ['document.structure'], 'Inspect rich source'),
    wordAction(
      'word.transform.v1',
      { operation: 'append_paragraph', text: 'Rich output', style: 'Heading1' },
      ['document.paragraph'],
      'Append a styled paragraph',
    ),
  ];
  const harness = await createHarness(t, { fixtureKind: 'rich', wordPlan: plan });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'word-rich-complete',
    manifest: harness.manifest,
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 20_000 },
  );

  const inspection = completed.itemResults[`${submitted.task.taskId}:execute:1:0`];
  assert.deepEqual(
    {
      tableCount: inspection.tableCount,
      styleCount: inspection.styleCount,
      headerCount: inspection.headerCount,
      footerCount: inspection.footerCount,
      imageCount: inspection.imageCount,
    },
    { tableCount: 2, styleCount: 1, headerCount: 1, footerCount: 1, imageCount: 1 },
  );
  const paths = getWordTaskPaths(completed);
  const documentXml = await readZipEntry(
    harness.codeApi.virtualPath(harness.sessionId, paths.outputPath),
    'word/document.xml',
  );
  assert.match(documentXml, /w:val="Heading1"/);
  assert.match(documentXml, /Rich output/);
  assert.equal(sha256(await readFile(harness.fixturePath)), sha256(harness.source));
});

test('Word text transform spans multiple runs without changing the source', async (t) => {
  const plan = [
    wordAction('word.inspect.v1', { operation: 'inspect' }, ['document.structure'], 'Inspect split text'),
    wordAction(
      'word.transform.v1',
      { operation: 'replace_text', find: 'Source paragraph', replace: 'Updated paragraph' },
      ['document.text'],
      'Replace text across Word runs',
    ),
  ];
  const harness = await createHarness(t, { fixtureKind: 'split-text', wordPlan: plan });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'word-split-text-complete',
    manifest: harness.manifest,
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 20_000 },
  );

  const paths = getWordTaskPaths(completed);
  const outputPath = harness.codeApi.virtualPath(harness.sessionId, paths.outputPath);
  const documentXml = await readZipEntry(outputPath, 'word/document.xml');
  assert.match(documentXml, /Updated paragraph/);
  assert.doesNotMatch(documentXml, /Source paragraph/);
  assert.equal(sha256(await readFile(harness.fixturePath)), sha256(harness.source));
});

test('Word patch refuses a stale candidate base hash before CodeAPI mutation', async (t) => {
  const harness = await createHarness(t);
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'word-patch-base',
    manifest: harness.manifest,
  });
  await harness.runtime.waitFor(submitted.task.taskId, (task) => task.status === 'completed', { timeoutMs: 20_000 });
  const task = await harness.runtime.getTask(submitted.task.taskId);
  const paths = getWordTaskPaths(task);
  const before = harness.codeApi.requests.length;
  await assert.rejects(
    harness.executor.execute({
      itemId: `${task.taskId}:stale-patch`,
      task,
      action: wordAction(
        'word.patch.v1',
        {
          operation: 'append_paragraph',
          text: 'must not be applied',
          expectedBaseSha256: '0'.repeat(64),
        },
        ['document.paragraph'],
      ),
      signal: new AbortController().signal,
    }),
    (error) => error instanceof ExecutorRejectedError && error.code === 'WORD_PATCH_BASE_CONFLICT',
  );
  assert.equal(harness.codeApi.requests.length, before + 1);
  assert.equal(await readFile(harness.codeApi.virtualPath(harness.sessionId, paths.outputPath)).then(sha256), task.verification.artifact.sha256);
});

test('Word verifier reports relationship, orphan-comment, and render failures as failed assertions', async (t) => {
  for (const [fixtureKind, expectedCode, renderBin] of [
    ['broken-relationship', 'word.relationships.resolved', 'soffice'],
    ['orphan-comments', 'word.comments.no_orphans', 'soffice'],
    ['normal', 'word.render.succeeded', '/usr/bin/false'],
  ]) {
    const harness = await createHarness(t, { fixtureKind, renderBin, provider: new NoRepairProvider() });
    const submitted = await harness.runtime.submit({
      idempotencyKey: `word-negative-${fixtureKind}-${renderBin}`,
      manifest: harness.manifest,
    });
    const terminal = await harness.runtime.waitFor(
      submitted.task.taskId,
      (task) => task.status === 'needs_input' || task.status === 'failed' || task.status === 'completed',
      { timeoutMs: 20_000 },
    );
    assert.notEqual(terminal.status, 'completed');
    const failedCodes = new Set(terminal.verification?.failedAssertions?.map((entry) => entry.code));
    assert.ok(failedCodes.has(expectedCode), `${fixtureKind} did not report ${expectedCode}`);
  }
});

test('Word accident replay stops an equivalent repair before the next CodeAPI mutation', async (t) => {
  const plan = [
    wordAction('word.inspect.v1', { operation: 'inspect' }, ['document.structure'], 'Inspect accident fixture'),
    wordAction(
      'word.transform.v1',
      { operation: 'replace_table_cell', tableIndex: 0, rowIndex: 0, columnIndex: 1, text: 'Accident update' },
      ['table.cell.text'],
      'Apply the table correction',
    ),
  ];
  const harness = await createHarness(t, { fixtureKind: 'accident-replay', wordPlan: plan });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'word-accident-replay',
    manifest: harness.manifest,
  });
  const needsInput = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'needs_input',
    { timeoutMs: 20_000 },
  );

  assert.equal(needsInput.progress.stagnationCount, 1);
  assert.ok(needsInput.events.some((event) => event.type === 'progress.stalled'));
  assert.equal(needsInput.events.at(-1).data.reason, 'repeated_no_progress_plan');
  assert.ok(harness.codeApi.requests.some((request) => request.item_id.endsWith(':execute:2:0')));
  assert.equal(
    harness.codeApi.requests.some((request) => request.item_id.endsWith(':execute:3:0')),
    false,
  );
  assert.ok(needsInput.verification.failedAssertions.some((entry) => entry.code === 'word.comments.no_orphans'));
});
