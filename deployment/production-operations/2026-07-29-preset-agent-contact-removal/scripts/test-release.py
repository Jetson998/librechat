#!/usr/bin/env python3

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
OPERATION = ROOT / "deployment/production-operations/2026-07-29-preset-agent-contact-removal"
SCRIPTS = OPERATION / "scripts"
TEMPLATES = ROOT / "workflow-templates/preset-agents"
SHARED = ROOT / "deployment/production-operations/2026-07-29-preset-workflow-agents/scripts"
COMPILED = TEMPLATES / "compiled-agents.json"
EXPECTED_IDS = {
    "workflow_meeting-to-action",
    "workflow_knowledge-base-curator",
    "workflow_excel-audit-reconciliation",
    "workflow_policy-change-impact",
    "workflow_feedback-root-cause-analysis",
    "workflow_kyc-periodic-review",
    "workflow_journal-entry-audit",
}
FORBIDDEN = [
    re.compile(pattern, re.I)
    for pattern in [
        r"github_pat_",
        r"BEGIN [A-Z ]*PRIVATE KEY",
        r"api[_-]?key\s*[:=]\s*['\"][A-Za-z0-9_-]{12,}",
        r"password\s*[:=]\s*['\"][^$'\"\r\n]{8,}",
        r"cookie\s*[:=]\s*['\"][^$'\"\r\n]{8,}",
        r"/srv/codeapi-data",
        r"sess_[a-z0-9]",
    ]
]


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def run(command):
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise AssertionError(
            f"command failed: {' '.join(command)}\n{result.stdout}\n{result.stderr}"
        )
    return result.stdout


def test_compiled_catalog():
    catalog = json.loads(COMPILED.read_text(encoding="utf-8"))
    payload = {key: value for key, value in catalog.items() if key != "compiledDigest"}
    assert catalog["compiledDigest"] == sha256(canonical_json(payload))
    agents = catalog["agents"]
    assert len(agents) == 7
    assert {agent["id"] for agent in agents} == EXPECTED_IDS
    assert len({starter for agent in agents for starter in agent["conversation_starters"]}) == 21
    for agent in agents:
        assert "support_contact" not in agent
        assert agent["provider"] == "anthropic"
        assert agent["model"] == "claude-fable-5"
        assert agent["category"] == "automation-workflow"
        assert agent["is_promoted"] is True
        assert "/mnt/data" in agent["instructions"]


def test_manifest_compiler_is_current():
    output = run(["node", str(TEMPLATES / "scripts/compile.mjs"), "--check"])
    assert "7 manifests" in output


def test_contact_update_fixture():
    output = run(["node", str(SCRIPTS / "test-contact-update.mjs")])
    assert "7 updated, 7 unchanged, exact rollback" in output


def test_script_syntax_and_scope():
    for name in [
        "collect-preflight.sh",
        "deploy.sh",
        "rollback.sh",
    ]:
        run(["bash", "-n", str(SCRIPTS / name)])
    for name in [
        "remote-preflight.py",
        "remote-apply.py",
        "remote-rollback.py",
        "normalize-preflight.py",
    ]:
        ast.parse((SCRIPTS / name).read_text(encoding="utf-8"), filename=str(SCRIPTS / name))
    for name in [
        "remove-support-contact.js",
        "rollback-agents.js",
        "snapshot-targets.js",
        "test-contact-update.mjs",
    ]:
        run(["node", "--check", str(SCRIPTS / name)])

    update = (SCRIPTS / "remove-support-contact.js").read_text(encoding="utf-8")
    rollback = (SCRIPTS / "rollback-agents.js").read_text(encoding="utf-8")
    combined = update + rollback
    assert "MANAGED_BY" in combined
    assert "support_contact" in update
    assert "$unset: { support_contact: '' }" in update
    assert "writes: ['agents']" in update
    assert "writes: ['agents']" in rollback
    assert "db.aclentries" not in combined
    assert "db.agentcategories" not in combined
    assert "db.users" not in combined
    assert "db.skills" not in combined
    assert "db.files" not in combined
    assert "db.messages" not in combined
    assert "dropDatabase" not in combined
    assert "deleteMany" not in combined

    deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    assert "release-governance:scoped-deployment" in deploy
    assert "release-governance:targets=chat-mongodb" in deploy
    assert "release-governance:target-lock" in deploy
    assert "docker compose up" not in deploy
    assert "docker restart" not in deploy


