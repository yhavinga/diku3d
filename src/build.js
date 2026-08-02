/**
 * Geometry construction: laid-out cells -> a walkable, lit, shadowed town.
 *
 * The layout hands over a grid where rooms sit on the even coordinates and
 * everything between them is free. Rooms build themselves inside their own
 * cell -- a plaza filling it if the room is open ground, a walled box with a
 * roof if it is indoors -- and the cells a passage was routed through become
 * street. Every remaining empty cell that touches a street gets built on, which
 * is both what gives the town its frontage and what stops you walking into the
 * void.
 *
 * All static geometry is transformed to world space, given world-space UVs so
 * textures run continuously across surfaces, and merged per chunk per material.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SECTOR, ROOM_INDOORS, EX_ISDOOR, EX_CLOSED, EX_LOCKED, DIR_STEP, DIR_NAME } from './are.js';
import { InstanceBatch } from './assets.js';

export const CELL = 13;         // grid pitch; rooms sit two cells apart
export const ROOM = 10;         // interior span of an indoor room
export const WALL_IN = 0.3;     // inner skin
export const WALL_OUT = 0.4;    // outer skin
export const DOOR_W = 3.2;
export const DOOR_H = 3.1;
export const CEIL = 5.2;        // interior clear height
export const SLAB = 0.45;       // floor thickness
export const LEVEL_H = 7.6;     // vertical pitch between levels

/** Where a kit's wall panel is centred, measured from the room centre. */
const KIT_LINE = 5.35;

/** Rotation that turns a model's -Z front towards each direction. */
const FACE_ROT = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

const HALF = CELL / 2;
const SHELL = ROOM / 2 + WALL_IN + WALL_OUT;

// Staircase: a straight flight starting at the near wall and climbing across
// the room. The opening runs from the top of the flight back far enough to
// clear your head where the steps pass through the ceiling.
const STAIR_STEPS = 20;
const STAIR_RUN = 7.4;
const STAIR_START = ROOM / 2 - 0.5;
const STAIR_END = STAIR_START - STAIR_RUN;
const HOLE_CENTRE = (STAIR_END + 2.4) / 2;
const HOLE_RUN = 2.4 - STAIR_END;
const HOLE_SPAN = DOOR_W + 0.8;

const OUTDOOR = new Set([
  SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS,
  SECTOR.MOUNTAIN, SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT, SECTOR.AIR,
]);

export const isOutdoor = (room) => OUTDOOR.has(room.sector) && !(room.flags & ROOM_INDOORS);

export function hash3(a, b, c, salt = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647) ^ Math.imul(salt, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

// ------------------------------------------------------------- batching ----

const _matrix = new THREE.Matrix4();
const WHITE = [1, 1, 1];

class Batcher {
  constructor(materials) {
    this.materials = materials;
    this.groups = new Map();
  }

  /**
   * Transform a geometry into world space, project world-space UVs onto it,
   * paint vertex colours, and file it under (chunk, material).
   */
  add(geometry, materialName, matrix, options = {}) {
    const material = this.materials[materialName];
    if (!material) throw new Error(`build: unknown material ${materialName}`);
    const { tint = null, ao = null, chunk = '0', uvScale = null } = options;

    const geo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geo.applyMatrix4(matrix);
    geo.computeVertexNormals();

    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const scale = uvScale ?? material.userData.uvScale;
    const uv = new Float32Array(pos.count * 2);
    const col = new Float32Array(pos.count * 3);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
      const nx = Math.abs(nor.getX(i)); const ny = Math.abs(nor.getY(i)); const nz = Math.abs(nor.getZ(i));
      // Project from whichever axis the face points along: no UV bookkeeping,
      // and textures stay continuous where surfaces meet.
      if (ny >= nx && ny >= nz) { uv[i * 2] = x * scale; uv[i * 2 + 1] = z * scale; }
      else if (nx >= nz) { uv[i * 2] = z * scale; uv[i * 2 + 1] = y * scale; }
      else { uv[i * 2] = x * scale; uv[i * 2 + 1] = y * scale; }

      const shade = ao ? ao(x, y, z) : 1;
      const t = tint || WHITE;
      col[i * 3] = t[0] * shade;
      col[i * 3 + 1] = t[1] * shade;
      col[i * 3 + 2] = t[2] * shade;
    }

    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    for (const name of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'uv', 'color'].includes(name)) geo.deleteAttribute(name);
    }

    const key = `${chunk}|${materialName}`;
    let bucket = this.groups.get(key);
    if (!bucket) { bucket = { materialName, list: [] }; this.groups.set(key, bucket); }
    bucket.list.push(geo);
  }

  finish(parent) {
    let triangles = 0;
    for (const { materialName, list } of this.groups.values()) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) throw new Error(`build: could not merge ${materialName}`);
      merged.computeBoundingSphere();
      triangles += merged.attributes.position.count / 3;
      const mesh = new THREE.Mesh(merged, this.materials[materialName]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      for (const geo of list) if (geo !== merged) geo.dispose();
    }
    return { meshes: this.groups.size, triangles };
  }
}

// -------------------------------------------------------------- helpers ----

const boxCache = new Map();
function box(w, h, d, sw = 1, sh = 1, sd = 1) {
  const key = `${w},${h},${d},${sw},${sh},${sd}`;
  let geo = boxCache.get(key);
  if (!geo) { geo = new THREE.BoxGeometry(w, h, d, sw, sh, sd); boxCache.set(key, geo); }
  return geo;
}

const planeCache = new Map();
function plane(w, d, seg = 4) {
  const key = `${w},${d},${seg}`;
  let geo = planeCache.get(key);
  if (!geo) {
    geo = new THREE.PlaneGeometry(w, d, seg, seg);
    geo.rotateX(-Math.PI / 2);
    planeCache.set(key, geo);
  }
  return geo;
}

