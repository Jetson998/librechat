# File Agent non-production integration harness

This directory is a repeatable, non-production environment for the M3 + M3.1
File Agent integration boundary. It is intentionally smaller than the
production cluster and contains no production data, production credentials,
public ingress, Nginx, RAG, Admin, or billable model endpoint.

The environment runs:

```text
LibreChat API with the repository's real File Agent overlay/bridge
MongoDB test instance
operator-supplied real LibreChat CodeAPI image
candidate File Agent Runtime image
local deterministic Fake Model Relay
test-only file, task, audit and CodeAPI storage
```

The CodeAPI image is an external input because this repository does not contain
the CodeAPI source. The harness verifies its immutable image ID and fails
closed when the image or an operator-supplied archive is missing. It never
replaces that image with a stub and never reports a Fake CodeAPI result as a
real protocol pass.

## Prerequisites

```sh
cp .env.integration.example .env.integration
```

Fill these candidate inputs in `.env.integration`:

```text
FILE_AGENT_RUNTIME_IMAGE
FILE_AGENT_RUNTIME_IMAGE_ID
FILE_AGENT_RUNTIME_SOURCE_REVISION
INTEGRATION_HARNESS_REVISION
```

The Runtime image must be the candidate under test and must be `linux/amd64`.
The historical local r2 image must not be silently used for a later source
revision. `FILE_AGENT_RUNTIME_SOURCE_REVISION` identifies the frozen Runtime
and Connector source, while `INTEGRATION_HARNESS_REVISION` identifies the
committed integration harness currently checked out. The harness requires the
Runtime source to be an ancestor of the harness revision and rejects any
Runtime/Connector business-path diff between them; it does not require the two
revisions to be identical. The real CodeAPI image must either already exist locally as
`local/librechat-codeapi:office` with the declared image ID or be supplied
through `CODEAPI_IMAGE_ARCHIVE` outside Git.

The state root stays private (`0700`). Disposable bind-mount data directories
inside it are made writable for the non-root UIDs defined by the API, Runtime,
CodeAPI and Fake Relay images; they contain no credentials and are removed by
the cleanup command. Secret and configuration files remain private.

Docker Compose and a Linux/amd64-capable Docker runtime are required. The
default API and Fake Relay host ports are `3081` and `8788`; change them if
they conflict with another local service.

## Commands

Start the environment and build only the API overlay/Fake Relay helper images:

```sh
./scripts/integration-up.sh
```

`integration-up.sh` also runs the infrastructure smoke. It checks all five
services, the API overlay marker, one Fake Relay request and one harmless real
CodeAPI `/exec` command. It also proves that an API-only bounded restart returns
to readiness without changing MongoDB, CodeAPI, Runtime or Fake Relay container
identity. It does not create an Agent, upload a DOCX or run the business E2E.

Inspect a running environment without changing it:

```sh
./scripts/integration-status.sh
```

Run the real API registration, login, endpoint/model selection, file upload,
Agent chat, SSE delivery, Fake Relay observation, Runtime `/exec` audit and
user/task/session isolation checks:

```sh
./scripts/run-file-agent-e2e.sh
```

The E2E uses two newly generated test users and two different allowlisted model
selections (`gpt-5.6-sol` and `claude-fable-5`) against the fixed repository
fixture `fixtures/minimal-source.docx`. The API-side endpoint is the
fixed production route identity `Muskapis-openai`; the Runtime private registry
maps that identity to the in-network Fake Relay. No public model request is
made.

On success, the default cleanup removes the integration containers, Mongo
named volume, test files, task data and test secrets. Redacted evidence is
kept under `runs/`. Set `INTEGRATION_KEEP_STATE=true` when inspecting a failed
run; a failed run is retained automatically so the first blocking fact is not
lost.

Clean an environment explicitly:

```sh
./scripts/integration-down.sh
```

Generate only test secrets (normally called by `integration-up.sh`):

```sh
./scripts/generate-test-secrets.sh
```

Import and verify the external CodeAPI image:

```sh
./scripts/import-codeapi-image.sh
```

## What is actually verified

The API Dockerfile pins the captured API image digest, installs the three
captured production baseline files from the repository, checks their hashes,
then copies the repository overlay, checks the overlay hashes, and writes a
startup marker. The reviewed baseline/overlay hashes and their source revision are versioned in
[`config/api-overlay-manifest.json`](config/api-overlay-manifest.json); the
startup marker carries that manifest into the run evidence. A marker alone is
not treated as a bridge pass: the E2E must also observe actual File Agent
traffic at the Fake Relay and the Runtime audit.

The Fake Relay records only bounded routing evidence:

```text
internal endpoint/base URL
HTTP path and protocol
selected model
idempotency-key presence
authorization presence
plan operation and assertion type summary
```

The Runtime audit records the `/exec` field set, session identity, bounded file
references, code hash/length and response status. It rejects neither the
real CodeAPI nor the customer file path by pretending a local `/api/files/...`
path is a filesystem path.

The required `/exec` field set and forbidden legacy fields are documented in
[`contracts/librechat-codeapi-exec.md`](contracts/librechat-codeapi-exec.md).
The JSON evidence shape is in
[`evidence/INTEGRATION_EVIDENCE.template.json`](evidence/INTEGRATION_EVIDENCE.template.json).
The operator self-review is in
[`evidence/reconciliation.template.md`](evidence/reconciliation.template.md),
with non-secret target facts in
[`PRODUCTION_INTEGRATION_FACTS.md`](PRODUCTION_INTEGRATION_FACTS.md) and the
full command/runbook in
[`INTEGRATION_ENVIRONMENT_RUNBOOK.md`](INTEGRATION_ENVIRONMENT_RUNBOOK.md).

## Scope and limitations

This harness is not a production release runner. It does not run production
preflight, SSH/SCP, Compose apply, restart of production services, model
requests, customer-file acceptance, or release finalization. A passing E2E
proves only the declared non-production API/Runtime/real-CodeAPI/Fake-Relay and
file-isolation chain.

The current production route registry intentionally has one fixed route
identity (`Muskapis-openai` / `custom:Muskapis-openai`) and an allowlist of the
two approved models. The integration harness tests dynamic selection between
those models. Expanding production protocols or adding arbitrary endpoint
identities is outside this harness task and must be a separately reviewed
production contract change.
