#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="/opt/librechat"
api_container="${API_CONTAINER:-LibreChat-API}"
nginx_container="${NGINX_CONTAINER:-LibreChat-NGINX}"
codeapi_container="${CODEAPI_CONTAINER:-LibreChat-CodeAPI}"
mongo_container="${MONGO_CONTAINER:-chat-mongodb}"
main_url="${MAIN_URL:-https://152.32.172.162.sslip.io}"
patch_root="$root_dir/ui-label-patch/client-dist"

test -f "$patch_root/index.html"
test -f "$patch_root/business-upload-menu.js"
grep -Fq 'business-upload-label-patch' "$patch_root/index.html"
grep -Fq 'Office文件上传' "$patch_root/business-upload-menu.js"
grep -Fq "$patch_root:/app/client/dist:ro" "$root_dir/compose.override.yaml"

api_id_before="$(docker inspect "$api_container" --format '{{.Id}}')"
nginx_id_before="$(docker inspect "$nginx_container" --format '{{.Id}}')"
codeapi_id_before="$(docker inspect "$codeapi_container" --format '{{.Id}}')"
mongo_id_before="$(docker inspect "$mongo_container" --format '{{.Id}}')"

cd "$root_dir"
docker compose up -d --no-deps --force-recreate client >/dev/null

ready=0
for _ in $(seq 1 90); do
  if curl -ksSf "$main_url/" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = "1"

nginx_id_after="$(docker inspect "$nginx_container" --format '{{.Id}}')"
test "$nginx_id_after" != "$nginx_id_before"
test "$(docker inspect "$api_container" --format '{{.Id}}')" = "$api_id_before"
test "$(docker inspect "$codeapi_container" --format '{{.Id}}')" = "$codeapi_id_before"
test "$(docker inspect "$mongo_container" --format '{{.Id}}')" = "$mongo_id_before"
test "$(docker inspect "$codeapi_container" --format '{{.State.Health.Status}}')" = "healthy"

public_index="$(mktemp)"
public_script="$(mktemp)"
trap 'rm -f "$public_index" "$public_script"' EXIT
curl -ksS --compressed "$main_url/?upload-menu-persistence=$(date +%s)" >"$public_index"
curl -ksS --compressed "$main_url/business-upload-menu.js?upload-menu-persistence=$(date +%s)" >"$public_script"
test "$(grep -o 'business-upload-label-patch' "$public_index" | wc -l | tr -d '[:space:]')" = "1"
grep -Fq '图片上传' "$public_script"
grep -Fq 'Office文件上传' "$public_script"
grep -Fq '文件提取文字上传' "$public_script"
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"

printf 'persistence_recreate=ok\n'
printf 'api_container_unchanged=%s\n' "$api_id_before"
printf 'nginx_container_before=%s\n' "$nginx_id_before"
printf 'nginx_container_after=%s\n' "$nginx_id_after"
printf 'codeapi_container_unchanged=%s\n' "$codeapi_id_before"
printf 'mongo_container_unchanged=%s\n' "$mongo_id_before"
printf 'public_index_sha256=%s\n' "$(sha256sum "$public_index" | awk '{print $1}')"
printf 'public_script_sha256=%s\n' "$(sha256sum "$public_script" | awk '{print $1}')"
