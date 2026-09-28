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
import { InstanceBatch, StaticBatches } from './assets.js';
import { OVERLAY_LAYER } from './render.js';
import { buildGrass } from './grass.js';
import { classifyShells, shellFor } from './shells.js';
import { placeClutter } from './clutter.js';

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
/**
 * A room that says it is *outside* one is not inside one. "Outside a cave in
 * the deep, dark forest" is the mouth of the Green Dragon's cave -- a path end
 * under the same crowns as the forty-four rooms around it, with the cave
 * itself the room to the north -- and `cave` in its own name was building it a
 * brick box with a plank ceiling 5.2 m over the middle of a wood.
 *
 * Checked over all 45 stock areas, which is the only way to ship a word here:
 * of the 45 FOREST+INDOORS rooms `CANOPY_NOT` currently calls interiors --
 * Moria's thirty-odd tunnels, the spider web, the Green Dragon's cave itself,
 * the great tree, the cultist temple -- exactly one says `outside`, and it is
 * #6142. `entrance to` and `before` were tried alongside it and dropped:
 * across the world they take "Entrance to the Crypt", "Entrance to the High
 * Tower" and "Standing before the throne", all of them genuinely indoors.
 */
const CANOPY_OUTSIDE = /\boutside\b/i;
// Not the sewer. Twenty-six of its drains are sectored FOREST -- "The sewer
// drain.", "The strange sewer" -- and every one carries ROOM_INDOORS, so the
// canopy test took them for Haon Dor and planted firs seven metres under the
// Dump.
const isCanopy = (room) => room.sector === SECTOR.FOREST && !isOutdoor(room) && !isDeep(room)
  && (CANOPY_OUTSIDE.test(room.name) || !CANOPY_NOT.test(room.name));

/** No walls, no ceiling, no roof -- whatever the mud says about the sky. */
// "Strange Glowing Sand" is INDOORS by its flags and "a vast desert" by its
// words; the words win, as they do for the canopy.
// The neighborhood's courtyards likewise: INDOORS, and "once it was the
// courtyard of a beautiful building complex ... the plants all died".
const isOpenAir = (room) => isOutdoor(room) || isCanopy(room)
  || (!!eastStyle(room) && eastStyle(room) !== 'cave') || hoodStyle(room) === 'court';

/**
 * An exit to room -1 is the stock files' way of writing "nothing": four of
 * them in the sewer, "There WAS an exit down". It is not a gate out of the
 * loaded world, and a portcullis signed "#-1 -- outside the loaded world"
 * standing in a wall says it is.
 */
const deadExit = (exit) => !!exit && exit.to < 0;

/** One definition, because the alley between two of them needs the same answer. */
const isWater = (room) => room.sector === SECTOR.WATER_SWIM || room.sector === SECTOR.WATER_NOSWIM;

/**
 * How far a water surface lies above the bed it is laid on.
 *
 * It was 0.7, which is not a water level. Every floor in the world -- a room's,
 * a routed alley's, a cell built on -- tops out at its own level's y, so a lake
 * stood 0.70 m proud of its own bed, and where the cell beside it was a filler
 * with no floor of its own it stood 1.17 m proud of the world's ground plane.
 * Measured at the marsh lake (#8315/#8316): plates at y=0.70, every platform
 * around them at 0.00, the ground plane at -0.47. What that reads as is a
 * translucent blue slab on a plinth with a razor-straight edge -- a swimming
 * pool dropped on a lawn, which is what a judge photographed.
 *
 * Standing water sits *on* the ground. `POOL_LIFT` already puts the bog pools
 * 3 cm over their peat; this is a little more only because these are 13 m
 * planes rather than 2 m discs and have further to go before they z-fight.
 */
const WATER_LIFT = 0.06;
/**
 * How far a water plane runs past its own cell. Sheets laid exactly cell-sized
 * abut on a shared edge, and two of the same shader a pixel out of step with
 * each other draw a line along it -- the mosaic seam a judge read across the
 * marsh lake. Overlapping costs nothing: they are at the same height and are
 * the same surface.
 */
const WATER_LAP = 0.7;

/**
 * Cut into the ground: a cave-material room on a level below zero.
 *
 * Two world-wide defects hang off this one predicate. A room's floor stops at
 * its own wall line (ROOM/2 = 5 m) while the passage routed away from it starts
 * at the next cell boundary (HALF = 6.5 m), so every doorway spans 1.5 m of no
 * floor -- above ground the world's ground plane lies 0.47 m below and fills
 * it, and below ground there is nothing there at all. And a room with earth on
 * every side has no outside to put a window in.
 *
 * Both were found in the Shire's burrows and were keyed to the Shire. The
 * graveyard's thirteen tombs are the same thing -- level -1, cave material --
 * and were being given casements with lit panes two metres under a graveyard.
 * Measured over the loaded world: 23 rooms are buried, 13 of them carried
 * windows and all 13 were the tombs. None of the 13 has a doorway (their only
 * way out is the stair up), so the floor half is a no-op for them; it is still
 * written here because the rule is about being underground, not about the
 * Shire, and the next buried area with a door should not have to find it again.
 */
/** Outer skins a window is dressed in stone for, rather than framed in oak. */
const MASONRY = new Set(['stonewall', 'sootwall', 'brick', 'marble', 'crag', 'cliff', 'rock', 'caverock']);

const isBuried = (mats, cell) => mats.cave && (cell.level < 0 || !!mats.inRock);

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
 * so "Swamp's Edge" is still a swamp. Over the default six areas that is still
 * 10 rooms, all in the marsh, and none at all in Midgaard, the Shire, Haon Dor,
 * the Troll Den or the graveyard; over all 45 it adds only Mahn-Tor's swampy
 * paths, which are swampy paths. `pond` and `murky` were tried and dropped --
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

/**
 * Rock somebody lives in, as against a crypt somebody built. The `cave` test
 * in `pickMaterials` takes both, and handed both the same `rock` -- a 70 cm
 * crazy paving that came out on the troll den's floor, walls and ceiling
 * alike. Over the 45 stock areas this names the troll den's five rooms,
 * seven caverns in the catacombs, three dens and one in Moria; the tombs,
 * crypts and catacomb passages stay dressed stone.
 */
const ROCK_CAVE = /\b(den|caverns?|grotto)\b|moria/;

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

// ------------------------------------------------------------- the sewer ----

/**
 * Midgaard's sewer, keyed by area like the Shire and for the same reason: it is
 * a different kind of place, not a different kind of room. Its sector codes
 * are noise -- the pipes are CITY, MOUNTAIN, FOREST, FIELD and HILLS in no
 * order at all, and 26 of them would otherwise have grown a fir canopy.
 *
 * Inside the area the prose decides, three ways:
 *
 *  - `vault`: the works. "Enormous concrete pipes leading north, south, east
 *    and west", "a huge junction of sewer pipes". A brick groin-vaulted
 *    chamber per room and a barrel-vaulted tunnel with a channel down the
 *    middle for every passage between them -- the `sewer_*` kit.
 *  - `room`: somewhere with a door on it. The lairs, the treasury, the torture
 *    room, the Realm of lost souls: brick-walled rooms in the ordinary walled
 *    builder, because a door leaf wants a 3.2 m doorway and a tunnel mouth is
 *    4.4 m of arch.
 *  - `cave`: what the sewer breaks into further down -- the ledges round the
 *    abyss, the stalagmite caves, the basilisk's cave. Bare rock.
 *
 * A room that says none of it takes whatever its neighbours mostly are, so
 * "The hot room" in the middle of the stalagmite caves is a cave and "The
 * small room" off a pipe junction is a vault.
 */
const isSewer = (room) => room.areaFile === 'sewer.are';
const SEWER_WORKS = /\b(sewers?|pipes?|drains?|drainpipe|junction|well|shaft|pit)\b/i;
const SEWER_CHAMBERED = /\b(lair|treasury|realm|torture ?room|corridor|t-crossing|firedeath)\b/i;
const SEWER_CAVE = /\b(caves?|cavern|stalag\w*|ledge|abyss|fissure|edge of the water|mid-air|spongy|crawlway|crack|tunnel|pool)\b/i;
const sewerStyles = new WeakMap();

function classifySewer(world) {
  const pending = [];
  for (const room of world.rooms.values()) {
    if (!isSewer(room)) continue;
    let style = null;
    // A door makes a room; then the cave words, in the name or the prose --
    // "The rat's lair" is "a little cave" -- and only then a chambered name.
    if (SEWER_WORKS.test(room.name)) style = 'vault';
    else if (room.exits.some((e) => e && (e.locks & EX_ISDOOR))) style = 'room';
    else if (SEWER_CAVE.test(room.name) || /\b(caves?|stalag\w*)\b/i.test(room.description)) style = 'cave';
    else if (SEWER_CHAMBERED.test(room.name)) style = 'room';
    if (style) sewerStyles.set(room, style);
    else pending.push(room);
  }
  // Three sweeps is enough for the longest run of wordless rooms in the area.
  for (let sweep = 0; sweep < 3 && pending.length; sweep++) {
    for (const room of pending) {
      const votes = { vault: 0, room: 0, cave: 0 };
      for (const exit of room.exits) {
        const next = exit && world.rooms.get(exit.to);
        const style = next && sewerStyles.get(next);
        if (style) votes[style]++;
      }
      const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
      if (best[1] > 0) sewerStyles.set(room, best[0]);
    }
  }
  for (const room of pending) if (!sewerStyles.has(room)) sewerStyles.set(room, 'vault');
}
const deepStyle = (room) => (isSewer(room) ? (sewerStyles.get(room) || 'vault')
  : (eastStyle(room) === 'cave' ? 'cave' : null));
const isVault = (room) => deepStyle(room) === 'vault';

// ------------------------------------------------- the Great Eastern Desert ----

/**
 * East of the town the river goes into the mountains through a hole in the
 * wall, and comes out -- past an underground lake, caves, a fungus temple --
 * on the edge of a desert with a nomads' oasis in it. Keyed by area, and then
 * by the rooms' own words, five ways:
 *
 *  - `cave`: everything the mud calls INDOORS that is not a tent. The river's
 *    tunnels, the lake, the caverns: the sewer's cave treatment -- rock lining,
 *    no sky in the lighting -- and, because these are at street level and not
 *    under it, a mountain over them (`buildMassif`).
 *  - `desert`: "A vast desert stretches for miles": sand, and dunes out past
 *    the rooms (`buildSandSea`).
 *  - `camp`: the oasis -- "this small group of desert nomads has stopped ...
 *    beside this beautiful oasis" -- palms, water, the tents seen from outside.
 *  - `tent`: "Inside a small tent", "The main tent": a room whose walls and
 *    roof are cloth.
 *  - `ledge`: "the wind-swept ledge ... this canyon is about a half a kilometer
 *    deep": rock underfoot at the edge of a drop.
 */
const isEastern = (room) => room.areaFile === 'eastern.are';
const EAST_TENT = /\btents?\b/i;
const EAST_CAMP = /\b(camp|camels?|oasis)\b/i;
const EAST_LEDGE = /\bledge\b/i;
const eastStyle = (room) => {
  if (!isEastern(room)) return null;
  if (EAST_TENT.test(room.name)) return 'tent';
  if (EAST_CAMP.test(room.name)) return 'camp';
  if (EAST_LEDGE.test(room.name)) return 'ledge';
  if (room.sector === SECTOR.DESERT || /\bsand\b/i.test(room.name)) return 'desert';
  if (room.flags & ROOM_INDOORS) return 'cave';
  return 'desert';
};

/** Anywhere that lights itself and dresses itself from its prose, with no sky in it. */
const isDeep = (room) => isSewer(room) || eastStyle(room) === 'cave';
/** What stands in the water of a deep room: the sewer's own, or a cave's lime-water. */
const deepWater = (room) => (isSewer(room) ? 'sewage' : 'cavewater');

/** "You are standing in mud to your knees", "something like porridge". */
const SEWER_MUD = /\b(mud|muddy|mudhole|sludge|porridge)\b/i;
/** "The water you're in up to your hips", "you stand in water to your waist". */
const SEWER_FLOOD = /\b(watery|under water|water to your|water you're in|in water|floor is completely covered with water|covered with yucky water)\b/i;
const sewerMud = (room) => SEWER_MUD.test(`${room.name} ${room.description}`) && !SEWER_FLOOD.test(`${room.name} ${room.description}`);
const sewerFlood = (room) => SEWER_FLOOD.test(`${room.name} ${room.description}`);

// The kit's section, in the numbers tools/blender/sewer.py builds it to.
const SW_A = 2.2;          // half the tunnel's clear width
const SW_WALL = 0.3;       // how thick the colliders behind a tunnel wall are
const SW_CH = 0.65;        // half the channel
const SW_INVERT = -0.32;   // the channel's floor
const SW_CA = 4.5;         // half a chamber's clear span
const SW_CT = 0.4;         // a chamber wall
const SW_MUD = 0.07;       // mud lies over the kerbs, which stand 0.025 proud
const SW_FLOOD = 0.34;     // water over the walkway: wading, not swimming

export function hash3(a, b, c, salt = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647) ^ Math.imul(salt, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

// ------------------------------------------------------------- batching ----

const _matrix = new THREE.Matrix4();
const IDENTITY = new THREE.Matrix4();
const WHITE = [1, 1, 1];

class Batcher {
  constructor(materials) {
    this.materials = materials;
    this.groups = new Map();
    // Whether what is being added right now is inside an enclosed room. Set
    // once per cell rather than passed through a dozen builders; see the note
    // on `indoorBounce` in textures.js for what reads it.
    this.indoor = false;
  }

  /**
   * Transform a geometry into world space, project world-space UVs onto it,
   * paint vertex colours, and file it under (chunk, material).
   */
  add(geometry, materialName, matrix, options = {}) {
    const material = this.materials[materialName];
    if (!material) throw new Error(`build: unknown material ${materialName}`);
    const {
      tint = null, ao = null, chunk = '0', uvScale = null, indoor = this.indoor, normals = false, keepUv = false,
    } = options;

    const geo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geo.applyMatrix4(matrix);
    // `normals` keeps the ones a curved surface came with; recomputed on a
    // non-indexed geometry they are one per face, and a vault turns faceted.
    if (!normals) geo.computeVertexNormals();

    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const scale = uvScale ?? material.userData.uvScale;
    // `keepUv`: a surface laid round a curve -- a log's bark -- brings UVs of
    // its own, already in the material's tile.
    const given = keepUv ? geo.attributes.uv : null;
    const uv = new Float32Array(pos.count * 2);
    const col = new Float32Array(pos.count * 3);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
      const nx = Math.abs(nor.getX(i)); const ny = Math.abs(nor.getY(i)); const nz = Math.abs(nor.getZ(i));
      // Project from whichever axis the face points along: no UV bookkeeping,
      // and textures stay continuous where surfaces meet.
      if (given) { uv[i * 2] = given.getX(i); uv[i * 2 + 1] = given.getY(i); }
      else if (ny >= nx && ny >= nz) { uv[i * 2] = x * scale; uv[i * 2 + 1] = z * scale; }
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
    // Written on every batched geometry, not only the indoor ones: mergeGeometries
    // needs the same attribute set on all of them.
    const inside = new Float32Array(pos.count);
    if (indoor) inside.fill(1);
    geo.setAttribute('aIndoor', new THREE.BufferAttribute(inside, 1));
    for (const name of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'uv', 'color', 'aIndoor'].includes(name)) geo.deleteAttribute(name);
    }

    const key = `${chunk}|${materialName}`;
    let bucket = this.groups.get(key);
    if (!bucket) { bucket = { materialName, list: [] }; this.groups.set(key, bucket); }
    bucket.list.push(geo);
  }

  /** Each chunk's merged geometry goes into `batches` under the chunk's region. */
  finish(batches, regionOf) {
    let triangles = 0;
    for (const [key, { materialName, list }] of this.groups) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) throw new Error(`build: could not merge ${materialName}`);
      triangles += merged.attributes.position.count / 3;
      batches.addStatic(regionOf(key.slice(0, key.lastIndexOf('|'))), this.materials[materialName], merged);
      for (const geo of list) geo.dispose();
    }
    return { triangles };
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

/**
 * A rectangle less some holes, as rectangles: cut into strips at every hole
 * edge along x, then each strip into the runs of z no hole covers.
 */
function rectsAround(outer, holes) {
  const inside = holes.filter((h) => h.x1 > outer.x0 && h.x0 < outer.x1 && h.z1 > outer.z0 && h.z0 < outer.z1);
  if (!inside.length) return [outer];
  const xs = [...new Set([outer.x0, outer.x1, ...inside.flatMap((h) => [h.x0, h.x1])])]
    .filter((x) => x >= outer.x0 && x <= outer.x1).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i]; const x1 = xs[i + 1];
    if (x1 - x0 < 1e-6) continue;
    const cut = inside.filter((h) => h.x0 < x1 - 1e-6 && h.x1 > x0 + 1e-6)
      .map((h) => [Math.max(outer.z0, h.z0), Math.min(outer.z1, h.z1)]).sort((a, b) => a[0] - b[0]);
    let z = outer.z0;
    for (const [c0, c1] of cut) {
      if (c0 > z + 1e-6) out.push({ x0, x1, z0: z, z1: c0 });
      z = Math.max(z, c1);
    }
    if (outer.z1 > z + 1e-6) out.push({ x0, x1, z0: z, z1: outer.z1 });
  }
  return out;
}

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
    case SECTOR.FIELD: case SECTOR.HILLS: floor = 'grass'; break;
    // Not grass. Under a closed conifer canopy almost nothing reaches the
    // ground, so what is down there is two or three years of needles over
    // humus -- and because this is asked for the routed cells too, the litter
    // runs between the rooms as well as through them.
    case SECTOR.FOREST: floor = 'duff'; break;
    case SECTOR.MOUNTAIN: floor = 'rock'; break;
    case SECTOR.DESERT: floor = 'sand'; break;
    case SECTOR.WATER_SWIM: case SECTOR.WATER_NOSWIM: floor = 'water'; break;
    case SECTOR.AIR: floor = 'cloud'; break;
    default: break;
  }
  // "The dump, where the people from the city drop their garbage." Not a lawn.
  if (REFUSE.test(room.name)) floor = 'dirt';
  // The desert and the oasis are sand whatever the sector says -- the camp is
  // FIELD, which is grass -- and the ledge over the canyon is the canyon's rock.
  const east = eastStyle(room);
  if (east === 'desert' || east === 'camp' || east === 'tent') floor = 'sand';
  else if (east === 'ledge') floor = 'cliff';
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
      if (smial) {
        wallOut = 'grass'; wallUv = TURF_UV;
        // Inside, it is a home and not a hole: "the proper dwelling place for
        // halflings". Plaster on the curve and boards underfoot; the bare
        // earth is for the tunnels between them. See `buildSmialVault`.
        floor = 'planks'; wallIn = 'plaster'; ceil = 'plaster';
      }
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

  // The sewer overrules the sector here and not at the call site, for the same
  // reason the bog does: the passage routed between two drains asks this
  // function what it is built of. `cave` stays set on all three styles, which
  // is what keeps them buried -- no windows, no roof, no masonry kit.
  const style = deepStyle(room);
  // Under a mountain rather than under the street: buried all the same.
  const inRock = style === 'cave' && isEastern(room);
  if (style) {
    cave = true;
    if (style === 'cave') {
      floor = 'cavefloor'; wallIn = 'caverock'; wallOut = 'caverock'; ceil = 'caverock';
      // A cave at street level has an outside, and the sky lights it.
      if (inRock) wallOut = 'cliff';
    }
    else { floor = 'sewerflag'; wallIn = 'brick'; wallOut = 'brick'; ceil = 'brick'; }
    if (style !== 'vault' && sewerMud(room)) floor = 'sludge';
  }

  // A cave above ground is a hill with a hole in it, not a rock box with a
  // tiled roof and lit windows, which is how the troll den stood in the
  // forest: `inRock` buries it (no roof, no windows) and `buildMassif` heaps
  // crag over it. Outside it is `crag`, the same rock lit by the sky.
  // What the room's words say it is built as (src/shells.js). Asked only of a
  // room with walls: a passage routed out of it asks this function too, and
  // gets the shell's floor, which is the floor that runs out of its door.
  const shell = isOpenAir(room) ? null : shellFor(room);
  // "You are in a natural cave": the words, where the name alone missed it --
  // Haon Dor's "Inside the cave" was the stone kit with a timber window in it.
  if (shell && shell.kind === 'cave' && !style) cave = true;
  const rockCave = cave && !style && !burrow && !holy && (ROCK_CAVE.test(name) || (shell && shell.kind === 'cave'));
  if (rockCave) { floor = 'cavefloor'; wallIn = 'caverock'; wallOut = 'crag'; ceil = 'caverock'; }

  // What the Shire builds when it does not dig: timber and plaster, and a
  // barn is boarded. Chosen here, for every room in the area, because the
  // alternative was the town's masonry kit on all of them -- the Green Dragon
  // was a stone hall with a blue flagged floor and the barn cut brick with a
  // torch beside the hay.
  let shire = null;
  if (isShire(room) && !burrow && !isOpenAir(room)) {
    shire = FARMYARD.test(room.name) ? 'barn' : 'timber';
    if (shire === 'barn') { floor = 'dirt'; wallIn = 'boards'; wallOut = 'boards'; ceil = 'planks'; roof = 'thatch'; }
    else { floor = 'planks'; wallIn = 'plaster'; wallOut = 'plaster'; ceil = 'planks'; }
  }

  // The rest of the shells, after the area's own rules so they overrule them,
  // and before the neighborhood's, which is a different town.
  const kind = shell && shell.kind;
  let wallInTint = null;
  // Underground the sewer's own lighting has to reach the surface, so a shell
  // there takes the `buried` recipes; up in the town the daylit ones.
  const deep = !!style;
  if (kind === 'tomb') {
    // Dressed stone, not the crazy paving `cave` handed every tomb.
    cave = true;
    floor = 'sewerflag'; wallIn = 'ashlar'; wallOut = 'ashlar'; ceil = 'ashlar';
  } else if (kind === 'lair') {
    floor = 'emberstone'; wallIn = 'scorched'; ceil = 'scorched';
    if (!deep) wallOut = 'sootwall';
  } else if (kind === 'dungeon') {
    if (deep) { floor = 'sewerflag'; wallIn = 'ashlar'; ceil = 'ashlar'; } else { floor = 'flagstone'; wallIn = 'stonewall'; ceil = 'stonewall'; }
    wallOut = deep ? wallOut : 'stonewall';
    // "Dark stone walls, hard and cold to the touch": the same stone, damp.
    wallInTint = [0.66, 0.68, 0.7];
  } else if (kind === 'vault') {
    floor = 'flagstone'; wallIn = 'stonewall'; ceil = 'stonewall'; wallOut = 'stonewall';
  } else if (kind === 'log') {
    // The logs are built in front of both skins (`buildLogWalls`); what shows
    // between them is the chinking, lime daub, on either face.
    floor = 'planks'; wallIn = 'plaster'; wallOut = 'plaster'; ceil = 'planks'; roof = 'boards';
  } else if (kind === 'panelled') {
    floor = 'planks'; wallIn = 'plaster'; ceil = 'planks';
  } else if (kind === 'farmhouse' && shire === 'timber') {
    // A farmer's house is built of what is in his fields: rough stone, a
    // flagged floor you can bring a boot into, thatch.
    floor = 'flagstone'; wallIn = 'stonewall'; wallOut = 'stonewall'; roof = 'thatch';
  } else if (kind === 'smial' && isShire(room)) {
    smial = true; burrow = true; cave = true; shire = null;
    floor = 'planks'; wallIn = 'plaster'; ceil = 'plaster'; wallOut = 'grass'; wallUv = TURF_UV; roof = 'grass';
  }

  if (!holy && !cave && !wood && !shire && !kind && hash3(room.vnum, 0, 0, 9) > 0.6) wallOut = 'timber';
  if (!holy && !burrow && hash3(room.vnum, 1, 0, 3) > 0.84) roof = 'thatch';

  // The neighborhood, after everything else, because it overrules the sector
  // (No Man's Land is HILLS, which is grass) and the passage routed out of one
  // of its streets asks here what it is paved with.
  const hood = hoodStyle(room);
  if (hood === 'ruin') { floor = 'ash'; wallIn = 'sootwall'; wallOut = 'sootwall'; ceil = 'charred'; }
  else if (hood === 'lot' || hood === 'plaza') floor = 'wasteground';
  else if (hood === 'park') floor = 'grass';
  else if (hood === 'court') floor = 'flagstone';
  else if (hood === 'street' || hood === 'nml' || hood === 'wall') floor = 'brokencobble';
  if (hood && hood !== 'ruin' && !holy && !wood) wallOut = 'sootwall';
  return {
    floor, wallIn, wallOut, roof, ceil, holy, cave, smial, wallUv, sewer: style, inRock: inRock || rockCave, hood,
    rockCave, shire, shell, wallInTint,
  };
}

// ---------------------------------------------- the Dangerous Neighborhood ----

/**
 * Raff's neighborhood, keyed by area like the Shire and the sewer, because it
 * is a different kind of place rather than a different kind of room: the same
 * town, gone bad. Inside the area the prose decides, room by room -- "All the
 * shops and homes have been boarded up and abandoned", "Everywhere you look
 * you see signs of recent violence. Patches of blood lie everywhere", "The
 * remains of the magic shop", "This is the section of town between the two
 * gang's territories. This is usually where the violence starts."
 *
 *  - `nml`: No Man's Land. Its ten rooms are sectored HILLS, which built them
 *    grass ridges and rock kerbs; they are a burnt-out strip of town, open
 *    and wider than a street, rubble and barricades at both ends.
 *  - `ruin`: "The remains of", "What is left of", "what USED to be the
 *    armory". Walled, but the roof and the floors above are gone: the ruin_
 *    kit from tools/blender/hood.py, ash underfoot, the sky over it.
 *  - `court`: the courtyards, flagged INDOORS and described as open ground
 *    with the plants dead in them. The words win, as they do for the desert.
 *  - `lot`, `plaza`, `park`: the over-grown lot, Dracolich Plaza, Khan Park.
 *  - `lair`: the warehouse the gang leader runs things from, and the chapel.
 *  - `wall`: Wall Road, "along the inside of the wall surrounding the city".
 *  - `street` and `room` for the rest.
 *
 * Which gang's ground a room is on is read off the map rather than the
 * resets: the mud loads its ogre gang members in the north and its trolls in
 * the south, while its prose says the opposite -- "Yellow Dragon Road is the
 * southern boundary of Troll Territory. You enter no-man's land to the south",
 * "now entering Ogre territory" in the southern alley, "deep within Ogre gang
 * territory" on Achilles Avenue. The prose is what the gangs paint on their
 * walls, so north of No Man's Land is the Trolls' -- the Dragon gang, whose
 * idol is the Dracolich and whose streets are named for dragons -- and south
 * of it the Ogres'.
 */
const isHood = (room) => room.areaFile === 'hood.are';
const HOOD_NML = /\bno man'?s land\b/i;
const HOOD_RUIN = /\b(remains of|what is left of|used to be the)\b/i;
const HOOD_COURT = /\bcourtyard\b/i;
const HOOD_PLAZA = /\bplaza\b/i;
const HOOD_LOT = /\bover-?grown\b/i;
const HOOD_LAIR = /\b(warehouse|chapel)\b/i;
const hoodStyle = (room) => {
  if (!isHood(room)) return null;
  const { name } = room;
  if (HOOD_NML.test(name)) return 'nml';
  if ((room.flags & ROOM_INDOORS) && HOOD_RUIN.test(`${name} ${room.description}`)) return 'ruin';
  if (HOOD_COURT.test(name)) return 'court';
  if (HOOD_PLAZA.test(name)) return 'plaza';
  if (isPark(room)) return 'park';
  if (HOOD_LOT.test(name)) return 'lot';
  if (HOOD_LAIR.test(name)) return 'lair';
  if (/^wall road$/i.test(name)) return 'wall';
  return (room.flags & ROOM_INDOORS) ? 'room' : 'street';
};

/** Rooms the prose says have been painted on, and what the gangs paint with. */
const HOOD_GRAFFITI = /\b(graffiti|spray-?painted|vandali[sz]ed|slogans|desecrated)\b/i;
const HOOD_BLOOD = /\bblood\b/i;
/** What is left lying about in a street nobody sweeps. */
// Not the sewer's `rubble`: it wears the underground's materials, which are
// lit for a drain and read as blue glass in the sun.
const HOOD_PROPS = ['debris', 'debris', 'planks_pile', 'cartwheel', 'crate', 'barrel', 'sack', 'broom'];
const HOOD_NML_PROPS = ['debris', 'debris', 'planks_pile', 'cartwheel'];

/**
 * Which gang holds a row of the map: north of No Man's Land the Trolls', south
 * of it the Ogres'. `at(z)` answers for any cell, room or not, so the houses
 * between the streets are painted by the same rule as the streets.
 */
function hoodTurf(layout) {
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const cell of layout.order) {
    if (hoodStyle(cell.room) !== 'nml') continue;
    z0 = Math.min(z0, cell.z);
    z1 = Math.max(z1, cell.z);
  }
  const of = (z) => (z < z0 ? 'troll' : z > z1 ? 'ogre' : 'nml');
  // Four cells is two rooms: the street on No Man's Land and the one behind.
  return (z) => (of(z) !== 'nml' && (of(z - 4) !== of(z) || of(z + 4) !== of(z)) ? `${of(z)}!` : of(z));
}

/**
 * Places to stand a thing in an open-air room: against a side with no way out
 * of it, or in a corner, far enough in to clear the frontage and far enough
 * out to clear the middle, where the player arrives. Each pick is refused if
 * it lands on one already made.
 */
function hoodSpots(room, pos, sides, count, radius, salt, taken = []) {
  const reach = (!isOpenAir(room) ? ROOM / 2 - 0.5 : wantsFrontage(room) ? HALF - FRONTAGE_D : HALF - 0.9) - radius;
  const blank = [0, 1, 2, 3].filter((d) => !sides[d]);
  const out = [];
  for (let i = 0, tries = 0; out.length < count && tries < count * 6; tries++, i++) {
    const r = (k) => hash3(room.vnum, i, k, salt);
    let x; let z; let dir = -1;
    if (blank.length && r(0) < 0.7) {
      dir = blank[Math.floor(r(1) * blank.length)];
      const [dx, , dz] = DIR_STEP[dir];
      const along = (r(2) * 2 - 1) * reach;
      x = pos.x + dx * reach + (dx ? 0 : along);
      z = pos.z + dz * reach + (dz ? 0 : along);
    } else {
      x = pos.x + (r(3) < 0.5 ? -1 : 1) * reach * (0.8 + r(5) * 0.2);
      z = pos.z + (r(4) < 0.5 ? -1 : 1) * reach * (0.8 + r(6) * 0.2);
    }
    if (Math.hypot(x - pos.x, z - pos.z) < radius + 1.6) continue;
    if (taken.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + radius + 0.3)) continue;
    const spot = { x, z, dir, r: radius };
    taken.push(spot);
    out.push(spot);
  }
  return out;
}

/** A modelled prop with a box round it, turned a quarter at a time plus a little. */
function hoodProp({ instances, chunk, addCollider, name, x, y, z, rotY = 0, scale = 1, half = null, height = 1.2 }) {
  if (!instances.add(name, { x, y, z, rotY, scale }, chunk)) return false;
  if (half) {
    const [hx, hz] = Math.abs(Math.sin(rotY)) > 0.7 ? [half[1], half[0]] : half;
    addCollider(x - hx * scale, x + hx * scale, z - hz * scale, z + hz * scale, y, y + height * scale);
  }
  return true;
}

/** A fire in an iron basket, burning day and night where a gang keeps watch. */
function hoodBrazier({ instances, chunk, decor, lights, addCollider, x, y, z }) {
  const top = instances.library.get('brazier')?.bounds?.max.y;
  if (top === undefined || !hoodProp({ instances, chunk, addCollider, name: 'brazier', x, y, z, half: [0.42, 0.42], height: 1.1 })) return;
  decor.push({ kind: 'torch', bare: true, x, y: y + top - 0.12, z });
  lights.push({ x, y: y + top + 0.5, z, color: 0xff8a3a, intensity: 18, radius: 14, flicker: true, outdoor: true });
}

/**
 * Paint on a wall: one of the two gangs' marks, or the other gang's struck
 * through. `n` is the face's outward normal (a unit axis), and the mark is
 * centred on (x, y, z) in that face. `turf` ends in `!` within a few rows of
 * No Man's Land, where the other gang comes across to deface it.
 */
function hoodMark(decals, turf, x, y, z, nx, nz, size, seed) {
  const gang = turf && turf.replace('!', '');
  if (gang !== 'troll' && gang !== 'ogre') return;
  decals.push({ material: gang === 'troll' ? 'decal_troll' : 'decal_ogre', x, y, z, nx, nz, w: size, h: size });
  if (turf.endsWith('!') && seed > 0.4) {
    decals.push({ material: 'decal_strike', x: x + nz * 0.08, y: y + 0.05, z: z - nx * 0.08, nx, nz, w: size * 1.05, h: size * 1.05, lift: 0.02 });
  }
}

/**
 * The frontage of a street in the neighborhood: the same blocks `buildCity
 * Frontage` brings forward everywhere, in sooted stone or old half-timber,
 * every window boarded and no light in any of them, and the gang's mark on
 * the wall. Called for each block with its street face.
 */
function hoodFrontage({ instances, chunk, addCollider, decals, lights, turf, graffiti, room, bx, bz, sx, sz, y0, h, face, seed, feature = null }) {
  if (!instances) return;
  const [nx, , nz] = DIR_STEP[face];
  // The face plane and the run along it.
  const half = (nx ? sz : sx) / 2;
  const fx = bx + nx * (nx ? sx / 2 : 0);
  const fz = bz + nz * (nz ? sz / 2 : 0);
  const tx = nz ? 1 : 0;
  const tz = nx ? 1 : 0;
  // `FACE_ROT` turns a model's -z to a direction; these are built fronting +z
  // like the houses, so half a turn more puts their front on the street.
  const rotY = FACE_ROT[face] + Math.PI;
  const bays = Math.max(1, Math.floor((half * 2) / 3.4));
  const middle = Math.floor(bays / 2);
  let door = hash3(Math.round(bx), Math.round(bz), 3, 911) < 0.4 ? Math.floor(hash3(Math.round(bx), Math.round(bz), 4, 911) * bays) : -1;
  // "The Bakery used to be to the south but the entrance is sealed off."
  if (feature === 'sealed') door = middle;
  // A mark on about half the fronts, on every front where the mud mentions
  // the painting -- on a bay of its own, not across a boarded window.
  let mark = (graffiti || hash3(Math.round(bx), Math.round(bz), 5, 913) < 0.5)
    ? Math.floor(hash3(Math.round(bx), Math.round(bz), 6, 913) * bays) : -1;
  if (mark === door || (feature && mark === middle)) mark = bays > 1 ? (mark + 1) % bays : -1;
  for (let i = 0; i < bays; i++) {
    const a = -half + (half * 2) * (i + 0.5) / bays;
    const x = fx + tx * a;
    const z = fz + tz * a;
    if (i === mark) {
      const size = 1.6 + hash3(Math.round(bx), Math.round(bz), 7, 913) * 0.6;
      hoodMark(decals, turf, x + nx * 0.02, y0 + 1.1 + size / 2, z + nz * 0.02, nx, nz, size, seed);
      if (h > 6.8) instances.add('boarded_window', { x, y: y0 + 3.3, z, rotY }, chunk);
      continue;
    }
    if (feature === 'barred' && i === middle) {
      // "There is a barred window to the north. There appears to be a light
      // coming from the cracks around it." The one lit window on the street.
      instances.add('barred_window', { x, y: y0, z, rotY }, chunk);
      lights.push({ x: x + nx * 0.8, y: y0 + 2.1, z: z + nz * 0.8, color: 0xffb566, intensity: 7, radius: 7, flicker: true, outdoor: true });
    } else {
      instances.add(i === door ? 'boarded_door' : 'boarded_window', { x, y: y0, z, rotY }, chunk);
    }
    if (h > 6.8) instances.add('boarded_window', { x, y: y0 + 3.3, z, rotY }, chunk);
  }
  if (feature === 'shored') {
    // "The building could collapse at any moment": shores against its front.
    // At 0.6 the shores reach 2.3 m out, which is what a 6.6 m lane can give.
    for (const a of [-half * 0.5, half * 0.5]) {
      const x = fx + tx * a; const z = fz + tz * a;
      instances.add('shoring', { x, y: y0, z, rotY, scale: 0.6 }, chunk);
      const ex = x + nx * 2.3; const ez = z + nz * 2.3;
      addCollider(Math.min(x, ex) - tx * 0.3, Math.max(x, ex) + tx * 0.3,
        Math.min(z, ez) - tz * 0.3, Math.max(z, ez) + tz * 0.3, y0, y0 + 2.5);
    }
  }
  void room;
}

/** The frontage a room's own prose points at, by the side it names. */
const HOOD_FRONT = [
  ['barred', /barred window to the (north|south|east|west)/i],
  ['sealed', /the (north|south|east|west)[^.]*?entrance is sealed/i],
  ['sealed', /to the (north|south|east|west) but the entrance is sealed/i],
  ['shored', /could collapse at any moment/i],
  ['marble', /marble facade lies to the (north|south|east|west)/i],
];
function hoodFeatures(room, sides) {
  const out = new Map();
  for (const [kind, re] of HOOD_FRONT) {
    const m = re.exec(room.description.replace(/\s+/g, ' '));
    if (!m) continue;
    const dir = m[1] ? WALL_WORD[m[1].toLowerCase()] : [2, 0, 1, 3].find((d) => !sides[d]);
    if (dir !== undefined && !out.has(dir)) out.set(dir, kind);
  }
  return out;
}

/** "A wrought-iron fence ... the cemetery here to the north": the side it is on. */
const HOOD_FENCE = /(?:cemetery|fence)[^.]*?\bto the (north|south|east|west)\b/i;
const hoodFenceDir = (room) => {
  if (!isHood(room)) return -1;
  const m = HOOD_FENCE.exec(room.description.replace(/\s+/g, ' '));
  return m ? WALL_WORD[m[1].toLowerCase()] : -1;
};

/**
 * Everything a room in the neighborhood has that the prose names, beyond its
 * walls and floor. One function, because each of these is a sentence or two
 * of one room's description and nothing else in the world asks for them.
 */
function buildHoodRoom({ room, pos, sides, instances, model, chunk, decor, lights, addCollider, decals, turf, style }) {
  if (!instances) return;
  const text = `${room.name} ${room.description}`;
  const y = pos.y;
  const taken = [];
  const put = (name, count, radius, salt, opts = {}) => {
    if (!model([name])) return [];
    const spots = hoodSpots(room, pos, sides, count, radius, salt, taken);
    for (const s of spots) {
      const rotY = opts.face && s.dir >= 0 ? FACE_ROT[s.dir] : hash3(room.vnum, Math.round(s.x), Math.round(s.z), salt) * Math.PI * 2;
      hoodProp({
        instances, chunk, addCollider, name, x: s.x, y, z: s.z, rotY,
        scale: opts.scale ?? (0.9 + hash3(room.vnum, Math.round(s.x), 7, salt) * 0.25),
        half: opts.solid === false ? null : [radius, radius], height: opts.height ?? 1.2,
      });
    }
    return spots;
  };
  const blood = (count, salt) => {
    for (let i = 0; i < count; i++) {
      const a = hash3(room.vnum, i, 0, salt) * Math.PI * 2;
      const r = 1.2 + hash3(room.vnum, i, 1, salt) * 2.6;
      decals.push({
        material: 'decal_blood', ground: true, x: pos.x + Math.cos(a) * r, y, z: pos.z + Math.sin(a) * r,
        w: 0.9 + hash3(room.vnum, i, 2, salt) * 1.1, spin: hash3(room.vnum, i, 3, salt) * Math.PI * 2,
      });
    }
  };
  const crow = (x, z, top = 0) => {
    instances.add('crow', { x, y: y + top, z, rotY: hash3(Math.round(x * 3), Math.round(z * 3), 0, 931) * Math.PI * 2 }, chunk);
  };

  // Blood where the mud says there is some. The weaponshop's is "splattered
  // and dried all over the walls", which is handled with the ruins below.
  if (HOOD_BLOOD.test(room.description) && style !== 'ruin') blood(/everywhere/i.test(text) ? 6 : 3, 941);

  switch (style) {
    case 'nml': {
      // Burnt-out ground between two gangs: rubble where the houses came
      // down, the charred bones of their roofs, whatever was thrown, and the
      // crows that come for what is left after a fight.
      const heaps = put('rubble_heap', 1 + Math.floor(hash3(room.vnum, 0, 0, 951) * 2), 1.7, 952, { height: 1.1 });
      put('charred_beams', 1, 2.4, 953, { height: 0.9 });
      if (hash3(room.vnum, 1, 0, 951) < 0.4) put('burnt_cart', 1, 1.9, 954, { height: 1.4 });
      put('tall_weeds', 2, 0.5, 955, { solid: false });
      put('debris', 2, 1.0, 956, { solid: false });
      blood(2 + Math.floor(hash3(room.vnum, 2, 0, 951) * 3), 957);
      for (const h of heaps) if (hash3(room.vnum, Math.round(h.x), 0, 958) < 0.6) crow(h.x + 0.2, h.z - 0.1, 1.08);
      for (let i = 0; i < 2; i++) {
        if (hash3(room.vnum, i, 0, 959) < 0.5) continue;
        const a = hash3(room.vnum, i, 1, 959) * Math.PI * 2;
        crow(pos.x + Math.cos(a) * 3.2, pos.z + Math.sin(a) * 3.2);
      }
      break;
    }
    case 'ruin': {
      // Roof and floors in a heap on the ground floor, the timbers that held
      // them lying across it, and nothing worth taking left.
      const reach = ROOM / 2 - 2.2;
      const corner = Math.floor(hash3(room.vnum, 0, 0, 961) * 4);
      const cx = pos.x + (corner & 1 ? 1 : -1) * reach;
      const cz = pos.z + (corner & 2 ? 1 : -1) * reach;
      hoodProp({ instances, chunk, addCollider, name: 'rubble_heap', x: cx, y, z: cz, rotY: corner * 1.3, half: [1.6, 1.6], height: 1.1 });
      const bx = pos.x - (corner & 1 ? 1 : -1) * 1.2;
      const bz = pos.z - (corner & 2 ? 1 : -1) * (reach - 0.4);
      hoodProp({ instances, chunk, addCollider, name: 'charred_beams', x: bx, y, z: bz, rotY: (corner & 1) * 0.3, half: [2.6, 1.0], height: 0.9 });
      instances.add('debris', { x: pos.x + 2.2, y, z: pos.z - 2.6, rotY: 2.1 }, chunk);
      if (HOOD_BLOOD.test(room.description)) {
        // "Blood is splattered and dried all over the walls here."
        for (let d = 0; d < 4; d++) {
          if (sides[d]) continue;
          const [dx, , dz] = DIR_STEP[d];
          const a = (hash3(room.vnum, d, 0, 963) - 0.5) * 5;
          decals.push({
            material: 'decal_blood', x: pos.x + dx * (ROOM / 2 - 0.25) + (dx ? 0 : a), y: y + 1.3 + hash3(room.vnum, d, 1, 963),
            z: pos.z + dz * (ROOM / 2 - 0.25) + (dz ? 0 : a), nx: -dx, nz: -dz, w: 1.6, h: 1.6,
          });
        }
        blood(4, 964);
      }
      break;
    }
    case 'lot': {
      // "A huge building was going to be built here ... Now it is just a
      // weed-strewn plot of land"; its east end "just a dusty square".
      const dusty = /dusty/i.test(room.description);
      put('tall_weeds', dusty ? 3 : 7, 0.6, 971, { solid: false });
      put('bramble', dusty ? 1 : 3, 1.6, 972, { height: 1.6 });
      put('nettles', dusty ? 2 : 5, 0.3, 973, { solid: false });
      put('grass_tuft', dusty ? 3 : 6, 0.3, 974, { solid: false });
      if (!dusty) put('collapsed_shed', 1, 2.0, 975, { height: 2.0, face: true });
      put('debris', 2, 1.0, 976, { solid: false });
      break;
    }
    case 'plaza': {
      // "They began construction of a pleasant plaza here ... renamed in
      // honor of the Dragon gang's idol, the Dracolich. It has become sort of
      // a training ground." The idol against the plaza's closed side, facing
      // across it; pells to beat on; a fire.
      const spot = hoodSpots(room, pos, sides, 1, 1.6, 981, taken)[0];
      if (spot) {
        const rotY = spot.dir >= 0 ? FACE_ROT[(spot.dir + 2) % 4] + Math.PI : Math.atan2(pos.x - spot.x, pos.z - spot.z);
        hoodProp({ instances, chunk, addCollider, name: 'dracolich_idol', x: spot.x, y, z: spot.z, rotY, half: [0.5, 0.5], height: 4.2 });
      }
      put('training_pell', 3, 0.8, 982, { height: 2.0 });
      const fire = hoodSpots(room, pos, sides, 2, 0.6, 983, taken);
      for (const f of fire) hoodBrazier({ instances, chunk, decor, lights, addCollider, x: f.x, y, z: f.z });
      // The paving that was started: a few flags laid and a stack of them
      // never used.
      put('planks_pile', 1, 0.9, 984);
      break;
    }
    case 'park': {
      // "Not really a 'park' ... queerly peaceful ... some kind of memorial to
      // the great Mongol warrior Khan being crudely constructed here."
      const spot = hoodSpots(room, pos, sides, 1, 2.1, 991, taken)[0];
      if (spot) {
        hoodProp({ instances, chunk, addCollider, name: 'khan_memorial', x: spot.x, y, z: spot.z, rotY: spot.dir >= 0 ? FACE_ROT[spot.dir] : 0, half: [1.6, 1.6], height: 1.8 });
      }
      for (let i = 0; i < 3; i++) {
        const s = hoodSpots(room, pos, sides, 1, 0.9, 992 + i, taken)[0];
        if (!s) continue;
        decor.push({ kind: 'tree', x: s.x, y, z: s.z, scale: 0.8 + hash3(room.vnum, i, 0, 995) * 0.4 });
        addCollider(s.x - 0.7, s.x + 0.7, s.z - 0.7, s.z + 0.7, y, y + 8);
      }
      put('bramble', 3, 1.6, 996, { height: 1.6 });
      put('tall_weeds', 4, 0.5, 997, { solid: false });
      put('grass_tuft', 8, 0.3, 998, { solid: false });
      break;
    }
    case 'court': {
      // "Someone forgot to water the plants and they all died"; "a set of
      // stairs used to extend up to a suite of rooms but the set is missing
      // stairs 3-15".
      put('dead_planter', 3, 1.0, 1001, { face: true, height: 0.7 });
      if (/\bstairs\b/i.test(room.description)) {
        const blank = [0, 1, 2, 3].filter((d) => !sides[d]);
        if (blank.length) {
          const d = blank[0];
          const [dx, , dz] = DIR_STEP[d];
          const reach = HALF - 0.95;
          const x = pos.x + dx * reach; const z = pos.z + dz * reach;
          // Its wall is its +y in Blender, which is -z here once exported:
          // FACE_ROT turns -z to face the wall it stands against.
          hoodProp({ instances, chunk, addCollider, name: 'broken_stair', x, y, z, rotY: FACE_ROT[d], half: [4.0, 0.9], height: 3.5 });
        }
      }
      put('debris', 2, 1.0, 1002, { solid: false });
      break;
    }
    case 'lair': {
      // The gang leader's hideout and the Ogres' chapel: their fires, their
      // marks on the walls. INDOORS, so against the inner face of the walls.
      for (let i = 0; i < 2; i++) {
        const a = (i ? 1 : -1) * 2.6;
        const d = [0, 1, 2, 3].find((k) => !sides[k]) ?? 0;
        const [dx, , dz] = DIR_STEP[d];
        hoodBrazier({ instances, chunk, decor, lights, addCollider, x: pos.x + dx * 3.4 + (dx ? 0 : a), y, z: pos.z + dz * 3.4 + (dz ? 0 : a) });
      }
      for (let d = 0; d < 4; d++) {
        if (sides[d]) continue;
        const [dx, , dz] = DIR_STEP[d];
        const a = (hash3(room.vnum, d, 0, 1011) - 0.5) * 4;
        hoodMark(decals, turf, pos.x + dx * (ROOM / 2 - 0.06) + (dx ? 0 : a), y + 2.1, pos.z + dz * (ROOM / 2 - 0.06) + (dz ? 0 : a),
          -dx, -dz, 1.9, hash3(room.vnum, d, 1, 1011));
      }
      // The chapel is "desecrated by graffiti and vandalism": its roof
      // timbers have come down in it.
      if (/desecrated|vandalism/i.test(room.description)) {
        put('rubble_heap', 1, 1.6, 1012, { height: 1.1 });
        put('charred_beams', 1, 2.4, 1013, { height: 0.9 });
      }
      put('debris', 2, 1.0, 1014, { solid: false });
      break;
    }
    default: break;
  }

  // Each gang keeps a fire burning where its street opens on No Man's Land:
  // the only light along the strip after dark, and it is on the far side.
  // And one on each corner it holds -- the crossings, where it can see three
  // ways at once -- which is all the light its streets get.
  if (style === 'street' && [0, 1, 2, 3].filter((d) => sides[d]).length >= 3) {
    const corner = hoodSpots(room, pos, sides, 1, 0.5, 1082, taken)[0];
    if (corner) hoodBrazier({ instances, chunk, decor, lights, addCollider, x: corner.x, y, z: corner.z });
  }
  if (style === 'street') {
    for (let d = 0; d < 4; d++) {
      const side = sides[d];
      if (!side || side.kind !== 'alley' || !side.target || hoodStyle(side.target.room) !== 'nml') continue;
      const [dx, , dz] = DIR_STEP[d];
      const s = hash3(room.vnum, d, 0, 1081) < 0.5 ? -1 : 1;
      const x = pos.x + dx * 3.4 + (dx ? 0 : s * 2.3);
      const z = pos.z + dz * 3.4 + (dz ? 0 : s * 2.3);
      hoodBrazier({ instances, chunk, decor, lights, addCollider, x, y, z });
    }
  }

  // Prose-named things, one room each.
  if (/smashed crystal statues/i.test(text)) put('crystal_stump', 3, 1.0, 1021, { height: 2.0 });
  else if (/crystal sculptures/i.test(text)) put('crystal_stump', 1, 1.0, 1022, { height: 2.0 });
  if (/full of garbage/i.test(text)) put('refuse_heap', 3, 1.3, 1023, { height: 0.7 });
  if (/toppling of a building/i.test(text)) {
    // "Black Dragon Avenue used to run south from here but the way has been
    // blocked by the toppling of a building into the street."
    const [dx, , dz] = DIR_STEP[2];
    for (const a of [-3.2, 0, 3.2]) {
      hoodProp({ instances, chunk, addCollider, name: 'rubble_heap', x: pos.x + a, y, z: pos.z + dz * (HALF - FRONTAGE_D - 0.9) + dx, rotY: a, half: [1.6, 1.4], height: 1.1 });
    }
  }
  if (/footprints|struggle|broken sticks/i.test(text)) put('debris', 2, 1.0, 1024, { solid: false });
  if (/grand fountain/i.test(text)) {
    // "There is a grand fountain to the east but the water doesn't look
    // good to drink": dry, choked with rubbish.
    const d = sides[1] ? [0, 2, 3].find((k) => !sides[k]) : 1;
    if (d !== undefined) {
      const [dx, , dz] = DIR_STEP[d];
      const r = HALF - FRONTAGE_D - 1.5;
      hoodProp({ instances, chunk, addCollider, name: 'fountain', x: pos.x + dx * r, y, z: pos.z + dz * r, half: [1.3, 1.3], height: 1.2 });
      instances.add('debris', { x: pos.x + dx * r - dz * 1.8, y, z: pos.z + dz * r + dx * 1.8, rotY: 0.7 }, chunk);
    }
  }
  if (/crushed under its own weight/i.test(text)) {
    // "Some kind of tunnel entrance is to the west but it has been crushed
    // under its own weight."
    const d = /to the west/i.test(text) && !sides[3] ? 3 : [0, 1, 2, 3].find((k) => !sides[k]);
    if (d !== undefined) {
      const [dx, , dz] = DIR_STEP[d];
      const r = HALF - FRONTAGE_D - 0.4;
      instances.add('stone_arch', { x: pos.x + dx * r, y, z: pos.z + dz * r, rotY: dx ? Math.PI / 2 : 0 }, chunk);
      hoodProp({ instances, chunk, addCollider, name: 'rubble_heap', x: pos.x + dx * (r - 0.9), y, z: pos.z + dz * (r - 0.9), rotY: dx ? Math.PI / 2 : 0, half: [1.7, 1.4], height: 1.2 });
    }
  }
  if (/statue here depicting/i.test(text)) {
    // "...a battle between two great warriors. You think it's odd that it has
    // not been defiled, but then you sense a aura protecting it."
    lights.push({ x: pos.x, y: y + 3.2, z: pos.z, color: 0xbcd4ff, intensity: 7, radius: 9, outdoor: true });
  }
}

/**
 * A cell built on in the neighborhood. Mostly the town's own house shut up
 * and left (`house_derelict`), a third of them burnt out (`house_gutted`),
 * and now and then one somebody still lives in -- the only glass in the
 * district that lights after dark. Where the prose puts a burnt building on a
 * corner, that corner is the burnt one.
 *
 * The inside of No Man's Land is not built on at all: the cells between its
 * rooms are open ground, walkable, with the stumps of the houses that stood
 * there -- which is what makes it a strip and not four more street corners.
 */
function buildHoodFiller({ batcher, instances, chunk, addCollider, addPlatform, decor, x, y, z, faceDir, open, burnt, cemetery, turf, decals, seed }) {
  batcher.add(plane(CELL, CELL, 3), open ? 'ash' : 'brokencobble', place(x, y, z), { chunk });
  if (!instances) return;
  if (open) {
    // Stumps of walls on two sides, the rest of them in heaps.
    addPlatform(x - HALF, x + HALF, z - HALF, z + HALF, y);
    const d = Math.floor(seed * 4);
    for (const k of [d, (d + 1) % 4]) {
      const [dx, , dz] = DIR_STEP[k];
      instances.add('ruin_wall_solid', {
        x: x + dx * (HALF - 1.2), y, z: z + dz * (HALF - 1.2), rotY: FACE_ROT[k], scaleX: 0.9, scaleY: 0.45 + seed * 0.3,
      }, chunk);
      const along = k === 1 || k === 3;
      const cx = x + dx * (HALF - 1.2); const cz = z + dz * (HALF - 1.2);
      addCollider(cx - (along ? 0.3 : 5.2), cx + (along ? 0.3 : 5.2), cz - (along ? 5.2 : 0.3), cz + (along ? 5.2 : 0.3), y, y + 3);
    }
    const hx = x - DIR_STEP[d][0] * 2.2 - DIR_STEP[(d + 1) % 4][0] * 2.2;
    const hz = z - DIR_STEP[d][2] * 2.2 - DIR_STEP[(d + 1) % 4][2] * 2.2;
    hoodProp({ instances, chunk, addCollider, name: 'rubble_heap', x: hx, y, z: hz, rotY: seed * 6, half: [1.6, 1.6], height: 1.1 });
    instances.add('tall_weeds', { x: x + 1.5, y, z: z - 1.2, rotY: seed * 9 }, chunk);
    if (seed > 0.5) instances.add('crow', { x: hx + 0.2, y: y + 1.08, z: hz, rotY: seed * 13 }, chunk);
    decals.push({ material: 'decal_blood', ground: true, x: x - 1.1, y, z: z + 1.6, w: 1.2, spin: seed * 7 });
    return;
  }
  if (cemetery) {
    // "A large open space, possibly a cemetery ... You wonder if it's keeping
    // you out, or the ghouls in?" Nobody tends it.
    batcher.add(plane(CELL - 0.2, CELL - 0.2, 3), 'grass', place(x, y + 0.01, z), { chunk });
    for (let i = 0; i < 9; i++) {
      const gx = x - 4 + (i % 3) * 4 + (hash3(x, z, i, 1031) - 0.5);
      const gz = z - 4 + Math.floor(i / 3) * 4 + (hash3(x, z, i, 1032) - 0.5);
      instances.add(i % 4 === 3 ? 'grave_slab' : 'headstone', {
        x: gx, y, z: gz, rotY: (hash3(x, z, i, 1033) - 0.5) * 0.5 + (i % 4 === 3 ? 0 : Math.PI / 2 * Math.round(hash3(x, z, i, 1034))),
      }, chunk);
    }
    instances.add('tree_snag', { x: x + 2, y, z: z + 1.5, rotY: seed * 6, scale: 0.8 }, chunk);
    instances.add('tall_weeds', { x: x - 2.5, y, z: z + 2.4, rotY: seed * 4 }, chunk);
    addCollider(x - HALF, x + HALF, z - HALF, z + HALF, y, y + 3);
    return;
  }
  const house = burnt ? 'house_gutted' : (seed < 0.1 ? 'house_stone_a' : (seed < 0.36 ? 'house_gutted' : 'house_derelict'));
  const modelled = instances.library.get(house);
  if (!modelled) return;
  const fit = Math.min(1.15, (CELL * 0.92) / Math.max(0.001, Math.max(modelled.size.x, modelled.size.z)));
  const rotY = faceDir >= 0 ? FACE_ROT[faceDir] + Math.PI : Math.floor(seed * 4) * (Math.PI / 2);
  instances.add(house, { x, y, z, rotY, scaleX: fit, scaleZ: fit, scaleY: fit * (0.9 + seed * 0.25) }, chunk);
  const w = CELL * 0.92;
  addCollider(x - w / 2, x + w / 2, z - w / 2, z + w / 2, y, y + modelled.size.y * fit);
  // The gang's mark on the street face.
  if (faceDir >= 0 && hash3(x, z, 0, 1041) < 0.55) {
    const [nx, , nz] = DIR_STEP[faceDir];
    // The front wall's face, not the bounds: the step before the door stands
    // a metre further out.
    const face = 5.97 * fit;
    const a = (hash3(x, z, 1, 1041) < 0.5 ? -1 : 1) * 2.35 * fit;
    const px = x + nx * face + (nx ? 0 : a) + nx * 0.18;
    const pz = z + nz * face + (nz ? 0 : a) + nz * 0.18;
    // Only on masonry that is there: the burnt house's front is broken down
    // in the middle, so its mark goes low.
    hoodMark(decals, turf, px, y + (house === 'house_gutted' ? 1.4 : 1.9), pz, nx, nz, 1.7, hash3(x, z, 2, 1041));
  }
  void decor;
}

/**
 * Where No Man's Land meets a street: a barricade across the passage, built
 * from both ends and meeting in the middle, with the gap the patrolmen walk
 * through. The stakes are always on the street's side of it, the cart and
 * crates on No Man's Land's -- a gang holds its end.
 */
function buildHoodBarricade({ instances, chunk, addCollider, cell, dir, y, seed }) {
  if (!instances) return;
  const [dx, , dz] = DIR_STEP[dir];
  const across = dir === 0 || dir === 2 ? [1, 0] : [0, 1];
  const x = cell.x * CELL; const z = cell.z * CELL;
  // The line lies across the way, the pieces either side of a 2.8 m gap.
  const rotY = across[0] ? 0 : Math.PI / 2;
  for (const s of [-1, 1]) {
    const off = s * 4.2;
    const px = x + across[0] * off + dx * (seed - 0.5);
    const pz = z + across[1] * off + dz * (seed - 0.5);
    const name = (s > 0) === (seed > 0.5) ? 'barricade' : 'barricade_stakes';
    hoodProp({
      instances, chunk, addCollider, name, x: px, y, z: pz, rotY: rotY + (s > 0 ? 0 : Math.PI),
      half: name === 'barricade' ? [2.8, 0.9] : [2.0, 1.0], height: 1.8,
    });
  }
  instances.add('debris', { x: x + dx * 2.6, y, z: z + dz * 2.6, rotY: seed * 6 }, chunk);
}

/**
 * Wall Road: the long street down the inside of the town's east wall, and
 * the wall. A curtain wall on every side of the road that faces out of town,
 * except where the river goes through it -- "a hole in the wall" -- and there
 * the road crosses the water on a bridge.
 */
function buildHoodWallRoad({ batcher, instances, link, layout, chunkOf, addCollider, addPlatform, reserved, cellKey }) {
  if (!instances) return;
  const level = link.from.level;
  const y = level * LEVEL_H;
  const chain = [link.from, ...link.path, link.to];
  for (let i = 1; i < chain.length - 1; i++) {
    const c = chain[i];
    const open = new Set([dirBetween(c, chain[i - 1]), dirBetween(c, chain[i + 1])]);
    const chunk = chunkOf({ x: c.x, z: c.z, level });
    const px = c.x * CELL; const pz = c.z * CELL;
    const other = layout.passageAt(level, c.x, c.z);
    const river = other && other !== link && isWater(other.from.room) && isWater(other.to.room);
    if (river) {
      // The bridge: a stone deck over the water, the length of the cell, with
      // a parapet down each side.
      const along = open.has(0) || open.has(2);
      const [w, d] = along ? [4.8, CELL] : [CELL, 4.8];
      batcher.add(box(w, 0.34, d, 3, 1, 3), 'stonewall', place(px, y + 0.08, pz), { chunk, ao: wallAo(y - 0.2) });
      addPlatform(px - w / 2, px + w / 2, pz - d / 2, pz + d / 2, y + 0.25);
      for (const s of [-1, 1]) {
        const [bx, bz] = along ? [px + s * (w / 2 - 0.25), pz] : [px, pz + s * (d / 2 - 0.25)];
        const [bw, bd] = along ? [0.5, CELL] : [CELL, 0.5];
        batcher.add(box(bw, 0.75, bd, 1, 1, 3), 'stonewall', place(bx, y + 0.62, bz), { chunk, ao: wallAo(y) });
        addCollider(bx - bw / 2, bx + bw / 2, bz - bd / 2, bz + bd / 2, y, y + 1.5);
      }
      continue;
    }
    // East is out of town all the way down.
    if (open.has(1)) continue;
    const nkey = cellKey(level, c.x + 1, c.z);
    if (layout.at(level, c.x + 1, c.z) !== undefined || layout.isPath(level, c.x + 1, c.z)) continue;
    reserved.add(nkey);
    // Its buttressed face to the road, which is west of it.
    instances.add('city_wall', { x: px + HALF + 0.2, y, z: pz, rotY: FACE_ROT[3] + Math.PI }, chunk);
    addCollider(px + HALF - 1.95, px + HALF + 1.6, pz - HALF, pz + HALF, y, y + 9);
  }
}

/**
 * The paint and the blood: every decal quad in the world, merged by
 * material, laid a centimetre off whatever it is on.
 */
function buildDecals(group, decals, materials) {
  const byMaterial = new Map();
  for (const d of decals) {
    if (!materials[d.material]) continue;
    if (!byMaterial.has(d.material)) byMaterial.set(d.material, []);
    byMaterial.get(d.material).push(d);
  }
  for (const [name, list] of byMaterial) {
    const pos = new Float32Array(list.length * 18);
    const nor = new Float32Array(list.length * 18);
    const uv = new Float32Array(list.length * 12);
    list.forEach((d, k) => {
      let n; let r; let u;
      if (d.ground) {
        n = [0, 1, 0];
        r = [Math.cos(d.spin), 0, Math.sin(d.spin)];
        u = [Math.sin(d.spin), 0, -Math.cos(d.spin)];
      } else {
        n = [d.nx, 0, d.nz];
        // Screen right for someone looking at the face: up x n.
        r = [d.nz, 0, -d.nx];
        u = [0, 1, 0];
      }
      const hw = d.w / 2; const hh = (d.h ?? d.w) / 2;
      const lift = 0.012 + (d.lift ?? 0);
      const c = [d.x + n[0] * lift, d.y + n[1] * lift, d.z + n[2] * lift];
      const corner = (sx, sy) => [c[0] + r[0] * hw * sx + u[0] * hh * sy, c[1] + r[1] * hw * sx + u[1] * hh * sy,
        c[2] + r[2] * hw * sx + u[2] * hh * sy];
      const quad = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, -1, 0, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
      quad.forEach(([sx, sy, tu, tv], i) => {
        const p = corner(sx, sy);
        pos.set(p, (k * 6 + i) * 3);
        nor.set(n, (k * 6 + i) * 3);
        uv.set([tu, tv], (k * 6 + i) * 2);
      });
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, materials[name]);
    mesh.name = name;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}


// ------------------------------------------------------------------ main ----

export function buildScene(world, layout, materials, assets = null) {
  const group = new THREE.Group();
  group.name = 'world';
  const batcher = new Batcher(materials);
  // Modelled assets are optional everywhere: if the library is absent or a
  // particular model has not been made yet, the procedural geometry stands in.
  // Two batches, split on the chunk's level: see `buildZones`.
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
  const skyHoles = [];    // the tops of the sewer's air shafts
  const cabins = [];      // world rects a cabin shell stands on: keep them clear
  const decals = [];      // paint and blood, laid on surfaces: see buildDecals
  const reserved = new Set(); // cells something other than a house stands on

  const addCollider = (x0, x1, z0, z1, y0, y1) => colliders.push({ x0, x1, z0, z1, y0, y1 });
  const addPlatform = (x0, x1, z0, z1, top) => platforms.push({ x0, x1, z0, z1, top });

  classifySewer(world);
  classifyShells(world, (room) => room.sector !== SECTOR.AIR && !isOpenAir(room));
  const turfAt = hoodTurf(layout);
  // The whole kit or none of it: a chamber with no tunnel to leave by is worse
  // than the plain walled room it falls back to.
  const sewerKit = !!instances && SEWER_KIT.every((name) => assets.has(name));

  const worldOf = (cell) => ({ x: cell.x * CELL, y: cell.level * LEVEL_H, z: cell.z * CELL });
  // The neighborhood is chunked eight cells a side instead of four. It is a
  // district of boarded houses a few hundred metres from the Market Square,
  // every one of its models has five or six materials, and at 4x4 it came to
  // 1,070 meshes drawn from a square that cannot see one of them.
  const hoodBox = hoodBounds(layout);
  const inHood = (cell) => !!hoodBox && cell.level === 0 && cell.x >= hoodBox.x0 && cell.x <= hoodBox.x1
    && cell.z >= hoodBox.z0 && cell.z <= hoodBox.z1;
  const chunkOf = (cell) => (inHood(cell)
    ? `${cell.level}:h${Math.floor(cell.x / 8)},${Math.floor(cell.z / 8)}`
    : `${cell.level}:${Math.floor(cell.x / 4)},${Math.floor(cell.z / 4)}`);
  // What every cell's ground was painted in, so `buildVerges` can find the
  // boundaries between two biomes without guessing at them a second time.
  const groundAt = new Map();
  const cellKey = (level, x, z) => `${level}:${x},${z}`;

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
  // With a hole in it wherever a stair goes down out of a street-level room.
  // The ground plane runs under everything at -0.47, so a stair cut through a
  // floor at level 0 came out on grass half a metre down -- the graveyard's
  // tombs have been sealed that way since they were added: the opening read
  // as a lawn with a handrail standing in it, and the ground's platform held
  // the player up at -0.47 over a flight that goes down to -7.6.
  const groundHoles = [];
  for (const plan of stairPlans) {
    if (plan.upper.level !== 0 || plan.lower.level >= 0) continue;
    const rect = unionRect(holes.get(plan.upper.vnum).filter((h) => !h.ceiling));
    const ux = plan.upper.x * CELL; const uz = plan.upper.z * CELL;
    groundHoles.push({ x0: ux + rect.x0, x1: ux + rect.x1, z0: uz + rect.z0, z1: uz + rect.z1 });
  }
  for (const r of rectsAround({ x0: gx0, x1: gx1, z0: gz0, z1: gz1 }, groundHoles)) {
    const w = r.x1 - r.x0; const d = r.z1 - r.z0;
    const seg = Math.max(1, Math.min(32, Math.round(Math.max(w, d) / 60)));
    batcher.add(plane(w, d, seg), 'grass', place((r.x0 + r.x1) / 2, groundY, (r.z0 + r.z1) / 2), { chunk: 'ground' });
    addPlatform(r.x0, r.x1, r.z0, r.z1, groundY);
  }
  // ...and something for it to end against, out where the fog is thick enough
  // to do the work.
  const horizon = buildHorizon(group, bounds, groundY, layout);

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
    const openAir = isOpenAir(room);
    // Everything this cell adds is inside a building unless the cell is open to
    // the sky. Set here rather than threaded through buildFloor, buildIndoorWall,
    // buildCeiling and the props, all of which add on this room's behalf.
    batcher.indoor = !openAir;
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
    const hood = mats.hood;
    const ruin = hood === 'ruin';
    const kit = (!openAir && !mats.cave && !mats.shire && !mats.shell && instances)
      ? (ruin && model(['ruin_wall_solid']) ? 'ruin_'
        : mats.holy && model(['temple_wall_solid']) ? 'temple_'
          : (model(['wall_solid']) ? '' : null))
      : null;
    // "The back wall of the building has been bashed down, allowing you to go
    // south": that side is a breach, not a doorway.
    const bashed = ruin ? /bashed down[^.]*?\b(north|south|east|west)\b/i.exec(room.description) : null;
    const breach = bashed ? WALL_WORD[bashed[1].toLowerCase()] : -1;
    // A roofless ruin is lit like the street it stands in.
    if (ruin) batcher.indoor = false;

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

    // Where you arrive is the room's centre -- unless a stair goes down through
    // it, in which case the centre is over the opening and every arrival fell
    // three metres onto the flight. It moves beside the opening instead, to
    // the side with no door in it where there is one. Everything that places
    // a player reads this -- a step, a portal, `goto` -- so it is the one fix.
    const down = stairPlans.find((plan) => plan.upper === cell);
    let arrive = { x: pos.x, z: pos.z };
    if (down) {
      const [ax, , az] = DIR_STEP[down.dir];
      const beside = [(down.dir + 1) % 4, (down.dir + 3) % 4].sort((a, b) => (sides[a] ? 1 : 0) - (sides[b] ? 1 : 0))[0];
      const [bx, , bz] = DIR_STEP[beside];
      arrive = { x: pos.x + ax * HOLE_CENTRE + bx * 3.45, z: pos.z + az * HOLE_CENTRE + bz * 3.45 };
    }
    rooms.set(room.vnum, {
      room, cell, center: new THREE.Vector3(arrive.x, pos.y, arrive.z), outdoor,
      chunk, materials: mats, sides,
    });

    // The sewer's works are assembled from the kit and own everything about
    // themselves: floor, walls, vault, mouths, what stands in them.
    if (sewerKit && isVault(room)) {
      batcher.indoor = true;
      buildSewerChamber({
        batcher, instances, chunk, room, cell, pos, sides, layout,
        floorHoles: roomHoles.filter((h) => !h.ceiling),
        shaft: stairPlans.some((plan) => plan.lower === cell),
        addCollider, addPlatform, lights, decor, portals, skyHoles,
      });
      // "An old and worn well from before this century": the stair down is
      // its shaft, and a windlass stands over it.
      const shaftTop = roomHoles.filter((h) => !h.ceiling);
      if (mats.shell && mats.shell.kind === 'well' && shaftTop.length) {
        buildWellhead({ batcher, instances, chunk, pos, hole: unionRect(shaftTop), wood: 'sewerwood' });
      }
      continue;
    }

    // A doorway has nothing under it, and underground you can see that: see
    // `isBuried`. Paving these rooms to their cell edge closes it.
    const buried = !openAir && isBuried(mats, cell);
    const half = airborne ? ROOM / 2 : (openAir || buried ? HALF : ROOM / 2);
    if (openAir) groundAt.set(cellKey(cell.level, cell.x, cell.z), mats.floor);
    buildFloor({
      batcher, chunk, material: mats.floor, x: pos.x, y: pos.y, z: pos.z,
      half, holes: roomHoles.filter((h) => !h.ceiling), addPlatform, slab: !airborne,
      shade: !openAir,
    });

    // Six of the marsh's rooms are sectored as open water and only two of them
    // are: "Gloomy Path Through the Marsh" is WATER_SWIM, and a path is not
    // thirteen metres of river. A bog takes pools instead.
    // Water in the sewer is the sewer's own, lying on the floor under a vault:
    // the river shader mirrors the sky and the shore grows reeds.
    if (isDeep(room) && (isWater(room) || sewerFlood(room))) {
      batcher.add(plane(half * 2, half * 2, 4), deepWater(room), place(pos.x, pos.y + SW_FLOOD, pos.z), { chunk });
    } else if (isWater(room) && !bog) {
      // A little over the cell, so two neighbouring sheets overlap instead of
      // meeting on a seam: they are at the same height and the same shader, and
      // an abutting edge still shows as a line where the two planes' waves
      // disagree by a pixel.
      decor.push({ kind: 'water', x: pos.x, y: pos.y + WATER_LIFT, z: pos.z, size: half * 2 + WATER_LAP });
      buildShore({
        batcher,
        instances,
        model,
        chunk,
        room,
        pos,
        half,
        wet: (d) => {
          const [ddx, , ddz] = DIR_STEP[d];
          const vn = layout.at(cell.level, cell.x + ddx, cell.z + ddz);
          if (vn !== undefined) {
            const info = rooms.get(vn);
            return !!info && isWater(info.room) && !isBog(info.room);
          }
          // A routed cell only carries water where both ends of its passage do,
          // which is the same test `buildAlley` makes for midstream.
          const link = sides[d] && sides[d].link;
          if (!link || !link.from || !link.to) return false; // a gate leads out of the world
          const far = link.from.vnum === cell.vnum ? link.to : link.from;
          return !!far.room && isWater(far.room) && !isBog(far.room);
        },
      });
    }
    let pools = null;
    if (bog) {
      mistCells.push(pos);
      pools = buildBogPool({ batcher, chunk, room, pos, sides });
    }

    // Before the sides, because the side that carries the cabin's door has to
    // know that the opening is 1.00 m and not the world's 3.2 m gateway.
    const cabin = (openAir && !airborne && CABIN.test(room.name))
      ? buildCabin({ instances, model, chunk, room, pos, sides, addCollider })
      : null;
    if (cabin) cabins.push(cabin.rect);
    // A gate room that says it has towers gets them, framing the leaves the
    // mud already hangs on that side.
    const gated = openAir && !airborne
      && GATE_ROOM.test(room.name) && GATE_TOWERS.test(room.description);

    for (let dir = 0; dir < 4; dir++) {
      const side = sides[dir];
      const [dx, , dz] = DIR_STEP[dir];
      const rotY = (dir === 1 || dir === 3) ? Math.PI / 2 : 0;
      // "A well in the middle of the floor leads down into darkness. Vile
      // smells waft from the depths." Two of the guild rooms drop into the
      // sewer somewhere the grid could not put directly underneath, so the way
      // down is a portal -- and it is a well in the floor, not an archway
      // glowing blue in the wall.
      const wellDown = sewerKit && side && side.kind === 'portal' && side.link && side.link.dir === 5
        && side.target && isSewer(side.target.room);
      const open = side && (side.kind === 'alley' || side.kind === 'portal') && !wellDown;
      const distance = openAir ? HALF : ROOM / 2;
      const wx = pos.x + dx * distance;
      const wz = pos.z + dz * distance;

      if (!openAir) {
        buildIndoorWall({
          batcher, chunk, mats, x: wx, y: pos.y, z: wz, rotY, open, kit, instances,
          width: ROOM + (WALL_IN + WALL_OUT) * 2, addCollider, dir, room, lights, decor,
          cellX: pos.x, cellZ: pos.z, breach: dir === breach, unlit: ruin || mats.shire === 'barn' || mats.smial,
        });
      } else if (!airborne) {
        // Nothing walls a room under the canopy: `buildForest` stands a picket
        // of trees along every side there is no way out of, and a rock kerb
        // behind that is the level editor showing through.
        if (!canopy) buildOutdoorEdge({ batcher, chunk, room, pos, dir, open, addCollider, bog, instances });
        // Once, for the whole cell -- the corners need to know about all four
        // sides, not one at a time.
        // Outside a gate is outside the wall: no houses. See `townEdges`.
        if (dir === 3 && gateOf(room) >= 0) {
          buildGateFlanks({ batcher, chunk, pos, dir: gateOf(room), addCollider });
        } else if (dir === 3) {
          buildCityFrontage({
            batcher, instances, model, chunk, room, cell, pos, sides, addCollider, decor, doors,
            lights, decals, turf: hood ? turfAt(cell.z) : null,
          });
        }
      }

      // "In the air..." rooms sit three levels above the roofs. An archway
      // built for one hangs over the town with its signpost floating beside it,
      // which is exactly what it looks like. They are scenery; leave them bare.
      if (wellDown) {
        const wx2 = pos.x + dx * (distance - 2.1);
        const wz2 = pos.z + dz * (distance - 2.1);
        instances.add('town_well', { x: wx2, y: pos.y, z: wz2, rotY: FACE_ROT[dir] }, chunk);
        addCollider(wx2 - 1.0, wx2 + 1.0, wz2 - 1.0, wz2 + 1.0, pos.y, pos.y + 0.62);
        portals.push({
          x: wx2 - dx * PIT_REACH, y: pos.y, z: wz2 - dz * PIT_REACH, radius: 1.0, target: side.target.vnum,
          from: room.vnum, label: side.target.room.name, dir,
        });
      } else if (side && (side.kind === 'portal' || side.kind === 'gate') && !airborne && !deadExit(side.exit)) {
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
            kind: 'gateSign', x: ax - dx * 0.9, y: pos.y + 2.7, z: az - dz * 0.9, rotY, dx, dz,
            text: DIR_NAME[side.link.dir],
          });
        }
      }

      if (side && side.exit && (side.exit.locks & EX_ISDOOR)) {
        // A cabin standing on this side owns the opening: the model has a
        // 1.00 x 1.99 m void and one leaf fills it, because a one-room cabin
        // does not have double doors.
        const hung = cabin && cabin.dir === dir ? cabin : null;
        doors.push({
          x: wx + dx * (openAir ? -0.3 : (WALL_IN + WALL_OUT) / 2), y: pos.y,
          z: wz + dz * (openAir ? -0.3 : (WALL_IN + WALL_OUT) / 2), rotY, dir,
          width: hung ? hung.width : DOOR_W, height: hung ? hung.height : DOOR_H,
          single: !!hung,
          // One round leaf covering the whole opening instead of two boarded
          // halves. The opening stays 3.2 x 3.1 -- square to within 3%, which
          // is close enough for a circle and leaves the lintel, the collider
          // and the player's clearance exactly as they were.
          round: isShire(room),
          closed: !!(side.exit.locks & EX_CLOSED),
          locked: !!(side.exit.locks & EX_LOCKED),
          keyword: side.exit.keyword || 'door',
          // "Through the solid iron bars you see the Concourse": a grate is
          // iron you can see through, not boards.
          grate: GRATE.test(side.exit.keyword || ''),
          room: room.vnum,
        });
        if (gated) buildGatehouse({ batcher, chunk, pos, dir, addCollider });
        // Out in the open a grate hangs in a railing, not on its own: iron
        // runs from each jamb to the corner of the cell, on the line the
        // graveyard's own railing takes.
        if (openAir && GRATE.test(side.exit.keyword || '')) {
          buildGrateRailing({ instances, model, chunk, pos, dir, addCollider });
        }
      }
    }

    // One per cell, after the sides, not one per side: which way out a street
    // happens to have says nothing about where its lamp stands.
    // Nobody has lit a lamp in the neighborhood for years: its light is the
    // gangs' fires.
    if (openAir && !hood) buildStreetLamp({ room, cell, pos, decor, lights, addCollider });

    // links that had no free wall left: an arch standing in the room itself
    for (const link of layout.links) {
      if (link.from !== cell || link.side !== null || link.kind === 'alley' || link.kind === 'stairs') continue;
      if (deadExit(link.exit)) continue;
      if (airborne) continue;
      // Up out of the Temple Square is "In the air...", which is never built:
      // the arch stood in the middle of the square leading nowhere, a portal
      // to a room the game refuses to enter.
      if (link.to && link.to.room.sector === SECTOR.AIR) continue;
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
      if (!ruin) instances.add(`${kit}roof`, { x: pos.x, y: pos.y + CEIL, z: pos.z, rotY: 0 }, chunk);
      if (kit === 'temple_') {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            instances.add('temple_column', { x: pos.x + sx * 3.0, y: pos.y, z: pos.z + sz * 3.0, rotY: 0 }, chunk);
          }
        }
      }
    }

    if (!openAir) {
      const shellKind = mats.shell && mats.shell.kind;
      const ceilHoles = roomHoles.filter((h) => h.ceiling);
      // "The walls and ceiling seem miles away": the lining goes up, and the
      // flat ceiling that would hide it does not go in.
      const top = ceilingOf(room, cell, layout);
      if (!ruin && top !== VAST_CEIL) {
        buildCeiling({
          batcher, chunk, material: mats.ceil, x: pos.x, y: pos.y + top, z: pos.z,
          half: ROOM / 2 + WALL_IN, holes: roomHoles.filter((h) => h.ceiling),
        });
      }
      if (mats.shire) {
        buildTimberFrame({
          batcher, chunk, pos, sides, addCollider, barn: mats.shire === 'barn',
          holes: roomHoles.filter((h) => h.ceiling), rail: shellKind !== 'inn',
        });
      }
      buildShell({
        kind: shellKind, batcher, instances, chunk, room, cell, pos, sides, addCollider, lights, decor, mats, materials,
        holes: ceilHoles, stairDir: stairPlans.find((plan) => plan.lower === cell)?.dir ?? -1,
      });
      // Lanterns hang from the beams: the barn's tie beams, the smial's ribs.
      let lanterns = mats.shire === 'barn' ? [[-1.8, -2.6], [1.8, 2.6]] : null;
      if (mats.smial) lanterns = buildSmialVault({ batcher, chunk, pos, sides, addCollider });
      if (instances && lanterns) hangLanterns({ instances, chunk, pos, decor, lights, room, points: lanterns });
      if (instances && (deepStyle(room) === 'cave' || mats.rockCave)) {
        buildCaveLining({
          instances, chunk, room, pos, sides, roofed: !roomHoles.some((h) => h.ceiling), addCollider,
          height: top,
        });
      }
      // ...and a room with earth over it has no roof either. Same family as the
      // windows below, and it was visible: a tomb sits 5.65 m under the
      // graveyard and `buildRoof` puts its ridge at CEIL + SLAB + span/2 above
      // its own floor, so a 12.4 m rooftile prism ran from y -1.95 up to +0.6
      // and came through the grass -- measured over #3640, where it read as a
      // tiled roof lying on the turf. The chimney and its smoke went with it.
      if (kit === null && !buried && !ruin) {
        buildRoof({ batcher, chunk, mats, room, x: pos.x, y: pos.y + CEIL + SLAB, z: pos.z, decor });
      }
      // A room under the ground has no outside to put a window in. The Shire's
      // tunnels and its lower halfling holes were getting casements with lit
      // panes and sills, and the sills -- pale timber right beside a wall torch
      // -- came out as two glowing white bars across a room the mud calls
      // "darkness"; the graveyard's tombs were getting the same. The smials on
      // Bywater Road are at street level and keep theirs, which is the whole
      // difference.
      // A ruin's windows are holes, and nobody is home in the gangs' lairs.
      if (!isBuried(mats, cell) && !ruin && hood !== 'lair') {
        decor.push({
          kind: 'windows', x: pos.x, y: pos.y, z: pos.z,
          // On a log wall the casement sits on the logs' face, and the logs
          // are cut round it (`buildLogWalls`).
          w: (SHELL + (shellKind === 'log' ? LOG_FACE : 0)) * 2, d: (SHELL + (shellKind === 'log' ? LOG_FACE : 0)) * 2,
          h: CEIL + 1.1, seed: hash3(room.vnum, 2, 0, 11), doorSides: sides,
          frame: (kit !== null || MASONRY.has(mats.wallOut)) ? 'stone' : 'timber',
        });
      }
      if (isDeep(room)) buildSewerRoomProps({ room, pos, sides, decor, lights, instances, chunk, addCollider });
      else if (!ruin) rooms.get(room.vnum).plan = buildInteriorProps({ room, pos, sides, decor, mats, holes: roomHoles.filter((h) => !h.ceiling), lights, kit });
      // "The inn actually looks fairly functional despite its lack of repair
      // ... It looks as if the beer is still on tap!!!" The one place in the
      // neighborhood with a sign out and a light at the door.
      const pub = hood === 'room' && TAPROOM.test(room.name);
      if (isShop(room) || pub) buildShopSign({ room, pos, sides, instances, model, chunk, decor, lights });
      if (pub) {
        const d = [0, 1, 2, 3].find((k) => sides[k] && sides[k].kind === 'alley');
        if (d !== undefined) {
          const [dx, , dz] = DIR_STEP[d];
          for (const s of [-1, 1]) {
            const along = s * (DOOR_W / 2 + 0.8);
            const tx = pos.x + dx * (SHELL + 0.05) + (dx ? 0 : along);
            const tz = pos.z + dz * (SHELL + 0.05) + (dz ? 0 : along);
            decor.push({ kind: 'torch', x: tx, y: pos.y + 2.9, z: tz, rotY: FACE_ROT[d] + Math.PI });
            lights.push({ x: tx + dx * 0.5, y: pos.y + 3.3, z: tz + dz * 0.5, color: 0xffa347, intensity: 12, radius: 12, flicker: true, outdoor: true });
          }
        }
      }
    } else {
      // Bog first: half the marsh's bog rooms are sectored FOREST or MOUNTAIN,
      // and a stand of firs is not what grows in standing water.
      if (bog) buildBogFlora({ room, pos, sides, pools, instances, model, chunk });
      else if (isPark(room) && !hood) buildPark({ room, cell, pos, sides, instances, model, chunk, decor, addCollider });
      else if (room.sector === SECTOR.FOREST) {
        buildForest({
          room, pos, sides, instances, model, chunk, decor, addCollider, dense: canopy,
          // Nothing grows through the cabin. The shell sits at the cell edge and
          // the planting ring stops short of it here, but a fern inside a wall
          // is the kind of thing that only turns up in a screenshot.
          keepOut: cabin ? cabin.rect : null,
        });
      }
      // What has been *done* to the ground, as against what grows on it: a
      // clearing full of fresh stumps is still a forest room, and a graveyard
      // is still a field. Both read the room's own words.
      if (!bog) buildClearing({ batcher, chunk, room, pos, sides, addCollider });
      if (GRAVEYARD.test(room.name)) buildGraveyard({ instances, model, chunk, room, pos, sides });
      if (eastStyle(room) && instances) buildEastRoom({ room, pos, sides, instances, chunk, decor, lights, addCollider });
      // "Through the garbage you can see a large junction of pipes": the
      // garbage first, heaped in the corners where nobody has to walk.
      if (REFUSE.test(room.name) && !hood && instances && model(['refuse_heap'])) {
        const heaps = [];
        for (let k = 0; k < 4; k++) heaps.push([k & 1 ? 1 : -1, k & 2 ? 1 : -1]);
        // ...and against the middle of any side with no way out of it.
        for (let d = 0; d < 4; d++) {
          if (sides[d]) continue;
          const [dx, , dz] = DIR_STEP[d];
          heaps.push([dx + (hash3(room.vnum, d, 5, 97) - 0.5) * 0.6 * (dz !== 0), dz + (hash3(room.vnum, d, 6, 97) - 0.5) * 0.6 * (dx !== 0)]);
        }
        heaps.forEach(([sx, sz], k) => {
          const x = pos.x + sx * (4.3 + hash3(room.vnum, k, 1, 97) * 0.6);
          const z = pos.z + sz * (4.3 + hash3(room.vnum, k, 2, 97) * 0.6);
          instances.add('refuse_heap', {
            x, y: pos.y, z, rotY: hash3(room.vnum, k, 3, 97) * 6.28, scale: 0.9 + hash3(room.vnum, k, 4, 97) * 0.4,
          }, chunk);
          addCollider(x - 1.1, x + 1.1, z - 0.9, z + 0.9, pos.y, pos.y + 0.6);
        });
      }
      if (STATUE.test(room.description) || (hood && /statue here depicting/i.test(room.description))) {
        buildStatue({ batcher, chunk, room, pos, sides, addCollider });
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
      if (!bog && blank.length && wantsClutter(room)
        && (farm || REFUSE.test(room.name) || hash3(room.vnum, 13, 0, 6) > 0.28)) {
        decor.push({
          // Against the new facade, not inside it.
          kind: 'clutter', x: pos.x, y: pos.y, z: pos.z,
          half: wantsFrontage(room) ? HALF - FRONTAGE_D : HALF,
          walls: blank, seed: hash3(room.vnum, 12, 0, 5), indoor: false,
          props: hood ? (hood === 'nml' ? HOOD_NML_PROPS : HOOD_PROPS) : clutterProps(room),
        });
      }
    }
    if (hood) {
      buildHoodRoom({
        room, pos, sides, instances, model, chunk, decor, lights, addCollider, decals,
        turf: turfAt(cell.z), style: hood,
      });
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
  batcher.indoor = false;

  // --- streets and corridors ----------------------------------------------

  // Every cell an open street runs through, for the corridors that share one:
  // Wall Road down four cells of the corridor between #3022 and #3023, and
  // four more in Midgaard that layout.js could not route apart.
  const openStreet = new Set();
  for (const link of layout.links) {
    if (link.kind !== 'alley' || alleyEnclosed(link)) continue;
    for (const c of link.path) openStreet.add(cellKey(link.from.level, c.x, c.z));
  }
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
    // A tunnel wherever either end is the sewer's works. Where the other end is
    // a walled room, the tunnel is closed off at that room's cell edge by a
    // face with its doorway in it.
    if (sewerKit && (isVault(link.from.room) || isVault(link.to.room))) {
      buildSewerPassage({ batcher, instances, link, worldOf, chunkOf, addCollider, addPlatform, lights, decor });
      continue;
    }
    buildAlley({
      batcher, instances, link, worldOf, chunkOf, addCollider, addPlatform, lights, decor, mistCells, cabins, groundAt,
      cellKey, streetCells: openStreet,
    });
    // The neighborhood's anchor is Wall Road, and its passages into No Man's
    // Land are barricaded.
    const fromHood = hoodStyle(link.from.room);
    const toHood = hoodStyle(link.to.room);
    if (!!fromHood !== !!toHood) {
      buildHoodWallRoad({ batcher, instances, link, layout, chunkOf, addCollider, addPlatform, reserved, cellKey });
    } else if (fromHood && toHood && (fromHood === 'nml') !== (toHood === 'nml') && link.path.length) {
      const mid = link.path[Math.floor(link.path.length / 2)];
      const next = link.path[Math.floor(link.path.length / 2) + 1] || link.to;
      buildHoodBarricade({
        instances, chunk: chunkOf({ ...mid, level: link.from.level }), addCollider,
        cell: mid, dir: dirBetween(mid, next), y: link.from.level * LEVEL_H,
        seed: hash3(mid.x, mid.z, 0, 1071),
      });
    }
  }

  for (const plan of stairPlans) {
    const lowerMats = pickMaterials(plan.lower.room, plan.lower.room.area);
    buildStair({
      batcher, plan, worldOf, chunkOf, addCollider, addPlatform,
      materials: lowerMats,
      lowerCeil: ceilingOf(plan.lower.room, plan.lower, layout),
      // Going down into the ground rather than up a storey: the opening wants
      // a parapet round it, and a lining through the earth between the room
      // below's ceiling and this floor -- unless the room below is a sewer
      // shaft, whose walls already run the whole way up.
      buried: isBuried(lowerMats, plan.lower),
      shaftWalls: sewerKit && isVault(plan.lower.room),
      // The kerb is built of what the room above is built of: marble in the
      // sanctum, not the street's rubble with the temple's blue light on it.
      kerb: isDeep(plan.upper.room) ? (deepStyle(plan.upper.room) === 'cave' ? 'caverock' : 'ashlar')
        : (isOpenAir(plan.upper.room) ? 'stonewall' : pickMaterials(plan.upper.room, plan.upper.room.area).wallIn),
    });
  }

  // --- the eastern mountains ----------------------------------------------

  // Before the frontage, because a cell the mountain takes is not a street's
  // to build on.
  const mountain = instances && assets.has('massif_a')
    ? buildMassif({ layout, batcher, instances, addCollider, chunkOf, cellKey }) : new Set();

  // --- build on every empty cell that fronts a street ----------------------

  const frontage = new Map(); // cell key -> sector to build from
  const consider = (level, x, z, sector, bog, shire, east = false, hood = false) => {
    if (layout.at(level, x, z) !== undefined || layout.isPath(level, x, z)) return;
    const k = `${level}:${x},${z}`;
    if (!frontage.has(k)) frontage.set(k, { level, x, z, sector, bog, shire, east, hood });
  };
  for (const cell of layout.order) {
    if (!isOpenAir(cell.room) || cell.room.sector === SECTOR.AIR) continue;
    for (let dir = 0; dir < 4; dir++) {
      const [dx, , dz] = DIR_STEP[dir];
      consider(cell.level, cell.x + dx, cell.z + dz, cell.room.sector, isBog(cell.room), isShire(cell.room),
        !!eastStyle(cell.room), !!hoodStyle(cell.room));
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
        consider(link.from.level, c.x + dx, c.z + dz, source.sector, isBog(source), isShire(source), !!eastStyle(source),
          !!hoodStyle(source));
      }
    }
  }
  // The neighborhood's cells that the prose says burnt, and its cemetery.
  const hoodBurnt = new Set();
  const hoodGraves = new Set();
  for (const cell of layout.order) {
    const r = cell.room;
    if (!isHood(r)) continue;
    const text = r.description.replace(/\s+/g, ' ');
    const at = (dx, dz) => cellKey(cell.level, cell.x + dx, cell.z + dz);
    const corner = /\b(north|south)(east|west) corner\b/i.exec(text);
    if (corner && /\b(burn|demolish)/i.test(text)) {
      hoodBurnt.add(at(corner[2].toLowerCase() === 'east' ? 1 : -1, corner[1].toLowerCase() === 'south' ? 1 : -1));
    }
    const gone = /\b(stables|building)\b[^.]*?\b(?:to the|run) (north|south|east|west)\b/i.exec(text);
    if (gone && /\b(used to|toppling|dead or gone)\b/i.test(text)) {
      const [dx, , dz] = DIR_STEP[WALL_WORD[gone[2].toLowerCase()]];
      hoodBurnt.add(at(dx, dz));
    }
    const fence = hoodFenceDir(r);
    if (fence >= 0) hoodGraves.add(at(DIR_STEP[fence][0], DIR_STEP[fence][2]));
  }
  // The inside of No Man's Land: a cell every one of whose ways in is No
  // Man's Land's own.
  const nmlCell = (level, x, z) => {
    const v = layout.at(level, x, z);
    if (v !== undefined) return hoodStyle(world.rooms.get(v)) === 'nml';
    const link = layout.passageAt(level, x, z);
    return !!link && hoodStyle(link.from.room) === 'nml' && hoodStyle(link.to.room) === 'nml';
  };
  const insideNml = (spot) => {
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const [dx, , dz] = DIR_STEP[d];
      const x = spot.x + dx; const z = spot.z + dz;
      if (layout.at(spot.level, x, z) === undefined && !layout.isPath(spot.level, x, z)) continue;
      if (!nmlCell(spot.level, x, z)) return false;
      n++;
    }
    return n >= 2;
  };

  const townWalls = [];
  const edges = townEdges(layout, world);
  if (instances && instances.library.get('city_wall')) townWalls.push(...edges.pathWalls);
  for (const spot of frontage.values()) {
    if (mountain.has(cellKey(spot.level, spot.x, spot.z))) continue;
    if (reserved.has(cellKey(spot.level, spot.x, spot.z))) continue;
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
    spot.faces = faces; // the party walls below need to know which cells share a street
    const pos = { x: spot.x * CELL, y: spot.level * LEVEL_H, z: spot.z * CELL };
    const edge = edges.get(cellKey(spot.level, spot.x, spot.z));
    if (edge && buildTownEdge({
      edge, spot, pos, batcher, instances, model, chunk: chunkOf(spot), addCollider, decor, groundAt, townWalls,
      key: cellKey(spot.level, spot.x, spot.z),
    })) continue;
    if (spot.hood) {
      const key = cellKey(spot.level, spot.x, spot.z);
      const open = insideNml(spot);
      groundAt.set(key, open ? 'ash' : 'brokencobble');
      buildHoodFiller({
        batcher, instances, chunk: chunkOf(spot),
        addCollider, addPlatform, decor, x: pos.x, y: pos.y, z: pos.z, faceDir: faces, open,
        burnt: hoodBurnt.has(key), cemetery: hoodGraves.has(key), turf: turfAt(spot.z), decals,
        seed: hash3(spot.x, spot.z, spot.level, 17),
      });
      continue;
    }
    // The edge of the town. A city cell with open country on one side --
    // Haon Dor's field at #6000 -- got a fit-scaled Tudor house like any
    // other, and a judge photographed it standing on the forest's grass: the
    // town cut off mid-cell. What ends a walled town is its wall, so the side
    // facing the country gets a length of curtain wall instead of a house,
    // its merlons outwards, and the town keeps its cobbles behind it.
    if (spot.sector === SECTOR.CITY && !spot.shire && !spot.east && !spot.bog && instances
      && instances.library.get('city_wall')) {
      const wild = [];
      for (let dir = 0; dir < 4; dir++) {
        const [dx, , dz] = DIR_STEP[dir];
        const vn = layout.at(spot.level, spot.x + dx, spot.z + dz);
        const link = vn === undefined ? layout.passageAt(spot.level, spot.x + dx, spot.z + dz) : null;
        const room = vn !== undefined ? world.rooms.get(vn) : (link ? (isOpenAir(link.from.room) ? link.from.room : link.to.room) : null);
        if (room && isOpenAir(room) && COUNTRY.has(room.sector) && !isShire(room)) wild.push(dir);
      }
      if (wild.length) {
        const key = cellKey(spot.level, spot.x, spot.z);
        groundAt.set(key, 'cobble');
        batcher.add(plane(CELL, CELL, 3), 'cobble', place(pos.x, pos.y, pos.z), { chunk: chunkOf(spot) });
        for (const dir of wild) townWalls.push({ spot, pos, dir });
        continue;
      }
    }
    if (spot.bog) mistCells.push(pos);
    const paved = spot.bog ? 'peat' : (spot.east ? 'sand' : FILLER_GROUND[spot.sector]);
    if (paved) groundAt.set(cellKey(spot.level, spot.x, spot.z), paved);
    buildFiller({
      batcher, instances, model, faceRot: faces < 0 ? null : FACE_ROT[faces],
      chunk: chunkOf(spot),
      sector: spot.east ? SECTOR.DESERT : spot.sector, bog: spot.bog, shire: spot.shire, x: pos.x, y: pos.y, z: pos.z,
      seed: hash3(spot.x, spot.z, spot.level, 17), addCollider, lights, decor,
      // Sides where a room with walls stands next door: nothing grows through them.
      walled: [0, 1, 2, 3].map((d) => {
        const vn = layout.at(spot.level, spot.x + DIR_STEP[d][0], spot.z + DIR_STEP[d][2]);
        const info = vn !== undefined ? rooms.get(vn) : null;
        return !!info && !info.unbuilt && !isOpenAir(info.room);
      }),
    });
  }
  // The town wall's lengths, and a tower wherever a length ends without
  // another one beside it facing the same way: a curtain wall that simply
  // stops shows its cut end.
  const walled = new Set(townWalls.map(({ spot, dir }) => `${cellKey(spot.level, spot.x, spot.z)}|${dir}`));
  for (const { spot, pos, dir } of townWalls) {
    const [dx, , dz] = DIR_STEP[dir];
    const chunk = chunkOf(spot);
    const out = HALF - 1.25;
    const wx = pos.x + dx * out; const wz = pos.z + dz * out;
    // The model's town side is its +z; turn that away from the country.
    instances.add('city_wall', { x: wx, y: pos.y, z: wz, rotY: FACE_ROT[(dir + 2) % 4] + Math.PI }, chunk);
    const [w, d] = dx ? [2.5, CELL] : [CELL, 2.5];
    addCollider(wx - w / 2, wx + w / 2, wz - d / 2, wz + d / 2, pos.y, pos.y + 8.4);
    const tx = dz ? 1 : 0; const tz = dx ? 1 : 0;
    for (const s of [-1, 1]) {
      if (walled.has(`${cellKey(spot.level, spot.x + tx * s, spot.z + tz * s)}|${dir}`)) continue;
      const cx = wx + tx * s * (HALF - 1.6); const cz = wz + tz * s * (HALF - 1.6);
      const T = 4.4; const TH = 10.2;
      batcher.add(box(T, TH, T, 2, 4, 2), 'stonewall', place(cx, pos.y + TH / 2, cz), { chunk, ao: wallAo(pos.y) });
      batcher.add(box(T + 0.5, 0.45, T + 0.5), 'stonewall', place(cx, pos.y + TH + 0.22, cz), { chunk });
      for (let i = 0; i < 4; i++) {
        for (const k of [-1, 1]) {
          const m = (T + 0.5) / 2 - 0.3;
          const [mx, mz] = i < 2 ? [k * (T / 4), (i ? 1 : -1) * m] : [(i === 2 ? 1 : -1) * m, k * (T / 4)];
          batcher.add(box(0.9, 1.0, 0.9), 'stonewall', place(cx + mx, pos.y + TH + 0.95, cz + mz), { chunk });
        }
      }
      addCollider(cx - T / 2, cx + T / 2, cz - T / 2, cz + T / 2, pos.y, pos.y + TH + 1.5);
    }
  }

  // Every cell you can stand on out of doors in the town: the rooms and the
  // passages routed between them. A party wall is only ever laid where one of
  // these can see the gap, which is what keeps it a street feature.
  const streetCells = [];
  for (const cell of layout.order) {
    if (isOpenAir(cell.room) && cell.room.sector === SECTOR.CITY) {
      streetCells.push({ level: cell.level, x: cell.x, z: cell.z });
    }
  }
  for (const link of layout.links) {
    if (link.kind !== 'alley' || alleyEnclosed(link)) continue;
    if (rooms.get(link.from.vnum)?.unbuilt || rooms.get(link.to.vnum)?.unbuilt) continue;
    const source = isOpenAir(link.from.room) ? link.from.room : link.to.room;
    if (source.sector !== SECTOR.CITY) continue;
    for (const c of link.path) streetCells.push({ level: link.from.level, x: c.x, z: c.z });
  }
  buildPartyWalls({ batcher, frontage, addCollider, layout, rooms, streetCells });

  // --- the graveyard's railings --------------------------------------------

  // The graveyard's own ground: its rooms and the paths routed between them.
  // The fence goes round the outside of that shape and nowhere inside it.
  const graveCells = new Set();
  for (const cell of layout.order) {
    if (GRAVEYARD.test(cell.room.name)) graveCells.add(cellKey(cell.level, cell.x, cell.z));
  }
  for (const link of layout.links) {
    if (link.kind !== 'alley') continue;
    if (!GRAVEYARD.test(link.from.room.name) || !GRAVEYARD.test(link.to.room.name)) continue;
    for (const c of link.path) graveCells.add(cellKey(link.from.level, c.x, c.z));
  }
  for (const key of graveCells) {
    const colon = key.indexOf(':');
    const level = Number(key.slice(0, colon));
    const comma = key.indexOf(',', colon);
    const cx = Number(key.slice(colon + 1, comma));
    const cz = Number(key.slice(comma + 1));
    const chunk = chunkOf({ level, x: cx, z: cz });
    const y = level * LEVEL_H;
    for (let dir = 0; dir < 4; dir++) {
      const [dx, , dz] = DIR_STEP[dir];
      const nx = cx + dx; const nz = cz + dz;
      // Anything with ground on it is somewhere you might walk through, so a
      // railing never lands across a way out -- including the iron grate the
      // mud puts between #3600 and the Concourse. Which is the same test as
      // "the gravel runs that way", so the two are one branch: an arm of road
      // where you can walk out, railings where you cannot.
      if (layout.at(level, nx, nz) !== undefined || layout.isPath(level, nx, nz)) {
        const [aw, ad] = dx ? [HALF, GRAVEL_W] : [GRAVEL_W, HALF];
        batcher.add(plane(aw, ad, 2), 'gravel',
          place(cx * CELL + dx * HALF / 2, y + GRAVEL_LIFT, cz * CELL + dz * HALF / 2), { chunk });
        continue;
      }
      // ...and the empty cell between two graveyard rooms is inside, not out.
      if (graveCells.has(cellKey(level, nx + dx, nz + dz))) continue;
      buildIronFence({
        instances, model, chunk, x: cx * CELL, y, z: cz * CELL, dir, addCollider,
      });
    }
  }

  if (instances && assets.has('dune_a')) {
    buildSandSea({ layout, batcher, instances, frontage, mountain, groundAt, cellKey, chunkOf });
  }

  buildVerges({ batcher, instances, model, groundAt, chunkOf });
  // What each room's own words put in it (src/clutter.js), once everything
  // it has to find a clear place among is standing.
  const clutter = placeClutter({
    world, rooms, decor, colliders, addCollider, instances, lights, worldOf, openAir: isOpenAir, ROOM, HALF,
    BufferAttribute: THREE.BufferAttribute,
  });

  // No tree grows through a room's walls. A forest fir is modelled with its
  // lowest boughs 3.6 m out and planted at up to 2.6x, so one standing a
  // whole cell away from Haon Dor's cabin still put its crown through the
  // logs. A tree near a walled room is kept to the size its crown has room
  // for, and one with no room left is not planted.
  const walledRooms = [...rooms.values()].filter((i) => !i.unbuilt && !isOpenAir(i.room))
    .map((i) => ({ x: i.cell.x * CELL, y: i.cell.level * LEVEL_H, z: i.cell.z * CELL }));
  const CROWN = 3.2; // bough reach per unit of scale, at the height of a wall
  for (let i = decor.length - 1; i >= 0; i--) {
    const d = decor[i];
    if (d.kind !== 'tree') continue;
    let room = Infinity;
    for (const b of walledRooms) {
      if (Math.abs(d.y - b.y) > 2) continue;
      room = Math.min(room, Math.max(Math.abs(d.x - b.x), Math.abs(d.z - b.z)) - SHELL - 0.2);
    }
    const fits = room / CROWN;
    if (fits < 0.7) decor.splice(i, 1);
    else if ((d.scale || 1) > fits) d.scale = fits;
  }

  const mist = buildMist(group, mistCells);

  const zones = buildZones(group, groundY, groundHoles, hoodBox && {
    x0: hoodBox.x0 * CELL - HALF, x1: hoodBox.x1 * CELL + HALF, z0: hoodBox.z0 * CELL - HALF, z1: hoodBox.z1 * CELL + HALF,
  });
  buildDecals(zones.surface, decals, materials);
  if (skyHoles.length) zones.deep.add(buildSkyHoles(skyHoles));
  // Blades on every grass surface laid above; must run before the batcher
  // merges its geometry away.
  const grass = buildGrass({
    groups: batcher.groups, instances, colliders, layout, rooms, materials, cell: CELL, biomeOf: grassBiome,
  });
  zones.surface.add(grass);
  const batches = new StaticBatches();
  const regionOf = regions(hoodBox);
  const stats = batcher.finish(batches, regionOf);
  if (instances) {
    markIndoorAssets(assets);
    const placed = instances.finish(group, batches, regionOf);
    stats.triangles += placed.triangles;
    stats.instanced = placed.triangles;
  }
  stats.meshes = batches.finish(zones.route);
  stats.clutter = clutter;
  return { group, colliders, platforms, lights, portals, doors, rooms, decor, mist, horizon, stats, zones, grass };
}

/** Which of grass.js's biomes a room's ground grows. */
function grassBiome(room) {
  if (isShire(room)) return 'shire';
  if (room.areaFile === 'grave.are') return 'grave';
  if (isPark(room)) return 'park';
  if (room.sector === SECTOR.HILLS) return 'hills';
  if (room.sector === SECTOR.FIELD) return 'meadow';
  return 'verge';
}

// --------------------------------------------------------------- zones ----

/**
 * Which batch a chunk's contents are drawn in.
 *
 * A region is 64 cells a side, 832 m -- most of the town in one. That is not
 * as coarse as it sounds: inside a region a chunk's built geometry and every
 * odd prop are still culled one by one, and what repeats is instanced, which
 * the GPU draws faster than it can be culled. Measured against 16 and 32
 * cells, 64 was fastest in every heavy view (barn facing south 18.9 ms at 16,
 * 14.9 at 32, 15.4 at 64 with fewer draws; Market Square facing south 16.9,
 * 13.3, 12.1). Underground and the neighborhood keep regions of their own, so
 * the zones below can still hide them whole. Region keys start with the zone:
 * `d` underground, `h` the neighborhood, `s` the rest of the surface.
 */
const REGION = 64;

/**
 * Underground regions are smaller, because from the street only the one
 * under a stair can be seen: see `ZONE_SHAFT_VIEW`.
 */
const DEEP_REGION = 16;

function regions(hoodBox) {
  const inHood = (x, z) => !!hoodBox && x >= hoodBox.x0 && x <= hoodBox.x1 && z >= hoodBox.z0 && z <= hoodBox.z1;
  return (chunk) => {
    const m = /^(-?\d+):(h?)(-?\d+),(-?\d+)$/.exec(chunk);
    if (!m) return `s:${chunk}`;
    const level = Number(m[1]);
    const span = m[2] ? 8 : 4;
    const x = Number(m[3]) * span; const z = Number(m[4]) * span;
    if (level < 0) return `d:${Math.floor(x / DEEP_REGION)},${Math.floor(z / DEEP_REGION)}`;
    const rx = Math.floor(x / REGION); const rz = Math.floor(z / REGION);
    // Upper storeys over the neighborhood's streets are chunked like the
    // town's; they belong with the district all the same.
    if (m[2] || inHood(x + span / 2, z + span / 2)) return `h:${rx},${rz}`;
    return `s:${rx},${rz}`;
  };
}

/**
 * What is underground and what is not, drawn only where it can be seen.
 *
 * Frustum culling does not know about the ground. From the Market Square the
 * sewer's chunks are right there in the view frustum, a few metres below the
 * paving, and with the sewer loaded every one of them was drawn: 723 draw
 * calls became 1,708 for a view that shows not one pixel of it. The reverse
 * holds down there, where the whole town is overhead and none of it visible.
 *
 * So the world splits in two, and each half is shown when the camera could
 * see into it: the underground when the eye is below the ground plane, the
 * surface when it is above -- and both near a stair that goes through the
 * ground, where you can look up or down the shaft. The sensor is how the check
 * gets the camera without the render loop having to know any of this: an
 * empty mesh that is never culled, whose onBeforeRender sees the camera every
 * frame. The decision lands a frame late, which is invisible, because the half
 * being hidden is the half with a vault or a street between it and the eye.
 */
const ZONE_SHAFT_REACH = 10;
/** How far from the eye an underground region must reach to be drawn through a shaft. */
const ZONE_SHAFT_VIEW = 40;

function buildZones(group, groundY, openings, district = null) {
  const surface = new THREE.Group();
  surface.name = 'surface';
  const deep = new THREE.Group();
  deep.name = 'underground';
  group.add(surface, deep);
  // The neighborhood, inside the surface: see DISTRICT_REACH.
  const hood = new THREE.Group();
  hood.name = 'district';
  surface.add(hood);
  const centres = openings.map((r) => ({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }));
  const reach2 = ZONE_SHAFT_REACH * ZONE_SHAFT_REACH;
  // The underground by region, each with the ground it lies under.
  const deepRegions = [];
  const deepRegion = (key) => {
    let entry = deepRegions.find((r) => r.key === key);
    if (!entry) {
      const [rx, rz] = key.slice(2).split(',').map(Number);
      const span = DEEP_REGION * CELL;
      const group = new THREE.Group();
      group.name = `underground ${key.slice(2)}`;
      deep.add(group);
      entry = {
        key, group,
        x0: rx * span - HALF, x1: (rx + 1) * span - HALF, z0: rz * span - HALF, z1: (rz + 1) * span - HALF,
      };
      deepRegions.push(entry);
    }
    return entry.group;
  };
  const view2 = ZONE_SHAFT_VIEW * ZONE_SHAFT_VIEW;
  const update = (eye) => {
    const below = eye.y < groundY - 0.25;
    const shaft = centres.some((c) => (c.x - eye.x) ** 2 + (c.z - eye.z) ** 2 < reach2);
    deep.visible = below || shaft;
    surface.visible = !below || shaft;
    // Down a stair from the street you see the stair and the room at its
    // foot, not the sewer a hundred metres off that frustum culling would
    // draw anyway: 176 draw calls of it from the graveyard's tomb path.
    for (const r of deepRegions) {
      const dx = Math.max(r.x0 - eye.x, 0, eye.x - r.x1);
      const dz = Math.max(r.z0 - eye.z, 0, eye.z - r.z1);
      r.group.visible = below || dx * dx + dz * dz < view2;
    }
    if (district) {
      const dx = Math.max(district.x0 - eye.x, 0, eye.x - district.x1);
      const dz = Math.max(district.z0 - eye.z, 0, eye.z - district.z1);
      hood.visible = dx * dx + dz * dz < DISTRICT_REACH * DISTRICT_REACH || eye.y > DISTRICT_ABOVE;
    }
  };
  const sensor = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }),
  );
  sensor.name = 'zone sensor';
  sensor.frustumCulled = false;
  sensor.onBeforeRender = (renderer, scene, camera) => update(camera.position);
  // **The sun's shadow map must see both halves, whatever the eye can.** The
  // ground is what keeps the sun out of the sewer, and with the surface hidden
  // the next shadow redraw left it out: the sun went straight through the
  // town and lit a lair three levels down at 111 of luminance against the 30
  // it reads with the ground in the map (measured at #7282, noon). The reverse
  // bit on the way up -- a town with no shadows until the next 6 m redraw.
  // The shadow pass walks the tree in order and this sensor is the first
  // child, so showing both here, before it reaches them, is enough; the main
  // pass puts the eye's own answer back.
  sensor.castShadow = true;
  sensor.onBeforeShadow = () => {
    surface.visible = true; deep.visible = true; hood.visible = true;
    for (const r of deepRegions) r.group.visible = true;
  };
  group.children.unshift(sensor);
  sensor.parent = group;
  return {
    surface, deep, update,
    route: (region) => (region.startsWith('d:') ? deepRegion(region) : region.startsWith('h:') && district ? hood : surface),
  };
}

/**
 * How near the neighborhood you have to be for it to be drawn. It sits off
 * the town's south-east corner at the far end of Wall Road, behind the whole
 * town from the Market Square -- and frustum culling drew all of it from
 * there anyway: 2,116 draw calls for nothing on screen (measured by hiding
 * it: 0 pixels changed facing it from #3014, 214 m off, and 0 from the top of
 * Wall Road, 183 m off, where the road's jog at the river hides it). It comes
 * into sight round that jog, 58 m off, so 180 m is well clear of any pop;
 * from above the roofs the whole of it is drawn.
 */
const DISTRICT_REACH = 180;
const DISTRICT_ABOVE = 40;

/** The neighborhood's cells, with a ring of two for the houses round it. */
function hoodBounds(layout) {
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  for (const cell of layout.order) {
    if (!isHood(cell.room) || cell.level !== 0) continue;
    x0 = Math.min(x0, cell.x); x1 = Math.max(x1, cell.x);
    z0 = Math.min(z0, cell.z); z1 = Math.max(z1, cell.z);
  }
  return x0 === Infinity ? null : { x0: x0 - 2, x1: x1 + 2, z0: z0 - 2, z1: z1 + 2 };
}

/**
 * The modelled room kits: panels, corners, roofs and the temple's columns.
 * Every one of them is placed under `kit !== null`, which is gated on the cell
 * *not* being open air, so an instance of one is inside a building by
 * construction.
 *
 * They need the same `aIndoor` flag `Batcher` writes, and they cannot get it
 * per instance: `InstanceBatch` hands one shared geometry to every
 * `InstancedMesh` built from an asset, so a per-instance attribute would have
 * to clone it per chunk. Marking the geometry itself is exact here and costs
 * one float a vertex, once. This is also the half of the temple that matters:
 * its walls, ceiling and columns are all kit, so before this the interior read
 * 139 mean at noon with the batched marble floor already flagged -- an up-facing
 * floor takes nothing from a hemisphere whose sky half is black.
 */
const INDOOR_ASSETS = [
  'wall_solid', 'wall_door', 'wall_corner', 'wall_roof',
  'temple_wall_solid', 'temple_wall_door', 'temple_corner', 'temple_roof', 'temple_column',
  // Seven metres under the street there is no sunlit ground to bounce off.
  'sewer_tunnel', 'sewer_arm', 'sewer_hub', 'sewer_hub_end', 'sewer_chamber', 'sewer_chamber_air', 'sewer_shaft',
  'sewer_wall_open', 'sewer_wall_solid', 'sewer_shaft_open', 'sewer_shaft_solid', 'sewer_door_end',
  'cave_wall', 'cave_wall_door', 'cave_wall_long', 'cave_wall_long_door', 'cave_roof',
];

function markIndoorAssets(assets) {
  for (const name of INDOOR_ASSETS) {
    const asset = assets.get(name);
    if (!asset) continue;
    for (const primitive of asset.primitives) {
      const geo = primitive.geometry;
      if (geo.getAttribute('aIndoor')) continue;
      const count = geo.getAttribute('position').count;
      geo.setAttribute('aIndoor', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1));
    }
  }
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
function buildIndoorWall({ batcher, chunk, mats, x, y, z, rotY, open, kit, instances, width, addCollider, dir, room, lights, decor, cellX, cellZ, breach = false, unlit = false }) {
  const gap = open ? DOOR_W : 0;
  const eave = CEIL + 1.1;
  const [dx, , dz] = DIR_STEP[dir];
  const along = dir === 1 || dir === 3;

  // A modelled panel spans the whole wall and carries its own doorway, so the
  // two procedural skins are skipped -- but the colliders below are unchanged,
  // because they describe the wall line, not the geometry sitting on it.
  if (kit !== null && kit !== undefined && instances) {
    instances.add(`${kit}${open ? (breach ? 'wall_breach' : 'wall_door') : 'wall_solid'}`, {
      x: cellX + dx * KIT_LINE, y, z: cellZ + dz * KIT_LINE, rotY: FACE_ROT[dir],
    }, chunk);
  }

  for (const skin of (kit !== null && kit !== undefined && instances ? [] : [
    { name: mats.wallIn, t: WALL_IN, offset: WALL_IN / 2, height: CEIL, tint: mats.wallInTint },
    // `uv` is undefined for every room but a smial, and undefined falls through
    // to the material's own tile inside `Batcher.add`.
    { name: mats.wallOut, t: WALL_OUT, offset: WALL_IN + WALL_OUT / 2, height: eave, uv: mats.wallUv },
  ])) {
    const sx = x + dx * skin.offset;
    const sz = z + dz * skin.offset;
    if (!gap) {
      batcher.add(box(width, skin.height, skin.t, 3, 4, 1), skin.name,
        place(sx, y + skin.height / 2, sz, rotY), { chunk, ao: wallAo(y), uvScale: skin.uv, tint: skin.tint });
      continue;
    }
    const sideW = (width - gap) / 2;
    for (const s of [-1, 1]) {
      const offset = s * (gap + sideW) / 2;
      batcher.add(box(sideW, skin.height, skin.t, 2, 4, 1), skin.name,
        place(sx + (along ? 0 : offset), y + skin.height / 2, sz + (along ? offset : 0), rotY),
        { chunk, ao: wallAo(y), uvScale: skin.uv, tint: skin.tint });
    }
    const lintel = skin.height - DOOR_H;
    if (lintel > 0.05) {
      batcher.add(box(gap, lintel, skin.t, 2, 1, 1), skin.name,
        place(sx, y + DOOR_H + lintel / 2, sz, rotY), { chunk, ao: () => 0.72, uvScale: skin.uv, tint: skin.tint });
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

  // The sewer lights itself from its prose (`sewerDressing`): a torch on
  // every wall of every INSIDE room put four of them in "Mid-air", a cave
  // with nothing in it but the fall.
  if (room.sector !== SECTOR.INSIDE || isDeep(room) || unlit) return;
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
function buildCityFrontage({ batcher, instances, model, chunk, room, cell, pos, sides, addCollider, decor, doors, lights = [], decals = null, turf = null }) {
  if (!wantsFrontage(room)) return;
  const isOpen = (d) => {
    const side = sides[d];
    return !!(side && (side.kind === 'alley' || side.kind === 'portal' || side.kind === 'gate'));
  };
  const inset = HALF - FRONTAGE_D / 2;
  const shire = isShire(room);

  const hood = !!hoodStyle(room);
  // "All the shops and homes have been boarded up and abandoned."
  const graffiti = hood && HOOD_GRAFFITI.test(room.description);
  const features = hood ? hoodFeatures(room, sides) : new Map();
  const fenced = hoodFenceDir(room);
  const block = (bx, bz, sx, sz, salt, face = -1) => {
    const seed = hash3(cell.x * 7 + Math.round(bx), cell.z * 7 + Math.round(bz), cell.level, salt);
    const h = 6.2 + seed * 4.6;
    // In the neighborhood every front is masonry: a boarded window nailed
    // over half-timbering's painted braces read as a sticker.
    const stone = hood || hash3(Math.round(bx), Math.round(bz), cell.level, 61) > 0.45;
    const marble = face >= 0 && features.get((face + 2) % 4) === 'marble';
    batcher.add(box(sx, h, sz, 3, 4, 3), marble ? 'marble' : stone ? (hood ? 'sootwall' : 'stonewall') : 'timber',
      place(bx, pos.y + h / 2, bz), { chunk, ao: wallAo(pos.y) });
    const roofH = 1.7 + seed * 1.4;
    // `triPrism` puts its cross-section on local X and its ridge on local Z,
    // and a quarter turn maps local Z to world X -- so under rotation the two
    // extents have to swap as well. They did not, and the roof came out with
    // its cross-section and its length exchanged: measured on Poor Alley, a
    // 13 x 3.2 m block on a street's north side carried a roof 3.9 m across
    // the block and 13.7 m along it. That is 5.25 m of tiling hanging over the
    // street on each side -- past the room's own centre -- with 4.55 m of wall
    // left bare at each end, and it photographs as a slab floating over the
    // lane. `cottage` below already got this right; `block` never did.
    const wide = sx > sz;
    // A burnt roof in the neighborhood is a black one.
    batcher.add(triPrism((wide ? sz : sx) + 0.7, roofH, (wide ? sx : sz) + 0.7),
      hood && seed < 0.2 ? 'charred' : seed > 0.86 ? 'thatch' : 'rooftile',
      place(bx, pos.y + h, bz, wide ? Math.PI / 2 : 0), { chunk });
    addCollider(bx - sx / 2, bx + sx / 2, bz - sz / 2, bz + sz / 2, pos.y, pos.y + h);
    if (hood) {
      // Boarded, dark, and painted on, in place of the lit casements.
      if (face >= 0) {
        hoodFrontage({
          instances, chunk, addCollider, decals, lights, turf, graffiti, room, bx, bz, sx, sz, y0: pos.y, h, face,
          seed: hash3(cell.x, cell.z, face, 1061), feature: features.get((face + 2) % 4) || null,
        });
      }
      return;
    }
    // A blank three-storey wall along the street was reported; give it openings.
    decor.push({ kind: 'windows', x: bx, y: pos.y, z: bz, w: sx, d: sz, h, seed, frame: stone || marble ? 'stone' : 'timber' });
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
    decor.push({ kind: 'windows', x: bx, y: pos.y, z: bz, w: sx, d: sz, h, seed, frame: 'timber' });
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
      // An apron at the toe. A turf bank standing on bare street paving is a
      // hill that begins on a kerbstone -- the join is a clean ellipse on
      // cobble, and it was reported. Patches rather than a gradient, for the
      // same reason `buildVerges` uses them: a fade would only move the line.
      // Each patch is turned and sized by its own hash, so the grass runs out
      // into the lane by a different amount everywhere along the bank.
      for (let i = 0; i < 4; i++) {
        const seed = (k) => hash3(cell.x * 13 + Math.round(a), cell.z * 13 + dir, i, 240 + k);
        const size = 1.6 + seed(0) * 2.2;
        const p = at(a + (seed(1) - 0.5) * len, inset - depth / 2 - seed(2) * 1.5);
        batcher.add(plane(size, size, 2), 'grass',
          place(p.x, pos.y + 0.02, p.z, seed(3) * Math.PI * 2), { chunk, uvScale: TURF_UV });
      }
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
    if (dir === fenced) {
      // The cemetery's railings stand where a house front would.
      buildIronFence({ instances, model, chunk, x: pos.x, y: pos.y, z: pos.z, dir, addCollider });
      continue;
    }
    if (!shire) { block(bx, bz, sx, sz, 62 + dir, (dir + 2) % 4); continue; }
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
 * Party walls: what turns a row of detached houses into a street.
 *
 * A room cell's own frontage block spans the full 13 m of its side, so those
 * join. A *filler* cell -- the empty cell beside a street that gets a modelled
 * house -- does not: the model is fit-scaled to 92% of the cell on its longest
 * side and capped at 1.15, so a house typically finishes around 9 m and leaves
 * a couple of metres of nothing at each end of its cell. Two of them side by
 * side is a 4-8 m hole with sky in it, and a judge counted one between every
 * pair down Main Street. Historic streets do not do that: where the buildings
 * do not touch, a wall does, and the frontage reads as one continuous line
 * with roofs of different heights over it.
 *
 * So each filler cell lays half a wall along the street from its own centre to
 * each edge whose neighbour is another filler cell fronting the *same* street.
 * Two halves meet at the boundary. Nothing is built towards a cell that is a
 * room or a routed passage, which is what keeps every way through open --
 * `faces` is by definition the one direction out of the cell that is walkable,
 * and the wall never runs that way.
 *
 * A yard wall with a coping: high enough to stop the sky in the slot, low
 * enough that it reads as a wall against a three-storey house and not as
 * another storey.
 *
 * **What this cannot fix, measured.** Down Main Street it lays nothing at all,
 * and that is correct: of the eleven cells flanking #3012-#3016, *nine are
 * routed passages* -- the ways to the bakery, the armoury, the magic shop and
 * the guild, whose rooms sit two cells back because rooms only ever take even
 * coordinates. So the 13 m gaps a judge photographed between the houses there
 * are the mouths of those passages, and walling them is walling the town shut.
 * The islands this does close are everywhere the frontage is real: 87
 * boundaries over the default five areas.
 */
const PARTY_H = 3.3;
const PARTY_T = 0.45;
const PARTY_SPAN = 5.2;
/**
 * How far towards the street, from the building cell's centre. An indoor room's
 * outer skin is at SHELL, so this is flush with the shells that line most of
 * Midgaard; a filler house fronts a metre or so behind it, and a low wall
 * standing a metre proud of a house is a forecourt wall, which is the right way
 * to be wrong. The cell edge is at HALF, so nothing here ever reaches the
 * street cell next door.
 */
const PARTY_OUT = SHELL + 0.2;

function buildPartyWalls({ batcher, frontage, addCollider, layout, rooms, streetCells }) {
  /**
   * What counts as a building beside a street. Three kinds line one here and
   * they are not the same shape: an indoor room is an 11.4 m shell in a 13 m
   * cell, a filler cell is a fit-scaled model around 9 m, and a room's own
   * frontage block spans the full 13 and needs no help. A path cell and an
   * open-air room are not buildings -- they are the street, or another street.
   */
  const building = (level, x, z) => {
    // `layout.at` answers with a vnum, not a cell.
    const vnum = layout.at(level, x, z);
    if (vnum !== undefined) {
      const info = rooms.get(vnum);
      return !!info && !info.unbuilt && !isOpenAir(info.room);
    }
    if (layout.isPath(level, x, z)) return false;
    const spot = frontage.get(`${level}:${x},${z}`);
    return !!spot && !spot.bog && !spot.shire && spot.sector === SECTOR.CITY;
  };

  const done = new Set();
  for (const s of streetCells) {
    for (let p = 0; p < 4; p++) {
      const [pdx, , pdz] = DIR_STEP[p];
      const nx = s.x + pdx; const nz = s.z + pdz;
      if (!building(s.level, nx, nz)) continue;
      // The street runs across the way this building faces it.
      for (const a of (pdx ? [0, 2] : [1, 3])) {
        const [adx, , adz] = DIR_STEP[a];
        if (!building(s.level, nx + adx, nz + adz)) continue;
        // One wall to a boundary, however many street cells can see it.
        const key = `${s.level}|${Math.min(nx, nx + adx)},${Math.min(nz, nz + adz)}|${p}`;
        if (done.has(key)) continue;
        done.add(key);

        const y = s.level * LEVEL_H;
        const h = PARTY_H + hash3(nx + adx, nz + adz, s.level, 78) * 0.9;
        // Out to the frontage line -- an indoor shell's outer face is at SHELL,
        // so this is flush with it -- and centred on the boundary between the
        // two buildings, which is where the hole is.
        const wx = nx * CELL - pdx * PARTY_OUT + adx * HALF;
        const wz = nz * CELL - pdz * PARTY_OUT + adz * HALF;
        // Long enough to bury itself in whatever stands either side, whether
        // that leaves 1.6 m of gap or 3.8. It is a low wall against a
        // three-storey house, so overlapping one costs nothing.
        const [sx, sz] = pdx ? [PARTY_T, PARTY_SPAN] : [PARTY_SPAN, PARTY_T];
        const chunk = `${s.level}:${Math.floor(nx / 4)},${Math.floor(nz / 4)}`;
        batcher.add(box(sx, h, sz, 1, 2, 3), 'stonewall',
          place(wx, y + h / 2, wz), { chunk, ao: wallAo(y) });
        // A coping is what stops a wall reading as a slab standing on edge.
        const [cw, cd] = pdx ? [PARTY_T + 0.16, PARTY_SPAN] : [PARTY_SPAN, PARTY_T + 0.16];
        batcher.add(box(cw, 0.14, cd), 'stonewall',
          place(wx, y + h + 0.07, wz), { chunk, ao: () => 0.95 });
        addCollider(wx - sx / 2, wx + sx / 2, wz - sz / 2, wz + sz / 2, y, y + h);
      }
    }
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
function buildShopSign({ room, pos, sides, instances, model, chunk, decor, lights }) {
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
  const placed = {
    x: pos.x + dx * SHELL + (dx ? 0 : along),
    y: pos.y + Math.max(0, SIGN_CLEAR - bottom),
    z: pos.z + dz * SHELL + (dz ? 0 : along),
    // `FACE_ROT` turns a model's -z towards a direction; the arm reaches the
    // other way, so half a turn past that swings it out over the street.
    rotY: FACE_ROT[dir] + Math.PI,
  };
  instances.add(sign, placed, chunk);
  // And a lantern on the wall between the sign and the door, so the board can
  // be read after dark: nothing lit any of them, and a judge found every sign
  // in town a dark blank at night. Off the board's own plane, or a light level
  // with the board strikes both painted faces edge-on and lights neither.
  const lantern = model(['wall_lantern'], 0);
  if (lantern) {
    const back = -Math.sign(along) * 0.85;
    const lx = pos.x + dx * SHELL + (dx ? 0 : along + back);
    const lz = pos.z + dz * SHELL + (dz ? 0 : along + back);
    instances.add(lantern, { x: lx, y: pos.y, z: lz, rotY: placed.rotY }, chunk);
    // The lantern's box hangs 0.4 m out and 2.8 m up.
    lights.push({
      x: lx + dx * 0.4, y: pos.y + 2.8, z: lz + dz * 0.4,
      color: 0xffb566, intensity: 6, radius: 7, flicker: true, outdoor: true,
    });
  }
  // actors.js paints the shop's name on the board (its `shopSigns`).
  decor.push({ kind: 'shopSign', vnum: room.vnum, name: room.name, ...placed });
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

function buildForest({ room, pos, sides, instances, model, chunk, decor, addCollider, dense = false, keepOut = null }) {
  const clears = edgeClear(sides, FOREST_CLEAR);
  const clear = keepOut
    ? (lx, lz) => !(pos.x + lx > keepOut.x0 && pos.x + lx < keepOut.x1
      && pos.z + lz > keepOut.z0 && pos.z + lz < keepOut.z1)
    : () => true;
  const open = (lx, lz) => Math.hypot(lx, lz) >= FOREST_MIDDLE && clears(lx, lz) && clear(lx, lz);
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

  // Coarse woody debris. In an old coastal stand about two thirds of the dead
  // wood is lying on the ground rather than standing, and a forest floor with
  // none of it reads as a plantation. Two to four pieces a room. `open`
  // already keeps the middle of the room and every way out of it clear, so
  // nothing ever lies across a trail or where the player arrives.
  const log = model(['dead_log'], 0);
  if (log) {
    const n = 2 + Math.floor(hash3(room.vnum, 0, 0, 120) * 3);
    for (let i = 0; i < n; i++) {
      const angle = ((i + hash3(room.vnum, i, 0, 121)) / n) * Math.PI * 2;
      const radius = 3.9 + hash3(room.vnum, i, 1, 121) * 1.9;
      const lx = Math.cos(angle) * radius;
      const lz = Math.sin(angle) * radius;
      if (!open(lx, lz)) continue;
      instances.add(log, {
        x: pos.x + lx, y: pos.y, z: pos.z + lz,
        rotY: hash3(room.vnum, i, 2, 121) * Math.PI * 2,
        // Rot as well as size: a log that fell last winter and one that has
        // been going back into the duff for thirty years are not the same log.
        scale: 0.75 + hash3(room.vnum, i, 3, 121) * 0.85,
      }, chunk);
    }
  }

  scatterUndergrowth({
    instances, chunk, x: pos.x, y: pos.y, z: pos.z,
    rand: (i, k, salt) => hash3(room.vnum, i, k, salt),
    clears: open,
    kinds: [
      // Sword fern holds about 37% cover in a coastal stand and it was the
      // thinnest thing on this floor: four to eight clumps over 169 m2 is a
      // few per cent. The grass tufts come down to make room, because grass
      // is what a fir stand does not have.
      { name: model(['fern'], 0), count: (dense ? 11 : 8) + Math.floor(hash3(room.vnum, 0, 0, 103) * 5), ring: 4.3, spread: dense ? 3.2 : 2.6, size: 1.0, salt: 110 },
      { name: salal, count: (dense ? 5 : 4) + Math.floor(hash3(room.vnum, 1, 0, 103) * 3), ring: 4.9, spread: 1.8, size: 1.0, salt: 111 },
      { name: model(['grass_tuft'], 0), count: (dense ? 4 : 3) + Math.floor(hash3(room.vnum, 2, 0, 103) * 3), ring: 4.4, spread: 2.0, size: 1.0, salt: 112 },
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

// ---------------------------------------------------------------- cabin ----

/**
 * A room that stands outside a cabin, with the cabin's own door in it.
 *
 * Haon Dor's #6009 is the case, and its description is the instruction: "You
 * are outside a small cabin built entirely from heavy logs.  There is a wooden
 * door to the north."  The mud puts a real door on that exit (`D0 ... 1 -1
 * 6010`, closed by its own reset), so the viewer hung two 3.2 m leaves at the
 * cell boundary -- and there was no building behind them, because the room the
 * door leads to is a separate cell fourteen metres further north. Two door
 * leaves standing in a wood is what a judge reported, twice.
 */
const CABIN = /\bcabins?\b/i;

/**
 * `log_cabin`, measured off the file rather than assumed.
 *
 * Blender puts the origin on the floor, and glTF is written y-up, so the model
 * runs x +/-3.454, y 0..4.244, z +/-2.67 (wall centrelines 5.5 x 4.5, log ends
 * proud to +/-3.05/+/-2.55, wall head 2.40, ridge 4.10). The doorway is the
 * void in the **+Z** gable: clear from x -0.50 to +0.50, lintel at 1.988, wall
 * plane at z = 2.25.
 *
 * That face had to be found by sampling the triangle surfaces, not by counting
 * vertices in a box. A log wall is full-width logs whose vertices sit only at
 * their ends, so a vertex census says the solid gable is a hole and the walled
 * flank is a door -- the same trap that made the "black bar" hunts go wrong,
 * in a different costume.
 */
const CABIN_HALF_X = 3.454;
const CABIN_WALL = 2.25;        // the door wall's plane, from the model centre
const CABIN_FLANK = 2.75;       // the side walls' plane
const CABIN_HEAD = 2.40;        // wall head; the ridge is 4.10
const CABIN_DOOR_W = 1.00;
const CABIN_DOOR_H = 1.988;
/** Wall thickness, for colliders that sit on the logs rather than inside them. */
const CABIN_SKIN = 0.30;

/**
 * Drop the cabin the room says you are standing outside of.
 *
 * Placed so its door wall lands exactly on the plane where the viewer already
 * hangs that door -- `HALF - 0.3` out from the room centre -- and turned so the
 * +Z gable looks back at the arrival point. `FACE_ROT[dir]` turns a model's -Z
 * towards `dir`, which is the same rotation, so the two conventions meet.
 * Nothing about the door moves; the opening around it shrinks from a 3.2 m
 * gateway to the 1.00 x 1.99 m the model actually has.
 *
 * The body therefore sits mostly in the cell *beyond* the room, which is the
 * routed passage to the interior. That is on purpose and it is what a player
 * sees: from the arrival point the shell subtends 28 degrees against the 15
 * the room beyond subtends, so the cabin hides the walled box that room builds
 * for itself instead of standing next to it. Nothing here tries to be that
 * room's interior -- it is a separate cell, and the mud's own exit still takes
 * you there.
 *
 * Colliders go on the four walls with the doorway left open, so the door is
 * something you walk up to and, once it is open, step through.
 */
function buildCabin({ instances, model, chunk, room, pos, sides, addCollider }) {
  if (!instances) return null;
  const name = model(['log_cabin'], 0);
  if (!name) return null;
  // Which way the cabin faces is the mud's answer: the side whose exit carries
  // a door. A room that says "cabin" with no door in it gets nothing.
  const dir = [0, 1, 2, 3].find((d) => sides[d] && sides[d].exit
    && (sides[d].exit.locks & EX_ISDOOR));
  if (dir === undefined) return null;

  // Read the sit height off the model rather than trusting the convention: a
  // regenerated cabin whose origin is not on its floor should stand on the
  // ground, not half in it.
  const bounds = instances.library.get(name)?.bounds;
  const lift = bounds ? -Math.min(0, bounds.min.y) : 0;

  const [dx, , dz] = DIR_STEP[dir];
  const out = HALF - 0.3 + CABIN_WALL;
  const cx = pos.x + dx * out;
  const cz = pos.z + dz * out;
  instances.add(name, { x: cx, y: pos.y + lift, z: cz, rotY: FACE_ROT[dir] }, chunk);

  // Local frame: `a` runs along the door wall, `o` outward from the room. The
  // model's +Z looks back at the room, so `o` runs along -DIR_STEP.
  const acrossZ = dz !== 0;
  const wall = (a0, a1, o0, o1) => {
    if (acrossZ) {
      const p = cz - dz * o0; const q = cz - dz * o1;
      addCollider(cx + a0, cx + a1, Math.min(p, q), Math.max(p, q), pos.y, pos.y + CABIN_HEAD);
    } else {
      const p = cx - dx * o0; const q = cx - dx * o1;
      addCollider(Math.min(p, q), Math.max(p, q), cz + a0, cz + a1, pos.y, pos.y + CABIN_HEAD);
    }
  };
  const jamb = CABIN_DOOR_W / 2;
  wall(-CABIN_HALF_X, -jamb, CABIN_WALL - CABIN_SKIN, CABIN_WALL);
  wall(jamb, CABIN_HALF_X, CABIN_WALL - CABIN_SKIN, CABIN_WALL);
  wall(-CABIN_HALF_X, CABIN_HALF_X, -CABIN_WALL, -CABIN_WALL + CABIN_SKIN);
  for (const s of [-1, 1]) {
    const inner = s * (CABIN_FLANK - CABIN_SKIN / 2);
    const outer = s * (CABIN_FLANK + CABIN_SKIN / 2);
    wall(Math.min(inner, outer), Math.max(inner, outer), -CABIN_WALL, CABIN_WALL);
  }

  return {
    dir, width: CABIN_DOOR_W, height: CABIN_DOOR_H,
    // The footprint in world space, so nothing else furnishes the ground the
    // cabin is standing on. It straddles a cell boundary, and the passage cell
    // behind it stacks barrels against its walls otherwise.
    rect: acrossZ
      ? { x0: cx - CABIN_HALF_X, x1: cx + CABIN_HALF_X, z0: cz - CABIN_WALL, z1: cz + CABIN_WALL }
      : { x0: cx - CABIN_WALL, x1: cx + CABIN_WALL, z0: cz - CABIN_HALF_X, z1: cz + CABIN_HALF_X },
  };
}

// --------------------------------------------------------- worked ground ----

/**
 * A clearing somebody has been felling in: cut stumps, and logs stacked on
 * stakes.
 *
 * Haon Dor's #6008 is the case and its description is a construction drawing
 * nothing was reading: "Lots of fresh stumps of varying sizes protrude from
 * the ground and heavy logs are stacked neatly in a big pile supported by
 * stakes set into the ground."  The room's own extra descriptions carry the
 * detail -- the logs are "chopped to shorter pieces... quite heavy as they are
 * fresh and still filled with sap", the stakes "keep the logs from rolling
 * down", and "some of the stumps are partly covered in moss". Same move as
 * `readFittings`: where the prose names a fitting it is a placement
 * instruction, not scenery.
 */
const STUMPS = /\bstumps?\b/i;
const LOG_STACK = /\blogs?\b[^.]{0,140}?\bstacked\b|\bstacked\b[^.]{0,80}?\blogs?\b/i;

/** Nothing inside this of the centre: the player materialises there. */
const CLEARING_MIDDLE = 3.2;
/** How much of a side you can walk out of stays clear. */
const CLEARING_CLEAR = 2.2;

function buildClearing({ batcher, chunk, room, pos, sides, addCollider }) {
  const text = `${room.name}. ${room.description}`.replace(/\s+/g, ' ');
  const wantsStumps = STUMPS.test(text);
  const wantsPile = LOG_STACK.test(text);
  if (!wantsStumps && !wantsPile) return;

  const clears = edgeClear(sides, CLEARING_CLEAR);
  const free = (lx, lz) => Math.hypot(lx, lz) >= CLEARING_MIDDLE && clears(lx, lz);

  // The pile stands away from the ways out, the way a bog's pool does: sum the
  // exits and face the other way.
  let ax = 0; let az = 0;
  for (let d = 0; d < 4; d++) {
    if (!sides[d]) continue;
    const [dx, , dz] = DIR_STEP[d];
    ax += dx; az += dz;
  }
  const anchor = (ax || az) ? Math.atan2(-az, -ax) : hash3(room.vnum, 0, 0, 210) * Math.PI * 2;

  if (wantsPile) {
    const rho = 4.3;
    const px = Math.cos(anchor) * rho;
    const pz = Math.sin(anchor) * rho;
    if (free(px, pz)) {
      const spin = anchor + Math.PI / 2 + (hash3(room.vnum, 1, 0, 211) - 0.5) * 0.6;
      const r = 0.27;
      const len = 4.0;
      // Three courses, 3-2-1. Each course sits in the hollows of the one below,
      // which is what a stack of round timber does and why the rise between
      // courses is less than a diameter.
      [3, 2, 1].forEach((n, row) => {
        for (let i = 0; i < n; i++) {
          const across = (i - (n - 1) / 2) * (r * 2 + 0.05);
          const up = r + row * r * 1.74;
          const geo = new THREE.CylinderGeometry(
            r * (0.9 + hash3(room.vnum, row, i, 212) * 0.2), r, len, 9,
          );
          geo.rotateZ(Math.PI / 2);          // lay the log down along local X
          geo.translate(0, up, across);      // ...then stack it
          batcher.add(geo, 'bark', place(pos.x + px, pos.y, pos.z + pz, spin), { chunk });
          geo.dispose();
        }
      });
      // "The stakes keep the logs from rolling down." Two pairs, one at each
      // end, standing in the ground either side of the stack.
      const cos = Math.cos(spin); const sin = Math.sin(spin);
      const at = (a, b) => ({
        x: pos.x + px + cos * a + sin * b,
        z: pos.z + pz - sin * a + cos * b,
      });
      for (const a of [-len / 2 + 0.3, len / 2 - 0.3]) {
        for (const b of [-1.12, 1.12]) {
          const p = at(a, b);
          batcher.add(box(0.14, 2.0, 0.14), 'timber',
            place(p.x, pos.y + 0.9, p.z, spin), { chunk });
        }
      }
      // A stack of green timber is something you walk round. The box is the
      // rotated footprint's own extent, not a guess.
      const hx = Math.abs(cos) * (len / 2 + 0.3) + Math.abs(sin) * 1.3;
      const hz = Math.abs(sin) * (len / 2 + 0.3) + Math.abs(cos) * 1.3;
      addCollider(pos.x + px - hx, pos.x + px + hx, pos.z + pz - hz, pos.z + pz + hz,
        pos.y, pos.y + 1.6);
    }
  }

  if (!wantsStumps) return;
  // "Stumps of varying sizes", so the size varies: a stand is felled across a
  // range of ages and this is the difference between a clearing and a lawn
  // with cylinders on it. No colliders -- these are knee-high, and an
  // invisible wall you cannot step over is worse than walking through one.
  const n = 5 + Math.floor(hash3(room.vnum, 0, 0, 213) * 4);
  for (let i = 0; i < n; i++) {
    const angle = ((i + hash3(room.vnum, i, 0, 214)) / n) * Math.PI * 2;
    const rho = 3.6 + hash3(room.vnum, i, 1, 215) * 2.1;
    const lx = Math.cos(angle) * rho;
    const lz = Math.sin(angle) * rho;
    if (!free(lx, lz)) continue;
    // Keep out of the log pile.
    if (wantsPile && Math.hypot(lx - Math.cos(anchor) * 4.3, lz - Math.sin(anchor) * 4.3) < 2.8) continue;
    const r = 0.2 + hash3(room.vnum, i, 2, 216) * 0.34;
    const h = 0.22 + hash3(room.vnum, i, 3, 217) * 0.5;
    const trunk = new THREE.CylinderGeometry(r * 0.96, r, h, 10);
    trunk.translate(0, h / 2, 0);
    batcher.add(trunk, 'bark', place(pos.x + lx, pos.y, pos.z + lz), { chunk });
    trunk.dispose();
    // The sawn face on top: pale end grain, or moss on the older ones, which
    // is what the room's own extra description says separates them.
    const mossy = hash3(room.vnum, i, 4, 218) < 0.38;
    const cut = new THREE.CircleGeometry(r * 0.96, 10);
    cut.rotateX(-Math.PI / 2);
    batcher.add(cut, mossy ? 'grass' : 'planks',
      place(pos.x + lx, pos.y + h + 0.012, pos.z + lz), { chunk });
    cut.dispose();
  }
}

// ------------------------------------------------------------ gatehouse ----

/**
 * The towers every gate room in Midgaard has always described.
 *
 * All four gates say the same thing, in the room inside the wall and the room
 * outside it alike: "You are by two small towers that have been built into the
 * city wall and connected with a footbridge across the heavy wooden gate." The
 * extra descriptions go further -- the towers are "built from large grey rocks
 * that have been fastened to each other with some kind of mortar, just like the
 * city wall", and the footbridge "is too high up to reach but it looks as if
 * one easily could walk across it from one tower to the other."
 *
 * None of it was built. What stood there was the gate's own pair of leaves in
 * the middle of open paving: the same orphan-door fault as the cabin's, at the
 * other end of the map. The gatehouse frames the leaves the viewer already
 * hangs, so the plane, the rotation and the opening all come from the door and
 * nothing new has to agree with anything.
 *
 * It is built at *both* ends of the gate passage, because both rooms describe
 * it as being where they are, and each is 6.2 m from its own room centre --
 * the two are 40 m apart with the routed road between them, which reads as a
 * long gate through a thick wall rather than as one gatehouse in the wrong
 * place. The footbridge carries no collider: the mud says it is out of reach.
 */
const GATE_ROOM = /\bgate\b/i;
const GATE_TOWERS = /\btowers?\b/i;
const TOWER_W = 3.4;
const TOWER_H = 9.2;
const MERLON = 0.62;
/** Deck height: clear of the 3.1 m opening, and out of reach from the road. */
const BRIDGE_Y = 5.8;

function buildGatehouse({ batcher, chunk, pos, dir, addCollider }) {
  const [dx, , dz] = DIR_STEP[dir];
  const along = dir === 1 || dir === 3;      // the wall line runs along z
  const out = HALF - 0.3;                    // the plane the door hangs in
  const gx = pos.x + dx * out;
  const gz = pos.z + dz * out;
  // Local frame: `a` runs along the wall, `o` across it. Same convention the
  // Shire's `bank` uses, for the same reason.
  const at = (a, o) => (along
    ? { x: gx + dx * o, z: gz + a }
    : { x: gx + a, z: gz + dz * o });
  const span = (a, o) => (along ? [o, a] : [a, o]);

  for (const s of [-1, 1]) {
    const c = at(s * (DOOR_W / 2 + TOWER_W / 2), 0);
    const [sx, sz] = span(TOWER_W, TOWER_W);
    batcher.add(box(sx, TOWER_H, sz, 2, 5, 2), 'stonewall',
      place(c.x, pos.y + TOWER_H / 2, c.z), { chunk, ao: wallAo(pos.y) });
    addCollider(c.x - sx / 2, c.x + sx / 2, c.z - sz / 2, c.z + sz / 2, pos.y, pos.y + TOWER_H);
    // A corbelled string course under the parapet, then merlons on it. Without
    // the crenellation a tower is a pillar.
    const [cw, cd] = span(TOWER_W + 0.5, TOWER_W + 0.5);
    batcher.add(box(cw, 0.35, cd), 'stonewall',
      place(c.x, pos.y + TOWER_H + 0.175, c.z), { chunk, ao: () => 0.8 });
    const ring = (TOWER_W + 0.5) / 2 - MERLON / 2;
    for (const [ox, oz] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
      batcher.add(box(MERLON, 0.75, MERLON), 'stonewall',
        place(c.x + ox * ring, pos.y + TOWER_H + 0.72, c.z + oz * ring), { chunk });
    }
  }

  // The wall over the gate, carrying the footbridge: this is what makes the
  // towers read as built *into* a wall rather than standing beside a hole.
  const lintelH = BRIDGE_Y - 0.2 - (DOOR_H + 0.2);
  const lc = at(0, 0);
  const [lw, ld] = span(DOOR_W + TOWER_W, 1.5);
  batcher.add(box(lw, lintelH, ld), 'stonewall',
    place(lc.x, pos.y + DOOR_H + 0.2 + lintelH / 2, lc.z), { chunk, ao: () => 0.74 });

  const [bw, bd] = span(DOOR_W + TOWER_W, 2.0);
  batcher.add(box(bw, 0.4, bd), 'stonewall',
    place(lc.x, pos.y + BRIDGE_Y, lc.z), { chunk, ao: () => 0.7 });
  for (const s of [-1, 1]) {
    const p = at(0, s * 0.88);
    const [pw, pd] = span(DOOR_W + TOWER_W, 0.24);
    batcher.add(box(pw, 0.85, pd), 'stonewall',
      place(p.x, pos.y + BRIDGE_Y + 0.62, p.z), { chunk });
  }
}

// --------------------------------------------------------------- shore ----

/**
 * Where open water stops.
 *
 * A water room lays one plane over its whole cell, so the lake at #8315/#8316
 * met the dry marsh on the cell boundary: a razor-straight, axis-aligned line
 * 13 m long, which is the grid showing through as plainly as anything in the
 * world. Real open water has a margin -- peat slumping into it, a metre of mud
 * that is neither, reeds standing in the shallows.
 *
 * So every side of a water cell with dry land beyond it gets a bank: half a
 * dozen low peat domes strung along the edge and jittered in and out, which
 * breaks the line because no two of them reach the same distance. The water
 * plane laps over them rather than stopping at them -- `WATER_LAP` widens it --
 * so the meeting is a ragged edge of mud in shallow water and not a cut.
 *
 * Sides where the water carries on get nothing, or the lake would be a mosaic
 * of walled ponds.
 */
const SHORE_DOMES = 6;
const SHORE_H = [0.26, 0.52];
const SHORE_W = [2.3, 4.1];

function buildShore({ batcher, instances, model, chunk, room, pos, half, wet }) {
  const reed = instances ? model(['reed_clump', 'tussock', 'fern'], 0) : null;
  for (let d = 0; d < 4; d++) {
    if (wet(d)) continue;
    const [dx, , dz] = DIR_STEP[d];
    const along = dx !== 0;   // the bank runs across the cell, the other way
    for (let i = 0; i < SHORE_DOMES; i++) {
      const t = ((i + 0.5) / SHORE_DOMES - 0.5) * (half * 2 + 1.4)
        + (hash3(room.vnum, d * 8 + i, 0, 240) - 0.5) * 1.5;
      // How far in from the cell edge this lump reaches: the whole point is
      // that it is different for every one of them.
      const inward = 0.5 + hash3(room.vnum, d * 8 + i, 1, 241) * 1.9;
      const w = SHORE_W[0] + hash3(room.vnum, d * 8 + i, 2, 242) * (SHORE_W[1] - SHORE_W[0]);
      const h = SHORE_H[0] + hash3(room.vnum, d * 8 + i, 3, 243) * (SHORE_H[1] - SHORE_H[0]);
      const bx = pos.x + (along ? dx * (half - inward) : t);
      const bz = pos.z + (along ? t : dz * (half - inward));
      const geo = mound(w, h, w * (0.62 + hash3(room.vnum, d * 8 + i, 4, 244) * 0.5));
      batcher.add(geo, 'peat', place(bx, pos.y - 0.05, bz), { chunk });
      geo.dispose();
      if (!reed || hash3(room.vnum, d * 8 + i, 5, 245) < 0.42) continue;
      // Standing in the shallows at the foot of the bank, on the water side.
      const rx = bx - (along ? dx * 1.1 : 0);
      const rz = bz - (along ? 0 : dz * 1.1);
      instances.add(reed, {
        x: rx, y: pos.y, z: rz,
        rotY: hash3(room.vnum, d * 8 + i, 6, 246) * Math.PI * 2,
        scale: 0.85 + hash3(room.vnum, d * 8 + i, 7, 247) * 0.5,
      }, chunk);
    }
  }
}

// --------------------------------------------------------------- statue ----

/**
 * "A large, peculiar looking statue is standing in the middle of the square."
 *
 * The Market Square's own prose has said so since 1991 and there was nothing
 * there, which is the same class of fault as the graveyard's lawn: the mud
 * names a thing and the builder does not read it. Same move as `readFittings` --
 * the description is a placement instruction.
 *
 * Subject, not scenery: the sentence has to say the statue *is* here, so a room
 * that merely mentions one in passing does not grow one, and only out of doors,
 * because the temple's prose talks about statues of gods on its walls.
 *
 * Never at the room's exact centre, whatever the prose says -- that is where
 * the player arrives, and a fountain and a mobile have both been stood on
 * already. 2.6 m off reads as "the middle of the square" from every approach
 * and leaves the arrival point clear.
 */
const STATUE = /\bstatue\b[^.]{0,60}?\b(?:is|stands|standing|rises|towers)\b/i;

function buildStatue({ batcher, chunk, room, pos, sides, addCollider }) {
  // Away from the ways out, the same anchor the tomb's lid uses; on a square
  // with a way out on every side there is no such direction, so the room's own
  // number picks one and picks the same one every time.
  let ax = 0; let az = 0;
  for (let d = 0; d < 4; d++) {
    if (!sides[d]) continue;
    const [dx, , dz] = DIR_STEP[d];
    ax += dx; az += dz;
  }
  const anchor = (ax || az) ? Math.atan2(-az, -ax) : hash3(room.vnum, 3, 0, 230) * Math.PI * 2;
  const sx = pos.x + Math.cos(anchor) * 2.6;
  const sz = pos.z + Math.sin(anchor) * 2.6;
  const spin = anchor + Math.PI; // facing back across the square
  const y = pos.y;
  const put = (h) => place(sx, y + h, sz, spin);

  // Plinth: base, die, cap. 1.73 m of it, which is what a figure has to stand
  // on to be read as a monument rather than as a person who has stopped.
  batcher.add(box(2.0, 0.30, 2.0), 'stonewall', put(0.15), { chunk, ao: () => 0.9 });
  batcher.add(box(1.34, 1.25, 1.34, 2, 2, 2), 'stonewall', put(0.925), { chunk, ao: wallAo(y) });
  batcher.add(box(1.62, 0.18, 1.62), 'stonewall', put(1.64), { chunk, ao: () => 0.95 });

  // The figure, in marble against the plinth's masonry: robe, shoulders, head,
  // and the peculiar part -- one arm straight up and the other straight out,
  // which is what a statue nobody can identify looks like from a distance.
  const robe = new THREE.CylinderGeometry(0.30, 0.44, 1.02, 12);
  batcher.add(robe, 'marble', put(1.73 + 0.51), { chunk });
  robe.dispose();
  batcher.add(box(0.64, 0.62, 0.36, 2, 2, 1), 'marble', put(1.73 + 1.33), { chunk });
  const head = new THREE.SphereGeometry(0.19, 12, 8);
  batcher.add(head, 'marble', put(1.73 + 1.83), { chunk });
  head.dispose();
  // Raised arm, on the right of the figure's own facing.
  // Clear of the head, or it merges with the shoulders and the silhouette is
  // a chess piece.
  const arm = box(0.15, 0.86, 0.15);
  batcher.add(arm, 'marble',
    place(sx + Math.cos(spin + Math.PI / 2) * 0.30, y + 1.73 + 2.14,
      sz - Math.sin(spin + Math.PI / 2) * 0.30, spin), { chunk });
  // ...and one held out level, which is a bar of stone lying the other way.
  batcher.add(box(0.72, 0.15, 0.15), 'marble',
    place(sx + Math.cos(spin - Math.PI / 2) * 0.62, y + 1.73 + 1.44,
      sz - Math.sin(spin - Math.PI / 2) * 0.62, spin), { chunk });

  addCollider(sx - 1.0, sx + 1.0, sz - 1.0, sz + 1.0, y, y + 1.73);
}

// ------------------------------------------------------------ graveyard ----

/**
 * A graveyard, dressed.
 *
 * grave.are's nineteen surface rooms name themselves -- "A Gravel Path on the
 * Graveyard", "A Gravel Road on the Graveyard" -- and thirteen of them add "An
 * old tomb is here", with the stone described as "a large rectangular slab of
 * dark grey stone that has been placed face up in the ground". So the slab is
 * the tomb's own lid, beside the way down, and the headstones are the rest of
 * the plot.
 *
 * Keyed on the room *name* and not on its description, on purpose: Midgaard's
 * Concourse has an iron grate through to here and its prose says so, and the
 * Concourse is a street. This is the distinction `readFittings` already draws
 * between a taproom and a room that merely points at one.
 */
const GRAVEYARD = /\bgrave ?yard\b/i;
const OLD_TOMB = /\bold tomb\b/i;

/**
 * The road itself. Nineteen rooms say "gravel" in their own names and every one
 * of them was laid with lawn -- a judge photographed #3600 and reported a mown
 * field. An arm runs from the cell centre to each edge you can walk out of, so
 * the routed cells between two graveyard rooms get theirs the same way the
 * rooms do; a surface driven off the sector alone would have left a boiling
 * band of grass midway between every pair, which is the marsh's lesson.
 *
 * 3.4 m wide, not the cell: a thirteen-metre gravel road is a car park. The
 * lift is two centimetres, enough to clear the floor plane it lies on and far
 * too little to trip over.
 */
const GRAVEL_W = 3.4;
const GRAVEL_LIFT = 0.02;

/** The gravel runs from the centre out to every way out; stones go on grass. */
const GRAVE_PATH = 2.6;
/**
 * Nothing within this of a way out, or the path is blocked. It was 2.6, and
 * that is what made the yard read as empty: a room with four ways out has
 * `edgeClear` reject everything past 3.9 m on both axes, so of the twelve
 * candidate positions exactly one per quadrant survived -- 146 stones over 19
 * rooms, 7.7 a room, on cells 13 m square. The road is 3.4 m wide, so 1.9 m of
 * verge still leaves it entirely open.
 */
const GRAVE_CLEAR = 1.9;
/**
 * Rows out from the path and spacing along them. Rows rather than a scatter
 * because a graveyard is laid out and a wood is not, and jitter on top because
 * a hand-cut stone in soft ground does not stay where the surveyor put it.
 */
const GRAVE_ROWS = [2.7, 4.0, 5.3];
const GRAVE_FIRST = 2.6;
const GRAVE_COLS = 3;
const GRAVE_STEP = 1.5;
const GRAVE_JITTER = 0.32;

function buildGraveyard({ instances, model, chunk, room, pos, sides }) {
  if (!instances) return;
  const stone = model(['headstone'], 0);
  const slab = model(['grave_slab'], 0);
  if (!stone && !slab) return;

  const clears = edgeClear(sides, GRAVE_CLEAR);
  // The gravel is a cross through the middle -- every way out is a path from
  // the centre to that edge -- so the strip along each open axis stays bare.
  // The centre is bare anyway: it is where the player arrives, and in the
  // thirteen tomb rooms it is also the opening the stair comes up through.
  const onPath = (lx, lz) => {
    for (let d = 0; d < 4; d++) {
      if (!sides[d]) continue;
      const [dx, , dz] = DIR_STEP[d];
      if (dx ? (Math.abs(lz) < GRAVE_PATH && lx * dx > 0)
        : (Math.abs(lx) < GRAVE_PATH && lz * dz > 0)) return true;
    }
    return false;
  };
  const free = (lx, lz) => Math.hypot(lx, lz) > 3.6 && clears(lx, lz) && !onPath(lx, lz);

  const quadrants = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  quadrants.forEach(([sx, sz], q) => {
    // Seven quadrants in eight carry a plot; an empty corner is what stops the
    // whole yard reading as one stamped tile, and at 0.26 it was throwing away
    // a quarter of a yard that already had too few stones in it.
    if (hash3(room.vnum, q, 0, 220) < 0.13) return;
    GRAVE_ROWS.forEach((row, r) => {
      for (let c = 0; c < GRAVE_COLS; c++) {
        const k = q * 12 + r * GRAVE_COLS + c;
        const lx = sx * (row + (hash3(room.vnum, k, 0, 221) - 0.5) * 2 * GRAVE_JITTER);
        const lz = sz * (GRAVE_FIRST + c * GRAVE_STEP + (hash3(room.vnum, k, 1, 222) - 0.5) * 2 * GRAVE_JITTER);
        if (!free(lx, lz)) continue;
        // A slab lies flat and needs 1.94 x 0.84 of ground, so it only goes in
        // the outer rows where there is room for it.
        const lying = slab && r > 0 && hash3(room.vnum, q * 8 + c, 2, 223) < 0.24;
        const name = lying ? slab : stone;
        if (!name) continue;
        instances.add(name, {
          x: pos.x + lx, y: pos.y, z: pos.z + lz,
          // A row faces the path it was cut for, give or take how carefully it
          // was set. `InstanceBatch` can only turn about Y, so the lean a
          // settled headstone has is not available here -- see the report.
          rotY: (sz > 0 ? 0 : Math.PI) + (hash3(room.vnum, k, 3, 224) - 0.5) * 0.34,
          // The model is a 0.75 m stone, and 0.86-1.16 of it is 0.65-0.87 m --
          // the low end of what a churchyard actually holds, and too low to
          // read from the road at all. 0.95-1.45 spans 0.71-1.09 m, which
          // covers a child's marker up to a headstone with a name on it.
          scale: 0.95 + hash3(room.vnum, k, 4, 225) * 0.5,
        }, chunk);
      }
    });
  });

  // "An old tomb is here": the lid, set beside the way down rather than over
  // it. Away from the ways out, the same anchor the bog's pool uses.
  if (!slab || !OLD_TOMB.test(room.description)) return;
  let ax = 0; let az = 0;
  for (let d = 0; d < 4; d++) {
    if (!sides[d]) continue;
    const [dx, , dz] = DIR_STEP[d];
    ax += dx; az += dz;
  }
  const anchor = (ax || az) ? Math.atan2(-az, -ax) : hash3(room.vnum, 1, 0, 226) * Math.PI * 2;
  const lx = Math.cos(anchor) * 4.5;
  const lz = Math.sin(anchor) * 4.5;
  if (!clears(lx, lz)) return;
  instances.add(slab, {
    x: pos.x + lx, y: pos.y, z: pos.z + lz,
    rotY: anchor + Math.PI / 2, scale: 1,
  }, chunk);
}

/**
 * Railings along the graveyard's outer boundary.
 *
 * `iron_fence` is modelled to be laid end to end: it runs x 0..2.600 from its
 * own origin with the posts inset, so segments at exactly 2.6 m butt flush and
 * a 13 m cell side takes five of them with no joint to see. The pitch is not a
 * taste setting -- change it and the chain either gaps or overlaps.
 *
 * Only the outside is fenced. A side is fenced when the cell beyond it is
 * neither a room nor a routed path -- so no railing can ever land across a way
 * through -- and when there is no graveyard cell two steps that way either,
 * which is what stops the gap between two graveyard rooms being fenced off
 * from both sides into a row of pens.
 */
const FENCE_PITCH = 2.6;

const GRATE = /\b(grate|grating|grille|bars)\b/i;

/** Open country: what a town wall faces. */
const COUNTRY = new Set([SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS, SECTOR.MOUNTAIN]);

/** Railing either side of a grate on a cell edge, jamb to corner. */
function buildGrateRailing({ instances, model, chunk, pos, dir, addCollider }) {
  const name = model(['iron_fence'], 0);
  if (!name) return;
  const [dx, , dz] = DIR_STEP[dir];
  const alongZ = dx !== 0;
  const out = HALF - 0.35;
  const rotY = alongZ ? -Math.PI / 2 : 0;
  const lx = pos.x + dx * out;
  const lz = pos.z + dz * out;
  for (const s of [-1, 1]) {
    // Panels run +along from their origin, so the far side starts a pitch out.
    for (let a = DOOR_W / 2 + 0.1; a + FENCE_PITCH <= HALF + 0.05; a += FENCE_PITCH) {
      const from = s > 0 ? a : -a - FENCE_PITCH;
      instances.add(name, alongZ
        ? { x: lx, y: pos.y, z: lz + from, rotY }
        : { x: lx + from, y: pos.y, z: lz, rotY }, chunk);
    }
    const a0 = s > 0 ? DOOR_W / 2 + 0.1 : -HALF;
    const a1 = s > 0 ? HALF : -DOOR_W / 2 - 0.1;
    if (alongZ) addCollider(lx - 0.25, lx + 0.25, lz + a0, lz + a1, pos.y, pos.y + 2.2);
    else addCollider(lx + a0, lx + a1, lz - 0.25, lz + 0.25, pos.y, pos.y + 2.2);
  }
}

function buildIronFence({ instances, model, chunk, x, y, z, dir, addCollider }) {
  const name = model(['iron_fence'], 0);
  if (!name) return;
  const [dx, , dz] = DIR_STEP[dir];
  const alongZ = dx !== 0;            // a run across an east/west step lies on z
  const out = HALF - 0.35;
  // The model runs from its origin along +X, so turn +X onto the run.
  const rotY = alongZ ? -Math.PI / 2 : 0;
  const n = Math.round(CELL / FENCE_PITCH);
  for (let i = 0; i < n; i++) {
    const a = -HALF + i * FENCE_PITCH;
    instances.add(name, alongZ
      ? { x: x + dx * out, y, z: z + a, rotY }
      : { x: x + a, y, z: z + dz * out, rotY }, chunk);
  }
  const [w, d] = alongZ ? [0.5, CELL] : [CELL, 0.5];
  const cx = x + dx * out;
  const cz = z + dz * out;
  addCollider(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, y, y + 2.2);
}

// ----------------------------------------------------------- town edges ----

/**
 * Where the town stops, as the rooms there say it does.
 *
 * The curtain wall goes up wherever a street cell faces open country, which is
 * right for the town's outer edge and wrong in two places. Outside a gate the
 * rooms are city rooms -- "Outside the West Gate", paved -- so the cells round
 * them were built as town, and a judge looking from Haon Dor's forest edge at
 * the West Gate saw half-timbered houses standing outside the wall in front of
 * it. And the graveyard is sectored FIELD, so every town cell beside it faced
 * "country" and it was walled in by Midgaard's crenellated curtain, the town's
 * houses looking over it.
 *
 * So: outside a gate, the cells on the far side of the gate's line are
 * fields, and the cells beside the gate passage on the town side carry the
 * curtain on to the towers. Round the graveyard, a low churchyard wall behind
 * its railings and dark evergreens -- "a gravel path winding its way between
 * dark evergreen trees" -- which also stand between it and the town.
 */
const OUTSIDE_GATE = /\boutside\b[^.]*\bgate\b/i;
/** A MOUNTAIN room that says so. The rest are mis-sectored lowland. */
const MOUNTAINOUS = /\b(mountains?|cliffs?|crags?|ledges?|canyon|peaks?|ridge|gorge|ravine|rocks?|rocky|pass|summit|slopes?)\b/i;
/** How far along the wall and out from it a gate's surroundings are taken as outside the town. */
const GATE_REACH = 2;
const CHURCHYARD_H = 1.25;
const CHURCHYARD_T = 0.55;

function gateOf(room) {
  if (room.sector !== SECTOR.CITY || !isOpenAir(room) || !OUTSIDE_GATE.test(room.name)) return -1;
  return room.exits.findIndex((e, d) => d < 4 && e && (e.locks & EX_ISDOOR) && /\bgate\b/i.test(e.keyword || ''));
}

/** cell key -> what the town's edge wants built in that empty cell instead of a house. */
function townEdges(layout, world) {
  const edges = new Map();
  edges.pathWalls = [];
  const key = (level, x, z) => `${level}:${x},${z}`;
  const walkable = (level, x, z) => layout.at(level, x, z) !== undefined || layout.isPath(level, x, z);
  // Is this cell part of the town proper -- a street or room that is neither
  // outside a gate nor open country? The layout is not a plan, and a town
  // room can land on the far side of a gate's line: its neighbours stay town.
  const outside = (room) => gateOf(room) >= 0 || COUNTRY.has(room.sector);
  const town = (level, x, z) => {
    const v = layout.at(level, x, z);
    if (v !== undefined) return !outside(world.rooms.get(v));
    const link = layout.passageAt(level, x, z);
    return !!link && !(outside(link.from.room) && outside(link.to.room));
  };
  for (const cell of layout.order) {
    const g = gateOf(cell.room);
    if (g < 0) continue;
    const [gx, , gz] = DIR_STEP[g];
    const ax = gz ? 1 : 0; const az = gx ? 1 : 0;
    for (let a = -GATE_REACH; a <= GATE_REACH; a++) {
      for (let depth = -GATE_REACH; depth <= 1; depth++) {
        const x = cell.x + gx * depth + ax * a; const z = cell.z + gz * depth + az * a;
        const back = [x - gx, z - gz];
        if (walkable(cell.level, x, z)) {
          // A street running along the inside of the wall line takes the
          // wall on its outer side, unless it leaves that way: without it
          // the fields let you walk round the gate.
          if (depth === 1 && a !== 0 && layout.isPath(cell.level, x, z) && !walkable(cell.level, back[0], back[1])) {
            edges.pathWalls.push({ spot: { level: cell.level, x, z }, pos: { x: x * CELL, y: cell.level * LEVEL_H, z: z * CELL }, dir: (g + 2) % 4 });
          }
          continue;
        }
        // The first cells on the town side of the gate line carry the wall
        // on from the towers; out from the line is fields, unless the town
        // itself is next door.
        if (depth === 1) { edges.set(key(cell.level, x, z), { kind: 'wall', dir: (g + 2) % 4 }); continue; }
        // A town street across the wall line is behind the wall, not next door.
        let near = false;
        for (let d = 0; d < 4 && !near; d++) {
          const nx = x + DIR_STEP[d][0]; const nz = z + DIR_STEP[d][2];
          if ((nx - cell.x) * gx + (nz - cell.z) * gz > 0) continue;
          near = town(cell.level, nx, nz);
        }
        if (!near && !edges.has(key(cell.level, x, z))) edges.set(key(cell.level, x, z), { kind: 'outer' });
      }
    }
  }
  // A room the mud sectors MOUNTAIN that its own name calls a beach, a bog's
  // edge or a forest -- half the Old Marsh -- handed every empty cell round it
  // an eleven-metre cube of rock: the "large featureless slabs" standing in
  // the reeds at #8315. They take the marsh's own ground instead.
  for (const cell of layout.order) {
    const room = cell.room;
    if (room.sector !== SECTOR.MOUNTAIN || !isOpenAir(room) || isHood(room) || MOUNTAINOUS.test(room.name)) continue;
    for (let dir = 0; dir < 4; dir++) {
      const x = cell.x + DIR_STEP[dir][0]; const z = cell.z + DIR_STEP[dir][2];
      if (walkable(cell.level, x, z) || edges.has(key(cell.level, x, z))) continue;
      edges.set(key(cell.level, x, z), { kind: 'lowland', forest: /\bforest\b/i.test(room.name) });
    }
  }
  const grave = (level, x, z) => {
    const v = layout.at(level, x, z);
    if (v !== undefined) return GRAVEYARD.test(world.rooms.get(v).name);
    const link = layout.passageAt(level, x, z);
    return !!link && GRAVEYARD.test(link.from.room.name) && GRAVEYARD.test(link.to.room.name);
  };
  const graves = [];
  for (const cell of layout.order) if (grave(cell.level, cell.x, cell.z)) graves.push(cell);
  for (const link of layout.links) {
    if (link.kind !== 'alley' || !grave(link.from.level, link.path?.[0]?.x, link.path?.[0]?.z)) continue;
    for (const c of link.path) graves.push({ level: link.from.level, x: c.x, z: c.z });
  }
  for (const c of graves) {
    for (let dir = 0; dir < 4; dir++) {
      const [dx, , dz] = DIR_STEP[dir];
      const x = c.x + dx; const z = c.z + dz;
      if (walkable(c.level, x, z)) continue;
      const k = key(c.level, x, z);
      const edge = edges.get(k);
      if (edge && edge.kind !== 'churchyard') continue;
      if (!edge) edges.set(k, { kind: 'churchyard', toward: [(dir + 2) % 4] });
      else if (!edge.toward.includes((dir + 2) % 4)) edge.toward.push((dir + 2) % 4);
    }
  }
  return edges;
}

/**
 * Build what the town's edge wants in one empty cell. Returns false when the
 * cell should be built as usual after all.
 */
function buildTownEdge({ edge, spot, pos, batcher, instances, model, chunk, addCollider, decor, groundAt, townWalls, key }) {
  const { x, y, z } = pos;
  if (edge.kind === 'lowland') {
    // Built as usual, as what the room says it is.
    if (spot.sector === SECTOR.MOUNTAIN) {
      if (edge.forest) spot.sector = SECTOR.FOREST;
      else spot.bog = true;
    }
    return false;
  }
  if (edge.kind === 'wall') {
    if (!instances || !instances.library.get('city_wall')) return false;
    groundAt.set(key, 'cobble');
    batcher.add(plane(CELL, CELL, 3), 'cobble', place(x, y, z), { chunk });
    townWalls.push({ spot, pos, dir: edge.dir });
    return true;
  }
  // Not a building: no party wall may lean on it.
  spot.sector = SECTOR.FIELD;
  groundAt.set(key, 'grass');
  batcher.add(plane(CELL, CELL, 3), 'grass', place(x, y, z), { chunk });
  if (edge.kind === 'outer') return true;

  // A churchyard wall: waist high, coped, just behind the graveyard's railing.
  for (const dir of edge.toward) {
    const [dx, , dz] = DIR_STEP[dir];
    const out = HALF - CHURCHYARD_T / 2 - 0.05;
    const wx = x + dx * out; const wz = z + dz * out;
    const [w, d] = dx ? [CHURCHYARD_T, CELL] : [CELL, CHURCHYARD_T];
    batcher.add(box(w, CHURCHYARD_H, d, 1, 2, 6), 'stonewall', place(wx, y + CHURCHYARD_H / 2, wz), { chunk, ao: wallAo(y) });
    const [cw, cd] = dx ? [CHURCHYARD_T + 0.18, CELL] : [CELL, CHURCHYARD_T + 0.18];
    batcher.add(box(cw, 0.16, cd), 'stonewall', place(wx, y + CHURCHYARD_H + 0.08, wz), { chunk, ao: () => 0.95 });
    addCollider(wx - w / 2, wx + w / 2, wz - d / 2, wz + d / 2, y, y + CHURCHYARD_H + 0.16);
  }
  // Evergreens, clear of the wall by a crown's width, thick enough to stand
  // between the graves and the town's gables.
  const clear = (d, v) => (edge.toward.includes(d) ? Math.min(v, HALF - 3.2) : Math.min(v, HALF - 1.2));
  for (let i = 0; i < 4; i++) {
    let ox = (hash3(spot.x, spot.z, i, 211) - 0.5) * CELL;
    let oz = (hash3(spot.x, spot.z, i, 212) - 0.5) * CELL;
    ox = ox >= 0 ? clear(1, ox) : -clear(3, -ox);
    oz = oz >= 0 ? clear(2, oz) : -clear(0, -oz);
    const tx = x + ox; const tz = z + oz;
    decor.push({ kind: 'tree', conifer: true, x: tx, y, z: tz, scale: 1.7 + hash3(spot.x, spot.z, i, 213) * 0.9 });
    addCollider(tx - 0.7, tx + 0.7, tz - 0.7, tz + 0.7, y, y + 8);
  }
  if (instances) {
    scatterUndergrowth({
      instances, chunk, x, y, z,
      rand: (i, k, salt) => hash3(spot.x, spot.z, i, salt + k),
      kinds: [
        { name: model(['salal_bush', 'bush'], 0), count: 2 + Math.floor(hash3(spot.x, spot.z, 0, 214) * 3), ring: 4.0, spread: 3.2, size: 1.0, salt: 215 },
        { name: model(['fern'], 0), count: 2, ring: 3.6, spread: 3.0, size: 1.0, salt: 217 },
      ],
    });
  }
  return true;
}

/**
 * The curtain between the gatehouse's towers and the cell's edge, where the
 * next length of wall takes over: 1.5 m each side that otherwise showed
 * straight through the wall.
 */
function buildGateFlanks({ batcher, chunk, pos, dir, addCollider }) {
  const [dx, , dz] = DIR_STEP[dir];
  const out = HALF - 0.3;
  const from = DOOR_W / 2 + TOWER_W;
  const length = HALF - from;
  const h = 8.4;
  for (const s of [-1, 1]) {
    const a = s * (from + length / 2);
    const cx = pos.x + dx * out + (dz ? a : 0);
    const cz = pos.z + dz * out + (dx ? a : 0);
    const [w, d] = dx ? [TOWER_W, length] : [length, TOWER_W];
    batcher.add(box(w, h, d, 1, 4, 1), 'stonewall', place(cx, pos.y + h / 2, cz), { chunk, ao: wallAo(pos.y) });
    addCollider(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, pos.y, pos.y + h);
  }
}

// ---------------------------------------------------------------- verges ----

/**
 * Where two biomes meet on a cell boundary, break the line.
 *
 * Two areas that touch are each painted flat right up to the boundary and stop
 * dead. Midgaard's cobbles and Haon Dor's grass meet on the cell line at
 * x = -149.5 and the join is a straight edge tens of metres long, parallel to
 * the world axes -- the level editor showing through, which is the same fault
 * the indoor floor shading has out of doors.
 *
 * It is deliberately not fixed with a gradient. Fading a floor towards its
 * perimeter is the trap already written up: the neighbour cell is painted
 * flat, so a fade only moves the straight line, it cannot remove it. What
 * removes it is geometry that crosses the line and does not follow it --
 * patches of the softer ground laid over the harder one at hashed positions,
 * sizes and angles, some straddling the join and some clear of it, with
 * planting on top. The boundary is still square; you can no longer see that it
 * is.
 */
const SOFT_GROUND = new Set(['grass', 'dirt', 'peat', 'sand']);
const HARD_GROUND = new Set(['cobble', 'flagstone']);
/** Clear of the floor it lies on, and far under anything standing on it. */
const VERGE_LIFT = 0.02;
/** Patches per 13 m edge, and how big each one runs. */
const VERGE_N = 9;
const VERGE_SIZE = [1.1, 2.9];

function buildVerges({ batcher, instances, model, groundAt, chunkOf }) {
  const tuft = instances ? model(['grass_tuft'], 0) : null;
  for (const [key, mine] of groundAt) {
    const colon = key.indexOf(':');
    const level = Number(key.slice(0, colon));
    const comma = key.indexOf(',', colon);
    const cx = Number(key.slice(colon + 1, comma));
    const cz = Number(key.slice(comma + 1));
    // Each shared edge once: every horizontal edge is some cell's north side
    // and every vertical edge is some cell's east side.
    for (const dir of [0, 1]) {
      const [dx, , dz] = DIR_STEP[dir];
      const theirs = groundAt.get(`${level}:${cx + dx},${cz + dz}`);
      if (!theirs || theirs === mine) continue;
      const mineSoft = SOFT_GROUND.has(mine);
      const soft = mineSoft ? mine : (SOFT_GROUND.has(theirs) ? theirs : null);
      const hard = HARD_GROUND.has(mine) ? mine : (HARD_GROUND.has(theirs) ? theirs : null);
      if (!soft || !hard) continue;
      // Grass colonises paving; paving does not colonise grass. `towards` is
      // the way the verge grows, from the soft cell onto the hard one.
      const towards = mineSoft ? 1 : -1;
      const y = level * LEVEL_H;
      const ex = (cx + dx / 2) * CELL;
      const ez = (cz + dz / 2) * CELL;
      const chunk = chunkOf({ level, x: cx, z: cz });
      const alongZ = dx === 0;        // a north edge runs along x, not z
      for (let i = 0; i < VERGE_N; i++) {
        const seed = (k) => hash3(cx * 31 + i, cz * 31 + dir, level, 230 + k);
        const a = -HALF + (i + seed(0)) * (CELL / VERGE_N);
        // Straddle by default, but let a few sit wholly on one side or the
        // other: a verge that is a constant width is another straight line.
        const o = towards * (seed(1) * 2.4 - 0.7) * (dx || dz ? 1 : 1);
        const size = VERGE_SIZE[0] + seed(2) * (VERGE_SIZE[1] - VERGE_SIZE[0]);
        const px = alongZ ? ex + a : ex + dx * o;
        const pz = alongZ ? ez + dz * o : ez + a;
        batcher.add(plane(size, size, 2), soft,
          place(px, y + VERGE_LIFT, pz, seed(3) * Math.PI * 2), { chunk });
        if (!tuft || seed(4) < 0.45) continue;
        instances.add(tuft, {
          x: px + (seed(5) - 0.5) * size, y: y + VERGE_LIFT,
          z: pz + (seed(6) - 0.5) * size,
          rotY: seed(7) * Math.PI * 2, scale: 0.8 + seed(8) * 0.5,
        }, chunk);
      }
    }
  }
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
function buildOutdoorEdge({ batcher, chunk, room, pos, dir, open, addCollider, bog = false, instances = null }) {
  if (open) return;
  // No Man's Land's edges are what is left of the houses that stood there:
  // a broken wall along the side, a heap of it at its foot.
  const hood = hoodStyle(room);
  if (hood === 'nml' && instances && instances.library.get('ruin_wall_solid')) {
    const [dx, , dz] = DIR_STEP[dir];
    const along = dir === 1 || dir === 3;
    const bx = pos.x + dx * (HALF - 0.45);
    const bz = pos.z + dz * (HALF - 0.45);
    instances.add('ruin_wall_solid', { x: bx, y: pos.y, z: bz, rotY: FACE_ROT[dir], scaleX: CELL / 11.4, scaleY: 0.8 + hash3(room.vnum, dir, 0, 1051) * 0.3 }, chunk);
    addCollider(bx - (along ? 0.4 : HALF), bx + (along ? 0.4 : HALF), bz - (along ? HALF : 0.4), bz + (along ? HALF : 0.4), pos.y, pos.y + 6);
    return;
  }

  // A street with frontage has a building on this side already; a low garden
  // wall in front of it is one wall too many.
  if (wantsFrontage(room)) return;

  // A lake's edge is a shore, not a wall. The marsh lake's closed sides are the
  // two that face more water -- the cells beyond them are water-sectored filler
  // -- so the generic kerb put a 1.4 m dry-stone wall across the middle of the
  // lake, which is visible in the reference frame. Nothing goes here: with the
  // surface down at WATER_LIFT the beds either side are continuous and the
  // water reads as one sheet. A bog keeps its cut peat bank, which is a real
  // feature of a bog and stands only 0.9 m.
  if (isWater(room) && !bog) return;

  // A pen is fenced, not walled. Without this the pig pen took the CITY branch
  // below and came out ringed in 2.6 m of dressed ashlar.
  if (isShire(room) && FARMYARD.test(room.name)) {
    buildRailFence({ batcher, chunk, pos, dir, addCollider });
    return;
  }

  // A graveyard is railed, not walled. `buildIronFence` runs the railings round
  // the outside of the whole yard; a dry-stone kerb five centimetres inside
  // them is one boundary too many, and the two together read as a compound.
  if (GRAVEYARD.test(room.name)) return;

  // Nobody builds a wall in the desert: the edge of a room is where the sand
  // rises into the dune beyond it. A tent's edge is its own cloth.
  const east = eastStyle(room);
  if (east === 'tent') return;
  if (east) {
    const [ex, , ez] = DIR_STEP[dir];
    const bank = mound(CELL + 3, 1.3, 3.4, 18);
    batcher.add(bank, east === 'ledge' ? 'cliff' : 'sand',
      place(pos.x + ex * HALF, pos.y - 0.05, pos.z + ez * HALF, ex ? Math.PI / 2 : 0), { chunk });
    bank.dispose();
    const along = dir === 1 || dir === 3;
    const cx = pos.x + ex * (HALF - 0.4); const cz = pos.z + ez * (HALF - 0.4);
    addCollider(cx - (along ? 0.4 : HALF), cx + (along ? 0.4 : HALF), cz - (along ? HALF : 0.4), cz + (along ? HALF : 0.4), pos.y, pos.y + 2.5);
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
  // Out of town a boundary is a field wall of coursed rubble; it was `rock`,
  // crazy paving laid up on edge.
  const material = bog ? 'peat' : (hood ? 'sootwall' : room.sector === SECTOR.CITY ? 'stonewall' : 'rubblewall');
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
function buildAlley({ batcher, instances = null, link, worldOf, chunkOf, addCollider, addPlatform, lights, decor, mistCells, cabins = [], groundAt = null, cellKey = null, streetCells = null }) {
  const enclosed = alleyEnclosed(link);
  batcher.indoor = enclosed;
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
  const midstream = !isDeep(source) && isWater(link.from.room) && isWater(link.to.room)
    && !isBog(link.from.room) && !isBog(link.to.room);
  const level = link.from.level;
  const y = level * LEVEL_H;
  const chain = [link.from, ...link.path, link.to];
  // Lined as a cave when it leaves one: the rock goes on until the brick of
  // whatever it reaches, and the room at the other end has its own wall.
  const caveRun = enclosed && deepStyle(source) === 'cave';
  if (enclosed) {
    for (const [end, next] of [[link.from, chain[1]], [link.to, chain[chain.length - 2]]]) {
      const endMats = pickMaterials(end.room, end.room.area);
      if (!isBuried(endMats, end)) {
        closeCorners({
          batcher, pos: worldOf(end), dir: dirBetween(end, next), chunk: chunkOf(end),
          material: mats.wallIn, floor: mats.floor, addCollider,
        });
        continue;
      }
      closeDoorway({ batcher, pos: worldOf(end), dir: dirBetween(end, next), chunk: chunkOf(end), material: endMats.wallIn, addCollider });
    }
  }
  if (instances && caveRun) {
    // Each end, where the corridor meets a cave room's outer wall: a face of
    // rock with the doorway in it, looking down the corridor.
    for (const [end, next] of [[link.from, chain[1]], [link.to, chain[chain.length - 2]]]) {
      const d = dirBetween(end, next);
      const [dx, , dz] = DIR_STEP[d];
      const at = worldOf(end);
      // On the face `closeDoorway` puts across the cell edge.
      const face = HALF;
      instances.add('cave_wall_long_door', {
        x: at.x + dx * face, y, z: at.z + dz * face, rotY: FACE_ROT[(d + 2) % 4],
      }, chunkOf(end));
      for (const [c0, c1] of [[-HALF, -CAVE_HOLE], [CAVE_HOLE, HALF]]) {
        const r = sewerRect(at, d, face, face + CAVE_PROUD, c0, c1);
        addCollider(r.x0, r.x1, r.z0, r.z1, y, y + CEIL);
      }
    }
  }

  for (let i = 1; i < chain.length - 1; i++) {
    const c = chain[i];
    const cellRef = { x: c.x, z: c.z, level };
    const chunk = chunkOf(cellRef);
    const pos = worldOf(cellRef);
    const openDirs = new Set([dirBetween(c, chain[i - 1]), dirBetween(c, chain[i + 1])]);
    // An open street routed through the same cell makes it a street: a
    // corridor's walls and ceiling there would stand across the road, and its
    // floorboards would lie over the river "On the River" runs down. The
    // street builds the cell.
    if (enclosed && streetCells && cellKey && streetCells.has(cellKey(level, c.x, c.z))) continue;

    batcher.add(plane(CELL, CELL, 6), mats.floor, place(pos.x, y, pos.z), {
      chunk, ao: enclosed ? floorAo(pos.x, pos.z, HALF, HALF) : null,
    });
    batcher.add(box(CELL, SLAB, CELL), mats.floor, place(pos.x, y - SLAB / 2 - 0.01, pos.z), { chunk });
    addPlatform(pos.x - HALF, pos.x + HALF, pos.z - HALF, pos.z + HALF, y);
    // An enclosed corridor has no sky over it, so no verge belongs on it.
    if (groundAt && cellKey && !enclosed) groundAt.set(cellKey(level, c.x, c.z), mats.floor);

    // Between two flooded rooms in the sewer the water lies on the floor of
    // the passage too, in the sewer's own material, not the river's.
    if (isDeep(source) && [link.from.room, link.to.room].every((r) => isWater(r) || sewerFlood(r))) {
      batcher.add(plane(CELL, CELL, 4), deepWater(source), place(pos.x, y + SW_FLOOD, pos.z), { chunk });
    }
    // The floor underneath stays as it is; the plane covers it, at the same
    // height and size the rooms either side use.
    if (midstream) decor.push({ kind: 'water', x: pos.x, y: y + WATER_LIFT, z: pos.z, size: CELL + WATER_LAP });
    if (bog && mistCells) mistCells.push({ x: pos.x, y, z: pos.z });

    if (!enclosed) {
      // Was 0.86 -- one street cell in seven carried anything at all, which is
      // most of why the town read as a blockout. The two open ends of the
      // passage are excluded so nothing lands in the middle of the way through.
      // Not on the river, though: a routed cell between two water rooms is
      // water now, and barrels do not stack on it.
      // A cabin standing on this cell has the ground; the clutter goes against
      // the cell's walls, which here are the cabin's.
      const built = cabins.some((r) => pos.x + HALF > r.x0 && pos.x - HALF < r.x1
        && pos.z + HALF > r.z0 && pos.z - HALF < r.z1);
      if (!built && !midstream && !bog && wantsClutter(source)
        && hash3(c.x, c.z, level, 12) > 0.45) {
        const walls = [0, 1, 2, 3].filter((d) => !openDirs.has(d));
        decor.push({
          kind: 'clutter', x: pos.x, y, z: pos.z, half: HALF,
          walls: walls.length ? walls : [0, 1, 2, 3],
          seed: hash3(c.x, c.z, level, 13), indoor: false,
          props: clutterProps(source),
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
    // A passage between two caves is a cave too: the same rock lining the
    // rooms get, stretched to the corridor's thirteen metres.
    if (instances && caveRun) {
      for (let dir = 0; dir < 4; dir++) {
        if (openDirs.has(dir)) continue;
        const [dx, , dz] = DIR_STEP[dir];
        instances.add('cave_wall_long', {
          x: pos.x + dx * (HALF - 0.5), y, z: pos.z + dz * (HALF - 0.5), rotY: FACE_ROT[dir],
        }, chunk);
        const r = sewerRect(pos, dir, HALF - 0.5 - CAVE_PROUD, HALF - 0.5, -HALF, HALF);
        addCollider(r.x0, r.x1, r.z0, r.z1, y, y + CEIL);
      }
      instances.add('cave_roof', {
        x: pos.x, y: y + CEIL, z: pos.z, rotY: Math.floor(hash3(c.x, c.z, level, 15) * 4) * Math.PI / 2,
        scaleX: CAVE_STRETCH, scaleZ: CAVE_STRETCH,
      }, chunk);
    }
    // Not in a cave: nobody keeps torches burning in the basilisk's tunnels,
    // and a sconce would stand inside the rock lining.
    if (!caveRun && hash3(c.x, c.z, level, 14) > 0.45) {
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
  batcher.indoor = false;
}

// ------------------------------------------------------- the sewer's kit ----

/** Everything the sewer is assembled from; tools/blender/sewer.py makes them. */
const SEWER_KIT = [
  'sewer_tunnel', 'sewer_arm', 'sewer_hub', 'sewer_hub_end', 'sewer_chamber', 'sewer_chamber_air', 'sewer_shaft',
  'sewer_wall_open', 'sewer_wall_solid', 'sewer_shaft_open', 'sewer_shaft_solid',
  'sewer_grate', 'sewer_door_end', 'sewer_pit', 'sewer_ladder', 'town_well', 'sewer_sconce',
];

/**
 * A point `along` metres out of `pos` towards `dir` and `across` metres to
 * the right of that heading -- the frame every kit piece is authored in,
 * facing north with +x on its right, and swung round with FACE_ROT.
 */
function sewerAt(pos, dir, along, across) {
  const [fx, , fz] = DIR_STEP[dir];
  const th = FACE_ROT[dir];
  return { x: pos.x + fx * along + Math.cos(th) * across, z: pos.z + fz * along - Math.sin(th) * across };
}

function sewerRect(pos, dir, a0, a1, c0, c1) {
  const p = sewerAt(pos, dir, a0, c0);
  const q = sewerAt(pos, dir, a1, c1);
  return { x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), z0: Math.min(p.z, q.z), z1: Math.max(p.z, q.z) };
}

/**
 * What a length of tunnel is to walk on and walk into: the two walkways, the
 * channel sunk between them, and a wall down each side. The channel is a
 * platform like any other -- the mud is explicit that you are standing *in*
 * the sewer, and a step down into the water is what says so.
 */
function sewerRun({ pos, dir, from, to, y, addCollider, addPlatform }) {
  const walk = (c0, c1, top) => {
    const r = sewerRect(pos, dir, from, to, c0, c1);
    addPlatform(r.x0, r.x1, r.z0, r.z1, top);
  };
  walk(-SW_A, -SW_CH, y);
  walk(SW_CH, SW_A, y);
  walk(-SW_CH, SW_CH, y + SW_INVERT);
  for (const s of [-1, 1]) {
    const r = sewerRect(pos, dir, from, to, s * SW_A, s * (SW_A + SW_WALL));
    addCollider(r.x0, r.x1, r.z0, r.z1, y, y + 4.2);
  }
}

/**
 * Mud or water lying over a stretch of floor, wall to wall. It covers the
 * channel and the kerbs, which is the point: in "the muddy sewer" there is
 * no walkway any more, and in "the watery sewer" there is no channel.
 */
function sewerSheet({ batcher, chunk, pos, dir, from, to, y, flood }) {
  const r = sewerRect(pos, dir, from, to, -SW_A, SW_A);
  const w = r.x1 - r.x0; const d = r.z1 - r.z0;
  batcher.add(plane(w, d, Math.max(2, Math.round(Math.max(w, d) / 2))), flood ? 'sewage' : 'sludge',
    place((r.x0 + r.x1) / 2, y + (flood ? SW_FLOOD : SW_MUD), (r.z0 + r.z1) / 2), { chunk });
}

/** A tunnel mouth that nothing is routed through is stopped 0.3 m short of the cell edge. */
function sewerCap({ instances, chunk, pos, dir, y, addCollider }) {
  const cap = sewerAt(pos, dir, HALF - 0.3 - SW_A, 0);
  instances.add('sewer_hub_end', { x: cap.x, y, z: cap.z, rotY: FACE_ROT[dir] }, chunk);
  const r = sewerRect(pos, dir, HALF - 0.3, HALF, -SW_A, SW_A);
  addCollider(r.x0, r.x1, r.z0, r.z1, y, y + 4.2);
}

/**
 * How far in front of a pit or a well its way down is triggered: at the
 * kerb, on the room side. At the centre, which is where it was, the mobiles
 * that walk to a way out before they take it walked into the stonework --
 * the pit's collider is a metre each way -- and stood in the middle of it.
 */
const PIT_REACH = 1.45;

/** The prose of a junction with a shaft to the open air over it. */
const SEWER_AIR = /\bair ?shaft\b|\bshaft leading up\b|\bup into sunlight\b/i;
/** Where the shaft in `sewer_chamber_air` stops: see tools/blender/sewer.py. */
const AIR_TOP = 6.4;

/**
 * The sky at the top of an air shaft: a disc that shows the hour's own
 * horizon colour, read off the scene's fog at draw time -- the same colour the
 * town's haze is -- and divided by the exposure so it stands at a sky's
 * brightness whatever the hour. Pale by day, deep blue at night. It is the
 * only thing underground that tells the time without a stair to climb.
 */
function buildSkyHoles(spots) {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  const tint = new THREE.Color();
  const geometry = new THREE.CircleGeometry(0.62, 20);
  geometry.rotateX(Math.PI / 2);
  const group = new THREE.Group();
  group.name = 'air shafts';
  for (const s of spots) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(s.x, s.y, s.z);
    mesh.onBeforeRender = (renderer, scene) => {
      if (!scene.fog) return;
      tint.copy(scene.fog.color).multiplyScalar(0.85 / Math.max(0.05, renderer.toneMappingExposure));
      material.color.copy(tint);
    };
    group.add(mesh);
  }
  return group;
}

/**
 * How many torches the room's own words burn: "lit by a single torch set in
 * the wall", "the room is lit by five torches", "on the wall is a torch
 * sitting in its sconce". None where it does not say so -- the sewer is dark,
 * and that it is dark is most of what the mud says about it.
 */
const TORCH_COUNT = { a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, some: 2, several: 3 };
function sewerTorches(room) {
  const text = `${room.name} ${room.description}`.toLowerCase();
  const m = text.match(/\b(a|an|one|single|two|three|four|five|six|some|several)\s+(?:\w+\s+)?torch(es)?\b/);
  if (m) return TORCH_COUNT[m[1]] || 1;
  return /\btorch(es)?\b/.test(text) ? 1 : 0;
}
/**
 * A light the mud gives no source for: "all lit up by an odd light", "walls
 * that glitter like gold ... as if the glitter lights the whole room", "a
 * strange light flowing from there". Cold, even and sourceless, hung under
 * the crown -- which is exactly what it is described as.
 */
const SEWER_GLOW = /\b(odd light|lit up|glitter\w*|glow\w*|strange light|some light|lot of light|filled with light|bright as daylight|all bright)\b/i;

function buildSewerChamber({
  batcher, instances, chunk, room, cell, pos, sides, layout, floorHoles, shaft,
  addCollider, addPlatform, lights, decor, portals, skyHoles,
}) {
  const y = pos.y;
  const mud = sewerMud(room);
  const flood = sewerFlood(room);
  // Out to the middle of the wall, so the floor's edge is under masonry.
  buildFloor({
    batcher, chunk, material: 'sewerflag', x: pos.x, y, z: pos.z,
    half: SW_CA + SW_CT / 2, holes: floorHoles, addPlatform,
  });
  if ((mud || flood) && !floorHoles.length) {
    sewerSheet({ batcher, chunk, pos, dir: 0, from: -SW_CA, to: SW_CA, y, flood });
    // sewerSheet spans the tunnel's width; a chamber is wider than that.
    for (const s of [-1, 1]) {
      const r = { x0: pos.x + (s < 0 ? -SW_CA : SW_A), x1: pos.x + (s < 0 ? -SW_A : SW_CA), z0: pos.z - SW_CA, z1: pos.z + SW_CA };
      batcher.add(plane(r.x1 - r.x0, r.z1 - r.z0, 3), flood ? 'sewage' : 'sludge',
        place((r.x0 + r.x1) / 2, y + (flood ? SW_FLOOD : SW_MUD), pos.z), { chunk });
    }
  }
  const top = y + (shaft ? 7.15 : 5.0);
  const blind = [];

  for (let dir = 0; dir < 4; dir++) {
    const side = sides[dir];
    const link = side && side.link;
    // A way up or down that claimed this wall is a ladder or a pit against
    // it, not a tunnel mouth: there is nowhere level for a tunnel to go.
    const vertical = !!link && link.dir >= 4 && side.kind === 'portal';
    const open = !!side && !vertical && !deadExit(side.exit) && ['alley', 'portal', 'gate'].includes(side.kind);
    const rotY = FACE_ROT[dir];
    const piece = shaft ? (open ? 'sewer_shaft_open' : 'sewer_shaft_solid')
      : (open ? 'sewer_wall_open' : 'sewer_wall_solid');
    instances.add(piece, { x: pos.x, y, z: pos.z, rotY }, chunk);

    if (!open) {
      const r = sewerRect(pos, dir, SW_CA, SW_CA + SW_CT, -SW_CA - SW_CT, SW_CA + SW_CT);
      addCollider(r.x0, r.x1, r.z0, r.z1, y, top);
      if (!side || deadExit(side.exit)) blind.push(dir);
    } else {
      for (const s of [-1, 1]) {
        const r = sewerRect(pos, dir, SW_CA, SW_CA + SW_CT, s * SW_A, s * (SW_CA + SW_CT));
        addCollider(r.x0, r.x1, r.z0, r.z1, y, top);
      }
      sewerRun({ pos, dir, from: SW_CA, to: HALF, y, addCollider, addPlatform });
      // The stub carries the room's mud or water out to the cell edge, where
      // the passage beyond takes it up if the room at its other end has any.
      if (mud || flood) sewerSheet({ batcher, chunk, pos, dir, from: SW_CA - 0.05, to: HALF, y, flood });
    }

    if (open && side.kind !== 'alley') {
      // Nothing is routed through this mouth: a portal is somewhere the grid
      // could not put next door, a gate is outside the loaded world. Stop the
      // tunnel short and mark which it is, the way an archway would.
      sewerCap({ instances, chunk, pos, dir, y, addCollider });
      const at = sewerAt(pos, dir, SW_CA + 0.7, 0);
      if (side.kind === 'portal') {
        portals.push({
          x: at.x, y, z: at.z, radius: 1.6, target: side.target.vnum,
          from: room.vnum, label: side.target.room.name, dir,
        });
        lights.push({ x: at.x, y: y + 2.4, z: at.z, color: 0x7fd8ff, intensity: 5, radius: 10 });
      } else {
        // A grille across the mouth, bars cut to the arch.
        for (let i = -5; i <= 5; i++) {
          const across = i * 0.38;
          const h = 1.9 + Math.sqrt(Math.max(0, SW_A * SW_A - across * across)) - 0.05;
          const b = sewerAt(pos, dir, SW_CA + 0.2, across);
          batcher.add(box(0.07, h, 0.07), 'rustiron', place(b.x, y + h / 2, b.z, rotY), { chunk });
        }
        for (const h of [1.1, 2.7]) {
          const b = sewerAt(pos, dir, SW_CA + 0.2, 0);
          batcher.add(box(h > 2 ? 3.9 : 4.3, 0.09, 0.09), 'rustiron', place(b.x, y + h, b.z, rotY), { chunk });
        }
        const r = sewerRect(pos, dir, SW_CA + 0.1, SW_CA + 0.3, -SW_A, SW_A);
        addCollider(r.x0, r.x1, r.z0, r.z1, y, y + 4.2);
        const sign = sewerAt(pos, dir, SW_CA - 0.4, 0);
        decor.push({
          kind: 'gateSign', x: sign.x, y: y + 2.7, z: sign.z, rotY: (dir === 1 || dir === 3) ? Math.PI / 2 : 0,
          text: `${DIR_NAME[link.dir]} · #${side.exit ? side.exit.to : '?'} — outside the loaded world`,
        });
      }
    }

    if (vertical) {
      // "There are bars set in the side of the pit wall functioning as a
      // ladder." Down is a pit against the wall; up is iron rungs on it.
      const down = link.dir === 5;
      const at = sewerAt(pos, dir, down ? SW_CA - 1.55 : SW_CA, 0);
      instances.add(down ? 'sewer_pit' : 'sewer_ladder', { x: at.x, y, z: at.z, rotY }, chunk);
      if (down) addCollider(at.x - 1.0, at.x + 1.0, at.z - 1.0, at.z + 1.0, y, y + 0.62);
      const trigger = sewerAt(pos, dir, down ? SW_CA - 1.55 - PIT_REACH : SW_CA - 0.7, 0);
      portals.push({
        x: trigger.x, y, z: trigger.z, radius: down ? 1.0 : 1.2, target: side.target.vnum,
        from: room.vnum, label: side.target.room.name, dir,
      });
    }
  }

  // "Right under what you'd think was an air shaft", "above you an air shaft
  // leads up into sunlight": a round hole in the crown with the hour's sky at
  // the top of it.
  const air = !shaft && SEWER_AIR.test(room.description);
  // The far end of a way up or down that the grid could not stack: the
  // layout hands its wall to the room it was walked from, so "the Dark Pit"
  // itself had no pit. It gets one against a blank wall, and a trigger.
  for (const link of layout.links) {
    if (link.kind !== 'portal' || link.to !== cell || link.dir < 4 || !link.twoWay || !blind.length) continue;
    const dir = blind.shift();
    const down = link.dir === 4; // walked up from below: this end is the top
    const at = sewerAt(pos, dir, down ? SW_CA - 1.55 : SW_CA, 0);
    instances.add(down ? 'sewer_pit' : 'sewer_ladder', { x: at.x, y, z: at.z, rotY: FACE_ROT[dir] }, chunk);
    if (down) addCollider(at.x - 1.0, at.x + 1.0, at.z - 1.0, at.z + 1.0, y, y + 0.62);
    const trigger = sewerAt(pos, dir, down ? SW_CA - 1.55 - PIT_REACH : SW_CA - 0.7, 0);
    portals.push({
      x: trigger.x, y, z: trigger.z, radius: down ? 1.0 : 1.2, target: link.from.vnum,
      from: room.vnum, label: link.from.room.name, dir: link.dir === 4 ? 5 : 4,
    });
  }

  instances.add(shaft ? 'sewer_shaft' : (air ? 'sewer_chamber_air' : 'sewer_chamber'), { x: pos.x, y, z: pos.z, rotY: 0 }, chunk);
  if (air) skyHoles.push({ x: pos.x, y: y + AIR_TOP, z: pos.z });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = pos.x + sx * (SW_CA - 0.3); const cz = pos.z + sz * (SW_CA - 0.3);
      addCollider(cx - 0.42, cx + 0.42, cz - 0.42, cz + 0.42, y, top);
    }
  }

  // A drain in the floor, off the middle and clear of any stair.
  if (!mud && !flood) {
    const corner = Math.floor(hash3(room.vnum, 31, 0, 3) * 4);
    for (let k = 0; k < 4; k++) {
      const q = (corner + k) % 4;
      const gx = (q & 1 ? 1 : -1) * 2.5; const gz = (q & 2 ? 1 : -1) * 2.5;
      const clear = !floorHoles.some((h) => gx + 0.7 > h.x0 && gx - 0.7 < h.x1 && gz + 0.7 > h.z0 && gz - 0.7 < h.z1)
        && !(shaft && (Math.abs(gx) < 2.4 || Math.abs(gz) < 2.4));
      if (!clear) continue;
      instances.add('sewer_grate', { x: pos.x + gx, y, z: pos.z + gz, rotY: 0 }, chunk);
      break;
    }
  }

  sewerDressing({
    room, style: 'vault', pos, y, blind, sides, wall: SW_CA, ceil: 5.0,
    instances, chunk, decor, lights, addCollider,
    // Somebody works down here -- there is a store room, a guard room, a
    // ladder "left here so that you can climb up" -- so a junction the mud
    // says nothing about keeps a torch about half the time. Not by the DARK
    // flag: 170 of the area's 177 rooms carry it, so it says nothing.
    kept: SEWER_GLOW.test(room.description) || hash3(room.vnum, 91, 0, 7) < 0.45 ? 0 : 1,
  });
}

/**
 * What the room's own words put in it, for every room in the sewer: the
 * torches it says burn, the light it says glows, the bones and the rubble it
 * says are lying about, and -- in a cave -- the rock itself.
 *
 * `wall` is how far the inner face of the walls is from the middle: 4.5 in a
 * chamber, 5 in a walled room. `blind` is the walls with nothing in them.
 */
function sewerDressing({ room, style, pos, y, blind, sides, wall, ceil, instances, chunk, decor, lights, addCollider, kept = 0 }) {
  const text = `${room.name} ${room.description}`;
  const rand = (k, salt) => hash3(room.vnum, k, 0, salt);
  const put = (name, along, across, dir, spin, scale = 1) => {
    const at = sewerAt(pos, dir, along, across);
    instances.add(name, { x: at.x, y, z: at.z, rotY: FACE_ROT[dir] + spin, scale }, chunk);
    return at;
  };

  // Light, only where the mud says there is some. Blind walls first, the
  // middle of each and then either side of it; then the stretch of wall
  // beside a way out, between it and the corner.
  const spots = [];
  for (const across of [0, 2.4, -2.4]) for (const d of blind) spots.push([d, across]);
  for (let d = 0; d < 4; d++) {
    if (blind.includes(d)) continue;
    for (const across of [wall - 1.05, -(wall - 1.05)]) spots.push([d, across]);
  }
  const torches = Math.min(Math.max(sewerTorches(room), kept), spots.length);
  const sconce = instances.library.get('sewer_sconce');
  for (let i = 0; i < torches; i++) {
    const [dir, across] = spots[i];
    const face = sewerAt(pos, dir, wall, across);
    const cup = sewerAt(pos, dir, wall - 0.31, across);
    const flameY = y + 2.75;
    if (sconce) {
      instances.add('sewer_sconce', { x: face.x, y: flameY + 0.26 - sconce.bounds.max.y, z: face.z, rotY: FACE_ROT[dir] }, chunk);
    }
    decor.push({ kind: 'torch', bare: true, x: cup.x, y: flameY, z: cup.z });
    const [dx, , dz] = DIR_STEP[dir];
    lights.push({ x: cup.x - dx * 0.3, y: flameY + 0.4, z: cup.z - dz * 0.3, color: 0xffa347, intensity: 8, radius: 12, flicker: true });
  }
  if (SEWER_GLOW.test(room.description)) {
    lights.push({
      x: pos.x, y: y + Math.min(ceil - 0.8, 4.2), z: pos.z, radius: 13, intensity: 7,
      color: /gold|glitter/i.test(room.description) ? 0xffd89a : 0xb8d4ff,
    });
  }

  // Against the walls with nothing in them, never in the middle of the floor.
  const against = blind.length ? blind : [0, 1, 2, 3].filter((d) => !sides[d] || sides[d].kind !== 'alley');
  let slot = 0;
  const nextWall = () => against[(slot++) % Math.max(1, against.length)];
  // "From the treasure haphazardly strewn about": gold catches what light
  // there is. A faint warm glint, which is also all that keeps a dragon's
  // lair and its door off RGB 0.
  if (/\btreasur\w*/i.test(text)) {
    lights.push({ x: pos.x + 1.5, y: y + 1.2, z: pos.z - 1.5, color: 0xffcf7a, intensity: 9, radius: 13 });
  }
  if (/\b(bones?|skulls?|skeletons?|decay|carcass\w*)\b/i.test(text) && against.length) {
    const n = /\b(lot of|all kinds|scattered|spread)\b/i.test(text) ? 2 : 1;
    for (let i = 0; i < n; i++) {
      put('bone_pile', wall - 1.1, (rand(i, 41) - 0.5) * (wall - 1.5) * 2, nextWall(), rand(i, 43) * 6.28);
    }
  }
  if (/\b(collapsed|cave-in|rubble|debris)\b/i.test(text) && against.length) {
    const at = put('rubble', wall - 1.25, (rand(0, 45) - 0.5) * 3, nextWall(), rand(0, 47) * 6.28);
    addCollider(at.x - 0.9, at.x + 0.9, at.z - 0.9, at.z + 0.9, y, y + 0.4);
  }

  // "The fungus patch", "a giant mushroom ... decorated in the fashion of a
  // temple": clumps of it against the walls, and the pale light the spores
  // hang in -- the one cave down here that is not dark.
  if (/\b(fung\w*|mushrooms?|spores?|myconoid)\b/i.test(text) && instances.library.get('fungus_cluster')) {
    const walls = against.length ? against : [0, 1, 2, 3];
    const n = /\btemple\b/i.test(text) ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const d = walls[i % walls.length];
      const at = put('fungus_cluster', wall - 1.3, (rand(i, 85) - 0.5) * (wall - 1.8) * 2, d, rand(i, 87) * 6.28,
        0.8 + rand(i, 89) * 0.6);
      addCollider(at.x - 0.7, at.x + 0.7, at.z - 0.7, at.z + 0.7, y, y + 1.2);
    }
    lights.push({ x: pos.x, y: y + 2.2, z: pos.z, color: 0xc8f0b0, intensity: 5, radius: 11 });
  }

  if (style === 'cave') {
    // A rock box is still a box. Boulders fallen into its corners and along
    // its blank walls break the four straight lines where wall meets floor,
    // which is where the eye finds the level editor.
    const inset = wall - 1.15;
    for (let k = 0; k < 4; k++) {
      const sx = k & 1 ? 1 : -1; const sz = k & 2 ? 1 : -1;
      const name = rand(k, 51) > 0.5 ? 'cave_rock_b' : 'cave_rock_a';
      const scale = 0.75 + rand(k, 53) * 0.45;
      const x = pos.x + sx * inset; const z = pos.z + sz * inset;
      instances.add(name, { x, y: y - 0.05, z, rotY: rand(k, 55) * 6.28, scale }, chunk);
      addCollider(x - scale, x + scale, z - scale, z + scale, y, y + 1.2 * scale);
    }
    for (const d of blind) {
      const across = (rand(d, 57) - 0.5) * 4;
      const scale = 0.6 + rand(d, 59) * 0.4;
      const at = put(rand(d, 61) > 0.5 ? 'cave_rock_a' : 'cave_rock_b', wall - 0.7, across, d, rand(d, 63) * 6.28, scale);
      addCollider(at.x - scale, at.x + scale, at.z - scale, at.z + scale, y, y + 1.2 * scale);
    }
    // Flowstone from the roof, and up from the floor where the name says so.
    const hanging = 2 + Math.floor(rand(0, 65) * 2);
    for (let i = 0; i < hanging; i++) {
      const a = rand(i, 67) * Math.PI * 2; const r = 1.6 + rand(i, 69) * 1.8;
      instances.add('stalactites', {
        x: pos.x + Math.cos(a) * r, y: y + ceil, z: pos.z + Math.sin(a) * r, rotY: rand(i, 71) * 6.28,
        scale: 0.7 + rand(i, 73) * 0.5,
      }, chunk);
    }
    if (/\bstalag\w*/i.test(text) || rand(0, 75) > 0.55) {
      const n = /\bstalagmite/i.test(text) ? 2 : 1;
      for (let i = 0; i < n && against.length; i++) {
        const at = put('stalagmites', wall - 1.5, (rand(i, 77) - 0.5) * 3.5, nextWall(), rand(i, 79) * 6.28,
          0.8 + rand(i, 81) * 0.4);
        addCollider(at.x - 0.9, at.x + 0.9, at.z - 0.9, at.z + 0.9, y, y + 2);
      }
    }
  }

  // "The Sewer Store Room": somewhere things are kept.
  if (/\b(store|storage)\b/i.test(room.name) && blind.length) {
    decor.push({
      kind: 'clutter', x: pos.x, y, z: pos.z, half: wall + 0.35, walls: blind,
      seed: hash3(room.vnum, 12, 0, 5), indoor: true,
      props: ['barrel', 'crate', 'sack', 'stacked_crates', 'barrel_stack', 'rope_coil', 'bucket', 'planks_pile'],
    });
  }
}

/** The cave roof is authored for a room; a corridor cell is 13 m square. */
/** How far into a room a cave panel's rock is kept out of, and its opening's half-width. */
const CAVE_PROUD = 0.55;
const CAVE_HOLE = 1.42;
const CAVE_STRETCH = 13 / 10.6;

/**
 * Rock over the four walls and under the ceiling of a cave room, so the box
 * it is built as stops showing: its straight corners and its flat walls were
 * what read as a level editor's room with a rock texture on it. A wall with a
 * way through it gets the panel with the opening in it.
 */
function buildCaveLining({ instances, chunk, room, pos, sides, roofed, addCollider, height = CEIL }) {
  // A vast cavern stretches the same rock up: the panels are authored to CEIL.
  const scaleY = height / CEIL;
  for (let dir = 0; dir < 4; dir++) {
    const side = sides[dir];
    const open = !!side && ['alley', 'portal', 'gate'].includes(side.kind);
    const [dx, , dz] = DIR_STEP[dir];
    instances.add(open ? 'cave_wall_door' : 'cave_wall', {
      x: pos.x + dx * ROOM / 2, y: pos.y, z: pos.z + dz * ROOM / 2, rotY: FACE_ROT[dir], scaleY,
    }, chunk);
    // The rock stands up to 0.9 m proud of the wall line the room's own
    // colliders are on; without these you walked into it to the knees.
    const runs = open ? [[-ROOM / 2, -CAVE_HOLE], [CAVE_HOLE, ROOM / 2]] : [[-ROOM / 2, ROOM / 2]];
    for (const [c0, c1] of runs) {
      const r = sewerRect(pos, dir, ROOM / 2 - CAVE_PROUD, ROOM / 2, c0, c1);
      addCollider(r.x0, r.x1, r.z0, r.z1, pos.y, pos.y + height);
    }
  }
  if (roofed) {
    instances.add('cave_roof', {
      x: pos.x, y: pos.y + height, z: pos.z, rotY: Math.floor(hash3(room.vnum, 83, 0, 2) * 4) * Math.PI / 2,
    }, chunk);
  }
}

/** The walled rooms and caves of the sewer, dressed from the same words. */
function buildSewerRoomProps({ room, pos, sides, decor, lights, instances, chunk, addCollider }) {
  if (!instances) return;
  const blind = [0, 1, 2, 3].filter((d) => !sides[d] || deadExit(sides[d].exit));
  sewerDressing({
    room, style: deepStyle(room), pos, y: pos.y, blind, sides, wall: ROOM / 2, ceil: CEIL,
    instances, chunk, decor, lights, addCollider,
  });
  // An altar or a hearth the text names, in the ordinary way: these rooms have
  // the ordinary walls the fittings are measured from.
  for (const f of readFittings(room, sides)) {
    decor.push({ kind: 'fitting', fitting: f.kind, dir: f.dir, blocked: !!sides[f.dir], x: pos.x, y: pos.y, z: pos.z, seed: hash3(room.vnum, f.dir, 0, 71) });
  }
}

/**
 * A routed passage in the sewer, cell by cell: a whole straight tunnel where
 * it runs straight through, otherwise a crossing with an arm out to every
 * side it leaves by and a blind end on every side it does not.
 */
function buildSewerPassage({ batcher, instances, link, worldOf, chunkOf, addCollider, addPlatform, lights, decor }) {
  batcher.indoor = true;
  const level = link.from.level;
  const y = level * LEVEL_H;
  const chain = [link.from, ...link.path, link.to];
  // Mud and water run on between two rooms that both have them.
  const mud = sewerMud(link.from.room) && sewerMud(link.to.room);
  const flood = sewerFlood(link.from.room) && sewerFlood(link.to.room);
  const sconce = !mud && !flood ? instances.library.get('sewer_sconce') : null;

  for (let i = 1; i < chain.length - 1; i++) {
    const c = chain[i];
    const cellRef = { x: c.x, z: c.z, level };
    const chunk = chunkOf(cellRef);
    const pos = worldOf(cellRef);
    const open = [dirBetween(c, chain[i - 1]), dirBetween(c, chain[i + 1])];
    const straight = (open[0] + 2) % 4 === open[1];
    if (straight) {
      instances.add('sewer_tunnel', { x: pos.x, y, z: pos.z, rotY: FACE_ROT[open[0] % 2] }, chunk);
      sewerRun({ pos, dir: open[0], from: -HALF, to: HALF, y, addCollider, addPlatform });
      if (mud || flood) sewerSheet({ batcher, chunk, pos, dir: open[0], from: -HALF, to: HALF, y, flood });
      // Now and then a torch on the tunnel wall, low enough to sit on the
      // upright part of it rather than on the turn of the vault.
      if (sconce && hash3(c.x, c.z, level, 19) > 0.74) {
        const side = (open[0] + (hash3(c.x, c.z, level, 23) > 0.5 ? 1 : 3)) % 4;
        const face = sewerAt(pos, side, SW_A - 0.02, 0);
        const cup = sewerAt(pos, side, SW_A - 0.33, 0);
        const flameY = y + 2.15;
        instances.add('sewer_sconce', { x: face.x, y: flameY + 0.26 - sconce.bounds.max.y, z: face.z, rotY: FACE_ROT[side] }, chunk);
        decor.push({ kind: 'torch', bare: true, x: cup.x, y: flameY, z: cup.z });
        const [dx, , dz] = DIR_STEP[side];
        lights.push({ x: cup.x - dx * 0.3, y: flameY + 0.4, z: cup.z - dz * 0.3, color: 0xffa347, intensity: 7, radius: 11, flicker: true });
      }
      continue;
    }
    instances.add('sewer_hub', { x: pos.x, y, z: pos.z, rotY: 0 }, chunk);
    addPlatform(pos.x - SW_A, pos.x + SW_A, pos.z - SW_A, pos.z + SW_A, y);
    if (mud || flood) sewerSheet({ batcher, chunk, pos, dir: 0, from: -SW_A, to: SW_A, y, flood });
    for (let dir = 0; dir < 4; dir++) {
      if (open.includes(dir)) {
        instances.add('sewer_arm', { x: pos.x, y, z: pos.z, rotY: FACE_ROT[dir] }, chunk);
        sewerRun({ pos, dir, from: SW_A, to: HALF, y, addCollider, addPlatform });
        if (mud || flood) sewerSheet({ batcher, chunk, pos, dir, from: SW_A, to: HALF, y, flood });
      } else {
        instances.add('sewer_hub_end', { x: pos.x, y, z: pos.z, rotY: FACE_ROT[dir] }, chunk);
        const r = sewerRect(pos, dir, SW_A, SW_A + SW_WALL, -SW_A, SW_A);
        addCollider(r.x0, r.x1, r.z0, r.z1, y, y + 4.2);
      }
    }
  }

  // Where the tunnel reaches a room that is not part of the works -- a lair
  // with a door on it, a cave -- it ends in a face at that room's cell edge
  // with the room's own doorway through it.
  for (const [end, next] of [[link.from, chain[1]], [link.to, chain[chain.length - 2]]]) {
    if (isVault(end.room)) continue;
    const dir = dirBetween(end, next);
    const pos = worldOf(end);
    instances.add('sewer_door_end', { x: pos.x, y, z: pos.z, rotY: FACE_ROT[dir] }, chunkOf(end));
    for (const s of [-1, 1]) {
      const r = sewerRect(pos, dir, HALF - 0.05, HALF + 0.1, s * 1.6, s * SW_A);
      addCollider(r.x0, r.x1, r.z0, r.z1, y, y + 4.2);
    }
  }
  batcher.indoor = false;
}

/**
 * The doorway of a buried room, from its wall out to its cell edge.
 *
 * A room's walls stand at 5-5.7 m from its middle and the corridor out of it
 * starts at the cell edge, 6.5 m: in between, either side of the doorway, is a
 * slot 0.8 m deep that nothing builds. In the town it looks onto the next
 * building. Underground it looks onto nothing at all -- which means the sky
 * dome, seven metres below the street: a lit blue slit beside every doorway
 * in the sewer's lairs and caves. A face across the cell edge with the
 * doorway in it, and a lined reveal back to the room's wall, close it.
 */
function closeDoorway({ batcher, pos, dir, chunk, material, addCollider }) {
  const y = pos.y;
  const H = CEIL + SLAB;
  const T = 0.3;
  const add = (a0, a1, c0, c1, y0, y1) => {
    const r = sewerRect(pos, dir, a0, a1, c0, c1);
    batcher.add(box(r.x1 - r.x0, y1 - y0, r.z1 - r.z0), material,
      place((r.x0 + r.x1) / 2, (y0 + y1) / 2, (r.z0 + r.z1) / 2), { chunk, ao: wallAo(y) });
    return r;
  };
  for (const s of [-1, 1]) {
    const r = add(HALF - T, HALF, s * (DOOR_W / 2 + T), s * HALF, y, y + H);
    addCollider(r.x0, r.x1, r.z0, r.z1, y, y + H);
    // The reveal: a jamb from the room's wall to the face.
    const j = add(SHELL - 0.05, HALF - T, s * DOOR_W / 2, s * (DOOR_W / 2 + T), y, y + DOOR_H);
    addCollider(j.x0, j.x1, j.z0, j.z1, y, y + DOOR_H);
  }
  add(HALF - T, HALF, -(DOOR_W / 2 + T), DOOR_W / 2 + T, y + DOOR_H, y + H);
  add(SHELL - 0.05, HALF - T, -DOOR_W / 2, DOOR_W / 2, y + DOOR_H, y + DOOR_H + 0.3);
}

/**
 * Where a corridor meets a room above ground, the two corners between them.
 *
 * The corridor's walls stand 6-6.5 m off its line and stop at the cell edge;
 * the room's walls stand 5.7 m off its middle. Either side of the doorway that
 * leaves a slot 0.8 m deep and 0.3 m wide that nothing builds, and between two
 * rooms of a freestanding building it looks out: walking north from #3001,
 * the temple's corridor showed the sky and a roof across the square through
 * its left-hand wall. A post in each corner closes it and leaves the room's
 * face -- the temple's columns and windows -- to be seen down the corridor,
 * which a face across the cell edge (`closeDoorway`) would hide.
 */
function closeCorners({ batcher, pos, dir, chunk, material, floor, addCollider }) {
  const y = pos.y;
  const H = CEIL + SLAB;
  // And the strip of floor in front of the room's face, where the grass 0.47 m
  // below showed as a green line under its plinth. A centimetre down, so the
  // doorway's own threshold wins wherever the two overlap.
  const f = sewerRect(pos, dir, ROOM / 2, HALF, -HALF, HALF);
  batcher.add(plane(f.x1 - f.x0, f.z1 - f.z0, 2), floor, place((f.x0 + f.x1) / 2, y - 0.01, (f.z0 + f.z1) / 2), { chunk });
  for (const s of [-1, 1]) {
    const r = sewerRect(pos, dir, SHELL - 0.05, HALF, s * (SHELL - 0.05), s * HALF);
    batcher.add(box(r.x1 - r.x0, H, r.z1 - r.z0), material,
      place((r.x0 + r.x1) / 2, y + H / 2, (r.z0 + r.z1) / 2), { chunk, ao: wallAo(y) });
    addCollider(r.x0, r.x1, r.z0, r.z1, y, y + H);
  }
}

/**
 * The mountain the river cuts its tunnels through.
 *
 * The eastern caves are at street level -- the river runs straight in from
 * the town -- so built as rooms they stood on the grass as rock boxes with
 * flat tops, the corridors between them thirteen-metre sheds. Every empty cell
 * within a cell of one of them now holds a block of mountain, and the caves
 * and their corridors carry a craggy block on their ceilings, so the whole
 * run is one massif with the tunnels inside it and the cave mouths opening
 * out of its cliffs onto the desert.
 *
 * Returns the cells it took, so nothing else builds there.
 */
/**
 * The open rooms of the Great Eastern Desert, dressed from their own words.
 *
 * A tent is built over its room: the pavilion roof, and a cloth wall on every
 * side -- the side with a way out gets the wall with the doorway and its flap
 * rolled up, and the others are closed, so the tent stands where the mud says
 * it does and you walk in and out through the door it says it has. The camp is
 * the oasis the prose promises: a pool under palms, reeds at its edge. Beside
 * the camels there is the picket line they are hitched to.
 */
function buildEastRoom({ room, pos, sides, instances, chunk, decor, lights, addCollider }) {
  const style = eastStyle(room);
  const text = `${room.name} ${room.description}`;
  const rand = (k, salt) => hash3(room.vnum, k, 0, salt);
  const blank = [0, 1, 2, 3].filter((d) => !sides[d]);
  const y = pos.y;

  if (style === 'tent') {
    instances.add('tent_roof', { x: pos.x, y, z: pos.z, rotY: 0 }, chunk);
    for (let dir = 0; dir < 4; dir++) {
      const open = !!sides[dir] && ['alley', 'portal', 'gate'].includes(sides[dir].kind);
      instances.add(open ? 'tent_wall_door' : 'tent_wall', { x: pos.x, y, z: pos.z, rotY: FACE_ROT[dir] }, chunk);
      const runs = open ? [[-TENT_H, -1.6], [1.6, TENT_H]] : [[-TENT_H, TENT_H]];
      for (const [c0, c1] of runs) {
        const r = sewerRect(pos, dir, TENT_H - 0.15, TENT_H + 0.1, c0, c1);
        addCollider(r.x0, r.x1, r.z0, r.z1, y, y + 2.4);
      }
    }
    // Poles: the two king poles either side of the middle, and the ring.
    for (const sx of [-1.2, 1.2]) addCollider(pos.x + sx - 0.12, pos.x + sx + 0.12, pos.z - 0.12, pos.z + 0.12, y, y + 5);
    // "A fancy carpet lies on the sand", "cushions"; every tent has somewhere
    // to sit. Against a closed wall, never in the doorway or the middle.
    const back = blank.length ? blank[0] : 0;
    const rug = sewerAt(pos, back, 2.6, 0);
    instances.add('rug', { x: rug.x, y, z: rug.z, rotY: FACE_ROT[back] }, chunk);
    const seat = sewerAt(pos, back, 4.3, 0);
    instances.add('cushions', { x: seat.x, y, z: seat.z, rotY: FACE_ROT[back] + Math.PI }, chunk);
    // A lantern on a chain from the ridge beam, off the middle of it. After
    // dark it is all the light there is in a tent, so every tent has one --
    // the rich ones turned up. Without it the inside of a tent at night was
    // 23% of the frame at RGB 0: black goat hair lit by nothing.
    // Two, one each end of the beam: from one, the far walls of an eleven-
    // metre tent still fell to black at their foot.
    const rich = /lavish|fancy|rich|tapestr/i.test(text);
    for (const off of [-0.9, 0.9]) {
      const lx = pos.x + off;
      instances.add('lantern', { x: lx, y: y + 4.9, z: pos.z, rotY: 0 }, chunk);
      decor.push({ kind: 'torch', bare: true, x: lx, y: y + 4.9 - 1.72, z: pos.z });
      lights.push({ x: lx, y: y + 2.9, z: pos.z, color: 0xffb566, intensity: rich ? 34 : 24, radius: 16, flicker: true });
    }
    return;
  }

  if (style === 'camp') {
    if (/\boasis\b/i.test(text)) {
      // The pool: off the middle, round, with a lip of wet sand and reeds.
      const a = rand(0, 61) * Math.PI * 2;
      const px = pos.x + Math.cos(a) * 2.6; const pz = pos.z + Math.sin(a) * 2.6;
      decor.push({ kind: 'water', x: px, y: y + 0.04, z: pz, radius: 2.4, chop: 0.25, glint: 0.9, shallow: 0x3d7a6a, deep: 0x123a3a });
      addCollider(px - 1.7, px + 1.7, pz - 1.7, pz + 1.7, y, y + 1);
      for (let i = 0; i < 5; i++) {
        const t = a + Math.PI * 0.6 + i * 0.55;
        instances.add('reed_clump', {
          x: px + Math.cos(t) * 2.5, y, z: pz + Math.sin(t) * 2.5, rotY: rand(i, 63) * 6.28, scale: 0.7 + rand(i, 65) * 0.4,
        }, chunk);
      }
    }
    // Palms round the camp's edge, in the corners, where nothing walks.
    for (let k = 0; k < 4; k++) {
      if (rand(k, 67) < 0.3) continue;
      const sx = k & 1 ? 1 : -1; const sz = k & 2 ? 1 : -1;
      const x = pos.x + sx * (4.6 + rand(k, 69) * 0.8); const z = pos.z + sz * (4.6 + rand(k, 71) * 0.8);
      instances.add(rand(k, 73) > 0.5 ? 'palm_a' : 'palm_b', { x, y, z, rotY: rand(k, 75) * 6.28, scale: 0.85 + rand(k, 77) * 0.3 }, chunk);
      addCollider(x - 0.35, x + 0.35, z - 0.35, z + 0.35, y, y + 6);
    }
    if (/\bcamels?\b/i.test(room.name) && blank.length) {
      const d = blank[0];
      const at = sewerAt(pos, d, 4.4, 0);
      instances.add('hitch_line', { x: at.x, y, z: at.z, rotY: FACE_ROT[d] }, chunk);
      const r = sewerRect(pos, d, 4.2, 4.6, -4.6, 4.6);
      addCollider(r.x0, r.x1, r.z0, r.z1, y, y + 0.9);
    }
    return;
  }

  if (/\bglow/i.test(room.description)) {
    // "This patch of desert looks different ... the sand glows."
    lights.push({ x: pos.x, y: y + 0.6, z: pos.z, color: 0x9fe6c8, intensity: 9, radius: 14 });
  }
}

/**
 * "A vast desert stretches for miles." Nine rooms of it, laid out, is a patch
 * of sand in a meadow: past the ring of dunes the frontage puts round them the
 * world's own ground is grass, and it showed as a green band under the sky in
 * every view out of the desert. So the sand goes on -- flat sand in every
 * empty cell over a margin round the desert's rooms, a dune on most of them --
 * out to where the fog takes over. Nothing out there is reachable, so none of
 * it needs a collider; the frontage dunes already stop you.
 */
const SAND_MARGIN = 7;

function buildSandSea({ layout, batcher, instances, frontage, mountain, groundAt, cellKey, chunkOf }) {
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  for (const cell of layout.order) {
    const style = eastStyle(cell.room);
    if (cell.level !== 0 || !style || style === 'cave') continue;
    x0 = Math.min(x0, cell.x); x1 = Math.max(x1, cell.x);
    z0 = Math.min(z0, cell.z); z1 = Math.max(z1, cell.z);
  }
  if (x0 > x1) return;
  for (let x = x0 - SAND_MARGIN; x <= x1 + SAND_MARGIN; x++) {
    for (let z = z0 - SAND_MARGIN; z <= z1 + SAND_MARGIN; z++) {
      const k = cellKey(0, x, z);
      if (layout.at(0, x, z) !== undefined || layout.isPath(0, x, z) || mountain.has(k) || frontage.has(k)) continue;
      // Not over the town or anything else that is not the desert's: only
      // cells nearer the desert than any other area's room.
      if (nearestArea(layout, x, z) !== 'eastern.are') continue;
      const chunk = chunkOf({ level: 0, x, z });
      const px = x * CELL; const pz = z * CELL;
      batcher.add(plane(CELL, CELL, 2), 'sand', place(px, 0, pz), { chunk });
      groundAt.set(k, 'sand');
      if (hash3(x, z, 0, 43) < 0.35) continue;
      instances.add(hash3(x, z, 1, 43) > 0.5 ? 'dune_a' : 'dune_b', {
        x: px, y: 0, z: pz, rotY: -Math.PI / 2 + (hash3(x, z, 2, 43) - 0.5) * 0.6,
        scale: 0.9 + hash3(x, z, 3, 43) * 0.5, scaleY: 0.7 + hash3(x, z, 4, 43) * 0.7,
      }, chunk);
    }
  }
}

/** Which area the nearest room on the ground belongs to, within six cells. */
function nearestArea(layout, x, z) {
  let best = Infinity; let area = null;
  for (let r = 0; r <= 6 && r * r < best; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const v = layout.at(0, x + dx, z + dz);
        if (v === undefined) continue;
        const d = dx * dx + dz * dz;
        if (d < best) { best = d; area = layout.cells.get(v).room.areaFile; }
      }
    }
  }
  return area;
}

/** Half the side of a tent: tools/blender/desert.py `TH`. */
const TENT_H = 5.6;

/** Half the width of the passage through `massif_mouth`, less its rough. */
const MOUTH_W = 2.0;

function buildMassif({ layout, batcher, instances, addCollider, chunkOf, cellKey }) {
  // The desert's caves wear its sandstone; a cave anywhere else -- the troll
  // den in Haon Dor's firs -- the same crags in grey rock.
  const rocky = (room) => eastStyle(room) === 'cave' || pickMaterials(room, room.area).rockCave;
  const skin = (room) => (eastStyle(room) === 'cave' ? null : { cliff: 'crag' });
  const inside = [];            // {level, x, z, swap} cells that are cave or cave corridor
  for (const cell of layout.order) {
    if (cell.level < 0 || !rocky(cell.room)) continue;
    const top = ceilingOf(cell.room, cell, layout);
    inside.push({ level: cell.level, x: cell.x, z: cell.z, swap: skin(cell.room), top });
  }
  for (const link of layout.links) {
    if (link.kind !== 'alley' || !link.path || link.from.level < 0) continue;
    if (!rocky(link.from.room) || !rocky(link.to.room)) continue;
    for (const c of link.path) inside.push({ level: link.from.level, x: c.x, z: c.z, swap: skin(link.from.room) });
  }
  const taken = new Set();
  const free = (x, z) => layout.at(0, x, z) === undefined && !layout.isPath(0, x, z)
    && layout.at(1, x, z) === undefined && !layout.isPath(1, x, z);
  const block = (x, z, swap) => {
    const k = cellKey(0, x, z);
    if (taken.has(k)) return;
    taken.add(k);
    const cx = x * CELL; const cz = z * CELL;
    const tall = hash3(x, z, 0, 211);
    const name = tall > 0.5 ? 'massif_a' : 'massif_b';
    const scaleY = 0.85 + hash3(x, z, 1, 211) * 0.45;
    instances.add(name, {
      x: cx, y: 0, z: cz, rotY: Math.floor(hash3(x, z, 2, 211) * 4) * Math.PI / 2, scaleY,
    }, chunkOf({ level: 0, x, z }), swap);
    addCollider(cx - HALF, cx + HALF, cz - HALF, cz + HALF, 0, (name === 'massif_a' ? 12 : 9) * scaleY);
  };
  // The way out of a cave onto the open air goes through the cliff: the first
  // cell of the path is a block with a passage driven through it, so the
  // room's own walls stand behind rock and only its mouth shows.
  for (const link of layout.links) {
    if (link.kind !== 'alley' || !link.path || !link.path.length || link.from.level !== 0) continue;
    const ends = [[link.from, link.to, link.path[0], link.path[1] || link.to],
      [link.to, link.from, link.path[link.path.length - 1], link.path[link.path.length - 2] || link.from]];
    for (const [cave, far, first, next] of ends) {
      if (!rocky(cave.room) || !isOpenAir(far.room)) continue;
      const inDir = dirBetween(first, cave);
      if (inDir < 0 || dirBetween(first, next) !== (inDir + 2) % 4) continue;
      const k = cellKey(0, first.x, first.z);
      if (taken.has(k)) continue;
      taken.add(k);
      const cx = first.x * CELL; const cz = first.z * CELL;
      instances.add('massif_mouth', { x: cx, y: 0, z: cz, rotY: inDir % 2 ? Math.PI / 2 : 0 }, chunkOf({ level: 0, x: first.x, z: first.z }), skin(cave.room));
      for (const s of [-1, 1]) {
        const r = sewerRect({ x: cx, z: cz }, inDir, -HALF, HALF, s * MOUTH_W, s * HALF);
        addCollider(r.x0, r.x1, r.z0, r.z1, 0, 10);
      }
      // "The iron bars are broken, allowing passage through the hole in the
      // wall." Where the open end's own words say so, a grille across the
      // mouth with its middle bars gone and two bent aside.
      const exit = [0, 1, 2, 3].map((d) => far.room.exits[d]).find((e) => e && e.to === cave.vnum);
      if (exit && /\bbars?\b/i.test(`${exit.description || ''} ${far.room.description}`)) {
        const at = sewerAt({ x: cx, z: cz }, inDir, -HALF + 0.6, 0);
        const rot = inDir % 2 ? Math.PI / 2 : 0;
        for (let i = -5; i <= 5; i++) {
          if (Math.abs(i) <= 1) continue;
          const across = i * 0.36;
          const p = sewerAt({ x: at.x, z: at.z }, inDir, 0, across);
          const bent = Math.abs(i) === 2;
          batcher.add(box(0.06, bent ? 2.2 : 3.6, 0.06), 'rust',
            place(p.x, bent ? 1.1 : 1.8, p.z, rot), { chunk: chunkOf({ level: 0, x: first.x, z: first.z }) });
        }
        for (const hy of [0.4, 3.4]) {
          for (const s of [-1, 1]) {
            const p = sewerAt({ x: at.x, z: at.z }, inDir, 0, s * 1.35);
            batcher.add(box(1.25, 0.08, 0.08), 'rust', place(p.x, hy, p.z, rot), { chunk: chunkOf({ level: 0, x: first.x, z: first.z }) });
          }
        }
      }
      // At the back of the passage, the cave room's own outer wall: rock over
      // it with the doorway in it, and the slot beside the door closed.
      const out = (inDir + 2) % 4;
      const room = { x: cave.x * CELL, y: 0, z: cave.z * CELL };
      const [ox, , oz] = DIR_STEP[out];
      instances.add('cave_wall_long_door', { x: room.x + ox * HALF, y: 0, z: room.z + oz * HALF, rotY: FACE_ROT[inDir] }, chunkOf(cave), skin(cave.room));
      closeDoorway({ batcher, pos: room, dir: out, chunk: chunkOf(cave), material: 'caverock', addCollider });
    }
  }
  for (const c of inside) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (c.level === 0 && free(c.x + dx, c.z + dz)) block(c.x + dx, c.z + dz, c.swap);
      }
    }
    // A cap on the room's own ceiling, unless another cave stands on it.
    if (layout.at(c.level + 1, c.x, c.z) !== undefined) continue;
    const y = c.level * LEVEL_H + (c.top ?? CEIL);
    instances.add(hash3(c.x, c.z, c.level, 213) > 0.5 ? 'massif_a' : 'massif_b', {
      x: c.x * CELL, y, z: c.z * CELL, rotY: Math.floor(hash3(c.x, c.z, 3, 213) * 4) * Math.PI / 2,
      scaleY: 0.45 + hash3(c.x, c.z, 4, 213) * 0.35,
    }, chunkOf(c), c.swap);
  }
  return taken;
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
function buildStair({ batcher, plan, worldOf, chunkOf, addCollider, addPlatform, materials, buried = false, shaftWalls = false, kerb = 'stonewall', lowerCeil = CEIL }) {
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
      batcher.add(box(w, 0.18, d), buried ? 'rustiron' : 'iron', place(lower.x + dx * along + offX, y, lower.z + dz * along + offZ), { chunk });
      batcher.add(box(0.13, 0.95, 0.13), buried ? 'rustiron' : 'iron', place(lower.x + dx * along + offX, y - 0.5, lower.z + dz * along + offZ), { chunk });
    }
    // One collider per stretch of rail, spanning only the height the rail
    // is at there. It was one box from the floor to the top of the flight,
    // which sealed the room in two along the stair: in a sewer shaft the
    // stair runs across the middle of a junction with tunnels on both sides
    // of it, and the way between them is underneath the upper half.
    //
    // And none on the lowest stretch. The flight starts at the wall, so
    // coming down it you arrive facing brick with a rail on either hand, and
    // the only way off a stair that ends in a wall is sideways: with the rail
    // collided the whole way down, the foot of every stair was a pen -- a walk
    // down into the sewer stopped on the fourth tread and could not leave it.
    for (let i = 1; i < segments; i++) {
      const a0 = STAIR_START - STAIR_RUN * (i / segments);
      const a1 = STAIR_START - STAIR_RUN * ((i + 1) / segments);
      const x0 = lower.x + dx * a0 + offX; const x1 = lower.x + dx * a1 + offX;
      const z0 = lower.z + dz * a0 + offZ; const z1 = lower.z + dz * a1 + offZ;
      addCollider(Math.min(x0, x1) - 0.15, Math.max(x0, x1) + 0.15, Math.min(z0, z1) - 0.15, Math.max(z0, z1) + 0.15,
        Math.max(lower.y, lower.y + rise * (i / segments) - 0.4), lower.y + rise * ((i + 1) / segments) + 1.1);
    }
  }

  if (!buried) return;
  const upper = worldOf(plan.upper);
  const upperChunk = chunkOf(plan.upper);
  // The opening, in the upper room's frame: `along` runs the stair's way.
  const a0 = HOLE_CENTRE - HOLE_RUN / 2; const a1 = HOLE_CENTRE + HOLE_RUN / 2;
  const c0 = -HOLE_SPAN / 2; const c1 = HOLE_SPAN / 2;
  const at = (along, across) => ({
    x: upper.x + dx * along + (dz !== 0 ? across : 0),
    z: upper.z + dz * along + (dx !== 0 ? across : 0),
  });
  const slab = (p, q, y0, y1, material) => {
    const x0 = Math.min(p.x, q.x); const x1 = Math.max(p.x, q.x);
    const z0 = Math.min(p.z, q.z); const z1 = Math.max(p.z, q.z);
    batcher.add(box(x1 - x0, y1 - y0, z1 - z0), material,
      place((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), { chunk: upperChunk, ao: wallAo(y0) });
    return { x0, x1, z0, z1 };
  };
  // A parapet on the three sides the stair does not come out of -- "a well
  // in the middle of the floor leads down into darkness" wants something to
  // lean over, and a bare hole in a floor reads as a missing tile. The top of
  // the flight is at a0, the far end from the wall it starts at.
  const K = 0.34; const KH = 0.86;
  const parts = [
    [at(a1, c0 - K), at(a1 + K, c1 + K)],
    [at(a0, c0 - K), at(a1, c0)],
    [at(a0, c1), at(a1, c1 + K)],
  ];
  for (const [p, q] of parts) {
    const r = slab(p, q, upper.y, upper.y + KH, kerb);
    addCollider(r.x0, r.x1, r.z0, r.z1, upper.y, upper.y + KH);
    slab({ x: r.x0 - 0.05, z: r.z0 - 0.05 }, { x: r.x1 + 0.05, z: r.z1 + 0.05 }, upper.y + KH, upper.y + KH + 0.1, kerb);
  }
  // The opening's own edges: the slab it is cut through is whatever the room
  // above is floored with, and in the Dump that is turf, standing 0.45 m deep
  // round the top of a brick shaft. Lined in the parapet's stone instead.
  for (const [p, q] of [
    [at(a0, c0 - 0.06), at(a1, c0)], [at(a0, c1), at(a1, c1 + 0.06)],
    [at(a1, c0 - 0.06), at(a1 + 0.06, c1 + 0.06)],
  ]) slab(p, q, upper.y - SLAB - 0.02, upper.y - 0.005, kerb);
  if (shaftWalls) {
    // A sewer shaft's walls run to the underside of the floor above, and
    // round the opening that underside is the ceiling you look up at -- it
    // was the grass of the Dump seen from below. Brick, like the rest.
    const inner = SW_CA + SW_CT / 2;
    const shaft = { x0: upper.x - inner, x1: upper.x + inner, z0: upper.z - inner, z1: upper.z + inner };
    const p = at(a0, c0); const q = at(a1, c1);
    const hole = { x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), z0: Math.min(p.z, q.z), z1: Math.max(p.z, q.z) };
    for (const r of rectsAround(shaft, [hole])) {
      slab({ x: r.x0, z: r.z0 }, { x: r.x1, z: r.z1 }, upper.y - SLAB - 0.06, upper.y - SLAB - 0.01, 'brick');
    }
    return;
  }
  // And the lining: the room below stops at its ceiling, this floor starts a
  // metre and a half higher, and between the two there was nothing at all.
  const y0 = lower.y + lowerCeil + SLAB; const y1 = upper.y - SLAB;
  if (y1 - y0 < 0.05) return;
  for (const [p, q] of [
    [at(a0, c0 - 0.25), at(a1, c0)], [at(a0, c1), at(a1, c1 + 0.25)],
    [at(a0 - 0.25, c0 - 0.25), at(a0, c1 + 0.25)], [at(a1, c0 - 0.25), at(a1 + 0.25, c1 + 0.25)],
  ]) slab(p, q, y0, y1, materials.wallIn);
}

/** Pitched roof over an indoor room, with a chimney now and then. */
// ------------------------------------------------------ Shire interiors ----

/**
 * The frame a Shire room is built on, standing inside its plaster: a post at
 * every corner and either side of every door, a plate along the head of each
 * wall and tie beams across under the boards of the floor above. A barn is
 * the same frame heavier, without the rail. It is what makes a timber
 * building's inside read as one -- a plaster box with a plank ceiling read
 * as the stone box it replaced, repainted.
 */
const FRAME_POST = 0.26;
const FRAME_PLATE = 0.24;

function buildTimberFrame({ batcher, chunk, pos, sides, addCollider, holes, barn, rail = true }) {
  const post = barn ? 0.34 : FRAME_POST;
  const inner = ROOM / 2;
  const y = pos.y;
  const add = (w, h, d, x, yy, z, rotY = 0) => batcher.add(box(w, h, d), 'timber', place(x, yy, z, rotY), { chunk });
  // Corners.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(post, CEIL, post, pos.x + sx * (inner - post / 2), y + CEIL / 2, pos.z + sz * (inner - post / 2));
    }
  }
  for (let dir = 0; dir < 4; dir++) {
    const [dx, , dz] = DIR_STEP[dir];
    const rotY = dir === 1 || dir === 3 ? Math.PI / 2 : 0;
    const open = !!sides[dir] && (sides[dir].kind === 'alley' || sides[dir].kind === 'portal');
    // The face of the wall, and a point `along` it (the axis across dx/dz).
    const at = (along, inset) => ({
      x: pos.x + dx * (inner - inset) + (dx ? 0 : along),
      z: pos.z + dz * (inner - inset) + (dz ? 0 : along),
    });
    const plate = at(0, FRAME_PLATE / 2);
    add(ROOM, FRAME_PLATE, FRAME_PLATE, plate.x, y + CEIL - FRAME_PLATE / 2, plate.z, rotY);
    const studs = open ? [-(DOOR_W / 2 + post / 2), DOOR_W / 2 + post / 2] : [0];
    for (const s of studs) {
      const p = at(s, post / 2);
      add(post, CEIL, post, p.x, y + CEIL / 2, p.z, rotY);
      addCollider(p.x - post / 2, p.x + post / 2, p.z - post / 2, p.z + post / 2, y, y + CEIL);
    }
    if (open) {
      // The door head, spanning both posts.
      const p = at(0, post / 2);
      add(DOOR_W + post * 2, 0.26, post, p.x, y + DOOR_H + 0.13, p.z, rotY);
    }
    if (!barn && rail) {
      // A rail at the height of a chair back, broken by the door.
      const runs = open ? [[-inner, -DOOR_W / 2 - post], [DOOR_W / 2 + post, inner]] : [[-inner, inner]];
      for (const [a, b] of runs) {
        const p = at((a + b) / 2, 0.05);
        add(b - a, 0.14, 0.1, p.x, y + 1.05, p.z, rotY);
      }
    }
  }
  // Tie beams across, clear of any stair coming up through the ceiling.
  const hole = holes.length ? unionRect(holes) : null;
  for (const offset of [-2.6, 2.6]) {
    if (hole && offset + 0.2 > hole.z0 && offset - 0.2 < hole.z1) continue;
    add(ROOM, barn ? 0.36 : 0.3, barn ? 0.3 : 0.26, pos.x, y + CEIL - 0.16, pos.z + offset);
  }
}

/**
 * A smial is round. "A hole in the ground which serves as the proper dwelling
 * place for halflings": plaster curving from the walls into the ceiling, the
 * corners rounded off in plan, boards to waist height and a timber rib over
 * the vault every couple of metres -- the tube-shaped hall of the book, cut to
 * the square room the mud gives it. The room's own walls still stand behind
 * it, and so do its colliders; this is a lining.
 */
const VAULT_SPRING = 3.2;       // above the 3.1 m doorways, so no door cuts the curve
const VAULT_CORNER = 2.3;       // the plan's corner radius: over the cove's 2.0, or the corners fold
const VAULT_BOARDS = 1.05;

function buildSmialVault({ batcher, chunk, pos, sides, addCollider }) {
  return buildVaultLining({
    batcher, chunk, pos, sides, addCollider,
    spring: VAULT_SPRING, corner: VAULT_CORNER,
    surface: (h) => (h <= VAULT_BOARDS + 1e-6 ? 'planks' : 'plaster'),
    rib: 'timber',
  });
}

/**
 * A lining that curves from the walls into the ceiling: the smial's plaster
 * tube, a tomb's low stone vault, a laboratory's smoke-stained one. Walls
 * rise straight to `spring`, then a quarter-circle cove carries them in to a
 * flat crown at CEIL; in plan the corners are rounded off by `corner`. The
 * room's own walls and colliders stand behind it.
 *
 * `surface(h)` names the material a band of it is at the height its top is at;
 * `rib` is what the transverse ribs and the beam over the crown are built of.
 * `holes` are the ceiling's openings, which the crown is cut back from.
 * `shade(y)` darkens it by height -- the smoke that climbed a laboratory.
 */
function buildVaultLining({
  batcher, chunk, pos, sides, addCollider, spring, corner, surface, rib, ribW = 0.12, ribs = [-2.7, 2.7],
  holes = [], inset = 0, shade = null,
}) {
  const H = ROOM / 2 - inset;
  const cove = CEIL - spring;
  const straight = H - corner;
  // Profile: [inset from the wall face, height, normal tilt t (0 wall, pi/2 ceiling)]
  const profile = [0, VAULT_BOARDS, 2.1, DOOR_H].filter((h) => h < spring - 1e-6).map((h) => [0, h, 0]);
  profile.push([0, spring, 0]);
  const ARC = 10;
  for (let i = 1; i <= ARC; i++) {
    const t = (i / ARC) * Math.PI / 2;
    profile.push([cove - cove * Math.cos(t), spring + cove * Math.sin(t), t]);
  }
  // Path round the room: [x, z, inward nx, nz, side, along].
  const path = [];
  const cornerSteps = 6;
  const alongs = [-straight, -2.4, -DOOR_W / 2, -0.8, 0, 0.8, DOOR_W / 2, 2.4, straight]
    .filter((a) => Math.abs(a) <= straight + 1e-6);
  // North, east, south, west, going clockwise seen from above (x east, z south).
  const SIDES = [
    { dir: 0, origin: [0, -H], axis: [1, 0], normal: [0, 1] },
    { dir: 1, origin: [H, 0], axis: [0, 1], normal: [-1, 0] },
    { dir: 2, origin: [0, H], axis: [-1, 0], normal: [0, -1] },
    { dir: 3, origin: [-H, 0], axis: [0, -1], normal: [1, 0] },
  ];
  for (const { dir, origin, axis, normal } of SIDES) {
    for (const a of alongs) {
      path.push({ x: origin[0] + axis[0] * a, z: origin[1] + axis[1] * a, nx: normal[0], nz: normal[1], dir, along: a });
    }
    // The corner after this side, round a centre inset by the radius.
    const cx = origin[0] + axis[0] * straight + normal[0] * corner;
    const cz = origin[1] + axis[1] * straight + normal[1] * corner;
    for (let k = 1; k < cornerSteps; k++) {
      const f = k / cornerSteps;
      // From pointing out of this side to pointing out along the axis.
      const ox = -normal[0] * (1 - f) + axis[0] * f;
      const oz = -normal[1] * (1 - f) + axis[1] * f;
      const len = Math.hypot(ox, oz);
      const ux = ox / len; const uz = oz / len;
      path.push({ x: cx + ux * corner, z: cz + uz * corner, nx: -ux, nz: -uz, dir: -1, along: 0 });
    }
  }
  const doorway = [0, 1, 2, 3].map((d) => !!sides[d] && (sides[d].kind === 'alley' || sides[d].kind === 'portal'));
  const surfaces = new Map();
  const vertex = (p, row) => {
    const [ins, h, t] = profile[row];
    return {
      x: pos.x + p.x + p.nx * ins, y: pos.y + h, z: pos.z + p.z + p.nz * ins,
      nx: p.nx * Math.cos(t), ny: -Math.sin(t), nz: p.nz * Math.cos(t),
    };
  };
  // A stair's opening in the ceiling, a little wider, in the room's frame.
  const overHole = (v) => holes.some((h) => v.x - pos.x > h.x0 - 0.15 && v.x - pos.x < h.x1 + 0.15
    && v.z - pos.z > h.z0 - 0.15 && v.z - pos.z < h.z1 + 0.15);
  for (let i = 0; i < path.length; i++) {
    const a = path[i]; const b = path[(i + 1) % path.length];
    const sameSide = a.dir === b.dir && a.dir >= 0;
    const inDoor = sameSide && doorway[a.dir]
      && Math.max(a.along, b.along) <= DOOR_W / 2 + 1e-6 && Math.min(a.along, b.along) >= -DOOR_W / 2 - 1e-6;
    for (let r = 0; r < profile.length - 1; r++) {
      if (inDoor && profile[r + 1][1] <= DOOR_H + 1e-6) continue;
      // Two triangles facing into the room.
      const quad = [vertex(a, r), vertex(b, r), vertex(b, r + 1), vertex(a, r), vertex(b, r + 1), vertex(a, r + 1)];
      if (holes.length && profile[r + 1][1] > DOOR_H && quad.some(overHole)) continue;
      const name = surface(profile[r + 1][1]);
      if (!surfaces.has(name)) surfaces.set(name, [[], []]);
      const [pos3, nor] = surfaces.get(name);
      for (const v of quad) { pos3.push(v.x, v.y, v.z); nor.push(v.nx, v.ny, v.nz); }
    }
  }
  const ao = shade ? (x, y) => wallAo(pos.y)(x, y) * shade(y - pos.y) : wallAo(pos.y);
  for (const [name, [p, n]] of surfaces) {
    if (!p.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    batcher.add(geo, name, IDENTITY, { chunk, normals: true, ao });
  }
  // Ribs over the pair of walls with fewer doors in them, and a beam across
  // the flat of the ceiling from one to the other.
  const pair = (doorway[0] ? 1 : 0) + (doorway[2] ? 1 : 0) <= (doorway[1] ? 1 : 0) + (doorway[3] ? 1 : 0) ? [0, 2] : [1, 3];
  const ribAo = shade ? (x, y) => shade(y - pos.y) : null;
  for (const along of ribs) {
    for (const dir of pair) {
      const side = SIDES[dir];
      const p0 = { x: side.origin[0] + side.axis[0] * along, z: side.origin[1] + side.axis[1] * along, nx: side.normal[0], nz: side.normal[1] };
      const p3 = []; const n3 = [];
      for (let r = 0; r < profile.length - 1; r++) {
        const quad = [];
        for (const [rr, w] of [[r, -ribW], [r, ribW], [r + 1, ribW], [r, -ribW], [r + 1, ribW], [r + 1, -ribW]]) {
          const v = vertex(p0, rr);
          quad.push({
            ...v,
            x: v.x + side.axis[0] * w + v.nx * 0.05, y: v.y + v.ny * 0.05, z: v.z + side.axis[1] * w + v.nz * 0.05,
          });
        }
        if (holes.length && quad.some(overHole)) continue;
        for (const v of quad) { p3.push(v.x, v.y, v.z); n3.push(v.nx, v.ny, v.nz); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p3, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(n3, 3));
      batcher.add(geo, rib, IDENTITY, { chunk, normals: true, ao: ribAo });
    }
    const across = 2 * H - 2 * cove;
    const bx = pair[0] === 0 ? along : 0; const bz = pair[0] === 0 ? 0 : along;
    const beam = { x: pos.x + (pair[0] === 0 ? bx : 0), z: pos.z + (pair[0] === 0 ? 0 : bz) };
    if (across > 0.3 && !(holes.length && overHole({ x: beam.x, z: beam.z }))) {
      batcher.add(box(pair[0] === 0 ? ribW * 2 : across, 0.2, pair[0] === 0 ? across : ribW * 2), rib,
        place(beam.x, pos.y + CEIL - 0.1, beam.z), { chunk, ao: ribAo });
    }
  }
  const lanterns = pair[0] === 0 ? [[-2.7, -1.2], [2.7, 1.2]] : [[-1.2, -2.7], [1.2, 2.7]];
  // The rounded corners stand inside the room's square colliders.
  const c = H - corner * (1 - Math.SQRT1_2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x0 = pos.x + sx * c; const z0 = pos.z + sz * c;
      addCollider(Math.min(x0, pos.x + sx * H), Math.max(x0, pos.x + sx * H),
        Math.min(z0, pos.z + sz * H), Math.max(z0, pos.z + sz * H), pos.y, pos.y + CEIL);
    }
  }
  return lanterns;
}

// ------------------------------------------------------------ room shells ----

/**
 * The room-frame helpers every shell below uses: `along` runs the wall's way,
 * the same frame `buildSmialVault` walks, and `inset` is measured into the
 * room from the inner face at ROOM/2.
 */
const SHELL_SIDES = [
  { origin: [0, -1], axis: [1, 0], normal: [0, 1] },
  { origin: [1, 0], axis: [0, 1], normal: [-1, 0] },
  { origin: [0, 1], axis: [-1, 0], normal: [0, -1] },
  { origin: [-1, 0], axis: [0, -1], normal: [1, 0] },
];
const onWall = (pos, dir, along, inset, face = ROOM / 2) => {
  const { origin, axis, normal } = SHELL_SIDES[dir];
  return {
    x: pos.x + origin[0] * face + axis[0] * along + normal[0] * inset,
    z: pos.z + origin[1] * face + axis[1] * along + normal[1] * inset,
  };
};
/** A box lying along wall `dir`: `len` along it, `h` tall, `d` deep into the room. */
function wallBox(batcher, chunk, material, pos, dir, a0, a1, y0, y1, i0, i1, opts = {}) {
  const c = onWall(pos, dir, (a0 + a1) / 2, (i0 + i1) / 2);
  const along = dir === 0 || dir === 2;
  const len = a1 - a0; const d = i1 - i0;
  batcher.add(box(along ? len : d, y1 - y0, along ? d : len), material, place(c.x, pos.y + (y0 + y1) / 2, c.z), { chunk, ...opts });
  return c;
}
const openSide = (side) => !!side && (side.kind === 'alley' || side.kind === 'portal');
/** Spans of a wall clear of its doorway, `pad` past each jamb. */
const wallRuns = (side, pad = 0.1, half = ROOM / 2) => (openSide(side)
  ? [[-half, -DOOR_W / 2 - pad], [DOOR_W / 2 + pad, half]] : [[-half, half]]);

/**
 * "A dark burial chamber beneath a large tomb stone." Loculi -- shelf graves --
 * cut into every wall the stair does not come down against: two tiers of three
 * under the spring of the vault, a masonry band half a metre deep with the
 * recesses left in it. Some are sealed with a slab, some are open with what is
 * left of the dead in them. The band stands where the wall is, so it takes the
 * wall's collider out to its own face.
 */
const LOCULI = [[-4.3, -2.1], [-1.1, 1.1], [2.1, 4.3]];
const TIERS = [[0.35, 0.95], [1.2, 1.8]];
function buildTombNiches({ batcher, instances, chunk, room, pos, sides, stairDir, addCollider, material, decor, lights }) {
  const D = 0.5;
  // Somebody still keeps a light for them: a candle or two, in open niches
  // of the lower tier. Without them the chamber read as a black box.
  let candles = instances && instances.library.get('furn_candle') ? 2 : 0;
  for (let dir = 0; dir < 4; dir++) {
    if (sides[dir] && !deadExit(sides[dir].exit)) continue;
    // The flight's foot is against this wall and three metres wide.
    const bays = dir === stairDir ? [LOCULI[0], LOCULI[2]] : LOCULI;
    const spans = dir === stairDir ? [[-5, -2.0], [2.0, 5]] : [[-5, 5]];
    for (const [s0, s1] of spans) {
      // Plinth, the shelf between the tiers, and the cornice under the vault.
      for (const [y0, y1] of [[0, 0.35], [0.95, 1.2], [1.8, 2.0]]) {
        wallBox(batcher, chunk, material, pos, dir, s0, s1, y0, y1, 0, D, { ao: wallAo(pos.y) });
      }
      // Piers between the bays, up both tiers.
      const edges = [s0, ...bays.flat().filter((a) => a > s0 && a < s1), s1];
      for (let k = 0; k < edges.length; k += 2) {
        if (edges[k + 1] - edges[k] < 0.05) continue;
        for (const [y0, y1] of TIERS) wallBox(batcher, chunk, material, pos, dir, edges[k], edges[k + 1], y0, y1, 0, D, { ao: wallAo(pos.y) });
      }
      const r0 = onWall(pos, dir, s0, 0); const r1 = onWall(pos, dir, s1, D);
      addCollider(Math.min(r0.x, r1.x), Math.max(r0.x, r1.x), Math.min(r0.z, r1.z), Math.max(r0.z, r1.z), pos.y, pos.y + 2.0);
    }
    bays.forEach(([a0, a1], b) => {
      TIERS.forEach(([y0, y1], t) => {
        const roll = hash3(room.vnum, dir * 8 + b, t, 131);
        if (roll < 0.42) {
          // Sealed: a slab set a few centimetres back in the opening.
          wallBox(batcher, chunk, material, pos, dir, a0 + 0.04, a1 - 0.04, y0 + 0.03, y1 - 0.03, D - 0.12, D - 0.06, { ao: () => 0.82 });
        } else if (instances && roll > 0.6) {
          const c = onWall(pos, dir, (a0 + a1) / 2 + (roll - 0.8) * 0.8, 0.26);
          instances.add('bone_pile', { x: c.x, y: pos.y + y0, z: c.z, rotY: roll * 12, scale: 0.42 }, chunk);
        } else if (candles && t === 0 && (candles === 2 || b === 2)) {
          candles--;
          const c = onWall(pos, dir, (a0 + a1) / 2, 0.3);
          instances.add('furn_candle', { x: c.x, y: pos.y + y0, z: c.z, rotY: 0 }, chunk);
          decor.push({ kind: 'torch', bare: true, candle: true, x: c.x, y: pos.y + y0 + 0.215, z: c.z });
          const l = onWall(pos, dir, (a0 + a1) / 2, 0.9);
          lights.push({ x: l.x, y: pos.y + y0 + 0.5, z: l.z, color: 0xffb060, intensity: 8, radius: 12, flicker: true });
        }
      });
    });
  }
}

/**
 * A log wall, both faces: "a small one-room cabin made entirely from heavy
 * logs", "the cafe is built from large logs". Round logs stacked on the two
 * skins, touching, with the skins' lime daub showing in the lines between them
 * as chinking. Outside they run past the corners and cross, the two pairs of
 * walls half a course apart, the way `log_cabin` is built (props.py); inside
 * they butt. Bark UVs run along each log, which the Batcher's projection could
 * not do on a curve.
 */
const LOG_R = 0.18;
// A little over two radii: the daub between the logs shows as a pale line,
// which is what draws each log's round against the one above it.
const LOG_PITCH = 0.4;
const LOG_OVER = 0.34;
function logGeometry(length, r, uvScale, grainAlongU = false) {
  const geo = new THREE.CylinderGeometry(r, r, length, 12, 1, false);
  const uv = geo.attributes.uv;
  // Around the log and along it, in metres, then into the tile. Bark runs its
  // fissures up v; planed wood its grain along u.
  for (let i = 0; i < uv.count; i++) {
    const round = uv.getX(i) * Math.PI * 2 * r * uvScale; const along = uv.getY(i) * length * uvScale;
    if (grainAlongU) uv.setXY(i, along, round); else uv.setXY(i, round, along);
  }
  geo.rotateZ(Math.PI / 2);
  return geo;
}
function buildLogWalls({ batcher, chunk, pos, sides, addCollider, windows, materials }) {
  const add = (x0, x1, y, zc, alongX, f) => {
    if (x1 - x0 < 0.2) return;
    const r = LOG_R * (0.93 + hash3(Math.round(x0 * 10), Math.round(y * 10), Math.round(zc * 10), 141) * 0.14);
    const geo = logGeometry(x1 - x0, r, materials[f.material].userData.uvScale, f.inside);
    const m = alongX
      ? place((x0 + x1) / 2, y, zc, 0)
      : place(zc, y, (x0 + x1) / 2, Math.PI / 2);
    batcher.add(geo, f.material, m, { chunk, normals: true, keepUv: true, tint: f.tint });
    geo.dispose();
  };
  const faces = [
    // Inside, peeled and adzed: honey-coloured round logs, butting at the
    // corners, their centres just proud of the daubed inner face.
    { face: ROOM / 2 - LOG_R * 0.5, reach: ROOM / 2 - LOG_R * 0.5, top: CEIL - 0.3, stagger: false, inside: true, material: 'wood', tint: [1.08, 1.0, 0.9] },
    // Outside in the bark, the way `log_cabin` is: running past the corner
    // and crossing the other pair half a course up.
    { face: SHELL + LOG_R * 0.3, reach: SHELL + LOG_OVER, top: CEIL + 1.1, stagger: true, inside: false, material: 'bark', tint: [0.92, 0.88, 0.84] },
  ];
  for (const f of faces) {
    for (let dir = 0; dir < 4; dir++) {
      const [dx, , dz] = DIR_STEP[dir];
      const alongX = dz !== 0;
      const zc = (alongX ? pos.z : pos.x) + (alongX ? dz : dx) * f.face;
      const c0 = alongX ? pos.x : pos.z;
      const lift = f.stagger && !alongX ? LOG_PITCH / 2 : 0;
      for (let y = LOG_R * 0.9 + lift; y < f.top - LOG_R * 0.5; y += LOG_PITCH) {
        let cuts = [];
        if (openSide(sides[dir]) && y < DOOR_H + LOG_R) cuts.push([-DOOR_W / 2, DOOR_W / 2]);
        // Outside, clear of the casements `actors.js` lays on this face.
        if (!f.inside && windows) {
          for (const w of windows) if (y > w.y0 && y < w.y1) cuts.push([w.a - w.half, w.a + w.half]);
        }
        // The fitting frame's `along` runs against the world axis on two sides;
        // cuts here are symmetric, so the sign does not matter.
        cuts = cuts.sort((a, b) => a[0] - b[0]);
        let a = -f.reach;
        for (const [k0, k1] of cuts) { add(c0 + a, c0 + k0, pos.y + y, zc, alongX, f); a = Math.max(a, k1); }
        add(c0 + a, c0 + f.reach, pos.y + y, zc, alongX, f);
      }
      if (f.inside) {
        // A squared wall plate along the top, which the joists sit on.
        wallBox(batcher, chunk, 'timber', pos, dir, -ROOM / 2, ROOM / 2, CEIL - 0.34, CEIL, 0, 0.3);
        // A log cut at a doorway shows a cylinder's end; a board each side and
        // over the head closes it, as `log_cabin` trims its own openings.
        if (openSide(sides[dir])) {
          for (const sgn of [-1, 1]) wallBox(batcher, chunk, 'timber', pos, dir, sgn * (DOOR_W / 2) - 0.11, sgn * (DOOR_W / 2) + 0.11, 0, DOOR_H + 0.1, -0.02, 0.3);
          wallBox(batcher, chunk, 'timber', pos, dir, -DOOR_W / 2 - 0.11, DOOR_W / 2 + 0.11, DOOR_H, DOOR_H + 0.26, -0.02, 0.3);
        }
        for (const [r0, r1] of wallRuns(sides[dir], 0.12)) {
          const p0 = onWall(pos, dir, r0, 0); const p1 = onWall(pos, dir, r1, LOG_R * 1.1);
          addCollider(Math.min(p0.x, p1.x), Math.max(p0.x, p1.x), Math.min(p0.z, p1.z), Math.max(p0.z, p1.z), pos.y, pos.y + CEIL);
        }
      }
    }
  }
}

/**
 * The town's civic rooms and the Shire's inns: panelling to the height of a
 * chair back -- a skirting, stiles and rails, a capping rail -- plaster above.
 * `beams` crosses the ceiling with joists where nothing else does.
 */
function buildWainscot({ batcher, chunk, pos, sides, tint = null, beams = false, holes = [] }) {
  const H = 1.25;
  const opts = { chunk, tint, ao: wallAo(pos.y) };
  for (let dir = 0; dir < 4; dir++) {
    for (const [a0, a1] of wallRuns(sides[dir], 0.05)) {
      wallBox(batcher, chunk, 'wood', pos, dir, a0, a1, 0, H, 0, 0.035, opts);
      wallBox(batcher, chunk, 'wood', pos, dir, a0, a1, 0, 0.2, 0, 0.07, opts);
      wallBox(batcher, chunk, 'wood', pos, dir, a0, a1, H - 0.08, H, 0, 0.085, opts);
      wallBox(batcher, chunk, 'wood', pos, dir, a0, a1, H - 0.34, H - 0.26, 0, 0.06, opts);
      const n = Math.max(1, Math.round((a1 - a0) / 0.95));
      for (let k = 0; k <= n; k++) {
        const a = a0 + ((a1 - a0) * k) / n;
        wallBox(batcher, chunk, 'wood', pos, dir, Math.max(a0, a - 0.05), Math.min(a1, a + 0.05), 0.2, H - 0.08, 0, 0.06, opts);
      }
    }
  }
  if (!beams) return;
  const hole = holes.length ? unionRect(holes) : null;
  for (const off of [-3.0, 0, 3.0]) {
    if (hole && off + 0.2 > hole.z0 && off - 0.2 < hole.z1) continue;
    batcher.add(box(ROOM, 0.28, 0.24), 'timber', place(pos.x, pos.y + CEIL - 0.14, pos.z + off), { chunk });
  }
}

/**
 * A jail, a torture room: iron in the walls. On each wall with nothing in it,
 * two staples with a ring and a length of chain hanging from each to a
 * manacle -- "along the walls skeletons are hanging in rusty chains".
 */
function buildShackles({ batcher, chunk, pos, sides, iron }) {
  const ring = new THREE.TorusGeometry(0.085, 0.017, 5, 12);
  const link = new THREE.TorusGeometry(0.032, 0.009, 4, 8);
  const cuff = new THREE.TorusGeometry(0.055, 0.014, 5, 12);
  const _m = new THREE.Matrix4(); const _r = new THREE.Matrix4();
  for (let dir = 0; dir < 4; dir++) {
    if (openSide(sides[dir])) continue;
    const face = (dir === 1 || dir === 3) ? Math.PI / 2 : 0;
    for (const along of [-2.3, 2.3]) {
      const top = 2.25 + hash3(pos.x, pos.z, dir * 4 + (along > 0 ? 1 : 0), 151) * 0.3;
      wallBox(batcher, chunk, iron, pos, dir, along - 0.07, along + 0.07, top - 0.1, top + 0.12, 0, 0.035);
      const at = onWall(pos, dir, along, 0.06);
      // The ring hangs flat against the wall from its staple.
      _m.makeRotationY(face); _m.setPosition(at.x, pos.y + top - 0.09, at.z);
      batcher.add(ring, iron, _m, { chunk, normals: true });
      const links = 9 + Math.floor(hash3(pos.x, pos.z, dir * 4 + (along > 0 ? 3 : 2), 153) * 6);
      for (let k = 0; k < links; k++) {
        const c = onWall(pos, dir, along, 0.075);
        _m.makeRotationY(face + (k % 2 ? Math.PI / 2 : 0));
        _m.setPosition(c.x, pos.y + top - 0.2 - k * 0.055, c.z);
        batcher.add(link, iron, _m, { chunk, normals: true });
      }
      const c = onWall(pos, dir, along, 0.1);
      _r.makeRotationX(Math.PI / 2);
      _m.makeRotationY(face).multiply(_r); _m.setPosition(c.x, pos.y + top - 0.25 - links * 0.055, c.z);
      batcher.add(cuff, iron, _m, { chunk, normals: true });
    }
  }
  ring.dispose(); link.dispose(); cuff.dispose();
}

/**
 * "You are standing by an old and worn well from before this century ... the
 * well leads down into darkness. Metal bars implanted in the side of the well
 * lead down as a ladder." The opening already has its kerb (`buildStair`);
 * over it, a windlass: two posts, a drum with a crank, rope down to a bucket.
 */
function buildWellhead({ batcher, instances, chunk, pos, hole, wood }) {
  const cx = pos.x + (hole.x0 + hole.x1) / 2; const cz = pos.z + (hole.z0 + hole.z1) / 2;
  const wideX = hole.x1 - hole.x0 > hole.z1 - hole.z0;
  // Posts off the long sides' middles, the drum across the short way.
  const half = (wideX ? hole.z1 - hole.z0 : hole.x1 - hole.x0) / 2 + 0.45;
  const top = 2.9;
  for (const s of [-1, 1]) {
    const px = cx + (wideX ? 0 : s * half); const pz = cz + (wideX ? s * half : 0);
    batcher.add(box(0.24, top + 0.2, 0.24), wood, place(px, pos.y + (top + 0.2) / 2, pz), { chunk });
  }
  const drum = new THREE.CylinderGeometry(0.16, 0.16, half * 2, 12);
  drum.rotateZ(Math.PI / 2);
  batcher.add(drum, wood, place(cx, pos.y + top - 0.15, cz, wideX ? Math.PI / 2 : 0), { chunk, normals: true });
  drum.dispose();
  // The crank, out past one post.
  const kx = cx + (wideX ? 0 : half + 0.2); const kz = cz + (wideX ? half + 0.2 : 0);
  batcher.add(box(0.06, 0.45, 0.06), 'rustiron', place(kx, pos.y + top - 0.35, kz), { chunk });
  const rope = new THREE.CylinderGeometry(0.02, 0.02, 1.9, 6);
  batcher.add(rope, 'rope', place(cx, pos.y + top - 0.15 - 0.95, cz), { chunk, normals: true });
  rope.dispose();
  if (instances) instances.add('bucket', { x: cx, y: pos.y + top - 2.4, z: cz, rotY: 0.4 }, chunk);
}

/** A vast cavern's roof, where nothing stands on the cell above. */
const VAST_CEIL = CEIL * 2;
/** How far past the outer skin a log wall's face stands. */
const LOG_FACE = 0.2;

/** Rooms and passages on the cell above this one: a vast cavern needs none. */
const roomsAbove = (layout, cell) => (layout.at(cell.level + 1, cell.x, cell.z) !== undefined ? 1 : 0)
  + (layout.isPath(cell.level + 1, cell.x, cell.z) ? 1 : 0);
/**
 * How high a room's ceiling is. A vast cavern goes to twice the storey with
 * nothing over it, and otherwise right up under the floor of the room above --
 * #5011's way out is a stair up, so "miles away" has to fit in one level.
 */
const ceilingOf = (room, cell, layout) => {
  const shell = shellFor(room);
  if (!shell || !shell.vast || isOpenAir(room)) return CEIL;
  return roomsAbove(layout, cell) ? LEVEL_H - 2 * SLAB - 0.02 : VAST_CEIL;
};

/**
 * The lining a room's shell puts inside its walls (src/shells.js for which
 * rooms). Materials were chosen in `pickMaterials`; this is the geometry that
 * makes a tomb a vault and a cafe a log house rather than a box wearing
 * another texture. Caves and smials are built by their own long-standing
 * paths and need nothing here.
 */
function buildShell({ kind, batcher, instances, chunk, room, cell, pos, sides, addCollider, lights, decor, mats, materials, holes, stairDir }) {
  if (!kind) return;
  const deep = !!mats.sewer;
  if (kind === 'tomb') {
    // A low vault: the walls spring at two metres and turn in to the crown.
    buildVaultLining({
      batcher, chunk, pos, sides, addCollider, spring: 2.0, corner: 0.6,
      surface: () => mats.wallIn, rib: mats.wallIn, ribW: 0.2, holes,
      shade: (h) => 0.92 - 0.2 * Math.min(1, Math.max(0, (h - 2) / 3.2)),
    });
    buildTombNiches({ batcher, instances, chunk, room, pos, sides, stairDir, addCollider, material: mats.wallIn, decor, lights });
  } else if (kind === 'vault') {
    // "Dark smoke-stained stones arch over": the soot climbs the curve.
    buildVaultLining({
      batcher, chunk, pos, sides, addCollider, spring: VAULT_SPRING, corner: 0.9,
      surface: () => mats.wallIn, rib: mats.wallIn, ribW: 0.24, holes,
      shade: (h) => 1 - 0.55 * Math.min(1, Math.max(0, (h - 2.2) / 2.8)),
    });
  } else if (kind === 'dungeon') {
    buildShackles({ batcher, chunk, pos, sides, iron: deep ? 'rustiron' : 'rust' });
    // Nobody hangs a torch in a torture room under the sewer; they keep a
    // brazier for the irons, in the corner furthest from the way in.
    if (deep && instances) {
      const way = [0, 1, 2, 3].find((d) => openSide(sides[d])) ?? 2;
      const [wx, , wz] = DIR_STEP[way];
      const sx = wx ? -wx : 1; const sz = wz ? -wz : 1;
      // Not `hoodBrazier`: its light is an outdoor one, which the hour puts
      // out at noon, and down here noon is as dark as midnight.
      const x = pos.x + sx * 3.4; const z = pos.z + sz * 3.4;
      const top = instances.library.get('brazier')?.bounds?.max.y;
      if (top !== undefined && hoodProp({ instances, chunk, addCollider, name: 'brazier', x, y: pos.y, z, half: [0.42, 0.42], height: 1.1 })) {
        decor.push({ kind: 'torch', bare: true, x, y: pos.y + top - 0.12, z });
        lights.push({ x, y: pos.y + top + 0.5, z, color: 0xff8a3a, intensity: 16, radius: 12, flicker: true });
      }
    }
  } else if (kind === 'lair') {
    // The heat is in the floor: a low red light out of the cracks, which is
    // what the scorch on the walls is lit by.
    for (const [ox, oz] of [[-2.4, 1.8], [2.2, -2.0], [1.6, 2.6]]) {
      lights.push({ x: pos.x + ox, y: pos.y + 0.6, z: pos.z + oz, color: 0xff5a20, intensity: 12, radius: 10, flicker: true });
    }
  } else if (kind === 'log') {
    const span = (SHELL + LOG_FACE) * 2;
    const cols = Math.max(1, Math.floor(span / 3.0));
    const windows = [];
    for (let c = 0; c < cols; c++) {
      const a = (c - (cols - 1) / 2) * (span / cols);
      // actors.js leaves the middle one out for the door on every face.
      if (Math.abs(a) >= 1.5) windows.push({ a, half: 0.78, y0: 0.72, y1: 2.9 });
    }
    buildLogWalls({ batcher, chunk, pos, sides, addCollider, windows, materials });
    // Round joists across, the same logs.
    const uv = materials.wood.userData.uvScale;
    const hole = holes.length ? unionRect(holes) : null;
    for (const off of [-3.1, 0, 3.1]) {
      if (hole && off + 0.3 > hole.z0 && off - 0.3 < hole.z1) continue;
      const geo = logGeometry(ROOM, 0.17, uv, true);
      batcher.add(geo, 'wood', place(pos.x, pos.y + CEIL - 0.19, pos.z + off), { chunk, normals: true, keepUv: true, tint: [0.95, 0.88, 0.8] });
      geo.dispose();
    }
  } else if (kind === 'panelled') {
    buildWainscot({ batcher, chunk, pos, sides, tint: [0.82, 0.74, 0.66], beams: !mats.shire, holes });
  } else if (kind === 'inn') {
    // Darker, and older: a taproom's panelling has had a century of pipes.
    buildWainscot({ batcher, chunk, pos, sides, tint: [0.62, 0.52, 0.45] });
  }
}

/**
 * Light that hangs, for rooms where a torch in an iron bracket is wrong: a
 * barn full of hay, a halfling's parlour. The desert's lantern, on its chain
 * from a beam, with the flame and the light where the tents put theirs.
 */
function hangLanterns({ instances, chunk, pos, decor, lights, room, points }) {
  points.forEach(([ox, oz], i) => {
    const lx = pos.x + ox; const lz = pos.z + oz;
    const top = pos.y + CEIL - 0.3;
    instances.add('lantern', { x: lx, y: top, z: lz, rotY: hash3(room.vnum, i, 0, 91) * 6.28 }, chunk);
    decor.push({ kind: 'torch', bare: true, x: lx, y: top - 1.72, z: lz });
    lights.push({ x: lx, y: top - 2.0, z: lz, color: 0xffb566, intensity: 22, radius: 14, flicker: true });
  });
}

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
  // An inn that does not say so in its name -- "The Green Dragon" -- says so
  // in its prose: patrons, and something to eat or drink. Both, because the
  // street outside names the inn too, and a morgue has patrons of its own.
  if (/\bpatrons\b/i.test(room.description) && /\b(food|drink|ale|beer|hostess|innkeep\w*)\b/i.test(room.description)
    && !NOT_THE_ROOM_ITSELF.test(room.name)) loose(/./, 'counter');
  loose(/\bcounter\b/i, 'counter');
  loose(/\b(fireplace|hearth|forge)\b/i, 'hearth');
  loose(/\bshelves\b/i, 'shelves');
  loose(/\baltar\b/i, 'altar');

  return [...found].map(([kind, dir]) => ({ kind, dir }));
}

/**
 * The trade a room is kept for: its shopkeeper's first, then its own name.
 * This is what tells a smithy's counter from a tavern's -- both are a counter
 * in the prose, and the smithy was getting bar stools, a gantry of bottles
 * and three tables with benches. Measured over all 45 areas: every keyword
 * here lands on a keeper of that trade and nothing else.
 */
const TRADE_KEEPER = [
  ['tavern', /\b(bartender|barkeep|barmaid|waiter|waitress|innkeeper|hostess|landlord|publican|maid)\b/i],
  ['smith', /\b(blacksmith|weaponsmith|swordsmith|smith)\b/i],
  ['armourer', /\barmou?rer\b/i],
  ['baker', /\bbaker\b/i],
  ['grocer', /\b(grocer|shopkeeper|storekeeper)\b/i],
  ['magic', /\b(wizard|alchemist)\b/i],
  ['leather', /\bleather\b/i],
];
const TRADE_ROOM = [
  ['smith', /\b(smithy|forge|weapon ?shop|house of arms)\b/i],
  ['armourer', /\barmou?ry\b/i],
  ['baker', /\bbakery\b/i],
  ['grocer', /\b(general store|grocer)/i],
  ['leather', /\bleather shop\b/i],
];
export function tradeOf(room) {
  for (const mob of room.mobs || []) {
    if (!mob.shop) continue;
    const words = `${mob.proto.keywords} ${mob.proto.short}`;
    for (const [trade, pattern] of TRADE_KEEPER) if (pattern.test(words)) return trade;
  }
  if (TAPROOM.test(room.name) && !NOT_THE_ROOM_ITSELF.test(room.name)) return 'tavern';
  for (const [trade, pattern] of TRADE_ROOM) if (pattern.test(room.name)) return trade;
  return null;
}
/** Trades served across a counter, whether or not the prose mentions one. */
const COUNTER_TRADES = new Set(['tavern', 'smith', 'armourer', 'baker', 'grocer']);

/**
 * Footprints of the furniture actors.js places (tools/blender/furniture.py),
 * in the fitting frame: x0..x1 along the wall, z0..z1 out of it from the
 * model's origin, which is on the wall line for pieces that stand against
 * one and at the middle for the rest. Measured off the exported files.
 */
export const PIECES = {
  cask_rack: { model: 'furn_cask_rack', x0: -1.06, x1: 1.06, z0: 0, z1: 1.04, h: 0.75 },
  // `high`: half the span along the wall that stands past 2.2 m, where a wall
  // torch's bracket is -- a hood and flue, a board of weapons, a rack's top.
  forge: { model: 'furn_forge', x0: -2.2, x1: 1.58, z0: 0, z1: 1.14, h: 0.9, high: 1.0 },
  anvil: { model: 'furn_anvil', x0: -0.36, x1: 0.51, z0: -0.31, z1: 0.32, h: 0.85 },
  grindstone: { model: 'furn_grindstone', x0: -0.43, x1: 0.56, z0: -0.56, z1: 0.56, h: 1.07 },
  weapon_rack: { model: 'furn_weapon_rack', x0: -0.89, x1: 0.89, z0: 0, z1: 0.46, h: 2.24, high: 0.9 },
  // Hung on the wall from 0.9 m up: nothing to walk into, but nothing to put
  // against the wall under it either.
  weapon_board: { model: 'furn_weapon_board', x0: -0.96, x1: 0.96, z0: 0, z1: 0.3, h: 0, high: 1.0 },
  armour_stand: { model: 'furn_armour_stand', x0: -0.44, x1: 0.44, z0: -0.36, z1: 0.36, h: 1.77 },
  oven: { model: 'furn_oven', x0: -1.0, x1: 1.04, z0: 0, z1: 2.1, h: 1.8, high: 0.6 },
  bed: { model: 'furn_bed', x0: -0.52, x1: 0.52, z0: 0, z1: 2.06, h: 0.6 },
  desk: { model: 'furn_desk', x0: -0.91, x1: 0.91, z0: -0.44, z1: 0.44, h: 0.8 },
  chair: { model: 'furn_chair', x0: -0.24, x1: 0.24, z0: -0.25, z1: 0.23, h: 0.97 },
  armchair: { model: 'furn_armchair', x0: -0.42, x1: 0.42, z0: -0.56, z1: 0.42, h: 0.7 },
  // "A large oak table": the board table drawn out to 2.1 x 1.05, not taller.
  worktable: { model: 'furn_table_board', x0: -1.07, x1: 1.07, z0: -0.55, z1: 0.55, h: 0.83, scale: [1.4, 1, 1.4] },
};

// "A bed, a chair and a table", "two beds to the side" -- a bed the text puts
// in the room, not a river bed or an armchair that "resembles a bed".
const BED = /(?<!(?:resembles|like|river|sea|lava|flower|stream)\s+)\b(?:a|the|two|three|several|many|some|his|her|their|small|large|wooden|straw|unmade|soft)\s+(?:\w+\s+)?(beds?|cots?|bunks?)\b/i;
const BEDROOM = /\b(bed ?room|barracks|sleeping quarters|dormitory)\b/i;
const HOW_MANY_BEDS = (text) => (/\b(several|many|rows? of)\b[^.]{0,20}\b(beds|cots|bunks)\b|\bbarracks\b/i.test(text) ? 3
  : /\b(two|pair of)\s+(\w+\s+)?(beds|cots|bunks)\b/i.test(text) ? 2 : 1);

/**
 * Where things already stand on a room's floor, as rectangles about its
 * centre, and room left for more. Everything here is in the frame
 * `actors.js` builds fittings in: `lx` along wall `dir`, `lz` from the room's
 * centre with the wall's inner face at -ROOM/2.
 */
function floorPlan(sides, holes, style = {}) {
  const FACE = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
  const WALL = -ROOM / 2;
  const taken = [];
  // What stands up past a wall torch's bracket, per wall, as spans along it.
  const tall = [[], [], [], []];
  const rect = (dir, lx0, lx1, lz0, lz1) => {
    const c = Math.round(Math.cos(FACE[dir])); const s = Math.round(Math.sin(FACE[dir]));
    const xs = []; const zs = [];
    for (const lx of [lx0, lx1]) {
      for (const lz of [lz0, lz1]) { xs.push(lx * c + lz * s); zs.push(-lx * s + lz * c); }
    }
    return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  };
  const clear = (r, pad = 0.12) => r.x0 >= WALL - 0.01 && r.x1 <= -WALL + 0.01 && r.z0 >= WALL - 0.01 && r.z1 <= -WALL + 0.01
    && !taken.some((t) => r.x0 < t.x1 + pad && r.x1 > t.x0 - pad && r.z0 < t.z1 + pad && r.z1 > t.z0 - pad);
  // Where you arrive, the ways out, a staircase and the hole it comes up through.
  taken.push({ x0: -1.3, x1: 1.3, z0: -1.3, z1: 1.3 });
  for (let d = 0; d < 4; d++) {
    const side = sides[d];
    if (!side) continue;
    taken.push(side.kind === 'stair' ? rect(d, -2.1, 2.1, WALL, 3.4) : rect(d, -2.0, 2.0, WALL, WALL + 2.0));
  }
  for (const h of holes) taken.push({ x0: h.x0 - 0.3, x1: h.x1 + 0.3, z0: h.z0 - 0.3, z1: h.z1 + 0.3 });
  // The stone kit's engaged buttresses stand 0.62 m proud of its face on every
  // wall, 2.32 to 3.38 m either side of the middle; a smial's corners are
  // rounded off 2.3 m in plan. Measured by raycasting the built rooms.
  for (let d = 0; d < 4; d++) {
    if (style.buttress) for (const s of [-1, 1]) taken.push(rect(d, s * 2.85 - 0.56, s * 2.85 + 0.56, WALL, WALL + 0.55));
    if (style.smial) for (const s of [-1, 1]) taken.push(rect(d, s > 0 ? 2.8 : -5, s > 0 ? 5 : -2.8, WALL, WALL + 2.2));
  }
  const BUTTRESS = [[-3.41, -2.29], [2.29, 3.41]];
  return {
    face: style.face || 0,
    /**
     * Where along its wall a fitting goes and how far it stands off it. A
     * fitting on the wall with the door slides aside; one that lands on a
     * buttress is brought out to stand in front of it (the models carry a
     * backing that closes the gap behind).
     */
    settle(kind, blocked) {
      const half = { hearth: 1.25, shelves: 1.55 }[kind];
      const shift = blocked ? (style.buttress && kind === 'hearth' ? -3.3 : -(1.6 + 1.55)) : 0;
      const out = half && style.buttress && BUTTRESS.some(([a0, a1]) => shift - half < a1 && shift + half > a0) ? 0.55 : 0;
      return { shift, out };
    },
    taken, rect, clear, tall,
    take(r) { taken.push(r); return r; },
    /** A fitting where actors.js will build it, with the floor it needs in front. */
    fitting(kind, dir, shift, bar = false, out = 0) {
      const reach = { counter: [2.35, 2.75], hearth: [1.55, 1.8], shelves: [1.6, 0.5], altar: [1.7, 2.65] }[kind];
      if (reach) taken.push(rect(dir, shift - reach[0], shift + reach[0], WALL, WALL + out + reach[1]));
      // A bar's gantry, a chimney breast and a shelving unit all reach 2.5 m.
      const high = { counter: bar ? 1.95 : 0, hearth: 1.15, shelves: 1.6 }[kind];
      if (high) tall[dir].push([shift - high, shift + high]);
    },
    /**
     * The first clear place for a piece against one of `walls`, trying
     * `alongs` on each; `out` is how far its origin stands off the wall.
     */
    wall(kind, walls, alongs, out = 0, spin = 0) {
      const p = PIECES[kind];
      // A piece turned on its own spot claims the square round everything it
      // could reach.
      const k = spin ? Math.max(-p.x0, p.x1, -p.z0, p.z1) : 0;
      const [x0, x1, z0, z1] = spin ? [-k, k, -k, k] : [p.x0, p.x1, p.z0, p.z1];
      // After the preferred places, anywhere along the wall at all.
      const scan = [];
      for (let a = -4.4; a <= 4.41; a += 0.2) scan.push(Math.round(a * 10) / 10);
      for (const dir of walls) {
        for (const along of [...alongs, ...scan]) {
          const r = rect(dir, along + x0, along + x1, WALL + out + z0, WALL + out + z1);
          if (clear(r)) {
            taken.push(r);
            if (p.high && out === 0) tall[dir].push([along - p.high, along + p.high]);
            return { dir, along, out };
          }
        }
      }
      return null;
    },
  };
}

/**
 * A wall torch hangs at the middle of a blank wall, 2.9 m up, and it was
 * being hung straight through whatever the room's own furniture put there:
 * the Grunting Boar's torch burned in the middle of its gantry of bottles.
 * The torch and its light are slid along the wall to the nearest place clear
 * of anything that tall.
 */
function clearTorches(plan, pos, decor, lights) {
  const FACE = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
  for (let dir = 0; dir < 4; dir++) {
    const spans = plan.tall[dir];
    if (!spans.length) continue;
    const [dx, , dz] = DIR_STEP[dir];
    const onWall = (o) => dx * (o.x - pos.x) + dz * (o.z - pos.z) > ROOM / 2 - 1.2
      && Math.abs(dz * (o.x - pos.x) - dx * (o.z - pos.z)) < 0.3 && Math.abs(o.y - pos.y) < 4;
    const torch = decor.find((d) => d.kind === 'torch' && !d.bare && onWall(d));
    if (!torch) continue;
    // Spans are in the fitting frame, whose `along` runs against the world
    // axis on the south and west walls: measure the torch in the same frame.
    const c = Math.cos(FACE[dir]); const s = Math.sin(FACE[dir]);
    const at = (torch.x - pos.x) * c - (torch.z - pos.z) * s;
    const blocked = (a) => spans.some(([a0, a1]) => a > a0 - 0.35 && a < a1 + 0.35);
    if (!blocked(at)) continue;
    let to = null;
    for (let k = 1; k <= 38 && to === null; k++) {
      for (const a of [at + k * 0.1, at - k * 0.1]) if (to === null && Math.abs(a) < 4.4 && !blocked(a)) to = a;
    }
    if (to === null) continue;
    const light = lights.find((l) => Math.abs(l.x - (torch.x - dx * 0.4)) < 0.05 && Math.abs(l.z - (torch.z - dz * 0.4)) < 0.05);
    for (const o of [torch, light]) {
      if (!o) continue;
      o.x += (to - at) * c;
      o.z -= (to - at) * s;
    }
  }
}

function buildInteriorProps({ room, pos, sides, decor, mats, holes = [], lights = [], kit = null }) {
  const trade = tradeOf(room);
  const fittings = readFittings(room, sides);
  const blank = [0, 1, 2, 3].filter((d) => !sides[d]);
  // A trade served over a counter gets one, on a wall with no door and no
  // other fitting, if the prose did not already put one somewhere.
  if (COUNTER_TRADES.has(trade) && !fittings.some((f) => f.kind === 'counter') && blank.length) {
    const used = new Set(fittings.map((f) => f.dir));
    fittings.push({ kind: 'counter', dir: blank.find((d) => !used.has(d)) ?? blank[0] });
  }
  // "All sorts of items are stacked on shelves behind the counter."
  const counterAt = fittings.find((f) => f.kind === 'counter');
  const shelvesAt = fittings.find((f) => f.kind === 'shelves');
  if (counterAt && shelvesAt && /\bshelves\s+behind\s+the\s+counter\b/i.test(room.description)) shelvesAt.dir = counterAt.dir;
  // Where the walls' inner faces really are: the stone and temple kits stand
  // at 5.10 from the middle, not the 5.00 the procedural walls do, and a
  // Shire room's chair rail stands 0.1 m proud of its plaster.
  // A shell's lining stands proud of the wall too: a log's round, panelling.
  const lining = { log: -LOG_R * 1.5, panelled: -0.09, inn: -0.1 }[mats.shell && mats.shell.kind] ?? 0;
  const plan = floorPlan(sides, holes, {
    face: kit === '' || kit === 'temple_' ? 0.1 : Math.min(lining, mats.shire && mats.shire !== 'barn' ? -0.1 : 0),
    buttress: kit === '', smial: !!mats.smial,
  });
  const piece = (kind, at, spin = 0, extra = null) => decor.push({
    kind: 'piece', piece: kind, dir: at.dir, along: at.along, out: at.out, spin, face: plan.face,
    x: pos.x, y: pos.y, z: pos.z, seed: hash3(room.vnum, at.dir, Math.round(at.along * 10), 77), ...extra,
  });
  for (const f of fittings) {
    // A wall the text names may still be the one with the door in it -- the
    // Grunting Boar's fireplace is in the western wall and west is its only way
    // out. Slide the fitting along until it clears the opening rather than
    // moving it to a wall the mud did not choose.
    const blocked = !!sides[f.dir];
    const { shift, out } = plan.settle(f.kind, blocked);
    decor.push({
      kind: 'fitting', fitting: f.kind, dir: f.dir, blocked, trade, shift, out, face: plan.face,
      // "In the crackling fireplace hangs a big iron pot with boiling water."
      pot: f.kind === 'hearth' && /\b(iron pot|cauldron|kettle)\b/i.test(room.description),
      x: pos.x, y: pos.y, z: pos.z, seed: hash3(room.vnum, f.dir, 0, 71),
    });
    plan.fitting(f.kind, f.dir, shift, !trade || trade === 'tavern', out);
    // A bar with nowhere to sit and drink is a counter. The prose does not
    // list the tables because nobody would think to; "this place makes you
    // feel like home" is the line that stands in for them. A shop's counter is
    // not a bar, and a smithy with three tables and benches in it is a tavern.
    if (f.kind === 'counter' && (trade === 'tavern' || !trade)) {
      const [nx, , nz] = DIR_STEP[f.dir];
      for (let i = 0; i < 3; i++) {
        const along = (i - 1) * 2.9 + (hash3(room.vnum, i, 0, 73) - 0.5) * 0.8;
        const back = 1.7 + hash3(room.vnum, i, 0, 74) * 1.7;
        const tx = -nx * back - nz * along;
        const tz = -nz * back - nx * along;
        decor.push({
          kind: 'table', benches: true,
          x: pos.x + tx,
          y: pos.y,
          z: pos.z + tz,
          spin: (hash3(room.vnum, i, 0, 75) - 0.5) * 0.5,
        });
        plan.take({ x0: tx - 1.15, x1: tx + 1.15, z0: tz - 1.15, z1: tz + 1.15 });
      }
    }
  }

  // The tools of the trade, against walls with no door first.
  const walls = [...blank, ...[0, 1, 2, 3].filter((d) => sides[d])];
  const ends = [-3.2, 3.2, -1.6, 1.6, 0];
  const middle = [0, -1.2, 1.2, -2.6, 2.6];
  if (trade === 'tavern') {
    const at = plan.wall('cask_rack', walls, [3.7, -3.7, 2.6, -2.6]);
    if (at) piece('cask_rack', at);
  } else if (trade === 'smith') {
    const forge = plan.wall('forge', walls, [0.4, -0.6, 1.2, -1.4]);
    if (forge) {
      piece('forge', forge);
      // The anvil a stride out from the fire, turned so the smith stands
      // between the two.
      for (const [da, out] of [[0.2, 2.1], [1.3, 2.0], [-1.1, 2.0], [0.2, 2.6]]) {
        const at = plan.wall('anvil', [forge.dir], [forge.along + da], out, Math.PI / 2);
        if (at) { piece('anvil', at, Math.PI / 2); break; }
      }
    }
    const grind = plan.wall('grindstone', walls, ends, 0.75, Math.PI / 2);
    if (grind) piece('grindstone', grind, Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const at = plan.wall('weapon_rack', walls, ends);
      if (at) piece('weapon_rack', at);
    }
  } else if (trade === 'armourer') {
    // "All kinds of armours on the walls and in the window."
    for (let i = 0; i < 2; i++) {
      const at = plan.wall('armour_stand', walls, ends, 0.55);
      if (at) piece('armour_stand', at);
    }
    const board = plan.wall('weapon_board', walls, [-2.6, 2.6, -3.3, 3.3, 0]);
    if (board) piece('weapon_board', board);
    const rack = plan.wall('weapon_rack', walls, ends);
    if (rack) piece('weapon_rack', rack);
  } else if (trade === 'baker') {
    const at = plan.wall('oven', walls, middle);
    if (at) piece('oven', at);
  } else if (trade === 'leather') {
    // "In the middle of the room is a large oak table."
    const at = plan.wall('worktable', walls, [0, -1.5, 1.5], 2.9);
    if (at) piece('worktable', at);
  }

  // What the prose puts in the room that nobody trades in.
  const text = `${room.name}. ${room.description}`;
  if (/\bdesks?\b/i.test(room.description)) {
    // "Dividing the room in two is a large desk", "a big desk ... standing in
    // the centre of the room": out in the floor, with its chair behind it.
    const desk = plan.wall('desk', walls, [0, -1.4, 1.4, -2.6, 2.6], 2.6);
    if (desk) {
      // "A large and polished but completely empty desk."
      piece('desk', desk, 0, { things: !/\bempty\b/i.test(room.description) });
      const seat = /\barm-?chair\b/i.test(room.description) ? 'armchair' : 'chair';
      const at = plan.wall(seat, [desk.dir], [desk.along], desk.out - (seat === 'armchair' ? 1.1 : 0.95));
      if (at) piece(seat, at);
    }
  }
  if (/\bchairs\b/i.test(room.description)) {
    // "Wooden chairs stand along the walls."
    for (let i = 0; i < 4; i++) {
      const at = plan.wall('chair', walls, [-3.9, 3.9, -3.2, 3.2, -2.5, 2.5], 0.3);
      if (at) piece('chair', at);
    }
  }
  if (BEDROOM.test(room.name) || BED.test(room.description)) {
    for (let i = HOW_MANY_BEDS(text); i > 0; i--) {
      const at = plan.wall('bed', walls, [-3.9, 3.9, -2.6, 2.6, -1.3, 1.3]);
      if (at) piece('bed', at);
    }
  }
  clearTorches(plan, pos, decor, lights);
  buildLooseProps({ room, pos, sides, decor, mats, plan, trade });
  return plan;
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

/**
 * Whether a room out of doors gets the loose clutter at all, and what it draws
 * from. The general list is *street furniture* -- barrels, crates, a water
 * butt, stacked crates -- and it was reaching every open-air room in the world,
 * because the only thing gating it was the cell having a blank side. So a judge
 * photographed barrels standing on the graveyard's grass and the town park
 * strewn with crates, and both readings were correct.
 *
 * A cell that is paved keeps it. A farmyard names its own list and keeps that
 * wherever it stands, since a Shire farm is FIELD and not CITY. A park is a
 * city cell but nobody stacks a barrel on the grass, so it gets the things a
 * park does have. Field, forest and the graveyard get nothing: what belongs
 * there is planted, not stacked, and `buildForest`, `buildPark` and
 * `buildGraveyard` already put it in.
 */
const PARK_PROPS = ['bench', 'bench', 'herb_pots', 'nettles'];
/**
 * A dump is refuse, and the mud names it by name: The Dump is FIELD, so the
 * street clutter never reached it and it came out as a mown lawn round a
 * sewer shaft. What people throw away is what they used: broken crates and
 * barrels, sacks, planks, a cartwheel, a bucket with no bottom.
 */
const REFUSE = /\b(dump|midden|rubbish|refuse|garbage)\b/i;
const REFUSE_PROPS = [
  'sack', 'sack', 'crate', 'planks_pile', 'barrel', 'cartwheel', 'bucket', 'broom',
  'firewood_pile', 'stacked_crates', 'nettles',
];
const wantsClutter = (room) => !GRAVEYARD.test(room.name)
  && (room.sector === SECTOR.CITY || !!farmProps(room) || REFUSE.test(room.name));
const clutterProps = (room) => farmProps(room) || (REFUSE.test(room.name) ? REFUSE_PROPS : null)
  || (isPark(room) ? PARK_PROPS : null);

/**
 * Against a shop's walls, what its trade keeps there. The general list is a
 * guild hall's -- nettles, a hay bale and a trough in a baker's.
 */
const TRADE_PROPS = {
  tavern: ['bench', 'bench', 'barrel', 'barrel_stack', 'firewood_pile', 'crate', 'bucket', 'broom'],
  smith: ['barrel', 'crate', 'firewood_pile', 'bucket', 'planks_pile', 'water_butt'],
  armourer: ['crate', 'stacked_crates', 'barrel'],
  baker: ['sack', 'sack', 'furn_basket', 'furn_basket', 'barrel', 'firewood_pile', 'broom'],
  grocer: ['sack', 'sack', 'furn_basket', 'barrel', 'crate', 'stacked_crates', 'barrel_stack', 'rope_coil'],
  leather: ['crate', 'barrel', 'bucket', 'stacked_crates'],
};

function buildLooseProps({ room, pos, sides, decor, mats, plan = null, trade = null }) {
  const blank = [];
  for (let d = 0; d < 4; d++) if (!sides[d]) blank.push(d);
  if (blank.length && /temple|altar|sanctum|hall|throne/i.test(room.name)) {
    decor.push({ kind: 'banner', x: pos.x, y: pos.y, z: pos.z, dir: blank[0] });
  }
  // An inn with a named landlord was a bare stone box: eighteen prop models
  // existed and only routed alley cells ever placed one. Rooms dress
  // themselves now, against whichever walls have no door in them.
  // The table first, so the clutter knows where it is.
  if (mats.floor === 'planks' && !trade && hash3(room.vnum, 9, 0, 7) > 0.45) {
    const tx = (hash3(room.vnum, 10, 0, 1) - 0.5) * 3.5;
    const tz = (hash3(room.vnum, 11, 0, 2) - 0.5) * 3.5;
    const r = { x0: tx - 1.15, x1: tx + 1.15, z0: tz - 1.15, z1: tz + 1.15 };
    // The arrival square is the one thing this table may overlap: it always has.
    if (!plan || plan.taken.slice(1).every((t) => !(r.x0 < t.x1 && r.x1 > t.x0 && r.z0 < t.z1 && r.z1 > t.z0))) {
      if (plan) plan.take(r);
      decor.push({ kind: 'table', x: pos.x + tx, y: pos.y, z: pos.z + tz });
    }
  }
  if (blank.length) {
    decor.push({
      kind: 'clutter', x: pos.x, y: pos.y, z: pos.z, half: SHELL,
      walls: blank, seed: hash3(room.vnum, 12, 0, 5), indoor: true,
      props: farmProps(room) || TRADE_PROPS[trade] || null,
      // What the furniture already stands on, so a barrel is not stood in it.
      busy: plan ? plan.taken.slice(1) : null,
    });
  }
}

/**
 * What an empty cell is paved with before anything is built on it. Without
 * this the world's ground plane shows through around the footings -- which
 * read as a lawn once that plane became grass.
 *
 * Module scope because `buildVerges` has to know what colour every cell's
 * ground came out, and asking twice in two places is how the two answers drift
 * apart.
 */
const FILLER_GROUND = {
  [SECTOR.CITY]: 'cobble', [SECTOR.FIELD]: 'grass', [SECTOR.FOREST]: 'duff',
  [SECTOR.HILLS]: 'grass', [SECTOR.MOUNTAIN]: 'rock', [SECTOR.DESERT]: 'sand',
  // A lake has a bed like anything else, and without one the filler cells
  // around the marsh lake laid nothing at all: their water planes hung over
  // the world's own ground plane 0.47 m below, which is the other half of
  // what made that lake read as a slab on a plinth.
  [SECTOR.WATER_SWIM]: 'water', [SECTOR.WATER_NOSWIM]: 'water',
};

/** Scenery for an empty cell: houses along a street, trees along a path. */
function buildFiller({ batcher, instances, model, faceRot, chunk, sector, bog, shire, x, y, z, seed, addCollider, lights, decor, walled = [] }) {
  const GROUND = FILLER_GROUND;
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
        decor.push({ kind: 'windows', x, y, z, w, d, h: ch, seed: hash3(x, z, 0, 26), frame: 'timber' });
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
      decor.push({ kind: 'windows', x, y, z, w, d, h, seed: hash3(x, z, 0, 26), frame: stone ? 'stone' : 'timber' });
      if (hash3(x, z, 0, 27) > 0.55) decor.push({ kind: 'smoke', x, y: y + h + roofH, z });
      break;
    }
    case SECTOR.FOREST: {
      // One cell in six stands a dead spar instead of one of its trees: a stand
      // of identical live conifers is wallpaper, and the snag is the thing that
      // says this wood is old. It keeps the trunk's collider either way.
      const snag = instances && hash3(x, z, 0, 161) < 1 / 6 ? model(['tree_snag'], 0) : null;
      const spar = snag ? Math.floor(hash3(x, z, 1, 161) * 5) : -1;
      // A fir's crown is three metres and more across: planted within a stride
      // of the cell edge beside a walled room, it grew through the wall -- one
      // stood in the middle of Haon Dor's cabin, ferns round its foot.
      const keep = (d, v) => (walled[d] ? Math.min(v, HALF - 3.4) : v);
      for (let i = 0; i < 5; i++) {
        let ox = (hash3(x, z, i, 31) - 0.5) * CELL * 0.9;
        let oz = (hash3(x, z, i, 32) - 0.5) * CELL * 0.9;
        ox = -keep(3, -keep(1, ox)); oz = -keep(0, -keep(2, oz));
        const tx = x + ox;
        const tz = z + oz;
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
        clears: walled.some(Boolean) ? edgeClear(walled, 1.6) : null,
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
    case SECTOR.MOUNTAIN: {
      const h = 11;
      batcher.add(box(CELL, h, CELL, 3, 3, 3), 'rock', place(x, y + h / 2 - 0.8, z), { chunk, ao: wallAo(y) });
      addCollider(x - HALF, x + HALF, z - HALF, z + HALF, y, y + h - 0.8);
      break;
    }
    /**
     * Higher ground, as a ridge and not as a block.
     *
     * This shared the mountain's branch: a 13 m cube of rock 4 m tall, its top
     * sheared off at exactly y + 3.2 in every cell that took it. Where two or
     * three of those line up -- and they do, because a room hands its sector to
     * every filler around it -- what you get is a dead flat coping over a dead
     * vertical face running tens of metres, which a judge photographed beside
     * #8304 and read as a coursed party wall crossing the room. Worse, #8304 is
     * the mud's own "You stand atop a hill": the one room that ought to be the
     * high point was standing 3.2 m *below* the ground on two sides of it.
     *
     * A prism instead, the same move the desert dune already makes, and grass
     * rather than rock because `FILLER_GROUND` has already called this cell
     * grass and a green hillside is what the sector means outside a canyon.
     * The rotation is a quarter turn and not the dune's free angle: a
     * CELL-square prism turned to an arbitrary heading overhangs its own cell
     * by up to 2.7 m, which here would push a rock into a neighbouring room's
     * floor. Ridge lines that run two ways and heights that vary by a metre
     * and a half are enough -- two cells no longer share a face or a top edge,
     * and the whole thing slopes to nothing at the cell boundary, so a room
     * beside it looks up a bank rather than at a wall.
     */
    case SECTOR.HILLS: {
      const h = 2.8 + hash3(x, z, 0, 45) * 1.6;
      batcher.add(triPrism(CELL, h, CELL), GROUND[SECTOR.HILLS] || 'grass',
        place(x, y, z, hash3(x, z, 1, 45) > 0.5 ? Math.PI / 2 : 0), { chunk, ao: wallAo(y) });
      addCollider(x - HALF, x + HALF, z - HALF, z + HALF, y, y + h);
      break;
    }
    case SECTOR.DESERT: {
      // A dune, where there is one to be had: the triangular prism that stood
      // here is a roof lying in the sand. All of them face one wind, from the
      // west off the mountains, with a little wander -- dunes on a field that
      // face every way at once read as a scatter of props.
      const dune = model(['dune_a', 'dune_b'], hash3(x, z, 0, 41));
      if (dune && instances) {
        instances.add(dune, { x, y, z, rotY: -Math.PI / 2 + (hash3(x, z, 1, 41) - 0.5) * 0.6, scaleY: 0.8 + hash3(x, z, 2, 41) * 0.5 }, chunk);
        addCollider(x - HALF + 1.2, x + HALF - 1.2, z - HALF + 1.2, z + HALF - 1.2, y, y + 2.6);
        break;
      }
      batcher.add(triPrism(CELL, 2.6, CELL), 'sand', place(x, y, z, hash3(x, z, 0, 41) * Math.PI), { chunk });
      addCollider(x - HALF, x + HALF, z - HALF, z + HALF, y, y + 2.6);
      break;
    }
    case SECTOR.WATER_SWIM: case SECTOR.WATER_NOSWIM: {
      decor.push({ kind: 'water', x, y: y + WATER_LIFT, z, size: CELL + WATER_LAP });
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
      // A walled bank of turf: coursed field stone round it, grass on top. As
      // bare `rock` it was crazy paving 1.6 m high down both sides of the
      // graveyard's lanes.
      batcher.add(box(CELL, h, CELL, 2, 2, 2), 'rubblewall', place(x, y + h / 2 - 0.6, z), { chunk, ao: wallAo(y) });
      batcher.add(plane(CELL, CELL, 2), 'grass', place(x, y + h - 0.6 + 0.01, z), { chunk });
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
 * Keep `scene.fog`'s transmittance and throw away its colour: the surface
 * dissolves into whatever is already in the buffer behind it -- which out here
 * is the sky, at the sky's own radiance -- instead of into an LDR haze colour
 * that at noon is a fifth as bright as the sky it stands for. See the note on
 * `buildHorizon` for the measurement.
 *
 * The maths is the stock `fog_fragment` chunk with the mix taken out, so it
 * reads the same `fogDensity` and `vFogDepth` three already keeps in step with
 * the hour, per fragment. `fogColor` simply falls out of the program; three
 * uploads only the uniforms a program actually declares, so nothing breaks.
 * `depthWrite` stays on: within one ring a nearer blade drawn after a further
 * one must hide it rather than blend twice over it.
 */
function haze(material, clarity = 1) {
  material.transparent = true;
  material.depthWrite = true;
  // `clarity` thins the air for one material: a desert's dry air carries a
  // mesa twice as far as a Pacific haze carries a ridge.
  const k = clarity.toFixed(3);
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', [
      '#ifdef USE_FOG',
      '  #ifdef FOG_EXP2',
      `    gl_FragColor.a *= exp( - fogDensity * fogDensity * vFogDepth * vFogDepth * ${k} * ${k} );`,
      '  #else',
      '    gl_FragColor.a *= 1.0 - smoothstep( fogNear, fogFar, vFogDepth );',
      '  #endif',
      '#endif',
    ].join('\n'));
  };
  return material;
}

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
 * **The aerial perspective is a dissolve, not a fog blend.** `FogExp2` keeps
 * `exp(-(density * depth)^2)` of a surface, not `exp(-density * depth)`, and
 * that is the right transmittance -- but `scene.fog.color` is an LDR display
 * colour and the sky it stands for is HDR. Measured at noon, looking out over
 * the town: the rendered sky is 3.10 in linear radiance where the fog colour
 * `#bcd2e6` is 0.644, so the haze is **4.8x too dim to be the sky**. Blending
 * a black ridge 49% of the way into something five times darker than what is
 * behind it does not dissolve it; it leaves a cut-out. A/B at 686 m, noon:
 * fog off the ridge is RGB 0,0,0, fog on it is 29,37,44, and the sky over it
 * is 174,207,220. Nobody saw this while the noon density was 0.0060, because
 * at that density 686 m keeps nothing at all and the whole horizon was
 * invisible; thinning the fog to 0.0012 for a clear day is what uncovered it.
 *
 * So the fog's *transmittance* is kept and its *colour* is thrown away: the
 * fragment writes `exp(-(density*depth)^2)` into alpha and lets the sky
 * already in the buffer supply the haze, at whatever radiance the sky
 * actually has. That is also what extinction plus in-scattering comes to when
 * the in-scattered light is the background -- which at horizon level under a
 * uniform sky it is. It needs no per-hour hook: `fogDensity` is a uniform
 * three keeps in step with `scene.fog`, so night's 0.024 dissolves the ridge
 * to nothing on its own, and it is per fragment, so standing at the town's
 * edge the near arc is correctly denser than the far one.
 *
 * **Only the ridge gets it, and that is not a compromise.** Alpha compositing
 * attenuates once per *surface* where air attenuates once per *metre*, so it
 * is only honest where a ray crosses the thing once. The ridge is a closed
 * strip: one layer, always. A tree ring is 440 loose triangles about 1.5 deg
 * wide spaced 0.6 deg apart, so two or three of them stack on any bearing --
 * dissolved at 64% each they come to 92% together, and what that looks like
 * is not a hazier treeline but a heap of glass cones, each one visible
 * through the next, with their pale tips speckled across the ridge behind.
 * Photographed and rejected. The combs keep the stock fog blend, and the
 * near-black comb they come out as is what the reference has anyway; it is
 * the ridge behind them that has to dissolve.
 *
 * The three radii are three planes of depth. From the loaded world's centre
 * that is 556, 601 and 686 m. They cannot come closer: they have to clear
 * everything built, and the town's own radius is 213 m at Midgaard alone.
 * The treeline is for the streets that can see out; in the middle of town
 * the buildings are the horizon.
 */
/**
 * Which skyline an area stands under. Keyed on the area file, as the other
 * area tests in this file are; anything not named is a town, which is what the
 * rest of the default world -- Midgaard, the graveyard, the district -- is.
 */
const HORIZON_STYLE = {
  'haon.are': 'forest', 'trollden.are': 'forest', 'shire.are': 'hills',
  'eastern.are': 'desert', 'marsh.are': 'marsh',
};
const HORIZON_STYLES = ['town', 'forest', 'hills', 'desert', 'marsh'];
/** Metres around the camera over which the areas' rooms vote on the skyline. */
const HORIZON_REACH = 90;

/**
 * The horizon, per area.
 *
 * There used to be one skyline for the whole world -- the conifer combs and
 * the ridge below -- and from the Great Eastern Desert it read as fir forest
 * standing in front of a blue sea: the ridge's dark rock dissolved into a noon
 * sky is a band of mid blue, flat enough to be water. So each area has its own
 * skyline on the same rings -- mesas and dune haze past the desert, green
 * hills past the Shire, rooftops past the town, reeds and mist past the marsh,
 * fir ridges past Haon Dor -- and the rooms around the camera vote on which is
 * up. A skyline that is not wanted sinks into the ground rather than fading:
 * fading the combs means blending them, and loose blended triangles stack
 * into glass (see below), while a skyline squashed to half height is still an
 * opaque skyline. Crossing a seam, one range goes down as the other comes up.
 */
function buildHorizon(group, bounds, groundY, layout) {
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

  // Each style's meshes share one `rise`, 0..1, applied in the vertex shader
  // about the ground: see the note on the function.
  const rises = new Map(HORIZON_STYLES.map((name) => [name, { value: name === 'town' ? 1 : 0 }]));
  const meshes = new Map(HORIZON_STYLES.map((name) => [name, []]));
  const risen = (material, style) => {
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (previous) previous(shader, renderer);
      shader.uniforms.horizonRise = rises.get(style);
      shader.uniforms.horizonGround = { value: groundY };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float horizonRise;\nuniform float horizonGround;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n\ttransformed.y = horizonGround + ( transformed.y - horizonGround ) * horizonRise;');
    };
    material.customProgramCacheKey = () => `horizon-rise-${material.transparent}-${material.userData.clarity ?? 1}`;
    return material;
  };

  // Unlit, and dark. A lit material was tried first -- up-normals handing the
  // silhouettes the same sun and sky the field gets -- and at noon that made
  // the treeline *lighter* than the sky behind it: a row of pale ghosts,
  // exactly backwards from the reference. A conifer wall reflects almost
  // nothing and reads near-black against any daylit sky, so flat unlit colour
  // is the honest model: how much of it survives to the eye is the haze's job,
  // and exposure keeps it in step with the hour.
  // Vertex colours carry the variation: seen with a clear sky from the town's
  // edge -- the park, the levee -- a single flat tone read as one continuous
  // grey dam, and repetition the eye forgives in a texture it does not
  // forgive in a skyline. One factor per tree and a slow wave along the
  // ridge break it for free; the material stays unlit.
  const conifer = () => new THREE.MeshBasicMaterial({
    color: 0x141a14, side: THREE.DoubleSide, vertexColors: true,
  });
  // A far slope that is *lit*: sand, grass, stone in daylight. Unlike the
  // near-black combs these have an albedo, so the hour has to set how much
  // light is on them (`setHour`) or noon's colour would come out four times
  // as bright at night's exposure.
  const lit = [];
  const litSlope = (albedo, clarity = 1) => {
    const material = haze(new THREE.MeshBasicMaterial({
      color: albedo, side: THREE.DoubleSide, vertexColors: true,
    }), clarity);
    material.userData.clarity = clarity;
    lit.push({ material, albedo: new THREE.Color(albedo) });
    return material;
  };

  const silhouette = (points, colors, material, name, order, style) => {
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
    const mesh = new THREE.Mesh(geo, risen(material, style));
    mesh.name = name;
    // The sun's shadow camera is 260 m of span following the player. Nothing
    // out here may enter that pass, casting or receiving.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // A 360-degree ring is always partly in view, so the test only ever
    // answers yes.
    mesh.frustumCulled = false;
    // The ridge blends, so it goes before everything else that does -- nothing
    // in the world is further away than it is. The combs are opaque and the
    // depth buffer already has them right.
    mesh.renderOrder = order;
    mesh.visible = rises.get(style).value > 0.002;
    group.add(mesh);
    meshes.get(style).push(mesh);
  };

  /**
   * A closed strip from the ground up to `crest(a)`, one layer, which is the
   * only shape the haze dissolve is honest on. `tone(a, top)` shades it.
   */
  const strip = (radius, segments, crest, tone, material, name, order, style, rows = 1) => {
    const points = [];
    const colors = [];
    // `tone(a, top)` sees a boolean for a single row and the height fraction
    // for more, which is what lets a cliff carry strata.
    const push = (a, v) => {
      const h = crest(a) * v;
      points.push(cx + Math.cos(a) * radius, groundY + h, cz + Math.sin(a) * radius);
      const t = tone(a, rows === 1 ? v > 0.5 : v, h);
      colors.push(t[0], t[1], t[2]);
    };
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2; const a1 = ((i + 1) / segments) * Math.PI * 2;
      for (let j = 0; j < rows; j++) {
        const v0 = j / rows; const v1 = (j + 1) / rows;
        push(a0, v0); push(a1, v0); push(a1, v1);
        push(a0, v0); push(a1, v1); push(a0, v1);
      }
    }
    silhouette(points, colors, material, name, order, style);
  };
  // Whole cycles per turn, because a ring has to close. A frequency that is
  // not an integer leaves f(2pi) != f(0), which is a vertical cliff in the
  // skyline at one bearing -- the seam is worse than the repetition it was
  // meant to avoid. Coprime frequencies, so nothing repeats inside a turn.
  const waves = (list, base) => {
    const w = list.map(([f, amp]) => ({ f, amp, phase: rng() * Math.PI * 2 }));
    return (a) => w.reduce((sum, v) => sum + v.amp * Math.sin(v.f * a + v.phase), base);
  };
  // Tone drifts along a ring the same way a crest does, and the crest sits a
  // shade lighter than the foot, which is what haze does to a far slope.
  // Without this a ridge was one continuous grey band and read as a dam.
  const drift = (top, foot) => {
    const tw = waves([[2, 0.06], [5, 0.05], [13, 0.03]], 1);
    return (a, isTop) => { const t = tw(a) * (isTop ? top : foot); return [t, t, t * 1.04]; };
  };

  // --------------------------------------------------------------- forest --
  // The three radii are three planes of depth. They cannot come closer: they
  // have to clear everything built, and the town's own radius is 213 m at
  // Midgaard alone.
  const rings = [
    { r: town + 120, low: 14, high: 30 },
    { r: town + 165, low: 18, high: 38 },
  ];
  const ridgeR = town + 250;
  const combs = (style, colourOf) => rings.forEach((ring, index) => {
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
      const [r, g, b] = colourOf(rnd(0.68, 1.3), rnd(0.9, 1.1));
      const blade = (from, to, apex, top) => {
        // Wound so the side facing the town is the front face: three flips a
        // back face's normal, and these normals are all up, so the back of one
        // of these would be lit from underneath.
        points.push(px + tx * from, groundY, pz + tz * from);
        points.push(px + tx * to, groundY, pz + tz * to);
        points.push(px + tx * apex, groundY + top, pz + tz * apex);
        for (let k = 0; k < 3; k++) colors.push(r, g, b);
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
    silhouette(points, colors, conifer(), `horizon-${style}-trees-${index}`, 0, style);
  });
  combs('forest', (tone, hue) => [tone * hue, tone, tone * (2 - hue)]);

  // **The aerial perspective is a dissolve, not a fog blend** -- see `haze`.
  // Only the strips get it, and that is not a compromise: alpha compositing
  // attenuates once per *surface* where air attenuates once per *metre*, so
  // it is only honest where a ray crosses the thing once. A tree ring is 440
  // loose triangles about 1.5 deg wide spaced 0.6 deg apart, so two or three
  // of them stack on any bearing -- dissolved at 64% each they come to 92%
  // together, and what that looks like is not a hazier treeline but a heap of
  // glass cones, each one visible through the next. Photographed and
  // rejected. The combs keep the stock fog blend.
  // The ridge behind is forested mountain in daylight, not a dark cut-out: in
  // near-black rock, dissolved into a noon sky, it came out a flat band of mid
  // blue and was reported as the sea.
  strip(ridgeR, 360, waves([[3, 16], [7, 9], [11, 4], [23, 2]], 62), drift(1.14, 0.92), litSlope(0x2e3f33),
    'horizon-forest-ridge', -3, 'forest');

  // ---------------------------------------------------------------- hills --
  const COPSE = 0x34482a;
  // The Shire: rolling farmland going blue with distance, a hedge-and-copse
  // comb in front, round-headed trees rather than spires.
  {
    const points = [];
    const colors = [];
    const ring = rings[0];
    const span = 2 * Math.PI * ring.r;
    for (let arc = 0; arc < span; arc += rnd(5, 16)) {
      const a = arc / ring.r;
      const radius = ring.r + rnd(-15, 15);
      const px = cx + Math.cos(a) * radius; const pz = cz + Math.sin(a) * radius;
      const tx = -Math.sin(a); const tz = Math.cos(a);
      // A copse is a few crowns side by side; a hedge line is low and long.
      const crowns = rng() < 0.35 ? 1 : 2 + Math.floor(rng() * 3);
      const tone = rnd(0.75, 1.25);
      for (let c = 0; c < crowns; c++) {
        const r = rnd(5, 11);
        const h = r * rnd(1.3, 2.1);
        const off = (c - (crowns - 1) / 2) * r * 1.3 + rnd(-1.5, 1.5);
        const SEG = 7;
        for (let k = 0; k < SEG; k++) {
          const t0 = (k / SEG) * Math.PI; const t1 = ((k + 1) / SEG) * Math.PI;
          const at = (t) => [off + Math.cos(t) * r, h - r + Math.sin(t) * r];
          const [x0, y0] = at(t0); const [x1, y1] = at(t1);
          points.push(px + tx * (off + r), groundY, pz + tz * (off + r));
          points.push(px + tx * (off - r), groundY, pz + tz * (off - r));
          points.push(px + tx * x0, groundY + y0, pz + tz * x0);
          points.push(px + tx * (off - r), groundY, pz + tz * (off - r));
          points.push(px + tx * x1, groundY + y1, pz + tz * x1);
          points.push(px + tx * x0, groundY + y0, pz + tz * x0);
          for (let q = 0; q < 6; q++) colors.push(tone * 0.95, tone, tone * 0.9);
        }
      }
    }
    // Broadleaf crowns in farmland, in daylight: an albedo lit by the hour
    // like the slopes behind them, not a near-black left for the fog to lift.
    // The Shire's noon fog is thin, so 0x18221a stayed what it was -- a black
    // cardboard strip, RGB 4,7,8, across a sunlit field. Kept out of `haze`
    // for the reason the combs are: a copse is overlapping loose crowns.
    const copse = new THREE.MeshBasicMaterial({ color: COPSE, side: THREE.DoubleSide, vertexColors: true });
    lit.push({ material: copse, albedo: new THREE.Color(COPSE) });
    silhouette(points, colors, copse, 'horizon-hills-copses', 0, 'hills');
    // Two ranges of hills, the nearer greener, the further gone to haze.
    strip(rings[1].r + 20, 256, waves([[4, 7], [7, 5], [13, 2.5]], 22), drift(1.1, 0.95),
      litSlope(0x3f5634), 'horizon-hills-near', -2, 'hills');
    strip(ridgeR, 256, waves([[3, 12], [5, 8], [11, 3]], 44), drift(1.12, 0.94),
      litSlope(0x4d5a52), 'horizon-hills-far', -3, 'hills');
  }

  // --------------------------------------------------------------- desert --
  // Mesas and buttes: flat tops, cliffs, talus -- the silhouette nothing else
  // has -- and a low swell of dunes in front, all in sand and red rock that the
  // noon haze turns pale.
  {
    const SEG = 720;
    const tops = [];
    for (let a = 0; a < Math.PI * 2;) {
      const width = rnd(0.05, 0.22);
      const gap = rnd(0.02, 0.14);
      // Some buttes stand in two tiers: a caprock over a wider bench.
      tops.push({ a0: a, a1: a + width, h: rnd(28, 78), shoulder: rnd(0.004, 0.012), tier: rng() < 0.4 ? rnd(0.55, 0.8) : 1 });
      a += width + gap;
    }
    // The last one must not run over the seam at 2 pi.
    tops[tops.length - 1].a1 = Math.min(tops[tops.length - 1].a1, Math.PI * 2 - 0.01);
    const base = waves([[5, 3], [9, 2]], 9);
    const mesa = (a) => {
      let h = base(a);
      for (const m of tops) {
        const inside = Math.min(a - m.a0, m.a1 - a);
        if (inside <= -m.shoulder * 3) continue;
        // A cliff above a talus slope: steep for the upper two thirds.
        const t = THREE.MathUtils.clamp((inside + m.shoulder * 3) / (m.shoulder * 4), 0, 1);
        let top = m.h * (t < 0.35 ? t / 0.35 * 0.35 : 0.35 + 0.65 * THREE.MathUtils.smoothstep(t, 0.35, 0.6));
        // The caprock sits back from the bench's edge.
        if (m.tier < 1) {
          const back = (m.a1 - m.a0) * 0.22;
          top = Math.min(top, inside > back ? m.h : m.h * m.tier);
        }
        // Weathered, not ruled: a few metres of broken edge along the top.
        top *= 1 + 0.025 * Math.sin(a * 310) * Math.sin(a * 83 + 1.3);
        h = Math.max(h, top);
      }
      return h;
    };
    // Strata by height, a darker talus at the foot, and each butte turned a
    // little more or less to the sun -- one flat tone read as cardboard.
    const faceOf = (a) => {
      for (let i = 0; i < tops.length; i++) if (a >= tops[i].a0 - 0.04 && a <= tops[i].a1 + 0.04) return 0.78 + 0.34 * hash3(i, 0, 0, 7117);
      return 0.9;
    };
    const strata = (a, v, h) => {
      const band = 0.9 + 0.1 * Math.sin(h * 0.9 + Math.sin(a * 40) * 0.6) + 0.06 * Math.sin(h * 2.7);
      const talus = THREE.MathUtils.smoothstep(v, 0.0, 0.3);
      const k = faceOf(a) * band * (0.72 + 0.28 * talus);
      return [k * 1.02, k, k * 0.97];
    };
    strip(ridgeR, SEG, mesa, strata, litSlope(0xd8a482, 0.55), 'horizon-desert-mesas', -3, 'desert', 8);
    strip(rings[1].r, 256, waves([[11, 3], [17, 2], [29, 1.2]], 8), (a, top) => (top ? [1.05, 1.02, 0.96] : [0.86, 0.8, 0.74]),
      litSlope(0xd2b48a, 0.55), 'horizon-desert-dunes', -2, 'desert');
  }

  // ----------------------------------------------------------------- town --
  // Past the town, more town: gables, chimneys, a tower now and then and the
  // line of a wall -- one strip whose crest traces the roofs, so the haze can
  // dissolve it like a ridge.
  {
    const r = rings[0].r;
    const pts = [];
    for (let arc = 0; arc < 2 * Math.PI * r - 30;) {
      const a = arc / r;
      const kind = rng();
      if (kind < 0.12) {
        // A tower with a spire.
        const w = rnd(8, 11); const h = rnd(32, 44); const spire = rnd(10, 18);
        pts.push([arc, 10], [arc, h], [arc + w / 2, h + spire], [arc + w, h], [arc + w, 10]);
        arc += w + rnd(2, 6);
      } else if (kind < 0.22) {
        // A stretch of wall with crenels.
        const len = rnd(20, 45);
        for (let x = 0; x < len; x += 3) pts.push([arc + x, 12], [arc + x, 13.6], [arc + x + 1.5, 13.6], [arc + x + 1.5, 12]);
        arc += len;
      } else {
        // A house: eaves, a gable, sometimes a chimney.
        const w = rnd(10, 22); const eave = rnd(12, 19); const ridge = eave + w * rnd(0.3, 0.45);
        pts.push([arc, eave], [arc + w / 2, ridge], [arc + w, eave]);
        if (rng() < 0.4) {
          const c = arc + w * rnd(0.6, 0.8);
          const at = eave + (ridge - eave) * (1 - Math.abs(c - (arc + w / 2)) / (w / 2));
          pts.splice(pts.length - 1, 0, [c, at], [c, at + 3.5], [c + 1.6, at + 3.5], [c + 1.6, at - 1.6 * (ridge - eave) / (w / 2)]);
        }
        arc += w + rnd(0, 3);
      }
    }
    pts.push([2 * Math.PI * r, pts[0][1]]);
    const crest = (a) => {
      const arc = a * r;
      let lo = 0; let hi = pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= arc) lo = mid; else hi = mid; }
      const [x0, y0] = pts[lo]; const [x1, y1] = pts[hi];
      return x1 > x0 ? y0 + (y1 - y0) * (arc - x0) / (x1 - x0) : y1;
    };
    // Sampled finely enough to keep the corners: 1.5 m of arc a segment.
    strip(r, Math.round(2 * Math.PI * r / 1.5), crest, (a, top) => (top ? [1.0, 1.0, 1.05] : [0.85, 0.85, 0.9]),
      haze(new THREE.MeshBasicMaterial({ color: 0x1a1d24, side: THREE.DoubleSide, vertexColors: true })),
      'horizon-town-roofs', -2, 'town');
    // Farmland and wooded hills beyond the walls, going blue with distance.
    strip(ridgeR, 360, waves([[3, 14], [7, 8], [11, 4], [19, 2]], 48), drift(1.12, 0.94), litSlope(0x4a5a4c),
      'horizon-town-ridge', -3, 'town');
  }

  // ---------------------------------------------------------------- marsh --
  // Flat: a reed bed's ragged top a few metres high, a low bank of willow
  // beyond it, and nothing else -- the haze does the rest.
  {
    const reed = (a) => {
      const k = a * 2400;
      const saw = Math.abs(((k % 2) + 2) % 2 - 1);
      return 3.2 + 1.8 * saw * (0.6 + 0.4 * Math.sin(a * 37)) + 1.2 * Math.sin(a * 13);
    };
    strip(rings[0].r, 4800, reed, (a, top) => (top ? [1.0, 1.02, 0.94] : [0.8, 0.84, 0.78]),
      litSlope(0x4f5a3e), 'horizon-marsh-reeds', -2, 'marsh');
    strip(ridgeR, 256, waves([[9, 3], [16, 2], [27, 1.4]], 12), drift(1.08, 0.96),
      litSlope(0x55605a), 'horizon-marsh-willows', -3, 'marsh');
  }

  // Which style each room votes for, and where it stands.
  const voters = [];
  for (const cell of layout.order) {
    if (!cell.room) continue;
    const style = HORIZON_STYLE[cell.room.areaFile] || 'town';
    voters.push({ x: cell.x * CELL, y: cell.level * LEVEL_H, z: cell.z * CELL, style });
  }
  const weights = new Map(HORIZON_STYLES.map((n) => [n, 0]));

  return {
    /**
     * The hour's light on the far slopes that have an albedo. `level` is
     * already divided by the exposure, so the slopes keep their noon value
     * on screen at noon and fall with the light, not with the camera.
     */
    setHour(tintHex, level) {
      const tint = new THREE.Color(tintHex);
      for (const { material, albedo } of lit) material.color.copy(albedo).multiply(tint).multiplyScalar(level);
    },
    /** Vote, then ease each skyline towards its share. */
    update(position, dt) {
      for (const n of HORIZON_STYLES) weights.set(n, 0);
      let total = 0;
      for (const v of voters) {
        // Only rooms on the camera's own level: the sewer runs under the
        // Shire, and its rooms are the town's.
        if (Math.abs(v.y - position.y) > LEVEL_H * 0.75) continue;
        const d = Math.hypot(v.x - position.x, v.z - position.z);
        if (d >= HORIZON_REACH) continue;
        const w = (1 - d / HORIZON_REACH) ** 2;
        weights.set(v.style, weights.get(v.style) + w);
        total += w;
      }
      if (total <= 0) return; // off in the fields: keep what was up
      const k = 1 - Math.exp(-dt / 0.8);
      for (const n of HORIZON_STYLES) {
        const rise = rises.get(n);
        const target = THREE.MathUtils.smoothstep(weights.get(n) / total, 0.05, 0.6);
        rise.value += (target - rise.value) * k;
        if (Math.abs(target - rise.value) < 0.002) rise.value = target;
        for (const mesh of meshes.get(n)) mesh.visible = rise.value > 0.002;
      }
    },
    /** Jump straight to the vote, for a camera that has teleported. */
    settle(position) { for (let i = 0; i < 40; i++) this.update(position, 1); },
    rises,
  };
}
