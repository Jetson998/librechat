#!/usr/bin/env python3
"""Contracts for the bounded Agent category de-dup count Client release."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
METADATA = ROOT / "client" / "artifact.json"
SCRIPTS = ROOT / "scripts"
EXPECTED_HIDDEN_IDS = [
    "agent_workflow_meeting-to-action",
    "agent_workflow_knowledge-base-curator",
    "agent_workflow_excel-audit-reconciliation",
    "agent_workflow_policy-change-impact",
    "agent_workflow_feedback-root-cause-analysis",
    "agent_workflow_kyc-periodic-review",
    "agent_workflow_journal-entry-audit",
]


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_verifier():
    path = SCRIPTS / "verify-artifact.py"
    spec = importlib.util.spec_from_file_location("agent_category_dedup_count_fix_verifier", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def main() -> None:
    metadata = json.loads(METADATA.read_text(encoding="utf-8"))
    check(metadata["schema_version"] == 1, "metadata schema mismatch")
    check(
        metadata["component"] == "agent-category-dedup-count-fix-client",
        "component identity mismatch",
    )
    check(
        metadata["artifact"]["origin"] == "independent-build",
        "artifact origin changed",
    )
    check(len(metadata["artifact"]["zip_sha256"]) == 64, "ZIP digest missing")
    check(len(metadata["artifact"]["members"]) == 8, "artifact member contract changed")
    check(
        metadata["source"]["base_patch_sha256"]
        == "00fc078859275611b717e34bd3a0fda4c44d08db1412b6df9e8735d27d0777bc",
        "Agent P0 UI patch digest changed",
    )
    check(
        metadata["source"]["sidebar_patch_sha256"]
        == "c37a97f87857bdcb2f9f877e27917774ef0f614718adf74e5b316f15716fc525",
        "Agent sidebar patch digest changed",
    )
    check(
        metadata["source"]["contact_patch_sha256"]
        == "6699946b4662daec1005403aadc42a96d55ba27e70436ba8b74d148bc5c6f5d8",
        "preset Agent contact patch digest changed",
    )
    check(
        metadata["source"]["terminology_patch_sha256"]
        == "8038176a51b2e98b4730ee639a43cabcfade18c45396b6c4ebeb961cc7736dfe",
        "Agent guidance terminology patch digest changed",
    )
    check(
        metadata["source"]["runtime_category_patch_sha256"]
        == "f3ea605fc928318f8b1b56ad4f3cb480adad8cf733be5b56ee8ad5f1fd819ee9",
        "Agent category count patch digest changed",
    )
    check(
        metadata["client"]["hidden_contact_agent_ids"] == EXPECTED_HIDDEN_IDS,
        "hidden preset Agent ID list changed",
    )
    check(metadata["client"]["asset_count"] == 10, "protected asset count changed")
    check(
        metadata["build_provenance"]["build_environment"] == "independent-build",
        "independent-build provenance missing",
    )
    check(metadata["build_provenance"]["production_host"] is False, "build ran on production")
    check(
        metadata["build_provenance"]["source_revision"]
        == metadata["source"]["repository_commit"],
        "independent-build source revision mismatch",
    )

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
    check("agent-category-dedup-count-fix" in apply, "versioned Client destination missing")
    check(
        "--force-recreate api" in apply and "--force-recreate api" in rollback,
        "API-only recreate missing",
    )
    check("chat-mongodb" in preflight, "MongoDB identity is not protected")
    check(
        'baseline["containers"]' in apply and "protected container changed" in apply,
        "protected container identities are not enforced",
    )
    check(
        'read -r -s LIBRECHAT_SSH_PASSWORD </dev/tty' in transport,
        "SSH password input must use the interactive control terminal",
    )
    check(
        "requires key authentication or an interactive control terminal" in transport,
        "non-interactive SSH failure is not explicit",
    )
    check(
        'librechat-agent-category-dedup-count-fix-runtime.XXXXXX"' in collect
        and "librechat-agent-category-dedup-count-fix-runtime.XXXXXX." not in collect,
        "preflight temp-file template is not portable",
    )
    check("Office Converter" in (ROOT / "README.md").read_text(encoding="utf-8"), "Office boundary is undocumented")
    check("support_contact" not in apply, "release must not mutate Agent contact data")
    check("mongosh" not in apply, "release must not execute MongoDB writes")
    check("migrate.js" not in deploy and "migration" not in apply.lower(), "Mongo migration must not be repeated")
    token_prefix = "github_" + "pat_"
    check(token_prefix not in "\n".join((deploy, apply, rollback, transport)), "credential leaked into scripts")

    for shell_script in (deploy, apply, rollback, transport):
        for line in shell_script.splitlines():
            if "docker compose" in line and "up -d" in line:
                check("api" in line, f"non-API Compose recreate found: {line}")

    for script in (
        SCRIPTS / "ssh-transport.sh",
        SCRIPTS / "collect-preflight.sh",
        SCRIPTS / "deploy.sh",
        SCRIPTS / "remote-apply.sh",
        SCRIPTS / "remote-rollback.sh",
    ):
        subprocess.run(["bash", "-n", str(script)], check=True)
    for script in (
        SCRIPTS / "verify-artifact.py",
        SCRIPTS / "remote-preflight.py",
        SCRIPTS / "test-release.py",
    ):
        compile(script.read_text(encoding="utf-8"), str(script), "exec")

    if len(sys.argv) == 2:
        artifact = Path(sys.argv[1]).resolve()
        result = load_verifier().verify(artifact, METADATA)
        check(result["status"] == "passed", "Client artifact verification failed")
        check(
            result["hidden_contact_agent_ids"] == EXPECTED_HIDDEN_IDS,
            "verified hidden Agent IDs changed",
        )
        print(json.dumps(result, sort_keys=True))
    else:
        print("artifact_verification=deferred (pass the release ZIP as argv[1])")
    print("agent_category_dedup_count_fix_release_contract=passed")


if __name__ == "__main__":
    main()
