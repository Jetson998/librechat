import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ProviderAmbiguousCommitError,
  ProviderCallConflictError,
} from './provider-adapter.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

export class FileModelCallJournal {
  #lock = Promise.resolve();

  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.callsDir = path.join(this.rootDir, 'model-calls');
  }

  async init() {
    await mkdir(this.callsDir, { recursive: true });
  }

  async begin({ callId, requestDigest, routeId, supportsIdempotency }) {
    this.#validateIdentity({ callId, requestDigest, routeId });
    await this.init();
    return this.#withLock(async () => {
      const existing = await this.#read(callId);
      if (!existing) {
        const now = new Date().toISOString();
        const pending = {
          schemaVersion: '1.0',
          callIdHash: sha256(callId),
          requestDigest,
          routeId,
          status: 'pending',
          attemptCount: 1,
          createdAt: now,
          updatedAt: now,
        };
        await this.#write(callId, pending);
        return { action: 'execute', replay: false };
      }
      if (existing.requestDigest !== requestDigest || existing.routeId !== routeId) {
        throw new ProviderCallConflictError();
      }
      if (existing.status === 'completed' || existing.status === 'completed_valid') {
        return { action: 'replay', result: clone(existing.result) };
      }
      if (existing.status === 'completed_invalid') {
        return { action: 'replay_invalid', receipt: clone(existing.receipt) };
      }
      if (existing.status === 'ambiguous') {
        throw new ProviderAmbiguousCommitError();
      }
      if (!supportsIdempotency) {
        existing.status = 'ambiguous';
        existing.updatedAt = new Date().toISOString();
        await this.#write(callId, existing);
        throw new ProviderAmbiguousCommitError(
          'Pending provider call cannot be replayed because the route does not guarantee idempotency',
        );
      }
      existing.attemptCount += 1;
      existing.updatedAt = new Date().toISOString();
      await this.#write(callId, existing);
      return { action: 'execute', replay: true };
    });
  }

  complete(args) {
    return this.completeValid(args);
  }

  async completeValid({ callId, requestDigest, routeId, result }) {
    this.#validateIdentity({ callId, requestDigest, routeId });
    await this.init();
    return this.#withLock(async () => {
      const existing = await this.#read(callId);
      if (!existing) {
        throw new ProviderCallConflictError('Provider call was completed without a pending journal entry');
      }
      if (existing.requestDigest !== requestDigest || existing.routeId !== routeId) {
        throw new ProviderCallConflictError();
      }
      if (existing.status === 'completed' || existing.status === 'completed_valid') {
        return clone(existing.result);
      }
      if (existing.status === 'completed_invalid') {
        throw new ProviderCallConflictError('Provider call was already completed with an invalid response');
      }
      if (existing.status === 'ambiguous') {
        throw new ProviderAmbiguousCommitError();
      }
      existing.status = 'completed_valid';
      existing.result = clone(result);
      existing.completedAt = new Date().toISOString();
      existing.updatedAt = existing.completedAt;
      await this.#write(callId, existing);
      return clone(existing.result);
    });
  }

  async completeInvalid({ callId, requestDigest, routeId, receipt }) {
    this.#validateIdentity({ callId, requestDigest, routeId });
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw new TypeError('Invalid provider receipt is required');
    }
    await this.init();
    return this.#withLock(async () => {
      const existing = await this.#read(callId);
      if (!existing) {
        throw new ProviderCallConflictError('Provider call was completed without a pending journal entry');
      }
      if (existing.requestDigest !== requestDigest || existing.routeId !== routeId) {
        throw new ProviderCallConflictError();
      }
      if (existing.status === 'completed_invalid') {
        return clone(existing.receipt);
      }
      if (existing.status === 'completed' || existing.status === 'completed_valid') {
        throw new ProviderCallConflictError('Provider call was already completed with a valid response');
      }
      if (existing.status === 'ambiguous') {
        throw new ProviderAmbiguousCommitError();
      }
      existing.status = 'completed_invalid';
      existing.receipt = clone(receipt);
      existing.completedAt = new Date().toISOString();
      existing.updatedAt = existing.completedAt;
      await this.#write(callId, existing);
      return clone(existing.receipt);
    });
  }

  async get(callId) {
    await this.init();
    const value = await this.#read(callId);
    return value ? clone(value) : null;
  }

  #validateIdentity({ callId, requestDigest, routeId }) {
    for (const [name, value] of Object.entries({ callId, requestDigest, routeId })) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`Model call journal ${name} is required`);
      }
    }
  }

  async #read(callId) {
    try {
      return JSON.parse(await readFile(this.#path(callId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async #write(callId, value) {
    const target = this.#path(callId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  #path(callId) {
    return path.join(this.callsDir, `${sha256(callId)}.json`);
  }

  #withLock(operation) {
    const next = this.#lock.catch(() => {}).then(operation);
    this.#lock = next.catch(() => {});
    return next;
  }
}
