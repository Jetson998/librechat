#!/usr/bin/env python3
"""Red tests for Sol's dual-service apply and rollback rejection cases.

These tests intentionally describe the required failure-injection seam before
the runner implementation is changed. They must be committed and observed
failing before the production runner is modified.
"""

from __future__ import annotations

import importlib.util
import json
import hashlib
import sys
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
SCRIPTS = ROOT / "deployment/production-patches/2026-08-04-file-agent-runtime-m3-m31-production-integration/scripts"


def load_module(name: str, path: Path):
    if str(path.parent) not in sys.path:
        sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def minimal_runner_fixture(runner, workspace: Path):
    stage = workspace / "stage"
    stage.mkdir()
    root = workspace / "librechat"
    root.mkdir()
    (root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    (root / "compose.override.yaml").write_text("services: {}\n", encoding="utf-8")
    (stage / "connector.tar.gz").write_bytes(b"fixture")
    handoff = {
        "source_revision": "a" * 40,
        "connector_archive": {"filename": "connector.tar.gz", "files": []},
    }
    preflight = {
        "baseline": {
            "containers": {},
            "runtime_container_id": None,
            "compose_override_sha256": "override",
        },
    }
    runner.load_stage = lambda _stage: (handoff, {}, preflight)
    runner.verify_baseline = lambda _root, _baseline: None
    runner.safe_extract_connector = lambda *_args: None
    runner.compose_with_runtime = lambda *_args: {"services": {"api": {}, "codeapi": {}}}
    runner.validate_runtime_compose = lambda *_args: None
    runner.inspect = lambda name: {"Id": name}
    return stage, root


def test_runtime_created_then_api_create_fails_records_runtime_for_rollback() -> None:
    runner = load_module("sol_rejection_remote_apply", SCRIPTS / "remote-apply.py")
    rollback_state: list[dict] = []

    def fake_run(command: list[str], check: bool = True):
        if "config" in command and "--format" in command:
            return subprocess.CompletedProcess(
                command,
                0,
                json.dumps({"services": {"api": {}, "codeapi": {}}}),
                "",
            )
        if "up" in command and runner.API_SERVICE in command:
            raise RuntimeError("API creation failed after Runtime container creation")
        return subprocess.CompletedProcess(command, 0, "", "")

    def fake_rollback_module():
        class Rollback:
            @staticmethod
            def restore_state(backup_dir: Path, *, root: Path, run_command):
                state = json.loads((backup_dir / "state.json").read_text(encoding="utf-8"))
                rollback_state.append(state)

        return Rollback

    with tempfile.TemporaryDirectory(prefix="sol-runtime-api-failure-") as temporary:
        workspace = Path(temporary)
        stage, root = minimal_runner_fixture(runner, workspace)
        runner.load_rollback_module = fake_rollback_module
        runner.compose_container_id = lambda *_args, **_kwargs: "runtime-created"
        runner.wait_healthy = lambda *_args, **_kwargs: {
            "State": {"Running": True, "Health": {"Status": "healthy"}},
            "HostConfig": {"PortBindings": None},
        }

        try:
            runner.apply(stage, root=root, run_command=fake_run)
        except Exception:
            pass

    assert rollback_state, "apply must invoke rollback after API creation fails"
    assert rollback_state[0]["candidate_runtime_container_id"] == "runtime-created"


def test_native_fallback_probe_failure_rolls_back_without_success_record() -> None:
    runner = load_module("sol_rejection_remote_apply_native", SCRIPTS / "remote-apply.py")
    calls: list[str] = []
    rollback_state: list[dict] = []

    def fake_native_fallback_probe(*, api_container: str, **_kwargs) -> None:
        calls.append(api_container)
        raise RuntimeError("native fallback probe failed")

    def fake_run(command: list[str], check: bool = True):
        if "config" in command and "--format" in command:
            return subprocess.CompletedProcess(
                command,
                0,
                json.dumps({"services": {"api": {}, "codeapi": {}}}),
                "",
            )
        return subprocess.CompletedProcess(command, 0, "", "")

    def fake_rollback_module():
        class Rollback:
            @staticmethod
            def restore_state(backup_dir: Path, *, root: Path, run_command):
                rollback_state.append(json.loads((backup_dir / "state.json").read_text(encoding="utf-8")))

        return Rollback

    with tempfile.TemporaryDirectory(prefix="sol-native-fallback-failure-") as temporary:
        workspace = Path(temporary)
        stage, root = minimal_runner_fixture(runner, workspace)
        runner.load_rollback_module = fake_rollback_module
        runner.compose_container_id = lambda *_args, **_kwargs: "runtime-created"
        runner.wait_healthy = lambda *_args, **_kwargs: {
            "State": {"Running": True, "Health": {"Status": "healthy"}},
            "HostConfig": {"PortBindings": None},
        }
        runner.wait_running = lambda *_args, **_kwargs: {
            "State": {"Running": True},
            "Config": {"Env": ["FILE_AGENT_RUNTIME_ENABLED=true"]},
        }
        runner.verify_internal_health = lambda *_args, **_kwargs: None

        try:
            runner.apply(
                stage,
                root=root,
                run_command=fake_run,
                native_fallback_probe=fake_native_fallback_probe,
            )
        except Exception:
            pass

    assert calls == ["LibreChat-API"]
    assert rollback_state, "native fallback failure must invoke rollback"


def test_real_connector_archive_imports_after_production_extraction() -> None:
    common = load_module("sol_rejection_runner_common_archive", SCRIPTS / "runner_common.py")
    with tempfile.TemporaryDirectory(prefix="sol-real-connector-archive-") as temporary:
        workspace = Path(temporary)
        archive = workspace / "connector.tar.gz"
        manifest = workspace / "connector.manifest.json"
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "package-connector-archive.py"),
                "--source-root",
                str(ROOT / "services/librechat-file-agent-connector"),
                "--output",
                str(archive),
                "--manifest-output",
                str(manifest),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        metadata = json.loads(manifest.read_text(encoding="utf-8"))
        extracted = workspace / "connector"
        extracted.mkdir()
        common.safe_extract_connector(archive, extracted, metadata["files"])
        imported = subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                "import { pathToFileURL } from 'node:url'; import(process.argv[1] ? pathToFileURL(process.argv[1]).href : '').then((module) => { if (typeof module.createProductionOfficePreflight !== 'function') process.exit(2); }).catch((error) => { console.error(error.stack || error); process.exit(1); });",
                str(extracted / "src/production-host-integration.js"),
            ],
            capture_output=True,
            text=True,
        )
        assert imported.returncode == 0, imported.stderr


