import { randomUUID } from 'node:crypto';

import { ArtifactDelivery, ArtifactPolicyError } from './artifact-delivery.js';
import { EventConsumer } from './event-consumer.js';
import { MessageFinalizer } from './message-finalizer.js';
import { buildTaskSubmission } from './task-manifest-builder.js';
import {
  decideFileAgentCandidate,
  decideFileAgentCapabilityRoute,
  decideFileAgentPreflight,
  decideFileAgentRoute,
} from './task-router.js';
import { UsageIngestion } from './usage-ingestion.js';
import { buildRebindTurn, buildSteerTurn } from './turn-delivery.js';
import { clone, digestJson, opaqueRef, requiredString } from './stable.js';
import { ActiveTaskSelectionRequiredError } from './active-task-store.js';

function routeKey(request) {
  return digestJson({
    userId: request.userId,
    tenantId: request.tenantId ?? null,
    conversationId: request.conversationId,
    userMessageId: request.userMessageId,
    assistantMessageId: request.assistantMessageId,
    streamId: request.streamId,
    instruction: request.instruction,
    files: request.files,
    sessionId: request.sessionId,
    modelRouteId: request.modelRouteId,
    providerRouteRef: request.providerRouteRef ?? null,
    providerEndpoint: request.providerEndpoint ?? null,
    providerModel: request.providerModel ?? null,
    providerProtocol: request.providerProtocol ?? null,
    capabilityProfile: request.capabilityProfile,
    acceptance: request.acceptance,
    acceptanceAssertions: request.acceptanceAssertions,
    limits: request.limits,
  });
}

export class LibreChatFileAgentConnector {
  constructor({
    store,
    runtimeClient,
    ports,
    featureEnabled = false,
    allowlistedUserIds = new Set(),
    reconcilerId = randomUUID(),
    leaseTtlMs = 30_000,
    activeTaskStore = null,
  }) {
    this.store = store;
    this.runtimeClient = runtimeClient;
    this.ports = ports;
    this.featureEnabled = featureEnabled;
    this.allowlistedUserIds = allowlistedUserIds;
    this.reconcilerId = reconcilerId;
    this.leaseTtlMs = leaseTtlMs;
    if (activeTaskStore && (
      typeof activeTaskStore.getByTaskId !== 'function' ||
      typeof activeTaskStore.create !== 'function' ||
      typeof activeTaskStore.attachTurn !== 'function' ||
      typeof activeTaskStore.recordEvent !== 'function' ||
      typeof activeTaskStore.markUsageReceipt !== 'function' ||
      typeof activeTaskStore.markArtifactReceipt !== 'function' ||
      typeof activeTaskStore.get !== 'function' ||
      typeof activeTaskStore.listActive !== 'function' ||
      typeof activeTaskStore.mutateByTaskId !== 'function'
    )) {
      throw new TypeError('activeTaskStore must implement the task binding contract');
    }
    this.activeTaskStore = activeTaskStore;
    this.preparedRoutes = new WeakMap();
    const finalizer = new MessageFinalizer({ store, ports });
    this.finalizer = finalizer;
    this.consumer = new EventConsumer({
      store,
      runtimeClient,
      ports,
      usageIngestion: new UsageIngestion({ store, ports, activeTaskStore }),
      artifactDelivery: new ArtifactDelivery({ store, ports, activeTaskStore }),
      finalizer,
      activeTaskStore,
    });
  }

  async prepareRoute(request) {
    const candidate = decideFileAgentCandidate({
      ...request,
      featureEnabled: this.featureEnabled,
      allowlistedUserIds: this.allowlistedUserIds,
    });
    if (candidate.route !== 'candidate') {
      return { suppressNativeAgent: false, decision: candidate };
    }
    const capabilities = await this.runtimeClient.discoverCapabilities();
    const decision = decideFileAgentCapabilityRoute({
      ...request,
      capabilities,
    });
    if (decision.route !== 'runtime') {
      return { suppressNativeAgent: false, decision };
    }
    const prepared = Object.freeze({
      suppressNativeAgent: true,
      decision,
    });
    this.preparedRoutes.set(prepared, {
      capabilities,
      routeKey: routeKey(request),
    });
    return prepared;
  }

