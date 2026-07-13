# Production Verification

## Production User Creation - 2026-07-13

Created the local LibreChat user `vip998@example.local` through the supported
application script after the production operation was documented and pushed.
The password was supplied out of band through non-echoed standard input and was
not placed in a command, repository file, or verification log.

Repository gate:

- `28b74ee` added the user lifecycle SOP and the planned production operation.
- The first container preflight used the upstream npm command, but the
  production API container starts in `/app/api`; it exited with
  `MODULE_NOT_FOUND` for `/app/api/create-user.js` before any MongoDB write.
- `e943fc7` corrected the committed production command to the absolute
  `/app/config/create-user.js` path and was pushed before the write.

Production result at 2026-07-13 16:55 HKT:

```text
CREATE_USER_RESULT=created
EMAIL_VERIFIED=true
POST /api/auth/login=200
emailLoginEnabled=true
registrationEnabled=false
```

No service was restarted and no production file, environment variable, or
Admin Panel setting changed. The account deletion rollback was not used.

## GPT-5.6-SOL Sender Label Configuration - 2026-07-12

- Implementation commit `35cc853` was pushed to `origin/main` before the
  production write.
- Deployment timestamp: `20260712011327`.
- Mongo backup ID: `sender-label-20260712011327` in
  `codexConfigBackups`.
- The active `__base__` override advanced from config version 8 to 9.
- `gpt-5.6-sol` now has `preset.modelLabel: GPT-5.6-SOL`.
- The MuskAPI endpoint fallback is normalized to `GPT-5.6-SOL`.
- Release test, production preflight, API restart, `/api/config` readiness,
  and Mongo runtime assertions passed.
- No LibreChat source, frontend bundle, Office pipeline, CodeAPI file, or
  historical message was modified.
- After login, the user confirmed the final new-conversation display and
  message-label verification passed on 2026-07-12.

Target:

```text
https://152.32.172.162.sslip.io/
```

Latest verification date: 2026-07-11

## Admin Panel Simplified Chinese Deployment

Repository gate:

- `7b1ede0` - repository-owned remote deployment runners committed and pushed.
- `858e344` - deploy-result capture committed and pushed.
- `feedcc5` - release packaging corrected to strip macOS metadata before
  production deployment.
- `2a48314` - production build and deploy results committed and pushed.

Final production deployment timestamp: `20260711231635`.

Backup created by deployment:

```text
/opt/librechat/backups/admin-panel-zh-cn-20260711231635
```

Released image:

```text
librechat-admin-panel-zh-cn:95388ccb14d2
```

Production result:

- Admin Panel is available at
  `https://admin.152.32.172.162.sslip.io/`.
- A direct probe on 2026-07-11 returned `HTTP/2 200`.
- The deployed image ID is
  `sha256:99c0dc20fbdfc1b96afd87a2758214de63341019d42f1f6b74164a8c48d271d5`.
- The verified source tree hash is
  `95388ccb14d2d6c61b68ccb4d04faaafd47ea9b50628a23d7d5b91a82739460d`.
- The CI attestation matched commit `5f1f280f7240aaa75dfe5c3f8dd445d22a71f304`,
  tag `admin-ci-95388ccb14d2`, and workflow run `29149061012`.
- Only `LibreChat-Admin-Panel` changed container identity.
- `LibreChat-API`, `LibreChat-NGINX`, `LibreChat-CodeAPI`, and
  `chat-mongodb` remained unchanged.
- `/office/` remained `401` with `realm="Office Converter"`.
- MongoDB `configs` count remained `0` before and after deploy.

Rollback: restore
`/opt/librechat/backups/admin-panel-zh-cn-20260711231635/compose.override.yaml`
to `/opt/librechat/compose.override.yaml`, recreate only `admin-panel`, then
repeat Admin root, main root, `/api/config`, `/office/`, and protected-service
checks. See
`deployment/production-patches/2026-07-11-admin-panel-zh-cn/ROLLBACK.md`.

## Official Admin Panel Deployment

Repository gate:

- `92bbebc` - design, risk boundary, verification, and rollback plan committed
  and pushed before implementation.
- `842b60f` - production discovery recorded before implementation.
- `8eec63d` - official Admin Panel service, both Nginx layers, model config, and
  the bundled OpenAI icon committed and pushed.
- `d4a9a37` - atomic preflight, backup, deployment, verification, and rollback
  runner committed and pushed before production deployment.
- `e041f23` - bind-mounted Nginx reload correction committed and pushed before
  the corrected production deployment.

