# File Agent Runtime M3-R Word 生产接入开发计划

Date: 2026-08-04

Status: approved for development planning. This is a separate M3-R production
integration batch, not an authorization to package, deploy, enable customer
traffic, or send a model request.

## 1. Goal and fixed boundary

Turn the reviewed `word-edit-v1` source candidate into a deployable, reversible
production candidate without widening the product surface.

The only intended capability is:

```text
one authorized DOCX input -> word-edit-v1 -> one verified DOCX output
```

The first production configuration is disabled by default and may route only an
explicit allowlist. The allowlist value is operational configuration, not
source code. XLSX, PPTX, PDF, Office Compose, dynamic scripts, public Runtime
HTTP, a browser-visible workflow UI, and any change to CodeAPI storage are out
of scope.

## 2. Observed production baseline

The following was collected read-only from the current LibreChat host. It is
the source baseline for this batch; a changed value invalidates its production
overlay replay and requires a new source review.

| Item | Observed value |
| --- | --- |
| API container | `LibreChat-API`, image digest `sha256:3dfdcecc87a020983c2053f557c33072008a2d9e3ebf3268525e7022a7ea548b` |
| CodeAPI container | `LibreChat-CodeAPI`, image digest `sha256:dc97d2378247102a6ef9f42dbabc9698ed5e39d299179db5b356f7a2e7681b3c` |
| Shared network | `librechat_default` |
| Base Compose SHA-256 | `fdeb63fe35643bafa23300edb1877ccdc167d5341a81c1fb1580e734b951139f` |
| Override Compose SHA-256 | `0fad75bf8430bf97f2bbfe42506e8f7a52613482592461fbd7690abf9ce02ebd` |
| `/app/api/server/index.js` | `6c24bc39d97a78caaa47dfe4b8ab510dcd385254b615c7e92ac9e8e4c3381cf1` |
| `/app/api/server/controllers/agents/request.js` | `eb0ba1cb054951dcd653014753884fed9f1f1cd1d9ffcf444a749ece34df6c9f` |
| `/app/api/server/routes/agents/chat.js` | `f77d6ff5279e7b172d53bca04f85978b30ce2f4f5d2dcbceb036b46e0c4e42a3` |

The API uses a standard image plus exact bind-mounted API overlays. The current
`request.js` and `index.js` come from the deployed diagnostic-log batch. The
production integration must start from those mounted files, preserve their
Office pre-parse and initialization-failure behavior, and add no broad image
replacement.

There is no File Agent Runtime container, Compose service, production host
installer, feature flag, secret source, or deployment runner today. API and
CodeAPI are already private peers on the shared Docker network.

## 3. Target design

### 3.1 Runtime service

Add one private `file-agent-runtime` service to the existing Compose project.
It is a single replica because the current `FileTaskStore` and model-call
journal are filesystem-backed and use a process-local lock. It must:

- use a versioned Node 20 OCI image built outside production from the frozen
  Runtime source;
- expose only an internal `healthz` and Runtime API port on
  `librechat_default`; it has no host port, Nginx route, or browser CORS;
- use a dedicated durable volume for task state and provider journal, with
  restrictive ownership and no shared CodeAPI data mount;
- use `CodeApiWordExecutor` only against the existing internal CodeAPI service;
- use HMAC service-scope verification for every `/v1/*` request;
- load the model route and service-scope secret at runtime from mounted secret
  files, never from the image, Git, Compose literals, task manifest, logs, or
  MongoDB;
- fail startup when explicitly enabled configuration is incomplete, while a
  disabled API deployment keeps the native chat path available.

The production entry point replaces the development `FakeProvider` and
`FakeExecutor` bootstrap with `SingleModelAgentProvider`,
`OpenAiChatTransport`, `FileModelCallJournal`, `CodeApiWordExecutor`, and a
verified Runtime HTTP authorizer. The capability list remains Word-only.

### 3.2 API host bridge

Add a small production host installer that is loaded from the current API
overlay at startup. It may set only `app.locals.fileAgentRuntimeBridge`; it
must not alter ordinary Agent routing by default.

