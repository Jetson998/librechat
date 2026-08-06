#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PATCH_DIR="$(cd -- "$INTEGRATION_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$PATCH_DIR/../../.." && pwd)"
ENV_FILE="${1:-$INTEGRATION_DIR/.env.integration}"
COMPOSE_FILE="$INTEGRATION_DIR/compose.integration.yaml"
API_OVERLAY_MANIFEST="$INTEGRATION_DIR/config/api-overlay-manifest.json"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'missing integration env file: %s\n' "$ENV_FILE" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${COMPOSE_PROJECT_NAME:=file-agent-integration}"
: "${LIBRECHAT_API_IMAGE:?LIBRECHAT_API_IMAGE is required}"
: "${CODEAPI_IMAGE:?CODEAPI_IMAGE is required}"
: "${FILE_AGENT_RUNTIME_IMAGE:?FILE_AGENT_RUNTIME_IMAGE is required}"
: "${FILE_AGENT_RUNTIME_IMAGE_ID:?FILE_AGENT_RUNTIME_IMAGE_ID is required}"
: "${FILE_AGENT_RUNTIME_SOURCE_REVISION:?FILE_AGENT_RUNTIME_SOURCE_REVISION is required}"
: "${INTEGRATION_HARNESS_REVISION:?INTEGRATION_HARNESS_REVISION is required}"
: "${INTEGRATION_MODEL:=gpt-5.6-sol}"
: "${INTEGRATION_SECOND_MODEL:=claude-fable-5}"
: "${INTEGRATION_LIBRECHAT_ENDPOINT:=Muskapis-openai}"
: "${INTEGRATION_PROVIDER_ENDPOINT:=Muskapis-openai}"
: "${INTEGRATION_PROVIDER_ROUTE_REF:=custom:Muskapis-openai}"

if [[ ! "$FILE_AGENT_RUNTIME_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'FILE_AGENT_RUNTIME_SOURCE_REVISION must be a full 40-character Git revision\n' >&2
  exit 3
fi
if [[ ! "$INTEGRATION_HARNESS_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'INTEGRATION_HARNESS_REVISION must be a full 40-character Git revision\n' >&2
  exit 3
fi

checkout_revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if ! git -C "$REPO_ROOT" cat-file -e "$FILE_AGENT_RUNTIME_SOURCE_REVISION^{commit}"; then
  printf 'Runtime source revision is unavailable in this checkout: %s\n' \
    "$FILE_AGENT_RUNTIME_SOURCE_REVISION" >&2
  exit 4
fi
if ! git -C "$REPO_ROOT" cat-file -e "$INTEGRATION_HARNESS_REVISION^{commit}"; then
  printf 'Integration harness revision is unavailable in this checkout: %s\n' \
    "$INTEGRATION_HARNESS_REVISION" >&2
  exit 4
fi
if [[ "$checkout_revision" != "$INTEGRATION_HARNESS_REVISION" ]]; then
  printf 'Integration harness revision does not match this checkout: harness=%s checkout=%s\n' \
    "$INTEGRATION_HARNESS_REVISION" "$checkout_revision" >&2
  exit 4
fi
if ! git -C "$REPO_ROOT" merge-base --is-ancestor \
  "$FILE_AGENT_RUNTIME_SOURCE_REVISION" "$INTEGRATION_HARNESS_REVISION"; then
  printf 'Runtime source revision is not an ancestor of the integration harness revision: runtime=%s harness=%s\n' \
    "$FILE_AGENT_RUNTIME_SOURCE_REVISION" "$INTEGRATION_HARNESS_REVISION" >&2
  exit 4
fi
business_diff="$(git -C "$REPO_ROOT" diff --name-only \
  "$FILE_AGENT_RUNTIME_SOURCE_REVISION" "$INTEGRATION_HARNESS_REVISION" -- \
  services/file-agent-runtime services/librechat-file-agent-connector)"
if [[ -n "$business_diff" ]]; then
  printf 'Runtime/Connector business paths changed between frozen Runtime and harness revisions:\n%s\n' \
    "$business_diff" >&2
  exit 4
fi

if [[ -n "$(git -C "$REPO_ROOT" status --short -- services/file-agent-runtime services/librechat-file-agent-connector)" ]]; then
  printf 'tracked Runtime/Connector source paths are dirty; build from a committed revision\n' >&2
  exit 4
fi

case "$COMPOSE_PROJECT_NAME" in
  file-agent-integration|file-agent-integration-*) ;;
  *)
    printf 'COMPOSE_PROJECT_NAME must use the file-agent-integration prefix\n' >&2
    exit 3
    ;;
esac

if [[ "$INTEGRATION_LIBRECHAT_ENDPOINT" != Muskapis-openai \
  || "$INTEGRATION_PROVIDER_ENDPOINT" != Muskapis-openai \
  || "$INTEGRATION_PROVIDER_ROUTE_REF" != custom:Muskapis-openai ]]; then
  printf 'integration route map does not match the fixed File Agent route contract\n' >&2
  exit 3
fi

case "$INTEGRATION_MODEL" in
  gpt-5.6-sol|claude-fable-5) ;;
  *) printf 'INTEGRATION_MODEL is outside the production route allowlist\n' >&2; exit 3 ;;
