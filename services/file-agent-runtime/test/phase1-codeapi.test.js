import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodeApiHttpTransport } from '../src/codeapi-transport.js';
import {
  CodeApiXlsxExecutor,
  DeterministicXlsxProvider,
  getPhase1TaskPaths,
  XLSX_MIME,
} from '../src/deterministic-xlsx.js';
import {
  ExecutorExecutionError,
  ExecutorProtocolError,
  ExecutorRejectedError,
  ExecutorTransportError,
} from '../src/executor-adapter.js';
import { FileAgentRuntime, RuntimeShutdownError } from '../src/runtime.js';
import { FileTaskStore } from '../src/task-store.js';
import { IsolatedCodeApiServer } from './isolated-codeapi.js';

function runPython(source, args = []) {
  return new Promise((resolve, reject) => {
    execFile('python3', ['-c', source, ...args], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function createWorkbook(filePath) {
  await runPython(
    'from openpyxl import Workbook\nimport sys\nwb=Workbook()\nws=wb.active\nws.title="Source"\nws.append(["Channel", "Model"])\nws.append(["relay", "gpt-5.6-sol"])\nwb.save(sys.argv[1])',
    [filePath],
  );
}

async function inspectWorkbook(filePath) {
  const stdout = await runPython(
    'import json,sys\nfrom openpyxl import load_workbook\nwb=load_workbook(sys.argv[1],read_only=True)\nws=wb["Agent Summary"]\nprint(json.dumps({"sheets":wb.sheetnames,"marker":ws["B3"].value}))',
    [filePath],
  );
  return JSON.parse(stdout);
}

function manifest({ sessionId, fileId }) {
  return {
    schemaVersion: '1.0',
    taskContractVersion: 'office-file-agent.v1',
    taskType: 'office_transform',
    intent: 'Run the deterministic Phase 1 XLSX transform',
    execution: {
      executor: 'codeapi',
      sessionId,
      workspaceRoot: '/mnt/data/.agent/{taskId}',
    },
    inputs: [
      {
        logicalName: 'source.xlsx',
        mimeType: XLSX_MIME,
        codeEnvRef: {
          storage_session_id: sessionId,
          file_id: fileId,
        },
      },
    ],
  };
}

async function createPhase1Harness(t, { rootDir, testHooks } = {}) {
  const ownedRoot = rootDir ?? (await mkdtemp(path.join(tmpdir(), 'file-agent-phase1-')));
  const fixturePath = path.join(ownedRoot, 'source.xlsx');
  await createWorkbook(fixturePath);
  const codeApi = await new IsolatedCodeApiServer(path.join(ownedRoot, 'codeapi')).start();
  const sessionId = 'phase1-isolated-session';
  const fileId = 'phase1-input-xlsx';
  await codeApi.registerFile({ sessionId, fileId, name: 'source.xlsx', sourcePath: fixturePath });

  const store = new FileTaskStore(path.join(ownedRoot, 'runtime'));
  const transport = new CodeApiHttpTransport({ baseUrl: codeApi.baseUrl });
  const executor = new CodeApiXlsxExecutor({ transport });
  const runtime = new FileAgentRuntime({
    store,
    provider: new DeterministicXlsxProvider(),
    executor,
    testHooks,
  });
  await runtime.start();

  if (!rootDir) {
    t.after(async () => {
      await runtime.stop();
      await codeApi.stop();
      await rm(ownedRoot, { recursive: true, force: true });
    });
  }
  return { codeApi, executor, fileId, rootDir: ownedRoot, runtime, sessionId, store };
}

test('Phase 1 completes one XLSX transform through an isolated CodeAPI session', async (t) => {
  const harness = await createPhase1Harness(t);
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'phase1-xlsx-complete',
    manifest: manifest(harness),
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 15_000 },
  );

  assert.equal(completed.planRevision, 2);
  assert.equal(completed.verification.passed, true);
  assert.equal(completed.result.artifacts.length, 1);
  assert.equal(completed.result.artifacts[0].mimeType, XLSX_MIME);
  assert.equal(completed.events.filter((event) => event.type === 'artifact.ready').length, 1);

  const paths = getPhase1TaskPaths(completed);
  const scriptPath = harness.codeApi.virtualPath(harness.sessionId, paths.scriptPath);
  const outputPath = harness.codeApi.virtualPath(harness.sessionId, paths.outputPath);
  const script = await readFile(scriptPath, 'utf8');
  assert.ok(script.includes('__PHASE1_PATCH_APPLIED__'));
  assert.ok(!script.includes('__PHASE1_PATCH_PENDING__'));
  await harness.executor.prepare({
    itemId: `${completed.taskId}:prepare-repeat-contract-check`,
    task: completed,
    signal: new AbortController().signal,
  });
  assert.equal(await readFile(scriptPath, 'utf8'), script);
  const workbook = await inspectWorkbook(outputPath);
  assert.ok(workbook.sheets.includes('Source'));
  assert.ok(workbook.sheets.includes('Agent Summary'));
  assert.equal(workbook.marker, '__PHASE1_PATCH_APPLIED__');

  assert.ok(harness.codeApi.requests.length >= 6);
  assert.ok(harness.codeApi.requests.every((request) => typeof request.item_id === 'string'));
  for (const request of harness.codeApi.requests) {
    assert.equal(harness.codeApi.executionCount(request.item_id), 1);
  }
  const patchItems = completed.completedItemIds.filter((itemId) => itemId.includes(':execute:2:0'));
  assert.equal(patchItems.length, 1);
  assert.equal(completed.itemResults[patchItems[0]].patch.replacements, 1);
});

test('Runtime restart replays the same itemId without duplicating the external XLSX artifact', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase1-restart-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let interrupted = false;
  const first = await createPhase1Harness(t, {
    rootDir,
    testHooks: {
      afterItemOperation({ itemId, kind }) {
        if (!interrupted && kind === 'xlsx_transform') {
          interrupted = true;
          throw new RuntimeShutdownError(`Injected checkpoint after ${itemId}`);
        }
      },
    },
  });
  const submitted = await first.runtime.submit({
    idempotencyKey: 'phase1-restart-idempotency',
    manifest: manifest(first),
  });
  const interruptedTask = await first.runtime.waitFor(
    submitted.task.taskId,
    (task) => interrupted && task.activeItem?.kind === 'xlsx_transform',
    { timeoutMs: 10_000 },
  );
  const replayedItemId = interruptedTask.activeItem.itemId;
  await first.runtime.stop();

  const secondStore = new FileTaskStore(path.join(rootDir, 'runtime'));
  const secondRuntime = new FileAgentRuntime({
    store: secondStore,
    provider: new DeterministicXlsxProvider(),
    executor: new CodeApiXlsxExecutor({
      transport: new CodeApiHttpTransport({ baseUrl: first.codeApi.baseUrl }),
    }),
  });
  await secondRuntime.start();
  t.after(async () => {
    await secondRuntime.stop();
    await first.codeApi.stop();
  });
  const completed = await secondRuntime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 15_000 },
  );

  assert.equal(first.codeApi.executionCount(replayedItemId), 1);
  const replayRequests = first.codeApi.requests.filter((request) => request.item_id === replayedItemId);
  assert.equal(replayRequests.length, 2);
  assert.equal(completed.itemResults[replayedItemId].replayed, true);
  assert.equal(completed.result.artifacts.length, 1);
  assert.equal(completed.events.filter((event) => event.type === 'artifact.ready').length, 1);
});

