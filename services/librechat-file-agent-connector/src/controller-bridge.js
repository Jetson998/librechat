function requiredFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function snapshotRef(snapshot) {
  if (typeof snapshot === 'string' && snapshot.trim() !== '') {
    return snapshot.trim();
  }
  if (typeof snapshot?.snapshotId === 'string' && snapshot.snapshotId.trim() !== '') {
    return snapshot.snapshotId.trim();
  }
  throw new TypeError('createBillingSnapshot must return a snapshotId');
}

export class FileAgentHandoffError extends Error {
  constructor(message, { cause, userTurnPersisted = false } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FileAgentHandoffError';
    this.userTurnPersisted = userTurnPersisted;
  }
}

export class FileAgentControllerBridge {
  constructor({
    connector,
    prepareRequest,
    persistUserTurn,
    createBillingSnapshot,
    scheduleReconcile,
  }) {
    if (!connector || typeof connector.prepareRoute !== 'function') {
      throw new TypeError('connector.prepareRoute is required');
    }
    if (typeof connector.submit !== 'function') {
      throw new TypeError('connector.submit is required');
    }
    this.connector = connector;
    this.prepareRequest = requiredFunction(prepareRequest, 'prepareRequest');
    this.persistUserTurn = requiredFunction(persistUserTurn, 'persistUserTurn');
    this.createBillingSnapshot = requiredFunction(
      createBillingSnapshot,
      'createBillingSnapshot',
    );
    this.scheduleReconcile = requiredFunction(scheduleReconcile, 'scheduleReconcile');
  }

  async tryRoute(context) {
    const request = await this.prepareRequest(context);
    if (request?.route === 'native') {
      return {
        routed: false,
        suppressNativeAgent: false,
        decision: request,
      };
    }
    const preparedRoute = await this.connector.prepareRoute(request);
    if (preparedRoute.suppressNativeAgent !== true) {
      return {
        routed: false,
        suppressNativeAgent: false,
        decision: preparedRoute.decision,
      };
    }

    let persisted;
    try {
      persisted = await this.persistUserTurn({ ...context, request });
      if (!persisted?.userMessage || !persisted?.conversation) {
        throw new TypeError('persistUserTurn must return userMessage and conversation');
      }
      if (persisted.userMessage.messageId !== request.userMessageId) {
        throw new TypeError('Persisted user message does not match the prepared message identity');
      }
      if (persisted.conversation.conversationId !== request.conversationId) {
        throw new TypeError('Persisted conversation does not match the prepared conversation');
      }
    } catch (error) {
      throw new FileAgentHandoffError('Failed to persist the Runtime user turn', {
        cause: error,
      });
    }

    try {
      const billingSnapshot = await this.createBillingSnapshot({
        ...context,
        request,
        persisted,
      });
      const billingSnapshotRef = snapshotRef(billingSnapshot);
      const submission = await this.connector.submit(
        { ...request, billingSnapshotRef },
        { preparedRoute },
      );
      if (submission.suppressNativeAgent !== true || !submission.delivery?.deliveryId) {
        throw new Error('Connector declined a prepared Runtime route after user persistence');
      }
      let scheduleError = null;
      try {
        await this.scheduleReconcile({
          ...context,
          request: { ...request, billingSnapshotRef },
          persisted,
          submission,
        });
      } catch (error) {
        // The delivery is already durable. A periodic reconciler can resume it, so
        // scheduling failure must not complete the LibreChat job or start native Agent.
        scheduleError = { name: error.name, message: error.message };
      }
      return {
        routed: true,
        suppressNativeAgent: true,
        decision: submission.decision,
        deliveryId: submission.delivery.deliveryId,
        taskId: submission.taskId,
        pending: submission.pending === true,
        scheduleError,
        persisted,
      };
    } catch (error) {
      throw new FileAgentHandoffError('Runtime handoff failed after user turn persistence', {
        cause: error,
        userTurnPersisted: true,
      });
    }
  }
}
