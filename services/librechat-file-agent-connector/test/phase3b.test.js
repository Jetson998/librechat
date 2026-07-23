import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RUNTIME_CAPABILITIES,
  createRuntimeHttpServer,
  handleRuntimeFetch,
} from '../../file-agent-runtime/src/http-server.js';
import { ArtifactDelivery } from '../src/artifact-delivery.js';
import {
  LibreChatFileAgentConnector,
  MemoryDeliveryStore,
  MongoBillingSnapshotStore,
  MongoDeliveryStore,
  NativeLibreChatPorts,
  RuntimeClient,
  ServiceScopeSigner,
  createLibreChatFinalEventBuilder,
  createLibreChatHostIntegration,
  createLibreChatMessageBuilder,
  createMongoTransactionIdFinder,
  createRuntimeAuthorizer,
  stableTransactionId,
} from '../src/index.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function clone(value) {
  return structuredClone(value);
}

function matchesCondition(value, condition) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return value === condition;
  }
  if ('$nin' in condition && condition.$nin.includes(value)) {
    return false;
  }
  if ('$in' in condition && !condition.$in.includes(value)) {
    return false;
  }
  if ('$lte' in condition && !(value <= condition.$lte)) {
    return false;
  }
  return true;
}

function matches(document, filter) {
  if (filter.$or && !filter.$or.some((entry) => matches(document, entry))) {
    return false;
  }
  return Object.entries(filter)
    .filter(([key]) => key !== '$or')
    .every(([key, condition]) => matchesCondition(document[key], condition));
}

class FakeMongoCollection {
  constructor() {
    this.documents = [];
    this.indexes = [];
    this.forceVersionConflictOnce = false;
  }

  async createIndex(keys, options = {}) {
    this.indexes.push({ keys: clone(keys), options: clone(options) });
    return Object.keys(keys).join('_');
  }

  async insertOne(document) {
    for (const index of this.indexes.filter((entry) => entry.options.unique)) {
      const duplicate = this.documents.find((existing) =>
        Object.keys(index.keys).every((key) => existing[key] === document[key]));
      if (duplicate) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
    }
    this.documents.push(clone(document));
    return { insertedId: document._id };
  }

  async findOne(filter) {
    const document = this.documents.find((entry) => matches(entry, filter));
    return document ? clone(document) : null;
  }

  async findOneAndUpdate(filter, update) {
    const index = this.documents.findIndex((entry) => matches(entry, filter));
    if (index < 0) {
      return null;
    }
    if (this.forceVersionConflictOnce && Object.hasOwn(filter, 'version')) {
      this.forceVersionConflictOnce = false;
      this.documents[index].version += 1;
      this.documents[index].externalMutation = true;
      return null;
    }
    this.documents[index] = { ...this.documents[index], ...clone(update.$set ?? {}) };
    for (const [key, amount] of Object.entries(update.$inc ?? {})) {
      this.documents[index][key] = (this.documents[index][key] ?? 0) + amount;
    }
    return clone(this.documents[index]);
  }

  find(filter) {
    let direction = 1;
    return {
      sort: (spec) => {
        direction = spec.createdAt ?? 1;
      },
      toArray: async () => this.documents
        .filter((entry) => matches(entry, filter))
        .sort((left, right) => direction * left.createdAt.localeCompare(right.createdAt))
        .map(clone),
    };
  }
}

function deliveryRecord(overrides = {}) {
  return {
    taskContractVersion: 'office-file-agent.v1',
    user: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-1',
    assistantMessageId: 'assistant-message-1',
    streamId: 'stream-1',
    billingSnapshotRef: 'snapshot-1',
    modelRouteId: 'file-agent-primary',
    allowedOutputMimeTypes: [XLSX_MIME],
    maxVisibleArtifacts: 3,
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    taskContractVersion: 'office-file-agent.v1',
    taskType: 'office_transform',
    source: { files: [{ fileRef: 'file-1' }] },
    ...overrides,
  };
}

async function createMemoryDelivery(store, overrides = {}) {
  return store.createOrGet({
    idempotencyKey: overrides.idempotencyKey ?? 'idempotency-1',
    manifest: overrides.manifest ?? manifest(),
    record: deliveryRecord(overrides.record),
  });
}

