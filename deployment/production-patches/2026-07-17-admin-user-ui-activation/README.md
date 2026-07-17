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

Deployed on 2026-07-17 after commit
`e97962331de8e687ed6af3d8de6964fa65eb83b0`.

```text
timestamp=20260717175908
backup_dir=/opt/librechat/backups/admin-user-ui-activation-20260717175908
image_ref=librechat-admin-panel-user-ui:e6a103c4218b
admin_container_before=b6690f50efae88acf6588d88321328258b56f744cae3e852e5a3560e3a69179a
admin_container_after=bd888ea33f65c88d571c15dd8cff7b9a09be749ffb7ef3566cde56040a5fa8aa
api_and_data_containers_unchanged=true
```

Browser lifecycle acceptance passed:

- `/users` rendered the Users page and the sidebar displayed `用户`;
- created `Codex E2E User` as a verified local `USER`;
- the main LibreChat login endpoint returned `200`, the expected email and
  username, role `USER`, `emailVerified=true`, and a token;
- deleted the temporary user through the Admin Panel;
- the list returned from five users to four and showed the delete-success
  notification;
- a login attempt after deletion returned `404`.

The existing `Gracey` account remained present and was not modified.