/** Triangular prism: gable roofs, dune wedges. */
function triPrism(width, height, depth) {
  const w = width / 2; const d = depth / 2;
  const v = [
    [-w, 0, -d], [w, 0, -d], [0, height, -d],
    [-w, 0, d], [w, 0, d], [0, height, d],
  ];
  const faces = [
    [0, 2, 1], [3, 4, 5],
    [0, 1, 4], [0, 4, 3],
    [1, 2, 5], [1, 5, 4],
    [2, 0, 3], [2, 3, 5],
  ];
  const positions = new Float32Array(faces.length * 9);
  let p = 0;
  for (const f of faces) for (const idx of f) { positions[p++] = v[idx][0]; positions[p++] = v[idx][1]; positions[p++] = v[idx][2]; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function place(x, y, z, rotY = 0) {
  _matrix.makeRotationY(rotY);
  _matrix.setPosition(x, y, z);
  return _matrix;
}

/** Darkening in corners and along walls: cheap contact shading. */
function floorAo(cx, cz, halfW, halfD) {
  return (x, y, z) => {
    const edge = Math.min(halfW - Math.abs(x - cx), halfD - Math.abs(z - cz));
    const t = Math.min(1, Math.max(0, edge / 1.9));
    return 0.55 + 0.45 * t * t * (3 - 2 * t);
  };
}

function wallAo(baseY) {
  return (x, y) => {
    const t = Math.min(1, Math.max(0, (y - baseY) / 1.8));
    return 0.58 + 0.42 * t;
  };
}

const unionRect = (rects) => rects.reduce((a, b) => ({
  x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1),
  z0: Math.min(a.z0, b.z0), z1: Math.max(a.z1, b.z1),
}));

/** Which way you step to get from one cell to its neighbour. */
function dirBetween(a, b) {
  for (let d = 0; d < 4; d++) {
    const [dx, , dz] = DIR_STEP[d];
    if (a.x + dx === b.x && a.z + dz === b.z) return d;
  }
  return -1;
}

// -------------------------------------------------------- material choice ----

function pickMaterials(room, area) {
  const name = `${room.name} ${area}`.toLowerCase();
  const cave = /moria|sewer|catacomb|cavern|mine|tunnel|crypt|grotto|den|dungeon/.test(name);
  const holy = /temple|altar|sanctum|shrine|chapel|cathedral/.test(name);
  const wood = /inn|bar|tavern|pub|shop|store|smith|baker|grocer|hall|guild|house|cabin|room/.test(name);

  let floor = 'flagstone';
  let wallIn = 'plaster';
  let wallOut = 'stonewall';
  let roof = 'rooftile';

  // What you are standing under. Only a vault or a cave has stone overhead:
  // over an ordinary room it is the joists and floorboards of whatever is
  // above, which is also why plastering it read as sprayed artex.
  let ceil = 'planks';

  if (cave) { floor = 'rock'; wallIn = 'rock'; wallOut = 'rock'; ceil = 'rock'; }
  else if (holy) { floor = 'marble'; wallIn = 'marble'; wallOut = 'marble'; roof = 'marble'; ceil = 'marble'; }
  else if (wood) { floor = 'planks'; wallIn = 'plaster'; wallOut = 'timber'; }

  switch (room.sector) {
    case SECTOR.CITY: floor = 'cobble'; break;
    case SECTOR.FIELD: case SECTOR.FOREST: case SECTOR.HILLS: floor = 'grass'; break;
    case SECTOR.MOUNTAIN: floor = 'rock'; break;
    case SECTOR.DESERT: floor = 'sand'; break;
    case SECTOR.WATER_SWIM: case SECTOR.WATER_NOSWIM: floor = 'water'; break;
    case SECTOR.AIR: floor = 'cloud'; break;
    default: break;
  }
  if (!holy && !cave && !wood && hash3(room.vnum, 0, 0, 9) > 0.6) wallOut = 'timber';
  if (!holy && hash3(room.vnum, 1, 0, 3) > 0.84) roof = 'thatch';
  return { floor, wallIn, wallOut, roof, ceil, holy, cave };
}

// ------------------------------------------------------------------ main ----

export function buildScene(world, layout, materials, assets = null) {
  const group = new THREE.Group();
  group.name = 'world';
  const batcher = new Batcher(materials);
  // Modelled assets are optional everywhere: if the library is absent or a
  // particular model has not been made yet, the procedural geometry stands in.
  const instances = assets ? new InstanceBatch(assets) : null;
  const model = (names, seed) => (assets ? assets.choose(names, seed) : null);

  const colliders = [];   // {x0,x1,z0,z1,y0,y1}
  const platforms = [];   // {x0,x1,z0,z1,top}
  const lights = [];      // {x,y,z,color,intensity,radius,flicker}
  const portals = [];     // walk-through archways
  const doors = [];       // interactive door panels
  const rooms = new Map();// vnum -> {room, cell, center, outdoor, materials, sides}
  const decor = [];       // handed to actors.js

  const addCollider = (x0, x1, z0, z1, y0, y1) => colliders.push({ x0, x1, z0, z1, y0, y1 });
  const addPlatform = (x0, x1, z0, z1, top) => platforms.push({ x0, x1, z0, z1, top });

  const worldOf = (cell) => ({ x: cell.x * CELL, y: cell.level * LEVEL_H, z: cell.z * CELL });
  const chunkOf = (cell) => `${cell.level}:${Math.floor(cell.x / 4)},${Math.floor(cell.z / 4)}`;

  // --- floor and ceiling openings for staircases ---------------------------

  const holes = new Map();
  const stairPlans = [];
  for (const link of layout.links) {
    if (link.kind !== 'stairs') continue;
    const goingUp = link.dir === 4;
    const lower = goingUp ? link.from : link.to;
    const upper = goingUp ? link.to : link.from;
    const dir = layout.stairSide.get(link);
    if (dir === undefined || !lower || !upper) continue;
    stairPlans.push({ lower, upper, dir });
    const [dx, , dz] = DIR_STEP[dir];
    const rect = {
      x0: dx * HOLE_CENTRE - (dx !== 0 ? HOLE_RUN : HOLE_SPAN) / 2,
      x1: dx * HOLE_CENTRE + (dx !== 0 ? HOLE_RUN : HOLE_SPAN) / 2,
      z0: dz * HOLE_CENTRE - (dz !== 0 ? HOLE_RUN : HOLE_SPAN) / 2,
      z1: dz * HOLE_CENTRE + (dz !== 0 ? HOLE_RUN : HOLE_SPAN) / 2,
    };
    if (!holes.has(upper.vnum)) holes.set(upper.vnum, []);
    holes.get(upper.vnum).push({ ...rect, ceiling: false });
    if (!holes.has(lower.vnum)) holes.set(lower.vnum, []);
    holes.get(lower.vnum).push({ ...rect, ceiling: true });
  }

  // --- the ground everything stands on -------------------------------------

  const { bounds } = layout;
  const groundY = -SLAB - 0.02;
  // Far enough out that the edge of the world is beyond the fog. It was four
  // cells, which the thinner fog of the current lighting made visible as a
  // brown line against the sky.
  const pad = 60;
  const gx0 = (bounds.minX - pad) * CELL; const gx1 = (bounds.maxX + pad) * CELL;
  const gz0 = (bounds.minZ - pad) * CELL; const gz1 = (bounds.maxZ + pad) * CELL;
  // What lies outside the walls is fields, not bare earth: dirt read as desert
  // once the fog thinned enough to see this far.
  batcher.add(plane(gx1 - gx0, gz1 - gz0, 32), 'grass',
    place((gx0 + gx1) / 2, groundY, (gz0 + gz1) / 2), { chunk: 'ground' });
  addPlatform(gx0, gx1, gz0, gz1, groundY);

  // --- rooms ---------------------------------------------------------------

  for (const cell of layout.order) {
    const room = cell.room;
    const pos = worldOf(cell);
    const chunk = chunkOf(cell);
    const outdoor = isOutdoor(room);
    const airborne = room.sector === SECTOR.AIR;
    const mats = pickMaterials(room, room.area);
    const sides = layout.sides.get(cell.vnum);
    const roomHoles = holes.get(cell.vnum) || [];

    // A modelled room kit, where one fits. Caves keep their procedural rock --
    // the kits are dressed masonry and would look absurd in Moria.
    const kit = (!outdoor && !mats.cave && instances)
      ? (mats.holy && model(['temple_wall_solid']) ? 'temple_'
        : (model(['wall_solid']) ? '' : null))
      : null;

    // Nothing can reach an "In the air..." room now that its archways are not
    // built, so its floor is pure scenery -- and a translucent slab hanging
    // over the rooftops reads as a bug, which is what the review called it.
    if (airborne) {
      rooms.set(room.vnum, {
        room, cell, center: new THREE.Vector3(pos.x, pos.y, pos.z), outdoor,
        chunk, materials: mats, sides, unbuilt: true,
      });
      continue;
    }

    rooms.set(room.vnum, {
      room, cell, center: new THREE.Vector3(pos.x, pos.y, pos.z), outdoor,
      chunk, materials: mats, sides,
    });

    const half = airborne ? ROOM / 2 : (outdoor ? HALF : ROOM / 2);
    buildFloor({
      batcher, chunk, material: mats.floor, x: pos.x, y: pos.y, z: pos.z,
      half, holes: roomHoles.filter((h) => !h.ceiling), addPlatform, slab: !airborne,
    });

    if (room.sector === SECTOR.WATER_SWIM || room.sector === SECTOR.WATER_NOSWIM) {
      decor.push({ kind: 'water', x: pos.x, y: pos.y + 0.7, z: pos.z, size: half * 2 });
    }

    for (let dir = 0; dir < 4; dir++) {
      const side = sides[dir];
      const [dx, , dz] = DIR_STEP[dir];
      const rotY = (dir === 1 || dir === 3) ? Math.PI / 2 : 0;
      const open = side && (side.kind === 'alley' || side.kind === 'portal');
      const distance = outdoor ? HALF : ROOM / 2;
      const wx = pos.x + dx * distance;
      const wz = pos.z + dz * distance;

      if (!outdoor) {
        buildIndoorWall({
          batcher, chunk, mats, x: wx, y: pos.y, z: wz, rotY, open, kit, instances,
          width: ROOM + (WALL_IN + WALL_OUT) * 2, addCollider, dir, room, lights, decor,
          cellX: pos.x, cellZ: pos.z,
        });
      } else if (!airborne) {
        buildOutdoorEdge({ batcher, chunk, room, cell, pos, dir, open, addCollider, decor, lights });
      }

      // "In the air..." rooms sit three levels above the roofs. An archway
      // built for one hangs over the town with its signpost floating beside it,
      // which is exactly what it looks like. They are scenery; leave them bare.
      if (side && (side.kind === 'portal' || side.kind === 'gate') && !airborne) {
        const ax = pos.x + dx * (distance - 0.1);
        const az = pos.z + dz * (distance - 0.1);
        buildArch({ batcher, instances, model, chunk, x: ax, y: pos.y, z: az, rotY, sealed: side.kind === 'gate' });
        if (side.kind === 'portal') {
          portals.push({
            x: ax - dx * 0.8, y: pos.y, z: az - dz * 0.8, radius: 1.6,
            target: side.target.vnum, from: room.vnum, label: side.target.room.name, dir,
          });
          lights.push({ x: ax, y: pos.y + 2.2, z: az, color: 0x7fd8ff, intensity: 5, radius: 10 });
        } else {
          decor.push({
            kind: 'gateSign', x: ax - dx * 0.9, y: pos.y + 2.7, z: az - dz * 0.9, rotY,
            text: `${DIR_NAME[side.link.dir]} · #${side.exit ? side.exit.to : '?'} — outside the loaded world`,
          });
        }
      }

      if (side && side.exit && (side.exit.locks & EX_ISDOOR)) {
        doors.push({
          x: wx + dx * (outdoor ? -0.3 : (WALL_IN + WALL_OUT) / 2), y: pos.y,
          z: wz + dz * (outdoor ? -0.3 : (WALL_IN + WALL_OUT) / 2), rotY, dir,
          width: DOOR_W, height: DOOR_H,
          closed: !!(side.exit.locks & EX_CLOSED),
          locked: !!(side.exit.locks & EX_LOCKED),
          keyword: side.exit.keyword || 'door',
          room: room.vnum,
        });
      }
    }

    // links that had no free wall left: an arch standing in the room itself
    for (const link of layout.links) {
      if (link.from !== cell || link.side !== null || link.kind === 'alley' || link.kind === 'stairs') continue;
      if (airborne) continue;
      const angle = hash3(room.vnum, 5, 0, 1) * Math.PI * 2;
      const ax = pos.x + Math.cos(angle) * half * 0.4;
      const az = pos.z + Math.sin(angle) * half * 0.4;
      buildArch({ batcher, instances, model, chunk, x: ax, y: pos.y, z: az, rotY: -angle, sealed: link.kind === 'gate' });
      if (link.kind === 'portal' && link.to) {
        portals.push({
          x: ax, y: pos.y, z: az, radius: 1.6, target: link.to.vnum,
          from: room.vnum, label: link.to.room.name, dir: link.dir,
        });
        lights.push({ x: ax, y: pos.y + 2.2, z: az, color: 0x7fd8ff, intensity: 5, radius: 10 });
      }
    }

    if (kit !== null) {
      // Corner piers close the four panels; the roof sits on the eaves, which
      // is exactly where a panel's cornice ends.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          instances.add(`${kit}corner`, { x: pos.x + sx * KIT_LINE, y: pos.y, z: pos.z + sz * KIT_LINE, rotY: 0 }, chunk);
        }
      }
      instances.add(`${kit}roof`, { x: pos.x, y: pos.y + CEIL, z: pos.z, rotY: 0 }, chunk);
      if (kit === 'temple_') {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            instances.add('temple_column', { x: pos.x + sx * 3.0, y: pos.y, z: pos.z + sz * 3.0, rotY: 0 }, chunk);
          }
        }
      }
    }

    if (!outdoor) {
      buildCeiling({
        batcher, chunk, material: mats.ceil, x: pos.x, y: pos.y + CEIL, z: pos.z,
        half: ROOM / 2 + WALL_IN, holes: roomHoles.filter((h) => h.ceiling),
      });
      if (kit === null) buildRoof({ batcher, chunk, mats, room, x: pos.x, y: pos.y + CEIL + SLAB, z: pos.z, decor });
      decor.push({
        kind: 'windows', x: pos.x, y: pos.y, z: pos.z,
        w: SHELL * 2, d: SHELL * 2, h: CEIL + 1.1, seed: hash3(room.vnum, 2, 0, 11), doorSides: sides,
      });
      buildInteriorProps({ room, pos, sides, decor, mats });
    } else {
      // Out of doors the same thing, against the sides with no way out of
      // them, so a square reads as somewhere people keep their things rather
      // than as swept paving.
      const blank = [];
      for (let d = 0; d < 4; d++) if (!sides[d]) blank.push(d);
      if (blank.length && hash3(room.vnum, 13, 0, 6) > 0.28) {
        decor.push({
          kind: 'clutter', x: pos.x, y: pos.y, z: pos.z, half: HALF,
          walls: blank, seed: hash3(room.vnum, 12, 0, 5), indoor: false,
        });
      }
    }

    // upper floors need something underneath them
    if (cell.level > 0 && layout.at(cell.level - 1, cell.x, cell.z) === undefined && !airborne) {
      const h = LEVEL_H;
      const s = outdoor ? HALF : SHELL;
      batcher.add(box(s * 2, h, s * 2), 'stonewall', place(pos.x, pos.y - SLAB - h / 2, pos.z), {
        chunk, ao: wallAo(pos.y - SLAB - h),
      });
      addCollider(pos.x - s, pos.x + s, pos.z - s, pos.z + s, pos.y - SLAB - h, pos.y - SLAB);
    }
  }

  // --- streets and corridors ----------------------------------------------

  for (const link of layout.links) {
    if (link.kind !== 'alley') continue;
    // A corridor to a room that was never built is a corridor to nowhere, and
    // it hangs in the sky: "In the air..." rooms are lifted three levels and
    // then skipped, but their passages were still routed and walled. An
    // enclosed one is a thirteen-metre box with a ceiling slab whose inside
    // faces catch no light, which is what read as a black slab over the town.
    const fromInfo = rooms.get(link.from.vnum);
    const toInfo = rooms.get(link.to.vnum);
    if ((fromInfo && fromInfo.unbuilt) || (toInfo && toInfo.unbuilt)) continue;
    buildAlley({ batcher, link, worldOf, chunkOf, addCollider, addPlatform, lights, decor });
  }

  for (const plan of stairPlans) {
    buildStair({
      batcher, plan, worldOf, chunkOf, addCollider, addPlatform,
      materials: pickMaterials(plan.lower.room, plan.lower.room.area),
    });
  }

  // --- build on every empty cell that fronts a street ----------------------

  const frontage = new Map(); // cell key -> sector to build from
  const consider = (level, x, z, sector) => {
    if (layout.at(level, x, z) !== undefined || layout.isPath(level, x, z)) return;
    const k = `${level}:${x},${z}`;
    if (!frontage.has(k)) frontage.set(k, { level, x, z, sector });
  };
  for (const cell of layout.order) {
    if (!isOutdoor(cell.room) || cell.room.sector === SECTOR.AIR) continue;
    for (let dir = 0; dir < 4; dir++) {
      const [dx, , dz] = DIR_STEP[dir];
      consider(cell.level, cell.x + dx, cell.z + dz, cell.room.sector);
    }
  }
  for (const link of layout.links) {
    if (link.kind !== 'alley' || alleyEnclosed(link)) continue;
    // Same reason as above: no frontage along a passage that does not exist.
    if (rooms.get(link.from.vnum)?.unbuilt || rooms.get(link.to.vnum)?.unbuilt) continue;
    const sector = isOutdoor(link.from.room) ? link.from.room.sector : link.to.room.sector;
    for (const c of link.path) {
      for (let dir = 0; dir < 4; dir++) {
        const [dx, , dz] = DIR_STEP[dir];
        consider(link.from.level, c.x + dx, c.z + dz, sector);
      }
    }
  }
  for (const spot of frontage.values()) {
    // Face the house at the street. Models are built fronting -Z, so the
    // rotation that turns that front towards direction d is FACE_ROT[d]. It
    // also keeps the jetties and hoist beams oversailing a road, not a
    // neighbour's roof.
    let faces = -1;
    for (let dir = 0; dir < 4 && faces < 0; dir++) {
      const [dx, , dz] = DIR_STEP[dir];
      const nx = spot.x + dx; const nz = spot.z + dz;
      if (layout.at(spot.level, nx, nz) !== undefined || layout.isPath(spot.level, nx, nz)) faces = dir;
    }
    buildFiller({
      batcher, instances, model, faceRot: faces < 0 ? null : FACE_ROT[faces],
      chunk: `${spot.level}:${Math.floor(spot.x / 4)},${Math.floor(spot.z / 4)}`,
      sector: spot.sector, x: spot.x * CELL, y: spot.level * LEVEL_H, z: spot.z * CELL,
      seed: hash3(spot.x, spot.z, spot.level, 17), addCollider, lights, decor,
    });
  }

  const stats = batcher.finish(group);
  if (instances) {
    const placed = instances.finish(group);
    stats.meshes += placed.meshes;
    stats.triangles += placed.triangles;
    stats.instanced = placed.triangles;
  }
  return { group, colliders, platforms, lights, portals, doors, rooms, decor, stats };
}

