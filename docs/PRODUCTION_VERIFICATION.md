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
- Fresh user-facing Excel upload and PPT generation verification passed in
  conversation `d512f145-574e-4a91-8bda-b047c10c07e9` on 2026-07-10
  01:16 HKT. The user uploaded
  `模型_API_服务能力表_含GLM__1_.xlsx` through the Office upload path, and the
  preflight route generated assistant attachment
  `API渠道模型来源说明_基础版_bee83a55.pptx` (`29275` bytes,
  `messageId: bee83a55-99a5-4a8b-8230-c4f1a9627308`,
  `file_id: e1a6d20b-89e6-428a-9e7b-9f3369d4333b`). API logs showed
  `[BaseClient] Office/PPT generation request; running deterministic CodeAPI
  preflight`; CodeAPI logs showed `/exec` returned `200 OK`. No duplicate
  filename error was observed.
- UI follow-up: the same conversation showed the assistant text but no visible
  download card because the generated PPT was present only in
  `responseMessage.attachments`. The 2026-07-10 follow-up patch mirrors
  deterministic PPT outputs into `responseMessage.files` so the frontend
  renders a normal downloadable file card.
- General file-card follow-up: CodeAPI tool artifacts for Excel/CSV, Word,
  Markdown/text, PDF, images, and other real generated files can hit the same
  frontend visibility issue if they are stored only in
  `responseMessage.attachments`. The general fix mirrors downloadable
  generated artifacts with `file_id` into `responseMessage.files`, while
  leaving display-only tool attachments such as search/UI resources in
  `attachments` only.
- General file-card fix was deployed on 2026-07-10 01:41 HKT after commit
  `5283696` was pushed. Backup:
  `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710014142`.
  Checksum changed from
  `1ef62a50021491d4a962376e99e50ecdeeba19da1c405553ec5189cecd8291c3` to
  `774120c7ecc38897887f41bf7a676f55b4f179b955f456569e8bced42a80ff34`.
  Production verification confirmed container `node --check` passed,
  `isDownloadableMessageFile`, `appendDownloadableMessageFiles`,
  `artifactAttachments`, and `responseMessage.files` markers were present, and
  server-local `/api/config` returned JSON.
- Conversation `b214cc21-95bb-4721-979d-893f637b094f` showed that the saved
  LibreChat messages did not contain cross-conversation `files` or
  `attachments`, but the model called Bash with `find /srv/codeapi-data/sessions`
  and received a listing of other CodeAPI sessions. This is a CodeAPI storage
  exposure and tool-output token inflation issue, not a Mongo conversation
  linkage issue. The first mitigation is a code-execution storage guard in
  `ToolService.js`, plus prompt constraints that restrict file work to
  `/mnt/data` and current-message files.
- The same conversation used the wording `做出 1 页 ppt`; the preflight trigger
  now includes `做出`, `做成`, `做一张`, and `做一份` so these Office/PPT
  requests go through deterministic backend generation instead of model-led
  global file discovery.
- CodeAPI session enumeration guard was deployed on 2026-07-10 02:01 HKT after
  commits `14e17fe` and `ec8179a` were pushed. Backups:
  `/opt/librechat/librechat.yaml.bak-20260710020149`,
  `/opt/librechat/office-context-patch/ToolService.js.bak-20260710020149`,
  and `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710020149`.
  Checksums changed to
  `3da74bf821b7cc26b1b449b3e93138a0f33ab28a3d70bd258a03a4a2fa7c1f14`
  (`librechat.yaml`),
  `29d117046ed8ed7c9f8880b222b452fc3f4b096d7bad5ba346f935602118e0cd`
  (`ToolService.js`), and
  `fd406df87154d26ef2ef6caeb4a4125d5ad82c2e5a4eaf1e2db8239ced6bbcdf`
  (`BaseClient.js`). Production verification confirmed container
  `node --check` passed for both JS files, guard/preflight markers were present,
  `LibreChat-CodeAPI` was healthy, and server-local `/api/config` returned
  JSON.
- Existing bloated unsafe tool outputs in conversation
  `b214cc21-95bb-4721-979d-893f637b094f` should be redacted with repository
  script
  `deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/scripts/redact-unsafe-codeapi-session-tool-outputs.js`
  before continuing that same conversation.
- The same conversation was redacted on 2026-07-10 02:05 HKT, targeting
  assistant message `bd55ca81-0a53-4bd4-805b-4ce6c2191d3f`. Result:
  `scannedMessages: 1`, `updatedMessages: 1`, `redactedParts: 9`;
  verification showed `unsafeOutputs: 0`, `unsafeArgs: 0`, and
  `redactedOutputs: 4`.
- Follow-up deployment on 2026-07-10 01:24 HKT replaced production
  `BaseClient.js` after commit `b15b743` was pushed. Backup:
  `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710012446`.
  Checksum changed from
  `8f21565c7941774d20b2164cc0f3096b55048c5cb0a74e3332164588cb49d8c0` to
  `1ef62a50021491d4a962376e99e50ecdeeba19da1c405553ec5189cecd8291c3`.
  Production verification confirmed container `node --check` passed,
  `responseMessage.files` and `shouldAddFileContext` markers were present, and
  server-local `/api/config` returned JSON.
- Existing message `bee83a55-99a5-4a8b-8230-c4f1a9627308` in conversation
  `d512f145-574e-4a91-8bda-b047c10c07e9` was backfilled with
  `files[0].file_id: e1a6d20b-89e6-428a-9e7b-9f3369d4333b` using the
  repository script
  `deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/scripts/backfill-deterministic-ppt-message-files.js`.
- Incident `4865a297-3013-40e5-b77a-c5958d79ef16` was repaired by generating
  `API渠道模型来源说明_基础版.pptx` from the uploaded workbook in CodeAPI and
  attaching it to the previously blank assistant message.
- Follow-up deployment on 2026-07-10 03:15 HKT after commit `d5325cf` added a
  generic `.pptx` transform fallback for visual/theme/layout requests and fixed
  the code-execution storage guard return shape for `content_and_artifact` tools.
  Production backups were:
  `/opt/librechat/librechat.yaml.bak-20260710031519`,
  `/opt/librechat/office-context-patch/ToolService.js.bak-20260710031519`, and
  `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710031519`.
  Post-restart verification confirmed container `node --check` passed for
  `BaseClient.js` and `ToolService.js`, markers `PPT/PPTX transform request`,
  `officePptTransformFallback`, `deterministic_office_ppt_transform`, and
  `buildCodeExecutionStorageGuardOutput` were present, root returned
  `HTTP/2 200`, `/api/config` returned JSON, `/office/` returned `401`, and
  `LibreChat-CodeAPI` remained healthy.

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
