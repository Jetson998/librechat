# Admin Panel User Creation

Date: 2026-07-17

Status: implementation committed; corrected production preflight pending.

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

## Rollback

Restore the timestamp-matched API bundle, admin users route, Admin Panel image,
and Compose override backups. Recreate only the API and Admin Panel services,
then verify existing account login and `/api/admin/users` list access.
