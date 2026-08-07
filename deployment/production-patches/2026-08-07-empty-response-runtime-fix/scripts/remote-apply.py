#!/usr/bin/env python3
"""Apply and verify the four-file LibreChat-API overlay."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path("/opt/librechat")
API_SERVICE = "api"
API_CONTAINER = "LibreChat-API"
TARGETS = {
    "BaseClient.js": "/app/api/app/clients/BaseClient.js",
    "request.js": "/app/api/server/controllers/agents/request.js",
    "InitializationFailure.js": "/app/api/server/controllers/agents/InitializationFailure.js",
    "DiagnosticEvents.js": "/app/api/server/services/DiagnosticEvents.js",
}
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
    return json.loads(run(["docker", "inspect", name]).stdout)[0]


def inspect_id(name: str) -> str:
    return inspect(name)["Id"]


def target(entry: object) -> str:
    if isinstance(entry, str):
        parts = entry.split(":")
        return parts[1] if len(parts) > 1 else ""
    if isinstance(entry, dict):
        return str(entry.get("target", ""))
    return ""


def compose_with_overlay(payload: dict, release_dir: Path) -> dict:
    services = payload.setdefault("services", {})
    require("api" in services, "Compose payload does not contain api service")
    api = services["api"]
    volumes = api.setdefault("volumes", [])
    destinations = set(TARGETS.values())
    api["volumes"] = [entry for entry in volumes if target(entry) not in destinations]
    api["volumes"].extend(
        f"{release_dir / filename}:{destination}:ro"
        for filename, destination in TARGETS.items()
    )
    return payload


def write_candidate_compose(compose_base: Path, compose_override: Path, release_dir: Path) -> Path:
    payload = json.loads(
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
                "--format",
                "json",
            ]
        ).stdout
    )
    candidate = compose_override.with_name(f"compose.override.yaml.next-{os.getpid()}")
    candidate.write_text(
        json.dumps(compose_with_overlay(payload, release_dir), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return candidate


def public_status(url: str) -> int:
    return int(run(["curl", "-ksS", "-o", "/dev/null", "-w", "%{http_code}", url]).stdout.strip())


def wait_for_api() -> None:
    for _ in range(90):
        if public_status("https://152.32.172.162.sslip.io/api/config") == 200:
            return
        time.sleep(1)
    raise RuntimeError("API did not become ready")


def verify_hashes(release_dir: Path, manifest: dict) -> dict:
    result = {}
    for filename, destination in TARGETS.items():
        source = release_dir / filename
        expected = next(item["candidate_sha256"] for item in manifest["targets"] if item["destination"] == destination)
        require(digest(source) == expected, f"candidate source hash mismatch: {filename}")
        run(["docker", "exec", API_CONTAINER, "node", "--check", destination])
        actual = run(["docker", "exec", API_CONTAINER, "sha256sum", destination]).stdout.split()[0]
        require(actual == expected, f"runtime file hash mismatch: {destination}")
        result[destination] = actual
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--runtime-evidence", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    arguments = parser.parse_args()

    stage = arguments.stage.resolve()
    runtime = json.loads(arguments.runtime_evidence.read_text(encoding="utf-8"))
    manifest = json.loads((stage / "SOURCE_MANIFEST.json").read_text(encoding="utf-8"))
    require(runtime.get("status") == "passed", "runtime preflight is not passed")
    require(runtime.get("source_revision") == arguments.source_revision, "runtime revision mismatch")
    require(runtime.get("artifact_sha256") == arguments.artifact_sha256, "runtime artifact mismatch")
    require(runtime.get("release_plan_sha256"), "runtime release plan digest is missing")
    require(manifest.get("batch_id") == "2026-08-07-empty-response-runtime-fix", "manifest batch mismatch")
    require(set(TARGETS.values()) == {item["destination"] for item in manifest["targets"]}, "manifest targets drifted")

    compose_base = ROOT / "compose.yaml"
    compose_override = ROOT / "compose.override.yaml"
    baseline = runtime["baseline"]
    lock_handle = (Path("/var/lock") / "librechat-empty-response-runtime-fix.lock").open("w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception:
        lock_handle.close()
        raise
    require(digest(compose_override) == baseline["compose_override_sha256"], "Compose override drifted after preflight")
    for name, expected in baseline["containers"].items():
        require(inspect_id(name) == expected["id"], f"container drifted before apply: {name}")
    for destination, expected in baseline["target_hashes"].items():
        actual = run(["docker", "exec", API_CONTAINER, "sha256sum", destination]).stdout.split()[0]
        require(actual == expected, f"target drifted before apply: {destination}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    release_dir = ROOT / "empty-response-runtime-fix" / f"{arguments.source_revision[:12]}-{timestamp}"
    backup_dir = ROOT / "backups" / f"empty-response-runtime-fix-{arguments.source_revision[:12]}-{timestamp}"
    release_dir.mkdir(parents=True, exist_ok=False)
    backup_dir.mkdir(parents=True, exist_ok=False)
    backup_dir.chmod(0o700)
    shutil.copy2(compose_override, backup_dir / "compose.override.yaml.before")
    shutil.copy2(arguments.runtime_evidence, backup_dir / "runtime-preflight.json")
    shutil.copy2(stage / "SOURCE_MANIFEST.json", backup_dir / "SOURCE_MANIFEST.json")
    if (stage / "remote-rollback.py").is_file():
        shutil.copy2(stage / "remote-rollback.py", backup_dir / "remote-rollback.py")
    (backup_dir / "active-containers.json").write_text(
        json.dumps({name: inspect_id(name) for name in baseline["containers"]}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    for filename in TARGETS:
        source = stage / filename
        require(source.is_file(), f"candidate file is missing: {filename}")
        expected = next(item["candidate_sha256"] for item in manifest["targets"] if item["destination"] == TARGETS[filename])
        require(digest(source) == expected, f"staged candidate hash mismatch: {filename}")
        shutil.copy2(source, release_dir / filename)
        (release_dir / filename).chmod(0o444)

    changed = False
    try:
        candidate_override = write_candidate_compose(compose_base, compose_override, release_dir)
        try:
            run(
                [
                    "docker",
                    "compose",
                    "--project-directory",
                    str(ROOT),
                    "-f",
                    str(compose_base),
                    "-f",
                    str(candidate_override),
                    "config",
                    "-q",
                ]
            )
            candidate_override.replace(compose_override)
            changed = True
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
                    "up",
                    "-d",
                    "--no-deps",
                    "--force-recreate",
                    API_SERVICE,
                ]
            )
            wait_for_api()
            mounted_hashes = verify_hashes(release_dir, manifest)
            require(inspect_id(API_CONTAINER) != baseline["containers"][API_CONTAINER]["id"], "API was not recreated")
            for name in PROTECTED_SERVICES:
                require(inspect_id(name) == baseline["containers"][name]["id"], f"protected service changed: {name}")
            main_status = public_status("https://152.32.172.162.sslip.io/")
            api_status = public_status("https://152.32.172.162.sslip.io/api/config")
            office_status = public_status("https://152.32.172.162.sslip.io/office/")
            require(main_status == 200, "main site failed")
            require(api_status == 200, "API config failed")
            require(office_status == 401, "Office auth boundary changed")
            result = {
                "schema_version": 1,
                "status": "passed",
                "deployed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "source_revision": arguments.source_revision,
                "artifact_sha256": arguments.artifact_sha256,
                "release_plan_sha256": runtime["release_plan_sha256"],
                "release_dir": str(release_dir),
                "backup_dir": str(backup_dir),
                "compose_override_sha256_before": baseline["compose_override_sha256"],
                "compose_override_sha256_after": digest(compose_override),
                "api_container_before": baseline["containers"][API_CONTAINER]["id"],
                "api_container_after": inspect_id(API_CONTAINER),
                "mounted_target_hashes": mounted_hashes,
                "recreated_services": ["LibreChat-API"],
                "protected_services": {name: baseline["containers"][name]["id"] for name in PROTECTED_SERVICES},
                "protected_services_unchanged": True,
                "public_checks": {"main_root": main_status, "api_config": api_status, "office_auth_boundary": office_status},
                "billable_model_requests": 0,
            }
            arguments.result.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            shutil.copy2(arguments.result, backup_dir / "DEPLOY_RESULT.json")
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        finally:
            candidate_override.unlink(missing_ok=True)
    except Exception:
        if changed:
            rollback = stage / "remote-rollback.py"
            if rollback.is_file():
                subprocess.run([sys.executable, str(rollback), "--backup-dir", str(backup_dir), "--no-lock"], check=False)
        raise
    finally:
        lock_handle.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"remote_apply_failed: {error}") from error