const alleyEnclosed = (link) => !isOutdoor(link.from.room) && !isOutdoor(link.to.room);

// ---------------------------------------------------------------- pieces ----

function buildFloor({ batcher, chunk, material, x, y, z, half, holes, addPlatform, slab = true }) {
  const emit = (cx, cz, w, d) => {
    batcher.add(plane(w, d, Math.max(2, Math.round(w / 2))), material, place(cx, y, cz), {
      chunk, ao: slab ? floorAo(x, z, half, half) : null,
    });
    if (slab) batcher.add(box(w, SLAB, d), material, place(cx, y - SLAB / 2 - 0.01, cz), { chunk });
    addPlatform(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, y);
  };
  if (!holes.length) { emit(x, z, half * 2, half * 2); return; }
  // Split the slab into strips around the opening a staircase passes through.
  const hole = unionRect(holes);
  for (const b of [
    { x0: -half, x1: half, z0: -half, z1: hole.z0 },
    { x0: -half, x1: half, z0: hole.z1, z1: half },
    { x0: -half, x1: hole.x0, z0: hole.z0, z1: hole.z1 },
    { x0: hole.x1, x1: half, z0: hole.z0, z1: hole.z1 },
  ]) {
    const w = b.x1 - b.x0; const d = b.z1 - b.z0;
    if (w <= 0.05 || d <= 0.05) continue;
    emit(x + (b.x0 + b.x1) / 2, z + (b.z0 + b.z1) / 2, w, d);
  }
}

