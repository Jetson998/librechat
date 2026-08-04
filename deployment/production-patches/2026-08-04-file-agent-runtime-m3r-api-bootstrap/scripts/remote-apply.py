#!/usr/bin/env python3
"""Apply the default-disabled File Agent API overlay with automatic rollback."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from remote_rollback import restore_compose_override, wait_for_api


ROOT = Path("/opt/librechat")
API_SERVICE = "api"
API_CONTAINER = "LibreChat-API"
PROTECTED = (
    "LibreChat-NGINX",
    "LibreChat-CodeAPI",
    "LibreChat-RAG-API",
    "LibreChat-Admin-Panel",
    "chat-mongodb",
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


def file_sha256(path: str) -> str:
    output = run(["docker", "exec", API_CONTAINER, "sha256sum", path]).stdout.strip().split()
    require(bool(output), f"no SHA-256 returned for {path}")
    return output[0]


def file_exists(path: str) -> bool:
    return run(["docker", "exec", API_CONTAINER, "test", "-e", path], check=False).returncode == 0


def public_status(url: str) -> int:
    completed = run(["curl", "-ksS", "-o", "/dev/null", "-w", "%{http_code}", url], check=False)
    try:
        return int(completed.stdout.strip())
    except ValueError:
        return 0


def wait_for_http(url: str, expected: int, attempts: int = 60) -> None:
    for _ in range(attempts):
        if public_status(url) == expected:
            return
        time.sleep(1)
    raise RuntimeError(f"HTTP check did not become ready: {url}")


def compose_target(entry: object) -> str:
    if isinstance(entry, dict):
        return str(entry.get("target", ""))
    if isinstance(entry, str):
        parts = entry.split(":")
        return parts[1] if len(parts) >= 2 else ""
    return ""


def normalized_environment(value: object) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return {str(key): "" if item is None else str(item) for key, item in value.items()}
    if isinstance(value, list):
        result: dict[str, str] = {}
        for item in value:
            require(isinstance(item, str) and "=" in item, "unsupported Compose environment entry")
            key, item_value = item.split("=", 1)
            require(key != "", "empty Compose environment name")
            result[key] = item_value
        return result
    raise RuntimeError("unsupported Compose environment representation")


def compose_with_overlay(payload: dict, release_dir: Path, targets: list[dict]) -> dict:
    services = payload.get("services")
    require(isinstance(services, dict) and isinstance(services.get(API_SERVICE), dict), "API Compose service is missing")
    api = services[API_SERVICE]
    destinations = {target["destination"] for target in targets}
    volumes = api.get("volumes", [])
    require(isinstance(volumes, list), "API volumes are not a list")
    api["volumes"] = [entry for entry in volumes if compose_target(entry) not in destinations]
    for target in targets:
        source = release_dir / target["relative_path"]
        api["volumes"].append(f"{source}:{target['destination']}:ro")
    environment = normalized_environment(api.get("environment"))
    environment["FILE_AGENT_RUNTIME_ENABLED"] = "false"
    api["environment"] = environment
    return payload


def safe_extract_overlay(archive_path: Path, destination: Path, targets: list[dict]) -> None:
    expected = {target["relative_path"]: target for target in targets}
    destination = destination.resolve()
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        names = {member.name for member in members}
        require(names == set(expected), "overlay archive file set mismatch")
        for member in members:
            require(member.isfile() and not member.issym() and not member.islnk(), f"unsafe overlay archive member: {member.name}")
            target_path = (destination / member.name).resolve()
            try:
                target_path.relative_to(destination)
            except ValueError as error:
                raise RuntimeError(f"unsafe overlay archive path: {member.name}") from error
            source = archive.extractfile(member)
            require(source is not None, f"cannot read overlay archive member: {member.name}")
            payload = source.read()
            expected_target = expected[member.name]
            require(len(payload) == expected_target["bytes"], f"overlay byte count mismatch: {member.name}")
            require(hashlib.sha256(payload).hexdigest() == expected_target["sha256"], f"overlay digest mismatch: {member.name}")
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_bytes(payload)
            target_path.chmod(0o444)


def load_stage(stage: Path) -> tuple[dict, dict]:
    handoff = json.loads((stage / "handoff-manifest.json").read_text(encoding="utf-8"))
    preflight = json.loads((stage / "runtime-preflight.json").read_text(encoding="utf-8"))
    require(handoff.get("status") == "packaged_for_deployment", "handoff is not deployable")
    require(preflight.get("status") == "passed", "runtime preflight did not pass")
    for key in ("source_revision", "artifact_sha256", "release_plan_sha256"):
        require(handoff.get(key) == preflight.get(key), f"handoff and preflight {key} mismatch")
    targets = handoff.get("targets")
    require(isinstance(targets, list) and len(targets) == 4, "handoff must contain four targets")
    archive = stage / handoff["overlay_archive"]["filename"]
    require(archive.is_file(), "overlay archive is missing")
    require(digest(archive) == handoff["overlay_archive"]["sha256"], "overlay archive digest mismatch")
    return handoff, preflight


def verify_target_baseline(targets: list[dict], expected_hashes: dict[str, str | None]) -> None:
    for target in targets:
        destination = target["destination"]
        expected = expected_hashes.get(destination)
        if expected is None:
            require(not file_exists(destination), f"new target appeared after preflight: {destination}")
        else:
            require(file_sha256(destination) == expected, f"target drifted after preflight: {destination}")


def write_result(stage: Path, value: dict) -> None:
    (stage / "DEPLOY_RESULT.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def apply(stage: Path) -> dict:
    handoff, preflight = load_stage(stage)
    baseline = preflight["baseline"]
    source_revision = handoff["source_revision"]
    targets = handoff["targets"]
    compose_base = ROOT / "compose.yaml"
    compose_override = ROOT / "compose.override.yaml"
    require(digest(compose_base) == baseline["compose_base_sha256"], "Compose base drifted after preflight")
    require(digest(compose_override) == baseline["compose_override_sha256"], "Compose override drifted after preflight")
    for name, expected in baseline["containers"].items():
        require(inspect(name)["Id"] == expected["id"], f"container drifted after preflight: {name}")
    verify_target_baseline(targets, baseline["target_hashes"])

    lock_dir = ROOT / ".release-locks"
    lock_dir.mkdir(mode=0o700, exist_ok=True)
    lock_path = lock_dir / "file-agent-runtime-m3r-api-bootstrap.lock"
    with lock_path.open("w") as lock_handle:
        try:
            fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("another LibreChat File Agent API deployment is active") from error

        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        release_dir = ROOT / "file-agent-runtime" / "api-bootstrap" / f"{source_revision[:12]}-{stamp}"
        backup_dir = ROOT / "backups" / f"file-agent-runtime-m3r-api-bootstrap-{source_revision[:12]}-{stamp}"
        work_dir = Path(tempfile.mkdtemp(prefix="file-agent-api-overlay-"))
        changed = False
        try:
            archive = stage / handoff["overlay_archive"]["filename"]
            extracted = work_dir / "overlay"
            extracted.mkdir(parents=True)
            safe_extract_overlay(archive, extracted, targets)

            release_dir.mkdir(parents=True, exist_ok=False)
            for target in targets:
                source = extracted / target["relative_path"]
                destination = release_dir / target["relative_path"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                destination.chmod(0o444)

            backup_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
            shutil.copy2(compose_override, backup_dir / "compose.override.yaml.before")
            (backup_dir / "runtime-preflight.json").write_text(
                json.dumps(preflight, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            (backup_dir / "handoff-manifest.json").write_text(
                json.dumps(handoff, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            (backup_dir / "active-containers.json").write_text(
                json.dumps(
                    {name: inspect(name)["Id"] for name in baseline["containers"]},
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )

            resolved = json.loads(
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
            candidate = work_dir / "compose.override.yaml.next"
            candidate.write_text(
                json.dumps(compose_with_overlay(resolved, release_dir, targets), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            run(
                [
                    "docker",
                    "compose",
                    "--project-directory",
                    str(ROOT),
                    "-f",
                    str(compose_base),
                    "-f",
                    str(candidate),
                    "config",
                    "-q",
                ]
            )
            os.replace(candidate, compose_override)
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
            wait_for_api(attempts=60)
            wait_for_http("http://127.0.0.1:3081/api/config", 200)
            for target in targets:
                require(file_sha256(target["destination"]) == target["sha256"], f"runtime target hash mismatch: {target['destination']}")
                run(["docker", "exec", API_CONTAINER, "node", "--check", target["destination"]])
            disabled = run(
                [
                    "docker",
                    "exec",
                    API_CONTAINER,
                    "node",
                    "-e",
                    "if(process.env.FILE_AGENT_RUNTIME_ENABLED!=='false'){process.exit(2)}; console.log('file-agent-runtime-disabled')",
                ],
                check=False,
            )
            require(disabled.returncode == 0, "File Agent Runtime is not explicitly disabled")
            for name in PROTECTED:
                require(inspect(name)["Id"] == baseline["containers"][name]["id"], f"protected service changed: {name}")
            api_after = inspect(API_CONTAINER)
            require(api_after["State"].get("Running") is True, "API is not running")
            require(api_after["Id"] != baseline["containers"][API_CONTAINER]["id"], "API was not recreated")
            require(public_status("http://127.0.0.1:3081/") == 200, "main site failed after API restart")
            require(public_status("https://152.32.172.162.sslip.io/office/") == 401, "Office auth boundary changed")

            result = {
                "schema_version": 1,
                "status": "passed",
                "deployed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "source_revision": source_revision,
                "artifact_sha256": handoff["artifact_sha256"],
                "release_plan_sha256": handoff["release_plan_sha256"],
                "backup_dir": str(backup_dir),
                "release_dir": str(release_dir),
                "compose_override_sha256_before": baseline["compose_override_sha256"],
                "compose_override_sha256_after": digest(compose_override),
                "api_container_before": baseline["containers"][API_CONTAINER]["id"],
                "api_container_after": api_after["Id"],
                "recreated_services": ["LibreChat-API"],
                "protected_services": {name: baseline["containers"][name]["id"] for name in PROTECTED},
                "protected_services_unchanged": True,
                "file_agent_runtime_enabled": False,
                "mounted_targets": {target["destination"]: target["sha256"] for target in targets},
                "public_checks": {
                    "main_root": 200,
                    "api_config": 200,
                    "office_auth_boundary": 401,
                },
                "billable_model_requests": 0,
                "business_acceptance": "default-disabled API bootstrap only; no user conversation, file task, Runtime request, or model request was created",
            }
            write_result(stage, result)
            return result
        except Exception as error:
            rollback_error = None
            if changed:
                try:
                    restore_compose_override(backup_dir)
                    wait_for_api(attempts=60)
                except Exception as candidate:
                    rollback_error = str(candidate)
            result = {
                "schema_version": 1,
                "status": "rolled_back" if changed and rollback_error is None else "failed",
                "source_revision": source_revision,
                "backup_dir": str(backup_dir) if backup_dir.exists() else None,
                "error": str(error),
                "rollback_error": rollback_error,
            }
            write_result(stage, result)
            raise
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=Path, required=True)
    arguments = parser.parse_args()
    result = apply(arguments.stage.resolve())
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
