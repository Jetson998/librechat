#!/usr/bin/env python3

import json
from pathlib import Path

PATCHES = Path(__file__).resolve().parents[2]
REPO = PATCHES.parents[1]
USAGE = PATCHES / "2026-07-17-user-usage-dashboard"
ADMIN = PATCHES / "2026-07-11-admin-panel-zh-cn" / "source"

api = (USAGE / "api" / "usage-dashboard.js").read_text(encoding="utf-8")
client = (USAGE / "client" / "user-usage-dashboard.js").read_text(encoding="utf-8")
style = (USAGE / "client" / "user-usage-dashboard.css").read_text(encoding="utf-8")
api_tests = (USAGE / "scripts" / "test-usage-dashboard.js").read_text(encoding="utf-8")
admin_page = (ADMIN / "src/components/pricing/ModelPricingPage.tsx").read_text(encoding="utf-8")
admin_helpers = (ADMIN / "src/components/pricing/modelPricing.ts").read_text(encoding="utf-8")
admin_server = (ADMIN / "src/server/config.ts").read_text(encoding="utf-8")
admin_tests = (ADMIN / "src/components/pricing/modelPricing.test.ts").read_text(encoding="utf-8")
demo = (REPO / "docs/demos/user-usage-dashboard-demo.html").read_text(encoding="utf-8")

for marker in ("buildModelMarket", "officialPrompt", "inputDiscount", "market.published"):
    assert marker in api, f"missing market API marker: {marker}"

for marker in ('data-view="market"', "renderMarket", "模型市场", "输入优惠率", "官方"):
    assert marker in client, f"missing market Client marker: {marker}"

for marker in ("lc-usage-market-table", "lc-usage-market-discount", "lc-usage-toolbar[hidden]"):
    assert marker in style, f"missing market style marker: {marker}"

for marker in ("published: true", "officialPrompt: 1.25", "inputDiscount: 52"):
    assert marker in api_tests, f"missing market API test marker: {marker}"

for marker in (
    "EMPTY_MARKET_DRAFT",
    "getMarketDraft",
    "parseMarketDraft",
    "com_pricing_market_publish",
    "com_pricing_official_prompt",
):
    assert marker in admin_helpers or marker in admin_page, f"missing Admin marker: {marker}"

assert "marketPublished: z.boolean()" in admin_server
assert "officialPrompt: z.number().positive().nullable()" in admin_server
assert "modelConfig.market" in admin_server
assert "reads and validates market metadata" in admin_tests

for locale in ("en", "zh-Hans"):
    translations = json.loads(
        (ADMIN / f"src/locales/{locale}/translation.json").read_text(encoding="utf-8")
    )
    for key in (
        "com_pricing_market_title",
        "com_pricing_market_publish",
        "com_pricing_official_prompt",
        "com_pricing_market_discount_preview",
    ):
        assert translations.get(key), f"{locale} locale missing: {key}"

assert 'data-view="market"' in demo
assert "优惠 52%" in demo
assert "如需大额采购" not in client, "phase-two contact CTA must not enter phase one"
print("user model market phase-one release checks: ok")
