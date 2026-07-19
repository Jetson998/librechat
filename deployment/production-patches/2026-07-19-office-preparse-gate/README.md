# Office Pre-parse Gate

Date: 2026-07-19

This release closes the gap between a successful Office upload and model tool
selection. Current-turn Office attachments are deterministically parsed through
the existing CodeAPI bash transport before model execution. The bounded
manifest is appended to the current agent context; the original files remain
available in `/mnt/data` for complete analysis and modification.

The implementation remains in the canonical production patch:

- `../2026-07-10-office-ppt-deterministic-fallback/office-context-patch/api-index.cjs`
- `../2026-07-10-office-ppt-deterministic-fallback/office-context-patch/BaseClient.js`

No upload route, converter service, CodeAPI source, generated-file callback,
Admin Panel component, or database record is changed.

## Test

```sh
node deployment/production-patches/2026-07-19-office-preparse-gate/scripts/test-office-preparse-gate.js
node deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/scripts/test-empty-response-regeneration.js
```

## Deployment

Production deployment is blocked until the implementation commit is pushed and
the repository release-governance preflight has produced an exact-revision
artifact. Only `LibreChat-API` may be recreated for this change.

## Rollback

Restore timestamp-matched copies of `api-index.cjs` and `BaseClient.js`, then
recreate only `LibreChat-API`. Recheck normal chat, Office upload, CodeAPI
health, generated download cards, and `/office/` protection.
