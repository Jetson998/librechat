---
name: lightweight-release-governance
description: High-autonomy, rollback-aware guidance for releasing self-hosted applications. Use it to choose the smallest trustworthy path for a versioned release, production change, recovery, acceptance, or release result. Keep ordinary development outside release governance and avoid process work that does not improve safety, verification, recovery, or traceability.
---

# Lightweight Release Governance

This Skill is a decision guide and toolkit, not a universal state machine. Trust
the model to choose the implementation path. Constrain dangerous outcomes, not
the model's reasoning process.

## When to use it

- Do not invoke release governance for ordinary analysis, coding, local tests,
  or documentation.
- Use it when preparing a release artifact, changing an external runtime,
  recovering a service, accepting changed business behavior, or recording what
  was actually released.
- Batch related development and govern the batch once when it is ready.

## Required outcomes

A trustworthy release proves only what matters:

1. The project, target, intended scope, and current state are understood.
2. The change is recoverable, or an irreversible risk is explicitly accepted
   before the write.
3. The simplest trustworthy validation for this change has passed.
4. The affected business path works after the change.
5. The actual result, warnings, and recovery reference are recorded truthfully.

Everything else is conditional. Do not create gates, evidence files, builds,
or checks merely to satisfy this Skill.

## Working method

Use this shape rather than a fixed checklist:

```text
observe -> decide -> act -> verify -> record
```

- Read the project adapter once and use its existing scripts and facts.
- Confirm required access and target reachability before expensive build work.
- Freeze the release scope before producing the final artifact.
- Prefer one trusted artifact. Reuse valid build, test, preflight, or acceptance
  evidence when its revision, artifact, configuration, and assumptions match.
- Combine related read-only checks. Prefer one bounded apply over many remote
  commands.
- Resume from the last trustworthy result after a failure. Re-run only work
  invalidated by changed inputs.
- If an execution control plane does not start a command, stop retrying it and
  give the operator one exact project-owned command plus expected evidence.
- Keep detailed logs in files and return only the decision, compact evidence,
  warnings, and paths to the model context.

## Scale protection to risk

Use the least costly path that preserves the required outcomes.

- A small, reversible, single-target change normally needs an existing trusted
  artifact, a compact target check, a bounded apply, focused business
  acceptance, and a result record.
- Data, identity, permissions, billing, routing, shared infrastructure,
  difficult rollback, or uncertain impact justify stronger backup, artifact,
  locking, and acceptance evidence.
- First-time environment setup is provisioning work. Separate it from ordinary
  application releases so later releases can reuse the stable runtime.
- During an incident, restore the known-good service first when safe. Record the
  recovery, then handle the permanent fix as a separate change if needed.

Do not lower protection for high-risk writes, but do not force high-risk tools
onto ordinary changes.

## Business acceptance

Business acceptance remains part of every user-visible production decision.

- Use light acceptance for an ordinary change: cover the changed path and its
  nearest guardrail, then stop.
- Use heavy acceptance only when the affected data, identity, money, routing,
  core workflow, service coupling, or rollback risk warrants it.
- Reuse valid acceptance evidence when the relevant inputs still match.
- Do not open every page, exercise every role, or create billable or destructive
  data unless the changed path requires it.
- If acceptance fails after a write, stop further rollout and recover when the
  affected path is unsafe or critical.
- Full scans, load tests, cleanup, formatting, and unrelated health audits are
  not business acceptance. Reference them only when independently required.

## Failure and recovery

First determine whether the command started, then distinguish an execution
failure from unavailable dependencies, rejected access, state conflict,
invalid artifacts, target drift, deployment failure, acceptance failure, or
recording failure.

Use `references/failure-taxonomy.md` only when classification is unclear. Use
checkpoint and evidence tooling only when it helps resume safely; do not make
checkpoint maintenance the main task.

## Efficiency supervision

Metrics supervise the workflow; they are not release gates. When the data is
available, report:

- release execution duration;
- actual production-write attempts;
- rework count for repeated critical work;
- final result and unexpected scope changes;
- release amplification: release duration divided by development active time.

Mark amplification as estimated or unavailable when development time cannot be
reconstructed reliably. Do not add a telemetry system only to collect these
metrics.

## Project adapter boundary

The project owns concrete commands, targets, risk facts, acceptance paths, and
recovery actions. Load detailed contracts only when needed:

- `references/adapter-contract.md`: project adapter responsibilities;
- `references/evidence-contract.md`: durable evidence guidance;
- `references/failure-taxonomy.md`: failure classification;
- `references/new-project-onboarding.md`: new-project setup.

The bundled script may validate records, manifests, and checkpoints when a
project chooses to use them. It does not make those artifacts mandatory for
every release.
