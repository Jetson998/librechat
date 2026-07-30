#!/usr/bin/env python3
"""Restore the pre-release Compose override and CodeAPI runtime."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, text=True, capture_output=True)
    if check and completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed


def main() -> None:
    backup = Path(sys.argv[1]).resolve()
    root = Path("/opt/librechat")
    original = backup / "compose.override.yaml.before"
    rollback_override = backup / "codeapi-rollback.override.yaml"
    if not original.is_file() or not rollback_override.is_file():
        raise RuntimeError("rollback artifacts are missing")
    shutil.copy2(original, root / "compose.override.yaml")
    run([
        "docker", "compose", "--project-directory", str(root),
        "-f", str(root / "compose.yaml"), "-f", str(root / "compose.override.yaml"),
        "-f", str(rollback_override), "up", "-d", "--no-deps", "--force-recreate", "codeapi",
    ])
    for _ in range(30):
        payload = json.loads(run(["docker", "inspect", "LibreChat-CodeAPI"]).stdout)[0]
        if payload["State"].get("Running") and payload["HostConfig"].get("Init") in {None, False}:
            print(json.dumps({"status": "rolled_back", "container_id": payload["Id"]}))
            return
        time.sleep(2)
    raise RuntimeError("rollback CodeAPI did not become ready")


if __name__ == "__main__":
    main()
