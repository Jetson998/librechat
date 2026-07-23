# LibreChat File Agent Connector

This package is the Phase 3A local contract POC between LibreChat and the
independent File Agent Runtime. It uses Node.js built-in modules only and has no
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

## Not Implemented

- Mongo-backed delivery records or multi-replica leases;
- real `prepareStructuredTokenSpend()` or `bulkWriteTransactions()` calls;
- real `processCodeOutput()`, message persistence, or GenerationJobManager;
- production service authentication or signed task scopes;
- production feature flags, customer files, or deployment;
- Word, PPT, PDF, or additional Runtime workers.

## Run

```sh
cd services/librechat-file-agent-connector
npm run check
npm test
```

Tests route requests through the real local Runtime HTTP handler and use
recorded LibreChat ports. They do not access Mongo, CodeAPI, a model relay, or
the network.
