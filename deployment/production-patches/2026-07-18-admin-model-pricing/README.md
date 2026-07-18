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
- Admin image: `librechat-admin-panel-model-pricing:606b888f9fca`;
- Admin container: `1294763c6667334d479863d7341ed869e70eee1ddd288275c59c00dda3dcd503`;
- API container at the latest preflight:
  `a834cd68ea0fa5c0e89bab5a301ce07d80ed8da0f484e786ac473a3baac815c8`;
- Compose override SHA-256:
  `5d2e58ff45c766916ad67edbcd5ec6da4cdcb5ab9911540f455e21a761f3acfb`.

## Save Contract

The generic Admin Config editor validates and merges custom endpoints as
indexed array entries, but model pricing must not use the resulting full-array
save. The dedicated pricing action PATCHes only:

```text
endpoints.custom.<endpointIndex>.tokenConfig
```

Submitting the complete `endpoints.custom` array first produced
`Validation failed — endpoints.custom: Required`; after changing only the
array index, the API accepted the request but did not retain the dynamic model
price record. The release test now requires the dedicated tokenConfig action
and rejects the generic full-array save from the pricing page.

## Intended Initial Prices

```text
prompt      0.6  USD / 1M tokens
completion  3.6  USD / 1M tokens
cacheRead   0.06 USD / 1M tokens
cacheWrite  0.75 USD / 1M tokens
```

These values must be saved through the deployed Admin Panel page during live
acceptance, not injected directly into MongoDB.
