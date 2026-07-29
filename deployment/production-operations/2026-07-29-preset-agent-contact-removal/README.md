# Preset Agent Contact Removal Operation

Date: 2026-07-29

Design gate:
`docs/PRESET_WORKFLOW_AGENT_CONTACT_REMOVAL_PLAN.md`

## Objective

Remove `support_contact` from the seven managed preset Workflow Agents so the
Agent details no longer show `联系: LibreChat Workflow Agent`.

This operation writes only the seven target documents in `db.agents`. It does
not write Agent ACLs, categories, users, Skills, files, conversations, messages,
or any other collection. LibreChat's generic support contact capability remains
available to personal Agents.

## Target Guard

The operation requires all seven stable Agent IDs and
`managedBy=librechat-preset-workflow-agents`. Before updating a document it
verifies the stored drift digest and proves that the only catalog differences
are removal of the exact legacy contact and the resulting source Agent digest.

## Apply

The update:

- unsets the top-level `support_contact` field;
- advances `workflowTemplate.sourceAgentDigest` and `persistedDigest`;
- appends one contact-free Agent version snapshot;
- increments `__v` and updates `updatedAt`;
- leaves all other current Agent fields unchanged.

The remote runner signs a read-only target snapshot, verifies the snapshot and
protected container identities immediately before the write, saves a targeted
backup under `/opt/librechat/backups/preset-agent-contact-removal-*`, and checks
that ACLs and categories are byte-for-byte unchanged after the write.

## Rollback

Rollback replaces only the seven target Agent documents with their exact
preflight EJSON documents. It then requires the complete target snapshot digest
to match the preflight digest. No service is restarted.

## Local Verification

```sh
python3 deployment/production-operations/2026-07-29-preset-agent-contact-removal/scripts/test-release.py
scripts/validate-release-governance.sh
git diff --check
```
