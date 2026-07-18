#!/usr/bin/env python3

from pathlib import Path

PATCHES = Path(__file__).resolve().parents[2]
USAGE = PATCHES / "2026-07-17-user-usage-dashboard"
ROOT = PATCHES.parents[1]

client = (USAGE / "client" / "user-usage-dashboard.js").read_text(encoding="utf-8")
demo = (ROOT / "docs" / "demos" / "user-usage-dashboard-demo.html").read_text(
    encoding="utf-8"
)

assert client.count("currencyDisplay: 'narrowSymbol'") == 2
assert "US$" not in client
assert "US$" not in demo
assert "费用合计：$0.0209" in demo
print("compact USD symbol release checks: ok")
