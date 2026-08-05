import { randomUUID } from 'node:crypto';

import { clone, requiredString } from './stable.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

export class ActiveTaskConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActiveTaskConflictError';
    this.statusCode = 409;
  }
}

export class ActiveTaskNotFoundError extends Error {
  constructor(taskId) {
    super(`Active Runtime task not found: ${taskId}`);
    this.name = 'ActiveTaskNotFoundError';
    this.taskId = taskId;
    this.statusCode = 404;
  }
}

export class ActiveTaskSequenceGapError extends Error {
  constructor(expected, actual) {
    super(`Active task event sequence gap: expected ${expected}, received ${actual}`);
    this.name = 'ActiveTaskSequenceGapError';
    this.expected = expected;
    this.actual = actual;
    this.statusCode = 409;
  }
}

export class ActiveTaskSelectionRequiredError extends Error {
  constructor(tasks) {
    super('Multiple active Runtime tasks match this conversation; task selection is required');
    this.name = 'ActiveTaskSelectionRequiredError';
    this.statusCode = 409;
    this.candidates = tasks.map((task) => ({
      activeTaskId: task.activeTaskId,
      taskId: task.taskId,
      capabilityProfile: task.capabilityProfile,
      status: task.status,
      runtimePhase: task.runtimePhase,
      updatedAt: task.updatedAt,
    }));
  }
}

function normalizedTenantId(value) {
  return value == null ? null : requiredString(value, 'tenantId');
}

function assertScope(scope) {
  return {
    user: requiredString(scope?.user, 'user'),
    tenantId: normalizedTenantId(scope?.tenantId),
    conversationId: requiredString(scope?.conversationId, 'conversationId'),
  };
}

function sameScope(left, right) {
  return left.user === right.user &&
    (left.tenantId ?? null) === (right.tenantId ?? null) &&
    left.conversationId === right.conversationId;
}

function assertTaskIdentity(existing, scope) {
  if (!sameScope(existing, scope)) {
    throw new ActiveTaskConflictError('Runtime task is owned by a different user, tenant, or conversation');
  }
}

function normalizeTurn(turn) {
  return {
    deliveryId: requiredString(turn?.deliveryId, 'turn.deliveryId'),
    userMessageId: requiredString(turn?.userMessageId, 'turn.userMessageId'),
    assistantMessageId: requiredString(turn?.assistantMessageId, 'turn.assistantMessageId'),
    streamId: requiredString(turn?.streamId, 'turn.streamId'),
    turnType: requiredString(turn?.turnType ?? 'submit', 'turn.turnType'),
    createdAt: turn?.createdAt ?? new Date().toISOString(),
  };
}

function normalizeInputRefs(inputRefs) {
  if (inputRefs == null) {
    return [];
  }
  if (!Array.isArray(inputRefs)) {
    throw new TypeError('inputRefs must be an array');
  }
  return clone(inputRefs);
}

function normalizeOutputPolicy(allowedOutputMimeTypes, maxVisibleArtifacts) {
  if (!Array.isArray(allowedOutputMimeTypes)) {
    throw new TypeError('allowedOutputMimeTypes must be an array');
  }
  if (!Number.isSafeInteger(maxVisibleArtifacts) || maxVisibleArtifacts < 1) {
    throw new TypeError('maxVisibleArtifacts must be a positive safe integer');
  }
  return {
    allowedOutputMimeTypes: [...new Set(allowedOutputMimeTypes)],
    maxVisibleArtifacts,
  };
}

