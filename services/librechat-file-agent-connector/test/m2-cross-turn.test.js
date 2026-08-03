import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_RUNTIME_CAPABILITIES,
  handleRuntimeFetch,
} from '../../file-agent-runtime/src/http-server.js';
import { FileAgentRuntime } from '../../file-agent-runtime/src/runtime.js';
import { FileTaskStore } from '../../file-agent-runtime/src/task-store.js';
import {
  LibreChatFileAgentConnector,
  MemoryActiveTaskStore,
  MemoryDeliveryStore,
  RecordedLibreChatPorts,
  RuntimeClient,
} from '../src/index.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class CrossTurnProvider {
  constructor({ requiredInstructions = 1 } = {}) {
    this.requiredInstructions = requiredInstructions;
  }

  #usage = 0;

  #result(callId, task, value) {
    this.#usage += 1;
    return {
      value,
      call: {
        callId,
        modelRouteId: task.manifest.model?.modelRouteId ?? 'file-agent-primary',
        providerModel: 'test-cross-turn-model',
      },
      usage: {
        inputTokens: 100 + this.#usage,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        outputTokens: 30,
      },
    };
  }

  async plan({ callId, task }) {
    if (task.instructions.length < this.requiredInstructions) {
      return this.#result(callId, task, {
        schemaVersion: '1.0',
        summary: 'Ask for one missing Word or workbook detail',
        needsInput: true,
        question: '请补充继续执行所需的要求。',
        actions: [],
      });
    }
    return this.#result(callId, task, {
      schemaVersion: '1.0',
      summary: 'Produce one verified workbook',
      needsInput: false,
      actions: [{ kind: 'xlsx_transform', summary: 'Transform the authorized input' }],
    });
  }

  async repair({ callId, task }) {
    return this.plan({ callId, task });
  }
}

class CrossTurnExecutor {
  async prepare({ task }) {
    return { workspaceRoot: `/mnt/data/.agent/${task.taskId}` };
  }

  async execute({ action }) {
    return { actionKind: action.kind };
  }

  async verify() {
    return { passed: true, summary: 'Cross-turn output verified' };
  }

  async publish({ task }) {
    return {
      artifacts: [{
        name: 'result.xlsx',
        mimeType: XLSX_MIME,
        size: 4096,
        codeEnvRef: {
          storage_session_id: task.manifest.execution.sessionId,
          file_id: `artifact-${task.taskId}`,
        },
      }],
    };
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
    instruction: '根据工作簿生成汇总 Excel',
    files: [{
      fileId: 'librechat-file-1',
      name: 'source.xlsx',
      mimeType: XLSX_MIME,
      sha256: 'a'.repeat(64),
      conversationId: 'conversation-1',
      ownershipVerified: true,
      codeEnvRef: {
        storage_session_id: 'session-1',
        file_id: 'codeapi-source-1',
      },
    }],
    sessionId: 'session-1',
    modelRouteId: 'file-agent-primary',
    billingSnapshotRef: 'billing-1',
    ...overrides,
  };
}

