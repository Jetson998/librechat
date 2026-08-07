# File Agent Runtime M3/M3.1 integration environment runbook

This runbook is for a non-production, production-shaped integration test
environment. It is not a production deployment or release procedure.

## Components

```text
mongodb              disposable test database
codeapi              operator-supplied real LibreChat CodeAPI image
fake-model-relay     local deterministic OpenAI-compatible relay
file-agent-runtime   candidate Runtime image under test
api                  LibreChat API plus reviewed File Agent overlay
admin-panel          CI-verified LibreChat Admin Panel image
```

The environment excludes production MongoDB, Nginx, RAG, public ingress,
production credentials, real model endpoints, and customer files.

## Required inputs

```sh
cp .env.integration.example .env.integration
```

Fill the exact non-secret image identities:

```text
FILE_AGENT_RUNTIME_IMAGE
FILE_AGENT_RUNTIME_IMAGE_ID
FILE_AGENT_RUNTIME_SOURCE_REVISION
INTEGRATION_HARNESS_REVISION
CODEAPI_IMAGE
CODEAPI_IMAGE_ID
ADMIN_PANEL_IMAGE
ADMIN_PANEL_IMAGE_ID
INTEGRATION_TEST_USER_EMAIL
INTEGRATION_TEST_USER_PASSWORD
```

`CODEAPI_IMAGE_ARCHIVE` may point to an operator-supplied archive outside Git.
The exact images must be `linux/amd64`. If the real CodeAPI image is missing,
`integration-up.sh` stops before creating test secrets or state.
`FILE_AGENT_RUNTIME_SOURCE_REVISION` is the frozen 40-character Runtime and
Connector source revision. `INTEGRATION_HARNESS_REVISION` is the full
40-character commit currently checked out. The Runtime revision must be an
ancestor of the harness revision, and the harness refuses any
`services/file-agent-runtime` or `services/librechat-file-agent-connector`
diff between those revisions. This lets the harness be committed after the
Runtime is frozen without silently combining an old Runtime image with newer
business source.

## Operator commands

From this directory:

```sh
./scripts/import-codeapi-image.sh
./scripts/integration-up.sh
./scripts/integration-status.sh
./scripts/run-file-agent-e2e.sh
./scripts/integration-down.sh
```

`integration-up.sh` imports/verifies CodeAPI, creates isolated state and test
secrets, packages the Connector, builds the API overlay/Fake Relay helpers,
starts Compose and records startup evidence. It does not run business E2E.

`integration-status.sh` is read-only. It reports image identity, Compose
service/container state, state marker, evidence paths and the API overlay
marker. It does not create or remove resources.

`run-file-agent-e2e.sh` is the developer-facing business E2E entrypoint. The
developer owns its positive and negative business assertions; it logs in with
the one permanent disposable administrator recorded under private integration
state and must use the stable environment after the operator smoke is complete.
The same login is valid at the frontend and Admin Panel; the user selects both
approved models in separate Agent scenarios. Negative-path users are temporary
and must be deleted by the E2E before a successful result.

`integration-down.sh` removes only this integration Compose project, its named
Mongo volume, state directory and generated test secrets. It refuses unknown
or symlinked state roots.

## Operator smoke before developer handoff

The operator must first establish:

```text
1. exact CodeAPI image imported and ID matched;
2. API, Admin Panel, MongoDB, CodeAPI, Runtime and Fake Relay started once;
3. API overlay startup marker exists;
4. real CodeAPI accepts a harmless `/exec` request with the declared schema;
5. Fake Relay accepts and records one test model request;
6. status reports the expected image/platform/container identities;
7. down removes containers, volume, state and generated secrets;
8. `runtimeSourceRevision` and `integrationHarnessRevision` are both recorded;
   the Runtime/Connector business diff between them is empty.
9. one permanent disposable test user is created, promoted to `ADMIN`, assigned
   both approved model selections, and its internal ID becomes the final
   temporary allowlist;
10. the bootstrap API is force-recreated once after that allowlist update, the
    new process reaches `healthy`, `/readyz` and `/api/config`, and MongoDB,
    CodeAPI, Runtime, Fake Relay and Admin Panel container IDs stay unchanged;
11. the Admin Panel reaches `/health`, the test account passes
    `/api/admin/verify`, has `manage:configs`, and can read
    `/api/admin/config/base`.
```

The harmless CodeAPI smoke is infrastructure-only. It is not a DOCX business
acceptance and must not be reported as one.

The captured amd64 LibreChat API has shown that repeated graceful restarts can
remain between shutdown and process startup for several minutes under local
emulation. The harness therefore does not use repeated `docker compose restart`
as an allowlist reload mechanism. Before any business request exists, it kills
and removes only the disposable bootstrap API container, creates one fresh API
container, and allows up to 300 seconds for the same clean-start path used on
initial boot. MongoDB, CodeAPI, Runtime, Fake Relay and Admin Panel remain
running and their container identities must not change. The final environment
is handed to E2E with the allowlist already active; the E2E does not own API
lifecycle changes.

Local access after operator smoke:

```text
frontend: http://127.0.0.1:3081
admin:    http://127.0.0.1:3091/configuration?tab=custom
account:  INTEGRATION_TEST_USER_EMAIL from ignored .env.integration
role:     ADMIN
```

The Admin screen is suitable for testing configuration persistence in the
disposable API/Mongo pair. It is not evidence that the Runtime used a real
provider: this harness intentionally keeps the Runtime private route mapped to
the Fake Relay.

## Evidence

Use [`evidence/reconciliation.template.md`](evidence/reconciliation.template.md)
and retain redacted files under the run evidence directory. Do not use the
following as a substitute for the operator smoke or developer E2E:

```text
container healthy
/healthz = 200
Docker mock success
Runtime unit tests
Connector unit tests
Fake Relay-only smoke
Compose YAML parsing
```

## Negative and business E2E ownership

The developer must use this environment to verify the Agent DOCX chain,
selected GPT/Fable model routing, artifact identity, Verifier, native fallback
and failure paths. If a failure is caused by container/image/network/volume or
CodeAPI availability, Operations owns it. If it is caused by bridge, route,
payload, artifact identity, Verifier, billing or journal behavior, Development
owns it.

## Cleanup self-check

After `integration-down.sh`:

```sh
./scripts/integration-status.sh
docker ps -a --filter name=file-agent-integration
docker volume ls --filter label=com.docker.compose.project=file-agent-integration
```

Expected result:

```text
state directory absent
test secret files absent
integration containers absent
integration volumes absent
production write=false
```

Only after the smoke checklist and reconciliation table are complete may the
operator hand the environment to Development for business E2E.
