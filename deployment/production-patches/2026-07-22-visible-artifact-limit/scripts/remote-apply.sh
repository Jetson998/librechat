#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:?stage directory is required}"
source_revision="${2:?source revision is required}"
timestamp="$(date +%Y%m%d%H%M%S)"
release_dir="/opt/librechat/visible-artifact-limit/${source_revision:0:12}-$timestamp"
compose_dir="/opt/librechat"
compose_override="$compose_dir/compose.override.yaml"
compose_backup="$compose_override.bak-$timestamp"
backup_id="generated-artifact-delivery-${source_revision:0:12}-$timestamp"

baseclient_src="$stage_dir/BaseClient.js"
visibility_src="$stage_dir/GeneratedArtifactVisibility.js"
code_process_src="$stage_dir/code-process.js"
mongo_config_src="$stage_dir/mongo-config.js"

for file in \
  "$baseclient_src" "$visibility_src" "$code_process_src" \
  "$mongo_config_src" "$compose_override"; do
  test -f "$file"
done

node --check "$baseclient_src"
node --check "$visibility_src"
node --check "$code_process_src"
node --check "$mongo_config_src"

baseclient_hash="$(sha256sum "$baseclient_src" | awk '{print $1}')"
visibility_hash="$(sha256sum "$visibility_src" | awk '{print $1}')"
code_process_hash="$(sha256sum "$code_process_src" | awk '{print $1}')"
codeapi_id_before="$(docker inspect LibreChat-CodeAPI --format '{{.Id}}')"
codeapi_started_before="$(docker inspect LibreChat-CodeAPI --format '{{.State.StartedAt}}')"

run_mongo_mode() {
  local mode="$1"
  docker exec -i \
    -e GENERATED_ARTIFACT_DELIVERY_MODE="$mode" \
    -e GENERATED_ARTIFACT_DELIVERY_BACKUP_ID="$backup_id" \
    chat-mongodb mongosh --quiet LibreChat --file /dev/stdin <"$mongo_config_src"
}

mongo_preflight="$(run_mongo_mode preflight | tail -n 1)"
[[ "$mongo_preflight" == preflight=ok* ]]

cp -a "$compose_override" "$compose_backup"
mkdir -p "$release_dir"
install -m 0444 "$baseclient_src" "$release_dir/BaseClient.js"
install -m 0444 "$visibility_src" "$release_dir/GeneratedArtifactVisibility.js"
install -m 0444 "$code_process_src" "$release_dir/code-process.js"
install -m 0400 "$mongo_config_src" "$release_dir/mongo-config.js"

applied=0
mongo_applied=0
rollback() {
  set +e
  if [[ "$mongo_applied" == "1" ]]; then
    run_mongo_mode rollback >/dev/null 2>&1 || true
  fi
  cp -a "$compose_backup" "$compose_override"
  docker compose -f "$compose_dir/compose.yaml" -f "$compose_override" \
    up -d --no-deps --force-recreate api >/dev/null 2>&1 || true
}
on_error() {
  local rc=$?
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
    '/app/api/app/clients/BaseClient.js',
    '/app/api/server/services/Files/GeneratedArtifactVisibility.js',
    '/app/api/server/services/Files/Code/process.js',
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
    f'{release_dir}/BaseClient.js:/app/api/app/clients/BaseClient.js:ro',
    f'{release_dir}/GeneratedArtifactVisibility.js:/app/api/server/services/Files/GeneratedArtifactVisibility.js:ro',
    f'{release_dir}/code-process.js:/app/api/server/services/Files/Code/process.js:ro',
])
api['volumes'] = volumes

with open(path, 'w', encoding='utf-8') as handle:
    yaml.safe_dump(payload, handle, sort_keys=False, allow_unicode=True)
PY

docker compose -f "$compose_dir/compose.yaml" -f "$compose_override" config >/dev/null
applied=1
mongo_apply="$(run_mongo_mode apply | tail -n 1)"
[[ "$mongo_apply" == apply=ok* || "$mongo_apply" == apply=already_configured* ]]
if [[ "$mongo_apply" == apply=ok* ]]; then
  mongo_applied=1
fi

docker compose -f "$compose_dir/compose.yaml" -f "$compose_override" \
  up -d --no-deps --force-recreate api >/dev/null

ready=0
for _ in $(seq 1 120); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = "1"

docker exec LibreChat-API node --check /app/api/app/clients/BaseClient.js
docker exec LibreChat-API node --check /app/api/server/services/Files/GeneratedArtifactVisibility.js
docker exec LibreChat-API node --check /app/api/server/services/Files/Code/process.js

test "$(docker exec LibreChat-API sha256sum /app/api/app/clients/BaseClient.js | awk '{print $1}')" = "$baseclient_hash"
test "$(docker exec LibreChat-API sha256sum /app/api/server/services/Files/GeneratedArtifactVisibility.js | awk '{print $1}')" = "$visibility_hash"
test "$(docker exec LibreChat-API sha256sum /app/api/server/services/Files/Code/process.js | awk '{print $1}')" = "$code_process_hash"

test "$(run_mongo_mode verify | tail -n 1 | cut -d' ' -f1)" = "verify=ok"
test "$(docker inspect LibreChat-CodeAPI --format '{{.Id}}')" = "$codeapi_id_before"
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.StartedAt}}')" = "$codeapi_started_before"
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.Health.Status}}')" = "healthy"
curl -ksSf https://152.32.172.162.sslip.io/ >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)" = "401"

trap - ERR
printf 'timestamp=%s\n' "$timestamp"
printf 'release_dir=%s\n' "$release_dir"
printf 'compose_backup=%s\n' "$compose_backup"
printf 'mongo_backup_id=%s\n' "$backup_id"
printf 'baseclient_sha256=%s\n' "$baseclient_hash"
printf 'visibility_sha256=%s\n' "$visibility_hash"
printf 'code_process_sha256=%s\n' "$code_process_hash"
printf 'codeapi_unchanged=true\n'
