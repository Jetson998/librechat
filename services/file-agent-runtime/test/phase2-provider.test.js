import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ContextProjector } from '../src/context-projector.js';
import { CodeApiHttpTransport } from '../src/codeapi-transport.js';
import { CodeApiXlsxExecutor, XLSX_MIME } from '../src/deterministic-xlsx.js';
import { ExecutorAdapter } from '../src/executor-adapter.js';
import { FakeExecutor } from '../src/fake-adapters.js';
import { FileModelCallJournal } from '../src/model-call-journal.js';
import { OpenAiChatTransport, SingleModelAgentProvider } from '../src/openai-compatible-provider.js';
import { ProviderAmbiguousCommitError, ProviderCallConflictError } from '../src/provider-adapter.js';
import { FileAgentRuntime, RuntimeShutdownError } from '../src/runtime.js';
import { FileTaskStore } from '../src/task-store.js';
import { IsolatedCodeApiServer } from './isolated-codeapi.js';
import { IsolatedModelRelay } from './isolated-model-relay.js';

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
    'from openpyxl import Workbook\nimport sys\nwb=Workbook()\nws=wb.active\nws.title="Source"\nws.append(["Channel","Model"])\nws.append(["relay","gpt-5.6-sol"])\nwb.save(sys.argv[1])',
    [filePath],
  );
}

function modelManifest(overrides = {}) {
  return {
    schemaVersion: '1.0',
    taskContractVersion: 'office-file-agent.v1',
    taskType: 'office_transform',
    intent: 'Use the model planner to transform one workbook',
    acceptance: ['Return one verified XLSX artifact'],
    model: {
      modelRouteId: 'file-agent-primary',
      capabilityProfile: 'office-planner-v1',
    },
    ...overrides,
  };
}

function createProvider({
  rootDir,
  relay,
  transport,
  apiKey = 'phase2-test-secret',
  supportsIdempotency = true,
  maxChars = 12_000,
}) {
  return new SingleModelAgentProvider({
    routes: {
      'file-agent-primary': {
        baseUrl: relay?.baseUrl ?? 'http://recorded-model.local',
        model: 'recorded-office-planner',
        apiKey,
        capabilityProfile: 'office-planner-v1',
        supportsIdempotency,
        outputBudgetTokens: 500,
      },
    },
    transport: transport ?? new OpenAiChatTransport(),
    journal: new FileModelCallJournal(path.join(rootDir, 'provider-journal')),
    projector: new ContextProjector({ maxChars }),
  });
}

async function createFullHarness(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2-'));
  const fixturePath = path.join(rootDir, 'source.xlsx');
  await createWorkbook(fixturePath);
  const codeApi = await new IsolatedCodeApiServer(path.join(rootDir, 'codeapi')).start();
  const relay = await new IsolatedModelRelay().start();
  const sessionId = 'phase2-isolated-session';
  const fileId = 'phase2-input-xlsx';
  await codeApi.registerFile({ sessionId, fileId, name: 'source.xlsx', sourcePath: fixturePath });
  const store = new FileTaskStore(path.join(rootDir, 'runtime'));
  const runtime = new FileAgentRuntime({
    store,
    provider: createProvider({ rootDir, relay }),
    executor: new CodeApiXlsxExecutor({
      transport: new CodeApiHttpTransport({ baseUrl: codeApi.baseUrl }),
    }),
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await relay.stop();
    await codeApi.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { codeApi, fileId, relay, rootDir, runtime, sessionId, store };
}

test('Phase 2A model planner completes XLSX work with bounded context and durable usage', async (t) => {
  const harness = await createFullHarness(t);
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'phase2-model-xlsx',
    manifest: modelManifest({
      execution: {
        executor: 'codeapi',
        sessionId: harness.sessionId,
        workspaceRoot: '/mnt/data/.agent/{taskId}',
      },
      inputs: [
        {
          logicalName: 'source.xlsx',
          mimeType: XLSX_MIME,
          codeEnvRef: {
            storage_session_id: harness.sessionId,
            file_id: harness.fileId,
          },
        },
      ],
    }),
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 20_000 },
  );

  assert.equal(completed.planRevision, 2);
  assert.equal(completed.usageRecords.length, 2);
  assert.equal(completed.events.filter((event) => event.type === 'usage.recorded').length, 2);
  assert.deepEqual(
    completed.usageRecords.map((usage) => [
      usage.inputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.outputTokens,
    ]),
    [[500, 0, 0, 70], [700, 120, 0, 90]],
  );
  assert.ok(completed.usageRecords.every((usage) => !('cost' in usage) && !('price' in usage)));
  assert.equal(completed.result.artifacts.length, 1);
  assert.equal(harness.relay.requests.length, 2);
  for (const request of harness.relay.requests) {
    const serialized = JSON.stringify(request.context);
    assert.ok(serialized.length <= 12_000);
    assert.ok(!serialized.includes('from openpyxl import load_workbook'));
    assert.ok(!serialized.includes('__PHASE1_PATCH_PENDING__'));
    assert.ok(!serialized.includes('phase2-test-secret'));
  }

  const persisted = JSON.stringify(await harness.store.requireTask(completed.taskId));
  assert.ok(!persisted.includes('phase2-test-secret'));
  assert.ok(!persisted.includes(harness.relay.baseUrl));
});

