# User Usage Chart Deployment Result

Deployment time: 2026-07-18 17:50 Asia/Singapore

Release commit: `bbae4f4`

Status: passed.

## Runtime Result

```text
release_root=/opt/librechat/user-usage-dashboard/bbae4f4-charts-20260718175030
backup_dir=/opt/librechat/backups/user-usage-charts-20260718175030
compose_sha=90a03305d3f1706f1363e33b7a7368fe9dc69a11cb31858c1535a571669aa1ec
client_index_sha=29306df25134b09716727523eaeea0bfca1d75029a8ffc89ec02b47a4bf105e0
client_script_sha=6f76a7379c01d640460bf34864b88554771ca43c18e063239c5d1a294300433f
client_style_sha=2817b8722535d3d46c514c8b93c8713abe4852860cc0075e5c07df1b0f4a01ff
api_container_before=be77a2c1caeee8b259646a94f7615e669c84f8f221434d40a6a022d5f39d115f
api_container_after=71a718183888c2c99e1dd926270e79f2a53c33cd7ffe1557ee5c935c2da6d33f
currency=USD
unauthenticated_endpoint_status=401
api_config_health=ok
```

The active Client mount is:

```text
/opt/librechat/user-usage-dashboard/bbae4f4-charts-20260718175030/client-dist
-> /app/client/dist
```

## Protected Containers

Only `LibreChat-API` was recreated.

```text
LibreChat-NGINX=1a5c01b19b73559d6ff2a7b9e053d77d5528946b61bafcd7acae86532f9e03df
LibreChat-CodeAPI=ddba629a7b6384c8088d012008f0300ba2d1e355b620b26a71c1e5dfaf3428df
LibreChat-RAG-API=d16e85e1e1036a8d203a338032d367e472f7245e993efc1ef30d06e7bf6373de
chat-mongodb=01d5bc03e9cb05a5efe43cc8a95c3dfce1e6387f65250923d135debe3050e7c6
LibreChat-Admin-Panel=95fa880c7c3c3cd5c18ecca0068ee28f93d455889b593a8fc897768a01c2b49b
```

All protected identities remained unchanged.

## Browser Acceptance

Authenticated production acceptance passed for the `近 30 天` view:

- trend Y-axis labels and sampled dates were visible;
- the Token trend rendered real production values;
- point hover returned `2026-07-08 · Token 消耗：12.0M`;
- model distribution rendered a donut and persistent legend;
- model hover returned `claude-fable-5 · 29.7M Token · 75.3%`;
- switching to `费用消耗` changed the chart to USD axis labels;
- switching back to `Token 消耗` succeeded;
- summary and log pricing remained USD;
- no API error, empty state, overlap, or clipped chart label was observed.

## Gate Events

Two pre-production gates stopped incomplete attempts before final acceptance:

1. The first package omitted the committed legacy deploy script required by the
   client release test. The test failed before a production write. The package
   was rebuilt from the same commit with the dependency included.
2. The first runtime attempt reached live checks, where shell `pipefail`
   misclassified `curl | grep -q` early closure as a curl error. The scripted
   rollback restored the exact prior Compose hash and Client mount. The fix was
   committed as `bbae4f4`, pushed, repackaged from Git, and then deployed.

No server-side hot patch was used.