esac
case "$INTEGRATION_SECOND_MODEL" in
  gpt-5.6-sol|claude-fable-5) ;;
  *) printf 'INTEGRATION_SECOND_MODEL is outside the production route allowlist\n' >&2; exit 3 ;;
esac

# Verify external images before creating state or test secrets. A missing
# CodeAPI archive/image must not leave credentials behind in a half-created
# integration run.
"$SCRIPT_DIR/import-codeapi-image.sh" "$ENV_FILE" >/dev/null
runtime_id="$(docker image inspect "$FILE_AGENT_RUNTIME_IMAGE" --format '{{.Id}}')"
if [[ "$runtime_id" != "$FILE_AGENT_RUNTIME_IMAGE_ID" ]]; then
  printf 'Runtime image identity mismatch: expected=%s actual=%s\n' "$FILE_AGENT_RUNTIME_IMAGE_ID" "$runtime_id" >&2
  exit 5
fi
runtime_platform="$(docker image inspect "$FILE_AGENT_RUNTIME_IMAGE" --format '{{.Os}}/{{.Architecture}}')"
if [[ "$runtime_platform" != linux/amd64 ]]; then
  printf 'Runtime candidate must be linux/amd64: %s\n' "$runtime_platform" >&2
  exit 6
fi
api_platform="$(docker image inspect --platform linux/amd64 "$LIBRECHAT_API_IMAGE" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true)"
if [[ "$api_platform" != linux/amd64 ]]; then
  docker pull --platform linux/amd64 "$LIBRECHAT_API_IMAGE" >/dev/null
  api_platform="$(docker image inspect --platform linux/amd64 "$LIBRECHAT_API_IMAGE" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true)"
fi
if [[ "$api_platform" != linux/amd64 ]]; then
  printf 'LibreChat API baseline must be linux/amd64: %s\n' "$api_platform" >&2
  exit 6
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
EVIDENCE_DIR="${INTEGRATION_EVIDENCE_DIR:-$INTEGRATION_DIR/runs/$(date -u +%Y%m%dT%H%M%SZ)-$FILE_AGENT_RUNTIME_SOURCE_REVISION-$INTEGRATION_HARNESS_REVISION}"

for state_child in config connector runtime-data codeapi-data fake-relay api-uploads api-logs audit secrets; do
  state_path="$STATE_DIR/$state_child"
  if [[ -L "$state_path" ]]; then
    printf 'integration state child must not be a symbolic link: %s\n' "$state_path" >&2
    exit 3
  fi
  if [[ -e "$state_path" && ! -d "$state_path" ]]; then
    printf 'integration state child must be a directory: %s\n' "$state_path" >&2
    exit 3
  fi
done

mkdir -p "$STATE_DIR" "$EVIDENCE_DIR" \
  "$STATE_DIR/config" "$STATE_DIR/connector" "$STATE_DIR/runtime-data" \
  "$STATE_DIR/codeapi-data" "$STATE_DIR/fake-relay" "$STATE_DIR/api-uploads" \
  "$STATE_DIR/api-logs" "$STATE_DIR/audit" "$STATE_DIR/secrets"
chmod 700 "$STATE_DIR" "$STATE_DIR/config" "$STATE_DIR/connector" \
  "$STATE_DIR/secrets" "$EVIDENCE_DIR"
# The state root is private, but the containers deliberately run as their
# image-defined non-root users. These bind-mount targets therefore need to be
# writable by an unknown container UID on a clean Linux host. They contain only
# disposable test data; secrets and configuration above remain private.
chmod 777 "$STATE_DIR/runtime-data" "$STATE_DIR/codeapi-data" "$STATE_DIR/fake-relay" \
  "$STATE_DIR/api-uploads" "$STATE_DIR/api-logs" "$STATE_DIR/audit"
