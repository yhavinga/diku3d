/**
 * Everything that isn't architecture: the mobiles and objects the reset table
 * puts in each room, plus the fire, foliage, water and signage that make a
 * street look inhabited.
 *
 * Figures are assembled from capsules and spheres, coloured from the mobile's
 * own keywords and level, then merged down to two meshes each (body, head) so a
 * crowded market square still costs only a handful of draw calls.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEM, ACT_AGGRESSIVE, ACT_SENTINEL } from './are.js';
import { hash3 } from './build.js';

const SKIN = [0xe8c39e, 0xd9a877, 0xb5834f, 0x8a5a33, 0x6d4526, 0xc9b7a0];
const CLOTH = [
  0x6b3f3f, 0x3f4f6b, 0x4a5c3a, 0x6b5b3f, 0x4b3b52, 0x5c5c5c,
  0x7a5230, 0x2f4858, 0x71614a, 0x8a3b3b,
];

const strHash = (s, salt = 0) => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
};

// ----------------------------------------------------------------- labels ----

const labelCache = new Map();
function labelTexture(text, { size = 44, colour = '#f3e6cf', accent = 'rgba(12,10,8,0.72)' } = {}) {
  const key = `${text}|${size}|${colour}`;
  if (labelCache.has(key)) return labelCache.get(key);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `${size}px "Iowan Old Style", "Palatino Linotype", Georgia, serif`;
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + 40;
  canvas.width = THREE.MathUtils.ceilPowerOfTwo(width);
  canvas.height = THREE.MathUtils.ceilPowerOfTwo(size * 2);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = accent;
  const pad = 10;
  roundRect(ctx, (canvas.width - width) / 2, canvas.height / 2 - size * 0.72, width, size * 1.44, pad);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const record = { texture, aspect: canvas.width / canvas.height };
  labelCache.set(key, record);
  return record;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function makeLabel(text, height = 0.5, options) {
  const { texture, aspect } = labelTexture(text, options);
  const material = new THREE.SpriteMaterial({
    map: texture, transparent: true, depthWrite: false, sizeAttenuation: true, fog: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(height * aspect, height, 1);
  return sprite;
}

// ---------------------------------------------------------------- figures ----

function pushPart(parts, geometry, colour, matrix) {
  const geo = geometry.clone().applyMatrix4(matrix);
  const count = geo.attributes.position.count;
  const col = new Float32Array(count * 3);
  const c = new THREE.Color(colour);
  for (let i = 0; i < count; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  parts.push(geo);
}

const G = {
  capsule: (r, len, seg = 8) => new THREE.CapsuleGeometry(r, len, 3, seg),
  sphere: (r, seg = 12) => new THREE.SphereGeometry(r, seg, seg * 0.75),
  cone: (r, h, seg = 10) => new THREE.ConeGeometry(r, h, seg),
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  cylinder: (r1, r2, h, seg = 10) => new THREE.CylinderGeometry(r1, r2, h, seg),
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();

function at(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return _m.compose(_p, _q, _s);
}

const figureMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.82, metalness: 0.05,
});
const metalMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.35, metalness: 0.85,
});

/**
 * Build a body from the mobile's own words: a guard gets a helmet and a spear,
 * a wizard a robe and a staff, a baker an apron. It's a guess, but it's the
 * area author's vocabulary doing the guessing.
 */
function figureTraits(proto) {
  const words = `${proto.keywords} ${proto.short}`.toLowerCase();
  const has = (re) => re.test(words);
  const seed = strHash(proto.keywords, proto.vnum);

  const traits = {
    scale: 1,
    skin: SKIN[Math.floor(strHash(proto.keywords, 7) * SKIN.length)],
    cloth: CLOTH[Math.floor(seed * CLOTH.length)],
    trim: 0x3a3128,
    helmet: false, hood: false, robe: false, apron: false, cloak: false,
    weapon: null, shield: false, beard: false, hair: true,
  };

  if (has(/guard|soldier|knight|patrol|watch|legion|warrior|sentry/)) { traits.helmet = true; traits.weapon = 'spear'; traits.cloth = 0x4a4f57; traits.trim = 0x8d8f94; }
  if (has(/wizard|mage|sorcer|magi|witch|warlock/)) { traits.robe = true; traits.hood = true; traits.weapon = 'staff'; traits.cloth = 0x2f2a4a; }
  if (has(/cleric|priest|monk|acolyte|nun|abbot|bishop/)) { traits.robe = true; traits.hood = true; traits.cloth = 0x6a6152; }
  if (has(/baker|grocer|cook|butcher|barkeep|bartender|innkeep|waiter|maid/)) { traits.apron = true; traits.cloth = 0x8b7f6b; }
  if (has(/smith|armour|armor|weapon/)) { traits.apron = true; traits.cloth = 0x5a4230; traits.weapon = 'hammer'; traits.beard = true; }
  if (has(/thief|rogue|beggar|drunk|bum|urchin|cutpurse/)) { traits.hood = true; traits.cloth = 0x4a4239; }
  if (has(/king|lord|mayor|noble|duke|queen|lady/)) { traits.cloak = true; traits.cloth = 0x6b2f3f; traits.trim = 0xc8a24f; }
  if (has(/dwarf|dwarv/)) { traits.scale = 0.72; traits.beard = true; }
  if (has(/child|kid|boy|girl|pupil|smurf|gnome|hobbit/)) traits.scale = 0.66;
  if (has(/giant|ogre|troll|golem|titan/)) { traits.scale = 1.55; traits.skin = 0x6b7a5c; traits.hair = false; }
  if (has(/executioner|headsman/)) { traits.hood = true; traits.cloth = 0x2b2320; traits.weapon = 'axe'; }
  if (has(/skeleton|zombie|ghoul|wraith|ghost|spectre|spirit/)) { traits.skin = 0xd6d2c4; traits.cloth = 0x3b3a36; traits.hair = false; }

  for (const item of proto.equipment || []) {
    if (item.proto.itemType === ITEM.WEAPON) traits.weapon = traits.weapon || 'sword';
    if (item.wearLoc === 11) traits.shield = true;
    if (item.wearLoc === 6) traits.helmet = true;
  }
  if (proto.level > 25) traits.cloak = true;
  traits.scale *= 0.92 + strHash(proto.short, 3) * 0.18;
  return traits;
}