def test_preflight_normalizer_contract():
    source_revision = "c" * 40
    release_plan_sha256 = "a" * 64
    artifact_sha256 = "b" * 64
    raw = {
        "schema_version": 1,
        "status": "passed",
        "source_revision": source_revision,
        "catalog": {"compiled_digest": "d" * 64, "agent_count": 7},
        "data_snapshot_sha256": "e" * 64,
        "data_snapshot": {},
        "containers": {
            "LibreChat-API": {"status": "running"},
            "chat-mongodb": {"status": "running"},
        },
        "host_resources": {"memoryAvailableMb": 2048, "diskFreeMb": 16384},
        "public_checks": {"mainRoot": {"status": 200}},
        "write_operations": [],
    }
    with tempfile.TemporaryDirectory() as directory:
        raw_path = Path(directory) / "raw.json"
        output_path = Path(directory) / "normalized.json"
        raw_path.write_text(json.dumps(raw), encoding="utf-8")
        run(
            [
                "python3",
                str(SCRIPTS / "normalize-preflight.py"),
                str(raw_path),
                str(output_path),
                source_revision,
                release_plan_sha256,
                artifact_sha256,
            ]
        )
        normalized = json.loads(output_path.read_text(encoding="utf-8"))
        assert normalized["release_plan_sha256"] == release_plan_sha256
        assert normalized["artifact_sha256"] == artifact_sha256
        assert normalized["checked_services"] == ["LibreChat-API", "chat-mongodb"]
        assert normalized["rollback_available"] is True
        assert normalized["backup_reference"]["source_snapshot_sha256"] == "e" * 64


def test_shared_runtime_contract():
    for name in ["runtime_common.py", "ssh-transport.sh"]:
        assert (SHARED / name).is_file(), f"shared release component is missing: {name}"
    assert "runtime_common.py" in (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    assert "ssh-transport.sh" in (SCRIPTS / "collect-preflight.sh").read_text(encoding="utf-8")


def test_no_embedded_secrets():
    paths = [path for path in OPERATION.rglob("*") if path.is_file() and path.name != "test-release.py"]
    paths.extend(path for path in TEMPLATES.rglob("*") if path.is_file())
    for path in paths:
        text = path.read_text(encoding="utf-8")
        for pattern in FORBIDDEN:
            assert not pattern.search(text), f"{path} matches forbidden pattern {pattern.pattern}"


def test_executable_entrypoints():
    for path in [
        TEMPLATES / "scripts/compile.mjs",
        SCRIPTS / "collect-preflight.sh",
        SCRIPTS / "deploy.sh",
        SCRIPTS / "rollback.sh",
        SCRIPTS / "normalize-preflight.py",
        SCRIPTS / "remote-preflight.py",
        SCRIPTS / "remote-apply.py",
        SCRIPTS / "remote-rollback.py",
    ]:
        assert os.access(path, os.X_OK), f"{path} is not executable"


def main():
    tests = [
        test_compiled_catalog,
        test_manifest_compiler_is_current,
        test_contact_update_fixture,
        test_script_syntax_and_scope,
        test_preflight_normalizer_contract,
        test_shared_runtime_contract,
        test_no_embedded_secrets,
        test_executable_entrypoints,
    ]
    for test in tests:
        test()
    print(f"preset Agent contact removal tests passed ({len(tests)} groups)")


if __name__ == "__main__":
    main()
