import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ProductionRuntimeConfigError,
  loadProductionRuntimeConfig,
} from '../src/production-config.js';

const SERVICE_SCOPE_SECRET = 'file-agent-production-scope-secret-0123456789';
const MODEL_API_KEY = 'test-model-api-key-not-for-production';

async function withSecretFiles(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'file-agent-production-config-'));
  try {
    const scopePath = path.join(root, 'scope.secret');
    const modelPath = path.join(root, 'model.secret');
    await writeFile(scopePath, `${SERVICE_SCOPE_SECRET}\n`, 'utf8');
    await writeFile(modelPath, `${MODEL_API_KEY}\n`, 'utf8');
    return await run({ root, scopePath, modelPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function environment({ root, scopePath, modelPath }, overrides = {}) {
  return {
    FILE_AGENT_SERVICE_SCOPE_SECRET_FILE: scopePath,
    FILE_AGENT_MODEL_API_KEY_FILE: modelPath,
    FILE_AGENT_MODEL_BASE_URL: 'https://model-relay.example.test/v1',
    FILE_AGENT_MODEL: 'word-planner',
    FILE_AGENT_DATA_DIR: path.join(root, 'runtime-data'),
    ...overrides,
  };
}

test('production config reads secret files and constrains the Runtime to its private peers', async () => {
  await withSecretFiles(async (files) => {
    const config = await loadProductionRuntimeConfig({ environment: environment(files) });

    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 8790);
    assert.equal(config.dataDir, path.join(files.root, 'runtime-data'));
    assert.equal(config.codeApi.baseUrl, 'http://codeapi:8000');
    assert.equal(config.modelRoute.capabilityProfile, 'word-edit-v1');
    assert.equal(config.modelRoute.supportsIdempotency, false);
    assert.equal(config.serviceScope.secret, SERVICE_SCOPE_SECRET);
    assert.equal(config.modelRoute.apiKey, MODEL_API_KEY);
    assert.equal(Object.isFrozen(config), true);
  });
});

test('production config rejects a CodeAPI endpoint outside the internal service name', async () => {
  await withSecretFiles(async (files) => {
    await assert.rejects(
      loadProductionRuntimeConfig({
        environment: environment(files, {
          FILE_AGENT_CODEAPI_BASE_URL: 'https://outside.example.test',
        }),
      }),
      (error) => error instanceof ProductionRuntimeConfigError &&
        error.message.includes('FILE_AGENT_CODEAPI_BASE_URL'),
    );
  });
});

test('production config does not include an unreadable secret value in its error', async () => {
  const unreadableSecret = 'do-not-leak-this-model-secret';
  await assert.rejects(
    loadProductionRuntimeConfig({
      environment: {
        FILE_AGENT_SERVICE_SCOPE_SECRET_FILE: '/run/secrets/file-agent-scope',
        FILE_AGENT_MODEL_API_KEY_FILE: '/run/secrets/file-agent-model',
        FILE_AGENT_MODEL_BASE_URL: 'https://model-relay.example.test/v1',
        FILE_AGENT_MODEL: 'word-planner',
      },
      readSecretFile: async () => {
        throw new Error(unreadableSecret);
      },
    }),
    (error) => error instanceof ProductionRuntimeConfigError &&
      !error.message.includes(unreadableSecret),
  );
});
