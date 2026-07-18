# Production Deployment Result

Date: 2026-07-18 20:16 Asia/Singapore

Status: deployed and backend acceptance passed.

## Release

```text
commit: 406693a
package: librechat-model-pricing-dotted-key-406693a.tgz
package_sha256: 8f97979e0b1ea7b641a895f3d77616576dc31e80507446d8f5d8296e425df53e
release_root: /opt/librechat/model-pricing-dotted-key/406693a-20260718201634
backup_dir: /opt/librechat/backups/model-pricing-dotted-key-20260718201634
```

## Runtime

```text
compose_sha256: bf6f0774569d451e446ea6d2e0cd633c177ab585f17374f5f9edabe4ffff0197
api_bundle_sha256: b9cac9721e5dcbde30b5d3b1052ba8306e15119255d4b8c53bb330ca8b089b27
admin_image: librechat-admin-panel-model-pricing-keyfix:1ff1e5728a85
api_container: 87e626c0b209b00ec19bbdc4b8f32b022a7cb6618838750912705994de6bcec6
admin_container: 1a9387d2e6420327941aeb587ad3254f486dbbc2947db383f612ed83dfdeb52d
```

Only `LibreChat-API` and `LibreChat-Admin-Panel` were recreated. The deployment
gate confirmed that Nginx, CodeAPI, RAG API, and MongoDB container IDs remained
unchanged. API config health and Admin `/pricing` health both passed.

## Acceptance

The authenticated Admin Config API saved the approved model prices through the
same `setLiteralModelConfig` operation used by the Admin Panel:

```text
MuskAPI / gpt-5.6-sol
prompt: 0.6
completion: 3.6
cacheRead: 0.06
cacheWrite: 0.75
```

MongoDB acceptance at `configVersion=40` confirmed:

- `tokenConfig` contains the literal key `gpt-5.6-sol`;
- all four values persisted exactly;
- `MuskAPI-Anthropic / claude-fable-5` remained unchanged at `2.4 / 12 / 0.24 / 3`;
- historical transactions were not modified.

The Admin browser session returned to the login page after the Admin container
was recreated. Page-level refresh acceptance therefore requires only a new
Admin login; backend persistence and the built Admin request contract passed.
