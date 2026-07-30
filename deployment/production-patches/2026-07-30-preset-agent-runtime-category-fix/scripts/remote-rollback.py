#!/usr/bin/env python3
"""Restore the pre-release Mongo Agent documents and Client mount."""

from __future__ import annotations

import hashlib
import json
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path("/opt/librechat")
COMPOSE_BASE = ROOT / "compose.yaml"
COMPOSE_OVERRIDE = ROOT / "compose.override.yaml"
ENV_FILE = ROOT / ".env"


def run(command: list[str], *, input_text: str | None = None) -> str:
    completed = subprocess.run(
        command, input=input_text, text=True, capture_output=True, check=False
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n"
            f"stdout: {completed.stdout[-4000:]}\nstderr: {completed.stderr[-4000:]}"
        )
    return completed.stdout


def parse_json_output(output: str) -> dict:
    for line in reversed([line.strip() for line in output.splitlines() if line.strip()]):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError(f"no JSON object in command output: {output[-4000:]}")


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_mongosh(mapping: list[list[str]], script: Path, backup: dict | None = None) -> dict:
    prefix = f"const MAPPING = {json.dumps(mapping, ensure_ascii=False)};\n"
    if backup is not None:
        backup_text = json.dumps(backup, ensure_ascii=False, separators=(",", ":"))
        prefix += f"const BACKUP = EJSON.parse({json.dumps(backup_text, ensure_ascii=False)});\n"
    output = run(
        [
            "docker",
            "exec",
            "-i",
            "chat-mongodb",
            "mongosh",
            "--quiet",
            "LibreChat",
            "--file",
            "/dev/stdin",
        ],
        input_text=prefix + script.read_text(encoding="utf-8"),
    )
    return parse_json_output(output)


def wait_ready() -> None:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    for _ in range(120):
        try:
            with urllib.request.urlopen(
                "https://152.32.172.162.sslip.io/api/config",
                timeout=5,
                context=context,
            ) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("LibreChat API did not become ready during rollback")


def assert_protected_services(baseline: dict) -> None:
    for name, expected in baseline["containers"].items():
        if name == "LibreChat-API":
            continue
        payload = json.loads(run(["docker", "inspect", name]))[0]
        if (
            payload["Id"] != expected["id"]
            or payload["State"]["StartedAt"] != expected["started_at"]
        ):
            raise RuntimeError(f"protected container changed during rollback: {name}")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: remote-rollback.py <backup-dir> <runtime-preflight.json>")
    backup_dir = Path(sys.argv[1]).resolve()
    baseline_path = Path(sys.argv[2]).resolve()
    metadata_path = backup_dir / "artifact.json"
    before_path = backup_dir / "before-target-snapshot.json"
    snapshot_script = backup_dir / "snapshot.js"
    rollback_script = backup_dir / "rollback.js"
    for path in (
        backup_dir / "compose.override.yaml",
        backup_dir / "client-dist" / "index.html",
        baseline_path,
        metadata_path,
        before_path,
        snapshot_script,
        rollback_script,
        COMPOSE_BASE,
        COMPOSE_OVERRIDE,
        ENV_FILE,
    ):
        if not path.exists():
            raise RuntimeError(f"rollback input is missing: {path}")

    baseline_payload = json.loads(baseline_path.read_text(encoding="utf-8"))
    baseline = baseline_payload["baseline"]
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    backup = json.loads(before_path.read_text(encoding="utf-8"))
    mapping = metadata["migration"]["id_mapping"]

    mongo_result = run_mongosh(mapping, rollback_script, backup=backup)
    if mongo_result.get("status") != "passed":
        raise RuntimeError("Mongo rollback did not report success")
    restored = run_mongosh(mapping, snapshot_script)
    if canonical_json(restored) != canonical_json(backup):
        raise RuntimeError("Mongo rollback did not restore the exact target snapshot")

    old_mount = Path(baseline["client_mount"])
    if not old_mount.is_dir():
        old_mount.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(backup_dir / "client-dist", old_mount)
    if sha256_file(old_mount / "index.html") != baseline["public_index_sha256"]:
        raise RuntimeError("rollback Client index does not match the baseline")

    shutil.copy2(backup_dir / "compose.override.yaml", COMPOSE_OVERRIDE)
    run(
        [
            "docker",
            "compose",
            "--env-file",
            str(ENV_FILE),
            "-f",
            str(COMPOSE_BASE),
            "-f",
            str(COMPOSE_OVERRIDE),
            "config",
        ]
    )
    run(
        [
            "docker",
            "compose",
            "--env-file",
            str(ENV_FILE),
            "-f",
            str(COMPOSE_BASE),
            "-f",
            str(COMPOSE_OVERRIDE),
            "up",
            "-d",
            "--no-deps",
            "--force-recreate",
            "api",
        ]
    )
    wait_ready()
    active_mount = run(
        [
            "docker",
            "inspect",
            "LibreChat-API",
            "--format",
            '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}',
        ]
    ).strip()
    if active_mount != str(old_mount):
        raise RuntimeError("rollback did not restore the previous Client mount")
    assert_protected_services(baseline)

    result = {
        "schema_version": 1,
        "status": "passed",
        "rolled_back_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "backup_dir": str(backup_dir),
        "client_mount": active_mount,
        "client_index_sha256": baseline["public_index_sha256"],
        "mongo_result": mongo_result,
        "restored_agent_ids": sorted(agent["id"] for agent in restored["agents"]),
        "protected_services_unchanged": True,
    }
    result_path = backup_dir / "ROLLBACK_RESULT.json"
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
