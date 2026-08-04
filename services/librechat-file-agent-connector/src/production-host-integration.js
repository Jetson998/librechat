import { DOCX_MIME, TASK_CONTRACT_VERSION_V1_1, WORD_CAPABILITY_PROFILE } from './constants.js';
import { createLibreChatHostIntegration } from './librechat-host-integration.js';
import { loadProductionHostConfig } from './production-host-config.js';
import {
  createStorageBackedFileDigest,
  createUpstreamMongoCollections,
  startUpstreamLibreChatHostIntegration,
} from './upstream-controller-adapter.js';
import { resolveWordAcceptanceAssertions } from './word-acceptance-resolver.js';

export const FILE_AGENT_DELIVERY_COLLECTION = 'file_agent_deliveries';
export const FILE_AGENT_BILLING_SNAPSHOT_COLLECTION = 'file_agent_billing_snapshots';
export const FILE_AGENT_ACTIVE_TASK_COLLECTION = 'file_agent_active_tasks';

const COMPLEX_WORD_INTENT = /(?:修改|替换|改为|改成|追加|新增|添加|交付|生成|制作|整理|replace|append|add|modify|transform|deliver|produce)/iu;

function native(reason) {
  return { route: 'native', reason };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function requestFileIds(req) {
  const files = req?.body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    return { reason: 'no_current_request_files' };
  }
  if (files.length !== 1) {
    return { reason: 'word_input_contract_unsupported' };
  }
  const fileId = files[0]?.file_id;
  if (!nonEmptyString(fileId)) {
    return { reason: 'invalid_current_request_file_reference' };
  }
  return { fileId: fileId.trim() };
}

/**
 * Applies only cheap, side-effect-free conditions before attachment hashing,
 * billing snapshots, or Runtime discovery. The full ownership and CodeAPI
 * checks remain in createUpstreamRuntimeRequestResolver.
 */
export function createProductionWordPreflight({ allowlistedUserIds }) {
  if (!(allowlistedUserIds instanceof Set)) {
    throw new TypeError('allowlistedUserIds must be a Set');
  }
  return async (context) => {
    if (!allowlistedUserIds.has(context?.userId)) {
      return native('user_not_allowlisted');
    }
    if (!nonEmptyString(context?.text) || !COMPLEX_WORD_INTENT.test(context.text)) {
      return native('not_complex_file_intent');
    }
    const current = requestFileIds(context?.req);
    if (current.reason) {
      return native(current.reason);
    }
    if (
      !nonEmptyString(context?.conversationId) ||
      !nonEmptyString(context?.userMessageId) ||
      !nonEmptyString(context?.assistantMessageId) ||
      !nonEmptyString(context?.streamId)
    ) {
      return native('current_turn_identity_unavailable');
    }

    const attachments = context?.client?.options?.attachments;
    if (!Array.isArray(attachments)) {
      return native('current_request_file_not_authorized');
    }
    const attachment = attachments.find((file) => file?.file_id === current.fileId);
    if (!attachment) {
      return native('current_request_file_not_authorized');
    }
    if (
      attachment.type !== DOCX_MIME ||
      !nonEmptyString(attachment.filename) ||
      !attachment.filename.toLowerCase().endsWith('.docx')
    ) {
      return native('word_input_contract_unsupported');
    }
    return null;
  };
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

/**
 * Composes the reviewed Connector with real LibreChat ports. The caller owns
 * all upstream imports so this module stays independently testable and cannot
 * silently bind a different LibreChat API revision.
 */
export async function startProductionLibreChatHostIntegration({
  app,
  config,
  database,
  native,
  registerShutdownTask = null,
  runtimeClient = null,
  runtimeFetch = globalThis.fetch,
}) {
  if (config?.enabled !== true) {
    throw new TypeError('enabled production host configuration is required');
  }
  if (!database || typeof database.collection !== 'function') {
    throw new TypeError('connected Mongo database is required');
  }
  if (!native || typeof native !== 'object') {
    throw new TypeError('native LibreChat ports are required');
  }
  if (registerShutdownTask != null) {
    requiredFunction(registerShutdownTask, 'registerShutdownTask');
  }

  const computeFileDigest = createStorageBackedFileDigest({
    readStorageStream: requiredFunction(native.readStorageStream, 'native.readStorageStream'),
    persistFileMetadata: requiredFunction(
      native.persistFileMetadata,
      'native.persistFileMetadata',
    ),
  });
  const collections = createUpstreamMongoCollections({
    database,
    deliveryCollectionName: FILE_AGENT_DELIVERY_COLLECTION,
    billingSnapshotCollectionName: FILE_AGENT_BILLING_SNAPSHOT_COLLECTION,
    transactionCollectionName: 'transactions',
    activeTaskCollectionName: FILE_AGENT_ACTIVE_TASK_COLLECTION,
  });
  const integration = createLibreChatHostIntegration({
    collections,
    ...(runtimeClient ? { runtimeClient } : {
      runtimeBaseUrl: config.runtimeBaseUrl,
      runtimeFetch,
      serviceScopeSecret: config.serviceScopeSecret,
      serviceScopeOptions: { ttlSeconds: config.serviceScopeTtlSeconds },
    }),
    native,
    featureEnabled: true,
    allowlistedUserIds: config.allowlistedUserIds,
    reconcilerId: `file-agent-api-${process.pid}`,
    reconcileIntervalMs: config.reconcileIntervalMs,
    onReconcileError: native.onReconcileError,
  });

  try {
    const host = await startUpstreamLibreChatHostIntegration({
      app,
      integration,
      controllerBridge: {
        modelRouteId: config.modelRouteId,
        capabilityProfile: WORD_CAPABILITY_PROFILE,
        taskContractVersion: TASK_CONTRACT_VERSION_V1_1,
        getBalanceConfig: native.getBalanceConfig,
        getTransactionsConfig: native.getTransactionsConfig,
        getMultiplier: native.getMultiplier,
        getCacheMultiplier: native.getCacheMultiplier,
        limits: { maxVisibleArtifacts: 1 },
        resolveAcceptanceAssertions: resolveWordAcceptanceAssertions,
        computeFileDigest,
        preflightRequest: createProductionWordPreflight({
          allowlistedUserIds: config.allowlistedUserIds,
        }),
      },
    });
    if (registerShutdownTask) {
      registerShutdownTask('file agent Runtime host', host.stop);
    }
    return { ...host, enabled: true };
  } catch (error) {
    await integration.stop().catch(() => {});
    throw error;
  }
}

export { loadProductionHostConfig };