function buildCeiling({ batcher, chunk, material, x, y, z, half, holes }) {
  const emit = (cx, cz, w, d) => batcher.add(box(w, SLAB, d), material,
    place(cx, y + SLAB / 2, cz), { chunk, ao: () => 0.62 });
  if (!holes.length) { emit(x, z, half * 2, half * 2); return; }
  const hole = unionRect(holes);
  for (const b of [
    { x0: -half, x1: half, z0: -half, z1: hole.z0 },
    { x0: -half, x1: half, z0: hole.z1, z1: half },
    { x0: -half, x1: hole.x0, z0: hole.z0, z1: hole.z1 },
    { x0: hole.x1, x1: half, z0: hole.z0, z1: hole.z1 },
  ]) {
    const w = b.x1 - b.x0; const d = b.z1 - b.z0;
    if (w <= 0.05 || d <= 0.05) continue;
    emit(x + (b.x0 + b.x1) / 2, z + (b.z0 + b.z1) / 2, w, d);
  }
}

/**
 * One wall of an indoor room: an inner skin you see from inside, an outer skin
 * that is the face of the building, and a doorway punched through both.
 */
function buildIndoorWall({ batcher, chunk, mats, x, y, z, rotY, open, kit, instances, width, addCollider, dir, room, lights, decor, cellX, cellZ }) {
  const gap = open ? DOOR_W : 0;
  const eave = CEIL + 1.1;
  const [dx, , dz] = DIR_STEP[dir];
  const along = dir === 1 || dir === 3;

  // A modelled panel spans the whole wall and carries its own doorway, so the
  // two procedural skins are skipped -- but the colliders below are unchanged,
  // because they describe the wall line, not the geometry sitting on it.
  if (kit !== null && kit !== undefined && instances) {
    instances.add(`${kit}${open ? 'wall_door' : 'wall_solid'}`, {
      x: cellX + dx * KIT_LINE, y, z: cellZ + dz * KIT_LINE, rotY: FACE_ROT[dir],
    }, chunk);
  }

  for (const skin of (kit !== null && kit !== undefined && instances ? [] : [
    { name: mats.wallIn, t: WALL_IN, offset: WALL_IN / 2, height: CEIL },
    { name: mats.wallOut, t: WALL_OUT, offset: WALL_IN + WALL_OUT / 2, height: eave },
  ])) {
    const sx = x + dx * skin.offset;
    const sz = z + dz * skin.offset;
    if (!gap) {
      batcher.add(box(width, skin.height, skin.t, 3, 4, 1), skin.name,
        place(sx, y + skin.height / 2, sz, rotY), { chunk, ao: wallAo(y) });
      continue;
    }
    const sideW = (width - gap) / 2;
    for (const s of [-1, 1]) {
      const offset = s * (gap + sideW) / 2;
      batcher.add(box(sideW, skin.height, skin.t, 2, 4, 1), skin.name,
        place(sx + (along ? 0 : offset), y + skin.height / 2, sz + (along ? offset : 0), rotY),
        { chunk, ao: wallAo(y) });
    }
    const lintel = skin.height - DOOR_H;
    if (lintel > 0.05) {
      batcher.add(box(gap, lintel, skin.t, 2, 1, 1), skin.name,
        place(sx, y + DOOR_H + lintel / 2, sz, rotY), { chunk, ao: () => 0.72 });
    }
  }

  const t = WALL_IN + WALL_OUT;
  const centre = along ? z : x;
  const addWall = (c0, c1) => {
    if (along) addCollider(x - t * 0.2, x + dx * t + t * 0.2, c0, c1, y, y + eave);
    else addCollider(c0, c1, z - t * 0.2, z + dz * t + t * 0.2, y, y + eave);
  };
  if (!gap) addWall(centre - width / 2, centre + width / 2);
  else {
    addWall(centre - width / 2, centre - gap / 2);
    addWall(centre + gap / 2, centre + width / 2);
  }

  if (room.sector !== SECTOR.INSIDE) return;
  const px = x - dx * 0.7;
  const pz = z - dz * 0.7;
  const spots = gap ? [-(gap / 2 + 0.8), gap / 2 + 0.8] : [0];
  for (const s of spots) {
    const tx = px + (along ? 0 : s);
    const tz = pz + (along ? s : 0);
    decor.push({ kind: 'torch', x: tx, y: y + 2.9, z: tz, rotY });
    lights.push({ x: tx - dx * 0.4, y: y + 3.4, z: tz - dz * 0.4, color: 0xffa347, intensity: 9, radius: 11, flicker: true });
  }
}

