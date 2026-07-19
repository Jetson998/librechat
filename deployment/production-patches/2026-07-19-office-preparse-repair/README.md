# Office Pre-parse Repair

Date: 2026-07-19

This patch replaces the rolled-back Office pre-parse gate. It keeps the
existing upload and CodeAPI pipeline, but resolves current-turn attachments
against fresh priming results after CodeAPI session rotation.

## Behavior

- Prefer a stable `source_file_id` matching the LibreChat `file_id`.
- Preserve direct matching for still-active CodeAPI references.
- Support legacy priming results only when the exact sandbox filename is
  unique; reject ambiguous duplicates.
- Parse using the fresh primed CodeAPI session and file IDs.
- Stop after 45 seconds and propagate a request abort signal.
- Keep semantic-empty and early-abort guards from the current production
  baseline.

No converter, upload route, CodeAPI service, prompt retry, Admin Panel page, or
database record is added.

## Test

```sh
node deployment/production-patches/2026-07-19-office-preparse-repair/scripts/test-office-preparse-repair.js
node deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/scripts/test-empty-response-regeneration.js
node --check deployment/production-patches/2026-07-19-office-preparse-repair/office-context-patch/BaseClient.js
node --check deployment/production-patches/2026-07-19-office-preparse-repair/office-context-patch/api-index.cjs
```

## Deployment

Production deployment must use the repository release-governance scripts and
an exact pushed source revision. The deploy runner replaces only
`BaseClient.js` and `api-index.cjs`, then restarts only `LibreChat-API`.

## Rollback

Restore the timestamp-matched backups created by `remote-apply.sh`, restart
only `LibreChat-API`, and recheck `/`, `/api/config`, `/office/`, CodeAPI
health, normal chat, Office reading, and generated download cards.
