import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadProviderRoutes } from './provider-route-registry.js';

const DEFAULTS = Object.freeze({
  codeApiBaseUrl: 'http://codeapi:8000',
  codeApiTimeoutMs: 120_000,
  dataDir: '/var/lib/file-agent-runtime',
  host: '0.0.0.0',
  maxConcurrentTasks: 1,
  maxContextChars: 12_000,
  port: 8790,
  serviceScopeTtlSeconds: 60,
});

export class ProductionRuntimeConfigError extends Error {
  constructor(field, message = 'is invalid') {
    super(`Production File Agent Runtime configuration ${field} ${message}`);
    this.name = 'ProductionRuntimeConfigError';
    this.code = 'FILE_AGENT_CONFIGURATION_INVALID';
    this.safeSummary = `Production File Agent Runtime configuration ${field} is invalid`;
  }
}

function requiredString(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProductionRuntimeConfigError(name, 'is required');
  }
  return value.trim();
}

function optionalString(environment, name, fallback) {
  const value = environment[name];
  if (value == null || value === '') {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new ProductionRuntimeConfigError(name);
  }
  return value.trim();
}

function integer(environment, name, fallback, { min, max }) {
  const value = optionalString(environment, name, String(fallback));
  if (!/^\d+$/.test(value)) {
    throw new ProductionRuntimeConfigError(name);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ProductionRuntimeConfigError(name);
  }
  return parsed;
}

function absoluteDirectory(environment, name, fallback) {
  const value = optionalString(environment, name, fallback);
  if (!path.isAbsolute(value) || value.split(path.sep).includes('..')) {
    throw new ProductionRuntimeConfigError(name);
  }
  return path.resolve(value);
}

function normalizedHttpUrl(environment, name, { protocols, expectedHostname = null, fallback = null }) {
  const raw = fallback == null ? requiredString(environment, name) : optionalString(environment, name, fallback);
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new ProductionRuntimeConfigError(name);
  }
  if (
    !protocols.includes(value.protocol) ||
    value.username !== '' ||
    value.password !== '' ||
    value.hostname === '' ||
    (expectedHostname != null && value.hostname !== expectedHostname)
  ) {
    throw new ProductionRuntimeConfigError(name);
  }
  return value.toString().replace(/\/$/, '');
}

async function requiredSecret(environment, name, readSecretFile) {
  const filePath = requiredString(environment, name);
  if (!path.isAbsolute(filePath)) {
    throw new ProductionRuntimeConfigError(name);
  }
  let value;
  try {
    value = await readSecretFile(filePath, 'utf8');
  } catch {
    throw new ProductionRuntimeConfigError(name, 'could not be read');
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProductionRuntimeConfigError(name, 'is empty');
  }
  return value.trim();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

/**
 * Reads the production-only Runtime configuration without logging or returning
 * secret file paths. Values intentionally stay out of task manifests and
 * release evidence; callers must treat the returned object as process-local.
 */
export async function loadProductionRuntimeConfig({
  environment = process.env,
  readSecretFile = readFile,
} = {}) {
  if (!environment || typeof environment !== 'object') {
    throw new TypeError('environment is required');
  }
  if (typeof readSecretFile !== 'function') {
    throw new TypeError('readSecretFile must be a function');
  }

  const serviceScopeSecret = await requiredSecret(
    environment,
    'FILE_AGENT_SERVICE_SCOPE_SECRET_FILE',
    readSecretFile,
  );
  if (serviceScopeSecret.length < 32) {
    throw new ProductionRuntimeConfigError('FILE_AGENT_SERVICE_SCOPE_SECRET_FILE');
  }
  const providerRoutes = await loadProviderRoutes({
    filePath: environment.FILE_AGENT_PROVIDER_ROUTES_FILE,
    readTextFile: readSecretFile,
    readSecretFile,
    requireProductionContract: true,
  });

  const host = optionalString(environment, 'FILE_AGENT_HOST', DEFAULTS.host);
  if (!['0.0.0.0', '::'].includes(host)) {
    throw new ProductionRuntimeConfigError('FILE_AGENT_HOST');
  }

  const codeApiBaseUrl = normalizedHttpUrl(environment, 'FILE_AGENT_CODEAPI_BASE_URL', {
    protocols: ['http:'],
    expectedHostname: 'codeapi',
    fallback: DEFAULTS.codeApiBaseUrl,
  });
  const codeApiUrl = new URL(codeApiBaseUrl);
  if (codeApiUrl.port !== '8000') {
    throw new ProductionRuntimeConfigError('FILE_AGENT_CODEAPI_BASE_URL');
  }

  return deepFreeze({
    host,
    port: integer(environment, 'FILE_AGENT_PORT', DEFAULTS.port, { min: 1, max: 65_535 }),
    dataDir: absoluteDirectory(environment, 'FILE_AGENT_DATA_DIR', DEFAULTS.dataDir),
    maxConcurrentTasks: integer(
      environment,
      'FILE_AGENT_MAX_CONCURRENT_TASKS',
      DEFAULTS.maxConcurrentTasks,
      { min: 1, max: 2 },
    ),
    maxContextChars: integer(
      environment,
      'FILE_AGENT_MAX_CONTEXT_CHARS',
      DEFAULTS.maxContextChars,
      { min: 1_000, max: 12_000 },
    ),
    codeApi: {
      baseUrl: codeApiBaseUrl,
      timeoutMs: integer(
        environment,
        'FILE_AGENT_CODEAPI_TIMEOUT_MS',
        DEFAULTS.codeApiTimeoutMs,
        { min: 1_000, max: 900_000 },
      ),
    },
    providerRoutes,
    routeConfigDigest: providerRoutes[0].routeConfigDigest,
    serviceScope: {
      secret: serviceScopeSecret,
      ttlSeconds: integer(
        environment,
        'FILE_AGENT_SERVICE_SCOPE_TTL_SECONDS',
        DEFAULTS.serviceScopeTtlSeconds,
        { min: 1, max: 300 },
      ),
    },
  });
}
