#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-upload-menu-release}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
patch_root="$root_dir/ui-label-patch"
api_container="${API_CONTAINER:-LibreChat-API}"
nginx_container="${NGINX_CONTAINER:-LibreChat-NGINX}"
codeapi_container="${CODEAPI_CONTAINER:-LibreChat-CodeAPI}"
mongo_container="${MONGO_CONTAINER:-chat-mongodb}"
main_url="${MAIN_URL:-https://152.32.172.162.sslip.io}"
expected_mount="$patch_root/client-dist:/app/client/dist:ro"
source_js="$stage_dir/client/business-upload-menu.js"
builder="$stage_dir/scripts/build-upload-menu-client.py"
compose_merger="$stage_dir/scripts/merge-compose-upload-menu.cjs"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/upload-menu-$timestamp"
work_dir="$(mktemp -d /tmp/librechat-upload-menu.XXXXXX)"
candidate_dist="$work_dir/client-dist"
candidate_override="$work_dir/compose.override.yaml"
compose_input_container="/tmp/upload-menu-compose-$timestamp.input.yaml"
compose_output_container="/tmp/upload-menu-compose-$timestamp.output.yaml"
next_patch="$root_dir/ui-label-patch.next-$timestamp"
next_override="$compose_override.next-$timestamp"

cleanup_work() {
  rm -rf "$work_dir"
  if [[ -e "$next_patch" ]]; then
    rm -rf "$next_patch"
  fi
  rm -f "$next_override"
  docker exec "$api_container" rm -f \
    "$compose_input_container" "$compose_output_container" >/dev/null 2>&1 || true
}
trap cleanup_work EXIT

for path in \
  "$compose_base" \
  "$compose_override" \
  "$source_js" \
  "$builder" \
  "$compose_merger"; do
  test -f "$path"
done

for container in "$api_container" "$nginx_container" "$codeapi_container" "$mongo_container"; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
done
test "$(docker inspect "$codeapi_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" = "healthy"
curl -ksSf "$main_url/" >/dev/null
curl -ksSf "$main_url/api/config" >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"
docker exec -w /app "$api_container" node -e "require('js-yaml')" >/dev/null

mkdir -p "$candidate_dist"
docker cp "$api_container:/app/client/dist/." "$candidate_dist/"
python3 "$builder" --dist "$candidate_dist" >"$work_dir/build-result.txt"

docker cp "$compose_override" "$api_container:$compose_input_container"
docker exec -i -w /app "$api_container" node - \
  "$compose_input_container" "$compose_output_container" "$expected_mount" \
  <"$compose_merger"
docker cp "$api_container:$compose_output_container" "$candidate_override"

docker compose \
  --env-file "$root_dir/.env" \
  -f "$compose_base" \
  -f "$candidate_override" \
  config >/dev/null
grep -Fq "$expected_mount" "$candidate_override"
grep -Fq 'business-upload-label-patch' "$candidate_dist/index.html"
grep -Fq '图片上传' "$candidate_dist/business-upload-menu.js"
grep -Fq 'Office文件上传' "$candidate_dist/business-upload-menu.js"
grep -Fq '文件提取文字上传' "$candidate_dist/business-upload-menu.js"

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight=ok\n'
  printf 'api_image=%s\n' "$(docker inspect "$api_container" --format '{{.Config.Image}}')"
  printf 'candidate_index_sha256=%s\n' "$(sha256sum "$candidate_dist/index.html" | awk '{print $1}')"
  printf 'candidate_script_sha256=%s\n' "$(sha256sum "$candidate_dist/business-upload-menu.js" | awk '{print $1}')"
  cat "$work_dir/build-result.txt"
  exit 0
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
docker inspect "$api_container" >"$backup_dir/api-container-before.json"
docker inspect "$nginx_container" >"$backup_dir/nginx-container-before.json"
curl -ksS "$main_url/" >"$backup_dir/public-index-before.html"
sha256sum "$backup_dir/public-index-before.html" >"$backup_dir/public-index-before.sha256"

patch_existed=0
if [[ -e "$patch_root" ]]; then
  patch_existed=1
else
  : >"$backup_dir/ui-label-patch.absent"
fi

