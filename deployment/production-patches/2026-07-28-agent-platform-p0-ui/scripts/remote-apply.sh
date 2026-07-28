#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:?stage directory is required}"
source_revision="${2:?source revision is required}"
timestamp="$(date +%Y%m%d%H%M%S)"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
config_file="$root_dir/librechat.yaml"
artifact_zip="$stage_dir/client-artifact.zip"
metadata_path="$stage_dir/artifact.json"
runtime_snapshot="$stage_dir/runtime-preflight.json"
verify_script="$stage_dir/verify-artifact.py"
preflight_script="$stage_dir/remote-preflight.py"
rollback_script="$stage_dir/remote-rollback.sh"
release_root="$root_dir/agent-platform-p0-ui/${source_revision:0:12}-$timestamp"
release_client="$release_root/client-dist"
backup_dir="$root_dir/backups/agent-platform-p0-ui-${source_revision:0:12}-$timestamp"
work_dir="$(mktemp -d /tmp/librechat-agent-platform-p0-apply.XXXXXX)"
candidate_client="$work_dir/client-dist"
candidate_override="$work_dir/compose.override.yaml"
current_snapshot="$work_dir/current-runtime.json"
result_path="$stage_dir/DEPLOY_RESULT.json"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

for path in \
  "$compose_base" "$compose_override" "$env_file" "$config_file" \
  "$artifact_zip" "$metadata_path" "$runtime_snapshot" "$verify_script" \
  "$preflight_script" "$rollback_script"; do
  test -f "$path"
done

python3 "$verify_script" "$artifact_zip" "$metadata_path"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_revision"])' "$runtime_snapshot")" = "$source_revision"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["client_artifact"]["zip_sha256"])' "$runtime_snapshot")" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifact"]["zip_sha256"])' "$metadata_path")"

python3 "$preflight_script" "$metadata_path" "$current_snapshot" >/dev/null
python3 - "$runtime_snapshot" "$current_snapshot" <<'PY'
import json
import sys

expected = json.load(open(sys.argv[1], encoding="utf-8"))
current = json.load(open(sys.argv[2], encoding="utf-8"))
if current.get("status") != "passed":
    raise SystemExit("current production preflight did not pass")
if expected.get("baseline") != current.get("baseline"):
    raise SystemExit("production baseline drifted after the signed preflight")
if current["host_resources"]["memory_available_mb"] < 512:
    raise SystemExit("production memory fell below release threshold")
if current["host_resources"]["disk_free_mb"] < 2048:
    raise SystemExit("production disk fell below release threshold")
PY

python3 - "$artifact_zip" "$candidate_client" <<'PY'
import io
import os
import shutil
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

zip_path = Path(sys.argv[1])
destination = Path(sys.argv[2]).resolve()
destination.mkdir(parents=True, exist_ok=False)
with zipfile.ZipFile(zip_path) as bundle:
    tar_payload = bundle.read("client-dist.tar.gz")
with tarfile.open(fileobj=io.BytesIO(tar_payload), mode="r:gz") as archive:
    for member in archive.getmembers():
        relative = PurePosixPath(member.name)
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit(f"unsafe Client archive path: {member.name}")
        while str(relative).startswith("./"):
            relative = PurePosixPath(str(relative)[2:])
        if str(relative) in {"", "."}:
            continue
        target = (destination / str(relative)).resolve()
        try:
            target.relative_to(destination)
        except ValueError as error:
            raise SystemExit(f"Client archive path escaped destination: {member.name}") from error
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            target.chmod(0o555)
            continue
        if not member.isfile():
            raise SystemExit(f"unsupported Client archive member: {member.name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit(f"unable to read Client archive member: {member.name}")
        with target.open("wb") as handle:
            shutil.copyfileobj(source, handle)
        target.chmod(0o444)
PY

candidate_index_sha="$(sha256sum "$candidate_client/index.html" | awk '{print $1}')"
expected_index_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["client"]["composed_index_sha256"])' "$metadata_path")"
test "$candidate_index_sha" = "$expected_index_sha"

current_client="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["client_mount"])' "$runtime_snapshot")"
compose_sha_before="$(sha256sum "$compose_override" | awk '{print $1}')"
config_sha_before="$(sha256sum "$config_file" | awk '{print $1}')"
api_id_before="$(docker inspect LibreChat-API --format '{{.Id}}')"

python3 - "$compose_override" "$candidate_override" "$release_client" <<'PY'
import sys
import yaml

source, destination, release_client = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    payload = yaml.safe_load(handle) or {}
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
api["volumes"].append(f"{release_client}:/app/client/dist:ro")
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(payload, handle, allow_unicode=True, sort_keys=False)
PY

cd "$root_dir"
docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate_override" config >/dev/null
test "$(grep -cF ':/app/client/dist:ro' "$candidate_override")" = "1"
grep -Fq "$release_client:/app/client/dist:ro" "$candidate_override"

mkdir -p "$release_root" "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$candidate_client" "$release_client"
cp -a "$current_client" "$backup_dir/client-dist"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"
cp -a "$runtime_snapshot" "$backup_dir/runtime-preflight.json"
cp -a "$artifact_zip" "$release_root/client-artifact.zip"
cp -a "$metadata_path" "$release_root/artifact.json"
cp -a "$runtime_snapshot" "$release_root/runtime-preflight.json"
cp -a "$rollback_script" "$release_root/remote-rollback.sh"
chmod 700 "$release_root/remote-rollback.sh"
test "$(sha256sum "$backup_dir/client-dist/index.html" | awk '{print $1}')" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["client_index_sha256"])' "$runtime_snapshot")"

