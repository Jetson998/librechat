import {
  DEFAULT_CAPABILITY_PROFILE,
  DOCX_MIME,
  MAX_VISIBLE_ARTIFACTS,
  TASK_CONTRACT_VERSION,
  TASK_CONTRACT_VERSION_V1_1,
  TASK_CONTRACT_VERSION_V1_2,
  TASK_TYPE,
  XLSX_CAPABILITY_PROFILE,
  XLSX_MIME,
  WORD_CAPABILITY_PROFILE,
} from './constants.js';
import { digestJson, opaqueRef, requiredString, sha256 } from './stable.js';
import { normalizeWordAcceptanceAssertions } from '../../file-agent-runtime/src/word-acceptance.js';
import { normalizeXlsxAcceptanceAssertions } from '../../file-agent-runtime/src/xlsx-acceptance.js';

function normalizeFile(file, { conversationId, sessionId, userId }) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new TypeError('Each task file must be an object');
  }
  if (file.ownershipVerified !== true || file.conversationId !== conversationId) {
    throw new TypeError('Task file ownership must be verified for the current conversation');
  }
  const codeEnvRef = file.codeEnvRef;
  if (
    !codeEnvRef ||
    codeEnvRef.storage_session_id !== sessionId ||
    typeof codeEnvRef.file_id !== 'string' ||
    codeEnvRef.file_id.trim() === ''
  ) {
    throw new TypeError('Task file requires a primed CodeAPI reference in the task session');
  }
  return {
    logicalName: requiredString(file.name, 'file.name'),
    librechatFileRef: opaqueRef('file', requiredString(file.fileId, 'file.fileId')),
    codeEnvRef: {
      kind: 'user',
      id: opaqueRef('user', userId),
      storage_session_id: sessionId,
      file_id: codeEnvRef.file_id.trim(),
    },
    sha256: requiredString(file.sha256, 'file.sha256'),
    mimeType: requiredString(file.mimeType, 'file.mimeType'),
  };
}

