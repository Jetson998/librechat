#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API
# release-governance:target-lock
set -Eeuo pipefail

test -n "${RELEASE_SOURCE_REVISION:-}"

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
patch_root="deployment/production-patches/2026-07-24-agent-progress-ledger"
remote_stage="/tmp/librechat-agent-progress-ledger-${RELEASE_SOURCE_REVISION:0:12}"

for file in \
  "$patch_root/api-patch/api-index.cjs" \
  "$patch_root/api-patch/code-tool-contract.cjs" \
  "$patch_root/api-patch/tool-call-normalizer.cjs" \
  "$patch_root/api-patch/tool-call-recovery.cjs" \
  "$patch_root/api-patch/tool-progress-ledger.cjs" \
  "$patch_root/scripts/remote-apply.sh"; do
  test -f "$file"
done

ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
ssh "${ssh_opts[@]}" "$user@$host" "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
scp "${ssh_opts[@]}" -- \
  "$patch_root/api-patch/api-index.cjs" \
  "$patch_root/api-patch/code-tool-contract.cjs" \
  "$patch_root/api-patch/tool-call-normalizer.cjs" \
  "$patch_root/api-patch/tool-call-recovery.cjs" \
  "$patch_root/api-patch/tool-progress-ledger.cjs" \
  "$patch_root/scripts/remote-apply.sh" \
  "$user@$host:$remote_stage/"
ssh "${ssh_opts[@]}" "$user@$host" \
  "chmod 700 '$remote_stage/remote-apply.sh' && '$remote_stage/remote-apply.sh' '$remote_stage' '$RELEASE_SOURCE_REVISION'"
