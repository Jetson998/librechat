import { FileAgentControllerBridge } from './controller-bridge.js';
import { clone, sha256 } from './stable.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function valueString(value) {
  if (value == null) {
    return null;
  }
  const normalized = typeof value === 'string' ? value : value.toString?.();
  return typeof normalized === 'string' && normalized !== '' ? normalized : null;
}

function sameIdentity(left, right) {
  return valueString(left) === valueString(right);
}

function native(reason) {
  return { route: 'native', reason };
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function resolveModelRouteId(value, context) {
  const resolved = typeof value === 'function' ? value(context) : value;
  return requiredString(resolved, 'modelRouteId');
}

function resolveTurnConstraint(req) {
  if (req?.body?.isTemporary === true) {
    return native('temporary_chat_unsupported');
  }
  if (req?.body?.isRegenerate === true) {
    return native('regenerate_unsupported');
  }
  if (req?.body?.isContinued === true) {
    return native('continued_response_unsupported');
  }
  if (req?.body?.editedContent != null) {
    return native('edited_response_unsupported');
  }
  return null;
}

export function codeEnvObjectDigest(file) {
  const ref = file?.metadata?.codeEnvRef;
  return sha256([
    'codeenv-object-v1',
    ref?.kind ?? '',
    ref?.id ?? '',
    ref?.storage_session_id ?? '',
    ref?.file_id ?? '',
    file?.bytes ?? '',
    file?.filename ?? '',
    file?.type ?? '',
  ].join('\0'));
}

export function createUpstreamRuntimeRequestResolver({
  modelRouteId,
  capabilityProfile = 'office-planner-v1',
  acceptance = ['Produce one verified XLSX artifact from the authorized current-turn workbook'],
  limits = {},
  computeFileDigest = codeEnvObjectDigest,
} = {}) {
  requiredFunction(computeFileDigest, 'computeFileDigest');
  return async (context) => {
    const constraint = resolveTurnConstraint(context.req);
    if (constraint) {
      return constraint;
    }

    const requestFiles = Array.isArray(context.req?.body?.files) ? context.req.body.files : [];
    if (requestFiles.length === 0) {
      return native('no_current_request_files');
    }
    const requestFileIds = requestFiles
      .map((file) => valueString(file?.file_id))
      .filter(Boolean);
    if (requestFileIds.length !== requestFiles.length) {
      return native('invalid_current_request_file_reference');
    }

    const attachments = Array.isArray(context.client?.options?.attachments)
      ? context.client.options.attachments
      : [];
    const attachmentById = new Map(
      attachments.map((file) => [valueString(file?.file_id), file]),
    );
    const authorized = requestFileIds.map((fileId) => attachmentById.get(fileId));
    if (authorized.some((file) => !file)) {
      return native('current_request_file_not_authorized');
    }

    const userId = requiredString(context.userId, 'userId');
    const tenantId = valueString(context.req?.user?.tenantId);
    for (const file of authorized) {
      const ref = file.metadata?.codeEnvRef;
      if (!sameIdentity(file.user, userId)) {
        return native('current_request_file_owner_mismatch');
      }
      if (valueString(file.tenantId) !== tenantId) {
        return native('current_request_file_tenant_mismatch');
      }
      if (
        !ref ||
        ref.kind !== 'user' ||
        !sameIdentity(ref.id, userId) ||
        !valueString(ref.storage_session_id) ||
        !valueString(ref.file_id)
      ) {
        return native('current_request_file_not_primed');
      }
    }

    const sessionIds = new Set(
      authorized.map((file) => valueString(file.metadata.codeEnvRef.storage_session_id)),
    );
    if (sessionIds.size !== 1) {
      return native('multiple_codeapi_storage_sessions_unsupported');
    }

    const files = await Promise.all(authorized.map(async (file) => ({
      fileId: requiredString(valueString(file.file_id), 'file.fileId'),
      name: requiredString(file.filename, 'file.filename'),
      mimeType: requiredString(file.type, 'file.type'),
      sha256: requiredString(await computeFileDigest(file), 'file.sha256'),
      conversationId: requiredString(context.conversationId, 'conversationId'),
      ownershipVerified: true,
      codeEnvRef: {
        storage_session_id: requiredString(
          valueString(file.metadata.codeEnvRef.storage_session_id),
          'file.codeEnvRef.storage_session_id',
        ),
        file_id: requiredString(
          valueString(file.metadata.codeEnvRef.file_id),
          'file.codeEnvRef.file_id',
        ),
      },
    })));

    return {
      userId,
      tenantId,
      conversationId: requiredString(context.conversationId, 'conversationId'),
      userMessageId: requiredString(context.userMessageId, 'userMessageId'),
      assistantMessageId: requiredString(context.assistantMessageId, 'assistantMessageId'),
      streamId: requiredString(context.streamId, 'streamId'),
      instruction: requiredString(context.text, 'instruction'),
      files,
      sessionId: [...sessionIds][0],
      modelRouteId: resolveModelRouteId(modelRouteId, context),
      capabilityProfile,
      acceptance: [...acceptance],
      limits: clone(limits),
    };
  };
}

function resolvedProviderModel(client) {
  return requiredString(
    client?.options?.agent?.model ?? client?.modelOptions?.model ?? client?.model,
    'provider model',
  );
}

function resolvedEndpoint(client) {
  return requiredString(
    client?.options?.agent?.endpoint ?? client?.options?.endpoint,
    'provider endpoint',
  );
}

function resolvedMessageIdentity(client, endpoint, model) {
  const sender = valueString(client?.sender) ?? model;
  const iconURL = valueString(client?.options?.iconURL);
  return {
    sender,
    endpoint,
    model,
    ...(iconURL ? { iconURL } : {}),
  };
}

function nonNegativeRate(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} did not resolve to a non-negative finite rate`);
  }
  return value;
}

export function createUpstreamBillingSnapshotCreator({
  billingSnapshotStore,
  getBalanceConfig,
  getTransactionsConfig,
  getMultiplier,
  getCacheMultiplier,
}) {
  if (!billingSnapshotStore || typeof billingSnapshotStore.create !== 'function') {
    throw new TypeError('billingSnapshotStore.create is required');
  }
  requiredFunction(getBalanceConfig, 'getBalanceConfig');
  requiredFunction(getTransactionsConfig, 'getTransactionsConfig');
  requiredFunction(getMultiplier, 'getMultiplier');
  requiredFunction(getCacheMultiplier, 'getCacheMultiplier');

  return async ({ req, client, request }) => {
    const model = resolvedProviderModel(client);
    const endpoint = resolvedEndpoint(client);
    const endpointTokenConfig = clone(client?.options?.endpointTokenConfig ?? {});
    const currentModelTokenConfig = Object.hasOwn(endpointTokenConfig, model)
      ? { [model]: clone(endpointTokenConfig[model]) }
      : {};
    const pricingArgs = { model, endpoint, endpointTokenConfig };
    const prices = {
      prompt: nonNegativeRate(
        getMultiplier({ ...pricingArgs, tokenType: 'prompt' }),
        'prompt price',
      ),
      completion: nonNegativeRate(
        getMultiplier({ ...pricingArgs, tokenType: 'completion' }),
        'completion price',
      ),
      cacheRead: getCacheMultiplier({ ...pricingArgs, cacheType: 'read' }),
      cacheWrite: getCacheMultiplier({ ...pricingArgs, cacheType: 'write' }),
    };
    for (const field of ['cacheRead', 'cacheWrite']) {
      if (prices[field] != null) {
        prices[field] = nonNegativeRate(prices[field], `${field} price`);
      }
    }

    return billingSnapshotStore.create({
      user: request.userId,
      modelRouteId: request.modelRouteId,
      endpoint,
      model,
      prices,
      pricing: { source: 'resolved-librechat-native-v1' },
      endpointTokenConfig: currentModelTokenConfig,
      balance: getBalanceConfig(req.config),
      transactions: getTransactionsConfig(req.config),
      messageIdentity: resolvedMessageIdentity(client, endpoint, model),
    });
  };
}

export function createUpstreamControllerBridge({
  connector,
  billingSnapshotStore,
  modelRouteId,
  getBalanceConfig,
  getTransactionsConfig,
  getMultiplier,
  getCacheMultiplier,
  scheduleReconcile,
  capabilityProfile,
  acceptance,
  limits,
  computeFileDigest,
}) {
  return new FileAgentControllerBridge({
    connector,
    prepareRequest: createUpstreamRuntimeRequestResolver({
      modelRouteId,
      capabilityProfile,
      acceptance,
      limits,
      computeFileDigest,
    }),
    persistUserTurn: ({ persistUserTurn }) => persistUserTurn(),
    createBillingSnapshot: createUpstreamBillingSnapshotCreator({
      billingSnapshotStore,
      getBalanceConfig,
      getTransactionsConfig,
      getMultiplier,
      getCacheMultiplier,
    }),
    scheduleReconcile: requiredFunction(scheduleReconcile, 'scheduleReconcile'),
  });
}

export function createUpstreamMongoCollections({
  database,
  deliveryCollectionName,
  billingSnapshotCollectionName,
  transactionCollectionName,
}) {
  if (!database || typeof database.collection !== 'function') {
    throw new TypeError('Mongo database.collection is required');
  }
  return {
    deliveries: database.collection(
      requiredString(deliveryCollectionName, 'deliveryCollectionName'),
    ),
    billingSnapshots: database.collection(
      requiredString(billingSnapshotCollectionName, 'billingSnapshotCollectionName'),
    ),
    transactions: database.collection(
      requiredString(transactionCollectionName, 'transactionCollectionName'),
    ),
  };
}

export function installUpstreamControllerBridge({ app, bridge }) {
  if (!app?.locals || typeof app.locals !== 'object') {
    throw new TypeError('Express app.locals is required');
  }
  if (!bridge || typeof bridge.tryRoute !== 'function') {
    throw new TypeError('File Agent controller bridge is required');
  }
  if (app.locals.fileAgentRuntimeBridge != null) {
    throw new Error('Express app already has a File Agent Runtime bridge');
  }
  app.locals.fileAgentRuntimeBridge = bridge;
  return () => {
    if (app.locals.fileAgentRuntimeBridge === bridge) {
      delete app.locals.fileAgentRuntimeBridge;
    }
  };
}

export async function startUpstreamLibreChatHostIntegration({
  app,
  integration,
  controllerBridge,
}) {
  if (!integration || typeof integration.init !== 'function') {
    throw new TypeError('LibreChat host integration.init is required');
  }
  if (!integration.reconciler || typeof integration.reconciler.start !== 'function') {
    throw new TypeError('LibreChat host integration reconciler is required');
  }
  if (!integration.stores?.billingSnapshotStore) {
    throw new TypeError('LibreChat host billing snapshot store is required');
  }

  await integration.init();
  const bridge = createUpstreamControllerBridge({
    ...controllerBridge,
    connector: integration.connector,
    billingSnapshotStore: integration.stores.billingSnapshotStore,
    scheduleReconcile: ({ submission }) =>
      integration.reconciler.wake(submission.delivery.deliveryId),
  });
  const uninstall = installUpstreamControllerBridge({ app, bridge });
  integration.reconciler.start();

  let stopped = false;
  return {
    bridge,
    integration,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      uninstall();
      await integration.stop();
    },
  };
}

export { XLSX_MIME };
