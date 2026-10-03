/**
 * Things lying on the ground: whatever you drop, what spills from a corpse,
 * the reset table's own loose objects (a mushroom in the wood, a shovel in the
 * sexton's shed), and the coins a sale leaves. The game keeps where each one
 * is (`game.ground`, with `at` on the floor); this draws them there, and takes
 * them away when they go.
 *
 * The modelled arms (weapon_*, shield_*) are laid on their flat; the handful
 * of library props that are the thing itself (a sack for a bag, a barrel for a
 * barrel) are scaled down to a carried size; everything else is built here,
 * small, in the baked surfaces the town is made of -- iron, leather, cloth,
 * oak -- so a key on flagstones reads as iron on stone and not as a coloured
 * box. What is fixed in place (the fountain, a desk) is actors.js's scenery,
 * and a corpse is the body lying where it fell.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEM } from './are.js';
import { weaponKind } from './fx.js';
import { buriedTwin } from './textures.js';

const TAKE = 1;
const hash = (s, salt = 0) => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
function at(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz)).clone();
}

/** Metre UVs off the dominant normal axis, as Batcher makes them. */
function projectUV(geo, scale) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i)); const ay = Math.abs(nor.getY(i)); const az = Math.abs(nor.getZ(i));
    let u; let v;
    if (ay >= ax && ay >= az) { u = pos.getX(i); v = pos.getZ(i); } else if (ax >= az) { u = pos.getZ(i); v = pos.getY(i); } else { u = pos.getX(i); v = pos.getY(i); }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * A bag of parts, one merged mesh per surface. Each part: a geometry, a tint
 * (vertex colour over the baked surface), a surface tag, a placement.
 */
class Kit {
  constructor() { this.parts = new Map(); }
  add(geometry, tag, tint, matrix) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    g.applyMatrix4(matrix);
    g.deleteAttribute('uv');
    const colour = new THREE.Color(tint);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = colour.r; c[i * 3 + 1] = colour.g; c[i * 3 + 2] = colour.b; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    if (!this.parts.has(tag)) this.parts.set(tag, []);
    this.parts.get(tag).push(g);
    return this;
  }
}

const G = {
  box: (x, y, z) => new THREE.BoxGeometry(x, y, z),
  cyl: (rt, rb, h, n = 12) => new THREE.CylinderGeometry(rt, rb, h, n),
  sphere: (r, w = 12, h = 8) => new THREE.SphereGeometry(r, w, h),
  torus: (r, t, rs = 8, ts = 16, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, rs, ts, arc),
  lathe: (profile, n = 14) => new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), n),
  capsule: (r, l, n = 8) => new THREE.CapsuleGeometry(r, l, 4, n),
};

// ------------------------------------------------------------ the shapes ----

const words = (obj) => `${obj.keywords || ''} ${obj.name || ''}`.toLowerCase();

/** A folded garment or a piece of plate: how armour lies when nobody wears it. */
function armourShape(k, obj) {
  const w = words(obj);
  const metal = /plate|mail|chain|scale|steel|iron|bronze|helm|gauntlet|greave|bracer/.test(w);
  const tag = metal ? 'iron' : (/leather|hide|studded|boot|belt|glove/.test(w) ? 'leather' : 'cloth');
  const tint = metal ? 0xb8b8b4 : (tag === 'leather' ? 0xa47a52 : 0x9a7a66);
  if (/helm|cap|hat|hood/.test(w)) {
    k.add(G.lathe([[0.001, 0.2], [0.07, 0.195], [0.13, 0.16], [0.155, 0.1], [0.16, 0.03], [0.17, 0]]), tag, tint, at(0, 0, 0));
    return;
  }
  if (/boot|shoe|sandal/.test(w)) {
    for (const s of [-1, 1]) {
      k.add(G.box(0.1, 0.07, 0.27), tag, tint, at(s * 0.08, 0.035, 0.03, 0, s * 0.15, 0));
      k.add(G.cyl(0.055, 0.06, 0.22, 10), tag, tint, at(s * 0.08, 0.11, -0.07, 0.25, s * 0.15, 0));
    }
    return;
  }
  if (/ring|band/.test(w)) {
    k.add(G.torus(0.018, 0.005, 6, 16), 'iron', 0xe0c070, at(0, 0.006, 0, Math.PI / 2, 0, 0));
    return;
  }
  if (/belt|girth/.test(w)) {
    k.add(G.torus(0.14, 0.012, 4, 24), 'leather', 0x8a6040, at(0, 0.012, 0, Math.PI / 2, 0, 0, 1, 0.3, 1));
    k.add(G.box(0.05, 0.012, 0.04), 'iron', 0xc8b070, at(0.14, 0.02, 0));
    return;
  }
  if (/shield|buckler/.test(w)) return 'shield';
  // A body piece, folded: a slab with rounded ends, a second fold on top.
  k.add(G.capsule(0.07, 0.34, 8), tag, tint, at(0, 0.06, 0, 0, 0, Math.PI / 2, 1, 0.8, 2.1));
  k.add(G.capsule(0.05, 0.26, 8), tag, metal ? 0xa5a6a2 : tint, at(0.02, 0.13, 0.02, 0, 0.1, Math.PI / 2, 1, 0.7, 1.7));
}

