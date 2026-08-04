# File Agent Runtime M3 + M3.1 统一开发与发布基线

Date: 2026-08-04

Status: frozen development boundary

This document is the only planning authority for the unified M3 + M3.1 batch.
It defines the implementation boundary, candidate boundary, and production
release boundary. It does not authorize production deployment.

## 1. Why this document exists

The repository contains a reviewed M3 Word implementation, a source-only M3
candidate, a default-disabled API bootstrap, and planning material for the
broader Office Worker Suite. Those records describe different facts and must
not be treated as separate product releases.

This document consolidates them into one development batch and one customer-
visible candidate. It supersedes the release and scheduling sections of:

- `docs/FILE_AGENT_RUNTIME_M3R_PRODUCTION_INTEGRATION_PLAN.md`;
- `docs/FILE_AGENT_RUNTIME_OFFICE_M3_1_ARCHITECTURE.md`;
- `docs/FILE_AGENT_RUNTIME_OFFICE_M3_1_DEVELOPMENT_TASKS.md`.

The older documents remain technical reference material. Their statements
about separate M3-R/M3.1 release batches, or independent release authority, no
longer apply.

## 2. Repository and production facts

The following are facts, not new implementation claims:

| Item | Value |
| --- | --- |
| Reviewed M3 Word functional baseline | `a2624f8b18597e292fb83e8b2cfb71de1e1e7d9e` |
| Current repository HEAD | `31a1a1a38b088125f67cf5b6838dd6cc4753fa75` |
| Current remote state | `HEAD == origin/main` at the recorded revision |
| Existing production state | API bootstrap deployed with Runtime disabled |
| Existing production flag | `FILE_AGENT_RUNTIME_ENABLED=false` |
| Runtime production traffic | none |
| M3.1 formal profiles | not implemented: `xlsx-edit-v1`, `pptx-edit-v1`, `office-compose-v1` |
| Existing XLSX implementation | legacy POC retained for regression; not the M3.1 capability |

The existing production bootstrap and its rollback record are retained as
historical, reversible infrastructure. They are not revoked or reset. The
bootstrap is not an enabled Runtime release.

## 3. Product scope

### 3.1 M3 Word capability

M3 keeps the reviewed `word-edit-v1` contract and its v1.1 task semantics:

- one authorized DOCX input;
- deterministic inspect, transform, patch, verify, repair, and publish;
- bounded text replacement, paragraph append, and specified table-cell edits;
- independent acceptance assertions and cumulative action verification;
- restart recovery, idempotent usage and delivery, and one verified DOCX output.

M3 Word behavior is regression-protected. M3.1 must not silently change the
meaning of `office-file-agent.v1.1` or `word-edit-v1`.

### 3.2 M3.1 Office capabilities

M3.1 extends the same Runtime, Connector, Workspace, billing, recovery,
Verifier, and artifact-delivery foundation with three formal capabilities:

- `xlsx-edit-v1`: inspect and modify supported XLSX values, formulas, sheets,
  styles, tables, and basic charts, with protected-region and render checks;
- `pptx-edit-v1`: inspect and modify supported PPTX text, tables, existing
  images, slide order, and basic layouts, with relationship, render, source-
  mapping, and basic overflow checks;
- `office-compose-v1`: deterministically compose one primary PPTX from
  authorized DOCX/XLSX source facts, using registered Workers only.

The M3.1 contract may introduce `office-file-agent.v1.2`, while retaining the
M3 v1/v1.1 contracts. M3.1 must publish one primary artifact per task. It must
not use ZIP fallback or split a presentation into per-slide files.

The first M3.1 acceptance set is deliberately bounded to these compose paths:

- XLSX -> PPTX;
- DOCX -> PPTX;
- XLSX + DOCX -> PPTX.

## 4. Explicit exclusions

This batch does not include:

- M4 dynamic Script mode, arbitrary Shell, Python, or JavaScript execution;
- PDF workers or OCR-derived untrusted structure;
- legacy `.doc`, `.xls`, or `.ppt` files;
- `.xlsm`, VBA, Power Query, external data connections, or unsupported complex
  pivot objects;
- image generation, ZIP fallback, multi-Agent orchestration, or a new upload/
  file-library/billing system;
- a browser-visible task workflow UI;
- a promise of full desktop Office compatibility or pixel-identical rendering
  across arbitrary fonts and environments.

