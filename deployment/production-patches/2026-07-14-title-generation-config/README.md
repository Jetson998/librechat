# Conversation Title Configuration Release

This release corrects the MuskAPI title endpoint and prompt configuration. It
does not modify LibreChat source, compiled frontend assets, Office handling,
CodeAPI, messages, or historical titles.

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
