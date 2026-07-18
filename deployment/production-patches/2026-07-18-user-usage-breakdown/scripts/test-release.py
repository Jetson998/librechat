#!/usr/bin/env python3

from pathlib import Path

PATCHES = Path(__file__).resolve().parents[2]
USAGE = PATCHES / "2026-07-17-user-usage-dashboard"

api = (USAGE / "api" / "usage-dashboard.js").read_text(encoding="utf-8")
client = (USAGE / "client" / "user-usage-dashboard.js").read_text(encoding="utf-8")
style = (USAGE / "client" / "user-usage-dashboard.css").read_text(encoding="utf-8")

for marker in (
    "structuredPromptRows",
    "inputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "outputTokens",
    "tokenBreakdownAvailable",
):
    assert marker in api, f"missing API breakdown marker: {marker}"

for marker in (
    "formatTokenBreakdown",
    "lc-usage-token-detail",
    "普通输入",
    "缓存读取",
    "缓存写入",
    "历史明细不可拆分",
):
    assert marker in client, f"missing Client breakdown marker: {marker}"

assert ".lc-usage-token-detail" in style
assert "white-space: pre-line" in style
print("usage token breakdown release checks: ok")
