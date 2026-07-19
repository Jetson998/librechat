# Office Pre-parse Final Repair Plan

Date: 2026-07-20

Status: approved for implementation; production unchanged.

## Confirmed Root Causes

The Office upload and CodeAPI sandbox are healthy. Two request-normalization
contracts are missing:

1. `api/server/services/Files/Code/process.js::primeFiles()` rotates the
   CodeAPI session and file IDs after a stale reference, but its returned file
   objects do not carry the stable LibreChat `file_id`. A downstream consumer
   therefore cannot deterministically correlate a fresh CodeAPI reference with
   the original database file.
2. A regeneration request does not resend `req.body.files`. The attachment on
   the regenerated parent user message is loaded as historical tool context,
   while `currentRequestFiles` remains empty. Current-turn Office pre-parse is
   therefore bypassed and no CodeAPI `/exec` occurs.

The current resumable controller already catches `initializeClient()` errors,
emits an error event, completes the GenerationJob, and the existing abort guard
prevents an empty assistant row. A general provider first-token watchdog is not
part of this Office repair because maximum-reasoning models may legitimately
take longer and the previous acceptance did not prove that controller contract
is broken.

## Minimal Repair

### Stable priming identity

Every user/file-backed object returned by `primeFiles()` must include:

```text
source_file_id: <LibreChat db.files.file_id>
```

This field is metadata for LibreChat orchestration only. CodeAPI continues to
receive its fresh `id`, `storage_session_id`, `name`, `kind`, and
`resource_id` values unchanged.

The Office selector must require `source_file_id === current file.file_id`.
Mutable CodeAPI IDs and filenames must not be the primary association. Exact
legacy CodeAPI references may remain as a compatibility path only while the
source and deployed producer are upgraded together; filename guessing is
removed.

### Regeneration-aware current files

When `isRegenerate === true` and `req.body.files` is empty:

1. Resolve the message identified by `parentMessageId` within the current
   conversation and authenticated user scope.
2. Collect only that user message's `files[].file_id` values.
3. Resolve those database files through the existing ownership-scoped file
   queries.
4. Merge them into `currentRequestFiles` for priming and Office pre-parse.

Do not classify every historical thread file as current. Generated assistant
attachments and files from earlier user turns remain available through normal
tool history, but are not automatically pre-parsed.

### Bounded pre-parse

Keep the deterministic Office parser on the existing CodeAPI bash transport:

- 45 second timeout;
- request/job abort propagation when available;
- filename-specific visible failure;
- no model request after pre-parse failure;
- no successful blank assistant row.

The resumable controller already owns the authoritative GenerationJob abort
signal, but `initializeAgent()` currently cannot see it. During
`initializeClient()` only, expose that existing signal on the request as a
request-scoped field, consume it in Office pre-parse, and remove it in a
`finally` block. This is signal propagation, not a new timeout or provider
watchdog.

## Files

The implementation release will carry exact production-baseline copies of:

- `/app/api/server/services/Files/Code/process.js`;
- `/app/packages/api/dist/index.cjs`;
- `/app/api/server/controllers/agents/request.js`;
- focused tests and governed deployment scripts.

`BaseClient.js`, the upload menu, CodeAPI source, Mongo data, Nginx, Admin
Panel, generated-file callbacks, and WebAI are out of scope.

## Required Tests

1. Active cached reference preserves `source_file_id`.
2. `405 -> re-upload -> fresh reference` preserves `source_file_id`.
3. Two same-named files remain distinguishable by LibreChat `file_id`.
4. A fresh upload is selected as current-turn Office input.
5. Regeneration restores only the parent user message's files.
6. Earlier thread files are not automatically pre-parsed.
7. Pre-parse timeout and abort return visible errors before model execution.
8. Stop before content persists no assistant row.

## Acceptance

Use `vip998` and at most one billable request per release attempt.

- Fresh-upload acceptance and regeneration acceptance are separate contracts;
  one must not substitute for the other.
- If browser automation cannot set a file chooser, the user performs the fresh
  upload manually and provides the conversation URL; diagnosis then uses
  request logs, CodeAPI `/exec`, Mongo message metadata, and the visible result.
