function requiredConnector(connector) {
  if (!connector || typeof connector.reconcile !== 'function') {
    throw new TypeError('connector.reconcile is required');
  }
  if (typeof connector.reconcileAll !== 'function') {
    throw new TypeError('connector.reconcileAll is required');
  }
  return connector;
}

export class FileAgentReconciler {
  constructor({ connector, intervalMs = 1_000, onError = () => {} }) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 50) {
      throw new TypeError('intervalMs must be a safe integer of at least 50');
    }
    if (typeof onError !== 'function') {
      throw new TypeError('onError must be a function');
    }
    this.connector = requiredConnector(connector);
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.timer = null;
    this.allRun = null;
    this.deliveryRuns = new Map();
  }

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.wakeAll().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
    void this.wakeAll().catch(() => {});
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([
      ...(this.allRun ? [this.allRun] : []),
      ...this.deliveryRuns.values(),
    ]);
  }

  wake(deliveryId) {
    if (typeof deliveryId !== 'string' || deliveryId === '') {
      throw new TypeError('deliveryId is required');
    }
    const existing = this.deliveryRuns.get(deliveryId);
    if (existing) {
      return existing;
    }
    const run = Promise.resolve()
      .then(() => this.connector.reconcile(deliveryId))
      .catch((error) => {
        this.onError(error, { deliveryId });
        throw error;
      })
      .finally(() => {
        this.deliveryRuns.delete(deliveryId);
      });
    this.deliveryRuns.set(deliveryId, run);
    return run;
  }

  wakeAll() {
    if (this.allRun) {
      return this.allRun;
    }
    this.allRun = Promise.resolve()
      .then(() => this.connector.reconcileAll())
      .catch((error) => {
        this.onError(error, { all: true });
        throw error;
      })
      .finally(() => {
        this.allRun = null;
      });
    return this.allRun;
  }
}
