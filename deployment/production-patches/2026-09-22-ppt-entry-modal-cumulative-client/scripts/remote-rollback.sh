#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir="${1:?backup directory is required}"
baseline_path="${2:?preflight snapshot is required}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
ppt_active="$root_dir/ppt-entry-plan-a-redirect/current"

test -f "$backup_dir/compose.override.yaml"
test -f "$backup_dir/ppt-current-target"
test -f "$baseline_path"
test -f "$env_file"

old_mount="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["client_mount"])' "$baseline_path")"
old_index_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["client_index_sha256"])' "$baseline_path")"
old_ppt_target="$(cat "$backup_dir/ppt-current-target")"
test -d "$old_mount"
test -f "$old_mount/index.html"
test "$(sha256sum "$old_mount/index.html" | awk '{print $1}')" = "$old_index_sha"
test -d "$old_ppt_target"

cp -a "$backup_dir/compose.override.yaml" "$compose_override"
tmp_link="$ppt_active.rollback-$$"
rm -f "$tmp_link"
ln -s "$old_ppt_target" "$tmp_link"
mv -Tf "$tmp_link" "$ppt_active"

docker compose --env-file "$env_file" -f "$compose_base" -f "$compose_override" config >/dev/null
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

tmp_index="$(mktemp /tmp/ppt-entry-modal-rollback-index.XXXXXX)"
tmp_ppt="$(mktemp /tmp/ppt-entry-modal-rollback-ppt.XXXXXX)"
trap 'rm -f "$tmp_index" "$tmp_ppt"' EXIT
curl -ksSf -o "$tmp_index" https://152.32.172.162.sslip.io/
curl -ksSf -o "$tmp_ppt" https://ppt.152.32.172.162.sslip.io/
test "$(sha256sum "$tmp_index" | awk '{print $1}')" = "$old_index_sha"
old_ppt_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline"]["ppt_index_sha256"])' "$baseline_path")"
test "$(sha256sum "$tmp_ppt" | awk '{print $1}')" = "$old_ppt_sha"
test "$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination \"/app/client/dist\"}}{{.Source}}{{end}}{{end}}')" = "$old_mount"
test "$(docker inspect LibreChat-API --format '{{range .Mounts}}{{if eq .Destination \"/app/client/dist\"}}{{.RW}}{{end}}{{end}}')" = "false"

python3 - "$baseline_path" <<'PY'
import json
import subprocess
import sys

baseline = json.load(open(sys.argv[1], encoding="utf-8"))
for name, expected in baseline["services"].items():
    if name == "LibreChat-API":
        continue
    current = json.loads(subprocess.run(["docker", "inspect", name], text=True, capture_output=True, check=True).stdout)[0]
    if current["Id"] != expected["id"] or current["State"]["StartedAt"] != expected["started_at"]:
        raise SystemExit(f"protected service changed during rollback: {name}")
PY

printf 'rollback=ok\nclient_mount=%s\nppt_target=%s\npublic_index_sha256=%s\n' \
  "$old_mount" "$old_ppt_target" "$old_index_sha"