function createRecord({
  taskId,
  user,
  tenantId = null,
  conversationId,
  taskContractVersion,
  capabilityProfile,
  billingSnapshotRef,
  modelRouteId,
  providerRouteRef = null,
  providerEndpoint = null,
  providerModel = null,
  providerProtocol = null,
  workspaceRef = null,
  inputRefs = [],
  allowedOutputMimeTypes = [],
  maxVisibleArtifacts = 1,
  runtimePhase = 'accepted',
  turn = null,
}) {
  const scope = assertScope({ user, tenantId, conversationId });
  const outputPolicy = normalizeOutputPolicy(allowedOutputMimeTypes, maxVisibleArtifacts);
  const record = {
    schemaVersion: '1.0',
    activeTaskId: randomUUID(),
    taskId: requiredString(taskId, 'taskId'),
    ...scope,
    taskContractVersion: requiredString(taskContractVersion, 'taskContractVersion'),
    capabilityProfile: requiredString(capabilityProfile, 'capabilityProfile'),
    billingSnapshotRef: requiredString(billingSnapshotRef, 'billingSnapshotRef'),
    modelRouteId: requiredString(modelRouteId, 'modelRouteId'),
    ...(providerRouteRef
      ? {
          providerRouteRef: requiredString(providerRouteRef, 'providerRouteRef'),
          providerEndpoint: requiredString(providerEndpoint, 'providerEndpoint'),
          providerModel: requiredString(providerModel, 'providerModel'),
          providerProtocol: requiredString(providerProtocol, 'providerProtocol'),
        }
      : {}),
    workspaceRef: workspaceRef == null ? null : requiredString(workspaceRef, 'workspaceRef'),
    inputRefs: normalizeInputRefs(inputRefs),
    ...outputPolicy,
    status: runtimePhase,
    runtimePhase,
    latestSequence: 0,
    usageReceipts: {},
    artifactReceipts: {},
    turnDeliveryIds: [],
    turns: [],
    currentTurnDeliveryId: null,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (turn) {
    const normalizedTurn = normalizeTurn(turn);
    record.turnDeliveryIds.push(normalizedTurn.deliveryId);
    record.turns.push(normalizedTurn);
    record.currentTurnDeliveryId = normalizedTurn.deliveryId;
  }
  return record;
}

function applyEventState(draft, event) {
  if (typeof event.phase === 'string' && event.phase !== '') {
    draft.runtimePhase = event.phase;
    draft.status = event.phase;
  }
  if (event.type === 'task.needs_input') {
    draft.status = 'needs_input';
  } else if (event.type === 'task.completed') {
    draft.status = 'completed';
  } else if (event.type === 'task.failed') {
    draft.status = 'failed';
  } else if (event.type === 'task.canceled') {
    draft.status = 'canceled';
  }
}

function markReceipt(draft, key, value) {
  if (typeof key !== 'string' || key === '') {
    throw new TypeError('Receipt key is required');
  }
  if (Object.hasOwn(draft, key)) {
    return false;
  }
  draft[key] = value;
  return true;
}

export class MemoryActiveTaskStore {
  constructor() {
    this.records = new Map();
    this.byTaskId = new Map();
    this.lock = Promise.resolve();
  }

  async init() {}

  async create(options) {
    return this.#withLock(async () => {
      const taskId = requiredString(options?.taskId, 'taskId');
      const existingId = this.byTaskId.get(taskId);
      if (existingId) {
        const existing = this.records.get(existingId);
        assertTaskIdentity(existing, assertScope(options));
        return { created: false, activeTask: clone(existing) };
      }
      const record = createRecord(options);
      this.records.set(record.activeTaskId, record);
      this.byTaskId.set(record.taskId, record.activeTaskId);
      return { created: true, activeTask: clone(record) };
    });
  }

  async get(activeTaskId) {
    const record = this.records.get(activeTaskId);
    return record ? clone(record) : null;
  }

  async getByTaskId(taskId) {
    const activeTaskId = this.byTaskId.get(taskId);
    return activeTaskId ? this.get(activeTaskId) : null;
  }

  async listActive(scopeInput) {
    const scope = assertScope(scopeInput);
    return [...this.records.values()]
      .filter((record) => sameScope(record, scope) && !TERMINAL_STATUSES.has(record.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(clone);
  }

  async attachTurn({ taskId, scope, turn }) {
    return this.mutateByTaskId(taskId, (draft) => {
      assertTaskIdentity(draft, assertScope(scope));
      const normalizedTurn = normalizeTurn(turn);
      if (draft.turnDeliveryIds.includes(normalizedTurn.deliveryId)) {
        return false;
      }
      if (TERMINAL_STATUSES.has(draft.status)) {
        throw new ActiveTaskConflictError(`Cannot attach a turn to terminal task: ${draft.status}`);
      }
      draft.turnDeliveryIds.push(normalizedTurn.deliveryId);
      draft.turns.push(normalizedTurn);
      draft.currentTurnDeliveryId = normalizedTurn.deliveryId;
      return true;
    });
  }

  async mutateByTaskId(taskId, mutator) {
    return this.#withLock(async () => {
      const activeTaskId = this.byTaskId.get(taskId);
      if (!activeTaskId) {
        throw new ActiveTaskNotFoundError(taskId);
      }
      const current = this.records.get(activeTaskId);
      const draft = clone(current);
      const changed = await mutator(draft);
      if (changed === false) {
        return clone(current);
      }
      draft.version = (current.version ?? 0) + 1;
      draft.updatedAt = new Date().toISOString();
      this.records.set(activeTaskId, draft);
      return clone(draft);
    });
  }

  async recordEvent(taskId, event) {
    return this.mutateByTaskId(taskId, (draft) => {
      if (event.sequence <= draft.latestSequence) {
        return false;
      }
      if (event.sequence !== draft.latestSequence + 1) {
        throw new ActiveTaskSequenceGapError(draft.latestSequence + 1, event.sequence);
      }
      draft.latestSequence = event.sequence;
      applyEventState(draft, event);
      return true;
    });
  }

  async markUsageReceipt(taskId, usageEventId) {
    return this.mutateByTaskId(taskId, (draft) => {
      return markReceipt(draft.usageReceipts, usageEventId, 'completed');
    });
  }

  async markArtifactReceipt(taskId, artifactId, receipt) {
    return this.mutateByTaskId(taskId, (draft) => {
      return markReceipt(draft.artifactReceipts, artifactId, clone(receipt));
    });
  }

  #withLock(operation) {
    const next = this.lock.catch(() => {}).then(operation);
    this.lock = next.catch(() => {});
    return next;
  }
}

