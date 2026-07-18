#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-user-usage-usd-symbol}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
source_client="$root_dir/user-usage-cutover-cost-detail/57ed9f9-20260718212527/client-dist"
release_root="$root_dir/user-usage-usd-symbol/$release_key-$timestamp"
release_client="$release_root/client-dist"
backup_dir="$root_dir/backups/user-usage-usd-symbol-$timestamp"
patch_root="$stage_dir/deployment/production-patches"
client_patch="$patch_root/2026-07-17-user-usage-dashboard/client/user-usage-dashboard.js"
release_patch="$patch_root/2026-07-18-user-usage-usd-symbol"

expected_override_sha="db0e88bb22f0b2afd0c76d0f8bd9c690c9866c7365e3b7d49c1a37f6ca772b89"
expected_index_sha="f9571d1488a18b6c3385fa73e0d82cfa3ec5ff728d9c5275aae6ae7602056a05"
expected_client_sha="b1995985ec7539a3879765785b056ac697f4315bc070452193aa686f5019ca2f"
expected_style_sha="724094199fa29f77799331988748b8eef8d88c135b35abf5bea5f2c19a1a494b"

for path in \
  "$compose_base" "$compose_override" "$env_file" "$source_client/index.html" \
  "$source_client/user-usage-dashboard.js" "$source_client/user-usage-dashboard.css" \
  "$client_patch" "$release_patch/scripts/test-release.py"; do
  test -f "$path"
done

test "$(sha256sum "$compose_override" | awk '{print $1}')" = "$expected_override_sha"
test "$(sha256sum "$source_client/index.html" | awk '{print $1}')" = "$expected_index_sha"
test "$(sha256sum "$source_client/user-usage-dashboard.js" | awk '{print $1}')" = "$expected_client_sha"
test "$(sha256sum "$source_client/user-usage-dashboard.css" | awk '{print $1}')" = "$expected_style_sha"

node --check "$client_patch"
python3 "$release_patch/scripts/test-release.py"

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$source_client" "$release_client"
install -m 0444 "$client_patch" "$release_client/user-usage-dashboard.js"

python3 - "$release_client/index.html" "$release_key" <<'PY'
from pathlib import Path
import re
import sys

path, version = Path(sys.argv[1]), sys.argv[2]
text = path.read_text(encoding="utf-8")
text, count = re.subn(
    r'user-usage-dashboard\.js\?v=[^"\']+',
    f'user-usage-dashboard.js?v={version}',
    text,
)
if count != 1:
    raise SystemExit(f"unexpected usage script references: {count}")
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
grep -Fq "user-usage-dashboard.js?v=$release_key" "$release_client/index.html"
test "$(grep -c "currencyDisplay: 'narrowSymbol'" "$release_client/user-usage-dashboard.js")" = "2"

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
grep -Fq "user-usage-dashboard.js?v=$release_key" "$stage_dir/live-index.html"
test "$(grep -c "currencyDisplay: 'narrowSymbol'" "$stage_dir/live-user-usage-dashboard.js")" = "2"

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
currency_display=narrowSymbol
unauthenticated_endpoint_status=401
api_config_health=ok
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nbackup_dir=%s\nrelease_root=%s\napi_container=%s\n' \
  "$backup_dir" "$release_root" "$api_id_after"
