import { clone, sha256 } from './stable.js';

const MESSAGE_CONTEXT = 'services/librechat-file-agent-connector/native-ports.js';

function requiredFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function normalizeExistingIds(value) {
  if (value == null) {
    return new Set();
  }
  return value instanceof Set ? value : new Set(value);
}

function stableTransactionId(usageEventId, tokenType) {
  return sha256(`file-agent-usage:${usageEventId}:${tokenType}`);
}

export class NativeLibreChatPorts {
  constructor({
    billingSnapshotStore,
    prepareStructuredTokenSpend,
    bulkWriteTransactions,
    findExistingTransactionIds,
    transactionDbOps,
    processCodeOutput,
    saveMessage,
    generationJobManager,
    resolveRequest,
    buildMessage,
    buildFinalEvent,
    buildRequestContext = ({ delivery }) => ({ userId: delivery.user }),
    updateProgress = async () => {},
  }) {
    if (!billingSnapshotStore || typeof billingSnapshotStore.get !== 'function') {
      throw new TypeError('billingSnapshotStore is required');
    }
    if (!generationJobManager || typeof generationJobManager.emitDone !== 'function') {
      throw new TypeError('generationJobManager.emitDone is required');
    }
    if (typeof generationJobManager.completeJob !== 'function') {
      throw new TypeError('generationJobManager.completeJob is required');
    }
    if (!transactionDbOps || typeof transactionDbOps !== 'object') {
      throw new TypeError('transactionDbOps is required');
    }
    this.billingSnapshotStore = billingSnapshotStore;
    this.prepareStructuredTokenSpend = requiredFunction(
      prepareStructuredTokenSpend,
      'prepareStructuredTokenSpend',
    );
    this.bulkWriteTransactions = requiredFunction(
      bulkWriteTransactions,
      'bulkWriteTransactions',
    );
    this.findExistingTransactionIds = requiredFunction(
      findExistingTransactionIds,
      'findExistingTransactionIds',
    );
    this.transactionDbOps = transactionDbOps;
    this.processNativeCodeOutput = requiredFunction(processCodeOutput, 'processCodeOutput');
    this.saveNativeMessage = requiredFunction(saveMessage, 'saveMessage');
    this.resolveRequest = requiredFunction(resolveRequest, 'resolveRequest');
    this.buildMessage = requiredFunction(buildMessage, 'buildMessage');
    this.buildFinalEvent = requiredFunction(buildFinalEvent, 'buildFinalEvent');
    this.buildRequestContext = requiredFunction(buildRequestContext, 'buildRequestContext');
    this.updateNativeProgress = requiredFunction(updateProgress, 'updateProgress');
    this.generationJobManager = generationJobManager;
  }

  async writeUsageTransactions({ usageEventId, usage, delivery }) {
    const snapshot = await this.#getBillingSnapshot(delivery);
    const prepared = this.prepareStructuredTokenSpend(
      {
        user: delivery.user,
        balance: clone(snapshot.balance),
        messageId: delivery.assistantMessageId,
        transactions: clone(snapshot.transactions),
        conversationId: delivery.conversationId,
        endpointTokenConfig: clone(snapshot.endpointTokenConfig),
        context: 'file_agent',
        model: snapshot.model,
      },
      {
        promptTokens: {
          input: usage.inputTokens,
          write: usage.cacheWriteTokens,
          read: usage.cacheReadTokens,
        },
        completionTokens: usage.outputTokens,
      },
      clone(snapshot.pricing),
    ).map((entry) => ({ ...entry, doc: { ...entry.doc } }));

    const idsByTokenType = {};
    for (const entry of prepared) {
      const tokenType = entry?.doc?.tokenType;
      if (tokenType !== 'prompt' && tokenType !== 'completion') {
        throw new Error(`Unsupported LibreChat transaction token type: ${tokenType}`);
      }
      if (idsByTokenType[tokenType]) {
        throw new Error(`Duplicate LibreChat transaction token type: ${tokenType}`);
      }
      const transactionId = stableTransactionId(usageEventId, tokenType);
      entry.doc._id = transactionId;
      idsByTokenType[tokenType] = transactionId;
    }

    const transactionIds = Object.values(idsByTokenType);
    const existingIds = normalizeExistingIds(await this.findExistingTransactionIds({
      ids: transactionIds,
      user: delivery.user,
      delivery,
    }));
    const missing = prepared.filter((entry) => !existingIds.has(entry.doc._id));
    if (missing.length > 0) {
      await this.bulkWriteTransactions(
        { user: delivery.user, docs: missing },
        this.transactionDbOps,
      );
    }
    return clone(idsByTokenType);
  }

