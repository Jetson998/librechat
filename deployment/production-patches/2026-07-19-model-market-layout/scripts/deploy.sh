#!/usr/bin/env bash
set -Eeuo pipefail

# release-governance:scoped-deployment
# release-governance:target-lock
stage_dir="${1:-/tmp/librechat-model-market-layout}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
config_file="$root_dir/librechat.yaml"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
source_client="$root_dir/context-safety-ui/702fc0c9988e-20260719002157/client-dist"
source_usage_route="$root_dir/user-model-market/6bfb5be23255-20260718235639/usage-dashboard.js"
release_root="$root_dir/model-market-layout/$release_key-$timestamp"
release_client="$release_root/client-dist"
backup_dir="$root_dir/backups/model-market-layout-$timestamp"
usage_dir="$stage_dir/deployment/production-patches/2026-07-17-user-usage-dashboard"
patch_dir="$stage_dir/deployment/production-patches/2026-07-19-model-market-layout"
work_dir="$(mktemp -d /tmp/librechat-model-market-layout.XXXXXX)"
candidate_client="$work_dir/client-dist"
candidate_override="$work_dir/compose.override.yaml"

expected_override_sha="571e67111fb4bab0d21f6f275895fb9cf60f986d689d6692dad9e3bdc71c7a7e"
expected_index_sha="2e2a6763fc8784ef89c233e0aa49e78ac8c0642825447625858bdc145dc304a2"
expected_old_js_sha="1f03cbd793319a80ea59229889c510fa5801d30cf2b8074ae5c58064812dc115"
expected_old_css_sha="121b1907784ff2214246e2c7ad67933faf01038d480e23ee581f5d2c85d6c3a1"
expected_new_js_sha="cca0ef2448edda6febd90ff0a1d7e70294121a6f33353a33115af2c9d7e1d135"
expected_new_css_sha="94a1ca94a5d2d371c53788f33106137e429e64d198ca41ea8b2cc4d8ae6ce8fd"

cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT
sha_file() { sha256sum "$1" | awk '{print $1}'; }

for path in \
  "$compose_base" "$compose_override" "$env_file" "$config_file" \
  "$source_client/index.html" "$source_client/user-usage-dashboard.js" \
  "$source_client/user-usage-dashboard.css" "$source_usage_route" \
  "$usage_dir/client/user-usage-dashboard.js" \
  "$usage_dir/client/user-usage-dashboard.css" \
  "$usage_dir/scripts/test-client-release.py" "$patch_dir/scripts/test-release.py"; do
  test -f "$path"
done

test "$(sha_file "$compose_override")" = "$expected_override_sha"
test "$(sha_file "$source_client/index.html")" = "$expected_index_sha"
test "$(sha_file "$source_client/user-usage-dashboard.js")" = "$expected_old_js_sha"
test "$(sha_file "$source_client/user-usage-dashboard.css")" = "$expected_old_css_sha"
test "$(sha_file "$usage_dir/client/user-usage-dashboard.js")" = "$expected_new_js_sha"
test "$(sha_file "$usage_dir/client/user-usage-dashboard.css")" = "$expected_new_css_sha"

active_client_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
active_usage_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/api/server/routes/usage-dashboard.js"}}{{.Source}}{{end}}{{end}}')"
test "$active_client_mount" = "$source_client"
test "$active_usage_mount" = "$source_usage_route"

python3 "$usage_dir/scripts/test-client-release.py"
python3 "$patch_dir/scripts/test-release.py"
node --check "$usage_dir/client/user-usage-dashboard.js"

cp -a "$source_client" "$candidate_client"
install -m 0444 "$usage_dir/client/user-usage-dashboard.js" "$candidate_client/user-usage-dashboard.js"
install -m 0444 "$usage_dir/client/user-usage-dashboard.css" "$candidate_client/user-usage-dashboard.css"
python3 - "$candidate_client/index.html" "$release_key" <<'PY'
from pathlib import Path
import re
import sys

path, version = Path(sys.argv[1]), sys.argv[2]
text = path.read_text(encoding="utf-8")
text, css_count = re.subn(r'user-usage-dashboard\.css\?v=[^"\']+', f'user-usage-dashboard.css?v={version}', text, count=1)
text, js_count = re.subn(r'user-usage-dashboard\.js\?v=[^"\']+', f'user-usage-dashboard.js?v={version}', text, count=1)
if css_count != 1 or js_count != 1:
    raise SystemExit("usage dashboard references were not updated exactly once")
path.write_text(text, encoding="utf-8")
PY

