#!/usr/bin/env python3
"""Focused local contract checks for the cumulative Client/PPT release."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
METADATA = ROOT / "client" / "artifact.json"
ARCHIVE = Path("/Users/jets2026/Documents/Codex/LibreChat/tmp/agent-ui-upstream/ppt-entry-modal-cumulative-client-candidate-20260922.tar.gz")


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_verifier():
    path = SCRIPTS / "verify-artifact.py"
    spec = importlib.util.spec_from_file_location("ppt_cumulative_verifier", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def main() -> None:
    metadata = json.loads(METADATA.read_text(encoding="utf-8"))
    check(metadata["source"]["candidate_revision"] == "a79bfb08461016044d092f6fd1ec584811047fde", "source revision mismatch")
    check(metadata["candidate"]["archive_sha256"] == "e2355c3202e2e0ef6a1c1a137a957f291f5d4284394341cd294b476c20c0944f", "candidate digest mismatch")
    check(metadata["client"]["file_count"] == 352, "Client file count mismatch")
    check(len(metadata["client"]["protected_assets"]) == 10, "protected overlay count mismatch")
    check(metadata["ppt"]["file_count"] == 14, "PPT file count mismatch")
    check(metadata["build_provenance"]["production_host"] is False, "production build provenance is unsafe")

    for script in SCRIPTS.glob("*.sh"):
        subprocess.run(["bash", "-n", str(script)], check=True)
    for script in SCRIPTS.glob("*.py"):
        compile(script.read_text(encoding="utf-8"), str(script), "exec")

    result = load_verifier().verify(ARCHIVE, METADATA)
    check(result["status"] == "passed", "candidate archive verification failed")
    apply = (SCRIPTS / "remote-apply.sh").read_text(encoding="utf-8")
    rollback = (SCRIPTS / "remote-rollback.sh").read_text(encoding="utf-8")
    deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    check("release-governance:scoped-deployment" in deploy, "deployment scope marker missing")
    check("LibreChat-API,PPT-static-root" in deploy, "deployment target marker missing")
    check("--no-deps --force-recreate api" in apply, "API-only recreate missing")
    check("docker compose" in rollback and "--force-recreate api" in rollback, "rollback recreate missing")
    check("nginx_reloaded" in apply and "False" in apply, "Nginx no-reload contract missing")
    check("mongosh" not in apply and "migrate" not in apply, "database mutation leaked into runner")
    print(json.dumps(result, sort_keys=True))
    print("ppt_entry_modal_cumulative_client_release_contract=passed")


if __name__ == "__main__":
    main()
