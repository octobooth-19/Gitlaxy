# ✦ Gitlaxy

**Every repo is a star. Every language, a spiral arm. Every merge… a galactic collision.**

Gitlaxy turns any GitHub profile into a living, explorable 3D galaxy, right in your browser. Watch it form in a Big Bang replay set to generative music, see real GitHub activity streak in as comets, then `git merge` two developers and watch their galaxies collide in a real gravitational simulation.

> One `index.html`. Zero dependencies. No build step needed to run it. Open it and fly.

---

## The 30-second demo

1. **Open `index.html`** (double-click it, or serve the folder). A demo galaxy is already turning behind the title screen.
2. **Type a GitHub username** (try your own) and hit **Launch ✦**.
3. **Watch the Big Bang.** Your repos ignite in chronological order, from your first repo at the core out to this week's at the rim. Each one plays a note.
4. **Click the brightest star** to fly to your most-starred repo. Its planets are its forks.
5. **Watch the comets.** Each one is a real recent push, PR, issue or star, striking the repo it touched.
6. **Head home and `git merge` two users** (or click **git merge @mona ⨯ @hubot**). The two galaxies swing past each other, throw off tidal tails, flag "merge conflicts" (repos with the same name zap each other until they auto-resolve ✓), and settle into one merged galaxy.
7. **Press `P`** to download a shareable poster.

No network? Click **Explore a demo galaxy** or **@mona ⨯ @hubot** for fully offline demos.

## How to read a Gitlaxy

| What you see | What it means |
|---|---|
| ⭐ A star | One repository |
| Star color | Primary language (GitHub's linguist colors) |
| Star size and diffraction spikes | Stargazers (log scale) |
| Gentle pulse | Pushed in the last 30 days (slower pulse: last 180 days) |
| Distance from the core | Time: oldest repos at the center, newest at the rim |
| Spiral arms | Your top languages, colored by share |
| Faint off-plane satellites | Forks |
| Greyed stars | Archived repos |
| 🪐 Planets around a selected star | Its forks (log scale) |
| ☄️ Comets | Your recent public GitHub events, striking the repo they touched or flying out to repos you contribute to |
| Constellation lines (`C`) | Repos sharing a language, linked by a minimum spanning tree |

Every galaxy gets a classification such as **Starburst Galaxy**, **Quasar**, **Grand-Design Spiral** or **Elliptical Galaxy**, plus a designation (e.g. `GLX-4821`). Layouts are seeded by your login, so your galaxy looks the same every time you load it.

## `git merge` mode

Merge mode is a real **restricted three-body simulation** in the style of Toomre & Toomre (1972), the paper that first explained tidal tails. The method:

- Each galaxy core is a softened point mass. The two cores approach on a near-parabolic, prograde orbit.
- Every particle and repo-star is a massless test particle that starts on a circular orbit around its own core. The discs are tilted relative to the orbit.
- Dynamical friction near pericenter lets the cores spiral in and merge after about two passages.

The result is the tidal tails and bridges you see in real interacting galaxies like the Antennae or the Mice. Repos with the same name in both accounts become **merge conflicts**: lightning arcs between them until they auto-resolve. The summary ends with:

```
Merge made by the 'gravity' strategy.
```

## Keyboard

| Key | Action |
|---|---|
| Drag / scroll / pinch | Orbit / zoom (right-drag or shift-drag pans) |
| Click | Select a star |
| `←` `→` | Previous / next star |
| `Space` | Play / pause the Big Bang (or the merge) |
| `R` | Replay |
| `F` or `/` | Find a repo |
| `C` | Constellations |
| `M` | Mute / unmute |
| `P` | Download poster |
| `0` | Reset view |
| `?` | Help |
| `Esc` | Back |

Deep links: `index.html#@octocat`, `index.html#merge=alice,bob`, `index.html#demo`, `index.html#demo-merge`.

## Under the hood

Everything is hand-written for this project. There are no frameworks, libraries, fonts or images:

- **WebGL1 renderer**: about 30k additive point-sprite particles per galaxy and billboarded stars with diffraction spikes. It also draws fbm-noise nebulae, a twinkling sky, and a "reveal wavefront" shader for the Big Bang.
- **Galaxy model**: a deterministic, seeded layout. Logarithmic spiral arms per language, radius encodes time, a soft minimum separation between stars, and a Prim MST for constellations.
- **N-body merge sim**: symplectic integration over typed arrays, softened gravity and dynamical friction, around 28k test particles stepped on the CPU every frame.
- **Generative audio (WebAudio)**: pentatonic plucks for each star birth (language → scale degree, stars → octave). It adds an evolving pad that shifts mood during a merge, a convolution reverb built from a generated impulse response, and synthesized comet chimes and collision booms.
- **GitHub REST API**: called straight from the browser. Each galaxy costs about 3–5 requests, and responses are cached for an hour.
- **Poster export**: a Canvas2D composition of the live WebGL frame plus your stats, as a 1200×1500 PNG.

### Project layout

```
index.html          ← the whole app (generated; just open it)
build.mjs           ← inlines src/ into index.html (Node built-ins only)
src/shell.html      ← HTML skeleton
src/css/*.css       ← design system, HUD, chrome
src/js/00-core.js   ← shared math, colors, buffers, icons
src/js/10-data.js   ← GitHub API + cache + offline demo users
src/js/20-model.js  ← galaxy layout, stats, classification
src/js/30-renderer.js, 35-camera.js, 40-sim.js, 50-audio.js,
src/js/60-ui-hud.js, 65-ui-chrome.js, 70-poster.js, 80-effects.js
src/js/90-app.js    ← state machine, main loop, wiring
CONTRACT.md         ← the module contract the app was built against
tests/              ← node:test suites (no npm needed)
```

### Build & test

```bash
node build.mjs                 # regenerate index.html
node --test tests/             # run the test suites
```

## Privacy

Gitlaxy only talks to `api.github.com` and GitHub's avatar CDN, straight from your browser. There's no server, no analytics and no tracking. Cached profiles live in your browser's `localStorage`.

## License

MIT. Built for the GitHub hackathon with GitHub Copilot.
