# Generic Project Development Workflow

Purpose: reusable development, GitHub, release, and deployment standards for a
new or existing software project.

Copy this document into a new project and replace placeholders such as
`<project-name>`, `<repo-ssh-url>`, `<default-branch>`, `<production-url>`, and
`<deploy-target>`.

## 1. Project Identity

Fill this section before work starts:

```text
Project name: <project-name>
Repository: <repo-ssh-url>
Default branch: <default-branch>
Primary runtime: <node/python/go/java/etc>
Production URL: <production-url or none>
Deployment target: <server/container/cloud/service or none>
Owner/operator: <name/team>
```

Rules:

- Keep one repository scoped to one project.
- Do not mix unrelated project patches, docs, scripts, credentials, logs, or
  deployment notes into this repository.
- If external systems are involved, document them as dependencies instead of
  copying their private state into this repo.

## 2. Non-Negotiable Rules

- Do not commit secrets.
- Do not apply production hotfixes that are not represented in the repository.
- Do not modify production before the intended change is committed and pushed.
- Do not claim success until verification has passed.
- Do not overwrite unrelated local changes.
- Do not force-push shared history unless there is an explicit recovery
  decision.

## 3. New Computer Setup

Install baseline tools:

```sh
git --version
ssh -V
```

Configure Git identity:

```sh
git config --global user.name "<github-username>"
git config --global user.email "<github-email>"
git config --global init.defaultBranch main
```

Generate an SSH key if needed:

```sh
ssh-keygen -t ed25519 -C "<github-email>"
```

Add the public key to GitHub:

```sh
cat ~/.ssh/id_ed25519.pub
```

GitHub UI path:

```text
GitHub -> Settings -> SSH and GPG keys -> New SSH key
```

Test GitHub SSH:

```sh
ssh -T git@github.com
```

Clone:

```sh
mkdir -p ~/Documents/Codex
cd ~/Documents/Codex
git clone <repo-ssh-url> <project-directory>
cd <project-directory>
git status --short --branch
```

Expected:

```text
## <default-branch>...origin/<default-branch>
```

## 4. GitHub Access

Recommended remote format:

```text
git@github.com:<owner>/<repo>.git
```

Check remote:

```sh
git remote -v
```

Set remote:

```sh
git remote set-url origin <repo-ssh-url>
```

Fetch:

```sh
git fetch origin
```

Update local branch safely:

```sh
git switch <default-branch>
git pull --ff-only origin <default-branch>
```

Push:

```sh
git push origin <default-branch>
```

Optional GitHub CLI:

```sh
gh auth login
gh auth status
gh repo view <owner>/<repo>
```

PAT fallback:

- Use only when SSH is unavailable.
- Use a short-lived token.
- Do not store the token in repository files, scripts, `.env`, committed docs,
  or Git remote URLs.
- If a token enters the remote URL, replace it immediately:

```sh
git remote set-url origin <repo-ssh-url>
```

## 5. Standard Work Start

Run at the start of every task:

```sh
pwd
git status --short --branch
git log --oneline -5
```

Then inspect relevant files before editing:

```sh
rg --files
rg -n "<keyword>"
```

Prefer `rg` over slower broad searches.

## 6. Change Design

Before implementation, write down or confirm:

- problem statement;
- affected user path;
- verified evidence;
- suspected root cause;
- files/modules likely affected;
- expected behavior after change;
- verification plan;
- rollback plan if production is involved.

Do not start with a production edit. Read-only diagnosis is allowed.

## 7. Repository Layout

Recommended layout:

```text
README.md
docs/
scripts/
src/
tests/
deployment/
deployment/releases/
deployment/operations/
```

Use `docs/` for durable explanations, plans, and operating rules.

Use `deployment/releases/YYYY-MM-DD-short-name/` for release-specific patches,
configs, scripts, and deployment records.

Use `deployment/operations/YYYY-MM-DD-short-name/` for one-off operational
actions such as data repair, user creation, migration, or controlled cleanup.

Every release/operation folder should include a `README.md` with:

- reason;
- affected files/services;
- implementation summary;
- verification plan;
- rollback plan;
- deployment result after execution;
- backup paths or artifact IDs when applicable.

## 8. Code Standards

General:

- Follow existing project patterns.
- Keep changes scoped.
- Prefer simple code over premature abstraction.
- Add abstractions only when they reduce real duplication or risk.
- Use structured parsers/APIs instead of fragile string parsing where practical.
- Add comments only for non-obvious logic or operational constraints.
- Keep names exact: field names, route names, env vars, config keys, file paths.

Frontend:

- Preserve existing design system and interaction patterns.
- Verify responsive behavior for affected screens.
- Prevent text overflow and layout overlap.
- Do not rely on visible labels alone when behavior needs validation; enforce
  rules in code.

Backend:

- Validate inputs at boundaries.
- Keep authorization and tenant/user scoping explicit.
- Treat persistence changes as contract changes.
- Log enough for diagnosis, but never log secrets or private payloads.

