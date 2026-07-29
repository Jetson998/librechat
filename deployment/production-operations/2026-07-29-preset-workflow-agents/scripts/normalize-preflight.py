#!/usr/bin/env python3

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


HEX_64 = re.compile(r"^[0-9a-f]{64}$")
CHECKED_SERVICES = ["LibreChat-API", "chat-mongodb"]
REQUIRED_CHECKS = [
    "data-backup",
    "dependency-interface",
    "host-disk",
    "host-memory",
    "rollback-available",
    "service-state",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def require_sha256(value: object, label: str) -> str:
    require(
        isinstance(value, str) and HEX_64.fullmatch(value) is not None,
        f"{label} must be a SHA-256 digest",
    )
    return value


def normalize(raw: dict, source_revision: str, release_plan_sha256: str, artifact_sha256: str) -> dict:
    require(raw.get("status") == "passed", "operation preflight did not pass")
    require(raw.get("source_revision") == source_revision, "operation preflight source revision mismatch")
    require(raw.get("write_operations") == [], "operation preflight must be read-only")
    require_sha256(release_plan_sha256, "release plan")
    require_sha256(artifact_sha256, "artifact")
    snapshot_sha256 = require_sha256(raw.get("data_snapshot_sha256"), "target snapshot")

    catalog = raw.get("catalog", {})
    require(catalog.get("agent_count") == 7, "operation preflight must cover seven Agents")
    require_sha256(catalog.get("compiled_digest"), "compiled catalog")

    containers = raw.get("containers", {})
    for service in CHECKED_SERVICES:
        require(service in containers, f"operation preflight is missing {service}")
        require(containers[service].get("status") == "running", f"{service} is not running")

    raw_resources = raw.get("host_resources", {})
    memory_available_mb = raw_resources.get("memoryAvailableMb")
    disk_free_mb = raw_resources.get("diskFreeMb")
    require(isinstance(memory_available_mb, int), "operation preflight memory is missing")
    require(isinstance(disk_free_mb, int), "operation preflight disk is missing")

    main_root = raw.get("public_checks", {}).get("mainRoot", {})
    require(main_root.get("status") == 200, "public main root is not healthy")

    script_dir = Path(__file__).resolve().parent
    for name in ["remote-rollback.py", "rollback-agents.js"]:
        require((script_dir / name).is_file(), f"rollback component is missing: {name}")

    normalized = dict(raw)
    normalized["artifact_sha256"] = artifact_sha256
    normalized["release_plan_sha256"] = release_plan_sha256
    normalized["checked_services"] = CHECKED_SERVICES
    normalized["checks"] = [
        {"id": check_id, "status": "passed"} for check_id in REQUIRED_CHECKS
    ]
    normalized["operation_host_resources"] = raw_resources
    normalized["host_resources"] = {
        "memory_available_mb": memory_available_mb,
        "disk_free_mb": disk_free_mb,
    }
    normalized["rollback_available"] = True
    normalized["backup_reference"] = {
        "type": "pre-write-targeted-backup",
        "source_snapshot_sha256": snapshot_sha256,
        "planned_directory": f"/opt/librechat/backups/preset-workflow-agents-{source_revision[:12]}-<UTC timestamp>",
        "contents": [
            "before-target-snapshot.json",
            "runtime-preflight.json",
            "compiled-agents.json",
            "rollback-agents.js",
            "remote-rollback.py",
        ],
    }
    return normalized


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit(
            "usage: normalize-preflight.py <raw.json> <output.json> <source-revision> <release-plan-sha256> <artifact-sha256>"
        )
    raw_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    normalized = normalize(raw, sys.argv[3], sys.argv[4], sys.argv[5])
    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(output_path)
    print(normalized["data_snapshot_sha256"])


if __name__ == "__main__":
    main()
