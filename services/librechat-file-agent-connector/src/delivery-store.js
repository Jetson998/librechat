import { randomUUID } from 'node:crypto';

import { DELIVERY_TERMINAL_STATUSES } from './constants.js';
import { clone, digestJson, sha256 } from './stable.js';

export class DeliveryConflictError extends Error {
  constructor() {
    super('Delivery idempotency key was already used with a different manifest');
    this.name = 'DeliveryConflictError';
  }
}

export class MemoryDeliveryStore {
  constructor() {
    this.records = new Map();
    this.byIdempotencyHash = new Map();
  }

  async createOrGet({ idempotencyKey, manifest, record }) {
    const idempotencyKeyHash = sha256(idempotencyKey);
    const manifestDigest = digestJson(manifest);
    const existingId = this.byIdempotencyHash.get(idempotencyKeyHash);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing.manifestDigest !== manifestDigest) {
        throw new DeliveryConflictError();
      }
      return { created: false, delivery: clone(existing) };
    }
    const now = new Date().toISOString();
    const delivery = {
      schemaVersion: '1.0',
      deliveryId: randomUUID(),
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
      createdAt: now,
      updatedAt: now,
      ...clone(record),
    };
    this.records.set(delivery.deliveryId, delivery);
    this.byIdempotencyHash.set(idempotencyKeyHash, delivery.deliveryId);
    return { created: true, delivery: clone(delivery) };
  }

  async get(deliveryId) {
    const record = this.records.get(deliveryId);
    return record ? clone(record) : null;
  }

  async mutate(deliveryId, mutator) {
    const current = this.records.get(deliveryId);
    if (!current) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }
    const draft = clone(current);
    const changed = await mutator(draft);
    if (changed === false) {
      return clone(current);
    }
    draft.updatedAt = new Date().toISOString();
    this.records.set(deliveryId, draft);
    return clone(draft);
  }

  async listRecoverable() {
    return [...this.records.values()]
      .filter((record) => !DELIVERY_TERMINAL_STATUSES.has(record.status))
      .map(clone)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
