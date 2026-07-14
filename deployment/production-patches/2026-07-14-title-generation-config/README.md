# Conversation Title Configuration Release

This release corrects the MuskAPI title endpoint and prompt configuration. It
does not modify LibreChat source, compiled frontend assets, Office handling,
CodeAPI, messages, or historical titles.

`title-config.yaml` is the self-contained release contract used by the remote
test; the same values are tracked in the repository baseline.

## Test

```bash
python3 scripts/test-title-config-release.py
```

## Deploy

```bash
PREFLIGHT_ONLY=true scripts/deploy-title-config.sh
scripts/deploy-title-config.sh
```

The runner stores the complete original config in `codexConfigBackups` and
restores it automatically if restart or runtime verification fails.

## Production Result

Pending.
