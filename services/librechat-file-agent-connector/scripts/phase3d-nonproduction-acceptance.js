import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { CodeApiHttpTransport } from '../../file-agent-runtime/src/codeapi-transport.js';
import { ContextProjector } from '../../file-agent-runtime/src/context-projector.js';
import { CodeApiXlsxExecutor, XLSX_MIME } from '../../file-agent-runtime/src/deterministic-xlsx.js';
import { createRuntimeHttpServer } from '../../file-agent-runtime/src/http-server.js';
import { FileModelCallJournal } from '../../file-agent-runtime/src/model-call-journal.js';
import {
  OpenAiChatTransport,
  SingleModelAgentProvider,
} from '../../file-agent-runtime/src/openai-compatible-provider.js';
import { FileAgentRuntime } from '../../file-agent-runtime/src/runtime.js';
import { FileTaskStore } from '../../file-agent-runtime/src/task-store.js';
import { IsolatedCodeApiServer } from '../../file-agent-runtime/test/isolated-codeapi.js';
import { IsolatedModelRelay } from '../../file-agent-runtime/test/isolated-model-relay.js';
import {
  FileAgentReconciler,
  LibreChatFileAgentConnector,
  MongoBillingSnapshotStore,
  MongoDeliveryStore,
  RecordedLibreChatPorts,
  RuntimeClient,
  createUpstreamControllerBridge,
  installUpstreamControllerBridge,
} from '../src/index.js';

const execFileAsync = promisify(execFile);
const CONFIRMATION = 'ONE_ISOLATED_NON_PRODUCTION_TASK';

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function loadMongoDriver() {
  const dependencyRoot = process.env.FILE_AGENT_PHASE3D_NODE_MODULES;
  const require = dependencyRoot
    ? createRequire(path.join(path.resolve(dependencyRoot), 'package.json'))
    : createRequire(import.meta.url);
  try {
    return require('mongodb');
  } catch (error) {
    throw new Error(
      'The MongoDB Node driver is required outside the repository. Set ' +
        'FILE_AGENT_PHASE3D_NODE_MODULES to an isolated dependency directory.',
      { cause: error },
    );
  }
}

function assertNonProductionMongoUri(value) {
  const url = new URL(value);
  if (url.protocol !== 'mongodb:') {
    throw new Error('FILE_AGENT_PHASE3D_MONGO_URI must use mongodb://');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Phase 3D acceptance only permits a loopback MongoDB host');
  }
  return value;
}

async function resolveMongoEnvironment(require) {
  const mode = process.env.FILE_AGENT_PHASE3D_MONGO_MODE ?? 'uri';
  if (mode === 'uri') {
    return {
      mode: 'isolated-loopback-mongodb',
      uri: assertNonProductionMongoUri(requiredEnvironment('FILE_AGENT_PHASE3D_MONGO_URI')),
      stop: async () => {},
    };
  }
  if (mode !== 'memory-server') {
    throw new Error('FILE_AGENT_PHASE3D_MONGO_MODE must equal uri or memory-server');
  }
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = require('mongodb-memory-server'));
  } catch (error) {
    throw new Error(
      'mongodb-memory-server is required in FILE_AGENT_PHASE3D_NODE_MODULES for memory-server mode.',
      { cause: error },
    );
  }
  const server = await MongoMemoryServer.create({
    binary: { version: process.env.FILE_AGENT_PHASE3D_MONGOD_VERSION ?? '8.2.1' },
    instance: { ip: '127.0.0.1' },
  });
  return {
    mode: 'mongodb-memory-server-loopback',
    uri: assertNonProductionMongoUri(server.getUri()),
    stop: () => server.stop(),
  };
}

async function createWorkbook(filePath) {
  const source = [
    'from openpyxl import Workbook',
    'import sys',
    'wb=Workbook()',
    'ws=wb.active',
    'ws.title="Source"',
    'ws.append(["Channel","Model"])',
    'ws.append(["non-production","gpt-5.6-sol"])',
    'wb.save(sys.argv[1])',
  ].join('\n');
  await execFileAsync('python3', ['-c', source, filePath]);
}

