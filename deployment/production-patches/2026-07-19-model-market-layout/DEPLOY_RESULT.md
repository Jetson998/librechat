# Model Market Table Layout Deployment Result

Deployment time: 2026-07-19 03:21 Asia/Singapore

Release commit: `1d6bad93acc52af5acb599178bf8d01a8cc9bd13`

Status: passed.

## Package And Preflight

```text
archive=librechat-model-market-layout-1d6bad93acc5.tar.gz
archive_sha256=df27c6b5fb51f347b7f705572ee153568c16f9125e0bdbc7f7c94030fc76ea50
preflight_only=ok
client_release_checks=ok
model_market_layout_release_checks=ok
```

## Runtime

```text
release_root=/opt/librechat/model-market-layout/1d6bad93acc5-20260719032150
backup_dir=/opt/librechat/backups/model-market-layout-20260719032150
compose_sha_before=571e67111fb4bab0d21f6f275895fb9cf60f986d689d6692dad9e3bdc71c7a7e
compose_sha_after=aea5293665861fa8b7bcc8fc0a7d629d536fc5de35ba87b8e3838cd86fc5f9ec
config_sha_unchanged=4868cbaa70558cba2def51a3c8f8a5d4e8eb88248a697866a813f06feec05375
client_mount_before=/opt/librechat/context-safety-ui/702fc0c9988e-20260719002157/client-dist
client_mount_after=/opt/librechat/model-market-layout/1d6bad93acc5-20260719032150/client-dist
usage_mount_unchanged=/opt/librechat/user-model-market/6bfb5be23255-20260718235639/usage-dashboard.js
usage_js_sha=4cb2523c5269f41c021dbda8d3a8b20b8b5a091267ff9643ab3711742aa725a8
usage_css_sha=94a1ca94a5d2d371c53788f33106137e429e64d198ca41ea8b2cc4d8ae6ce8fd
```

Only `LibreChat-API` was recreated:

```text
api_container_before=d9a8d149b6d46027d3bf7f8073d2ccde784d0f63ba8a827eaaecc42acc8d905f
api_container_after=79b0cc8667477211a111376f6c01bdb802e0a3034274a5e44fa4d8eb8bf8a1e9
protected_containers_unchanged=true
```

## Health Gates

```text
root=200
api_config=200
admin=200
office=401
office_realm=Office Converter
usage_dashboard_unauthenticated=401
```

## Browser Acceptance

Verified with an existing signed-in account without sending a model request:

- `我的 -> 用量统计 -> 模型市场` opened normally;
- the model-name column is wider and the price columns remain stable;
- the table uses the recorded `26 / 10 / 19 / 15 / 15 / 15` allocation;
- `官方 $5.00/M` and `优惠 88%` render on one compact metadata row for
  `gpt-5.6-sol`;
- the note states that model discount uses input price as the comparison basis;
- both models currently show `—` for context because no context value is stored
  in their production `tokenConfig` entries.

## Rollback

Restore `/opt/librechat/backups/model-market-layout-20260719032150/compose.override.yaml`
and recreate only `LibreChat-API`.
