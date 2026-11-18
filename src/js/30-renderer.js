/* Gitlaxy — 30-renderer.js
 * WebGL1 renderer: sky (diffuse dust band + ~3000 background stars), galaxy particles (2 slots),
 * billboard sprites (STAR / GLOW / RING / NEBULA) and lines. Everything is premultiplied additive
 * (blendFunc ONE, ONE) without depth test, so draw order never matters.
 */
(() => {
  'use strict';
  const GLX = (window.GLX = window.GLX || {});

  // Tuning. "px" = device (drawing-buffer) pixels unless noted.
  const TUNE = {
    PARTICLE_WORLD: 0.005, // world diameter of a size-1 particle → uPointScale = bufferH/2 · proj[5] · this
    PARTICLE_MIN_PX: 2.0, // below: clamp up, alpha × (s/min)² (energy preserving)
    PARTICLE_SOFT_PX: 9, // × dpr; above: alpha × sqrt(soft/s) so close-ups don't turn into mush
    PARTICLE_MAX_PX: 48, // × dpr, and ≤ ALIASED_POINT_SIZE_RANGE max
    HAZE_STRIDE: 7, // every Nth particle also draws a big faint "unresolved starlight" blob
    HAZE_SCALE: 7.0,
    HAZE_ALPHA: 0.05,
    HAZE_MIN_PX: 4,
    STAR_MIN_HALF_PX: 3,
    GLOW_MIN_HALF_PX: 1.5,
    RING_MIN_HALF_PX: 2,
    NEBULA_GAIN: 3.0,
    SKY_STARS: 3000,
    SKY_MIN_PX: 2.0,
    BAND_INTENSITY: 0.05, // peak band brightness above the clear color (0..1)
    CUBE_SIZE: 128,
    NOISE_SIZE: 64
  };
  const STRIDE_SKY = 10; // dir3, rgb3, brightness, sizeCss, twinkleSpeed, phase
  const STRIDE_PART_ATTR = 7; // r,g,b,a, size, birth, seed
  const SPR_VFLOATS = 10; // x,y,z,size, r,g,b,a, p1,p2 (per vertex)
  const SPR_QFLOATS = SPR_VFLOATS * 4;
  const MAX_QUADS = Math.min(GLX.config ? GLX.config.MAX_SPRITES : 16000, 16383); // Uint16 indices
  const DRAW_ORDER = [3, 1, 2, 0]; // nebula, glow, ring, star

  // ------------------------------------------------------------------ shaders
  const FS_HEAD =
    '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';
  // Gentle per-sprite highlight roll-off (C1 continuous at 0.6) keeps dense overlaps from clipping harshly.
  const KNEE = 'vec3 knee(vec3 x){return mix(x,0.6+0.4*(1.0-exp(-(x-0.6)*2.5)),step(0.6,x));}\n';

  const BAND_VS = `
attribute vec2 aPos;
uniform mat3 uInvRot;
uniform vec2 uInvProj;
varying vec3 vRay;
void main() {
  vRay = uInvRot * vec3(aPos * uInvProj, -1.0);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
  const BAND_FS = FS_HEAD + `
uniform samplerCube uBand;
uniform float uIntensity;
varying vec3 vRay;
void main() {
  vec3 c = textureCube(uBand, vRay).rgb;
  c = c * c * uIntensity;
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  gl_FragColor = vec4(max(c + (n - 0.5) / 255.0, 0.0), 1.0);
}`;

  const SKY_VS = `
attribute vec3 aDir;
attribute vec4 aColor;
attribute vec3 aMeta;
uniform mat4 uProj;
uniform mat3 uRot;
uniform vec4 uS; // time, alpha, dpr, minPx
varying vec3 vColor;
varying float vSpike;
void main() {
  vec4 c = uProj * vec4(uRot * aDir, 0.0);
  gl_Position = vec4(c.xy, 0.0, c.w);
  float tw = sin(uS.x * aMeta.y + aMeta.z) * sin(uS.x * aMeta.y * 0.37 + aMeta.z * 2.1);
  float s = aMeta.x * uS.z;
  float a = aColor.a * uS.y * (1.0 + 0.32 * tw);
  if (s < uS.w) { a *= s * s / (uS.w * uS.w); s = uS.w; }
  gl_PointSize = s;
  vSpike = smoothstep(5.0, 10.0, s);
  vColor = aColor.rgb * a;
}`;
  const SKY_FS = FS_HEAD + `
varying vec3 vColor;
varying float vSpike;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  float w = max(1.0 - r2, 0.0);
  vec2 ad = abs(d);
  float sp = (exp(-ad.y * 30.0) * (1.0 - ad.x) + exp(-ad.x * 30.0) * (1.0 - ad.y)) * vSpike * 0.45;
  float g = exp(-r2 * (5.0 + 9.0 * vSpike)) + sp;
  gl_FragColor = vec4(vColor * g * w, 1.0);
}`;

  const PART_VS = `
attribute vec3 aPos;
attribute vec4 aColor;
attribute vec3 aMeta; // size, birth, seed
uniform mat4 uMV;
uniform mat4 uProj;
uniform vec4 uA; // pointScale, reveal, alpha, time
uniform vec4 uB; // minPx, softPx, maxPx, wavefront boost
varying vec3 vColor;
void main() {
  vec4 vp = uMV * vec4(aPos, 1.0);
  float born = uA.y - aMeta.y;
  float fadeIn = smoothstep(0.0, 0.03, born);
  float flash = uB.w * exp(-max(born, 0.0) * 40.0);
  float seed = aMeta.z;
  float z = max(-vp.z, 0.001);
  float s = aMeta.x * uA.x / z * (1.0 + 0.5 * flash);
  float a = aColor.a * uA.z * fadeIn * (1.0 + 2.6 * flash);
  float tw = 0.05 + 0.2 * step(0.75, fract(seed * 7.31));
  a *= 1.0 + tw * sin(uA.w * (0.5 + 2.5 * fract(seed * 3.17)) + seed * 43.0);
  if (s < uB.x) { a *= s * s / (uB.x * uB.x); s = uB.x; }
  else if (s > uB.y) { a *= sqrt(uB.y / s); }
  gl_PointSize = min(s, uB.z);
  gl_Position = a > 0.0004 ? uProj * vp : vec4(2.0, 2.0, 2.0, 1.0);
  vColor = aColor.rgb * a;
}`;
  const PART_FS = FS_HEAD + `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  gl_FragColor = vec4(vColor * (exp(-r2 * 4.5) * max(1.0 - r2, 0.0)), 1.0);
}`;

  const HAZE_VS = `
