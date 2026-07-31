# Incident handoff: Office pre-parse invalid manifest

## Conclusion

The production failure is in the Office pre-parse result parser, before the
model request. The Bash tool result contains one valid
`__LIBRECHAT_OFFICE_MANIFEST__` JSON object followed by wrapper-appended stderr.
The stderr is an `openpyxl` `UserWarning` stating that the workbook contains no
default style. The old parser passes the complete suffix to `JSON.parse()`, so
the warning after the valid JSON is incorrectly treated as manifest content.

This is a confirmed result-boundary bug. It is not malformed Office data, a
CodeAPI execution failure, or a model response failure.

## Production evidence

`LibreChat-API` logged the following `Initialization error` entries. Times are
shown in Singapore time (UTC+8), converted from the container UTC timestamps.

| Time | Error position | User marker |
| --- | ---: | --- |
| 2026-07-31 15:44:44 | 38569 | `userId=6a61...80b` |
| 2026-07-31 16:12:41 | 38569 | `userId=6a61...80b` |
| 2026-07-31 16:14:43 | 33758 | `userId=6a61...80b` |
| 2026-07-31 16:15:51 | 33758 | `userId=6a61...80b` |
| 2026-07-31 16:34:42 | 38569 | `userId=6a61...80b` |
| 2026-07-31 17:04:49 | 20181 | `userId=6a61...80b` |
| 2026-07-31 17:13:42 | 24992 | `userId=Bill` |

The exact server error was:

```text
[ResumableAgentController] Initialization error:
Office pre-parse returned an invalid manifest:
Unexpected non-whitespace character after JSON at position N
(line 3 column 1)
```

For every reproduced failure, the reported JSON position is exactly the valid
manifest length plus the two newlines before the appended stderr. The observed
stderr was:

```text
/usr/local/lib/python3.11/site-packages/openpyxl/styles/stylesheet.py:237:
UserWarning: Workbook contains no default style, apply openpyxl's default
```

## Code path

Relevant file:

`deployment/production-patches/2026-07-20-office-file-identity/office-context-patch/OfficePreparse.js`

1. `buildParser()` runs Python against `/mnt/data` and prints exactly one
   marker plus `json.dumps({"files": manifest})`.
2. `toolContent()` converts the tool response into a string. For a content
   array it joins every part with `\n`, so additional parts become part of the
   parse input.
3. `lastIndexOf(MANIFEST_MARKER)` selects the marker.
4. The complete remaining suffix, including wrapper stderr, is passed to
   `JSON.parse()`.

The failure is at the `JSON.parse(content.slice(...).trim())` boundary. The
parser does not isolate one balanced JSON object from the tool wrapper output.

## Why the second error appeared

The pre-parse exception occurs during resumable request initialization, before
`client.sendMessage()`. The controller has already issued a temporary assistant
response ID ending in `_`, but neither the user message nor that response is
saved. The exception branch only emits an error and completes the job. The next
request therefore cannot find its selected parent in MongoDB and is rejected by
`rejectPreliminaryParentMessageId()` with HTTP 409:

```text
Cannot submit a follow-up while the selected parent response is still being saved.
Please wait and try again.
```

This is a permanent orphaned-parent state, not a temporary save race and not a
bad model follow-up. It does not recover by waiting because no code later saves
that preliminary response.

## Recommended fix order

The development patch is located at:

`deployment/production-patches/2026-07-31-office-preparse-result-contract-fix`

It implements the following bounded changes:

1. Extract exactly the first balanced JSON object after the manifest marker,
   including correct handling of braces and escapes inside JSON strings.
2. Keep recognized stderr and generated-file wrapper output outside the trusted
   manifest; reject duplicate manifests and unexpected trailing formats.
3. Log only trailing-output classification, length, and content-part count.
4. Persist the preliminary user message, terminal assistant error, and new
   conversation metadata when initialization fails before `sendMessage()`.
5. Emit a terminal final event after persistence so an immediate follow-up can
   resolve the underscore-suffixed parent instead of returning 409.

## Acceptance criteria

- A valid Office upload with normal tool output reaches the model.
- A tool response with trailing output returns one visible terminal error and
  does not leave the parent response permanently saving.
- An immediate follow-up returns a deterministic retryable response and does
  not create a blank assistant sibling.
- Logs identify `conversationId`, `streamId`, model, file count, and parser
  failure class, while excluding document previews, authorization headers, and
  raw user content.
