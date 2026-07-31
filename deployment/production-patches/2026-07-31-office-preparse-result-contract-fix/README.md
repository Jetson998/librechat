# Office pre-parse result contract fix

Development patch for two coupled failure modes in the Agent Office path:

1. Parse exactly one balanced JSON manifest after the Office marker while keeping
   known Bash wrapper stderr and generated-file summaries outside the manifest.
2. Persist a terminal user/assistant message pair when Agent initialization fails
   before `sendMessage()`, so the preliminary underscore response ID is no longer
   an orphan that permanently blocks the next follow-up with HTTP 409.

Development completed and was frozen in commit `ae2e324`. Release automation is
kept separate under `scripts/`: it packages files from an explicit Git revision,
backs up the current Compose override, replaces only the three API mounts, and
force-recreates only `LibreChat-API`. CodeAPI, NGINX, RAG, Admin, and MongoDB are
checked as unchanged protected services.

Run the focused test:

```sh
node deployment/production-patches/2026-07-31-office-preparse-result-contract-fix/scripts/test-office-preparse-result-contract.js
```

Run the bounded release from an exact committed revision:

```sh
deployment/production-patches/2026-07-31-office-preparse-result-contract-fix/scripts/deploy.sh <full-commit-sha>
```

Automatic rollback restores the timestamped Compose override backup and
recreates only the API if any post-write check fails.
