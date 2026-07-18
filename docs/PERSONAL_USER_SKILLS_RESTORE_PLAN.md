# Personal User Skills Restore Plan

Date: 2026-07-18

Status: design committed and pushed in `6831848`; implementation and
production deployment pending a separate release commit.

## Requirement

A normal LibreChat `USER` must be able to:

- open the Skills panel;
- create a Skill by writing instructions;
- upload a personal `.md`, `.zip`, or `.skill` package;
- see and select an accessible Skill from the chat `$` picker;
- use the Skill without receiving platform-level Skill administration access.

## Verified Production State

The issue is not a missing personal-Skill backend.

- The `USER` role currently has `SKILLS.USE: true` and
  `SKILLS.CREATE: true`.
- A normal user can open `/skills` directly.
- A normal user can open `/skills/new` and receives the complete Create Skill
  form.
- The active client bundle includes personal Skill creation, import of
  `.md`/`.zip`/`.skill`, ownership grants, file management, and the `$` Skill
  picker.
- The backend creates personal Skills with the authenticated user as author,
  attaches the request tenant, and grants `SKILL_OWNER` to the uploader.
- Deployment Skills such as `office-document-parser` are loaded through the
  separate read-only `DeploymentSkillRegistry` path.

The missing behavior is the normal chat-side Skills entry and `$` picker.

## Root Cause

Production currently sets:

```text
ENDPOINTS=anthropic
```

LibreChat's `getEnabledEndpoints()` therefore removes the built-in `agents`
endpoint from `/api/endpoints`, even though `librechat.yaml` correctly defines:

```text
endpoints.agents.capabilities:
  - skills
```

The client renders the Skills panel and enables the `$` picker only when both
conditions are true:

1. the current role has `SKILLS.USE`; and
2. `/api/endpoints` contains `agents.capabilities` with `skills`.

The first condition passes and the second fails. This creates a partial state:
the direct create route still works, but discovery and selection disappear.

## Change Scope

The release will change only the production `ENDPOINTS` allowlist from:

```text
anthropic
```

to:

```text
anthropic,agents
```

The release will:

- back up the production `.env` before the write;
- replace exactly one `ENDPOINTS` assignment and reject unexpected baselines;
- recreate only the LibreChat API service with `--no-deps`;
- verify that `/api/endpoints` exposes `agents.capabilities` including
  `skills` for a normal `USER`;
- verify personal Skill create/import routes remain ownership-scoped;
- verify the Office deployment Skill remains loaded and unchanged;
- verify MongoDB, CodeAPI, RAG-API, Nginx, Admin Panel, and client container IDs
  do not change.

No frontend bundle patch, prompt workaround, Mongo permission rewrite, or
platform Skill-management grant is needed.

## Security And Isolation

- Do not grant `READ_SKILLS` or `MANAGE_SKILLS` system capabilities to normal
  users. Those capabilities protect platform/deployment Skill synchronization.
- Personal Skill list and file APIs continue to use resource ACLs and tenant
  context.
- New personal Skills continue to receive `SKILL_OWNER` for the uploader only.
- Other users' private Skills must not appear in the uploader's list or `$`
  picker.
- Deployment Skills remain non-editable through personal Skill mutation routes.
- Import remains limited to `.md`, `.zip`, and `.skill`, with existing archive,
  path traversal, entry-count, and decompressed-size validation.

## Deployment Procedure

1. Record the current `.env` hash, `ENDPOINTS` value, API image, API container
   ID, and neighboring container IDs.
2. Back up `.env` to a timestamped directory under
   `/opt/librechat/backups/`.
3. Atomically replace only `ENDPOINTS=anthropic` with
   `ENDPOINTS=anthropic,agents`.
4. Recreate only `api` with:

   ```bash
   docker compose up -d --no-deps --force-recreate api
   ```

5. Verify API health, enabled endpoints, deployment-Skill loading, neighboring
   containers, Office protection, and CodeAPI health.
6. Run browser acceptance as a normal `USER`: upload a temporary Skill, confirm
   it appears in My Skills and the `$` picker, then remove the temporary Skill.
7. Record the deployment result and push it to `origin/main`.

## Rollback

On any failure after the `.env` write:

1. restore the timestamped `.env` backup;
2. recreate only `api` with `--no-deps`;
3. verify the previous `ENDPOINTS=anthropic` state and normal service health;
4. leave personal Skill documents and user data untouched.

## Acceptance Criteria

- A normal `USER` sees the Skills navigation entry.
- The normal user can choose Write Instructions or Upload Skill.
- `.md`, `.zip`, and `.skill` are the only accepted Skill package extensions.
- A temporary uploaded Skill is owned by the uploader and visible in My Skills.
- The temporary Skill appears in the chat `$` picker.
- Another normal user cannot see the private temporary Skill.
- The deployment `office-document-parser` Skill remains available and cannot be
  edited as a personal Skill.
- `READ_SKILLS` and `MANAGE_SKILLS` are not granted to the `USER` role.
- Only the API container is recreated; adjacent service container IDs stay
  unchanged.
