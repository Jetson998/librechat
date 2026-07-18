#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-user-usage-cutover-cost-detail}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
source_client="$root_dir/context-safety-ui/9fa04abc07e9-20260718210529/client-dist"
source_usage="$root_dir/user-usage-breakdown/fe30975-20260718205221/usage-dashboard.js"
release_root="$root_dir/user-usage-cutover-cost-detail/$release_key-$timestamp"
release_client="$release_root/client-dist"
release_usage="$release_root/usage-dashboard.js"
backup_dir="$root_dir/backups/user-usage-cutover-cost-detail-$timestamp"
usage_stage="$stage_dir/deployment/production-patches/2026-07-17-user-usage-dashboard"
release_stage="$stage_dir/deployment/production-patches/2026-07-18-user-usage-cutover-cost-detail"
cutoff="2026-07-18T12:23:34.480Z"
cutoff_models="gpt-5.6-sol,claude-fable-5"

expected_override_sha="bd122f277f134fe329eeeb555a9f970603676a2c8037b1ea7e524afaadc4307b"
expected_usage_sha="1f040de3da50029439b7b50ee7e17e81a4237b9495c70b1b2846537f02ac1f93"
expected_user_sha="6a535ba377dace4e81e3f5b3913704884adb21586c1088d102cf22e53e949280"
expected_index_sha="b238c4db3ebb81059c309d0d0d52e8568719b39e892a001d42a750ba47817a4f"
expected_client_js_sha="2f0dabe376555f660e9e42fca7c4623ef7a74f8ef4bac1930d86f848350f2e9f"
expected_client_css_sha="e6ebd476540e353751e300b6b1b9c96f2448008253d682488ba3aa3753e81dbb"

for path in \
  "$compose_base" "$compose_override" "$env_file" "$source_usage" \
  "$source_client/index.html" "$source_client/user-usage-dashboard.js" \
  "$source_client/user-usage-dashboard.css" "$usage_stage/api/usage-dashboard.js" \
  "$usage_stage/client/user-usage-dashboard.js" "$usage_stage/client/user-usage-dashboard.css" \
  "$usage_stage/scripts/test-usage-dashboard.js" "$usage_stage/scripts/test-client-release.py" \
  "$usage_stage/scripts/test-production-aggregation.js" "$release_stage/scripts/test-release.py"; do
  test -f "$path"
done

test "$(sha256sum "$compose_override" | awk '{print $1}')" = "$expected_override_sha"
test "$(sha256sum "$source_usage" | awk '{print $1}')" = "$expected_usage_sha"
test "$(docker exec LibreChat-API sha256sum /app/api/server/routes/user.js | awk '{print $1}')" = "$expected_user_sha"
test "$(sha256sum "$source_client/index.html" | awk '{print $1}')" = "$expected_index_sha"
test "$(sha256sum "$source_client/user-usage-dashboard.js" | awk '{print $1}')" = "$expected_client_js_sha"
test "$(sha256sum "$source_client/user-usage-dashboard.css" | awk '{print $1}')" = "$expected_client_css_sha"
grep -Fq 'USER_USAGE_CURRENCY=USD' "$compose_override"
grep -Fq 'USER_USAGE_USD_RATE=1' "$compose_override"

docker exec chat-mongodb mongosh --quiet LibreChat --eval '
const d=db.configs.findOne({principalType:"role",principalId:"__base__",isActive:true});
const c=d?.overrides?.endpoints?.custom??[];
const g=c.find(e=>e?.name==="MuskAPI")?.tokenConfig?.["gpt-5.6-sol"];
const f=c.find(e=>e?.name==="MuskAPI-Anthropic")?.tokenConfig?.["claude-fable-5"];
if(g?.prompt!==0.6||g?.completion!==3.6||g?.cacheRead!==0.06||g?.cacheWrite!==0.75)throw new Error("GPT pricing drift");
if(f?.prompt!==2.4||f?.completion!==12||f?.cacheRead!==0.24||f?.cacheWrite!==3)throw new Error("Fable pricing drift");
print("pricing_config=ok");'

node --check "$usage_stage/api/usage-dashboard.js"
node --check "$usage_stage/client/user-usage-dashboard.js"
node "$usage_stage/scripts/test-usage-dashboard.js"
python3 "$usage_stage/scripts/test-client-release.py"
python3 "$release_stage/scripts/test-release.py"

docker cp "$usage_stage/api/usage-dashboard.js" LibreChat-API:/tmp/lc-usage-cutover-candidate.js
docker cp "$usage_stage/scripts/test-production-aggregation.js" LibreChat-API:/tmp/lc-usage-cutover-production-test.js
docker exec \
  -e USER_USAGE_PRICING_CUTOFF="$cutoff" \
  -e USER_USAGE_PRICING_CUTOFF_MODELS="$cutoff_models" \
  LibreChat-API node /tmp/lc-usage-cutover-production-test.js /tmp/lc-usage-cutover-candidate.js

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$source_client" "$release_client"
install -m 0444 "$usage_stage/client/user-usage-dashboard.js" "$release_client/user-usage-dashboard.js"
install -m 0444 "$usage_stage/client/user-usage-dashboard.css" "$release_client/user-usage-dashboard.css"
install -m 0444 "$usage_stage/api/usage-dashboard.js" "$release_usage"

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
python3 - "$compose_override" "$candidate_override" "$release_client" "$release_usage" "$cutoff" "$cutoff_models" <<'PY'
import sys
import yaml

source, destination, release_client, release_usage, cutoff, cutoff_models = sys.argv[1:]
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
updates = {
    "USER_USAGE_PRICING_CUTOFF": cutoff,
    "USER_USAGE_PRICING_CUTOFF_MODELS": cutoff_models,
}
environment = api.setdefault("environment", [])
if isinstance(environment, dict):
    environment.update(updates)
else:
    environment = [item for item in environment if str(item).split("=", 1)[0] not in updates]
    environment.extend(f"{key}={value}" for key, value in updates.items())
    api["environment"] = environment
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
test "$(grep -cF ':/app/client/dist:ro' "$candidate_override")" = "1"
test "$(grep -cF ':/app/api/server/routes/usage-dashboard.js:ro' "$candidate_override")" = "1"
test "$(grep -cF ':/app/api/server/routes/user.js:ro' "$candidate_override")" = "1"
grep -Fq "USER_USAGE_PRICING_CUTOFF=$cutoff" "$candidate_override"
grep -Fq "USER_USAGE_PRICING_CUTOFF_MODELS=$cutoff_models" "$candidate_override"
grep -Fq "user-usage-dashboard.js?v=$release_key" "$release_client/index.html"
grep -Fq 'decorateCostBreakdown' "$release_usage"
grep -Fq 'lc-usage-cost-detail' "$release_client/user-usage-dashboard.js"

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
grep -Fq 'lc-usage-cost-detail' "$stage_dir/live-user-usage-dashboard.js"
docker cp "$usage_stage/scripts/test-production-aggregation.js" LibreChat-API:/tmp/lc-usage-cutover-production-test.js
docker exec LibreChat-API node /tmp/lc-usage-cutover-production-test.js /app/api/server/routes/usage-dashboard.js

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
pricing_cutoff=$cutoff
pricing_cutoff_models=$cutoff_models
protected_containers_unchanged=true
currency=USD
unauthenticated_endpoint_status=401
api_config_health=ok
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nbackup_dir=%s\nrelease_root=%s\napi_container=%s\n' "$backup_dir" "$release_root" "$api_id_after"
