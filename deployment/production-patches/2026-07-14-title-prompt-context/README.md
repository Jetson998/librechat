# Conversation Title Context Release

This release adds LibreChat's required `{convo}` placeholder to the custom
MuskAPI title prompt. Without it, `createCompletionTitleRunnable` sends only
the title instruction to the model and omits the first user message, producing
generic titles such as `生成简洁会话标题`.

It does not modify LibreChat source, compiled frontend assets, Office handling,
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

Deployed after implementation commit `86ad3a0` was pushed to `origin/main`.

```text
timestamp=20260714150105
backup_id=title-config-20260714150105
configVersion=24 -> 25
titleEndpoint=MuskAPI
titleModel=gpt-5.6-sol
```

The remote release test, preflight, API restart, `/api/config` readiness, and
runtime Mongo assertions passed. A real signed-in LibreChat conversation used
the first message `验证标题上下文：比较主流AI模型在代码、长文本和多模态方面的优势`.
The sidebar updated to `主流AI模型多维能力对比`, and Mongo persisted the same
title on conversation `064d9483-c03d-48e1-971e-2392d24c6784`.

Existing historical titles were not rewritten.
