#!/usr/bin/env python3
"""Patch contract tests for the bounded Client-only production release."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
METADATA = ROOT / "client" / "artifact.json"
SCRIPTS = ROOT / "scripts"


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_verifier():
    path = SCRIPTS / "verify-artifact.py"
    spec = importlib.util.spec_from_file_location("agent_sidebar_artifact_verifier", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def main() -> None:
    metadata = json.loads(METADATA.read_text(encoding="utf-8"))
    check(metadata["schema_version"] == 1, "metadata schema mismatch")
    check(len(metadata["artifact"]["zip_sha256"]) == 64, "ZIP digest missing")
    check(len(metadata["artifact"]["members"]) == 5, "artifact member contract changed")
    check(
        metadata["source"]["follow_up_patch_sha256"]
        == "c37a97f87857bdcb2f9f877e27917774ef0f614718adf74e5b316f15716fc525",
        "Agent sidebar patch digest changed",
    )
    check(metadata["client"]["asset_count"] == 10, "protected asset count changed")

    deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    apply = (SCRIPTS / "remote-apply.sh").read_text(encoding="utf-8")
    rollback = (SCRIPTS / "remote-rollback.sh").read_text(encoding="utf-8")
    transport = (SCRIPTS / "ssh-transport.sh").read_text(encoding="utf-8")
    collect = (SCRIPTS / "collect-preflight.sh").read_text(encoding="utf-8")
    preflight = (SCRIPTS / "remote-preflight.py").read_text(encoding="utf-8")

    check("release-governance:scoped-deployment" in deploy, "scoped marker missing")
    check("release-governance:targets=LibreChat-API" in deploy, "target marker missing")
    check("release-governance:target-lock" not in deploy, "unexpected enhanced lock marker")
    check("/app/client/dist" in apply, "Client mount contract missing")
    check("--force-recreate api" in apply and "--force-recreate api" in rollback, "API-only recreate missing")
    check(
        "LibreChat-CodeAPI" in preflight and "chat-mongodb" in preflight,
        "protected services are not captured",
    )
    check(
        'baseline["containers"]' in apply and "protected container changed" in apply,
        "protected container identities are not enforced",
    )
    check("/dev/tty" not in transport, "SSH password input bypasses inherited stdin")
    check(
        'librechat-agent-sidebar-menu-runtime.XXXXXX"' in collect
        and "librechat-agent-sidebar-menu-runtime.XXXXXX." not in collect,
        "preflight temp-file template is not portable across BSD and GNU mktemp",
    )
    check("Office Converter" in (ROOT / "README.md").read_text(encoding="utf-8"), "Office boundary is undocumented")
    token_prefix = "github_" + "pat_"
    check(token_prefix not in "\n".join((deploy, apply, rollback, transport)), "credential leaked into scripts")

    for shell_script in (deploy, apply, rollback, transport):
        for line in shell_script.splitlines():
            if "docker compose" in line and "up -d" in line:
                check("api" in line, f"non-API Compose recreate found: {line}")

    for script in (SCRIPTS / "ssh-transport.sh", SCRIPTS / "collect-preflight.sh", SCRIPTS / "deploy.sh", SCRIPTS / "remote-apply.sh", SCRIPTS / "remote-rollback.sh"):
        subprocess.run(["bash", "-n", str(script)], check=True)
    for script in (SCRIPTS / "verify-artifact.py", SCRIPTS / "remote-preflight.py", SCRIPTS / "test-release.py"):
        compile(script.read_text(encoding="utf-8"), str(script), "exec")

    if len(sys.argv) == 2:
        artifact = Path(sys.argv[1]).resolve()
        result = load_verifier().verify(artifact, METADATA)
        check(result["status"] == "passed", "Client artifact verification failed")
        print(json.dumps(result, sort_keys=True))
    else:
        print("artifact_verification=deferred (pass the downloaded CI ZIP as argv[1])")
    print("agent_sidebar_menu_state_release_contract=passed")


if __name__ == "__main__":
    main()
