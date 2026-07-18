#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_OVERRIDE = os.environ.get("ADMIN_PANEL_SOURCE")
REPO_ROOT = ROOT.parents[2] if len(ROOT.parents) > 2 else None
ADMIN_SOURCE = Path(SOURCE_OVERRIDE or (REPO_ROOT / "deployment/production-patches/2026-07-11-admin-panel-zh-cn/source"))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def read(relative: str) -> str:
    return (ADMIN_SOURCE / relative).read_text(encoding="utf-8")


def main() -> None:
    page = read("src/components/pricing/ModelPricingPage.tsx")
    server_config = read("src/server/config.ts")
    helpers = read("src/components/pricing/modelPricing.ts")
    helper_tests = read("src/components/pricing/modelPricing.test.ts")
    sidebar = read("src/components/Sidebar.tsx")
    route = read("src/routes/_app/pricing.tsx")
    route_tree = read("src/routeTree.gen.ts")
    dockerfile = read("Dockerfile")

    for marker in (
        "admin-model-pricing",
        "saveCustomEndpointTokenConfigFn",
        "PRICE_FIELDS",
        "$/1M tokens",
        "com_pricing_save_preview",
    ):
        require(marker in page, f"pricing page marker missing: {marker}")
    require("saveBaseConfigFn" not in page, "pricing page must not use full-array config save")
    require(
        "endpoints.custom.${data.endpointIndex}.tokenConfig" in server_config,
        "dedicated tokenConfig field save is missing",
    )
    require(
        "entries: [{ fieldPath, value: tokenConfig }]" in server_config,
        "dedicated tokenConfig save payload is missing",
    )
    require("tokenConfig[data.model] = modelConfig" in server_config,
            "server-side model pricing reconstruction is missing")

    for marker in (
        "prompt",
        "completion",
        "cacheRead",
        "cacheWrite",
        "hasComplexPricing",
        "delete modelConfig[field]",
    ):
        require(marker in helpers, f"pricing helper marker missing: {marker}")

    for marker in ("preserving non-price fields", "context: 800000", "blocks unsupported complex"):
        require(marker in helper_tests, f"pricing test marker missing: {marker}")

    require("path: '/pricing'" in sidebar, "pricing sidebar route missing")
    require("icon: 'payment'" in sidebar, "pricing sidebar icon is not the approved native icon")
    require("READ_CONFIGS" in route, "pricing route read capability missing")
    require("AppPricingRoute" in route_tree, "generated pricing route missing")
    require("modelPricing.test.ts" in dockerfile, "Docker build does not run pricing tests")

    for locale in ("en", "zh-Hans"):
        data = json.loads(read(f"src/locales/{locale}/translation.json"))
        for key in (
            "com_nav_model_pricing",
            "com_pricing_title",
            "com_pricing_prompt_label",
            "com_pricing_completion_label",
            "com_pricing_cache_read_label",
            "com_pricing_cache_write_label",
            "com_pricing_save_preview",
        ):
            require(data.get(key), f"{locale} locale missing: {key}")

    deploy = (ROOT / "scripts/build-and-deploy.sh").read_text(encoding="utf-8")
    require("75765781ad2a7fcb4f801e4ed8ae297de640159f244b1aab2fc1cd3e2b69f17f" in deploy,
            "production Compose baseline missing")
    require("force-recreate admin-panel" in deploy, "deployment does not scope recreation to Admin Panel")
    require("force-recreate api" not in deploy, "deployment unexpectedly recreates API")
    require("REUSE_PREFLIGHT_IMAGE" in deploy, "verified preflight image reuse is missing")
    print("admin_model_pricing_release: ok")


if __name__ == "__main__":
    main()
