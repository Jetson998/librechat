import { TASK_TYPE } from './constants.js';
import { clone, opaqueRef, requiredString, sha256 } from './stable.js';

function assertTurnScope(activeTask, request) {
  if (
    activeTask.user !== request.userId ||
    (activeTask.tenantId ?? null) !== (request.tenantId ?? null) ||
    activeTask.conversationId !== request.conversationId
  ) {
    throw new Error('Turn does not belong to the active task scope');
  }
}

function assertTurnIdentifiers({ userMessageId, assistantMessageId, streamId }) {
  return {
    userMessageId: requiredString(userMessageId, 'userMessageId'),
    assistantMessageId: requiredString(assistantMessageId, 'assistantMessageId'),
    streamId: requiredString(streamId, 'streamId'),
  };
}

function buildTurnDescriptor({
  activeTask,
  turnType,
  userMessageId,
  assistantMessageId,
  streamId,
  instructionId,
  instruction,
  inputRebind = null,
}) {
  const normalizedIdentifiers = assertTurnIdentifiers({
    userMessageId,
    assistantMessageId,
    streamId,
  });
  const normalizedInstruction = requiredString(instruction, 'instruction');
  const normalizedInstructionId = requiredString(instructionId, 'instructionId');
  const idempotencyKey = sha256(JSON.stringify({
    type: `file-agent-${turnType}`,
    taskId: activeTask.taskId,
    ...normalizedIdentifiers,
    instructionId: normalizedInstructionId,
    instruction: normalizedInstruction,
    routeConfigDigest: activeTask.routeConfigDigest ?? null,
    inputRebind,
  }));
  const manifest = {
    schemaVersion: '1.0',
    taskContractVersion: activeTask.taskContractVersion,
    taskType: TASK_TYPE,
    turnType,
    taskId: activeTask.taskId,
  };
  const record = {
    taskId: activeTask.taskId,
    activeTaskId: activeTask.activeTaskId,
    turnType,
    user: activeTask.user,
    tenantId: activeTask.tenantId,
    conversationId: activeTask.conversationId,
    ...normalizedIdentifiers,
    taskContractVersion: activeTask.taskContractVersion,
    capabilityProfile: activeTask.capabilityProfile,
    billingSnapshotRef: activeTask.billingSnapshotRef,
    modelRouteId: activeTask.modelRouteId,
    ...(activeTask.providerRouteRef
      ? {
          providerRouteRef: activeTask.providerRouteRef,
          providerEndpoint: activeTask.providerEndpoint,
          providerModel: activeTask.providerModel,
          providerProtocol: activeTask.providerProtocol,
          routeConfigDigest: activeTask.routeConfigDigest,
        }
      : {}),
    allowedOutputMimeTypes: clone(activeTask.allowedOutputMimeTypes ?? []),
    maxVisibleArtifacts: activeTask.maxVisibleArtifacts ?? 1,
    status: 'running',
    runtimePhase: activeTask.runtimePhase,
    lastSequence: activeTask.latestSequence,
    usageReceipts: clone(activeTask.usageReceipts),
    artifactReceipts: clone(activeTask.artifactReceipts),
    finalization: {
      messageSaved: false,
      finalEventSaved: false,
      jobCompleted: false,
    },
    retry: { attempts: 0, nextAt: null, lastErrorCode: null },
    steer: {
      instructionId: normalizedInstructionId,
      text: normalizedInstruction.slice(0, 8_000),
      submitted: false,
    },
    ...(inputRebind ? { inputRebind: clone(inputRebind) } : {}),
    submission: {
      idempotencyKey,
      manifest: clone(manifest),
    },
  };
  return {
    idempotencyKey,
    manifest,
    record,
    turn: {
      deliveryId: null,
      ...normalizedIdentifiers,
      turnType,
    },
    instruction: {
      instructionId: normalizedInstructionId,
      text: normalizedInstruction.slice(0, 8_000),
      ...(inputRebind ? { inputRebind: clone(inputRebind) } : {}),
    },
  };
}

