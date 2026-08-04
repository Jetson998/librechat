#!/usr/bin/env python3
"""Restore the pre-File-Agent API Compose override and recreate only API."""

from __future__ import annotations

import argparse
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


def restore_compose_override(
    backup_dir: Path,
    *,
    root: Path = ROOT,
    run_command=run,
) -> None:
    before = backup_dir / "compose.override.yaml.before"
    compose_base = root / "compose.yaml"
    compose_override = root / "compose.override.yaml"
    if not before.is_file():
        raise RuntimeError("rollback Compose backup is missing")
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
            "api",
        ]
    )


def wait_for_api(*, run_command=run, attempts: int = 90) -> None:
    for _ in range(attempts):
        result = run_command(["docker", "inspect", "--format", "{{.State.Running}}", API_CONTAINER], check=False)
        if result.returncode == 0 and result.stdout.strip() == "true":
            return
        time.sleep(1)
    raise RuntimeError("API did not become running after rollback")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("backup_dir", type=Path)
    arguments = parser.parse_args()
    restore_compose_override(arguments.backup_dir.resolve())
    wait_for_api()
    print(f"rollback=passed backup_dir={arguments.backup_dir}")


if __name__ == "__main__":
    main()
