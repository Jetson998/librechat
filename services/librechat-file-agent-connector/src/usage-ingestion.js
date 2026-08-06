function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

const PROVIDER_IDENTITY_FIELDS = [
  'providerRouteRef',
  'providerEndpoint',
  'providerModel',
  'providerProtocol',
  'routeConfigDigest',
  'requestedModel',
  'actualModel',
];

export class UsageIngestion {
  constructor({ store, ports, activeTaskStore = null }) {
    this.store = store;
    this.ports = ports;
    this.activeTaskStore = activeTaskStore;
  }

  async ingest(deliveryId, usage, { taskId = null } = {}) {
    const delivery = await this.store.get(deliveryId);
    const usageEventId = usage?.usageEventId;
    if (typeof usageEventId !== 'string' || usageEventId === '') {
      throw new TypeError('Runtime usageEventId is required');
    }
    const activeTask = this.activeTaskStore && taskId
      ? await this.activeTaskStore.getByTaskId(taskId)
      : null;
    if (activeTask?.usageReceipts[usageEventId] === 'completed') {
      return this.store.mutate(deliveryId, (draft) => {
        draft.usageReceipts = { ...activeTask.usageReceipts };
      });
    }
    if (delivery.usageReceipts[usageEventId] === 'completed') {
      return delivery;
    }
    if (usage.modelRouteId !== delivery.modelRouteId) {
      throw new Error('Runtime usage model route does not match the delivery billing snapshot');
    }
    const deliveryHasProviderIdentity = PROVIDER_IDENTITY_FIELDS.some((field) => delivery[field] != null);
    const usageHasProviderIdentity = PROVIDER_IDENTITY_FIELDS.some((field) => usage[field] != null);
    if (deliveryHasProviderIdentity !== usageHasProviderIdentity) {
      throw new Error('Runtime usage provider route identity presence does not match the delivery billing snapshot');
    }
    if (deliveryHasProviderIdentity) {
      for (const field of PROVIDER_IDENTITY_FIELDS) {
        if (usage[field] == null && delivery[field] == null) {
          continue;
        }
        if (typeof usage[field] !== 'string' || typeof delivery[field] !== 'string' || usage[field] !== delivery[field]) {
          throw new Error(`Runtime usage ${field} does not match the delivery billing snapshot`);
        }
      }
    }
    const normalized = {
      ...usage,
      inputTokens: nonNegativeInteger(usage.inputTokens, 'inputTokens'),
      cacheReadTokens: nonNegativeInteger(usage.cacheReadTokens, 'cacheReadTokens'),
      cacheWriteTokens: nonNegativeInteger(usage.cacheWriteTokens, 'cacheWriteTokens'),
      outputTokens: nonNegativeInteger(usage.outputTokens, 'outputTokens'),
    };
    await this.ports.writeUsageTransactions({ usageEventId, usage: normalized, delivery });
    const updatedTask = this.activeTaskStore && taskId
      ? await this.activeTaskStore.markUsageReceipt(taskId, usageEventId)
      : null;
    return this.store.mutate(deliveryId, (draft) => {
      draft.usageReceipts[usageEventId] = 'completed';
      if (updatedTask) {
        draft.usageReceipts = { ...updatedTask.usageReceipts };
      }
    });
  }
}
