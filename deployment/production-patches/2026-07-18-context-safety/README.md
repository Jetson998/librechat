# LibreChat Context Safety Release

Date: 2026-07-18

Status: Stage A implementation locally verified; commit, push, and deployment
pending. Stage B browser notices remain a separate release.

## Reason

Conversation `64345282-da97-41a8-8971-1969e8d98087` accumulated large serialized
JSON and tool-history outputs. The browser showed 77% context usage and the
run stopped at the default 50-step recursion limit. The current Admin Panel
has no configured tool-result ceiling or recursion hard cap.

## Approved Behavior

Stage A will configure:

```text
工具结果最大字符数=32000
递归限制=50
最大值递归限制=50
```

The model workflow will use one deterministic, possibly streaming or
checkpointed, batch task after a lightweight preflight. It will keep normal
stdout at or below 8,000 characters, never print complete source data, and
write detailed results to `/mnt/data/<task-directory>/` with a manifest and
error list.

Stage B will add browser-facing context warnings and a friendly recursion-stop
message. It will preserve existing upload-menu, Office, usage-dashboard, file
card, and web-search behavior.

## Production Scope

Stage A expected targets:

- `/opt/librechat/librechat.yaml`;
- the active base Mongo config document;
- the active API service, recreated only after the release is committed and
  pushed.

Stage B expected targets:

- the versioned `/app/client/dist` mount and its Compose override;
- the API service only, with all protected neighboring services unchanged.

No conversation rows, uploaded files, generated artifacts, user records,
CodeAPI session directories, Office route, RAG service, Nginx configuration, or
WebAI/OpenWebUI resources are in scope.

## Files

```text
README.md
config/large-file-batch-contract.txt
scripts/merge-config.cjs
scripts/mongo-config.js
scripts/test-release.py
scripts/deploy.sh
scripts/run-remote-release.sh
scripts/deploy-remote.exp
```

`merge-config.cjs` updates only the three approved agent values and the marked
prompt block on the two active model specs. `mongo-config.js` applies the same
contract to the unique active base config document and provides preflight,
verification, preservation-hash, backup, and rollback modes.

## Local Test

```bash
python3 scripts/test-release.py
git diff --check
```

Current local result:

```text
context_safety_release: ok
```

## Deployment

After the implementation commit is pushed to `origin/main`, stage this release
with `deploy-remote.exp`. The transport accepts the SSH password only through
the process environment, checks that local `HEAD` equals `RELEASE_COMMIT`, and
does not store credentials in the repository or on the server.

The remote runner executes the local contract test and a read-only preflight
before the production write. The production runner backs up YAML and the full
active base config, performs idempotent structural updates, recreates only the
API service with `--no-deps`, verifies protected container identities, and
rolls back both config layers on failure.

## Design Gate Evidence

- The target conversation displayed `28万 of 36.1万 tokens used (77%)`.
- The visible run ended with `Recursion limit of 50 reached without hitting a
  stop condition`.
- Nine tool-output blocks totaled approximately 614,497 characters; the four
  largest were approximately 200,035, 200,035, 90,452, and 69,631 characters.
- The active Admin Panel fields `工具结果最大字符数`, `递归限制`, and
  `最大值递归限制` were blank during inspection.

## Verification and Rollback

The implementation release must include structural merge tests, prompt
contract tests, secret scanning, idempotency checks, HTTP health checks, a
bounded-output JSON/Office smoke task, and browser acceptance. Every production
write must back up the full affected config and restore it atomically on
failure.

Detailed design and acceptance criteria are in:

```text
docs/CONTEXT_SAFETY_PLAN.md
```