applied=0
rollback_on_error() {
  local rc=$?
  trap - ERR
  if [[ "$applied" = "1" ]]; then
    "$rollback_script" "$backup_dir" "$runtime_snapshot" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap rollback_on_error ERR

install -m 0644 "$candidate_override" "$compose_override.next-$timestamp"
mv "$compose_override.next-$timestamp" "$compose_override"
applied=1
docker compose --env-file "$env_file" -f "$compose_base" -f "$compose_override" \
  up -d --no-deps --force-recreate api >/dev/null

ready=0
for _ in $(seq 1 120); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = "1"

root_status="$(curl -ksS -o "$work_dir/live-index.html" -w '%{http_code}' https://152.32.172.162.sslip.io/)"
api_status="$(curl -ksS -o "$work_dir/api-config.json" -w '%{http_code}' https://152.32.172.162.sslip.io/api/config)"
admin_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://admin.152.32.172.162.sslip.io/)"
office_status="$(curl -ksS -D "$work_dir/office.headers" -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)"
test "$root_status" = "200"
test "$api_status" = "200"
test "$admin_status" = "200"
test "$office_status" = "401"
grep -Fiq 'Office Converter' "$work_dir/office.headers"
test "$(sha256sum "$work_dir/live-index.html" | awk '{print $1}')" = "$expected_index_sha"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["buildInfo"]["commit"])' "$work_dir/api-config.json")" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source"]["upstream_commit"])' "$metadata_path")"

python3 - "$release_client/agent-platform-client-overlay.json" <<'PY'
import hashlib
import json
import ssl
import sys
import urllib.request

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
context = ssl.create_default_context()
context.check_hostname = False
context.verify_mode = ssl.CERT_NONE
for asset in manifest["assets"]:
    with urllib.request.urlopen(
        "https://152.32.172.162.sslip.io/" + asset["output"],
        timeout=20,
        context=context,
    ) as response:
        payload = response.read()
    actual = hashlib.sha256(payload).hexdigest()
    if actual != asset["sha256"]:
        raise SystemExit(f"public asset SHA-256 mismatch: {asset['output']}")
PY

active_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
test "$active_mount" = "$release_client"
test "$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.RW}}{{end}}{{end}}')" = "false"
api_id_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_id_after" != "$api_id_before"
test "$(sha256sum "$config_file" | awk '{print $1}')" = "$config_sha_before"
test "$(sha256sum "$compose_base" | awk '{print $1}')" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["compose_base_sha256"])' "$runtime_snapshot")"

python3 - "$runtime_snapshot" <<'PY'
import json
import subprocess
import sys

baseline = json.load(open(sys.argv[1], encoding="utf-8"))["baseline"]
for name, expected in baseline["containers"].items():
    if name == "LibreChat-API":
        continue
    payload = json.loads(
        subprocess.run(["docker", "inspect", name], text=True, capture_output=True, check=True).stdout
    )[0]
    if payload["Id"] != expected["id"] or payload["State"]["StartedAt"] != expected["started_at"]:
        raise SystemExit(f"protected container changed: {name}")

office = baseline["office_converter"]
if office["kind"] == "container":
    payload = json.loads(
        subprocess.run(
            ["docker", "inspect", office["name"]], text=True, capture_output=True, check=True
        ).stdout
    )[0]
    if payload["Id"] != office["id"] or payload["State"]["StartedAt"] != office["started_at"]:
        raise SystemExit("Office Converter container changed")
else:
    output = subprocess.run(
        [
            "systemctl",
            "show",
            office["name"],
            "--property=ActiveState",
            "--property=MainPID",
            "--property=ActiveEnterTimestampMonotonic",
        ],
        text=True,
        capture_output=True,
        check=True,
    ).stdout
    current = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    if (
        current.get("ActiveState") != office["active_state"]
        or current.get("MainPID") != office["main_pid"]
        or current.get("ActiveEnterTimestampMonotonic")
        != office["active_enter_timestamp_monotonic"]
    ):
        raise SystemExit("Office Converter service changed")
PY

compose_sha_after="$(sha256sum "$compose_override" | awk '{print $1}')"
python3 - "$result_path" "$runtime_snapshot" "$release_root" "$release_client" \
  "$backup_dir" "$api_id_before" "$api_id_after" "$compose_sha_before" \
  "$compose_sha_after" "$expected_index_sha" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

(
    result_path,
    snapshot_path,
    release_root,
    release_client,
    backup_dir,
    api_before,
    api_after,
    compose_before,
    compose_after,
    index_sha,
) = sys.argv[1:]
snapshot = json.load(open(snapshot_path, encoding="utf-8"))
payload = {
    "schema_version": 1,
    "status": "passed",
    "deployed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    "release_root": release_root,
    "client_mount_before": snapshot["baseline"]["client_mount"],
    "client_mount_after": release_client,
    "client_index_sha256": index_sha,
    "backup_dir": backup_dir,
    "compose_sha256_before": compose_before,
    "compose_sha256_after": compose_after,
    "api_container_before": api_before,
    "api_container_after": api_after,
    "protected_services_unchanged": True,
    "public_checks": {
        "main_root": 200,
        "api_config": 200,
        "admin_root": 200,
        "office_auth_boundary": 401,
    },
}
Path(result_path).write_text(
    json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
print(json.dumps(payload, sort_keys=True))
PY

cp -a "$result_path" "$release_root/DEPLOY_RESULT.json"
cp -a "$result_path" "$backup_dir/DEPLOY_RESULT.json"
trap - ERR
printf 'deployment=ok\nrelease_root=%s\nbackup_dir=%s\nclient_index_sha256=%s\napi_container=%s\n' \
  "$release_root" "$backup_dir" "$expected_index_sha" "$api_id_after"
