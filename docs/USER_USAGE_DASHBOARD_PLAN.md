# User Price And Usage Dashboard

Date: 2026-07-17

Status: implemented; native-style UI refinement prepared for release.

## UI Refinement Gate (2026-07-18)

The customer-facing surface follows the existing LibreChat `设置` and `我的文件`
patterns:

- use a left vertical navigation for `用量概览` and `对话日志`;
- keep `近 7 天` / `近 30 天` / `全部` as a separate range control;
- use the existing file-list table language for header background, row height,
  typography, borders, and pagination;
- keep overview content within the available height without a page-level
  scrollbar;
- give the log table its own scroll region with a sticky header and fixed footer;
- allow searchable filters to close by toggle, outside click, or `Escape`.

## Objective

Add a lightweight customer-facing dashboard under:

```text
My -> Price and usage statistics
我的 -> 价格用量统计
```

The page must show only the authenticated user's data. It must not expose
prompt text, response text, uploaded file names, API keys, provider credentials,
or another user's conversations.

## Approved UX Contract

Date ranges:

```text
Last 7 days / Last 30 days / All
近 7 天 / 近 30 天 / 全部
```

Metric groups:

```text
消耗统计
- Token 消耗: 对话请求的 Token 数
- 费用消耗: 对话请求 Token 的费用

对话统计
- 对话实例数: 产生的对话窗口数
- 对话轮次: 产生回复的对话轮次

对话复杂度
- 平均上下文: 对话 Token / 对话实例数
- 平均对话轮次: 对话轮次 / 对话实例数
```

Trend tabs, in order:

```text
Token 消耗 / 对话实例数 / 平均上下文 / 费用消耗
```

Conversation log contract:

```text
时间 / 模型 / 对话实例 / 轮次 / Token 消耗 / 费用消耗
```

- one row represents one successful assistant reply;
- only successful reply rows are shown;
- model cells show provider logo plus model name, without provider text;
- conversation titles are searchable and open the original conversation;
- model and conversation filters are searchable;
- the selected date range filters cards, trends, and logs together;
- raw conversation IDs remain hidden from the normal UI.

The approved standalone prototype is:

```text
docs/demos/user-usage-dashboard-demo.html
```

## Data Contract

The backend is authoritative. The browser must not calculate pricing from a
model-name table.

Preferred source order, subject to read-only production verification:

1. persisted assistant-message usage rollup (`metadata.usage`) when present;
2. existing transaction rows grouped by `user`, `conversationId`, and
   `messageId` for exact token and cost repair;
3. persisted assistant `promptTokens` plus `tokenCount` only as a token fallback
   when authoritative usage is unavailable.

One log row must aggregate the complete usage scope associated with the reply,
including Agent-internal model calls when LibreChat persisted them under the
same reply usage/transaction identity.

Cost rules:

- reuse LibreChat's authoritative token-value calculation;
- `tokenValue` is treated according to the active LibreChat contract, currently
  documented in the active bundle as USD multiplied by 1,000,000;
- currency conversion, if the UI displays CNY, must happen once on the server
  through an explicit production setting;
- do not label USD values with the CNY symbol;
- historical rows without authoritative cost must return `null`, not fabricated
  zero cost.

## Proposed API

Use one authenticated read endpoint to keep the client and server surface small:

```text
GET /api/user/usage-dashboard
```

Query parameters:

```text
range=7|30|all
model=<optional exact or normalized model filter>
conversation=<optional conversation id>
page=<positive integer>
limit=<bounded integer, default 20, maximum 100>
```

Response shape:

```json
{
  "currency": "CNY",
  "summary": {
    "tokens": 0,
    "cost": 0,
    "conversationInstances": 0,
    "conversationTurns": 0,
    "averageContext": 0,
    "averageTurns": 0
  },
  "trends": [],
  "models": [],
  "conversationOptions": [],
  "logs": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 0
  }
}
```

The route must derive the user identity only from the authenticated request. It
must not accept an arbitrary user ID from the browser.

## Production Preflight

Before implementation, perform a read-only audit and record:

- active API and Client image/container IDs;
- active main Client source/build path;
- current `My` menu component and routing pattern;
- active user-route mount point;
- active Message and Transaction schema fields and indexes;
- sample field presence/counts without exporting message text or user data;
- whether `metadata.usage.cost` is currently persisted;
- whether transactions are enabled and queryable;
- the active currency/pricing unit;
- available memory and swap before any Client build.

If the active production source differs from repository snapshots, archive the
exact active baseline in this release directory before editing it.

## Implementation Boundaries

- Work only on LibreChat.
- Do not modify Office Converter, CodeAPI, RAG, Mongo data, or unrelated model
  configuration as part of feature implementation.
- Do not add Grafana, ClickHouse, Redis analytics, or a new always-on service.
- Do not log prompt/response bodies in the dashboard path.
- Keep aggregation bounded by date, authenticated user, pagination, and existing
  or release-added indexes.
- Preserve current upload, file-card, model-selection, title, web-search, and
  Admin Panel customizations.

## Verification

Local:

- static prototype script check;
- API aggregation tests covering user isolation, range filters, missing cost,
  Agent usage aggregation, pagination, and searchable filters;
- frontend tests for menu entry, loading, empty, error, filtering, and pagination;
- production bundle syntax/build checks;
- `git diff --check` and secret scan.

Production:

1. back up every replaced or mounted file;
2. deploy only the services required by the active implementation;
3. verify root and `/api/config` remain healthy;
4. log in as two normal users;
5. confirm each user sees only their own totals and logs;
6. create a fresh simple conversation and verify the dashboard increments;
7. confirm the conversation link opens the original conversation;
8. confirm 7/30/all synchronously update cards, trends, and logs;
9. confirm Office, CodeAPI, Mongo, Nginx, and Admin Panel container identities
   remain unchanged unless explicitly required and documented;
10. record deployed hashes, backups, container IDs, and browser evidence.

## Rollback

Restore the timestamp-matched API/Client files or images and the previous
Compose override, then recreate only the services changed by this release.
Verify login, simple chat, `/api/config`, upload labels, and `/office/` boundary
after rollback.

## Release Gate

1. Commit and push this design and prototype before production writes.
2. Complete the read-only production audit.
3. Implement and test against the active production baseline.
4. Commit and push the complete release before deployment.
5. Deploy with committed scripts and backups only.
6. Complete browser-visible user-isolation acceptance.
7. Record and push the deployment result.
