# Deployment Result

Date: 2026-07-18

Result: successful

## Release

```text
design_commit=7484ebf
implementation_commit=57ed9f9
release_root=/opt/librechat/user-usage-cutover-cost-detail/57ed9f9-20260718212527
backup_dir=/opt/librechat/backups/user-usage-cutover-cost-detail-20260718212527
api_container_after=248e103b3c8cae55dac9b4af5340d92176e2c635ccb7ee32f1ed7a7bf5caa253
pricing_cutoff=2026-07-18T12:23:34.480Z
pricing_cutoff_models=gpt-5.6-sol,claude-fable-5
currency=USD
```

Only `LibreChat-API` was recreated. `LibreChat-NGINX`, `LibreChat-CodeAPI`,
`LibreChat-RAG-API`, `chat-mongodb`, and `LibreChat-Admin-Panel` retained their
pre-deployment container identities.

## Verification

- Local release checks passed.
- Production aggregation tests passed.
- API configuration health passed.
- The unauthenticated usage endpoint returned the expected `401`.
- Browser acceptance passed for cards, trends, model distribution, logs, and
  pagination.
- The acceptance account had no post-cutover requests, so all views correctly
  returned zero.
- No MongoDB transactions or balances were deleted or modified.

The cost-detail tooltip is deployed. A post-cutover GPT or Fable transaction is
needed before its populated production state can be observed without creating a
new billed request during deployment acceptance.
