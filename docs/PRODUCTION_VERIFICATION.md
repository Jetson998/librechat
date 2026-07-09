# Production Verification

Target:

```text
https://152.32.172.162.sslip.io/
```

Verification date: 2026-07-10

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
Upload to Provider -> 图片上传
Upload to Code Environment -> Office文件上传
Upload as Text -> 文件提取文字上传
```

The same runtime patch applies client-side file-type guards:

- `图片上传`: image files only.
- `Office文件上传`: DOCX, XLSX, XLSM, PPT, PPTX, CSV, TSV, ODS, ODP.
- `文件提取文字上传`: document, table, PDF, and text-like files.

The menu includes operator descriptions:

- `图片上传`: `仅图片；用于截图、照片、图像识别`
- `Office文件上传`: `Word/Excel/PPT 原文件；可读写并返回文件`
- `文件提取文字上传`: `转成文本给模型分析；适合审阅总结`

Recheck this after frontend rebuilds, asset cleanup, or upstream LibreChat
updates.

## CodeAPI Office Generation

Probe date: 2026-07-09

Authenticated server-side smoke tests confirmed:

- `openpyxl 3.1.5` and `python-pptx 1.0.2` are installed in CodeAPI.
- LibreOffice is available at `/usr/bin/libreoffice`.
- A real CodeAPI `/exec` run generated
  `codeapi_ppt_generation_smoke.pptx` under `/mnt/data` and returned it as an
  artifact.

Operational interpretation:

- Excel parse/edit/generate and PPTX generate are backend-capable.
- A blank LibreChat assistant turn after a PPT request should be diagnosed as
  a model/tool-routing or empty-message issue unless CodeAPI smoke tests fail.
- The 2026-07-09 production `BaseClient.js` patch retried empty Office/PPT
  generation turns once with a stronger Bash/Python instruction and recorded a
  visible fallback if the retry was still empty. This was proven insufficient
  by conversation `29d2e4e5-6007-4874-896a-413a025c1c0b`.
- Repository patch
  `deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/`
  was deployed after commit `73420d3` was pushed to `origin/main`. It first
  handled empty PPT turns by calling CodeAPI `/exec` directly, generating a
  PPTX, saving it into LibreChat uploads, creating a `db.files` row, and
  attaching it to the assistant message.
- User verification in conversation
  `a453c3d4-422f-4867-995a-6d4b7a50c8ac` showed the route also needs to run
  before model tool attempts for explicit PPT output requests. The same test
  also exposed a same-conversation duplicate filename failure in `db.files`;
  generated PPT filenames now need a short unique suffix.
- Follow-up commit `883ac36` was pushed to `origin/main` and deployed on
  2026-07-10. Production verification confirmed the preflight marker and
  unique-filename helper are present in `BaseClient.js`, container
  `node --check` passed, root URL returned `HTTP/2 200`, `/api/config` returned
  JSON, and `LibreChat-CodeAPI` was healthy. The pre-replacement backup for
  this follow-up is
  `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710011244`.
- Deployment verification on 2026-07-10 confirmed:
  `BaseClient.js` marker present, container `node --check` passed, root URL
  returned `HTTP/2 200`, `/api/config` returned JSON, `LibreChat-API` was up,
  and `LibreChat-CodeAPI` was healthy. The pre-replacement backup is
  `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710003919`.
- A fresh user-facing Excel upload and PPT generation test remains the final
  functional verification step.
- Incident `4865a297-3013-40e5-b77a-c5958d79ef16` was repaired by generating
  `API渠道模型来源说明_基础版.pptx` from the uploaded workbook in CodeAPI and
  attaching it to the previously blank assistant message.

## Office/Excel Reader Backend

The LibreChat HTTPS hostname exposes a protected Office converter route:

```text
https://152.32.172.162.sslip.io/office/
```

Observed unauthenticated boundary:

```text
HTTP/2 401
WWW-Authenticate: Basic realm="Office Converter"
```

Operational meaning:

- This is our deployment-level backend capability for reading Office documents,
  especially Excel/XLSX workbooks, before passing extracted content back into a
  LibreChat workflow.
- It is not an upstream LibreChat core route.
- Keep the 401 boundary in place; authenticate before using it with private
  workbooks.

## Stability Probe

Probe date: 2026-07-09

Public boundary checks:

```text
/office/ 10/10 returned 401, time range 0.060-0.112s
/        5/5 returned 200, time range 0.075-0.096s
/api/config 5/5 returned 200, time range 0.062-0.076s
```

Interpretation:

- LibreChat public entry is stable in this short probe.
- `/office/` is reachable and consistently protected by the expected auth
  boundary.
- End-to-end Excel extraction was not re-tested in this probe because it
  requires authenticated access to the Office converter.
