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
  FileAgentReconciler,
  LibreChatFileAgentConnector,
  MemoryDeliveryStore,
  RecordedLibreChatPorts,
  RuntimeClient,
  createUpstreamControllerBridge,
  installUpstreamControllerBridge,
} from '../src/index.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class HarnessProvider {
  async plan({ callId }) {
    return {
      value: {
        schemaVersion: '1.0',
        summary: 'Generate one verified workbook',
        needsInput: false,
        actions: [{ kind: 'xlsx_transform', summary: 'Transform workbook' }],
      },
      call: {
        callId,
        modelRouteId: 'file-agent-primary',
        providerModel: 'gpt-5.6-sol',
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

class HarnessExecutor extends ExecutorAdapter {
  async prepare({ task }) {
    return { workspaceRoot: `/mnt/data/.agent/${task.taskId}` };
  }

  async execute({ action }) {
    return { actionKind: action.kind };
  }

  async verify() {
    return { passed: true, summary: 'Workbook verified' };
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

class MemoryBillingSnapshots {
  constructor() {
    this.snapshots = new Map();
  }

  async create(value) {
    const snapshot = {
      ...structuredClone(value),
      snapshotId: `snapshot-${this.snapshots.size + 1}`,
    };
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return structuredClone(snapshot);
  }

  async get(snapshotId) {
    return structuredClone(this.snapshots.get(snapshotId) ?? null);
  }
}

async function waitForDelivery(store, deliveryId, status, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const delivery = await store.get(deliveryId);
    if (delivery?.status === status) {
      return delivery;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for delivery ${deliveryId} to reach ${status}`);
}

test('Phase 3D host harness completes one source-level Runtime handoff', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'phase3d-host-'));
  const runtime = new FileAgentRuntime({
    store: new FileTaskStore(rootDir),
    provider: new HarnessProvider(),
    executor: new HarnessExecutor(),
    maxConcurrentTasks: 1,
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await rm(rootDir, { recursive: true, force: true });
  });

  const runtimeClient = new RuntimeClient({
    baseUrl: 'http://runtime.phase3d',
    fetchImpl: (url, init) => handleRuntimeFetch(
      runtime,
      new Request(url, init),
      { capabilities: DEFAULT_RUNTIME_CAPABILITIES },
    ),
  });
  const deliveryStore = new MemoryDeliveryStore();
  const ports = new RecordedLibreChatPorts();
  const connector = new LibreChatFileAgentConnector({
    store: deliveryStore,
    runtimeClient,
    ports,
    featureEnabled: true,
    allowlistedUserIds: new Set(['user-1']),
  });
  const reconciler = new FileAgentReconciler({
    connector,
    intervalMs: 50,
  });
  reconciler.start();
  t.after(() => reconciler.stop());

  const billingSnapshotStore = new MemoryBillingSnapshots();
  const bridge = createUpstreamControllerBridge({
    connector,
    billingSnapshotStore,
    modelRouteId: 'file-agent-primary',
    getBalanceConfig: () => ({ enabled: true }),
    getTransactionsConfig: () => ({ enabled: true }),
    getMultiplier: ({ tokenType }) => tokenType === 'prompt' ? 0.6 : 3.6,
    getCacheMultiplier: ({ cacheType }) => cacheType === 'read' ? 0.06 : 0.75,
    scheduleReconcile: ({ submission }) => reconciler.wake(submission.delivery.deliveryId),
  });
  const app = { locals: {} };
  const uninstall = installUpstreamControllerBridge({ app, bridge });
  t.after(uninstall);

  let persistenceCalls = 0;
  const result = await app.locals.fileAgentRuntimeBridge.tryRoute({
    req: {
      app,
      user: { id: 'user-1', tenantId: 'tenant-1' },
      body: { files: [{ file_id: 'file-1' }] },
      config: {},
    },
    client: {
      options: {
        endpoint: 'agents',
        endpointTokenConfig: {
          'gpt-5.6-sol': { prompt: 0.6, completion: 3.6, read: 0.06, write: 0.75 },
        },
        agent: { endpoint: 'custom', model: 'gpt-5.6-sol' },
        attachments: [{
          file_id: 'file-1',
          user: 'user-1',
          tenantId: 'tenant-1',
          filename: 'source.xlsx',
          bytes: 2048,
          type: XLSX_MIME,
          metadata: {
            codeEnvRef: {
              kind: 'user',
              id: 'user-1',
              storage_session_id: 'storage-session-1',
              file_id: 'codeapi-source-1',
            },
          },
        }],
      },
    },
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    assistantMessageId: 'message-1_',
    streamId: 'conversation-1',
    text: '根据工作簿生成汇总 Excel',
    persistUserTurn: async () => {
      persistenceCalls += 1;
      return {
        userMessage: { messageId: 'message-1', conversationId: 'conversation-1' },
        conversation: { conversationId: 'conversation-1', title: 'New Chat' },
      };
    },
  });

  assert.equal(result.suppressNativeAgent, true);
  assert.equal(persistenceCalls, 1);
  await runtime.waitFor(result.taskId, (task) => task.status === 'completed');
  const delivery = await waitForDelivery(deliveryStore, result.deliveryId, 'completed');
  assert.equal(delivery.assistantMessageId, 'message-1_');
  assert.equal(ports.operations.length, 6);
  assert.match(ports.operations[0], /^transaction:prompt:/);
  assert.match(ports.operations[1], /^transaction:completion:/);
  assert.match(ports.operations[2], /^artifact:/);
  assert.deepEqual(ports.operations.slice(3), [
    'message:saved',
    'final:emitted',
    'job:completed',
  ]);
  assert.equal(billingSnapshotStore.snapshots.size, 1);
  const [snapshot] = billingSnapshotStore.snapshots.values();
  assert.deepEqual(snapshot.prices, {
    prompt: 0.6,
    completion: 3.6,
    cacheRead: 0.06,
    cacheWrite: 0.75,
  });
});
