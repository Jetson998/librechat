(() => {
  if (window.__businessUploadMenuPatchInstalled) {
    return;
  }
  window.__businessUploadMenuPatchInstalled = true;

  const labels = new Map([
    ['上传至提供商', '图片上传'],
    ['Upload to Provider', '图片上传'],
    ['Upload to provider', '图片上传'],
    ['原文件上传', '图片上传'],
    ['作为文本上传', '文件提取文字上传'],
    ['Upload as Text', '文件提取文字上传'],
    ['Upload as text', '文件提取文字上传'],
    ['提取文字上传', '文件提取文字上传'],
    ['Upload to Code Environment', 'Office文件上传'],
    ['Upload to code environment', 'Office文件上传'],
    ['用代码读取文件', 'Office文件上传'],
  ]);

  const imageLabels = new Set([
    '上传至提供商',
    'Upload to Provider',
    'Upload to provider',
    '原文件上传',
    '图片上传',
  ]);
  const officeLabels = new Set([
    'Upload to Code Environment',
    'Upload to code environment',
    '用代码读取文件',
    'Office文件上传',
  ]);
  const textLabels = new Set([
    '作为文本上传',
    'Upload as Text',
    'Upload as text',
    '提取文字上传',
    '文件提取文字上传',
  ]);
  const descriptions = {
    图片上传: '仅图片；用于截图、照片、图像识别',
    Office文件上传: 'Word/Excel/PPT 原文件；可读写并返回文件',
    文件提取文字上传: '转成文本给模型分析；适合审阅总结',
  };
  const displayOrder = ['图片上传', 'Office文件上传', '文件提取文字上传'];
  const displayOrderIndex = new Map(displayOrder.map((label, index) => [label, index]));
  const rules = {
    image: {
      accept: 'image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.heic,.heif,.avif',
      test: (file) =>
        /^image\//i.test(file.type || '') ||
        /\.(png|jpe?g|webp|gif|bmp|svg|heic|heif|avif)$/i.test(file.name || ''),
      message: '图片上传仅支持图片文件。Office/文档请使用 Office文件上传 或 文件提取文字上传。',
    },
    office: {
      accept:
        '.docx,.xlsx,.xlsm,.ppt,.pptx,.csv,.tsv,.ods,.odp,application/msword,application/vnd.ms-excel,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/csv,text/tab-separated-values,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation',
      test: (file) =>
        /\.(docx|xlsx|xlsm|pptx?|csv|tsv|ods|odp)$/i.test(file.name || '') ||
        /^(application\/msword|application\/vnd\.ms-excel|application\/vnd\.ms-powerpoint|text\/csv|text\/tab-separated-values|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/vnd\.ms-excel\.sheet\.macroEnabled\.12|application\/vnd\.oasis\.opendocument\.(spreadsheet|presentation))$/i.test(
          file.type || '',
        ),
      message: 'Office文件上传支持 .docx、.xlsx、.xlsm、.ppt、.pptx、.csv、.tsv、.ods、.odp。',
    },
    text: {
      accept:
        '.pdf,.doc,.docx,.xls,.xlsx,.xlsm,.ppt,.pptx,.txt,.md,.csv,.tsv,.json,.html,.htm,.rtf,.odt,.ods,.odp,text/*,application/pdf,application/msword,application/vnd.ms-excel,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/rtf,application/json,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation',
      test: (file) =>
        /\.(pdf|docx?|xlsx?|xlsm|pptx?|txt|md|csv|tsv|json|html?|rtf|odt|ods|odp)$/i.test(
          file.name || '',
        ) ||
        /^(text\/|application\/pdf|application\/msword|application\/vnd\.ms-excel|application\/vnd\.ms-powerpoint|application\/vnd\.openxmlformats-officedocument\.|application\/rtf|application\/json|application\/vnd\.oasis\.opendocument\.)/i.test(
          file.type || '',
        ),
      message: '文件提取文字上传仅支持文档、表格、PDF 和文本类文件。图片请使用 图片上传。',
    },
  };
  let uploadMode = '';

  window.__businessUploadMenuContract = Object.freeze({
    version: '2026-07-12',
    labels: Object.freeze([...displayOrder]),
    descriptions: Object.freeze({ ...descriptions }),
    accepts: Object.freeze({
      image: rules.image.accept,
      office: rules.office.accept,
      text: rules.text.accept,
    }),
  });

  const getText = (node) => (node?.textContent || '').trim();
  const hasLabel = (text, labelSet) => {
    const normalized = (text || '').replace(/\s+/g, ' ').trim();
    return Array.from(labelSet).some(
      (label) =>
        normalized === label || normalized.startsWith(`${label} `) || normalized.includes(label),
    );
  };
  const closestControl = (node) => {
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return (
      element?.closest?.('[role="menuitem"], [data-radix-collection-item], button, li, div') ||
      element
    );
  };
  const makeDescription = (label) => {
    const description = document.createElement('span');
    description.dataset.businessUploadDescription = 'true';
    description.textContent = descriptions[label];
    description.style.display = 'block';
    description.style.fontSize = '12px';
    description.style.lineHeight = '16px';
    description.style.opacity = '0.72';
    description.style.marginTop = '2px';
    description.style.whiteSpace = 'normal';
    return description;
  };
  const decorateLabelNode = (node) => {
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentNode) {
      return;
    }
    const label = node.nodeValue.trim();
    if (!descriptions[label]) {
      return;
    }
    const control = closestControl(node);
    if (!control || control.querySelector?.('[data-business-upload-description]')) {
      return;
    }

    const wrapper = document.createElement('span');
    wrapper.dataset.businessUploadLabel = 'true';
    wrapper.style.display = 'inline-flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.alignItems = 'flex-start';
    wrapper.style.gap = '0';
    wrapper.style.minWidth = '0';
    wrapper.style.whiteSpace = 'normal';

    const title = document.createElement('span');
    title.textContent = label;
    title.style.display = 'block';
    title.style.lineHeight = '20px';

    wrapper.append(title, makeDescription(label));
    node.parentNode.replaceChild(wrapper, node);
  };
  const getDisplayLabel = (element) => {
    const text = getText(element);
    return displayOrder.find((label) => text.includes(label)) || '';
  };
  const reorderUploadMenus = () => {
    document.querySelectorAll('[role="menu"]').forEach((menu) => {
      const uploadItems = Array.from(menu.children)
        .map((element) => [element, getDisplayLabel(element)])
        .filter(([, label]) => displayOrderIndex.has(label));
      if (uploadItems.length < 2) {
        return;
      }

      const sortedItems = uploadItems
        .slice()
        .sort((a, b) => displayOrderIndex.get(a[1]) - displayOrderIndex.get(b[1]));
      let cursor = uploadItems[0][0];
      for (const [element] of sortedItems) {
        if (element !== cursor) {
          menu.insertBefore(element, cursor);
        }
        cursor = element.nextSibling;
      }
    });
  };
  const setFileInputAccept = (mode) => {
    const input = document.querySelector('input[type="file"]');
    if (!input) {
      return;
    }
    if (rules[mode]) {
      input.setAttribute('accept', rules[mode].accept);
    } else {
      input.removeAttribute('accept');
    }
  };
  const setModeFromText = (text) => {
    if (hasLabel(text, imageLabels)) {
      uploadMode = 'image';
    } else if (hasLabel(text, officeLabels)) {
      uploadMode = 'office';
    } else if (hasLabel(text, textLabels)) {
      uploadMode = 'text';
    } else {
      return;
    }
    setFileInputAccept(uploadMode);
  };
  const patchText = (node) => {
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      return;
    }
    const trimmed = node.nodeValue.trim();
    const next = labels.get(trimmed);
    if (!next) {
      return;
    }
    node.nodeValue = node.nodeValue.replace(trimmed, next);
  };
  const walk = (root) => {
    if (!root) {
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    const nodes = [];
    while ((node = walker.nextNode())) {
      patchText(node);
      nodes.push(node);
    }
    for (const textNode of nodes) {
      decorateLabelNode(textNode);
    }
    reorderUploadMenus();
  };
  const validateUpload = (event) => {
    const input = event.target;
    if (!input || input.type !== 'file' || !rules[uploadMode]) {
      return;
    }
    const files = Array.from(input.files || []);
    if (files.length === 0) {
      return;
    }
    const rule = rules[uploadMode];
    const invalid = files.find((file) => !rule.test(file));
    if (!invalid) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
    input.value = '';
    window.alert(rule.message);
  };

  document.addEventListener(
    'pointerdown',
    (event) => setModeFromText(getText(closestControl(event.target))),
    true,
  );
  document.addEventListener(
    'click',
    (event) => setModeFromText(getText(closestControl(event.target))),
    true,
  );
  document.addEventListener('change', validateUpload, true);

  const run = () => walk(document.body);
  if (document.body) {
    run();
  }
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          patchText(node);
        } else {
          walk(node);
        }
      }
      if (record.type === 'characterData') {
        patchText(record.target);
        decorateLabelNode(record.target);
        reorderUploadMenus();
      }
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
