#!/usr/bin/env python3
"""Red tests for Sol's dual-service apply and rollback rejection cases.

These tests intentionally describe the required failure-injection seam before
the runner implementation is changed. They must be committed and observed
failing before the production runner is modified.
"""

from __future__ import annotations

import importlib.util
import json
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
    preflight = {"baseline": {"containers": {}, "runtime_container_id": None}}
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
        if "up" in command:
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

    def fake_native_fallback_probe(*, api_container: str) -> None:
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


if __name__ == "__main__":
    failures = []
    for name, check in (
        ("runtime-created-api-failure", test_runtime_created_then_api_create_fails_records_runtime_for_rollback),
        ("native-fallback-failure", test_native_fallback_probe_failure_rolls_back_without_success_record),
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
