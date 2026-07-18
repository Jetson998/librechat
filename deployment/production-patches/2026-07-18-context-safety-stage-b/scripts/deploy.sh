#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-context-safety-stage-b}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
config_file="$root_dir/librechat.yaml"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
source_client="$root_dir/context-safety-ui/0b87f1bbab06-20260718200800/client-dist"
release_root="$root_dir/context-safety-ui/$release_key-$timestamp"
release_client="$release_root/client-dist"
backup_dir="$root_dir/backups/context-safety-stage-b-$timestamp"
asset_dir="$stage_dir/client"
release_test="$stage_dir/scripts/test-release.py"
work_dir="$(mktemp -d /tmp/librechat-context-safety-stage-b.XXXXXX)"
candidate_client="$work_dir/client-dist"
candidate_override="$work_dir/compose.override.yaml"

expected_override_sha="bf6f0774569d451e446ea6d2e0cd633c177ab585f17374f5f9edabe4ffff0197"
expected_index_sha="0674e373954f61b4a155562c4ccbf6720d547d7d620438c5d293370443a7ee5f"
expected_upload_sha="a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9"
expected_login_sha="aeb91c87012ee37a7c94635f3673f9c4747c39245f2c0242eae4d6a79e860f27"
expected_usage_js_sha="6f76a7379c01d640460bf34864b88554771ca43c18e063239c5d1a294300433f"
expected_usage_css_sha="2817b8722535d3d46c514c8b93c8713abe4852860cc0075e5c07df1b0f4a01ff"
expected_context_script_sha="9a10425cf36171ebe553961c1b725d879327c894e2cc130434789607dfb5fb83"
expected_context_style_sha="a2ebfa336df18d54d96a07cae7c17d04091cf384bd413e17554bb456be5e979d"
expected_pricing_bundle="$root_dir/model-pricing-dotted-key/406693a-20260718201634/api-index.cjs"
expected_pricing_bundle_sha="b9cac9721e5dcbde30b5d3b1052ba8306e15119255d4b8c53bb330ca8b089b27"
expected_admin_image="librechat-admin-panel-model-pricing-keyfix:1ff1e5728a85"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

sha_file() {
  sha256sum "$1" | awk '{print $1}'
}

for path in \
  "$compose_base" "$compose_override" "$env_file" "$config_file" \
  "$expected_pricing_bundle" \
  "$source_client/index.html" "$source_client/business-upload-menu.js" \
  "$source_client/odysseia-login.js" "$source_client/user-usage-dashboard.js" \
  "$source_client/user-usage-dashboard.css" "$source_client/context-safety-ui.js" \
  "$source_client/context-safety-ui.css" "$asset_dir/context-safety-ui.js" \
  "$asset_dir/context-safety-ui.css" "$asset_dir/context-safety-stage-b-smoke.html" \
  "$release_test"; do
  test -f "$path"
done

test "$(sha_file "$compose_override")" = "$expected_override_sha"
test "$(sha_file "$source_client/index.html")" = "$expected_index_sha"
test "$(sha_file "$source_client/business-upload-menu.js")" = "$expected_upload_sha"
test "$(sha_file "$source_client/odysseia-login.js")" = "$expected_login_sha"
test "$(sha_file "$source_client/user-usage-dashboard.js")" = "$expected_usage_js_sha"
test "$(sha_file "$source_client/user-usage-dashboard.css")" = "$expected_usage_css_sha"
test "$(sha_file "$source_client/context-safety-ui.js")" = "$expected_context_script_sha"
test "$(sha_file "$source_client/context-safety-ui.css")" = "$expected_context_style_sha"
test "$(sha_file "$expected_pricing_bundle")" = "$expected_pricing_bundle_sha"
test "$(docker inspect LibreChat-Admin-Panel --format '{{.Config.Image}}')" = "$expected_admin_image"
grep -Fq \
  "$expected_pricing_bundle:/app/packages/api/dist/index.cjs:ro" \
  "$compose_override"

active_client_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
test "$active_client_mount" = "$source_client"

