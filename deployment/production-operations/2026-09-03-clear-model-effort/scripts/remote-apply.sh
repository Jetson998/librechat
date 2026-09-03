#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=chat-mongodb
# release-governance:target-lock
set -Eeuo pipefail

stage_dir="${1:?stage directory is required}"
source_revision="${2:?source revision is required}"
artifact_sha256="${3:?artifact digest is required}"
mongo_script="$stage_dir/mongo-config.js"
preflight="$stage_dir/runtime-preflight.json"
rollback_script="$stage_dir/remote-rollback.sh"
test -f "$mongo_script" -a -f "$preflight" -a -f "$rollback_script"

python3 - "$preflight" "$source_revision" "$artifact_sha256" <<'PY'
import json
import sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
assert data['status'] == 'passed'
assert data['source_revision'] == sys.argv[2]
assert data['artifact_sha256'] == sys.argv[3]
assert data['write_operations'] == []
PY

timestamp="$(date -u +%Y%m%d%H%M%S)"
backup_id="clear-model-effort-${source_revision:0:12}-${timestamp}"
backup_dir="/opt/librechat/backups/$backup_id"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -p "$mongo_script" "$backup_dir/mongo-config.js"
cp -p "$rollback_script" "$backup_dir/remote-rollback.sh"
chmod 700 "$backup_dir/remote-rollback.sh"
cp -p "$preflight" "$backup_dir/runtime-preflight.json"

before_output="$(docker exec -e CLEAR_MODEL_EFFORT_MODE=preflight -i chat-mongodb mongosh --quiet LibreChat --file /dev/stdin < "$mongo_script")"
before_json="$(printf '%s\n' "$before_output" | tail -n 1)"
printf '%s\n' "$before_json" > "$backup_dir/before.json"

rollback_on_error() {
  set +e
  docker exec -e CLEAR_MODEL_EFFORT_MODE=rollback -e CLEAR_MODEL_EFFORT_BACKUP_ID="$backup_id" -i \
    chat-mongodb mongosh --quiet LibreChat --file /dev/stdin < "$mongo_script" > "$backup_dir/rollback-output.log" 2>&1
}

if ! apply_output="$(docker exec -e CLEAR_MODEL_EFFORT_MODE=apply -e CLEAR_MODEL_EFFORT_BACKUP_ID="$backup_id" -i \
  chat-mongodb mongosh --quiet LibreChat --file /dev/stdin < "$mongo_script")"; then
  rollback_on_error
  exit 1
fi
apply_json="$(printf '%s\n' "$apply_output" | tail -n 1)"
printf '%s\n' "$apply_json" > "$backup_dir/apply.json"

if ! verify_output="$(docker exec -e CLEAR_MODEL_EFFORT_MODE=preflight -i chat-mongodb mongosh --quiet LibreChat --file /dev/stdin < "$mongo_script")"; then
  rollback_on_error
  exit 1
fi
verify_json="$(printf '%s\n' "$verify_output" | tail -n 1)"
printf '%s\n' "$verify_json" > "$backup_dir/after.json"

python3 - "$before_json" "$apply_json" "$verify_json" "$source_revision" "$artifact_sha256" "$backup_id" "$backup_dir" "$stage_dir/DEPLOY_RESULT.json" <<'PY'
import json
import sys
from datetime import datetime, timezone

before = json.loads(sys.argv[1])
applied = json.loads(sys.argv[2])
after = json.loads(sys.argv[3])
assert applied['status'] == 'passed'
assert after['status'] == 'passed'
assert after['alreadyCleared'] is True
result = {
    'schema_version': 1,
    'status': 'passed',
    'completed_at': datetime.now(timezone.utc).isoformat(),
    'source_revision': sys.argv[4],
    'artifact_sha256': sys.argv[5],
    'backup_id': sys.argv[6],
    'backup_dir': sys.argv[7],
    'before': before,
    'apply': applied,
    'after': after,
    'changed_services': ['chat-mongodb:data'],
    'restarted_services': [],
}
for path in (sys.argv[8], sys.argv[7] + '/DEPLOY_RESULT.json'):
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
print(json.dumps(result, ensure_ascii=False, sort_keys=True))
PY