## 5. Unified production integration scope

The same batch must make all in-scope capabilities deployable through one
production integration:

1. Add one private `file-agent-runtime` Compose service with a versioned OCI
   image, internal-only port, durable task/provider-journal volume, resource
   bounds, and healthcheck.
2. Connect the API Connector to the Runtime through the internal Compose
   network. The API must preserve the native Agent path when disabled or when
   the request is unsupported or not allowlisted.
3. Load Runtime HMAC scope secrets, model credentials, and the API allowlist
   from read-only secret files. Values must not enter Git, image layers, task
   manifests, logs, or release records.
4. Add capability routing, acceptance resolution, billing snapshots, usage
   ingestion, artifact delivery, reconciliation, and recovery for Word,
   Excel, PowerPoint, and the supported Compose paths.
5. Add API + Runtime health checks, internal HMAC request checks, dependency
   checks, and disabled-mode checks without creating a customer task.
6. Add one versioned runner that snapshots and verifies the current Compose
   and replaced API sources, updates only API and Runtime, and restores both
   services and the previous Compose/source state after any failed check.

The production flag remains false during development and candidate creation.
It is enabled only during a separately authorized production release for the
allowlisted acceptance account.

## 6. Development and commit policy

This is one unified development batch, not one commit and not multiple public
releases. Developers may make several coherent commits while implementing the
batch. A later review receives one frozen final `HEAD` and the complete
focused test evidence.

Allowed commit boundaries are technical only, for example:

- shared contract/fixture and Office safety foundation;
- Excel Worker and Verifier;
- PowerPoint Worker and Verifier;
- cross-format Compose and Runtime/Connector routing;
- production Compose, secrets, health, deployment, and rollback integration;
- final regression and acceptance evidence.

These commits do not create separate release records or deployment events.
The candidate source revision is frozen only after the complete batch is
implemented, tested, and independently reviewed.

## 7. Completion evidence before candidate packaging

The unified batch is development-complete only when all of the following pass:

1. M3 Word tests and the isolated DOCX acceptance remain green with unchanged
   contract semantics.
2. `xlsx-edit-v1` replaces the old fixed-marker POC for the formal capability;
   the POC remains only as a regression fixture.
3. `pptx-edit-v1` has deterministic supported transforms, relationship/media
   checks, full-slide rendering, and basic overflow detection.
4. `office-compose-v1` has fixed fixtures and one successful result for each
   supported source combination.
5. Unsupported formats/features fail before model, file, or task side effects.
6. Disabled API mode makes no Runtime request and continues to use native
   Agent behavior.
7. Allowlisted enabled tasks prove one task, one primary verified artifact,
   one usage/delivery record, and no duplicate after API or Runtime restart.
8. Internal HMAC scope, changed request body/path, expired signature, missing
   secret, and invalid allowlist cases fail closed.
9. The dual-service runner passes Compose validation, health checks, backup,
   apply replay, and rollback replay without touching unrelated services.
10. The complete evidence is tied to the final source revision and contains no
    credentials, customer files, raw prompts, or model output.

Local listener failures caused only by the restricted test environment remain
environment limitations. They must be rerun in an allowed isolated environment
before claiming end-to-end acceptance; they are not silently counted as
business success.

## 8. Candidate and production release boundary

After development completion:

1. Freeze the final source revision and have Sol independently review that
   revision and the evidence.
2. On review approval, generate one candidate set: Runtime OCI image, scoped
   source archive, Compose/runner package, manifest, SHA-256 values, test
   report, and operator rollback instructions.
3. Commit and push the release record and candidate provenance. Stop at
   `候选版本已就绪，待上线`.
4. Do not run production preflight, deployment, restart, or customer-file
   acceptance during candidate creation.
5. Only after explicit deployment authorization run:

   `release-status -> release-preflight -> release-deploy -> release-acceptance -> release-finalize`

The final deployment runner must update the API and Runtime as a bounded unit,
verify both health endpoints and the native fallback, and automatically restore
the prior two-service state after a failed check.

## 9. Current gate

Current state is `开发暂停，统一范围已冻结，待恢复开发`.

No feature code, package, image, production preflight, or deployment is
authorized merely by this document. The next implementation action, after the
document is accepted as the source of truth, is the first unified-batch code
commit covering the shared Office contract/safety foundation and the formal
Excel capability boundary.
