# Fable Custom Endpoint Release

This release routes new `claude-fable-5` model-spec selections through the
same MuskAPI relay used by `gpt-5.6-sol`, using a custom Anthropic-compatible
endpoint. It does not add a pricing subsystem.

## Changes

- add `MuskAPI-Anthropic` as a custom endpoint;
- keep the existing native `anthropic` endpoint for compatibility;
- point the Fable model spec at `MuskAPI-Anthropic`;
- allow the custom endpoint for agents;
- restart only `LibreChat-API` after the base override is updated;
- preserve historical conversations and transactions.

The live configuration script stores a complete backup document in
`codexConfigBackups` before applying the change.

## Expected Routing

```text
claude-fable-5 -> MuskAPI-Anthropic -> https://api.muskapis.com
gpt-5.6-sol   -> MuskAPI          -> https://api.muskapis.com/v1
```

The API key is referenced only as `${ANTHROPIC_API_KEY}` and is never written
to this repository or the release archive.
