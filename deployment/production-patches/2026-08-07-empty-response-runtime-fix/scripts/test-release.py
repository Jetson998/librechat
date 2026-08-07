#!/usr/bin/env python3
"""Contract checks for the empty-response API-only release runner."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import py_compile
import subprocess
import tempfile
from pathlib import Path


PATCH = Path(__file__).resolve().parents[1]
SCRIPTS = PATCH / "scripts"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> None:
    manifest = json.loads((PATCH / "SOURCE_MANIFEST.json").read_text(encoding="utf-8"))
    require(manifest["status"] == "development_only", "manifest must remain development-only before release")
    require(len(manifest["targets"]) == 4, "target count changed")
    for target in manifest["targets"]:
        source = PATCH / target["source"]
        require(source.is_file(), f"missing source: {target['source']}")
        require(hashlib.sha256(source.read_bytes()).hexdigest() == target["candidate_sha256"], f"source hash mismatch: {target['source']}")

    deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    preflight = (SCRIPTS / "remote-preflight.py").read_text(encoding="utf-8")
    apply = (SCRIPTS / "remote-apply.py").read_text(encoding="utf-8")
    rollback = (SCRIPTS / "remote-rollback.py").read_text(encoding="utf-8")
    collect = (SCRIPTS / "collect-preflight.sh").read_text(encoding="utf-8")

    require("release-governance:scoped-deployment" in deploy, "scoped marker missing")
    require("release-governance:targets=LibreChat-API" in deploy, "API-only marker missing")
    require("release-governance:target-lock" in deploy, "target lock marker missing")
    require("--remove-orphans" not in deploy and "--remove-orphans" not in apply, "orphan removal is forbidden")
    for protected in ("LibreChat-CodeAPI", "LibreChat-NGINX", "LibreChat-RAG-API", "chat-mongodb", "LibreChat-Admin-Panel"):
        require(protected in preflight and protected in apply and protected in rollback, f"protected service guard missing: {protected}")
    for destination in (
        "/app/api/app/clients/BaseClient.js",
        "/app/api/server/controllers/agents/request.js",
        "/app/api/server/controllers/agents/InitializationFailure.js",
        "/app/api/server/services/DiagnosticEvents.js",
    ):
        require(destination in apply and destination in preflight, f"target missing: {destination}")
    require("--no-deps" in apply and "--force-recreate" in apply, "API-only recreate contract missing")
    require("compose_with_overlay" in apply and "config" in apply, "Compose normalization contract missing")
    require("import yaml" not in apply, "remote runner must not require PyYAML")
    require("response_shape_only" in (PATCH / "SOURCE_MANIFEST.json").read_text(encoding="utf-8"), "privacy contract missing")
    require("write_operations" in preflight and "rollback_available" in preflight, "preflight evidence contract missing")
    require("remote-rollback.py" in apply and "--no-lock" in apply, "automatic rollback contract missing")
    require("rm -rf '$remote_stage'" in deploy and "rm -rf '$remote_stage'" in collect, "temporary stage cleanup missing")

    subprocess.run(["bash", "-n", str(SCRIPTS / "ssh-transport.sh")], check=True)
    subprocess.run(["bash", "-n", str(SCRIPTS / "collect-preflight.sh")], check=True)
    subprocess.run(["bash", "-n", str(SCRIPTS / "deploy.sh")], check=True)
    with tempfile.TemporaryDirectory(prefix="empty-response-runner-pyc-") as temporary:
        for index, source in enumerate(sorted(SCRIPTS.glob("*.py"))):
            py_compile.compile(
                str(source),
                cfile=str(Path(temporary) / f"{index}.pyc"),
                doraise=True,
            )

    apply_module = load_module("empty_response_remote_apply", SCRIPTS / "remote-apply.py")
    compose = {
        "services": {
            "api": {
                "extra_hosts": ["gateway=host-gateway", "database:127.0.0.1"],
                "volumes": [
                    "old:/app/api/app/clients/BaseClient.js:ro",
                    "keep:/app/keep:ro",
                ]
            }
        }
    }
    with tempfile.TemporaryDirectory(prefix="empty-response-runner-test-") as temporary:
        patched = apply_module.compose_with_overlay(compose, Path(temporary) / "release")
        volumes = patched["services"]["api"]["volumes"]
        require(
            patched["services"]["api"]["extra_hosts"]
            == {"gateway": "host-gateway", "database": "127.0.0.1"},
            "Compose extra_hosts list was not normalized",
        )
        require("old:/app/api/app/clients/BaseClient.js:ro" not in volumes, "old target mount retained")
        require("keep:/app/keep:ro" in volumes, "unrelated mount removed")
        require(sum("/app/api/" in entry for entry in volumes) == 4, "four API target mounts expected")

    print("empty_response_runtime_release_runner_contract=passed")


if __name__ == "__main__":
    main()
