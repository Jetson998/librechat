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

## Production Result

Deployment completed on 2026-07-17 from repository commit
`447a17633510762f1c773336c2f921e7a30ea974`. The implementation commit was
pushed to `origin/main` before the production write.

Because the production host could not clone the GitHub repository over HTTPS
without credentials, the release directory was staged from a local
`git archive` of the same pushed commit and then executed on the host.

```text
timestamp=20260717115644
backup_dir=/opt/librechat/backups/odysseia-login-20260717115644
api_image=registry.librechat.ai/danny-avila/librechat-dev-api:latest
api_container_before=d8939269903e6ededc46118f4a02ee5d3a5351a6e5f17d89ce2882c8c952e685
api_container_after=d67f514c468ebbd81d7a5f637dfd283f4a66876712a6585fb8f96586e77da680
nginx_container_unchanged=true
codeapi_container_unchanged=true
mongo_container_unchanged=true
compose_mount=/opt/librechat/ui-label-patch/client-dist:/app/client/dist:ro
public_index_sha256=6227db29a08eff17d6674cd0ae7225fde944076660a2d92d0c372b594cc5fd24
public_script_sha256=2471b8a06d8c08081eb63c43e69d7efbf7e2648e7ff5839a143b5980b1ca50d5
public_upload_script_sha256=a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9
office_status=401
codeapi_health=healthy
patch_marker_count=1
```

External post-deploy checks confirmed:

- Public HTML contains `odysseia-login-page-patch`.
- Public HTML still contains `business-upload-label-patch`.
- `/odysseia-login.js` contains `Odýsseia Studio`,
  `Start your Agent Studio.`, `font-weight: 400`, and the video URL.
- `/business-upload-menu.js` still contains `Office文件上传`,
  `图片上传`, and `文件提取文字上传`.
- `/office/` still returns HTTP `401`.

## Rollback

Restore the timestamped backup directory printed in `DEPLOY_RESULT.txt`:

```bash
cp -a /opt/librechat/backups/odysseia-login-<timestamp>/ui-label-patch-before \
  /opt/librechat/ui-label-patch
cd /opt/librechat
docker compose up -d --no-deps --force-recreate api
```

Then verify `/api/config`, login, and `business-upload-label-patch`.
