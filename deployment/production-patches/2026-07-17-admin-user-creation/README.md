# Admin Panel User Creation Release

This release makes `用户管理 -> 添加用户` create a real local LibreChat
account through a capability-protected Admin API.

## Scope

- add `POST /api/admin/users` guarded by `ACCESS_ADMIN` and `MANAGE_USERS`;
- validate name, email, username, password, role, and email verification;
- use LibreChat's supported registration service and return a sanitized user;
- make password properties non-enumerable before calling the registration
  service so existing error logging cannot serialize them;
- complete the Admin Panel form and bilingual text;
- enable the existing capability-protected delete route, which the visible
  user-management page already exposes.

Public registration remains disabled. Office, CodeAPI, model configuration,
uploads, conversations, and existing users are unchanged.

## Source

The API patch was downloaded from the active production container before
editing. Baseline hashes are recorded in `BASELINE_SHA256`.

The production preflight also found a historical July 11 bundle at
`/opt/librechat/office-context-patch/api-index.cjs`. It was not mounted in the
running API after the July 17 Web Search recreation, so it is not the active
baseline. This release leaves that historical file untouched and installs its
candidate under the scoped path below:

```text
/opt/librechat/admin-user-creation/api-index.cjs
```

Admin Panel source:

```text
../2026-07-11-admin-panel-zh-cn/source
```

## Tests

```bash
python3 scripts/test-release.py
node scripts/test-api-handler.js api-patch/api-index.cjs
```

The API behavior test is intended to run inside the production API container
against a temporary copy of the candidate bundle. The Admin Panel Docker build
runs the focused server test, TypeScript checking, locale checks, and the
production build.

## Deployment

The committed runner:

```bash
scripts/build-and-deploy.sh /tmp/librechat-admin-user-creation
```

The stage directory must contain this release as its root and a committed
Admin Panel source copy at `admin-panel-source`.

Only `LibreChat-API` and `LibreChat-Admin-Panel` are recreated. Nginx, Mongo,
CodeAPI, Office Converter, and all other services must retain their container
IDs.

The runner gates the bundle hash against the running API container, verifies
that no competing bundle mount is active, then mounts the committed candidate
and admin users route from `/opt/librechat/admin-user-creation/`. Rollback
restores the previous Compose override and therefore returns the API to its
image bundle without touching the historical Office patch archive.

## Production Result

Pending implementation gate, deployment, browser verification, and repository
closeout.
