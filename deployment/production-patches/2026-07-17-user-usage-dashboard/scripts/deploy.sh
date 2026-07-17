#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-user-usage-dashboard}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
release_root="$root_dir/user-usage-dashboard/$release_key-$timestamp"
release_client="$release_root/client-dist"
backup_dir="$root_dir/backups/user-usage-dashboard-$timestamp"

expected_override_sha="20b0a41b0f37829f15f373f4a14062df1d06abaf008e2d7fdab59c46613eee17"
expected_user_route_sha="6a535ba377dace4e81e3f5b3913704884adb21586c1088d102cf22e53e949280"
expected_client_index_sha="15a4e35d4e01085c8510f6b42f146607e17318e6e239854023cd9d0ed2d18d01"
source_client="$root_dir/ui-label-patch/client-dist"

for path in "$compose_base" "$compose_override" "$env_file" "$source_client/index.html"; do test -e "$path"; done
test "$(sha256sum "$compose_override" | awk '{print $1}')" = "$expected_override_sha"
test "$(docker exec LibreChat-API sha256sum /app/api/server/routes/user.js | awk '{print $1}')" = "$expected_user_route_sha"
test "$(sha256sum "$source_client/index.html" | awk '{print $1}')" = "$expected_client_index_sha"

node "$stage_dir/scripts/test-usage-dashboard.js"
python3 "$stage_dir/scripts/test-client-release.py"
node --check "$stage_dir/api/usage-dashboard.js"
node --check "$stage_dir/api/user.js"
node --check "$stage_dir/client/user-usage-dashboard.js"
node --check "$stage_dir/scripts/test-production-aggregation.js"

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$source_client" "$release_client"
install -m 0444 "$stage_dir/client/user-usage-dashboard.js" "$release_client/user-usage-dashboard.js"
install -m 0444 "$stage_dir/client/user-usage-dashboard.css" "$release_client/user-usage-dashboard.css"
install -m 0444 "$stage_dir/client/anthropic-mark.svg" "$release_client/anthropic-mark.svg"
install -m 0444 "$stage_dir/api/user.js" "$release_root/user.js"
install -m 0444 "$stage_dir/api/usage-dashboard.js" "$release_root/usage-dashboard.js"

python3 - "$release_client/index.html" "$release_key" <<'PY'
from pathlib import Path
import sys
path, version = Path(sys.argv[1]), sys.argv[2]
text = path.read_text(encoding="utf-8")
if "user-usage-dashboard.css" in text or "user-usage-dashboard.js" in text:
    raise SystemExit("usage dashboard assets are already present")
text = text.replace("</head>", f'<link rel="stylesheet" href="/user-usage-dashboard.css?v={version}"></head>', 1)
text = text.replace("</body>", f'<script id="user-usage-dashboard" src="/user-usage-dashboard.js?v={version}"></script></body>', 1)
path.write_text(text, encoding="utf-8")
PY

candidate_override="$stage_dir/compose.override.candidate.yaml"
python3 - "$compose_override" "$candidate_override" "$release_root" <<'PY'
import sys
import yaml
source, destination, release_root = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle)
api = data.setdefault("services", {}).setdefault("api", {})
volumes = api.setdefault("volumes", [])
managed_targets = (
    ":/app/client/dist:ro",
    ":/app/api/server/routes/user.js:ro",
    ":/app/api/server/routes/usage-dashboard.js:ro",
)
volumes = [item for item in volumes if not str(item).endswith(managed_targets)]
volumes.extend([
    f"{release_root}/client-dist:/app/client/dist:ro",
    f"{release_root}/user.js:/app/api/server/routes/user.js:ro",
    f"{release_root}/usage-dashboard.js:/app/api/server/routes/usage-dashboard.js:ro",
])
api["volumes"] = volumes
environment = api.setdefault("environment", [])
if isinstance(environment, dict):
    environment.update({"USER_USAGE_CURRENCY": "CNY", "USER_USAGE_USD_TO_CNY": "7.2", "USER_USAGE_TIMEZONE": "Asia/Singapore"})
else:
    keys = {str(item).split("=", 1)[0] for item in environment}
    for item in ["USER_USAGE_CURRENCY=CNY", "USER_USAGE_USD_TO_CNY=7.2", "USER_USAGE_TIMEZONE=Asia/Singapore"]:
        if item.split("=", 1)[0] not in keys: environment.append(item)
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
grep -Fq 'user-usage-dashboard.js' "$release_client/index.html"
grep -Fq 'business-upload-label-patch' "$release_client/index.html"
grep -Fq 'odysseia-login-page-patch' "$release_client/index.html"

declare -A protected_ids
for container in LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API chat-mongodb LibreChat-Admin-Panel; do protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"; done
api_id_before="$(docker inspect LibreChat-API --format '{{.Id}}')"

applied=0
rollback() { set +e; cp -a "$backup_dir/compose.override.yaml" "$compose_override"; cd "$root_dir"; docker compose up -d --no-deps --force-recreate api >/dev/null 2>&1; }
on_error() { rc=$?; trap - ERR; [[ "$applied" = "1" ]] && rollback; exit "$rc"; }
trap on_error ERR

install -m 0644 "$candidate_override" "$compose_override.next-$timestamp"
mv "$compose_override.next-$timestamp" "$compose_override"
applied=1
cd "$root_dir"
docker compose up -d --no-deps --force-recreate api >/dev/null

for _ in $(seq 1 120); do curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null 2>&1 && break; sleep 1; done
curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/user/usage-dashboard)" = "401"
curl -ksSf https://152.32.172.162.sslip.io/ | grep -Fq 'user-usage-dashboard.js'
docker exec LibreChat-API node --check /app/api/server/routes/usage-dashboard.js
docker cp "$stage_dir/scripts/test-production-aggregation.js" LibreChat-API:/tmp/test-production-aggregation.js
docker exec LibreChat-API node /tmp/test-production-aggregation.js /app/api/server/routes/usage-dashboard.js

for container in "${!protected_ids[@]}"; do test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"; done
api_id_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_id_after" != "$api_id_before"

trap - ERR
cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
release_commit=$release_commit
release_root=$release_root
backup_dir=$backup_dir
api_container_before=$api_id_before
api_container_after=$api_id_after
client_index_sha=$(sha256sum "$release_client/index.html" | awk '{print $1}')
user_route_sha=$(sha256sum "$release_root/user.js" | awk '{print $1}')
usage_route_sha=$(sha256sum "$release_root/usage-dashboard.js" | awk '{print $1}')
protected_containers_unchanged=true
unauthenticated_endpoint_status=401
api_config_health=ok
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
printf 'deployment=ok\nbackup_dir=%s\nrelease_root=%s\napi_container=%s\n' "$backup_dir" "$release_root" "$api_id_after"
