# LibreChat Context Safety Plan

Date: 2026-07-18

Status: design gate; implementation and production deployment pending.

## Scope

This plan applies only to the self-hosted LibreChat deployment. It does not
change WebAI, OpenWebUI, CodeAPI storage ownership, or historical conversation
content in the first release.

The goal is to keep complete user files and generated deliverables in the code
environment while returning only bounded structure, summaries, evidence
locations, and file manifests to the model context.

## Incident Evidence

Target conversation:

```text
https://152.32.172.162.sslip.io/c/64345282-da97-41a8-8971-1969e8d98087
```

Observed browser state:

- Context meter: `28万 of 36.1万 tokens used (77%)`.
- The run stopped with the LangGraph recursion-limit error at 50 steps. The
  context hard limit had not yet been reached.
- The uploaded JSON file was approximately 23.4 MB, but the file card itself
  was not the primary cause of prompt growth.
- Nine visible code-tool output blocks totaled approximately 614,497
  characters. Four individual blocks were approximately 200,035, 200,035,
  90,452, and 69,631 characters.
- The model printed serialized conversation/tool data instead of returning
  bounded summaries and artifact paths.

Current Admin Panel configuration inspection found these fields unconfigured:

- `工具结果最大字符数`;
- `递归限制`;
- `最大值递归限制`.

The deployed runtime resolves recursion in this order:

1. `endpoints.agents.recursionLimit`, defaulting to 50;
2. a positive per-agent `recursion_limit` override;
3. `endpoints.agents.maxRecursionLimit` as the hard cap.

Therefore setting only the default to 50 does not prevent a custom agent from
requesting a larger value.

## Approved Parameters

The first implementation must use:

```text
maxToolResultChars = 32000
recursionLimit = 50
maxRecursionLimit = 50
```

`32000` is a last-resort per-tool-result ceiling, not the target output size.
The processing contract targets `stdout <= 8000` characters.

## Processing Contract

For large JSON, CSV, Excel, Word, PowerPoint, and similar files:

- Permit one lightweight preflight that returns file size, structure, sheets,
  fields, record counts, and bounded representative samples.
- Run the main operation as one deterministic Python batch task. The task may
  stream, chunk, retry, checkpoint, and resume internally; "one task" does not
  mean loading the entire file into memory.
- Never print complete `data`, `repr(data)`, `pprint(data)`, workbook dumps,
  conversation histories, tool payloads, or raw response bodies.
- Keep normal `stdout` at or below 8,000 characters. A preview may contain at
  most five representative rows and twenty representative errors unless the
  user explicitly requests more.
- Write detailed results under `/mnt/data/<task-directory>/`, including, when
  applicable:
  - `manifest.json`;
  - requested Markdown, Excel, Word, PowerPoint, PDF, or ZIP deliverables;
  - `errors.json`;
  - bounded logs or checkpoint files required for resumption.
- Do not create a redundant full dump by default when the original file can
  remain the source of truth.
- The final tool result returns only counts, key warnings, and output paths.
- When a tool result is truncated, explicitly state that the detailed result is
  in the generated file and provide its file card.

The model may request targeted follow-up reads by sheet/range, chapter/page,
record ID, or JSON field. It must not reload an entire prior dump into the
conversation.

## User-Facing Messages

The user-facing layer must avoid exposing internal token, SDK, or stack-trace
terminology. The approved messages are:

- Large-file preflight: `检测到较大文件，将分块处理。原始内容不会全部加入对话上下文，请稍候。`
- Processing: `正在处理文件并生成结果，详细内容会保存为可下载文件。`
- Bounded output: `为保证对话稳定，当前回复仅保留摘要；完整结果已保存并附在下方文件中。`
- 70% context warning: `当前对话内容较多，任务仍可继续。后续长文件建议使用新对话，并携带当前任务摘要。`
- 85% context warning: `对话空间接近上限。建议先生成交接摘要，再开启新对话继续。`
- 95% context warning: `为避免任务失败，系统已暂停继续调用工具。已生成文件仍然保留。`
- Recursion stop: `本次处理步骤已达到安全上限，已停止继续尝试。已保留已生成结果和错误清单，可从未完成项继续。`
- Completion: `处理完成：共处理 X 项，成功 X 项，失败 X 项。完整结果、错误清单和清单文件已附上。`

The UI should offer `生成交接摘要`, `新建对话继续`, and `查看完整结果`
where the corresponding state is available. A continuation action carries the
task manifest and current-turn files, not the full historical tool output.

## Release Stages

### Stage A: backend and workflow guard

- Set the three approved agent configuration values.
- Preserve all unrelated YAML and active base Mongo config fields.
- Add the large-file batch contract to both active model prompt prefixes and
  the repository-owned document-processing guidance.
- Keep current-message uploads and current-turn generated files available in
  `/mnt/data`.
- Do not change recursion behavior beyond the default and hard cap.
- Recreate only the API service after the committed release is pushed.

### Stage B: browser-facing context notices

- Add the threshold notices to the active client release without replacing
  existing upload-menu or usage-dashboard assets.
- Detect the existing context meter at 70%, 85%, and 95%.
- Convert the raw recursion-limit failure into the approved user-facing copy
  while retaining a diagnostic detail path for operators.
- Verify the served HTML, asset marker, responsive layout, and normal chat
  behavior before production acceptance.

## Verification

Local:

- structural config merge is idempotent;
- unrelated config fields preserve their normalized hash;
- `maxToolResultChars`, `recursionLimit`, and `maxRecursionLimit` resolve to
  `32000`, `50`, and `50`;
- both model prompt prefixes contain the batch-processing contract;
- no secret or raw user export enters the repository;
- changed JavaScript passes `node --check`;
- `git diff --check` passes.

Production Stage A:

- backup YAML and the complete active base Mongo config before writing;
- API health, root, `/api/config`, and `/office/` boundary remain valid;
- CodeAPI, RAG-API, Nginx, MongoDB, and Admin Panel identities remain unchanged;
- a small JSON/Office smoke task returns bounded stdout and a downloadable
  manifest/result;
- a large-output fixture proves the result is stored as an artifact rather
  than returned as an unbounded tool message.

Production Stage B:

- fresh authenticated browser session shows the context warnings at each
  threshold;
- recursion-stop state shows the friendly message and preserves files;
- normal chat, upload menu, Office workflow, download cards, usage dashboard,
  and web search remain functional.

## Rollback

Before any production write, create a timestamped backup of:

- `librechat.yaml`;
- the complete active base Mongo config document;
- the active client mount and Compose override for Stage B.

On failure, restore the exact backups and recreate only the service changed by
the stage. No conversation, file, or user data is modified by the release.