if [[ -L "$STATE_DIR/.integration-state" || ( -e "$STATE_DIR/.integration-state" && ! -f "$STATE_DIR/.integration-state" ) ]]; then
  printf 'integration state marker must be a regular file: %s\n' "$STATE_DIR/.integration-state" >&2
  exit 3
fi
printf '%s\n' file-agent-integration-state-v1 > "$STATE_DIR/.integration-state"
chmod 600 "$STATE_DIR/.integration-state"

python3 "$SCRIPT_DIR/verify-api-overlay.py" \
  --repo-root "$REPO_ROOT" \
  --manifest "$API_OVERLAY_MANIFEST" \
  > "$EVIDENCE_DIR/api-overlay-check.json"

git -C "$REPO_ROOT" rev-parse HEAD > "$EVIDENCE_DIR/repository-head.txt"
git -C "$REPO_ROOT" status --short > "$EVIDENCE_DIR/repository-status.txt"
printf '%s\n' "$FILE_AGENT_RUNTIME_SOURCE_REVISION" > "$EVIDENCE_DIR/runtime-source-revision.txt"
printf '%s\n' "$INTEGRATION_HARNESS_REVISION" > "$EVIDENCE_DIR/integration-harness-revision.txt"
{
  printf 'runtimeSourceRevision=%s\n' "$FILE_AGENT_RUNTIME_SOURCE_REVISION"
  printf 'integrationHarnessRevision=%s\n' "$INTEGRATION_HARNESS_REVISION"
  printf 'checkoutRevision=%s\n' "$checkout_revision"
  printf 'runtimeConnectorBusinessDiff=empty\n'
} > "$EVIDENCE_DIR/integration-revisions.txt"
cp "$API_OVERLAY_MANIFEST" "$EVIDENCE_DIR/api-overlay-manifest.json"
chmod 600 "$EVIDENCE_DIR/api-overlay-manifest.json"
{
  printf 'runtime_reference=%s\n' "$FILE_AGENT_RUNTIME_IMAGE"
  printf 'runtime_image_id=%s\n' "$runtime_id"
  printf 'runtime_platform=%s\n' "$runtime_platform"
  printf 'codeapi_reference=%s\n' "$CODEAPI_IMAGE"
  printf 'codeapi_image_id=%s\n' "$(docker image inspect "$CODEAPI_IMAGE" --format '{{.Id}}')"
  printf 'codeapi_platform=%s/%s\n' \
    "$(docker image inspect "$CODEAPI_IMAGE" --format '{{.Os}}')" \
    "$(docker image inspect "$CODEAPI_IMAGE" --format '{{.Architecture}}')"
  printf 'api_reference=%s\n' "$LIBRECHAT_API_IMAGE"
  printf 'api_image_id=%s\n' "$(docker image inspect --platform linux/amd64 "$LIBRECHAT_API_IMAGE" --format '{{.Id}}')"
  printf 'api_platform=%s\n' "$api_platform"
} > "$EVIDENCE_DIR/image-identities.txt"

"$SCRIPT_DIR/generate-test-secrets.sh" "$ENV_FILE" >/dev/null
# shellcheck disable=SC1090
set -a
source "$STATE_DIR/config/api-runtime.env"
set +a

ARCHIVE_SCRIPT="$PATCH_DIR/scripts/package-connector-archive.py"
python3 "$ARCHIVE_SCRIPT" \
  --source-root "$REPO_ROOT/services/librechat-file-agent-connector" \
  --output "$STATE_DIR/connector.tar.gz" \
  --manifest-output "$STATE_DIR/connector.manifest.json" \
  > "$EVIDENCE_DIR/connector-package.json"
python3 "$SCRIPT_DIR/extract-connector-archive.py" \
  --archive "$STATE_DIR/connector.tar.gz" \
  --manifest "$STATE_DIR/connector.manifest.json" \
  --destination "$STATE_DIR/connector" \
  > "$EVIDENCE_DIR/connector-extract.json"

