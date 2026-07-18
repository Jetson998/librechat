# LibreChat Context Safety Stage B Plan

Date: 2026-07-18

Status: design gate prepared; implementation, commit, push, and production
deployment have not started.

## Objective

Add browser-facing context warnings and a friendly recursion-stop state without
changing LibreChat's compressed application bundle, backend graph execution,
Office pipeline, CodeAPI storage, conversation rows, or existing custom Client
assets.

Stage B must remain a separate release from the completed Stage A backend and
workflow guard.

## Observed Production Baseline

Read-only production discovery on 2026-07-18 found:

```text
api_container=5e64f9129da345b2172afc230878ff95ba212a27ae1e7d683d182b077da5911c
compose_override_sha=90a03305d3f1706f1363e33b7a7368fe9dc69a11cb31858c1535a571669aa1ec
client_mount=/opt/librechat/user-usage-dashboard/bbae4f4-charts-20260718175030/client-dist
client_index_sha=29306df25134b09716727523eaeea0bfca1d75029a8ffc89ec02b47a4bf105e0
main_asset=assets/index.P3glMaNP.js
```

The active Client also contains these protected custom assets:

```text
business-upload-menu.js=a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9
odysseia-login.js=aeb91c87012ee37a7c94635f3673f9c4747c39245f2c0242eae4d6a79e860f27
user-usage-dashboard.js=6f76a7379c01d640460bf34864b88554771ca43c18e063239c5d1a294300433f
user-usage-dashboard.css=2817b8722535d3d46c514c8b93c8713abe4852860cc0075e5c07df1b0f4a01ff
```

The affected production conversation is:

```text
https://152.32.172.162.sslip.io/c/64345282-da97-41a8-8971-1969e8d98087
```

Its rendered DOM exposes stable upstream contracts:

- context trigger: `[data-testid="token-usage"]`;
- numeric meter: `[role="meter"][aria-valuenow][aria-valuemax]`;
- observed values: `279617 / 361000`, rounded to `77%`;
- composer: `#prompt-textarea[data-testid="text-input"]`;
- send control: `[data-testid="send-button"]`;
- stop control while active: `[data-testid="stop-generation-button"]`;
- recursion error: `[role="alert"]` containing
  `Recursion limit of 50 reached without hitting a stop condition`.

## Implementation Shape

Create a repository-owned external asset pair:

```text
context-safety-ui.js
context-safety-ui.css
```

The release copies the complete current mounted Client into a new versioned
directory, installs the two assets, and injects one stylesheet marker and one
deferred script marker into `index.html`. It must not edit
`assets/index.P3glMaNP.js` or replace any existing custom asset.

The script exposes a frozen `window.__contextSafetyUIContract` containing its
version, thresholds, exact messages, and pure threshold classifier for tests.
It installs only once and uses a bounded `MutationObserver` to re-evaluate the
meter, composer, generated-file controls, and exact recursion-error candidates.

## Threshold Behavior

The numeric source of truth is `aria-valuenow / aria-valuemax`. Localized text
is never parsed. Unknown or invalid maximum values produce no warning.

### Below 70%

- render no context warning;
- do not alter form submission or generation controls.

### 70% Through 84%

Render a non-blocking status band immediately above the composer:

```text
当前对话内容较多，任务仍可继续。后续长文件建议使用新对话，并携带当前任务摘要。
```

Offer `生成交接摘要` and `新建对话继续` controls. Generating a handoff only
prefills a bounded, no-tools summary request in the existing composer; it does
not submit a model request automatically.

### 85% Through 94%

Render a stronger warning band:

```text
对话空间接近上限。建议先生成交接摘要，再开启新对话继续。
```

Keep the same explicit user-controlled actions. Do not trigger an automatic
model call or navigation.

### 95% And Above

Render a blocking alert band:

```text
为避免任务失败，系统已暂停继续调用工具。已生成文件仍然保留。
```

The browser guard must:

- click the native stop-generation control at most once for the current 95%
  episode when it is present and enabled;
