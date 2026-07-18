# User Usage USD Symbol

Date: 2026-07-18

Status: implementation complete; production deployment pending.

## Problem

The usage dashboard formats USD with the `zh-CN` locale and the default
`Intl.NumberFormat` currency display. Browsers therefore render values such as
`US$0.00`, while the product UI only needs the unambiguous compact `$0.00`.

## Design

Use `currencyDisplay: 'narrowSymbol'` in the dashboard's shared currency
formatters. This keeps cards, trend axes and tooltips, conversation logs, and
cost formulas consistent without changing stored costs, pricing configuration,
or backend aggregation.

## Verification

- assert that the shared amount and rate formatters use `narrowSymbol`;
- verify USD formats as `$0.00` and no `US$` literal is introduced;
- deploy only the versioned Client asset and recreate only `LibreChat-API` if
  production deployment is approved.

## Rollback

Restore the prior versioned Client asset mount. No database or API rollback is
required.
