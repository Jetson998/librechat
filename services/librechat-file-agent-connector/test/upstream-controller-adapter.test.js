import assert from 'node:assert/strict';
import test from 'node:test';

import {
  XLSX_MIME,
  codeEnvObjectDigest,
  createUpstreamBillingSnapshotCreator,
  createUpstreamMongoCollections,
  createUpstreamRuntimeRequestResolver,
  installUpstreamControllerBridge,
} from '../src/upstream-controller-adapter.js';

function attachment(overrides = {}) {
  return {
    file_id: 'file-1',
    user: 'user-1',
    tenantId: 'tenant-1',
    filename: 'source.xlsx',
    bytes: 2048,
    type: XLSX_MIME,
    metadata: {
      codeEnvRef: {
        kind: 'user',
        id: 'user-1',
        storage_session_id: 'storage-session-1',
        file_id: 'codeapi-file-1',
      },
    },
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    req: {
      user: { id: 'user-1', tenantId: 'tenant-1' },
      body: { files: [{ file_id: 'file-1' }] },
      config: { balance: { enabled: true }, transactions: { enabled: true } },
    },
    client: {
      options: {
        endpoint: 'agents',
        endpointTokenConfig: {
          'gpt-5.6-sol': { prompt: 0.6, completion: 3.6, read: 0.06, write: 0.75 },
        },
        agent: { endpoint: 'custom', model: 'gpt-5.6-sol' },
        attachments: [attachment()],
      },
    },
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    assistantMessageId: 'message-1_',
    streamId: 'conversation-1',
    text: '根据工作簿生成汇总 Excel',
    ...overrides,
  };
}

test('upstream request resolver uses initialized current-request attachments', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-primary',
  });

  const request = await resolve(context());

  assert.equal(request.userId, 'user-1');
  assert.equal(request.tenantId, 'tenant-1');
  assert.equal(request.sessionId, 'storage-session-1');
  assert.equal(request.files.length, 1);
  assert.deepEqual(request.files[0].codeEnvRef, {
    storage_session_id: 'storage-session-1',
    file_id: 'codeapi-file-1',
  });
  assert.equal(request.files[0].conversationId, 'conversation-1');
  assert.equal(request.files[0].ownershipVerified, true);
  assert.equal(request.files[0].sha256, codeEnvObjectDigest(attachment()));
});

test('upstream request resolver rejects files not authorized by initialized LibreChat context', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-primary',
  });
  const result = await resolve(context({
    client: {
      options: {
        attachments: [attachment({ user: 'other-user' })],
      },
    },
  }));

  assert.deepEqual(result, {
    route: 'native',
    reason: 'current_request_file_owner_mismatch',
  });
});

test('unsupported turn modes return native before file or Runtime work', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-primary',
  });
  const ctx = context();
  ctx.req.body.isTemporary = true;

  assert.deepEqual(await resolve(ctx), {
    route: 'native',
    reason: 'temporary_chat_unsupported',
  });
});

test('different CodeAPI storage sessions are rejected before persistence', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-primary',
  });
  const ctx = context();
  ctx.req.body.files.push({ file_id: 'file-2' });
  ctx.client.options.attachments.push(attachment({
    file_id: 'file-2',
    filename: 'source-2.xlsx',
    metadata: {
      codeEnvRef: {
        kind: 'user',
        id: 'user-1',
        storage_session_id: 'storage-session-2',
        file_id: 'codeapi-file-2',
      },
    },
  }));

  assert.deepEqual(await resolve(ctx), {
    route: 'native',
    reason: 'multiple_codeapi_storage_sessions_unsupported',
  });
});

