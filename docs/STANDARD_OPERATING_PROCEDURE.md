# Standard Operating Procedure

Project: self-hosted LibreChat

Production URL:

```text
https://152.32.172.162.sslip.io/
```

Last external verification in this project: 2026-07-15.

## 1. Scope

This SOP covers routine operation, small releases, provider/model changes,
frontend runtime patches, file-upload behavior, incident triage, rollback, and
documentation hygiene for the self-hosted LibreChat deployment.

It intentionally separates verified production facts from assumptions. When a
server path, service name, Docker Compose file, or credential is not present in
this repository, verify it on the server before writing it into permanent docs.

## 2. Current Production Facts

Externally verified on 2026-07-09:

- Root URL returns `HTTP/2 200`.
- Server header is `nginx/1.20.1`.
- HTML title is `LibreChat`.
- `/api/config` reports `appTitle: "LibreChat"`.
- Public registration is disabled: `registrationEnabled: false`.
- Email/password login is enabled: `emailLoginEnabled: true`.
- Password reset email is disabled: `passwordResetEnabled: false`.
- Social login providers are disabled.
- Build info reports commit `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`
  on branch `main`, built at `2026-07-05T16:06:59Z`.
- `/office/` is a protected deployment-level Office/Excel reader backend used
  to extract workbook/document content for LibreChat workflows.
- The delivered HTML includes a runtime upload-menu patch that maps LibreChat
  upload choices into clearer Chinese labels and applies file-type guards:
  - `Upload to Provider` -> `图片上传`
  - `Upload to Code Environment` -> `Office文件上传`
  - `Upload as Text` -> `文件提取文字上传`

Keep `docs/PRODUCTION_VERIFICATION.md` updated when these facts change.

## 3. Roles And Ownership

- Product/operator: decides user-facing behavior, model availability, login
  policy, and wording.
- Engineer/operator: applies configuration, deploys updates, verifies smoke
  tests, and maintains rollback paths.
- Reviewer: checks that no secrets, private data, or unnecessary logs enter the
  repository.

For one-person operation, run through the same checklist explicitly before a
production change.

## 4. Daily Health Check

Run these from a trusted machine:

```sh
curl -k -I https://152.32.172.162.sslip.io/
curl -k -L https://152.32.172.162.sslip.io/api/config
```

Pass criteria:

- Root page returns `200`.
- `/api/config` returns JSON.
- The page still identifies as LibreChat.
- Registration remains disabled unless intentionally opened.
- Login page can be opened in a browser.
- A known admin/test account can sign in.
- A simple chat message returns non-empty assistant content.

Optional deeper checks after releases:

- Upload a small text file and verify normal attachment behavior.
- If code execution is enabled, run a tiny calculation such as `2 + 2`.
- If Office/document conversion is used, test one small XLSX workbook and one
  representative DOCX/PPTX file when relevant.

## 5. Change Intake

Before changing production, write down:

- Change name and date.
- Reason for the change.
- Files, environment variables, or service settings expected to change.
- User-visible behavior expected to change.
- Verification commands.
- Rollback action.

For small changes, use `docs/RELEASE_CHECKLIST.md`. For larger changes, create a
dated release note under a future `releases/` directory.

## 6. Mandatory Production Change Gate

This gate is mandatory for every production write. There is no firefighting
bypass.

Allowed before this gate:

- Read-only diagnostics: HTTP checks, browser inspection, log reads, MongoDB
  reads, container status reads, and CodeAPI smoke checks that do not alter
  production state.
- Temporary diagnostic scripts under `/tmp` only when they are read-only,
  removed after use, and mentioned in the final notes.

Not allowed before this gate:

- Editing or replacing production files, including bind-mounted patch files.
- Restarting containers or services.
- Changing Nginx, Docker Compose, `librechat.yaml`, skills, static assets, or
  route handlers.
- Updating MongoDB, Redis, uploads, generated assistant attachments, or saved
  conversations.
- Applying a "small hotfix" that is not already represented in the repository.

Required before any production write:

1. Record the intended change in the repository.
   - Add or update the patch file, config snapshot, skill file, or deployment
     archive that represents exactly what will be applied.
   - Add a short change record with reason, expected behavior, affected files,
     feature/function list, verification plan, and rollback action.
   - Update the SOP, production verification log, release checklist, or
     customization audit when behavior or operating rules change.
2. Run the relevant local checks, such as syntax checks for JavaScript patches
   or a secret scan for files being added.
3. Commit the repository change.
4. Push the commit to `origin/main`.
5. Confirm `git status --short --branch` shows the local branch aligned with
   `origin/main`.

If commit or push cannot complete, stop and report the block. Do not continue
with a production write.

After the production write:

- Verify production with the documented checks.
- Capture any production files that differ from the committed plan.
- Commit and push a follow-up record if the applied state, verification result,
  rollback path, or feature list changed.

Manual repairs count as production writes. This includes attaching generated
files to old conversations, editing saved assistant messages, or changing file
metadata in MongoDB.

## 7. Release Workflow

1. Capture current state.

   ```sh
   curl -k -I https://152.32.172.162.sslip.io/
   curl -k -L https://152.32.172.162.sslip.io/api/config
   ```

