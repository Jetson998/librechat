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
5. Detail drawer: one failure event's safe diagnostic metadata and correlation
   IDs after the API is available. It does not reconstruct a request timeline.

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
      "errorSummary": "Office pre-parse manifest is invalid.",
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
list endpoint explicitly excludes raw `userId`, prompts, file contents,
credentials, filenames, raw error text, stacks, and raw tool output. The detail
endpoint returns the same safe metadata as the list response and never adds a
raw or redacted stack.

## Event taxonomy

The initial failure-event index covers the current incident path:

```text
office_preparse_manifest_invalid
office_preparse_manifest_missing
office_preparse_manifest_incomplete
office_preparse_file_failed
office_preparse_timeout
office_preparse_aborted
office_preparse_file_reference_missing
office_preparse_file_reference_ambiguous
office_preparse_tool_failed
generation_initialization_failed
generation_failed
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

Do not await diagnostic persistence in the model request path. Emit only the
allowlisted event and correlation metadata to structured stdout, then enqueue a
bounded asynchronous persistence operation for failure/state-transition events.
At most 256 events may be outstanding and at most four `Model.create()` calls
run concurrently. Overflow remains in structured stdout only, with one
rate-limited aggregate warning and a dropped-event counter; it does not emit one
warning per dropped event.

## Acceptance

- Admins with the diagnostic permission can open `/logs` and filter by time,
  stage, level, conversation, and request.
- Rows link to a detail drawer for one event and its correlation IDs; no
  success-event timeline is recorded or reconstructed.
- A missing or unavailable diagnostic backend produces an explicit unavailable
  state, never fake rows.
- Normal conversation success does not create a synchronous database write.
- Logs exclude message bodies, document previews, credentials, filenames, raw
  error text, stacks, and raw tool output. The backend uses a fixed event
  allowlist and static summaries; it does not attempt to make arbitrary Error
  objects safe with regular-expression redaction.

## Current implementation status

- The Admin client now calls `GET /api/admin/diagnostic-events` with exact
  lookup, level, stage, date, cursor, and limit filters.
- The client validates the response with a bounded safe-metadata schema; unknown
  fields such as prompts, file contents, authorization headers, and raw tool
  output are discarded before rendering.
- A `404` or `503` response is rendered as an explicit unavailable state, and a
  failed response never creates placeholder rows.
- The API stores only allowlisted failure/state-transition events through a
  bounded asynchronous queue, with a 14-day TTL, tenant scoping, cursor-
  compatible correlation indexes, a four-worker write limit, and rate-limited
  overflow accounting.
- Office pre-parse errors carry stable diagnostic codes for invalid, missing,
  incomplete, failed, timeout, abort, and stable-reference paths. Error text
  from the parser and tool is not copied into the thrown diagnostic message.
- The Admin client uses cursor pagination and opens a detail drawer for the
  single safe event record; there is no raw stack endpoint.
- The production API and persisted rows are not part of the existing Admin
  Panel release; deployment remains a separate approval and release task.