def test_rollback_rejects_api_baseline_or_runtime_health_mismatch() -> None:
    rollback = load_module("sol_rejection_remote_rollback_baseline", SCRIPTS / "remote-rollback.py")
    with tempfile.TemporaryDirectory(prefix="sol-rollback-baseline-") as temporary:
        root = Path(temporary) / "librechat"
        root.mkdir()
        (root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (root / "compose.override.yaml").write_text("candidate: true\n", encoding="utf-8")
        backup = Path(temporary) / "backup"
        backup.mkdir()
        before = backup / "compose.override.yaml.before"
        before.write_text("before: true\n", encoding="utf-8")
        (backup / "state.json").write_text(
            json.dumps({
                "runtime_service_present": True,
                "runtime_container_id": "runtime-before",
                "runtime": {
                    "container_id": "runtime-before",
                    "image_id": "runtime-image-before",
                    "image_ref": "runtime:before",
                    "health": "healthy",
                },
                "candidate_runtime_container_id": "runtime-candidate",
                "compose_override_sha256_before": __import__("hashlib").sha256(before.read_bytes()).hexdigest(),
                "protected_container_ids": {},
                "api": {
                    "image_id": "api-image-before",
                    "image_ref": "api:before",
                    "runtime_enabled": False,
                },
            }),
            encoding="utf-8",
        )
        def fake_run(command: list[str], check: bool = True):
            if command[:3] == ["docker", "inspect", "--format"]:
                return subprocess.CompletedProcess(command, 0, "true\n", "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "LibreChat-API":
                image_id = "api-image-wrong"
                payload = {"Id": "new-api", "Image": image_id, "Config": {"Image": "api:before", "Env": ["FILE_AGENT_RUNTIME_ENABLED=true"]}}
                return subprocess.CompletedProcess(command, 0, json.dumps([payload]), "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "runtime-before":
                payload = {"Id": "runtime-before", "Image": "runtime-image-before", "Config": {"Image": "runtime:before"}, "State": {"Health": {"Status": "starting"}}}
                return subprocess.CompletedProcess(command, 0, json.dumps([payload]), "")
            if command[:2] == ["docker", "exec"]:
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, "", "")

        try:
            rollback.restore_state(backup, root=root, run_command=fake_run)
        except RuntimeError as error:
            assert "API" in str(error) or "Runtime" in str(error)
        else:
            raise AssertionError("rollback accepted a mismatched API baseline")


def test_rollback_rejects_feature_flag_mismatch() -> None:
    rollback = load_module("sol_rejection_remote_rollback_flag", SCRIPTS / "remote-rollback.py")
    with tempfile.TemporaryDirectory(prefix="sol-rollback-flag-") as temporary:
        root = Path(temporary) / "librechat"
        root.mkdir()
        (root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (root / "compose.override.yaml").write_text("candidate: true\n", encoding="utf-8")
        backup = Path(temporary) / "backup"
        backup.mkdir()
        before = backup / "compose.override.yaml.before"
        before.write_text("before: true\n", encoding="utf-8")
        (backup / "state.json").write_text(
            json.dumps({
                "runtime_service_present": False,
                "candidate_runtime_container_id": None,
                "compose_override_sha256_before": hashlib.sha256(before.read_bytes()).hexdigest(),
                "protected_container_ids": {},
                "api": {"image_id": "api-image-before", "image_ref": "api:before", "runtime_enabled": False},
                "runtime": {"present": False},
            }),
            encoding="utf-8",
        )

        def fake_run(command: list[str], check: bool = True):
            if command[:3] == ["docker", "inspect", "--format"]:
                return subprocess.CompletedProcess(command, 0, "true\n", "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "LibreChat-API":
                payload = {"Id": "new-api", "Image": "api-image-before", "Config": {"Image": "api:before", "Env": ["FILE_AGENT_RUNTIME_ENABLED=true"]}}
                return subprocess.CompletedProcess(command, 0, json.dumps([payload]), "")
            if command[:2] == ["docker", "exec"]:
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, "", "")

        try:
            rollback.restore_state(backup, root=root, run_command=fake_run)
        except RuntimeError as error:
            assert "feature flag" in str(error)
        else:
            raise AssertionError("rollback accepted a mismatched Runtime feature flag")


def test_rollback_rejects_unhealthy_existing_runtime() -> None:
    rollback = load_module("sol_rejection_remote_rollback_runtime", SCRIPTS / "remote-rollback.py")
    with tempfile.TemporaryDirectory(prefix="sol-rollback-runtime-") as temporary:
        root = Path(temporary) / "librechat"
        root.mkdir()
        (root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (root / "compose.override.yaml").write_text("candidate: true\n", encoding="utf-8")
        backup = Path(temporary) / "backup"
        backup.mkdir()
        before = backup / "compose.override.yaml.before"
        before.write_text("before: true\n", encoding="utf-8")
        (backup / "state.json").write_text(
            json.dumps({
                "runtime_service_present": True,
                "runtime_container_id": "runtime-before",
                "compose_override_sha256_before": hashlib.sha256(before.read_bytes()).hexdigest(),
                "protected_container_ids": {},
                "api": {"image_id": "api-image-before", "image_ref": "api:before", "runtime_enabled": "true"},
                "runtime": {
                    "present": True,
                    "container_id": "runtime-before",
                    "image_id": "runtime-image-before",
                    "image_ref": "runtime:before",
                    "health": "healthy",
                },
            }),
            encoding="utf-8",
        )

        def fake_run(command: list[str], check: bool = True):
            if command[:3] == ["docker", "inspect", "--format"]:
                return subprocess.CompletedProcess(command, 0, "true\n", "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "LibreChat-API":
                payload = {"Id": "new-api", "Image": "api-image-before", "Config": {"Image": "api:before", "Env": ["FILE_AGENT_RUNTIME_ENABLED=true"]}}
                return subprocess.CompletedProcess(command, 0, json.dumps([payload]), "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "file-agent-runtime":
                payload = {"Id": "new-runtime", "Image": "runtime-image-before", "Config": {"Image": "runtime:before"}, "State": {"Running": True, "Health": {"Status": "starting"}}}
                return subprocess.CompletedProcess(command, 0, json.dumps([payload]), "")
            if command[:2] == ["docker", "exec"]:
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, "", "")

        try:
            rollback.restore_state(backup, root=root, run_command=fake_run)
        except RuntimeError as error:
            assert "Runtime health" in str(error)
        else:
            raise AssertionError("rollback accepted an unhealthy existing Runtime")


def test_runtime_build_uses_an_immutable_debian_source() -> None:
    dockerfile = (ROOT / "services/file-agent-runtime/Dockerfile").read_text(encoding="utf-8")
    assert "snapshot.debian.org" in dockerfile or "DEBIAN_SNAPSHOT" in dockerfile


if __name__ == "__main__":
    failures = []
    for name, check in (
        ("runtime-created-api-failure", test_runtime_created_then_api_create_fails_records_runtime_for_rollback),
        ("native-fallback-failure", test_native_fallback_probe_failure_rolls_back_without_success_record),
        ("real-connector-archive-import", test_real_connector_archive_imports_after_production_extraction),
        ("rollback-baseline-mismatch", test_rollback_rejects_api_baseline_or_runtime_health_mismatch),
        ("rollback-feature-flag-mismatch", test_rollback_rejects_feature_flag_mismatch),
        ("rollback-existing-runtime-health", test_rollback_rejects_unhealthy_existing_runtime),
        ("immutable-debian-source", test_runtime_build_uses_an_immutable_debian_source),
    ):
        try:
            check()
        except Exception as error:
            failures.append((name, error))
    if failures:
        for name, error in failures:
            print(f"FAIL {name}: {error}")
        raise SystemExit(1)
    print("sol_rejection_tests=passed")
