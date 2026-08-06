import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOCX_MIME,
  XLSX_MIME,
  codeEnvObjectDigest,
  contentSha256,
  createUpstreamBillingSnapshotCreator,
  createUpstreamMongoCollections,
  createUpstreamRuntimeRequestResolver,
  createStorageBackedFileDigest,
  installUpstreamControllerBridge,
  startUpstreamLibreChatHostIntegration,
} from '../src/upstream-controller-adapter.js';
import { resolveWordAcceptanceAssertions } from '../src/word-acceptance-resolver.js';

function attachment(overrides = {}) {
  return {
    file_id: 'file-1',
    user: 'user-1',
    tenantId: 'tenant-1',
    filename: 'source.xlsx',
    bytes: 2048,
    type: XLSX_MIME,
    content: Buffer.from('xlsx-content-fixture'),
    metadata: {
      codeEnvRef: {
        kind: 'user',
        id: 'user-1',
        resource_id: 'resource-1',
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
    resource_id: 'resource-1',
    storage_session_id: 'storage-session-1',
    file_id: 'codeapi-file-1',
  });
  assert.equal(request.files[0].conversationId, 'conversation-1');
  assert.equal(request.files[0].ownershipVerified, true);
  assert.equal(request.files[0].sha256, await contentSha256(attachment()));
  assert.notEqual(request.files[0].sha256, codeEnvObjectDigest(attachment()));
  assert.equal(request.taskContractVersion, 'office-file-agent.v1');
});

test('upstream Word resolver creates the v1.1 task contract from real attachment bytes', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-word',
    resolveAcceptanceAssertions: resolveWordAcceptanceAssertions,
  });
  const base = context();
  const word = attachment({
    filename: 'source.docx',
    type: DOCX_MIME,
    content: Buffer.from('docx-content-fixture'),
  });
  const request = await resolve({
    ...base,
    text: '将“Source paragraph”替换为“Updated paragraph”，并交付修订版 Word 文档',
    client: {
      ...base.client,
      options: {
        ...base.client.options,
        attachments: [word],
      },
    },
  });

  assert.equal(request.taskContractVersion, 'office-file-agent.v1.1');
  assert.equal(request.capabilityProfile, 'word-edit-v1');
  assert.equal(request.files[0].sha256, await contentSha256(word));
  assert.deepEqual(request.acceptance, [
    'Produce one verified DOCX artifact from the authorized current-turn Word document',
  ]);
  assert.equal(request.acceptanceAssertions[0].type, 'word.text_replace.v1');
  assert.equal(request.acceptanceAssertions[0].find, 'Source paragraph');
  assert.equal(request.acceptanceAssertions[0].replace, 'Updated paragraph');
});

test('Word acceptance resolver fails closed for an ambiguous or unsupported instruction', () => {
  const file = attachment({ filename: 'source.docx', type: DOCX_MIME });
  assert.deepEqual(
    resolveWordAcceptanceAssertions({
      files: [file],
      instruction: '修改这个 Word 文档并交付修订版',
    }),
    null,
  );
  assert.deepEqual(
    resolveWordAcceptanceAssertions({
      files: [file],
      instruction: '将“Source paragraph”替换为“Updated paragraph”，然后删除页眉',
    }),
    null,
  );
});

