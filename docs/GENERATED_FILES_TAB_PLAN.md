# Generated Files Tab Plan

Date: 2026-07-22

## Goal

Add a separate `生成的文件` tab inside LibreChat's existing `我的文件`
dialog. Keep uploaded files and generated deliverables visibly separated without
changing how files are attached to model context.

## Data Contract

The generated-files list is derived from completed assistant message references,
not from every `execute_code` row in the files collection.

- identity always comes from `req.user.id`;
- only assistant messages owned by that user are scanned;
- only referenced files owned by that user are returned;
- only files with `context=execute_code` are eligible;
- message references explicitly marked `artifactRole=intermediate` are excluded;
- duplicate references are collapsed by `file_id`, keeping the latest delivery;
- prompts, responses, tool output, hidden QA files, and files from other users
  are never returned;
- listing a generated file does not attach it to the current conversation or add
  it to model context.

This uses the final assistant attachment as the customer-visible source of truth.
The native file row remains the source of download metadata and ownership.

## User Experience

The existing dialog title remains `我的文件` and receives two compact tabs:

1. `上传的文件` keeps the native LibreChat table unchanged.
2. `生成的文件` shows delivered outputs with file name, type, size, source
   conversation, generated time, and download action.

The generated tab includes filename search, pagination, refresh, loading, empty,
and error states. It follows the existing My Files typography, table header,
row spacing, border, and dialog dimensions.

## API

```text
GET /api/user/generated-files?page=1&limit=20&query=<filename>
```

The endpoint returns only current-user data and server-generated download paths.

## Release Boundary

The production release adds one API route and two static Client assets. It copies
the currently mounted Client build into a versioned release directory, mounts the
new route, and recreates only `LibreChat-API`.

No Mongo migration, CodeAPI restart, RAG restart, Office route change, or model
request is required for acceptance.

## Acceptance

- `我的文件` opens with `上传的文件` selected;
- switching tabs does not reload or alter the native upload list;
- the acceptance PPTX appears once under `生成的文件`;
- the uploaded source XLSX does not appear under `生成的文件`;
- hidden QA, per-page, preview, and ZIP artifacts do not appear;
- download succeeds through the normal authenticated file route;
- filename search and pagination work;
- unauthenticated API access returns `401`;
- another user's files are not returned;
- root, `/api/config`, Admin Panel, and `/office/` smoke checks remain unchanged.

