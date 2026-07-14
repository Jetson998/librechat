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

Pending repository gate, production deployment, and a real LibreChat
conversation-path verification.
