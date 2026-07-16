#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-odysseia-login-release}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
patch_root="$root_dir/ui-label-patch"
# Expected production mount: /opt/librechat/ui-label-patch/client-dist:/app/client/dist:ro
api_container="${API_CONTAINER:-LibreChat-API}"
nginx_container="${NGINX_CONTAINER:-LibreChat-NGINX}"
codeapi_container="${CODEAPI_CONTAINER:-LibreChat-CodeAPI}"
mongo_container="${MONGO_CONTAINER:-chat-mongodb}"
main_url="${MAIN_URL:-https://152.32.172.162.sslip.io}"
expected_mount="$patch_root/client-dist:/app/client/dist:ro"
source_js="$stage_dir/client/odysseia-login.js"
builder="$stage_dir/scripts/build-odysseia-login-client.py"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/odysseia-login-$timestamp"
work_dir="$(mktemp -d /tmp/librechat-odysseia-login.XXXXXX)"
candidate_dist="$work_dir/client-dist"
next_patch="$root_dir/ui-label-patch.next-$timestamp"

cleanup_work() {
  rm -rf "$work_dir"
  if [[ -e "$next_patch" ]]; then
    rm -rf "$next_patch"
  fi
}
trap cleanup_work EXIT

for path in \
  "$compose_base" \
  "$compose_override" \
  "$source_js" \
  "$builder"; do
  test -f "$path"
done

grep -Fq "$expected_mount" "$compose_override"

for container in "$api_container" "$nginx_container" "$codeapi_container" "$mongo_container"; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
done
test "$(docker inspect "$codeapi_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" = "healthy"
curl -ksSf "$main_url/" >/dev/null
curl -ksSf "$main_url/api/config" >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"

mkdir -p "$candidate_dist"
docker cp "$api_container:/app/client/dist/." "$candidate_dist/"
python3 "$builder" --dist "$candidate_dist" >"$work_dir/build-result.txt"

grep -Fq 'odysseia-login-page-patch' "$candidate_dist/index.html"
grep -Fq 'business-upload-label-patch' "$candidate_dist/index.html"
grep -Fq 'Odýsseia Studio' "$candidate_dist/odysseia-login.js"
grep -Fq 'Start your Agent Studio.' "$candidate_dist/odysseia-login.js"
grep -Fq 'font-weight: 400' "$candidate_dist/odysseia-login.js"

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight=ok\n'
  printf 'api_image=%s\n' "$(docker inspect "$api_container" --format '{{.Config.Image}}')"
  printf 'candidate_index_sha256=%s\n' "$(sha256sum "$candidate_dist/index.html" | awk '{print $1}')"
  printf 'candidate_script_sha256=%s\n' "$(sha256sum "$candidate_dist/odysseia-login.js" | awk '{print $1}')"
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
docker exec "$api_container" grep -Fq 'odysseia-login-page-patch' /app/client/dist/index.html
docker exec "$api_container" grep -Fq 'Odýsseia Studio' /app/client/dist/odysseia-login.js

public_index="$work_dir/public-index-after.html"
public_script="$work_dir/odysseia-login-after.js"
public_upload_script="$work_dir/business-upload-menu-after.js"
curl -ksS --compressed "$main_url/?odysseia-login-release=$timestamp" >"$public_index"
curl -ksS --compressed "$main_url/odysseia-login.js?odysseia-login-release=$timestamp" >"$public_script"
curl -ksS --compressed "$main_url/business-upload-menu.js?odysseia-login-release=$timestamp" >"$public_upload_script"
test "$(grep -o 'odysseia-login-page-patch' "$public_index" | wc -l | tr -d '[:space:]')" = "1"
test "$(grep -o 'business-upload-label-patch' "$public_index" | wc -l | tr -d '[:space:]')" = "1"
for value in \
  'Odýsseia Studio' \
  'Start your Agent Studio.' \
  'font-weight: 400' \
  'https://image01.vidu.zone/vidu/landing-page/login-bg.c7293340.mp4'; do
  grep -Fq "$value" "$public_script"
done
grep -Fq 'Office文件上传' "$public_upload_script"
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
public_upload_script_sha256=$(sha256sum "$public_upload_script" | awk '{print $1}')
office_status=401
codeapi_health=healthy
EOF
cat "$work_dir/build-result.txt" >>"$stage_dir/DEPLOY_RESULT.txt"
cat "$stage_dir/DEPLOY_RESULT.txt"
