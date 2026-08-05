#!/usr/bin/env python3
"""Restore the pre-apply API + Runtime Compose state."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from runner_common import native_fallback_probe, normalized_environment


ROOT = Path("/opt/librechat")
API_CONTAINER = "LibreChat-API"


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, text=True, capture_output=True)
    if check and completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def inspect_container(container_id: str, *, run_command=run) -> dict:
    result = run_command(["docker", "inspect", container_id], check=False)
    require(result.returncode == 0, f"container is missing after rollback: {container_id}")
    return json.loads(result.stdout)[0]


def wait_running(container: str, *, run_command=run, attempts: int = 90) -> None:
    for _ in range(attempts):
        result = run_command(["docker", "inspect", "--format", "{{.State.Running}}", container], check=False)
        if result.returncode == 0 and result.stdout.strip() == "true":
            return
        time.sleep(1)
    raise RuntimeError(f"container did not become running after rollback: {container}")


def verify_api_recovered(api_container: str, state: dict, *, run_command=run) -> None:
    payload = inspect_container(api_container, run_command=run_command)
    baseline = state.get("api", {})
    if baseline.get("image_id"):
        require(payload.get("Image") == baseline["image_id"], "API image was not restored after rollback")
    if baseline.get("image_ref"):
        require(
            payload.get("Config", {}).get("Image") == baseline["image_ref"],
            "API image reference was not restored after rollback",
        )
    environment = normalized_environment(payload.get("Config", {}).get("Env"))
    require(
        environment.get("FILE_AGENT_RUNTIME_ENABLED") == baseline.get("runtime_enabled"),
        "API Runtime feature flag was not restored after rollback",
    )
    for key in ("FILE_AGENT_CONNECTOR_ROOT", "FILE_AGENT_RUNTIME_BASE_URL"):
        baseline_key = "connector_root" if key == "FILE_AGENT_CONNECTOR_ROOT" else "runtime_base_url"
        if baseline_key in baseline:
            require(environment.get(key) == baseline.get(baseline_key), f"API {key} was not restored after rollback")
    expected_mount = baseline.get("connector_mount")
    actual_mount = next(
        (mount for mount in payload.get("Mounts", []) if mount.get("Destination") == "/opt/librechat/file-agent-runtime/connector"),
        None,
    )
    if expected_mount is None:
        require(actual_mount is None, "Connector mount was not removed after rollback")
    else:
        require(actual_mount is not None, "Connector mount was not restored after rollback")
        require(actual_mount.get("Source") == expected_mount.get("source"), "Connector source was not restored after rollback")
        require(actual_mount.get("Destination") == expected_mount.get("target"), "Connector target was not restored after rollback")
        expected_rw = not bool(expected_mount.get("read_only"))
        require(
            actual_mount.get("RW") is expected_rw,
            "Connector mount mode was not restored after rollback",
        )
    health = run_command(
        [
            "docker",
            "exec",
            api_container,
            "node",
            "-e",
            "fetch('http://127.0.0.1:3080/api/config').then((r)=>{if(!r.ok)process.exit(2)}).catch(()=>process.exit(3))",
        ],
        check=False,
    )
    require(health.returncode == 0, "API health failed after rollback")


def verify_runtime_recovered(state: dict, *, run_command=run) -> None:
    baseline = state.get("runtime", {})
    require(baseline.get("present") is True, "Runtime baseline is missing for an existing Runtime rollback")
    runtime_id = baseline.get("container_id")
    require(isinstance(runtime_id, str) and runtime_id, "Runtime baseline container ID is missing")
    payload = inspect_container("file-agent-runtime", run_command=run_command)
    if baseline.get("image_id"):
        require(payload.get("Image") == baseline["image_id"], "Runtime image was not restored after rollback")
    if baseline.get("image_ref"):
        require(
            payload.get("Config", {}).get("Image") == baseline["image_ref"],
            "Runtime image reference was not restored after rollback",
        )
    require(payload.get("State", {}).get("Running") is True, "Runtime is not running after rollback")
    expected_health = baseline.get("health")
    if expected_health:
        require(
            payload.get("State", {}).get("Health", {}).get("Status") == expected_health,
            "Runtime health was not restored after rollback",
        )


def restore_state(
    backup_dir: Path,
    *,
    root: Path = ROOT,
    run_command=run,
) -> None:
    compose_base = root / "compose.yaml"
    compose_override = root / "compose.override.yaml"
    before = backup_dir / "compose.override.yaml.before"
    state_path = backup_dir / "state.json"
    require(compose_base.is_file() and before.is_file(), "rollback Compose snapshot is missing")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    previous_runtime_present = bool(state.get("runtime_service_present"))
    candidate_runtime_id = state.get("candidate_runtime_container_id")

    run_command(
        [
            "docker",
            "compose",
            "--project-directory",
            str(root),
            "-f",
            str(compose_base),
            "-f",
            str(before),
            "config",
            "-q",
        ]
    )
    shutil.copy2(before, compose_override)
    expected_compose_hash = state.get("compose_override_sha256_before")
    if expected_compose_hash:
        require(sha256(compose_override) == expected_compose_hash, "Compose override hash was not restored")

    if not previous_runtime_present and isinstance(candidate_runtime_id, str) and candidate_runtime_id:
        run_command(["docker", "rm", "-f", candidate_runtime_id], check=False)

    services = ["api"]
    if previous_runtime_present:
        services.append("file-agent-runtime")
    run_command(
        [
            "docker",
            "compose",
            "--project-directory",
            str(root),
            "-f",
            str(compose_base),
            "-f",
            str(compose_override),
            "up",
            "-d",
            "--no-deps",
            "--force-recreate",
            *services,
        ]
    )
    wait_running(API_CONTAINER, run_command=run_command)
    verify_api_recovered(API_CONTAINER, state, run_command=run_command)

    if previous_runtime_present:
        verify_runtime_recovered(state, run_command=run_command)
    elif state.get("api", {}).get("runtime_enabled") != "true":
        native_fallback_probe(api_container=API_CONTAINER, run_command=run_command)

    for name, expected_id in state.get("protected_container_ids", {}).items():
        inspected = run_command(["docker", "inspect", name], check=False)
        require(inspected.returncode == 0, f"protected service is missing after rollback: {name}")
        payload = json.loads(inspected.stdout)[0]
        require(payload.get("Id") == expected_id, f"protected service identity changed after rollback: {name}")

    if not previous_runtime_present and isinstance(candidate_runtime_id, str) and candidate_runtime_id:
        candidate = run_command(["docker", "inspect", candidate_runtime_id], check=False)
        require(candidate.returncode != 0, "candidate Runtime still exists after rollback")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("backup_dir", type=Path)
    arguments = parser.parse_args()
    restore_state(arguments.backup_dir.resolve())
    print(f"dual_service_rollback=passed backup_dir={arguments.backup_dir}")


if __name__ == "__main__":
    main()
