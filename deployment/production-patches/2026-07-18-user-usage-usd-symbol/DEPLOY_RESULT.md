# Deployment Result

Date: 2026-07-18

Result: successful

```text
timestamp=20260718214145
release_commit=0b57393fab4bfe6028e04e25b357b9fd225158e8
release_root=/opt/librechat/user-usage-usd-symbol/0b57393fab4b-20260718214145
backup_dir=/opt/librechat/backups/user-usage-usd-symbol-20260718214145
compose_sha=cd6002ddc8893f25a6337dc823c9a9978f928aa5652f7e16ca28ac4d4e8fa6d2
client_index_sha=488e92e83bd289e709ae746e766c28af9c176406a4d93d0a8d6d1c7958fea76e
client_script_sha=aba651fe592a0059296fa8f5d679c0eeb693424def58a304c53037fd686248da
client_style_sha=724094199fa29f77799331988748b8eef8d88c135b35abf5bea5f2c19a1a494b
api_container_before=248e103b3c8cae55dac9b4af5340d92176e2c635ccb7ee32f1ed7a7bf5caa253
api_container_after=84bc24c956985b08374cc06757e48aae9a4b7c850f7c4b1360bea26cfcf0d335
protected_containers_unchanged=true
currency=USD
currency_display=narrowSymbol
unauthenticated_endpoint_status=401
api_config_health=ok
```

Protected container IDs after deployment:

```text
LibreChat-Admin-Panel 1a9387d2e642
LibreChat-RAG-API d16e85e1e103
LibreChat-NGINX 1a5c01b19b73
LibreChat-CodeAPI ddba629a7b63
chat-mongodb 01d5bc03e9cb
```

Browser acceptance confirmed `$0.0052` on the live usage card after reloading
the page. No `US$` prefix remained in the rendered usage dialog.
