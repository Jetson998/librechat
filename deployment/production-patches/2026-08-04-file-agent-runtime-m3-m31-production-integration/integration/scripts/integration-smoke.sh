#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$INTEGRATION_DIR/.env.integration}"
COMPOSE_FILE="$INTEGRATION_DIR/compose.integration.yaml"

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

set -a
if [[ -f "$STATE_DIR/config/integration.paths.env" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_DIR/config/integration.paths.env"
fi
set +a
EVIDENCE_DIR="${INTEGRATION_EVIDENCE_DIR:?INTEGRATION_EVIDENCE_DIR is required after integration-up}"
mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}")

require_service() {
  local service="$1"
  local container_id status health
  container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    printf 'service %s is not running\n' "$service" >&2
    return 1
  fi
  status="$(docker inspect "$container_id" --format '{{.State.Status}}' 2>/dev/null || true)"
  health="$(docker inspect "$container_id" --format '{{with (index .State "Health")}}{{.Status}}{{else}}unreported{{end}}' 2>/dev/null || true)"
  printf 'service=%s status=%s health=%s\n' "$service" "$status" "$health"
  [[ "$status" == running ]] || return 1
  case "$service" in
    codeapi) [[ "$health" == healthy || "$health" == unreported ]] ;;
    *) [[ "$health" == healthy ]] ;;
  esac
}

for service in mongodb codeapi fake-model-relay file-agent-runtime api; do
  require_service "$service"
done > "$EVIDENCE_DIR/operator-service-smoke.txt"

api_response="$EVIDENCE_DIR/operator-api-config.json"
curl --silent --show-error --fail --output "$api_response" \
  "http://127.0.0.1:${INTEGRATION_API_PORT:-3081}/api/config"
chmod 600 "$api_response"

marker="$EVIDENCE_DIR/api-overlay-marker.json"
if [[ ! -f "$marker" ]]; then
  "${compose[@]}" exec -T api cat /tmp/file-agent-integration-api-overlay.json > "$marker"
fi
python3 - "$marker" "$FILE_AGENT_RUNTIME_SOURCE_REVISION" "$INTEGRATION_HARNESS_REVISION" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

value = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
if value.get('marker') != 'file-agent-api-overlay-loaded':
    raise SystemExit('API overlay startup marker is missing')
if not value.get('apiOverlay', {}).get('files'):
    raise SystemExit('API overlay startup marker has no manifest files')
if value.get('runtimeSourceRevision') != sys.argv[2]:
    raise SystemExit('API overlay marker Runtime source revision mismatch')
if value.get('integrationHarnessRevision') != sys.argv[3]:
    raise SystemExit('API overlay marker harness revision mismatch')
print('api_overlay_marker=passed')
PY

relay_response="$EVIDENCE_DIR/fake-relay-smoke-response.json"
relay_status="$(curl --silent --show-error --output "$relay_response" --write-out '%{http_code}' \
  -X POST "http://127.0.0.1:${INTEGRATION_FAKE_RELAY_PORT:-8788}/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer integration-relay-smoke-key' \
  -H 'idempotency-key: integration-ops-smoke-provider-1' \
  --data '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"return a deterministic empty integration plan"}],"metadata":{"operation":"ops-smoke"}}')"
chmod 600 "$relay_response"
if [[ "$relay_status" != 200 ]]; then
  printf 'Fake Relay smoke returned HTTP %s\n' "$relay_status" >&2
  exit 4
fi

codeapi_response="$EVIDENCE_DIR/codeapi-smoke-response.json"
codeapi_status="$(curl --silent --show-error --output "$codeapi_response" --write-out '%{http_code}' \
  -X POST "http://127.0.0.1:${INTEGRATION_CODEAPI_PORT:-8001}/exec" \
  -H 'content-type: application/json' \
  --data '{"lang":"bash","code":"printf integration-codeapi-smoke-ok","session_id":"integration-ops-smoke","files":[]}' || true)"
chmod 600 "$codeapi_response"
if [[ "$codeapi_status" != 200 ]]; then
  printf 'real CodeAPI /exec smoke returned HTTP %s\n' "$codeapi_status" >&2
  exit 5
fi

python3 - "$codeapi_response" "$EVIDENCE_DIR/codeapi-smoke-summary.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

response = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
exit_code = response.get('exitCode', response.get('exit_code', 0 if not response.get('error') else 1))
if exit_code != 0:
    raise SystemExit(f'CodeAPI smoke command failed with exit code {exit_code!r}')
summary = {
    'status': 'passed',
    'responseFields': sorted(response) if isinstance(response, dict) else [],
    'exitCode': exit_code,
    'sessionId': response.get('session_id') if isinstance(response, dict) else None,
    'artifactCount': len(response.get('files', [])) if isinstance(response, dict) and isinstance(response.get('files'), list) else 0,
}
Path(sys.argv[2]).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print('codeapi_exec_smoke=passed')
PY
chmod 600 "$EVIDENCE_DIR/codeapi-smoke-summary.json"

if [[ -f "$STATE_DIR/fake-relay/requests.ndjson" ]]; then
  cp "$STATE_DIR/fake-relay/requests.ndjson" "$EVIDENCE_DIR/fake-relay-requests.ndjson"
  chmod 600 "$EVIDENCE_DIR/fake-relay-requests.ndjson"
fi

