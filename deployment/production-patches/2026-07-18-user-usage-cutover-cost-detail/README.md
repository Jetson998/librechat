# User Usage Pricing Cutover And Cost Detail

Date: 2026-07-18

Status: deployed and verified.

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

## Production Release Record

Implementation commit: `57ed9f9`

Design commit: `7484ebf`

Deployment timestamp: `2026-07-18 21:25:27 Asia/Singapore`

Release root:

```text
/opt/librechat/user-usage-cutover-cost-detail/57ed9f9-20260718212527
```

Backup:

```text
/opt/librechat/backups/user-usage-cutover-cost-detail-20260718212527
```

The deployment recreated only `LibreChat-API`. The protected NGINX, CodeAPI,
RAG API, MongoDB, and Admin Panel containers were preserved. The resulting API
container was:

```text
248e103b3c8cae55dac9b4af5340d92176e2c635ccb7ee32f1ed7a7bf5caa253
```

Production checks passed for API health, the unauthenticated dashboard route
(`401`), asset versioning, aggregation tests, and protected-container
stability. Browser acceptance confirmed that overview cards, trends, model
distribution, logs, and pagination all apply the same cutoff.

The signed-in acceptance account had no post-cutover requests, so its dashboard
correctly showed zero rows. The live cost-detail tooltip is ready but requires
the first new GPT or Fable request after the cutoff for production observation.

## Data And Pricing Semantics

Historical GPT/Fable transactions remain in MongoDB and historical balances are
unchanged. They are excluded only by dashboard aggregation when their model and
timestamp are before the cutoff.

The token breakdown is aligned with the native pricing configuration:

```text
普通输入   -> prompt
缓存读取   -> cacheRead
缓存写入   -> cacheWrite
输出       -> completion
```

Each component is calculated as `tokens × configured USD/M tokens / 1,000,000`.
The persisted `transaction.tokenValue` remains the authoritative displayed
total; component details are shown only when structured token fields and the
matching native prices are available.

## Rollback

Restore the previous Compose override and versioned Client/API mounts. Remove
the cutoff environment values only as part of the rollback; do not delete
transactions.
