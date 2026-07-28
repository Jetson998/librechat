# LibreChat Agent sidebar menu state overlay

This follow-up overlay fixes the unified sidebar interaction without modifying
the immutable Agent P0 UI overlay already used by production release
`20260728-agent-platform-p0-ui`.

## Immutable Inputs

- LibreChat upstream commit:
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`;
- base Agent P0 UI patch SHA-256:
  `00fc078859275611b717e34bd3a0fda4c44d08db1412b6df9e8735d27d0777bc`;
- base source manifest SHA-256:
  `bddabe15942fd54427e19f6e8dba444fe89aec3baab7d19ec2fe4546302ff237`;
- follow-up patch SHA-256:
  `a15a4e61a2a0851f630f5ce7e819a04adc04cfb1d4304ad3fba92f425fc583a4`.

The build order is deterministic:

```text
pinned upstream -> Agent P0 UI patch -> sidebar menu state patch
```

## User-Facing Behavior

- `/agents`, `/agents?view=...`, and `/agents/:category` visibly select the
  `智能助手` sidebar icon;
- the first click from another route opens the workspace without clearing the
  current side-panel content;
- clicking the selected icon again collapses the sidebar and does not repeat
  navigation;
- returning to a non-Agent route ignores stale route selection;
- route commands cannot create an empty side-panel content area.

## Local Validation

- Prettier check passed for all changed files.
- Focused Agent/Sidebar regression: `15/15` suites and `136/136` tests passed.
- Client TypeScript typecheck passed.
- Production Client build passed with `9307` transformed modules.
- `git diff --check` passed for the follow-up source patch.

The inherited React Router, Suspense test, chunk-size, direct-eval, and PWA icon
messages remain warnings; no test, typecheck, or build step failed.

## Release Boundary

This overlay and its CI workflow do not write production. A separate protected
release must record the CI artifact, prior Client mount and hash, rollback path,
affected service, and browser acceptance. The seven Workflow Manifest Agent
templates remain outside this fix.
