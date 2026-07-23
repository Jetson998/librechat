import { randomUUID } from 'node:crypto';

import { ArtifactDelivery, ArtifactPolicyError } from './artifact-delivery.js';
import { EventConsumer } from './event-consumer.js';
import { MessageFinalizer } from './message-finalizer.js';
import { buildTaskSubmission } from './task-manifest-builder.js';
import { decideFileAgentPreflight, decideFileAgentRoute } from './task-router.js';
import { UsageIngestion } from './usage-ingestion.js';

export class LibreChatFileAgentConnector {
  constructor({ store, runtimeClient, ports, featureEnabled = false, allowlistedUserIds = new Set() }) {
    this.store = store;
    this.runtimeClient = runtimeClient;
    this.ports = ports;
    this.featureEnabled = featureEnabled;
    this.allowlistedUserIds = allowlistedUserIds;
    const finalizer = new MessageFinalizer({ store, ports });
    this.finalizer = finalizer;
    this.consumer = new EventConsumer({
      store,
      runtimeClient,
      ports,
      usageIngestion: new UsageIngestion({ store, ports }),
      artifactDelivery: new ArtifactDelivery({ store, ports }),
      finalizer,
    });
  }

  async submit(request) {
    const preflight = decideFileAgentPreflight({
      ...request,
      featureEnabled: this.featureEnabled,
      allowlistedUserIds: this.allowlistedUserIds,
    });
    if (preflight.route !== 'candidate') {
      return { accepted: false, suppressNativeAgent: false, decision: preflight };
    }
    const capabilities = await this.runtimeClient.discoverCapabilities();
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
          taskId: null,
          error: { name: error.name, message: error.message },
        };
      }
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
      try {
        results.push(await this.reconcile(delivery.deliveryId));
      } catch (error) {
        results.push({ deliveryId: delivery.deliveryId, error: error.message });
      }
    }
    return results;
  }

  async cancel(deliveryId) {
    const delivery = await this.store.get(deliveryId);
    if (!delivery?.taskId) {
      throw new Error('Cannot cancel a delivery before Runtime acceptance');
    }
    await this.runtimeClient.cancel(delivery.taskId);
    return this.consumer.consume(deliveryId);
  }

  async steer(deliveryId, { instructionId = randomUUID(), text }) {
    const delivery = await this.store.get(deliveryId);
    if (!delivery?.taskId) {
      throw new Error('Cannot steer a delivery before Runtime acceptance');
    }
    await this.runtimeClient.steer(delivery.taskId, { instructionId, text });
    await this.store.mutate(deliveryId, (draft) => {
      if (draft.status === 'needs_input') {
        draft.status = 'running';
      }
    });
    return { instructionId, delivery: await this.consumer.consume(deliveryId) };
  }

  async #submitDelivery(deliveryId) {
    const delivery = await this.store.get(deliveryId);
    try {
      const submitted = await this.runtimeClient.submit(delivery.submission);
      return this.store.mutate(deliveryId, (draft) => {
        draft.taskId = submitted.task.taskId;
        draft.status = 'running';
        draft.retry.lastErrorCode = null;
      });
    } catch (error) {
      await this.store.mutate(deliveryId, (draft) => {
        draft.retry.attempts += 1;
        draft.retry.lastErrorCode = error.name;
      });
      throw error;
    }
  }
}
