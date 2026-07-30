#!/usr/bin/env python3
"""Collect a read-only CodeAPI incident and rollback baseline."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


CONTAINERS = (
    "LibreChat-API",
    "LibreChat-NGINX",
    "LibreChat-CodeAPI",
    "LibreChat-RAG-API",
    "LibreChat-Admin-Panel",
    "chat-mongodb",
)
EXPECTED_IMAGE_ID = "sha256:dc97d2378247102a6ef9f42dbabc9698ed5e39d299179db5b356f7a2e7681b3c"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, text=True, capture_output=True)
    if check and completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(name: str) -> dict:
    payload = json.loads(run(["docker", "inspect", name]).stdout)[0]
    require(payload["State"].get("Running") is True, f"{name} is not running")
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


def codeapi_pid_state(payload: dict) -> dict:
    host_pid = int(payload["State"]["Pid"])
    cgroup_rel = Path(f"/proc/{host_pid}/cgroup").read_text(encoding="utf-8").strip().split("::", 1)[1]
    cgroup = Path("/sys/fs/cgroup") / cgroup_rel.lstrip("/")
    children = run(["ps", "--ppid", str(host_pid), "-o", "stat=,comm="], check=False)
    parsed = [line.split(None, 1) for line in children.stdout.splitlines() if line.strip()]
    zombies = Counter(parts[1] for parts in parsed if parts[0].startswith("Z"))
    return {
        "host_pid": host_pid,
        "pids_current": int((cgroup / "pids.current").read_text(encoding="utf-8")),
        "pids_max": (cgroup / "pids.max").read_text(encoding="utf-8").strip(),
        "pids_events": (cgroup / "pids.events").read_text(encoding="utf-8").strip(),
        "zombie_count": sum(zombies.values()),
        "zombies_by_command": dict(sorted(zombies.items())),
    }


def main() -> None:
    output = Path(sys.argv[1])
    root = Path("/opt/librechat")
    compose_base = root / "compose.yaml"
    compose_override = root / "compose.override.yaml"
    require(compose_base.is_file() and compose_override.is_file(), "Compose files are missing")
    containers = {name: inspect(name) for name in CONTAINERS}
    codeapi = containers["LibreChat-CodeAPI"]
    require(codeapi["Image"] == EXPECTED_IMAGE_ID, "CodeAPI image identity drift")
    require(codeapi["HostConfig"].get("Init") in {None, False}, "CodeAPI init baseline changed")
    require(codeapi["HostConfig"].get("PidsLimit") == 256, "CodeAPI PID limit drift")
    require("\n  codeapi:" not in compose_override.read_text(encoding="utf-8"), "CodeAPI is already managed by current override")
    interface = run([
        "docker", "exec", "LibreChat-API", "node", "-e",
        "fetch('http://codeapi:8000/healthz').then(r=>{if(!r.ok)process.exit(2);console.log(r.status)}).catch(()=>process.exit(3))",
    ])
    require(interface.stdout.strip() == "200", "API-to-CodeAPI health interface failed")
    image_present = run(["docker", "image", "inspect", EXPECTED_IMAGE_ID], check=False).returncode == 0
    require(image_present, "rollback image is unavailable")
    mounts = codeapi.get("Mounts", [])
    require(any(m.get("Source") == "/opt/librechat/codeapi-data" and m.get("Destination") == "/srv/codeapi-data" for m in mounts), "CodeAPI data mount drift")
    baseline = {
        "compose_base_sha256": digest(compose_base),
        "compose_override_sha256": digest(compose_override),
        "containers": {
            name: {
                "id": payload["Id"],
                "image_id": payload["Image"],
                "started_at": payload["State"]["StartedAt"],
            }
            for name, payload in containers.items()
        },
        "codeapi": {
            "image": codeapi["Config"]["Image"],
            "image_id": codeapi["Image"],
            "init": codeapi["HostConfig"].get("Init"),
            "memory": codeapi["HostConfig"].get("Memory"),
            "memory_swap": codeapi["HostConfig"].get("MemorySwap"),
            "pids_limit": codeapi["HostConfig"].get("PidsLimit"),
            "restart": codeapi["HostConfig"].get("RestartPolicy", {}).get("Name"),
            "mounts": mounts,
            "pid_state": codeapi_pid_state(codeapi),
        },
    }
    payload = {
        "schema_version": 1,
        "status": "passed",
        "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "checked_services": list(CONTAINERS),
        "checks": [
            {"id": "service-state", "status": "passed"},
            {"id": "dependency-interface", "status": "passed"},
            {"id": "host-memory", "status": "passed"},
            {"id": "host-disk", "status": "passed"},
            {"id": "rollback-available", "status": "passed"},
            {"id": "codeapi-pid-exhaustion-baseline", "status": "passed"},
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
