# Preset Agent runtime identity and category de-duplication

Release ID: `20260730-preset-agent-runtime-category-fix`

This enhanced release fixes two production defects without changing the seven
preset Agent definitions, provider/model configuration, ownership, ACLs, or
ordinary/personal Agent behavior.

## Scope

- migrate exactly seven managed Agent IDs from `workflow_*` to
  `agent_workflow_*`, the persistent-Agent prefix required by LibreChat;
- preserve each Agent `_id`, `author`, `provider`, `model`, every embedded
  version, and the existing 14 ACL documents;
- update only top-level `id` and every `versions[].id`;
- deploy the independently built Client that uses the new IDs and hides the
  sole business-category tab when it duplicates `全部`;
- recreate only `LibreChat-API`; MongoDB data changes in place but the
  `chat-mongodb` container is not recreated.

The deployment target lock is:

```text
LibreChat-API
chat-mongodb:data
```

NGINX, CodeAPI, RAG, Admin, the MongoDB container, Office Converter, Runtime
Connector, files, Skills, users, conversations, and model configuration are not
deployment targets.

## Immutable Client

- repository source: `d880d08fbb72de34193456b5a4be62c95303bc02`
- upstream source: `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`
- GitHub Actions run: `30519531259` (`success`)
- GitHub artifact: `8750249452`
- independent ZIP SHA-256:
  `6be12f42311e50350ac911503da326b60186d3594f1d295cec5a9c7b022856e3`
- Client tar SHA-256:
  `35f0094c809f69769627bcd8dbc17c49e5c7977780de21ef1eca832c52758ab5`
- composed `index.html` SHA-256:
  `37e9e18e822416f744d46eeca5322baf5f06db58a03056f81f3db49857b44aca`
- tar members: 355; AppleDouble and `__MACOSX` members are forbidden.

The binary ZIP is retained as an external release artifact and is not committed
to Git. `client/artifact.json` records the exact member hashes.

## Preflight and data backup

`scripts/collect-preflight.sh` performs a read-only production snapshot. It:

- locks the active Client mount, public index, Compose/config hashes, protected
  service identities, host resources, and public boundaries;
- saves the seven target Agent documents, 14 ACL documents, and the active
  `automation-workflow` category as Mongo Extended JSON;
- scans every non-system, non-GridFS-chunk collection for exact legacy Agent ID
  references, including other Agent documents;
- fails if any target new ID already exists, a target is not managed by
  `librechat-preset-workflow-agents`, owner/model/version/ACL invariants drift,
  or an external reference is found.

Immediately before mutation, `remote-apply.py` reruns the same snapshot and
requires its Client/service baseline and Mongo digest to match the signed
preflight.

## Apply and rollback

The runner stores under the timestamped backup directory:

- the full pre-migration Extended JSON target snapshot;
- the previous Client tree and Compose override;
- the runtime preflight, artifact metadata, migration scripts, and rollback
  runner.

It migrates Mongo first, proves that only the top-level and embedded-version IDs
changed, then switches the Client mount and recreates only `LibreChat-API`.
Any migration, Client, public-health, protected-service, or asset validation
failure triggers both Mongo and Client rollback.

## Verification

```sh
python3 deployment/production-patches/2026-07-30-preset-agent-runtime-category-fix/scripts/test-release.py \
  /path/to/librechat-preset-agent-runtime-category-fix-client.zip
```

Production acceptance uses `vip998` without clicking a starter or sending a
model request:

- `/agents` shows only `精选 Agent` and `全部`, each with seven cards;
- opening the audit Agent no longer reports a missing My Agents model;
- preset Agent detail/new conversation retains three starters and hides contact;
- a non-preset or personal Agent retains configured contact controls;
- Mongo shows seven `agent_workflow_*` IDs with unchanged `_id`, owner, model,
  versions other than their IDs, and 14 unchanged ACL entries.