export REPO_ROOT FILE_AGENT_RUNTIME_SOURCE_REVISION INTEGRATION_HARNESS_REVISION
export INTEGRATION_STATE_DIR="$STATE_DIR" INTEGRATION_EVIDENCE_DIR="$EVIDENCE_DIR"
export INTEGRATION_CONNECTOR_HOST_DIR="$STATE_DIR/connector"
export INTEGRATION_RUNTIME_DATA_HOST_DIR="$STATE_DIR/runtime-data"
export INTEGRATION_CODEAPI_DATA_HOST_DIR="$STATE_DIR/codeapi-data"
export INTEGRATION_FAKE_RELAY_STATE_HOST_DIR="$STATE_DIR/fake-relay"
export INTEGRATION_API_UPLOADS_HOST_DIR="$STATE_DIR/api-uploads"
export INTEGRATION_API_LOGS_HOST_DIR="$STATE_DIR/api-logs"
export FILE_AGENT_SERVICE_SCOPE_SECRET_HOST_FILE="$STATE_DIR/secrets/file-agent-service-scope"
export FILE_AGENT_ALLOWLIST_HOST_FILE="$STATE_DIR/secrets/file-agent-allowlist"
export FILE_AGENT_PROVIDER_KEY_HOST_FILE="$STATE_DIR/secrets/file-agent-provider-key-integration"
export INTEGRATION_PROVIDER_ROUTE_MAP_HOST_FILE="$STATE_DIR/config/provider-route-map.json"
export INTEGRATION_PROVIDER_ROUTES_HOST_FILE="$STATE_DIR/config/provider-routes.json"
export INTEGRATION_CONFIG_HOST_FILE="$STATE_DIR/config/librechat.integration.yaml"

python3 - "$STATE_DIR/config/provider-route-map.json" "$STATE_DIR/config/provider-routes.json" \
  "$INTEGRATION_MODEL" "$INTEGRATION_LIBRECHAT_ENDPOINT" "$INTEGRATION_PROVIDER_ENDPOINT" \
  "$INTEGRATION_PROVIDER_ROUTE_REF" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

public_path = Path(sys.argv[1])
private_path = Path(sys.argv[2])
selected_model = sys.argv[3]
librechat_endpoint = sys.argv[4]
provider_endpoint = sys.argv[5]
route_ref = sys.argv[6]
allowed_models = ['gpt-5.6-sol', 'claude-fable-5']
if (
    librechat_endpoint != 'Muskapis-openai'
    or provider_endpoint != 'Muskapis-openai'
    or route_ref != 'custom:Muskapis-openai'
):
    raise SystemExit('integration route values do not match the fixed File Agent contract')
for path in (public_path, private_path):
    if path.is_symlink():
        raise SystemExit(f'integration route file must not be a symbolic link: {path}')
    if path.exists() and not path.is_file():
        raise SystemExit(f'integration route file must be a regular file: {path}')
    if path.exists():
        path.chmod(0o600)
public = {
    'schemaVersion': 1,
    'routes': [{
        'librechatEndpoint': librechat_endpoint,
        'providerRouteRef': route_ref,
        'providerEndpoint': provider_endpoint,
        'protocol': 'openai-compatible',
        'allowedModels': allowed_models,
    }],
}
private = {
    'schemaVersion': 1,
    'routes': [{
        **public['routes'][0],
        'baseUrl': 'http://fake-model-relay:8788/v1',
        'apiKeyFile': '/run/secrets/file-agent-provider-key-integration',
        'supportsIdempotency': True,
        'outputBudgetTokens': 500,
    }],
}
if selected_model not in allowed_models:
    raise SystemExit('selected integration model is not allowlisted')
public_path.write_text(json.dumps(public, indent=2) + '\n', encoding='utf-8')
private_path.write_text(json.dumps(private, indent=2) + '\n', encoding='utf-8')
for path in (public_path, private_path):
    path.chmod(0o444)
PY

if [[ -L "$STATE_DIR/config/librechat.integration.yaml" \
  || ( -e "$STATE_DIR/config/librechat.integration.yaml" && ! -f "$STATE_DIR/config/librechat.integration.yaml" ) ]]; then
  printf 'integration config target must be a regular non-symlink file: %s\n' \
    "$STATE_DIR/config/librechat.integration.yaml" >&2
  exit 3
fi
if [[ -e "$STATE_DIR/config/librechat.integration.yaml" ]]; then
  chmod 600 "$STATE_DIR/config/librechat.integration.yaml"
fi
cp "$INTEGRATION_DIR/config/librechat.integration.yaml" "$STATE_DIR/config/librechat.integration.yaml"
chmod 444 "$STATE_DIR/config/librechat.integration.yaml"

