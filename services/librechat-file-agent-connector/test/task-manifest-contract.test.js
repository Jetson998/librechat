import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TASK_CONTRACT_VERSION,
  TASK_CONTRACT_VERSION_V1_1,
  WORD_CAPABILITY_PROFILE,
} from '../src/constants.js';
import { buildTaskSubmission } from '../src/task-manifest-builder.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function request(overrides = {}) {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    instruction: '修改这个 Word 文档并交付修订版',
    files: [{
      fileId: 'file-1',
      name: 'source.docx',
      mimeType: DOCX_MIME,
      sha256: 'a'.repeat(64),
      conversationId: 'conversation-1',
      ownershipVerified: true,
      codeEnvRef: {
        storage_session_id: 'session-1',
        file_id: 'codeapi-file-1',
      },
    }],
    sessionId: 'session-1',
    modelRouteId: 'file-agent-primary',
    billingSnapshotRef: 'billing-1',
    ...overrides,
  };
}

test('Word task manifest uses v1.1 only with the Word capability profile', () => {
  const built = buildTaskSubmission({
    ...request(),
    taskContractVersion: TASK_CONTRACT_VERSION_V1_1,
    capabilityProfile: WORD_CAPABILITY_PROFILE,
  });
  assert.equal(built.manifest.taskContractVersion, TASK_CONTRACT_VERSION_V1_1);
  assert.equal(built.manifest.model.capabilityProfile, WORD_CAPABILITY_PROFILE);
  assert.notEqual(
    built.idempotencyKey,
    buildTaskSubmission({ ...request(), taskContractVersion: TASK_CONTRACT_VERSION }).idempotencyKey,
  );
});

test('Task manifest builder rejects contract/profile mismatches', () => {
  assert.throws(
    () => buildTaskSubmission({
      ...request(),
      taskContractVersion: TASK_CONTRACT_VERSION_V1_1,
    }),
    /incompatible/,
  );
  assert.throws(
    () => buildTaskSubmission({
      ...request(),
      capabilityProfile: WORD_CAPABILITY_PROFILE,
    }),
    /incompatible/,
  );
});
