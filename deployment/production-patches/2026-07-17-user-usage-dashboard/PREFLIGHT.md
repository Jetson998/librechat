# Production Preflight

Audit time: 2026-07-18 00:02-00:08 Asia/Singapore

The audit was read-only. No container was restarted and no database document was modified.

## Runtime

```text
LibreChat-API 0570b11e1fbe registry.librechat.ai/danny-avila/librechat-dev-api:latest
LibreChat-NGINX 1a5c01b19b73 nginx:1.27.0-alpine
LibreChat-CodeAPI ddba629a7b63 local/librechat-codeapi:office
LibreChat-RAG-API d16e85e1e103 registry.librechat.ai/danny-avila/librechat-rag-api-dev-lite:latest
chat-mongodb 01d5bc03e9cb mongo:8.0.20
LibreChat-Admin-Panel bd888ea33f65 librechat-admin-panel-user-ui:e6a103c4218b
```

The Client build is mounted into the API container from:

```text
/opt/librechat/ui-label-patch/client-dist -> /app/client/dist
```

API route ownership is `/app/api/server/routes/user.js`, mounted by the application at
`/api/user`. The exact active route baseline is archived under `baseline/user.js`.

## Capacity

```text
MemAvailable: 1690 MB
SwapTotal: 4095 MB
SwapFree: 3100 MB
```

## Data Contract Evidence

```text
messages: 331 documents
transactions: 1138 documents
conversations: 34 documents
error-free assistant messages: 168
meaningful successful assistant messages: 144
empty assistant rows excluded from billing logs: 24
distinct transaction messageIds: 249
```

All 1,138 transaction rows have `user`, `conversationId`, `messageId`, and `model`.
Message and conversation `user` fields are strings. Transaction `user` fields are ObjectIds.

A successful dashboard row must also contain visible text, structured `content`, a file, or an
attachment. An error-free flag alone is insufficient because 24 historical empty assistant rows
remain from earlier empty-response incidents.

Transaction contexts:

```text
message: 1044 rows (522 prompt + 522 completion)
title: 88 rows
summarization: 6 rows
```

The dashboard must therefore join successful assistant messages to transactions by
authenticated user plus `messageId`, and include only `context=message`. This includes
Agent-internal calls persisted under the reply message while excluding title and summary cost.

Message `metadata.usage` contains `input`, `output`, `cacheRead`, and `cacheWrite` for 156
messages. It is a token fallback only; transaction `rawAmount` and `tokenValue` remain the
authoritative source when transaction rows exist.

## Active Hashes

```text
compose.override.yaml d173b65bf3a2b2d619961247c97b8f00731dfc1399db2fea3a61799dc3505d7f
client index.html 15a4e35d4e01085c8510f6b42f146607e17318e6e239854023cd9d0ed2d18d01
client main JS 702558177bdaea89cef1eb51f0322ba22267ed0d7133813257445c05c77c24bf
AccountSettings JS f6730dcb032662ac1821b9aa50f343a3020590dbc76232bd1bf842544b46cb37
client CSS 56e8c36600c6cddb90c4df152a62f4735de222f60aa913d452eb39789815ce22
business-upload-menu.js a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9
odysseia-login.js aeb91c87012ee37a7c94635f3673f9c4747c39245f2c0242eae4d6a79e860f27
user.js 9c1ffa04c10c78af2088cfda0f201670bc4024c59f7b7fdb9b2021b102a9ccb5
api index.cjs 2cc88bec7011b3d063f5528171d98835ab295e4fefc679bd2e4963fa5e66ee20
data-schemas index.cjs fdae826349dda6123ef14265c90536dc26f1761ac84aaad609b10e8efba19f91
librechat.yaml f67ddcfdd45df03ad3f2cbab0c2cd5f3fcb24bfb08627a09f7483113e5cd1e10
```

Indexes already exist on user, conversation, message, and created-at fields. This release does
not add a database index or mutate Mongo data.

## Read-only Aggregation Acceptance

The committed aggregation module was executed against the active MongoDB from a temporary API
container path without mounting routes or restarting services:

```json
{"aggregation":"ok","summaryTurns":130,"conversationInstances":27,"trendBuckets":9,"modelBuckets":4,"returnedLogs":5,"totalLogs":130,"costIncomplete":false}
```

This also caught and corrected MongoDB 8's requirement that `$documentNumber` use exactly one
top-level `sortBy` field before the release was committed.
