(() => {
  if (window.__librechatUserUsageDashboardInstalled) {
    return;
  }
  window.__librechatUserUsageDashboardInstalled = true;

  const state = {
    range: '30',
    trend: 'tokens',
    model: '',
    conversation: '',
    page: 1,
    limit: 20,
    data: null,
    loading: false,
  };

  const labels = {
    tokens: 'Token 消耗',
    conversationInstances: '对话实例数',
    averageContext: '平均上下文',
    cost: '费用消耗',
  };

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  const formatNumber = (value, digits = 1) => {
    const number = Number(value || 0);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(digits)}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(digits)}K`;
    return number.toLocaleString('zh-CN', { maximumFractionDigits: digits });
  };

  const formatCost = (value, currency = 'CNY') => {
    if (value == null) return '不可用';
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(Number(value || 0));
  };

  const formatTimestamp = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  };

  function providerLogo({ model = '', endpoint = '', iconURL = '' }) {
    if (/^(https?:\/\/|\/)/i.test(iconURL)) {
      return `<img class="lc-usage-provider-logo" src="${escapeHtml(iconURL)}" alt="" />`;
    }
    const key = `${model} ${endpoint}`.toLowerCase();
    if (/openai|gpt|o1|o3|o4/.test(key)) return '<img class="lc-usage-provider-logo" src="/assets/openai.svg" alt="" />';
    if (/google|gemini/.test(key)) return '<img class="lc-usage-provider-logo" src="/assets/google.svg" alt="" />';
    if (/mistral/.test(key)) return '<img class="lc-usage-provider-logo" src="/assets/mistral.png" alt="" />';
    if (/deepseek/.test(key)) return '<img class="lc-usage-provider-logo" src="/assets/deepseek.svg" alt="" />';
    if (/groq/.test(key)) return '<img class="lc-usage-provider-logo" src="/assets/groq.png" alt="" />';
    if (/anthropic|claude|fable/.test(key)) return '<img class="lc-usage-provider-logo" src="/anthropic-mark.svg" alt="" />';
    const initial = (model.trim()[0] || 'M').toUpperCase();
    return `<span class="lc-usage-provider-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`;
  }

  function createPanel() {
    const overlay = document.createElement('div');
    overlay.id = 'lc-user-usage-overlay';
    overlay.className = 'lc-usage-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <section class="lc-usage-panel" role="dialog" aria-modal="true" aria-labelledby="lcUsageTitle">
        <header class="lc-usage-header">
          <div>
            <h1 id="lcUsageTitle">价格用量统计</h1>
            <p>查看当前账户的对话消耗与使用记录</p>
          </div>
          <div class="lc-usage-header-actions">
            <div class="lc-usage-help-wrap">
              <button class="lc-usage-icon-button" data-action="help" type="button" aria-label="指标说明" title="指标说明">?</button>
              <div class="lc-usage-help" data-role="help" hidden>
                <strong>指标说明</strong>
                <p><b>Token 消耗</b>：对话请求的 Token 数。</p>
                <p><b>费用消耗</b>：对话请求 Token 的费用。</p>
                <p><b>对话实例数</b>：产生的对话窗口数。</p>
                <p><b>对话轮次</b>：产生回复的对话轮次。</p>
                <p><b>平均上下文</b>：对话 Token / 对话实例数。</p>
                <p><b>平均对话轮次</b>：对话轮次 / 对话实例数。</p>
              </div>
            </div>
            <button class="lc-usage-icon-button" data-action="close" type="button" aria-label="关闭" title="关闭">×</button>
          </div>
        </header>
        <div class="lc-usage-content">
          <div class="lc-usage-toolbar">
            <div class="lc-usage-ranges" role="group" aria-label="统计周期">
              <button type="button" data-range="7">近 7 天</button>
              <button type="button" data-range="30">近 30 天</button>
              <button type="button" data-range="all">全部</button>
            </div>
            <span class="lc-usage-authority">费用按后台模型单价估算</span>
          </div>
          <div data-role="dashboard"></div>
        </div>
      </section>`;

    overlay.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (event.target === overlay || action === 'close') closePanel();
      if (action === 'help') {
        const help = overlay.querySelector('[data-role="help"]');
        help.hidden = !help.hidden;
      }
      const range = event.target.closest('[data-range]')?.dataset.range;
      if (range && range !== state.range) {
        state.range = range;
        state.page = 1;
        loadDashboard();
      }
      const trend = event.target.closest('[data-trend]')?.dataset.trend;
      if (trend && trend !== state.trend) {
        state.trend = trend;
        renderDashboard();
      }
      const page = Number(event.target.closest('[data-page]')?.dataset.page);
      if (page > 0 && page !== state.page) {
        state.page = page;
        loadDashboard();
      }
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function getPanel() {
    return document.getElementById('lc-user-usage-overlay') || createPanel();
  }

  function openPanel() {
    const panel = getPanel();
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('lc-usage-open');
    loadDashboard();
  }

  function closePanel() {
    const panel = document.getElementById('lc-user-usage-overlay');
    panel?.classList.remove('is-open');
    panel?.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('lc-usage-open');
  }

  function metric(label, value, description, tone) {
    return `
      <article class="lc-usage-metric" data-tone="${tone}">
        <div class="lc-usage-metric-label"><span>${label}</span><i></i></div>
        <div class="lc-usage-metric-value">${value}</div>
        <div class="lc-usage-metric-meta">${description}</div>
      </article>`;
  }

  function renderChart(trends, key, currency) {
    const values = trends.map((item) => Number(item[key] || 0));
    if (!values.length || Math.max(...values) <= 0) {
      return '<div class="lc-usage-empty lc-usage-chart-empty">当前周期暂无趋势数据</div>';
    }
    const width = 720;
    const height = 210;
    const padding = 24;
    const max = Math.max(...values);
    const step = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0;
    const points = values.map((value, index) => {
      const x = values.length > 1 ? padding + index * step : width / 2;
      const y = height - padding - (value / max) * (height - padding * 2);
      return [x, y];
    });
    const polyline = points.map(([x, y]) => `${x},${y}`).join(' ');
    const area = `${padding},${height - padding} ${polyline} ${points.at(-1)[0]},${height - padding}`;
    const latest = values.at(-1);
    const latestText = key === 'cost' ? formatCost(latest, currency) : formatNumber(latest);
    return `
      <div class="lc-usage-chart-summary"><span>${labels[key]}</span><strong>${latestText}</strong></div>
      <svg class="lc-usage-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${labels[key]}趋势">
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" />
        <polygon points="${area}" />
        <polyline points="${polyline}" />
        ${points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" />`).join('')}
      </svg>
      <div class="lc-usage-chart-dates"><span>${escapeHtml(trends[0].date)}</span><span>${escapeHtml(trends.at(-1).date)}</span></div>`;
  }

  function renderModelDistribution(models) {
    if (!models.length) return '<div class="lc-usage-empty">当前周期暂无模型数据</div>';
    return models
      .slice(0, 5)
      .map(
        (item) => `
          <div class="lc-usage-model-row">
            <div class="lc-usage-model-name">${providerLogo(item)}<span>${escapeHtml(item.model)}</span></div>
            <strong>${item.percentage}%</strong>
            <div class="lc-usage-bar"><i style="width:${Math.max(1, item.percentage)}%"></i></div>
          </div>`,
      )
      .join('');
  }

  function renderLogs(data) {
    const rows = data.logs || [];
    const body = rows.length
      ? rows
          .map(
            (row) => `
              <tr>
                <td>${formatTimestamp(row.timestamp)}</td>
                <td><div class="lc-usage-log-model">${providerLogo(row)}<span>${escapeHtml(row.model)}</span></div></td>
                <td><button class="lc-usage-conversation-link" type="button" data-conversation-link="${escapeHtml(row.conversationId)}">${escapeHtml(row.conversationTitle)}</button></td>
                <td>${Number(row.turn || 0)}</td>
                <td>${formatNumber(row.tokens, 1)}</td>
                <td>${formatCost(row.cost, data.currency)}</td>
              </tr>`,
          )
          .join('')
      : '<tr><td colspan="6"><div class="lc-usage-empty">当前筛选条件下暂无对话日志</div></td></tr>';

    const totalPages = Math.max(1, Math.ceil(data.pagination.total / data.pagination.limit));
    return `
      <section class="lc-usage-surface lc-usage-logs">
        <div class="lc-usage-surface-header lc-usage-log-header">
          <div><h2>对话日志</h2><p>仅展示成功产生回复的对话轮次</p></div>
          <div class="lc-usage-filters">
            ${searchFilter('model', '筛选模型', data.modelOptions || [])}
            ${searchFilter('conversation', '筛选对话实例', data.conversationOptions || [])}
          </div>
        </div>
        <div class="lc-usage-table-wrap">
          <table>
            <thead><tr><th>时间</th><th>模型</th><th>对话实例</th><th>轮次</th><th>Token 消耗</th><th>费用消耗</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <footer class="lc-usage-log-footer">
          <span>共 ${data.pagination.total} 条记录</span>
          <div>
            <button type="button" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>‹</button>
            <span>${state.page} / ${totalPages}</span>
            <button type="button" data-page="${state.page + 1}" ${state.page >= totalPages ? 'disabled' : ''}>›</button>
          </div>
        </footer>
      </section>`;
  }

  function searchFilter(name, placeholder, options) {
    const selectedValue = state[name];
    const selected = options.find((item) => item.value === selectedValue);
    return `
      <div class="lc-usage-search" data-filter="${name}">
        <input type="search" autocomplete="off" value="${escapeHtml(selected?.label || '')}" placeholder="${placeholder}" aria-label="${placeholder}" />
        <button type="button" data-filter-clear="${name}" aria-label="清除${placeholder}" title="清除" ${selectedValue ? '' : 'hidden'}>×</button>
        <div class="lc-usage-options" hidden></div>
      </div>`;
  }

  function bindFilters() {
    const panel = getPanel();
    panel.querySelectorAll('[data-filter]').forEach((root) => {
      const name = root.dataset.filter;
      const input = root.querySelector('input');
      const optionsBox = root.querySelector('.lc-usage-options');
      const options = name === 'model' ? state.data.modelOptions : state.data.conversationOptions;
      const drawOptions = () => {
        const query = input.value.trim().toLowerCase();
        const matches = options
          .filter((item) => !query || item.label.toLowerCase().includes(query))
          .slice(0, 30);
        optionsBox.innerHTML = matches.length
          ? matches
              .map((item) => `<button type="button" data-value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</button>`)
              .join('')
          : '<span>无匹配项</span>';
        optionsBox.hidden = false;
      };
      input.addEventListener('focus', drawOptions);
      input.addEventListener('input', () => {
        if (!input.value && state[name]) {
          state[name] = '';
          state.page = 1;
          loadDashboard();
          return;
        }
        drawOptions();
      });
      optionsBox.addEventListener('click', (event) => {
        const option = event.target.closest('[data-value]');
        if (!option) return;
        state[name] = option.dataset.value;
        state.page = 1;
        optionsBox.hidden = true;
        loadDashboard();
      });
    });
    panel.querySelectorAll('[data-filter-clear]').forEach((button) => {
      button.addEventListener('click', () => {
        state[button.dataset.filterClear] = '';
        state.page = 1;
        loadDashboard();
      });
    });
    panel.querySelectorAll('[data-conversation-link]').forEach((button) => {
      button.addEventListener('click', () => {
        closePanel();
        window.location.assign(`/c/${encodeURIComponent(button.dataset.conversationLink)}`);
      });
    });
  }

  function renderDashboard() {
    const panel = getPanel();
    const root = panel.querySelector('[data-role="dashboard"]');
    panel.querySelectorAll('[data-range]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.range === state.range);
    });

    if (state.loading && !state.data) {
      root.innerHTML = '<div class="lc-usage-status"><i></i><span>正在加载用量数据</span></div>';
      return;
    }
    if (!state.data) {
      root.innerHTML = '<div class="lc-usage-status is-error"><span>用量数据加载失败</span><button type="button" data-action="retry">重试</button></div>';
      root.querySelector('[data-action="retry"]')?.addEventListener('click', loadDashboard);
      return;
    }

    const data = state.data;
    const summary = data.summary;
    const incomplete = summary.costIncomplete ? '<span class="lc-usage-cost-note">部分历史记录无费用</span>' : '';
    root.innerHTML = `
      <section class="lc-usage-metric-groups" aria-label="核心统计">
        <div><h2>消耗统计</h2><div class="lc-usage-metric-grid">
          ${metric('Token 消耗', formatNumber(summary.tokens), '对话请求的 Token 数', 'token')}
          ${metric('费用消耗', `${formatCost(summary.cost, data.currency)}${incomplete}`, '对话请求 Token 的费用', 'cost')}
        </div></div>
        <div><h2>对话统计</h2><div class="lc-usage-metric-grid">
          ${metric('对话实例数', formatNumber(summary.conversationInstances, 0), '产生的对话窗口数', 'instance')}
          ${metric('对话轮次', formatNumber(summary.conversationTurns, 0), '产生回复的对话轮次', 'turn')}
        </div></div>
        <div><h2>对话复杂度</h2><div class="lc-usage-metric-grid">
          ${metric('平均上下文', formatNumber(summary.averageContext), '对话 Token / 对话实例数', 'context')}
          ${metric('平均对话轮次', Number(summary.averageTurns || 0).toFixed(1), '对话轮次 / 对话实例数', 'average')}
        </div></div>
      </section>
      <div class="lc-usage-main-grid">
        <section class="lc-usage-surface">
          <div class="lc-usage-surface-header"><h2>用量趋势</h2><div class="lc-usage-trend-tabs">
            ${[
              ['tokens', 'Token 消耗'],
              ['conversationInstances', '对话实例数'],
              ['averageContext', '平均上下文'],
              ['cost', '费用消耗'],
            ]
              .map(([key, label]) => `<button type="button" data-trend="${key}" class="${state.trend === key ? 'is-active' : ''}">${label}</button>`)
              .join('')}
          </div></div>
          <div class="lc-usage-chart-wrap">${renderChart(data.trends, state.trend, data.currency)}</div>
        </section>
        <section class="lc-usage-surface">
          <div class="lc-usage-surface-header"><div><h2>模型分布</h2><p>按 Token 消耗</p></div></div>
          <div class="lc-usage-model-list">${renderModelDistribution(data.models)}</div>
        </section>
      </div>
      ${renderLogs(data)}`;
    bindFilters();
  }

  async function getAccessToken() {
    const storedToken = window.localStorage.getItem('token');
    if (storedToken) return storedToken;

    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return '';
    const payload = await response.json().catch(() => null);
    return typeof payload?.token === 'string' ? payload.token : '';
  }

  async function loadDashboard() {
    if (state.loading) return;
    state.loading = true;
    renderDashboard();
    const params = new URLSearchParams({
      range: state.range,
      page: String(state.page),
      limit: String(state.limit),
    });
    if (state.model) params.set('model', state.model);
    if (state.conversation) params.set('conversation', state.conversation);
    try {
      const token = await getAccessToken();
      const response = await fetch(`/api/user/usage-dashboard?${params}`, {
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.data = await response.json();
    } catch (error) {
      console.error('[usage-dashboard] load failed', error);
      state.data = null;
    } finally {
      state.loading = false;
      renderDashboard();
    }
  }

  function isAccountMenu(menu) {
    const text = (menu.textContent || '').replace(/\s+/g, ' ');
    return /(设置|Settings)/i.test(text) && /(退出|注销|登出|Log out|Logout)/i.test(text);
  }

  function installMenuEntry() {
    document.querySelectorAll('[role="menu"]').forEach((menu) => {
      if (!isAccountMenu(menu) || menu.querySelector('[data-user-usage-menu]')) return;
      const controls = Array.from(menu.querySelectorAll('button, [role="menuitem"]'));
      const settings = controls.find((item) => /(设置|Settings)/i.test(item.textContent || ''));
      const reference = settings || controls.at(-1);
      if (!reference) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.userUsageMenu = 'true';
      button.className = `${reference.className || ''} lc-user-usage-menu-item`;
      button.setAttribute('role', reference.getAttribute('role') || 'menuitem');
      button.innerHTML = '<span class="lc-user-usage-menu-icon" aria-hidden="true">¥</span><span>价格用量统计</span>';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPanel();
      });
      menu.insertBefore(button, reference);
    });
  }

  document.addEventListener('keydown', (event) => {
    const panel = document.getElementById('lc-user-usage-overlay');
    if (event.key === 'Escape' && panel?.classList.contains('is-open')) closePanel();
  });

  installMenuEntry();
  new MutationObserver(installMenuEntry).observe(document.documentElement, { childList: true, subtree: true });
})();
