#!/usr/bin/env python3

from pathlib import Path

PATCH = Path(__file__).resolve().parents[1]
PATCHES = PATCH.parent
ADMIN = PATCHES / "2026-07-11-admin-panel-zh-cn"

metadata = {}
for line in (PATCH / "RELEASE.env").read_text(encoding="utf-8").splitlines():
    if not line:
        continue
    key, value = line.split("=", 1)
    metadata[key] = value

source_hash = (ADMIN / "SOURCE_TREE_SHA256").read_text(encoding="utf-8").strip()
assert metadata["SOURCE_TREE_SHA256"] == source_hash
assert metadata["CI_VERIFIED_TAG"] == f"admin-ci-{source_hash[:12]}"
assert metadata["IMAGE_REF"].endswith(f":{source_hash[:12]}")
assert metadata["IMAGE_DIGEST"].startswith("sha256:")
assert len(metadata["IMAGE_DIGEST"]) == 71
assert len(metadata["CI_VERIFIED_COMMIT"]) == 40

page = (ADMIN / "source/src/components/pricing/ModelPricingPage.tsx").read_text(encoding="utf-8")
helper = (ADMIN / "source/src/components/pricing/modelPricing.ts").read_text(encoding="utf-8")
server = (ADMIN / "source/src/server/config.ts").read_text(encoding="utf-8")
tests = (ADMIN / "source/src/components/pricing/modelPricing.test.ts").read_text(encoding="utf-8")
deploy = (PATCH / "scripts/deploy.sh").read_text(encoding="utf-8")
set_context = (PATCH / "scripts/set-context-values.sh").read_text(encoding="utf-8")
set_context_js = (PATCH / "scripts/set-context-values.js").read_text(encoding="utf-8")

for marker in (
    "com_pricing_context_label",
    "metadataPreview.context",
    "getModelMetadataDraft",
    "parseModelMetadataDraft",
):
    assert marker in page or marker in helper

assert "context: z.number().int().positive().nullable()" in server
assert "modelConfig.context = data.context" in server
assert "reads and validates the model context limit" in tests

for marker in (
    "release-governance:scoped-deployment",
    "release-governance:target-lock",
    "PREFLIGHT_ONLY",
    "force-recreate admin-panel",
    "protected_containers_unchanged=true",
):
    assert marker in deploy

for marker in (
    "PREFLIGHT_ONLY",
    "protected_containers_unchanged=true",
    "codexConfigBackups",
    "modelConfig.context = 1000000",
):
    assert marker in set_context or marker in set_context_js

assert "non-context model fields changed" in set_context_js
assert "db.configs.replaceOne" in set_context_js

print("admin context configuration release checks: ok")