2. Confirm there is a rollback path.

   Examples:

   - Previous container image tag is known.
   - Previous configuration file is backed up.
   - Runtime patch can be removed independently.
   - Database backup exists before schema-impacting work.

3. Pass the mandatory production change gate in section 6. If the gate is not
   complete, stop here.

4. Apply the smallest committed and pushed change that solves the problem.

5. Restart only the services that must restart.

   Deployment skills are a restart-required case in this LibreChat version.
   The API reads deployment `SKILL.md` files into an in-memory
   `DeploymentSkillRegistry` during startup. Replacing a bind-mounted skill
   file without restarting changes the filesystem only; it does not refresh
   the active `skill.body`. If a release explicitly forbids restart, record it
   as "file deployed, runtime activation pending" and do not claim that the new
   skill behavior passed production acceptance.

6. Run post-change verification:

   - HTTP check.
   - Browser login check.
   - Simple chat completion.
   - File upload check when upload behavior changed.
   - Code-environment check when execution behavior changed.

7. Record result in the release note or checklist. Commit and push any
   difference between the planned and actual production state.

## 8. Configuration Standards

Do:

- Keep production secrets in server-side environment files or secret stores.
- Keep this repository free of API keys, tokens, cookies, private URLs with
  credentials, and raw user data.
- Pin production versions where possible instead of relying indefinitely on
  floating branches.
- Verify public behavior through `/api/config` after changing auth or interface
  settings.

Do not:

- Commit `.env` files containing real values.
- Paste private request/response bodies into docs.
- Assume a config flag proves a backend capability works.
- Enable public registration without an explicit product decision.

### User Account Lifecycle

The Admin Panel `/access` page manages roles and groups; it does not create
LibreChat login accounts. Public registration is disabled in production, so
new accounts must be created with LibreChat's supported CLI after passing the
mandatory production change gate:

```sh
cd /opt/librechat
docker compose exec api node /app/config/create-user.js \
  <email> <name> <username>
```

Use the absolute script path for this deployment. The production API
container starts in `/app/api`, so invoking `npm run create-user` inside that
container currently resolves the script as `/app/api/create-user.js` and
fails before touching MongoDB.

- Enter the password interactively or through non-echoed standard input. Never
  pass it as a command argument or record it in this repository.
- Keep email verification enabled for locally managed accounts when production
  email delivery is disabled.
- Verify the new credentials through `POST /api/auth/login` without printing or
  saving returned access or refresh tokens.
- Use `/access` only after account creation when role or group membership needs
  to change.
- For an immediate rollback of an unused account, use the supported
  `node /app/config/delete-user.js <email>` flow and confirm that the account
  has no user data before deletion.

## 9. Model And Provider Changes

When adding or changing a model/provider:

1. Confirm the provider base URL and model names in the server config.
2. Store provider keys only in the server environment.
3. Verify a simple text chat.
4. Verify a longer answer to catch streaming or timeout issues.
5. If tools/code execution are involved, verify tool calls separately.
6. If image generation is involved, verify the correct image endpoint and UI
   path rather than selecting an image-only model as a normal chat model.
7. Document the user-facing model name, provider, and known limitations.

## 10. File Upload And Code Environment

The current frontend patch clarifies upload choices for Chinese operators and
prevents common wrong-route uploads:

- `图片上传`: image-only upload path.
- `Office文件上传`: route Office/table files to the code-execution environment
  for reading, editing, and returning artifacts.
- `文件提取文字上传`: extract text and send text context for analysis.

The production menu also shows short operator guidance under each choice:

- `图片上传`: `仅图片；用于截图、照片、图像识别`
- `Office文件上传`: `Word/Excel/PPT 原文件；可读写并返回文件`
- `文件提取文字上传`: `转成文本给模型分析；适合审阅总结`

Operational rules:

- Use `图片上传` only for image files such as PNG, JPG/JPEG, WEBP, GIF, BMP,
  SVG, HEIC/HEIF, and AVIF.
- Use `Office文件上传` for Office/table files handled by CodeAPI:
  DOCX, XLSX, XLSM, PPT, PPTX, CSV, TSV, ODS, and ODP.
- Use `文件提取文字上传` for document/text extraction, including PDF, legacy
  DOC/XLS/PPT, DOCX/XLSX/PPTX, TXT/Markdown, CSV/TSV, JSON/HTML/RTF, and
  ODT/ODS/ODP.
- CodeAPI can generate Office artifacts as well as parse them. The verified
  PPT path is Python `python-pptx` writing `.pptx` files under `/mnt/data`;
  Excel generation/modification uses `openpyxl`.
- The Anthropic model prompt must point the model at the actually available
  code tool (`Bash` in this deployment) and must tell it not to use Claude Code
  helper names such as `Glob`, `Read`, `Edit`, or `LS`.
- Production must use one generic model/tool path for Office work. Uploaded
  CodeAPI references are injected into the current code session under
  `/mnt/data`; generated files return through the normal code-artifact callback
  and download-card pipeline. `BaseClient.js` must not detect PPT keywords,
  call CodeAPI directly, run a fixed Office template, synthesize tool calls, or
  retry an Office request with a hidden prompt.
