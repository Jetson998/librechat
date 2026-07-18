#!/usr/bin/env python3

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
script = (ROOT / "client" / "user-usage-dashboard.js").read_text(encoding="utf-8")
style = (ROOT / "client" / "user-usage-dashboard.css").read_text(encoding="utf-8")

for marker in [
    "用量统计", "/api/user/usage-dashboard", "Token 消耗", "费用消耗",
    "对话实例数", "对话轮次", "平均上下文", "平均对话轮次",
    "时间</th><th>模型</th><th>对话实例</th><th>轮次</th><th>Token 消耗</th><th>费用消耗",
    "近 7 天", "近 30 天", "全部",
    'data-view="overview"', 'data-view="logs"',
    'data-chart-tooltip', 'lc-usage-axis-label', 'lc-usage-model-chart',
    'pointermove', 'focusin',
    'lc-usage-token-detail', 'lc-usage-cost-detail', '普通输入', '缓存读取', '缓存写入', '历史明细不可拆分',
    'formatCostBreakdown', '费用合计', '实际费用', '×',
    'data-view="market"', '模型市场', 'renderMarket', '模型优惠率', 'officialPrompt',
    'lc-usage-market-col-model', 'lc-usage-market-col-rate', 'lc-usage-market-price-meta',
    "页面 ${state.page} / ${totalPages}", "上一页", "下一页",
    "data-filter-toggle", "event.key !== 'Escape'", "input.blur()",
]:
    assert marker in script, f"missing client marker: {marker}"
for forbidden in ["对话回合", "本轮次", "本轮费用", "成功状态"]:
    assert forbidden not in script, f"forbidden terminology: {forbidden}"
assert "lc-usage-overlay" in style
assert "lc-usage-settings-layout" in style
assert "lc-usage-section-nav" in style
assert "lc-usage-dashboard-root" in style
assert "data-active-item" in script
assert "lucide-chart-no-axes-column-increasing" in script
assert "价格用量统计" not in script
assert ".lc-user-usage-menu-item:hover" in style
assert "var(--surface-hover)" in style
assert "position: sticky" in style
assert "table-layout: fixed" in style
assert ".lc-usage-market-col-model" in style
assert ".lc-usage-market-col-rate" in style
assert ".lc-usage-market-price-meta" in style
assert "managed_targets" in (ROOT / "scripts" / "deploy.sh").read_text(encoding="utf-8")
assert "@media (max-width: 680px)" in style
assert "data-conversation-link" in script
assert "localStorage.getItem('token')" in script
assert "fetch('/api/auth/refresh'" in script
assert "credentials: 'include'" in script
assert "Authorization: `Bearer ${token}`" in script
print("client release checks: ok")
