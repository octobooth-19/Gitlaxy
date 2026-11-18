/* Gitlaxy — 60-ui-hud.js
 * GLX.HUD: profile panel, language legend, star card, hover tooltip, pooled star labels,
 * git-merge header + typewriter status + merge summary, and the "find a star" palette.
 * Untrusted text only ever goes through textContent (GLX.util.el); innerHTML is used for GLX.icon() markup only.
 */
(() => {
  'use strict';
  const GLX = (window.GLX = window.GLX || {});

  const HANDLERS = ['onLangHover', 'onLangToggle', 'onFactClick', 'onCardClose', 'onCardNav', 'onSearchPick', 'onPoster', 'onMergeReplay', 'onExplore'];
  const NOOP = () => {};
  const FACT_ICONS = { brightest: 'star', oldest: 'clock', newest: 'sparkle', active: 'zap', forked: 'fork' };
  const LEGEND_MAX = 8;
  const CONFLICTS_MAX = 4;
  const SEARCH_MAX = 8;
  const TYPE_MS = 28;
  const LABEL_MAX = 48;
  const SEP_RE = /[\s\-_./]/;

  const h = {};
  for (const k of HANDLERS) h[k] = NOOP;

  let D = null; // DOM references (built lazily by init)
  let mqReduce = null, mqSmall = null;
  let vw = 1280, vh = 800, dpr = 1;

  const S = {
    mode: 'hidden',
    galaxy: null, gals: null,
    legend: { highlight: null, solo: null },
    langBtns: new Map(),
    collapsed: false,
    cardOpen: false, cardStar: null, navDir: 0,
    summary: null, summaryShown: false, summaryDismissed: false,
    tipStar: null, tipOn: false, tipW: 0, tipH: 0, tipX: NaN, tipY: NaN,
    searchOpen: false, sIndex: [], sResults: [], sActive: -1, sPrev: null,
    typeText: null, typeChars: null, typePos: 0, typeTimer: 0, typeSub: null
  };

  // ------------------------------------------------------------------ helpers
  function el() { return GLX.util.el.apply(null, arguments); }
  function ico(name, size, cls) {
    return el('span', { class: 'hud-ico' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', html: GLX.icon(name, size || 14) });
  }
  const num = (n) => GLX.util.fmtNum(n || 0);
  const full = (n) => (Number(n) || 0).toLocaleString('en-US');
  const plural = (n, word) => word + (n === 1 ? '' : 's');
  const cssColor = (rgb, a) => GLX.color.rgbToCss(rgb || GLX.color.OTHER_COLOR, a == null ? 1 : a);
  const reduced = () => !!(mqReduce && mqReduce.matches);
  const isSmall = () => !!(mqSmall && mqSmall.matches);
  const setC = (node, color) => { node.style.setProperty('--c', color); return node; };
  const vis = (node, on) => node && node.classList.toggle('is-visible', !!on);
  function replay(node) {
    node.classList.remove('is-visible');
    void node.offsetWidth; // restart the entrance animation
    node.classList.add('is-visible');
  }
  function kbd(t) { return el('kbd', { class: 'hud-kbd' }, t); }
  function iconBtn(name, label, fn, cls) {
    return el('button', { class: 'hud-icon-btn' + (cls ? ' ' + cls : ''), type: 'button', 'aria-label': label, title: label, html: GLX.icon(name, 18), on: { click: fn } });
  }
  function badge(text, kind, iconName, pulse) {
    return el('span', { class: 'hud-badge hud-badge-' + kind },
      pulse ? el('span', { class: 'hud-pulse', 'aria-hidden': 'true' }) : iconName ? ico(iconName, 11) : null, text);
  }

  /** Only http(s) URLs survive (blocks javascript: etc. in untrusted homepages). */
  function safeUrl(u) {
    if (typeof u !== 'string') return null;
    let s = u.trim();
    if (!s) return null;
    if (!/^[a-z][a-z\d+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    try {
      const p = new URL(s);
      return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null;
    } catch (e) {
      return null;
    }
  }
  const prettyUrl = (u) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  function avatarSrc(url, size) {
    const s = safeUrl(url);
    if (!s) return null;
    try {
      const u = new URL(s);
      u.searchParams.set('s', String(size));
      return u.href;
    } catch (e) {
      return s;
    }
  }
  function initialsOf(p) {
    const name = String((p && p.name) || '').replace(/\([^)]*\)/g, '').trim();
    const words = (name || String((p && p.login) || '?')).split(/[\s_-]+/).filter(Boolean);
    const first = (w) => Array.from(w || '')[0] || '';
    const s = words.length > 1 ? first(words[0]) + first(words[1]) : first(words[0]);
    return (s || '?').toUpperCase();
  }
  /** Avatar circle: gradient initials underneath, the real image fades in on top (removed on error). */
  function avatar(p, px, cls) {
    const login = String((p && p.login) || '');
    const hue = GLX.util.hashStr(login.toLowerCase()) % 360;
    const node = el('span', { class: 'hud-avatar' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' },
      el('span', { class: 'hud-avatar-ini' }, initialsOf(p)));
    node.style.width = node.style.height = px + 'px';
    node.style.fontSize = Math.round(px * 0.38) + 'px';
    node.style.setProperty('--hud-av', 'linear-gradient(135deg, hsl(' + hue + ', 82%, 66%), hsl(' + ((hue + 64) % 360) + ', 70%, 42%))');
    const src = p && p.avatarUrl ? avatarSrc(p.avatarUrl, 96) : null;
    if (src) {
      const img = el('img', { referrerpolicy: 'no-referrer', alt: '', decoding: 'async', draggable: 'false', width: px, height: px });
      img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = src;
      node.append(img);
    }
    return node;
  }
  function loginLink(p, cls) {
    const login = String((p && p.login) || '');
    const href = safeUrl(p && p.url) || 'https://github.com/' + encodeURIComponent(login);
    return el('a', { class: cls || 'hud-login', href, target: '_blank', rel: 'noopener noreferrer', title: 'Open @' + login + ' on GitHub' }, '@' + login);
  }
  function ownerOf(star, galaxy) {
    const fn = String((star && star.repo && star.repo.fullName) || '');
    const i = fn.indexOf('/');
    return i > 0 ? fn.slice(0, i) : String((galaxy && galaxy.profile && galaxy.profile.login) || '');
  }

  // ------------------------------------------------------------------ build
  function measure() {
    vw = window.innerWidth || 1280;
    vh = window.innerHeight || 800;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
  }

  function build() {
    if (D) return;
    const root = document.getElementById('glx-hud-root') || document.body;
    const labels = document.getElementById('glx-labels') || root;
    if (window.matchMedia) {
      mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
      mqSmall = window.matchMedia('(max-width: 720px)');
    }
    measure();
    window.addEventListener('resize', measure, { passive: true });

    D = { root, labels };
    D.wrap = el('div', { class: 'hud' });
    D.left = el('div', { class: 'hud-left' });
    D.profile = el('section', { class: 'hud-panel hud-profile' });
    D.merge = buildMerge();
    D.legend = el('section', { class: 'hud-panel hud-legend', 'aria-label': 'Language legend' });
    D.left.append(D.profile, D.merge, D.legend);
    D.card = buildCard();
    D.summary = el('section', { class: 'hud-panel hud-pop hud-summary', 'aria-labelledby': 'hud-sum-title' });
    D.tip = el('div', { class: 'hud-tip', 'aria-hidden': 'true' });
    D.wrap.append(D.left, D.card, D.summary, D.tip);
    root.append(D.wrap);
    // The palette is a true modal: mounted on <body> so it stacks above the chrome layer too.
    D.search = buildSearch();
    document.body.append(D.search);
  }

  function buildMerge() {
    const sec = el('section', { class: 'hud-panel hud-merge', 'aria-label': 'git merge' });
    const avs = el('div', { class: 'hud-merge-avs' });
    const title = el('div', { class: 'hud-merge-title' });
    const sub = el('div', { class: 'hud-merge-sub' }, 'git merge · two galaxies collide');
    const prompt = el('span', { class: 'hud-term-prompt' });
    const text = el('span', { class: 'hud-term-text' });
    const term = el('div', { class: 'hud-term', 'aria-hidden': 'true' },
      el('div', { class: 'hud-term-line' }, prompt, text, el('span', { class: 'hud-term-caret' })),
      el('div', { class: 'hud-term-sub' }));
    const live = el('span', { class: 'hud-sr', role: 'status', 'aria-live': 'polite' });
    const sumBtn = el('button', { class: 'hud-btn hud-btn-sm hud-merge-sumbtn', type: 'button', hidden: true, on: { click: reopenSummary } },
      ico('check', 14), 'Merge summary');
    sec.append(el('div', { class: 'hud-merge-top' }, avs, el('div', { class: 'hud-merge-titles' }, title, sub)), term, sumBtn, live);
    Object.assign(D, { mergeAvs: avs, mergeTitle: title, tPrompt: prompt, tText: text, tTerm: term, tSub: term.lastChild, tLive: live, mergeSumBtn: sumBtn });
    return sec;
  }

  function buildCard() {
    const card = el('aside', { class: 'hud-panel hud-pop hud-card', 'aria-labelledby': 'hud-card-title', on: { keydown: onCardKey } });
    const kicker = el('span', { class: 'hud-card-kicker' });
    const linkTxt = el('span', { class: 'hud-card-name' });
    const link = el('a', { class: 'hud-card-link', target: '_blank', rel: 'noopener noreferrer' }, linkTxt, ico('external', 14, 'hud-card-ext'));
    const title = el('h2', { class: 'hud-card-title', id: 'hud-card-title', 'aria-live': 'polite' }, link);
    const owner = el('div', { class: 'hud-card-owner' });
    const orb = el('span', { class: 'hud-orb', 'aria-hidden': 'true' });
    const head = el('div', { class: 'hud-card-head' }, orb, el('div', { class: 'hud-card-titles' }, title, owner));
    const body = el('div', { class: 'hud-card-body' });
    card.append(
      el('div', { class: 'hud-grip', 'aria-hidden': 'true' }),
      el('div', { class: 'hud-card-bar' }, kicker,
        el('div', { class: 'hud-card-nav' },
          iconBtn('chevronLeft', 'Previous star', () => nav(-1)),
          iconBtn('chevronRight', 'Next star', () => nav(1)),
          iconBtn('close', 'Close star details', closeCardByUser, 'hud-card-close'))),
      el('div', { class: 'hud-card-scroll' }, head, body));
    Object.assign(D, { cardKicker: kicker, cardLink: link, cardName: linkTxt, cardOwner: owner, cardOrb: orb, cardHead: head, cardBody: body, cardScroll: card.lastChild });
    return card;
  }

  function buildSearch() {
    const input = el('input', {
      class: 'hud-s-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'hud-s-list',
      'aria-autocomplete': 'list', 'aria-label': 'Find a star by repository name', placeholder: 'Find a star…',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go', on: { input: runSearch }
    });
    const esc = el('button', { class: 'hud-s-esc', type: 'button', 'aria-label': 'Close search', title: 'Close (Esc)', on: { click: closeSearch } }, 'esc');
    const head = el('div', { class: 'hud-s-head', id: 'hud-s-head' });
    const list = el('ul', { class: 'hud-s-list', id: 'hud-s-list', role: 'listbox', 'aria-labelledby': 'hud-s-head' });
    list.addEventListener('pointermove', (e) => {
      const li = e.target.closest && e.target.closest('[data-i]');
      if (li) setActive(+li.dataset.i, false);
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest && e.target.closest('[data-i]');
      if (li) pick(+li.dataset.i);
    });
    const box = el('div', { class: 'hud-s-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Find a star', on: { keydown: onSearchKey } },
      el('div', { class: 'hud-s-field' }, ico('search', 18, 'hud-s-ico'), input, esc),
      el('div', { class: 'hud-s-results' }, head, list),
      el('div', { class: 'hud-s-foot', 'aria-hidden': 'true' },
        el('span', null, kbd('↑'), kbd('↓'), 'navigate'),
        el('span', null, kbd('↵'), 'fly to star'),
        el('span', null, kbd('esc'), 'close')));
    const wrap = el('div', { class: 'hud-s' }, el('div', { class: 'hud-s-backdrop', on: { click: closeSearch } }), box);
    const stop = (e) => e.stopPropagation(); // keep app shortcuts quiet while typing
    wrap.addEventListener('keyup', stop);
    wrap.addEventListener('keypress', stop);
    Object.assign(D, { sInput: input, sList: list, sHead: head, sEsc: esc, sBox: box });
    return wrap;
  }

  // ------------------------------------------------------------------ profile panel
  function renderProfile(g) {
    const p = g.profile || {}, st = g.stats || {}, cl = g.classification || {}, user = g.user || {};
    const login = String(p.login || '');
    const name = String(p.name || '').trim() || login;
    const stars = g.stars || [];
    const prof = D.profile;
    prof.setAttribute('aria-label', 'Galaxy of @' + login);

    const toggle = el('button', {
      class: 'hud-icon-btn hud-collapse', type: 'button', 'aria-controls': 'hud-prof-body',
      html: GLX.icon('chevronRight', 18), on: { click: () => setCollapsed(!S.collapsed) }
    });
    D.profToggle = toggle;

    const head = el('div', { class: 'hud-prof-head' },
      avatar(p, 46),
      el('div', { class: 'hud-prof-id' },
        el('h2', { class: 'hud-prof-name', title: name }, name),
        el('div', { class: 'hud-prof-sub' },
          loginLink(p),
          p.type === 'Organization' && badge('Organization', 'org', 'users'),
          p.isDemo && badge('Demo', 'demo', 'sparkle'))),
      toggle);

    const total = Math.max(Number(p.publicRepos) || 0, (user.repos || []).length);
    const note = (user.truncated || (total && stars.length < total))
      ? el('p', { class: 'hud-note' }, ico('alert', 13), 'Showing ' + full(stars.length) + ' of ' + full(total) + ' repositories.')
      : null;

    const facts = (g.facts || []).filter(Boolean);
    const factList = facts.length ? el('div', { class: 'hud-sec' },
      el('h3', { class: 'hud-h' }, 'Notable stars'),
      el('ul', { class: 'hud-facts' }, facts.map((f, i) => {
        const star = stars[f.starIndex];
        const b = el('button', {
          class: 'hud-fact', type: 'button', title: 'Fly to ' + f.text,
          'aria-label': f.label + ': ' + f.text + ', ' + f.value + '. Fly to star', on: { click: () => h.onFactClick(f) }
        },
        ico(FACT_ICONS[f.id] || 'sparkle', 15, 'hud-fact-ico'),
        el('span', { class: 'hud-fact-main' }, el('span', { class: 'hud-fact-label' }, f.label), el('span', { class: 'hud-fact-text' }, f.text)),
        el('span', { class: 'hud-fact-value' }, f.value),
        ico('chevronRight', 14, 'hud-fact-go'));
        setC(b, cssColor(star && star.color));
        b.style.setProperty('--i', i);
        return el('li', null, b);
      }))) : null;

    let srcText = 'Live from api.github.com', srcKind = 'live';
    if (user.source === 'demo' || p.isDemo) { srcText = 'Synthetic demo galaxy · works offline'; srcKind = 'demo'; }
    else if (user.source === 'cache') { srcText = 'Cached copy · fetched ' + GLX.util.timeAgo(user.fetchedAt || Date.now()); srcKind = 'cache'; }
    const since = st.firstYear ? ' · since ' + st.firstYear : '';

    const statDefs = [
      ['star', st.stars, 'stars', full(st.stars) + ' stargazers in total', 'is-stars'],
      ['sparkle', st.repos, 'repos', full(st.repos) + ' repositories (' + full(st.forkRepos) + ' forks)'],
      ['fork', st.forksReceived, 'forks', full(st.forksReceived) + ' forks received'],
      ['code', st.languages, plural(st.languages, 'lang'), full(st.languages) + ' languages'],
      ['zap', st.active90d, 'active', full(st.active90d) + ' repos pushed in the last 90 days']
    ];

    const body = el('div', { class: 'hud-prof-body', id: 'hud-prof-body' },
      el('div', { class: 'hud-prof-inner' },
        el('div', { class: 'hud-class-row' },
          el('span', { class: 'hud-class', title: cl.name || '' },
            el('span', { class: 'hud-class-emoji', 'aria-hidden': 'true' }, cl.emoji || '✦'),
            el('span', null, cl.name || 'Galaxy')),
          el('span', { class: 'hud-desig', title: 'Galaxy designation' }, String(g.designation || '') + since)),
        cl.blurb ? el('p', { class: 'hud-blurb' }, cl.blurb) : null,
        el('div', { class: 'hud-stats', role: 'list' }, statDefs.map(([icon, v, label, title, cls]) =>
          el('div', { class: 'hud-stat' + (cls ? ' ' + cls : ''), role: 'listitem', title, 'aria-label': title },
            el('span', { class: 'hud-stat-v' }, num(v)),
            el('span', { class: 'hud-stat-l' }, ico(icon, 11), label)))),
        note,
        factList,
        el('div', { class: 'hud-source is-' + srcKind }, el('span', { class: 'hud-source-dot', 'aria-hidden': 'true' }), srcText)));

    prof.replaceChildren(head, body);
    setCollapsed(isSmall());
  }

  function setCollapsed(on) {
    S.collapsed = !!on;
    if (!D) return;
    D.profile.classList.toggle('is-collapsed', S.collapsed);
    const b = D.profToggle;
    if (b) {
      const label = S.collapsed ? 'Expand profile' : 'Collapse profile';
      b.setAttribute('aria-expanded', S.collapsed ? 'false' : 'true');
      b.setAttribute('aria-label', label);
      b.title = label;
    }
  }

  // ------------------------------------------------------------------ legend
  function renderLegend(langs, title) {
    S.langBtns.clear();
    const lg = D.legend;
    if (!langs || !langs.length) {
      lg.replaceChildren();
      vis(lg, false);
      return false;
    }
    let maxShare = 0;
    for (const L of langs) maxShare = Math.max(maxShare, L.share || 0);
    const list = el('ul', { class: 'hud-legend-list' });
    langs.forEach((L, i) => {
      const lang = String(L.lang || 'Other');
      const pct = (L.share || 0) * 100;
      const pctTxt = pct >= 1 ? Math.round(pct) + '%' : '<1%';
      const count = L.count || 0;
      const b = el('button', {
        class: 'hud-lang', type: 'button', 'aria-pressed': 'false',
        title: count + ' ' + plural(count, 'repo') + ' · ' + pctTxt + ' — click to solo',
        'aria-label': lang + ': ' + count + ' ' + plural(count, 'repo') + ', ' + pctTxt + (L.shared ? ', in both galaxies' : '') + '. Toggle solo',
        on: {
          pointerenter: () => h.onLangHover(lang), pointerleave: () => h.onLangHover(null),
          focus: () => h.onLangHover(lang), blur: () => h.onLangHover(null),
          click: () => h.onLangToggle(lang)
        }
      },
      el('span', { class: 'hud-lang-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'hud-lang-name' }, lang, L.shared ? el('span', { class: 'hud-lang-shared', 'aria-hidden': 'true', title: 'In both galaxies' }, '⨯') : null),
      el('span', { class: 'hud-lang-count' }, num(count)),
      el('span', { class: 'hud-lang-bar', 'aria-hidden': 'true' }, el('i', { style: { width: (maxShare ? (L.share || 0) / maxShare * 100 : 0).toFixed(1) + '%' } })));
      setC(b, cssColor(L.color || GLX.color.langColor(lang)));
      b.style.setProperty('--i', i);
      S.langBtns.set(lang, b);
      list.append(el('li', { class: i >= LEGEND_MAX ? 'hud-lang-extra' : null }, b));
    });
    const extra = langs.length - LEGEND_MAX;
    let more = null;
    if (extra > 0) {
      more = el('button', { class: 'hud-legend-more', type: 'button', 'aria-expanded': 'false' }, '+' + extra + ' more');
      more.addEventListener('click', () => {
        const open = !lg.classList.contains('is-expanded');
        lg.classList.toggle('is-expanded', open);
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open ? 'Show less' : '+' + extra + ' more';
      });
    }
    lg.classList.remove('is-expanded');
    lg.replaceChildren(
      el('div', { class: 'hud-legend-head' }, el('h3', { class: 'hud-legend-title' }, title), el('span', { class: 'hud-legend-hint' }, 'click to solo')),
      list, more);
    return true;
  }

  function setLegendState(s) {
    const hl = (s && s.highlight) || null, solo = (s && s.solo) || null;
    S.legend.highlight = hl;
    S.legend.solo = solo;
    if (!D) return;
    D.legend.classList.toggle('has-hl', !!hl);
    D.legend.classList.toggle('has-solo', !!solo);
    S.langBtns.forEach((b, lang) => {
      b.classList.toggle('is-hl', lang === hl);
      b.classList.toggle('is-solo', lang === solo);
      b.classList.toggle('is-dim', !!solo && lang !== solo && lang !== hl);
      b.setAttribute('aria-pressed', lang === solo ? 'true' : 'false');
    });
    const target = S.langBtns.get(solo || hl);
    if (target && target.parentNode.classList.contains('hud-lang-extra') && !D.legend.classList.contains('is-expanded')) {
      const more = D.legend.querySelector('.hud-legend-more');
      if (more) more.click();
    }
  }

  function combinedLangs(a, b) {
    const map = new Map();
    let total = 0;
    [a, b].forEach((g, gi) => {
      for (const L of (g && g.langs) || []) {
        let e = map.get(L.lang);
        if (!e) map.set(L.lang, (e = { lang: L.lang, count: 0, stars: 0, color: L.color, inA: false, inB: false }));
        e.count += L.count || 0;
        e.stars += L.stars || 0;
        if (gi === 0) e.inA = true; else e.inB = true;
        total += L.count || 0;
      }
    });
    const out = [];
    map.forEach((e) => out.push({ lang: e.lang, count: e.count, stars: e.stars, color: e.color, share: total ? e.count / total : 0, shared: e.inA && e.inB }));
    out.sort((x, y) => y.count - x.count || y.stars - x.stars);
    return out;
  }

  // ------------------------------------------------------------------ card
  function nav(dir) {
    S.navDir = dir;
    h.onCardNav(dir);
  }
  function closeCardByUser() {
    h.onCardClose();
    hideCard();
  }
  function onCardKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCardByUser();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      nav(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  function planetLine(planets, forks) {
    const nP = el('b', null, planets + ' ' + plural(planets, 'planet'));
    if (!forks) return [el('b', null, 'A lone planet'), ' orbits this star — fork it to grow the system.'];
    return [nP, ' ' + (planets === 1 ? 'orbits' : 'orbit') + ' this star — forged from ' + full(forks) + ' ' + plural(forks, 'fork') + '.'];
  }
  function orbitViz(planets) {
    const ring = el('span', { class: 'hud-orbit-ring' });
    for (let i = 0; i < planets; i++) {
      const dot = el('i');
      dot.style.setProperty('--a', Math.round((360 / planets) * i + 18) + 'deg');
      ring.append(dot);
    }
    return el('span', { class: 'hud-orbit', 'aria-hidden': 'true' }, ring, el('span', { class: 'hud-orbit-core' }, '🪐'));
  }
  function tile(icon, v, label, title, cls) {
    return el('div', { class: 'hud-tile' + (cls ? ' ' + cls : ''), title },
      el('span', { class: 'hud-tile-v' }, num(v)),
      el('span', { class: 'hud-tile-l' }, ico(icon, 12), label));
  }
  function metaRow(icon, label, value, title) {
    return [el('dt', null, ico(icon, 13), label), el('dd', { title: title || null }, value)];
  }

  function fillCard(star, galaxy, ref) {
    const r = star.repo || {};
    const color = cssColor(star.color);
    const lang = star.lang || r.language || 'Other';
    const owner = ownerOf(star, galaxy);
    const total = (galaxy && galaxy.stars && galaxy.stars.length) || 0;
    const idx = ref && typeof ref.index === 'number' ? ref.index : star.index;
    const forks = Math.max(0, Number(r.forks) || 0);
    const planets = Math.min(7, 1 + Math.floor(Math.log2(forks + 1)));
    const url = safeUrl(r.url) || 'https://github.com/' + String(r.fullName || owner + '/' + r.name).split('/').map(encodeURIComponent).join('/');
    const home = safeUrl(r.homepage);

    setC(D.card, color);
    D.cardKicker.textContent = (S.mode === 'merge' ? '@' + owner + ' · ' : '') + 'Star ' + (idx + 1) + (total ? ' of ' + total : '');
    D.cardName.textContent = r.name || '(unnamed)';
    D.cardLink.href = url;
    D.cardLink.title = 'Open ' + (r.fullName || r.name || 'repository') + ' on GitHub';
    D.cardOwner.textContent = '@' + owner;
    D.cardOrb.classList.toggle('is-active', star.activity >= 1);
    D.cardOrb.style.setProperty('--s', (0.55 + 0.45 * Math.min(1, Math.log10((r.stars || 0) + 1) / 4)).toFixed(3));

    const badges = [];
    if (star.isFork || r.isFork) badges.push(badge('Fork', 'fork', 'fork'));
    if (star.isArchived || r.isArchived) badges.push(badge('Archived', 'archived', 'archive'));
    if (star.activity >= 1) badges.push(badge('Active', 'active', null, true));
    else if (star.activity >= 0.5) badges.push(badge('Recently active', 'recent', 'clock'));

    const created = r.createdAt ? GLX.util.fmtDateLong(r.createdAt) : '—';
    const topics = Array.isArray(r.topics) ? r.topics.slice(0, 12) : [];
    const langChip = setC(el('span', { class: 'hud-chip' }, el('span', { class: 'hud-chip-dot', 'aria-hidden': 'true' }), lang), color);

    D.cardBody.replaceChildren(
      badges.length ? el('div', { class: 'hud-badges' }, badges) : null,
      r.description ? el('p', { class: 'hud-card-desc' }, r.description) : el('p', { class: 'hud-card-desc is-empty' }, 'No description — a quiet star.'),
      el('div', { class: 'hud-chips' }, langChip, r.license ? el('span', { class: 'hud-chip', title: 'License' }, ico('scale', 13), r.license) : null),
      el('div', { class: 'hud-tiles' },
        tile('star', r.stars, plural(r.stars || 0, 'star'), full(r.stars) + ' stargazers', 'is-stars'),
        tile('fork', forks, plural(forks, 'fork'), full(forks) + ' forks'),
        tile('issue', r.issues, 'open issues', full(r.issues) + ' open issues')),
      el('dl', { class: 'hud-meta' },
        metaRow('calendar', 'Created', [created, r.createdAt ? el('span', { class: 'hud-meta-sub' }, ' · ' + GLX.util.timeAgo(r.createdAt)) : null]),
        metaRow('clock', 'Last push', r.pushedAt ? GLX.util.timeAgo(r.pushedAt) : '—', r.pushedAt ? GLX.util.fmtDateLong(r.pushedAt) : null),
        home ? metaRow('link', 'Homepage', el('a', { href: home, target: '_blank', rel: 'noopener noreferrer' }, prettyUrl(home)), home) : null),
      topics.length ? el('div', { class: 'hud-topics', 'aria-label': 'Topics' }, topics.map((t) => el('span', { class: 'hud-topic' }, String(t)))) : null,
      el('div', { class: 'hud-planets' }, orbitViz(planets), el('p', null, planetLine(planets, forks))),
      el('div', { class: 'hud-card-actions' },
        el('a', { class: 'hud-btn hud-btn-wide', href: url, target: '_blank', rel: 'noopener noreferrer' }, ico('external', 15), 'Open on GitHub'),
        home ? el('a', { class: 'hud-btn', href: home, target: '_blank', rel: 'noopener noreferrer', title: home }, ico('link', 15), 'Homepage') : null));
  }

  function showCard(star, galaxy, ref) {
    ensure();
    if (!star) return hideCard();
    const was = S.cardOpen, prev = S.cardStar;
    S.cardStar = star;
    fillCard(star, galaxy || S.galaxy, ref || { slot: 0, index: star.index });
    D.cardScroll.scrollTop = 0;
    if (!was) {
      S.cardOpen = true;
      vis(D.card, true);
      GLX.bus.emit('hud:card', { open: true });
    } else if (prev !== star && !reduced() && D.cardBody.animate) {
      const dx = S.navDir < 0 ? -14 : 14;
      const kf = [{ opacity: 0, transform: 'translateX(' + dx + 'px)' }, { opacity: 1, transform: 'none' }];
      D.cardHead.animate(kf, { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
      D.cardBody.animate(kf, { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    S.navDir = 0;
    syncSummary();
  }

  function hideCard() {
    if (!D || !S.cardOpen) return;
    S.cardOpen = false;
    S.cardStar = null;
    if (D.card.contains(document.activeElement)) document.activeElement.blur();
    vis(D.card, false);
    syncSummary();
    GLX.bus.emit('hud:card', { open: false });
  }

  // ------------------------------------------------------------------ tooltip
  function fillTip(star) {
    const r = star.repo || {};
    const tags = [];
    if (star.isFork || r.isFork) tags.push(el('span', { class: 'hud-tip-tag' }, 'fork'));
    if (star.isArchived || r.isArchived) tags.push(el('span', { class: 'hud-tip-tag' }, 'archived'));
    if (star.activity >= 1) tags.push(el('span', { class: 'hud-tip-tag is-active' }, 'active'));
    setC(D.tip, cssColor(star.color));
    D.tip.replaceChildren(
      el('div', { class: 'hud-tip-head' }, el('span', { class: 'hud-tip-dot' }), el('span', { class: 'hud-tip-name' }, r.name || '')),
      el('div', { class: 'hud-tip-meta' },
        el('span', null, star.lang || r.language || 'Other'),
        el('span', { class: 'hud-tip-stars' }, ico('star', 12), num(r.stars)),
        tags),
      r.description ? el('div', { class: 'hud-tip-desc' }, r.description) : null);
  }

  function showTooltip(x, y, star) {
    ensure();
    if (!star || S.mode === 'hidden') return hideTooltip();
    if (star !== S.tipStar) {
      fillTip(star);
      S.tipStar = star;
      S.tipW = D.tip.offsetWidth;
      S.tipH = D.tip.offsetHeight;
    }
    const w = S.tipW, ht = S.tipH;
    let tx = x + 14, ty = y + 14;
    if (tx + w > vw - 8) tx = x - 14 - w;
    if (ty + ht > vh - 8) ty = y - 14 - ht;
    tx = Math.round(Math.max(8, Math.min(tx, vw - w - 8)));
    ty = Math.round(Math.max(8, Math.min(ty, vh - ht - 8)));
    if (tx !== S.tipX || ty !== S.tipY) {
      S.tipX = tx;
      S.tipY = ty;
      D.tip.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0)';
    }
    if (!S.tipOn) {
      S.tipOn = true;
      D.tip.classList.add('is-visible');
    }
  }

  function hideTooltip() {
    if (!D || !S.tipOn) return;
    S.tipOn = false;
    D.tip.classList.remove('is-visible');
  }

  // ------------------------------------------------------------------ labels (per frame, allocation-free in steady state)
  const L = {
    map: new Map(), free: [],
    order: new Int32Array(64), prio: new Float64Array(64), rects: new Float32Array(LABEL_MAX * 4),
    frame: 0, last: 0, k: 1, typed: null
  };

  /** CSS Typed OM lets us mutate reusable CSSUnitValues instead of building strings each frame. */
  function typedOM() {
    if (L.typed !== null) return L.typed;
    L.typed = false;
    try {
      if (window.CSS && CSS.px && CSS.number && window.CSSTransformValue && window.CSSTranslate) {
        const probe = document.createElement('div');
        if (probe.attributeStyleMap) {
          const x = CSS.px(0), y = CSS.px(0);
          const tv = new CSSTransformValue([new CSSTranslate(x, y, CSS.px(0))]);
          x.value = 12.5;
          probe.attributeStyleMap.set('transform', tv);
          L.typed = /12\.5px/.test(probe.style.transform);
        }
      }
    } catch (e) {
      L.typed = false;
    }
    return L.typed;
  }

  function makeLabel() {
    const node = document.createElement('div');
    node.className = 'hud-label is-off';
    const inner = document.createElement('div');
    inner.className = 'hud-label-in';
    const dot = document.createElement('span');
    dot.className = 'hud-label-dot';
    const txt = document.createElement('span');
    txt.className = 'hud-label-txt';
    inner.append(dot, txt);
    node.append(inner);
    D.labels.append(node);
    const r = { node, txt, key: null, text: '', color: '', x: NaN, y: NaN, a: 0, op: 0, opq: -1, stamp: -1, em: false, left: false, off: true, tx: null, ty: null, tf: null, ov: null };
    if (typedOM()) {
      r.tx = CSS.px(0);
      r.ty = CSS.px(0);
      r.tf = new CSSTransformValue([new CSSTranslate(r.tx, r.ty, CSS.px(0))]);
      r.ov = CSS.number(0);
    }
    return r;
  }

  function placeLabel(r, it, x, y, left, em) {
    if (r.text !== it.text) { r.text = it.text; r.txt.textContent = it.text; }
    if (r.color !== it.color) { r.color = it.color; r.node.style.setProperty('--c', it.color || '#e6edf3'); }
    if (r.em !== em) { r.em = em; r.node.classList.toggle('is-em', em); }
    if (r.left !== left) { r.left = left; r.node.classList.toggle('is-left', left); }
    const rx = Math.round(x * dpr) / dpr, ry = Math.round(y * dpr) / dpr; // device-pixel snapped: crisp text
    if (rx !== r.x || ry !== r.y) {
      r.x = rx;
      r.y = ry;
      if (r.tf) {
        r.tx.value = rx;
        r.ty.value = ry;
        r.node.attributeStyleMap.set('transform', r.tf);
      } else {
        r.node.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)';
      }
    }
  }

  function releaseLabel(r) {
    r.key = null;
    r.op = 0;
    r.opq = -1;
    r.stamp = -1;
    if (!r.off) { r.off = true; r.node.classList.add('is-off'); }
    L.free.push(r);
  }

  function stepLabel(r, key) {
    const target = r.stamp === L.frame ? r.a : 0;
    r.op += (target - r.op) * L.k;
    if (target === 0 && r.op < 0.015) {
      L.map.delete(key);
      releaseLabel(r);
      return;
    }
    if (r.off) { r.off = false; r.node.classList.remove('is-off'); }
    const q = Math.round(r.op * 100);
    if (q !== r.opq) {
      r.opq = q;
      if (r.ov) {
        r.ov.value = q / 100;
        r.node.attributeStyleMap.set('opacity', r.ov);
      } else {
        r.node.style.opacity = q / 100;
      }
    }
  }

  function updateLabels(items) {
    if (!D) return;
    const now = performance.now();
    let dt = (now - L.last) / 1000;
    L.last = now;
    if (!(dt > 0) || dt > 0.25) dt = 1 / 60;
    L.k = reduced() ? 1 : 1 - Math.exp(-dt * 14);
    const frame = ++L.frame;
    const n = S.mode === 'hidden' || !items ? 0 : items.length | 0;
    if (n > L.order.length) {
      L.order = new Int32Array(n * 2);
      L.prio = new Float64Array(n * 2);
    }
    const order = L.order, prio = L.prio, rects = L.rects;

    // Insertion sort by priority (emphasis first): allocation-free and fast for tens of items.
    let m = 0;
    for (let i = 0; i < n; i++) {
      const it = items[i];
      if (!it || !(it.alpha > 0.02) || !it.text) continue;
      const p = (it.emphasis ? 1e9 : 0) + (+it.priority || 0);
      let j = m++;
      while (j > 0 && prio[j - 1] < p) { prio[j] = prio[j - 1]; order[j] = order[j - 1]; j--; }
      prio[j] = p;
      order[j] = i;
    }

    // Greedy placement: a label is shown only if its estimated box is free.
    let placed = 0;
    for (let j = 0; j < m; j++) {
      const it = items[order[j]];
      const em = !!it.emphasis;
      const x = +it.x, y = +it.y;
      const w = it.text.length * 6.6 + (em ? 26 : 16), hh = em ? 24 : 18;
      const left = x + 8 + w > vw - 4 && x - 8 - w > 4;
      const x0 = left ? x - 8 - w : x + 4, x1 = left ? x - 4 : x + 8 + w;
      const y0 = y - hh * 0.5, y1 = y + hh * 0.5;
      const onScreen = x === x && y === y && x1 > 0 && x0 < vw && y1 > 0 && y0 < vh;
      let ok = onScreen && placed < LABEL_MAX;
      if (ok && !em) {
        for (let q = 0, o = 0; q < placed; q++, o += 4) {
          if (x0 < rects[o + 2] && x1 > rects[o] && y0 < rects[o + 3] && y1 > rects[o + 1]) { ok = false; break; }
        }
      }
      if (!ok) {
        const fading = L.map.get(it.key);
        if (fading && onScreen) placeLabel(fading, it, x, y, left, em);
        continue;
      }
      const o = placed * 4;
      rects[o] = x0; rects[o + 1] = y0; rects[o + 2] = x1; rects[o + 3] = y1;
      placed++;
      let r = L.map.get(it.key);
      if (!r) {
        r = L.free.pop() || makeLabel();
        r.key = it.key;
        L.map.set(it.key, r);
      }
      r.stamp = frame;
      r.a = it.alpha > 1 ? 1 : +it.alpha;
      placeLabel(r, it, x, y, left, em);
    }
    L.map.forEach(stepLabel);
  }

  function clearLabels() {
    L.map.forEach(releaseLabel);
    L.map.clear();
  }

  // ------------------------------------------------------------------ merge
  function showMerge(galA, galB, summary) {
    ensure();
    S.mode = 'merge';
    S.galaxy = null;
    S.gals = [galA, galB];
    S.summary = summary || null;
    S.summaryShown = false;
    S.summaryDismissed = false;
    hideCard();
    hideTooltip();
    clearLabels();
    const pa = (galA && galA.profile) || (summary && summary.a) || {};
    const pb = (galB && galB.profile) || (summary && summary.b) || {};
    D.merge.setAttribute('aria-label', 'git merge @' + pa.login + ' and @' + pb.login);
    D.mergeAvs.replaceChildren(avatar(pa, 40, 'is-a'), avatar(pb, 40, 'is-b'), el('span', { class: 'hud-merge-badge', 'aria-hidden': 'true', html: GLX.icon('merge', 12) }));
    D.mergeTitle.replaceChildren(loginLink(pa, 'hud-merge-login'), el('span', { class: 'hud-merge-op', 'aria-hidden': 'true' }, '⨯'), loginLink(pb, 'hud-merge-login'));
    stopTyping();
    S.typeText = null;
    S.typeSub = null;
    D.tPrompt.textContent = '';
    D.tText.textContent = '';
    D.tSub.textContent = '';
    D.tLive.textContent = '';
    vis(D.profile, false);
    replay(D.merge);
    if (renderLegend(combinedLangs(galA, galB), 'Combined arms')) replay(D.legend);
    setLegendState(null);
    syncSummary();
  }

  function setMergeStatus(text, sub) {
    ensure();
    text = text == null ? '' : String(text);
    if (text !== S.typeText) {
      S.typeText = text;
      if (sub === undefined) sub = '';
      stopTyping();
      const m = /^([$>❯])\s+/.exec(text);
      const body = m ? text.slice(m[0].length) : text;
      D.tPrompt.textContent = m ? m[1] : '';
      D.tLive.textContent = text + (sub ? ' — ' + sub : '');
      const chars = Array.from(body);
      if (reduced() || chars.length < 2) {
        D.tText.textContent = body;
      } else {
        S.typeChars = chars;
        S.typePos = 0;
        D.tText.textContent = '';
        D.tTerm.classList.add('is-typing');
        S.typeTimer = setInterval(typeTick, Math.max(12, Math.min(TYPE_MS, 1800 / chars.length)));
      }
    }
    if (sub !== undefined) {
      const s = sub == null ? '' : String(sub);
      if (s !== S.typeSub) {
        S.typeSub = s;
        D.tSub.textContent = s;
      }
    }
  }
  function typeTick() {
    const c = S.typeChars;
    if (!c || !D) return stopTyping();
    D.tText.textContent += c[S.typePos++];
    if (S.typePos >= c.length) stopTyping();
  }
  function stopTyping() {
    if (S.typeTimer) {
      clearInterval(S.typeTimer);
      S.typeTimer = 0;
    }
    S.typeChars = null;
    if (D) D.tTerm.classList.remove('is-typing');
  }

  function syncSummary() {
    if (!D) return;
    const can = S.summaryShown && S.mode !== 'hidden';
    vis(D.summary, can && !S.summaryDismissed && !S.cardOpen);
    D.mergeSumBtn.hidden = !(can && S.summaryDismissed);
  }
  function reopenSummary() {
    S.summaryDismissed = false;
    if (S.cardOpen) closeCardByUser();
    syncSummary();
  }
  function dismissSummary() {
    const hadFocus = D.summary.contains(document.activeElement);
    S.summaryDismissed = true;
    syncSummary();
    if (hadFocus && !D.mergeSumBtn.hidden) D.mergeSumBtn.focus({ preventScroll: true });
  }

  function showMergeSummary(sum) {
    ensure();
    if (!sum) return;
    S.summary = sum;
    const a = sum.a || {}, b = sum.b || {};
    const conflicts = Array.isArray(sum.conflicts) ? sum.conflicts : [];
    const shared = Array.isArray(sum.sharedLangs) ? sum.sharedLangs : [];
    const cl = sum.classification || {};
    const nC = conflicts.length;

    const cfList = el('ul', { class: 'hud-conflicts' + (nC > CONFLICTS_MAX ? ' is-clamped' : ''), id: 'hud-sum-conflicts' },
      conflicts.map((c, i) => el('li', { class: i >= CONFLICTS_MAX ? 'hud-cf-extra' : null },
        el('span', { class: 'hud-cf-warn' }, '⚠ CONFLICT'),
        el('span', { class: 'hud-cf-in' }, ' in '),
        el('span', { class: 'hud-cf-name' }, String(c.name || '')),
        el('span', { class: 'hud-cf-ok' }, ' → auto-resolved ✓'))));
    let cfMore = null;
    if (nC > CONFLICTS_MAX) {
      const label = 'Show ' + (nC - CONFLICTS_MAX) + ' more';
      cfMore = el('button', { class: 'hud-link-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'hud-sum-conflicts' }, label);
      cfMore.addEventListener('click', () => {
        const open = cfList.classList.toggle('is-clamped') === false;
        cfMore.setAttribute('aria-expanded', String(open));
        cfMore.textContent = open ? 'Show less' : label;
      });
    }

    const exploreBtn = (p) => el('button', { class: 'hud-btn hud-btn-ghost hud-explore', type: 'button', on: { click: () => h.onExplore(p.login) } },
      avatar(p, 20), el('span', null, 'Explore @' + p.login));

    const content = el('div', { class: 'hud-sum-scroll' },
      el('div', { class: 'hud-sum-head' },
        el('span', { class: 'hud-sum-check', 'aria-hidden': 'true', html: GLX.icon('check', 20) }),
        el('div', { class: 'hud-sum-titles' },
          el('h2', { class: 'hud-sum-title', id: 'hud-sum-title' }, 'Merge complete'),
          el('div', { class: 'hud-sum-strategy' }, "Merge made by the 'gravity' strategy.")),
        iconBtn('close', 'Hide merge summary', dismissSummary, 'hud-sum-close')),
      el('div', { class: 'hud-commit' },
        el('div', null, el('span', { class: 'hud-commit-k' }, 'commit '), el('span', { class: 'hud-commit-sha' }, String(sum.commitSha || '0000000')),
          el('span', { class: 'hud-commit-ref' }, ' (HEAD → universe)')),
        el('div', null, el('span', { class: 'hud-commit-k' }, 'Merge: '), '@' + a.login + ' @' + b.login),
        nC ? el('div', { class: 'hud-commit-dim' }, 'CONFLICT (gravity): ' + nC + ' ' + plural(nC, 'collision') + ' · auto-resolved') : null),
      el('div', { class: 'hud-tiles hud-tiles-4' },
        tile('sparkle', sum.totalRepos, 'repos', full(sum.totalRepos) + ' repositories'),
        tile('star', sum.totalStars, 'stars', full(sum.totalStars) + ' stargazers', 'is-stars'),
        tile('code', sum.languages, plural(sum.languages, 'lang'), full(sum.languages) + ' languages'),
        tile('alert', nC, plural(nC, 'conflict'), nC + ' merge ' + plural(nC, 'conflict'), nC ? 'is-warn' : null)),
      el('div', { class: 'hud-sec' },
        el('h3', { class: 'hud-h' }, 'Shared languages'),
        shared.length
          ? el('div', { class: 'hud-chips' }, shared.map((lang) => setC(el('span', { class: 'hud-chip' }, el('span', { class: 'hud-chip-dot', 'aria-hidden': 'true' }), String(lang)), GLX.color.rgbToCss(GLX.color.langColor(lang)))))
          : el('p', { class: 'hud-muted' }, 'None — opposites attract.')),
      el('div', { class: 'hud-sec' },
        el('h3', { class: 'hud-h' }, 'Conflicts', nC ? el('span', { class: 'hud-h-count' }, String(nC)) : null),
        nC ? [cfList, cfMore] : el('p', { class: 'hud-muted' }, 'None — a clean fast-forward through spacetime.')),
      el('div', { class: 'hud-remnant' },
        el('span', { class: 'hud-remnant-emoji', 'aria-hidden': 'true' }, cl.emoji || '✦'),
        el('div', null,
          el('div', { class: 'hud-remnant-k' }, 'Remnant', sum.designation ? el('span', { class: 'hud-desig' }, String(sum.designation)) : null),
          el('div', { class: 'hud-remnant-name' }, cl.name || 'Merged galaxy'),
          cl.blurb ? el('p', { class: 'hud-remnant-blurb' }, cl.blurb) : null)),
      el('div', { class: 'hud-sum-actions' },
        el('button', { class: 'hud-btn hud-btn-primary', type: 'button', on: { click: () => h.onPoster() } }, ico('download', 16), 'Download poster'),
        el('button', { class: 'hud-btn', type: 'button', on: { click: () => h.onMergeReplay() } }, ico('replay', 16), 'Replay merge')),
      el('div', { class: 'hud-sum-explore' }, exploreBtn(a), exploreBtn(b)));

    D.summary.replaceChildren(content);
    D.tLive.textContent = "Merge complete. Merge made by the 'gravity' strategy.";
    S.summaryShown = true;
    S.summaryDismissed = false;
    syncSummary();
  }

  // ------------------------------------------------------------------ search palette
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_.]/g, '-');

  /** Ranked match of normalized query q against normalized name n → { score, hits[] } | null. */
  function match(n, q) {
    const i = n.indexOf(q);
    const hits = [];
    if (i >= 0) {
      let score = 1000 - i * 2 - (n.length - q.length) * 0.5;
      if (n.length === q.length) score += 400;
      else if (i === 0) score += 250;
      else if (SEP_RE.test(n[i - 1])) score += 150;
      for (let k = 0; k < q.length; k++) hits.push(i + k);
      return { score, hits };
    }
    let qi = 0, first = -1, last = -1, bonus = 0;
    for (let k = 0; k < n.length && qi < q.length; k++) {
      if (n[k] === q[qi]) {
        if (first < 0) first = k;
        last = k;
        hits.push(k);
        if (k === 0 || SEP_RE.test(n[k - 1])) bonus += 12;
        qi++;
      }
    }
    if (qi < q.length) return null;
    return { score: 500 - (last - first + 1 - q.length) * 8 - first * 2 + bonus, hits };
  }

  function highlight(name, hits) {
    if (!hits || !hits.length) return [name];
    const out = [];
    let i = 0, k = 0;
    while (i < name.length) {
      if (k < hits.length && hits[k] === i) {
        let j = i;
        while (k < hits.length && hits[k] === j) { j++; k++; }
        out.push(el('mark', { class: 'hud-s-hl' }, name.slice(i, j)));
        i = j;
      } else {
        const next = k < hits.length ? hits[k] : name.length;
        out.push(name.slice(i, next));
        i = next;
      }
    }
    return out;
  }

  function runSearch() {
    const raw = D.sInput.value.trim();
    const q = norm(raw);
    let res;
    if (!q) {
      res = S.sIndex.slice().sort((x, y) => y.stars - x.stars || y.prio - x.prio).slice(0, SEARCH_MAX).map((e) => ({ e, hits: null }));
      D.sHead.textContent = S.sIndex.length ? 'Brightest stars' : 'No stars in view';
    } else {
      res = [];
      for (const e of S.sIndex) {
        const m = match(e.norm, q);
        if (m) res.push({ e, hits: m.hits, score: m.score });
      }
      const count = res.length;
      res.sort((x, y) => y.score - x.score || y.e.stars - x.e.stars);
      res = res.slice(0, SEARCH_MAX);
      D.sHead.textContent = count ? count + ' ' + plural(count, 'star') + ' found' + (count > SEARCH_MAX ? ' · top ' + SEARCH_MAX : '') : 'No matches';
    }
    S.sResults = res;
    S.sActive = -1;
    const nodes = res.map((r, i) => {
      const star = r.e.it.star, repo = star.repo || {};
      const li = el('li', { class: 'hud-s-item', role: 'option', id: 'hud-s-opt-' + i, 'aria-selected': 'false', dataset: { i: String(i) } },
        el('span', { class: 'hud-s-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'hud-s-main' },
          el('span', { class: 'hud-s-name' }, highlight(r.e.name, r.hits)),
          el('span', { class: 'hud-s-sub' }, '@' + r.e.owner + ' · ' + (star.lang || repo.language || 'Other'))),
        el('span', { class: 'hud-s-stars', title: full(repo.stars) + ' stars' }, ico('star', 13), num(repo.stars)),
        el('span', { class: 'hud-s-go', 'aria-hidden': 'true' }, '↵'));
      return setC(li, cssColor(star.color));
    });
    if (!nodes.length && q) nodes.push(el('li', { class: 'hud-s-empty', role: 'presentation' }, 'No star named like “', raw, '” — try fewer letters.'));
    D.sList.replaceChildren(...nodes);
    D.sInput.removeAttribute('aria-activedescendant');
    if (res.length) setActive(0, false);
  }

  function setActive(i, scroll) {
    const n = S.sResults.length;
    if (!n) return;
    i = ((i % n) + n) % n;
    if (i === S.sActive) return;
    const prev = D.sList.children[S.sActive];
    if (prev) {
      prev.classList.remove('is-active');
      prev.setAttribute('aria-selected', 'false');
    }
    S.sActive = i;
    const cur = D.sList.children[i];
    if (!cur) return;
    cur.classList.add('is-active');
    cur.setAttribute('aria-selected', 'true');
    D.sInput.setAttribute('aria-activedescendant', cur.id);
    if (scroll && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const r = S.sResults[i];
    if (!r) return;
    const ref = r.e.it.ref;
    closeSearch();
    h.onSearchPick(ref);
  }

  function onSearchKey(e) {
    e.stopPropagation();
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      closeSearch();
    } else if (k === 'ArrowDown' || (e.ctrlKey && k === 'n')) {
      e.preventDefault();
      setActive(S.sActive + 1, true);
    } else if (k === 'ArrowUp' || (e.ctrlKey && k === 'p')) {
      e.preventDefault();
      setActive(S.sActive - 1, true);
    } else if (k === 'Enter' && !e.isComposing) {
      e.preventDefault();
      pick(S.sActive);
    } else if (k === 'Tab') {
      e.preventDefault(); // focus trap: the input and the esc button are the only stops
      (document.activeElement === D.sInput ? D.sEsc : D.sInput).focus();
    }
  }

  function openSearch(items) {
    ensure();
    S.sIndex = (Array.isArray(items) ? items : []).filter((it) => it && it.star).map((it) => {
      const name = String((it.star.repo && it.star.repo.name) || '');
      return { it, name, norm: norm(name), owner: String(it.owner || ''), stars: Number(it.star.repo && it.star.repo.stars) || 0, prio: Number(it.star.labelPriority) || 0 };
    });
    if (!S.searchOpen) {
      const ae = document.activeElement;
      S.sPrev = ae && ae !== document.body && !D.search.contains(ae) ? ae : null;
      S.searchOpen = true;
      D.search.classList.add('is-open');
      hideTooltip();
      GLX.bus.emit('hud:search', { open: true });
    }
    D.sInput.value = '';
    runSearch();
    D.sInput.focus({ preventScroll: true });
  }

  function closeSearch() {
    if (!D || !S.searchOpen) return;
    S.searchOpen = false;
    D.search.classList.remove('is-open');
    if (D.search.contains(document.activeElement)) document.activeElement.blur();
    const prev = S.sPrev;
    S.sPrev = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
    GLX.bus.emit('hud:search', { open: false });
  }

  // ------------------------------------------------------------------ public API
  function init(handlers) {
    for (const k of HANDLERS) h[k] = handlers && typeof handlers[k] === 'function' ? handlers[k] : h[k] || NOOP;
    build();
  }
  function ensure() {
    if (!D) build();
  }

  function showGalaxy(galaxy) {
    ensure();
    if (!galaxy) return;
    S.mode = 'galaxy';
    S.galaxy = galaxy;
    S.gals = null;
    S.summaryShown = false;
    stopTyping();
    hideCard();
    hideTooltip();
    clearLabels();
    vis(D.merge, false);
    renderProfile(galaxy);
    replay(D.profile);
    if (renderLegend(galaxy.langs || [], 'Spiral arms')) replay(D.legend);
    setLegendState(null);
    syncSummary();
  }

  function hide() {
    if (!D) return;
    S.mode = 'hidden';
    stopTyping();
    closeSearch();
    hideCard();
    hideTooltip();
    clearLabels();
    S.summaryShown = false;
    vis(D.profile, false);
    vis(D.merge, false);
    vis(D.legend, false);
    syncSummary();
  }

  GLX.HUD = {
    init,
    showGalaxy,
    showMerge,
    setMergeStatus,
    showMergeSummary,
    hide,
    setLegendState,
    showCard,
    hideCard,
    get cardOpen() { return S.cardOpen; },
    showTooltip,
    hideTooltip,
    updateLabels,
    openSearch,
    closeSearch,
    get searchOpen() { return S.searchOpen; }
  };
})();
