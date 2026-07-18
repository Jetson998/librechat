# LibreChat Context Safety Stage B Release

Date: 2026-07-18

Status: initial production deployment and generic-label follow-up both passed
their server gates. Browser acceptance showed the PWA Service Worker could
still serve the old script under a query-versioned URL. A filename-versioned
follow-up is prepared and requires commit, push, preflight, deployment, and
final browser acceptance.

## Scope

This release adds browser-facing context warnings and a friendly recursion-stop
state through a repository-owned external asset. It does not edit LibreChat's
compressed application bundle.

The UI behavior is:

- 70%: non-blocking context notice;
- 85%: stronger handoff warning;
- 95%: stop the current generation once when possible and block subsequent
  sends while the numeric context meter remains at or above 95%;
- exact recursion-limit alerts: friendly Chinese text with collapsed technical
  details;
- generated-file cards remain available;
- handoff and new-conversation actions are explicit and never submit a model
  request automatically.

Detailed design and limitations are in:

```text
docs/CONTEXT_SAFETY_STAGE_B_PLAN.md
```

## Files

```text
client/context-safety-ui.js
client/context-safety-ui.css
client/context-safety-stage-b-smoke.html
scripts/test-contract.js
scripts/test-release.py
scripts/build-client.py
scripts/deploy.sh
scripts/run-remote-release.sh
scripts/deploy-remote.exp
```

The smoke page is an unlinked, noindex production fixture used to verify 70%,
85%, and 95% rendering and interaction guards in a real browser without
inflating a user conversation.

## Production Boundary

The follow-up guarded release copies the complete active Client from the
successfully deployed token-breakdown release:

```text
/opt/librechat/user-usage-breakdown/fe30975-20260718205221/client-dist
```

It installs only `context-safety-ui.js`, `context-safety-ui.css`, and the smoke
fixture, injects the two asset markers into the copied `index.html`, replaces
only the `/app/client/dist:ro` Compose mount, and recreates only
`LibreChat-API`.

The deployment aborts before a production write unless the audited Compose,
Client index, upload menu, login page, usage-dashboard script,
usage-dashboard stylesheet, usage-dashboard backend route, model-pricing API
bundle, and Admin Panel image all match. It also verifies that the candidate
still references `assets/index.P3glMaNP.js`.

The first Stage B preflight correctly stopped before a write because a
concurrent model-pricing deployment changed the Compose hash and added this
protected mount while leaving the Client unchanged:

```text
/opt/librechat/model-pricing-dotted-key/42c8ff2-20260718195311/api-index.cjs
-> /app/packages/api/dist/index.cjs
```

Stage B was rebased to the newly audited Compose hash
`a35aaf354dfd7e40a475d0a16b648bef07c3e16d1d2c292117e13a294596a38f`
and now explicitly preserves that bundle and Admin image. A second pricing
release completed at 20:16 and changed the audited baseline again; the current
follow-up baseline is `bf6f0774569d451e446ea6d2e0cd633c177ab585f17374f5f9edabe4ffff0197`
with API bundle
`/opt/librechat/model-pricing-dotted-key/406693a-20260718201634/api-index.cjs`
and Admin image `librechat-admin-panel-model-pricing-keyfix:1ff1e5728a85`.

The first formal Stage B deployment passed at `20260718200800`. Its browser
acceptance verified all threshold and recursion behavior, then found that one
generic download control contributed the literal file name `下载` to a handoff
draft. The `c0276ba` follow-up filtered generic open/download labels and passed
its server gates at `20260718203853`, but browser acceptance proved the PWA
Service Worker could reuse the old body for the same asset path even when the
query string changed.

The final follow-up now starts from the `fe30975` token-breakdown Client,
installs a new JS and CSS filename derived from the release commit, and updates
both `index.html` and the smoke fixture to those unique paths. Its combined
Compose baseline is
`94a9bfdffeb527d7ec34b40bf36197d91b6745884692d8855e79f5c22c13a59d`.
The existing token-breakdown route remains mounted from
`/opt/librechat/user-usage-breakdown/fe30975-20260718205221/usage-dashboard.js`
and is guarded by SHA-256 before and after the API recreation.

No Nginx, MongoDB, Admin Panel, CodeAPI, RAG-API, Office Skill, model config,
conversation, user, file, generated artifact, or WebAI/OpenWebUI resource is
changed.

## Local Verification

```bash
python3 scripts/test-release.py
git diff --check
```

The release test runs `node --check`, pure contract tests, fixture checks,
deployment-boundary assertions, and a secret scan.

## Release Flow

1. Commit and push the implementation to `origin/main`.
2. Package this directory from that exact commit.
3. Run `deploy-remote.exp` with
   `CONTEXT_SAFETY_STAGE_B_PREFLIGHT_ONLY=true` and review the read-only result.
4. Run a separate formal transport without the preflight-only flag.
5. Complete production browser acceptance before recording the release as
   passed.

## Browser Acceptance

- Real 77% conversation shows the 70% notice.
- Its raw recursion-limit alert is replaced by the approved message and keeps
  technical details collapsed.
- The smoke fixture passes 70%, 85%, and 95% desktop and mobile checks.
- The 95% fixture invokes stop once and blocks send-button, form-submit, and
  Enter-to-send events.
- A fresh normal conversation still supports chat, upload menu, generated-file
  cards, usage dashboard, and web search.

## Rollback

Restore the timestamped `compose.override.yaml` backup and recreate only
`LibreChat-API`. The previous versioned Client directory remains intact. No
database or file-storage rollback is required.
