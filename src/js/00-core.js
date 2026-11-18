/* Gitlaxy — 00-core.js
 * Shared namespace, config, utilities, math, colors, event bus, render buffers and icons.
 * Every other module depends on this file. It only defines things on window.GLX (no side effects).
 */
(() => {
  'use strict';
  const GLX = (window.GLX = window.GLX || {});
  GLX.version = '1.0.0';

  GLX.config = {
    GALAXY_RADIUS: 1.0,
    MAX_STARS: 300,
    PARTICLES_DESKTOP: 32000,
    PARTICLES_MOBILE: 14000,
    PARTICLES_MERGE_DESKTOP: 14000,
    PARTICLES_MERGE_MOBILE: 6000,
    ROTATION_SPEED: 0.025, // rad/s, single-galaxy mode rotation about +Y
    ARM_TWIST: 4.6, // radians of spiral-arm winding from core (r=0) to rim (r=1)
    MAX_SPRITES: 16000,
    CACHE_TTL_MS: 60 * 60 * 1000
  };

  // ---------------------------------------------------------------- util
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

  /** FNV-1a 32-bit string hash → uint32 */
  function hashStr(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** Seeded PRNG (mulberry32). Returns () => float in [0, 1). */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Standard normal sample using a PRNG from rng(). */
  function gauss(r) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];

  function weightedIndex(r, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let x = r() * total;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i];
      if (x <= 0) return i;
    }
    return weights.length - 1;
  }

  const toMs = (d) => (typeof d === 'number' ? d : Date.parse(d));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** 1234 → '1.2k', 25000 → '25k', 1500000 → '1.5M' */
  function fmtNum(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }
  /** → 'Mar 2016' */
  function fmtDate(d) {
    const t = new Date(toMs(d));
    return MONTHS[t.getMonth()] + ' ' + t.getFullYear();
  }
  /** → 'Mar 12, 2016' */
  function fmtDateLong(d) {
    const t = new Date(toMs(d));
    return MONTHS[t.getMonth()] + ' ' + t.getDate() + ', ' + t.getFullYear();
  }
  /** → '3 days ago' */
  function timeAgo(d, now = Date.now()) {
    const sec = Math.max(0, (now - toMs(d)) / 1000);
    if (sec < 45) return 'just now';
    const table = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, s] of table) {
      const v = Math.floor(sec / s);
      if (v >= 1) return v + ' ' + unit + (v > 1 ? 's' : '') + ' ago';
    }
    return 'just now';
  }

  /**
   * Tiny DOM builder. attrs: class, text, html (TRUSTED static markup only, e.g. GLX.icon()),
   * style (object), on ({event: fn}), dataset (object), any other attribute (true → empty attr).
   * Children: Nodes or strings (strings become text nodes — safe), arrays are flattened, null/false skipped.
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'on') for (const ev in v) node.addEventListener(ev, v[ev]);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : String(c));
    }
    return node;
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  const PREFIX = 'gitlaxy:';
  function makeStore(getStore) {
    return {
      get(key, fallback = null) {
        try {
          const v = getStore().getItem(PREFIX + key);
          return v == null ? fallback : JSON.parse(v);
        } catch (e) {
          return fallback;
        }
      },
      set(key, value) {
        try {
          getStore().setItem(PREFIX + key, JSON.stringify(value));
          return true;
        } catch (e) {
          return false;
        }
      },
      del(key) {
        try {
          getStore().removeItem(PREFIX + key);
        } catch (e) { /* ignore */ }
      }
    };
  }
  /** JSON localStorage wrapper with 'gitlaxy:' prefix; .session uses sessionStorage. Never throws. */
  const storage = makeStore(() => window.localStorage);
  storage.session = makeStore(() => window.sessionStorage);

  const prefersReducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const isMobile = () =>
    !!((window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || Math.min(window.innerWidth || 1e4, window.innerHeight || 1e4) < 560);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  GLX.util = {
    clamp, lerp, smoothstep, easeOutCubic, easeInOutCubic, easeOutExpo,
    hashStr, rng, gauss, pick, weightedIndex, toMs,
    fmtNum, fmtDate, fmtDateLong, timeAgo, MONTHS,
    el, esc, storage, prefersReducedMotion, isMobile, sleep
  };

  // ---------------------------------------------------------------- math (column-major mat4, gl-matrix conventions)
  const math = {
    mat4() {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },
    identity(out) {
      out.fill(0);
      out[0] = out[5] = out[10] = out[15] = 1;
      return out;
    },
    perspective(out, fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      out.fill(0);
      out[0] = f / aspect;
      out[5] = f;
      out[10] = (far + near) * nf;
      out[11] = -1;
      out[14] = 2 * far * near * nf;
      return out;
    },
    lookAt(out, eye, center, up) {
      let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
      let len = Math.hypot(z0, z1, z2);
      if (len < 1e-9) return math.identity(out);
      z0 /= len; z1 /= len; z2 /= len;
      let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
      len = Math.hypot(x0, x1, x2);
      if (len < 1e-9) { x0 = 0; x1 = 0; x2 = 0; } else { x0 /= len; x1 /= len; x2 /= len; }
      const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
      out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
      out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
      out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
      out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
      out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
      out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
      out[15] = 1;
      return out;
    },
    /** out = a × b */
    multiply(out, a, b) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      for (let i = 0; i < 16; i += 4) {
        const b0 = b[i], b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3];
        out[i] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[i + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[i + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[i + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      }
      return out;
    },
    /** Rotation matrix about an arbitrary axis (radians). */
    rotationAxis(out, axis, rad) {
      let x = axis[0], y = axis[1], z = axis[2];
      const len = Math.hypot(x, y, z) || 1;
      x /= len; y /= len; z /= len;
      const s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
      out[0] = x * x * t + c; out[1] = y * x * t + z * s; out[2] = z * x * t - y * s; out[3] = 0;
      out[4] = x * y * t - z * s; out[5] = y * y * t + c; out[6] = z * y * t + x * s; out[7] = 0;
      out[8] = x * z * t + y * s; out[9] = y * z * t - x * s; out[10] = z * z * t + c; out[11] = 0;
      out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
      return out;
    },
    rotationY(out, rad) {
      return math.rotationAxis(out, [0, 1, 0], rad);
    },
    translation(out, x, y, z) {
      math.identity(out);
      out[12] = x; out[13] = y; out[14] = z;
      return out;
    },
    /** Affine transform of a point (w = 1, no perspective divide). out may be any 3-array. */
    transformPoint(out, m, x, y, z) {
      out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      return out;
    },
    /** Full vec4 transform. */
    transformVec4(out, m, x, y, z, w) {
      out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
      out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
      out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
      out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
      return out;
    },
    v3: {
      add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
      sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
      scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
      dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
      cross: (o, a, b) => {
        const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
        o[0] = x; o[1] = y; o[2] = z; return o;
      },
      len: (a) => Math.hypot(a[0], a[1], a[2]),
      dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
      normalize: (o, a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; return o; },
      lerp: (o, a, b, t) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; }
    }
  };
  GLX.math = math;

  // ---------------------------------------------------------------- color
  // GitHub linguist colors (subset). Use GLX.color.langColor() which brightens them for a dark sky.
  const LANG_COLORS = {
    JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219', Go: '#00ADD8', Rust: '#dea584',
    'C++': '#f34b7d', C: '#555555', 'C#': '#178600', Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF',
    Dart: '#00B4AB', Shell: '#89e051', HTML: '#e34c26', CSS: '#663399', SCSS: '#c6538c', Vue: '#41b883', Svelte: '#ff3e00',
    'Jupyter Notebook': '#DA5B0B', R: '#198CE7', Scala: '#c22d40', Elixir: '#6e4a7e', Haskell: '#5e5086', Lua: '#000080',
    Perl: '#0298c3', 'Objective-C': '#438eff', 'Objective-C++': '#6866fb', Clojure: '#db5855', Erlang: '#B83998', OCaml: '#ef7a08',
    Zig: '#ec915c', Nix: '#7e7eff', Dockerfile: '#384d54', HCL: '#844FBA', PowerShell: '#012456', 'Vim Script': '#199f4b',
    'Emacs Lisp': '#c065db', TeX: '#3D6117', Makefile: '#427819', CMake: '#DA3434', Julia: '#a270ba', MATLAB: '#e16737',
    Groovy: '#4298b8', Assembly: '#6E4C13', Solidity: '#AA6746', Elm: '#60B5CC', 'F#': '#b845fc', Nim: '#ffc200',
    Crystal: '#000100', Astro: '#ff5a03', MDX: '#fcb32c', Fortran: '#4d41b1', Gleam: '#ffaff3', Mojo: '#ff4c1f',
    WebAssembly: '#04133b', GLSL: '#5686a5', HLSL: '#aace60', Batchfile: '#C1F12E', Markdown: '#083fa1', Handlebars: '#f7931e',
    Less: '#1d365d', Stylus: '#ff6347', CoffeeScript: '#244776', Processing: '#0096D8', Verilog: '#b2b7f8', VHDL: '#adb2cb',
    SystemVerilog: '#DAE1C2', Cuda: '#3A4E3A', Ada: '#02f88c', Pascal: '#E3F171', Prolog: '#74283c', Racket: '#3c5caa',
    Scheme: '#1e4aec', 'Common Lisp': '#3fb68b', Haxe: '#df7900', D: '#ba595e', Raku: '#0000fb', Hack: '#878787',
    Apex: '#1797c0', Bicep: '#519aba', PureScript: '#1D222D', ReScript: '#ed5051', Reason: '#ff5847', Smarty: '#f0c040',
    Pug: '#a86454', 'Visual Basic .NET': '#945db7', Liquid: '#67b8de', Jsonnet: '#0064bd', Starlark: '#76d275',
    Blade: '#f7523f', Twig: '#c1d026', Mustache: '#724b3b', Jinja: '#a52a22', EJS: '#a91e50', Roff: '#ecdebe',
    YAML: '#cb171e', Cairo: '#ff4a48', Move: '#4a137a', Odin: '#60AFFE', Janet: '#0886a5', Coq: '#d0b68c', Agda: '#315665',
    Idris: '#b30000', Smalltalk: '#596706', Tcl: '#e4cc98', AutoHotkey: '#6594b9', GDScript: '#355570', Metal: '#8f14e9',
    Lean: '#8a6cff', Vala: '#a56de2', Wren: '#383838', Ballerina: '#FF5000', Bash: '#89e051', Cython: '#fedf5b'
  };

  function hexToRgb(hex) {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
  }
  function rgbToCss(rgb, a = 1) {
    return 'rgba(' + Math.round(clamp(rgb[0], 0, 1) * 255) + ',' + Math.round(clamp(rgb[1], 0, 1) * 255) + ',' +
      Math.round(clamp(rgb[2], 0, 1) * 255) + ',' + a + ')';
  }
  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    if (s === 0) return [l, l, l];
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
  }
  /** Brighten/saturate a color so it glows nicely on a near-black sky. */
  function spaceColor(rgb) {
    let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    if (s < 0.08) return hslToRgb(0.6, 0.18, clamp(l, 0.7, 0.8));
    s = Math.max(s, 0.5);
    l = clamp(l, 0.56, 0.74);
    return hslToRgb(h, s, l);
  }
  const OTHER_COLOR = [0.78, 0.84, 1.0];
  const langCache = new Map();
  /** Space-brightened [r,g,b] (0..1) for a language name. null/'Other' → pale blue-white. Returns a fresh copy. */
  function langColor(lang) {
    if (!lang || lang === 'Other') return OTHER_COLOR.slice();
    let c = langCache.get(lang);
    if (!c) {
      const hex = LANG_COLORS[lang];
      c = hex ? spaceColor(hexToRgb(hex)) : hslToRgb((hashStr(lang) % 360) / 360, 0.62, 0.64);
      langCache.set(lang, c);
    }
    return c.slice();
  }
  const langColorHex = (lang) => rgbToHex(langColor(lang));
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  GLX.color = { LANG_COLORS, OTHER_COLOR, hexToRgb, rgbToHex, rgbToCss, rgbToHsl, hslToRgb, spaceColor, langColor, langColorHex, mix };

  /** Colors per GHEvent.kind (hex). */
  GLX.EVENT_COLORS = {
    push: '#3fb950', pr: '#a371f7', issue: '#f0883e', comment: '#d2a8ff', star: '#e3b341',
    create: '#79c0ff', fork: '#58a6ff', release: '#ff7b72', review: '#56d4dd', other: '#c9d1d9'
  };

  // ---------------------------------------------------------------- event bus
  const handlers = new Map();
  GLX.bus = {
    on(evt, fn) {
      if (!handlers.has(evt)) handlers.set(evt, new Set());
      handlers.get(evt).add(fn);
      return () => GLX.bus.off(evt, fn);
    },
    off(evt, fn) {
      const set = handlers.get(evt);
      if (set) set.delete(fn);
    },
    emit(evt, payload) {
      const set = handlers.get(evt);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (e) { console.error(e); }
      }
    }
  };

  // ---------------------------------------------------------------- render buffers
  /** Sprite styles understood by GLX.Renderer (see CONTRACT.md §7.3). */
  GLX.SPRITE = { STAR: 0, GLOW: 1, RING: 2, NEBULA: 3 };

  const SPRITE_STRIDE = 11; // x,y,z, size, r,g,b,a, style, p1, p2
  /** Growable per-frame list of billboard sprites. Reuse one instance; call reset() each frame. */
  class SpriteBuffer {
    constructor(capacity = 2048) {
      this.stride = SPRITE_STRIDE;
      this.data = new Float32Array(capacity * SPRITE_STRIDE);
      this.count = 0;
    }
    reset() {
      this.count = 0;
      return this;
    }
    /** size = world-space half-extent of the quad. a = opacity/intensity (additive). Invisible sprites are skipped. */
    push(x, y, z, size, r, g, b, a, style, p1 = 0, p2 = 0) {
      if (!(a > 0.002) || !(size > 0)) return;
      if (this.count >= GLX.config.MAX_SPRITES) return;
      let o = this.count * SPRITE_STRIDE;
      if (o + SPRITE_STRIDE > this.data.length) {
        const n = new Float32Array(this.data.length * 2);
        n.set(this.data);
        this.data = n;
      }
      const d = this.data;
      d[o++] = x; d[o++] = y; d[o++] = z; d[o++] = size;
      d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
      d[o++] = style; d[o++] = p1; d[o] = p2;
      this.count++;
    }
  }

  const LINE_VSTRIDE = 7; // per vertex: x,y,z, r,g,b,a ; 2 vertices per segment
  /** Growable per-frame list of line segments (drawn additively, 1px). */
  class LineBuffer {
    constructor(capacity = 2048) {
      this.vstride = LINE_VSTRIDE;
      this.data = new Float32Array(capacity * LINE_VSTRIDE * 2);
      this.count = 0; // segments
    }
    reset() {
      this.count = 0;
      return this;
    }
    push(x1, y1, z1, x2, y2, z2, r, g, b, a) {
      this.pushGradient(x1, y1, z1, r, g, b, a, x2, y2, z2, r, g, b, a);
    }
    pushGradient(x1, y1, z1, r1, g1, b1, a1, x2, y2, z2, r2, g2, b2, a2) {
      if (!(a1 > 0.002) && !(a2 > 0.002)) return;
      let o = this.count * LINE_VSTRIDE * 2;
      if (o + LINE_VSTRIDE * 2 > this.data.length) {
        const n = new Float32Array(this.data.length * 2);
        n.set(this.data);
        this.data = n;
      }
      const d = this.data;
      d[o++] = x1; d[o++] = y1; d[o++] = z1; d[o++] = r1; d[o++] = g1; d[o++] = b1; d[o++] = a1;
      d[o++] = x2; d[o++] = y2; d[o++] = z2; d[o++] = r2; d[o++] = g2; d[o++] = b2; d[o] = a2;
      this.count++;
    }
  }
  GLX.SpriteBuffer = SpriteBuffer;
  GLX.LineBuffer = LineBuffer;

  // ---------------------------------------------------------------- icons (24×24 stroke icons)
  const ICONS = {
    play: '<path d="M7.5 5v14l11-7z" fill="currentColor"/>',
    pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
    replay: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
    sound: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
    mute: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5L6 19.5"/>',
    download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
    merge: '<circle cx="6" cy="5.5" r="2.2"/><circle cx="6" cy="18.5" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 7.7v8.6M6 7.7c0 3.5 3 4.3 9.8 4.3"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 3.8"/><path d="M12 17.2h.01"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    home: '<path d="M4 11l8-7 8 7"/><path d="M6.5 9.5V20h11V9.5"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
    fork: '<circle cx="6.5" cy="5" r="2"/><circle cx="17.5" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6.5 7v1.5a3 3 0 0 0 3 3h5a3 3 0 0 0 3-3V7M12 11.5V17"/>',
    issue: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="1.6"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
    chevronRight: '<path d="M9 5l7 7-7 7"/>',
    constellation: '<circle cx="5" cy="17" r="1.6"/><circle cx="11" cy="8" r="1.6"/><circle cx="19" cy="12" r="1.6"/><circle cx="15" cy="19" r="1.6"/><path d="M6.2 15.8l3.7-6.3M12.4 8.7l5.2 2.6M18.2 13.4l-2.4 4.2"/>',
    sparkle: '<path d="M12 3l1.8 5.6L19.5 10l-5.7 1.6L12 17l-1.8-5.4L4.5 10l5.7-1.4z"/><path d="M19 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
    users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19c.9-3 3.2-4.6 6-4.6s5.1 1.6 6 4.6"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.2c2.3 0 4 1.3 4.7 3.8"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    zap: '<path d="M13 3L5 13.5h6L10.5 21 19 10h-6z"/>',
    code: '<path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5"/>',
    tag: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3-8.7 8.7z"/><circle cx="8" cy="8" r="1.3"/>',
    scale: '<path d="M12 4v16M7 20h10M5 8h14"/><path d="M5 8l-2.5 6a2.5 2.5 0 0 0 5 0zM19 8l-2.5 6a2.5 2.5 0 0 0 5 0z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    planet: '<circle cx="12" cy="12" r="5"/><path d="M3.5 15.5c-1 1.7 0 2.6 2.6 2.4 3-.2 7.4-1.8 10.9-4.1 3.5-2.3 5.3-4.6 4.4-5.9-.5-.8-2-1-3.9-.6"/>',
    archive: '<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    speed: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
    token: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>'
  };
  /** Returns trusted SVG markup string for an icon (use via el(..., {html: GLX.icon('star')}) or innerHTML). */
  GLX.icon = function icon(name, size = 18) {
    const body = ICONS[name] || ICONS.sparkle;
    return '<svg class="icon icon-' + name + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      body + '</svg>';
  };
  GLX.icons = Object.keys(ICONS);
})();
