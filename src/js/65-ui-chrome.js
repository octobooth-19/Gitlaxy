/* Gitlaxy — 65-ui-chrome.js
 * Lean app chrome: intro, loading, toasts, toolbar, Big Bang timeline, merge bar and activity feed.
 */
(() => {
  'use strict';
  const GLX = window.GLX;
  const { util } = GLX;
  const { el } = util;

  let H = {};
  let root, intro, introInput, introError, mergeForm, mergeA, mergeB;
  let loading, loadingMsg, toasts, toolbar, soundBtn, constBtn;
  let timeline, tlPlay, tlRange, tlDate, tlStart, tlEnd;
  let mergeBar, mbPlay, mbLabel, mbFill;
  let tickerBox;
  let introOpen = false, scrubbing = false;
  const tl = { t0: 0, t1: 1, reveal: -1, playing: null, month: '' };
  const mb = { label: '', progress: -1, playing: null };

  const call = (name, ...args) => {
    const fn = H[name];
    if (typeof fn === 'function') fn(...args);
  };
  const iconBtn = (name, label, key, onClick) =>
    el('button', { class: 'icon-btn ch-tool', type: 'button', 'aria-label': label + (key ? ' (' + key + ')' : ''), 'data-tip': label + (key ? ' · ' + key : ''), html: GLX.icon(name, 18), on: { click: onClick } });
  const show = (node, on) => {
    if (!node) return;
    node.classList.toggle('ch-show', !!on);
    node.setAttribute('aria-hidden', on ? 'false' : 'true');
  };

  function buildIntro() {
    introInput = el('input', { class: 'ch-input', name: 'login', placeholder: 'github-username', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'GitHub username' });
    introError = el('p', { class: 'ch-error', role: 'alert' });
    mergeA = el('input', { class: 'ch-input', placeholder: 'you', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'First GitHub username' });
    mergeB = el('input', { class: 'ch-input', placeholder: 'friend', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Second GitHub username' });
    mergeForm = el('form', { class: 'ch-merge', hidden: true, on: { submit: (e) => { e.preventDefault(); call('onMerge', mergeA.value, mergeB.value); } } },
      el('div', { class: 'ch-merge-row' },
        el('label', { class: 'ch-field ch-field-sm' }, el('span', { class: 'ch-at', text: '@' }), mergeA),
        el('span', { class: 'ch-x', text: '⨯', 'aria-hidden': 'true' }),
        el('label', { class: 'ch-field ch-field-sm' }, el('span', { class: 'ch-at', text: '@' }), mergeB),
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Collide' })));
    intro = el('section', { class: 'ch-intro', 'aria-label': 'Gitlaxy' },
      el('div', { class: 'ch-intro-inner' },
        el('div', { class: 'ch-eyebrow', text: '✦ GitHub Hackathon' }),
        el('h1', { class: 'ch-wordmark', text: 'Gitlaxy' }),
        el('p', { class: 'ch-tagline', text: 'Every repo is a star. Every language, a spiral arm.' }),
        el('form', { class: 'ch-launch', on: { submit: (e) => { e.preventDefault(); launch(); } } },
          el('label', { class: 'ch-field' }, el('span', { class: 'ch-at', text: '@' }), introInput),
          el('button', { class: 'btn btn-primary ch-go', type: 'submit', text: 'Launch ✦' })),
        introError,
        el('div', { class: 'ch-actions' },
          el('button', { class: 'btn', type: 'button', text: '✦ Explore a demo galaxy', on: { click: () => call('onDemo') } }),
          el('button', { class: 'btn', type: 'button', html: GLX.icon('merge', 16) + '<span>git merge @mona ⨯ @hubot</span>', on: { click: () => call('onMergeDemo') } })),
        el('button', { class: 'ch-link', type: 'button', text: 'or merge two real GitHub users →', on: { click: () => { mergeForm.hidden = !mergeForm.hidden; if (!mergeForm.hidden) mergeA.focus(); } } }),
        mergeForm,
        el('p', { class: 'ch-footer', text: 'Zero dependencies · Your data stays in your browser · Built with GitHub Copilot' })));
    return intro;
  }

  function launch() {
    const v = introInput.value.trim();
    if (!v) {
      introError.textContent = 'Type a GitHub username — or explore the demo galaxy.';
      intro.classList.remove('ch-shake');
      void intro.offsetWidth;
      intro.classList.add('ch-shake');
      return;
    }
    call('onLaunch', v);
  }

  function buildTimeline() {
    tlPlay = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Play / pause (Space)', html: GLX.icon('pause', 18), on: { click: () => call('onPlayPause') } });
    tlRange = el('input', { class: 'ch-range', type: 'range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Timeline' });
    tlRange.addEventListener('pointerdown', () => { scrubbing = true; });
    window.addEventListener('pointerup', () => { scrubbing = false; });
    tlRange.addEventListener('input', () => {
      const v = Number(tlRange.value) / 1000;
      tlRange.style.setProperty('--p', (v * 100).toFixed(2) + '%');
      call('onScrub', v);
    });
    tlDate = el('div', { class: 'ch-date', text: '' });
    tlStart = el('span', { text: '' });
    tlEnd = el('span', { text: '' });
    timeline = el('div', { class: 'ch-timeline glass', 'aria-hidden': 'true' },
      tlPlay,
      el('div', { class: 'ch-track' }, tlRange, el('div', { class: 'ch-ends' }, tlStart, tlEnd)),
      tlDate);
    return timeline;
  }

  function buildMergeBar() {
    mbPlay = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Play / pause (Space)', html: GLX.icon('pause', 18), on: { click: () => call('onPlayPause') } });
    mbLabel = el('div', { class: 'ch-mb-label', text: 'Approach' });
    mbFill = el('div', { class: 'ch-mb-fill' });
    mergeBar = el('div', { class: 'ch-mergebar glass', 'aria-hidden': 'true' },
      mbPlay,
      el('div', { class: 'ch-mb-main' }, mbLabel, el('div', { class: 'ch-mb-bar' }, mbFill)),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Replay merge', html: GLX.icon('replay', 18), on: { click: () => call('onMergeRestart') } }));
    return mergeBar;
  }

  function init(handlers) {
    H = handlers || {};
    root = document.getElementById('glx-chrome-root');
    loadingMsg = el('p', { class: 'ch-loading-msg', 'aria-live': 'polite', text: '' });
    loading = el('div', { class: 'ch-loading', 'aria-hidden': 'true' },
      el('div', { class: 'ch-spinner', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
      loadingMsg,
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', on: { click: () => call('onCancelLoading') } }));
    toasts = el('div', { class: 'ch-toasts', 'aria-live': 'polite' });
    soundBtn = iconBtn('sound', 'Sound', 'M', () => call('onSound'));
    constBtn = iconBtn('constellation', 'Constellations', 'C', () => call('onConstellations'));
    toolbar = el('div', { class: 'ch-toolbar', 'aria-hidden': 'true' },
      constBtn,
      soundBtn,
      iconBtn('image', 'Download poster', 'P', () => call('onPoster')),
      iconBtn('home', 'Home', 'Esc', () => call('onHome')));
    tickerBox = el('div', { class: 'ch-ticker', 'aria-live': 'polite' });
    root.append(buildIntro(), buildTimeline(), buildMergeBar(), toolbar, tickerBox, loading, toasts);
  }

  // ------------------------------------------------------------------ intro & loading
  function showIntro(opts = {}) {
    introOpen = true;
    introError.textContent = opts.error || '';
    if (opts.prefill != null && opts.prefill !== '') introInput.value = opts.prefill;
    show(intro, true);
    if (!util.isMobile()) setTimeout(() => { if (introOpen) introInput.focus(); }, 60);
  }
  function hideIntro() {
    introOpen = false;
    show(intro, false);
    if (document.activeElement && intro.contains(document.activeElement)) document.activeElement.blur();
  }
  function showLoading(msg) {
    loadingMsg.textContent = msg || 'Loading…';
    show(loading, true);
  }
  const setLoading = (msg) => { loadingMsg.textContent = msg || ''; };
  const hideLoading = () => show(loading, false);

  // ------------------------------------------------------------------ toasts
  const TOAST_ICON = { info: 'sparkle', success: 'check', warn: 'alert', error: 'alert' };
  function toast(message, opts = {}) {
    const type = opts.type || 'info';
    let timer = null;
    const node = el('div', { class: 'ch-toast glass ch-toast-' + type, role: type === 'error' ? 'alert' : 'status' },
      el('span', { class: 'ch-toast-icon', html: GLX.icon(TOAST_ICON[type] || 'sparkle', 16) }),
      el('span', { class: 'ch-toast-text', text: String(message) }));
    const close = () => {
      if (timer) clearTimeout(timer);
      if (!node.isConnected) return;
      node.classList.add('ch-out');
      setTimeout(() => node.remove(), 260);
    };
    if (opts.action && opts.action.label) {
      node.append(el('button', { class: 'ch-toast-action', type: 'button', text: opts.action.label, on: { click: () => { close(); opts.action.fn && opts.action.fn(); } } }));
    }
    node.append(el('button', { class: 'ch-toast-close', type: 'button', 'aria-label': 'Dismiss', html: GLX.icon('close', 14), on: { click: close } }));
    toasts.append(node);
    while (toasts.children.length > 3) toasts.firstChild.remove();
    const timeout = opts.timeout == null ? 4500 : opts.timeout;
    if (timeout > 0) timer = setTimeout(close, timeout);
    return { close };
  }

  // ------------------------------------------------------------------ toolbar
  function showToolbar(mode) {
    constBtn.hidden = mode === 'merge';
    show(toolbar, true);
  }
  const hideToolbar = () => show(toolbar, false);
  function setSound(on) {
    soundBtn.innerHTML = GLX.icon(on ? 'sound' : 'mute', 18);
    soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const setConstellations = (on) => constBtn.setAttribute('aria-pressed', on ? 'true' : 'false');

  // ------------------------------------------------------------------ timeline (per-frame updates are cached)
  function showTimeline(t0, t1) {
    tl.t0 = t0; tl.t1 = t1; tl.reveal = -1; tl.playing = null; tl.month = '';
    tlStart.textContent = 'Big Bang · ' + util.fmtDate(t0);
    tlEnd.textContent = 'Today';
    show(timeline, true);
  }
  function updateTimeline(reveal, playing) {
    if (playing !== tl.playing) {
      tl.playing = playing;
      tlPlay.innerHTML = GLX.icon(playing ? 'pause' : reveal >= 1 ? 'replay' : 'play', 18);
    }
    if (!scrubbing && Math.abs(reveal - tl.reveal) >= 0.001) {
      tl.reveal = reveal;
      tlRange.value = String(Math.round(reveal * 1000));
      tlRange.style.setProperty('--p', (reveal * 100).toFixed(2) + '%');
      if (reveal >= 1 && !playing) tlPlay.innerHTML = GLX.icon('replay', 18);
    }
    const label = util.fmtDate(tl.t0 + Math.max(0, Math.min(1, reveal)) * (tl.t1 - tl.t0));
    if (label !== tl.month) {
      tl.month = label;
      tlDate.textContent = label;
    }
  }
  const hideTimeline = () => show(timeline, false);

  // ------------------------------------------------------------------ merge bar
  function showMergeBar() {
    mb.label = ''; mb.progress = -1; mb.playing = null;
    show(mergeBar, true);
  }
  function updateMergeBar(s) {
    if (s.label !== mb.label) { mb.label = s.label; mbLabel.textContent = s.label; }
    if (Math.abs(s.progress - mb.progress) >= 0.002) { mb.progress = s.progress; mbFill.style.transform = 'scaleX(' + s.progress.toFixed(3) + ')'; }
    if (s.playing !== mb.playing) { mb.playing = s.playing; mbPlay.innerHTML = GLX.icon(s.playing ? 'pause' : 'play', 18); }
  }
  const hideMergeBar = () => show(mergeBar, false);

  // ------------------------------------------------------------------ activity ticker
  function ticker(item) {
    const node = el('div', { class: 'ch-tick glass' },
      el('span', { class: 'ch-tick-icon', style: { background: item.color || '#c9d1d9' }, text: item.icon || '•' }),
      el('span', { class: 'ch-tick-body' }, el('span', { class: 'ch-tick-text', text: item.text || '' }), item.sub ? el('span', { class: 'ch-tick-sub', text: item.sub }) : null));
    tickerBox.prepend(node);
    while (tickerBox.children.length > 4) tickerBox.lastChild.remove();
    setTimeout(() => { node.classList.add('ch-out'); setTimeout(() => node.remove(), 400); }, 6000);
  }
  const clearTicker = () => { if (tickerBox) tickerBox.textContent = ''; };

  function showHelp() {
    toast('Drag to orbit · scroll to zoom · click a star · ←/→ next star · Space play/pause · C constellations · M mute · P poster · Esc back', { type: 'info', timeout: 9000 });
  }

  GLX.Chrome = {
    init,
    showIntro, hideIntro, get introOpen() { return introOpen; },
    showLoading, setLoading, hideLoading,
    toast,
    showToolbar, hideToolbar, setSound, setConstellations,
    showTimeline, updateTimeline, hideTimeline,
    showMergeBar, updateMergeBar, hideMergeBar,
    showHelp, hideHelp() {}, get helpOpen() { return false; },
    openMergeDialog() {}, openTokenDialog() {},
    closeAllModals() { return false; },
    ticker, clearTicker
  };
})();