grep -Fq "user-usage-dashboard.js?v=$release_key" "$candidate_client/index.html"
grep -Fq "user-usage-dashboard.css?v=$release_key" "$candidate_client/index.html"
test "$(sha_file "$candidate_client/user-usage-dashboard.js")" = "$expected_new_js_sha"
test "$(sha_file "$candidate_client/user-usage-dashboard.css")" = "$expected_new_css_sha"

python3 - "$compose_override" "$candidate_override" "$release_client" <<'PY'
import sys
import yaml

source, destination, release_client = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle)
api = data.setdefault("services", {}).setdefault("api", {})
volumes = api.setdefault("volumes", [])
volumes = [item for item in volumes if not str(item).endswith(":/app/client/dist:ro")]
volumes.append(f"{release_client}:/app/client/dist:ro")
api["volumes"] = volumes
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
test "$(grep -cF ':/app/client/dist:ro' "$candidate_override")" = "1"
grep -Fq "$release_client:/app/client/dist:ro" "$candidate_override"
grep -Fq "$source_usage_route:/app/api/server/routes/usage-dashboard.js:ro" "$candidate_override"

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight_only=ok\nrelease_commit=%s\nsource_client=%s\nsource_usage_route=%s\nnew_js_sha=%s\nnew_css_sha=%s\n' \
    "$release_commit" "$source_client" "$source_usage_route" "$expected_new_js_sha" "$expected_new_css_sha"
  exit 0
fi

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$candidate_client" "$release_client"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"

declare -A protected_ids
for container in LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API LibreChat-Admin-Panel chat-mongodb; do
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
api_id_before="$(docker inspect LibreChat-API --format '{{.Id}}')"
config_sha_before="$(sha_file "$config_file")"
compose_sha_before="$(sha_file "$compose_override")"

applied=0
rollback() {
  set +e
  cp -a "$backup_dir/compose.override.yaml" "$compose_override"
  cd "$root_dir"
  docker compose up -d --no-deps --force-recreate api >/dev/null 2>&1
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
docker compose up -d --no-deps --force-recreate api >/dev/null

for _ in $(seq 1 120); do
  curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null 2>&1 && break
  sleep 1
done

root_status="$(curl -ksS -o "$work_dir/live-index.html" -w '%{http_code}' https://152.32.172.162.sslip.io/)"
api_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/config)"
admin_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://admin.152.32.172.162.sslip.io/)"
office_status="$(curl -ksS -D "$work_dir/office.headers" -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)"
usage_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/user/usage-dashboard)"
curl -ksSf -o "$work_dir/live-usage.js" https://152.32.172.162.sslip.io/user-usage-dashboard.js
curl -ksSf -o "$work_dir/live-usage.css" https://152.32.172.162.sslip.io/user-usage-dashboard.css

test "$root_status" = "200"
test "$api_status" = "200"
test "$admin_status" = "200"
test "$office_status" = "401"
grep -Fiq 'Office Converter' "$work_dir/office.headers"
test "$usage_status" = "401"
grep -Fq "user-usage-dashboard.js?v=$release_key" "$work_dir/live-index.html"
test "$(sha_file "$work_dir/live-usage.js")" = "$expected_new_js_sha"
test "$(sha_file "$work_dir/live-usage.css")" = "$expected_new_css_sha"

active_client_after="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
active_usage_after="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/api/server/routes/usage-dashboard.js"}}{{.Source}}{{end}}{{end}}')"
test "$active_client_after" = "$release_client"
test "$active_usage_after" = "$source_usage_route"
for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done
api_id_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_id_after" != "$api_id_before"
test "$(sha_file "$config_file")" = "$config_sha_before"

trap - ERR
cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
release_commit=$release_commit
release_root=$release_root
backup_dir=$backup_dir
compose_sha_before=$compose_sha_before
compose_sha_after=$(sha_file "$compose_override")
config_sha_unchanged=$config_sha_before
client_mount_before=$source_client
client_mount_after=$release_client
usage_mount_unchanged=$source_usage_route
usage_js_sha=$expected_new_js_sha
usage_css_sha=$expected_new_css_sha
api_container_before=$api_id_before
api_container_after=$api_id_after
protected_containers_unchanged=true
root=$root_status
api_config=$api_status
admin=$admin_status
office=$office_status
usage_dashboard_unauthenticated=$usage_status
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nrelease_root=%s\nbackup_dir=%s\napi_container=%s\n' "$release_root" "$backup_dir" "$api_id_after"

