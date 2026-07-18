# LibreChat Context Safety Release

Date: 2026-07-18

Status: Stage A committed, deployed, and browser-accepted. Stage B browser
notices remain a separate release.

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

Set `CONTEXT_SAFETY_PREFLIGHT_ONLY=true` on the local transport to stop after
the remote read-only preflight. The formal deployment must be a separate
transport run after that result is reviewed.

## Stage A Production Record

Repository gates pushed before the production write:

- `679f3e9` - design gate and approved context-safety contract;
- `f920599` - Stage A implementation and release automation;
- `f5b61b1` - separate read-only production preflight;
- `48ebbb2` - corrected Mongo preflight execution.

Production result:

```text
timestamp=20260718184949
backup_dir=/opt/librechat/backups/context-safety-stage-a-20260718184949
config_sha_before=f67ddcfdd45df03ad3f2cbab0c2cd5f3fcb24bfb08627a09f7483113e5cd1e10
config_sha_after=4868cbaa70558cba2def51a3c8f8a5d4e8eb88248a697866a813f06feec05375
api_container_before=71a718183888c2c99e1dd926270e79f2a53c33cd7ffe1557ee5c935c2da6d33f
api_container_after=5e64f9129da345b2172afc230878ff95ba212a27ae1e7d683d182b077da5911c
maxToolResultChars=32000
recursionLimit=50
maxRecursionLimit=50
protected_containers_unchanged=true
root=200
api_config=200
office=401
```

The Office Skill remained unchanged at SHA
`29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a`.
The Admin Panel displayed the exact values `32000`, `50`, and `50`.

Authenticated browser acceptance used conversation:

```text
https://152.32.172.162.sslip.io/c/6ff21a1b-1e5b-4e2c-b37b-64df9c9ba176
```

One deterministic Python batch task generated and processed 20,000 synthetic
JSON records. It returned `20,000` processed, `20,000` successful, `0` failed,
no warning, and only bounded summary/path output. Download cards rendered for
`manifest.json`, `report.md`, `errors.json`, `records.jsonl`, and
`batch_job.py`. The run completed normally with no visible stop-generation or
still-writing state, and the observed context meter was `6794 / 36.1万 tokens
（2%）`.

Opening `records.jsonl` expanded a large browser preview, but the context meter
remained at 2%. This is recorded as a UI-preview follow-up, not a Stage A model
context regression.

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
