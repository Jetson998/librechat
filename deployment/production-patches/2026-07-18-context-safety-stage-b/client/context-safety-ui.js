(() => {
  'use strict';

  const root = typeof window === 'undefined' ? null : window;
  const VERSION = '2026-07-18-stage-b-v2';
  const STORAGE_KEY = 'librechat-context-safety-handoff-v2';
  const LEVELS = Object.freeze({
    none: 'none',
    notice: 'notice',
    warning: 'warning',
    critical: 'critical',
  });
  const THRESHOLDS = Object.freeze({ notice: 70, warning: 85, critical: 95 });
  const MESSAGES = Object.freeze({
    notice:
      '当前对话内容较多，任务仍可继续。后续长文件建议使用新对话，并携带当前任务摘要。',
    warning: '对话空间接近上限。建议先生成交接摘要，再开启新对话继续。',
    critical: '为避免任务失败，系统已暂停继续调用工具。已生成文件仍然保留。',
    recursion:
      '本次处理步骤已达到安全上限，已停止继续尝试。已保留已生成结果和错误清单，可从未完成项继续。',
  });
  const SUMMARY_REQUEST =
    '请为当前任务生成一份简洁的交接摘要，供新对话继续使用。不要调用任何工具，不要重新读取完整文件或历史工具输出。只写：任务目标、已完成事项、未完成事项、关键结论、当前相关文件名和下一步建议。控制在 1200 字以内。';

  const normalizeSpace = (value) =>
    String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const truncate = (value, limit) => {
    const text = String(value || '').trim();
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
  };
  const classifyPercent = (value) => {
    const percent = Number(value);
    if (!Number.isFinite(percent) || percent < 0) {
      return LEVELS.none;
    }
    if (percent >= THRESHOLDS.critical) {
      return LEVELS.critical;
    }
    if (percent >= THRESHOLDS.warning) {
      return LEVELS.warning;
    }
    if (percent >= THRESHOLDS.notice) {
      return LEVELS.notice;
    }
    return LEVELS.none;
  };
  const parseMeterValues = (usedValue, maxValue) => {
    const used = Number(usedValue);
    const max = Number(maxValue);
    if (!Number.isFinite(used) || !Number.isFinite(max) || used < 0 || max <= 0) {
      return null;
    }
    const percent = (used / max) * 100;
    return Object.freeze({ used, max, percent, level: classifyPercent(percent) });
  };
  const isRecursionError = (value) => {
    const text = normalizeSpace(value);
    return (
      /Recursion limit of\s+\d+\s+reached/i.test(text) &&
      /without hitting a stop condition/i.test(text)
    );
  };
  const normalizeFileNames = (values) => {
    const unique = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const name = truncate(normalizeSpace(value).replace(/^(?:下载|Download)\s+/i, ''), 180);
      if (
        !name ||
        /^(?:下载|Download|打开|Open|点击以打开|点击打开)$/i.test(name) ||
        seen.has(name)
      ) {
        continue;
      }
      seen.add(name);
      unique.push(name);
      if (unique.length >= 20) {
        break;
      }
    }
    return unique;
  };
  const removeGenericFileLines = (value) =>
    String(value || '')
      .split('\n')
      .filter(
        (line) =>
          !/^\s*-\s*(?:下载|Download|打开|Open|点击以打开|点击打开)\s*$/i.test(
            normalizeSpace(line),
          ),
      )
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  const buildHandoffDraft = ({ previousUrl, latestUserRequest, fileNames } = {}) => {
    const files = normalizeFileNames(fileNames);
    const lines = [
      '这是上一对话的任务交接草稿，请在新对话中先确认任务范围，再继续处理。',
      '',
      `上一对话：${truncate(previousUrl, 500) || '未记录'}`,
      '',
      '最近一次用户要求：',
      truncate(latestUserRequest, 2000) || '未提取到可见用户要求。',
    ];
    if (files.length > 0) {
      lines.push('', '上一对话可见的生成文件：', ...files.map((name) => `- ${name}`));
    }
    lines.push(
      '',
      '请不要加载上一对话的完整工具输出。需要文件内容时，请让我重新附加必要文件或按明确范围读取。',
    );
    return truncate(removeGenericFileLines(lines.join('\n')), 6000);
  };

  const contract = Object.freeze({
    version: VERSION,
    storageKey: STORAGE_KEY,
    levels: LEVELS,
    thresholds: THRESHOLDS,
    messages: MESSAGES,
    summaryRequest: SUMMARY_REQUEST,
    classifyPercent,
    parseMeterValues,
    isRecursionError,
    normalizeFileNames,
    removeGenericFileLines,
    buildHandoffDraft,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = contract;
  }

  if (!root?.document || root.__contextSafetyUIInstalled) {
    return;
  }

  root.__contextSafetyUIInstalled = true;
  root.__contextSafetyUIContract = contract;

  const document = root.document;
  const state = {
    level: LEVELS.none,
    percent: null,
    stopRequested: false,
    scheduled: false,
    recursionOriginals: new WeakMap(),
  };

  const getComposer = () => {
    const textarea = document.querySelector(
      '#prompt-textarea[data-testid="text-input"], textarea[data-testid="text-input"]',
    );
    return { textarea, form: textarea?.closest('form') || null };
  };

  const getContextView = () => {
    const trigger = document.querySelector('[data-testid="token-usage"]');
    const meter = trigger?.querySelector('[role="meter"]') || null;
    if (!meter) {
      return null;
    }
    return parseMeterValues(meter.getAttribute('aria-valuenow'), meter.getAttribute('aria-valuemax'));
  };

  const setTextareaValue = (textarea, value) => {
    if (!textarea) {
      return false;
    }
    const prototype = root.HTMLTextAreaElement?.prototype;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) {
      setter.call(textarea, value);
    } else {
      textarea.value = value;
    }
    textarea.dispatchEvent(new root.Event('input', { bubbles: true }));
    textarea.dispatchEvent(new root.Event('change', { bubbles: true }));
    textarea.focus();
    return true;
  };

  const getLatestUserRequest = () => {
    const messages = Array.from(document.querySelectorAll('.user-turn .text-message'));
    const latest = messages[messages.length - 1];
    return truncate(latest?.textContent || '', 2000);
  };

  const getGeneratedFileNames = () => {
    const names = [];
    const downloadButtons = document.querySelectorAll(
      '.agent-turn button[aria-label^="下载 "], .agent-turn button[aria-label^="Download "]',
    );
    for (const button of downloadButtons) {
      names.push(button.getAttribute('aria-label') || '');
    }
    const titledFiles = document.querySelectorAll(
      '.agent-turn .text-attachment-container [title], .agent-turn .file-attachment-container button[aria-label]',
    );
    for (const element of titledFiles) {
      names.push(element.getAttribute('title') || element.getAttribute('aria-label') || '');
    }
    return normalizeFileNames(names.slice().reverse()).reverse();
  };

  const findLatestResultCard = () => {
    const cards = document.querySelectorAll(
      '.agent-turn .text-attachment-container, .agent-turn .file-attachment-container',
    );
    return cards[cards.length - 1] || null;
  };

  const prefillSummaryRequest = () => {
    const { textarea } = getComposer();
    if (!textarea || textarea.value.trim()) {
      textarea?.focus();
      return;
    }
    setTextareaValue(textarea, SUMMARY_REQUEST);
  };

  const saveHandoffDraft = () => {
    const draft = buildHandoffDraft({
      previousUrl: root.location.href,
      latestUserRequest: getLatestUserRequest(),
      fileNames: getGeneratedFileNames(),
    });
    try {
      root.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ draft, createdAt: Date.now(), sourcePath: root.location.pathname }),
      );
    } catch {
      return false;
    }
    return true;
  };

  const openNewConversation = () => {
    if (!saveHandoffDraft()) {
      return;
    }
    root.location.assign(new URL('/c/new', root.location.origin).href);
  };

  const restoreHandoffDraft = () => {
    if (root.location.pathname !== '/c/new') {
      return;
    }
    let value;
    try {
      value = root.sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!value) {
      return;
    }
    let record;
    try {
      record = JSON.parse(value);
    } catch {
      root.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    if (!record?.draft || Date.now() - Number(record.createdAt || 0) > 60 * 60 * 1000) {
      root.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    const { textarea } = getComposer();
    if (!textarea || textarea.value.trim()) {
      return;
    }
    if (setTextareaValue(textarea, truncate(record.draft, 6000))) {
      root.sessionStorage.removeItem(STORAGE_KEY);
    }
  };

  const scrollToLatestResult = () => {
    const card = findLatestResultCard();
    if (!card) {
      return;
    }
    card.classList.add('context-safety-result-target');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    root.setTimeout(() => card.classList.remove('context-safety-result-target'), 1800);
  };

  const makeButton = (label, action, kind = 'secondary') => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `context-safety-action context-safety-action-${kind}`;
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  };

  const removeBanner = () => {
    document.getElementById('context-safety-ui-banner')?.remove();
  };

  const ensureBanner = (view) => {
    if (!view || view.level === LEVELS.none) {
      removeBanner();
      return;
    }
    const { form } = getComposer();
    const parent = form?.parentElement;
    if (!form || !parent) {
      return;
    }
    let banner = document.getElementById('context-safety-ui-banner');
    if (!banner) {
      banner = document.createElement('section');
      banner.id = 'context-safety-ui-banner';
      banner.setAttribute('aria-live', 'polite');
    }
    const hasResult = Boolean(findLatestResultCard());
    const signature = `${view.level}:${Math.round(view.percent)}:${hasResult ? 'files' : 'no-files'}`;
    if (
      banner.dataset.signature === signature &&
      banner.parentElement === parent &&
      banner.nextElementSibling === form
    ) {
      return;
    }
    banner.dataset.signature = signature;
    banner.dataset.level = view.level;
    banner.setAttribute('role', view.level === LEVELS.notice ? 'status' : 'alert');
    banner.replaceChildren();

    const content = document.createElement('div');
    content.className = 'context-safety-banner-content';
    const message = document.createElement('p');
    message.className = 'context-safety-banner-message';
    message.textContent = MESSAGES[view.level];
    const usage = document.createElement('span');
    usage.className = 'context-safety-banner-usage';
    usage.textContent = `当前对话已使用 ${Math.round(view.percent)}%`;
    content.append(message, usage);

    const actions = document.createElement('div');
    actions.className = 'context-safety-banner-actions';
    if (view.level !== LEVELS.critical) {
      actions.append(makeButton('生成交接摘要', prefillSummaryRequest));
    }
    actions.append(makeButton('新建对话继续', openNewConversation, 'primary'));
    if (view.level === LEVELS.critical && hasResult) {
      actions.append(makeButton('查看完整结果', scrollToLatestResult));
    }
    banner.append(content, actions);

    if (banner.parentElement !== parent || banner.nextElementSibling !== form) {
      parent.insertBefore(banner, form);
    }
  };

  const requestNativeStop = () => {
    if (state.stopRequested) {
      return;
    }
    const button = document.querySelector('[data-testid="stop-generation-button"]');
    if (!button || button.disabled) {
      return;
    }
    state.stopRequested = true;
    button.click();
  };

  const patchRecursionAlert = (alert) => {
    if (!alert || !isRecursionError(alert.textContent)) {
      return;
    }
    if (alert.querySelector('[data-context-safety-recursion-body]')) {
      return;
    }
    const original = state.recursionOriginals.get(alert) || String(alert.textContent || '').trim();
    state.recursionOriginals.set(alert, original);

    const body = document.createElement('div');
    body.dataset.contextSafetyRecursionBody = 'true';
    body.className = 'context-safety-recursion-body';
    const message = document.createElement('p');
    message.className = 'context-safety-recursion-message';
    message.textContent = MESSAGES.recursion;
    const details = document.createElement('details');
    details.className = 'context-safety-recursion-details';
    const summary = document.createElement('summary');
    summary.textContent = '技术详情';
    const detailText = document.createElement('pre');
    detailText.textContent = original;
    details.append(summary, detailText);
    body.append(message, details);
    alert.dataset.contextSafetyRecursionPatched = 'true';
    alert.replaceChildren(body);
  };

  const patchRecursionErrors = () => {
    for (const alert of document.querySelectorAll('[role="alert"]')) {
      patchRecursionAlert(alert);
    }
  };

  const refresh = () => {
    state.scheduled = false;
    const view = getContextView();
    const nextLevel = view?.level || LEVELS.none;
    if (nextLevel !== LEVELS.critical && state.level === LEVELS.critical) {
      state.stopRequested = false;
    }
    state.level = nextLevel;
    state.percent = view?.percent ?? null;
    ensureBanner(view);
    if (nextLevel === LEVELS.critical) {
      requestNativeStop();
    }
    patchRecursionErrors();
    restoreHandoffDraft();
  };

  const scheduleRefresh = () => {
    if (state.scheduled) {
      return;
    }
    state.scheduled = true;
    root.requestAnimationFrame(refresh);
  };

  const isCriticalNow = () => getContextView()?.level === LEVELS.critical;
  const stopEvent = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    scheduleRefresh();
  };

  document.addEventListener(
    'submit',
    (event) => {
      const { form } = getComposer();
      if (form && event.target === form && isCriticalNow()) {
        stopEvent(event);
      }
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target?.closest?.('[data-testid="send-button"]');
      if (target && isCriticalNow()) {
        stopEvent(event);
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      const { textarea } = getComposer();
      if (
        textarea &&
        event.target === textarea &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing &&
        isCriticalNow()
      ) {
        stopEvent(event);
      }
    },
    true,
  );

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-valuenow', 'aria-valuemax', 'data-testid', 'class'],
  });
  root.addEventListener('popstate', scheduleRefresh);
  root.addEventListener('hashchange', scheduleRefresh);

  root.__contextSafetyUIRuntime = Object.freeze({
    getSnapshot: () =>
      Object.freeze({
        level: state.level,
        percent: state.percent,
        stopRequested: state.stopRequested,
        bannerCount: document.querySelectorAll('#context-safety-ui-banner').length,
        patchedRecursionCount: document.querySelectorAll(
          '[data-context-safety-recursion-patched="true"]',
        ).length,
      }),
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRefresh, { once: true });
  } else {
    scheduleRefresh();
  }
})();
