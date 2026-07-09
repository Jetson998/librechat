# Production Patch Archive: Office/PPT Empty Response Retry

Date: 2026-07-09

Production target:

```text
https://152.32.172.162.sslip.io/
```

## Why This Exists

Conversation `4865a297-3013-40e5-b77a-c5958d79ef16` uploaded an Excel workbook
successfully, and the uploaded file had a valid `metadata.codeEnvRef`, but the
assistant message was saved with empty content:

```text
textLen: 0
contentLen: 0
attachments: []
```

CodeAPI logs showed the file upload but no `/exec` call for that turn. The
failure was therefore model/tool-routing empty output before code execution,
not a PPT generation failure.

## Archived Production Files

These files were copied from the live bind-mounted production patch layer after
the fix:

```text
office-context-patch/BaseClient.js
office-context-patch/ToolService.js
office-context-patch/process.js
skill/office-document-parser/SKILL.md
librechat.yaml
```

Production mount map at the time of capture:

```text
/opt/librechat/office-context-patch/BaseClient.js -> /app/api/app/clients/BaseClient.js
/opt/librechat/office-context-patch/ToolService.js -> /app/api/server/services/ToolService.js
/opt/librechat/office-context-patch/process.js -> /app/api/server/services/Files/process.js
/opt/librechat/skill -> /app/skill
/opt/librechat/librechat.yaml -> /app/librechat.yaml
```

## What Changed

- `BaseClient.js` adds `OFFICE_GENERATION_EMPTY_RETRY_MARKER`.
- Empty Office/PPT generation completions are detected when the completion has
  no meaningful text, content part, tool call, or attachment.
- The affected turn is retried once with a stronger instruction to use
  `Bash` and Python, read Office files from `/mnt/data`, generate `.pptx` with
  `python-pptx`, and save artifacts under `/mnt/data`.
- If the retry is still empty or throws, LibreChat saves a visible fallback
  message instead of a blank assistant row.
- `office-document-parser/SKILL.md` now documents Office generation/edit
  workflows, not just extraction: `.pptx` via `python-pptx`, `.xlsx` via
  `openpyxl`, `.docx` via `python-docx`.
- `librechat.yaml` prompt text points the model at the actual Anthropic-side
  tool name (`Bash`) and away from unsupported Claude Code helper names such as
  `Glob`, `Read`, `Edit`, and `LS`.

## Incident Repair

The existing blank assistant message in conversation
`4865a297-3013-40e5-b77a-c5958d79ef16` was repaired manually:

- Source workbook in CodeAPI session:
  `sess_0a29d3ba3ba04f1294402b2c7e060cf3`
- Source workbook:
  `模型_API_服务能力表_含GLM__1_.xlsx`
- Generated PPT:
  `API渠道模型来源说明_基础版.pptx`
- LibreChat file id:
  `31389640-1289-4bd8-a6d2-e7281f62a1a1`
- CodeAPI file id:
  `file_eb99fd9d463f4b328c2c994eb8720df2`
- File size:
  `30334` bytes

The repaired message now has one text content part and one attachment.

## Verification

Verified after deployment:

```text
/api/config: 200
LibreChat-API: Up
LibreChat-CodeAPI: Up, healthy
LibreChat-NGINX: Up
CodeAPI post-patch python-pptx smoke: generated .pptx successfully
```

Mongo compact check for the repaired message showed:

```text
contentLen: 1
attachmentCount: 1
filename: API渠道模型来源说明_基础版.pptx
bytes: 30334
```

## Rollback

Production script created timestamped backups beside the patched files before
editing:

```text
/opt/librechat/office-context-patch/BaseClient.js.bak-<timestamp>
/opt/librechat/skill/office-document-parser/SKILL.md.bak-<timestamp>
```

To roll back this patch on the server:

1. Restore `BaseClient.js` from the matching `.bak-<timestamp>` file.
2. Restore `SKILL.md` from the matching `.bak-<timestamp>` file.
3. Restart `LibreChat-API`.
4. Verify `/api/config` returns `200`.
5. Run an Office/PPT CodeAPI smoke test before asking users to retry.

Do not delete the repaired conversation attachment unless the user explicitly
requests removing that generated PPT.
