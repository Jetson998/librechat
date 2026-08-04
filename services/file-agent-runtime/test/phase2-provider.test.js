import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ContextProjector } from '../src/context-projector.js';
import { CodeApiHttpTransport } from '../src/codeapi-transport.js';
import { CodeApiXlsxExecutor, XLSX_MIME } from '../src/deterministic-xlsx.js';
import { DOCX_MIME, WORD_VERIFIER_PROFILE } from '../src/deterministic-word.js';
import { PPTX_MIME, PPTX_VERIFIER_PROFILE } from '../src/deterministic-pptx-v1.js';
import { ExecutorAdapter } from '../src/executor-adapter.js';
import { FakeExecutor } from '../src/fake-adapters.js';
import { FileModelCallJournal } from '../src/model-call-journal.js';
import { OpenAiChatTransport, SingleModelAgentProvider } from '../src/openai-compatible-provider.js';
import {
  ProviderAmbiguousCommitError,
  ProviderCallConflictError,
  ProviderProtocolError,
} from '../src/provider-adapter.js';
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

function wordModelManifest(overrides = {}) {
  return {
    schemaVersion: '1.0',
    taskContractVersion: 'office-file-agent.v1.1',
    taskType: 'office_transform',
    intent: 'Modify one authorized Word document',
    acceptance: ['Return one verified DOCX artifact'],
    acceptanceAssertions: [{
      type: 'word.paragraph_append.v1',
      text: 'Provider output',
    }],
    model: {
      modelRouteId: 'file-agent-word',
      capabilityProfile: 'word-edit-v1',
    },
    execution: {
      executor: 'codeapi',
      sessionId: 'word-provider-session',
    },
    inputs: [{
      logicalName: 'source.docx',
      mimeType: DOCX_MIME,
      sha256: 'a'.repeat(64),
      codeEnvRef: {
        storage_session_id: 'word-provider-session',
        file_id: 'word-provider-file',
      },
    }],
    limits: { maxVisibleArtifacts: 1 },
    ...overrides,
  };
}

function officeProfileManifest({ capabilityProfile, mimeType, logicalName, inputRef }) {
  const isPptx = capabilityProfile === 'pptx-edit-v1';
  return {
    schemaVersion: '1.0',
    taskContractVersion: 'office-file-agent.v1.2',
    taskType: 'office_transform',
    intent: `Modify one authorized ${logicalName}`,
    acceptance: [`Return one verified ${isPptx ? 'PPTX' : 'XLSX'} artifact`],
    model: {
      modelRouteId: `file-agent-${isPptx ? 'pptx' : 'xlsx'}-repair`,
      capabilityProfile,
    },
    execution: {
      executor: 'codeapi',
      sessionId: 'phase2-office-repair-session',
    },
    inputs: [{
      logicalName,
      mimeType,
      sha256: 'a'.repeat(64),
      codeEnvRef: {
        storage_session_id: 'phase2-office-repair-session',
        file_id: inputRef,
      },
    }],
    limits: { maxVisibleArtifacts: 1 },
  };
}

function officeAction({ worker, targetRef, inputRef, operation, parameters, verificationProfile }) {
  return {
    schemaVersion: '1.0',
    objective: 'Apply one bounded Office change',
    worker,
    inputRefs: [inputRef],
    targetRef,
    parameters: { operation, ...parameters },
    expectedChange: ['bounded Office mutation'],
    verificationProfile,
    onFailure: 'replan',
    summary: 'Apply the bounded change',
  };
}

