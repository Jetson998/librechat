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
- Compatibility permission gate: `read:diagnostic_logs` or the existing
  `read:audit_log`, so the current production admin role does not lose access
  while the backend capability is being seeded.
- Follow-up: seed the dedicated `read:diagnostic_logs` capability in the
  backend and remove the temporary audit-log fallback.

## Page structure

1. Header: title, purpose, and refresh action.
2. Filter row: free-text search, level, stage, start date, end date, clear.
3. Summary strip: matching events, error events, latest event.
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
q, level, stage, from, to, conversationId, streamId, page, limit
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
      "userId": "6a61...80b",
      "conversationId": "...",
      "streamId": "...",
      "messageId": "...",
      "model": "claude-opus-5",
      "errorName": "SyntaxError",
      "errorMessage": "Unexpected non-whitespace character after JSON at position 33758",
      "durationMs": 4521,
      "release": "238c8ddd"
    }
  ],
  "total": 1,
  "nextCursor": null
}
```

The detail endpoint can be:

```text
GET /api/admin/diagnostic-events/:id
```

Use cursor pagination for large collections. The list endpoint should return
only safe metadata; a detail endpoint may add a redacted stack and a bounded
redacted tail sample when an operator has the diagnostic permission.

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

Use a separate `diagnostic_events` collection with a 7-30 day TTL. Recommended
indexes:

```text
{ conversationId: 1, timestamp: -1 }
{ streamId: 1 }
{ userIdHash: 1, timestamp: -1 }
{ event: 1, timestamp: -1 }
{ timestamp: 1 }  // TTL
```

Do not await diagnostic persistence in the model request path. Emit structured
stdout immediately and enqueue one bounded asynchronous persistence operation
for error/state-transition events.

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

- The Admin client now calls `GET /api/admin/diagnostic-events` with the
  documented search, level, stage, date, page, and limit filters.
- The client validates the response with a bounded safe-metadata schema; unknown
  fields such as prompts, file contents, authorization headers, and raw tool
  output are discarded before rendering.
- A `404` or `503` response is rendered as an explicit unavailable state, and a
  failed response never creates placeholder rows.
- The production API currently remains a separate backend task. Until it is
  implemented, `/logs` is expected to show the unavailable state.
