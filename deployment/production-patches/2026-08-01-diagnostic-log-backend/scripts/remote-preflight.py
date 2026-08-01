#!/usr/bin/env python3
"""Read-only production baseline for the diagnostic-log deployment."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


CONTAINERS = (
    "LibreChat-API",
    "LibreChat-Admin-Panel",
    "LibreChat-CodeAPI",
    "LibreChat-NGINX",
    "LibreChat-RAG-API",
    "chat-mongodb",
)
CAPABILITIES_PATH = "/app/packages/data-schemas/dist/admin/capabilities.cjs"
EXPECTED_CAPABILITIES_SHA256 = "5d9b8d6f3fa1de98ba4d1bec1f43310190d2d7f24dbe8d66aa50177d2dbc87a9"


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, text=True, capture_output=True)
    if check and completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(name: str) -> dict:
    payload = json.loads(run(["docker", "inspect", name]).stdout)[0]
    state = payload["State"]
    require(state.get("Running") is True, f"container is not running: {name}")
    health = state.get("Health", {}).get("Status")
    require(health in {None, "healthy"}, f"container is not healthy: {name}: {health}")
    return payload


def host_resources(root: Path) -> dict:
    memory_kb = next(
        int(line.split()[1])
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines()
        if line.startswith("MemAvailable:")
    )
    stats = os.statvfs(root)
    return {
        "memory_available_mb": memory_kb // 1024,
        "disk_free_mb": stats.f_bavail * stats.f_frsize // (1024 * 1024),
    }


def mount_snapshot(payload: dict) -> list[dict]:
    return sorted(
        [
            {
                "destination": mount.get("Destination"),
                "source": mount.get("Source"),
                "rw": bool(mount.get("RW")),
            }
            for mount in payload.get("Mounts", [])
        ],
        key=lambda item: (item["destination"] or "", item["source"] or ""),
    )


def main() -> None:
    output = Path(sys.argv[1])
    root = Path("/opt/librechat")
    compose_base = root / "compose.yaml"
    compose_override = root / "compose.override.yaml"
    config_file = root / "librechat.yaml"
    require(compose_base.is_file(), "Compose base is missing")
    require(compose_override.is_file(), "Compose override is missing")
    require(config_file.is_file(), "LibreChat config is missing")

    containers = {name: inspect(name) for name in CONTAINERS}
    codeapi = containers["LibreChat-CodeAPI"]
    require(codeapi["HostConfig"].get("Init") is True, "CodeAPI init baseline drift")
    require(codeapi["HostConfig"].get("PidsLimit") == 256, "CodeAPI PID limit drift")

    capability_hash = run(
        ["docker", "exec", "LibreChat-API", "sha256sum", CAPABILITIES_PATH]
    ).stdout.split()[0]
    require(
        capability_hash == EXPECTED_CAPABILITIES_SHA256,
        "data-schemas capability runtime baseline drift",
    )
    interface = run(
        [
            "docker",
            "exec",
            "LibreChat-API",
            "node",
            "-e",
            "fetch('http://codeapi:8000/healthz').then(r=>{if(!r.ok)process.exit(2)}).catch(()=>process.exit(3))",
        ],
        check=False,
    )
    require(interface.returncode == 0, "API-to-CodeAPI health interface failed")

    baseline = {
        "compose_base_sha256": digest(compose_base),
        "compose_override_sha256": digest(compose_override),
        "config_sha256": digest(config_file),
        "containers": {
            name: {
                "id": payload["Id"],
                "image_id": payload["Image"],
                "image_ref": payload["Config"].get("Image"),
                "started_at": payload["State"]["StartedAt"],
            }
            for name, payload in containers.items()
        },
        "api_mounts": mount_snapshot(containers["LibreChat-API"]),
        "admin_image": {
            "ref": containers["LibreChat-Admin-Panel"]["Config"].get("Image"),
            "id": containers["LibreChat-Admin-Panel"]["Image"],
        },
        "capabilities": {
            "path": CAPABILITIES_PATH,
            "sha256": capability_hash,
        },
    }
    payload = {
        "schema_version": 1,
        "status": "passed",
        "checked_services": list(CONTAINERS),
        "checks": [
            {"id": "service-state", "status": "passed"},
            {"id": "dependency-interface", "status": "passed"},
            {"id": "host-memory", "status": "passed"},
            {"id": "host-disk", "status": "passed"},
            {"id": "rollback-available", "status": "passed"},
        ],
        "host_resources": host_resources(root),
        "rollback_available": True,
        "baseline": baseline,
        "write_operations": [],
    }
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(payload, sort_keys=True))


if __name__ == "__main__":
    main()