/** The boundary of an open-air room: an opening, or something to stop you. */
function buildOutdoorEdge({ batcher, chunk, room, cell, pos, dir, open, addCollider, decor, lights }) {
  if (open) {
    if (room.sector === SECTOR.CITY && dir === 0 && hash3(cell.x, cell.z, cell.level, 5) > 0.5) {
      const sx = hash3(cell.x, cell.z, 1, 6) > 0.5 ? 1 : -1;
      const sz = hash3(cell.x, cell.z, 2, 7) > 0.5 ? 1 : -1;
      const lx = pos.x + (HALF - 1.3) * sx;
      const lz = pos.z + (HALF - 1.3) * sz;
      decor.push({ kind: 'lamp', x: lx, y: pos.y, z: lz });
      lights.push({ x: lx, y: pos.y + 3.9, z: lz, color: 0xffc182, intensity: 26, radius: 21, flicker: true });
      addCollider(lx - 0.3, lx + 0.3, lz - 0.3, lz + 0.3, pos.y, pos.y + 4.2);
    }
    return;
  }

  const [dx, , dz] = DIR_STEP[dir];
  const bx = pos.x + dx * (HALF - 0.3);
  const bz = pos.z + dz * (HALF - 0.3);
  const along = dir === 1 || dir === 3;
  const t = 0.6;
  const h = room.sector === SECTOR.CITY ? 2.6 : 1.4;
  const material = room.sector === SECTOR.CITY ? 'stonewall' : 'rock';
  batcher.add(box(along ? t : CELL, h, along ? CELL : t, 2, 2, 2), material,
    place(bx, pos.y + h / 2, bz), { chunk, ao: wallAo(pos.y) });
  addCollider(bx - (along ? t : CELL) / 2, bx + (along ? t : CELL) / 2,
    bz - (along ? CELL : t) / 2, bz + (along ? CELL : t) / 2, pos.y, pos.y + h + 2);
  void decor;
}

