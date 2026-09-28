/**
 * Grass: blades over the turf, where the turf is open ground.
 *
 * The ground's `grass` recipe was the whole of a meadow -- a noise whose
 * relief swung the lit value by 28% in 40 cm blotches, which a judge called
 * camouflage. What reads as grass in a game is cards of blades standing on a
 * low-contrast base, thinning with distance until the base carries the colour
 * alone; that is this.
 *
 * Where it grows is read off what was built rather than decided twice: every
 * upward face the builder laid in `grass` is sown, unless something else was
 * laid over it (a street on the ground plane, a gravel path on a lawn), a
 * model stands on it (a house, a trunk, a grave slab) or a wall's collider
 * does. So a new grass surface anywhere in build.js grows blades with no
 * change here, and nothing grows indoors, under paving or underground --
 * indoor faces are flagged by the builder, and the buried rooms are not grass.
 *
 * What grows is read off the room: the Shire's lawns have buttercups and
 * daisies in them, the fields outside the forest stand knee-deep and go to
 * seed, the park is mown, the graveyard is kept but not well. The lines the
 * mud's exits walk through a grass room are trodden short.
 *
 * Drawn as clumps of four crossed cards, one instanced mesh per 24 m block,
 * so a view is a dozen draws whatever it looks at. Blocks past the far fade
 * are hidden outright; inside it, the vertex shader thins the clumps with
 * distance (widening what is left, so the cover holds), shrinks the last ones
 * into the ground, and sways the tips. Only the blocks nearest the eye cast
 * into the sun's shadow map.
 */

import * as THREE from 'three';
import { GRASS_CARDS, GRASS_ATLAS } from './textures.js';

const BLOCK = 24;
const SHADOW_REACH = 16;
const CARDS_PER_CLUMP = 4;

/**
 * How far the blades reach and how thick they stand, by quality preset.
 * `range` is where the last of them has sunk into the turf; the thinning
 * starts at 40% of it. `density` is the share of the sown clumps drawn.
 */
export const GRASS_PRESETS = {
  low: { density: 0.35, range: 22, shadows: false },
  medium: { density: 0.65, range: 34, shadows: false },
  high: { density: 1, range: 46, shadows: true },
  max: { density: 1, range: 62, shadows: true },
};

// Sown clumps per square metre, and the share of each card, by biome. Cards
// are GRASS_CARDS: lawn, lawnseed, meadow, straw, buttercup, daisy, weed,
// trodden.
const BIOMES = {
  shire: { density: 4.6, height: 1.0, mix: [0.34, 0.24, 0.06, 0.02, 0.13, 0.12, 0.09, 0] },
  park: { density: 4.6, height: 0.8, mix: [0.62, 0.18, 0, 0, 0.03, 0.13, 0.04, 0] },
  grave: { density: 4.2, height: 0.95, mix: [0.34, 0.3, 0.16, 0.06, 0, 0.06, 0.08, 0] },
  meadow: { density: 4.4, height: 1.05, mix: [0.06, 0.2, 0.44, 0.2, 0.04, 0.02, 0.04, 0] },
  hills: { density: 4.2, height: 1.0, mix: [0.16, 0.28, 0.3, 0.16, 0.04, 0.02, 0.04, 0] },
  verge: { density: 2.8, height: 1.0, mix: [0.12, 0.26, 0.36, 0.18, 0.03, 0.01, 0.04, 0] },
};
const TRODDEN = 7;

// How far out from the town the ground plane is sown, and over what distance
// it thins to nothing: the fields beyond are seen from the walls and gates,
// past the range of any blade, and the base texture is what reads there.
const VERGE_FULL = 16;
const VERGE_END = 32;

