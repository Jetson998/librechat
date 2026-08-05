import { readFile } from 'node:fs/promises';

const SUPPORTED_PROTOCOLS = new Set(['openai-compatible', 'anthropic-messages']);
const ROUTE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

export class ProviderRouteRegistryError extends Error {
  constructor(message, code = 'PROVIDER_ROUTE_REGISTRY_INVALID') {
    super(message);
    this.name = 'ProviderRouteRegistryError';
    this.code = code;
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProviderRouteRegistryError(`${field} is required`);
  }
  return value.trim();
}

function normalizedId(value, field, pattern = ENDPOINT_ID) {
  const normalized = requiredString(value, field);
  if (!pattern.test(normalized) || normalized.includes('://')) {
    throw new ProviderRouteRegistryError(`${field} is invalid`);
  }
  return normalized;
}

function normalizedModels(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProviderRouteRegistryError(`${field} must contain at least one model`);
  }
  const models = [...new Set(value.map((model, index) =>
    requiredString(model, `${field}[${index}]`)))];
  if (models.some((model) => model.includes('\n') || model.includes('\r'))) {
    throw new ProviderRouteRegistryError(`${field} contains an invalid model`);
  }
  return models;
}

export function normalizeProviderRouteMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderRouteRegistryError('Provider route map must be an object');
  }
  if (value.schemaVersion !== 1) {
    throw new ProviderRouteRegistryError('Provider route map schemaVersion must be 1');
  }
  if (!Array.isArray(value.routes) || value.routes.length === 0) {
    throw new ProviderRouteRegistryError('Provider route map routes are required');
  }
  const endpoints = new Set();
  const refs = new Set();
  const routes = value.routes.map((route, index) => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new ProviderRouteRegistryError(`routes[${index}] must be an object`);
    }
    for (const forbidden of ['apiKey', 'apiKeyFile', 'baseUrl']) {
      if (Object.hasOwn(route, forbidden)) {
        throw new ProviderRouteRegistryError(`routes[${index}].${forbidden} is not allowed in the API route map`);
      }
    }
    const normalized = {
      librechatEndpoint: normalizedId(route.librechatEndpoint, `routes[${index}].librechatEndpoint`),
      providerRouteRef: normalizedId(route.providerRouteRef, `routes[${index}].providerRouteRef`, ROUTE_REF),
      providerEndpoint: normalizedId(route.providerEndpoint, `routes[${index}].providerEndpoint`),
      protocol: requiredString(route.protocol, `routes[${index}].protocol`),
      allowedModels: normalizedModels(route.allowedModels, `routes[${index}].allowedModels`),
    };
    if (!SUPPORTED_PROTOCOLS.has(normalized.protocol)) {
      throw new ProviderRouteRegistryError(`routes[${index}].protocol is unsupported`);
    }
    if (endpoints.has(normalized.librechatEndpoint)) {
      throw new ProviderRouteRegistryError('Provider route map contains duplicate LibreChat endpoints');
    }
    if (refs.has(normalized.providerRouteRef)) {
      throw new ProviderRouteRegistryError('Provider route map contains duplicate provider route references');
    }
    endpoints.add(normalized.librechatEndpoint);
    refs.add(normalized.providerRouteRef);
    return Object.freeze(normalized);
  });
  return Object.freeze({ schemaVersion: 1, routes: Object.freeze(routes) });
}

export async function loadProviderRouteMap({ filePath, readTextFile = readFile } = {}) {
  const normalizedPath = requiredString(filePath, 'provider route map file path');
  let text;
  try {
    text = await readTextFile(normalizedPath, 'utf8');
  } catch {
    throw new ProviderRouteRegistryError(
      'Provider route map could not be read',
      'PROVIDER_ROUTE_MAP_UNAVAILABLE',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderRouteRegistryError(
      'Provider route map is not valid JSON',
      'PROVIDER_ROUTE_MAP_INVALID',
    );
  }
  return normalizeProviderRouteMap(parsed);
}

export function resolveProviderRoute({ registry, librechatEndpoint, model }) {
  const normalized = normalizeProviderRouteMap(registry);
  const endpoint = requiredString(librechatEndpoint, 'LibreChat provider endpoint');
  const providerModel = requiredString(model, 'LibreChat provider model');
  const route = normalized.routes.find((entry) => entry.librechatEndpoint === endpoint);
  if (!route) {
    throw new ProviderRouteRegistryError(
      'Provider route is not registered',
      'PROVIDER_ROUTE_UNAVAILABLE',
    );
  }
  if (!route.allowedModels.includes(providerModel)) {
    throw new ProviderRouteRegistryError(
      'Provider model is not allowlisted',
      'PROVIDER_MODEL_NOT_ALLOWLISTED',
    );
  }
  return Object.freeze({ ...route, providerModel });
}

export function providerRouteIdentity(route) {
  if (!route || typeof route !== 'object') {
    return null;
  }
  return {
    providerRouteRef: route.providerRouteRef,
    providerEndpoint: route.providerEndpoint,
    providerModel: route.providerModel,
    providerProtocol: route.protocol ?? route.providerProtocol,
  };
}

export { SUPPORTED_PROTOCOLS };
