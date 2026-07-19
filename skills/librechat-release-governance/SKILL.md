---
name: librechat-release-governance
description: Repository-owned release adapter for the self-hosted LibreChat project. Use when preparing, validating, deploying, accepting, rolling back, or recording a LibreChat change. Keep the work strictly inside the LibreChat repository and use its release-governance.json and scripts instead of copying generic governance rules into prompts.
---

# LibreChat Release Governance

Treat `/Users/jets2026/Documents/Codex/LibreChat` as the only project scope for
this Skill. Do not mix WebAI, OpenWebUI, or another application's files,
services, routes, or release records.

## Entry points

Read these files before a release task:

- `release-governance.json`: project adapter contract and risk modes.
- `scripts/release-prepare.sh`: create a release record and state directory.
- `scripts/release-preflight.sh`: validate one project-produced read-only target
  snapshot plus path-selected public checks.
- `scripts/release-package.sh`: package an exact source revision and manifest.
- `scripts/release-deploy.sh`: protected, bounded deployment wrapper.
- `scripts/release-acceptance.sh`: path-selected public and business acceptance
  evidence, with at most one billable model request when explicitly selected.
- `scripts/release-status.sh`: show checkpoint state before resuming.
- `docs/RELEASE_GOVERNANCE_INDEX.md`: file map and ownership.
- `docs/LIGHTWEIGHT_RELEASE_GOVERNANCE_ZH_CN.md`: short operator guide.
- `references/project-contract.md`: LibreChat critical business paths and
  acceptance-selection guidance.

## Rules

1. Keep daily feature development in `light`: normal Git commits and focused
   tests, without creating one release per AI task.
2. Use `release` when a related batch is ready to package without touching
   production.
3. Use `protected` or `enhanced` once when a related batch is ready for a
   production write. `release-verify` resolves the accumulated scope through the
   repository path rules and writes one plan under `.release-state/`.
4. Do not use an environment variable to bypass a gate.
5. Build packages from the recorded source revision, not the current worktree or
   production server. Production batches require CI or independent-build
   evidence for the requirements selected by the plan.
6. Keep full logs and raw production data in evidence files, not model context.
7. Do not claim deployment success until the release record and acceptance
   evidence are complete.
8. Keep business acceptance in every production release decision, but select
   light or heavy coverage from the actual changed path. Public HTTP checks are
   technical smoke evidence and do not automatically prove the business path.
9. Reuse valid evidence for the same source revision and artifact. Do not open
   every page, test every role, or send a model request unless the affected
   LibreChat path requires it.

The generic protocol and failure taxonomy live in
`skills/lightweight-release-governance/`. This Skill only supplies the
LibreChat adapter and its boundaries.
