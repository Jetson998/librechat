#!/usr/bin/env bash
set -Eeuo pipefail

output_path="${1:?local runtime preflight output is required}"
source_revision="${2:?source revision is required}"
release_plan_sha256="${3:?release plan digest is required}"
artifact_sha256="${4:?artifact digest is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/ssh-transport.sh"

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-diagnostic-preflight-${source_revision:0:12}-$$"
remote_output="$remote_stage/runtime-preflight.json"

trap 'transport_cleanup' EXIT
transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$script_dir/remote-preflight.py" "$remote_stage/remote-preflight.py"
transport_exec "chmod 700 '$remote_stage/remote-preflight.py' && python3 '$remote_stage/remote-preflight.py' '$remote_output'"
transport_copy_from "$remote_output" "$output_path"

python3 - "$output_path" "$source_revision" "$release_plan_sha256" "$artifact_sha256" <<'PY'
import json
import sys

path, source_revision, plan_sha256, artifact_sha256 = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
assert data["status"] == "passed"
assert data["write_operations"] == []
assert data["rollback_available"] is True
data["source_revision"] = source_revision
data["release_plan_sha256"] = plan_sha256
data["artifact_sha256"] = artifact_sha256
with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
    handle.write("\n")
PY

printf 'runtime_preflight=%s\n' "$output_path"
