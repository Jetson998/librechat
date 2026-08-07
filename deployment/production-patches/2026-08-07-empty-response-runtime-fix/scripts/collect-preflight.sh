#!/usr/bin/env bash
# release-governance:read-only-target-preflight
set -Eeuo pipefail

source_revision="${1:?source revision is required}"
artifact_sha256="${2:?artifact sha256 is required}"
release_plan_sha256="${3:?release plan sha256 is required}"
output_path="${4:?output path is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patch_root="$(cd "$script_dir/.." && pwd)"
source "$script_dir/ssh-transport.sh"

if [[ ! "$source_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "source revision must be a full 40-character commit SHA" >&2
  exit 2
fi
if [[ ! "$artifact_sha256" =~ ^[0-9a-f]{64}$ || ! "$release_plan_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "artifact and release plan digests must be 64-character SHA-256 values" >&2
  exit 2
fi

python3 - "$patch_root/SOURCE_MANIFEST.json" "$patch_root" <<'PY'
import hashlib
import json
import pathlib
import sys

manifest_path, root = map(pathlib.Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
assert manifest["status"] == "development_only"
assert len(manifest["targets"]) == 4
for target in manifest["targets"]:
    path = root / target["source"]
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    assert actual == target["candidate_sha256"], target["source"]
PY

remote_stage="/tmp/librechat-empty-response-preflight-${source_revision:0:12}-$$"
cleanup() {
  if [[ -n "${LIBRECHAT_SSH_MODE:-}" ]]; then
    transport_exec "rm -rf '$remote_stage'" >/dev/null 2>&1 || true
  fi
  transport_cleanup || true
}
trap cleanup EXIT

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$script_dir/remote-preflight.py" "$remote_stage/remote-preflight.py"
transport_copy_to "$patch_root/SOURCE_MANIFEST.json" "$remote_stage/SOURCE_MANIFEST.json"
transport_exec "chmod 700 '$remote_stage/remote-preflight.py' && python3 '$remote_stage/remote-preflight.py' --manifest '$remote_stage/SOURCE_MANIFEST.json' --source-revision '$source_revision' --artifact-sha256 '$artifact_sha256' --release-plan-sha256 '$release_plan_sha256' --output '$remote_stage/runtime-preflight.json'"
mkdir -p "$(dirname "$output_path")"
transport_copy_from "$remote_stage/runtime-preflight.json" "$output_path"
python3 - "$output_path" "$source_revision" "$artifact_sha256" "$release_plan_sha256" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["status"] == "passed"
assert payload["source_revision"] == sys.argv[2]
assert payload["artifact_sha256"] == sys.argv[3]
assert payload["release_plan_sha256"] == sys.argv[4]
PY
printf 'target_preflight=passed output=%s\n' "$output_path"
