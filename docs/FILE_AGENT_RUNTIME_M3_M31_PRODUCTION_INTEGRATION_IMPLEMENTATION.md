# M3 + M3.1 production integration implementation record

Date: 2026-08-04

Status: development remediation complete for this integration slice; awaiting
Sol re-review. It is not packaged, not preflighted, not deployed, and not
customer-accepted.

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

## Capability closure matrix

Each frozen M3/M3.1 capability has a route, independent acceptance contract,
deterministic Worker operation, Verifier assertion, and positive/negative
fixture. The acceptance resolver runs only after the profile has been selected
by `resolveOfficeTaskIntent`; a resolver cannot select a profile by succeeding
accidentally.

| Capability | Connector/profile | Worker and Verifier contract | Evidence |
| --- | --- | --- | --- |
| Word edit | DOCX -> `word-edit-v1` | text replacement, paragraph/table edits, cumulative ledger, independent Word assertions | Word positive, wrong-occurrence, ignored-requirement, and unsafe-workspace fixtures |
| Workbook edit | XLSX -> `xlsx-edit-v1` | cell value/formula, sheet add/delete/rename/order, number format/style, Excel Table, bar/line chart | XLSX positive and unauthorized formula/protected-cell/unsupported-OOXML fixtures |
| Presentation edit | PPTX -> `pptx-edit-v1` | text/table edits, append/delete/reorder slides, existing-image preservation, render and source-shape checks | PPTX positive, contradictory-delete, unauthorized-change, stale-hash, and unsupported-OOXML fixtures |
| Office Compose | DOCX/XLSX (one or two sources) -> `office-compose-v1` | bounded source facts, structured title/section/data/conclusion/source pages, tables/charts, complete source mappings, one PPTX | XLSX->PPTX, DOCX->PPTX, XLSX+DOCX, false-chart, source-integrity, and render fixtures |

The negative fixtures fail closed when the instruction contains an unsupported
action, an unconsumed quoted requirement, multiple output intents, an
unauthorized source/location, a contradictory assertion, or a stale artifact
hash.

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
- the Connector archive contains the complete production `src/` tree and the
  canonical shared acceptance contracts at
  `src/acceptance-contracts/`; the API never imports acceptance code from the
  Runtime container's filesystem;
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
2. verifies the handoff's pre-generated deterministic Connector source archive,
   then extracts it symlink-free into a release-scoped directory;
3. writes a generated Compose override with API + Runtime changes;
4. recreates only `file-agent-runtime` and `api`;
5. waits for Runtime health, API running state, and both internal health
   checks;
6. verifies the Runtime has no published host port and protected services keep
   their container identities. LibreChat-API is intentionally excluded from
   the protected identity set because this deployment unit is allowed to
   recreate it; its image, feature flag, health, Connector mount, and native
   fallback are checked instead.

On any post-write failure, `remote-rollback.py` restores the previous
`compose.override.yaml`, removes a newly created Runtime container when there
was no previous Runtime service, and recreates only the prior API/Runtime
state. It verifies the original API image ID/reference, feature flag,
Connector mount, native route, and—when a Runtime already existed—the original
Runtime image and healthy state. CodeAPI, Mongo, RAG, Nginx, and Admin are
outside the runner's write and rollback scope.

The enabled apply path uses the candidate Connector and Runtime health/request
probe. A first-enable rollback restores a disabled/no-Runtime baseline and uses
an independent API-only baseline probe; it does not import the candidate
Connector or contact the Runtime URL. When a Runtime already existed, rollback
resolves the recreated container through `docker compose ps -q
file-agent-runtime` before checking its image and health, rather than assuming
the Compose service name is a container name.

The Connector archive and its manifest are produced during the later candidate
packaging step by `package-connector-archive.py`. `remote-apply.py` does not
produce a new archive; it validates the handoff digest and file manifest, then
performs safe extraction only.

The runner requires an explicit `deployment.enable_runtime=true` handoff. Its
default source Compose contract remains disabled (`FILE_AGENT_RUNTIME_ENABLED`
defaults to `false`) until a separately authorized release supplies that
handoff.

## Development verification

The current source-level results are:

- Connector full suite: `112/112` passed serially;
- Runtime full suite after production multi-capability changes: `97/97`
  passed serially;
- strict Provider schema includes every XLSX and PPTX Action parameter and
  uses profile-specific reorder types;
- PPTX resolver covers append/delete/reorder and the Verifier checks existing
  image hashes as well as text/table preservation. Slide copy is explicitly
  outside the M3.1 contract because the prior implementation could lose Office
  relationships and formatting;
- Python Office dependencies and APT packages are recorded in
  `services/file-agent-runtime/requirements.lock` and
  `services/file-agent-runtime/apt-packages.lock`; the Dockerfile uses
  `--require-hashes`, a digest-pinned Node base image, and a fixed Debian
  snapshot source. The three LibreOffice packages are locked to
  `4:7.4.7-1+deb12u13`, and
  `deployment/production-patches/2026-08-04-file-agent-runtime-m3-m31-production-integration/scripts/verify-apt-snapshot.py`
  parses the declared amd64 `Packages` indexes and checks the exact package
  versions. It deliberately does not claim to solve the transitive APT
  transaction; native `apt-get install` during the authorized Docker build is
  the authoritative dependency-resolution evidence;
- the production Connector archive is generated by
  `scripts/package-connector-archive.py` and replayed through
  `safe_extract_connector()` before importing the extracted
  `production-host-integration.js`;
- XLSX rename is independently asserted and formula/protected-cell checks
  follow the frozen sheet identity across the rename;
- Connector and Runtime `npm run check`: passed;
- production host profile/route focused suite: `4/4` passed;
- production Runtime capability/manifest focused suite: `2/2` passed;
- dual-service Compose and rollback isolated replay:
  `file_agent_dual_service_contract=passed`;
- Sol rejection regressions, including real archive import and rollback
  baseline/health failures: `sol_rejection_tests=passed`;
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
