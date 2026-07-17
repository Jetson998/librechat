#!/usr/bin/env python3

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
script = (ROOT / "client" / "user-usage-dashboard.js").read_text(encoding="utf-8")
style = (ROOT / "client" / "user-usage-dashboard.css").read_text(encoding="utf-8")

for marker in [
    "价格用量统计", "/api/user/usage-dashboard", "Token 消耗", "费用消耗",
    "对话实例数", "对话轮次", "平均上下文", "平均对话轮次",
    "时间</th><th>模型</th><th>对话实例</th><th>轮次</th><th>Token 消耗</th><th>费用消耗",
    "近 7 天", "近 30 天", "全部",
]:
    assert marker in script, f"missing client marker: {marker}"
for forbidden in ["对话回合", "本轮次", "本轮费用", "成功状态"]:
    assert forbidden not in script, f"forbidden terminology: {forbidden}"
assert "lc-usage-overlay" in style
assert "@media (max-width: 680px)" in style
assert "data-conversation-link" in script
assert "localStorage.getItem('token')" in script
assert "Authorization: `Bearer ${token}`" in script
print("client release checks: ok")
