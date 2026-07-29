# Preset Workflow Agents Market Operation

Date: 2026-07-29

Status: implementation candidate; production data unchanged

Design gate:
`docs/PRESET_WORKFLOW_AGENTS_MARKET_RELEASE_PLAN.md`

## Objective

Publish the seven reviewed Workflow Agent templates into the existing LibreChat
Agent marketplace without a frontend hardcode, a second workflow service, or an
unrecorded MongoDB command.

The operation:

- compiles seven versioned manifests into stable LibreChat Agent records;
- assigns the existing `admin` account as the system owner at runtime;
- grants one owner ACL and one PUBLIC viewer ACL per Agent;
- marks all seven Agents as promoted;
- places all seven under the active `automation-workflow` category;
- deactivates only the seven non-custom upstream default categories;
- never edits personal Agents, Skills, files, conversations, model settings, or
  unrelated ACL entries.

## Runtime Contract

The first engine profile is `librechat-native-agent-v1`. It uses the production
Agent endpoint and its existing `execute_code`, `file_search`, and `web_search`
capabilities. It does not claim that the non-production File Agent Runtime,
workflow checkpoint recovery, or scheduled triggers are active.

Source manifests and the deterministic compiled catalog are under:

```text
workflow-templates/preset-agents/
```

Stable Agent IDs:

```text
workflow_meeting-to-action
workflow_knowledge-base-curator
workflow_excel-audit-reconciliation
workflow_policy-change-impact
workflow_feedback-root-cause-analysis
workflow_kyc-periodic-review
workflow_journal-entry-audit
```

## Read-only Preflight

`scripts/collect-preflight.sh` copies only the catalog and read-only inspection
code to a temporary server directory. The remote preflight:

- verifies the compiled catalog digest;
- snapshots the exact target Agent, ACL, and category documents as canonical
  Extended JSON;
- resolves `admin`, `agent_owner`, and `agent_viewer` without hardcoded ObjectIds;
- rejects unmanaged stable-ID conflicts or unexpected ACLs;
- verifies the configured provider, model, and Agent capabilities;
- records all protected container identities, host resources, and public health;
- reports `write_operations: []`.

The target snapshot is the rollback source and the apply drift lock.

## Apply

`scripts/deploy.sh` is the only supported write entry point. The release runner
declares:

```text
release-governance:targets=chat-mongodb
```

Before the first Mongo write, the remote apply repeats the target snapshot and
requires its SHA-256 plus every protected container identity to equal the signed
preflight. It then creates a timestamped backup under:

```text
/opt/librechat/backups/preset-workflow-agents-<source>-<timestamp>/
```

The seed script performs stable-ID upserts, rejects edits outside the managed
release, and verifies all seven Agent and ACL records after the write. It does
not restart or recreate any container.

If seed or post-write verification fails, apply immediately runs the targeted
rollback and requires the original target snapshot digest before returning a
failure.

## Rollback

`scripts/rollback.sh <backup-dir> <local-result.json>` invokes the versioned
rollback stored in the selected backup directory. It:

- deletes only the seven stable Agent IDs and their target ACLs;
- restores any pre-existing target Agents and ACLs from the backup;
- restores only the eight related category values;
- preserves all unrelated Agents, Skills, files, conversations, users, and ACLs;
- verifies the exact preflight target snapshot digest;
- restarts no service.

## Acceptance

Data acceptance must prove:

- exactly seven target Agents exist;
- each is promoted and uses `automation-workflow`;
- each has one system owner ACL and one PUBLIC viewer ACL;
- the default non-custom categories are inactive;
- protected container identities did not change;
- public root, API config, Admin, and Office Converter boundary remain healthy.

Browser acceptance with `vip998` must then prove the Agent workspace shows all
seven cards, removes the unwanted HR/R&D/Finance/IT/Sales/After-sales tabs, opens
a selected Agent in a new conversation, and does not expose edit/delete controls
to the normal user.

## Local Verification

```sh
python3 deployment/production-operations/2026-07-29-preset-workflow-agents/scripts/test-release.py
scripts/validate-release-governance.sh
git diff --check
```
