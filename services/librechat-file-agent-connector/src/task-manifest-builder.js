import {
  DEFAULT_CAPABILITY_PROFILE,
  MAX_VISIBLE_ARTIFACTS,
  TASK_CONTRACT_VERSION,
  TASK_TYPE,
} from './constants.js';
import { digestJson, opaqueRef, requiredString, sha256 } from './stable.js';

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
  acceptance = [],
  limits = {},
}) {
  userId = requiredString(userId, 'userId');
  conversationId = requiredString(conversationId, 'conversationId');
  userMessageId = requiredString(userMessageId, 'userMessageId');
  instruction = requiredString(instruction, 'instruction');
  sessionId = requiredString(sessionId, 'sessionId');
  modelRouteId = requiredString(modelRouteId, 'modelRouteId');
  billingSnapshotRef = requiredString(billingSnapshotRef, 'billingSnapshotRef');
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError('At least one task file is required');
  }

  const inputs = files
    .map((file) => normalizeFile(file, { conversationId, sessionId, userId }))
    .sort((left, right) => left.librechatFileRef.localeCompare(right.librechatFileRef));
  const maxVisibleArtifacts = limits.maxVisibleArtifacts ?? MAX_VISIBLE_ARTIFACTS;
  if (
    !Number.isSafeInteger(maxVisibleArtifacts) ||
    maxVisibleArtifacts < 1 ||
    maxVisibleArtifacts > MAX_VISIBLE_ARTIFACTS
  ) {
    throw new TypeError(`limits.maxVisibleArtifacts must be between 1 and ${MAX_VISIBLE_ARTIFACTS}`);
  }
  const idempotencyKey = sha256([
    conversationId,
    userMessageId,
    ...inputs.map((input) => `${input.librechatFileRef}:${input.sha256}`),
    TASK_CONTRACT_VERSION,
  ].join('\0'));
  const manifest = {
    schemaVersion: '1.0',
    taskContractVersion: TASK_CONTRACT_VERSION,
    taskType: TASK_TYPE,
    intent: instruction,
    acceptance: acceptance.length > 0
      ? acceptance.map((entry) => requiredString(entry, 'acceptance'))
      : ['Produce only verified final artifacts from the authorized input files'],
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
