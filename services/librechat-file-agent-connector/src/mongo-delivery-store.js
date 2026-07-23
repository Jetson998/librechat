import { randomUUID } from 'node:crypto';

import { DELIVERY_TERMINAL_STATUSES } from './constants.js';
import { DeliveryConflictError } from './delivery-store.js';
import { clone, digestJson, sha256 } from './stable.js';

const TERMINAL_STATUSES = [...DELIVERY_TERMINAL_STATUSES];

function returnedDocument(result) {
  return result?.value ?? result ?? null;
}

function identityFilter(idempotencyKeyHash, record) {
  const filters = [{ idempotencyKeyHash }];
  if (record?.conversationId && record?.userMessageId && record?.taskContractVersion) {
    filters.push({
      conversationId: record.conversationId,
      userMessageId: record.userMessageId,
      taskContractVersion: record.taskContractVersion,
    });
  }
  return filters.length === 1 ? filters[0] : { $or: filters };
}

function assertSameSubmission(existing, { idempotencyKeyHash, manifestDigest }) {
  if (
    existing.idempotencyKeyHash !== idempotencyKeyHash ||
    existing.manifestDigest !== manifestDigest
  ) {
    throw new DeliveryConflictError();
  }
}

export class MongoDeliveryStore {
  constructor({ collection, maxMutationRetries = 5 }) {
    if (!collection || typeof collection.findOne !== 'function') {
      throw new TypeError('MongoDeliveryStore collection is required');
    }
    if (!Number.isSafeInteger(maxMutationRetries) || maxMutationRetries < 1) {
      throw new TypeError('maxMutationRetries must be a positive safe integer');
    }
    this.collection = collection;
    this.maxMutationRetries = maxMutationRetries;
  }

  async init() {
    await this.collection.createIndex({ idempotencyKeyHash: 1 }, { unique: true });
    await this.collection.createIndex(
      { conversationId: 1, userMessageId: 1, taskContractVersion: 1 },
      { unique: true },
    );
    await this.collection.createIndex({ status: 1, 'retry.nextAt': 1 });
    await this.collection.createIndex({ leaseExpiresAt: 1 });
  }

  async createOrGet({ idempotencyKey, manifest, record }) {
    const idempotencyKeyHash = sha256(idempotencyKey);
    const manifestDigest = digestJson(manifest);
    const filter = identityFilter(idempotencyKeyHash, record);
    const existing = await this.collection.findOne(filter);
    if (existing) {
      assertSameSubmission(existing, { idempotencyKeyHash, manifestDigest });
      return { created: false, delivery: clone(existing) };
    }
    const now = new Date().toISOString();
    const delivery = {
      ...clone(record),
      _id: randomUUID(),
      schemaVersion: '1.0',
      deliveryId: null,
      taskId: null,
      status: 'submitting',
      lastSequence: 0,
      usageReceipts: {},
      artifactReceipts: {},
      finalization: {
        messageSaved: false,
        finalEventSaved: false,
        jobCompleted: false,
      },
      retry: { attempts: 0, nextAt: null, lastErrorCode: null },
      idempotencyKeyHash,
      manifestDigest,
      submission: { idempotencyKey, manifest: clone(manifest) },
      leaseOwner: null,
      leaseExpiresAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    delivery.deliveryId = delivery._id;
    try {
      await this.collection.insertOne(delivery);
      return { created: true, delivery: clone(delivery) };
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }
      const concurrent = await this.collection.findOne(filter);
      if (!concurrent) {
        throw new DeliveryConflictError();
      }
      assertSameSubmission(concurrent, { idempotencyKeyHash, manifestDigest });
      return { created: false, delivery: clone(concurrent) };
    }
  }

  async get(deliveryId) {
    const record = await this.collection.findOne({ _id: deliveryId });
    return record ? clone(record) : null;
  }

  async mutate(deliveryId, mutator) {
    for (let attempt = 0; attempt < this.maxMutationRetries; attempt += 1) {
      const current = await this.collection.findOne({ _id: deliveryId });
      if (!current) {
        throw new Error(`Delivery not found: ${deliveryId}`);
      }
      const draft = clone(current);
      const changed = await mutator(draft);
      if (changed === false) {
        return clone(current);
      }
      draft.version = (current.version ?? 0) + 1;
      draft.updatedAt = new Date().toISOString();
      const { _id, ...setFields } = draft;
      const updated = returnedDocument(await this.collection.findOneAndUpdate(
        { _id: deliveryId, version: current.version },
        { $set: setFields },
        { returnDocument: 'after' },
      ));
      if (updated) {
        return clone(updated);
      }
    }
    throw new Error(`Delivery mutation conflict: ${deliveryId}`);
  }

  async listRecoverable() {
    const cursor = this.collection.find({ status: { $nin: TERMINAL_STATUSES } });
    if (typeof cursor.sort === 'function') {
      cursor.sort({ createdAt: 1 });
    }
    return (await cursor.toArray()).map(clone);
  }

  async acquireLease(deliveryId, { owner, ttlMs = 30_000, now = Date.now() }) {
    if (typeof owner !== 'string' || owner === '') {
      throw new TypeError('Lease owner is required');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new TypeError('Lease ttlMs must be a positive safe integer');
    }
    const nowIso = new Date(now).toISOString();
    const leaseExpiresAt = new Date(now + ttlMs).toISOString();
    const result = returnedDocument(await this.collection.findOneAndUpdate(
      {
        _id: deliveryId,
        status: { $nin: TERMINAL_STATUSES },
        $or: [
          { leaseOwner: owner },
          { leaseOwner: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $lte: nowIso } },
        ],
      },
      {
        $set: {
          leaseOwner: owner,
          leaseExpiresAt,
          updatedAt: nowIso,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    ));
    return result ? clone(result) : null;
  }

  async releaseLease(deliveryId, owner) {
    const result = returnedDocument(await this.collection.findOneAndUpdate(
      { _id: deliveryId, leaseOwner: owner },
      {
        $set: {
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date().toISOString(),
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    ));
    return result ? clone(result) : null;
  }
}
