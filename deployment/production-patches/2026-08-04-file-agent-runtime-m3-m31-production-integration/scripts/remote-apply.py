#!/usr/bin/env python3
"""Apply the bounded API + Runtime Compose unit with automatic rollback."""

from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from runner_common import (
    API_SERVICE,
    native_fallback_probe,
    RUNTIME_SERVICE,
    compose_with_runtime,
    require,
    safe_extract_connector,
    sha256,
    validate_handoff,
    validate_runtime_compose,
)


ROOT = Path("/opt/librechat")
API_CONTAINER = "LibreChat-API"
PROTECTED_CONTAINERS = (
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


def inspect(name: str) -> dict:
    return json.loads(run(["docker", "inspect", name]).stdout)[0]


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
    values = result.stdout.strip().splitlines()
    return values[0] if values else None


def wait_running(container_id: str, attempts: int = 90) -> dict:
    for _ in range(attempts):
        payload = inspect(container_id)
        if payload.get("State", {}).get("Running") is True:
            return payload
        time.sleep(1)
    raise RuntimeError(f"container did not become running: {container_id}")


def wait_healthy(container_id: str, attempts: int = 90) -> dict:
    for _ in range(attempts):
        payload = inspect(container_id)
        state = payload.get("State", {})
        if state.get("Running") is True and state.get("Health", {}).get("Status") == "healthy":
            return payload
        if state.get("Status") == "exited":
            raise RuntimeError(f"Runtime container exited while waiting for health: {container_id}")
        time.sleep(1)
    raise RuntimeError(f"Runtime did not become healthy: {container_id}")


def load_rollback_module():
    path = SCRIPT_DIR / "remote-rollback.py"
    spec = importlib.util.spec_from_file_location("file_agent_remote_rollback", path)
    require(spec is not None and spec.loader is not None, "rollback module is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_result(stage: Path, value: dict) -> None:
    (stage / "DEPLOY_RESULT.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def load_stage(stage: Path) -> tuple[dict, dict, dict]:
    handoff = json.loads((stage / "handoff-manifest.json").read_text(encoding="utf-8"))
    deployment = validate_handoff(handoff, stage)
    preflight = json.loads((stage / "runtime-preflight.json").read_text(encoding="utf-8"))
    require(preflight.get("status") == "passed", "Runtime preflight did not pass")
    for key in ("source_revision", "artifact_sha256", "release_plan_sha256"):
        require(handoff.get(key) == preflight.get(key), f"handoff and preflight {key} mismatch")
    return handoff, deployment, preflight


def verify_baseline(root: Path, baseline: dict) -> None:
    require(sha256(root / "compose.yaml") == baseline["compose_base_sha256"], "Compose base drifted after preflight")
    require(sha256(root / "compose.override.yaml") == baseline["compose_override_sha256"], "Compose override drifted after preflight")
    for name, expected in baseline["containers"].items():
        require(inspect(name)["Id"] == expected["id"], f"container drifted after preflight: {name}")
    runtime_id = baseline.get("runtime_container_id")
    if runtime_id:
        require(inspect(runtime_id)["Id"] == runtime_id, "existing Runtime container drifted after preflight")


def api_has_enabled_flag(payload: dict) -> bool:
    values = payload.get("Config", {}).get("Env", [])
    return "FILE_AGENT_RUNTIME_ENABLED=true" in values


def verify_internal_health(api_id: str, runtime_id: str, *, run_command=run) -> None:
    runtime_health = run_command(
        [
            "docker",
            "exec",
            runtime_id,
            "node",
            "-e",
            "fetch('http://127.0.0.1:8790/healthz').then((r)=>{if(!r.ok)process.exit(2)}).catch(()=>process.exit(3))",
        ],
        check=False,
    )
    require(runtime_health.returncode == 0, "Runtime /healthz failed")
    api_health = run_command(
        [
            "docker",
            "exec",
            api_id,
            "node",
            "-e",
            "fetch('http://127.0.0.1:3080/api/config').then((r)=>{if(!r.ok)process.exit(2)}).catch(()=>process.exit(3))",
        ],
        check=False,
    )
    require(api_health.returncode == 0, "API internal health endpoint failed")


def apply(
    stage: Path,
    root: Path = ROOT,
    *,
    run_command=run,
    native_fallback_probe=native_fallback_probe,
) -> dict:
    handoff, deployment, preflight = load_stage(stage)
    baseline = preflight["baseline"]
    verify_baseline(root, baseline)

    lock_dir = root / ".release-locks"
    lock_dir.mkdir(mode=0o700, exist_ok=True)
    lock_path = lock_dir / "file-agent-runtime-m3-m31-production-integration.lock"
    with lock_path.open("w", encoding="utf-8") as lock_handle:
        try:
            fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("another File Agent dual-service deployment is active") from error

        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        revision = handoff["source_revision"]
        release_dir = root / "file-agent-runtime" / "m3-m31" / f"{revision[:12]}-{stamp}"
        backup_dir = root / "backups" / f"file-agent-runtime-m3-m31-{revision[:12]}-{stamp}"
        work_dir = Path(tempfile.mkdtemp(prefix="file-agent-m3-m31-"))
        changed = False
        candidate_runtime_id = None

        def rollback_state(candidate_id: str | None) -> dict:
            return {
                "runtime_service_present": bool(baseline.get("runtime_service_present")),
                "candidate_runtime_container_id": candidate_id,
                "compose_override_sha256_before": baseline["compose_override_sha256"],
                "api": baseline.get("api", {}),
                "runtime": baseline.get("runtime", {}),
                "protected_container_ids": {
                    name: expected["id"] for name, expected in baseline.get("containers", {}).items()
                },
            }

        try:
            archive = stage / handoff["connector_archive"]["filename"]
            release_dir.mkdir(parents=True, exist_ok=False)
            connector_dir = release_dir / "connector"
            connector_dir.mkdir(parents=True)
            safe_extract_connector(archive, connector_dir, handoff["connector_archive"]["files"])

            backup_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
            shutil.copy2(root / "compose.override.yaml", backup_dir / "compose.override.yaml.before")
            (backup_dir / "runtime-preflight.json").write_text(
                json.dumps(preflight, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            (backup_dir / "handoff-manifest.json").write_text(
                json.dumps(handoff, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            state_path = backup_dir / "state.json"
            state_path.write_text(
                json.dumps(rollback_state(None), indent=2) + "\n",
                encoding="utf-8",
            )

            resolved = json.loads(
                run_command(
                    [
                        "docker",
                        "compose",
                        "--project-directory",
                        str(root),
                        "-f",
                        str(root / "compose.yaml"),
                        "-f",
                        str(root / "compose.override.yaml"),
                        "config",
                        "--format",
                        "json",
                    ]
                ).stdout
            )
            candidate = work_dir / "compose.override.yaml.next"
            candidate.write_text(
                json.dumps(compose_with_runtime(resolved, release_dir, deployment), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            candidate_payload = json.loads(candidate.read_text(encoding="utf-8"))
            validate_runtime_compose(candidate_payload, release_dir, deployment)
            run_command(
                [
                    "docker",
                    "compose",
                    "--project-directory",
                    str(root),
                    "-f",
                    str(root / "compose.yaml"),
                    "-f",
                    str(candidate),
                    "config",
                    "-q",
                ]
            )
            os.replace(candidate, root / "compose.override.yaml")
            changed = True

            try:
                run_command(
                    [
                        "docker",
                        "compose",
                        "--project-directory",
                        str(root),
                        "-f",
                        str(root / "compose.yaml"),
                        "-f",
                        str(root / "compose.override.yaml"),
                        "up",
                        "-d",
                        "--no-deps",
                        "--force-recreate",
                        RUNTIME_SERVICE,
                    ]
                )
            finally:
                # Compose can create the container before a later start or
                # health step returns non-zero. Discover that side effect
                # before rollback gets the state snapshot.
                candidate_runtime_id = compose_container_id(root, RUNTIME_SERVICE)
                if candidate_runtime_id:
                    state_path.write_text(
                        json.dumps(rollback_state(candidate_runtime_id), indent=2) + "\n",
                        encoding="utf-8",
                    )
            require(candidate_runtime_id is not None, "Runtime container was not created")
            runtime_payload = wait_healthy(candidate_runtime_id)

            run_command(
                [
                    "docker",
                    "compose",
                    "--project-directory",
                    str(root),
                    "-f",
                    str(root / "compose.yaml"),
                    "-f",
                    str(root / "compose.override.yaml"),
                    "up",
                    "-d",
                    "--no-deps",
                    "--force-recreate",
                    API_SERVICE,
                ]
            )
            api_payload = wait_running(API_CONTAINER)
            api_baseline = baseline.get("api", {})
            if api_baseline.get("image_id"):
                require(api_payload.get("Image") == api_baseline["image_id"], "API image changed during apply")
            if api_baseline.get("image_ref"):
                require(
                    api_payload.get("Config", {}).get("Image") == api_baseline["image_ref"],
                    "API image reference changed during apply",
                )
            require(api_has_enabled_flag(api_payload), "API Runtime flag is not true after apply")
            require(not runtime_payload.get("HostConfig", {}).get("PortBindings"), "Runtime published a host port")
            verify_internal_health(API_CONTAINER, candidate_runtime_id, run_command=run_command)
            native_fallback_probe(api_container=API_CONTAINER, run_command=run_command)

            for name, expected in baseline["containers"].items():
                require(inspect(name)["Id"] == expected["id"], f"protected service changed: {name}")

            result = {
                "schema_version": 1,
                "status": "passed",
                "deployed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "source_revision": revision,
                "artifact_sha256": handoff["artifact_sha256"],
                "release_plan_sha256": handoff["release_plan_sha256"],
                "backup_dir": str(backup_dir),
                "release_dir": str(release_dir),
                "recreated_services": ["file-agent-runtime", "LibreChat-API"],
                "protected_services_unchanged": True,
                "runtime_container_id": candidate_runtime_id,
                "runtime_image": deployment["runtime_image"],
                "runtime_health": "healthy",
                "api_health": "passed",
                "file_agent_runtime_enabled": True,
                "host_ports_published": [],
                "billable_model_requests": 0,
                "business_acceptance": "technical dual-service apply only; no customer file or model request was created",
            }
            write_result(stage, result)
            return result
        except Exception as error:
            rollback_error = None
            if changed and backup_dir.exists():
                try:
                    load_rollback_module().restore_state(backup_dir, root=root, run_command=run_command)
                except Exception as candidate_error:
                    rollback_error = str(candidate_error)
            result = {
                "schema_version": 1,
                "status": "rolled_back" if changed and rollback_error is None else "failed",
                "source_revision": handoff["source_revision"],
                "backup_dir": str(backup_dir) if backup_dir.exists() else None,
                "error": str(error),
                "rollback_error": rollback_error,
                "candidate_runtime_container_id": candidate_runtime_id,
            }
            write_result(stage, result)
            raise
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=ROOT)
    arguments = parser.parse_args()
    result = apply(arguments.stage.resolve(), arguments.root.resolve())
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
