/**
 * What a fight looks and sounds like.
 *
 * The rules are Merc's and live in game.js: a round is resolved all at once on
 * the violence pulse, every three seconds. Shown that way it is a flurry of
 * text and nothing else, so every combat event carries a `delay` -- the beat
 * of its blow within the round (game.js `SWING_GAP`, `MOB_BEAT`) -- and
 * everything here happens *on* that beat:
 *
 *   - a mobile's first swing of a round is started early, from the pulse
 *     clock, so the clip's contact frame (`hitFrame`) lands on the pulse; later
 *     swings of the same round start the moment the round is known;
 *   - on contact: the victim flinches (`hit`), blocks (`block`) or sidesteps,
 *     a spark comes off metal or a small dark puff off cloth, and the sound
 *     is placed where it happened;
 *   - your own blows are a weapon in your hands, swung to land on the same
 *     beat, and a blow on you shakes the view.
 *
 * Nothing here is gore. A hit on flesh is a few dark droplets that are gone in
 * half a second; a death is a body going down and a little dust.
 */

import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { OVERLAY_LAYER } from './render.js';
import { MOB_BEAT, WEAR } from './game.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (u) => u * u * (3 - 2 * u);
const easeIn = (u) => u * u * u;
const easeOut = (u) => 1 - (1 - u) * (1 - u);

// ---------------------------------------------------------------- weapons ----

const WEAPON_WORDS = [
  ['dagger', /\b(dagger|knife|dirk|stiletto|kris|shiv)\b/],
  ['axe', /\b(axe|hatchet|cleaver|bardiche)\b/],
  ['mace', /\b(mace|club|hammer|morning ?star|flail|cudgel|maul|whip)\b/],
  ['spear', /\b(spear|lance|pike|trident|halberd|javelin|polearm|glaive)\b/],
  ['staff', /\b(staff|quarterstaff|stick|rod|cane|stave)\b/],
  ['sword', /\b(sword|blade|sabre|saber|scimitar|rapier|katana|longsword|broadsword|cutlass)\b/],
];
/** attack_table, for a weapon whose name says nothing. */
const BY_ATTACK = {
  slice: 'sword', slash: 'sword', stab: 'dagger', pierce: 'dagger',
  pound: 'mace', crush: 'mace', whip: 'mace', hit: 'sword',
};
const ATTACK_TABLE = ['hit', 'slice', 'stab', 'slash', 'whip', 'claw', 'blast', 'pound', 'crush', 'grep', 'bite', 'pierce', 'suction'];

/**
 * Which of the six modelled weapons an object is: its own words first, then
 * the attack type in value[3]. Null for bare hands.
 */
export function weaponKind(obj) {
  if (!obj) return null;
  const words = `${obj.keywords || ''} ${obj.name || ''}`.toLowerCase();
  for (const [kind, re] of WEAPON_WORDS) if (re.test(words)) return kind;
  const attack = ATTACK_TABLE[(obj.values && obj.values[3]) || 0];
  return BY_ATTACK[attack] || 'sword';
}

/** How each kind is used: a cut, a thrust, or a punch. */
const STYLE = { sword: 'cut', axe: 'cut', mace: 'cut', staff: 'cut', dagger: 'thrust', spear: 'thrust', fist: 'punch' };

// -- procedural stand-ins, for until the modelled weapons exist -----------------

/**
 * A blade: a diamond section tapering to a point, flat-shaded so the two bevels
 * catch the light differently -- which is what makes steel read as steel.
 * Grip at the origin, blade up +Y, flat of the blade facing Z.
 */
function bladeGeometry(length, width, thick, tip) {
  const stations = [
    [0, width, thick], [length - tip, width * 0.86, thick * 0.9], [length, 0.0005, 0.0005],
  ];
  const ring = (y, w, t) => [[w / 2, y, 0], [0, y, t / 2], [-w / 2, y, 0], [0, y, -t / 2]];
  const pos = [];
  for (let s = 0; s < stations.length - 1; s++) {
    const a = ring(...stations[s]);
    const b = ring(...stations[s + 1]);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      pos.push(...a[k], ...b[k], ...b[k2], ...a[k], ...b[k2], ...a[k2]);
    }
  }
  const base = ring(0, width, thick);
  pos.push(...base[0], ...base[2], ...base[1], ...base[0], ...base[3], ...base[2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function makeMaterials(library) {
  // Steel wants the environment to be anything at all: a bright metal with no
  // reflection is a grey plastic. Flat PBR on purpose -- a tiled stone recipe
  // on a 90 cm blade reads as a pattern, not a surface.
  const steel = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.92, roughness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x55565a, metalness: 0.85, roughness: 0.42 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08a4e, metalness: 0.9, roughness: 0.35 });
  const flat = (tag, fallback) => {
    const m = library && library.materialFor ? library.materialFor(tag) : null;
    if (!m) return new THREE.MeshStandardMaterial(fallback);
    const c = m.clone();
    c.vertexColors = false; // procedural geometry here carries no colour attribute
    return c;
  };
  const leather = flat('leather', { color: 0x4a3524, roughness: 0.6 });
  const wood = flat('oak', { color: 0x5a4330, roughness: 0.75 });
  const skin = flat('skin', { color: 0xc79b76, roughness: 0.7 });
  const cloth = flat('cloth', { color: 0x4a3f36, roughness: 0.95 });
  cloth.color.setHex(0x4b4136);
  return { steel, dark, brass, leather, wood, skin, cloth };
}

function mesh(geometry, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  return m;
}

