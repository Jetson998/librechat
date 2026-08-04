#!/usr/bin/env python3
"""Restore the pre-apply API + Runtime Compose state."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
from pathlib import Path


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


def inspect_container(container_id: str) -> dict:
    return json.loads(run(["docker", "inspect", container_id]).stdout)[0]


def wait_running(container: str, *, run_command=run, attempts: int = 90) -> None:
    for _ in range(attempts):
        result = run_command(["docker", "inspect", "--format", "{{.State.Running}}", container], check=False)
        if result.returncode == 0 and result.stdout.strip() == "true":
            return
        time.sleep(1)
    raise RuntimeError(f"container did not become running after rollback: {container}")


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("backup_dir", type=Path)
    arguments = parser.parse_args()
    restore_state(arguments.backup_dir.resolve())
    print(f"dual_service_rollback=passed backup_dir={arguments.backup_dir}")


if __name__ == "__main__":
    main()