python3 "$release_test"

cp -a "$source_client" "$candidate_client"
install -m 0444 "$asset_dir/context-safety-ui.js" "$candidate_client/context-safety-ui.js"
install -m 0444 "$asset_dir/context-safety-ui.css" "$candidate_client/context-safety-ui.css"
install -m 0444 \
  "$asset_dir/context-safety-stage-b-smoke.html" \
  "$candidate_client/context-safety-stage-b-smoke.html"

python3 - "$candidate_client/index.html" "$release_key" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
version = sys.argv[2]
text = path.read_text(encoding="utf-8")
style_marker = 'id="context-safety-stage-b-style"'
script_marker = 'id="context-safety-stage-b"'
style = (
    f'<link id="context-safety-stage-b-style" rel="stylesheet" '
    f'href="/context-safety-ui.css?v={version}">'
)
script = (
    f'<script id="context-safety-stage-b" defer '
    f'src="/context-safety-ui.js?v={version}"></script>'
)
style_count = text.count(style_marker)
script_count = text.count(script_marker)
if style_count == 0 and script_count == 0:
    if text.count("</head>") != 1 or text.count("</body>") != 1:
        raise SystemExit("unexpected index.html structure")
    text = text.replace("</head>", f"{style}</head>", 1)
    text = text.replace("</body>", f"{script}</body>", 1)
elif style_count == 1 and script_count == 1:
    text, css_count = re.subn(
        r'context-safety-ui\.css\?v=[^"\']+',
        f'context-safety-ui.css?v={version}',
        text,
    )
    text, js_count = re.subn(
        r'context-safety-ui\.js\?v=[^"\']+',
        f'context-safety-ui.js?v={version}',
        text,
    )
    if css_count != 1 or js_count != 1:
        raise SystemExit(f"unexpected Stage B references: css={css_count} js={js_count}")
else:
    raise SystemExit(
        f"mismatched Stage B markers: style={style_count} script={script_count}"
    )
path.write_text(text, encoding="utf-8")
PY

test "$(grep -cF 'id="context-safety-stage-b-style"' "$candidate_client/index.html")" = "1"
test "$(grep -cF 'id="context-safety-stage-b"' "$candidate_client/index.html")" = "1"
grep -Fq "context-safety-ui.css?v=$release_key" "$candidate_client/index.html"
grep -Fq "context-safety-ui.js?v=$release_key" "$candidate_client/index.html"
grep -Fq 'business-upload-label-patch' "$candidate_client/index.html"
grep -Fq 'odysseia-login-page-patch' "$candidate_client/index.html"
grep -Fq 'user-usage-dashboard.js' "$candidate_client/index.html"
grep -Fq './assets/index.P3glMaNP.js' "$candidate_client/index.html"
test "$(sha_file "$candidate_client/business-upload-menu.js")" = "$expected_upload_sha"
test "$(sha_file "$candidate_client/odysseia-login.js")" = "$expected_login_sha"
test "$(sha_file "$candidate_client/user-usage-dashboard.js")" = "$expected_usage_js_sha"
test "$(sha_file "$candidate_client/user-usage-dashboard.css")" = "$expected_usage_css_sha"

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
grep -Fq 'USER_USAGE_CURRENCY=USD' "$candidate_override"
grep -Fq 'USER_USAGE_USD_RATE=1' "$candidate_override"
grep -Fq \
  "$expected_pricing_bundle:/app/packages/api/dist/index.cjs:ro" \
  "$candidate_override"

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  cat <<EOF
release_commit=$release_commit
preflight_only=ok
compose_override_sha=$expected_override_sha
source_client=$source_client
source_index_sha=$expected_index_sha
candidate_index_sha=$(sha_file "$candidate_client/index.html")
context_script_sha=$(sha_file "$candidate_client/context-safety-ui.js")
context_style_sha=$(sha_file "$candidate_client/context-safety-ui.css")
protected_client_assets=ok
pricing_bundle_sha=$expected_pricing_bundle_sha
admin_image=$expected_admin_image
EOF
  exit 0