attribute vec3 aPos;
attribute vec4 aColor;
attribute vec3 aMeta;
uniform mat4 uMV;
uniform mat4 uProj;
uniform vec4 uA; // pointScale, reveal, alpha, time
uniform vec4 uH; // scale, alpha, minPx, maxPx
varying vec3 vColor;
void main() {
  vec4 vp = uMV * vec4(aPos, 1.0);
  float born = uA.y - aMeta.y;
  float z = max(-vp.z, 0.001);
  float s = aMeta.x * uA.x / z * uH.x;
  float a = aColor.a * uA.z * uH.y * smoothstep(0.0, 0.06, born) * smoothstep(uH.z, uH.z * 2.5, s);
  if (s > uH.w) { a *= uH.w / s; s = uH.w; }
  gl_PointSize = s;
  gl_Position = a > 0.0002 ? uProj * vp : vec4(2.0, 2.0, 2.0, 1.0);
  vColor = aColor.rgb * a;
}`;
  const HAZE_FS = FS_HEAD + `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float w = max(1.0 - dot(d, d), 0.0);
  gl_FragColor = vec4(vColor * (w * w * w), 1.0);
}`;

  // Sprites: one vertex shader compiled per style (#define STYLE n). Quads are billboarded in view space.
  const SPRITE_VS = `
attribute vec4 aCenter; // world xyz, half-size
attribute vec4 aColor;
attribute vec2 aParam;  // p1, p2
attribute vec2 aCorner; // ±1
uniform mat4 uView;
uniform mat4 uProj;
uniform vec4 uU; // device px per world unit at depth 1, min half px, fade, time
varying vec2 vUV;
varying vec4 vColor;
varying vec4 vP;
#if STYLE == 3
varying vec2 vN;
#endif
void main() {
  vec4 vc = uView * vec4(aCenter.xyz, 1.0);
  float z = -vc.z;
  float size = aCenter.w;
  float a = aColor.a * uU.z;
  float px = size * uU.x / max(z, 0.0001);
  if (px < uU.y) {
    float k = px / uU.y;
#if STYLE == 0
    a *= k * sqrt(k);
#elif STYLE == 2
    a *= k;
#else
    a *= k * k;
#endif
    size *= uU.y / max(px, 0.0001);
    px = uU.y;
  }
  float S = 1.0;
#if STYLE == 0
  float p1 = clamp(aParam.x, 0.0, 1.0);
  float L = 0.6 + 1.8 * p1;
  float sd = aParam.y * 6.2831853;
  float t = uU.w;
  float sh = 1.0 + 0.05 * sin(t * (1.1 + 1.9 * fract(aParam.y * 7.3)) + sd) + 0.035 * sin(t * (2.7 + 1.3 * aParam.y) + sd * 3.0);
  S = max(1.0, L);
  vP = vec4(L, (0.22 + 0.68 * p1) * smoothstep(3.5, 13.0, px) * sh, px, sh);
#elif STYLE == 1
  vP = vec4(clamp(aParam.x, 0.0, 1.0), 0.0, px, 0.0);
#elif STYLE == 2
  vP = vec4(clamp(aParam.x, 0.02, 0.3), 0.0, px, 0.0);
#else
  a *= smoothstep(aCenter.w * 0.35, aCenter.w * 1.4, z);
  float sd = aParam.x * 6.2831853;
  float ang = sd + uU.w * 0.008;
  float ca = cos(ang), sa = sin(ang);
  vec2 off = vec2(fract(aParam.x * 13.17), fract(aParam.x * 29.71)) * 16.0 +
             0.6 * vec2(sin(uU.w * 0.05 + sd), cos(uU.w * 0.041 + sd * 1.3));
  vN = mat2(ca, sa, -sa, ca) * aCorner * 2.6 + off;
  vP = vec4(0.0, clamp(aParam.y, 0.0, 1.0), px, 0.0);
#endif
  vec2 q = aCorner * S;
  vc.xy += q * size;
  gl_Position = (z > 0.001 && a > 0.00002) ? uProj * vc : vec4(2.0, 2.0, 2.0, 1.0);
  vUV = q;
  vColor = vec4(aColor.rgb, a);
}`;

  const SPRITE_FS_HEAD = FS_HEAD + KNEE + 'varying vec2 vUV;\nvarying vec4 vColor;\nvarying vec4 vP;\n';

  // STAR — vUV is in units of the nominal star radius (quad is enlarged to fit the spikes).
  const STAR_FS = SPRITE_FS_HEAD + `