function nativeHarness({ snapshot, processCodeOutput } = {}) {
  const transactions = new Map();
  const transactionBatchSizes = [];
  const messages = new Map();
  const operations = [];
  let preparedArgs = null;
  let finalizeCalls = 0;
  const billingSnapshot = snapshot ?? {
    snapshotId: 'snapshot-1',
    modelRouteId: 'file-agent-primary',
    endpoint: 'custom',
    model: 'gpt-5.6-sol',
    pricing: { source: 'native-pricing' },
    endpointTokenConfig: { prompt: 0.6, completion: 3.6, cacheRead: 0.06, cacheWrite: 0.75 },
    balance: { enabled: true },
    transactions: { enabled: true },
  };
  const ports = new NativeLibreChatPorts({
    billingSnapshotStore: {
      get: async (snapshotId) => snapshotId === billingSnapshot.snapshotId
        ? clone(billingSnapshot)
        : null,
    },
    prepareStructuredTokenSpend: (txData, tokenUsage, pricing) => {
      preparedArgs = { txData: clone(txData), tokenUsage: clone(tokenUsage), pricing: clone(pricing) };
      return [
        { doc: { tokenType: 'prompt' }, tokenValue: -1, balance: txData.balance },
        { doc: { tokenType: 'completion' }, tokenValue: -2, balance: txData.balance },
      ];
    },
    findExistingTransactionIds: async ({ ids }) => ids.filter((id) => transactions.has(id)),
    bulkWriteTransactions: async ({ docs }) => {
      operations.push('transactions');
      transactionBatchSizes.push(docs.length);
      for (const entry of docs) {
        transactions.set(entry.doc._id, clone(entry.doc));
      }
    },
    transactionDbOps: { name: 'native-db-ops' },
    processCodeOutput: processCodeOutput ?? (async ({ id }) => ({
      file: { file_id: `librechat-${id}` },
      finalize: async () => {
        finalizeCalls += 1;
      },
    })),
    saveMessage: async (_reqCtx, message) => {
      operations.push('message');
      messages.set(message.messageId, clone(message));
      return clone(message);
    },
    generationJobManager: {
      emitDone: async (_streamId, event) => {
        operations.push('final');
        assert.equal(event.final, true);
      },
      completeJob: async () => {
        operations.push('job');
      },
    },
    resolveRequest: async ({ delivery }) => ({ user: { id: delivery.user } }),
    buildRequestContext: ({ delivery }) => ({ userId: delivery.user }),
    buildMessage: ({ delivery, text, fileIds, status, billingSnapshot: current }) => ({
      messageId: delivery.assistantMessageId,
      conversationId: delivery.conversationId,
      parentMessageId: delivery.userMessageId,
      isCreatedByUser: false,
      text,
      files: fileIds.map((fileId) => ({ file_id: fileId })),
      endpoint: current.endpoint,
      model: current.model,
      ...(status ? { status } : {}),
    }),
    buildFinalEvent: async ({ getResponseMessage }) => ({
      final: true,
      responseMessage: await getResponseMessage(),
    }),
  });
  return {
    ports,
    transactions,
    transactionBatchSizes,
    messages,
    operations,
    getPreparedArgs: () => preparedArgs,
    getFinalizeCalls: () => finalizeCalls,
  };
}

test('Mongo delivery store enforces both idempotency and message-contract uniqueness', async () => {
  const collection = new FakeMongoCollection();
  const store = new MongoDeliveryStore({ collection });
  await store.init();
  assert.ok(collection.indexes.some((entry) => entry.keys['retry.nextAt'] === 1));

  const first = await createMemoryDelivery(store);
  const replay = await createMemoryDelivery(store);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(first.delivery.deliveryId, replay.delivery.deliveryId);
  assert.equal(collection.documents.length, 1);

  await assert.rejects(
    createMemoryDelivery(store, {
      idempotencyKey: 'different-idempotency',
      manifest: manifest({ source: { files: [{ fileRef: 'different-file' }] } }),
    }),
    /idempotency key was already used/,
  );
  assert.equal(collection.documents.length, 1);
});

test('Mongo delivery mutation retries optimistic conflicts and preserves the concurrent version', async () => {
  const collection = new FakeMongoCollection();
  const store = new MongoDeliveryStore({ collection });
  await store.init();
  const created = await createMemoryDelivery(store);
  collection.forceVersionConflictOnce = true;

  const updated = await store.mutate(created.delivery.deliveryId, (draft) => {
    draft.status = 'running';
  });
  assert.equal(updated.status, 'running');
  assert.equal(updated.externalMutation, true);
  assert.equal(updated.version, 3);
});

