import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { FileAgentControllerBridge } from './controller-bridge.js';
import {
  DEFAULT_CAPABILITY_PROFILE,
  DOCX_MIME,
  TASK_CONTRACT_VERSION,
  TASK_CONTRACT_VERSION_V1_1,
  WORD_CAPABILITY_PROFILE,
} from './constants.js';
import { clone, sha256 } from './stable.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CONTINUATION_INTENT = /(?:继续|接着|刚才|上一轮|上一个任务|按刚才|按之前|resume|continue|same task)/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REMOTE_FILE_REFERENCE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

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

function resolveCapabilityProfile(value, context, files) {
  const resolved = typeof value === 'function' ? value(context) : value;
  if (resolved == null) {
    return files.some((file) => file.type === DOCX_MIME)
      ? WORD_CAPABILITY_PROFILE
      : DEFAULT_CAPABILITY_PROFILE;
  }
  return requiredString(resolved, 'capabilityProfile');
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

function binaryContent(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return null;
}

function trustedContentHash(file) {
  const metadata = file?.metadata;
  const declared = file?.contentSha256 ?? metadata?.contentSha256;
  if (
    typeof declared === 'string' &&
    SHA256_PATTERN.test(declared) &&
    metadata?.contentSha256Source === 'librechat-storage-v1'
  ) {
    return declared.toLowerCase();
  }
  return null;
}

async function digestContent(value) {
  const content = binaryContent(value);
  if (content) {
    return sha256(content);
  }
  if (!value || typeof value[Symbol.asyncIterator] !== 'function') {
    const error = new Error('The storage strategy did not return a readable file stream');
    error.code = 'FILE_CONTENT_STREAM_UNAVAILABLE';
    throw error;
  }
  const digest = createHash('sha256');
  for await (const chunk of value) {
    const buffer = binaryContent(chunk);
    if (!buffer) {
      const error = new Error('The storage strategy returned a non-binary file chunk');
      error.code = 'FILE_CONTENT_STREAM_INVALID';
      throw error;
    }
    digest.update(buffer);
  }
  return digest.digest('hex');
}

export async function contentSha256(file) {
  const trusted = trustedContentHash(file);
  if (trusted) {
    return trusted;
  }

  const content = binaryContent(file?.content ?? file?.buffer);
  if (content) {
    return sha256(content);
  }

  const sourcePath = [file?.path, file?.localPath, file?.filepath]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((value) => (
      value !== ''
      && path.isAbsolute(value)
      && !value.startsWith('/api/')
      && !REMOTE_FILE_REFERENCE.test(value)
    ));
  if (sourcePath) {
    try {
      return sha256(await readFile(sourcePath));
    } catch (cause) {
      const error = new Error(
        'The upstream attachment local content could not be read for hashing',
        { cause },
      );
      error.code = 'FILE_CONTENT_HASH_UNAVAILABLE';
      throw error;
    }
  }

  const error = new Error(
    'The upstream attachment does not expose verified DOCX bytes or a content SHA-256',
  );
  error.code = 'FILE_CONTENT_HASH_UNAVAILABLE';
  throw error;
}

export function createStorageBackedFileDigest({
  readStorageStream,
  persistFileMetadata,
} = {}) {
  requiredFunction(readStorageStream, 'readStorageStream');
  if (persistFileMetadata != null) {
    requiredFunction(persistFileMetadata, 'persistFileMetadata');
  }

  return async (file, context) => {
    const trusted = trustedContentHash(file);
    if (trusted) {
      return trusted;
    }

    const content = binaryContent(file?.content ?? file?.buffer);
    if (content) {
      return sha256(content);
    }

    let stream;
    try {
      stream = await readStorageStream({ file, context });
    } catch (error) {
      const wrapped = new Error('The LibreChat storage strategy could not read the attachment', {
        cause: error,
      });
      wrapped.code = 'FILE_CONTENT_HASH_UNAVAILABLE';
      throw wrapped;
    }

    let digest;
    try {
      digest = await digestContent(stream);
    } catch (error) {
      if (error?.code === 'FILE_CONTENT_STREAM_UNAVAILABLE') {
        error.code = 'FILE_CONTENT_HASH_UNAVAILABLE';
      }
      throw error;
    }

    if (persistFileMetadata) {
      const metadata = {
        ...(file?.metadata ?? {}),
        contentSha256: digest,
        contentSha256Source: 'librechat-storage-v1',
      };
      try {
        await persistFileMetadata({ file, metadata, context });
      } catch (error) {
        const wrapped = new Error('The LibreChat attachment hash could not be persisted', {
          cause: error,
        });
        wrapped.code = 'FILE_CONTENT_HASH_PERSIST_FAILED';
        throw wrapped;
      }
      if (file && typeof file === 'object') {
        file.metadata = metadata;
      }
    }
    return digest;
  };
}

export function createUpstreamRuntimeRequestResolver({
  modelRouteId,
  capabilityProfile,
  taskContractVersion,
  acceptance,
  limits = {},
  computeFileDigest = contentSha256,
  resolveAcceptanceAssertions = null,
} = {}) {
  requiredFunction(computeFileDigest, 'computeFileDigest');
  if (resolveAcceptanceAssertions != null) {
    requiredFunction(resolveAcceptanceAssertions, 'resolveAcceptanceAssertions');
  }
  return async (context) => {
    const constraint = resolveTurnConstraint(context.req);
    if (constraint) {
      return constraint;
    }

    const requestFiles = Array.isArray(context.req?.body?.files) ? context.req.body.files : [];
    if (requestFiles.length === 0) {
      if (!CONTINUATION_INTENT.test(context.text ?? '')) {
        return native('no_current_request_files');
      }
      const userId = requiredString(context.userId, 'userId');
      return {
        route: 'continuation_candidate',
        userId,
        tenantId: valueString(context.req?.user?.tenantId),
        conversationId: requiredString(context.conversationId, 'conversationId'),
        userMessageId: requiredString(context.userMessageId, 'userMessageId'),
        assistantMessageId: requiredString(context.assistantMessageId, 'assistantMessageId'),
        streamId: requiredString(context.streamId, 'streamId'),
        instruction: requiredString(context.text, 'instruction'),
        activeTaskId: valueString(
          context.activeTaskId ?? context.req?.body?.activeTaskId,
        ),
      };
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

    const resolvedCapabilityProfile = resolveCapabilityProfile(
      capabilityProfile,
      context,
      authorized,
    );
    const resolvedTaskContractVersion = taskContractVersion ?? (
      resolvedCapabilityProfile === WORD_CAPABILITY_PROFILE
        ? TASK_CONTRACT_VERSION_V1_1
        : TASK_CONTRACT_VERSION
    );
    const defaultAcceptance = resolvedCapabilityProfile === WORD_CAPABILITY_PROFILE
      ? ['Produce one verified DOCX artifact from the authorized current-turn Word document']
      : ['Produce one verified XLSX artifact from the authorized current-turn workbook'];
    const resolvedAcceptance = acceptance ?? defaultAcceptance;
    const resolvedAcceptanceAssertions = resolveAcceptanceAssertions
      ? await resolveAcceptanceAssertions({
          context,
          files: authorized,
          instruction: context.text,
        })
      : null;
    if (
      resolvedCapabilityProfile === WORD_CAPABILITY_PROFILE &&
      !Array.isArray(resolvedAcceptanceAssertions)
    ) {
      return native('word_acceptance_assertions_unavailable');
    }

    let files;
    try {
      files = await Promise.all(authorized.map(async (file) => {
        const fileSha256 = requiredString(
          await computeFileDigest(file, context),
          'file.sha256',
        ).toLowerCase();
        if (!SHA256_PATTERN.test(fileSha256)) {
          throw new TypeError('file.sha256 must be a SHA-256 digest of the file contents');
        }
        return {
          fileId: requiredString(valueString(file.file_id), 'file.fileId'),
          name: requiredString(file.filename, 'file.filename'),
          mimeType: requiredString(file.type, 'file.type'),
          sha256: fileSha256,
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
        };
      }));
    } catch (error) {
      if (
        error?.code === 'FILE_CONTENT_HASH_UNAVAILABLE' ||
        error?.code === 'FILE_CONTENT_HASH_PERSIST_FAILED'
      ) {
        return native(
          error.code === 'FILE_CONTENT_HASH_PERSIST_FAILED'
            ? 'input_content_hash_persistence_failed'
            : 'input_content_hash_unavailable',
        );
      }
      throw error;
    }

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
      capabilityProfile: resolvedCapabilityProfile,
      taskContractVersion: resolvedTaskContractVersion,
      acceptance: [...resolvedAcceptance],
      ...(resolvedAcceptanceAssertions
        ? { acceptanceAssertions: clone(resolvedAcceptanceAssertions) }
        : {}),
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
  taskContractVersion,
  acceptance,
  limits,
  computeFileDigest,
  resolveAcceptanceAssertions,
  preflightRequest,
}) {
  return new FileAgentControllerBridge({
    connector,
    prepareRequest: createUpstreamRuntimeRequestResolver({
      modelRouteId,
      capabilityProfile,
      taskContractVersion,
      acceptance,
      resolveAcceptanceAssertions,
      limits,
      computeFileDigest,
    }),
    preflightRequest,
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
  activeTaskCollectionName = 'file_agent_active_tasks',
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
    activeTasks: database.collection(
      requiredString(activeTaskCollectionName, 'activeTaskCollectionName'),
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

export { DOCX_MIME, XLSX_MIME };
