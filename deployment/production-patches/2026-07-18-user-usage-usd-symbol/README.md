# User Usage USD Symbol

Date: 2026-07-18

Status: deployed and verified.

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

## Production Result

Implementation commit: `18f26d7`

Guarded deployment commit: `0b57393`

Release root:

```text
/opt/librechat/user-usage-usd-symbol/0b57393fab4b-20260718214145
```

Backup:

```text
/opt/librechat/backups/user-usage-usd-symbol-20260718214145
```

Only `LibreChat-API` was recreated. Browser acceptance after a full page reload
confirmed that the live usage card displays `$0.0052` instead of `US$0.0052`.