function buildFigure(proto) {
  const t = figureTraits(proto);
  const body = [];
  const head = [];
  const metal = [];
  const s = t.scale;
  const hip = 0.95 * s;
  const shoulder = 1.5 * s;

  pushPart(body, G.capsule(0.11 * s, 0.62 * s), t.cloth, at(-0.14 * s, hip - 0.42 * s, 0));
  pushPart(body, G.capsule(0.11 * s, 0.62 * s), t.cloth, at(0.14 * s, hip - 0.42 * s, 0));
  pushPart(body, G.box(0.26 * s, 0.1 * s, 0.34 * s), 0x2c231b, at(-0.14 * s, 0.05 * s, 0.04 * s));
  pushPart(body, G.box(0.26 * s, 0.1 * s, 0.34 * s), 0x2c231b, at(0.14 * s, 0.05 * s, 0.04 * s));

  // torso
  pushPart(body, G.capsule(0.2 * s, 0.42 * s), t.cloth, at(0, hip + 0.2 * s, 0, 0, 0, 0, 1.15, 1, 0.8));
  if (t.robe) pushPart(body, G.cone(0.42 * s, 1.15 * s, 12), t.cloth, at(0, hip - 0.32 * s, 0));
  if (t.apron) pushPart(body, G.box(0.36 * s, 0.6 * s, 0.05 * s), 0xd8cdb4, at(0, hip + 0.02 * s, 0.19 * s));
  if (t.cloak) pushPart(body, G.cone(0.36 * s, 0.95 * s, 10), t.trim, at(0, hip + 0.12 * s, -0.1 * s, 0.12));

  // arms
  for (const side of [-1, 1]) {
    pushPart(body, G.capsule(0.075 * s, 0.5 * s), t.cloth,
      at(side * 0.29 * s, shoulder - 0.42 * s, 0, 0, 0, side * 0.1));
    pushPart(body, G.sphere(0.075 * s, 8), t.skin, at(side * 0.32 * s, shoulder - 0.72 * s, 0));
  }

  // head
  pushPart(head, G.capsule(0.115 * s, 0.08 * s), t.skin, at(0, 0, 0, 0, 0, 0, 1, 1.05, 0.95));
  pushPart(head, G.box(0.06 * s, 0.03 * s, 0.03 * s), 0x1b1613, at(-0.05 * s, 0.03 * s, 0.11 * s));
  pushPart(head, G.box(0.06 * s, 0.03 * s, 0.03 * s), 0x1b1613, at(0.05 * s, 0.03 * s, 0.11 * s));
  if (t.beard) pushPart(head, G.sphere(0.1 * s, 8), 0x9a9188, at(0, -0.08 * s, 0.05 * s, 0, 0, 0, 1, 0.8, 0.8));
  else if (t.hair) pushPart(head, G.sphere(0.125 * s, 10), 0x2e241c, at(0, 0.03 * s, -0.01 * s, 0, 0, 0, 1, 0.85, 1));
  if (t.hood) pushPart(head, G.cone(0.19 * s, 0.34 * s, 10), t.cloth, at(0, 0.06 * s, -0.03 * s, -0.25));
  if (t.helmet) pushPart(metal, G.sphere(0.145 * s, 10), t.trim, at(0, 0.05 * s, 0, 0, 0, 0, 1, 0.85, 1));

  // hand-held gear
  const hand = new THREE.Vector3(0.34 * s, shoulder - 0.78 * s, 0.06 * s);
  switch (t.weapon) {
    case 'spear':
      pushPart(body, G.cylinder(0.03 * s, 0.03 * s, 2.1 * s, 6), 0x53402c, at(hand.x, hand.y + 0.75 * s, hand.z));
      pushPart(metal, G.cone(0.07 * s, 0.3 * s, 6), 0xb8bcc0, at(hand.x, hand.y + 1.9 * s, hand.z));
      break;
    case 'staff':
      pushPart(body, G.cylinder(0.035 * s, 0.045 * s, 1.9 * s, 6), 0x4a3a26, at(hand.x, hand.y + 0.7 * s, hand.z, 0, 0, 0.06));
      pushPart(metal, G.sphere(0.09 * s, 10), 0x9fd8e6, at(hand.x + 0.06 * s, hand.y + 1.66 * s, hand.z));
      break;
    case 'hammer':
      pushPart(body, G.cylinder(0.035 * s, 0.035 * s, 0.7 * s, 6), 0x53402c, at(hand.x, hand.y - 0.2 * s, hand.z));
      pushPart(metal, G.box(0.2 * s, 0.16 * s, 0.16 * s), 0x6f7377, at(hand.x, hand.y - 0.55 * s, hand.z));
      break;
    case 'axe':
      pushPart(body, G.cylinder(0.04 * s, 0.04 * s, 1.5 * s, 6), 0x4a3a26, at(hand.x, hand.y + 0.4 * s, hand.z));
      pushPart(metal, G.box(0.06 * s, 0.42 * s, 0.3 * s), 0xa9adb2, at(hand.x + 0.1 * s, hand.y + 1.05 * s, hand.z));
      break;
    case 'sword':
      pushPart(metal, G.box(0.055 * s, 0.9 * s, 0.14 * s), 0xc2c6cb, at(hand.x, hand.y - 0.4 * s, hand.z));
      pushPart(body, G.box(0.05 * s, 0.16 * s, 0.09 * s), 0x3a2b1d, at(hand.x, hand.y + 0.12 * s, hand.z));
      break;
    default: break;
  }
  if (t.shield) {
    pushPart(metal, G.cylinder(0.28 * s, 0.28 * s, 0.06 * s, 12), 0x7a5a3a,
      at(-0.4 * s, shoulder - 0.55 * s, 0.1 * s, Math.PI / 2, 0, 0.25));
  }

  const group = new THREE.Group();
  const bodyMesh = new THREE.Mesh(mergeGeometries(body, false), figureMaterial);
  bodyMesh.castShadow = true;
  group.add(bodyMesh);
  if (metal.length) {
    const metalMesh = new THREE.Mesh(mergeGeometries(metal, false), metalMaterial);
    metalMesh.castShadow = true;
    group.add(metalMesh);
  }
  const headGroup = new THREE.Group();
  headGroup.position.set(0, shoulder + 0.12 * s, 0);
  const headMesh = new THREE.Mesh(mergeGeometries(head, false), figureMaterial);
  headMesh.castShadow = true;
  headGroup.add(headMesh);
  group.add(headGroup);

  return { group, headGroup, height: shoulder + 0.35 * s, scale: s };
}

