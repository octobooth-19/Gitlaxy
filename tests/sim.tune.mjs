// Gitlaxy sim tuning harness: node tests/sim.tune.mjs [outDir]
// Builds two galaxies, runs the merge, prints the timeline/perf and renders PNG snapshots from the merge camera.
import vm from 'node:vm';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

globalThis.window = globalThis;
for (const f of ['src/js/00-core.js', 'src/js/20-model.js', 'src/js/35-camera.js', 'src/js/40-sim.js']) {
  vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: f });
}
const { GLX } = globalThis;
const outDir = process.argv[2] || '/tmp/glx-sim';
fs.mkdirSync(outDir, { recursive: true });

function fakeUser(login, langs, n, seed) {
  const R = GLX.util.rng(seed);
  const now = Date.now();
  const repos = [];
  for (let i = 0; i < n; i++) {
    const created = now - (R() ** 0.7) * 10 * 365 * 864e5;
    repos.push({
      name: (i % 17 === 0 ? ['dotfiles', 'blog', 'hello-world', 'advent-of-code'][i % 4] : login + '-repo-' + i),
      fullName: login + '/r' + i, description: '', language: langs[Math.floor(R() * langs.length)],
      stars: Math.floor(Math.exp(GLX.util.gauss(R) * 1.6 + 1)), forks: Math.floor(R() * 5), issues: 0,
      createdAt: created, pushedAt: created + R() * (now - created), url: '', homepage: '', topics: [], license: null,
      isFork: R() < 0.1, isArchived: false, size: 100
    });
  }
  return { profile: { login, name: login, avatarUrl: null, bio: '', url: '', createdAt: now - 11 * 365 * 864e5, publicRepos: n, followers: 1, following: 1, type: 'User', id: 1, isDemo: true }, repos, events: [], source: 'demo', truncated: false, fetchedAt: now };
}

const N = Number(process.env.N || 14000);
const gA = GLX.Model.build(fakeUser('mona', ['JavaScript', 'TypeScript', 'Ruby', 'Go'], 110, 1), { particleCount: N });
const gB = GLX.Model.build(fakeUser('hubot', ['CoffeeScript', 'Python', 'Shell'], 70, 2), { particleCount: N });
let t0 = performance.now();
const sim = new GLX.MergeSim(gA, gB, JSON.parse(process.env.OPTS || "{}"));
console.log(`init ${(performance.now() - t0).toFixed(1)} ms · friction=${sim.friction.toFixed(3)} · predicted merge t=${sim.mergeTime.toFixed(2)} · masses=${sim.M.map((m) => m.toFixed(2))}`);

// --- PNG helpers
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePNG(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const W = 640, H = 400;
const cam = new GLX.Camera(null);
function render(file, label) {
  const d = sim.coreDistance;
  cam.setGoal({ yaw: 0.45, pitch: 0.95, dist: Math.min(10, Math.max(4.2, 3.8 + d * 1.0)), target: [0, 0, 0] }, { instant: true });
  cam.computeMatrices(W, H);
  const acc = new Float32Array(W * H * 3);
  const out = { x: 0, y: 0, depth: 0, visible: false };
  const splat = (pos, colors, count, gain) => {
    for (let i = 0; i < count; i++) {
      cam.project(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], out);
      if (!out.visible) continue;
      const x = out.x | 0, y = out.y | 0;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const k = (y * W + x) * 3;
      const a = (colors ? colors[4 * i + 3] : 1) * gain;
      acc[k] += (colors ? colors[4 * i] : 1) * a; acc[k + 1] += (colors ? colors[4 * i + 1] : 0.9) * a; acc[k + 2] += (colors ? colors[4 * i + 2] : 0.6) * a;
    }
  };
  splat(sim.partPos[0], gA.particles.color, gA.particles.count, 1);
  splat(sim.partPos[1], gB.particles.color, gB.particles.count, 1);
  const red = new Float32Array(4 * gA.stars.length).fill(1);
  splat(sim.starPos[0], null, gA.stars.length, 4);
  splat(sim.starPos[1], null, gB.stars.length, 4);
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) rgb[i] = Math.round(255 * (1 - Math.exp(-acc[i] * 1.6)));
  writePNG(file, W, H, rgb);
  console.log(`  snapshot ${label} → ${file}`);
}

const snaps = (process.env.SNAPS || '0,5,9,13,18,merged+4').split(',');
const dt = 1 / 60;
let frames = 0, stepMs = 0, maxStep = 0, mergedAt = null, nanFound = false;
const timeline = [];
render(path.join(outDir, 'snap-00.png'), 't=0');
let snapIdx = 1;
while (sim.time < 60) {
  const s = performance.now();
  const ev = sim.step(dt);
  const e = performance.now() - s;
  stepMs += e; maxStep = Math.max(maxStep, e); frames++;
  for (const x of ev) timeline.push(`${sim.time.toFixed(2)} ${x} (d=${sim.coreDistance.toFixed(2)})`);
  if (sim.merged && mergedAt == null) mergedAt = sim.time;
  const next = snaps[snapIdx];
  if (next) {
    const target = next.startsWith('merged+') ? (mergedAt != null ? mergedAt + Number(next.slice(7)) : Infinity) : Number(next);
    if (sim.time >= target) { render(path.join(outDir, `snap-${String(snapIdx).padStart(2, '0')}.png`), `t=${sim.time.toFixed(1)} ${sim.phase}`); snapIdx++; }
  }
  if (mergedAt != null && sim.time > mergedAt + 6 && snapIdx >= snaps.length) break;
}
for (const arr of [...sim.partPos, ...sim.starPos]) for (const v of arr) if (!Number.isFinite(v)) { nanFound = true; break; }
let far = 0, total = 0;
for (const arr of sim.partPos) for (let i = 0; i < arr.length; i += 3) { total++; if (Math.hypot(arr[i], arr[i + 1], arr[i + 2]) > 2.5) far++; }
console.log(timeline.join('\n'));
console.log(`merged at t=${mergedAt?.toFixed(2)} · avg step ${(stepMs / frames).toFixed(2)} ms · max ${maxStep.toFixed(2)} ms · NaN=${nanFound} · particles beyond r>2.5: ${(100 * far / total).toFixed(1)}%`);
