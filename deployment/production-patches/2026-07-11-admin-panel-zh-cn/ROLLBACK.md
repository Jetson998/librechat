# Admin Panel Simplified Chinese Rollback

Scope: revert only the standalone Admin Panel image deployed by this release.

Do not use this rollback to change:

- LibreChat API
- LibreChat main frontend
- MongoDB data or `configs`
- CodeAPI
- Office helper route
- Nginx routing

## Trigger Conditions

Run this rollback if any of the following are true after deployment:

- Admin login page fails to load or returns non-`200`
- Admin container is not `healthy`
- Chinese build renders broken assets or broken navigation
- Admin saves fail unexpectedly
- Browser-visible localization regression blocks normal admin use

## Production Facts

Current released image:

```text
librechat-admin-panel-zh-cn:95388ccb14d2
```

Backup captured at deploy time:

```text
/opt/librechat/backups/admin-panel-zh-cn-20260711231635
```

Previous official image:

```text
registry.librechat.ai/clickhouse/librechat-admin-panel@sha256:1d3916ae84439e83da83507afd4aae14a99bd81ff2e1890079f57d8d377eb8e9
```

## Rollback Steps

1. Log in to production host and confirm the backup exists:

   ```bash
   test -d /opt/librechat/backups/admin-panel-zh-cn-20260711231635
   test -f /opt/librechat/backups/admin-panel-zh-cn-20260711231635/compose.override.yaml
   ```

2. Restore the pre-release Compose override:

   ```bash
   cp -a /opt/librechat/backups/admin-panel-zh-cn-20260711231635/compose.override.yaml /opt/librechat/compose.override.yaml
   ```

3. Recreate only the Admin Panel service:

   ```bash
   cd /opt/librechat
   docker compose up -d --no-deps --force-recreate admin-panel
   ```

4. Wait for the Admin Panel container to become healthy:

   ```bash
   docker inspect LibreChat-Admin-Panel --format '{{.State.Health.Status}}'
   ```

5. Verify the running Admin Panel image is back on the official digest:

   ```bash
   docker inspect LibreChat-Admin-Panel --format '{{.Config.Image}}'
   docker inspect LibreChat-Admin-Panel --format '{{.Image}}'
   ```

## Required Post-Rollback Checks

All of the following must pass:

- `https://admin.152.32.172.162.sslip.io/` returns `200`
- `https://152.32.172.162.sslip.io/` returns `200`
- `https://152.32.172.162.sslip.io/api/config` returns `200`
- `https://152.32.172.162.sslip.io/office/` returns `401`
- `WWW-Authenticate` realm remains `Office Converter`
- `LibreChat-API`, `LibreChat-NGINX`, `LibreChat-CodeAPI`, and `chat-mongodb`
  container IDs remain unchanged from pre-rollback values

Recommended commands:

```bash
curl -fsS https://admin.152.32.172.162.sslip.io/ >/dev/null
curl -fsS https://152.32.172.162.sslip.io/ >/dev/null
curl -fsS https://152.32.172.162.sslip.io/api/config >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)" = "401"
test "$(curl -ksSI https://152.32.172.162.sslip.io/office/ | tr -d '\r' | awk -F': ' 'tolower($1)=="www-authenticate" {print $2; exit}')" = 'Basic realm="Office Converter"'
```

## Recording Requirement

After rollback:

1. Record the exact trigger and time.
2. Record the restored backup path.
3. Record the final Admin image ref and image ID.
4. Commit the rollback note or verification result back to this repository
   before any follow-up production change.
