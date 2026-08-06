#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$INTEGRATION_DIR/.env.integration}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'missing integration env file: %s\n' "$ENV_FILE" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${CODEAPI_IMAGE:?CODEAPI_IMAGE is required}"
: "${CODEAPI_IMAGE_ID:?CODEAPI_IMAGE_ID is required}"

if ! docker image inspect "$CODEAPI_IMAGE" >/dev/null 2>&1; then
  archive="${CODEAPI_IMAGE_ARCHIVE:-}"
  if [[ -z "$archive" ]]; then
    printf 'real CodeAPI image is unavailable and CODEAPI_IMAGE_ARCHIVE is empty\n' >&2
    exit 3
  fi
  if [[ ! -f "$archive" || -L "$archive" ]]; then
    printf 'CODEAPI_IMAGE_ARCHIVE must be a regular file: %s\n' "$archive" >&2
    exit 3
  fi
  docker load --input "$archive" >/dev/null
fi

actual_id="$(docker image inspect "$CODEAPI_IMAGE" --format '{{.Id}}')"
if [[ "$actual_id" != "$CODEAPI_IMAGE_ID" ]]; then
  printf 'CodeAPI image identity mismatch: expected=%s actual=%s\n' "$CODEAPI_IMAGE_ID" "$actual_id" >&2
  exit 4
fi

architecture="$(docker image inspect "$CODEAPI_IMAGE" --format '{{.Architecture}}')"
os_name="$(docker image inspect "$CODEAPI_IMAGE" --format '{{.Os}}')"
if [[ "$architecture" != amd64 || "$os_name" != linux ]]; then
  printf 'CodeAPI image must be linux/amd64: os=%s architecture=%s\n' "$os_name" "$architecture" >&2
  exit 5
fi

platform_id="$(docker image inspect --platform linux/amd64 "$CODEAPI_IMAGE" --format '{{.Id}}')"
platform_architecture="$(docker image inspect --platform linux/amd64 "$CODEAPI_IMAGE" --format '{{.Architecture}}')"
platform_os="$(docker image inspect --platform linux/amd64 "$CODEAPI_IMAGE" --format '{{.Os}}')"
if [[ "$platform_architecture" != amd64 || "$platform_os" != linux ]]; then
  printf 'CodeAPI platform selection must be linux/amd64: os=%s architecture=%s\n' \
    "$platform_os" "$platform_architecture" >&2
  exit 5
fi

printf 'codeapi_image=verified\n'
printf 'codeapi_image_id=%s\n' "$actual_id"
printf 'codeapi_platform_image_id=%s\n' "$platform_id"
printf 'codeapi_platform=%s/%s\n' "$os_name" "$architecture"