function proceduralWeapon(kind, M) {
  const g = new THREE.Group();
  const grip = (len, r = 0.017) => {
    g.add(mesh(new THREE.CylinderGeometry(r, r * 1.08, len, 10), M.leather, 0, len / 2 - 0.02, 0));
    // Wrapped: a few raised turns so the grip is not a pipe.
    for (let i = 0; i < 5; i++) g.add(mesh(new THREE.TorusGeometry(r * 1.02, 0.0035, 5, 12), M.leather, 0, 0.01 + i * (len / 5), 0, Math.PI / 2));
  };
  switch (kind) {
    case 'dagger': {
      grip(0.11, 0.015);
      g.add(mesh(new THREE.SphereGeometry(0.02, 12, 8), M.brass, 0, -0.03, 0));
      g.add(mesh(new THREE.BoxGeometry(0.085, 0.016, 0.022), M.brass, 0, 0.1, 0));
      g.add(mesh(bladeGeometry(0.24, 0.034, 0.007, 0.07), M.steel, 0, 0.108, 0));
      break;
    }
    case 'axe': {
      g.add(mesh(new THREE.CylinderGeometry(0.018, 0.021, 0.72, 10), M.wood, 0, 0.25, 0));
      const shape = new THREE.Shape();
      shape.moveTo(0, -0.05); shape.lineTo(0.05, -0.04); shape.quadraticCurveTo(0.13, -0.1, 0.17, -0.12);
      shape.quadraticCurveTo(0.2, 0.0, 0.17, 0.12); shape.quadraticCurveTo(0.13, 0.08, 0.05, 0.05);
      shape.lineTo(0, 0.05); shape.lineTo(-0.03, 0.03); shape.lineTo(-0.03, -0.03); shape.closePath();
      const head = new THREE.ExtrudeGeometry(shape, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 2, curveSegments: 10 });
      head.translate(0, 0, -0.008);
      g.add(mesh(head, M.steel, 0.012, 0.54, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.07, 10), M.dark, 0, 0.54, 0));
      break;
    }
    case 'mace': {
      g.add(mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.5, 10), M.wood, 0, 0.18, 0));
      grip(0.14, 0.02);
      g.add(mesh(new THREE.SphereGeometry(0.048, 16, 12), M.dark, 0, 0.47, 0));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.add(mesh(new THREE.BoxGeometry(0.012, 0.11, 0.05), M.steel, Math.cos(a) * 0.045, 0.47, Math.sin(a) * 0.045, 0, -a, 0));
      }
      g.add(mesh(new THREE.ConeGeometry(0.018, 0.05, 8), M.steel, 0, 0.535, 0));
      break;
    }
    case 'spear': {
      g.add(mesh(new THREE.CylinderGeometry(0.016, 0.019, 1.9, 10), M.wood, 0, 0.35, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.02, 0.017, 0.07, 10), M.dark, 0, 1.3, 0));
      g.add(mesh(bladeGeometry(0.26, 0.055, 0.012, 0.13), M.steel, 0, 1.33, 0));
      break;
    }
    case 'staff': {
      g.add(mesh(new THREE.CylinderGeometry(0.02, 0.026, 1.8, 10), M.wood, 0, 0.3, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.05, 10), M.brass, 0, 1.17, 0));
      g.add(mesh(new THREE.SphereGeometry(0.036, 14, 10), M.wood, 0, 1.22, 0));
      break;
    }
    case 'fist': {
      // A gloved fist and the cuff of a sleeve; the forearm runs back out of
      // frame. Origin at the knuckles' centre, knuckles toward +Y (the way a
      // blade points), back of the hand toward +Z.
      const palm = mesh(new THREE.SphereGeometry(0.05, 16, 12), M.leather, 0, -0.035, 0);
      palm.scale.set(1, 1.05, 0.8);
      g.add(palm);
      const knuckles = new THREE.CapsuleGeometry(0.021, 0.055, 4, 10);
      g.add(mesh(knuckles, M.leather, 0, 0.004, 0.004, 0, 0, Math.PI / 2));
      g.add(mesh(new THREE.CapsuleGeometry(0.017, 0.03, 4, 8), M.leather, -0.045, -0.02, 0.012, 0.3, 0, 0.5));
      g.add(mesh(new THREE.CylinderGeometry(0.036, 0.04, 0.05, 14), M.leather, 0, -0.1, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.039, 0.05, 0.32, 14), M.cloth, 0, -0.28, 0));
      break;
    }
    default: {
      // sword
      grip(0.16, 0.017);
      g.add(mesh(new THREE.SphereGeometry(0.026, 14, 10), M.brass, 0, -0.035, 0));
      const guard = new THREE.CapsuleGeometry(0.011, 0.17, 4, 8);
      g.add(mesh(guard, M.dark, 0, 0.145, 0, 0, 0, Math.PI / 2));
      g.add(mesh(bladeGeometry(0.78, 0.048, 0.009, 0.13), M.steel, 0, 0.155, 0));
      break;
    }
  }
  g.traverse((n) => { if (n.isMesh) { n.castShadow = false; n.receiveShadow = false; } });
  return g;
}

/** The arms tools/blender/weapons.py makes; fx.js loads them if boot did not. */
export const WEAPON_ASSETS = [
  'weapon_sword', 'weapon_dagger', 'weapon_axe', 'weapon_mace', 'weapon_spear',
  'weapon_staff', 'shield_round', 'shield_kite',
];

/**
 * Tags the weapons use that a textures.js without their recipes cannot
 * dress. `materialFor` answers an unknown tag with stone, which on a blade is
 * the stick of charcoal weapons.py's docstring warns about -- so until the
 * `steel` and `paint` recipes are there, these stand in.
 */
const STAND_IN = {
  steel: { color: 0xb4b9be, metalness: 0.95, roughness: 0.4 },
  paint: { color: 0x7d2a22, metalness: 0, roughness: 0.66 },
};

/**
 * A modelled weapon from the library, turned into the hand's frame. The file's
 * frame (weapons.py): grip centre at the origin, +Y up the blade, +Z the
 * striking side, flats facing X. The hand's weapon frame here puts the edge on
 * X and the flats on Z, so a quarter turn about Y; the grip centre is already
 * where the fist closes.
 */
function modelledWeapon(library, name) {
  const asset = library && library.get && library.get(name);
  if (!asset) return null;
  const g = new THREE.Group();
  const inner = new THREE.Group();
  if (name.startsWith('weapon_')) inner.rotation.y = -Math.PI / 2;
  for (const p of asset.primitives) {
    let material = p.material;
    const standIn = STAND_IN[p.materialName];
    if (standIn && !(library.materials && library.materials[p.materialName])) {
      material = new THREE.MeshStandardMaterial({ vertexColors: true, ...standIn });
    } else if (material && material.metalness > 0.5) {
      // Half a metre from the eye, the hammered steel's relief is a field of
      // tiny mirrors: each one caught a lamp at night and the blade bloomed
      // like cut crystal. Its own copy, smoother and flatter, for the hand.
      material = material.clone();
      material.roughness = Math.max(material.roughness, 0.38);
      if (material.normalScale) material.normalScale.multiplyScalar(0.4);
      material.envMapIntensity = (material.envMapIntensity ?? 1) * 0.7;
    }
    inner.add(new THREE.Mesh(p.geometry, material));
  }
  g.add(inner);
  g.userData.modelled = true;
  return g;
}

