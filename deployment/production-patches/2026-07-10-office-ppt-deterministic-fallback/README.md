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
   `演示`) with an output action such as `生成`, `制作`, `做出`, `输出`,
   `导出`, or `返回`.
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
10. Mirror generated downloadable artifacts into `responseMessage.files` so the
   frontend renders the same downloadable file cards used for normal chat
   files. This applies to CodeAPI-generated PPT/PPTX, Excel/CSV, Word, MD/TXT,
   PDF, images, and other real file artifacts that have a `file_id`.
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

Follow-up file-card visibility fix deployed on 2026-07-10 after commit
`b15b743` was pushed to `origin/main`. Existing pre-fix message
`bee83a55-99a5-4a8b-8230-c4f1a9627308` in conversation
`d512f145-574e-4a91-8bda-b047c10c07e9` was backfilled after commit `87e475a`
was pushed to `origin/main`.

General generated-artifact file-card fix deployed on 2026-07-10 after commit
`5283696` was pushed to `origin/main`. This extends file-card rendering from
the deterministic PPT route to all assistant-generated downloadable artifacts
that have a `file_id`.

CodeAPI session enumeration guard deployed on 2026-07-10 after commits
`14e17fe` and `ec8179a` were pushed to `origin/main`. The guard preserves
current-message `/mnt/data` files while blocking global CodeAPI session storage
enumeration.

Production write performed:

```text
/opt/librechat/office-context-patch/BaseClient.js
```

Backup created before replacement:

```text
/opt/librechat/office-context-patch/BaseClient.js.bak-20260710003919
/opt/librechat/office-context-patch/BaseClient.js.bak-20260710011244
/opt/librechat/office-context-patch/BaseClient.js.bak-20260710012446
/opt/librechat/office-context-patch/BaseClient.js.bak-20260710014142
/opt/librechat/office-context-patch/BaseClient.js.bak-20260710020149
/opt/librechat/office-context-patch/ToolService.js.bak-20260710020149
/opt/librechat/librechat.yaml.bak-20260710020149
```

Observed checksums:

