import assert from 'node:assert/strict';
import test from 'node:test';

import { DOCX_MIME } from '../src/constants.js';
import {
  createProductionWordPreflight,
  startProductionLibreChatHostIntegration,
} from '../src/production-host-integration.js';

const SECRET = '12345678901234567890123456789012';

function context(overrides = {}) {
  return {
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    assistantMessageId: 'message-1_',
    streamId: 'conversation-1',
    text: '将“甲”替换为“乙”，并交付 DOCX',
    req: { body: { files: [{ file_id: 'file-1' }] } },
    client: {
      options: {
        attachments: [{
          file_id: 'file-1',
          filename: 'source.docx',
          type: DOCX_MIME,
        }],
      },
    },
    ...overrides,
  };
}

class FakeCollection {
  constructor() {
    this.indexes = [];
    this.documents = [];
  }

  async createIndex(keys, options = {}) {
    this.indexes.push({ keys, options });
  }

  async insertOne(document) {
    this.documents.push(structuredClone(document));
  }

  async findOne() {
    return null;
  }

  find() {
    return { toArray: async () => [] };
  }
}

function nativeHarness() {
  return {
    readStorageStream: async () => Buffer.from('docx'),
    persistFileMetadata: async () => {},
    getBalanceConfig: () => ({ enabled: false }),
    getTransactionsConfig: () => ({ enabled: true }),
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
    prepareStructuredTokenSpend: () => [],
    bulkWriteTransactions: async () => {},
    transactionDbOps: {},
    processCodeOutput: async () => ({ file: { file_id: 'output-1' } }),
    saveMessage: async (_request, message) => message,
    generationJobManager: {
      emitDone: async () => {},
      completeJob: async () => {},
    },
    resolveRequest: async () => ({ user: { id: 'user-1' }, config: {} }),
    getFilesByIds: async () => [],
    sanitizeFileForTransmit: (file) => file,
    resolveMessageIdentity: () => ({ sender: 'Agent', endpoint: 'agents', model: 'model' }),
    loadConversation: async () => null,
    loadMessage: async () => null,
    sanitizeMessageForTransmit: (message) => message,
  };
}

test('production Word preflight leaves unallowlisted, normal, unsupported, and malformed turns native', async () => {
  const preflight = createProductionWordPreflight({ allowlistedUserIds: new Set(['user-1']) });

  assert.deepEqual(await preflight(context({ userId: 'other-user' })), {
    route: 'native',
    reason: 'user_not_allowlisted',
  });
  assert.deepEqual(await preflight(context({ text: '你好' })), {
    route: 'native',
    reason: 'not_complex_file_intent',
  });
  assert.deepEqual(await preflight(context({
    client: { options: { attachments: [{ file_id: 'file-1', filename: 'sheet.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] } },
  })), {
    route: 'native',
    reason: 'word_input_contract_unsupported',
  });
  assert.deepEqual(await preflight(context({ userMessageId: '' })), {
    route: 'native',
    reason: 'current_turn_identity_unavailable',
  });
  assert.equal(await preflight(context()), null);
});

test('host installation puts the bridge on app.locals and an unallowlisted turn performs no Runtime discovery', async () => {
  const collections = new Map();
  const app = { locals: {} };
  let discoveries = 0;
  const runtimeClient = {
    discoverCapabilities: async () => {
      discoveries += 1;
      return {};
    },
  };
  const config = {
    enabled: true,
    runtimeBaseUrl: 'http://file-agent-runtime:8790',
    modelRouteId: 'file-agent-primary',
    serviceScopeSecret: SECRET,
    allowlistedUserIds: new Set(['user-1']),
    reconcileIntervalMs: 1000,
    serviceScopeTtlSeconds: 60,
  };
  const host = await startProductionLibreChatHostIntegration({
    app,
    config,
    database: {
      collection: (name) => {
        if (!collections.has(name)) {
          collections.set(name, new FakeCollection());
        }
        return collections.get(name);
      },
    },
    native: nativeHarness(),
    runtimeClient,
  });

  assert.equal(host.enabled, true);
  assert.equal(typeof app.locals.fileAgentRuntimeBridge?.tryRoute, 'function');
  const result = await app.locals.fileAgentRuntimeBridge.tryRoute(context({ userId: 'other-user' }));
  assert.deepEqual(result.decision, { route: 'native', reason: 'user_not_allowlisted' });
  assert.equal(discoveries, 0);
  await host.stop();
  assert.equal(app.locals.fileAgentRuntimeBridge, undefined);
});
