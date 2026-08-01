# Diagnostic log development batch

Status: development complete for external review. This batch has not been
packaged, preflighted, deployed, restarted, or accepted against production.

This directory is an independent, versioned development artifact for the
runtime diagnostic-log work. It deliberately does not modify the previously
deployed Office or Admin release directories in place.

## Scope

- Backend: a bounded asynchronous `diagnostic_events` collection with a
  14-day TTL, correlation indexes, HMAC user identifiers, redacted stacks and
  error text, cursor pagination, and Admin-only list/detail routes.
- Agent path: records initialization failures, generation failures,
  follow-up `409` parent-saving rejections, and stable Office pre-parse error
  classifications without storing prompts, file bodies, credentials, or raw
  tool output.
- Office path: adds stable error codes to the existing pre-parse patch through
  minimal unified diffs.
- Admin Panel: adds cursor pagination and a redacted detail drawer on top of
  the already released diagnostic-log menu/client contract.

## Immutable bases

- Backend local base: `e3496b4bd3e77849d8aa1ce87378432681f95ad3`, corresponding upstream LibreChat commit
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`.
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

The verifier copies overlays into temporary replay trees, checks base blobs,
applies the Office diffs to an archived clean governance baseline, and checks
all result blobs and SHA-256 values. It does not alter its input trees or the
repository worktree.

## Focused checks

Previously completed before this development batch: Office pre-parse contract
tests and backend syntax checks. The current environment lacks the complete
Jest/Vitest dependency sets for the isolated backend/Admin trees, so those
test commands remain an explicit Sol-review item; no dependency installation
or network-based test bootstrap was performed.

## Release boundary

This is not a release record and contains no package, image, preflight,
deployment, restart, backup, or production acceptance evidence. Any later
deployment must be a separately approved release built from a reviewed commit
and the exact replayed artifacts.
