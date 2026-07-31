# Office pre-parse result contract fix

Development patch for two coupled failure modes in the Agent Office path:

1. Parse exactly one balanced JSON manifest after the Office marker while keeping
   known Bash wrapper stderr and generated-file summaries outside the manifest.
2. Persist a terminal user/assistant message pair when Agent initialization fails
   before `sendMessage()`, so the preliminary underscore response ID is no longer
   an orphan that permanently blocks the next follow-up with HTTP 409.

This directory currently contains development code and local regression tests
only. Deployment automation and production release evidence are intentionally
deferred until the implementation passes local review.

Run the focused test:

```sh
node deployment/production-patches/2026-07-31-office-preparse-result-contract-fix/scripts/test-office-preparse-result-contract.js
```
