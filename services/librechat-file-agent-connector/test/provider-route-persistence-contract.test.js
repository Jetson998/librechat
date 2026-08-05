import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeLibreChatPorts } from '../src/native-ports.js';
import { MongoBillingSnapshotStore } from '../src/mongo-billing-snapshot-store.js';
import { MemoryActiveTaskStore } from '../src/active-task-store.js';
import { MemoryDeliveryStore } from '../src/delivery-store.js';
import { UsageIngestion } from '../src/usage-ingestion.js';

const PROVIDER_IDENTITY = {
  providerRouteRef: 'custom:Muskapis-openai',
  providerEndpoint: 'Muskapis-openai',
  providerModel: 'gpt-5.6-sol',
  providerProtocol: 'openai-compatible',
};

const BASE_DELIVERY = {
  taskContractVersion: 'office-file-agent.v1.2',
  user: 'user-1',
  conversationId: 'conversation-1',
  userMessageId: 'message-1',
  assistantMessageId: 'assistant-1',
  streamId: 'stream-1',
  billingSnapshotRef: 'snapshot-1',
  modelRouteId: 'file-agent-primary',
  ...PROVIDER_IDENTITY,
};

class FakeMongoCollection {
  constructor() {
    this.document = null;
  }

  async createIndex() {}

  async insertOne(document) {
    this.document = structuredClone(document);
  }

  async findOne() {
    return this.document ? structuredClone(this.document) : null;
  }
}

function usage(overrides = {}) {
  return {
    usageEventId: 'usage-1',
    modelRouteId: 'file-agent-primary',
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
    ...PROVIDER_IDENTITY,
    ...overrides,
  };
}

test('billing snapshot, delivery, and active task preserve one provider route identity', async () => {
  const collection = new FakeMongoCollection();
  const snapshotStore = new MongoBillingSnapshotStore({ collection });
  await snapshotStore.init();
  const snapshot = await snapshotStore.create({
    user: 'user-1',
    modelRouteId: 'file-agent-primary',
    endpoint: 'Muskapis-openai',
    model: 'gpt-5.6-sol',
    ...PROVIDER_IDENTITY,
    prices: { prompt: 1, completion: 2, cacheRead: 0, cacheWrite: 0 },
    pricing: { source: 'test' },
    messageIdentity: {
      sender: 'gpt-5.6-sol',
      endpoint: 'Muskapis-openai',
      model: 'gpt-5.6-sol',
    },
  });
  assert.deepEqual(
    Object.fromEntries(Object.keys(PROVIDER_IDENTITY).map((field) => [field, snapshot[field]])),
    PROVIDER_IDENTITY,
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /apiKey|https:\/\//u);

  const deliveryStore = new MemoryDeliveryStore();
  const created = await deliveryStore.createOrGet({
    idempotencyKey: 'idempotency-1',
    manifest: { model: PROVIDER_IDENTITY },
    record: BASE_DELIVERY,
  });
  const delivery = await deliveryStore.get(created.delivery.deliveryId);
  assert.deepEqual(
    Object.fromEntries(Object.keys(PROVIDER_IDENTITY).map((field) => [field, delivery[field]])),
    PROVIDER_IDENTITY,
  );

  const activeTasks = new MemoryActiveTaskStore();
  const active = await activeTasks.create({
    taskId: 'task-1',
    user: 'user-1',
    conversationId: 'conversation-1',
    taskContractVersion: 'office-file-agent.v1.2',
    capabilityProfile: 'xlsx-edit-v1',
    billingSnapshotRef: 'snapshot-1',
    modelRouteId: 'file-agent-primary',
    ...PROVIDER_IDENTITY,
  });
  assert.deepEqual(
    Object.fromEntries(Object.keys(PROVIDER_IDENTITY).map((field) => [field, active.activeTask[field]])),
    PROVIDER_IDENTITY,
  );
});

test('usage identity mismatch is rejected before a transaction is written', async () => {
  const deliveryStore = new MemoryDeliveryStore();
  const created = await deliveryStore.createOrGet({
    idempotencyKey: 'idempotency-usage',
    manifest: { model: PROVIDER_IDENTITY },
    record: BASE_DELIVERY,
  });
  let writes = 0;
  const ingestion = new UsageIngestion({
    store: deliveryStore,
    ports: {
      writeUsageTransactions: async () => {
        writes += 1;
      },
    },
  });

  await assert.rejects(
    ingestion.ingest(created.delivery.deliveryId, usage({ providerModel: 'other-model' })),
    /providerModel does not match/u,
  );
  assert.equal(writes, 0);

  await ingestion.ingest(created.delivery.deliveryId, usage());
  assert.equal(writes, 1);
});

test('billing snapshot identity mismatch is rejected before token preparation', async () => {
  const ports = new NativeLibreChatPorts({
    billingSnapshotStore: {
      get: async () => ({
        snapshotId: 'snapshot-1',
        modelRouteId: 'file-agent-primary',
        model: 'gpt-5.6-sol',
        prices: { prompt: 1, completion: 2, cacheRead: 0, cacheWrite: 0 },
        balance: { enabled: true },
        transactions: { enabled: true },
        ...PROVIDER_IDENTITY,
        providerModel: 'different-model',
      }),
    },
    prepareStructuredTokenSpend: () => [],
    bulkWriteTransactions: async () => {},
    findExistingTransactionIds: async () => [],
    transactionDbOps: {},
    processCodeOutput: async () => ({ file: { file_id: 'file-1' } }),
    saveMessage: async () => {},
    generationJobManager: { emitDone: async () => {}, completeJob: async () => {} },
    resolveRequest: async () => ({}),
    buildMessage: () => ({}),
    buildFinalEvent: () => ({}),
  });

  await assert.rejects(
    ports.writeUsageTransactions({
      usageEventId: 'usage-1',
      usage: usage(),
      delivery: BASE_DELIVERY,
    }),
    /providerModel does not match delivery/u,
  );
});
