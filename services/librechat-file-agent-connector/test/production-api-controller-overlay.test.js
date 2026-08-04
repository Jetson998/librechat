import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const overlayPath = path.join(
  directory,
  '../production-overlay/api/overlay/api/server/controllers/agents/request.js',
);

function response() {
  return {
    headersSent: false,
    jsonPayloads: [],
    json(payload) {
      this.headersSent = true;
      this.jsonPayloads.push(payload);
      return this;
    },
    status() {
      return this;
    },
  };
}

function request() {
  return {
    body: {
      text: '将“甲”替换为“乙”，并交付 DOCX',
      conversationId: 'new',
      messageId: 'message-1',
      parentMessageId: null,
      endpointOption: {
        endpoint: 'agents',
        agent_id: 'file-agent',
        modelLabel: 'File Agent',
        modelOptions: { model: 'file-agent-primary' },
      },
      files: [{ file_id: 'file-1' }],
    },
    config: { interfaceConfig: {} },
    user: { id: 'user-1', tenantId: 'tenant-1' },
  };
}

async function loadOverlay({ bridge }) {
  const source = await readFile(overlayPath, 'utf8');
  const operations = [];
  const savedMessages = [];
  const savedConversations = [];
  const job = {
    createdAt: 'job-created-at',
    abortController: new AbortController(),
    emitter: { on: () => {} },
    readyPromise: Promise.resolve(),
  };
  const generationJobManager = {
    createJob: async () => job,
    updateMetadata: async (...args) => operations.push(['metadata', ...args]),
    setContentParts: (...args) => operations.push(['content-parts', ...args]),
    emitChunk: async (...args) => operations.push(['chunk', ...args]),
    emitDone: async (...args) => operations.push(['done', ...args]),
    emitError: async (...args) => operations.push(['error', ...args]),
    completeJob: (...args) => operations.push(['complete', ...args]),
    getJob: async () => job,
    getResumeState: async () => null,
  };
  const modules = {
    '@librechat/data-schemas': {
      logger: { debug: () => {}, error: () => {}, warn: () => {} },
    },
    'librechat-data-provider': {
      Constants: { NO_PARENT: '00000000-0000-0000-0000-000000000000' },
      ViolationTypes: { CONCURRENT: 'concurrent' },
      isEphemeralAgentId: () => false,
    },
    '@librechat/api': {
      sendEvent: async () => {},
      getViolationInfo: () => ({}),
      buildMessageFiles: () => [],
      getReferencedQuotes: () => null,
      resolveTitleTiming: () => 'final',
      GenerationJobManager: generationJobManager,
      filterPersistableAbortContent: (value) => value,
      decrementPendingRequest: async (userId) => operations.push(['decrement', userId]),
      sanitizeMessageForTransmit: (message) => ({ ...message, sanitized: true }),
      checkAndIncrementPendingRequest: async () => ({ allowed: true, pendingRequests: 1, limit: 2 }),
      isUnpersistedPreliminaryParent: async () => false,
    },
    '~/server/cleanup': {
      disposeClient: () => operations.push(['dispose']),
      clientRegistry: new Map(),
      requestDataMap: new Map(),
    },
    '~/server/services/MCPRequestContext': {
      getMCPRequestContext: () => ({}),
      cleanupMCPRequestContextForReq: async () => operations.push(['cleanup']),
    },
    '~/server/middleware': { handleAbortError: () => false },
    '~/cache': { logViolation: async () => {} },
    '~/models': {
      saveMessage: async (_context, message) => {
        savedMessages.push(structuredClone(message));
        return message;
      },
      saveConvo: async (_context, conversation) => {
        savedConversations.push(structuredClone(conversation));
        return conversation;
      },
      getMessages: async () => [],
      getConvo: async () => null,
      recordDiagnosticEvent: () => operations.push(['diagnostic']),
    },
    './InitializationFailure': {
      persistInitializationFailure: async () => {
        throw new Error('unexpected initialization failure path');
      },
    },
  };
  const module = { exports: {} };
  const sandbox = {
    AbortController,
    clearTimeout,
    console,
    crypto: { randomUUID: () => 'conversation-1' },
    module,
    exports: module.exports,
    require: (name) => {
      if (!Object.hasOwn(modules, name)) {
        throw new Error(`Unexpected overlay dependency: ${name}`);
      }
      return modules[name];
    },
    setTimeout,
  };
  vm.runInNewContext(source, sandbox, { filename: overlayPath });

  const client = {
    contentParts: [],
    options: { agent: { endpoint: 'agents' } },
    sender: 'File Agent',
    sendMessage: async () => {
      operations.push(['native-send']);
      throw new Error('native Agent must not run for a Runtime handoff');
    },
  };
  const initializeClient = async () => ({ client });
  return {
    AgentController: module.exports,
    bridge,
    client,
    initializeClient,
    operations,
    savedConversations,
    savedMessages,
  };
}

