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

The Dockerfile uses the Debian snapshot at `20260702T000000Z` with separate
`bookworm`, `bookworm-updates`, and `bookworm-security` APT sources. The
LibreOffice Calc, Impress, and Writer lock is
`4:7.4.7-1+deb12u13`, which is present in the declared `bookworm-security`
amd64 `Packages` index. `scripts/verify-apt-snapshot.py` checks the actual
snapshot, suite, amd64 index, index digest, and exact locked package records.
It does not claim to solve the transitive APT transaction; the authorized
candidate Docker build is the evidence for native `apt-get install`. The
image is not built during development-only review.

The explicit candidate-stage index check is:

```sh
python3 deployment/production-patches/2026-08-04-file-agent-runtime-m3-m31-production-integration/scripts/verify-apt-snapshot.py \
  --dockerfile services/file-agent-runtime/Dockerfile \
  --apt-lock services/file-agent-runtime/apt-packages.lock \
  --architecture amd64 \
  --download
```

Routine rejection tests use the fixed offline fixtures under
`scripts/fixtures/apt/` and do not invoke this download path.

The Connector production archive contains the complete `src/` tree, including
the canonical shared acceptance contracts under `src/acceptance-contracts/`.
The API therefore loads the same acceptance contract from its own mounted
archive; it does not resolve modules from the Runtime container filesystem.

No secret value is stored in this directory. Operators provide these host files
at deployment time:

- File Agent HMAC service-scope secret;
- File Agent user allowlist;
- one server-side provider key file for each allowlisted provider route.

The API receives a non-sensitive provider route map and the Runtime receives a
private provider route registry. The registry declares endpoint identity,
protocol, model allowlist, base URL, and the container secret path for each
route. User-selected endpoint/model values are resolved against this registry;
the user cannot supply a URL or API key to the task.

The runner requires an explicit `enable_runtime=true` handoff input. A missing
input, non-digest image, missing secret file, missing allowlist, missing
provider route registry, or failed health check stops before the Compose write.
A failed
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
- `scripts/package-connector-archive.py`: creates the deterministic,
  manifest-backed Connector source archive used by the handoff.
- `scripts/deploy.sh`: release-governance scoped entry point for a later
  authorized release.
- `scripts/test-release.py`: isolated Compose transformation and rollback
  replay; it does not contact Docker, SSH, Mongo, or production.
- `scripts/test-sol-rejections.py`: failure tests for real archive import,
  disabled-baseline rollback semantics, Compose service container resolution,
  rollback baseline restoration, and exact Debian root-package index checks
  using fixed offline fixtures.

Candidate creation remains a separate later step. This directory does not
authorize image builds, source packaging, preflight, deployment, restart, or
customer-file acceptance.
