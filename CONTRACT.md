# Gitlaxy — Build Contract (binding spec for all engineers)

Project root: `/Users/octodemo/.copilot/chats/2026-11-18/jubilant-tribble-89b38001/gitlaxy`

## 1. Vision

**Gitlaxy turns any GitHub user into a living 3D galaxy in the browser.** Built for a GitHub hackathon — the quality bar is *hackathon-winning polish*: gorgeous, smooth (60 fps), delightful, zero console errors.

- Every **repository is a star**: color = language, size/brightness = stargazers, gentle pulse = pushed recently, dim satellite = fork, grey/dim = archived.
- Every **top language is a spiral arm** (arm color = language color). **Radius is time**: oldest repos near the core, newest at the rim.
- On launch a **"Big Bang" replay** animates the galaxy forming chronologically (timeline scrubber), with generative music — each star birth plays a note.
- Recent public activity (GitHub events) flies in as **comets** that strike the repo they touched (or fly out of the galaxy for contributions to other people's repos), with a small activity ticker.
- Click a star → camera flies to it; **planets (forks) orbit it**; a glass card shows repo details.
- **`git merge` mode**: two usernames → their galaxies **collide in a real gravitational simulation** (Toomre & Toomre-style restricted N-body + dynamical friction): tidal tails, **merge conflicts** (same-named repos zap each other with lightning, then auto-resolve ✓), a merged elliptical remnant, a summary ("Merge made by the 'gravity' strategy.") and a poster.
- **Export a shareable 1200×1500 PNG poster.**
- Works offline with deterministic **demo galaxies @mona and @hubot** (synthetic data).

Tone: playful astronomy × git puns. Examples: "Every repo is a star. Every language, a spiral arm.", "git merge two galaxies", "Merge made by the 'gravity' strategy.", "CONFLICT (gravity): Merge conflict in dotfiles", "Auto-resolved ✓".

## 2. Hard constraints

- **Zero dependencies.** No npm/npx/yarn/pnpm/pip/uv, no CDNs, no web fonts, no remote images except GitHub avatars. Plain ES2020 JS, WebGL1, WebAudio, Canvas2D, DOM.
- The deliverable is ONE file `index.html` produced by `node build.mjs`, which inlines `src/css/*.css` (sorted by name) and `src/js/*.js` (sorted by name) into `src/shell.html`. It must work from `file://`.
- Runtime network: only `https://api.github.com` (unauthenticated by default; optional token in sessionStorage) and avatar images.
- Each JS file is ONE IIFE with `'use strict'`, communicating only through `window.GLX`. **No side effects at load** besides defining things on `GLX` (no DOM queries, listeners, timers or AudioContext at load). `src/js/90-app.js` (coordinator) calls init functions on DOMContentLoaded.
- Never put untrusted text (repo names, descriptions, bios, event labels, logins) into `innerHTML`. Use `textContent` or `GLX.util.el` (string children are safe text). `innerHTML`/`html:` is fine for static markup such as `GLX.icon()`.
- Hot paths (anything per frame) must not allocate (reuse typed arrays / objects) and must not thrash layout (only write DOM/styles when values change).
- Respect `prefers-reduced-motion` where relevant.
- Comment sparingly (only non-obvious logic).

## 3. File ownership — only touch your own files

| File | Owner | Exposes |
|---|---|---|
| `src/js/00-core.js` | coordinator (DONE — read it, don't edit) | `GLX.config, GLX.util, GLX.math, GLX.color, GLX.bus, GLX.SpriteBuffer, GLX.LineBuffer, GLX.SPRITE, GLX.EVENT_COLORS, GLX.icon` |
| `src/js/10-data.js` | **data** | `GLX.Data` |
| `src/js/20-model.js` | **model** | `GLX.Model` |
| `src/js/30-renderer.js` | **renderer** | `GLX.Renderer` |
| `src/js/35-camera.js` | **camera** | `GLX.Camera` |
| `src/js/40-sim.js` | **sim** | `GLX.MergeSim` |
| `src/js/50-audio.js` | **audio** | `GLX.Audio` |
| `src/js/60-ui-hud.js`, `src/css/60-hud.css` | **hud** | `GLX.HUD` |
| `src/js/65-ui-chrome.js`, `src/css/65-chrome.css` | **chrome** | `GLX.Chrome` |
| `src/js/70-poster.js` | **poster** | `GLX.Poster` |
| `src/js/80-effects.js` | **effects** | `GLX.Effects` |
| `src/js/90-app.js`, `src/shell.html`, `src/css/00-base.css`, `build.mjs`, README | coordinator | wiring |

You may additionally create files ONLY named `dev/<yourmodule>*` and `tests/<yourmodule>*`. Never edit anyone else's file — 10 engineers work concurrently.

## 4. Coordinates, units, time

- Right-handed, **Y up**. Each galaxy is built in LOCAL coords centered at the origin, **disc in the XZ plane**, thin in Y. Stars lie within r ≤ 1.0; diffuse halo particles may reach r ≈ 1.3.
- Single-galaxy mode: app rotates the galaxy about +Y: `GLX.math.rotationY(model, time * GLX.config.ROTATION_SPEED)`; world = model × local.
- Merge mode: `GLX.MergeSim` owns WORLD positions (model = identity).
- Camera default: target `[0,0,0]`, yaw `0.6`, pitch `0.72` rad (looking down ≈41°), dist `2.9`, fov 50°.
- Matrices: column-major `Float32Array(16)`, gl-matrix conventions (`GLX.math`).
- `time` = seconds since app start (float). All timestamps in data = epoch **milliseconds** (numbers).
- `StarRef = { slot: 0|1, index: number }` — slot = galaxy slot (single mode: always 0; merge: 0 = A, 1 = B).

## 5. Shared data shapes

```ts
type Profile = { login: string, name: string, avatarUrl: string|null, bio: string, url: string,
  createdAt: number, publicRepos: number, followers: number, following: number,
  type: 'User'|'Organization', id: number|null, isDemo: boolean }

type Repo = { name: string, fullName: string, description: string, language: string|null,
  stars: number, forks: number, issues: number, createdAt: number, pushedAt: number,
  url: string, homepage: string, topics: string[], license: string|null,
  isFork: boolean, isArchived: boolean, size: number }

type GHEvent = { type: string /* raw, e.g. 'PushEvent' */,
  kind: 'push'|'pr'|'issue'|'comment'|'star'|'create'|'fork'|'release'|'review'|'other',
  repo: string /* 'owner/name' */, createdAt: number,
  label: string /* e.g. 'Pushed 3 commits to main', 'Opened PR: Fix the warp drive' */,
  icon: string /* one emoji: ⬆️ 🔀 🐛 💬 ⭐ ✨ 🍴 🚀 👀 • */ }

type UserData = { profile: Profile, repos: Repo[], events: GHEvent[] /* newest first */,
  source: 'api'|'cache'|'demo', truncated: boolean, fetchedAt: number }

type Star = {
  index: number,                    // === position in galaxy.stars
  repo: Repo,
  pos: [number, number, number],    // LOCAL position
  color: [number, number, number],  // 0..1, GLX.color.langColor(repo.language)
  size: number,                     // world half-size of star sprite: 0.010 + 0.0085*log10(stars+1); forks ×0.65
  birth: number,                    // 0..1 = (createdAt - t0)/(t1 - t0): appearance time in the Big Bang replay
  activity: number,                 // 1 if pushed ≤30 days ago, 0.5 if ≤180 days, else 0
  arm: number, lang: string,        // lang = repo.language || 'Other'
  isFork: boolean, isArchived: boolean,
  labelPriority: number             // higher = more label-worthy (stars + recency); 0 for forks
}

type Galaxy = {
  user: UserData, profile: Profile, seed: number,
  t0: number, t1: number,           // timeline: min(profile.createdAt, first repo createdAt) → fetchedAt/now
  radius: number,                   // 1.0
  arms: { lang: string, color: [r,g,b], angle: number, share: number }[],          // 2..6 arms
  langs: { lang: string, count: number, share: number, color: [r,g,b], stars: number }[], // desc by count
  stars: Star[],                    // sorted by createdAt ascending
  particles: { count: number,
    pos: Float32Array,   // 3*count, LOCAL
    color: Float32Array, // 4*count rgba 0..1 (a = base brightness)
    meta: Float32Array   // 3*count: size (0.6..4.0, typical 1.5), birth (0..1), seed (0..1)
  },
  nebulae: { pos: [x,y,z], size: number /*0.15..0.45*/, color: [r,g,b], alpha: number /*0.04..0.12*/, birth: number, seed: number }[],
  constellations: [number, number][], // star-index pairs: MST edges within each language (non-fork stars)
  stats: { repos, ownRepos, forkRepos, stars, forksReceived, languages, active90d, ageYears, firstYear, topLang, topShare, archived },
  classification: { id: string, name: string, emoji: string, blurb: string },
  designation: string,              // 'GLX-4821'
  facts: { id: string, label: string, text: string, value: string, starIndex: number }[]
}

type MergeSummary = {
  a: Profile, b: Profile, totalRepos: number, totalStars: number, languages: number,
  sharedLangs: string[],
  conflicts: { name: string, a: number /*star index in A*/, b: number /*star index in B*/ }[],
  classification: { id, name, emoji, blurb }, commitSha: string /*7 hex*/, designation: string
}
```

## 6. Core (`src/js/00-core.js`) — use it, don't duplicate it

`GLX.config` (constants), `GLX.util` (clamp, lerp, smoothstep, easing, hashStr, rng(seed)→PRNG, gauss(rng), pick, weightedIndex, toMs, fmtNum, fmtDate, fmtDateLong, timeAgo, el, esc, storage(.session), prefersReducedMotion, isMobile, sleep), `GLX.math` (mat4, identity, perspective, lookAt, multiply, rotationAxis, rotationY, translation, transformPoint, transformVec4, v3.*), `GLX.color` (LANG_COLORS, langColor, langColorHex, rgbToCss, hexToRgb, rgbToHex, hsl helpers, mix, OTHER_COLOR), `GLX.EVENT_COLORS[kind]`, `GLX.bus` (on/off/emit), `GLX.SPRITE` enum, `GLX.SpriteBuffer`, `GLX.LineBuffer`, `GLX.icon(name, size)` (names in `GLX.icons`).

**SpriteBuffer** — `push(x,y,z, size, r,g,b,a, style, p1=0, p2=0)`; `data: Float32Array`, stride 11 floats `[x,y,z,size,r,g,b,a,style,p1,p2]`, `count`. size = world half-extent. Skips a≤0.002.
**LineBuffer** — `push(x1,y1,z1, x2,y2,z2, r,g,b,a)` / `pushGradient(...)`; `data` = 2 vertices per segment, 7 floats per vertex `[x,y,z,r,g,b,a]`; `count` = segments.

## 7. Module APIs (implement EXACTLY these names/signatures; extra private helpers are fine)

### 7.1 `GLX.Data` (10-data.js)
```js
GLX.Data = {
  parseLogin(input: string): string|null,       // trims, strips '@', accepts 'https://github.com/<login>[/...]'; validates /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i
  async loadUser(login, opts?: { onProgress?(msg: string), signal?: AbortSignal, maxPages?: number /*default 3*/ }): Promise<UserData>,
  demoUser(id: 'mona'|'hubot'): UserData,       // synchronous, deterministic, source 'demo', profile.isDemo = true
  getToken(): string, setToken(token: string): void,   // sessionStorage via GLX.util.storage.session ('token'); never localStorage
  recent: { list(): string[] /*≤6, newest first*/, add(login: string): void },  // localStorage 'recent'
  rateLimit: { remaining: number|null, limit: number|null, resetAt: number|null },  // updated from x-ratelimit-* headers
  ApiError   // class extends Error { code, status, resetAt } ; message is human-friendly & toast-ready
}
```
- Error codes: `'invalid_login' | 'not_found' | 'rate_limited' | 'bad_token' | 'network' | 'aborted' | 'http'`.
- Fetch `/users/{login}` → then repo pages `/users/{login}/repos?per_page=100&sort=pushed&type=owner&page=N` for N ≤ min(maxPages, ceil(public_repos/100)) in parallel → then `/users/{login}/events/public?per_page=100` (non-fatal: on failure events = []). `truncated = publicRepos > repos.length`. Only header sent by default: `Accept: application/vnd.github+json` (keeps requests CORS-simple); add `Authorization: Bearer <token>` only if a token is set.
- Rate limit: 403/429 with `x-ratelimit-remaining: 0` (or 429) → `rate_limited` with `resetAt` from `x-ratelimit-reset`*1000.
- Cache slimmed UserData in localStorage key `cache:<login lowercased>` for `GLX.config.CACHE_TTL_MS`; returned with `source: 'cache'`. Ignore quota errors.
- `onProgress` messages, e.g. "Contacting api.github.com…", "Found 142 repositories…", "Reading recent activity…".
- **Demo users** (synthetic, plausible, deterministic via `GLX.util.rng(GLX.util.hashStr(id))`, dates relative to `Date.now()`):
  - `mona` — "Mona Lisa Octocat (demo)", ~110 repos since ~12 years ago; JavaScript/TypeScript heavy + Ruby, Go, Python, Rust, CSS, Shell; ~12% forks, ~4% archived; heavy-tailed stars with 2–3 hits in the 1k–6k range.
  - `hubot` — "Hubot (demo)", ~70 repos since ~14 years ago; CoffeeScript-heavy + JavaScript, Python, Shell, Go, Rust.
  - Both share ~4 same-named repos (`dotfiles`, `advent-of-code`, `blog`, `hello-world`) so merge conflicts appear in the demo merge.
  - ~25% of repos pushed in the last 30 days; descriptions short & fun; topics on ~40%; licenses on ~60%; homepage on a few.
  - 50–80 events in the last ~60 days (mostly push to own active repos; ~25% to external repos like `octo-org/warp-drive`), all kinds represented.
  - avatarUrl `null` for demo users.

### 7.2 `GLX.Model` (20-model.js)
```js
GLX.Model = {
  build(user: UserData, opts?: { particleCount?: number /*default GLX.config.PARTICLES_DESKTOP*/, maxStars?: number /*default GLX.config.MAX_STARS*/ }): Galaxy,
  mergeSummary(galA: Galaxy, galB: Galaxy): MergeSummary,
  classify(stats): { id, name, emoji, blurb }
}
```
- Deterministic: seed = `hashStr(login.toLowerCase())`, all randomness from `GLX.util.rng(seed)`.
- Arms: languages with share ≥5% (non-fork repos; fall back to all repos), top 6, min 2 arms (duplicate/complement if only one language; if zero repos create 2 pale arms). Arm k angle = 2πk/K (+ small seeded jitter). Spiral: θ = armAngle + r·`GLX.config.ARM_TWIST` + noise.
- Stars: radius from time: `u = mix(timeNorm, rankNorm, 0.4)`, `r = 0.14 + 0.82·u` (+ tiny jitter); placed on their language's arm (other languages → arm by hash); y ≈ gauss·0.015 (forks: off-plane gauss·0.06 and wider angular scatter — a satellite halo). If more than maxStars repos, keep most-starred/recent.
- Particles (count = particleCount): ~18% bulge (warm white, r ~ |gauss|·0.1, thicker in y), ~76% along arms by language share (exponential radial falloff to ~1.15, angular spread wider near core; color = arm color mixed toward white), ~6% diffuse halo (cool, dim). Occasional bright particles. `birth ≈ clamp(r/1.2) * 0.92 + rand*0.06` (galaxy grows outward). Make it beautiful: dense bright core, crisp colorful arms, dust between arms.
- Nebulae: 6–10 per arm scaled by share, along arms at r 0.2–1.0.
- Constellations: per language (≥2 non-fork stars) Euclidean MST (Prim) edges.
- Stats/classification (fun astronomy names), first match wins: 0 repos → "Primordial Cloud"; avg stars ≥ 50 & total ≥ 1000 → "Quasar"; ≥40% repos pushed ≤90d → "Starburst Galaxy"; top language ≥70% → "Elliptical Galaxy"; ≥4 languages with ≥8% → "Grand-Design Spiral"; < 8 repos → "Dwarf Galaxy"; forks ≥50% → "Satellite Swarm"; age ≥10y → "Ancient Spiral"; else "Barred Spiral". Each with emoji + witty one-line blurb that may mention the top language.
- designation = `'GLX-' + (1000 + seed % 9000)`.
- Facts (skip if not applicable): `brightest` ("Brightest star", most stars), `oldest` ("First light", earliest), `newest` ("Newest star"), `active` ("Most recent flare", latest pushedAt), `forked` ("Most planets", most forks if >0). `text` = repo name, `value` short e.g. '⭐ 1.2k', 'Mar 2014', '3 days ago'.
- mergeSummary: conflicts = case-insensitive equal repo names across A and B (one entry per name; star indices), commitSha = 7 hex from hashStr('merge:'+loginA+':'+loginB), classification of the union (reuse classify on combined stats), sharedLangs = intersection of language names.

### 7.3 `GLX.Renderer` (30-renderer.js)
```js
class Renderer {
  constructor(canvas: HTMLCanvasElement)        // WebGL1 ({antialias:true, alpha:false, premultipliedAlpha:false, preserveDrawingBuffer:false}); throw Error('WebGL unavailable') if none
  resize(): { width, height }                    // CSS px; drawing buffer = CSS px × min(devicePixelRatio, 2); call on window resize
  width, height, dpr                             // current CSS size & ratio
  setParticles(slot: 0|1, particles: Galaxy['particles'], opts?: { dynamic?: boolean }): void
  updateParticlePositions(slot: 0|1, pos: Float32Array): void   // same length as setParticles pos (merge sim)
  clearParticles(slot: 0|1): void
  render(frame: Frame): void
  dispose(): void
}
type Frame = {
  time: number, proj: Float32Array, view: Float32Array,
  fade: number,          // 0..1 global brightness multiplier (transitions)
  skyAlpha?: number,     // default 1
  particles: { slot: 0|1, model: Float32Array, reveal: number /*0..1*/, alpha: number }[],
  sprites: GLX.SpriteBuffer, lines: GLX.LineBuffer
}
```
- Everything **additive** (premultiplied: `blendFunc(ONE, ONE)`), no depth test → order-independent. Clear to `rgb(3,5,11)`.
- **Sky**: renderer-owned static background of ~3000 faint stars on a far sphere (+ very subtle colored dust band) drawn with the view rotation only (no translation), twinkling.
- **Particles** (`gl.POINTS`): `gl_PointSize = size * uPointScale / -viewZ`, `uPointScale ≈ drawingBufferHeight * 0.0016` (tune so typical particles are ~1.5–3 device px at dist 2.9); clamp to ≤ min(48, max point size); when < ~1.5px, clamp up and reduce alpha proportionally (energy-preserving). Soft gaussian disc. Reveal: hidden while `birth > reveal`, fade in over ~0.03, brief brightness boost just after birth (expanding "wavefront"). Subtle twinkle via seed & time. Alpha × slot alpha × fade.
- **Sprites** (billboard quads, 4 verts each, static index buffer for `GLX.config.MAX_SPRITES`; corners expanded on CPU into a reusable vertex array or via a corner attribute). Styles (`GLX.SPRITE`):
  - `STAR(0)`: white-hot core + colored halo + 4 diffraction spikes (JWST-like); `p1` spike strength 0..1, `p2` seed (subtle shimmer). Min on-screen half-size ~3 device px with alpha compensation.
  - `GLOW(1)`: soft gaussian; `p1` hardness 0..1 (0 = very soft, 1 = tight bright core).
  - `RING(2)`: thin glowing ring at ~0.8 of the quad radius; `p1` thickness 0.02..0.3.
  - `NEBULA(3)`: wispy fbm/value-noise cloud, fades to 0 well before quad edges (no visible squares!); `p1` seed, `p2` density 0..1. Keep fragment cost modest.
- **Lines**: `gl.LINES`, additive, color × alpha × fade.
- Handle `webglcontextlost` (preventDefault) / `webglcontextrestored` (rebuild programs, buffers, re-upload last particles); emit `GLX.bus.emit('gl:lost')` / `'gl:restored'`.
- No per-frame allocations. Target: 32k particles + 1k sprites at 60 fps on a laptop.

### 7.4 `GLX.Camera` (35-camera.js)
```js
class Camera {
  constructor(canvas: HTMLCanvasElement)        // attaches pointer/wheel listeners to canvas (pointer events: mouse, touch, pen)
  yaw, pitch, dist, target: [x,y,z], fov /*radians, 50°*/, near /*0.01*/, far /*400*/, minDist /*0.12*/, maxDist /*16*/
  setGoal(goal: { yaw?, pitch?, dist?, target? }, opts?: { instant?: boolean, duration?: number /*s; eased flight*/ }): void
  follow(target: [x,y,z]): void                 // continuously retarget (moving star) without restarting an in-progress flight's easing
  nudge(dYaw: number, dPitch: number, zoomFactor?: number): void   // keyboard helpers
  update(dt: number): void                      // easing/flights, damping, inertia, auto-orbit, shake
  computeMatrices(widthCss: number, heightCss: number): { proj, view, viewProj, eye }   // reuses internal arrays
  project(x, y, z, out?): { x, y, depth, visible }   // CSS px within canvas; depth = view-space distance (>0 in front); visible = in front & inside viewport (+40px margin). Uses last computeMatrices.
  autoOrbit: boolean /*true*/, autoOrbitSpeed: number /*0.035 rad/s*/, idleDelay: number /*4000 ms*/
  inputEnabled: boolean
  shake(intensity: number): void                // decays over ~1 s
  isDragging: boolean, lastInteraction: number /*ms timestamp*/
  onClick: (x, y, ev) => void                   // tap/click with < 6px movement (primary button)
  onHover: (x, y) => void                       // pointer moved while not dragging
  onLeave: () => void
  onInteract: () => void                        // user started manipulating the camera
  dispose(): void
}
```
- Drag (left mouse / one finger) orbits with inertia; right-drag or shift-drag pans the target in the view plane; wheel/trackpad (incl. ctrl+wheel pinch) & two-finger pinch zoom exponentially; pitch clamped to [-1.45, 1.45]; dist clamped to [minDist, maxDist]. Auto-orbit (slow yaw drift) resumes after idleDelay without input (disabled under reduced motion). Smooth exponential damping for goals; `duration` flights ease with `easeInOutCubic`.
- The canvas has CSS `touch-action: none`. Use pointer capture. Ignore input when `inputEnabled` is false.

### 7.5 `GLX.MergeSim` (40-sim.js)
```js
class MergeSim {
  constructor(galA: Galaxy, galB: Galaxy, opts?: { pericenter?: number /*≈1.1*/, startDistance?: number /*≈5.5*/, friction?: number })
  partPos: [Float32Array, Float32Array]   // WORLD positions per galaxy (same order/length as galaxy.particles.pos) → renderer.updateParticlePositions
  starPos: [Float32Array, Float32Array]   // 3*stars.length each, same order as galaxy.stars
  nebPos:  [Float32Array, Float32Array]   // 3*nebulae.length each
  corePos: [[x,y,z],[x,y,z]]              // current cores (equal after merge)
  time: number, speed: number /*sim units per real second, default 1.0*/,
  phase: 'approach'|'first-passage'|'separating'|'second-approach'|'merging'|'merged',
  progress: number /*0..1 estimate toward merged*/, coreDistance: number, merged: boolean,
  step(dtSeconds: number): string[]       // advance dtSeconds*speed sim time in fixed substeps (h ≤ 0.01, ≤ 12 substeps/call); returns events that occurred: 'first-contact' (core distance first < 1.6), 'pericenter', 'phase:<name>', 'merged'
  reset(): void                            // back to initial conditions
}
```
- Restricted three-body (Toomre & Toomre 1972): two softened point-mass cores (G = 1, masses ≈1, ratio clamped to [0.6, 1.6] by repo counts) on a near-parabolic, prograde encounter in the XZ plane; every particle/star/nebula is a massless test particle initialized on circular orbits about its own core (`v² = M r² / (r² + ε²)^{3/2}`), disc spin around local +Y before tilting. Tilt disc A ~20°, disc B ~55°. Center of mass stays at origin.
- Dynamical friction on the cores near pericenter so they **merge after ~2 passages; total ≈ 22–30 sim units** (≈ 25 s at speed 1). After merge → single combined core; particles keep evolving into an elliptical-ish remnant with tails.
- Must look spectacular from the default merge camera (target origin, pitch ≈ 0.95, dist ≈ 7.5): long curved tidal tails & bridges, no particle explosions/NaNs. Tune offline with a Node script (`tests/sim*.mjs`), and measure perf: 2 × 14k particles + 600 stars ≤ ~4 ms per `step(1/60)`.

### 7.6 `GLX.Audio` (50-audio.js) — all sound synthesized (no samples)
```js
GLX.Audio = {
  init(): void,                  // call from a user gesture; idempotent; creates/resumes AudioContext; safe no-op if unsupported
  get ready(): boolean, get enabled(): boolean,
  setEnabled(on: boolean): void, // persisted via GLX.util.storage 'sound' (default true); smooth master fade
  toggle(): boolean,
  ambient(mode: 'off'|'calm'|'tense'|'resolved'): void,   // evolving pad drone, crossfades between moods
  starBirth(o: { lang: string, stars: number, pan: number /*-1..1*/, loud?: number /*0..1*/ }): void, // pentatonic pluck; lang→scale degree, stars→octave/velocity; throttled ≤14/s, ≤24 voices
  galaxyComplete(): void, cometLaunch(o: { pan }): void, cometArrive(o: { pan, kind }): void,
  select(): void, hover(): void /*very quiet, throttled*/, uiClick(): void,
  collision(intensity: number): void, conflict(): void, resolve(): void, mergeComplete(): void, whoosh(): void
}
```
- Master: gain → DynamicsCompressor → destination; generated-impulse ConvolverNode reverb send; all methods are safe no-ops when not ready/disabled. Tasteful, spacious, never harsh or loud; nothing should clip even with many notes.

### 7.7 `GLX.HUD` (60-ui-hud.js + 60-hud.css) — mounts in `#glx-hud-root`, labels in `#glx-labels`
```js
GLX.HUD = {
  init(handlers: { onLangHover(lang|null), onLangToggle(lang), onFactClick(fact), onCardClose(), onCardNav(dir: -1|1),
                   onSearchPick(ref: StarRef), onPoster(), onMergeReplay(), onExplore(login) }): void,
  showGalaxy(galaxy: Galaxy): void,          // profile panel (top-left) + facts + legend (bottom-left)
  showMerge(galA, galB, summary): void,      // dual header "@a ⨯ @b" + combined legend
  setMergeStatus(text: string, sub?: string): void,   // terminal-style typewriter line, e.g. "$ git merge @hubot"
  showMergeSummary(summary: MergeSummary): void,      // result panel: "Merge made by the 'gravity' strategy.", commit sha, stats, shared languages, conflicts list (auto-resolved ✓), remnant classification; buttons Poster / Replay merge / Explore @a / Explore @b
  hide(): void,                              // hide everything (intro)
  setLegendState(s: { highlight: string|null, solo: string|null }): void,
  showCard(star: Star, galaxy: Galaxy, ref: StarRef): void, hideCard(): void, get cardOpen(): boolean,
  showTooltip(x: number, y: number, star: Star): void, hideTooltip(): void,
  updateLabels(items: { key: string, text: string, x: number, y: number, alpha: number, color: string, priority: number, emphasis?: boolean }[]): void, // per frame; pooled nodes; greedy overlap culling by priority; transform-only updates
  openSearch(items: { ref: StarRef, star: Star, owner: string }[]): void, closeSearch(): void, get searchOpen(): boolean
}
```
- Profile panel: avatar (img with `referrerpolicy="no-referrer"`, fallback gradient initials circle for null/failed), name, @login link, Organization badge, classification pill (emoji + name) with blurb, designation in mono, stats row (⭐ stars, repos, forks received, languages, active 90d), "truncated" note if applicable, facts list (clickable → onFactClick). Collapsible on small screens.
- Legend: language chips (color dot, name, count, share bar); hover → onLangHover, click → onLangToggle; reflects setLegendState.
- Card (right side; bottom sheet on mobile): repo name (link ↗), owner, description, language chip, ⭐ stars, forks, open issues, created (fmtDateLong + timeAgo), last push (timeAgo), topics chips, license, homepage link, badges (Fork / Archived / Active), "🪐 N planets orbit this star — one for every fork" style line, prev/next buttons (onCardNav), close (onCardClose). Smooth slide-in.
- Tooltip: compact (name, language dot, ⭐ count, one-line description truncated), positioned near (x,y) and kept on-screen; pointer-events none.
- Search: command-palette modal (fuzzy-ish substring match on repo names, ↑/↓/Enter/Esc, ≤8 results showing language dot, stars and owner).

### 7.8 `GLX.Chrome` (65-ui-chrome.js + 65-chrome.css) — mounts in `#glx-chrome-root`
```js
GLX.Chrome = {
  init(handlers: { onLaunch(login), onDemo(), onMerge(a, b), onMergeDemo(), onCancelLoading(), onHome(), onPlayPause(),
                   onReplay(), onScrub(reveal: number), onSound(), onPoster(), onOpenMerge(), onHelp(), onSearch(),
                   onConstellations(), onMergeRestart(), onMergeSpeed(mult: number), onTokenChange(token: string) }): void,
  showIntro(opts?: { recent?: string[], error?: string, prefill?: string }): void, hideIntro(): void, get introOpen(): boolean,
  showLoading(msg: string): void, setLoading(msg: string): void, hideLoading(): void,
  toast(message: string, opts?: { type?: 'info'|'success'|'warn'|'error', timeout?: number /*ms, default 4500, 0 = sticky*/, action?: { label: string, fn(): void } }): { close(): void },
  showToolbar(mode: 'galaxy'|'merge'): void, hideToolbar(): void,
  setSound(on: boolean): void, setConstellations(on: boolean): void,
  showTimeline(t0: number, t1: number): void, updateTimeline(reveal: number, playing: boolean): void /*per frame, cheap*/, hideTimeline(): void,
  showMergeBar(): void, updateMergeBar(s: { phase: string, label: string, progress: number, speed: number, playing: boolean }): void /*per frame, cheap*/, hideMergeBar(): void,
  showHelp(): void, hideHelp(): void, get helpOpen(): boolean,
  openMergeDialog(prefillA?: string): void, openTokenDialog(): void,
  closeAllModals(): boolean,     // closes help/merge/token dialogs; returns true if anything closed (Esc handling)
  ticker(item: { icon: string, text: string, sub?: string, color?: string }): void, clearTicker(): void   // bottom-right activity feed, ≤4 items, auto-fade ~6 s
}
```
- **Intro** (full-screen overlay over the live demo galaxy background; translucent so the galaxy shows through): huge gradient wordmark "Gitlaxy" (subtle shimmer), tagline "Every repo is a star. Every language, a spiral arm.", a large input with "@" prefix + primary "Launch ✦" button (Enter submits → onLaunch(rawInput)), secondary "Explore a demo galaxy" (onDemo) and "git merge two galaxies" (reveals two inputs + "Collide" → onMerge(a,b), plus "Demo: @mona ⨯ @hubot" → onMergeDemo), recent-login chips (→ onLaunch), collapsible "Advanced: GitHub token (optional, raises rate limit 60→5000/h; kept in this tab only)" (onTokenChange), error line, footer "Zero dependencies · Your data stays in your browser · Built for the GitHub hackathon".
- **Loading**: centered orbit spinner, message, Cancel (onCancelLoading).
- **Toolbar** (top-right icon buttons with tooltips + aria-labels): galaxy mode: search (F), constellations (C), sound (M), poster (P), merge (G), help (?), home (Esc/H); merge mode: sound, poster, help, home.
- **Timeline** (bottom center, galaxy mode): play/pause, replay, range slider (0..1, fine steps) with year ticks between t0 and t1, big current-date label (fmtDate of t0 + reveal·(t1−t0)), "Big Bang" start caption. Scrubbing calls onScrub(reveal).
- **Merge bar** (bottom center, merge mode): phase label, progress bar, play/pause, speed segmented control (0.5× 1× 2× 4×), restart.
- **Help modal**: keyboard shortcuts (Drag orbit · Scroll/pinch zoom · Click star · ←/→ prev/next star · Space play/pause · F find · C constellations · M mute · P poster · G merge · R replay · 0 reset view · Esc back) + "How to read a Gitlaxy" legend (size = stars, color = language, radius = time, pulse = active ≤30d, faint satellites = forks, comets = recent activity, planets = forks).
- **Merge dialog** (from toolbar): two inputs (A prefilled) + Collide.
- Toasts: top-center stack, glass, typed accent, optional action button.

### 7.9 `GLX.Poster` (70-poster.js)
```js
GLX.Poster = {
  async create(opts: { glCanvas: HTMLCanvasElement, render: () => void /*renders a fresh frame synchronously*/,
                       galaxy?: Galaxy, galaxies?: [Galaxy, Galaxy], summary?: MergeSummary, width?: 1200, height?: 1500 }): Promise<Blob>,
  download(blob: Blob, filename: string): void,
  async exportPoster(opts /* same as create */): Promise<void>   // filename 'gitlaxy-<login>.png' or 'gitlaxy-merge-<a>-<b>.png'
}
```
- Call `opts.render()` then immediately `drawImage(glCanvas)` in the same task (no preserveDrawingBuffer). Cover-crop the galaxy into the top ~70%, fade into a stats panel: big "@login" (or "@a ⨯ @b"), name, classification (emoji + name + blurb), designation, 4–5 stat tiles, language bar (top 6 segments with labels), facts or merge info (commit sha, conflicts count, shared languages), footer "gitlaxy · every repo is a star" + date. Avatar via `Image` with `crossOrigin='anonymous'` and `?s=200`; 2.5 s timeout; on failure or canvas taint fall back to gradient initials. Canvas2D only, system fonts, crisp layout.

### 7.10 `GLX.Effects` (80-effects.js)
```js
class Effects {
  constructor()
  reset(): void
  setEvents(events: GHEvent[], ownRepos: Map<string /*fullName lowercased*/, StarRef>): void   // comet queue, newest first, cycles
  cometsEnabled: boolean /*default false*/, cometInterval: number /*s, default 1.8*/
  onCometLaunch: (event: GHEvent, target: StarRef|null) => void
  onCometArrive: (event: GHEvent, target: StarRef|null, pos: [x,y,z]) => void
  birth(ref: StarRef, color: [r,g,b], strength: number /*0..1*/): void        // flash + expanding ring that tracks the (moving) star
  burst(pos: [x,y,z], color: [r,g,b], size: number): void                     // shockwave at a fixed point
  bolt(a: StarRef, b: StarRef, opts?: { duration?: number /*s, default 2.4*/ }): void   // jagged flickering lightning between two stars: red/orange → turns green as it "resolves"
  setSelected(sel: { ref: StarRef, star: Star }|null): void   // planets (1 + floor(log2(forks+1)), max 7) on tilted orbits + faint orbit rings (line loops) around the selected star; optional moon for open issues
  setHovered(sel: { ref: StarRef, star: Star }|null): void    // soft hover ring
  update(dt: number, time: number): void
  emit(sprites: GLX.SpriteBuffer, lines: GLX.LineBuffer, ctx: EffectsCtx): void
}
type EffectsCtx = {
  starPos(ref: StarRef, out: number[]): number[],   // current WORLD position of a star
  starSize(ref: StarRef): number,                   // star world half-size
  galaxyCenter(slot: 0|1, out: number[]): number[], // WORLD center of a galaxy (core)
  galaxyRadius: number, camDist: number, time: number
}
```
- Comets: every `cometInterval` while enabled, take the next event. Own repo → comet from a random point outside the rim (r≈1.6, y ±0.3, relative to that galaxy's center) curving into the star (~2.2 s, ease-in); external repo → from the galaxy core outward past the rim toward a hash-determined direction ("contributing to the wider universe"). Head = bright GLOW sprite in `GLX.EVENT_COLORS[kind]`, trail = ~14 fading sprites along the recent path. Call onCometLaunch at launch and onCometArrive at impact (also add a small burst at impact).
- All visual sizes in world units relative to `starSize`/`camDist` so they look right when zoomed in on a star (dist ~0.3) and in overview (dist ~3).
- No per-frame allocations (pool objects, reuse scratch arrays).

## 8. Visual language & CSS conventions

`src/css/00-base.css` (coordinator) defines:
```css
:root {
  --bg:#03050b; --panel:rgba(13,17,23,.58); --panel-strong:rgba(13,17,23,.86); --border:rgba(240,246,252,.10); --border-strong:rgba(240,246,252,.20);
  --text:#e6edf3; --muted:#8b949e; --faint:#6e7681; --accent:#58a6ff; --accent-2:#a371f7; --accent-3:#ff7b72;
  --green:#3fb950; --yellow:#e3b341; --orange:#f0883e; --red:#f85149;
  --grad: linear-gradient(90deg,#79c0ff 0%,#d2a8ff 50%,#ff7b72 100%);
  --radius:14px; --radius-sm:10px; --blur:16px; --shadow:0 12px 40px rgba(0,0,0,.45);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --ease:cubic-bezier(.2,.8,.2,1);
  --z-labels:5; --z-hud:10; --z-chrome:20; --z-modal:40; --z-toast:50;
}
```
Shared classes in base: `.glass` (blurred translucent panel + border + shadow), `.btn`, `.btn-primary` (gradient), `.btn-ghost`, `.icon-btn` (36px round icon button), `.chip`, `.kbd`, `.mono`, `.sr-only`, `.dot` (8px color dot), `.icon` (svg sizing). Body is `overflow:hidden`, dark, `color: var(--text)`, `font: 14px/1.45 var(--font)`.
- Your own classes MUST be prefixed (`hud-…`, `ch-…`). Don't restyle base classes globally.
- Motion: 160–320 ms with `var(--ease)`; honor `@media (prefers-reduced-motion: reduce)`.
- Every interactive element is keyboard reachable, has a visible `:focus-visible` ring and an aria-label if icon-only.
- Mobile (≤720px): compact layouts, no overlapping panels, 44px touch targets.

## 9. DOM (src/shell.html)

```html
<canvas id="glx-canvas"></canvas>             <!-- full-screen WebGL canvas, touch-action:none -->
<div id="glx-vignette"></div>                  <!-- decorative -->
<div id="glx-labels" aria-hidden="true"></div> <!-- HUD star labels -->
<div id="glx-hud-root"></div>                  <!-- HUD panels -->
<div id="glx-chrome-root"></div>               <!-- Chrome: intro, toolbar, timeline, modals, toasts -->
```
All roots: `position:fixed; inset:0; pointer-events:none;` — set `pointer-events:auto` on your interactive elements. Labels root z = `--z-labels`, HUD = `--z-hud`, Chrome = `--z-chrome` (modals `--z-modal`, toasts `--z-toast`).

## 10. Testing

- `node --check src/js/<your file>` must pass.
- Node logic tests (no npm): 
  ```js
  import vm from 'node:vm'; import fs from 'node:fs';
  globalThis.window = globalThis;
  for (const f of ['src/js/00-core.js', 'src/js/20-model.js']) vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: f });
  const { GLX } = globalThis;
  ```
- Browser-only modules: optionally create `dev/<module>.html` that loads `../src/css/00-base.css` (may not exist yet), `../src/js/00-core.js` and your file to exercise it. Headless Chrome may exist at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (e.g. `--headless=new --disable-gpu-sandbox --enable-unsafe-swiftshader --use-angle=swiftshader --window-size=1280,800 --virtual-time-budget=5000 --screenshot=/tmp/x.png file://...`). Don't sink much time into tooling if it fails.
- **GitHub API budget is tiny (shared booth IP, ~50 calls/hour left). Do NOT call the real API except the data engineer (max 2 calls total).** Mock `fetch` instead.
- Don't start long-running servers or background processes.

## 11. Report back

Reply in ≤250 words: files written; confirm your public API matches this contract (list deviations precisely); notable assumptions; test results.
