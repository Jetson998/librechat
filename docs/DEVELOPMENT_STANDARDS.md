# Development Standards

Project: self-hosted LibreChat

This document defines how changes should be designed, implemented, reviewed,
verified, documented, and deployed in this repository.

Related documents:

- `docs/DEVELOPMENT_AND_GITHUB_WORKFLOW.md`: new-computer setup and GitHub
  commands.
- `docs/STANDARD_OPERATING_PROCEDURE.md`: production operation rules.
- `docs/RELEASE_CHECKLIST.md`: minimum gate for production changes.

## 1. Scope

This repository is for the self-hosted LibreChat deployment only.

Do not mix changes, notes, patches, scripts, or assumptions from WebAI,
OpenWebUI, or unrelated projects into this repository. If a comparison is
needed, document it as external context and keep the implemented patch scoped
to LibreChat.

## 2. Engineering Principles

- Prefer the smallest change that fixes the actual verified problem.
- Diagnose with evidence before changing production.
- Preserve upstream LibreChat behavior unless the product requirement explicitly
  says otherwise.
- Keep custom behavior easy to find, verify, and roll back.
- Prefer deterministic backend logic for critical file and artifact flows.
  Prompt-only fixes are not sufficient when the system can enforce the
  behavior directly.
- Do not claim production success until browser/API behavior and persisted data
  match the expected contract.

## 3. Worktree Standards

Start every task with:

```sh
pwd
git status --short --branch
git log --oneline -5
```

Rules:

- Do not overwrite unrelated local changes.
- Do not revert user changes unless explicitly asked.
- Do not leave generated scratch files in the repository.
- Keep temporary diagnostics under `/tmp` or another documented scratch path.
- Any production-mounted file that is edited or replaced must have its intended
  version represented in this repository first.

## 4. Change Design Standards

Before implementation, identify:

- user-visible problem;
- verified root cause or strongest current evidence;
- affected files/services;
- expected behavior after the change;
- rollback method;
- local checks;
- production smoke checks.

For production-affecting changes, this must be written into a patch archive,
plan, release note, or verification document before production is touched.

## 5. Repository Layout Standards

Use these locations consistently:

```text
docs/
deployment/production-patches/
deployment/production-operations/
```

Use `docs/` for design plans, operating rules, and verification summaries.

Use `deployment/production-patches/YYYY-MM-DD-short-name/` for production code,
config, skill, static asset, or script patches. A patch directory should include
a `README.md` with:

- reason;
- affected production paths;
- source files included in the archive;
- feature/function list;
- verification plan;
- rollback path;
- deployment result after release;
- backup paths and checksums when applicable.

Use `deployment/production-operations/YYYY-MM-DD-short-name/` for one-off
operational actions such as creating users or running controlled repair
scripts. These still follow the production gate.

## 6. Code Standards

General:

- Follow existing LibreChat patterns before introducing new abstractions.
- Keep edits scoped to the feature or bug.
- Prefer structured APIs/parsers over ad hoc string parsing.
- Add comments only when they explain non-obvious behavior or operational
  constraints.
- Keep file names, environment variable names, database field names, and route
  names exact in docs and code.
- Avoid broad refactors while fixing production issues.

JavaScript/Node patches:

- Run `node --check` for changed deployable JS files where possible.
- Run `git diff --check`.
- Keep bundled or production snapshot changes minimal and clearly marked in the
  patch archive.
- If a generated/bundled production file must be patched, archive the exact
  production snapshot in the repository before modifying it.

Scripts:

- Scripts that change production must be committed before use.
- Scripts must fail closed with `set -euo pipefail` where practical.
- Scripts must back up affected production files before replacement.
- Scripts must print enough evidence to audit: target path, backup path, hash,
  marker check, and verification result.
- Scripts must not print secrets.

## 7. Frontend Standards

For LibreChat UI changes:

- Preserve existing interaction patterns unless a product decision requires a
  different flow.
- Use clear Chinese labels for operator-facing upload and file flows.
- Ensure labels do not rely only on visual position; behavior must be guarded
  by file-type checks where relevant.
- Verify runtime patches are present in the served HTML or asset actually used
  by the browser.
- Avoid changes that require users to infer hidden behavior from generic
  LibreChat labels.

Upload menu contract:

```text
图片上传
Office文件上传
文件提取文字上传
```

Expected behavior:

