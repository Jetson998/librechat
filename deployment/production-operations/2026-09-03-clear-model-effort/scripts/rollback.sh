#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=chat-mongodb
# release-governance:target-lock
set -Eeuo pipefail

backup_dir="${1:?production backup directory is required}"
local_result="${2:?local rollback result path is required}"
script_dir="deployment/production-operations/2026-09-03-clear-model-effort/scripts"
transport_script="$script_dir/ssh-transport.sh"
test -f "$transport_script"

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
source "$transport_script"
trap 'transport_cleanup' EXIT
transport_prepare "$host" "$user"
transport_exec "test -f '$backup_dir/remote-rollback.sh' && cd '$backup_dir' && bash ./remote-rollback.sh '$backup_dir'"
mkdir -p "$(dirname "$local_result")"
transport_copy_from "$backup_dir/ROLLBACK_RESULT.json" "$local_result"
python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["status"] == "passed"; print(json.dumps(data, ensure_ascii=False, sort_keys=True))' "$local_result"