  async submit(request, { preparedRoute = null } = {}) {
    const preflight = decideFileAgentPreflight({
      ...request,
      featureEnabled: this.featureEnabled,
      allowlistedUserIds: this.allowlistedUserIds,
    });
    if (preflight.route !== 'candidate') {
      return { accepted: false, suppressNativeAgent: false, decision: preflight };
    }
    let capabilities;
    if (preparedRoute != null) {
      const prepared = this.preparedRoutes.get(preparedRoute);
      if (!prepared) {
        throw new TypeError('preparedRoute was not created by this connector');
      }
      if (prepared.routeKey !== routeKey(request)) {
        throw new TypeError('Runtime route inputs changed after preparation');
      }
      capabilities = prepared.capabilities;
    } else {
      capabilities = await this.runtimeClient.discoverCapabilities();
    }
    const decision = decideFileAgentRoute({
      ...request,
      featureEnabled: this.featureEnabled,
      allowlistedUserIds: this.allowlistedUserIds,
      capabilities,
    });
    if (decision.route !== 'runtime') {
      return { accepted: false, suppressNativeAgent: false, decision };
    }
    const submission = buildTaskSubmission(request);
    const created = await this.store.createOrGet({
      ...submission,
      record: {
        taskContractVersion: submission.manifest.taskContractVersion,
        user: request.userId,
        tenantId: request.tenantId ?? null,
        conversationId: request.conversationId,
        userMessageId: request.userMessageId,
        assistantMessageId: request.assistantMessageId,
        streamId: request.streamId,
        billingSnapshotRef: request.billingSnapshotRef,
        modelRouteId: request.modelRouteId,
        providerRouteRef: request.providerRouteRef,
        providerEndpoint: request.providerEndpoint,
        providerModel: request.providerModel,
        providerProtocol: request.providerProtocol,
        capabilityProfile: submission.manifest.model.capabilityProfile,
        inputRefs: submission.manifest.inputs,
        allowedOutputMimeTypes: [...capabilities.outputMimeTypes],
        maxVisibleArtifacts: submission.manifest.limits.maxVisibleArtifacts,
      },
    });
    let delivery = created.delivery;
    if (!delivery.taskId) {
      try {
        delivery = await this.#submitDelivery(delivery.deliveryId);
      } catch (error) {
        delivery = await this.store.get(delivery.deliveryId);
        return {
          accepted: false,
          pending: true,
          suppressNativeAgent: true,
          decision,
          delivery,
          taskId: delivery.taskId ?? null,
          error: { name: error.name, message: error.message },
        };
      }
    } else if (this.activeTaskStore) {
      delivery = await this.#ensureActiveTask(delivery);
    }
    return {
      accepted: Boolean(delivery.taskId),
      suppressNativeAgent: true,
      decision,
      delivery,
      taskId: delivery.taskId,
    };
  }

  async reconcile(deliveryId) {
    let delivery = await this.store.get(deliveryId);
    if (delivery.status === 'submitting' && !delivery.taskId) {
      delivery = await this.#submitDelivery(deliveryId);
    }
    if (this.activeTaskStore && delivery.taskId) {
      delivery = await this.#ensureActiveTask(delivery);
    }
    try {
      return await this.consumer.consume(deliveryId);
    } catch (error) {
      if (error instanceof ArtifactPolicyError) {
        return this.finalizer.terminal(deliveryId, 'delivery_failed', error.message);
      }
      await this.store.mutate(deliveryId, (draft) => {
        draft.status = 'delivery_retry';
        draft.retry.attempts += 1;
        draft.retry.lastErrorCode = error.name;
        draft.retry.nextAt = new Date(Date.now() + Math.min(60_000, 2 ** draft.retry.attempts * 1000))
          .toISOString();
      });
      throw error;
    }
  }

