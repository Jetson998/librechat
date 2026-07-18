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
role-document preservation, rollback, and forbidden platform permission
changes.

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

Pending implementation commit, preflight, deployment, and normal-USER browser
acceptance.
