# Fable Custom Endpoint Plan

Date: 2026-07-18

## Decision

`claude-fable-5` and `gpt-5.6-sol` use the same MuskAPI relay, but Fable is
currently routed through LibreChat's built-in `anthropic` endpoint. Keep the
model name and the original endpoint for compatibility, and add a second
custom endpoint named `MuskAPI-Anthropic` for new model-spec selections.

The existing pricing page already supports custom endpoints and native
`tokenConfig`, so no new pricing engine or provider-price feature is needed.

## Runtime Change

- add `endpoints.custom[name=MuskAPI-Anthropic]` with `provider: anthropic`;
- use the existing `${ANTHROPIC_API_KEY}` and the relay root
  `https://api.muskapis.com`;
- expose `claude-fable-5` on that endpoint with model fetching disabled;
- add the endpoint to `endpoints.agents.allowedProviders`;
- change only `modelSpecs.list[name=claude-fable-5].preset.endpoint`;
- leave the native `endpoints.anthropic` block unchanged;
- leave existing conversations and transactions unchanged.

## Compatibility

Existing conversations may retain their stored `anthropic` endpoint. New
conversations and newly selected Fable presets use `MuskAPI-Anthropic`.
Historical transactions are never recalculated.

## Verification

1. Read-only audit the active base override and running API image.
2. Deploy the committed Admin Panel save-path fix without rebuilding API.
3. Apply the committed base-config change with a Mongo backup and restart only
   `LibreChat-API` so the merged configuration is reloaded.
4. Verify the Fable spec, custom endpoint, allowed provider list, API readiness,
   and unchanged protected container IDs.
5. Open Admin Panel pricing and verify Fable appears under the custom endpoint.
6. Save Fable prices through the page and verify `tokenConfig` in Mongo.
7. Send one new Fable request and verify the new transaction uses the saved
   price; do not modify historical transactions.
