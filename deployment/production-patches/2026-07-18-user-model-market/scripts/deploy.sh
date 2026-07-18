#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-user-model-market}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
config_file="$root_dir/librechat.yaml"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
source_client="$root_dir/search-favicon-fallback/14b9fc7972f5-20260718230646/client-dist"
source_usage_route="$root_dir/user-usage-cost-detail-availability/de2beeace561-20260718223055/usage-dashboard.js"
release_root="$root_dir/user-model-market/$release_key-$timestamp"
release_client="$release_root/client-dist"
release_usage_route="$release_root/usage-dashboard.js"
backup_dir="$root_dir/backups/user-model-market-$timestamp"
usage_dir="$stage_dir/deployment/production-patches/2026-07-17-user-usage-dashboard"
market_dir="$stage_dir/deployment/production-patches/2026-07-18-user-model-market"
work_dir="$(mktemp -d /tmp/librechat-user-model-market.XXXXXX)"
candidate_client="$work_dir/client-dist"
candidate_override="$work_dir/compose.override.yaml"

expected_override_sha="4f93345987c1913c8379792d54db2dea7a417106cbb978a1bae5269e07f6aa8f"
expected_index_sha="27dd78be6e3862a4297e6a20b12a758513c11ebfcd515d05b550fa32a2903921"
expected_old_usage_route_sha="5bd0bd087aab75799fb429b7da8cbb68b6947856b6fe388aeb86985a94821ba9"
expected_new_usage_route_sha="dfb57eedf861c14a342b0821e7d1fca6f004f3cb7bfa671f24bbb892f37455a8"
expected_new_usage_js_sha="1f03cbd793319a80ea59229889c510fa5801d30cf2b8074ae5c58064812dc115"
expected_new_usage_css_sha="121b1907784ff2214246e2c7ad67933faf01038d480e23ee581f5d2c85d6c3a1"
expected_upload_sha="a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9"
expected_login_sha="aeb91c87012ee37a7c94635f3673f9c4747c39245f2c0242eae4d6a79e860f27"
expected_context_script_sha="b9d40771ae9d679c43bcf03e00a240124643b0187f496ca9771db859b891cb39"
expected_context_style_sha="a2ebfa336df18d54d96a07cae7c17d04091cf384bd413e17554bb456be5e979d"
expected_search_asset="search-favicon-fallback-14b9fc7972f5.js"
expected_search_asset_sha="6dc1974118b843218c9178caccedaf4cd7cba5e1e17574ab883d622f550bdade"
expected_pricing_bundle="$root_dir/model-pricing-dotted-key/406693a-20260718201634/api-index.cjs"
expected_pricing_bundle_sha="b9cac9721e5dcbde30b5d3b1052ba8306e15119255d4b8c53bb330ca8b089b27"
expected_admin_image="librechat-admin-panel-model-pricing-keyfix:1ff1e5728a85"

cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT
sha_file() { sha256sum "$1" | awk '{print $1}'; }

for path in \
  "$compose_base" "$compose_override" "$env_file" "$config_file" \
  "$source_usage_route" "$expected_pricing_bundle" "$source_client/index.html" \
  "$source_client/business-upload-menu.js" "$source_client/odysseia-login.js" \
  "$source_client/context-safety-ui.js" "$source_client/context-safety-ui.css" \
  "$source_client/$expected_search_asset" "$usage_dir/api/usage-dashboard.js" \
  "$usage_dir/client/user-usage-dashboard.js" "$usage_dir/client/user-usage-dashboard.css" \
  "$usage_dir/scripts/test-usage-dashboard.js" "$usage_dir/scripts/test-client-release.py" \
  "$usage_dir/scripts/test-production-aggregation.js" "$market_dir/scripts/test-release.py"; do
  test -f "$path"
done

test "$(sha_file "$compose_override")" = "$expected_override_sha"
test "$(sha_file "$source_client/index.html")" = "$expected_index_sha"
test "$(sha_file "$source_usage_route")" = "$expected_old_usage_route_sha"
test "$(sha_file "$usage_dir/api/usage-dashboard.js")" = "$expected_new_usage_route_sha"
test "$(sha_file "$usage_dir/client/user-usage-dashboard.js")" = "$expected_new_usage_js_sha"
test "$(sha_file "$usage_dir/client/user-usage-dashboard.css")" = "$expected_new_usage_css_sha"
test "$(sha_file "$source_client/business-upload-menu.js")" = "$expected_upload_sha"
test "$(sha_file "$source_client/odysseia-login.js")" = "$expected_login_sha"
test "$(sha_file "$source_client/context-safety-ui.js")" = "$expected_context_script_sha"
test "$(sha_file "$source_client/context-safety-ui.css")" = "$expected_context_style_sha"
test "$(sha_file "$source_client/$expected_search_asset")" = "$expected_search_asset_sha"
test "$(sha_file "$expected_pricing_bundle")" = "$expected_pricing_bundle_sha"
test "$(docker inspect LibreChat-Admin-Panel --format '{{.Config.Image}}')" = "$expected_admin_image"
grep -Fq "$source_usage_route:/app/api/server/routes/usage-dashboard.js:ro" "$compose_override"
grep -Fq "$source_client:/app/client/dist:ro" "$compose_override"
grep -Fq "$expected_pricing_bundle:/app/packages/api/dist/index.cjs:ro" "$compose_override"

active_client_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
active_usage_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/api/server/routes/usage-dashboard.js"}}{{.Source}}{{end}}{{end}}')"
test "$active_client_mount" = "$source_client"
test "$active_usage_mount" = "$source_usage_route"

