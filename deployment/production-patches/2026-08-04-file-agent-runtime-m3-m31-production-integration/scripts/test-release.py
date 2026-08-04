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


def main() -> None:
    common = load_module("file_agent_runner_common", SCRIPTS / "runner_common.py")
    rollback = load_module("file_agent_runner_rollback", SCRIPTS / "remote-rollback.py")

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
            json.dumps({"runtime_service_present": False, "candidate_runtime_container_id": "runtime-candidate"}),
            encoding="utf-8",
        )
        calls: list[list[str]] = []

        def fake_run(command: list[str], check: bool = True):
            calls.append(command)
            if command[:3] == ["docker", "inspect", "--format"]:
                return subprocess.CompletedProcess(command, 0, "true\n", "")
            return subprocess.CompletedProcess(command, 0, "", "")

        rollback.restore_state(backup, root=fake_root, run_command=fake_run)
        require((fake_root / "compose.override.yaml").read_text(encoding="utf-8") == "before: true\n", "rollback did not restore Compose")
        require(any(command[:3] == ["docker", "rm", "-f"] for command in calls), "rollback did not remove the candidate Runtime")
        require(any(command[-1] == "api" for command in calls), "rollback did not recreate API")
        require(not any("LibreChat-CodeAPI" in command for command in calls), "rollback touched CodeAPI")

    for index, source in enumerate(sorted(SCRIPTS.glob("*.py"))):
        with tempfile.TemporaryDirectory(prefix="file-agent-dual-service-pyc-") as temporary:
            py_compile.compile(str(source), cfile=str(Path(temporary) / f"{index}.pyc"), doraise=True)

    compose_text = (PATCH / "compose.runtime.contract.yaml").read_text(encoding="utf-8")
    require("file-agent-runtime:" in compose_text, "Compose Runtime service contract is missing")
    require("FILE_AGENT_RUNTIME_ENABLED:-false" in compose_text, "Compose contract is not disabled by default")
    apply_text = (SCRIPTS / "remote-apply.py").read_text(encoding="utf-8")
    require("restore_state" in apply_text, "automatic dual-service rollback is missing")
    require('"--no-deps"' in apply_text and '"--force-recreate"' in apply_text, "bounded Compose apply is missing")
    deploy_text = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    require("release-governance:targets=LibreChat-API,file-agent-runtime" in deploy_text, "dual-service release scope marker is missing")
    require("--remove-orphans" not in deploy_text, "runner may not remove unrelated services")
    print("file_agent_dual_service_contract=passed")


if __name__ == "__main__":
    main()
