#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-user-usage-dashboard-auth-fix}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
release_key="${release_commit:0:12}"
timestamp="$(date +%Y%m%d%H%M%S)"
source_root="$root_dir/user-usage-dashboard/4c2bbcf875d8-20260718002958"
release_root="$root_dir/user-usage-dashboard/$release_key-$timestamp"
release_client="$release_root/client-dist"
backup_dir="$root_dir/backups/user-usage-dashboard-auth-fix-$timestamp"

expected_override_sha="2ffe5f78f449cb5def5e2084ea557ea792c4368eee413ca3cb6a7eb45fe42e22"
expected_index_sha="fdac283ba9e31b87bc71f088d618fc84b1d33d45defb2269f7aba0cb1365367f"
expected_client_js_sha="886e005120d96f4750e50a9c7aa3906a675dea28c3f16bd89bc9044b61662b4f"
expected_user_route_sha="6a535ba377dace4e81e3f5b3913704884adb21586c1088d102cf22e53e949280"
expected_usage_route_sha="47873c3b3c58eff47c91884faf488bbdee99c4f6a8be984a669053ff223af700"

test "$(sha256sum "$compose_override" | awk '{print $1}')" = "$expected_override_sha"
test "$(sha256sum "$source_root/client-dist/index.html" | awk '{print $1}')" = "$expected_index_sha"
test "$(sha256sum "$source_root/client-dist/user-usage-dashboard.js" | awk '{print $1}')" = "$expected_client_js_sha"
test "$(sha256sum "$source_root/user.js" | awk '{print $1}')" = "$expected_user_route_sha"
test "$(sha256sum "$source_root/usage-dashboard.js" | awk '{print $1}')" = "$expected_usage_route_sha"

node --check "$stage_dir/client/user-usage-dashboard.js"
python3 "$stage_dir/scripts/test-client-release.py"
bash -n "$stage_dir/scripts/deploy-auth-fix.sh"

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$source_root/client-dist" "$release_client"
install -m 0444 "$stage_dir/client/user-usage-dashboard.js" "$release_client/user-usage-dashboard.js"
install -m 0444 "$stage_dir/api/user.js" "$release_root/user.js"
install -m 0444 "$stage_dir/api/usage-dashboard.js" "$release_root/usage-dashboard.js"

python3 - "$release_client/index.html" "$release_key" <<'PY'
from pathlib import Path
import re
import sys
path, version = Path(sys.argv[1]), sys.argv[2]
text = path.read_text(encoding="utf-8")
text, count = re.subn(r'user-usage-dashboard\.js\?v=[^"<]+', f'user-usage-dashboard.js?v={version}', text, count=1)
if count != 1:
    raise SystemExit("dashboard script version marker was not found")
path.write_text(text, encoding="utf-8")
PY

candidate_override="$stage_dir/compose.override.auth-fix.yaml"
python3 - "$compose_override" "$candidate_override" "$release_root" <<'PY'
import sys
import yaml
source, destination, release_root = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle)
api = data["services"]["api"]
destinations = {
    "/app/client/dist": f"{release_root}/client-dist:/app/client/dist:ro",
    "/app/api/server/routes/user.js": f"{release_root}/user.js:/app/api/server/routes/user.js:ro",
    "/app/api/server/routes/usage-dashboard.js": f"{release_root}/usage-dashboard.js:/app/api/server/routes/usage-dashboard.js:ro",
}
next_volumes = []
seen = set()
for item in api.get("volumes", []):
    destination_path = str(item).split(":", 2)[1]
    if destination_path in destinations:
        next_volumes.append(destinations[destination_path])
        seen.add(destination_path)
    else:
        next_volumes.append(item)
if seen != set(destinations):
    raise SystemExit(f"missing expected mounts: {set(destinations) - seen}")
api["volumes"] = next_volumes
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
grep -Fq "user-usage-dashboard.js?v=$release_key" "$release_client/index.html"
grep -Fq "localStorage.getItem('token')" "$release_client/user-usage-dashboard.js"

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
curl -ksSf https://152.32.172.162.sslip.io/ | grep -Fq "user-usage-dashboard.js?v=$release_key"

for container in "${!protected_ids[@]}"; do test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"; done
api_id_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_id_after" != "$api_id_before"

trap - ERR
cat >"$stage_dir/AUTH_FIX_DEPLOY_RESULT.txt" <<EOF
timestamp=$timestamp
release_commit=$release_commit
release_root=$release_root
backup_dir=$backup_dir
api_container_before=$api_id_before
api_container_after=$api_id_after
client_js_sha=$(sha256sum "$release_client/user-usage-dashboard.js" | awk '{print $1}')
client_index_sha=$(sha256sum "$release_client/index.html" | awk '{print $1}')
protected_containers_unchanged=true
api_config_health=ok
unauthenticated_endpoint_status=401
EOF
cp "$stage_dir/AUTH_FIX_DEPLOY_RESULT.txt" "$backup_dir/AUTH_FIX_DEPLOY_RESULT.txt"
cat "$stage_dir/AUTH_FIX_DEPLOY_RESULT.txt"
