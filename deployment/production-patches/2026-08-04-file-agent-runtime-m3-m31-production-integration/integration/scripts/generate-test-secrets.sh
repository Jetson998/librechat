#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$INTEGRATION_DIR/.env.integration}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

STATE_DIR="${INTEGRATION_STATE_DIR:-$INTEGRATION_DIR/.state}"
STATE_DIR="$(python3 - "$STATE_DIR" "$INTEGRATION_DIR" <<'PY'
import os
import sys

value = os.path.abspath(sys.argv[1])
integration_dir = os.path.abspath(sys.argv[2])
if value == os.path.dirname(value):
    raise SystemExit("refusing to use a filesystem root as integration state")
if value == integration_dir or value == os.path.dirname(integration_dir):
    raise SystemExit("refusing to use the integration directory or its parent as state")
if os.path.lexists(value) and os.path.islink(value):
    raise SystemExit("integration state root must not be a symbolic link")
if os.path.lexists(value) and not os.path.isdir(value):
    raise SystemExit("integration state root must be a directory")
parent = os.path.dirname(value)
if os.path.lexists(parent) and os.path.islink(parent):
    raise SystemExit("integration state parent must not be a symbolic link")
print(value)
PY
)"

SECRETS_DIR="$STATE_DIR/secrets"
CONFIG_DIR="$STATE_DIR/config"
for directory in "$SECRETS_DIR" "$CONFIG_DIR"; do
  if [[ -L "$directory" ]]; then
    printf 'integration secret/config directory must not be a symbolic link: %s\n' "$directory" >&2
    exit 1
  fi
  if [[ -e "$directory" && ! -d "$directory" ]]; then
    printf 'integration secret/config path must be a directory: %s\n' "$directory" >&2
    exit 1
  fi
done
mkdir -p "$SECRETS_DIR" "$CONFIG_DIR"
chmod 700 "$STATE_DIR" "$SECRETS_DIR" "$CONFIG_DIR"
umask 077

if [[ -L "$STATE_DIR/.integration-state" || ( -e "$STATE_DIR/.integration-state" && ! -f "$STATE_DIR/.integration-state" ) ]]; then
  printf 'integration state marker must be a regular file: %s\n' "$STATE_DIR/.integration-state" >&2
  exit 1
fi
printf '%s\n' file-agent-integration-state-v1 > "$STATE_DIR/.integration-state"
chmod 600 "$STATE_DIR/.integration-state"

write_random() {
  local destination="$1"
  local bytes="$2"
  if [[ -e "$destination" && ! -f "$destination" ]]; then
    printf 'refusing to replace non-regular test secret: %s\n' "$destination" >&2
    exit 1
  fi
  if [[ ! -s "$destination" ]]; then
    openssl rand -hex "$bytes" > "$destination"
  fi
  chmod 600 "$destination"
  [[ -f "$destination" && -s "$destination" && ! -L "$destination" ]]
}

write_random "$SECRETS_DIR/file-agent-service-scope" 32
write_random "$SECRETS_DIR/file-agent-provider-key-integration" 32

if [[ -e "$SECRETS_DIR/file-agent-allowlist" && ! -f "$SECRETS_DIR/file-agent-allowlist" ]]; then
  printf 'refusing to replace non-regular allowlist: %s\n' "$SECRETS_DIR/file-agent-allowlist" >&2
  exit 1
fi
if [[ ! -s "$SECRETS_DIR/file-agent-allowlist" ]]; then
  # The API initially starts with a syntactically valid non-empty allowlist.
  # Operator smoke provisions one disposable administrator, writes its internal
  # ID, and recreates only the test API before handing the environment to E2E.
  printf '%s\n' integration-bootstrap > "$SECRETS_DIR/file-agent-allowlist"
fi
chmod 600 "$SECRETS_DIR/file-agent-allowlist"

write_random "$CONFIG_DIR/api-creds-key" 32
write_random "$CONFIG_DIR/api-creds-iv" 16
write_random "$CONFIG_DIR/api-jwt-secret" 32
write_random "$CONFIG_DIR/api-jwt-refresh-secret" 32
write_random "$CONFIG_DIR/admin-panel-session-secret" 32

cat > "$CONFIG_DIR/api-runtime.env" <<EOF
INTEGRATION_RELAY_API_KEY=integration-fake-relay-key
INTEGRATION_API_CREDS_KEY=$(<"$CONFIG_DIR/api-creds-key")
INTEGRATION_API_CREDS_IV=$(<"$CONFIG_DIR/api-creds-iv")
INTEGRATION_API_JWT_SECRET=$(<"$CONFIG_DIR/api-jwt-secret")
INTEGRATION_API_JWT_REFRESH_SECRET=$(<"$CONFIG_DIR/api-jwt-refresh-secret")
INTEGRATION_ADMIN_PANEL_SESSION_SECRET=$(<"$CONFIG_DIR/admin-panel-session-secret")
EOF
chmod 600 "$CONFIG_DIR/api-runtime.env"

printf 'integration_test_secrets=ready\n'
printf 'state_dir=%s\n' "$STATE_DIR"
