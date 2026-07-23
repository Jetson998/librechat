import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ExecutorAdapter } from '../../file-agent-runtime/src/executor-adapter.js';
import {
  DEFAULT_RUNTIME_CAPABILITIES,
  handleRuntimeFetch,
} from '../../file-agent-runtime/src/http-server.js';
import { FileAgentRuntime } from '../../file-agent-runtime/src/runtime.js';
import { FileTaskStore } from '../../file-agent-runtime/src/task-store.js';
import {
  LibreChatFileAgentConnector,
  MemoryDeliveryStore,
  RecordedLibreChatPorts,
  RuntimeClient,
  SequenceGapError,
  buildTaskSubmission,
} from '../src/index.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class RecordedProvider {
  constructor({ needsInput = false } = {}) {
    this.needsInput = needsInput;
    this.calls = 0;
  }

  async plan({ callId, task }) {
    this.calls += 1;
    const needsInput = this.needsInput && task.instructions.length === 0;
    return {
      value: needsInput
        ? {
            schemaVersion: '1.0',
            summary: 'Wait for one bounded instruction',
            needsInput: true,
            question: '请补充要生成的工作表名称。',
            actions: [],
          }
        : {
            schemaVersion: '1.0',
            summary: 'Run one stable workbook transform',
            needsInput: false,
            actions: [{ kind: 'xlsx_transform', summary: 'Transform the authorized workbook' }],
          },
      call: {
        callId,
        modelRouteId: task.manifest.model.modelRouteId,
        providerModel: 'recorded-phase3a-model',
        replayed: false,
      },
      usage: {
        inputTokens: 100,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        outputTokens: 30,
        occurredAt: new Date().toISOString(),
      },
    };
  }

  repair(args) {
    return this.plan(args);
  }
}

class RecordedExecutor extends ExecutorAdapter {
  constructor({ artifactCount = 1, delayMs = 0, failExecute = false } = {}) {
    super();
    this.artifactCount = artifactCount;
    this.delayMs = delayMs;
    this.failExecute = failExecute;
  }

  async prepare({ task, signal }) {
    await this.#wait(signal);
    return { workspaceRoot: `/mnt/data/.agent/${task.taskId}` };
  }

  async execute({ action, signal }) {
    await this.#wait(signal);
    if (this.failExecute) {
      throw new Error('recorded executor failure');
    }
    return { actionKind: action.kind };
  }

  async verify({ signal }) {
    await this.#wait(signal);
    return { passed: true, summary: 'Recorded workbook verification passed' };
  }

  async publish({ task, signal }) {
    await this.#wait(signal);
    return {
      artifacts: Array.from({ length: this.artifactCount }, (_, index) => ({
        name: index === 0 ? 'result.xlsx' : `result-${index + 1}.xlsx`,
        mimeType: XLSX_MIME,
        size: 2048 + index,
        codeEnvRef: {
          storage_session_id: task.manifest.execution.sessionId,
          file_id: `artifact-${task.taskId}-${index + 1}`,
        },
      })),
    };
  }

  async #wait(signal) {
    if (this.delayMs > 0) {
      await delay(this.delayMs, undefined, { signal });
    }
  }
}

class InterruptingPorts extends RecordedLibreChatPorts {
  constructor({ failMessageOnce = false, failFinalOnce = false } = {}) {
    super();
    this.failMessageOnce = failMessageOnce;
    this.failFinalOnce = failFinalOnce;
  }

  async saveAssistantMessage(args) {
    if (this.failMessageOnce) {
      this.failMessageOnce = false;
      throw new Error('simulated message persistence interruption');
    }
    return super.saveAssistantMessage(args);
  }

  async emitDone(args) {
    if (this.failFinalOnce) {
      this.failFinalOnce = false;
      throw new Error('simulated final event interruption');
    }
    return super.emitDone(args);
  }
}

function request(overrides = {}) {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-1',
    assistantMessageId: 'assistant-message-1',
    streamId: 'stream-1',
    instruction: '根据工作簿生成一份汇总 Excel',
    files: [
      {
        fileId: 'librechat-file-1',
        name: 'source.xlsx',
        mimeType: XLSX_MIME,
        sha256: 'a'.repeat(64),
        conversationId: 'conversation-1',
        ownershipVerified: true,
        codeEnvRef: {
          storage_session_id: 'phase3a-session',
          file_id: 'codeapi-source-1',
        },
      },
    ],
    sessionId: 'phase3a-session',
    modelRouteId: 'file-agent-primary',
    billingSnapshotRef: 'billing-snapshot-1',
    ...overrides,
  };
}

