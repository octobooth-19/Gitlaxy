/* Gitlaxy — 70-poster.js
 * Shareable PNG poster (default 1200×1500): the live WebGL galaxy, cover-cropped into a "star chart" frame that
 * fades into a trading-card info panel (single galaxy or `git merge` remnant). Canvas2D only, system fonts.
 */
(() => {
  'use strict';
  const GLX = (window.GLX = window.GLX || {});

  const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  const BG = '#03050b';
  const COL = {
    text: '#e6edf3', soft: 'rgba(230,237,243,0.76)', muted: '#8b949e', faint: '#6e7681',
    blue: '#79c0ff', purple: '#d2a8ff', coral: '#ff7b72', yellow: '#e3b341', green: '#3fb950', red: '#f85149', cyan: '#56d4dd'
  };
  const GRAD = [COL.blue, COL.purple, COL.coral];
  const BASE_W = 1200;
  const BASE_H = 1500;
  const GALAXY_FRAC = 0.68; // share of the poster height showing the galaxy
  const ZOOM = 1.08; // crop slightly into the frame…
  const BIAS = 0.03; // …and nudge the galaxy upward, away from the info panel
  const FRAME = 16;
  const MARGIN = 72;
  const AVATAR_TIMEOUT_MS = 2500;
  const TAU = Math.PI * 2;
  const FACT_ORDER = ['brightest', 'oldest', 'active', 'forked', 'newest'];
  const FACT_COLORS = { brightest: COL.yellow, oldest: COL.blue, active: COL.green, forked: COL.purple, newest: COL.coral };

  // Device px per layout px of the poster being composed. Shadow blur/offsets ignore the canvas transform.
  let K = 1;

  // ------------------------------------------------------------------ small utils
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const clean = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  const font = (weight, px, fam) => weight + ' ' + px + 'px ' + (fam || SANS);
  const fmtNum = (n) => GLX.util.fmtNum(n);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  function yearOf(ms) {
    const t = Number(ms);
    if (!isFinite(t) || t <= 0) return null;
    const y = new Date(t).getFullYear();
    return isFinite(y) ? y : null;
  }
  function rgba(c, a) {
    return GLX.color.rgbToCss(Array.isArray(c) ? c : GLX.color.hexToRgb(c), a);
  }
  function warn(e) {
    try {
      console.warn('[GLX.Poster]', e);
    } catch (_) { /* ignore */ }
  }
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  function guard(ctx, fn) {
    ctx.save();
    try {
      fn();
    } catch (e) {
      warn(e);
    }
    ctx.restore();
  }
  function shadow(ctx, color, blur, ox, oy) {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur * K;
    ctx.shadowOffsetX = (ox || 0) * K;
    ctx.shadowOffsetY = (oy || 0) * K;
  }
  function grad(ctx, x0, y0, x1, y1, colors) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    const n = colors.length;
    for (let i = 0; i < n; i++) g.addColorStop(n > 1 ? i / (n - 1) : 0, colors[i]);
    return g;
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function circle(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, r), 0, TAU);
  }
  function sparkle(ctx, x, y, r, fill) {
    const k = r * 0.14;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x + k, y - k, x + r, y);
    ctx.quadraticCurveTo(x + k, y + k, x, y + r);
    ctx.quadraticCurveTo(x - k, y + k, x - r, y);
    ctx.quadraticCurveTo(x - k, y - k, x, y - r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  function softGlow(ctx, x, y, r, rgb, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(rgb, a));
    g.addColorStop(0.45, rgba(rgb, a * 0.38));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // ------------------------------------------------------------------ text (letterSpacing with a manual fallback)
  let lsMode = '';
  function lsProbe(ctx) {
    if (lsMode) return lsMode;
    lsMode = 'manual';
    try {
      if ('letterSpacing' in ctx) {
        const prev = ctx.font;
        ctx.font = font(400, 20);
        ctx.letterSpacing = '0px';
        const a2 = ctx.measureText('MM').width, a1 = ctx.measureText('M').width;
        ctx.letterSpacing = '10px';
        const b2 = ctx.measureText('MM').width, b1 = ctx.measureText('M').width;
        ctx.letterSpacing = '0px';
        ctx.font = prev;
        if (b2 - a2 > 5) lsMode = b1 - a1 > 5 ? 'native-trailing' : 'native';
      }
    } catch (e) {
      lsMode = 'manual';
    }
    return lsMode;
  }
  /** Visible advance width of `s` with `sp` px extra tracking between characters. */
  function measure(ctx, s, sp) {
    if (!s) return 0;
    if (!sp) return ctx.measureText(s).width;
    const mode = lsProbe(ctx);
    if (mode !== 'manual') {
      ctx.letterSpacing = sp + 'px';
      const w = ctx.measureText(s).width;
      ctx.letterSpacing = '0px';
      return mode === 'native-trailing' ? w - sp : w;
    }
    const chars = Array.from(s);
    let w = 0;
    for (let i = 0; i < chars.length; i++) w += ctx.measureText(chars[i]).width;
    return w + sp * (chars.length - 1);
  }
  function fillSpaced(ctx, s, x, y, sp) {
    if (!sp) {
      ctx.fillText(s, x, y);
      return;
    }
    if (lsProbe(ctx) !== 'manual') {
      ctx.letterSpacing = sp + 'px';
      ctx.fillText(s, x, y);
      ctx.letterSpacing = '0px';
      return;
    }
    const chars = Array.from(s);
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], x, y);
      x += ctx.measureText(chars[i]).width + sp;
    }
  }
  function ellipsize(ctx, s, maxW, sp) {
    s = String(s == null ? '' : s);
    if (!(maxW > 0)) return '';
    if (measure(ctx, s, sp) <= maxW) return s;
    const chars = Array.from(s);
    let lo = 0, hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measure(ctx, chars.slice(0, mid).join('').trimEnd() + '…', sp) <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? chars.slice(0, lo).join('').trimEnd() + '…' : '…';
  }
  /** Greedy word wrap; the last allowed line is ellipsized when the text overflows. */
  function wrap(ctx, s, maxW, maxLines, sp) {
    const words = clean(s).split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const test = line ? line + ' ' + words[i] : words[i];
      if (!line || measure(ctx, test, sp) <= maxW) {
        line = test;
        continue;
      }
      lines.push(line);
      if (lines.length === maxLines) {
        lines[maxLines - 1] = ellipsize(ctx, line + ' ' + words.slice(i).join(' '), maxW, sp);
        return lines;
      }
      line = words[i];
    }
    if (line) lines.push(line);
    return lines.map((l) => ellipsize(ctx, l, maxW, sp));
  }
  /** Largest integer size in [minSize, maxSize] whose widthAt(size) fits maxW (minSize if none does). */
  function fitSize(maxSize, minSize, widthAt, maxW) {
    const w0 = widthAt(maxSize);
    if (w0 <= maxW) return maxSize;
    let s = Math.max(minSize, Math.floor((maxSize * maxW) / Math.max(1, w0)));
    while (s > minSize && widthAt(s) > maxW) s--;
    while (s < maxSize && widthAt(s + 1) <= maxW) s++;
    return s;
  }
  /**
   * Draws one line of text and returns its visible width.
   * o: { font, color, gradient: [css…], align: 'left'|'center'|'right', baseline, spacing, maxWidth (ellipsize) }
   */
  function text(ctx, s, x, y, o) {
    o = o || {};
    s = s == null ? '' : String(s);
    ctx.font = o.font || font(400, 16);
    ctx.textAlign = 'left';
    ctx.textBaseline = o.baseline || 'alphabetic';
    const sp = o.spacing || 0;
    if (o.maxWidth != null) s = ellipsize(ctx, s, o.maxWidth, sp);
    if (!s) return 0;
    const w = measure(ctx, s, sp);
    const x0 = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
    ctx.fillStyle = o.gradient && w > 0 ? grad(ctx, x0, 0, x0 + w, 0, o.gradient) : o.color || COL.text;
    fillSpaced(ctx, s, x0, y, sp);
    return w;
  }

  // ------------------------------------------------------------------ icons (reuse GLX.icon SVG markup via Path2D)
  const iconCache = new Map();
  function iconPath(name) {
    if (iconCache.has(name)) return iconCache.get(name);
    let out = null;
    try {
      if (typeof Path2D === 'function' && typeof GLX.icon === 'function') {
        const svg = GLX.icon(name, 24);
        let d = '', fillD = '';
        const re = /<(path|circle|rect)\b([^>]*)>/g;
        let m;
        while ((m = re.exec(svg))) {
          const a = {};
          m[2].replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => {
            a[k] = v;
            return '';
          });
          let part = '';
          if (m[1] === 'path') part = a.d || '';
          else if (m[1] === 'circle') {
            const cx = +a.cx, cy = +a.cy, r = +a.r;
            part = 'M' + (cx - r) + ' ' + cy + 'a' + r + ' ' + r + ' 0 1 0 ' + 2 * r + ' 0a' + r + ' ' + r + ' 0 1 0 ' + -2 * r + ' 0Z';
          } else {
            const x = +a.x, y = +a.y, w = +a.width, h = +a.height, r = Math.min(+a.rx || 0, w / 2, h / 2);
            part = 'M' + (x + r) + ' ' + y + 'h' + (w - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + 'v' + (h - 2 * r) +
              'a' + r + ' ' + r + ' 0 0 1 ' + -r + ' ' + r + 'h' + (2 * r - w) + 'a' + r + ' ' + r + ' 0 0 1 ' + -r + ' ' + -r +
              'v' + (2 * r - h) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + -r + 'Z';
          }
          if (a.fill === 'currentColor') fillD += part;
          else d += part;
        }
        if (d || fillD) out = { stroke: d ? new Path2D(d) : null, fill: fillD ? new Path2D(fillD) : null };
      }
    } catch (e) {
      out = null;
    }
    iconCache.set(name, out);
    return out;
  }
  function drawIcon(ctx, name, x, y, size, color) {
    const ic = iconPath(name);
    if (!ic) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (ic.stroke) ctx.stroke(ic.stroke);
    if (ic.fill) ctx.fill(ic.fill);
    ctx.restore();
  }

  // ------------------------------------------------------------------ data → poster model (defensive: any field may be missing)
  const profileOf = (g) => (g && (g.profile || (g.user && g.user.profile))) || null;

  function langList(g) {
    const map = new Map();
    const add = (lang, count) => {
      const k = clean(lang) || 'Other';
      if (count > 0) map.set(k, (map.get(k) || 0) + count);
    };
    if (g && Array.isArray(g.langs) && g.langs.length) {
      for (const l of g.langs) if (l) add(l.lang, num(l.count, 0));
    } else if (g && Array.isArray(g.stars)) {
      for (const s of g.stars) if (s) add(s.lang || (s.repo && s.repo.language), 1);
    }
    return [...map].map(([lang, count]) => ({ lang, count })).sort((a, b) => b.count - a.count);
  }
  function combineLangs(lists) {
    const map = new Map();
    for (const list of lists) for (const l of list) map.set(l.lang, (map.get(l.lang) || 0) + l.count);
    return [...map].map(([lang, count]) => ({ lang, count })).sort((a, b) => b.count - a.count);
  }
  /** Top `max` named languages + everything else folded into "Other". */
  function segments(langs, max) {
    const total = langs.reduce((s, l) => s + l.count, 0);
    if (!(total > 0)) return [];
    const top = langs.filter((l) => l.lang !== 'Other').slice(0, max);
    const used = top.reduce((s, l) => s + l.count, 0);
    const segs = top.map((l) => ({ lang: l.lang, share: l.count / total, rgb: GLX.color.langColor(l.lang) }));
    if (total - used > 0) {
      segs.push({ lang: 'Other', share: (total - used) / total, rgb: GLX.color.mix(GLX.color.OTHER_COLOR, [0.42, 0.47, 0.58], 0.45) });
    }
    return segs;
  }
  function paletteOf(segs) {
    const p = segs.filter((s) => s.lang !== 'Other').slice(0, 3).map((s) => s.rgb);
    const brand = GRAD.map((c) => GLX.color.hexToRgb(c));
    while (p.length < 3) p.push(brand[p.length]);
    return p;
  }

  function describeSingle(g) {
    g = g || {};
    const p = profileOf(g) || {};
    const login = clean(p.login) || 'stargazer';
    const st = g.stats || {};
    const stars = Array.isArray(g.stars) ? g.stars.filter(Boolean) : [];
    const repoOf = (s) => s.repo || {};
    const repos = num(st.repos, stars.length);
    const starCount = num(st.stars, stars.reduce((t, s) => t + num(repoOf(s).stars, 0), 0));
    const forks = num(st.forksReceived, stars.reduce((t, s) => t + (repoOf(s).isFork ? 0 : num(repoOf(s).forks, 0)), 0));
    const langs = langList(g);
    const segs = segments(langs, 6);
    const languages = num(st.languages, langs.filter((l) => l.lang !== 'Other').length);
    let firstYear = num(st.firstYear, null) || null;
    if (!firstYear && stars.length) firstYear = yearOf(Math.min(...stars.map((s) => num(repoOf(s).createdAt, Infinity))));
    if (!firstYear && repos > 0) firstYear = yearOf(g.t0);
    const seed = num(g.seed, GLX.util.hashStr(login.toLowerCase())) >>> 0;
    const cls = g.classification || {};

    const facts = (Array.isArray(g.facts) ? g.facts : [])
      .filter((f) => f && clean(f.label) && (clean(f.text) || clean(f.value)))
      .map((f) => ({ id: f.id, label: clean(f.label), text: clean(f.text), value: clean(f.value), color: FACT_COLORS[f.id] || COL.cyan }))
      .sort((a, b) => {
        const ia = FACT_ORDER.indexOf(a.id), ib = FACT_ORDER.indexOf(b.id);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .slice(0, 3);
    if (facts.length < 3 && num(p.createdAt, 0) > 0) {
      facts.push({ label: 'Joined GitHub', text: GLX.util.fmtDate(p.createdAt), value: GLX.util.timeAgo(p.createdAt), color: COL.blue });
    }
    if (facts.length < 3 && typeof p.followers === 'number') {
      facts.push({ label: 'Followers', text: fmtNum(p.followers), value: 'following ' + fmtNum(num(p.following, 0)), color: COL.purple });
    }
    if (facts.length < 3 && repos === 0) {
      facts.push({ label: 'Status', text: 'Awaiting first light', value: 'no public repos yet', color: COL.coral });
    }

    return {
      kind: 'single',
      login,
      name: clean(p.name),
      avatarUrl: p.avatarUrl || null,
      isDemo: !!(p.isDemo || (g.user && g.user.source === 'demo')),
      isOrg: p.type === 'Organization',
      joined: num(p.createdAt, 0),
      followers: num(p.followers, -1),
      seed,
      designation: clean(g.designation) || 'GLX-' + (1000 + (seed % 9000)),
      cls: { emoji: clean(cls.emoji), name: clean(cls.name), blurb: clean(cls.blurb) },
      tiles: [
        { label: 'Stars', value: fmtNum(starCount), icon: 'star', color: COL.yellow },
        { label: 'Repos', value: fmtNum(repos), icon: 'sparkle', color: COL.blue },
        { label: 'Languages', value: fmtNum(languages), icon: 'code', color: COL.purple },
        { label: 'Forks received', value: fmtNum(forks), icon: 'fork', color: COL.coral },
        { label: 'First light', value: firstYear ? String(firstYear) : '—', icon: 'calendar', color: COL.green }
      ],
      segs,
      langCount: languages,
      facts: facts.slice(0, 3),
      epoch: firstYear ? [firstYear, yearOf(g.t1) || new Date().getFullYear()] : null,
      palette: paletteOf(segs),
      galaxies: [g]
    };
  }

  function describeMerge(opts) {
    const s = opts.summary || {};
    const gs = (Array.isArray(opts.galaxies) ? opts.galaxies : []).slice(0, 2);
    const pa = s.a || profileOf(gs[0]) || {};
    const pb = s.b || profileOf(gs[1]) || {};
    const who = (p, d) => ({ login: clean(p.login) || d, name: clean(p.name), avatarUrl: p.avatarUrl || null });
    const a = who(pa, 'galaxy-a'), b = who(pb, 'galaxy-b');
    const seed = GLX.util.hashStr('merge:' + a.login.toLowerCase() + ':' + b.login.toLowerCase());
    const stat = (k) => gs.reduce((t, g) => t + num(g && g.stats && g.stats[k], 0), 0);
    const lists = gs.map(langList);
    const combined = combineLangs(lists);
    const segs = segments(combined, 6);
    let shared = Array.isArray(s.sharedLangs) ? s.sharedLangs.map(clean).filter(Boolean) : null;
    if (!shared) {
      const inB = new Set((lists[1] || []).map((l) => l.lang));
      shared = (lists[0] || []).map((l) => l.lang).filter((l) => l !== 'Other' && inB.has(l));
    }
    const conflicts = (Array.isArray(s.conflicts) ? s.conflicts : []).map((c) => clean(c && c.name)).filter(Boolean);
    const languages = num(s.languages, combined.filter((l) => l.lang !== 'Other').length);
    const sha = /^[0-9a-f]{7,40}$/i.test(String(s.commitSha || '')) ? String(s.commitSha).slice(0, 7).toLowerCase()
      : (seed >>> 0).toString(16).padStart(8, '0').slice(0, 7);
    const cls = s.classification || {};
    return {
      kind: 'merge',
      a, b, seed, sha,
      designation: clean(s.designation) || 'GLX-' + (1000 + (seed % 9000)),
      cls: { emoji: clean(cls.emoji), name: clean(cls.name), blurb: clean(cls.blurb) },
      tiles: [
        { label: 'Repos', value: fmtNum(num(s.totalRepos, stat('repos'))), icon: 'sparkle', color: COL.blue },
        { label: 'Stars', value: fmtNum(num(s.totalStars, stat('stars'))), icon: 'star', color: COL.yellow },
        { label: 'Languages', value: fmtNum(languages), icon: 'code', color: COL.purple },
        { label: 'Conflicts resolved', value: fmtNum(conflicts.length), icon: 'check', color: COL.green }
      ],
      conflicts,
      shared,
      segs,
      langCount: languages,
      palette: paletteOf(segs),
      galaxies: gs
    };
  }

  const isMerge = (opts) => !!(opts.summary || (!opts.galaxy && Array.isArray(opts.galaxies) && opts.galaxies.length >= 2));
  const describe = (opts) => (isMerge(opts) ? describeMerge(opts) : describeSingle(opts.galaxy || (opts.galaxies && opts.galaxies[0])));

  // ------------------------------------------------------------------ galaxy snapshot
  /** Must run synchronously right after render(): the WebGL drawing buffer is not preserved past this task. */
  function snapshot(opts, w, h) {
    const src = opts.glCanvas;
    if (!src) return null;
    try {
      if (typeof opts.render === 'function') opts.render();
    } catch (e) {
      warn(e);
    }
    try {
      const sw = src.width | 0, sh = src.height | 0;
      if (sw < 2 || sh < 2) return null;
      const c = makeCanvas(w, h);
      const ctx = c.getContext('2d');
      const s = Math.max(w / sw, h / sh) * ZOOM;
      const cw = Math.min(sw, w / s), ch = Math.min(sh, h / s);
      const sx = (sw - cw) / 2;
      const sy = clamp((sh - ch) / 2 + sh * BIAS, 0, sh - ch);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, sx, sy, cw, ch, 0, 0, w, h);
      return c;
    } catch (e) {
      warn(e);
      return null;
    }
  }
  /** True when the snapshot holds nothing but background (e.g. lost context, cleared buffer). */
  function isBlank(c) {
    try {
      const t = makeCanvas(48, 48);
      const x = t.getContext('2d');
      x.drawImage(c, 0, 0, 48, 48);
      const d = x.getImageData(0, 0, 48, 48).data;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
      return max < 16;
    } catch (e) {
      return false;
    }
  }

  /** Procedural stand-in when no usable WebGL frame exists: projects the model's particles + stars. */
  function paintFallbackGalaxy(ctx, w, h, m) {
    const rnd = GLX.util.rng((m.seed ^ 0x9e3779b9) >>> 0);
    for (let i = 0; i < 900; i++) {
      const a = 0.08 + Math.pow(rnd(), 4) * 0.6, r = 0.3 + rnd() * 0.8;
      ctx.fillStyle = 'rgba(214,226,255,' + a.toFixed(3) + ')';
      ctx.fillRect(rnd() * w, rnd() * h, r * 1.6, r * 1.6);
    }
    const gals = (m.galaxies || []).filter(Boolean);
    const n = m.kind === 'merge' ? 2 : 1;
    const S = Math.min(w, h) * (n > 1 ? 0.3 : 0.44);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let gi = 0; gi < n; gi++) {
      const g = gals[gi];
      const cx = w / 2 + (n > 1 ? (gi ? 1 : -1) * S * 0.7 : 0);
      const cy = h * 0.46 + (n > 1 ? (gi ? -1 : 1) * S * 0.14 : 0);
      const yaw = 0.6 + gi * 2.1, pitch = n > 1 ? (gi ? 1.05 : 0.55) : 0.72;
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
      const P = g && g.particles;
      if (P && P.pos && P.color && P.count > 0) {
        const step = Math.max(1, Math.floor(P.count / 20000));
        for (let i = 0; i < P.count; i += step) {
          const x = P.pos[3 * i], y = P.pos[3 * i + 1], z = P.pos[3 * i + 2];
          const px = cx + (x * cyw - z * syw) * S, py = cy + ((x * syw + z * cyw) * sp - y * cp) * S;
          const sz = P.meta ? 0.9 + P.meta[3 * i] * 0.55 : 1.4;
          const al = clamp(P.color[4 * i + 3] * 0.5, 0, 1);
          ctx.fillStyle = 'rgba(' + ((P.color[4 * i] * 255) | 0) + ',' + ((P.color[4 * i + 1] * 255) | 0) + ',' +
            ((P.color[4 * i + 2] * 255) | 0) + ',' + al.toFixed(3) + ')';
          ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        }
      }
      if (g && Array.isArray(g.stars)) {
        for (const st of g.stars) {
          if (!st || !st.pos || !st.color) continue;
          const x = st.pos[0], y = st.pos[1], z = st.pos[2];
          const px = cx + (x * cyw - z * syw) * S, py = cy + ((x * syw + z * cyw) * sp - y * cp) * S;
          softGlow(ctx, px, py, 4 + num(st.size, 0.012) * S * 0.5, st.color, st.isFork ? 0.25 : 0.7);
        }
      }
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.4);
      core.addColorStop(0, 'rgba(255,246,232,0.95)');
      core.addColorStop(0.08, 'rgba(255,230,200,0.6)');
      core.addColorStop(0.3, 'rgba(190,170,255,0.14)');
      core.addColorStop(1, 'rgba(120,140,255,0)');
      ctx.fillStyle = core;
      ctx.fillRect(cx - S, cy - S, S * 2, S * 2);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ avatars
  function avatarSrc(url) {
    url = String(url);
    if (!/^https?:/i.test(url)) return url;
    if (/[?&]s=\d+/.test(url)) return url.replace(/([?&]s=)\d+/, '$1200');
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 's=200';
  }
  function isClean(img) {
    try {
      const c = makeCanvas(2, 2);
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, 2, 2);
      x.getImageData(0, 0, 1, 1);
      return true;
    } catch (e) {
      return false;
    }
  }
  /** Resolves to a CORS-clean loaded image, or null (no url, error, timeout or tainting image). Never rejects. */
  function loadAvatar(url) {
    return new Promise((resolve) => {
      if (!url || typeof Image !== 'function') return resolve(null);
      const img = new Image();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(ok && (img.naturalWidth || img.width) > 0 && isClean(img) ? img : null);
      };
      const timer = setTimeout(() => finish(false), AVATAR_TIMEOUT_MS);
      try {
        img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        img.onload = () => finish(true);
        img.onerror = () => finish(false);
        img.src = avatarSrc(url);
      } catch (e) {
        finish(false);
      }
    });
  }
  function initialsOf(name, login) {
    const first = (w) => Array.from(w)[0] || '';
    const words = clean(name).split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w));
    const s = words.length >= 2 ? first(words[0]) + first(words[1]) : words.length ? first(words[0]) : first(clean(login) || '?');
    return s.toUpperCase();
  }
  function ringStyle(ctx, cx, cy, r, colors) {
    if (typeof ctx.createConicGradient === 'function') {
      const g = ctx.createConicGradient(-Math.PI / 2, cx, cy);
      const cs = colors.concat([colors[0]]);
      cs.forEach((c, i) => g.addColorStop(i / (cs.length - 1), c));
      return g;
    }
    return grad(ctx, cx - r, cy - r, cx + r, cy + r, colors);
  }
  function drawAvatar(ctx, cx, cy, r, img, who, colors) {
    ctx.save();
    shadow(ctx, rgba(colors[0], 0.5), 34);
    circle(ctx, cx, cy, r + 11);
    ctx.fillStyle = BG;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = ringStyle(ctx, cx, cy, r + 6.5, colors);
    circle(ctx, cx, cy, r + 6.5);
    ctx.stroke();
    circle(ctx, cx, cy, r);
    ctx.clip();
    if (img) {
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const s = Math.max((2 * r) / iw, (2 * r) / ih);
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, cx - (iw * s) / 2, cy - (ih * s) / 2, iw * s, ih * s);
    } else {
      const hue = GLX.util.hashStr(who.login.toLowerCase()) % 360;
      ctx.fillStyle = grad(ctx, cx - r, cy - r, cx + r, cy + r, [
        'hsl(' + hue + ',70%,60%)', 'hsl(' + ((hue + 48) % 360) + ',66%,46%)', 'hsl(' + ((hue + 96) % 360) + ',62%,30%)'
      ]);
      ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
      const hl = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, 0, cx - r * 0.35, cy - r * 0.45, r * 1.2);
      hl.addColorStop(0, 'rgba(255,255,255,0.32)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl;
      ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
      const ini = initialsOf(who.name, who.login);
      const size = Math.round(r * (Array.from(ini).length > 1 ? 0.74 : 0.9));
      ctx.font = font(800, size);
      const tm = ctx.measureText(ini);
      const asc = tm.actualBoundingBoxAscent, desc = tm.actualBoundingBoxDescent || 0;
      const ty = asc > 0 ? cy + (asc - desc) / 2 : cy + size * 0.36;
      shadow(ctx, 'rgba(0,0,0,0.35)', 10, 0, 2);
      text(ctx, ini, cx, ty, { font: font(800, size), color: '#ffffff', align: 'center' });
    }
    ctx.restore();

    ctx.save();
    circle(ctx, cx, cy, r);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ painting: background, chart, frame, footer
  function paintSpace(ctx, L, m, snap) {
    const { W, H, GH } = L;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    if (snap) ctx.drawImage(snap, 0, 0, W, GH);
    else guard(ctx, () => paintFallbackGalaxy(ctx, W, GH, m));

    const vx = W / 2, vy = GH * 0.44;
    const vg = ctx.createRadialGradient(vx, vy, GH * 0.24, vx, vy, Math.hypot(W / 2, GH * 0.6));
    vg.addColorStop(0, 'rgba(3,5,11,0)');
    vg.addColorStop(0.62, 'rgba(3,5,11,0.16)');
    vg.addColorStop(1, 'rgba(3,5,11,0.74)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, GH);
    ctx.fillStyle = grad(ctx, 0, 0, 0, 180, ['rgba(3,5,11,0.62)', 'rgba(3,5,11,0)']);
    ctx.fillRect(0, 0, W, 180);

    const f0 = GH - 340;
    const fg = ctx.createLinearGradient(0, f0, 0, GH);
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      fg.addColorStop(t, 'rgba(3,5,11,' + (t * t * (3 - 2 * t)).toFixed(4) + ')');
    }
    ctx.fillStyle = fg;
    ctx.fillRect(0, f0, W, GH - f0 + 1);
    ctx.fillStyle = BG;
    ctx.fillRect(0, GH, W, H - GH);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pal = m.palette;
    softGlow(ctx, W * 0.1, H - 40, 560, pal[0], 0.085);
    softGlow(ctx, W * 0.94, GH + 130, 520, pal[1], 0.07);
    softGlow(ctx, W * 0.56, H + 160, 620, pal[2], 0.06);
    ctx.restore();

    const rnd = GLX.util.rng((m.seed ^ 0x5bd1e995) >>> 0);
    const top = GH - 300;
    const tints = ['255,255,255', '206,224,255', '255,238,214', '222,210,255'];
    for (let i = 0; i < 460; i++) {
      const x = rnd() * W, y = top + rnd() * (H - top);
      const a = (0.1 + Math.pow(rnd(), 3) * 0.72) * smooth(top, GH + 40, y);
      const r = 0.35 + Math.pow(rnd(), 2.2) * 1.05;
      const tint = tints[(rnd() * tints.length) | 0];
      if (a < 0.02) continue;
      ctx.fillStyle = 'rgba(' + tint + ',' + a.toFixed(3) + ')';
      circle(ctx, x, y, r);
      ctx.fill();
    }
    for (let i = 0; i < 9; i++) {
      const x = 40 + rnd() * (W - 80), y = GH - 40 + rnd() * (H - GH - 20), r = 3 + rnd() * 4;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      softGlow(ctx, x, y, r * 2.2, [0.85, 0.9, 1], 0.22);
      sparkle(ctx, x, y, r, 'rgba(235,242,255,' + (0.35 + rnd() * 0.3).toFixed(3) + ')');
      ctx.restore();
    }
  }

  function paintChart(ctx, L, m) {
    const { W, H, GH, F, M } = L;
    for (let i = 0, y = F + 36; y < GH - 70; i++, y += 20) {
      const major = i % 5 === 0;
      const a = (major ? 0.34 : 0.15) * (1 - smooth(GH * 0.5, GH - 70, y));
      if (a < 0.01) continue;
      const len = major ? 12 : 6;
      ctx.fillStyle = 'rgba(230,237,243,' + a.toFixed(3) + ')';
      ctx.fillRect(F, y, len, 1);
      ctx.fillRect(W - F - len, y, len, 1);
    }
    for (let i = 0, x = F + 36; x < W - F - 30; i++, x += 20) {
      const major = i % 5 === 0;
      ctx.fillStyle = major ? 'rgba(230,237,243,0.3)' : 'rgba(230,237,243,0.13)';
      ctx.fillRect(x, F, 1, major ? 10 : 5);
    }
    const b = F + 14, l = 22;
    ctx.strokeStyle = 'rgba(230,237,243,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(b, b + l); ctx.lineTo(b, b); ctx.lineTo(b + l, b);
    ctx.moveTo(W - b - l, b); ctx.lineTo(W - b, b); ctx.lineTo(W - b, b + l);
    ctx.moveTo(b, H - b - l); ctx.lineTo(b, H - b); ctx.lineTo(b + l, H - b);
    ctx.moveTo(W - b - l, H - b); ctx.lineTo(W - b, H - b); ctx.lineTo(W - b, H - b - l);
    ctx.stroke();

    const ty = F + 54;
    const when = GLX.util.fmtDate(Date.now()).toUpperCase();
    ctx.save();
    shadow(ctx, rgba(COL.purple, 0.7), 12);
    sparkle(ctx, M + 7, ty - 6, 8.5, grad(ctx, M - 2, ty - 15, M + 16, ty + 3, [COL.blue, COL.coral]));
    ctx.restore();
    text(ctx, 'GITLAXY', M + 24, ty, { font: font(800, 15), spacing: 4.5, gradient: GRAD });
    text(ctx, (m.kind === 'merge' ? 'MERGER EVENT · ' : 'STAR CHART · ') + when, M, ty + 22,
      { font: font(500, 11.5, MONO), spacing: 2, color: 'rgba(230,237,243,0.5)' });
    if (m.kind === 'merge') {
      text(ctx, '$ git merge -s gravity', W - M, ty, { align: 'right', font: font(600, 13, MONO), spacing: 0.5, color: 'rgba(230,237,243,0.8)' });
      text(ctx, '2 GALAXIES → 1 REMNANT', W - M, ty + 22, { align: 'right', font: font(500, 11, MONO), spacing: 2, color: 'rgba(230,237,243,0.45)' });
    } else {
      if (m.epoch) {
        text(ctx, 'EPOCH ' + m.epoch[0] + ' → ' + m.epoch[1], W - M, ty,
          { align: 'right', font: font(600, 12.5, MONO), spacing: 2, color: 'rgba(230,237,243,0.8)' });
      }
      text(ctx, 'RADIUS = TIME · CORE = OLDEST', W - M, ty + 22, { align: 'right', font: font(500, 11, MONO), spacing: 1.8, color: 'rgba(230,237,243,0.45)' });
    }
  }

  function paintFrame(ctx, L) {
    const { W, H, F } = L;
    rr(ctx, F + 0.75, F + 0.75, W - 2 * F - 1.5, H - 2 * F - 1.5, 26);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = grad(ctx, 0, 0, W, H, ['rgba(121,192,255,0.8)', 'rgba(210,168,255,0.42)', 'rgba(255,123,114,0.75)']);
    ctx.stroke();
    rr(ctx, 5.5, 5.5, W - 11, H - 11, 34);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(240,246,252,0.07)';
    ctx.stroke();
  }

  function paintFooter(ctx, L, m) {
    const { W, H, F, M } = L;
    const y = H - F - 30;
    ctx.fillStyle = grad(ctx, M, 0, W - M, 0, ['rgba(240,246,252,0)', 'rgba(240,246,252,0.18)', 'rgba(240,246,252,0)']);
    ctx.fillRect(M, y - 34, W - 2 * M, 1);
    ctx.save();
    shadow(ctx, rgba(COL.purple, 0.6), 10);
    sparkle(ctx, M + 7, y - 6, 7.5, grad(ctx, M, y - 14, M + 14, y + 2, [COL.blue, COL.coral]));
    ctx.restore();
    let x = M + 22;
    x += text(ctx, 'gitlaxy', x, y, { font: font(800, 16), gradient: GRAD, spacing: 0.2 });
    x += text(ctx, '  ·  every repo is a star', x, y, { font: font(500, 15), color: COL.muted });
    const left = x;

    const fr = font(500, 14);
    ctx.font = fr;
    const tail = 'GitHub Copilot';
    const head = GLX.util.fmtDateLong(Date.now()) + '  ·  made with ';
    const tw = measure(ctx, tail, 0), hw = measure(ctx, head, 0);
    text(ctx, head, W - M - tw - hw, y, { font: fr, color: COL.faint });
    text(ctx, tail, W - M - tw, y, { font: font(600, 14), color: COL.soft });
    const rightStart = W - M - tw - hw;

    if (m.kind === 'single') {
      const cf = font(500, 13, MONO), cs = 'github.com/' + m.login;
      ctx.font = cf;
      const cw = measure(ctx, cs, 0.4);
      if (cw + 80 < rightStart - left) {
        text(ctx, cs, (left + rightStart) / 2, y, { align: 'center', font: cf, spacing: 0.4, color: 'rgba(230,237,243,0.38)' });
      }
    }
  }

  // ------------------------------------------------------------------ panel building blocks
  function drawCatalog(ctx, right, y, des, seed) {
    const df = font(600, 30, MONO), lf = font(700, 11.5);
    ctx.font = df;
    const dw = measure(ctx, des, 1);
    ctx.font = lf;
    const w = Math.max(dw, measure(ctx, 'CATALOG NO.', 2.4), 150);
    text(ctx, 'CATALOG NO.', right, y, { align: 'right', font: lf, spacing: 2.4, color: COL.muted });
    ctx.save();
    shadow(ctx, 'rgba(0,0,0,0.6)', 14, 0, 2);
    text(ctx, des, right, y + 36, { align: 'right', font: df, spacing: 1, color: COL.text });
    ctx.restore();
    const rnd = GLX.util.rng((seed ^ 0x2545f491) >>> 0);
    ctx.fillStyle = 'rgba(230,237,243,0.4)';
    for (let x = right - w; ;) {
      const bw = rnd() < 0.3 ? 2.5 : 1;
      if (x + bw > right) break;
      ctx.fillRect(x, y + 50, bw, rnd() < 0.14 ? 23 : 18);
      x += bw + 1.5 + Math.floor(rnd() * 3);
    }
    return w;
  }

  function drawBadge(ctx, label, x, cy, color) {
    const f = font(800, 11);
    ctx.font = f;
    const w = measure(ctx, label, 1.6) + 16, h = 21;
    rr(ctx, x, cy - h / 2, w, h, 6);
    ctx.fillStyle = rgba(color, 0.14);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    text(ctx, label, x + 8, cy + 4, { font: f, spacing: 1.6, color });
    return w;
  }

  function loginWidth(ctx, login, size) {
    ctx.font = font(800, size);
    return measure(ctx, '@', 0) + size * 0.03 + measure(ctx, login, -size * 0.015);
  }
  function drawLogin(ctx, login, x, y, size, maxW) {
    const f = font(800, size), sp = -size * 0.015;
    ctx.font = f;
    const aw = measure(ctx, '@', 0) + size * 0.03;
    const s = maxW ? ellipsize(ctx, login, maxW - aw, sp) : login;
    text(ctx, '@', x, y, { font: f, color: 'rgba(230,237,243,0.42)' });
    return aw + text(ctx, s, x + aw, y, { font: f, color: '#ffffff', spacing: sp });
  }

  function drawBar(ctx, x, y, w, h, segs) {
    rr(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    if (!segs.length) return;
    const total = segs.reduce((s, g) => s + g.share, 0) || 1;
    ctx.save();
    let cx = x;
    for (const s of segs) {
      const sw = (s.share / total) * w;
      shadow(ctx, rgba(s.rgb, 0.55), 16);
      ctx.shadowOffsetX = 20000 * K; // draw only the glow: shape off-canvas, shadow shifted back on
      ctx.fillStyle = '#000';
      ctx.fillRect(cx - 20000, y + 1, sw, h - 2);
      cx += sw;
    }
    ctx.restore();
    ctx.save();
    rr(ctx, x, y, w, h, h / 2);
    ctx.clip();
    cx = x;
    segs.forEach((s, i) => {
      const sw = (s.share / total) * w;
      ctx.fillStyle = grad(ctx, 0, y, 0, y + h, [rgba(GLX.color.mix(s.rgb, [1, 1, 1], 0.3), 1), rgba(s.rgb, 1)]);
      ctx.fillRect(cx, y, sw + 0.5, h);
      if (i > 0) {
        ctx.fillStyle = BG;
        ctx.fillRect(cx - 1, y, 2, h);
      }
      cx += sw;
    });
    ctx.fillStyle = grad(ctx, 0, y, 0, y + h, ['rgba(255,255,255,0.24)', 'rgba(255,255,255,0)', 'rgba(0,0,0,0.14)']);
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  function glowDot(ctx, x, y, r, rgb) {
    ctx.save();
    shadow(ctx, rgba(rgb, 0.9), 8);
    circle(ctx, x, y, r);
    ctx.fillStyle = rgba(rgb, 1);
    ctx.fill();
    ctx.restore();
  }

  const pct = (share) => (share > 0 && share < 0.005 ? '<1%' : Math.round(share * 100) + '%');

  // Sections are { h, priority, draw(y) } stacked by flow(); low-priority ones are dropped when space runs out.
  function classSection(ctx, x, w, cls, prefix) {
    if (!cls.name && !cls.blurb) return null;
    const pillH = 46, padX = 20;
    const pf = font(700, 11.5), nf = font(600, 21), ef = font(400, 21);
    ctx.font = pf;
    const pw = prefix ? measure(ctx, prefix, 2) + 14 : 0;
    ctx.font = ef;
    const ew = cls.emoji ? measure(ctx, cls.emoji, 0) + 10 : 0;
    ctx.font = nf;
    const name = ellipsize(ctx, cls.name || 'Uncharted Galaxy', Math.max(80, w * 0.6 - pw - ew - padX * 2), 0);
    const pillW = padX * 2 + pw + ew + measure(ctx, name, 0);
    const bf = font(400, 18), lh = 25;
    let lines = [], below = false;
    if (cls.blurb) {
      ctx.font = bf;
      const bw = w - pillW - 26;
      if (bw >= 300) lines = wrap(ctx, cls.blurb, bw, 2, 0);
      else {
        below = true;
        lines = wrap(ctx, cls.blurb, w, 2, 0);
      }
    }
    const h = below ? pillH + 12 + lines.length * lh : Math.max(pillH, lines.length * lh);
    return {
      h, priority: 5,
      draw(y) {
        const cy = y + (below ? pillH / 2 : h / 2);
        rr(ctx, x, cy - pillH / 2, pillW, pillH, pillH / 2);
        ctx.fillStyle = grad(ctx, x, 0, x + pillW, 0, ['rgba(121,192,255,0.17)', 'rgba(210,168,255,0.12)', 'rgba(255,123,114,0.13)']);
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = grad(ctx, x, 0, x + pillW, 0, ['rgba(121,192,255,0.7)', 'rgba(210,168,255,0.45)', 'rgba(255,123,114,0.6)']);
        ctx.stroke();
        let px = x + padX;
        if (prefix) {
          text(ctx, prefix, px, cy + 4.5, { font: pf, spacing: 2, color: 'rgba(230,237,243,0.55)' });
          px += pw;
        }
        if (cls.emoji) {
          text(ctx, cls.emoji, px, cy + 7.5, { font: ef });
          px += ew;
        }
        text(ctx, name, px, cy + 7.5, { font: nf, color: COL.text });
        const bx = below ? x : x + pillW + 26;
        const by = below ? y + pillH + 12 + 18 : cy - (lines.length * lh) / 2 + 18;
        lines.forEach((ln, i) => text(ctx, ln, bx, by + i * lh, { font: bf, color: COL.soft }));
      }
    };
  }

  function tilesSection(ctx, x, w, tiles) {
    const h = 112;
    return {
      h, priority: 4,
      draw(y) {
        const n = tiles.length, gap = 14, tw = (w - gap * (n - 1)) / n;
        tiles.forEach((t, i) => {
          const tx = x + i * (tw + gap);
          ctx.save();
          rr(ctx, tx, y, tw, h, 16);
          ctx.fillStyle = grad(ctx, 0, y, 0, y + h, ['rgba(255,255,255,0.065)', 'rgba(255,255,255,0.02)']);
          ctx.fill();
          ctx.strokeStyle = 'rgba(240,246,252,0.1)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = grad(ctx, tx + 16, 0, tx + tw - 16, 0, [rgba(t.color, 0), rgba(t.color, 0.9), rgba(t.color, 0)]);
          ctx.fillRect(tx + 16, y - 0.5, tw - 32, 1.5);
          softGlow(ctx, tx + tw / 2, y, tw * 0.42, GLX.color.hexToRgb(t.color), 0.07);
          ctx.restore();
          drawIcon(ctx, t.icon, tx + tw - 40, y + 18, 20, t.color);
          const vs = fitSize(46, 24, (s) => {
            ctx.font = font(800, s);
            return measure(ctx, t.value, -0.5);
          }, tw - 72);
          ctx.save();
          shadow(ctx, rgba(t.color, 0.22), 18);
          text(ctx, t.value, tx + 20, y + 64, { font: font(800, vs), color: '#ffffff', spacing: -0.5 });
          ctx.restore();
          text(ctx, t.label.toUpperCase(), tx + 20, y + h - 22, { font: font(700, 12), spacing: 1.6, color: COL.muted, maxWidth: tw - 36 });
        });
      }
    };
  }

  function langSection(ctx, x, w, m) {
    const segs = m.segs;
    const nf = font(600, 15), pf = font(500, 15), gap = 28;
    const items = segs.map((s) => {
      ctx.font = nf;
      const nw = measure(ctx, s.lang, 0);
      ctx.font = pf;
      const pw = measure(ctx, pct(s.share), 0);
      return { s, nw, w: 10 + 9 + nw + 7 + pw };
    });
    const rows = [[]];
    let rw = 0;
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row.length && rw + gap + it.w > w) {
        if (rows.length === 2) break;
        rows.push([it]);
        rw = it.w;
      } else {
        rw += (row.length ? gap : 0) + it.w;
        row.push(it);
      }
    }
    const h = rows.length > 1 ? 98 : 72;
    return {
      h, priority: 3,
      draw(y) {
        text(ctx, 'LANGUAGE ARMS', x, y + 12, { font: font(700, 12), spacing: 2, color: COL.muted });
        text(ctx, m.langCount ? plural(m.langCount, 'language') + ' · by repository count' : '', x + w, y + 12,
          { align: 'right', font: font(500, 13), color: COL.faint });
        drawBar(ctx, x, y + 24, w, 12, segs);
        if (!segs.length) {
          text(ctx, 'No languages yet — a primordial cloud of pure potential.', x, y + 66, { font: font(400, 15), color: COL.soft, maxWidth: w });
          return;
        }
        rows.forEach((row, r) => {
          let lx = x;
          const ly = y + 66 + r * 26;
          for (const it of row) {
            glowDot(ctx, lx + 5, ly - 5, 5, it.s.rgb);
            text(ctx, it.s.lang, lx + 19, ly, { font: nf, color: COL.text });
            text(ctx, pct(it.s.share), lx + 19 + it.nw + 7, ly, { font: pf, color: COL.muted });
            lx += it.w + gap;
          }
        });
      }
    };
  }

  function factsSection(ctx, x, w, facts) {
    if (!facts.length) return null;
    const n = facts.length, gap = 36, cw = (w - gap * (n - 1)) / n;
    return {
      h: 80, priority: 2,
      draw(y) {
        facts.forEach((f, i) => {
          const fx = x + i * (cw + gap);
          if (i > 0) {
            ctx.fillStyle = 'rgba(240,246,252,0.09)';
            ctx.fillRect(fx - gap / 2, y + 2, 1, 76);
          }
          ctx.save();
          shadow(ctx, rgba(f.color, 0.9), 8);
          ctx.translate(fx + 5, y + 7.5);
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = f.color;
          ctx.fillRect(-3.5, -3.5, 7, 7);
          ctx.restore();
          text(ctx, f.label.toUpperCase(), fx + 18, y + 12, { font: font(700, 12), spacing: 1.8, color: COL.muted, maxWidth: cw - 18 });
          text(ctx, f.text, fx, y + 46, { font: font(700, 23), color: COL.text, maxWidth: cw });
          text(ctx, f.value, fx, y + 72, { font: font(500, 16), color: COL.soft, maxWidth: cw });
        });
      }
    };
  }

  function terminalLines(m, maxLines) {
    const out = [[{ t: '$ ', c: COL.green, bold: true }, { t: 'git merge @' + m.b.login, c: COL.text }]];
    const n = m.conflicts.length;
    const room = Math.max(0, maxLines - 2);
    let shown = Math.min(n, room);
    if (n > shown) shown = Math.max(0, room - 1);
    for (let i = 0; i < shown; i++) {
      out.push([{ t: 'CONFLICT (gravity): ', c: COL.red, bold: true }, { t: 'Merge conflict in ' + m.conflicts[i], c: COL.soft }]);
    }
    if (n > shown) out.push([{ t: '… and ' + plural(n - shown, 'more conflict'), c: COL.faint }]);
    out.push(n
      ? [{ t: 'Auto-resolved ✓ ', c: COL.green, bold: true }, { t: plural(n, 'conflict') + ' settled by gravity', c: COL.faint }]
      : [{ t: 'Clean merge ✓ ', c: COL.green, bold: true }, { t: 'no conflicts', c: COL.faint }]);
    return out.slice(0, maxLines);
  }

  function drawTerminal(ctx, x, y, w, h, m) {
    ctx.save();
    shadow(ctx, 'rgba(0,0,0,0.55)', 26, 0, 10);
    rr(ctx, x, y, w, h, 14);
    ctx.fillStyle = 'rgba(2,5,11,0.86)';
    ctx.fill();
    ctx.restore();
    ctx.save();
    rr(ctx, x, y, w, h, 14);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.fillRect(x, y, w, 32);
    ctx.fillStyle = 'rgba(240,246,252,0.08)';
    ctx.fillRect(x, y + 32, w, 1);
    ctx.restore();
    rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 14);
    ctx.strokeStyle = 'rgba(240,246,252,0.13)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
      circle(ctx, x + 18 + i * 18, y + 16, 5);
      ctx.fillStyle = c;
      ctx.fill();
    });
    text(ctx, '~/universe — git merge', x + w / 2, y + 20.5, { align: 'center', font: font(500, 12, MONO), color: COL.faint });
    const fs = 14.5, lh = 24;
    const lines = terminalLines(m, Math.max(2, Math.floor((h - 32 - 18) / lh)));
    let ly = y + 32 + 28;
    for (const parts of lines) {
      let lx = x + 18;
      for (const p of parts) {
        const avail = x + w - 18 - lx;
        if (avail < 12) break;
        lx += text(ctx, p.t, lx, ly, { font: font(p.bold ? 700 : 500, fs, MONO), color: p.c, maxWidth: avail });
      }
      ly += lh;
    }
  }

  function drawShared(ctx, x, y, w, h, m) {
    text(ctx, 'SHARED LANGUAGES', x, y + 12, { font: font(700, 12), spacing: 2, color: COL.muted });
    text(ctx, String(m.shared.length), x + w, y + 12, { align: 'right', font: font(700, 13, MONO), color: COL.faint });
    const cf = font(600, 15), ch = 32, padX = 13, dotR = 4.5, gx = 10, gy = 10, maxRows = 2;
    const cy0 = y + 28;
    if (!m.shared.length) {
      ctx.font = font(400, 16);
      wrap(ctx, 'No shared languages — opposites attract.', w, 2, 0)
        .forEach((ln, i) => text(ctx, ln, x, cy0 + 22 + i * 24, { font: font(400, 16), color: COL.soft }));
    } else {
      ctx.font = cf;
      const items = m.shared.map((n) => ({ n, w: Math.min(w, padX * 2 + dotR * 2 + 9 + measure(ctx, n, 0)) }));
      const place = [];
      let row = 0, cx = 0, i = 0;
      for (; i < items.length; i++) {
        if (cx > 0 && cx + items[i].w > w) {
          row++;
          cx = 0;
        }
        if (row >= maxRows) break;
        place.push({ it: items[i], x: cx, row, w: items[i].w });
        cx += items[i].w + gx;
      }
      if (i < items.length) {
        let rest = items.length - place.length;
        const moreW = (k) => padX * 2 + measure(ctx, '+' + k, 0);
        while (place.length) {
          const last = place[place.length - 1];
          const ex = last.x + last.w + gx;
          if (ex + moreW(rest) <= w) {
            place.push({ more: '+' + rest, x: ex, row: last.row, w: moreW(rest) });
            break;
          }
          place.pop();
          rest++;
        }
      }
      for (const p of place) {
        const px = x + p.x, py = cy0 + p.row * (ch + gy);
        rr(ctx, px, py, p.w, ch, ch / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fill();
        ctx.lineWidth = 1;
        if (p.more) {
          ctx.strokeStyle = 'rgba(240,246,252,0.14)';
          ctx.stroke();
          text(ctx, p.more, px + padX, py + ch / 2 + 5.5, { font: cf, color: COL.muted });
          continue;
        }
        const rgb = GLX.color.langColor(p.it.n);
        ctx.strokeStyle = rgba(rgb, 0.45);
        ctx.stroke();
        glowDot(ctx, px + padX + dotR, py + ch / 2, dotR, rgb);
        text(ctx, p.it.n, px + padX + dotR * 2 + 9, py + ch / 2 + 5.5, { font: cf, color: COL.text, maxWidth: p.w - (padX * 2 + dotR * 2 + 9) + 4 });
      }
    }
    if (m.segs.length) {
      const sy = y + h - 30;
      text(ctx, 'COMBINED SPECTRUM', x, sy, { font: font(700, 12), spacing: 2, color: COL.muted });
      text(ctx, plural(m.langCount, 'language'), x + w, sy, { align: 'right', font: font(500, 13), color: COL.faint });
      drawBar(ctx, x, sy + 12, w, 10, m.segs);
    }
  }

  function mergeSection(ctx, x, w, m) {
    const h = 196, lw = Math.round(w * 0.56), gap = 30;
    return {
      h, priority: 3,
      draw(y) {
        drawTerminal(ctx, x, y, lw, h, m);
        drawShared(ctx, x + lw + gap, y, w - lw - gap, h, m);
      }
    };
  }

  /** Stacks sections between top and bottom with even gaps (dropping low-priority ones if cramped). */
  function flow(top, bottom, sections) {
    const list = sections.filter((s) => s && s.h > 0);
    const minGap = 14;
    const total = () => list.reduce((t, s) => t + s.h, 0);
    while (list.length > 1 && total() + minGap * (list.length + 1) > bottom - top) {
      let worst = 0;
      for (let i = 1; i < list.length; i++) if (list[i].priority < list[worst].priority) worst = i;
      list.splice(worst, 1);
    }
    const gap = clamp((bottom - top - total()) / (list.length + 1), minGap, 40);
    let y = top + Math.max(0, (bottom - top - total() - gap * (list.length - 1)) / 2);
    for (const s of list) {
      s.draw(Math.round(y));
      y += s.h + gap;
    }
  }

  // ------------------------------------------------------------------ panels
  function paintSingle(ctx, L, m, avatar) {
    const { W, H, GH, F, M } = L;
    const right = W - M;
    const hy = GH - 128;
    const ar = 72;
    drawAvatar(ctx, M + ar, hy + 16, ar, avatar, m, GRAD);
    const tx = M + ar * 2 + 42;
    const catW = drawCatalog(ctx, right, hy - 34, m.designation, m.seed);
    const maxW = right - catW - 44 - tx;

    const size = fitSize(80, 40, (s) => loginWidth(ctx, m.login, s), maxW);
    ctx.save();
    shadow(ctx, 'rgba(0,0,0,0.6)', 22, 0, 3);
    drawLogin(ctx, m.login, tx, hy + 8, size, maxW);
    ctx.restore();

    const badges = [];
    if (m.isOrg) badges.push(['ORG', COL.purple]);
    if (m.isDemo) badges.push(['DEMO', COL.yellow]);
    ctx.font = font(800, 11);
    const badgeW = badges.reduce((t, b) => t + measure(ctx, b[0], 1.6) + 16 + 10, 0);
    const showName = m.name && m.name.toLowerCase() !== m.login.toLowerCase();
    const nameStr = showName ? m.name : 'github.com/' + m.login;
    ctx.save();
    shadow(ctx, 'rgba(0,0,0,0.6)', 14, 0, 2);
    const nw = text(ctx, nameStr, tx, hy + 50, { font: font(500, 27), color: showName ? COL.soft : COL.muted, maxWidth: maxW - badgeW });
    ctx.restore();
    let bx = tx + nw + 14;
    for (const [label, color] of badges) bx += drawBadge(ctx, label, bx, hy + 41, color) + 10;

    const meta = [];
    if (m.joined > 0) meta.push('Joined GitHub ' + GLX.util.fmtDate(m.joined));
    if (m.followers >= 0) meta.push(fmtNum(m.followers) + (m.followers === 1 ? ' follower' : ' followers'));
    if (meta.length) text(ctx, meta.join('  ·  '), tx, hy + 84, { font: font(500, 16), color: COL.faint, maxWidth: right - tx });

    const x = M, w = W - 2 * M;
    flow(hy + 108, H - F - 64 - 14, [
      classSection(ctx, x, w, m.cls, ''),
      tilesSection(ctx, x, w, m.tiles),
      langSection(ctx, x, w, m),
      factsSection(ctx, x, w, m.facts)
    ]);
  }

  function drawMergeTitle(ctx, x, y, a, b, maxW) {
    const crossW = (s) => s * 0.92;
    const widthAt = (s) => loginWidth(ctx, a, s) + loginWidth(ctx, b, s) + crossW(s);
    const size = fitSize(72, 36, widthAt, maxW);
    let wa = loginWidth(ctx, a, size), wb = loginWidth(ctx, b, size);
    const avail = maxW - crossW(size);
    if (wa + wb > avail) {
      // Still too wide at the minimum size: give each login a fair share of the width.
      const half = avail / 2;
      if (wa > half && wb > half) wa = wb = half;
      else if (wa > half) wa = avail - wb;
      else wb = avail - wa;
    }
    let cx = x + drawLogin(ctx, a, x, y, size, wa);
    const mx = cx + crossW(size) / 2, my = y - size * 0.34, arm = size * 0.165;
    ctx.save();
    shadow(ctx, rgba(COL.purple, 0.8), 16);
    ctx.lineWidth = size * 0.075;
    ctx.lineCap = 'round';
    ctx.strokeStyle = grad(ctx, mx - arm, my - arm, mx + arm, my + arm, [COL.blue, COL.coral]);
    ctx.beginPath();
    ctx.moveTo(mx - arm, my - arm);
    ctx.lineTo(mx + arm, my + arm);
    ctx.moveTo(mx + arm, my - arm);
    ctx.lineTo(mx - arm, my + arm);
    ctx.stroke();
    ctx.restore();
    cx += crossW(size);
    drawLogin(ctx, b, cx, y, size, wb);
  }

  function paintMerge(ctx, L, m, avatars) {
    const { W, H, GH, F, M } = L;
    const right = W - M;
    const hy = GH - 128;
    const ar = 64, off = ar * 1.42;
    drawAvatar(ctx, M + ar, hy + 18, ar, avatars[0] || null, m.a, GRAD);
    drawAvatar(ctx, M + ar + off, hy + 18, ar, avatars[1] || null, m.b, [COL.coral, COL.purple, COL.blue]);
    const tx = M + ar * 2 + off + 40;
    const catW = drawCatalog(ctx, right, hy - 34, m.designation, m.seed);
    const maxW = right - catW - 40 - tx;

    ctx.save();
    shadow(ctx, 'rgba(0,0,0,0.6)', 22, 0, 3);
    drawMergeTitle(ctx, tx, hy + 6, m.a.login, m.b.login, maxW);
    ctx.restore();
    ctx.save();
    shadow(ctx, 'rgba(0,0,0,0.6)', 12, 0, 2);
    text(ctx, "Merge made by the 'gravity' strategy.", tx, hy + 48, { font: font(500, 24), color: COL.soft, maxWidth: maxW });
    ctx.restore();
    const cf = font(600, 17, MONO);
    const cw = text(ctx, 'commit ' + m.sha, tx, hy + 84, { font: cf, color: COL.yellow });
    text(ctx, ' (HEAD -> main)', tx + cw, hy + 84, { font: font(500, 17, MONO), color: 'rgba(86,212,221,0.85)', maxWidth: right - tx - cw });

    const x = M, w = W - 2 * M;
    flow(hy + 110, H - F - 64 - 14, [
      classSection(ctx, x, w, m.cls, 'REMNANT'),
      tilesSection(ctx, x, w, m.tiles),
      mergeSection(ctx, x, w, m)
    ]);
  }

  function compose(m, snap, avatars, W, H) {
    const cv = makeCanvas(W, H);
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    K = W / BASE_W;
    const L = { W: BASE_W, H: H / K, F: FRAME, M: MARGIN };
    L.GH = Math.round(L.H * GALAXY_FRAC);
    ctx.setTransform(K, 0, 0, K, 0, 0);
    if ('textRendering' in ctx) ctx.textRendering = 'optimizeLegibility';
    ctx.fillStyle = grad(ctx, 0, 0, 0, L.H, ['#0b1020', '#05070d']);
    ctx.fillRect(0, 0, L.W, L.H);
    ctx.save();
    rr(ctx, L.F, L.F, L.W - 2 * L.F, L.H - 2 * L.F, 26);
    ctx.clip();
    guard(ctx, () => paintSpace(ctx, L, m, snap));
    guard(ctx, () => paintChart(ctx, L, m));
    guard(ctx, () => (m.kind === 'merge' ? paintMerge(ctx, L, m, avatars) : paintSingle(ctx, L, m, avatars[0] || null)));
    guard(ctx, () => paintFooter(ctx, L, m));
    ctx.restore();
    guard(ctx, () => paintFrame(ctx, L));
    return cv;
  }

  // ------------------------------------------------------------------ export
  function dataUrlToBlob(canvas) {
    try {
      const url = canvas.toDataURL('image/png');
      const i = url.indexOf(',');
      if (i < 0) return null;
      const bin = atob(url.slice(i + 1));
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      return new Blob([bytes], { type: 'image/png' });
    } catch (e) {
      return null;
    }
  }
  /** PNG Blob of the canvas, or null if it can't be exported (e.g. tainted). Never rejects. */
  function toBlob(canvas) {
    return new Promise((resolve) => {
      try {
        if (typeof canvas.toBlob === 'function') {
          canvas.toBlob((b) => resolve(b || dataUrlToBlob(canvas)), 'image/png');
          return;
        }
      } catch (e) {
        if (e && e.name === 'SecurityError') return resolve(null);
      }
      resolve(dataUrlToBlob(canvas));
    });
  }
  function canvasSize(opts) {
    let w = Math.round(clamp(num(opts.width, BASE_W), 300, 4800));
    let h = Math.round(clamp(num(opts.height, BASE_H), 300, 6000));
    const maxPx = 16e6;
    if (w * h > maxPx) {
      const s = Math.sqrt(maxPx / (w * h));
      w = Math.floor(w * s);
      h = Math.floor(h * s);
    }
    return { w, h };
  }

  async function create(opts) {
    opts = opts || {};
    const { w, h } = canvasSize(opts);
    const k = w / BASE_W;
    // Must happen before any await: render a fresh WebGL frame and copy it in the same task.
    let snap = snapshot(opts, w, Math.round(Math.round((h / k) * GALAXY_FRAC) * k));
    if (snap && isBlank(snap)) snap = null;
    const m = describe(opts);
    const urls = m.kind === 'merge' ? [m.a.avatarUrl, m.b.avatarUrl] : [m.avatarUrl];
    const avatars = await Promise.all(urls.map(loadAvatar));
    let blob = await toBlob(compose(m, snap, avatars, w, h));
    if (!blob && avatars.some(Boolean)) blob = await toBlob(compose(m, snap, [], w, h));
    if (!blob && snap) blob = await toBlob(compose(m, null, [], w, h));
    if (!blob) throw new Error('Could not export the poster image.');
    return blob;
  }

  function download(blob, filename) {
    if (!blob) return;
    let url = '';
    try {
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = String(filename || 'gitlaxy.png');
      a.rel = 'noopener';
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 15000);
    } catch (e) {
      warn(e);
      if (url) {
        try {
          window.open(url, '_blank', 'noopener');
        } catch (_) { /* ignore */ }
      }
    }
  }

  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 39) || 'galaxy';
  function filenameFor(opts) {
    if (isMerge(opts)) {
      const s = opts.summary || {}, gs = opts.galaxies || [];
      const a = (s.a && s.a.login) || (profileOf(gs[0]) || {}).login;
      const b = (s.b && s.b.login) || (profileOf(gs[1]) || {}).login;
      return 'gitlaxy-merge-' + slug(a) + '-' + slug(b) + '.png';
    }
    return 'gitlaxy-' + slug((profileOf(opts.galaxy || (opts.galaxies && opts.galaxies[0])) || {}).login) + '.png';
  }

  async function exportPoster(opts) {
    opts = opts || {};
    const blob = await create(opts);
    GLX.Poster.download(blob, filenameFor(opts));
  }

  GLX.Poster = { create, download, exportPoster };
})();