Final production deployment timestamp: `20260711103411`.

Backup created by the corrected deployment:

```text
/opt/librechat/backups/admin-panel-20260711103411
```

Official image, pinned by immutable digest:

```text
registry.librechat.ai/clickhouse/librechat-admin-panel@sha256:1d3916ae84439e83da83507afd4aae14a99bd81ff2e1890079f57d8d377eb8e9
```

Production result:

- Admin Panel is available at
  `https://admin.152.32.172.162.sslip.io/` with a valid Let's Encrypt
  certificate.
- The Admin container is reachable only through the existing Compose network;
  it has no published host port.
- The first deployment wrote the correct inner Nginx file but did not refresh
  the inode already bind-mounted in `LibreChat-NGINX`, so the Admin hostname
  initially reached the wrong frontend. No ad hoc production edit was kept.
  Commit `e041f23` added `docker compose up -d --force-recreate client`; the
  corrected release then passed the Admin-route assertions.
- `admin@example.local` authenticated with role `ADMIN`. The production Admin
  password had drifted and was synchronized to the current Bill password using
  the existing server-side operation; no password or hash was written to the
  repository.
- The Admin Configuration page loaded the custom endpoint and both model specs,
  `gpt-5.6-sol` and `claude-fable-5`.
- MongoDB `configs` remained empty at deployment verification, so Admin Config
  did not override the repository-managed base configuration.
- The Admin release did not modify Office handling, CodeAPI, uploads, generated
  artifacts, LibreChat application source, or compiled frontend bundles.

Post-deployment checks on 2026-07-11:

- Repository Admin release test: passed.
- Main root: `200`; `/api/config`: `200`; Admin root: `200` and served
  `LibreChat Admin Panel` HTML.
- `/office/`: `401` with `Basic realm="Office Converter"`.
- A genuinely fresh chat selected `GPT-5.6 SOL` and rendered
  `/assets/openai.svg`; a GPT reply completed successfully.
- After a standalone Fable check, a separate fresh `/c/new` tab again selected
  `GPT-5.6 SOL` with the OpenAI icon.
- Standalone Fable conversation `3687080b-eda2-4c2b-b0d1-c37d03eae7cc`
  returned `Fable 独立正常` successfully.

Known cross-provider boundary:

- Switching from GPT to Fable inside the same conversation reproducibly ended
  with an empty Claude assistant bubble. It occurred in conversations
  `63228927-6936-43d2-a3c6-6702a584aacf` and
  `28c9f3a2-a328-4008-8ced-d1e16e2720db`.
- The same Fable model works in a standalone Fable conversation, so this is not
  a global Fable endpoint outage and does not change the verified GPT default.
  The current evidence points to cross-endpoint history/request compatibility.
- No speculative patch, Mongo rewrite, Office change, or production hotfix was
  made. This requires its own design-first repository change and mixed-provider
  regression test before any production deployment.

Rollback: restore the timestamped backup, restore the previous host and inner
Nginx configuration, remove the Admin service, force-recreate the client
container, and repeat the route, authentication, model-default, and Office
boundary checks. The deployment runner implements this rollback without a
MongoDB message rewrite.

## GPT-5.6 SOL Default Model Deployment

Repository gate:

- `e10b0ad` - design and rollback plan committed and pushed.
- `f6e553c` - dual-model configuration and strict config test committed and
  pushed.
- `3dc260f` - atomic backup/deploy/rollback runner committed and pushed.

Production deployment timestamp: `20260711011151`.

Only this production file changed:

```text
/opt/librechat/librechat.yaml
```

Backup created before replacement:

```text
/opt/librechat/librechat.yaml.bak-20260711011151
```

Configuration hashes:

```text
before  3da74bf821b7cc26b1b449b3e93138a0f33ab28a3d70bd258a03a4a2fa7c1f14
after   19610ec4b6fc2dd59ad558a98ca8673feca54903109ffc7397a3bdd00842d47d
```

Configuration behavior:

- `gpt-5.6-sol` is the sole default model spec.
- The GPT model uses custom OpenAI-compatible endpoint `MuskAPI` and sends
  `reasoning_effort: max` through endpoint `addParams`.
- `claude-fable-5` remains available as a non-default model spec with its
  existing Anthropic `effort: max` setting.
- Both model specs keep Skills, execute-code access, current-session
  `/mnt/data` rules, generated-file handling, and the global CodeAPI-session
  enumeration prohibition.
- No LibreChat source file, frontend asset, Office patch, database record, API
  key, or environment file was changed by the release.

