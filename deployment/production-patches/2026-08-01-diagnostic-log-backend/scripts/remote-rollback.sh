#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir="${1:?backup directory is required}"
root_dir="/opt/librechat"
compose_override="$root_dir/compose.override.yaml"

test -f "$backup_dir/compose.override.yaml.before"
cp -a "$backup_dir/compose.override.yaml.before" "$compose_override"
docker compose -f "$root_dir/compose.yaml" -f "$compose_override" config >/dev/null
docker compose -f "$root_dir/compose.yaml" -f "$compose_override" \
  up -d --no-deps --force-recreate api admin-panel >/dev/null

test "$(docker inspect LibreChat-API --format '{{.State.Running}}')" = "true"
test "$(docker inspect LibreChat-Admin-Panel --format '{{.State.Running}}')" = "true"
printf 'rollback=passed\nbackup_dir=%s\n' "$backup_dir"
