# User Usage Token Breakdown Release

Date: 2026-07-18

Status: deployed and browser-verified.

Final release commit: `fe30975`

Production hashes, container boundaries, browser acceptance, and NewAPI
reconciliation results are recorded in `DEPLOY_RESULT.md`.

## Objective

Expose the existing transaction Token components in the customer conversation
log without changing billing, transaction rows, summary totals, or historical
amounts.

## Data Contract

For each successful assistant reply, the usage dashboard transaction lookup
will aggregate:

```text
inputTokens       ordinary input tokens
readTokens        prompt-cache read tokens
writeTokens       prompt-cache write tokens
completion tokens output tokens
rawAmount         total billed tokens
tokenValue        authoritative billed cost
```

The API log row will add:

```json
{
  "tokenBreakdownAvailable": true,
  "inputTokens": 0,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "outputTokens": 0
}
```

`tokenBreakdownAvailable` is true only when every prompt transaction joined to
the reply contains the structured input/cache fields. Output tokens remain
available from completion transactions, but the UI must not present a partial
prompt split as complete.

## UI Contract

- keep the existing `Token 消耗` total in the conversation log;
- make the total a low-noise focusable detail control;
- on pointer hover or keyboard focus show ordinary input, cache read, cache
  write, output, and total;
- for legacy rows without structured fields show the total plus
  `历史明细不可拆分`;
- do not add columns or increase the normal table density;
- keep USD cost sourced from `transaction.tokenValue / 1e6`.

## Pricing Boundary

This release does not alter model prices. Fable cache writes remain uniformly
configured at `3 USD / 1M tokens`; the upstream `4.8 USD / 1M` one-hour cache
tier is intentionally not represented because LibreChat's native
`tokenConfig.cacheWrite` has one scalar rate.

## Verification

- pipeline tests for structured and legacy prompt rows;
- client tests for the detail tooltip and legacy wording;
- production aggregation test for non-negative component totals;
- request-level reconciliation against
  `JetsonChatbot_计费拆分_近3天.csv` using Singapore timestamps, model, total
  prompt tokens, and output tokens;
- deploy only the API usage route and mounted Client assets;
- preserve all unrelated container identities.

## Rollback

Restore the timestamped Compose override and previous versioned Client/API
route mounts, then recreate only `LibreChat-API`.
