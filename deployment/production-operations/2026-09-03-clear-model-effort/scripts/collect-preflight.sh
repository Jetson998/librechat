#!/usr/bin/env bash
set -Eeuo pipefail

output_path="${1:?local runtime preflight output path is required}"
test -n "${RELEASE_SOURCE_REVISION:-}"
test -n "${RELEASE_PLAN_SHA256:-}"
test -n "${RELEASE_ARTIFACT_SHA256:-}"

script_dir="deployment/production-operations/2026-09-03-clear-model-effort/scripts"
transport_script="$script_dir/ssh-transport.sh"
for path in "$script_dir/mongo-config.js" "$script_dir/remote-preflight.sh" "$transport_script"; do
  test -f "$path"
done

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-clear-model-effort-preflight-${RELEASE_SOURCE_REVISION:0:12}"
source "$transport_script"

cleanup() {
  transport_exec "rm -rf '$remote_stage'" >/dev/null 2>&1 || true
  transport_cleanup
}
trap cleanup EXIT

transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$script_dir/mongo-config.js" "$remote_stage/mongo-config.js"
transport_copy_to "$script_dir/remote-preflight.sh" "$remote_stage/remote-preflight.sh"
transport_exec "chmod 700 '$remote_stage/remote-preflight.sh' && '$remote_stage/remote-preflight.sh' '$remote_stage/mongo-config.js' '$RELEASE_SOURCE_REVISION' '$RELEASE_PLAN_SHA256' '$RELEASE_ARTIFACT_SHA256' > '$remote_stage/runtime-preflight.json'"

mkdir -p "$(dirname "$output_path")"
transport_copy_from "$remote_stage/runtime-preflight.json" "$output_path"
python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["status"] == "passed"; assert data["write_operations"] == []; assert data["rollback_available"] is True' "$output_path"