- `图片上传`: image files only.
- `Office文件上传`: original Office/table files for code execution.
- `文件提取文字上传`: extracted text for model-side review.

## 8. Backend And File Pipeline Standards

The file pipeline contract is:

- Office uploads intended for code execution must be available in CodeAPI under
  `/mnt/data`.
- Generated artifacts must be saved under `/mnt/data` first.
- LibreChat must persist generated artifacts as downloadable files.
- PPTX/XLSX/DOCX/MD/PDF/image outputs must render as visible download cards
  when the frontend supports the file type.
- Current conversation files and current-turn generated files should be
  available; unrelated cross-conversation CodeAPI session storage should not be
  exposed to the model.

When debugging file issues, check in this order:

1. LibreChat message record.
2. `files` collection row.
3. `metadata.codeEnvRef`.
4. `tool_resources.execute_code`.
5. CodeAPI upload/session logs.
6. First code-tool call `_injected_files`.
7. `/mnt/data` contents inside the execution.
8. Assistant `files`, `attachments`, and tool content needed for card rendering.

Do not rely on a model retry as the primary fix for missing file injection,
missing artifact persistence, or missing download-card rendering.

## 9. Security Standards

Never commit:

- GitHub PATs;
- OpenAI/Anthropic/provider API keys;
- SSH private keys;
- cookies;
- database credentials;
- production `.env` files;
- user exports;
- unredacted private logs;
- raw request/response payloads containing user data.

Run a basic secret scan before commits that add docs, scripts, config, or
captured production files:

```sh
rg -n "github_pat|sk-[A-Za-z0-9]|OPENAI_API_KEY|ANTHROPIC_API_KEY|BEGIN (RSA|OPENSSH|PRIVATE) KEY" .
```

If the scan matches an example command, that is acceptable only when the match
does not contain a real secret.

## 10. Verification Standards

Minimum local checks for documentation-only changes:

```sh
git diff --check
```

Minimum local checks for JavaScript production patches:

```sh
git diff --check
node --check <changed-js-file>
```

Minimum external smoke checks for production:

```sh
curl -k -I https://152.32.172.162.sslip.io/
curl -k -L https://152.32.172.162.sslip.io/api/config
curl -k -I https://152.32.172.162.sslip.io/office/
```

Expected:

- root returns `HTTP/2 200`;
- `/api/config` returns JSON;
- `/office/` returns `HTTP/2 401` with `realm="Office Converter"`.

When file upload or CodeAPI behavior changes, also verify with a real small
file. For Office work, include at least one XLSX test when the change touches
spreadsheet parsing, code execution, or generated artifacts.

## 11. Git Standards

Use `main` and `origin/main` unless a deliberate branch workflow is introduced.

Commit standards:

- Use short imperative commit messages.
- Commit code/config changes separately from deployment result records when
  that improves auditability.
- Do not amend or force-push shared history unless there is an explicit
  recovery decision.
- Push before production.
- After push, confirm:

```sh
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

`HEAD` and `origin/main` must match before production writes.

## 12. Production Deployment Standards

Production writes include:

- editing server files;
- replacing bind mounts;
- restarting containers or services;
- changing Nginx or Docker Compose;
- changing `librechat.yaml`;
- changing deployment skills;
- changing static assets;
- modifying MongoDB/Redis/uploads;
- repairing saved conversations or file metadata.

Required sequence:

1. Read-only diagnosis.
2. Repository change.
3. Local checks.
4. Commit.
5. Push to `origin/main`.
6. Confirm branch alignment.
7. Back up production files.
8. Apply the committed change.
9. Verify production.
10. Record deployment result.
11. Commit and push the record.

If any step fails, stop and document the blocker. Do not continue with manual
untracked fixes.

## 13. Rollback Standards

Every production patch must have a rollback path before deployment.

A rollback path should include:

- exact backup file path;
- exact production target path;
- service restart command if needed;
- verification commands;
- expected restored behavior.

If rollback requires a database repair, document the query/script and confirm
that it is scoped to the intended conversation, user, file, or config record.

## 14. Done Criteria

A change is done only when:

- the intended behavior is represented in the repository;
- relevant checks passed;
- commits are pushed to `origin/main`;
- production was changed only after the gate, if production was touched;
- production verification passed, if production was touched;
- deployment result and rollback evidence are documented;
- local branch is aligned with `origin/main`;
- `git status --short --branch` is clean.

For documentation-only changes, done means the document is committed and pushed,
with `git diff --check` passing.
