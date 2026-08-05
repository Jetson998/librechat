import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProductionHostConfigError,
  loadProductionHostConfig,
} from '../src/production-host-config.js';

const SECRET = '12345678901234567890123456789012';

function enabledEnvironment(overrides = {}) {
  return {
    FILE_AGENT_RUNTIME_ENABLED: 'true',
    FILE_AGENT_CONNECTOR_ROOT: '/opt/librechat/file-agent-runtime/connector',
    FILE_AGENT_RUNTIME_ALLOWLIST_FILE: '/run/secrets/file-agent-allowlist',
    FILE_AGENT_SERVICE_SCOPE_SECRET_FILE: '/run/secrets/file-agent-service-scope',
    FILE_AGENT_PROVIDER_ROUTE_MAP_FILE: '/run/file-agent/provider-route-map.json',
    ...overrides,
  };
}

function reader(files) {
  return async (filePath) => {
    if (!Object.hasOwn(files, filePath)) {
      throw new Error('not found');
    }
    return files[filePath];
  };
}

test('disabled production host configuration does not read operational files', async () => {
  let reads = 0;
  const config = await loadProductionHostConfig({
    environment: { FILE_AGENT_RUNTIME_ENABLED: 'false' },
    readSecretFile: async () => {
      reads += 1;
      throw new Error('must not read');
    },
    readTextFile: async () => {
      reads += 1;
      throw new Error('must not read');
    },
  });

  assert.deepEqual(config, { enabled: false });
  assert.equal(reads, 0);
});

test('enabled production host configuration reads only file-backed secrets and an allowlist', async () => {
  const files = {
    '/run/secrets/file-agent-allowlist': '# staged users\nuser-1\nuser-2\nuser-1\n',
    '/run/secrets/file-agent-service-scope': `${SECRET}\n`,
    '/run/file-agent/provider-route-map.json': JSON.stringify({
      schemaVersion: 1,
      routes: [{
        librechatEndpoint: 'Muskapis-openai',
        providerRouteRef: 'custom:Muskapis-openai',
        providerEndpoint: 'Muskapis-openai',
        protocol: 'openai-compatible',
        allowedModels: ['gpt-5.6-sol'],
      }],
    }),
  };
  const config = await loadProductionHostConfig({
    environment: enabledEnvironment({
      FILE_AGENT_RUNTIME_RECONCILE_INTERVAL_MS: '7500',
      FILE_AGENT_SERVICE_SCOPE_TTL_SECONDS: '120',
    }),
    readSecretFile: reader(files),
    readTextFile: reader(files),
  });

  assert.equal(config.enabled, true);
  assert.equal(config.runtimeBaseUrl, 'http://file-agent-runtime:8790');
  assert.equal(config.modelRouteId, 'file-agent-primary');
  assert.equal(config.providerRouteRegistry.routes[0].providerRouteRef, 'custom:Muskapis-openai');
  assert.deepEqual([...config.allowlistedUserIds], ['user-1', 'user-2']);
  assert.equal(config.reconcileIntervalMs, 7500);
  assert.equal(config.serviceScopeTtlSeconds, 120);
  assert.equal(config.serviceScopeSecret, SECRET);
});

test('enabled production host configuration fails closed for unsafe Runtime targets and empty allowlists', async () => {
  const files = {
    '/run/secrets/file-agent-allowlist': '\n# no users\n',
    '/run/secrets/file-agent-service-scope': SECRET,
    '/run/file-agent/provider-route-map.json': JSON.stringify({
      schemaVersion: 1,
      routes: [{
        librechatEndpoint: 'Muskapis-openai',
        providerRouteRef: 'custom:Muskapis-openai',
        providerEndpoint: 'Muskapis-openai',
        protocol: 'openai-compatible',
        allowedModels: ['gpt-5.6-sol'],
      }],
    }),
  };
  await assert.rejects(
    loadProductionHostConfig({
      environment: enabledEnvironment(),
      readSecretFile: reader(files),
      readTextFile: reader(files),
    }),
    ProductionHostConfigError,
  );
  await assert.rejects(
    loadProductionHostConfig({
      environment: enabledEnvironment({ FILE_AGENT_RUNTIME_BASE_URL: 'https://runtime.example.test' }),
      readSecretFile: reader({
        ...files,
        '/run/secrets/file-agent-allowlist': 'user-1\n',
      }),
      readTextFile: reader({
        ...files,
        '/run/secrets/file-agent-allowlist': 'user-1\n',
      }),
    }),
    ProductionHostConfigError,
  );
});

test('enabled production host configuration rejects missing and short service-scope files without exposing their values', async () => {
  await assert.rejects(
    loadProductionHostConfig({
      environment: enabledEnvironment(),
      readSecretFile: reader({}),
      readTextFile: reader({ '/run/secrets/file-agent-allowlist': 'user-1\n' }),
    }),
    (error) => {
      assert.ok(error instanceof ProductionHostConfigError);
      assert.doesNotMatch(error.message, /secret-value|\/run\/secrets/u);
      return true;
    },
  );
  await assert.rejects(
    loadProductionHostConfig({
      environment: enabledEnvironment(),
      readSecretFile: reader({ '/run/secrets/file-agent-service-scope': 'short' }),
      readTextFile: reader({ '/run/secrets/file-agent-allowlist': 'user-1\n' }),
    }),
    ProductionHostConfigError,
  );
});
