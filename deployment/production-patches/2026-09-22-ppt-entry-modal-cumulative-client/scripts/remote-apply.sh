#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API,PPT-static-root
set -Eeuo pipefail

stage_dir="${1:?stage directory is required}"
source_revision="${2:?candidate source revision is required}"
timestamp="$(date +%Y%m%d%H%M%S)"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
config_file="$root_dir/librechat.yaml"
artifact="$stage_dir/candidate.tar.gz"
metadata="$stage_dir/artifact.json"
expected_snapshot="$stage_dir/runtime-preflight.json"
preflight="$stage_dir/remote-preflight.py"
verify="$stage_dir/verify-artifact.py"
rollback="$stage_dir/remote-rollback.sh"
release_root="$root_dir/ppt-entry-modal-cumulative-client/${source_revision:0:12}-$timestamp"
release_client="$release_root/client-dist"
release_ppt="$release_root/ppt-entry"
backup_dir="$root_dir/backups/ppt-entry-modal-cumulative-client-${source_revision:0:12}-$timestamp"
work_dir="$(mktemp -d /tmp/ppt-entry-modal-cumulative-client-apply.XXXXXX)"
current_snapshot="$work_dir/current-runtime.json"
result_path="$stage_dir/DEPLOY_RESULT.json"
applied=0

cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

for path in "$compose_base" "$compose_override" "$env_file" "$config_file" "$artifact" "$metadata" "$expected_snapshot" "$preflight" "$verify" "$rollback"; do
  test -f "$path"
done

python3 "$verify" "$artifact" "$metadata" >/dev/null
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidate_revision"])' "$expected_snapshot")" = "$source_revision"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidate_sha256"])' "$expected_snapshot")" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidate"]["archive_sha256"])' "$metadata")"

python3 "$preflight" "$metadata" "$current_snapshot" >/dev/null
python3 - "$expected_snapshot" "$current_snapshot" <<'PY'
import json
import sys

expected = json.load(open(sys.argv[1], encoding="utf-8"))
current = json.load(open(sys.argv[2], encoding="utf-8"))
if current.get("status") != "passed":
    raise SystemExit("fresh production preflight failed")
if current.get("baseline") != expected.get("baseline"):
    raise SystemExit("production baseline changed after preflight")
if current.get("services") != expected.get("services"):
    raise SystemExit("protected service identities changed after preflight")
if current["host_resources"]["memory_available_mb"] < 512 or current["host_resources"]["disk_free_mb"] < 2048:
    raise SystemExit("production resources below threshold")
PY

mkdir -p "$work_dir/extracted"
tar -xzf "$artifact" -C "$work_dir/extracted"
candidate_root="$work_dir/extracted/$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidate"]["root"])' "$metadata")"
client_source="$candidate_root/librechat-client/dist"
ppt_source="$candidate_root/ppt-entry/dist-ppt-entry"
test -d "$client_source"
test -d "$ppt_source"

current_mount="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["client_mount"])' "$current_snapshot")"
current_ppt_target="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["ppt_resolved_path"])' "$current_snapshot")"
compose_before="$(sha256sum "$compose_override" | awk '{print $1}')"
config_before="$(sha256sum "$config_file" | awk '{print $1}')"
api_before="$(docker inspect LibreChat-API --format '{{.Id}}')"

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$client_source" "$release_client"
cp -a "$ppt_source" "$release_ppt"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$current_mount" "$backup_dir/client-dist"
printf '%s\n' "$current_ppt_target" > "$backup_dir/ppt-current-target"
cp -a "$expected_snapshot" "$backup_dir/runtime-preflight.json"
cp -a "$artifact" "$release_root/candidate.tar.gz"
cp -a "$metadata" "$release_root/artifact.json"
cp -a "$expected_snapshot" "$release_root/runtime-preflight.json"
cp -a "$rollback" "$release_root/remote-rollback.sh"
chmod 700 "$release_root/remote-rollback.sh"

candidate_index="$(sha256sum "$release_client/index.html" | awk '{print $1}')"
expected_index="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["client"]["index_sha256"])' "$metadata")"
test "$candidate_index" = "$expected_index"
candidate_ppt_index="$(sha256sum "$release_ppt/index.html" | awk '{print $1}')"
expected_ppt_index="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ppt"]["index_sha256"])' "$metadata")"
test "$candidate_ppt_index" = "$expected_ppt_index"

candidate_override="$work_dir/compose.override.yaml"
python3 - "$compose_override" "$candidate_override" "$release_client" <<'PY'
import sys
import yaml

source, destination, client_path = sys.argv[1:]
payload = yaml.safe_load(open(source, encoding="utf-8")) or {}
api = payload.setdefault("services", {}).setdefault("api", {})
volumes = api.setdefault("volumes", [])

def target(entry):
    if isinstance(entry, str):
        parts = entry.split(":")
        return parts[1] if len(parts) > 1 else ""
    if isinstance(entry, dict):
        return entry.get("target", "")
    return ""

api["volumes"] = [entry for entry in volumes if target(entry) != "/app/client/dist"]
api["volumes"].append(f"{client_path}:/app/client/dist:ro")
yaml.safe_dump(payload, open(destination, "w", encoding="utf-8"), allow_unicode=True, sort_keys=False)
PY

