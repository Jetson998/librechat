import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  canTransition,
  DOCX_MIME,
  isTerminal,
  SUPPORTED_TASK_CONTRACT_VERSIONS,
  TASK_CONTRACT_VERSION_V1_1,
  WORD_CAPABILITY_PROFILE,
} from './constants.js';
import { assertExecutorAdapter, isAbortError } from './executor-adapter.js';
import { buildProgressVector, evaluateProgress, repairActionSignature } from './progress-evaluator.js';
import { assertProviderAdapter } from './provider-adapter.js';
import { normalizeVerificationResult, verificationFingerprint } from './verification-result.js';
import { normalizeWordAcceptanceAssertions } from './word-acceptance.js';

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
  if (!SUPPORTED_TASK_CONTRACT_VERSIONS.has(manifest.taskContractVersion)) {
    throw new TypeError(`Unsupported task contract version: ${manifest.taskContractVersion}`);
  }
  const capabilityProfile = manifest.model?.capabilityProfile;
  const hasDocxInput = Array.isArray(manifest.inputs)
    && manifest.inputs.some((input) => input?.mimeType === DOCX_MIME);
  if (hasDocxInput && manifest.taskContractVersion !== TASK_CONTRACT_VERSION_V1_1) {
    throw new TypeError('DOCX inputs require office-file-agent.v1.1 and the Word capability profile');
  }
  if (manifest.taskContractVersion === TASK_CONTRACT_VERSION_V1_1) {
    if (capabilityProfile !== WORD_CAPABILITY_PROFILE) {
      throw new TypeError('office-file-agent.v1.1 requires the Word capability profile');
    }
    if (
      !Array.isArray(manifest.inputs) ||
      manifest.inputs.length !== 1 ||
      manifest.inputs[0]?.mimeType !== DOCX_MIME
    ) {
      throw new TypeError('Word task contract requires exactly one DOCX input');
    }
  }
  if (capabilityProfile === WORD_CAPABILITY_PROFILE && manifest.taskContractVersion !== TASK_CONTRACT_VERSION_V1_1) {
    throw new TypeError('The Word capability profile requires office-file-agent.v1.1');
  }
  if (capabilityProfile === WORD_CAPABILITY_PROFILE) {
    normalizeWordAcceptanceAssertions(manifest.acceptanceAssertions);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

export function normalizeTaskManifest(manifest) {
  validateTaskManifest(manifest);
  const normalized = clone(manifest);
  if (normalized.model?.capabilityProfile === WORD_CAPABILITY_PROFILE) {
    normalized.acceptanceAssertions = normalizeWordAcceptanceAssertions(
      normalized.acceptanceAssertions,
    );
  }
  return deepFreeze(normalized);
}

function errorRecord(error) {
  const record = {
    name: error?.name ?? 'Error',
    code: typeof error?.code === 'string' ? error.code : 'RUNTIME_ERROR',
    retryable: error?.retryable === true,
  };
  if (typeof error?.safeSummary === 'string' && error.safeSummary.trim() !== '') {
    record.summary = error.safeSummary.trim().slice(0, 500);
  } else if (typeof error?.message === 'string' && error.message.trim() !== '') {
    record.summary = error.message.trim().slice(0, 500);
  }
  record.message = record.summary ?? record.code;
  return record;
}

function unwrapProviderValue(result) {
  return result?.value ?? result;
}

function clone(value) {
  return structuredClone(value);
}

function normalizeEnabledValues(value, name) {
  if (value == null) {
    return null;
  }
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw new TypeError(`${name} must be an array or Set when provided`);
  }
  const normalized = new Set(value);
  if (normalized.size === 0 || [...normalized].some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new TypeError(`${name} must contain one or more non-empty strings`);
  }
  return normalized;
}

function isWordTask(task) {
  return task?.manifest?.model?.capabilityProfile === WORD_CAPABILITY_PROFILE;
}

function hasCompletedWordInspection(task) {
  return Object.values(task?.itemResults ?? {}).some(
    (result) => result?.operation === 'inspect',
  );
}

function wordLedgerEntry(action, planRevision, itemId) {
  if (!['word.transform.v1', 'word.patch.v1'].includes(action?.worker)) {
    return null;
  }
  return {
    planRevision,
    itemId,
    worker: action.worker,
    parameters: clone(action.parameters),
    expectedChange: clone(action.expectedChange ?? []),
  };
}

function wordLedgerKey(entry) {
  const parameters = { ...(entry.parameters ?? {}) };
  delete parameters.expectedBaseSha256;
  return JSON.stringify({
    itemId: entry.itemId ?? null,
    worker: entry.worker,
    parameters,
    expectedChange: entry.expectedChange ?? [],
  });
}

function appendWordLedger(current, entry) {
  if (!entry) {
    return;
  }
  current.acceptanceLedger ??= [];
  const key = wordLedgerKey(entry);
  if (!current.acceptanceLedger.some((existing) => wordLedgerKey(existing) === key)) {
    current.acceptanceLedger.push(entry);
  }
}

