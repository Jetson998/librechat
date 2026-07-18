# Usage Menu Follow-up

Date: 2026-07-18

## Scope

- Rename the account-menu entry and dashboard heading from `价格用量统计` to
  `用量统计`.
- Replace the currency-character marker with a native-size Lucide-style chart
  icon so the entry matches the surrounding LibreChat menu icons.
- Match the native account-menu hover and focus state through
  `data-active-item`, with a CSS hover fallback using `var(--surface-hover)`.
- Keep the API, aggregation, filters, logs, and dashboard data contract
  unchanged.

## Verification

- `node --check client/user-usage-dashboard.js`
- `python3 scripts/test-client-release.py`
- `git diff --check`
- Local demo visual check: label, icon spacing, hover background, and heading.

## Production Result

- Release commit: `65ac5e4d0eb0b26b8a2e63bed440dad179873ae6`
- Release root: `/opt/librechat/user-usage-dashboard/65ac5e4d0eb0-20260718135751`
- Backup: `/opt/librechat/backups/user-usage-dashboard-20260718135751`
- Browser assets: `user-usage-dashboard.js/css?v=65ac5e4d0eb0`
- Browser result: one `用量统计` entry, 20px chart icon, 8px gap, native gray hover background.
- Runtime boundary: only `LibreChat-API` was recreated; all protected container IDs were unchanged.
