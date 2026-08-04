#!/usr/bin/env bash
set -Eeuo pipefail

output_path="${1:?local preflight output path is required}"
handoff_manifest="${FILE_AGENT_HANDOFF_MANIFEST_PATH:?FILE_AGENT_HANDOFF_MANIFEST_PATH is required}"
connector_archive="${FILE_AGENT_CONNECTOR_ARCHIVE_PATH:?FILE_AGENT_CONNECTOR_ARCHIVE_PATH is required}"
source_revision="${RELEASE_SOURCE_REVISION:?RELEASE_SOURCE_REVISION is required}"
artifact_sha256="${RELEASE_ARTIFACT_SHA256:?RELEASE_ARTIFACT_SHA256 is required}"
release_plan_sha256="${RELEASE_PLAN_SHA256:?RELEASE_PLAN_SHA256 is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/ssh-transport.sh"

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-file-agent-runtime-m3-m31-preflight-${source_revision:0:12}-$$"
cleanup() {
  transport_cleanup
}
trap cleanup EXIT

transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$handoff_manifest" "$remote_stage/handoff-manifest.json"
transport_copy_to "$connector_archive" "$remote_stage/$(basename "$connector_archive")"
transport_copy_to "$script_dir/runner_common.py" "$remote_stage/runner_common.py"
transport_copy_to "$script_dir/remote-preflight.py" "$remote_stage/remote-preflight.py"
transport_exec "chmod 700 '$remote_stage/remote-preflight.py' '$remote_stage/runner_common.py' && python3 '$remote_stage/remote-preflight.py' --stage '$remote_stage' --output '$remote_stage/runtime-preflight.json' --source-revision '$source_revision' --artifact-sha256 '$artifact_sha256' --release-plan-sha256 '$release_plan_sha256'"

mkdir -p "$(dirname "$output_path")"
transport_copy_from "$remote_stage/runtime-preflight.json" "$output_path"
printf 'file_agent_dual_service_preflight=%s\n' "$output_path"
