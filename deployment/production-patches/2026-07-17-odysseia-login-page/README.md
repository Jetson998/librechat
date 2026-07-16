# Odysseia Login Page Release

Date: 2026-07-17

This release adds an Odysseia login-page runtime skin to the main LibreChat
frontend. It keeps the upstream LibreChat bundle intact and injects one
additional script into the mounted frontend dist:

```text
odysseia-login-page-patch -> /odysseia-login.js
```

## User-Visible Effect

- The unauthenticated email/password login page uses the Odysseia visual style.
- The page keeps the current right-side dark glass login panel direction.
- The heading is `Start your Agent Studio.` with normal `font-weight: 400`.
- The panel contains subtle mythology line art instead of the removed planet
  logo.
- The background references the approved video URL:
  `https://image01.vidu.zone/vidu/landing-page/login-bg.c7293340.mp4`.

The patch activates only when the page contains an email/username input,
password input, and a submit control. It removes the active skin class when that
login form is no longer present, so authenticated chat pages are not restyled.

## Scope

Changed:

- Frontend static `index.html` injection.
- New static runtime script `odysseia-login.js`.

Not changed:

- LibreChat source bundle.
- Database.
- Model/provider configuration.
- Conversations, files, uploads, CodeAPI, Office parser, or `/office/`.
- Existing `business-upload-label-patch` upload menu script.

## Test

```bash
python3 scripts/test-odysseia-login-release.py
```

The test verifies builder idempotence, coexistence with
`business-upload-label-patch`, script contract strings, JavaScript syntax, deploy
guards, and basic secret patterns.

## Deployment

Stage this directory on the production host, then run:

```bash
PREFLIGHT_ONLY=true scripts/deploy-odysseia-login.sh /tmp/librechat-odysseia-login-release
scripts/deploy-odysseia-login.sh /tmp/librechat-odysseia-login-release
```

For the repository-gated path, push the implementation commit to `origin/main`
first, then run:

```bash
scripts/run-remote-release.sh <commit-sha>
```

The deployment script copies the current running `/app/client/dist`, injects the
Odysseia script idempotently, preserves `business-upload-label-patch`, writes a
new read-only `ui-label-patch` directory, recreates only the API container, and
rolls back on failure.

## Verification

Automated verification requires:

- `/` and `/api/config` return successfully.
- `/office/` remains protected with HTTP `401`.
- CodeAPI remains healthy.
- Nginx, CodeAPI, and MongoDB container IDs remain unchanged.
- Public HTML contains exactly one `odysseia-login-page-patch` marker.
- Public HTML still contains exactly one `business-upload-label-patch` marker.
- `/odysseia-login.js` contains `Odýsseia Studio`,
  `Start your Agent Studio.`, `font-weight: 400`, and the video URL.
- `/business-upload-menu.js` still contains `Office文件上传`.

Browser verification after deployment:

1. Open a fresh unauthenticated browser session.
2. Confirm the login page shows Odysseia Studio branding.
3. Confirm `Start your Agent Studio.` is not bold.
4. Confirm the login form is usable.
5. Sign in and confirm the chat app is not restyled as a login page.

## Rollback

Restore the timestamped backup directory printed in `DEPLOY_RESULT.txt`:

```bash
cp -a /opt/librechat/backups/odysseia-login-<timestamp>/ui-label-patch-before \
  /opt/librechat/ui-label-patch
cd /opt/librechat
docker compose up -d --no-deps --force-recreate api
```

Then verify `/api/config`, login, and `business-upload-label-patch`.
