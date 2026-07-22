# User Balance And Admin Credits

This governed patch exposes LibreChat's native balance as a USD account-credit experience.

## Scope

- Admin user balance lookup and signed credit adjustment;
- atomic, idempotent administrator adjustment history on the native balance document;
- current balance and credit records in the authenticated user usage dashboard;
- no payment gateway and no user self-service recharge.

## Source Files

The release is assembled from the repository-owned cumulative sources:

```text
deployment/production-patches/2026-07-17-admin-user-creation/api-patch/users.js
deployment/production-patches/2026-07-17-admin-user-creation/api-patch/admin-balance.js
deployment/production-patches/2026-07-17-user-usage-dashboard/api/user.js
deployment/production-patches/2026-07-17-user-usage-dashboard/api/usage-dashboard.js
deployment/production-patches/2026-07-17-user-usage-dashboard/client/user-usage-dashboard.js
deployment/production-patches/2026-07-17-user-usage-dashboard/client/user-usage-dashboard.css
deployment/production-patches/2026-07-11-admin-panel-zh-cn/source/
```

## Production Preconditions

- resolved configuration has `balance.enabled=true`;
- pricing is configured in USD per one million tokens;
- MongoDB balance data is backed up;
- API, Client and Admin artifacts pass their focused tests.

No production deployment is performed by creating this patch record.

## Runtime Configuration

The deployment enables the native LibreChat accounting switches in the resolved
Mongo base override:

```text
overrides.balance.enabled=true
overrides.transactions.enabled=true
```

The user dashboard reads the native balance and transaction records. It does
not introduce a second accounting system. Admin adjustments update the native
balance atomically and append the administrator credit audit record.

## Client Asset Versioning

LibreChat-API caches the root HTML during startup. The production release uses
revisioned dashboard assets so the cached document cannot keep loading an older
dashboard implementation:

```text
user-usage-dashboard-918b222.js
user-usage-dashboard-918b222.css
```

Changing only a query string is not sufficient for this runtime cache. A future
dashboard release must publish a new filename and recreate only LibreChat-API.

## Deployment Result

See `DEPLOY_RESULT.md` for the exact CI evidence, production directories,
container identities, configuration version and acceptance scope.

## Rollback

Use the timestamp-matched backup at
`/opt/librechat/backups/user-balance-credits-20260723011842`. Restore the API,
Client, Admin and Mongo configuration artifacts from that directory, recreate
only `LibreChat-API` and `LibreChat-Admin-Panel`, then verify the main app,
usage dashboard, Admin Panel and `/office/` authentication boundary.
