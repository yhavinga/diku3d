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
  frost: { glow: C(0.45, 0.85, 1.7), crystal: C(1.6, 2.4, 3.6), mist: C(0.5, 0.7, 1.0), rime: C(0.75, 0.9, 1.1), light: 0x9fd0ff },
  acid: { glow: C(0.55, 1.6, 0.18), drop: C(0.9, 2.6, 0.22), fume: C(0.42, 0.55, 0.16), light: 0x8cff4a },
  heal: { glow: C(1.9, 1.5, 0.8), mote: C(3.0, 2.5, 1.3), light: 0xffd9a0 },
  refresh: { glow: C(0.7, 1.7, 1.3), mote: C(1.4, 3.0, 2.3), light: 0xa0ffd8 },
  ward: { glow: C(0.75, 1.0, 1.9), mote: C(1.4, 1.9, 3.2), light: 0xa8c8ff },
  bless: { glow: C(1.9, 1.5, 0.6), mote: C(3.2, 2.6, 1.1), light: 0xffe0a0 },
  sanctuary: { glow: C(2.0, 1.85, 1.45), mote: C(3.6, 3.3, 2.4), light: 0xfff0d0 },
  dark: { glow: C(0.55, 0.12, 0.9), smoke: C(0.07, 0.03, 0.09), light: 0x7a3cff },
  harm: { glow: C(1.9, 0.18, 0.12), smoke: C(0.08, 0.01, 0.01), light: 0xff3a2a },
  poison: { glow: C(0.55, 1.5, 0.25), smoke: C(0.12, 0.2, 0.05), light: 0x7aff4a },
  faerie: { glow: C(2.0, 0.55, 1.3), mote: C(3.4, 1.1, 2.4), light: 0xff78c8 },
  holy: { glow: C(2.0, 1.8, 1.2), core: C(14, 12, 8), light: 0xfff0c8 },
  dispel: { glow: C(0.6, 1.6, 1.9), light: 0x9ff0ff },
  dust: { smoke: C(0.46, 0.41, 0.34), grit: C(0.3, 0.26, 0.21) },
  gas: { smoke: C(0.34, 0.46, 0.14), glow: C(0.5, 1.2, 0.2), light: 0xb8ff6a },
};
const BOLT_MID = C(1.1, 1.5, 3.6);
const MISSILE_STREAK = C(3.2, 2.4, 6);
const FIRE_TRAIL = PAL.fire.glow.clone().multiplyScalar(1.4);
const FIRE_BURST = PAL.fire.glow.clone().multiplyScalar(1.5);
const HARM_BRIGHT = PAL.harm.glow.clone().multiplyScalar(1.5);
const DRAIN_SMOKE = C(0.06, 0.005, 0.005);
const TRAIL = 12;
const WHITE_HOT = C(9, 9, 10);
// A fire tongue, drawn with functions made once.
const tongue = { a: 1, big: 1, c0: null, c1: null };
const _tc = new THREE.Color();
const tongueWidth = (u) => (0.06 + u * 0.55) * tongue.big;
const tongueColour = (u) => _tc.copy(tongue.c0).lerp(tongue.c1, Math.sqrt(u));
const tongueAlpha = (u) => tongue.a * 0.55 * Math.pow(1 - u, 1.4) * Math.min(1, u * 10);
const C_PRISM_FLARE = C(1.6, 1.5, 1.7);
/** A colour of the spectrum, `hue` wrapping, in display units, into `_spec`. */
const _spec = new THREE.Color();
const spectral = (hue, k = 2.4) => _spec.setHSL(((hue % 1) + 1) % 1, 1, 0.5).multiplyScalar(k);
// The colour spray's ray, drawn with functions made once (see drawRibbons).
const prismRay = { hue: 0, a: 1 };
const _spec2 = new THREE.Color();
const prismWide = (u) => 0.04 + u * 0.42;
const prismThin = (u) => 0.012 + u * 0.05;
const prismColour = (u) => spectral(prismRay.hue + u * 0.4, 1.3);
const prismColourHot = (u) => _spec2.copy(spectral(prismRay.hue + u * 0.4, 2.6)).addScalar(1.6 * (1 - u));
const prismAlphaWide = (u) => prismRay.a * 0.5 * Math.pow(1 - u, 1.2) * Math.min(1, u * 8);
const prismAlphaThin = (u) => prismRay.a * Math.pow(1 - u, 1.6);
// Width and alpha along a ribbon, made once: u is 0 at the head.
const widths = new Map();
const fades = new Map();
const taper1 = (w) => widths.get(w) || widths.set(w, (u) => w * (1 - u)).get(w);
const fadeSq = (a) => fades.get(a) || fades.set(a, (u) => a * (1 - u) * (1 - u)).get(a);
const BOLT_GHOST = C(0.55, 0.42, 1.8);
/** Return strokes of a lightning flash, seconds after the leader. */
const STROKES = [0, 0.07, 0.15, 0.27];
const CRACKLE = new Set(['lightning', 'shock', 'storm', 'breath-lightning']);
const PRISM = [C(2.6, 0.2, 0.15), C(2.6, 1.0, 0.1), C(2.3, 2.1, 0.2), C(0.3, 2.4, 0.35), C(0.2, 1.2, 2.8), C(0.9, 0.3, 2.8), C(2.2, 0.35, 2.0)];

/**
 * A breath (or burning hands): what its stream is made of. `hot`/`cool` the
 * body's colour from the lips to the far end, `shape` its sprite (see
 * POINT_FRAG), `lift` its gravity (negative rises); `bit` what is flung
 * through it; `smoke` what hangs off its end; `tongue` the ribbons.
 */
const STREAMS = {
  flame: null,
  'breath-fire': {
    hot: C(1.7, 0.52, 0.06), cool: C(0.5, 0.05, 0.0), alpha: 0.55, shape: 4, lift: -2.2, occ: 0.7,
    bit: PAL.fire.ember, bit2: PAL.fire.dark, bitShape: 1, bitSize: 0.03, bitFall: 5, bitOcc: 0,
    smoke: C(0.1, 0.09, 0.08), smoke2: C(0.24, 0.23, 0.22), smokeAlpha: 0.42, smokeRise: 1,
    lip: C(5, 3.2, 1.2), glow: PAL.fire.glow, tongue0: C(2.4, 1.3, 0.35), tongue1: C(1.0, 0.18, 0.02), tongueA: 1,
    heat: true, light: PAL.fire.light, lit: 1,
  },
  'breath-frost': {
    hot: C(1.3, 1.8, 2.6), cool: C(0.35, 0.55, 0.9), alpha: 0.55, shape: 3, lift: 0.4, occ: 0.55,
    bit: PAL.frost.crystal, bit2: PAL.frost.glow, bitShape: 2, bitSize: 0.08, bitFall: 1.5, bitOcc: 0.35,
    smoke: C(0.62, 0.7, 0.8), smoke2: C(0.7, 0.76, 0.84), smokeAlpha: 0.3, smokeRise: -0.3,
    lip: C(3, 4, 6), glow: PAL.frost.glow, tongue0: C(1.6, 2.2, 3.2), tongue1: C(0.3, 0.55, 1.1), tongueA: 0.8,
    heat: false, light: PAL.frost.light, lit: 0.6,
  },
  'breath-acid': {
    hot: C(0.7, 1.9, 0.25), cool: C(0.25, 0.5, 0.06), alpha: 0.6, shape: 3, lift: 1.2, occ: 0.55,
    bit: PAL.acid.drop, bit2: PAL.acid.glow, bitShape: 6, bitSize: 0.07, bitFall: 7, bitOcc: 0.6,
    smoke: C(0.3, 0.38, 0.1), smoke2: C(0.36, 0.42, 0.16), smokeAlpha: 0.45, smokeRise: 0.6,
    lip: C(2.4, 5, 1), glow: PAL.acid.glow, tongue0: C(1.0, 2.4, 0.3), tongue1: C(0.3, 0.7, 0.05), tongueA: 0.7,
    heat: false, light: PAL.acid.light, lit: 0.6,
  },
};
STREAMS.flame = { ...STREAMS['breath-fire'] };

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
  uniform float uTime;
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
    float hot = 0.0;
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
    } else if (shape < 4.5) {          // flame: a torn edge that licks upward, whiter where it is dense
      vec2 q = c * 0.42 + vec2(seed * 5.1, seed * 9.7 + uTime * 0.55);
      float n = texture2D(uNoise, q).r * 0.65 + texture2D(uNoise, q * 2.3 - vec2(0.0, uTime * 0.9)).r * 0.35;
      n = (n - 0.5) * 2.6 + 0.5;   // the field is mostly mid-grey: stretch it, so the edge tears
      a = exp(-r2 * 1.6) * smoothstep(0.3, 0.8, n * 0.75 + (1.0 - r2) * 0.5) * 1.3;
      // Temperature, not just density: the thick middle of a tongue is
      // yellow, its ragged edge the colour it was given.
      hot = smoothstep(0.8, 1.25, a) * 0.6;
    } else if (shape < 5.5) {          // bubble: a thin ring with a lit rim
      float r = sqrt(r2);
      a = smoothstep(0.62, 0.8, r) * smoothstep(1.0, 0.86, r) * 0.9 + exp(-dot(c - vec2(-0.3, 0.35), c - vec2(-0.3, 0.35)) * 40.0) * 0.6;
    } else if (shape < 6.5) {          // blob: a bead of liquid with a highlight
      a = smoothstep(1.0, 0.55, r2) * 0.85 + exp(-dot(c - vec2(-0.3, 0.3), c - vec2(-0.3, 0.3)) * 18.0) * 0.8;
    } else {                           // glint: a four-point star that twinkles
      float ang = seed * 1.57;
      vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c;
      float tw = 0.55 + 0.45 * sin(uTime * 23.0 + seed * 61.0);
      a = (exp(-abs(q.x) * 28.0) * exp(-abs(q.y) * 2.6) + exp(-abs(q.y) * 28.0) * exp(-abs(q.x) * 2.6)) * 0.9 * tw
        + exp(-r2 * 30.0) * 1.4;
      hot = exp(-r2 * 30.0);
    }
    a = clamp(a, 0.0, 2.0) * vAlpha * fogT(vDist);
    // Both pools blend ONE / ONE_MINUS_SRC_ALPHA on premultiplied colour.
    // Matter covers what is behind it and is lit, not emissive. Light adds,
    // except for its occlusion share: fire has body, and over a sunlit
    // wall a purely additive flame only ever bleaches it towards white.
    vec3 col = vColor * (1.0 + hot * vec3(0.35, 0.8, 1.6)) * uGain;
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
  uniform float uSeed;
  uniform float uHeat;      // for the marks: 1 fresh, falling to 0 as it cools
  varying vec2 vUv;
  varying float vDist;
  ${NOISE_GLSL}
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
    } else if (uMode < 2.5) {
      a = exp(-r * r * 3.5);
    } else if (uMode > 7.5) {
      // Sanctuary: a plain double ring and a pool of light on the ground,
      // with fine ticks between the rings turning very slowly. uHeat is the
      // breath, so it swells and settles with the mantle.
      float turn = atan(vUv.y, vUv.x) + uTime * 0.12;
      float ticks = smoothstep(0.55, 0.9, abs(sin(turn * 14.0))) * step(0.76, r) * step(r, 0.9);
      float rings = band(r, 0.94, 0.028) + band(r, 0.7, 0.014) * 0.55;
      a = (rings + ticks * 0.45) * (0.65 + 0.35 * uHeat) + exp(-r * r * 4.5) * 0.3 * (0.6 + 0.4 * uHeat);
      a *= smoothstep(1.0, 0.9, r);
    } else {
      // The marks a spell leaves: ground cover (alpha, darkening what is
      // under it) and a little light of its own (colour) that dies first.
      vec3 p3 = vec3(vUv * 2.2, uSeed);
      float n = fbm(p3);
      float edge = r + (n - 0.5) * 0.55;
      float cover = 0.0;
      vec3 lit = vec3(0.0);
      if (uMode < 3.5) {
        // Scorch: charred in the middle, a brown singe out to a torn edge,
        // embers in the char while it is hot.
        float char = smoothstep(0.62, 0.2, edge);
        float singe = smoothstep(0.95, 0.45, edge);
        cover = singe * 0.45 + char * 0.45;
        float ember = smoothstep(0.58, 0.8, fbm(vec3(vUv * 7.0, uSeed + uTime * 0.25))) * char;
        lit = vec3(2.4, 0.75, 0.12) * ember * uHeat * 1.6 + uColor * exp(-r * r * 6.0) * uHeat * 0.5;
      } else if (uMode < 4.5) {
        // Where lightning went to ground: a burnt star of forking channels
        // (Lichtenberg figures), glowing white-blue for a moment.
        float ang = atan(vUv.y, vUv.x);
        float w = fbm(vec3(r * 3.0, ang * 1.3, uSeed)) * 5.0 + fbm(vec3(r * 9.0, ang * 4.0, uSeed + 3.0)) * 1.4;
        float ch = abs(sin(ang * 4.0 + w));
        float ch2 = abs(sin(ang * 9.0 + w * 1.7 + 1.3));
        float thin = mix(0.16, 0.035, r);
        float reach = smoothstep(1.0, 0.55, edge);
        float lines = max(smoothstep(thin, 0.0, ch), smoothstep(thin * 0.7, 0.0, ch2) * smoothstep(0.25, 0.5, r)) * reach;
        // The burn is wider than the glowing channel was.
        float burnt = max(smoothstep(thin * 3.0, 0.0, ch), smoothstep(thin * 2.2, 0.0, ch2) * smoothstep(0.25, 0.5, r)) * reach;
        float core = smoothstep(0.32, 0.0, edge);
        cover = max(burnt * 0.85, core * 0.62);
        lit = uColor * (lines * 0.9 + core * 1.2) * uHeat * uHeat;
      } else if (uMode < 5.5) {
        // Rime: pale frost feathered at its edge, with a cold glint.
        // Ridged noise for the feathering of frost, finer points of it lit.
        float fe = fbm(vec3(vUv * 7.0, uSeed));
        float ridge = 1.0 - abs(2.0 * fbm(vec3(vUv * 5.0 + 3.0, uSeed + 7.0)) - 1.0);
        float body = smoothstep(0.9, 0.3, edge + (fe - 0.5) * 0.5);
        float feather = pow(ridge, 5.0) * body;
        float glint = smoothstep(0.72, 0.9, fbm(vec3(vUv * 26.0, uSeed + 11.0))) * body;
        cover = body * 0.12 + feather * 0.35;
        lit = uColor * (body * 0.12 + feather * 0.75 + glint * 1.6) + uColor * exp(-r * r * 5.0) * uHeat * 0.6;
      } else if (uMode < 6.5) {
        // Acid: a dark etched stain, and it still seethes.
        float body = smoothstep(0.8, 0.35, edge);
        float pits = smoothstep(0.55, 0.75, fbm(vec3(vUv * 8.0, uSeed + uTime * 0.6)));
        cover = body * (0.5 + pits * 0.25);
        lit = uColor * body * (0.15 + pits * 1.3) * (0.4 + 0.6 * uHeat);
      } else {
        // Earthquake: the ground split in jagged lines out from the middle.
        float ang = atan(vUv.y, vUv.x);
        float w = fbm(vec3(r * 2.5, ang * 1.1, uSeed)) * 6.0;
        float ch = abs(sin(ang * 3.5 + w));
        float ch2 = abs(sin(ang * 8.0 + w * 1.6 + 2.0));
        float lines = smoothstep(mix(0.13, 0.03, r), 0.0, ch) * smoothstep(0.04, 0.16, r) * smoothstep(1.0, 0.6, edge);
        lines = max(lines, smoothstep(mix(0.08, 0.02, r), 0.0, ch2) * smoothstep(0.3, 0.55, r) * smoothstep(1.0, 0.6, edge) * 0.8);
        // Dust settled round the splits.
        float dust = smoothstep(0.9, 0.2, edge) * 0.12;
        cover = lines * 0.9 + dust;
        lit = vec3(0.0);
      }
      float f = uAlpha * fogT(vDist);
      gl_FragColor = vec4(lit * uGain * f, cover * f);
      return;
    }
    a *= uAlpha * fogT(vDist);
    gl_FragColor = vec4(uColor * uGain * a, 0.0);
  }
