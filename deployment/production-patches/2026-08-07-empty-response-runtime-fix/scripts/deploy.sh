#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API
# release-governance:target-lock
set -Eeuo pipefail

source_revision="${RELEASE_SOURCE_REVISION:?RELEASE_SOURCE_REVISION is required}"
artifact_sha256="${RELEASE_ARTIFACT_SHA256:?RELEASE_ARTIFACT_SHA256 is required}"
runtime_evidence="${1:?runtime preflight evidence is required}"
result_path="${2:-$PWD/DEPLOY_RESULT.json}"
if [[ "$runtime_evidence" == "--" ]]; then
  runtime_evidence="${2:?runtime preflight evidence is required}"
  result_path="${3:-$PWD/DEPLOY_RESULT.json}"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patch_root="$(cd "$script_dir/.." && pwd)"
source "$script_dir/ssh-transport.sh"
test -f "$runtime_evidence"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_revision"])' "$runtime_evidence")" = "$source_revision"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifact_sha256"])' "$runtime_evidence")" = "$artifact_sha256"

python3 - "$patch_root/SOURCE_MANIFEST.json" "$patch_root" <<'PY'
import hashlib
import json
import pathlib
import sys

manifest_path, root = map(pathlib.Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
assert len(manifest["targets"]) == 4
for target in manifest["targets"]:
    path = root / target["source"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == target["candidate_sha256"], target["source"]
PY

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-empty-response-runtime-fix-${source_revision:0:12}-$$"
cleanup() {
  if [[ -n "${LIBRECHAT_SSH_MODE:-}" ]]; then
    transport_exec "rm -rf '$remote_stage'" >/dev/null 2>&1 || true
  fi
  transport_cleanup || true
}
trap cleanup EXIT

transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$patch_root/SOURCE_MANIFEST.json" "$remote_stage/SOURCE_MANIFEST.json"
transport_copy_to "$runtime_evidence" "$remote_stage/runtime-preflight.json"
transport_copy_to "$script_dir/remote-apply.py" "$remote_stage/remote-apply.py"
transport_copy_to "$script_dir/remote-rollback.py" "$remote_stage/remote-rollback.py"
transport_copy_to "$patch_root/client/overlay/BaseClient.js" "$remote_stage/BaseClient.js"
transport_copy_to "$patch_root/backend/overlay/api/server/controllers/agents/request.js" "$remote_stage/request.js"
transport_copy_to "$patch_root/backend/overlay/api/server/controllers/agents/InitializationFailure.js" "$remote_stage/InitializationFailure.js"
transport_copy_to "$patch_root/backend/overlay/api/server/services/DiagnosticEvents.js" "$remote_stage/DiagnosticEvents.js"
transport_exec "chmod 700 '$remote_stage/remote-apply.py' '$remote_stage/remote-rollback.py' && python3 '$remote_stage/remote-apply.py' --stage '$remote_stage' --source-revision '$source_revision' --artifact-sha256 '$artifact_sha256' --runtime-evidence '$remote_stage/runtime-preflight.json' --result '$remote_stage/DEPLOY_RESULT.json'"
mkdir -p "$(dirname "$result_path")"
transport_copy_from "$remote_stage/DEPLOY_RESULT.json" "$result_path"
cat "$result_path"
