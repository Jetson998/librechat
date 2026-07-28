# Agent Platform P0 UI Production Release

Date: 2026-07-28

Status: repository patch in preparation; production unchanged.

## Objective

Deploy the fixed-upstream LibreChat Client that provides the unified
`智能助手` workspace, recommended/my/create/edit modes, permission-safe states,
and the basic/advanced Agent builder split while preserving every currently
protected Client customization.

## Immutable Inputs

- LibreChat upstream commit:
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`;
- Agent UI patch SHA-256:
  `00fc078859275611b717e34bd3a0fda4c44d08db1412b6df9e8735d27d0777bc`;
- CI run: `30326622161`;
- CI artifact ID: `8675938396`;
- artifact ZIP SHA-256:
  `015ab73f6e5ac4bbf84f5a19f48160e3072f7cf494669a18c5c45e84eb90410c`;
- Client tar SHA-256:
  `1bae767735f53be05a9acbc5fceb7ec04b4bad7576f48f52d5a3ca73175f6c68`;
- composed `index.html` SHA-256:
  `e50a1f4ba112abe37df27d5af4608bfa8b4b6c5cdcf06763960ba1b742f9f67e`.

The binary artifact is not stored in Git. `scripts/verify-artifact.py` verifies
the downloaded ZIP against `client/artifact.json` before any SSH or production
operation.

## Deployment Scope

- create one versioned Client directory under
  `/opt/librechat/agent-platform-p0-ui/`;
- replace only the `LibreChat-API` bind mount whose destination is
  `/app/client/dist`;
- recreate only Compose service `api` / container `LibreChat-API`;
- do not modify Agent API code, MongoDB, CodeAPI, RAG, Admin Panel, NGINX,
  Office Converter, Runtime Connector, files, Skills, conversations, or model
  configuration.

The release runner declares exactly:

```text
release-governance:targets=LibreChat-API
```

## Preflight

The versioned preflight collector verifies and records:

- current root Client hash and LibreChat `buildInfo.commit`;
- exact active `/app/client/dist:ro` source;
- Compose and configuration hashes;
- API, NGINX, CodeAPI, RAG, Admin Panel, MongoDB, and Office Converter identity;
- memory, disk, dependency interface, and rollback availability;
- the immutable candidate artifact contract.

The apply script repeats the preflight immediately before changing production
and rejects any drift from that signed snapshot.

The local collector uses a BSD/GNU-compatible `mktemp` template so the same
versioned preflight runs on macOS operator hosts and Linux build environments.

## Rollback

Before apply, the remote script creates a timestamped backup containing:

- the exact pre-release `compose.override.yaml`;
- a full copy of the active Client distribution;
- the runtime preflight snapshot;
- candidate metadata and the deploy result.

Rollback restores the matching Compose override, recreates only
`LibreChat-API`, verifies the old public Client hash, and confirms all protected
services remain unchanged. It never deletes Agent, Skill, file, conversation,
or MongoDB data.

## Acceptance

No billable model request is required. Acceptance must cover:

- public root and `/api/config`;
- `/office/` remains `401` with realm `Office Converter`;
- Admin Panel remains available;
- all ten protected Client assets retain their exact hashes;
- USER can find `智能助手`, switch recommended/my/create, create and remove a
  private test assistant, and discover personal Skills where permitted;
- ADMIN uses the same workspace while retaining existing market/admin controls;
- desktop `1440x900` and mobile `390x844` have no overflow, clipping, or double
  side panels;
- normal chat, upload menu, My Files, generated files, model market, usage,
  login, search fallback, and context safety remain visible.

Workflow Manifest, Runtime production execution, and the seven planned workflow
templates are explicitly outside this release.
