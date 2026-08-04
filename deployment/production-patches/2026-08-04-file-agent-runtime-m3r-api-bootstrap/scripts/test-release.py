#!/usr/bin/env python3
"""Local contract and rollback replay for the File Agent API bootstrap runner."""

from __future__ import annotations

import copy
import importlib.util
import json
import py_compile
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
PATCH = ROOT / "deployment/production-patches/2026-08-04-file-agent-runtime-m3r-api-bootstrap"
SCRIPTS = PATCH / "scripts"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_module(name: str, path: Path):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main() -> None:
    verify = SCRIPTS / "verify-overlay.py"
    with tempfile.TemporaryDirectory(prefix="file-agent-api-runner-test-") as temporary:
        workspace = Path(temporary)
        archive = workspace / "file-agent-api-overlay.tar.gz"
        handoff = workspace / "handoff-manifest.json"
        command = [
            sys.executable,
            str(verify),
            "--build-handoff",
            "--output",
            str(archive),
            "--handoff-manifest",
            str(handoff),
            "--source-revision",
            "a" * 40,
            "--artifact-sha256",
            "b" * 64,
            "--release-plan-sha256",
            "c" * 64,
        ]
        subprocess.run(command, check=True, text=True, capture_output=True)
        subprocess.run(
            [
                sys.executable,
                str(verify),
                "--verify-handoff",
                "--archive",
                str(archive),
                "--verify-manifest",
                str(handoff),
            ],
            check=True,
            text=True,
            capture_output=True,
        )
        manifest = json.loads(handoff.read_text(encoding="utf-8"))
        require(manifest["overlay_archive"]["bytes"] < 200_000, "incremental overlay archive is unexpectedly large")
        require(len(manifest["targets"]) == 4, "handoff target count changed")

        rollback_module = load_module("remote_rollback", SCRIPTS / "remote-rollback.py")
        apply = load_module("file_agent_remote_apply", SCRIPTS / "remote-apply.py")
        compose = {
            "services": {
                "api": {
                    "environment": ["EXISTING=value", "FILE_AGENT_RUNTIME_ENABLED=true"],
                    "volumes": [
                        "old-index:/app/api/server/index.js:ro",
                        "keep:/app/keep:ro",
                    ],
                }
            }
        }
        release_dir = workspace / "release"
        patched = apply.compose_with_overlay(copy.deepcopy(compose), release_dir, manifest["targets"])
        api = patched["services"]["api"]
        require(api["environment"]["FILE_AGENT_RUNTIME_ENABLED"] == "false", "disabled flag is not forced")
        require(api["environment"]["EXISTING"] == "value", "existing environment was lost")
        require("old-index:/app/api/server/index.js:ro" not in api["volumes"], "old API mount was retained")
        require("keep:/app/keep:ro" in api["volumes"], "unrelated API mount was lost")
        mounted = [entry for entry in api["volumes"] if str(release_dir) in entry]
        require(len(mounted) == 4, "candidate Compose did not mount exactly four overlay files")

        fake_root = workspace / "librechat"
        fake_root.mkdir()
        (fake_root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (fake_root / "compose.override.yaml").write_text("candidate: true\n", encoding="utf-8")
        backup = workspace / "backup"
        backup.mkdir()
        (backup / "compose.override.yaml.before").write_text("before: true\n", encoding="utf-8")
        calls: list[list[str]] = []

        def fake_run(command: list[str], check: bool = True):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        rollback_module.restore_compose_override(backup, root=fake_root, run_command=fake_run)
        require(
            (fake_root / "compose.override.yaml").read_text(encoding="utf-8") == "before: true\n",
            "rollback did not restore the prior Compose override",
        )
        require(any(command[-1] == "api" for command in calls), "rollback did not recreate API")
        require(not any("LibreChat-CodeAPI" in command for command in calls), "rollback touched CodeAPI")

    deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    require("release-governance:scoped-deployment" in deploy, "scoped deployment marker is missing")
    require("release-governance:targets=LibreChat-API" in deploy, "API-only target marker is missing")
    require("--remove-orphans" not in deploy, "runner may not remove unrelated services")
    apply_text = (SCRIPTS / "remote-apply.py").read_text(encoding="utf-8")
    require("FILE_AGENT_RUNTIME_ENABLED" in apply_text, "disabled runtime flag is missing")
    require("restore_compose_override" in apply_text, "automatic rollback is missing")
    require('"--no-deps",' in apply_text and '"--force-recreate",' in apply_text, "API recreate is missing")

    python_files = sorted(SCRIPTS.glob("*.py"))
    with tempfile.TemporaryDirectory(prefix="file-agent-api-pyc-") as temporary:
        for index, source in enumerate(python_files):
            py_compile.compile(str(source), cfile=str(Path(temporary) / f"{index}.pyc"), doraise=True)
    print("file_agent_api_bootstrap_contract=passed")


if __name__ == "__main__":
    main()
