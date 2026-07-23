function expectedUsageIds(runtimeTask) {
  return (runtimeTask.usageRecords ?? []).map((usage) => usage.usageEventId);
}

function expectedArtifactIds(runtimeTask) {
  return (runtimeTask.result?.artifacts ?? []).map((artifact) => artifact.codeEnvRef?.file_id);
}

function ensureReceipts(delivery, runtimeTask) {
  const missingUsage = expectedUsageIds(runtimeTask)
    .filter((usageEventId) => delivery.usageReceipts[usageEventId] !== 'completed');
  const missingArtifacts = expectedArtifactIds(runtimeTask)
    .filter((artifactId) => delivery.artifactReceipts[artifactId]?.status !== 'completed');
  if (missingUsage.length > 0 || missingArtifacts.length > 0) {
    throw new Error('Runtime task cannot finalize before usage and artifact receipts complete');
  }
}

function successText(delivery) {
  const names = Object.values(delivery.artifactReceipts).map((receipt) => receipt.name);
  if (names.length === 0) {
    return '文件任务已完成。';
  }
  return `已完成文件处理并生成 ${names.join('、')}，文件已附在本条回复中，可直接下载。`;
}

export class MessageFinalizer {
  constructor({ store, ports }) {
    this.store = store;
    this.ports = ports;
  }

  async complete(deliveryId, runtimeTask) {
    let delivery = await this.store.mutate(deliveryId, (draft) => {
      if (draft.status !== 'completed') {
        draft.status = 'delivering';
      }
    });
    ensureReceipts(delivery, runtimeTask);
    const text = successText(delivery);

    if (!delivery.finalization.messageSaved) {
      const fileIds = Object.values(delivery.artifactReceipts).map((receipt) => receipt.fileId);
      await this.ports.saveAssistantMessage({
        delivery,
        text,
        fileIds,
      });
      delivery = await this.store.mutate(deliveryId, (draft) => {
        draft.finalization.messageSaved = true;
      });
    }
    if (!delivery.finalization.finalEventSaved) {
      await this.ports.emitDone({
        delivery,
        payload: {
          messageId: delivery.assistantMessageId,
          conversationId: delivery.conversationId,
          text,
          fileIds: Object.values(delivery.artifactReceipts).map((receipt) => receipt.fileId),
        },
      });
      delivery = await this.store.mutate(deliveryId, (draft) => {
        draft.finalization.finalEventSaved = true;
      });
    }
    if (!delivery.finalization.jobCompleted) {
      await this.ports.completeJob({ delivery });
      delivery = await this.store.mutate(deliveryId, (draft) => {
        draft.finalization.jobCompleted = true;
      });
    }
    return this.store.mutate(deliveryId, (draft) => {
      draft.status = 'completed';
    });
  }

  async terminal(deliveryId, status, message) {
    let delivery = await this.store.get(deliveryId);
    if (!delivery.finalization.messageSaved) {
      await this.ports.saveTerminalMessage({ delivery, status, message });
      delivery = await this.store.mutate(deliveryId, (draft) => {
        draft.finalization.messageSaved = true;
      });
    }
    if (!delivery.finalization.finalEventSaved) {
      await this.ports.emitDone({
        delivery,
        payload: {
          messageId: delivery.assistantMessageId,
          conversationId: delivery.conversationId,
          text: message,
          status,
          error: message,
          fileIds: [],
        },
      });
      delivery = await this.store.mutate(deliveryId, (draft) => {
        draft.finalization.finalEventSaved = true;
      });
    }
    if (!delivery.finalization.jobCompleted) {
      await this.ports.completeJob({ delivery });
      await this.store.mutate(deliveryId, (draft) => {
        draft.finalization.jobCompleted = true;
      });
    }
    return this.store.mutate(deliveryId, (draft) => {
      draft.status = status;
    });
  }
}
