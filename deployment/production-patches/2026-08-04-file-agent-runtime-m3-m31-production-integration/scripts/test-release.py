#!/usr/bin/env python3
"""Isolated contract tests for the dual-service Compose runner."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import py_compile
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
PATCH = ROOT / "deployment/production-patches/2026-08-04-file-agent-runtime-m3-m31-production-integration"
SCRIPTS = PATCH / "scripts"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_module(name: str, path: Path):
    if str(path.parent) not in sys.path:
        sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def digest_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def make_archive(path: Path) -> dict:
    files = {
        "src/production-host-integration.js": b"export const production = true;\n",
        "src/word-acceptance-resolver.js": b"export const resolver = true;\n",
    }
    manifest_files = []
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for name, payload in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o444
            info.uid = 0
            info.gid = 0
            info.mtime = 0
            archive.addfile(info, io.BytesIO(payload))
            manifest_files.append({"path": name, "bytes": len(payload), "sha256": digest_bytes(payload)})
    return {"filename": path.name, "sha256": digest_bytes(path.read_bytes()), "files": manifest_files}


def make_handoff(root: Path, archive: dict) -> dict:
    secrets = {}
    for key, value in {
        "service_scope": "scope-secret-012345678901234567890123456789",
        "allowlist": "user-1\n",
        "model_api_key": "model-secret-value\n",
    }.items():
        target = root / f"{key}.secret"
        target.write_text(value, encoding="utf-8")
        secrets[key] = str(target)
    return {
        "schema_version": 1,
        "status": "packaged_for_deployment",
        "source_revision": "a" * 40,
        "artifact_sha256": "b" * 64,
        "release_plan_sha256": "c" * 64,
        "deployment": {
            "enable_runtime": True,
            "runtime_image": "registry.example.test/file-agent-runtime@sha256:" + "d" * 64,
            "model_base_url": "https://relay.example.test/v1",
            "model": "file-agent-model",
            "secret_host_files": secrets,
        },
        "connector_archive": archive,
    }


def exercise_apply_failure(
    runner,
    workspace: Path,
    failure: str,
    *,
    runtime_present: bool = False,
    rollback_fails: bool = False,
) -> dict:
    workspace.mkdir(parents=True, exist_ok=True)
    stage = workspace / "stage"
    stage.mkdir()
    root = workspace / "librechat"
    root.mkdir()
    (root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    (root / "compose.override.yaml").write_text("services: {}\n", encoding="utf-8")
    archive = stage / "connector.tar.gz"
    archive.write_bytes(b"fixture")
    handoff = {
        "source_revision": "a" * 40,
        "connector_archive": {"filename": archive.name, "files": []},
    }
    protected = {"protected": {"id": "protected-before"}} if failure == "protected-identity" else {}
    preflight = {
        "baseline": {
            "containers": protected,
            "runtime_container_id": "runtime-before" if runtime_present else None,
            "runtime_service_present": runtime_present,
            "compose_base_sha256": "base",
            "compose_override_sha256": "override",
        },
    }
    runner.load_stage = lambda _stage: (handoff, {}, preflight)
    runner.verify_baseline = lambda _root, _baseline: None
    runner.safe_extract_connector = lambda *_args: None
    runner.compose_with_runtime = lambda *_args: {"services": {"api": {}, "codeapi": {}}}
    runner.validate_runtime_compose = lambda *_args: None
    runner.compose_container_id = lambda *_args, **_kwargs: "runtime-created"
    runner.wait_healthy = lambda *_args, **_kwargs: (
        (_ for _ in ()).throw(RuntimeError("Runtime health failed"))
        if failure == "runtime-health"
        else {"State": {"Running": True, "Health": {"Status": "healthy"}}, "HostConfig": {"PortBindings": None}}
    )
    runner.wait_running = lambda *_args, **_kwargs: {"State": {"Running": True}, "Config": {"Env": ["FILE_AGENT_RUNTIME_ENABLED=true"]}}
    runner.verify_internal_health = lambda *_args, **_kwargs: (
        (_ for _ in ()).throw(RuntimeError("API health failed"))
        if failure == "api-health"
        else None
    )
    runner.inspect = lambda name: {
        "Id": "protected-changed" if failure == "protected-identity" and name == "protected" else name,
    }
    rollback_states: list[dict] = []
    rollback_commands: list[list[str]] = []

    def fake_rollback_module():
        class Rollback:
            @staticmethod
            def restore_state(backup_dir: Path, *, root: Path, run_command):
                state = json.loads((backup_dir / "state.json").read_text(encoding="utf-8"))
                rollback_states.append(state)
                candidate_id = state.get("candidate_runtime_container_id")
                if candidate_id:
                    run_command(["docker", "rm", "-f", candidate_id], check=False)
                    rollback_commands.append(["docker", "rm", "-f", candidate_id])
                if rollback_fails:
                    raise RuntimeError("rollback API restart failed")

        return Rollback

    runner.load_rollback_module = fake_rollback_module

    def fake_native_fallback_probe(*, api_container: str, **_kwargs):
        if failure in {"native-fallback", "first-enable-rollback", "existing-runtime-rollback"}:
            raise RuntimeError("native fallback failed")

    runtime_side_effect = False

    def fake_run(command: list[str], check: bool = True):
        nonlocal runtime_side_effect
        if "config" in command and "--format" in command:
            return subprocess.CompletedProcess(command, 0, json.dumps({"services": {"api": {}, "codeapi": {}}}), "")
        if "ps" in command and runner.RUNTIME_SERVICE in command and runtime_side_effect:
            return subprocess.CompletedProcess(command, 0, "runtime-created\n", "")
        if "up" in command and runner.RUNTIME_SERVICE in command:
            if failure == "runtime-create":
                runtime_side_effect = True
                raise RuntimeError("Runtime creation failed")
        if "up" in command and runner.API_SERVICE in command:
            if failure == "api-create":
                raise RuntimeError("API creation failed")
        return subprocess.CompletedProcess(command, 0, "", "")

    try:
        runner.apply(
            stage,
            root=root,
            run_command=fake_run,
            native_fallback_probe=fake_native_fallback_probe,
        )
    except Exception:
        pass
    result_path = stage / "DEPLOY_RESULT.json"
    require(result_path.is_file(), f"failure case did not write a result: {failure}")
    result = json.loads(result_path.read_text(encoding="utf-8"))
    require(rollback_states, f"failure case did not invoke rollback: {failure}")
    return {"result": result, "rollback": rollback_states[0], "rollback_commands": rollback_commands}


def main() -> None:
    common = load_module("file_agent_runner_common", SCRIPTS / "runner_common.py")
    preflight = load_module("file_agent_runner_preflight", SCRIPTS / "remote-preflight.py")
    rollback = load_module("file_agent_runner_rollback", SCRIPTS / "remote-rollback.py")
    require("LibreChat-API" not in preflight.PROTECTED_CONTAINERS, "API must be rebuildable, not identity-protected")

    with tempfile.TemporaryDirectory(prefix="file-agent-dual-service-test-") as temporary:
        workspace = Path(temporary)
        archive = workspace / "connector.tar.gz"
        archive_metadata = make_archive(archive)
        handoff = make_handoff(workspace, archive_metadata)
        handoff_path = workspace / "handoff-manifest.json"
        handoff_path.write_text(json.dumps(handoff), encoding="utf-8")
        deployment = common.validate_handoff(handoff, workspace)

        release_dir = workspace / "release"
        payload = {
            "services": {
                "api": {
                    "environment": ["EXISTING=value"],
                    "volumes": ["old:/app/keep:ro"],
                    "depends_on": ["codeapi"],
                },
                "codeapi": {"image": "codeapi:baseline"},
            },
            "secrets": {"existing": {"file": "/run/secrets/existing"}},
            "volumes": {"existing-data": {}},
        }
        patched = common.compose_with_runtime(copy.deepcopy(payload), release_dir, deployment)
        common.validate_runtime_compose(patched, release_dir, deployment)
        api = patched["services"]["api"]
        runtime = patched["services"]["file-agent-runtime"]
        require(api["environment"]["EXISTING"] == "value", "API environment was lost")
        require(api["environment"]["FILE_AGENT_RUNTIME_ENABLED"] == "true", "API feature flag is not enabled")
        require(any(str(release_dir / "connector") in str(item) for item in api["volumes"]), "Connector source mount is missing")
        require(runtime["image"].endswith("@sha256:" + "d" * 64), "Runtime image digest was changed")
        require("ports" not in runtime, "Runtime host port was published")
        require(runtime["depends_on"]["codeapi"]["condition"] == "service_started", "CodeAPI dependency is missing")
        require(runtime["healthcheck"]["test"][0] == "CMD", "Runtime healthcheck is missing")
        require("file-agent-runtime-data" in patched["volumes"], "Runtime durable volume is missing")
        require("file-agent-model-api-key" in patched["secrets"], "model secret is missing")
        require("file-agent-allowlist" in patched["services"]["api"]["secrets"], "allowlist is not mounted into API")
        require("file-agent-runtime" in api["depends_on"], "API does not depend on Runtime")

        extracted = workspace / "connector-extracted"
        extracted.mkdir()
        common.safe_extract_connector(archive, extracted, archive_metadata["files"])
        require((extracted / "src/production-host-integration.js").is_file(), "Connector archive replay failed")

        invalid = copy.deepcopy(handoff)
        invalid["deployment"]["runtime_image"] = "registry.example.test/file-agent-runtime:latest"
        try:
            common.validate_handoff(invalid, workspace)
        except RuntimeError:
            pass
        else:
            raise AssertionError("mutable Runtime image was accepted")

        fake_root = workspace / "librechat"
        fake_root.mkdir()
        (fake_root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (fake_root / "compose.override.yaml").write_text("candidate: true\n", encoding="utf-8")
        backup = workspace / "backup"
        backup.mkdir()
        (backup / "compose.override.yaml.before").write_text("before: true\n", encoding="utf-8")
        (backup / "state.json").write_text(
            json.dumps({
                "runtime_service_present": False,
                "candidate_runtime_container_id": "runtime-candidate",
                "compose_override_sha256_before": digest_bytes(b"before: true\n"),
                "protected_container_ids": {},
            }),
            encoding="utf-8",
        )
        calls: list[list[str]] = []
        candidate_removed = False

        def fake_run(command: list[str], check: bool = True):
            nonlocal candidate_removed
            calls.append(command)
            if command[:3] == ["docker", "inspect", "--format"]:
                return subprocess.CompletedProcess(command, 0, "true\n", "")
            if command[:3] == ["docker", "rm", "-f"]:
                candidate_removed = True
                return subprocess.CompletedProcess(command, 0, "", "")
            if command[:2] == ["docker", "inspect"] and candidate_removed and command[-1] == "runtime-candidate":
                return subprocess.CompletedProcess(command, 1, "", "not found")
            if command[:2] == ["docker", "exec"]:
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, "", "")

        rollback.restore_state(backup, root=fake_root, run_command=fake_run)
        require((fake_root / "compose.override.yaml").read_text(encoding="utf-8") == "before: true\n", "rollback did not restore Compose")
        require(any(command[:3] == ["docker", "rm", "-f"] for command in calls), "rollback did not remove the candidate Runtime")
        require(any(command[-1] == "api" for command in calls), "rollback did not recreate API")
        require(not any("LibreChat-CodeAPI" in command for command in calls), "rollback touched CodeAPI")

        runner_path = SCRIPTS / "remote-apply.py"
        failure_cases = [
            ("runtime-create", False, False),
            ("api-create", False, False),
            ("runtime-health", False, False),
            ("api-health", False, False),
            ("native-fallback", False, False),
            ("protected-identity", False, False),
            ("first-enable-rollback", False, False),
            ("existing-runtime-rollback", True, False),
            ("native-fallback", False, True),
        ]
        for index, (failure, runtime_present, rollback_fails) in enumerate(failure_cases):
            runner = load_module(f"file_agent_runner_failure_{index}", runner_path)
            case = exercise_apply_failure(
                runner,
                workspace / f"apply-failure-{index}",
                failure,
                runtime_present=runtime_present,
                rollback_fails=rollback_fails,
            )
            require(case["rollback"]["runtime_service_present"] is runtime_present, f"rollback state lost Runtime presence: {failure}")
            if failure == "api-create":
                require(case["rollback"]["candidate_runtime_container_id"] == "runtime-created", "API failure did not record Runtime ID")
            if failure == "runtime-create":
                require(
                    case["rollback"]["candidate_runtime_container_id"] == "runtime-created",
                    "partial Runtime creation was not recorded for rollback",
                )
                require(
                    case["rollback"]["candidate_runtime_container_id"]
                    and any(command[-1] == "runtime-created" for command in case.get("rollback_commands", [])),
                    "partial Runtime container was not scheduled for removal",
                )
            if rollback_fails:
                require(case["result"]["status"] == "failed", "rollback failure was reported as a successful rollback")
                require(case["result"]["rollback_error"] == "rollback API restart failed", "rollback failure evidence is missing")
            else:
                require(case["result"]["status"] == "rolled_back", f"failure case was not rolled back: {failure}")

    for index, source in enumerate(sorted(SCRIPTS.glob("*.py"))):
        with tempfile.TemporaryDirectory(prefix="file-agent-dual-service-pyc-") as temporary:
            py_compile.compile(str(source), cfile=str(Path(temporary) / f"{index}.pyc"), doraise=True)

    compose_text = (PATCH / "compose.runtime.contract.yaml").read_text(encoding="utf-8")
    require("file-agent-runtime:" in compose_text, "Compose Runtime service contract is missing")
    require("FILE_AGENT_RUNTIME_ENABLED:-false" in compose_text, "Compose contract is not disabled by default")
    apply_text = (SCRIPTS / "remote-apply.py").read_text(encoding="utf-8")
    require("restore_state" in apply_text, "automatic dual-service rollback is missing")
    require('"--no-deps"' in apply_text and '"--force-recreate"' in apply_text, "bounded Compose apply is missing")
    require(
        "resolveOfficeTaskIntent" in apply_text
        and "createProductionOfficePreflight" in apply_text
        and "/opt/librechat/file-agent-runtime/connector" in apply_text,
        "native fallback probe does not load the production Connector classifier and preflight",
    )
    require("user_not_allowlisted" in apply_text and "not_complex_file_intent" in apply_text, "native fallback cases are incomplete")
    runtime_dir = ROOT / "services/file-agent-runtime"
    dockerfile_text = (runtime_dir / "Dockerfile").read_text(encoding="utf-8")
    require("node:20-bookworm-slim@sha256:" in dockerfile_text, "Node base image is not digest-pinned")
    requirements_lock = runtime_dir / "requirements.lock"
    require(requirements_lock.is_file(), "Python requirements lock is missing")
    requirements_text = requirements_lock.read_text(encoding="utf-8")
    for package in ("openpyxl==", "python-docx==", "python-pptx=="):
        require(package in requirements_text, f"Python dependency is not exactly pinned: {package}")
    require("--hash=sha256:" in requirements_text, "Python dependency hashes are missing")
    apt_lock = runtime_dir / "apt-packages.lock"
    require(apt_lock.is_file(), "APT package lock is missing")
    apt_text = apt_lock.read_text(encoding="utf-8")
    for package in ("libreoffice-calc=", "libreoffice-impress=", "libreoffice-writer="):
        require(package in apt_text, f"APT dependency is not exactly pinned: {package}")
    deploy_text = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    require("release-governance:targets=LibreChat-API,file-agent-runtime" in deploy_text, "dual-service release scope marker is missing")
    require("--remove-orphans" not in deploy_text, "runner may not remove unrelated services")
    print("file_agent_dual_service_contract=passed")


if __name__ == "__main__":
    main()
