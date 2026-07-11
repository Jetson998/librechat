# Admin Panel Runtime Configuration Record

Purpose: record browser-side Admin Panel configuration changes that happen after
the image release is deployed.

This file is for durable operator history. It separates:

- image release changes tracked by git and deployment artifacts
- runtime config changes saved through the Admin Panel UI

If a setting is changed in the browser, append a new entry below before the next
production release.

## Rules

- Record exact changed field paths when known.
- Record whether the source of truth is repository config or Admin Panel saved
  override.
- Record whether the change affects default model, icon, locale, or endpoint
  behavior.
- Do not store secrets or raw credentials here.

## Current Known State

- Release image: `librechat-admin-panel-zh-cn:95388ccb14d2`
- Release deploy timestamp: `20260711231635`
- MongoDB `configs` count at deploy: `0`
- At deployment time, no Admin Panel saved override was present.

## Change Log Template

Copy this block and append one entry per runtime change:

```text
Date:
Operator:
Environment: production
Admin URL: https://admin.152.32.172.162.sslip.io/
Area: Configuration / Specs / Access / Grants / Other
Field path:
Before:
After:
Saved through Admin Panel: yes/no
Persisted in MongoDB configs: yes/no/unknown
Related repo commit:
Verification:
Notes:
```
