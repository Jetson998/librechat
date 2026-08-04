#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API
set -Eeuo pipefail

release_id="${RELEASE_ID:?RELEASE_ID is required}"
source_revision="${RELEASE_SOURCE_REVISION:?RELEASE_SOURCE_REVISION is required}"
artifact_sha256="${RELEASE_ARTIFACT_SHA256:?RELEASE_ARTIFACT_SHA256 is required}"
artifact_path="${RELEASE_ARTIFACT_PATH:?RELEASE_ARTIFACT_PATH is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_dir="$(cd "$(dirname "$artifact_path")/.." && pwd)"
runtime_evidence="$state_dir/runtime-preflight.json"
result_path="$state_dir/deployment/file-agent-runtime-m3r-api-bootstrap-apply-result.json"
handoff_dir="$state_dir/deployment/file-agent-runtime-m3r-api-bootstrap-handoff"
source "$script_dir/ssh-transport.sh"

test -f "$runtime_evidence"
release_plan_sha256="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["release_plan_sha256"])' "$runtime_evidence")"
python3 "$script_dir/verify-overlay.py" \
  --validate-runtime-evidence "$runtime_evidence" \
  --expected-source-revision "$source_revision" \
  --expected-artifact-sha256 "$artifact_sha256" >/dev/null

mkdir -p "$handoff_dir" "$(dirname "$result_path")"
overlay_archive="$handoff_dir/file-agent-api-overlay.tar.gz"
handoff_manifest="$handoff_dir/handoff-manifest.json"
python3 "$script_dir/verify-overlay.py" \
  --build-handoff \
  --output "$overlay_archive" \
  --handoff-manifest "$handoff_manifest" \
  --source-revision "$source_revision" \
  --artifact-sha256 "$artifact_sha256" \
  --release-plan-sha256 "$release_plan_sha256" >/dev/null
python3 "$script_dir/verify-overlay.py" \
  --verify-handoff \
  --archive "$overlay_archive" \
  --verify-manifest "$handoff_manifest" >/dev/null

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-file-agent-runtime-apply-${release_id}-${source_revision:0:12}"
cleanup() {
  transport_cleanup
}
trap cleanup EXIT

transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$overlay_archive" "$remote_stage/file-agent-api-overlay.tar.gz"
transport_copy_to "$handoff_manifest" "$remote_stage/handoff-manifest.json"
transport_copy_to "$runtime_evidence" "$remote_stage/runtime-preflight.json"
transport_copy_to "$script_dir/remote-apply.py" "$remote_stage/remote-apply.py"
transport_copy_to "$script_dir/remote-rollback.py" "$remote_stage/remote_rollback.py"

set +e
transport_exec "chmod 700 '$remote_stage/remote-apply.py' '$remote_stage/remote_rollback.py' && python3 '$remote_stage/remote-apply.py' --stage '$remote_stage'"
apply_status=$?
set -e
transport_copy_from "$remote_stage/DEPLOY_RESULT.json" "$result_path" || true
if [[ -f "$result_path" ]]; then
  cat "$result_path"
fi
exit "$apply_status"
