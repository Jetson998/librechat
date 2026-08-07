# Production integration facts

This is a non-secret fact sheet for the integration environment. It must never
contain API keys, HMAC values, Authorization headers, cookies, passwords, or
customer file contents.

Status vocabulary:

```text
observed       directly checked in the current target environment
repo-derived   derived from versioned source/release records
not_run        requires a target-environment check that has not happened
blocked        cannot be checked because required external input/access is absent
```

## Repository-derived facts

| Fact | Value | Status | Source |
|---|---|---|---|
| Repository | `/Users/jets2026/Documents/Codex/LibreChat` | repo-derived | current checkout |
| Frozen Runtime/Connector source revision | `35321db548412f3b36e997937a74f5ecae8acb05` | repo-derived | integration Runtime input |
| API base image | `registry.librechat.ai/danny-avila/librechat-dev-api@sha256:3dfdcecc87a020983c2053f557c33072008a2d9e3ebf3268525e7022a7ea548b` | repo-derived | integration env example |
| API logical service | `LibreChat-API` | repo-derived | production records |
| API overlay source revision | `eaa07d9142783a33931d3f3d131449120a8b7590` | repo-derived | `config/api-overlay-manifest.json` |
| File Agent API overlay files | `index.js`, `controllers/agents/request.js`, `routes/agents/chat.js`, `services/FileAgentRuntime.js` | repo-derived | overlay manifest |
| API mounted baseline dependencies | `models/index.js`, `controllers/agents/InitializationFailure.js`, `routes/index.js`, `routes/admin/diagnosticEvents.js`, `services/DiagnosticEvents.js` | repo-derived | overlay manifest and existing production patch source manifests |
| Host installer | `installFileAgentRuntimeHost()` | repo-derived | overlay API index |
| Bridge app-local slot | `app.locals.fileAgentRuntimeBridge` | repo-derived | overlay controller/route |
| Agent route injection | `req.app.locals.fileAgentRuntimeBridge` to Agent controller | repo-derived | overlay chat route |
| Integration CodeAPI URL | `http://codeapi:8000` | repo-derived | `compose.integration.yaml` |
| CodeAPI request path | `POST /exec` | repo-derived | transport contract |
| CodeAPI request fields | `lang`, `code`, `session_id`, `files` | repo-derived | transport contract |
| Forbidden legacy fields | `item_id`, `command`, `injected_files`, `artifact_paths`, `timeout_ms` | repo-derived | transport contract |
| Input identity fields | `resource_id`, `storage_session_id`, `file_id`, `name`, `kind` | repo-derived | transport contract |
| Provider route reference | `custom:Muskapis-openai` | repo-derived | route registry |
| Provider endpoint identity | `Muskapis-openai` | repo-derived | route registry |
| Provider protocol | `openai-compatible` | repo-derived | route registry |
| Allowlisted models | `gpt-5.6-sol`, `claude-fable-5` | repo-derived | route registry |
| Integration Admin image | `ghcr.io/jetson998/librechat-admin-panel-zh-cn:ca5aa4c17881` | repo-derived | `.env.integration.example` |
| Integration Admin platform | `linux/amd64` | repo-derived | `compose.integration.yaml` and image gate |
| Integration Admin/API boundary | Admin uses `http://api:3080`; browser API uses `http://127.0.0.1:3081` | repo-derived | `compose.integration.yaml` |
| Integration permanent test identities | one `ADMIN` user selecting both approved models | repo-derived | provisioning and Admin smoke scripts |

## Target facts still required

These items are deliberately not claimed from repository inspection:

| Fact | Status | Required evidence |
|---|---|---|
| Production API image, digest and Compose service name | not_run | read-only target host/Compose inspection |
| Production CodeAPI service and image | observed | read-only production Docker inspection: `LibreChat-CodeAPI`, `local/librechat-codeapi:office` |
| Production CodeAPI image ID and platform | observed | read-only production Docker inspection: `sha256:dc97d2378247102a6ef9f42dbabc9698ed5e39d299179db5b356f7a2e7681b3c`, `linux/amd64` |
| Controlled CodeAPI OCI export SHA-256 | observed | local operator export, `778e85a220595d15f5ca9eec3fb286ea2a43da98f909cf737bc5d89d804e10d7` |
| Production CodeAPI internal address and auth mode | not_run | read-only target Compose/runtime inspection; no secrets |
| Actual production `/exec` request/response | not_run | authenticated redacted CodeAPI observation |
| LibreChat upload/artifact storage relationship | not_run | one authorized test-file trace |
| Production Admin endpoint identity and protocol | not_run | read-only production Admin configuration review |
| Whether both approved models use one relay | not_run | endpoint config or redacted request evidence |
| Internal userId corresponding to `vip998` | blocked | authorized read-only production lookup |

No production credentials, sessions, customer files, or real model requests
belong in this document. The integration environment uses generated test
secrets and a local Fake Relay only. The integration Admin Panel can read and
write disposable API/Mongo configuration, but its visible Fake Relay endpoint
is not production endpoint evidence and does not prove real provider traffic.

The CodeAPI image was exported with a read-only `docker save` operation and
loaded locally. No production container was restarted or rebuilt; no
production volume, customer file, runtime secret, or container environment was
read.
