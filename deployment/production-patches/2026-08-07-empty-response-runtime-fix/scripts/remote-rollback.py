#!/usr/bin/env python3
"""Restore the timestamp-matched API Compose state for this release."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import subprocess
import time
from pathlib import Path


COMPOSE_ROOT = Path("/opt/librechat")
API_SERVICE = "api"
API_CONTAINER = "LibreChat-API"
PROTECTED_SERVICES = (
    "LibreChat-CodeAPI",
    "LibreChat-NGINX",
    "LibreChat-RAG-API",
    "chat-mongodb",
    "LibreChat-Admin-Panel",
)


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, text=True, capture_output=True)
    if check and completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def inspect_id(name: str) -> str:
    return run(["docker", "inspect", name, "--format", "{{.Id}}"]).stdout.strip()


def public_status(url: str) -> int:
    return int(run(["curl", "-ksS", "-o", "/dev/null", "-w", "%{http_code}", url]).stdout.strip())


def restore_compose_override(
    backup_dir: Path,
    *,
    root: Path = COMPOSE_ROOT,
    run_command=run,
) -> None:
    before = backup_dir / "compose.override.yaml.before"
    compose_override = root / "compose.override.yaml"
    compose_base = root / "compose.yaml"
    if not before.is_file():
        raise RuntimeError("rollback compose backup is missing")
    compose_override.write_bytes(before.read_bytes())
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
            "config",
            "-q",
        ]
    )
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
            API_SERVICE,
        ]
    )


def verify_rollback(backup_dir: Path, root: Path = COMPOSE_ROOT) -> dict:
    runtime = json.loads((backup_dir / "runtime-preflight.json").read_text(encoding="utf-8"))
    baseline = runtime["baseline"]
    for name in PROTECTED_SERVICES:
        expected = baseline["containers"][name]["id"]
        if inspect_id(name) != expected:
            raise RuntimeError(f"protected container changed during rollback: {name}")
    if digest(root / "compose.override.yaml") != baseline["compose_override_sha256"]:
        raise RuntimeError("rollback did not restore compose.override.yaml")
    for destination, expected in baseline["target_hashes"].items():
        actual = run(["docker", "exec", API_CONTAINER, "sha256sum", destination]).stdout.split()[0]
        if actual != expected:
            raise RuntimeError(f"rollback target hash mismatch: {destination}")
    if public_status("https://152.32.172.162.sslip.io/api/config") != 200:
        raise RuntimeError("API did not become ready after rollback")
    return {
        "status": "passed",
        "restored_compose_override_sha256": digest(root / "compose.override.yaml"),
        "api_container_after": inspect_id(API_CONTAINER),
        "protected_services_unchanged": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--compose-root", type=Path, default=COMPOSE_ROOT)
    parser.add_argument("--no-lock", action="store_true")
    arguments = parser.parse_args()
    root = arguments.compose_root.resolve()
    lock_handle = None
    try:
        if not arguments.no_lock:
            lock_handle = (Path("/var/lock") / "librechat-empty-response-runtime-fix.lock").open("w")
            fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        restore_compose_override(arguments.backup_dir, root=root)
        result = verify_rollback(arguments.backup_dir, root=root)
        result["backup_dir"] = str(arguments.backup_dir)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    finally:
        if lock_handle is not None:
            lock_handle.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"remote_rollback_failed: {error}") from error
