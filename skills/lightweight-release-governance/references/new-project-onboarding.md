# New Project Onboarding

Use this guide when a repository adopts the generic release protocol for the
first time. The generic layer defines what must be proved. The project adapter
defines how that repository proves it.

## Minimal adoption path

1. Select the least restrictive initial mode. Start with `light` for local
   work or `release` for packaging. Do not enable an external write until the
   `protected` adapter path has been implemented and tested.
2. Copy `assets/project-adapter-template/` into the project root.
3. Replace the project id and name in `release-governance.json`.
4. Implement the repository-owned scripts. Keep read-only checks separate from
   apply or deploy commands, and make every unfinished command fail closed.
5. Add the project's required package paths, accumulated-path selection rules,
   acceptance checks, rollback behavior, and evidence locations.
6. Add contract tests that prove required files exist, scope is bounded,
   unfinished commands fail, and protected mode cannot skip a gate.
7. Run a local `release` dry-run through record creation, repository checks,
   packaging, attestation, and final recording before testing `protected` mode.

## Recommended project layout

```text
release-governance.json
scripts/
  project-release-adapter.sh
  release-prepare.sh
  release-verify.sh
  release-package.sh
  release-attest.sh
  release-preflight.sh
  release-deploy.sh
  release-acceptance.sh
  release-finalize.sh
  release-status.sh
  validate-release-governance.sh
tests/release-governance/
deployment/release-records/
.release-state/
```

Commit the configuration, scripts, tests, and final release records. Ignore
`.release-state/`; it contains temporary checkpoints, logs, and artifacts.

## Adapter responsibilities

The adapter should answer these questions deterministically:

- Which project, revision, target, and scope are being released?
- Which accumulated paths select builds, tests, targets, backup conditions, and
  light or heavy acceptance for this batch?
- Is the repository state compatible with the recorded source revision?
- Are all files needed for remote verification present in the package?
- What read-only target snapshot proves the write is safe to begin?
- What exact command performs the bounded change?
- What backup or rollback reference exists before that command runs?
- What acceptance check proves the intended result without unnecessary cost or
  destructive data?
- Where are checkpoints, detailed evidence, and the final release result kept?

## Project-type substitutions

Keep the state machine and evidence fields. Replace only the adapter details:

| Project type | Target preflight | Apply gate | Acceptance gate |
|---|---|---|---|
| Web application | Read-only page and API checks | Bounded service or asset update | Page and API smoke checks |
| API service | Health, version, and dependency checks | Versioned service rollout | Contract and health checks |
| Static site | Existing asset and routing snapshot | Publish immutable assets | Page and resource checks |
| Command-line tool or library | Package and test evidence | Registry or distribution publish | Install and command regression |
| Data migration | Compatibility, backup, and lock checks | Versioned migration | Data integrity and restore proof |
| Function platform | Current version and traffic snapshot | Version or alias update | Invocation and rollback checks |
| Mobile application | Build and signing evidence | Distribution submission | Install, launch, and key-flow checks |

If a gate does not apply to a project type, declare that outcome in the
project configuration and require a recorded reason. Do not improvise a
per-run bypass.

## First acceptance milestone

The first implementation is ready for use only when:

- configuration validation passes;
- every adapter command either works or fails closed with a clear category;
- a package is built from an exact source revision;
- a changed input invalidates dependent checkpoints;
- a simulated failure can still produce a terminal release record;
- no protected write can run before repository, artifact, preflight, and
  rollback evidence are valid.

After that milestone, ordinary development remains lightweight. Run the full
protected path only once a related batch is ready for an external runtime write.
