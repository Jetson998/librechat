#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API,LibreChat-CodeAPI
# release-governance:target-lock
set -Eeuo pipefail

runtime_evidence="${1:?runtime preflight evidence is required}"
local_result="${2:?local deployment result path is required}"
test -n "${RELEASE_SOURCE_REVISION:-}"
patch_root="deployment/production-patches/2026-07-31-office-codeapi-process-reaper"
script_dir="$patch_root/scripts"
transport_script="deployment/production-patches/2026-07-31-agent-category-dedup-count-fix/scripts/ssh-transport.sh"
for path in "$runtime_evidence" "$patch_root/config/codeapi-service.block" \
  "$script_dir/patch-compose.py" "$script_dir/remote-apply.py" \
  "$script_dir/remote-rollback.py" "$transport_script"; do
  test -f "$path"
done
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_revision"])' "$runtime_evidence")" = "$RELEASE_SOURCE_REVISION"

remote_stage="/tmp/librechat-codeapi-reaper-deploy-${RELEASE_SOURCE_REVISION:0:12}"
source "$transport_script"
trap 'transport_cleanup' EXIT
transport_prepare "${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}" "${LIBRECHAT_PRODUCTION_USER:-root}"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$runtime_evidence" "$remote_stage/runtime-preflight.json"
transport_copy_to "$patch_root/config/codeapi-service.block" "$remote_stage/codeapi-service.block"
transport_copy_to "$script_dir/patch-compose.py" "$remote_stage/patch-compose.py"
transport_copy_to "$script_dir/remote-apply.py" "$remote_stage/remote-apply.py"
transport_copy_to "$script_dir/remote-rollback.py" "$remote_stage/remote-rollback.py"
transport_exec "chmod 700 '$remote_stage/patch-compose.py' '$remote_stage/remote-apply.py' '$remote_stage/remote-rollback.py' && python3 '$remote_stage/remote-apply.py' '$remote_stage' '$RELEASE_SOURCE_REVISION'"
mkdir -p "$(dirname "$local_result")"
transport_copy_from "$remote_stage/DEPLOY_RESULT.json" "$local_result"
python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["status"] == "passed"; print(json.dumps(data, sort_keys=True))' "$local_result"