test('Provider journal replays a completed model call after Runtime interruption without duplicate usage', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2-restart-'));
  const transportCalls = new Map();
  const recordedTransport = {
    async invoke({ callId, operation }) {
      transportCalls.set(callId, (transportCalls.get(callId) ?? 0) + 1);
      return {
        plan: operation === 'repair'
          ? {
              schemaVersion: '1.0',
              summary: 'Recorded repair',
              needsInput: false,
              actions: [{ kind: 'xlsx_patch_and_transform', summary: 'Recorded patch' }],
            }
          : {
              schemaVersion: '1.0',
              summary: 'Recorded plan',
              needsInput: false,
              actions: [{ kind: 'xlsx_transform', summary: 'Recorded transform' }],
            },
        providerModel: 'recorded-office-planner',
        usage: {
          inputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 70,
        },
      };
    },
  };
  const store = new FileTaskStore(path.join(rootDir, 'runtime'));
  let interrupted = false;
  const firstRuntime = new FileAgentRuntime({
    store,
    provider: createProvider({ rootDir, transport: recordedTransport }),
    executor: new FakeExecutor(),
    testHooks: {
      afterItemOperation({ kind }) {
        if (!interrupted && kind === 'model_plan') {
          interrupted = true;
          throw new RuntimeShutdownError('Injected after provider journal completion');
        }
      },
    },
  });
  await firstRuntime.start();
  const submitted = await firstRuntime.submit({
    idempotencyKey: 'phase2-provider-restart',
    manifest: modelManifest(),
  });
  const interruptedTask = await firstRuntime.waitFor(
    submitted.task.taskId,
    (task) => interrupted && task.activeItem?.kind === 'model_plan',
    { timeoutMs: 10_000 },
  );
  const callId = interruptedTask.activeItem.itemId;
  await firstRuntime.stop();

  const secondRuntime = new FileAgentRuntime({
    store: new FileTaskStore(path.join(rootDir, 'runtime')),
    provider: createProvider({ rootDir, transport: recordedTransport }),
    executor: new FakeExecutor(),
  });
  await secondRuntime.start();
  t.after(async () => {
    await secondRuntime.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const completed = await secondRuntime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 10_000 },
  );

  assert.equal(transportCalls.get(callId), 1);
  assert.equal(completed.itemResults[callId].call.replayed, true);
  assert.equal(completed.usageRecords.filter((usage) => usage.callId === callId).length, 1);
  assert.equal(completed.events.filter((event) => event.type === 'usage.recorded').length, 1);
});

class StagnantExecutor extends ExecutorAdapter {
  constructor() {
    super();
    this.actions = [];
  }

  async prepare() {
    return { workspaceRoot: '/mnt/data/.agent/stagnant' };
  }

  async execute({ action }) {
    this.actions.push(action.kind);
    return { actionKind: action.kind, scriptHash: 'same-script', outputHash: 'same-output' };
  }

  async verify() {
    return { passed: false, summary: 'The same verification failure', outputHash: 'same-output' };
  }

  async publish() {
    throw new Error('publish must not run for a stagnant task');
  }
}

test('Repeated failed fingerprint plus the same repair plan stops before duplicate CodeAPI work', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2-stagnant-'));
  const relay = await new IsolatedModelRelay().start();
  const executor = new StagnantExecutor();
  const runtime = new FileAgentRuntime({
    store: new FileTaskStore(path.join(rootDir, 'runtime')),
    provider: createProvider({ rootDir, relay }),
    executor,
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await relay.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const submitted = await runtime.submit({
    idempotencyKey: 'phase2-stagnant-plan',
    manifest: modelManifest(),
  });
  const needsInput = await runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'needs_input',
    { timeoutMs: 10_000 },
  );

  assert.deepEqual(executor.actions, ['xlsx_transform', 'xlsx_patch_and_transform']);
  assert.equal(needsInput.progress.stagnationCount, 1);
  assert.ok(needsInput.events.some((event) => event.type === 'progress.stalled'));
  assert.equal(
    needsInput.events.at(-1).data.reason,
    'repeated_no_progress_plan',
  );
  assert.equal(needsInput.usageRecords.length, 3);
});

