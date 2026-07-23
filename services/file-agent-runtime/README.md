# File Agent Runtime

This directory contains the non-production File Agent Runtime foundation and
the Phase 1 isolated CodeAPI executor POC described in:

- `docs/INDEPENDENT_FILE_AGENT_RUNTIME_ARCHITECTURE.md`
- `docs/FILE_AGENT_RUNTIME_PHASE0_IMPLEMENTATION.md`
- `docs/FILE_AGENT_RUNTIME_PHASE1_CODEAPI_POC_PLAN.md`
- `docs/FILE_AGENT_RUNTIME_PHASE1_IMPLEMENTATION.md`

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
- fake adapters for the original Phase 0 state-machine tests;
- local development HTTP API bound to `127.0.0.1` by default.

## Not Implemented

- LibreChat Connector;
- production authentication or signed task scopes;
- production CodeAPI authentication or protocol mapping;
- real model calls;
- Word, PPT, PDF, or general Office workers;
- usage ingestion or billing;
- artifact persistence through `processCodeOutput()`;
- Redis, database, or multi-replica coordination;
- production container, deployment, or public endpoint.

## Run

Requires Node.js 20 or newer. Phase 1 tests also require Python 3 with
`openpyxl` in the test environment.

```sh
cd services/file-agent-runtime
npm run check
npm test
npm start
```

`npm test` starts a temporary HTTP server on `127.0.0.1` for the isolated
CodeAPI fixture. It never calls production or a remote service.

The default `npm start` command intentionally still uses `FakeProvider` and
`FakeExecutor`. Phase 1 CodeAPI components are not selectable from the server
entry point, which prevents accidental connection to a real endpoint before a
separate non-production integration gate.

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

## Runtime API

```text
GET  /healthz
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

## Safety Boundary

The Phase 1 implementation does not read LibreChat Mongo, import LibreChat
source, call `processCodeOutput()`, calculate prices, or access production
CodeAPI. The test fixture maps only an isolated `/mnt/data` directory and an
explicit session allowlist.
