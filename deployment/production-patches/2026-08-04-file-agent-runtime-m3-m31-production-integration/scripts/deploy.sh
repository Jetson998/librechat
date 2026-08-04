#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API,file-agent-runtime
# release-governance:target-lock
set -Eeuo pipefail

release_id="${RELEASE_ID:?RELEASE_ID is required}"
source_revision="${RELEASE_SOURCE_REVISION:?RELEASE_SOURCE_REVISION is required}"
artifact_sha256="${RELEASE_ARTIFACT_SHA256:?RELEASE_ARTIFACT_SHA256 is required}"
artifact_path="${RELEASE_ARTIFACT_PATH:?RELEASE_ARTIFACT_PATH is required}"
handoff_manifest="${FILE_AGENT_HANDOFF_MANIFEST_PATH:?FILE_AGENT_HANDOFF_MANIFEST_PATH is required}"
connector_archive="${FILE_AGENT_CONNECTOR_ARCHIVE_PATH:?FILE_AGENT_CONNECTOR_ARCHIVE_PATH is required}"
runtime_preflight="${FILE_AGENT_RUNTIME_PREFLIGHT_PATH:?FILE_AGENT_RUNTIME_PREFLIGHT_PATH is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_dir="$(cd "$(dirname "$artifact_path")/.." && pwd)"
result_path="$state_dir/deployment/file-agent-runtime-m3-m31-apply-result.json"
source "$script_dir/ssh-transport.sh"

test -f "$handoff_manifest"
test -f "$connector_archive"
test -f "$runtime_preflight"
mkdir -p "$(dirname "$result_path")"

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-file-agent-runtime-m3-m31-apply-${release_id}-${source_revision:0:12}"
cleanup() {
  transport_cleanup
}
trap cleanup EXIT

transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$handoff_manifest" "$remote_stage/handoff-manifest.json"
transport_copy_to "$connector_archive" "$remote_stage/$(basename "$connector_archive")"
transport_copy_to "$runtime_preflight" "$remote_stage/runtime-preflight.json"
for file in runner_common.py remote-apply.py remote-rollback.py; do
  transport_copy_to "$script_dir/$file" "$remote_stage/$file"
done
transport_exec "chmod 700 '$remote_stage/remote-apply.py' '$remote_stage/remote-rollback.py' '$remote_stage/runner_common.py' && python3 '$remote_stage/remote-apply.py' --stage '$remote_stage'"
transport_copy_from "$remote_stage/DEPLOY_RESULT.json" "$result_path"
cat "$result_path"
