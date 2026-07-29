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
OPERATION = ROOT / "deployment/production-operations/2026-07-29-preset-workflow-agents"
SCRIPTS = OPERATION / "scripts"
TEMPLATES = ROOT / "workflow-templates/preset-agents"
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
ALLOWED_TOOLS = {"execute_code", "file_search", "web_search"}
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
    assert catalog["category"] == {
        "value": "automation-workflow",
        "label": "自动化工作流",
        "description": "使用文件、代码、检索和 Office 能力完成可交付任务",
        "order": 0,
    }
    assert set(catalog["defaultCategoriesToDisable"]) == {
        "general",
        "hr",
        "rd",
        "finance",
        "it",
        "sales",
        "aftersales",
    }
    agents = catalog["agents"]
    assert len(agents) == 7
    assert {agent["id"] for agent in agents} == EXPECTED_IDS
    assert len({agent["name"] for agent in agents}) == 7
    assert len({starter for agent in agents for starter in agent["conversation_starters"]}) == 21
    for agent in agents:
        assert agent["provider"] == "anthropic"
        assert agent["model"] == "claude-fable-5"
        assert agent["category"] == "automation-workflow"
        assert agent["is_promoted"] is True
        assert 1 <= len(agent["tools"]) <= 3
        assert set(agent["tools"]).issubset(ALLOWED_TOOLS)
        source = {key: value for key, value in agent.items() if key != "agentDigest"}
        assert agent["agentDigest"] == sha256(canonical_json(source))
        assert "/mnt/data" in agent["instructions"]
        assert "当前对话" in agent["instructions"]
        assert len(agent["acceptanceFixtures"]) >= 1


def test_manifest_compiler_is_current():
    output = run(["node", str(TEMPLATES / "scripts/compile.mjs"), "--check"])
    assert "7 manifests" in output


def test_script_syntax_and_modes():
    shell_scripts = [
        "collect-preflight.sh",
        "deploy.sh",
        "rollback.sh",
        "ssh-transport.sh",
    ]
    for name in shell_scripts:
        path = SCRIPTS / name
        run(["bash", "-n", str(path)])
    for name in ["snapshot-targets.js", "seed-agents.js", "rollback-agents.js"]:
        run(["node", "--check", str(SCRIPTS / name)])
    for path in SCRIPTS.glob("*.py"):
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    deploy_text = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    assert "release-governance:scoped-deployment" in deploy_text
    assert "release-governance:targets=chat-mongodb" in deploy_text
    assert "release-governance:target-lock" in deploy_text
    assert "docker compose up" not in deploy_text
    assert "docker restart" not in deploy_text


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
        assert {item["id"] for item in normalized["checks"]} == {
            "data-backup",
            "dependency-interface",
            "host-disk",
            "host-memory",
            "rollback-available",
            "service-state",
        }
        assert normalized["host_resources"] == {
            "memory_available_mb": 2048,
            "disk_free_mb": 16384,
        }
        assert normalized["rollback_available"] is True
        assert normalized["backup_reference"]["source_snapshot_sha256"] == "e" * 64

        raw["write_operations"] = ["unexpected-write"]
        raw_path.write_text(json.dumps(raw), encoding="utf-8")
        failed = subprocess.run(
            [
                "python3",
                str(SCRIPTS / "normalize-preflight.py"),
                str(raw_path),
                str(output_path),
                source_revision,
                release_plan_sha256,
                artifact_sha256,
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        assert failed.returncode != 0


def test_data_scope_is_targeted():
    seed = (SCRIPTS / "seed-agents.js").read_text(encoding="utf-8")
    rollback = (SCRIPTS / "rollback-agents.js").read_text(encoding="utf-8")
    snapshot = (SCRIPTS / "snapshot-targets.js").read_text(encoding="utf-8")
    combined = seed + rollback + snapshot
    for collection in ["agents", "aclentries", "agentcategories", "users", "accessroles"]:
        assert f"db.{collection}" in combined
    for forbidden_collection in ["files", "messages", "conversations", "skills", "transactions"]:
        assert f"db.{forbidden_collection}" not in combined
    assert "deleteMany({})" not in combined
    assert "dropDatabase" not in combined
    assert "drop()" not in combined
    assert "defaultCategoriesToDisable" in seed
    assert "custom: { $ne: true }" in seed
    assert "id: { $in: targetAgentIds }" in rollback


def test_no_embedded_secrets():
    paths = [
        path
        for path in OPERATION.rglob("*")
        if path.is_file() and path.name != "test-release.py"
    ]
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
        test_script_syntax_and_modes,
        test_preflight_normalizer_contract,
        test_data_scope_is_targeted,
        test_no_embedded_secrets,
        test_executable_entrypoints,
    ]
    for test in tests:
        test()
    print(f"preset workflow Agent release tests passed ({len(tests)} groups)")


if __name__ == "__main__":
    main()
