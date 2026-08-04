#!/usr/bin/env bash
set -Eeuo pipefail

output_path="${1:?local runtime preflight output is required}"
source_revision="${2:?source revision is required}"
release_plan_sha256="${3:?release plan digest is required}"
artifact_sha256="${4:?artifact digest is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/../../../.." && pwd)"
source "$script_dir/ssh-transport.sh"

handoff_dir="$(mktemp -d "${TMPDIR:-/tmp}/file-agent-api-preflight.XXXXXX")"
remote_stage="/tmp/librechat-file-agent-runtime-preflight-${source_revision:0:12}-$$"
cleanup() {
  rm -rf "$handoff_dir"
  transport_cleanup
}
trap cleanup EXIT

overlay_archive="$handoff_dir/file-agent-api-overlay.tar.gz"
handoff_manifest="$handoff_dir/handoff-manifest.json"
python3 "$script_dir/verify-overlay.py" \
  --build-handoff \
  --output "$overlay_archive" \
  --handoff-manifest "$handoff_manifest" \
  --source-revision "$source_revision" \
  --artifact-sha256 "$artifact_sha256" \
  --release-plan-sha256 "$release_plan_sha256" >/dev/null

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$handoff_manifest" "$remote_stage/handoff-manifest.json"
transport_copy_to "$script_dir/remote-preflight.py" "$remote_stage/remote-preflight.py"
transport_exec "chmod 700 '$remote_stage/remote-preflight.py' && python3 '$remote_stage/remote-preflight.py' --stage '$remote_stage' --output '$remote_stage/runtime-preflight.json' --source-revision '$source_revision' --artifact-sha256 '$artifact_sha256' --release-plan-sha256 '$release_plan_sha256'"

mkdir -p "$(dirname "$output_path")"
transport_copy_from "$remote_stage/runtime-preflight.json" "$output_path"
python3 "$script_dir/verify-overlay.py" \
  --validate-runtime-evidence "$output_path" \
  --expected-source-revision "$source_revision" \
  --expected-artifact-sha256 "$artifact_sha256" >/dev/null
printf 'runtime_preflight=%s\n' "$output_path"
