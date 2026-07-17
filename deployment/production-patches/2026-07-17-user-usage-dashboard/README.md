# User Price And Usage Dashboard Release

Date: 2026-07-17

Status: deployed and browser-verified.

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

## API And Data Rules

The release adds one authenticated endpoint:

```text
GET /api/user/usage-dashboard
```

- identity is derived only from `req.user.id`;
- one log row is one successful assistant reply;
- transaction rows are joined by authenticated user plus reply `messageId`;
- only `context=message` is included;
- Agent-internal calls sharing the reply message are included;
- title and summarization transactions are excluded;
- transaction `rawAmount` is the authoritative Token source;
- transaction `tokenValue / 1e6` is authoritative USD cost;
- production converts USD to CNY once on the server with `USER_USAGE_USD_TO_CNY=7.2`;
- missing historical cost remains `null` and is marked incomplete in totals.

The endpoint never returns prompts, responses, file names, credentials, or a browser-supplied
user ID.

## Included Files

```text
api/user.js
api/usage-dashboard.js
client/user-usage-dashboard.js
client/user-usage-dashboard.css
client/anthropic-mark.svg
scripts/test-usage-dashboard.js
scripts/test-production-aggregation.js
scripts/test-client-release.py
scripts/deploy.sh
scripts/run-remote-release.sh
scripts/verify-deployment.sh
scripts/deploy-auth-fix.sh
baseline/user.js
baseline/compose.override.yaml
PREFLIGHT.md
DEPLOY_RESULT.txt
LIVE_ACCEPTANCE.md
```

## Intended Services

Required runtime change:

```text
LibreChat-API
```

The active Client build is copied into a versioned release directory and mounted by the API
container. The release must not recreate MongoDB, CodeAPI, Office Converter, Nginx, RAG, or
Admin Panel.

## Source And Baseline

The verified active route and Compose baselines are archived under `baseline/`. Runtime hashes,
container identities, schema evidence, and capacity are recorded in `PREFLIGHT.md`.

Deployment aborts if the audited Compose, user route, or Client index hash has drifted.

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

Final release commit:

```text
34842d07cf973b231aa9d487f040676d2417a2d1
```

Only `LibreChat-API` was recreated. The final release root, backup path, hashes, container IDs,
authenticated API results, and browser evidence are recorded in `DEPLOY_RESULT.txt` and
`LIVE_ACCEPTANCE.md`.