function waitForDelivery(store, deliveryId, status, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = async () => {
      try {
        const delivery = await store.get(deliveryId);
        if (delivery?.status === status) {
          resolve(delivery);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for delivery ${deliveryId} to reach ${status}`));
          return;
        }
        setTimeout(poll, 25);
      } catch (error) {
        reject(error);
      }
    };
    void poll();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createIsolatedDependencies({ rootDir, fixturePath }) {
  const codeApi = await new IsolatedCodeApiServer(path.join(rootDir, 'codeapi')).start();
  const relay = await new IsolatedModelRelay().start();
  const sessionId = 'phase3d-isolated-session';
  const codeFileId = 'phase3d-input-xlsx';
  await codeApi.registerFile({
    sessionId,
    fileId: codeFileId,
    name: 'source.xlsx',
    sourcePath: fixturePath,
  });
  return {
    sessionId,
    codeFileId,
    resourceKind: 'user',
    resourceId: 'phase3d-user',
    billingModel: 'gpt-5.6-sol',
    providerRoute: {
      baseUrl: relay.baseUrl,
      model: 'recorded-office-planner',
      apiKey: 'isolated-non-production-key',
      capabilityProfile: 'office-planner-v1',
      supportsIdempotency: true,
      outputBudgetTokens: 500,
    },
    providerTransport: new OpenAiChatTransport(),
    executorTransport: new CodeApiHttpTransport({ baseUrl: codeApi.baseUrl }),
    assertCompleted() {
      assert.equal(relay.actualExecutions.size, 2);
      assert.ok([...codeApi.actualExecutions.values()].every((count) => count === 1));
    },
    report: {
      modelRelay: 'isolated-recorded',
      codeApi: 'isolated-execution-server',
    },
    async stop() {
      await relay.stop();
      await codeApi.stop();
    },
  };
}

export async function runPhase3DAcceptance({
  confirmation = CONFIRMATION,
  createDependencies = createIsolatedDependencies,
  taskTimeoutMs = 20_000,
} = {}) {
  if (requiredEnvironment('FILE_AGENT_PHASE3D_SCOPE') !== 'non-production') {
    throw new Error('FILE_AGENT_PHASE3D_SCOPE must equal non-production');
  }
  if (requiredEnvironment('FILE_AGENT_PHASE3D_CONFIRM') !== confirmation) {
    throw new Error(`FILE_AGENT_PHASE3D_CONFIRM must equal ${confirmation}`);
  }

  const dependencyRoot = process.env.FILE_AGENT_PHASE3D_NODE_MODULES;
  const require = dependencyRoot
    ? createRequire(path.join(path.resolve(dependencyRoot), 'package.json'))
    : createRequire(import.meta.url);
  const { MongoClient } = loadMongoDriver();
  const mongoEnvironment = await resolveMongoEnvironment(require);
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase3d-acceptance-'));
  const databaseName = `file_agent_phase3d_${Date.now()}_${process.pid}`;
  const fixturePath = path.join(rootDir, 'source.xlsx');
  const mongo = new MongoClient(mongoEnvironment.uri, { serverSelectionTimeoutMS: 5_000 });
  let runtime;
  let runtimeServer;
  let dependencies;
  let reconciler;

  try {
    await createWorkbook(fixturePath);
    await mongo.connect();
    const database = mongo.db(databaseName);
    const deliveryStore = new MongoDeliveryStore({ collection: database.collection('deliveries') });
    const billingSnapshotStore = new MongoBillingSnapshotStore({
      collection: database.collection('billing_snapshots'),
    });
    await Promise.all([deliveryStore.init(), billingSnapshotStore.init()]);

    dependencies = await createDependencies({ rootDir, fixturePath });
    const {
      sessionId,
      codeFileId,
      providerRoute,
      providerTransport,
      executorTransport,
    } = dependencies;
    const userId = dependencies.userId ?? 'phase3d-user';
    const tenantId = dependencies.tenantId ?? 'phase3d-tenant';
    let provider = new SingleModelAgentProvider({
      routes: { 'file-agent-primary': providerRoute },
      transport: providerTransport,
      journal: new FileModelCallJournal(path.join(rootDir, 'provider-journal')),
      projector: new ContextProjector({ maxChars: 8_000 }),
    });
    if (dependencies.wrapProvider) {
      provider = dependencies.wrapProvider(provider);
    }

    runtime = new FileAgentRuntime({
      store: new FileTaskStore(path.join(rootDir, 'runtime')),
      provider,
      executor: new CodeApiXlsxExecutor({
        transport: executorTransport,
        timeoutMs: dependencies.executorTimeoutMs ?? 120_000,
      }),
      maxConcurrentTasks: 1,
    });
    await runtime.start();
    runtimeServer = createRuntimeHttpServer(runtime);
    await listen(runtimeServer);
    const address = runtimeServer.address();
    const runtimeClient = new RuntimeClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    const ports = new RecordedLibreChatPorts();
    const connector = new LibreChatFileAgentConnector({
      store: deliveryStore,
      runtimeClient,
      ports,
      featureEnabled: true,
      allowlistedUserIds: new Set([userId]),
      reconcilerId: `phase3d-${process.pid}`,
    });
    reconciler = new FileAgentReconciler({ connector, intervalMs: 50 });
    reconciler.start();

    const bridge = createUpstreamControllerBridge({
      connector,
      billingSnapshotStore,
      modelRouteId: 'file-agent-primary',
      getBalanceConfig: () => ({ enabled: true }),
      getTransactionsConfig: () => ({ enabled: true }),
      getMultiplier: ({ tokenType }) => (tokenType === 'prompt' ? 0.6 : 3.6),
      getCacheMultiplier: ({ cacheType }) => (cacheType === 'read' ? 0.06 : 0.75),
      scheduleReconcile: ({ submission }) => reconciler.wake(submission.delivery.deliveryId),
    });
    const app = { locals: {} };
    const uninstall = installUpstreamControllerBridge({ app, bridge });
    let persistenceCalls = 0;
    const result = await app.locals.fileAgentRuntimeBridge.tryRoute({
      req: {
        app,
        user: { id: userId, tenantId },
        body: { files: [{ file_id: 'phase3d-librechat-file' }] },
        config: {},
      },
      client: {
        options: {
          endpoint: 'agents',
          endpointTokenConfig: {
            [dependencies.billingModel]: {
              prompt: 0.6,
              completion: 3.6,
              read: 0.06,
              write: 0.75,
            },
          },
          agent: { endpoint: 'custom', model: dependencies.billingModel },
          attachments: [{
            file_id: 'phase3d-librechat-file',
            user: userId,
            tenantId,
            filename: 'source.xlsx',
            bytes: 4_096,
            type: XLSX_MIME,
            metadata: {
              codeEnvRef: {
                kind: dependencies.resourceKind,
                id: dependencies.resourceId,
                storage_session_id: sessionId,
                file_id: codeFileId,
              },
            },
          }],
        },
      },
      userId,
      conversationId: 'phase3d-conversation',
      userMessageId: 'phase3d-message',
      assistantMessageId: 'phase3d-message_',
      streamId: 'phase3d-conversation',
      text: '读取工作簿并生成一个经过验证的汇总 Excel',
      persistUserTurn: async () => {
        persistenceCalls += 1;
        return {
          userMessage: {
            messageId: 'phase3d-message',
            conversationId: 'phase3d-conversation',
          },
          conversation: { conversationId: 'phase3d-conversation', title: 'New Chat' },
        };
      },
    });
    uninstall();

    assert.equal(result.suppressNativeAgent, true);
    assert.equal(persistenceCalls, 1);
    await runtime.waitFor(result.taskId, (task) => task.status === 'completed', {
      timeoutMs: taskTimeoutMs,
    });
    const delivery = await waitForDelivery(
      deliveryStore,
      result.deliveryId,
      'completed',
      taskTimeoutMs,
    );
    const operationsBeforeReplay = [...ports.operations];
    await connector.reconcile(result.deliveryId);

    assert.equal(delivery.assistantMessageId, 'phase3d-message_');
    assert.deepEqual(ports.operations, operationsBeforeReplay);
    assert.equal(ports.transactions.size, 4);
    assert.equal(ports.files.size, 1);
    assert.equal(ports.messages.size, 1);
    assert.equal(ports.finalEvents.size, 1);
    assert.equal(ports.completedJobs.size, 1);
    assert.equal(await database.collection('deliveries').countDocuments({}), 1);
    assert.equal(await database.collection('billing_snapshots').countDocuments({}), 1);
    assert.deepEqual(runtime.getCapacity(), {
      maxConcurrentTasks: 1,
      runningTasks: 0,
      queuedTasks: 0,
    });
    await dependencies.assertCompleted?.({
      database,
      delivery,
      ports,
      result,
      rootDir,
      runtime,
    });

    return {
      schemaVersion: '1.0',
      status: 'passed',
      scope: 'non-production',
      database: mongoEnvironment.mode,
      runtimeTransport: 'loopback-http',
      ...dependencies.report,
      deliveryStatus: delivery.status,
      usageEvents: ports.transactions.size / 2,
      generatedFiles: ports.files.size,
      replayProducedDuplicates: false,
      runtimeCapacity: runtime.getCapacity(),
    };
  } finally {
    await reconciler?.stop().catch(() => {});
    await closeServer(runtimeServer).catch(() => {});
    await runtime?.stop().catch(() => {});
    await dependencies?.stop?.().catch(() => {});
    try {
      await mongo.db(databaseName).dropDatabase();
    } catch {}
    await mongo.close().catch(() => {});
    await mongoEnvironment.stop().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runPhase3DAcceptance()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