The installer will compose the existing Connector with actual LibreChat native
ports, Mongo collections, Runtime client, HMAC signer, a periodic reconciler,
and a frozen allowlist. It must install before the agent chat router handles
requests. The route overlay passes the explicit app-local bridge to
`AgentController`; when the bridge is absent, disabled, unsupported, or the
user is not allowlisted, the original single native Agent call remains the
only execution path.

The controller overlay must be rebuilt from the three pinned production files,
not from the older non-production `60eba...` upstream overlay. In particular,
it must retain the deployed initialization-failure persistence and
`officePreparseSignal` behavior while adding the File Agent handoff branch.

### 3.3 Data, secrets, and rollback

Create dedicated Mongo collections for delivery, frozen billing snapshots, and
active task references. Index creation is idempotent and occurs only after a
successfully enabled host installer starts. Existing LibreChat collections and
CodeAPI storage remain untouched.

The two shared service secrets are mounted as read-only files:

```text
API -> Runtime HMAC scope secret
Runtime -> model relay route secret/configuration
```

The deployment patch contains only file paths and validation rules, never
their values. The primary rollback is disable the feature, recreate only the
Runtime and API services, and restore the prior Compose override and three API
overlay files from the bounded deployment backup.

## 4. Development milestones

| Milestone | Deliverable | Required completion evidence | Status |
| --- | --- | --- | --- |
| R0 | Exact source/Compose manifest and this plan | Read-only baseline digests; no production write | complete |
| R1 | Runtime production bootstrap, config parser, Dockerfile, health and HMAC tests | Invalid configuration fails closed; Word-only capabilities; no secret output | next |
| R2 | Current-API host installer and source overlay replay | Native request remains byte-for-byte equivalent when disabled; existing Office/diagnostic regression fixtures pass | pending |
| R3 | Versioned Compose patch, preflight, apply, rollback and acceptance runners | Only `LibreChat-API` and `file-agent-runtime` are eligible targets; rollback replay tested | pending |
| R4 | Frozen development candidate | Runtime/Connector/overlay tests, isolated DOCX replay, source manifest, independent review | pending |
| R5 | Separately authorized production candidate | OCI attestation, fresh target preflight, one allowlisted DOCX acceptance, recorded rollback evidence | blocked until R4 approval |

## 5. Verification contract

Before a production candidate can be created, the development batch must prove:

1. disabled mode performs no Runtime HTTP request, creates no delivery,
   billing snapshot, task, transaction, file, or Assistant sibling;
2. unallowlisted, normal-chat, unsupported-file, multi-file, malformed DOCX,
   and ambiguous instructions all stay on the native path before user-turn
   persistence;
3. an enabled allowlisted DOCX task creates one Runtime task, one immutable
   billing snapshot, and at most one visible verified DOCX; replay and API or
   Runtime restart create neither duplicate model usage nor duplicate file,
   message, transaction, final event, or job completion;
4. the Runtime accepts only internally networked HMAC-scoped requests; changed
   path, body, idempotency key, expired signature, or missing signature fails
   before task submission;
5. the Runtime container cannot expose a host port, use a production shell
   mount, access CodeAPI data directly, or emit route credentials;
6. the deployment runner snapshots the current Compose and all replaced API
   overlays, verifies their digests immediately before apply, recreates only
   the selected services, and restores the snapshots on any failed check.

Production acceptance remains a later release-stage operation. It requires an
explicit deployment authorization and exactly one controlled Word task for the
allowlisted account; it is not performed while implementing this plan.

## 6. Stop conditions

Stop the batch and return to design review if any of the following is true:

- the active API source, Compose digest, image ABI, or native-port contract no
  longer matches the R0 manifest;
- preserving the current Office pre-parse/diagnostic behavior requires an
  unreviewed merge or an API image replacement;
- Runtime durability requires modifying existing CodeAPI storage or exposing
  the Runtime publicly;
- a secret, user file, full prompt, model output, or production endpoint must
  enter Git, an image layer, a task manifest, or the release record;
- native fallback cannot be proven before durable File Agent acceptance; or
- the first production validation would require more than the one approved,
  allowlisted DOCX task.

## 7. Explicitly deferred work

M3.1 Excel, PowerPoint, Office Compose, multiple outputs, task-status UI and
M4 controlled scripting remain separate product-development tracks. They do
not delay R1-R4 and must not be added to the M3-R production integration
candidate.
