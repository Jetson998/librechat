#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=chat-mongodb
# release-governance:target-lock
set -Eeuo pipefail

runtime_evidence="${1:?runtime preflight evidence is required}"
local_result="${2:?local deployment result path is required}"
test -n "${RELEASE_SOURCE_REVISION:-}"
test -n "${RELEASE_ARTIFACT_SHA256:-}"

script_dir="deployment/production-operations/2026-09-03-clear-model-effort/scripts"
transport_script="$script_dir/ssh-transport.sh"
for path in "$runtime_evidence" "$script_dir/mongo-config.js" "$script_dir/remote-apply.sh" "$script_dir/remote-rollback.sh" "$transport_script"; do
  test -f "$path"
done

python3 - "$runtime_evidence" "$RELEASE_SOURCE_REVISION" "$RELEASE_ARTIFACT_SHA256" <<'PY'
import json
import sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
assert data['status'] == 'passed'
assert data['source_revision'] == sys.argv[2]
assert data['artifact_sha256'] == sys.argv[3]
assert data['rollback_available'] is True
PY

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-clear-model-effort-deploy-${RELEASE_SOURCE_REVISION:0:12}"
source "$transport_script"

cleanup() {
  transport_exec "rm -rf '$remote_stage'" >/dev/null 2>&1 || true
  transport_cleanup
}
trap cleanup EXIT

transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$script_dir/mongo-config.js" "$remote_stage/mongo-config.js"
transport_copy_to "$script_dir/remote-apply.sh" "$remote_stage/remote-apply.sh"
transport_copy_to "$script_dir/remote-rollback.sh" "$remote_stage/remote-rollback.sh"
transport_copy_to "$runtime_evidence" "$remote_stage/runtime-preflight.json"
transport_exec "chmod 700 '$remote_stage/remote-apply.sh' && '$remote_stage/remote-apply.sh' '$remote_stage' '$RELEASE_SOURCE_REVISION' '$RELEASE_ARTIFACT_SHA256'"

mkdir -p "$(dirname "$local_result")"
transport_copy_from "$remote_stage/DEPLOY_RESULT.json" "$local_result"
python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["status"] == "passed"; print(json.dumps(data, ensure_ascii=False, sort_keys=True))' "$local_result"
