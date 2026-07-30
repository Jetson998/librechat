#!/usr/bin/env bash
set -Eeuo pipefail

release_id="${1:?release id is required}"
output_path="${2:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patch_root="$(cd "$script_dir/.." && pwd)"
root_dir="$(cd "$patch_root/../../.." && pwd)"
state_dir="$root_dir/.release-state/$release_id"
record_path="$root_dir/deployment/release-records/$release_id/RELEASE.json"
plan_path="$state_dir/release-plan.json"
manifest_path="$state_dir/artifacts/manifest.json"
transport_script="$root_dir/deployment/production-patches/2026-07-31-agent-category-dedup-count-fix/scripts/ssh-transport.sh"

test -f "$record_path"
test -f "$plan_path"
test -f "$manifest_path"
test -f "$script_dir/remote-preflight.py"
test -f "$transport_script"
if [[ -z "$output_path" ]]; then
  output_path="$state_dir/runtime-preflight.json"
fi
mkdir -p "$(dirname "$output_path")"

source_revision="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_revision"])' "$record_path")"
remote_stage="/tmp/librechat-codeapi-reaper-preflight-${source_revision:0:12}"
local_raw="$(mktemp "${TMPDIR:-/tmp}/librechat-codeapi-reaper.XXXXXX")"
source "$transport_script"
trap 'transport_cleanup' EXIT
transport_prepare "${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}" "${LIBRECHAT_PRODUCTION_USER:-root}"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$script_dir/remote-preflight.py" "$remote_stage/remote-preflight.py"
transport_exec "chmod 700 '$remote_stage/remote-preflight.py' && python3 '$remote_stage/remote-preflight.py' '$remote_stage/runtime-raw.json' >/dev/null"
transport_copy_from "$remote_stage/runtime-raw.json" "$local_raw"

python3 - "$local_raw" "$record_path" "$plan_path" "$manifest_path" "$output_path" <<'PY'
import json, sys
from pathlib import Path
raw_path, record_path, plan_path, manifest_path, output_path = map(Path, sys.argv[1:])
raw = json.loads(raw_path.read_text(encoding="utf-8"))
record = json.loads(record_path.read_text(encoding="utf-8"))
plan = json.loads(plan_path.read_text(encoding="utf-8"))
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if raw.get("status") != "passed" or raw.get("write_operations") != []:
    raise SystemExit("remote preflight was not read-only and passed")
raw.update({
    "source_revision": record["source_revision"],
    "release_plan_sha256": plan["release_plan_sha256"],
    "artifact_sha256": manifest["artifact"]["sha256"],
})
output_path.write_text(json.dumps(raw, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps(raw, indent=2, sort_keys=True))
PY

printf 'runtime_preflight=%s\n' "$output_path"
