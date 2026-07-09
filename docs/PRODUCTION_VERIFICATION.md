# Production Verification

Target:

```text
https://152.32.172.162.sslip.io/
```

Verification date: 2026-07-09

## External Checks

Root headers:

```text
HTTP/2 200
server: nginx/1.20.1
content-type: text/html; charset=utf-8
x-robots-tag: noindex
cache-control: no-cache, no-store, must-revalidate
```

Root HTML:

```text
title: LibreChat
main asset: ./assets/index.P3glMaNP.js
```

Main asset headers:

```text
HTTP/2 200
content-type: application/javascript; charset=UTF-8
last-modified: Wed, 08 Jul 2026 10:38:03 GMT
```

`/api/config` highlights:

```json
{
  "appTitle": "LibreChat",
  "serverDomain": "https://152.32.172.162.sslip.io",
  "emailLoginEnabled": true,
  "registrationEnabled": false,
  "passwordResetEnabled": false,
  "socialLoginEnabled": false,
  "buildInfo": {
    "commit": "8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9",
    "commitShort": "8fcb77f",
    "branch": "main",
    "buildDate": "2026-07-05T16:06:59Z"
  }
}
```

`/api/health` result:

```json
{"message":"Endpoint not found"}
```

This means `/api/health` should not be used as the primary health check unless
the backend later adds that route.

## Runtime Patch Observed

The delivered HTML contains a script with id:

```text
business-upload-label-patch
```

Observed label mappings include:

```text
Upload to Provider -> 原文件上传
Upload as Text -> 提取文字上传
Upload to Code Environment -> 用代码读取文件
```

Recheck this after frontend rebuilds, asset cleanup, or upstream LibreChat
updates.
