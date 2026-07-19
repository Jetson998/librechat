#!/usr/bin/env bash
set -Eeuo pipefail

# release-governance:scoped-deployment
# release-governance:target-lock
stage_dir="${1:-/tmp/librechat-admin-context-config}"
patch_dir="$stage_dir/deployment/production-patches/2026-07-19-admin-context-config"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
config_file="$root_dir/librechat.yaml"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/admin-context-config-$timestamp"
work_dir="$(mktemp -d /tmp/librechat-admin-context-config.XXXXXX)"
candidate_override="$work_dir/compose.override.yaml"
source "$patch_dir/RELEASE.env"

expected_override_sha="aea5293665861fa8b7bcc8fc0a7d629d536fc5de35ba87b8e3838cd86fc5f9ec"
expected_admin_image="librechat-admin-panel-zh-cn:e6802a820c8e"
expected_client_mount="$root_dir/model-market-layout/1d6bad93acc5-20260719032150/client-dist"
expected_usage_mount="$root_dir/user-model-market/6bfb5be23255-20260718235639/usage-dashboard.js"
local_image="librechat-admin-panel-zh-cn:${SOURCE_TREE_SHA256:0:12}"

cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT
sha_file() { sha256sum "$1" | awk '{print $1}'; }

for path in "$compose_base" "$compose_override" "$env_file" "$config_file" "$patch_dir/RELEASE.env"; do
  test -f "$path"
done
test "$(sha_file "$compose_override")" = "$expected_override_sha"
test "$CI_VERIFIED_TAG" = "admin-ci-${SOURCE_TREE_SHA256:0:12}"
test "$IMAGE_REF" = "ghcr.io/jetson998/librechat-admin-panel-zh-cn:${SOURCE_TREE_SHA256:0:12}"
test "$(docker inspect LibreChat-Admin-Panel --format '{{.Config.Image}}')" = "$expected_admin_image"

active_client_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
active_usage_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/api/server/routes/usage-dashboard.js"}}{{.Source}}{{end}}{{end}}')"
test "$active_client_mount" = "$expected_client_mount"
test "$active_usage_mount" = "$expected_usage_mount"

docker pull "$IMAGE_REF" >/dev/null
repo_digests="$(docker image inspect "$IMAGE_REF" --format '{{join .RepoDigests "\n"}}')"
printf '%s\n' "$repo_digests" | grep -Fq "@$IMAGE_DIGEST"
test "$(docker image inspect "$IMAGE_REF" --format '{{.Architecture}}')" = "amd64"
test "$(docker image inspect "$IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$SOURCE_TREE_SHA256"
docker tag "$IMAGE_REF" "$local_image"
image_id="$(docker image inspect "$local_image" --format '{{.Id}}')"

python3 - "$compose_override" "$candidate_override" "$local_image" <<'PY'
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
grep -Fqx "    image: $local_image" "$candidate_override"
grep -Fq "$expected_client_mount:/app/client/dist:ro" "$candidate_override"
grep -Fq "$expected_usage_mount:/app/api/server/routes/usage-dashboard.js:ro" "$candidate_override"

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight_only=ok\nrelease_commit=%s\nimage_ref=%s\nimage_digest=%s\nimage_id=%s\n' \
    "$release_commit" "$IMAGE_REF" "$IMAGE_DIGEST" "$image_id"
  exit 0
fi

declare -A protected_ids
for container in LibreChat-API LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API chat-mongodb; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
admin_container_before="$(docker inspect LibreChat-Admin-Panel --format '{{.Id}}')"
admin_image_id_before="$(docker inspect LibreChat-Admin-Panel --format '{{.Image}}')"
config_count_before="$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'db.configs.countDocuments({})' | tail -n 1 | tr -d '[:space:]')"
config_sha_before="$(sha_file "$config_file")"
compose_sha_before="$(sha_file "$compose_override")"

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
  health="$(docker inspect LibreChat-Admin-Panel --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  [[ "$health" = "healthy" ]] && break
  sleep 1
done
test "$(docker inspect LibreChat-Admin-Panel --format '{{.State.Health.Status}}')" = "healthy"
test "$(docker inspect LibreChat-Admin-Panel --format '{{.Image}}')" = "$image_id"

for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done
test "$(sha_file "$config_file")" = "$config_sha_before"
test "$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'db.configs.countDocuments({})' | tail -n 1 | tr -d '[:space:]')" = "$config_count_before"

root_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/)"
api_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/config)"
admin_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://admin.152.32.172.162.sslip.io/)"
office_status="$(curl -ksS -D "$work_dir/office.headers" -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)"
test "$root_status" = "200"
test "$api_status" = "200"
test "$admin_status" = "200"
test "$office_status" = "401"
grep -Fiq 'Office Converter' "$work_dir/office.headers"

admin_container_after="$(docker inspect LibreChat-Admin-Panel --format '{{.Id}}')"
test "$admin_container_after" != "$admin_container_before"

trap - ERR
cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
release_commit=$release_commit
source_tree_sha256=$SOURCE_TREE_SHA256
ci_verified_commit=$CI_VERIFIED_COMMIT
ci_verified_tag=$CI_VERIFIED_TAG
ci_run_reference=$CI_RUN_REFERENCE
image_ref=$IMAGE_REF
image_digest=$IMAGE_DIGEST
image_id=$image_id
backup_dir=$backup_dir
compose_sha_before=$compose_sha_before
compose_sha_after=$(sha_file "$compose_override")
config_sha_unchanged=$config_sha_before
config_count_before=$config_count_before
config_count_after=$config_count_before
admin_container_before=$admin_container_before
admin_container_after=$admin_container_after
admin_image_id_before=$admin_image_id_before
admin_image_id_after=$image_id
protected_containers_unchanged=true
root=$root_status
api_config=$api_status
admin=$admin_status
office=$office_status
EOF
for container in "${!protected_ids[@]}"; do
  key="${container//-/_}"
  printf 'protected_%s=%s\n' "$key" "${protected_ids[$container]}" >>"$stage_dir/DEPLOY_RESULT.txt"
done
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nimage_id=%s\nbackup_dir=%s\n' "$image_id" "$backup_dir"

