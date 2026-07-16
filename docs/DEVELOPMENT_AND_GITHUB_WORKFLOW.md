# Development And GitHub Workflow

Project: self-hosted LibreChat

Repository:

```text
git@github.com:Jetson998/librechat.git
```

Default branch:

```text
main
```

This document is the portable operating guide for using this repository from a
new computer. It covers local setup, GitHub access, routine development, and
the production-change gate.

For coding, patching, verification, security, rollback, and deployment
standards, read `docs/DEVELOPMENT_STANDARDS.md` first.

## 1. Non-Negotiable Rules

- Do not apply production hotfixes that are not represented in this repository.
- Before any production write, the intended patch, config, script, or
  documentation change must be committed and pushed to `origin/main`.
- Do not commit secrets, API keys, GitHub PATs, cookies, SSH private keys,
  database credentials, user exports, raw private logs, or unredacted request
  bodies.
- Use SSH for GitHub access by default. Do not store GitHub PATs in repository
  files or shell scripts.
- If production behavior is changed, update the relevant release note,
  production verification log, or patch archive before or immediately after the
  deployment, then commit and push the record.
- If `git push` fails, stop before touching production.

## 2. New Computer Setup

Install baseline tools:

```sh
git --version
ssh -V
```

Configure Git identity:

```sh
git config --global user.name "Jetson998"
git config --global user.email "<github-email>"
git config --global init.defaultBranch main
```

Generate an SSH key if the new computer does not already have one:

```sh
ssh-keygen -t ed25519 -C "<github-email>"
```

Use the default path unless there is a reason to separate keys. Add the public
key to GitHub:

```sh
cat ~/.ssh/id_ed25519.pub
```

GitHub UI path:

```text
GitHub -> Settings -> SSH and GPG keys -> New SSH key
```

Test SSH auth:

```sh
ssh -T git@github.com
```

Expected result is an authentication success message from GitHub. It may say
shell access is not provided; that is normal.

Clone the repository:

```sh
mkdir -p ~/Documents/Codex
cd ~/Documents/Codex
git clone git@github.com:Jetson998/librechat.git LibreChat
cd LibreChat
git status --short --branch
```

Expected branch status:

```text
## main...origin/main
```

## 3. GitHub Access Methods

### Recommended: SSH Git Remote

Current production repository remote:

```sh
git remote -v
```

Expected:

```text
origin  git@github.com:Jetson998/librechat.git (fetch)
origin  git@github.com:Jetson998/librechat.git (push)
```

Set or repair the remote:

```sh
git remote set-url origin git@github.com:Jetson998/librechat.git
```

Fetch:

```sh
git fetch origin
```

Update local `main` safely:

```sh
git switch main
git pull --ff-only origin main
```

Push:

```sh
git push origin main
```

### Optional: GitHub CLI

Use GitHub CLI only if it is already installed or needed for issue/PR work:

```sh
gh auth login
gh auth status
gh repo view Jetson998/librechat
```

Prefer SSH during `gh auth login` when prompted for Git protocol.

### Fallback: HTTPS With PAT

Avoid this for normal operation. If SSH cannot be used, use a short-lived PAT
through the OS credential manager or an interactive prompt. Do not write the PAT
into:

- repository files;
- `.env`;
- shell history where possible;
- Git remote URLs;
- Codex prompts that will be committed into logs or docs.

If an HTTPS remote accidentally contains a token, replace it immediately:

```sh
git remote set-url origin git@github.com:Jetson998/librechat.git
```

## 4. Routine Development Flow

Start every task by checking state:

```sh
pwd
git status --short --branch
git log --oneline -5
```

Before editing, inspect the relevant existing docs or patch archive. Common
entry points:

```text
README.md
docs/STANDARD_OPERATING_PROCEDURE.md
docs/RELEASE_CHECKLIST.md
docs/PRODUCTION_VERIFICATION.md
deployment/production-patches/
deployment/production-operations/
```

Make the smallest repository change that represents the intended behavior.

Run relevant local checks. Examples:

```sh
git diff --check
node --check <changed-js-file>
rg -n "github_pat|sk-[A-Za-z0-9]|OPENAI_API_KEY|BEGIN (RSA|OPENSSH|PRIVATE) KEY" .
```

