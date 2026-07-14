#!/usr/bin/env python3

from pathlib import Path
import sys
import yaml


ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    endpoint = yaml.safe_load((ROOT / "title-config.yaml").read_text(encoding="utf-8"))
    require(endpoint["titleConvo"] is True, "title generation disabled")
    require(endpoint["titleEndpoint"] == "MuskAPI", "title endpoint mismatch")
    require(endpoint["titleModel"] == "gpt-5.6-sol", "title model mismatch")
    require(endpoint["titleMessageRole"] == "user", "title role mismatch")
    require("只输出标题本身" in endpoint["titlePrompt"], "title prompt incomplete")
    require("{convo}" in endpoint["titlePrompt"], "title prompt missing convo placeholder")
    require("titlePromptTemplate" not in endpoint, "title prompt template must remain unset")

    deploy = (ROOT / "scripts/deploy-title-config.sh").read_text(encoding="utf-8")
    for marker in (
        "codexConfigBackups",
        "titleEndpoint = expectedEndpoint",
        "titleModel = expectedModel",
        "titlePrompt.includes('{convo}')",
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
