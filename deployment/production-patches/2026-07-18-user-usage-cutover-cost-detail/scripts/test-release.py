#!/usr/bin/env python3

from pathlib import Path

PATCHES = Path(__file__).resolve().parents[2]
USAGE = PATCHES / "2026-07-17-user-usage-dashboard"

api = (USAGE / "api" / "usage-dashboard.js").read_text(encoding="utf-8")
client = (USAGE / "client" / "user-usage-dashboard.js").read_text(encoding="utf-8")
style = (USAGE / "client" / "user-usage-dashboard.css").read_text(encoding="utf-8")

for marker in (
    "parsePricingCutoff",
    "parsePricingCutoffModels",
    "buildPricingIndex",
    "decorateCostBreakdown",
    "costBreakdownMatches",
    "USER_USAGE_PRICING_CUTOFF",
):
    assert marker in api, f"missing cutover API marker: {marker}"

for marker in (
    "formatCostBreakdown",
    "formatRate",
    "lc-usage-cost-detail",
    "费用明细不可用",
    "费用合计",
    "实际费用",
):
    assert marker in client, f"missing cost-detail Client marker: {marker}"

assert ".lc-usage-cost-detail" in style
print("pricing cutover and cost detail release checks: ok")
