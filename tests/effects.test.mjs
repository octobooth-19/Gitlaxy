// node --test tests/effects.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
for (const f of ['src/js/00-core.js', 'src/js/80-effects.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const { GLX } = globalThis;
const { GLOW, RING } = GLX.SPRITE;
const DT = 1 / 60;

/** Fake EffectsCtx: stars rotate slowly around their galaxy center; some indices can be "missing". */
function makeCtx({ moving = true, missing = new Set(), nan = new Set() } = {}) {
  const ctx = {
    time: 0, camDist: 2.9, galaxyRadius: 1,
    starPos(ref, out) {
      if (missing.has(ref.index)) return null;
      if (nan.has(ref.index)) { out[0] = NaN; out[1] = 0; out[2] = 0; return out; }
      const r = 0.2 + (ref.index % 10) * 0.08;
      const a = ref.index * 0.9 + (moving ? ctx.time * 0.3 : 0);
      out[0] = Math.cos(a) * r + ref.slot * 4;
      out[1] = 0.01 * (ref.index % 3);
      out[2] = Math.sin(a) * r;
      return out;
    },
    starSize(ref) { return 0.012 + (ref.index % 5) * 0.008; },
    galaxyCenter(slot, out) { out[0] = slot * 4; out[1] = 0; out[2] = 0; return out; }
  };
  return ctx;
}

function rig(opts) {
  const fx = new GLX.Effects();
  const ctx = makeCtx(opts);
  const sprites = new GLX.SpriteBuffer(256);
  const lines = new GLX.LineBuffer(256);
  const step = (n = 1, dt = DT, each) => {
    for (let i = 0; i < n; i++) {
      ctx.time += dt;
      fx.update(dt, ctx.time);
      sprites.reset();
      lines.reset();
      fx.emit(sprites, lines, ctx);
      assertFinite(sprites, lines);
      if (each) each(i);
    }
  };
  return { fx, ctx, sprites, lines, step };
}

function assertFinite(sprites, lines) {
  const sd = sprites.data, ld = lines.data;
  for (let i = 0; i < sprites.count * sprites.stride; i++) if (!Number.isFinite(sd[i])) assert.fail(`NaN/Inf in sprite ${Math.floor(i / sprites.stride)} field ${i % sprites.stride}`);
  for (let i = 0; i < lines.count * 14; i++) if (!Number.isFinite(ld[i])) assert.fail(`NaN/Inf in line ${Math.floor(i / 14)}`);
}

function spriteList(buf) {
  const out = [];
  for (let i = 0; i < buf.count; i++) {
    const d = buf.data, o = i * buf.stride;
    out.push({ x: d[o], y: d[o + 1], z: d[o + 2], size: d[o + 3], r: d[o + 4], g: d[o + 5], b: d[o + 6], a: d[o + 7], style: d[o + 8], p1: d[o + 9], p2: d[o + 10] });
  }
  return out;
}

function lineColorSum(lines) {
  let r = 0, g = 0;
  for (let i = 0; i < lines.count * 2; i++) {
    const o = i * 7;
    r += lines.data[o + 3] * lines.data[o + 6];
    g += lines.data[o + 4] * lines.data[o + 6];
  }
  return { r, g };
}

const ev = (kind, repo, i = 0) => ({ type: 'PushEvent', kind, repo, createdAt: 1e12 - i, label: kind + ' ' + repo, icon: '•' });

test('API surface matches the contract', () => {
  const fx = new GLX.Effects();
  for (const m of ['reset', 'setEvents', 'birth', 'burst', 'bolt', 'setSelected', 'setHovered', 'update', 'emit']) assert.equal(typeof fx[m], 'function', m);
  assert.equal(fx.cometsEnabled, false);
  assert.equal(fx.cometInterval, 1.8);
  assert.ok('onCometLaunch' in fx && 'onCometArrive' in fx);
});

test('birth emits flash + ring + sparkles, tracks the star, then expires', () => {
  const { fx, ctx, sprites, step } = rig();
  fx.birth({ slot: 0, index: 3 }, [1, 0.5, 0.2], 0.8);
  step(6);
  const list = spriteList(sprites);
  assert.ok(list.some((s) => s.style === RING), 'ring');
  assert.ok(list.filter((s) => s.style === GLOW).length >= 6, 'flash + sparkles');
  const ring = list.find((s) => s.style === RING);
  const p = ctx.starPos({ slot: 0, index: 3 }, [0, 0, 0]);
  assert.ok(Math.hypot(ring.x - p[0], ring.y - p[1], ring.z - p[2]) < 1e-6, 'ring centered on the moving star');
  const r0 = ring.size;
  step(30);
  const r1 = spriteList(sprites).find((s) => s.style === RING).size;
  assert.ok(r1 > r0 * 2, 'ring expands');
  step(60);
  assert.equal(sprites.count, 0, 'expired after ~1.2 s');
  assert.equal(fx.stats.births, 0);
});

test('birth strength scales the effect; bursts of births stay pooled', () => {
  const { fx, sprites, step } = rig({ moving: false });
  fx.birth({ slot: 0, index: 1 }, [1, 1, 1], 0);
  step(3);
  const weak = spriteList(sprites).reduce((m, s) => Math.max(m, s.size), 0);
  fx.reset();
  fx.birth({ slot: 0, index: 1 }, [1, 1, 1], 1);
  step(3);
  const strong = spriteList(sprites).reduce((m, s) => Math.max(m, s.size), 0);
  assert.ok(strong > weak * 1.4, `strong ${strong} > weak ${weak}`);
  fx.reset();
  for (let i = 0; i < 400; i++) fx.birth({ slot: 0, index: i % 50 }, [0.5, 0.8, 1], Math.random());
  step(1);
  assert.ok(fx.stats.births <= 128, 'ring buffer caps live births');
  assert.equal(fx._births.length, 128);
});

test('burst: shockwave rings at a fixed point, then expires', () => {
  const { fx, sprites, step } = rig();
  fx.burst([1, 2, 3], [0.2, 0.6, 1], 0.4);
  step(10);
  const list = spriteList(sprites);
  assert.ok(list.some((s) => s.style === RING && s.x === 1 && s.y === 2 && s.z === 3));
  assert.ok(list.some((s) => s.style === GLOW));
  step(80);
  assert.equal(sprites.count, 0);
  fx.burst(null, [1, 1, 1], 1);
  fx.burst([NaN, 0, 0], [1, 1, 1], 1);
  fx.burst([0, 0, 0], null, NaN);
  step(5);
  assert.equal(fx.stats.bursts, 1, 'invalid positions ignored, invalid color/size defaulted');
});

test('comets launch at the interval, cycle newest → oldest, own & external callbacks', () => {
  const { fx, step } = rig();
  const own = new Map([['mona/a', { slot: 0, index: 4 }], ['mona/b', { slot: 0, index: 7 }]]);
  const events = [ev('push', 'mona/a', 0), ev('pr', 'octo-org/warp-drive', 1), ev('star', 'Mona/B', 2)];
  const launches = [], arrivals = [];
  fx.onCometLaunch = (e, target) => launches.push({ e, target, at: fx._clock });
  fx.onCometArrive = (e, target, pos) => arrivals.push({ e, target, pos });
  fx.setEvents(events, own);
  step(120);
  assert.equal(launches.length, 0, 'disabled by default');
  fx.cometsEnabled = true;
  step(Math.round(12 / DT));
  // first after ~0.5 s, then every 1.8 s → 7 launches in 12 s
  assert.ok(launches.length >= 6 && launches.length <= 7, 'launch count ' + launches.length);
  for (let i = 1; i < launches.length; i++) {
    const gap = launches[i].at - launches[i - 1].at;
    assert.ok(gap > 1.75 && gap < 1.9, 'gap ' + gap);
  }
  assert.deepEqual(launches.slice(0, 4).map((l) => l.e), [events[0], events[1], events[2], events[0]], 'cycles newest → oldest');
  assert.equal(launches[0].target, own.get('mona/a'));
  assert.equal(launches[1].target, null, 'external repo → null target');
  assert.equal(launches[2].target, own.get('mona/b'), 'case-insensitive lookup');
  assert.ok(arrivals.length >= 4);
  const ownArr = arrivals.find((a) => a.target);
  const extArr = arrivals.find((a) => a.target === null);
  assert.ok(ownArr && extArr, 'both kinds arrive');
  for (const a of arrivals) assert.ok(Array.isArray(a.pos) && a.pos.length === 3 && a.pos.every(Number.isFinite));
  assert.ok(Math.hypot(extArr.pos[0], extArr.pos[1], extArr.pos[2]) > 2, 'external comet ends past the rim');
});

test('own comet strikes its (moving) star and leaves an impact burst', () => {
  const { fx, ctx, step } = rig();
  const arrivals = [];
  fx.onCometArrive = (e, target, pos) => arrivals.push({ target, pos, t: ctx.time });
  fx.setEvents([ev('push', 'mona/a')], new Map([['mona/a', { slot: 0, index: 5 }]]));
  fx.cometsEnabled = true;
  let burstsAfter = 0;
  step(Math.round(3.4 / DT), DT, () => {
    if (arrivals.length === 1 && !burstsAfter) burstsAfter = fx.stats.bursts;
  });
  assert.equal(arrivals.length, 1);
  const p = ctx.starPos({ slot: 0, index: 5 }, [0, 0, 0]);
  const ctxAtArrival = makeCtx();
  ctxAtArrival.time = arrivals[0].t;
  const q = ctxAtArrival.starPos({ slot: 0, index: 5 }, [0, 0, 0]);
  assert.ok(Math.hypot(arrivals[0].pos[0] - q[0], arrivals[0].pos[2] - q[2]) < 1e-9, 'impact at the star position of that frame');
  assert.ok(p, 'star exists');
  assert.ok(burstsAfter >= 1, 'impact burst');
});

test('comet trail grows to ~14 sprites; max 6 concurrent comets', () => {
  const { fx, step } = rig();
  fx.setEvents([ev('push', 'x/a'), ev('issue', 'mona/a')], new Map([['mona/a', { slot: 0, index: 2 }]]));
  fx.cometsEnabled = true;
  step(Math.round(0.5 / DT) + 2); // first launch
  assert.equal(fx.stats.comets, 1);
  step(Math.round(0.6 / DT));
  assert.equal(fx.stats.trail, 14, 'full trail');
  fx.reset();
  fx.cometInterval = 0.1;
  fx.setEvents([ev('push', 'x/a'), ev('issue', 'mona/a'), ev('fork', 'y/b')], new Map([['mona/a', { slot: 0, index: 2 }]]));
  let max = 0;
  step(Math.round(6 / DT), DT, () => { max = Math.max(max, fx.stats.comets); });
  assert.equal(max, 6, 'capped at 6');
});

test('comets skip events whose target star is unavailable', () => {
  const { fx, step } = rig({ missing: new Set([9]) });
  const launches = [];
  fx.onCometLaunch = (e) => launches.push(e.repo);
  fx.setEvents([ev('push', 'mona/gone'), ev('push', 'mona/ok')], new Map([['mona/gone', { slot: 0, index: 9 }], ['mona/ok', { slot: 0, index: 1 }]]));
  fx.cometsEnabled = true;
  step(Math.round(6 / DT));
  assert.ok(launches.length >= 2);
  assert.ok(launches.every((r) => r === 'mona/ok'));
});

test('setEvents mid-flight: old comets fade out silently, no stale callbacks', () => {
  const { fx, step } = rig();
  const arrivals = [];
  fx.onCometArrive = (e) => arrivals.push(e.repo);
  fx.setEvents([ev('push', 'mona/a')], new Map([['mona/a', { slot: 0, index: 2 }]]));
  fx.cometsEnabled = true;
  step(Math.round(1 / DT));
  assert.equal(fx.stats.comets, 1);
  fx.setEvents([], new Map());
  step(Math.round(4 / DT));
  assert.equal(arrivals.length, 0);
  assert.equal(fx.stats.comets, 0);
});

test('bolt: jagged lines, red/orange → green, expires; pool of 8', () => {
  const { fx, lines, sprites, step } = rig();
  fx.bolt({ slot: 0, index: 1 }, { slot: 1, index: 3 }, { duration: 2 });
  step(12);
  assert.ok(lines.count >= 20, 'channel + strand + branches: ' + lines.count);
  let c = lineColorSum(lines);
  assert.ok(c.r > c.g * 1.4, 'conflict = red/orange');
  step(Math.round(1.6 / DT) - 12);
  c = lineColorSum(lines);
  assert.ok(c.g > c.r * 1.5, 'resolved = green');
  assert.ok(spriteList(sprites).some((s) => s.style === RING), 'resolution pulse');
  step(Math.round(0.5 / DT));
  assert.equal(lines.count, 0);
  assert.equal(sprites.count, 0);
  for (let i = 0; i < 20; i++) fx.bolt({ slot: 0, index: i }, { slot: 1, index: i + 1 });
  step(2);
  assert.equal(fx.stats.bolts, 8);
  fx.reset();
  fx.bolt({ slot: 0, index: 2 }, { slot: 0, index: 2 }); // degenerate: same star
  fx.bolt({ slot: 0, index: 2 }, null);
  step(30);
});

test('bolt flicker regenerates ~12×/s and is deterministic', () => {
  const shapes = () => {
    const { fx, lines, step } = rig({ moving: false });
    fx.bolt({ slot: 0, index: 1 }, { slot: 0, index: 6 });
    const out = [];
    step(30, DT, () => out.push(lines.data[3 * 7 + 1] /* y of an interior vertex */));
    return out;
  };
  const a = shapes(), b = shapes();
  assert.deepEqual(a, b, 'deterministic');
  let changes = 0;
  for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1]) changes++;
  assert.ok(changes >= 4 && changes <= 8, 'changes in 0.5 s: ' + changes);
});