Review changes:

```sh
git diff --stat
git diff
```

Commit:

```sh
git add <changed-files>
git commit -m "<short imperative summary>"
```

Push:

```sh
git push origin main
```

Confirm clean alignment:

```sh
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

The two hashes must match before production deployment.

## 5. Production Change Gate

For production writes, follow `docs/STANDARD_OPERATING_PROCEDURE.md` and
`docs/RELEASE_CHECKLIST.md`.

Minimum required sequence:

1. Read-only diagnosis is allowed.
2. Represent the intended change in this repository.
3. Document reason, affected files/services, expected behavior, verification,
   and rollback.
4. Run local checks.
5. Commit.
6. Push to `origin/main`.
7. Confirm local `HEAD` equals `origin/main`.
8. Back up production files before replacement.
9. Apply the committed change to production.
10. Verify production.
11. Record deployment result, backups, hashes, and verification.
12. Commit and push the deployment record.

No production write is allowed between steps 1 and 7.

## 6. Standard Production Smoke Checks

External checks:

```sh
curl -k -I https://152.32.172.162.sslip.io/
curl -k -L https://152.32.172.162.sslip.io/api/config
curl -k -I https://152.32.172.162.sslip.io/office/
```

Expected high-level result:

- `/` returns `HTTP/2 200`.
- `/api/config` returns JSON.
- `/office/` returns `HTTP/2 401` with `realm="Office Converter"`.

For JS production patches, run container syntax checks before restart whenever
possible:

```sh
docker exec LibreChat-API node --check /app/api/app/clients/BaseClient.js
docker exec LibreChat-API node --check /app/api/server/services/ToolService.js
docker exec LibreChat-API node --check /app/packages/api/dist/index.cjs
```

Only run checks for files that exist and are affected by the release.

## 7. File And Office Workflow Contract

Current intended contract:

- `图片上传`: images only.
- `Office文件上传`: original Office/table files for CodeAPI execution.
- `文件提取文字上传`: extracted text for model-side review and summary.
- Office uploads used by code execution must be available inside CodeAPI under
  `/mnt/data`.
- Generated Office artifacts should be saved under `/mnt/data` first, then
  persisted by LibreChat as downloadable cards.
- Generated PPTX/XLSX/DOCX/MD/PDF artifacts need visible download-card
  rendering, not only backend metadata.

When this contract breaks, diagnose in this order:

1. Stored LibreChat message/file metadata.
2. `metadata.codeEnvRef`.
3. CodeAPI upload/session logs.
4. Whether the first Bash/code call received `_injected_files`.
5. Whether generated artifacts were saved under `/mnt/data`.
6. Whether assistant `files`, `attachments`, and tool content allow frontend
   rendering.

## 8. Prompt To Give Codex On A New Computer

Use this when starting a new Codex session:

```text
We are working only on the LibreChat repository at
/Users/<user>/Documents/Codex/LibreChat. Remote is
git@github.com:Jetson998/librechat.git, branch main.

Follow the repository gate strictly:
1. read-only diagnosis first;
2. represent changes in the repo;
3. run checks;
4. commit;
5. git push origin main;
6. only then deploy production;
7. record deployment result and push the record.

Do not use GitHub PATs. Use SSH. Do not mix WebAI/OpenWebUI work into this
LibreChat repo.
```

Adjust the local path if the repository is cloned elsewhere.

## 9. Common Problems

SSH auth fails:

```sh
ssh -T git@github.com
ssh-add -l
ssh-add ~/.ssh/id_ed25519
```

Remote points to HTTPS or the wrong repository:

```sh
git remote -v
git remote set-url origin git@github.com:Jetson998/librechat.git
```

Local branch diverged:

```sh
git status --short --branch
git fetch origin
git log --oneline --graph --decorate --all -20
```

Do not force-push unless there is an explicit recovery decision.

Uncommitted local changes exist:

```sh
git status --short
git diff
```

Do not discard changes unless they are confirmed unrelated and safe to remove.

Production differs from repository:

- Treat it as a process violation or emergency drift.
- Capture production files read-only first.
- Bring the production patch into the repository.
- Commit and push before replacing anything else.