/** A deterministic stream, so the same world grows the same meadow. */
function stream(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2D value noise in [0,1], for patches a few metres across. */
function patchNoise(x, z, salt) {
  const h = (i, j) => {
    let n = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(salt, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const ix = Math.floor(x); const iz = Math.floor(z);
  const fx = x - ix; const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx); const sz = fz * fz * (3 - 2 * fz);
  const a = h(ix, iz); const b = h(ix + 1, iz); const c = h(ix, iz + 1); const d = h(ix + 1, iz + 1);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}

/** A 2D bucket grid of anything with an xz extent. */
class Buckets {
  constructor(size = 4) { this.size = size; this.map = new Map(); }
  add(item, x0, x1, z0, z1) {
    const s = this.size;
    for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
      for (let j = Math.floor(z0 / s); j <= Math.floor(z1 / s); j++) {
        const k = `${i},${j}`;
        let list = this.map.get(k);
        if (!list) { list = []; this.map.set(k, list); }
        list.push(item);
      }
    }
  }
  at(x, z) { return this.map.get(`${Math.floor(x / this.size)},${Math.floor(z / this.size)}`) || []; }
}

/** Height of triangle (a,b,c) over (x,z), or null if (x,z) is outside it. */
function heightIn(t, x, z) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) return null;
  return l1 * ay + l2 * by + l3 * cy;
}

/**
 * One clump: four cards crossing about its centre at scattered angles,
 * each a unit square (the instance scales it to its card's metres) in two
 * rows, so the upper half can bend in the wind and the whole card can lean.
 * Normals point up: a lawn is lit as the ground it covers, not as three
 * hundred little walls catching the sun one by one.
 */
