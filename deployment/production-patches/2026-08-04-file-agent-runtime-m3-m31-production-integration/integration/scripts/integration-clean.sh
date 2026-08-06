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

case "$COMPOSE_PROJECT_NAME" in
  file-agent-integration|file-agent-integration-*) ;;
  *)
    printf 'COMPOSE_PROJECT_NAME must use the file-agent-integration prefix\n' >&2
    exit 3
    ;;
esac

STATE_DIR="${INTEGRATION_STATE_DIR:-$INTEGRATION_DIR/.state}"
STATE_DIR="$(python3 - "$STATE_DIR" "$INTEGRATION_DIR" <<'PY'
import os
import sys

value = os.path.abspath(sys.argv[1])
integration_dir = os.path.abspath(sys.argv[2])
if value == os.path.dirname(value):
    raise SystemExit("refusing to clean a filesystem root")
if value == integration_dir or value == os.path.dirname(integration_dir):
    raise SystemExit("refusing to clean the integration directory or its parent")
if os.path.lexists(value) and os.path.islink(value):
    raise SystemExit("integration state root must not be a symbolic link")
print(value)
PY
)"
if [[ ! -d "$STATE_DIR" || -L "$STATE_DIR" || ! -f "$STATE_DIR/.integration-state" || -L "$STATE_DIR/.integration-state" ]]; then
  printf 'refusing to clean a path that is not an integration state directory\n' >&2
  exit 3
fi
if [[ "$(tr -d '\r\n' < "$STATE_DIR/.integration-state")" != file-agent-integration-state-v1 ]]; then
  printf 'integration state marker is not recognized\n' >&2
  exit 3
fi

PATHS_ENV="$STATE_DIR/config/integration.paths.env"
API_ENV="$STATE_DIR/config/api-runtime.env"
if [[ ! -f "$PATHS_ENV" || ! -f "$API_ENV" ]]; then
  printf 'integration state is incomplete; refusing cleanup\n' >&2
  exit 3
fi
set -a
# shellcheck disable=SC1090
source "$PATHS_ENV"
# shellcheck disable=SC1090
source "$API_ENV"
set +a

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME")
REPO_ROOT="$(cd -- "$INTEGRATION_DIR/../../../../" && pwd)"
export REPO_ROOT
"${compose[@]}" down --volumes --remove-orphans

if [[ -n "$("${compose[@]}" ps -aq 2>/dev/null || true)" ]]; then
  printf 'integration containers remain after compose down\n' >&2
  exit 4
fi
if [[ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" 2>/dev/null || true)" ]]; then
  printf 'integration volumes remain after compose down\n' >&2
  exit 5
fi

rm -rf -- "$STATE_DIR"
if [[ -e "$STATE_DIR" || -L "$STATE_DIR" ]]; then
  printf 'integration state directory could not be removed\n' >&2
  exit 6
fi

printf 'integration_environment=cleaned\n'
