(() => {
  if (window.__odysseiaLoginPatchInstalled) {
    return;
  }
  window.__odysseiaLoginPatchInstalled = true;

  const PATCH_ID = 'odysseia-login-page-patch';
  const STYLE_ID = 'odysseia-login-page-style';
  const BACKDROP_ID = 'odysseia-login-backdrop';
  const VIDEO_URL = 'https://image01.vidu.zone/vidu/landing-page/login-bg.c7293340.mp4';

  const panelArt = `
    <span class="odysseia-panel-oracle-ring"></span>
    <span class="odysseia-panel-moon"></span>
    <span class="odysseia-panel-pediment"></span>
    <span class="odysseia-panel-column odysseia-column-left"></span>
    <span class="odysseia-panel-column odysseia-column-right"></span>
    <span class="odysseia-panel-mist odysseia-panel-mist-a"></span>
    <span class="odysseia-panel-mist odysseia-panel-mist-b"></span>
  `;

  const css = `
    body.odysseia-login-active {
      min-height: 100vh !important;
      background: #05070d !important;
      color: #f8fafc;
      overflow: hidden;
    }

    body.odysseia-login-active #root {
      position: relative;
      z-index: 2;
      min-height: 100vh;
      background: transparent !important;
    }

    body.odysseia-login-active [data-odysseia-login-shell="true"] {
      position: relative !important;
      display: flex !important;
      min-height: 100vh !important;
      width: 100% !important;
      align-items: center !important;
      justify-content: flex-end !important;
      padding: 32px clamp(28px, 6vw, 96px) !important;
      background: transparent !important;
    }

    #${BACKDROP_ID} {
      position: fixed;
      inset: 0;
      z-index: 0;
      display: none;
      overflow: hidden;
      pointer-events: none;
      background:
        radial-gradient(circle at 35% 38%, rgba(248, 217, 144, 0.12), transparent 28%),
        radial-gradient(circle at 76% 50%, rgba(56, 189, 248, 0.1), transparent 28%),
        #05070d;
    }

    body.odysseia-login-active #${BACKDROP_ID} {
      display: block;
    }

    #${BACKDROP_ID} video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
      filter: saturate(1.02) contrast(1.02) brightness(1);
    }

    #${BACKDROP_ID} .odysseia-stage {
      position: absolute;
      inset: 0;
      opacity: 0.72;
      mix-blend-mode: screen;
    }

    #${BACKDROP_ID} .odysseia-stage::before {
      position: absolute;
      top: clamp(38px, 6vh, 74px);
      left: 39%;
      width: min(84vw, 980px);
      height: min(30vw, 320px);
      border-top: 1px solid rgba(248, 217, 144, 0.22);
      background:
        radial-gradient(ellipse at 50% 0%, rgba(248, 217, 144, 0.2), transparent 45%),
        linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.08) 20% 80%, transparent);
      clip-path: polygon(50% 0, 100% 100%, 87% 100%, 50% 18%, 13% 100%, 0 100%);
      content: "";
      opacity: 0.28;
      transform: translateX(-50%);
    }

    #${BACKDROP_ID} .odysseia-stage::after {
      position: absolute;
      left: 39%;
      bottom: -7vh;
      width: 72vw;
      height: 26vh;
      border-radius: 999px;
      background:
        radial-gradient(ellipse at 50% 50%, rgba(186, 230, 253, 0.16), transparent 62%),
        radial-gradient(ellipse at 32% 60%, rgba(248, 217, 144, 0.08), transparent 48%);
      filter: blur(34px);
      content: "";
      opacity: 0.42;
      transform: translateX(-50%);
      animation: odysseia-mist-drift 16s ease-in-out infinite;
    }

    body.odysseia-login-active .odysseia-login-panel {
      position: relative !important;
      width: min(100%, 408px) !important;
      max-width: 408px !important;
      margin: 0 !important;
      padding: 40px 32px 32px !important;
      overflow: hidden !important;
      border: 1px solid rgba(255, 255, 255, 0.14) !important;
      border-radius: 8px !important;
      background:
        radial-gradient(circle at 50% -12%, rgba(255, 255, 255, 0.16), transparent 30%),
        radial-gradient(circle at 16% 0%, rgba(125, 211, 252, 0.13), transparent 34%),
        linear-gradient(145deg, rgba(255, 255, 255, 0.08), transparent 26%),
        linear-gradient(180deg, rgba(14, 19, 29, 0.76), rgba(8, 13, 22, 0.64)),
        rgba(7, 11, 19, 0.7) !important;
      box-shadow:
        0 34px 110px rgba(0, 0, 0, 0.38),
        0 0 0 1px rgba(125, 211, 252, 0.06),
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        inset 0 -1px 0 rgba(255, 255, 255, 0.06) !important;
      backdrop-filter: blur(24px) saturate(1.18);
      text-align: center !important;
      text-shadow: 0 2px 20px rgba(6, 12, 22, 0.42);
    }

    body.odysseia-login-active .odysseia-login-panel::before {
      position: absolute;
      inset: 0;
      z-index: 0;
      border-radius: inherit;
      background:
        repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.035) 0 1px, transparent 1px 22px),
        linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.045), transparent);
      content: "";
      opacity: 0.34;
      pointer-events: none;
    }

    .odysseia-panel-mythic {
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
    }

    .odysseia-panel-oracle-ring {
      position: absolute;
      top: -96px;
      left: 50%;
      width: 250px;
      height: 250px;
      border: 1px solid rgba(186, 230, 253, 0.15);
      border-radius: 50%;
      background:
        repeating-conic-gradient(from 12deg, rgba(248, 217, 144, 0.16) 0 1deg, transparent 1deg 14deg),
        radial-gradient(circle, transparent 0 57%, rgba(125, 211, 252, 0.1) 58% 60%, transparent 61%);
      box-shadow:
        0 0 52px rgba(125, 211, 252, 0.08),
        inset 0 0 44px rgba(248, 217, 144, 0.05);
      opacity: 0.48;
      transform: translateX(-50%);
      animation: odysseia-oracle-drift 11s ease-in-out infinite;
    }

    .odysseia-panel-moon {
      position: absolute;
      top: 18px;
      right: 18px;
      width: 54px;
      height: 54px;
      border: 1px solid rgba(248, 217, 144, 0.28);
      border-radius: 50%;
      box-shadow:
        inset -18px -7px 0 rgba(7, 12, 22, 0.78),
        0 0 28px rgba(248, 217, 144, 0.1);
      opacity: 0.34;
      animation: odysseia-moon-breathe 8s ease-in-out infinite;
    }

    .odysseia-panel-pediment {
      position: absolute;
      right: 58px;
      bottom: 66px;
      left: 58px;
      height: 68px;
      border-top: 1px solid rgba(248, 217, 144, 0.18);
      background:
        radial-gradient(ellipse at 50% 0%, rgba(248, 217, 144, 0.13), transparent 56%),
        linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.08), transparent);
      clip-path: polygon(50% 0, 100% 100%, 87% 100%, 50% 28%, 13% 100%, 0 100%);
      opacity: 0.46;
    }

    .odysseia-panel-column {
      position: absolute;
      bottom: 28px;
      width: 18px;
      height: 98px;
      border: 1px solid rgba(248, 217, 144, 0.12);
      background:
        repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.08) 0 1px, transparent 1px 6px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.05), rgba(186, 230, 253, 0.1), rgba(4, 8, 16, 0.2));
      box-shadow: 0 0 24px rgba(248, 217, 144, 0.06);
      opacity: 0.38;
    }

    .odysseia-column-left {
      left: 72px;
    }

    .odysseia-column-right {
      right: 72px;
    }

    .odysseia-panel-mist {
      position: absolute;
      bottom: -28px;
      left: 50%;
      width: 92%;
      height: 84px;
      border-radius: 999px;
      background:
        radial-gradient(ellipse at 50% 50%, rgba(186, 230, 253, 0.14), transparent 62%),
        radial-gradient(ellipse at 34% 42%, rgba(248, 217, 144, 0.08), transparent 48%);
      filter: blur(24px);
      opacity: 0.38;
      transform: translateX(-50%);
    }

    .odysseia-panel-mist-b {
      bottom: 46px;
      width: 72%;
      height: 44px;
      opacity: 0.18;
      animation: odysseia-mist-drift 14s ease-in-out infinite;
    }

    .odysseia-login-header {
      position: relative;
      z-index: 1;
      margin: 0 0 30px;
      text-align: center;
    }

    .odysseia-login-eyebrow {
      margin: 0 0 14px;
      color: rgba(186, 230, 253, 0.78);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }

    .odysseia-login-title {
      width: 100%;
      margin: 0 auto;
      color: #f8fafc;
      font-size: clamp(25px, 2.3vw, 30px);
      font-weight: 400;
      line-height: 1.12;
      letter-spacing: 0;
      text-align: center;
      white-space: nowrap;
    }

    body.odysseia-login-active .odysseia-login-panel > *:not(.odysseia-panel-mythic) {
      position: relative;
      z-index: 1;
    }

    body.odysseia-login-active [data-odysseia-original-heading="true"] {
      display: none !important;
    }

    body.odysseia-login-active .odysseia-login-panel input {
      min-height: 54px !important;
      border: 1px solid rgba(148, 163, 184, 0.24) !important;
      border-radius: 16px !important;
      background: rgba(12, 18, 32, 0.72) !important;
      color: #f8fafc !important;
      box-shadow:
        0 18px 60px rgba(0, 0, 0, 0.22),
        inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
      backdrop-filter: blur(18px);
    }

    body.odysseia-login-active .odysseia-login-panel input::placeholder {
      color: rgba(203, 213, 225, 0.62) !important;
    }

    body.odysseia-login-active .odysseia-login-panel button {
      min-height: 48px;
      border-radius: 16px !important;
    }

    body.odysseia-login-active .odysseia-login-panel button[type="submit"],
    body.odysseia-login-active .odysseia-login-panel form button,
    body.odysseia-login-active .odysseia-login-panel [role="button"] {
      font-weight: 700;
    }

    @keyframes odysseia-oracle-drift {
      0%,
      100% {
        transform: translate(-50%, -52%) scale(1);
      }

      50% {
        transform: translate(-50%, -54%) scale(1.025);
      }
    }

    @keyframes odysseia-moon-breathe {
      0%,
      100% {
        opacity: 0.34;
        transform: scale(1);
      }

      50% {
        opacity: 0.46;
        transform: scale(1.04);
      }
    }

    @keyframes odysseia-mist-drift {
      0%,
      100% {
        transform: translateX(-54%) translateY(0);
      }

      50% {
        transform: translateX(-46%) translateY(-14px);
      }
    }

    @media (max-width: 840px) {
      body.odysseia-login-active [data-odysseia-login-shell="true"] {
        justify-content: center !important;
        padding: 32px 24px !important;
      }
    }

    @media (max-width: 640px) {
      body.odysseia-login-active {
        overflow: auto;
      }

      body.odysseia-login-active [data-odysseia-login-shell="true"] {
        padding: 28px 22px !important;
      }

      body.odysseia-login-active .odysseia-login-panel {
        padding: 36px 24px 28px !important;
      }

      .odysseia-login-title {
        font-size: clamp(22px, 6.4vw, 28px);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #${BACKDROP_ID} video {
        display: none;
      }

      .odysseia-panel-oracle-ring,
      .odysseia-panel-moon,
      .odysseia-panel-mist-b,
      #${BACKDROP_ID} .odysseia-stage::after {
        animation: none !important;
      }
    }
  `;

  const hasOwn = (element, selector) => element && element.querySelector(selector);

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.append(style);
  };

  const ensureBackdrop = () => {
    if (document.getElementById(BACKDROP_ID)) {
      return;
    }
    const backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID;
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = `
      <video autoplay muted loop playsinline preload="auto">
        <source src="${VIDEO_URL}" type="video/mp4">
      </video>
      <span class="odysseia-stage"></span>
    `;
    document.body.prepend(backdrop);
  };

  const getText = (element) => (element?.textContent || '').replace(/\s+/g, ' ').trim();

  const isLikelyLoginPage = () => {
    const password = document.querySelector('input[type="password"]');
    const email = document.querySelector(
      'input[type="email"], input[name*="email" i], input[autocomplete="email"], input[autocomplete="username"]',
    );
    if (!password || !email) {
      return false;
    }
    const submit = document.querySelector('button, [role="button"], input[type="submit"]');
    return Boolean(submit);
  };

  const findLoginPanel = () => {
    const anchor =
      document.querySelector('input[type="password"]') ||
      document.querySelector('input[type="email"], input[name*="email" i]');
    if (!anchor) {
      return null;
    }

    let node = anchor.closest('form') || anchor.parentElement;
    let best = node;
    for (let depth = 0; node && depth < 8; depth += 1) {
      if (node === document.body || node.id === 'root') {
        break;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width >= 260 && rect.width <= 640 && rect.height >= 160) {
        best = node;
      }
      node = node.parentElement;
    }
    return best;
  };

  const markShell = (panel) => {
    const root = document.getElementById('root');
    const firstChild = root?.firstElementChild;
    const shell = firstChild && firstChild !== panel && firstChild.contains(panel) ? firstChild : root;
    if (shell) {
      shell.dataset.odysseiaLoginShell = 'true';
    }
  };

  const clearShellMarks = () => {
    document
      .querySelectorAll('[data-odysseia-login-shell="true"]')
      .forEach((element) => delete element.dataset.odysseiaLoginShell);
  };

  const decoratePanel = (panel) => {
    panel.classList.add('odysseia-login-panel');

    if (!hasOwn(panel, '.odysseia-panel-mythic')) {
      const mythic = document.createElement('div');
      mythic.className = 'odysseia-panel-mythic';
      mythic.setAttribute('aria-hidden', 'true');
      mythic.innerHTML = panelArt;
      panel.prepend(mythic);
    }

    if (!hasOwn(panel, '.odysseia-login-header')) {
      const header = document.createElement('div');
      header.className = 'odysseia-login-header';
      header.innerHTML = `
        <p class="odysseia-login-eyebrow">Odýsseia Studio</p>
        <h1 class="odysseia-login-title">Start your Agent Studio.</h1>
      `;
      const art = panel.querySelector('.odysseia-panel-mythic');
      art?.after(header);
    }

    panel.querySelectorAll('h1, h2').forEach((heading) => {
      if (heading.closest('.odysseia-login-header')) {
        return;
      }
      const text = getText(heading);
      if (/^(librechat|sign in|log in|welcome|登录|登入|欢迎)/i.test(text)) {
        heading.dataset.odysseiaOriginalHeading = 'true';
      }
    });
  };

  const setActive = (active) => {
    document.body.classList.toggle('odysseia-login-active', active);
    const backdrop = document.getElementById(BACKDROP_ID);
    if (backdrop) {
      backdrop.hidden = !active;
    }
    if (!active) {
      clearShellMarks();
      document
        .querySelectorAll('.odysseia-login-panel')
        .forEach((element) => element.classList.remove('odysseia-login-panel'));
      if (document.title === 'Odýsseia Login') {
        document.title = 'LibreChat';
      }
    }
  };

  const apply = () => {
    ensureStyle();
    if (!document.body || !isLikelyLoginPage()) {
      setActive(false);
      return;
    }

    const panel = findLoginPanel();
    if (!panel) {
      setActive(false);
      return;
    }

    ensureBackdrop();
    setActive(true);
    markShell(panel);
    decoratePanel(panel);
    document.title = 'Odýsseia Login';
  };

  let scheduled = false;
  const schedule = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  };

  if (document.body) {
    schedule();
  } else {
    document.addEventListener('DOMContentLoaded', schedule, { once: true });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);

  window.__odysseiaLoginPatch = Object.freeze({
    id: PATCH_ID,
    version: '2026-07-17',
    videoUrl: VIDEO_URL,
    title: 'Start your Agent Studio.',
  });
})();