`;

/** A ball of fire: fbm moving through it, hottest where you look straight in. */
const FIRE_VERT = `
  uniform float uTime;
  uniform float uSeed;
  uniform float uBillow;    // how far the surface heaves, as a share of the radius
  varying vec3 vP;
  varying vec3 vN;
  varying vec3 vV;
  varying float vDist;
  ${NOISE_GLSL}
  void main() {
    vP = position;
    // Billows: the surface pushed out by slow noise rolling up through it,
    // so the ball is a heap of lobes and never a smooth dome.
    float b = fbm(position * 1.7 + vec3(uSeed, uSeed * 0.3 - uTime * 1.6, 0.0));
    vec3 pos = position * (1.0 + (b - 0.45) * uBillow * 2.2);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
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
    float n = fbm(vP * 2.2 + vec3(uSeed, -uTime * 3.2, uSeed * 0.7));
    n = clamp((n - 0.5) * 2.4 + 0.5, 0.0, 1.0);   // fbm is mostly mid-grey: stretch it into seams and lobes
    float t = clamp(pow(facing, 1.3) * 0.42 + n * 0.9 - (1.0 - uHeat) * 0.85 - 0.02, 0.0, 1.0);
    // Soot red at the cool edges, orange through the body, yellow only in
    // the hottest seams -- too much of the top end and it reads as peach.
    vec3 col = mix(vec3(0.16, 0.02, 0.0), vec3(1.1, 0.26, 0.02), smoothstep(0.08, 0.45, t));
    col = mix(col, vec3(1.9, 0.75, 0.12), smoothstep(0.5, 0.82, t));
    col = mix(col, vec3(6.0, 3.6, 1.2), smoothstep(0.9, 1.0, t) * uHeat);
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
  uniform float uSoft;
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
    // Soft (sanctuary): light along the body's own edge and nowhere else --
    // rim light, the way a figure stands against a bright window. It used to
    // be a broad band peaking *inside* a shell blown 6 cm off the body, and
    // what that drew was a second, translucent, inflated copy of the whole
    // figure over it: the executioner and the brass dragon read as ghosts in
    // glass. The shell now sits a centimetre off the skin, so its outline is
    // the body's, and only the last few degrees of the turn light up.
    float soft = pow(rim, 5.0) * 1.6 * (0.6 + 0.4 * smoothstep(0.8, 4.0, vDist));
    f = mix(f, soft, uSoft);
    float n = vnoise(vW * 3.2 + vec3(0.0, -uTime * 1.3, 0.0));
    // A slow shimmer rising through it.
    n = mix(n, 0.5 + 0.5 * sin(vW.y * 9.0 - uTime * 3.0 + vnoise(vW * 2.0) * 5.0), uSoft * 0.5);
    float flick = mix(1.0, 0.6 + 0.8 * vnoise(vec3(uTime * 9.0, vW.y * 2.0, 0.0)), uFlicker);
    float a = f * 1.5 * (0.25 + 1.0 * n) * uIntensity * flick * fogT(vDist);
    gl_FragColor = vec4(uColor * uGain * a, 0.0);
  }
`;

/**
 * Sanctuary's mantle: the *outside* of a figure. The shell is the body pushed
 * out along its normals and drawn from behind, so the only part of it that
 * ever shows is the ring between the body's silhouette and the shell's own
 * edge, and there |n.v| falls from the body outwards -- bright where the
 * light leaves the skin, gone at the rim. The inner-rim shell cannot do this:
 * it lights the body's own edge, which is a one-pixel line at 20 m.
 */
const HALO_FRAG = `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uGain;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vW;
  varying float vDist;
  ${NOISE_GLSL}
  ${FOG_GLSL}
  void main() {
    // Signed: a real far side of the body turns its normal away from the eye.
    // A shard of shell that has folded in front of the body (flat-shaded
    // normals pushed apart) still faces the eye, and must not draw.
    float nv = max(0.0, -dot(normalize(vN), normalize(vV)));
    float f = pow(nv, 2.0);
    // Light drifting up through it, slowly.
    float n = vnoise(vW * 2.4 + vec3(0.0, -uTime * 0.7, 0.0));
    float rise = 0.5 + 0.5 * sin(vW.y * 4.0 - uTime * 1.3 + n * 3.0);
    float shimmer = 0.72 + 0.28 * mix(n, rise, 0.5);
    float a = f * shimmer * uIntensity * fogT(vDist);
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
    this.floor = F(1); this.hold = F(1);

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
    this.hold[i] = o.hold || 0;
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
      this.seed, this.fadeIn, this.anchor, this.swirl, this.pull, this.floor, this.occ, this.hold]) move1(arr);
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
      // `hold`: full strength for that share of its life before it fades --
      // a stream has to arrive, not die on the way.
      const h = this.hold[i];
      const uf = h > 0 ? Math.max(0, (u - h) / (1 - h)) : u;
      this.ga[i] = this.a0[i] * inA * (1 - uf) * (1 - uf * 0.35);
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
   * `alpha(u)`; `sharp` 0 soft to 1 hard-edged; only the first `count`
   * points (a bolt still reaching its target).
   */
  strip(pts, width, color, alpha, sharp = 0, count = pts.length) {
    const n = Math.min(count, pts.length);
    if (n < 2 || this.v + n * 2 > this.max) return;
    const base = this.v;
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)]; const b = pts[Math.min(n - 1, k + 1)];
      this._dir.set(b.x - a.x, b.y - a.y, b.z - a.z);
      const p = pts[k];
      this._side.set(p.x - this._eye.x, p.y - this._eye.y, p.z - this._eye.z).cross(this._dir);
      const len = this._side.length() || 1;
      const u = k / (n - 1);
      // Never wider than a few degrees of the view: a bolt leaving your own
      // hand is a metre-wide glow half a metre from the lens otherwise, and
      // reads as a flat strip pasted over the frame.
      const eyeDist = Math.hypot(p.x - this._eye.x, p.y - this._eye.y, p.z - this._eye.z);
      const w = Math.min(typeof width === 'function' ? width(u) : width, eyeDist * (sharp > 0.5 ? MAX_CORE_ANGLE : MAX_RIBBON_ANGLE)) / 2 / len;
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

/** The widest a ribbon may look, in radians of the view (see Ribbons.strip). */
const MAX_RIBBON_ANGLE = 0.05;
const MAX_CORE_ANGLE = 0.01;

const P3 = (n) => Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0 }));

/**
 * A jagged path from a to b written into `out` (2^depth + 1 points, from
 * `at`): midpoint displacement, the kick halving with each level.
 */
function jag(out, a, b, amount, depth, at = 0) {
  const N = 1 << depth;
  const s = out[at]; const e = out[at + N];
  s.x = a.x; s.y = a.y; s.z = a.z; e.x = b.x; e.y = b.y; e.z = b.z;
  let amp = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * amount;
  for (let step = N >> 1; step >= 1; step >>= 1) {
    for (let i = step; i < N; i += step * 2) {
      const p = out[at + i - step]; const q = out[at + i + step]; const m = out[at + i];
      m.x = (p.x + q.x) / 2 + rand(-amp, amp);
      m.y = (p.y + q.y) / 2 + rand(-amp, amp) * 0.8;
      m.z = (p.z + q.z) / 2 + rand(-amp, amp);
    }
    amp *= 0.52;
  }
  return out;
}

