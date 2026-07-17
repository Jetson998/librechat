#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-admin-user-ui-activation}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
admin_source="$stage_dir/admin-panel-source"
admin_container="LibreChat-Admin-Panel"
release_commit="${RELEASE_COMMIT:-unknown}"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/admin-user-ui-activation-$timestamp"
expected_api_sha="2cc88bec7011b3d063f5528171d98835ab295e4fefc679bd2e4963fa5e66ee20"
expected_route_sha="b384199dfbd1b24ed55d12575d03744baa1696ba1202a842fb758bbd895ab571"

for path in "$compose_base" "$compose_override" "$env_file" "$admin_source/Dockerfile"; do
  test -e "$path"
done

ADMIN_PANEL_SOURCE="$admin_source" python3 "$stage_dir/scripts/test-release.py"
test "$(docker exec LibreChat-API sha256sum /app/packages/api/dist/index.cjs | awk '{print $1}')" = "$expected_api_sha"
test "$(docker exec LibreChat-API sha256sum /app/api/server/routes/admin/users.js | awk '{print $1}')" = "$expected_route_sha"
docker inspect LibreChat-API --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  | grep -Fqx '/opt/librechat/admin-user-creation/api-index.cjs -> /app/packages/api/dist/index.cjs'
docker inspect LibreChat-API --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  | grep -Fqx '/opt/librechat/admin-user-creation/users.js -> /app/api/server/routes/admin/users.js'

source_hash="$({
  cd "$admin_source"
  find . -type f \
    ! -path './node_modules/*' ! -path './dist/*' ! -path './.git/*' \
    ! -name '.DS_Store' -print0 \
    | sort -z \
    | xargs -0 sha256sum
} | sha256sum | awk '{print $1}')"
image_ref="librechat-admin-panel-user-ui:${source_hash:0:12}"
mem_available_mb="$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)"
swap_total_mb="$(awk '/^SwapTotal:/ {print int($2 / 1024)}' /proc/meminfo)"
swap_free_mb="$(awk '/^SwapFree:/ {print int($2 / 1024)}' /proc/meminfo)"
test "$swap_total_mb" -ge 3072
test "$((mem_available_mb + swap_free_mb))" -ge 4096
docker build --build-arg "MODIFIED_SOURCE_REVISION=$release_commit" -t "$image_ref" "$admin_source"
image_id="$(docker image inspect "$image_ref" --format '{{.Id}}')"
test "$(docker image inspect "$image_ref" --format '{{.Architecture}}')" = "amd64"

candidate_override="$stage_dir/compose.override.candidate.yaml"
python3 - "$compose_override" "$candidate_override" "$image_ref" <<'PY'
import sys
import yaml

source, destination, image = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle)
data.setdefault("services", {}).setdefault("admin-panel", {})["image"] = image
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY
docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null

declare -A protected_ids
for container in LibreChat-API LibreChat-NGINX LibreChat-CodeAPI chat-mongodb; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
admin_id_before="$(docker inspect "$admin_container" --format '{{.Id}}')"

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight=ok\nimage_ref=%s\nimage_id=%s\nsource_hash=%s\n' \
    "$image_ref" "$image_id" "$source_hash"
  exit 0
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"

applied=0
rollback() {
  set +e
  cp -a "$backup_dir/compose.override.yaml" "$compose_override"
  cd "$root_dir"
  docker compose up -d --no-deps --force-recreate admin-panel >/dev/null 2>&1
}
on_error() {
  rc=$?
  trap - ERR
  [[ "$applied" = "1" ]] && rollback
  exit "$rc"
}
trap on_error ERR

install -m 0644 "$candidate_override" "$compose_override.next-$timestamp"
mv "$compose_override.next-$timestamp" "$compose_override"
applied=1
cd "$root_dir"
docker compose up -d --no-deps --force-recreate admin-panel >/dev/null

for _ in $(seq 1 120); do
  health="$(docker inspect "$admin_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  [[ "$health" = "healthy" ]] && break
  sleep 1
done
test "$(docker inspect "$admin_container" --format '{{.State.Health.Status}}')" = "healthy"
docker exec "$admin_container" sh -lc "grep -R -q 'admin-user-ui-activation' /app/dist"
curl -ksSf https://admin.152.32.172.162.sslip.io/ >/dev/null
curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null

for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done
test "$(docker inspect "$admin_container" --format '{{.Id}}')" != "$admin_id_before"

trap - ERR
cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
backup_dir=$backup_dir
release_commit=$release_commit
source_hash=$source_hash
image_ref=$image_ref
image_id=$image_id
admin_container_before=$admin_id_before
admin_container_after=$(docker inspect "$admin_container" --format '{{.Id}}')
api_and_data_containers_unchanged=true
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nbackup_dir=%s\nimage_ref=%s\nimage_id=%s\n' \
  "$backup_dir" "$image_ref" "$image_id"
