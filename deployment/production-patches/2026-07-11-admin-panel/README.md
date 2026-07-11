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

## Production Result

Final deployment timestamp:

```text
20260711103411
```

Backup:

```text
/opt/librechat/backups/admin-panel-20260711103411
```

The official image is pinned to:

```text
registry.librechat.ai/clickhouse/librechat-admin-panel@sha256:1d3916ae84439e83da83507afd4aae14a99bd81ff2e1890079f57d8d377eb8e9
```

The first production attempt exposed a bind-mount refresh issue: replacing the
host copy of `client/nginx.conf` did not replace the inode already mounted in
the running `LibreChat-NGINX` container. The Admin hostname therefore reached
the wrong frontend even though the candidate file was correct. Commit
`e041f23` added a forced client-container recreation and Admin-content
assertions. The corrected deployment passed.

Authenticated verification confirmed:

- `admin@example.local` signs in with role `ADMIN`.
- The Admin password was synchronized to the current Bill password with an
  existing server-side operation after production drift was discovered; no
  credential or hash is tracked here.
- Dashboard and Configuration load, including the custom endpoint and the two
  model specs `gpt-5.6-sol` and `claude-fable-5`.
- A fresh main-site tab defaults to `GPT-5.6 SOL` and loads
  `/assets/openai.svg`.
- Standalone Fable selection and response work, and a separate fresh tab after
  that check returns to the GPT default.
- Root, `/api/config`, Admin root, the Office authentication boundary, CodeAPI
  health, the unexposed Admin port, and the empty MongoDB `configs` boundary
  passed the corrected deployment assertions.

Post-deployment mixed-provider testing found a separate residual behavior:
continuing a GPT conversation after switching it to Fable can produce an empty
Claude assistant message, while a standalone Fable conversation succeeds. The
Admin release does not patch that behavior. It must be handled as a separate,
design-first cross-endpoint history issue; do not add a production hotfix to
this release.

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

The deployment force-recreates `LibreChat-NGINX` after replacing its
bind-mounted configuration. This is required because changing the host file
does not update the inode already mounted in a running container.

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
default model, GPT icon, and that the Admin hostname serves Admin Panel HTML
rather than the main chat client. Timestamped backups are written under:

```text
/opt/librechat/backups/admin-panel-<timestamp>/
```

Any failure after the first production write restores `.env`,
`librechat.yaml`, `compose.override.yaml`, both Nginx layers, the main API, and
the existing client service. The issued certificate may remain unused after a
rollback; no MongoDB restore or message rewrite is performed.