  async reconcileAll() {
    const deliveries = await this.store.listRecoverable();
    const results = [];
    for (const delivery of deliveries) {
      if (delivery.status === 'needs_input') {
        results.push(delivery);
        continue;
      }
      if (delivery.retry.nextAt && new Date(delivery.retry.nextAt).getTime() > Date.now()) {
        results.push(delivery);
        continue;
      }
      let leased = null;
      if (typeof this.store.acquireLease === 'function') {
        leased = await this.store.acquireLease(delivery.deliveryId, {
          owner: this.reconcilerId,
          ttlMs: this.leaseTtlMs,
        });
        if (!leased) {
          results.push(delivery);
          continue;
        }
      }
      try {
        results.push(await this.reconcile(delivery.deliveryId));
      } catch (error) {
        results.push({ deliveryId: delivery.deliveryId, error: error.message });
      } finally {
        if (leased && typeof this.store.releaseLease === 'function') {
          await this.store.releaseLease(delivery.deliveryId, this.reconcilerId);
        }
      }
    }
    return results;
  }

  async cancel(deliveryId) {
    const delivery = await this.store.get(deliveryId);
    if (!delivery?.taskId) {
      throw new Error('Cannot cancel a delivery before Runtime acceptance');
    }
    if (this.activeTaskStore) {
      await this.#ensureActiveTask(delivery);
    }
    await this.runtimeClient.cancel(delivery.taskId);
    return this.consumer.consume(deliveryId);
  }

  async steer(deliveryId, { instructionId = randomUUID(), text }) {
    return this.steerTurn(deliveryId, { instructionId, text });
  }

  async steerTurn(deliveryId, {
    instructionId = randomUUID(),
    text,
    inputRebind = null,
  }) {
    const delivery = await this.store.get(deliveryId);
    if (!delivery?.taskId) {
      throw new Error('Cannot steer a delivery before Runtime acceptance');
    }
    if (this.activeTaskStore) {
      await this.#ensureActiveTask(delivery);
    }
    const instruction = {
      instructionId,
      text,
      ...(inputRebind ? { inputRebind: clone(inputRebind) } : {}),
    };
    await this.runtimeClient.steer(delivery.taskId, instruction, {
      idempotencyKey: delivery.submission?.idempotencyKey,
    });
    if (this.activeTaskStore && inputRebind) {
      await this.activeTaskStore.mutateByTaskId(delivery.taskId, (draft) => {
        draft.inputRefs = clone(inputRebind.inputs);
        return true;
      });
    }
    await this.store.mutate(deliveryId, (draft) => {
      if (draft.status === 'needs_input') {
        draft.status = 'running';
      }
      draft.steer = {
        instructionId,
        submitted: true,
      };
    });
    return { instructionId, delivery: await this.consumer.consume(deliveryId) };
  }

  async listActiveTasks({ userId, tenantId = null, conversationId }) {
    if (!this.activeTaskStore) {
      return [];
    }
    return this.activeTaskStore.listActive({
      user: requiredString(userId, 'userId'),
      tenantId,
      conversationId: requiredString(conversationId, 'conversationId'),
    });
  }

