#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-user-usage-cost-detail-availability}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
source_client="$root_dir/user-usage-usd-symbol/0b57393fab4b-20260718214145/client-dist"
source_usage="$root_dir/user-usage-cutover-cost-detail/57ed9f9-20260718212527/usage-dashboard.js"
release_root="$root_dir/user-usage-cost-detail-availability/$release_key-$timestamp"
release_client="$release_root/client-dist"
release_usage="$release_root/usage-dashboard.js"
backup_dir="$root_dir/backups/user-usage-cost-detail-availability-$timestamp"
patch_root="$stage_dir/deployment/production-patches"
usage_patch="$patch_root/2026-07-17-user-usage-dashboard"
release_patch="$patch_root/2026-07-18-user-usage-cost-detail-availability"

expected_override_sha="cd6002ddc8893f25a6337dc823c9a9978f928aa5652f7e16ca28ac4d4e8fa6d2"
expected_index_sha="488e92e83bd289e709ae746e766c28af9c176406a4d93d0a8d6d1c7958fea76e"
expected_client_sha="aba651fe592a0059296fa8f5d679c0eeb693424def58a304c53037fd686248da"
expected_style_sha="724094199fa29f77799331988748b8eef8d88c135b35abf5bea5f2c19a1a494b"
expected_usage_sha="6d51f0f488790bc117a2ae33a61c0a23a296ee1dbc5a7352e84fa7d09d35e187"

for path in \
  "$compose_base" "$compose_override" "$env_file" "$source_client/index.html" \
  "$source_client/user-usage-dashboard.js" "$source_client/user-usage-dashboard.css" \
  "$source_usage" "$usage_patch/api/usage-dashboard.js" \
  "$usage_patch/client/user-usage-dashboard.js" "$usage_patch/scripts/test-usage-dashboard.js" \
  "$usage_patch/scripts/test-client-release.py" "$usage_patch/scripts/test-production-aggregation.js" \
  "$release_patch/scripts/test-release.py"; do
  test -f "$path"
done

test "$(sha256sum "$compose_override" | awk '{print $1}')" = "$expected_override_sha"
test "$(sha256sum "$source_client/index.html" | awk '{print $1}')" = "$expected_index_sha"
test "$(sha256sum "$source_client/user-usage-dashboard.js" | awk '{print $1}')" = "$expected_client_sha"
test "$(sha256sum "$source_client/user-usage-dashboard.css" | awk '{print $1}')" = "$expected_style_sha"
test "$(sha256sum "$source_usage" | awk '{print $1}')" = "$expected_usage_sha"

node --check "$usage_patch/api/usage-dashboard.js"
node --check "$usage_patch/client/user-usage-dashboard.js"
node "$usage_patch/scripts/test-usage-dashboard.js"
python3 "$usage_patch/scripts/test-client-release.py"
python3 "$release_patch/scripts/test-release.py"

docker cp "$usage_patch/api/usage-dashboard.js" LibreChat-API:/tmp/lc-cost-detail-candidate.js
docker cp "$usage_patch/scripts/test-production-aggregation.js" LibreChat-API:/tmp/lc-cost-detail-production-test.js
docker exec LibreChat-API node /tmp/lc-cost-detail-production-test.js /tmp/lc-cost-detail-candidate.js

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$source_client" "$release_client"
install -m 0444 "$usage_patch/client/user-usage-dashboard.js" "$release_client/user-usage-dashboard.js"
install -m 0444 "$usage_patch/api/usage-dashboard.js" "$release_usage"

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
python3 - "$compose_override" "$candidate_override" "$release_client" "$release_usage" <<'PY'
import sys
import yaml

source, destination, release_client, release_usage = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle)
api = data.setdefault("services", {}).setdefault("api", {})
volumes = api.setdefault("volumes", [])
managed_targets = (":/app/client/dist:ro", ":/app/api/server/routes/usage-dashboard.js:ro")
volumes = [item for item in volumes if not str(item).endswith(managed_targets)]
volumes.extend([
    f"{release_client}:/app/client/dist:ro",
    f"{release_usage}:/app/api/server/routes/usage-dashboard.js:ro",
])
api["volumes"] = volumes
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
test "$(grep -cF ':/app/client/dist:ro' "$candidate_override")" = "1"
test "$(grep -cF ':/app/api/server/routes/usage-dashboard.js:ro' "$candidate_override")" = "1"
grep -Fq "user-usage-dashboard.js?v=$release_key" "$release_client/index.html"
grep -Fq 'pricingMatches' "$release_usage"
grep -Fq '.filter(([key]) => row.costBreakdown[key])' "$release_client/user-usage-dashboard.js"

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
grep -Fq '.filter(([key]) => row.costBreakdown[key])' "$stage_dir/live-user-usage-dashboard.js"
docker cp "$usage_patch/scripts/test-production-aggregation.js" LibreChat-API:/tmp/lc-cost-detail-production-test.js
docker exec LibreChat-API node /tmp/lc-cost-detail-production-test.js /app/api/server/routes/usage-dashboard.js

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
usage_route_sha=$(sha256sum "$release_usage" | awk '{print $1}')
client_index_sha=$(sha256sum "$release_client/index.html" | awk '{print $1}')
client_script_sha=$(sha256sum "$release_client/user-usage-dashboard.js" | awk '{print $1}')
client_style_sha=$(sha256sum "$release_client/user-usage-dashboard.css" | awk '{print $1}')
api_container_before=$api_id_before
api_container_after=$api_id_after
protected_containers_unchanged=true
unauthenticated_endpoint_status=401
api_config_health=ok
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nbackup_dir=%s\nrelease_root=%s\napi_container=%s\n' \
  "$backup_dir" "$release_root" "$api_id_after"
