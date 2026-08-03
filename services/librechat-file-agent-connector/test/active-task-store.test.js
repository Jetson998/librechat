import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActiveTaskSequenceGapError,
  MemoryActiveTaskStore,
  MongoActiveTaskStore,
} from '../src/active-task-store.js';

function matches(value, condition) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return value === condition;
  }
  if ('$nin' in condition && condition.$nin.includes(value)) {
    return false;
  }
  return true;
}

class FakeCollection {
  constructor() {
    this.documents = [];
    this.indexes = [];
  }

  async createIndex(keys, options = {}) {
    this.indexes.push({ keys, options });
  }

  async insertOne(document) {
    for (const index of this.indexes.filter((entry) => entry.options.unique)) {
      if (this.documents.some((existing) =>
        Object.keys(index.keys).every((key) => existing[key] === document[key]))) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
    }
    this.documents.push(structuredClone(document));
  }

  async findOne(filter) {
    const document = this.documents.find((entry) =>
      Object.entries(filter).every(([key, condition]) => matches(entry[key], condition)));
    return document ? structuredClone(document) : null;
  }

  async findOneAndUpdate(filter, update) {
    const index = this.documents.findIndex((entry) =>
      Object.entries(filter).every(([key, condition]) => matches(entry[key], condition)));
    if (index < 0) {
      return null;
    }
    this.documents[index] = {
      ...this.documents[index],
      ...structuredClone(update.$set ?? {}),
    };
    return structuredClone(this.documents[index]);
  }

  find(filter) {
    return {
      sort: () => {},
      toArray: async () => this.documents
        .filter((entry) => Object.entries(filter).every(([key, condition]) =>
          matches(entry[key], condition)))
        .map((entry) => structuredClone(entry)),
    };
  }
}

function task(overrides = {}) {
  return {
    taskId: 'task-1',
    user: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    taskContractVersion: 'office-file-agent.v1.1',
    capabilityProfile: 'word-edit-v1',
    billingSnapshotRef: 'billing-1',
    modelRouteId: 'file-agent-primary',
    workspaceRef: 'workspace-hash-1',
    ...overrides,
  };
}

function turn(deliveryId, index = 1) {
  return {
    deliveryId,
    userMessageId: `user-message-${index}`,
    assistantMessageId: `assistant-message-${index}`,
    streamId: `stream-${index}`,
    turnType: index === 1 ? 'submit' : 'steer',
  };
}

test('active task store binds multiple turns and keeps task-level receipts', async () => {
  const store = new MemoryActiveTaskStore();
  const created = await store.create({ ...task(), turn: turn('delivery-1') });
  const attached = await store.attachTurn({
    taskId: 'task-1',
    scope: task(),
    turn: turn('delivery-2', 2),
  });
  assert.equal(attached.currentTurnDeliveryId, 'delivery-2');
  await store.markUsageReceipt('task-1', 'usage-1');
  await store.markArtifactReceipt('task-1', 'artifact-1', {
    status: 'completed',
    fileId: 'file-1',
  });
  const current = await store.getByTaskId('task-1');
  assert.equal(created.activeTask.taskId, 'task-1');
  assert.deepEqual(current.turnDeliveryIds, ['delivery-1', 'delivery-2']);
  assert.equal(current.usageReceipts['usage-1'], 'completed');
  assert.equal(current.artifactReceipts['artifact-1'].fileId, 'file-1');
  assert.equal((await store.listActive(task())).length, 1);
  assert.equal((await store.listActive({ ...task(), user: 'other-user' })).length, 0);
});

test('active task event cursor rejects gaps and makes duplicate events idempotent', async () => {
  const store = new MemoryActiveTaskStore();
  await store.create(task());
  await store.recordEvent('task-1', { sequence: 1, type: 'task.accepted', phase: 'accepted' });
  await assert.rejects(
    store.recordEvent('task-1', { sequence: 3, type: 'task.phase_changed', phase: 'planning' }),
    ActiveTaskSequenceGapError,
  );
  const duplicate = await store.recordEvent('task-1', { sequence: 1, type: 'task.accepted', phase: 'accepted' });
  assert.equal(duplicate.latestSequence, 1);
});

test('active task store refuses cross-scope turns and terminal task reuse', async () => {
  const store = new MemoryActiveTaskStore();
  await store.create(task());
  await assert.rejects(
    store.attachTurn({
      taskId: 'task-1',
      scope: { ...task(), tenantId: 'other-tenant' },
      turn: turn('delivery-2', 2),
    }),
    /different user, tenant, or conversation/,
  );
  await store.mutateByTaskId('task-1', (draft) => {
    draft.status = 'completed';
  });
  await assert.rejects(
    store.attachTurn({ taskId: 'task-1', scope: task(), turn: turn('delivery-3', 3) }),
    /terminal task/,
  );
});

test('Mongo active task store preserves turns, task cursor, and task-level receipts', async () => {
  const collection = new FakeCollection();
  const store = new MongoActiveTaskStore({ collection });
  await store.init();
  await store.create({ ...task(), turn: turn('delivery-1') });
  await store.attachTurn({ taskId: 'task-1', scope: task(), turn: turn('delivery-2', 2) });
  await store.recordEvent('task-1', { sequence: 1, type: 'task.accepted', phase: 'accepted' });
  await store.markUsageReceipt('task-1', 'usage-1');
  await store.markArtifactReceipt('task-1', 'artifact-1', { status: 'completed' });
  const current = await store.getByTaskId('task-1');

  assert.equal(current.turnDeliveryIds.length, 2);
  assert.equal(current.latestSequence, 1);
  assert.equal(current.usageReceipts['usage-1'], 'completed');
  assert.equal(current.artifactReceipts['artifact-1'].status, 'completed');
  assert.equal((await store.listActive(task())).length, 1);
});