export class MongoActiveTaskStore {
  constructor({ collection, maxMutationRetries = 5 }) {
    if (!collection || typeof collection.findOne !== 'function') {
      throw new TypeError('MongoActiveTaskStore collection is required');
    }
    if (!Number.isSafeInteger(maxMutationRetries) || maxMutationRetries < 1) {
      throw new TypeError('maxMutationRetries must be a positive safe integer');
    }
    this.collection = collection;
    this.maxMutationRetries = maxMutationRetries;
  }

  async init() {
    await this.collection.createIndex({ taskId: 1 }, { unique: true });
    await this.collection.createIndex({ user: 1, tenantId: 1, conversationId: 1, status: 1, updatedAt: -1 });
    await this.collection.createIndex({ turnDeliveryIds: 1 });
  }

  async create(options) {
    const taskId = requiredString(options?.taskId, 'taskId');
    const scope = assertScope(options);
    const existing = await this.collection.findOne({ taskId });
    if (existing) {
      assertTaskIdentity(existing, scope);
      return { created: false, activeTask: clone(existing) };
    }
    const record = createRecord(options);
    try {
      await this.collection.insertOne(record);
      return { created: true, activeTask: clone(record) };
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }
      const concurrent = await this.collection.findOne({ taskId });
      if (!concurrent) {
        throw error;
      }
      assertTaskIdentity(concurrent, scope);
      return { created: false, activeTask: clone(concurrent) };
    }
  }

  async get(activeTaskId) {
    const record = await this.collection.findOne({ activeTaskId });
    return record ? clone(record) : null;
  }

  async getByTaskId(taskId) {
    const record = await this.collection.findOne({ taskId });
    return record ? clone(record) : null;
  }

  async listActive(scopeInput) {
    const scope = assertScope(scopeInput);
    const cursor = this.collection.find({
      ...scope,
      status: { $nin: [...TERMINAL_STATUSES] },
    });
    if (typeof cursor.sort === 'function') {
      cursor.sort({ updatedAt: -1 });
    }
    return (await cursor.toArray()).map(clone);
  }

  async attachTurn({ taskId, scope, turn }) {
    return this.mutateByTaskId(taskId, (draft) => {
      assertTaskIdentity(draft, assertScope(scope));
      const normalizedTurn = normalizeTurn(turn);
      if (draft.turnDeliveryIds.includes(normalizedTurn.deliveryId)) {
        return false;
      }
      if (TERMINAL_STATUSES.has(draft.status)) {
        throw new ActiveTaskConflictError(`Cannot attach a turn to terminal task: ${draft.status}`);
      }
      draft.turnDeliveryIds.push(normalizedTurn.deliveryId);
      draft.turns.push(normalizedTurn);
      draft.currentTurnDeliveryId = normalizedTurn.deliveryId;
      return true;
    });
  }

  async mutateByTaskId(taskId, mutator) {
    for (let attempt = 0; attempt < this.maxMutationRetries; attempt += 1) {
      const current = await this.collection.findOne({ taskId });
      if (!current) {
        throw new ActiveTaskNotFoundError(taskId);
      }
      const draft = clone(current);
      const changed = await mutator(draft);
      if (changed === false) {
        return clone(current);
      }
      draft.version = (current.version ?? 0) + 1;
      draft.updatedAt = new Date().toISOString();
      const { _id, ...setFields } = draft;
      const result = await this.collection.findOneAndUpdate(
        { taskId, version: current.version },
        { $set: setFields },
        { returnDocument: 'after' },
      );
      const updated = result?.value ?? result;
      if (updated) {
        return clone(updated);
      }
    }
    throw new Error(`Active task mutation conflict: ${taskId}`);
  }

  async recordEvent(taskId, event) {
    return this.mutateByTaskId(taskId, (draft) => {
      if (event.sequence <= draft.latestSequence) {
        return false;
      }
      if (event.sequence !== draft.latestSequence + 1) {
        throw new ActiveTaskSequenceGapError(draft.latestSequence + 1, event.sequence);
      }
      draft.latestSequence = event.sequence;
      applyEventState(draft, event);
      return true;
    });
  }

  async markUsageReceipt(taskId, usageEventId) {
    return this.mutateByTaskId(taskId, (draft) => {
      return markReceipt(draft.usageReceipts, usageEventId, 'completed');
    });
  }

  async markArtifactReceipt(taskId, artifactId, receipt) {
    return this.mutateByTaskId(taskId, (draft) => {
      return markReceipt(draft.artifactReceipts, artifactId, clone(receipt));
    });
  }
}
