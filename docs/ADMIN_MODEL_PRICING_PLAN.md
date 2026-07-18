# Admin Model Pricing Plan

Date: 2026-07-18

## Objective

Add a dedicated `模型价格` page to the LibreChat Admin Panel. The page must
write LibreChat's native custom-endpoint `tokenConfig`; it must not introduce a
parallel NewAPI ratio table or recalculate costs in the browser.

New successful requests will continue through LibreChat's existing pricing and
transaction pipeline:

```text
Admin Panel model price
  -> endpoints.custom[].tokenConfig
  -> LibreChat pricing.getMultiplier/getCacheMultiplier
  -> transactions.rate/tokenValue
  -> user usage dashboard cost
```

## Native Data Mapping

The form uses direct USD prices per one million tokens:

| Form field | LibreChat field |
| --- | --- |
| 基础价格 | `prompt` |
| 补全价格 | `completion` |
| 缓存读取价格 | `cacheRead` |
| 缓存创建价格 | `cacheWrite` |

Example:

```yaml
endpoints:
  custom:
    - name: MuskAPI
      tokenConfig:
        gpt-5.6-sol:
          prompt: 0.6
          completion: 3.6
          cacheRead: 0.06
          cacheWrite: 0.75
```

The page edits only these four keys. Existing keys such as `context`, `output`,
or future native fields must be preserved byte-for-value when prices are saved.
An empty optional price removes only that price key. If a model entry becomes
empty, the model key is removed from `tokenConfig`.

## UX

- Add `模型价格` to the Admin Panel sidebar and route it at `/pricing`.
- Require `READ_CONFIGS` to view and `MANAGE_CONFIGS` to save.
- Select a custom endpoint, then search/select a model from the endpoint model
  list plus existing `tokenConfig` keys.
- Show direct decimal inputs with the unit `$/1M tokens`.
- Show a low-noise explanation that prices apply to new requests only.
- Show a save preview containing the exact native `tokenConfig` fields that
  will be written.
- Disable saving when the form is unchanged or the administrator lacks
  permission.
- Keep image/audio, per-request, and expression billing out of this release
  because they are not native `tokenConfig` fields and would require changes to
  LibreChat's transaction engine.

## Save Contract

Use a dedicated Admin server action that PATCHes only
`endpoints.custom.<index>.tokenConfig` through the supported base-config API.
The browser sends only the endpoint index, model name, and four fixed numeric
fields. The server action reads the current endpoint and reconstructs the
dynamic model-keyed tokenConfig while preserving unrelated model fields.
The generic indexed-array helper must not be used here: it expands the change
to the complete `endpoints.custom` array, and the nested dynamic model-price
record is not preserved by that general editing path. The page must not write
MongoDB directly.

After save:

- invalidate `baseConfig` and `resolvedConfig` queries;
- reload the saved endpoint/model values;
- show a success notification;
- leave unrelated endpoint configuration unchanged.

## Verification

Local:

- pricing data extraction and immutable update unit tests;
- empty-value removal and preservation tests;
- Admin Panel typecheck and focused test suite;
- production image build preflight;
- `git diff --check` and secret scan.

Production:

1. Read-only audit current endpoint names, models, and tokenConfig.
2. Deploy only committed Admin Panel artifacts.
3. Save the four approved `gpt-5.6-sol` prices through the page.
4. Verify the resolved config contains the native values.
5. Submit one small test request and verify its new transaction rows use the
   configured prompt/completion/cache rates.
6. Verify the user usage dashboard reflects the authoritative transaction cost.
7. Preserve Office, CodeAPI, RAG, MongoDB, Nginx, and unrelated model settings.
