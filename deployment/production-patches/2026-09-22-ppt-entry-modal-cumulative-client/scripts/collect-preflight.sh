#!/usr/bin/env bash
set -Eeuo pipefail

release_id="${1:?release id is required}"
archive="${2:?candidate archive is required}"
output="${3:?output evidence path is required}"
patch_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
transport="$patch_root/scripts/ssh-transport.sh"
remote_preflight="$patch_root/scripts/remote-preflight.py"
metadata="$patch_root/client/artifact.json"
candidate_revision="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source"]["candidate_revision"])' "$metadata")"
remote_stage="/tmp/ppt-entry-modal-cumulative-client-preflight-${candidate_revision:0:12}"
local_raw="$(mktemp "${TMPDIR:-/tmp}/ppt-entry-modal-cumulative-client-preflight.XXXXXX")"

python3 "$patch_root/scripts/verify-artifact.py" "$archive" "$metadata" >/dev/null
source "$transport"
trap 'transport_cleanup; rm -f "$local_raw"' EXIT
host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$metadata" "$remote_stage/artifact.json"
transport_copy_to "$remote_preflight" "$remote_stage/remote-preflight.py"
transport_exec "chmod 700 '$remote_stage/remote-preflight.py' && python3 '$remote_stage/remote-preflight.py' '$remote_stage/artifact.json' '$remote_stage/runtime-raw.json' >/dev/null"
transport_copy_from "$remote_stage/runtime-raw.json" "$local_raw"

python3 - "$local_raw" "$release_id" "$archive" "$metadata" "$output" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

raw_path, release_id, archive, metadata, output = map(Path, sys.argv[1:])
payload = json.loads(raw_path.read_text(encoding="utf-8"))
meta = json.loads(metadata.read_text(encoding="utf-8"))
if payload.get("status") != "passed" or payload.get("write_operations") != []:
    raise SystemExit("remote preflight was not read-only and passed")
payload.update({
    "release_id": release_id.name,
    "candidate_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "candidate_revision": meta["source"]["candidate_revision"],
    "client_artifact": meta["client"],
    "ppt_artifact": meta["ppt"],
})
Path(output).parent.mkdir(parents=True, exist_ok=True)
Path(output).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps(payload, indent=2, sort_keys=True))
PY

printf 'runtime_preflight=%s\n' "$output"
