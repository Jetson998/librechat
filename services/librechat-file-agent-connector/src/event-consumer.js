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
]);

export class EventConsumer {
  constructor({ store, runtimeClient, ports, usageIngestion, artifactDelivery, finalizer }) {
    this.store = store;
    this.runtimeClient = runtimeClient;
    this.ports = ports;
    this.usageIngestion = usageIngestion;
    this.artifactDelivery = artifactDelivery;
    this.finalizer = finalizer;
  }

  async consume(deliveryId) {
    let delivery = await this.store.get(deliveryId);
    if (!delivery.taskId) {
      return delivery;
    }
    const batch = await this.runtimeClient.getEvents(delivery.taskId, delivery.lastSequence);
    for (const event of batch.events ?? []) {
      delivery = await this.store.get(deliveryId);
      if (event.sequence <= delivery.lastSequence) {
        continue;
      }
      const expected = delivery.lastSequence + 1;
      if (event.sequence !== expected) {
        throw new SequenceGapError(expected, event.sequence);
      }
      await this.#apply(delivery, event);
      delivery = await this.store.mutate(deliveryId, (draft) => {
        draft.lastSequence = event.sequence;
      });
    }
    return delivery;
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
        await this.usageIngestion.ingest(delivery.deliveryId, event.data?.usage);
        return;
      case 'artifact.ready': {
        const runtimeTask = await this.runtimeClient.getTask(delivery.taskId);
        await this.artifactDelivery.deliver(
          delivery.deliveryId,
          event.data?.artifact,
          runtimeTask,
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
