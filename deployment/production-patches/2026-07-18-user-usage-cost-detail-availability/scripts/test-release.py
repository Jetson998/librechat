#!/usr/bin/env python3

from pathlib import Path

PATCHES = Path(__file__).resolve().parents[2]
USAGE = PATCHES / "2026-07-17-user-usage-dashboard"

api = (USAGE / "api" / "usage-dashboard.js").read_text(encoding="utf-8")
user = (USAGE / "api" / "user.js").read_text(encoding="utf-8")
client = (USAGE / "client" / "user-usage-dashboard.js").read_text(encoding="utf-8")
tests = (USAGE / "scripts" / "test-usage-dashboard.js").read_text(encoding="utf-8")

for marker in (
    "pricingMatches",
    "components.length === 0",
    ".filter(([, tokens]) => Number(tokens) > 0)",
):
    assert marker in api, f"missing API marker: {marker}"

assert ".filter(([key]) => row.costBreakdown[key])" in client
assert "router.get('/usage-dashboard', requireJwtAuth, configMiddleware, usageDashboardHandler);" in user
assert "identical duplicate prices must resolve by model" in tests
assert "missing zero-Token price must not block detail" in tests
print("cost detail availability release checks: ok")
