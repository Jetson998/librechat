#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-admin-panel-zh-cn-release}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
candidate_override="$stage_dir/compose.override.yaml"
expected_before="$stage_dir/compose.before.yaml"
image_ref="$(cat "$stage_dir/IMAGE_REF")"
expected_image_id="$(cat "$stage_dir/BUILT_IMAGE_ID")"
main_url="https://152.32.172.162.sslip.io"
admin_url="https://admin.152.32.172.162.sslip.io"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/admin-panel-zh-cn-$timestamp"

for path in "$compose_base" "$compose_override" "$env_file" "$candidate_override" "$expected_before"; do
  test -f "$path"
done

cmp -s "$compose_override" "$expected_before"
test "$(docker image inspect "$image_ref" --format '{{.Id}}')" = "$expected_image_id"
test "$(docker image inspect "$image_ref" --format '{{.Architecture}}')" = "amd64"
grep -Fqx "    image: $image_ref" "$candidate_override"

docker compose \
  --env-file "$env_file" \
  -f "$compose_base" \
  -f "$candidate_override" \
  config >/dev/null

declare -A protected_ids
for container in LibreChat-API LibreChat-NGINX LibreChat-CodeAPI chat-mongodb; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
admin_container_id_before="$(docker inspect LibreChat-Admin-Panel --format '{{.Id}}')"
admin_image_ref_before="$(docker inspect LibreChat-Admin-Panel --format '{{.Config.Image}}')"
admin_image_id_before="$(docker inspect LibreChat-Admin-Panel --format '{{.Image}}')"

config_count_before="$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'db.configs.countDocuments({})' | tail -n 1 | tr -d '[:space:]')"
office_code_before="$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")"
office_realm_before="$(curl -ksSI "$main_url/office/" | tr -d '\r' | awk -F': ' 'tolower($1)=="www-authenticate" {print $2; exit}')"
test "$config_count_before" = "0"
test "$office_code_before" = "401"
test "$office_realm_before" = 'Basic realm="Office Converter"'
curl -fsS "$main_url/api/config" >/dev/null
curl -fsS "$main_url/" >/dev/null

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight=ok\nimage_ref=%s\nimage_id=%s\n' "$image_ref" "$expected_image_id"
  exit 0
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
docker inspect LibreChat-Admin-Panel >"$backup_dir/admin-container-before.json"
printf '%s\n' "$config_count_before" >"$backup_dir/config-count-before"

applied=0
rollback() {
  set +e
  cp -a "$backup_dir/compose.override.yaml" "$compose_override"
  cd "$root_dir"
  docker compose up -d --no-deps --force-recreate admin-panel >/dev/null 2>&1
}

on_error() {
  local rc=$?
  trap - ERR
  if [[ "$applied" = "1" ]]; then rollback; fi
  exit "$rc"
}
trap on_error ERR

next_override="$compose_override.next-$timestamp"
cp "$candidate_override" "$next_override"
chmod --reference="$compose_override" "$next_override"
chown --reference="$compose_override" "$next_override"
mv "$next_override" "$compose_override"
applied=1

cd "$root_dir"
docker compose up -d --no-deps --force-recreate admin-panel >/dev/null

for _ in $(seq 1 120); do
  health="$(docker inspect LibreChat-Admin-Panel --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  [[ "$health" = "healthy" ]] && break
  sleep 1
done
test "$(docker inspect LibreChat-Admin-Panel --format '{{.State.Health.Status}}')" = "healthy"
test "$(docker inspect LibreChat-Admin-Panel --format '{{.Image}}')" = "$expected_image_id"
test -z "$(docker port LibreChat-Admin-Panel)"

for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done

curl -fsS "$admin_url/" >/dev/null
curl -fsS "$main_url/api/config" >/dev/null
curl -fsS "$main_url/" >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"
test "$(curl -ksSI "$main_url/office/" | tr -d '\r' | awk -F': ' 'tolower($1)=="www-authenticate" {print $2; exit}')" = 'Basic realm="Office Converter"'
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.Health.Status}}')" = "healthy"
test "$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'db.configs.countDocuments({})' | tail -n 1 | tr -d '[:space:]')" = "$config_count_before"
docker exec LibreChat-Admin-Panel sh -lc "grep -R -q '简体中文' /app/dist"
docker exec LibreChat-Admin-Panel sh -lc "grep -R -q '修改版源代码' /app/dist"

admin_container_id_after="$(docker inspect LibreChat-Admin-Panel --format '{{.Id}}')"
admin_image_ref_after="$(docker inspect LibreChat-Admin-Panel --format '{{.Config.Image}}')"
admin_image_id_after="$(docker inspect LibreChat-Admin-Panel --format '{{.Image}}')"

trap - ERR
cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
backup_dir=$backup_dir
image_ref=$image_ref
image_id=$expected_image_id
admin_container_id_before=$admin_container_id_before
admin_image_ref_before=$admin_image_ref_before
admin_image_id_before=$admin_image_id_before
admin_container_id_after=$admin_container_id_after
admin_image_ref_after=$admin_image_ref_after
admin_image_id_after=$admin_image_id_after
config_count_before=$config_count_before
config_count_after=$config_count_before
office_status=401
office_realm=Office Converter
protected_containers_unchanged=true
EOF
for container in LibreChat-API LibreChat-NGINX LibreChat-CodeAPI chat-mongodb; do
  key="${container//-/_}"
  current_id="$(docker inspect "$container" --format '{{.Id}}')"
  printf 'protected_%s_before=%s\nprotected_%s_after=%s\n' \
    "$key" "${protected_ids[$container]}" "$key" "$current_id" \
    >>"$stage_dir/DEPLOY_RESULT.txt"
done
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nbackup_dir=%s\nimage_ref=%s\nimage_id=%s\n' \
  "$backup_dir" "$image_ref" "$expected_image_id"
