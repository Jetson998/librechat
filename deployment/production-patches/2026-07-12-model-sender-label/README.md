# GPT-5.6-SOL Message Sender Label

Date: 2026-07-12

This release adds the supported `preset.modelLabel` field to the active
`gpt-5.6-sol` model spec. It does not modify LibreChat source, frontend
bundles, Office handling, CodeAPI, files, or historical messages.

Design and evidence are recorded in
`docs/MODEL_SENDER_LABEL_PLAN.md`.

## Test

```bash
python3 scripts/test-model-sender-label-release.py
```

## Deployment

Stage this directory on the production host, then run:

```bash
PREFLIGHT_ONLY=true scripts/deploy-model-sender-label.sh
scripts/deploy-model-sender-label.sh
```

The runner requires exactly one active `__base__` role override and exactly
one `gpt-5.6-sol` model spec. Before changing it, the runner stores the full
Mongo document in `codexConfigBackups`. A failed restart or runtime assertion
restores that document and restarts the API.

## Production Result

Deployed on 2026-07-12 from implementation commit `35cc853`, after that
commit was pushed to `origin/main`.

```text
timestamp=20260712011327
backup_id=sender-label-20260712011327
configVersion=8 -> 9
model_label=GPT-5.6-SOL
```

The committed release test and production preflight passed before the write.
The runner then stored the original active base override in
`codexConfigBackups`, updated `preset.modelLabel` and the endpoint fallback,
restarted `LibreChat-API`, waited through the expected startup 502 window, and
passed both `/api/config` readiness and Mongo runtime assertions.

The existing Chrome LibreChat tab was signed out after the API restart, so the
authenticated check was completed after login. The user confirmed the final
new-conversation test passed on 2026-07-12. No historical message rows were
changed.