- block subsequent composer submits, send-button clicks, and Enter-to-send
  while the displayed context remains at or above 95%;
- keep file-card open and download controls available;
- offer `新建对话继续` and `查看完整结果` actions;
- remove the block automatically if the numeric meter later falls below 95%.

This is a browser guard, not a backend transaction rollback. Work already
accepted by the backend before the meter update may finish or require the
native stop request to propagate.

## Action Boundaries

`生成交接摘要` inserts a fixed request capped below 1,000 characters and
focuses the composer. The user remains responsible for sending it.

`新建对话继续` creates a bounded handoff draft in `sessionStorage` containing:

- the previous conversation URL;
- the latest visible user request, capped at 2,000 characters;
- up to twenty visible generated-file names;
- no tool output, hidden reasoning, raw file content, credential, or complete
  conversation history.

The action then navigates to `/c/new`; Stage B prefills the draft but does not
submit it. Binary file cloning is deliberately excluded because the current
Client exposes download buttons but no supported cross-conversation file-copy
contract. DOM download-and-reupload automation would create a fragile second
upload pipeline.

`查看完整结果` scrolls to the latest visible generated-file card. It is hidden
when no generated-file card is available.

## Recursion Error Normalization

Only an alert whose text matches both of these case-insensitive fragments is
eligible:

```text
Recursion limit of <number> reached
without hitting a stop condition
```

Replace its visible body with:

```text
本次处理步骤已达到安全上限，已停止继续尝试。已保留已生成结果和错误清单，可从未完成项继续。
```

The original alert text and troubleshooting URL remain available inside a
collapsed `技术详情` disclosure for operators. Code blocks, user messages, and
ordinary text containing similar words must not be changed.

## Deployment Boundary

The production runner must:

1. require the implementation commit to be pushed to `origin/main`;
2. verify the exact active Compose, Client index, and protected custom-asset
   hashes listed above;
3. run local JavaScript, CSS/HTML, fixture, idempotency, and secret checks;
4. copy the complete current Client into a new versioned release directory;
5. inject the two Stage B assets exactly once;
6. back up the complete Compose override and current Client index;
7. replace only the `/app/client/dist:ro` mount;
8. recreate only `LibreChat-API` with `--no-deps`;
9. verify protected container identities, public assets, route health, Office
   boundary, and all existing Client asset markers;
10. roll back the exact Compose override and recreate only the API service on
    any failure.

No Nginx, MongoDB, Admin Panel, CodeAPI, RAG-API, Office Skill, model config,
user, conversation, file, generated artifact, or WebAI/OpenWebUI resource is
in scope.

## Verification

Local tests must cover:

- classifier boundaries at `69.99`, `70`, `84.99`, `85`, `94.99`, and `95`;
- invalid and unknown meter values;
- exactly one warning band after repeated mutations;
- message and action changes at all three thresholds;
- 95% submit, click, and Enter guards;
- stop-generation invoked no more than once per 95% episode;
- automatic unblock below 95%;
- exact recursion-error replacement and preserved technical details;
- no replacement inside normal text or code blocks;
- handoff draft character and file-name bounds;
- new-conversation draft prefill without automatic submission;
- generated-file scroll action;
- narrow and desktop fixture layout;
- preservation of upload-menu, login-page, usage-dashboard, and main asset
  references;
- `node --check`, release test, secret scan, and `git diff --check`.

Production browser acceptance must combine:

- the real 77% conversation for upstream meter integration and recursion-error
  normalization;
- a production-served isolated fixture for 70%, 85%, and 95% rendering and
  95% interaction blocking;
- a fresh normal conversation for chat, upload menu, generated-file cards,
  usage dashboard, and web-search regressions;
- desktop and mobile viewport checks with no overlap or clipped text.

## Rollback

Restore the timestamped `compose.override.yaml` backup and recreate only
`LibreChat-API`. The prior versioned Client directory remains unchanged and is
the rollback mount target. No database or file-storage rollback is required.
