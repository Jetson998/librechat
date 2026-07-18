(() => {
  'use strict';

  const root = typeof window === 'undefined' ? null : window;
  const VERSION = '2026-07-18-search-favicon-v1';
  const GOOGLE_FAVICON_ORIGIN = 'https://www.google.com';
  const GOOGLE_FAVICON_PATH = '/s2/favicons';
  const SELECTOR = 'img[src^="https://www.google.com/s2/favicons"]';
  const COLORS = Object.freeze([
    '#2563eb',
    '#0891b2',
    '#0f766e',
    '#15803d',
    '#7c3aed',
    '#be123c',
    '#475569',
  ]);

  const normalizeDomain = (value) => {
    const domain = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .replace(/^www\./, '')
      .replace(/:\d+$/, '');
    if (
      !domain ||
      domain.length > 253 ||
      domain.includes('..') ||
      !/^[a-z0-9.-]+$/.test(domain)
    ) {
      return '';
    }
    return domain;
  };

  const parseGoogleFaviconDomain = (value) => {
    try {
      const url = new URL(String(value || ''));
      if (url.origin !== GOOGLE_FAVICON_ORIGIN || url.pathname !== GOOGLE_FAVICON_PATH) {
        return '';
      }
      return normalizeDomain(url.searchParams.get('domain'));
    } catch {
      return '';
    }
  };

  const hashDomain = (domain) => {
    let hash = 0;
    for (const char of String(domain || '')) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return hash;
  };

  const createFallbackDataUri = (value) => {
    const domain = normalizeDomain(value);
    const initial = (domain.match(/[a-z0-9]/)?.[0] || 'w').toUpperCase();
    const color = COLORS[hashDomain(domain) % COLORS.length];
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      `<rect width="32" height="32" rx="8" fill="${color}"/>` +
      `<text x="16" y="21" text-anchor="middle" font-family="Arial,sans-serif" ` +
      `font-size="16" font-weight="700" fill="#fff">${initial}</text>` +
      '</svg>';
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  };

  const replaceImage = (image) => {
    if (!image?.getAttribute || image.dataset?.lcSearchFaviconFallback) {
      return false;
    }
    const source = image.getAttribute('src') || '';
    const domain = parseGoogleFaviconDomain(source) || normalizeDomain(image.getAttribute('alt'));
    if (!source.startsWith(`${GOOGLE_FAVICON_ORIGIN}${GOOGLE_FAVICON_PATH}`) || !domain) {
      return false;
    }
    image.dataset.lcSearchFaviconFallback = domain;
    image.setAttribute('referrerpolicy', 'no-referrer');
    image.removeAttribute('srcset');
    image.setAttribute('src', createFallbackDataUri(domain));
    return true;
  };

  const contract = Object.freeze({
    version: VERSION,
    selector: SELECTOR,
    normalizeDomain,
    parseGoogleFaviconDomain,
    hashDomain,
    createFallbackDataUri,
    replaceImage,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = contract;
  }

  if (!root?.document || root.__lcSearchFaviconFallbackInstalled) {
    return;
  }

  root.__lcSearchFaviconFallbackInstalled = true;
  root.__lcSearchFaviconFallbackContract = contract;
  const document = root.document;

  const scan = (node) => {
    if (!node || node.nodeType !== 1) {
      return 0;
    }
    let replaced = 0;
    if (node.matches?.(SELECTOR) && replaceImage(node)) {
      replaced += 1;
    }
    for (const image of node.querySelectorAll?.(SELECTOR) || []) {
      if (replaceImage(image)) {
        replaced += 1;
      }
    }
    return replaced;
  };

  const scanDocument = () => scan(document.documentElement);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        replaceImage(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        scan(node);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
  scanDocument();

  root.__lcSearchFaviconFallbackRuntime = Object.freeze({
    scan: scanDocument,
    getReplacementCount: () =>
      document.querySelectorAll('[data-lc-search-favicon-fallback]').length,
  });
})();
