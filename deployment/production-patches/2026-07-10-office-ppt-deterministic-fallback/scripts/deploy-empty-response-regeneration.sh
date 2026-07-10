#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-empty-response-regeneration}"
patch_dir="/opt/librechat/office-context-patch"
timestamp="$(date +%Y%m%d%H%M%S)"

baseclient_src="$stage_dir/BaseClient.js"
api_index_src="$stage_dir/api-index.cjs"
baseclient_dst="$patch_dir/BaseClient.js"
api_index_dst="$patch_dir/api-index.cjs"

for file in "$baseclient_src" "$api_index_src"; do
  test -f "$file"
done

for file in "$baseclient_dst" "$api_index_dst"; do
  test -f "$file"
done

baseclient_backup="$baseclient_dst.bak-$timestamp"
api_index_backup="$api_index_dst.bak-$timestamp"

cp -a "$baseclient_dst" "$baseclient_backup"
cp -a "$api_index_dst" "$api_index_backup"

applied=0

rollback() {
  cp -a "$baseclient_backup" "$baseclient_dst"
  cp -a "$api_index_backup" "$api_index_dst"
  docker restart LibreChat-API >/dev/null
}

on_error() {
  rc=$?
  trap - ERR
  if [[ "$applied" == "1" ]]; then
    rollback
  fi
  exit "$rc"
}

trap on_error ERR

install_candidate() {
  src="$1"
  dst="$2"
  next="$dst.next-$timestamp"
  cp "$src" "$next"
  chmod --reference="$dst" "$next"
  chown --reference="$dst" "$next"
  mv "$next" "$dst"
}

applied=1
install_candidate "$baseclient_src" "$baseclient_dst"
install_candidate "$api_index_src" "$api_index_dst"

docker exec LibreChat-API node --check /app/api/app/clients/BaseClient.js
docker exec LibreChat-API node --check /app/packages/api/dist/index.cjs

grep -Fq "const EMPTY_MODEL_RESPONSE_CODE = 'EMPTY_MODEL_RESPONSE';" "$baseclient_dst"
grep -Fq 'filterSemanticallyEmptyAssistantMessages' "$baseclient_dst"
grep -Fq 'ensureAssistantSemanticContent(responseMessage)' "$baseclient_dst"
grep -Fq 'const isEarlyAbort = !shouldPersistAbortContent;' "$api_index_dst"
grep -Fq 'success: !isEarlyAbort' "$api_index_dst"

docker restart LibreChat-API >/dev/null

for _ in $(seq 1 30); do
  if [[ "$(docker inspect LibreChat-API --format '{{.State.Running}}')" == "true" ]]; then
    break
  fi
  sleep 1
done
test "$(docker inspect LibreChat-API --format '{{.State.Running}}')" = "true"

api_ready=0
for _ in $(seq 1 60); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null; then
    api_ready=1
    break
  fi
  sleep 1
done
test "$api_ready" = "1"

curl -ksSf https://152.32.172.162.sslip.io/ >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)" = "401"
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.Running}}')" = "true"
test "$(docker inspect LibreChat-CodeAPI --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" = "healthy"

trap - ERR

printf 'timestamp=%s\n' "$timestamp"
printf 'backup=%s\n' "$baseclient_backup"
printf 'backup=%s\n' "$api_index_backup"
sha256sum "$baseclient_dst" "$api_index_dst"
docker ps --format '{{.Names}} {{.Status}}' --filter name=LibreChat-API --filter name=LibreChat-CodeAPI
