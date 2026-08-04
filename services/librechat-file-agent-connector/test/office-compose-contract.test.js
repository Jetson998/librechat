import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOCX_MIME,
  OFFICE_COMPOSE_CAPABILITY_PROFILE,
  PPTX_MIME,
  TASK_CONTRACT_VERSION_V1_2,
  XLSX_MIME,
} from '../src/constants.js';
import { resolveOfficeComposeAcceptanceAssertions, sourceLogicalIdForFile } from '../src/office-compose-acceptance-resolver.js';
import { buildTaskSubmission } from '../src/task-manifest-builder.js';
import { decideFileAgentCapabilityRoute } from '../src/task-router.js';
import { createUpstreamRuntimeRequestResolver, contentSha256 } from '../src/upstream-controller-adapter.js';

function file({ fileId, filename, type, content }) {
  return {
    file_id: fileId,
    user: 'user-1',
    tenantId: 'tenant-1',
    filename,
    type,
    content: Buffer.from(content),
    metadata: {
      codeEnvRef: {
        kind: 'user',
        id: 'user-1',
        storage_session_id: 'session-1',
        file_id: `codeapi-${fileId}`,
      },
    },
  };
}

function requestContext(attachments, text = '根据 Source!A1 和第1段生成 PPTX 汇报') {
  return {
    req: {
      user: { id: 'user-1', tenantId: 'tenant-1' },
      body: { files: attachments.map((entry) => ({ file_id: entry.file_id })) },
      config: {},
    },
    client: {
      options: {
        attachments,
        agent: { endpoint: 'custom', model: 'compose-model' },
      },
    },
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    assistantMessageId: 'assistant-1',
    streamId: 'stream-1',
    text,
  };
}

test('Office Compose resolver creates explicit source mappings for one XLSX and one DOCX', () => {
  const sources = [
    file({ fileId: 'xlsx-1', filename: 'finance.xlsx', type: XLSX_MIME, content: 'xlsx' }),
    file({ fileId: 'docx-1', filename: 'brief.docx', type: DOCX_MIME, content: 'docx' }),
  ];
  const assertions = resolveOfficeComposeAcceptanceAssertions({
    files: sources,
    instruction: '根据 Source!A1 和第1段生成 PPTX 汇报',
  });
  assert.ok(assertions);
  assert.equal(assertions.filter((entry) => entry.type === 'compose.source_mapping.v1').length, 2);
  assert.deepEqual(
    assertions.filter((entry) => entry.type === 'compose.source_mapping.v1').map((entry) => entry.sourceLocation),
    ['Source!A1', 'body.paragraph[0]'],
  );
  assert.equal(assertions.at(-1).type, 'compose.artifact.v1');
  assert.equal(
    assertions.find((entry) => entry.type === 'compose.source_mapping.v1').sourceLogicalId,
    sourceLogicalIdForFile(sources[0]),
  );
});

test('Office Compose manifest and Runtime routing use v1.2 and one PPTX output', async () => {
  const xlsx = file({ fileId: 'xlsx-1', filename: 'finance.xlsx', type: XLSX_MIME, content: 'xlsx' });
  const docx = file({ fileId: 'docx-1', filename: 'brief.docx', type: DOCX_MIME, content: 'docx' });
  const attachments = [xlsx, docx];
  const assertions = resolveOfficeComposeAcceptanceAssertions({
    files: attachments,
    instruction: '根据 Source!A1 和第1段生成 PPTX 汇报',
  });
  const built = buildTaskSubmission({
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    instruction: '根据 Source!A1 和第1段生成 PPTX 汇报',
    files: attachments.map((entry) => ({
      fileId: entry.file_id,
      name: entry.filename,
      mimeType: entry.type,
      sha256: entry.file_id === 'xlsx-1' ? 'a'.repeat(64) : 'b'.repeat(64),
      conversationId: 'conversation-1',
      ownershipVerified: true,
      codeEnvRef: entry.metadata.codeEnvRef,
    })),
    sessionId: 'session-1',
    modelRouteId: 'file-agent-compose',
    billingSnapshotRef: 'billing-1',
    capabilityProfile: OFFICE_COMPOSE_CAPABILITY_PROFILE,
    taskContractVersion: TASK_CONTRACT_VERSION_V1_2,
    acceptanceAssertions: assertions,
  });
  assert.equal(built.manifest.taskContractVersion, TASK_CONTRACT_VERSION_V1_2);
  assert.equal(built.manifest.model.capabilityProfile, OFFICE_COMPOSE_CAPABILITY_PROFILE);
  assert.deepEqual(built.manifest.inputs.map((entry) => entry.mimeType).sort(), [DOCX_MIME, XLSX_MIME].sort());
  assert.equal(built.manifest.limits.maxVisibleArtifacts, 1);

  const route = decideFileAgentCapabilityRoute({
    files: attachments.map((entry) => ({ mimeType: entry.type })),
    capabilityProfile: OFFICE_COMPOSE_CAPABILITY_PROFILE,
    capabilities: {
      taskContractVersions: [TASK_CONTRACT_VERSION_V1_2],
      taskTypes: ['office_transform'],
      capabilityProfiles: [OFFICE_COMPOSE_CAPABILITY_PROFILE],
      inputMimeTypes: [DOCX_MIME, XLSX_MIME],
      outputMimeTypes: [PPTX_MIME],
      maxInputFiles: 2,
    },
  });
  assert.deepEqual(route, { route: 'runtime', reason: 'eligible_complex_file_task' });

  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-compose',
    capabilityProfile: OFFICE_COMPOSE_CAPABILITY_PROFILE,
    taskContractVersion: TASK_CONTRACT_VERSION_V1_2,
    resolveAcceptanceAssertions: resolveOfficeComposeAcceptanceAssertions,
  });
  const request = await resolve(requestContext(attachments));
  assert.equal(request.capabilityProfile, OFFICE_COMPOSE_CAPABILITY_PROFILE);
  assert.equal(request.taskContractVersion, TASK_CONTRACT_VERSION_V1_2);
  assert.equal(request.files.length, 2);
  assert.equal(request.files[0].sha256.length, 64);
  assert.ok(request.acceptanceAssertions.some((entry) => entry.type === 'compose.source_mapping.v1'));
  assert.equal(request.files[0].logicalId, sourceLogicalIdForFile(attachments[0]));
  assert.equal(request.files[0].sha256, await contentSha256(attachments[0]));
});

test('Office Compose resolver fails closed when a source location is omitted or output asks for multiple files', () => {
  const xlsx = file({ fileId: 'xlsx-1', filename: 'finance.xlsx', type: XLSX_MIME, content: 'xlsx' });
  assert.equal(
    resolveOfficeComposeAcceptanceAssertions({ files: [xlsx], instruction: '生成 PPTX 汇报' }),
    null,
  );
  assert.equal(
    resolveOfficeComposeAcceptanceAssertions({ files: [xlsx], instruction: '根据 Source!A1 生成两个 PPTX 文件' }),
    null,
  );
});