/**
 * A routed passage, cell by cell. Out of doors it is left open and the
 * buildings that fill the cells beside it become the street frontage; between
 * two indoor rooms it gets walls and a ceiling and becomes a corridor.
 */
function buildAlley({ batcher, link, worldOf, chunkOf, addCollider, addPlatform, lights, decor }) {
  const enclosed = alleyEnclosed(link);
  const source = isOutdoor(link.from.room) ? link.from.room : link.to.room;
  const mats = pickMaterials(source, source.area);
  const level = link.from.level;
  const y = level * LEVEL_H;
  const chain = [link.from, ...link.path, link.to];

  for (let i = 1; i < chain.length - 1; i++) {
    const c = chain[i];
    const cellRef = { x: c.x, z: c.z, level };
    const chunk = chunkOf(cellRef);
    const pos = worldOf(cellRef);
    const openDirs = new Set([dirBetween(c, chain[i - 1]), dirBetween(c, chain[i + 1])]);

    batcher.add(plane(CELL, CELL, 6), mats.floor, place(pos.x, y, pos.z), {
      chunk, ao: enclosed ? floorAo(pos.x, pos.z, HALF, HALF) : null,
    });
    batcher.add(box(CELL, SLAB, CELL), mats.floor, place(pos.x, y - SLAB / 2 - 0.01, pos.z), { chunk });
    addPlatform(pos.x - HALF, pos.x + HALF, pos.z - HALF, pos.z + HALF, y);

    if (!enclosed) {
      // Was 0.86 -- one street cell in seven carried anything at all, which is
      // most of why the town read as a blockout. The two open ends of the
      // passage are excluded so nothing lands in the middle of the way through.
      if (hash3(c.x, c.z, level, 12) > 0.45) {
        const walls = [0, 1, 2, 3].filter((d) => !openDirs.has(d));
        decor.push({
          kind: 'clutter', x: pos.x, y, z: pos.z, half: HALF,
          walls: walls.length ? walls : [0, 1, 2, 3],
          seed: hash3(c.x, c.z, level, 13), indoor: false,
        });
      }
      continue;
    }

    for (let dir = 0; dir < 4; dir++) {
      if (openDirs.has(dir)) continue;
      const [dx, , dz] = DIR_STEP[dir];
      const along = dir === 1 || dir === 3;
      const t = 0.5;
      const wx = pos.x + dx * (HALF - t / 2);
      const wz = pos.z + dz * (HALF - t / 2);
      batcher.add(box(along ? t : CELL, CEIL, along ? CELL : t, 2, 3, 2), mats.wallIn,
        place(wx, y + CEIL / 2, wz), { chunk, ao: wallAo(y) });
      addCollider(wx - (along ? t : CELL) / 2, wx + (along ? t : CELL) / 2,
        wz - (along ? CELL : t) / 2, wz + (along ? CELL : t) / 2, y, y + CEIL);
    }
    batcher.add(box(CELL, SLAB, CELL), mats.ceil, place(pos.x, y + CEIL + SLAB / 2, pos.z), { chunk, ao: () => 0.6 });
    if (hash3(c.x, c.z, level, 14) > 0.45) {
      const wallDir = [0, 1, 2, 3].find((d) => !openDirs.has(d));
      if (wallDir !== undefined) {
        const [dx, , dz] = DIR_STEP[wallDir];
        const tx = pos.x + dx * (HALF - 1.0);
        const tz = pos.z + dz * (HALF - 1.0);
        decor.push({ kind: 'torch', x: tx, y: y + 2.9, z: tz, rotY: (wallDir === 1 || wallDir === 3) ? Math.PI / 2 : 0 });
        lights.push({ x: tx - dx * 0.4, y: y + 3.4, z: tz - dz * 0.4, color: 0xffa347, intensity: 9, radius: 11, flicker: true });
      }
    }
  }
}

