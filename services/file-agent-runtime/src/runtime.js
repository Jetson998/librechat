import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { canTransition, isTerminal } from './constants.js';
import { assertExecutorAdapter, isAbortError } from './executor-adapter.js';
import { assertProviderAdapter } from './provider-adapter.js';

export class RuntimeShutdownError extends Error {
  constructor() {
    super('Runtime is shutting down');
    this.name = 'RuntimeShutdownError';
  }
}

export class TaskStateConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskStateConflictError';
    this.statusCode = 409;
  }
}

export function validateTaskManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('Task manifest must be an object');
  }
  if (manifest.schemaVersion !== '1.0') {
    throw new TypeError('Task manifest schemaVersion must be "1.0"');
  }
  for (const field of ['taskContractVersion', 'taskType', 'intent']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      throw new TypeError(`Task manifest ${field} is required`);
    }
  }
}

function errorRecord(error) {
  const record = {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
  };
  if (typeof error?.code === 'string') {
    record.code = error.code;
  }
  if (typeof error?.retryable === 'boolean') {
    record.retryable = error.retryable;
  }
  return record;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function unwrapProviderValue(result) {
  return result?.value ?? result;
}

function actionSignature(plan) {
  return hashJson((plan?.actions ?? []).map((action) => ({ kind: action.kind })));
}

function verificationFingerprint(verification) {
  return hashJson({
    passed: verification?.passed === true,
    summary: verification?.summary ?? '',
    repairMarker: verification?.repairMarker ?? null,
    outputHash: verification?.outputHash ?? null,
    errorSignature: verification?.errorSignature ?? null,
  });
}

function persistProviderMetadata(task, emit, result, itemId) {
  const call = result?.call;
  const usage = result?.usage;
  if (call?.callId && usage && !task.recordedUsageEventIds.includes(call.callId)) {
    const usageRecord = {
      usageEventId: call.callId,
      callId: call.callId,
      modelRouteId: call.modelRouteId,
      providerModel: call.providerModel,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      occurredAt: usage.occurredAt ?? new Date().toISOString(),
    };
    task.recordedUsageEventIds.push(call.callId);
    task.usageRecords.push(usageRecord);
    emit({ type: 'usage.recorded', data: { usage: usageRecord } });
  }

  const compaction = result?.context?.compaction;
  const compactionId = `${itemId}:context`;
  if (compaction && !task.recordedCompactionIds.includes(compactionId)) {
    task.recordedCompactionIds.push(compactionId);
    emit({
      type: 'context.compacted',
      data: {
        compactionId,
        omittedItemCount: compaction.omittedItemCount,
        projectionCharacters: compaction.projectionCharacters,
      },
    });
  }
}

export class FileAgentRuntime {
  #running = new Map();
  #stopping = false;

  constructor({ store, provider, executor, testHooks }) {
    this.store = store;
    this.provider = assertProviderAdapter(provider);
    this.executor = assertExecutorAdapter(executor);
    this.testHooks = testHooks;
  }

  async start() {
    this.#stopping = false;
    await this.store.init();
    const tasks = await this.store.listRecoverableTasks();
    for (const task of tasks) {
      this.#schedule(task.taskId);
    }
  }

  async stop() {
    this.#stopping = true;
    for (const { controller } of this.#running.values()) {
      controller.abort(new RuntimeShutdownError());
    }
    await Promise.allSettled([...this.#running.values()].map(({ promise }) => promise));
  }

  async submit({ idempotencyKey, manifest }) {
    validateTaskManifest(manifest);
    const result = await this.store.createTask({ idempotencyKey, manifest });
    if (!isTerminal(result.task.status)) {
      this.#schedule(result.task.taskId);
    }
    return result;
  }

  getTask(taskId) {
    return this.store.getTask(taskId);
  }

  getEvents(taskId, after = 0) {
    return this.store.getEvents(taskId, after);
  }

  async cancel(taskId) {
    const mutation = await this.store.mutateTask(taskId, (task, emit) => {
      if (isTerminal(task.status)) {
        return false;
      }
      const previous = task.status;
      task.status = 'canceled';
      task.phase = 'canceled';
      task.activeItem = null;
      emit({ type: 'task.canceled', phase: 'canceled', data: { previous } });
      return true;
    });

    if (mutation.changed) {
      this.#running.get(taskId)?.controller.abort();
    }
    return mutation.task;
  }

  async steer(taskId, instruction) {
    if (!instruction || typeof instruction !== 'object') {
      throw new TypeError('Steer instruction must be an object');
    }
    if (typeof instruction.text !== 'string' || instruction.text.trim() === '') {
      throw new TypeError('Steer instruction text is required');
    }

    const normalized = {
      instructionId: instruction.instructionId ?? randomUUID(),
      text: instruction.text.trim(),
      createdAt: instruction.createdAt ?? new Date().toISOString(),
    };

    const mutation = await this.store.mutateTask(taskId, (task, emit) => {
      if (isTerminal(task.status)) {
        throw new TaskStateConflictError(`Cannot steer terminal task: ${task.status}`);
      }
      if (task.instructions.some((entry) => entry.instructionId === normalized.instructionId)) {
        return false;
      }

      task.instructions.push(normalized);
      task.instructionRevision += 1;
      emit({
        type: 'task.steered',
        data: {
          instructionId: normalized.instructionId,
          instructionRevision: task.instructionRevision,
        },
      });

      if (task.status === 'needs_input') {
        const previous = task.status;
        task.status = 'planning';
        task.phase = 'planning';
        emit({ type: 'task.phase_changed', phase: 'planning', data: { from: previous, to: 'planning' } });
      }
      return true;
    });

    if (!isTerminal(mutation.task.status)) {
      this.#schedule(taskId);
    }
    return mutation.task;
  }

  async waitFor(taskId, predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await this.store.requireTask(taskId);
      if (predicate(task)) {
        return task;
      }
      await delay(intervalMs);
    }
    throw new Error(`Timed out waiting for task ${taskId}`);
  }

  #schedule(taskId) {
    if (this.#stopping || this.#running.has(taskId)) {
      return;
    }

    const controller = new AbortController();
    const promise = this.#runTask(taskId, controller.signal)
      .catch(() => {})
      .finally(() => {
        this.#running.delete(taskId);
      });
    this.#running.set(taskId, { controller, promise });
  }

  async #runTask(taskId, signal) {
    try {
      while (!this.#stopping) {
        signal.throwIfAborted();
        const task = await this.store.requireTask(taskId);

        if (isTerminal(task.status) || task.status === 'needs_input') {
          return;
        }

        switch (task.status) {
          case 'accepted':
            await this.#transition(taskId, 'preparing');
            break;
          case 'preparing':
            await this.#prepare(task, signal);
            break;
          case 'planning':
            await this.#plan(task, signal);
            break;
          case 'executing':
            await this.#execute(task, signal);
            break;
          case 'verifying':
            await this.#verify(task, signal);
            break;
          case 'repairing':
            await this.#repair(task, signal);
            break;
          case 'publishing':
            await this.#publish(task, signal);
            break;
          default:
            throw new Error(`Unsupported task status: ${task.status}`);
        }
      }
    } catch (error) {
      const task = await this.store.getTask(taskId);
      const shutdown = this.#stopping || error instanceof RuntimeShutdownError;
      const canceled = task?.status === 'canceled';
      if (shutdown || canceled || (isAbortError(error) && signal.aborted)) {
        return;
      }
      if (error?.code === 'PROVIDER_AMBIGUOUS_COMMIT') {
        await this.#moveToNeedsInput(taskId, error.message, 'provider_ambiguous_commit');
        return;
      }
      await this.#failTask(taskId, error);
    }
  }

  async #prepare(task, signal) {
    await this.#runItem({
      task,
      itemId: `${task.taskId}:prepare`,
      kind: 'workspace_prepare',
      summary: 'Prepare the isolated task workspace',
      signal,
      operation: (itemId) => this.executor.prepare({ itemId, task, signal }),
    });
    await this.#transition(task.taskId, 'planning');
  }

  async #plan(task, signal) {
    const instructionRevision = task.instructionRevision;
    const nextPlanRevision = task.planRevision + 1;
    const providerResult = await this.#runItem({
      task,
      itemId: `${task.taskId}:plan:${nextPlanRevision}:${instructionRevision}`,
      kind: 'model_plan',
      summary: `Create plan revision ${nextPlanRevision}`,
      signal,
      operation: (itemId) => this.provider.plan({ callId: itemId, task, signal }),
    });
    const plan = unwrapProviderValue(providerResult);

    await this.store.mutateTask(task.taskId, (current, emit) => {
      if (current.status !== 'planning') {
        return false;
      }
      if (current.instructionRevision !== instructionRevision) {
        return false;
      }

      current.planRevision = nextPlanRevision;
      current.appliedInstructionRevision = instructionRevision;
      current.executionCursor = 0;
      current.plan = plan;
      emit({
        type: 'plan.updated',
        data: {
          planRevision: nextPlanRevision,
          actionCount: plan.actions?.length ?? 0,
          needsInput: plan.needsInput === true,
        },
      });

      if (plan.needsInput) {
        current.status = 'needs_input';
        current.phase = 'needs_input';
        emit({ type: 'task.needs_input', phase: 'needs_input', data: { question: plan.question } });
      } else {
        current.status = 'executing';
        current.phase = 'executing';
        emit({ type: 'task.phase_changed', phase: 'executing', data: { from: 'planning', to: 'executing' } });
      }
      return true;
    });
  }

  async #execute(task, signal) {
    if (task.instructionRevision > task.appliedInstructionRevision) {
      await this.#transition(task.taskId, 'planning');
      return;
    }

    const actions = task.plan?.actions ?? [];
    if (task.executionCursor >= actions.length) {
      await this.#transition(task.taskId, 'verifying');
      return;
    }

    const cursor = task.executionCursor;
    const action = actions[cursor];
    await this.#runItem({
      task,
      itemId: `${task.taskId}:execute:${task.planRevision}:${cursor}`,
      kind: action.kind,
      summary: action.summary,
      signal,
      operation: (itemId) => this.executor.execute({ itemId, action, task, signal }),
    });

    await this.store.mutateTask(task.taskId, (current) => {
      if (
        current.status !== 'executing' ||
        current.planRevision !== task.planRevision ||
        current.executionCursor !== cursor
      ) {
        return false;
      }
      current.executionCursor += 1;
      return true;
    });
  }

  async #verify(task, signal) {
    const verification = await this.#runItem({
      task,
      itemId: `${task.taskId}:verify:${task.planRevision}`,
      kind: 'artifact_verification',
      summary: `Verify plan revision ${task.planRevision}`,
      signal,
      operation: (itemId) => this.executor.verify({ itemId, task, signal }),
    });

    await this.store.mutateTask(task.taskId, (current, emit) => {
      if (current.status !== 'verifying' || current.planRevision !== task.planRevision) {
        return false;
      }
      const fingerprint = verificationFingerprint(verification);
      current.verification = { ...verification, fingerprint };
      if (verification.passed) {
        current.progress.stagnationCount = 0;
        current.progress.lastFailedVerificationFingerprint = null;
      } else if (current.progress.lastFailedVerificationFingerprint === fingerprint) {
        current.progress.stagnationCount += 1;
        emit({
          type: 'progress.stalled',
          data: { fingerprint, stagnationCount: current.progress.stagnationCount },
        });
      } else {
        current.progress.stagnationCount = 0;
        current.progress.lastFailedVerificationFingerprint = fingerprint;
      }
      const next = verification.passed ? 'publishing' : 'repairing';
      current.status = next;
      current.phase = next;
      emit({ type: 'task.phase_changed', phase: next, data: { from: 'verifying', to: next } });
      return true;
    });
  }

  async #repair(task, signal) {
    const nextPlanRevision = task.planRevision + 1;
    const providerResult = await this.#runItem({
      task,
      itemId: `${task.taskId}:repair-plan:${nextPlanRevision}`,
      kind: 'model_repair_plan',
      summary: `Create repair plan revision ${nextPlanRevision}`,
      signal,
      operation: (itemId) => this.provider.repair({
        callId: itemId,
        task,
        verification: task.verification,
        signal,
      }),
    });
    const plan = unwrapProviderValue(providerResult);

    await this.store.mutateTask(task.taskId, (current, emit) => {
      if (current.status !== 'repairing' || current.planRevision !== task.planRevision) {
        return false;
      }
      current.planRevision = nextPlanRevision;
      current.plan = plan;
      current.executionCursor = 0;
      current.appliedInstructionRevision = current.instructionRevision;
      const nextActionSignature = actionSignature(plan);
      emit({
        type: 'plan.updated',
        data: { planRevision: nextPlanRevision, actionCount: plan.actions?.length ?? 0, repair: true },
      });
      if (plan.needsInput) {
        current.status = 'needs_input';
        current.phase = 'needs_input';
        emit({ type: 'task.needs_input', phase: 'needs_input', data: { question: plan.question } });
      } else if (
        current.progress.stagnationCount > 0 &&
        current.progress.lastRepairActionSignature === nextActionSignature
      ) {
        current.status = 'needs_input';
        current.phase = 'needs_input';
        emit({
          type: 'task.needs_input',
          phase: 'needs_input',
          data: {
            reason: 'repeated_no_progress_plan',
            question: 'The same repair plan did not change verification. Additional guidance is required.',
          },
        });
      } else {
        current.progress.lastRepairActionSignature = nextActionSignature;
        current.status = 'executing';
        current.phase = 'executing';
        emit({ type: 'task.phase_changed', phase: 'executing', data: { from: 'repairing', to: 'executing' } });
      }
      return true;
    });
  }

  async #publish(task, signal) {
    const result = await this.#runItem({
      task,
      itemId: `${task.taskId}:publish:${task.planRevision}`,
      kind: 'artifact_publish',
      summary: 'Publish verified CodeAPI artifact references',
      signal,
      operation: (itemId) => this.executor.publish({ itemId, task, signal }),
    });

    await this.store.mutateTask(task.taskId, (current, emit) => {
      if (current.status !== 'publishing' || current.planRevision !== task.planRevision) {
        return false;
      }
      current.result = result;
      for (const artifact of result.artifacts ?? []) {
        emit({ type: 'artifact.ready', data: { artifact } });
      }
      current.status = 'completed';
      current.phase = 'completed';
      emit({
        type: 'task.completed',
        phase: 'completed',
        data: { artifactCount: result.artifacts?.length ?? 0 },
      });
      return true;
    });
  }

  async #runItem({ task, itemId, kind, summary, signal, operation }) {
    const latest = await this.store.requireTask(task.taskId);
    if (latest.completedItemIds.includes(itemId)) {
      return latest.itemResults[itemId];
    }

    await this.store.mutateTask(task.taskId, (current, emit) => {
      if (isTerminal(current.status)) {
        return false;
      }
      if (current.completedItemIds.includes(itemId)) {
        return false;
      }
      if (current.activeItem?.itemId === itemId) {
        return false;
      }
      current.activeItem = { itemId, kind, summary, startedAt: new Date().toISOString() };
      emit({ type: 'item.started', item: { itemId, kind, status: 'running', summary } });
      return true;
    });

    try {
      const result = await operation(itemId);
      signal.throwIfAborted();
      await this.testHooks?.afterItemOperation?.({
        taskId: task.taskId,
        itemId,
        kind,
        result,
      });
      await this.store.mutateTask(task.taskId, (current, emit) => {
        if (isTerminal(current.status)) {
          return false;
        }
        if (!current.completedItemIds.includes(itemId)) {
          current.completedItemIds.push(itemId);
        }
        current.itemResults[itemId] = result;
        persistProviderMetadata(current, emit, result, itemId);
        if (current.activeItem?.itemId === itemId) {
          current.activeItem = null;
        }
        emit({
          type: 'item.completed',
          item: { itemId, kind, status: 'completed', summary, result },
        });
        return true;
      });
      return result;
    } catch (error) {
      if (error instanceof RuntimeShutdownError) {
        throw error;
      }
      if (!signal.aborted) {
        await this.store.mutateTask(task.taskId, (current, emit) => {
          if (isTerminal(current.status)) {
            return false;
          }
          if (current.activeItem?.itemId === itemId) {
            current.activeItem = null;
          }
          emit({
            type: 'item.failed',
            item: { itemId, kind, status: 'failed', summary, error: errorRecord(error) },
          });
          return true;
        });
      }
      throw error;
    }
  }

  async #transition(taskId, nextStatus) {
    return this.store.mutateTask(taskId, (task, emit) => {
      if (task.status === nextStatus || isTerminal(task.status)) {
        return false;
      }
      if (!canTransition(task.status, nextStatus)) {
        throw new Error(`Illegal task transition: ${task.status} -> ${nextStatus}`);
      }
      const previous = task.status;
      task.status = nextStatus;
      task.phase = nextStatus;
      emit({
        type: 'task.phase_changed',
        phase: nextStatus,
        data: { from: previous, to: nextStatus },
      });
      return true;
    });
  }

  async #failTask(taskId, error) {
    await this.store.mutateTask(taskId, (task, emit) => {
      if (isTerminal(task.status)) {
        return false;
      }
      const previous = task.status;
      task.status = 'failed';
      task.phase = 'failed';
      task.activeItem = null;
      task.error = errorRecord(error);
      emit({ type: 'task.failed', phase: 'failed', data: { previous, error: task.error } });
      return true;
    });
  }

  async #moveToNeedsInput(taskId, question, reason) {
    await this.store.mutateTask(taskId, (task, emit) => {
      if (isTerminal(task.status) || task.status === 'needs_input') {
        return false;
      }
      if (!canTransition(task.status, 'needs_input')) {
        throw new Error(`Illegal task transition: ${task.status} -> needs_input`);
      }
      const previous = task.status;
      task.status = 'needs_input';
      task.phase = 'needs_input';
      task.activeItem = null;
      emit({
        type: 'task.needs_input',
        phase: 'needs_input',
        data: { previous, reason, question },
      });
      return true;
    });
  }
}
