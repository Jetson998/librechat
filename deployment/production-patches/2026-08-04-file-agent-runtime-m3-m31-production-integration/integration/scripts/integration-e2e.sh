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
  printf 'integration environment state is missing or unsafe\n' >&2
  exit 3
fi
if [[ "$(tr -d '\r\n' < "$STATE_DIR/.integration-state")" != file-agent-integration-state-v1 ]]; then
  printf 'integration environment state marker is not recognized\n' >&2
  exit 3
fi
PATHS_ENV="$STATE_DIR/config/integration.paths.env"
API_ENV="$STATE_DIR/config/api-runtime.env"
if [[ ! -f "$PATHS_ENV" || ! -f "$API_ENV" ]]; then
  printf 'integration environment is not running; execute integration-up.sh first\n' >&2
  exit 3
fi
set -a
# shellcheck disable=SC1090
source "$PATHS_ENV"
# shellcheck disable=SC1090
source "$API_ENV"
set +a

export REPO_ROOT="$(cd -- "$INTEGRATION_DIR/../../../../" && pwd)"
export INTEGRATION_COMPOSE_FILE="$COMPOSE_FILE"
export INTEGRATION_ENV_FILE="$ENV_FILE"
INTEGRATION_FIXTURE_SOURCE="${INTEGRATION_FIXTURE_SOURCE:-$INTEGRATION_DIR/fixtures/minimal-source.docx}"
if [[ -L "$INTEGRATION_FIXTURE_SOURCE" || ! -f "$INTEGRATION_FIXTURE_SOURCE" ]]; then
  printf 'fixed integration fixture is missing or unsafe: %s\n' "$INTEGRATION_FIXTURE_SOURCE" >&2
  exit 3
fi
export INTEGRATION_FIXTURE_ONE="$STATE_DIR/api-uploads/integration-one.docx"
export INTEGRATION_FIXTURE_TWO="$STATE_DIR/api-uploads/integration-two.docx"

trap_cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$status" -eq 0 && "${INTEGRATION_KEEP_STATE:-false}" != true ]]; then
    "$SCRIPT_DIR/integration-clean.sh" "$ENV_FILE" || status=$?
  elif [[ "$status" -ne 0 ]]; then
    printf 'integration failure evidence retained under: %s\n' "$INTEGRATION_EVIDENCE_DIR" >&2
  fi
  exit "$status"
}
trap trap_cleanup EXIT

cp "$INTEGRATION_FIXTURE_SOURCE" "$INTEGRATION_FIXTURE_ONE"
cp "$INTEGRATION_FIXTURE_SOURCE" "$INTEGRATION_FIXTURE_TWO"
chmod 0644 "$INTEGRATION_FIXTURE_ONE" "$INTEGRATION_FIXTURE_TWO"

curl --fail --silent --show-error "http://127.0.0.1:${INTEGRATION_API_PORT}/api/config" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:${INTEGRATION_FAKE_RELAY_PORT}/healthz" >/dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" \
  exec -T file-agent-runtime node -e "fetch('http://127.0.0.1:8790/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

set +e
node "$SCRIPT_DIR/integration-e2e.mjs"
runner_status=$?
set -e

# Preserve the runner's status and retain the state directory on failure, but
# still collect the best available redacted evidence before a human performs
# integration-down.sh. A collection failure must never hide the original
# business assertion failure.
collect_status=0
"$SCRIPT_DIR/collect-evidence.sh" "$ENV_FILE" || collect_status=$?
if [[ "$runner_status" -ne 0 ]]; then
  printf 'integration_e2e_runner_status=%s\n' "$runner_status" >&2
  exit "$runner_status"
fi
if [[ "$collect_status" -ne 0 ]]; then
  printf 'integration_e2e_collect_status=%s\n' "$collect_status" >&2
  exit "$collect_status"
fi
printf 'integration_e2e=passed\n'
printf 'evidence_dir=%s\n' "$INTEGRATION_EVIDENCE_DIR"