function normalizeInputRebind(task, inputRebind) {
  if (!inputRebind || typeof inputRebind !== 'object' || Array.isArray(inputRebind)) {
    throw new TypeError('inputRebind must be an object');
  }
  if (inputRebind.schemaVersion !== '1.0') {
    throw new TypeError('inputRebind schemaVersion must be "1.0"');
  }
  if (inputRebind.taskId !== task.taskId) {
    throw new TaskStateConflictError('Input rebind taskId does not match the Runtime task');
  }
  const originalInputs = task.manifest.inputs;
  if (!Array.isArray(originalInputs) || !Array.isArray(inputRebind.inputs)) {
    throw new TypeError('Runtime task inputs are required for rebind');
  }
  if (inputRebind.inputs.length !== originalInputs.length) {
    throw new TaskStateConflictError('Input rebind must preserve the task input set');
  }
  const originalByRef = new Map(
    originalInputs.map((input) => [input.librechatFileRef, input]),
  );
  const seen = new Set();
  const rebound = inputRebind.inputs.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Each rebound input must be an object');
    }
    const original = originalByRef.get(input.librechatFileRef);
    if (!original || seen.has(input.librechatFileRef)) {
      throw new TaskStateConflictError('Input rebind must preserve authorized input references');
    }
    seen.add(input.librechatFileRef);
    if (
      input.logicalName !== original.logicalName ||
      input.sha256 !== original.sha256 ||
      input.mimeType !== original.mimeType
    ) {
      throw new TaskStateConflictError('Input rebind cannot change authorized file identity');
    }
    const originalCodeEnvRef = original.codeEnvRef;
    const codeEnvRef = input.codeEnvRef;
    if (
      !codeEnvRef ||
      codeEnvRef.kind !== originalCodeEnvRef?.kind ||
      codeEnvRef.id !== originalCodeEnvRef?.id ||
      typeof codeEnvRef.storage_session_id !== 'string' ||
      codeEnvRef.storage_session_id.trim() === '' ||
      typeof codeEnvRef.file_id !== 'string' ||
      codeEnvRef.file_id.trim() === ''
    ) {
      throw new TaskStateConflictError('Input rebind CodeAPI scope does not match the task');
    }
    return {
      ...clone(original),
      codeEnvRef: {
        ...clone(originalCodeEnvRef),
        storage_session_id: codeEnvRef.storage_session_id.trim(),
        file_id: codeEnvRef.file_id.trim(),
      },
    };
  });
  return rebound.sort((left, right) => left.librechatFileRef.localeCompare(right.librechatFileRef));
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
  #queue = [];
  #queued = new Set();
  #stopping = false;

  constructor({
    store,
    provider,
    executor,
    testHooks,
    maxConcurrentTasks = 2,
    enabledCapabilityProfiles = null,
    enabledTaskContractVersions = null,
  }) {
    if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) {
      throw new TypeError('maxConcurrentTasks must be a positive safe integer');
    }
    this.store = store;
    this.provider = assertProviderAdapter(provider);
    this.executor = assertExecutorAdapter(executor);
    this.testHooks = testHooks;
    this.maxConcurrentTasks = maxConcurrentTasks;
    this.enabledCapabilityProfiles = normalizeEnabledValues(
      enabledCapabilityProfiles,
      'enabledCapabilityProfiles',
    );
    this.enabledTaskContractVersions = normalizeEnabledValues(
      enabledTaskContractVersions,
      'enabledTaskContractVersions',
    );
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
    this.#queue = [];
    this.#queued.clear();
    for (const { controller } of this.#running.values()) {
      controller.abort(new RuntimeShutdownError());
    }
    await Promise.allSettled([...this.#running.values()].map(({ promise }) => promise));
  }

  async submit({ idempotencyKey, manifest }) {
    const normalizedManifest = normalizeTaskManifest(manifest);
    if (
      this.enabledCapabilityProfiles &&
      !this.enabledCapabilityProfiles.has(normalizedManifest.model?.capabilityProfile)
    ) {
      throw new TypeError('Capability profile is not enabled for this Runtime');
    }
    if (
      this.enabledTaskContractVersions &&
      !this.enabledTaskContractVersions.has(normalizedManifest.taskContractVersion)
    ) {
      throw new TypeError('Task contract version is not enabled for this Runtime');
    }
    const result = await this.store.createTask({
      idempotencyKey,
      manifest: normalizedManifest,
    });
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
      this.#removeQueued(taskId);
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

    const taskBeforeSteer = await this.store.requireTask(taskId);
    const reboundInputs = instruction.inputRebind
      ? normalizeInputRebind(taskBeforeSteer, instruction.inputRebind)
      : null;
    const normalized = {
      instructionId: instruction.instructionId ?? randomUUID(),
      text: instruction.text.trim(),
      createdAt: instruction.createdAt ?? new Date().toISOString(),
      ...(reboundInputs ? { inputRebind: { schemaVersion: '1.0', taskId, inputs: reboundInputs } } : {}),
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
      if (normalized.inputRebind) {
        task.manifest = {
          ...task.manifest,
          inputs: clone(normalized.inputRebind.inputs),
        };
        task.inputRebindRevision = (task.inputRebindRevision ?? 0) + 1;
        emit({
          type: 'task.input_rebound',
          data: {
            inputRebindRevision: task.inputRebindRevision,
            inputCount: normalized.inputRebind.inputs.length,
          },
        });
      }
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
    if (this.#stopping || this.#running.has(taskId) || this.#queued.has(taskId)) {
      return;
    }

    this.#queued.add(taskId);
    this.#queue.push(taskId);
    this.#drainQueue();
  }

  #removeQueued(taskId) {
    if (!this.#queued.delete(taskId)) {
      return;
    }
    this.#queue = this.#queue.filter((queuedTaskId) => queuedTaskId !== taskId);
  }

  #drainQueue() {
    while (!this.#stopping && this.#running.size < this.maxConcurrentTasks) {
      const taskId = this.#queue.shift();
      if (!taskId) {
        return;
      }
      this.#queued.delete(taskId);

      const controller = new AbortController();
      const promise = this.#runTask(taskId, controller.signal)
        .catch(() => {})
        .finally(() => {
          this.#running.delete(taskId);
          this.#drainQueue();
        });
      this.#running.set(taskId, { controller, promise });
    }
  }

  getCapacity() {
    return {
      maxConcurrentTasks: this.maxConcurrentTasks,
      runningTasks: this.#running.size,
      queuedTasks: this.#queue.length,
    };
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

    if (
      isWordTask(task) &&
      !hasCompletedWordInspection(task) &&
      plan?.needsInput !== true &&
      (
        !Array.isArray(plan?.actions) ||
        plan.actions.length !== 1 ||
        plan.actions[0]?.worker !== 'word.inspect.v1'
      )
    ) {
      throw new TypeError(
        'The initial Word plan must contain exactly one first action: word.inspect.v1',
      );
    }

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
    const actionKind = action.worker ?? action.kind ?? 'unknown';
    const actionSummary = action.summary ?? action.objective ?? `Execute ${actionKind}`;
    const shouldReplanAfterInspection = isWordTask(task)
      && !hasCompletedWordInspection(task)
      && action.worker === 'word.inspect.v1';
    await this.#runItem({
      task,
      itemId: `${task.taskId}:execute:${task.planRevision}:${cursor}`,
      kind: actionKind,
      summary: actionSummary,
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
      appendWordLedger(
        current,
        wordLedgerEntry(action, task.planRevision, `${task.taskId}:execute:${task.planRevision}:${cursor}`),
      );
      if (shouldReplanAfterInspection) {
        current.executionCursor = 0;
        current.plan = null;
        current.status = 'planning';
        current.phase = 'planning';
        return true;
      }
      current.executionCursor += 1;
      return true;
    });

    if (shouldReplanAfterInspection) {
      await this.store.mutateTask(task.taskId, (current, emit) => {
        if (current.status !== 'planning') {
          return false;
        }
        emit({
          type: 'task.phase_changed',
          phase: 'planning',
          data: { from: 'executing', to: 'planning', reason: 'word_inspection_ready' },
        });
        return true;
      });
    }
  }

  async #verify(task, signal) {
    const rawVerification = await this.#runItem({
      task,
      itemId: `${task.taskId}:verify:${task.planRevision}`,
      kind: 'artifact_verification',
      summary: `Verify plan revision ${task.planRevision}`,
      signal,
      operation: (itemId) => this.executor.verify({ itemId, task, signal }),
    });
    const verification = normalizeVerificationResult(rawVerification);

    await this.store.mutateTask(task.taskId, (current, emit) => {
      if (current.status !== 'verifying' || current.planRevision !== task.planRevision) {
        return false;
      }
      const fingerprint = verificationFingerprint(verification);
      const previousVector = current.progress.vector;
      const vector = buildProgressVector({
        phase: current.phase,
        verification,
        closedPlanNodeIds: previousVector?.closedPlanNodeIds ?? [],
        scriptHash: rawVerification?.scriptHash,
        artifactHash: rawVerification?.outputHash ?? rawVerification?.artifact?.sha256,
      });
      const progressDecision = evaluateProgress(previousVector, vector);
      current.verification = { ...verification, fingerprint };
      current.progress.vector = vector;
      if (verification.passed) {
        current.progress.stagnationCount = 0;
        current.progress.lastFailedVerificationFingerprint = null;
      } else if (
        !progressDecision.progressed &&
        (previousVector || current.progress.lastFailedVerificationFingerprint === fingerprint)
      ) {
        current.progress.stagnationCount += 1;
        current.progress.lastFailedVerificationFingerprint = fingerprint;
        emit({
          type: 'progress.stalled',
          data: {
            fingerprint,
            reason: progressDecision.reason,
            stagnationCount: current.progress.stagnationCount,
          },
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
      const nextActionSignature = repairActionSignature(plan);
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
          persistProviderMetadata(current, emit, error?.receipt, itemId);
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
