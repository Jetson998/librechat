import {
  DOCX_MIME,
  OFFICE_COMPOSE_CAPABILITY_PROFILE,
  PPTX_CAPABILITY_PROFILE,
  PPTX_MIME,
  TASK_CONTRACT_VERSION_V1_1,
  TASK_CONTRACT_VERSION_V1_2,
  XLSX_CAPABILITY_PROFILE,
  XLSX_MIME,
  WORD_CAPABILITY_PROFILE,
} from './constants.js';
import { createLibreChatHostIntegration } from './librechat-host-integration.js';
import { loadProductionHostConfig } from './production-host-config.js';
import {
  createStorageBackedFileDigest,
  createUpstreamMongoCollections,
  startUpstreamLibreChatHostIntegration,
} from './upstream-controller-adapter.js';
import { resolveOfficeComposeAcceptanceAssertions } from './office-compose-acceptance-resolver.js';
import { resolveOfficeTaskIntent } from './office-task-intent.js';
import { resolvePptxAcceptanceAssertions } from './pptx-acceptance-resolver.js';
import { resolveWordAcceptanceAssertions } from './word-acceptance-resolver.js';
import { resolveXlsxAcceptanceAssertions } from './xlsx-acceptance-resolver.js';

export const FILE_AGENT_DELIVERY_COLLECTION = 'file_agent_deliveries';
export const FILE_AGENT_BILLING_SNAPSHOT_COLLECTION = 'file_agent_billing_snapshots';
export const FILE_AGENT_ACTIVE_TASK_COLLECTION = 'file_agent_active_tasks';

const COMPLEX_WORD_INTENT = /(?:修改|替换|改为|改成|追加|新增|添加|交付|生成|制作|整理|replace|append|add|modify|transform|deliver|produce)/iu;
const COMPLEX_OFFICE_INTENT = /(?:修改|替换|改为|改成|追加|新增|添加|交付|生成|制作|整理|导出|汇总|转换|演示|汇报|幻灯片|工作表|公式|格式|重排|replace|append|add|modify|transform|deliver|produce|export|summari[sz]e|convert|slide|presentation|deck|formula|format)/iu;
const OFFICE_FILE_TYPES = new Set([DOCX_MIME, XLSX_MIME, PPTX_MIME]);
const ACCEPTANCE_UNAVAILABLE_REASONS = Object.freeze({
  [WORD_CAPABILITY_PROFILE]: 'word_acceptance_assertions_unavailable',
  [XLSX_CAPABILITY_PROFILE]: 'xlsx_acceptance_assertions_unavailable',
  [PPTX_CAPABILITY_PROFILE]: 'pptx_acceptance_assertions_unavailable',
  [OFFICE_COMPOSE_CAPABILITY_PROFILE]: 'office_compose_acceptance_assertions_unavailable',
});

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

function requestFileIdList(req) {
  const files = req?.body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    return { reason: 'no_current_request_files' };
  }
  if (files.length > 2) {
    return { reason: 'office_input_contract_unsupported' };
  }
  const fileIds = files.map((file) => file?.file_id);
  if (fileIds.some((fileId) => !nonEmptyString(fileId))) {
    return { reason: 'invalid_current_request_file_reference' };
  }
  if (new Set(fileIds.map((fileId) => fileId.trim())).size !== fileIds.length) {
    return { reason: 'duplicate_current_request_file_reference' };
  }
  return { fileIds: fileIds.map((fileId) => fileId.trim()) };
}

function attachmentFormatSupported(file) {
  if (!OFFICE_FILE_TYPES.has(file?.type) || !nonEmptyString(file?.filename)) {
    return false;
  }
  const filename = file.filename.toLowerCase();
  return (
    (file.type === DOCX_MIME && filename.endsWith('.docx'))
    || (file.type === XLSX_MIME && filename.endsWith('.xlsx'))
    || (file.type === PPTX_MIME && filename.endsWith('.pptx'))
  );
}

function acceptanceResolverForProfile(profile) {
  if (profile === WORD_CAPABILITY_PROFILE) {
    return resolveWordAcceptanceAssertions;
  }
  if (profile === XLSX_CAPABILITY_PROFILE) {
    return resolveXlsxAcceptanceAssertions;
  }
  if (profile === PPTX_CAPABILITY_PROFILE) {
    return resolvePptxAcceptanceAssertions;
  }
  if (profile === OFFICE_COMPOSE_CAPABILITY_PROFILE) {
    return resolveOfficeComposeAcceptanceAssertions;
  }
  return null;
}

