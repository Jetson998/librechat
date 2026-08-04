import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_RUNTIME_CAPABILITIES } from '../../file-agent-runtime/src/http-server.js';
import {
  DOCX_MIME,
  PPTX_CAPABILITY_PROFILE,
  PPTX_MIME,
  TASK_CONTRACT_VERSION,
  TASK_CONTRACT_VERSION_V1_1,
  TASK_CONTRACT_VERSION_V1_2,
  WORD_CAPABILITY_PROFILE,
} from '../src/constants.js';
import { buildTaskSubmission } from '../src/task-manifest-builder.js';
import { decideFileAgentCapabilityRoute } from '../src/task-router.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
    acceptanceAssertions: [{
      type: 'word.text_replace.v1',
      find: 'Source paragraph',
      replace: 'Updated paragraph',
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
    buildTaskSubmission({
      ...request({
        files: [{ ...request().files[0], name: 'source.xlsx', mimeType: XLSX_MIME }],
      }),
      taskContractVersion: TASK_CONTRACT_VERSION,
    }).idempotencyKey,
  );
});

test('PPTX task manifest uses v1.2 and the PPTX capability profile', () => {
  const built = buildTaskSubmission({
    ...request({
      instruction: '更新这个 PowerPoint 并交付修订版',
      files: [{ ...request().files[0], name: 'source.pptx', mimeType: PPTX_MIME }],
      acceptanceAssertions: [
        { type: 'pptx.text_value.v1', slide: 1, shape: 'TitleBox', value: 'Updated' },
      ],
    }),
    capabilityProfile: PPTX_CAPABILITY_PROFILE,
  });
  assert.equal(built.manifest.taskContractVersion, TASK_CONTRACT_VERSION_V1_2);
  assert.equal(built.manifest.model.capabilityProfile, PPTX_CAPABILITY_PROFILE);
  assert.equal(built.manifest.inputs[0].mimeType, PPTX_MIME);
  assert.equal(built.manifest.acceptanceAssertions[0].type, 'pptx.text_value.v1');
});

test('Task manifest builder rejects contract/profile mismatches', () => {
  assert.throws(
    () => buildTaskSubmission({
      ...request(),
      taskContractVersion: TASK_CONTRACT_VERSION_V1_1,
    }),
    /incompatible/,
  );
  const autoWord = buildTaskSubmission({
    ...request(),
    capabilityProfile: WORD_CAPABILITY_PROFILE,
  });
  assert.equal(autoWord.manifest.taskContractVersion, TASK_CONTRACT_VERSION_V1_1);
  assert.equal(autoWord.manifest.model.capabilityProfile, WORD_CAPABILITY_PROFILE);
  assert.throws(
    () => buildTaskSubmission({
      ...request({ files: [{ ...request().files[0], name: 'source.xlsx' }] }),
      taskContractVersion: TASK_CONTRACT_VERSION_V1_1,
      capabilityProfile: WORD_CAPABILITY_PROFILE,
    }),
    /exactly one DOCX file/,
  );
  assert.throws(
    () => buildTaskSubmission(request()),
    /DOCX inputs require office-file-agent.v1.1/,
  );
});

test('Word capability routing requires the v1.1 contract and DOCX output support', () => {
  const files = [{ mimeType: DOCX_MIME }];
  assert.deepEqual(
    decideFileAgentCapabilityRoute({
      files,
      capabilities: DEFAULT_RUNTIME_CAPABILITIES,
    }),
    { route: 'native', reason: 'word_capability_profile_required' },
  );
  assert.deepEqual(
    decideFileAgentCapabilityRoute({
      files,
      capabilityProfile: WORD_CAPABILITY_PROFILE,
      capabilities: DEFAULT_RUNTIME_CAPABILITIES,
    }),
    { route: 'runtime', reason: 'eligible_complex_file_task' },
  );
  assert.deepEqual(
    decideFileAgentCapabilityRoute({
      files,
      capabilityProfile: WORD_CAPABILITY_PROFILE,
      capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES, taskContractVersions: [TASK_CONTRACT_VERSION] },
    }),
    { route: 'native', reason: 'runtime_contract_unsupported' },
  );
  assert.deepEqual(
    decideFileAgentCapabilityRoute({
      files,
      capabilityProfile: WORD_CAPABILITY_PROFILE,
      capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES, outputMimeTypes: [] },
    }),
    { route: 'native', reason: 'runtime_output_type_unsupported' },
  );
  assert.deepEqual(
    decideFileAgentCapabilityRoute({
      files: [{ mimeType: XLSX_MIME }],
      capabilityProfile: WORD_CAPABILITY_PROFILE,
      capabilities: DEFAULT_RUNTIME_CAPABILITIES,
    }),
    { route: 'native', reason: 'word_input_contract_unsupported' },
  );
});
