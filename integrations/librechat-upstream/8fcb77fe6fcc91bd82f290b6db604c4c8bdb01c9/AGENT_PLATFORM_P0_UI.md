# LibreChat Agent Platform P0 UI overlay

This directory owns the first Agent platform Client batch for the self-hosted
LibreChat project. It is a version-pinned source overlay, not a production hot
patch and not a production deployment record.

## Source boundary

- Upstream repository: `https://github.com/danny-avila/LibreChat.git`
- LibreChat release: `0.8.7`
- Upstream commit: `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`
- Upstream tree: `66d1547235bc3e0f61663778b386e0ec7ec72c58`
- Runtime Connector overlay: separately pinned at
  `60eba76375213dafc1874d943e41371201c300ab`

The Agent UI patch changes only LibreChat Client source and tests. It does not
change Agent APIs, MongoDB schemas, CodeAPI, Office Converter, Runtime, billing,
file isolation, or role definitions.

## User-facing behavior

- Replaces the split marketplace/builder navigation with one `AI Assistants`
  workspace command.
- Provides URL-restorable Recommended, My Assistants, Create, and Edit modes.
- Restricts My Assistants to resources with existing `EDIT` permission.
- Redirects forbidden Create URLs and rejects invalid or unauthorized edit IDs.
- Preserves marketplace search, categories, detail links, admin controls, and
  category deep links.
- Separates the basic builder from publishing, integration, orchestration, and
  other advanced settings without changing the Agent create/update payload.
- Keeps Skills visible once, with platform capabilities in Basic and
  MCP/Actions/tool integrations in Advanced.
- Uses assistant terminology throughout the Simplified Chinese Client.
- Adds keyboard navigation, roving tab focus, accessible tab/panel relations,
  and actionable empty states.

This batch does not publish the seven planned workflow templates and does not
enable Workflow Manifest or Runtime production execution.

## Verify the source overlay

For an exact Git checkout:

```sh
scripts/verify-agent-platform-p0-ui-overlay.sh /path/to/librechat-8fcb77f
```

For the official codeload archive extracted without `.git`:

```sh
scripts/verify-agent-platform-p0-ui-overlay.sh \
  /path/to/extracted-source \
  /path/to/librechat-8fcb77f.tar.gz
```

The verifier checks the upstream commit or official archive SHA-256, every
changed upstream blob, the lockfile, patch SHA-256, changed-file allowlist,
result blobs, locale contracts, and the untouched Runtime Connector overlay.

## Build and compose

The CI workflow installs the pinned lockfile, builds internal packages, runs
the focused Agent/Marketplace/Sidebar tests, typechecks, and builds the
production Client. It then composes repository-owned protected assets:

- three-entry business upload menu;
- Odysseia login page;
- usage, balance, and model market UI;
- search favicon fallback;
- context safety UI;
- generated-files tab and authenticated download behavior;
- upstream stale-asset recovery markers.

Composition is deterministic:

```sh
scripts/compose-agent-platform-client.sh \
  /path/to/upstream/client/dist \
  /path/to/candidate-client
```

The composer rejects hash drift, missing contract markers, duplicate HTML
markers, stale versioned assets, missing local references, and an output path
that already exists. It never reads a running production Client directory.

Two repository gate defects were found and corrected before push:

- Inline CSS/JavaScript is inserted through callable regular-expression
  replacements so backslashes in asset source cannot be interpreted as Python
  replacement-template escapes.
- The upload-menu persistence contract validates the current protected Client
  overlay hash/order and a generic protected Client mount instead of requiring
  one superseded historical mount directory.
- `.gitattributes` disables whitespace diagnostics only for serialized
  `*.patch` artifacts, whose blank context lines require a leading diff marker;
  source, scripts, JSON, workflow, and documentation remain under normal
  whitespace checks.

## Local validation completed

- Focused and existing regression suites: `13/13`, `120/120` tests passed.
- Client TypeScript typecheck passed.
- Production Client build passed with `9307` transformed modules.
- `git diff --check` passed.
- Official GitHub commit/tree metadata and all 21 modified upstream blobs were
  matched; seven files are new in this overlay.
- Six protected Client source-contract suites passed.
- Local protected composition passed with ten assets and 352 output files.
- Local base `index.html` SHA-256:
  `cc8374ddef9eea40bcdb1c704c6bd1fde44c16d7fcc17af4fb98ec619226627a`.
- Local composed `index.html` SHA-256:
  `e50a1f4ba112abe37df27d5af4608bfa8b4b6c5cdcf06763960ba1b742f9f67e`.
- Marker counts, protected hashes, authenticated-download markers, stale-asset
  recovery markers, and stale versioned-asset cleanup passed.
- Repository release-governance validation passed `32/32` tests.

The Vite chunk-size and PWA icon glob messages are inherited build warnings,
not Agent UI failures.

## Release status

No production deployment is authorized or performed by this overlay or its CI
workflow. A future production release must use the repository release
governance, a CI-produced immutable Client artifact, a recorded prior Client
mount/hash, and browser acceptance for both USER and ADMIN roles.
