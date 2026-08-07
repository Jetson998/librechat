#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$INTEGRATION_DIR/.env.integration}"
COMPOSE_FILE="$INTEGRATION_DIR/compose.integration.yaml"
REPO_ROOT="$(cd -- "$INTEGRATION_DIR/../../../../" && pwd)"
export REPO_ROOT

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'missing integration env file: %s\n' "$ENV_FILE" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

STATE_DIR="${INTEGRATION_STATE_DIR:-$INTEGRATION_DIR/.state}"
if [[ -L "$STATE_DIR" || ! -d "$STATE_DIR" || -L "$STATE_DIR/.integration-state" || ! -f "$STATE_DIR/.integration-state" ]]; then
  printf 'integration state is missing or unsafe\n' >&2
  exit 3
fi
if [[ "$(tr -d '\r\n' < "$STATE_DIR/.integration-state")" != file-agent-integration-state-v1 ]]; then
  printf 'integration state marker is not recognized\n' >&2
  exit 3
fi

PATHS_ENV="$STATE_DIR/config/integration.paths.env"
API_ENV="$STATE_DIR/config/api-runtime.env"
if [[ ! -f "$PATHS_ENV" || ! -f "$API_ENV" ]]; then
  printf 'integration state is incomplete\n' >&2
  exit 3
fi
set -a
# shellcheck disable=SC1090
source "$PATHS_ENV"
# shellcheck disable=SC1090
source "$API_ENV"
set +a

EVIDENCE_DIR="${INTEGRATION_EVIDENCE_DIR:?INTEGRATION_EVIDENCE_DIR is required}"
EVIDENCE_FILE="${2:-$EVIDENCE_DIR/api-allowlist-reload.txt}"
ALLOWLIST_FILE="${FILE_AGENT_ALLOWLIST_HOST_FILE:?FILE_AGENT_ALLOWLIST_HOST_FILE is required}"
if [[ -L "$ALLOWLIST_FILE" || ! -f "$ALLOWLIST_FILE" || ! -s "$ALLOWLIST_FILE" ]]; then
  printf 'integration allowlist must be a non-empty regular file\n' >&2
  exit 3
fi
mkdir -p "$(dirname -- "$EVIDENCE_FILE")"
touch "$EVIDENCE_FILE"
chmod 600 "$EVIDENCE_FILE"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}")
protected_services=(mongodb codeapi fake-model-relay file-agent-runtime admin-panel)

service_ids() {
  local service container_id
  for service in "${protected_services[@]}"; do
    container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      printf 'protected integration service is missing: %s\n' "$service" >&2
      return 1
    fi
    printf '%s=%s\n' "$service" "$container_id"
  done
}

record_failure() {
  local status=$?
  trap - EXIT
  printf 'status=failed\nexit_code=%s\n' "$status" >> "$EVIDENCE_FILE"
  "${compose[@]}" ps >> "$EVIDENCE_FILE" 2>&1 || true
  exit "$status"
}
trap record_failure EXIT

protected_before="$(service_ids)"
api_container_before="$("${compose[@]}" ps -q api 2>/dev/null || true)"
if [[ -z "$api_container_before" ]]; then
  printf 'integration API container is missing before allowlist reload\n' >&2
  exit 4
fi
api_started_before="$(docker inspect "$api_container_before" --format '{{.State.StartedAt}}')"
allowlist_entries="$(awk 'NF { count += 1 } END { print count + 0 }' "$ALLOWLIST_FILE")"
allowlist_sha256="$(shasum -a 256 "$ALLOWLIST_FILE")"
allowlist_sha256="${allowlist_sha256%% *}"
if [[ "$allowlist_entries" -lt 1 ]]; then
  printf 'integration allowlist has no user identities\n' >&2
  exit 4
fi

started_epoch="$(date +%s)"
{
  printf 'status=started\n'
  printf 'operation=force_recreate_disposable_api_after_allowlist_update\n'
  printf 'reason=avoid_unbounded_repeated_graceful_restart\n'
  printf 'api_container_before=%s\n' "$api_container_before"
  printf 'api_started_before=%s\n' "$api_started_before"
  printf 'allowlist_entries=%s\n' "$allowlist_entries"
  printf 'allowlist_sha256=%s\n' "$allowlist_sha256"
  printf 'protected_services_before_begin\n%s\nprotected_services_before_end\n' "$protected_before"
} > "$EVIDENCE_FILE"