async function createOfficeProfileProvider({ rootDir, capabilityProfile, plan }) {
  return new SingleModelAgentProvider({
    routes: {
      [`file-agent-${capabilityProfile === 'pptx-edit-v1' ? 'pptx' : 'xlsx'}-repair`]: {
        baseUrl: 'https://office-repair.example.invalid',
        model: 'office-repair-model',
        capabilityProfile,
        supportsIdempotency: true,
        outputBudgetTokens: 256,
      },
    },
    transport: {
      async invoke() {
        return {
          plan,
          providerModel: 'office-repair-model',
          usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 30 },
        };
      },
    },
    journal: new FileModelCallJournal(path.join(rootDir, 'provider-journal')),
    projector: new ContextProjector(),
  });
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
  assert.deepEqual(
    failed.usageRecords.map((usage) => [
      usage.inputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.outputTokens,
    ]),
    [[500, 0, 0, 70]],
  );
  const usageSequence = failed.events.find((event) => event.type === 'usage.recorded').sequence;
  const itemFailed = failed.events.find((event) => event.type === 'item.failed');
  const taskFailed = failed.events.find((event) => event.type === 'task.failed');
  assert.ok(usageSequence < itemFailed.sequence);
  assert.ok(itemFailed.sequence < taskFailed.sequence);
  const journal = new FileModelCallJournal(path.join(rootDir, 'provider-journal'));
  const journalRecord = await journal.get(itemFailed.item.itemId);
  assert.equal(journalRecord.status, 'completed_invalid');
  assert.equal(journalRecord.receipt.error.code, 'PROVIDER_PROTOCOL');
  const persistedJournal = JSON.stringify(journalRecord);
  assert.ok(!persistedJournal.includes('run_shell'));
  assert.ok(!persistedJournal.includes('cat /etc/passwd'));
  assert.ok(!persistedJournal.includes('command'));
});

