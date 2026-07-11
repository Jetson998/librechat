#!/usr/bin/env python3

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    plan = (REPO / "docs/MODEL_SENDER_LABEL_PLAN.md").read_text(encoding="utf-8")
    baseline = (
        REPO
        / "deployment/production-patches/2026-07-11-admin-panel/librechat.yaml"
    ).read_text(encoding="utf-8")
    deploy = (ROOT / "scripts/deploy-model-sender-label.sh").read_text(encoding="utf-8")

    require('modelLabel: "GPT-5.6-SOL"' in baseline, "baseline modelLabel missing")
    require("Do not patch `getResponseSender`" in plan, "source-patch boundary missing")
    for marker in (
        "codexConfigBackups",
        "principalId: '__base__'",
        "spec.preset.modelLabel = expectedLabel",
        "endpoint.modelDisplayLabel = expectedLabel",
        "configVersion",
        "rollback",
        "PREFLIGHT_ONLY",
        "docker restart LibreChat-API",
        "/api/config",
    ):
        require(marker in deploy, f"deployment guard missing: {marker}")

    print("model_sender_label_release: ok")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"model_sender_label_release: failed: {error}", file=sys.stderr)
        raise