function drinkShape(k, obj) {
  const w = words(obj);
  if (/skin|flask|canteen/.test(w)) {
    k.add(G.sphere(0.12, 12, 8), 'leather', 0xa07650, at(0, 0.07, 0, 0, 0, 0, 1.3, 0.6, 0.9));
    k.add(G.cyl(0.025, 0.03, 0.08, 8), 'leather', 0x7a5a3a, at(0.17, 0.08, 0, 0, 0, Math.PI / 2));
    return;
  }
  if (/cup|mug|tankard/.test(w)) {
    k.add(G.lathe([[0.001, 0], [0.045, 0], [0.05, 0.02], [0.052, 0.1], [0.047, 0.1], [0.045, 0.012], [0.001, 0.012]]), 'oak', 0xc8b4a0, at(0, 0, 0));
    return;
  }
  // A bottle, lying down: glass body, neck, cork.
  const green = /wine|beer|ale|brandy|whisky|firebreather|specialty/.test(w);
  k.add(G.lathe([[0.001, 0], [0.05, 0], [0.055, 0.01], [0.055, 0.17], [0.045, 0.2], [0.018, 0.23], [0.017, 0.29], [0.021, 0.3], [0.001, 0.3]]),
    'glass', green ? 0x3f6a3a : 0x8a7050, at(0, 0.055, 0.12, -Math.PI / 2, 0, 0));
  k.add(G.cyl(0.015, 0.015, 0.03, 8), 'oak', 0xb89a70, at(0, 0.055, -0.19, Math.PI / 2, 0, 0));
}

function foodShape(k, obj) {
  const w = words(obj);
  if (/mushroom|toadstool/.test(w)) {
    const poison = obj.values && obj.values[3];
    const cap = /toadstool/.test(w) ? (poison ? 0x9a3a2a : 0xa06a3a) : 0xd8c8a8;
    k.add(G.cyl(0.018, 0.024, 0.08, 8), 'skin', 0xeee6d6, at(0, 0.04, 0));
    k.add(G.lathe([[0.001, 0.03], [0.05, 0.028], [0.065, 0.012], [0.062, 0], [0.001, 0.004]]), 'skin', cap, at(0, 0.075, 0));
    k.add(G.cyl(0.013, 0.016, 0.05, 8), 'skin', 0xeee6d6, at(0.07, 0.025, 0.02, 0, 0, 0.3));
    k.add(G.lathe([[0.001, 0.018], [0.03, 0.016], [0.037, 0.006], [0.035, 0], [0.001, 0.002]]), 'skin', cap, at(0.075, 0.048, 0.02, 0, 0, 0.3));
    return;
  }
  if (/berr/.test(w)) {
    for (let i = 0; i < 9; i++) {
      const a = i * 2.39;
      const r = 0.025 + (i % 3) * 0.018;
      k.add(G.sphere(0.017, 8, 6), 'skin', 0x2a1a3a, at(Math.cos(a) * r, 0.017 + (i > 6 ? 0.02 : 0), Math.sin(a) * r));
    }
    k.add(G.box(0.1, 0.004, 0.035), 'leaves', 0x4a6a2a, at(0.02, 0.003, -0.05, 0, 0.6, 0));
    return;
  }
  if (/egg/.test(w)) {
    k.add(G.sphere(0.035, 12, 8), 'skin', 0xf2ead8, at(0, 0.03, 0, 0, 0, Math.PI / 2, 1, 1.3, 1));
    return;
  }
  if (/pie/.test(w)) {
    k.add(G.cyl(0.13, 0.11, 0.06, 18), 'oak', 0xc8905a, at(0, 0.03, 0));
    k.add(G.lathe([[0.001, 0.035], [0.08, 0.03], [0.125, 0.01], [0.13, 0], [0.001, 0]], 18), 'skin', 0xd89a58, at(0, 0.06, 0));
    return;
  }
  // A loaf: a crust, scored across the top.
  k.add(G.capsule(0.07, 0.14, 10), 'skin', 0xc08048, at(0, 0.06, 0, 0, 0, Math.PI / 2, 1, 0.75, 1));
  for (const x of [-0.06, 0, 0.06]) k.add(G.box(0.012, 0.01, 0.1), 'skin', 0x8a5428, at(x, 0.113, 0, 0, 0.35, 0));
}