applied=0
rollback() {
  set +e
  cp -a "$backup_dir/compose.override.yaml" "$compose_override"
  if [[ -e "$patch_root" ]]; then
    mv "$patch_root" "$backup_dir/ui-label-patch-failed"
  fi
  if [[ "$patch_existed" = "1" && -e "$backup_dir/ui-label-patch-before" ]]; then
    mv "$backup_dir/ui-label-patch-before" "$patch_root"
  fi
  cd "$root_dir"
  docker compose up -d --no-deps --force-recreate api >/dev/null 2>&1
  for _ in $(seq 1 90); do
    curl -ksSf "$main_url/api/config" >/dev/null 2>&1 && break
    sleep 1
  done
}

on_error() {
  local rc=$?
  trap - ERR
  if [[ "$applied" = "1" ]]; then
    rollback
  fi
  exit "$rc"
}
trap on_error ERR

mkdir -p "$next_patch"
cp -a "$candidate_dist" "$next_patch/client-dist"
chmod -R a-w "$next_patch/client-dist"
applied=1
if [[ "$patch_existed" = "1" ]]; then
  mv "$patch_root" "$backup_dir/ui-label-patch-before"
fi
mv "$next_patch" "$patch_root"

cp "$candidate_override" "$next_override"
chmod --reference="$compose_override" "$next_override"
chown --reference="$compose_override" "$next_override"
mv "$next_override" "$compose_override"

api_id_before="$(docker inspect "$api_container" --format '{{.Id}}')"
nginx_id_before="$(docker inspect "$nginx_container" --format '{{.Id}}')"
codeapi_id_before="$(docker inspect "$codeapi_container" --format '{{.Id}}')"
mongo_id_before="$(docker inspect "$mongo_container" --format '{{.Id}}')"

cd "$root_dir"
docker compose up -d --no-deps --force-recreate api >/dev/null

ready=0
for _ in $(seq 1 120); do
  if curl -ksSf "$main_url/api/config" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = "1"
test "$(docker inspect "$api_container" --format '{{.State.Running}}')" = "true"
test "$(docker inspect "$nginx_container" --format '{{.Id}}')" = "$nginx_id_before"
test "$(docker inspect "$codeapi_container" --format '{{.Id}}')" = "$codeapi_id_before"
test "$(docker inspect "$mongo_container" --format '{{.Id}}')" = "$mongo_id_before"
test "$(docker inspect "$codeapi_container" --format '{{.State.Health.Status}}')" = "healthy"

docker inspect "$api_container" --format '{{range .Mounts}}{{println .Source ":" .Destination .Mode}}{{end}}' \
  | grep -Fq "$patch_root/client-dist : /app/client/dist ro"
docker exec "$api_container" grep -Fq 'business-upload-label-patch' /app/client/dist/index.html
docker exec "$api_container" grep -Fq 'Office文件上传' /app/client/dist/business-upload-menu.js

public_index="$work_dir/public-index-after.html"
public_script="$work_dir/business-upload-menu-after.js"
curl -ksS --compressed "$main_url/?upload-menu-release=$timestamp" >"$public_index"
curl -ksS --compressed "$main_url/business-upload-menu.js?upload-menu-release=$timestamp" >"$public_script"
test "$(grep -o 'business-upload-label-patch' "$public_index" | wc -l | tr -d '[:space:]')" = "1"
for value in \
  '图片上传' \
  'Office文件上传' \
  '文件提取文字上传' \
  '仅图片；用于截图、照片、图像识别' \
  'Word/Excel/PPT 原文件；可读写并返回文件' \
  '转成文本给模型分析；适合审阅总结'; do
  grep -Fq "$value" "$public_script"
done
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"

trap - ERR
cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
backup_dir=$backup_dir
api_image=$(docker inspect "$api_container" --format '{{.Config.Image}}')
api_container_before=$api_id_before
api_container_after=$(docker inspect "$api_container" --format '{{.Id}}')
nginx_container_unchanged=true
codeapi_container_unchanged=true
mongo_container_unchanged=true
compose_mount=$expected_mount
public_index_sha256=$(sha256sum "$public_index" | awk '{print $1}')
public_script_sha256=$(sha256sum "$public_script" | awk '{print $1}')
office_status=401
codeapi_health=healthy
EOF
cat "$work_dir/build-result.txt" >>"$stage_dir/DEPLOY_RESULT.txt"
cat "$stage_dir/DEPLOY_RESULT.txt"
