import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTaskSubmission } from '../src/task-manifest-builder.js';
import { createUpstreamRuntimeRequestResolver } from '../src/upstream-controller-adapter.js';
import { XLSX_MIME } from '../src/constants.js';

const ROUTE_MAP = {
  schemaVersion: 1,
  routes: [
    {
      librechatEndpoint: 'Muskapis-openai',
      providerRouteRef: 'custom:Muskapis-openai',
      providerEndpoint: 'Muskapis-openai',
      protocol: 'openai-compatible',
      allowedModels: ['gpt-5.6-sol'],
    },
    {
      librechatEndpoint: 'Muskapis-Anthropic',
      providerRouteRef: 'custom:Muskapis-Anthropic',
      providerEndpoint: 'Muskapis-Anthropic',
      protocol: 'anthropic-messages',
      allowedModels: ['claude-fable-5'],
    },
  ],
};

function attachment(overrides = {}) {
  return {
    file_id: 'file-1',
    user: 'user-1',
    tenantId: 'tenant-1',
    filename: 'source.xlsx',
    bytes: 12,
    type: XLSX_MIME,
    content: Buffer.from('xlsx-fixture'),
    metadata: {
      codeEnvRef: {
        kind: 'user',
        id: 'user-1',
        storage_session_id: 'storage-1',
        file_id: 'codeapi-1',
      },
    },
    ...overrides,
  };
}

function context({ endpoint = 'Muskapis-openai', model = 'gpt-5.6-sol', ...overrides } = {}) {
  const file = attachment();
  return {
    req: {
      user: { id: 'user-1', tenantId: 'tenant-1' },
      body: { files: [{ file_id: file.file_id }] },
    },
    client: {
      options: {
        agent: { endpoint, model },
        attachments: [file],
      },
    },
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    assistantMessageId: 'message-1_',
    streamId: 'stream-1',
    text: '根据工作簿生成汇总 Excel',
    ...overrides,
  };
}

test('Connector request carries the allowlisted provider route selected by LibreChat', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-primary',
    providerRouteRegistry: ROUTE_MAP,
    resolveAcceptanceAssertions: async () => [],
  });
  const request = await resolve(context());

  assert.equal(request.providerRouteRef, 'custom:Muskapis-openai');
  assert.equal(request.providerEndpoint, 'Muskapis-openai');
  assert.equal(request.providerModel, 'gpt-5.6-sol');
  assert.equal(request.providerProtocol, 'openai-compatible');
  assert.equal(request.providerApiKey, undefined);
});

test('Connector selects the explicit Anthropic protocol from the route registry', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-primary',
    providerRouteRegistry: ROUTE_MAP,
    resolveAcceptanceAssertions: async () => [],
  });
  const request = await resolve(context({
    endpoint: 'Muskapis-Anthropic',
    model: 'claude-fable-5',
  }));

  assert.deepEqual({
    providerRouteRef: request.providerRouteRef,
    providerEndpoint: request.providerEndpoint,
    providerModel: request.providerModel,
    providerProtocol: request.providerProtocol,
  }, {
    providerRouteRef: 'custom:Muskapis-Anthropic',
    providerEndpoint: 'Muskapis-Anthropic',
    providerModel: 'claude-fable-5',
    providerProtocol: 'anthropic-messages',
  });
});

test('Unknown provider route and model are fail-closed before Runtime discovery', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-primary',
    providerRouteRegistry: ROUTE_MAP,
    resolveAcceptanceAssertions: async () => [],
  });

  assert.deepEqual(await resolve(context({ endpoint: 'unregistered-endpoint' })), {
    route: 'native',
    reason: 'provider_route_unavailable',
  });
  assert.deepEqual(await resolve(context({ model: 'model-not-allowed' })), {
    route: 'native',
    reason: 'provider_model_not_allowlisted',
  });
});

test('Task manifest and idempotency identity include the selected provider route', () => {
  const base = {
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    instruction: '修改工作簿',
    files: [{
      fileId: 'file-1',
      name: 'source.xlsx',
      mimeType: XLSX_MIME,
      sha256: 'a'.repeat(64),
      conversationId: 'conversation-1',
      ownershipVerified: true,
      codeEnvRef: { storage_session_id: 'storage-1', file_id: 'codeapi-1' },
    }],
    sessionId: 'storage-1',
    modelRouteId: 'file-agent-primary-xlsx',
    billingSnapshotRef: 'billing-1',
    capabilityProfile: 'xlsx-edit-v1',
    providerRouteRef: 'custom:Muskapis-openai',
    providerEndpoint: 'Muskapis-openai',
    providerModel: 'gpt-5.6-sol',
    providerProtocol: 'openai-compatible',
    acceptanceAssertions: [{ type: 'xlsx.cell_value.v1', sheet: 'Sheet1', cell: 'A1', value: 'x' }],
  };
  const openai = buildTaskSubmission(base);
  const anthropic = buildTaskSubmission({
    ...base,
    providerRouteRef: 'custom:Muskapis-Anthropic',
    providerEndpoint: 'Muskapis-Anthropic',
    providerModel: 'claude-fable-5',
    providerProtocol: 'anthropic-messages',
  });

  assert.deepEqual(openai.manifest.model.providerRouteRef, 'custom:Muskapis-openai');
  assert.equal(openai.manifest.model.providerModel, 'gpt-5.6-sol');
  assert.equal(openai.manifest.model.providerProtocol, 'openai-compatible');
  assert.notEqual(openai.idempotencyKey, anthropic.idempotencyKey);
});