/** A stone archway: portals you step through, gates that are sealed. */
function buildArch({ batcher, instances, model, chunk, x, y, z, rotY, sealed }) {
  const arch = model(['stone_arch'], 0);
  if (arch && instances) {
    instances.add(arch, { x, y, z, rotY }, chunk);
    const bars = sealed ? model(['portcullis'], 0) : null;
    if (bars) instances.add(bars, { x, y, z, rotY }, chunk);
    if (bars || !sealed) return;
  }
  const t = 0.8;
  const h = DOOR_H + 1.0;
  const post = 0.7;
  for (const s of [-1, 1]) {
    batcher.add(box(post, h, t, 1, 3, 1), 'stonewall', place(
      x + Math.cos(rotY) * s * (DOOR_W + post) / 2, y + h / 2,
      z - Math.sin(rotY) * s * (DOOR_W + post) / 2, rotY,
    ), { chunk, ao: wallAo(y) });
  }
  batcher.add(box(DOOR_W + post * 2, 0.8, t, 2, 1, 1), 'stonewall',
    place(x, y + h + 0.4, z, rotY), { chunk, ao: () => 0.8 });
  if (!sealed) return;
  for (let i = 0; i < 5; i++) {
    const off = (i - 2) * (DOOR_W / 5);
    batcher.add(box(0.18, h, 0.18), 'iron',
      place(x + Math.cos(rotY) * off, y + h / 2, z - Math.sin(rotY) * off, rotY), { chunk });
  }
  batcher.add(box(DOOR_W, 0.2, 0.2), 'iron', place(x, y + h * 0.55, z, rotY), { chunk });
}

/** Straight flight from the lower room up through the opening in its ceiling. */
function buildStair({ batcher, plan, worldOf, chunkOf, addCollider, addPlatform, materials }) {
  const lower = worldOf(plan.lower);
  const chunk = chunkOf(plan.lower);
  const [dx, , dz] = DIR_STEP[plan.dir];
  const rise = LEVEL_H;
  const riser = rise / STAIR_STEPS;
  const run = STAIR_RUN / STAIR_STEPS;

  for (let i = 0; i < STAIR_STEPS; i++) {
    const along = STAIR_START - run * (i + 0.5);
    const cx = lower.x + dx * along;
    const cz = lower.z + dz * along;
    const y = lower.y + riser * (i + 1);
    const w = dx !== 0 ? run : DOOR_W;
    const d = dz !== 0 ? run : DOOR_W;
    batcher.add(box(w, riser, d), materials.floor, place(cx, y - riser / 2, cz),
      { chunk, ao: () => 0.72 + 0.28 * (i / STAIR_STEPS) });
    addPlatform(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, y);
  }

  const segments = 6;
  for (const s of [-1, 1]) {
    const offX = dx !== 0 ? 0 : s * (DOOR_W / 2 + 0.15);
    const offZ = dz !== 0 ? 0 : s * (DOOR_W / 2 + 0.15);
    for (let i = 0; i < segments; i++) {
      const t = (i + 0.5) / segments;
      const along = STAIR_START - STAIR_RUN * t;
      const y = lower.y + rise * t + 0.95;
      const w = dx !== 0 ? STAIR_RUN / segments : 0.18;
      const d = dz !== 0 ? STAIR_RUN / segments : 0.18;
      batcher.add(box(w, 0.18, d), 'iron', place(lower.x + dx * along + offX, y, lower.z + dz * along + offZ), { chunk });
      batcher.add(box(0.13, 0.95, 0.13), 'iron', place(lower.x + dx * along + offX, y - 0.5, lower.z + dz * along + offZ), { chunk });
    }
    const railW = dx !== 0 ? STAIR_RUN : 0.3;
    const railD = dz !== 0 ? STAIR_RUN : 0.3;
    const cx = lower.x + dx * (STAIR_START - STAIR_RUN / 2) + offX;
    const cz = lower.z + dz * (STAIR_START - STAIR_RUN / 2) + offZ;
    addCollider(cx - railW / 2, cx + railW / 2, cz - railD / 2, cz + railD / 2, lower.y, lower.y + rise);
  }
}

/** Pitched roof over an indoor room, with a chimney now and then. */
function buildRoof({ batcher, chunk, mats, room, x, y, z, decor }) {
  const span = SHELL * 2 + 1.0;
  const height = mats.holy ? 1.6 : 2.4 + hash3(room.vnum, 3, 0, 2) * 1.2;
  const alongX = hash3(room.vnum, 4, 0, 8) > 0.5;
  batcher.add(triPrism(span, height, span), mats.roof, place(x, y, z, alongX ? Math.PI / 2 : 0),
    { chunk, ao: (px, py) => 0.72 + 0.28 * ((py - y) / height) });
  if (!mats.holy && hash3(room.vnum, 6, 0, 4) > 0.55) {
    const cx = x + (hash3(room.vnum, 7, 0, 5) - 0.5) * span * 0.45;
    const cz = z + (hash3(room.vnum, 8, 0, 6) - 0.5) * span * 0.45;
    batcher.add(box(1.1, height + 1.4, 1.1), 'stonewall', place(cx, y + (height + 1.4) / 2, cz), { chunk });
    decor.push({ kind: 'smoke', x: cx, y: y + height + 1.6, z: cz });
  }
}

