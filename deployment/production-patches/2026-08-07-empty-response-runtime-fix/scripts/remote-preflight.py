#!/usr/bin/env python3
"""Read-only production baseline for the empty-response API overlay."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path


ROOT = Path("/opt/librechat")
API_CONTAINER = "LibreChat-API"
CHECKED_CONTAINERS = (
    "LibreChat-API",
    "LibreChat-CodeAPI",
    "LibreChat-NGINX",
    "LibreChat-RAG-API",
    "chat-mongodb",
    "LibreChat-Admin-Panel",
)
SOURCE_REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
EXPECTED_TARGET_DESTINATIONS = {
    "/app/api/app/clients/BaseClient.js",
    "/app/api/server/controllers/agents/request.js",
    "/app/api/server/controllers/agents/InitializationFailure.js",
    "/app/api/server/services/DiagnosticEvents.js",
}


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
    require(output, f"no SHA-256 returned for {path}")
    return output[0]


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


def target_map(manifest: dict) -> dict[str, dict]:
    targets = manifest.get("targets")
    require(isinstance(targets, list) and len(targets) == 4, "manifest must contain four targets")
    mapping = {}
    for target in targets:
        destination = target.get("destination")
        require(destination and destination.startswith("/app/api/"), "target escapes API")
        require(destination not in mapping, f"duplicate target: {destination}")
        candidate = target.get("candidate_sha256", "")
        baseline = target.get("baseline_sha256", "")
        require(re.fullmatch(r"[0-9a-f]{64}", candidate), f"invalid candidate digest: {destination}")
        require(re.fullmatch(r"[0-9a-f]{64}", baseline), f"invalid baseline digest: {destination}")
        mapping[destination] = target
    return mapping


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--release-plan-sha256", required=True)
    arguments = parser.parse_args()

    require(SOURCE_REVISION_RE.fullmatch(arguments.source_revision) is not None, "invalid source revision")
    require(re.fullmatch(r"[0-9a-f]{64}", arguments.artifact_sha256) is not None, "invalid artifact digest")
    require(re.fullmatch(r"[0-9a-f]{64}", arguments.release_plan_sha256) is not None, "invalid release plan digest")
    manifest = json.loads(arguments.manifest.read_text(encoding="utf-8"))
    require(manifest.get("batch_id") == "2026-08-07-empty-response-runtime-fix", "manifest batch mismatch")
    targets = target_map(manifest)
    require(set(targets) == EXPECTED_TARGET_DESTINATIONS, "manifest target destinations drifted")

    compose_base = ROOT / "compose.yaml"
    compose_override = ROOT / "compose.override.yaml"
    backup_root = ROOT / "backups"
    require(compose_base.is_file(), "Compose base is missing")
    require(compose_override.is_file(), "Compose override is missing")
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

    target_hashes = {}
    for destination, target in targets.items():
        actual = container_file_sha256(destination)
        require(actual == target["baseline_sha256"], f"API baseline drifted: {destination}")
        target_hashes[destination] = actual

    resources = host_resources()
    require(resources["memory_available_mb"] >= 512, "host memory is below release threshold")
    require(resources["disk_free_mb"] >= 2048, "host disk is below release threshold")
    baseline = {
        "compose_base_sha256": digest(compose_base),
        "compose_override_sha256": digest(compose_override),
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
        "captured_at": run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"]).stdout.strip(),
        "source_revision": arguments.source_revision,
        "artifact_sha256": arguments.artifact_sha256,
        "release_plan_sha256": arguments.release_plan_sha256,
        "checked_services": list(CHECKED_CONTAINERS),
        "checks": [
            {"id": "service-state", "status": "passed"},
            {"id": "dependency-interface", "status": "passed"},
            {"id": "host-memory", "status": "passed"},
            {"id": "host-disk", "status": "passed"},
            {"id": "rollback-available", "status": "passed"},
            {"id": "api-overlay-baseline", "status": "passed"},
        ],
        "host_resources": resources,
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
    try:
        main()
    except Exception as error:
        raise SystemExit(f"remote_preflight_failed: {error}") from error