// ------------------------------------------------------------- the passes ----

/**
 * The weapon in your hands is drawn after the world and its ambient occlusion,
 * over a cleared depth buffer: it can never poke into a wall you are standing
 * against, and the AO -- computed from a depth prepass that never saw it --
 * cannot shade it with the shape of whatever is behind it. Bloom and tone
 * mapping still run after it, so it is exposed like everything else.
 */
class ViewModelPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.scene.visible) return;
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = oldAutoClear;
  }
}

// -------------------------------------------------------------- particles ----

const PARTICLE_VERT = `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  uniform float scale;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * scale / max(0.05, -mv.z);
    vAlpha = alpha;
    vTint = tint;
  }
`;
const PARTICLE_FRAG = `
  varying float vAlpha;
  varying vec3 vTint;
  uniform float hard;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = dot(c, c);
    if (r > 1.0) discard;
    float a = mix(1.0 - r, 1.0 - smoothstep(0.55, 1.0, r), hard) * vAlpha;
    gl_FragColor = vec4(vTint * a, a);
  }
`;

class Particles {
  constructor(max, additive, hard) {
    this.max = max;
    this.live = [];
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tint', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: { scale: { value: 600 }, hard: { value: hard ? 1 : 0 } },
      transparent: true,
      depthWrite: false,
      // Premultiplied in the shader, so one blend equation serves both: ONE,
      // ONE for light (sparks) and ONE, ONE_MINUS_SRC_ALPHA for matter.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    // Kept out of the AO prepass, like every other soft transparent quad.
    this.points.layers.set(OVERLAY_LAYER);
  }

  spawn(p) {
    if (this.live.length >= this.max) this.live.shift();
    this.live.push({ t: 0, grow: 0, drag: 1.5, gravity: 0, fade: 1, ...p });
  }

  update(dt) {
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.t += dt;
      if (p.t >= p.life) { this.live.splice(i, 1); continue; }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * k - p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.floor !== undefined && p.y < p.floor) { p.y = p.floor; p.vy = Math.abs(p.vy) * 0.2; p.vx *= 0.4; p.vz *= 0.4; }
    }
    for (const p of this.live) {
      const u = p.t / p.life;
      this.pos[n * 3] = p.x; this.pos[n * 3 + 1] = p.y; this.pos[n * 3 + 2] = p.z;
      this.col[n * 3] = p.r; this.col[n * 3 + 1] = p.g; this.col[n * 3 + 2] = p.b;
      this.size[n] = p.size * (1 + p.grow * u);
      this.alpha[n] = p.alpha * Math.pow(1 - u, p.fade);
      n++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    for (const name of ['position', 'tint', 'size', 'alpha']) g.attributes[name].needsUpdate = n > 0;
  }
}

/**
 * Sparks as the eye (and a camera) sees them: streaks, each the distance it
 * travels in about a thirtieth of a second, bright at the head and dying to
 * nothing at the tail. Drawn as points they read as flecks of gold paint
 * stuck to whatever they came off.
 */
class Streaks {
  constructor(max) {
    this.max = max;
    this.live = [];
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
    this.lines.layers.set(OVERLAY_LAYER);
  }

  spawn(p) {
    if (this.live.length >= this.max) this.live.shift();
    this.live.push({ t: 0, drag: 2, gravity: 9.8, ...p });
  }

  update(dt) {
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.t += dt;
      if (p.t >= p.life) { this.live.splice(i, 1); continue; }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * k - p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.floor !== undefined && p.y < p.floor) { p.y = p.floor; p.vy = Math.abs(p.vy) * 0.3; p.vx *= 0.5; p.vz *= 0.5; }
    }
    for (const p of this.live) {
      const fade = Math.pow(1 - p.t / p.life, 1.5);
      const len = 0.034;
      const o = n * 6;
      this.pos[o] = p.x; this.pos[o + 1] = p.y; this.pos[o + 2] = p.z;
      this.pos[o + 3] = p.x - p.vx * len; this.pos[o + 4] = p.y - p.vy * len; this.pos[o + 5] = p.z - p.vz * len;
      this.col[o] = p.r * fade; this.col[o + 1] = p.g * fade; this.col[o + 2] = p.b * fade;
      this.col[o + 3] = p.r * fade * 0.12; this.col[o + 4] = p.g * fade * 0.08; this.col[o + 5] = p.b * fade * 0.05;
      n++;
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, n * 2);
    g.attributes.position.needsUpdate = n > 0;
    g.attributes.color.needsUpdate = n > 0;
  }
}

// ------------------------------------------------------------ view model ----

/**
 * Key poses in camera space (x right, y up, looking down -z). Each is where the
 * fist is, which way the blade points out of it, and which way the forearm
 * runs back to the elbow; the hand's orientation is built from those two
 * directions, which is far easier to reason about than three Euler angles.
 * For bare hands `blade` is the line through the curled fingers.
 */
/*
 * Rest and ready keep the hand in the lower right, left of the vitals panel
 * (NDC x ~0.25, y ~-0.6 at 16:9) and the blade rising up and out from it, so
 * the crosshair and whatever it is on are never behind steel. The old ones
 * crossed the blade over the centre of the frame and put the fist under the
 * panel.
 */
