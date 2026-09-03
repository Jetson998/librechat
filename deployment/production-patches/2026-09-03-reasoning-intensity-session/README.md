# Session-scoped Reasoning Intensity Client Release

Date: 2026-09-03

Status: independent Client artifact for a bounded production release.

## Source and artifact

- source revision: `dcef7febecece61012436194c4c5aeab0e081f93`;
- parent overlay baseline: `5daeb14ca495d97acb5c069c055ec6ebbc4923b3`;
- upstream baseline: `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`;
- source archive: Git archive of the exact source revision;
- deployment artifact: independently built `client-artifact.zip`.

The source revision is held in the operator-supplied nested checkout and is
intentionally recorded as an external source input. The nested checkout had
uncommitted unrelated Agent files; they were excluded from the build.

## Behavior

The Client stores reasoning intensity only for the active conversation. The
automatic state omits `effort` and `reasoning_effort`; Anthropic requests use
`effort`, while OpenAI-compatible requests use `reasoning_effort`. The model
specific option set includes `max` only for `gpt-5.6-sol`.

## Deployment scope

- create one versioned Client directory under `/opt/librechat/reasoning-intensity-session/`;
- replace only the `LibreChat-API` bind mount at `/app/client/dist:ro`;
- recreate only Compose service `api` / container `LibreChat-API`;
- keep MongoDB, CodeAPI, Runtime, Connector, Nginx, RAG, Admin, data, files,
  conversations, models, and secrets unchanged.

## Validation and rollback

The artifact verifier checks ZIP and tar safety, all member hashes, the exact
source manifest, the built Client index, and the core bundles carrying the
session routing contract. The versioned remote runner captures a fresh
read-only production snapshot, backs up the active Client and Compose
override, applies the read-only mount change, checks public boundaries, and
automatically invokes the versioned rollback runner on post-apply failure.

No billable model request is required or allowed by this release.
