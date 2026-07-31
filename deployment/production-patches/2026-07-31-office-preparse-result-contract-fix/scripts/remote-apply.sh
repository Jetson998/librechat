#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:?stage directory is required}"
source_revision="${2:?source revision is required}"
timestamp="$(date +%Y%m%d%H%M%S)"
compose_dir="/opt/librechat"
compose_override="$compose_dir/compose.override.yaml"
release_dir="$compose_dir/office-preparse-result-contract-fix/${source_revision:0:12}-$timestamp"
backup_dir="$compose_dir/backups/office-preparse-result-contract-fix-${source_revision:0:12}-$timestamp"

exec 9>"/var/lock/librechat-office-preparse-result-contract-fix.lock"
flock -n 9 || {
  echo "another Office pre-parse release is active" >&2
  exit 75
}

initialization_failure_src="$stage_dir/InitializationFailure.js"
office_preparse_src="$stage_dir/OfficePreparse.js"
request_src="$stage_dir/request.js"
for file in \
  "$initialization_failure_src" \
  "$office_preparse_src" \
  "$request_src" \
  "$compose_override"; do
  test -f "$file"
done

initialization_failure_hash="$(sha256sum "$initialization_failure_src" | awk '{print $1}')"
office_preparse_hash="$(sha256sum "$office_preparse_src" | awk '{print $1}')"
request_hash="$(sha256sum "$request_src" | awk '{print $1}')"
compose_hash_before="$(sha256sum "$compose_override" | awk '{print $1}')"

api_id_before="$(docker inspect LibreChat-API --format '{{.Id}}')"
codeapi_id_before="$(docker inspect LibreChat-CodeAPI --format '{{.Id}}')"
codeapi_started_before="$(docker inspect LibreChat-CodeAPI --format '{{.State.StartedAt}}')"
codeapi_image_before="$(docker inspect LibreChat-CodeAPI --format '{{.Image}}')"
codeapi_init_before="$(docker inspect LibreChat-CodeAPI --format '{{.HostConfig.Init}}')"

protected=(LibreChat-CodeAPI LibreChat-NGINX LibreChat-RAG-API LibreChat-Admin-Panel chat-mongodb)
declare -A protected_before
for container in "${protected[@]}"; do
  protected_before["$container"]="$(docker inspect "$container" --format '{{.Id}}')"
done

mkdir -p "$release_dir" "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml.before"
install -m 0444 "$initialization_failure_src" "$release_dir/InitializationFailure.js"
install -m 0444 "$office_preparse_src" "$release_dir/OfficePreparse.js"
install -m 0444 "$request_src" "$release_dir/request.js"

for destination in \
  /app/api/server/controllers/agents/request.js \
  /app/api/server/services/Files/OfficePreparse.js; do
  current_source="$(docker inspect LibreChat-API --format \
    "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Source}}{{end}}{{end}}")"
  if [[ -n "$current_source" && -f "$current_source" ]]; then
    cp -a "$current_source" "$backup_dir/$(basename "$destination").before"
  fi
done

applied=0
rollback() {
  cp -a "$backup_dir/compose.override.yaml.before" "$compose_override"
  docker compose -f "$compose_dir/compose.yaml" -f "$compose_override" \
    up -d --no-deps --force-recreate api >/dev/null
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
    '/app/api/server/controllers/agents/InitializationFailure.js',
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
    f'{release_dir}/InitializationFailure.js:/app/api/server/controllers/agents/InitializationFailure.js:ro',
    f'{release_dir}/request.js:/app/api/server/controllers/agents/request.js:ro',
    f'{release_dir}/OfficePreparse.js:/app/api/server/services/Files/OfficePreparse.js:ro',
])
api['volumes'] = volumes

with open(path, 'w', encoding='utf-8') as handle:
    yaml.safe_dump(payload, handle, sort_keys=False, allow_unicode=True)
PY

docker compose -f "$compose_dir/compose.yaml" -f "$compose_override" config >/dev/null
applied=1
docker compose -f "$compose_dir/compose.yaml" -f "$compose_override" \
  up -d --no-deps --force-recreate api >/dev/null

ready=0
for _ in $(seq 1 90); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = "1"

docker exec LibreChat-API node --check \
  /app/api/server/controllers/agents/InitializationFailure.js
docker exec LibreChat-API node --check /app/api/server/controllers/agents/request.js
docker exec LibreChat-API node --check /app/api/server/services/Files/OfficePreparse.js

test "$(docker exec LibreChat-API sha256sum /app/api/server/controllers/agents/InitializationFailure.js | awk '{print $1}')" = "$initialization_failure_hash"
test "$(docker exec LibreChat-API sha256sum /app/api/server/controllers/agents/request.js | awk '{print $1}')" = "$request_hash"
test "$(docker exec LibreChat-API sha256sum /app/api/server/services/Files/OfficePreparse.js | awk '{print $1}')" = "$office_preparse_hash"

api_id_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_id_after" != "$api_id_before"
for container in "${protected[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_before[$container]}"
done
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.Status}}')" = "running"
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.StartedAt}}')" = "$codeapi_started_before"
test "$(docker inspect LibreChat-CodeAPI --format '{{.Image}}')" = "$codeapi_image_before"
test "$(docker inspect LibreChat-CodeAPI --format '{{.HostConfig.Init}}')" = "$codeapi_init_before"

main_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/)"
api_config_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/config)"
office_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)"
test "$main_status" = "200"
test "$api_config_status" = "200"
test "$office_status" = "401"

compose_hash_after="$(sha256sum "$compose_override" | awk '{print $1}')"
trap - ERR
printf 'status=passed\n'
printf 'deployed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'source_revision=%s\n' "$source_revision"
printf 'release_dir=%s\n' "$release_dir"
printf 'backup_dir=%s\n' "$backup_dir"
printf 'compose_sha256_before=%s\n' "$compose_hash_before"
printf 'compose_sha256_after=%s\n' "$compose_hash_after"
printf 'api_container_before=%s\n' "$api_id_before"
printf 'api_container_after=%s\n' "$api_id_after"
printf 'codeapi_container=%s\n' "$codeapi_id_before"
printf 'initialization_failure_sha256=%s\n' "$initialization_failure_hash"
printf 'request_sha256=%s\n' "$request_hash"
printf 'office_preparse_sha256=%s\n' "$office_preparse_hash"
printf 'main_status=%s\n' "$main_status"
printf 'api_config_status=%s\n' "$api_config_status"
printf 'office_status=%s\n' "$office_status"
printf 'protected_services_unchanged=true\n'
