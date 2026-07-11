#!/usr/bin/env bash
set -Eeuo pipefail

tarball_path="${1:?tarball_path is required}"
tarball_sha256="${2:?tarball_sha256 is required}"
stage_parent="${3:-/tmp/librechat-admin-panel-zh-cn-release-525a22b}"
stage_dir="$stage_parent/librechat-admin-panel-zh-cn-release"
main_url="${MAIN_URL:-https://152.32.172.162.sslip.io}"
admin_url="${ADMIN_URL:-https://admin.152.32.172.162.sslip.io}"
office_url="$main_url/office/"
build_memory="${BUILD_MEMORY:-1024m}"
build_cpu_quota="${BUILD_CPU_QUOTA:-50000}"
build_timeout="${BUILD_TIMEOUT:-45m}"
old_deps_image="${OLD_DEPS_IMAGE:-librechat-admin-panel-zh-cn-deps:1f409f3}"

log() {
  printf '[admin-release] %s\n' "$*"
}

log "remote_host=$(hostname)"
log "kernel=$(uname -srmo)"

log "killing leftover deps containers if any"
ids="$(docker ps -q --filter "ancestor=$old_deps_image" || true)"
if [ -n "$ids" ]; then
  docker kill $ids >/dev/null
fi

log "read-only recovery audit"
uptime
free -h
df -h /
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

api_id_before="$(docker inspect LibreChat-API --format '{{.Id}}')"
nginx_id_before="$(docker inspect LibreChat-NGINX --format '{{.Id}}')"
codeapi_id_before="$(docker inspect LibreChat-CodeAPI --format '{{.Id}}')"
mongo_id_before="$(docker inspect chat-mongodb --format '{{.Id}}')"
admin_id_before="$(docker inspect LibreChat-Admin-Panel --format '{{.Id}}')"

office_code_before="$(curl -ksS -o /dev/null -w '%{http_code}' "$office_url")"
office_realm_before="$(curl -ksSI "$office_url" | tr -d '\r' | awk -F': ' 'tolower($1)=="www-authenticate" {print $2; exit}')"
config_count_before="$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'db.configs.countDocuments({})' | tail -n 1 | tr -d '[:space:]')"
codeapi_health_before="$(docker inspect LibreChat-CodeAPI --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
main_code_before="$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/")"
api_config_code_before="$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/api/config")"
admin_code_before="$(curl -ksS -o /dev/null -w '%{http_code}' "$admin_url/")"

printf 'before.main=%s\nbefore.api_config=%s\nbefore.admin=%s\nbefore.office=%s\nbefore.office_realm=%s\nbefore.configs=%s\nbefore.codeapi_health=%s\n' \
  "$main_code_before" "$api_config_code_before" "$admin_code_before" "$office_code_before" "$office_realm_before" "$config_count_before" "$codeapi_health_before"

test "$main_code_before" = "200"
test "$api_config_code_before" = "200"
test "$admin_code_before" = "200"
test "$office_code_before" = "401"
test "$office_realm_before" = 'Basic realm="Office Converter"'
test "$config_count_before" = "0"
test "$codeapi_health_before" = "healthy"

log "verifying uploaded tarball"
test -f "$tarball_path"
test "$(sha256sum "$tarball_path" | awk '{print $1}')" = "$tarball_sha256"

log "preparing stage directory"
rm -rf "$stage_parent"
mkdir -p "$stage_parent"
tar -xzf "$tarball_path" -C "$stage_parent"
test -d "$stage_dir"

log "verifying source and CI attestation"
REQUIRE_CI_ATTESTATION=true "$stage_dir/scripts/verify-source.sh"
"$stage_dir/scripts/verify-ci-attestation.sh" "$stage_dir"
target_image_ref="$(cat "$stage_dir/IMAGE_REF")"

log "building release image"
BUILD_MEMORY="$build_memory" BUILD_CPU_QUOTA="$build_cpu_quota" BUILD_TIMEOUT="$build_timeout" \
  "$stage_dir/scripts/build-image.sh" "$stage_dir"

log "running deploy preflight"
PREFLIGHT_ONLY=true "$stage_dir/scripts/deploy.sh" "$stage_dir"

log "deploying admin panel"
"$stage_dir/scripts/deploy.sh" "$stage_dir"

log "post-deploy validation"
api_id_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
nginx_id_after="$(docker inspect LibreChat-NGINX --format '{{.Id}}')"
codeapi_id_after="$(docker inspect LibreChat-CodeAPI --format '{{.Id}}')"
mongo_id_after="$(docker inspect chat-mongodb --format '{{.Id}}')"
admin_id_after="$(docker inspect LibreChat-Admin-Panel --format '{{.Id}}')"

test "$api_id_before" = "$api_id_after"
test "$nginx_id_before" = "$nginx_id_after"
test "$codeapi_id_before" = "$codeapi_id_after"
test "$mongo_id_before" = "$mongo_id_after"
test "$admin_id_before" != "$admin_id_after"
docker image inspect "$target_image_ref" >/dev/null

log "cleaning buildkit cache and old webui artifacts"
docker builder prune -af >/dev/null || true
old_deps_image_id="$(docker image inspect "$old_deps_image" --format '{{.Id}}' 2>/dev/null || true)"
if [ -n "$old_deps_image_id" ]; then
  docker image rm -f "$old_deps_image" >/dev/null || true
fi
for container in open-webui open-webui-before-claude-20260707215154; do
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$container"; then
    docker rm -f "$container" >/dev/null || true
  fi
done
open_webui_image_ids="$(docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | awk '$1 ~ /^open-webui(:|$)/ {print $2}')"
if [ -n "$open_webui_image_ids" ]; then
  docker rmi -f $open_webui_image_ids >/dev/null || true
fi

log "final state snapshot"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker system df

printf 'REMOTE_STAGE_DIR=%s\n' "$stage_dir"
printf 'API_ID_BEFORE=%s\nAPI_ID_AFTER=%s\n' "$api_id_before" "$api_id_after"
printf 'NGINX_ID_BEFORE=%s\nNGINX_ID_AFTER=%s\n' "$nginx_id_before" "$nginx_id_after"
printf 'CODEAPI_ID_BEFORE=%s\nCODEAPI_ID_AFTER=%s\n' "$codeapi_id_before" "$codeapi_id_after"
printf 'MONGO_ID_BEFORE=%s\nMONGO_ID_AFTER=%s\n' "$mongo_id_before" "$mongo_id_after"
printf 'ADMIN_ID_BEFORE=%s\nADMIN_ID_AFTER=%s\n' "$admin_id_before" "$admin_id_after"

log "build result"
cat "$stage_dir/BUILD_RESULT.txt"
log "deploy result"
cat "$stage_dir/DEPLOY_RESULT.txt"
