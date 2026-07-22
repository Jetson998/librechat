# Fable Tool Endpoint Alias Compatibility

This release fixes a confirmed model-tool contract mismatch for
`claude-fable-5` without changing the Office upload, pre-parse, CodeAPI, or
artifact delivery pipelines.

## Confirmed failure

Conversation `9b947fcc-8e44-4220-a48f-5e5a39a5a3b1` had valid DOCX/XLSX
`codeEnvRef` values and successful Office pre-parse. The model nevertheless
called Claude Code aliases (`Bash`, `Read`, and `Skill`), while LibreChat had
registered `bash_tool`, `read_file`, and `skill`. The event executor therefore
returned `Tool not found`, leaving the model with only the bounded Office
manifest instead of the complete document available under `/mnt/data`.

## Scope

- Normalize only `Bash`, `Read`, and `Skill` at `ON_TOOL_EXECUTE` before tool
  loading.
- Convert `Read.file_path` to `read_file.path`.
- Convert `Skill.skill` to `skill.skillName`.
- Preserve IDs, code-session context, file injection metadata, and all other
  arguments.
- Correct only the `claude-fable-5` prompt text in the active base Mongo
  configuration.
- Keep `Grep` unsupported instead of synthesizing shell commands.

## Files

- `api-patch/api-index.cjs`: current production package baseline plus the
  bounded normalization hook.
- `api-patch/tool-call-normalizer.cjs`: independently testable alias contract.
- `scripts/mongo-config.js`: preflight/apply/verify/rollback for the Fable
  prompt correction.
- `scripts/test-release.js`: regression tests based on the recorded production
  tool-call payloads.
- `scripts/deploy.sh`: governed SSH/SCP wrapper.
- `scripts/remote-apply.sh`: fail-closed API-only recreation with Mongo and
  Compose rollback.

## Validation

```sh
node deployment/production-patches/2026-07-22-fable-tool-endpoint-aliases/scripts/test-release.js
node deployment/production-patches/2026-07-22-fable-tool-endpoint-aliases/scripts/test-mongo-config.js
node --check deployment/production-patches/2026-07-22-fable-tool-endpoint-aliases/api-patch/api-index.cjs
node --check deployment/production-patches/2026-07-22-fable-tool-endpoint-aliases/api-patch/tool-call-normalizer.cjs
node --check deployment/production-patches/2026-07-22-fable-tool-endpoint-aliases/scripts/mongo-config.js
bash -n deployment/production-patches/2026-07-22-fable-tool-endpoint-aliases/scripts/deploy.sh
bash -n deployment/production-patches/2026-07-22-fable-tool-endpoint-aliases/scripts/remote-apply.sh
```

## Production boundary

The release recreates only `LibreChat-API`. It writes one versioned base-config
change in `chat-mongodb` and verifies that `LibreChat-CodeAPI` retains the same
container ID, start time, and healthy state. Rollback restores both the Compose
override and the exact backed-up Mongo document.

The detailed design and acceptance contract are recorded in
`docs/FABLE_TOOL_ALIAS_NORMALIZATION_PLAN.md`.
