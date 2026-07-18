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
- `scripts/release-preflight.sh`: read-only repository and public target checks.
- `scripts/release-package.sh`: package an exact source revision and manifest.
- `scripts/release-deploy.sh`: protected, bounded deployment wrapper.
- `scripts/release-acceptance.sh`: non-billable HTTP/API acceptance checks.
- `scripts/release-status.sh`: show checkpoint state before resuming.
- `docs/RELEASE_GOVERNANCE_INDEX.md`: file map and ownership.
- `docs/LIGHTWEIGHT_RELEASE_GOVERNANCE_ZH_CN.md`: short operator guide.

## Rules

1. Use `light` mode for analysis and local documentation only.
2. Use `release` mode when producing a versioned package or release record.
3. Use `protected` or `enhanced` mode before any production write.
4. Do not use an environment variable to bypass a gate.
5. Build packages from the recorded source revision, not the current worktree.
6. Keep full logs and raw production data in evidence files, not model context.
7. Do not claim deployment success until the release record and acceptance
   evidence are complete.

The generic protocol and failure taxonomy live in
`skills/lightweight-release-governance/`. This Skill only supplies the
LibreChat adapter and its boundaries.