  async submitTurn(request, { activeTaskId = null, taskId = null } = {}) {
    if (!this.activeTaskStore) {
      throw new Error('activeTaskStore is required for cross-turn task routing');
    }
    const activeTask = await this.#resolveActiveTask({
      userId: request.userId,
      tenantId: request.tenantId ?? null,
      conversationId: request.conversationId,
      activeTaskId,
      taskId,
    });
    const descriptor = buildSteerTurn({
      activeTask,
      userId: request.userId,
      tenantId: request.tenantId ?? null,
      conversationId: request.conversationId,
      userMessageId: request.userMessageId,
      assistantMessageId: request.assistantMessageId,
      streamId: request.streamId,
      instructionId: request.instructionId,
      instruction: request.instruction,
      billingSnapshotRef: request.billingSnapshotRef,
      modelRouteId: request.modelRouteId,
    });
    const created = await this.store.createOrGet({
      idempotencyKey: descriptor.idempotencyKey,
      manifest: descriptor.manifest,
      record: descriptor.record,
    });
    let delivery = created.delivery;
    descriptor.turn.deliveryId = delivery.deliveryId;
    delivery = await this.#ensureActiveTask(delivery, activeTask);
    const steered = await this.steerTurn(delivery.deliveryId, {
      instructionId: descriptor.instruction.instructionId,
      text: descriptor.instruction.text,
    });
    return {
      accepted: true,
      suppressNativeAgent: true,
      turnType: 'steer',
      decision: { route: 'runtime', reason: 'active_runtime_task_turn' },
      activeTask: await this.activeTaskStore.getByTaskId(activeTask.taskId),
      delivery: steered.delivery,
      taskId: activeTask.taskId,
    };
  }

  async rebindTurn(request, { activeTaskId = null, taskId = null } = {}) {
    if (!this.activeTaskStore) {
      throw new Error('activeTaskStore is required for cross-turn task routing');
    }
    const activeTask = await this.#resolveActiveTask({
      userId: request.userId,
      tenantId: request.tenantId ?? null,
      conversationId: request.conversationId,
      activeTaskId,
      taskId,
    });
    const descriptor = buildRebindTurn({
      activeTask,
      userId: request.userId,
      tenantId: request.tenantId ?? null,
      conversationId: request.conversationId,
      userMessageId: request.userMessageId,
      assistantMessageId: request.assistantMessageId,
      streamId: request.streamId,
      instructionId: request.instructionId,
      instruction: request.instruction,
      files: request.files,
    });
    const created = await this.store.createOrGet({
      idempotencyKey: descriptor.idempotencyKey,
      manifest: descriptor.manifest,
      record: descriptor.record,
    });
    let delivery = created.delivery;
    descriptor.turn.deliveryId = delivery.deliveryId;
    delivery = await this.#ensureActiveTask(delivery, activeTask);
    const steered = await this.steerTurn(delivery.deliveryId, descriptor.instruction);
    return {
      accepted: true,
      suppressNativeAgent: true,
      turnType: 'rebind',
      decision: { route: 'runtime', reason: 'active_runtime_task_rebind' },
      activeTask: await this.activeTaskStore.getByTaskId(activeTask.taskId),
      delivery: steered.delivery,
      taskId: activeTask.taskId,
    };
  }

  async #submitDelivery(deliveryId) {
    const delivery = await this.store.get(deliveryId);
    try {
      const submitted = await this.runtimeClient.submit(delivery.submission);
      const updated = await this.store.mutate(deliveryId, (draft) => {
        draft.taskId = submitted.task.taskId;
        draft.status = 'running';
        draft.retry.lastErrorCode = null;
      });
      return this.#ensureActiveTask(updated, submitted.task);
    } catch (error) {
      await this.store.mutate(deliveryId, (draft) => {
        draft.retry.attempts += 1;
        draft.retry.lastErrorCode = error.name;
      });
      throw error;
    }
  }

  async #resolveActiveTask({
    userId,
    tenantId,
    conversationId,
    activeTaskId,
    taskId,
  }) {
    const scope = {
      user: requiredString(userId, 'userId'),
      tenantId,
      conversationId: requiredString(conversationId, 'conversationId'),
    };
    if (activeTaskId) {
      const candidate = await this.activeTaskStore.get(activeTaskId);
      if (!candidate) {
        throw new Error(`Active Runtime task not found: ${activeTaskId}`);
      }
      this.#assertActiveTaskScope(candidate, scope);
      return candidate;
    }
    if (taskId) {
      const candidate = await this.activeTaskStore.getByTaskId(taskId);
      if (!candidate) {
        throw new Error(`Active Runtime task not found: ${taskId}`);
      }
      this.#assertActiveTaskScope(candidate, scope);
      return candidate;
    }
    const candidates = await this.activeTaskStore.listActive(scope);
    if (candidates.length === 0) {
      throw new Error(`No active Runtime task for conversation: ${scope.conversationId}`);
    }
    if (candidates.length > 1) {
      throw new ActiveTaskSelectionRequiredError(candidates);
    }
    return candidates[0];
  }

  #assertActiveTaskScope(activeTask, scope) {
    if (
      activeTask.user !== scope.user ||
      (activeTask.tenantId ?? null) !== (scope.tenantId ?? null) ||
      activeTask.conversationId !== scope.conversationId
    ) {
      const error = new Error('Runtime task is owned by a different user, tenant, or conversation');
      error.name = 'ActiveTaskConflictError';
      error.statusCode = 409;
      throw error;
    }
  }

  async #ensureActiveTask(delivery, runtimeTask = null) {
    if (!this.activeTaskStore || !delivery?.taskId) {
      return delivery;
    }
    let activeTask = await this.activeTaskStore.getByTaskId(delivery.taskId);
    const turn = {
      deliveryId: delivery.deliveryId,
      userMessageId: delivery.userMessageId,
      assistantMessageId: delivery.assistantMessageId,
      streamId: delivery.streamId,
      turnType: delivery.turnType ?? 'submit',
    };
    if (!activeTask) {
      const manifest = runtimeTask?.manifest ?? delivery.submission?.manifest ?? {};
      const workspaceSeed = `${delivery.taskId}:${manifest.execution?.sessionId ?? 'session'}`;
      const created = await this.activeTaskStore.create({
        taskId: delivery.taskId,
        user: delivery.user,
        tenantId: delivery.tenantId ?? null,
        conversationId: delivery.conversationId,
        taskContractVersion: delivery.taskContractVersion,
        capabilityProfile: delivery.capabilityProfile ?? manifest.model?.capabilityProfile ?? 'unknown',
        billingSnapshotRef: delivery.billingSnapshotRef,
        modelRouteId: delivery.modelRouteId,
        providerRouteRef: delivery.providerRouteRef,
        providerEndpoint: delivery.providerEndpoint,
        providerModel: delivery.providerModel,
        providerProtocol: delivery.providerProtocol,
        workspaceRef: opaqueRef('workspace', workspaceSeed),
        inputRefs: manifest.inputs ?? delivery.inputRefs ?? [],
        allowedOutputMimeTypes: delivery.allowedOutputMimeTypes ?? [],
        maxVisibleArtifacts: delivery.maxVisibleArtifacts ?? 1,
        runtimePhase: runtimeTask?.phase ?? runtimeTask?.status ?? 'accepted',
        turn,
      });
      activeTask = created.activeTask;
    } else {
      this.#assertActiveTaskScope(activeTask, {
        user: delivery.user,
        tenantId: delivery.tenantId ?? null,
        conversationId: delivery.conversationId,
      });
      for (const field of [
        'taskContractVersion',
        'capabilityProfile',
        'billingSnapshotRef',
        'modelRouteId',
        'providerRouteRef',
        'providerEndpoint',
        'providerModel',
        'providerProtocol',
      ]) {
        if (delivery[field] && delivery[field] !== activeTask[field]) {
          const error = new Error(`Runtime task ${field} does not match the bound task`);
          error.name = 'ActiveTaskConflictError';
          error.statusCode = 409;
          throw error;
        }
      }
      if (!activeTask.turnDeliveryIds.includes(delivery.deliveryId)) {
        activeTask = await this.activeTaskStore.attachTurn({
          taskId: delivery.taskId,
          scope: {
            user: delivery.user,
            tenantId: delivery.tenantId ?? null,
            conversationId: delivery.conversationId,
          },
          turn,
        });
      }
    }
    return this.store.mutate(delivery.deliveryId, (draft) => {
      draft.activeTaskId = activeTask.activeTaskId;
      draft.lastSequence = activeTask.latestSequence;
      draft.usageReceipts = clone(activeTask.usageReceipts);
      draft.artifactReceipts = clone(activeTask.artifactReceipts);
      draft.runtimePhase = activeTask.runtimePhase;
    });
  }
}