const POSES = {
  cut: {
    rest: { p: [0.18, -0.27, -0.55], blade: [0.4, 0.7, -0.6], elbow: [0.45, -0.55, 0.7] },
    ready: { p: [0.15, -0.22, -0.55], blade: [0.15, 0.8, -0.58], elbow: [0.5, -0.65, 0.55] },
    block: { p: [0.06, -0.15, -0.5], blade: [-1, 0.14, -0.12], elbow: [0.35, -0.75, 0.55] },
    swings: [
      // right to left, falling: wound up over the right shoulder
      { windup: { p: [0.34, -0.06, -0.36], blade: [0.5, 0.55, 0.67], elbow: [0.35, -0.9, 0.25] },
        contact: { p: [0.02, -0.21, -0.6], blade: [-0.86, 0.06, -0.5], elbow: [0.45, -0.45, 0.75] },
        follow: { p: [-0.26, -0.36, -0.46], blade: [-0.62, -0.42, 0.66], elbow: [0.7, -0.3, 0.6] } },
      // high right to low left, the heavy cut: seen at contact as a diagonal
      // across the frame, where a straight overhead one is end-on and hides
      // behind its own hand
      { windup: { p: [0.2, 0.05, -0.4], blade: [0.2, 0.55, 0.81], elbow: [0.35, -0.9, 0.2] },
        contact: { p: [0.03, -0.17, -0.62], blade: [-0.5, -0.12, -0.86], elbow: [0.4, -0.55, 0.72] },
        follow: { p: [-0.12, -0.4, -0.52], blade: [-0.55, -0.6, -0.58], elbow: [0.45, -0.3, 0.84] } },
      // left to right, rising
      { windup: { p: [-0.08, -0.3, -0.46], blade: [-0.8, -0.2, -0.55], elbow: [0.55, -0.4, 0.7] },
        contact: { p: [0.12, -0.19, -0.6], blade: [0.82, 0.3, -0.48], elbow: [0.1, -0.6, 0.8] },
        follow: { p: [0.34, -0.08, -0.46], blade: [0.62, 0.62, 0.45], elbow: [0.2, -0.9, 0.35] } },
    ],
  },
  thrust: {
    rest: { p: [0.18, -0.3, -0.5], blade: [0.12, 0.4, -0.9], elbow: [0.4, -0.6, 0.7] },
    ready: { p: [0.16, -0.24, -0.5], blade: [0.05, 0.3, -0.95], elbow: [0.4, -0.55, 0.73] },
    block: { p: [0.06, -0.16, -0.46], blade: [-1, 0.2, -0.1], elbow: [0.35, -0.75, 0.55] },
    swings: [
      { windup: { p: [0.23, -0.27, -0.28], blade: [-0.06, 0.18, -0.98], elbow: [0.35, -0.45, 0.82] },
        contact: { p: [0.08, -0.16, -0.78], blade: [-0.26, 0.24, -0.93], elbow: [0.3, -0.25, 0.92] },
        follow: { p: [0.1, -0.18, -0.7], blade: [-0.24, 0.22, -0.94], elbow: [0.3, -0.27, 0.91] } },
      { windup: { p: [0.3, -0.2, -0.32], blade: [-0.3, 0.3, -0.9], elbow: [0.5, -0.5, 0.7] },
        contact: { p: [0.02, -0.19, -0.76], blade: [0.12, 0.02, -1], elbow: [0.3, -0.25, 0.92] },
        follow: { p: [0.0, -0.22, -0.66], blade: [0.12, 0.0, -1], elbow: [0.3, -0.3, 0.9] } },
    ],
  },
  punch: {
    rest: { p: [0.2, -0.36, -0.45], blade: [-0.9, 0.3, -0.3], elbow: [0.3, -0.8, 0.5] },
    ready: { p: [0.16, -0.22, -0.45], blade: [-0.9, 0.3, -0.3], elbow: [0.3, -0.65, 0.7] },
    block: { p: [0.08, -0.12, -0.36], blade: [-0.25, 0.96, 0.05], elbow: [0.2, -0.85, 0.45] },
    swings: [
      { windup: { p: [0.22, -0.22, -0.34], blade: [-0.9, 0.25, -0.3], elbow: [0.3, -0.7, 0.65] },
        contact: { p: [0.06, -0.13, -0.66], blade: [-1, 0.1, 0.0], elbow: [0.2, -0.3, 0.93] },
        follow: { p: [0.07, -0.14, -0.62], blade: [-1, 0.1, 0.0], elbow: [0.2, -0.32, 0.92] } },
    ],
  },
};

/** The casting gesture, for the right hand whatever it holds. */
const CAST = {
  // Both kept right of the crosshair, so the arm never stands between you
  // and what you are casting at.
  gather: { p: [0.24, -0.21, -0.44], blade: [-0.88, 0.4, -0.25], elbow: [0.35, -0.72, 0.6] },
  release: { p: [0.2, -0.17, -0.62], blade: [-0.95, 0.25, -0.18], elbow: [0.45, -0.5, 0.74] },
};

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();

/** Hand orientation from a pose: +X along the blade, -Y up the forearm. */
function handQuat(pose, out, mirror = false) {
  const sx = mirror ? -1 : 1;
  _bx.set(pose.blade[0] * sx, pose.blade[1], pose.blade[2]).normalize();
  _by.set(pose.elbow[0] * sx, pose.elbow[1], pose.elbow[2]);
  _by.addScaledVector(_bx, -_by.dot(_bx)).normalize().negate();
  _bz.crossVectors(_bx, _by);
  _m.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_m);
}

function setHand(obj, a, b, u, mirror = false) {
  const sx = mirror ? -1 : 1;
  obj.position.set(
    (a.p[0] + (b.p[0] - a.p[0]) * u) * sx,
    a.p[1] + (b.p[1] - a.p[1]) * u,
    a.p[2] + (b.p[2] - a.p[2]) * u,
  );
  handQuat(a, _q1, mirror);
  handQuat(b, _q2, mirror);
  obj.quaternion.slerpQuaternions(_q1, _q2, u);
}

class ViewModel {
  constructor(camera, library, materials) {
    this.camera = camera;
    this.library = library;
    this.M = materials;
    this.scene = new THREE.Scene();
    this.scene.fog = null;
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.hand = new THREE.Group();   // right hand: the weapon or a fist
    this.off = new THREE.Group();    // left: a fist when unarmed, a shield if carried
    this.root.add(this.hand, this.off);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.fill = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.scene.add(this.sun, this.sun.target, this.fill);
    // The two strongest practicals the pool has bound this frame -- the lamp
    // on the kerb, the torch on the wall -- so a blade at night catches the
    // fire it is held beside. A fixed two, so the program never changes.
    this.lamps = [0, 1].map(() => {
      const l = new THREE.PointLight(0xffffff, 0, 16, 2);
      this.scene.add(l);
      return l;
    });
    this.kind = undefined;
    this.shield = undefined;
    this.swing = null;
    this.queue = [];
    this.block = 0;
    this.jolt = 0;
    this.fight = 0;
    this.show = 0;
    this.lastYaw = null;
    this.lag = { x: 0, y: 0 };
    this.beat = 0;
    this.primedFor = null;
    this.casting = null;
  }

