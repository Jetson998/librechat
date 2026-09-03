#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir="${1:?production backup directory is required}"
mongo_script="$backup_dir/mongo-config.js"
test -f "$mongo_script"
backup_id="$(basename "$backup_dir")"
CLEAR_MODEL_EFFORT_MODE=rollback CLEAR_MODEL_EFFORT_BACKUP_ID="$backup_id" \
  docker exec -i chat-mongodb mongosh --quiet LibreChat --file /dev/stdin < "$mongo_script" > "$backup_dir/rollback-output.log"
verify_output="$(CLEAR_MODEL_EFFORT_MODE=preflight docker exec -i chat-mongodb mongosh --quiet LibreChat --file /dev/stdin < "$mongo_script")"
verify_json="$(printf '%s\n' "$verify_output" | tail -n 1)"
printf '%s\n' "$verify_json" > "$backup_dir/rollback-after.json"
python3 - "$verify_json" "$backup_dir" <<'PY'
import json
import sys
from datetime import datetime, timezone
state = json.loads(sys.argv[1])
assert state['status'] == 'passed'
result = {'status': 'passed', 'completed_at': datetime.now(timezone.utc).isoformat(), 'backup_dir': sys.argv[2], 'state': state}
with open(sys.argv[2] + '/ROLLBACK_RESULT.json', 'w', encoding='utf-8') as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
print(json.dumps(result, ensure_ascii=False, sort_keys=True))
PY