Deployment-runner verification:

- The candidate parsed with the container's `js-yaml` package and passed the
  expected endpoint, provider, model-spec, tool, and max-reasoning assertions.
- A real relay probe returned model `gpt-5.6-sol`, accepted
  `reasoning_effort: max`, and produced the expected function `tool_call`.
- Six transient `502` responses occurred while `LibreChat-API` restarted; the
  runner waited until readiness returned.
- The running bind-mounted config passed the sole-default and max-reasoning
  assertions.
- Root and `/api/config` returned `200`.
- `/office/` returned `401` with `realm="Office Converter"`.
- `LibreChat-CodeAPI` remained running and healthy.
- The temporary server staging directory was removed.

Authenticated browser verification used conversation:

```text
b332fa31-f6e6-4061-a6c4-20939f20f0b0
```

Observed user-facing behavior:

- Fresh chat default: `GPT-5.6 SOL`.
- Short GPT reply: passed.
- Longer GPT reply and visible thinking content: passed.
- Real Python code-tool call: passed, returning `83810205` for
  `12345 * 6789`.
- Model selector retained `Fable 5`; a Fable reply passed.
- A second fresh chat after switching to Fable again defaulted to
  `GPT-5.6 SOL`.
- MongoDB assistant messages recorded endpoint `MuskAPI` and model
  `gpt-5.6-sol` for GPT turns, and endpoint `anthropic` with model
  `claude-fable-5` for the Fable turn.

Office regression boundary:

- The browser control layer rejected assigning the local synthetic XLSX to the
  file chooser, so this automated run did not upload an Office file and is not
  counted as a new Office end-to-end pass.
- The file pipeline was unchanged. Existing user acceptance for
  `PPT upload -> edit -> download` and
  `Excel upload -> edit -> download` remains the current Office evidence.

Residual observation: immediately navigating to `/c/new` after the first
automated Fable response created a second successful sibling copy of the same
Fable test prompt/response. The cause was not established, no repair was
performed, and the behavior did not occur during the GPT turns. Monitor for a
manual duplicate-submit report before classifying it as a product regression.

Rollback: restore
`/opt/librechat/librechat.yaml.bak-20260711011151`, restart
`LibreChat-API`, then repeat root, `/api/config`, `/office/`, GPT/Fable model
selection, simple chat, code execution, and the existing Office smoke checks.

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

## Persistent Upload Menu Patch

The upload-menu patch was restored through the repository-owned production
release on 2026-07-12. The delivered HTML contains exactly one script with id:

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

The patch is now generated from the active API image and persisted through the
read-only Compose mount:

```text
/opt/librechat/ui-label-patch/client-dist:/app/client/dist:ro
```

Production evidence:

```text
deployment_timestamp=20260712020837
backup_dir=/opt/librechat/backups/upload-menu-20260712020837
public_index_sha256=decb4df509099e61a8fd9c03b7121a9bb76a4c49b26ff2b51134678cd982cb2f
public_script_sha256=a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9
```

Authenticated browser verification showed all three labels, descriptions, and
the required order. A separate test force-recreated `LibreChat-NGINX`; the
public hashes and menu remained unchanged, while API, CodeAPI, and MongoDB
container identities remained stable. Recheck the release test whenever the
frontend image or Compose ownership changes.

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

Current production file pipeline, deployed on 2026-07-10:

- Use one generic model/Bash path for Office reading, generation, and edits.
- Keep request-scoped upload priming, runtime file injection recovery, current
  thread isolation, and generic generated-artifact download cards.
- Remove all `BaseClient.js` PPT preflight/transform templates, direct CodeAPI
  calls, Office retries, synthetic tool calls, and manual attachment streaming.
- Do not always apply the Office skill or direct users to `/office/` when a code
  session is missing a file.
- Enforce the Office code-upload extension allowlist on the server.

## File Pipeline Simplification Deployment

Repository gate:

- `6e9f5c5` - design committed and pushed.
- `bf1fadf` - simplified implementation and durable tests committed and pushed.
- `a60acfb` - atomic backup/deploy/rollback runner committed and pushed.

Production deployment timestamp: `20260710215832`.

Backups created before replacement:

```text
/opt/librechat/office-context-patch/BaseClient.js.bak-20260710215832
/opt/librechat/office-context-patch/ToolService.js.bak-20260710215832
/opt/librechat/office-context-patch/process.js.bak-20260710215832
/opt/librechat/skill/office-document-parser/SKILL.md.bak-20260710215832
```

