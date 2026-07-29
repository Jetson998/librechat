#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from runtime_common import (
    collect_target_snapshot,
    container_snapshot,
    load_json,
    public_checks,
    run_mongosh,
    snapshot_digest,
    validate_container_health,
    verify_compiled,
    write_json,
)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: remote-rollback.py <backup-dir>")
    backup_dir = Path(sys.argv[1]).resolve()
    compiled = load_json(backup_dir / "compiled-agents.json")
    preflight = load_json(backup_dir / "runtime-preflight.json")
    verify_compiled(compiled)

    containers_before = container_snapshot()
    validate_container_health(containers_before)
    rollback_result = run_mongosh(
        compiled,
        backup_dir / "rollback-agents.js",
        backup=preflight["data_snapshot"],
    )
    if rollback_result.get("writes") != ["agents"]:
        raise RuntimeError("rollback reported an unexpected write scope")
    restored = collect_target_snapshot(compiled, backup_dir / "snapshot-targets.js")
    restored_digest = snapshot_digest(restored)
    if restored_digest != preflight.get("data_snapshot_sha256"):
        raise RuntimeError("rollback target snapshot digest mismatch")
    containers_after = container_snapshot()
    validate_container_health(containers_after)
    if containers_after != containers_before:
        raise RuntimeError("a protected container changed during rollback")

    result = {
        "schema_version": 1,
        "status": "passed",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "backup_dir": str(backup_dir),
        "restored_snapshot_sha256": restored_digest,
        "rollback_result": rollback_result,
        "containers_before": containers_before,
        "containers_after": containers_after,
        "public_checks": public_checks(),
        "restarted_services": [],
    }
    write_json(backup_dir / "ROLLBACK_RESULT.json", result)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
