import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  loadProviderRouteMap,
  validateProductionProviderRouteMap,
} from './provider-route-registry.js';

const DEFAULTS = Object.freeze({
  connectorRoot: '/opt/librechat/file-agent-runtime/connector',
  modelRouteId: 'file-agent-primary',
  reconcileIntervalMs: 5_000,
  runtimeBaseUrl: 'http://file-agent-runtime:8790',
  serviceScopeTtlSeconds: 60,
});

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class ProductionHostConfigError extends Error {
  constructor(field) {
    super(`Production File Agent host configuration ${field} is invalid`);
    this.name = 'ProductionHostConfigError';
    this.code = 'FILE_AGENT_HOST_CONFIGURATION_INVALID';
    this.safeSummary = `Production File Agent host configuration ${field} is invalid`;
  }
}

function optionalString(environment, name, fallback = null) {
  const value = environment[name];
  if (value == null || value === '') {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new ProductionHostConfigError(name);
  }
  return value.trim();
}

function boolean(environment, name, fallback = false) {
  const value = optionalString(environment, name, fallback ? 'true' : 'false').toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new ProductionHostConfigError(name);
}

function absolutePath(environment, name, fallback) {
  const value = optionalString(environment, name, fallback);
  if (
    typeof value !== 'string' ||
    value === '' ||
    !path.isAbsolute(value) ||
    value.split(path.sep).includes('..')
  ) {
    throw new ProductionHostConfigError(name);
  }
  return path.resolve(value);
}

function integer(environment, name, fallback, { min, max }) {
  const value = optionalString(environment, name, String(fallback));
  if (!/^\d+$/u.test(value)) {
    throw new ProductionHostConfigError(name);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ProductionHostConfigError(name);
  }
  return parsed;
}

function runtimeBaseUrl(environment) {
  const value = optionalString(environment, 'FILE_AGENT_RUNTIME_BASE_URL', DEFAULTS.runtimeBaseUrl);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProductionHostConfigError('FILE_AGENT_RUNTIME_BASE_URL');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== 'file-agent-runtime' ||
    parsed.port !== '8790' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new ProductionHostConfigError('FILE_AGENT_RUNTIME_BASE_URL');
  }
  return DEFAULTS.runtimeBaseUrl;
}

function routeId(environment) {
  const value = optionalString(environment, 'FILE_AGENT_RUNTIME_MODEL_ROUTE_ID', DEFAULTS.modelRouteId);
  if (!ROUTE_ID.test(value)) {
    throw new ProductionHostConfigError('FILE_AGENT_RUNTIME_MODEL_ROUTE_ID');
  }
  return value;
}

async function requiredSecret(environment, name, readSecretFile) {
  const filePath = absolutePath(environment, name, null);
  let secret;
  try {
    secret = await readSecretFile(filePath, 'utf8');
  } catch {
    throw new ProductionHostConfigError(name);
  }
  if (typeof secret !== 'string' || secret.trim().length < 32) {
    throw new ProductionHostConfigError(name);
  }
  return secret.trim();
}

async function allowlistedUserIds(environment, readTextFile) {
  const filePath = absolutePath(environment, 'FILE_AGENT_RUNTIME_ALLOWLIST_FILE', null);
  let text;
  try {
    text = await readTextFile(filePath, 'utf8');
  } catch {
    throw new ProductionHostConfigError('FILE_AGENT_RUNTIME_ALLOWLIST_FILE');
  }
  const ids = new Set();
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim();
    if (value === '' || value.startsWith('#')) {
      continue;
    }
    if (!USER_ID.test(value)) {
      throw new ProductionHostConfigError('FILE_AGENT_RUNTIME_ALLOWLIST_FILE');
    }
    ids.add(value);
  }
  if (ids.size === 0) {
    throw new ProductionHostConfigError('FILE_AGENT_RUNTIME_ALLOWLIST_FILE');
  }
  return ids;
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
 * Reads production-only API host settings. Disabled mode intentionally returns
 * before reading secret or allowlist files, so a normal API boot keeps the
 * native request path independent from the Runtime deployment.
 */
export async function loadProductionHostConfig({
  environment = process.env,
  readSecretFile = readFile,
  readTextFile = readFile,
} = {}) {
  if (!environment || typeof environment !== 'object') {
    throw new TypeError('environment is required');
  }
  if (typeof readSecretFile !== 'function' || typeof readTextFile !== 'function') {
    throw new TypeError('secret and text file readers are required');
  }
  if (!boolean(environment, 'FILE_AGENT_RUNTIME_ENABLED')) {
    return Object.freeze({ enabled: false });
  }

  let providerRouteRegistry;
  try {
    providerRouteRegistry = validateProductionProviderRouteMap(await loadProviderRouteMap({
      filePath: absolutePath(environment, 'FILE_AGENT_PROVIDER_ROUTE_MAP_FILE', null),
      readTextFile,
    }));
  } catch (error) {
    if (error instanceof ProductionHostConfigError) {
      throw error;
    }
    throw new ProductionHostConfigError('FILE_AGENT_PROVIDER_ROUTE_MAP_FILE');
  }

  return deepFreeze({
    enabled: true,
    connectorRoot: absolutePath(
      environment,
      'FILE_AGENT_CONNECTOR_ROOT',
      DEFAULTS.connectorRoot,
    ),
    runtimeBaseUrl: runtimeBaseUrl(environment),
    modelRouteId: routeId(environment),
    providerRouteRegistry,
    routeConfigDigest: providerRouteRegistry.routeConfigDigest,
    serviceScopeSecret: await requiredSecret(
      environment,
      'FILE_AGENT_SERVICE_SCOPE_SECRET_FILE',
      readSecretFile,
    ),
    allowlistedUserIds: await allowlistedUserIds(environment, readTextFile),
    reconcileIntervalMs: integer(
      environment,
      'FILE_AGENT_RUNTIME_RECONCILE_INTERVAL_MS',
      DEFAULTS.reconcileIntervalMs,
      { min: 1_000, max: 60_000 },
    ),
    serviceScopeTtlSeconds: integer(
      environment,
      'FILE_AGENT_SERVICE_SCOPE_TTL_SECONDS',
      DEFAULTS.serviceScopeTtlSeconds,
      { min: 1, max: 300 },
    ),
  });
}
