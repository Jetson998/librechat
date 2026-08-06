#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$INTEGRATION_DIR/.env.integration}"
COMPOSE_FILE="$INTEGRATION_DIR/compose.integration.yaml"
REPO_ROOT="$(cd -- "$INTEGRATION_DIR/../../../../" && pwd)"

printf 'file_agent_integration_status=v1\n'
printf 'env_file=%s\n' "$ENV_FILE"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'environment=not_configured\n'
  printf 'blocking=missing .env.integration; copy .env.integration.example and provide image identities\n'
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

case "${COMPOSE_PROJECT_NAME:-}" in
  file-agent-integration|file-agent-integration-*) ;;
  *)
    printf 'environment=invalid\n'
    printf 'blocking=COMPOSE_PROJECT_NAME must use the file-agent-integration prefix\n'
    exit 3
    ;;
esac

STATE_DIR="${INTEGRATION_STATE_DIR:-$INTEGRATION_DIR/.state}"
if [[ -L "$STATE_DIR" || ! -d "$STATE_DIR" || -L "$STATE_DIR/.integration-state" || ! -f "$STATE_DIR/.integration-state" ]]; then
  printf 'environment=not_started\n'
else
  marker="$(tr -d '\r\n' < "$STATE_DIR/.integration-state" 2>/dev/null || true)"
  if [[ "$marker" == file-agent-integration-state-v1 ]]; then
    printf 'environment=state_present\n'
  else
    printf 'environment=unsafe_or_unknown_state\n'
  fi
  if [[ -f "$STATE_DIR/config/integration.paths.env" ]]; then
    # shellcheck disable=SC1090
    source "$STATE_DIR/config/integration.paths.env"
  fi
fi

printf 'compose_project=%s\n' "$COMPOSE_PROJECT_NAME"
printf 'runtime_source_revision=%s\n' "${FILE_AGENT_RUNTIME_SOURCE_REVISION:-unset}"
printf 'integration_harness_revision=%s\n' "${INTEGRATION_HARNESS_REVISION:-unset}"
checkout_revision="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
printf 'checkout_revision=%s\n' "${checkout_revision:-unavailable}"
if [[ -n "$checkout_revision" && -n "${FILE_AGENT_RUNTIME_SOURCE_REVISION:-}" \
  && "${FILE_AGENT_RUNTIME_SOURCE_REVISION}" =~ ^[0-9a-f]{40}$ ]] \
  && git -C "$REPO_ROOT" cat-file -e "${FILE_AGENT_RUNTIME_SOURCE_REVISION}^{commit}" 2>/dev/null; then
  printf 'runtime_source_available=PASS\n'
else
  printf 'runtime_source_available=FAIL\n'
fi
if [[ -n "$checkout_revision" && -n "${INTEGRATION_HARNESS_REVISION:-}" \
  && "$checkout_revision" == "$INTEGRATION_HARNESS_REVISION" \
  && "$INTEGRATION_HARNESS_REVISION" =~ ^[0-9a-f]{40}$ ]] \
  && git -C "$REPO_ROOT" cat-file -e "${INTEGRATION_HARNESS_REVISION}^{commit}" 2>/dev/null; then
  printf 'integration_harness_checkout_match=PASS\n'
else
  printf 'integration_harness_checkout_match=FAIL\n'
fi
if [[ -n "${FILE_AGENT_RUNTIME_SOURCE_REVISION:-}" && -n "${INTEGRATION_HARNESS_REVISION:-}" ]] \
  && git -C "$REPO_ROOT" merge-base --is-ancestor \
    "$FILE_AGENT_RUNTIME_SOURCE_REVISION" "$INTEGRATION_HARNESS_REVISION" 2>/dev/null; then
  printf 'runtime_source_is_harness_ancestor=PASS\n'
else
  printf 'runtime_source_is_harness_ancestor=FAIL\n'
