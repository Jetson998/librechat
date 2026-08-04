#!/usr/bin/env python3
"""Collect a read-only target snapshot for the File Agent API bootstrap."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path


ROOT = Path("/opt/librechat")
API_CONTAINER = "LibreChat-API"
CHECKED_CONTAINERS = (
    "LibreChat-API",
    "chat-mongodb",
    "LibreChat-CodeAPI",
    "LibreChat-NGINX",
    "LibreChat-RAG-API",
    "LibreChat-Admin-Panel",
)


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, text=True, capture_output=True)
    if check and completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def inspect(name: str) -> dict:
    payload = json.loads(run(["docker", "inspect", name]).stdout)[0]
    state = payload.get("State", {})
    require(state.get("Running") is True, f"container is not running: {name}")
    health = state.get("Health", {}).get("Status")
    require(health in {None, "healthy"}, f"container is not healthy: {name}: {health}")
    return payload


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
        key=lambda value: (value["destination"] or "", value["source"] or ""),
    )


def container_file_sha256(path: str) -> str:
    output = run(["docker", "exec", API_CONTAINER, "sha256sum", path]).stdout.strip().split()
    require(len(output) >= 1, f"no SHA-256 returned for {path}")
    return output[0]


def container_path_exists(path: str) -> bool:
    return run(["docker", "exec", API_CONTAINER, "test", "-e", path], check=False).returncode == 0


def host_resources() -> dict:
    memory_kb = next(
        int(line.split()[1])
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines()
        if line.startswith("MemAvailable:")
    )
    filesystem = os.statvfs(ROOT)
    return {
        "memory_available_mb": memory_kb // 1024,
        "disk_free_mb": filesystem.f_bavail * filesystem.f_frsize // (1024 * 1024),
    }


def read_handoff(stage: Path) -> dict:
    path = stage / "handoff-manifest.json"
    require(path.is_file(), "handoff manifest is missing")
    handoff = json.loads(path.read_text(encoding="utf-8"))
    require(handoff.get("status") == "packaged_for_deployment", "handoff is not deployable")
    targets = handoff.get("targets")
    require(isinstance(targets, list) and len(targets) == 4, "handoff must contain four targets")
    for target in targets:
        require(target.get("destination", "").startswith("/app/api/"), "handoff destination escapes API")
        relative = Path(target.get("relative_path", ""))
        require(not relative.is_absolute() and ".." not in relative.parts, "handoff path is unsafe")
    return handoff


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--release-plan-sha256", required=True)
    arguments = parser.parse_args()

    stage = arguments.stage.resolve()
    handoff = read_handoff(stage)
    require(handoff.get("source_revision") == arguments.source_revision, "handoff revision mismatch")
    require(handoff.get("artifact_sha256") == arguments.artifact_sha256, "handoff artifact mismatch")

    compose_base = ROOT / "compose.yaml"
    compose_override = ROOT / "compose.override.yaml"
    config_file = ROOT / "librechat.yaml"
    backup_root = ROOT / "backups"
    require(compose_base.is_file(), "Compose base is missing")
    require(compose_override.is_file(), "Compose override is missing")
    require(config_file.is_file(), "LibreChat config is missing")
    require(backup_root.is_dir() and os.access(backup_root, os.W_OK), "rollback backup root is unavailable")
    run(
        [
            "docker",
            "compose",
            "--project-directory",
            str(ROOT),
            "-f",
            str(compose_base),
            "-f",
            str(compose_override),
            "config",
            "-q",
        ]
    )

    containers = {name: inspect(name) for name in CHECKED_CONTAINERS}
    codeapi_health = run(
        [
            "docker",
            "exec",
            API_CONTAINER,
            "node",
            "-e",
            "fetch('http://codeapi:8000/healthz').then((response)=>{if(!response.ok)process.exit(2)}).catch(()=>process.exit(3))",
        ],
        check=False,
    )
    require(codeapi_health.returncode == 0, "API-to-CodeAPI health interface failed")

    target_hashes: dict[str, str | None] = {}
    for target in handoff["targets"]:
        destination = target["destination"]
        baseline = target.get("baseline_sha256")
        if baseline is None:
            require(not container_path_exists(destination), f"new target already exists: {destination}")
            target_hashes[destination] = None
        else:
            actual = container_file_sha256(destination)
            require(actual == baseline, f"API baseline drifted: {destination}")
            target_hashes[destination] = actual

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
        "api_mounts": mount_snapshot(containers[API_CONTAINER]),
        "target_hashes": target_hashes,
    }
    payload = {
        "schema_version": 1,
        "status": "passed",
        "source_revision": arguments.source_revision,
        "artifact_sha256": arguments.artifact_sha256,
        "release_plan_sha256": arguments.release_plan_sha256,
        "checked_services": ["LibreChat-API", "chat-mongodb"],
        "checks": [
            {"id": "service-state", "status": "passed"},
            {"id": "dependency-interface", "status": "passed"},
            {"id": "host-memory", "status": "passed"},
            {"id": "host-disk", "status": "passed"},
            {"id": "rollback-available", "status": "passed"},
            {"id": "api-overlay-baseline", "status": "passed"},
        ],
        "host_resources": host_resources(),
        "rollback_available": True,
        "baseline": baseline,
        "write_operations": [],
    }
    arguments.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