function keyShape(k) {
  k.add(G.torus(0.028, 0.008, 6, 14), 'iron', 0x9a8a60, at(-0.07, 0.008, 0, Math.PI / 2, 0, 0));
  k.add(G.cyl(0.007, 0.007, 0.13, 6), 'iron', 0x9a8a60, at(0.02, 0.008, 0, 0, 0, Math.PI / 2));
  k.add(G.box(0.012, 0.012, 0.03), 'iron', 0x9a8a60, at(0.075, 0.008, 0.018));
  k.add(G.box(0.012, 0.012, 0.022), 'iron', 0x9a8a60, at(0.055, 0.008, 0.014));
}

function coinShape(k, obj) {
  const n = Math.max(1, Math.min(14, Math.round(Math.log2((obj.values && obj.values[0]) || 1) * 2) + 1));
  for (let i = 0; i < n; i++) {
    const a = i * 2.39 + hash(obj.name, 3);
    const r = i ? 0.03 + 0.025 * Math.sqrt(i) : 0;
    const stack = i % 4 === 3 ? 0.006 : 0;
    k.add(G.cyl(0.016, 0.016, 0.0035, 14), 'iron', 0xf0c850, at(Math.cos(a) * r, 0.002 + stack, Math.sin(a) * r, (i % 3) * 0.1, a, 0));
  }
}

function lightShape(k, obj) {
  const w = words(obj);
  if (/lantern|lamp/.test(w)) {
    k.add(G.cyl(0.07, 0.08, 0.02, 10), 'iron', 0x8a7a50, at(0, 0.01, 0));
    k.add(G.cyl(0.055, 0.06, 0.13, 10), 'glass', 0xe8d8a0, at(0, 0.085, 0));
    k.add(G.lathe([[0.001, 0.05], [0.03, 0.045], [0.07, 0]], 10), 'iron', 0x8a7a50, at(0, 0.15, 0));
    k.add(G.torus(0.035, 0.005, 6, 12, Math.PI), 'iron', 0x8a7a50, at(0, 0.2, 0));
    return;
  }
  if (/candle/.test(w)) {
    k.add(G.cyl(0.05, 0.06, 0.015, 12), 'iron', 0xc8a860, at(0, 0.008, 0));
    k.add(G.cyl(0.012, 0.016, 0.12, 8), 'iron', 0xc8a860, at(0, 0.07, 0));
    k.add(G.cyl(0.012, 0.012, 0.08, 8), 'skin', 0xf0e8d0, at(0, 0.17, 0));
    return;
  }
  if (/branch|stick/.test(w)) return 'branch';
  if (/banner/.test(w)) {
    k.add(G.cyl(0.012, 0.012, 1.0, 6), 'oak', 0x9a7a50, at(0, 0.012, 0, 0, 0, Math.PI / 2));
    k.add(G.box(0.5, 0.01, 0.34), 'cloth', 0x8a2a2a, at(0.2, 0.01, 0.17, 0, 0.08, 0));
    return;
  }
  // A torch: a stick with a pitch-wrapped head, lying where it was dropped.
  k.add(G.cyl(0.018, 0.022, 0.5, 8), 'oak', 0x8a6a48, at(0, 0.022, 0, 0, 0, Math.PI / 2));
  k.add(G.cyl(0.04, 0.03, 0.12, 10), 'cloth', 0x3a2e24, at(0.27, 0.035, 0, 0, 0, Math.PI / 2));
}

