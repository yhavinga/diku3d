/**
 * What a spell looks and sounds like.
 *
 * The rules are magic.js's. Every spell arrives here as two events on the
 * game's sink: `cast` when the words begin -- with how long they take
 * (`windup`) and how long whatever is released takes to cross the room
 * (`flight`) -- and `spell` when magic.js resolves it, with who was hurt and
 * whether they saved. Between the two this draws the gathering at the
 * caster's hand, the runic circle under their feet, and the thing in flight;
 * on `spell` it draws the impact, so the fire and the number land together.
 * Lasting affects (sanctuary, faerie fire, armour, bless, curse, poison,
 * blindness) are read off each visible character every frame and drawn for as
 * long as they last.
 *
 * Everything is built at boot, nothing is loaded: the smoke is a noise field
 * baked into a texture here, the runes are a fragment shader, fire is fbm.
 *
 * What it costs is bounded up front, because the expensive pixels in this
 * scene are large soft sprites (CLAUDE.md's chimney smoke):
 *   - two pooled point clouds (light and matter), sized by the quality
 *     preset, with a hard cap on a sprite's size on screen;
 *   - two ribbon batches (lightning, trails, rays, tendrils), rebuilt on the
 *     CPU from a few hundred segments at most;
 *   - a handful of ground decals and fire spheres, pooled;
 *   - `LIGHTS` point lights that are always in the scene and merely dark when
 *     idle, so the number of lights -- and with it every lit material's
 *     shader -- never changes when a fireball goes off;
 *   - a heat-haze pass that only runs while something hot is in the air.
 *
 * Brightness is authored in display units: a colour of 1 comes out of ACES at
 * about 0.8, whatever the hour, because every shader here multiplies by
 * `0.6 / exposure` (three's ACES divides by 0.6). The bloom threshold is read
 * in linear HDR before exposure, which in these units is about 12 at noon,
 * 23 at dusk and 4 at night -- so only the small hot cores (10-30) bloom by
 * day, and the broad glows (0.5-3) never do.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OVERLAY_LAYER } from './render.js';
import { AFF } from './magic.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (u) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

/** How much of everything each preset may draw. */
const BUDGET = {
  low: { light: 700, matter: 260, ribbon: 1400, density: 0.45, lights: 1, heat: false, maxPx: 0.18 },
  medium: { light: 1300, matter: 500, ribbon: 2600, density: 0.7, lights: 2, heat: false, maxPx: 0.24 },
  high: { light: 2200, matter: 800, ribbon: 4000, density: 1, lights: 2, heat: true, maxPx: 0.3 },
  max: { light: 3000, matter: 1100, ribbon: 5200, density: 1.25, lights: 2, heat: true, maxPx: 0.34 },
};
const LIGHTS = 2;   // always in the scene; measured at 0.12 ms each at 1280x720 (see the head of the file)

// -------------------------------------------------------------- palette ----
// Display units (see the head of the file). `hot` is a core meant to bloom.
const C = (r, g, b) => new THREE.Color(r, g, b);
const PAL = {
  missile: { glow: C(0.6, 0.34, 1.6), core: C(7, 5.5, 12), trail: C(0.42, 0.24, 1.3), light: 0x9a7cff },
  fire: { glow: C(1.35, 0.42, 0.07), core: C(10, 5.5, 1.8), ember: C(2.6, 0.9, 0.15), dark: C(0.4, 0.07, 0.015), light: 0xff8a3a },
  lightning: { glow: C(0.55, 0.75, 1.9), core: C(14, 16, 22), light: 0xb8d4ff },
  frost: { glow: C(0.45, 0.85, 1.7), crystal: C(1.6, 2.4, 3.6), mist: C(0.5, 0.7, 1.0), light: 0x9fd0ff },
  acid: { glow: C(0.55, 1.6, 0.18), drop: C(0.9, 2.6, 0.22), fume: C(0.42, 0.55, 0.16), light: 0x8cff4a },
  heal: { glow: C(1.9, 1.5, 0.8), mote: C(3.0, 2.5, 1.3), light: 0xffd9a0 },
  refresh: { glow: C(0.7, 1.7, 1.3), mote: C(1.4, 3.0, 2.3), light: 0xa0ffd8 },
  ward: { glow: C(0.75, 1.0, 1.9), mote: C(1.4, 1.9, 3.2), light: 0xa8c8ff },
  bless: { glow: C(1.9, 1.5, 0.6), mote: C(3.2, 2.6, 1.1), light: 0xffe0a0 },
  sanctuary: { glow: C(1.8, 1.8, 1.9), mote: C(3.2, 3.2, 3.4), light: 0xf4f6ff },
  dark: { glow: C(0.55, 0.12, 0.9), smoke: C(0.07, 0.03, 0.09), light: 0x7a3cff },
  harm: { glow: C(1.9, 0.18, 0.12), smoke: C(0.08, 0.01, 0.01), light: 0xff3a2a },
  poison: { glow: C(0.55, 1.5, 0.25), smoke: C(0.12, 0.2, 0.05), light: 0x7aff4a },
  faerie: { glow: C(2.0, 0.55, 1.3), mote: C(3.4, 1.1, 2.4), light: 0xff78c8 },
  holy: { glow: C(2.0, 1.8, 1.2), core: C(14, 12, 8), light: 0xfff0c8 },
  dispel: { glow: C(0.6, 1.6, 1.9), light: 0x9ff0ff },
  dust: { smoke: C(0.46, 0.41, 0.34) },
  gas: { smoke: C(0.34, 0.46, 0.14), glow: C(0.5, 1.2, 0.2), light: 0xb8ff6a },
};
const PRISM = [C(2.6, 0.2, 0.15), C(2.6, 1.0, 0.1), C(2.3, 2.1, 0.2), C(0.3, 2.4, 0.35), C(0.2, 1.2, 2.8), C(0.9, 0.3, 2.8), C(2.2, 0.35, 2.0)];

/** Which palette a spell family is gathered, cast and landed in. */
const FAMILY = {
  missile: 'missile', fireball: 'fire', flame: 'fire', flamestrike: 'fire', 'breath-fire': 'fire',
  lightning: 'lightning', shock: 'lightning', storm: 'lightning', 'breath-lightning': 'lightning',
  frost: 'frost', 'breath-frost': 'frost', acid: 'acid', 'breath-acid': 'acid', 'breath-gas': 'gas',
  prism: 'missile', heal: 'heal', refresh: 'refresh', ward: 'ward', bless: 'bless', sanctuary: 'sanctuary',
  curse: 'dark', drain: 'harm', harm: 'harm', weaken: 'dark', blind: 'dark', hex: 'dark', poison: 'poison',
  faerie: 'faerie', holy: 'holy', dispel: 'dispel', sight: 'ward', teleport: 'dispel', quake: 'holy',
};
const pal = (family) => PAL[FAMILY[family] || 'ward'];

// ---------------------------------------------------------------- shaders ----

const NOISE_GLSL = `
  float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float vnoise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
`;

/** Fog as transmittance: light fades into the haze instead of taking its colour. */
const FOG_GLSL = `
  uniform float uFogDensity;
  float fogT(float dist) { float d = uFogDensity * dist; return exp(-d * d); }
`;

const POINT_VERT = `
  attribute vec3 aColor;
  attribute vec3 aInfo;     // shape, seed, occlusion
  attribute float aSize;
  attribute float aAlpha;
  uniform float uScale;
  uniform float uMaxPx;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vInfo;
  varying float vDist;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float px = aSize * uScale / max(0.05, -mv.z);
    // Past the cap the sprite stops growing and fades instead: a puff held
    // up against the lens is the one thing that could fill the frame.
    float capped = min(px, uMaxPx);
    gl_PointSize = max(1.0, capped);
    vColor = aColor;
    vAlpha = aAlpha * (px > uMaxPx ? uMaxPx / px : 1.0) * (px < 1.0 ? px : 1.0);
    vInfo = aInfo;
    vDist = -mv.z;
  }
`;

const POINT_FRAG = `
  uniform sampler2D uNoise;
  uniform float uGain;
  uniform float uMatter;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vInfo;
  varying float vDist;
  ${FOG_GLSL}
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float shape = vInfo.x;
    float seed = vInfo.y;
    float a;
    if (shape < 0.5) {                 // soft glow
      a = exp(-r2 * 3.2) - 0.04;
    } else if (shape < 1.5) {          // spark: hot point, small halo
      a = exp(-r2 * 26.0) * 1.6 + exp(-r2 * 5.0) * 0.28;
    } else if (shape < 2.5) {          // crystal: a turned diamond with a cross glint
      float ang = seed * 6.2831;
      vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c;
      float d = abs(q.x) * 1.9 + abs(q.y);
      a = smoothstep(1.0, 0.55, d) * 0.9 + exp(-abs(q.x * q.y) * 90.0) * exp(-r2 * 2.0) * 0.8;
    } else if (shape < 3.5) {          // smoke: a noise puff, turned by its seed
      float ang = seed * 6.2831;
      vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c;
      float n = texture2D(uNoise, q * 0.34 + vec2(seed * 7.3, seed * 3.1)).r;
      a = smoothstep(1.0, 0.1, r2) * smoothstep(0.22, 0.78, n + (1.0 - r2) * 0.35);
    } else if (shape < 4.5) {          // flame: soft, with a torn edge
      float n = texture2D(uNoise, c * 0.3 + vec2(seed * 5.1, seed * 9.7)).r;
      a = exp(-r2 * 2.4) * smoothstep(0.15, 0.7, n + (1.0 - r2) * 0.55) * 1.25;
    } else if (shape < 5.5) {          // bubble: a thin ring with a lit rim
      float r = sqrt(r2);
      a = smoothstep(0.62, 0.8, r) * smoothstep(1.0, 0.86, r) * 0.9 + exp(-dot(c - vec2(-0.3, 0.35), c - vec2(-0.3, 0.35)) * 40.0) * 0.6;
    } else {                           // blob: a bead of liquid with a highlight
      a = smoothstep(1.0, 0.55, r2) * 0.85 + exp(-dot(c - vec2(-0.3, 0.3), c - vec2(-0.3, 0.3)) * 18.0) * 0.8;
    }
    a = clamp(a, 0.0, 2.0) * vAlpha * fogT(vDist);
    // Both pools blend ONE / ONE_MINUS_SRC_ALPHA on premultiplied colour.
    // Matter covers what is behind it and is lit, not emissive. Light adds,
    // except for its occlusion share: fire has body, and over a sunlit
    // wall a purely additive flame only ever bleaches it towards white.
    vec3 col = vColor * uGain;
    gl_FragColor = uMatter > 0.5 ? vec4(col * min(a, 1.0), min(a, 1.0)) : vec4(col * a, min(a, 1.0) * vInfo.z);
  }
`;

const RIBBON_VERT = `
  attribute vec3 aColor;
  attribute vec3 aUv;       // along, across (-1..1), sharpness
  attribute float aAlpha;
  varying vec3 vColor;
  varying vec3 vUv;
  varying float vAlpha;
  varying float vDist;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor; vUv = aUv; vAlpha = aAlpha; vDist = -mv.z;
  }
`;
const RIBBON_FRAG = `
  uniform float uGain;
  uniform float uMatter;
  uniform float uOcc;
  varying vec3 vColor;
  varying vec3 vUv;
  varying float vAlpha;
  varying float vDist;
  ${FOG_GLSL}
  void main() {
    float y = vUv.y;
    float soft = exp(-y * y * 3.0);
    float hard = smoothstep(1.0, 0.35, abs(y));
    float a = mix(soft, hard, vUv.z) * vAlpha * fogT(vDist);
    vec3 col = vColor * uGain;
    gl_FragColor = uMatter > 0.5 ? vec4(col * min(a, 1.0), min(a, 1.0)) : vec4(col * a, min(a, 1.0) * uOcc);
  }
`;

const DECAL_VERT = `
  varying vec2 vUv;
  varying float vDist;
  void main() {
    vUv = uv * 2.0 - 1.0;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
/**
 * The ground under a spell. `uMode` 0 is the casting circle: three rings, a
 * band of runes that are drawn on as it opens (each cell a glyph of a few
 * strokes picked by hash), a hexagram inside turning the other way. 1 is a
 * shockwave ring, 2 a soft pool of light.
 */
const DECAL_FRAG = `
  uniform float uMode;
  uniform float uTime;
  uniform float uOpen;      // 0..1 draw-on
  uniform float uAlpha;
  uniform float uRadius;    // for the ring: where the front is, 0..1
  uniform vec3 uColor;
  uniform float uGain;
  varying vec2 vUv;
  varying float vDist;
  ${FOG_GLSL}
  float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  float line(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }
  float band(float r, float at, float w) { return smoothstep(w, 0.0, abs(r - at)); }
  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    float ang = atan(vUv.y, vUv.x);
    float a = 0.0;
    if (uMode < 0.5) {
      // draw-on: everything past the opening angle is not there yet
      float sweep = fract((ang + 3.14159) / 6.28318 + 0.25);
      float drawn = smoothstep(uOpen * 1.08 - 0.08, uOpen * 1.08, sweep) < 0.5 ? 1.0 : 0.0;
      a += band(r, 0.96, 0.012) + band(r, 0.84, 0.008) * 0.8 + band(r, 0.52, 0.01) * 0.7;
      // runes, turning slowly
      float cells = 22.0;
      float ra = ang + uTime * 0.25;
      float cell = floor((ra / 6.28318 + 0.5) * cells);
      float u = fract((ra / 6.28318 + 0.5) * cells) * 2.0 - 1.0;
      float v = (r - 0.9) / 0.055;
      vec2 p = vec2(u * 0.8, v);
      float g = 1.0;
      float s = h1(cell + 1.0);
      g = min(g, line(p, vec2(-0.1, -0.8), vec2(-0.1, 0.8)));
      if (s > 0.25) g = min(g, line(p, vec2(-0.1, 0.7), vec2(0.5, 0.2)));
      if (fract(s * 7.0) > 0.4) g = min(g, line(p, vec2(-0.1, -0.1), vec2(0.5, -0.6)));
      if (fract(s * 13.0) > 0.5) g = min(g, line(p, vec2(-0.6, 0.4), vec2(-0.1, 0.0)));
      if (fract(s * 29.0) > 0.6) g = min(g, line(p, vec2(0.45, -0.8), vec2(0.45, 0.8)));
      a += smoothstep(0.16, 0.05, g) * step(abs(v), 1.2) * 0.9;
      // hexagram, turning the other way
      float ia = ang - uTime * 0.4;
      vec2 q = vec2(cos(ia), sin(ia)) * r;
      float hex = 1.0;
      for (int k = 0; k < 6; k++) {
        float t0 = float(k) * 1.0472 * 2.0;
        vec2 a0 = vec2(cos(t0), sin(t0)) * 0.8;
        vec2 a1 = vec2(cos(t0 + 2.0944), sin(t0 + 2.0944)) * 0.8;
        if (k >= 3) { a0 = vec2(cos(t0 + 1.0472), sin(t0 + 1.0472)) * 0.8; a1 = vec2(cos(t0 + 3.1416), sin(t0 + 3.1416)) * 0.8; }
        hex = min(hex, line(q, a0, a1));
      }
      a += smoothstep(0.014, 0.0, hex) * 0.6 * step(r, 0.82);
      a += exp(-r * r * 6.0) * 0.18;          // a little light pooled in the middle
      a *= drawn;
    } else if (uMode < 1.5) {
      float front = uRadius;
      a = exp(-pow((r - front) / 0.06, 2.0)) * (1.0 - front * 0.6) + smoothstep(front, 0.0, r) * 0.12 * (1.0 - front);
    } else {
      a = exp(-r * r * 3.5);
    }
    a *= uAlpha * fogT(vDist);
    gl_FragColor = vec4(uColor * uGain * a, 0.0);
  }