# This environment is disposable and has no in-flight business task at this
# gate. A repeated graceful restart of the captured amd64 LibreChat API can
# remain in shutdown/startup for minutes under local emulation. Remove that
# lifecycle dependency: kill only the test API, remove only its container, and
# create one fresh API process against the already-running protected services.
"${compose[@]}" kill -s SIGKILL api >> "$EVIDENCE_FILE" 2>&1
"${compose[@]}" rm -f api >> "$EVIDENCE_FILE" 2>&1
"${compose[@]}" up -d --no-deps api >> "$EVIDENCE_FILE" 2>&1

deadline=$((SECONDS + 300))
api_ready=false
api_status=missing
api_health=unreported
while (( SECONDS < deadline )); do
  api_container_after="$("${compose[@]}" ps -q api 2>/dev/null || true)"
  if [[ -n "$api_container_after" ]]; then
    api_status="$(docker inspect "$api_container_after" --format '{{.State.Status}}' 2>/dev/null || true)"
    api_health="$(docker inspect "$api_container_after" --format '{{with (index .State "Health")}}{{.Status}}{{else}}unreported{{end}}' 2>/dev/null || true)"
    if [[ "$api_status" == running && "$api_health" == healthy ]] \
      && curl --silent --show-error --fail --max-time 3 --output /dev/null \
        "http://127.0.0.1:${INTEGRATION_API_PORT:-3081}/readyz" \
      && curl --silent --show-error --fail --max-time 3 --output /dev/null \
        "http://127.0.0.1:${INTEGRATION_API_PORT:-3081}/api/config"; then
      api_ready=true
      break
    fi
  fi
  sleep 2
done
if [[ "$api_ready" != true ]]; then
  printf 'reason=api_not_ready_after_forced_recreation\napi_status=%s\napi_health=%s\n' \
    "$api_status" "$api_health" >> "$EVIDENCE_FILE"
  printf 'integration API did not become ready after forced recreation\n' >&2
  exit 5
fi

api_container_after="$("${compose[@]}" ps -q api)"
api_started_after="$(docker inspect "$api_container_after" --format '{{.State.StartedAt}}')"
if [[ "$api_container_after" == "$api_container_before" || "$api_started_after" == "$api_started_before" ]]; then
  printf 'reason=api_container_was_not_recreated\n' >> "$EVIDENCE_FILE"
  printf 'integration API recreation did not produce a new container/process\n' >&2
  exit 5
fi
if docker inspect "$api_container_before" >/dev/null 2>&1; then
  printf 'reason=old_api_container_still_exists\n' >> "$EVIDENCE_FILE"
  printf 'old integration API container still exists after recreation\n' >&2
  exit 5
fi

protected_after="$(service_ids)"
if [[ "$protected_after" != "$protected_before" ]]; then
  printf 'reason=protected_service_identity_changed\n' >> "$EVIDENCE_FILE"
  printf 'protected integration service identity changed during API recreation\n' >&2
  exit 6
fi

marker="$EVIDENCE_DIR/api-overlay-marker-after-allowlist-reload.json"
"${compose[@]}" exec -T api cat /tmp/file-agent-integration-api-overlay.json > "$marker"
python3 - "$marker" "$FILE_AGENT_RUNTIME_SOURCE_REVISION" "$INTEGRATION_HARNESS_REVISION" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

value = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
if value.get('marker') != 'file-agent-api-overlay-loaded':
    raise SystemExit('API overlay marker is missing after allowlist reload')
if value.get('runtimeSourceRevision') != sys.argv[2]:
    raise SystemExit('API overlay Runtime source revision mismatch after allowlist reload')
if value.get('integrationHarnessRevision') != sys.argv[3]:
    raise SystemExit('API overlay harness revision mismatch after allowlist reload')
print('api_overlay_marker_after_allowlist_reload=passed')
PY
chmod 600 "$marker"

finished_epoch="$(date +%s)"
{
  printf 'status=passed\n'
  printf 'api_container_after=%s\n' "$api_container_after"
  printf 'api_started_after=%s\n' "$api_started_after"
  printf 'recreate_to_ready_seconds=%s\n' "$((finished_epoch - started_epoch))"
  printf 'readyz=passed\napi_config=passed\n'
  printf 'overlay_marker=passed\n'
  printf 'protected_service_identity=unchanged\n'
  printf 'protected_services_after_begin\n%s\nprotected_services_after_end\n' "$protected_after"
} >> "$EVIDENCE_FILE"

trap - EXIT
printf 'api_allowlist_reload=passed\n'
printf 'api_container=%s\n' "$api_container_after"
printf 'evidence_file=%s\n' "$EVIDENCE_FILE"
