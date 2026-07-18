# Context Safety Stage B Deployment Result

Deployment time: 2026-07-19 00:21 Asia/Singapore

Release commit: `702fc0c9988ebf1cbab3b5e9316a1c0da0149ee2`

Status: passed repository gates, production preflight, guarded deployment, and
browser acceptance.

## Runtime

```text
release_root=/opt/librechat/context-safety-ui/702fc0c9988e-20260719002157
backup_dir=/opt/librechat/backups/context-safety-stage-b-20260719002157
compose_sha_before=82690eb847fe78401258d7ccb5f469d370cd21d764af30478f9503716979b6ec
compose_sha_after=b9ae70a23f396e4cc5f3cbe5792dc97a1c0ce18fb6d0d7e45676ef7a7ae76f17
config_sha_unchanged=4868cbaa70558cba2def51a3c8f8a5d4e8eb88248a697866a813f06feec05375
client_index_before=b2205004f64846905701eddec56c068b8761a4d44708b639ef08ef305309090e
client_index_after=2e2a6763fc8784ef89c233e0aa49e78ac8c0642825447625858bdc145dc304a2
context_script_asset=context-safety-ui-702fc0c9988e.js
context_script_sha=7be394908eadb381fa40078d8f64a05c283ada8841998462ba92b4024a74be39
context_style_asset=context-safety-ui-702fc0c9988e.css
context_style_sha=a2ebfa336df18d54d96a07cae7c17d04091cf384bd413e17554bb456be5e979d
context_fixture_asset=context-safety-stage-b-smoke-702fc0c9988e.html
search_asset_sha=6dc1974118b843218c9178caccedaf4cd7cba5e1e17574ab883d622f550bdade
```

Only `LibreChat-API` was recreated:

```text
api_container_before=63631af3febd8913b70d21fc32e38e6775c5a5c0016c20a92096968c469fb105
api_container_after=d9a8d149b6d46027d3bf7f8073d2ccde784d0f63ba8a827eaaecc42acc8d905f
protected_containers_unchanged=true
protected_client_assets_unchanged=true
```

The model-market usage route remained mounted at:

```text
/opt/librechat/user-model-market/6bfb5be23255-20260718235639/usage-dashboard.js
sha256=dfb57eedf861c14a342b0821e7d1fca6f004f3cb7bfa671f24bbb892f37455a8
```

## Health Gates

```text
root=200
api_config=200
office=401
usage_dashboard_unauthenticated=401
smoke_fixture=200
```

## Browser Acceptance

The existing signed-in conversation was used without sending a model request:

```text
https://152.32.172.162.sslip.io/c/64345282-da97-41a8-8971-1969e8d98087
```

Acceptance evidence:

- the production meter was `279617 / 361000`, rendered as `77%`;
- the notice and friendly recursion message rendered, with technical details
  collapsed and generated-file controls retained;
- the no-store HTML contained inline Stage B v2 source with
  `removeGenericFileLines` and no external Stage B script `src`;
- `新建对话继续` opened `/c/new` with a 1,069-character handoff draft;
- the draft contained real generated filenames and no isolated generic
  `- 下载`, `- Download`, `- 打开`, or `- Open` line;
- no message was sent and the browser returned to the original conversation
  with an empty composer;
- the 70%, 85%, and 95% smoke states rendered notice, warning, and critical
  behavior respectively;
- the 95% state invoked stop exactly once and blocked send-button, form-submit,
  and Enter-to-send events while retaining two file controls;
- the mobile viewport had no horizontal overflow or incoherent overlap;
- no browser log entry containing `context-safety` was emitted at warning or
  error level.

## Rollback

Restore
`/opt/librechat/backups/context-safety-stage-b-20260719002157/compose.override.yaml`
and recreate only `LibreChat-API`. The previous model-market Client and usage
route remain intact.