test('Context projection compacts old item summaries and emits one compacted event', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2-context-'));
  const relay = await new IsolatedModelRelay().start();
  const store = new FileTaskStore(path.join(rootDir, 'runtime'));
  await store.init();
  const created = await store.createTask({
    idempotencyKey: 'phase2-context-compaction',
    manifest: modelManifest({ intent: 'x'.repeat(3_000) }),
  });
  await store.mutateTask(created.task.taskId, (task, emit) => {
    for (let index = 0; index < 40; index += 1) {
      emit({
        type: 'item.completed',
        item: {
          itemId: `historical-${index}`,
          kind: 'historical_fixture',
          status: 'completed',
          summary: `summary-${index}-${'y'.repeat(700)}`,
        },
      });
    }
    return true;
  });
  const runtime = new FileAgentRuntime({
    store,
    provider: createProvider({ rootDir, relay, maxChars: 4_000 }),
    executor: new FakeExecutor(),
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await relay.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const completed = await runtime.waitFor(
    created.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 10_000 },
  );

  const compacted = completed.events.filter((event) => event.type === 'context.compacted');
  assert.equal(compacted.length, 1);
  assert.ok(compacted[0].data.omittedItemCount > 0);
  assert.ok(compacted[0].data.projectionCharacters <= 4_000);
  const sentContext = relay.requests[0].context;
  assert.ok(JSON.stringify(sentContext).length <= 4_000);
  assert.ok(sentContext.recentItems.length < 40);
});

test('Model call journal rejects digest conflicts and marks non-idempotent pending calls ambiguous', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2-journal-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const journal = new FileModelCallJournal(rootDir);

  await journal.begin({
    callId: 'call-conflict',
    requestDigest: 'digest-a',
    routeId: 'file-agent-primary',
    supportsIdempotency: true,
  });
  await assert.rejects(
    journal.begin({
      callId: 'call-conflict',
      requestDigest: 'digest-b',
      routeId: 'file-agent-primary',
      supportsIdempotency: true,
    }),
    ProviderCallConflictError,
  );

  await journal.begin({
    callId: 'call-ambiguous',
    requestDigest: 'digest-c',
    routeId: 'file-agent-primary',
    supportsIdempotency: false,
  });
  await assert.rejects(
    journal.begin({
      callId: 'call-ambiguous',
      requestDigest: 'digest-c',
      routeId: 'file-agent-primary',
      supportsIdempotency: false,
    }),
    ProviderAmbiguousCommitError,
  );
  assert.equal((await journal.get('call-ambiguous')).status, 'ambiguous');
});

test('Provider rejects unknown actions and command-bearing model output', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2-protocol-'));
  const relay = await new IsolatedModelRelay({
    responseFor: () => ({
      schemaVersion: '1.0',
      summary: 'Attempt an unsupported command',
      needsInput: false,
      actions: [
        { kind: 'run_shell', summary: 'Run arbitrary shell', command: 'cat /etc/passwd' },
      ],
    }),
  }).start();
  const runtime = new FileAgentRuntime({
    store: new FileTaskStore(path.join(rootDir, 'runtime')),
    provider: createProvider({ rootDir, relay }),
    executor: new FakeExecutor(),
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await relay.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const submitted = await runtime.submit({
    idempotencyKey: 'phase2-invalid-model-action',
    manifest: modelManifest(),
  });
  const failed = await runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'failed',
    { timeoutMs: 10_000 },
  );
  assert.equal(failed.error.code, 'PROVIDER_PROTOCOL');
  assert.match(failed.error.message, /unsupported fields|not allowed/);
});

test('Ambiguous provider completion moves the task to needs_input without an automatic retry', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2-ambiguous-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let calls = 0;
  const provider = {
    async plan() {
      calls += 1;
      throw new ProviderAmbiguousCommitError('The relay may already have charged this call');
    },
    async repair() {
      throw new Error('repair must not run');
    },
  };
  const runtime = new FileAgentRuntime({
    store: new FileTaskStore(path.join(rootDir, 'runtime')),
    provider,
    executor: new FakeExecutor(),
  });
  await runtime.start();
  t.after(() => runtime.stop());
  const submitted = await runtime.submit({
    idempotencyKey: 'phase2-provider-ambiguous-runtime',
    manifest: modelManifest(),
  });
  const needsInput = await runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'needs_input',
    { timeoutMs: 10_000 },
  );
  assert.equal(calls, 1);
  assert.equal(needsInput.events.at(-1).data.reason, 'provider_ambiguous_commit');
  assert.equal(needsInput.usageRecords.length, 0);
});
