# User Usage Dashboard USD Release

Date: 2026-07-18

This release changes only the user usage dashboard display currency from CNY
to USD. Transaction `tokenValue / 1e6` remains the authoritative amount, so no
historical transaction or model price is recalculated.

Runtime configuration:

```text
USER_USAGE_CURRENCY=USD
USER_USAGE_USD_RATE=1
```

The release recreates only `LibreChat-API` to load the environment change.
MongoDB, Admin Panel, CodeAPI, RAG, and Nginx are protected by container-ID
checks.
