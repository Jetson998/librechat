# Model Sender Label Fix Plan

Date: 2026-07-12

Status: approved for implementation; production deployment pending.

## Objective

Make new `gpt-5.6-sol` assistant messages display and persist the exact sender
label `GPT-5.6-SOL`, while leaving the real endpoint, model slug, model
selection label, icon, reasoning settings, Office pipeline, and historical
messages unchanged.

## Confirmed Cause

Production conversation `ee169cd9-2441-4387-a24d-2c22cb4151f1` stores the
correct model identity:

```text
endpoint=MuskAPI
endpointType=custom
model=gpt-5.6-sol
spec=gpt-5.6-sol
```

The active Mongo base override contains `modelSpecs.list[].label` but omits
`modelSpecs.list[].preset.modelLabel` for `gpt-5.6-sol`.

LibreChat uses these fields for different purposes:

- `modelSpecs.list[].label` names the item in the model selector.
- `preset.modelLabel` names assistant messages and is included in the request
  endpoint options.
- `modelDisplayLabel` is an endpoint-level fallback.
- when the message label is absent, the custom-endpoint sender parser derives
  `GPT-5.6` from `gpt-5.6-sol`, intentionally losing the vendor suffix.

The resulting `GPT-5.6` value is then persisted in `messages.sender`; this is
not a CSS truncation or stale frontend bundle issue.

## Chosen Fix

Use LibreChat's supported configuration field:

```yaml
modelSpecs:
  list:
    - name: gpt-5.6-sol
      preset:
        modelLabel: GPT-5.6-SOL
```

Also normalize the MuskAPI endpoint fallback to `GPT-5.6-SOL` in the active
override. Do not patch `getResponseSender`, agent initialization, compiled
frontend assets, `BaseClient`, or historical Mongo messages.

## Release Gate

1. Update the repository-owned YAML baseline and regression assertion.
2. Add a production runner with exact preconditions, Mongo backup, rollback,
   API restart, and runtime assertions.
3. Run local tests.
4. Commit and push `origin/main` before the production write.
5. Deploy the committed release only.
6. Verify a newly generated message stores `sender: GPT-5.6-SOL`.
7. Record timestamp, backup ID, commit, and verification result in the repo.

## Non-Goals

- Do not rewrite existing `messages.sender` rows.
- Do not rename the real model slug.
- Do not change title generation, reasoning effort, prompts, or providers.
- Do not introduce a special-case source-code branch for one model.
