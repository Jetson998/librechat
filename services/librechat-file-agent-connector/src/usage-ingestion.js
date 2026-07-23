function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export class UsageIngestion {
  constructor({ store, ports }) {
    this.store = store;
    this.ports = ports;
  }

  async ingest(deliveryId, usage) {
    const delivery = await this.store.get(deliveryId);
    const usageEventId = usage?.usageEventId;
    if (typeof usageEventId !== 'string' || usageEventId === '') {
      throw new TypeError('Runtime usageEventId is required');
    }
    if (delivery.usageReceipts[usageEventId] === 'completed') {
      return delivery;
    }
    if (usage.modelRouteId !== delivery.modelRouteId) {
      throw new Error('Runtime usage model route does not match the delivery billing snapshot');
    }
    const normalized = {
      ...usage,
      inputTokens: nonNegativeInteger(usage.inputTokens, 'inputTokens'),
      cacheReadTokens: nonNegativeInteger(usage.cacheReadTokens, 'cacheReadTokens'),
      cacheWriteTokens: nonNegativeInteger(usage.cacheWriteTokens, 'cacheWriteTokens'),
      outputTokens: nonNegativeInteger(usage.outputTokens, 'outputTokens'),
    };
    await this.ports.writeUsageTransactions({ usageEventId, usage: normalized, delivery });
    return this.store.mutate(deliveryId, (draft) => {
      draft.usageReceipts[usageEventId] = 'completed';
    });
  }
}
