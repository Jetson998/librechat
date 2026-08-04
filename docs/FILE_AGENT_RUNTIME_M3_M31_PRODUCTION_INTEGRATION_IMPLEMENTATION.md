# M3 + M3.1 production integration implementation record

Date: 2026-08-04

Status: development implementation complete for this integration slice; not
packaged, not preflighted, not deployed, and not customer-accepted.

This record belongs to the unified M3 + M3.1 batch. It does not create a new
release or split Word, Excel, PowerPoint, and Compose into separate production
events.

## Implemented source scope

The production Runtime now advertises and constructs these four profiles:

```text
word-edit-v1       -> office-file-agent.v1.1 -> file-agent-primary
xlsx-edit-v1       -> office-file-agent.v1.2 -> file-agent-primary-xlsx
pptx-edit-v1       -> office-file-agent.v1.2 -> file-agent-primary-pptx
office-compose-v1  -> office-file-agent.v1.2 -> file-agent-primary-compose
```

The Runtime production server dispatches the four deterministic CodeAPI
executors and keeps one shared task store/provider journal configuration. The
Dockerfile includes the Python Office worker dependencies and LibreOffice
rendering components used by the XLSX, PPTX, Compose, and Word verification
paths.

The API host integration now selects a profile from the authorized current-turn
Office attachments, resolves the corresponding independent acceptance
assertions, derives the v1.1/v1.2 task contract, and preserves native fallback
when the request is unsupported, ambiguous, unallowlisted, or lacks frozen
acceptance criteria.

## Production service contract

The source contract is in:

`deployment/production-patches/2026-08-04-file-agent-runtime-m3-m31-production-integration/`

It defines:

- private `file-agent-runtime` service on internal port `8790` with no host
  port, Nginx route, or browser surface;
- immutable Runtime image reference requiring `@sha256:<digest>`;
- dedicated `file-agent-runtime-data` volume for task state and provider
  journal;
- read-only API mount at
  `/opt/librechat/file-agent-runtime/connector`;
- API-to-Runtime HMAC scope secret, API allowlist file, and Runtime model API
  key as file-backed Compose secrets;
- Runtime healthcheck at `/healthz` and API internal health check at
  `http://127.0.0.1:3080/api/config`;
- API dependency on Runtime health and Runtime dependency on the internal
  CodeAPI service;
- bounded resource settings and `no-new-privileges` for the Runtime.

No secret value is present in the source, Compose template, handoff manifest,
task manifest, image build context contract, or release record.

## Apply and rollback boundary

`remote-preflight.py` is read-only and records Compose hashes, protected
container identities, CodeAPI reachability, Runtime image presence, secret and
allowlist availability, and host resources.

`remote-apply.py` performs these bounded operations:

1. rechecks the Compose and container baseline from preflight;
2. extracts a verified, symlink-free Connector source archive into a
   release-scoped directory;
3. writes a generated Compose override with API + Runtime changes;
4. recreates only `file-agent-runtime` and `api`;
5. waits for Runtime health, API running state, and both internal health
   checks;
6. verifies the Runtime has no published host port and protected services keep
   their container identities.

On any post-write failure, `remote-rollback.py` restores the previous
`compose.override.yaml`, removes a newly created Runtime container when there
was no previous Runtime service, and recreates only the prior API/Runtime
state. CodeAPI, Mongo, RAG, Nginx, and Admin are outside the runner's write and
rollback scope.

The runner requires an explicit `deployment.enable_runtime=true` handoff. Its
default source Compose contract remains disabled (`FILE_AGENT_RUNTIME_ENABLED`
defaults to `false`) until a separately authorized release supplies that
handoff.

## Development verification

The current source-level results are:

- Connector full suite: `104/104` passed;
- Runtime full suite after production multi-capability changes: `85/85`
  passed;
- Connector and Runtime `npm run check`: passed;
- production host profile/route focused suite: `4/4` passed;
- production Runtime capability/manifest focused suite: `2/2` passed;
- dual-service Compose and rollback isolated replay:
  `file_agent_dual_service_contract=passed`;
- runner shell syntax and `git diff --check`: passed.

The Python cache write attempt from the macOS sandbox was not used as evidence;
the runner test compiles each script into a temporary file and completed
successfully. No Docker build, image push, production preflight, SSH write,
deployment, restart, or customer-file request was performed.

## Remaining gate

Run the final complete regression on the frozen development tree, inspect the
worktree for unrelated files, commit and push the coherent development
changes, then give the exact revision and evidence to Sol. Stop there. Image
build, source candidate packaging, production preflight, and deployment remain
separate post-review actions.
