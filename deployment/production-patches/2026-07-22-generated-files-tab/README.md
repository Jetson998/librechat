# Generated Files Tab Release

Date: 2026-07-22

## Feature

- add `上传的文件` and `生成的文件` tabs to the native `我的文件` dialog;
- keep the existing upload table unchanged;
- list only current-user assistant-delivered `execute_code` files;
- exclude hidden intermediate artifacts and duplicate message references;
- support filename search, pagination, conversation navigation, refresh, and
  authenticated download;
- keep listing separate from model context and conversation attachment logic.

## Included Files

```text
api/generated-files.js
api/user.js
client/generated-files-tab.js
client/generated-files-tab.css
scripts/test-generated-files.js
scripts/test-client-release.py
scripts/fixture.html
scripts/remote-apply.sh
scripts/deploy.sh
```

## Runtime Boundary

Only `LibreChat-API` is recreated. MongoDB, CodeAPI, RAG, Nginx, Admin Panel,
and Office Converter must keep their container identities.

## Rollback

Restore the timestamped `compose.override.yaml` backup and recreate only the API
service. The versioned release directory remains for audit.
