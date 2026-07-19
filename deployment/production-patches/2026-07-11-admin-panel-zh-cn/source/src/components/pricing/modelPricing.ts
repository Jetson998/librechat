import type * as t from '@/types';

export const PRICE_FIELDS = ['prompt', 'completion', 'cacheRead', 'cacheWrite'] as const;

export type PriceField = (typeof PRICE_FIELDS)[number];
export type PricingDraft = Record<PriceField, string>;
export type ModelMetadataDraft = {
  context: string;
};
export type MarketDraft = {
  published: boolean;
  officialPrompt: string;
};
export type CustomEndpoint = Record<string, t.ConfigValue> & {
  name?: string;
  models?: {
    default?: string[];
    fetch?: boolean;
  };
  tokenConfig?: Record<string, t.ConfigValue> | null;
};

export const EMPTY_PRICING_DRAFT: PricingDraft = {
  prompt: '',
  completion: '',
  cacheRead: '',
  cacheWrite: '',
};

export const EMPTY_MODEL_METADATA_DRAFT: ModelMetadataDraft = {
  context: '',
};

export const EMPTY_MARKET_DRAFT: MarketDraft = {
  published: false,
  officialPrompt: '',
};

function isRecord(value: unknown): value is Record<string, t.ConfigValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getCustomEndpoints(config?: Record<string, t.ConfigValue>): CustomEndpoint[] {
  const endpoints = config?.endpoints;
  if (!isRecord(endpoints) || !Array.isArray(endpoints.custom)) return [];
  return endpoints.custom.filter(isRecord) as CustomEndpoint[];
}

export function getEndpointModels(endpoint?: CustomEndpoint): string[] {
  if (!endpoint) return [];
  const models = new Set<string>();
  const defaults = endpoint.models?.default;
  if (Array.isArray(defaults)) {
    for (const model of defaults) {
      if (typeof model === 'string' && model.trim()) models.add(model.trim());
    }
  }
  if (isRecord(endpoint.tokenConfig)) {
    for (const model of Object.keys(endpoint.tokenConfig)) {
      if (model.trim()) models.add(model.trim());
    }
  }
  return [...models].sort((a, b) => a.localeCompare(b));
}

function getModelConfig(endpoint: CustomEndpoint | undefined, model: string) {
  if (!endpoint || !isRecord(endpoint.tokenConfig)) return undefined;
  const value = endpoint.tokenConfig[model];
  return isRecord(value) ? value : undefined;
}

export function getMarketDraft(endpoint: CustomEndpoint | undefined, model: string): MarketDraft {
  const modelConfig = getModelConfig(endpoint, model);
  const market = modelConfig?.market;
  if (!isRecord(market)) return { ...EMPTY_MARKET_DRAFT };
  const officialPrompt = market.officialPrompt;
  return {
    published: market.published === true,
    officialPrompt:
      typeof officialPrompt === 'number' && Number.isFinite(officialPrompt)
        ? String(officialPrompt)
        : '',
  };
}

export function getModelMetadataDraft(
  endpoint: CustomEndpoint | undefined,
  model: string,
): ModelMetadataDraft {
  const context = getModelConfig(endpoint, model)?.context;
  return {
    context:
      typeof context === 'number' && Number.isInteger(context) && context > 0
        ? String(context)
        : '',
  };
}

export function parseModelMetadataDraft(draft: ModelMetadataDraft): { context: number | null } {
  const raw = draft.context.trim();
  if (!raw) return { context: null };
  const context = Number(raw);
  if (!Number.isInteger(context) || context <= 0) {
    throw new Error('context must be a positive integer');
  }
  return { context };
}

export function parseMarketDraft(draft: MarketDraft): {
  published: boolean;
  officialPrompt: number | null;
} {
  const raw = draft.officialPrompt.trim();
  if (!raw) return { published: draft.published, officialPrompt: null };
  const officialPrompt = Number(raw);
  if (!Number.isFinite(officialPrompt) || officialPrompt <= 0) {
    throw new Error('officialPrompt must be a positive number');
  }
  return { published: draft.published, officialPrompt };
}

export function hasComplexPricing(endpoint: CustomEndpoint | undefined, model: string): boolean {
  if (!endpoint || !isRecord(endpoint.tokenConfig)) return false;
  const value = endpoint.tokenConfig[model];
  if (value == null) return false;
  if (!isRecord(value)) return true;
  return PRICE_FIELDS.some((field) => {
    const price = value[field];
    return price != null && typeof price !== 'number';
  });
}

export function getPricingDraft(endpoint: CustomEndpoint | undefined, model: string): PricingDraft {
  const modelConfig = getModelConfig(endpoint, model);
  const draft = { ...EMPTY_PRICING_DRAFT };
  if (!modelConfig) return draft;
  for (const field of PRICE_FIELDS) {
    const value = modelConfig[field];
    if (typeof value === 'number' && Number.isFinite(value)) draft[field] = String(value);
  }
  return draft;
}

export function parsePricingDraft(draft: PricingDraft): Partial<Record<PriceField, number>> {
  const result: Partial<Record<PriceField, number>> = {};
  for (const field of PRICE_FIELDS) {
    const raw = draft[field].trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a non-negative number`);
    }
    result[field] = value;
  }
  return result;
}

export function updateModelPricing(
  endpoints: CustomEndpoint[],
  endpointIndex: number,
  model: string,
  draft: PricingDraft,
): CustomEndpoint[] {
  if (!endpoints[endpointIndex]) throw new Error('Endpoint not found');
  if (!model.trim()) throw new Error('Model is required');
  if (hasComplexPricing(endpoints[endpointIndex], model)) {
    throw new Error('Complex pricing must be edited in the general configuration page');
  }

  const next = endpoints.map((endpoint) => ({ ...endpoint }));
  const endpoint = next[endpointIndex];
  const tokenConfig = isRecord(endpoint.tokenConfig) ? { ...endpoint.tokenConfig } : {};
  const currentModelConfig = getModelConfig(endpoint, model);
  const modelConfig = currentModelConfig ? { ...currentModelConfig } : {};
  const parsed = parsePricingDraft(draft);

  for (const field of PRICE_FIELDS) {
    if (parsed[field] == null) delete modelConfig[field];
    else modelConfig[field] = parsed[field];
  }

  if (Object.keys(modelConfig).length > 0) tokenConfig[model] = modelConfig;
  else delete tokenConfig[model];

  if (Object.keys(tokenConfig).length > 0) endpoint.tokenConfig = tokenConfig;
  else delete endpoint.tokenConfig;
  return next;
}
