# LibreChat Customization Audit

Target deployment:

```text
https://152.32.172.162.sslip.io/
```

Audit date: 2026-07-09

Baseline used for this pass:

- Publicly visible production HTML and `/api/config`.
- Local SOP notes in this repository.
- GitHub API metadata for the official upstream commit.
- GitHub Contents API copy of official `client/index.html` for the same commit.
- Upstream baseline inferred from production `buildInfo.commit`:
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`.

This is not yet a full source-level diff. The local repository currently stores
operations documentation, not the modified LibreChat source tree.

## Official Comparison Summary

The live LibreChat build reports upstream commit:

```text
8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9
```

GitHub identifies this as the official `danny-avila/LibreChat` commit:

```text
fix: Preserve Fenced Markdown Artifacts (#14121)
```

Comparison result:

| Area | Official LibreChat? | Our change? | Function |
| --- | --- | --- | --- |
| Asset recovery / RUM bootstrap | Yes | No confirmed custom change | Detect stale frontend assets, dynamic import failures, and service worker issues, then recover/reload |
| Code Environment / Skills frontend | Yes | No confirmed core change | Official agent file/code sandbox UI and wording exists in the bundle |
| Upload menu Chinese business wording and guards | No | Yes | Re-label upload choices as `图片上传`, `Office文件上传`, `文件提取文字上传` and add client-side file-type guards |
| Auth policy | Configurable official feature | Yes, deployment config | Close registration, keep email/password login, disable social login/password reset |
| Public domain / noindex headers | Deployment concern | Yes, deployment config | Expose LibreChat on `sslip.io` HTTPS and discourage indexing |
| `/office/` Office/Excel reader backend | Not LibreChat core | Yes, LibreChat-host backend capability | Protected Office document extraction service for Excel/XLSX reading and DOCX/PPTX-style preprocessing |

Net: the only confirmed LibreChat frontend customization visible from public
assets is the upload-label business patch. Other visible differences are
deployment configuration or deployment-level backend helpers that support the
LibreChat workflow.

Open WebUI / WebAI customizations on other hostnames are intentionally excluded
from this audit.

## Confirmed LibreChat Changes

### 1. Business upload label patch

The delivered HTML contains a custom script:

```text
business-upload-label-patch
```

It rewrites LibreChat upload menu labels into clearer Chinese business labels
and applies client-side file-type guards:

```text
Upload to Provider -> 图片上传
Upload to Code Environment -> Office文件上传
Upload as Text -> 文件提取文字上传
```

Effect:

- This is a frontend UX patch.
- It helps operators choose the correct upload path.
- It adds short menu descriptions:
  `仅图片；用于截图、照片、图像识别`,
  `Word/Excel/PPT 原文件；可读写并返回文件`, and
  `转成文本给模型分析；适合审阅总结`.
- It blocks common wrong-route uploads before the request reaches the backend:
  images only for `图片上传`; DOCX/XLSX/XLSM/PPT/PPTX/CSV/TSV/ODS/ODP for
  `Office文件上传`; document, table, PDF, and text-like files for
  `文件提取文字上传`.

### 2. Production auth policy

`/api/config` shows:

```text
emailLoginEnabled: true
registrationEnabled: false
passwordResetEnabled: false
socialLoginEnabled: false
```

Effect:

- Public registration is closed.
- Login is email/password based.
- Social login and password reset email are disabled.

This is primarily configuration hardening rather than a LibreChat source-code
feature.

### 3. Public server domain and Nginx exposure

`/api/config` reports:

```text
serverDomain: https://152.32.172.162.sslip.io
```

Root headers show:

```text
server: nginx/1.20.1
x-robots-tag: noindex
```

Effect:

- The app is publicly reachable through the sslip.io domain.
- Search indexing is discouraged by `x-robots-tag: noindex`.

### 4. Runtime asset recovery and diagnostics guard

The delivered HTML also contains a startup script with markers such as:

```text
__lcRumRecoveryGuardInstalled
__lcRecoverStaleAssets
lc-rum-queue
lc-asset-recovery-at
```

Observed behavior:

- Captures asset load and dynamic import failures.
- Stores a small session diagnostic queue.
- Unregisters matching service workers and reloads the page when stale assets
  are detected.
- Responds to service-worker ping messages.

Refined check on 2026-07-09:

- The recovery markers are present in the live root HTML.
- Related RUM/recovery logic is also present in the bundled main JS asset.
- The bundle calls `window.__lcRecoverStaleAssets?.()` on Vite preload errors.
- The official `client/index.html` for commit
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9` contains the same inline recovery
  script markers.
- The official source tree contains RUM/recovery files such as
  `client/src/lib/rum/bootstrap-entry.js`, `client/src/lib/rum/bootstrap.js`,
  `client/src/lib/rum/diagnostics.ts`, and `api/server/routes/rum.js`.

Interpretation:

- This is official LibreChat behavior in the deployed upstream commit.
- It should not be counted as our custom modification unless a later source diff
  shows local edits to the official RUM implementation.
- Functionally, it improves frontend reliability after stale assets, service
  worker problems, or failed dynamic imports.

Status: official feature, not a confirmed custom change.

### 5. Code environment wording and operational workflow

The upload menu patch explicitly exposes the code-environment path as:

```text
Office文件上传
```

Prior operational notes for this deployment family show that code-environment
availability and attachment routing must be verified with real smoke tests, not
assumed from UI flags alone.

Known operational distinction:

- A normal local attachment can exist without reaching `tool_resources.execute_code`.
- A fresh code execution smoke test is needed to prove the backend path works.
- For this deployment, authenticated CodeAPI smoke tests confirmed Excel
  tooling and real PPTX generation: `python-pptx` can write `.pptx` files under
  `/mnt/data` and return them as artifacts.

Refined check on 2026-07-09:

- The public JS bundle contains upstream-looking Code Environment and Skills
  strings such as `Files below are for Code Environment only` and `Lets the
  agent write and run code in a secure sandbox...`.
- Unauthenticated `/api/endpoints` and `/api/models` return `No auth token`, so
  public checks cannot confirm which models/tools are enabled for a logged-in
  user.
- The confirmed local customization here is the business wording and guard
  layer: `图片上传`, `Office文件上传`, and `文件提取文字上传`.
- The model prompt is also customized to steer Office generation through the
  available code tool (`Bash`) and away from unsupported Claude Code helper
  names such as `Glob`, `Read`, `Edit`, and `LS`.
- The production `office-context-patch/BaseClient.js` adds an Office/PPT empty
  response retry guard: an empty assistant completion for Office/PPT generation
  is retried once with an explicit Bash/Python instruction; if still empty, a
  visible fallback message is saved instead of a blank row.
- The deployment `office-document-parser` skill is extended beyond extraction
  to include Office artifact generation/modification guidance for `.pptx`,
  `.xlsx`, and `.docx` outputs under `/mnt/data`.
- The official tree for the same commit includes Code/Skills/Agent file
  handling paths such as `api/server/services/Files/Code/`,
  `api/server/services/Skills/`, and `client/src/components/Agents/`.

Interpretation:

- Code Environment / Skills are official LibreChat capabilities in this build.
- Our visible change is the Chinese operational wording in the upload menu.
- Backend CodeAPI/tool execution is confirmed by authenticated smoke tests, but
  individual empty assistant messages still need MongoDB/log inspection to
  distinguish model empty output from CodeAPI failure.

Status: official frontend capability plus custom Chinese label patch; backend
execution confirmed from authenticated server-side checks.

### 6. Office/Excel reader backend

The LibreChat HTTPS hostname exposes one protected backend route for reading
Office documents:

```text
/office/
```

Known role in this LibreChat deployment:

- `/office/`: Office document extraction/conversion backend used to help
  LibreChat process files that are awkward or unreliable through normal chat
  attachments.
- Primary business use case: read Excel/XLSX files and turn workbook content
  into text/Markdown that can be reviewed, summarized, or pasted back into a
  LibreChat conversation.
- Same backend pattern can support Office preprocessing for DOCX/PPTX workflows
  when needed.

Refined check on 2026-07-09:

- `https://152.32.172.162.sslip.io/office/` returns `401` with
  `WWW-Authenticate: Basic realm="Office Converter"`.
- On the `sslip.io` HTTPS LibreChat host, `/claude/` and `/claude-login/`
  currently return the LibreChat SPA, not the Claude terminal login.

Interpretation:

- `/office/` is a confirmed LibreChat-host backend capability, protected by
  Basic Auth.
- It is not an official LibreChat core route, but it is part of our practical
  LibreChat file-reading workflow.
- Its purpose is to bridge the gap between LibreChat chat attachments and
  structured Office files, especially Excel/XLSX, when the model/provider or
  Code Environment path cannot reliably see or parse the original file.
- `/claude/` and `/claude-login/` are not counted as LibreChat changes because
  the LibreChat HTTPS hostname serves the normal SPA for those paths.

Operational workflow:

1. Use `/office/` for Excel/XLSX files when direct LibreChat upload does not
   expose usable workbook content to the model or code environment.
2. Convert/extract the Office document through the protected backend.
3. Feed the extracted text/Markdown/table content back into LibreChat for
   analysis, summarization, issue-log review, or follow-up drafting.
4. Treat the original workbook as private data; do not store converted outputs
   in this repository unless they are sanitized.

Status: confirmed deployment-level LibreChat backend capability; not an
upstream LibreChat source modification.

## What Still Looks Like Upstream

The visible production branding still says:

```text
LibreChat
```

Observed examples:

- HTML title: `LibreChat`
- Manifest name: `LibreChat`
- `/api/config` app title: `LibreChat`

So there is no externally visible product rebrand in this LibreChat deployment,
at least in the publicly fetched HTML/config/manifest.

## Open Questions For Source-Level Diff

To finish a real diff against upstream LibreChat, collect one of:

- The server-side modified LibreChat source directory.
- The image/build Dockerfile and runtime patch scripts.
- A patch package or Git remote for the deployed app.

Then compare against upstream commit:

```text
8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9
```

Recommended next checks:

1. Locate the live deployment source or container build context.
2. Search for:

   ```text
   business-upload-label-patch
   __lcRumRecoveryGuardInstalled
   __lcRecoverStaleAssets
   图片上传
   Office文件上传
   文件提取文字上传
   ```

3. Separate pure configuration changes from source changes.
4. Use an authenticated test account or server logs to verify whether
   CodeAPI/tool execution works end to end.
5. Keep `/office/` documented as the LibreChat-host Office/Excel reader backend,
   not a core source modification.
6. Keep Open WebUI / WebAI and direct-IP-only routes out of this LibreChat
   comparison.
