#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-admin-user-creation}"
root_dir="/opt/librechat"
api_container="LibreChat-API"
admin_container="LibreChat-Admin-Panel"
mongo_container="chat-mongodb"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
route_patch_dir="$root_dir/admin-user-creation"
api_bundle_host="$route_patch_dir/api-index.cjs"
route_patch_host="$route_patch_dir/users.js"
candidate_bundle="$stage_dir/api-patch/api-index.cjs"
candidate_route="$stage_dir/api-patch/users.js"
admin_source="$stage_dir/admin-panel-source"
release_commit="${RELEASE_COMMIT:-unknown}"
main_url="https://152.32.172.162.sslip.io"
admin_url="https://admin.152.32.172.162.sslip.io"
expected_active_bundle_before="2eff0d333af8f058455932a0d077f732d48d16175ebed32cf7ed79193f19dd2d"
expected_route_before="69c8e49b22a188fc222c21aaa927a4e05946afe8e08c4b1d4428cc35966cd469"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/admin-user-creation-$timestamp"

for path in \
  "$compose_base" "$compose_override" "$env_file" \
  "$candidate_bundle" "$candidate_route" "$admin_source/Dockerfile"; do
  test -e "$path"
done

ADMIN_PANEL_SOURCE="$admin_source" python3 "$stage_dir/scripts/test-release.py"
node --check "$candidate_bundle"
node --check "$candidate_route"
test "$(docker exec "$api_container" sha256sum /app/packages/api/dist/index.cjs | awk '{print $1}')" = "$expected_active_bundle_before"
test "$(docker exec "$api_container" sha256sum /app/api/server/routes/admin/users.js | awk '{print $1}')" = "$expected_route_before"
test -z "$(docker inspect "$api_container" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  | awk '$3 == "/app/packages/api/dist/index.cjs" {print $1}')"

candidate_test_path="/app/packages/api/dist/admin-user-candidate.cjs"
docker cp "$candidate_bundle" "$api_container:$candidate_test_path"
docker cp "$stage_dir/scripts/test-api-handler.js" "$api_container:/tmp/test-admin-user-handler.js"
cleanup_candidate_test() {
  docker exec "$api_container" rm -f "$candidate_test_path" /tmp/test-admin-user-handler.js >/dev/null 2>&1 || true
}
trap cleanup_candidate_test EXIT
docker exec "$api_container" node /tmp/test-admin-user-handler.js "$candidate_test_path"
cleanup_candidate_test
trap - EXIT

source_hash="$({
  cd "$admin_source"
  find . -type f \
    ! -path './node_modules/*' ! -path './dist/*' ! -path './.git/*' \
    ! -name '.DS_Store' -print0 \
    | sort -z \
    | xargs -0 sha256sum
} | sha256sum | awk '{print $1}')"
image_ref="librechat-admin-panel-user-creation:${source_hash:0:12}"
docker build \
  --build-arg "MODIFIED_SOURCE_REVISION=$release_commit" \
  -t "$image_ref" "$admin_source"
image_id="$(docker image inspect "$image_ref" --format '{{.Id}}')"
test "$(docker image inspect "$image_ref" --format '{{.Architecture}}')" = "amd64"

candidate_override="$stage_dir/compose.override.candidate.yaml"
python3 - "$compose_override" "$candidate_override" "$image_ref" <<'PY'
import sys
import yaml

source, destination, image = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle)
services = data.setdefault("services", {})
api = services.setdefault("api", {})
volumes = api.setdefault("volumes", [])
bundle_mount = "/opt/librechat/admin-user-creation/api-index.cjs:/app/packages/api/dist/index.cjs:ro"
mount = "/opt/librechat/admin-user-creation/users.js:/app/api/server/routes/admin/users.js:ro"
volumes = [
    item for item in volumes
    if not str(item).endswith(":/app/packages/api/dist/index.cjs:ro")
    and not str(item).endswith(":/app/api/server/routes/admin/users.js:ro")
]
volumes.append(bundle_mount)
volumes.append(mount)
api["volumes"] = volumes
admin = services.setdefault("admin-panel", {})
admin["image"] = image
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null

declare -A protected_ids
for container in LibreChat-NGINX LibreChat-CodeAPI "$mongo_container"; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
api_id_before="$(docker inspect "$api_container" --format '{{.Id}}')"
admin_id_before="$(docker inspect "$admin_container" --format '{{.Id}}')"
route_existed=0
test -e "$route_patch_host" && route_existed=1
bundle_existed=0
test -e "$api_bundle_host" && bundle_existed=1

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight=ok\nimage_ref=%s\nimage_id=%s\nsource_hash=%s\n' \
    "$image_ref" "$image_id" "$source_hash"
  exit 0
