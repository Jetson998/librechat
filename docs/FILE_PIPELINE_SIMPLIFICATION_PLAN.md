# File Pipeline Simplification Plan

Date: 2026-07-10

Status: deployed to production and verified on 2026-07-10. Repository commits,
production backups, hashes, and verification evidence are recorded below and
in `docs/PRODUCTION_VERIFICATION.md`.

## Objective

Reduce the LibreChat file workflow to one generic contract:

1. A supported current-thread upload is stored by LibreChat and receives a
   CodeAPI reference.
2. Before code execution, the referenced files are mounted into the same code
   session under `/mnt/data`.
3. Code-generated files remain under `/mnt/data` and flow through LibreChat's
   normal code-artifact callback.
4. Real generated artifacts are persisted once and rendered through the normal
   assistant attachment/download-card path.

No prompt keyword, document topic, output style, or Office subtype may bypass
the normal model/tool path.

## Keep

- `process.js`: sanitized CodeAPI upload and structured
  `metadata.codeEnvRef` persistence.
- `ToolService.js`: request-scoped `primeCodeFiles()` cache, so initialization
  and execution share one upload result rather than uploading again for every
  Bash call.
- `api-index.cjs`: initial session seeding plus execution-time recovery when the
  graph omits `codeSessionContext`; preserve generated files and deduplicate by
  storage session plus file ID.
- Code-execution storage guard: allow current `/mnt/data`, block global CodeAPI
  session enumeration.
- `BaseClient.js`: current-thread file ownership/rehydration checks and the
  small generic mirror from real artifact attachments into
  `responseMessage.files`.
- The deployment-level Office converter only for the separate
  `文件提取文字上传` route.

## Remove

- PPT/PPTX keyword preflight and transform routing in `BaseClient.js`.
- Fixed spreadsheet-to-PPT Python and fixed PPT restyling templates.
- Direct `BaseClient` calls to CodeAPI `/exec` and `/download`.
- Manual generated-file persistence, synthetic tool-call content, and manual
  attachment SSE emission used only by the deterministic PPT fallback.
- Office-specific empty-response retry and hard-coded failure messages.
- The global `BaseClient.addInstructions()` business-tool notice; the model
  configuration remains the single prompt source.
- `office-document-parser` as an always-applied skill, its `/office/` user
  redirect, its missing bundled-script command, and `/tmp` output guidance.

## Format Rules

- The frontend labels remain:
  `图片上传`, `Office文件上传`, and `文件提取文字上传`.
- `Office文件上传` accepts DOCX, XLSX, XLSM, PPT, PPTX, CSV, TSV, ODS, and ODP.
- The same Office-upload allowlist must be enforced server-side for
  message-level `execute_code` uploads; client-side `accept` is guidance, not
  authorization.
- Normal CodeAPI output handling remains format-agnostic for genuine artifacts.
  PPTX, XLSX, DOCX, PDF, Markdown/text, CSV, images, and other CodeAPI artifacts
  continue to use the same callback and download-card pipeline. No
  PPT-specific persistence path is allowed.

## Expected User-Visible Behavior

- Uploading a supported Office file makes it visible in `/mnt/data` on the
  first Bash/code call.
- Subsequent Bash calls in the same request do not re-upload the same inputs.
- The model can perform arbitrary user-requested Office reading, generation,
  modification, and layout work rather than a hard-coded one-page PPT task.
- A generated file is announced only after LibreChat has received a real
  artifact/file ID.
- Missing inputs or generation failures return the actual tool/backend error;
  users are not redirected to `/office/` and are not told an attachment exists
  before persistence succeeds.

## Verification

Repository checks:

```sh
node --check deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/BaseClient.js
node --check deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/ToolService.js
node --check deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/api-index.cjs
node --check deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/process.js
git diff --check
```

Behavior checks:

1. Concurrent initialization/execution priming calls invoke the underlying
   upload once.
2. A Bash call without graph `codeSessionContext` still receives the uploaded
   file under `/mnt/data`.
3. Existing current-turn generated files remain available and are not
   duplicated.
4. An unsupported file sent directly to the Office `execute_code` upload route
   is rejected server-side.
5. XLSX to PPTX, XLSX to DOCX, and generated Markdown use the normal model/tool
   path and return one real download card each.
6. A PPT restyling request is handled by the model/tool path, not by a fixed
   `BaseClient` template.
7. A non-Office chat receives no Office skill body or business-tool notice.

## Production Gate

Before production write:

1. Commit and push this plan.
2. Implement and test the repository patch.
3. Commit and push the implementation.
4. Capture pre-deployment HTTP status, production hashes, and backups.

Production deployment changes only the files whose repository diffs require
replacement. Restart `LibreChat-API` only unless verification proves another
service is required. Use
`deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/scripts/deploy-file-pipeline-simplification.sh`
for timestamp-matched backups, syntax checks, automatic rollback, restart, and
HTTP verification.

## Deployment Outcome

The gate completed in order:

- Design commit `6e9f5c5`, implementation commit `bf1fadf`, and atomic deploy
  runner commit `a60acfb` were pushed to `origin/main` before production write.
- Deployment timestamp: `20260710215832`.
- Timestamp-matched backups were created for `BaseClient.js`, `ToolService.js`,
  `process.js`, and `office-document-parser/SKILL.md` under their existing
  `/opt/librechat` patch directories.
- Production syntax and patch-contract checks passed, `LibreChat-API`
  restarted, `LibreChat-CodeAPI` remained healthy, root returned `200`,
  `/api/config` returned JSON, and `/office/` returned `401` with realm
  `Office Converter`.
- A handler-level production smoke on 2026-07-10 22:12 HKT deliberately omitted
  `codeSessionContext`; request-scoped recovery injected the two expected
  current-thread files into `/mnt/data` and returned `status: success` without
  creating or modifying any chat message.
- An authenticated browser check confirmed the three upload menu labels and
  existing generated-file download cards. A fresh automated upload could not
  be completed because the browser control layer rejected local file selection;
  that limitation is recorded separately and is not reported as a passed UI
  end-to-end test.

## Rollback

Restore the timestamp-matched pre-deployment copies of every replaced file,
restart `LibreChat-API`, then verify root, `/api/config`, simple chat, Office
upload, first-call `/mnt/data` visibility, and generated download cards.
