import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED_PROTOCOLS = new Set(['openai-compatible', 'anthropic-messages']);
const ROUTE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

export class RuntimeProviderRouteRegistryError extends Error {
  constructor(message, code = 'RUNTIME_PROVIDER_ROUTE_REGISTRY_INVALID') {
    super(message);
    this.name = 'RuntimeProviderRouteRegistryError';
    this.code = code;
    this.safeSummary = message;
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RuntimeProviderRouteRegistryError(`${field} is required`);
  }
  return value.trim();
}

function normalizedId(value, field, pattern = ENDPOINT_ID) {
  const normalized = requiredString(value, field);
  if (!pattern.test(normalized) || normalized.includes('://')) {
    throw new RuntimeProviderRouteRegistryError(`${field} is invalid`);
  }
  return normalized;
}

function normalizedUrl(value, field) {
  const raw = requiredString(value, field);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RuntimeProviderRouteRegistryError(`${field} is invalid`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new RuntimeProviderRouteRegistryError(`${field} is invalid`);
  }
  return parsed.toString().replace(/\/$/u, '');
}

function normalizedModels(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuntimeProviderRouteRegistryError(`${field} must contain at least one model`);
  }
  return [...new Set(value.map((model, index) =>
    requiredString(model, `${field}[${index}]`)))];
}

function apiKeyPath(value, field) {
  const normalized = requiredString(value, field);
  if (!path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
    throw new RuntimeProviderRouteRegistryError(`${field} is invalid`);
  }
  return path.resolve(normalized);
}

async function loadApiKey(filePath, readSecretFile, field) {
  let value;
  try {
    value = await readSecretFile(filePath, 'utf8');
  } catch {
    throw new RuntimeProviderRouteRegistryError(`${field} could not be read`, 'RUNTIME_PROVIDER_SECRET_UNAVAILABLE');
  }
  return requiredString(value, field);
}

export async function loadProviderRoutes({ filePath, readTextFile = readFile, readSecretFile = readFile } = {}) {
  const normalizedPath = apiKeyPath(filePath, 'FILE_AGENT_PROVIDER_ROUTES_FILE');
  let text;
  try {
    text = await readTextFile(normalizedPath, 'utf8');
  } catch {
    throw new RuntimeProviderRouteRegistryError(
      'FILE_AGENT_PROVIDER_ROUTES_FILE could not be read',
      'RUNTIME_PROVIDER_ROUTES_UNAVAILABLE',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RuntimeProviderRouteRegistryError(
      'FILE_AGENT_PROVIDER_ROUTES_FILE is not valid JSON',
      'RUNTIME_PROVIDER_ROUTES_INVALID',
    );
  }
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.routes) || parsed.routes.length === 0) {
    throw new RuntimeProviderRouteRegistryError('Runtime provider route registry is invalid');
  }
  const refs = new Set();
  const routes = [];
  for (const [index, route] of parsed.routes.entries()) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new RuntimeProviderRouteRegistryError(`routes[${index}] must be an object`);
    }
    const normalized = {
      providerRouteRef: normalizedId(route.providerRouteRef, `routes[${index}].providerRouteRef`, ROUTE_REF),
      providerEndpoint: normalizedId(route.providerEndpoint, `routes[${index}].providerEndpoint`),
      baseUrl: normalizedUrl(route.baseUrl, `routes[${index}].baseUrl`),
      protocol: requiredString(route.protocol, `routes[${index}].protocol`),
      allowedModels: normalizedModels(route.allowedModels, `routes[${index}].allowedModels`),
      apiKeyFile: apiKeyPath(route.apiKeyFile, `routes[${index}].apiKeyFile`),
      supportsIdempotency: route.supportsIdempotency === true,
      outputBudgetTokens: Number.isSafeInteger(route.outputBudgetTokens)
        ? route.outputBudgetTokens
        : 500,
    };
    if (!SUPPORTED_PROTOCOLS.has(normalized.protocol)) {
      throw new RuntimeProviderRouteRegistryError(`routes[${index}].protocol is unsupported`);
    }
    if (normalized.outputBudgetTokens < 1 || normalized.outputBudgetTokens > 4_096) {
      throw new RuntimeProviderRouteRegistryError(`routes[${index}].outputBudgetTokens is invalid`);
    }
    if (refs.has(normalized.providerRouteRef)) {
      throw new RuntimeProviderRouteRegistryError('Runtime provider route references must be unique');
    }
    refs.add(normalized.providerRouteRef);
    routes.push(Object.freeze({
      ...normalized,
      apiKey: await loadApiKey(normalized.apiKeyFile, readSecretFile, `routes[${index}].apiKey`),
    }));
  }
  return Object.freeze(routes);
}

export function providerRouteMap(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new RuntimeProviderRouteRegistryError('Runtime provider routes are required');
  }
  return Object.fromEntries(routes.map((route) => [route.providerRouteRef, route]));
}

export { SUPPORTED_PROTOCOLS };