fi

mkdir -p "$backup_dir" "$route_patch_dir"
chmod 700 "$backup_dir"
docker cp "$api_container:/app/packages/api/dist/index.cjs" "$backup_dir/api-index.cjs.active-before"
docker cp "$api_container:/app/api/server/routes/admin/users.js" "$backup_dir/users.js.active-before"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
if [[ "$bundle_existed" = "1" ]]; then cp -a "$api_bundle_host" "$backup_dir/api-index.cjs.host-before"; fi
if [[ "$route_existed" = "1" ]]; then cp -a "$route_patch_host" "$backup_dir/users.js"; fi

applied=0
rollback() {
  set +e
  cp -a "$backup_dir/compose.override.yaml" "$compose_override"
  if [[ "$bundle_existed" = "1" ]]; then
    cp -a "$backup_dir/api-index.cjs.host-before" "$api_bundle_host"
  else
    rm -f "$api_bundle_host"
  fi
  if [[ "$route_existed" = "1" ]]; then
    cp -a "$backup_dir/users.js" "$route_patch_host"
  else
    rm -f "$route_patch_host"
  fi
  cd "$root_dir"
  docker compose up -d --no-deps --force-recreate api admin-panel >/dev/null 2>&1
}
on_error() {
  rc=$?
  trap - ERR
  [[ "$applied" = "1" ]] && rollback
  exit "$rc"
}
trap on_error ERR

install -m 0644 "$candidate_bundle" "$api_bundle_host.next-$timestamp"
mv "$api_bundle_host.next-$timestamp" "$api_bundle_host"
install -m 0644 "$candidate_route" "$route_patch_host.next-$timestamp"
mv "$route_patch_host.next-$timestamp" "$route_patch_host"
install -m 0644 "$candidate_override" "$compose_override.next-$timestamp"
mv "$compose_override.next-$timestamp" "$compose_override"
applied=1

cd "$root_dir"
docker compose up -d --no-deps --force-recreate api admin-panel >/dev/null

ready=0
for _ in $(seq 1 120); do
  if curl -ksSf "$main_url/api/config" >/dev/null; then ready=1; break; fi
  sleep 1
done
test "$ready" = "1"
for _ in $(seq 1 120); do
  health="$(docker inspect "$admin_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  [[ "$health" = "healthy" ]] && break
  sleep 1
done
test "$(docker inspect "$admin_container" --format '{{.State.Health.Status}}')" = "healthy"

docker exec "$api_container" node --check /app/packages/api/dist/index.cjs
docker exec "$api_container" node --check /app/api/server/routes/admin/users.js
docker exec "$api_container" grep -Fq 'createUser: createUserHandler' /app/packages/api/dist/index.cjs
docker exec "$api_container" grep -Fq "router.post('/', requireManageUsers, handlers.createUser)" /app/api/server/routes/admin/users.js
docker inspect "$api_container" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  | grep -Fqx "$api_bundle_host -> /app/packages/api/dist/index.cjs"
docker inspect "$api_container" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  | grep -Fqx "$route_patch_host -> /app/api/server/routes/admin/users.js"
docker exec "$admin_container" sh -lc "grep -R -q 'com_users_password_mismatch' /app/src/server /app/dist"
curl -ksSf "$main_url/" >/dev/null
curl -ksSf "$admin_url/" >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' -X POST "$main_url/api/admin/users")" = "401"
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"

for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done
test "$(docker inspect "$api_container" --format '{{.Id}}')" != "$api_id_before"
test "$(docker inspect "$admin_container" --format '{{.Id}}')" != "$admin_id_before"

trap - ERR
cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
backup_dir=$backup_dir
release_commit=$release_commit
source_hash=$source_hash
image_ref=$image_ref
image_id=$image_id
api_container_before=$api_id_before
api_container_after=$(docker inspect "$api_container" --format '{{.Id}}')
admin_container_before=$admin_id_before
admin_container_after=$(docker inspect "$admin_container" --format '{{.Id}}')
protected_containers_unchanged=true
admin_create_unauthenticated_status=401
office_status=401
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nbackup_dir=%s\nimage_ref=%s\nimage_id=%s\n' \
  "$backup_dir" "$image_ref" "$image_id"
