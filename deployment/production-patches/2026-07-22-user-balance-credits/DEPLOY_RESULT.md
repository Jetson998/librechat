# User Balance And Admin Credits Deployment Result

## Release Identity

- source revision: `918b2228b667c5611868daab9d33c48bea2f8468`
- GitHub Actions run: `29940651767`
- Admin source SHA-256: `ca5aa4c17881314a9409c62e5654d3f094f25de1155a4a102319c19b08d65631`
- verified tag: `admin-ci-ca5aa4c17881`
- Admin image: `ghcr.io/jetson998/librechat-admin-panel-zh-cn:ca5aa4c17881`

## Production Result

- deployed at: `2026-07-23 01:18:42 Asia/Singapore`
- release directory: `/opt/librechat/user-balance-credits/918b2228b667-20260723011842`
- backup directory: `/opt/librechat/backups/user-balance-credits-20260723011842`
- Mongo base configuration version: `65 -> 66`
- `overrides.balance.enabled=true`
- `overrides.transactions.enabled=true`
- LibreChat-API container: `f97fcb9096f2d1fa3cfb15de333d944e9aa3bcdfe7ecaf39d63fa1a3d1fca37a`
- LibreChat-Admin-Panel container: `53d4071e329102e8fb8653c4cbdea00646bde97a686e60e85d526035b1d1aced`
- versioned Client assets: `user-usage-dashboard-918b222.js`, `user-usage-dashboard-918b222.css`

The following services were not recreated or modified:

- `LibreChat-NGINX`
- `LibreChat-CodeAPI`
- `LibreChat-RAG-API`
- `chat-mongodb`

The Office helper boundary remains intact: `/office/` returns `401` with
`Basic realm="Office Converter"`.

## Acceptance

Authenticated acceptance with `vip998@example.local` confirmed:

- Account Settings opens Usage Statistics.
- Current available balance displays `$0.00`.
- The Credit Records tab opens and shows the empty state.
- The dashboard shows Token usage, estimated cost, conversation instances,
  conversation turns and average context.
- The user-facing message states that online recharge is not currently
  supported.

No real administrator credit increase, deduction or billable model request was
executed. Production balances and credit history were therefore not polluted by
release acceptance.

## Cache Correction

The API process cached the previous root HTML after the first asset update.
Query-string cache busting did not change the cached document. The release was
corrected by publishing revisioned JS and CSS filenames and recreating only
`LibreChat-API`. The user dashboard then loaded the deployed revision and passed
page-level acceptance.

## Rollback

Restore the timestamp-matched artifacts from the backup directory, restore the
previous Mongo base configuration, recreate only `LibreChat-API` and
`LibreChat-Admin-Panel`, and repeat the targeted acceptance above. Do not touch
the Office, CodeAPI, RAG, MongoDB or NGINX containers unless independent
evidence identifies them as part of a later failure.