test('planets: count = 1 + floor(log2(forks+1)) (max 7), orbit, fade on deselect', () => {
  const sel = (forks, issues = 0, index = 3) => ({ ref: { slot: 0, index }, star: { size: 0.02, color: [0.3, 0.6, 1], repo: { fullName: 'mona/r' + index, forks, issues } } });
  const cases = [[0, 1], [1, 2], [2, 2], [3, 3], [7, 4], [15, 5], [40, 6], [63, 7], [5000, 7]];
  for (const [forks, n] of cases) {
    const { fx, step } = rig();
    fx.setSelected(sel(forks));
    step(30);
    assert.equal(fx.stats.planets, n, `forks ${forks}`);
  }
  const { fx, ctx, sprites, lines, step } = rig({ moving: false });
  fx.setSelected(sel(7, 3));
  step(40); // fully faded in
  const center = ctx.starPos({ slot: 0, index: 3 }, [0, 0, 0]);
  const planets = () => spriteList(sprites).filter((s) => s.style === GLOW && Math.abs(s.p1 - 0.85) < 1e-6);
  const before = planets();
  assert.equal(before.length, 4);
  assert.equal(lines.count, 4 * 48 + 24, 'orbit loops (48 segments each) + moon orbit');
  assert.ok(spriteList(sprites).some((s) => s.r === Math.fround(0.84)), 'moon for open issues');
  step(30);
  const after = planets();
  for (let k = 0; k < 4; k++) {
    const d0 = Math.hypot(before[k].x - center[0], before[k].y - center[1], before[k].z - center[2]);
    const d1 = Math.hypot(after[k].x - center[0], after[k].y - center[1], after[k].z - center[2]);
    assert.ok(Math.abs(d0 - d1) < 1e-4, 'circular orbit');
    assert.ok(Math.hypot(after[k].x - before[k].x, after[k].z - before[k].z) > 1e-4, 'planet moved');
    if (k) assert.ok(d1 > Math.hypot(before[k - 1].x - center[0], before[k - 1].y - center[1], before[k - 1].z - center[2]), 'radii grow outward');
  }
  // inner planets orbit faster (Kepler-ish)
  const ang = (s) => Math.atan2(s.z - center[2], s.x - center[0]);
  const dA = (k) => Math.abs(Math.atan2(Math.sin(ang(after[k]) - ang(before[k])), Math.cos(ang(after[k]) - ang(before[k]))));
  assert.ok(dA(0) > dA(3));
  fx.setSelected(sel(7, 3)); // same selection → no restart
  step(1);
  assert.equal(planets().length, 4);
  fx.setSelected(null);
  step(12);
  assert.ok(planets().length === 4 && planets()[0].a < 0.95 * 0.9, 'fading out');
  step(20);
  assert.equal(sprites.count, 0, 'gone after ~0.4 s');
  assert.equal(lines.count, 0);
});

