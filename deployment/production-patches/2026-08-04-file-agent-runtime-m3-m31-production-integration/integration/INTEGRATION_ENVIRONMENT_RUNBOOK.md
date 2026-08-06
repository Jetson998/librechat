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
```

The environment excludes production MongoDB, Nginx, RAG, Admin, public
ingress, production credentials, real model endpoints, and customer files.

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
developer owns its positive and negative business assertions; it must use the
environment after the operator smoke is complete.

`integration-down.sh` removes only this integration Compose project, its named
Mongo volume, state directory and generated test secrets. It refuses unknown
or symlinked state roots.

## Operator smoke before developer handoff

The operator must first establish:

```text
1. exact CodeAPI image imported and ID matched;
2. API, MongoDB, CodeAPI, Runtime and Fake Relay started once;
3. API overlay startup marker exists;
4. real CodeAPI accepts a harmless `/exec` request with the declared schema;
5. Fake Relay accepts and records one test model request;
6. status reports the expected image/platform/container identities;
7. down removes containers, volume, state and generated secrets;
8. `runtimeSourceRevision` and `integrationHarnessRevision` are both recorded;
   the Runtime/Connector business diff between them is empty.
```

The harmless CodeAPI smoke is infrastructure-only. It is not a DOCX business
acceptance and must not be reported as one.

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
