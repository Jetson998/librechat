#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API,LibreChat-Admin-Panel,LibreChat-CodeAPI
# release-governance:target-lock
set -Eeuo pipefail

source_revision="${RELEASE_SOURCE_REVISION:?RELEASE_SOURCE_REVISION is required}"
handoff_tar="${1:?deployment handoff tarball is required}"
runtime_evidence="${2:?runtime preflight evidence is required}"
result_path="${3:-$PWD/DEPLOY_RESULT.json}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/ssh-transport.sh"

test -f "$handoff_tar"
test -f "$runtime_evidence"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_revision"])' "$runtime_evidence")" = "$source_revision"

handoff_stage="$(mktemp -d "${TMPDIR:-/tmp}/librechat-diagnostic-handoff.XXXXXX")"
remote_stage="/tmp/librechat-diagnostic-log-backend-${source_revision:0:12}"
cleanup() {
  rm -rf "$handoff_stage"
  transport_cleanup
}
trap cleanup EXIT

tar -xzf "$handoff_tar" -C "$handoff_stage"
python3 - "$handoff_stage/deployment-handoff-manifest.json" "$handoff_stage" <<'PY'
import hashlib
import json
import pathlib
import sys

manifest_path, root = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding="utf-8"))
assert manifest["status"] == "packaged_for_later_deployment"
files = {item["kind"]: item for item in manifest["artifacts"]}
for kind, name in {
    "api-office-overlay": "api-office-overlay-d44feb7eb4b0.tar.gz",
    "admin-image-tar": "admin-image-a64ca0d3d1ee.tar",
}.items():
    path = pathlib.Path(root) / name
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    assert actual == files[kind]["sha256"], f"handoff digest mismatch: {kind}"
PY

api_tar="$handoff_stage/api-office-overlay-d44feb7eb4b0.tar.gz"
admin_tar="$handoff_stage/admin-image-a64ca0d3d1ee.tar"
remote_apply="$script_dir/remote-apply.py"
remote_rollback="$script_dir/remote-rollback.sh"
for file in "$api_tar" "$admin_tar" "$remote_apply" "$remote_rollback"; do
  test -f "$file"
done

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
trap 'cleanup' EXIT
transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$api_tar" "$remote_stage/api-office-overlay.tar.gz"
transport_copy_to "$admin_tar" "$remote_stage/admin-image.tar"
transport_copy_to "$handoff_stage/deployment-handoff-manifest.json" "$remote_stage/deployment-handoff-manifest.json"
transport_copy_to "$runtime_evidence" "$remote_stage/runtime-preflight.json"
transport_copy_to "$remote_apply" "$remote_stage/remote-apply.py"
transport_copy_to "$remote_rollback" "$remote_stage/remote-rollback.sh"
transport_exec "chmod 700 '$remote_stage/remote-apply.py' '$remote_stage/remote-rollback.sh' && python3 '$remote_stage/remote-apply.py' '$remote_stage' '$source_revision'"

mkdir -p "$(dirname "$result_path")"
transport_copy_from "$remote_stage/DEPLOY_RESULT.json" "$result_path"
cp -f "$result_path" "$script_dir/DEPLOY_RESULT.json"
cat "$result_path"
