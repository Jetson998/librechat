# Admin Panel User Creation

Date: 2026-07-17

Status: deployed and browser lifecycle acceptance passed.

## Objective

Make `用户管理 -> 添加用户` create a real local LibreChat login account.
Keep public registration disabled and preserve the existing CLI account
lifecycle as an operational fallback.

## Confirmed Gap

- The Admin Panel already renders `CreateUserDialog`.
- Its `createUserFn` throws `Not implemented`.
- LibreChat exposes `/api/admin/users` for list and search only in production.
- The production route has a prepared `MANAGE_USERS` capability middleware,
  but the write route is not mounted.

## API Contract

Add `POST /api/admin/users` with this JSON body:

```json
{
  "name": "Example User",
  "email": "user@example.local",
  "username": "example",
  "password": "operator supplied secret",
  "role": "USER",
  "emailVerified": true
}
```

Requirements:

- require JWT authentication, Admin Panel access, and `MANAGE_USERS`;
- validate and normalize all non-secret fields before invoking registration;
- reject duplicate email or username with HTTP 409;
- use LibreChat's supported registration service for password hashing and user
  initialization;
- allow only `USER` or `ADMIN` roles;
- never log, persist outside the user record, or return the plaintext password;
- return a sanitized user object on HTTP 201.

## Admin Panel UX

The create dialog must include:

- name;
- email;
- username, defaulted from the email local part when empty;
- password and confirmation fields;
- role selector;
- email-verified checkbox, enabled by default.

The submit action must display validation and API errors, invalidate the user
list on success, and clear password fields when closing.

## Release Gate

1. Commit and push this design before implementation.
2. Base the API patch on the active production files, not a stale bundle.
3. Add focused API-handler and Admin Panel tests.
4. Run typecheck, tests, production bundle syntax checks, and Admin Panel build.
5. Commit and push the complete release before production writes.
6. Back up every replaced host file and preserve rollback commands.
7. Restart only the API and Admin Panel services required to load the change.
8. Create a temporary user through the browser, verify login, then delete it
   through the supported lifecycle before recording success.

## Preflight Baseline Correction

The first production preflight on 2026-07-17 stopped before any build or write
because `/opt/librechat/office-context-patch/api-index.cjs` did not match the
active container hash. Read-only inspection established that this file is a
historical July 11 patch and is no longer mounted after the July 17 API
recreation.

The release therefore uses the active API container bundle as its only code
baseline and installs the candidate at the release-scoped host path
`/opt/librechat/admin-user-creation/api-index.cjs`. The historical Office file
is neither overwritten nor reactivated as part of this change.

## Production Build Resource Guard

The production host has approximately 4 GB RAM and initially had no swap. A
full Admin Panel TypeScript check exhausted available memory during preflight,
making HTTPS and SSH temporarily unavailable. No release files had been
applied, and the existing containers recovered after the host restarted.

This release now requires a dedicated 4 GB persistent build swap file before
Docker build. The setup is idempotent and does not restart services. The
runner blocks the build unless swap and combined memory thresholds are met,
and the TypeScript process is capped to a 1 GB Node heap.

## UI Activation Follow-up

Post-deployment browser verification found that upstream Admin Panel source
still redirected `/users` to `/` and kept the Users sidebar item commented
out. The API and form were deployed correctly but were unreachable through the
visible interface.

The follow-up release activates the existing Users page, guards it with
`READ_USERS`, restores the capability-filtered sidebar item, and recreates only
the Admin Panel. The already deployed API, Nginx, MongoDB, and CodeAPI must keep
their container IDs.

Production deployment recreated only the Admin Panel. Browser verification
created a temporary verified local user, confirmed a successful main LibreChat
login, deleted the user through the Admin Panel, and confirmed the deleted
credentials returned `404`. The pre-existing `Gracey` account remained intact.

## Rollback

Restore the timestamp-matched API bundle, admin users route, Admin Panel image,
and Compose override backups. Recreate only the API and Admin Panel services,
then verify existing account login and `/api/admin/users` list access.