  /**
   * Say the words: the hand draws back and up while the spell gathers, and
   * thrusts out at the release, `windup` seconds from now -- so what leaves
   * the hand (spellfx.js reads `castPoint`) leaves it at full reach. A lost
   * spell just sinks back.
   */
  cast(windup, lost = false) {
    this.casting = { t: 0, windup: Math.max(0.2, windup), lost };
  }

  /** Where a spell sits in your hand: just past the knuckles, in world space. */
  castPoint(out) {
    return out.set(this.hand.position.x - 0.03, this.hand.position.y + 0.07, this.hand.position.z - 0.08)
      .applyQuaternion(this.camera.quaternion).add(this.camera.position);
  }

  equip(kind, shieldKind) {
    if (kind === this.kind && shieldKind === this.shield) return;
    this.kind = kind;
    this.shield = shieldKind;
    for (const g of [this.hand, this.off]) while (g.children.length) g.remove(g.children[0]);
    // The hand is always there; the weapon sits in it with its grip through
    // the curled fingers (hand X), pommel on the little-finger side.
    this.hand.add(proceduralWeapon('fist', this.M));
    if (kind) {
      const weapon = modelledWeapon(this.library, `weapon_${kind}`) || proceduralWeapon(kind, this.M);
      weapon.rotation.z = -Math.PI / 2;
      // The procedural grips start at their own origin; a modelled one is
      // centred on it already.
      weapon.position.x = weapon.userData.modelled ? 0 : -0.055;
      this.hand.add(weapon);
    }
    if (shieldKind) {
      const s = modelledWeapon(this.library, `shield_${shieldKind}`) || this.proceduralShield();
      // Face (+Z in the file) away from you.
      s.rotation.y = Math.PI;
      this.off.add(s);
    } else if (!kind) {
      const f = proceduralWeapon('fist', this.M);
      f.scale.z = -1; // the left hand is the mirror of the right (see setHand)
      this.off.add(f);
    }
    this.style = STYLE[kind || 'fist'] || 'cut';
  }

  proceduralShield() {
    const g = new THREE.Group();
    const board = new THREE.CylinderGeometry(0.3, 0.3, 0.025, 28);
    g.add(mesh(board, this.M.wood, 0, 0, 0, Math.PI / 2));
    g.add(mesh(new THREE.TorusGeometry(0.3, 0.012, 6, 32), this.M.dark, 0, 0, 0));
    g.add(mesh(new THREE.SphereGeometry(0.07, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), this.M.steel, 0, 0, 0.012, Math.PI / 2));
    return g;
  }

  /**
   * Swing so the blow lands `contactIn` seconds from now. A wind-up takes
   * about a quarter second; with more time than that the swing simply starts
   * later, with less it is quicker.
   */
  strike(contactIn, miss = false) {
    const windup = clamp(contactIn - 0.1, 0.08, 0.26);
    const start = Math.max(0, contactIn - windup - 0.1);
    const set = POSES[this.style].swings;
    const shape = set[this.beat % set.length];
    // Bare hands alternate: a jab with the right, a cross with the left.
    const hand = this.style === 'punch' && this.beat % 2 ? 'off' : 'hand';
    this.beat++;
    // Queued, not replacing: a round's second blow is known the moment the
    // first is, and writing it over the first swing cut that one off before
    // it landed -- two hits, one swing.
    this.queue.push({ t: -start, windup, strike: 0.1, shape, hand, miss });
  }

