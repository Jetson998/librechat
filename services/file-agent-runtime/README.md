# File Agent Runtime

This directory contains the non-production File Agent Runtime foundation,
the Phase 1 isolated CodeAPI executor POC, and the Phase 2A recorded single-model
POC described in:

- `docs/INDEPENDENT_FILE_AGENT_RUNTIME_ARCHITECTURE.md`
- `docs/FILE_AGENT_RUNTIME_PHASE0_IMPLEMENTATION.md`
- `docs/FILE_AGENT_RUNTIME_PHASE1_CODEAPI_POC_PLAN.md`
- `docs/FILE_AGENT_RUNTIME_PHASE1_IMPLEMENTATION.md`
- `docs/FILE_AGENT_RUNTIME_PHASE2_SINGLE_MODEL_POC_PLAN.md`
- `docs/FILE_AGENT_RUNTIME_PHASE2A_IMPLEMENTATION.md`
- `docs/FILE_AGENT_RUNTIME_PHASE2B_HARNESS_IMPLEMENTATION.md`
- `docs/FILE_AGENT_RUNTIME_PHASE3_CONNECTOR_PLAN.md`
- `docs/FILE_AGENT_RUNTIME_PHASE3A_IMPLEMENTATION.md`
- `docs/FILE_AGENT_RUNTIME_PHASE3B_IMPLEMENTATION.md`
- `docs/FILE_AGENT_RUNTIME_PHASE3B_HOST_WIRING.md`

It uses Node.js built-in modules only. The Phase 1 XLSX fixture executes Python
inside an isolated test CodeAPI service; the Runtime package itself does not
import Python libraries.

## Implemented

- versioned task manifest validation;
- idempotent task submission;
- file-backed task and event persistence;
- monotonic event sequence and cursor replay;
- explicit task state transitions;
- cancel, steer, verification, repair, and restart recovery;
- formal `ExecutorAdapter` contract and typed executor errors;
- isolated HTTP CodeAPI transport boundary;
- deterministic one-XLSX plan without a real model;
- one persisted workbook script and one incremental patch path;
- workbook verification and one CodeAPI artifact reference;
- item-level external idempotency proven across Runtime restart;
- formal `ProviderAdapter` contract and typed provider errors;
- one allowlisted OpenAI-compatible model route;
- persistent model call journal with completed replay, digest conflict, and
  ambiguous-commit handling;
- structured model plans restricted to versioned worker actions;
- bounded context projection without scripts, stdout, credentials, or prices;
- durable input/cache-read/cache-write/output usage events;
- progress fingerprints that stop repeated repair plans before duplicate work;
- isolated recorded model relay with no external model calls or cost;
- fake adapters for the original Phase 0 state-machine tests;
- local development HTTP API bound to `127.0.0.1` by default.
- read-only Runtime capability discovery for the Phase 3A Connector contract.
- optional Phase 3B request authorization hook for signed internal `/v1/*`
  service scopes; `/healthz` remains outside service authentication.
- explicit `maxInputFiles: 1` capability advertisement for the current XLSX
  worker;
- a Runtime-owned FIFO queue with a configurable `maxConcurrentTasks` limit,
  defaulting to two concurrent tasks.

## Not Implemented

- production LibreChat Connector integration;
- production secret distribution, rotation, or public authentication;
- production CodeAPI authentication or protocol mapping;
- persistent external model credentials or a production model route;
- Word, PPT, PDF, or general Office workers;
- production usage ingestion or billing;
- production artifact persistence through `processCodeOutput()`;
- Redis, database, or multi-replica coordination;
- production container, deployment, or public endpoint.

## Run

Requires Node.js 20 or newer. XLSX tests also require Python 3 with
`openpyxl` in the test environment.

```sh
cd services/file-agent-runtime
npm run check
npm test
npm start
```

`npm test` starts temporary HTTP servers on `127.0.0.1` for the isolated
CodeAPI and recorded model relay fixtures. It never calls production or a
remote service.

The default `npm start` command intentionally still uses `FakeProvider` and
`FakeExecutor`. Phase 1 CodeAPI and Phase 2A provider components are not
selectable from the server entry point, which prevents accidental connection
to a real endpoint before a separate non-production integration gate.

Defaults:

```text
host: 127.0.0.1
port: 8790
data: services/file-agent-runtime/.data
```

Optional development variables:

```text
FILE_AGENT_HOST
FILE_AGENT_PORT
FILE_AGENT_DATA_DIR
```

The development server must not be exposed publicly.

The in-process Runtime constructor also accepts `maxConcurrentTasks`. Queued
tasks remain durable and begin in FIFO order when a running slot is released;
LibreChat request concurrency is not used as Runtime capacity.

## Runtime API

