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
import os
import re
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


def test_enabled_runtime_probe_failure_rolls_back_without_success_record() -> None:
    runner = load_module("sol_rejection_remote_apply_native", SCRIPTS / "remote-apply.py")
    calls: list[str] = []
    rollback_state: list[dict] = []

    def fake_enabled_runtime_probe(*, api_container: str, **_kwargs) -> None:
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
                enabled_runtime_probe=fake_enabled_runtime_probe,
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
            if command[:3] == ["docker", "compose", "--project-directory"] and "ps" in command:
                return subprocess.CompletedProcess(command, 0, "runtime-after\n", "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "runtime-after":
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


def test_disabled_baseline_probe_has_no_runtime_or_connector_dependencies() -> None:
    rollback = load_module("sol_rejection_disabled_probe_contract", SCRIPTS / "remote-rollback.py")
    if not hasattr(rollback, "disabled_baseline_probe"):
        raise AssertionError("disabled baseline probe is missing")

    calls: list[list[str]] = []

    def fake_run(command: list[str], check: bool = True):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    rollback.disabled_baseline_probe(api_container="LibreChat-API", run_command=fake_run)
    command_text = " ".join(" ".join(command) for command in calls)
    assert "127.0.0.1:3080/api/config" in command_text
    assert "file-agent-runtime" not in command_text
    assert "production-host-integration" not in command_text
    assert "/opt/librechat/file-agent-runtime/connector" not in command_text


def test_disabled_rollback_uses_only_the_baseline_probe() -> None:
    rollback = load_module("sol_rejection_disabled_rollback_probe", SCRIPTS / "remote-rollback.py")
    with tempfile.TemporaryDirectory(prefix="sol-disabled-rollback-probe-") as temporary:
        workspace = Path(temporary)
        root = workspace / "librechat"
        root.mkdir()
        (root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (root / "compose.override.yaml").write_text("candidate: true\n", encoding="utf-8")
        backup = workspace / "backup"
        backup.mkdir()
        before = backup / "compose.override.yaml.before"
        before.write_text("before: true\n", encoding="utf-8")
        (backup / "state.json").write_text(
            json.dumps({
                "runtime_service_present": False,
                "candidate_runtime_container_id": "runtime-candidate",
                "compose_override_sha256_before": hashlib.sha256(before.read_bytes()).hexdigest(),
                "protected_container_ids": {},
                "api": {
                    "image_id": "api-image-before",
                    "image_ref": "api:before",
                    "runtime_enabled": "false",
                },
                "runtime": {"present": False},
            }),
            encoding="utf-8",
        )
        enabled_calls: list[str] = []
        disabled_calls: list[str] = []

        rollback.native_fallback_probe = lambda **_kwargs: enabled_calls.append("enabled")
        rollback.disabled_baseline_probe = lambda **_kwargs: disabled_calls.append("disabled")

        def fake_run(command: list[str], check: bool = True):
            if command[:3] == ["docker", "inspect", "--format"]:
                return subprocess.CompletedProcess(command, 0, "true\n", "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "LibreChat-API":
                payload = {
                    "Id": "api-after",
                    "Image": "api-image-before",
                    "Config": {"Image": "api:before", "Env": ["FILE_AGENT_RUNTIME_ENABLED=false"]},
                    "Mounts": [],
                }
                return subprocess.CompletedProcess(command, 0, json.dumps([payload]), "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "runtime-candidate":
                return subprocess.CompletedProcess(command, 1, "", "not found")
            if command[:2] == ["docker", "exec"]:
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, "", "")

        rollback.restore_state(backup, root=root, run_command=fake_run)
        assert disabled_calls == ["disabled"]
        assert enabled_calls == []


def test_existing_runtime_rollback_resolves_compose_service_container_id() -> None:
    rollback = load_module("sol_rejection_runtime_service_id", SCRIPTS / "remote-rollback.py")
    with tempfile.TemporaryDirectory(prefix="sol-runtime-service-id-") as temporary:
        workspace = Path(temporary)
        root = workspace / "librechat"
        root.mkdir()
        (root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (root / "compose.override.yaml").write_text("candidate: true\n", encoding="utf-8")
        backup = workspace / "backup"
        backup.mkdir()
        before = backup / "compose.override.yaml.before"
        before.write_text("before: true\n", encoding="utf-8")
        (backup / "state.json").write_text(
            json.dumps({
                "runtime_service_present": True,
                "candidate_runtime_container_id": None,
                "compose_override_sha256_before": hashlib.sha256(before.read_bytes()).hexdigest(),
                "protected_container_ids": {},
                "api": {
                    "image_id": "api-image-before",
                    "image_ref": "api:before",
                    "runtime_enabled": "true",
                },
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
        commands: list[list[str]] = []

        def fake_run(command: list[str], check: bool = True):
            commands.append(command)
            if command[:3] == ["docker", "inspect", "--format"]:
                return subprocess.CompletedProcess(command, 0, "true\n", "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "LibreChat-API":
                payload = {
                    "Id": "api-after",
                    "Image": "api-image-before",
                    "Config": {"Image": "api:before", "Env": ["FILE_AGENT_RUNTIME_ENABLED=true"]},
                    "Mounts": [],
                }
                return subprocess.CompletedProcess(command, 0, json.dumps([payload]), "")
            if command[:3] == ["docker", "compose", "--project-directory"] and "ps" in command:
                return subprocess.CompletedProcess(command, 0, "runtime-after\n", "")
            if command[:2] == ["docker", "inspect"] and command[-1] == "file-agent-runtime":
                return subprocess.CompletedProcess(command, 1, "", "service name is not a container")
            if command[:2] == ["docker", "inspect"] and command[-1] == "runtime-after":
                payload = {
                    "Id": "runtime-after",
                    "Image": "runtime-image-before",
                    "Config": {"Image": "runtime:before"},
                    "State": {"Running": True, "Health": {"Status": "healthy"}},
                }
                return subprocess.CompletedProcess(command, 0, json.dumps([payload]), "")
            if command[:2] == ["docker", "exec"]:
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, "", "")

        rollback.restore_state(backup, root=root, run_command=fake_run)
        assert any("ps" in command and "file-agent-runtime" in command for command in commands)
        assert not any(command[-1] == "file-agent-runtime" for command in commands if command[:2] == ["docker", "inspect"])


def test_runtime_build_snapshot_matches_locked_package_release_and_suite_syntax() -> None:
    dockerfile = (ROOT / "services/file-agent-runtime/Dockerfile").read_text(encoding="utf-8")
    snapshot_matches = re.findall(r"snapshot\.debian\.org/archive/debian(?:-security)?/(\d{8}T\d{6}Z)", dockerfile)
    assert snapshot_matches
    assert min(snapshot_matches) >= "20260702T000000Z"
    assert "bookworm main bookworm-updates" not in dockerfile
    assert " bookworm main'" in dockerfile
    assert " bookworm-updates main'" in dockerfile
    assert " bookworm-security main'" in dockerfile
    assert 'test "$TARGETARCH" = "amd64"' in dockerfile
    assert 'test "$(dpkg --print-architecture)" = "amd64"' in dockerfile

    apt_lock = (ROOT / "services/file-agent-runtime/apt-packages.lock").read_text(encoding="utf-8")
    assert "libreoffice-calc=4:7.4.7-1+deb12u13" in apt_lock
    assert "libreoffice-impress=4:7.4.7-1+deb12u13" in apt_lock
    assert "libreoffice-writer=4:7.4.7-1+deb12u13" in apt_lock


def test_runtime_build_indexes_provide_every_locked_package() -> None:
    verifier = SCRIPTS / "verify-apt-snapshot.py"
    command = [
        sys.executable,
        str(verifier),
        "--dockerfile",
        str(ROOT / "services/file-agent-runtime/Dockerfile"),
        "--apt-lock",
        str(ROOT / "services/file-agent-runtime/apt-packages.lock"),
        "--architecture",
        "amd64",
    ]
    index_specs = os.environ.get("FILE_AGENT_APT_INDEX_SPECS")
    if index_specs:
        for spec in index_specs.split(","):
            command.extend(("--index", spec))
    else:
        command.append("--download")

    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, (
        "the declared Debian snapshot must expose every exact locked package "
        f"through amd64 Packages indexes; stdout={result.stdout!r} "
        f"stderr={result.stderr!r}"
    )


def test_runtime_build_indexes_reject_unavailable_exact_version() -> None:
    verifier = SCRIPTS / "verify-apt-snapshot.py"
    with tempfile.TemporaryDirectory(prefix="apt-snapshot-invalid-lock-") as temporary:
        invalid_lock = Path(temporary) / "apt-packages.lock"
        invalid_lock.write_text(
            (ROOT / "services/file-agent-runtime/apt-packages.lock")
            .read_text(encoding="utf-8")
            .replace("4:7.4.7-1+deb12u13", "4:7.4.7-1+deb12u14"),
            encoding="utf-8",
        )
        command = [
            sys.executable,
            str(verifier),
            "--dockerfile",
            str(ROOT / "services/file-agent-runtime/Dockerfile"),
            "--apt-lock",
            str(invalid_lock),
            "--architecture",
            "amd64",
        ]
        index_specs = os.environ.get("FILE_AGENT_APT_INDEX_SPECS")
        if index_specs:
            for spec in index_specs.split(","):
                command.extend(("--index", spec))
        else:
            command.append("--download")
        result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode != 0, "an exact version absent from Packages indexes was accepted"
    assert "deb12u14" in result.stderr


if __name__ == "__main__":
    failures = []
    for name, check in (
        ("runtime-created-api-failure", test_runtime_created_then_api_create_fails_records_runtime_for_rollback),
        ("enabled-runtime-probe-failure", test_enabled_runtime_probe_failure_rolls_back_without_success_record),
        ("real-connector-archive-import", test_real_connector_archive_imports_after_production_extraction),
        ("rollback-baseline-mismatch", test_rollback_rejects_api_baseline_or_runtime_health_mismatch),
        ("rollback-feature-flag-mismatch", test_rollback_rejects_feature_flag_mismatch),
        ("rollback-existing-runtime-health", test_rollback_rejects_unhealthy_existing_runtime),
        ("disabled-baseline-probe-contract", test_disabled_baseline_probe_has_no_runtime_or_connector_dependencies),
        ("disabled-rollback-probe", test_disabled_rollback_uses_only_the_baseline_probe),
        ("runtime-service-container-id", test_existing_runtime_rollback_resolves_compose_service_container_id),
        ("compatible-debian-snapshot", test_runtime_build_snapshot_matches_locked_package_release_and_suite_syntax),
        ("apt-index-exact-package-resolution", test_runtime_build_indexes_provide_every_locked_package),
        ("apt-index-rejects-unavailable-version", test_runtime_build_indexes_reject_unavailable_exact_version),
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
