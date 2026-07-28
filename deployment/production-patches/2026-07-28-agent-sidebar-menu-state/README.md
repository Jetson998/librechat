# Agent Sidebar Menu State Production Release

Date: 2026-07-28

Status: repository patch in preparation; production unchanged.

## Objective

Deploy the fixed-upstream LibreChat Client that labels the workspace `Agent`,
shows its gray active state on `/agents`, collapses the sidebar when the active
entry is clicked again, and preserves valid side-panel content instead of
rendering an empty panel.

## Immutable Inputs

- LibreChat upstream commit:
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`;
- base Agent UI patch SHA-256:
  `00fc078859275611b717e34bd3a0fda4c44d08db1412b6df9e8735d27d0777bc`;
- sidebar follow-up patch SHA-256:
  `c37a97f87857bdcb2f9f877e27917774ef0f614718adf74e5b316f15716fc525`;
- CI run: `30335517499`;
- CI artifact ID: `8679020809`;
- artifact ZIP SHA-256:
  `d4f1848acdacb5240fa46dedff65b09726a92ca99844f119be2ce44655a118c2`;
- Client tar SHA-256:
  `c32fd952eac54b90369043e50e050486a5ecb58291d051c9fdc5f67a6a00503e`;
- composed `index.html` SHA-256:
  `ef79e21b7d2b24998972f34a32db4dfd8700ff1898cf2caae6fbe6316756f6b9`.

The binary artifact is not stored in Git. `scripts/verify-artifact.py` verifies
the downloaded ZIP, both source manifests, the Client tar, composed index, and
all protected assets against `client/artifact.json` before any SSH operation.

## Deployment Scope

- create one versioned Client directory under
  `/opt/librechat/agent-sidebar-menu-state/`;
- replace only the `LibreChat-API` bind mount whose destination is
  `/app/client/dist`;
- recreate only Compose service `api` / container `LibreChat-API`;
- do not modify Agent API code, MongoDB, CodeAPI, RAG, Admin Panel, NGINX,
  Office Converter, Runtime Connector, files, Skills, conversations, models,
  or the seven planned workflow templates.

The release runner declares exactly:

```text
release-governance:targets=LibreChat-API
```

## Preflight

The versioned collector records the active Client mount and hash, Compose and
configuration hashes, public identity, protected container identities, Office
Converter identity, host resources, rollback availability, and exact candidate
artifact. Apply repeats the same checks and rejects any signed-baseline drift.

## Rollback

Before apply, the remote script creates a timestamped backup containing the
exact pre-release Compose override, active Client distribution, runtime
preflight, candidate metadata, and deploy result. Rollback restores that
override and Client mount, recreates only `LibreChat-API`, and verifies every
protected service remains unchanged. It never deletes user or application data.

## Acceptance

No billable model request is required. Acceptance must prove with `vip998`:

- the sidebar entry and `/agents` heading display `Agent`;
- `/agents`, query views, and category deep links select the Agent icon;
- clicking the selected Agent icon collapses the sidebar without navigation;
- reopening Agent keeps valid panel content and does not create a blank panel;
- desktop `1440x900` and mobile `390x844` have no overlap or horizontal
  overflow;
- normal chat navigation and the protected upload, generated-files, usage,
  login, search, and context-safety assets remain present.

Public root, `/api/config`, Admin Panel, and the Office Converter `401` boundary
must remain healthy. Production execution for Workflow Manifest Agents remains
outside this release.
