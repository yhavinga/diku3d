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
import { OVERLAY_LAYER } from './render.js';

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

/**
 * FOREST plus ROOM_INDOORS is the mud saying "no sky", not "inside a building".
 * Haon Dor's deep, dark forest is under the canopy -- "the crowns of the trees
 * must be very dense, as they leave the forest floor in utter darkness" -- and
 * 44 of the default world's 68 forest rooms carry the flag. Built as interiors
 * they came out as stone boxes with a ceiling and a roof standing in a wood.
 *
 * `isOutdoor` still answers no for them, and that is the right answer: it is
 * what keeps the rain and the open-air ambience off under a canopy. What
 * changes is only the geometry, so the two questions are now separate.
 */
// The sector says forest, but six of Haon Dor's INDOORS rooms are named
// caves, an underground hallway, a temple, the inside of a tree -- real
// interiors that happen to sit in a forest area. The name wins over the
// sector code, the same move readFittings and the park already make.
const CANOPY_NOT = /\b(cave|underground|temple|hall|inside|web|tunnel)\b/i;
const isCanopy = (room) => room.sector === SECTOR.FOREST && !isOutdoor(room)
  && !CANOPY_NOT.test(room.name);

/** No walls, no ceiling, no roof -- whatever the mud says about the sky. */
const isOpenAir = (room) => isOutdoor(room) || isCanopy(room);

/** One definition, because the alley between two of them needs the same answer. */
const isWater = (room) => room.sector === SECTOR.WATER_SWIM || room.sector === SECTOR.WATER_NOSWIM;

/**
 * A bog, by what the room says it is rather than by its sector code.
 *
 * The Old Marsh's sectors are a lie and the mud is quite open about it: "An
 * Oozing Bog" and "Murky Bog" are MOUNTAIN, so they came out as bare rock with
 * eleven-metre cliffs in every cell beside them, while "Gloomy Path Through the
 * Marsh" is WATER_SWIM and came out as open river. The prose is truthful where
 * the sector is not, which is the same asymmetry `SQUARE` and `CANOPY_NOT`
 * already trade on -- so the name and the description decide.
 *
 * Two guards, both measured over the 45 stock areas. `BOG_NOT` on the *name* is
 * what separates a room that is a bog from one that can see one: "On a hill",
 * "Beach" and Haon Dor's "path on the river bank" all mention the marsh next
 * door and none of them is one. And a name that says bog outright wins anyway,
 * so "Swamp's Edge" is still a swamp. Over the default five areas that is 10
 * rooms, all in the marsh, and none at all in Midgaard, the Shire, Haon Dor or
 * the Troll Den; over all 45 it adds only Mahn-Tor's swampy paths, which are
 * swampy paths. `pond` and `murky` were tried in the vocabulary and dropped --
 * they take Midgaard's park pond and the two park paths beside it.
 */
const BOG = /\b(bogs?|marsh(?:es|y)?|swamps?|swampy|mire|fen|quagmire|quick ?sand|morass|oozing|peat)\b/i;
const BOG_NOT = /\b(hills?|beach|shore|lake|river|cliff|bridge|gates?|keep|tower|road|street|inn|house)\b/i;
const isBog = (room) => isOpenAir(room) && room.sector !== SECTOR.CITY
  && BOG.test(`${room.name} ${room.description}`)
  && (BOG.test(room.name) || !BOG_NOT.test(room.name));

// ------------------------------------------------------------- the Shire ----

/**
 * The Shire is the one area in the stock world that is not built at Midgaard's
 * scale, and it has to be keyed by area rather than by prose because that is
 * what it is: a village of a different people. Measured before any of this,
 * standing on Bywater Road at #1120: eaves 6.2-10.8 m (median 6.8) over a
 * 1.72 m figure, three storeys of half-timbering, indistinguishable from
 * Midgaard's Main Street.
 *
 * Everything *inside* the area is still chosen from the mud's own words, the
 * way `pickMaterials` and `readFittings` already choose. The prose is a
 * construction drawing: "a smial, a hole in the ground which serves as the
 * proper dwelling place for halflings"; a halfling hole is "rather crudely
 * built... musty and damp"; a dark tunnel's "ceiling is so low that you must
 * crouch"; and in the pig pen "you feel your boots sinking into the mud".
 */
const isShire = (room) => room.areaFile === 'shire.are';
/** Dug into a hillside: the hobbits' own word for one, plus the famous one. */
const SMIAL = /\b(smial|bag ?end|halfling hole)\b/i;
/** Earth rather than masonry -- the burrow network and the holes off it. */
const BURROW = /\b(smial|bag ?end|halfling hole|tunnel|intersection)\b/i;
/** A yard with animals in it is not a terrace of shops. */
const FARMYARD = /\b(pig ?pen|barn|chicken coop|stable|byre|sty)\b/i;

/** How high a Shire bank stands: a garden wall, not a storey. */
const BANK_LO = 2.9;
const BANK_HI = 3.7;
/** The cutting in a bank that a front door sits at the back of. */
const BANK_GAP = 3.4;
/**
 * The tile a turf bank wears, against the 5.5 m the `grass` recipe uses on the
 * ground.
 *
 * The ground is nearly always seen at a grazing angle, which compresses the
 * pattern into a fine dense turf; a bank is seen face on, and at the ground
 * tile the same recipe came out as metre-wide blobs -- topiary, not grass.
 * Going the other way was worse and worth recording: at a 14 m tile the blobs
 * are 2.5 m across and the banks read as camouflage netting. So finer, until
 * the grain on a bank face matches the grain the field has at a distance.
 */
const TURF_UV = 1 / 2.6;

/**
 * A hobbit's own front door. The world's standard opening is 3.2 x 3.1 m and
 * everything here is built at about that 1.8x, so 2.2 m is the same fraction
 * of a halfling's door that 3.1 m is of a man's -- clearly smaller from the
 * street, and still a door and not a hatch.
 */
const ROUND_DOOR = 2.2;

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

/**
 * Half an ellipsoid sitting on its own base plane: a turf bank, a barrow, the
 * hill a smial is dug into. No bottom cap, because it never leaves the ground
 * it is standing on -- and an open shell seen from underneath is a hole, so
 * nothing may hang one of these in the air.
 */
