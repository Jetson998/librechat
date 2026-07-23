import {
  DEFAULT_CAPABILITY_PROFILE,
  TASK_CONTRACT_VERSION,
  TASK_TYPE,
} from './constants.js';

const COMPLEX_FILE_INTENT = /(?:修改|生成|转换|汇总|导出|交付|制作|整理|重排|合并|拆分|modify|generate|convert|transform|summari[sz]e|export|deliver|create)/i;

function native(reason) {
  return { route: 'native', reason };
}

export function decideFileAgentRoute({
  featureEnabled,
  userId,
  allowlistedUserIds,
  conversationId,
  instruction,
  files,
  sessionId,
  modelRouteId,
  billingSnapshotRef,
  capabilityProfile = DEFAULT_CAPABILITY_PROFILE,
  capabilities,
}) {
  const preflight = decideFileAgentPreflight({
    featureEnabled,
    userId,
    allowlistedUserIds,
    conversationId,
    instruction,
    files,
    sessionId,
    modelRouteId,
    billingSnapshotRef,
    capabilityProfile,
  });
  if (preflight.route !== 'candidate') {
    return preflight;
  }
  if (
    !capabilities ||
    !capabilities.taskContractVersions?.includes(TASK_CONTRACT_VERSION) ||
    !capabilities.taskTypes?.includes(TASK_TYPE) ||
    !capabilities.capabilityProfiles?.includes(capabilityProfile) ||
    !Array.isArray(capabilities.inputMimeTypes) ||
    !Array.isArray(capabilities.outputMimeTypes)
  ) {
    return native('runtime_contract_unsupported');
  }
  if (files.some((file) => !capabilities.inputMimeTypes?.includes(file.mimeType))) {
    return native('runtime_file_type_unsupported');
  }
  return { route: 'runtime', reason: 'eligible_complex_file_task' };
}

export function decideFileAgentPreflight({
  featureEnabled,
  userId,
  allowlistedUserIds,
  conversationId,
  instruction,
  files,
  sessionId,
  modelRouteId,
  billingSnapshotRef,
  capabilityProfile = DEFAULT_CAPABILITY_PROFILE,
}) {
  if (featureEnabled !== true) {
    return native('feature_disabled');
  }
  if (!(allowlistedUserIds instanceof Set) || !allowlistedUserIds.has(userId)) {
    return native('user_not_allowlisted');
  }
  if (typeof instruction !== 'string' || !COMPLEX_FILE_INTENT.test(instruction)) {
    return native('not_complex_file_intent');
  }
  if (!Array.isArray(files) || files.length === 0) {
    return native('no_files');
  }
  if (files.some((file) => file.ownershipVerified !== true || file.conversationId !== conversationId)) {
    return native('file_scope_not_verified');
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return native('codeapi_session_not_primed');
  }
  if (typeof modelRouteId !== 'string' || typeof billingSnapshotRef !== 'string') {
    return native('billing_or_model_route_missing');
  }
  if (typeof capabilityProfile !== 'string' || capabilityProfile.trim() === '') {
    return native('capability_profile_missing');
  }
  return { route: 'candidate', reason: 'local_preflight_passed' };
}
