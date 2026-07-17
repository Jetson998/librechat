# Live Acceptance

Final acceptance time: 2026-07-18 03:18 Asia/Singapore

## API

- unauthenticated `GET /api/user/usage-dashboard` returned `401`;
- authenticated Gracey dashboard data loaded successfully with CNY values and all response sections;
- the production aggregation test returned `132` successful reply turns across `27` conversation instances;
- the route continues to derive identity only from the authenticated JWT and does not expose prompt,
  response, file, credential, or arbitrary-user data.

## Browser

The existing signed-in browser session was refreshed after the API recreation and re-authenticated as Gracey.

- `账户设置` contained exactly one `价格用量统计` menu item;
- the committed assets loaded as `user-usage-dashboard.js/css?v=59efa3bf9754`;
- the panel opened with two left-side navigation items: `用量概览` and `对话日志`;
- the overview had no vertical scrollbar at the tested desktop viewport;
- the log table used the committed header, row, filter, and `页面 1 / 1` pagination layout;
- model filter dropdown closed by toggle and by `Escape`;
- `近 7 天`, `近 30 天`, and `全部` each switched the active range without an error state;
- the active range was restored to `近 30 天` for handoff.

## Runtime Boundary

Only `LibreChat-API` was recreated. The final cleanup release also removed duplicate historical
usage-dashboard mounts from the active Compose override; only the current `59efa3bf9754` Client,
user-route, and usage-route mounts remain.

```text
LibreChat-API before 28371a9783e6ddd98c9dbd311f5e1837bf6e2d18cbc175b0f4e9f3dc94d6899a
LibreChat-API after  cb31843cb1a7ebd0a9ae134b60cd97ec3dec273ba48492bd7c824d00dde64ad5
LibreChat-NGINX     1a5c01b19b73559d6ff2a7b9e053d77d5528946b61bafcd7acae86532f9e03df
LibreChat-CodeAPI   ddba629a7b6384c8088d012008f0300ba2d1e355b620b26a71c1e5dfaf3428df
LibreChat-RAG-API   d16e85e1e1036a8d203a338032d367e472f7245e993efc1ef30d06e7bf6373de
chat-mongodb        01d5bc03e9cb05a5efe43cc8a95c3dfce1e6387f65250923d135debe3050e7c6
LibreChat-Admin-Panel bd888ea33f65c88d571c15dd8cff7b9a09be749ffb7ef3566cde56040a5fa8aa
```

Acceptance: passed.