```text
before: 23915ea0f6fb84fb1c554417a4c0ad0b1a008b941d2a98ff77e7c40c748c230f
after:  db4638270ae7cb48eafa67a67258d44cba3971edb502001fb229d33f5b6041d8
preflight before: db4638270ae7cb48eafa67a67258d44cba3971edb502001fb229d33f5b6041d8
preflight after:  8f21565c7941774d20b2164cc0f3096b55048c5cb0a74e3332164588cb49d8c0
file-card before: 8f21565c7941774d20b2164cc0f3096b55048c5cb0a74e3332164588cb49d8c0
file-card after:  1ef62a50021491d4a962376e99e50ecdeeba19da1c405553ec5189cecd8291c3
general file-card before: 1ef62a50021491d4a962376e99e50ecdeeba19da1c405553ec5189cecd8291c3
general file-card after:  774120c7ecc38897887f41bf7a676f55b4f179b955f456569e8bced42a80ff34
storage guard BaseClient after:  fd406df87154d26ef2ef6caeb4a4125d5ad82c2e5a4eaf1e2db8239ced6bbcdf
storage guard ToolService after: 29d117046ed8ed7c9f8880b222b452fc3f4b096d7bad5ba346f935602118e0cd
storage guard librechat.yaml after: 3da74bf821b7cc26b1b449b3e93138a0f33ab28a3d70bd258a03a4a2fa7c1f14
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
File-card markers present in production BaseClient.js
Backfill result: message.files[0].file_id and message.attachments[0].file_id
matched `e1a6d20b-89e6-428a-9e7b-9f3369d4333b`
General file-card markers present in production BaseClient.js:
isDownloadableMessageFile, appendDownloadableMessageFiles,
artifactAttachments, responseMessage.files
Storage guard markers present in production ToolService.js and prompt config.
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
- Existing messages created before that follow-up can be repaired with
  `scripts/backfill-deterministic-ppt-message-files.js`, which copies PPT
  attachments into `message.files` idempotently for a specified
  `conversationId` and assistant `messageId`.
- Newer generic repairs should use
  `scripts/backfill-generated-attachment-files.js`, which copies any
  downloadable assistant attachment into `message.files` while ignoring
  display-only tool attachments such as search and UI resources.
- Old conversations that already saved global CodeAPI session listings can be
  repaired with `scripts/redact-unsafe-codeapi-session-tool-outputs.js`, which
  redacts unsafe tool-call arguments and outputs for one specified
  conversation/message.
- Conversation `b214cc21-95bb-4721-979d-893f637b094f`, assistant message
  `bd55ca81-0a53-4bd4-805b-4ce6c2191d3f`, was redacted on 2026-07-10:
  `redactedParts: 9`, `unsafeOutputs: 0`, `unsafeArgs: 0`.

Follow-up diagnosis for the same conversation on 2026-07-10 02:11 HKT:

- Latest assistant message `a7eebe59-575a-4e83-b681-9836403b5898` already
  had `message.files[0]`, `message.attachments[0]`, and a matching `files`
  collection row for `API渠道模型来源说明_基础版_a7eebe59.pptx`.
- The missing browser card was therefore not a CodeAPI generation failure or a
  Mongo persistence failure.
- Likely gap: deterministic preflight bypassed the normal code-tool callback
  path that emits live `attachment` SSE chunks. The final response persisted
  `files`, but the current-page stream state did not receive the same generated
  file event used by regular code artifacts.
- Fix: `office-context-patch/BaseClient.js` now emits a live generated
  `attachment` event for deterministic Office/PPT fallback artifacts in
  addition to persisting `responseMessage.files` and `responseMessage.attachments`.
  In standard streaming mode it writes to the response stream when writable; in
  resumable mode it publishes through `GenerationJobManager.emitChunk` using the
  conversation id stream.

Deployment result on 2026-07-10 02:19 HKT:

- Repository commit deployed: `df2eb11` (`Emit live deterministic PPT attachments`).
- Production backup created before replacement:
  `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710021923`.
- Production `BaseClient.js` hash changed from
  `fd406df87154d26ef2ef6caeb4a4125d5ad82c2e5a4eaf1e2db8239ced6bbcdf` to
  `de1244004246815b4b846a5b3ea0d59529247d2536f8232ed94bba4202d59510`.
- `docker exec LibreChat-API node --check /app/api/app/clients/BaseClient.js`
  passed before restart.
- Post-restart verification found production markers:
  `GenerationJobManager`, `emitGeneratedAttachmentEvent`, and the
  `GenerationJobManager.emitChunk` call in `/app/api/app/clients/BaseClient.js`.
- Container health after restart: `LibreChat-API` up, `LibreChat-CodeAPI`
  healthy, `LibreChat-NGINX` up.
- HTTP smoke: root returned `200`; `/office/` returned `401`, matching the
  protected Office Converter helper route.

Second follow-up diagnosis on 2026-07-10 02:24 HKT for conversation
`fe8d7f54-8bbd-4786-b7a1-d4618f83ba35`:

- Assistant message `a709f5cb-8ead-4b21-be0d-2f277ce21b72` had
  `message.files[0]`, `message.attachments[0]`, and the matching `files`
  collection row for `API渠道模型来源说明_基础版_a709f5cb.pptx`.
- Frontend bundle inspection showed the chat message body renderer only renders
  `message.content` or `message.text`; assistant `message.files` participates in
  memo comparison but is not rendered as an inline download card.
- Existing LibreChat generated-file rendering is tied to `content` tool-call
  blocks: attachments are grouped by `toolCallId` and then passed to the tool
  renderer. Deterministic fallback returned plain text, so there was no content
  tool block to carry the attachment.
- Fix: deterministic fallback now assigns a stable `toolCallId` to the generated
  attachment and emits response `content` with a text part plus a completed
  lightweight `tool_call` part. This reuses the existing tool attachment render
  path instead of relying on assistant `files` alone.
- Repair script added:
  `scripts/backfill-generated-attachment-tool-content.js`. It updates one
  specified assistant message by adding the lightweight tool-call content block
  and aligning `attachments/files[].toolCallId` for the generated file.

Second deployment/backfill result on 2026-07-10 02:35 HKT:

- Repository commit deployed: `ef2ae4a`
  (`Render deterministic PPT attachments via tool content`).
- Production backup created before replacement:
  `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710023323`.
- Production `BaseClient.js` hash changed from
  `de1244004246815b4b846a5b3ea0d59529247d2536f8232ed94bba4202d59510` to
  `bf95d899075c293fd093e8fb257fc64b47bb1f228ecadb869a642084c11835ff`.
- `docker exec LibreChat-API node --check /app/api/app/clients/BaseClient.js`
  passed before restart and after deployment verification.
- Post-restart production markers present:
  `getGeneratedAttachmentToolCallId`, `buildGeneratedAttachmentContent`, and
  `deterministic_office_ppt_fallback`.
- Backfilled conversation `fe8d7f54-8bbd-4786-b7a1-d4618f83ba35`, assistant
  message `a709f5cb-8ead-4b21-be0d-2f277ce21b72`: `matched: 1`,
  `updated: 1`, generated file `eb4a7313-bbef-43ab-aae6-e9cc0adf3948`
  (`API渠道模型来源说明_基础版_a709f5cb.pptx`).
- Read-back verification showed `contentTypes: ['text', 'tool_call']` and the
  same `toolCallId` on the content tool call, `attachments[0]`, and `files[0]`:
  `office_ppt_deterministic_fallback_eb4a7313-bbef-43ab-aae6-e9cc0adf3948`.
- HTTP smoke: root returned `200`; `/office/` returned `401`, matching the
  protected Office Converter helper route.
- Browser visual verification could not complete from the automation session
  because the claimed tab redirected to `/login?redirect_to=...`; no password or
  session data was entered. Backend and Mongo verification completed.

Third follow-up diagnosis on 2026-07-10 for the deleted conversation
`fe8d7f54-8bbd-4786-b7a1-d4618f83ba35` and live replacement conversation
`dd56871a-72ab-4929-a00a-9aeb0cf0f549`:

- `fe8d7f54-8bbd-4786-b7a1-d4618f83ba35` had been deleted from
  `db.conversations` and `db.messages`; only historical `db.files` rows remained.
  It is therefore not a valid current test case.
- The live browser conversation was
  `dd56871a-72ab-4929-a00a-9aeb0cf0f549`, where the user uploaded an existing
  `.pptx` and asked `换成科技风风格的 ppt`.
- Mongo showed the uploaded PPTX was attached to the current user message and had
  `metadata.codeEnvRef`, but the model-led Bash path still saw an empty
  `/mnt/data` and then attempted broad filesystem discovery.
- The CodeAPI storage guard correctly blocked the unsafe broad search, but it
  returned a plain string to a code tool whose response format expected
  `content_and_artifact`, producing the visible secondary error:
  `Tool response format is "content_and_artifact" but the output was not a two-tuple`.
- Root cause: the earlier deterministic route fixed `Excel/Office -> generated
  PPTX -> download card`. It did not cover `existing PPTX -> modified/restyled
  PPTX -> download card`.

Repository fix plan for this follow-up:

- Add a generic PPTX transform fallback in `BaseClient.js`. It triggers only when
  the current message has a `.pptx` CodeAPI attachment and the prompt is about
  visual/theme/layout transformation such as `美化`, `重新排版`, `风格`, `主题`,
  `配色`, `template`, `layout`, or `style`.
- Do not hard-code a single `科技风` output. The backend reads the user prompt and
  maps it through an extensible visual profile table (`tech`, `business`,
  `clean`, `finance`, `red_government`, `marketing`, `dark_gold`, `training`,
  default professional), while preserving the existing slide count, text, tables,
  and images as much as `python-pptx` allows.
- Keep content-specific edits, such as "change slide 3 title to X", on the normal
  model/tool path instead of forcing the visual transform fallback.
- Save transform outputs as normal LibreChat local uploads with
  `metadata.officePptTransformFallback`, `context: execute_code`, a
  `office_ppt_transform_fallback_<file_id>` tool call id, `message.files`, and the
  same lightweight content tool-call block used by generated PPT attachments.
- Refactor shared CodeAPI `/exec`, artifact download, and LibreChat file
  persistence into helper functions so the spreadsheet-summary fallback and PPTX
  transform fallback do not fork the download-card logic.
- Fix `ToolService.js` so storage-guard blocks for Bash/execute-code/programmatic
  tools return a valid two-tuple when the tool uses `content_and_artifact`; this
  prevents the guard from creating a secondary tool-format error.
- Binary `.ppt` uploads remain allowed at the upload-menu layer, but this
  deterministic transform fallback intentionally handles `.pptx` only. `.ppt`
  conversion should be added as a separate LibreOffice conversion step if needed.

Third deployment result on 2026-07-10 03:15 HKT:

- Repository commit deployed: `d5325cf`
  (`Add PPTX transform fallback`), pushed to `origin/main` before production
  write.
- Production backups created before replacement:
  - `/opt/librechat/librechat.yaml.bak-20260710031519`
  - `/opt/librechat/office-context-patch/ToolService.js.bak-20260710031519`
  - `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710031519`
- Production hashes changed:
  - `BaseClient.js`: `bf95d899075c293fd093e8fb257fc64b47bb1f228ecadb869a642084c11835ff`
    -> `c71720f02158ce37a70b7b91ad3b52e6e38c73e16d60a3e2e03fd7e7e706fca1`
  - `ToolService.js`: `29d117046ed8ed7c9f8880b222b452fc3f4b096d7bad5ba346f935602118e0cd`
    -> `93e0e394b91a741655d0fc53b862d6b4900024d34ae544380760d933a3e41990`
  - `librechat.yaml` stayed
    `3da74bf821b7cc26b1b449b3e93138a0f33ab28a3d70bd258a03a4a2fa7c1f14`.
- Deployment script ran `docker exec LibreChat-API node --check` for both
  `/app/api/app/clients/BaseClient.js` and
  `/app/api/server/services/ToolService.js`; both passed.
- Post-restart production marker verification found:
  `PPT/PPTX transform request`, `officePptTransformFallback`,
  `deterministic_office_ppt_transform`, and
  `buildCodeExecutionStorageGuardOutput`.
- Container verification after restart:
  `LibreChat-API` up, `LibreChat-CodeAPI` healthy, `LibreChat-NGINX` up,
  `LibreChat-RAG-API` up.
- HTTP verification after deployment:
  root returned `HTTP/2 200`, `/api/config` returned `200 application/json`, and
  `/office/` returned `HTTP/2 401` with
  `WWW-Authenticate: Basic realm="Office Converter"`.
- Local template smoke test extracted `buildOfficePptTransformPython` from this
  patched `BaseClient.js`, transformed a temporary one-slide PPTX with prompt
  `换成科技风风格的 ppt`, reopened the generated file with `python-pptx`, and
  confirmed `slides 1`.

## Feature / Function List

- Stable PPT output when the model returns empty content after an Office/PPT
  generation request.
- Backend-generated `.pptx` artifact even when the model never calls `Bash`.
- Generated PPT file is stored in normal LibreChat uploads and visible as a
  downloadable assistant file card.
- Deterministic PPT file cards are also emitted to the active browser stream,
  so the card appears immediately without requiring a page refresh.
- Deterministic PPT messages also carry a completed lightweight tool-call
  content block, which is the frontend path that actually renders generated
  attachments in the chat body.
- Existing `.pptx` files can be transformed into a new downloadable `.pptx` for
  visual/theme/layout requests without relying on the model to locate the file in
  `/mnt/data`.
- PPTX transform output is prompt-shaped through an extensible visual profile
  table rather than a fixed "tech style" template.
- Generated Excel/CSV, Word, Markdown/text, PDF, images, and other real file
  artifacts are also mirrored into `responseMessage.files` for download-card
  rendering.
- Code execution storage guard blocks Bash/programmatic-code commands that try
  to inspect `/srv/codeapi-data`, `/srv/codeapi-data/sessions`, raw `sess_*`
  directories, or broad root filesystem searches such as `find /`. This keeps
  one conversation from enumerating another conversation's CodeAPI session
  files and prevents tool-output token blowups from global file listings.
- Guarded code-tool calls now preserve the expected `content_and_artifact`
  response shape for Bash/execute-code/programmatic tools, so a blocked unsafe
  command produces the intended guard message instead of a secondary tool-format
  exception.
- CodeAPI artifact identity is preserved in file metadata for later diagnosis.
- Existing manual retry/fallback message remains as a safety net when CodeAPI
  generation itself fails.

## Verification Plan

Repository checks before production write:

```sh
node --check deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/BaseClient.js
node --check deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/ToolService.js
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
10. Upload an existing PPTX through `Office文件上传`; ask for a visual/theme
   change such as `换成科技风风格的 ppt`; confirm the assistant returns a new
   downloadable `.pptx` whose file row has `metadata.officePptTransformFallback`.
11. In a separate code-tool turn, attempt an unsafe broad file search such as
   `find /srv/codeapi-data/sessions -name "*.xlsx" | head`; confirm the visible
   tool output is the LibreChat storage-guard message and does not include the
   secondary `content_and_artifact` two-tuple error.
12. For pre-fix messages with generated file text but no visible file card, run
   `scripts/backfill-generated-attachment-files.js` against that single
   assistant message and confirm `messages.files[*].file_id` contains the
   generated attachment file IDs.
```

## Rollback

Before replacing production files, create timestamped backups:

```text
/opt/librechat/office-context-patch/BaseClient.js.bak-<timestamp>
/opt/librechat/office-context-patch/ToolService.js.bak-<timestamp>
```

Rollback steps:

1. Restore `BaseClient.js` and `ToolService.js` from the matching backups.
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
