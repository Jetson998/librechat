import path from 'node:path';

import { MAX_VISIBLE_ARTIFACTS, MIME_EXTENSIONS } from './constants.js';

export class ArtifactPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArtifactPolicyError';
  }
}

function validateArtifact(artifact, allowedOutputMimeTypes) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new ArtifactPolicyError('Runtime artifact must be an object');
  }
  if (typeof artifact.name !== 'string' || artifact.name.trim() === '') {
    throw new ArtifactPolicyError('Runtime artifact name is required');
  }
  if (!allowedOutputMimeTypes.includes(artifact.mimeType)) {
    throw new ArtifactPolicyError(`Runtime artifact MIME is not allowed: ${artifact.mimeType}`);
  }
  const allowedExtensions = MIME_EXTENSIONS[artifact.mimeType];
  if (!allowedExtensions?.has(path.extname(artifact.name).toLowerCase())) {
    throw new ArtifactPolicyError('Runtime artifact extension does not match its MIME type');
  }
  if (
    !artifact.codeEnvRef ||
    typeof artifact.codeEnvRef.file_id !== 'string' ||
    typeof artifact.codeEnvRef.storage_session_id !== 'string'
  ) {
    throw new ArtifactPolicyError('Runtime artifact requires a CodeAPI reference');
  }
  if (artifact.size != null && (!Number.isSafeInteger(artifact.size) || artifact.size < 1)) {
    throw new ArtifactPolicyError('Runtime artifact size must be a positive safe integer');
  }
}

export class ArtifactDelivery {
  constructor({ store, ports }) {
    this.store = store;
    this.ports = ports;
  }

  async deliver(deliveryId, artifact, runtimeTask) {
    const delivery = await this.store.get(deliveryId);
    const artifactId = artifact?.codeEnvRef?.file_id;
    if (artifactId && delivery.artifactReceipts[artifactId]?.status === 'completed') {
      return delivery;
    }
    if (runtimeTask?.verification?.passed !== true) {
      throw new ArtifactPolicyError('Runtime artifact cannot be delivered before verification passes');
    }
    validateArtifact(artifact, delivery.allowedOutputMimeTypes);
    const completedCount = Object.values(delivery.artifactReceipts)
      .filter((receipt) => receipt.status === 'completed').length;
    const limit = delivery.maxVisibleArtifacts ?? MAX_VISIBLE_ARTIFACTS;
    if (completedCount >= limit) {
      throw new ArtifactPolicyError(`Runtime produced more than ${limit} visible artifacts`);
    }
    const file = await this.ports.processCodeOutput({ artifactId, artifact, delivery });
    return this.store.mutate(deliveryId, (draft) => {
      draft.artifactReceipts[artifactId] = {
        status: 'completed',
        fileId: file.fileId,
        name: artifact.name,
        toolCallId: file.toolCallId ?? file.file?.toolCallId ?? `file-agent:${artifactId}`,
      };
    });
  }
}
