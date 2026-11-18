/* Gitlaxy — 35-camera.js
 * Cinematic orbit camera: damped goals, eased flights, star following, inertia, auto-orbit, shake,
 * and pointer/wheel/pinch input. Also projects world points to CSS pixels for picking and labels.
 */
(() => {
  'use strict';
  const GLX = window.GLX;
  const { util, math } = GLX;
  const { clamp, easeInOutCubic } = util;

  const TAU = Math.PI * 2;
  const PITCH_MIN = -1.45, PITCH_MAX = 1.45;
  const UP = [0, 1, 0];
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const wrapAngle = (a) => {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  };

  class Camera {
    constructor(canvas) {
      this.canvas = canvas || null;
      this.yaw = 0.6;
      this.pitch = 0.72;
      this.dist = 2.9;
      this.target = [0, 0, 0];
      this.fov = (50 * Math.PI) / 180;
      this.near = 0.01;
      this.far = 400;
      this.minDist = 0.12;
      this.maxDist = 16;
      this.autoOrbit = true;
      this.autoOrbitSpeed = 0.035;
      this.idleDelay = 4000;
      this.inputEnabled = true;
      this.isDragging = false;
      this.lastInteraction = 0;
      this.onClick = null;
      this.onHover = null;
      this.onLeave = null;
      this.onInteract = null;

      this.goal = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: [0, 0, 0] };
      this.flight = null;
      this._vel = { yaw: 0, pitch: 0 };
      this._orbitRamp = 0;
      this._shake = 0;
      this._shakeT = 0;
      this._pointers = new Map();
      this._drag = null;
      this._pinch = null;
      this._lastTap = 0;
      this._w = 1;
      this._h = 1;
      this._center = [0, 0, 0];
      this.proj = math.mat4();
      this.view = math.mat4();
      this.viewProj = math.mat4();
      this.eye = [0, 0, 0];
      this._matrices = { proj: this.proj, view: this.view, viewProj: this.viewProj, eye: this.eye };
      this._projOut = { x: 0, y: 0, depth: 0, visible: false };
      this._listeners = [];
      this._reduced = false;
      try { this._reduced = util.prefersReducedMotion(); } catch (e) { this._reduced = false; }
      this._attach();
    }

    // ---------------------------------------------------------------- goals & flights
    setGoal(g, opts) {
      g = g || {};
      opts = opts || {};
      const base = this.flight ? this.flight.to : this.goal;
      const to = {
        yaw: g.yaw != null ? g.yaw : base.yaw,
        pitch: g.pitch != null ? clamp(g.pitch, PITCH_MIN, PITCH_MAX) : base.pitch,
        dist: g.dist != null ? clamp(g.dist, this.minDist, this.maxDist) : base.dist,
        target: g.target ? [g.target[0], g.target[1], g.target[2]] : base.target.slice()
      };
      if (opts.instant || (opts.duration > 0 && this._reduced)) {
        this.flight = null;
        this.yaw = to.yaw; this.pitch = to.pitch; this.dist = to.dist;
        this._copy(this.target, to.target);
        this._setGoalValues(to);
        this._vel.yaw = 0; this._vel.pitch = 0;
        return;
      }
      if (opts.duration > 0) {
        to.yaw = this.yaw + wrapAngle(to.yaw - this.yaw);
        this.flight = {
          t: 0,
          duration: opts.duration,
          from: { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: this.target.slice() },
          to
        };
        this._setGoalValues(to);
        this._vel.yaw = 0; this._vel.pitch = 0;
        return;
      }
      if (g.yaw != null) to.yaw = this.yaw + wrapAngle(to.yaw - this.yaw);
      if (this.flight) {
        // Adjust the destination of the in-progress flight rather than cancelling it.
        const f = this.flight.to;
        f.yaw = to.yaw; f.pitch = to.pitch; f.dist = to.dist; this._copy(f.target, to.target);
      }
      this._setGoalValues(to);
    }

    follow(t) {
      if (!t) return;
      if (this.flight) this._copy(this.flight.to.target, t);
      this._copy(this.goal.target, t);
    }

    nudge(dYaw, dPitch, zoomFactor) {
      if (!this.inputEnabled) return;
      this._cancelFlight();
      this.goal.yaw += dYaw || 0;
      this.goal.pitch = clamp(this.goal.pitch + (dPitch || 0), PITCH_MIN, PITCH_MAX);
      if (zoomFactor && zoomFactor > 0) this.goal.dist = clamp(this.goal.dist * zoomFactor, this.minDist, this.maxDist);
      this._markInteract();
    }

    shake(intensity) {
      if (this._reduced) return;
      this._shake = Math.min(1.5, this._shake + Math.max(0, intensity || 0));
    }

    update(dt) {
      dt = Math.max(0, Math.min(dt || 0, 0.1));
      if (this.flight) {
        const f = this.flight;
        f.t += dt;
        const u = f.duration > 0 ? Math.min(1, f.t / f.duration) : 1;
        const e = easeInOutCubic(u);
        this.yaw = f.from.yaw + (f.to.yaw - f.from.yaw) * e;
        this.pitch = f.from.pitch + (f.to.pitch - f.from.pitch) * e;
        this.dist = Math.exp(Math.log(f.from.dist) + (Math.log(f.to.dist) - Math.log(f.from.dist)) * e);
        for (let i = 0; i < 3; i++) this.target[i] = f.from.target[i] + (f.to.target[i] - f.from.target[i]) * e;
        if (u >= 1) {
          this.flight = null;
          this._setGoalValues(f.to);
        }
      } else {
        if (!this.isDragging && (Math.abs(this._vel.yaw) > 1e-4 || Math.abs(this._vel.pitch) > 1e-4)) {
          this.goal.yaw += this._vel.yaw * dt;
          this.goal.pitch = clamp(this.goal.pitch + this._vel.pitch * dt, PITCH_MIN, PITCH_MAX);
          const decay = Math.exp(-dt * 3.2);
          this._vel.yaw *= decay;
          this._vel.pitch *= decay;
        }
        const kA = 1 - Math.exp(-dt * 7);
        const kD = 1 - Math.exp(-dt * 6);
        const kT = 1 - Math.exp(-dt * 5);
        this.yaw += (this.goal.yaw - this.yaw) * kA;
        this.pitch += (this.goal.pitch - this.pitch) * kA;
        this.dist = Math.exp(Math.log(this.dist) + (Math.log(this.goal.dist) - Math.log(this.dist)) * kD);
        for (let i = 0; i < 3; i++) this.target[i] += (this.goal.target[i] - this.target[i]) * kT;
      }
      const idle = !this.isDragging && !this._pointers.size && now() - this.lastInteraction > this.idleDelay;
      const want = this.autoOrbit && idle && !this._reduced ? 1 : 0;
      this._orbitRamp += (want - this._orbitRamp) * (1 - Math.exp(-dt * 0.8));
      if (this._orbitRamp > 1e-3) {
        const d = this.autoOrbitSpeed * this._orbitRamp * dt;
        this.goal.yaw += d;
        if (this.flight) {
          this.flight.to.yaw += d;
          this.flight.from.yaw += d;
        }
      }
      if (this._shake > 0) {
        this._shakeT += dt;
        this._shake *= Math.exp(-dt * 3.5);
        if (this._shake < 1e-3) this._shake = 0;
      }
    }

    computeMatrices(width, height) {
      this._w = Math.max(1, width || 1);
      this._h = Math.max(1, height || 1);
      let tx = this.target[0], ty = this.target[1], tz = this.target[2];
      if (this._shake > 0) {
        const s = this._shake * this.dist * 0.012;
        const t = this._shakeT * 37;
        tx += s * (Math.sin(t * 1.31) + 0.5 * Math.sin(t * 2.97 + 0.7));
        ty += s * (Math.sin(t * 1.73 + 1.2) + 0.5 * Math.sin(t * 3.41 + 2.1));
        tz += s * (Math.sin(t * 1.19 + 2.5) + 0.5 * Math.sin(t * 2.63 + 0.3));
      }
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      this.eye[0] = tx + this.dist * cp * Math.sin(this.yaw);
      this.eye[1] = ty + this.dist * sp;
      this.eye[2] = tz + this.dist * cp * Math.cos(this.yaw);
      this._center[0] = tx; this._center[1] = ty; this._center[2] = tz;
      math.perspective(this.proj, this.fov, this._w / this._h, this.near, this.far);
      math.lookAt(this.view, this.eye, this._center, UP);
      math.multiply(this.viewProj, this.proj, this.view);
      return this._matrices;
    }

    project(x, y, z, out) {
      const o = out || this._projOut;
      const m = this.viewProj;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      o.depth = cw;
      if (!(cw > this.near)) {
        o.x = -1e5; o.y = -1e5; o.visible = false;
        return o;
      }
      o.x = (cx / cw * 0.5 + 0.5) * this._w;
      o.y = (0.5 - cy / cw * 0.5) * this._h;
      o.visible = o.x > -40 && o.x < this._w + 40 && o.y > -40 && o.y < this._h + 40;
      return o;
    }

    dispose() {
      const c = this.canvas;
      if (c && typeof c.removeEventListener === 'function') {
        for (const [type, fn, opts] of this._listeners) c.removeEventListener(type, fn, opts);
      }
      this._listeners.length = 0;
      this._pointers.clear();
    }

    // ---------------------------------------------------------------- internals
    _copy(dst, src) {
      dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2];
    }

    _setGoalValues(v) {
      this.goal.yaw = v.yaw;
      this.goal.pitch = v.pitch;
      this.goal.dist = v.dist;
      this._copy(this.goal.target, v.target);
    }

    _cancelFlight() {
      if (!this.flight) return;
      this.flight = null;
      this.goal.yaw = this.yaw;
      this.goal.pitch = this.pitch;
      this.goal.dist = this.dist;
    }

    _markInteract() {
      const t = now();
      const starting = t - this.lastInteraction > 250;
      this.lastInteraction = t;
      if (starting && typeof this.onInteract === 'function') this.onInteract();
    }

    _local(e) {
      const c = this.canvas;
      const r = c && c.getBoundingClientRect ? c.getBoundingClientRect() : { left: 0, top: 0 };
      return [(e.clientX || 0) - r.left, (e.clientY || 0) - r.top];
    }

    _attach() {
      const c = this.canvas;
      if (!c || typeof c.addEventListener !== 'function') return;
      const on = (type, fn, opts) => {
        c.addEventListener(type, fn, opts);
        this._listeners.push([type, fn, opts]);
      };
      on('pointerdown', (e) => this._down(e));
      on('pointermove', (e) => this._move(e));
      on('pointerup', (e) => this._up(e, false));
      on('pointercancel', (e) => this._up(e, true));
      on('pointerleave', () => {
        if (!this._pointers.size && typeof this.onLeave === 'function') this.onLeave();
      });
      on('wheel', (e) => this._wheel(e), { passive: false });
      on('contextmenu', (e) => e.preventDefault());
      on('dblclick', (e) => {
        if (!this.inputEnabled) return;
        e.preventDefault();
        this._zoomIn();
      });
    }

    _down(e) {
      if (!this.inputEnabled) return;
      const [x, y] = this._local(e);
      this._pointers.set(e.pointerId, { x, y });
      try { if (this.canvas.setPointerCapture) this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (this._pointers.size === 1) {
        const pan = e.button === 2 || e.button === 1 || e.shiftKey;
        const t = now();
        this._drag = { mode: pan ? 'pan' : 'orbit', x, y, sx: x, sy: y, t, lastT: t, moved: false, button: e.button };
        this._vel.yaw = 0;
        this._vel.pitch = 0;
      } else if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        if (this._drag) this._drag.moved = true;
        this._cancelFlight();
        this.isDragging = true;
        this._markInteract();
      }
    }

    _move(e) {
      const [x, y] = this._local(e);
      const p = this._pointers.get(e.pointerId);
      if (!p) {
        if (this.inputEnabled && typeof this.onHover === 'function') this.onHover(x, y);
        return;
      }
      p.x = x;
      p.y = y;
      if (!this.inputEnabled) return;
      if (this._pointers.size >= 2 && this._pinch) {
        const [a, b] = [...this._pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        if (d > 1 && this._pinch.d > 1) this.goal.dist = clamp(this.goal.dist * (this._pinch.d / d), this.minDist, this.maxDist);
        this._panBy(cx - this._pinch.cx, cy - this._pinch.cy);
        this._pinch.d = d; this._pinch.cx = cx; this._pinch.cy = cy;
        this._markInteract();
        return;
      }
      const dr = this._drag;
      if (!dr) return;
      if (!dr.moved) {
        if (Math.hypot(x - dr.sx, y - dr.sy) < 6) return;
        dr.moved = true;
        this.isDragging = true;
        this._cancelFlight();
        dr.x = x; dr.y = y;
        this._markInteract();
      }
      const dx = x - dr.x, dy = y - dr.y;
      const t = now();
      const dts = Math.max(8, t - dr.lastT) / 1000;
      if (dr.mode === 'orbit') {
        const rs = 0.0055;
        const dYaw = -dx * rs, dPitch = dy * rs;
        this.goal.yaw += dYaw;
        this.goal.pitch = clamp(this.goal.pitch + dPitch, PITCH_MIN, PITCH_MAX);
        this._vel.yaw = this._vel.yaw * 0.55 + (dYaw / dts) * 0.45;
        this._vel.pitch = this._vel.pitch * 0.55 + (dPitch / dts) * 0.45;
      } else {
        this._panBy(dx, dy);
      }
      dr.x = x; dr.y = y; dr.lastT = t;
      this._markInteract();
    }

    _up(e, cancelled) {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.delete(e.pointerId);
      try { if (this.canvas.releasePointerCapture) this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (this._pointers.size >= 1) {
        const rem = [...this._pointers.values()][0];
        const t = now();
        this._pinch = null;
        this._drag = { mode: 'orbit', x: rem.x, y: rem.y, sx: rem.x, sy: rem.y, t, lastT: t, moved: true, button: 0 };
        this._vel.yaw = 0;
        this._vel.pitch = 0;
        return;
      }
      this._pinch = null;
      const dr = this._drag;
      this._drag = null;
      const wasDragging = this.isDragging;
      this.isDragging = false;
      if (!dr || cancelled) {
        this._vel.yaw = 0; this._vel.pitch = 0;
        return;
      }
      if (!dr.moved && now() - dr.t < 500 && (dr.button === 0 || dr.button == null)) {
        const [x, y] = this._local(e);
        if (e.pointerType === 'touch') {
          const t = now();
          if (t - this._lastTap < 300) {
            this._lastTap = 0;
            this._zoomIn();
            return;
          }
          this._lastTap = t;
        }
        if (typeof this.onClick === 'function') this.onClick(x, y, e);
        return;
      }
      if (wasDragging) {
        if (this._reduced || now() - dr.lastT > 90) {
          this._vel.yaw = 0; this._vel.pitch = 0;
        } else {
          this._vel.yaw = clamp(this._vel.yaw, -6, 6);
          this._vel.pitch = clamp(this._vel.pitch, -4, 4);
        }
      }
    }

    _wheel(e) {
      if (!this.inputEnabled) return;
      if (e.cancelable) e.preventDefault();
      let dy = e.deltaY || 0;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= this._h || 800;
      const k = e.ctrlKey ? 0.01 : 0.0015;
      this._cancelFlight();
      this.goal.dist = clamp(this.goal.dist * Math.exp(clamp(dy * k, -1, 1)), this.minDist, this.maxDist);
      this._markInteract();
    }

    _zoomIn() {
      this._markInteract();
      this.setGoal({ dist: this.goal.dist * 0.6 }, { duration: 0.6 });
    }

    _panBy(dx, dy) {
      const wpp = (2 * this.goal.dist * Math.tan(this.fov / 2)) / Math.max(1, this._h);
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
      const mx = -dx * wpp, my = dy * wpp;
      const t = this.goal.target;
      t[0] += cy * mx + -sp * sy * my;
      t[1] += cp * my;
      t[2] += -sy * mx + -sp * cy * my;
      const len = Math.hypot(t[0], t[1], t[2]);
      if (len > 12) { t[0] *= 12 / len; t[1] *= 12 / len; t[2] *= 12 / len; }
    }
  }

  GLX.Camera = Camera;
})();
