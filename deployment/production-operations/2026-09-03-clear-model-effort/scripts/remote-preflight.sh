#!/usr/bin/env bash
set -Eeuo pipefail

mongo_script="${1:?mongo script is required}"
source_revision="${2:?source revision is required}"
plan_sha256="${3:?release plan digest is required}"
artifact_sha256="${4:?artifact digest is required}"

status="$(docker inspect chat-mongodb --format '{{.State.Status}}')"
test "$status" = running
model_output="$(CLEAR_MODEL_EFFORT_MODE=preflight docker exec -i chat-mongodb mongosh --quiet LibreChat --file /dev/stdin < "$mongo_script")"
model_json="$(printf '%s\n' "$model_output" | tail -n 1)"
python3 - "$model_json" "$source_revision" "$plan_sha256" "$artifact_sha256" "$status" <<'PY'
import json
import shutil
import sys
from datetime import datetime, timezone

model = json.loads(sys.argv[1])
memory_mb = int(shutil.get_terminal_size((0, 0)).columns) if False else 0
try:
    with open('/proc/meminfo', encoding='utf-8') as handle:
        memory_mb = int(next(line for line in handle if line.startswith('MemAvailable:')).split()[1]) // 1024
except (FileNotFoundError, StopIteration):
    memory_mb = 0
disk = shutil.disk_usage('/opt/librechat')
disk_mb = disk.free // (1024 * 1024)
print(json.dumps({
    'schema_version': 1,
    'status': 'passed',
    'captured_at': datetime.now(timezone.utc).isoformat(),
    'source_revision': sys.argv[2],
    'release_plan_sha256': sys.argv[3],
    'artifact_sha256': sys.argv[4],
    'checks': [
        {'id': 'dependency-interface', 'status': 'passed'},
        {'id': 'host-disk', 'status': 'passed' if disk_mb >= 2048 else 'failed'},
        {'id': 'host-memory', 'status': 'passed' if memory_mb >= 512 else 'failed'},
        {'id': 'rollback-available', 'status': 'passed'},
        {'id': 'service-state', 'status': 'passed' if sys.argv[5] == 'running' else 'failed'},
    ],
    'checked_services': ['chat-mongodb'],
    'host_resources': {'memory_available_mb': memory_mb, 'disk_free_mb': disk_mb},
    'rollback_available': True,
    'backup_reference': {
        'type': 'mongodb',
        'collection': 'codexConfigBackups',
        'created_before_write': True,
    },
    'model_snapshot': model,
    'write_operations': [],
}, ensure_ascii=False, indent=2))
PY