cat > "$STATE_DIR/config/integration.paths.env" <<EOF
COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME
FILE_AGENT_RUNTIME_SOURCE_REVISION=$FILE_AGENT_RUNTIME_SOURCE_REVISION
INTEGRATION_HARNESS_REVISION=$INTEGRATION_HARNESS_REVISION
INTEGRATION_STATE_DIR=$STATE_DIR
INTEGRATION_EVIDENCE_DIR=$EVIDENCE_DIR
INTEGRATION_CONNECTOR_HOST_DIR=$INTEGRATION_CONNECTOR_HOST_DIR
INTEGRATION_RUNTIME_DATA_HOST_DIR=$INTEGRATION_RUNTIME_DATA_HOST_DIR
INTEGRATION_CODEAPI_DATA_HOST_DIR=$INTEGRATION_CODEAPI_DATA_HOST_DIR
INTEGRATION_FAKE_RELAY_STATE_HOST_DIR=$INTEGRATION_FAKE_RELAY_STATE_HOST_DIR
INTEGRATION_API_UPLOADS_HOST_DIR=$INTEGRATION_API_UPLOADS_HOST_DIR
INTEGRATION_API_LOGS_HOST_DIR=$INTEGRATION_API_LOGS_HOST_DIR
FILE_AGENT_SERVICE_SCOPE_SECRET_HOST_FILE=$FILE_AGENT_SERVICE_SCOPE_SECRET_HOST_FILE
FILE_AGENT_ALLOWLIST_HOST_FILE=$FILE_AGENT_ALLOWLIST_HOST_FILE
FILE_AGENT_PROVIDER_KEY_HOST_FILE=$FILE_AGENT_PROVIDER_KEY_HOST_FILE
INTEGRATION_PROVIDER_ROUTE_MAP_HOST_FILE=$INTEGRATION_PROVIDER_ROUTE_MAP_HOST_FILE
INTEGRATION_PROVIDER_ROUTES_HOST_FILE=$INTEGRATION_PROVIDER_ROUTES_HOST_FILE
INTEGRATION_CONFIG_HOST_FILE=$INTEGRATION_CONFIG_HOST_FILE
INTEGRATION_API_PORT=${INTEGRATION_API_PORT:-3081}
INTEGRATION_CODEAPI_PORT=${INTEGRATION_CODEAPI_PORT:-8001}
INTEGRATION_FAKE_RELAY_PORT=${INTEGRATION_FAKE_RELAY_PORT:-8788}
INTEGRATION_LIBRECHAT_ENDPOINT=$INTEGRATION_LIBRECHAT_ENDPOINT
INTEGRATION_PROVIDER_ENDPOINT=$INTEGRATION_PROVIDER_ENDPOINT
INTEGRATION_PROVIDER_ROUTE_REF=$INTEGRATION_PROVIDER_ROUTE_REF
INTEGRATION_MODEL=$INTEGRATION_MODEL
INTEGRATION_SECOND_MODEL=$INTEGRATION_SECOND_MODEL
EOF
chmod 600 "$STATE_DIR/config/integration.paths.env"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME")
on_setup_error() {
  local status=$?
  trap - EXIT
  "${compose[@]}" ps > "$EVIDENCE_DIR/compose-failure-ps.txt" 2>&1 || true
  "${compose[@]}" logs --no-color > "$EVIDENCE_DIR/compose-failure.log" 2>&1 || true
  chmod 600 "$EVIDENCE_DIR/compose-failure-ps.txt" "$EVIDENCE_DIR/compose-failure.log" 2>/dev/null || true
  exit "$status"
}
trap on_setup_error EXIT
if ! "${compose[@]}" config >/dev/null; then
  printf 'integration Compose config validation failed\n' >&2
  exit 6
fi

"${compose[@]}" up -d --build

wait_healthy() {
  local service="$1"
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    local container_id status
    container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect "$container_id" --format '{{with (index .State "Health")}}{{.Status}}{{else}}{{$.State.Status}}{{end}}' 2>/dev/null || true)"
      if [[ "$status" == healthy ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  printf 'timed out waiting for integration service: %s\n' "$service" >&2
  "${compose[@]}" ps >&2 || true
  return 1
}

wait_healthy fake-model-relay
wait_healthy file-agent-runtime
wait_healthy api

python3 - "${INTEGRATION_CODEAPI_PORT:-8001}" <<'PY'
from __future__ import annotations

import socket
import sys
import time

port = int(sys.argv[1])
deadline = time.time() + 30
while time.time() < deadline:
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=2):
            break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit('CodeAPI did not accept a TCP connection on its integration port')
PY

"${compose[@]}" exec -T api cat /tmp/file-agent-integration-api-overlay.json > "$EVIDENCE_DIR/api-overlay-marker.json"
"${compose[@]}" ps > "$EVIDENCE_DIR/compose-ps.txt"
"$SCRIPT_DIR/integration-smoke.sh" "$ENV_FILE"
trap - EXIT
printf 'integration_environment=started\n'
printf 'state_dir=%s\n' "$STATE_DIR"
printf 'evidence_dir=%s\n' "$EVIDENCE_DIR"