node "$usage_dir/scripts/test-usage-dashboard.js"
python3 "$usage_dir/scripts/test-client-release.py"
python3 "$market_dir/scripts/test-release.py"
node --check "$usage_dir/api/usage-dashboard.js"
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
    raise SystemExit("usage dashboard asset references were not updated exactly once")
path.write_text(text, encoding="utf-8")
PY

grep -Fq "user-usage-dashboard.js?v=$release_key" "$candidate_client/index.html"
grep -Fq "user-usage-dashboard.css?v=$release_key" "$candidate_client/index.html"
grep -Fq "data-asset=\"/$expected_search_asset\"" "$candidate_client/index.html"
grep -Fq 'business-upload-label-patch' "$candidate_client/index.html"
grep -Fq 'odysseia-login-page-patch' "$candidate_client/index.html"
grep -Fq 'context-safety-ui-9fa04abc07e9.js' "$candidate_client/index.html"
test "$(sha_file "$candidate_client/business-upload-menu.js")" = "$expected_upload_sha"
test "$(sha_file "$candidate_client/odysseia-login.js")" = "$expected_login_sha"
test "$(sha_file "$candidate_client/context-safety-ui.js")" = "$expected_context_script_sha"
test "$(sha_file "$candidate_client/context-safety-ui.css")" = "$expected_context_style_sha"
test "$(sha_file "$candidate_client/$expected_search_asset")" = "$expected_search_asset_sha"
test "$(sha_file "$candidate_client/user-usage-dashboard.js")" = "$expected_new_usage_js_sha"
test "$(sha_file "$candidate_client/user-usage-dashboard.css")" = "$expected_new_usage_css_sha"

python3 - "$compose_override" "$candidate_override" "$release_client" "$release_usage_route" <<'PY'
import sys
import yaml

source, destination, release_client, release_usage_route = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle)
api = data.setdefault("services", {}).setdefault("api", {})
volumes = api.setdefault("volumes", [])
volumes = [
    item for item in volumes
    if not str(item).endswith(":/app/client/dist:ro")
    and not str(item).endswith(":/app/api/server/routes/usage-dashboard.js:ro")
]
volumes.extend([
    f"{release_client}:/app/client/dist:ro",
    f"{release_usage_route}:/app/api/server/routes/usage-dashboard.js:ro",
])
api["volumes"] = volumes
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
grep -Fq "$release_client:/app/client/dist:ro" "$candidate_override"
grep -Fq "$release_usage_route:/app/api/server/routes/usage-dashboard.js:ro" "$candidate_override"
grep -Fq "$expected_pricing_bundle:/app/packages/api/dist/index.cjs:ro" "$candidate_override"
grep -Fq 'USER_USAGE_CURRENCY=USD' "$candidate_override"
grep -Fq 'USER_USAGE_USD_RATE=1' "$candidate_override"

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight_only=ok\nrelease_commit=%s\ncompose_sha=%s\nsource_client=%s\nsource_usage_route=%s\nnew_usage_route_sha=%s\nnew_usage_js_sha=%s\nnew_usage_css_sha=%s\n' \
    "$release_commit" "$expected_override_sha" "$source_client" "$source_usage_route" \
    "$expected_new_usage_route_sha" "$expected_new_usage_js_sha" "$expected_new_usage_css_sha"
  exit 0
fi

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$candidate_client" "$release_client"
install -m 0444 "$usage_dir/api/usage-dashboard.js" "$release_usage_route"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$source_client/index.html" "$backup_dir/client-index.html"

declare -A protected_ids
for container in LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API chat-mongodb LibreChat-Admin-Panel; do
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
api_status="$(curl -ksS -o "$work_dir/live-api-config.json" -w '%{http_code}' https://152.32.172.162.sslip.io/api/config)"
office_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)"
usage_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/user/usage-dashboard)"
curl -ksSf -o "$work_dir/live-usage.js" https://152.32.172.162.sslip.io/user-usage-dashboard.js
curl -ksSf -o "$work_dir/live-usage.css" https://152.32.172.162.sslip.io/user-usage-dashboard.css

test "$root_status" = "200"
test "$api_status" = "200"
test "$office_status" = "401"
test "$usage_status" = "401"
grep -Fq "user-usage-dashboard.js?v=$release_key" "$work_dir/live-index.html"
grep -Fq "data-asset=\"/$expected_search_asset\"" "$work_dir/live-index.html"
grep -Fq 'data-view="market"' "$work_dir/live-usage.js"
grep -Fq 'renderMarket' "$work_dir/live-usage.js"
test "$(sha_file "$work_dir/live-usage.js")" = "$expected_new_usage_js_sha"
test "$(sha_file "$work_dir/live-usage.css")" = "$expected_new_usage_css_sha"
docker exec LibreChat-API node --check /app/api/server/routes/usage-dashboard.js
docker cp "$usage_dir/scripts/test-production-aggregation.js" LibreChat-API:/tmp/test-production-aggregation.js
docker exec LibreChat-API node /tmp/test-production-aggregation.js /app/api/server/routes/usage-dashboard.js

active_client_after="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
active_usage_after="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/api/server/routes/usage-dashboard.js"}}{{.Source}}{{end}}{{end}}')"
test "$active_client_after" = "$release_client"
test "$active_usage_after" = "$release_usage_route"
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
usage_mount_before=$source_usage_route
usage_mount_after=$release_usage_route
usage_route_sha=$expected_new_usage_route_sha
usage_js_sha=$expected_new_usage_js_sha
usage_css_sha=$expected_new_usage_css_sha
api_container_before=$api_id_before
api_container_after=$api_id_after
protected_containers_unchanged=true
root=$root_status
api_config=$api_status
office=$office_status
usage_dashboard_unauthenticated=$usage_status
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nrelease_root=%s\nbackup_dir=%s\napi_container=%s\n' "$release_root" "$backup_dir" "$api_id_after"
