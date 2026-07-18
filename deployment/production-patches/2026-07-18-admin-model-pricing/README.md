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
- Admin image: `librechat-admin-panel-model-pricing:79ed55d2829f`;
- Admin container: `eb96970990635bfdaaff16c29895cfb8ef037d15a1cd057f729fd3260f8e8c07`;
- API container: `4d7253d5dacb01cfd1bf65fc181194a1a316d154f0ad8f529a95c62150f2bbd2`;
- Compose override SHA-256:
  `606b6cf5d4ae46173fc9703413b4e7b04872d4d2a7f5889b31546823bd951d6c`.

## Save Contract

Admin Config validates and merges custom endpoints as indexed array entries.
The pricing page must therefore save the selected endpoint using:

```text
endpoints.custom.<endpointIndex>
```

Submitting the complete `endpoints.custom` array is invalid and produces
`Validation failed — endpoints.custom: Required` before any Mongo override is
written. The release test rejects that full-array field path.

## Intended Initial Prices

```text
prompt      0.6  USD / 1M tokens
completion  3.6  USD / 1M tokens
cacheRead   0.06 USD / 1M tokens
cacheWrite  0.75 USD / 1M tokens
```

These values must be saved through the deployed Admin Panel page during live
acceptance, not injected directly into MongoDB.
