#!/usr/bin/env python3

from pathlib import Path
import sys
import yaml


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    baseline_path = REPO / "deployment/production-patches/2026-07-11-admin-panel/librechat.yaml"
    config = yaml.safe_load(baseline_path.read_text(encoding="utf-8"))
    endpoint = next(item for item in config["endpoints"]["custom"] if item["name"] == "MuskAPI")
    require(endpoint["titleConvo"] is True, "title generation disabled")
    require(endpoint["titleEndpoint"] == "MuskAPI", "title endpoint mismatch")
    require(endpoint["titleModel"] == "gpt-5.6-sol", "title model mismatch")
    require(endpoint["titleMessageRole"] == "user", "title role mismatch")
    require("只输出标题本身" in endpoint["titlePrompt"], "title prompt incomplete")
    require("titlePromptTemplate" not in endpoint, "title prompt template must remain unset")

    deploy = (ROOT / "scripts/deploy-title-config.sh").read_text(encoding="utf-8")
    for marker in (
        "codexConfigBackups",
        "titleEndpoint = expectedEndpoint",
        "titleModel = expectedModel",
        "delete endpoint.titlePromptTemplate",
        "configVersion",
        "rollback",
        "PREFLIGHT_ONLY",
        "docker restart LibreChat-API",
        "/api/config",
    ):
        require(marker in deploy, f"deployment guard missing: {marker}")
    print("title_config_release: ok")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"title_config_release: failed: {error}", file=sys.stderr)
        raise