```text
GET  /healthz
GET  /v1/capabilities
POST /v1/tasks
GET  /v1/tasks/{taskId}
GET  /v1/tasks/{taskId}/events?after={sequence}
POST /v1/tasks/{taskId}/cancel
POST /v1/tasks/{taskId}/steer
```

## Persistence Contract

Each task is stored under:

```text
<data-dir>/tasks/<task-id>.json
```

The document includes the manifest, phase, plan revision, execution cursor,
item results, instructions, terminal result, and durable events. Writes use a
temporary file followed by an atomic rename.

Idempotency indexes contain only a SHA-256 hash of the external key. Reusing a
key with a different canonical manifest returns `409`.

## Executor Contract

Every executor operation receives the deterministic Runtime `itemId`:

```text
prepare({ itemId, task, signal })
execute({ itemId, action, task, signal })
verify({ itemId, task, signal })
publish({ itemId, task, signal })
```

The Phase 1 transport sends that value unchanged as `item_id`. Its isolated
CodeAPI fixture persists completed responses by item ID. If the Runtime stops
after the external command succeeds but before the item checkpoint is written,
the resumed request returns the stored result with `replayed: true` and does not
execute the command again.

## Phase 1 XLSX Contract

The deterministic POC requires exactly one `.xlsx` input with a CodeAPI ref and
one matching execution session. It uses stable paths:

```text
/mnt/data/.agent/<taskId>/scripts/transform_workbook.py
/mnt/data/.agent/<taskId>/output/phase1-output.xlsx
```

The first verification intentionally requests one repair. The repair changes a
single marker in the persisted script and reruns the same script and output
path. It does not regenerate a large program.

The final Runtime result contains one opaque CodeAPI artifact reference only.
It is not a LibreChat file record and is not a download card.

## Phase 2A Provider Contract

The task contains only an allowlisted `modelRouteId` and capability profile.
Route URLs, credentials, models, budgets, and idempotency support are injected
into `SingleModelAgentProvider` and are not persisted in the task.

Each provider item uses the Runtime item ID as its `callId`. Before an upstream
request, `FileModelCallJournal` writes a pending record under:

```text
<journal-dir>/model-calls/<sha256-call-id>.json
```

A normalized plan and usage record are atomically marked completed before the
provider returns to the Runtime. Completed calls replay locally. Pending calls
may only replay when the route guarantees idempotency; otherwise the task moves
to `needs_input` instead of risking a duplicate billable request.

## Context And Usage

`ContextProjector` sends only the objective, acceptance criteria, phase,
resource names and hashes, bounded recent item summaries, verification state,
and progress state. The serialized projection is capped at 12,000 characters
by default. Full scripts, stdout, file contents, credentials, URLs, prices, and
LibreChat objects are excluded.

Successful provider calls persist one idempotent `usage.recorded` event with:

```text
inputTokens
cacheReadTokens
cacheWriteTokens
outputTokens
```

The Runtime does not calculate cost or create LibreChat transactions.

## Progress Contract

Failed verification results receive a stable fingerprint. The first failure
enters repair normally. If the same failure returns after repair and the model
again proposes the same repair action signature, the Runtime moves to
`needs_input` before executing duplicate CodeAPI work. Hard call-count limits
remain safety boundaries, not the primary scheduler.

## Safety Boundary

The Phase 1 and Phase 2A implementations do not read LibreChat Mongo, import
LibreChat source, call `processCodeOutput()`, calculate prices, or access
production CodeAPI or a production model relay. The fixtures map only isolated
local sessions and contain no customer data.

## Phase 2B One-shot Harness

`scripts/phase2b-once.js` is a disabled-by-default non-production acceptance
harness. It always uses the tracked `test/fixtures/phase2b-source.xlsx`, an
isolated local CodeAPI fixture, one allowlisted model route, at most two model
calls, an 8,000-character context projection, and fixed input/output budgets.

The harness refuses a real relay unless all of these variables are present:

```text
FILE_AGENT_PHASE2B_BASE_URL
FILE_AGENT_PHASE2B_API_KEY
FILE_AGENT_PHASE2B_MODEL
FILE_AGENT_PHASE2B_KEY_SCOPE=non-production
FILE_AGENT_PHASE2B_CONFIRM=ONE_NON_PRODUCTION_BILLABLE_TASK
FILE_AGENT_PHASE2B_SUPPORTS_IDEMPOTENCY=true|false
FILE_AGENT_PHASE2B_STRUCTURED_OUTPUT_MODE=json_object|json_schema
```

Run only after a separately scoped test key is approved:

```sh
npm run phase2b:run
```

The retained `.phase2b/phase2b-report.json` records status, latency, usage,
request-contract compatibility and model quality without storing the API key or
relay URL. Re-running the same directory uses the same task idempotency key and
provider journal instead of creating a second billable task. The harness never
writes LibreChat transactions and is not reachable from `npm start`.