test('Mongo delivery lease excludes another owner and allows takeover after expiry', async () => {
  const collection = new FakeMongoCollection();
  const store = new MongoDeliveryStore({ collection });
  await store.init();
  const created = await createMemoryDelivery(store);

  const first = await store.acquireLease(created.delivery.deliveryId, {
    owner: 'worker-1',
    ttlMs: 1_000,
    now: 10_000,
  });
  const blocked = await store.acquireLease(created.delivery.deliveryId, {
    owner: 'worker-2',
    ttlMs: 1_000,
    now: 10_500,
  });
  const takeover = await store.acquireLease(created.delivery.deliveryId, {
    owner: 'worker-2',
    ttlMs: 1_000,
    now: 11_001,
  });
  assert.equal(first.leaseOwner, 'worker-1');
  assert.equal(blocked, null);
  assert.equal(takeover.leaseOwner, 'worker-2');
});

test('Mongo billing snapshots are immutable copies and reject nested credentials', async () => {
  const collection = new FakeMongoCollection();
  const store = new MongoBillingSnapshotStore({ collection });
  await store.init();
  const created = await store.create({
    user: 'user-1',
    modelRouteId: 'file-agent-primary',
    endpoint: 'custom',
    model: 'gpt-5.6-sol',
    prices: { prompt: 0.6, completion: 3.6, cacheRead: 0.06, cacheWrite: 0.75 },
    pricing: { source: 'native' },
    balance: { enabled: true },
    transactions: { enabled: true },
  });
  created.prices.prompt = 999;
  const loaded = await store.get(created.snapshotId);
  assert.equal(loaded.prices.prompt, 0.6);
  assert.deepEqual(loaded.transactions, { enabled: true });

  await assert.rejects(
    store.create({
      user: 'user-1',
      modelRouteId: 'file-agent-primary',
      endpoint: 'custom',
      model: 'gpt-5.6-sol',
      prices: {},
      pricing: { nested: { apiKey: 'must-not-persist' } },
    }),
    /forbidden field/,
  );
});

test('native usage replay preserves structured token granularity and does not rebill', async () => {
  const harness = nativeHarness();
  const delivery = deliveryRecord();
  const usage = {
    inputTokens: 2_010,
    cacheReadTokens: 166_400,
    cacheWriteTokens: 120,
    outputTokens: 1_459,
  };
  await harness.ports.writeUsageTransactions({ usageEventId: 'usage-1', usage, delivery });
  await harness.ports.writeUsageTransactions({ usageEventId: 'usage-1', usage, delivery });

  assert.equal(harness.transactions.size, 2);
  assert.equal(harness.operations.filter((entry) => entry === 'transactions').length, 1);
  assert.deepEqual(harness.transactionBatchSizes, [2]);
  assert.ok(harness.transactions.has(stableTransactionId('usage-1', 'prompt')));
  assert.ok(harness.transactions.has(stableTransactionId('usage-1', 'completion')));
  assert.deepEqual(harness.getPreparedArgs().tokenUsage, {
    promptTokens: { input: 2_010, write: 120, read: 166_400 },
    completionTokens: 1_459,
  });
  assert.equal(harness.getPreparedArgs().txData.endpointTokenConfig.cacheRead, 0.06);
  assert.deepEqual(harness.getPreparedArgs().pricing, { source: 'native-pricing' });

  harness.transactions.delete(stableTransactionId('usage-1', 'completion'));
  await harness.ports.writeUsageTransactions({ usageEventId: 'usage-1', usage, delivery });
  assert.equal(harness.transactions.size, 2);
  assert.deepEqual(harness.transactionBatchSizes, [2, 1]);
});

test('native artifact replay produces one LibreChat file receipt and awaits preview finalization', async () => {
  let processCalls = 0;
  let finalizeCalls = 0;
  const harness = nativeHarness({
    processCodeOutput: async ({ id, messageId, toolCallId }) => {
      processCalls += 1;
      assert.equal(messageId, 'assistant-message-1');
      assert.equal(toolCallId, 'file-agent:artifact-1');
      return {
        file: { file_id: `librechat-${id}` },
        finalize: async () => {
          finalizeCalls += 1;
        },
      };
    },
  });
  const store = new MemoryDeliveryStore();
  const created = await createMemoryDelivery(store);
  const delivery = new ArtifactDelivery({ store, ports: harness.ports });
  const artifact = {
    name: 'result.xlsx',
    mimeType: XLSX_MIME,
    size: 2_048,
    codeEnvRef: { storage_session_id: 'session-1', file_id: 'artifact-1' },
  };

  await delivery.deliver(created.delivery.deliveryId, artifact, { verification: { passed: true } });
  await delivery.deliver(created.delivery.deliveryId, artifact, { verification: { passed: true } });
  assert.equal(processCalls, 1);
  assert.equal(finalizeCalls, 1);
  assert.equal(
    (await store.get(created.delivery.deliveryId)).artifactReceipts['artifact-1'].fileId,
    'librechat-artifact-1',
  );
  assert.equal(
    (await store.get(created.delivery.deliveryId)).artifactReceipts['artifact-1'].toolCallId,
    'file-agent:artifact-1',
  );
});

