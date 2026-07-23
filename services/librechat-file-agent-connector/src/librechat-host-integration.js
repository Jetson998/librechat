import { LibreChatFileAgentConnector } from './connector.js';
import { MongoBillingSnapshotStore } from './mongo-billing-snapshot-store.js';
import { MongoDeliveryStore } from './mongo-delivery-store.js';
import { NativeLibreChatPorts } from './native-ports.js';
import { FileAgentReconciler } from './reconciler.js';
import { RuntimeClient } from './runtime-client.js';
import { ServiceScopeSigner } from './service-scope.js';
import { clone } from './stable.js';

const MESSAGE_IDENTITY_FIELDS = new Set(['sender', 'endpoint', 'model', 'iconURL']);

function requiredFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function requiredCollection(value, name) {
  if (!value || typeof value.find !== 'function') {
    throw new TypeError(`${name} collection is required`);
  }
  return value;
}

function isOwnedConversationFile(file, delivery) {
  return Boolean(
      file?.file_id &&
      file.user === delivery.user &&
      file.conversationId === delivery.conversationId &&
      (file.tenantId ?? null) === (delivery.tenantId ?? null),
  );
}

function validateMessageIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('resolveMessageIdentity must return an object');
  }
  for (const field of ['sender', 'endpoint', 'model']) {
    if (typeof identity[field] !== 'string' || identity[field] === '') {
      throw new TypeError(`resolveMessageIdentity.${field} is required`);
    }
  }
  for (const field of Object.keys(identity)) {
    if (!MESSAGE_IDENTITY_FIELDS.has(field)) {
      throw new TypeError(`resolveMessageIdentity returned unsupported field: ${field}`);
    }
  }
  return identity;
}

export function createMongoTransactionIdFinder(collection) {
  requiredCollection(collection, 'transaction');
  return async ({ ids, user }) => {
    if (ids.length === 0) {
      return [];
    }
    const cursor = collection.find(
      { _id: { $in: ids }, user },
      { projection: { _id: 1 } },
    );
    return (await cursor.toArray()).map((document) => document._id);
  };
}

export function createLibreChatMessageBuilder({
  getFilesByIds,
  sanitizeFileForTransmit,
  resolveMessageIdentity,
}) {
  requiredFunction(getFilesByIds, 'getFilesByIds');
  requiredFunction(sanitizeFileForTransmit, 'sanitizeFileForTransmit');
  requiredFunction(resolveMessageIdentity, 'resolveMessageIdentity');

  return async ({ kind, delivery, text, fileIds, artifacts, billingSnapshot }) => {
    const uniqueFileIds = [...new Set(fileIds)];
    const files = uniqueFileIds.length === 0
      ? []
      : await getFilesByIds({
          fileIds: uniqueFileIds,
          userId: delivery.user,
          tenantId: delivery.tenantId,
          conversationId: delivery.conversationId,
        });
    const filesById = new Map(
      (files ?? [])
        .filter((file) => isOwnedConversationFile(file, delivery))
        .map((file) => [file.file_id, file]),
    );
    const missing = uniqueFileIds.filter((fileId) => !filesById.has(fileId));
    if (missing.length > 0) {
      throw new Error(`Generated LibreChat files not found or not owned: ${missing.join(', ')}`);
    }

    const artifactByFileId = new Map(
      (artifacts ?? []).map((artifact) => [artifact.fileId, artifact]),
    );
    const attachments = [];
    for (const fileId of uniqueFileIds) {
      const artifact = artifactByFileId.get(fileId);
      const sanitized = await sanitizeFileForTransmit(filesById.get(fileId));
      if (!sanitized || sanitized.file_id !== fileId) {
        throw new Error(`sanitizeFileForTransmit removed or changed file_id: ${fileId}`);
      }
      attachments.push({
        ...sanitized,
        messageId: delivery.assistantMessageId,
        ...(artifact?.toolCallId ? { toolCallId: artifact.toolCallId } : {}),
      });
    }

    const identity = validateMessageIdentity(
      await resolveMessageIdentity({ delivery, billingSnapshot, kind }),
    );
    return {
      ...clone(identity),
      messageId: delivery.assistantMessageId,
      conversationId: delivery.conversationId,
      parentMessageId: delivery.userMessageId,
      user: delivery.user,
      isCreatedByUser: false,
      text,
      unfinished: kind === 'needs_input',
      ...(attachments.length > 0
        ? { attachments: clone(attachments), files: clone(attachments) }
        : {}),
    };
  };
}