python3 - "$compose_override" "$candidate_override" <<'PY'
import sys
import yaml

def without_client_mount(payload):
    payload = yaml.safe_load(open(payload, encoding="utf-8")) or {}
    volumes = payload.get("services", {}).get("api", {}).get("volumes", [])
    def target(entry):
        if isinstance(entry, str):
            parts = entry.split(":")
            return parts[1] if len(parts) > 1 else ""
        return entry.get("target", "") if isinstance(entry, dict) else ""
    payload["services"]["api"]["volumes"] = [item for item in volumes if target(item) != "/app/client/dist"]
    return payload

if without_client_mount(sys.argv[1]) != without_client_mount(sys.argv[2]):
    raise SystemExit("compose override changed outside the Client mount")
PY

rollback_on_error() {
  local rc=$?
  trap - ERR
  if [[ "$applied" = "1" ]]; then
    "$rollback" "$backup_dir" "$expected_snapshot" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap rollback_on_error ERR

cd "$root_dir"
docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
applied=1
install -m 0644 "$candidate_override" "$compose_override.next-$timestamp"
mv "$compose_override.next-$timestamp" "$compose_override"
ppt_link="$root_dir/ppt-entry-plan-a-redirect/current.next-$timestamp"
rm -f "$ppt_link"
ln -s "$release_ppt" "$ppt_link"
mv -Tf "$ppt_link" "$root_dir/ppt-entry-plan-a-redirect/current"

docker compose --env-file "$env_file" -f "$compose_base" -f "$compose_override" \
  up -d --no-deps --force-recreate api >/dev/null

ready=0
for _ in $(seq 1 180); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = "1"

main_index="$work_dir/main-index.html"
ppt_index="$work_dir/ppt-index.html"
curl -ksSf -o "$main_index" https://152.32.172.162.sslip.io/
curl -ksSf -o "$ppt_index" https://ppt.152.32.172.162.sslip.io/
test "$(sha256sum "$main_index" | awk '{print $1}')" = "$candidate_index"
test "$(sha256sum "$ppt_index" | awk '{print $1}')" = "$candidate_ppt_index"
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/config)" = "200"
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://ppt.152.32.172.162.sslip.io/api/config)" = "404"
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://admin.152.32.172.162.sslip.io/)" = "200"

active_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
test "$active_mount" = "$release_client"
test "$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.RW}}{{end}}{{end}}')" = "false"
test "$(readlink -f "$root_dir/ppt-entry-plan-a-redirect/current")" = "$release_ppt"
api_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_after" != "$api_before"
test "$(sha256sum "$config_file" | awk '{print $1}')" = "$config_before"
test "$(sha256sum "$compose_base" | awk '{print $1}')" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["compose_sha256"])' "$expected_snapshot")"

python3 - "$expected_snapshot" <<'PY'
import json
import subprocess
import sys

baseline = json.load(open(sys.argv[1], encoding="utf-8"))
for name, expected in baseline["services"].items():
    if name == "LibreChat-API":
        continue
    current = json.loads(subprocess.run(["docker", "inspect", name], text=True, capture_output=True, check=True).stdout)[0]
    if current["Id"] != expected["id"] or current["State"]["StartedAt"] != expected["started_at"]:
        raise SystemExit(f"protected service changed: {name}")
PY

compose_after="$(sha256sum "$compose_override" | awk '{print $1}')"
python3 - "$result_path" "$expected_snapshot" "$release_root" "$release_client" "$release_ppt" "$backup_dir" "$api_before" "$api_after" "$compose_before" "$compose_after" "$candidate_index" "$candidate_ppt_index" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

(
    result_path, snapshot, release_root, client, ppt, backup, api_before, api_after,
    compose_before, compose_after, client_index, ppt_index,
) = sys.argv[1:]
payload = {
    "schema_version": 1,
    "status": "passed",
    "deployed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    "release_root": release_root,
    "client_mount_before": json.load(open(snapshot, encoding="utf-8"))["baseline"]["client_mount"],
    "client_mount_after": client,
    "ppt_target_after": ppt,
    "client_index_sha256": client_index,
    "ppt_index_sha256": ppt_index,
    "backup_dir": backup,
    "compose_override_sha256_before": compose_before,
    "compose_override_sha256_after": compose_after,
    "api_container_before": api_before,
    "api_container_after": api_after,
    "protected_services_unchanged": True,
    "nginx_reloaded": False,
    "public_checks": {"main_root": 200, "api_config": 200, "ppt_root": 200, "ppt_api": 404, "admin_root": 200},
}
encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
Path(result_path).write_text(encoded, encoding="utf-8")
Path(release_root, "DEPLOY_RESULT.json").write_text(encoded, encoding="utf-8")
Path(backup, "DEPLOY_RESULT.json").write_text(encoded, encoding="utf-8")
print(json.dumps(payload, sort_keys=True))
PY

trap - ERR
printf 'deployment=ok\nrelease_root=%s\nbackup_dir=%s\nclient_index_sha256=%s\nppt_index_sha256=%s\napi_container=%s\n' \
  "$release_root" "$backup_dir" "$candidate_index" "$candidate_ppt_index" "$api_after"
