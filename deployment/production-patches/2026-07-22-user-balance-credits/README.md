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
