#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=chat-mongodb
# release-governance:target-lock
set -Eeuo pipefail

runtime_evidence="${1:?runtime preflight evidence is required}"
local_result="${2:?local deployment result path is required}"
test -n "${RELEASE_SOURCE_REVISION:-}"

operation_root="deployment/production-operations/2026-07-29-preset-agent-contact-removal"
shared_root="deployment/production-operations/2026-07-29-preset-workflow-agents/scripts"
template_root="workflow-templates/preset-agents"
compiled_path="$template_root/compiled-agents.json"
script_dir="$operation_root/scripts"
transport_script="$shared_root/ssh-transport.sh"

files=(
  "$compiled_path"
  "$runtime_evidence"
  "$shared_root/runtime_common.py"
  "$script_dir/remote-apply.py"
  "$script_dir/remote-rollback.py"
  "$script_dir/snapshot-targets.js"
  "$script_dir/remove-support-contact.js"
  "$script_dir/rollback-agents.js"
  "$transport_script"
)
for path in "${files[@]}"; do
  test -f "$path"
done

python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["status"] == "passed"; assert data["source_revision"] == sys.argv[2]' "$runtime_evidence" "$RELEASE_SOURCE_REVISION"
node "$template_root/scripts/compile.mjs" --check

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-preset-agent-contact-deploy-${RELEASE_SOURCE_REVISION:0:12}"
source "$transport_script"

cleanup() {
  transport_exec "rm -rf '$remote_stage'" >/dev/null 2>&1 || true
  transport_cleanup
}
trap cleanup EXIT

transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$compiled_path" "$remote_stage/compiled-agents.json"
transport_copy_to "$runtime_evidence" "$remote_stage/runtime-preflight.json"
transport_copy_to "$shared_root/runtime_common.py" "$remote_stage/runtime_common.py"
for name in remote-apply.py remote-rollback.py snapshot-targets.js remove-support-contact.js rollback-agents.js; do
  transport_copy_to "$script_dir/$name" "$remote_stage/$name"
done
transport_exec "chmod 700 '$remote_stage/remote-apply.py' '$remote_stage/remote-rollback.py' && cd '$remote_stage' && python3 ./remote-apply.py '$remote_stage' '$RELEASE_SOURCE_REVISION'"

mkdir -p "$(dirname "$local_result")"
transport_copy_from "$remote_stage/DEPLOY_RESULT.json" "$local_result"
python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["status"] == "passed"; print(json.dumps(data, ensure_ascii=False, sort_keys=True))' "$local_result"