test('billing snapshot freezes the effective native token rates', async () => {
  let created = null;
  const createSnapshot = createUpstreamBillingSnapshotCreator({
    billingSnapshotStore: {
      create: async (value) => {
        created = structuredClone(value);
        return { snapshotId: 'snapshot-1', ...created };
      },
    },
    getBalanceConfig: (config) => config.balance,
    getTransactionsConfig: (config) => config.transactions,
    getMultiplier: ({ endpointTokenConfig, model, tokenType }) =>
      endpointTokenConfig[model][tokenType],
    getCacheMultiplier: ({ endpointTokenConfig, model, cacheType }) =>
      endpointTokenConfig[model][cacheType],
  });

  const ctx = context();
  const snapshot = await createSnapshot({
    ...ctx,
    request: { userId: 'user-1', modelRouteId: 'file-agent-primary' },
  });

  assert.equal(snapshot.snapshotId, 'snapshot-1');
  assert.deepEqual(created.prices, {
    prompt: 0.6,
    completion: 3.6,
    cacheRead: 0.06,
    cacheWrite: 0.75,
  });
  assert.deepEqual(created.balance, { enabled: true });
  assert.deepEqual(created.transactions, { enabled: true });
  ctx.client.options.endpointTokenConfig['gpt-5.6-sol'].prompt = 99;
  assert.equal(created.endpointTokenConfig['gpt-5.6-sol'].prompt, 0.6);
});

test('billing snapshot rejects negative resolved prices and stores only the current model config', async () => {
  let created = null;
  const createSnapshot = createUpstreamBillingSnapshotCreator({
    billingSnapshotStore: {
      create: async (value) => {
        created = structuredClone(value);
        return { snapshotId: 'snapshot-1', ...created };
      },
    },
    getBalanceConfig: () => ({ enabled: true }),
    getTransactionsConfig: () => ({ enabled: true }),
    getMultiplier: ({ tokenType }) => (tokenType === 'prompt' ? 0.6 : 3.6),
    getCacheMultiplier: ({ cacheType }) => (cacheType === 'read' ? 0.06 : 0.75),
  });
  const ctx = context();
  ctx.client.options.endpointTokenConfig['other-model'] = { prompt: 99, completion: 99 };
  await createSnapshot({
    ...ctx,
    request: { userId: 'user-1', modelRouteId: 'file-agent-primary' },
  });
  assert.deepEqual(Object.keys(created.endpointTokenConfig), ['gpt-5.6-sol']);

  const invalid = createUpstreamBillingSnapshotCreator({
    billingSnapshotStore: { create: async () => ({ snapshotId: 'unreachable' }) },
    getBalanceConfig: () => ({ enabled: true }),
    getTransactionsConfig: () => ({ enabled: true }),
    getMultiplier: ({ tokenType }) => (tokenType === 'prompt' ? -0.6 : 3.6),
    getCacheMultiplier: () => null,
  });
  await assert.rejects(
    invalid({
      ...ctx,
      request: { userId: 'user-1', modelRouteId: 'file-agent-primary' },
    }),
    /non-negative finite rate/,
  );
});

test('upstream Mongo collection names and Express bridge installation are explicit', () => {
  const requestedNames = [];
  const collections = createUpstreamMongoCollections({
    database: {
      collection: (name) => {
        requestedNames.push(name);
        return { name };
      },
    },
    deliveryCollectionName: 'file_agent_nonprod_deliveries',
    billingSnapshotCollectionName: 'file_agent_nonprod_billing_snapshots',
    transactionCollectionName: 'transactions',
  });
  assert.deepEqual(requestedNames, [
    'file_agent_nonprod_deliveries',
    'file_agent_nonprod_billing_snapshots',
    'transactions',
  ]);
  assert.equal(collections.deliveries.name, 'file_agent_nonprod_deliveries');

  const app = { locals: {} };
  const bridge = { tryRoute: async () => ({ suppressNativeAgent: false }) };
  const uninstall = installUpstreamControllerBridge({ app, bridge });
  assert.equal(app.locals.fileAgentRuntimeBridge, bridge);
  assert.throws(
    () => installUpstreamControllerBridge({ app, bridge }),
    /already has/,
  );
  uninstall();
  assert.equal(app.locals.fileAgentRuntimeBridge, undefined);
});