Production hashes after deployment:

```text
BaseClient.js  ef33ed6a254c3ad41541408e3fb780ee48fca6c05c4283bb9a3046719167497d
ToolService.js c361cd67cb6877684150a3f3c14e55680762c3287b8a921cfbe84753c9d09edb
process.js     f7d7452ba82f8340ca8532bebd21570efdc1c5d5bcb04a5969bd5b5f473698e4
SKILL.md       98e97c17e1753a0b0316e95be8162f68a6adaf88b13951053539f258a8c33c21
```

Deployment verification:

- Container `node --check` passed for `BaseClient.js`, `ToolService.js`, and
  `process.js`.
- Patch-contract checks confirmed the generic artifact mirror and Office
  server allowlist, and confirmed deterministic PPT routing/templates, direct
  CodeAPI fallback calls, Office retries, and stale skill instructions were
  absent.
- `LibreChat-API` restarted successfully and `LibreChat-CodeAPI` remained
  healthy. Nine temporary `502` responses occurred during the restart window;
  the service then recovered and remained reachable.
- Root returned `200`; `/api/config` returned valid JSON; `/office/` returned
  `401` with `WWW-Authenticate: Basic realm="Office Converter"`.
- The deployment skill was loaded from `/app/skill`.
- Existing startup warning: configuration version `1.2.8` is older than
  `1.3.13`. This predates and is unrelated to the file-pipeline change.

Post-deployment handler smoke rerun at 2026-07-10 22:12 HKT:

```json
{
  "ok": true,
  "primedCount": 2,
  "expectedNames": [
    "API渠道模型来源说明_基础版_a709f5cb.pptx",
    "模型_API_服务能力表_含GLM__1_.xlsx"
  ],
  "observedFiles": [
    "API渠道模型来源说明_基础版_a709f5cb.pptx",
    "模型_API_服务能力表_含GLM__1_.xlsx"
  ],
  "status": "success"
}
```

This smoke called the real exported tool handler with no graph
`codeSessionContext`. It proved that request-scoped primed refs recovered both
current-thread files into the same `/mnt/data` execution session and did not
create or modify a LibreChat message.

Authenticated browser verification on 2026-07-10 confirmed:

- A new conversation displayed the three intended upload entries and their
  operator descriptions.
- Existing generated PPTX and DOCX messages displayed real download buttons;
  DOCX preview rendering also loaded.
- Browser automation could open the Office file chooser but its control layer
  rejected setting a local synthetic XLSX. That automated attempt was not
  counted as an end-to-end pass.

Manual user acceptance later on 2026-07-10 completed the fresh-conversation UI
check:

- `PPT upload -> edit PPT -> download PPT`: passed.
- `Excel upload -> edit Excel -> download Excel`: passed.
- Together with the handler smoke, this verifies current-conversation file
  injection, model/tool editing, generated-artifact persistence, and visible
  download cards for the two primary bidirectional Office workflows.

Non-blocking format coverage still not explicitly exercised in this acceptance
run: DOCX editing, generated PDF cards, legacy binary `.ppt`, and the secondary
allowlisted formats XLSM, CSV, TSV, ODS, and ODP. These continue through the
same generic pipeline but should not be described as manually verified until
separately tested.

## Empty Response Regeneration Deployment

The user completed the remaining file-pipeline acceptance checks before this
deployment:

- A new blank conversation cannot access files from a different conversation.
- DOCX and Markdown generation return visible download cards.
- Unsupported upload formats are rejected by the intended file-type guards.

The empty-response recovery design was committed and pushed before
implementation:

```text
c2deb7a  Design empty response regeneration recovery
eb19708  Clarify empty abort persistence gate
```

Implementation and the atomic deployment script were then committed and pushed:

```text
5aa0552  Prevent empty assistant regeneration loops
5af2163  Add atomic empty response deployment
```

Production deployment completed at server timestamp `20260711001055`. Only
`LibreChat-API` was restarted. The changed host files and rollback backups are:

```text
/opt/librechat/office-context-patch/BaseClient.js
/opt/librechat/office-context-patch/BaseClient.js.bak-20260711001055
/opt/librechat/office-context-patch/api-index.cjs
/opt/librechat/office-context-patch/api-index.cjs.bak-20260711001055
```

Deployed checksums:

```text
f432035ec723a92a000ecd7e2738f437bdfa1cfef91e8f73832a03230b96528b  BaseClient.js
bd72c9707b3c075aa9d710a30fb7c7dedf405f4dd509c653ded52ddb7a8d267c  api-index.cjs
```

