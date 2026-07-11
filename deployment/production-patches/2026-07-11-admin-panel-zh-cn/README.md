# LibreChat Admin Panel Simplified Chinese Release

Date: 2026-07-11

Status: implementation prepared; production deployment pending.

The first production-host build attempt exhausted host responsiveness before an
image was produced. No deployment ran. See `INCIDENT_2026-07-11.md` for the
confirmed boundary and mandatory recovery gate.

This release will derive a bilingual Admin Panel image from the official source
revision:

```text
repository: https://github.com/ClickHouse/librechat-admin-panel
revision:   64bc4b6151894b080694f5953f7b31aa99bc2cc4
license:    AGPL-3.0
```

The detailed design, safety boundary, verification plan, release sequence, and
rollback are recorded in:

```text
docs/ADMIN_PANEL_ZH_CN_PLAN.md
```

The complete corresponding modified source is under `source/`. It adds:

- Simplified Chinese as the default Admin Panel language;
- English as a browser-persisted selectable language;
- a compact login language control and Settings language control;
- immediate synchronization of `html[lang]`;
- a visible modified-source link on Help;
- exact translation-key, interpolation-placeholder, and mixed-language gates.

The pinned upstream revision has 19 existing Prettier differences, recorded in
`source/format-baseline.txt`. The image build scans the complete source tree and
fails if that exact baseline changes, so modified files must be formatted while
unrelated upstream files remain byte-identical.

The same policy applies to the upstream import sorter: its 3 existing
differences are recorded in `source/import-baseline.txt`, while all modified
localization files must remain sorted.

Run the source and localization preflight with:

```bash
scripts/verify-source.sh
```

After the implementation commit is pushed, stage this release on the production
host and build it without changing a running container. The build script uses a
disposable BuildKit container capped at 1.25 GiB and 0.75 CPU by default, with a
45-minute hard timeout; it fails closed if those controls are unavailable:

```bash
scripts/build-image.sh
PREFLIGHT_ONLY=true scripts/deploy.sh /tmp/librechat-admin-panel-zh-cn-release
scripts/deploy.sh /tmp/librechat-admin-panel-zh-cn-release
```

`BUILD_MEMORY`, `BUILD_CPU_QUOTA`, and `BUILD_TIMEOUT` may be lowered after the
host capacity check. They must not be raised on a production host without first
confirming enough headroom for all running services.

The deployment runner requires the current official Compose override to match
`compose.before.yaml`, changes only the Admin Panel image, and recreates only
`LibreChat-Admin-Panel`. It records and verifies that the API, Nginx, CodeAPI,
and MongoDB container IDs remain unchanged. Any failed post-write assertion
restores the official image override and recreates only the Admin Panel.
The deployment result records the actual before/after IDs for every protected
container and the Admin Panel's before/after container and image identities.

Production deployment must not begin until this implementation is committed,
pushed, and verified. The derived image must be built from this committed source
and recorded by immutable image ID.

The release changes only the standalone Admin Panel image. It does not modify
LibreChat chat behavior, model specs, Office, CodeAPI, MongoDB config records,
uploads, conversations, or generated files.
