# User Usage Chart Release

Date: 2026-07-18

Status: prepared for production release.

## Scope

Improve the existing customer usage dashboard without changing its API or
aggregation rules.

- add five Y-axis ticks and sampled date labels to usage trends;
- add keyboard-focusable data points;
- show date, metric, and formatted value on pointer hover or keyboard focus;
- replace static model bars with a Token-distribution donut;
- keep a persistent model legend with model name, Token value, and percentage;
- show model, Token value, and percentage on donut or legend hover;
- preserve the current USD display and authenticated user isolation;
- add dark-mode and narrow-screen chart styling.

The Ant Design Charts line example is used only as an interaction and
information-hierarchy reference. This release keeps the existing vanilla
JavaScript injection and does not add a chart-library runtime.

## Runtime Boundary

Only the mounted Client directory changes. The deployment script:

1. verifies the audited Compose and active Client hashes;
2. copies the current active Client into a new versioned release directory;
3. replaces only `user-usage-dashboard.js` and `user-usage-dashboard.css`;
4. updates their cache-busting query strings in `index.html`;
5. replaces only the `/app/client/dist` mount;
6. recreates only `LibreChat-API`;
7. verifies protected container identities remain unchanged.

Live asset checks download responses to stage files before assertion so shell
`pipefail` cannot misclassify an intentional `grep -q` early close as a curl
transport failure.

No API route, MongoDB data, CodeAPI, Office Converter, RAG, Nginx, Admin Panel,
model configuration, or pricing configuration is changed.

## Local Verification

```text
node --check deployment/production-patches/2026-07-17-user-usage-dashboard/client/user-usage-dashboard.js
python3 deployment/production-patches/2026-07-17-user-usage-dashboard/scripts/test-client-release.py
node deployment/production-patches/2026-07-17-user-usage-dashboard/scripts/test-usage-dashboard.js
python3 deployment/production-patches/2026-07-18-user-usage-charts/scripts/test-release.py
git diff --check
```

Browser acceptance must confirm visible axes and dates, trend hover values,
model legend values, model hover values, metric-tab switching, and USD values.

## Rollback

Restore the timestamped Compose override backup and recreate only
`LibreChat-API`. The previous versioned Client directory remains intact.
