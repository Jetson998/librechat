#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API
set -Eeuo pipefail

artifact_zip="${1:?Client artifact ZIP is required}"
runtime_evidence="${2:?runtime preflight evidence is required}"
local_result="${3:?local deployment result path is required}"

test -n "${RELEASE_SOURCE_REVISION:-}"

patch_root="deployment/production-patches/2026-07-28-agent-platform-p0-ui"
metadata_path="$patch_root/client/artifact.json"
script_dir="$patch_root/scripts"
verify_script="$script_dir/verify-artifact.py"
preflight_script="$script_dir/remote-preflight.py"
apply_script="$script_dir/remote-apply.sh"
rollback_script="$script_dir/remote-rollback.sh"
transport_script="$script_dir/ssh-transport.sh"

for path in \
  "$artifact_zip" "$runtime_evidence" "$metadata_path" "$verify_script" \
  "$preflight_script" "$apply_script" "$rollback_script" "$transport_script"; do
  test -f "$path"
done

python3 "$verify_script" "$artifact_zip" "$metadata_path"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_revision"])' "$runtime_evidence")" = "$RELEASE_SOURCE_REVISION"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["client_artifact"]["zip_sha256"])' "$runtime_evidence")" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifact"]["zip_sha256"])' "$metadata_path")"

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-agent-platform-p0-deploy-${RELEASE_SOURCE_REVISION:0:12}"
source "$transport_script"
trap 'transport_cleanup' EXIT
transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$artifact_zip" "$remote_stage/client-artifact.zip"
transport_copy_to "$runtime_evidence" "$remote_stage/runtime-preflight.json"
transport_copy_to "$metadata_path" "$remote_stage/artifact.json"
transport_copy_to "$verify_script" "$remote_stage/verify-artifact.py"
transport_copy_to "$preflight_script" "$remote_stage/remote-preflight.py"
transport_copy_to "$apply_script" "$remote_stage/remote-apply.sh"
transport_copy_to "$rollback_script" "$remote_stage/remote-rollback.sh"
transport_exec "chmod 700 '$remote_stage/verify-artifact.py' '$remote_stage/remote-preflight.py' '$remote_stage/remote-apply.sh' '$remote_stage/remote-rollback.sh' && '$remote_stage/remote-apply.sh' '$remote_stage' '$RELEASE_SOURCE_REVISION'"

mkdir -p "$(dirname "$local_result")"
transport_copy_from "$remote_stage/DEPLOY_RESULT.json" "$local_result"
python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["status"] == "passed"; print(json.dumps(data, sort_keys=True))' "$local_result"
printf 'local_deployment_result=%s\n' "$local_result"
