#!/usr/bin/env python3

from pathlib import Path
import os
import re
import subprocess
import tempfile

import yaml


ROOT = Path(__file__).resolve().parents[1]


class StrictLoader(yaml.SafeLoader):
    pass


def construct_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise AssertionError(f"duplicate YAML key: {key}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    construct_mapping,
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read(relative_path):
    return (ROOT / relative_path).read_text(encoding="utf-8")


def load_yaml(path):
    return yaml.load(path.read_text(encoding="utf-8"), Loader=StrictLoader)


def main():
    merge_script = ROOT / "scripts" / "merge-config.cjs"
    deploy_script = ROOT / "scripts" / "deploy.sh"
    runner_script = ROOT / "scripts" / "run-remote-release.sh"
    transport_script = ROOT / "scripts" / "deploy-remote.exp"

    fixture = """version: 1.2.8
endpoints:
  custom:
    - name: MuskAPI
modelSpecs:
  enforce: false
  prioritize: true
  list:
    - name: \"gpt-5.6-sol\"
      label: \"GPT-5.6 SOL\"
      skills: true
      executeCode: true
      preset:
        endpoint: MuskAPI
        model: gpt-5.6-sol
        promptPrefix: |
          keep this prompt unchanged
    - name: \"claude-fable-5\"
      label: \"Fable 5\"
      preset:
        endpoint: anthropic
        model: claude-fable-5
fileConfig:
  serverFileSizeLimit: 100
"""

    with tempfile.TemporaryDirectory() as temp_dir:
        temp = Path(temp_dir)
        source = temp / "source.yaml"
        merged = temp / "merged.yaml"
        merged_twice = temp / "merged-twice.yaml"
        source.write_text(fixture, encoding="utf-8")

        env = dict(os.environ)
        env["SKIP_YAML_VALIDATION"] = "1"
        subprocess.run(
            ["node", str(merge_script), str(source), str(merged)],
            check=True,
            env=env,
        )
        subprocess.run(
            ["node", str(merge_script), str(merged), str(merged_twice)],
            check=True,
            env=env,
        )

        require(merged.read_bytes() == merged_twice.read_bytes(), "merge is not idempotent")
        config = load_yaml(merged)
        require(
            config["webSearch"]
            == {
                "searchProvider": "serper",
                "scraperProvider": "serper",
                "serperApiKey": "${SERPER_API_KEY}",
            },
            "global Serper config mismatch",
        )
        specs = config["modelSpecs"]["list"]
        by_name = {item["name"]: item for item in specs}
        require(by_name["gpt-5.6-sol"].get("webSearch") is True, "GPT webSearch missing")
        require("webSearch" not in by_name["claude-fable-5"], "Fable spec was changed")
        require(
            by_name["gpt-5.6-sol"]["preset"]["promptPrefix"]
            == "keep this prompt unchanged\n",
            "GPT prompt changed",
        )

    for script in (deploy_script, runner_script):
        subprocess.run(["bash", "-n", str(script)], check=True)
    subprocess.run(["node", "--check", str(merge_script)], check=True)

    deploy = deploy_script.read_text(encoding="utf-8")
    for marker in (
        "SERPER_API_KEY",
        "docker compose up -d --force-recreate api",
        "overrides.webSearch",
        "config-doc.ejson",
        "serper_search_probe=ok",
        "serper_scrape_probe=ok",
        "PREFLIGHT_ONLY",
        "rollback",
        "LibreChat-CodeAPI",
        "LibreChat-NGINX",
        "joint_override_count",
        "admin_model_state",
        "admin_override_preserved_sha_before",
        '"overrides.modelSpecs.list.$[target].webSearch": true',
        'arrayFilters: [{"target.name": "gpt-5.6-sol"}]',
        "admin_override_preserved_sha_after",
        "expected_office_skill_sha",
        "[deploymentSkills] Loaded",
        "/office/",
    ):
        require(marker in deploy, f"deployment guard missing: {marker}")
    require(
        'test "$model_override_count" = "1"' in deploy,
        "Admin model override preflight must require exactly one document",
    )
    require(
        'test "$admin_override_preserved_sha_after" = '
        '"$admin_override_preserved_sha_before"' in deploy,
        "Admin override preservation hash check missing",
    )
    require(
        'test "$model_override_count" = "0"' not in deploy,
        "stale zero-model-override assumption remains",
    )

    transport = transport_script.read_text(encoding="utf-8")
    require("SSH_PASS" in transport, "SSH password transport missing")
    require("RELEASE_COMMIT" in transport, "release commit guard missing")
    require("local HEAD does not match RELEASE_COMMIT" in transport, "HEAD guard missing")
    require(
        "rev-parse HEAD 2>@stderr" in transport,
        "PTY-safe git stderr redirect missing",
    )

    runner = runner_script.read_text(encoding="utf-8")
    require(
        runner.count('bash "$release_dir/scripts/deploy.sh"') == 2,
        "remote runner must invoke both deploy phases through bash",
    )
    require(
        re.search(
            r'(?m)^(?:PREFLIGHT_ONLY=true )?"\$release_dir/scripts/deploy\.sh"',
            runner,
        )
        is None,
        "remote runner still depends on the deploy script executable bit",
    )

    combined = "\n".join(
        path.read_text(encoding="utf-8")
        for path in ROOT.rglob("*")
        if path.is_file()
    )
    secret_patterns = (
        r"github_pat_[A-Za-z0-9_]+",
        r"sk-[A-Za-z0-9_-]{12,}",
        r"SERPER_API_KEY=[A-Za-z0-9_-]{16,}",
        r"BEGIN (?:RSA|OPENSSH|PRIVATE) KEY",
    )
    for pattern in secret_patterns:
        require(re.search(pattern, combined, re.IGNORECASE) is None, f"possible secret: {pattern}")

    readme = read("README.md")
    require("Production Result" in readme, "production result section missing")
    require("Rollback" in readme, "rollback section missing")

    print("global_serper_web_search_release: ok")


if __name__ == "__main__":
    main()
