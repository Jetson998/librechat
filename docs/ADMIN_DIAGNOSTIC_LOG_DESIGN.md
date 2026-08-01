# Admin diagnostic logs

## Scope

Add a top-level **诊断日志 / Diagnostic logs** page to the standalone Admin
Panel. This page is for runtime troubleshooting of chat, file, model, and
follow-up failures. It is separate from the existing **授权 > 审计日志** page,
which records capability grants and revocations.

The first UI slice adds the navigation entry, route, permission gate, filter
layout, summary strip, result table, and privacy boundary. It intentionally
does not invent rows while the backend diagnostic-event endpoint is absent.

## Navigation and access

- Route: `/logs`
- Menu label: `诊断日志`
- Icon: existing `document` icon
- Permission gate: `read:diagnostic_logs`. The Admin BFF and backend route
  require the same capability; there is no `read:audit_log` fallback that can
  expose a menu followed by a backend `403`.

## Page structure

1. Header: title, purpose, and refresh action.
2. Filter row: exact correlation/stable-code lookup, level, stage, start date,
   end date, clear. There is no broad error-text or regex search.
3. Summary strip: current-page events, current-page errors, latest event.
4. Dense result table: level, event, stage, context, timestamp.
5. Detail drawer: full diagnostic metadata and request timeline after the API
   is available.

The page uses the current Admin Panel's restrained table/filter layout. It does
not show full prompts, uploaded file content, authorization headers, or raw
tool output.

## Backend contract

Recommended endpoint:

```text
GET /api/admin/diagnostic-events
```

Query parameters:

```text
lookup, level, stage, from, to, conversationId, streamId, cursor, limit
```

Response shape:

```json
{
  "entries": [
    {
      "id": "...",
      "timestamp": "2026-07-31T08:14:43.655Z",
      "level": "error",
      "event": "office_preparse_manifest_invalid",
      "stage": "office_preparse",
      "userIdHash": "6a61...80b",
      "conversationId": "...",
      "streamId": "...",
      "messageId": "...",
      "model": "claude-opus-5",
      "errorCode": "OFFICE_PREPARSE_INVALID_MANIFEST",
      "errorName": "SyntaxError",
      "errorMessage": "Unexpected non-whitespace character after JSON at position 33758",
      "durationMs": 4521,
      "release": "238c8ddd"
    }
  ],
  "nextCursor": null
}
```

The detail endpoint can be:

```text
GET /api/admin/diagnostic-events/:id
```

Use cursor pagination for large collections. Each page performs one indexed
read (`limit + 1`) and does not run `countDocuments` or a full aggregate. The
list endpoint explicitly excludes `stack`, raw `userId`, prompts, file
contents, credentials, and raw tool output. The detail endpoint may add an
already-redacted stack when an operator has the diagnostic permission.

## Event taxonomy

The initial events should cover the current incident path:

```text
request_received
files_primed
office_preparse_started
office_preparse_tool_result_received
office_preparse_manifest_invalid
generation_initialization_failed
generation_completed
followup_rejected_parent_saving
```

Each event should carry the same correlation fields: `requestId`,
`conversationId`, `streamId`, `messageId`, `userIdHash`, `model`, and `release`.

## Storage and indexes

Use a separate `diagnostic_events` collection with a 14-day TTL. Every query
is constrained to its authenticated tenant (or the legacy unscoped partition,
never all tenants). The actual indexes pair the tenant and cursor sort keys:

```text
{ tenantId: 1, timestamp: -1, _id: -1 }
{ tenantId: 1, level: 1, timestamp: -1, _id: -1 }
{ tenantId: 1, stage: 1, timestamp: -1, _id: -1 }
{ tenantId: 1, conversationId: 1, timestamp: -1, _id: -1 }
{ tenantId: 1, streamId: 1, timestamp: -1, _id: -1 }
{ tenantId: 1, requestId: 1, timestamp: -1, _id: -1 }
{ tenantId: 1, messageId: 1, timestamp: -1, _id: -1 }
{ tenantId: 1, event: 1, timestamp: -1, _id: -1 }
{ tenantId: 1, errorCode: 1, timestamp: -1, _id: -1 }
{ expiresAt: 1 }  // TTL
```

Do not await diagnostic persistence in the model request path. Emit structured
stdout immediately, then enqueue a bounded asynchronous persistence operation
for error/state-transition events. At most 256 events may be outstanding and
at most four `Model.create()` calls run concurrently; overflow remains in
structured stdout only.

## Acceptance

- Admins with the diagnostic permission can open `/logs` and filter by time,
  stage, level, conversation, and request.
- Rows link to a detail drawer and reconstruct one request timeline.
- A missing or unavailable diagnostic backend produces an explicit unavailable
  state, never fake rows.
- Normal conversation success does not create a synchronous database write.
- Logs exclude message bodies, document previews, credentials, and raw tool
  output.

## Current implementation status

- The Admin client now calls `GET /api/admin/diagnostic-events` with exact
  lookup, level, stage, date, cursor, and limit filters.
- The client validates the response with a bounded safe-metadata schema; unknown
  fields such as prompts, file contents, authorization headers, and raw tool
  output are discarded before rendering.
- A `404` or `503` response is rendered as an explicit unavailable state, and a
  failed response never creates placeholder rows.
- The API stores only error/state-transition events through a bounded
  asynchronous queue, with a 14-day TTL, JSON-aware credential redaction,
  tenant scoping, and cursor-compatible correlation indexes.
- Office pre-parse errors carry stable diagnostic codes, including
  `OFFICE_PREPARSE_INVALID_MANIFEST`, so classification does not depend only
  on localized error text.
- The Admin client uses cursor pagination and opens a detail drawer that
  fetches the redacted stack separately from the list.
- The production API and persisted rows are not part of the existing Admin
  Panel release; deployment remains a separate approval and release task.
