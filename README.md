# LibreChat Self-host

This project stores the operating documentation for the self-hosted LibreChat
deployment currently exposed at:

```text
https://152.32.172.162.sslip.io/
```

The production endpoint was checked on 2026-07-10. It returns the LibreChat
single-page application through Nginx, with public registration disabled and
email/password login enabled.

## Documentation

- [Standard operating procedure](docs/STANDARD_OPERATING_PROCEDURE.md): daily
  checks, release workflow, rollback, model/provider changes, file-upload
  handling, and incident response.
- [Development standards](docs/DEVELOPMENT_STANDARDS.md): code, patch,
  verification, security, rollback, and production deployment standards.
- [Release checklist](docs/RELEASE_CHECKLIST.md): short pre-change and
  post-change checklist for small production updates.
- [Release governance index](docs/RELEASE_GOVERNANCE_INDEX.md): complete map of
  the generic Skill, LibreChat adapter, scripts, tests, and release evidence.
- [Lightweight release governance guide](docs/LIGHTWEIGHT_RELEASE_GOVERNANCE_ZH_CN.md):
  concise Chinese instructions for preparing, verifying, deploying, and
  recording a release.
- [New project governance guide](docs/RELEASE_GOVERNANCE_NEW_PROJECT_ZH_CN.md):
  how another self-hosted project can reuse the generic protocol with a thin
  project adapter.
- [Release evidence contract](docs/RELEASE_EVIDENCE_CONTRACT.md): provider-neutral
  source, artifact, runtime, backup, acceptance, and rollback evidence fields.
- [Development and GitHub workflow](docs/DEVELOPMENT_AND_GITHUB_WORKFLOW.md):
  new-computer setup, SSH GitHub access, commit/push flow, and production gate.
- [Production verification log](docs/PRODUCTION_VERIFICATION.md): current
  externally verified facts about the live site.
- [Admin Panel deployment plan](docs/ADMIN_PANEL_DEPLOYMENT_PLAN.md): official
  Admin service architecture, repository gate, verification, and rollback.
- [Admin Panel production release](deployment/production-patches/2026-07-11-admin-panel/README.md):
  deployed image, proxy configuration, release runner, and production result.
- [Odysseia login-page release](deployment/production-patches/2026-07-17-odysseia-login-page/README.md):
  runtime login-page skin, deployment runner, verification, and rollback.
- [Admin Panel Simplified Chinese plan](docs/ADMIN_PANEL_ZH_CN_PLAN.md): pinned
  upstream source, bilingual UI design, verification, license, and rollback.
- [File pipeline simplification plan](docs/FILE_PIPELINE_SIMPLIFICATION_PLAN.md):
  the deployed `/mnt/data` upload, code execution, artifact, and download-card
  contract.
- [Independent File Agent Runtime architecture](docs/INDEPENDENT_FILE_AGENT_RUNTIME_ARCHITECTURE.md):
  approved low-coupling split for keeping chat in LibreChat while delegating
  complex Office and file tasks to an independently deployable runtime.
- [File Agent Runtime Phase 0 implementation](docs/FILE_AGENT_RUNTIME_PHASE0_IMPLEMENTATION.md):
  locally verified task state machine, idempotency, event cursor, cancel,
  steer, restart recovery, and fake adapters with no production integration.
- [File Agent Runtime Phase 3A Connector implementation](docs/FILE_AGENT_RUNTIME_PHASE3A_IMPLEMENTATION.md):
  locally verified Runtime-to-LibreChat contract, idempotent usage and artifact
  delivery, message/final ordering, and interruption recovery through recorded
  ports with no production integration.
- [Targeted Excel analysis plan](docs/OFFICE_TARGETED_EXCEL_ANALYSIS_PLAN.md):
  structure-first workbook review without unrequested full-text dump artifacts.
- [Empty response and regeneration recovery plan](docs/EMPTY_RESPONSE_REGENERATION_PLAN.md):
  generic handling for poisoned empty history, blank model completions, and
  no-content aborts.
- [Current production patch archive](deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/README.md):
  current production-mounted files, deployment history, and rollback notes.
- [Historical Office/PPT retry archive](deployment/production-patches/2026-07-09-office-ppt-empty-retry/README.md):
  the superseded empty-response retry implementation.

## Quick Health Checks

```sh
curl -k -I https://152.32.172.162.sslip.io/
curl -k -L https://152.32.172.162.sslip.io/api/config
```

Expected high-level result:

- `/` returns `HTTP/2 200`.
- `/api/config` returns `appTitle: "LibreChat"`.
- `registrationEnabled` is `false`.
- `emailLoginEnabled` is `true`.

## Operating Principle

Keep the upstream LibreChat application as the stable baseline. Custom behavior,
branding text, runtime patches, and provider configuration should remain easy to
identify, verify, and roll back.

## Production Change Gate

Production writes are not allowed until the change is represented in this
repository, committed, and pushed to `origin/main`. There is no firefighting
bypass. Read-only diagnostics may happen first, but any server file edit,
container restart, database update, static asset patch, route change, or manual
conversation/file repair must follow the gate in
[Standard operating procedure](docs/STANDARD_OPERATING_PROCEDURE.md).

Do not commit production secrets, API keys, database credentials, user exports,
or private log payloads into this project.

New governed releases use `release-governance.json` and the repository-owned
`scripts/release-*.sh` entry points. Ordinary analysis, coding, documentation,
and local testing remain outside the production-write gate.
