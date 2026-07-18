#!/usr/bin/env python3

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT.parents[1]
API = REPO / "deployment/production-patches/2026-07-17-admin-user-creation/api-patch/api-index.cjs"
ADMIN = REPO / "deployment/production-patches/2026-07-11-admin-panel-zh-cn/source/src/server/config.ts"

api = API.read_text(encoding="utf-8")
admin = ADMIN.read_text(encoding="utf-8")

for marker in (
    "CUSTOM_ENDPOINT_TOKEN_CONFIG_PATH",
    "overrides.endpoints.custom",
    "configVersion: rawConfig.configVersion",
    "$inc: { configVersion: 1 }",
    "Config changed concurrently; reload and retry",
):
    assert marker in api, f"missing API persistence marker: {marker}"

for marker in (
    "result.config?.overrides?.endpoints?.custom",
    "Model pricing was not persisted; reload and retry",
    "persisted[field] !== expected[field]",
):
    assert marker in admin, f"missing Admin verification marker: {marker}"

assert "gpt-5.6-sol" not in api, "API fix must remain model-agnostic"
print("model pricing dotted-key release checks: ok")