// ---------------------------------------------------------------- objects ----

const propMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 });
const shinyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.9 });
const glassMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.75,
});

function buildObject(proto) {
  const parts = []; const metal = []; const glass = [];
  const seed = strHash(proto.keywords, proto.vnum);
  const wood = 0x6b4d31;

  switch (proto.itemType) {
    case ITEM.WEAPON:
      pushPart(metal, G.box(0.05, 0.95, 0.12), 0xc4c8cd, at(0, 0.55, 0, 0, 0, 1.3));
      pushPart(parts, G.box(0.05, 0.2, 0.08), 0x3a2b1d, at(-0.42, 0.12, 0, 0, 0, 1.3));
      break;
    case ITEM.ARMOR:
      pushPart(metal, G.capsule(0.24, 0.2, 10), 0x8d9298, at(0, 0.3, 0, 0.3, 0, 0, 1.1, 1, 0.75));
      break;
    case ITEM.CONTAINER:
      pushPart(parts, G.box(0.75, 0.45, 0.5), wood, at(0, 0.22, 0));
      pushPart(metal, G.box(0.78, 0.06, 0.53), 0x4a4a4a, at(0, 0.45, 0));
      pushPart(metal, G.box(0.08, 0.12, 0.55), 0x6a6a6a, at(0, 0.3, 0));
      break;
    case ITEM.DRINK_CON:
      pushPart(parts, G.cylinder(0.28, 0.24, 0.7, 12), wood, at(0, 0.35, 0));
      pushPart(metal, G.cylinder(0.29, 0.29, 0.05, 12), 0x50504a, at(0, 0.5, 0));
      pushPart(metal, G.cylinder(0.29, 0.29, 0.05, 12), 0x50504a, at(0, 0.2, 0));
      break;
    case ITEM.POTION: case ITEM.PILL:
      pushPart(glass, G.sphere(0.12, 10), 0x6fd0c0, at(0, 0.14, 0));
      pushPart(glass, G.cylinder(0.04, 0.05, 0.12, 8), 0x6fd0c0, at(0, 0.29, 0));
      pushPart(parts, G.cylinder(0.045, 0.045, 0.05, 8), 0x6b4a2c, at(0, 0.37, 0));
      break;
    case ITEM.SCROLL:
      pushPart(parts, G.cylinder(0.06, 0.06, 0.42, 10), 0xd9cba6, at(0, 0.07, 0, 0, 0, Math.PI / 2));
      break;
    case ITEM.WAND: case ITEM.STAFF:
      pushPart(parts, G.cylinder(0.035, 0.045, 1.1, 8), 0x4a3a26, at(0, 0.55, 0, 0, 0, 0.1));
      pushPart(metal, G.sphere(0.08, 10), 0x9fd8e6, at(0.06, 1.1, 0));
      break;
    case ITEM.TREASURE: case ITEM.MONEY:
      for (let i = 0; i < 7; i++) {
        const a = seed * 6 + i;
        pushPart(metal, G.cylinder(0.07, 0.07, 0.02, 10), 0xd8b445,
          at(Math.cos(a) * 0.12, 0.02 + i * 0.012, Math.sin(a) * 0.12, 0, a, 0));
      }
      break;
    case ITEM.FOUNTAIN:
      pushPart(parts, G.cylinder(1.5, 1.7, 0.55, 20), 0x8e8a80, at(0, 0.27, 0));
      pushPart(parts, G.cylinder(1.25, 1.25, 0.5, 20), 0x6d6a63, at(0, 0.55, 0));
      pushPart(parts, G.cylinder(0.22, 0.3, 1.1, 12), 0x9a968c, at(0, 1.0, 0));
      pushPart(parts, G.sphere(0.34, 12), 0xa8a49a, at(0, 1.6, 0));
      break;
    case ITEM.FURNITURE:
      pushPart(parts, G.box(1.6, 0.12, 0.8), wood, at(0, 0.85, 0));
      for (const [ox, oz] of [[-0.7, -0.3], [0.7, -0.3], [-0.7, 0.3], [0.7, 0.3]]) {
        pushPart(parts, G.box(0.1, 0.85, 0.1), 0x4a3421, at(ox, 0.42, oz));
      }
      break;
    case ITEM.LIGHT:
      pushPart(parts, G.cylinder(0.06, 0.08, 0.5, 8), 0x4a3a26, at(0, 0.25, 0));
      pushPart(parts, G.sphere(0.1, 8), 0xffb066, at(0, 0.55, 0));
      break;
    case ITEM.FOOD:
      pushPart(parts, G.sphere(0.16, 10), 0xb98a4e, at(0, 0.15, 0, 0, 0, 0, 1.2, 0.7, 1));
      break;
    case ITEM.KEY:
      pushPart(metal, G.cylinder(0.02, 0.02, 0.28, 6), 0x9a8b5a, at(0, 0.05, 0, 0, 0, Math.PI / 2));
      pushPart(metal, G.cylinder(0.06, 0.06, 0.02, 10), 0x9a8b5a, at(-0.16, 0.05, 0, Math.PI / 2, 0, 0));
      break;
    case ITEM.CORPSE_NPC: case ITEM.CORPSE_PC: case ITEM.TRASH:
      pushPart(parts, G.capsule(0.2, 0.6, 8), 0x5a5248, at(0, 0.2, 0, 0, seed * 3, Math.PI / 2));
      break;
    case ITEM.BOAT:
      pushPart(parts, G.capsule(0.6, 2.2, 8), wood, at(0, 0.4, 0, 0, 0, Math.PI / 2, 1, 1, 0.5));
      break;
    default:
      pushPart(parts, G.box(0.35, 0.35, 0.35), 0x7a6a55, at(0, 0.18, 0, 0, seed * 3, 0));
      break;
  }

  const group = new THREE.Group();
  if (parts.length) group.add(new THREE.Mesh(mergeGeometries(parts, false), propMaterial));
  if (metal.length) group.add(new THREE.Mesh(mergeGeometries(metal, false), shinyMaterial));
  if (glass.length) group.add(new THREE.Mesh(mergeGeometries(glass, false), glassMaterial));
  for (const child of group.children) { child.castShadow = true; child.receiveShadow = true; }
  return group;
}

