import { Button, Icon } from '@clickhouse/click-ui';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EMPTY_PRICING_DRAFT,
  EMPTY_MODEL_METADATA_DRAFT,
  EMPTY_MARKET_DRAFT,
  PRICE_FIELDS,
  getCustomEndpoints,
  getEndpointModels,
  getMarketDraft,
  getModelMetadataDraft,
  getPricingDraft,
  hasComplexPricing,
  parsePricingDraft,
  parseModelMetadataDraft,
  parseMarketDraft,
  type MarketDraft,
  type ModelMetadataDraft,
  type PriceField,
  type PricingDraft,
} from './modelPricing';
import { baseConfigOptions, saveCustomEndpointTokenConfigFn } from '@/server';
import { EmptyState, LoadingState } from '@/components/shared';
import { cn, notifyError, notifySuccess } from '@/utils';
import { useCapabilities, useLocalize } from '@/hooks';
import { SystemCapabilities } from '@/constants';

const FIELD_KEYS: Record<PriceField, { label: string; description: string; backend: string }> = {
  prompt: {
    label: 'com_pricing_prompt_label',
    description: 'com_pricing_prompt_desc',
    backend: 'prompt',
  },
  completion: {
    label: 'com_pricing_completion_label',
    description: 'com_pricing_completion_desc',
    backend: 'completion',
  },
  cacheRead: {
    label: 'com_pricing_cache_read_label',
    description: 'com_pricing_cache_read_desc',
    backend: 'cacheRead',
  },
  cacheWrite: {
    label: 'com_pricing_cache_write_label',
    description: 'com_pricing_cache_write_desc',
    backend: 'cacheWrite',
  },
};

