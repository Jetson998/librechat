# Admin Model Pricing Release

Date: 2026-07-18

This release adds a dedicated `模型价格` page to the existing Simplified
Chinese LibreChat Admin Panel.

## Scope

- add `/pricing` and a `模型价格` sidebar entry;
- discover custom endpoints and configured models from resolved Admin Config;
- edit direct `prompt`, `completion`, `cacheRead`, and `cacheWrite` prices;
- display prices in USD per one million tokens;
- preview the exact native `tokenConfig` keys before saving;
- save through the existing Admin Config API and preserve unrelated endpoint
  fields;
- leave the LibreChat pricing engine, transaction writer, user dashboard,
  Office, CodeAPI, RAG, Nginx, and Mongo schema unchanged.

The implementation source remains in:

```text
deployment/production-patches/2026-07-11-admin-panel-zh-cn/source
```

The approved design is recorded in:

```text
docs/ADMIN_MODEL_PRICING_PLAN.md
```

## Production Baseline

- endpoint: `MuskAPI`;
- model: `gpt-5.6-sol`;
- YAML `tokenConfig`: absent;
- Mongo base override `tokenConfig`: absent;
- Admin image: `librechat-admin-panel-model-pricing:b8a725a0b06a`;
- Admin container: `95de9f93ec9176fbadad6e66da98598307a6e4e466a3456f6c5f91effc2620c8`;
- API container at the latest preflight:
  `a834cd68ea0fa5c0e89bab5a301ce07d80ed8da0f484e786ac473a3baac815c8`;
- Compose override SHA-256:
  `a2ec0ad577861ede3543b9973ea246e5cd193ba02ec6fc69e5966d744def935d`.

## Save Contract

The generic Admin Config editor validates and merges custom endpoints as
indexed array entries, but model pricing must not use the resulting full-array
save. The dedicated pricing action PATCHes only:

```text
endpoints.custom.<endpointIndex>.tokenConfig
```

The browser sends fixed scalar fields only. The Admin server reconstructs the
dynamic model-keyed record after reading the current base config, avoiding the
loss of nested model prices across the server-action serialization boundary.

Submitting the complete `endpoints.custom` array first produced
`Validation failed — endpoints.custom: Required`; after changing only the
array index, the API accepted the request but did not retain the dynamic model
price record. The release test now requires the dedicated tokenConfig action
and rejects the generic full-array save from the pricing page.

After a complete preflight has built the source-hash-tagged image, production
deployment may set `REUSE_PREFLIGHT_IMAGE=true`. The script then requires that
exact image and architecture instead of rebuilding under a second memory gate;
all container and health checks still run.

## Intended Initial Prices

```text
prompt      0.6  USD / 1M tokens
completion  3.6  USD / 1M tokens
cacheRead   0.06 USD / 1M tokens
cacheWrite  0.75 USD / 1M tokens
```

These values must be saved through the deployed Admin Panel page during live
acceptance, not injected directly into MongoDB.