test('Completed invalid plan replays its safe receipt without another model request', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2-invalid-replay-'));
  const relay = await new IsolatedModelRelay({
    responseFor: () => ({
      schemaVersion: '1.0',
      summary: 'Return one plan with an unsupported top-level field',
      needsInput: false,
      actions: [{ kind: 'xlsx_transform', summary: 'Use the stable transform' }],
      unsupportedDetail: 'must-not-be-persisted',
    }),
  }).start();
  t.after(async () => {
    await relay.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const provider = createProvider({ rootDir, relay, supportsIdempotency: false });
  const task = {
    taskId: 'phase2-invalid-replay-task',
    manifest: modelManifest(),
    phase: 'planning',
    planRevision: 0,
    instructionRevision: 0,
    events: [],
    itemResults: {},
    progress: {
      stagnationCount: 0,
      lastFailedVerificationFingerprint: null,
    },
  };
  const callId = 'phase2-invalid-replay-call';

  let firstError;
  await assert.rejects(
    provider.plan({ callId, task }),
    (error) => {
      firstError = error;
      return error instanceof ProviderProtocolError && error.receipt?.call?.replayed === false;
    },
  );
  let replayError;
  await assert.rejects(
    provider.plan({ callId, task }),
    (error) => {
      replayError = error;
      return error instanceof ProviderProtocolError && error.receipt?.call?.replayed === true;
    },
  );

  assert.equal(relay.executionCount(callId), 1);
  assert.deepEqual(replayError.receipt.usage, firstError.receipt.usage);
  assert.equal(replayError.receipt.responseDigest, firstError.receipt.responseDigest);
  const journalRecord = await new FileModelCallJournal(
    path.join(rootDir, 'provider-journal'),
  ).get(callId);
  assert.equal(journalRecord.status, 'completed_invalid');
  assert.ok(!JSON.stringify(journalRecord).includes('must-not-be-persisted'));
});

test('Strict JSON Schema forbids extra fields and cached_creation_tokens maps to cache write', async () => {
  let requestBody;
  const transport = new OpenAiChatTransport({
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        model: 'strict-schema-model',
        choices: [
          {
            message: {
              content: JSON.stringify({
                schemaVersion: '1.0',
                summary: 'Use the stable transform',
                needsInput: false,
                question: null,
                actions: [{ kind: 'xlsx_transform', summary: 'Transform the workbook' }],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 800,
          completion_tokens: 60,
          prompt_tokens_details: {
            cached_tokens: 120,
            cached_creation_tokens: 45,
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const result = await transport.invoke({
    callId: 'strict-schema-call',
    route: {
      baseUrl: 'https://strict.example.invalid',
      model: 'strict-schema-model',
      outputBudgetTokens: 256,
      structuredOutputMode: 'json_schema',
    },
    operation: 'plan',
    context: { schemaVersion: '1.0', objective: 'Test strict schema' },
  });

  assert.equal(requestBody.response_format.type, 'json_schema');
  assert.equal(requestBody.response_format.json_schema.strict, true);
  assert.equal(requestBody.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(
    requestBody.response_format.json_schema.schema.properties.actions.items.additionalProperties,
    false,
  );
  assert.equal(result.usage.cacheReadTokens, 120);
  assert.equal(result.usage.cacheWriteTokens, 45);
});

test('Word provider emits the bounded worker schema and validates a v1.1 plan', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-word-provider-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let requestBody;
  const transport = new OpenAiChatTransport({
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        model: 'word-provider-model',
        choices: [{
          message: {
            content: JSON.stringify({
              schemaVersion: '1.0',
              summary: 'Inspect and append one paragraph',
              needsInput: false,
              question: null,
              actions: [
                {
                  schemaVersion: '1.0',
                  objective: 'Inspect the authorized Word document',
                  worker: 'word.inspect.v1',
                  inputRefs: ['input:source-docx'],
                  targetRef: 'candidate:working-docx',
                  parameters: {
                    operation: 'inspect',
                    find: null,
                    replace: null,
                    text: null,
                    occurrence: null,
                    tableIndex: null,
                    rowIndex: null,
                    columnIndex: null,
                    style: null,
                    expectedBaseSha256: null,
                  },
                  expectedChange: ['document.structure'],
                  verificationProfile: WORD_VERIFIER_PROFILE,
                  onFailure: 'replan',
                  summary: 'Inspect the Word document',
                },
                {
                  schemaVersion: '1.0',
                  objective: 'Append a bounded paragraph',
                  worker: 'word.transform.v1',
                  inputRefs: ['input:source-docx'],
                  targetRef: 'candidate:working-docx',
                  parameters: {
                    operation: 'append_paragraph',
                    find: null,
                    replace: null,
                    text: 'Provider output',
                    occurrence: null,
                    tableIndex: null,
                    rowIndex: null,
                    columnIndex: null,
                    style: null,
                    expectedBaseSha256: null,
                  },
                  expectedChange: ['document.paragraph'],
                  verificationProfile: WORD_VERIFIER_PROFILE,
                  onFailure: 'replan',
                  summary: 'Append the paragraph',
                },
              ],
            }),
          },
        }],
        usage: {
          prompt_tokens: 320,
          completion_tokens: 80,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const provider = new SingleModelAgentProvider({
    routes: {
      'file-agent-word': {
        baseUrl: 'https://word-provider.example.invalid',
        model: 'word-provider-model',
        capabilityProfile: 'word-edit-v1',
        supportsIdempotency: true,
        outputBudgetTokens: 256,
        structuredOutputMode: 'json_schema',
      },
    },
    transport,
    journal: new FileModelCallJournal(path.join(rootDir, 'provider-journal')),
    projector: new ContextProjector(),
  });

  const result = await provider.plan({
    callId: 'word-provider-plan',
    task: {
      taskId: 'word-provider-task',
      manifest: wordModelManifest(),
      phase: 'planning',
      planRevision: 0,
      instructionRevision: 0,
      events: [],
      itemResults: {},
      progress: {},
    },
  });

  assert.equal(result.value.actions.length, 2);
  assert.equal(result.value.actions[1].parameters.operation, 'append_paragraph');
  assert.equal(requestBody.response_format.type, 'json_schema');
  assert.equal(requestBody.response_format.json_schema.schema.properties.actions.maxItems, 4);
  assert.ok(
    requestBody.response_format.json_schema.schema.properties.actions.items.properties.worker.enum.includes('word.patch.v1'),
  );
  assert.equal(
    requestBody.response_format.json_schema.schema.properties.actions.items.properties.targetRef.const,
    'candidate:working-docx',
  );
});

test('PPTX strict schema exposes every PPTX action parameter and validates a title edit', async () => {
  let requestBody;
  const transport = new OpenAiChatTransport({
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        model: 'pptx-provider-model',
        choices: [{
          message: {
            content: JSON.stringify({
              schemaVersion: '1.0',
              summary: 'Update the presentation title',
              needsInput: false,
              question: null,
              actions: [{
                schemaVersion: '1.0',
                objective: 'Update the title on the first slide',
                worker: 'pptx.transform.v1',
                inputRefs: ['input:source-pptx'],
                targetRef: 'candidate:working-pptx',
                parameters: {
                  operation: 'replace_text',
                  sheet: null,
                  cell: null,
                  slide: 1,
                  shape: 'TitleBox',
                  row: null,
                  column: null,
                  layoutIndex: null,
                  value: 'Updated Report',
                  formula: null,
                  from: null,
                  to: null,
                  order: null,
                  numberFormat: null,
                  style: null,
                  tableName: null,
                  ref: null,
                  styleName: null,
                  chartType: null,
                  dataRange: null,
                  title: null,
                  anchor: null,
                  destination: null,
                  expectedBaseSha256: null,
                },
                expectedChange: ['slide1.TitleBox'],
                verificationProfile: PPTX_VERIFIER_PROFILE,
                onFailure: 'replan',
                summary: 'Update the title',
              }],
            }),
          },
        }],
        usage: { prompt_tokens: 200, completion_tokens: 40 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const result = await transport.invoke({
    callId: 'pptx-provider-schema-call',
    route: {
      baseUrl: 'https://pptx-provider.example.invalid',
      model: 'pptx-provider-model',
      outputBudgetTokens: 256,
      capabilityProfile: 'pptx-edit-v1',
      structuredOutputMode: 'json_schema',
    },
    operation: 'plan',
    context: { schemaVersion: '1.0', objective: 'Update a PPTX title' },
  });

  const parameters = requestBody.response_format.json_schema.schema.properties.actions.items.properties.parameters;
  for (const field of ['slide', 'shape', 'row', 'column', 'layoutIndex']) {
    assert.ok(parameters.properties[field], `PPTX schema must expose ${field}`);
    assert.ok(parameters.required.includes(field), `PPTX schema must require ${field}`);
  }
  assert.equal(result.plan.actions[0].parameters.slide, 1);
  assert.equal(result.plan.actions[0].parameters.shape, 'TitleBox');
});

test('XLSX and PPTX strict schemas use the worker-specific order types', async () => {
  for (const [capabilityProfile, expectedType] of [
    ['xlsx-edit-v1', 'string'],
    ['pptx-edit-v1', 'integer'],
  ]) {
    let requestBody;
    const transport = new OpenAiChatTransport({
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          model: 'order-schema-model',
          choices: [{
            message: {
              content: JSON.stringify({
                schemaVersion: '1.0',
                summary: 'Inspect the Office file',
                needsInput: true,
                question: 'Need more context',
                actions: [],
              }),
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await transport.invoke({
      callId: `order-schema-${capabilityProfile}`,
      route: {
        baseUrl: 'https://order-schema.example.invalid',
        model: 'order-schema-model',
        outputBudgetTokens: 128,
        capabilityProfile,
        structuredOutputMode: 'json_schema',
      },
      operation: 'plan',
      context: { schemaVersion: '1.0', objective: 'Inspect the Office file' },
    });
    const orderSchema = requestBody.response_format.json_schema.schema
      .properties.actions.items.properties.parameters.properties.order;
    assert.equal(orderSchema.anyOf[0].items.type, expectedType, capabilityProfile);
  }
});

test('Provider accepts a strict PPTX reorder plan with integer slide numbers', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-pptx-order-provider-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const provider = await createOfficeProfileProvider({
    rootDir,
    capabilityProfile: 'pptx-edit-v1',
    plan: {
      schemaVersion: '1.0',
      summary: 'Reorder the presentation slides',
      needsInput: false,
      question: null,
      actions: [officeAction({
        worker: 'pptx.transform.v1',
        targetRef: 'candidate:working-pptx',
        inputRef: 'input:source-pptx',
        operation: 'reorder_slides',
        parameters: { order: [2, 1] },
        verificationProfile: PPTX_VERIFIER_PROFILE,
      })],
    },
  });
  const result = await provider.plan({
    callId: 'pptx-order-provider-plan',
    task: {
      taskId: 'pptx-order-provider-task',
      manifest: officeProfileManifest({
        capabilityProfile: 'pptx-edit-v1',
        mimeType: PPTX_MIME,
        logicalName: 'source.pptx',
        inputRef: 'pptx-provider-file',
      }),
      phase: 'planning',
      planRevision: 0,
      instructionRevision: 0,
      events: [],
      itemResults: {},
      progress: {},
    },
  });
  assert.deepEqual(result.value.actions[0].parameters.order, [2, 1]);
});

test('XLSX repair rejects a transform worker and requires a patch worker', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-xlsx-repair-provider-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const provider = await createOfficeProfileProvider({
    rootDir,
    capabilityProfile: 'xlsx-edit-v1',
    plan: {
      schemaVersion: '1.0',
      summary: 'Repair the workbook',
      needsInput: false,
      question: null,
      actions: [officeAction({
        worker: 'xlsx.transform.v1',
        targetRef: 'candidate:working-xlsx',
        inputRef: 'input:source-xlsx',
        operation: 'set_cell',
        parameters: { sheet: 'Source', cell: 'A1', value: 42 },
        verificationProfile: 'xlsx-structure-v1',
      })],
    },
  });
  await assert.rejects(
    provider.repair({
      callId: 'xlsx-repair-transform',
      task: {
        taskId: 'xlsx-repair-transform-task',
        manifest: officeProfileManifest({
          capabilityProfile: 'xlsx-edit-v1',
          mimeType: XLSX_MIME,
          logicalName: 'source.xlsx',
          inputRef: 'xlsx-provider-file',
        }),
        phase: 'verifying',
        planRevision: 1,
        instructionRevision: 0,
        events: [],
        itemResults: {},
        progress: {},
      },
    }),
    ProviderProtocolError,
  );
});

test('PPTX repair rejects a transform worker and requires a patch worker', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-pptx-repair-provider-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const provider = await createOfficeProfileProvider({
    rootDir,
    capabilityProfile: 'pptx-edit-v1',
    plan: {
      schemaVersion: '1.0',
      summary: 'Repair the presentation',
      needsInput: false,
      question: null,
      actions: [officeAction({
        worker: 'pptx.transform.v1',
        targetRef: 'candidate:working-pptx',
        inputRef: 'input:source-pptx',
        operation: 'replace_text',
        parameters: { slide: 1, shape: 'TitleBox', value: 'Repaired' },
        verificationProfile: PPTX_VERIFIER_PROFILE,
      })],
    },
  });
  await assert.rejects(
    provider.repair({
      callId: 'pptx-repair-transform',
      task: {
        taskId: 'pptx-repair-transform-task',
        manifest: officeProfileManifest({
          capabilityProfile: 'pptx-edit-v1',
          mimeType: PPTX_MIME,
          logicalName: 'source.pptx',
          inputRef: 'pptx-provider-file',
        }),
        phase: 'verifying',
        planRevision: 1,
        instructionRevision: 0,
        events: [],
        itemResults: {},
        progress: {},
      },
    }),
    ProviderProtocolError,
  );
});

test('XLSX and PPTX patch repair actions require expectedBaseSha256', async (t) => {
  for (const [capabilityProfile, mimeType, logicalName, inputRef, targetRef, worker, verificationProfile, parameters] of [
    ['xlsx-edit-v1', XLSX_MIME, 'source.xlsx', 'xlsx-patch-file', 'candidate:working-xlsx', 'xlsx.patch.v1', 'xlsx-structure-v1', { sheet: 'Source', cell: 'A1', value: 42 }],
    ['pptx-edit-v1', PPTX_MIME, 'source.pptx', 'pptx-patch-file', 'candidate:working-pptx', 'pptx.patch.v1', PPTX_VERIFIER_PROFILE, { slide: 1, shape: 'TitleBox', value: 'Patched' }],
  ]) {
    const rootDir = await mkdtemp(path.join(tmpdir(), `file-agent-${capabilityProfile}-patch-provider-`));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const provider = await createOfficeProfileProvider({
      rootDir,
      capabilityProfile,
      plan: {
        schemaVersion: '1.0',
        summary: 'Repair the Office file with a patch',
        needsInput: false,
        question: null,
        actions: [officeAction({
          worker,
          targetRef,
          inputRef: capabilityProfile === 'xlsx-edit-v1' ? 'input:source-xlsx' : 'input:source-pptx',
          operation: capabilityProfile === 'xlsx-edit-v1' ? 'set_cell' : 'replace_text',
          parameters,
          verificationProfile,
        })],
      },
    });
    await assert.rejects(
      provider.repair({
        callId: `${capabilityProfile}-missing-patch-hash`,
        task: {
          taskId: `${capabilityProfile}-missing-patch-hash-task`,
          manifest: officeProfileManifest({ capabilityProfile, mimeType, logicalName, inputRef }),
          phase: 'verifying',
          planRevision: 1,
          instructionRevision: 0,
          events: [],
          itemResults: {},
          progress: {},
        },
      }),
      ProviderProtocolError,
    );
  }
});

test('Word context projection includes bounded inspected document content for replanning', () => {
  const projection = new ContextProjector().project({
    manifest: {
      intent: 'Modify the authorized Word document',
      acceptance: ['Return one verified DOCX artifact'],
      acceptanceAssertions: [{
        type: 'word.paragraph_append.v1',
        text: 'Requested paragraph',
      }],
      inputs: [{ logicalName: 'source.docx', mimeType: DOCX_MIME, sha256: 'a'.repeat(64) }],
    },
    phase: 'planning',
    planRevision: 1,
    instructionRevision: 0,
    itemResults: {
      inspect: {
        operation: 'inspect',
        sha256: 'b'.repeat(64),
        paragraphCount: 2,
        tableCount: 1,
        styleCount: 1,
        headerCount: 1,
        footerCount: 1,
        paragraphs: [{ index: 0, text: 'Source paragraph', style: 'Normal', location: 'body' }],
        tables: [{ index: 0, rows: [{ index: 0, cells: ['Cell A1', 'Cell A2'] }] }],
        headers: [{ name: 'word/header1.xml', paragraphs: ['Header text'] }],
        footers: [{ name: 'word/footer1.xml', paragraphs: ['Footer text'] }],
        styles: [{ id: 'Heading1', name: 'heading 1' }],
      },
    },
    events: [],
    progress: {},
  });

  assert.equal(projection.context.document.paragraphs[0].text, 'Source paragraph');
  assert.deepEqual(projection.context.document.tables[0].rows[0].cells, ['Cell A1', 'Cell A2']);
  assert.equal(projection.context.document.headers[0].paragraphs[0], 'Header text');
  assert.equal(projection.context.document.footers[0].paragraphs[0], 'Footer text');
  assert.deepEqual(projection.context.wordAcceptanceAssertions, [{
    schemaVersion: '1.0',
    type: 'word.paragraph_append.v1',
    text: 'Requested paragraph',
  }, {
    schemaVersion: '1.0',
    type: 'word.artifact.v1',
    logicalId: 'candidate:working-docx',
    mimeType: DOCX_MIME,
    maxCount: 1,
  }]);
  assert.ok(projection.characters <= 12_000);
});

test('Word context projection preserves a long accepted value exactly', () => {
  const text = 'x'.repeat(700);
  const projection = new ContextProjector().project({
    manifest: {
      intent: 'Modify the authorized Word document',
      acceptance: ['Return one verified DOCX artifact'],
      acceptanceAssertions: [{ type: 'word.paragraph_append.v1', text }],
      inputs: [],
    },
    phase: 'planning',
    planRevision: 1,
    instructionRevision: 0,
    itemResults: {},
    events: [],
    progress: {},
  });

  assert.equal(projection.context.wordAcceptanceAssertions[0].text, text);
  assert.equal(projection.context.wordAcceptanceAssertions[0].text.includes('...'), false);
});

test('Invalid plan receipt persistence failure becomes ambiguous', async () => {
  const provider = new SingleModelAgentProvider({
    routes: {
      'file-agent-primary': {
        baseUrl: 'https://recorded.example.invalid',
        model: 'recorded-model',
        capabilityProfile: 'office-planner-v1',
        supportsIdempotency: false,
        outputBudgetTokens: 128,
      },
    },
    transport: {
      async invoke() {
        return {
          plan: {
            schemaVersion: '1.0',
            summary: 'Invalid extra field',
            needsInput: false,
            actions: [{ kind: 'xlsx_transform', summary: 'Transform' }],
            extra: true,
          },
          providerModel: 'recorded-model',
          usage: {
            inputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 20,
          },
        };
      },
    },
    journal: {
      async begin() {
        return { action: 'execute', replay: false };
      },
      async completeValid() {
        throw new Error('valid completion must not run');
      },
      async completeInvalid() {
        throw new Error('injected journal write failure');
      },
    },
    projector: {
      project() {
        return {
          context: { schemaVersion: '1.0' },
          digest: 'context-digest',
          characters: 23,
          compaction: null,
        };
      },
    },
  });

  await assert.rejects(
    provider.plan({
      callId: 'invalid-write-failure',
      task: { manifest: modelManifest() },
    }),
    ProviderAmbiguousCommitError,
  );
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