test('switching selection cross-fades between systems', () => {
  const { fx, step } = rig();
  const s = (i, forks) => ({ ref: { slot: 0, index: i }, star: { size: 0.02, color: [1, 0.8, 0.3], repo: { fullName: 'a/' + i, forks } } });
  fx.setSelected(s(1, 0));
  step(30);
  fx.setSelected(s(2, 7));
  step(6);
  assert.equal(fx.stats.planets, 1 + 4, 'both visible mid-fade');
  step(30);
  assert.equal(fx.stats.planets, 4);
  for (let i = 0; i < 10; i++) fx.setSelected(s(i, i)); // rapid clicking stays within the pool
  step(60);
  assert.equal(fx._systems.length, 3);
});

test('hover ring fades in, pulses, fades out', () => {
  const { fx, sprites, step } = rig();
  fx.setHovered({ ref: { slot: 0, index: 2 }, star: { size: 0.03, color: [1, 0.4, 0.4] } });
  step(20);
  const rings = spriteList(sprites).filter((s) => s.style === RING);
  assert.equal(rings.length, 2);
  fx.setHovered(null);
  step(30);
  assert.equal(sprites.count, 0);
});

test('reset clears everything', () => {
  const { fx, sprites, lines, step } = rig();
  fx.birth({ slot: 0, index: 1 }, [1, 1, 1], 1);
  fx.burst([0, 0, 0], [1, 1, 1], 0.2);
  fx.bolt({ slot: 0, index: 1 }, { slot: 0, index: 2 });
  fx.setSelected({ ref: { slot: 0, index: 1 }, star: null });
  fx.setHovered({ ref: { slot: 0, index: 1 }, star: null });
  fx.setEvents([ev('push', 'z/z')], new Map());
  fx.cometsEnabled = true;
  step(60);
  fx.reset();
  step(1);
  assert.equal(sprites.count, 0);
  assert.equal(lines.count, 0);
});

