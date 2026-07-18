#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[2]
CANONICAL_YAML = REPO_ROOT / "deployment/production-patches/2026-07-11-admin-panel/librechat.yaml"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> None:
    yaml = CANONICAL_YAML.read_text(encoding="utf-8")
    script = (ROOT / "scripts/deploy.sh").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    for marker in (
        'name: "MuskAPI-Anthropic"',
        'provider: "anthropic"',
        'baseURL: "https://api.muskapis.com"',
        'model: "claude-fable-5"',
        'endpoint: "MuskAPI-Anthropic"',
    ):
        require(marker in yaml, f"canonical YAML marker missing: {marker}")
    require('endpoint: "anthropic"' not in yaml, "Fable spec still points to native anthropic")
    require("MuskAPI-Anthropic" in script, "deployment target endpoint missing")
    require("codexConfigBackups" in script, "deployment backup is missing")
    require('docker restart "$api_container"' in script, "API reload is missing")
    require("MuskAPI-Anthropic" in readme, "release documentation is incomplete")
    print("fable_custom_endpoint_release: ok")


if __name__ == "__main__":
    main()