test('production API overlay persists one Runtime turn, emits created, and skips native Agent', async () => {
  let persisted = null;
  const harness = await loadOverlay({
    bridge: {
      tryRoute: async ({ persistUserTurn }) => {
        persisted = await persistUserTurn();
        return {
          suppressNativeAgent: true,
          deliveryId: 'delivery-1',
          taskId: 'task-1',
          persisted,
        };
      },
    },
  });
  const req = request();
  const res = response();

  await harness.AgentController(req, res, () => {}, harness.initializeClient, null, harness.bridge);

  assert.equal(harness.savedConversations.length, 1);
  assert.equal(harness.savedMessages.length, 1);
  assert.equal(harness.savedMessages[0].messageId, 'message-1');
  assert.equal(persisted.userMessage.messageId, 'message-1');
  assert.deepEqual(
    harness.operations.filter(([kind]) => kind === 'chunk').map(([, , event]) => event.created),
    [true],
  );
  assert.equal(harness.operations.some(([kind]) => kind === 'native-send'), false);
  assert.equal(harness.operations.filter(([kind]) => kind === 'decrement').length, 1);
  assert.equal(harness.operations.filter(([kind]) => kind === 'dispose').length, 1);
  assert.equal(harness.operations.filter(([kind]) => kind === 'complete').length, 0);
  assert.equal(res.jsonPayloads.length, 1);
  assert.equal(res.jsonPayloads[0].streamId, 'conversation-1');
  assert.equal(res.jsonPayloads[0].conversationId, 'conversation-1');
  assert.equal(res.jsonPayloads[0].status, 'started');
});

test('production API overlay finalizes one error after persisted Runtime handoff without native fallback', async () => {
  const harness = await loadOverlay({
    bridge: {
      tryRoute: async ({ persistUserTurn }) => {
        const persisted = await persistUserTurn();
        const error = new Error('Runtime submit failed');
        error.userTurnPersisted = true;
        error.persisted = persisted;
        throw error;
      },
    },
  });
  const req = request();
  const res = response();

  await harness.AgentController(req, res, () => {}, harness.initializeClient, null, harness.bridge);

  assert.equal(harness.savedConversations.length, 1);
  assert.equal(harness.savedMessages.length, 2);
  assert.equal(harness.savedMessages[0].messageId, 'message-1');
  assert.equal(harness.savedMessages[1].messageId, 'message-1_');
  assert.equal(harness.savedMessages[1].error, true);
  assert.equal(harness.operations.some(([kind]) => kind === 'native-send'), false);
  assert.equal(harness.operations.filter(([kind]) => kind === 'done').length, 1);
  assert.equal(harness.operations.filter(([kind]) => kind === 'complete').length, 1);
  assert.equal(harness.operations.filter(([kind]) => kind === 'decrement').length, 1);
  assert.equal(harness.operations.filter(([kind]) => kind === 'dispose').length, 1);
  assert.equal(harness.operations.filter(([kind]) => kind === 'diagnostic').length, 1);
  assert.equal(res.jsonPayloads.length, 1);
});