// ------------------------------------------------------------------ flame ----

// Billboarded: the quad is built in view space around the instance origin, so
// a flame always faces you however you walk around the sconce.
const FLAME_VERT = `
  attribute float seed;
  varying vec2 vUv;
  varying float vSeed;
  uniform float time;
  void main() {
    vUv = uv;
    vSeed = seed;
    vec3 pos = position;
    float flick = sin(time * 11.0 + seed * 30.0) * 0.5 + sin(time * 17.0 + seed * 11.0) * 0.5;
    pos.x += flick * 0.05 * uv.y;
    pos.y *= 1.0 + flick * 0.14;
    float scale = length(instanceMatrix[0].xyz);
    vec4 origin = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 mv = modelViewMatrix * origin;
    mv.xy += pos.xy * scale;
    gl_Position = projectionMatrix * mv;
  }`;

const FLAME_FRAG = `
  varying vec2 vUv;
  varying float vSeed;
  uniform float time;
  void main() {
    vec2 p = vUv - vec2(0.5, 0.0);
    float taper = smoothstep(1.0, 0.15, vUv.y);
    float body = 1.0 - smoothstep(0.0, 0.34 * taper, abs(p.x));
    float alpha = body * smoothstep(1.0, 0.55, vUv.y) * smoothstep(0.0, 0.1, vUv.y);
    if (alpha < 0.02) discard;
    vec3 hot = vec3(1.0, 0.92, 0.62);
    vec3 mid = vec3(1.0, 0.55, 0.16);
    vec3 cool = vec3(0.75, 0.16, 0.03);
    vec3 colour = mix(hot, mid, smoothstep(0.0, 0.5, vUv.y));
    colour = mix(colour, cool, smoothstep(0.45, 1.0, vUv.y));
    gl_FragColor = vec4(colour * (1.6 + sin(time * 13.0 + vSeed * 20.0) * 0.25), alpha);
  }`;

function makeFlames(count) {
  const geo = new THREE.PlaneGeometry(0.34, 0.62);
  geo.translate(0, 0.31, 0);
  const material = new THREE.ShaderMaterial({
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    uniforms: { time: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const mesh = new THREE.InstancedMesh(geo, material, count);
  mesh.frustumCulled = false;
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) seeds[i] = Math.random();
  mesh.geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 1));
  return { mesh, material };
}

// ------------------------------------------------------------------ water ----

