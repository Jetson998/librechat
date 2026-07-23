# LibreChat File Agent Connector

This package contains the Phase 3A local contract POC, Phase 3B native host
adapters, and the Phase 3C non-production controller bridge for the independent
File Agent Runtime. It uses Node.js built-in modules only and has no production
entry point.

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

## Not Implemented

- a production wiring module for concrete LibreChat imports or collections;
- concrete route registration that injects the controller bridge into the
  running LibreChat process;
- a production Runtime secret source, rotation policy, or network deployment;
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
