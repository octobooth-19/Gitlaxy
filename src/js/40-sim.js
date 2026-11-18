/* Gitlaxy — 40-sim.js
 * `git merge` as physics: a restricted three-body galaxy collision (Toomre & Toomre 1972).
 * Two softened point-mass cores fall together on a near-parabolic prograde orbit; every particle,
 * repo-star and nebula is a massless tracer on an initially circular orbit about its own core.
 * Dynamical friction near pericenter makes the cores merge after ~2 passages.
 */
(() => {
  'use strict';
  const GLX = window.GLX;
  const { util, math } = GLX;
  const { clamp } = util;

  const DEFAULTS = {
    pericenter: 1.5,
    startDistance: 5.5,
    friction: null, // auto-tuned so the merge lands in the target window
    coreFriction: 0.35, // extra short-range drag so the final coalescence is quick (less heating)
    targetMergeTime: 24,
    bound: 0.97, // <1 → slightly bound orbit
    epsCore: 0.22,
    epsPart: 0.12,
    h: 0.008,
    maxSub: 12,
    tiltA: 0.35, // ~20°
    azA: 0.4,
    tiltB: 0.96, // ~55°
    azB: 2.3,
    viewYaw: 0.45 // camera yaw the encounter is framed for (galaxy A on the left)
  };
  const FRICTION_RANGE = 1.6;

  class MergeSim {
    constructor(galA, galB, opts) {
      this.opts = Object.assign({}, DEFAULTS, opts || {});
      this.gal = [galA, galB];
      const nA = Math.max(1, galA.stars.length), nB = Math.max(1, galB.stars.length);
      const ratio = clamp(Math.sqrt(nB / nA), 0.6, 1.6);
      this.M = [2 / (1 + ratio), (2 * ratio) / (1 + ratio)];
      this.speed = 1.0;
      const alloc = (n) => new Float32Array(Math.max(0, n) * 3);
      this.partPos = [alloc(galA.particles.count), alloc(galB.particles.count)];
      this.partVel = [alloc(galA.particles.count), alloc(galB.particles.count)];
      this.starPos = [alloc(galA.stars.length), alloc(galB.stars.length)];
      this.starVel = [alloc(galA.stars.length), alloc(galB.stars.length)];
      this.nebPos = [alloc(galA.nebulae.length), alloc(galB.nebulae.length)];
      this.nebVel = [alloc(galA.nebulae.length), alloc(galB.nebulae.length)];
      this.corePos = [[0, 0, 0], [0, 0, 0]];
      this._cv = [[0, 0, 0], [0, 0, 0]];
      this._events = [];
      this._seed = util.hashStr('merge:' + galA.profile.login + ':' + galB.profile.login);
      this._orbit = this._orbitState();
      this.friction = this.opts.friction != null ? this.opts.friction : this._tuneFriction();
      this.mergeTime = this._presim(this.friction).mergeTime;
      this.reset();
    }

    reset() {
      const o = this.opts;
      const orb = this._orbit;
      const [mA, mB] = this.M;
      const mT = mA + mB;
      for (let i = 0; i < 3; i++) {
        this.corePos[0][i] = (-mB / mT) * orb.rel[i];
        this.corePos[1][i] = (mA / mT) * orb.rel[i];
        this._cv[0][i] = (-mB / mT) * orb.vrel[i];
        this._cv[1][i] = (mA / mT) * orb.vrel[i];
      }
      const rotA = discRotation(o.tiltA, o.azA, orb.psi);
      const rotB = discRotation(o.tiltB, o.azB, orb.psi);
      const R = util.rng(this._seed);
      for (let s = 0; s < 2; s++) {
        const g = this.gal[s];
        const rot = s === 0 ? rotA : rotB;
        const core = this.corePos[s], vcore = this._cv[s], M = this.M[s];
        initGroup(g.particles.pos, g.particles.count, this.partPos[s], this.partVel[s], rot, core, vcore, M, o.epsPart, R, true);
        const sp = new Float32Array(g.stars.length * 3);
        g.stars.forEach((st, i) => { sp[3 * i] = st.pos[0]; sp[3 * i + 1] = st.pos[1]; sp[3 * i + 2] = st.pos[2]; });
        initGroup(sp, g.stars.length, this.starPos[s], this.starVel[s], rot, core, vcore, M, o.epsPart, R, false);
        const np = new Float32Array(g.nebulae.length * 3);
        g.nebulae.forEach((nb, i) => { np[3 * i] = nb.pos[0]; np[3 * i + 1] = nb.pos[1]; np[3 * i + 2] = nb.pos[2]; });
        initGroup(np, g.nebulae.length, this.nebPos[s], this.nebVel[s], rot, core, vcore, M, o.epsPart, R, false);
      }
      this.time = 0;
      this.merged = false;
      this.phase = 'approach';
      this.progress = 0;
      this.pericenters = 0;
      this.coreDistance = o.startDistance;
      this._contact = false;
      this._contactD = Math.max(1.6, o.pericenter + 0.3);
      this._prevD = this.coreDistance;
      this._prevDD = -1;
      this._massA = this.M[0];
      this._massB = this.M[1];
    }

    step(dtSeconds) {
      const events = this._events;
      events.length = 0;
      const want = (dtSeconds > 0 ? dtSeconds : 0) * (this.speed > 0 ? this.speed : 0);
      if (!(want > 0)) return events;
      const h = this.opts.h;
      const n = Math.min(this.opts.maxSub, Math.max(1, Math.ceil(want / h - 1e-9)));
      const hh = Math.min(h, want / n);
      for (let k = 0; k < n; k++) {
        this._substep(hh);
        this._track(events);
      }
      this.progress = this.merged ? 1 : clamp(this.time / Math.max(1, this.mergeTime), 0, 0.99);
      return events;
    }

    // ---------------------------------------------------------------- integration
    _substep(h) {
      const cA = this.corePos[0], cB = this.corePos[1];
      const mA = this._massA, mB = this._massB;
      const e2 = this.opts.epsPart * this.opts.epsPart;
      for (let s = 0; s < 2; s++) {
        advance(this.partPos[s], this.partVel[s], cA, cB, mA, mB, e2, h);
        advance(this.starPos[s], this.starVel[s], cA, cB, mA, mB, e2, h);
        advance(this.nebPos[s], this.nebVel[s], cA, cB, mA, mB, e2, h);
      }
      if (!this.merged) {
        coreStep(cA, cB, this._cv[0], this._cv[1], this.M[0], this.M[1], this.opts.epsCore, this.friction, h, this.opts.coreFriction);
      }
      this.time += h;
    }

    _track(events) {
      const cA = this.corePos[0], cB = this.corePos[1];
      const d = this.merged ? 0 : Math.hypot(cB[0] - cA[0], cB[1] - cA[1], cB[2] - cA[2]);
      this.coreDistance = d;
      if (this.merged) return;
      if (!this._contact && d < this._contactD) {
        this._contact = true;
        events.push('first-contact');
        this._setPhase('first-passage', events);
      }
      const dd = d - this._prevD;
      if (this._prevDD < 0 && dd >= 0) {
        this.pericenters++;
        events.push('pericenter');
        if (this.pericenters >= 2) this._setPhase('merging', events);
      } else if (this._prevDD > 0 && dd <= 0 && this.pericenters >= 1 && this.phase !== 'merging') {
        this._setPhase('second-approach', events);
      }
      if (this.pericenters === 1 && dd > 0 && this.phase === 'first-passage' && d > 1.0) this._setPhase('separating', events);
      if (dd !== 0) this._prevDD = dd;
      this._prevD = d;
      if ((this.pericenters >= 2 && d < 0.18) || d < 0.08) {
        const mA = this.M[0], mB = this.M[1], mT = mA + mB;
        for (let i = 0; i < 3; i++) {
          const c = (mA * cA[i] + mB * cB[i]) / mT;
          cA[i] = c; cB[i] = c;
          this._cv[0][i] = 0; this._cv[1][i] = 0;
        }
        this._massA = mT;
        this._massB = 0;
        this.merged = true;
        this.coreDistance = 0;
        this.progress = 1;
        events.push('merged');
        this._setPhase('merged', events);
      }
    }

    _setPhase(p, events) {
      if (this.phase === p) return;
      this.phase = p;
      events.push('phase:' + p);
    }

    // ---------------------------------------------------------------- orbit setup & tuning
    _orbitState() {
      const o = this.opts;
      const mT = this.M[0] + this.M[1];
      const q = o.pericenter, D = o.startDistance;
      const f = -Math.acos(clamp((2 * q) / D - 1, -1, 1));
      const p = 2 * q;
      const k = Math.sqrt(mT / p) * Math.sqrt(o.bound);
      const vr = k * Math.sin(f), vt = k * (1 + Math.cos(f));
      const rel0 = [D * Math.cos(f), 0, D * Math.sin(f)];
      const vrel0 = [vr * Math.cos(f) - vt * Math.sin(f), 0, vr * Math.sin(f) + vt * Math.cos(f)];
      // Rotate the encounter about Y so the initial separation runs across the screen for the framing camera.
      const right = [Math.cos(o.viewYaw), 0, -Math.sin(o.viewYaw)];
      const angSep = Math.atan2(rel0[2], rel0[0]);
      const angRight = Math.atan2(right[2], right[0]);
      // rotationY(psi) maps polar angle φ → φ − psi; B (at +rel) should end up on the right.
      const psi = angSep - angRight;
      const G = math.rotationY(math.mat4(), psi);
      const rel = math.transformPoint([0, 0, 0], G, rel0[0], rel0[1], rel0[2]);
      const vrel = math.transformPoint([0, 0, 0], G, vrel0[0], vrel0[1], vrel0[2]);
      return { rel, vrel, psi };
    }

    /** Integrate only the two cores (cheap) to find the merge time for a given friction. */
    _presim(fr) {
      const orb = this._orbit;
      const [mA, mB] = this.M;
      const mT = mA + mB;
      const cA = [0, 0, 0], cB = [0, 0, 0], vA = [0, 0, 0], vB = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        cA[i] = (-mB / mT) * orb.rel[i]; cB[i] = (mA / mT) * orb.rel[i];
        vA[i] = (-mB / mT) * orb.vrel[i]; vB[i] = (mA / mT) * orb.vrel[i];
      }
      const h = this.opts.h;
      let t = 0, peri = 0, prevD = this.opts.startDistance, prevDD = -1;
      const peris = [];
      while (t < 90) {
        coreStep(cA, cB, vA, vB, mA, mB, this.opts.epsCore, fr, h, this.opts.coreFriction);
        t += h;
        const d = Math.hypot(cB[0] - cA[0], cB[1] - cA[1], cB[2] - cA[2]);
        const dd = d - prevD;
        if (prevDD < 0 && dd >= 0) { peri++; peris.push(t); }
        if (dd !== 0) prevDD = dd;
        prevD = d;
        if ((peri >= 2 && d < 0.18) || d < 0.08) return { mergeTime: t, pericenters: peris };
      }
      return { mergeTime: Infinity, pericenters: peris };
    }

    _tuneFriction() {
      const target = this.opts.targetMergeTime;
      let lo = 0.05, hi = 6;
      let best = 1, bestErr = Infinity;
      for (let it = 0; it < 22; it++) {
        const mid = Math.sqrt(lo * hi);
        const r = this._presim(mid);
        const err = Math.abs(r.mergeTime - target);
        if (err < bestErr && r.pericenters.length >= 2) { bestErr = err; best = mid; }
        if (r.mergeTime > target) lo = mid; else hi = mid;
        if (err < 0.3 && r.pericenters.length >= 2) break;
      }
      return best;
    }
  }

  // ------------------------------------------------------------------ helpers (hot paths)
  function coreStep(cA, cB, vA, vB, mA, mB, eps, fr, h, frCore) {
    const dx = cB[0] - cA[0], dy = cB[1] - cA[1], dz = cB[2] - cA[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    const r2 = d2 + eps * eps;
    const inv = 1 / (r2 * Math.sqrt(r2));
    const mT = mA + mB;
    const w = fr * Math.exp(-d2 / (FRICTION_RANGE * FRICTION_RANGE)) + frCore * Math.exp(-d2 / 0.36);
    const rvx = vB[0] - vA[0], rvy = vB[1] - vA[1], rvz = vB[2] - vA[2];
    vA[0] += (mB * dx * inv + (mB / mT) * w * rvx) * h;
    vA[1] += (mB * dy * inv + (mB / mT) * w * rvy) * h;
    vA[2] += (mB * dz * inv + (mB / mT) * w * rvz) * h;
    vB[0] += (-mA * dx * inv - (mA / mT) * w * rvx) * h;
    vB[1] += (-mA * dy * inv - (mA / mT) * w * rvy) * h;
    vB[2] += (-mA * dz * inv - (mA / mT) * w * rvz) * h;
    cA[0] += vA[0] * h; cA[1] += vA[1] * h; cA[2] += vA[2] * h;
    cB[0] += vB[0] * h; cB[1] += vB[1] * h; cB[2] += vB[2] * h;
  }

  function advance(pos, vel, cA, cB, mA, mB, e2, h) {
    const n = pos.length;
    const ax0 = cA[0], ay0 = cA[1], az0 = cA[2];
    const bx0 = cB[0], by0 = cB[1], bz0 = cB[2];
    const twoCores = mB > 0;
    for (let o = 0; o < n; o += 3) {
      const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
      if (px * px + py * py + pz * pz > 3600) continue;
      let dx = ax0 - px, dy = ay0 - py, dz = az0 - pz;
      let r2 = dx * dx + dy * dy + dz * dz + e2;
      let inv = mA / (r2 * Math.sqrt(r2));
      let ax = dx * inv, ay = dy * inv, az = dz * inv;
      if (twoCores) {
        dx = bx0 - px; dy = by0 - py; dz = bz0 - pz;
        r2 = dx * dx + dy * dy + dz * dz + e2;
        inv = mB / (r2 * Math.sqrt(r2));
        ax += dx * inv; ay += dy * inv; az += dz * inv;
      }
      const vx = vel[o] + ax * h, vy = vel[o + 1] + ay * h, vz = vel[o + 2] + az * h;
      vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
      pos[o] = px + vx * h; pos[o + 1] = py + vy * h; pos[o + 2] = pz + vz * h;
    }
  }

  /** Rotation taking local +Y (disc spin axis) to a tilted, roughly prograde axis (orbital L ∥ −Y), then the encounter yaw. */
  function discRotation(tilt, az, psi) {
    const s = [Math.sin(tilt) * Math.cos(az), -Math.cos(tilt), Math.sin(tilt) * Math.sin(az)];
    const axis = [s[2], 0, -s[0]];
    const len = Math.hypot(axis[0], axis[1], axis[2]);
    const tilted = math.mat4();
    if (len < 1e-6) math.rotationAxis(tilted, [1, 0, 0], s[1] < 0 ? Math.PI : 0);
    else math.rotationAxis(tilted, axis, Math.acos(clamp(s[1], -1, 1)));
    const G = math.rotationY(math.mat4(), psi);
    return math.multiply(math.mat4(), G, tilted);
  }

  function initGroup(local, count, outPos, outVel, rot, core, vcore, M, eps, R, dispersion) {
    const e2 = eps * eps;
    const p = [0, 0, 0], v = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const o = 3 * i;
      const x = local[o], y = local[o + 1], z = local[o + 2];
      const rc = Math.hypot(x, z);
      const r2 = x * x + y * y + z * z;
      const vc = Math.sqrt((M * rc * rc) / Math.pow(r2 + e2, 1.5));
      let lvx = rc > 1e-6 ? (vc * z) / rc : 0;
      let lvy = 0;
      let lvz = rc > 1e-6 ? (-vc * x) / rc : 0;
      const r = Math.sqrt(r2);
      if (dispersion && r < 0.25) {
        const s = 0.18 * Math.sqrt(M / Math.sqrt(r2 + e2)) * (1 - r / 0.25);
        lvx += util.gauss(R) * s;
        lvy += util.gauss(R) * s * 0.6;
        lvz += util.gauss(R) * s;
      }
      math.transformPoint(p, rot, x, y, z);
      math.transformPoint(v, rot, lvx, lvy, lvz);
      outPos[o] = p[0] + core[0]; outPos[o + 1] = p[1] + core[1]; outPos[o + 2] = p[2] + core[2];
      outVel[o] = v[0] + vcore[0]; outVel[o + 1] = v[1] + vcore[1]; outVel[o + 2] = v[2] + vcore[2];
    }
  }

  GLX.MergeSim = MergeSim;
})();
