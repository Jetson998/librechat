import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));
const { createNativePorts, installFileAgentRuntimeHost } = require(
  path.join(directory, '../production-overlay/api/server/services/FileAgentRuntime.js'),
);

const SECRET = '12345678901234567890123456789012';

function dependencies() {
  const transactions = [];
  return {
    api: {
      getBalanceConfig: () => ({ enabled: false }),
      getTransactionsConfig: () => ({ enabled: true }),
      prepareStructuredTokenSpend: () => [],
      bulkWriteTransactions: async () => {},
      sanitizeFileForTransmit: (file) => file,
      sanitizeMessageForTransmit: (message) => message,
      GenerationJobManager: {
        emitDone: async () => {},
        completeJob: async () => {},
      },
      registerShutdownTask: () => {},
    },
    db: {
      updateFile: async () => {},
      getMultiplier: () => 1,
      getCacheMultiplier: () => null,
      bulkInsertTransactions: async () => {},
      updateBalance: async () => {},
      saveMessage: async () => {},
      getFiles: async () => [],
      getConvo: async () => null,
      getMessage: async () => null,
    },
    FileSources: { local: 'local' },
    getAppConfig: async () => ({ interfaceConfig: {} }),
    getStrategyFunctions: () => ({ getDownloadStream: async () => Buffer.from('docx') }),
    logger: { warn: () => {} },
    mongoose: {
      connection: {
        db: {
          collection: () => ({
            find: () => ({ toArray: async () => transactions }),
          }),
        },
      },
      isValidObjectId: () => true,
      Types: { ObjectId: class ObjectId { constructor(value) { this.value = value; } } },
    },
    processCodeOutput: async () => ({ file: { file_id: 'output-1' } }),
    tenantStorage: { run: async (_scope, callback) => callback() },
  };
}

test('disabled API installer does not load a connector module or native dependencies', async () => {
  let loaded = 0;
  const result = await installFileAgentRuntimeHost({
    app: { locals: {} },
    environment: { FILE_AGENT_RUNTIME_ENABLED: 'false' },
    loadHostModule: async () => {
      loaded += 1;
      throw new Error('must not load');
    },
  });
  assert.equal(result.enabled, false);
  assert.equal(loaded, 0);
});

test('enabled API installer maps current LibreChat ports without exposing configuration secrets', async () => {
  const app = { locals: {} };
  const nativeDependencies = dependencies();
  let received = null;
  const result = await installFileAgentRuntimeHost({
    app,
    appConfig: { interfaceConfig: { placeholder: true } },
    environment: {
      FILE_AGENT_RUNTIME_ENABLED: 'true',
      FILE_AGENT_CONNECTOR_ROOT: '/opt/librechat/file-agent-runtime/connector',
    },
    dependencies: nativeDependencies,
    loadHostModule: async () => ({
      loadProductionHostConfig: async () => ({
        enabled: true,
        runtimeBaseUrl: 'http://file-agent-runtime:8790',
        modelRouteId: 'file-agent-primary',
        serviceScopeSecret: SECRET,
        allowlistedUserIds: new Set(['user-1']),
        reconcileIntervalMs: 1000,
        serviceScopeTtlSeconds: 60,
      }),
      startProductionLibreChatHostIntegration: async (value) => {
        received = value;
        return { enabled: true, stop: async () => {} };
      },
    }),
  });

  assert.equal(result.enabled, true);
  assert.equal(received.database, nativeDependencies.mongoose.connection.db);
  assert.equal(typeof received.native.readStorageStream, 'function');
  assert.equal(typeof received.native.persistFileMetadata, 'function');
  assert.equal(typeof received.native.processCodeOutput, 'function');
  const stream = await received.native.readStorageStream({
    file: { source: 'local', filepath: '/uploads/user-1/input.docx' },
    context: { req: {} },
  });
  assert.deepEqual(stream, Buffer.from('docx'));
  assert.equal(typeof received.native.onReconcileError, 'function');
  assert.equal(Object.hasOwn(received.native, 'serviceScopeSecret'), false);
});

test('native production ports restore tenant scope for delayed Runtime delivery work', async () => {
  const scopes = [];
  const nativeDependencies = dependencies();
  nativeDependencies.tenantStorage = {
    run: async (scope, operation) => {
      scopes.push(scope);
      return operation();
    },
  };
  const { native } = createNativePorts({
    app: { locals: {} },
    appConfig: { interfaceConfig: {} },
    dependencies: nativeDependencies,
  });
  const identity = { id: 'user-1', tenantId: 'tenant-1' };
  const delivery = { user: 'user-1', tenantId: 'tenant-1' };

  await native.readStorageStream({
    file: { source: 'local', filepath: '/uploads/user-1/input.docx' },
    context: { req: { user: identity } },
  });
  await native.persistFileMetadata({
    file: { file_id: 'file-1' },
    metadata: { contentSha256: 'a'.repeat(64) },
    context: { req: { user: identity } },
  });
  await native.bulkWriteTransactions({ user: 'user-1', tenantId: 'tenant-1', docs: [] }, {});
  await native.processCodeOutput({ req: { user: identity } });
  await native.getFilesByIds({
    fileIds: ['file-1'],
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
  });
  await native.findExistingTransactionIds({ ids: ['transaction-1'], user: 'user-1', delivery });
  await native.saveMessage({ userId: 'user-1', tenantId: 'tenant-1' }, {}, {});
  await native.loadConversation({
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
  });
  await native.loadMessage({
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    messageId: 'message-1',
  });

  assert.equal(scopes.length, 9);
  assert.ok(scopes.every((scope) => (
    scope.userId === 'user-1' && scope.tenantId === 'tenant-1'
  )));
});