test('Word acceptance resolver consumes supported action clauses and rejects mixed unsupported actions', () => {
  const file = attachment({ filename: 'source.docx', type: DOCX_MIME });
  const supported = [
    {
      instruction: '将“Source paragraph”替换为“Updated paragraph”，并交付修订版 Word 文档',
      type: 'word.text_replace.v1',
    },
    {
      instruction: '在文档末尾追加段落：“Conclusion”，并交付经过验证的 DOCX',
      type: 'word.paragraph_append.v1',
    },
    {
      instruction: '将第1个表格第2行第3列替换为“Updated cell”，并交付 DOCX',
      type: 'word.table_cell_replace.v1',
    },
    {
      instruction: 'replace "a" with "b" and provide one final document',
      type: 'word.text_replace.v1',
    },
  ];

  for (const { instruction, type } of supported) {
    const result = resolveWordAcceptanceAssertions({ files: [file], instruction });
    assert.ok(result);
    assert.equal(result[0].type, type);
    assert.equal(result.at(-1).type, 'word.artifact.v1');
  }

  const composite = resolveWordAcceptanceAssertions({
    files: [file],
    instruction: 'replace "a" with "b" and append a paragraph "done" and deliver a verified DOCX file',
  });
  assert.deepEqual(composite?.map((assertion) => assertion.type), [
    'word.text_replace.v1',
    'word.paragraph_append.v1',
    'word.artifact.v1',
  ]);

  const mixedUnsupported = [
    '将“甲”替换为“乙”，并调整行距',
    '在文档末尾追加段落：“结论”，同时添加页码',
    '将“甲”替换为“乙”，并翻译第二段',
    'replace "a" with "b" and add a heading',
    '将“甲”替换为“乙”，并请“调整行距”',
    '将“甲”替换为“乙”，并提供“带页码的版本”',
    '将“甲”替换为“乙”，输出“同时删除页眉的修订版”',
    'replace "a" with "b" and provide "a version with page numbers"',
    '将“甲”替换为“乙”，并提供一个最终文档，同时提供一个修订版文档',
    '将“甲”替换为“乙”，并生成一个文档以及一个文件',
    'replace "a" with "b" and provide one final document and provide one revised file',
    '将“甲”替换为“乙”，and add a heading',
    'replace "a" with "b"，并翻译第二段',
    '在文档末尾追加段落：“结论”，and add a heading',
    '将“甲”替换为“乙”，编辑文档',
    '将“甲”替换为“乙”，完成修改',
  ];

  for (const instruction of mixedUnsupported) {
    assert.equal(
      resolveWordAcceptanceAssertions({ files: [file], instruction }),
      null,
      instruction,
    );
  }
});

test('Word resolver fails closed when no independent acceptance assertions are supplied', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({ modelRouteId: 'file-agent-word' });
  const base = context();
  const result = await resolve({
    ...base,
    text: '修改这个 Word 文档并交付修订版',
    client: {
      ...base.client,
      options: {
        ...base.client.options,
        attachments: [attachment({ filename: 'source.docx', type: DOCX_MIME })],
      },
    },
  });
  assert.deepEqual(result, { route: 'native', reason: 'word_acceptance_assertions_unavailable' });
});

test('storage-backed digest reads the storage stream for API paths and persists a trusted hash', async () => {
  const file = attachment({
    content: undefined,
    filepath: '/api/files/file-1',
    metadata: {
      ...attachment().metadata,
    },
  });
  const persisted = [];
  const digest = createStorageBackedFileDigest({
    readStorageStream: async ({ file: source }) => {
      assert.equal(source.filepath, '/api/files/file-1');
      return (async function* stream() {
        yield Buffer.from('xlsx-');
        yield Buffer.from('content-fixture');
      }());
    },
    persistFileMetadata: async (value) => persisted.push(value),
  });

  const actual = await digest(file, { req: { id: 'request-1' } });

  assert.equal(actual, await contentSha256(attachment()));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].metadata.contentSha256, actual);
  assert.equal(persisted[0].metadata.contentSha256Source, 'librechat-storage-v1');
  assert.equal(file.metadata.contentSha256, actual);
});

test('untrusted persisted hash is not accepted as file content identity', async () => {
  await assert.rejects(
    contentSha256(attachment({
      content: undefined,
      metadata: {
        ...attachment().metadata,
        contentSha256: 'a'.repeat(64),
      },
    })),
    (error) => error?.code === 'FILE_CONTENT_HASH_UNAVAILABLE',
  );
});

test('contentSha256 does not treat an API download reference as a local file path', async () => {
  await assert.rejects(
    contentSha256({ filepath: '/api/files/file-1' }),
    (error) => error?.code === 'FILE_CONTENT_HASH_UNAVAILABLE',
  );
  await assert.rejects(
    contentSha256({ filepath: 'https://files.example.invalid/file-1' }),
    (error) => error?.code === 'FILE_CONTENT_HASH_UNAVAILABLE',
  );
});

