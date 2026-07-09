# Production Patch Archive: Office/PPT Deterministic Fallback

Date: 2026-07-10

Repository status:

```text
Committed and pushed to origin/main before production write.
```

Production target:

```text
https://152.32.172.162.sslip.io/
```

## Why This Exists

Conversation `29d2e4e5-6007-4874-896a-413a025c1c0b` proved the previous
Office/PPT empty-response patch was not enough:

- The Excel upload reached CodeAPI and had a valid `metadata.codeEnvRef`.
- The source workbook existed inside the CodeAPI session.
- CodeAPI logs showed upload activity but no `/exec` call.
- The assistant response was the visible empty-response fallback text with no
  generated PPT attachment.

Conclusion: this is not an Excel upload failure and not a missing
`python-pptx` dependency. It is a model/tool-routing failure where the model
returns no useful content and no tool call. Prompt retry alone is therefore
insufficient.

## Archived Production Files

This patch archive is based on the previous production patch layer and is
intended to replace the bind-mounted files below after the repository gate
passes:

```text
office-context-patch/BaseClient.js
office-context-patch/ToolService.js
office-context-patch/process.js
skill/office-document-parser/SKILL.md
librechat.yaml
```

Production mount map observed before this patch:

```text
/opt/librechat/office-context-patch/BaseClient.js -> /app/api/app/clients/BaseClient.js
/opt/librechat/office-context-patch/ToolService.js -> /app/api/server/services/ToolService.js
/opt/librechat/office-context-patch/process.js -> /app/api/server/services/Files/process.js
/opt/librechat/skill -> /app/skill
/opt/librechat/librechat.yaml -> /app/librechat.yaml
```

## What Changes

`office-context-patch/BaseClient.js` now adds a deterministic PPT route for
Office/PPT generation turns:

1. Detect a PPT generation intent (`ppt`, `pptx`, `PowerPoint`, `幻灯片`,
   `演示`) with an output action such as `生成`, `输出`, `导出`, or `返回`.
2. Require an uploaded Office/table attachment with `metadata.codeEnvRef`.
3. For explicit PPT output requests, call CodeAPI `/exec` directly before
   asking the model to try tools. This avoids visible half-failed tool runs
   such as `Glob` not found or an empty `/mnt/data` listing.
4. For non-preflight cases, still catch empty Office/PPT responses and run the
   same deterministic backend route.
5. Run Python in CodeAPI:
   - read the uploaded workbook from `/mnt/data`;
   - parse XLSX/XLSM/CSV rows;
   - build a one-slide PPTX using `python-pptx`;
   - save `API渠道模型来源说明_基础版_<messageId>.pptx` under `/mnt/data`.
6. Download the CodeAPI artifact from `/download/<session>/<file_id>`.
7. Save the PPTX into LibreChat local uploads through the official local file
   strategy with `basePath: uploads`.
8. Create a `db.files` record with:
   - `source: local`;
   - `context: execute_code`;
   - `metadata.codeEnvRef` pointing back to the CodeAPI artifact;
   - `metadata.officePptDeterministicFallback` describing the source workbook.
9. Attach the saved file to the assistant message before
   `saveMessageToDatabase`.
10. Mirror the generated file into `responseMessage.files` so the frontend
   renders the same downloadable file card used for normal chat files.
11. Save a visible assistant message pointing users to the generated attachment.

The older prompt-retry behavior remains only for non-deterministic Office
generation cases that do not match the PPT fallback path.

## Follow-up From User Verification

User verification on conversation `a453c3d4-422f-4867-995a-6d4b7a50c8ac`
showed two additional issues:

- First run: the final assistant message had the generated PPT attachment, but
  the model had already attempted a visible tool path that called missing
  `Glob` and listed an empty `/mnt/data`. This confirmed the fallback should be
  a preflight route for explicit PPT generation requests, not only a response
  to empty model output.
- Second run in the same conversation: CodeAPI generated and downloaded the
  PPTX successfully, but `db.createFile` failed with duplicate key
  `filename_1_conversationId_1_context_1_tenantId_1` because the filename
  `API渠道模型来源说明_基础版.pptx` already existed in that conversation.

The patch now gives each generated PPTX a short message-id suffix, for example:

```text
API渠道模型来源说明_基础版_a3913bc4.pptx
```

## Deployment Result

Deployed to production on 2026-07-10 after commit `73420d3` was pushed to
`origin/main`.

Follow-up preflight and duplicate-filename fix deployed on 2026-07-10 after
commit `883ac36` was pushed to `origin/main`.

