#!/usr/bin/env python3

from pathlib import Path
import re
import sys

import yaml


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "librechat.yaml"


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


def main():
    raw = CONFIG_PATH.read_text(encoding="utf-8")
    config = yaml.load(raw, Loader=StrictLoader)

    endpoints = config["endpoints"]
    allowed = endpoints["agents"]["allowedProviders"]
    require(allowed == ["anthropic", "MuskAPI"], "unexpected agent provider allowlist")

    custom = [item for item in endpoints.get("custom", []) if item.get("name") == "MuskAPI"]
    require(len(custom) == 1, "MuskAPI custom endpoint must exist exactly once")
    muskapi = custom[0]
    require(muskapi["apiKey"] == "${ANTHROPIC_API_KEY}", "relay key must remain an env placeholder")
    require(muskapi["baseURL"] == "https://api.muskapis.com/v1", "unexpected relay base URL")
    require(muskapi["models"]["default"] == ["gpt-5.6-sol"], "unexpected GPT model allowlist")
    require(muskapi["models"]["fetch"] is False, "model discovery must remain deterministic")
    require(muskapi["addParams"] == {"reasoning_effort": "max"}, "GPT max reasoning is not enforced")
    require(
        muskapi["customParams"]
        == {"defaultParamsEndpoint": "openAI", "reasoningFormat": "reasoning_effort"},
        "unexpected OpenAI-compatible parameter mapping",
    )

    specs = config["modelSpecs"]["list"]
    require([item["name"] for item in specs] == ["gpt-5.6-sol", "claude-fable-5"], "unexpected model spec order")
    defaults = [item["name"] for item in specs if item.get("default") is True]
    require(defaults == ["gpt-5.6-sol"], "GPT-5.6 SOL must be the sole default")

    by_name = {item["name"]: item for item in specs}
    gpt = by_name["gpt-5.6-sol"]
    fable = by_name["claude-fable-5"]

    require(gpt["skills"] is True and gpt["executeCode"] is True, "GPT tools must remain enabled")
    require(gpt["preset"]["endpoint"] == "MuskAPI", "GPT must use the custom relay endpoint")
    require(gpt["preset"]["model"] == "gpt-5.6-sol", "GPT preset model mismatch")
    require(fable["default"] is False, "Fable 5 must be non-default")
    require(fable["skills"] is True and fable["executeCode"] is True, "Fable tools must remain enabled")
    require(fable["preset"]["endpoint"] == "anthropic", "Fable endpoint changed unexpectedly")
    require(fable["preset"]["effort"] == "max", "Fable max effort changed unexpectedly")

    for name, spec in by_name.items():
        prompt = spec["preset"]["promptPrefix"]
        require("/mnt/data" in prompt, f"{name} is missing the current-session file boundary")
        require("/srv/codeapi-data/sessions" in prompt, f"{name} is missing the global-session prohibition")
        require("生成文件必须保存到 /mnt/data" in prompt, f"{name} is missing the artifact output rule")

    secret_patterns = (
        r"github_pat_[A-Za-z0-9_]+",
        r"sk-[A-Za-z0-9_-]{12,}",
        r"apiKey:\s*[\"']?(?!\$\{)[A-Za-z0-9_-]{16,}",
    )
    for pattern in secret_patterns:
        require(re.search(pattern, raw, re.IGNORECASE) is None, f"possible committed secret: {pattern}")

    print("gpt56_sol_default_config: ok")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"gpt56_sol_default_config: failed: {error}", file=sys.stderr)
        raise