test('upstream resolver fails closed when an attachment has no verified content hash source', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-word',
    resolveAcceptanceAssertions: resolveWordAcceptanceAssertions,
  });
  const base = context();
  const attachmentWithoutContent = attachment({
    filename: 'source.docx',
    type: DOCX_MIME,
    content: undefined,
    buffer: undefined,
    path: undefined,
    filepath: undefined,
    localPath: undefined,
  });
  const result = await resolve({
    ...base,
    text: '在文档末尾追加段落：“Requested paragraph”，并交付修订版 Word 文档',
    client: {
      ...base.client,
      options: {
        ...base.client.options,
        attachments: [attachmentWithoutContent],
      },
    },
  });

  assert.deepEqual(result, {
    route: 'native',
    reason: 'input_content_hash_unavailable',
  });
});

test('upstream request resolver marks explicit continuation turns without current files', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-primary',
  });
  const result = await resolve(context({
    req: {
      user: { id: 'user-1', tenantId: 'tenant-1' },
      body: { files: [], activeTaskId: 'active-task-1' },
      config: {},
    },
    text: '继续按刚才的要求修改文件',
  }));

  assert.deepEqual(result, {
    route: 'continuation_candidate',
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    assistantMessageId: 'message-1_',
    streamId: 'conversation-1',
    instruction: '继续按刚才的要求修改文件',
    activeTaskId: 'active-task-1',
  });
});

test('ordinary no-file chat remains native instead of becoming a Runtime continuation', async () => {
  const resolve = createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-primary',
  });
  const result = await resolve(context({
    req: {
      user: { id: 'user-1', tenantId: 'tenant-1' },
      body: { files: [] },
      config: {},
    },
    text: '请解释一下这个功能',
  }));
  assert.deepEqual(result, { route: 'native', reason: 'no_current_request_files' });
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
        resource_id: 'resource-2',
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
  assert.deepEqual(created.messageIdentity, {
    sender: 'gpt-5.6-sol',
    endpoint: 'custom',
    model: 'gpt-5.6-sol',
  });
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
    activeTaskCollectionName: 'file_agent_nonprod_active_tasks',
  });
  assert.deepEqual(requestedNames, [
    'file_agent_nonprod_deliveries',
    'file_agent_nonprod_billing_snapshots',
    'transactions',
    'file_agent_nonprod_active_tasks',
  ]);
  assert.equal(collections.deliveries.name, 'file_agent_nonprod_deliveries');
  assert.equal(collections.activeTasks.name, 'file_agent_nonprod_active_tasks');

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

test('upstream host lifecycle installs the bridge, starts reconciliation, and stops idempotently', async () => {
  const operations = [];
  const app = { locals: {} };
  const integration = {
    connector: {
      prepareRoute: async () => ({ suppressNativeAgent: false }),
      submit: async () => ({ suppressNativeAgent: false }),
    },
    stores: { billingSnapshotStore: { create: async () => ({ snapshotId: 'snapshot-1' }) } },
    reconciler: {
      start: () => operations.push('start'),
      wake: async (deliveryId) => operations.push(`wake:${deliveryId}`),
    },
    init: async () => operations.push('init'),
    stop: async () => operations.push('stop'),
  };
  const host = await startUpstreamLibreChatHostIntegration({
    app,
    integration,
    controllerBridge: {
      modelRouteId: 'file-agent-primary',
      getBalanceConfig: () => ({ enabled: false }),
      getTransactionsConfig: () => ({ enabled: true }),
      getMultiplier: () => 1,
      getCacheMultiplier: () => null,
    },
  });

  assert.equal(app.locals.fileAgentRuntimeBridge, host.bridge);
  assert.deepEqual(operations, ['init', 'start']);
  await host.stop();
  await host.stop();
  assert.equal(app.locals.fileAgentRuntimeBridge, undefined);
  assert.deepEqual(operations, ['init', 'start', 'stop']);
});
