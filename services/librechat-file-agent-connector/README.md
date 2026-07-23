# LibreChat File Agent Connector

This package contains the Phase 3A local contract POC, Phase 3B native host
adapters, the Phase 3C controller bridge, and the Phase 3D non-production
upstream host adapter for the independent File Agent Runtime. The runtime
package and normal tests use Node.js built-in modules only. There is no
production entry point.

## Implemented

- deterministic allowlist and file-intent routing;
- capability discovery over Runtime HTTP;
- opaque task manifest construction and stable idempotency keys;
- in-memory delivery records with durable-cursor semantics;
- Runtime submit, event polling, cancel, and steer clients;
- idempotent four-part usage ingestion through recorded transaction ports;
- verified artifact delivery with MIME/extension checks and a three-file cap;
- preallocated assistant message and stream identity reuse;
- ordered message, final-event, and job completion;
- delivery retry after message or final-event interruption;
- delivery failure for artifact policy violations;
- restart reconciliation from the last completed Runtime sequence.
- Mongo-backed delivery records with optimistic updates, unique submission
  identities, recoverable scans, and short multi-replica leases;
- immutable model-specific billing snapshots without endpoint credentials;
- injected native LibreChat ports for structured transactions,
  `processCodeOutput()`, message persistence, and GenerationJobManager;
- one host composition root for Mongo stores, Runtime authentication, native
  ports, generated-file download refs, and final-event reconstruction;
- stable transaction IDs that repair partial usage writes without rebilling;
- HMAC service scopes bound to the exact HTTP method, path, query, body, and
  task idempotency header.
- a two-stage controller handoff: capability routing is prepared without
  persistence, then the authoritative user message and conversation are saved
  before the immutable billing snapshot and Runtime delivery are created;
- prepared-route identity checks that reject request mutation between probe and
  submission without creating a delivery;
- fail-closed ownership after user persistence, so a failed Runtime handoff
  cannot start a second native Agent execution;
- best-effort immediate reconciliation scheduling backed by durable periodic
  recovery when the scheduler is temporarily unavailable.
- an explicit upstream adapter that resolves only `req.body.files` from the
  initialized `client.options.attachments`, validates user/tenant/CodeAPI
  ownership, freezes the resolved provider pricing, and installs the bridge on
  `Express app.locals`;
- Runtime capability enforcement for exactly one current-turn XLSX input;
- a Runtime-owned FIFO capacity queue, independent of LibreChat's short-lived
  pending-request counter;
- an immediate and periodic reconciler with per-delivery wake deduplication;
- one guarded Phase 3D acceptance command using a real loopback MongoDB,
  loopback Runtime HTTP, isolated CodeAPI, and isolated recorded model relay.
- one guarded Phase 3D-B acceptance command using the pinned full LibreChat API
  and client build, a real browser, temporary MongoDB, Runtime/API restart
  recovery, native download-card verification, and native fallback verification;
- one disabled-by-default Phase 3D-C command that maps the Runtime executor to
  LibreChat's native CodeAPI protocol and enforces one external non-production
  task, model/token/CodeAPI/time budgets, fixture hashing, artifact hashing, and
  credential persistence checks;
- generated assistant messages that pair every delivered file attachment with
  a matching native `execute_code` tool-call content part.

## Not Implemented

- a production wiring module or startup hook;
- a production Runtime secret source, rotation policy, or network deployment;
- an executed and recorded real non-production external CodeAPI/model-relay task;
- production feature flags, customer files, or deployment;
- Word, PPT, PDF, or additional Runtime workers.

## Run

```sh
cd services/librechat-file-agent-connector
npm run check
npm test
```

Tests route requests through the real local Runtime HTTP handler, recorded
LibreChat ports, and an in-memory Mongo contract double. They do not access a
real Mongo deployment, CodeAPI, a model relay, customer files, or the network.

The separately guarded Phase 3D acceptance uses a real temporary `mongod` and
requires external test-only dependencies outside this repository:

```sh
FILE_AGENT_PHASE3D_SCOPE=non-production \
FILE_AGENT_PHASE3D_CONFIRM=ONE_ISOLATED_NON_PRODUCTION_TASK \
FILE_AGENT_PHASE3D_MONGO_MODE=memory-server \
FILE_AGENT_PHASE3D_NODE_MODULES=/path/to/isolated/node_modules \
npm run phase3d:accept
```

`FILE_AGENT_PHASE3D_MONGO_MODE=uri` may instead use an explicitly supplied
loopback `FILE_AGENT_PHASE3D_MONGO_URI`. The command refuses remote Mongo hosts,
production scope, missing confirmation, or missing test dependencies.

The Phase 3D-B command additionally requires a clean full LibreChat tree at the
pinned upstream revision. It uses only temporary local services and refuses to
run without the explicit non-production confirmation:

```sh
FILE_AGENT_PHASE3DB_SCOPE=non-production \
FILE_AGENT_PHASE3DB_CONFIRM=FULL_ISOLATED_LIBRECHAT_ACCEPTANCE \
FILE_AGENT_PHASE3DB_UPSTREAM_ROOT=/path/to/pinned/librechat \
npm run phase3db:accept
```

Phase 3D-C is a separate external non-production gate. It requires a test-only
model key and a pre-primed CodeAPI reference for the tracked repository fixture.
The command refuses production scope, remote MongoDB, URLs containing
credentials, missing confirmation, or an unbounded route:

```sh
FILE_AGENT_PHASE3DC_SCOPE=non-production \
FILE_AGENT_PHASE3DC_CONFIRM=ONE_EXTERNAL_NON_PRODUCTION_TASK \
FILE_AGENT_PHASE3DC_KEY_SCOPE=non-production \
FILE_AGENT_PHASE3DC_MODEL_BASE_URL=https://relay.example.test \
FILE_AGENT_PHASE3DC_MODEL_API_KEY=provided-at-runtime \
FILE_AGENT_PHASE3DC_MODEL=model-name \
FILE_AGENT_PHASE3DC_MODEL_SUPPORTS_IDEMPOTENCY=false \
FILE_AGENT_PHASE3DC_CODEAPI_BASE_URL=https://codeapi.example.test \
FILE_AGENT_PHASE3DC_CODEAPI_BEARER_TOKEN=provided-at-runtime \
FILE_AGENT_PHASE3DC_CODEAPI_SESSION_ID=preprimed-session \
FILE_AGENT_PHASE3DC_CODEAPI_FILE_ID=preprimed-file \
FILE_AGENT_PHASE3DC_CODEAPI_RESOURCE_ID=test-user \
FILE_AGENT_PHASE3DC_MONGO_MODE=memory-server \
FILE_AGENT_PHASE3DC_NODE_MODULES=/path/to/isolated/node_modules \
npm run phase3dc:accept
```

The report contains only contract type, latency, usage, artifact size/hash and
idempotent delivery counts. It does not retain URLs, keys, authorization,
customer files, or raw model output.