test('robust to bad context data (null/NaN positions, throwing ctx) — never pushes NaN', () => {
  const { fx, ctx, step } = rig({ missing: new Set([1]), nan: new Set([2]) });
  ctx.starSize = (ref) => (ref.index === 3 ? NaN : 0.02);
  const realCenter = ctx.galaxyCenter;
  ctx.galaxyCenter = (slot, out) => (slot === 1 ? undefined : realCenter(slot, out));
  const throwing = { slot: 0, index: 77 };
  const sp = ctx.starPos;
  ctx.starPos = (ref, out) => { if (ref.index === 77) throw new Error('boom'); return sp(ref, out); };
  for (const i of [1, 2, 3, 77]) {
    fx.birth({ slot: 0, index: i }, [NaN, 1, 1], NaN);
    fx.bolt({ slot: 0, index: i }, { slot: 1, index: 4 });
    fx.setHovered({ ref: { slot: 0, index: i }, star: { size: NaN, color: null } });
  }
  fx.setSelected({ ref: throwing, star: { size: -1, repo: { forks: NaN, issues: 2 } } });
  fx.setEvents([ev('push', 'a/b'), ev('???', 'c/d'), null, ev('push', 'own/x')], new Map([['own/x', { slot: 1, index: 3 }]]));
  fx.cometsEnabled = true;
  ctx.camDist = NaN;
  step(Math.round(5 / DT)); // assertFinite runs every frame
  fx.update(NaN, NaN);
  fx.update(-1, 0);
  fx.update(1e9, 0);
  step(10);
});