// Not cached the way `box` and `plane` are: every one of these is a different
// size, so a cache would only ever grow. `Batcher.add` clones what it is given,
// so the caller disposes -- same as `buildBogPool` does with its discs.
function mound(w, h, d, seg = 20) {
  const geo = new THREE.SphereGeometry(0.5, seg, Math.max(3, Math.round(seg / 2)), 0, Math.PI * 2, 0, Math.PI / 2);
  geo.scale(w, h * 2, d);
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
  // `tomb` alongside `crypt`: the graveyard's thirteen tombs were reading as
  // ordinary rooms and coming out in plaster and floorboards.
  let cave = /moria|sewer|catacomb|cavern|mine|tunnel|crypt|tomb|grotto|den|dungeon/.test(name);
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
  // After the switch, because the sector is the thing being overruled -- and
  // inside this function rather than at the call site the way the park does it,
  // because a passage routed between two bog rooms asks here for its surface
  // and the ground between two bogs is bog.
  if (isBog(room)) floor = 'peat';

  // The Shire is dug, not built. Same move as the bog and the park: the room's
  // own words overrule the sector, and they do it here rather than at the call
  // site because the lane routed out of a pig pen asks this function what the
  // ground between them is made of, and it is mud.
  let smial = false;
  let burrow = false;
  let wallUv;                   // undefined -> the material's own tile
  if (isShire(room)) {
    burrow = BURROW.test(room.name);
    if (burrow) {
      // Trodden earth, all of it, because a burrow is dug out of one substance.
      // Not the bare rock the `tunnel` branch above hands out: these are cut
      // through a hillside, not mined. `dirt` and not `peat` on the walls --
      // peat is the darkest surface in the world and a torch-lit room made of
      // it measured 14% of the frame under luminance 4; and `dirt` carries the
      // damp in its low patches that the prose asks for ("the air is musty and
      // damp"). Peat stays overhead, where nothing lights it anyway.
      smial = SMIAL.test(room.name);
      cave = true;              // whatever else, no dressed-masonry kit in a hole
      floor = 'dirt'; wallIn = 'dirt'; wallOut = 'dirt'; ceil = 'peat'; roof = 'grass';
      // A smial's outside is the hill, so its outer skin is turf and not the
      // earth face it is cut from: `dirt` carries a `wet` term, and shaded by
      // `wallAo` a six-metre wall of it read as wet black cobble under a green
      // cap -- a building with a dome, which is the opposite of the point. In
      // grass, wall and dome are one green mass with a doorway in it. The tile
      // has to come with it or the wall wears the ground's 5.5 m grass.
      if (smial) { wallOut = 'grass'; wallUv = TURF_UV; }
    } else if (cave) {
      // "Gamgee Resi*den*ce" is not a den. The cave test above is a substring
      // match, so a farmer's cottage came out in bare rock with a rock ceiling;
      // nothing in the Shire is a cavern.
      cave = false;
      floor = 'planks'; wallIn = 'plaster'; wallOut = 'timber'; ceil = 'planks';
    }
    // "You feel your boots sinking into the mud." A coop's floor is the same.
    if (/\b(pig ?pen|chicken coop|sty)\b/i.test(room.name)) floor = 'dirt';
  }

  if (!holy && !cave && !wood && hash3(room.vnum, 0, 0, 9) > 0.6) wallOut = 'timber';
  if (!holy && !burrow && hash3(room.vnum, 1, 0, 3) > 0.84) roof = 'thatch';
  return { floor, wallIn, wallOut, roof, ceil, holy, cave, smial, wallUv };
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
  const mistCells = [];   // cell centres the ground mist lies over

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
  // ...and something for it to end against, out where the fog is thick enough
  // to do the work.
  buildHorizon(group, bounds, groundY);

  // --- rooms ---------------------------------------------------------------

  for (const cell of layout.order) {
    const room = cell.room;
    const pos = worldOf(cell);
    const chunk = chunkOf(cell);
    const outdoor = isOutdoor(room);
    // What the room record carries is the mud's answer, because rain and
    // ambience read it. What the geometry below asks is whether there are walls.
    const canopy = isCanopy(room);
    const bog = isBog(room);
    const openAir = outdoor || canopy;
    const airborne = room.sector === SECTOR.AIR;
    const mats = pickMaterials(room, room.area);
    // A park takes grass rather than the cobbles its CITY sector would hand it.
    // Here and not inside `pickMaterials`, because an alley routed out of a
    // park room asks that same function for its surface -- and the paving
    // between two park cells is the path the mud says runs through them.
    if (isPark(room)) mats.floor = 'grass';
    const sides = layout.sides.get(cell.vnum);
    const roomHoles = holes.get(cell.vnum) || [];

    // A modelled room kit, where one fits. Caves keep their procedural rock --
    // the kits are dressed masonry and would look absurd in Moria.
    const kit = (!openAir && !mats.cave && instances)
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

    // A doorway has nothing under it, and underground you can see that.
    //
    // An indoor room's floor stops at its own wall line (ROOM/2 = 5 m) and the
    // passage routed away from it starts at the next cell boundary (HALF =
    // 6.5 m), so every doorway spans 1.5 m of no floor -- and outside the
    // doorway a 0.8 m strip runs the length of every wall. Above ground the
    // world's own ground plane lies 0.47 m below and fills it, which is why
    // nobody has ever seen it. Underground there is nothing below at all:
    // standing in a Shire tunnel you were looking at daylight sky through the
    // floor, and it read as a bar of blown white across the opening -- 0.164%
    // of the frame, and the hide-things sweep named the culprit as the sky
    // itself, not any mesh. Paving these rooms to their cell edge closes both.
    //
    // The gap is world-wide -- it lives in the `half` below, and Moria and the
    // sewers have it too -- so this is keyed to the Shire's own burrows rather
    // than changed for every area, and the general case is written up instead.
    const buried = !openAir && mats.cave && isShire(room) && cell.level < 0;
    const half = airborne ? ROOM / 2 : (openAir || buried ? HALF : ROOM / 2);
    buildFloor({
      batcher, chunk, material: mats.floor, x: pos.x, y: pos.y, z: pos.z,
      half, holes: roomHoles.filter((h) => !h.ceiling), addPlatform, slab: !airborne,
      shade: !openAir,
    });

    // Six of the marsh's rooms are sectored as open water and only two of them
    // are: "Gloomy Path Through the Marsh" is WATER_SWIM, and a path is not
    // thirteen metres of river. A bog takes pools instead.
    if (isWater(room) && !bog) {
      decor.push({ kind: 'water', x: pos.x, y: pos.y + 0.7, z: pos.z, size: half * 2 });
    }
    let pools = null;
    if (bog) {
      mistCells.push(pos);
      pools = buildBogPool({ batcher, chunk, room, pos, sides });
    }

    for (let dir = 0; dir < 4; dir++) {
      const side = sides[dir];
      const [dx, , dz] = DIR_STEP[dir];
      const rotY = (dir === 1 || dir === 3) ? Math.PI / 2 : 0;
      const open = side && (side.kind === 'alley' || side.kind === 'portal');
      const distance = openAir ? HALF : ROOM / 2;
      const wx = pos.x + dx * distance;
      const wz = pos.z + dz * distance;

      if (!openAir) {
        buildIndoorWall({
          batcher, chunk, mats, x: wx, y: pos.y, z: wz, rotY, open, kit, instances,
          width: ROOM + (WALL_IN + WALL_OUT) * 2, addCollider, dir, room, lights, decor,
          cellX: pos.x, cellZ: pos.z,
        });
      } else if (!airborne) {
        // Nothing walls a room under the canopy: `buildForest` stands a picket
        // of trees along every side there is no way out of, and a rock kerb
        // behind that is the level editor showing through.
        if (!canopy) buildOutdoorEdge({ batcher, chunk, room, pos, dir, open, addCollider, bog });
        // Once, for the whole cell -- the corners need to know about all four
        // sides, not one at a time.
        if (dir === 3) {
          buildCityFrontage({
            batcher, instances, model, chunk, room, cell, pos, sides, addCollider, decor, doors,
          });
        }
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
          x: wx + dx * (openAir ? -0.3 : (WALL_IN + WALL_OUT) / 2), y: pos.y,
          z: wz + dz * (openAir ? -0.3 : (WALL_IN + WALL_OUT) / 2), rotY, dir,
          width: DOOR_W, height: DOOR_H,
          // One round leaf covering the whole opening instead of two boarded
          // halves. The opening stays 3.2 x 3.1 -- square to within 3%, which
          // is close enough for a circle and leaves the lintel, the collider
          // and the player's clearance exactly as they were.
          round: isShire(room),
          closed: !!(side.exit.locks & EX_CLOSED),
          locked: !!(side.exit.locks & EX_LOCKED),
          keyword: side.exit.keyword || 'door',
          room: room.vnum,
        });
      }
    }

    // One per cell, after the sides, not one per side: which way out a street
    // happens to have says nothing about where its lamp stands.
    if (openAir) buildStreetLamp({ room, cell, pos, decor, lights, addCollider });

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

    if (!openAir) {
      buildCeiling({
        batcher, chunk, material: mats.ceil, x: pos.x, y: pos.y + CEIL, z: pos.z,
        half: ROOM / 2 + WALL_IN, holes: roomHoles.filter((h) => h.ceiling),
      });
      if (kit === null) buildRoof({ batcher, chunk, mats, room, x: pos.x, y: pos.y + CEIL + SLAB, z: pos.z, decor });
      // A burrow under the ground has no outside to put a window in. The Shire's
      // tunnels and its lower halfling holes were getting casements with lit
      // panes and sills, and the sills -- pale timber right beside a wall torch
      // -- came out as two glowing white bars across a room the mud calls
      // "darkness". The smials on Bywater Road are at street level and keep
      // theirs, which is the whole difference.
      if (!(mats.cave && isShire(room) && cell.level < 0)) {
        decor.push({
          kind: 'windows', x: pos.x, y: pos.y, z: pos.z,
          w: SHELL * 2, d: SHELL * 2, h: CEIL + 1.1, seed: hash3(room.vnum, 2, 0, 11), doorSides: sides,
        });
      }
      buildInteriorProps({ room, pos, sides, decor, mats });
      if (isShop(room)) buildShopSign({ room, pos, sides, instances, model, chunk });
    } else {
      // Bog first: half the marsh's bog rooms are sectored FOREST or MOUNTAIN,
      // and a stand of firs is not what grows in standing water.
      if (bog) buildBogFlora({ room, pos, sides, pools, instances, model, chunk });
      else if (isPark(room)) buildPark({ room, cell, pos, sides, instances, model, chunk, decor, addCollider });
      else if (room.sector === SECTOR.FOREST) {
        buildForest({ room, pos, sides, instances, model, chunk, decor, addCollider, dense: canopy });
      }
      // Out of doors the same thing, against the sides with no way out of
      // them, so a square reads as somewhere people keep their things rather
      // than as swept paving.
      const blank = [];
      for (let d = 0; d < 4; d++) if (!sides[d]) blank.push(d);
      // Nobody stacks barrels in a bog. This clutter is street furniture and it
      // reaches every open-air room, which is how a trough came to stand in the
      // marsh; the reeds below are what a bog keeps against its edges instead.
      const farm = farmProps(room);
      // The farmyard always dresses: an empty pig pen is a cobbled square with
      // pigs on it, and the trough is half of what makes it a pen.
      if (!bog && blank.length && (farm || hash3(room.vnum, 13, 0, 6) > 0.28)) {
        decor.push({
          // Against the new facade, not inside it.
          kind: 'clutter', x: pos.x, y: pos.y, z: pos.z,
          half: wantsFrontage(room) ? HALF - FRONTAGE_D : HALF,
          walls: blank, seed: hash3(room.vnum, 12, 0, 5), indoor: false,
          props: farm,
        });
      }
    }

    // upper floors need something underneath them
    if (cell.level > 0 && layout.at(cell.level - 1, cell.x, cell.z) === undefined && !airborne) {
      const h = LEVEL_H;
      const s = openAir ? HALF : SHELL;
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
    buildAlley({ batcher, link, worldOf, chunkOf, addCollider, addPlatform, lights, decor, mistCells });
  }

  for (const plan of stairPlans) {
    buildStair({
      batcher, plan, worldOf, chunkOf, addCollider, addPlatform,
      materials: pickMaterials(plan.lower.room, plan.lower.room.area),
    });
  }

  // --- build on every empty cell that fronts a street ----------------------

  const frontage = new Map(); // cell key -> sector to build from
  const consider = (level, x, z, sector, bog, shire) => {
    if (layout.at(level, x, z) !== undefined || layout.isPath(level, x, z)) return;
    const k = `${level}:${x},${z}`;
    if (!frontage.has(k)) frontage.set(k, { level, x, z, sector, bog, shire });
  };
  for (const cell of layout.order) {
    if (!isOpenAir(cell.room) || cell.room.sector === SECTOR.AIR) continue;
    for (let dir = 0; dir < 4; dir++) {
      const [dx, , dz] = DIR_STEP[dir];
      consider(cell.level, cell.x + dx, cell.z + dz, cell.room.sector, isBog(cell.room), isShire(cell.room));
    }
  }
  for (const link of layout.links) {
    if (link.kind !== 'alley' || alleyEnclosed(link)) continue;
    // Same reason as above: no frontage along a passage that does not exist.
    if (rooms.get(link.from.vnum)?.unbuilt || rooms.get(link.to.vnum)?.unbuilt) continue;
    const source = isOpenAir(link.from.room) ? link.from.room : link.to.room;
    for (const c of link.path) {
      for (let dir = 0; dir < 4; dir++) {
        const [dx, , dz] = DIR_STEP[dir];
        consider(link.from.level, c.x + dx, c.z + dz, source.sector, isBog(source), isShire(source));
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
    const pos = { x: spot.x * CELL, y: spot.level * LEVEL_H, z: spot.z * CELL };
    if (spot.bog) mistCells.push(pos);
    buildFiller({
      batcher, instances, model, faceRot: faces < 0 ? null : FACE_ROT[faces],
      chunk: `${spot.level}:${Math.floor(spot.x / 4)},${Math.floor(spot.z / 4)}`,
      sector: spot.sector, bog: spot.bog, shire: spot.shire, x: pos.x, y: pos.y, z: pos.z,
      seed: hash3(spot.x, spot.z, spot.level, 17), addCollider, lights, decor,
    });
  }

  const mist = buildMist(group, mistCells);

  const stats = batcher.finish(group);
  if (instances) {
    const placed = instances.finish(group);
    stats.meshes += placed.meshes;
    stats.triangles += placed.triangles;
    stats.instanced = placed.triangles;
  }
  return { group, colliders, platforms, lights, portals, doors, rooms, decor, mist, stats };
}

// A passage is a corridor only when there is a building at both ends of it. The
// trail between two rooms under the canopy is a trail: walls and a ceiling slab
// on it is the masonry tunnel Haon Dor was reported as.
const alleyEnclosed = (link) => !isOpenAir(link.from.room) && !isOpenAir(link.to.room);

// ---------------------------------------------------------------- pieces ----

function buildFloor({ batcher, chunk, material, x, y, z, half, holes, addPlatform, slab = true, shade = true }) {
  const emit = (cx, cz, w, d) => {
    batcher.add(plane(w, d, Math.max(2, Math.round(w / 2))), material, place(cx, y, cz), {
      // Darkening the perimeter is right in a room, where there is a wall all
      // the way round it. Out of doors there is not, and the cell next door --
      // a routed street, or a cell built on -- is painted flat, so the two meet
      // at 0.55 against 1.0 and the join is a razor-straight rectangle on the
      // ground, parallel to the world axes. That is the level editor showing
      // through, and GTAO does the job properly anyway.
      chunk, ao: (slab && shade) ? floorAo(x, z, half, half) : null,
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
    // `uv` is undefined for every room but a smial, and undefined falls through
    // to the material's own tile inside `Batcher.add`.
    { name: mats.wallOut, t: WALL_OUT, offset: WALL_IN + WALL_OUT / 2, height: eave, uv: mats.wallUv },
  ])) {
    const sx = x + dx * skin.offset;
    const sz = z + dz * skin.offset;
    if (!gap) {
      batcher.add(box(width, skin.height, skin.t, 3, 4, 1), skin.name,
        place(sx, y + skin.height / 2, sz, rotY), { chunk, ao: wallAo(y), uvScale: skin.uv });
      continue;
    }
    const sideW = (width - gap) / 2;
    for (const s of [-1, 1]) {
      const offset = s * (gap + sideW) / 2;
      batcher.add(box(sideW, skin.height, skin.t, 2, 4, 1), skin.name,
        place(sx + (along ? 0 : offset), y + skin.height / 2, sz + (along ? offset : 0), rotY),
        { chunk, ao: wallAo(y), uvScale: skin.uv });
    }
    const lintel = skin.height - DOOR_H;
    if (lintel > 0.05) {
      batcher.add(box(gap, lintel, skin.t, 2, 1, 1), skin.name,
        place(sx, y + DOOR_H + lintel / 2, sz, rotY), { chunk, ao: () => 0.72, uvScale: skin.uv });
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

/**
 * How much of an open-air city cell is street rather than building.
 *
 * A cell is thirteen metres across and an open-air room used to pave every
 * metre of it, so a room, a routed street and another room came to thirty-nine
 * metres of uninterrupted ground -- measured by raycast, and the widest lane in
 * Rothenburg is about twelve. Nothing was ever in shadow because nothing was
 * near enough to shade anything: switching off every shadow in the town changed
 * a noon frame by a third of a percent.
 *
 * The fix is not to move rooms, which the layout cannot afford. It is to stop
 * treating a whole cell as street. A lane wants a corridor; the rest of the
 * cell is where the buildings behind it come forward to meet the road.
 */
const FRONTAGE_D = 3.2;

/** Rooms the mud itself calls open ground. Six metres is not a market square. */
const SQUARE = /\b(square|plaza|piazza|courtyard|market|green|common|park|field|yard)\b/i;

// A pig pen is sectored CITY like every other Shire lane, and a terrace of
// shop fronts brought forward around a sty is not what the mud describes. It
// gets a rail fence off `buildOutdoorEdge` instead, the way any other
// unfronted open-air room gets its boundary.
const wantsFrontage = (room) => room.sector === SECTOR.CITY && !SQUARE.test(room.name)
  && !(isShire(room) && FARMYARD.test(room.name));

/**
 * Bring the frontage forward on every side of a city cell that is not a way
 * out, and build the corners between two ways out as well. Four exits leaves a
 * crossroads with a block on each corner; two opposite exits leaves a lane
 * between two terraces. Either way the facades finish 6.6 m apart, which is
 * inside the 5-9 m a real town street runs to, and the buildings now touch
 * their neighbours in the cells behind instead of standing free on paving.
 */
function buildCityFrontage({ batcher, instances, model, chunk, room, cell, pos, sides, addCollider, decor, doors }) {
  if (!wantsFrontage(room)) return;
  const isOpen = (d) => {
    const side = sides[d];
    return !!(side && (side.kind === 'alley' || side.kind === 'portal' || side.kind === 'gate'));
  };
  const inset = HALF - FRONTAGE_D / 2;
  const shire = isShire(room);

  const block = (bx, bz, sx, sz, salt) => {
    const seed = hash3(cell.x * 7 + Math.round(bx), cell.z * 7 + Math.round(bz), cell.level, salt);
    const h = 6.2 + seed * 4.6;
    const stone = hash3(Math.round(bx), Math.round(bz), cell.level, 61) > 0.45;
    batcher.add(box(sx, h, sz, 3, 4, 3), stone ? 'stonewall' : 'timber',
      place(bx, pos.y + h / 2, bz), { chunk, ao: wallAo(pos.y) });
    const roofH = 1.7 + seed * 1.4;
    batcher.add(triPrism(sx + 0.7, roofH, sz + 0.7), seed > 0.86 ? 'thatch' : 'rooftile',
      place(bx, pos.y + h, bz, sx > sz ? Math.PI / 2 : 0), { chunk });
    addCollider(bx - sx / 2, bx + sx / 2, bz - sz / 2, bz + sz / 2, pos.y, pos.y + h);
    // A blank three-storey wall along the street was reported; give it openings.
    decor.push({ kind: 'windows', x: bx, y: pos.y, z: bz, w: sx, d: sz, h, seed });
  };

  /**
   * A Shire cottage: the same block, at the height a cottage is.
   *
   * The ridge is worked out here rather than borrowed from `block` because
   * `triPrism` puts its cross-section on local X and its ridge on local Z, and
   * a quarter turn maps local Z to world X -- so under rotation the *width*
   * argument has to become the short side, not stay the long one.
   */
  const cottage = (bx, bz, sx, sz, salt) => {
    const seed = hash3(cell.x * 7 + Math.round(bx), cell.z * 7 + Math.round(bz), cell.level, salt);
    const h = 2.9 + seed * 0.8;
    batcher.add(box(sx, h, sz, 3, 2, 3), seed > 0.5 ? 'plaster' : 'timber',
      place(bx, pos.y + h / 2, bz), { chunk, ao: wallAo(pos.y) });
    const roofH = 2.2 + seed * 1.3;
    const wide = sx > sz;
    batcher.add(triPrism((wide ? sz : sx) + 0.8, roofH, (wide ? sx : sz) + 0.8),
      seed > 0.38 ? 'thatch' : 'rooftile',
      place(bx, pos.y + h, bz, wide ? Math.PI / 2 : 0), { chunk });
    addCollider(bx - sx / 2, bx + sx / 2, bz - sz / 2, bz + sz / 2, pos.y, pos.y + h);
    decor.push({ kind: 'windows', x: bx, y: pos.y, z: bz, w: sx, d: sz, h, seed });
    if (hash3(Math.round(bx), Math.round(bz), cell.level, 71) > 0.5) {
      decor.push({ kind: 'smoke', x: bx, y: pos.y + h + roofH, z: bz });
    }
  };

  /**
   * A turf bank with a hobbit hole cut into it: the Shire's answer to a shop
   * front.
   *
   * Nothing is subtracted anywhere, because there is no CSG here. The bank is
   * built as two lengths with a gap between them, and the gap *is* the cutting
   * -- a 3.4 m recess with a stone face at the back of it, a round door in the
   * face, and a turf gable carried over the opening so the door reads as being
   * in a bank rather than between two of them. The recess keeps the room's own
   * paving and no collider, so you can walk in and stand at the door.
   *
   * The gable is a prism and not another half-ellipsoid on purpose: a
   * hemisphere has no bottom cap, and one hung in the air is an open shell that
   * reads as a hole in the turf from below.
   */
  const bank = (dir) => {
    const [dx, , dz] = DIR_STEP[dir];
    const along = dir === 1 || dir === 3;    // the bank runs along z
    const seed = hash3(cell.x, cell.z, dir, 64);
    const h = BANK_LO + seed * (BANK_HI - BANK_LO);
    // Local frame: `a` runs along the street, `o` outwards from the room centre.
    const at = (a, o) => (along
      ? { x: pos.x + dx * o, z: pos.z + a }
      : { x: pos.x + a, z: pos.z + dz * o });
    // ...and the same swap for extents: [world x, world z].
    const span = (a, o) => (along ? [o, a] : [a, o]);
    // A metre deeper than the block it stands on. An ellipsoid's tangent is
    // vertical at its rim, so at the 1.6 m half-depth of a bare frontage block
    // a 3 m bank meets the paving at very nearly a right angle and reads as a
    // green wall; 2.1 m takes the aspect from 2:1 to 1.5:1 and the toe lies
    // down. The overhang is unreachable either way -- measured over the Shire,
    // no closed side of a frontage cell has a routed passage behind it, so the
    // cell it leans into is always one that has been built on.
    const depth = FRONTAGE_D + 1.0;
    const turf = (a, len) => {
      const c = at(a, inset);
      const [sx, sz] = span(len, depth);
      const geo = mound(sx, h, sz);
      batcher.add(geo, 'grass', place(c.x, pos.y, c.z), { chunk, uvScale: TURF_UV });
      geo.dispose();
      addCollider(c.x - sx / 2, c.x + sx / 2, c.z - sz / 2, c.z + sz / 2, pos.y, pos.y + h);
    };
    const chimney = (a) => {
      if (hash3(cell.x, cell.z, dir, 68) < 0.45) return;
      const c = at(a, inset);
      batcher.add(box(0.85, 1.9, 0.85), 'stonewall', place(c.x, pos.y + h + 0.25, c.z), { chunk });
      decor.push({ kind: 'smoke', x: c.x, y: pos.y + h + 1.2, z: c.z });
    };

    if (hash3(cell.x, cell.z, dir, 65) >= 0.8) {
      // A plain bank: a green shoulder to the lane, and the neighbour's
      // chimney standing out of it.
      turf(0, CELL + 0.6);
      chimney((hash3(cell.x, cell.z, dir, 69) - 0.5) * 6);
      return;
    }

    // Two lengths of bank, overlapping the neighbouring cells a little so the
    // banks along a street join up instead of ending at every cell boundary.
    const wingLen = HALF + 0.3 - BANK_GAP / 2;
    const wingAt = BANK_GAP / 2 + wingLen / 2;
    for (const s of [-1, 1]) turf(s * wingAt, wingLen);
    chimney(wingAt * (hash3(cell.x, cell.z, dir, 69) > 0.5 ? 1 : -1));

    // The face at the back of the cutting, flush with the cell boundary.
    const faceT = 0.6;
    const faceH = ROUND_DOOR + 0.55;
    const fc = at(0, HALF - faceT / 2);
    const [fx, fz] = span(BANK_GAP, faceT);
    batcher.add(box(fx, faceH, fz, 2, 2, 1), 'stonewall',
      place(fc.x, pos.y + faceH / 2, fc.z), { chunk, ao: wallAo(pos.y) });
    addCollider(fc.x - fx / 2, fc.x + fx / 2, fc.z - fz / 2, fc.z + fz / 2, pos.y, pos.y + faceH);

    // A brow of turf over the door, carried on the face and not on the air.
    // Spanning the whole cutting it was a 3.7 m green awning hanging over an
    // open recess, which from underneath is exactly what it looked like -- and
    // a cutting is meant to be open to the sky anyway. 1.6 m deep, sitting on
    // the face and oversailing the door by 0.7 m, is a hood.
    const capH = Math.max(0.6, h - faceH + 0.55);
    const cap = at(0, HALF - faceT / 2 - 0.2);
    batcher.add(triPrism(faceT + 1.0, capH, BANK_GAP + 0.6), 'grass',
      place(cap.x, pos.y + faceH, cap.z, along ? 0 : Math.PI / 2), { chunk, uvScale: TURF_UV });

    // The door itself. Nothing leads through it -- the bank behind is solid --
    // so it is scenery with a hinge, and shut is the only way you ever see the
    // whole circle. `room: -1` keeps it out of main.js's "is a door in the way"
    // lookup, which matches on room and direction.
    const dc = at(0, HALF - faceT - 0.08);
    doors.push({
      x: dc.x, y: pos.y, z: dc.z,
      // FACE_ROT turns a model's -z towards a direction, so it turns the
      // leaf's +z -- its ironwork, its knob -- back towards the street.
      rotY: FACE_ROT[dir], dir: -1, room: -1,
      width: ROUND_DOOR, height: ROUND_DOOR,
      round: true, scenery: true, closed: true, locked: false, keyword: 'round door',
    });

    if (!instances) return;
    const pot = model(['herb_pots', 'nettles', 'bush'], hash3(cell.x, cell.z, dir, 66));
    if (!pot) return;
    for (const s of [-1, 1]) {
      const p = at(s * (BANK_GAP / 2 - 0.6), HALF - faceT - 0.7);
      instances.add(pot, {
        x: p.x, y: pos.y, z: p.z, rotY: hash3(cell.x, cell.z, dir * 2 + s, 67) * Math.PI * 2,
      }, chunk);
    }
  };

  /** The corner between two ways out: a knoll, not a block. */
  const knoll = (bx, bz, salt) => {
    const seed = hash3(cell.x * 7 + Math.round(bx), cell.z * 7 + Math.round(bz), cell.level, salt);
    const h = BANK_LO + seed * (BANK_HI - BANK_LO);
    const geo = mound(FRONTAGE_D + 0.7, h, FRONTAGE_D + 0.7);
    batcher.add(geo, 'grass', place(bx, pos.y, bz), { chunk, uvScale: TURF_UV });
    geo.dispose();
    addCollider(bx - FRONTAGE_D / 2, bx + FRONTAGE_D / 2, bz - FRONTAGE_D / 2, bz + FRONTAGE_D / 2, pos.y, pos.y + h);
  };

  for (let dir = 0; dir < 4; dir++) {
    if (isOpen(dir)) continue;
    const [dx, , dz] = DIR_STEP[dir];
    const along = dir === 1 || dir === 3;
    const bx = pos.x + dx * inset;
    const bz = pos.z + dz * inset;
    const sx = along ? FRONTAGE_D : CELL;
    const sz = along ? CELL : FRONTAGE_D;
    if (!shire) { block(bx, bz, sx, sz, 62 + dir); continue; }
    // Mostly bank, a cottage now and then -- a village of holes with a few
    // houses in it, which is what the Shire is.
    if (hash3(cell.x, cell.z, dir, 60) < 0.76) bank(dir);
    else cottage(bx, bz, sx, sz, 62 + dir);
  }
  // Corners, only where both of their sides are a way out -- otherwise the
  // full-width block on the closed side already covers them.
  for (const [dirA, dirB, sx, sz] of [[0, 1, 1, -1], [1, 2, 1, 1], [2, 3, -1, 1], [3, 0, -1, -1]]) {
    if (!isOpen(dirA) || !isOpen(dirB)) continue;
    const bx = pos.x + sx * inset;
    const bz = pos.z + sz * inset;
    if (shire) knoll(bx, bz, 70 + dirA);
    else block(bx, bz, FRONTAGE_D, FRONTAGE_D, 70 + dirA);
  }
}

/**
 * A street lamp, one to a city room.
 *
 * It used to be one per *north* side and then only half the time: 34 lamps in
 * the whole loaded world against 956 torch candidates, 12 of them in Midgaard,
 * and none within 33 m of the Temple Square -- whose four sides are all open,
 * so it failed the test on a coin flip. A judge standing there after dark found
 * the nearest light of any kind 28 m off and a window at that. These are the
 * only light the town has once the sun is down, so a street with none is
 * unlit, and the side an exit landed on has nothing to do with it. One per room
 * is a lamp every 26 m along a street -- rooms sit two 13 m cells apart -- which
 * is about the spacing a gas-lit town ran to, and it takes the loaded world to
 * 105 lamps, Midgaard to 48.
 */
function buildStreetLamp({ room, cell, pos, decor, lights, addCollider }) {
  if (room.sector !== SECTOR.CITY) return;
  const sx = hash3(cell.x, cell.z, 1, 6) > 0.5 ? 1 : -1;
  const sz = hash3(cell.x, cell.z, 2, 7) > 0.5 ? 1 : -1;
  // Against the kerb, not out in the road: with frontage brought forward the
  // corridor is only 6.6 m and the old offset stood the post inside a wall.
  const reach = wantsFrontage(room) ? HALF - FRONTAGE_D - 0.7 : HALF - 1.3;
  const lx = pos.x + reach * sx;
  const lz = pos.z + reach * sz;
  decor.push({ kind: 'lamp', x: lx, y: pos.y, z: lz });
  // At the flame: actors.js puts the lantern at +4.3 and this was at +3.9, so
  // the light hung in the open air below its own housing. `outdoor` so the pool
  // can put it out at noon -- a street lamp burning in daylight was reported --
  // and so it takes the 2.6x lift after dark, which is why it carries far more
  // than a torch in a hall.
  lights.push({
    x: lx, y: pos.y + 4.3, z: lz, color: 0xffc182,
    intensity: 26, radius: 26, flicker: true, outdoor: true,
  });
  addCollider(lx - 0.3, lx + 0.3, lz - 0.3, lz + 0.3, pos.y, pos.y + 4.2);
}

/**
 * Which rooms are shops is in the world data, not in the prose: `#SHOPS` names
 * a keeper mob and the reset table drops that mob in a room, so a room whose
 * mobs include a keeper is the mud's own answer to the question.
 */
const isShop = (room) => !!room.mobs && room.mobs.some((mob) => mob.shop);

/** Head height and then some. Nobody walks into a shop sign. */
const SIGN_CLEAR = 2.6;

/**
 * The shop's sign, hung out over the street beside its door.
 *
 * `hanging_sign` is modelled for exactly this and nothing had ever placed it:
 * fixing plate flat on the wall at z = 0, ironwork reaching out along +z,
 * origin on the ground under the fixing. All it needs is the outside face of a
 * wall and the way out of it.
 *
 * That wall is the one the door is in, because that is the wall the street
 * sees, and the sign slides along it to clear the opening -- the same move
 * `buildInteriorProps` makes with a fitting whose wall has the door in it. A
 * shop with no way out to open air is buried inside something else and has no
 * street to hang anything over, so it gets none: that is the bars and back
 * rooms in Midgaard's temple block, which are reached through other rooms.
 */
function buildShopSign({ room, pos, sides, instances, model, chunk }) {
  if (!instances) return;
  // A missing model means no sign. Procedural ironwork and a painted board is
  // not worth inventing for something this small.
  const sign = model(['hanging_sign'], 0);
  if (!sign) return;

  const dir = [0, 1, 2, 3].find((d) => {
    const side = sides[d];
    return side && side.kind === 'alley' && !alleyEnclosed(side.link);
  });
  if (dir === undefined) return;

  const [dx, , dz] = DIR_STEP[dir];
  // Beside the doorway, not over it, and well short of the corner.
  const along = (hash3(room.vnum, 0, 0, 91) > 0.5 ? 1 : -1) * (DOOR_W / 2 + 1.4);
  // It already hangs clear of a head from an origin on the ground, but read
  // that off the model's own bounds rather than trusting it: a regenerated
  // sign that sits lower has to be lifted, not left hanging in the doorway.
  const bottom = instances.library.get(sign)?.bounds?.min.y ?? 0;
  instances.add(sign, {
    x: pos.x + dx * SHELL + (dx ? 0 : along),
    y: pos.y + Math.max(0, SIGN_CLEAR - bottom),
    z: pos.z + dz * SHELL + (dz ? 0 : along),
    // `FACE_ROT` turns a model's -z towards a direction; the arm reaches the
    // other way, so half a turn past that swings it out over the street.
    rotY: FACE_ROT[dir] + Math.PI,
  }, chunk);
}

/**
 * A park, planted.
 *
 * Midgaard's park is CITY sector like every other street, so it paved wall to
 * wall -- a review stood in the middle of one and reported a park with no tree,
 * grass or path in it. The mud names them itself, "Small path through the
 * park", "Park Entrance", and that name is the signal `pickMaterials` already
 * reads. A room that calls itself a *road* past the park is a road, which is
 * the distinction `readFittings` draws between a taproom and a room that merely
 * points at one. The path wants no geometry of its own: the alley routed
 * between two park cells keeps its cobbles, so the grass is joined up by paving.
 */
const PARK = /\bpark\b/i;
const PARK_IS_A_ROAD = /\b(road|street|avenue|lane)\b/i;
const isPark = (room) => isOutdoor(room) && PARK.test(room.name) && !PARK_IS_A_ROAD.test(room.name);

/** How much of a side you can walk out of stays empty. */
const PARK_CLEAR = 1.5;
const PARK_CORNER = 4.3;

/**
 * Nothing may stand in a doorway. A side with a way out of it keeps its last
 * `margin` metres clear; a side without one is a wall, and things grow against
 * a wall. Cell-local coordinates in, planted-or-not out.
 */
const edgeClear = (sides, margin) => (lx, lz) => {
  for (let d = 0; d < 4; d++) {
    if (!sides[d]) continue;
    const [dx, , dz] = DIR_STEP[d];
    if (HALF - (dx ? lx * dx : lz * dz) < margin) return false;
  }
  return true;
};

/**
 * A ring of small planting near the edges of a cell: instanced, and no collider
 * on any of it. These are knee- and ankle-high, and walking through a clump of
 * grass is not the wall a trunk is. `rand(i, k, salt)` is the caller's own
 * stream, because a room is keyed by vnum and a filler cell by its coordinates.
 */
function scatterUndergrowth({ instances, chunk, x, y, z, kinds, rand, clears = null }) {
  for (const kind of kinds) {
    if (!kind.name) continue;
    for (let i = 0; i < kind.count; i++) {
      const angle = ((i + rand(i, 0, kind.salt)) / kind.count) * Math.PI * 2;
      const radius = kind.ring + (rand(i, 1, kind.salt) - 0.5) * kind.spread;
      const lx = Math.cos(angle) * radius;
      const lz = Math.sin(angle) * radius;
      if (clears && !clears(lx, lz)) continue;
      instances.add(kind.name, {
        x: x + lx, y, z: z + lz,
        rotY: rand(i, 2, kind.salt) * Math.PI * 2,
        scale: kind.size * (0.8 + rand(i, 3, kind.salt) * 0.5),
      }, chunk);
    }
  }
}

function buildPark({ room, cell, pos, sides, instances, model, chunk, decor, addCollider }) {
  const clears = edgeClear(sides, PARK_CLEAR);

  // Trees go in the corners, because the ways out are on the axes and so is the
  // walk across -- and never at the centre, which is where the player arrives.
  // The corner the street lamp stands in is left alone (`buildStreetLamp` picks
  // it the same way) or a canopy swallows the only light in the room.
  const lampX = hash3(cell.x, cell.z, 1, 6) > 0.5 ? 1 : -1;
  const lampZ = hash3(cell.x, cell.z, 2, 7) > 0.5 ? 1 : -1;
  const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]]
    .filter(([sx, sz]) => !(sx === lampX && sz === lampZ));
  const first = Math.floor(hash3(room.vnum, 0, 0, 81) * corners.length);
  const trees = hash3(room.vnum, 1, 0, 82) > 0.45 ? 3 : 2;
  for (let i = 0; i < trees; i++) {
    const [sx, sz] = corners[(first + i) % corners.length];
    const lx = sx * (PARK_CORNER + (hash3(room.vnum, i, 0, 83) - 0.5) * 1.3);
    const lz = sz * (PARK_CORNER + (hash3(room.vnum, i, 1, 84) - 0.5) * 1.3);
    if (!clears(lx, lz)) continue;
    const tx = pos.x + lx;
    const tz = pos.z + lz;
    decor.push({ kind: 'tree', x: tx, y: pos.y, z: tz, scale: 0.72 + hash3(room.vnum, i, 2, 85) * 0.34 });
    // The same box a forest tree gets: a trunk is something you walk around.
    addCollider(tx - 0.7, tx + 0.7, tz - 0.7, tz + 0.7, pos.y, pos.y + 8);
  }

  // Undergrowth around the edges.
  if (!instances) return;
  scatterUndergrowth({
    instances, chunk, x: pos.x, y: pos.y, z: pos.z,
    rand: (i, k, salt) => hash3(room.vnum, i, k, salt),
    clears,
    kinds: [
      { name: model(['bush'], 0), count: 5, ring: 4.4, spread: 1.0, size: 0.85, salt: 86 },
      { name: model(['grass_tuft'], 0), count: 14, ring: 4.2, spread: 1.8, size: 1.0, salt: 90 },
    ],
  });
}

/**
 * A walkable forest room: the floor of a coastal rainforest, not a lawn.
 *
 * Haon Dor is the largest outdoor surface in the default world and its *rooms*
 * carried nothing at all -- grass to the cell edge, with every tree in the
 * filler cells between them. Standing in one you were on a mown clearing
 * looking at a treeline, a hundred times over. So the rooms are planted too,
 * on the park's rules, because a room is somewhere you walk: the ring near the
 * edges gets the undergrowth, the middle stays clear -- that is where the
 * player arrives -- and any side with a way out of it keeps its last metre and
 * a half, or the trail is blocked by a fern.
 *
 * The trees go through the `decor` path rather than being instanced here, so
 * the no-assets fallback still grows something; the species is actors.js's
 * choice, which is where a fir-first pick belongs.
 *
 * `dense` is a room the mud flags ROOM_INDOORS: under the canopy, not in a
 * clearing. It has no walls to be enclosed by, so its own trees are the
 * enclosure -- a picket just inside every side there is no way out of, close
 * enough that the crowns knit over the room, with the undergrowth thickened to
 * match. Everything else about the cell is what an open forest room gets.
 */
const FOREST_CLEAR = 1.5;
/** Nothing inside this of the centre: the player materialises there. */
const FOREST_MIDDLE = 2.5;
const FOREST_CORNER = 4.6;
/** The picket line, far enough in that a trunk is inside its own cell. */
const FOREST_PICKET = 5.2;
/** How much of a side the picket spreads over: the cell, less a corner each end. */
const FOREST_SPAN = CELL - 2.2;

function buildForest({ room, pos, sides, instances, model, chunk, decor, addCollider, dense = false }) {
  const clears = edgeClear(sides, FOREST_CLEAR);
  const open = (lx, lz) => Math.hypot(lx, lz) >= FOREST_MIDDLE && clears(lx, lz);
  const trunks = [];
  // `conifer` weights the species pick in actors.js toward fir: this is the
  // deep coastal forest, not a town park.
  const plant = (lx, lz, scale) => {
    const tx = pos.x + lx;
    const tz = pos.z + lz;
    decor.push({ kind: 'tree', conifer: true, x: tx, y: pos.y, z: tz, scale });
    // The trunk grows with the tree; walking through a metre-wide bole is
    // worse than walking around it.
    const r = Math.max(0.7, 0.5 * scale);
    addCollider(tx - r, tx + r, tz - r, tz + r, pos.y, pos.y + 8);
    trunks.push([lx, lz]);
  };
  // Which corners are plantable at all, starting from a different one per room.
  // Taking the first that clear, rather than dropping a corner that fails, is
  // what stops a room coming out with nothing standing in it after all: with a
  // jittered corner simply skipped when it reached into a doorway, 13 of the
  // default world's 68 forest rooms were still bare lawn. Now none are.
  const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  const first = Math.floor(hash3(room.vnum, 1, 0, 100) * corners.length);
  const spots = [];
  for (let k = 0; k < corners.length; k++) {
    const [sx, sz] = corners[(first + k) % corners.length];
    const lx = sx * (FOREST_CORNER + (hash3(room.vnum, k, 0, 101) - 0.5) * 1.6);
    const lz = sz * (FOREST_CORNER + (hash3(room.vnum, k, 1, 101) - 0.5) * 1.6);
    if (open(lx, lz)) spots.push([lx, lz, k]);
  }

  // The picket: two or three firs along every side there is no way out of,
  // standing where a wall would have been. The sides you can walk out of keep
  // their metre and a half, so a trail still runs through -- and salal fills the
  // gap between one trunk and the next, or the picket is a colonnade you can see
  // straight out of at eye level.
  const salal = instances ? model(['salal_bush'], 0) : null;
  if (dense) {
    for (let d = 0; d < 4; d++) {
      if (sides[d]) continue;
      const [dx, , dz] = DIR_STEP[d];
      const n = hash3(room.vnum, d, 0, 104) > 0.5 ? 3 : 2;
      const at = (along, out) => (dx ? [dx * out, along] : [along, dz * out]);
      for (let i = 0; i < n; i++) {
        const base = ((i + 0.5) / n - 0.5) * FOREST_SPAN;
        const [lx, lz] = at(base + (hash3(room.vnum, d, i, 105) - 0.5) * 1.1,
          FOREST_PICKET - hash3(room.vnum, d, i, 106) * 0.6);
        if (open(lx, lz)) plant(lx, lz, 1.9 + hash3(room.vnum, d, i, 107) * 0.7);
        if (!salal || i === n - 1) continue;
        const [sx, sz] = at(base + FOREST_SPAN / (n * 2), FOREST_PICKET - 0.5);
        if (!open(sx, sz)) continue;
        instances.add(salal, {
          x: pos.x + sx, y: pos.y, z: pos.z + sz,
          rotY: hash3(room.vnum, d, i, 108) * Math.PI * 2,
          scale: 0.9 + hash3(room.vnum, d, i, 109) * 0.5,
        }, chunk);
      }
    }
  }

  // One or two in the corners, because the ways out are on the axes and the
  // walk across is too. A forest room with nothing standing in it is a
  // clearing, and Haon Dor is not a hundred clearings in a row. A dense room
  // whose picket found a side is already walled by it; one with a way out of
  // every side -- a crossing in the woods -- falls back to these.
  const trees = trunks.length ? 0 : Math.min(spots.length, hash3(room.vnum, 0, 0, 100) > 0.45 ? 2 : 1);
  for (let i = 0; i < trees; i++) {
    const [lx, lz, k] = spots[i];
    // Coastal scale. A judge measured the stand: median trunk 0.81 m -- a
    // 45-55 m tree in Capilano -- under a 9.8 m crown, height:diameter 12:1
    // against a real conifer's 50:1, with open sky at the zenith of a room
    // the mud calls "utter darkness". The trunks were right; the trees were
    // planted at toy scale. Double them and the crowns knit.
    plant(lx, lz, 1.7 + hash3(room.vnum, k, 2, 101) * 0.8);
  }

  if (!instances) return;

  // A boulder in one room in four -- one in three under the canopy -- in a
  // corner nothing is standing in already, and this one does get a collider,
  // because a metre of granite is not a fern.
  const bare = spots.slice(trees).find(([lx, lz]) => trunks.every(
    ([tx, tz]) => Math.hypot(lx - tx, lz - tz) > 1.7,
  ));
  const rock = bare && hash3(room.vnum, 0, 0, 102) < (dense ? 1 / 3 : 0.25)
    ? model(['moss_rock'], 0) : null;
  if (rock) {
    const [lx, lz] = bare;
    const scale = 0.9 + hash3(room.vnum, 3, 0, 102) * 0.5;
    instances.add(rock, {
      x: pos.x + lx, y: pos.y, z: pos.z + lz,
      rotY: hash3(room.vnum, 4, 0, 102) * Math.PI * 2, scale,
    }, chunk);
    addStoneCollider({ instances, name: rock, x: pos.x + lx, y: pos.y, z: pos.z + lz, scale, addCollider });
  }

  scatterUndergrowth({
    instances, chunk, x: pos.x, y: pos.y, z: pos.z,
    rand: (i, k, salt) => hash3(room.vnum, i, k, salt),
    clears: open,
    kinds: [
      { name: model(['fern'], 0), count: (dense ? 6 : 4) + Math.floor(hash3(room.vnum, 0, 0, 103) * 4), ring: 4.6, spread: dense ? 2.4 : 1.6, size: 1.0, salt: 110 },
      { name: salal, count: (dense ? 3 : 2) + Math.floor(hash3(room.vnum, 1, 0, 103) * 2), ring: 4.9, spread: 1.2, size: 1.0, salt: 111 },
      { name: model(['grass_tuft'], 0), count: (dense ? 8 : 6) + Math.floor(hash3(room.vnum, 2, 0, 103) * 4), ring: 4.4, spread: 2.0, size: 1.0, salt: 112 },
    ],
  });
}

/**
 * A box round a boulder, read off the model rather than guessed: Blender puts
 * the origin on the floor, so the height is the whole of `size.y`.
 */
function addStoneCollider({ instances, name, x, y, z, scale, addCollider }) {
  const size = instances.library.get(name)?.size;
  const half = ((size ? Math.max(size.x, size.z) : 0.9) * scale) / 2;
  addCollider(x - half, x + half, z - half, z + half, y, y + (size ? size.y : 0.9) * scale);
}

// ------------------------------------------------------------------ bog ----

/** Nothing inside this of the centre gets wet: the player materialises there. */
const BOG_MIDDLE = 2.3;
/** How much of a side you can walk out of stays clear of water and reeds. */
const BOG_CLEAR = 2.0;
/** A disc small enough that one fits between the arrival point and the kerb. */
const POOL_R = [1.2, 1.8];
/** Standing water lies on the peat rather than being cut into the floor slab. */
const POOL_LIFT = 0.03;

/**
 * A pool of standing water, off to one side of a bog room.
 *
 * Two rules shape it. It may not sit at the centre, which is where the player
 * arrives; and it may not fill the cell, because a full cell of water is a lake
 * and a bog is water lying in a hollow with peat all round it. That leaves a
 * band: a disc of radius r has to clear 2.3 m at the middle and stay 0.5 m
 * inside a 6.5 m half-cell, so 2r <= 3.7 and nothing bigger than 1.8 m fits.
 * Three overlapping lobes of that size, clustered on one anchor angle, come to
 * about 7% of the cell and read as one irregular pool rather than three
 * puddles on a ring.
 *
 * The anchor points away from the ways out, so the water is never in a doorway
 * and the walk through the room is dry. And the lobes are *clamped* into that
 * band rather than rejected when they miss it -- the forest picket learned this
 * the expensive way, with 13 of 68 rooms coming out bare because a jittered
 * spot that reached into a doorway was simply dropped.
 */
function buildBogPool({ batcher, chunk, room, pos, sides }) {
  // Away from the exits: sum the ways out and face the other way.
  let ax = 0; let az = 0;
  for (let d = 0; d < 4; d++) {
    if (!sides[d]) continue;
    const [dx, , dz] = DIR_STEP[d];
    ax += dx; az += dz;
  }
  const anchor = (ax || az) ? Math.atan2(-az, -ax) : hash3(room.vnum, 1, 0, 172) * Math.PI * 2;

  const discs = [];
  for (let i = 0; i < 3; i++) {
    const angle = anchor + (hash3(room.vnum, i, 0, 173) - 0.5) * 1.6;
    const r = POOL_R[0] + hash3(room.vnum, i, 1, 174) * (POOL_R[1] - POOL_R[0]);
    const cos = Math.cos(angle); const sin = Math.sin(angle);
    // The far limit is where the disc would cross the cell wall on whichever
    // axis it runs closest to; the near limit is the dry landing at the centre.
    const far = Math.min(
      (HALF - 0.5 - r) / Math.max(0.1, Math.abs(cos)),
      (HALF - 0.5 - r) / Math.max(0.1, Math.abs(sin)),
    );
    const near = BOG_MIDDLE + r;
    if (far < near) continue;
    const rho = Math.min(far, Math.max(near, 3.4 + hash3(room.vnum, i, 2, 175) * 1.4));
    const lx = cos * rho; const lz = sin * rho;
    const geo = new THREE.CircleGeometry(r, 14);
    geo.rotateX(-Math.PI / 2);
    batcher.add(geo, 'bogwater', place(pos.x + lx, pos.y + POOL_LIFT, pos.z + lz), { chunk });
    geo.dispose();
    discs.push({ x: lx, z: lz, r });
  }
  return discs;
}

/**
 * What grows in a bog: reeds standing in the shallows at the water's edge,
 * tussocks and dead timber on the peat between.
 *
 * The three models this wants are being made; until they land every one falls
 * back to something already in the library, so a bog is never bare ground. The
 * pool footprint comes in from `buildBogPool` and nothing is planted inside it
 * -- a reed bed rings a pool, it does not float on one.
 */
function buildBogFlora({ room, pos, sides, pools, instances, model, chunk }) {
  if (!instances) return;
  const clears = edgeClear(sides, BOG_CLEAR);
  const inWater = (lx, lz) => (pools || []).some((p) => Math.hypot(lx - p.x, lz - p.z) < p.r);
  const dry = (lx, lz) => Math.hypot(lx, lz) >= BOG_MIDDLE && clears(lx, lz) && !inWater(lx, lz);

  // A reed clump wants a name of its own; a fern is the nearest thing standing
  // in the library, and salal and a mossed boulder stand in for the rest.
  const reed = model(['reed_clump', 'fern'], 0);
  const tussock = model(['tussock', 'salal_bush', 'grass_tuft'], 0);
  const log = model(['dead_log', 'moss_rock'], 0);

  // The margin: a ring just outside each lobe, which is where reeds actually
  // grow -- roots in the water, heads out of it.
  if (reed) {
    for (const [i, p] of (pools || []).entries()) {
      const n = 5 + Math.floor(hash3(room.vnum, i, 0, 181) * 4);
      for (let k = 0; k < n; k++) {
        const a = ((k + hash3(room.vnum, i, k, 182)) / n) * Math.PI * 2;
        const rr = p.r + 0.15 + hash3(room.vnum, i, k, 183) * 0.7;
        const lx = p.x + Math.cos(a) * rr;
        const lz = p.z + Math.sin(a) * rr;
        if (!clears(lx, lz) || inWater(lx, lz)) continue;
        instances.add(reed, {
          x: pos.x + lx, y: pos.y, z: pos.z + lz,
          rotY: hash3(room.vnum, i, k, 184) * Math.PI * 2,
          scale: 0.85 + hash3(room.vnum, i, k, 185) * 0.5,
        }, chunk);
      }
    }
  }

  // A dead log lies where a tree fell, so one per room at most, out on the peat.
  if (log && hash3(room.vnum, 0, 0, 186) > 0.42) {
    const a = hash3(room.vnum, 1, 0, 187) * Math.PI * 2;
    const rho = 3.6 + hash3(room.vnum, 2, 0, 188) * 1.6;
    const lx = Math.cos(a) * rho; const lz = Math.sin(a) * rho;
    if (dry(lx, lz)) {
      instances.add(log, {
        x: pos.x + lx, y: pos.y, z: pos.z + lz,
        rotY: hash3(room.vnum, 3, 0, 189) * Math.PI * 2,
        scale: 0.9 + hash3(room.vnum, 4, 0, 190) * 0.4,
      }, chunk);
    }
  }

  scatterUndergrowth({
    instances, chunk, x: pos.x, y: pos.y, z: pos.z,
    rand: (i, k, salt) => hash3(room.vnum, i, k, salt),
    clears: dry,
    kinds: [
      { name: tussock, count: 6 + Math.floor(hash3(room.vnum, 0, 0, 191) * 4), ring: 4.5, spread: 2.6, size: 1.0, salt: 192 },
      { name: reed, count: 4 + Math.floor(hash3(room.vnum, 1, 0, 191) * 3), ring: 5.1, spread: 1.6, size: 0.9, salt: 193 },
    ],
  });
}

// ----------------------------------------------------------------- mist ----

/**
 * Under the bloom threshold at every hour, and thin enough to see through.
 * Measured against the ground band with the bank hidden and shown: at 0.05/0.12
 * dawn lifted it 14.8 of luminance, which is a veil over the marsh rather than
 * mist lying in it. These read 9.2 at dawn, 5.8 at dusk, 1.4 at night and 0.2
 * at noon -- dawn stays the thickest, which is the hour a bog actually steams.
 */
const MIST_MIN = 0.04;
const MIST_MAX = 0.085;
/**
 * Mist is lit by the sky directly above it, and the haze colour `applyTime`
 * hands out is the horizon's -- the brightest part of the dome at both ends of
 * the day. A knee-high bank sees less than that.
 */
const MIST_SKY = 0.85;
/** Knee height and below: this is ground mist, not weather. */
const MIST_HEIGHTS = [0.35, 0.8, 1.3];

/**
 * The alpha of a mist bank: two and a bit octaves of value noise on a periodic
 * lattice, so it tiles. `hash3` is the file's own generator -- the horizon uses
 * it as a stream the same way -- and there is no reason for a second one.
 */
function mistTexture(size = 128) {
  const at = (ix, iy, period, salt) => hash3(
    ((ix % period) + period) % period, ((iy % period) + period) % period, 0, salt,
  );
  const noise = (x, y, period, salt) => {
    const ix = Math.floor(x); const iy = Math.floor(y);
    const fx = x - ix; const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx); const sy = fy * fy * (3 - 2 * fy);
    const a = at(ix, iy, period, salt); const b = at(ix + 1, iy, period, salt);
    const c = at(ix, iy + 1, period, salt); const d = at(ix + 1, iy + 1, period, salt);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size; const v = (y + 0.5) / size;
      const n = noise(u * 4, v * 4, 4, 401) * 0.62
        + noise(u * 9, v * 9, 9, 409) * 0.26
        + noise(u * 18, v * 18, 18, 419) * 0.12;
      const a = Math.max(0, Math.min(1, n * 1.55 - 0.28)) * 255;
      const i = (y * size + x) * 4;
      data[i] = a; data[i + 1] = a; data[i + 2] = a; data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Ground mist over the bog: flat horizontal quads, three to a cell.
 *
 * Not sprites. The chimney smoke measured 4.5 ms a frame on its own -- 910 soft
 * billboards 3.2 m across, and large soft sprites are the most expensive thing
 * per pixel there is. A horizontal sheet seen from standing height is nearly
 * edge-on, so a 14 m bank covers a band of the frame rather than a disc of it,
 * and three of them stacked at ankle, shin and knee height cost a fraction of
 * one billboard cloud.
 *
 * Three things they must be. On `OVERLAY_LAYER`, because GTAO's prepass renders
 * the scene with an override material and cannot see alpha -- a transparent
 * quad in that buffer is an opaque wall and the AO shades what is behind it,
 * which is exactly the bug the name labels shipped. `depthWrite` off, so the
 * banks read through each other. And no colour of its own: `setHour` feeds it
 * the hour's haze, because a material with hardcoded radiance is the fault that
 * made the river glow white at night.
 */
function buildMist(group, cells) {
  if (!cells.length) return null;
  const texture = mistTexture();
  const parts = [];
  cells.forEach((cell, index) => {
    MIST_HEIGHTS.forEach((height, layer) => {
      const seed = (k, salt) => hash3(index, layer, k, salt);
      // Wider than a 13 m cell on purpose: a bank whose edge lines up with a
      // cell boundary is a decal, and the overlap is what joins the marsh up.
      const size = 12 + seed(0, 421) * 5;
      const cx = cell.x + (seed(2, 423) - 0.5) * 5;
      const cz = cell.z + (seed(4, 425) - 0.5) * 5;
      const geo = new THREE.PlaneGeometry(size, size, 6, 6);
      geo.rotateX(-Math.PI / 2);
      geo.rotateY(seed(1, 422) * Math.PI * 2);
      geo.translate(cx, cell.y + height + (seed(3, 424) - 0.5) * 0.3, cz);
      // Alpha in the vertex colour is what feathers the edges; the noise map
      // is a tiling pattern and has no edge of its own to fade.
      const pos = geo.attributes.position;
      const colour = new Float32Array(pos.count * 4);
      const uv = geo.attributes.uv;
      // Each bank samples its own patch of the one noise map, so a single
      // scrolling offset drifts all of them without any two matching.
      const ou = seed(5, 426) * 8; const ov = seed(6, 427) * 8;
      const us = 0.7 + seed(7, 428) * 0.6;
      for (let i = 0; i < pos.count; i++) {
        const dx = (pos.getX(i) - cx) / (size / 2);
        const dz = (pos.getZ(i) - cz) / (size / 2);
        const t = Math.max(0, 1 - Math.hypot(dx, dz));
        colour[i * 4] = 1; colour[i * 4 + 1] = 1; colour[i * 4 + 2] = 1;
        colour[i * 4 + 3] = t * t * (3 - 2 * t);
        uv.setXY(i, uv.getX(i) * us + ou, uv.getY(i) * us + ov);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colour, 4));
      parts.push(geo);
    });
  });

  const material = new THREE.MeshBasicMaterial({
    color: 0xbcd2e6, transparent: true, opacity: MIST_MIN, depthWrite: false,
    side: THREE.DoubleSide, vertexColors: true, alphaMap: texture,
  });
  const merged = mergeGeometries(parts, false);
  for (const geo of parts) geo.dispose();
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = 'bog-mist';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.layers.set(OVERLAY_LAYER);
  // Three's own per-mesh hook, so the drift needs no place in anyone's loop.
  mesh.onBeforeRender = () => {
    const t = performance.now() / 1000;
    texture.offset.set(t * 0.0055, t * 0.0022);
  };
  group.add(mesh);

  return {
    mesh,
    /**
     * Radiation fog burns off as the ground warms and stands again once the sun
     * is off it, so the bank is thickest at night and thinnest at noon. The
     * colour is the hour's haze: a mist is lit by the sky and nothing else.
     */
    setHour(colourHex, elevationDeg) {
      material.color.setHex(colourHex).multiplyScalar(MIST_SKY);
      const day = Math.max(0, Math.min(1, (elevationDeg + 4) / 26));
      material.opacity = MIST_MAX - (MIST_MAX - MIST_MIN) * day;
    },
  };
}

/** The boundary of an open-air room: an opening, or something to stop you. */
function buildOutdoorEdge({ batcher, chunk, room, pos, dir, open, addCollider, bog = false }) {
  if (open) return;

  // A street with frontage has a building on this side already; a low garden
  // wall in front of it is one wall too many.
  if (wantsFrontage(room)) return;

  // A pen is fenced, not walled. Without this the pig pen took the CITY branch
  // below and came out ringed in 2.6 m of dressed ashlar.
  if (isShire(room) && FARMYARD.test(room.name)) {
    buildRailFence({ batcher, chunk, pos, dir, addCollider });
    return;
  }

  const [dx, , dz] = DIR_STEP[dir];
  const bx = pos.x + dx * (HALF - 0.3);
  const bz = pos.z + dz * (HALF - 0.3);
  const along = dir === 1 || dir === 3;
  const t = 0.6;
  // Half the marsh is sectored MOUNTAIN, so every closed side of a bog was a
  // waist-high grey rock kerb: a wet hollow fenced in dry stone. A cut peat
  // bank is the same barrier out of the ground the room is actually made of,
  // and low enough to see the next hollow over.
  const h = room.sector === SECTOR.CITY ? 2.6 : (bog ? 0.9 : 1.4);
  const material = bog ? 'peat' : (room.sector === SECTOR.CITY ? 'stonewall' : 'rock');
  // `wallAo` runs 0.58 -> 1.0 over 1.8 m, which on a 0.9 m bank never gets past
  // 0.79 -- the whole face shaded, hard. On rock that survives; on peat, the
  // darkest surface in the world, it was the *only* thing outdoors putting
  // pixels at literal RGB 0. Measured: 1448 zeros in a noon frame, 195 with
  // vertex colours off, and the wet term accounted for none of it.
  const shade = bog
    ? (x, y) => 0.84 + 0.16 * Math.min(1, (y - pos.y) / h)
    : wallAo(pos.y);
  batcher.add(box(along ? t : CELL, h, along ? CELL : t, 2, 2, 2), material,
    place(bx, pos.y + h / 2, bz), { chunk, ao: shade });
  addCollider(bx - (along ? t : CELL) / 2, bx + (along ? t : CELL) / 2,
    bz - (along ? CELL : t) / 2, bz + (along ? CELL : t) / 2, pos.y, pos.y + h + 2);
}

/**
 * Post and rail along one side of a cell: six posts and two rails, waist high,
 * so you can see the pigs over it. The collider is the whole line and stands
 * taller than the timber -- you cannot step over a fence here any more than
 * you can step over a wall.
 */
function buildRailFence({ batcher, chunk, pos, dir, addCollider }) {
  const [dx, , dz] = DIR_STEP[dir];
  const along = dir === 1 || dir === 3;
  const out = HALF - 0.35;
  const at = (a) => (along
    ? { x: pos.x + dx * out, z: pos.z + a }
    : { x: pos.x + a, z: pos.z + dz * out });
  const H = 1.3;
  for (let i = 0; i < 6; i++) {
    const p = at((i / 5 - 0.5) * (CELL - 0.7));
    batcher.add(box(0.2, H, 0.2), 'timber', place(p.x, pos.y + H / 2, p.z), { chunk });
  }
  const c = at(0);
  for (const ry of [0.46, 1.02]) {
    const [rw, rd] = along ? [0.11, CELL] : [CELL, 0.11];
    batcher.add(box(rw, 0.16, rd), 'timber', place(c.x, pos.y + ry, c.z), { chunk });
  }
  const [cw, cd] = along ? [0.6, CELL] : [CELL, 0.6];
  addCollider(c.x - cw / 2, c.x + cw / 2, c.z - cd / 2, c.z + cd / 2, pos.y, pos.y + H + 1.2);
}

/**
 * A routed passage, cell by cell. Out of doors it is left open and the
 * buildings that fill the cells beside it become the street frontage; between
 * two indoor rooms it gets walls and a ceiling and becomes a corridor.
 */
function buildAlley({ batcher, link, worldOf, chunkOf, addCollider, addPlatform, lights, decor, mistCells }) {
  const enclosed = alleyEnclosed(link);
  const source = isOpenAir(link.from.room) ? link.from.room : link.to.room;
  const mats = pickMaterials(source, source.area);
  const bog = isBog(source);
  // A river is a chain of water rooms with a routed cell between each pair, and
  // only the rooms ever got a water surface -- so midstream showed the raw
  // `water` floor material between two shader planes, a boiling band 13 m wide
  // across every reach. The plane is a pure function of world position, so one
  // laid over the routed cell joins the two either side of it seamlessly.
  // ...unless both of them are bog, where the same sector code means standing
  // water in peat rather than a reach of river.
  const midstream = isWater(link.from.room) && isWater(link.to.room)
    && !isBog(link.from.room) && !isBog(link.to.room);
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

    // The floor underneath stays as it is; the plane covers it, at the same
    // height and size the rooms either side use.
    if (midstream) decor.push({ kind: 'water', x: pos.x, y: y + 0.7, z: pos.z, size: CELL });
    if (bog && mistCells) mistCells.push({ x: pos.x, y, z: pos.z });

    if (!enclosed) {
      // Was 0.86 -- one street cell in seven carried anything at all, which is
      // most of why the town read as a blockout. The two open ends of the
      // passage are excluded so nothing lands in the middle of the way through.
      // Not on the river, though: a routed cell between two water rooms is
      // water now, and barrels do not stack on it.
      if (!midstream && !bog && hash3(c.x, c.z, level, 12) > 0.45) {
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
  // "A smial, a hole in the ground which serves as the proper dwelling place
  // for halflings." What is over one is the hill, not a roof -- so a turf dome
  // sits on the wall head instead of a pitched span, and with `wallOut` already
  // earth the frontage reads as a bank with a doorway in it.
  //
  // The dome is barely wider than the walls it stands on. A hemisphere has no
  // bottom cap, so any of it that oversails is an open shell seen from below;
  // 15 cm of overhang is hidden by the wall itself.
  if (mats.smial) {
    const wallTop = y - SLAB + 1.1;
    const width = SHELL * 2 + 0.3;
    const domeH = 3.2 + hash3(room.vnum, 3, 0, 2) * 1.4;
    // A collar first. The room is a square and the dome is a circle, so the
    // four corners of the wall head reach 2.4 m past the rim -- and a dome set
    // straight on them leaves an open triangle at each corner that you can see
    // the sky through, which is what it did. A closed slab of turf across the
    // whole head caps them and reads as the thick edge of a turf roof.
    const collar = SHELL * 2 + 0.7;
    batcher.add(box(collar, 0.55, collar, 3, 1, 3), 'grass',
      place(x, wallTop + 0.275, z), { chunk, uvScale: TURF_UV });
    const dome = mound(width, domeH, width);
    batcher.add(dome, 'grass', place(x, wallTop + 0.45, z), { chunk, uvScale: TURF_UV });
    dome.dispose();
    // A chimney out of the turf, rooted where the dome is still thick.
    const angle = hash3(room.vnum, 7, 0, 5) * Math.PI * 2;
    const r = 2.6 + hash3(room.vnum, 8, 0, 6) * 1.4;
    const cx = x + Math.cos(angle) * r;
    const cz = z + Math.sin(angle) * r;
    const turf = wallTop + 0.45 + domeH * Math.sqrt(Math.max(0, 1 - ((2 * r) / width) ** 2));
    batcher.add(box(0.9, 2.4, 0.9), 'stonewall', place(cx, turf + 0.4, cz), { chunk });
    decor.push({ kind: 'smoke', x: cx, y: turf + 1.7, z: cz });
    return;
  }
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

/**
 * What the room says is in it.
 *
 * Diku prose is formulaic about fittings, and where it names one it usually
 * names the wall too: "the bar is set against the northern wall", "a fireplace
 * is built into the western wall". That is a placement instruction, not
 * scenery, and reading it is the same move `pickMaterials` already makes on the
 * room name. Across the 45 stock areas 107 rooms name a counter, a hearth,
 * shelves or an altar and seven of them say which wall -- and it is the only
 * way the Grunting Boar gets the bar its own description has always promised.
 */
const WALL_WORD = { north: 0, east: 1, south: 2, west: 3 };
// The lookbehind is not decoration. "A small entrance to the bar is in the
// northern wall" is a doorway, and without it the Cleric's Guild entrance hall
// grew a counter out of the description of the room next door.
const FITTING_ON_WALL = /(?<!(?:entrance|door|doorway|way|opening|stairs?|passage)\s+(?:to|into)\s+the\s+)\b(bar|counter|fireplace|hearth|forge|altar|shelves|shelf|bookcase)\b[^.]{0,90}?\b(?:against|into|in|on|by|along|beside)\s+the\s+(north|south|east|west)(?:ern)?\s+(?:wall|side|end)/gi;
const FITTING_KIND = {
  bar: 'counter', counter: 'counter',
  fireplace: 'hearth', hearth: 'hearth', forge: 'hearth',
  shelves: 'shelves', shelf: 'shelves', bookcase: 'shelves',
  altar: 'altar',
};
// A room that *is* a bar, not one that mentions where the bar is: "to the east
// is the bar" is a direction and "a little sand bar" is in a river. The name is
// the reliable signal -- Cleric's Bar, The Thieves Bar, Nyles' House of Ale --
// and the entrance halls and practice yards that point at one are not it.
const TAPROOM = /\b(bar|inn|tavern|pub|alehouse|taproom|ale)\b/i;
const NOT_THE_ROOM_ITSELF = /\b(entrance|hall|yard|street|road|square|gate|path|door)\b/i;

function readFittings(room, sides) {
  const text = `${room.name}. ${room.description}`.replace(/\s+/g, ' ');
  const blank = [];
  for (let d = 0; d < 4; d++) if (!sides[d]) blank.push(d);
  const found = new Map();   // kind -> dir, first mention wins

  FITTING_ON_WALL.lastIndex = 0;
  let m;
  while ((m = FITTING_ON_WALL.exec(text))) {
    const kind = FITTING_KIND[m[1].toLowerCase()];
    if (kind && !found.has(kind)) found.set(kind, WALL_WORD[m[2].toLowerCase()]);
  }

  // Named without a wall: put it somewhere there is no door, if there is one.
  const loose = (pattern, kind) => {
    if (found.has(kind) || !pattern.test(text)) return;
    found.set(kind, blank.length ? blank[found.size % blank.length] : 0);
  };
  if (TAPROOM.test(room.name) && !NOT_THE_ROOM_ITSELF.test(room.name)) loose(/./, 'counter');
  loose(/\bcounter\b/i, 'counter');
  loose(/\b(fireplace|hearth|forge)\b/i, 'hearth');
  loose(/\bshelves\b/i, 'shelves');
  loose(/\baltar\b/i, 'altar');

  return [...found].map(([kind, dir]) => ({ kind, dir }));
}

function buildInteriorProps({ room, pos, sides, decor, mats }) {
  for (const f of readFittings(room, sides)) {
    // A wall the text names may still be the one with the door in it -- the
    // Grunting Boar's fireplace is in the western wall and west is its only way
    // out. Slide the fitting along until it clears the opening rather than
    // moving it to a wall the mud did not choose.
    const blocked = !!sides[f.dir];
    decor.push({
      kind: 'fitting', fitting: f.kind, dir: f.dir, blocked,
      x: pos.x, y: pos.y, z: pos.z, seed: hash3(room.vnum, f.dir, 0, 71),
    });
    // A bar with nowhere to sit and drink is a counter. The prose does not
    // list the tables because nobody would think to; "this place makes you
    // feel like home" is the line that stands in for them.
    if (f.kind === 'counter') {
      const [nx, , nz] = DIR_STEP[f.dir];
      for (let i = 0; i < 3; i++) {
        const along = (i - 1) * 2.9 + (hash3(room.vnum, i, 0, 73) - 0.5) * 0.8;
        const back = 1.7 + hash3(room.vnum, i, 0, 74) * 1.7;
        decor.push({
          kind: 'table', benches: true,
          x: pos.x - nx * back - nz * along,
          y: pos.y,
          z: pos.z - nz * back - nx * along,
          spin: (hash3(room.vnum, i, 0, 75) - 0.5) * 0.5,
        });
      }
    }
  }
  buildLooseProps({ room, pos, sides, decor, mats });
}

/**
 * What is stacked against the wall of a barn is not what is stacked against
 * the wall of a guild hall, and the general list is mostly a guild hall's.
 * Null leaves the general list alone; `hay_bale` twice weights the pick, the
 * same trick `buildForest` uses to get a fir-first mix out of `choose`.
 */
const FARM = /\b(pig ?pen|barn|chicken coop|stable|byre|sty|gamgee|farm(?:er|house|yard)?s?)\b/i;
const FARM_PROPS = [
  'hay_bale', 'hay_bale', 'trough', 'sack', 'barrel', 'firewood_pile',
  'planks_pile', 'bucket', 'cartwheel', 'ladder', 'water_butt', 'crate',
];
const farmProps = (room) => (isShire(room) && FARM.test(room.name) ? FARM_PROPS : null);

function buildLooseProps({ room, pos, sides, decor, mats }) {
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
      props: farmProps(room),
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
function buildFiller({ batcher, instances, model, faceRot, chunk, sector, bog, shire, x, y, z, seed, addCollider, lights, decor }) {
  // Pave the cell to match its street before building on it. Without this the
  // world's ground plane shows through around the footings -- which read as a
  // lawn once that plane became grass.
  const GROUND = {
    [SECTOR.CITY]: 'cobble', [SECTOR.FIELD]: 'grass', [SECTOR.FOREST]: 'grass',
    [SECTOR.HILLS]: 'grass', [SECTOR.MOUNTAIN]: 'rock', [SECTOR.DESERT]: 'sand',
  };
  // A bog is what its rooms say, and so is everything between them. Half the
  // Old Marsh is sectored MOUNTAIN, and taken at its word that put an
  // eleven-metre rock face in every cell beside a bog -- a wet hollow at the
  // bottom of a quarry. Reed beds and dead timber on peat instead, and nothing
  // to wall it in: the kerbs on the rooms themselves are the barrier.
  if (bog) {
    batcher.add(plane(CELL, CELL, 3), 'peat', place(x, y, z), { chunk });
    if (!instances) return;
    scatterUndergrowth({
      instances, chunk, x, y, z,
      rand: (i, k, salt) => hash3(x, z, i, salt + k),
      kinds: [
        { name: model(['reed_clump', 'fern'], 0), count: 4 + Math.floor(hash3(x, z, 0, 194) * 4), ring: 4.0, spread: 5.0, size: 1.0, salt: 195 },
        { name: model(['tussock', 'salal_bush', 'grass_tuft'], 0), count: 3 + Math.floor(hash3(x, z, 0, 196) * 3), ring: 4.4, spread: 4.4, size: 1.0, salt: 197 },
      ],
    });
    const log = hash3(x, z, 0, 198) < 0.3 ? model(['dead_log', 'moss_rock'], 0) : null;
    if (log) {
      instances.add(log, {
        x: x + (hash3(x, z, 1, 198) - 0.5) * CELL * 0.6, y,
        z: z + (hash3(x, z, 2, 198) - 0.5) * CELL * 0.6,
        rotY: hash3(x, z, 3, 198) * Math.PI * 2,
        scale: 0.9 + hash3(x, z, 4, 198) * 0.4,
      }, chunk);
    }
    return;
  }
  const ground = GROUND[sector];
  if (ground) {
    batcher.add(plane(CELL, CELL, 3), ground, place(x, y, z), { chunk });
  }

  switch (sector) {
    case SECTOR.CITY: {
      const w = CELL * 0.92;
      const d = CELL * 0.92;
      // Behind a Shire frontage the ground goes on: a knoll a cell wide, or a
      // cottage in its own garden. Never the modelled house -- fit-scaled it
      // stands 9-11 m and the banks in front of it are three, so it would
      // simply look over them. (w and d are equal here, so the ridge rotation
      // is symmetric and cannot come out across the building.)
      if (shire) {
        if (seed < 0.62) {
          const kh = 3.6 + hash3(x, z, 0, 28) * 1.8;
          const knoll = mound(CELL + 1.4, kh, CELL + 1.4);
          batcher.add(knoll, 'grass', place(x, y, z), { chunk, uvScale: TURF_UV });
          knoll.dispose();
          addCollider(x - HALF, x + HALF, z - HALF, z + HALF, y, y + kh);
          break;
        }
        const ch = 3.0 + hash3(x, z, 0, 29) * 0.9;
        batcher.add(box(w, ch, d, 3, 2, 3), hash3(x, z, 0, 22) > 0.5 ? 'plaster' : 'timber',
          place(x, y + ch / 2, z), { chunk, ao: wallAo(y) });
        const cRoof = 2.6 + hash3(x, z, 0, 23) * 1.4;
        batcher.add(triPrism(w + 1.0, cRoof, d + 1.0), hash3(x, z, 0, 24) > 0.35 ? 'thatch' : 'rooftile',
          place(x, y + ch, z, hash3(x, z, 0, 25) > 0.5 ? Math.PI / 2 : 0), { chunk });
        addCollider(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y, y + ch);
        decor.push({ kind: 'windows', x, y, z, w, d, h: ch, seed: hash3(x, z, 0, 26) });
        if (hash3(x, z, 0, 27) > 0.45) decor.push({ kind: 'smoke', x, y: y + ch + cRoof, z });
        break;
      }
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
      // One cell in six stands a dead spar instead of one of its trees: a stand
      // of identical live conifers is wallpaper, and the snag is the thing that
      // says this wood is old. It keeps the trunk's collider either way.
      const snag = instances && hash3(x, z, 0, 161) < 1 / 6 ? model(['tree_snag'], 0) : null;
      const spar = snag ? Math.floor(hash3(x, z, 1, 161) * 5) : -1;
      for (let i = 0; i < 5; i++) {
        const tx = x + (hash3(x, z, i, 31) - 0.5) * CELL * 0.9;
        const tz = z + (hash3(x, z, i, 32) - 0.5) * CELL * 0.9;
        if (i === spar) {
          instances.add(snag, {
            x: tx, y, z: tz, rotY: hash3(x, z, i, 162) * Math.PI * 2,
            scale: 0.85 + hash3(x, z, i, 163) * 0.4,
          }, chunk);
        } else {
          decor.push({ kind: 'tree', conifer: true, x: tx, y, z: tz, scale: 1.5 + hash3(x, z, i, 33) * 1.0 });
        }
        addCollider(tx - 0.7, tx + 0.7, tz - 0.7, tz + 0.7, y, y + 8);
      }
      if (!instances) break;
      // The cell's own coordinates already use all three of hash3's slots, so
      // here the fourth varies per draw; the families are spaced to keep clear
      // of each other.
      scatterUndergrowth({
        instances, chunk, x, y, z,
        rand: (i, k, salt) => hash3(x, z, i, salt + k),
        kinds: [
          { name: model(['fern'], 0), count: 3 + Math.floor(hash3(x, z, 0, 144) * 3), ring: 4.2, spread: 4.0, size: 1.0, salt: 140 },
          { name: model(['salal_bush'], 0), count: 1 + Math.floor(hash3(x, z, 0, 154) * 3), ring: 4.6, spread: 3.6, size: 1.0, salt: 150 },
        ],
      });
      // A boulder in a third of the cells. Nothing walls this cell off -- only
      // its trunks have colliders -- so the rock gets one too.
      const rock = hash3(x, z, 0, 160) < 1 / 3 ? model(['moss_rock'], 0) : null;
      if (rock) {
        const rx = x + (hash3(x, z, 1, 160) - 0.5) * CELL * 0.7;
        const rz = z + (hash3(x, z, 2, 160) - 0.5) * CELL * 0.7;
        const scale = 0.9 + hash3(x, z, 3, 160) * 0.6;
        instances.add(rock, { x: rx, y, z: rz, rotY: hash3(x, z, 4, 160) * Math.PI * 2, scale }, chunk);
        addStoneCollider({ instances, name: rock, x: rx, y, z: rz, scale, addCollider });
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
      // FIELD lands here, and a 2.2 m block of rock is not what borders the
      // Shire's grassy fields. Left flat -- `GROUND` has already laid grass --
      // with hedge and a tree on it. Nothing gets a mound: undergrowth is
      // scattered on a ring at one height, and on a dome that is one height the
      // surface never has, so every bush would float or be buried.
      if (shire) {
        if (hash3(x, z, 0, 30) > 0.55) {
          const tx = x + (hash3(x, z, 0, 31) - 0.5) * CELL * 0.5;
          const tz = z + (hash3(x, z, 1, 31) - 0.5) * CELL * 0.5;
          decor.push({ kind: 'tree', x: tx, y, z: tz, scale: 0.9 + hash3(x, z, 2, 31) * 0.5 });
          addCollider(tx - 0.7, tx + 0.7, tz - 0.7, tz + 0.7, y, y + 8);
        }
        if (!instances) break;
        scatterUndergrowth({
          instances, chunk, x, y, z,
          rand: (i, k, salt) => hash3(x, z, i, salt + k),
          kinds: [
            { name: model(['bush'], 0), count: 2 + Math.floor(hash3(x, z, 0, 32) * 3), ring: 4.6, spread: 3.4, size: 0.95, salt: 33 },
            { name: model(['grass_tuft'], 0), count: 6 + Math.floor(hash3(x, z, 0, 34) * 5), ring: 4.4, spread: 4.2, size: 1.0, salt: 35 },
          ],
        });
        break;
      }
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

// -------------------------------------------------------------- horizon ----

// Constant, so the same town gets the same skyline every load. A horizon that
// reshuffles on reload is a screensaver, not a place.
const HORIZON_SEED = 20931;

/**
 * The skyline: two rings of conifers with a ridge behind them.
 *
 * The ground runs 60 cells past the town and then meets the sky along a dead
 * flat line -- green felt at noon, orange at dusk -- and that line is the one
 * thing in frame that says this is a plane with a town drawn on it. What fixes
 * it is not detail. The reference look (Stargate's British Columbia exteriors)
 * is two tones at this range: a near-black comb of conifers against a bright
 * sky, and a ridge dissolving into haze behind it. So this is flat triangles,
 * one colour each, no texture and no light of its own. At 120 m through fog a
 * texture is invisible; silhouette and tone are the entire job, and nothing
 * here has to be lit, shadowed or updated.
 *
 * **The fog does the aerial perspective, and it squares.** `FogExp2` keeps
 * `exp(-(density * depth)^2)` of a surface, not `exp(-density * depth)` -- a
 * far shorter world than it sounds, half of any surface gone by 138 m at the
 * noon density of 0.0060. Measured from the near edge of the town, which is
 * where the horizon is visible at all (stand in the middle of it and you are
 * looking at frontage), a ring keeps:
 *
 *     margin    noon .0060   dusk .0088   night .024
 *     120 m       59.6%        32.8%        0.02%
 *     165 m       37.5%        12.1%        0.00%
 *     250 m       10.5%         0.8%        0.00%
 *     380 m        0.6%         0.0%        0.00%
 *
 * That is the whole reason for +120, +165 and +250 m: three planes of depth
 * out of three flat colours, and a horizon that puts itself away after dark
 * without being told. The ridge is at +250 and not the +380 that would be
 * right under unsquared fog, because 380 m keeps 0.6% -- not a tonal shape,
 * nothing at all. Nor can the rings come closer: they have to clear everything
 * built, and the town's own radius is already 213 m at Midgaard, so from the
 * bounds centre the inner ring is 333 m off and keeps 1.8%. The treeline is
 * for the streets that can see out; in the middle of town the buildings are
 * the horizon.
 */
function buildHorizon(group, bounds, groundY) {
  const cx = ((bounds.minX + bounds.maxX) / 2) * CELL;
  const cz = ((bounds.minZ + bounds.maxZ) / 2) * CELL;
  const town = Math.hypot((bounds.maxX - bounds.minX) * CELL, (bounds.maxZ - bounds.minZ) * CELL) / 2;

  // `hash3` is the file's generator and there is no reason for a second one; a
  // ring wants a stream, so run it over a counter. Measured over 20k draws:
  // every tenth of the range within 3.6% of flat, lag-1 to lag-3 correlation
  // under 0.01.
  let draw = 0;
  const rng = () => hash3(draw++, 0, 0, HORIZON_SEED);
  const rnd = (lo, hi) => lo + rng() * (hi - lo);

  // Unlit, and dark. A lit material was tried first -- up-normals handing the
  // silhouettes the same sun and sky the field gets -- and at noon that made
  // the treeline *lighter* than the sky behind it: a row of pale ghosts,
  // exactly backwards from the reference. A conifer wall reflects almost
  // nothing and reads near-black against any daylit sky, so flat unlit colour
  // is the honest model: the fog supplies the aerial perspective and the
  // per-hour tint, and exposure keeps it in step with the hour.
  // Vertex colours carry the variation: seen with a clear sky from the town's
  // edge -- the park, the levee -- a single flat tone read as one continuous
  // grey dam, and repetition the eye forgives in a texture it does not
  // forgive in a skyline. One factor per tree and a slow wave along the
  // ridge break it for free; the material stays unlit.
  const conifer = new THREE.MeshBasicMaterial({
    color: 0x141a14, side: THREE.DoubleSide, vertexColors: true,
  });
  // Colder and bluer than the trees, so the ridge reads as a further plane
  // before the fog has said anything about it.
  const rock = new THREE.MeshBasicMaterial({
    color: 0x10151d, side: THREE.DoubleSide, vertexColors: true,
  });

  const silhouette = (points, colors, material, name) => {
    const position = new Float32Array(points);
    // The unlit material never reads these, but the AO prepass renders the
    // scene with a normal material, and a missing attribute there is a
    // garbage buffer, not a default. Straight up is the cheapest true thing
    // to say.
    const normal = new Float32Array(position.length);
    for (let i = 1; i < normal.length; i += 3) normal[i] = 1;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    // The sun's shadow camera is 260 m of span following the player. Nothing
    // out here may enter that pass, casting or receiving.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // A 360-degree ring is always partly in view, so the test only ever
    // answers yes.
    mesh.frustumCulled = false;
    group.add(mesh);
  };

  const rings = [
    { r: town + 120, low: 14, high: 30 },
    { r: town + 165, low: 18, high: 38 },
  ];
  rings.forEach((ring, index) => {
    const points = [];
    const colors = [];
    const span = 2 * Math.PI * ring.r;
    for (let arc = 0; arc < span; arc += rnd(6, 10)) {
      const a = arc / ring.r;
      const radius = ring.r + rnd(-12, 12);
      const px = cx + Math.cos(a) * radius;
      const pz = cz + Math.sin(a) * radius;
      // The ring's tangent, which seen from the town is also screen right --
      // that is what puts the front face inwards below.
      const tx = -Math.sin(a); const tz = Math.cos(a);
      const h = rnd(ring.low, ring.high);
      const w = h * rnd(0.32, 0.5);
      // Apex off centre, or the whole ring is a metronome.
      const lean = h * rnd(-0.06, 0.06);
      // One tone per tree: brightness spread wide, hue nudged so a few read
      // browner (dead tops) and a few bluer, the way a real stand mixes.
      const tone = rnd(0.68, 1.3);
      const hue = rnd(0.9, 1.1);
      const blade = (from, to, apex, top) => {
        // Wound so the side facing the town is the front face: three flips a
        // back face's normal, and these normals are all up, so the back of one
        // of these would be lit from underneath.
        points.push(px + tx * from, groundY, pz + tz * from);
        points.push(px + tx * to, groundY, pz + tz * to);
        points.push(px + tx * apex, groundY + top, pz + tz * apex);
        for (let k = 0; k < 3; k++) colors.push(tone * hue, tone, tone * (2 - hue));
      };
      blade(-w / 2, w / 2, lean, h);
      if (rng() < 1 / 6) {
        // A ragged lower tier on a minority of them. It has to *overhang*: a
        // narrower triangle on the same centre line, half as tall, lies
        // entirely inside the cone it is meant to break and draws nothing at
        // all. So it is narrow and pushed out to one side, which is also what
        // makes a spruce read as a spruce rather than a traffic cone.
        const off = (rng() < 0.5 ? -1 : 1) * w * rnd(0.28, 0.42);
        const half = w * rnd(0.26, 0.34);
        blade(off - half, off + half, off, h * rnd(0.4, 0.58));
      }
    }
    silhouette(points, colors, conifer, `horizon-trees-${index}`);
  });

  // The ridge: one strip ring, ground to crest.
  const SEG = 256;
  // Whole cycles per turn, because the ring has to close. A frequency that is
  // not an integer leaves crest(2pi) != crest(0), which is a vertical cliff in
  // the skyline at one bearing -- the seam is worse than the repetition it was
  // meant to avoid. 3, 7 and 11 are coprime, so nothing repeats inside a turn.
  const waves = [[3, 11], [7, 6], [11, 3]].map(([f, amp]) => ({ f, amp, phase: rng() * Math.PI * 2 }));
  const crest = (a) => waves.reduce((sum, w) => sum + w.amp * Math.sin(w.f * a + w.phase), 65);
  const ridgeR = town + 250;
  // Tone drifts along the ridge the same way the crest does -- coprime whole
  // cycles, so it closes -- and the crest sits a shade lighter than the foot,
  // which is what haze does to a far slope. Without this the ridge was one
  // continuous grey band and read as a dam, not a range.
  const toneWaves = [[2, 0.06], [5, 0.05], [13, 0.03]].map(([f, amp]) => ({ f, amp, phase: rng() * Math.PI * 2 }));
  const ridgeTone = (a) => toneWaves.reduce((sum, w) => sum + w.amp * Math.sin(w.f * a + w.phase), 1);
  const ridge = [];
  const ridgeColors = [];
  const push = (x, y, z, a, top) => {
    ridge.push(x, y, z);
    const t = ridgeTone(a) * (top ? 1.14 : 0.92);
    ridgeColors.push(t, t, t * 1.04);
  };
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2; const a1 = ((i + 1) / SEG) * Math.PI * 2;
    const x0 = cx + Math.cos(a0) * ridgeR; const z0 = cz + Math.sin(a0) * ridgeR;
    const x1 = cx + Math.cos(a1) * ridgeR; const z1 = cz + Math.sin(a1) * ridgeR;
    const top0 = groundY + crest(a0); const top1 = groundY + crest(a1);
    push(x0, groundY, z0, a0, false); push(x1, groundY, z1, a1, false); push(x1, top1, z1, a1, true);
    push(x0, groundY, z0, a0, false); push(x1, top1, z1, a1, true); push(x0, top0, z0, a0, true);
  }
  silhouette(ridge, ridgeColors, rock, 'horizon-ridge');
}
