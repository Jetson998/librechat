# LibreChat Context Safety Stage B Release

Date: 2026-07-18

Status: completed. The final inline release `702fc0c` passed repository tests,
production preflight, guarded deployment, and browser acceptance on the active
user-model-market baseline.

## Scope

This release adds browser-facing context warnings and a friendly recursion-stop
state through a repository-owned inline asset generated from readable source
files. It does not edit LibreChat's compressed application bundle.

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

The final guarded release copied the complete active Client from the successful
user-model-market release:

```text
/opt/librechat/user-model-market/6bfb5be23255-20260718235639/client-dist
```

It installed only `context-safety-ui.js`, `context-safety-ui.css`, and the smoke
fixture, injected the two asset markers into the copied `index.html`, replaced
only the `/app/client/dist:ro` Compose mount, and recreated only
`LibreChat-API`.

The deployment aborts before a production write unless the audited Compose,
Client index, upload menu, login page, usage-dashboard script,
usage-dashboard stylesheet, usage-dashboard backend route, search-favicon
asset, model-pricing API bundle, and Admin Panel image all match. It also
verifies that the candidate still references `assets/index.P3glMaNP.js` and
retains the inline search-favicon runtime.

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

The `9fa04ab` release started from the `fe30975` token-breakdown Client,
installed JS and CSS filenames derived from the release commit, and preserved
the usage route. Its server deployment passed at `20260718210529`. Browser
acceptance then proved that Chrome could still execute the old script body
even though the new public file SHA was correct.

The final release embeds the audited JS and CSS directly into `index.html`.
The root HTML is served with `Cache-Control: no-cache, no-store,
must-revalidate`, so runtime code and the release index cannot drift.
Commit-derived external copies remain available for SHA verification, while
the smoke fixture is also inlined and copied to a commit-derived filename.

After the later usage-detail and search-favicon releases, the final Stage B
baseline was:

```text
compose_override_sha=4f93345987c1913c8379792d54db2dea7a417106cbb978a1bae5269e07f6aa8f
client_mount=/opt/librechat/search-favicon-fallback/14b9fc7972f5-20260718230646/client-dist
client_index_sha=27dd78be6e3862a4297e6a20b12a758513c11ebfcd515d05b550fa32a2903921
usage_route=/opt/librechat/user-usage-cost-detail-availability/de2beeace561-20260718223055/usage-dashboard.js
usage_route_sha=5bd0bd087aab75799fb429b7da8cbb68b6947856b6fe388aeb86985a94821ba9
search_asset=search-favicon-fallback-14b9fc7972f5.js
search_asset_sha=6dc1974118b843218c9178caccedaf4cd7cba5e1e17574ab883d622f550bdade
```

The deployment guards the usage route and search-favicon asset before and
after the API recreation.

The user-model-market release then changed the protected Client and usage
route while preserving the search, upload, login, and context assets. The
current rebase baseline is:

```text
compose_override_sha=82690eb847fe78401258d7ccb5f469d370cd21d764af30478f9503716979b6ec
client_mount=/opt/librechat/user-model-market/6bfb5be23255-20260718235639/client-dist
client_index_sha=b2205004f64846905701eddec56c068b8761a4d44708b639ef08ef305309090e
usage_route=/opt/librechat/user-model-market/6bfb5be23255-20260718235639/usage-dashboard.js
usage_route_sha=dfb57eedf861c14a342b0821e7d1fca6f004f3cb7bfa671f24bbb892f37455a8
usage_js_sha=1f03cbd793319a80ea59229889c510fa5801d30cf2b8074ae5c58064812dc115
usage_css_sha=121b1907784ff2214246e2c7ad67933faf01038d480e23ee581f5d2c85d6c3a1
```

The candidate and live gates also require the model-market markers
`data-view="market"` and `renderMarket` in the preserved usage dashboard.

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
