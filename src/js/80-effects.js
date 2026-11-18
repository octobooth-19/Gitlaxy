/* Gitlaxy — 80-effects.js
 * The sparkle layer: star-birth flashes, impact shockwaves, activity comets, merge-conflict lightning,
 * planets orbiting the selected star and the hover ring. Everything is pooled: update()/emit() never allocate.
 */
(() => {
  'use strict';
  const GLX = (window.GLX = window.GLX || {});
  const U = GLX.util;
  const SPR = GLX.SPRITE || { STAR: 0, GLOW: 1, RING: 2, NEBULA: 3 };
  const GLOW = SPR.GLOW, RING = SPR.RING;

  const TAU = Math.PI * 2;
  const PX = 0.00105; // ≈ world units per CSS px at distance 1 (fov 50°, ~900 px tall viewport)

  const MAX_BIRTHS = 128, BIRTH_LIFE = 1.2, BIRTH_SPARKS = 6;
  const MAX_BURSTS = 48, BURST_LIFE = 1.15, BURST_SPARKS = 8;
  const MAX_SPARKS = 256;
  const MAX_COMETS = 6, HIST = 48, TRAIL = 14, TRAIL_DT = 0.03, SAMPLE_DT = 0.012, SHED_DT = 0.05;
  const COMET_OWN_DUR = 2.2, COMET_EXT_DUR = 2.6, FIRST_COMET_DELAY = 0.5, MIN_INTERVAL = 0.1;
  const MAX_BOLTS = 8, BOLT_SEG = 16, BOLT_BRANCHES = 3, BRANCH_SEG = 4;
  const MAX_SYSTEMS = 3, MAX_PLANETS = 7, ORBIT_SEG = 48, SYS_FADE = 0.4, ORBIT_RMAX = 0.17, KEPLER_W0 = 0.8;
  const MAX_HOVERS = 3;

  const COS = new Float64Array(ORBIT_SEG + 1), SIN = new Float64Array(ORBIT_SEG + 1);
  for (let j = 0; j <= ORBIT_SEG; j++) {
    COS[j] = Math.cos((j / ORBIT_SEG) * TAU);
    SIN[j] = Math.sin((j / ORBIT_SEG) * TAU);
  }

  const RED = GLX.color.hexToRgb('#f85149'), ORANGE = GLX.color.hexToRgb('#f0883e'), GREEN = GLX.color.hexToRgb('#3fb950');

  const isNum = Number.isFinite;
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const smooth01 = (x) => {
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    return x * x * (3 - 2 * x);
  };
  const easeOut3 = (x) => {
    x = x < 0 ? 1 : x > 1 ? 0 : 1 - x;
    return 1 - x * x * x;
  };
  /** RING thickness (fraction of the quad radius) that renders ≈ wantPx CSS px wide. */
  const ringThk = (half, px, wantPx) => {
    const t = (wantPx * px) / half;
    return t < 0.02 ? 0.02 : t > 0.3 ? 0.3 : t;
  };
  const validRef = (r) => !!r && isNum(r.index) && r.index >= 0;
  const sameRef = (a, b) => a.slot === (b.slot | 0) && a.index === (b.index | 0);
  /** Identity of a selected star: its repo's full name (stable across object copies), else the object itself. */
  const starKey = (star) => (star && star.repo && (star.repo.fullName || star.repo.name)) || star || null;

  function setColor(o, c) {
    if (c && isNum(c[0]) && isNum(c[1]) && isNum(c[2])) {
      o.r = clamp01(c[0]); o.g = clamp01(c[1]); o.b = clamp01(c[2]);
    } else {
      o.r = 1; o.g = 1; o.b = 1;
    }
  }

  const evColorCache = Object.create(null);
  function eventColor(kind) {
    const key = typeof kind === 'string' ? kind : 'other';
    let c = evColorCache[key];
    if (!c) {
      const table = GLX.EVENT_COLORS || {};
      const hex = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : table.other || '#c9d1d9';
      c = evColorCache[key] = GLX.color.hexToRgb(hex);
    }
    return c;
  }

  function lookupRef(own, key) {
    if (!own) return null;
    let r = null;
    if (typeof own.get === 'function') r = own.get(key);
    else if (Object.prototype.hasOwnProperty.call(own, key)) r = own[key];
    return validRef(r) ? r : null;
  }

  // Reseedable mulberry32 (same generator as GLX.util.rng) for per-flicker lightning jitter without closures.
  let jState = 0;
  function jSeed(a, b) {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 15;
    jState = h | 0;
  }
  function jRand() {
    jState = (jState + 0x6d2b79f5) | 0;
    let t = Math.imul(jState ^ (jState >>> 15), 1 | jState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const newRef = () => ({ slot: 0, index: 0 });
  const makeBirth = () => ({
    on: false, ref: newRef(), r: 1, g: 1, b: 1, s: 0.5, age: 0, n: 0,
    dir: new Float32Array(BIRTH_SPARKS * 3), sp: new Float32Array(BIRTH_SPARKS)
  });
  const makeBurst = () => ({
    on: false, track: false, ref: newRef(), x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, size: 0.1, age: 0, n: 0,
    dir: new Float32Array(BURST_SPARKS * 3), sp: new Float32Array(BURST_SPARKS)
  });
  const makeComet = () => ({
    on: false, orphan: false, fade: 1, ev: null, target: null, ref: newRef(), ext: false, slot: 0,
    age: 0, dur: COMET_OWN_DUR, t: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, ex: 0, ey: 0, ez: 0,
    side: 1, bend: 0.2, lift: 0, r: 1, g: 1, b: 1, shed: 0,
    hist: new Float64Array(HIST * 4), hHead: 0, hCount: 0, lastSample: 0
  });
  const makeBolt = () => ({ on: false, a: newRef(), b: newRef(), age: 0, dur: 2.4, seed: 0 });
  const makeSystem = () => ({
    on: false, alpha: 0, target: 0, ref: newRef(), key: null, size: 0, r: 1, g: 1, b: 1, n: 0, t0: 0,
    rad: new Float32Array(MAX_PLANETS), om: new Float32Array(MAX_PLANETS), ph: new Float32Array(MAX_PLANETS),
    ps: new Float32Array(MAX_PLANETS), e1: new Float32Array(MAX_PLANETS * 3), e2: new Float32Array(MAX_PLANETS * 3),
    col: new Float32Array(MAX_PLANETS * 3), moon: -1, mPh: 0, mOm: 0, m1: new Float32Array(3), m2: new Float32Array(3)
  });
  const makeHover = () => ({ on: false, alpha: 0, target: 0, ref: newRef(), key: null, size: 0, r: 1, g: 1, b: 1 });
  const pool = (n, make) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push(make());
    return a;
  };

  /** Orbit basis for a plane tilted `tilt` rad from the XZ plane about the horizontal axis at angle `ax`. */
  function tiltedBasis(e1, o1, e2, o2, ax, tilt) {
    const cx = Math.cos(ax), cz = Math.sin(ax), ct = Math.cos(tilt), st = Math.sin(tilt);
    const nx = -cz * st, ny = ct, nz = cx * st; // orbit normal (+Y tilted about (cx, 0, cz))
    e1[o1] = cx; e1[o1 + 1] = 0; e1[o1 + 2] = cz;
    e2[o2] = ny * cz; e2[o2 + 1] = nz * cx - nx * cz; e2[o2 + 2] = -ny * cx; // n × e1 → prograde like the galaxy spin
  }

  class Effects {
    constructor() {
      this.cometsEnabled = false;
      this.cometInterval = 1.8;
      this.onCometLaunch = null;
      this.onCometArrive = null;
      this.reducedMotion = !!(U.prefersReducedMotion && U.prefersReducedMotion());
      /** Per-emit diagnostics (counts of live effects drawn last frame). */
      this.stats = { births: 0, bursts: 0, sparks: 0, comets: 0, trail: 0, bolts: 0, planets: 0, hovers: 0, sprites: 0, lines: 0 };

      this._births = pool(MAX_BIRTHS, makeBirth);
      this._bursts = pool(MAX_BURSTS, makeBurst);
      this._comets = pool(MAX_COMETS, makeComet);
      this._bolts = pool(MAX_BOLTS, makeBolt);
      this._systems = pool(MAX_SYSTEMS, makeSystem);
      this._hovers = pool(MAX_HOVERS, makeHover);
      this._sPos = new Float32Array(MAX_SPARKS * 3);
      this._sVel = new Float32Array(MAX_SPARKS * 3);
      this._sCol = new Float32Array(MAX_SPARKS * 3);
      this._sAge = new Float32Array(MAX_SPARKS);
      this._sLife = new Float32Array(MAX_SPARKS);
      this._sSize = new Float32Array(MAX_SPARKS);
      this._sInt = new Float32Array(MAX_SPARKS);
      this._bv = new Float32Array((BOLT_SEG + 1) * 3);
      this._bw = new Float32Array((BOLT_SEG + 1) * 2);
      this._p = [0, 0, 0];
      this._q = [0, 0, 0];
      this._c = [0, 0, 0];
      this._e = [0, 0, 0];
      this._px = 2.9 * PX;
      this.reset();
    }

    /** Clears every effect and the comet queue. Settings (cometsEnabled, cometInterval, callbacks) are kept. */
    reset() {
      this._rand = U.rng(0x6a17e5);
      this._clock = 0;
      this._time = 0;
      for (let i = 0; i < MAX_BIRTHS; i++) this._births[i].on = false;
      for (let i = 0; i < MAX_BURSTS; i++) this._bursts[i].on = false;
      for (let i = 0; i < MAX_COMETS; i++) {
        const c = this._comets[i];
        c.on = false; c.ev = null; c.target = null;
      }
      for (let i = 0; i < MAX_BOLTS; i++) this._bolts[i].on = false;
      for (let i = 0; i < MAX_SYSTEMS; i++) {
        const s = this._systems[i];
        s.on = false; s.alpha = 0; s.target = 0; s.key = null;
      }
      for (let i = 0; i < MAX_HOVERS; i++) {
        const h = this._hovers[i];
        h.on = false; h.alpha = 0; h.target = 0; h.key = null;
      }
      this._sAge.fill(0);
      this._sLife.fill(0);
      this._birthHead = 0;
      this._burstHead = 0;
      this._sparkHead = 0;
      this._events = [];
      this._evTargets = [];
      this._evHash = new Uint32Array(0);
      this._evSlot = new Uint8Array(0);
      this._evCursor = 0;
      this._cometTimer = 0;
      this._wasEnabled = false;
      const st = this.stats;
      for (const k in st) st[k] = 0;
    }

    /** Comet queue (newest first, cycles). ownRepos: Map<'owner/name' lowercased, StarRef>. */
    setEvents(events, ownRepos) {
      const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
      const n = list.length;
      const targets = new Array(n), hashes = new Uint32Array(n), slots = new Uint8Array(n);
      const ownerSlot = new Map();
      if (ownRepos && typeof ownRepos.forEach === 'function') {
        ownRepos.forEach((ref, key) => {
          if (!validRef(ref) || typeof key !== 'string') return;
          const owner = key.split('/')[0];
          if (owner && !ownerSlot.has(owner)) ownerSlot.set(owner, ref.slot | 0);
        });
      }
      for (let i = 0; i < n; i++) {
        const key = String(list[i].repo || '').toLowerCase();
        const ref = lookupRef(ownRepos, key);
        targets[i] = ref;
        hashes[i] = U.hashStr(key);
        const owner = key.split('/')[0];
        slots[i] = ref ? ref.slot | 0 : ownerSlot.has(owner) ? ownerSlot.get(owner) : 0;
      }
      this._events = list;
      this._evTargets = targets;
      this._evHash = hashes;
      this._evSlot = slots;
      this._evCursor = 0;
      this._wasEnabled = false; // first comet of the new queue shortly after
      // In-flight comets may point at another galaxy's stars now: let them fade out silently.
      for (let i = 0; i < MAX_COMETS; i++) {
        const c = this._comets[i];
        if (c.on) c.orphan = true;
      }
    }

    /** Star-birth flash + expanding ring + sparkles; tracks the (moving) star. */
    birth(ref, color, strength) {
      if (!validRef(ref)) return;
      const b = this._births[this._birthHead];
      this._birthHead = (this._birthHead + 1) % MAX_BIRTHS;
      const s = isNum(strength) ? clamp01(strength) : 0.5;
      b.on = true;
      b.age = 0;
      b.ref.slot = ref.slot | 0;
      b.ref.index = ref.index | 0;
      setColor(b, color);
      b.s = s;
      b.n = 4 + Math.round(2 * s);
      const rnd = this._rand;
      for (let i = 0; i < b.n; i++) {
        const u = rnd() * TAU, v = rnd() * 2 - 1, h = Math.sqrt(1 - v * v);
        b.dir[i * 3] = Math.cos(u) * h;
        b.dir[i * 3 + 1] = v * 0.45;
        b.dir[i * 3 + 2] = Math.sin(u) * h;
        b.sp[i] = 0.7 + 0.6 * rnd();
      }
    }

    /** Shockwave at a fixed world point; size = final shockwave radius (world units). */
    burst(pos, color, size) {
      if (!pos || !isNum(pos[0]) || !isNum(pos[1]) || !isNum(pos[2])) return;
      const ok = !!color && isNum(color[0]) && isNum(color[1]) && isNum(color[2]);
      this._spawnBurst(null, pos[0], pos[1], pos[2], ok ? clamp01(color[0]) : 1, ok ? clamp01(color[1]) : 1, ok ? clamp01(color[2]) : 1, size);
    }

    _spawnBurst(ref, x, y, z, r, g, b, size) {
      const bu = this._bursts[this._burstHead];
      this._burstHead = (this._burstHead + 1) % MAX_BURSTS;
      bu.on = true;
      bu.age = 0;
      bu.track = !!ref;
      if (ref) {
        bu.ref.slot = ref.slot | 0;
        bu.ref.index = ref.index | 0;
      }
      bu.x = x; bu.y = y; bu.z = z;
      bu.r = r; bu.g = g; bu.b = b;
      bu.size = isNum(size) && size > 0 ? size : 0.1;
      const rnd = this._rand;
      bu.n = 6 + Math.floor(rnd() * 3);
      for (let i = 0; i < bu.n; i++) {
        const u = rnd() * TAU, v = rnd() * 2 - 1, h = Math.sqrt(1 - v * v);
        bu.dir[i * 3] = Math.cos(u) * h;
        bu.dir[i * 3 + 1] = v * 0.6;
        bu.dir[i * 3 + 2] = Math.sin(u) * h;
        bu.sp[i] = 0.65 + 0.5 * rnd();
      }
    }

    _spawnSpark(x, y, z, vx, vy, vz, life, size, r, g, b, intensity) {
      const i = this._sparkHead;
      this._sparkHead = (i + 1) % MAX_SPARKS;
      const o = i * 3, P = this._sPos, V = this._sVel, C = this._sCol;
      P[o] = x; P[o + 1] = y; P[o + 2] = z;
      V[o] = vx; V[o + 1] = vy; V[o + 2] = vz;
      C[o] = r; C[o + 1] = g; C[o + 2] = b;
      this._sAge[i] = 0;
      this._sLife[i] = life;
      this._sSize[i] = size;
      this._sInt[i] = intensity;
    }

    /** Merge-conflict lightning between two stars: red/orange flicker → resolves to green → fades. */
    bolt(a, b, opts) {
      if (!validRef(a) || !validRef(b)) return;
      const B = this._bolts;
      let pick = null;
      for (let i = 0; i < MAX_BOLTS; i++) {
        if (!B[i].on) {
          pick = B[i];
          break;
        }
      }
      if (!pick) {
        pick = B[0];
        for (let i = 1; i < MAX_BOLTS; i++) if (B[i].age / B[i].dur > pick.age / pick.dur) pick = B[i];
      }
      const d = opts && isNum(opts.duration) && opts.duration > 0 ? opts.duration : 2.4;
      pick.on = true;
      pick.age = 0;
      pick.dur = d < 0.3 ? 0.3 : d;
      pick.a.slot = a.slot | 0;
      pick.a.index = a.index | 0;
      pick.b.slot = b.slot | 0;
      pick.b.index = b.index | 0;
      pick.seed = (this._rand() * 2147483647) | 0;
    }

    /** Planets (one per power of two of forks, max 7) orbiting the selected star; null fades them out. */
    setSelected(sel) {
      const ref = sel && sel.ref;
      const ok = validRef(ref);
      const star = ok ? sel.star || null : null, key = starKey(star);
      const S = this._systems;
      for (let i = 0; i < MAX_SYSTEMS; i++) {
        const s = S[i];
        if (ok && s.on && s.target === 1 && sameRef(s.ref, ref) && s.key === key) return;
      }
      for (let i = 0; i < MAX_SYSTEMS; i++) if (S[i].on) S[i].target = 0;
      if (!ok) return;
      for (let i = 0; i < MAX_SYSTEMS; i++) {
        const s = S[i];
        if (s.on && sameRef(s.ref, ref) && s.key === key) {
          s.target = 1;
          return;
        }
      }
      let pick = null;
      for (let i = 0; i < MAX_SYSTEMS; i++) {
        if (!S[i].on) {
          pick = S[i];
          break;
        }
      }
      if (!pick) {
        pick = S[0];
        for (let i = 1; i < MAX_SYSTEMS; i++) if (S[i].alpha < pick.alpha) pick = S[i];
      }
      this._layoutSystem(pick, ref, star, key);
    }

    _layoutSystem(sys, ref, star, key) {
      const repo = (star && star.repo) || null;
      const forks = repo && isNum(repo.forks) && repo.forks > 0 ? repo.forks : 0;
      const n = Math.min(MAX_PLANETS, 1 + Math.floor(Math.log2(forks + 1)));
      sys.on = true;
      sys.alpha = 0;
      sys.target = 1;
      sys.t0 = this._clock;
      sys.n = n;
      sys.key = key;
      sys.ref.slot = ref.slot | 0;
      sys.ref.index = ref.index | 0;
      setColor(sys, star && star.color);
      sys.size = star && isNum(star.size) && star.size > 0 ? star.size : 0;
      const name = repo ? String(repo.fullName || repo.name || '') : '';
      const rnd = U.rng(U.hashStr(name + '|' + sys.ref.slot + ':' + sys.ref.index));
      const hsl = GLX.color.rgbToHsl(sys.r, sys.g, sys.b);
      const incAxis = rnd() * TAU, inc = 0.1 + 0.22 * rnd();
      let big = 0;
      for (let k = 0; k < n; k++) {
        const o = k * 3;
        tiltedBasis(sys.e1, o, sys.e2, o, incAxis + (rnd() - 0.5) * 1.4, inc + (rnd() - 0.5) * 0.28);
        sys.ph[k] = rnd() * TAU;
        sys.ps[k] = 0.15 + 0.15 * rnd();
        if (sys.ps[k] > sys.ps[big]) big = k;
        const c = GLX.color.hslToRgb((hsl[0] + (rnd() - 0.5) * 0.16 + 1) % 1, clamp01(0.22 + hsl[1] * (0.35 + 0.45 * rnd())), 0.52 + 0.28 * rnd());
        sys.col[o] = c[0];
        sys.col[o + 1] = c[1];
        sys.col[o + 2] = c[2];
      }
      sys.moon = repo && isNum(repo.issues) && repo.issues > 0 ? big : -1;
      if (sys.moon >= 0) {
        tiltedBasis(sys.m1, 0, sys.m2, 0, rnd() * TAU, 0.35 + 0.3 * rnd());
        sys.mPh = rnd() * TAU;
        sys.mOm = 2.4 + 1.2 * rnd();
      }
      if (sys.size > 0) this._layoutRadii(sys);
    }

    /** Orbits ≈2.5× star size growing ≈1.25× outward, softly compressed so big systems stay in frame; Kepler-ish speeds. */
    _layoutRadii(sys) {
      const z = sys.size, n = sys.n;
      let r0 = 2.5 * z, g = 1.25;
      if (n > 1 && r0 * Math.pow(g, n - 1) > ORBIT_RMAX) g = Math.max(1.12, Math.pow(ORBIT_RMAX / r0, 1 / (n - 1)));
      const span = Math.pow(g, n - 1);
      if (r0 * span > ORBIT_RMAX) r0 = Math.max(1.5 * z, ORBIT_RMAX / span);
      for (let k = 0; k < n; k++) {
        sys.rad[k] = r0 * Math.pow(g, k);
        sys.om[k] = KEPLER_W0 * Math.pow(g, -1.5 * k);
      }
    }

    /** Soft pulsing ring around the hovered star; null fades it out. */
    setHovered(sel) {
      const ref = sel && sel.ref;
      const ok = validRef(ref);
      const star = ok ? sel.star || null : null, key = starKey(star);
      const H = this._hovers;
      for (let i = 0; i < MAX_HOVERS; i++) {
        const h = H[i];
        if (ok && h.on && h.target === 1 && sameRef(h.ref, ref) && h.key === key) return;
      }
      for (let i = 0; i < MAX_HOVERS; i++) if (H[i].on) H[i].target = 0;
      if (!ok) return;
      for (let i = 0; i < MAX_HOVERS; i++) {
        const h = H[i];
        if (h.on && sameRef(h.ref, ref) && h.key === key) {
          h.target = 1;
          return;
        }
      }
      let pick = null;
      for (let i = 0; i < MAX_HOVERS; i++) {
        if (!H[i].on) {
          pick = H[i];
          break;
        }
      }
      if (!pick) {
        pick = H[0];
        for (let i = 1; i < MAX_HOVERS; i++) if (H[i].alpha < pick.alpha) pick = H[i];
      }
      pick.on = true;
      pick.alpha = 0;
      pick.target = 1;
      pick.ref.slot = ref.slot | 0;
      pick.ref.index = ref.index | 0;
      pick.key = key;
      pick.size = star && isNum(star.size) && star.size > 0 ? star.size : 0;
      setColor(pick, star && star.color);
    }

    _interval() {
      const v = this.cometInterval;
      return isNum(v) ? (v < MIN_INTERVAL ? MIN_INTERVAL : v) : 1.8;
    }

    update(dt, time) {
      dt = isNum(dt) && dt > 0 ? (dt > 0.1 ? 0.1 : dt) : 0;
      if (isNum(time)) this._time = time;
      this._clock += dt;

      for (let i = 0; i < MAX_BIRTHS; i++) {
        const b = this._births[i];
        if (b.on && (b.age += dt) >= BIRTH_LIFE) b.on = false;
      }
      for (let i = 0; i < MAX_BURSTS; i++) {
        const b = this._bursts[i];
        if (b.on && (b.age += dt) >= BURST_LIFE) b.on = false;
      }
      if (dt > 0) {
        const damp = Math.exp(-1.6 * dt), P = this._sPos, V = this._sVel, ages = this._sAge, lifes = this._sLife;
        for (let i = 0; i < MAX_SPARKS; i++) {
          if (ages[i] >= lifes[i]) continue;
          ages[i] += dt;
          const o = i * 3;
          P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt;
          V[o] *= damp; V[o + 1] *= damp; V[o + 2] *= damp;
        }
      }
      for (let i = 0; i < MAX_COMETS; i++) {
        const c = this._comets[i];
        if (!c.on) continue;
        c.age += dt;
        c.t = c.age / c.dur;
        c.shed = Math.min(c.shed + dt, 0.25);
        if (c.orphan && (c.fade -= dt / 0.3) <= 0) {
          c.on = false; c.ev = null; c.target = null;
        }
      }
      const interval = this._interval();
      const enabled = !!this.cometsEnabled;
      if (enabled && !this._wasEnabled) this._cometTimer = Math.max(0, interval - FIRST_COMET_DELAY);
      this._wasEnabled = enabled;
      if (enabled && this._events.length) this._cometTimer = Math.min(this._cometTimer + dt, interval);

      for (let i = 0; i < MAX_BOLTS; i++) {
        const b = this._bolts[i];
        if (b.on && (b.age += dt) >= b.dur) b.on = false;
      }
      const sysStep = dt / SYS_FADE;
      for (let i = 0; i < MAX_SYSTEMS; i++) {
        const s = this._systems[i];
        if (!s.on) continue;
        s.alpha = s.target ? Math.min(1, s.alpha + sysStep) : s.alpha - sysStep;
        if (!s.target && s.alpha <= 0) {
          s.on = false; s.alpha = 0; s.key = null;
        }
      }
      for (let i = 0; i < MAX_HOVERS; i++) {
        const h = this._hovers[i];
        if (!h.on) continue;
        h.alpha = h.target ? Math.min(1, h.alpha + dt / 0.16) : h.alpha - dt / 0.28;
        if (!h.target && h.alpha <= 0) {
          h.on = false; h.alpha = 0; h.key = null;
        }
      }
    }

    emit(sprites, lines, ctx) {
      const st = this.stats;
      st.births = st.bursts = st.sparks = st.comets = st.trail = st.bolts = st.planets = st.hovers = st.sprites = st.lines = 0;
      if (!sprites || !lines || !ctx) return;
      const s0 = sprites.count, l0 = lines.count;
      const cd = isNum(ctx.camDist) && ctx.camDist > 0 ? ctx.camDist : 2.9;
      this._px = cd * PX;
      this._emitComets(sprites, lines, ctx);
      this._emitBirths(sprites, ctx);
      this._emitBursts(sprites, ctx);
      this._emitSparks(sprites);
      this._emitBolts(sprites, lines, ctx);
      this._emitSystems(sprites, lines, ctx);
      this._emitHovers(sprites, ctx);
      st.sprites = sprites.count - s0;
      st.lines = lines.count - l0;
    }

    /** Current world position of a star into `out`; false when unavailable/invalid (never throws). */
    _star(ctx, ref, out) {
      out[0] = NaN;
      let p;
      try {
        p = ctx.starPos(ref, out);
      } catch (err) {
        return false;
      }
      if (p === null) return false;
      if (p === undefined) p = out;
      const x = p[0], y = p[1], z = p[2];
      if (!(isNum(x) && isNum(y) && isNum(z))) return false;
      out[0] = x; out[1] = y; out[2] = z;
      return true;
    }

    _center(ctx, slot, out) {
      out[0] = NaN;
      let p = null;
      if (typeof ctx.galaxyCenter === 'function') {
        try {
          p = ctx.galaxyCenter(slot, out);
        } catch (err) {
          p = null;
        }
        if (p === undefined) p = out;
      }
      if (p && isNum(p[0]) && isNum(p[1]) && isNum(p[2])) {
        out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
      } else {
        out[0] = 0; out[1] = 0; out[2] = 0;
      }
      return out;
    }

    _size(ctx, ref) {
      let z = 0;
      if (typeof ctx.starSize === 'function') {
        try {
          z = +ctx.starSize(ref);
        } catch (err) {
          z = 0;
        }
      }
      return isNum(z) && z > 0 ? z : 0.02;
    }

    // ------------------------------------------------------------------ comets
    _launch(ctx) {
      let c = null;
      for (let i = 0; i < MAX_COMETS; i++) {
        if (!this._comets[i].on) {
          c = this._comets[i];
          break;
        }
      }
      if (!c) return false;
      const n = this._events.length;
      const tries = n < 4 ? n : 4;
      for (let k = 0; k < tries; k++) {
        const i = this._evCursor;
        this._evCursor = (i + 1) % n;
        const ev = this._events[i], target = this._evTargets[i];
        if (target && !this._star(ctx, target, this._e)) continue; // target star unavailable → skip this event
        this._initComet(c, ev, target, this._evHash[i], this._evSlot[i], ctx);
        const fn = this.onCometLaunch;
        if (typeof fn === 'function') {
          try {
            fn(ev, target);
          } catch (err) {
            console.error(err);
          }
        }
        return true;
      }
      this._cometTimer = Math.max(0, this._interval() - 0.25); // nothing launchable right now: retry soon
      return false;
    }

    _initComet(c, ev, target, hash, slot, ctx) {
      const rnd = this._rand;
      const gr = isNum(ctx.galaxyRadius) && ctx.galaxyRadius > 0 ? ctx.galaxyRadius : 1;
      const C = this._center(ctx, target ? target.slot | 0 : slot, this._c);
      const col = eventColor(ev.kind);
      c.on = true;
      c.orphan = false;
      c.fade = 1;
      c.ev = ev;
      c.target = target;
      c.age = 0;
      c.t = 0;
      c.shed = 0;
      c.hHead = 0;
      c.hCount = 0;
      c.lastSample = 0;
      c.r = col[0]; c.g = col[1]; c.b = col[2];
      if (target) {
        const E = this._e; // filled by _launch
        c.ext = false;
        c.slot = target.slot | 0;
        c.ref.slot = c.slot;
        c.ref.index = target.index | 0;
        c.ex = E[0]; c.ey = E[1]; c.ez = E[2];
        // Enter from the star's side of the sky, at r ≈ 1.6 just outside the rim.
        const phi = Math.atan2(E[2] - C[2], E[0] - C[0]) + (rnd() - 0.5) * 2.6;
        c.ax = Math.cos(phi) * 1.6 * gr;
        c.ay = (rnd() * 2 - 1) * 0.3 * gr;
        c.az = Math.sin(phi) * 1.6 * gr;
        c.side = rnd() < 0.5 ? -1 : 1;
        c.bend = 0.16 + 0.18 * rnd();
        c.lift = (rnd() - 0.35) * 0.16;
        c.dur = COMET_OWN_DUR * (0.9 + 0.2 * rnd());
      } else {
        // Contribution to someone else's repo: leave the core along a direction fixed by the repo name.
        const phi = ((hash & 0xffff) / 65536) * TAU, el = (((hash >>> 16) & 0xff) / 255 - 0.5) * 0.5;
        const ce = Math.cos(el), dx = Math.cos(phi) * ce, dy = Math.sin(el), dz = Math.sin(phi) * ce;
        c.ext = true;
        c.slot = slot;
        c.ax = dx * 0.04 * gr; c.ay = dy * 0.04 * gr; c.az = dz * 0.04 * gr;
        c.bx = dx * 2.2 * gr; c.by = dy * 2.2 * gr; c.bz = dz * 2.2 * gr;
        c.ex = C[0] + c.bx; c.ey = C[1] + c.by; c.ez = C[2] + c.bz;
        c.side = (hash >>> 24) & 1 ? 1 : -1;
        c.bend = 0.18 + 0.12 * (((hash >>> 25) & 0x7f) / 127);
        c.lift = 0;
        c.dur = COMET_EXT_DUR;
      }
    }

    _arrive(ev, target, x, y, z) {
      const fn = this.onCometArrive;
      if (typeof fn !== 'function') return;
      try {
        fn(ev, target, [x, y, z]);
      } catch (err) {
        console.error(err);
      }
    }

    _emitComets(sprites, lines, ctx) {
      const interval = this._interval();
      if (this.cometsEnabled && this._events.length && this._cometTimer >= interval) {
        if (this._launch(ctx)) this._cometTimer -= interval;
      }
      const px = this._px, C = this._c, E = this._e, st = this.stats, rnd = this._rand;
      const hs = px * 11; // head half-size ≈ 11 CSS px at the camera target
      for (let i = 0; i < MAX_COMETS; i++) {
        const c = this._comets[i];
        if (!c.on) continue;
        this._center(ctx, c.slot, C);
        const sx = C[0] + c.ax, sy = C[1] + c.ay, sz = C[2] + c.az;
        let ex, ey, ez;
        if (c.ext) {
          ex = C[0] + c.bx; ey = C[1] + c.by; ez = C[2] + c.bz;
        } else {
          if (!c.orphan && this._star(ctx, c.ref, E)) {
            c.ex = E[0]; c.ey = E[1]; c.ez = E[2];
          }
          ex = c.ex; ey = c.ey; ez = c.ez;
        }
        // Quadratic Bézier: control point = midpoint pushed sideways (and a bit up) for a gentle curve.
        const dx = ex - sx, dy = ey - sy, dz = ez - sz;
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        let ux = -dz, uy = 0, uz = dx, ul = Math.sqrt(ux * ux + uz * uz);
        if (ul < 1e-6) {
          ux = 0; uy = dz; uz = -dy; ul = Math.sqrt(uy * uy + uz * uz);
        }
        if (ul < 1e-9) {
          ux = 1; uy = 0; uz = 0; ul = 1;
        }
        const kb = (c.side * c.bend * L) / ul;
        const kx = (sx + ex) * 0.5 + ux * kb, ky = (sy + ey) * 0.5 + uy * kb + c.lift * L, kz = (sz + ez) * 0.5 + uz * kb;
        const t = c.t < 1 ? c.t : 1;
        const s = c.ext ? t * (1.7 - 0.7 * t) : t * (0.3 + 0.7 * t); // ext: flung out & slowing; own: falling in
        const m = 1 - s, w0 = m * m, w1 = 2 * m * s, w2 = s * s;
        const hx = w0 * sx + w1 * kx + w2 * ex, hy = w0 * sy + w1 * ky + w2 * ey, hz = w0 * sz + w1 * kz + w2 * ez;

        if (c.t >= 1) {
          const ev = c.ev, target = c.target, orphan = c.orphan, ext = c.ext;
          c.on = false; c.ev = null; c.target = null;
          if (orphan) continue;
          if (ext) this._arrive(ev, null, hx, hy, hz);
          else {
            this._spawnBurst(c.ref, ex, ey, ez, c.r, c.g, c.b, Math.max(this._size(ctx, c.ref) * 5, px * 16));
            this._arrive(ev, target, ex, ey, ez);
          }
          continue;
        }
        st.comets++;

        const h = c.hist;
        if (c.hCount === 0 || c.age - c.lastSample >= SAMPLE_DT) {
          const o = c.hHead * 4;
          h[o] = hx; h[o + 1] = hy; h[o + 2] = hz; h[o + 3] = c.age;
          c.hHead = (c.hHead + 1) % HIST;
          if (c.hCount < HIST) c.hCount++;
          c.lastSample = c.age;
        }

        let A = c.ext ? smooth01(c.age / 0.2) * (1 - smooth01((t - 0.55) / 0.45)) : smooth01(c.age / 0.3) * (0.85 + 0.25 * s);
        if (c.orphan) A *= c.fade > 0 ? c.fade : 0;
        if (A <= 0.004) {
          c.shed = 0;
          continue;
        }
        const cr = c.r, cg = c.g, cb = c.b;

        // Trail: sample the recorded path at fixed time offsets (frame-rate independent, no popping).
        let nx = hx, ny = hy, nz = hz, nt = c.age;
        let idx = c.hHead === 0 ? HIST - 1 : c.hHead - 1, rem = c.hCount;
        let lx = hx, ly = hy, lz = hz, la = A * 0.55;
        let drawn = 0;
        for (let k = 1; k <= TRAIL; k++) {
          const q = c.age - k * TRAIL_DT;
          while (rem > 0 && h[idx * 4 + 3] > q) {
            const o = idx * 4;
            nx = h[o]; ny = h[o + 1]; nz = h[o + 2]; nt = h[o + 3];
            idx = idx === 0 ? HIST - 1 : idx - 1;
            rem--;
          }
          if (rem <= 0) break;
          const o = idx * 4, ot = h[o + 3];
          const f = nt > ot ? (q - ot) / (nt - ot) : 0;
          const x = h[o] + (nx - h[o]) * f, y = h[o + 1] + (ny - h[o + 1]) * f, z = h[o + 2] + (nz - h[o + 2]) * f;
          const fk = k / (TRAIL + 1), fade = 1 - fk;
          const a = A * 0.6 * fade * Math.sqrt(fade);
          const w = 0.3 + 0.7 * fk; // white-hot near the head → event color toward the tail
          const r = 1 + (cr - 1) * w, g = 1 + (cg - 1) * w, b = 1 + (cb - 1) * w;
          sprites.push(x, y, z, hs * (0.85 - 0.6 * fk), r, g, b, a, GLOW, 0.35);
          lines.pushGradient(lx, ly, lz, r, g, b, la, x, y, z, r, g, b, a * 0.9);
          lx = x; ly = y; lz = z; la = a * 0.9;
          drawn++;
        }
        if (drawn > st.trail) st.trail = drawn;

        sprites.push(hx, hy, hz, hs * 2.8, cr, cg, cb, 0.16 * A, GLOW, 0.04);
        sprites.push(hx, hy, hz, hs, cr + (1 - cr) * 0.3, cg + (1 - cg) * 0.3, cb + (1 - cb) * 0.3, 0.95 * A, GLOW, 0.55);
        sprites.push(hx, hy, hz, hs * 0.36, 1, 1, 1, A, GLOW, 0.95);

        // Shed glittering dust that lingers along the path.
        while (c.shed >= SHED_DT) {
          c.shed -= SHED_DT;
          const u = rnd() * TAU, v = rnd() * 2 - 1, hh = Math.sqrt(1 - v * v), sp = px * (5 + 14 * rnd());
          this._spawnSpark(hx, hy, hz, Math.cos(u) * hh * sp, v * sp, Math.sin(u) * hh * sp, 0.4 + 0.45 * rnd(),
            px * (1 + 1.4 * rnd()), cr + (1 - cr) * 0.5, cg + (1 - cg) * 0.5, cb + (1 - cb) * 0.5, A * 0.8);
        }
      }
    }

    // ------------------------------------------------------------------ births, bursts, sparks
    _emitBirths(sprites, ctx) {
      const px = this._px, P = this._p, rm = this.reducedMotion;
      let n = 0;
      for (let i = 0; i < MAX_BIRTHS; i++) {
        const b = this._births[i];
        if (!b.on || !this._star(ctx, b.ref, P)) continue;
        n++;
        const s = b.s, age = b.age, x = P[0], y = P[1], zc = P[2];
        const z = Math.max(this._size(ctx, b.ref), px * 2.2);
        // Flash: fast attack, exponential decay, gone by ~0.75 s.
        const env = (age < 0.05 ? age / 0.05 : Math.exp(-(age - 0.05) / 0.2)) * (1 - smooth01((age - 0.5) / 0.25));
        if (env > 0.002) {
          sprites.push(x, y, zc, z * (3 + 4 * s), b.r + (1 - b.r) * 0.35, b.g + (1 - b.g) * 0.35, b.b + (1 - b.b) * 0.35,
            (0.3 + 0.45 * s) * env, GLOW, 0.3);
          sprites.push(x, y, zc, z * (1.3 + 1.2 * s), b.r + (1 - b.r) * 0.75, b.g + (1 - b.g) * 0.75, b.b + (1 - b.b) * 0.75,
            (0.55 + 0.5 * s) * env * env, GLOW, 0.9);
        }
        // Expanding ring: 1× → (4..6.5)× star size over the birth lifetime.
        const tr = age / BIRTH_LIFE;
        const radius = z * (1 + (3 + 2.5 * s) * easeOut3(tr)), half = radius / 0.8;
        sprites.push(x, y, zc, half, b.r + (1 - b.r) * 0.4, b.g + (1 - b.g) * 0.4, b.b + (1 - b.b) * 0.4,
          (0.4 + 0.45 * s) * Math.pow(1 - clamp01(tr), 1.6) * smooth01(age / 0.06), RING, ringThk(half, px, 1.6 + 1.2 * s));
        // Sparkles drifting outward.
        const ts = age / 0.95;
        if (ts < 1) {
          const travel = z * (2.2 + 2.6 * s) * easeOut3(ts);
          const sz = Math.max(z * 0.28 * (1 - 0.55 * ts), px * 1.3);
          const fa = 0.85 * Math.pow(1 - ts, 1.2) * smooth01(age / 0.04);
          const sr = b.r + (1 - b.r) * 0.55, sg = b.g + (1 - b.g) * 0.55, sb = b.b + (1 - b.b) * 0.55;
          for (let k = 0; k < b.n; k++) {
            const o = k * 3, d = travel * b.sp[k];
            const tw = rm ? 1 : 0.7 + 0.3 * Math.sin(age * 38 + k * 2.1);
            sprites.push(x + b.dir[o] * d, y + b.dir[o + 1] * d, zc + b.dir[o + 2] * d, sz, sr, sg, sb, fa * tw, GLOW, 0.8);
          }
        }
      }
      this.stats.births = n;
    }

    _emitBursts(sprites, ctx) {
      const px = this._px, P = this._p;
      let n = 0;
      for (let i = 0; i < MAX_BURSTS; i++) {
        const b = this._bursts[i];
        if (!b.on) continue;
        if (b.track && this._star(ctx, b.ref, P)) {
          b.x = P[0]; b.y = P[1]; b.z = P[2];
        }
        n++;
        const x = b.x, y = b.y, z = b.z, age = b.age, R = Math.max(b.size, px * 10);
        const env = age < 0.04 ? age / 0.04 : Math.exp(-(age - 0.04) / 0.16);
        sprites.push(x, y, z, R * 0.5, b.r + (1 - b.r) * 0.45, b.g + (1 - b.g) * 0.45, b.b + (1 - b.b) * 0.45, 0.85 * env, GLOW, 0.5);
        sprites.push(x, y, z, R * 0.16, 1, 1, 1, env * Math.exp(-age / 0.1), GLOW, 0.95);
        // Primary shockwave, then a slower, paler echo.
        const t1 = age / 0.85;
        if (t1 < 1) {
          const half = (R * (0.12 + 0.88 * easeOut3(t1))) / 0.8;
          sprites.push(x, y, z, half, b.r + (1 - b.r) * 0.2, b.g + (1 - b.g) * 0.2, b.b + (1 - b.b) * 0.2,
            0.8 * Math.pow(1 - t1, 1.5) * smooth01(age / 0.03), RING, ringThk(half, px, 2.4));
        }
        const t2 = (age - 0.1) / 1.0;
        if (t2 > 0 && t2 < 1) {
          const half = (R * (0.08 + 0.6 * easeOut3(t2))) / 0.8;
          sprites.push(x, y, z, half, b.r + (1 - b.r) * 0.55, b.g + (1 - b.g) * 0.55, b.b + (1 - b.b) * 0.55,
            0.38 * Math.pow(1 - t2, 1.3), RING, ringThk(half, px, 1.5));
        }
        const ts = age / 0.75;
        if (ts < 1) {
          const travel = R * 0.9 * easeOut3(ts), sz = Math.max(R * 0.045, px * 1.5) * (1 - 0.6 * ts);
          const fa = 0.85 * Math.pow(1 - ts, 1.3);
          const sr = b.r + (1 - b.r) * 0.6, sg = b.g + (1 - b.g) * 0.6, sb = b.b + (1 - b.b) * 0.6;
          for (let k = 0; k < b.n; k++) {
            const o = k * 3, d = travel * b.sp[k];
            sprites.push(x + b.dir[o] * d, y + b.dir[o + 1] * d, z + b.dir[o + 2] * d, sz, sr, sg, sb, fa, GLOW, 0.8);
          }
        }
      }
      this.stats.bursts = n;
    }

    _emitSparks(sprites) {
      const P = this._sPos, C = this._sCol, ages = this._sAge, lifes = this._sLife, rm = this.reducedMotion;
      let n = 0;
      for (let i = 0; i < MAX_SPARKS; i++) {
        const age = ages[i], life = lifes[i];
        if (age >= life) continue;
        const f = age / life, o = i * 3;
        const tw = rm ? 1 : 0.65 + 0.35 * Math.sin(age * 31 + i * 1.7);
        const a = this._sInt[i] * (1 - f) * (1 - f) * tw * smooth01(age / 0.05);
        sprites.push(P[o], P[o + 1], P[o + 2], this._sSize[i] * (1 - 0.5 * f), C[o], C[o + 1], C[o + 2], a, GLOW, 0.75);
        n++;
      }
      this.stats.sparks = n;
    }

    // ------------------------------------------------------------------ merge-conflict lightning
    _emitBolts(sprites, lines, ctx) {
      const px = this._px, PA = this._p, PB = this._q, V = this._bv, W = this._bw, rm = this.reducedMotion;
      for (let bi = 0; bi < MAX_BOLTS; bi++) {
        const bo = this._bolts[bi];
        if (!bo.on || !this._star(ctx, bo.a, PA) || !this._star(ctx, bo.b, PB)) continue;
        this.stats.bolts++;
        const age = bo.age, u = age / bo.dur;
        jSeed(bo.seed, Math.floor(age * (rm ? 4 : 12))); // new jagged shape ~12×/s
        const k = smooth01((u - 0.6) / 0.2); // 0 = conflict … 1 = resolved
        const hot = jRand(), flick = jRand();
        let r = RED[0] + (ORANGE[0] - RED[0]) * hot, g = RED[1] + (ORANGE[1] - RED[1]) * hot, b = RED[2] + (ORANGE[2] - RED[2]) * hot;
        r += (GREEN[0] - r) * k; g += (GREEN[1] - g) * k; b += (GREEN[2] - b) * k;
        const steady = rm ? 1 : 0.7 + 0.3 * flick;
        const A = smooth01(age / 0.06) * (1 - smooth01((u - 0.8) / 0.2)) * (steady + (1 - steady) * k);
        const ax = PA[0], ay = PA[1], az = PA[2];
        const dx = PB[0] - ax, dy = PB[1] - ay, dz = PB[2] - az;
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const za = Math.max(this._size(ctx, bo.a) * 1.3, px * 7), zb = Math.max(this._size(ctx, bo.b) * 1.3, px * 7);

        // Resolution pulse: a green ring blooms around both stars as the conflict resolves.
        const tr = (u - 0.6) / 0.35;
        if (tr > 0 && tr < 1) {
          const e = 0.9 + 2.6 * easeOut3(tr), ra = 0.55 * Math.pow(1 - tr, 1.5);
          const ha = (za * e) / 0.8, hb = (zb * e) / 0.8;
          sprites.push(ax, ay, az, ha, GREEN[0], GREEN[1], GREEN[2], ra, RING, ringThk(ha, px, 1.8));
          sprites.push(PB[0], PB[1], PB[2], hb, GREEN[0], GREEN[1], GREEN[2], ra, RING, ringThk(hb, px, 1.8));
        }
        if (A <= 0.003 || L < 1e-6) continue;

        // Camera-independent perpendicular frame: p1 = d × Y (fallback d × X), p2 = d̂ × p1.
        const lx = dx / L, ly = dy / L, lz = dz / L;
        let p1x = -lz, p1y = 0, p1z = lx, pl = Math.sqrt(p1x * p1x + p1z * p1z);
        if (pl < 1e-4) {
          p1x = 0; p1y = lz; p1z = -ly; pl = Math.sqrt(p1y * p1y + p1z * p1z);
        }
        p1x /= pl; p1y /= pl; p1z /= pl;
        const p2x = ly * p1z - lz * p1y, p2y = lz * p1x - lx * p1z, p2z = lx * p1y - ly * p1x;

        // Jagged channel = 2-D Brownian bridge (pinned at both stars); straightens as it resolves.
        const N = 10 + Math.floor(jRand() * 7);
        const amp = L * 0.085 * (1 - 0.85 * k) * Math.sqrt(12 / N);
        let wu = 0, wv = 0;
        W[0] = 0; W[1] = 0;
        for (let i = 1; i <= N; i++) {
          wu += jRand() * 2 - 1;
          wv += jRand() * 2 - 1;
          W[i * 2] = wu;
          W[i * 2 + 1] = wv;
        }
        for (let i = 0; i <= N; i++) {
          const t = i / N, ou = (W[i * 2] - t * wu) * amp, ov = (W[i * 2 + 1] - t * wv) * amp, o = i * 3;
          V[o] = ax + dx * t + p1x * ou + p2x * ov;
          V[o + 1] = ay + dy * t + p1y * ou + p2y * ov;
          V[o + 2] = az + dz * t + p1z * ou + p2z * ov;
        }
        const reach = age < 0.12 ? Math.max(1, Math.ceil((N * age) / 0.12)) : N; // the strike propagates a → b

        // White-hot main channel + a fainter colored sister strand.
        const cr = r + (1 - r) * 0.55, cg = g + (1 - g) * 0.55, cb = b + (1 - b) * 0.55, amp2 = amp * 0.45;
        let qx = ax, qy = ay, qz = az;
        for (let i = 0; i < reach; i++) {
          const o = i * 3;
          lines.push(V[o], V[o + 1], V[o + 2], V[o + 3], V[o + 4], V[o + 5], cr, cg, cb, A);
          const env = i + 1 >= N ? 0 : Math.sin((Math.PI * (i + 1)) / N);
          const ju = (jRand() * 2 - 1) * amp2 * env, jv = (jRand() * 2 - 1) * amp2 * env;
          const nx = V[o + 3] + p1x * ju + p2x * jv, ny = V[o + 4] + p1y * ju + p2y * jv, nz = V[o + 5] + p1z * ju + p2z * jv;
          lines.push(qx, qy, qz, nx, ny, nz, r, g, b, A * 0.45);
          qx = nx; qy = ny; qz = nz;
        }

        // Faint forks off the channel (vanish once resolved).
        if (k < 1) {
          const nb = 1 + Math.floor(jRand() * BOLT_BRANCHES), ba = A * 0.5 * (1 - k);
          for (let j = 0; j < nb; j++) {
            const i0 = 1 + Math.floor(jRand() * (N - 1));
            const len = (L * (0.05 + 0.08 * jRand())) / BRANCH_SEG;
            const su = jRand() * 2 - 1, sv = jRand() * 2 - 1;
            let bx = lx * 0.8 + p1x * su + p2x * sv, by = ly * 0.8 + p1y * su + p2y * sv, bz = lz * 0.8 + p1z * su + p2z * sv;
            const bn = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
            bx /= bn; by /= bn; bz /= bn;
            if (i0 >= reach) continue;
            let x = V[i0 * 3], y = V[i0 * 3 + 1], z = V[i0 * 3 + 2], a0 = ba;
            for (let sgm = 1; sgm <= BRANCH_SEG; sgm++) {
              const ju = (jRand() * 2 - 1) * 0.6, jv = (jRand() * 2 - 1) * 0.6;
              const nx = x + (bx + p1x * ju + p2x * jv) * len, ny = y + (by + p1y * ju + p2y * jv) * len, nz = z + (bz + p1z * ju + p2z * jv) * len;
              const a1 = ba * (1 - sgm / BRANCH_SEG);
              lines.pushGradient(x, y, z, r, g, b, a0, nx, ny, nz, r, g, b, a1);
              x = nx; y = ny; z = nz; a0 = a1;
            }
          }
        }

        // Volumetric glow along the channel + sparks where it touches the stars.
        const gs = Math.max(L * 0.03, px * 6);
        for (let i = 1; i < reach; i += 2) sprites.push(V[i * 3], V[i * 3 + 1], V[i * 3 + 2], gs, r, g, b, 0.09 * A, GLOW, 0.15);
        const fl = rm ? 1 : 0.8 + 0.4 * jRand();
        sprites.push(ax, ay, az, za * fl, r, g, b, 0.7 * A, GLOW, 0.55);
        sprites.push(ax, ay, az, za * 0.35, 1, 1, 1, 0.75 * A, GLOW, 0.95);
        if (reach >= N) {
          sprites.push(PB[0], PB[1], PB[2], zb * (rm ? 1 : 1.2 - (fl - 0.8)), r, g, b, 0.7 * A, GLOW, 0.55);
          sprites.push(PB[0], PB[1], PB[2], zb * 0.35, 1, 1, 1, 0.75 * A, GLOW, 0.95);
        }
      }
    }

    // ------------------------------------------------------------------ planets & hover
    _emitSystems(sprites, lines, ctx) {
      const px = this._px, P = this._p, slow = this.reducedMotion ? 0.35 : 1, pMin = px * 1.7;
      for (let si = 0; si < MAX_SYSTEMS; si++) {
        const sys = this._systems[si];
        if (!sys.on || sys.alpha <= 0 || !this._star(ctx, sys.ref, P)) continue;
        if (!(sys.size > 0)) {
          sys.size = this._size(ctx, sys.ref);
          this._layoutRadii(sys);
        }
        const A = smooth01(sys.alpha);
        const spread = 0.55 + 0.45 * A; // planets glide out of the star as the system fades in
        const tt = (this._clock - sys.t0) * slow, z = sys.size, cx = P[0], cy = P[1], cz = P[2];
        const E1 = sys.e1, E2 = sys.e2;
        this.stats.planets += sys.n;
        for (let k = 0; k < sys.n; k++) {
          const o = k * 3;
          const e1x = E1[o], e1y = E1[o + 1], e1z = E1[o + 2], e2x = E2[o], e2y = E2[o + 1], e2z = E2[o + 2];
          const cr = sys.col[o], cg = sys.col[o + 1], cb = sys.col[o + 2];
          const rad = Math.max(sys.rad[k], px * (6 + 3.5 * k)) * spread;
          const th = sys.ph[k] + sys.om[k] * tt, ct = Math.cos(th), st = Math.sin(th);
          const x0 = cx + rad * (ct * e1x + st * e2x), y0 = cy + rad * (ct * e1y + st * e2y), z0 = cz + rad * (ct * e1z + st * e2z);
          // Orbit loop, brightest just behind the planet and fading around the circle.
          let lx = x0, ly = y0, lz = z0, la = A * 0.36;
          for (let j = 1; j <= ORBIT_SEG; j++) {
            const c2 = ct * COS[j] + st * SIN[j], s2 = st * COS[j] - ct * SIN[j]; // angle θ − j·Δ
            const x = cx + rad * (c2 * e1x + s2 * e2x), y = cy + rad * (c2 * e1y + s2 * e2y), zz = cz + rad * (c2 * e1z + s2 * e2z);
            const w = 1 - j / ORBIT_SEG, a = A * (0.06 + 0.3 * w * w * w);
            lines.pushGradient(lx, ly, lz, cr, cg, cb, la, x, y, zz, cr, cg, cb, a);
            lx = x; ly = y; lz = zz; la = a;
          }
          const size = Math.max(sys.ps[k] * z, pMin);
          sprites.push(x0, y0, z0, size * 2.6, cr, cg, cb, 0.13 * A, GLOW, 0.08);
          sprites.push(x0, y0, z0, size, cr + (1 - cr) * 0.25, cg + (1 - cg) * 0.25, cb + (1 - cb) * 0.25, 0.95 * A, GLOW, 0.85);
          if (k === sys.moon) {
            const m1 = sys.m1, m2 = sys.m2, mr = size * 2.6;
            const mth = sys.mPh + sys.mOm * tt, mc = Math.cos(mth), ms = Math.sin(mth);
            sprites.push(x0 + mr * (mc * m1[0] + ms * m2[0]), y0 + mr * (mc * m1[1] + ms * m2[1]), z0 + mr * (mc * m1[2] + ms * m2[2]),
              Math.max(size * 0.42, px * 1.1), 0.84, 0.86, 0.93, 0.9 * A, GLOW, 0.8);
            let mx = x0 + mr * m1[0], my = y0 + mr * m1[1], mz = z0 + mr * m1[2];
            for (let j = 2; j <= ORBIT_SEG; j += 2) {
              const x = x0 + mr * (COS[j] * m1[0] + SIN[j] * m2[0]), y = y0 + mr * (COS[j] * m1[1] + SIN[j] * m2[1]),
                zz = z0 + mr * (COS[j] * m1[2] + SIN[j] * m2[2]);
              lines.push(mx, my, mz, x, y, zz, 0.8, 0.84, 0.95, 0.07 * A);
              mx = x; my = y; mz = zz;
            }
          }
        }
      }
    }

    _emitHovers(sprites, ctx) {
      const px = this._px, P = this._p, t = this._clock, rm = this.reducedMotion;
      for (let i = 0; i < MAX_HOVERS; i++) {
        const h = this._hovers[i];
        if (!h.on || h.alpha <= 0 || !this._star(ctx, h.ref, P)) continue;
        this.stats.hovers++;
        const z = Math.max(h.size > 0 ? h.size : this._size(ctx, h.ref), px * 2.5);
        const f = smooth01(h.alpha);
        const pulse = rm ? 1 : 1 + 0.05 * Math.sin(t * 5.2);
        const half = (Math.max(z * 1.5, px * 9) * pulse * (1 + 0.45 * (1 - f))) / 0.8; // settles inward as it appears
        const cr = 0.5 + 0.5 * h.r, cg = 0.5 + 0.5 * h.g, cb = 0.5 + 0.5 * h.b;
        sprites.push(P[0], P[1], P[2], half, cr, cg, cb, 0.5 * f, RING, ringThk(half, px, 1.5));
        const half2 = half * 1.32;
        sprites.push(P[0], P[1], P[2], half2, cr, cg, cb, 0.14 * f * (rm ? 1 : 0.75 + 0.25 * Math.sin(t * 3.1)), RING, ringThk(half2, px, 1));
        sprites.push(P[0], P[1], P[2], z * 2.8, h.r, h.g, h.b, 0.07 * f, GLOW, 0.1);
      }
    }
  }

  GLX.Effects = Effects;
})();
