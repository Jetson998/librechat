import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PRODUCTION_RUNTIME_CAPABILITIES,
  createProductionRuntime,
  createProductionRuntimeServer,
} from '../src/production-server.js';
import {
  ServiceScopeSigner,
} from '../../librechat-file-agent-connector/src/service-scope.js';

const SERVICE_SCOPE_SECRET = 'file-agent-production-runtime-test-secret-0123456789';

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

test('production Runtime publishes Word-only capabilities and rejects unsigned or legacy tasks', async () => {
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
    assert.deepEqual((await capabilities.json()).capabilityProfiles, ['word-edit-v1']);

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
