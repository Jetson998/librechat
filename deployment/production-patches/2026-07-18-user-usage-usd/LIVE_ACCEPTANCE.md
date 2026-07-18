# Live Acceptance

Date: 2026-07-18
Release commit: `65594e2`

## Result

- `USER_USAGE_CURRENCY=USD` is active in `LibreChat-API`;
- `USER_USAGE_USD_RATE=1` is active;
- the previous `USER_USAGE_USD_TO_CNY` variable is absent;
- the dashboard response returns `currency: USD`;
- an authoritative cost of `143.914403` is returned as `143.9144` USD;
- no transaction, model price, or historical cost was rewritten;
- API container changed from
  `a834cd68ea0fa5c0e89bab5a301ce07d80ed8da0f484e786ac473a3baac815c8`
  to
  `474f0b045587a090c9a1268ef3901b174f295778dd580a101a718873ecd0d2d8`;
- Nginx, CodeAPI, RAG, MongoDB, and Admin Panel container IDs were unchanged;
- main site and `/api/config` returned HTTP 200;
- `/office/` remained protected with HTTP 401.

Production backup:

```text
/opt/librechat/backups/user-usage-usd-20260718170653
```

Current Compose override SHA-256:

```text
af8367633ecd58e8dff78ad41d90956bbac405ba3b7d85db152148644eaeb33f
```
