# User Usage Pricing Cutover And Cost Detail

Date: 2026-07-18

Status: design approved; implementation pending.

## Scope

1. Hide pre-correction usage for `gpt-5.6-sol` and `claude-fable-5` from the
   customer usage dashboard at the configured UTC cutoff corresponding to
   `2026-07-18 20:23:34 Asia/Singapore`.
2. Keep all MongoDB transactions and balances unchanged.
3. Show cost details using the resolved native `tokenConfig` from `req.config`:

```text
普通输入 = inputTokens × prompt / 1M
缓存读取 = cacheReadTokens × cacheRead / 1M
缓存写入 = cacheWriteTokens × cacheWrite / 1M
输出     = outputTokens × completion / 1M
费用合计 = four component costs summed
```

The authoritative displayed total remains the persisted transaction
`tokenValue / 1e6`. The calculated component sum is shown only when the
structured Token fields and matching native prices are available.

## Configuration

Production environment values:

```text
USER_USAGE_PRICING_CUTOFF=2026-07-18T12:23:34.480Z
USER_USAGE_PRICING_CUTOFF_MODELS=gpt-5.6-sol,claude-fable-5
```

The cutoff is applied before turn numbering and all dashboard facets, so cards,
trends, model distribution, logs, and pagination share one boundary.

Fable remains configured with `cacheWrite=3 USD / 1M` by product decision. The
NewAPI 1-hour cache tier at `4.8 USD / 1M` is not represented by the native
single-value LibreChat field.

## Verification

- unit tests for cutoff parsing, model filtering, price extraction, and cost
  formulas;
- production aggregation against MongoDB;
- browser verification of hidden pre-cutover rows and the full cost tooltip;
- no Mongo deletion or transaction update;
- only `LibreChat-API` recreation if deployment is required.

## Rollback

Restore the previous Compose override and versioned Client/API mounts. Remove
the cutoff environment values only as part of the rollback; do not delete
transactions.