  update(dt, player, fighting) {
    const cam = this.camera;
    this.root.position.copy(cam.position);
    this.root.quaternion.copy(cam.quaternion);

    const armed = !!this.kind;
    this.fight += ((fighting ? 1 : 0) - this.fight) * Math.min(1, dt * 5);
    const wantShow = armed || fighting || !!this.swing || this.queue.length || this.casting ? 1 : 0;
    this.show += (wantShow - this.show) * Math.min(1, dt * (wantShow ? 7 : 3));
    this.scene.visible = this.show > 0.01;
    if (!this.scene.visible) return;

    const P = POSES[this.style || 'cut'];
    const u = ease(this.fight);
    let main = { a: P.rest, b: P.ready, u };
    let off = { a: P.rest, b: P.ready, u };

    // Walking: the hands ride the same bob as the eye.
    const bob = player ? player.bob : 0;
    const phase = player ? player.bobPhase : 0;
    const bx = Math.cos(phase * 0.5) * 0.012 * bob;
    const by = -Math.abs(Math.sin(phase)) * 0.016 * bob;
    // Turning: the weapon lags the view a little, like anything with weight.
    const yaw = cam.rotation.y;
    const pitch = cam.rotation.x;
    if (this.lastYaw !== null) {
      let dy = yaw - this.lastYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const dp = pitch - this.lastPitch;
      const k = Math.min(1, dt * 10);
      this.lag.x += (clamp(dy / Math.max(dt, 1e-3), -6, 6) * 0.01 - this.lag.x) * k;
      this.lag.y += (clamp(dp / Math.max(dt, 1e-3), -6, 6) * 0.01 - this.lag.y) * k;
    }
    this.lastYaw = yaw; this.lastPitch = pitch;

    // A blow that meets nothing carries on past where it should have stopped:
    // the follow-through a third again as far, which is what a miss looks
    // like from behind the blade.
    const follow = (s) => {
      if (!s.miss) return s.shape.follow;
      if (!s.over) {
        const c = s.shape.contact; const f = s.shape.follow;
        s.over = { p: f.p.map((v, i) => v + (v - c.p[i]) * 0.4), blade: f.blade, elbow: f.elbow };
      }
      return s.over;
    };
    const mix = (m) => {
      // Collapse a two-pose blend to a single pose object.
      const a = m.a; const b = m.b; const t = m.u;
      const lerp3 = (x, y) => x.map((v, i) => v + (y[i] - v) * t);
      return { p: lerp3(a.p, b.p), blade: lerp3(a.blade, b.blade), elbow: lerp3(a.elbow, b.elbow) };
    };

    // Parry: the blade comes across and holds a beat.
    if (this.block > 0) {
      this.block -= dt;
      const w = this.block > 0.3 ? easeOut(clamp((0.45 - this.block) / 0.15, 0, 1)) : ease(clamp(this.block / 0.3, 0, 1));
      main = { a: mix(main), b: P.block, u: w };
      if (!this.kind) off = { a: mix(off), b: P.block, u: w };
    }

    // The latest queued swing that has started is the one on screen.
    for (let i = 0; i < this.queue.length; i++) this.queue[i].t += dt;
    while (this.queue.length && this.queue[0].t >= 0) {
      this.swing = this.queue.shift();
      this.swing.t -= dt; // advanced once below
    }
    if (this.swing) {
      const s = this.swing;
      s.t += dt;
      const t = s.t;
      const cur = s.hand === 'off' ? off : main;
      const base = mix(cur);
      let seg;
      if (t < 0) seg = { a: base, b: base, u: 0 };
      else if (t < s.windup) seg = { a: base, b: s.shape.windup, u: easeOut(t / s.windup) };
      else if (t < s.windup + s.strike) seg = { a: s.shape.windup, b: s.shape.contact, u: easeIn((t - s.windup) / s.strike) };
      else if (t < s.windup + s.strike + 0.12) seg = { a: s.shape.contact, b: follow(s), u: easeOut((t - s.windup - s.strike) / 0.12) };
      else if (t < s.windup + s.strike + 0.55) seg = { a: follow(s), b: base, u: ease((t - s.windup - s.strike - 0.12) / 0.43) };
      else { this.swing = null; seg = null; }
      if (seg) { if (s.hand === 'off') off = seg; else main = seg; }
    }

    // Casting: back and up to gather, out at the release, and home again.
    if (this.casting) {
      const c = this.casting;
      c.t += dt;
      const thrust = c.windup - 0.1;
      const base = mix(main);
      let seg = null;
      if (c.t < thrust) seg = { a: base, b: CAST.gather, u: easeOut(clamp(c.t / Math.min(0.3, thrust), 0, 1)) };
      else if (c.lost) seg = c.t < thrust + 0.45 ? { a: CAST.gather, b: base, u: ease((c.t - thrust) / 0.45) } : null;
      else if (c.t < c.windup) seg = { a: CAST.gather, b: CAST.release, u: easeIn((c.t - thrust) / 0.1) };
      else if (c.t < c.windup + 0.16) seg = { a: CAST.release, b: CAST.release, u: 0 };
      else if (c.t < c.windup + 0.6) seg = { a: CAST.release, b: base, u: ease((c.t - c.windup - 0.16) / 0.44) };
      if (seg) {
        // A tremble while it gathers: the words are an effort.
        const tr = c.t < thrust ? Math.sin(c.t * 47) * 0.004 : 0;
        seg = { a: seg.a, b: seg.b, u: seg.u, tr };
        main = seg;
      } else this.casting = null;
    }

    // Coming into view from below, not popping in.
    const drop = (1 - ease(this.show)) * 0.45;
    const jolt = this.jolt > 0 ? Math.sin((1 - this.jolt / 0.25) * Math.PI) * 0.045 : 0;
    this.jolt = Math.max(0, this.jolt - dt);
    const place = (obj, m, mirror) => {
      setHand(obj, m.a, m.b, m.u, mirror);
      obj.position.x += bx - this.lag.x - jolt * 0.3;
      obj.position.y += by - drop - this.lag.y * 0.6 - jolt;
    };
    place(this.hand, main, false);
    if (main.tr) this.hand.position.y += main.tr;
    if (this.shield) {
      // A shield is not held like a blade: its board stays square to you, low
      // and out to the left, and comes up across the body in a fight.
      const up = this.block > 0 ? 1 : u;
      this.off.position.set(-0.56 + 0.14 * up + bx - this.lag.x, -0.74 + 0.26 * up + by - drop - this.lag.y * 0.6, -0.82 + 0.06 * up);
      this.off.rotation.set(-0.12 + 0.1 * up, 0.5 - 0.25 * up, 0.15 - 0.1 * up);
    } else {
      place(this.off, off, true);
    }
    this.off.visible = !this.kind || !!this.shield;
  }

  light(sun, hemi, scene, indoor, pool) {
    this.lamps.forEach((lamp, i) => {
      const src = pool && pool.lights[i];
      if (!src || !src.visible) { lamp.intensity = 0; return; }
      lamp.position.copy(src.position);
      lamp.color.copy(src.color);
      lamp.distance = src.distance;
      lamp.decay = src.decay;
      // Less than the wall beside it gets: a point light on a curved mirror
      // at arm's length is the brightest pixel in a night frame.
      lamp.intensity = src.intensity * 0.4;
    });
    this.sun.color.copy(sun.color);
    this.sun.intensity = sun.intensity * (indoor ? 0.08 : 1);
    this.sun.position.copy(this.camera.position).add(_v.copy(sun.position).sub(sun.target.position).normalize());
    this.sun.target.position.copy(this.camera.position);
    this.fill.color.copy(hemi.color);
    this.fill.groundColor.copy(hemi.groundColor);
    this.fill.intensity = hemi.intensity * (indoor ? 0.7 : 1);
    this.scene.environment = scene.environment;
    this.scene.environmentIntensity = (scene.environmentIntensity ?? 1) * (indoor ? 0.4 : 1);
  }
}

// ----------------------------------------------------------------- the fx ----

/**
 * @param {object} deps
 *   scene, camera, composer -- the renderer's own
 *   actors  -- for the figures and motion.js's strike/react
 *   game    -- the event stream and the pulse clock
 *   audio   -- the synthesiser
 *   player  -- for the bob and the camera shake
 *   library -- the asset library (weapon models), or null
 *   sun, hemi -- the lights the view model should match
 *   built   -- to tell an interior from the street
 */
