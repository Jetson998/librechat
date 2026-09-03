# Clear Model Effort Defaults

Date: 2026-09-03

This operation removes preset reasoning-strength values from the five active
base model specs. It changes only `preset.effort` and
`preset.reasoning_effort`; `thinking`, `thinkingDisplay`, model names, routing,
prompts, and all other fields remain unchanged.

The Mongo operation writes a complete copy of the active base config to
`codexConfigBackups` before incrementing `configVersion`. Rollback replaces the
same config document from that backup and is guarded by the exact backup id.

Target scope: `chat-mongodb` only. No API, NGINX, Client, CodeAPI, RAG, Admin,
or Office service is recreated.

Target models:

- `claude-fable-5-1`
- `claude-opus-5`
- `claude-opus-4-8`
- `gpt-5.6-sol`
- `claude-fable-5`

The empty value means vendor-managed automatic reasoning. The client feature
under development may send a session-only `effort` value, but it does not write
back to this global model configuration.
