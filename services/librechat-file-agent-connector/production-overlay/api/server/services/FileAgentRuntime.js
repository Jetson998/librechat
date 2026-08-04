const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DEFAULT_CONNECTOR_ROOT = '/opt/librechat/file-agent-runtime/connector';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function scopedIdentity({ userId, tenantId } = {}) {
  const normalizedUserId = nonEmptyString(userId?.toString?.() ?? userId);
  if (!normalizedUserId) {
    return null;
  }
  return {
    userId: normalizedUserId,
    tenantId: nonEmptyString(tenantId?.toString?.() ?? tenantId) ?? undefined,
  };
}

function requestIdentity(request) {
  return scopedIdentity({
    userId: request?.user?.id ?? request?.user?._id,
    tenantId: request?.user?.tenantId,
  });
}

function deliveryIdentity(delivery) {
  return scopedIdentity({
    userId: delivery?.user,
    tenantId: delivery?.tenantId,
  });
}

function runInTenantScope(tenantStorage, identity, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('tenant-scoped operation is required');
  }
  if (!identity || typeof tenantStorage?.run !== 'function') {
    return operation();
  }
  return tenantStorage.run(identity, operation);
}

function configurationError(field) {
  const error = new Error(`Production File Agent host configuration ${field} is invalid`);
  error.code = 'FILE_AGENT_HOST_CONFIGURATION_INVALID';
  error.safeSummary = `Production File Agent host configuration ${field} is invalid`;
  return error;
}

function enabled(environment) {
  const value = environment?.FILE_AGENT_RUNTIME_ENABLED;
  if (value == null || value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw configurationError('FILE_AGENT_RUNTIME_ENABLED');
}

function connectorRoot(environment) {
  const value = environment?.FILE_AGENT_CONNECTOR_ROOT || DEFAULT_CONNECTOR_ROOT;
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.split(path.sep).includes('..')
  ) {
    throw configurationError('FILE_AGENT_CONNECTOR_ROOT');
  }
  return path.resolve(value);
}

async function loadProductionHostModule(root) {
  const entrypoint = path.join(root, 'src', 'production-host-integration.js');
  return import(pathToFileURL(entrypoint).href);
}

function loadNativeDependencies() {
  const { logger, tenantStorage } = require('@librechat/data-schemas');
  const api = require('@librechat/api');
  const mongoose = require('mongoose');
  const db = require('~/models');
  const { getAppConfig } = require('~/server/services/Config');
  const { processCodeOutput } = require('~/server/services/Files/Code/process');
  const { getStrategyFunctions } = require('~/server/services/Files/strategies');
  const { FileSources } = require('librechat-data-provider');
  return {
    api,
    db,
    FileSources,
    getAppConfig,
    getStrategyFunctions,
    logger,
    mongoose,
    processCodeOutput,
    tenantStorage,
  };
}

