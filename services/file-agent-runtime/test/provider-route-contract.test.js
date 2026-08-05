import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadProductionRuntimeConfig } from '../src/production-config.js';

const SERVICE_SCOPE_SECRET = 'file-agent-production-scope-secret-0123456789';

test('Runtime loads multiple explicit provider routes and their server-side keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'file-agent-provider-routes-'));
  try {
    const scopePath = path.join(root, 'scope.secret');
    const openaiKeyPath = path.join(root, 'openai.secret');
    const anthropicKeyPath = path.join(root, 'anthropic.secret');
    const routesPath = path.join(root, 'routes.json');
    await writeFile(scopePath, SERVICE_SCOPE_SECRET);
    await writeFile(openaiKeyPath, 'openai-secret-value');
    await writeFile(anthropicKeyPath, 'anthropic-secret-value');
    await writeFile(routesPath, JSON.stringify({
      schemaVersion: 1,
      routes: [
        {
          providerRouteRef: 'custom:Muskapis-openai',
          providerEndpoint: 'Muskapis-openai',
          baseUrl: 'https://api.muskapis.example/v1',
          protocol: 'openai-compatible',
          allowedModels: ['gpt-5.6-sol'],
          apiKeyFile: openaiKeyPath,
        },
        {
          providerRouteRef: 'custom:Muskapis-Anthropic',
          providerEndpoint: 'Muskapis-Anthropic',
          baseUrl: 'https://api.muskapis.example',
          protocol: 'anthropic-messages',
          allowedModels: ['claude-fable-5'],
          apiKeyFile: anthropicKeyPath,
        },
      ],
    }), 'utf8');

    const config = await loadProductionRuntimeConfig({
      environment: {
        FILE_AGENT_SERVICE_SCOPE_SECRET_FILE: scopePath,
        FILE_AGENT_PROVIDER_ROUTES_FILE: routesPath,
        FILE_AGENT_DATA_DIR: path.join(root, 'runtime-data'),
      },
    });

    assert.equal(config.providerRoutes.length, 2);
    assert.equal(config.providerRoutes[0].providerRouteRef, 'custom:Muskapis-openai');
    assert.equal(config.providerRoutes[0].apiKey, 'openai-secret-value');
    assert.equal(config.providerRoutes[1].protocol, 'anthropic-messages');
    assert.equal(config.providerRoutes[1].apiKey, 'anthropic-secret-value');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Runtime rejects the old fixed model configuration as its production-only route source', async () => {
  await assert.rejects(
    loadProductionRuntimeConfig({
      environment: {
        FILE_AGENT_SERVICE_SCOPE_SECRET_FILE: '/run/secrets/scope',
        FILE_AGENT_MODEL_API_KEY_FILE: '/run/secrets/model',
        FILE_AGENT_MODEL_BASE_URL: 'https://model-relay.example.test/v1',
        FILE_AGENT_MODEL: 'word-planner',
      },
      readSecretFile: async () => 'file-agent-production-scope-secret-0123456789',
    }),
    /FILE_AGENT_PROVIDER_ROUTES_FILE/,
  );
});
