# Generated Artifact Visibility Limit

Date: 2026-07-22

This patch fixes the LibreChat assistant-message boundary that exposed every
CodeAPI output as a customer download. It keeps all generated files persisted
for continued editing and audit, while showing only the requested deliverables.

## Product Contract

- One assistant reply defaults to one complete deliverable file.
- Explicit, reasonable multi-format output may expose at most three files.
- More than three independent files is not supported in one reply.
- ZIP is not offered as a fallback.
- A multi-slide presentation is one complete PPTX, not one PPTX per slide.
- QA, manifest, error, render, preview, numbered page, and temporary artifacts
  remain internal.

## Changes

- `GeneratedArtifactVisibility.js` classifies generated files and selects the
  requested formats with a hard visible limit of three.
- `BaseClient.js` filters only the assistant message attachments and file cards;
  non-file tool attachments remain unchanged.
- `code-process.js` persists `metadata.artifactRole` and
  `metadata.artifactVisibilityReason` on generated files.
- `mongo-config.js` appends the same delivery contract to the active GPT and
  Fable model specs without replacing their existing prompts.

## Safety Boundary

Hidden files are not deleted. They remain owner- and conversation-scoped in
LibreChat/CodeAPI so a later turn can continue editing the complete work. The
patch changes only customer-visible attachment selection.

## Test

```sh
node deployment/production-patches/2026-07-22-visible-artifact-limit/scripts/test-visible-artifact-limit.js
node --check deployment/production-patches/2026-07-22-visible-artifact-limit/office-context-patch/GeneratedArtifactVisibility.js
node --check deployment/production-patches/2026-07-22-visible-artifact-limit/office-context-patch/BaseClient.js
node --check deployment/production-patches/2026-07-22-visible-artifact-limit/office-context-patch/code-process.js
node --check deployment/production-patches/2026-07-22-visible-artifact-limit/scripts/mongo-config.js
```

## Deployment

The governed runner creates an immutable release directory, backs up the active
Compose override and Mongo base config, updates only the API bind mounts, and
force-recreates only `LibreChat-API`. CodeAPI is checked as an unchanged
dependency and is not recreated.

## Rollback

Restore the timestamp-matched Compose backup and Mongo backup record created by
the runner, recreate only `LibreChat-API`, then verify `/`, `/api/config`, the
Office auth boundary, normal chat, Office reading, and generated download cards.