async function createHarness(t, { requiredInstructions = 1 } = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-m2-'));
  const runtime = new FileAgentRuntime({
    store: new FileTaskStore(rootDir),
    provider: new CrossTurnProvider({ requiredInstructions }),
    executor: new CrossTurnExecutor(),
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const runtimeClient = new RuntimeClient({
    baseUrl: 'http://runtime.m2',
    fetchImpl: (url, init) => handleRuntimeFetch(
      runtime,
      new Request(url, init),
      { capabilities: DEFAULT_RUNTIME_CAPABILITIES },
    ),
  });
  const store = new MemoryDeliveryStore();
  const activeTaskStore = new MemoryActiveTaskStore();
  const ports = new RecordedLibreChatPorts();
  const connector = new LibreChatFileAgentConnector({
    store,
    activeTaskStore,
    runtimeClient,
    ports,
    featureEnabled: true,
    allowlistedUserIds: new Set(['user-1']),
  });
  return { activeTaskStore, connector, ports, runtime, store };
}

test('one Runtime task spans multiple turns with task-level receipts and one artifact', async (t) => {
  const harness = await createHarness(t, { requiredInstructions: 2 });
  const first = await harness.connector.submit(request());
  await harness.runtime.waitFor(first.taskId, (task) => task.status === 'needs_input');
  const waiting = await harness.connector.reconcile(first.delivery.deliveryId);
  assert.equal(waiting.status, 'needs_input');

  const second = await harness.connector.submitTurn({
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-2',
    assistantMessageId: 'assistant-message-2',
    streamId: 'stream-2',
    instruction: '继续执行并输出汇总文件。',
  });
  assert.equal(second.taskId, first.taskId);
  assert.notEqual(second.delivery.deliveryId, first.delivery.deliveryId);

  await harness.runtime.waitFor(first.taskId, (task) => task.status === 'needs_input');
  await harness.connector.reconcile(second.delivery.deliveryId);
  const third = await harness.connector.submitTurn({
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-3',
    assistantMessageId: 'assistant-message-3',
    streamId: 'stream-3',
    instruction: '再继续执行并交付最终文件。',
  });
  assert.equal(third.taskId, first.taskId);

  await harness.runtime.waitFor(first.taskId, (task) => task.status === 'completed');
  const completed = await harness.connector.reconcile(third.delivery.deliveryId);
  const active = await harness.activeTaskStore.getByTaskId(first.taskId);

  assert.equal(completed.status, 'completed');
  assert.equal(active.turnDeliveryIds.length, 3);
  assert.equal(active.turns[0].assistantMessageId, 'assistant-message-1');
  assert.equal(active.turns[1].assistantMessageId, 'assistant-message-2');
  assert.equal(active.turns[2].assistantMessageId, 'assistant-message-3');
  assert.equal(Object.keys(active.usageReceipts).length, 3);
  assert.equal(Object.keys(active.artifactReceipts).length, 1);
  assert.equal(harness.ports.files.size, 1);
  assert.equal(harness.ports.messages.size, 3);
  assert.equal(harness.ports.finalEvents.size, 1);
});

test('replaying the same follow-up turn keeps one delivery and one Runtime instruction', async (t) => {
  const harness = await createHarness(t);
  const first = await harness.connector.submit(request());
  await harness.runtime.waitFor(first.taskId, (task) => task.status === 'needs_input');
  await harness.connector.reconcile(first.delivery.deliveryId);

  const followUp = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-2',
    assistantMessageId: 'assistant-message-2',
    streamId: 'stream-2',
    instruction: '继续执行。',
  };
  const firstReplay = await harness.connector.submitTurn(followUp);
  const secondReplay = await harness.connector.submitTurn(followUp);
  const active = await harness.activeTaskStore.getByTaskId(first.taskId);
  const runtimeTask = await harness.runtime.getTask(first.taskId);

  assert.equal(firstReplay.delivery.deliveryId, secondReplay.delivery.deliveryId);
  assert.equal(active.turnDeliveryIds.length, 2);
  assert.equal(runtimeTask.instructions.length, 1);
});

test('multiple active tasks require explicit selection and cross-scope access is rejected', async (t) => {
  const harness = await createHarness(t);
  const first = await harness.connector.submit(request());
  const second = await harness.connector.submit(request({
    userMessageId: 'user-message-other',
    assistantMessageId: 'assistant-message-other',
    streamId: 'stream-other',
  }));
  await harness.runtime.waitFor(first.taskId, (task) => task.status === 'needs_input');
  await harness.runtime.waitFor(second.taskId, (task) => task.status === 'needs_input');

  await assert.rejects(
    harness.connector.submitTurn({
      userId: 'user-1',
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      userMessageId: 'user-message-follow-up',
      assistantMessageId: 'assistant-message-follow-up',
      streamId: 'stream-follow-up',
      instruction: '继续。',
    }),
    (error) => {
      assert.equal(error.name, 'ActiveTaskSelectionRequiredError');
      assert.equal(error.candidates.length, 2);
      return true;
    },
  );

  const active = await harness.activeTaskStore.getByTaskId(first.taskId);
  await assert.rejects(
    harness.connector.submitTurn({
      userId: 'user-1',
      tenantId: 'tenant-2',
      conversationId: 'conversation-1',
      userMessageId: 'user-message-cross-scope',
      assistantMessageId: 'assistant-message-cross-scope',
      streamId: 'stream-cross-scope',
      instruction: '继续。',
    }, { activeTaskId: active.activeTaskId }),
    /different user, tenant, or conversation/,
  );
});

test('stale CodeAPI references rebind inside the same task and workspace', async (t) => {
  const harness = await createHarness(t);
  const first = await harness.connector.submit(request());
  await harness.runtime.waitFor(first.taskId, (task) => task.status === 'needs_input');
  await harness.connector.reconcile(first.delivery.deliveryId);

  const rebound = await harness.connector.rebindTurn({
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-rebind',
    assistantMessageId: 'assistant-message-rebind',
    streamId: 'stream-rebind',
    instruction: '已重新上传，请继续使用同一个任务工作区。',
    files: [{
      fileId: 'librechat-file-1',
      conversationId: 'conversation-1',
      ownershipVerified: true,
      sha256: 'a'.repeat(64),
      mimeType: XLSX_MIME,
      codeEnvRef: {
        storage_session_id: 'session-2',
        file_id: 'codeapi-source-2',
      },
    }],
  });
  await harness.runtime.waitFor(first.taskId, (task) => task.status === 'completed');
  const active = await harness.activeTaskStore.getByTaskId(first.taskId);
  const runtimeTask = await harness.runtime.getTask(first.taskId);

  assert.equal(rebound.taskId, first.taskId);
  assert.equal(active.turns.length, 2);
  assert.equal(active.workspaceRef, (await harness.activeTaskStore.getByTaskId(first.taskId)).workspaceRef);
  assert.equal(active.inputRefs[0].codeEnvRef.storage_session_id, 'session-2');
  assert.equal(runtimeTask.manifest.inputs[0].codeEnvRef.storage_session_id, 'session-2');
  assert.equal(runtimeTask.manifest.inputs[0].codeEnvRef.file_id, 'codeapi-source-2');
});
