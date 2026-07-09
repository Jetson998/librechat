# Standard Operating Procedure

Project: self-hosted LibreChat

Production URL:

```text
https://152.32.172.162.sslip.io/
```

Last external verification in this project: 2026-07-09.

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
- The delivered HTML includes a runtime upload-label patch that maps LibreChat
  upload choices into clearer Chinese labels, including:
  - `Upload to Provider` -> `原文件上传`
  - `Upload as Text` -> `提取文字上传`
  - `Upload to Code Environment` -> `用代码读取文件`

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
- If Office/document conversion is used, test one small DOCX/XLSX/PPTX file.

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

## 6. Release Workflow

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

3. Apply the smallest change that solves the problem.

4. Restart only the services that must restart.

5. Run post-change verification:

   - HTTP check.
   - Browser login check.
   - Simple chat completion.
   - File upload check when upload behavior changed.
   - Code-environment check when execution behavior changed.

6. Record result in the release note or checklist.

## 7. Configuration Standards

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

## 8. Model And Provider Changes

When adding or changing a model/provider:

1. Confirm the provider base URL and model names in the server config.
2. Store provider keys only in the server environment.
3. Verify a simple text chat.
4. Verify a longer answer to catch streaming or timeout issues.
5. If tools/code execution are involved, verify tool calls separately.
6. If image generation is involved, verify the correct image endpoint and UI
   path rather than selecting an image-only model as a normal chat model.
7. Document the user-facing model name, provider, and known limitations.

## 9. File Upload And Code Environment

The current frontend patch clarifies upload choices for Chinese operators:

- `原文件上传`: send the original file to the selected provider path.
- `提取文字上传`: extract text and send text context.
- `用代码读取文件`: route the file to the code-execution environment.

Operational rules:

- Use `提取文字上传` for simple text review when formatting is not critical.
- Use `原文件上传` when the provider needs the original binary and the data is
  safe to send.
- Use `用代码读取文件` only after verifying that the backend code environment is
  actually reachable.
- If a conversation returns empty content after an upload, inspect backend logs
  and saved message metadata before assuming the model is slow.

## 10. Frontend Runtime Patches

Runtime patches are allowed for small wording or UX fixes, but they must be:

- Clearly named.
- Easy to find in delivered HTML or static assets.
- Safe to remove.
- Covered by browser verification after deployment.

For the upload-label patch, verify the menu still shows the intended Chinese
labels after each frontend rebuild or asset refresh.

## 11. Incident Response

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

## 12. Rollback

Rollback order for production incidents:

1. Disable or remove the newest runtime patch.
2. Restore the previous config file or environment values.
3. Revert to the previous container image or build.
4. Restore database or volume backup only when data corruption is confirmed.

After rollback, run the same checks as a normal release and document the
incident.

## 13. Security Rules

- Treat uploaded files and chat logs as private user data.
- Do not export production conversations into this repository.
- Do not share API keys, cookies, JWTs, database URLs, or provider credentials.
- Keep `x-robots-tag: noindex` unless the product intentionally becomes public
  and indexable.
- Rotate any secret that appears in a document, terminal output, screenshot, or
  chat transcript intended for external sharing.

## 14. Documentation Maintenance

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
