# Targeted Excel Analysis Skill

Date: 2026-07-15

Status: deployed to the production filesystem; runtime activation pending an
approved API restart.

## Scope

This release updates only the deployed `office-document-parser` skill. It makes
direct, targeted `openpyxl` analysis the default and prevents unrequested
whole-workbook text dumps and intermediate download cards.

It does not change:

- Office upload routing or format allowlists;
- `/mnt/data` mounting and current-conversation isolation;
- CodeAPI, Office converter, frontend file cards, or LibreChat source code;
- user-requested TXT, Markdown, CSV, JSON, Excel, Word, or PowerPoint exports.

## Behavior

- Initial review requests return workbook structure and bounded previews.
- Python filters and aggregates before sending data into model context.
- Findings preserve sheet, row, cell, formula, and identifier references.
- The original workbook is reopened between tool calls instead of being copied
  into a complete text dump.
- Complete exports remain available only when explicitly requested.
- Only requested deliverables should become `/mnt/data` artifacts and download
  cards.

## Test

```sh
node scripts/test-release.js
```

## Deployment

After the release commit is pushed to `origin/main`, run the checked-in remote
transport from a trusted operator machine:

```sh
SSH_PASS='supplied out of band' \
RELEASE_COMMIT='<release-commit>' \
expect scripts/deploy-remote.exp
```

The transport does not contain credentials. It verifies that local `HEAD`
exactly matches `RELEASE_COMMIT`, then uploads only that checked-in release
directory. The production host does not need GitHub credentials or repository
access. The staged runner executes the release test and read-only preflight,
backs up the current skill, and atomically replaces only `SKILL.md`. It does
not restart any container. The release verifies the bind-mounted file hash
inside `LibreChat-API`, confirms the API container ID, start time, and restart
count are unchanged, and checks `/`, `/api/config`, and the protected
`/office/` boundary.

LibreChat deployment skills are loaded into an in-memory
`DeploymentSkillRegistry` during API startup. Replacing the bind-mounted file
without restarting updates the host and container filesystem, but it does not
refresh the running registry's cached `skill.body`. A no-restart deployment
must therefore be recorded as a file deployment, not as runtime activation.

## Rollback

Restore `SKILL.md` from the backup directory reported in `DEPLOY_RESULT.txt`.
Do not restart a container for this rollback. If a new conversation proves the
running API cached the old skill body, report that limitation rather than
restarting without a separately approved release.

## Production Result

Filesystem deployment completed on 2026-07-15 without a container restart.

```text
release_commit=22d0ca4bfc747bcd10673198e85960075ec975d9
timestamp=20260715192958
backup_dir=/opt/librechat/backups/office-targeted-excel-analysis-20260715192958
previous_sha=98e97c17e1753a0b0316e95be8162f68a6adaf88b13951053539f258a8c33c21
deployed_sha=29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a
container_sha=29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a
api_restarted=false
api_restart_count=0
api_config=200
root=200
office=401
```

Only `/opt/librechat/skill/office-document-parser/SKILL.md` changed. The host
and bind-mounted container copies matched the new hash. API container identity,
start time, and restart count remained unchanged.

Runtime source review confirmed that `loadDeploymentSkill()` reads `SKILL.md`
into `skill.body`, and `initializeDeploymentSkills()` replaces the in-memory
registry at startup. No file watcher or supported live-reload path was found.
Consequently the running API still uses the previously cached skill body. A
fresh-conversation behavior pass is intentionally not claimed for this
no-restart release. Activation and browser acceptance require a separately
approved API restart.
