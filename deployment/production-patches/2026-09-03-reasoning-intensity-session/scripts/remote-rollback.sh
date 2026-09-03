#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir="${1:?backup directory is required}"
baseline_path="${2:?runtime preflight snapshot is required}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"

test -f "$backup_dir/compose.override.yaml"
test -f "$baseline_path"
test -f "$env_file"

old_index_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["public_index_sha256"])' "$baseline_path")"
old_mount="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["client_mount"])' "$baseline_path")"

if [[ ! -d "$old_mount" ]]; then
  mkdir -p "$(dirname "$old_mount")"
  cp -a "$backup_dir/client-dist" "$old_mount"
fi
test "$(sha256sum "$old_mount/index.html" | awk '{print $1}')" = "$old_index_sha"

cp -a "$backup_dir/compose.override.yaml" "$compose_override"
docker compose --env-file "$env_file" -f "$compose_base" -f "$compose_override" config >/dev/null
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

active_mount="$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}')"
test "$active_mount" = "$old_mount"
test "$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.RW}}{{end}}{{end}}')" = "false"
tmp_index="$(mktemp /tmp/librechat-reasoning-intensity-session-rollback-index.XXXXXX)"
trap 'rm -f "$tmp_index"' EXIT
curl -ksSf -o "$tmp_index" https://152.32.172.162.sslip.io/
test "$(sha256sum "$tmp_index" | awk '{print $1}')" = "$old_index_sha"
python3 - "$baseline_path" <<'PY'
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
        raise SystemExit(f"protected container changed during rollback: {name}")

office = baseline["office_converter"]
if office["kind"] == "container":
    payload = json.loads(
        subprocess.run(
            ["docker", "inspect", office["name"]], text=True, capture_output=True, check=True
        ).stdout
    )[0]
    if payload["Id"] != office["id"] or payload["State"]["StartedAt"] != office["started_at"]:
        raise SystemExit("Office Converter container changed during rollback")
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
        raise SystemExit("Office Converter service changed during rollback")
PY
printf 'rollback=ok\nclient_mount=%s\npublic_index_sha256=%s\n' "$active_mount" "$old_index_sha"