void main() {
  vec2 q = vUV;
  float r2 = dot(q, q);
  float px = vP.z;
  vec3 c = vColor.rgb;
  float sc = max(0.08, 0.62 / px);
  float core = exp(-r2 / (2.0 * sc * sc));
  float w = max(1.0 - r2, 0.0);
  float halo = (0.55 * exp(-r2 * 10.0) + 0.35 * exp(-sqrt(r2) * 6.0)) * w * w * vP.w;
  vec2 aq = abs(q);
  float L = vP.x;
  float sw = max(0.004, 0.55 / px);
  vec2 al = clamp(1.0 - aq / L, 0.0, 1.0);
  al *= al;
  vec2 wid = sw * (1.0 + 1.6 * exp(-aq * 9.0));
  float sx = exp(-0.5 * aq.y * aq.y / (wid.x * wid.x)) * al.x / (1.0 + 3.0 * aq.x);
  float sy = exp(-0.5 * aq.x * aq.x / (wid.y * wid.y)) * al.y / (1.0 + 3.0 * aq.y);
  vec3 tx = mix(vec3(1.0), c, smoothstep(0.0, 0.55, aq.x / L));
  vec3 ty = mix(vec3(1.0), c, smoothstep(0.0, 0.55, aq.y / L));
  vec3 col = core * mix(vec3(1.0), c, 0.12) * 1.25 + halo * c + (sx * tx + sy * ty) * vP.y;
  gl_FragColor = vec4(knee(col * vColor.a), 1.0);
}`;

  const GLOW_FS = SPRITE_FS_HEAD + `
void main() {
  float r2 = dot(vUV, vUV);
  float w = max(1.0 - r2, 0.0);
  float h = vP.x;
  float kc = min(40.0, 4.0 + 0.4 * vP.z * vP.z);
  float soft = exp(-r2 * 3.0);
  float hard = exp(-r2 * kc) + 0.25 * exp(-r2 * 6.0);
  float g = mix(soft, hard, h) * w * w;
  vec3 col = vColor.rgb * g + vec3(h * h * 0.5 * exp(-r2 * kc * 3.0));
  gl_FragColor = vec4(knee(col * vColor.a), 1.0);
}`;

  const RING_FS = SPRITE_FS_HEAD + `
void main() {
  float r = length(vUV);
  float hw = vP.x * 0.5;
  float hwPx = max(hw, 0.85 / vP.z);
  float d = (r - 0.8) / hwPx;
  float ring = exp(-d * d * 1.6) * (hw / hwPx);
  float inner = 0.05 * smoothstep(0.15, 0.8, r) * (1.0 - smoothstep(0.76, 0.8, r));
  float g = (ring + inner) * (1.0 - smoothstep(0.9, 1.0, r));
  gl_FragColor = vec4(knee(vColor.rgb * g * vColor.a), 1.0);
}`;

  // NEBULA — domain-warped 3-octave value-noise fbm from a random texture (smooth-interpolated lookups).
  const NEBULA_FS = SPRITE_FS_HEAD + `
uniform sampler2D uNoise;
varying vec2 vN;
vec4 nz(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture2D(uNoise, (i + f + 0.5) * (1.0 / ${TUNE.NOISE_SIZE.toFixed(1)}));
}
void main() {
  float r = length(vUV);
  if (r > 0.94) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float dens = vP.y;
  vec2 p = vN;
  vec4 w = nz(p * 0.5 + vec2(17.0, 9.0));
  p += (w.xy - 0.5) * 2.4;
  float n1 = nz(p).z;
  vec2 p2 = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(5.2, 1.3);
  float n2 = nz(p2).w;
  vec2 p3 = mat2(1.6, 1.2, -1.2, 1.6) * p2 + vec2(1.7, 9.2);
  float n3 = mix(0.5, nz(p3).x, smoothstep(24.0, 96.0, vP.z));
  float f = n1 * 0.55 + n2 * 0.3 + n3 * 0.15;
  float th = mix(0.62, 0.32, dens);
  float cloud = smoothstep(th, th + 0.3, f);
  float wisp = 1.0 - abs(f * 2.0 - 1.0);
  wisp *= wisp;
  wisp *= wisp;
  float rr = r * (0.88 + 0.3 * w.z);
  float fall = 1.0 - smoothstep(0.12, 0.82, rr);
  fall *= fall;
  float dsum = (cloud + 0.35 * wisp * (0.4 + dens)) * fall;
  vec3 c = vColor.rgb;
  vec3 col = mix(c, mix(c, vec3(1.0, 0.9, 0.92), 0.35), cloud * fall) * dsum;
  gl_FragColor = vec4(knee(col * (vColor.a * ${TUNE.NEBULA_GAIN.toFixed(2)})), 1.0);
}`;

  const LINE_VS = `
