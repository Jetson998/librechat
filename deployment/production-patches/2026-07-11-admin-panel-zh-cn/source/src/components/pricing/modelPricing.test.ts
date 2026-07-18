import { describe, expect, it } from 'vitest';
import {
  getEndpointModels,
  getMarketDraft,
  getPricingDraft,
  hasComplexPricing,
  updateModelPricing,
  parseMarketDraft,
  type CustomEndpoint,
} from './modelPricing';

const endpoint: CustomEndpoint = {
  name: 'MuskAPI',
  models: { default: ['gpt-5.6-sol'], fetch: false },
  tokenConfig: {
    'gpt-5.6-sol': { context: 800000, prompt: 0.5 },
    'legacy-model': { prompt: 1 },
  },
};

describe('model pricing helpers', () => {
  it('combines endpoint models and existing tokenConfig keys', () => {
    expect(getEndpointModels(endpoint)).toEqual(['gpt-5.6-sol', 'legacy-model']);
  });

  it('reads direct numeric prices into the form draft', () => {
    expect(getPricingDraft(endpoint, 'gpt-5.6-sol')).toEqual({
      prompt: '0.5',
      completion: '',
      cacheRead: '',
      cacheWrite: '',
    });
  });

  it('reads and validates market metadata independently from billing prices', () => {
    const marketEndpoint: CustomEndpoint = {
      ...endpoint,
      tokenConfig: {
        ...endpoint.tokenConfig,
        'gpt-5.6-sol': {
          context: 800000,
          prompt: 0.5,
          market: { published: true, officialPrompt: 1.25 },
        },
      },
    };
    expect(getMarketDraft(marketEndpoint, 'gpt-5.6-sol')).toEqual({
      published: true,
      officialPrompt: '1.25',
    });
    expect(parseMarketDraft({ published: true, officialPrompt: '1.25' })).toEqual({
      published: true,
      officialPrompt: 1.25,
    });
    expect(() => parseMarketDraft({ published: true, officialPrompt: '0' })).toThrow();
  });

  it('updates native prices while preserving non-price fields', () => {
    const [updated] = updateModelPricing([endpoint], 0, 'gpt-5.6-sol', {
      prompt: '0.6',
      completion: '3.6',
      cacheRead: '0.06',
      cacheWrite: '0.75',
    });
    expect(updated.tokenConfig?.['gpt-5.6-sol']).toEqual({
      context: 800000,
      prompt: 0.6,
      completion: 3.6,
      cacheRead: 0.06,
      cacheWrite: 0.75,
    });
    expect(endpoint.tokenConfig?.['gpt-5.6-sol']).toEqual({ context: 800000, prompt: 0.5 });
  });

  it('removes only cleared price fields', () => {
    const [updated] = updateModelPricing([endpoint], 0, 'gpt-5.6-sol', {
      prompt: '',
      completion: '',
      cacheRead: '',
      cacheWrite: '',
    });
    expect(updated.tokenConfig?.['gpt-5.6-sol']).toEqual({ context: 800000 });
  });

  it('blocks unsupported complex price values', () => {
    const complex: CustomEndpoint = {
      name: 'Tiered',
      tokenConfig: { model: { prompt: { default: 1 } } },
    };
    expect(hasComplexPricing(complex, 'model')).toBe(true);
  });
});