`;

/** A ball of fire: fbm moving through it, hottest where you look straight in. */
const FIRE_VERT = `
  varying vec3 vP;
  varying vec3 vN;
  varying vec3 vV;
  varying float vDist;
  void main() {
    vP = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const FIRE_FRAG = `
  uniform float uTime;
  uniform float uHeat;      // 1 fresh, falling to 0 as it burns out
  uniform float uAlpha;
  uniform float uGain;
  uniform float uSeed;
  varying vec3 vP;
  varying vec3 vN;
  varying vec3 vV;
  varying float vDist;
  ${NOISE_GLSL}
  ${FOG_GLSL}
  void main() {
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float n = fbm(vP * 2.6 + vec3(uSeed, -uTime * 3.2, uSeed * 0.7));
    float t = clamp(pow(facing, 1.3) * 0.6 + n * 0.95 - (1.0 - uHeat) * 0.85 - 0.12, 0.0, 1.0);
    vec3 col = mix(vec3(0.22, 0.02, 0.0), vec3(1.25, 0.34, 0.04), smoothstep(0.08, 0.45, t));
    col = mix(col, vec3(2.6, 1.3, 0.3), smoothstep(0.45, 0.8, t));
    col = mix(col, vec3(9.0, 6.5, 3.0), smoothstep(0.86, 1.0, t) * uHeat);
    // The silhouette is torn by the same noise, so the ball has no hard rim.
    float a = smoothstep(0.06, 0.3, t) * smoothstep(0.02, 0.45, facing * (0.6 + n)) * uAlpha * fogT(vDist);
    // Premultiplied, with a share of cover: the ball has a body.
    gl_FragColor = vec4(col * uGain * a, a * 0.55);
  }
`;

/** The lasting aura: a shell over the body, bright at the silhouette, shimmering upward. */
const AURA_VERT = `
  #include <common>
  #include <skinning_pars_vertex>
  uniform float uThick;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vW;
  varying float vDist;
  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    transformed += normalize(objectNormal) * uThick;
    vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
    vN = normalize(normalMatrix * objectNormal);
    vV = normalize(-mv.xyz);
    vW = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const AURA_FRAG = `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uGain;
  uniform float uFlicker;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vW;
  varying float vDist;
  ${NOISE_GLSL}
  ${FOG_GLSL}
  void main() {
    float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    // Only the silhouette: facing surfaces add nothing, so the body stays
    // readable inside its halo even at arm's length.
    float f = pow(rim, 3.2);
    float n = vnoise(vW * 3.2 + vec3(0.0, -uTime * 1.3, 0.0));
    float flick = mix(1.0, 0.6 + 0.8 * vnoise(vec3(uTime * 9.0, vW.y * 2.0, 0.0)), uFlicker);
    float a = f * 1.5 * (0.25 + 1.0 * n) * uIntensity * flick * fogT(vDist);
    gl_FragColor = vec4(uColor * uGain * a, 0.0);
  }
`;

// ------------------------------------------------------------ noise map ----

/** A tiling fbm field, for smoke and flame sprites. */
function noiseTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  const lattice = (n) => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = Math.random();
    return (x, y) => {
      const xi = Math.floor(x); const yi = Math.floor(y);
      const fx = x - xi; const fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx); const sy = fy * fy * (3 - 2 * fy);
      const at = (i, j) => g[((j % n + n) % n) * n + ((i % n + n) % n)];
      return lerp(lerp(at(xi, yi), at(xi + 1, yi), sx), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), sx), sy);
    };
  };
  const octaves = [4, 8, 16, 32].map((n) => ({ n, f: lattice(n) }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0; let amp = 0.5; let sum = 0;
      for (const { n, f } of octaves) { v += f((x / size) * n, (y / size) * n) * amp; sum += amp; amp *= 0.5; }
      const b = Math.round(clamp(v / sum, 0, 1) * 255);
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = b; data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// -------------------------------------------------------------- particles ----

/**
 * A pool of point sprites simulated on the CPU in flat arrays. A particle may
 * be anchored: then its position is an offset from a point that moves (a
 * hand, a body), and it can swirl about that point's vertical and be drawn in
 * towards it -- which is how the gathering at a hand follows the hand.
 */
class Pool {
  constructor(max, matter, noise, uniforms) {
    this.max = max;
    this.n = 0;
    const F = (k) => new Float32Array(max * k);
    this.p = F(3); this.v = F(3); this.c0 = F(3); this.c1 = F(3);
    this.life = F(1); this.age = F(1); this.s0 = F(1); this.s1 = F(1); this.a0 = F(1);
    this.drag = F(1); this.grav = F(1); this.shape = F(1); this.seed = F(1);
    this.fadeIn = F(1); this.anchor = new Int16Array(max); this.swirl = F(1); this.pull = F(1); this.occ = F(1);
    this.floor = F(1);

    const g = new THREE.BufferGeometry();
    this.gp = F(3); this.gc = F(3); this.gi = F(3); this.gs = F(1); this.ga = F(1);
    const attr = (name, arr, k) => g.setAttribute(name, new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage));
    attr('position', this.gp, 3); attr('aColor', this.gc, 3); attr('aInfo', this.gi, 3);
    attr('aSize', this.gs, 1); attr('aAlpha', this.ga, 1);
    g.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: {
        ...uniforms,
        uNoise: { value: noise },
        uMatter: { value: matter ? 1 : 0 },
        uScale: { value: 800 },
        uMaxPx: { value: 300 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = matter ? 5 : 6;
    this.points.layers.set(OVERLAY_LAYER);
  }

  /**
   * One particle. `o`: x,y,z, vx,vy,vz, life, size, grow (end size as a
   * multiple), color, color2, alpha, drag, gravity (negative rises), shape,
   * fadeIn (fraction of life), anchor (id), swirl (rad/s), pull (1/s), floor.
   */
  spawn(o) {
    if (this.n >= this.max) return;   // full: the newest go without, not the oldest
    const i = this.n++;
    const i3 = i * 3;
    this.p[i3] = o.x; this.p[i3 + 1] = o.y; this.p[i3 + 2] = o.z;
    this.v[i3] = o.vx || 0; this.v[i3 + 1] = o.vy || 0; this.v[i3 + 2] = o.vz || 0;
    const c = o.color; const c2 = o.color2 || c;
    this.c0[i3] = c.r; this.c0[i3 + 1] = c.g; this.c0[i3 + 2] = c.b;
    this.c1[i3] = c2.r; this.c1[i3 + 1] = c2.g; this.c1[i3 + 2] = c2.b;
    this.life[i] = o.life; this.age[i] = 0;
    this.s0[i] = o.size; this.s1[i] = o.size * (o.grow ?? 1);
    this.a0[i] = o.alpha ?? 1;
    this.drag[i] = o.drag ?? 1.2; this.grav[i] = o.gravity ?? 0;
    this.shape[i] = o.shape ?? 0; this.seed[i] = o.seed ?? Math.random();
    this.fadeIn[i] = o.fadeIn ?? 0.08;
    this.anchor[i] = o.anchor ?? -1;
    this.swirl[i] = o.swirl || 0; this.pull[i] = o.pull || 0;
    this.floor[i] = o.floor ?? -1e9;
    // Flame has a body; a soft glow a little; a spark none.
    this.occ[i] = o.occ ?? (this.shape[i] > 3.5 && this.shape[i] < 4.5 ? 0.45 : this.shape[i] < 0.5 ? 0.08 : 0);
    if (o.anchor !== undefined && o.anchor >= 0 && this.anchors) this.anchors.ref(o.anchor, 1);
  }

  kill(i) {
    const last = --this.n;
    if (this.anchor[i] >= 0 && this.anchors) this.anchors.ref(this.anchor[i], -1);
    if (i === last) return;
    const move3 = (arr) => { arr[i * 3] = arr[last * 3]; arr[i * 3 + 1] = arr[last * 3 + 1]; arr[i * 3 + 2] = arr[last * 3 + 2]; };
    const move1 = (arr) => { arr[i] = arr[last]; };
    move3(this.p); move3(this.v); move3(this.c0); move3(this.c1);
    for (const arr of [this.life, this.age, this.s0, this.s1, this.a0, this.drag, this.grav, this.shape,
      this.seed, this.fadeIn, this.anchor, this.swirl, this.pull, this.floor, this.occ]) move1(arr);
  }

  update(dt, anchors) {
    const A = anchors.pos;
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.kill(i); continue; }
      const i3 = i * 3;
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i3] *= k; this.v[i3 + 2] *= k;
      this.v[i3 + 1] = this.v[i3 + 1] * k - this.grav[i] * dt;
      let x = this.p[i3] + this.v[i3] * dt;
      let y = this.p[i3 + 1] + this.v[i3 + 1] * dt;
      let z = this.p[i3 + 2] + this.v[i3 + 2] * dt;
      if (this.swirl[i]) {
        const a = this.swirl[i] * dt; const ca = Math.cos(a); const sa = Math.sin(a);
        const nx = x * ca - z * sa; z = x * sa + z * ca; x = nx;
      }
      if (this.pull[i]) { const q = Math.exp(-this.pull[i] * dt); x *= q; y *= q; z *= q; }
      if (y < this.floor[i]) { y = this.floor[i]; this.v[i3 + 1] = Math.abs(this.v[i3 + 1]) * 0.15; this.v[i3] *= 0.5; this.v[i3 + 2] *= 0.5; }
      this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;
    }
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3;
      const u = this.age[i] / this.life[i];
      const an = this.anchor[i];
      const ox = an >= 0 ? A[an * 3] : 0; const oy = an >= 0 ? A[an * 3 + 1] : 0; const oz = an >= 0 ? A[an * 3 + 2] : 0;
      this.gp[i3] = this.p[i3] + ox; this.gp[i3 + 1] = this.p[i3 + 1] + oy; this.gp[i3 + 2] = this.p[i3 + 2] + oz;
      this.gc[i3] = lerp(this.c0[i3], this.c1[i3], u);
      this.gc[i3 + 1] = lerp(this.c0[i3 + 1], this.c1[i3 + 1], u);
      this.gc[i3 + 2] = lerp(this.c0[i3 + 2], this.c1[i3 + 2], u);
      this.gs[i] = lerp(this.s0[i], this.s1[i], 1 - (1 - u) * (1 - u));
      const fi = this.fadeIn[i];
      const inA = fi > 0 ? Math.min(1, u / fi) : 1;
      this.ga[i] = this.a0[i] * inA * (1 - u) * (1 - u * 0.35);
      this.gi[i3] = this.shape[i]; this.gi[i3 + 1] = this.seed[i]; this.gi[i3 + 2] = this.occ[i];
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    for (const name of ['position', 'aColor', 'aInfo', 'aSize', 'aAlpha']) {
      const at = g.attributes[name];
      at.needsUpdate = this.n > 0;
      at.clearUpdateRanges();
      if (this.n > 0) at.addUpdateRange(0, this.n * at.itemSize);
    }
  }
}

/** Moving points particles can hang off; freed when nothing refers to them. */
class Anchors {
  constructor(max = 96) {
    this.pos = new Float32Array(max * 3);
    this.refs = new Int32Array(max);
    this.free = [];
    for (let i = max - 1; i >= 0; i--) this.free.push(i);
  }

  take(p) {
    const id = this.free.pop();
    if (id === undefined) return -1;
    this.refs[id] = 1;   // the holder's own reference
    this.set(id, p);
    return id;
  }

  set(id, p) { if (id < 0) return; this.pos[id * 3] = p.x; this.pos[id * 3 + 1] = p.y; this.pos[id * 3 + 2] = p.z; }

  ref(id, d) {
    if (id < 0) return;
    this.refs[id] += d;
    if (this.refs[id] <= 0) { this.refs[id] = 0; this.free.push(id); }
  }

  release(id) { this.ref(id, -1); }
}

// ---------------------------------------------------------------- ribbons ----

/**
 * Camera-facing strips along polylines, rebuilt every frame: lightning,
 * trails, rays, tendrils. Each call to `strip` is one polyline.
 */
class Ribbons {
  constructor(maxVerts, matter, uniforms) {
    this.max = maxVerts;
    this.pos = new Float32Array(maxVerts * 3);
    this.col = new Float32Array(maxVerts * 3);
    this.uv = new Float32Array(maxVerts * 3);
    this.alpha = new Float32Array(maxVerts);
    this.index = new Uint16Array(maxVerts * 3);
    this.v = 0; this.i = 0;
    const g = new THREE.BufferGeometry();
    const attr = (name, arr, k) => g.setAttribute(name, new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage));
    attr('position', this.pos, 3); attr('aColor', this.col, 3); attr('aUv', this.uv, 3); attr('aAlpha', this.alpha, 1);
    g.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      // A little cover under the light, for the same reason as the points:
      // colour survives in front of a sunlit wall.
      uniforms: { ...uniforms, uMatter: { value: matter ? 1 : 0 }, uOcc: { value: 0.3 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = matter ? 5 : 7;
    this.mesh.layers.set(OVERLAY_LAYER);
    this._side = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._eye = new THREE.Vector3();
  }

  begin(eye) { this.v = 0; this.i = 0; this._eye.copy(eye); }

  /**
   * `pts` an array of {x,y,z}; `width(u)` metres; `color(u)` a Color;
   * `alpha(u)`; `sharp` 0 soft to 1 hard-edged.
   */
  strip(pts, width, color, alpha, sharp = 0) {
    const n = pts.length;
    if (n < 2 || this.v + n * 2 > this.max) return;
    const base = this.v;
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)]; const b = pts[Math.min(n - 1, k + 1)];
      this._dir.set(b.x - a.x, b.y - a.y, b.z - a.z);
      const p = pts[k];
      this._side.set(p.x - this._eye.x, p.y - this._eye.y, p.z - this._eye.z).cross(this._dir);
      const len = this._side.length() || 1;
      const u = k / (n - 1);
      const w = (typeof width === 'function' ? width(u) : width) / 2 / len;
      const c = typeof color === 'function' ? color(u) : color;
      const al = typeof alpha === 'function' ? alpha(u) : alpha;
      for (const s of [-1, 1]) {
        const o = this.v * 3;
        this.pos[o] = p.x + this._side.x * w * s; this.pos[o + 1] = p.y + this._side.y * w * s; this.pos[o + 2] = p.z + this._side.z * w * s;
        this.col[o] = c.r; this.col[o + 1] = c.g; this.col[o + 2] = c.b;
        this.uv[o] = u; this.uv[o + 1] = s; this.uv[o + 2] = sharp;
        this.alpha[this.v] = al;
        this.v++;
      }
    }
    for (let k = 0; k < n - 1; k++) {
      const a = base + k * 2;
      this.index[this.i++] = a; this.index[this.i++] = a + 1; this.index[this.i++] = a + 2;
      this.index[this.i++] = a + 1; this.index[this.i++] = a + 3; this.index[this.i++] = a + 2;
    }
  }

  end() {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.i);
    for (const name of ['position', 'aColor', 'aUv', 'aAlpha']) {
      const at = g.attributes[name];
      at.needsUpdate = this.v > 0;
      at.clearUpdateRanges();
      if (this.v > 0) at.addUpdateRange(0, this.v * at.itemSize);
    }
    g.index.needsUpdate = this.i > 0;
    g.index.clearUpdateRanges();
    if (this.i > 0) g.index.addUpdateRange(0, this.i);
    this.mesh.visible = this.i > 0;
  }
}

/** A jagged path from a to b: midpoint displacement, `depth` times. */
function bolt(a, b, jag = 0.22, depth = 5) {
  let pts = [a, b];
  let amp = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * jag;
  for (let d = 0; d < depth; d++) {
    const next = [pts[0]];
    for (let k = 0; k < pts.length - 1; k++) {
      const p = pts[k]; const q = pts[k + 1];
      next.push({ x: (p.x + q.x) / 2 + rand(-amp, amp), y: (p.y + q.y) / 2 + rand(-amp, amp) * 0.8, z: (p.z + q.z) / 2 + rand(-amp, amp) });
      next.push(q);
    }
    pts = next;
    amp *= 0.52;
  }
  return pts;
}

// ------------------------------------------------------------- heat haze ----

/**
 * Heat shimmer: sprites that write a screen-space offset into a small target,
 * then one full-screen pass that reads the frame through it. Runs only while
 * something hot is in the air; otherwise `enabled` is false and it costs
 * nothing.
 */
class HeatPass extends Pass {
  constructor(camera, noise) {
    super();
    this.camera = camera;
    this.needsSwap = true;
    this.enabled = false;
    this.target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    this.scene = new THREE.Scene();
    this.max = 160;
    this.n = 0;
    this.p = new Float32Array(this.max * 3);
    this.sz = new Float32Array(this.max);
    this.al = new Float32Array(this.max);
    this.seed = new Float32Array(this.max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.sz, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.al, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage));
    this.spriteMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute float aSeed;
        uniform float uScale; varying float vA; varying float vSeed;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aSize * uScale / max(0.05, -mv.z), 260.0);
          vA = aAlpha; vSeed = aSeed;
        }`,
      fragmentShader: `
        uniform sampler2D uNoise; uniform float uTime;
        varying float vA; varying float vSeed;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(c, c);
          if (r2 > 1.0) discard;
          vec2 q = c * 0.4 + vec2(vSeed * 5.0, vSeed * 3.0 - uTime * 0.9);
          float nx = texture2D(uNoise, q).r - texture2D(uNoise, q + vec2(0.07, 0.0)).r;
          float ny = texture2D(uNoise, q).r - texture2D(uNoise, q + vec2(0.0, 0.07)).r;
          float w = exp(-r2 * 2.5) * vA;
          gl_FragColor = vec4(nx * w, ny * w, 0.0, 1.0);
        }`,
      uniforms: { uNoise: { value: noise }, uScale: { value: 400 }, uTime: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.spriteMaterial);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tHeat: { value: null }, uStrength: { value: 0.028 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform sampler2D tHeat; uniform float uStrength;
        varying vec2 vUv;
        void main() {
          vec2 o = texture2D(tHeat, vUv).rg * uStrength;
          gl_FragColor = texture2D(tDiffuse, vUv + o);
        }`,
      depthTest: false,
      depthWrite: false,
    }));
    this.live = [];
  }

  setSize(width, height) {
    this.target.setSize(Math.max(2, Math.round(width / 3)), Math.max(2, Math.round(height / 3)));
    this.spriteMaterial.uniforms.uScale.value = (height / 3) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  add(x, y, z, size, life, strength = 1) {
    if (this.live.length >= this.max) return;
    this.live.push({ x, y, z, size, life, t: 0, strength, seed: Math.random(), vy: rand(0.4, 0.9) });
  }

  step(dt, time) {
    this.spriteMaterial.uniforms.uTime.value = time;
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const h = this.live[i];
      h.t += dt;
      if (h.t >= h.life) { this.live.splice(i, 1); continue; }
      h.y += h.vy * dt;
    }
    for (const h of this.live) {
      const u = h.t / h.life;
      this.p[n * 3] = h.x; this.p[n * 3 + 1] = h.y; this.p[n * 3 + 2] = h.z;
      this.sz[n] = h.size * (1 + u * 0.8);
      this.al[n] = h.strength * Math.sin(Math.PI * u);
      this.seed[n] = h.seed;
      n++;
    }
    this.n = n;
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    for (const k of ['position', 'aSize', 'aAlpha', 'aSeed']) g.attributes[k].needsUpdate = n > 0;
    this.enabled = n > 0;
  }

  render(renderer, writeBuffer, readBuffer) {
    const old = renderer.getClearColor(new THREE.Color());
    const oldAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
    renderer.setClearColor(old, oldAlpha);
    this.quad.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material.uniforms.tHeat.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

// ------------------------------------------------------------- the module ----

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/**
 * @param deps scene, camera, renderer, composer, game, actors (figures,
 *   motion.perform), audio (its context and the combat helpers), player (for
 *   shake), quality (for the preset).
 */
export function createSpellFx({ scene, camera, renderer, composer, game, actors, audio, player, quality }) {
  const noise = noiseTexture(128);
  const shared = {
    uGain: { value: 1 },
    uFogDensity: { value: 0 },
  };
  const budgetOf = () => BUDGET[quality ? quality.name : 'high'] || BUDGET.high;
  let budget = budgetOf();
  const anchors = new Anchors(96);
  const light = new Pool(BUDGET.max.light, false, noise, shared);
  const matter = new Pool(BUDGET.max.matter, true, noise, shared);
  light.anchors = anchors; matter.anchors = anchors;
  const glow = new Ribbons(BUDGET.max.ribbon, false, shared);
  const shade = new Ribbons(1600, true, shared);
  const group = new THREE.Group();
  group.name = 'spellfx';
  group.add(matter.points, light.points, glow.mesh, shade.mesh);
  scene.add(group);

  // -- decals -------------------------------------------------------------
  const decalGeometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const decalBase = new THREE.ShaderMaterial({
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    uniforms: {
      uMode: { value: 0 }, uTime: { value: 0 }, uOpen: { value: 0 }, uAlpha: { value: 0 },
      uRadius: { value: 0 }, uColor: { value: new THREE.Color() },
      uGain: shared.uGain, uFogDensity: shared.uFogDensity,
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const decals = [];
  for (let i = 0; i < 10; i++) {
    const m = decalBase.clone();
    m.uniforms.uGain = shared.uGain;
    m.uniforms.uFogDensity = shared.uFogDensity;
    const mesh = new THREE.Mesh(decalGeometry, m);
    mesh.visible = false;
    mesh.renderOrder = 4;
    mesh.layers.set(OVERLAY_LAYER);
    group.add(mesh);
    decals.push({ mesh, busy: false, t: 0, life: 0, update: null });
  }

  /** A decal on the ground at `p`, radius `r`, driven by `drive(u, uniforms, t)`. */
  function decal(p, r, mode, color, life, drive) {
    const d = decals.find((x) => !x.busy);
    if (!d) return null;
    d.busy = true; d.t = 0; d.life = life; d.drive = drive; d.anchorFn = null;
    d.mesh.position.set(p.x, p.y + 0.04, p.z);
    d.mesh.scale.setScalar(r);
    d.mesh.rotation.y = rand(0, TAU);
    const u = d.mesh.material.uniforms;
    u.uMode.value = mode; u.uColor.value.copy(color); u.uOpen.value = 0; u.uAlpha.value = 0; u.uRadius.value = 0;
    d.mesh.visible = true;
    return d;
  }

  // -- fire spheres ---------------------------------------------------------
  const sphereGeometry = new THREE.IcosahedronGeometry(1, 3);
  const fireBase = new THREE.ShaderMaterial({
    vertexShader: FIRE_VERT,
    fragmentShader: FIRE_FRAG,
    uniforms: {
      uTime: { value: 0 }, uHeat: { value: 1 }, uAlpha: { value: 1 }, uSeed: { value: 0 },
      uGain: shared.uGain, uFogDensity: shared.uFogDensity,
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const spheres = [];
  for (let i = 0; i < 5; i++) {
    const m = fireBase.clone();
    m.uniforms.uGain = shared.uGain;
    m.uniforms.uFogDensity = shared.uFogDensity;
    const mesh = new THREE.Mesh(sphereGeometry, m);
    mesh.visible = false;
    mesh.renderOrder = 6;
    mesh.layers.set(OVERLAY_LAYER);
    group.add(mesh);
    spheres.push({ mesh, busy: false });
  }
  function sphere() {
    const s = spheres.find((x) => !x.busy);
    if (!s) return null;
    s.busy = true;
    s.mesh.visible = true;
    s.mesh.material.uniforms.uSeed.value = rand(0, 50);
    return s;
  }
  function freeSphere(s) { if (!s) return; s.busy = false; s.mesh.visible = false; }

  // -- lights -----------------------------------------------------------------
  // Always in the scene, always visible, dark when idle: the number of lights
  // is part of every lit material's shader, and changing it recompiles them.
  const lights = [];
  for (let i = 0; i < LIGHTS; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 14, 2);
    l.position.set(0, -500, 0);
    l.castShadow = false;
    scene.add(l);
    lights.push({ light: l, busy: false, owner: null });
  }
  /** A light for `fn(t)` -> {x,y,z,intensity,color?,distance?} until it returns null. */
  function takeLight(color, fn) {
    const usable = lights.slice(0, budget.lights);
    let slot = usable.find((l) => !l.busy);
    if (!slot) {
      // Everything is lit already: take the one closest to finishing.
      slot = usable.reduce((a, b) => ((a.remaining ?? 0) < (b.remaining ?? 0) ? a : b), usable[0]);
      if (!slot) return;
    }
    slot.busy = true; slot.t = 0; slot.fn = fn; slot.light.color.setHex(color); slot.remaining = 1;
  }

  // -- heat -----------------------------------------------------------------
  const heat = new HeatPass(camera, noise);
  {
    const bloomIndex = composer.passes.findIndex((p) => p.constructor.name === 'UnrealBloomPass');
    composer.insertPass(heat, bloomIndex >= 0 ? bloomIndex : composer.passes.length - 2);
  }

  // -- the player's own view ----------------------------------------------------
  // What a spell on you looks like from inside it: a tint at the edge of the
  // frame for as long as an affect lasts, and a wash for a moment on a hit.
  const overlay = document.createElement('div');
  overlay.id = 'spell-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:11;opacity:1;';
  const edge = document.createElement('div');
  edge.style.cssText = 'position:absolute;inset:0;transition:opacity 600ms ease, background 600ms ease;opacity:0;';
  const wash = document.createElement('div');
  wash.style.cssText = 'position:absolute;inset:0;opacity:0;mix-blend-mode:screen;';
  overlay.append(edge, wash);
  document.body.appendChild(overlay);
  /** A wash over the frame. Held well short of opaque: a spell on you is felt, not a white-out. */
  function flashScreen(css, strength = 0.5, ms = 420) {
    wash.style.background = css;
    wash.animate([{ opacity: 0 }, { opacity: Math.min(0.55, strength * 0.65), offset: 0.12 }, { opacity: 0 }], { duration: ms, easing: 'ease-out' });
  }

  // -- places ---------------------------------------------------------------------

  const figureOf = (slot) => (slot && slot.figure && slot.figure.m ? slot.figure : null);
  const handCache = new WeakMap();

  /** The bone (or socket) a figure casts from, found once. */
  function handOf(fig) {
    if (handCache.has(fig)) return handCache.get(fig);
    let found = fig.castPoint || null;
    if (!found) {
      fig.object.traverse((o) => {
        if (!found && o.isBone && /^(hand\.?R|handR|hand_R|RightHand)$/i.test(o.name)) found = o;
      });
    }
    handCache.set(fig, found);
    return found;
  }
  const headCache = new WeakMap();
  function headOf(fig) {
    if (headCache.has(fig)) return headCache.get(fig);
    let found = null;
    fig.object.traverse((o) => { if (!found && o.isBone && /^head$/i.test(o.name)) found = o; });
    headCache.set(fig, found);
    return found;
  }

  const forwardOf = (fig, out) => out.set(Math.sin(fig.object.rotation.y), 0, Math.cos(fig.object.rotation.y));

  /** Where a caster's spell leaves from: its hand, or just in front of your chest. */
  function handPoint(who, out) {
    if (who.player) {
      camera.getWorldDirection(_v);
      _w.set(1, 0, 0).applyQuaternion(camera.quaternion);
      out.copy(camera.position).addScaledVector(_v, 0.62).addScaledVector(_w, 0.2);
      out.y -= 0.24;
      return out;
    }
    const fig = figureOf(who.slot);
    if (!fig) return who.slot ? out.set(who.slot.pos.x, who.slot.pos.y + 1.3, who.slot.pos.z) : out.copy(camera.position);
    const hand = handOf(fig);
    if (hand) {
      hand.updateWorldMatrix(true, false);
      hand.getWorldPosition(out);
      if (hand === fig.castPoint) return out;
      // A bare hand bone: a little out past the fingers, where a spell would sit.
      forwardOf(fig, _w);
      return out.addScaledVector(_w, 0.12);
    }
    forwardOf(fig, _w);
    return out.set(fig.at.x, fig.at.y + fig.height * 0.62, fig.at.z).addScaledVector(_w, 0.38);
  }

  /** A dragon's mouth, or a head. */
  function mouthPoint(who, out) {
    if (who.player) return handPoint(who, out);
    const fig = figureOf(who.slot);
    if (!fig) return handPoint(who, out);
    forwardOf(fig, _w);
    const head = headOf(fig);
    if (head) { head.updateWorldMatrix(true, false); head.getWorldPosition(out); return out.addScaledVector(_w, 0.2); }
    return out.set(fig.at.x, fig.at.y + fig.height * 0.88, fig.at.z).addScaledVector(_w, fig.legs ? 0.6 : 0.25);
  }

  /**
   * Where a spell strikes: the chest, or in front of your eye -- `near` for
   * what flies at you (a stream or a bolt has to arrive in your face), far
   * enough for a burst to go off without filling the frame otherwise.
   */
  function chestPoint(who, out, near = false) {
    if (who.player) {
      camera.getWorldDirection(_v);
      return out.copy(camera.position).addScaledVector(_v, near ? 0.8 : 1.7).add({ x: 0, y: near ? -0.22 : -0.3, z: 0 });
    }
    const fig = figureOf(who.slot);
    if (!fig) return who.slot ? out.set(who.slot.pos.x, who.slot.pos.y + 1.1, who.slot.pos.z) : out.copy(camera.position);
    return out.set(fig.at.x, fig.at.y + fig.height * 0.6, fig.at.z);
  }

  function feetPoint(who, out) {
    if (who.player) return out.set(camera.position.x, camera.position.y - 1.72, camera.position.z);
    const fig = figureOf(who.slot);
    if (!fig) return who.slot ? out.set(who.slot.pos.x, who.slot.pos.y, who.slot.pos.z) : out.set(camera.position.x, camera.position.y - 1.72, camera.position.z);
    return out.set(fig.at.x, fig.at.y, fig.at.z);
  }

  const heightOf = (who) => (who.player ? 1.8 : (figureOf(who.slot) ? figureOf(who.slot).height : 1.7));

  /** Stereo place and distance fall-off for a sound at `p`. */
  function where(p) {
    const dx = p.x - camera.position.x; const dz = p.z - camera.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.8) return { pan: 0, gain: 1 };
    _w.set(1, 0, 0).applyQuaternion(camera.quaternion);
    return { pan: clamp((dx * _w.x + dz * _w.z) / d, -1, 1) * 0.7, gain: clamp(1 / (1 + (d - 1) / 6), 0.06, 1) };
  }
  const distToCamera = (p) => Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);

  // -- spawners ------------------------------------------------------------------

  const n = (count) => Math.max(1, Math.round(count * budget.density));

  function burst(pool, p, count, o) {
    for (let i = 0; i < n(count); i++) {
      const dir = _v.set(rand(-1, 1), rand(-1, 1) * (o.flat ? 0.3 : 1), rand(-1, 1));
      if (o.up) dir.y = Math.abs(dir.y) + o.up;
      dir.normalize();
      const s = rand(o.speed[0], o.speed[1]);
      pool.spawn({
        x: p.x + dir.x * (o.offset || 0), y: p.y + dir.y * (o.offset || 0), z: p.z + dir.z * (o.offset || 0),
        vx: dir.x * s + (o.vx || 0), vy: dir.y * s + (o.vy || 0), vz: dir.z * s + (o.vz || 0),
        life: rand(o.life[0], o.life[1]), size: rand(o.size[0], o.size[1]), grow: o.grow,
        color: o.color, color2: o.color2, alpha: o.alpha, drag: o.drag, gravity: o.gravity,
        shape: o.shape, fadeIn: o.fadeIn, floor: o.floor, occ: o.occ,
      });
    }
  }

  function glowAt(pool, p, color, size, life, alpha = 1, shape = 0, occ = undefined) {
    pool.spawn({ x: p.x, y: p.y, z: p.z, life, size, color, alpha, shape, drag: 0, fadeIn: 0.05, occ });
  }

  // -- sound -----------------------------------------------------------------------

  const S = {
    ok() { return audio && audio.ctx && !audio.muted && audio.out; },
    osc(dest, { type = 'sine', from, to = null, gain, attack = 0.01, decay, delay = 0, q = null }) {
      const ctx = audio.ctx;
      const now = ctx.currentTime + delay;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(from, now);
      if (to) o.frequency.exponentialRampToValueAtTime(to, now + attack + decay);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, now);
      env.gain.linearRampToValueAtTime(gain, now + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
      let node = o;
      if (q) {
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = q.f; f.Q.value = q.q;
        o.connect(f); node = f;
      }
      node.connect(env).connect(dest);
      o.start(now);
      o.stop(now + attack + decay + 0.05);
    },
    /** The words: a breath of air and a rising shimmer, pitched by family. */
    gather(p, family, windup) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      const base = ({ fire: 180, lightning: 320, frost: 520, acid: 240, heal: 392, bless: 440, sanctuary: 523, dark: 110, harm: 98, poison: 150, faerie: 660, holy: 330, dispel: 470, missile: 280, ward: 349, refresh: 415, gas: 120 })[FAMILY[family]] || 300;
      audio.noiseHit(dest, { frequency: 900, to: 2600, q: 1.4, gain: 0.18, attack: windup * 0.7, decay: windup * 0.5, rate: 0.8 });
      for (const [r, g] of [[1, 0.05], [1.5, 0.03], [2.01, 0.02]]) {
        S.osc(dest, { from: base * r, to: base * r * 2, gain: g, attack: windup * 0.85, decay: 0.3 });
      }
    },
    missile(p) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      S.osc(dest, { type: 'triangle', from: 1900, to: 520, gain: 0.07, attack: 0.005, decay: 0.28 });
      audio.noiseHit(dest, { frequency: 3000, to: 1200, q: 2, gain: 0.12, decay: 0.2, rate: 1.6 });
    },
    pop(p, pitch = 1) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      audio.thump(dest, { from: 420 * pitch, to: 120 * pitch, gain: 0.12, decay: 0.12 });
      audio.noiseHit(dest, { frequency: 2400 * pitch, q: 1.2, gain: 0.22, decay: 0.08 });
    },
    roar(p, duration) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      audio.noiseHit(dest, { frequency: 260, to: 900, q: 0.8, type: 'lowpass', gain: 0.6, attack: duration * 0.6, decay: duration * 0.6, rate: 0.7 });
      audio.noiseHit(dest, { frequency: 1400, q: 1.1, gain: 0.08, attack: duration * 0.5, decay: duration * 0.5, rate: 1.1 });
    },
    boom(p, size = 1) {
      if (!S.ok()) return;
      const place = where(p);
      const dest = audio.out({ pan: place.pan, gain: Math.min(1, place.gain * 1.6) });
      audio.thump(dest, { from: 95, to: 28, gain: 0.34 * size, decay: 0.9 });
      audio.noiseHit(dest, { frequency: 700, to: 120, q: 0.7, type: 'lowpass', gain: 1.0 * size, attack: 0.004, decay: 1.2, rate: 0.6 });
      audio.noiseHit(dest, { frequency: 3200, q: 0.9, gain: 0.35 * size, decay: 0.12 });
      for (let i = 0; i < 7; i++) audio.noiseHit(dest, { frequency: rand(2000, 5000), q: 3, gain: rand(0.04, 0.1), decay: 0.05, delay: 0.15 + rand(0, 0.9) });
    },
    crack(p, big = 1) {
      if (!S.ok()) return;
      const place = where(p);
      const dest = audio.out({ pan: place.pan, gain: Math.min(1, place.gain * 1.4) });
      audio.noiseHit(dest, { frequency: 4200, q: 0.6, type: 'highpass', gain: 0.9 * big, attack: 0.002, decay: 0.09 });
      audio.thump(dest, { from: 160, to: 40, gain: 0.2 * big, decay: 0.35 });
      S.osc(dest, { type: 'sawtooth', from: 118, to: 96, gain: 0.05 * big, attack: 0.005, decay: 0.3, q: { f: 900, q: 4 } });
      audio.noiseHit(dest, { frequency: 140, to: 60, q: 0.7, type: 'lowpass', gain: 0.55 * big, attack: 0.08, decay: 1.9, delay: 0.12, rate: 0.5 });
    },
    frost(p) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      audio.ring(dest, { base: 1680 + rand(0, 200), ratios: [1, 1.34, 2.11, 2.93, 3.87], gain: 0.05, decay: 1.1 });
      audio.noiseHit(dest, { frequency: 6000, q: 0.8, type: 'highpass', gain: 0.25, attack: 0.03, decay: 0.7 });
    },
    hiss(p, long = 1) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      audio.noiseHit(dest, { frequency: 5200, q: 0.7, type: 'highpass', gain: 0.4, attack: 0.02, decay: 0.9 * long });
      for (let i = 0; i < 9; i++) audio.noiseHit(dest, { frequency: rand(3000, 7000), q: 4, gain: rand(0.03, 0.08), decay: 0.04, delay: rand(0, 0.9 * long) });
    },
    chord(p, root = 392, bright = 1) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      [[1, 0.05], [1.26, 0.04], [1.5, 0.035], [2, 0.025 * bright], [3, 0.012 * bright]].forEach(([r, g], i) => {
        S.osc(dest, { from: root * r, gain: g, attack: 0.08 + i * 0.03, decay: 1.6 });
      });
      audio.ring(dest, { base: root * 4, ratios: [1, 2.76, 5.4], gain: 0.02 * bright, decay: 1.4 });
    },
    prism(p) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      [1, 1.25, 1.5, 1.875, 2.25].forEach((r, i) => S.osc(dest, { from: 520 * r, to: 780 * r, gain: 0.035, attack: 0.02, decay: 0.45, delay: i * 0.025 }));
      audio.noiseHit(dest, { frequency: 3000, to: 6000, q: 1, gain: 0.2, attack: 0.03, decay: 0.3 });
    },
    dark(p) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      S.osc(dest, { type: 'sawtooth', from: 92, to: 46, gain: 0.07, attack: 0.15, decay: 1.1, q: { f: 380, q: 3 } });
      audio.noiseHit(dest, { frequency: 700, to: 300, q: 5, gain: 0.25, attack: 0.2, decay: 0.8 });
    },
    rumble(p) {
      if (!S.ok()) return;
      const dest = audio.out({ pan: 0, gain: 1 });
      audio.noiseHit(dest, { frequency: 90, to: 45, q: 0.8, type: 'lowpass', gain: 1.4, attack: 0.25, decay: 2.2, rate: 0.35 });
      audio.thump(dest, { from: 60, to: 30, gain: 0.3, decay: 1.4 });
      for (let i = 0; i < 6; i++) audio.noiseHit(dest, { frequency: rand(300, 900), q: 1, type: 'lowpass', gain: rand(0.2, 0.4), decay: 0.12, delay: rand(0.1, 1.4) });
    },
    fizzle(p) {
      if (!S.ok()) return;
      const dest = audio.out(where(p));
      audio.noiseHit(dest, { frequency: 1800, to: 500, q: 1.5, gain: 0.15, decay: 0.3 });
    },
  };

  // -- effects --------------------------------------------------------------------

  let clock = 0;
  const effects = [];
  const byId = new Map();

  /** A participant: the player, or a mobile's slot. */
  const who = (slot, isPlayer) => ({ slot: isPlayer ? null : slot, player: !!isPlayer });

  /** A figure plays its casting clip, timed so the release lands on `contactIn`. */
  function performCast(w, contactIn, clip = 'cast') {
    const fig = figureOf(w.slot);
    if (!fig || !actors.perform) return;
    const name = fig.actions && fig.actions[clip] ? clip : 'attack';
    actors.perform(w.slot, name, { contactIn });
  }

  function onEvent(e) {
    switch (e.kind) {
      case 'cast': return onCast(e);
      case 'spell': return onSpell(e);
      case 'spell-fizzle': {
        const fx = byId.get(e.id);
        if (fx) { fx.fizzled = true; byId.delete(e.id); }
        const p = handPoint(who(e.from, e.fromPlayer), new THREE.Vector3());
        burst(light, p, 10, { speed: [0.3, 1.2], life: [0.2, 0.5], size: [0.03, 0.07], color: C(0.8, 0.8, 1.2), drag: 3, shape: 1 });
        S.fizzle(p);
        return;
      }
      case 'suffer': {
        const w = who(e.from, e.fromPlayer);
        if (w.player) { flashScreen('radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 40%, rgba(70,140,30,0.55) 100%)', 0.6, 700); return; }
        const p = chestPoint(w, new THREE.Vector3());
        burst(matter, p, 8, { speed: [0.1, 0.4], up: 0.6, life: [0.9, 1.4], size: [0.14, 0.26], grow: 1.8, color: PAL.poison.smoke, alpha: 0.5, drag: 1.5, gravity: -0.4, shape: 3 });
        burst(light, p, 8, { speed: [0.1, 0.35], up: 0.8, life: [0.8, 1.3], size: [0.04, 0.08], color: PAL.poison.glow, drag: 1.2, gravity: -0.5, shape: 5 });
        return;
      }
      case 'teleport':
        flashScreen('radial-gradient(ellipse at 50% 50%, rgba(235,245,255,0.95) 0%, rgba(160,200,255,0.6) 100%)', 0.9, 900);
        return;
      default:
    }
  }
  const unlisten = game.listen(onEvent);

  function onCast(e) {
    const from = who(e.from, e.fromPlayer);
    const to = e.area ? null : (e.self ? from : (e.to !== undefined || e.toPlayer ? who(e.to, e.toPlayer) : null));
    const fx = {
      id: e.id, family: e.family, spell: e.spell, source: e.source, level: e.level || 10,
      from, to, t: 0, windup: e.windup, flight: e.flight, released: false, landed: false, done: false,
      lost: !!e.lost, hand: new THREE.Vector3(), aim: new THREE.Vector3(), anchor: -1, data: {},
    };
    handPoint(from, fx.hand);
    fx.anchor = anchors.take(fx.hand);
    effects.push(fx);
    byId.set(e.id, fx);
    const palette = pal(fx.family);

    // The body: hands up for the words; the teeth for a bite; the head for breath.
    if (!from.player && !fx.lost) {
      if (e.source === 'bite') performCast(from, e.windup, 'attack');
      else if (e.source === 'breath') performCast(from, e.windup, 'attack');
      else if (!['quaff', 'eat'].includes(e.source)) performCast(from, e.windup);
    }

    // The circle, for anything spoken; not for a potion, a bite or a breath.
    if (['cast', 'spec', 'recite', 'brandish'].includes(e.source)) {
      const feet = feetPoint(from, new THREE.Vector3());
      const radius = from.player ? 1.25 : 1.05;
      const color = palette.glow.clone().multiplyScalar(0.9);
      const life = e.windup + 0.9;
      decal(feet, radius, 0, color, life, (d, u, t) => {
        feetPoint(from, _v);
        d.mesh.position.set(_v.x, _v.y + 0.04, _v.z);
        u.uOpen.value = smooth(t / (e.windup * 0.8));
        u.uAlpha.value = (fx.lost ? 0.6 : 1) * Math.min(1, t / 0.12) * (t > e.windup ? Math.max(0, 1 - (t - e.windup) / 0.9) : 1);
        u.uTime.value = clock;
      });
    }
    S.gather(fx.hand, fx.family, e.windup);
  }

  function onSpell(e) {
    let fx = byId.get(e.id);
    if (!fx) {
      // Nobody saw it cast (the event was missed); show the landing anyway.
      const from = who(e.from, e.fromPlayer);
      fx = { id: e.id, family: e.family, spell: e.spell, from, to: e.self ? from : (e.to !== undefined || e.toPlayer ? who(e.to, e.toPlayer) : null), t: 0, windup: 0, flight: 0, released: true, hand: handPoint(from, new THREE.Vector3()), aim: new THREE.Vector3(), anchor: -1, data: {} };
      effects.push(fx);
    }
    byId.delete(e.id);
    fx.landed = true;
    fx.hits = e.hits || [];
    fx.saved = e.saved;
    fx.failed = e.failed;
    fx.landT = fx.t;
    impact(fx);
  }

  // -- flight and impact, by family ---------------------------------------------------

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  /** The gathering at the hand before release: light drawn in and turning. */
  function gather(fx, dt) {
    const palette = pal(fx.family);
    const u = clamp(fx.t / Math.max(0.05, fx.windup), 0, 1);
    const rate = (fx.from.player ? 28 : 40) * budget.density;
    fx.data.acc = (fx.data.acc || 0) + dt * rate * (0.4 + u);
    while (fx.data.acc >= 1) {
      fx.data.acc -= 1;
      const r = rand(0.28, 0.55) * (1 - u * 0.4);
      const th = rand(0, TAU); const ph = rand(-0.9, 0.9);
      light.spawn({
        x: Math.cos(th) * r, y: ph * r * 0.7, z: Math.sin(th) * r, anchor: fx.anchor,
        vx: 0, vy: 0, vz: 0, drag: 0, swirl: rand(3, 6) * (Math.random() < 0.5 ? -1 : 1), pull: rand(3.5, 5.5),
        life: rand(0.35, 0.55), size: rand(0.025, 0.05), color: palette.glow.clone().multiplyScalar(1.6), color2: palette.core || palette.mote || palette.glow,
        shape: 1, fadeIn: 0.3,
      });
    }
    // The growing heart of it: one sprite a frame, short-lived, so it follows the hand.
    const coreSize = (fx.from.player ? 0.06 : 0.09) + u * (fx.from.player ? 0.1 : 0.16);
    light.spawn({ x: 0, y: 0, z: 0, anchor: fx.anchor, life: 0.05, size: coreSize * 2.6, color: palette.glow, alpha: 0.5 + u * 0.5, shape: 0, drag: 0, fadeIn: 0 });
    light.spawn({ x: 0, y: 0, z: 0, anchor: fx.anchor, life: 0.05, size: coreSize * 0.8, color: (palette.core || palette.mote || palette.glow), alpha: 0.35 + u * 0.4, shape: 1, drag: 0, fadeIn: 0 });
  }

  function release(fx) {
    fx.released = true;
    fx.releaseT = fx.t;
    const f = fx.family;
    const from = fx.from;
    const src = fx.hand.clone();
    fx.data.src = src;
    if (fx.to) chestPoint(fx.to, fx.aim, true);
    const palette = pal(f);
    // A flash as it leaves the hand.
    glowAt(light, src, palette.glow, fx.from.player ? 0.5 : 0.8, 0.18, 0.9);

    if (f === 'missile' && fx.to) {
      const count = clamp(1 + Math.floor(fx.level / 6), 1, 5);
      fx.data.bolts = [];
      for (let i = 0; i < count; i++) {
        // Each bows out to its own side -- fanned evenly, so a volley spreads
        // like a hand of cards rather than bunching -- and dips in at the end.
        const toward = _w.subVectors(fx.aim, src).setY(0).normalize();
        const across = new THREE.Vector3(-toward.z, 0, toward.x);
        const fan = count > 1 ? (i / (count - 1)) * 2 - 1 : (Math.random() < 0.5 ? -0.6 : 0.6);
        const side = across.clone().multiplyScalar(fan * 0.9 + rand(-0.15, 0.15)).add(new THREE.Vector3(0, rand(0.15, 0.55), 0));
        const bend2 = across.clone().multiplyScalar(-fan * 0.4 + rand(-0.2, 0.2)).add(new THREE.Vector3(0, rand(-0.1, 0.3), 0));
        fx.data.bolts.push({ delay: i * 0.055, bend: side, bend2, trail: [], hit: false });
      }
      S.missile(src);
      takeLight(PAL.missile.light, (t) => (t < fx.flight + 0.15 && !fx.done ? { p: fx.data.head || src, intensity: 7, distance: 9 } : null));
    } else if ((f === 'fireball') && fx.to) {
      fx.data.ball = sphere();
      S.roar(src, fx.flight + 0.2);
      takeLight(PAL.fire.light, (t) => (fx.data.ballPos && !fx.landed ? { p: fx.data.ballPos, intensity: 24, distance: 13 } : null));
    } else if (f === 'lightning' || f === 'breath-lightning') {
      S.crack(src, 1);
      takeLight(PAL.lightning.light, (t) => (t < 0.32 ? { p: fx.data.mid || src, intensity: 90 * (0.55 + 0.45 * Math.random()) * (1 - t / 0.32), distance: 22 } : null));
    } else if (f === 'shock') {
      S.crack(src, 0.5);
    } else if (f === 'frost' || f === 'breath-frost') {
      S.frost(src);
    } else if (f === 'acid' || f === 'breath-acid') {
      S.hiss(src, 0.6);
    } else if (f === 'prism') {
      S.prism(src);
      takeLight(0xffffff, (t) => (t < 0.35 ? { p: src, intensity: 14 * (1 - t / 0.35), distance: 10 } : null));
    } else if (f === 'flame' || f === 'breath-fire') {
      S.roar(src, 0.6);
      takeLight(PAL.fire.light, (t) => (t < 0.7 ? { p: src, intensity: 16 * Math.sin(Math.PI * t / 0.7), distance: 10 } : null));
    } else if (f === 'breath-gas') {
      S.roar(src, 1.0);
    } else if (f === 'drain' || f === 'curse' || f === 'harm' || f === 'weaken' || f === 'blind' || f === 'hex') {
      S.dark(fx.to ? fx.aim : src);
    } else if (f === 'flamestrike') {
      S.roar(fx.aim, 0.6);
    }
  }

  /** What is in the air between release and landing, once a frame. */
  function fly(fx, dt) {
    const f = fx.family;
    const tf = fx.t - fx.releaseT;
    const u = clamp(tf / Math.max(0.05, fx.flight), 0, 1);
    const src = fx.data.src;
    if (fx.to) chestPoint(fx.to, fx.aim, true);
    const aim = fx.aim;
    const dist = src.distanceTo(aim);

    switch (f) {
      case 'missile': {
        if (!fx.to) break;
        const bolts = fx.data.bolts || [];
        bolts.forEach((b, i) => {
          const span = Math.max(0.08, fx.flight - (bolts.length - 1) * 0.045);
          const bu = clamp((tf - b.delay) / span, 0, 1);
          if (tf < b.delay || b.hit) return;
          // A cubic from the hand, bowing out to one side, into the chest.
          const p1 = tmpA.copy(src).addScaledVector(b.bend, Math.min(3, dist * 0.35));
          const p2 = tmpB.copy(aim).addScaledVector(b.bend2, Math.min(2, dist * 0.25));
          const s = 1 - bu;
          const head = new THREE.Vector3(
            s * s * s * src.x + 3 * s * s * bu * p1.x + 3 * s * bu * bu * p2.x + bu * bu * bu * aim.x,
            s * s * s * src.y + 3 * s * s * bu * p1.y + 3 * s * bu * bu * p2.y + bu * bu * bu * aim.y,
            s * s * s * src.z + 3 * s * s * bu * p1.z + 3 * s * bu * bu * p2.z + bu * bu * bu * aim.z,
          );
          b.trail.unshift(head);
          if (b.trail.length > 14) b.trail.pop();
          if (i === 0) fx.data.head = head;
          glowAt(light, head, PAL.missile.glow, 0.42, 0.04, 1, 0, 0.35);
          glowAt(light, head, PAL.missile.core, 0.1, 0.04, 1, 1);
          if (Math.random() < 0.7 * budget.density) {
            light.spawn({ x: head.x, y: head.y, z: head.z, vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), vz: rand(-0.4, 0.4), life: rand(0.2, 0.4), size: rand(0.02, 0.04), color: PAL.missile.trail, shape: 1, drag: 2 });
          }
          if (bu >= 1) {
            b.hit = true;
            burst(light, head, 14, { speed: [1, 3.5], life: [0.15, 0.35], size: [0.02, 0.05], color: PAL.missile.core, color2: PAL.missile.trail, drag: 4, shape: 1 });
            glowAt(light, head, PAL.missile.glow, 0.9, 0.2, 1);
            S.pop(head, 1.4);
          }
        });
        break;
      }
      case 'fireball': {
        if (!fx.to) break;
        const pos = fx.data.ballPos || (fx.data.ballPos = new THREE.Vector3());
        // At you, it bursts at arm's length (see impact), so it flies there.
        const end = fx.to.player ? camera.getWorldDirection(_w).multiplyScalar(2.6).add(camera.position).add({ x: 0, y: -0.35, z: 0 }) : aim;
        pos.lerpVectors(src, end, u);
        pos.y += Math.sin(Math.PI * u) * Math.min(1.2, dist * 0.08);
        const ball = fx.data.ball;
        const r = (fx.from.player ? 0.2 : 0.26) * (0.6 + 0.4 * Math.min(1, tf / 0.12));
        if (ball) {
          ball.mesh.position.copy(pos);
          ball.mesh.scale.setScalar(r);
          ball.mesh.material.uniforms.uTime.value = clock;
          ball.mesh.material.uniforms.uHeat.value = 1;
          ball.mesh.material.uniforms.uAlpha.value = 1;
        }
        glowAt(light, pos, PAL.fire.glow, r * 5.5, 0.04, 0.9);
        glowAt(light, pos, PAL.fire.core, r * 1.6, 0.04, 0.9, 1);
        // Flame shed behind it, embers, and smoke that lingers where it passed.
        const dir = _v.subVectors(aim, src).normalize();
        for (let k = 0; k < n(5); k++) {
          light.spawn({
            x: pos.x + rand(-0.08, 0.08), y: pos.y + rand(-0.08, 0.08), z: pos.z + rand(-0.08, 0.08),
            vx: -dir.x * rand(0.5, 2) + rand(-0.4, 0.4), vy: rand(0.2, 0.9), vz: -dir.z * rand(0.5, 2) + rand(-0.4, 0.4),
            life: rand(0.22, 0.42), size: rand(0.16, 0.3), grow: 1.8, color: PAL.fire.glow.clone().multiplyScalar(1.4), color2: PAL.fire.dark,
            shape: 4, drag: 2.5, gravity: -1.5, fadeIn: 0.05,
          });
        }
        if (Math.random() < 0.8) {
          light.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: rand(-1.5, 1.5), vy: rand(-0.5, 1.8), vz: rand(-1.5, 1.5), life: rand(0.4, 0.9), size: rand(0.02, 0.035), color: PAL.fire.ember, color2: PAL.fire.dark, shape: 1, drag: 1.2, gravity: 2 });
        }
        if (Math.random() < 0.6 * budget.density) {
          matter.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: rand(-0.2, 0.2), vy: rand(0.2, 0.5), vz: rand(-0.2, 0.2), life: rand(0.9, 1.5), size: rand(0.22, 0.34), grow: 2.4, color: C(0.2, 0.18, 0.16), alpha: 0.4, shape: 3, drag: 1, gravity: -0.3, fadeIn: 0.2 });
        }
        if (budget.heat) heat.add(pos.x, pos.y, pos.z, 0.9, 0.55, 1);
        break;
      }
      case 'lightning': case 'breath-lightning': {
        if (!fx.to) break;
        fx.data.mid = fx.data.mid || new THREE.Vector3();
        fx.data.mid.lerpVectors(src, aim, 0.5);
        break;
      }
      case 'acid': case 'breath-acid': {
        if (!fx.to) break;
        // Droplets thrown so each arrives on the chest as the flight ends.
        const rate = (f === 'acid' ? 130 : 160) * budget.density;
        fx.data.acc = (fx.data.acc || 0) + dt * rate;
        const left = Math.max(0.12, fx.flight - tf);
        const g = 7;
        while (fx.data.acc >= 1 && tf < fx.flight * 0.9) {
          fx.data.acc -= 1;
          const tt = left * rand(0.85, 1.15);
          const jitter = f === 'acid' ? 0.15 : 0.45;
          const tx = aim.x + rand(-jitter, jitter); const ty = aim.y + rand(-jitter, jitter); const tz = aim.z + rand(-jitter, jitter);
          light.spawn({
            x: src.x, y: src.y, z: src.z, vx: (tx - src.x) / tt, vy: (ty - src.y) / tt + 0.5 * g * tt, vz: (tz - src.z) / tt,
            life: tt, size: rand(0.045, 0.09), color: PAL.acid.drop, color2: PAL.acid.glow, shape: 6, drag: 0, gravity: g, fadeIn: 0.02, occ: 0.6,
          });
        }
        break;
      }
      case 'frost': case 'breath-frost': {
        if (!fx.to) break;
        const rate = (f === 'frost' ? 50 : 90) * budget.density;
        fx.data.acc = (fx.data.acc || 0) + dt * rate;
        const dir = _v.subVectors(aim, src);
        const len = dir.length(); dir.normalize();
        const speed = len / Math.max(0.12, fx.flight) * 1.05;
        while (fx.data.acc >= 1 && tf < fx.flight) {
          fx.data.acc -= 1;
          const spread = f === 'frost' ? 0.12 : 0.35;
          const vx = dir.x + rand(-spread, spread); const vy = dir.y + rand(-spread, spread); const vz = dir.z + rand(-spread, spread);
          if (Math.random() < 0.55) {
            light.spawn({ x: src.x, y: src.y, z: src.z, vx: vx * speed, vy: vy * speed, vz: vz * speed, life: len / speed * rand(0.9, 1.1), size: rand(0.06, 0.12), color: PAL.frost.crystal, color2: PAL.frost.glow, shape: 2, drag: 0.1, fadeIn: 0.05, occ: 0.35 });
          } else {
            // Cold air is seen, not lit: a faint blue haze, a little over what is behind it.
            light.spawn({ x: src.x, y: src.y, z: src.z, vx: vx * speed * 0.8, vy: vy * speed * 0.8, vz: vz * speed * 0.8, life: rand(0.5, 0.9), size: rand(0.22, 0.36), grow: 2.2, color: PAL.frost.mist, alpha: 0.3, shape: 3, drag: 1.4, fadeIn: 0.1, occ: 0.5 });
          }
        }
        break;
      }
      case 'flame': case 'breath-fire': {
        if (!fx.to) break;
        const big = f === 'breath-fire';
        const rate = (big ? 110 : 90) * budget.density;
        fx.data.acc = (fx.data.acc || 0) + dt * rate;
        const dir = _v.subVectors(aim, src);
        const len = dir.length(); dir.normalize();
        const speed = Math.max(4, len / Math.max(0.15, fx.flight));
        while (fx.data.acc >= 1) {
          fx.data.acc -= 1;
          const spread = big ? 0.28 : 0.18;
          light.spawn({
            x: src.x, y: src.y, z: src.z,
            vx: (dir.x + rand(-spread, spread)) * speed, vy: (dir.y + rand(-spread, spread)) * speed, vz: (dir.z + rand(-spread, spread)) * speed,
            life: rand(0.35, 0.55) * (len / speed + 0.35), size: rand(0.16, 0.3) * (big ? 1.5 : 1), grow: 3,
            color: PAL.fire.glow.clone().multiplyScalar(1.5), color2: PAL.fire.dark, shape: 4, drag: 1.6, gravity: -2, fadeIn: 0.04,
          });
        }
        if (budget.heat) heat.add(src.x + dir.x * len * 0.5, src.y, src.z + dir.z * len * 0.5, 1.4, 0.5, 0.8);
        break;
      }
      case 'breath-gas': {
        // A green cloud rolling out of the dragon and across the room.
        const rate = 36 * budget.density;
        fx.data.acc = (fx.data.acc || 0) + dt * rate;
        const fwd = figureOf(fx.from.slot) ? forwardOf(figureOf(fx.from.slot), _v) : _v.set(0, 0, 1);
        while (fx.data.acc >= 1) {
          fx.data.acc -= 1;
          const a = rand(-1.1, 1.1);
          const s = rand(2.5, 6);
          const cx = fwd.x * Math.cos(a) - fwd.z * Math.sin(a); const cz = fwd.x * Math.sin(a) + fwd.z * Math.cos(a);
          matter.spawn({ x: src.x, y: src.y, z: src.z, vx: cx * s, vy: rand(-0.6, 0.2), vz: cz * s, life: rand(1.6, 2.6), size: rand(0.4, 0.7), grow: 3.5, color: PAL.gas.smoke, alpha: 0.42, shape: 3, drag: 0.9, gravity: 0.1, fadeIn: 0.1, floor: feetPoint(fx.from, tmpA).y + 0.3 });
        }
        break;
      }
      case 'prism': {
        if (!fx.to) break;
        const dir = _v.subVectors(aim, src).normalize();
        for (let k = 0; k < n(6); k++) {
          const c = PRISM[Math.floor(rand(0, PRISM.length))];
          const sp = rand(9, 14);
          light.spawn({ x: src.x, y: src.y, z: src.z, vx: (dir.x + rand(-0.3, 0.3)) * sp, vy: (dir.y + rand(-0.2, 0.2)) * sp, vz: (dir.z + rand(-0.3, 0.3)) * sp, life: dist / sp * rand(0.8, 1.2), size: rand(0.03, 0.06), color: c, shape: 1, drag: 0.2 });
        }
        break;
      }
      case 'curse': case 'drain': case 'weaken': case 'hex': case 'blind': case 'poison': case 'faerie': case 'dispel': case 'holy': {
        if (!fx.to || fx.to === fx.from) break;
        // A few motes of the spell's colour carried across to the target.
        const palette = pal(f);
        if (Math.random() < 0.8 * budget.density) {
          const p = _v.lerpVectors(src, aim, u + rand(-0.08, 0.08));
          light.spawn({ x: p.x + rand(-0.1, 0.1), y: p.y + rand(-0.1, 0.1), z: p.z + rand(-0.1, 0.1), vx: 0, vy: 0, vz: 0, life: 0.3, size: rand(0.04, 0.08), color: palette.mote || palette.glow, shape: 1, drag: 0 });
        }
        break;
      }
      case 'harm': {
        if (!fx.to) break;
        // Darkness drawn in on the victim from all round before it breaks.
        const rate = 60 * budget.density;
        fx.data.acc = (fx.data.acc || 0) + dt * rate;
        while (fx.data.acc >= 1) {
          fx.data.acc -= 1;
          const d = _v.set(rand(-1, 1), rand(-0.6, 1), rand(-1, 1)).normalize();
          const r = rand(0.9, 1.4);
          const life = rand(0.25, 0.4);
          light.spawn({ x: aim.x + d.x * r, y: aim.y + d.y * r, z: aim.z + d.z * r, vx: -d.x * r / life, vy: -d.y * r / life, vz: -d.z * r / life, life, size: rand(0.03, 0.06), color: PAL.harm.glow, shape: 1, drag: 0, fadeIn: 0.4 });
          if (Math.random() < 0.3) matter.spawn({ x: aim.x + d.x * r, y: aim.y + d.y * r, z: aim.z + d.z * r, vx: -d.x * r / life, vy: -d.y * r / life, vz: -d.z * r / life, life, size: rand(0.12, 0.2), grow: 0.5, color: PAL.harm.smoke, alpha: 0.55, shape: 3, drag: 0, fadeIn: 0.4 });
        }
        break;
      }
      case 'heal': case 'refresh': case 'ward': case 'bless': case 'sanctuary': case 'sight': {
        if (!fx.to || fx.to === fx.from) break;
        const palette = pal(f);
        const p = _v.lerpVectors(src, aim, u);
        for (let k = 0; k < n(3); k++) light.spawn({ x: p.x + rand(-0.1, 0.1), y: p.y + rand(-0.1, 0.1), z: p.z + rand(-0.1, 0.1), vx: 0, vy: rand(0, 0.3), vz: 0, life: rand(0.3, 0.5), size: rand(0.03, 0.06), color: palette.mote || palette.glow, shape: 1, drag: 1 });
        break;
      }
      case 'flamestrike': {
        if (!fx.to) break;
        // Fire falling out of a clear sky onto the victim.
        feetPoint(fx.to, tmpA);
        const rate = 220 * budget.density;
        fx.data.acc = (fx.data.acc || 0) + dt * rate;
        const top = tmpA.y + 8;
        const front = top - (top - tmpA.y) * smooth(u * 1.2);
        while (fx.data.acc >= 1) {
          fx.data.acc -= 1;
          const x = tmpA.x + rand(-0.35, 0.35); const z = tmpA.z + rand(-0.35, 0.35);
          const y = rand(front, top);
          light.spawn({ x, y, z, vx: rand(-0.3, 0.3), vy: -rand(6, 10), vz: rand(-0.3, 0.3), life: rand(0.18, 0.32), size: rand(0.22, 0.4), grow: 1.6, color: C(2.6, 1.2, 0.3), color2: PAL.fire.glow, shape: 4, drag: 1, fadeIn: 0.05 });
        }
        fx.data.column = { base: tmpA.clone(), front, top };
        break;
      }
      default: break;
    }
  }

  /** The moment it lands: what the rules just decided, drawn. */
  function impact(fx) {
    const f = fx.family;
    const palette = pal(f);
    const target = fx.to;
    const aim = target ? chestPoint(target, new THREE.Vector3()) : handPoint(fx.from, new THREE.Vector3());
    const feet = target ? feetPoint(target, new THREE.Vector3()) : feetPoint(fx.from, new THREE.Vector3());
    const onYou = target && target.player;
    const scale = onYou ? 0.55 : 1;
    const hurtFigure = (w, strength) => {
      const fig = w && figureOf(w.slot);
      if (fig && actors.motion && !w.player) actors.motion.react(fig, 'hit', strength);
    };
    const hitAny = fx.hits && fx.hits.some((h) => h.dam > 0);
    if (fx.failed && !['earthquake'].includes(fx.spell)) {
      // Saved, resisted, or refused ("God protects"): a puff and nothing more.
      glowAt(light, aim, palette.glow, 0.6 * scale, 0.25, 0.6);
      S.fizzle(aim);
      return;
    }

    switch (f) {
      case 'missile': {
        glowAt(light, aim, PAL.missile.glow, 1.1 * scale, 0.25, 1);
        if (hitAny) hurtFigure(target, 0.4);
        if (onYou) flashScreen('radial-gradient(ellipse at 50% 60%, rgba(170,140,255,0.55) 0%, rgba(90,60,200,0) 70%)', 0.7, 360);
        break;
      }
      case 'fireball': {
        freeSphere(fx.data.ball); fx.data.ball = null;
        // On you it goes off at arm's length and a size that leaves the frame
        // readable: the wash at the edges says the rest.
        if (onYou) { camera.getWorldDirection(_v); aim.copy(camera.position).addScaledVector(_v, 2.6); aim.y -= 0.35; }
        explode(aim, feet, onYou ? 0.35 : (fx.saved ? 0.8 : 1));
        if (hitAny) hurtFigure(target, 1);
        if (onYou) flashScreen('radial-gradient(ellipse at 50% 50%, rgba(255,170,80,0) 25%, rgba(255,120,30,0.6) 72%, rgba(140,30,0,0.8) 100%)', 0.85, 700);
        break;
      }
      case 'flame': case 'breath-fire': case 'flamestrike': {
        const big = f !== 'flame';
        burst(light, aim, big ? 40 : 22, { speed: [1, big ? 4 : 2.5], up: 0.3, life: [0.35, 0.7], size: [0.18, 0.34], grow: 2.4, color: PAL.fire.glow.clone().multiplyScalar(1.5), color2: PAL.fire.dark, drag: 2.6, gravity: -2, shape: 4, fadeIn: 0.05 });
        burst(light, aim, big ? 30 : 16, { speed: [2, 6], life: [0.4, 0.9], size: [0.02, 0.035], color: PAL.fire.ember, color2: PAL.fire.dark, drag: 1, gravity: 6, shape: 1, floor: feet.y + 0.02 });
        burst(matter, aim, big ? 14 : 8, { speed: [0.3, 1], up: 0.8, life: [1.2, 2], size: [0.4, 0.7], grow: 2.2, color: C(0.16, 0.14, 0.13), alpha: 0.45, drag: 1.4, gravity: -0.45, shape: 3, fadeIn: 0.2 });
        if (f === 'flamestrike') {
          decal(feet, 1.8, 1, PAL.fire.glow, 0.55, (d, u, t) => { u.uRadius.value = smooth(t / 0.45); u.uAlpha.value = 1 - t / 0.55; });
          takeLight(PAL.fire.light, (t) => (t < 0.8 ? { p: aim, intensity: 70 * Math.pow(1 - t / 0.8, 2), distance: 16 } : null));
          S.boom(aim, 0.6);
        }
        if (hitAny) hurtFigure(target, 0.8);
        if (budget.heat) for (let k = 0; k < 4; k++) heat.add(aim.x + rand(-0.4, 0.4), aim.y + rand(0, 0.6), aim.z + rand(-0.4, 0.4), 1.2, 0.9, 1);
        if (onYou) flashScreen('radial-gradient(ellipse at 50% 50%, rgba(255,170,80,0.8) 0%, rgba(200,60,10,0.45) 100%)', 0.7, 600);
        break;
      }
      case 'lightning': case 'breath-lightning': case 'shock': case 'storm': {
        const strikes = f === 'storm' ? fx.hits.map((h) => who(h.to, h.player)) : [target];
        fx.data.strikes = strikes.filter(Boolean).map((w) => ({ w, until: fx.t + (f === 'shock' ? 0.45 : 0.3), path: null, next: 0 }));
        for (const s of fx.data.strikes) {
          const p = chestPoint(s.w, new THREE.Vector3());
          burst(light, p, 26, { speed: [2, 7], life: [0.1, 0.3], size: [0.015, 0.035], color: PAL.lightning.core, color2: PAL.lightning.glow, drag: 3, shape: 1 });
          glowAt(light, p, PAL.lightning.glow, 1.4 * scale, 0.22, 1);
          hurtFigure(s.w, 0.7);
          if (s.w.player) flashScreen('radial-gradient(ellipse at 50% 50%, rgba(220,235,255,0.95) 0%, rgba(140,170,255,0.5) 100%)', 0.85, 300);
        }
        if (f === 'storm') {
          S.crack(aim, 1.3);
          takeLight(PAL.lightning.light, (t) => (t < 0.4 ? { p: fx.data.strikes[0] ? chestPoint(fx.data.strikes[0].w, tmpA).add({ x: 0, y: 3, z: 0 }) : aim, intensity: 160 * (0.5 + 0.5 * Math.random()) * (1 - t / 0.4), distance: 30 } : null));
        }
        break;
      }
      case 'frost': case 'breath-frost': {
        burst(light, aim, 40, { speed: [0.8, 3.4], life: [0.7, 1.3], size: [0.06, 0.14], color: PAL.frost.crystal, color2: PAL.frost.glow, drag: 2, gravity: 3, shape: 2, floor: feet.y + 0.02, occ: 0.35 });
        burst(light, aim, 18, { speed: [0.2, 0.9], life: [1.4, 2.2], size: [0.35, 0.6], grow: 2, color: PAL.frost.mist, alpha: 0.3, drag: 1.5, gravity: 0.15, shape: 3, fadeIn: 0.15, floor: feet.y + 0.1, occ: 0.5 });
        glowAt(light, aim, PAL.frost.glow, 1.3 * scale, 0.35, 0.8, 0, 0.3);
        decal(feet, 1.1, 2, PAL.frost.glow.clone().multiplyScalar(0.7), 2.2, (d, u, t) => { u.uAlpha.value = Math.min(1, t / 0.1) * (1 - t / 2.2); });
        if (target) auraPulse(target, PAL.frost.crystal.clone().multiplyScalar(0.5), 1.6, 2.2);
        if (hitAny) hurtFigure(target, 0.5);
        S.frost(aim);
        if (onYou) flashScreen('radial-gradient(ellipse at 50% 50%, rgba(200,230,255,0) 30%, rgba(170,210,255,0.8) 100%)', 0.8, 1100);
        break;
      }
      case 'acid': case 'breath-acid': {
        burst(light, aim, onYou ? 16 : 44, { speed: [1.2, 4], life: [0.4, 0.9], size: [0.04 * scale, 0.08 * scale], color: PAL.acid.drop, color2: PAL.acid.glow, drag: 1, gravity: 7, shape: 6, floor: feet.y + 0.02, occ: 0.6 });
        burst(matter, aim, onYou ? 6 : 20, { speed: [0.2, 0.8], up: 0.8, life: [1.6, 2.6], size: [0.3 * scale, 0.55 * scale], grow: 2.4, color: PAL.acid.fume, alpha: 0.55, drag: 1.2, gravity: -0.5, shape: 3, fadeIn: 0.2 });
        auraPulse(target, PAL.acid.glow, 1.4, 1.2);
        decal(feet, 0.9, 2, PAL.acid.glow.clone().multiplyScalar(0.6), 2.4, (d, u, t) => { u.uAlpha.value = (1 - t / 2.4) * Math.min(1, t / 0.1); });
        glowAt(light, aim, PAL.acid.glow, 1.0 * scale, 0.3, 0.8);
        if (hitAny) hurtFigure(target, 0.7);
        S.hiss(aim, 1.4);
        if (onYou) flashScreen('radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 35%, rgba(90,170,20,0.7) 100%)', 0.75, 900);
        break;
      }
      case 'prism': {
        for (let k = 0; k < PRISM.length; k++) {
          burst(light, aim, 6, { speed: [1, 4], life: [0.3, 0.6], size: [0.03, 0.06], color: PRISM[k], drag: 3, shape: 1 });
        }
        glowAt(light, aim, C(2, 2, 2), 1.2 * scale, 0.2, 0.9);
        if (hitAny) hurtFigure(target, 0.8);
        if (onYou) flashScreen('linear-gradient(120deg, rgba(255,90,90,0.7), rgba(255,230,90,0.7), rgba(90,255,120,0.7), rgba(90,160,255,0.7), rgba(220,90,255,0.7))', 0.8, 500);
        break;
      }
      case 'heal': case 'refresh': {
        const big = fx.spell === 'heal';
        motes(target || fx.from, palette.mote, big ? 60 : 36, big ? 1.8 : 1.4);
        decal(feet, big ? 1.2 : 0.95, 2, palette.glow.clone().multiplyScalar(0.8), 1.3, (d, u, t) => { u.uAlpha.value = Math.sin(Math.PI * clamp(t / 1.3, 0, 1)); });
        auraPulse(target || fx.from, palette.glow, 1.2, big ? 1.6 : 1);
        takeLight(palette.light, (t) => (t < 1.1 ? { p: aim, intensity: (big ? 14 : 8) * Math.sin(Math.PI * t / 1.1), distance: 7 } : null));
        if (big && !(target || fx.from).player) column(feet, palette.mote, 1.4);
        S.chord(aim, fx.spell === 'refresh' ? 440 : 392, big ? 1.5 : 1);
        if ((target || fx.from).player) flashScreen('radial-gradient(ellipse at 50% 55%, rgba(255,225,160,0.45) 0%, rgba(255,210,140,0) 75%)', 0.7, 1100);
        break;
      }
      case 'ward': case 'bless': case 'sanctuary': case 'sight': {
        const w = target || fx.from;
        const strong = f === 'sanctuary';
        auraPulse(w, palette.glow, strong ? 1.8 : 1.2, strong ? 2.2 : 1.3);
        if (f === 'bless') {
          // Gold falling on them from above.
          const top = new THREE.Vector3(feet.x, feet.y + heightOf(w) + 1.4, feet.z);
          for (let k = 0; k < n(60); k++) light.spawn({ x: top.x + rand(-0.6, 0.6), y: top.y + rand(0, 0.8), z: top.z + rand(-0.6, 0.6), vx: 0, vy: -rand(1.2, 2.2), vz: 0, life: rand(0.9, 1.5), size: rand(0.05, 0.09), color: PAL.bless.mote, shape: 2, drag: 0.5, fadeIn: 0.2, floor: feet.y + 0.02, occ: 0.3 });
        } else {
          motes(w, palette.mote, strong ? 50 : 28, strong ? 1.8 : 1.2);
        }
        if (strong && !w.player) column(feet, palette.mote, 1.8);
        decal(feet, strong ? 1.3 : 1.0, 1, palette.glow, 0.7, (d, u, t) => { u.uRadius.value = smooth(t / 0.6); u.uAlpha.value = 1 - t / 0.7; });
        takeLight(palette.light, (t) => (t < 0.9 ? { p: aim, intensity: (strong ? 16 : 7) * Math.sin(Math.PI * t / 0.9), distance: 7 } : null));
        S.chord(aim, strong ? 523 : f === 'bless' ? 440 : 349, strong ? 2 : 1);
        if (w.player) flashScreen(strong ? 'radial-gradient(ellipse at 50% 50%, rgba(255,255,255,0) 35%, rgba(245,248,255,0.85) 100%)' : 'radial-gradient(ellipse at 50% 50%, rgba(180,200,255,0) 45%, rgba(170,195,255,0.6) 100%)', 0.7, 900);
        break;
      }
      case 'curse': case 'hex': case 'weaken': case 'blind': case 'poison': {
        if (!target) break;
        const smoke = f === 'poison' ? PAL.poison.smoke : PAL.dark.smoke;
        const glowC = f === 'poison' ? PAL.poison.glow : PAL.dark.glow;
        const at = f === 'blind' ? new THREE.Vector3(feet.x, feet.y + heightOf(target) * 0.9, feet.z) : aim;
        burst(matter, at, 24, { speed: [0.2, 0.9], life: [1.0, 1.8], size: [0.26, 0.46], grow: 1.8, color: smoke, alpha: 0.65, drag: 2, gravity: f === 'weaken' ? 0.4 : -0.2, shape: 3, fadeIn: 0.15 });
        burst(light, at, 26, { speed: [0.3, 1.2], up: f === 'poison' ? 0.5 : 0, life: [0.7, 1.3], size: f === 'poison' ? [0.06, 0.12] : [0.04, 0.08], color: glowC, drag: 2, gravity: f === 'poison' ? -0.6 : 0, shape: f === 'poison' ? 5 : 1, occ: 0.3 });
        auraPulse(target, glowC, 1.0, 1.1);
        if (onYou) flashScreen(f === 'poison' ? 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 35%, rgba(60,130,20,0.7) 100%)' : 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 30%, rgba(40,10,60,0.85) 100%)', 0.8, 900);
        break;
      }
      case 'faerie': {
        if (!target) break;
        burst(light, aim, 36, { speed: [0.3, 1.4], life: [0.6, 1.1], size: [0.03, 0.06], color: PAL.faerie.mote, drag: 2, gravity: -0.3, shape: 2 });
        auraPulse(target, PAL.faerie.glow, 1.8, 0.8);
        S.chord(aim, 660, 1.4);
        break;
      }
      case 'drain': {
        if (!target) break;
        burst(matter, aim, 14, { speed: [0.2, 0.7], life: [0.8, 1.3], size: [0.2, 0.34], grow: 1.6, color: PAL.harm.smoke, alpha: 0.55, drag: 2, shape: 3, fadeIn: 0.1 });
        fx.data.drainUntil = fx.t + 0.9;   // life streaming back to the caster: see `lingering`
        auraPulse(target, PAL.harm.glow, 1.3, 0.8);
        if (hitAny) hurtFigure(target, 0.6);
        if (onYou) flashScreen('radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 30%, rgba(120,10,10,0.8) 100%)', 0.85, 1000);
        break;
      }
      case 'harm': {
        if (!target) break;
        const big = fx.spell === 'harm' || fx.spell === 'cause critical';
        burst(light, aim, big ? 34 : 20, { speed: [1.5, 4.5], life: [0.2, 0.45], size: [0.03, 0.06], color: PAL.harm.glow, drag: 3.5, shape: 1 });
        burst(matter, aim, big ? 16 : 8, { speed: [0.8, 2.2], life: [0.6, 1.1], size: [0.18, 0.3], grow: 2, color: PAL.harm.smoke, alpha: 0.6, drag: 3, shape: 3 });
        glowAt(light, aim, PAL.harm.glow, (big ? 1.4 : 0.9) * scale, 0.22, 0.9);
        takeLight(PAL.harm.light, (t) => (t < 0.35 ? { p: aim, intensity: (big ? 26 : 12) * (1 - t / 0.35), distance: 8 } : null));
        if (hitAny) hurtFigure(target, big ? 1 : 0.5);
        S.dark(aim);
        S.pop(aim, 0.6);
        if (onYou) flashScreen('radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 25%, rgba(140,0,0,0.85) 100%)', 0.9, 600);
        break;
      }
      case 'holy': {
        if (!target) break;
        fx.data.rays = { until: fx.t + 0.45, at: aim.clone(), dirs: Array.from({ length: 10 }, () => new THREE.Vector3(rand(-1, 1), rand(-0.4, 1), rand(-1, 1)).normalize()) };
        burst(light, aim, 30, { speed: [1, 4], life: [0.3, 0.6], size: [0.03, 0.06], color: PAL.holy.core, color2: PAL.holy.glow, drag: 3, shape: 1 });
        glowAt(light, aim, PAL.holy.glow, 1.4 * scale, 0.3, 1);
        takeLight(PAL.holy.light, (t) => (t < 0.5 ? { p: aim, intensity: 30 * (1 - t / 0.5), distance: 10 } : null));
        if (hitAny) hurtFigure(target, 0.8);
        S.chord(aim, 330, 2);
        break;
      }
      case 'dispel': {
        const w = target || fx.from;
        decal(feetPoint(w, new THREE.Vector3()), 2.2, 1, PAL.dispel.glow, 0.7, (d, u, t) => { u.uRadius.value = smooth(t / 0.6); u.uAlpha.value = 1 - t / 0.7; });
        auraPulse(w, PAL.dispel.glow, 1.5, 0.7);
        burst(light, chestPoint(w, new THREE.Vector3()), 24, { speed: [1.5, 3.5], flat: true, life: [0.3, 0.6], size: [0.03, 0.05], color: PAL.dispel.glow, drag: 2.5, shape: 1 });
        S.chord(aim, 470, 1);
        if ((fx.spell === 'teleport' || fx.spell === 'word of recall') && !w.player) column(feetPoint(w, new THREE.Vector3()), C(2, 2.4, 3), 1.2);
        break;
      }
      case 'quake': {
        const c = feetPoint(fx.from, new THREE.Vector3());
        for (let k = 0; k < n(46); k++) {
          const a = rand(0, TAU); const r = rand(0.5, 9);
          matter.spawn({ x: c.x + Math.cos(a) * r, y: c.y + 0.1, z: c.z + Math.sin(a) * r, vx: Math.cos(a) * rand(0.2, 0.8), vy: rand(0.3, 1.2), vz: Math.sin(a) * rand(0.2, 0.8), life: rand(1.4, 2.4), size: rand(0.5, 1.1), grow: 2, color: PAL.dust.smoke, alpha: 0.35, drag: 1.2, gravity: 0.3, shape: 3, fadeIn: 0.15 });
        }
        for (let k = 0; k < n(40); k++) {
          const a = rand(0, TAU); const r = rand(0.5, 8);
          light.spawn({ x: c.x + Math.cos(a) * r, y: c.y + 0.05, z: c.z + Math.sin(a) * r, vx: rand(-0.5, 0.5), vy: rand(1.5, 3.5), vz: rand(-0.5, 0.5), life: rand(0.5, 0.9), size: rand(0.03, 0.06), color: C(0.3, 0.26, 0.2), shape: 1, drag: 0.5, gravity: 9, floor: c.y + 0.02 });
        }
        decal(c, 9, 1, C(0.55, 0.45, 0.3), 1.0, (d, u, t) => { u.uRadius.value = smooth(t / 0.9); u.uAlpha.value = 0.8 * (1 - t / 1.0); });
        const d = distToCamera(c);
        if (player && player.shake) player.shake(clamp(1.1 - d / 20, 0.25, 1));
        for (const h of fx.hits || []) hurtFigure(who(h.to, h.player), 0.8);
        S.rumble(c);
        break;
      }
      case 'breath-gas': {
        for (const h of fx.hits || []) {
          const w = who(h.to, h.player);
          hurtFigure(w, 0.6);
          if (w.player) flashScreen('radial-gradient(ellipse at 50% 50%, rgba(140,190,40,0.35) 0%, rgba(90,130,20,0.75) 100%)', 0.85, 1400);
        }
        break;
      }
      case 'teleport': {
        const w = target || fx.from;
        if (!w.player) column(feetPoint(w, new THREE.Vector3()), C(2.2, 2.6, 3.2), 1.4);
        auraPulse(w, PAL.dispel.glow, 2, 0.9);
        S.chord(aim, 587, 1.5);
        break;
      }
      default:
        glowAt(light, aim, palette.glow, 0.9 * scale, 0.3, 0.8);
    }
  }

  /** The fireball's end: a flash that swells and burns out, fire rolling off it, smoke, embers, a ring on the ground, light. */
  function explode(p, ground, size) {
    const s = sphere();
    const R = 1.35 * size;
    if (s) {
      const t0 = clock;
      const fx = { update() {
        const t = clock - t0;
        const u = t / 0.42;
        if (u >= 1) { freeSphere(s); return false; }
        s.mesh.position.copy(p);
        s.mesh.scale.setScalar(R * (0.25 + 0.75 * (1 - Math.pow(1 - Math.min(1, t / 0.18), 3))));
        const m = s.mesh.material.uniforms;
        m.uTime.value = clock; m.uHeat.value = 1 - u; m.uAlpha.value = 1 - u * u;
        return true;
      } };
      effects.push({ kind: 'custom', ...fx });
    }
    glowAt(light, p, PAL.fire.core, R * 0.8, 0.1, 1, 1);
    glowAt(light, p, PAL.fire.glow, R * 3.2, 0.3, 0.8, 0);
    // Hot at the heart, going orange and then a dull red as each tongue cools.
    burst(light, p, 34, { speed: [3, 7], life: [0.3, 0.6], size: [0.16, 0.3].map((x) => x * size), grow: 2.4, color: C(3.2, 1.6, 0.45), color2: PAL.fire.glow, drag: 4.5, gravity: -1.2, shape: 4, fadeIn: 0.02 });
    burst(light, p, 40, { speed: [1.5, 5], life: [0.55, 1.05], size: [0.25, 0.5].map((x) => x * size), grow: 2.2, color: PAL.fire.glow.clone().multiplyScalar(1.5), color2: PAL.fire.dark, drag: 3.2, gravity: -1.8, shape: 4, fadeIn: 0.06 });
    burst(light, p, 60, { speed: [4, 11], life: [0.5, 1.2], size: [0.02, 0.04], color: PAL.fire.ember, color2: PAL.fire.dark, drag: 1.1, gravity: 7, shape: 1, floor: ground.y + 0.02 });
    burst(matter, p, 24, { speed: [0.5, 2.0], up: 0.5, life: [1.8, 3.2], size: [0.5, 0.95].map((x) => x * size), grow: 2.4, color: C(0.11, 0.1, 0.09), color2: C(0.26, 0.25, 0.24), alpha: 0.6, drag: 1.8, gravity: -0.6, shape: 3, fadeIn: 0.35 });
    decal(ground, 3.8 * size, 1, PAL.fire.glow, 0.55, (d, u, t) => { u.uRadius.value = smooth(t / 0.45); u.uAlpha.value = 1.3 * (1 - t / 0.55); });
    decal(ground, 1.8 * size, 2, C(1.6, 0.45, 0.08), 1.6, (d, u, t) => { u.uAlpha.value = Math.pow(1 - t / 1.6, 2) * 0.8; });
    takeLight(PAL.fire.light, (t) => (t < 0.9 ? { p, intensity: 190 * size * Math.pow(1 - t / 0.9, 2.2) * (0.85 + 0.15 * Math.random()), distance: 20 } : null));
    if (budget.heat) for (let k = 0; k < 8; k++) heat.add(p.x + rand(-0.8, 0.8), p.y + rand(-0.3, 0.8), p.z + rand(-0.8, 0.8), 1.8 * size, rand(0.8, 1.3), 1.2);
    const d = distToCamera(p);
    if (player && player.shake) player.shake(clamp(0.9 - d / 18, 0.08, 0.8) * size);
    S.boom(p, size);
  }

  /** Motes rising round a body, turning as they go. */
  function motes(w, color, count, life) {
    const feet = feetPoint(w, new THREE.Vector3());
    const h = heightOf(w);
    const id = anchors.take(feet);
    if (id < 0) return;
    for (let k = 0; k < n(count); k++) {
      const a = rand(0, TAU); const r = rand(0.3, 0.55);
      light.spawn({ x: Math.cos(a) * r, y: rand(0, h * 0.4), z: Math.sin(a) * r, anchor: id, vx: 0, vy: rand(0.5, 1.2), vz: 0, life: rand(life * 0.6, life), size: rand(0.045, 0.085), color, shape: 1, drag: 0.4, swirl: rand(1.2, 2.2), fadeIn: 0.25, occ: 0.25 });
    }
    lingering.push({ anchor: id, until: clock + life, follow: w });
  }

  /** A shaft of light standing on `feet` for `life` seconds. */
  function column(feet, color, life) {
    const t0 = clock;
    const base = feet.clone();
    effects.push({ kind: 'custom', update() {
      const t = clock - t0;
      if (t > life) return false;
      const a = Math.sin(Math.PI * clamp(t / life, 0, 1));
      const pts = [0, 0.25, 0.5, 0.75, 1].map((k) => ({ x: base.x, y: base.y + k * 5.5, z: base.z }));
      glow.strip(pts, (u) => 1.1 * (1 - u * 0.3), color.clone().multiplyScalar(0.35), (u) => a * (1 - u) * (1 - u) * 0.9, 0);
      return true;
    } });
  }

  // -- lasting auras -----------------------------------------------------------------

  const auras = new Map();   // figure -> { meshes, material, pulse }
  const AURA_KIND = [
    // flag or affect type, colour, intensity, thickness, flicker
    { test: (ch) => ch.affectedBy & AFF.SANCTUARY, color: PAL.sanctuary.glow, intensity: 0.62, thick: 0.035, flicker: 0.15 },
    { test: (ch) => ch.affectedBy & AFF.FAERIE_FIRE, color: PAL.faerie.glow, intensity: 0.9, thick: 0.025, flicker: 0.6 },
    { test: (ch) => ch.affected && ch.affected.some((a) => a.type === 'shield' || a.type === 'stone skin'), color: PAL.ward.glow, intensity: 0.55, thick: 0.03, flicker: 0 },
    { test: (ch) => ch.affected && ch.affected.some((a) => a.type === 'armor' || a.type === 'protection'), color: PAL.ward.glow, intensity: 0.35, thick: 0.025, flicker: 0 },
    { test: (ch) => ch.affected && ch.affected.some((a) => a.type === 'bless'), color: PAL.bless.glow, intensity: 0.35, thick: 0.025, flicker: 0 },
  ];

  function auraMaterial() {
    return new THREE.ShaderMaterial({
      vertexShader: AURA_VERT,
      fragmentShader: AURA_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color() }, uIntensity: { value: 0 }, uTime: { value: 0 },
        uThick: { value: 0.03 }, uFlicker: { value: 0 },
        uGain: shared.uGain, uFogDensity: shared.uFogDensity,
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
  }

  /** Shells over every mesh of a figure's body, sharing its skeleton. Built once. */
  function auraFor(fig) {
    let a = auras.get(fig);
    if (a) return a;
    const material = auraMaterial();
    const meshes = [];
    const sources = [];
    // The body, not what it holds or its buttons: a shell on every eye and
    // on the staff stacks rims on rims and the figure reads as glass.
    const skinned = [];
    fig.object.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
    fig.object.traverse((o) => {
      if (!o.isMesh || o.isSprite || !o.geometry || !o.geometry.attributes.normal || o.visible === false) return;
      if (skinned.length && (!o.isSkinnedMesh || o.geometry.attributes.position.count < 150)) return;
      sources.push(o);
    });
    for (const o of sources) {
      let shell;
      if (o.isSkinnedMesh) {
        shell = new THREE.SkinnedMesh(o.geometry, material);
        shell.bind(o.skeleton, o.bindMatrix);
      } else {
        shell = new THREE.Mesh(o.geometry, material);
      }
      shell.position.copy(o.position); shell.quaternion.copy(o.quaternion); shell.scale.copy(o.scale);
      shell.frustumCulled = false;
      shell.castShadow = false; shell.receiveShadow = false;
      shell.renderOrder = 6;
      shell.layers.set(OVERLAY_LAYER);
      shell.visible = false;
      o.parent.add(shell);
      meshes.push(shell);
    }
    a = { meshes, material, pulse: null, on: false };
    auras.set(fig, a);
    return a;
  }

  /** A shell flaring over a body for a moment: the landing of a ward, a frost rime. */
  function auraPulse(w, color, intensity, life) {
    if (w.player) return;
    const fig = figureOf(w.slot);
    if (!fig) return;
    const a = auraFor(fig);
    a.pulse = { color: color.clone(), intensity, life, t: 0 };
  }

  /** Each visible figure's affects, as a shell and a little matter. */
  function updateAuras(dt) {
    const time = clock;
    for (const slot of game.mobs) {
      const fig = figureOf(slot);
      const ch = slot.instance;
      if (!fig) continue;
      const visible = fig.object.visible && !slot.dead;
      let kind = null;
      if (ch && visible) kind = AURA_KIND.find((k) => k.test(ch)) || null;
      let a = auras.get(fig);
      if (!kind && !(a && a.pulse)) { if (a && a.on) { for (const m of a.meshes) m.visible = false; a.on = false; } continue; }
      a = a || auraFor(fig);
      const u = a.material.uniforms;
      let intensity = kind ? kind.intensity : 0;
      if (kind) { u.uColor.value.copy(kind.color); u.uThick.value = kind.thick; u.uFlicker.value = kind.flicker; }
      if (a.pulse) {
        a.pulse.t += dt;
        const pu = a.pulse.t / a.pulse.life;
        if (pu >= 1) a.pulse = null;
        else {
          const k = Math.sin(Math.PI * Math.min(1, pu * 2.5)) * (1 - pu * 0.3);
          if (!kind || a.pulse.intensity * k > intensity) {
            u.uColor.value.copy(a.pulse.color);
            u.uThick.value = 0.03;
            u.uFlicker.value = 0.1;
            intensity = a.pulse.intensity * k;
          }
        }
      }
      u.uIntensity.value = intensity;
      u.uTime.value = time + (slot.proto.vnum % 17);
      const on = intensity > 0.01 && visible;
      if (on !== a.on) { for (const m of a.meshes) m.visible = on; a.on = on; }

      // Matter for the affects that are not a light: dark wisps of a curse,
      // sickly bubbles of poison, a haze over blind eyes, sanctuary's motes.
      if (!ch || !visible) continue;
      const near = distToCamera(fig.at) < 28;
      if (!near) continue;
      const rate = dt * budget.density;
      const px = fig.at.x; const py = fig.at.y; const pz = fig.at.z; const h = fig.height;
      if (ch.affectedBy & AFF.SANCTUARY) {
        // The light it stands in: one soft sprite a frame, faint, body-sized.
        light.spawn({ x: px, y: py + h * 0.55, z: pz, life: 0.04, size: h * 1.25, color: PAL.sanctuary.glow, alpha: 0.1, shape: 0, drag: 0, fadeIn: 0, occ: 0 });
      }
      if ((ch.affectedBy & AFF.SANCTUARY) && Math.random() < 6 * rate) {
        const a2 = rand(0, TAU);
        light.spawn({ x: px + Math.cos(a2) * 0.45, y: py + rand(0, h * 0.5), z: pz + Math.sin(a2) * 0.45, vx: 0, vy: rand(0.4, 0.8), vz: 0, life: rand(1, 1.6), size: rand(0.025, 0.045), color: PAL.sanctuary.mote, shape: 1, drag: 0.5, fadeIn: 0.3 });
      }
      if ((ch.affectedBy & AFF.FAERIE_FIRE) && Math.random() < 8 * rate) {
        light.spawn({ x: px + rand(-0.3, 0.3), y: py + rand(0.2, h), z: pz + rand(-0.3, 0.3), vx: 0, vy: rand(0.1, 0.4), vz: 0, life: rand(0.5, 0.9), size: rand(0.02, 0.04), color: PAL.faerie.mote, shape: 2, drag: 1, fadeIn: 0.2 });
      }
      if ((ch.affectedBy & AFF.CURSE) && Math.random() < 3 * rate) {
        matter.spawn({ x: px + rand(-0.3, 0.3), y: py + rand(0.3, h * 0.8), z: pz + rand(-0.3, 0.3), vx: 0, vy: rand(0.1, 0.35), vz: 0, life: rand(1.2, 2), size: rand(0.16, 0.26), grow: 1.8, color: PAL.dark.smoke, alpha: 0.4, shape: 3, drag: 0.8, fadeIn: 0.3 });
      }
      if ((ch.affectedBy & AFF.POISON) && Math.random() < 4 * rate) {
        light.spawn({ x: px + rand(-0.3, 0.3), y: py + rand(0.4, h * 0.8), z: pz + rand(-0.3, 0.3), vx: 0, vy: rand(0.2, 0.45), vz: 0, life: rand(0.8, 1.3), size: rand(0.03, 0.06), color: PAL.poison.glow, shape: 5, drag: 0.5, fadeIn: 0.3 });
      }
      if ((ch.affectedBy & AFF.BLIND) && Math.random() < 4 * rate) {
        matter.spawn({ x: px + rand(-0.2, 0.2), y: py + h * 0.92 + rand(-0.05, 0.08), z: pz + rand(-0.2, 0.2), vx: rand(-0.1, 0.1), vy: 0.05, vz: rand(-0.1, 0.1), life: rand(0.8, 1.2), size: rand(0.14, 0.22), grow: 1.4, color: PAL.dark.smoke, alpha: 0.55, shape: 3, drag: 1, fadeIn: 0.3 });
      }
      if (ch.affected && ch.affected.some((x) => x.type === 'bless') && Math.random() < 1.5 * rate) {
        light.spawn({ x: px + rand(-0.35, 0.35), y: py + h + rand(0, 0.3), z: pz + rand(-0.35, 0.35), vx: 0, vy: -0.5, vz: 0, life: rand(1, 1.6), size: rand(0.02, 0.035), color: PAL.bless.mote, shape: 1, drag: 0.3, fadeIn: 0.3 });
      }
    }
  }

  /** Your own affects: an edge to the frame for as long as they last. */
  let edgeKey = '';
  function updateEdge() {
    const s = game.state;
    const bits = s.affectedBy || 0;
    let css = '';
    let op = 0;
    // Blind is a long affect (1 + level ticks), so it narrows the view rather than ending it.
    if (bits & AFF.BLIND) { css = 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0.3) 0%, rgba(4,2,8,0.72) 45%, rgba(0,0,0,0.95) 100%)'; op = 1; }
    else if (bits & AFF.SANCTUARY) { css = 'radial-gradient(ellipse at 50% 50%, rgba(255,255,255,0) 55%, rgba(240,244,255,0.32) 85%, rgba(250,252,255,0.5) 100%)'; op = 1; }
    else if (bits & AFF.FAERIE_FIRE) { css = 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 60%, rgba(255,110,200,0.38) 100%)'; op = 1; }
    else if (bits & AFF.POISON) { css = 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(60,120,20,0.38) 100%)'; op = 1; }
    else if (bits & AFF.CURSE) { css = 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(40,10,55,0.4) 100%)'; op = 1; }
    const key = css + op;
    if (key === edgeKey) return;
    edgeKey = key;
    if (css) edge.style.background = css;
    edge.style.opacity = String(op);
  }

  // -- lingering bits that follow bodies ---------------------------------------------
  const lingering = [];

  // -- the frame --------------------------------------------------------------------------

  let lastScale = 0;
  function update(dt) {
    clock += dt;
    const b = budgetOf();
    if (b !== budget) budget = b;

    // Units: display, whatever the hour (see the head of the file).
    const exposure = renderer.toneMappingExposure || 1;
    shared.uGain.value = (0.6 / exposure) * dayBoost;
    shared.uFogDensity.value = scene.fog && scene.fog.density !== undefined ? scene.fog.density : 0;

    const h = composer.renderTarget1 ? composer.renderTarget1.height : window.innerHeight;
    const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    if (scale !== lastScale) {
      lastScale = scale;
      light.material.uniforms.uScale.value = scale;
      matter.material.uniforms.uScale.value = scale;
      heat.setSize(composer.renderTarget1 ? composer.renderTarget1.width : window.innerWidth, h);
    }
    light.material.uniforms.uMaxPx.value = h * budget.maxPx;
    matter.material.uniforms.uMaxPx.value = h * budget.maxPx;

    glow.begin(camera.position);
    shade.begin(camera.position);

    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i];
      if (fx.kind === 'custom') { if (!fx.update()) effects.splice(i, 1); continue; }
      fx.t += dt;
      if (!fx.released && !fx.fizzled) {
        handPoint(fx.from, fx.hand);
        anchors.set(fx.anchor, fx.hand);
        if (fx.lost) {
          if (fx.t < fx.windup) gather(fx, dt);
          else { fx.done = true; }
        } else if (fx.t < fx.windup) gather(fx, dt);
        else release(fx);
      }
      if (fx.released && !fx.landed && !fx.fizzled) {
        fly(fx, dt);
        // The rules never answered (paused, or a lost event): give up quietly.
        if (fx.t - fx.releaseT > fx.flight + 3) fx.done = true;
      }
      if (fx.fizzled && !fx.landed) {
        if (fx.data.ball) { freeSphere(fx.data.ball); fx.data.ball = null; }
        fx.done = true;
      }
      drawRibbons(fx);
      if (fx.landed) {
        const after = fx.t - (fx.landT ?? fx.t);
        if (after > 1.2 && !(fx.data.strikes && fx.data.strikes.some((s) => fx.t < s.until))) fx.done = true;
      }
      if (fx.done) {
        if (fx.data.ball) { freeSphere(fx.data.ball); fx.data.ball = null; }
        anchors.release(fx.anchor);
        fx.anchor = -1;
        effects.splice(i, 1);
      }
    }

    for (let i = lingering.length - 1; i >= 0; i--) {
      const l = lingering[i];
      if (clock > l.until) { anchors.release(l.anchor); lingering.splice(i, 1); continue; }
      anchors.set(l.anchor, feetPoint(l.follow, _v));
    }

    for (const d of decals) {
      if (!d.busy) continue;
      d.t += dt;
      if (d.t >= d.life) { d.busy = false; d.mesh.visible = false; continue; }
      d.drive(d, d.mesh.material.uniforms, d.t);
    }

    for (const l of lights) {
      if (!l.busy) { l.light.intensity = 0; continue; }
      l.t += dt;
      const r = l.fn(l.t);
      if (!r) { l.busy = false; l.light.intensity = 0; l.light.position.set(0, -500, 0); continue; }
      l.light.position.set(r.p.x, r.p.y, r.p.z);
      l.light.intensity = r.intensity * lightBoost;
      l.light.distance = r.distance || 14;
    }

    updateAuras(dt);
    updateEdge();

    light.update(dt, anchors);
    matter.update(dt, anchors);
    glow.end();
    shade.end();
    heat.step(dt, clock);
  }

  /** The polyline parts of an effect, rebuilt every frame. */
  function drawRibbons(fx) {
    const f = fx.family;
    if (f === 'missile' && fx.data.bolts) {
      for (const b of fx.data.bolts) {
        if (b.trail.length < 2 || b.hit) continue;
        glow.strip(b.trail, (u) => 0.16 * (1 - u), PAL.missile.trail, (u) => (1 - u) * 0.9, 0);
        glow.strip(b.trail.slice(0, 6), (u) => 0.03 * (1 - u), PAL.missile.core.clone().multiplyScalar(0.4), (u) => 1 - u, 1);
      }
    }
    // Lightning: a new path every few frames while it lasts, the core hard and white, the glow wide and blue.
    const lightning = (f === 'lightning' || f === 'breath-lightning') && fx.released && !fx.fizzled && fx.to;
    if (lightning && fx.t - fx.releaseT < Math.max(0.32, fx.flight + 0.25)) {
      const src = fx.data.src;
      const aim = chestPoint(fx.to, tmpA, true);
      if (!fx.data.path || clock >= (fx.data.nextPath || 0)) {
        fx.data.path = bolt(src, aim.clone(), 0.2, 5);
        fx.data.branches = [];
        const count = f === 'breath-lightning' ? 5 : 3;
        for (let k = 0; k < count; k++) {
          const from = fx.data.path[Math.floor(rand(4, fx.data.path.length - 6))];
          const dir = new THREE.Vector3(aim.x - src.x, aim.y - src.y, aim.z - src.z).normalize();
          const len = rand(0.8, 2.2);
          const to = { x: from.x + (dir.x + rand(-0.9, 0.9)) * len, y: from.y + (dir.y + rand(-0.9, 0.5)) * len, z: from.z + (dir.z + rand(-0.9, 0.9)) * len };
          fx.data.branches.push(bolt(from, to, 0.25, 3));
        }
        fx.data.nextPath = clock + 0.045;
      }
      const age = fx.t - fx.releaseT;
      const fade = 1 - smooth(age / Math.max(0.32, fx.flight + 0.25));
      const flick = 0.6 + 0.4 * Math.random();
      glow.strip(fx.data.path, 0.5, PAL.lightning.glow, 0.55 * fade * flick, 0);
      glow.strip(fx.data.path, 0.05, PAL.lightning.core, fade, 1);
      for (const br of fx.data.branches) {
        glow.strip(br, (u) => 0.22 * (1 - u), PAL.lightning.glow, (u) => 0.45 * (1 - u) * fade, 0);
        glow.strip(br, (u) => 0.025 * (1 - u * 0.6), PAL.lightning.core.clone().multiplyScalar(0.6), (u) => (1 - u) * fade, 1);
      }
    }
    // Arcs crawling over a body: shocking grasp, and the strike of a sky bolt.
    if (fx.data.strikes) {
      for (const s of fx.data.strikes) {
        if (fx.t >= s.until) continue;
        const fade = clamp((s.until - fx.t) / 0.3, 0, 1);
        const feet = feetPoint(s.w, tmpA);
        const h = heightOf(s.w);
        if (f === 'storm') {
          const top = { x: feet.x + rand(-2, 2), y: feet.y + 40, z: feet.z + rand(-2, 2) };
          const end = { x: feet.x, y: feet.y + h * 0.6, z: feet.z };
          if (!s.path || clock >= s.next) { s.path = bolt(top, end, 0.12, 6); s.next = clock + 0.05; }
          glow.strip(s.path, 1.2, PAL.lightning.glow, 0.5 * fade, 0);
          glow.strip(s.path, 0.12, PAL.lightning.core, fade, 1);
        } else if (!s.w.player) {
          for (let k = 0; k < 3; k++) {
            const a0 = rand(0, TAU); const a1 = a0 + rand(0.6, 1.6);
            const p0 = { x: feet.x + Math.cos(a0) * 0.3, y: feet.y + rand(0.3, h), z: feet.z + Math.sin(a0) * 0.3 };
            const p1 = { x: feet.x + Math.cos(a1) * 0.3, y: feet.y + rand(0.3, h), z: feet.z + Math.sin(a1) * 0.3 };
            const path = bolt(p0, p1, 0.3, 3);
            glow.strip(path, 0.14, PAL.lightning.glow, 0.5 * fade, 0);
            glow.strip(path, 0.02, PAL.lightning.core, fade, 1);
          }
        }
      }
    }
    // Shocking grasp: the arc from the hand while the spell is on its way.
    if (f === 'shock' && fx.released && fx.to && (!fx.landed || fx.t - fx.landT < 0.3)) {
      const aim = chestPoint(fx.to, tmpA, true).clone();
      const path = bolt(fx.data.src, aim, 0.3, 4);
      glow.strip(path, 0.3, PAL.lightning.glow, 0.5, 0);
      glow.strip(path, 0.035, PAL.lightning.core, 1, 1);
      fx.data.mid = aim;
    }
    // Flamestrike: the pillar itself, coming down.
    if (f === 'flamestrike' && fx.data.column && (!fx.landed || fx.t - fx.landT < 0.35)) {
      const c = fx.data.column;
      const fade = fx.landed ? 1 - (fx.t - fx.landT) / 0.35 : 1;
      const pts = [];
      for (let k = 0; k <= 8; k++) {
        const y = lerp(c.top, c.front, k / 8);
        pts.push({ x: c.base.x + Math.sin(clock * 23 + k) * 0.06, y, z: c.base.z + Math.cos(clock * 19 + k) * 0.06 });
      }
      glow.strip(pts, (u) => 0.5 + u * 0.5, PAL.fire.glow, (u) => fade * (0.35 + 0.65 * u), 0);
      glow.strip(pts, (u) => 0.12 + u * 0.12, C(4, 2.4, 0.8), (u) => fade * u, 0.5);
    }
    // Colour spray: a fan of rays from the hand, each its own colour.
    if (f === 'prism' && fx.released && fx.to) {
      const age = fx.t - fx.releaseT;
      const life = fx.flight + 0.3;
      if (age < life) {
        const src = fx.data.src;
        const aim = chestPoint(fx.to, tmpA, true);
        const dir = _v.set(aim.x - src.x, aim.y - src.y, aim.z - src.z);
        const len = dir.length() * 1.08; dir.normalize();
        const side = _w.set(-dir.z, 0, dir.x).normalize();
        const reach = smooth(age / Math.max(0.08, fx.flight));
        const fade = 1 - smooth((age - fx.flight) / 0.3);
        PRISM.forEach((c, k) => {
          const off = (k - (PRISM.length - 1) / 2) * 0.09;
          const end = { x: src.x + (dir.x + side.x * off) * len * reach, y: src.y + (dir.y + (k % 2 ? 0.04 : -0.04)) * len * reach, z: src.z + (dir.z + side.z * off) * len * reach };
          glow.strip([src, end], (u) => 0.04 + u * 0.16, c.clone().multiplyScalar(0.32), (u) => 0.9 * fade * (1 - u * 0.4), 0.4);
        });
      }
    }
    // Tendrils: a curse or a drain reaching across, writhing.
    if ((f === 'curse' || f === 'drain' || f === 'hex') && fx.released && fx.to && fx.to !== fx.from) {
      const age = fx.t - fx.releaseT;
      const life = fx.flight + 0.5;
      if (age < life) {
        const src = fx.data.src;
        const aim = chestPoint(fx.to, tmpA, true).clone();
        const reach = smooth(age / Math.max(0.1, fx.flight));
        const fade = 1 - smooth((age - fx.flight) / 0.5);
        // Three strands wound round the line between them, each turning and
        // writhing on its own, rising off the ground in a shallow arch.
        const dx = aim.x - src.x; const dy = aim.y - src.y; const dz = aim.z - src.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const ax = dx / len; const az = dz / len;
        const sx = -az; const sz = ax;   // horizontal side
        const smokeC = f === 'drain' ? C(0.06, 0.005, 0.005) : PAL.dark.smoke;
        const glowC = f === 'drain' ? PAL.harm.glow : PAL.dark.glow;
        for (let k = 0; k < 3; k++) {
          const pts = [];
          const phase = k * 2.094 + clock * 5.5;
          for (let j = 0; j <= 20; j++) {
            const u = (j / 20) * reach;
            const env = Math.sin(Math.PI * Math.min(1, u / Math.max(0.05, reach))) * 0.32 + 0.04;
            const ang = phase + u * 11;
            const r = env * (0.8 + 0.4 * Math.sin(u * 17 + clock * 9 + k));
            const arch = Math.sin(Math.PI * u) * Math.min(1.0, len * 0.12);
            pts.push({
              x: src.x + dx * u + sx * Math.cos(ang) * r,
              y: src.y + dy * u + Math.sin(ang) * r + arch,
              z: src.z + dz * u + sz * Math.cos(ang) * r,
            });
          }
          shade.strip(pts, (u) => 0.16 * (1 - u * 0.4), smokeC, (u) => 0.8 * fade * (0.4 + 0.6 * Math.sin(Math.PI * Math.min(1, u * 1.2))), 0);
          glow.strip(pts, (u) => 0.045 * (1 - u * 0.4), glowC, (u) => 0.9 * fade, 0.3);
          if (Math.random() < 0.5 * budget.density) {
            const q = pts[Math.floor(rand(0, pts.length))];
            matter.spawn({ x: q.x, y: q.y, z: q.z, vx: 0, vy: rand(0.1, 0.4), vz: 0, life: rand(0.6, 1.0), size: rand(0.12, 0.2), grow: 1.8, color: smokeC, alpha: 0.5, shape: 3, drag: 1, fadeIn: 0.2 });
          }
        }
      }
    }
    // Energy drain: what was taken, flowing back to the caster.
    if (f === 'drain' && fx.landed && fx.data.drainUntil && fx.t < fx.data.drainUntil && fx.to) {
      const from = chestPoint(fx.to, tmpA);
      const to = handPoint(fx.from, tmpB);
      for (let k = 0; k < n(3); k++) {
        const t = rand(0.35, 0.55);
        light.spawn({ x: from.x + rand(-0.2, 0.2), y: from.y + rand(-0.3, 0.3), z: from.z + rand(-0.2, 0.2), vx: (to.x - from.x) / t, vy: (to.y - from.y) / t, vz: (to.z - from.z) / t, life: t, size: rand(0.03, 0.06), color: PAL.harm.glow.clone().multiplyScalar(1.5), shape: 1, drag: 0 });
      }
    }
    // Dispel evil: rays thrown out of the struck.
    if (fx.data.rays && fx.t < fx.data.rays.until) {
      const r = fx.data.rays;
      const fade = (r.until - fx.t) / 0.45;
      for (const d of r.dirs) glow.strip([r.at, { x: r.at.x + d.x * 2.2, y: r.at.y + d.y * 2.2, z: r.at.z + d.z * 2.2 }], (u) => 0.12 * (1 - u), PAL.holy.glow, (u) => fade * (1 - u), 0);
    }
  }

  // Additive light reads weaker against a sunlit wall than against a night
  // street, and a spell has to read in daylight: `setDaylight` lifts both.
  let dayBoost = 1;
  let lightBoost = 1;

  return {
    update,
    /** 0 at night, 1 at noon: from applyTime, alongside fx.setAmbient. */
    setDaylight(k) {
      const d = clamp(k, 0, 1);
      dayBoost = 1 + 0.25 * d;
      lightBoost = 1 + 0.8 * d;
      // Smoke is lit, not emissive: dark at night, pale grey at noon.
      const m = 0.25 + 0.75 * d;
      PAL.dust.smoke.setRGB(0.46 * m, 0.41 * m, 0.34 * m);
    },
    /** For the harness: how much is alive right now. */
    stats() {
      return {
        effects: effects.length, light: light.n, matter: matter.n, ribbonVerts: glow.v + shade.v,
        decals: decals.filter((d) => d.busy).length, spheres: spheres.filter((s) => s.busy).length,
        lights: lights.filter((l) => l.busy).length, heat: heat.live.length, auras: [...auras.values()].filter((a) => a.on).length,
      };
    },
    pools: { light, matter, glow, shade },
    heat,
    dispose() { unlisten(); scene.remove(group); overlay.remove(); for (const l of lights) scene.remove(l.light); },
  };
}