function containerShape(k, obj) {
  const w = words(obj);
  if (/bag|sack|pouch|purse/.test(w)) return 'sack';
  if (/barrel/.test(w)) return 'barrel';
  // A small chest: boarded box, a lid, iron corners and a hasp.
  const s = /chest/.test(w) ? 1 : 0.7;
  k.add(G.box(0.5 * s, 0.26 * s, 0.32 * s), 'planks', 0xb08a60, at(0, 0.13 * s, 0));
  k.add(new THREE.CylinderGeometry(0.16 * s, 0.16 * s, 0.5 * s, 12, 1, false, 0, Math.PI), 'planks', 0xa07a52,
    at(0, 0.26 * s, 0, 0, 0, Math.PI / 2, 1, 1, 0.55));
  for (const x of [-0.19, 0.19]) k.add(G.box(0.03 * s, 0.3 * s, 0.335 * s), 'iron', 0x6a6a64, at(x * s, 0.15 * s, 0));
  k.add(G.box(0.05 * s, 0.07 * s, 0.02 * s), 'iron', 0x8a8a80, at(0, 0.24 * s, 0.165 * s));
}

function skeletonShape(k) {
  const bone = 0xd8cdb0;
  k.add(G.sphere(0.09, 12, 10), 'skin', bone, at(0, 0.08, -0.62, 0, 0, 0, 0.85, 0.9, 1.05));
  for (let i = 0; i < 7; i++) k.add(G.cyl(0.018, 0.018, 0.06, 6), 'skin', bone, at(0, 0.03, -0.48 + i * 0.07, Math.PI / 2, 0, 0));
  for (let i = 0; i < 5; i++) {
    k.add(G.torus(0.1 - i * 0.008, 0.009, 4, 12, Math.PI), 'skin', bone, at(0, 0.02, -0.44 + i * 0.055, 0, 0, 0, 1, 0.55, 1));
  }
  k.add(G.box(0.22, 0.04, 0.1), 'skin', bone, at(0, 0.03, 0.03));
  for (const s of [-1, 1]) {
    k.add(G.cyl(0.02, 0.018, 0.42, 6), 'skin', bone, at(s * 0.08, 0.02, 0.28, Math.PI / 2, 0, s * 0.08));
    k.add(G.cyl(0.017, 0.015, 0.38, 6), 'skin', bone, at(s * 0.1, 0.02, 0.66, Math.PI / 2, 0, 0));
    k.add(G.cyl(0.016, 0.014, 0.3, 6), 'skin', bone, at(s * 0.22, 0.02, -0.28, Math.PI / 2, 0, s * 0.3));
    k.add(G.cyl(0.014, 0.012, 0.26, 6), 'skin', bone, at(s * 0.3, 0.02, -0.02, Math.PI / 2, 0, s * 0.1));
  }
}

function branchShape(k) {
  k.add(G.cyl(0.025, 0.035, 1.1, 7), 'bark', 0x8a8070, at(0, 0.035, 0, 0, 0, Math.PI / 2));
  k.add(G.cyl(0.012, 0.02, 0.4, 6), 'bark', 0x8a8070, at(0.3, 0.03, 0.1, 0, 0.5, Math.PI / 2));
}

function scrollShape(k) {
  k.add(G.cyl(0.03, 0.03, 0.26, 12), 'cloth', 0xe8dcb8, at(0, 0.03, 0, 0, 0, Math.PI / 2));
  for (const x of [-0.07, 0.07]) k.add(G.torus(0.031, 0.004, 4, 12), 'cloth', 0x8a3a2a, at(x, 0.03, 0, 0, Math.PI / 2, 0));
}

