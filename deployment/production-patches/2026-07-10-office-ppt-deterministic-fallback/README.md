# Production Patch Archive: Office/PPT Deterministic Fallback

Date: 2026-07-10

Repository status:

```text
Must be committed and pushed to origin/main before any production write.
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

`office-context-patch/BaseClient.js` now adds a deterministic PPT fallback for
empty Office/PPT generation turns:

1. Detect a PPT generation intent (`ppt`, `pptx`, `PowerPoint`, `幻灯片`,
   `演示`) where the assistant completion has no meaningful text, content
   part, tool call, or attachment.
2. Require an uploaded Office/table attachment with `metadata.codeEnvRef`.
3. Call CodeAPI `/exec` directly from the backend using the existing
   `storage_session_id`.
4. Run Python in CodeAPI:
   - read the uploaded workbook from `/mnt/data`;
   - parse XLSX/XLSM/CSV rows;
   - build a one-slide PPTX using `python-pptx`;
   - save `API渠道模型来源说明_基础版.pptx` under `/mnt/data`.
5. Download the CodeAPI artifact from `/download/<session>/<file_id>`.
6. Save the PPTX into LibreChat local uploads through the official local file
   strategy with `basePath: uploads`.
7. Create a `db.files` record with:
   - `source: local`;
   - `context: execute_code`;
   - `metadata.codeEnvRef` pointing back to the CodeAPI artifact;
   - `metadata.officePptDeterministicFallback` describing the source workbook.
8. Attach the saved file to the assistant message before
   `saveMessageToDatabase`.
9. Save a visible assistant message pointing users to the generated attachment.

The older prompt-retry behavior remains only for non-deterministic Office
generation cases that do not match the PPT fallback path.

## Feature / Function List

- Stable PPT output when the model returns empty content after an Office/PPT
  generation request.
- Backend-generated `.pptx` artifact even when the model never calls `Bash`.
- Generated PPT file is stored in normal LibreChat uploads and visible as an
  assistant attachment.
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