Scripts:

- Use `set -euo pipefail` for shell scripts where practical.
- Fail closed.
- Print target path, backup path, version/hash, marker checks, and result.
- Do not print secrets.
- For destructive operations, require explicit target identifiers and dry-run
  support when feasible.

## 9. Security Standards

Never commit:

- GitHub PATs;
- API keys;
- SSH private keys;
- cookies;
- database credentials;
- `.env` with real values;
- user exports;
- unredacted logs;
- private request/response bodies;
- production database dumps.

Run a basic scan before committing sensitive areas:

```sh
rg -n "github_pat|sk-[A-Za-z0-9]|OPENAI_API_KEY|ANTHROPIC_API_KEY|BEGIN (RSA|OPENSSH|PRIVATE) KEY" .
```

If the match is only the example scan command, it is not a secret. If a real
secret is found, remove it before commit and rotate the exposed credential if
it may have left the local machine.

## 10. Local Verification

Minimum for docs-only changes:

```sh
git diff --check
```

Common checks by stack:

```sh
npm test
npm run lint
npm run typecheck
npm run build
python -m pytest
ruff check .
go test ./...
cargo test
```

Use the checks that match the project. If a check cannot run, document why.

For JavaScript files that are deployed directly:

```sh
node --check <file>
```

For shell scripts:

```sh
bash -n <script>
```

## 11. Git Flow

Review changes:

```sh
git diff --stat
git diff
```

Stage:

```sh
git add <files>
```

Check staged diff:

```sh
git diff --cached --check
git diff --cached --stat
```

Commit:

```sh
git commit -m "<short imperative summary>"
```

Push:

```sh
git push origin <default-branch>
```

Confirm alignment:

```sh
git status --short --branch
git rev-parse HEAD
git rev-parse origin/<default-branch>
```

`HEAD` and `origin/<default-branch>` should match before deployment.

## 12. Production Change Gate

Production writes include:

- editing server files;
- replacing deployed assets;
- changing configs;
- restarting services;
- changing databases or queues;
- changing cloud resources;
- changing secrets;
- repairing production data;
- running migrations;
- changing routing, DNS, or auth.

Required sequence:

1. Read-only diagnosis.
2. Represent the intended change in the repository.
3. Document reason, affected files/services, verification, and rollback.
4. Run local checks.
5. Commit.
6. Push to `origin/<default-branch>`.
7. Confirm local `HEAD` equals remote branch.
8. Back up affected production files/data/configs.
9. Apply the committed change.
10. Verify production.
11. Record deployment result.
12. Commit and push the deployment record.

No production write is allowed before step 7.

## 13. Deployment Verification

Define project-specific smoke checks here:

```sh
curl -I <production-url>
curl -L <production-url>/health
```

Replace these with the real health endpoints and user flows.

Minimum verification should cover:

- service is reachable;
- primary page/API returns expected status;
- auth path still works;
- core user workflow works;
- logs do not show new fatal errors;
- rollback remains possible.

For frontend changes, verify in a browser or screenshot-capable test.

For file, upload, artifact, or export changes, verify with a real small file and
confirm the output can be opened or downloaded.

## 14. Rollback Standards

Every production change needs a rollback path before deployment.

Record:

- backup path or artifact ID;
- target path/service/config;
- exact rollback command;
- whether restart is needed;
- verification command after rollback.

If rollback is not possible, record the risk before deployment and get an
explicit decision.

## 15. Documentation Standards

Update docs when:

- behavior changes;
- operating procedure changes;
- deployment path changes;
- rollback path changes;
- config or environment assumptions change;
- a production incident reveals a missing guardrail.

Docs should separate:

- verified facts;
- assumptions;
- inferred causes;
- commands run;
- results observed.

## 16. Done Criteria

A task is complete only when:

- code/docs/config are updated;
- relevant checks pass or skipped checks are explained;
- commit is created;
- commit is pushed;
- production deployment is verified if production was touched;
- deployment result is recorded if production was touched;
- rollback information is available;
- local branch is aligned with remote;
- worktree is clean.

## 17. Reusable Codex Prompt

Use this prompt when starting a new project session:

```text
We are working on <project-name> in <local-path>.
Remote is <repo-ssh-url>, default branch is <default-branch>.

Follow the development standard strictly:
1. inspect repo state first;
2. diagnose read-only before changing production;
3. represent intended changes in the repository;
4. run relevant checks;
5. commit;
6. push to origin/<default-branch>;
7. only then deploy production if needed;
8. record deployment result and push the record.

Do not use GitHub PATs unless SSH is impossible. Do not commit secrets.
Do not mix unrelated project work into this repository.
```

## 18. Minimal Release Record Template

```text
Date:
Operator:
Change name:
Reason:
Affected files/services:
Expected behavior:
Local checks:
Production verification:
Rollback:
Commit:
Deployment result:
Backup paths/artifacts:
Open risks:
```
