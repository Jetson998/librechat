# Live Acceptance

Final acceptance time: 2026-07-18 01:35 Asia/Singapore

## API

- unauthenticated `GET /api/user/usage-dashboard` returned `401`;
- authenticated Gracey request returned `200`, currency `CNY`, all response sections, five
  paginated rows, and nine successful reply rows in scope;
- the server derives identity from the JWT and the aggregation pipeline joins transactions with
  the same authenticated ObjectId;
- the production aggregation test returned valid summary, trend, model, log, and pagination
  sections without exporting prompt or response text.

## Browser

The existing signed-in Bill session was refreshed after deployment.

- `账户设置` contained exactly one `价格用量统计` menu item;
- the panel opened with the committed script version `34842d07cf97`;
- six metric cards rendered;
- the current log page rendered 20 successful reply rows;
- model distribution rendered exactly two unique models: `claude-fable-5` and `gpt-5.6-sol`;
- `近 7 天`, `近 30 天`, and `全部` each refreshed cards and logs without an error state;
- the active range was restored to `近 30 天` for handoff.

The initial browser `401` exposed that custom fetches did not inherit LibreChat's in-memory
Bearer header. The durable fix uses the official `POST /api/auth/refresh` route with the HttpOnly
refresh cookie, then sends the returned access token on the dashboard request. It does not guess
or enumerate browser storage keys.

## Runtime Boundary

Only `LibreChat-API` was recreated for the final release. These container IDs remained unchanged
through the release:

```text
LibreChat-NGINX 1a5c01b19b73559d6ff2a7b9e053d77d5528946b61bafcd7acae86532f9e03df
LibreChat-CodeAPI ddba629a7b6384c8088d012008f0300ba2d1e355b620b26a71c1e5dfaf3428df
LibreChat-RAG-API d16e85e1e1036a8d203a338032d367e472f7245e993efc1ef30d06e7bf6373de
chat-mongodb 01d5bc03e9cb05a5efe43cc8a95c3dfce1e6387f65250923d135debe3050e7c6
LibreChat-Admin-Panel bd888ea33f65c88d571c15dd8cff7b9a09be749ffb7ef3566cde56040a5fa8aa
```

Acceptance: passed.