test('soak: 10k frames of bursts without pool growth or leaks', () => {
  const { fx, step } = rig();
  const own = new Map();
  const events = [];
  for (let i = 0; i < 40; i++) {
    own.set('mona/r' + i, { slot: i % 2, index: i });
    events.push(ev(['push', 'pr', 'issue', 'star', 'release'][i % 5], i % 4 ? 'mona/r' + i : 'other/x' + i, i));
  }
  let arrivals = 0;
  fx.onCometArrive = () => arrivals++;
  fx.setEvents(events, own);
  fx.cometsEnabled = true;
  fx.cometInterval = 0.3;
  const sizes = () => [fx._births.length, fx._bursts.length, fx._comets.length, fx._bolts.length, fx._systems.length, fx._hovers.length,
    fx._sPos.length, fx._comets[0].hist.length, fx._events.length];
  const before = sizes();
  let maxSprites = 0, maxLines = 0;
  step(10000, DT, (i) => {
    for (let k = 0; k < 3; k++) fx.birth({ slot: 0, index: (i * 3 + k) % 40 }, [0.4, 0.7, 1], ((i + k) % 10) / 10);
    if (i % 10 === 0) fx.burst([Math.sin(i), 0, Math.cos(i)], [1, 0.6, 0.3], 0.3);
    if (i % 90 === 0) fx.bolt({ slot: 0, index: i % 40 }, { slot: 1, index: (i + 7) % 40 });
    if (i % 400 === 0) fx.setSelected(i % 800 ? null : { ref: { slot: 0, index: i % 40 }, star: { size: 0.02, color: [1, 1, 1], repo: { forks: i % 100, issues: 1 } } });
    if (i % 7 === 0) fx.setHovered(i % 14 ? null : { ref: { slot: 1, index: i % 40 }, star: null });
    maxSprites = Math.max(maxSprites, fx.stats.sprites);
    maxLines = Math.max(maxLines, fx.stats.lines);
  });
  assert.deepEqual(sizes(), before, 'internal arrays never grow');
  assert.ok(arrivals > 200, 'comets kept flowing: ' + arrivals);
  assert.ok(fx.stats.births <= 128 && fx.stats.bolts <= 8 && fx.stats.comets <= 6);
  assert.ok(maxSprites < 2500, 'sprite budget ' + maxSprites);
  assert.ok(maxLines < 2500, 'line budget ' + maxLines);
});
