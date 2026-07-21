#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:?stage directory is required}"
source_revision="${2:?source revision is required}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
timestamp="$(date +%Y%m%d%H%M%S)"
release_dir="$root_dir/generated-files-tab/${source_revision:0:12}-$timestamp"
release_client="$release_dir/client-dist"
backup_dir="$root_dir/backups/generated-files-tab-$timestamp"
work_dir="$(mktemp -d /tmp/librechat-generated-files-tab.XXXXXX)"
candidate_client="$work_dir/client-dist"
candidate_override="$work_dir/compose.override.yaml"

generated_route_src="$stage_dir/generated-files.js"
user_route_src="$stage_dir/user.js"
client_script_src="$stage_dir/generated-files-tab.js"
client_style_src="$stage_dir/generated-files-tab.css"

expected_index_sha="f588713111cf44cc94621e6a7ed6d89769b6c793f794040e3bc68aa78a9ac368"
expected_user_route_sha="459cce4df99363a2031e2b4240c2bafd798506c2b008c695c6919245e4359208"

cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT
sha_file() { sha256sum "$1" | awk '{print $1}'; }
mount_source() {
  local destination="$1"
  docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "'"$destination"'"}}{{.Source}}{{end}}{{end}}'
}

for file in \
  "$compose_base" "$compose_override" "$env_file" \
  "$generated_route_src" "$user_route_src" "$client_script_src" "$client_style_src"; do
  test -f "$file"
done

node --check "$generated_route_src"
node --check "$user_route_src"
node --check "$client_script_src"

source_client="$(mount_source /app/client/dist)"
source_user_route="$(mount_source /app/api/server/routes/user.js)"
source_usage_route="$(mount_source /app/api/server/routes/usage-dashboard.js)"
test -d "$source_client"
test -f "$source_client/index.html"
test -f "$source_user_route"
test -f "$source_usage_route"
test "$(sha_file "$source_client/index.html")" = "$expected_index_sha"
test "$(sha_file "$source_user_route")" = "$expected_user_route_sha"
grep -Fq 'user-usage-dashboard.js?v=1d6bad93acc5' "$source_client/index.html"
grep -Fq 'business-upload-label-patch' "$source_client/index.html"
grep -Fq 'context-safety-stage-b' "$source_client/index.html"
! grep -Fq 'generated-files-tab.js' "$source_client/index.html"

cp -a "$source_client" "$candidate_client"
install -m 0444 "$client_script_src" "$candidate_client/generated-files-tab.js"
install -m 0444 "$client_style_src" "$candidate_client/generated-files-tab.css"
python3 - "$candidate_client/index.html" "$source_revision" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
version = sys.argv[2][:12]
text = path.read_text(encoding="utf-8")
if "generated-files-tab.js" in text or "generated-files-tab.css" in text:
    raise SystemExit("generated files assets are already present")
text = text.replace(
    "</head>",
    f'<link rel="stylesheet" href="/generated-files-tab.css?v={version}"></head>',
    1,
)
text = text.replace(
    "</body>",
    f'<script id="generated-files-tab" src="/generated-files-tab.js?v={version}"></script></body>',
    1,
)
path.write_text(text, encoding="utf-8")
PY

mkdir -p "$release_dir"
install -m 0444 "$generated_route_src" "$release_dir/generated-files.js"
install -m 0444 "$user_route_src" "$release_dir/user.js"
cp -a "$candidate_client" "$release_client"

python3 - "$compose_override" "$candidate_override" "$release_dir" "$release_client" <<'PY'
import sys
import yaml

source, destination, release_dir, release_client = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle) or {}
api = data.setdefault("services", {}).setdefault("api", {})
volumes = api.setdefault("volumes", [])
managed = {
    "/app/client/dist",
    "/app/api/server/routes/user.js",
    "/app/api/server/routes/generated-files.js",
}

def target(item):
    if isinstance(item, str):
        parts = item.split(":")
        return parts[1] if len(parts) > 1 else ""
    if isinstance(item, dict):
        return item.get("target", "")
    return ""

