#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API,PPT-static-root
set -Eeuo pipefail

archive="${1:?candidate archive is required}"
runtime_evidence="${2:?runtime preflight evidence is required}"
local_result="${3:?local deployment result is required}"
patch_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
metadata="$patch_root/client/artifact.json"
candidate_revision="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source"]["candidate_revision"])' "$metadata")"
transport="$patch_root/scripts/ssh-transport.sh"

test -f "$archive"
test -f "$runtime_evidence"
test -f "$metadata"
python3 "$patch_root/scripts/verify-artifact.py" "$archive" "$metadata" >/dev/null
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidate_revision"])' "$runtime_evidence")" = "$candidate_revision"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidate_sha256"])' "$runtime_evidence")" = "$(python3 -c 'import json,sys,hashlib; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$archive")"

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/ppt-entry-modal-cumulative-client-deploy-${candidate_revision:0:12}"
source "$transport"
trap 'transport_cleanup' EXIT
transport_prepare "$host" "$user"
transport_exec "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"
transport_copy_to "$archive" "$remote_stage/candidate.tar.gz"
transport_copy_to "$metadata" "$remote_stage/artifact.json"
transport_copy_to "$runtime_evidence" "$remote_stage/runtime-preflight.json"
transport_copy_to "$patch_root/scripts/verify-artifact.py" "$remote_stage/verify-artifact.py"
transport_copy_to "$patch_root/scripts/remote-preflight.py" "$remote_stage/remote-preflight.py"
transport_copy_to "$patch_root/scripts/remote-apply.sh" "$remote_stage/remote-apply.sh"
transport_copy_to "$patch_root/scripts/remote-rollback.sh" "$remote_stage/remote-rollback.sh"
transport_exec "chmod 700 '$remote_stage/verify-artifact.py' '$remote_stage/remote-preflight.py' '$remote_stage/remote-apply.sh' '$remote_stage/remote-rollback.sh' && '$remote_stage/remote-apply.sh' '$remote_stage' '$candidate_revision'"
mkdir -p "$(dirname "$local_result")"
transport_copy_from "$remote_stage/DEPLOY_RESULT.json" "$local_result"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["status"] == "passed"; print(json.dumps(d, sort_keys=True))' "$local_result"
printf 'local_deployment_result=%s\n' "$local_result"