export function buildTaskSubmission({
  userId,
  tenantId = null,
  conversationId,
  userMessageId,
  instruction,
  files,
  sessionId,
  modelRouteId,
  billingSnapshotRef,
  capabilityProfile = DEFAULT_CAPABILITY_PROFILE,
  taskContractVersion = capabilityProfile === WORD_CAPABILITY_PROFILE
    ? TASK_CONTRACT_VERSION_V1_1
    : capabilityProfile === XLSX_CAPABILITY_PROFILE
      ? TASK_CONTRACT_VERSION_V1_2
    : TASK_CONTRACT_VERSION,
  acceptance = [],
  acceptanceAssertions = null,
  limits = {},
}) {
  userId = requiredString(userId, 'userId');
  conversationId = requiredString(conversationId, 'conversationId');
  userMessageId = requiredString(userMessageId, 'userMessageId');
  instruction = requiredString(instruction, 'instruction');
  sessionId = requiredString(sessionId, 'sessionId');
  modelRouteId = requiredString(modelRouteId, 'modelRouteId');
  billingSnapshotRef = requiredString(billingSnapshotRef, 'billingSnapshotRef');
  if (![TASK_CONTRACT_VERSION, TASK_CONTRACT_VERSION_V1_1, TASK_CONTRACT_VERSION_V1_2].includes(taskContractVersion)) {
    throw new TypeError(`Unsupported task contract version: ${taskContractVersion}`);
  }
  if (
    (taskContractVersion === TASK_CONTRACT_VERSION_V1_1 && capabilityProfile !== WORD_CAPABILITY_PROFILE) ||
    (taskContractVersion === TASK_CONTRACT_VERSION && capabilityProfile === WORD_CAPABILITY_PROFILE) ||
    (taskContractVersion === TASK_CONTRACT_VERSION_V1_2 && capabilityProfile !== XLSX_CAPABILITY_PROFILE) ||
    (taskContractVersion !== TASK_CONTRACT_VERSION_V1_2 && capabilityProfile === XLSX_CAPABILITY_PROFILE)
  ) {
    throw new TypeError('Task contract version and capability profile are incompatible');
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError('At least one task file is required');
  }
  if (
    files.some((file) => file?.mimeType === DOCX_MIME) &&
    (taskContractVersion !== TASK_CONTRACT_VERSION_V1_1 || capabilityProfile !== WORD_CAPABILITY_PROFILE)
  ) {
    throw new TypeError('DOCX inputs require office-file-agent.v1.1 and the Word capability profile');
  }
  if (taskContractVersion === TASK_CONTRACT_VERSION_V1_1) {
    if (
      files.length !== 1 ||
      files[0]?.mimeType !== DOCX_MIME ||
      typeof files[0]?.name !== 'string' ||
      !files[0].name.toLowerCase().endsWith('.docx')
    ) {
      throw new TypeError('Word task contract requires exactly one DOCX file');
    }
  }
  if (taskContractVersion === TASK_CONTRACT_VERSION_V1_2) {
    if (
      files.length !== 1 ||
      files[0]?.mimeType !== XLSX_MIME ||
      typeof files[0]?.name !== 'string' ||
      !files[0].name.toLowerCase().endsWith('.xlsx')
    ) {
      throw new TypeError('XLSX task contract requires exactly one XLSX file');
    }
  }

  const normalizedAcceptanceAssertions = capabilityProfile === WORD_CAPABILITY_PROFILE
    ? normalizeWordAcceptanceAssertions(acceptanceAssertions)
    : capabilityProfile === XLSX_CAPABILITY_PROFILE
      ? normalizeXlsxAcceptanceAssertions(acceptanceAssertions)
      : null;

  const inputs = files
    .map((file) => normalizeFile(file, { conversationId, sessionId, userId }))
    .sort((left, right) => left.librechatFileRef.localeCompare(right.librechatFileRef));
  const requestedVisibleArtifacts = limits.maxVisibleArtifacts;
  const maxVisibleArtifacts = [WORD_CAPABILITY_PROFILE, XLSX_CAPABILITY_PROFILE].includes(capabilityProfile)
    ? requestedVisibleArtifacts ?? 1
    : requestedVisibleArtifacts ?? MAX_VISIBLE_ARTIFACTS;
  if (
    !Number.isSafeInteger(maxVisibleArtifacts) ||
    maxVisibleArtifacts < 1 ||
    maxVisibleArtifacts > MAX_VISIBLE_ARTIFACTS
  ) {
    throw new TypeError(`limits.maxVisibleArtifacts must be between 1 and ${MAX_VISIBLE_ARTIFACTS}`);
  }
  if (capabilityProfile === WORD_CAPABILITY_PROFILE && maxVisibleArtifacts !== 1) {
    throw new TypeError('Word tasks allow exactly one visible artifact');
  }
  if (capabilityProfile === XLSX_CAPABILITY_PROFILE && maxVisibleArtifacts !== 1) {
    throw new TypeError('XLSX tasks allow exactly one visible artifact');
  }
  const idempotencyKey = sha256([
    conversationId,
    userMessageId,
    ...inputs.map((input) => `${input.librechatFileRef}:${input.sha256}`),
    taskContractVersion,
    normalizedAcceptanceAssertions ? digestJson(normalizedAcceptanceAssertions) : '',
  ].join('\0'));
  const manifest = {
    schemaVersion: '1.0',
    taskContractVersion,
    taskType: TASK_TYPE,
    intent: instruction,
    acceptance: acceptance.length > 0
      ? acceptance.map((entry) => requiredString(entry, 'acceptance'))
      : ['Produce only verified final artifacts from the authorized input files'],
    ...(normalizedAcceptanceAssertions
      ? { acceptanceAssertions: structuredClone(normalizedAcceptanceAssertions) }
      : {}),
    identity: {
      tenantScope: tenantId ? opaqueRef('tenant', tenantId) : null,
      userScope: opaqueRef('user', userId),
      conversationRef: opaqueRef('conversation', conversationId),
      messageRef: opaqueRef('message', userMessageId),
    },
    model: {
      modelRouteId,
      capabilityProfile,
    },
    billingRef: billingSnapshotRef,
    execution: {
      executor: 'codeapi',
      sessionId,
    },
    inputs,
    limits: {
      maxVisibleArtifacts,
      maxWallTimeSeconds: limits.maxWallTimeSeconds ?? 900,
      maxContextTokens: limits.maxContextTokens ?? 180_000,
    },
  };

  return {
    idempotencyKey,
    manifest,
    manifestDigest: digestJson(manifest),
  };
}
