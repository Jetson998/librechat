# User Model Market Phase One Deployment Result

Deployment time: 2026-07-18 23:56 Asia/Singapore

Release commit: `6bfb5be23255813cf6bda41e1a459a929bef0360`

User API/client status: passed.

Admin Panel status: pending. The new publication toggle and official input
reference field remain gated on the immutable Admin CI tag and have not been
deployed. No production market metadata was written during this release.

## Runtime

```text
release_root=/opt/librechat/user-model-market/6bfb5be23255-20260718235639
backup_dir=/opt/librechat/backups/user-model-market-20260718235639
compose_sha_before=4f93345987c1913c8379792d54db2dea7a417106cbb978a1bae5269e07f6aa8f
compose_sha_after=82690eb847fe78401258d7ccb5f469d370cd21d764af30478f9503716979b6ec
config_sha_unchanged=4868cbaa70558cba2def51a3c8f8a5d4e8eb88248a697866a813f06feec05375
usage_route_sha=dfb57eedf861c14a342b0821e7d1fca6f004f3cb7bfa671f24bbb892f37455a8
usage_js_sha=1f03cbd793319a80ea59229889c510fa5801d30cf2b8074ae5c58064812dc115
usage_css_sha=121b1907784ff2214246e2c7ad67933faf01038d480e23ee581f5d2c85d6c3a1
```

Only `LibreChat-API` was recreated:

```text
api_container_before=655e598261380bb37bba47b4175e17ef1f6cbf0bc0204319e0cb8b418c38ce11
api_container_after=63631af3febd8913b70d21fc32e38e6775c5a5c0016c20a92096968c469fb105
protected_containers_unchanged=true
```

Nginx, CodeAPI, RAG API, MongoDB, and the Admin Panel retained their container
identities. The existing search-favicon, upload-menu, login-page, context-safety,
model-pricing, Office, and file-generation assets remained mounted.

## Health Gates

```text
root=200
api_config=200
office=401
usage_dashboard_unauthenticated=401
production_aggregation=ok
```

## Browser Acceptance

Verified with the existing signed-in `gracey@example.local` session without
sending a model request:

- `我的 -> 用量统计` opened normally;
- `模型市场` appears below `对话日志`;
- the range toolbar is hidden in the market view;
- the six-column price table renders correctly;
- unpublished models are not exposed;
- the expected `0 个模型 / 暂无公开模型价格` state is shown while the Admin
  publication controls remain undeployed.

## Rollback

Restore the recorded backup Compose override and recreate only
`LibreChat-API`. Native pricing data, historical transactions, and Admin Panel
runtime configuration were not changed.
