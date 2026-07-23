# File Agent Runtime Phase 0

This directory contains the non-production Phase 0 implementation described in
`docs/INDEPENDENT_FILE_AGENT_RUNTIME_ARCHITECTURE.md`.

It intentionally uses only Node.js built-in modules. It does not connect to
LibreChat, MongoDB, CodeAPI, a model provider, or production traffic.

## Implemented

- versioned task manifest validation;
- idempotent `POST /v1/tasks`;
- file-backed task and event persistence;
- monotonic event sequence and cursor replay;
- explicit task state transitions;
- cancel and steer;
- restart recovery for non-terminal tasks;
- deterministic fake provider and executor;
- item-level idempotency keys;
- verification and one repair-plan fixture;
- local HTTP API bound to `127.0.0.1` by default.

## Not Implemented

- LibreChat Connector;
- production authentication or task signatures;
- real model calls;
- CodeAPI execution;
- Office workers;
- usage ingestion or billing;
- artifact persistence through `processCodeOutput()`;
- Redis or multi-replica coordination.

## Run

Requires Node.js 20 or newer.

```sh
cd services/file-agent-runtime
npm test
npm run check
npm start
```

Defaults:

```text
host: 127.0.0.1
port: 8790
data: services/file-agent-runtime/.data
```

Optional environment variables:

```text
FILE_AGENT_HOST
FILE_AGENT_PORT
FILE_AGENT_DATA_DIR
```

The Phase 0 server must not be exposed publicly. It has no production service
authentication because its purpose is to validate the state and recovery
contract before integration work begins.

## API

```text
GET  /healthz
POST /v1/tasks
GET  /v1/tasks/{taskId}
GET  /v1/tasks/{taskId}/events?after={sequence}
POST /v1/tasks/{taskId}/cancel
POST /v1/tasks/{taskId}/steer
```

Example submission:

```sh
curl -sS http://127.0.0.1:8790/v1/tasks \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: phase0-example-1' \
  -d '{
    "schemaVersion": "1.0",
    "taskContractVersion": "office-file-agent.v1",
    "taskType": "office_transform",
    "intent": "Run the deterministic Phase 0 fixture"
  }'
```

## Persistence Contract

Each task is stored as one JSON document under:

```text
<data-dir>/tasks/<task-id>.json
```

The document includes the manifest, current phase, plan revision, execution
cursor, item results, instructions, terminal result, and durable event list.
Writes use a temporary file followed by an atomic rename.

Idempotency indexes are stored by SHA-256 hash. The raw Idempotency-Key is not
written to disk. If an index write is interrupted, startup lookup can rebuild
the index by scanning task documents. Reusing a key with a different canonical
manifest digest returns `409` instead of silently reusing the old task.

## Adapter Contract

Every provider or executor operation receives a deterministic `itemId`. Future
CodeAPI and model adapters must treat it as an idempotency key. A task can be
resumed after a crash with an item marked started but not completed; repeating
that item must not duplicate an external side effect.

The fake adapters are test fixtures only. They make no network or file-execution
calls.