/** A jagged path from a to b: midpoint displacement, `depth` times (allocates; for the few-per-cast arcs). */
function bolt(a, b, amount = 0.22, depth = 5) {
  return jag(P3((1 << depth) + 1), a, b, amount, depth);
}

/**
 * A lightning stroke as it is seen: a main channel whose big kinks hold from
 * one return stroke to the next while the fine ones change, forks that burn
 * for a moment off each stroke, and the channel it was a moment ago left
 * behind on the eye. Everything preallocated when the spell is released.
 */
class Bolt {
  constructor(branches = 6) {
    this.coarse = P3(5);                 // the four kinks that hold
    this.main = P3(4 * 16 + 1);          // each coarse leg split 16 ways
    this.ghost = P3(this.main.length);
    this.ghostAt = -1;
    this.branches = Array.from({ length: branches }, () => ({ pts: P3(17), sub: P3(9), on: false, sub_on: false, len: 1 }));
  }

  /** Lay out the big kinks between a and b. */
  shape(a, b, amount = 0.2) { jag(this.coarse, a, b, amount, 2); }

  /** A return stroke: new fine detail, new forks, the old channel kept as an afterimage. */
  strike(a, b, now, reach = 2.2, forks = this.branches.length) {
    for (let i = 0; i < this.main.length; i++) { const g = this.ghost[i]; const m = this.main[i]; g.x = m.x; g.y = m.y; g.z = m.z; }
    this.ghostAt = now;
    const c = this.coarse;
    c[0].x = a.x; c[0].y = a.y; c[0].z = a.z; c[4].x = b.x; c[4].y = b.y; c[4].z = b.z;
    for (let k = 0; k < 4; k++) jag(this.main, c[k], c[k + 1], 0.16, 4, k * 16);
    const dx = b.x - a.x; const dy = b.y - a.y; const dz = b.z - a.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    for (let k = 0; k < this.branches.length; k++) {
      const br = this.branches[k];
      br.on = k < forks && Math.random() < 0.8;
      if (!br.on) continue;
      // Forks lean the way the stroke is going and spread off it.
      const from = this.main[Math.floor(rand(6, this.main.length - 10))];
      const len = rand(0.35, 1) * reach;
      _bv.set(dx / L + rand(-1, 1), dy / L + rand(-0.9, 0.4), dz / L + rand(-1, 1)).normalize().multiplyScalar(len);
      _bw.set(from.x + _bv.x, from.y + _bv.y, from.z + _bv.z);
      jag(br.pts, from, _bw, 0.24, 4);
      br.len = len;
      br.sub_on = Math.random() < 0.6;
      if (br.sub_on) {
        const at = br.pts[Math.floor(rand(4, 10))];
        _bv.multiplyScalar(0.45).add(_bx.set(rand(-0.5, 0.5), rand(-0.5, 0.2), rand(-0.5, 0.5)).multiplyScalar(len * 0.4));
        _bw.set(at.x + _bv.x, at.y + _bv.y, at.z + _bv.z);
        jag(br.sub, at, _bw, 0.25, 3);
      }
    }
  }
}
const _bv = new THREE.Vector3();
const _bw = new THREE.Vector3();
const _bx = new THREE.Vector3();

// ------------------------------------------------------------- heat haze ----

/**
 * Heat shimmer: sprites that write a screen-space offset into a small target,
 * then one full-screen pass that reads the frame through it. Runs only while
 * something hot is in the air; otherwise `enabled` is false and it costs
 * nothing.
 *
 * The pass runs on the finished frame, so it would bend a painted shop sign
 * as readily as the wall behind it -- and text that swims is the one thing
 * that reads as a rendering fault rather than as heat. Every label sprite in
 * the scene is drawn into the offset target as a mask (its glyphs, dilated a
 * little) that zeroes the offset over it.
 */
const LABEL_MASK_VERT = `
  uniform vec2 uCenter;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 sc = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
    mv.xy += (position.xy - (uCenter - vec2(0.5))) * sc * 1.06;
    gl_Position = projectionMatrix * mv;
  }
`;
const LABEL_MASK_FRAG = `
  uniform sampler2D map;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    float m = 0.0;
    for (int i = -2; i <= 2; i++) for (int j = -1; j <= 1; j++) {
      m = max(m, texture2D(map, vUv + vec2(float(i), float(j) * 2.0) * uTexel * 5.0).a);
    }
    gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(m * 2.0, 0.0, 1.0));
  }
`;