function createNativePorts({ app, appConfig, dependencies }) {
  const {
    api,
    db,
    FileSources,
    getAppConfig,
    getStrategyFunctions,
    logger,
    mongoose,
    processCodeOutput,
    tenantStorage,
  } = dependencies;
  const database = mongoose?.connection?.db;
  if (!database || typeof database.collection !== 'function') {
    throw new Error('LibreChat Mongo database is not connected');
  }

  const inRequestScope = (request, operation) =>
    runInTenantScope(tenantStorage, requestIdentity(request), operation);
  const inDeliveryScope = (delivery, operation) =>
    runInTenantScope(tenantStorage, deliveryIdentity(delivery), operation);

  const resolveRequest = async ({ delivery }) => {
    const identity = deliveryIdentity(delivery);
    const scope = identity ?? {
      tenantId: delivery.tenantId ?? undefined,
      userId: delivery.user,
    };
    const config = await runInTenantScope(
      tenantStorage,
      identity,
      async () => getAppConfig(scope).catch(() => appConfig),
    );
    return {
      app,
      config: config ?? appConfig,
      user: {
        id: delivery.user,
        _id: delivery.user,
        tenantId: delivery.tenantId ?? undefined,
        role: 'USER',
      },
    };
  };

  return {
    database,
    native: {
      readStorageStream: async ({ file, context }) => {
        return inRequestScope(context?.req, async () => {
          const source = file.source ?? FileSources.local;
          const strategy = getStrategyFunctions(source);
          if (typeof strategy?.getDownloadStream !== 'function') {
            throw new Error('LibreChat storage source does not support download streams');
          }
          const storageReference = file.storageKey ?? file.filepath;
          if (typeof storageReference !== 'string' || storageReference.trim() === '') {
            throw new Error('LibreChat attachment has no storage reference');
          }
          return strategy.getDownloadStream(context.req, storageReference);
        });
      },
      persistFileMetadata: ({ file, metadata, context }) => inRequestScope(
        context?.req,
        () => db.updateFile({
          file_id: file.file_id,
          metadata,
        }),
      ),
      getBalanceConfig: api.getBalanceConfig,
      getTransactionsConfig: api.getTransactionsConfig,
      getMultiplier: db.getMultiplier,
      getCacheMultiplier: db.getCacheMultiplier,
      prepareStructuredTokenSpend: api.prepareStructuredTokenSpend,
      bulkWriteTransactions: (request, transactionDbOps) => runInTenantScope(
        tenantStorage,
        scopedIdentity({ userId: request?.user, tenantId: request?.tenantId }),
        () => api.bulkWriteTransactions(request, transactionDbOps),
      ),
      transactionDbOps: {
        insertMany: db.bulkInsertTransactions,
        updateBalance: db.updateBalance,
      },
      processCodeOutput: (args) => inRequestScope(
        args?.req,
        () => processCodeOutput(args),
      ),
      saveMessage: (requestContext, message, options) => runInTenantScope(
        tenantStorage,
        scopedIdentity({
          userId: requestContext?.userId,
          tenantId: requestContext?.tenantId,
        }),
        () => db.saveMessage(requestContext, message, options),
      ),
      generationJobManager: {
        emitDone: (streamId, event) => api.GenerationJobManager.emitDone(streamId, event),
        completeJob: (streamId, error) => api.GenerationJobManager.completeJob(streamId, error),
      },
      resolveRequest,
      buildRequestContext: ({ delivery, request }) => ({
        userId: delivery.user,
        tenantId: delivery.tenantId ?? undefined,
        interfaceConfig: request.config?.interfaceConfig,
      }),
      updateProgress: async () => {},
      getFilesByIds: ({ fileIds, userId, tenantId, conversationId }) => runInTenantScope(
        tenantStorage,
        scopedIdentity({ userId, tenantId }),
        () => db.getFiles({
          file_id: { $in: fileIds },
          user: userId,
          conversationId,
          ...(tenantId != null ? { tenantId } : {}),
        }),
      ),
      createTransactionId: (stableId) => new mongoose.Types.ObjectId(stableId.slice(0, 24)),
      findExistingTransactionIds: async ({ ids, user, delivery }) => {
        if (!mongoose.isValidObjectId(user)) {
          return [];
        }
        return inDeliveryScope(delivery, async () => {
          const documents = await database.collection('transactions')
            .find(
              {
                _id: { $in: ids },
                user: new mongoose.Types.ObjectId(user),
              },
              { projection: { _id: 1 } },
            )
            .toArray();
          return documents.map((document) => document._id);
        });
      },
      sanitizeFileForTransmit: api.sanitizeFileForTransmit,
      resolveMessageIdentity: ({ billingSnapshot }) => billingSnapshot.messageIdentity,
      loadConversation: ({ userId, tenantId, conversationId }) => runInTenantScope(
        tenantStorage,
        scopedIdentity({ userId, tenantId }),
        () => db.getConvo(userId, conversationId),
      ),
      loadMessage: ({ userId, tenantId, conversationId, messageId }) => runInTenantScope(
        tenantStorage,
        scopedIdentity({ userId, tenantId }),
        async () => {
          const message = await db.getMessage({ user: userId, messageId });
          return message?.conversationId === conversationId ? message : null;
        },
      ),
      sanitizeMessageForTransmit: api.sanitizeMessageForTransmit,
      onReconcileError: (error, context) => {
        logger.warn('[file-agent-runtime] reconciliation failed', {
          deliveryId: context?.deliveryId ?? null,
          name: error?.name ?? 'Error',
        });
      },
    },
  };
}

/**
 * Installs the optional production bridge after Mongo and file storage are
 * initialized, but before the Agent router is registered. Default-disabled
 * mode performs no dynamic import, file read, database index creation, or
 * Runtime network request.
 */
async function installFileAgentRuntimeHost({
  app,
  appConfig,
  environment = process.env,
  dependencies = null,
  loadHostModule = loadProductionHostModule,
} = {}) {
  if (!enabled(environment)) {
    return { enabled: false, stop: async () => {} };
  }
  if (!app?.locals || typeof app.locals !== 'object') {
    throw new TypeError('Express app.locals is required');
  }
  if (typeof loadHostModule !== 'function') {
    throw new TypeError('loadHostModule is required');
  }

  const root = connectorRoot(environment);
  const hostModule = await loadHostModule(root);
  const config = await hostModule.loadProductionHostConfig({ environment });
  if (config?.enabled !== true) {
    throw configurationError('FILE_AGENT_RUNTIME_ENABLED');
  }
  const resolvedDependencies = dependencies ?? loadNativeDependencies();
  const { database, native } = createNativePorts({
    app,
    appConfig,
    dependencies: resolvedDependencies,
  });
  return hostModule.startProductionLibreChatHostIntegration({
    app,
    config,
    database,
    native,
    registerShutdownTask: resolvedDependencies.api.registerShutdownTask,
  });
}

module.exports = {
  createNativePorts,
  installFileAgentRuntimeHost,
};
