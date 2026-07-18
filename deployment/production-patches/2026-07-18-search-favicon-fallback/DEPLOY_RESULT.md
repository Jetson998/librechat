# Search Favicon Fallback Deployment Result

Deployment time: 2026-07-18 23:06 Asia/Singapore

Release commit: `14b9fc7972f5b9c257a610d8a5e7b92d90533427`

Status: passed.

## Runtime

```text
release_root=/opt/librechat/search-favicon-fallback/14b9fc7972f5-20260718230646
backup_dir=/opt/librechat/backups/search-favicon-fallback-20260718230646
compose_sha_before=0414a99197a5594ef18b06393f615331327b5fc53f15897f2763a4ece52ca68c
compose_sha_after=4f93345987c1913c8379792d54db2dea7a417106cbb978a1bae5269e07f6aa8f
client_index_before=b6834a3533fef6ca1a65d5061ebe63f274c15516bd9a92d14a6ec6b2a84aac87
client_index_after=27dd78be6e3862a4297e6a20b12a758513c11ebfcd515d05b550fa32a2903921
search_asset=search-favicon-fallback-14b9fc7972f5.js
search_asset_sha=6dc1974118b843218c9178caccedaf4cd7cba5e1e17574ab883d622f550bdade
api_container_before=ad3b7993e48e1b4994d325cadf59576f066e95dbe000c3fbbb4349bd0a09370e
api_container_after=655e598261380bb37bba47b4175e17ef1f6cbf0bc0204319e0cb8b418c38ce11
config_sha_unchanged=4868cbaa70558cba2def51a3c8f8a5d4e8eb88248a697866a813f06feec05375
```

The usage route remained mounted from:

```text
/opt/librechat/user-usage-cost-detail-availability/de2beeace561-20260718223055/usage-dashboard.js
```

Its SHA remained
`5bd0bd087aab75799fb429b7da8cbb68b6947856b6fe388aeb86985a94821ba9`.

## Health Gates

```text
root=200
api_config=200
office=401
usage_dashboard_unauthenticated=401
protected_containers_unchanged=true
protected_client_assets_unchanged=true
```

Only `LibreChat-API` was recreated. Nginx, CodeAPI, RAG-API, MongoDB, and the
Admin Panel retained their container identities.

## Browser Acceptance

Existing conversation:

```text
https://152.32.172.162.sslip.io/c/a98930ef-5cc2-46ca-b664-f2b5eab24dea
```

Observed after deployment:

```text
searched_cards=2
source_links=26
source_images=26
local_fallback_images=26
google_favicon_images=0
broken_images=0
user_turns=2
assistant_turns=2
prompt_value_empty=true
send_button_disabled=true
```

Every replacement had positive natural dimensions and retained its source
domain in `data-lc-search-favicon-fallback`. Expanding the second 13-source
card displayed the generated initial icons and kept all source titles, domains,
and links intact. No message was sent and no conversation was created.
