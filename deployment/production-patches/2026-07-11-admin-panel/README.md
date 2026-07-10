# LibreChat Admin Panel Production Release

Date: 2026-07-11

This release deploys the official LibreChat Admin Panel at:

```text
https://admin.152.32.172.162.sslip.io/
```

It also adds the bundled OpenAI icon to the `GPT-5.6 SOL` model spec. It does
not modify LibreChat application source, compiled frontend bundles, Office
handling, CodeAPI, MongoDB messages, uploads, or generated artifacts.

## Production Findings

- Production uses upstream commit `8fcb77f` and Docker Compose from
  `/opt/librechat/compose.yaml`.
- `Bill` and `Admin` are both LibreChat `ADMIN` users.
- The MongoDB `configs` collection was empty before implementation. There was
  no Admin Config override replacing the committed default model.
- The reported Fable default was reproduced in a browser tab that remained
  loaded across the previous config deployment. A fresh startup config must be
  verified after a hard reload.
- The production host is `x86_64`; the Admin Panel image is pinned to the
  resolved amd64 digest.
- The existing `ADMIN_PANEL_SESSION_SECRET` is present in production `.env` and
  is not stored in this repository.

## Files

```text
librechat.yaml
compose.override.yaml
client-nginx.conf
host-nginx-http.conf
host-nginx.conf
scripts/test-admin-panel-release.py
scripts/deploy-admin-panel.sh
```

The Admin Panel has no published host port. The existing inner Nginx routes
the Admin hostname to `admin-panel:3000` on the Compose network, while host
Nginx continues to proxy through `127.0.0.1:3081`.

## Test

```bash
python3 scripts/test-admin-panel-release.py
```

## Deployment

Stage this directory on the production server, then run:

```bash
PREFLIGHT_ONLY=true scripts/deploy-admin-panel.sh /tmp/librechat-admin-panel-release
scripts/deploy-admin-panel.sh /tmp/librechat-admin-panel-release
```

The runner validates the empty Admin Config boundary, pinned image,
architecture, Compose merge, DNS, ACME challenge route, certificate, container
state, main application, Office authentication boundary, CodeAPI health,
default model, and GPT icon. Timestamped backups are written under:

```text
/opt/librechat/backups/admin-panel-<timestamp>/
```

Any failure after the first production write restores `.env`,
`librechat.yaml`, `compose.override.yaml`, both Nginx layers, the main API, and
the existing client service. The issued certificate may remain unused after a
rollback; no MongoDB restore or message rewrite is performed.
