(() => {
  if (window.__librechatGeneratedFilesTabInstalled) return;
  window.__librechatGeneratedFilesTabInstalled = true;

  const PAGE_SIZE = 20;
  const dialogStates = new WeakMap();

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  const formatBytes = (value) => {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  };

  const formatDate = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  };

  const fileKind = (file) => {
    const name = String(file.filename || '');
    const extension = name.includes('.') ? name.split('.').pop().toUpperCase() : '';
    if (extension) return extension;
    return String(file.type || '文件').split('/').pop().toUpperCase();
  };

  const fileIcon = (file) => {
    const kind = fileKind(file);
    const className = /PPT|PPTX|ODP/.test(kind)
      ? 'presentation'
      : /XLS|XLSX|XLSM|CSV|TSV|ODS/.test(kind)
        ? 'spreadsheet'
        : /DOC|DOCX|ODT|MD|TXT/.test(kind)
          ? 'document'
          : kind === 'PDF'
            ? 'pdf'
            : /PNG|JPG|JPEG|WEBP|GIF|SVG/.test(kind)
              ? 'image'
              : 'file';
    return `<span class="lc-generated-file-icon" data-kind="${className}" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
      </svg>
    </span>`;
  };

  function findDialogParts(dialog) {
    const title = Array.from(dialog.querySelectorAll('h1,h2,h3,[role="heading"]')).find((node) =>
      ['我的文件', 'My Files'].includes(node.textContent?.trim()),
    );
    if (!title) return null;
    const table = dialog.querySelector('table');
    const tableWrap = table?.parentElement;
    const toolbar = tableWrap?.previousElementSibling;
    const pagination = tableWrap?.nextElementSibling;
    if (!tableWrap || !toolbar || !pagination) return null;
    return { title, header: title.parentElement, nativeSections: [toolbar, tableWrap, pagination] };
  }

  function setActiveView(state, view) {
    state.view = view;
    const generated = view === 'generated';
    state.nativeSections.forEach((section, index) => {
      section.hidden = generated;
      if (generated) {
        section.style.setProperty('display', 'none', 'important');
        return;
      }
      const original = state.nativeDisplays[index];
      if (original.value) {
        section.style.setProperty('display', original.value, original.priority);
      } else {
        section.style.removeProperty('display');
      }
    });
    state.panel.hidden = !generated;
    state.tabs.querySelectorAll('[role="tab"]').forEach((tab) => {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    if (generated && !state.loaded) loadFiles(state);
  }

  function renderLoading(state) {
    state.body.innerHTML = '<div class="lc-generated-files-state"><span class="lc-generated-files-spinner" aria-hidden="true"></span>正在加载生成的文件</div>';
  }

  function renderError(state) {
    state.body.innerHTML = `<div class="lc-generated-files-state lc-generated-files-error">
      <span>生成的文件暂时无法加载</span>
      <button type="button" data-action="retry">重试</button>
    </div>`;
  }

  function renderEmpty(state) {
    const text = state.query ? '没有匹配的生成文件' : '暂无生成的文件';
    const detail = state.query ? '请尝试其他文件名' : '对话中交付的文档、表格和演示文稿会显示在这里';
    state.body.innerHTML = `<div class="lc-generated-files-state lc-generated-files-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M8 13h8M8 17h5"></path></svg>
      <strong>${text}</strong><span>${detail}</span>
    </div>`;
  }

  function renderRows(state) {
    if (!state.data?.files?.length) {
      renderEmpty(state);
      state.footer.hidden = true;
      return;
    }
    state.footer.hidden = false;
    state.body.innerHTML = `<div class="lc-generated-files-table-wrap">
      <table class="lc-generated-files-table">
        <thead><tr><th>文件名</th><th>类型</th><th>大小</th><th>来源对话</th><th>生成时间</th><th><span class="sr-only">操作</span></th></tr></thead>
        <tbody>${state.data.files
          .map(
            (file) => `<tr>
              <td><div class="lc-generated-file-name">${fileIcon(file)}<span title="${escapeHtml(file.filename)}">${escapeHtml(file.filename)}</span></div></td>
              <td>${escapeHtml(fileKind(file))}</td>
              <td>${escapeHtml(formatBytes(file.bytes))}</td>
              <td>${file.conversationPath ? `<a class="lc-generated-conversation-link" href="${escapeHtml(file.conversationPath)}">查看对话</a>` : '-'}</td>
              <td>${escapeHtml(formatDate(file.generatedAt || file.updatedAt))}</td>
              <td><a class="lc-generated-download" href="${escapeHtml(file.downloadPath)}" aria-label="下载 ${escapeHtml(file.filename)}" title="下载">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" x2="12" y1="15" y2="3"></line></svg>
              </a></td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>`;
    const { page, pages, total } = state.data.pagination;
    state.footer.innerHTML = `<span>共 ${total} 个生成文件</span><div>
      <button type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span>${page} / ${pages}</span>
      <button type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button>
    </div>`;
  }

  async function loadFiles(state) {
    state.controller?.abort();
    state.controller = new AbortController();
    state.loaded = true;
    renderLoading(state);
    state.footer.hidden = true;
    const params = new URLSearchParams({
      page: String(state.page),
      limit: String(PAGE_SIZE),
    });
    if (state.query) params.set('query', state.query);
    try {
      const response = await fetch(`/api/user/generated-files?${params}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: state.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.data = await response.json();
      renderRows(state);
    } catch (error) {
      if (error.name !== 'AbortError') renderError(state);
    }
  }

  function createGeneratedPanel(state) {
    const panel = document.createElement('section');
    panel.className = 'lc-generated-files-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-label', '生成的文件');
    panel.innerHTML = `<div class="lc-generated-files-toolbar">
      <div><h2>生成的文件</h2><p>对话中已交付、可下载的文件</p></div>
      <div class="lc-generated-files-actions">
        <label><span class="sr-only">搜索生成的文件</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg><input type="search" placeholder="搜索文件名" autocomplete="off" /></label>
        <button type="button" data-action="refresh" aria-label="刷新生成的文件" title="刷新"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"></path><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"></path></svg></button>
      </div>
    </div><div class="lc-generated-files-body"></div><footer class="lc-generated-files-footer" hidden></footer>`;
    state.body = panel.querySelector('.lc-generated-files-body');
    state.footer = panel.querySelector('.lc-generated-files-footer');
    let searchTimer;
    panel.querySelector('input').addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = event.target.value.trim();
        state.page = 1;
        loadFiles(state);
      }, 250);
    });
    panel.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'refresh' || action === 'retry') loadFiles(state);
      const page = Number(event.target.closest('[data-page]')?.dataset.page);
      if (page > 0 && page !== state.page) {
        state.page = page;
        loadFiles(state);
      }
    });
    return panel;
  }

  function installDialog(dialog) {
    if (dialogStates.has(dialog) || dialog.dataset.generatedFilesTabs === 'true') return;
    const parts = findDialogParts(dialog);
    if (!parts) return;
    dialog.dataset.generatedFilesTabs = 'true';
    const tabs = document.createElement('div');
    tabs.className = 'lc-generated-files-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '文件分类');
    tabs.innerHTML = `<button type="button" role="tab" data-view="uploads" aria-selected="true">上传的文件</button><button type="button" role="tab" data-view="generated" aria-selected="false" tabindex="-1">生成的文件</button>`;
    const state = {
      ...parts,
      dialog,
      tabs,
      panel: null,
      body: null,
      footer: null,
      view: 'uploads',
      page: 1,
      query: '',
      data: null,
      loaded: false,
      controller: null,
      nativeDisplays: parts.nativeSections.map((section) => ({
        value: section.style.getPropertyValue('display'),
        priority: section.style.getPropertyPriority('display'),
      })),
    };
    state.panel = createGeneratedPanel(state);
    parts.header.insertAdjacentElement('afterend', tabs);
    tabs.insertAdjacentElement('afterend', state.panel);
    tabs.addEventListener('click', (event) => {
      const view = event.target.closest('[data-view]')?.dataset.view;
      if (view) setActiveView(state, view);
    });
    dialogStates.set(dialog, state);
  }

  function scan() {
    document.querySelectorAll('[role="dialog"]').forEach(installDialog);
  }

  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
