# Office File Identity and Regeneration Repair

Date: 2026-07-20

This patch repairs the deterministic Office read path on the exact API bundle
currently used by production. It preserves the existing model-pricing and
usage-dashboard code in that bundle.

Captured production baselines:

- active API bundle: `b9cac9721e5dcbde30b5d3b1052ba8306e15119255d4b8c53bb330ca8b089b27`;
- Code file priming service: `30b86dfe9d5077920937e8e530160f4bf8bcef32edd0632fdfc687caa50c3261`;
- resumable request controller: `5eeea022d37ce9ba34dfd2c91bc325bc5aea0d1df4ea292ababa87d2376244e2`;
- compose override: `33f582aa21a857f50d5158d612c9aba30fc4e7c33bcd1ceaec688e9df5eb687f`.

## Changes

- `primeFiles()` returns `source_file_id` for every primed database file.
- Office pre-parse resolves fresh CodeAPI references only by the stable
  LibreChat file ID.
- Regeneration restores only the target parent user message's uploaded files
  as current-turn files.
- The resumable GenerationJob abort signal reaches pre-parse during client
  initialization.
- Pre-parse runs through the existing CodeAPI bash transport with a 45 second
  timeout.

## Deployment

The release creates a new immutable host directory and updates the API volume
entries in `/opt/librechat/compose.override.yaml`. It recreates only the API
service. `docker restart` is intentionally not used because it would retain the
old bind-mount sources.

## Test

```sh
node deployment/production-patches/2026-07-20-office-file-identity/scripts/test-office-file-identity.js
node --check deployment/production-patches/2026-07-20-office-file-identity/office-context-patch/api-index.cjs
node --check deployment/production-patches/2026-07-20-office-file-identity/office-context-patch/code-process.js
node --check deployment/production-patches/2026-07-20-office-file-identity/office-context-patch/request.js
node --check deployment/production-patches/2026-07-20-office-file-identity/office-context-patch/OfficePreparse.js
```