async function createHarness(
  t,
  {
    artifactCount = 1,
    executorDelayMs = 0,
    failExecute = false,
    needsInput = false,
    ports = null,
  } = {},
) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'phase3a-runtime-'));
  const runtime = new FileAgentRuntime({
    store: new FileTaskStore(rootDir),
    provider: new RecordedProvider({ needsInput }),
    executor: new RecordedExecutor({
      artifactCount,
      delayMs: executorDelayMs,
      failExecute,
    }),
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const fetchImpl = (url, init) => handleRuntimeFetch(
    runtime,
    new Request(url, init),
    { capabilities: DEFAULT_RUNTIME_CAPABILITIES },
  );
  const runtimeClient = new RuntimeClient({ baseUrl: 'http://runtime.phase3a', fetchImpl });
  const store = new MemoryDeliveryStore();
  const recordedPorts = ports ?? new RecordedLibreChatPorts();
  const connector = new LibreChatFileAgentConnector({
    store,
    runtimeClient,
    ports: recordedPorts,
    featureEnabled: true,
    allowlistedUserIds: new Set(['user-1']),
  });
  return { connector, ports: recordedPorts, runtime, runtimeClient, store };
}

async function waitForRuntimeTerminal(harness, taskId) {
  return harness.runtime.waitFor(taskId, (task) => ['completed', 'failed', 'canceled'].includes(task.status));
}

test('Phase 3A routes only eligible allowlisted file work and ordinary chat never contacts Runtime', async (t) => {
  const harness = await createHarness(t);
  const capabilities = await harness.runtimeClient.discoverCapabilities();
  assert.ok(capabilities.taskContractVersions.includes('office-file-agent.v1'));
  assert.deepEqual(capabilities.inputMimeTypes, [XLSX_MIME]);

  let runtimeCalls = 0;
  const offlineConnector = new LibreChatFileAgentConnector({
    store: new MemoryDeliveryStore(),
    runtimeClient: {
      discoverCapabilities: async () => {
        runtimeCalls += 1;
        throw new Error('Runtime should not be called');
      },
    },
    ports: new RecordedLibreChatPorts(),
    featureEnabled: true,
    allowlistedUserIds: new Set(['user-1']),
  });
  const native = await offlineConnector.submit(request({ instruction: '你好，请介绍一下自己' }));
  assert.equal(native.accepted, false);
  assert.equal(native.suppressNativeAgent, false);
  assert.equal(runtimeCalls, 0);
  assert.equal((await harness.store.listRecoverable()).length, 0);
});

test('prepared Runtime routing performs capability discovery before durable submission', async (t) => {
  const harness = await createHarness(t);
  let capabilityCalls = 0;
  const connector = new LibreChatFileAgentConnector({
    store: harness.store,
    runtimeClient: {
      discoverCapabilities: async () => {
        capabilityCalls += 1;
        return harness.runtimeClient.discoverCapabilities();
      },
      submit: (...args) => harness.runtimeClient.submit(...args),
      getEvents: (...args) => harness.runtimeClient.getEvents(...args),
      getTask: (...args) => harness.runtimeClient.getTask(...args),
      cancel: (...args) => harness.runtimeClient.cancel(...args),
      steer: (...args) => harness.runtimeClient.steer(...args),
    },
    ports: harness.ports,
    featureEnabled: true,
    allowlistedUserIds: new Set(['user-1']),
  });
  const baseRequest = request();
  delete baseRequest.billingSnapshotRef;

  const preparedRoute = await connector.prepareRoute(baseRequest);
  assert.equal(preparedRoute.suppressNativeAgent, true);
  assert.equal('capabilities' in preparedRoute, false);
  assert.equal(capabilityCalls, 1);

  const submitted = await connector.submit(
    { ...baseRequest, billingSnapshotRef: 'billing-snapshot-1' },
    { preparedRoute },
  );
  assert.equal(submitted.accepted, true);
  assert.equal(capabilityCalls, 1);
});

test('prepared Runtime routing rejects request mutation before delivery creation', async (t) => {
  const harness = await createHarness(t);
  const baseRequest = request();
  delete baseRequest.billingSnapshotRef;
  const preparedRoute = await harness.connector.prepareRoute(baseRequest);

  await assert.rejects(
    harness.connector.submit(
      {
        ...baseRequest,
        instruction: '生成另一份不同的 Excel',
        billingSnapshotRef: 'billing-snapshot-1',
      },
      { preparedRoute },
    ),
    /inputs changed after preparation/,
  );
  assert.equal((await harness.store.listRecoverable()).length, 0);
});

test('Runtime capability rejects extra input files before user-turn persistence', async (t) => {
  const harness = await createHarness(t);
  const baseRequest = request({
    files: [
      ...request().files,
      {
        fileId: 'librechat-file-2',
        name: 'source-2.xlsx',
        mimeType: XLSX_MIME,
        sha256: 'b'.repeat(64),
        conversationId: 'conversation-1',
        ownershipVerified: true,
        codeEnvRef: {
          storage_session_id: 'phase3a-session',
          file_id: 'codeapi-source-2',
        },
      },
    ],
  });
  delete baseRequest.billingSnapshotRef;

  const prepared = await harness.connector.prepareRoute(baseRequest);

  assert.equal(prepared.suppressNativeAgent, false);
  assert.deepEqual(prepared.decision, {
    route: 'native',
    reason: 'runtime_file_count_unsupported',
  });
  assert.equal((await harness.store.listRecoverable()).length, 0);
});

test('ambiguous submit remains pending and reconciles with the same Runtime idempotency key', async (t) => {
  const harness = await createHarness(t);
  let firstSubmit = true;
  const ambiguousClient = {
    discoverCapabilities: () => harness.runtimeClient.discoverCapabilities(),
    submit: async (submission) => {
      const result = await harness.runtimeClient.submit(submission);
      if (firstSubmit) {
        firstSubmit = false;
        throw new Error('simulated response loss after Runtime acceptance');
      }
      return result;
    },
    getEvents: (...args) => harness.runtimeClient.getEvents(...args),
    getTask: (...args) => harness.runtimeClient.getTask(...args),
    cancel: (...args) => harness.runtimeClient.cancel(...args),
    steer: (...args) => harness.runtimeClient.steer(...args),
  };
  const connector = new LibreChatFileAgentConnector({
    store: harness.store,
    runtimeClient: ambiguousClient,
    ports: harness.ports,
    featureEnabled: true,
    allowlistedUserIds: new Set(['user-1']),
  });
  const pending = await connector.submit(request());
  assert.equal(pending.accepted, false);
  assert.equal(pending.pending, true);
  assert.equal(pending.suppressNativeAgent, true);
  assert.equal(pending.delivery.status, 'submitting');

  const reconciled = await connector.reconcile(pending.delivery.deliveryId);
  assert.ok(reconciled.taskId);
  const runtimeTask = await waitForRuntimeTerminal(harness, reconciled.taskId);
  assert.equal(runtimeTask.events.filter((event) => event.type === 'task.accepted').length, 1);
});

test('duplicate user-message submission creates one Runtime task and suppresses native fallback', async (t) => {
  const harness = await createHarness(t);
  const first = await harness.connector.submit(request());
  const second = await harness.connector.submit(request());
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(first.taskId, second.taskId);
  assert.equal(first.suppressNativeAgent, true);

  const runtimeTask = await waitForRuntimeTerminal(harness, first.taskId);
  assert.equal(runtimeTask.events.filter((event) => event.type === 'task.accepted').length, 1);
});

test('completed Runtime task records usage, delivers one artifact, then finalizes one message in order', async (t) => {
  const harness = await createHarness(t);
  const submitted = await harness.connector.submit(request());
  await waitForRuntimeTerminal(harness, submitted.taskId);
  const delivery = await harness.connector.reconcile(submitted.delivery.deliveryId);

  assert.equal(delivery.status, 'completed');
  assert.equal(harness.ports.transactions.size, 2);
  assert.equal(harness.ports.files.size, 1);
  assert.equal(harness.ports.messages.size, 1);
  assert.equal(harness.ports.finalEvents.size, 1);
  assert.equal(harness.ports.completedJobs.size, 1);
  assert.deepEqual(harness.ports.messages.get('assistant-message-1').fileIds.length, 1);
  assert.equal(
    harness.ports.finalEvents.get('stream-1').text,
    harness.ports.messages.get('assistant-message-1').text,
  );

  const artifactIndex = harness.ports.operations.findIndex((entry) => entry.startsWith('artifact:'));
  const messageIndex = harness.ports.operations.indexOf('message:saved');
  const finalIndex = harness.ports.operations.indexOf('final:emitted');
  const jobIndex = harness.ports.operations.indexOf('job:completed');
  assert.ok(artifactIndex < messageIndex);
  assert.ok(messageIndex < finalIndex);
  assert.ok(finalIndex < jobIndex);

  await harness.connector.reconcile(submitted.delivery.deliveryId);
  assert.equal(harness.ports.transactions.size, 2);
  assert.equal(harness.ports.files.size, 1);
  assert.equal(harness.ports.operations.filter((entry) => entry === 'message:saved').length, 1);
});

test('a new Connector instance resumes from delivery lastSequence without duplicate side effects', async (t) => {
  const harness = await createHarness(t);
  const submitted = await harness.connector.submit(request());
  await waitForRuntimeTerminal(harness, submitted.taskId);

  const restarted = new LibreChatFileAgentConnector({
    store: harness.store,
    runtimeClient: harness.runtimeClient,
    ports: harness.ports,
    featureEnabled: true,
    allowlistedUserIds: new Set(['user-1']),
  });
  const delivery = await restarted.reconcile(submitted.delivery.deliveryId);
  assert.equal(delivery.status, 'completed');
  assert.equal(harness.ports.transactions.size, 2);
  assert.equal(harness.ports.files.size, 1);
});

test('message persistence interruption resumes delivery without rerunning Runtime or duplicating artifact', async (t) => {
  const ports = new InterruptingPorts({ failMessageOnce: true });
  const harness = await createHarness(t, { ports });
  const submitted = await harness.connector.submit(request());
  const runtimeTask = await waitForRuntimeTerminal(harness, submitted.taskId);

  await assert.rejects(
    harness.connector.reconcile(submitted.delivery.deliveryId),
    /message persistence interruption/,
  );
  assert.equal((await harness.store.get(submitted.delivery.deliveryId)).status, 'delivery_retry');
  assert.equal(ports.files.size, 1);
  assert.equal(ports.messages.size, 0);

  const completed = await harness.connector.reconcile(submitted.delivery.deliveryId);
  assert.equal(completed.status, 'completed');
  assert.equal(ports.files.size, 1);
  assert.equal(runtimeTask.events.filter((event) => event.type === 'task.accepted').length, 1);
});

test('final-event interruption resumes after the saved message without creating a sibling', async (t) => {
  const ports = new InterruptingPorts({ failFinalOnce: true });
  const harness = await createHarness(t, { ports });
  const submitted = await harness.connector.submit(request());
  await waitForRuntimeTerminal(harness, submitted.taskId);

  await assert.rejects(
    harness.connector.reconcile(submitted.delivery.deliveryId),
    /final event interruption/,
  );
  assert.equal((await harness.store.get(submitted.delivery.deliveryId)).status, 'delivery_retry');
  assert.equal(ports.messages.size, 1);
  assert.equal(ports.finalEvents.size, 0);

  const completed = await harness.connector.reconcile(submitted.delivery.deliveryId);
  assert.equal(completed.status, 'completed');
  assert.equal(ports.messages.size, 1);
  assert.equal(ports.operations.filter((entry) => entry === 'message:saved').length, 1);
});

test('needs_input waits without looping and steer resumes the same Runtime task', async (t) => {
  const harness = await createHarness(t, { needsInput: true });
  const submitted = await harness.connector.submit(request());
  await harness.runtime.waitFor(submitted.taskId, (task) => task.status === 'needs_input');
  const waiting = await harness.connector.reconcile(submitted.delivery.deliveryId);
  assert.equal(waiting.status, 'needs_input');
  assert.equal(harness.ports.messages.get('assistant-message-1').needsInput, true);

  await harness.connector.steer(submitted.delivery.deliveryId, {
    instructionId: 'instruction-1',
    text: '工作表名称使用汇总。',
  });
  await waitForRuntimeTerminal(harness, submitted.taskId);
  const completed = await harness.connector.reconcile(submitted.delivery.deliveryId);
  assert.equal(completed.taskId, submitted.taskId);
  assert.equal(completed.status, 'completed');
});

test('cancel ends the same delivery and preserves the preallocated assistant message', async (t) => {
  const harness = await createHarness(t, { executorDelayMs: 100 });
  const submitted = await harness.connector.submit(request());
  await harness.runtime.waitFor(submitted.taskId, (task) => task.status === 'preparing');
  const canceled = await harness.connector.cancel(submitted.delivery.deliveryId);
  assert.equal(canceled.status, 'canceled');
  assert.equal(harness.ports.messages.get('assistant-message-1').status, 'canceled');
  assert.equal(harness.ports.completedJobs.has('stream-1'), true);
});

test('Runtime failure retains prior usage once and finalizes the original assistant message', async (t) => {
  const harness = await createHarness(t, { failExecute: true });
  const submitted = await harness.connector.submit(request());
  const runtimeTask = await waitForRuntimeTerminal(harness, submitted.taskId);
  assert.equal(runtimeTask.status, 'failed');

  const failed = await harness.connector.reconcile(submitted.delivery.deliveryId);
  assert.equal(failed.status, 'failed');
  assert.equal(harness.ports.transactions.size, 2);
  assert.equal(harness.ports.files.size, 0);
  assert.equal(harness.ports.messages.get('assistant-message-1').status, 'failed');
  assert.equal(harness.ports.completedJobs.has('stream-1'), true);

  await harness.connector.reconcile(submitted.delivery.deliveryId);
  assert.equal(harness.ports.transactions.size, 2);
  assert.equal(harness.ports.messages.size, 1);
});

test('more than three visible artifacts ends delivery before a fourth file record is created', async (t) => {
  const harness = await createHarness(t, { artifactCount: 4 });
  const submitted = await harness.connector.submit(request());
  await waitForRuntimeTerminal(harness, submitted.taskId);
  const failed = await harness.connector.reconcile(submitted.delivery.deliveryId);
  assert.equal(failed.status, 'delivery_failed');
  assert.equal(harness.ports.files.size, 3);
  assert.equal(harness.ports.messages.get('assistant-message-1').status, 'delivery_failed');
  assert.equal(harness.ports.completedJobs.has('stream-1'), true);
});

test('usage and artifact event replay rebuilds receipts without duplicate transactions or files', async (t) => {
  const harness = await createHarness(t);
  const submitted = await harness.connector.submit(request());
  const runtimeTask = await waitForRuntimeTerminal(harness, submitted.taskId);
  await harness.connector.reconcile(submitted.delivery.deliveryId);
  const usageSequence = runtimeTask.events.find((event) => event.type === 'usage.recorded').sequence;
  const originalOperationCount = harness.ports.operations.length;

  await harness.store.mutate(submitted.delivery.deliveryId, (draft) => {
    draft.status = 'running';
    draft.lastSequence = usageSequence - 1;
    draft.usageReceipts = {};
    draft.artifactReceipts = {};
    draft.finalization = {
      messageSaved: false,
      finalEventSaved: false,
      jobCompleted: false,
    };
  });
  const replayed = await harness.connector.reconcile(submitted.delivery.deliveryId);
  assert.equal(replayed.status, 'completed');
  assert.equal(harness.ports.transactions.size, 2);
  assert.equal(harness.ports.files.size, 1);
  assert.equal(harness.ports.messages.size, 1);
  assert.equal(harness.ports.operations.length, originalOperationCount);
});

test('manifest rejects a visible artifact limit above the product maximum', () => {
  assert.throws(
    () => buildTaskSubmission(request({ limits: { maxVisibleArtifacts: 4 } })),
    /between 1 and 3/,
  );
});

test('a sequence gap stops consumption without advancing the durable cursor', async () => {
  const runtimeClient = {
    discoverCapabilities: async () => DEFAULT_RUNTIME_CAPABILITIES,
    submit: async () => ({ task: { taskId: '00000000-0000-4000-8000-000000000001' } }),
    getEvents: async () => ({ events: [{ sequence: 2, type: 'task.accepted', phase: 'accepted' }] }),
  };
  const store = new MemoryDeliveryStore();
  const ports = new RecordedLibreChatPorts();
  const connector = new LibreChatFileAgentConnector({
    store,
    runtimeClient,
    ports,
    featureEnabled: true,
    allowlistedUserIds: new Set(['user-1']),
  });
  const submitted = await connector.submit(request());
  await assert.rejects(
    connector.reconcile(submitted.delivery.deliveryId),
    SequenceGapError,
  );
  assert.equal((await store.get(submitted.delivery.deliveryId)).lastSequence, 0);
});

test('task manifest and delivery omit model credentials, Runtime URL, prices, and raw LibreChat IDs', async (t) => {
  const built = buildTaskSubmission(request());
  const manifestText = JSON.stringify(built.manifest);
  for (const forbidden of [
    'user-1',
    'conversation-1',
    'user-message-1',
    'librechat-file-1',
    'apiKey',
    'baseUrl',
    'promptPrice',
    'history',
  ]) {
    assert.equal(manifestText.includes(forbidden), false);
  }

  const harness = await createHarness(t);
  const submitted = await harness.connector.submit(request());
  const deliveryText = JSON.stringify(await harness.store.get(submitted.delivery.deliveryId));
  assert.equal(deliveryText.includes('apiKey'), false);
  assert.equal(deliveryText.includes('http://runtime.phase3a'), false);
  assert.equal(deliveryText.includes('promptPrice'), false);
});