attribute vec3 aPos;
attribute vec4 aColor;
uniform mat4 uViewProj;
uniform float uFade;
varying vec3 vColor;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vColor = aColor.rgb * (aColor.a * uFade);
}`;
  const LINE_FS = FS_HEAD + `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

  const SPRITE_FS = [STAR_FS, GLOW_FS, RING_FS, NEBULA_FS];
  const SPRITE_ATTRS = ['aCenter', 'aColor', 'aParam', 'aCorner'];
  const SPRITE_UNIFORMS = ['uView', 'uProj', 'uU', 'uNoise'];

  // ------------------------------------------------------------------ helpers
  function compileShader(gl, type, src, name) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(sh) || '(no info log)';
      gl.deleteShader(sh);
      throw new Error('GLX.Renderer: ' + name + (type === gl.VERTEX_SHADER ? ' vertex' : ' fragment') +
        ' shader failed to compile:\n' + log);
    }
    return sh;
  }

  function linkProgram(gl, vsSrc, fsSrc, attribs, uniforms, name) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, name);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, name);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    for (let i = 0; i < attribs.length; i++) gl.bindAttribLocation(prog, i, attribs[i]);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(prog) || '(no info log)';
      gl.deleteProgram(prog);
      throw new Error('GLX.Renderer: ' + name + ' program failed to link:\n' + log);
    }
    const u = {};
    for (let i = 0; i < uniforms.length; i++) u[uniforms[i]] = gl.getUniformLocation(prog, uniforms[i]);
    return { prog, u };
  }

  /** Cached subarray view of arr with a power-of-two length ≥ need (clamped) — no per-frame allocation. */
  function bucketView(cache, arr, need) {
    let b = 8;
    while ((1 << b) < need) b++;
    let v = cache[b];
    if (v === undefined || v.buffer !== arr.buffer) v = cache[b] = arr.subarray(0, Math.min(1 << b, arr.length));
    return v;
  }

  const num = (v, d) => (typeof v === 'number' && v === v ? v : d);

  // Galactic plane of the background sky (a tilted great circle) and its in-plane basis.
  const BAND_N = normalize3([0.34, 0.86, -0.38]);
  const BAND_E1 = normalize3(cross3([0, 0, 1], BAND_N));
  const BAND_E2 = cross3(BAND_N, BAND_E1);
  function normalize3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  function genSkyStars(count) {
    const R = GLX.util.rng(0x51a7f00d);
    const d = new Float32Array(count * STRIDE_SKY);
    const PAL = [[0.68, 0.78, 1.0], [0.84, 0.89, 1.0], [1.0, 1.0, 1.0], [1.0, 0.95, 0.86], [1.0, 0.85, 0.68], [1.0, 0.72, 0.56]];
    const W = [0.16, 0.2, 0.24, 0.2, 0.14, 0.06];
    for (let i = 0; i < count; i++) {
      let x, y, z;
      if (R() < 0.4) {
        const lon = R() * Math.PI * 2, lat = GLX.util.gauss(R) * 0.13, c = Math.cos(lat), s = Math.sin(lat);
        const cl = Math.cos(lon) * c, sl = Math.sin(lon) * c;
        x = BAND_E1[0] * cl + BAND_E2[0] * sl + BAND_N[0] * s;
        y = BAND_E1[1] * cl + BAND_E2[1] * sl + BAND_N[1] * s;
        z = BAND_E1[2] * cl + BAND_E2[2] * sl + BAND_N[2] * s;
      } else {
        y = R() * 2 - 1;
        const phi = R() * Math.PI * 2, s = Math.sqrt(1 - y * y);
        x = Math.cos(phi) * s;
        z = Math.sin(phi) * s;
      }
      const u = R();
      let bright = 0.08 + 0.55 * Math.pow(u, 5);
      let size = 2.0 + 0.9 * u * u;
      if (R() < 0.012) {
        bright = 0.55 + 0.4 * R();
        size = 6 + 3 * R();
      }
      const pc = PAL[GLX.util.weightedIndex(R, W)];
      const o = i * STRIDE_SKY;
      d[o] = x; d[o + 1] = y; d[o + 2] = z;
      d[o + 3] = Math.min(1, pc[0] + (R() - 0.5) * 0.06);
      d[o + 4] = Math.min(1, pc[1] + (R() - 0.5) * 0.06);
      d[o + 5] = Math.min(1, pc[2] + (R() - 0.5) * 0.06);
      d[o + 6] = bright;
      d[o + 7] = size;
      d[o + 8] = 0.5 + 2.5 * R();
      d[o + 9] = R() * Math.PI * 2;
    }
    return d;
  }

  /** Six RGBA faces (N×N) of a cube map holding a soft, patchy dust band (sqrt-encoded, normalized to 255). */
  function genBandFaces(N) {
    const R = GLX.util.rng(0xba4d);
    const perm = new Uint8Array(512), vals = new Float32Array(256);
    for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = R(); }
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(R() * (i + 1)), t = perm[i];
      perm[i] = perm[j]; perm[j] = t;
    }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const fade = (t) => t * t * (3 - 2 * t);
    const noise3 = (x, y, z) => {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
      const X = xi & 255, Y = yi & 255, Z = zi & 255, X1 = (X + 1) & 255, Y1 = (Y + 1) & 255, Z1 = (Z + 1) & 255;
      const h = (a, b, c) => vals[perm[perm[perm[a] + b] + c]];
      const l = (a, b, t) => a + (b - a) * t;
      return l(
        l(l(h(X, Y, Z), h(X1, Y, Z), u), l(h(X, Y1, Z), h(X1, Y1, Z), u), v),
        l(l(h(X, Y, Z1), h(X1, Y, Z1), u), l(h(X, Y1, Z1), h(X1, Y1, Z1), u), v), w);
    };
    const fbm = (x, y, z, oct) => {
      let s = 0, a = 0.5, n = 0;
      for (let o = 0; o < oct; o++) {
        s += a * noise3(x, y, z);
        n += a;
        x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; z = z * 2.03 + 9.3;
        a *= 0.5;
      }
      return s / n;
    };
    const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const tmp = new Float32Array(N * N * 3 * 6);
    let max = 1e-6;
    for (let f = 0; f < 6; f++) {
      for (let j = 0; j < N; j++) {
        const T = (2 * (j + 0.5)) / N - 1;
        for (let i = 0; i < N; i++) {
          const S = (2 * (i + 0.5)) / N - 1;
          let x, y, z;
          switch (f) {
            case 0: x = 1; y = -T; z = -S; break;
            case 1: x = -1; y = -T; z = S; break;
            case 2: x = S; y = 1; z = T; break;
            case 3: x = S; y = -1; z = -T; break;
            case 4: x = S; y = -T; z = 1; break;
            default: x = -S; y = -T; z = -1;
          }
          const il = 1 / Math.hypot(x, y, z);
          x *= il; y *= il; z *= il;
          const lat = Math.asin(Math.max(-1, Math.min(1, x * BAND_N[0] + y * BAND_N[1] + z * BAND_N[2])));
          const lon = Math.atan2(x * BAND_E2[0] + y * BAND_E2[1] + z * BAND_E2[2], x * BAND_E1[0] + y * BAND_E1[1] + z * BAND_E1[2]);
          const core = Math.exp(-(lon * lon) / 0.5);
          const width = 0.15 * (1 + 0.9 * core);
          const base = Math.exp(-(lat / width) * (lat / width));
          let r = 0, g = 0, b = 0;
          if (base > 0.003) {
            const n1 = fbm(x * 2.4 + 3.1, y * 2.4, z * 2.4, 4);
            const n2 = fbm(x * 6.2, y * 6.2 + 7.7, z * 6.2, 3);
            const lane = (lat - 0.025 * Math.sin(lon * 2)) / (0.04 * (1 + core));
            const rift = Math.exp(-lane * lane) * ss(0.35, 0.62, n2) * 0.85;
            const dens = base * (0.25 + 1.3 * n1 * n1) * (1 - rift) * (0.45 + 1.4 * core);
            const pink = ss(0.6, 0.78, n2) * (1 - core) * 0.6;
            r = (0.62 + 0.38 * core + 0.25 * pink) * dens;
            g = (0.70 + 0.14 * core - 0.12 * pink) * dens;
            b = (1.0 - 0.34 * core) * dens;
          }
          const o = ((f * N + j) * N + i) * 3;
          tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
          if (r > max) max = r;
          if (g > max) max = g;
          if (b > max) max = b;
        }
      }
    }
    const faces = [];
    for (let f = 0; f < 6; f++) {
      const px = new Uint8Array(N * N * 4);
      for (let k = 0; k < N * N; k++) {
        const o = (f * N * N + k) * 3;
        px[k * 4] = Math.round(Math.sqrt(tmp[o] / max) * 255);
        px[k * 4 + 1] = Math.round(Math.sqrt(tmp[o + 1] / max) * 255);
        px[k * 4 + 2] = Math.round(Math.sqrt(tmp[o + 2] / max) * 255);
        px[k * 4 + 3] = 255;
      }
      faces.push(px);
    }
    return faces;
  }

  function genNoise(N) {
    const R = GLX.util.rng(0x6e6f6973);
    const d = new Uint8Array(N * N * 4);
    for (let i = 0; i < d.length; i++) d[i] = Math.floor(R() * 256);
    return d;
  }

  function newSlot() {
    return { particles: null, count: 0, dynamic: false, pos: null, posBuf: null, attrBuf: null, posCap: 0 };
  }

  // ------------------------------------------------------------------ renderer
  class Renderer {
    constructor(canvas) {
      if (!canvas || typeof canvas.getContext !== 'function') throw new Error('WebGL unavailable');
      const attrs = {
        antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false,
        depth: false, stencil: false, powerPreference: 'high-performance'
      };
      let gl = null;
      try {
        gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
      } catch (e) {
        gl = null;
      }
      if (!gl) throw new Error('WebGL unavailable');
      this.canvas = canvas;
      this.gl = gl;
      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this.tuning = TUNE;
      this._size = { width: 0, height: 0 };
      this._lost = false;
      this._disposed = false;
      this._slots = [newSlot(), newSlot()];
      this._mv = new Float32Array(16);
      this._vp = new Float32Array(16);
      this._rot = new Float32Array(9);
      this._invRot = new Float32Array(9);
      this._styleCnt = new Int32Array(4);
      this._styleOff = new Int32Array(4);
      this._styleCur = new Int32Array(4);
      this._sprVerts = null;
      this._sprCap = 0;
      this._sprViews = [];
      this._lineSrc = null;
      this._lineViews = [];
      this._en = 0;
      this._skyData = genSkyStars(TUNE.SKY_STARS);
      this._noiseData = genNoise(TUNE.NOISE_SIZE);
      this._bandFaces = null;
      this._bandSize = 0;

      this._onLost = (e) => {
        e.preventDefault();
        if (this._lost) return;
        this._lost = true;
        GLX.bus.emit('gl:lost');
      };
      this._onRestored = () => {
        if (this._disposed) return;
        this._lost = false;
        this._initGL();
        GLX.bus.emit('gl:restored');
      };
      canvas.addEventListener('webglcontextlost', this._onLost, false);
      canvas.addEventListener('webglcontextrestored', this._onRestored, false);

      this._initGL();
      this.resize();
    }

    /** Sizes the drawing buffer to CSS size × min(devicePixelRatio, 2). Cheap when nothing changed. */
    resize() {
      const c = this.canvas;
      const dpr = Math.min(Math.max(num(window.devicePixelRatio, 1), 0.25), 2);
      let w = c.clientWidth, h = c.clientHeight;
      if (!(w > 0 && h > 0)) {
        w = window.innerWidth || 300;
        h = window.innerHeight || 150;
      }
      let bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
      const lim = this._maxDim || 4096;
      if (bw > lim || bh > lim) {
        const k = lim / Math.max(bw, bh);
        bw = Math.max(1, Math.floor(bw * k));
        bh = Math.max(1, Math.floor(bh * k));
      }
      if (c.width !== bw) c.width = bw;
      if (c.height !== bh) c.height = bh;
      this.width = w;
      this.height = h;
      this.dpr = dpr;
      this._size.width = w;
      this._size.height = h;
      return this._size;
    }

    setParticles(slot, particles, opts) {
      const s = this._slots[slot === 1 ? 1 : 0];
      if (!particles || !(particles.count > 0) || !particles.pos || !particles.color || !particles.meta) {
        this.clearParticles(slot);
        return;
      }
      s.particles = particles;
      s.dynamic = !!(opts && opts.dynamic);
      s.pos = particles.pos;
      s.count = Math.min(particles.count | 0, Math.floor(particles.pos.length / 3),
        Math.floor(particles.color.length / 4), Math.floor(particles.meta.length / 3));
      if (!this._lost && !this._disposed) this._uploadSlot(s);
    }

    updateParticlePositions(slot, pos) {
      const s = this._slots[slot === 1 ? 1 : 0];
      if (!s.count || !pos) return;
      s.pos = pos;
      if (this._lost || this._disposed || !s.posBuf) return;
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, s.posBuf);
      if (pos.length > s.posCap) {
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
        s.posCap = pos.length;
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
      }
    }

    clearParticles(slot) {
      const s = this._slots[slot === 1 ? 1 : 0];
      if (!this._lost && !this._disposed) {
        if (s.posBuf) this.gl.deleteBuffer(s.posBuf);
        if (s.attrBuf) this.gl.deleteBuffer(s.attrBuf);
      }
      s.particles = null;
      s.pos = null;
      s.count = 0;
      s.posCap = 0;
      s.posBuf = s.attrBuf = null;
    }

    dispose() {
      if (this._disposed) return;
      this.canvas.removeEventListener('webglcontextlost', this._onLost, false);
      this.canvas.removeEventListener('webglcontextrestored', this._onRestored, false);
      if (!this._lost) {
        this.clearParticles(0);
        this.clearParticles(1);
        this._freeGL();
      }
      this._disposed = true;
      this._slots = [newSlot(), newSlot()];
      this._sprVerts = null;
      this._bandFaces = null;
    }

    // ---------------------------------------------------------------- GL setup
    _initGL() {
      const gl = this.gl;
      this._en = 0;
      const pr = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
      this._pointMax = pr && pr[1] >= 1 ? pr[1] : 64;
      const vpd = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      this._maxDim = Math.max(256, Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096, vpd ? Math.min(vpd[0], vpd[1]) : 4096, 8192));

      const P = (this._progs = {});
      P.band = linkProgram(gl, BAND_VS, BAND_FS, ['aPos'], ['uInvRot', 'uInvProj', 'uBand', 'uIntensity'], 'band');
      P.sky = linkProgram(gl, SKY_VS, SKY_FS, ['aDir', 'aColor', 'aMeta'], ['uProj', 'uRot', 'uS'], 'sky');
      P.part = linkProgram(gl, PART_VS, PART_FS, ['aPos', 'aColor', 'aMeta'], ['uMV', 'uProj', 'uA', 'uB'], 'particles');
      P.haze = linkProgram(gl, HAZE_VS, HAZE_FS, ['aPos', 'aColor', 'aMeta'], ['uMV', 'uProj', 'uA', 'uH'], 'haze');
      P.line = linkProgram(gl, LINE_VS, LINE_FS, ['aPos', 'aColor'], ['uViewProj', 'uFade'], 'lines');
      P.spr = [];
      for (let k = 0; k < 4; k++) {
        P.spr[k] = linkProgram(gl, '#define STYLE ' + k + '\n' + SPRITE_VS, '#define STYLE ' + k + '\n' + SPRITE_FS[k],
          SPRITE_ATTRS, SPRITE_UNIFORMS, 'sprite' + k);
      }
      gl.useProgram(P.band.prog);
      gl.uniform1i(P.band.u.uBand, 0);
      gl.useProgram(P.spr[3].prog);
      gl.uniform1i(P.spr[3].u.uNoise, 1);

      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

      this._triBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._triBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

      this._skyBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._skyBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this._skyData, gl.STATIC_DRAW);

      const corners = new Float32Array(MAX_QUADS * 8), idx = new Uint16Array(MAX_QUADS * 6);
      for (let q = 0; q < MAX_QUADS; q++) {
        const c = q * 8, v = q * 4, o = q * 6;
        corners[c] = -1; corners[c + 1] = -1; corners[c + 2] = 1; corners[c + 3] = -1;
        corners[c + 4] = 1; corners[c + 5] = 1; corners[c + 6] = -1; corners[c + 7] = 1;
        idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
        idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
      }
      this._cornerBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._cornerBuf);
      gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
      this._idxBuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

      this._sprBuf = gl.createBuffer();
      if (this._sprVerts) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this._sprBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this._sprVerts.byteLength, gl.DYNAMIC_DRAW);
      }
      this._lineBuf = gl.createBuffer();
      this._lineSrc = null;

      const cubeN = Math.max(16, Math.min(TUNE.CUBE_SIZE, gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE) || 16));
      if (!this._bandFaces || this._bandSize !== cubeN) {
        this._bandFaces = genBandFaces(cubeN);
        this._bandSize = cubeN;
      }
      this._bandTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, this._bandTex);
      for (let f = 0; f < 6; f++) {
        gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA, cubeN, cubeN, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._bandFaces[f]);
      }
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const nN = TUNE.NOISE_SIZE;
      this._noiseTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._noiseTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nN, nN, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._noiseData);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.activeTexture(gl.TEXTURE0);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      for (let i = 0; i < 2; i++) {
        const s = this._slots[i];
        s.posBuf = s.attrBuf = null;
        s.posCap = 0;
        if (s.count > 0) this._uploadSlot(s);
      }
    }

    _freeGL() {
      const gl = this.gl;
      const P = this._progs;
      if (P) {
        gl.deleteProgram(P.band.prog);
        gl.deleteProgram(P.sky.prog);
        gl.deleteProgram(P.part.prog);
        gl.deleteProgram(P.haze.prog);
        gl.deleteProgram(P.line.prog);
        for (let k = 0; k < 4; k++) gl.deleteProgram(P.spr[k].prog);
      }
      this._progs = null;
      for (const b of [this._triBuf, this._skyBuf, this._cornerBuf, this._idxBuf, this._sprBuf, this._lineBuf]) if (b) gl.deleteBuffer(b);
      if (this._bandTex) gl.deleteTexture(this._bandTex);
      if (this._noiseTex) gl.deleteTexture(this._noiseTex);
      this._triBuf = this._skyBuf = this._cornerBuf = this._idxBuf = this._sprBuf = this._lineBuf = null;
      this._bandTex = this._noiseTex = null;
    }

    _uploadSlot(s) {
      const gl = this.gl, n = s.count, p = s.particles;
      if (!s.posBuf) s.posBuf = gl.createBuffer();
      if (!s.attrBuf) s.attrBuf = gl.createBuffer();
      const pos = s.pos && s.pos.length >= n * 3 ? s.pos : p.pos;
      gl.bindBuffer(gl.ARRAY_BUFFER, s.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pos, s.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      s.posCap = pos.length;
      const a = new Float32Array(n * STRIDE_PART_ATTR), col = p.color, meta = p.meta;
      for (let i = 0, o = 0; i < n; i++, o += STRIDE_PART_ATTR) {
        a[o] = col[i * 4]; a[o + 1] = col[i * 4 + 1]; a[o + 2] = col[i * 4 + 2]; a[o + 3] = col[i * 4 + 3];
        a[o + 4] = meta[i * 3]; a[o + 5] = meta[i * 3 + 1]; a[o + 6] = meta[i * 3 + 2];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, s.attrBuf);
      gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
    }

    /** Enables vertex attribute arrays 0..n-1 and disables the rest. */
    _attribs(n) {
      const gl = this.gl;
      while (this._en < n) gl.enableVertexAttribArray(this._en++);
      while (this._en > n) gl.disableVertexAttribArray(--this._en);
    }

    // ---------------------------------------------------------------- frame
    render(frame) {
      if (this._lost || this._disposed || !frame || !frame.proj || !frame.view) return;
      const gl = this.gl;
      if (gl.isContextLost()) return;
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      gl.viewport(0, 0, W, H);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.clearColor(3 / 255, 5 / 255, 11 / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const proj = frame.proj, view = frame.view;
      const time = num(frame.time, 0);
      const fade = Math.max(0, num(frame.fade, 1));
      const skyA = Math.max(0, num(frame.skyAlpha, 1)) * fade;
      const effDpr = this.height > 0 ? H / this.height : this.dpr;
      const pxPerUnit = 0.5 * H * proj[5];

      const r = this._rot, ir = this._invRot;
      r[0] = view[0]; r[1] = view[1]; r[2] = view[2];
      r[3] = view[4]; r[4] = view[5]; r[5] = view[6];
      r[6] = view[8]; r[7] = view[9]; r[8] = view[10];
      ir[0] = view[0]; ir[1] = view[4]; ir[2] = view[8];
      ir[3] = view[1]; ir[4] = view[5]; ir[5] = view[9];
      ir[6] = view[2]; ir[7] = view[6]; ir[8] = view[10];

      if (skyA > 0.002) {
        this._drawBand(proj, skyA);
        this._drawSky(proj, time, skyA, effDpr);
      }
      const parts = frame.particles;
      if (parts && fade > 0.001) {
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) this._drawParticles(parts[i], view, proj, time, fade, pxPerUnit * TUNE.PARTICLE_WORLD, effDpr);
        }
      }
      if (frame.sprites && frame.sprites.count > 0 && fade > 0.001) this._drawSprites(frame.sprites, view, proj, time, fade, pxPerUnit);
      if (frame.lines && frame.lines.count > 0 && fade > 0.001) this._drawLines(frame.lines, view, proj, fade);
    }

    _drawBand(proj, a) {
      const gl = this.gl, p = this._progs.band;
      gl.useProgram(p.prog);
      gl.uniformMatrix3fv(p.u.uInvRot, false, this._invRot);
      gl.uniform2f(p.u.uInvProj, 1 / proj[0], 1 / proj[5]);
      gl.uniform1f(p.u.uIntensity, TUNE.BAND_INTENSITY * a);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, this._bandTex);
      this._attribs(1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._triBuf);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _drawSky(proj, time, a, dpr) {
      const gl = this.gl, p = this._progs.sky, st = STRIDE_SKY * 4;
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.u.uProj, false, proj);
      gl.uniformMatrix3fv(p.u.uRot, false, this._rot);
      gl.uniform4f(p.u.uS, time, a, dpr, TUNE.SKY_MIN_PX);
      this._attribs(3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._skyBuf);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, st, 0);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, st, 12);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, st, 28);
      gl.drawArrays(gl.POINTS, 0, TUNE.SKY_STARS);
    }

    _drawParticles(e, view, proj, time, fade, pointScale, dpr) {
      const s = this._slots[e.slot === 1 ? 1 : 0];
      if (!s.count || !s.posBuf || !s.attrBuf) return;
      const alpha = Math.max(0, num(e.alpha, 1)) * fade;
      if (alpha <= 0.001) return;
      const gl = this.gl, P = this._progs;
      const reveal = num(e.reveal, 1);
      const boost = reveal >= 1 ? 0 : 1 - GLX.util.smoothstep(0.985, 1.0, reveal);
      const mv = this._mv;
      if (e.model) GLX.math.multiply(mv, view, e.model);
      else mv.set(view);
      const maxPx = Math.min(TUNE.PARTICLE_MAX_PX * dpr, this._pointMax);
      const ast = STRIDE_PART_ATTR * 4;
      this._attribs(3);

      // Haze: every Nth particle as a big faint blob (stride trick, no extra buffers).
      const N = TUNE.HAZE_STRIDE;
      gl.useProgram(P.haze.prog);
      gl.uniformMatrix4fv(P.haze.u.uMV, false, mv);
      gl.uniformMatrix4fv(P.haze.u.uProj, false, proj);
      gl.uniform4f(P.haze.u.uA, pointScale, reveal, alpha, time);
      gl.uniform4f(P.haze.u.uH, TUNE.HAZE_SCALE, TUNE.HAZE_ALPHA, TUNE.HAZE_MIN_PX * dpr, maxPx);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.posBuf);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12 * N, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.attrBuf);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, ast * N, 0);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, ast * N, 16);
      gl.drawArrays(gl.POINTS, 0, Math.floor((s.count - 1) / N) + 1);

      gl.useProgram(P.part.prog);
      gl.uniformMatrix4fv(P.part.u.uMV, false, mv);
      gl.uniformMatrix4fv(P.part.u.uProj, false, proj);
      gl.uniform4f(P.part.u.uA, pointScale, reveal, alpha, time);
      gl.uniform4f(P.part.u.uB, TUNE.PARTICLE_MIN_PX, TUNE.PARTICLE_SOFT_PX * dpr, maxPx, boost);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.posBuf);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.attrBuf);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, ast, 0);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, ast, 16);
      gl.drawArrays(gl.POINTS, 0, s.count);
    }

    /** Expands sprites into 4 vertices each, bucketed by style (one draw call per style). Returns count. */
    _fillSprites(sb) {
      const src = sb.data, stride = sb.stride || 11;
      const n = Math.min(sb.count | 0, MAX_QUADS, Math.floor(src.length / stride));
      if (n <= 0) return 0;
      if (n > this._sprCap) {
        let cap = 256;
        while (cap < n) cap *= 2;
        cap = Math.min(cap, MAX_QUADS);
        this._sprVerts = new Float32Array(cap * SPR_QFLOATS);
        this._sprCap = cap;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._sprBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this._sprVerts.byteLength, gl.DYNAMIC_DRAW);
      }
      const cnt = this._styleCnt, off = this._styleOff, cur = this._styleCur;
      cnt[0] = cnt[1] = cnt[2] = cnt[3] = 0;
      for (let i = 0, o = 8; i < n; i++, o += stride) {
        const st = src[o] | 0;
        cnt[st >= 0 && st <= 3 ? st : 1]++;
      }
      let acc = 0;
      for (let k = 0; k < 4; k++) {
        const st = DRAW_ORDER[k];
        off[st] = cur[st] = acc;
        acc += cnt[st];
      }
      const dst = this._sprVerts;
      for (let i = 0, o = 0; i < n; i++, o += stride) {
        let st = src[o + 8] | 0;
        if (st < 0 || st > 3) st = 1;
        let d = cur[st]++ * SPR_QFLOATS;
        const x = src[o], y = src[o + 1], z = src[o + 2], sz = src[o + 3];
        const cr = src[o + 4], cg = src[o + 5], cb = src[o + 6], ca = src[o + 7], p1 = src[o + 9], p2 = src[o + 10];
        for (let k = 0; k < 4; k++, d += SPR_VFLOATS) {
          dst[d] = x; dst[d + 1] = y; dst[d + 2] = z; dst[d + 3] = sz;
          dst[d + 4] = cr; dst[d + 5] = cg; dst[d + 6] = cb; dst[d + 7] = ca;
          dst[d + 8] = p1; dst[d + 9] = p2;
        }
      }
      return n;
    }

    _drawSprites(sb, view, proj, time, fade, pxPerUnit) {
      const n = this._fillSprites(sb);
      if (!n) return;
      const gl = this.gl, P = this._progs, st = SPR_VFLOATS * 4;
      gl.bindBuffer(gl.ARRAY_BUFFER, this._sprBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, bucketView(this._sprViews, this._sprVerts, n * SPR_QFLOATS));
      this._attribs(4);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, st, 0);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, st, 16);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, st, 32);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._cornerBuf);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._idxBuf);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._noiseTex);
      gl.activeTexture(gl.TEXTURE0);
      for (let k = 0; k < 4; k++) {
        const style = DRAW_ORDER[k], c = this._styleCnt[style];
        if (!c) continue;
        const p = P.spr[style];
        const minHalf = style === 0 ? TUNE.STAR_MIN_HALF_PX : style === 1 ? TUNE.GLOW_MIN_HALF_PX : style === 2 ? TUNE.RING_MIN_HALF_PX : 0;
        gl.useProgram(p.prog);
        gl.uniformMatrix4fv(p.u.uView, false, view);
        gl.uniformMatrix4fv(p.u.uProj, false, proj);
        gl.uniform4f(p.u.uU, pxPerUnit, minHalf, fade, time);
        gl.drawElements(gl.TRIANGLES, c * 6, gl.UNSIGNED_SHORT, this._styleOff[style] * 12);
      }
    }

    _drawLines(lb, view, proj, fade) {
      const data = lb.data, n = Math.min(lb.count | 0, Math.floor(data.length / 14));
      if (n <= 0) return;
      const gl = this.gl, p = this._progs.line;
      gl.bindBuffer(gl.ARRAY_BUFFER, this._lineBuf);
      if (data !== this._lineSrc) {
        this._lineSrc = data;
        gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, bucketView(this._lineViews, data, n * 14));
      GLX.math.multiply(this._vp, proj, view);
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.u.uViewProj, false, this._vp);
      gl.uniform1f(p.u.uFade, fade);
      this._attribs(2);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
      gl.drawArrays(gl.LINES, 0, n * 2);
    }
  }

  Renderer.TUNING = TUNE;
  GLX.Renderer = Renderer;
})();
