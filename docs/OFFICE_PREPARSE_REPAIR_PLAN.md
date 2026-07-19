# Office Pre-parse Repair Plan

Date: 2026-07-19

Status: approved for implementation; production unchanged.

## Diagnosis

The rolled-back pre-parse gate matched a current LibreChat attachment only by
the CodeAPI `file_id` and `storage_session_id` saved at upload time. CodeAPI
may re-upload a valid file when its session is stale, rotating both values.
The file is then present and usable, but the gate rejects it because the
current request still carries the old mutable reference. This explains the
observed `405` session probe followed by successful upload and the later empty
assistant response.

The same release also left a separate lifecycle gap: a resumable request can
be stopped or aborted before any persistable assistant content exists, after
the preliminary job event has been emitted. That path must not save a normal
empty assistant row.

## Repair Decision

Keep the existing LibreChat upload and CodeAPI pipeline. The replacement will:

1. Resolve current-turn Office files using a stable LibreChat `file_id` when
   the priming layer provides it.
2. Fall back to an exact unique sandbox filename match for legacy priming
   results, while rejecting ambiguous duplicates instead of guessing.
3. Use the fresh primed CodeAPI session and file ID for the actual parse.
4. Bound the pre-parse call to 45 seconds and propagate the request/job abort
   signal when one is available.
5. Add request-scoped diagnostic logs containing IDs and counts only, never
   file contents or prompts.
6. Preserve the existing semantic-empty response guard and early-abort result
   so no-content stops cannot become successful blank messages.

This is deliberately a narrow orchestration repair. It does not add another
converter, upload route, prompt retry, database migration, or WebAI route.

## Verification Before Production

Focused tests must cover stale-reference rotation, unique filename fallback,
ambiguous duplicate rejection, current-turn isolation, real manifest parsing,
timeout, abort, and early-abort non-persistence. Syntax checks and `git diff
--check` must pass before packaging.

Production deployment, if later approved, replaces only the API bundle and
BaseClient patch, restarts only `LibreChat-API`, and records timestamped
backups plus rollback evidence through the repository release scripts.

