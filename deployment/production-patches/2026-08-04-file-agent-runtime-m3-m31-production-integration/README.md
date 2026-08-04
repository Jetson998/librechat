# File Agent Runtime M3 + M3.1 production integration

This directory is the production integration contract for the unified Office
batch. It is development source only until the final source revision has been
reviewed and a release candidate has been explicitly authorized.

The integration has one bounded deployment unit:

```text
LibreChat-API + file-agent-runtime
```

The Runtime is private to the Compose network. It has no host port, reverse
proxy route, browser CORS surface, CodeAPI data mount, or access to the API
container filesystem. The API receives a read-only Connector source mount. The
Runtime image is immutable by digest and owns a separate durable task/journal
volume.

No secret value is stored in this directory. Operators provide these host files
at deployment time:

- File Agent HMAC service-scope secret;
- File Agent user allowlist;
- model relay API key.

The runner requires an explicit `enable_runtime=true` handoff input. A missing
input, non-digest image, missing secret file, missing allowlist, missing model
configuration, or failed health check stops before the Compose write. A failed
post-write check restores the prior Compose override and recreates only the
previous API/Runtime state. Existing Mongo, CodeAPI, RAG, Nginx, and Admin
services are outside the rollback scope.

The old `2026-08-04-file-agent-runtime-m3r-api-bootstrap` directory remains a
historical record of the deployed default-disabled API bootstrap. It is not
modified by this integration.

## Contract files

- `compose.runtime.contract.yaml`: human-readable Compose service contract;
  it is a template and contains no secret values.
- `SOURCE_MANIFEST.json`: source-level contract and target invariants.
- `scripts/remote-preflight.py`: read-only target and secret/image precheck.
- `scripts/remote-apply.py`: bounded API + Runtime apply with automatic
  rollback.
- `scripts/remote-rollback.py`: restores the pre-apply two-service state.
- `scripts/deploy.sh`: release-governance scoped entry point for a later
  authorized release.
- `scripts/test-release.py`: isolated Compose transformation and rollback
  replay; it does not contact Docker, SSH, Mongo, or production.

Candidate creation remains a separate later step. This directory does not
authorize image builds, source packaging, preflight, deployment, restart, or
customer-file acceptance.