volumes = [item for item in volumes if target(item) not in managed]
volumes.extend([
    f"{release_client}:/app/client/dist:ro",
    f"{release_dir}/user.js:/app/api/server/routes/user.js:ro",
    f"{release_dir}/generated-files.js:/app/api/server/routes/generated-files.js:ro",
])
api["volumes"] = volumes
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
grep -Fq "$release_client:/app/client/dist:ro" "$candidate_override"
grep -Fq "$release_dir/user.js:/app/api/server/routes/user.js:ro" "$candidate_override"
grep -Fq "$release_dir/generated-files.js:/app/api/server/routes/generated-files.js:ro" "$candidate_override"
grep -Fq "$source_usage_route:/app/api/server/routes/usage-dashboard.js:ro" "$candidate_override"
grep -Fq "generated-files-tab.js?v=${source_revision:0:12}" "$candidate_client/index.html"
grep -Fq "generated-files-tab.css?v=${source_revision:0:12}" "$candidate_client/index.html"

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"

declare -A protected_ids
for container in LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API LibreChat-Admin-Panel chat-mongodb; do
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
api_id_before="$(docker inspect LibreChat-API --format '{{.Id}}')"
config_sha_before="$(sha_file "$root_dir/librechat.yaml")"
compose_sha_before="$(sha_file "$compose_override")"

applied=0
rollback() {
  set +e
  cp -a "$backup_dir/compose.override.yaml" "$compose_override"
  cd "$root_dir"
  docker compose --env-file "$env_file" -f "$compose_base" -f "$compose_override" \
    up -d --no-deps --force-recreate api >/dev/null 2>&1
}
on_error() {
  local rc=$?
  trap - ERR
  [[ "$applied" = "1" ]] && rollback
  exit "$rc"
}
trap on_error ERR

install -m 0644 "$candidate_override" "$compose_override.next-$timestamp"
mv "$compose_override.next-$timestamp" "$compose_override"
applied=1
cd "$root_dir"
docker compose --env-file "$env_file" -f "$compose_base" -f "$compose_override" \
  up -d --no-deps --force-recreate api >/dev/null

ready=0
for _ in $(seq 1 120); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = "1"

root_status="$(curl -ksS -o "$work_dir/live-index.html" -w '%{http_code}' https://152.32.172.162.sslip.io/)"
config_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/config)"
admin_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://admin.152.32.172.162.sslip.io/)"
office_status="$(curl -ksS -D "$work_dir/office.headers" -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)"
generated_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/user/generated-files)"
usage_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/user/usage-dashboard)"
curl -ksSf -o "$work_dir/live-generated.js" https://152.32.172.162.sslip.io/generated-files-tab.js
curl -ksSf -o "$work_dir/live-generated.css" https://152.32.172.162.sslip.io/generated-files-tab.css

test "$root_status" = "200"
test "$config_status" = "200"
test "$admin_status" = "200"
test "$office_status" = "401"
grep -Fiq 'Office Converter' "$work_dir/office.headers"
test "$generated_status" = "401"
test "$usage_status" = "401"
grep -Fq "generated-files-tab.js?v=${source_revision:0:12}" "$work_dir/live-index.html"
test "$(sha_file "$work_dir/live-generated.js")" = "$(sha_file "$client_script_src")"
test "$(sha_file "$work_dir/live-generated.css")" = "$(sha_file "$client_style_src")"

docker exec LibreChat-API node --check /app/api/server/routes/generated-files.js
docker exec LibreChat-API node --check /app/api/server/routes/user.js
test "$(mount_source /app/client/dist)" = "$release_client"
test "$(mount_source /app/api/server/routes/user.js)" = "$release_dir/user.js"
test "$(mount_source /app/api/server/routes/generated-files.js)" = "$release_dir/generated-files.js"
test "$(mount_source /app/api/server/routes/usage-dashboard.js)" = "$source_usage_route"
for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done
api_id_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_id_after" != "$api_id_before"
test "$(sha_file "$root_dir/librechat.yaml")" = "$config_sha_before"

trap - ERR
cat >"$release_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
release_revision=$source_revision
release_dir=$release_dir
backup_dir=$backup_dir
compose_sha_before=$compose_sha_before
compose_sha_after=$(sha_file "$compose_override")
client_mount_before=$source_client
client_mount_after=$release_client
usage_mount_unchanged=$source_usage_route
api_container_before=$api_id_before
api_container_after=$api_id_after
protected_containers_unchanged=true
root=$root_status
api_config=$config_status
admin=$admin_status
office=$office_status
generated_files_unauthenticated=$generated_status
usage_dashboard_unauthenticated=$usage_status
EOF
cp "$release_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
cat "$release_dir/DEPLOY_RESULT.txt"