export function ModelPricingPage() {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { hasCapability } = useCapabilities();
  const canManage = hasCapability(SystemCapabilities.MANAGE_CONFIGS);
  const { data, isLoading, isError } = useQuery(baseConfigOptions);
  const endpoints = useMemo(() => getCustomEndpoints(data?.config), [data?.config]);
  const [endpointIndex, setEndpointIndex] = useState(0);
  const endpoint = endpoints[endpointIndex];
  const models = useMemo(() => getEndpointModels(endpoint), [endpoint]);
  const [modelSearch, setModelSearch] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [draft, setDraft] = useState<PricingDraft>({ ...EMPTY_PRICING_DRAFT });
  const [metadataDraft, setMetadataDraft] = useState<ModelMetadataDraft>({
    ...EMPTY_MODEL_METADATA_DRAFT,
  });
  const [marketDraft, setMarketDraft] = useState<MarketDraft>({ ...EMPTY_MARKET_DRAFT });

  useEffect(() => {
    if (endpointIndex >= endpoints.length) setEndpointIndex(0);
  }, [endpointIndex, endpoints.length]);

  useEffect(() => {
    if (!models.includes(selectedModel)) setSelectedModel(models[0] ?? '');
  }, [models, selectedModel]);

  const savedDraft = useMemo(
    () => getPricingDraft(endpoint, selectedModel),
    [endpoint, selectedModel],
  );
  const savedMarketDraft = useMemo(
    () => getMarketDraft(endpoint, selectedModel),
    [endpoint, selectedModel],
  );
  const savedMetadataDraft = useMemo(
    () => getModelMetadataDraft(endpoint, selectedModel),
    [endpoint, selectedModel],
  );

  useEffect(() => {
    setDraft(savedDraft);
  }, [savedDraft]);

  useEffect(() => {
    setMarketDraft(savedMarketDraft);
  }, [savedMarketDraft]);

  useEffect(() => {
    setMetadataDraft(savedMetadataDraft);
  }, [savedMetadataDraft]);

  const filteredModels = models.filter((model) =>
    model.toLowerCase().includes(modelSearch.trim().toLowerCase()),
  );
  const isComplex = hasComplexPricing(endpoint, selectedModel);
  const isDirty =
    PRICE_FIELDS.some((field) => draft[field] !== savedDraft[field]) ||
    metadataDraft.context !== savedMetadataDraft.context ||
    marketDraft.published !== savedMarketDraft.published ||
    marketDraft.officialPrompt !== savedMarketDraft.officialPrompt;

  let preview: Partial<Record<PriceField, number>> = {};
  let metadataPreview: { context: number | null } = { context: null };
  let marketPreview: { published: boolean; officialPrompt: number | null } = {
    published: false,
    officialPrompt: null,
  };
  let validationError = '';
  try {
    metadataPreview = parseModelMetadataDraft(metadataDraft);
  } catch {
    validationError = localize('com_pricing_invalid_context');
  }
  try {
    preview = parsePricingDraft(draft);
    marketPreview = parseMarketDraft(marketDraft);
  } catch {
    if (!validationError) validationError = localize('com_pricing_invalid_price');
  }

  const inputDiscount =
    preview.prompt != null && marketPreview.officialPrompt != null
      ? ((marketPreview.officialPrompt - preview.prompt) / marketPreview.officialPrompt) * 100
      : null;

  const saveMutation = useMutation({
    mutationFn: async () => {
      return saveCustomEndpointTokenConfigFn({
        data: {
          endpointIndex,
          model: selectedModel,
          context: metadataPreview.context,
          prompt: preview.prompt ?? null,
          completion: preview.completion ?? null,
          cacheRead: preview.cacheRead ?? null,
          cacheWrite: preview.cacheWrite ?? null,
          marketPublished: marketPreview.published,
          officialPrompt: marketPreview.officialPrompt,
        },
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['baseConfig'] }),
        queryClient.invalidateQueries({ queryKey: ['resolvedConfig'] }),
      ]);
      notifySuccess(localize('com_pricing_saved'));
    },
    onError: (error: Error) => notifyError(error.message),
  });

  if (isLoading) return <LoadingState />;
  if (isError) return <EmptyState message={localize('com_pricing_load_error')} />;
  if (endpoints.length === 0) {
    return <EmptyState message={localize('com_pricing_no_endpoints')} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-release-marker="admin-model-pricing">
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] overflow-hidden">
        <aside className="flex min-h-0 flex-col border-r border-(--cui-color-stroke-default) bg-(--cui-color-background-panel) p-4">
          <label
            className="mb-1.5 text-xs font-medium text-(--cui-color-text-muted)"
            htmlFor="pricing-endpoint"
          >
            {localize('com_pricing_endpoint')}
          </label>
          <select
            id="pricing-endpoint"
            value={endpointIndex}
            onChange={(event) => {
              setEndpointIndex(Number(event.target.value));
              setModelSearch('');
            }}
            className="h-9 rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-2.5 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
          >
            {endpoints.map((item, index) => (
              <option key={`${item.name ?? 'endpoint'}-${index}`} value={index}>
                {item.name || localize('com_pricing_unnamed_endpoint')}
              </option>
            ))}
          </select>

          <label
            className="mt-5 mb-1.5 text-xs font-medium text-(--cui-color-text-muted)"
            htmlFor="pricing-model-search"
          >
            {localize('com_pricing_model')}
          </label>
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-(--cui-color-text-muted)"
            >
              <Icon name="search" size="xs" />
            </span>
            <input
              id="pricing-model-search"
              type="search"
              value={modelSearch}
              onChange={(event) => setModelSearch(event.target.value)}
              placeholder={localize('com_pricing_search_model')}
              className="h-9 w-full rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) pr-2.5 pl-8 text-sm text-(--cui-color-text-default) outline-none placeholder:text-(--cui-color-text-disabled) focus:border-(--cui-color-stroke-intense)"
            />
          </div>

          <div
            className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
            role="listbox"
            aria-label={localize('com_pricing_model')}
          >
            {filteredModels.map((model) => (
              <button
                key={model}
                type="button"
                role="option"
                aria-selected={selectedModel === model}
                onClick={() => setSelectedModel(model)}
                className={cn(
                  'flex min-h-9 items-center rounded-md px-2.5 text-left text-sm transition-colors',
                  selectedModel === model
                    ? 'bg-(--cui-color-background-active) font-medium text-(--cui-color-text-default)'
                    : 'text-(--cui-color-text-muted) hover:bg-(--cui-color-background-hover) hover:text-(--cui-color-text-default)',
                )}
              >
                <span className="truncate">{model}</span>
              </button>
            ))}
            {filteredModels.length === 0 && (
              <p className="px-2.5 py-3 text-xs text-(--cui-color-text-muted)">
                {localize('com_pricing_no_models')}
              </p>
            )}
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto p-6">
          <div className="mx-auto flex max-w-4xl flex-col gap-5">
            <section>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-xl font-semibold text-(--cui-color-title-default)">
                    {selectedModel}
                  </h1>
                  <p className="mt-1 text-sm text-(--cui-color-text-muted)">
                    {localize('com_pricing_new_requests_only')}
                  </p>
                </div>
                <span className="rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-muted) px-2.5 py-1 text-xs font-medium text-(--cui-color-text-muted)">
                  {localize('com_pricing_usage_billing')}
                </span>
              </div>
            </section>

            {isComplex && (
              <div
                role="alert"
                className="rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-muted) px-4 py-3 text-sm text-(--cui-color-text-muted)"
              >
                {localize('com_pricing_complex_warning')}
              </div>
            )}

            <section className="overflow-hidden rounded-lg border border-(--cui-color-stroke-default)">
              <div className="border-b border-(--cui-color-stroke-default) bg-(--cui-color-background-muted) px-4 py-3">
                <h2 className="text-sm font-semibold text-(--cui-color-text-default)">
                  {localize('com_pricing_model_spec')}
                </h2>
                <p className="mt-0.5 text-xs text-(--cui-color-text-muted)">
                  {localize('com_pricing_model_spec_desc')}
                </p>
              </div>
              <div className="grid grid-cols-[minmax(180px,1fr)_minmax(240px,320px)] items-center gap-6 px-4 py-3.5">
                <div>
                  <label
                    htmlFor="pricing-context"
                    className="text-sm font-medium text-(--cui-color-text-default)"
                  >
                    {localize('com_pricing_context_label')}
                  </label>
                  <p className="mt-0.5 text-xs text-(--cui-color-text-muted)">
                    {localize('com_pricing_context_desc')}
                  </p>
                </div>
                <div className="flex h-9 items-center overflow-hidden rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) focus-within:border-(--cui-color-stroke-intense)">
                  <input
                    id="pricing-context"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    value={metadataDraft.context}
                    disabled={!canManage || isComplex || saveMutation.isPending}
                    onChange={(event) => setMetadataDraft({ context: event.target.value })}
                    placeholder={localize('com_pricing_context_placeholder')}
                    className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-sm text-(--cui-color-text-default) outline-none placeholder:text-(--cui-color-text-disabled) disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <span className="shrink-0 border-l border-(--cui-color-stroke-default) px-3 text-xs text-(--cui-color-text-muted)">
                    Token
                  </span>
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-(--cui-color-stroke-default)">
              <div className="border-b border-(--cui-color-stroke-default) bg-(--cui-color-background-muted) px-4 py-3">
                <h2 className="text-sm font-semibold text-(--cui-color-text-default)">
                  {localize('com_pricing_direct_prices')}
                </h2>
                <p className="mt-0.5 text-xs text-(--cui-color-text-muted)">
                  {localize('com_pricing_optional_hint')}
                </p>
              </div>
              <div className="divide-y divide-(--cui-color-stroke-default)">
                {PRICE_FIELDS.map((field) => (
                  <PriceInput
                    key={field}
                    field={field}
                    value={draft[field]}
                    disabled={!canManage || isComplex || saveMutation.isPending}
                    onChange={(value) => setDraft((current) => ({ ...current, [field]: value }))}
                    localize={localize}
                  />
                ))}
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-(--cui-color-stroke-default)">
              <div className="border-b border-(--cui-color-stroke-default) bg-(--cui-color-background-muted) px-4 py-3">
                <h2 className="text-sm font-semibold text-(--cui-color-text-default)">
                  {localize('com_pricing_market_title')}
                </h2>
                <p className="mt-0.5 text-xs text-(--cui-color-text-muted)">
                  {localize('com_pricing_market_desc')}
                </p>
              </div>
              <div className="divide-y divide-(--cui-color-stroke-default)">
                <label className="grid grid-cols-[minmax(180px,1fr)_minmax(240px,320px)] items-center gap-6 px-4 py-3.5">
                  <span>
                    <span className="block text-sm font-medium text-(--cui-color-text-default)">
                      {localize('com_pricing_market_publish')}
                    </span>
                    <span className="mt-0.5 block text-xs text-(--cui-color-text-muted)">
                      {localize('com_pricing_market_publish_desc')}
                    </span>
                  </span>
                  <span className="flex justify-end">
                    <input
                      type="checkbox"
                      checked={marketDraft.published}
                      disabled={!canManage || isComplex || saveMutation.isPending}
                      onChange={(event) =>
                        setMarketDraft((current) => ({
                          ...current,
                          published: event.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-(--cui-color-accent-default)"
                    />
                  </span>
                </label>
                <div className="grid grid-cols-[minmax(180px,1fr)_minmax(240px,320px)] items-center gap-6 px-4 py-3.5">
                  <div>
                    <label
                      htmlFor="pricing-official-prompt"
                      className="text-sm font-medium text-(--cui-color-text-default)"
                    >
                      {localize('com_pricing_official_prompt')}
                    </label>
                    <p className="mt-0.5 text-xs text-(--cui-color-text-muted)">
                      {localize('com_pricing_official_prompt_desc')}
                    </p>
                  </div>
                  <div>
                    <div className="flex h-9 items-center overflow-hidden rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) focus-within:border-(--cui-color-stroke-intense)">
                      <input
                        id="pricing-official-prompt"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={marketDraft.officialPrompt}
                        disabled={!canManage || isComplex || saveMutation.isPending}
                        onChange={(event) =>
                          setMarketDraft((current) => ({
                            ...current,
                            officialPrompt: event.target.value,
                          }))
                        }
                        placeholder={localize('com_pricing_input_price')}
                        className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-sm text-(--cui-color-text-default) outline-none placeholder:text-(--cui-color-text-disabled) disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <span className="shrink-0 border-l border-(--cui-color-stroke-default) px-3 text-xs text-(--cui-color-text-muted)">
                        $/1M tokens
                      </span>
                    </div>
                    <p className="mt-1.5 text-right text-xs text-(--cui-color-text-muted)">
                      {inputDiscount == null
                        ? localize('com_pricing_market_discount_unavailable')
                        : localize('com_pricing_market_discount_preview', {
                            percent: Math.max(0, inputDiscount).toFixed(1),
                          })}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-(--cui-color-stroke-default)">
              <div className="border-b border-(--cui-color-stroke-default) bg-(--cui-color-background-muted) px-4 py-3">
                <h2 className="text-sm font-semibold text-(--cui-color-text-default)">
                  {localize('com_pricing_save_preview')}
                </h2>
                <p className="mt-0.5 text-xs text-(--cui-color-text-muted)">
                  {localize('com_pricing_preview_desc')}
                </p>
              </div>
              <dl className="divide-y divide-(--cui-color-stroke-default)">
                <div className="grid grid-cols-[minmax(160px,1fr)_minmax(120px,auto)] items-center gap-4 px-4 py-2.5 text-sm">
                  <dt className="font-mono text-xs text-(--cui-color-text-muted)">context</dt>
                  <dd className="text-right font-medium text-(--cui-color-text-default)">
                    {metadataPreview.context == null
                      ? localize('com_pricing_not_set')
                      : `${metadataPreview.context} Token`}
                  </dd>
                </div>
                {PRICE_FIELDS.map((field) => (
                  <div
                    key={field}
                    className="grid grid-cols-[minmax(160px,1fr)_minmax(120px,auto)] items-center gap-4 px-4 py-2.5 text-sm"
                  >
                    <dt className="font-mono text-xs text-(--cui-color-text-muted)">
                      {FIELD_KEYS[field].backend}
                    </dt>
                    <dd className="text-right font-medium text-(--cui-color-text-default)">
                      {preview[field] == null
                        ? localize('com_pricing_not_set')
                        : `${preview[field]} $/1M tokens`}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            {validationError && (
              <p role="alert" className="text-sm text-(--cui-color-text-danger)">
                {validationError}
              </p>
            )}
          </div>
        </main>
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-6 py-3">
        <span className="text-xs text-(--cui-color-text-muted)">
          {canManage
            ? localize('com_pricing_native_config_note')
            : localize('com_pricing_read_only')}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            type="secondary"
            label={localize('com_pricing_discard')}
            onClick={() => {
              setDraft(savedDraft);
              setMetadataDraft(savedMetadataDraft);
              setMarketDraft(savedMarketDraft);
            }}
            disabled={!isDirty || saveMutation.isPending}
          />
          <Button
            type="primary"
            label={saveMutation.isPending ? localize('com_ui_loading') : localize('com_ui_save')}
            onClick={() => saveMutation.mutate()}
            disabled={
              !canManage || !isDirty || !!validationError || isComplex || saveMutation.isPending
            }
          />
        </div>
      </footer>
    </div>
  );
}

function PriceInput({
  field,
  value,
  disabled,
  onChange,
  localize,
}: {
  field: PriceField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  localize: (key: string, values?: Record<string, string | number>) => string;
}) {
  const meta = FIELD_KEYS[field];
  return (
    <div className="grid grid-cols-[minmax(180px,1fr)_minmax(240px,320px)] items-center gap-6 px-4 py-3.5">
      <div>
        <label
          htmlFor={`pricing-${field}`}
          className="text-sm font-medium text-(--cui-color-text-default)"
        >
          {localize(meta.label)}
        </label>
        <p className="mt-0.5 text-xs text-(--cui-color-text-muted)">{localize(meta.description)}</p>
      </div>
      <div className="flex h-9 items-center overflow-hidden rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) focus-within:border-(--cui-color-stroke-intense)">
        <input
          id={`pricing-${field}`}
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={localize('com_pricing_input_price')}
          className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-sm text-(--cui-color-text-default) outline-none placeholder:text-(--cui-color-text-disabled) disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="shrink-0 border-l border-(--cui-color-stroke-default) px-3 text-xs text-(--cui-color-text-muted)">
          $/1M tokens
        </span>
      </div>
    </div>
  );
}
