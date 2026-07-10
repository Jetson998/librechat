# Empty Response and Regeneration Recovery Plan

Date: 2026-07-10

Status: diagnosed and approved for repository implementation. Production is
unchanged until the design and implementation commits are pushed.

## Incident

Affected conversation:

```text
d6313832-674c-47f5-b160-029506680698
```

Observed production behavior:

- The branch contains a cancelled tool run followed by an empty assistant
  response after the user message `停止`.
- The next user message, `我们文件库 有没有文件可以参考`, had three empty
  assistant siblings when diagnosis began.
- A controlled fourth regeneration started normally, displayed the stop button,
  ended after about 20 seconds without user cancellation, and created sibling
  `4 / 4` with no text, content card, tool call, or visible error.
- Reloading the page preserved `4 / 4`, proving the empty assistant response was
  saved by the backend rather than lost only in the live frontend stream.
- The same prompt with the same Fable 5 model succeeded in a temporary fresh
  conversation. It attempted `Glob`, recovered through `Bash`, inspected the
  empty current sandbox, and returned a normal answer. The model endpoint and
  CodeAPI were therefore not globally unavailable.

## Root Cause

The failure is a conversation-history and persistence defect:

1. `BaseClient.loadHistory()` currently forwards semantically empty assistant
   messages from the selected branch into the next provider request.
2. This conversation already contains an empty assistant turn produced after a
   cancelled/empty generation. The affected Anthropic relay returns an empty
   completion when that branch is regenerated.
3. `BaseClient.sendMessage()` currently saves the assistant response even when
   the returned completion has no meaningful text, reasoning, tool result,
   attachment, or generated file. Every regeneration therefore adds another
   empty sibling.
4. `GenerationJobManager.abortJob()` can also construct an empty assistant
   response when a `created` event was emitted but no persistable content was
   produced. That creates new history entries capable of poisoning later turns.

## Required Behavior

- Existing empty assistant rows may remain visible for audit/history, but they
  must not be sent back to the model as conversational context.
- A provider completion with no meaningful assistant content and no artifact
  must never be saved as a successful blank response.
- An abort before any meaningful content exists must finish as an early abort
  without creating an assistant placeholder, even if the user-message
  `created` event already fired.
- Non-empty text, reasoning, completed tool calls, tool output, attachments,
  generated files, citations, and UI resources must be preserved.
- The fix must be endpoint- and document-format-agnostic. It must not add an
  Office/PPT keyword route or a prompt-based retry.
- The fix must not automatically delete or rewrite existing conversation rows.

## Repository Changes

### `BaseClient.js`

Add a shared semantic-content check for assistant messages.

Use it in two places:

1. After the selected branch is reconstructed and historical attachments are
   resolved, omit semantically empty assistant messages from the provider
   history. Log only message IDs and counts, not message text.
2. After completion content and artifacts are assembled but before
   `saveMessageToDatabase`, reject a semantically empty assistant result with a
   stable `EMPTY_MODEL_RESPONSE` error. The normal request error path must show
   a visible failure instead of persisting a blank success message.

### `api-index.cjs`

In `GenerationJobManager.abortJob()`, treat any abort with no persistable
content as an early abort. Do not use `createdEventEmitted` as permission to
create an empty assistant response. The returned abort result must also tell
the existing abort middleware that there is no response to persist; otherwise
that caller can independently construct and save an empty assistant row even
when the emitted final event has `responseMessage: null`.

### Tests

Add a focused test script covering:

1. Blank `text`, empty `content`, and blank text parts are semantically empty.
2. Text, reasoning, completed tool output, and downloadable artifacts remain
   meaningful.
3. Historical empty assistant messages are removed while user messages and
   non-empty assistant messages retain branch order.
4. Empty provider completion is rejected before assistant persistence.
5. Abort with no persistable content is an early abort regardless of the
   `createdEventEmitted` flag and is returned as non-persistable to the abort
   middleware.
6. Existing file-pipeline tests remain green.

## Production Verification

After the implementation commit is pushed:

1. Create timestamp-matched backups for production `BaseClient.js` and
   `api-index.cjs`.
2. Run container syntax checks before restart.
3. Restart `LibreChat-API` only.
4. Verify root, `/api/config`, `/office/`, and CodeAPI health.
5. Re-open the affected conversation and regenerate the latest user message.
   It must produce a visible answer or visible error, never another blank
   sibling.
6. Run a temporary fresh-conversation control to confirm normal text and tool
   responses are unchanged.

## Rollback

Restore the timestamp-matched `BaseClient.js` and `api-index.cjs` backups,
restart `LibreChat-API`, and repeat the HTTP and simple-chat smoke checks. Do
not modify conversation data as part of rollback.