fi

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$candidate_client" "$release_client"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$source_client/index.html" "$backup_dir/client-index.html"

declare -A protected_ids
for container in \
  LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API chat-mongodb LibreChat-Admin-Panel; do
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
  if [[ "$applied" = "1" ]]; then
    rollback
  fi
  exit "$rc"
}
trap on_error ERR

install -m 0644 "$candidate_override" "$compose_override.next-$timestamp"
mv "$compose_override.next-$timestamp" "$compose_override"
applied=1
cd "$root_dir"
docker compose up -d --no-deps --force-recreate api >/dev/null

for _ in $(seq 1 120); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

root_status="$(curl -ksS -o "$work_dir/live-index.html" -w '%{http_code}' https://152.32.172.162.sslip.io/)"
api_status="$(curl -ksS -o "$work_dir/live-api-config.json" -w '%{http_code}' https://152.32.172.162.sslip.io/api/config)"
office_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)"
usage_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/user/usage-dashboard)"
smoke_status="$(curl -ksS -o "$work_dir/live-smoke.html" -w '%{http_code}' "https://152.32.172.162.sslip.io/context-safety-stage-b-smoke.html?level=70")"
curl -ksSf -o "$work_dir/live-context-safety-ui.js" https://152.32.172.162.sslip.io/context-safety-ui.js
curl -ksSf -o "$work_dir/live-context-safety-ui.css" https://152.32.172.162.sslip.io/context-safety-ui.css
curl -ksSf -o "$work_dir/live-upload.js" https://152.32.172.162.sslip.io/business-upload-menu.js
curl -ksSf -o "$work_dir/live-login.js" https://152.32.172.162.sslip.io/odysseia-login.js
curl -ksSf -o "$work_dir/live-usage.js" https://152.32.172.162.sslip.io/user-usage-dashboard.js
curl -ksSf -o "$work_dir/live-usage.css" https://152.32.172.162.sslip.io/user-usage-dashboard.css

test "$root_status" = "200"
test "$api_status" = "200"
test "$office_status" = "401"
test "$usage_status" = "401"
test "$smoke_status" = "200"
grep -Fq "context-safety-ui.js?v=$release_key" "$work_dir/live-index.html"
grep -Fq "context-safety-ui.css?v=$release_key" "$work_dir/live-index.html"
grep -Fq 'business-upload-label-patch' "$work_dir/live-index.html"
grep -Fq 'odysseia-login-page-patch' "$work_dir/live-index.html"
grep -Fq 'user-usage-dashboard.js' "$work_dir/live-index.html"
grep -Fq 'context-safety-stage-b' "$work_dir/live-smoke.html"
grep -Fq '__contextSafetyUIContract' "$work_dir/live-context-safety-ui.js"
grep -Fq '#context-safety-ui-banner' "$work_dir/live-context-safety-ui.css"
test "$(sha_file "$work_dir/live-upload.js")" = "$expected_upload_sha"
test "$(sha_file "$work_dir/live-login.js")" = "$expected_login_sha"
test "$(sha_file "$work_dir/live-usage.js")" = "$expected_usage_js_sha"
test "$(sha_file "$work_dir/live-usage.css")" = "$expected_usage_css_sha"

active_client_after="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
test "$active_client_after" = "$release_client"
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
client_index_before=$expected_index_sha
client_index_after=$(sha_file "$release_client/index.html")
context_script_sha=$(sha_file "$release_client/context-safety-ui.js")
context_style_sha=$(sha_file "$release_client/context-safety-ui.css")
api_container_before=$api_id_before
api_container_after=$api_id_after
protected_containers_unchanged=true
protected_client_assets_unchanged=true
root=$root_status
api_config=$api_status
office=$office_status
usage_dashboard_unauthenticated=$usage_status
smoke_fixture=$smoke_status
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"

printf 'deployment=ok\n'
printf 'backup_dir=%s\n' "$backup_dir"
printf 'release_root=%s\n' "$release_root"
printf 'api_container=%s\n' "$api_id_after"
