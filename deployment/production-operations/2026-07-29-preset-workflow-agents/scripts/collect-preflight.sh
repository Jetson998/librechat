#!/usr/bin/env bash
set -Eeuo pipefail

output_path="${1:?local runtime preflight output path is required}"
test -n "${RELEASE_SOURCE_REVISION:-}"
test -n "${RELEASE_PLAN_SHA256:-}"
test -n "${RELEASE_ARTIFACT_SHA256:-}"

operation_root="deployment/production-operations/2026-07-29-preset-workflow-agents"
template_root="workflow-templates/preset-agents"
compiled_path="$template_root/compiled-agents.json"
script_dir="$operation_root/scripts"
transport_script="$script_dir/ssh-transport.sh"

for path in \
  "$compiled_path" \
  "$script_dir/runtime_common.py" \
  "$script_dir/remote-preflight.py" \
  "$script_dir/normalize-preflight.py" \
  "$script_dir/snapshot-targets.js" \
  "$transport_script"; do
  test -f "$path"
done

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-preset-agent-preflight-${RELEASE_SOURCE_REVISION:0:12}"
source "$transport_script"

cleanup() {
  transport_exec "rm -rf '$remote_stage'" >/dev/null 2>&1 || true
  transport_cleanup
}
trap cleanup EXIT

transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$compiled_path" "$remote_stage/compiled-agents.json"
transport_copy_to "$script_dir/runtime_common.py" "$remote_stage/runtime_common.py"
transport_copy_to "$script_dir/remote-preflight.py" "$remote_stage/remote-preflight.py"
transport_copy_to "$script_dir/snapshot-targets.js" "$remote_stage/snapshot-targets.js"
transport_exec "chmod 700 '$remote_stage/remote-preflight.py' && cd '$remote_stage' && python3 ./remote-preflight.py ./compiled-agents.json ./snapshot-targets.js '$RELEASE_SOURCE_REVISION' > ./runtime-preflight.json"

mkdir -p "$(dirname "$output_path")"
transport_copy_from "$remote_stage/runtime-preflight.json" "$output_path"
python3 "$script_dir/normalize-preflight.py" \
  "$output_path" \
  "$output_path" \
  "$RELEASE_SOURCE_REVISION" \
  "$RELEASE_PLAN_SHA256" \
  "$RELEASE_ARTIFACT_SHA256"
python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["status"] == "passed"; assert data["write_operations"] == []; assert data["rollback_available"] is True' "$output_path"