class HeatPass extends Pass {
  constructor(camera, noise, world) {
    super();
    this.camera = camera;
    this.world = world;
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
      // Rising, fine-grained ripple, not a smear: two octaves of the noise
      // moving up at different speeds, differentiated into an offset.
      fragmentShader: `
        uniform sampler2D uNoise; uniform float uTime;
        varying float vA; varying float vSeed;
        float h(vec2 q) { return texture2D(uNoise, q).r * 0.6 + texture2D(uNoise, q * 2.7 + vec2(0.3, -uTime * 0.7)).r * 0.4; }
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(c, c);
          if (r2 > 1.0) discard;
          vec2 q = c * vec2(0.55, 0.3) + vec2(vSeed * 5.0, vSeed * 3.0 - uTime * 0.6);
          float e = 0.035;
          float nx = h(q) - h(q + vec2(e, 0.0));
          float ny = h(q) - h(q + vec2(0.0, e));
          float w = exp(-r2 * 3.0) * vA;
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
      uniforms: { tDiffuse: { value: null }, tHeat: { value: null }, uStrength: { value: 0.02 } },
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
    // Label masks: one sprite per label, sharing its texture; found when the
    // pass wakes, so labels made since are picked up.
    this.maskScene = new THREE.Scene();
    this.maskScene.matrixWorldAutoUpdate = false;
    this.masks = new Map();   // label sprite -> mask sprite
    this.maskMaterials = new Map();   // texture -> material
  }

  findLabels() {
    if (!this.world) return;
    const seen = new Set();
    this.world.traverse((o) => {
      if (!o.isSprite || !o.material || !o.material.map || o.material.toneMapped !== false || !o.material.map.image) return;
      seen.add(o);
      if (this.masks.has(o)) return;
      const tex = o.material.map;
      let m = this.maskMaterials.get(tex);
      if (!m) {
        m = new THREE.ShaderMaterial({
          vertexShader: LABEL_MASK_VERT,
          fragmentShader: LABEL_MASK_FRAG,
          uniforms: { map: { value: tex }, uCenter: { value: o.center }, uTexel: { value: new THREE.Vector2(1 / tex.image.width, 1 / tex.image.height) } },
          transparent: true, depthTest: false, depthWrite: false,
          blending: THREE.CustomBlending,
          blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
          blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        });
        this.maskMaterials.set(tex, m);
      }
      const mask = new THREE.Sprite(m);
      mask.matrixAutoUpdate = false;
      mask.frustumCulled = false;
      this.maskScene.add(mask);
      this.masks.set(o, mask);
    });
    for (const [label, mask] of this.masks) if (!seen.has(label)) { this.maskScene.remove(mask); this.masks.delete(label); }
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
    if (n > 0 && !this.enabled) this.findLabels();
    this.enabled = n > 0;
  }

  render(renderer, writeBuffer, readBuffer) {
    const old = renderer.getClearColor(_heatClear);
    const oldAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
    // Labels: undo the offset over each one that is showing.
    let any = false;
    for (const [label, mask] of this.masks) {
      let shown = label.visible;
      for (let o = label.parent; shown && o; o = o.parent) shown = o.visible;
      mask.visible = shown;
      if (shown) { mask.matrixWorld.copy(label.matrixWorld); any = true; }
    }
    if (any) renderer.render(this.maskScene, this.camera);
    renderer.setClearColor(old, oldAlpha);
    this.quad.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material.uniforms.tHeat.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}
const _heatClear = new THREE.Color();
const _down = new THREE.Vector3(0, -0.3, 0);

// ------------------------------------------------------------- the module ----

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/**
 * @param deps scene, camera, renderer, composer, game, actors (figures,
 *   motion.perform), audio (its context and the combat helpers), player (for
 *   shake), quality (for the preset), viewModel (fx.js's hands: `castPoint`).
 */
export function createSpellFx({ scene, camera, renderer, composer, game, actors, audio, player, quality, viewModel = null }) {
  const noise = noiseTexture(128);
  const shared = {
    uTime: { value: 0 },
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
      uRadius: { value: 0 }, uColor: { value: new THREE.Color() }, uSeed: { value: 0 }, uHeat: { value: 1 },
      uGain: shared.uGain, uFogDensity: shared.uFogDensity,
    },
    transparent: true,
    depthWrite: false,
    // Premultiplied: the glowing modes write no alpha and so add, the marks
    // left on the ground write cover and darken what is under them.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const decals = [];
  for (let i = 0; i < 18; i++) {
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
    let d = decals.find((x) => !x.busy);
    // Full: a mark left on the ground gives way first -- it is the one thing
    // here that is only lingering.
    if (!d) {
      d = decals.reduce((best, x) => (x.mesh.material.uniforms.uMode.value >= 3 && (!best || x.life - x.t < best.life - best.t) ? x : best), null);
      if (!d || mode >= 3) return null;
    }
    d.busy = true; d.t = 0; d.life = life; d.drive = drive; d.anchorFn = null;
    d.mesh.position.set(p.x, p.y + 0.04, p.z);
    d.mesh.scale.setScalar(r);
    d.mesh.rotation.y = rand(0, TAU);
    const u = d.mesh.material.uniforms;
    u.uMode.value = mode; u.uColor.value.copy(color); u.uOpen.value = 0; u.uAlpha.value = 0; u.uRadius.value = 0;
    u.uSeed.value = rand(0, 40); u.uHeat.value = 1;
    d.mesh.visible = true;
    return d;
  }

  /**
   * What a spell leaves on the ground where it struck -- a scorch (3), a
   * lightning burn (4), rime (5), an acid stain (6), a crack (7). It cools
   * over `cool` seconds and fades out over the last third of `life`.
   */
  function mark(p, r, mode, color, life = 7, cool = 1.6) {
    // A scorch still glowing lights the ground round it for a while -- the
    // light that stays after the flash. (Borrowed from the pool, so a new
    // spell takes it back.)
    // Taken once the blast's own light has had its moment.
    if (mode === 3 && cool > 1) {
      const at = new THREE.Vector3(p.x, p.y + 0.35, p.z);
      const t0 = clock;
      const hold = cool - 0.7;
      effects.push({ kind: 'custom', update() {
        if (clock - t0 < 0.7) return true;
        takeLight(0xff6a24, (t) => (t < hold ? { p: at, intensity: 7 * r * (1 - t / hold) * (0.85 + 0.15 * Math.sin(t * 23) * Math.sin(t * 7)), distance: 3 + r * 2 } : null));
        return false;
      } });
    }
    return decal(p, r, mode, color, life, (d, u, t) => {
      u.uAlpha.value = Math.min(1, t / 0.06) * (1 - smooth((t - life * 0.66) / (life * 0.34)));
      u.uHeat.value = Math.max(0, 1 - t / cool);
    });
  }

  // -- fire spheres ---------------------------------------------------------
  const sphereGeometry = new THREE.IcosahedronGeometry(1, 3);
  const fireBase = new THREE.ShaderMaterial({
    vertexShader: FIRE_VERT,
    fragmentShader: FIRE_FRAG,
    uniforms: {
      uTime: { value: 0 }, uHeat: { value: 1 }, uAlpha: { value: 1 }, uSeed: { value: 0 }, uBillow: { value: 0.12 },
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
      // Everything is lit already: take the one that has been lit longest.
      slot = usable.reduce((a, b) => ((a.t ?? 0) >= (b.t ?? 0) ? a : b), usable[0]);
      if (!slot) return;
    }
    slot.busy = true; slot.t = 0; slot.fn = fn; slot.light.color.setHex(color);
  }

  // -- heat -----------------------------------------------------------------
  const heat = new HeatPass(camera, noise, scene);
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
  edge.style.cssText = 'position:absolute;inset:0;transition:opacity 600ms ease;opacity:0;';
  // Its own layer so sanctuary can breathe without fighting the fade above.
  const edgeGlow = document.createElement('div');
  edgeGlow.style.cssText = 'position:absolute;inset:0;';
  edge.appendChild(edgeGlow);
  const wash = document.createElement('div');
  wash.style.cssText = 'position:absolute;inset:0;opacity:0;mix-blend-mode:screen;';
  overlay.append(edge, wash);
  const breatheFrames = [{ opacity: 0.55 }, { opacity: 1 }];
  let breathing = null;
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
      // Your own hand, where the view model has it -- so a bolt leaves the
      // fist you can see thrusting out, not a point in the middle of the air.
      if (viewModel && viewModel.castPoint) return viewModel.castPoint(out);
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

  /** Where a spell leaves from: a breath from the mouth, anything else the hand. */
  const sourcePoint = (fx, out) => (fx.source === 'breath' ? mouthPoint(fx.from, out) : handPoint(fx.from, out));

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
      case 'hit': {
        // Sanctuary halves it; show where. (A blow that did nothing is a 'miss'.)
        // The rules resolve a round on one pulse; the blow is seen `delay` later.
        const land = () => {
          if (e.to) absorbed(e.to);
          else if (e.from && (game.state.affectedBy & AFF.SANCTUARY)) {
            flashScreen('radial-gradient(ellipse closest-side at 50% 50%, rgba(255,240,200,0) 40%, rgba(255,236,190,0.8) 100%)', 0.6, 520);
          }
        };
        if (e.delay > 0.02) { const t0 = clock + e.delay; effects.push({ kind: 'custom', update() { if (clock < t0) return true; land(); return false; } }); }
        else land();
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
    sourcePoint(fx, fx.hand);
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
        life: rand(0.35, 0.55), size: rand(0.025, 0.05), color: palette.gather || (palette.gather = palette.glow.clone().multiplyScalar(1.6)), color2: palette.core || palette.mote || palette.glow,
        shape: 1, fadeIn: 0.3,
      });
    }
    // The growing heart of it: one sprite a frame, short-lived, so it follows the hand.
    const coreSize = (fx.from.player ? 0.06 : 0.09) + u * (fx.from.player ? 0.1 : 0.16);
    light.spawn({ x: 0, y: 0, z: 0, anchor: fx.anchor, life: 0.05, size: coreSize * 2.6, color: palette.glow, alpha: 0.5 + u * 0.5, shape: 0, drag: 0, fadeIn: 0 });
    light.spawn({ x: 0, y: 0, z: 0, anchor: fx.anchor, life: 0.05, size: coreSize * 0.8, color: (palette.core || palette.mote || palette.glow), alpha: 0.35 + u * 0.4, shape: 1, drag: 0, fadeIn: 0 });
  }

  /**
   * What stands between the hand and the target. The hand is off to the
   * side of the eye (yours 0.2 m right), so a target you can see can still
   * be behind a plinth's corner from the fist -- and a ball flown in a
   * straight line from it went through the stone. When only the hand's line
   * is blocked the flight bends out through a point on the eye's line
   * (`via`); when the eye's is blocked too it truly is in the way, and the
   * thing bursts where the line meets it (`wall`), not on the body.
   */
  const flightCounts = { clear: 0, via: 0, wall: 0 };
  function lineOfFlight(fx, src) {
    const nav = actors && actors.nav;
    if (!nav || !nav.sightBlocked || !fx.to || fx.to.player || fx.to === fx.from) return;
    const a = fx.aim;
    const blocked = (p, q) => nav.sightBlocked(p.x, p.y, p.z, q.x, q.y, q.z);
    if (!blocked(src, a)) { flightCounts.clear++; return; }
    const eye = fx.from.player ? camera.position : mouthPoint(fx.from, new THREE.Vector3());
    if (!blocked(eye, a)) {
      const d = eye.distanceTo(a);
      const via = new THREE.Vector3().lerpVectors(eye, a, Math.min(0.45, 1.6 / Math.max(1e-3, d)));
      if (!blocked(src, via)) { fx.data.via = via; flightCounts.via++; return; }
    }
    // Bisect for where the hand's line first meets something.
    let lo = 0; let hi = 1;
    const p = new THREE.Vector3();
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      p.lerpVectors(src, a, mid);
      if (blocked(src, p)) hi = mid; else lo = mid;
    }
    fx.data.wall = new THREE.Vector3().lerpVectors(src, a, Math.max(0, lo - 0.02));
    flightCounts.wall++;
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
        fx.data.bolts.push({
          delay: i * 0.055, bend: side, bend2, trail: P3(TRAIL), n: 0, hit: false, head: new THREE.Vector3(),
          across, weave: rand(0.07, 0.13) * (Math.random() < 0.5 ? -1 : 1), phase: rand(0, TAU),
        });
      }
      S.missile(src);
      takeLight(PAL.missile.light, (t) => (t < fx.flight + 0.15 && !fx.done ? { p: fx.data.head || src, intensity: 7, distance: 9 } : null));
    } else if ((f === 'fireball') && fx.to) {
      lineOfFlight(fx, src);
      fx.data.ball = sphere();
      S.roar(src, fx.flight + 0.2);
      takeLight(PAL.fire.light, (t) => (fx.data.ballPos && !fx.landed ? { p: fx.data.ballPos, intensity: 24, distance: 13 } : null));
    } else if ((f === 'lightning' || f === 'breath-lightning') && fx.to) {
      S.crack(src, 1);
      fx.data.strike = { bolt: new Bolt(f === 'breath-lightning' ? 9 : 6), stroke: -1, env: 1, jag: 0.2 };
      fx.data.boltLife = Math.max(0.42, fx.flight + 0.34);
      // The room lit in time with the strokes, not a steady lamp.
      takeLight(PAL.lightning.light, (t) => (t < fx.data.boltLife ? { p: fx.data.strike.bolt.main[32], intensity: 75 * fx.data.strike.env, distance: 22 } : null));
    } else if (f === 'shock') {
      S.crack(src, 0.5);
    } else if (f === 'frost') {
      S.frost(src);
    } else if (f === 'acid') {
      S.hiss(src, 0.6);
    } else if (f === 'prism' && fx.to) {
      S.prism(src);
      // The fan: rays in a cone about the line to the target, wide enough
      // to wash over a body at the far end, each with its own place in the
      // spectrum and its own shimmer.
      const d0 = _w.subVectors(fx.aim, src);
      const len = d0.length(); d0.normalize();
      const cone = Math.max(0.12, Math.min(0.3, 1.0 / Math.max(1, len)));
      const u0 = new THREE.Vector3(-d0.z, 0, d0.x).normalize();
      const v0 = new THREE.Vector3().crossVectors(u0, d0);
      fx.data.fan = Array.from({ length: n(13) }, (_, k) => {
        const a = rand(0, TAU); const r = Math.sqrt(Math.random()) * cone;
        const dir = d0.clone().addScaledVector(u0, Math.cos(a) * r).addScaledVector(v0, Math.sin(a) * r * 0.7).normalize();
        return { dir, len: len * rand(0.95, 1.25), hue: k / 13 + rand(-0.03, 0.03), phase: rand(0, TAU), pts: P3(7) };
      });
      takeLight(0xffffff, (t) => (t < 0.35 ? { p: src, intensity: 14 * (1 - t / 0.35), distance: 10 } : null));
    } else if ((f === 'flame' || f === 'breath-fire' || f === 'breath-frost' || f === 'breath-acid') && fx.to) {
      const big = f !== 'flame';
      if (f === 'breath-frost') S.frost(src);
      else if (f === 'breath-acid') S.hiss(src, 1.2);
      S.roar(src, big ? 1.1 : 0.6);
      // The stream outlives the landing: a breath pours on after it hits.
      fx.data.stream = fx.flight + (big ? 0.55 : 0.3);
      fx.data.tongues = Array.from({ length: big ? 6 : 4 }, () => ({ pts: P3(10), phase: rand(0, TAU), ang: rand(0, TAU), wob: rand(0.6, 1.2) }));
      fx.data.firePos = new THREE.Vector3().copy(src);
      takeLight(STREAMS[f].light, (t) => (t < fx.data.stream + 0.2 ? { p: fx.data.firePos, intensity: (big ? 34 : 16) * STREAMS[f].lit * Math.min(1, t / 0.08) * (1 - smooth((t - fx.data.stream) / 0.2)) * (0.8 + 0.2 * Math.random()), distance: big ? 14 : 10 } : null));
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
        for (let i = 0; i < bolts.length; i++) {
          const b = bolts[i];
          const span = Math.max(0.08, fx.flight - (bolts.length - 1) * 0.045);
          const bu = clamp((tf - b.delay) / span, 0, 1);
          if (tf < b.delay || b.hit) continue;
          // A cubic from the hand, bowing out to one side, into the chest --
          // and weaving across it as it goes, which is what makes a bolt
          // dart rather than glide. The weave dies at both ends.
          // Yours bow far less and lead forward: the first control point is
          // what the bolt heads for as it leaves, and a pure sideways bow of
          // 1.6 m half a metre from the lens took it out of the frame at the
          // top right and back in -- a beam out of the sky, not out of the hand.
          const p1 = fx.from.player
            ? tmpA.lerpVectors(src, aim, 0.3).addScaledVector(b.bend, Math.min(1, dist * 0.12))
            : tmpA.copy(src).addScaledVector(b.bend, Math.min(3, dist * 0.35));
          const p2 = tmpB.copy(aim).addScaledVector(b.bend2, Math.min(2, dist * 0.25));
          const s = 1 - bu;
          const head = b.head.set(
            s * s * s * src.x + 3 * s * s * bu * p1.x + 3 * s * bu * bu * p2.x + bu * bu * bu * aim.x,
            s * s * s * src.y + 3 * s * s * bu * p1.y + 3 * s * bu * bu * p2.y + bu * bu * bu * aim.y,
            s * s * s * src.z + 3 * s * s * bu * p1.z + 3 * s * bu * bu * p2.z + bu * bu * bu * aim.z,
          );
          const wv = Math.sin(bu * TAU * 1.6 + b.phase) * b.weave * Math.sin(Math.PI * bu) * Math.min(1, dist / 4);
          head.addScaledVector(b.across, wv);
          head.y += Math.cos(bu * TAU * 1.3 + b.phase) * Math.abs(b.weave) * 0.6 * Math.sin(Math.PI * bu);
          // The trail: a ring of the last few positions, newest first.
          const tr = b.trail;
          b.n = Math.min(TRAIL, b.n + 1);
          for (let k = b.n - 1; k > 0; k--) { tr[k].x = tr[k - 1].x; tr[k].y = tr[k - 1].y; tr[k].z = tr[k - 1].z; }
          tr[0].x = head.x; tr[0].y = head.y; tr[0].z = head.z;
          if (i === 0) fx.data.head = head;
          const pulse = 0.85 + 0.15 * Math.sin(clock * 60 + i * 2);
          glowAt(light, head, PAL.missile.glow, 0.5 * pulse, 0.04, 1, 0, 0.45);
          glowAt(light, head, PAL.missile.core, 0.16, 0.04, 1, 1);
          if (Math.random() < 0.9 * budget.density) {
            light.spawn({ x: head.x, y: head.y, z: head.z, vx: rand(-0.5, 0.5), vy: rand(-0.3, 0.6), vz: rand(-0.5, 0.5), life: rand(0.25, 0.5), size: rand(0.05, 0.09), color: PAL.missile.trail, color2: PAL.missile.glow, shape: 7, drag: 2.5 });
          }
          if (bu >= 1) {
            b.hit = true;
            burst(light, head, 18, { speed: [1.5, 4.5], life: [0.15, 0.35], size: [0.025, 0.05], color: PAL.missile.core, color2: PAL.missile.trail, drag: 4, shape: 1 });
            burst(light, head, 6, { speed: [0.4, 1.2], life: [0.3, 0.55], size: [0.06, 0.1], color: PAL.missile.core, color2: PAL.missile.glow, drag: 3, shape: 7 });
            glowAt(light, head, PAL.missile.glow, 1.0, 0.18, 1, 0, 0.3);
            glowAt(light, head, PAL.missile.core, 0.35, 0.07, 1, 1);
            S.pop(head, 1.4);
            // Each bolt jolts the body as it arrives: a volley reads as a volley.
            const fig = figureOf(fx.to.slot);
            if (fig && actors.motion && !fx.to.player) actors.motion.react(fig, 'hit', 0.5);
          }
        }
        break;
      }
      case 'fireball': {
        if (!fx.to) break;
        const pos = fx.data.ballPos || (fx.data.ballPos = new THREE.Vector3());
        // At you, it bursts at arm's length (see impact), so it flies there.
        const end = fx.to.player ? camera.getWorldDirection(_w).multiplyScalar(2.6).add(camera.position).add({ x: 0, y: -0.35, z: 0 }) : (fx.data.wall || aim);
        if (fx.data.via && !fx.data.wall) {
          // Out round the corner and on: a quadratic through the eye's line.
          const s1 = 1 - u; const v = fx.data.via;
          pos.set(s1 * s1 * src.x + 2 * s1 * u * v.x + u * u * end.x, s1 * s1 * src.y + 2 * s1 * u * v.y + u * u * end.y, s1 * s1 * src.z + 2 * s1 * u * v.z + u * u * end.z);
        } else {
          pos.lerpVectors(src, end, u);
          // The lob only where it cannot carry the ball into what stopped it.
          if (!fx.data.wall) pos.y += Math.sin(Math.PI * u) * Math.min(1.2, dist * 0.08);
        }
        const ball = fx.data.ball;
        // Out of your own hand it starts small and swells as it leaves, or
        // the first frames are a ball of fire filling the view.
        const near = fx.from.player ? clamp(distToCamera(pos) / 3, 0.3, 1) : 1;
        const r = (fx.from.player ? 0.2 : 0.26) * (0.6 + 0.4 * Math.min(1, tf / 0.12)) * near;
        if (ball) {
          ball.mesh.position.copy(pos);
          ball.mesh.scale.setScalar(r);
          ball.mesh.material.uniforms.uTime.value = clock;
          ball.mesh.material.uniforms.uHeat.value = 1;
          ball.mesh.material.uniforms.uAlpha.value = 1;
        }
        glowAt(light, pos, PAL.fire.glow, r * 3.4, 0.04, 0.55);
        glowAt(light, pos, PAL.fire.core, r * 1.2, 0.04, 0.8, 1);
        // Flame shed behind it, embers, and smoke that lingers where it passed.
        const dir = _v.subVectors(aim, src).normalize();
        for (let k = 0; k < n(5); k++) {
          light.spawn({
            x: pos.x + rand(-0.08, 0.08), y: pos.y + rand(-0.08, 0.08), z: pos.z + rand(-0.08, 0.08),
            vx: -dir.x * rand(0.5, 2) + rand(-0.4, 0.4), vy: rand(0.2, 0.9), vz: -dir.z * rand(0.5, 2) + rand(-0.4, 0.4),
            life: rand(0.22, 0.42), size: rand(0.16, 0.3) * near, grow: 1.8, color: FIRE_TRAIL, color2: PAL.fire.dark,
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
      case 'acid': {
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
      case 'frost': {
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
        if (!fx.to || !fx.data.fan) break;
        // Glints hanging in the fan, each the colour of the ray it is on, and
        // a white flare at the hand that the rays pour out of.
        for (let k = 0; k < n(5); k++) {
          const ray = fx.data.fan[Math.floor(rand(0, fx.data.fan.length))];
          const along = rand(0.1, 1) * ray.len * smooth(u * 1.4);
          spectral(ray.hue + along * 0.08 + clock * 1.3, 2.6);
          light.spawn({ x: src.x + ray.dir.x * along, y: src.y + ray.dir.y * along, z: src.z + ray.dir.z * along, vx: ray.dir.x * 1.5, vy: rand(-0.2, 0.4), vz: ray.dir.z * 1.5, life: rand(0.2, 0.45), size: rand(0.06, 0.13), color: _spec, shape: 7, drag: 3, occ: 0.2 });
        }
        glowAt(light, src, WHITE_HOT, fx.from.player ? 0.14 : 0.26, 0.04, 1, 1);
        glowAt(light, src, C_PRISM_FLARE, fx.from.player ? 0.4 : 0.8, 0.04, 0.7, 0, 0.2);
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

  /**
   * A stream of fire out of a hand or a mouth: flame tongues that widen and
   * cool from white-yellow at the lips to red at the far end, embers thrown
   * through it, smoke rolling off its end, and the air bending over it. It
   * is built to read from any side -- end-on the tongues fan out radially
   * and the smoke rims it -- because a breath is most often aimed at you.
   */
  function stream(fx, dt) {
    const K = STREAMS[fx.family];
    const big = fx.family !== 'flame';
    const tf = fx.t - fx.releaseT;
    const src = fx.data.src;
    sourcePoint(fx, src);
    // At you, the cone opens wider and stops short of your face, so it
    // pours past the edges of the frame instead of arriving as one sprite
    // pressed to the lens (which the size cap would fade to nothing).
    const atYou = fx.to.player;
    const aim = atYou ? camera.getWorldDirection(fx.aim).multiplyScalar(1.1).add(camera.position).add(_down) : chestPoint(fx.to, fx.aim, true);
    const dir = _v.subVectors(aim, src);
    const len = Math.max(0.5, dir.length()); dir.normalize();
    const tail = 1 - smooth((tf - (fx.data.stream - 0.2)) / 0.2);
    const reach = smooth(tf / Math.max(0.1, fx.flight));
    // Across the cone: two directions square to it.
    const ax = _w.set(-dir.z, 0, dir.x); if (ax.lengthSq() < 1e-4) ax.set(1, 0, 0); ax.normalize();
    const ay = tmpB.crossVectors(ax, dir);
    const spread = atYou ? 0.75 : big ? 0.3 : 0.2;
    const speed = Math.max(5, len / Math.max(0.15, fx.flight) * 1.1);
    fx.data.firePos.copy(src).addScaledVector(dir, len * 0.45 * reach);
    const floorY = feetPoint(fx.to, tmpA).y + 0.02;

    // The body of it: dense near the lips, so it is one stream and not a
    // string of beads, each puff growing and cooling as it goes.
    fx.data.acc = (fx.data.acc || 0) + dt * (big ? 280 : 170) * budget.density * tail;
    while (fx.data.acc >= 1) {
      fx.data.acc -= 1;
      const a = rand(0, TAU); const r = Math.sqrt(Math.random()) * spread;
      const cx = Math.cos(a) * r; const cy = Math.sin(a) * r;
      const sp = speed * rand(0.75, 1.1);
      const back = rand(0, sp / 60);   // spread along the frame's step, so there are no beads
      light.spawn({
        x: src.x + dir.x * back, y: src.y + dir.y * back, z: src.z + dir.z * back,
        vx: (dir.x + ax.x * cx + ay.x * cy) * sp, vy: (dir.y + ax.y * cx + ay.y * cy) * sp, vz: (dir.z + ax.z * cx + ay.z * cy) * sp,
        life: rand(0.75, 1.05) * (len / sp * 1.25 + (atYou ? 0.1 : 0.18)), size: rand(0.1, 0.2) * (big ? 1.35 : 1), grow: atYou ? 2.8 : big ? 4.5 : 3.6,
        color: K.hot, color2: K.cool, alpha: K.alpha, shape: K.shape, drag: 1.3, gravity: K.lift * (atYou ? 0.35 : 1), fadeIn: 0.03, occ: K.occ, hold: 0.45,
      });
    }
    // What is flung through it -- embers, ice, drops -- and what is left
    // hanging off its end: smoke, freezing mist, fumes.
    if (Math.random() < (big ? 1.4 : 0.6) * budget.density * tail) {
      const sp = speed * rand(0.9, 1.3);
      light.spawn({ x: src.x, y: src.y, z: src.z, vx: (dir.x + rand(-spread, spread)) * sp, vy: (dir.y + rand(-0.1, spread)) * sp, vz: (dir.z + rand(-spread, spread)) * sp, life: rand(0.5, 1.0), size: K.bitSize * rand(0.7, 1.3), color: K.bit, color2: K.bit2, shape: K.bitShape, drag: 1.4, gravity: K.bitFall, floor: floorY, occ: K.bitOcc });
    }
    if (Math.random() < (big ? 0.6 : 0.3) * budget.density * tail * reach) {
      const at = rand(0.55, 1) * len * reach;
      matter.spawn({ x: src.x + dir.x * at + rand(-0.3, 0.3), y: src.y + dir.y * at + rand(0, 0.3), z: src.z + dir.z * at + rand(-0.3, 0.3), vx: dir.x * 1.2, vy: rand(0.2, 0.8) * K.smokeRise, vz: dir.z * 1.2, life: rand(1.2, 2.0), size: rand(0.35, 0.55) * (big ? 1.3 : 1), grow: 2.6, color: K.smoke, color2: K.smoke2, alpha: K.smokeAlpha, shape: 3, drag: 1.2, gravity: -0.5 * K.smokeRise, fadeIn: 0.25, floor: floorY + 0.2 });
    }
    if (K.heat && budget.heat && Math.random() < 0.7) {
      const at = rand(0.2, 1) * len * reach;
      heat.add(src.x + dir.x * at, src.y + dir.y * at + 0.2, src.z + dir.z * at, big ? 1.5 : 1.0, 0.5, 0.8);
    }
    // The lips of it: hottest where it leaves.
    glowAt(light, src, K.lip, big ? 0.34 : 0.2, 0.04, tail, 1);
    glowAt(light, src, K.glow, big ? 1.3 : 0.7, 0.04, 0.8 * tail, 0, 0.3);

    // Tongues: wavy strips along the cone, each on its own side of it.
    const T = fx.data.tongues;
    tongue.c0 = K.tongue0; tongue.c1 = K.tongue1;
    for (let k = 0; k < T.length; k++) {
      const tg = T[k];
      const ca = Math.cos(tg.ang + tf * 2.5 * tg.wob); const sa = Math.sin(tg.ang + tf * 2.5 * tg.wob);
      for (let j = 0; j < 10; j++) {
        const u = j / 9;
        const along = u * len * reach * 1.05;
        const out = u * len * spread * 0.8 * (0.7 + 0.3 * Math.sin(u * 7 + clock * 13 * tg.wob + tg.phase));
        const q = tg.pts[j];
        q.x = src.x + dir.x * along + (ax.x * ca + ay.x * sa) * out;
        q.y = src.y + dir.y * along + (ax.y * ca + ay.y * sa) * out + u * u * 0.25 * K.lift / -2;
        q.z = src.z + dir.z * along + (ax.z * ca + ay.z * sa) * out;
      }
      tongue.a = tail * K.tongueA * (0.7 + 0.3 * Math.sin(clock * 29 + tg.phase)); tongue.big = big ? 1.4 : 1;
      glow.strip(tg.pts, tongueWidth, tongueColour, tongueAlpha, 0);
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
        glowAt(light, aim, PAL.missile.glow, 1.1 * scale, 0.25, 1, 0, 0.3);
        if (onYou) flashScreen('radial-gradient(ellipse at 50% 60%, rgba(170,140,255,0.55) 0%, rgba(90,60,200,0) 70%)', 0.7, 360);
        break;
      }
      case 'fireball': {
        freeSphere(fx.data.ball); fx.data.ball = null;
        // On you it goes off at arm's length and a size that leaves the frame
        // readable: the wash at the edges says the rest.
        if (onYou) { camera.getWorldDirection(_v); aim.copy(camera.position).addScaledVector(_v, 2.6); aim.y -= 0.35; }
        if (fx.data.wall) {
          // Stopped by what was in the way: it goes off there, on the ground below it.
          explode(fx.data.wall, feet.set(fx.data.wall.x, feet.y, fx.data.wall.z), fx.saved ? 0.8 : 1);
          break;
        }
        explode(aim, feet, onYou ? 0.35 : (fx.saved ? 0.8 : 1));
        if (hitAny) hurtFigure(target, 1.4);
        if (onYou) flashScreen('radial-gradient(ellipse at 50% 50%, rgba(255,170,80,0) 25%, rgba(255,120,30,0.6) 72%, rgba(140,30,0,0.8) 100%)', 0.85, 700);
        break;
      }
      case 'flame': case 'breath-fire': case 'flamestrike': {
        const big = f !== 'flame';
        burst(light, aim, big ? 40 : 22, { speed: [1, big ? 4 : 2.5], up: 0.3, life: [0.35, 0.7], size: [0.18, 0.34], grow: 2.4, color: FIRE_BURST, color2: PAL.fire.dark, drag: 2.6, gravity: -2, shape: 4, fadeIn: 0.05 });
        burst(light, aim, big ? 30 : 16, { speed: [2, 6], life: [0.4, 0.9], size: [0.02, 0.035], color: PAL.fire.ember, color2: PAL.fire.dark, drag: 1, gravity: 6, shape: 1, floor: feet.y + 0.02 });
        burst(matter, aim, big ? 14 : 8, { speed: [0.3, 1], up: 0.8, life: [1.2, 2], size: [0.4, 0.7], grow: 2.2, color: C(0.16, 0.14, 0.13), alpha: 0.45, drag: 1.4, gravity: -0.45, shape: 3, fadeIn: 0.2 });
        mark(feet, f === 'flame' ? 0.9 : 1.5, 3, PAL.fire.glow, f === 'flame' ? 6 : 9, 2.5);
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
        fx.data.strikes = strikes.filter(Boolean).map((w) => ({ w, until: fx.t + (f === 'shock' ? 0.45 : f === 'storm' ? 0.55 : 0.3), path: null, next: 0 }));
        for (const s of fx.data.strikes) {
          const p = chestPoint(s.w, new THREE.Vector3());
          if (f !== 'shock') {
            // It went to ground through them: a burn star at their feet, and
            // the ground lit for a moment round it.
            const ft = feetPoint(s.w, new THREE.Vector3());
            mark(ft, f === 'storm' ? 1.7 : 1.25, 4, PAL.lightning.glow, 6, 0.5);
            decal(ft, f === 'storm' ? 4 : 2.6, 2, BOLT_MID, 0.3, (d, u, t) => { u.uAlpha.value = 0.45 * Math.pow(1 - t / 0.3, 2) * (0.7 + 0.3 * Math.random()); });
          }
          burst(light, p, 26, { speed: [2, 7], life: [0.1, 0.3], size: [0.015, 0.035], color: PAL.lightning.core, color2: PAL.lightning.glow, drag: 3, shape: 1 });
          glowAt(light, p, PAL.lightning.glow, 1.4 * scale, 0.22, 1);
          hurtFigure(s.w, 1.1);
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
        burst(light, aim, 18, { speed: [0.2, 0.9], life: [1.4, 2.2], size: [0.3, 0.5], grow: 1.8, color: PAL.frost.mist, alpha: 0.18, drag: 1.5, gravity: 0.15, shape: 3, fadeIn: 0.15, floor: feet.y + 0.1, occ: 0.5 });
        glowAt(light, aim, PAL.frost.glow, 1.3 * scale, 0.35, 0.8, 0, 0.3);
        decal(feet, 1.1, 2, PAL.frost.glow.clone().multiplyScalar(0.7), 2.2, (d, u, t) => { u.uAlpha.value = Math.min(1, t / 0.1) * (1 - t / 2.2); });
        mark(feet, f === 'breath-frost' ? 1.6 : 1.0, 5, PAL.frost.rime, 7, 1.2);
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
        mark(feet, f === 'breath-acid' ? 1.5 : 1.0, 6, PAL.acid.glow, 7, 3);
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
        auraPulse(w, palette.glow, strong ? 0.45 : 1.2, strong ? 2.2 : 1.3, strong ? 1 : 0);
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
        if (w.player) flashScreen(strong ? 'radial-gradient(ellipse closest-side at 50% 50%, rgba(255,244,214,0) 30%, rgba(255,240,205,0.9) 100%)' : 'radial-gradient(ellipse at 50% 50%, rgba(180,200,255,0) 45%, rgba(170,195,255,0.6) 100%)', 0.7, 900);
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
        // The ground heaves out from the caster: a front of dust and thrown
        // grit running outward at ten metres a second, the paving split
        // behind it. Dust is lit matter, so it is kept pale enough to show
        // against a dark street at night (see setDaylight).
        const c = feetPoint(fx.from, new THREE.Vector3());
        const t0 = clock;
        let acc = 0;
        effects.push({ kind: 'custom', update() {
          const t = clock - t0;
          if (t > 1.2) return false;
          const last = this.last || 0; this.last = t;
          const front = 1 + t * 9;
          acc += (t - last) * 220 * budget.density * (1 - t / 1.2);
          while (acc >= 1) {
            acc -= 1;
            const a = rand(0, TAU); const r = front + rand(-0.6, 0.4);
            const x = c.x + Math.cos(a) * r; const z = c.z + Math.sin(a) * r;
            if (Math.random() < 0.6) {
              matter.spawn({ x, y: c.y + 0.15, z, vx: Math.cos(a) * rand(0.8, 2), vy: rand(0.6, 1.6), vz: Math.sin(a) * rand(0.8, 2), life: rand(1.6, 2.8), size: rand(0.5, 1.0), grow: 2.4, color: PAL.dust.smoke, alpha: 0.5, drag: 1.3, gravity: 0.25, shape: 3, fadeIn: 0.12 });
            } else {
              matter.spawn({ x, y: c.y + 0.05, z, vx: Math.cos(a) * rand(0.3, 1.2), vy: rand(2, 4.5), vz: Math.sin(a) * rand(0.3, 1.2), life: rand(0.7, 1.2), size: rand(0.05, 0.1), color: PAL.dust.grit, alpha: 1, drag: 0.3, gravity: 9.8, shape: 6, fadeIn: 0, floor: c.y + 0.03 });
            }
          }
          return true;
        } });
        mark(c, 6, 7, PAL.dust.smoke, 7, 1);
        decal(c, 11, 1, C(0.5, 0.42, 0.3), 1.2, (d, u, t) => { u.uRadius.value = smooth(t / 1.1); u.uAlpha.value = 0.7 * (1 - t / 1.2); });
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
        const u = t / 0.5;
        if (u >= 1) { freeSphere(s); s.mesh.material.uniforms.uBillow.value = 0.12; return false; }
        s.mesh.position.copy(p);
        s.mesh.scale.setScalar(R * (0.25 + 0.75 * (1 - Math.pow(1 - Math.min(1, t / 0.18), 3))));
        const m = s.mesh.material.uniforms;
        m.uTime.value = clock; m.uHeat.value = 1 - u; m.uAlpha.value = 1 - u * u; m.uBillow.value = 0.16 + 0.14 * u;
        return true;
      } };
      effects.push({ kind: 'custom', ...fx });
    }
    // The flash: white-hot and gone in a tenth of a second -- the
    // anticipation's payoff -- then the body of it.
    // No broad soft glow over it: one smooth gradient laid over the ball
    // is exactly what turned it into a peach-coloured egg. The light does
    // the lighting.
    glowAt(light, p, WHITE_HOT, R * 0.7, 0.08, 1, 1);
    glowAt(light, p, PAL.fire.glow, R * 1.1, 0.12, 0.35, 0);
    // Hot at the heart, going orange and then a dull red as each tongue cools.
    burst(light, p, 34, { speed: [3, 7], life: [0.3, 0.6], size: [0.16, 0.3].map((x) => x * size), grow: 2.4, color: C(2.2, 0.85, 0.14), color2: PAL.fire.glow, drag: 4.5, gravity: -1.2, shape: 4, fadeIn: 0.02, occ: 0.6 });
    burst(light, p, 40, { speed: [1.5, 5], life: [0.55, 1.05], size: [0.25, 0.5].map((x) => x * size), grow: 2.2, color: C(1.6, 0.45, 0.06), color2: PAL.fire.dark, drag: 3.2, gravity: -1.8, shape: 4, fadeIn: 0.06, occ: 0.6 });
    burst(light, p, 60, { speed: [4, 11], life: [0.5, 1.2], size: [0.02, 0.04], color: PAL.fire.ember, color2: PAL.fire.dark, drag: 1.1, gravity: 7, shape: 1, floor: ground.y + 0.02 });
    burst(matter, p, 24, { speed: [0.5, 2.0], up: 0.5, life: [1.8, 3.2], size: [0.5, 0.95].map((x) => x * size), grow: 2.4, color: C(0.11, 0.1, 0.09), color2: C(0.26, 0.25, 0.24), alpha: 0.6, drag: 1.8, gravity: -0.6, shape: 3, fadeIn: 0.35 });
    if (p.y - ground.y < 2.5) mark(ground, 2.1 * size, 3, PAL.fire.glow, 10, 3);
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
    const pts = [0, 0.25, 0.5, 0.75, 1].map((k) => ({ x: feet.x, y: feet.y + k * 5.5, z: feet.z }));
    const tint = color.clone().multiplyScalar(0.35);
    const width = (u) => 1.1 * (1 - u * 0.3);
    let a = 0;
    const alpha = (u) => a * (1 - u) * (1 - u) * 0.9;
    effects.push({ kind: 'custom', update() {
      const t = clock - t0;
      if (t > life) return false;
      a = Math.sin(Math.PI * clamp(t / life, 0, 1));
      glow.strip(pts, width, tint, alpha, 0);
      return true;
    } });
  }

  // -- lasting auras -----------------------------------------------------------------

  const auras = new Map();   // figure -> { meshes, material, pulse }
  const AURA_KIND = [
    // flag or affect type, colour, intensity, thickness, flicker
    { test: (ch) => ch.affectedBy & AFF.SANCTUARY, color: PAL.sanctuary.glow, intensity: 0.3, thick: 0.012, flicker: 0.05, soft: 1 },
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
        uThick: { value: 0.03 }, uFlicker: { value: 0 }, uSoft: { value: 0 },
        uGain: shared.uGain, uFogDensity: shared.uFogDensity,
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
  }

  /** Shells over every mesh of a figure's body, sharing its skeleton. */
  function shellsFor(fig, material, renderOrder) {
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
      shell.renderOrder = renderOrder;
      shell.layers.set(OVERLAY_LAYER);
      shell.visible = false;
      o.parent.add(shell);
      meshes.push(shell);
    }
    return meshes;
  }

  /** The rim shell of a figure's affects. Built once. */
  function auraFor(fig) {
    let a = auras.get(fig);
    if (a) return a;
    const material = auraMaterial();
    a = { meshes: shellsFor(fig, material, 6), material, pulse: null, on: false };
    auras.set(fig, a);
    return a;
  }

  /** A shell flaring over a body for a moment: the landing of a ward, a frost rime. */
  function auraPulse(w, color, intensity, life, soft = 0) {
    if (w.player) return;
    const fig = figureOf(w.slot);
    if (!fig) return;
    const a = auraFor(fig);
    a.pulse = { color: color.clone(), intensity, life, t: 0, soft };
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
      if (kind) { u.uColor.value.copy(kind.color); u.uThick.value = kind.thick; u.uFlicker.value = kind.flicker; u.uSoft.value = kind.soft || 0; }
      if (a.pulse) {
        a.pulse.t += dt;
        const pu = a.pulse.t / a.pulse.life;
        if (pu >= 1) a.pulse = null;
        else {
          const k = Math.sin(Math.PI * Math.min(1, pu * 2.5)) * (1 - pu * 0.3);
          if (!kind || a.pulse.intensity * k > intensity) {
            u.uColor.value.copy(a.pulse.color);
            u.uThick.value = a.pulse.soft ? 0.012 : 0.03;
            u.uFlicker.value = 0.1;
            u.uSoft.value = a.pulse.soft;
            intensity = a.pulse.intensity * k;
          }
        }
      }
      u.uIntensity.value = intensity;
      u.uTime.value = time + (slot.proto.vnum % 17);
      const on = intensity > 0.01 && visible;
      if (on !== a.on) { for (const m of a.meshes) m.visible = on; a.on = on; }

      // Matter for the affects that are not a light: dark wisps of a curse,
      // sickly bubbles of poison, a haze over blind eyes.
      if (!ch || !visible) continue;
      const near = distToCamera(fig.at) < 28;
      if (!near) continue;
      const rate = dt * budget.density;
      const px = fig.at.x; const py = fig.at.y; const pz = fig.at.z; const h = fig.height;
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

  // -- sanctuary ------------------------------------------------------------
  // "A white aura around your body": a luminous mantle standing just off the
  // figure (HALO_FRAG), a ring of light on the ground it protects, and
  // motes rising through it, all breathing on one slow cycle. It swells in
  // when cast, flares when a blow is absorbed and dissolves when it ends.
  const sanct = new Map();   // figure -> { meshes, material, level, flare, on, was, ground, phase }
  const SANCT_COLOR = PAL.sanctuary.glow;
  const SANCT_BREATH = 1.0;  // rad/s: one breath every ~6 s
  const SANCT_RINGS = 4;     // ground rings at once; the decal pool is shared with every spell

  function sanctFor(fig) {
    let s = sanct.get(fig);
    if (s) return s;
    const material = new THREE.ShaderMaterial({
      vertexShader: AURA_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: {
        uColor: { value: SANCT_COLOR.clone() }, uIntensity: { value: 0 }, uTime: { value: 0 },
        uThick: { value: 0.1 }, uGain: shared.uGain, uFogDensity: shared.uFogDensity,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    s = { meshes: shellsFor(fig, material, 5), material, level: 0, flare: 0, on: false, was: false, ground: null, phase: rand(0, TAU) };
    sanct.set(fig, s);
    return s;
  }

  const sanctuaryOn = (slot) => { const ch = slot.instance; return !!(ch && !slot.dead && (ch.affectedBy & AFF.SANCTUARY)); };

  function updateSanctuary(dt) {
    const rate = dt * budget.density;
    let rings = 0;
    for (const s of sanct.values()) if (s.ground && s.ground.busy && s.ground.owner === s) rings++;
    for (const slot of game.mobs) {
      const fig = figureOf(slot);
      if (!fig) continue;
      const want = sanctuaryOn(slot) && fig.object.visible;
      let s = sanct.get(fig);
      if (!s) { if (!want) continue; s = sanctFor(fig); }
      s.level = want ? Math.min(1, s.level + dt / 0.6) : Math.max(0, s.level - dt / 1.6);
      s.flare = Math.max(0, s.flare - dt * 2.6);
      const px = fig.at.x; const py = fig.at.y; const pz = fig.at.z; const h = fig.height;
      const d = distToCamera(fig.at);
      // It lifts off in a last handful of motes: the line the mud prints
      // when it ends is "fades", and this is what fading looks like.
      if (s.was && !sanctuaryOn(slot)) {
        for (let k = 0; k < 12; k++) {
          const ang = rand(0, TAU);
          light.spawn({ x: px + Math.cos(ang) * 0.35, y: py + rand(0, h * 0.8), z: pz + Math.sin(ang) * 0.35, vx: Math.cos(ang) * 0.25, vy: rand(0.6, 1.2), vz: Math.sin(ang) * 0.25, life: rand(0.7, 1.2), size: rand(0.03, 0.05), color: PAL.sanctuary.mote, shape: 1, drag: 0.6, fadeIn: 0.1, occ: 0.25 });
        }
      }
      s.was = want;
      const on = s.level > 0.01 && d < 60;
      if (on !== s.on) { for (const m of s.meshes) m.visible = on; s.on = on; }
      if (!on) { if (s.ground) { s.ground.life = 0; s.ground = null; } continue; }
      const k = smooth(s.level);
      const breath = 0.5 + 0.5 * Math.sin(clock * SANCT_BREATH + s.phase);
      const u = s.material.uniforms;
      // A fixed 8 cm is two pixels at 20 m, so the mantle stands further out
      // the further away it is looked at -- what has to read is the figure's
      // outline in light, not a measured shell.
      u.uThick.value = clamp(0.07 + 0.012 * d, 0.07, 0.3) * (1 + 0.5 * s.flare);
      u.uIntensity.value = 0.2 * k * (0.8 + 0.2 * breath + 1.2 * s.flare);
      u.uTime.value = clock + (slot.proto.vnum % 17);
      if (d < 32 && !(s.ground && s.ground.busy && s.ground.owner === s) && rings < SANCT_RINGS) {
        const g = decal({ x: px, y: py, z: pz }, 1.25, 8, SANCT_COLOR, 1e9, (dec, du) => {
          dec.mesh.position.set(fig.at.x, fig.at.y + 0.04, fig.at.z);
          du.uAlpha.value = smooth(s.level) * (0.75 + 0.25 * Math.sin(clock * SANCT_BREATH + s.phase)) * (1 + 1.5 * s.flare) * 0.35;
          du.uHeat.value = 0.5 + 0.5 * Math.sin(clock * SANCT_BREATH + s.phase);
        });
        if (g) { g.owner = s; s.ground = g; rings++; }
      } else if (s.ground && d >= 36) { s.ground.life = 0; s.ground = null; rings--; }
      if (d < 28 && Math.random() < 8 * k * rate) {
        const a2 = rand(0, TAU);
        light.spawn({ x: px + Math.cos(a2) * 0.5, y: py + rand(0, h * 0.5), z: pz + Math.sin(a2) * 0.5, vx: 0, vy: rand(0.4, 0.8), vz: 0, life: rand(1.1, 1.7), size: rand(0.03, 0.05), color: PAL.sanctuary.mote, shape: 1, drag: 0.5, fadeIn: 0.3, occ: 0.25 });
      }
    }
  }

  /** Your own mantle, seen from inside: a few motes drifting up through the view. */
  function updateOwnMantle(dt) {
    if (!(game.state.affectedBy & AFF.SANCTUARY) || Math.random() >= 5 * dt * budget.density) return;
    camera.getWorldDirection(_v);
    const a2 = rand(0, TAU); const r = rand(1.2, 2.6);
    light.spawn({ x: camera.position.x + Math.cos(a2) * r + _v.x * 0.8, y: camera.position.y + rand(-1.1, 0.2), z: camera.position.z + Math.sin(a2) * r + _v.z * 0.8, vx: 0, vy: rand(0.3, 0.6), vz: 0, life: rand(1.5, 2.4), size: rand(0.025, 0.04), color: PAL.sanctuary.mote, shape: 1, drag: 0.5, fadeIn: 0.4, occ: 0.25 });
  }

  /** A blow that sanctuary took half of: the mantle flares where it landed. */
  function absorbed(slot) {
    const fig = figureOf(slot);
    const s = fig && sanct.get(fig);
    if (!s || s.level < 0.5 || !sanctuaryOn(slot)) return;
    s.flare = 1;
    const h = fig.height;
    for (let k = 0; k < 8; k++) {
      const a2 = rand(0, TAU);
      light.spawn({ x: fig.at.x + Math.cos(a2) * 0.3, y: fig.at.y + rand(0.3, h * 0.9), z: fig.at.z + Math.sin(a2) * 0.3, vx: Math.cos(a2) * 0.9, vy: rand(0.1, 0.7), vz: Math.sin(a2) * 0.9, life: rand(0.35, 0.6), size: rand(0.03, 0.05), color: PAL.sanctuary.mote, shape: 1, drag: 2, fadeIn: 0, occ: 0.2 });
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
    else if (bits & AFF.SANCTUARY) { css = 'radial-gradient(ellipse closest-side at 50% 50%, rgba(255,246,222,0) 55%, rgba(252,240,206,0.34) 85%, rgba(255,246,220,0.68) 100%)'; op = 1; }
    else if (bits & AFF.FAERIE_FIRE) { css = 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 60%, rgba(255,110,200,0.38) 100%)'; op = 1; }
    else if (bits & AFF.POISON) { css = 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(60,120,20,0.38) 100%)'; op = 1; }
    else if (bits & AFF.CURSE) { css = 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(40,10,55,0.4) 100%)'; op = 1; }
    // The glow breathes on the mantle's own cycle; it stops when it is gone.
    const sanctuary = !(bits & AFF.BLIND) && (bits & AFF.SANCTUARY);
    if (sanctuary && !breathing) breathing = edgeGlow.animate(breatheFrames, { duration: 3200, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
    else if (!sanctuary && breathing && !breathing.ending) {
      // Let the edge finish fading out (600 ms) before the breath stops under it.
      const b = breathing; b.ending = true;
      setTimeout(() => { b.cancel(); if (breathing === b) breathing = null; }, 700);
    }
    const key = css + op;
    if (key === edgeKey) return;
    edgeKey = key;
    if (css) edgeGlow.style.background = css;
    edge.style.opacity = String(op);
  }

  // -- lingering bits that follow bodies ---------------------------------------------
  const lingering = [];

  // -- the frame --------------------------------------------------------------------------

  let lastScale = 0;
  function update(dt) {
    clock += dt;
    shared.uTime.value = clock;
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
        sourcePoint(fx, fx.hand);
        anchors.set(fx.anchor, fx.hand);
        if (fx.lost) {
          if (fx.t < fx.windup) gather(fx, dt);
          else { fx.done = true; }
        } else if (fx.t < fx.windup) gather(fx, dt);
        else release(fx);
      }
      if (fx.released && !fx.fizzled && fx.data.stream && fx.to && fx.t - fx.releaseT < fx.data.stream) stream(fx, dt);
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
      d.mesh.material.uniforms.uTime.value = clock;
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
    updateSanctuary(dt);
    updateOwnMantle(dt);
    updateEdge();

    light.update(dt, anchors);
    matter.update(dt, anchors);
    glow.end();
    shade.end();
    heat.step(dt, clock);
  }

  /**
   * A lightning bolt from a to b, `tf` seconds into a life of `L`: a leader
   * that reaches across in two frames, then return strokes down the same
   * channel -- each a flash that dies in a few hundredths of a second, new
   * forks, and the last channel lingering on the eye in violet. `st` holds
   * the Bolt and which stroke it is on; `st.env` is left at the brightness,
   * for the light.
   */
  function drawBolt(st, a, b, tf, L, w = 1, reach = 2.2) {
    const bl = st.bolt;
    while (st.stroke + 1 < STROKES.length && tf >= STROKES[st.stroke + 1] && STROKES[st.stroke + 1] < L - 0.1) {
      st.stroke++;
      if (st.stroke === 0) bl.shape(a, b, st.jag);
      bl.strike(a, b, tf, reach);
    }
    let env = 0;
    for (let k = 0; k <= st.stroke; k++) env = Math.max(env, Math.exp(-(tf - STROKES[k]) / 0.035));
    const fade = 1 - smooth((tf - (L - 0.14)) / 0.14);
    const B = (0.2 + 0.8 * env) * fade * (0.85 + 0.15 * Math.random());
    st.env = B;
    const lead = clamp(tf / 0.035, 0, 1);
    const count = Math.max(2, Math.ceil(bl.main.length * lead));
    glow.strip(bl.main, 1.1 * w, PAL.lightning.glow, 0.24 * B, 0, count);
    glow.strip(bl.main, 0.2 * w, BOLT_MID, 0.7 * B, 0, count);
    glow.strip(bl.main, 0.045 * w, PAL.lightning.core, Math.min(1, 0.3 + B), 1, count);
    if (lead < 1) return;
    const since = tf - bl.ghostAt;
    if (st.stroke > 0 && since < 0.12) glow.strip(bl.ghost, 0.13 * w, BOLT_GHOST, 0.5 * (1 - since / 0.12) * fade, 0.3);
    const ba = Math.max(0, 1 - since / 0.09) * fade;
    if (ba <= 0) return;
    for (const br of bl.branches) {
      if (!br.on) continue;
      glow.strip(br.pts, (u) => 0.34 * w * (1 - u), PAL.lightning.glow, (u) => 0.38 * ba * (1 - u), 0);
      glow.strip(br.pts, (u) => 0.024 * w * (1 - 0.7 * u), PAL.lightning.core, (u) => ba * (1 - u * 0.8), 1);
      if (br.sub_on) glow.strip(br.sub, (u) => 0.016 * w * (1 - 0.7 * u), PAL.lightning.core, (u) => 0.8 * ba * (1 - u), 1);
    }
  }

  /** The polyline parts of an effect, rebuilt every frame. */
  function drawRibbons(fx) {
    const f = fx.family;
    // Lightning gathering: little arcs snapping about the hand.
    if (!fx.released && !fx.fizzled && CRACKLE.has(f)) {
      const u = clamp(fx.t / Math.max(0.05, fx.windup), 0, 1);
      if (u > 0.2 && Math.random() < 0.35 + 0.6 * u) {
        const arcs = fx.data.arcs || (fx.data.arcs = [P3(9), P3(9)]);
        const r = fx.from.player ? 0.06 : 0.14 + u * 0.08;
        for (const arc of arcs) {
          _v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(r).add(fx.hand);
          _w.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(r * 1.2).add(fx.hand);
          jag(arc, _v, _w, 0.4, 3);
          glow.strip(arc, 0.05 * (fx.from.player ? 0.5 : 1), PAL.lightning.glow, 0.5, 0);
          glow.strip(arc, 0.01, PAL.lightning.core, 0.9, 1);
        }
      }
    }
    if (f === 'missile' && fx.data.bolts) {
      for (const b of fx.data.bolts) {
        if (b.n < 2 || b.hit) continue;
        // A wide violet wake, a hot streak at the head of it: read as a
        // thing moving fast, not as a line drawn across the square.
        glow.strip(b.trail, taper1(0.24), PAL.missile.trail, fadeSq(0.75), 0, b.n);
        glow.strip(b.trail, taper1(0.05), MISSILE_STREAK, fadeSq(1), 1, Math.min(b.n, 6));
      }
    }
    // Lightning: strokes down one channel (see `drawBolt`).
    const lightning = (f === 'lightning' || f === 'breath-lightning') && fx.released && !fx.fizzled && fx.to && fx.data.strike;
    if (lightning) {
      const tf = fx.t - fx.releaseT;
      if (tf < fx.data.boltLife) drawBolt(fx.data.strike, fx.data.src, chestPoint(fx.to, tmpA, true), tf, fx.data.boltLife, 1, f === 'breath-lightning' ? 2.8 : 2.1);
      else fx.data.strike.env = 0;
    }
    // Arcs crawling over a body: shocking grasp, and the strike of a sky bolt.
    if (fx.data.strikes) {
      for (const s of fx.data.strikes) {
        if (fx.t >= s.until) continue;
        const fade = clamp((s.until - fx.t) / 0.3, 0, 1);
        const feet = feetPoint(s.w, tmpA);
        const h = heightOf(s.w);
        if (f === 'storm') {
          if (!s.sky) s.sky = { bolt: new Bolt(8), stroke: -1, env: 1, jag: 0.1, top: { x: feet.x + rand(-3, 3), y: feet.y + 34, z: feet.z + rand(-3, 3) }, t0: fx.t };
          _v.set(feet.x, feet.y + h * 0.6, feet.z);
          drawBolt(s.sky, s.sky.top, _v, fx.t - s.sky.t0, 0.55, 2.6, 7);
        }
        if (!s.w.player) {
          for (let k = 0; k < 3; k++) {
            const a0 = rand(0, TAU); const a1 = a0 + rand(0.6, 1.6);
            const arcs = s.arcs || (s.arcs = [P3(9), P3(9), P3(9)]);
            _v.set(feet.x + Math.cos(a0) * 0.3, feet.y + rand(0.3, h), feet.z + Math.sin(a0) * 0.3);
            _w.set(feet.x + Math.cos(a1) * 0.3, feet.y + rand(0.3, h), feet.z + Math.sin(a1) * 0.3);
            const path = jag(arcs[k], _v, _w, 0.3, 3);
            glow.strip(path, 0.14, PAL.lightning.glow, 0.5 * fade, 0);
            glow.strip(path, 0.02, PAL.lightning.core, fade, 1);
          }
        }
      }
    }
    // Shocking grasp: the arc from the hand while the spell is on its way.
    if (f === 'shock' && fx.released && fx.to && (!fx.landed || fx.t - fx.landT < 0.3)) {
      const aim = chestPoint(fx.to, tmpA, true);
      const path = jag(fx.data.arc || (fx.data.arc = P3(17)), fx.data.src, aim, 0.3, 4);
      glow.strip(path, 0.16, PAL.lightning.glow, 0.45, 0);
      glow.strip(path, 0.025, PAL.lightning.core, 1, 1);
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
    // Colour spray: a fan of light out of the hand -- each ray running
    // through the spectrum along its length and over time, wide and soft
    // where it spreads, with a thin bright line down it, dying into the air.
    if (f === 'prism' && fx.released && fx.to && fx.data.fan) {
      const age = fx.t - fx.releaseT;
      const life = fx.flight + 0.34;
      if (age < life) {
        const src = fx.data.src;
        const reach = smooth(age / Math.max(0.08, fx.flight * 0.8));
        const fade = 1 - smooth((age - fx.flight) / 0.34);
        for (const ray of fx.data.fan) {
          const L = ray.len * reach;
          for (let k = 0; k < 7; k++) {
            const q = ray.pts[k]; const t = (k / 6) * L;
            q.x = src.x + ray.dir.x * t; q.y = src.y + ray.dir.y * t; q.z = src.z + ray.dir.z * t;
          }
          const shimmer = fade * (0.62 + 0.38 * Math.sin(clock * 31 + ray.phase * 7)) * (0.8 + 0.2 * Math.sin(clock * 11 + ray.phase));
          prismRay.hue = ray.hue + clock * 1.3; prismRay.a = shimmer;
          glow.strip(ray.pts, prismWide, prismColour, prismAlphaWide, 0);
          glow.strip(ray.pts, prismThin, prismColourHot, prismAlphaThin, 0.6);
        }
      }
    }
    // Tendrils: a curse or a drain reaching across, writhing.
    if ((f === 'curse' || f === 'drain' || f === 'hex') && fx.released && fx.to && fx.to !== fx.from) {
      const age = fx.t - fx.releaseT;
      const life = fx.flight + 0.5;
      if (age < life) {
        const src = fx.data.src;
        const aim = chestPoint(fx.to, tmpA, true);
        const reach = smooth(age / Math.max(0.1, fx.flight));
        const fade = 1 - smooth((age - fx.flight) / 0.5);
        // Three strands wound round the line between them, each turning and
        // writhing on its own, rising off the ground in a shallow arch.
        const dx = aim.x - src.x; const dy = aim.y - src.y; const dz = aim.z - src.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const ax = dx / len; const az = dz / len;
        const sx = -az; const sz = ax;   // horizontal side
        const smokeC = f === 'drain' ? DRAIN_SMOKE : PAL.dark.smoke;
        const strands = fx.data.strands || (fx.data.strands = [P3(21), P3(21), P3(21)]);
        const glowC = f === 'drain' ? PAL.harm.glow : PAL.dark.glow;
        for (let k = 0; k < 3; k++) {
          const pts = strands[k];
          const phase = k * 2.094 + clock * 5.5;
          for (let j = 0; j <= 20; j++) {
            const u = (j / 20) * reach;
            const env = Math.sin(Math.PI * Math.min(1, u / Math.max(0.05, reach))) * 0.32 + 0.04;
            const ang = phase + u * 11;
            const r = env * (0.8 + 0.4 * Math.sin(u * 17 + clock * 9 + k));
            const arch = Math.sin(Math.PI * u) * Math.min(1.0, len * 0.12);
            const q = pts[j];
            q.x = src.x + dx * u + sx * Math.cos(ang) * r;
            q.y = src.y + dy * u + Math.sin(ang) * r + arch;
            q.z = src.z + dz * u + sz * Math.cos(ang) * r;
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
        light.spawn({ x: from.x + rand(-0.2, 0.2), y: from.y + rand(-0.3, 0.3), z: from.z + rand(-0.2, 0.2), vx: (to.x - from.x) / t, vy: (to.y - from.y) / t, vz: (to.z - from.z) / t, life: t, size: rand(0.03, 0.06), color: HARM_BRIGHT, shape: 1, drag: 0 });
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
      // Not as dark as the street it rises from, even at night -- a dust
      // cloud catches the lamps and the moon, and one the colour of the
      // ground is simply not there.
      const m = 0.55 + 0.45 * d;
      PAL.dust.smoke.setRGB(0.5 * m, 0.45 * m, 0.38 * m);
      PAL.dust.grit.setRGB(0.3 * m, 0.26 * m, 0.21 * m);
    },
    /** For the harness: how much is alive right now. */
    stats() {
      return {
        effects: effects.length, light: light.n, matter: matter.n, ribbonVerts: glow.v + shade.v,
        decals: decals.filter((d) => d.busy).length, spheres: spheres.filter((s) => s.busy).length,
        lights: lights.filter((l) => l.busy).length, heat: heat.live.length, auras: [...auras.values()].filter((a) => a.on).length,
        flight: { ...flightCounts },
      };
    },
    pools: { light, matter, glow, shade },
    /** For the harness: leave a mark (see `mark`) at a point. */
    mark: (p, r, mode, color = PAL.fire.glow, life = 7, cool = 1.6) => mark(p, r, mode, color, life, cool),
    heat,
    dispose() { unlisten(); scene.remove(group); overlay.remove(); for (const l of lights) scene.remove(l.light); },
  };
}
