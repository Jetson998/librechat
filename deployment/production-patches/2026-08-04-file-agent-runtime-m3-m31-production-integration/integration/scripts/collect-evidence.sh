#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$INTEGRATION_DIR/.env.integration}"
COMPOSE_FILE="$INTEGRATION_DIR/compose.integration.yaml"
API_OVERLAY_MANIFEST="$INTEGRATION_DIR/config/api-overlay-manifest.json"

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
REPO_ROOT="$(cd -- "$INTEGRATION_DIR/../../../../" && pwd)"
export REPO_ROOT
set -a
# shellcheck disable=SC1090
source "$STATE_DIR/config/integration.paths.env"
# shellcheck disable=SC1090
source "$STATE_DIR/config/api-runtime.env"
set +a

EVIDENCE_DIR="${INTEGRATION_EVIDENCE_DIR:?INTEGRATION_EVIDENCE_DIR is required after integration-up}"
FIXTURE_ONE="${INTEGRATION_FIXTURE_ONE:-$STATE_DIR/api-uploads/integration-one.docx}"
FIXTURE_TWO="${INTEGRATION_FIXTURE_TWO:-$STATE_DIR/api-uploads/integration-two.docx}"
FIXTURE_SOURCE="${INTEGRATION_FIXTURE_SOURCE:-$INTEGRATION_DIR/fixtures/minimal-source.docx}"
mkdir -p "$EVIDENCE_DIR"
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME")

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file"
  else
    printf 'no SHA-256 utility is available\n' >&2
    return 1
  fi
}

"${compose[@]}" ps > "$EVIDENCE_DIR/compose-ps-final.txt"
{
  for service in mongodb codeapi fake-model-relay file-agent-runtime api; do
    container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      docker inspect "$container_id" --format "service=$service id={{.Id}} image={{.Config.Image}} status={{.State.Status}} health={{with (index .State \"Health\")}}{{.Status}}{{else}}unreported{{end}}"
    else
      printf 'service=%s status=missing\n' "$service"
    fi
  done
} > "$EVIDENCE_DIR/service-facts.txt"

{
  for file in \
    "$STATE_DIR/connector.tar.gz" \
    "$STATE_DIR/connector.manifest.json" \
    "$STATE_DIR/config/provider-route-map.json" \
    "$STATE_DIR/config/provider-routes.json" \
    "$STATE_DIR/config/librechat.integration.yaml" \
    "$API_OVERLAY_MANIFEST" \
    "$FIXTURE_SOURCE" \
    "$FIXTURE_ONE" \
    "$FIXTURE_TWO"; do
    if [[ -f "$file" && ! -L "$file" ]]; then
      sha256_file "$file"
    fi
  done
} > "$EVIDENCE_DIR/SHA256SUMS"

cp "$API_OVERLAY_MANIFEST" "$EVIDENCE_DIR/api-overlay-manifest.json"
chmod 600 "$EVIDENCE_DIR/api-overlay-manifest.json"

if [[ -f "$STATE_DIR/fake-relay/requests.ndjson" ]]; then
  cp "$STATE_DIR/fake-relay/requests.ndjson" "$EVIDENCE_DIR/fake-relay-requests.ndjson"
  chmod 600 "$EVIDENCE_DIR/fake-relay-requests.ndjson"
fi
if [[ -f "$STATE_DIR/runtime-data/integration-audit/codeapi.ndjson" ]]; then
  cp "$STATE_DIR/runtime-data/integration-audit/codeapi.ndjson" "$EVIDENCE_DIR/codeapi-audit.ndjson"
  chmod 600 "$EVIDENCE_DIR/codeapi-audit.ndjson"
fi

printf 'integration_evidence=collected\n'
printf 'evidence_dir=%s\n' "$EVIDENCE_DIR"
