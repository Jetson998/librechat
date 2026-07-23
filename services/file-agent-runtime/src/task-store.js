import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isTerminal } from './constants.js';

const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hashIdempotencyKey(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function digestManifest(manifest) {
  return createHash('sha256').update(JSON.stringify(canonicalize(manifest))).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

export class TaskNotFoundError extends Error {
  constructor(taskId) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different task manifest');
    this.name = 'IdempotencyConflictError';
    this.statusCode = 409;
  }
}

export class FileTaskStore {
  #lock = Promise.resolve();

  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.tasksDir = path.join(this.rootDir, 'tasks');
    this.idempotencyDir = path.join(this.rootDir, 'idempotency');
  }

  async init() {
    await mkdir(this.tasksDir, { recursive: true });
    await mkdir(this.idempotencyDir, { recursive: true });
  }

  async createTask({ idempotencyKey, manifest }) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new TypeError('Idempotency-Key is required');
    }

    const idempotencyKeyHash = hashIdempotencyKey(idempotencyKey);
    const manifestDigest = digestManifest(manifest);

    return this.#withLock(async () => {
      const existing = await this.#findByIdempotencyHash(idempotencyKeyHash);
      if (existing) {
        if (existing.manifestDigest !== manifestDigest) {
          throw new IdempotencyConflictError();
        }
        return { created: false, task: clone(existing) };
      }

      const now = new Date().toISOString();
      const taskId = randomUUID();
      const acceptedEvent = {
        schemaVersion: '1.0',
        taskId,
        sequence: 1,
        eventId: randomUUID(),
        type: 'task.accepted',
        phase: 'accepted',
        createdAt: now,
        data: {},
      };
      const task = {
        schemaVersion: '1.0',
        taskId,
        taskContractVersion: manifest.taskContractVersion,
        idempotencyKeyHash,
        manifestDigest,
        manifest: clone(manifest),
        status: 'accepted',
        phase: 'accepted',
        plan: null,
        planRevision: 0,
        appliedInstructionRevision: 0,
        instructionRevision: 0,
        instructions: [],
        executionCursor: 0,
        completedItemIds: [],
        itemResults: {},
        activeItem: null,
        result: null,
        error: null,
        lastSequence: 1,
        events: [acceptedEvent],
        createdAt: now,
        updatedAt: now,
      };

      await this.#writeTask(task);
      await this.#atomicWriteJson(this.#idempotencyPath(idempotencyKeyHash), {
        idempotencyKeyHash,
        taskId,
      });

      return { created: true, task: clone(task) };
    });
  }

  async getTask(taskId) {
    const task = await this.#readTask(taskId);
    return task ? clone(task) : null;
  }

  async requireTask(taskId) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  async getEvents(taskId, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError('after must be a non-negative safe integer');
    }
    const task = await this.requireTask(taskId);
    return task.events.filter((event) => event.sequence > after);
  }

  async listRecoverableTasks() {
    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    const tasks = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const task = await this.#readJson(path.join(this.tasksDir, entry.name));
      if (task && !isTerminal(task.status)) {
        tasks.push(task);
      }
    }

    tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return clone(tasks);
  }

  async mutateTask(taskId, mutator) {
    return this.#withLock(async () => {
      const current = await this.#readTask(taskId);
      if (!current) {
        throw new TaskNotFoundError(taskId);
      }

      const draft = clone(current);
      const pendingEvents = [];
      const emit = (event) => pendingEvents.push(clone(event));
      const changed = mutator(draft, emit);

      if (changed === false && pendingEvents.length === 0) {
        return { changed: false, task: clone(current), events: [] };
      }

      const now = new Date().toISOString();
      const persistedEvents = pendingEvents.map((event) => {
        draft.lastSequence += 1;
        return {
          schemaVersion: '1.0',
          taskId,
          sequence: draft.lastSequence,
          eventId: randomUUID(),
          createdAt: now,
          phase: draft.phase,
          data: {},
          ...event,
        };
      });

      draft.events.push(...persistedEvents);
      draft.updatedAt = now;
      await this.#writeTask(draft);

      return { changed: true, task: clone(draft), events: clone(persistedEvents) };
    });
  }

  async #findByIdempotencyHash(idempotencyKeyHash) {
    const index = await this.#readJson(this.#idempotencyPath(idempotencyKeyHash));
    if (index?.taskId) {
      const indexedTask = await this.#readTask(index.taskId);
      if (indexedTask?.idempotencyKeyHash === idempotencyKeyHash) {
        return indexedTask;
      }
    }

    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const task = await this.#readJson(path.join(this.tasksDir, entry.name));
      if (task?.idempotencyKeyHash === idempotencyKeyHash) {
        await this.#atomicWriteJson(this.#idempotencyPath(idempotencyKeyHash), {
          idempotencyKeyHash,
          taskId: task.taskId,
        });
        return task;
      }
    }

    return null;
  }

  async #readTask(taskId) {
    return this.#readJson(this.#taskPath(taskId));
  }

  async #writeTask(task) {
    await this.#atomicWriteJson(this.#taskPath(task.taskId), task);
  }

  async #readJson(filePath) {
    try {
      const contents = await readFile(filePath, 'utf8');
      return JSON.parse(contents);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async #atomicWriteJson(filePath, value) {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  }

  #taskPath(taskId) {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new TypeError('Invalid taskId');
    }
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  #idempotencyPath(idempotencyKeyHash) {
    return path.join(this.idempotencyDir, `${idempotencyKeyHash}.json`);
  }

  #withLock(operation) {
    const next = this.#lock.catch(() => {}).then(operation);
    this.#lock = next.catch(() => {});
    return next;
  }
}
