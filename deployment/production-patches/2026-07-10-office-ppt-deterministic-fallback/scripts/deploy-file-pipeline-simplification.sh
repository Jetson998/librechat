#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-file-pipeline-simplification}"
patch_dir="/opt/librechat/office-context-patch"
skill_dir="/opt/librechat/skill/office-document-parser"
timestamp="$(date +%Y%m%d%H%M%S)"

baseclient_src="$stage_dir/BaseClient.js"
toolservice_src="$stage_dir/ToolService.js"
process_src="$stage_dir/process.js"
skill_src="$stage_dir/SKILL.md"

baseclient_dst="$patch_dir/BaseClient.js"
toolservice_dst="$patch_dir/ToolService.js"
process_dst="$patch_dir/process.js"
skill_dst="$skill_dir/SKILL.md"

for file in "$baseclient_src" "$toolservice_src" "$process_src" "$skill_src"; do
  test -f "$file"
done

for file in "$baseclient_dst" "$toolservice_dst" "$process_dst" "$skill_dst"; do
  test -f "$file"
done

baseclient_backup="$baseclient_dst.bak-$timestamp"
toolservice_backup="$toolservice_dst.bak-$timestamp"
process_backup="$process_dst.bak-$timestamp"
skill_backup="$skill_dst.bak-$timestamp"

cp -a "$baseclient_dst" "$baseclient_backup"
cp -a "$toolservice_dst" "$toolservice_backup"
cp -a "$process_dst" "$process_backup"
cp -a "$skill_dst" "$skill_backup"

applied=0

rollback() {
  cp -a "$baseclient_backup" "$baseclient_dst"
  cp -a "$toolservice_backup" "$toolservice_dst"
  cp -a "$process_backup" "$process_dst"
  cp -a "$skill_backup" "$skill_dst"
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

install_candidate "$baseclient_src" "$baseclient_dst"
install_candidate "$toolservice_src" "$toolservice_dst"
install_candidate "$process_src" "$process_dst"
install_candidate "$skill_src" "$skill_dst"
applied=1

docker exec LibreChat-API node --check /app/api/app/clients/BaseClient.js
docker exec LibreChat-API node --check /app/api/server/services/ToolService.js
docker exec LibreChat-API node --check /app/api/server/services/Files/process.js

grep -Fq 'appendDownloadableMessageFiles' "$baseclient_dst"
if grep -Eq 'executeCodeApiPptJob|buildOfficePptFallbackPython|officeGenerationEmptyRetry|deterministicFallbackAttachment' "$baseclient_dst"; then
  false
fi

grep -Fq 'officeCodeUploadExts' "$process_dst"
grep -Fq "metadata.message_file === true || metadata.message_file === 'true'" "$process_dst"
grep -Fq 'find|tree' "$toolservice_dst"
if grep -Eq '^always-apply:|office_to_markdown\.py|/office/|/tmp/' "$skill_dst"; then
  false
fi

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

trap - ERR

printf 'timestamp=%s\n' "$timestamp"
printf 'backup=%s\n' "$baseclient_backup"
printf 'backup=%s\n' "$toolservice_backup"
printf 'backup=%s\n' "$process_backup"
printf 'backup=%s\n' "$skill_backup"
sha256sum "$baseclient_dst" "$toolservice_dst" "$process_dst" "$skill_dst"
docker ps --format '{{.Names}} {{.Status}}' --filter name=LibreChat-API --filter name=LibreChat-CodeAPI
