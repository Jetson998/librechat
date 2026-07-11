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

Pending.
