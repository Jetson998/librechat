---
name: lightweight-release-governance
description: Lightweight release workflow and rollback-first governance for self-hosted applications. Use when a project needs a baseline, change record, validation entry point, traceable artifacts, release evidence, rollback planning, resumable gates, or a stricter protection mode before an external runtime write. Keep ordinary analysis, coding, and documentation work lightweight.
---

# Lightweight Release Governance

Use this skill as a small release and recovery toolkit, not as a replacement for
the project's development process, CI platform, monitoring, or secret manager.

## Operating modes

Select the least restrictive mode that matches the task:

- `light`: analysis, local coding, documentation, or local experiments. Do not
  invoke production gates.
- `release`: prepare a versioned change or artifact. Require a target, baseline,
  change record, validation, rollback plan, and traceable source/artifact data.
- `protected`: any external runtime write, service restart, configuration/data
  mutation, or deployment. Add read-only target preflight, bounded scope,
  rollback evidence, risk-adaptive business acceptance, and a release result.
- `enhanced`: high-risk changes such as shared infrastructure, migrations, or
  concurrent releases. Add heavy business acceptance, immutable artifact
  attestation, deployment locking, strict input fingerprints, and automatic
  rollback evidence.

Never use an ad-hoc environment variable to skip a gate. A gate may be
`not_applicable` only when the project adapter declares that outcome for the
selected mode and records a reason.

## Required sequence

The generic protocol is:

```text
prepare -> preflight_permissions -> repository_gate -> package_manifest
         -> ci_attestation_gate -> target_preflight -> apply_gate
         -> acceptance_gate -> release_record
```

Project adapters may declare a gate `not_applicable`, but they must preserve the
order of all applicable gates. A failed or blocked gate stops the write path.

1. Confirm project, repository, revision, environment, and scope.
2. Run the adapter's read-only capability check before relying on a command,
   remote reference, credential, or external dependency.
3. Capture a known-good baseline or an explicit baseline reference.
4. Record the intended change, expected behavior, risk, verification, and
   rollback action.
5. Run read-only repository and target checks before any external write.
6. Build artifacts from an exact source revision, never from an uncommitted
   working tree.
7. Verify the build or artifact proof using the provider-neutral evidence
   contract supplied by the project adapter.
8. Apply only the bounded, versioned change after the protected gates pass.
9. Run the adapter's `acceptance_gate`. Business acceptance remains part of
   release governance whenever user-visible or business behavior can change;
   select a light or heavy level from the affected path and risk instead of
   applying a fixed test list. Do not create billable or destructive test data
   unless the release explicitly requires it.
10. Write an immutable release result and keep detailed evidence in files rather
   than injecting full logs into model context.

## Business acceptance

Business acceptance is a decision gate, not a requirement to rerun every test,
open every page, or exercise every role. The project adapter identifies its
critical business paths; this Skill supplies the selection rules.

Use **light acceptance** by default for ordinary releases:

- cover only the changed business path and its nearest guardrail;
- reuse valid CI, candidate-environment, or prior evidence when the source
  revision, artifact, configuration, and assumptions are unchanged;
- run a small, bounded smoke check after an external write;
- do not use a browser for a non-UI change or send a model request when the
  model/tool path is unaffected.

Use **heavy acceptance** when the change affects data structure or migration,
authentication or permissions, billing or quotas, model routing, a core file
pipeline, multiple services, a difficult-to-reverse behavior, or a major
version upgrade. The adapter may also select heavy acceptance when the impact
is uncertain and the rollback is weak.

The absence of a dedicated test environment is not a reason to abandon
acceptance. Use the least risky available evidence source: CI, a temporary
environment, a maintenance-window check, or a targeted production smoke. An
irreversible change must not be first tested in production.

Acceptance evidence should state the selected level, reason, affected scope,
result, warnings, evidence location, and whether release may continue. It may
reference existing test or operational evidence; it does not need to copy full
logs into the model context.

If acceptance fails before a write, stop the write. If it fails after a write,
stop further rollout, preserve evidence, and roll back when the affected path
is unsafe or critical. Never retry a mutating test blindly. Server cleanup,
full security scans, load tests, formatting, and unrelated service audits are
not business acceptance; record or reference their independent results only
when the release needs them.

## Resource and context limits

Keep the model's role bounded. Deterministic adapter code should batch checks,
apply timeouts, cap retries, and write detailed results to evidence files. The
model should receive a compact summary, warnings, decision, and paths. Do not
build a complete test environment on the target host, poll a workflow in a
loop, or call tools repeatedly for checks that one structured result can cover.

## Failure handling

First determine whether the attempted command actually started. Keep these
cases separate:

- `execution_not_started`: the execution control plane did not start it.
- `execution_failed`: the command started and returned an error.
- `dependency_unavailable`: a required tool, network, or external service was
  unavailable.
- `authentication_failed` / `authorization_failed`: credentials or scope were
  rejected.
- `state_conflict`: a concurrent or incompatible state prevented the action.
- `artifact_invalid` / `attestation_failed`: the produced proof or artifact is
  incomplete or inconsistent.
- `target_drift`: the target changed after a previous gate passed.
- `deployment_failed` / `acceptance_failed` / `recording_failed`: later-stage
  failures with their own recovery evidence.

Use `scripts/release_gate.py classify-failure` for a stable category and keep
provider-specific details in the evidence file. Do not turn an approval,
network, or authentication failure into a code diagnosis without proof.

## Checkpoints and recovery

Store checkpoints outside the tracked source tree while a release is running.
Each passed gate records an input fingerprint. On resume:

1. Load the last checkpoint.
2. Recompute the fingerprints of the affected inputs.
3. Mark changed gates and all dependent gates `invalidated`.
4. Resume from the first invalidated gate.

Never restart from the beginning merely because a later gate failed, and never
continue past an invalidated gate.

## Project adapter contract

The project owns the concrete commands and paths. Read the adapter's contract
before running a release:

- configuration identifies the project, repository, modes, required files, and
  adapter commands;
- scripts implement repository checks, target preflight, scoped application,
  and acceptance;
- the adapter identifies critical business paths, risk triggers, reusable
  evidence, automated checks, and cases that need human confirmation;
- the release record uses provider-neutral fields such as `source_revision`,
  `build_attestation`, `artifact_digest`, `runtime_snapshot`,
  `backup_reference`, and `acceptance_result`.

Do not put provider-specific assumptions in this Skill. Load the project's
adapter references only when the task enters `release` or `protected` mode.

When onboarding a new project, read
`references/new-project-onboarding.md` and start from the fail-closed files in
`assets/project-adapter-template/`. Replace the adapter behavior with
project-owned checks before allowing any external write.

## Daily command surface

Keep the operator-facing path small. A project should normally expose:

```text
prepare -> verify -> preflight -> deploy -> accept -> record
```

The scripts may perform many deterministic checks internally, but they should
return a compact summary, machine-readable evidence path, and a non-zero exit
status on a blocked gate.
