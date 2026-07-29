#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from runtime_common import (
    collect_target_snapshot,
    container_snapshot,
    host_resources,
    load_json,
    public_checks,
    sha256_file,
    snapshot_digest,
    validate_container_health,
    validate_runtime_config,
    validate_target_snapshot,
    verify_compiled,
    read_runtime_config,
)


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: remote-preflight.py <compiled-agents.json> <snapshot-targets.js> <source-revision>")
    compiled_path = Path(sys.argv[1]).resolve()
    snapshot_script = Path(sys.argv[2]).resolve()
    source_revision = sys.argv[3]

    compiled = load_json(compiled_path)
    verify_compiled(compiled)
    snapshot = collect_target_snapshot(compiled, snapshot_script)
    validate_target_snapshot(compiled, snapshot)
    runtime_config = read_runtime_config()
    validate_runtime_config(compiled, runtime_config)
    containers = container_snapshot()
    validate_container_health(containers)
    resources = host_resources()
    if resources["memoryAvailableMb"] < 512:
        raise RuntimeError("available memory is below 512 MiB")
    if resources["diskFreeMb"] < 2048:
        raise RuntimeError("free disk is below 2048 MiB")

    result = {
        "schema_version": 1,
        "status": "passed",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "source_revision": source_revision,
        "catalog": {
            "compiled_digest": compiled["compiledDigest"],
            "file_sha256": sha256_file(compiled_path),
            "agent_count": len(compiled["agents"]),
        },
        "data_snapshot_sha256": snapshot_digest(snapshot),
        "data_snapshot": snapshot,
        "runtime_config": runtime_config,
        "containers": containers,
        "host_resources": resources,
        "public_checks": public_checks(),
        "write_operations": [],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
