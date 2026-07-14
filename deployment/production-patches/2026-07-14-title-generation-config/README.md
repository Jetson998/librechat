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

Deployed on 2026-07-14 after implementation commit `e267d84` and
self-contained release commit `b6d8625` were pushed to `origin/main`.

```text
timestamp=20260714134018
backup_id=title-config-20260714134018
configVersion=23 -> 24
titleEndpoint=MuskAPI
titleModel=gpt-5.6-sol
```

The remote release test and preflight passed before the write. The API restart
passed `/api/config` readiness and Mongo runtime assertions. A synthetic title
probe through the configured relay returned:

```text
title_probe=ok model=gpt-5.6-sol title=主流模型性能对比
```

No conversation row was created by the probe. Existing historical titles were
not rewritten.
