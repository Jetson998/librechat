# Persistent LibreChat Upload Menu Release

Date: 2026-07-12

This release restores and permanently owns the three LibreChat upload choices:

- `图片上传` - `仅图片；用于截图、照片、图像识别`
- `Office文件上传` - `Word/Excel/PPT 原文件；可读写并返回文件`
- `文件提取文字上传` - `转成文本给模型分析；适合审阅总结`

## Root Cause

The patched frontend remained under
`/opt/librechat/ui-label-patch/client-dist`, but the Admin Panel deployment
replaced `compose.override.yaml` without the API frontend mount. The recreated
API container therefore served its clean image copy. The public HTML and menu
lost the patch even though the host artifact still existed.

## Implementation

- `client/business-upload-menu.js` is the repository-owned runtime adapter.
- `scripts/build-upload-menu-client.py` copies the adapter into a frontend
  dist and idempotently injects one script tag.
- `scripts/merge-compose-upload-menu.cjs` preserves the current Compose
  override while adding the read-only API mount.
- `scripts/deploy-upload-menu.sh` builds from the exact running API image,
  validates the candidate, backs up production state, activates the mount,
  recreates only the API service, verifies the public result, and rolls back on
  failure.
- Both Admin Panel override variants and deployment runners retain and verify
  the upload-menu mount.

No database, upload, conversation, generated artifact, Office parser, or
CodeAPI content is changed.

## Test

```bash
python3 scripts/test-upload-menu-release.py
python3 ../2026-07-11-admin-panel/scripts/test-admin-panel-release.py
```

## Deployment

Stage this directory on the production host, then run:

```bash
PREFLIGHT_ONLY=true scripts/deploy-upload-menu.sh /tmp/librechat-upload-menu-release
scripts/deploy-upload-menu.sh /tmp/librechat-upload-menu-release
```

The deployment result is written to `DEPLOY_RESULT.txt` in the staged release.
Timestamped backups are stored under:

```text
/opt/librechat/backups/upload-menu-<timestamp>/
```

## Verification

The automated release verifies:

- root and `/api/config` return successfully;
- `/office/` remains protected with `401`;
- CodeAPI remains healthy;
- Nginx, CodeAPI, and MongoDB containers are unchanged;
- the API has the read-only frontend mount;
- the public HTML has exactly one `business-upload-label-patch` marker;
- the public JavaScript contains all labels, descriptions, and format rules.

Authenticated browser verification is required after deployment. Open a fresh
page, inspect the three menu items and descriptions, and exercise one allowed
and one rejected fixture for each route.
