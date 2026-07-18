#!/usr/bin/env python3

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import yaml


ROOT = Path(__file__).resolve().parents[1]
MERGE_SCRIPT = ROOT / "scripts" / "merge-config.cjs"
MONGO_SCRIPT = ROOT / "scripts" / "mongo-config.js"
CONTRACT_FILE = ROOT / "config" / "large-file-batch-contract.txt"
DEPLOY_SCRIPT = ROOT / "scripts" / "deploy.sh"
REMOTE_RUNNER = ROOT / "scripts" / "run-remote-release.sh"
REMOTE_TRANSPORT = ROOT / "scripts" / "deploy-remote.exp"
MARKER_START = "[CONTEXT_SAFETY_BATCH_V1]"
MARKER_END = "[/CONTEXT_SAFETY_BATCH_V1]"


def run(*args, env=None):
    subprocess.run(args, check=True, env=env)


def fixture_yaml():
    return """version: 1.2.8
cache: true
endpoints:
  agents:
    allowedProviders:
      - anthropic
      - MuskAPI
    capabilities:
      - deferred_tools
      - execute_code
  anthropic:
    titleModel: claude-fable-5
modelSpecs:
  enforce: false
  prioritize: true
  list:
    - name: gpt-5.6-sol
      label: GPT-5.6 SOL
      preset:
        endpoint: MuskAPI
        model: gpt-5.6-sol
        promptPrefix: |
          Existing GPT instructions.
    - name: claude-fable-5
      label: Fable 5
      preset:
        endpoint: anthropic
        model: claude-fable-5
        promptPrefix: |
          Existing Claude instructions.
fileConfig:
  serverFileSizeLimit: 100
"""


def test_merge():
    env = dict(os.environ)
    env["SKIP_YAML_VALIDATION"] = "1"
    with tempfile.TemporaryDirectory() as temp_dir:
        temp = Path(temp_dir)
        source = temp / "source.yaml"
        once = temp / "once.yaml"
        twice = temp / "twice.yaml"
        source.write_text(fixture_yaml(), encoding="utf-8")
        run("node", str(MERGE_SCRIPT), str(source), str(once), str(CONTRACT_FILE), env=env)
        run("node", str(MERGE_SCRIPT), str(once), str(twice), str(CONTRACT_FILE), env=env)
        assert once.read_bytes() == twice.read_bytes()
        before = yaml.safe_load(source.read_text(encoding="utf-8"))
        after = yaml.safe_load(once.read_text(encoding="utf-8"))
        agents = after["endpoints"]["agents"]
        assert agents["maxToolResultChars"] == 32000
        assert agents["recursionLimit"] == 50
        assert agents["maxRecursionLimit"] == 50
        assert agents["allowedProviders"] == before["endpoints"]["agents"]["allowedProviders"]
        assert agents["capabilities"] == before["endpoints"]["agents"]["capabilities"]
        assert after["fileConfig"] == before["fileConfig"]
        for name in ("gpt-5.6-sol", "claude-fable-5"):
            spec = next(item for item in after["modelSpecs"]["list"] if item["name"] == name)
            prompt = spec["preset"]["promptPrefix"]
            assert prompt.count(MARKER_START) == 1
            assert prompt.count(MARKER_END) == 1
            assert "stdout 主动控制在 8000 字符以内" in prompt


def test_mongo_contract():
    contract = CONTRACT_FILE.read_text(encoding="utf-8").strip()
    fixture = {
        "principalType": "role",
        "principalId": "__base__",
        "isActive": True,
        "configVersion": 31,
        "overrides": {
            "endpoints": {
                "agents": {
                    "allowedProviders": ["anthropic", "MuskAPI"],
                    "capabilities": ["execute_code", "skills"],
                }
            },
            "modelSpecs": {
                "prioritize": True,
                "list": [
                    {
                        "name": "gpt-5.6-sol",
                        "preset": {"promptPrefix": "Existing GPT instructions."},
                    },
                    {
                        "name": "claude-fable-5",
                        "preset": {"promptPrefix": "Existing Claude instructions."},
                    },
                ],
            },
            "unrelated": {"keep": "unchanged"},
        },
    }
    node_program = r"""
const fs = require('node:fs');
const contract = require(process.argv[1]);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const before = contract.stripTargetedFields(input);
const once = contract.applyContractToDocument(input);
contract.assertConfigured(once);
const twice = contract.applyContractToDocument(once);
contract.assertConfigured(twice);
const after = contract.stripTargetedFields(twice);
process.stdout.write(JSON.stringify({
  contractText: contract.CONTRACT_TEXT,
  before,
  once,
  twice,
  after,
}));
"""
    result = subprocess.run(
        ["node", "-e", node_program, str(MONGO_SCRIPT)],
        input=json.dumps(fixture, ensure_ascii=False),
        text=True,
        check=True,
        capture_output=True,
    )
    data = json.loads(result.stdout)
    assert data["contractText"] == contract
    assert data["once"] == data["twice"]
    assert data["before"] == data["after"]
    assert data["once"]["overrides"]["unrelated"] == {"keep": "unchanged"}


def test_release_contract():
    contract = CONTRACT_FILE.read_text(encoding="utf-8")
    required = (
        "stdout 主动控制在 8000 字符以内",
        "manifest.json",
        "errors.json",
        "openpyxl",
        "检测到较大文件，将分块处理",
        "不得向用户显示 stdout、maxToolResultChars、LangGraph",
    )
    missing = [value for value in required if value not in contract]
    assert not missing, missing
    assert contract.count(MARKER_START) == 1
    assert contract.count(MARKER_END) == 1
    assert len(contract) < 3000

    for path in (MERGE_SCRIPT, MONGO_SCRIPT):
        run("node", "--check", str(path))

    for path in (DEPLOY_SCRIPT, REMOTE_RUNNER, REMOTE_TRANSPORT):
        assert path.is_file(), path

    deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    deploy_contract = deploy + "\n" + MONGO_SCRIPT.read_text(encoding="utf-8")
    for value in (
        "--no-deps --force-recreate api",
        "maxToolResultChars",
        "maxRecursionLimit",
        "codexConfigBackups",
        "protected_containers_unchanged=true",
        "office_skill_sha",
    ):
        assert value in deploy_contract, value

    remote_runner = REMOTE_RUNNER.read_text(encoding="utf-8")
    remote_transport = REMOTE_TRANSPORT.read_text(encoding="utf-8")
    assert "CONTEXT_SAFETY_PREFLIGHT_ONLY" in remote_runner
    assert "remote_preflight_only=ok" in remote_runner
    assert "CONTEXT_SAFETY_PREFLIGHT_ONLY" in remote_transport

    release_text = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in ROOT.rglob("*")
        if path.is_file()
    )
    secret_patterns = (
        r"github_pat_[A-Za-z0-9_]+",
        r"sk-[A-Za-z0-9]{20,}",
        r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----",
    )
    for pattern in secret_patterns:
        assert re.search(pattern, release_text) is None, pattern


def main():
    test_merge()
    test_mongo_contract()
    test_release_contract()
    print("context_safety_release: ok")


if __name__ == "__main__":
    main()
