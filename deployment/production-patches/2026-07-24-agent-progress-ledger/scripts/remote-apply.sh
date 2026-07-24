#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:?stage directory is required}"
source_revision="${2:?source revision is required}"
timestamp="$(date +%Y%m%d%H%M%S)"
release_dir="/opt/librechat/agent-progress-ledger/${source_revision:0:12}-$timestamp"
compose_dir="/opt/librechat"
compose_override="$compose_dir/compose.override.yaml"
compose_backup="$compose_override.bak-$timestamp"
backup_id="agent-progress-ledger-${source_revision:0:12}-$timestamp"
expected_baseline="615c030c56c62d9ce90f92d3591fb99d7fda29a058daa0b4076850bb6fc5f182"

api_index_src="$stage_dir/api-index.cjs"
normalizer_src="$stage_dir/tool-call-normalizer.cjs"
progress_ledger_src="$stage_dir/tool-progress-ledger.cjs"
mongo_config_src="$stage_dir/mongo-config.js"

for file in "$api_index_src" "$normalizer_src" "$progress_ledger_src" "$mongo_config_src" "$compose_override"; do
  test -f "$file"
done

node --check "$api_index_src"
node --check "$normalizer_src"
node --check "$progress_ledger_src"
node --check "$mongo_config_src"

current_hash="$(docker exec LibreChat-API sha256sum /app/packages/api/dist/index.cjs | awk '{print $1}')"
test "$current_hash" = "$expected_baseline"

api_index_hash="$(sha256sum "$api_index_src" | awk '{print $1}')"
normalizer_hash="$(sha256sum "$normalizer_src" | awk '{print $1}')"
progress_ledger_hash="$(sha256sum "$progress_ledger_src" | awk '{print $1}')"
codeapi_id_before="$(docker inspect LibreChat-CodeAPI --format '{{.Id}}')"
codeapi_started_before="$(docker inspect LibreChat-CodeAPI --format '{{.State.StartedAt}}')"

run_mongo_mode() {
  local mode="$1"
  docker exec -i \
    -e AGENT_PROGRESS_LEDGER_MODE="$mode" \
    -e AGENT_PROGRESS_LEDGER_BACKUP_ID="$backup_id" \
    chat-mongodb mongosh --quiet LibreChat --file /dev/stdin <"$mongo_config_src"
}

mongo_preflight="$(run_mongo_mode preflight | tail -n 1)"
[[ "$mongo_preflight" == preflight=ok* ]]

cp -a "$compose_override" "$compose_backup"
mkdir -p "$release_dir"
install -m 0444 "$api_index_src" "$release_dir/api-index.cjs"
install -m 0444 "$normalizer_src" "$release_dir/tool-call-normalizer.cjs"
install -m 0444 "$progress_ledger_src" "$release_dir/tool-progress-ledger.cjs"
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
    '/app/packages/api/dist/index.cjs',
    '/app/packages/api/dist/tool-call-normalizer.cjs',
    '/app/packages/api/dist/tool-progress-ledger.cjs',
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
    f'{release_dir}/tool-call-normalizer.cjs:/app/packages/api/dist/tool-call-normalizer.cjs:ro',
    f'{release_dir}/tool-progress-ledger.cjs:/app/packages/api/dist/tool-progress-ledger.cjs:ro',
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

docker exec LibreChat-API node --check /app/packages/api/dist/index.cjs
docker exec LibreChat-API node --check /app/packages/api/dist/tool-call-normalizer.cjs
docker exec LibreChat-API node --check /app/packages/api/dist/tool-progress-ledger.cjs
test "$(docker exec LibreChat-API sha256sum /app/packages/api/dist/index.cjs | awk '{print $1}')" = "$api_index_hash"
test "$(docker exec LibreChat-API sha256sum /app/packages/api/dist/tool-call-normalizer.cjs | awk '{print $1}')" = "$normalizer_hash"
test "$(docker exec LibreChat-API sha256sum /app/packages/api/dist/tool-progress-ledger.cjs | awk '{print $1}')" = "$progress_ledger_hash"
test "$(run_mongo_mode verify | tail -n 1 | cut -d' ' -f1)" = "verify=ok"

test "$(docker inspect LibreChat-CodeAPI --format '{{.Id}}')" = "$codeapi_id_before"
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.StartedAt}}')" = "$codeapi_started_before"
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.Health.Status}}')" = "healthy"
curl -ksSf https://152.32.172.162.sslip.io/ >/dev/null

trap - ERR
printf 'timestamp=%s\n' "$timestamp"
printf 'release_dir=%s\n' "$release_dir"
printf 'compose_backup=%s\n' "$compose_backup"
printf 'mongo_backup_id=%s\n' "$backup_id"
printf 'api_index_sha256=%s\n' "$api_index_hash"
printf 'normalizer_sha256=%s\n' "$normalizer_hash"
printf 'progress_ledger_sha256=%s\n' "$progress_ledger_hash"
printf 'codeapi_unchanged=true\n'