test('CodeAPI transport maps rejection, upstream, protocol, and execution errors', async () => {
  const request = { itemId: 'item-1', sessionId: 'session-1', command: 'true' };

  await assert.rejects(
    new CodeApiHttpTransport({
      baseUrl: 'http://codeapi.test',
      fetchImpl: async () => new Response('denied', { status: 403 }),
    }).execute(request),
    ExecutorRejectedError,
  );

  await assert.rejects(
    new CodeApiHttpTransport({
      baseUrl: 'http://codeapi.test',
      fetchImpl: async () => new Response('unavailable', { status: 503 }),
    }).execute(request),
    (error) => error instanceof ExecutorTransportError && error.retryable === true,
  );

  await assert.rejects(
    new CodeApiHttpTransport({
      baseUrl: 'http://codeapi.test',
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    }).execute(request),
    ExecutorProtocolError,
  );

  await assert.rejects(
    new CodeApiHttpTransport({
      baseUrl: 'http://codeapi.test',
      fetchImpl: async () => new Response(JSON.stringify({
        status: 'error',
        exitCode: 7,
        stdout: '',
        stderr: 'fixture failure',
        artifacts: [],
      }), { status: 200 }),
    }).execute(request),
    (error) => error instanceof ExecutorExecutionError && error.exitCode === 7,
  );
});

test('Runtime rejects an incomplete ExecutorAdapter before starting a task', () => {
  assert.throws(
    () => new FileAgentRuntime({
      store: {},
      provider: {},
      executor: { prepare() {} },
    }),
    /executor.execute must be a function/,
  );
});
