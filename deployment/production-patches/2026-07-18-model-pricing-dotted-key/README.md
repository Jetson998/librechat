# Model Pricing Dotted-Key Persistence Fix

Date: 2026-07-18

Status: prepared for release.

Production preflight is rebased to the deployed `42c8ff2` pricing release:

```text
compose.override.yaml: fbf89bd93b9721e1005209135ae550a5b224ab56057d25f85fe84ecf153db763
API bundle: d79ea31769617dccd5eacf8ffec61840c5d03e446108c789d15d4e823b1c4e03
Admin image: librechat-admin-panel-model-pricing-keyfix:29cf28804ff8
```

## Problem

The Admin Panel accepted and reported successful saves for `gpt-5.6-sol`, but
the active base config retained:

```text
MuskAPI.tokenConfig = {}
```

The model name contains periods. The generic config field writer interpreted
the nested key as a dotted path instead of preserving it as a literal model
key.

## Fix

- retain the existing authenticated and capability-checked Admin Config route;
- send a safe operation envelope containing the model name as a string instead
  of a dotted JSON object key, because request-body sanitization removes dotted
  keys before the route handler runs;
- special-case only `endpoints.custom.<index>.tokenConfig` after validation;
- merge or delete only the requested literal model key while preserving every
  other model price on the endpoint;
- replace the parent `overrides.endpoints.custom` array through the raw Mongo
  collection so dotted model keys remain literal object keys;
- guard the write with the current `configVersion` and reject concurrent edits;
- reload the persisted config before returning;
- make the Admin Panel compare the returned model record with the requested
  prices before showing a success notification.

No transaction history is rewritten. New prices apply only to new requests.

## Production Boundary

The release updates the existing mounted API bundle and the Admin Panel image.
It recreates only:

```text
LibreChat-API
LibreChat-Admin-Panel
```

Nginx, CodeAPI, RAG, MongoDB, and the user dashboard data route must remain
unchanged. The deployment must preserve the current Client, usage-dashboard,
user-route, and admin-user-route mounts.

The deployment itself does not modify pricing data. After deployment, browser
acceptance saves the approved prices and verifies the literal dotted model key
in Mongo before a new request is used for transaction-rate acceptance.

The default build gate requires 3.5 GB of available memory plus free swap. A
release operator may lower it no further than 2.5 GB with
`MIN_BUILD_HEADROOM_MB` after a failed preflight has populated the dependency
cache; this does not change the runtime deployment boundary.