Production write performed:

```text
/opt/librechat/office-context-patch/BaseClient.js
```

Backup created before replacement:

```text
/opt/librechat/office-context-patch/BaseClient.js.bak-20260710003919
/opt/librechat/office-context-patch/BaseClient.js.bak-20260710011244
```

Observed checksums:

```text
before: 23915ea0f6fb84fb1c554417a4c0ad0b1a008b941d2a98ff77e7c40c748c230f
after:  db4638270ae7cb48eafa67a67258d44cba3971edb502001fb229d33f5b6041d8
preflight before: db4638270ae7cb48eafa67a67258d44cba3971edb502001fb229d33f5b6041d8
preflight after:  8f21565c7941774d20b2164cc0f3096b55048c5cb0a74e3332164588cb49d8c0
```

Post-deployment verification:

```text
node --check /app/api/app/clients/BaseClient.js: passed
root URL: HTTP/2 200
/api/config: 200 JSON
LibreChat-API: Up
LibreChat-CodeAPI: Up, healthy
LibreChat-NGINX: Up
Runtime exports: buildCodeEnvDownloadQuery/getCodeApiAuthHeaders available
Preflight marker present in production BaseClient.js
```

End-to-end user upload verification passed in fresh LibreChat conversation
`d512f145-574e-4a91-8bda-b047c10c07e9` on 2026-07-10 01:16 HKT:

- User uploaded `模型_API_服务能力表_含GLM__1_.xlsx` through the Office upload
  path.
- Production logged `[BaseClient] Office/PPT generation request; running
  deterministic CodeAPI preflight`.
- CodeAPI logged `/exec` as `200 OK`.
- Assistant message `bee83a55-99a5-4a8b-8230-c4f1a9627308` attached
  `API渠道模型来源说明_基础版_bee83a55.pptx`.
- The attachment was recorded as `file_id:
  e1a6d20b-89e6-428a-9e7b-9f3369d4333b`, `context: execute_code`,
  `29275` bytes, with `metadata.codeEnvRef` pointing to generated CodeAPI
  artifact `file_a66c43fc67d14debbeea06cc270545fb`.
- No duplicate filename error was observed after adding the message-id suffix.
- Browser screenshot showed the generated PPTX text but no visible download
  file card. Diagnosis: the deterministic route persisted the generated file in
  `attachments`, but the live message UI did not render it as a downloadable
  chat file. Follow-up fix mirrors deterministic PPT outputs into
  `responseMessage.files` while keeping `attachments` for backend diagnosis.

## Feature / Function List

- Stable PPT output when the model returns empty content after an Office/PPT
  generation request.
- Backend-generated `.pptx` artifact even when the model never calls `Bash`.
- Generated PPT file is stored in normal LibreChat uploads and visible as a
  downloadable assistant file card.
- CodeAPI artifact identity is preserved in file metadata for later diagnosis.
- Existing manual retry/fallback message remains as a safety net when CodeAPI
  generation itself fails.

## Verification Plan

Repository checks before production write:

```sh
node --check deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/BaseClient.js
git diff --check
rg -n "github_pat|sk-[A-Za-z0-9]|api[_-]?key|OPENAI_API_KEY|ANTHROPIC_API_KEY|password" .
```

Production checks after deployment:

```text
1. Back up current /opt/librechat/office-context-patch/BaseClient.js.
2. Replace it with this patch archive's BaseClient.js.
3. Restart LibreChat-API only.
4. Verify /api/config returns 200 JSON.
5. Upload a small XLSX through `Office文件上传`.
6. Ask for a one-page PPTX summary.
7. Confirm assistant message has visible text and one downloadable .pptx
   attachment.
8. Confirm LibreChat-CodeAPI logs show /exec for the turn.
9. Confirm Mongo `messages.attachments[0]` and `files.metadata.codeEnvRef`
   point to the generated artifact.
```

## Rollback

Before replacing production files, create timestamped backups:

```text
/opt/librechat/office-context-patch/BaseClient.js.bak-<timestamp>
```

Rollback steps:

1. Restore `BaseClient.js` from the matching backup.
2. Restart `LibreChat-API`.
3. Verify `/api/config` returns `200`.
4. Run a simple chat smoke test.
5. Do not delete generated uploads or Mongo file rows unless explicitly
   requested; those are user-visible artifacts.

## Notes

- This patch is scoped to LibreChat only.
- It does not modify WebAI/Open WebUI.
- It does not store credentials in the repository.
- It should not be applied to production unless the commit has been pushed to
  `origin/main`.