function potionShape(k) {
  k.add(G.lathe([[0.001, 0], [0.03, 0], [0.045, 0.03], [0.045, 0.06], [0.015, 0.09], [0.012, 0.12], [0.001, 0.12]]), 'glass', 0x5aa8a0, at(0, 0.045, 0.05, -Math.PI / 2, 0, 0));
  k.add(G.cyl(0.013, 0.012, 0.025, 8), 'oak', 0x9a7a50, at(0, 0.045, -0.085, Math.PI / 2, 0, 0));
}

function parcelShape(k) {
  k.add(G.box(0.24, 0.12, 0.18), 'cloth', 0xa89070, at(0, 0.06, 0));
  k.add(G.box(0.25, 0.125, 0.02), 'leather', 0x6a4a30, at(0, 0.06, 0));
}

// ---------------------------------------------------------------- items ----

export function createItems({ scene, game, library, built }) {
  const group = new THREE.Group();
  group.name = 'items';
  scene.add(group);
  const drawn = new Map();       // obj -> THREE.Object3D
  const cache = new Map();       // shape key -> { parts: [[geometry, material]], ... }
  const materials = new Map();

  /**
   * The baked surfaces (iron, planks, bark) come from the library as the town
   * wears them, and the tints here multiply their albedo. The flat ones the
   * library makes for figures (cloth, skin, oak, leather) carry a colour of
   * their own, which would multiply every tint here down to near black -- so
   * those are made here, white, with the same shared grain for relief.
   */
  const FLAT = {
    cloth: { roughness: 0.95, grain: 0.5 }, skin: { roughness: 0.62, grain: 0.22 },
    oak: { roughness: 0.72, grain: 0.35 }, leather: { roughness: 0.58, grain: 0.45 },
  };
  const materialFor = (tag) => {
    if (materials.has(tag)) return materials.get(tag);
    let material;
    if (tag === 'glass') {
      material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.72 });
      material.userData.uvScale = 1;
    } else if (FLAT[tag]) {
      const grain = library && library.materials ? library.materials.$grain : null;
      material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: FLAT[tag].roughness, metalness: 0 });
      if (grain) { material.normalMap = grain; material.normalScale = new THREE.Vector2(FLAT[tag].grain, FLAT[tag].grain); }
      material.userData.uvScale = 1 / 0.6;
    } else if (library) material = library.materialFor(tag);
    else material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    materials.set(tag, material);
    return material;
  };

  const indoorAt = (obj) => {
    const info = built.rooms.get(obj.inRoom);
    return info ? !info.outdoor : false;
  };

  /** Mark geometry indoors or out for the hemisphere mix (CLAUDE.md: aIndoor). */
  function flagged(geometry, indoor) {
    const count = geometry.attributes.position.count;
    geometry.setAttribute('aIndoor', new THREE.BufferAttribute(new Float32Array(count).fill(indoor ? 1 : 0), 1));
    return geometry;
  }

  /**
   * A library model laid down. The arms' frame (tools/blender/weapons.py,
   * after glTF's y-up): a blade runs up +Y with its flats facing X, so a
   * quarter turn about Z puts a flat on the ground; a shield's face looks down
   * +Z, so a quarter turn about X lays it face up. Props sit on their floor.
   */
  function modelled(name, { lay = false, scale = 1 } = {}, indoor) {
    const key = `${name}|${lay}|${scale}|${indoor}`;
    if (cache.has(key)) return cache.get(key);
    const asset = library && library.get && library.get(name);
    if (!asset) { cache.set(key, null); return null; }
    const parts = asset.primitives.map((p) => {
      const g = flagged(p.geometry.clone(), indoor);
      return [g, p.material];
    });
    const min = asset.bounds.min;
    const entry = { parts, scale };
    if (lay === 'blade') { entry.rotation = [0, 0, Math.PI / 2]; entry.lift = -min.x * scale; } else if (lay === 'shield') {
      entry.rotation = [-Math.PI / 2, 0, 0]; entry.lift = -min.z * scale;
    } else { entry.rotation = [0, 0, 0]; entry.lift = -min.y * scale; }
    cache.set(key, entry);
    return entry;
  }

  function fromKit(kit, indoor) {
    const parts = [];
    for (const [tag, list] of kit.parts) {
      const geometry = mergeGeometries(list, false);
      const material = materialFor(tag);
      projectUV(geometry, material.userData.uvScale ?? 1);
      parts.push([flagged(geometry, indoor), material]);
    }
    return { parts, scale: 1, lift: 0, rotation: [0, 0, 0] };
  }

  /** What an object looks like lying down, by type and by its own words. */
  function shapeOf(obj, indoor) {
    const kit = new Kit();
    let key = `${obj.itemType}|${obj.vnum}|${indoor}`;
    if (obj.itemType === ITEM.MONEY) key = `money|${Math.min(14, Math.round(Math.log2(obj.values[0] || 1) * 2) + 1)}|${indoor}`;
    if (cache.has(key)) return cache.get(key);
    let special = null;
    switch (obj.itemType) {
      case ITEM.WEAPON: special = `weapon_${weaponKind(obj)}`; break;
      case ITEM.STAFF: special = 'weapon_staff'; break;
      case ITEM.ARMOR: special = armourShape(kit, obj) === 'shield' ? (/kite|tower|heater/.test(words(obj)) ? 'shield_kite' : 'shield_round') : null; break;
      case ITEM.DRINK_CON: if (/barrel/.test(words(obj))) special = 'barrel'; else drinkShape(kit, obj); break;
      case ITEM.FOOD: foodShape(kit, obj); break;
      case ITEM.KEY: keyShape(kit); break;
      case ITEM.MONEY: case ITEM.TREASURE:
        if (obj.itemType === ITEM.TREASURE && /ring|gem|jewel|pearl|opal|ruby|emerald|diamond/.test(words(obj))) {
          kit.add(G.torus(0.018, 0.005, 6, 16), 'iron', 0xe0c070, at(0, 0.006, 0, Math.PI / 2, 0, 0));
          kit.add(G.sphere(0.009, 8, 6), 'glass', 0xa8e0ff, at(0.018, 0.012, 0));
        } else coinShape(kit, obj);
        break;
      case ITEM.LIGHT: if (lightShape(kit, obj) === 'branch') branchShape(kit); break;
      case ITEM.CONTAINER: special = containerShape(kit, obj) || null; break;
      case ITEM.SCROLL: scrollShape(kit); break;
      case ITEM.POTION: case ITEM.PILL: potionShape(kit); break;
      case ITEM.WAND: kit.add(G.cyl(0.01, 0.013, 0.34, 6), 'oak', 0x5a4030, at(0, 0.013, 0, 0, 0, Math.PI / 2)); break;
      case ITEM.BOAT: special = 'handcart'; break;
      case ITEM.TRASH:
        if (/skeleton|bones/.test(words(obj))) skeletonShape(kit);
        else if (/branch|stick|twig/.test(words(obj))) branchShape(kit);
        else if (/bone/.test(words(obj))) kit.add(G.capsule(0.025, 0.3, 6), 'skin', 0xd8cdb0, at(0, 0.025, 0, 0, 0, Math.PI / 2));
        else parcelShape(kit);
        break;
      default: parcelShape(kit); break;
    }
    if (obj.itemType === ITEM.WEAPON && /bone/.test(words(obj))) special = null, kit.add(G.capsule(0.03, 0.36, 6), 'skin', 0xd8cdb0, at(0, 0.03, 0, 0, 0, Math.PI / 2));
    let entry = null;
    if (special) {
      const lay = special.startsWith('weapon_') ? 'blade' : (special.startsWith('shield_') ? 'shield' : false);
      const scale = special === 'sack' ? 0.45 : special === 'barrel' ? 0.55 : special === 'handcart' ? 0.9 : 1;
      entry = modelled(special, { lay, scale }, indoor);
    }
    if (!entry) {
      if (!kit.parts.size) parcelShape(kit);
      entry = fromKit(kit, indoor);
    }
    cache.set(key, entry);
    return entry;
  }

  function draw(obj) {
    const indoor = indoorAt(obj);
    const shape = shapeOf(obj, indoor);
    // Underground an object is lit as the sewer is, not by the sky over the
    // rock: a crate in the Playpen metered RGB 0 at night.
    const info = built.rooms.get(obj.inRoom);
    const buried = !!info && (info.cell.level < 0 || !!(info.materials && info.materials.inRock));
    const node = new THREE.Group();
    const inner = new THREE.Group();
    for (const [geometry, material] of shape.parts) {
      const mesh = new THREE.Mesh(geometry, buried ? buriedTwin(material) : material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      inner.add(mesh);
    }
    inner.rotation.set(...shape.rotation);
    inner.scale.setScalar(shape.scale);
    inner.position.y = shape.lift;
    node.add(inner);
    node.position.set(obj.at.x, obj.at.y + 0.004, obj.at.z);
    node.rotation.y = hash(`${obj.name}|${obj.at.x.toFixed(2)}`, 7) * Math.PI * 2;
    node.userData.obj = obj;
    group.add(node);
    return node;
  }

  /** Scenery (actors.js draws it) and corpses (the body is the corpse) are not ours. */
  const ours = (obj) => (obj.wearFlags & TAKE) && !(obj.slot && obj.slot.figure);

  /**
   * What a body holds is part of the figure (actors.js hangs the modelled
   * weapon and shield on its hands), so it has to be let go of when the game
   * says so: a mobile disarmed, a corpse relieved of its sword.
   */
  function syncGear() {
    for (const slot of game.mobs) {
      const fig = slot.figure;
      if (!fig || (!fig.weapon && !fig.shield)) continue;
      let weapon = true;
      let shield = true;
      if (slot.corpse) {
        weapon = !slot.corpse.wornWeapon || slot.corpse.contains.includes(slot.corpse.wornWeapon);
        shield = !slot.corpse.wornShield || slot.corpse.contains.includes(slot.corpse.wornShield);
      } else if (slot.instance && !slot.dead) {
        weapon = !!slot.instance.equipment[16] || !slot.record.equipment.some((e) => e.wearLoc === 16);
      }
      if (fig.weapon && fig.weapon.visible !== weapon) fig.weapon.visible = weapon;
      if (fig.shield && fig.shield.visible !== shield) fig.shield.visible = shield;
    }
  }

  function update() {
    syncGear();
    const live = new Set();
    for (const obj of game.ground) {
      // The ground is the whole mud's; only the drawn zone's rooms are drawn.
      if (!ours(obj) || !built.rooms.has(obj.inRoom)) continue;
      live.add(obj);
      let node = drawn.get(obj);
      if (!node) { node = draw(obj); drawn.set(obj, node); } else if (node.position.x !== obj.at.x || node.position.z !== obj.at.z) {
        node.position.set(obj.at.x, obj.at.y + 0.004, obj.at.z);
      }
    }
    for (const [obj, node] of drawn) {
      if (live.has(obj)) continue;
      group.remove(node);
      drawn.delete(obj);
    }
  }

  const _to = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  /**
   * What on the ground you are looking at: within three and a half metres of
   * the eye, near the middle of the view. Corpses count (you loot them with
   * E); scenery comes through actors.js's own list.
   */
  function lookable(camera) {
    camera.getWorldDirection(_fwd);
    let best = null;
    let bestScore = -Infinity;
    for (const obj of game.ground) {
      if (!built.rooms.has(obj.inRoom)) continue;
      if (!(obj.wearFlags & TAKE) && !game.isContainer(obj)) continue;
      if (!(obj.wearFlags & TAKE) && !(obj.slot)) continue;
      _to.set(obj.at.x - camera.position.x, obj.at.y + 0.15 - camera.position.y, obj.at.z - camera.position.z);
      const d = _to.length();
      if (d > 3.6) continue;
      _to.divideScalar(d);
      const facing = _to.dot(_fwd);
      if (facing < 0.9) continue;
      const score = facing * 3 - d * 0.2;
      if (score > bestScore) { bestScore = score; best = obj; }
    }
    return best;
  }

  /** Another zone (main.js crossTo): what lies in its rooms is drawn from now on. */
  function setBuilt(next) { built = next; }

  return { group, update, lookable, drawn, setBuilt };
}