function productionCapabilityProfile({ files, instruction }) {
  if (files.some((file) => !attachmentFormatSupported(file))) {
    return null;
  }
  return resolveOfficeTaskIntent({ files, instruction })?.profile ?? null;
}

function productionModelRouteId(baseRouteId, profile) {
  const suffix = profile === WORD_CAPABILITY_PROFILE
    ? ''
    : profile === XLSX_CAPABILITY_PROFILE
      ? '-xlsx'
      : profile === PPTX_CAPABILITY_PROFILE
        ? '-pptx'
        : profile === OFFICE_COMPOSE_CAPABILITY_PROFILE
          ? '-compose'
          : null;
  if (suffix == null) {
    throw new TypeError(`Unsupported production capability profile: ${profile}`);
  }
  return `${baseRouteId}${suffix}`;
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

export function createProductionOfficePreflight({ allowlistedUserIds }) {
  if (!(allowlistedUserIds instanceof Set)) {
    throw new TypeError('allowlistedUserIds must be a Set');
  }
  return async (context) => {
    if (!allowlistedUserIds.has(context?.userId)) {
      return native('user_not_allowlisted');
    }
    if (!nonEmptyString(context?.text) || !COMPLEX_OFFICE_INTENT.test(context.text)) {
      return native('not_complex_file_intent');
    }
    const current = requestFileIdList(context?.req);
    if (current.reason) {
      return native(current.reason);
    }
    if (
      !nonEmptyString(context?.conversationId)
      || !nonEmptyString(context?.userMessageId)
      || !nonEmptyString(context?.assistantMessageId)
      || !nonEmptyString(context?.streamId)
    ) {
      return native('current_turn_identity_unavailable');
    }
    const attachments = context?.client?.options?.attachments;
    if (!Array.isArray(attachments)) {
      return native('current_request_file_not_authorized');
    }
    const byId = new Map(attachments.map((file) => [file?.file_id, file]));
    const selected = current.fileIds.map((fileId) => byId.get(fileId));
    if (selected.some((file) => !file)) {
      return native('current_request_file_not_authorized');
    }
    if (selected.some((file) => !attachmentFormatSupported(file))) {
      return native('office_input_contract_unsupported');
    }
    const profile = productionCapabilityProfile({ files: selected, instruction: context.text });
    if (!profile) {
      return native('office_input_contract_unsupported');
    }
    const resolver = acceptanceResolverForProfile(profile);
    if (!resolver || !Array.isArray(await resolver({ files: selected, instruction: context.text }))) {
      return native(ACCEPTANCE_UNAVAILABLE_REASONS[profile]);
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
        modelRouteId: (context) => productionModelRouteId(
          config.modelRouteId,
          productionCapabilityProfile({
            files: context?.client?.options?.attachments?.filter((file) => (
              context?.req?.body?.files?.some((entry) => entry?.file_id === file?.file_id)
            )),
            instruction: context?.text,
          }),
        ),
        capabilityProfile: (context) => productionCapabilityProfile({
          files: context?.client?.options?.attachments?.filter((file) => (
            context?.req?.body?.files?.some((entry) => entry?.file_id === file?.file_id)
          )),
          instruction: context?.text,
        }),
        taskContractVersion: (context) => productionCapabilityProfile({
          files: context?.client?.options?.attachments?.filter((file) => (
            context?.req?.body?.files?.some((entry) => entry?.file_id === file?.file_id)
          )),
          instruction: context?.text,
        }) === WORD_CAPABILITY_PROFILE
          ? TASK_CONTRACT_VERSION_V1_1
          : TASK_CONTRACT_VERSION_V1_2,
        getBalanceConfig: native.getBalanceConfig,
        getTransactionsConfig: native.getTransactionsConfig,
        getMultiplier: native.getMultiplier,
        getCacheMultiplier: native.getCacheMultiplier,
        limits: { maxVisibleArtifacts: 1 },
        resolveAcceptanceAssertions: ({ files, instruction }) => {
          const profile = productionCapabilityProfile({ files, instruction });
          const resolver = acceptanceResolverForProfile(profile);
          return resolver ? resolver({ files, instruction }) : null;
        },
        computeFileDigest,
        providerRouteRegistry: config.providerRouteRegistry,
        preflightRequest: createProductionOfficePreflight({
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

export {
  loadProductionHostConfig,
  resolveOfficeTaskIntent,
  productionCapabilityProfile,
  productionModelRouteId,
};
