#!/usr/bin/env python3

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT.parents[1]
API = REPO / "deployment/production-patches/2026-07-17-admin-user-creation/api-patch/api-index.cjs"
ADMIN = REPO / "deployment/production-patches/2026-07-11-admin-panel-zh-cn/source/src/server/config.ts"

api = API.read_text(encoding="utf-8")
admin = ADMIN.read_text(encoding="utf-8")
deploy = (Path(__file__).resolve().parent / "deploy.sh").read_text(encoding="utf-8")

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
for marker in (
    "90a03305d3f1706f1363e33b7a7368fe9dc69a11cb31858c1535a571669aa1ec",
    "2cc88bec7011b3d063f5528171d98835ab295e4fefc679bd2e4963fa5e66ee20",
    "force-recreate api admin-panel",
    "config_version_unchanged_during_deploy=true",
):
    assert marker in deploy, f"missing deployment marker: {marker}"
print("model pricing dotted-key release checks: ok")
