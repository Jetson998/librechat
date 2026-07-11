# LibreChat Admin Panel Simplified Chinese Release

Date: 2026-07-11

Status: design approved; implementation not yet deployed.

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

Implementation must not begin until this design is committed and pushed to
`origin/main`. Production deployment must not begin until the complete source,
translation, tests, image build, deployment runner, and rollback are committed,
pushed, and locally verified.

The release changes only the standalone Admin Panel image. It does not modify
LibreChat chat behavior, model specs, Office, CodeAPI, MongoDB config records,
uploads, conversations, or generated files.
