import { clone } from './stable.js';

export class SequenceGapError extends Error {
  constructor(expected, actual) {
    super(`Runtime event sequence gap: expected ${expected}, received ${actual}`);
    this.name = 'SequenceGapError';
    this.expected = expected;
    this.actual = actual;
  }
}

const KNOWN_PASSIVE_EVENTS = new Set([
  'plan.updated',
  'item.started',
  'item.completed',
  'item.failed',
  'context.compacted',
  'progress.stalled',
  'task.steered',
  'task.input_rebound',
]);

export class EventConsumer {
  constructor({
    store,
    runtimeClient,
    ports,
    usageIngestion,
    artifactDelivery,
    finalizer,
    activeTaskStore = null,
  }) {
    this.store = store;
    this.runtimeClient = runtimeClient;
    this.ports = ports;
    this.usageIngestion = usageIngestion;
    this.artifactDelivery = artifactDelivery;
    this.finalizer = finalizer;
    this.activeTaskStore = activeTaskStore;
  }

  async consume(deliveryId) {
    let delivery = await this.store.get(deliveryId);
    if (!delivery.taskId) {
      return delivery;
    }
    let activeTask = await this.#getActiveTask(delivery);
    const after = activeTask?.latestSequence ?? delivery.lastSequence;
    const batch = await this.runtimeClient.getEvents(delivery.taskId, after);
    for (const event of batch.events ?? []) {
      delivery = await this.store.get(deliveryId);
      activeTask = await this.#getActiveTask(delivery);
      const currentSequence = activeTask?.latestSequence ?? delivery.lastSequence;
      if (event.sequence <= currentSequence) {
        continue;
      }
      const expected = currentSequence + 1;
      if (event.sequence !== expected) {
        throw new SequenceGapError(expected, event.sequence);
      }
      await this.#apply(delivery, event);
      if (this.activeTaskStore) {
        activeTask = await this.activeTaskStore.recordEvent(delivery.taskId, event);
        delivery = await this.#syncDelivery(delivery, activeTask);
      } else {
        delivery = await this.store.mutate(deliveryId, (draft) => {
          draft.lastSequence = event.sequence;
        });
      }
    }
    activeTask = await this.#getActiveTask(delivery);
    if (activeTask) {
      delivery = await this.#syncDelivery(delivery, activeTask);
      if (activeTask.status === 'completed') {
        const runtimeTask = await this.runtimeClient.getTask(delivery.taskId);
        return this.finalizer.complete(deliveryId, runtimeTask);
      }
      if (activeTask.status === 'failed') {
        return this.finalizer.terminal(deliveryId, 'failed', '文件任务执行失败。');
      }
      if (activeTask.status === 'canceled') {
        return this.finalizer.terminal(deliveryId, 'canceled', '文件任务已取消。');
      }
    }
    return delivery;
  }

  async #getActiveTask(delivery) {
    if (!this.activeTaskStore || !delivery?.taskId) {
      return null;
    }
    return this.activeTaskStore.getByTaskId(delivery.taskId);
  }

  async #syncDelivery(delivery, activeTask) {
    return this.store.mutate(delivery.deliveryId, (draft) => {
      draft.activeTaskId = activeTask.activeTaskId;
      draft.lastSequence = activeTask.latestSequence;
      draft.runtimePhase = activeTask.runtimePhase;
      draft.usageReceipts = clone(activeTask.usageReceipts);
      draft.artifactReceipts = clone(activeTask.artifactReceipts);
      if (activeTask.status === 'needs_input') {
        draft.status = 'needs_input';
      } else if (
        activeTask.status !== 'completed' &&
        activeTask.status !== 'failed' &&
        activeTask.status !== 'canceled' &&
        !['delivering', 'delivery_retry'].includes(draft.status)
      ) {
        draft.status = 'running';
      }
    });
  }

  async #apply(delivery, event) {
    switch (event.type) {
      case 'task.accepted':
      case 'task.phase_changed':
        await this.store.mutate(delivery.deliveryId, (draft) => {
          if (!['delivering', 'completed'].includes(draft.status)) {
            draft.status = 'running';
          }
          draft.runtimePhase = event.phase;
        });
        await this.ports.updateProgress({ delivery, event });
        return;
      case 'usage.recorded':
        await this.usageIngestion.ingest(delivery.deliveryId, event.data?.usage, {
          taskId: delivery.taskId,
        });
        return;
      case 'artifact.ready': {
        const runtimeTask = await this.runtimeClient.getTask(delivery.taskId);
        await this.artifactDelivery.deliver(
          delivery.deliveryId,
          event.data?.artifact,
          runtimeTask,
          { taskId: delivery.taskId },
        );
        return;
      }
      case 'task.needs_input':
        await this.ports.saveNeedsInput({
          delivery,
          question: event.data?.question ?? '需要补充文件处理要求。',
        });
        await this.store.mutate(delivery.deliveryId, (draft) => {
          draft.status = 'needs_input';
        });
        return;
      case 'task.completed': {
        const runtimeTask = await this.runtimeClient.getTask(delivery.taskId);
        await this.finalizer.complete(delivery.deliveryId, runtimeTask);
        return;
      }
      case 'task.failed':
        await this.finalizer.terminal(
          delivery.deliveryId,
          'failed',
          event.data?.error?.message ?? '文件任务执行失败。',
        );
        return;
      case 'task.canceled':
        await this.finalizer.terminal(delivery.deliveryId, 'canceled', '文件任务已取消。');
        return;
      default:
        if (KNOWN_PASSIVE_EVENTS.has(event.type)) {
          return;
        }
        if (event.type?.startsWith('task.')) {
          throw new Error(`Unknown terminal Runtime event: ${event.type}`);
        }
    }
  }
}
