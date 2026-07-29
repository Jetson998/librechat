# Preset Agent Contact Visibility Production Release

Date: 2026-07-29

Status: verified Client candidate; production deployment pending.

## Objective

Hide the entire contact row for exactly seven system-managed preset Workflow
Agents. Keep support contact, owner fallback, and no-contact behavior unchanged
for personal Agents and every Agent outside the exact stable-ID allowlist.

The shared `AgentContact` component is used by Agent market cards, Agent detail,
and the new-conversation welcome view, so one bounded source correction covers
all three user-facing surfaces.

## Immutable Inputs

- repository Client source commit:
  `b87a1f3da70f2a354d8cbb58f2a87007ec58804b`;
- LibreChat upstream commit:
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`;
- Agent P0 UI patch SHA-256:
  `00fc078859275611b717e34bd3a0fda4c44d08db1412b6df9e8735d27d0777bc`;
- Agent sidebar patch SHA-256:
  `c37a97f87857bdcb2f9f877e27917774ef0f614718adf74e5b316f15716fc525`;
- preset contact visibility patch SHA-256:
  `6699946b4662daec1005403aadc42a96d55ba27e70436ba8b74d148bc5c6f5d8`;
- successful CI run: `30436620515`;
- CI artifact ID: `8717748098`;
- independently reproduced release ZIP SHA-256:
  `56264deee0e95de4b093e5ca2c7febc0f2f18bf5dbcb0142e2e8d20cd221ee51`;
- Client tar SHA-256:
  `bdfcf277efca7d2b553299deec8aaff51687fc4aef81374b28a18be3c13711bd`;
- composed `index.html` SHA-256:
  `d54e0ff4a0e5b839858e260693ee632b8b4018b21198fa68e906f46d053a4375`.

GitHub Actions completed the full pinned workflow successfully. The production
ZIP was independently reproduced from the same upstream archive, the same
three patches, Node `24.14.1`, npm `11.11.0`, and the repository-owned protected
Client overlay. `scripts/verify-artifact.py` verifies every archive member,
source manifest, patch chain, hidden Agent ID, composed index, and protected
asset before any SSH operation.

## Hidden Agent IDs

```text
workflow_meeting-to-action
workflow_knowledge-base-curator
workflow_excel-audit-reconciliation
workflow_policy-change-impact
workflow_feedback-root-cause-analysis
workflow_kyc-periodic-review
workflow_journal-entry-audit
```

## Deployment Scope

- create one versioned Client directory under
  `/opt/librechat/preset-agent-contact-visibility/`;
- replace only the `LibreChat-API` bind mount whose destination is
  `/app/client/dist`;
- recreate only Compose service `api` / container `LibreChat-API`;
- do not modify Agent or user documents, MongoDB, CodeAPI, RAG, Admin Panel,
  NGINX, Office Converter, Runtime Connector, files, Skills, conversations,
  models, template contents, ACLs, or categories.

The release runner declares exactly:

```text
release-governance:targets=LibreChat-API
```

## Preflight

The versioned collector records the active Client mount and hash, Compose and
configuration hashes, public identity, protected container identities, Office
Converter identity, host resources, rollback availability, and exact candidate
artifact. Apply repeats the same checks and rejects signed-baseline drift.

## Rollback

Before apply, the remote script creates a timestamped backup containing the
exact pre-release Compose override, active Client distribution, runtime
preflight, candidate metadata, and deploy result. Rollback restores that
override and Client mount, recreates only `LibreChat-API`, and verifies every
protected service remains unchanged. It never changes application data.

## Acceptance

No billable model request is required. Acceptance with `vip998` must prove:

- all seven preset Agent cards omit the entire `联系:` row;
- a preset Agent detail page omits the entire `联系:` row;
- starting a new conversation with a preset Agent omits the contact row;
- the seven Agent names, descriptions, categories, starters, models, tools, and
  access remain available;
- an Agent outside the exact seven IDs still renders its configured support or
  owner contact;
- desktop and mobile layouts have no overlap or horizontal overflow;
- normal chat navigation and protected upload, generated-files, usage, login,
  search, and context-safety assets remain present.

Public root, `/api/config`, Admin Panel, and the Office Converter `401` boundary
must remain healthy.