# The developer E2E rewrites the disposable allowlist after registering its
# users, then restarts only the API so the startup-loaded allowlist is refreshed.
# Prove that exact environment operation before handoff without creating an
# Agent, uploading a file or exercising any business route.
protected_before="$EVIDENCE_DIR/protected-service-ids-before-api-restart.txt"
protected_after="$EVIDENCE_DIR/protected-service-ids-after-api-restart.txt"
api_restart_evidence="$EVIDENCE_DIR/api-restart-smoke.txt"
: > "$protected_before"
: > "$api_restart_evidence"
chmod 600 "$protected_before" "$api_restart_evidence"
for service in mongodb codeapi fake-model-relay file-agent-runtime; do
  container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    printf 'protected service missing before API restart: %s\n' "$service" >&2
    exit 6
  fi
  printf '%s=%s\n' "$service" "$container_id" >> "$protected_before"
done

api_container_before="$("${compose[@]}" ps -q api 2>/dev/null || true)"
if [[ -z "$api_container_before" ]]; then
  printf 'API container missing before restart smoke\n' >&2
  exit 6
fi
api_started_before="$(docker inspect "$api_container_before" --format '{{.State.StartedAt}}')"
api_stop_timeout="$(docker inspect "$api_container_before" --format '{{json .HostConfig.StopTimeout}}')"
if [[ "$api_stop_timeout" != 10 ]]; then
  printf 'integration API stop timeout is not bounded to 10 seconds: %s\n' "$api_stop_timeout" >&2
  exit 6
fi

restart_started_epoch="$(date +%s)"
printf 'status=started\napi_container_before=%s\napi_started_before=%s\napi_stop_timeout_seconds=%s\n' \
  "$api_container_before" "$api_started_before" "$api_stop_timeout" > "$api_restart_evidence"
"${compose[@]}" restart --timeout 10 api >> "$api_restart_evidence" 2>&1

restart_deadline=$((SECONDS + 180))
api_ready=false
while (( SECONDS < restart_deadline )); do
  api_container_after="$("${compose[@]}" ps -q api 2>/dev/null || true)"
  if [[ -n "$api_container_after" ]]; then
    api_status="$(docker inspect "$api_container_after" --format '{{.State.Status}}' 2>/dev/null || true)"
    api_health="$(docker inspect "$api_container_after" --format '{{with (index .State "Health")}}{{.Status}}{{else}}unreported{{end}}' 2>/dev/null || true)"
    if [[ "$api_status" == running && "$api_health" == healthy ]] \
      && curl --silent --show-error --fail --output /dev/null \
        "http://127.0.0.1:${INTEGRATION_API_PORT:-3081}/readyz" \
      && curl --silent --show-error --fail --output /dev/null \
        "http://127.0.0.1:${INTEGRATION_API_PORT:-3081}/api/config"; then
      api_ready=true
      break
    fi
  fi
  sleep 2
done
if [[ "$api_ready" != true ]]; then
  printf 'status=failed\nreason=api_not_ready_after_bounded_restart\n' >> "$api_restart_evidence"
  printf 'integration API did not become ready after bounded restart\n' >&2
  exit 6
fi

api_container_after="$("${compose[@]}" ps -q api)"
api_started_after="$(docker inspect "$api_container_after" --format '{{.State.StartedAt}}')"
restart_ready_epoch="$(date +%s)"
if [[ "$api_container_after" != "$api_container_before" || "$api_started_after" == "$api_started_before" ]]; then
  printf 'status=failed\nreason=api_restart_identity_or_started_at_mismatch\n' >> "$api_restart_evidence"
  printf 'integration API restart identity/timestamp check failed\n' >&2
  exit 6
fi

: > "$protected_after"
chmod 600 "$protected_after"
for service in mongodb codeapi fake-model-relay file-agent-runtime; do
  container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
  printf '%s=%s\n' "$service" "$container_id" >> "$protected_after"
done
if ! cmp -s "$protected_before" "$protected_after"; then
  printf 'status=failed\nreason=protected_service_identity_changed\n' >> "$api_restart_evidence"
  printf 'protected service identity changed during API restart smoke\n' >&2
  exit 6
fi

marker_after_restart="$EVIDENCE_DIR/api-overlay-marker-after-restart.json"
"${compose[@]}" exec -T api cat /tmp/file-agent-integration-api-overlay.json > "$marker_after_restart"
python3 - "$marker_after_restart" "$FILE_AGENT_RUNTIME_SOURCE_REVISION" "$INTEGRATION_HARNESS_REVISION" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

value = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
if value.get('marker') != 'file-agent-api-overlay-loaded':
    raise SystemExit('API overlay marker is missing after bounded restart')
if value.get('runtimeSourceRevision') != sys.argv[2]:
    raise SystemExit('API overlay Runtime revision mismatch after bounded restart')
if value.get('integrationHarnessRevision') != sys.argv[3]:
    raise SystemExit('API overlay harness revision mismatch after bounded restart')
print('api_overlay_marker_after_restart=passed')
PY
chmod 600 "$marker_after_restart"

printf 'status=passed\napi_container_after=%s\napi_started_after=%s\nrestart_to_ready_seconds=%s\nprotected_service_identity=unchanged\n' \
  "$api_container_after" "$api_started_after" "$((restart_ready_epoch - restart_started_epoch))" \
  >> "$api_restart_evidence"

printf 'operator_smoke=passed\n'
printf 'api_restart_smoke=passed\n'
printf 'evidence_dir=%s\n' "$EVIDENCE_DIR"
