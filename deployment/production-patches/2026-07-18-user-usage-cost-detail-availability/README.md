# User Usage Cost Detail Availability

Date: 2026-07-18

Status: implementation complete; production deployment pending.

## Problem

The conversation log can show an authoritative total cost while its tooltip says
`费用明细不可用`. The pricing resolver currently treats every duplicate model name
across custom endpoints as ambiguous, even when all copies have identical native
`tokenConfig` prices. It also requires a price for zero-Token components.

Production verification identified the primary runtime cause: the custom
`/api/user/usage-dashboard` route did not include LibreChat's existing
`configMiddleware`. Therefore `req.config` was empty and no native model price
could be resolved, regardless of endpoint matching.

## Design

1. Treat duplicate model pricing as reusable by model name when all four native
   price fields are identical. Keep genuinely different duplicate prices
   ambiguous unless the log endpoint matches exactly.
2. Add the existing `configMiddleware` to the authenticated usage-dashboard
   route so the handler receives the effective Admin Panel configuration.
3. Require a price only for components whose Token count is greater than zero.
4. Expand only the participating cost components:

```text
普通输入：2,010 × $0.60/M = $0.0012
缓存读取：166,400 × $0.06/M = $0.0100
输出：1,459 × $3.60/M = $0.0053
费用合计：$0.0164
```

Zero-Token components are omitted. The persisted transaction cost remains the
authoritative total and is shown separately only when it differs materially from
the component calculation.

## Scope

- usage dashboard API pricing resolution;
- conversation-log cost tooltip rendering;
- focused aggregation and client tests;
- no transaction, balance, model price, or historical data changes.

## Rollback

Restore the prior versioned usage API and Client assets. No database rollback is
required.