function clumpGeometry() {
  const pos = []; const uv = []; const col = []; const nor = []; const idx = [];
  const r = stream(424242);
  for (let k = 0; k < CARDS_PER_CLUMP; k++) {
    const a = (k / CARDS_PER_CLUMP) * Math.PI + (r() - 0.5) * 0.6;
    const ca = Math.cos(a); const sa = Math.sin(a);
    const ox = (r() - 0.5) * 0.7; const oz = (r() - 0.5) * 0.7;
    const lean = (r() - 0.5) * 0.24;
    const base = pos.length / 3;
    for (let row = 0; row < 3; row++) {
      const v = row / 2;
      for (let c = 0; c < 2; c++) {
        const u = c;
        const across = u - 0.5;
        pos.push(ox + ca * across + (-sa) * lean * v, v, oz + sa * across + ca * lean * v);
        // Inset from the region's edges, so bilinear never reaches the card
        // next door in the atlas.
        uv.push(0.004 + u * 0.992, 0.004 + v * 0.99);
        const shade = 0.86 + 0.14 * v;
        col.push(shade, shade, shade);
        nor.push(0, 1, 0);
      }
    }
    for (let row = 0; row < 2; row++) {
      const i = base + row * 2;
      idx.push(i, i + 1, i + 3, i, i + 3, i + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------- shader ----

const uniforms = {
  uGrassEye: { value: new THREE.Vector3() },
  uGrassTime: { value: 0 },
  // x: where thinning starts, y: where the last blade has sunk.
  uGrassRange: { value: new THREE.Vector2(18, 46) },
  uGrassDensity: { value: 1 },
  uGrassWind: { value: new THREE.Vector2(0.8, 0.6) },
};

const GRASS_VERTEX_HEAD = /* glsl */`
attribute vec4 aGrassPos;
attribute vec4 aGrassSize;
attribute vec4 aGrassTint;
uniform vec3 uGrassEye;
uniform float uGrassTime;
uniform vec2 uGrassRange;
uniform float uGrassDensity;
uniform vec2 uGrassWind;
varying vec3 vGrassWorld;
`;

// Each clump is three attributes rather than a matrix -- 48 bytes against
// 92 with three's own instancing, over a few hundred thousand of them:
//   aGrassPos  (x, y, z, yaw)        where it stands, world space
//   aGrassSize (width, height, card, keep)
//   aGrassTint (r, g, b, phase)
// The card picks the atlas region; `keep` against the density at this
// distance decides whether the clump is drawn at all.
const GRASS_VERTEX_BODY = /* glsl */`
  vec3 gOrigin = aGrassPos.xyz;
  vGrassWorld = gOrigin;
  float gDist = length( gOrigin.xz - uGrassEye.xz );
  float gThin = smoothstep( uGrassRange.x, uGrassRange.y, gDist );
  float gOn = step( aGrassSize.w, uGrassDensity * mix( 1.0, 0.4, gThin ) );
  float gSink = 1.0 - smoothstep( mix( uGrassRange.x, uGrassRange.y, 0.7 ), uGrassRange.y, gDist );
  // What survives the thinning stands a little wider, so a field does not go
  // bald before it goes to turf.
  float gW = aGrassSize.x * ( 1.0 + 0.7 * gThin ) * gOn;
  float gH = aGrassSize.y * gSink * gOn;
  vec3 gP = vec3( transformed.x * gW, transformed.y * gH, transformed.z * gW );
  // Turned the way Matrix4.makeRotationY turns: +x towards -z.
  float gC = cos( aGrassPos.w ); float gS = sin( aGrassPos.w );
  gP = vec3( gC * gP.x + gS * gP.z, gP.y, -gS * gP.x + gC * gP.z );
  // The wind: a slow gust rolling across the field and a quick flutter per
  // clump, bending the tips and leaving the roots where they are.
  float gTip = uv.y * uv.y;
  float gGust = sin( uGrassTime * 0.9 - dot( gOrigin.xz, uGrassWind ) * 0.18 ) * 0.5 + 0.5;
  float gFlutter = sin( uGrassTime * 3.1 + aGrassTint.w * 6.2832 + gOrigin.x * 0.7 );
  vec2 gSide = vec2( -uGrassWind.y, uGrassWind.x );
  vec2 gPush = uGrassWind * ( 0.05 + 0.16 * gGust * gGust ) + gSide * 0.035 * gFlutter;
  vec3 gOffset = vec3( gPush.x, -0.05 * gGust * gGust, gPush.y ) * gTip * gH;
  transformed = gOrigin + gP + gOffset;
`;

const GRASS_UV = /* glsl */`
  vec2 gCell = vec2( mod( aGrassSize.z, ${GRASS_ATLAS.cols}.0 ), floor( aGrassSize.z / ${GRASS_ATLAS.cols}.0 ) );
  vec2 gAtlasUv = ( gCell + uv ) / vec2( ${GRASS_ATLAS.cols}.0, ${GRASS_ATLAS.rows}.0 );
`;

/** Wire the grass vertex stage into any material's shader. */
function injectGrass(shader, { uvTargets = [] } = {}) {
  Object.assign(shader.uniforms, uniforms);
  const remap = uvTargets.map((name) => {
    const varying = `v${name[0].toUpperCase()}${name.slice(1)}Uv`;
    return `\t#ifdef USE_${name.toUpperCase()}\n\t${varying} = gAtlasUv;\n\t#endif`;
  }).join('\n');
  const before = shader.vertexShader;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${GRASS_VERTEX_HEAD}`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>\n${GRASS_UV}${remap}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GRASS_VERTEX_BODY}`);
  // Fail loudly if three renames a chunk: silently unbent grass is a bug
  // nobody would find.
  for (const chunk of ['#include <common>', '#include <uv_vertex>', '#include <begin_vertex>']) {
    if (!before.includes(chunk)) throw new Error(`grass: vertex shader has no ${chunk}`);
  }
}

/** The lit material: the baked atlas through the world's own lighting. */
function dressLit(material) {
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    base.call(material, shader, renderer);
    injectGrass(shader, { uvTargets: ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] });
    // The macro mottling and the detail grain key off the surface position,
    // which for an instance is the model's origin: give them the clump's.
    shader.vertexShader = shader.vertexShader
      .replace('vIndoor = aIndoor;', 'vIndoor = aIndoor;\n\tvSurfacePos = vGrassWorld;')
      .replace('#include <color_vertex>', '#include <color_vertex>\n\tvColor.rgb *= aGrassTint.rgb;');
  };
  const key = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${key.call(material)}|grass`;
  material.needsUpdate = true;
}

/**
 * What the AO prepass draws for grass: nothing. `foliageNormal` in render.js
 * takes this in place of its generic cut-out. Drawn into the prepass, a
 * field of cards occluded itself: under overcast, where the ambient is all
 * the light there is, it took a meadow from 65 to 55 of luminance and added
 * a quarter to its blotchiness -- measured by swapping this material in the
 * page. Left out, the pass sees the turf, which is flat, and a blade takes
 * the occlusion of the ground it stands on, which is what it should.
 */
const NOT_IN_PREPASS = new THREE.MeshBasicMaterial({ visible: false });

/** The sun's shadow map: cut-out and bent the same way. */
function depthMaterial(lit) {
  const material = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking, map: lit.map, alphaTest: lit.alphaTest, side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => injectGrass(shader, { uvTargets: ['map'] });
  material.customProgramCacheKey = () => 'grass-depth';
  return material;
}

// ------------------------------------------------------------------ field ----

/**
 * The blocks, shown and hidden by distance from whatever camera is drawing.
 * A LOD because three calls `update(camera)` on one while it walks the scene,
 * before it culls the children -- which is exactly the hook this needs, and
 * needs no frame loop of its own.
 */
class GrassField extends THREE.LOD {
  constructor() {
    super();
    this.name = 'grass';
    this.blocks = [];
    this.range = 46;
    this.shadows = true;
    // No wind, for comparing frames pixel for pixel.
    this.still = false;
    this.clock = performance.now();
  }

  update(camera) {
    // Only an eye: the shadow pass has its own camera and never calls this,
    // and anything else that draws the scene should not move the field.
    if (!camera.isPerspectiveCamera) return;
    const eye = camera.getWorldPosition(uniforms.uGrassEye.value);
    uniforms.uGrassTime.value = this.still ? 0 : (performance.now() - this.clock) / 1000;
    const reach = this.range + BLOCK * 0.75;
    for (const block of this.blocks) {
      const dx = Math.max(block.x0 - eye.x, 0, eye.x - block.x1);
      const dz = Math.max(block.z0 - eye.z, 0, eye.z - block.z1);
      const d = Math.hypot(dx, dz);
      // Only undo what this hid. A block in range that is not visible was
      // hidden for this frame by cull.js, behind a wall, and cull.js puts it
      // back itself; showing it here would draw it through the wall's cull.
      if (d >= reach) { block.mesh.visible = false; block.far = true; }
      else if (block.far) { block.mesh.visible = true; block.far = false; }
      block.mesh.castShadow = this.shadows && d < SHADOW_REACH;
    }
  }
}

// ------------------------------------------------------------------ build ----

/**
 * Sow the world's grass. Call before `batcher.finish`, which consumes the
 * geometry this reads.
 *
 * @param {object} args
 * @param {Map} args.groups the Batcher's (chunk|material) -> {materialName, list}
 * @param {InstanceBatch|null} args.instances placed models, to keep off
 * @param {Array} args.colliders wall boxes, to keep off
 * @param {object} args.layout the world's layout
 * @param {Map} args.rooms vnum -> built room info
 * @param {object} args.materials the baked materials
 * @param {number} args.cell the grid pitch
 * @param {(room: object) => string} args.biomeOf which BIOMES entry a room grows
 */
export function buildGrass({ groups, instances, colliders, layout, rooms, materials, cell, biomeOf }) {
  const lit = materials.grassblades;
  if (!lit) throw new Error('grass: no grassblades material');
  const t0 = performance.now();

  // --- what is sown, and what lies over it ------------------------------------
  const sown = [];
  const cover = new Buckets(4);
  for (const { materialName, list } of groups.values()) {
    const isGrass = materialName === 'grass';
    for (const geo of list) {
      const p = geo.attributes.position.array;
      const indoor = geo.attributes.aIndoor?.array;
      for (let i = 0; i < p.length; i += 9) {
        const ax = p[i]; const ay = p[i + 1]; const az = p[i + 2];
        const bx = p[i + 3]; const by = p[i + 4]; const bz = p[i + 5];
        const cx = p[i + 6]; const cy = p[i + 7]; const cz = p[i + 8];
        // Face normal, y component, and area.
        const ux = bx - ax; const uy = by - ay; const uz = bz - az;
        const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
        const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) continue;
        const up = ny / len;
        const tri = [ax, ay, az, bx, by, bz, cx, cy, cz];
        if (isGrass) {
          // Slopes to fifty degrees: a hill's flank, not a turf wall.
          if (up < 0.64 || (indoor && indoor[i / 3] > 0.5) || ay < -2) continue;
          sown.push({ tri, area: len / 2 });
        } else if (Math.abs(up) > 0.3) {
          cover.add(tri, Math.min(ax, bx, cx), Math.max(ax, bx, cx), Math.min(az, bz, cz), Math.max(az, bz, cz));
        }
      }
    }
  }
  // Lying over a sown point: anything from a gravel strip two centimetres up
  // to a ceiling four metres up. A roof higher than that is a building the
  // point is outside of.
  const covered = (x, y, z) => {
    for (const tri of cover.at(x, z)) {
      const h = heightIn(tri, x, z);
      if (h !== null && h > y + 0.008 && h < y + 4) return true;
    }
    return false;
  };

  // --- what stands on it ------------------------------------------------------
  const blocked = new Buckets(4);
  const PLANTS = /^(grass_tuft|fern|salal_bush|bush|nettles|tall_weeds|tussock|reed_clump|bramble)$/;
  if (instances) {
    for (const { asset, transforms } of instances.buckets.values()) {
      if (PLANTS.test(asset.name)) continue;
      const b = asset.bounds;
      const tree = /^(tree_|palm_)/.test(asset.name);
      for (const t of transforms) {
        const sx = t.scaleX ?? t.scale ?? 1; const sz = t.scaleZ ?? t.scale ?? 1;
        const sy = t.scaleY ?? t.scale ?? 1;
        if (b.max.y * sy + t.y < -1 || b.min.y * sy + t.y > t.y + 3) continue;
        const item = tree
          ? { x: t.x, z: t.z, r: 0.85 * Math.max(sx, sz) }
          : {
            x: t.x, z: t.z, c: Math.cos(t.rotY || 0), s: Math.sin(t.rotY || 0),
            x0: b.min.x * sx, x1: b.max.x * sx, z0: b.min.z * sz, z1: b.max.z * sz, y1: t.y + b.max.y * sy,
          };
        const reach = tree ? item.r : Math.hypot(Math.max(-item.x0, item.x1), Math.max(-item.z0, item.z1));
        blocked.add(item, t.x - reach, t.x + reach, t.z - reach, t.z + reach);
      }
    }
  }
  for (const c of colliders) blocked.add({ box: c }, c.x0, c.x1, c.z0, c.z1);
  const standing = (x, y, z) => {
    for (const it of blocked.at(x, z)) {
      if (it.box) {
        const c = it.box;
        // Standing *on* this ground: a wall's box starts at its foot. A hill's
        // box starts at the foot of the hill, well under its own flank.
        if (x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1 && Math.abs(c.y0 - y) < 0.35 && c.y1 > y + 0.1) return true;
      } else if (it.r !== undefined) {
        if ((x - it.x) ** 2 + (z - it.z) ** 2 < it.r * it.r) return true;
      } else {
        // Into the model's frame: rotY turns +x towards -z, as Matrix4 does.
        const dx = x - it.x; const dz = z - it.z;
        const lx = dx * it.c - dz * it.s; const lz = dx * it.s + dz * it.c;
        if (lx > it.x0 && lx < it.x1 && lz > it.z0 && lz < it.z1 && it.y1 > y + 0.02) return true;
      }
    }
    return false;
  };

  // --- whose ground it is -----------------------------------------------------
  // The room in a cell or the passage through it, and at the edges of the
  // world, the nearest one. Anything level 0 or above; grass is never buried.
  const surfaceRooms = [...rooms.values()].filter((r) => !r.unbuilt && r.cell.level >= 0);
  const byCell = new Map();
  for (const info of surfaceRooms) byCell.set(`${info.cell.level}:${info.cell.x},${info.cell.z}`, info);
  const occupied = new Set();
  for (const c of layout.cells.values()) occupied.add(`${c.x},${c.z}`);
  for (const k of layout.pathCells) { const [, xz] = k.split(':'); occupied.add(xz); }
  const ownerAt = (x, y, z) => {
    const gx = Math.round(x / cell); const gz = Math.round(z / cell);
    const level = Math.max(0, Math.round(y / 7.6));
    const here = byCell.get(`${level}:${gx},${gz}`);
    if (here) return { info: here, d: 0 };
    const link = layout.passageAt(level, gx, gz);
    if (link) return { info: rooms.get(link.from.vnum), d: 0 };
    let best = null;
    for (let r = 1; r <= 3 && !best; r++) {
      for (let i = -r; i <= r; i++) {
        for (let j = -r; j <= r; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          const info = byCell.get(`0:${gx + i},${gz + j}`);
          if (!info) continue;
          const d = Math.hypot(x - info.cell.x * cell, z - info.cell.z * cell) - cell / 2;
          if (!best || d < best.d) best = { info, d };
        }
      }
    }
    return best;
  };

  // The lines a player walks through a grass room: centre to each opening,
  // and along every routed passage cell to cell.
  const paths = new Buckets(8);
  const addPath = (ax, az, bx, bz) => paths.add([ax, az, bx, bz],
    Math.min(ax, bx) - 2, Math.max(ax, bx) + 2, Math.min(az, bz) - 2, Math.max(az, bz) + 2);
  for (const link of layout.links) {
    if (link.kind !== 'alley' || !link.path || link.from.level < 0) continue;
    const pts = [link.from, ...link.path, link.to].map((c) => [c.x * cell, c.z * cell]);
    for (let i = 0; i < pts.length - 1; i++) addPath(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  }
  for (const info of surfaceRooms) {
    info.sides?.forEach((side, dir) => {
      if (!side || side.kind === 'stair') return;
      const step = [[0, -1], [1, 0], [0, 1], [-1, 0]][dir];
      const x = info.cell.x * cell; const z = info.cell.z * cell;
      addPath(x, z, x + step[0] * cell / 2, z + step[1] * cell / 2);
    });
  }
  const pathDistance = (x, z) => {
    let best = Infinity;
    for (const [ax, az, bx, bz] of paths.at(x, z)) {
      const vx = bx - ax; const vz = bz - az;
      const l2 = vx * vx + vz * vz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - vx * t, z - az - vz * t));
    }
    return best;
  };

  // --- sow ----------------------------------------------------------------------
  const rng = stream(90210);
  const blocks = new Map();
  const counts = { sown: 0, covered: 0, standing: 0, far: 0 };
  const pick = (mix, x, z) => {
    // Each card waxes and wanes in patches a few metres across, so the
    // buttercups come in drifts and not as a sprinkle.
    let total = 0;
    const w = mix.map((m, i) => { const v = m * (0.25 + 1.5 * patchNoise(x / 5.5, z / 5.5, 300 + i)); total += v; return v; });
    let t = rng() * total;
    for (let i = 0; i < w.length; i++) { t -= w[i]; if (t <= 0) return i; }
    return 0;
  };
  const sowPoint = (x, y, z, known = null) => {
    const here = known || ownerAt(x, y, z);
    if (!here) { counts.far++; return; }
    const open = !occupied.has(`${Math.round(x / cell)},${Math.round(z / cell)}`);
    if (covered(x, y, z)) { counts.covered++; return; }
    if (standing(x, y, z)) { counts.standing++; return; }
    const kind = open ? BIOMES.verge : (BIOMES[biomeOf(here.info.room)] || BIOMES.verge);
    let card = pick(kind.mix, x, z);
    let height = kind.height * (0.75 + rng() * 0.5) * (0.8 + 0.4 * patchNoise(x / 3, z / 3, 77));
    const trail = open ? Infinity : pathDistance(x, z);
    if (trail < 1.1) {
      // Trodden: the line itself is bare turf with the odd flattened tuft.
      if (rng() < 0.8) return;
      card = TRODDEN;
    } else if (trail < 2.2) {
      if (card === 2 || card === 3) card = 1;
      height *= 0.75;
    }
    const spec = GRASS_CARDS[card];
    const key = `${Math.floor(x / BLOCK)},${Math.floor(z / BLOCK)}`;
    let block = blocks.get(key);
    if (!block) { block = { pos: [], size: [], tint: [], y0: Infinity, y1: -Infinity }; blocks.set(key, block); }
    block.pos.push(x, y - 0.015, z, rng() * Math.PI * 2);
    block.size.push(spec.w * (0.85 + rng() * 0.4), spec.h * height, card, rng());
    // Drier and yellower in patches, and every clump a shade of its own.
    const dry = patchNoise(x / 9, z / 9, 51);
    const value = 0.94 + 0.12 * rng();
    block.tint.push(value * (0.96 + dry * 0.1), value, value * (1.02 - dry * 0.12), rng());
    block.y0 = Math.min(block.y0, y); block.y1 = Math.max(block.y1, y + spec.h * height);
    counts.sown++;
  };

  const inTri = (tri, x, z) => heightIn(tri, x, z);
  for (const { tri, area } of sown) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tri;
    if (area < 40) {
      const owner = ownerAt((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3);
      // Out on the horizon's hills, past where any eye in a room could see
      // a blade.
      if (!owner || owner.d > VERGE_END + 10) { counts.far++; continue; }
      const biome = BIOMES[biomeOf(owner.info.room)] || BIOMES.verge;
      const n = Math.floor(area * biome.density + rng());
      for (let k = 0; k < n; k++) {
        let r1 = rng(); let r2 = rng();
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        sowPoint(ax + (bx - ax) * r1 + (cx - ax) * r2, ay + (by - ay) * r1 + (cy - ay) * r2,
          az + (bz - az) * r1 + (cz - az) * r2);
      }
      continue;
    }
    // A big face -- the ground plane is 60 m a triangle -- is walked a grid
    // cell at a time, so the town it runs under can be skipped whole rather
    // than sown and then rejected point by point.
    const half = cell / 2;
    const gx0 = Math.round(Math.min(ax, bx, cx) / cell); const gx1 = Math.round(Math.max(ax, bx, cx) / cell);
    const gz0 = Math.round(Math.min(az, bz, cz) / cell); const gz1 = Math.round(Math.max(az, bz, cz) / cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const x = gx * cell; const z = gz * cell;
        const yc = inTri(tri, x, z);
        const owner = ownerAt(x, yc ?? ay, z);
        if (!owner || owner.d > VERGE_END + half) continue;
        // Nine probes: how much of the triangle's share of this cell is open.
        // As a share of the probes that land in the triangle, not of all nine
        // -- the samples below are already thrown away outside it, and
        // counting that twice sowed a hill's flank at a quarter of the field
        // beside it.
        let clear = 0; let inside = 0;
        for (const [ox, oz] of [[0, 0], [-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8], [0, -0.8], [0, 0.8], [-0.8, 0], [0.8, 0]]) {
          const px = x + ox * half; const pz = z + oz * half;
          const py = inTri(tri, px, pz);
          if (py === null) continue;
          inside++;
          if (!covered(px, py, pz)) clear++;
        }
        if (inside && !clear) continue;
        const mine = occupied.has(`${gx},${gz}`);
        const biome = mine ? (BIOMES[biomeOf(owner.info.room)] || BIOMES.verge) : BIOMES.verge;
        // The ground plane between and beyond the rooms: full near the town,
        // thinning out into the fields.
        const thin = mine ? 1 : 1 - Math.max(0, Math.min(1, (owner.d - VERGE_FULL) / (VERGE_END - VERGE_FULL)));
        const n = Math.floor(cell * cell * biome.density * (inside ? clear / inside : 1) * thin + rng());
        for (let k = 0; k < n; k++) {
          const px = x + (rng() - 0.5) * cell; const pz = z + (rng() - 0.5) * cell;
          const py = inTri(tri, px, pz);
          if (py !== null) sowPoint(px, py, pz, owner);
        }
      }
    }
  }

  // A modelled grass tuft on turf that now grows blades is a stiff, dark
  // starburst in the middle of a meadow: it was the only grass there was.
  // It stays where nothing is sown -- the burnt lots, the dust.
  if (instances) {
    const turf = new Buckets(8);
    for (const { tri } of sown) {
      const [ax, , az, bx, , bz, cx, , cz] = tri;
      turf.add(tri, Math.min(ax, bx, cx), Math.max(ax, bx, cx), Math.min(az, bz, cz), Math.max(az, bz, cz));
    }
    const onTurf = (t) => turf.at(t.x, t.z).some((tri) => {
      const h = heightIn(tri, t.x, t.z);
      return h !== null && Math.abs(h - t.y) < 0.35;
    });
    counts.tuftsDropped = 0;
    for (const [key, bucket] of instances.buckets) {
      if (bucket.asset.name !== 'grass_tuft') continue;
      const before = bucket.transforms.length;
      bucket.transforms = bucket.transforms.filter((t) => !onTurf(t));
      counts.tuftsDropped += before - bucket.transforms.length;
      if (!bucket.transforms.length) instances.buckets.delete(key);
    }
  }

  // --- draw ---------------------------------------------------------------------
  dressLit(lit);
  lit.userData.aoMaterial = NOT_IN_PREPASS;
  const depth = depthMaterial(lit);
  const clump = clumpGeometry();
  const field = new GrassField();
  for (const [key, block] of blocks) {
    const [bx, bz] = key.split(',').map(Number);
    const count = block.pos.length / 4;
    const geometry = new THREE.InstancedBufferGeometry();
    for (const name of ['position', 'uv', 'color', 'normal']) geometry.setAttribute(name, clump.getAttribute(name));
    geometry.setIndex(clump.getIndex());
    geometry.setAttribute('aGrassPos', new THREE.InstancedBufferAttribute(new Float32Array(block.pos), 4));
    geometry.setAttribute('aGrassSize', new THREE.InstancedBufferAttribute(new Float32Array(block.size), 4));
    geometry.setAttribute('aGrassTint', new THREE.InstancedBufferAttribute(new Float32Array(block.tint), 4));
    geometry.instanceCount = count;
    // The clump's own bounds are a unit card at the origin; the block's are
    // what the frustum has to test.
    const x0 = bx * BLOCK - 1; const x1 = (bx + 1) * BLOCK + 1;
    const z0 = bz * BLOCK - 1; const z1 = (bz + 1) * BLOCK + 1;
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(x0, block.y0, z0), new THREE.Vector3(x1, block.y1 + 0.3, z1));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geometry, lit);
    mesh.name = `grass ${key}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.customDepthMaterial = depth;
    // Nothing aims at a blade of grass: not the stand-finder, not a click.
    mesh.raycast = () => {};
    mesh.matrixAutoUpdate = false;
    field.add(mesh);
    field.blocks.push({ mesh, x0, x1, z0, z1, far: false });
  }

  /** Quality preset: how thick and how far. A uniform write, no recompile. */
  materials.setGrass = (name) => {
    const preset = GRASS_PRESETS[name] || GRASS_PRESETS.high;
    uniforms.uGrassDensity.value = preset.density;
    uniforms.uGrassRange.value.set(preset.range * 0.4, preset.range);
    field.range = preset.range;
    field.shadows = preset.shadows;
  };
  materials.setGrass('high');

  field.stats = {
    ...counts, blocks: blocks.size, sownTriangles: sown.length,
    ms: Math.round(performance.now() - t0),
  };
  return field;
}