const WATER_VERT = `
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const WATER_FRAG = `
  uniform float time;
  uniform vec3 shallow;
  uniform vec3 deep;
  uniform vec3 skyColour;
  varying vec3 vWorld;
  varying vec2 vUv;
  float wave(vec2 p, float t) {
    return sin(p.x * 1.7 + t) * 0.5 + sin(p.y * 2.3 - t * 1.3) * 0.3 + sin((p.x + p.y) * 3.1 + t * 0.7) * 0.2;
  }
  void main() {
    vec2 p = vWorld.xz * 0.35;
    float h = wave(p, time * 1.1);
    vec2 grad = vec2(
      wave(p + vec2(0.06, 0.0), time * 1.1) - h,
      wave(p + vec2(0.0, 0.06), time * 1.1) - h);
    vec3 normal = normalize(vec3(-grad.x * 6.0, 1.0, -grad.y * 6.0));
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
    vec3 base = mix(deep, shallow, h * 0.5 + 0.5);
    vec3 colour = mix(base, skyColour, clamp(fresnel * 1.3, 0.0, 0.9));
    float spec = pow(max(dot(reflect(-viewDir, normal), normalize(vec3(0.4, 0.8, 0.2))), 0.0), 48.0);
    gl_FragColor = vec4(colour + spec * 0.8, 0.88);
  }`;

// ------------------------------------------------------------------ smoke ----

function smokeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ------------------------------------------------------------------- main ----

export function populate(world, layout, built, options = {}) {
  const group = new THREE.Group();
  group.name = 'actors';
  const interactables = [];
  const updaters = [];

  const trees = [];
  const windows = [];
  const flames = [];
  const smokes = [];
  const waters = [];
  const clutter = [];
  const banners = [];
  const tables = [];

  // --- mobiles ------------------------------------------------------------

  const figures = [];
  for (const [vnum, info] of built.rooms) {
    const room = world.rooms.get(vnum);
    if (!room || !room.mobs.length) continue;
    const count = room.mobs.length;
    room.mobs.forEach((mob, index) => {
      const proto = { ...mob.proto, equipment: mob.equipment };
      const { group: fig, headGroup, height } = buildFigure(proto);
      // Never at the centre of the room: that is where you arrive.
      const angle = (index / count) * Math.PI * 2 + strHash(mob.proto.keywords, 1) * 2;
      const radius = 2.1 + strHash(mob.proto.short, 2) * 1.5;
      fig.position.set(
        info.center.x + Math.cos(angle) * radius,
        info.center.y,
        info.center.z + Math.sin(angle) * radius,
      );
      fig.rotation.y = -angle + Math.PI / 2;
      group.add(fig);

      const label = makeLabel(mob.proto.short, 0.42);
      label.position.set(0, height + 0.42, 0);
      label.visible = false;
      fig.add(label);

      const aggressive = !!(mob.proto.act & ACT_AGGRESSIVE);
      figures.push({
        object: fig, head: headGroup, label, home: fig.position.clone(),
        phase: strHash(mob.proto.short, 5) * 6.28, aggressive,
        sentinel: !!(mob.proto.act & ACT_SENTINEL),
        drift: 0.35 + strHash(mob.proto.keywords, 9) * 0.5,
      });

      interactables.push({
        position: fig.position.clone().setY(fig.position.y + height * 0.6),
        radius: 2.6,
        title: mob.proto.short,
        subtitle: `level ${mob.proto.level}${mob.shop ? ' · shopkeeper' : ''}${aggressive ? ' · aggressive' : ''}`,
        body: mob.proto.description.trim() || mob.proto.long,
        kind: 'mob',
      });

      if (mob.shop) {
        const sign = makeLabel(shopSign(mob.proto.short), 0.6, { colour: '#f0d9a8' });
        sign.position.set(0, height + 1.15, 0);
        fig.add(sign);
      }
    });
  }

  // --- objects on the ground ---------------------------------------------

  for (const [vnum, info] of built.rooms) {
    const room = world.rooms.get(vnum);
    if (!room || !room.items.length) continue;
    room.items.forEach((item, index) => {
      const mesh = buildObject(item.proto);
      const angle = strHash(item.proto.keywords, index + 3) * Math.PI * 2;
      const radius = item.proto.itemType === ITEM.FOUNTAIN ? 0 : 2.4 + strHash(item.proto.short, index) * 2.4;
      mesh.position.set(
        info.center.x + Math.cos(angle) * radius,
        info.center.y,
        info.center.z + Math.sin(angle) * radius,
      );
      mesh.rotation.y = strHash(item.proto.short, 11) * Math.PI * 2;
      group.add(mesh);
      interactables.push({
        position: mesh.position.clone().setY(mesh.position.y + 0.6),
        radius: 2.0,
        title: item.proto.short,
        subtitle: item.contents.length ? `contains ${item.contents.length} item(s)` : '',
        body: item.proto.description || item.proto.long,
        kind: 'item',
      });
      // Anything you'd bump into gets a box, so the fountain in the middle of
      // the square is something you walk around rather than stand inside.
      const solid = { [ITEM.FOUNTAIN]: 1.7, [ITEM.FURNITURE]: 0.9, [ITEM.CONTAINER]: 0.5, [ITEM.BOAT]: 1.2 }[item.proto.itemType];
      if (solid) {
        built.colliders.push({
          x0: mesh.position.x - solid, x1: mesh.position.x + solid,
          z0: mesh.position.z - solid, z1: mesh.position.z + solid,
          y0: mesh.position.y, y1: mesh.position.y + 1.6,
        });
      }
      if (item.proto.itemType === ITEM.FOUNTAIN) {
        waters.push({ x: mesh.position.x, y: mesh.position.y + 0.62, z: mesh.position.z, size: 2.4 });
      }
    });
  }

  // --- decor from the builder ---------------------------------------------

  for (const item of built.decor) {
    switch (item.kind) {
      case 'torch': flames.push(item); break;
      case 'lamp': flames.push({ ...item, y: item.y + 4.3, lamp: true }); break;
      case 'tree': trees.push(item); break;
      case 'windows': windows.push(item); break;
      case 'smoke': smokes.push(item); break;
      case 'water': waters.push(item); break;
      case 'clutter': clutter.push(item); break;
      case 'banner': banners.push(item); break;
      case 'table': tables.push(item); break;
      case 'gateSign': {
        const sign = makeLabel(`${item.text} — beyond the map`, 0.55, { colour: '#cbb994' });
        sign.position.set(item.x, item.y, item.z);
        group.add(sign);
        break;
      }
      default: break;
    }
  }

  // barrels, crates and hay against the walls, a table where there's a floor
  // of boards, a banner where the room sounds like a hall.
  {
    const props = [];
    for (const item of clutter) {
      const kinds = Math.floor(item.seed * 3);
      for (let i = 0; i < 2 + Math.floor(item.seed * 3); i++) {
        const a = strHash(`${item.x},${item.z}`, i) * Math.PI * 2;
        const r = 3.2 + strHash(`${item.z}`, i) * 2.2;
        const px = item.x + Math.cos(a) * r;
        const pz = item.z + Math.sin(a) * r;
        const spin = strHash(`${item.x}`, i + 9) * Math.PI;
        if ((kinds + i) % 3 === 0) {
          pushPart(props, G.cylinder(0.32, 0.28, 0.82, 12), 0x6b4d31, at(px, item.y + 0.41, pz, 0, spin, 0));
          pushPart(props, G.cylinder(0.335, 0.335, 0.06, 12), 0x40403a, at(px, item.y + 0.62, pz));
          pushPart(props, G.cylinder(0.335, 0.335, 0.06, 12), 0x40403a, at(px, item.y + 0.2, pz));
        } else if ((kinds + i) % 3 === 1) {
          const sz = 0.5 + strHash(`${px}`, i) * 0.3;
          pushPart(props, G.box(sz, sz, sz), 0x7a5c3a, at(px, item.y + sz / 2, pz, 0, spin, 0));
        } else {
          pushPart(props, G.cylinder(0.45, 0.45, 0.55, 10), 0xa08a4a, at(px, item.y + 0.28, pz, 0, spin, 0));
        }
      }
    }
    for (const item of tables) {
      pushPart(props, G.box(1.5, 0.1, 0.75), 0x6b4d31, at(item.x, item.y + 0.78, item.z));
      for (const [ox, oz] of [[-0.62, -0.28], [0.62, -0.28], [-0.62, 0.28], [0.62, 0.28]]) {
        pushPart(props, G.box(0.09, 0.78, 0.09), 0x4a3421, at(item.x + ox, item.y + 0.39, item.z + oz));
      }
      for (const s of [-1, 1]) {
        pushPart(props, G.box(0.5, 0.08, 0.4), 0x5c4227, at(item.x + s * 1.1, item.y + 0.45, item.z));
        pushPart(props, G.box(0.08, 0.45, 0.08), 0x4a3421, at(item.x + s * 1.1, item.y + 0.22, item.z));
      }
    }
    for (const item of banners) {
      const [dx, , dz] = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]][item.dir];
      const ry = (item.dir === 1 || item.dir === 3) ? Math.PI / 2 : 0;
      for (const s of [-1.7, 1.7]) {
        const bx = item.x + dx * 4.7 + (dx ? 0 : s);
        const bz = item.z + dz * 4.7 + (dz ? 0 : s);
        pushPart(props, G.box(1.1, 2.4, 0.06), 0xb04a52, at(bx, item.y + 3.1, bz, 0, ry, 0));
        pushPart(props, G.box(1.4, 0.11, 0.11), 0xc0a765, at(bx, item.y + 4.35, bz, 0, ry, 0));
      }
    }
    if (props.length) {
      const mesh = new THREE.Mesh(mergeGeometries(props, false), propMaterial);
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  // torch brackets and lamp posts (static geometry, one merged mesh each)
  {
    const brackets = [];
    const posts = [];
    for (const f of flames) {
      if (f.lamp) {
        pushPart(posts, G.cylinder(0.09, 0.13, 4.3, 8), 0x2f2b26, at(f.x, f.y - 2.15, f.z));
        pushPart(posts, G.box(0.42, 0.5, 0.42), 0x1f1d1a, at(f.x, f.y + 0.12, f.z));
        pushPart(posts, G.cone(0.34, 0.3, 4), 0x1f1d1a, at(f.x, f.y + 0.5, f.z, 0, Math.PI / 4, 0));
      } else {
        pushPart(brackets, G.cylinder(0.045, 0.045, 0.5, 6), 0x2f2b26, at(f.x, f.y - 0.1, f.z, 0.5, f.rotY || 0, 0));
        pushPart(brackets, G.cylinder(0.075, 0.055, 0.34, 8), 0x33251a, at(f.x, f.y + 0.12, f.z));
      }
    }
    if (brackets.length) group.add(new THREE.Mesh(mergeGeometries(brackets, false), propMaterial));
    if (posts.length) group.add(new THREE.Mesh(mergeGeometries(posts, false), propMaterial));
  }

  // --- flames -------------------------------------------------------------

  let flameSystem = null;
  if (flames.length) {
    flameSystem = makeFlames(flames.length);
    const dummy = new THREE.Object3D();
    flames.forEach((f, i) => {
      dummy.position.set(f.x, f.y + (f.lamp ? 0.05 : 0.2), f.z);
      dummy.scale.setScalar(f.lamp ? 1.15 : 1);
      dummy.updateMatrix();
      flameSystem.mesh.setMatrixAt(i, dummy.matrix);
    });
    flameSystem.mesh.instanceMatrix.needsUpdate = true;
    group.add(flameSystem.mesh);
  }

  // --- trees --------------------------------------------------------------

  if (trees.length) {
    const trunkGeo = G.cylinder(0.22, 0.34, 4.2, 7);
    trunkGeo.translate(0, 2.1, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ map: options.materials?.bark?.map, roughness: 0.95, color: 0x6a5540 });
    const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const canopyGeo = mergeGeometries([
      G.sphere(1.7, 9).translate(0, 5.0, 0),
      G.sphere(1.25, 9).translate(1.1, 4.1, 0.5),
      G.sphere(1.15, 9).translate(-0.9, 4.4, -0.7),
    ], false);
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x3f5a2c, roughness: 0.95, flatShading: true });
    const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, trees.length);
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    trees.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.y = strHash(`${t.x},${t.z}`, 4) * 6.28;
      dummy.scale.setScalar(t.scale);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
      canopy.setMatrixAt(i, dummy.matrix);
      tint.setHSL(0.24 + strHash(`${t.x}`, i) * 0.08, 0.42, 0.24 + strHash(`${t.z}`, i) * 0.12);
      canopy.setColorAt(i, tint);
    });
    trunk.castShadow = true; canopy.castShadow = true; canopy.receiveShadow = true;
    trunk.instanceMatrix.needsUpdate = true;
    canopy.instanceMatrix.needsUpdate = true;
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    group.add(trunk, canopy);
  }

  // --- lit windows --------------------------------------------------------

  if (windows.length) {
    const panes = [];
    const frames = [];
    const PANE_W = 1.4;
    const PANE_H = 1.7;
    // The buildings are solid boxes, so a window is something laid onto the
    // face: the lit pane just proud of the wall, its frame and sill proud of
    // that. Read from a step away it sits in the wall convincingly enough.
    const FACES = [
      { nx: 0, nz: 1, ry: 0 }, { nx: 0, nz: -1, ry: Math.PI },
      { nx: 1, nz: 0, ry: Math.PI / 2 }, { nx: -1, nz: 0, ry: -Math.PI / 2 },
    ];
    for (const w of windows) {
      const rows = Math.max(1, Math.floor((w.h - 1.4) / 2.6));
      for (const f of FACES) {
        const tx = f.nz; const tz = -f.nx;
        const span = (f.nx ? w.d : w.w);
        const cols = Math.max(1, Math.floor(span / 3.6));
        const cx = w.x + f.nx * (w.w / 2);
        const cz = w.z + f.nz * (w.d / 2);
        for (let row = 0; row < rows; row++) {
          const y = w.y + 1.8 + row * 2.6;
          if (y > w.y + w.h - 0.9) continue;
          for (let c = 0; c < cols; c++) {
            const spread = (c - (cols - 1) / 2) * (span / cols);
            if (row === 0 && Math.abs(spread) < 1.5 && w.doorSides) continue; // that is the doorway
            const px = cx + tx * spread;
            const pz = cz + tz * spread;
            const out = (o) => at(px + f.nx * o, y, pz + f.nz * o, 0, f.ry, 0);
            const lit = hash3(Math.round(px * 4), Math.round(y * 4), Math.round(pz * 4), 71) > 0.42;
            pushPart(lit ? panes : frames, G.box(PANE_W, PANE_H, 0.12), lit ? 0xffc47e : 0x14110e, out(0.06));
            for (const s of [-1, 1]) {
              pushPart(frames, G.box(0.16, PANE_H + 0.3, 0.22), 0x36291d, at(px + tx * s * (PANE_W / 2 + 0.08) + f.nx * 0.1, y, pz + tz * s * (PANE_W / 2 + 0.08) + f.nz * 0.1, 0, f.ry, 0));
            }
            pushPart(frames, G.box(PANE_W + 0.3, 0.16, 0.22), 0x36291d,
              at(px + f.nx * 0.1, y + PANE_H / 2 + 0.08, pz + f.nz * 0.1, 0, f.ry, 0));
            pushPart(frames, G.box(PANE_W + 0.5, 0.14, 0.36), 0x594a38, at(px + f.nx * 0.16, y - PANE_H / 2 - 0.09, pz + f.nz * 0.16, 0, f.ry, 0));
          }
        }
      }
    }
    if (panes.length) {
      const glow = new THREE.MeshStandardMaterial({
        vertexColors: true, emissive: 0xffffff, emissiveIntensity: 1.0, color: 0x000000, roughness: 1,
      });
      glow.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;',
        );
      };
      const mesh = new THREE.Mesh(mergeGeometries(panes, false), glow);
      group.add(mesh);
    }
    if (frames.length) group.add(new THREE.Mesh(mergeGeometries(frames, false), propMaterial));
  }

  // --- water surfaces -----------------------------------------------------

  const waterMaterials = [];
  for (const w of waters) {
    const geo = new THREE.PlaneGeometry(w.size, w.size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      uniforms: {
        time: { value: 0 },
        shallow: { value: new THREE.Color(0x4d8f8c) },
        deep: { value: new THREE.Color(0x14343c) },
        skyColour: { value: new THREE.Color(0x9fc4e8) },
      },
      transparent: true,
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(w.x, w.y, w.z);
    group.add(mesh);
    waterMaterials.push(material);
  }

  // --- chimney smoke ------------------------------------------------------

  let smokeSystem = null;
  if (smokes.length) {
    const perEmitter = 14;
    const total = smokes.length * perEmitter;
    const positions = new Float32Array(total * 3);
    const seeds = new Float32Array(total);
    smokes.forEach((s, i) => {
      for (let p = 0; p < perEmitter; p++) {
        const idx = i * perEmitter + p;
        positions[idx * 3] = s.x;
        positions[idx * 3 + 1] = s.y;
        positions[idx * 3 + 2] = s.z;
        seeds[idx] = p / perEmitter + strHash(`${s.x}${s.z}`, p) * 0.05;
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    const material = new THREE.PointsMaterial({
      size: 3.2, map: smokeTexture(), transparent: true, depthWrite: false,
      color: 0x9a978f, opacity: 0.5, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    group.add(points);
    smokeSystem = { points, geo, base: positions.slice(), seeds };
  }

  // --- doors --------------------------------------------------------------

  const doorMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  const doors = [];
  for (const spec of built.doors) {
    const parts = [];
    pushPart(parts, G.box(spec.width - 0.25, spec.height - 0.1, 0.16), 0x5a4028, at(spec.width / 2 - 0.1, spec.height / 2, 0));
    for (const y of [spec.height * 0.25, spec.height * 0.75]) {
      pushPart(parts, G.box(spec.width - 0.3, 0.18, 0.2), 0x33302c, at(spec.width / 2 - 0.1, y, 0));
    }
    pushPart(parts, G.sphere(0.09, 8), 0x8a7a46, at(spec.width - 0.45, spec.height * 0.5, 0.14));
    const mesh = new THREE.Mesh(mergeGeometries(parts, false), doorMaterial);
    mesh.castShadow = true;
    const pivot = new THREE.Group();
    const [ux, uz] = [Math.cos(spec.rotY), -Math.sin(spec.rotY)];
    pivot.position.set(spec.x - ux * spec.width / 2, spec.y, spec.z - uz * spec.width / 2);
    pivot.rotation.y = spec.rotY;
    pivot.add(mesh);
    group.add(pivot);
    const door = {
      spec, pivot, open: !spec.closed, target: spec.closed ? 0 : 1, t: spec.closed ? 0 : 1,
    };
    doors.push(door);
    interactables.push({
      position: new THREE.Vector3(spec.x, spec.y + spec.height / 2, spec.z),
      radius: 2.6,
      title: spec.keyword.split(/\s+/)[0] || 'door',
      subtitle: spec.locked ? 'locked' : (spec.closed ? 'closed' : 'open'),
      body: spec.locked
        ? 'It is locked. In the mud you would need the key; here, press G to force every lock in the world.'
        : 'Press E to swing it.',
      kind: 'door',
      door,
    });
    if (spec.closed) built.colliders.push({
      x0: spec.x - 1.2, x1: spec.x + 1.2, z0: spec.z - 1.2, z1: spec.z + 1.2,
      y0: spec.y, y1: spec.y + spec.height, door,
    });
  }

  // --- per-frame ----------------------------------------------------------

  const _look = new THREE.Vector3();
  function update(dt, time, camera) {
    if (flameSystem) flameSystem.material.uniforms.time.value = time;
    for (const material of waterMaterials) material.uniforms.time.value = time;

    for (const fig of figures) {
      const bob = Math.sin(time * 1.7 + fig.phase) * 0.035;
      fig.object.position.y = fig.home.y + bob;
      if (!fig.sentinel) {
        fig.object.position.x = fig.home.x + Math.sin(time * 0.25 + fig.phase) * fig.drift;
        fig.object.position.z = fig.home.z + Math.cos(time * 0.19 + fig.phase * 1.3) * fig.drift;
      }
      const dx = camera.position.x - fig.object.position.x;
      const dz = camera.position.z - fig.object.position.z;
      const distSq = dx * dx + dz * dz;
      const near = distSq < 400;
      fig.label.visible = distSq < 110;
      if (near) {
        _look.set(dx, 0, dz).normalize();
        const want = Math.atan2(_look.x, _look.z);
        const current = fig.object.rotation.y;
        let delta = ((want - current + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (delta < -Math.PI) delta += Math.PI * 2;
        fig.head.rotation.y = THREE.MathUtils.clamp(delta, -0.9, 0.9);
        if (fig.aggressive) fig.object.rotation.y += delta * Math.min(1, dt * 1.5);
      }
    }

    if (smokeSystem) {
      const pos = smokeSystem.geo.attributes.position;
      for (let i = 0; i < smokeSystem.seeds.length; i++) {
        const life = (time * 0.14 + smokeSystem.seeds[i]) % 1;
        pos.array[i * 3] = smokeSystem.base[i * 3] + Math.sin(time * 0.4 + i) * life * 2.4;
        pos.array[i * 3 + 1] = smokeSystem.base[i * 3 + 1] + life * 9;
        pos.array[i * 3 + 2] = smokeSystem.base[i * 3 + 2] + Math.cos(time * 0.3 + i) * life * 1.8;
      }
      pos.needsUpdate = true;
    }

    for (const door of doors) {
      const want = door.open ? 1 : 0;
      if (Math.abs(door.t - want) > 0.001) {
        door.t += Math.sign(want - door.t) * Math.min(Math.abs(want - door.t), dt * 2.2);
        door.pivot.rotation.y = door.spec.rotY + door.t * (Math.PI / 2) * 0.95;
      }
    }
  }

  return { group, interactables, update, doors, figures };
}

function shopSign(short) {
  const clean = short.replace(/^(the|a|an)\s+/i, '');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}