test('native message, final event, and generation job use the same preallocated message in order', async () => {
  const harness = nativeHarness();
  const delivery = deliveryRecord();
  const text = '已完成文件处理并生成 result.xlsx，文件已附在本条回复中，可直接下载。';
  await harness.ports.saveAssistantMessage({ delivery, text, fileIds: ['file-1'] });
  await harness.ports.emitDone({
    delivery,
    payload: {
      messageId: delivery.assistantMessageId,
      conversationId: delivery.conversationId,
      text,
      fileIds: ['file-1'],
    },
  });
  await harness.ports.completeJob({ delivery });
  assert.deepEqual(harness.operations, ['message', 'final', 'job']);
  assert.equal(harness.messages.get('assistant-message-1').text, text);
});

test('reconcileAll skips a delivery leased by another API replica', async () => {
  const collection = new FakeMongoCollection();
  const store = new MongoDeliveryStore({ collection });
  await store.init();
  const created = await createMemoryDelivery(store);
  await store.acquireLease(created.delivery.deliveryId, {
    owner: 'other-worker',
    ttlMs: 60_000,
  });
  let runtimeCalls = 0;
  const connector = new LibreChatFileAgentConnector({
    store,
    runtimeClient: {
      submit: async () => {
        runtimeCalls += 1;
        return { task: { taskId: 'not-expected' } };
      },
    },
    ports: {},
    reconcilerId: 'this-worker',
  });
  const results = await connector.reconcileAll();
  assert.equal(runtimeCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].deliveryId, created.delivery.deliveryId);
});