function normalizeRebindInputs(activeTask, files, userId, conversationId) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError('files are required for an input rebind');
  }
  const authorized = new Map(
    (activeTask.inputRefs ?? []).map((input) => [input.librechatFileRef, input]),
  );
  const seen = new Set();
  const inputs = files.map((file) => {
    if (file?.ownershipVerified !== true || file.conversationId !== conversationId) {
      throw new Error('Rebound file ownership must be verified for the task conversation');
    }
    const fileId = requiredString(file?.fileId, 'file.fileId');
    const librechatFileRef = opaqueRef('file', fileId);
    if (file.librechatFileRef && file.librechatFileRef !== librechatFileRef) {
      throw new Error('Rebound file reference does not match fileId');
    }
    const original = authorized.get(librechatFileRef);
    if (!original) {
      throw new Error('Input rebind must reference an authorized task input');
    }
    if (seen.has(librechatFileRef)) {
      throw new Error('Input rebind contains a duplicate task input');
    }
    seen.add(librechatFileRef);
    const codeEnvRef = file.codeEnvRef;
    if (
      !codeEnvRef ||
      typeof codeEnvRef.storage_session_id !== 'string' ||
      codeEnvRef.storage_session_id.trim() === '' ||
      typeof codeEnvRef.file_id !== 'string' ||
      codeEnvRef.file_id.trim() === ''
    ) {
      throw new TypeError('Rebound file requires a primed CodeAPI reference');
    }
    if (file.sha256 && file.sha256 !== original.sha256) {
      throw new Error('Input rebind cannot change the authorized file content hash');
    }
    if (file.mimeType && file.mimeType !== original.mimeType) {
      throw new Error('Input rebind cannot change the authorized file MIME type');
    }
    return {
      ...clone(original),
      codeEnvRef: {
        ...clone(original.codeEnvRef),
        kind: 'user',
        id: original.codeEnvRef?.id ?? opaqueRef('user', userId),
        resource_id: original.codeEnvRef?.resource_id ?? userId,
        storage_session_id: codeEnvRef.storage_session_id.trim(),
        file_id: codeEnvRef.file_id.trim(),
      },
    };
  });
  if (seen.size !== authorized.size) {
    throw new Error('Input rebind must provide every authorized task input');
  }
  return inputs.sort((left, right) => left.librechatFileRef.localeCompare(right.librechatFileRef));
}

export function buildSteerTurn({
  activeTask,
  userId,
  tenantId = null,
  conversationId,
  userMessageId,
  assistantMessageId,
  streamId,
  instruction,
  instructionId = null,
  billingSnapshotRef,
  modelRouteId,
}) {
  if (!activeTask || typeof activeTask !== 'object') {
    throw new TypeError('activeTask is required');
  }
  if (['completed', 'failed', 'canceled'].includes(activeTask.status)) {
    throw new Error(`Cannot steer terminal task: ${activeTask.status}`);
  }
  const normalizedUserId = requiredString(userId, 'userId');
  const normalizedConversationId = requiredString(conversationId, 'conversationId');
  assertTurnScope(activeTask, {
    userId: normalizedUserId,
    tenantId,
    conversationId: normalizedConversationId,
  });
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new TypeError('instruction is required for a steer turn');
  }
  if (billingSnapshotRef && billingSnapshotRef !== activeTask.billingSnapshotRef) {
    throw new Error('Steer turn billing snapshot must match the active task');
  }
  if (modelRouteId && modelRouteId !== activeTask.modelRouteId) {
    throw new Error('Steer turn model route must match the active task');
  }
  instructionId ??= sha256([
    'file-agent-instruction',
    activeTask.taskId,
    userMessageId,
    assistantMessageId,
    streamId,
    instruction.trim(),
  ].join('\0'));
  return buildTurnDescriptor({
    activeTask,
    turnType: 'steer',
    userMessageId,
    assistantMessageId,
    streamId,
    instructionId,
    instruction,
  });
}

export function buildRebindTurn({
  activeTask,
  userId,
  tenantId = null,
  conversationId,
  userMessageId,
  assistantMessageId,
  streamId,
  instruction,
  instructionId = null,
  files,
}) {
  if (!activeTask || typeof activeTask !== 'object') {
    throw new TypeError('activeTask is required');
  }
  if (['completed', 'failed', 'canceled'].includes(activeTask.status)) {
    throw new Error(`Cannot rebind terminal task: ${activeTask.status}`);
  }
  const normalizedUserId = requiredString(userId, 'userId');
  const normalizedConversationId = requiredString(conversationId, 'conversationId');
  assertTurnScope(activeTask, {
    userId: normalizedUserId,
    tenantId,
    conversationId: normalizedConversationId,
  });
  const inputRebind = {
    schemaVersion: '1.0',
    taskId: activeTask.taskId,
    inputs: normalizeRebindInputs(activeTask, files, normalizedUserId, normalizedConversationId),
  };
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new TypeError('instruction is required for an input rebind turn');
  }
  instructionId ??= sha256([
    'file-agent-rebind-instruction',
    activeTask.taskId,
    userMessageId,
    assistantMessageId,
    streamId,
    instruction.trim(),
    JSON.stringify(inputRebind),
  ].join('\0'));
  const descriptor = buildTurnDescriptor({
    activeTask,
    turnType: 'rebind',
    userMessageId,
    assistantMessageId,
    streamId,
    instructionId,
    instruction,
    inputRebind,
  });
  return descriptor;
}