  async processCodeOutput({ artifactId, artifact, delivery }) {
    const req = await this.resolveRequest({ delivery });
    const result = await this.processNativeCodeOutput({
      req,
      id: artifact.codeEnvRef.file_id,
      name: artifact.name,
      toolCallId: `file-agent:${artifactId}`,
      conversationId: delivery.conversationId,
      messageId: delivery.assistantMessageId,
      session_id: artifact.codeEnvRef.storage_session_id,
    });
    if (!result?.file) {
      throw new Error('processCodeOutput did not return a LibreChat file');
    }
    if (typeof result.finalize === 'function') {
      await result.finalize();
    }
    const fileId = result.file.file_id ?? result.file.fileId;
    if (typeof fileId !== 'string' || fileId === '') {
      throw new Error('processCodeOutput returned a file without file_id');
    }
    return { fileId, file: clone(result.file) };
  }

  saveAssistantMessage({ delivery, text, fileIds, artifacts = [] }) {
    return this.#saveMessage({ kind: 'completed', delivery, text, fileIds, artifacts });
  }

  saveNeedsInput({ delivery, question }) {
    return this.#saveMessage({
      kind: 'needs_input',
      delivery,
      text: question,
      fileIds: [],
      artifacts: [],
    });
  }

  saveTerminalMessage({ delivery, status, message }) {
    return this.#saveMessage({
      kind: status,
      delivery,
      text: message,
      fileIds: [],
      artifacts: [],
      status,
    });
  }

  async emitDone({ delivery, payload }) {
    const text = payload.text ?? payload.error ?? '';
    let responseMessagePromise = null;
    const getResponseMessage = () => {
      responseMessagePromise ??= this.#buildMessage({
        kind: payload.status ?? 'completed',
        delivery,
        text,
        fileIds: payload.fileIds ?? [],
        artifacts: payload.artifacts ?? [],
        status: payload.status,
      });
      return responseMessagePromise;
    };
    const finalEvent = await this.buildFinalEvent({
      delivery,
      payload: clone(payload),
      getResponseMessage,
    });
    await this.generationJobManager.emitDone(delivery.streamId, finalEvent);
  }

  async completeJob({ delivery }) {
    await this.generationJobManager.completeJob(delivery.streamId);
  }

  updateProgress(args) {
    return this.updateNativeProgress(args);
  }

  async #saveMessage({ kind, delivery, text, fileIds, artifacts, status }) {
    const req = await this.resolveRequest({ delivery });
    const requestContext = await this.buildRequestContext({ delivery, request: req });
    const message = await this.#buildMessage({
      kind,
      delivery,
      text,
      fileIds,
      artifacts,
      status,
    });
    return this.saveNativeMessage(requestContext, message, { context: MESSAGE_CONTEXT });
  }

  async #buildMessage({ kind, delivery, text, fileIds, artifacts = [], status }) {
    const snapshot = await this.#getBillingSnapshot(delivery);
    return this.buildMessage({
      kind,
      delivery,
      text,
      fileIds: [...fileIds],
      artifacts: clone(artifacts),
      status,
      billingSnapshot: clone(snapshot),
    });
  }

  async #getBillingSnapshot(delivery) {
    const snapshot = await this.billingSnapshotStore.get(delivery.billingSnapshotRef);
    if (!snapshot) {
      throw new Error(`Billing snapshot not found: ${delivery.billingSnapshotRef}`);
    }
    if (snapshot.modelRouteId !== delivery.modelRouteId) {
      throw new Error('Billing snapshot model route does not match delivery');
    }
    return snapshot;
  }
}

export { stableTransactionId };
