# Admin Model Context Configuration Deployment Result

Date: 2026-07-19

Status: passed.

## Admin Image Release

```text
release_commit=0d5164e5164eb55af95dad684de9d13f2e8a8c55
source_tree_sha256=7c7249a76b3748aeb763afff7ba3b8ba7853e19897c1d1307eec4abeb0ecfce5
ci_verified_commit=2b182b8b96befa8e1b16e83c48c0952ccc536c68
ci_verified_tag=admin-ci-7c7249a76b37
ci_run_reference=private-api-unavailable
image_ref=ghcr.io/jetson998/librechat-admin-panel-zh-cn:7c7249a76b37
image_digest=sha256:3a40706d06fe8a70e222a447a85855d69b5b97314dfed98fbecb73c85a3cea00
image_id=sha256:3a40706d06fe8a70e222a447a85855d69b5b97314dfed98fbecb73c85a3cea00
backup_dir=/opt/librechat/backups/admin-context-config-20260719120235
compose_sha_before=aea5293665861fa8b7bcc8fc0a7d629d536fc5de35ba87b8e3838cd86fc5f9ec
compose_sha_after=33f582aa21a857f50d5158d612c9aba30fc4e7c33bcd1ceaec688e9df5eb687f
admin_container_before=e48a986fd6efe51b24e0ccf4d70b11dbfaeafe12cae7ed39d45b04af11f6f94e
admin_container_after=db86b98f14269f2258818eb235594fae8c6c776c12369670d1130babbebe9d6b
protected_containers_unchanged=true
```

The immutable CI tag points to the recorded commit. The public GHCR manifest
was anonymously verified at the recorded digest. The private repository's
workflow-run API was not available to the anonymous operator, so no run number
was invented.

Production bundle checks:

```text
context_ui_bundle=ok
discount_copy_bundle=ok
admin_health=healthy
```

## Initial Context Values

```text
release_commit=dc8166fa9f41416ec66686700065272e066c5f75
backup_id=admin-context-config-20260719120943
MuskAPI/gpt-5.6-sol.context=1000000
MuskAPI-Anthropic/claude-fable-5.context=1000000
config_count_before=1
config_count_after=1
protected_containers_unchanged=true
service_restarts=0
```

The guarded operation backed up the complete active base override before the
write. It verified that the price, cache-price, official-price, publication,
and all other model fields remained EJSON-equivalent after removing only the
new context field.

Final production values:

```text
gpt-5.6-sol: context=1000000 prompt=0.6 completion=3.6 published=true
claude-fable-5: context=1000000 prompt=2.4 completion=12 published=true
```

## Health Gates

```text
root=200
api_config=200
admin=200
office=401
office_realm=Office Converter
```

## Browser Boundary

The Admin deployment invalidated the existing browser login session. The
deployed bundle and persisted values were verified without guessing or reusing
an unrelated password. After the next normal login, the Admin pricing page will
show the new `上下文上限` control and the user model market will format
`1000000` as `1M`.

## Rollback

- Admin image: restore
  `/opt/librechat/backups/admin-context-config-20260719120235/compose.override.yaml`
  and recreate only `LibreChat-Admin-Panel`.
- Context values: restore backup `admin-context-config-20260719120943` with the
  checked-in `rollback-context-values.js` operation.