Deployment verification:

- Container `node --check` passed for both bind-mounted files before restart.
- Startup produced transient `502` responses while the API container was
  restarting; the committed deployment script waited until readiness returned.
- Root URL returned `200` after restart.
- `/api/config` returned `200` and was byte-identical to the captured
  pre-deployment response.
- `/office/` remained protected with `401`.
- `LibreChat-API` was running and `LibreChat-CodeAPI` remained healthy.
- API logs recorded both new protections:
  `[BaseClient] Omitted semantically empty assistant messages from history` and
  `[BaseClient] Rejected semantically empty assistant response`.
- The server staging directory
  `/tmp/librechat-empty-response-regeneration` was removed after deployment.

Affected-conversation browser verification:

- Conversation `d6313832-674c-47f5-b160-029506680698` previously ended at a
  persisted blank assistant sibling `4 / 4` for the latest user message.
- Regeneration after deployment invoked the normal tool path, recovered from an
  unavailable `Glob` call through Bash, and returned a complete visible answer.
- The new response displayed as `5 / 5` and remained present after a full page
  reload. No new blank sibling was created.

No-content stop verification:

- A normal, non-temporary Fable 5 conversation was started with a deliberately
  long verification prompt and stopped while its assistant bubble was still
  empty.
- After the stop completed and the page was reloaded, the verification user
  message remained, but there was no assistant heading, assistant content, or
  blank sibling. This confirms the persistent abort path no longer constructs
  an empty assistant row.

Residual non-blocking behavior: Fable 5 may still request the unavailable
Claude Code tool name `Glob`. In the verified run it recovered through Bash and
returned a normal answer. This is a model/tool-selection quality issue, not an
empty-response persistence failure.

Rollback: restore both timestamp-matched backups above, restart
`LibreChat-API`, then repeat root, `/api/config`, `/office/`, simple-chat, and
affected-conversation checks. No MongoDB rewrite is part of rollback.

## Historical Office/PPT Patch Record

The bullets below are the historical deployment record for the superseded
deterministic fallback and are retained for rollback/incident reconstruction:

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
- Office upload seeding fix was deployed on 2026-07-10 03:41 HKT after commit
  `131d5f9` was pushed. It archives and patches the production
  `/app/packages/api/dist/index.cjs` bind mount so
  `initializedAgent.primedCodeFiles` is passed into `createRun.initialSessions`
  before the first Bash/code call. Backups:
  `/opt/librechat/office-context-patch/BaseClient.js.bak-20260710034057` and
  `/opt/librechat/office-context-patch/api-index.cjs.bak-20260710034057`.
  Checksums changed to
  `fa7ee754510571ca0ae2e889e5f409dd3aee693b7ffccdd581f472f022f20d69`
  (`BaseClient.js`) and
  `197758d211c4d645c4372bcb624744461ab67afdf7efb4f70f8cd9d6b927ead2`
  (`api-index.cjs`). Verification confirmed container `node --check` passed
  for `/app/packages/api/dist/index.cjs` and
  `/app/api/app/clients/BaseClient.js`, production markers were present,
  root returned `HTTP/2 200`, `/api/config` returned JSON, and `/office/`
  returned `HTTP/2 401` with `realm="Office Converter"`.
- Runtime Office-file injection recovery was deployed on 2026-07-10 20:49 HKT
  after commit `b7076e2` was pushed. `ToolService.js` now caches fresh
  `primeCodeFiles()` results on the request and exposes them to runtime tool
  loading; `api-index.cjs` merges those refs into the effective code session
  immediately before Bash/code invocation when Graph omitted the context.
  Backups:
  `/opt/librechat/office-context-patch/ToolService.js.bak-20260710204908` and
  `/opt/librechat/office-context-patch/api-index.cjs.bak-20260710204908`.
  Checksums changed to
  `b55cee64fb292f795e13bc4e4e513ba157eff5e720f624ed78de969ee0bcb38a`
  (`ToolService.js`) and
  `6316d7dafe8b90a73036f2a8ce99122df6a79dae2630fb7dcdc278d8d4793357`
  (`api-index.cjs`). Container syntax, startup log, and HTTP checks passed.
  A real handler-level CodeAPI smoke deliberately omitted
  `codeSessionContext`; the runtime fallback recovered two primed refs and
  `/mnt/data` contained both
  `模型_API_服务能力表_含GLM__1_.xlsx` and
  `API渠道模型来源说明_基础版_a709f5cb.pptx` with status `success`.
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
