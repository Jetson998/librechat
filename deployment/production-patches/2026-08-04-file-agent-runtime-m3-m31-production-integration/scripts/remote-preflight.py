#!/usr/bin/env python3
"""Read-only preflight for the unified API + Runtime deployment unit."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

from runner_common import RUNTIME_SERVICE, require, sha256, validate_handoff


ROOT = Path("/opt/librechat")
API_CONTAINER = "LibreChat-API"
PROTECTED_CONTAINERS = (
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


def inspect(name: str, *, require_running: bool = True) -> dict:
    payload = json.loads(run(["docker", "inspect", name]).stdout)[0]
    state = payload.get("State", {})
    if require_running:
        require(state.get("Running") is True, f"container is not running: {name}")
        health = state.get("Health", {}).get("Status")
        require(health in {None, "healthy"}, f"container is not healthy: {name}: {health}")
    return payload


def compose_container_id(root: Path, service: str) -> str | None:
    result = run(
        [
            "docker",
            "compose",
            "--project-directory",
            str(root),
            "-f",
            str(root / "compose.yaml"),
            "-f",
            str(root / "compose.override.yaml"),
            "ps",
            "-q",
            service,
        ],
        check=False,
    )
    value = result.stdout.strip().splitlines()
    return value[0] if value else None


def host_resources(root: Path) -> dict:
    memory_kb = next(
        int(line.split()[1])
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines()
        if line.startswith("MemAvailable:")
    )
    filesystem = os.statvfs(root)
    return {
        "memory_available_mb": memory_kb // 1024,
        "disk_free_mb": filesystem.f_bavail * filesystem.f_frsize // (1024 * 1024),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--release-plan-sha256", required=True)
    parser.add_argument("--root", type=Path, default=ROOT)
    arguments = parser.parse_args()

    root = arguments.root.resolve()
    stage = arguments.stage.resolve()
    handoff = json.loads((stage / "handoff-manifest.json").read_text(encoding="utf-8"))
    deployment = validate_handoff(handoff, stage)
    require(handoff.get("source_revision") == arguments.source_revision, "handoff source revision mismatch")
    require(handoff.get("artifact_sha256") == arguments.artifact_sha256, "handoff artifact mismatch")
    require(handoff.get("release_plan_sha256") == arguments.release_plan_sha256, "handoff release plan mismatch")

    compose_base = root / "compose.yaml"
    compose_override = root / "compose.override.yaml"
    backup_root = root / "backups"
    require(compose_base.is_file(), "Compose base is missing")
    require(compose_override.is_file(), "Compose override is missing")
    require(backup_root.is_dir() and os.access(backup_root, os.W_OK), "rollback backup root is unavailable")

    resolved = json.loads(
        run(
            [
                "docker",
                "compose",
                "--project-directory",
                str(root),
                "-f",
                str(compose_base),
                "-f",
                str(compose_override),
                "config",
                "--format",
                "json",
            ]
        ).stdout
    )
    services = resolved.get("services", {})
    require("api" in services and "codeapi" in services, "API or CodeAPI Compose service is missing")
    runtime_present = RUNTIME_SERVICE in services
    runtime_id = compose_container_id(root, RUNTIME_SERVICE) if runtime_present else None
    if runtime_present:
        require(runtime_id is not None, "existing Runtime service has no container")
        runtime_payload = inspect(runtime_id)
        require(not runtime_payload.get("HostConfig", {}).get("PortBindings"), "existing Runtime publishes a host port")

    containers = {name: inspect(name) for name in PROTECTED_CONTAINERS}
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
    runtime_image = deployment["runtime_image"]
    image_check = run(["docker", "image", "inspect", runtime_image], check=False)
    require(image_check.returncode == 0, "immutable Runtime image is not present on the target")

    output = {
        "schema_version": 1,
        "status": "passed",
        "source_revision": arguments.source_revision,
        "artifact_sha256": arguments.artifact_sha256,
        "release_plan_sha256": arguments.release_plan_sha256,
        "checked_services": ["LibreChat-API", "file-agent-runtime", "LibreChat-CodeAPI"],
        "checks": [
            {"id": "compose-valid", "status": "passed"},
            {"id": "protected-services-running", "status": "passed"},
            {"id": "api-codeapi-interface", "status": "passed"},
            {"id": "runtime-image-present", "status": "passed"},
            {"id": "secret-files-and-allowlist", "status": "passed"},
            {"id": "rollback-available", "status": "passed"},
        ],
        "host_resources": host_resources(root),
        "rollback_available": True,
        "baseline": {
            "compose_base_sha256": sha256(compose_base),
            "compose_override_sha256": sha256(compose_override),
            "runtime_service_present": runtime_present,
            "runtime_container_id": runtime_id,
            "containers": {
                name: {
                    "id": payload["Id"],
                    "image_id": payload["Image"],
                    "image_ref": payload.get("Config", {}).get("Image"),
                    "started_at": payload.get("State", {}).get("StartedAt"),
                }
                for name, payload in containers.items()
            },
        },
        "write_operations": [],
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
