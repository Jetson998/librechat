import { readFile } from 'node:fs/promises';

import { digestJson } from './stable.js';

const SUPPORTED_PROTOCOLS = new Set(['openai-compatible', 'anthropic-messages']);
const ROUTE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const PRODUCTION_ROUTE_REF = 'custom:Muskapis-openai';
const PRODUCTION_PROVIDER_ENDPOINT = 'Muskapis-openai';
const PRODUCTION_PROTOCOL = 'openai-compatible';
const PRODUCTION_ALLOWED_MODELS = Object.freeze(['gpt-5.6-sol', 'claude-fable-5']);

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
  return Object.freeze({
    ...route,
    providerModel,
    routeConfigDigest: providerRouteConfigDigest(normalized),
  });
}

function publicRouteConfig(registry) {
  const normalized = normalizeProviderRouteMap(registry);
  return {
    schemaVersion: normalized.schemaVersion,
    routes: normalized.routes
      .map((route) => ({
        librechatEndpoint: route.librechatEndpoint,
        providerRouteRef: route.providerRouteRef,
        providerEndpoint: route.providerEndpoint,
        protocol: route.protocol,
        allowedModels: [...route.allowedModels].sort(),
      }))
      .sort((left, right) => left.providerRouteRef.localeCompare(right.providerRouteRef)),
  };
}

export function providerRouteConfigDigest(registry) {
  return digestJson(publicRouteConfig(registry));
}

export function validateProductionProviderRouteMap(registry) {
  const normalized = normalizeProviderRouteMap(registry);
  if (normalized.routes.length !== 1) {
    throw new ProviderRouteRegistryError(
      'Production provider route map must contain exactly one route',
      'PROVIDER_ROUTE_PRODUCTION_CONTRACT_INVALID',
    );
  }
  const [route] = normalized.routes;
  if (
    route.librechatEndpoint !== PRODUCTION_PROVIDER_ENDPOINT ||
    route.providerRouteRef !== PRODUCTION_ROUTE_REF ||
    route.providerEndpoint !== PRODUCTION_PROVIDER_ENDPOINT ||
    route.protocol !== PRODUCTION_PROTOCOL ||
    route.allowedModels.length !== PRODUCTION_ALLOWED_MODELS.length ||
    route.allowedModels.some((model) => !PRODUCTION_ALLOWED_MODELS.includes(model))
  ) {
    throw new ProviderRouteRegistryError(
      'Production provider route map does not match the fixed File Agent route contract',
      'PROVIDER_ROUTE_PRODUCTION_CONTRACT_INVALID',
    );
  }
  return Object.freeze({
    ...normalized,
    routeConfigDigest: providerRouteConfigDigest(normalized),
  });
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
    ...(route.routeConfigDigest ? { routeConfigDigest: route.routeConfigDigest } : {}),
  };
}

export {
  PRODUCTION_ALLOWED_MODELS,
  PRODUCTION_PROVIDER_ENDPOINT,
  PRODUCTION_PROTOCOL,
  PRODUCTION_ROUTE_REF,
  SUPPORTED_PROTOCOLS,
};