export function createLibreChatFinalEventBuilder({
  loadConversation,
  loadMessage,
  sanitizeMessageForTransmit,
}) {
  requiredFunction(loadConversation, 'loadConversation');
  requiredFunction(loadMessage, 'loadMessage');
  requiredFunction(sanitizeMessageForTransmit, 'sanitizeMessageForTransmit');

  return async ({ delivery }) => {
    const [conversation, userMessage, responseMessage] = await Promise.all([
      loadConversation({ userId: delivery.user, conversationId: delivery.conversationId }),
      loadMessage({
        userId: delivery.user,
        conversationId: delivery.conversationId,
        messageId: delivery.userMessageId,
      }),
      loadMessage({
        userId: delivery.user,
        conversationId: delivery.conversationId,
        messageId: delivery.assistantMessageId,
      }),
    ]);
    if (!conversation) {
      throw new Error(`LibreChat conversation not found: ${delivery.conversationId}`);
    }
    if (!userMessage) {
      throw new Error(`LibreChat user message not found: ${delivery.userMessageId}`);
    }
    if (!responseMessage) {
      throw new Error(`LibreChat assistant message not found: ${delivery.assistantMessageId}`);
    }
    const [requestMessage, transmittedResponseMessage] = await Promise.all([
      sanitizeMessageForTransmit(userMessage),
      sanitizeMessageForTransmit(responseMessage),
    ]);
    if (!requestMessage || !transmittedResponseMessage) {
      throw new Error('sanitizeMessageForTransmit must return both final-event messages');
    }
    return {
      final: true,
      conversation,
      title: conversation.title,
      requestMessage,
      responseMessage: transmittedResponseMessage,
    };
  };
}

export function createLibreChatHostIntegration({
  collections,
  runtimeClient = null,
  runtimeBaseUrl = null,
  runtimeFetch = globalThis.fetch,
  serviceScopeSecret = null,
  serviceScopeOptions = {},
  native,
  featureEnabled = false,
  allowlistedUserIds = new Set(),
  reconcilerId,
  leaseTtlMs,
  reconcileIntervalMs,
  onReconcileError,
}) {
  const deliveryCollection = requiredCollection(collections?.deliveries, 'delivery');
  const billingSnapshotCollection = requiredCollection(
    collections?.billingSnapshots,
    'billing snapshot',
  );
  const transactionCollection = requiredCollection(collections?.transactions, 'transaction');
  if (!native || typeof native !== 'object') {
    throw new TypeError('native LibreChat dependencies are required');
  }

  let resolvedRuntimeClient = runtimeClient;
  if (!resolvedRuntimeClient) {
    if (typeof runtimeBaseUrl !== 'string' || runtimeBaseUrl === '') {
      throw new TypeError('runtimeBaseUrl is required when runtimeClient is not supplied');
    }
    const scopeSigner = new ServiceScopeSigner({
      ...serviceScopeOptions,
      secret: serviceScopeSecret,
    });
    resolvedRuntimeClient = new RuntimeClient({
      baseUrl: runtimeBaseUrl,
      fetchImpl: runtimeFetch,
      scopeSigner,
    });
  }

  const deliveryStore = new MongoDeliveryStore({ collection: deliveryCollection });
  const billingSnapshotStore = new MongoBillingSnapshotStore({
    collection: billingSnapshotCollection,
  });
  const buildMessage = createLibreChatMessageBuilder({
    getFilesByIds: native.getFilesByIds,
    sanitizeFileForTransmit: native.sanitizeFileForTransmit,
    resolveMessageIdentity: native.resolveMessageIdentity,
  });
  const buildFinalEvent = createLibreChatFinalEventBuilder({
    loadConversation: native.loadConversation,
    loadMessage: native.loadMessage,
    sanitizeMessageForTransmit: native.sanitizeMessageForTransmit,
  });
  const ports = new NativeLibreChatPorts({
    billingSnapshotStore,
    prepareStructuredTokenSpend: native.prepareStructuredTokenSpend,
    bulkWriteTransactions: native.bulkWriteTransactions,
    findExistingTransactionIds: createMongoTransactionIdFinder(transactionCollection),
    transactionDbOps: native.transactionDbOps,
    processCodeOutput: native.processCodeOutput,
    saveMessage: native.saveMessage,
    generationJobManager: native.generationJobManager,
    resolveRequest: native.resolveRequest,
    buildMessage,
    buildFinalEvent,
    buildRequestContext: native.buildRequestContext,
    updateProgress: native.updateProgress,
  });
  const connector = new LibreChatFileAgentConnector({
    store: deliveryStore,
    runtimeClient: resolvedRuntimeClient,
    ports,
    featureEnabled,
    allowlistedUserIds,
    ...(reconcilerId ? { reconcilerId } : {}),
    ...(leaseTtlMs ? { leaseTtlMs } : {}),
  });
  const reconciler = new FileAgentReconciler({
    connector,
    ...(reconcileIntervalMs ? { intervalMs: reconcileIntervalMs } : {}),
    ...(onReconcileError ? { onError: onReconcileError } : {}),
  });

  const integration = {
    connector,
    reconciler,
    ports,
    runtimeClient: resolvedRuntimeClient,
    stores: { deliveryStore, billingSnapshotStore },
    async init() {
      await Promise.all([deliveryStore.init(), billingSnapshotStore.init()]);
      return integration;
    },
    async stop() {
      await reconciler.stop();
    },
  };
  return integration;
}
