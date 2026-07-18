#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-user-usage-charts}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
source_client="$root_dir/user-usage-dashboard/65ac5e4d0eb0-20260718135751/client-dist"
release_root="$root_dir/user-usage-dashboard/$release_key-charts-$timestamp"
release_client="$release_root/client-dist"
backup_dir="$root_dir/backups/user-usage-charts-$timestamp"
asset_dir="$stage_dir/deployment/production-patches/2026-07-17-user-usage-dashboard/client"
test_dir="$stage_dir/deployment/production-patches/2026-07-17-user-usage-dashboard/scripts"
release_test="$stage_dir/deployment/production-patches/2026-07-18-user-usage-charts/scripts/test-release.py"

expected_override_sha="af8367633ecd58e8dff78ad41d90956bbac405ba3b7d85db152148644eaeb33f"
expected_index_sha="991ff14417593776b0a7ff20a9787bdec182334fcc48a7514c89ddade00f8c02"
expected_script_sha="cc2eb9236008d3cac8230c0ef14078d5f349facf4b2c2bece46a09183f49de90"
expected_style_sha="8ff5fd66975f086850b0b1f8fbef610aadaaad5cc131d8f99f8b8e56f2dcb4e7"

for path in \
  "$compose_base" "$compose_override" "$env_file" \
  "$source_client/index.html" "$source_client/user-usage-dashboard.js" \
  "$source_client/user-usage-dashboard.css" "$asset_dir/user-usage-dashboard.js" \
  "$asset_dir/user-usage-dashboard.css" "$test_dir/test-client-release.py" "$release_test"; do
  test -f "$path"
done

test "$(sha256sum "$compose_override" | awk '{print $1}')" = "$expected_override_sha"
test "$(sha256sum "$source_client/index.html" | awk '{print $1}')" = "$expected_index_sha"
test "$(sha256sum "$source_client/user-usage-dashboard.js" | awk '{print $1}')" = "$expected_script_sha"
test "$(sha256sum "$source_client/user-usage-dashboard.css" | awk '{print $1}')" = "$expected_style_sha"
grep -Fq 'USER_USAGE_CURRENCY=USD' "$compose_override"
grep -Fq 'USER_USAGE_USD_RATE=1' "$compose_override"
! grep -Fq 'USER_USAGE_USD_TO_CNY' "$compose_override"

node --check "$asset_dir/user-usage-dashboard.js"
python3 "$test_dir/test-client-release.py"
python3 "$release_test"

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$source_client" "$release_client"
install -m 0444 "$asset_dir/user-usage-dashboard.js" "$release_client/user-usage-dashboard.js"
install -m 0444 "$asset_dir/user-usage-dashboard.css" "$release_client/user-usage-dashboard.css"

python3 - "$release_client/index.html" "$release_key" <<'PY'
from pathlib import Path
import re
import sys

path, version = Path(sys.argv[1]), sys.argv[2]
text = path.read_text(encoding="utf-8")
text, css_count = re.subn(r'user-usage-dashboard\.css\?v=[^"\']+', f'user-usage-dashboard.css?v={version}', text)
text, js_count = re.subn(r'user-usage-dashboard\.js\?v=[^"\']+', f'user-usage-dashboard.js?v={version}', text)
if css_count != 1 or js_count != 1:
    raise SystemExit(f"unexpected usage asset references: css={css_count} js={js_count}")
path.write_text(text, encoding="utf-8")
PY

candidate_override="$stage_dir/compose.override.candidate.yaml"
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
grep -Fq "user-usage-dashboard.js?v=$release_key" "$release_client/index.html"
grep -Fq 'lc-usage-axis-label' "$release_client/user-usage-dashboard.js"
grep -Fq 'lc-usage-model-chart' "$release_client/user-usage-dashboard.js"

declare -A protected_ids
for container in LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API chat-mongodb LibreChat-Admin-Panel; do
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
api_id_before="$(docker inspect LibreChat-API --format '{{.Id}}')"

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
curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/user/usage-dashboard)" = "401"
curl -ksSf -o "$stage_dir/live-index.html" https://152.32.172.162.sslip.io/
curl -ksSf -o "$stage_dir/live-user-usage-dashboard.js" https://152.32.172.162.sslip.io/user-usage-dashboard.js
curl -ksSf -o "$stage_dir/live-user-usage-dashboard.css" https://152.32.172.162.sslip.io/user-usage-dashboard.css
grep -Fq "user-usage-dashboard.js?v=$release_key" "$stage_dir/live-index.html"
grep -Fq 'lc-usage-model-chart' "$stage_dir/live-user-usage-dashboard.js"
grep -Fq 'lc-usage-chart-tooltip' "$stage_dir/live-user-usage-dashboard.css"

for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done
api_id_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_id_after" != "$api_id_before"

trap - ERR
cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
release_commit=$release_commit
release_root=$release_root
backup_dir=$backup_dir
compose_sha=$(sha256sum "$compose_override" | awk '{print $1}')
client_index_sha=$(sha256sum "$release_client/index.html" | awk '{print $1}')
client_script_sha=$(sha256sum "$release_client/user-usage-dashboard.js" | awk '{print $1}')
client_style_sha=$(sha256sum "$release_client/user-usage-dashboard.css" | awk '{print $1}')
api_container_before=$api_id_before
api_container_after=$api_id_after
protected_containers_unchanged=true
currency=USD
unauthenticated_endpoint_status=401
api_config_health=ok
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nbackup_dir=%s\nrelease_root=%s\napi_container=%s\n' "$backup_dir" "$release_root" "$api_id_after"