fi
if [[ -n "${FILE_AGENT_RUNTIME_SOURCE_REVISION:-}" && -n "${INTEGRATION_HARNESS_REVISION:-}" ]]; then
  business_diff="$(git -C "$REPO_ROOT" diff --name-only \
    "$FILE_AGENT_RUNTIME_SOURCE_REVISION" "$INTEGRATION_HARNESS_REVISION" -- \
    services/file-agent-runtime services/librechat-file-agent-connector 2>/dev/null || true)"
  if [[ -z "$business_diff" ]]; then
    printf 'runtime_connector_business_diff=empty\n'
  else
    printf 'runtime_connector_business_diff=FAIL\n%s\n' "$business_diff"
  fi
fi
printf 'runtime_reference=%s\n' "${FILE_AGENT_RUNTIME_IMAGE:-unset}"
printf 'runtime_expected_image_id=%s\n' "${FILE_AGENT_RUNTIME_IMAGE_ID:-unset}"
printf 'codeapi_reference=%s\n' "${CODEAPI_IMAGE:-unset}"
printf 'codeapi_expected_image_id=%s\n' "${CODEAPI_IMAGE_ID:-unset}"

inspect_image() {
  local label="$1"
  local reference="$2"
  local expected="$3"
  local actual platform
  if [[ -z "$reference" ]]; then
    printf '%s=not_configured\n' "$label"
    return 0
  fi
  if ! actual="$(docker image inspect "$reference" --format '{{.Id}}' 2>/dev/null)"; then
    printf '%s=missing\n' "$label"
    return 0
  fi
  platform="$(docker image inspect "$reference" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true)"
  printf '%s=present\n' "$label"
  printf '%s_image_id=%s\n' "$label" "$actual"
  printf '%s_platform=%s\n' "$label" "$platform"
  if [[ -n "$expected" && "$actual" != "$expected" ]]; then
    printf '%s_identity=FAIL\n' "$label"
  else
    printf '%s_identity=PASS\n' "$label"
  fi
}

inspect_image runtime_image "${FILE_AGENT_RUNTIME_IMAGE:-}" "${FILE_AGENT_RUNTIME_IMAGE_ID:-}"
inspect_image codeapi_image "${CODEAPI_IMAGE:-}" "${CODEAPI_IMAGE_ID:-}"

if [[ -f "$STATE_DIR/config/integration.paths.env" ]]; then
  printf 'paths_env=present\n'
  printf 'evidence_dir=%s\n' "${INTEGRATION_EVIDENCE_DIR:-unknown}"
else
  printf 'paths_env=missing\n'
fi

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file"
  fi
}

for file in \
  "$STATE_DIR/connector.tar.gz" \
  "$STATE_DIR/connector.manifest.json" \
  "$STATE_DIR/config/provider-route-map.json" \
  "$STATE_DIR/config/provider-routes.json"; do
  if [[ -f "$file" && ! -L "$file" ]]; then
    printf 'artifact_sha256='; sha256_file "$file"
  fi
done

if command -v docker >/dev/null 2>&1; then
  compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME")
  printf '%s\n' 'compose_ps_begin'
  "${compose[@]}" ps 2>&1 || true
  printf '%s\n' 'compose_ps_end'
  for service in mongodb codeapi fake-model-relay file-agent-runtime api; do
    container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      printf 'service=%s status=missing\n' "$service"
      continue
    fi
    docker inspect "$container_id" --format "service=$service id={{.Id}} image={{.Config.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}unreported{{end}}" 2>&1 || true
  done
  api_container="$("${compose[@]}" ps -q api 2>/dev/null || true)"
  if [[ -n "$api_container" ]]; then
    printf '%s\n' 'api_overlay_marker_begin'
    "${compose[@]}" exec -T api cat /tmp/file-agent-integration-api-overlay.json 2>&1 || true
    printf '%s\n' 'api_overlay_marker_end'
  fi
else
  printf 'docker=missing\n'
fi
