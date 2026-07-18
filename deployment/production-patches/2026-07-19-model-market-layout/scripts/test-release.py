#!/usr/bin/env python3

from pathlib import Path

PATCH = Path(__file__).resolve().parents[1]
PATCHES = PATCH.parent
USAGE = PATCHES / "2026-07-17-user-usage-dashboard"

client = (USAGE / "client/user-usage-dashboard.js").read_text(encoding="utf-8")
style = (USAGE / "client/user-usage-dashboard.css").read_text(encoding="utf-8")
deploy = (PATCH / "scripts/deploy.sh").read_text(encoding="utf-8")

for marker in (
    "lc-usage-market-price-meta",
    "模型优惠率以当前输入单价相对官方输入价计算",
    "lc-usage-market-col-model",
    "lc-usage-market-col-context",
    "lc-usage-market-col-input",
    "lc-usage-market-col-rate",
):
    assert marker in client, f"missing client marker: {marker}"

for marker in (
    "table-layout: fixed",
    ".lc-usage-market-col-model",
    "width: 26%",
    ".lc-usage-market-col-context",
    "width: 10%",
    ".lc-usage-market-col-input",
    "width: 19%",
    ".lc-usage-market-col-rate",
    "width: 15%",
    ".lc-usage-market-price-meta",
):
    assert marker in style, f"missing style marker: {marker}"

assert "输入优惠率按" not in client
for marker in (
    "release-governance:scoped-deployment",
    "release-governance:target-lock",
    "docker compose up -d --no-deps --force-recreate api",
    "protected_containers_unchanged=true",
    "PREFLIGHT_ONLY",
):
    assert marker in deploy, f"missing deployment marker: {marker}"

print("model market layout release checks: ok")

