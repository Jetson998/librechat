#!/usr/bin/env python3

from pathlib import Path

PATCHES = Path(__file__).resolve().parents[2]
CLIENT = PATCHES / "2026-07-17-user-usage-dashboard" / "client"

script = (CLIENT / "user-usage-dashboard.js").read_text(encoding="utf-8")
style = (CLIENT / "user-usage-dashboard.css").read_text(encoding="utf-8")

for marker in (
    "niceMaximum",
    "lc-usage-axis-label",
    "data-chart-tooltip",
    "pointermove",
    "focusin",
    "lc-usage-model-chart",
    "lc-usage-model-legend",
    "模型 Token 分布",
):
    assert marker in script, f"missing chart script marker: {marker}"

for marker in (
    ".lc-usage-grid-line",
    ".lc-usage-chart-tooltip",
    ".lc-usage-model-chart-layout",
    ".lc-usage-model-segment:hover",
    ".dark .lc-usage-model-track",
    "@media (max-width: 680px)",
):
    assert marker in style, f"missing chart style marker: {marker}"

for forbidden in ("lc-usage-bar", "lc-usage-chart-dates"):
    assert forbidden not in script, f"obsolete chart marker remains: {forbidden}"

print("usage chart release checks: ok")