function buildInteriorProps({ room, pos, sides, decor, mats }) {
  const blank = [];
  for (let d = 0; d < 4; d++) if (!sides[d]) blank.push(d);
  if (blank.length && /temple|altar|sanctum|hall|throne/i.test(room.name)) {
    decor.push({ kind: 'banner', x: pos.x, y: pos.y, z: pos.z, dir: blank[0] });
  }
  // An inn with a named landlord was a bare stone box: eighteen prop models
  // existed and only routed alley cells ever placed one. Rooms dress
  // themselves now, against whichever walls have no door in them.
  if (blank.length) {
    decor.push({
      kind: 'clutter', x: pos.x, y: pos.y, z: pos.z, half: SHELL,
      walls: blank, seed: hash3(room.vnum, 12, 0, 5), indoor: true,
    });
  }
  if (mats.floor === 'planks' && hash3(room.vnum, 9, 0, 7) > 0.45) {
    decor.push({
      kind: 'table',
      x: pos.x + (hash3(room.vnum, 10, 0, 1) - 0.5) * 3.5, y: pos.y,
      z: pos.z + (hash3(room.vnum, 11, 0, 2) - 0.5) * 3.5,
    });
  }
}

/** Scenery for an empty cell: houses along a street, trees along a path. */
function buildFiller({ batcher, instances, model, faceRot, chunk, sector, x, y, z, seed, addCollider, lights, decor }) {
  // Pave the cell to match its street before building on it. Without this the
  // world's ground plane shows through around the footings -- which read as a
  // lawn once that plane became grass.
  const GROUND = {
    [SECTOR.CITY]: 'cobble', [SECTOR.FIELD]: 'grass', [SECTOR.FOREST]: 'grass',
    [SECTOR.HILLS]: 'grass', [SECTOR.MOUNTAIN]: 'rock', [SECTOR.DESERT]: 'sand',
  };
  const ground = GROUND[sector];
  if (ground) {
    batcher.add(plane(CELL, CELL, 3), ground, place(x, y, z), { chunk });
  }

  switch (sector) {
    case SECTOR.CITY: {
      const w = CELL * 0.92;
      const d = CELL * 0.92;
      const h = 5.5 + seed * 6.5;
      const stone = hash3(x, z, 0, 22) > 0.5;
      const house = model(stone
        ? ['house_stone_a', 'house_stone_b', 'house_a', 'house_b', 'house_c']
        : ['house_a', 'house_b', 'house_c', 'house_stone_a', 'house_stone_b'], seed);
      if (house && instances) {
        // A modelled house comes with its own roof, windows and chimney; the
        // only thing left to decide is which way its front faces the street.
        const modelled = instances.library.get(house);
        const fit = Math.min(1.15, (CELL * 0.92) / Math.max(0.001, Math.max(modelled.size.x, modelled.size.z)));
        instances.add(house, {
          x, y, z, rotY: faceRot ?? Math.floor(hash3(x, z, 0, 25) * 4) * (Math.PI / 2),
          scaleX: fit, scaleZ: fit, scaleY: fit * (0.85 + seed * 0.4),
        }, chunk);
        const height = modelled.size.y * fit * (0.85 + seed * 0.4);
        addCollider(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y, y + height);
        if (hash3(x, z, 0, 27) > 0.55) decor.push({ kind: 'smoke', x, y: y + height, z });
        break;
      }
      const material = stone ? 'stonewall' : 'timber';
      batcher.add(box(w, h, d, 3, 4, 3), material, place(x, y + h / 2, z), { chunk, ao: wallAo(y) });
      const roofH = 2.0 + hash3(x, z, 0, 23) * 1.5;
      batcher.add(triPrism(w + 0.9, roofH, d + 0.9), hash3(x, z, 0, 24) > 0.82 ? 'thatch' : 'rooftile',
        place(x, y + h, z, hash3(x, z, 0, 25) > 0.5 ? Math.PI / 2 : 0), { chunk });
      addCollider(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y, y + h);
      decor.push({ kind: 'windows', x, y, z, w, d, h, seed: hash3(x, z, 0, 26) });
      if (hash3(x, z, 0, 27) > 0.55) decor.push({ kind: 'smoke', x, y: y + h + roofH, z });
      break;
    }
    case SECTOR.FOREST: {
      for (let i = 0; i < 5; i++) {
        const tx = x + (hash3(x, z, i, 31) - 0.5) * CELL * 0.9;
        const tz = z + (hash3(x, z, i, 32) - 0.5) * CELL * 0.9;
        decor.push({ kind: 'tree', x: tx, y, z: tz, scale: 0.7 + hash3(x, z, i, 33) * 0.8 });
        addCollider(tx - 0.7, tx + 0.7, tz - 0.7, tz + 0.7, y, y + 8);
      }
      break;
    }
    case SECTOR.MOUNTAIN: case SECTOR.HILLS: {
      const h = sector === SECTOR.MOUNTAIN ? 11 : 4;
      batcher.add(box(CELL, h, CELL, 3, 3, 3), 'rock', place(x, y + h / 2 - 0.8, z), { chunk, ao: wallAo(y) });
      addCollider(x - HALF, x + HALF, z - HALF, z + HALF, y, y + h - 0.8);
      break;
    }
    case SECTOR.DESERT: {
      batcher.add(triPrism(CELL, 2.6, CELL), 'sand', place(x, y, z, hash3(x, z, 0, 41) * Math.PI), { chunk });
      addCollider(x - HALF, x + HALF, z - HALF, z + HALF, y, y + 2.6);
      break;
    }
    case SECTOR.WATER_SWIM: case SECTOR.WATER_NOSWIM: {
      decor.push({ kind: 'water', x, y: y + 0.7, z, size: CELL });
      break;
    }
    case SECTOR.AIR: break;
    default: {
      const h = 2.2;
      batcher.add(box(CELL, h, CELL, 2, 2, 2), 'rock', place(x, y + h / 2 - 0.6, z), { chunk, ao: wallAo(y) });
      addCollider(x - HALF, x + HALF, z - HALF, z + HALF, y, y + h - 0.6);
      for (let i = 0; i < 2; i++) {
        if (hash3(x, z, i, 53) < 0.6) continue;
        const tx = x + (hash3(x, z, i, 51) - 0.5) * CELL * 0.7;
        const tz = z + (hash3(x, z, i, 52) - 0.5) * CELL * 0.7;
        decor.push({ kind: 'tree', x: tx, y: y + h - 0.6, z: tz, scale: 0.6 + hash3(x, z, i, 54) * 0.5 });
      }
      break;
    }
  }
  void lights;
}
