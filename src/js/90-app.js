/* Gitlaxy — 90-app.js
 * Application controller: boot, state machine, main loop, routing, input and the wiring of every module.
 * Modes: 'intro' (demo galaxy as backdrop + intro overlay) → 'loading' → 'galaxy' | 'merge'.
 */
(() => {
  'use strict';
  const GLX = window.GLX;
  const { util, math, config, SPRITE } = GLX;
  const { clamp, lerp, smoothstep } = util;

  const DEFAULT_VIEW = { yaw: 0.6, pitch: 0.72, dist: 2.9 };
  const PHASE_LABEL = {
    approach: 'Approach',
    'first-passage': 'First passage',
    separating: 'Tidal tails',
    'second-approach': 'Second approach',
    merging: 'Coalescing',
    merged: 'Merged'
  };
  const PHASE_STATUS = {
    'first-passage': ['Tidal forces engaged…', 'Stellar streams are tearing loose'],
    separating: ['Galaxies swing apart', 'Tidal tails unfurling across the void'],
    'second-approach': ['Falling back together…', 'Gravity always wins'],
    merging: ['Cores coalescing…', 'Rewriting history, one orbit at a time'],
    merged: ["Merge made by the 'gravity' strategy.", '']
  };

  const S = (GLX.state = {
    mode: 'boot',
    background: false,
    galaxies: [],
    summary: null,
    reveal: 1,
    playing: false,
    playDuration: 14,
    revealDone: true,
    rotation: 0,
    selected: null,
    hovered: null,
    highlightLang: null,
    soloLang: null,
    showConstellations: false,
    fade: 0,
    fadeTarget: 1,
    partAlpha: 1,
    time: 0,
    mergeSpeed: 1,
    mergePlaying: true,
    mergeClock: 0,
    mergeDone: false
  });

  let canvas = null, renderer = null, camera = null, effects = null, sim = null;
  let loadToken = 0, abortCtrl = null, introGalaxy = null;
  let lastNow = 0, frameErrors = 0, simDirty = false, dragClass = false;

  const sprites = new GLX.SpriteBuffer(4096);
  const lines = new GLX.LineBuffer(2048);
  const IDENTITY = math.mat4();
  const models = [math.mat4(), math.mat4()];
  const slotFrames = [
    { slot: 0, model: models[0], reveal: 1, alpha: 1 },
    { slot: 1, model: models[1], reveal: 1, alpha: 1 }
  ];
  const frame = { time: 0, proj: null, view: null, fade: 1, skyAlpha: 1, particles: [], sprites, lines };
  const slots = [makeSlot(), makeSlot()];
  const tmp3 = [0, 0, 0], tmpCore = [0, 0, 0], tmpSel = [0, 0, 0];
  const ORIGIN = [0, 0, 0];
  const pointer = { x: 0, y: 0, inside: false };
  const tooltipPos = { x: -1, y: -1, key: '' };
  const labelItems = [], labelPool = [];
  const statusQueue = [];
  let statusAt = -10, conflictPlan = [];

  function makeSlot() {
    return { starWorld: new Float32Array(0), nebWorld: new Float32Array(0), screen: [], labelOrder: [], labelKeys: [], colorCss: [] };
  }

  // ------------------------------------------------------------------ helpers
  const isLive = () => S.mode === 'galaxy' || S.mode === 'merge';
  const revealFor = () => (S.mode === 'merge' ? 1 : S.reveal);
  const sameRef = (a, b) => (a === b) || (!!a && !!b && a.slot === b.slot && a.index === b.index);
  const starOf = (ref) => (ref && S.galaxies[ref.slot] ? S.galaxies[ref.slot].stars[ref.index] : null);
  const particleBudget = (kind) =>
    kind === 'merge'
      ? (util.isMobile() ? config.PARTICLES_MERGE_MOBILE : config.PARTICLES_MERGE_DESKTOP)
      : (util.isMobile() ? config.PARTICLES_MOBILE : config.PARTICLES_DESKTOP);
  const nextFrame = () => new Promise((res) => requestAnimationFrame(() => res()));

  function msSinceInteraction() {
    const li = camera && camera.lastInteraction ? camera.lastInteraction : 0;
    if (!li) return Infinity;
    return (li > 1e12 ? Date.now() : performance.now()) - li;
  }

  function starPos(ref, out) {
    const sw = slots[ref.slot] && slots[ref.slot].starWorld;
    const i = 3 * ref.index;
    if (!sw || i + 2 >= sw.length) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    out[0] = sw[i]; out[1] = sw[i + 1]; out[2] = sw[i + 2];
    return out;
  }

  function coreWorld(slot, out) {
    if (S.mode === 'merge' && sim && sim.corePos && sim.corePos[slot]) {
      const c = sim.corePos[slot];
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
    } else {
      out[0] = 0; out[1] = 0; out[2] = 0;
    }
    return out;
  }

  const effectsCtx = {
    starPos,
    starSize(ref) {
      const s = starOf(ref);
      return s ? s.size : 0.02;
    },
    galaxyCenter: coreWorld,
    galaxyRadius: 1,
    camDist: DEFAULT_VIEW.dist,
    time: 0
  };

  function setHash(h) {
    const url = location.pathname + location.search + (h ? '#' + h : '');
    try {
      history.replaceState(null, '', url);
    } catch (e) {
      ignoreHash = true;
      location.hash = h || '';
    }
  }
  let ignoreHash = false;

  // ------------------------------------------------------------------ scene setup
  function prepareSlot(slot, g) {
    const d = slots[slot];
    const n = g.stars.length;
    d.starWorld = new Float32Array(n * 3);
    d.nebWorld = new Float32Array(g.nebulae.length * 3);
    d.screen = new Array(n);
    d.labelKeys = new Array(n);
    d.colorCss = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = g.stars[i].pos;
      d.starWorld[3 * i] = p[0]; d.starWorld[3 * i + 1] = p[1]; d.starWorld[3 * i + 2] = p[2];
      d.screen[i] = { x: 0, y: 0, depth: 0, visible: false, r: 0, on: false };
      d.labelKeys[i] = slot + ':' + i;
      d.colorCss[i] = GLX.color.rgbToCss(g.stars[i].color, 1);
    }
    for (let i = 0; i < g.nebulae.length; i++) {
      const p = g.nebulae[i].pos;
      d.nebWorld[3 * i] = p[0]; d.nebWorld[3 * i + 1] = p[1]; d.nebWorld[3 * i + 2] = p[2];
    }
    d.labelOrder = g.stars
      .map((s, i) => i)
      .filter((i) => g.stars[i].labelPriority > 0)
      .sort((a, b) => g.stars[b].labelPriority - g.stars[a].labelPriority);
  }

  function resetInteraction() {
    S.selected = null;
    S.hovered = null;
    S.highlightLang = null;
    S.soloLang = null;
    pointer.inside = false;
    tooltipPos.key = '';
    effects.reset();
    effects.cometsEnabled = false;
    GLX.HUD.hideTooltip();
    GLX.HUD.hideCard();
    canvas.classList.remove('is-hovering');
  }

  function getIntroGalaxy() {
    if (!introGalaxy) {
      introGalaxy = GLX.Model.build(GLX.Data.demoUser('mona'), {
        particleCount: Math.round(particleBudget('single') * 0.8)
      });
    }
    return introGalaxy;
  }

  /** Show a single galaxy. background=true → intro backdrop (no HUD, no replay). */
  function showGalaxy(g, opts = {}) {
    const background = !!opts.background;
    teardownMerge();
    resetInteraction();
    S.mode = background ? 'intro' : 'galaxy';
    S.background = background;
    S.galaxies = [g];
    S.summary = null;
    S.rotation = 0;
    renderer.clearParticles(1);
    renderer.setParticles(0, g.particles, { dynamic: false });
    prepareSlot(0, g);
    slots[1] = makeSlot();

    S.fade = 0;
    S.fadeTarget = background ? 0.8 : 1;
    if (background) {
      S.reveal = 1;
      S.playing = false;
      S.revealDone = true;
      camera.setGoal({ yaw: 0.2, pitch: 0.42, dist: 3.3, target: [0, 0, 0] }, { instant: true });
      camera.setGoal({ yaw: 0.6, pitch: 0.5, dist: 3.0 }, { duration: 6 });
      return;
    }

    S.reveal = -0.02;
    S.playing = true;
    S.revealDone = false;
    S.playDuration = clamp(9 + g.stars.length * 0.03, 10, 18);
    // Cinematic swoop while the galaxy forms.
    camera.setGoal({ yaw: DEFAULT_VIEW.yaw - 1.3, pitch: 1.28, dist: 6.2, target: [0, 0, 0] }, { instant: true });
    camera.setGoal({ yaw: DEFAULT_VIEW.yaw, pitch: DEFAULT_VIEW.pitch, dist: DEFAULT_VIEW.dist }, { duration: Math.min(S.playDuration * 0.55, 7) });

    GLX.Chrome.closeAllModals();
    GLX.Chrome.hideIntro();
    GLX.Chrome.hideLoading();
    GLX.Chrome.hideMergeBar();
    GLX.Chrome.clearTicker();
    GLX.HUD.showGalaxy(g);
    GLX.HUD.setLegendState({ highlight: null, solo: null });
    GLX.Chrome.showToolbar('galaxy');
    GLX.Chrome.showTimeline(g.t0, g.t1);
    GLX.Chrome.setConstellations(S.showConstellations);
    GLX.Chrome.setSound(GLX.Audio.enabled);
    GLX.Audio.ambient('calm');
    GLX.Audio.whoosh();
    effects.burst([0, 0, 0], [1, 0.86, 0.72], 0.55);
    document.title = '@' + g.profile.login + ' · Gitlaxy';
    if (!g.stars.length) {
      GLX.Chrome.toast('No public repositories yet — the universe is waiting for your first star ✨', { type: 'info', timeout: 7000 });
    }
  }

  function startMerge(ua, ub) {
    const n = particleBudget('merge');
    const gA = GLX.Model.build(ua, { particleCount: n });
    const gB = GLX.Model.build(ub, { particleCount: n });
    const summary = GLX.Model.mergeSummary(gA, gB);
    teardownMerge();
    resetInteraction();
    S.mode = 'merge';
    S.background = false;
    S.galaxies = [gA, gB];
    S.summary = summary;
    S.mergeDone = false;
    S.mergePlaying = true;
    S.mergeSpeed = 1;
    S.mergeClock = 0;
    conflictPlan = [];
    statusQueue.length = 0;
    statusAt = -10;

    sim = new GLX.MergeSim(gA, gB);
    sim.speed = S.mergeSpeed;
    prepareSlot(0, gA);
    prepareSlot(1, gB);
    renderer.setParticles(0, gA.particles, { dynamic: true });
    renderer.setParticles(1, gB.particles, { dynamic: true });
    syncSimArrays();
    simDirty = true;

    S.fade = 0;
    S.fadeTarget = 1;
    camera.setGoal({ yaw: 0.1, pitch: 1.3, dist: 10, target: [0, 0, 0] }, { instant: true });
    camera.setGoal({ yaw: 0.45, pitch: 0.95, dist: 6.4 }, { duration: 4 });

    GLX.Chrome.closeAllModals();
    GLX.Chrome.hideIntro();
    GLX.Chrome.hideLoading();
    GLX.Chrome.hideTimeline();
    GLX.Chrome.clearTicker();
    GLX.Chrome.showToolbar('merge');
    GLX.Chrome.showMergeBar();
    GLX.Chrome.setSound(GLX.Audio.enabled);
    GLX.HUD.showMerge(gA, gB, summary);
    GLX.HUD.setLegendState({ highlight: null, solo: null });
    queueStatus('$ git merge @' + gB.profile.login,
      'Merging into @' + gA.profile.login + ' · ' + util.fmtNum(gA.stars.length + gB.stars.length) + ' stars in flight');
    GLX.Audio.ambient('tense');
    GLX.Audio.whoosh();
    document.title = '@' + gA.profile.login + ' ⨯ @' + gB.profile.login + ' · Gitlaxy';
  }

  function syncSimArrays() {
    if (!sim) return;
    for (let s = 0; s < 2; s++) {
      slots[s].starWorld = sim.starPos[s];
      slots[s].nebWorld = sim.nebPos[s];
    }
  }

  function teardownMerge() {
    sim = null;
    conflictPlan = [];
    statusQueue.length = 0;
  }

  function restartMerge() {
    if (S.mode !== 'merge' || !sim) return;
    const [gA, gB] = S.galaxies;
    sim.reset();
    syncSimArrays();
    simDirty = true;
    effects.reset();
    S.selected = null;
    S.hovered = null;
    GLX.HUD.hideCard();
    S.mergeDone = false;
    S.mergePlaying = true;
    S.mergeClock = 0;
    conflictPlan = [];
    statusQueue.length = 0;
    statusAt = -10;
    GLX.HUD.showMerge(gA, gB, S.summary);
    queueStatus('$ git merge @' + gB.profile.login, 'Replaying the collision');
    camera.setGoal({ yaw: 0.1, pitch: 1.3, dist: 10, target: [0, 0, 0] }, { instant: true });
    camera.setGoal({ yaw: 0.45, pitch: 0.95, dist: 6.4 }, { duration: 3 });
    GLX.Audio.ambient('tense');
    GLX.Audio.whoosh();
  }

  // ------------------------------------------------------------------ launching
  function enterLoading(msg) {
    S.mode = 'loading';
    GLX.HUD.hide();
    GLX.Chrome.hideIntro();
    GLX.Chrome.hideToolbar();
    GLX.Chrome.hideTimeline();
    GLX.Chrome.hideMergeBar();
    GLX.Chrome.clearTicker();
    GLX.Chrome.showLoading(msg);
    if (!S.galaxies.length || !S.background) showGalaxy(getIntroGalaxy(), { background: true });
    S.mode = 'loading';
  }

  async function launch(raw) {
    GLX.Audio.init();
    const login = GLX.Data.parseLogin(raw || '');
    if (!login) {
      showIntro({ error: 'That doesn’t look like a GitHub username.', prefill: raw });
      return;
    }
    const token = ++loadToken;
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    enterLoading('Contacting api.github.com…');
    try {
      const user = await GLX.Data.loadUser(login, {
        signal: abortCtrl.signal,
        onProgress: (m) => { if (token === loadToken) GLX.Chrome.setLoading(m); }
      });
      if (token !== loadToken) return;
      GLX.Chrome.setLoading('Igniting ' + util.fmtNum(user.repos.length) + ' stars…');
      await nextFrame();
      if (token !== loadToken) return;
      const g = GLX.Model.build(user, { particleCount: particleBudget('single') });
      GLX.Data.recent.add(user.profile.login);
      showGalaxy(g);
      setHash('@' + user.profile.login);
      if (user.truncated) {
        GLX.Chrome.toast('Showing the ' + user.repos.length + ' most recently active of ' + util.fmtNum(user.profile.publicRepos) + ' repositories.', { type: 'info', timeout: 6000 });
      }
    } catch (err) {
      if (token === loadToken) handleLoadError(err, login);
    }
  }

  function launchDemo(id = 'mona') {
    GLX.Audio.init();
    loadToken++;
    if (abortCtrl) abortCtrl.abort();
    const g = GLX.Model.build(GLX.Data.demoUser(id), { particleCount: particleBudget('single') });
    showGalaxy(g);
    setHash(id === 'mona' ? 'demo' : 'demo-' + id);
  }

  async function launchMerge(rawA, rawB) {
    GLX.Audio.init();
    const a = GLX.Data.parseLogin(rawA || '');
    const b = GLX.Data.parseLogin(rawB || '');
    if (!a || !b) {
      GLX.Chrome.toast('Enter two valid GitHub usernames to merge.', { type: 'warn' });
      return;
    }
    if (a.toLowerCase() === b.toLowerCase()) {
      GLX.Chrome.toast('Already up to date. (Pick two different galaxies to merge.)', { type: 'warn' });
      return;
    }
    const token = ++loadToken;
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    enterLoading('Fetching @' + a + ' and @' + b + '…');
    try {
      const opts = { signal: abortCtrl.signal, onProgress: (m) => { if (token === loadToken) GLX.Chrome.setLoading(m); } };
      const [ua, ub] = await Promise.all([GLX.Data.loadUser(a, opts), GLX.Data.loadUser(b, opts)]);
      if (token !== loadToken) return;
      GLX.Chrome.setLoading('Aligning orbits…');
      await nextFrame();
      if (token !== loadToken) return;
      GLX.Data.recent.add(ua.profile.login);
      GLX.Data.recent.add(ub.profile.login);
      startMerge(ua, ub);
      setHash('merge=' + ua.profile.login + ',' + ub.profile.login);
    } catch (err) {
      if (token === loadToken) handleLoadError(err, a + ' ⨯ ' + b);
    }
  }

  function launchMergeDemo() {
    GLX.Audio.init();
    loadToken++;
    if (abortCtrl) abortCtrl.abort();
    startMerge(GLX.Data.demoUser('mona'), GLX.Data.demoUser('hubot'));
    setHash('demo-merge');
  }

  function handleLoadError(err, what) {
    GLX.Chrome.hideLoading();
    if (err && err.code === 'aborted') {
      goHome();
      return;
    }
    console.warn('[gitlaxy] could not load', what, err);
    const msg = (err && err.message) || 'Something went wrong while charting that galaxy.';
    goHome({ error: msg, prefill: typeof what === 'string' && what.indexOf(' ⨯ ') < 0 ? what : '' });
    const code = err && err.code;
    const action = code === 'rate_limited' || code === 'network'
      ? { label: 'Explore demo', fn: () => launchDemo('mona') }
      : code === 'bad_token'
        ? { label: 'Update token', fn: () => GLX.Chrome.openTokenDialog() }
        : null;
    GLX.Chrome.toast(msg, { type: 'error', timeout: 8000, action });
  }

  function cancelLoading() {
    loadToken++;
    if (abortCtrl) abortCtrl.abort();
    goHome();
  }

  function showIntro(opts = {}) {
    S.mode = 'intro';
    GLX.Chrome.showIntro({ recent: GLX.Data.recent.list(), error: opts.error, prefill: opts.prefill });
  }

  function goHome(opts = {}) {
    loadToken++;
    if (abortCtrl) abortCtrl.abort();
    GLX.HUD.hide();
    GLX.Chrome.closeAllModals();
    GLX.Chrome.hideLoading();
    GLX.Chrome.hideToolbar();
    GLX.Chrome.hideTimeline();
    GLX.Chrome.hideMergeBar();
    GLX.Chrome.clearTicker();
    GLX.HUD.updateLabels((labelItems.length = 0, labelItems));
    GLX.Audio.ambient('off');
    setHash('');
    document.title = 'Gitlaxy — every repo is a star';
    if (!(S.background && S.galaxies[0] === introGalaxy)) showGalaxy(getIntroGalaxy(), { background: true });
    showIntro(opts);
  }

  function route() {
    let h = '';
    try { h = decodeURIComponent(location.hash.replace(/^#/, '')).trim(); } catch (e) { h = ''; }
    if (!h) return false;
    if (h === 'demo') { launchDemo('mona'); return true; }
    if (h === 'demo-hubot') { launchDemo('hubot'); return true; }
    if (h === 'demo-merge') { launchMergeDemo(); return true; }
    const mm = h.match(/^merge=([^,+\s]+)[,+\s]+([^,+\s]+)$/i);
    if (mm) { launchMerge(mm[1], mm[2]); return true; }
    const um = h.match(/^(?:@|u=)(.+)$/i);
    if (um) { launch(um[1]); return true; }
    return false;
  }

  // ------------------------------------------------------------------ selection & interaction
  function selectStar(ref, opts = {}) {
    const g = S.galaxies[ref.slot];
    const star = g && g.stars[ref.index];
    if (!star) return;
    ensureRevealed(star);
    S.selected = { slot: ref.slot, index: ref.index };
    effects.setSelected({ ref: S.selected, star });
    GLX.HUD.showCard(star, g, S.selected);
    GLX.Audio.select();
    const p = starPos(S.selected, tmpSel);
    const dist = clamp(0.24 + star.size * 7, 0.28, 0.75);
    camera.setGoal({ target: [p[0], p[1], p[2]], dist }, opts.instant ? { instant: true } : { duration: 1.6 });
  }

  function deselect() {
    if (!S.selected) return;
    S.selected = null;
    effects.setSelected(null);
    GLX.HUD.hideCard();
    camera.setGoal({ target: [0, 0, 0], dist: S.mode === 'merge' ? mergeDist() : DEFAULT_VIEW.dist }, { duration: 1.4 });
  }

  function ensureRevealed(star) {
    if (S.mode !== 'galaxy' || star.birth <= S.reveal) return;
    S.playing = false;
    const prev = S.reveal;
    S.reveal = 1;
    handleBirths(prev, 1, false);
    onRevealComplete();
  }

  function navStar(dir) {
    if (!isLive()) return;
    const slot = S.selected ? S.selected.slot : 0;
    const g = S.galaxies[slot];
    if (!g || !g.stars.length) return;
    const reveal = revealFor();
    const n = g.stars.length;
    let i = S.selected ? S.selected.index : (dir > 0 ? -1 : n);
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (g.stars[i].birth <= reveal) { selectStar({ slot, index: i }); return; }
    }
  }

  function setHovered(ref) {
    S.hovered = ref;
    effects.setHovered(ref ? { ref, star: starOf(ref) } : null);
    canvas.classList.toggle('is-hovering', !!ref);
    if (ref) GLX.Audio.hover();
    else {
      GLX.HUD.hideTooltip();
      tooltipPos.key = '';
    }
  }

  function pickAt(x, y) {
    let bestSlot = -1, bestIndex = -1, bestScore = Infinity;
    for (let slot = 0; slot < S.galaxies.length; slot++) {
      const arr = slots[slot].screen;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (!o.on) continue;
        const dx = o.x - x, dy = o.y - y;
        const rad = Math.max(13, o.r * 1.8);
        const d2 = dx * dx + dy * dy;
        if (d2 > rad * rad) continue;
        const score = d2 / (rad * rad) + o.depth * 0.015;
        if (score < bestScore) { bestScore = score; bestSlot = slot; bestIndex = i; }
      }
    }
    return bestSlot < 0 ? null : { slot: bestSlot, index: bestIndex };
  }

  function updateHover() {
    const blocked = !isLive() || !pointer.inside || camera.isDragging || GLX.HUD.searchOpen || GLX.Chrome.helpOpen;
    if (blocked) {
      if (S.hovered) setHovered(null);
      return;
    }
    const ref = pickAt(pointer.x, pointer.y);
    if (!sameRef(ref, S.hovered)) setHovered(ref);
    if (S.hovered) {
      const o = slots[S.hovered.slot].screen[S.hovered.index];
      const key = S.hovered.slot + ':' + S.hovered.index;
      if (key !== tooltipPos.key || Math.abs(o.x - tooltipPos.x) > 0.5 || Math.abs(o.y - tooltipPos.y) > 0.5) {
        tooltipPos.key = key; tooltipPos.x = o.x; tooltipPos.y = o.y;
        GLX.HUD.showTooltip(o.x, o.y, starOf(S.hovered));
      }
    }
  }

  function setSolo(lang) {
    S.soloLang = lang;
    GLX.HUD.setLegendState({ highlight: S.highlightLang, solo: S.soloLang });
  }

  function togglePlay() {
    if (S.mode === 'merge') {
      S.mergePlaying = !S.mergePlaying;
      return;
    }
    if (S.mode !== 'galaxy') return;
    if (S.reveal >= 1) replay();
    else S.playing = !S.playing;
  }

  function replay() {
    if (S.mode === 'merge') { restartMerge(); return; }
    if (S.mode !== 'galaxy') return;
    deselect();
    effects.reset();
    effects.cometsEnabled = false;
    GLX.Chrome.clearTicker();
    S.reveal = -0.02;
    S.playing = true;
    S.revealDone = false;
    camera.setGoal({ yaw: camera.yaw - 0.9, pitch: 1.2, dist: 5.2, target: [0, 0, 0] }, { duration: 0.8 });
    setTimeout(() => {
      if (S.mode === 'galaxy') camera.setGoal({ yaw: DEFAULT_VIEW.yaw, pitch: DEFAULT_VIEW.pitch, dist: DEFAULT_VIEW.dist }, { duration: 6 });
    }, 850);
    effects.burst([0, 0, 0], [1, 0.86, 0.72], 0.5);
    GLX.Audio.whoosh();
  }

  function scrub(v) {
    if (S.mode !== 'galaxy') return;
    S.playing = false;
    const prev = S.reveal;
    S.reveal = clamp(v, 0, 1);
    if (S.reveal > prev && S.reveal - prev < 0.15) handleBirths(prev, S.reveal, false);
    if (S.reveal >= 1) onRevealComplete();
  }

  function toggleSound() {
    GLX.Audio.init();
    const on = GLX.Audio.toggle();
    GLX.Chrome.setSound(on);
    GLX.Chrome.toast(on ? 'Sound on 🔊' : 'Sound off', { type: 'info', timeout: 1600 });
  }

  function toggleConstellations() {
    if (!isLive()) return;
    S.showConstellations = !S.showConstellations;
    GLX.Chrome.setConstellations(S.showConstellations);
  }

  function openSearch() {
    if (!isLive()) return;
    const items = [];
    const reveal = revealFor();
    for (let slot = 0; slot < S.galaxies.length; slot++) {
      const g = S.galaxies[slot];
      for (let i = 0; i < g.stars.length; i++) {
        if (g.stars[i].birth <= reveal || S.mode === 'galaxy') items.push({ ref: { slot, index: i }, star: g.stars[i], owner: g.profile.login });
      }
    }
    GLX.HUD.openSearch(items);
  }

  function openMergeDialog() {
    if (!isLive()) return;
    GLX.Chrome.openMergeDialog(S.galaxies[0] ? S.galaxies[0].profile.login : '');
  }

  function resetView() {
    if (!isLive()) return;
    deselect();
    camera.setGoal({ yaw: DEFAULT_VIEW.yaw, pitch: S.mode === 'merge' ? 0.95 : DEFAULT_VIEW.pitch, dist: S.mode === 'merge' ? mergeDist() : DEFAULT_VIEW.dist, target: [0, 0, 0] }, { duration: 1.2 });
  }

  function setMergeSpeed(mult) {
    S.mergeSpeed = clamp(Number(mult) || 1, 0.25, 8);
    if (sim) sim.speed = S.mergeSpeed;
  }

  async function exportPoster() {
    if (!isLive()) return;
    GLX.Audio.uiClick();
    const t = GLX.Chrome.toast('Rendering your poster…', { type: 'info', timeout: 0 });
    try {
      await GLX.Poster.exportPoster({
        glCanvas: canvas,
        render: renderNow,
        galaxy: S.mode === 'galaxy' ? S.galaxies[0] : undefined,
        galaxies: S.mode === 'merge' ? [S.galaxies[0], S.galaxies[1]] : undefined,
        summary: S.mode === 'merge' ? S.summary : undefined
      });
      t.close();
      GLX.Chrome.toast('Poster downloaded — share your galaxy! 🖼️', { type: 'success' });
    } catch (e) {
      t.close();
      console.error('[gitlaxy] poster failed', e);
      GLX.Chrome.toast('Couldn’t create the poster this time.', { type: 'error' });
    }
  }

  function exploreLogin(login) {
    const g = S.galaxies.find((x) => x.profile.login === login);
    if (g && g.profile.isDemo) launchDemo(String(login).toLowerCase() === 'hubot' ? 'hubot' : 'mona');
    else launch(login);
  }

  // ------------------------------------------------------------------ Big Bang replay
  function handleBirths(prev, cur, withSound) {
    const g = S.galaxies[0];
    if (!g || cur <= prev) return;
    const stars = g.stars;
    const scr = slots[0].screen;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      if (s.birth <= prev || s.birth > cur) continue;
      const strength = clamp(0.35 + Math.log10(s.repo.stars + 1) / 3.5, 0.3, 1);
      effects.birth({ slot: 0, index: i }, s.color, strength);
      if (withSound && !S.background) {
        const o = scr[i];
        const pan = o && o.visible && renderer.width ? clamp((o.x / renderer.width) * 2 - 1, -1, 1) : 0;
        GLX.Audio.starBirth({ lang: s.lang, stars: s.repo.stars, pan, loud: strength });
      }
    }
  }

  function onRevealComplete() {
    if (S.revealDone) return;
    S.revealDone = true;
    S.playing = false;
    if (S.background || S.mode !== 'galaxy') return;
    const g = S.galaxies[0];
    GLX.Audio.galaxyComplete();
    GLX.Chrome.toast('✨ ' + g.stars.length + ' stars charted · ' + g.classification.emoji + ' ' + g.classification.name, { type: 'success', timeout: 5000 });
    startComets(g);
  }

  function startComets(g) {
    const events = (g.user && g.user.events) || [];
    const own = new Map();
    for (let i = 0; i < g.stars.length; i++) own.set(String(g.stars[i].repo.fullName).toLowerCase(), { slot: 0, index: i });
    effects.setEvents(events, own);
    effects.cometsEnabled = events.length > 0;
  }

  function panFor(pos) {
    if (!pos || !renderer.width) return 0;
    const o = camera.project(pos[0], pos[1], pos[2]);
    return o && o.visible ? clamp((o.x / renderer.width) * 2 - 1, -1, 1) : 0;
  }

  function shortRepo(full) {
    const g = S.galaxies[0];
    const own = g && g.profile && String(full).toLowerCase().startsWith(String(g.profile.login).toLowerCase() + '/');
    return own ? String(full).split('/')[1] : String(full);
  }

  // ------------------------------------------------------------------ merge choreography
  function mergeDist() {
    const d = sim ? sim.coreDistance : 5.5;
    return clamp(2.6 + d * 0.7, 3.2, 7.0);
  }

  function queueStatus(text, sub) {
    statusQueue.push([text, sub || '']);
    while (statusQueue.length > 5) statusQueue.shift();
  }

  function pumpStatus() {
    if (!statusQueue.length || S.time - statusAt < 1.7) return;
    const [text, sub] = statusQueue.shift();
    statusAt = S.time;
    GLX.HUD.setMergeStatus(text, sub);
  }

  function onSimEvent(e) {
    if (e === 'first-contact') {
      GLX.Audio.collision(0.9);
      camera.shake(0.7);
      coreWorld(0, tmpCore);
      effects.burst([tmpCore[0] * 0.5, 0, tmpCore[2] * 0.5], [1, 0.82, 0.62], 1.1);
      planConflicts();
    } else if (e === 'pericenter') {
      GLX.Audio.collision(0.45);
      camera.shake(0.35);
    } else if (e === 'merged') {
      onMerged();
    } else if (typeof e === 'string' && e.indexOf('phase:') === 0) {
      const st = PHASE_STATUS[e.slice(6)];
      if (st && e !== 'phase:merged') queueStatus(st[0], st[1]);
    }
  }

  function planConflicts() {
    const cs = (S.summary && S.summary.conflicts) || [];
    conflictPlan = cs.slice(0, 8).map((c, i) => ({ at: S.mergeClock + 0.5 + i * 1.15, c, stage: 0, announce: i < 3 }));
    if (!cs.length) queueStatus('No conflicts detected', 'Clean merge — gravity has it handled');
    else if (cs.length > 3) queueStatus('CONFLICT (gravity): ' + cs.length + ' repos collide', 'Automatic merge in progress…');
  }

  function processConflicts() {
    for (let k = 0; k < conflictPlan.length; k++) {
      const p = conflictPlan[k];
      if (p.stage === 0 && S.mergeClock >= p.at) {
        p.stage = 1;
        effects.bolt({ slot: 0, index: p.c.a }, { slot: 1, index: p.c.b }, { duration: 2.4 });
        GLX.Audio.conflict();
        if (p.announce) queueStatus('CONFLICT (gravity): Merge conflict in ' + p.c.name, 'Automatic merge failed; resolving…');
      } else if (p.stage === 1 && S.mergeClock >= p.at + 2.4) {
        p.stage = 2;
        GLX.Audio.resolve();
        if (p.announce) queueStatus('Auto-resolved ' + p.c.name + ' ✓', '');
      }
    }
  }

  function onMerged() {
    if (S.mergeDone) return;
    S.mergeDone = true;
    GLX.Audio.mergeComplete();
    GLX.Audio.ambient('resolved');
    effects.burst([0, 0, 0], [1, 0.9, 0.78], 1.4);
    camera.shake(0.45);
    statusQueue.length = 0;
    statusAt = -10;
    const sum = S.summary;
    queueStatus(PHASE_STATUS.merged[0], '@' + sum.a.login + ' ⨯ @' + sum.b.login + ' → ' + sum.classification.emoji + ' ' + sum.classification.name);
    setTimeout(() => {
      if (S.mode === 'merge' && S.mergeDone && S.summary === sum) GLX.HUD.showMergeSummary(sum);
    }, 1800);
  }

  // ------------------------------------------------------------------ per-frame
  function updateGalaxyMode(dt) {
    const g = S.galaxies[0];
    if (!g) return;
    S.rotation += dt * config.ROTATION_SPEED;
    math.rotationY(models[0], S.rotation);
    const d = slots[0], sw = d.starWorld, nw = d.nebWorld;
    for (let i = 0; i < g.stars.length; i++) {
      const p = g.stars[i].pos;
      math.transformPoint(tmp3, models[0], p[0], p[1], p[2]);
      sw[3 * i] = tmp3[0]; sw[3 * i + 1] = tmp3[1]; sw[3 * i + 2] = tmp3[2];
    }
    for (let i = 0; i < g.nebulae.length; i++) {
      const p = g.nebulae[i].pos;
      math.transformPoint(tmp3, models[0], p[0], p[1], p[2]);
      nw[3 * i] = tmp3[0]; nw[3 * i + 1] = tmp3[1]; nw[3 * i + 2] = tmp3[2];
    }
    if (S.playing && S.mode === 'galaxy') {
      const prev = S.reveal;
      S.reveal = Math.min(1, S.reveal + dt / S.playDuration);
      handleBirths(prev, S.reveal, true);
      if (S.reveal >= 1) onRevealComplete();
    }
  }

  function updateMergeMode(dt) {
    if (!sim) return;
    if (S.mergePlaying) {
      const evs = sim.step(dt);
      S.mergeClock += dt * S.mergeSpeed;
      simDirty = true;
      if (evs && evs.length) for (let i = 0; i < evs.length; i++) onSimEvent(evs[i]);
    }
    syncSimArrays();
    if (simDirty) {
      renderer.updateParticlePositions(0, sim.partPos[0]);
      renderer.updateParticlePositions(1, sim.partPos[1]);
      simDirty = false;
    }
    processConflicts();
    pumpStatus();
    if (!S.selected && S.mergeClock > 3.5 && msSinceInteraction() > 6000) {
      ORIGIN[0] = 0; ORIGIN[1] = 0; ORIGIN[2] = 0;
      camera.follow(ORIGIN);
      const want = mergeDist();
      if (Math.abs(camera.dist - want) > 0.05) camera.setGoal({ dist: lerp(camera.dist, want, 0.02) });
    }
  }

  function projectStars(m) {
    const h = renderer.height;
    const p5 = m.proj[5];
    const reveal = revealFor();
    for (let slot = 0; slot < S.galaxies.length; slot++) {
      const g = S.galaxies[slot];
      const d = slots[slot], sw = d.starWorld, scr = d.screen;
      for (let i = 0; i < scr.length; i++) {
        const o = scr[i];
        camera.project(sw[3 * i], sw[3 * i + 1], sw[3 * i + 2], o);
        o.r = o.visible && o.depth > 0 ? (g.stars[i].size * p5 * h * 0.5) / o.depth : 0;
        o.on = o.visible && g.stars[i].birth <= reveal;
      }
    }
  }

  function buildScene() {
    sprites.reset();
    lines.reset();
    frame.particles.length = 0;
    const reveal = revealFor();
    const hl = S.soloLang || S.highlightLang;
    const merge = S.mode === 'merge';
    for (let slot = 0; slot < S.galaxies.length; slot++) {
      const g = S.galaxies[slot];
      const sf = slotFrames[slot];
      sf.model = merge ? IDENTITY : models[slot];
      sf.reveal = reveal;
      sf.alpha = S.partAlpha * (merge ? 1.8 : 1);
      frame.particles.push(sf);
      emitNebulae(g, slot, reveal, hl);
      emitCore(slot, reveal);
      emitStars(g, slot, reveal, hl);
      emitConstellations(g, slot, reveal, hl);
    }
  }

  function emitNebulae(g, slot, reveal, hl) {
    const nw = slots[slot].nebWorld;
    const dim = (hl ? 0.45 : 1) * (S.mode === 'merge' ? 0.45 : 0.7);
    for (let i = 0; i < g.nebulae.length; i++) {
      const n = g.nebulae[i];
      const a = n.alpha * smoothstep(n.birth - 0.08, n.birth + 0.04, reveal) * dim;
      sprites.push(nw[3 * i], nw[3 * i + 1], nw[3 * i + 2], n.size, n.color[0], n.color[1], n.color[2], a, SPRITE.NEBULA, n.seed, 0.55);
    }
  }

  function emitCore(slot, reveal) {
    const c = coreWorld(slot, tmpCore);
    const rv = smoothstep(-0.02, 0.12, reveal);
    const pulse = 1 + 0.04 * Math.sin(S.time * 0.9 + slot * 2);
    sprites.push(c[0], c[1], c[2], 0.46 * pulse, 1.0, 0.8, 0.6, 0.12 * rv, SPRITE.GLOW, 0.0);
    sprites.push(c[0], c[1], c[2], 0.12, 1.0, 0.9, 0.78, 0.22 * rv, SPRITE.GLOW, 0.5);
    sprites.push(c[0], c[1], c[2], 0.03, 1.0, 0.98, 0.94, 0.6 * rv, SPRITE.GLOW, 1.0);
  }

  function emitStars(g, slot, reveal, hl) {
    const sw = slots[slot].starWorld;
    const sel = S.selected, hov = S.hovered, t = S.time;
    for (let i = 0; i < g.stars.length; i++) {
      const s = g.stars[i];
      if (s.birth > reveal) continue;
      const fresh = S.mode === 'merge' ? 1 : clamp((reveal - s.birth) / 0.012, 0, 1);
      let size = s.size;
      let a = 1;
      if (s.activity > 0) size *= 1 + 0.14 * s.activity * (0.5 + 0.5 * Math.sin(t * 2.3 + i * 1.7));
      if (s.isFork) a *= 0.55;
      if (s.isArchived) a *= 0.6;
      if (hl && s.lang !== hl) a *= 0.16;
      const isSel = !!sel && sel.slot === slot && sel.index === i;
      const isHov = !!hov && hov.slot === slot && hov.index === i;
      if (isSel) size *= 1.35;
      else if (isHov) size *= 1.22;
      let r = s.color[0], gg = s.color[1], b = s.color[2];
      if (s.isArchived) {
        const l = (r + gg + b) / 3;
        r = lerp(r, l, 0.75); gg = lerp(gg, l, 0.75); b = lerp(b, l, 0.75);
      }
      const spikes = clamp(Math.log10(s.repo.stars + 1) / 3.2, 0.06, 1);
      sprites.push(sw[3 * i], sw[3 * i + 1], sw[3 * i + 2], size * (0.55 + 0.45 * fresh), r, gg, b, a * fresh, SPRITE.STAR, spikes, (i * 0.618034) % 1);
    }
  }

  function emitConstellations(g, slot, reveal, hl) {
    const selStar = S.selected && S.selected.slot === slot ? g.stars[S.selected.index] : null;
    const selLang = selStar ? selStar.lang : null;
    if (!S.showConstellations && !hl && !selLang) return;
    const sw = slots[slot].starWorld;
    const edges = g.constellations;
    for (let k = 0; k < edges.length; k++) {
      const i = edges[k][0], j = edges[k][1];
      const si = g.stars[i], sj = g.stars[j];
      if (!si || !sj || si.birth > reveal || sj.birth > reveal) continue;
      let a;
      if (hl) a = si.lang === hl ? 0.4 : 0;
      else if (selLang && si.lang === selLang) a = 0.32;
      else a = S.showConstellations ? 0.12 : 0;
      if (a <= 0) continue;
      const c = si.color;
      lines.push(sw[3 * i], sw[3 * i + 1], sw[3 * i + 2], sw[3 * j], sw[3 * j + 1], sw[3 * j + 2], c[0], c[1], c[2], a);
    }
  }

  function labelItem(k) {
    let it = labelPool[k];
    if (!it) labelPool[k] = it = { key: '', text: '', x: 0, y: 0, alpha: 1, color: '', priority: 0, emphasis: false };
    return it;
  }

  function updateLabels() {
    labelItems.length = 0;
    if (!isLive()) { GLX.HUD.updateLabels(labelItems); return; }
    const hl = S.soloLang || S.highlightLang;
    const zoomed = camera.dist < 1.2;
    const perSlot = S.mode === 'merge' ? 6 : zoomed ? 22 : 11;
    let k = 0;
    for (let slot = 0; slot < S.galaxies.length; slot++) {
      const g = S.galaxies[slot], d = slots[slot];
      let shown = 0;
      for (let q = 0; q < d.labelOrder.length && shown < perSlot; q++) {
        const i = d.labelOrder[q];
        const o = d.screen[i];
        if (!o.on) continue;
        const s = g.stars[i];
        if (hl && s.lang !== hl) continue;
        const isSel = S.selected && S.selected.slot === slot && S.selected.index === i;
        const isHov = S.hovered && S.hovered.slot === slot && S.hovered.index === i;
        if (isSel || isHov) continue;
        const it = labelItem(k++);
        it.key = d.labelKeys[i]; it.text = s.repo.name; it.x = o.x; it.y = o.y;
        it.alpha = clamp(1.45 - o.depth / 4.2, 0.3, 1) * clamp((S.mode === 'merge' ? 1 : S.reveal - s.birth) / 0.05, 0, 1);
        it.color = d.colorCss[i]; it.priority = s.labelPriority; it.emphasis = false;
        labelItems.push(it);
        shown++;
      }
    }
    const extras = [S.selected, S.hovered];
    for (let e = 0; e < extras.length; e++) {
      const ref = extras[e];
      if (!ref || (e === 1 && sameRef(ref, S.selected))) continue;
      const d = slots[ref.slot], o = d.screen[ref.index], s = starOf(ref);
      if (!o || !o.on || !s) continue;
      const it = labelItem(k++);
      it.key = d.labelKeys[ref.index]; it.text = s.repo.name; it.x = o.x; it.y = o.y;
      it.alpha = 1; it.color = d.colorCss[ref.index]; it.priority = 1000 - e; it.emphasis = true;
      labelItems.push(it);
    }
    GLX.HUD.updateLabels(labelItems);
  }

  function updateUI() {
    if (S.mode === 'galaxy') GLX.Chrome.updateTimeline(clamp(S.reveal, 0, 1), S.playing);
    else if (S.mode === 'merge' && sim) {
      GLX.Chrome.updateMergeBar({
        phase: sim.phase,
        label: PHASE_LABEL[sim.phase] || sim.phase,
        progress: clamp(sim.progress, 0, 1),
        speed: S.mergeSpeed,
        playing: S.mergePlaying
      });
    }
    const dragging = !!camera.isDragging;
    if (dragging !== dragClass) {
      dragClass = dragging;
      canvas.classList.toggle('is-dragging', dragging);
    }
  }

  function renderScene(m) {
    effectsCtx.camDist = camera.dist;
    effectsCtx.time = S.time;
    effects.emit(sprites, lines, effectsCtx);
    frame.time = S.time;
    frame.proj = m.proj;
    frame.view = m.view;
    frame.fade = S.fade;
    frame.skyAlpha = 1;
    renderer.render(frame);
  }

  /** Synchronous re-render used by the poster exporter. */
  function renderNow() {
    const m = camera.computeMatrices(renderer.width, renderer.height);
    buildScene();
    renderScene(m);
  }

  function tick(dt) {
    S.time += dt;
    S.fade += (S.fadeTarget - S.fade) * (1 - Math.exp(-dt * 2.2));
    const wantAlpha = S.soloLang || S.highlightLang ? 0.5 : S.selected ? 0.8 : 1;
    S.partAlpha += (wantAlpha - S.partAlpha) * (1 - Math.exp(-dt * 5));

    if (S.mode === 'merge') updateMergeMode(dt);
    else updateGalaxyMode(dt);

    if (S.selected) camera.follow(starPos(S.selected, tmpSel));
    camera.update(dt);
    const m = camera.computeMatrices(renderer.width, renderer.height);
    projectStars(m);
    updateHover();
    buildScene();
    effects.update(dt, S.time);
    renderScene(m);
    updateLabels();
    updateUI();
  }

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = lastNow ? Math.min(0.05, Math.max(0, (now - lastNow) / 1000)) : 1 / 60;
    lastNow = now;
    try {
      tick(dt);
    } catch (e) {
      if (frameErrors++ < 3) console.error('[gitlaxy] frame error', e);
    }
  }

  // ------------------------------------------------------------------ input
  function onKeyCapture(e) {
    if (e.key !== 'Escape') return;
    if (GLX.HUD.searchOpen) {
      GLX.HUD.closeSearch();
    } else if (!GLX.Chrome.closeAllModals()) {
      if (S.mode === 'loading') cancelLoading();
      else if (S.selected) deselect();
      else if (S.soloLang) setSolo(null);
      else if (isLive()) goHome();
      else return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!isLive() || GLX.HUD.searchOpen || GLX.Chrome.helpOpen) return;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (t && t.closest && t.closest('[role="dialog"]')) return;
    const merge = S.mode === 'merge';
    let handled = true;
    switch (e.key) {
      case ' ':
        if (tag === 'BUTTON') { handled = false; break; }
        togglePlay(); break;
      case 'ArrowRight': navStar(1); break;
      case 'ArrowLeft': navStar(-1); break;
      case 'ArrowUp': camera.nudge(0, 0.08); break;
      case 'ArrowDown': camera.nudge(0, -0.08); break;
      case '+': case '=': camera.nudge(0, 0, 0.85); break;
      case '-': case '_': camera.nudge(0, 0, 1.18); break;
      case 'f': case 'F': case '/': openSearch(); break;
      case 'c': case 'C': toggleConstellations(); break;
      case 'm': case 'M': toggleSound(); break;
      case 'p': case 'P': exportPoster(); break;
      case 'r': case 'R': replay(); break;
      case '0': resetView(); break;
      case '?': case 'h': case 'H': GLX.Chrome.showHelp(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  function unlockAudio() {
    GLX.Audio.init();
    window.removeEventListener('pointerdown', unlockAudio, true);
    window.removeEventListener('keydown', unlockAudio, true);
    if (isLive()) GLX.Audio.ambient(S.mode === 'merge' ? (S.mergeDone ? 'resolved' : 'tense') : 'calm');
  }

  function fatal(msg) {
    document.body.append(
      util.el('div', { class: 'glx-fatal', role: 'alert' },
        util.el('h1', { text: 'Houston, we have a problem' }),
        util.el('p', { text: msg }))
    );
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    canvas = document.getElementById('glx-canvas');
    try {
      renderer = new GLX.Renderer(canvas);
    } catch (e) {
      console.error(e);
      fatal('Gitlaxy needs WebGL to draw galaxies, and this browser couldn’t provide it. Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration enabled.');
      return;
    }
    renderer.resize();
    camera = new GLX.Camera(canvas);
    effects = new GLX.Effects();

    camera.onHover = (x, y) => { pointer.x = x; pointer.y = y; pointer.inside = true; };
    camera.onLeave = () => { pointer.inside = false; };
    camera.onClick = (x, y) => {
      if (!isLive()) return;
      pointer.x = x; pointer.y = y;
      const ref = pickAt(x, y);
      if (ref) selectStar(ref);
      else if (S.selected) deselect();
    };

    effects.onCometLaunch = () => GLX.Audio.cometLaunch({ pan: 0 });
    effects.onCometArrive = (ev, target, pos) => {
      GLX.Audio.cometArrive({ pan: panFor(pos), kind: ev.kind });
      if (S.mode === 'galaxy') {
        GLX.Chrome.ticker({
          icon: ev.icon || '•',
          text: ev.label + ' · ' + shortRepo(ev.repo),
          sub: util.timeAgo(ev.createdAt),
          color: GLX.EVENT_COLORS[ev.kind] || GLX.EVENT_COLORS.other
        });
      }
    };

    GLX.HUD.init({
      onLangHover: (lang) => {
        S.highlightLang = lang || null;
        GLX.HUD.setLegendState({ highlight: S.highlightLang, solo: S.soloLang });
      },
      onLangToggle: (lang) => setSolo(S.soloLang === lang ? null : lang),
      onFactClick: (fact) => { if (fact && fact.starIndex >= 0) selectStar({ slot: 0, index: fact.starIndex }); },
      onCardClose: () => deselect(),
      onCardNav: (dir) => navStar(dir < 0 ? -1 : 1),
      onSearchPick: (ref) => { if (ref) selectStar(ref); },
      onPoster: () => exportPoster(),
      onMergeReplay: () => restartMerge(),
      onExplore: (login) => exploreLogin(login)
    });

    GLX.Chrome.init({
      onLaunch: (login) => launch(login),
      onDemo: () => launchDemo('mona'),
      onMerge: (a, b) => launchMerge(a, b),
      onMergeDemo: () => launchMergeDemo(),
      onCancelLoading: () => cancelLoading(),
      onHome: () => goHome(),
      onPlayPause: () => togglePlay(),
      onReplay: () => replay(),
      onScrub: (v) => scrub(v),
      onSound: () => toggleSound(),
      onPoster: () => exportPoster(),
      onOpenMerge: () => openMergeDialog(),
      onHelp: () => GLX.Chrome.showHelp(),
      onSearch: () => openSearch(),
      onConstellations: () => toggleConstellations(),
      onMergeRestart: () => restartMerge(),
      onMergeSpeed: (mult) => setMergeSpeed(mult),
      onTokenChange: (token) => {
        GLX.Data.setToken(token || '');
        GLX.Chrome.toast(token ? 'Token saved for this tab — 5,000 requests/hour unlocked.' : 'Token cleared.', { type: 'success' });
      }
    });
    GLX.Chrome.setSound(GLX.Audio.enabled);

    window.addEventListener('resize', () => renderer.resize());
    window.addEventListener('keydown', onKeyCapture, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', unlockAudio, true);
    window.addEventListener('keydown', unlockAudio, true);
    window.addEventListener('hashchange', () => {
      if (ignoreHash) { ignoreHash = false; return; }
      if (!route()) goHome();
    });
    GLX.bus.on('gl:lost', () => GLX.Chrome.toast('Graphics context lost — recovering…', { type: 'warn' }));
    GLX.bus.on('gl:restored', () => { simDirty = true; });

    showGalaxy(getIntroGalaxy(), { background: true });
    if (!route()) showIntro();
    requestAnimationFrame(loop);
  }

  // Exposed for debugging and automated checks.
  GLX.app = {
    launch, launchDemo, launchMerge, launchMergeDemo, goHome, selectStar, deselect, exportPoster, replay,
    get sim() { return sim; },
    get renderer() { return renderer; },
    get camera() { return camera; },
    get effects() { return effects; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
