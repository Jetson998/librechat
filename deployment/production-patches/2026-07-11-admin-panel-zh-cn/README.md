# LibreChat Admin Panel Simplified Chinese Release

Date: 2026-07-11

Status: implementation prepared; production deployment pending.

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

Run the source and localization preflight with:

```bash
scripts/verify-source.sh
```

After the implementation commit is pushed, stage this release on the production
host and build it without changing a running container:

```bash
scripts/build-image.sh
PREFLIGHT_ONLY=true scripts/deploy.sh /tmp/librechat-admin-panel-zh-cn-release
scripts/deploy.sh /tmp/librechat-admin-panel-zh-cn-release
```

The deployment runner requires the current official Compose override to match
`compose.before.yaml`, changes only the Admin Panel image, and recreates only
`LibreChat-Admin-Panel`. It records and verifies that the API, Nginx, CodeAPI,
and MongoDB container IDs remain unchanged. Any failed post-write assertion
restores the official image override and recreates only the Admin Panel.

Production deployment must not begin until this implementation is committed,
pushed, and verified. The derived image must be built from this committed source
and recorded by immutable image ID.

The release changes only the standalone Admin Panel image. It does not modify
LibreChat chat behavior, model specs, Office, CodeAPI, MongoDB config records,
uploads, conversations, or generated files.
