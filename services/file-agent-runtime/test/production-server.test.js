import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PRODUCTION_RUNTIME_CAPABILITIES,
  createProductionCodeApiTransport,
  createProductionRuntime,
  createProductionRuntimeServer,
} from '../src/production-server.js';
import { LibreChatCodeApiTransport } from '../src/librechat-codeapi-transport.js';
import { validateTaskManifest } from '../src/runtime.js';
import {
  ServiceScopeSigner,
} from '../../librechat-file-agent-connector/src/service-scope.js';

const SERVICE_SCOPE_SECRET = 'file-agent-production-runtime-test-secret-0123456789';

test('production Runtime constructs the real LibreChat CodeAPI /exec transport', () => {
  const transport = createProductionCodeApiTransport({
    baseUrl: 'http://codeapi:8000',
    timeoutMs: 120_000,
  });
  assert.ok(transport instanceof LibreChatCodeApiTransport);
});

function config(dataDir) {
  return {
    host: '127.0.0.1',
    port: 8790,
    dataDir,
    maxConcurrentTasks: 1,
    maxContextChars: 12_000,
    codeApi: { baseUrl: 'http://codeapi:8000', timeoutMs: 120_000 },
    modelRoute: {
      routeId: 'file-agent-primary',
      baseUrl: 'https://model-relay.example.test/v1',
      model: 'word-planner',
      apiKey: 'test-key',
      capabilityProfile: 'word-edit-v1',
      supportsIdempotency: false,
      outputBudgetTokens: 500,
      structuredOutputMode: 'json_schema',
    },
    serviceScope: { secret: SERVICE_SCOPE_SECRET, ttlSeconds: 60 },
  };
}

function signedRequest(signer, {
  baseUrl,
  pathname,
  method = 'GET',
  body = undefined,
  idempotencyKey = null,
}) {
  const headers = new Headers();
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  if (serializedBody !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (idempotencyKey) {
    headers.set('idempotency-key', idempotencyKey);
  }
  headers.set('authorization', `Bearer ${signer.sign({
    method,
    pathname,
    body: serializedBody ?? '',
    headers,
  })}`);
  return new Request(`${baseUrl}${pathname}`, { method, headers, body: serializedBody });
}

test('production Runtime publishes the four Office capabilities and rejects unsigned or legacy tasks', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'file-agent-production-runtime-'));
  const resolvedConfig = config(dataDir);
  const runtime = createProductionRuntime(resolvedConfig);
  const server = createProductionRuntimeServer(runtime, resolvedConfig);
  const signer = new ServiceScopeSigner({ secret: SERVICE_SCOPE_SECRET, ttlSeconds: 60 });
  try {
    await runtime.start();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).mode, 'production');

    const unsigned = await fetch(`${baseUrl}/v1/capabilities`);
    assert.equal(unsigned.status, 401);

    const capabilities = await fetch(signedRequest(signer, {
      baseUrl,
      pathname: '/v1/capabilities',
    }));
    assert.equal(capabilities.status, 200);
    const advertised = await capabilities.json();
    assert.deepEqual(advertised.capabilityProfiles, [
      'word-edit-v1',
      'xlsx-edit-v1',
      'pptx-edit-v1',
      'office-compose-v1',
    ]);
    assert.deepEqual(advertised.taskContractVersions, [
      'office-file-agent.v1.1',
      'office-file-agent.v1.2',
    ]);
    assert.equal(advertised.maxInputFiles, 2);

    const legacyManifest = {
      schemaVersion: '1.0',
      taskContractVersion: 'office-file-agent.v1',
      taskType: 'office_transform',
      intent: 'modify workbook',
      model: { capabilityProfile: 'office-planner-v1' },
      inputs: [],
    };
    const legacy = await fetch(signedRequest(signer, {
      baseUrl,
      pathname: '/v1/tasks',
      method: 'POST',
      body: legacyManifest,
      idempotencyKey: 'production-runtime-legacy-task',
    }));
    assert.equal(legacy.status, 400);
    assert.match((await legacy.json()).error, /Capability profile is not enabled/);
  } finally {
    await runtime.stop().catch(() => {});
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('production Runtime contract accepts one manifest for every enabled Office profile', () => {
  const common = {
    schemaVersion: '1.0',
    taskType: 'office_transform',
    intent: 'Apply the independently frozen Office change',
    identity: {},
    billingRef: 'billing:snapshot-1',
    execution: { executor: 'codeapi', sessionId: 'session-1' },
    limits: { maxVisibleArtifacts: 1 },
  };
  const input = (logicalName, mimeType, logicalId = null) => [{
    logicalName,
    mimeType,
    ...(logicalId ? { logicalId } : {}),
    librechatFileRef: `file:${logicalName}`,
    sha256: 'a'.repeat(64),
    codeEnvRef: { kind: 'user', id: 'user:user-1', storage_session_id: 'session-1', file_id: logicalName },
  }];
  const manifests = [
    {
      ...common,
      taskContractVersion: 'office-file-agent.v1.1',
      model: { capabilityProfile: 'word-edit-v1' },
      inputs: input('source.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      acceptanceAssertions: [{ type: 'word.text_replace.v1', find: 'before', replace: 'after', occurrence: 1 }],
    },
    {
      ...common,
      taskContractVersion: 'office-file-agent.v1.2',
      model: { capabilityProfile: 'xlsx-edit-v1' },
      inputs: input('source.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      acceptanceAssertions: [{ type: 'xlsx.cell_value.v1', sheet: 'Sheet1', cell: 'A1', value: 42 }],
    },
    {
      ...common,
      taskContractVersion: 'office-file-agent.v1.2',
      model: { capabilityProfile: 'pptx-edit-v1' },
      inputs: input('source.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
      acceptanceAssertions: [{ type: 'pptx.text_value.v1', slide: 1, shape: 'TitleBox', value: 'Updated' }],
    },
    {
      ...common,
      taskContractVersion: 'office-file-agent.v1.2',
      model: { capabilityProfile: 'office-compose-v1' },
      inputs: [
        ...input('source.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'source:source-xlsx-12345678'),
        ...input('brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'source:brief-docx-12345678'),
      ],
      acceptanceAssertions: [
        { type: 'compose.section_present.v1', slide: 1, title: 'Source Facts' },
        {
          type: 'compose.source_mapping.v1',
          sourceLogicalId: 'source:source-xlsx-12345678',
          sourceLocation: 'Sheet1!A1',
          targetSlide: 1,
          targetShape: 'body',
        },
      ],
    },
  ];
  for (const manifest of manifests) {
    assert.doesNotThrow(() => validateTaskManifest(manifest), manifest.model.capabilityProfile);
  }
  assert.deepEqual(
    PRODUCTION_RUNTIME_CAPABILITIES.capabilityProfiles,
    manifests.map((manifest) => manifest.model.capabilityProfile),
  );
});
