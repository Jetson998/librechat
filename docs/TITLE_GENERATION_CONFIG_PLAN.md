# Conversation Title Configuration Fix

Date: 2026-07-14

Status: deployed and server-side verified.

## Objective

Generate a concise title from the first user message through the existing
MuskAPI custom endpoint. Keep normal chat, model selection, Office handling,
CodeAPI, and historical conversation titles unchanged.

## Confirmed Cause

Production configuration version 23 has both `titleEndpoint` and `titleModel`
set to `gpt-5.6-sol`. These fields have different meanings:

- `titleEndpoint` is the configured endpoint name and must be `MuskAPI`.
- `titleModel` is the provider model slug and must be `gpt-5.6-sol`.

LibreChat logs confirm it tried to resolve `gpt-5.6-sol` as a provider and
reported `Provider gpt-5.6-sol not supported`. It then fell back and generated
the generic title `生成简洁会话标题` instead of summarizing the first user
message.

## Chosen Configuration

```yaml
titleConvo: true
titleEndpoint: MuskAPI
titleModel: gpt-5.6-sol
titleMessageRole: user
titlePrompt: >-
  根据用户的首条消息生成简洁、准确的会话标题。只输出标题本身，不要解释，
  不要提问，不要使用引号，不要添加“标题：”等前缀。标题应概括核心主题，
  中文最多20个汉字；如果原内容不是中文，则使用原内容对应的语言。
```

Leave `titlePromptTemplate` unset so LibreChat injects the first message using
its supported default title prompt construction.

## Release Gate

1. Commit the baseline, regression test, and rollback-capable runner.
2. Push `origin/main` before changing production.
3. Back up the complete active `role/__base__` config document.
4. Update only the MuskAPI title fields and increment `configVersion`.
5. Restart only `LibreChat-API` and verify `/api/config` readiness.
6. Create a new conversation and confirm a topic-specific title is persisted.
7. Record the deployment and verification in the repository.

## Deployment Record

Implementation commit `e267d84` and release packaging commit `b6d8625` were
pushed before production deployment.

```text
timestamp=20260714134018
backup_id=title-config-20260714134018
configVersion=23 -> 24
```

The committed release test, remote preflight, Mongo backup, API restart,
`/api/config` readiness, and runtime field assertions passed. A synthetic
MuskAPI probe generated `主流模型性能对比` from the sample first message
`50个字返回不同主流模型性能`, confirming that the model returns a topical
title instead of repeating or responding to the title instruction.
