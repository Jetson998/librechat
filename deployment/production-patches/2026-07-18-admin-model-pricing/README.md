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
- Admin image: `librechat-admin-panel-user-ui:e6a103c4218b`;
- Admin container: `bd888ea33f65c88d571c15dd8cff7b9a09be749ffb7ef3566cde56040a5fa8aa`;
- API container: `4d7253d5dacb01cfd1bf65fc181194a1a316d154f0ad8f529a95c62150f2bbd2`;
- Compose override SHA-256:
  `6ad105234ede74ded26ac29d5db9f2f68d2f55dbd972ceb3bc6ec1726741a702`.

## Intended Initial Prices

```text
prompt      0.6  USD / 1M tokens
completion  3.6  USD / 1M tokens
cacheRead   0.06 USD / 1M tokens
cacheWrite  0.75 USD / 1M tokens
```

These values must be saved through the deployed Admin Panel page during live
acceptance, not injected directly into MongoDB.
