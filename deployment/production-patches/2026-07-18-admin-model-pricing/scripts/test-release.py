#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[2]
ADMIN_SOURCE = Path(
    os.environ.get(
        "ADMIN_PANEL_SOURCE",
        REPO_ROOT / "deployment/production-patches/2026-07-11-admin-panel-zh-cn/source",
    )
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def read(relative: str) -> str:
    return (ADMIN_SOURCE / relative).read_text(encoding="utf-8")


def main() -> None:
    page = read("src/components/pricing/ModelPricingPage.tsx")
    helpers = read("src/components/pricing/modelPricing.ts")
    helper_tests = read("src/components/pricing/modelPricing.test.ts")
    sidebar = read("src/components/Sidebar.tsx")
    route = read("src/routes/_app/pricing.tsx")
    route_tree = read("src/routeTree.gen.ts")
    dockerfile = read("Dockerfile")

    for marker in (
        "admin-model-pricing",
        "endpoints.custom",
        "saveBaseConfigFn",
        "PRICE_FIELDS",
        "$/1M tokens",
        "com_pricing_save_preview",
    ):
        require(marker in page, f"pricing page marker missing: {marker}")

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
    require("6ad105234ede74ded26ac29d5db9f2f68d2f55dbd972ceb3bc6ec1726741a702" in deploy,
            "production Compose baseline missing")
    require("force-recreate admin-panel" in deploy, "deployment does not scope recreation to Admin Panel")
    require("force-recreate api" not in deploy, "deployment unexpectedly recreates API")
    print("admin_model_pricing_release: ok")


if __name__ == "__main__":
    main()
