# Personal User Skills Restoration

This release restores LibreChat's personal Skills discovery path for normal
`USER` accounts.

## Root Cause

Production had the correct `SKILLS.USE` and `SKILLS.CREATE` role permissions,
the personal Skill CRUD/import backend, and `skills` in
`endpoints.agents.capabilities`. The process environment still set:

```text
ENDPOINTS=anthropic
```

That filtered `agents` out of `/api/endpoints`. The client requires
`agents.capabilities` to contain `skills` before it renders the Skills panel or
the chat `$` picker, so direct `/skills/new` access worked while normal
discovery disappeared.

## Scope

The release changes exactly one production `.env` assignment:

```text
ENDPOINTS=anthropic,agents
```

It then recreates only the Compose `api` service with `--no-deps`.

It does not change:

- USER, ADMIN, or system capabilities;
- personal Skill records, ACLs, or files;
- deployment Skills;
- LibreChat frontend assets;
- `librechat.yaml`;
- Admin Config or MongoDB configuration documents;
- Office, CodeAPI, RAG-API, Nginx, Admin Panel, or storage services.

## Repository Gate

The design and isolation boundary are recorded in
`docs/PERSONAL_USER_SKILLS_RESTORE_PLAN.md` and were pushed before this release
implementation.

## Tests

```bash
python3 scripts/test-release.py
```

The test checks the exact old/new endpoint values, atomic `.env` replacement,
API-only recreation, neighboring-service guards, deployment-Skill guards,
role-document preservation, rollback, forbidden platform permission changes,
and the repository-owned normal-user upload fixture.

The reusable browser fixture is:

```text
fixtures/personal-skill-upload-smoke.md
```

## Deployment

Run a read-only preflight first:

```bash
PREFLIGHT_ONLY=true bash scripts/deploy.sh
```

Then deploy from a staged copy of this release:

```bash
bash scripts/deploy.sh
```

The script backs up `/opt/librechat/.env` under
`/opt/librechat/backups/personal-user-skills-<timestamp>/` before any write.

## Browser Acceptance

After deployment, use a normal `USER` account to verify:

1. Skills is visible in the control panel.
2. The create menu offers Write Instructions and Upload Skill.
3. A temporary `.md` Skill uploads and appears under My Skills.
4. The Skill appears in the chat `$` picker.
5. A second normal user cannot list the private temporary Skill.
6. The temporary Skill is deleted after acceptance.

## Rollback

On any post-write failure the deployment script restores the timestamped
`.env` backup and recreates only `api`. Personal Skill documents and user data
are never rewritten.

## Production Result

Deployment date: 2026-07-18 HKT.

Repository gates:

- `ec0697f` recorded the personal User Skills design and isolation boundary.
- `af98ce9` implemented the guarded `ENDPOINTS=anthropic,agents` release.

Production deployment:

```text
timestamp=20260718161656
backup_dir=/opt/librechat/backups/personal-user-skills-20260718161656
endpoints_after=anthropic,agents
api_recreated=true
protected_services_unchanged=true
office_skill_sha=29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a
```

Browser acceptance:

- normal `USER` Gracey displayed Skills, My Skills, Write skill instructions,
  and Upload a skill;
- a form-created personal Skill appeared in the `$` picker and returned
  `PERSONAL_SKILL_E2E_OK` when invoked;
- `fixtures/personal-skill-upload-smoke.md` uploaded successfully, was active
  by default, appeared in the `$` picker, and returned
  `PERSONAL_SKILL_UPLOAD_SMOKE_OK` when invoked;
- both temporary personal Skills were deleted after acceptance;
- ADMIN Bill displayed the same create, upload, and `$` invocation paths after
  refresh, plus the separate Administrator Settings entry;
- the deployment `office-document-parser` Skill remained present and was not
  used as the personal-Skill test fixture.

The `$` picker intentionally lists active, user-invocable Skills. A newly
created or uploaded personal Skill was active by default in both acceptance
flows.

Acceptance: passed for the standard `USER` and `ADMIN` personal Skill paths.
No platform Skill-management capability was added to normal users.
