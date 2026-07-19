#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:?stage directory is required}"
source_revision="${2:?source revision is required}"
timestamp="$(date +%Y%m%d%H%M%S)"
release_dir="/opt/librechat/office-file-identity/${source_revision:0:12}-$timestamp"
compose_dir="/opt/librechat"
compose_override="$compose_dir/compose.override.yaml"
compose_backup="$compose_override.bak-$timestamp"

api_index_src="$stage_dir/api-index.cjs"
code_process_src="$stage_dir/code-process.js"
request_src="$stage_dir/request.js"
office_preparse_src="$stage_dir/OfficePreparse.js"

for file in "$api_index_src" "$code_process_src" "$request_src" "$office_preparse_src" "$compose_override"; do
  test -f "$file"
done

api_index_hash="$(sha256sum "$api_index_src" | awk '{print $1}')"
code_process_hash="$(sha256sum "$code_process_src" | awk '{print $1}')"
request_hash="$(sha256sum "$request_src" | awk '{print $1}')"
office_preparse_hash="$(sha256sum "$office_preparse_src" | awk '{print $1}')"
codeapi_id_before="$(docker inspect LibreChat-CodeAPI --format '{{.Id}}')"

cp -a "$compose_override" "$compose_backup"
mkdir -p "$release_dir"
install -m 0444 "$api_index_src" "$release_dir/api-index.cjs"
install -m 0444 "$code_process_src" "$release_dir/code-process.js"
install -m 0444 "$request_src" "$release_dir/request.js"
install -m 0444 "$office_preparse_src" "$release_dir/OfficePreparse.js"

applied=0
rollback() {
  cp -a "$compose_backup" "$compose_override"
  docker compose -f "$compose_dir/compose.yaml" -f "$compose_override" up -d --no-deps --force-recreate api >/dev/null
}
on_error() {
  rc=$?
  trap - ERR
  if [[ "$applied" == "1" ]]; then
    rollback
  fi
  exit "$rc"
}
trap on_error ERR

python3 - "$compose_override" "$release_dir" <<'PY'
import sys
import yaml

path, release_dir = sys.argv[1:]
with open(path, 'r', encoding='utf-8') as handle:
    payload = yaml.safe_load(handle) or {}

api = payload.setdefault('services', {}).setdefault('api', {})
volumes = api.setdefault('volumes', [])
destinations = {
    '/app/packages/api/dist/index.cjs',
    '/app/api/server/services/Files/Code/process.js',
    '/app/api/server/controllers/agents/request.js',
    '/app/api/server/services/Files/OfficePreparse.js',
}

def destination(entry):
    if isinstance(entry, str):
        parts = entry.split(':')
        return parts[1] if len(parts) > 1 else ''
    if isinstance(entry, dict):
        return entry.get('target', '')
    return ''

volumes = [entry for entry in volumes if destination(entry) not in destinations]
volumes.extend([
    f'{release_dir}/api-index.cjs:/app/packages/api/dist/index.cjs:ro',
    f'{release_dir}/code-process.js:/app/api/server/services/Files/Code/process.js:ro',
    f'{release_dir}/request.js:/app/api/server/controllers/agents/request.js:ro',
    f'{release_dir}/OfficePreparse.js:/app/api/server/services/Files/OfficePreparse.js:ro',
])
api['volumes'] = volumes

with open(path, 'w', encoding='utf-8') as handle:
    yaml.safe_dump(payload, handle, sort_keys=False, allow_unicode=True)
PY

docker compose -f "$compose_dir/compose.yaml" -f "$compose_override" config >/dev/null
applied=1
docker compose -f "$compose_dir/compose.yaml" -f "$compose_override" up -d --no-deps --force-recreate api >/dev/null

ready=0
for _ in $(seq 1 90); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = "1"

docker exec LibreChat-API node --check /app/packages/api/dist/index.cjs
docker exec LibreChat-API node --check /app/api/server/services/Files/Code/process.js
docker exec LibreChat-API node --check /app/api/server/controllers/agents/request.js
docker exec LibreChat-API node --check /app/api/server/services/Files/OfficePreparse.js

test "$(docker exec LibreChat-API sha256sum /app/packages/api/dist/index.cjs | awk '{print $1}')" = "$api_index_hash"
test "$(docker exec LibreChat-API sha256sum /app/api/server/services/Files/Code/process.js | awk '{print $1}')" = "$code_process_hash"
test "$(docker exec LibreChat-API sha256sum /app/api/server/controllers/agents/request.js | awk '{print $1}')" = "$request_hash"
test "$(docker exec LibreChat-API sha256sum /app/api/server/services/Files/OfficePreparse.js | awk '{print $1}')" = "$office_preparse_hash"

test "$(docker inspect LibreChat-CodeAPI --format '{{.Id}}')" = "$codeapi_id_before"
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.Health.Status}}')" = "healthy"
curl -ksSf https://152.32.172.162.sslip.io/ >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)" = "401"

trap - ERR
printf 'timestamp=%s\n' "$timestamp"
printf 'release_dir=%s\n' "$release_dir"
printf 'compose_backup=%s\n' "$compose_backup"
printf 'api_index_sha256=%s\n' "$api_index_hash"
printf 'code_process_sha256=%s\n' "$code_process_hash"
printf 'request_sha256=%s\n' "$request_hash"
printf 'office_preparse_sha256=%s\n' "$office_preparse_hash"
