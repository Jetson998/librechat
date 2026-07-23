const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const INSTALLER_SYMBOL = Symbol.for('@jetson998/librechat-file-agent-host-installer/v1');

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function notify(message) {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

async function install(config, { app, appConfig }) {
  const upstreamRoot = path.resolve(requiredString(config.upstreamRoot, 'upstreamRoot'));
  const repositoryRoot = path.resolve(requiredString(config.repositoryRoot, 'repositoryRoot'));
  const requireUpstream = createRequire(path.join(upstreamRoot, 'package.json'));
  requireUpstream('module-alias')({ base: path.join(upstreamRoot, 'api') });

  const mongoose = requireUpstream('mongoose');
  const api = requireUpstream('@librechat/api');
  const db = requireUpstream(path.join(upstreamRoot, 'api/models'));
  const { getAppConfig } = requireUpstream(
    path.join(upstreamRoot, 'api/server/services/Config'),
  );
  const { processCodeOutput } = requireUpstream(
    path.join(upstreamRoot, 'api/server/services/Files/Code/process'),
  );
  const connector = await import(
    pathToFileURL(path.join(repositoryRoot, 'services/librechat-file-agent-connector/src/index.js'))
  );

  const database = mongoose.connection.db;
  if (!database) {
    throw new Error('LibreChat Mongo database is not connected');
  }
  const collections = connector.createUpstreamMongoCollections({
    database,
    deliveryCollectionName: requiredString(
      config.deliveryCollectionName,
      'deliveryCollectionName',
    ),
    billingSnapshotCollectionName: requiredString(
      config.billingSnapshotCollectionName,
      'billingSnapshotCollectionName',
    ),
    transactionCollectionName: 'transactions',
  });

  const resolveRequest = async ({ delivery }) => {
    const resolvedConfig = await getAppConfig({
      userId: delivery.user,
      tenantId: delivery.tenantId ?? undefined,
    }).catch(() => appConfig);
    return {
      app,
      config: resolvedConfig ?? appConfig,
      user: {
        id: delivery.user,
        _id: delivery.user,
        tenantId: delivery.tenantId ?? undefined,
        role: 'USER',
      },
    };
  };

  const native = {
    prepareStructuredTokenSpend: api.prepareStructuredTokenSpend,
    bulkWriteTransactions: api.bulkWriteTransactions,
    transactionDbOps: {
      insertMany: db.bulkInsertTransactions,
      updateBalance: db.updateBalance,
    },
    processCodeOutput,
    saveMessage: db.saveMessage,
    generationJobManager: {
      emitDone: async (streamId, event) => {
        const job = await api.GenerationJobManager.getJob(streamId);
        notify({
          type: 'file-agent-emit-done',
          streamId,
          listenerCount: job?.emitter?.listenerCount?.('chunk') ?? 0,
        });
        return api.GenerationJobManager.emitDone(streamId, event);
      },
      completeJob: (streamId, error) => api.GenerationJobManager.completeJob(streamId, error),
    },
    resolveRequest,
    buildRequestContext: ({ delivery, request }) => ({
      userId: delivery.user,
      interfaceConfig: request.config?.interfaceConfig,
    }),
    updateProgress: async () => {},
    getFilesByIds: ({ fileIds, userId, tenantId, conversationId }) =>
      db.getFiles({
        file_id: { $in: fileIds },
        user: userId,
        conversationId,
        ...(tenantId != null ? { tenantId } : {}),
      }),
    createTransactionId: (stableId) => new mongoose.Types.ObjectId(stableId.slice(0, 24)),
    findExistingTransactionIds: async ({ ids, user }) => {
      const documents = await collections.transactions
        .find(
          {
            _id: { $in: ids },
            user: new mongoose.Types.ObjectId(user),
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      return documents.map((document) => document._id);
    },
    sanitizeFileForTransmit: api.sanitizeFileForTransmit,
    resolveMessageIdentity: ({ billingSnapshot }) => billingSnapshot.messageIdentity,
    loadConversation: ({ userId, conversationId }) => db.getConvo(userId, conversationId),
    loadMessage: async ({ userId, conversationId, messageId }) => {
      const message = await db.getMessage({ user: userId, messageId });
      return message?.conversationId === conversationId ? message : null;
    },
    sanitizeMessageForTransmit: api.sanitizeMessageForTransmit,
  };

  const integration = connector.createLibreChatHostIntegration({
    collections,
    runtimeBaseUrl: requiredString(config.runtimeBaseUrl, 'runtimeBaseUrl'),
    serviceScopeSecret: requiredString(config.serviceScopeSecret, 'serviceScopeSecret'),
    native,
    featureEnabled: true,
    allowlistedUserIds: new Set(config.allowlistedUserIds ?? []),
    reconcilerId: requiredString(config.reconcilerId, 'reconcilerId'),
    reconcileIntervalMs: config.reconcileIntervalMs ?? 100,
    onReconcileError: (error, context) => {
      notify({
        type: 'file-agent-reconcile-error',
        error: error?.message ?? String(error),
        deliveryId: context?.deliveryId ?? null,
      });
    },
  });
  const host = await connector.startUpstreamLibreChatHostIntegration({
    app,
    integration,
    controllerBridge: {
      modelRouteId: requiredString(config.modelRouteId, 'modelRouteId'),
      getBalanceConfig: api.getBalanceConfig,
      getTransactionsConfig: api.getTransactionsConfig,
      getMultiplier: db.getMultiplier,
      getCacheMultiplier: db.getCacheMultiplier,
      limits: config.limits ?? {},
    },
  });
  api.registerShutdownTask('non-production file agent host', host.stop);
  notify({ type: 'file-agent-host-ready' });
}

process.once('message', (config) => {
  globalThis[INSTALLER_SYMBOL] = (context) => install(config, context);
  const upstreamRoot = path.resolve(requiredString(config.upstreamRoot, 'upstreamRoot'));
  require(path.join(upstreamRoot, 'api/server/index.js'));
});

setTimeout(() => {
  if (globalThis[INSTALLER_SYMBOL] == null) {
    throw new Error('Phase 3D-B launcher did not receive its IPC configuration');
  }
}, 10_000).unref();
