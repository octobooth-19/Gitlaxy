/* Gitlaxy — 50-audio.js
 * GLX.Audio: a fully synthesized ambient soundtrack + sound effects (WebAudio only — no samples, no network).
 * Graph: voices → buses → dry mix + convolution reverb send (generated IR) + ping-pong delay send → master → limiter → out.
 * Music: D major pentatonic with a Lydian tint; pads drift through I–vi–IV–V with slow glides.
 * Lazy: nothing (no AudioContext, listeners or timers) exists until init() is called from a user gesture.
 */
(() => {
  'use strict';
  const GLX = (window.GLX = window.GLX || {});
  const U = GLX.util;
  const clamp = U.clamp;

  // ---------------------------------------------------------------- tuning
  const LA = 0.03; // scheduling lookahead (s)
  const MASTER = 0.42; // master gain (the limiter adds ~+3 dB makeup)
  const FLOOR = 1e-4; // exponential ramps end here (never 0)
  const NOTE_GAP = 1 / 14; // starBirth: ≤ 14 notes / s
  const MAX_VOICES = 24;
  const POOL_MAX = 10;
  const POOL_WAIT = 0.32; // queued star notes older than this are dropped (loud ones get 0.6 s)
  const IR_SECONDS = 3.6;
  const DELAY_TIME = 0.46; // ≈ dotted eighth
  const PAD_LEVEL = 0.3;
  const PAD_VOICE = 0.045;
  const PAD_BASS = 0.11;
  const PENTA = [0, 2, 4, 7, 9]; // D E F# A B
  const KIND_NOTE = { push: 81, pr: 83, issue: 76, comment: 78, star: 86, create: 88, fork: 71, release: 90, review: 85, other: 74 };
  const PAD_PAN = [-0.55, -0.18, 0.18, 0.55];
  const MOODS = {
    // chords: 4 upper voices per chord (I, vi, IV, V); bass: one root per chord. MIDI numbers.
    calm: {
      level: 1, cutoff: 950, lfoRate: 0.045, lfoDepth: 380, q: 0.7, glide: 0.9, detune: 7, pulse: 0, dur: 9.6,
      bass: [38, 35, 31, 33],
      chords: [[57, 62, 64, 66], [54, 59, 62, 66], [55, 59, 62, 66], [57, 61, 64, 66]]
    },
    tense: { // Dsus – Bm11 – Gm6 – Asus4: same roots, darker colours, lower cutoff, slow pulse
      level: 1, cutoff: 520, lfoRate: 0.11, lfoDepth: 170, q: 1.4, glide: 0.55, detune: 12, pulse: 0.45, pulseRate: 1.3, dur: 7.2,
      bass: [38, 35, 31, 33],
      chords: [[55, 57, 62, 64], [54, 59, 62, 64], [55, 58, 62, 64], [52, 57, 62, 64]]
    },
    resolved: { // open, bright voicings (Dmaj9 – Bm(add9) – Gmaj7 – A6/9)
      level: 0.9, cutoff: 2000, lfoRate: 0.05, lfoDepth: 700, q: 0.55, glide: 1.2, detune: 6, pulse: 0, dur: 10.4,
      bass: [38, 35, 31, 33],
      chords: [[57, 64, 66, 73], [54, 62, 66, 73], [55, 62, 66, 71], [57, 61, 66, 71]]
    }
  };

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const noop = () => {};

  // ---------------------------------------------------------------- module state
  let S = null; // active engine (the real one, or a temporary offline one inside _debug.render)
  let real = null; // engine bound to the real AudioContext
  let pref = null; // enabled preference (read lazily from storage)
  let hidden = false;
  let wantMode = 'off';
  let failed = false;
  let visBound = false;
  let warned = false;

  function report(e) {
    if (warned) return;
    warned = true;
    try { console.warn('[GLX.Audio]', e); } catch (_) { /* ignore */ }
  }
  function guard(fn) {
    try { return fn(); } catch (e) { report(e); }
  }
  function isEnabled() {
    if (pref === null) pref = U.storage.get('sound', true) !== false;
    return pref;
  }
  const tnow = (s) => (s.tv != null ? s.tv : s.ctx.currentTime);
  const now = () => tnow(S);
  function live() {
    if (!S) return false;
    if (S.offline) return true;
    return S.ctx.state === 'running' && isEnabled() && !hidden;
  }
  /** Common entry for sound methods: retry a stalled context (autoplay / interruption), then report liveness. */
  function enter() {
    const s = real;
    if (s && S === s && s.ctx.state !== 'running' && s.ctx.state !== 'closed' && isEnabled() && !hidden) {
      const t = Date.now();
      if (t - s.resumeTry > 800) {
        s.resumeTry = t;
        resumeCtx(s);
      }
    }
    return live();
  }
  function resumeCtx(s) {
    try {
      const p = s.ctx.resume && s.ctx.resume();
      if (p && p.catch) p.catch(noop);
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- node helpers
  function gain(c, v) {
    const g = c.createGain();
    g.gain.value = v;
    return g;
  }
  function osc(c, type, f, det) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    if (det) o.detune.value = det;
    return o;
  }
  function filter(c, type, f, q) {
    const b = c.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }
  function panner(c, pan) {
    if (c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      return p;
    }
    return c.createGain(); // very old Safari: no panning
  }
  function setP(param, v) {
    try { param.value = v; } catch (e) { /* out of range on some engines */ }
  }
  /** Percussive envelope: 0 → peak (linear attack) → exponential decay → 0. Starts and ends at 0 gain. */
  function perc(p, t, att, peak, dur) {
    peak = Math.max(peak, 2e-4);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + att);
    p.exponentialRampToValueAtTime(Math.min(FLOOR, peak * 0.01), t + dur);
    p.linearRampToValueAtTime(0, t + dur + 0.02);
  }
  /** Click-free move of a param from its current value to v, arriving at t + d. */
  function glide(s, p, v, t, d) {
    if (p.cancelAndHoldAtTime) {
      p.cancelAndHoldAtTime(t);
    } else {
      // No cancelAndHold (Firefox/Safari): anchor at the context's present, otherwise cancelling an in-flight ramp
      // would make the param jump back to the previous event's value until t.
      const tc = Math.min(t, tnow(s));
      const cur = p.value;
      p.cancelScheduledValues(tc);
      p.setValueAtTime(cur, tc);
    }
    p.linearRampToValueAtTime(v, t + d);
  }
  /** Register a finished-able group of nodes: disconnect all when `src` ends. */
  function track(nodes, src, end) {
    const s = S;
    const g = { nodes, end, done: false };
    s.groups++;
    s.tracked.push(g);
    src.onended = () => drop(s, g);
    if (s.tracked.length > 160) sweep(s);
    return g;
  }
  function drop(s, g) {
    if (g.done) return;
    g.done = true;
    s.groups--;
    for (let i = 0; i < g.nodes.length; i++) {
      try { g.nodes[i].disconnect(); } catch (e) { /* already disconnected */ }
    }
  }
  function sweep(s) {
    const t = tnow(s) - 2; // fallback in case an 'ended' event never fires
    s.tracked = s.tracked.filter((g) => {
      if (!g.done && g.end < t) drop(s, g);
      return !g.done;
    });
  }
  function noise(s, pink, t, dur) {
    const b = pink ? s.pink : s.white;
    const src = s.ctx.createBufferSource();
    src.buffer = b;
    const d = Math.min(dur, b.duration - 0.02);
    src.start(t, Math.random() * Math.max(0, b.duration - d - 0.02));
    src.stop(t + d);
    return src;
  }
  /** Throttle helper: next free time for `key` (≥ gap apart, ≤ maxLat late) or -1 to drop. */
  function slot(key, gap, maxLat) {
    const t = now() + LA;
    const last = S.slots[key];
    const at = last != null && last + gap > t ? last + gap : t;
    if (at - t > maxLat) return -1;
    S.slots[key] = at;
    return at;
  }
  /** Gentle equal-loudness compensation: high notes a little quieter. */
  const loudComp = (f) => clamp(Math.pow(330 / f, 0.28), 0.5, 1.2);

  // ---------------------------------------------------------------- engine (graph)
  function makeIR(c) {
    const sr = c.sampleRate;
    const len = Math.floor(sr * IR_SECONDS);
    const buf = c.createBuffer(2, len, sr);
    const pre = Math.floor(sr * 0.018);
    const bloom = sr * 0.06;
    const fadeN = Math.floor(sr * 0.3);
    const ampStep = Math.exp(-1.75 / sr); // T60 ≈ 3.9 s
    const kStep = Math.exp(-1.6 / sr); // highs die faster than lows
    const r = U.rng(0x6a17a9);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0, amp = 1, kx = 1;
      for (let i = pre; i < len; i++) {
        const j = i - pre;
        const k = 0.05 + 0.7 * kx;
        lp += k * (r() * 2 - 1 - lp);
        let v = lp * amp * Math.sqrt((2 - k) / k);
        if (j < bloom) v *= j / bloom;
        if (i > len - fadeN) v *= (len - i) / fadeN;
        d[i] = v;
        amp *= ampStep;
        kx *= kStep;
      }
    }
    return buf;
  }
  function noiseBuf(c, seconds, pink, seed) {
    const sr = c.sampleRate;
    const n = Math.floor(sr * seconds);
    const b = c.createBuffer(1, n, sr);
    const d = b.getChannelData(0);
    const r = U.rng(seed);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      if (!pink) { d[i] = w; continue; }
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return b;
  }

  function build(c, dest, offline) {
    const s = {
      ctx: c, offline, tv: null,
      tracked: [], groups: 0, slots: Object.create(null),
      voices: [], pool: [], nextSlot: 0, lastMidi: -1, lastNoteAt: -9, dir: 1, pumpTimer: 0,
      pads: [], chord: 0, chordTimer: 0, suspendTimer: 0, resumeTry: 0, lastBoom: 0
    };
    const comp = c.createDynamicsCompressor(); // gentle safety limiter
    setP(comp.threshold, -6); setP(comp.knee, 6); setP(comp.ratio, 10); setP(comp.attack, 0.003); setP(comp.release, 0.25);
    const master = gain(c, 0);
    master.connect(comp);
    comp.connect(dest);

    const rvIn = gain(c, 1);
    const conv = c.createConvolver();
    conv.buffer = makeIR(c);
    const rvHp = filter(c, 'highpass', 140, 0.5);
    const rvOut = gain(c, 0.9);
    rvIn.connect(conv); conv.connect(rvHp); rvHp.connect(rvOut); rvOut.connect(master);

    // ping-pong delay: L → R → L …, darker on every bounce
    const dIn = gain(c, 1);
    const dHp = filter(c, 'highpass', 320, 0.6);
    const dLp = filter(c, 'lowpass', 3600, 0.5);
    const dL = c.createDelay(2), dR = c.createDelay(2);
    dL.delayTime.value = DELAY_TIME;
    dR.delayTime.value = DELAY_TIME;
    const fb1 = gain(c, 0.36), fb2 = gain(c, 0.36);
    const loopLp = filter(c, 'lowpass', 2400, 0.5);
    const mrg = c.createChannelMerger(2);
    const dOut = gain(c, 0.5), dRv = gain(c, 0.3);
    dIn.connect(dHp); dHp.connect(dLp); dLp.connect(dL);
    dL.connect(mrg, 0, 0); dL.connect(fb1); fb1.connect(dR);
    dR.connect(mrg, 0, 1); dR.connect(fb2); fb2.connect(loopLp); loopLp.connect(dL);
    mrg.connect(dOut); dOut.connect(master); dOut.connect(dRv); dRv.connect(rvIn);

    function bus(dry, rev, dly) {
      const g = c.createGain();
      const d = gain(c, dry);
      g.connect(d); d.connect(master);
      if (rev > 0) { const r = gain(c, rev); g.connect(r); r.connect(rvIn); }
      if (dly > 0) { const e = gain(c, dly); g.connect(e); e.connect(dIn); }
      return g;
    }
    s.buses = {
      pluck: bus(0.75, 0.55, 0.3),
      chime: bus(0.8, 0.6, 0.28),
      pad: bus(0.8, 0.75, 0),
      fx: bus(0.85, 0.4, 0.1),
      boom: bus(1, 0.28, 0),
      ui: bus(1, 0.15, 0)
    };
    s.master = master;
    s.comp = comp;
    s.white = noiseBuf(c, 1, false, 0xbada55);
    s.pink = noiseBuf(c, 3, true, 0xc0ffee);
    return s;
  }

  // ---------------------------------------------------------------- output state (enable / visibility)
  function applyOutput(s, fresh) {
    const want = isEnabled() && !hidden;
    const t = s.ctx.currentTime;
    clearTimeout(s.suspendTimer);
    s.suspendTimer = 0;
    if (want) {
      if (s.ctx.state !== 'running') resumeCtx(s);
      if (!fresh) glide(s, s.master.gain, MASTER, t, 0.6);
      if (wantMode !== 'off' && !s.pads.some((p) => p.mode === wantMode && !p.fading)) setMood(s, wantMode);
    } else {
      const fade = hidden ? 0.15 : 0.45;
      if (!fresh) glide(s, s.master.gain, 0, t, fade);
      s.pool.length = 0;
      clearTimeout(s.pumpTimer);
      s.pumpTimer = 0;
      s.suspendTimer = setTimeout(() => guard(() => {
        s.suspendTimer = 0;
        if (!(isEnabled() && !hidden) && s.ctx.state === 'running') {
          const p = s.ctx.suspend();
          if (p && p.catch) p.catch(noop);
        }
      }), (fade + 0.12) * 1000);
    }
  }
  function onVisibility() {
    guard(() => {
      hidden = document.visibilityState === 'hidden';
      if (real) applyOutput(real);
    });
  }
  function unlock(c) {
    // iOS: a one-sample silent buffer inside the gesture unlocks output.
    try {
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, c.sampleRate);
      src.connect(c.destination);
      src.onended = () => { try { src.disconnect(); } catch (e) { /* ignore */ } };
      src.start(0);
    } catch (e) { /* ignore */ }
  }

  function init() {
    if (failed) return;
    if (!real) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { failed = true; return; }
      // Not inside/after a user gesture yet: wait for the next init() rather than creating a blocked context.
      const ua = typeof navigator !== 'undefined' && navigator.userActivation;
      if (ua && ua.hasBeenActive === false) return;
      let c = null;
      try { c = new Ctor({ latencyHint: 'interactive' }); } catch (e) {
        try { c = new Ctor(); } catch (e2) { failed = true; return; }
      }
      try {
        real = build(c, c.destination, false);
      } catch (e) {
        failed = true;
        try { c.close(); } catch (e2) { /* ignore */ }
        throw e;
      }
      S = real;
      if (typeof document !== 'undefined') {
        hidden = document.visibilityState === 'hidden';
        if (!visBound && document.addEventListener) {
          document.addEventListener('visibilitychange', onVisibility);
          visBound = true;
        }
      }
      if (isEnabled() && !hidden) real.master.gain.value = MASTER;
      unlock(c);
      applyOutput(real, true);
      return;
    }
    applyOutput(real, false);
  }

  function setEnabled(on) {
    on = !!on;
    pref = on;
    U.storage.set('sound', on);
    if (real) applyOutput(real);
  }

  // ---------------------------------------------------------------- voices
  /**
   * FM pluck / bell. Sine carrier with a decaying modulator (ratio 1 = harp-ish, 3.5 = celesta/bell), a slightly
   * detuned triangle octave partial and an optional sub-octave bloom, all through one envelope and a lowpass whose
   * cutoff tracks velocity. The modulator is offset by < 1 Hz so the residual FM slowly shimmers.
   */
  function pluck(t, f, o) {
    const c = S.ctx;
    const vel = clamp(num(o.vel, 0.5), 0, 1);
    const dur = Math.max(0.2, o.dur);
    const peak = Math.max(5e-4, o.gain);
    const bell = !!o.bell;
    const att = o.att || (bell ? 0.003 : 0.006);
    const end = t + dur + 0.04;
    const ratio = bell ? 3.5 : 1;

    const car = osc(c, 'sine', f);
    const mod = osc(c, 'sine', f * ratio + 0.35 + Math.random() * 0.6);
    const modG = c.createGain();
    const dev = f * ratio * (bell ? 0.35 + 0.5 * vel : 0.7 + 1.0 * vel); // Δf = index · fm
    modG.gain.setValueAtTime(dev, t);
    modG.gain.exponentialRampToValueAtTime(dev * 0.03, t + (bell ? 0.16 : 0.4));
    mod.connect(modG);
    modG.connect(car.frequency);

    const tri = osc(c, 'triangle', f * 2, 4);
    const triG = c.createGain();
    triG.gain.setValueAtTime(0.14 + 0.14 * vel, t);
    triG.gain.exponentialRampToValueAtTime(0.01, t + dur * 0.5);
    tri.connect(triG);

    const env = c.createGain();
    env.gain.value = 0;
    perc(env.gain, t, att, peak, dur);
    car.connect(env);
    triG.connect(env);

    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.4;
    const c0 = clamp(f * (2.5 + 7 * vel), 700, 15000);
    const c1 = Math.min(c0, clamp(f * 1.6, 300, 6000));
    lp.frequency.setValueAtTime(c0, t);
    lp.frequency.exponentialRampToValueAtTime(c1, t + dur * 0.7);
    env.connect(lp);
    const pn = panner(c, num(o.pan, 0));
    lp.connect(pn);
    pn.connect(o.bus || S.buses.pluck);

    const nodes = [car, mod, modG, tri, triG, env, lp, pn];
    const srcs = [car, mod, tri];
    if (o.bloom) {
      const b = osc(c, 'sine', f / 2);
      const bg = c.createGain();
      bg.gain.setValueAtTime(0, t);
      bg.gain.linearRampToValueAtTime(0.45, t + 0.09);
      b.connect(bg);
      bg.connect(env);
      nodes.push(b, bg);
      srcs.push(b);
    }
    for (let i = 0; i < srcs.length; i++) {
      srcs[i].start(t);
      srcs[i].stop(end);
    }
    track(nodes, car, end);
    return { env, srcs, t0: t, att, dur, end, peak, floor: Math.min(FLOOR, peak * 0.01) };
  }

  /** Simple sine/triangle blip with optional pitch glide and pan. */
  function blip(t, f, peak, dur, bus, o) {
    o = o || {};
    const c = S.ctx;
    const end = t + dur + 0.04;
    const a = osc(c, o.type || 'sine', f);
    if (o.to) {
      a.frequency.setValueAtTime(f, t);
      a.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || dur * 0.5));
    }
    const env = c.createGain();
    env.gain.value = 0;
    perc(env.gain, t, o.att || 0.003, peak, dur);
    a.connect(env);
    const nodes = [a, env];
    let last = env;
    if (o.pan) {
      const p = panner(c, o.pan);
      env.connect(p);
      nodes.push(p);
      last = p;
    }
    last.connect(bus);
    a.start(t);
    a.stop(end);
    track(nodes, a, end);
  }

  /** Detuned saw/triangle chord through a sweeping lowpass with a slow swell (used by the "complete" cues). */
  function swell(t, notes, o) {
    const c = S.ctx;
    const tHold = t + o.att, tRel = tHold + o.hold, tEnd = tRel + o.rel;
    const end = tEnd + 0.06;
    const lp = filter(c, 'lowpass', o.cut0, 0.7);
    lp.frequency.setValueAtTime(o.cut0, t);
    lp.frequency.exponentialRampToValueAtTime(o.cut1, tHold);
    lp.frequency.exponentialRampToValueAtTime(o.cut2, tRel + o.rel * 0.6);
    const env = c.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(o.peak, tHold);
    env.gain.setValueAtTime(o.peak, tRel);
    env.gain.exponentialRampToValueAtTime(FLOOR, tEnd);
    env.gain.linearRampToValueAtTime(0, tEnd + 0.03);
    lp.connect(env);
    env.connect(o.bus);
    const nodes = [lp, env], srcs = [];
    for (let i = 0; i < notes.length; i++) {
      const m = notes[i];
      const f = mtof(m);
      const pan = notes.length > 1 ? ((i / (notes.length - 1)) * 2 - 1) * o.spread : 0;
      const a = osc(c, 'sawtooth', f, -5 - Math.random() * 4);
      const b = osc(c, 'triangle', f, 5 + Math.random() * 4);
      const g = gain(c, m < 45 ? 1.3 : 1);
      const p = panner(c, pan);
      a.connect(g); b.connect(g); g.connect(p); p.connect(lp);
      nodes.push(a, b, g, p);
      srcs.push(a, b);
    }
    for (let i = 0; i < srcs.length; i++) {
      srcs[i].start(t);
      srcs[i].stop(end);
    }
    track(nodes, srcs[0], end);
  }

  // ---------------------------------------------------------------- star births (scheduler)
  /*
   * Notes go into a small pool; a pump schedules one note per slot (≥ 1/14 s apart), choosing the candidate that is
   * loud, old, and best continues the current melodic direction. Low-star repos may pick between two octaves, so a
   * burst of births turns into rising and falling harp/celesta runs instead of random plinks. Popular repos sit in
   * fixed low octaves (warm "left hand") and do not bend the melodic contour.
   */
  function starBirth(o) {
    o = o || {};
    const lang = String(o.lang || 'Other');
    const stars = Math.max(0, num(+o.stars, 0));
    const loud = clamp(num(+o.loud, 0), 0, 1);
    const w = clamp(Math.log10(stars + 1) / 3.3, 0, 1);
    const n = {
      pc: PENTA[U.hashStr(lang) % 5],
      octs: w >= 0.82 ? [3] : w >= 0.55 ? [4] : w >= 0.25 ? [4, 5] : [5, 6],
      vel: clamp(0.28 + 0.62 * w + 0.35 * loud, 0, 1),
      w,
      pan: clamp(num(+o.pan, 0), -1, 1) * 0.85,
      at: now(),
      midi: 0
    };
    const pool = S.pool;
    if (pool.length >= POOL_MAX) {
      let qi = 0;
      for (let i = 1; i < pool.length; i++) if (pool[i].vel < pool[qi].vel) qi = i;
      if (pool[qi].vel >= n.vel) return; // the pool already holds louder notes: drop this one
      pool[qi] = n;
    } else pool.push(n);
    pump();
  }

  function pump() {
    const s = S;
    if (!s) return;
    if (s.pumpTimer) {
      clearTimeout(s.pumpTimer);
      s.pumpTimer = 0;
    }
    if (!live()) {
      s.pool.length = 0;
      return;
    }
    const t = now();
    const pool = s.pool;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (t - pool[i].at > (pool[i].vel > 0.8 ? 0.6 : POOL_WAIT)) pool.splice(i, 1);
    }
    while (pool.length) {
      const at = Math.max(t + LA, s.nextSlot);
      if (at > t + LA + 0.012) break;
      playNote(s, choose(s, t), at);
      s.nextSlot = at + NOTE_GAP + Math.random() * 0.012;
    }
    if (pool.length && !s.offline) {
      const wait = Math.max(0.004, s.nextSlot - LA - 0.012 - t);
      s.pumpTimer = setTimeout(pumpTick, wait * 1000);
    }
  }
  function pumpTick() {
    guard(() => {
      if (real) {
        real.pumpTimer = 0;
        if (S === real) pump();
      }
    });
  }

  function choose(s, t) {
    const pool = s.pool;
    if (t - s.lastNoteAt > 1.2) s.lastMidi = -1; // new phrase
    let bi = 0, bm = 0, bs = -1e9;
    for (let i = 0; i < pool.length; i++) {
      const n = pool[i];
      for (let k = 0; k < n.octs.length; k++) {
        const m = 12 * (n.octs[k] + 1) + 2 + n.pc;
        let sc = n.vel * 1.4 + (t - n.at) * 2.5;
        if (n.octs.length > 1) {
          if (s.lastMidi >= 0) {
            const d = (m - s.lastMidi) * s.dir;
            sc += d > 0 ? 1 - Math.min(d, 14) * 0.045 : d === 0 ? -0.35 : -0.6 + d * 0.02;
          } else if (k === 0) sc += 0.05;
        }
        if (sc > bs) { bs = sc; bi = i; bm = m; }
      }
    }
    const n = pool.splice(bi, 1)[0];
    n.midi = bm;
    if (n.octs.length > 1) {
      if (s.lastMidi >= 0 && (bm - s.lastMidi) * s.dir < 0) s.dir = -s.dir;
      if (bm >= 88) s.dir = -1;
      else if (bm <= 64) s.dir = 1;
      s.lastMidi = bm;
      s.lastNoteAt = t;
    }
    return n;
  }

  function playNote(s, n, t) {
    for (let i = s.voices.length - 1; i >= 0; i--) if (s.voices[i].end <= t) s.voices.splice(i, 1);
    if (s.voices.length >= MAX_VOICES) steal(s, t);
    const f = mtof(n.midi);
    const hi = clamp((n.midi - 62) / 30, 0, 1);
    const v = pluck(t + Math.random() * 0.004, f, {
      vel: n.vel,
      dur: clamp(2.5 - 1.4 * hi + 0.4 * n.w, 1, 2.5),
      gain: (0.045 + 0.11 * n.vel) * loudComp(f),
      bell: hi > 0.45,
      bloom: n.vel >= 0.75,
      pan: n.pan,
      bus: s.buses.pluck
    });
    s.voices.push(v);
  }

  /** Voice cap reached: quickly release the quietest sounding voice. */
  function steal(s, t) {
    let qi = -1, qa = Infinity;
    for (let i = 0; i < s.voices.length; i++) {
      const v = s.voices[i];
      const x = clamp((t - v.t0 - v.att) / (v.dur - v.att), 0, 1);
      const a = v.t0 > t ? Infinity : v.peak * Math.pow(v.floor / v.peak, x);
      if (a < qa) { qa = a; qi = i; }
    }
    if (qi < 0) qi = 0;
    const v = s.voices.splice(qi, 1)[0];
    const g = v.env.gain;
    let tk = t;
    if (g.cancelAndHoldAtTime) {
      g.cancelAndHoldAtTime(tk);
    } else {
      tk = Math.max(tnow(s), v.t0);
      g.cancelScheduledValues(tk);
      g.setValueAtTime(Math.min(qa, v.peak), tk);
    }
    g.linearRampToValueAtTime(0, tk + 0.04);
    for (let i = 0; i < v.srcs.length; i++) {
      try { v.srcs[i].stop(tk + 0.05); } catch (e) { /* old WebKit: second stop() throws; envelope is already 0 */ }
    }
  }

  // ---------------------------------------------------------------- ambient pads
  function makePad(s, mode, t, fadeIn) {
    const c = s.ctx, M = MOODS[mode], ch = s.chord % 4;
    const nodes = [], srcs = [], voices = [];
    const out = gain(c, 0);
    const filt = filter(c, 'lowpass', M.cutoff, M.q);
    const lfo = osc(c, 'sine', M.lfoRate), lfoG = gain(c, M.lfoDepth);
    lfo.connect(lfoG);
    lfoG.connect(filt.frequency);
    const drift = osc(c, 'sine', 0.06 + Math.random() * 0.03), dPos = gain(c, 5), dNeg = gain(c, -5);
    drift.connect(dPos);
    drift.connect(dNeg);
    nodes.push(out, filt, lfo, lfoG, drift, dPos, dNeg);
    srcs.push(lfo, drift);
    let tail = filt;
    if (M.pulse) {
      const trem = gain(c, 1 - M.pulse / 2), pl = osc(c, 'sine', M.pulseRate), plG = gain(c, M.pulse / 2);
      pl.connect(plG);
      plG.connect(trem.gain);
      filt.connect(trem);
      tail = trem;
      nodes.push(trem, pl, plG);
      srcs.push(pl);
    }
    tail.connect(out);
    out.connect(s.buses.pad);
    for (let i = 0; i < 4; i++) {
      const f = mtof(M.chords[ch][i]);
      const a = osc(c, 'sawtooth', f, -M.detune), b = osc(c, 'triangle', f, M.detune);
      const g = gain(c, PAD_VOICE), p = panner(c, PAD_PAN[i]);
      a.connect(g); b.connect(g); g.connect(p); p.connect(filt);
      (i % 2 ? dNeg : dPos).connect(b.detune);
      nodes.push(a, b, g, p);
      srcs.push(a, b);
      voices.push(a, b);
    }
    const bass = osc(c, 'triangle', mtof(M.bass[ch])), bg = gain(c, PAD_BASS);
    bass.connect(bg);
    bg.connect(filt);
    nodes.push(bass, bg);
    srcs.push(bass);
    for (let i = 0; i < srcs.length; i++) srcs[i].start(t);
    const level = M.level * PAD_LEVEL;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(level, t + fadeIn);
    return { mode, M, out, nodes, srcs, voices, bass, level, fading: false, dead: false, killAt: 0, killTimer: 0 };
  }
  function padChord(p, idx, t) {
    const M = p.M, ch = M.chords[idx];
    for (let i = 0; i < 4; i++) {
      const f = mtof(ch[i]);
      p.voices[i * 2].frequency.setTargetAtTime(f, t, M.glide);
      p.voices[i * 2 + 1].frequency.setTargetAtTime(f, t, M.glide);
    }
    p.bass.frequency.setTargetAtTime(mtof(M.bass[idx]), t, M.glide * 1.2);
  }
  function fadePad(s, p, t, dur) {
    glide(s, p.out.gain, 0, t, dur);
    p.fading = true;
    p.killAt = t + dur + 0.05;
    armKill(s, p, dur + 0.3);
  }
  function armKill(s, p, secs) {
    if (s.offline) return;
    clearTimeout(p.killTimer);
    p.killTimer = setTimeout(() => guard(() => {
      p.killTimer = 0;
      if (!p.fading || p.dead) return;
      if (s.ctx.state !== 'running' || s.ctx.currentTime < p.killAt) armKill(s, p, 0.5);
      else destroyPad(s, p);
    }), secs * 1000);
  }
  function revivePad(s, p, t) {
    clearTimeout(p.killTimer);
    p.killTimer = 0;
    p.fading = false;
    glide(s, p.out.gain, p.level, t, 2.4);
  }
  function destroyPad(s, p) {
    if (p.dead) return;
    p.dead = true;
    clearTimeout(p.killTimer);
    const t = tnow(s) + 0.01;
    glide(s, p.out.gain, 0, t, 0.05);
    p.srcs[0].onended = () => {
      for (let i = 0; i < p.nodes.length; i++) {
        try { p.nodes[i].disconnect(); } catch (e) { /* ignore */ }
      }
    };
    for (let i = 0; i < p.srcs.length; i++) p.srcs[i].stop(t + 0.08);
    const i = s.pads.indexOf(p);
    if (i >= 0) s.pads.splice(i, 1);
    if (!s.pads.length && s.chordTimer) {
      clearTimeout(s.chordTimer);
      s.chordTimer = 0;
    }
  }
  function nextChord(s) {
    s.chord = (s.chord + 1) % 4;
    const t = tnow(s) + LA;
    for (let i = 0; i < s.pads.length; i++) padChord(s.pads[i], s.chord, t);
  }
  function ensureChordTimer(s) {
    if (s.offline || s.chordTimer) return;
    const tick = () => guard(() => {
      s.chordTimer = 0;
      if (!s.pads.length) return;
      if (s.ctx.state === 'running') nextChord(s);
      s.chordTimer = setTimeout(tick, (MOODS[wantMode] || MOODS.calm).dur * 1000);
    });
    s.chordTimer = setTimeout(tick, (MOODS[wantMode] || MOODS.calm).dur * 1000);
  }
  function setMood(s, mode) {
    const t = tnow(s) + LA;
    let keep = null;
    const pads = s.pads.slice();
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (mode !== 'off' && p.mode === mode && !keep) { keep = p; continue; }
      if (!p.fading) fadePad(s, p, t, mode === 'off' ? 3.2 : 2.6);
    }
    if (mode === 'off') return;
    if (keep) {
      if (keep.fading) revivePad(s, keep, t);
      return;
    }
    s.pads.push(makePad(s, mode, t, s.pads.length ? 2.6 : 4.5));
    while (s.pads.length > 3) destroyPad(s, s.pads[0]);
    ensureChordTimer(s);
  }

  // ---------------------------------------------------------------- one-shots
  function galaxyComplete() {
    const t = slot('galaxy', 1.5, 0);
    if (t < 0) return;
    swell(t, [38, 50, 57, 64, 66, 73], { peak: 0.03, att: 1.3, hold: 0.9, rel: 4.5, cut0: 300, cut1: 2600, cut2: 900, spread: 0.6, bus: S.buses.pad });
    const arp = [62, 66, 69, 73, 76, 80, 81, 85, 88]; // Dmaj9(#11) rising
    for (let i = 0; i < arp.length; i++) {
      const f = mtof(arp[i]);
      pluck(t + 0.22 + i * 0.12 + Math.random() * 0.01, f, {
        vel: 0.5, dur: 2.3 - i * 0.1, gain: 0.07 * loudComp(f), bell: arp[i] >= 76,
        pan: -0.6 + (1.2 * i) / (arp.length - 1), bus: S.buses.chime
      });
    }
    pluck(t + 1.5, mtof(90), { vel: 0.4, dur: 2.4, gain: 0.03, bell: true, pan: 0.3, bus: S.buses.chime });
    pluck(t + 1.62, mtof(93), { vel: 0.4, dur: 2.6, gain: 0.025, bell: true, pan: -0.3, bus: S.buses.chime });
  }

  function cometLaunch(o) {
    const t = slot('launch', 0.12, 0.15);
    if (t < 0 || S.groups > 90) return;
    const c = S.ctx, dur = 1.25;
    const pan = clamp(num(o && +o.pan, 0), -1, 1);
    const src = noise(S, true, t, dur);
    const bp = filter(c, 'bandpass', 450, 1.3);
    bp.frequency.setValueAtTime(450, t);
    bp.frequency.exponentialRampToValueAtTime(2800, t + 0.8);
    const env = c.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.09, t + 0.32);
    env.gain.exponentialRampToValueAtTime(FLOOR, t + dur - 0.05);
    env.gain.linearRampToValueAtTime(0, t + dur - 0.02);
    const p = panner(c, pan * 0.8);
    if (p.pan) {
      p.pan.setValueAtTime(pan * 0.8, t);
      p.pan.linearRampToValueAtTime(pan * 0.3, t + dur);
    }
    src.connect(bp); bp.connect(env); env.connect(p); p.connect(S.buses.fx);
    track([src, bp, env, p], src, t + dur);
  }

  function cometArrive(o) {
    const t = slot('arrive', 0.09, 0.25);
    if (t < 0 || S.groups > 90) return;
    const m = KIND_NOTE[o && o.kind] || KIND_NOTE.other;
    const pan = clamp(num(o && +o.pan, 0), -1, 1) * 0.85;
    const f = mtof(m);
    pluck(t, f, { vel: 0.7, dur: 1.9, gain: 0.07 * loudComp(f), bell: true, pan, bus: S.buses.chime });
    pluck(t + 0.045, f * 2, { vel: 0.4, dur: 1.1, gain: 0.022 * loudComp(f * 2), bell: true, pan: -pan * 0.5, bus: S.buses.chime });
  }

  function select() {
    const t = slot('select', 0.06, 0);
    if (t < 0) return;
    blip(t, mtof(81), 0.05, 0.32, S.buses.chime, { att: 0.004 });
    blip(t + 0.075, mtof(86), 0.045, 0.45, S.buses.chime, { att: 0.004 });
  }

  function hover() {
    const t = slot('hover', 0.08, 0);
    if (t < 0 || S.groups > 90) return;
    blip(t, 2300 + Math.random() * 250, 0.006, 0.035, S.buses.ui, { att: 0.0015, pan: (Math.random() - 0.5) * 0.4 });
  }

  function uiClick() {
    const t = slot('click', 0.04, 0);
    if (t < 0 || S.groups > 90) return;
    blip(t, 1320, 0.035, 0.11, S.buses.ui, { att: 0.002, to: 990, glide: 0.03 });
    const c = S.ctx;
    const src = noise(S, false, t, 0.04);
    const bp = filter(c, 'bandpass', 4200, 1.2);
    const env = c.createGain();
    env.gain.value = 0;
    perc(env.gain, t, 0.001, 0.02, 0.018);
    src.connect(bp); bp.connect(env); env.connect(S.buses.ui);
    track([src, bp, env], src, t + 0.04);
  }

  function collision(intensity) {
    const i = clamp(num(+intensity, 0.6), 0, 1);
    if (i < 0.02) return;
    let t = slot('boom', 0.22, 0);
    if (t < 0) {
      if (i < S.lastBoom * 1.5 + 0.1) return; // a much bigger hit may still punch through
      t = now() + LA;
      S.slots.boom = t;
    }
    S.lastBoom = i;
    const c = S.ctx, k = Math.pow(i, 0.8);
    const dur = 1.6 + 1.2 * i, end = t + dur + 0.05;
    const f0 = 62 + 48 * i;

    const sub = osc(c, 'sine', f0);
    sub.frequency.setValueAtTime(f0, t);
    sub.frequency.exponentialRampToValueAtTime(30, t + 1.3);
    const body = osc(c, 'triangle', f0 * 2);
    body.frequency.setValueAtTime(f0 * 2, t);
    body.frequency.exponentialRampToValueAtTime(60, t + 0.9);
    const bodyG = gain(c, 0.35);
    const bodyLp = filter(c, 'lowpass', 420, 0.7);
    body.connect(bodyLp); bodyLp.connect(bodyG);
    const env = c.createGain();
    env.gain.value = 0;
    perc(env.gain, t, 0.008, 0.3 * k, dur);
    sub.connect(env); bodyG.connect(env); env.connect(S.buses.boom);

    // stereo debris: two decorrelated noise streams swept down through a lowpass
    const nd = Math.min(2.4, dur);
    const nl = noise(S, true, t, nd), nr = noise(S, true, t, nd);
    const mrg = c.createChannelMerger(2);
    nl.connect(mrg, 0, 0);
    nr.connect(mrg, 0, 1);
    const lp = filter(c, 'lowpass', 2600, 0.9);
    lp.frequency.setValueAtTime(800 + 2400 * i, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + nd * 0.85);
    const nEnv = c.createGain();
    nEnv.gain.value = 0;
    perc(nEnv.gain, t, 0.03, 0.22 * k, nd - 0.05);
    mrg.connect(lp); lp.connect(nEnv); nEnv.connect(S.buses.boom);

    sub.start(t); sub.stop(end);
    body.start(t); body.stop(end);
    track([sub, body, bodyG, bodyLp, env, nl, nr, mrg, lp, nEnv], sub, end);
  }

  function conflict() {
    const t = slot('conflict', 0.16, 0.5);
    if (t < 0) return;
    const c = S.ctx;
    const end = t + 0.5;
    const notes = [68, 69, 74]; // G#4 A4 D5: a cheeky semitone + tritone cluster
    const lp = filter(c, 'lowpass', 1900, 3);
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.4);
    const env = c.createGain();
    env.gain.value = 0;
    const pk = 0.055;
    const g = env.gain;
    g.setValueAtTime(0, t); // stutter gate, then a falling tail
    g.linearRampToValueAtTime(pk, t + 0.004);
    g.setValueAtTime(pk, t + 0.03);
    g.linearRampToValueAtTime(0, t + 0.038);
    g.setValueAtTime(0, t + 0.055);
    g.linearRampToValueAtTime(pk, t + 0.059);
    g.setValueAtTime(pk, t + 0.085);
    g.linearRampToValueAtTime(0, t + 0.093);
    g.setValueAtTime(0, t + 0.11);
    g.linearRampToValueAtTime(pk * 0.9, t + 0.114);
    g.exponentialRampToValueAtTime(FLOOR, t + 0.44);
    g.linearRampToValueAtTime(0, t + 0.46);
    const wob = osc(c, 'sine', 23), wobG = gain(c, 28);
    wob.connect(wobG);
    const pn = panner(c, (Math.random() - 0.5) * 0.6);
    lp.connect(env); env.connect(pn); pn.connect(S.buses.fx);
    const nodes = [lp, env, wob, wobG, pn], srcs = [wob];
    for (let i = 0; i < notes.length; i++) {
      const o = osc(c, i === 2 ? 'sawtooth' : 'square', mtof(notes[i]), (i - 1) * 9);
      o.frequency.setValueAtTime(mtof(notes[i]), t + 0.11);
      o.frequency.exponentialRampToValueAtTime(mtof(notes[i] - 1.2), t + 0.42);
      wobG.connect(o.detune);
      const og = gain(c, i === 2 ? 0.5 : 0.33);
      o.connect(og); og.connect(lp);
      nodes.push(o, og);
      srcs.push(o);
    }
    for (let i = 0; i < srcs.length; i++) {
      srcs[i].start(t);
      srcs[i].stop(end);
    }
    track(nodes, srcs[0], end);
  }

  function resolve() {
    const t = slot('resolve', 0.14, 0.6);
    if (t < 0) return;
    const a = mtof(81), d = mtof(86); // A5 → D6: "fixed!"
    pluck(t, a, { vel: 0.55, dur: 0.9, gain: 0.06 * loudComp(a), bell: false, pan: -0.15, bus: S.buses.chime });
    pluck(t + 0.09, d, { vel: 0.6, dur: 1.5, gain: 0.065 * loudComp(d), bell: false, pan: 0.15, bus: S.buses.chime });
    pluck(t + 0.09, d * 2, { vel: 0.3, dur: 1.2, gain: 0.012, bell: true, pan: 0.3, bus: S.buses.chime });
  }

  function mergeComplete() {
    const t = slot('merge', 2, 0);
    if (t < 0) return;
    swell(t, [38, 45, 50, 54, 57, 62, 64, 66, 69], { peak: 0.028, att: 0.5, hold: 1.6, rel: 5, cut0: 400, cut1: 3200, cut2: 1300, spread: 0.7, bus: S.buses.pad });
    const sub = osc(S.ctx, 'sine', mtof(38)), subG = S.ctx.createGain();
    subG.gain.value = 0;
    subG.gain.setValueAtTime(0, t);
    subG.gain.linearRampToValueAtTime(0.12, t + 0.4);
    subG.gain.exponentialRampToValueAtTime(FLOOR, t + 5);
    subG.gain.linearRampToValueAtTime(0, t + 5.03);
    sub.connect(subG);
    subG.connect(S.buses.boom);
    sub.start(t);
    sub.stop(t + 5.08);
    track([sub, subG], sub, t + 5.08);
    const arp = [62, 66, 69, 74, 76, 78, 81, 86, 88, 90, 93];
    for (let i = 0; i < arp.length; i++) {
      const f = mtof(arp[i]);
      pluck(t + 0.15 + i * 0.09 + Math.random() * 0.008, f, {
        vel: 0.45 + 0.03 * i, dur: 2.4 - i * 0.07, gain: 0.07 * loudComp(f), bell: arp[i] >= 78,
        pan: -0.7 + (1.4 * i) / (arp.length - 1), bus: S.buses.chime
      });
    }
    pluck(t + 1.25, mtof(86), { vel: 0.4, dur: 3, gain: 0.03, bell: true, pan: -0.25, bus: S.buses.chime });
    pluck(t + 1.33, mtof(93), { vel: 0.4, dur: 3, gain: 0.022, bell: true, pan: 0.25, bus: S.buses.chime });
  }

  function whoosh() {
    const t = slot('whoosh', 0.25, 0);
    if (t < 0) return;
    const c = S.ctx, dur = 1.4;
    const src = noise(S, true, t, dur);
    const bp = filter(c, 'bandpass', 280, 0.9);
    bp.frequency.setValueAtTime(280, t);
    bp.frequency.exponentialRampToValueAtTime(2200, t + 0.55);
    bp.frequency.exponentialRampToValueAtTime(500, t + 1.2);
    const env = c.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.16, t + 0.45);
    env.gain.exponentialRampToValueAtTime(FLOOR, t + dur - 0.05);
    env.gain.linearRampToValueAtTime(0, t + dur - 0.02);
    const p = panner(c, -0.7);
    if (p.pan) {
      p.pan.setValueAtTime(-0.7, t);
      p.pan.linearRampToValueAtTime(0.7, t + dur);
    }
    src.connect(bp); bp.connect(env); env.connect(p); p.connect(S.buses.fx);
    track([src, bp, env, p], src, t + dur);
  }

  // ---------------------------------------------------------------- dev hooks (not part of the contract)
  function analyze(buf) {
    const n = buf.length, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const W = Math.max(1, Math.floor(buf.sampleRate * 0.1));
    let peak = 0, sum = 0, clipped = 0, nan = 0, win = 0, wc = 0, maxWin = 0;
    for (let i = 0; i < n; i++) {
      const a = L[i], b = R[i];
      if (a !== a || b !== b) { nan++; continue; }
      const m = Math.max(Math.abs(a), Math.abs(b));
      if (m > peak) peak = m;
      if (m >= 0.999) clipped++;
      const e = (a * a + b * b) * 0.5;
      sum += e;
      win += e;
      if (++wc === W) {
        if (win / W > maxWin) maxWin = win / W;
        win = 0;
        wc = 0;
      }
    }
    const db = (x) => (x > 0 ? Math.round(200 * Math.log10(x)) / 10 : -Infinity);
    return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / n)), maxRms100msDb: db(Math.sqrt(maxWin)), clipped, nan };
  }

  const debug = {
    stats() {
      const s = S;
      if (!s) return null;
      return {
        state: s.ctx.state, time: tnow(s), voices: s.voices.length, pool: s.pool.length, groups: s.groups,
        pads: s.pads.map((p) => p.mode + (p.fading ? '~' : '')), chord: s.chord, enabled: isEnabled(), hidden
      };
    },
    pump() { guard(pump); },
    nextChord() { guard(() => S && nextChord(S)); },
    /** Render a scripted sequence into an OfflineAudioContext: script((t, fn) => …) schedules API calls at virtual times. */
    async render(seconds, script, sampleRate) {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OAC) throw new Error('OfflineAudioContext unsupported');
      const sr = sampleRate || 48000;
      const off = new OAC(2, Math.ceil(seconds * sr), sr);
      const s = build(off, off.destination, true);
      s.master.gain.value = MASTER;
      s.tv = 0;
      const evs = [];
      script((t, fn) => evs.push({ t: num(t, 0), fn }));
      evs.sort((a, b) => a.t - b.t);
      const prev = S;
      S = s;
      try {
        let i = 0;
        for (let vt = 0; vt < seconds; vt += 0.005) {
          s.tv = vt;
          while (i < evs.length && evs[i].t <= vt) evs[i++].fn();
          pump();
        }
      } finally {
        S = prev;
      }
      const buf = await off.startRendering();
      return Object.assign(analyze(buf), { buffer: buf, voicesLeft: s.voices.length, padsLeft: s.pads.length });
    }
  };

  // ---------------------------------------------------------------- public API (CONTRACT §7.6)
  const play = (fn) => function () {
    const args = arguments;
    guard(() => {
      if (enter()) fn.apply(null, args);
    });
  };

  GLX.Audio = {
    init() { guard(init); },
    get ready() {
      return !!(real && S === real && real.ctx.state === 'running');
    },
    get enabled() {
      return guard(isEnabled) !== false;
    },
    setEnabled(on) { guard(() => setEnabled(on)); },
    toggle() {
      guard(() => setEnabled(!isEnabled()));
      return guard(isEnabled) !== false;
    },
    ambient(mode) {
      guard(() => {
        mode = MOODS[mode] ? mode : 'off';
        if (!S || !S.offline) wantMode = mode;
        if (S) setMood(S, mode);
      });
    },
    starBirth: play(starBirth),
    galaxyComplete: play(galaxyComplete),
    cometLaunch: play(cometLaunch),
    cometArrive: play(cometArrive),
    select: play(select),
    hover: play(hover),
    uiClick: play(uiClick),
    collision: play(collision),
    conflict: play(conflict),
    resolve: play(resolve),
    mergeComplete: play(mergeComplete),
    whoosh: play(whoosh),
    _debug: debug
  };
})();
