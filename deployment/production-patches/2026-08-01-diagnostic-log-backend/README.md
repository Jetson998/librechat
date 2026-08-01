# Diagnostic log development batch

Status: remediated development candidate awaiting a second Sol review. This
batch has not been packaged, preflighted, deployed, restarted, or accepted
against production.

This directory is an independent, versioned development artifact for the
runtime diagnostic-log work. It deliberately does not modify the previously
deployed Office or Admin release directories in place.

## Scope

- Backend: a bounded asynchronous `diagnostic_events` collection with a
  14-day TTL, tenant-scoped correlation indexes, HMAC user identifiers,
  JSON-aware credential redaction, at most four concurrent writes, and
  one-read cursor pages with Admin-only list/detail routes.
- Agent path: records initialization failures, generation failures,
  follow-up `409` parent-saving rejections, and stable Office pre-parse error
  classifications without storing prompts, file bodies, credentials, or raw
  tool output.
- Office path: adds stable error codes to the existing pre-parse patch through
  minimal unified diffs.
- Admin Panel: adds exact lookup cursor pagination and a redacted detail
  drawer on top of the already released diagnostic-log menu/client contract.

## Immutable bases

- Backend local base: `e3496b4bd3e77849d8aa1ce87378432681f95ad3`, corresponding upstream LibreChat commit
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`.
- Production mounted Agent base: the 2026-07-31 `request.js` and
  `InitializationFailure.js` files, replayed before this overlay so the
  terminal-failure persistence and `officePreparseSignal` cannot be removed.
- Admin/governance baseline: `9cf6ae6a461f68de487a9dd3ca26672eef7e1d5a`.
- The exact per-file Git blob SHA-1, SHA-256, byte count, and patch result are
  recorded in `SOURCE_MANIFEST.json`.

## Replay verification

Use a clean backend checkout at the recorded backend base, the baseline Admin
Panel `source/` directory, and this governance repository:

```sh
python3 deployment/production-patches/2026-08-01-diagnostic-log-backend/scripts/verify-overlay.py \
  --backend-source /path/to/clean-backend \
  --admin-source deployment/production-patches/2026-07-11-admin-panel-zh-cn/source \
  --governance-repo .
```

The verifier archives the clean backend and governance baselines, stages the
2026-07-31 production Agent mounts, applies this overlay and the Office diff,
then checks every base/result blob and SHA-256 value. It does not alter its
input trees or the repository worktree.

## Focused checks

Run the dependency-free focused checks:

```sh
node deployment/production-patches/2026-08-01-diagnostic-log-backend/scripts/test-diagnostic-events.js
node deployment/production-patches/2026-08-01-diagnostic-log-backend/scripts/test-composed-overlay.js
```

`scripts/test-composed-overlay.js` verifies the 2026-07-31 mounted Agent
contract, the current diagnostic overlay, and the patched Office error codes in
one temporary composition. The remaining Backend Jest and Admin Vitest,
typecheck, and build gates are run only from the pinned source trees; no
dependency installation or network-based bootstrap is performed by this batch.

## Release boundary

This is not a release record and contains no package, image, preflight,
deployment, restart, backup, or production acceptance evidence. Any later
deployment must be a separately approved release built from a reviewed commit
and the exact replayed artifacts.
