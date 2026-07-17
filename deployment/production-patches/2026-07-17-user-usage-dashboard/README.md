# User Price And Usage Dashboard Release

Date: 2026-07-17

Status: design gate; production baseline and implementation pending.

## Reason

Expose a lightweight, user-isolated price and usage dashboard from the main
LibreChat `My` menu.

## Feature List

- add `我的 -> 价格用量统计`;
- show 7-day, 30-day, and all-time cards and trends;
- show Token usage, cost, conversation instances, reply turns, average context,
  and average turns;
- show a successful-reply conversation log;
- support searchable model and conversation filters;
- show provider logos without provider text;
- protect all data by authenticated user identity.

## Intended Services

Expected scope, subject to production preflight:

```text
LibreChat-API
LibreChat-Client
```

The release must not recreate MongoDB, CodeAPI, Office Converter, Nginx, RAG,
or Admin Panel unless the committed implementation proves one is required.

## Source And Baseline

The active production API and Client baselines must be collected read-only and
archived in this directory before implementation. Do not use a historical July
patch as the active baseline without hash and mount verification.

## Included Design Artifact

```text
docs/USER_USAGE_DASHBOARD_PLAN.md
docs/demos/user-usage-dashboard-demo.html
```

## Verification Plan

- API user-isolation and aggregation tests;
- frontend menu, page, filter, range, empty, and error-state tests;
- Client build and API syntax checks;
- production login and simple-chat smoke tests;
- two-user browser isolation acceptance;
- fresh-conversation increment check;
- unchanged neighboring-container checks.

## Rollback

Restore timestamp-matched API/Client backups or previous images and the prior
Compose override, recreate only affected services, then rerun root, config,
login, chat, upload-label, and Office boundary smoke tests.

## Production Result

Not deployed.