export function createFx({ scene, camera, composer, actors, game, audio, player, library, sun, hemi, built, lightPool = null }) {
  const sparks = new Particles(80, true, true);
  const streaks = new Streaks(240);
  const matter = new Particles(260, false, false);
  scene.add(sparks.points, streaks.lines, matter.points);
  const vm = new ViewModel(camera, library, makeMaterials(library));
  // The arms are not in the boot list until the branch that made them brings
  // its assets.js along; load whatever is missing, and re-dress when it lands.
  if (library && library.load) {
    const missing = WEAPON_ASSETS.filter((name) => !library.has(name) && !library.missing.has(name));
    if (missing.length) library.load(missing).then(() => { vm.kind = '(reload)'; });
  }
  const pass = new ViewModelPass(vm.scene, camera);
  // After GTAO (index 1) and before the shafts and the bloom.
  composer.insertPass(pass, 2);

  let clock = 0;
  const queue = [];
  let ambient = 1;
  let lastViolence = Infinity;

  const motion = actors.motion;
  const figureOf = (slot) => (slot && slot.figure && slot.figure.m ? slot.figure : null);

  /** A figure's chest, or the point just in front of your own. */
  function chest(slot, out = new THREE.Vector3()) {
    const fig = figureOf(slot);
    if (fig) return out.set(fig.at.x, fig.at.y + fig.height * 0.66, fig.at.z);
    // Out where your blade meets theirs: a little right of centre, most of a
    // metre off, below the eye.
    camera.getWorldDirection(out);
    const right = _v.set(1, 0, 0).applyQuaternion(camera.quaternion);
    return out.multiplyScalar(0.9).add(camera.position).addScaledVector(right, 0.12).add(_v.set(0, -0.2, 0));
  }

  /** Stereo placement and distance for a sound at a point. */
  function where(p) {
    const dx = p.x - camera.position.x; const dz = p.z - camera.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.8) return { pan: 0, gain: 1 };
    const right = _v.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const pan = clamp((dx * right.x + dz * right.z) / d, -1, 1) * 0.7;
    return { pan, gain: clamp(1 / (1 + (d - 1) / 5), 0.08, 1) };
  }

  // -- bursts ---------------------------------------------------------------

  function spark(p, away, strength = 1) {
    const n = Math.round(9 + strength * 9);
    for (let i = 0; i < n; i++) {
      const s = 2.2 + Math.random() * 3.6 * strength;
      const dir = new THREE.Vector3(
        away.x + (Math.random() - 0.5) * 1.4, 0.35 + Math.random() * 0.9, away.z + (Math.random() - 0.5) * 1.4,
      ).normalize();
      const hot = 0.75 + Math.random() * 0.25;
      streaks.spawn({
        x: p.x, y: p.y, z: p.z, vx: dir.x * s, vy: dir.y * s, vz: dir.z * s,
        life: 0.14 + Math.random() * 0.24, drag: 2.2, floor: p.floor,
        r: 4.2 * hot, g: 2.6 * hot, b: 1.0 * hot,
      });
    }
    // The flash itself: one small hot point, gone in two frames. Kept under
    // the bloom threshold's reach -- at 5x and 22 cm it lit a starburst across
    // half a noon frame.
    sparks.spawn({ x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, life: 0.06, size: 0.09 * strength, r: 1.6, g: 1.25, b: 0.8, alpha: 0.8, fade: 2 });
  }

  function flesh(p, away, strength = 1) {
    const n = Math.round(5 + strength * 7);
    const k = ambient;
    for (let i = 0; i < n; i++) {
      const s = 0.5 + Math.random() * 1.2 * strength;
      matter.spawn({
        x: p.x + (Math.random() - 0.5) * 0.08, y: p.y + (Math.random() - 0.5) * 0.1, z: p.z + (Math.random() - 0.5) * 0.08,
        vx: (away.x + (Math.random() - 0.5)) * s, vy: 0.3 + Math.random() * 0.8, vz: (away.z + (Math.random() - 0.5)) * s,
        life: 0.3 + Math.random() * 0.3, size: 0.035 + Math.random() * 0.035, grow: 0.8, gravity: 5.5, drag: 1.8,
        r: 0.2 * k, g: 0.025 * k, b: 0.018 * k, alpha: 0.75, fade: 1.2, floor: p.floor,
      });
    }
  }

  function dust(p, amount = 1) {
    const k = ambient;
    for (let i = 0; i < Math.round(5 * amount + 3); i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.25 + Math.random() * 0.6 * amount;
      matter.spawn({
        x: p.x + Math.cos(a) * 0.2, y: p.y + 0.05, z: p.z + Math.sin(a) * 0.2,
        vx: Math.cos(a) * s, vy: 0.12 + Math.random() * 0.25, vz: Math.sin(a) * s,
        life: 0.7 + Math.random() * 0.6, size: 0.18 + Math.random() * 0.2 * amount, grow: 1.6, gravity: 0.05, drag: 2.4,
        r: 0.42 * k, g: 0.38 * k, b: 0.31 * k, alpha: 0.2, fade: 1.3,
      });
    }
  }

  // -- events ---------------------------------------------------------------

  /**
   * A new event, the moment it is emitted: anything that has to *start*
   * before the blow lands -- the wind-up of a swing -- starts now; the rest
   * waits in the queue for its beat.
   */
  function onEvent(event) {
    // A spell's blow is spellfx.js's to draw: no swing, no spark, no clang.
    if (event.kind === 'cast' && event.fromPlayer && !['quaff', 'eat'].includes(event.source)) vm.cast(event.windup, event.lost);
    if (event.spell) return;
    const delay = event.delay || 0;
    if (['hit', 'miss', 'parry', 'dodge'].includes(event.kind)) {
      if (event.from) {
        const fig = figureOf(event.from);
        // The first blow of a pulse's round was started from the pulse clock.
        const primed = event.beat === 0 && event.from.primedAt !== undefined && Math.abs(event.from.primedAt - (clock + delay)) < 0.2;
        if (fig && !primed) motion.strike(fig, event.beat % 2 ? 'attack2' : 'attack', delay);
      } else if (event.skill !== 'kick') {   // a kick is the leg's (kick.js), not the blade's
        const primed = event.beat === 0 && vm.primedFor !== null && Math.abs(vm.primedFor - (clock + delay)) < 0.2;
        if (!primed) vm.strike(delay, event.kind === 'miss');
        else if (event.kind === 'miss') {
          // The swing was started before the round said it would miss.
          const s = vm.queue[vm.queue.length - 1] || vm.swing;
          if (s) s.miss = true;
        }
      }
      // The air moving, a moment before the contact.
      queue.push({ at: clock + Math.max(0, delay - 0.12), kind: 'whoosh', event });
    }
    queue.push({ at: clock + delay, kind: 'land', event });
  }
  const unlisten = game.listen(onEvent);

  function land(event) {
    const fromFig = figureOf(event.from);
    const at = chest(event.to);
    // Which way the debris goes: away from the striker.
    const src = event.from ? chest(event.from) : camera.position;
    const away = new THREE.Vector3(at.x - src.x, 0, at.z - src.z);
    if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
    away.normalize();
    // The point of contact: the near side of the body, not its middle.
    const contact = at.clone().addScaledVector(away, -0.22);
    contact.floor = (event.to && figureOf(event.to) ? figureOf(event.to).at.y : camera.position.y - 1.72) + 0.02;
    const place = where(contact);
    const toFig = figureOf(event.to);
    switch (event.kind) {
      case 'hit': {
        const strength = clamp(event.dam / Math.max(8, event.maxHp || 20) * 2.2, 0.3, 1.4);
        if (toFig) motion.react(toFig, 'hit', strength);
        // A blow on you is felt -- the shake, the vignette -- not seen as
        // debris hanging in front of your eye.
        if (event.to) {
          if (event.metal) spark(contact, away, strength);
          else flesh(contact, away, strength);
        }
        audio.impact && audio.impact(event.metal ? 'armour' : (event.attack === 'pound' || event.attack === 'crush' || !event.armed ? 'blunt' : 'flesh'), { ...place, strength });
        if (!event.to) {
          player.shake(clamp(0.25 + strength * 0.4, 0.25, 0.85));
          vm.jolt = 0.25;
        }
        break;
      }
      case 'miss':
        // A miss is a blow too: the one it missed leans out of its way, and
        // the blade passes through the air where they were.
        if (toFig) motion.react(toFig, 'evade');
        break;
      case 'parry': {
        if (toFig) motion.react(toFig, 'block');
        if (!event.to) vm.block = 0.45;
        spark(contact, away, 0.8);
        audio.clang && audio.clang({ ...place });
        break;
      }
      case 'dodge': {
        if (toFig) {
          motion.react(toFig, 'dodge');
          dust({ x: toFig.at.x, y: toFig.at.y, z: toFig.at.z }, 0.5);
        }
        if (!event.to) player.shake(0.12);
        audio.dodge && audio.dodge({ ...place });
        break;
      }
      case 'death': {
        if (event.player) { player.shake(0.9); break; }
        const p = { x: event.x, y: event.y, z: event.z };
        audio.death && audio.death(where(p));
        // The body meets the ground about three quarters of a second later.
        queue.push({ at: clock + 0.72, kind: 'fall', p });
        break;
      }
      default: break;
    }
    void fromFig;
  }

  // -- the frame --------------------------------------------------------------

  function update(dt) {
    clock += dt;

    // Start each opponent's first swing of the coming round early enough that
    // its contact frame lands on the pulse (and yours on yours).
    const vIn = game.violenceIn();
    if (vIn > lastViolence + 1) {
      for (const slot of game.mobs) slot.primedAt = undefined;
      vm.primedFor = null;
    }
    lastViolence = vIn;
    for (const slot of game.mobs) {
      if (slot.dead || !slot.instance || !slot.instance.fighting) continue;
      const fig = figureOf(slot);
      if (!fig) continue;
      const contactIn = vIn + MOB_BEAT;
      const clip = fig.clips && fig.clips.attack ? fig.clips.attack : 0.9;
      const windup = (fig.hitFrame && fig.hitFrame.attack ? fig.hitFrame.attack : 0.4) * clip;
      // How long the body has before it must start its next swing: the
      // footwork and feints between blows (motion.js fidget) fit inside it.
      const swinging = game.willSwing(slot);
      const primedNow = slot.primedAt !== undefined && clock < slot.primedAt + 0.3;
      fig.m.swingIn = !swinging ? 9 : (primedNow ? 0 : contactIn - windup);
      if (slot.primedAt !== undefined || !swinging) continue;
      if (contactIn <= windup + 0.02) {
        motion.strike(fig, 'attack', contactIn);
        slot.primedAt = clock + contactIn;
      }
    }
    if (vm.primedFor === null && game.playerWillSwing() && vIn <= 0.34) {
      vm.strike(vIn);
      vm.primedFor = clock + vIn;
    }

    for (let i = queue.length - 1; i >= 0; i--) {
      const item = queue[i];
      if (item.at > clock) continue;
      queue.splice(i, 1);
      if (item.kind === 'land') land(item.event);
      else if (item.kind === 'whoosh') {
        const e = item.event;
        const p = e.from ? chest(e.from) : camera.position;
        audio.whoosh && audio.whoosh({ ...where(p), weight: e.armed ? 1 : 0.6, miss: e.kind === 'miss' });
      } else if (item.kind === 'fall') {
        dust(item.p, 1.2);
        audio.bodyfall && audio.bodyfall(where(item.p));
      }
    }

    sparks.update(dt);
    streaks.update(dt);
    matter.update(dt);
    const h = composer.renderTarget1 ? composer.renderTarget1.height : window.innerHeight;
    const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    sparks.material.uniforms.scale.value = scale;
    matter.material.uniforms.scale.value = scale;

    // The weapon in your hand, from what you are actually wielding.
    const s = game.state;
    // A foe low in the frame draws the view down to it (player.js).
    const foeFig = s.fighting && s.fighting.slot ? figureOf(s.fighting.slot) : null;
    if (foeFig && !foeFig.m.dead) {
      player.lookAssist = player.lookAssist || new THREE.Vector3();
      player.lookAssist.set(foeFig.at.x, foeFig.at.y + foeFig.height * 0.6, foeFig.at.z);
    } else player.lookAssist = null;
    const wield = s.equipment[WEAR.WIELD];
    const shield = s.equipment[WEAR.SHIELD];
    vm.equip(weaponKind(wield), shield ? (/kite|tower|heater/i.test(shield.name) ? 'kite' : 'round') : null);
    const room = built.rooms.get(s.roomVnum);
    vm.light(sun, hemi, scene, room ? !room.outdoor : false, lightPool);
    vm.update(dt, player, !!s.fighting);
  }

  return {
    update,
    /** 0 at night to 1 at noon: dark matter (dust, droplets) is lit by the hour. */
    setAmbient(k) { ambient = clamp(0.18 + k * 0.82, 0.18, 1); },
    viewModel: vm,
    particles: { sparks, streaks, matter },
    pass,
    dispose() { unlisten(); },
  };
}
