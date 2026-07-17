# Admin User UI Activation Release

This follow-up activates the already implemented Admin Panel Users page after
browser verification found that upstream source still redirected `/users` to
the dashboard and hid the Users sidebar item.

## Scope

- render `UsersPage` at `/users`;
- require `READ_USERS` before rendering the page;
- restore the capability-filtered Users sidebar item;
- rebuild and recreate only `LibreChat-Admin-Panel`.

The deployed Admin API bundle and users route are prerequisites and are
verified by hash and mount path. API, Nginx, MongoDB, CodeAPI, RAG, uploads,
conversations, and model configuration are unchanged.

## Production Result

Pending repository gate, preflight, deployment, and browser lifecycle test.
