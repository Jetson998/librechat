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

For the committed production path, send and run
`scripts/run-remote-release.sh`. It clones the public repository, checks out
the pinned implementation commit `dfbe7a4`, runs both release test suites,
runs preflight, and only then starts the production deployment. It does not use
or store a GitHub PAT.

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

To prove the fix survives the same class of container replacement that caused
the incident, run:

```bash
scripts/verify-upload-menu-persistence.sh
```

It force-recreates only `LibreChat-NGINX`, asserts that API, CodeAPI, and
MongoDB container identities remain unchanged, then verifies the public patch
marker, JavaScript contract, Office boundary, and hashes again.

## Production Result

Deployment completed on 2026-07-12 from implementation commit `dfbe7a4`.

```text
timestamp=20260712020837
backup_dir=/opt/librechat/backups/upload-menu-20260712020837
public_index_sha256=decb4df509099e61a8fd9c03b7121a9bb76a4c49b26ff2b51134678cd982cb2f
public_script_sha256=a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9
patch_marker_count=1
```

The API container was recreated with the read-only frontend mount. Nginx,
CodeAPI, and MongoDB remained unchanged during deployment. A separate
persistence test then force-recreated Nginx and confirmed that the public HTML
and JavaScript hashes did not change; API, CodeAPI, and MongoDB container IDs
again remained unchanged.

Authenticated Chrome verification passed before and after the Nginx
recreation. The menu showed the three required entries in the required order,
with all three descriptions. The browser controller did not allow attaching a
local synthetic fixture, so no automated file-selection rejection was sent to
the production conversation. Format contracts remain covered by the committed
release test and the verified public JavaScript hash.

Exact evidence is stored in `results/latest/DEPLOY_RESULT.txt`.