- The deployment `office-document-parser` skill covers both extraction and
  Office artifact generation/modification. PPT generation uses `python-pptx`;
  Excel generation/modification uses `openpyxl`; generated files must be saved
  under `/mnt/data`. The skill is not always applied and must not redirect users
  to `/office/` when the current code session is missing an upload.
- Excel analysis must use the original workbook as the fact source. For initial
  review requests, return structure, headers, counts, key fields, and bounded
  previews; filter and aggregate in Python before sending data into model
  context.
- Do not create whole-workbook TXT, Markdown, CSV, JSON, or `full_dump`
  intermediates unless the user explicitly requests an export. Reopen the
  original workbook on later tool calls instead of persisting a complete text
  copy. Only requested deliverables should become download cards.
- Treat deployment-skill disk state and runtime state as separate checks. A
  matching host/container `SKILL.md` hash proves only that the file is mounted;
  a fresh conversation can prove the new behavior only after the API registry
  has been reloaded by an approved restart.
- If a conversation returns empty content after an upload, inspect backend logs
  and saved message metadata before assuming the model is slow or that PPT
  generation is unsupported.

## 11. Office/Excel Reader Backend

The `/office/` route is a deployment-level backend capability for LibreChat
workflows. It is not upstream LibreChat core code, but it is part of our
practical file-reading stack.

Current public check:

```sh
curl -k -I https://152.32.172.162.sslip.io/office/
```

Expected boundary:

```text
HTTP/2 401
WWW-Authenticate: Basic realm="Office Converter"
```

Use this backend when:

- An Excel/XLSX workbook needs to be read before analysis in LibreChat.
- A normal LibreChat attachment is visible in chat but not available to the
  code/tool environment.
- The provider path cannot reliably parse the original Office file.
- DOCX/PPTX content needs to be converted into text/Markdown before model
  analysis.

Operating rules:

- Treat uploaded Office files as private user data.
- Prefer sanitized extracted text/table content when moving information back
  into LibreChat.
- After deployment changes, verify with a small XLSX workbook before trusting
  the route for production Excel analysis.
- Do not document real workbook contents, request payloads, or extracted private
  data in this repository.

## 12. Frontend Runtime Patches

Runtime patches are allowed for small wording or UX fixes, but they must be:

- Clearly named.
- Easy to find in delivered HTML or static assets.
- Safe to remove.
- Covered by browser verification after deployment.
- Represented in this repository, committed, and pushed before production
  deployment.

For the upload-menu patch, verify the menu still shows the intended Chinese
labels and blocks invalid file types after each frontend rebuild or asset
refresh.

## 13. Incident Response

Incident response starts with read-only diagnosis. Any corrective action that
changes production must pass the mandatory production change gate first. If the
gate is blocked by missing credentials, unclear rollback, or inability to push,
stop and report the block instead of applying an untracked fix.

### Blank Page Or Asset Failure

1. Check root HTML:

   ```sh
   curl -k -I https://152.32.172.162.sslip.io/
   ```

2. Check the main asset referenced by HTML returns `200`.
3. In a browser, hard refresh and clear service worker/cache if the page is
   stale.
4. If a runtime patch was recently changed, remove that patch first and retest.

### Login Failure

1. Confirm `/api/config` still reports the intended login settings.
2. Test in a real browser, not only with `curl`.
3. Confirm public registration remains in the intended state.
4. Check server logs for failed auth, session, or CSRF errors.

### Slow Or Empty Chat Reply

1. Determine whether the assistant reply was saved with real content.
2. Check model/provider latency separately from LibreChat UI state.
3. Check whether attachments reached the intended path.
4. Run a fresh simple conversation to separate global failure from a
   conversation-specific issue.

### Upload Or Code Execution Failure

1. Reproduce with a tiny file.
2. Check which upload option was selected.
3. Verify the code-execution backend separately.
4. If code execution is unavailable, use a separate trusted document-conversion
   path rather than pretending the file reached the tool environment.

## 14. Rollback

Rollback order for production incidents:

1. Disable or remove the newest runtime patch.
2. Restore the previous config file or environment values.
3. Revert to the previous container image or build.
4. Restore database or volume backup only when data corruption is confirmed.

After rollback, run the same checks as a normal release and document the
incident.

## 15. Security Rules

- Treat uploaded files and chat logs as private user data.
- Do not export production conversations into this repository.
- Do not share API keys, cookies, JWTs, database URLs, or provider credentials.
- Keep `x-robots-tag: noindex` unless the product intentionally becomes public
  and indexable.
- Rotate any secret that appears in a document, terminal output, screenshot, or
  chat transcript intended for external sharing.

## 16. Documentation Maintenance

Update this SOP when:

- Production URL changes.
- Auth policy changes.
- Registration is opened or closed.
- Model/provider list changes.
- File-upload behavior changes.
- Code execution or document conversion paths change.
- Deployment method changes.
- A new recurring incident pattern is discovered.

Every doc update should preserve the difference between:

- Verified current facts.
- Intended operating rules.
- Historical notes that may be stale.
