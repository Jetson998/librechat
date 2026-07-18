#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-model-pricing-dotted-key}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
admin_source="$stage_dir/admin-panel-source"
api_bundle="$stage_dir/api-index.cjs"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
release_root="$root_dir/model-pricing-dotted-key/$release_key-$timestamp"
release_api="$release_root/api-index.cjs"
backup_dir="$root_dir/backups/model-pricing-dotted-key-$timestamp"
api_container="LibreChat-API"
admin_container="LibreChat-Admin-Panel"

expected_override_sha="90a03305d3f1706f1363e33b7a7368fe9dc69a11cb31858c1535a571669aa1ec"
expected_api_sha="2cc88bec7011b3d063f5528171d98835ab295e4fefc679bd2e4963fa5e66ee20"
expected_admin_image="librechat-admin-panel-model-pricing:5da05ef0635e"

for path in "$compose_base" "$compose_override" "$env_file" "$admin_source/Dockerfile" "$api_bundle"; do
  test -e "$path"
done

test "$(sha256sum "$compose_override" | awk '{print $1}')" = "$expected_override_sha"
test "$(docker exec "$api_container" sha256sum /app/packages/api/dist/index.cjs | awk '{print $1}')" = "$expected_api_sha"
test "$(docker inspect "$admin_container" --format '{{.Config.Image}}')" = "$expected_admin_image"
node --check "$api_bundle"
ADMIN_PANEL_SOURCE="$admin_source" python3 "$stage_dir/scripts/test-release.py"

source_hash="$({
  cd "$admin_source"
  find . -type f \
    ! -path './node_modules/*' ! -path './dist/*' ! -path './.git/*' \
    ! -name '.DS_Store' -print0 \
    | sort -z \
    | xargs -0 sha256sum
} | sha256sum | awk '{print $1}')"
image_ref="librechat-admin-panel-model-pricing-keyfix:${source_hash:0:12}"

if [[ "${REUSE_PREFLIGHT_IMAGE:-false}" == "true" ]]; then
  docker image inspect "$image_ref" >/dev/null
else
  mem_available_mb="$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)"
  swap_free_mb="$(awk '/^SwapFree:/ {print int($2 / 1024)}' /proc/meminfo)"
  test "$((mem_available_mb + swap_free_mb))" -ge 3584
  docker build --build-arg "MODIFIED_SOURCE_REVISION=$release_commit" -t "$image_ref" "$admin_source"
fi
test "$(docker image inspect "$image_ref" --format '{{.Architecture}}')" = "amd64"

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
install -m 0444 "$api_bundle" "$release_api"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
docker cp "$api_container:/app/packages/api/dist/index.cjs" "$backup_dir/api-index.cjs.before"

candidate_override="$stage_dir/compose.override.candidate.yaml"
python3 - "$compose_override" "$candidate_override" "$release_api" "$image_ref" <<'PY'
import sys
import yaml

source, destination, api_bundle, admin_image = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle)
services = data.setdefault("services", {})
api = services.setdefault("api", {})
volumes = [
    item for item in api.setdefault("volumes", [])
    if not str(item).endswith(":/app/packages/api/dist/index.cjs:ro")
]
volumes.append(f"{api_bundle}:/app/packages/api/dist/index.cjs:ro")
api["volumes"] = volumes
services.setdefault("admin-panel", {})["image"] = admin_image
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
test "$(grep -cF ':/app/packages/api/dist/index.cjs:ro' "$candidate_override")" = "1"
grep -Fq 'USER_USAGE_CURRENCY=USD' "$candidate_override"

declare -A protected_ids
for container in LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API chat-mongodb; do
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
api_id_before="$(docker inspect "$api_container" --format '{{.Id}}')"
admin_id_before="$(docker inspect "$admin_container" --format '{{.Id}}')"
config_version_before="$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'print(db.configs.findOne({principalType:"role",principalId:"__base__",isActive:true}).configVersion)' | tail -n 1 | tr -d '[:space:]')"

applied=0
rollback() {
  set +e
  cp -a "$backup_dir/compose.override.yaml" "$compose_override"
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

install -m 0644 "$candidate_override" "$compose_override.next-$timestamp"
mv "$compose_override.next-$timestamp" "$compose_override"
applied=1
cd "$root_dir"
docker compose up -d --no-deps --force-recreate api admin-panel >/dev/null

for _ in $(seq 1 120); do
  api_ready=0
  admin_ready=0
  curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null 2>&1 && api_ready=1
  test "$(docker inspect "$admin_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" = "healthy" && admin_ready=1
  [[ "$api_ready" = "1" && "$admin_ready" = "1" ]] && break
  sleep 1
done

curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null
curl -ksSf https://admin.152.32.172.162.sslip.io/pricing >/dev/null
test "$(docker inspect "$admin_container" --format '{{.State.Health.Status}}')" = "healthy"
docker exec "$api_container" node --check /app/packages/api/dist/index.cjs
docker exec "$api_container" grep -Fq 'CUSTOM_ENDPOINT_TOKEN_CONFIG_PATH' /app/packages/api/dist/index.cjs
docker exec "$admin_container" sh -lc "grep -R -q 'Model pricing was not persisted' /app/dist"
test "$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'print(db.configs.findOne({principalType:"role",principalId:"__base__",isActive:true}).configVersion)' | tail -n 1 | tr -d '[:space:]')" = "$config_version_before"

for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done
api_id_after="$(docker inspect "$api_container" --format '{{.Id}}')"
admin_id_after="$(docker inspect "$admin_container" --format '{{.Id}}')"
test "$api_id_after" != "$api_id_before"
test "$admin_id_after" != "$admin_id_before"

trap - ERR
cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
release_commit=$release_commit
release_root=$release_root
backup_dir=$backup_dir
compose_sha=$(sha256sum "$compose_override" | awk '{print $1}')
api_bundle_sha=$(sha256sum "$release_api" | awk '{print $1}')
admin_image=$image_ref
api_container_before=$api_id_before
api_container_after=$api_id_after
admin_container_before=$admin_id_before
admin_container_after=$admin_id_after
protected_containers_unchanged=true
config_version_unchanged_during_deploy=true
api_config_health=ok
admin_pricing_health=ok
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nrelease_root=%s\nbackup_dir=%s\napi=%s\nadmin=%s\n' \
  "$release_root" "$backup_dir" "$api_id_after" "$admin_id_after"
