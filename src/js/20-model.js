/* Gitlaxy — 20-model.js
 * Turns UserData into a Galaxy: deterministic spiral layout (radius = time, arms = languages),
 * particle field, nebulae, constellations (per-language MSTs), stats, classification and facts.
 */
(() => {
  'use strict';
  const GLX = window.GLX;
  const { util, color, config } = GLX;
  const { clamp, lerp, gauss, hashStr, weightedIndex } = util;

  const TAU = Math.PI * 2;
  const DAY = 864e5;
  const YEAR = 365.25 * DAY;
  const WARM = [1.0, 0.84, 0.66];
  const WHITE = [0.93, 0.95, 1.0];
  const YOUNG = [0.62, 0.76, 1.0];
  const HALO = [0.5, 0.6, 0.92];
  const HII = [1.0, 0.48, 0.72];

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const validTime = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);
  const pct = (x) => Math.round(x * 100) + '%';
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  function shiftHue(rgb, dh, dl = 0) {
    const [h, s, l] = color.rgbToHsl(rgb[0], rgb[1], rgb[2]);
    return color.hslToRgb((h + dh + 1) % 1, s, clamp(l + dl, 0, 1));
  }

  /** Exponential sample with given scale. */
  const expSample = (R, scale) => -Math.log(1 - R() * 0.999999) * scale;

  function maxBy(arr, fn) {
    let best = null, bv = -Infinity;
    for (const x of arr) {
      const v = fn(x);
      if (v > bv) { bv = v; best = x; }
    }
    return best;
  }

  function listLangs(langs) {
    const names = langs.slice(0, 3);
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
  }

  // ------------------------------------------------------------------ stats & classification
  function computeStats(repos, now, createdAt) {
    const own = repos.filter((r) => !r.isFork);
    const basis = own.length ? own : repos;
    const counts = new Map();
    for (const r of basis) {
      const L = r.language || 'Other';
      counts.set(L, (counts.get(L) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const named = ranked.filter(([L]) => L !== 'Other');
    const top = named[0] || ranked[0] || ['Other', 0];
    const distinct = new Set(repos.map((r) => r.language).filter(Boolean));
    const total = Math.max(1, basis.length);
    let stars = 0, forksReceived = 0, active90d = 0, archived = 0;
    for (const r of repos) {
      stars += num(r.stars);
      if (r.isArchived) archived++;
    }
    for (const r of own) {
      forksReceived += num(r.forks);
      if (now - num(r.pushedAt) <= 90 * DAY) active90d++;
    }
    const firstCreated = repos.reduce((m, r) => Math.min(m, validTime(r.createdAt, Infinity)), Infinity);
    const born = Math.min(validTime(createdAt, Infinity), firstCreated);
    const start = Number.isFinite(born) ? born : now;
    return {
      repos: repos.length,
      ownRepos: own.length,
      forkRepos: repos.length - own.length,
      stars,
      forksReceived,
      languages: distinct.size,
      active90d,
      ageYears: Math.max(0, (now - start) / YEAR),
      firstYear: new Date(start).getFullYear(),
      topLang: top[0],
      topShare: top[1] / total,
      archived,
      majorLangs: named.filter(([, c]) => c / total >= 0.08).map(([L]) => L)
    };
  }

  function classify(st) {
    const repos = num(st.repos);
    const own = Math.max(1, num(st.ownRepos) || repos);
    const major = st.majorLangs || [];
    if (!repos) {
      return { id: 'primordial', name: 'Primordial Cloud', emoji: '🌫️', blurb: 'No stars yet — just a shimmering cloud of potential. Your first repo will ignite it.' };
    }
    if (num(st.stars) / repos >= 50 && num(st.stars) >= 1000) {
      return { id: 'quasar', name: 'Quasar', emoji: '🌟', blurb: 'Blindingly bright — ' + util.fmtNum(st.stars) + ' stargazers outshine entire galaxies.' };
    }
    if (num(st.active90d) >= 3 && num(st.active90d) / own >= 0.4) {
      return { id: 'starburst', name: 'Starburst Galaxy', emoji: '💥', blurb: 'Forming new stars at a furious rate — ' + st.active90d + ' repos touched in the last 90 days.' };
    }
    if (num(st.topShare) >= 0.7 && st.topLang && st.topLang !== 'Other' && own >= 3) {
      return { id: 'elliptical', name: 'Elliptical Galaxy', emoji: '🥚', blurb: 'Dense, focused and devoted: ' + pct(st.topShare) + ' ' + st.topLang + '.' };
    }
    if (major.length >= 4) {
      return { id: 'grand-design', name: 'Grand-Design Spiral', emoji: '🌀', blurb: 'Majestic polyglot arms of ' + listLangs(major) + '.' };
    }
    if (repos < 8) {
      return { id: 'dwarf', name: 'Dwarf Galaxy', emoji: '✨', blurb: 'Small but mighty — every star counts.' };
    }
    if (num(st.forkRepos) / repos >= 0.5) {
      return { id: 'satellite', name: 'Satellite Swarm', emoji: '🛰️', blurb: 'Orbited by a swarm of forks — a true explorer of other worlds.' };
    }
    if (num(st.ageYears) >= 10) {
      return { id: 'ancient', name: 'Ancient Spiral', emoji: '🏛️', blurb: 'Shining for ' + Math.floor(st.ageYears) + ' years — older light than most of the universe.' };
    }
    return { id: 'barred', name: 'Barred Spiral', emoji: '🌌', blurb: 'A classic, balanced spiral with a ' + (st.topLang || 'polyglot') + ' heart.' };
  }

  // ------------------------------------------------------------------ build
  function build(user, opts = {}) {
    const particleCount = Math.max(0, Math.floor(opts.particleCount != null ? opts.particleCount : config.PARTICLES_DESKTOP));
    const maxStars = Math.max(0, Math.floor(opts.maxStars != null ? opts.maxStars : config.MAX_STARS));
    const profile = user.profile;
    const login = String(profile.login || 'unknown');
    const seed = hashStr(login.toLowerCase());
    const R = util.rng(seed);
    const now = validTime(num(user.fetchedAt), Date.now());

    // Repos → stars (most important first if we must cut), then chronological.
    let repos = (user.repos || []).filter((r) => r && r.name);
    if (repos.length > maxStars) {
      repos = repos.slice().sort((a, b) => num(b.stars) - num(a.stars) || num(b.pushedAt) - num(a.pushedAt)).slice(0, maxStars);
    }
    repos = repos.slice().sort((a, b) => num(a.createdAt) - num(b.createdAt) || (a.name < b.name ? -1 : 1));

    // Timeline.
    const firstRepo = repos.length ? validTime(repos[0].createdAt, Infinity) : Infinity;
    let t0 = Math.min(validTime(profile.createdAt, Infinity), firstRepo);
    if (!Number.isFinite(t0) || t0 >= now) t0 = now - YEAR;
    const t1 = Math.max(now, t0 + DAY);

    // Languages (legend counts include forks; arms come from own repos).
    const own = repos.filter((r) => !r.isFork);
    const basis = own.length ? own : repos;
    const all = new Map();
    for (const r of repos) {
      const L = r.language || 'Other';
      const e = all.get(L) || { lang: L, count: 0, stars: 0 };
      e.count++;
      e.stars += num(r.stars);
      all.set(L, e);
    }
    const langs = [...all.values()]
      .sort((a, b) => b.count - a.count || b.stars - a.stars || (a.lang < b.lang ? -1 : 1))
      .map((e) => ({ lang: e.lang, count: e.count, share: e.count / Math.max(1, repos.length), color: color.langColor(e.lang), stars: e.stars }));

    const basisCounts = new Map();
    for (const r of basis) {
      const L = r.language || 'Other';
      basisCounts.set(L, (basisCounts.get(L) || 0) + 1);
    }
    const basisTotal = Math.max(1, basis.length);
    let armLangs = [...basisCounts.entries()]
      .filter(([L]) => L !== 'Other')
      .map(([lang, c]) => ({ lang, share: c / basisTotal }))
      .filter((a) => a.share >= 0.05)
      .sort((a, b) => b.share - a.share || (a.lang < b.lang ? -1 : 1))
      .slice(0, 6);
    if (!armLangs.length && basisCounts.has('Other')) armLangs = [{ lang: 'Other', share: 1 }];

    // Arms.
    const K = Math.max(2, armLangs.length);
    const baseAngle = R() * TAU;
    const arms = [];
    for (let k = 0; k < K; k++) {
      const src = armLangs.length ? armLangs[k % armLangs.length] : null;
      let col;
      if (!src) col = k === 0 ? [0.62, 0.74, 1.0] : [0.82, 0.7, 1.0];
      else if (armLangs.length === 1 && k > 0) col = shiftHue(color.langColor(src.lang), 0.06, 0.04);
      else col = color.langColor(src.lang);
      const dup = src ? arms.filter((a) => a.lang === src.lang).length + 1 : 1;
      arms.push({
        lang: src ? src.lang : 'Other',
        color: col,
        angle: baseAngle + (TAU * k) / K + (R() - 0.5) * 0.3,
        share: src ? src.share / (armLangs.length === 1 ? K : dup) : 1 / K
      });
    }
    const armIndexFor = (lang, name) => {
      const idx = [];
      for (let k = 0; k < arms.length; k++) if (arms[k].lang === lang) idx.push(k);
      if (idx.length) return idx[hashStr(name) % idx.length];
      return hashStr(lang) % arms.length;
    };

    // Stars.
    const TWIST = config.ARM_TWIST;
    const n = repos.length;
    const stars = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = repos[i];
      const created = validTime(r.createdAt, t0);
      const tn = clamp((created - t0) / (t1 - t0), 0, 1);
      const rank = n > 1 ? i / (n - 1) : 0.5;
      const isFork = !!r.isFork;
      const rad = clamp(0.14 + 0.82 * lerp(tn, rank, 0.4) + gauss(R) * 0.012, 0.1, 0.985);
      const lang = r.language || 'Other';
      const k = armIndexFor(lang, r.name);
      const spread = isFork ? 0.34 : 0.11 * (1 - 0.35 * rad);
      const theta = arms[k].angle + rad * TWIST + gauss(R) * spread;
      const y = gauss(R) * (isFork ? 0.06 : 0.015);
      const nStars = num(r.stars);
      const pushedAgo = now - validTime(r.pushedAt, 0);
      const activity = pushedAgo <= 30 * DAY ? 1 : pushedAgo <= 180 * DAY ? 0.5 : 0;
      stars[i] = {
        index: i,
        repo: r,
        pos: [rad * Math.cos(theta), y, rad * Math.sin(theta)],
        color: color.langColor(r.language),
        size: (0.010 + 0.0085 * Math.log10(nStars + 1)) * (isFork ? 0.65 : 1),
        birth: tn,
        activity,
        arm: k,
        lang,
        isFork,
        isArchived: !!r.isArchived,
        labelPriority: isFork ? 0 : Math.max(0.05, 0.2 + 2 * Math.log10(nStars + 1) + activity * 0.8 - (r.isArchived ? 0.3 : 0))
      };
    }
    separateStars(stars, 0.022);

    // Particle field.
    const N = particleCount;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 4);
    const meta = new Float32Array(N * 3);
    const armWeights = arms.map((a) => Math.max(a.share, 0.08));
    const armCos = arms.map((a) => a.color);
    for (let p = 0; p < N; p++) {
      const roll = R();
      let x, y, z, r, c, size, alpha;
      if (roll < 0.17) {
        // Bulge: flattened warm spheroid.
        const rr = Math.min(Math.abs(gauss(R)) * 0.085 + R() * 0.012, 0.34);
        const th = R() * TAU;
        const cp = 2 * R() - 1;
        const sp = Math.sqrt(1 - cp * cp);
        x = rr * sp * Math.cos(th);
        z = rr * sp * Math.sin(th);
        y = rr * cp * 0.5;
        r = Math.hypot(x, z);
        c = mix3(WARM, WHITE, R() * 0.45);
        size = 0.9 + R() * 1.3;
        alpha = 0.07 + R() * 0.1;
      } else if (roll < 0.94) {
        // Spiral arms, allocated by language share.
        const k = weightedIndex(R, armWeights);
        const arm = arms[k];
        r = 0.05 + expSample(R, 0.36);
        if (r > 1.18) r = 0.06 + R() * 1.08;
        r += gauss(R) * 0.015;
        const off = gauss(R);
        const spread = 0.15 + 0.33 * Math.exp(-r * 2.2);
        const theta = arm.angle + r * TWIST + off * spread;
        x = r * Math.cos(theta);
        z = r * Math.sin(theta);
        y = gauss(R) * (0.011 + 0.032 * Math.exp(-r * 5));
        const young = R() < 0.07 && off > -0.3;
        const tCore = Math.exp(-r * 3.4);
        if (young) {
          c = mix3(YOUNG, WHITE, R() * 0.5);
          size = 2.0 + R() * 1.8;
          alpha = 0.55 + R() * 0.25;
        } else {
          c = mix3(mix3(armCos[k], WARM, tCore * 0.65), WHITE, 0.1 + R() * 0.22);
          size = 1.0 + R() * 1.6;
          alpha = (0.24 + R() * 0.3) * (0.5 + 0.5 * Math.exp(-off * off * 0.5));
        }
      } else {
        // Diffuse halo and inter-arm dust.
        r = Math.sqrt(R()) * 1.3;
        const theta = R() * TAU;
        x = r * Math.cos(theta);
        z = r * Math.sin(theta);
        y = gauss(R) * 0.07;
        c = mix3(HALO, armCos[(p * 7) % armCos.length], 0.25);
        size = 0.7 + R() * 1.1;
        alpha = 0.1 + R() * 0.14;
      }
      if (R() < 0.012) {
        size = Math.min(4, size * 2.1);
        alpha = Math.min(1, alpha * 1.7);
      }
      const o3 = p * 3, o4 = p * 4;
      pos[o3] = x; pos[o3 + 1] = y; pos[o3 + 2] = z;
      col[o4] = clamp(c[0], 0, 1); col[o4 + 1] = clamp(c[1], 0, 1); col[o4 + 2] = clamp(c[2], 0, 1); col[o4 + 3] = clamp(alpha, 0, 1);
      meta[o3] = clamp(size, 0.6, 4.0);
      meta[o3 + 1] = clamp(clamp(r / 1.2, 0, 1) * 0.92 + R() * 0.06, 0, 1);
      meta[o3 + 2] = R();
    }

    // Nebulae: colored clouds along arms, some pink H-II regions.
    const nebulae = [];
    for (let k = 0; k < arms.length; k++) {
      const count = Math.round(6 + 4 * Math.min(1, arms[k].share * 2));
      for (let j = 0; j < count; j++) {
        const r = 0.2 + R() * 0.8;
        const theta = arms[k].angle + r * TWIST + gauss(R) * 0.12;
        const pink = R() < 0.3;
        nebulae.push({
          pos: [r * Math.cos(theta), gauss(R) * 0.012, r * Math.sin(theta)],
          size: 0.15 + R() * 0.3,
          color: pink ? mix3(arms[k].color, HII, 0.55) : mix3(arms[k].color, WHITE, 0.12),
          alpha: 0.04 + R() * 0.08,
          birth: clamp(clamp(r / 1.2, 0, 1) * 0.92 + R() * 0.06, 0, 1),
          seed: R()
        });
      }
    }

    const constellations = buildConstellations(stars);
    const stats = computeStats(repos, now, profile.createdAt);
    const classification = classify(stats);
    const facts = buildFacts(stars, now);

    return {
      user,
      profile,
      seed,
      t0,
      t1,
      radius: 1.0,
      arms,
      langs,
      stars,
      particles: { count: N, pos, color: col, meta },
      nebulae,
      constellations,
      stats,
      classification,
      designation: 'GLX-' + (1000 + (seed % 9000)),
      facts
    };
  }

  /** Nudge stars apart (XZ) so none overlap exactly. */
  function separateStars(stars, minSep) {
    const n = stars.length;
    const min2 = minSep * minSep;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const a = stars[i].pos;
        for (let j = i + 1; j < n; j++) {
          const b = stars[j].pos;
          let dx = b[0] - a[0], dz = b[2] - a[2];
          const d2 = dx * dx + dz * dz + (b[1] - a[1]) * (b[1] - a[1]);
          if (d2 >= min2) continue;
          let d = Math.sqrt(dx * dx + dz * dz);
          if (d < 1e-6) {
            const ang = (i * 2.399963 + j) % TAU;
            dx = Math.cos(ang); dz = Math.sin(ang); d = 1;
          }
          const push = (minSep - Math.min(d, minSep)) * 0.5;
          const ux = dx / d, uz = dz / d;
          a[0] -= ux * push; a[2] -= uz * push;
          b[0] += ux * push; b[2] += uz * push;
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (const s of stars) {
      const r = Math.hypot(s.pos[0], s.pos[2]);
      if (r > 1.0) {
        s.pos[0] *= 1.0 / r;
        s.pos[2] *= 1.0 / r;
      }
    }
  }

  /** Prim MST per language over non-fork stars. */
  function buildConstellations(stars) {
    const byLang = new Map();
    for (const s of stars) {
      if (s.isFork) continue;
      if (!byLang.has(s.lang)) byLang.set(s.lang, []);
      byLang.get(s.lang).push(s.index);
    }
    const edges = [];
    for (const idxs of byLang.values()) {
      const m = idxs.length;
      if (m < 2) continue;
      const inTree = new Uint8Array(m);
      const best = new Float64Array(m).fill(Infinity);
      const parent = new Int32Array(m).fill(-1);
      best[0] = 0;
      for (let it = 0; it < m; it++) {
        let u = -1, bu = Infinity;
        for (let v = 0; v < m; v++) if (!inTree[v] && best[v] < bu) { bu = best[v]; u = v; }
        if (u < 0) break;
        inTree[u] = 1;
        if (parent[u] >= 0) edges.push([idxs[parent[u]], idxs[u]]);
        const pu = stars[idxs[u]].pos;
        for (let v = 0; v < m; v++) {
          if (inTree[v]) continue;
          const pv = stars[idxs[v]].pos;
          const d = (pu[0] - pv[0]) ** 2 + (pu[1] - pv[1]) ** 2 + (pu[2] - pv[2]) ** 2;
          if (d < best[v]) { best[v] = d; parent[v] = u; }
        }
      }
    }
    return edges;
  }

  function buildFacts(stars, now) {
    const facts = [];
    const ownStars = stars.filter((s) => !s.isFork);
    const pool = ownStars.length ? ownStars : stars;
    if (!pool.length) return facts;
    const brightest = maxBy(pool, (s) => num(s.repo.stars) * 1e3 + s.birth);
    if (brightest && num(brightest.repo.stars) > 0) {
      facts.push({ id: 'brightest', label: 'Brightest star', text: brightest.repo.name, value: '⭐ ' + util.fmtNum(brightest.repo.stars), starIndex: brightest.index });
    }
    const oldest = pool[0];
    facts.push({ id: 'oldest', label: 'First light', text: oldest.repo.name, value: util.fmtDate(oldest.repo.createdAt), starIndex: oldest.index });
    const newest = pool[pool.length - 1];
    if (newest !== oldest) {
      facts.push({ id: 'newest', label: 'Newest star', text: newest.repo.name, value: util.fmtDate(newest.repo.createdAt), starIndex: newest.index });
    }
    const active = maxBy(pool, (s) => num(s.repo.pushedAt));
    if (active && num(active.repo.pushedAt) > 0) {
      facts.push({ id: 'active', label: 'Most recent flare', text: active.repo.name, value: util.timeAgo(active.repo.pushedAt, now), starIndex: active.index });
    }
    const forked = maxBy(pool, (s) => num(s.repo.forks));
    if (forked && num(forked.repo.forks) > 0) {
      facts.push({ id: 'forked', label: 'Most planets', text: forked.repo.name, value: '🍴 ' + util.fmtNum(forked.repo.forks), starIndex: forked.index });
    }
    return facts;
  }

  // ------------------------------------------------------------------ merge summary
  function byName(stars) {
    const map = new Map();
    for (const s of stars) {
      const k = String(s.repo.name).toLowerCase();
      const prev = map.get(k);
      if (!prev || (prev.isFork && !s.isFork)) map.set(k, s);
    }
    return map;
  }

  function mergeSummary(A, B) {
    const mapA = byName(A.stars);
    const mapB = byName(B.stars);
    const conflicts = [];
    for (const [k, sa] of mapA) {
      const sb = mapB.get(k);
      if (sb) conflicts.push({ name: sa.repo.name, a: sa.index, b: sb.index, weight: num(sa.repo.stars) + num(sb.repo.stars) });
    }
    conflicts.sort((x, y) => y.weight - x.weight || (x.name < y.name ? -1 : 1));
    for (const c of conflicts) delete c.weight;

    const langsA = new Map(A.langs.filter((l) => l.lang !== 'Other').map((l) => [l.lang, l.count]));
    const langsB = new Map(B.langs.filter((l) => l.lang !== 'Other').map((l) => [l.lang, l.count]));
    const union = new Set([...langsA.keys(), ...langsB.keys()]);
    const sharedLangs = [...langsA.keys()]
      .filter((l) => langsB.has(l))
      .sort((x, y) => langsA.get(y) + langsB.get(y) - (langsA.get(x) + langsB.get(x)) || (x < y ? -1 : 1));

    const now = Math.max(num(A.user && A.user.fetchedAt), num(B.user && B.user.fetchedAt)) || Date.now();
    const created = Math.min(validTime(A.profile.createdAt, Infinity), validTime(B.profile.createdAt, Infinity));
    const combined = computeStats(A.stars.map((s) => s.repo).concat(B.stars.map((s) => s.repo)), now, created);
    let classification = classify(combined);
    if (classification.id === 'barred' || classification.id === 'ancient') {
      classification = { id: 'remnant', name: 'Elliptical Merger Remnant', emoji: '🥚', blurb: 'Two spirals in, one elliptical out — a textbook galactic merger.' };
    }
    const key = 'merge:' + String(A.profile.login).toLowerCase() + ':' + String(B.profile.login).toLowerCase();
    const h = hashStr(key);
    return {
      a: A.profile,
      b: B.profile,
      totalRepos: A.stars.length + B.stars.length,
      totalStars: num(A.stats.stars) + num(B.stats.stars),
      languages: union.size,
      sharedLangs,
      conflicts,
      classification,
      commitSha: (h.toString(16).padStart(8, '0') + hashStr(key + ':sha').toString(16).padStart(8, '0')).slice(0, 7),
      designation: 'GLX-' + (1000 + (h % 9000))
    };
  }

  GLX.Model = { build, mergeSummary, classify, computeStats };
})();