test('signed Runtime requests are accepted and missing, tampered, or expired scopes return 401', async () => {
  const secret = 'phase3b-service-scope-secret-0123456789';
  const signer = new ServiceScopeSigner({ secret, ttlSeconds: 60 });
  const authorizeRequest = createRuntimeAuthorizer(signer);
  const runtime = {};
  const fetchImpl = (url, init) => handleRuntimeFetch(
    runtime,
    new Request(url, init),
    { capabilities: DEFAULT_RUNTIME_CAPABILITIES, authorizeRequest },
  );
  const client = new RuntimeClient({
    baseUrl: 'http://runtime.phase3b',
    fetchImpl,
    scopeSigner: signer,
  });
  const capabilities = await client.discoverCapabilities();
  assert.equal(capabilities.schemaVersion, '1.0');

  const missing = await handleRuntimeFetch(
    runtime,
    new Request('http://runtime.phase3b/v1/capabilities'),
    { authorizeRequest },
  );
  assert.equal(missing.status, 401);

  const wrongPathToken = signer.sign({ method: 'GET', pathname: '/v1/tasks/not-this-path' });
  const tampered = await handleRuntimeFetch(
    runtime,
    new Request('http://runtime.phase3b/v1/capabilities', {
      headers: { authorization: `Bearer ${wrongPathToken}` },
    }),
    { authorizeRequest },
  );
  assert.equal(tampered.status, 401);

  const expiredToken = signer.sign({
    method: 'GET',
    pathname: '/v1/capabilities',
    now: Date.now() - 120_000,
  });
  const expired = await handleRuntimeFetch(
    runtime,
    new Request('http://runtime.phase3b/v1/capabilities', {
      headers: { authorization: `Bearer ${expiredToken}` },
    }),
    { authorizeRequest },
  );
  assert.equal(expired.status, 401);

  const body = JSON.stringify({ taskContractVersion: 'office-file-agent.v1' });
  const scopedSubmit = signer.sign({
    method: 'POST',
    pathname: '/v1/tasks',
    body,
    headers: { 'idempotency-key': 'original-key' },
  });
  const changedIdempotencyKey = await handleRuntimeFetch(
    runtime,
    new Request('http://runtime.phase3b/v1/tasks', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${scopedSubmit}`,
        'content-type': 'application/json',
        'idempotency-key': 'changed-key',
      },
      body,
    }),
    { authorizeRequest },
  );
  assert.equal(changedIdempotencyKey.status, 401);
});

test('the concrete Runtime HTTP server forwards its service authorizer', async (t) => {
  const signer = new ServiceScopeSigner({
    secret: 'phase3b-concrete-server-secret-0123456789',
  });
  const server = createRuntimeHttpServer({}, {
    capabilities: DEFAULT_RUNTIME_CAPABILITIES,
    authorizeRequest: createRuntimeAuthorizer(signer),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new RuntimeClient({ baseUrl, scopeSigner: signer });
  assert.equal((await client.discoverCapabilities()).schemaVersion, '1.0');
  assert.equal((await fetch(`${baseUrl}/v1/capabilities`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
});

test('host message builder rehydrates owned generated files in Runtime artifact order', async () => {
  const requested = [];
  const builder = createLibreChatMessageBuilder({
    getFilesByIds: async (query) => {
      requested.push(clone(query));
      return [
        {
          file_id: 'file-2',
          filename: 'second.xlsx',
          user: 'user-1',
          tenantId: 'tenant-1',
          conversationId: 'conversation-1',
          internal: true,
        },
        {
          file_id: 'file-1',
          filename: 'first.xlsx',
          user: 'user-1',
          tenantId: 'tenant-1',
          conversationId: 'conversation-1',
          internal: true,
        },
      ];
    },
    sanitizeFileForTransmit: (file) => ({ file_id: file.file_id, filename: file.filename }),
    resolveMessageIdentity: ({ billingSnapshot }) => ({
      sender: 'GPT-5.6-Sol',
      endpoint: billingSnapshot.endpoint,
      model: 'gpt-5.6-sol',
    }),
  });
  const message = await builder({
    kind: 'completed',
    delivery: deliveryRecord({ tenantId: 'tenant-1' }),
    text: '文件已生成。',
    fileIds: ['file-1', 'file-2'],
    artifacts: [
      { fileId: 'file-1', toolCallId: 'file-agent:artifact-1' },
      { fileId: 'file-2', toolCallId: 'file-agent:artifact-2' },
    ],
    billingSnapshot: { endpoint: 'custom' },
  });
  assert.deepEqual(requested, [{
    fileIds: ['file-1', 'file-2'],
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
  }]);
  assert.deepEqual(message.files.map((file) => file.file_id), ['file-1', 'file-2']);
  assert.deepEqual(
    message.attachments.map((file) => file.toolCallId),
    ['file-agent:artifact-1', 'file-agent:artifact-2'],
  );
  assert.equal(message.messageId, 'assistant-message-1');
  assert.equal(message.user, 'user-1');
  assert.equal(message.text, '文件已生成。');
  assert.equal(message.parentMessageId, 'user-message-1');
  assert.equal(message.unfinished, false);
  assert.equal(JSON.stringify(message).includes('internal'), false);
});

test('host message builder refuses missing or unauthorized generated file records', async () => {
  const builder = createLibreChatMessageBuilder({
    getFilesByIds: async () => [],
    sanitizeFileForTransmit: clone,
    resolveMessageIdentity: async () => ({ sender: 'Assistant', endpoint: 'custom', model: 'm' }),
  });
  await assert.rejects(
    builder({
      kind: 'completed',
      delivery: deliveryRecord(),
      text: 'not delivered',
      fileIds: ['missing-file'],
      artifacts: [],
      billingSnapshot: {},
    }),
    /not found or not owned/,
  );

  const foreignBuilder = createLibreChatMessageBuilder({
    getFilesByIds: async () => [{
      file_id: 'foreign-file',
      user: 'other-user',
      conversationId: 'conversation-1',
    }],
    sanitizeFileForTransmit: clone,
    resolveMessageIdentity: async () => ({ sender: 'Assistant', endpoint: 'custom', model: 'm' }),
  });
  await assert.rejects(
    foreignBuilder({
      kind: 'completed',
      delivery: deliveryRecord(),
      text: 'not delivered',
      fileIds: ['foreign-file'],
      artifacts: [],
      billingSnapshot: {},
    }),
    /not found or not owned/,
  );

  for (const file of [
    {
      file_id: 'wrong-tenant',
      user: 'user-1',
      tenantId: 'other-tenant',
      conversationId: 'conversation-1',
    },
    {
      file_id: 'wrong-conversation',
      user: 'user-1',
      tenantId: 'tenant-1',
      conversationId: 'other-conversation',
    },
  ]) {
    const scopedBuilder = createLibreChatMessageBuilder({
      getFilesByIds: async () => [file],
      sanitizeFileForTransmit: clone,
      resolveMessageIdentity: async () => ({
        sender: 'Assistant',
        endpoint: 'custom',
        model: 'm',
      }),
    });
    await assert.rejects(
      scopedBuilder({
        kind: 'completed',
        delivery: deliveryRecord({ tenantId: 'tenant-1' }),
        text: 'not delivered',
        fileIds: [file.file_id],
        artifacts: [],
        billingSnapshot: {},
      }),
      /not found or not owned/,
    );
  }

  const unsafeIdentityBuilder = createLibreChatMessageBuilder({
    getFilesByIds: async () => [],
    sanitizeFileForTransmit: clone,
    resolveMessageIdentity: async () => ({
      sender: 'Assistant',
      endpoint: 'custom',
      model: 'm',
      messageId: 'must-not-override',
    }),
  });
  await assert.rejects(
    unsafeIdentityBuilder({
      kind: 'completed',
      delivery: deliveryRecord(),
      text: 'not delivered',
      fileIds: [],
      artifacts: [],
      billingSnapshot: {},
    }),
    /unsupported field: messageId/,
  );
});

test('host final-event builder loads authoritative conversation, user, and assistant messages', async () => {
  const builder = createLibreChatFinalEventBuilder({
    loadConversation: async ({ userId, conversationId }) => ({
      userId,
      conversationId,
      title: '文件任务',
    }),
    loadMessage: async ({ messageId }) => messageId === 'user-message-1'
      ? { messageId, text: '生成文件' }
      : { messageId, text: '权威已保存回复', _id: 'internal-mongo-id' },
    sanitizeMessageForTransmit: (message) => ({
      messageId: message.messageId,
      ...(message.messageId === 'assistant-message-1' ? { text: message.text } : {}),
    }),
  });
  const event = await builder({ delivery: deliveryRecord() });
  assert.equal(event.final, true);
  assert.equal(event.title, '文件任务');
  assert.deepEqual(event.requestMessage, { messageId: 'user-message-1' });
  assert.deepEqual(event.responseMessage, {
    messageId: 'assistant-message-1',
    text: '权威已保存回复',
  });
});

test('Mongo transaction finder scopes stable IDs to the delivery owner', async () => {
  const collection = new FakeMongoCollection();
  collection.documents.push(
    { _id: 'tx-1', user: 'user-1' },
    { _id: 'tx-2', user: 'user-2' },
  );
  const findIds = createMongoTransactionIdFinder(collection);
  assert.deepEqual(
    await findIds({ ids: ['tx-1', 'tx-2'], user: 'user-1' }),
    ['tx-1'],
  );
});

test('host integration composes stores and native dependencies without production access', async () => {
  const collections = {
    deliveries: new FakeMongoCollection(),
    billingSnapshots: new FakeMongoCollection(),
    transactions: new FakeMongoCollection(),
  };
  const integration = createLibreChatHostIntegration({
    collections,
    runtimeClient: { discoverCapabilities: async () => DEFAULT_RUNTIME_CAPABILITIES },
    native: {
      getFilesByIds: async () => [],
      sanitizeFileForTransmit: clone,
      resolveMessageIdentity: async () => ({
        sender: 'Assistant',
        endpoint: 'custom',
        model: 'gpt-5.6-sol',
      }),
      loadConversation: async () => ({ conversationId: 'conversation-1', title: 'Test' }),
      loadMessage: async () => ({ messageId: 'user-message-1' }),
      sanitizeMessageForTransmit: clone,
      prepareStructuredTokenSpend: () => [],
      bulkWriteTransactions: async () => {},
      transactionDbOps: {},
      processCodeOutput: async () => ({ file: { file_id: 'file-1' } }),
      saveMessage: async (_context, message) => message,
      generationJobManager: { emitDone: async () => {}, completeJob: async () => {} },
      resolveRequest: async () => ({ user: { id: 'user-1' } }),
    },
    featureEnabled: true,
    allowlistedUserIds: new Set(['user-1']),
  });
  const initialized = await integration.init();
  assert.equal(initialized, integration);
  assert.ok(collections.deliveries.indexes.some((entry) => entry.options.unique));
  assert.ok(collections.billingSnapshots.indexes.some((entry) => entry.options.unique));
  assert.equal(integration.connector.featureEnabled, true);
});
