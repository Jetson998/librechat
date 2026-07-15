# Targeted Excel Analysis Skill

Date: 2026-07-15

Status: planned; not yet deployed.

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

## Rollback

Restore `SKILL.md` from the backup directory reported in `DEPLOY_RESULT.txt`.
Do not restart a container for this rollback. If a new conversation proves the
running API cached the old skill body, report that limitation rather than
restarting without a separately approved release.

## Production Result

Pending deployment and fresh-conversation acceptance.
