#!/usr/bin/env bash
set -Eeuo pipefail

release_id="${1:?release id is required}"
artifact_zip="${2:?Client artifact ZIP is required}"
output_path="${3:-}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patch_root="$(cd "$script_dir/.." && pwd)"
root_dir="$(cd "$patch_root/../../.." && pwd)"
state_dir="$root_dir/.release-state/$release_id"
record_path="$root_dir/deployment/release-records/$release_id/RELEASE.json"
plan_path="$state_dir/release-plan.json"
manifest_path="$state_dir/artifacts/manifest.json"
metadata_path="$patch_root/client/artifact.json"
verify_script="$script_dir/verify-artifact.py"
remote_preflight="$script_dir/remote-preflight.py"
snapshot_script="$patch_root/migration/snapshot.js"

test -f "$record_path"
test -f "$plan_path"
test -f "$manifest_path"
test -f "$metadata_path"
test -f "$verify_script"
test -f "$remote_preflight"
test -f "$snapshot_script"
test -f "$artifact_zip"

if [[ -z "$output_path" ]]; then
  output_path="$state_dir/runtime-preflight.json"
fi
mkdir -p "$(dirname "$output_path")"

python3 "$verify_script" "$artifact_zip" "$metadata_path"

source_revision="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_revision"])' "$record_path")"
remote_stage="/tmp/librechat-preset-agent-runtime-category-preflight-${source_revision:0:12}"
remote_raw="$remote_stage/runtime-raw.json"
local_raw="$(mktemp "${TMPDIR:-/tmp}/librechat-preset-agent-runtime-category-runtime.XXXXXX")"
host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"

source "$script_dir/ssh-transport.sh"
trap 'transport_cleanup' EXIT
transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$metadata_path" "$remote_stage/artifact.json"
transport_copy_to "$remote_preflight" "$remote_stage/remote-preflight.py"
transport_copy_to "$snapshot_script" "$remote_stage/snapshot.js"
transport_exec "chmod 700 '$remote_stage/remote-preflight.py' && python3 '$remote_stage/remote-preflight.py' '$remote_stage/artifact.json' '$remote_stage/snapshot.js' '$remote_raw' >/dev/null"
transport_copy_from "$remote_raw" "$local_raw"

python3 - "$local_raw" "$record_path" "$plan_path" "$manifest_path" \
  "$metadata_path" "$output_path" <<'PY'
import json
import sys
from pathlib import Path

raw_path, record_path, plan_path, manifest_path, metadata_path, output_path = map(
    Path, sys.argv[1:]
)
raw = json.loads(raw_path.read_text(encoding="utf-8"))
record = json.loads(record_path.read_text(encoding="utf-8"))
plan = json.loads(plan_path.read_text(encoding="utf-8"))
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

if raw.get("status") != "passed" or raw.get("write_operations") != []:
    raise SystemExit("remote preflight did not produce a read-only passed snapshot")

raw.update(
    {
        "source_revision": record["source_revision"],
        "release_plan_sha256": plan["release_plan_sha256"],
        "artifact_sha256": manifest["artifact"]["sha256"],
        "client_artifact": {
            "origin": metadata["artifact"]["origin"],
            "github_actions_run": metadata["github_actions"]["run_id"],
            "github_actions_artifact_id": metadata["github_actions"]["artifact_id"],
            "github_actions_artifact_sha256": metadata["github_actions"][
                "reported_artifact_sha256"
            ],
            "zip_sha256": metadata["artifact"]["zip_sha256"],
            "client_tar_sha256": metadata["artifact"]["members"][
                "client-dist.tar.gz"
            ],
            "composed_index_sha256": metadata["client"][
                "composed_index_sha256"
            ],
            "hidden_contact_agent_ids": metadata["client"][
                "hidden_contact_agent_ids"
            ],
            "id_mapping": metadata["migration"]["id_mapping"],
            "compiled_digest": metadata["source"]["compiled_digest"],
        },
    }
)
output_path.write_text(
    json.dumps(raw, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
print(json.dumps(raw, indent=2, sort_keys=True))
PY

printf 'runtime_preflight=%s\n' "$output_path"
