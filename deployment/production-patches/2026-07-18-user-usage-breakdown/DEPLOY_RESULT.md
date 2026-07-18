# User Usage Token Breakdown Deployment Result

Deployment time: 2026-07-18 20:52 Asia/Singapore

Release commit: `fe30975`

Status: passed.

## Runtime

```text
release_root=/opt/librechat/user-usage-breakdown/fe30975-20260718205221
backup_dir=/opt/librechat/backups/user-usage-breakdown-20260718205221
compose_sha=94a9bfdffeb527d7ec34b40bf36197d91b6745884692d8855e79f5c22c13a59d
usage_route_sha=1f040de3da50029439b7b50ee7e17e81a4237b9495c70b1b2846537f02ac1f93
client_index_sha=92cc8174e9675ea3cce98a28917d391339f2bac0f8b7314ed46561d8f93105a5
client_script_sha=2f0dabe376555f660e9e42fca7c4623ef7a74f8ef4bac1930d86f848350f2e9f
client_style_sha=e6ebd476540e353751e300b6b1b9c96f2448008253d682488ba3aa3753e81dbb
api_container_before=7954f67bf4dda1c5dab7a3a21039bec942412eb811187d1ad90ff8f61bfe951a
api_container_after=b64f7041d0447116935319ea09c0a9dd0329228c36be1ebec235bbcf578787be
currency=USD
unauthenticated_endpoint_status=401
api_config_health=ok
```

Active mounts:

```text
/opt/librechat/user-usage-breakdown/fe30975-20260718205221/client-dist
  -> /app/client/dist
/opt/librechat/user-usage-breakdown/fe30975-20260718205221/usage-dashboard.js
  -> /app/api/server/routes/usage-dashboard.js
```

## Production Aggregation

The committed route was executed against production MongoDB before and after
the API recreation:

```json
{"aggregation":"ok","summaryTurns":144,"conversationInstances":31,"trendBuckets":9,"modelBuckets":2,"returnedLogs":5,"totalLogs":144,"costIncomplete":false}
```

## Browser Acceptance

- the conversation log Token total became a focusable detail control;
- a structured row displayed ordinary input, cache read, cache write, output,
  and total;
- the tested structured row showed `3.9K + 6.1K + 0 + 3.0K = 13.1K`;
- keyboard focus opened the same detail tooltip used by pointer hover;
- a legacy row displayed `Token 合计：334.7K` and
  `历史明细不可拆分`;
- cost, date range, filters, pagination, and conversation links remained
  unchanged.

## NewAPI Reconciliation

Source:

```text
/Users/jets2026/cccli/Musk_DA/output/JetsonChatbot_计费拆分_近3天.csv
```

Matching used Singapore timestamps, model, total prompt Token, and output
Token. Of 158 upstream rows, 144 matched LibreChat transaction groups.

- 117 matched requests contained persisted structured prompt fields;
- ordinary input, cache read, and cache write were exact for `117 / 117`;
- GPT output was exact for all 124 matched GPT requests;
- Fable input and cache components were exact for all 20 matched Fable
  requests;
- Fable completion differed by 2-9 Token because the upstream and provider
  completion accounting use slightly different terminal counts;
- 27 matched legacy GPT requests had no structured fields and are correctly
  labeled as unavailable instead of reverse-engineered.

Token granularity is therefore aligned wherever authoritative component fields
exist.

## Pricing Boundary

GPT configuration was verified as:

```text
prompt=0.6 completion=3.6 cacheRead=0.06 cacheWrite=0.75 USD / 1M
```

Fable cache write remains uniformly `3 USD / 1M` by product decision. The
upstream one-hour cache tier at `4.8 USD / 1M` is intentionally not represented.

## Protected Containers

Only `LibreChat-API` was recreated. The following identities remained
unchanged:

```text
LibreChat-NGINX=1a5c01b19b73559d6ff2a7b9e053d77d5528946b61bafcd7acae86532f9e03df
LibreChat-CodeAPI=ddba629a7b6384c8088d012008f0300ba2d1e355b620b26a71c1e5dfaf3428df
LibreChat-RAG-API=d16e85e1e1036a8d203a338032d367e472f7245e993efc1ef30d06e7bf6373de
chat-mongodb=01d5bc03e9cb05a5efe43cc8a95c3dfce1e6387f65250923d135debe3050e7c6
LibreChat-Admin-Panel=1a9387d2e6420327941aeb587ad3254f486dbbc2947db383f612ed83dfdeb52d
```

## Gate Event

The first deployment attempt passed the pre-deploy production aggregation but
the post-recreate test file had been copied only into the old container. The
scripted rollback restored the exact previous Compose hash and mounts. The
post-recreate copy was added in `fe30975`, pushed, repackaged from Git, and then
deployed successfully. No server-side hot patch was used.
