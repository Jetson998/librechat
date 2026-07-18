#!/usr/bin/env python3

import os
from pathlib import Path

SCRIPT = Path(__file__).resolve()
REPO = SCRIPT.parents[4] if len(SCRIPT.parents) > 4 else None
API = Path(
    os.environ.get("API_BUNDLE")
    or (REPO / "deployment/production-patches/2026-07-17-admin-user-creation/api-patch/api-index.cjs")
)
ADMIN_SOURCE = Path(
    os.environ.get("ADMIN_PANEL_SOURCE")
    or (REPO / "deployment/production-patches/2026-07-11-admin-panel-zh-cn/source")
)
ADMIN = ADMIN_SOURCE / "src/server/config.ts"
DEPLOY = Path(os.environ.get("RELEASE_DEPLOY_SCRIPT") or (SCRIPT.parent / "deploy.sh"))

api = API.read_text(encoding="utf-8")
admin = ADMIN.read_text(encoding="utf-8")
deploy = DEPLOY.read_text(encoding="utf-8")

for marker in (
    "CUSTOM_ENDPOINT_TOKEN_CONFIG_PATH",
    'CUSTOM_ENDPOINT_TOKEN_CONFIG_MODEL_OPERATION = "setLiteralModelConfig"',
    "overrides.endpoints.custom",
    'if ("model" in tokenConfigPatch)',
    "delete tokenConfig[tokenConfigPatch.model]",
    "tokenConfig[tokenConfigPatch.model] = tokenConfigPatch.modelConfig",
    "configVersion: rawConfig.configVersion",
    "$inc: { configVersion: 1 }",
    "Config changed concurrently; reload and retry",
):
    assert marker in api, f"missing API persistence marker: {marker}"

for marker in (
    "operation: 'setLiteralModelConfig'",
    "model: data.model",
    "modelConfig: Object.keys(modelConfig).length > 0 ? modelConfig : null",
    "result.config?.overrides?.endpoints?.custom",
    "Model pricing was not persisted; reload and retry",
    "persisted[field] !== expected[field]",
):
    assert marker in admin, f"missing Admin verification marker: {marker}"

assert "gpt-5.6-sol" not in api, "API fix must remain model-agnostic"
assert "entries: [{ fieldPath, value: tokenConfig }]" not in admin, (
    "Admin must not send dotted model names as JSON object keys"
)
for marker in (
    "fbf89bd93b9721e1005209135ae550a5b224ab56057d25f85fe84ecf153db763",
    "d79ea31769617dccd5eacf8ffec61840c5d03e446108c789d15d4e823b1c4e03",
    "librechat-admin-panel-model-pricing-keyfix:29cf28804ff8",
    "force-recreate api admin-panel",
    "config_version_unchanged_during_deploy=true",
    'MIN_BUILD_HEADROOM_MB:-3584',
    'test "$min_build_headroom_mb" -ge 2500',
):
    assert marker in deploy, f"missing deployment marker: {marker}"
print("model pricing dotted-key release checks: ok")
