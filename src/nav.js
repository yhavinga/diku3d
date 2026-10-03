/**
 * Where a person can stand, and how to get from here to there.
 *
 * The player is kept out of walls by the builder's collider boxes and held up
 * by its platform list (player.js). A mobile needs the same answer ahead of
 * time -- it has to choose somewhere to walk *to* -- so this rasterises that
 * same data onto a half-metre grid, one 13 m layout cell at a time and only
 * when something first asks about that cell.
 *
 * No three.js here, and nothing from build.js (which pulls it in): game.js
 * plans a mobile's journey with this, and game.js has to run under bare node
 * for tools/game-check.mjs. Headless there is no geometry at all, and then
 * every sample inside the cells a route is allowed to use is walkable -- the
 * route still follows the streets, it just cannot see the furniture.
 */

import { DIR_STEP, REVERSE_DIR } from './are.js';

// build.js's own numbers, repeated for the reason above.
const CELL = 13;
const HALF = CELL / 2;
const LEVEL_H = 7.6;
const ROOM = 10;
const DOOR_W = 3.2;
const STAIR_START = ROOM / 2 - 0.5;
const STAIR_END = STAIR_START - 7.4;
const STAIR_STEPS = 20;
const STAIR_RISER = LEVEL_H / STAIR_STEPS;
const STAIR_TREAD = 7.4 / STAIR_STEPS;

export const NAV_RES = 0.5;
const PER = CELL / NAV_RES;          // 26 samples across a cell
/** A person, for clearance. Inflating every box by this keeps a centre line honest. */
const RADIUS = 0.32;
/** The band a body occupies above its own floor: shins to crown. */
const BAND_LO = 0.32;
const BAND_HI = 1.7;
/** A floor this close to the room's own level is the room's floor. */
const FLOOR_TOL = 0.3;

const BLOCKED = 0;
const OPEN = 1;
const WET = 2;

const GRID = 8;
class Buckets {
  constructor() { this.cells = new Map(); }
  add(item) {
    const x0 = Math.floor(item.x0 / GRID); const x1 = Math.floor(item.x1 / GRID);
    const z0 = Math.floor(item.z0 / GRID); const z1 = Math.floor(item.z1 / GRID);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = `${x},${z}`;
        let bucket = this.cells.get(key);
        if (!bucket) { bucket = []; this.cells.set(key, bucket); }
        bucket.push(item);
      }
    }
  }
  /** Everything whose box could touch the 13 m cell around (x, z). */
  around(x, z, out) {
    out.length = 0;
    const seen = new Set();
    const x0 = Math.floor((x - HALF - 1) / GRID); const x1 = Math.floor((x + HALF + 1) / GRID);
    const z0 = Math.floor((z - HALF - 1) / GRID); const z1 = Math.floor((z + HALF + 1) / GRID);
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        const bucket = this.cells.get(`${bx},${bz}`);
        if (!bucket) continue;
        for (const item of bucket) if (!seen.has(item)) { seen.add(item); out.push(item); }
      }
    }
    return out;
  }
}

/**
 * Which modelled props a person walks round rather than through. Things with
 * a collider of their own (houses, the room kits, lamps, trees, cabins) are
 * left to it: an instance's box is axis-aligned and a whole tree crown or a
 * rotated house would claim far more street than it stands on. Grass, ferns
 * and nettles are walked through, which is what they are for.
 */
const WALK_ROUND = new Set([
  'barrel', 'crate', 'sack', 'hay_bale', 'handcart', 'bench', 'trough',
  'stacked_crates', 'barrel_stack', 'firewood_pile', 'water_butt', 'bucket',
  'rope_coil', 'ladder', 'planks_pile', 'herb_pots', 'broom', 'cartwheel',
  'market_stall', 'well', 'fountain', 'signpost', 'bush', 'salal_bush', 'moss_rock',
  'dead_log', 'headstone', 'grave_slab', 'iron_fence', 'shire_fence', 'shire_flowerbed',
]);

const cellKey = (level, cx, cz) => `${level}:${cx},${cz}`;

/**
 * @param {object} deps
 *   layout, built, world -- the boot chain's own objects. `built.platforms`
 *   and `built.colliders` are read if present; a stub without them (the
 *   headless harness) gets a world with nothing in the way.
 */
export function createNav({ layout, built, world }) {
  const geometric = Array.isArray(built.platforms) && Array.isArray(built.colliders);
  const platforms = new Buckets();
  // Ground built up above its level -- a temple's mound and its steps
  // (build.js `mounds`): a platform with a `base` is the floor of that level,
  // at its own height.
  const mounds = new Buckets();
  const solids = new Buckets();
  const waters = [];
  if (geometric) {
    for (const p of built.platforms) {
      platforms.add(p);
      if (p.base !== undefined) mounds.add(p);
    }
    // Doors swing, so their boxes are the route's business and not the grid's.
    for (const c of built.colliders) if (!c.door) solids.add(c);
    for (const d of built.decor || []) {
      if (d.kind !== 'water') continue;
      const h = d.size / 2;
      waters.push({ x0: d.x - h, x1: d.x + h, z0: d.z - h, z1: d.z + h, y: d.y });
    }
  }
  const grids = new Map();
  const _near = [];
  const _mound = [];

  /**
   * The strip under an indoor room's doorway. Such a room's floor stops at the
   * inside face of its wall (ROOM/2 = 5 m) and the passage beyond starts at the
   * cell edge (6.5 m); in between there is only the wall, with a hole in it.
   * The player steps across on whatever happens to be under it -- at street
   * level the world's ground plane half a metre down. A plan needs to know the
   * way through is there.
   */
  function doorways(level, cx, cz) {
    const vnum = layout.at(level, cx, cz);
    if (vnum === undefined) return null;
    const sides = layout.sides.get(vnum);
    if (!sides) return null;
    const out = [];
    for (let dir = 0; dir < 4; dir++) {
      const side = sides[dir];
      if (!side || side.kind !== 'alley') continue;
      const [dx, , dz] = DIR_STEP[dir];
      const x = cx * CELL; const z = cz * CELL;
      const lat = DOOR_W / 2 - RADIUS;
      const a = ROOM / 2 - 0.4; const b = HALF + 0.4;
      if (dx) out.push({ x0: x + Math.min(dx * a, dx * b), x1: x + Math.max(dx * a, dx * b), z0: z - lat, z1: z + lat });
      else out.push({ x0: x - lat, x1: x + lat, z0: z + Math.min(dz * a, dz * b), z1: z + Math.max(dz * a, dz * b) });
    }
    return out;
  }

  function buildCell(level, cx, cz) {
    const grid = new Uint8Array(PER * PER);
    if (!geometric) { grid.fill(OPEN); return grid; }
    const y = level * LEVEL_H;
    const ox = cx * CELL - HALF;
    const oz = cz * CELL - HALF;
    const floors = platforms.around(cx * CELL, cz * CELL, []);
    const up = mounds.around(cx * CELL, cz * CELL, []).reduce((m, p) => Math.max(m, p.top - p.base), 0);
    const boxes = solids.around(cx * CELL, cz * CELL, _near).filter((c) => c.y1 > y + BAND_LO && c.y0 < y + BAND_HI + up);
    const doors = doorways(level, cx, cz) || [];
    const wet = waters.filter((w) => Math.abs(w.y - y) < 1);
    for (let j = 0; j < PER; j++) {
      const z = oz + (j + 0.5) * NAV_RES;
      for (let i = 0; i < PER; i++) {
        const x = ox + (i + 0.5) * NAV_RES;
        let ground = false;
        let raised = false;
        let g = y;
        for (const p of floors) {
          if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) continue;
          if (p.base !== undefined) {
            if (Math.abs(p.base - y) <= FLOOR_TOL) { ground = true; g = Math.max(g, p.top); }
          } else if (Math.abs(p.top - y) <= FLOOR_TOL) ground = true;
          else if (p.top > y + FLOOR_TOL && p.top < y + BAND_HI) raised = true;
        }
        // On a mound the ground is the mound, and what is in the way is
        // what stands on it -- not the mound's own sides.
        if (g > y + FLOOR_TOL) raised = false;
        if (!ground) {
          for (const d of doors) if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) { ground = true; break; }
        }
        let value = ground && !raised ? OPEN : BLOCKED;
        if (value) {
          for (const c of boxes) {
            if (x <= c.x0 - RADIUS || x >= c.x1 + RADIUS || z <= c.z0 - RADIUS || z >= c.z1 + RADIUS) continue;
            if (c.y1 <= g + BAND_LO || c.y0 >= g + BAND_HI) continue;
            if (c.obb) {
              // A prop turned on the spot: test its own footprint, not the
              // axis-aligned box round it.
              const dx = x - c.obb.x; const dz = z - c.obb.z;
              const u = dx * c.obb.ux + dz * c.obb.uz;
              const v = -dx * c.obb.uz + dz * c.obb.ux;
              if (Math.abs(u) >= c.obb.hx + RADIUS || Math.abs(v) >= c.obb.hz + RADIUS) continue;
            }
            value = BLOCKED;
            break;
          }
        }
        if (value) {
          for (const w of wet) if (x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1) { value = WET; break; }
        }
        grid[j * PER + i] = value;
      }
    }
    return grid;
  }

  function gridFor(level, cx, cz) {
    const key = cellKey(level, cx, cz);
    let grid = grids.get(key);
    if (!grid) { grid = buildCell(level, cx, cz); grids.set(key, grid); }
    return grid;
  }

  /** The sample index holding world (x, z). Cell cx spans ix in [26cx - 13, 26cx + 12]. */
  const ixOf = (x) => Math.floor(x / NAV_RES);
  const centreOf = (i) => (i + 0.5) * NAV_RES;
  const cellOfIndex = (i) => Math.floor((i + PER / 2) / PER);

  function sampleAt(level, ix, iz) {
    const cx = cellOfIndex(ix);
    const cz = cellOfIndex(iz);
    const grid = gridFor(level, cx, cz);
    return grid[(iz - (cz * PER - PER / 2)) * PER + (ix - (cx * PER - PER / 2))];
  }

  /** 0 blocked, 1 open ground, 2 open but under water. */
  function sample(x, z, level) {
    return sampleAt(level, ixOf(x), ixOf(z));
  }

  const levelOf = (y) => Math.round(y / LEVEL_H);

  /** How high the ground stands at (x, z) on `level`, where a mound raises it; else null. */
  function moundY(x, z, level) {
    const base = level * LEVEL_H;
    let top = null;
    for (const p of mounds.around(x, z, _mound)) {
      if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1 || Math.abs(p.base - base) > FLOOR_TOL) continue;
      if (top === null || p.top > top) top = p.top;
    }
    return top;
  }

  /**
   * Which room a point belongs to -- main.js's `currentRoom`, for feet rather
   * than for eyes. A room's own cell is unambiguous; a street belongs to the
   * nearer end of it.
   */
  function roomAt(x, y, z) {
    const level = levelOf(y);
    const cx = Math.round(x / CELL);
    const cz = Math.round(z / CELL);
    const here = layout.at(level, cx, cz);
    if (here !== undefined) return here;
    const passage = layout.passageAt(level, cx, cz);
    if (passage) {
      const a = passage.from; const b = passage.to;
      const da = (a.x * CELL - x) ** 2 + (a.z * CELL - z) ** 2;
      const db = (b.x * CELL - x) ** 2 + (b.z * CELL - z) ** 2;
      return da <= db ? a.vnum : b.vnum;
    }
    let vnum;
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const candidate = layout.at(level, cx + dx, cz + dz);
        if (candidate === undefined) continue;
        const d = ((cx + dx) * CELL - x) ** 2 + ((cz + dz) * CELL - z) ** 2;
        if (d < best) { best = d; vnum = candidate; }
      }
    }
    return vnum;
  }

  // -- the ground a room owns --------------------------------------------------

  /**
   * The room's own cell, plus the near half of the first street cell of every
   * passage out of it. Standing in the far half would put you in the next
   * room by `roomAt`'s rule, and a stroll must not move anyone's room.
   */
  function territory(vnum) {
    const cell = layout.cells.get(vnum);
    if (!cell) return null;
    const sides = layout.sides.get(vnum) || [];
    const cells = [{ level: cell.level, x: cell.x, z: cell.z, own: true }];
    for (let dir = 0; dir < 4; dir++) {
      const side = sides[dir];
      if (!side || side.kind !== 'alley' || !side.link.path || !side.link.path.length) continue;
      const path = side.link.from.vnum === vnum ? side.link.path : [...side.link.path].reverse();
      const first = path[0];
      const other = side.link.from.vnum === vnum ? side.link.to : side.link.from;
      // Only a street cell this passage owns: two passages may share a cell,
      // and `roomAt` would put someone standing in it in a third room.
      if (layout.passageAt(cell.level, first.x, first.z) !== side.link) continue;
      cells.push({ level: cell.level, x: first.x, z: first.z, own: false, other });
    }
    return { cell, cells };
  }

  function portalsOf(vnum) {
    return (built.portals || []).filter((p) => p.from === vnum);
  }

  /**
   * Somewhere worth walking to in this room: open ground, clear of the exact
   * centre (where the player arrives), clear of an archway's trigger, and dry
   * unless nothing else is. `rand` is the caller's generator, so a seeded game
   * picks the same spots twice.
   */
  function randomSpot(vnum, rand, { allowWater = false, near = null, radius = Infinity, avoid = null } = {}) {
    const t = territory(vnum);
    if (!t) return null;
    const { cell } = t;
    const cxw = cell.x * CELL; const czw = cell.z * CELL;
    const arches = portalsOf(vnum);
    const ok = (x, z) => {
      const s = sample(x, z, cell.level);
      if (!s || (s === WET && !allowWater)) return false;
      if ((x - cxw) ** 2 + (z - czw) ** 2 < 1.8 * 1.8) return false;
      for (const p of arches) if ((x - p.x) ** 2 + (z - p.z) ** 2 < (p.radius + 1.2) ** 2) return false;
      if (near && (x - near.x) ** 2 + (z - near.z) ** 2 > radius * radius) return false;
      if (avoid && avoid(x, z)) return false;
      // Two neighbours open as well, so a spot is not a single sample wedged
      // between a barrel and a wall.
      return sample(x + NAV_RES, z, cell.level) && sample(x - NAV_RES, z, cell.level)
        && sample(x, z + NAV_RES, cell.level) && sample(x, z - NAV_RES, cell.level);
    };
    for (let attempt = 0; attempt < 24; attempt++) {
      const pick = t.cells[attempt < 16 || t.cells.length === 1 ? 0 : 1 + Math.floor(rand() * (t.cells.length - 1))];
      let x = pick.x * CELL + (rand() - 0.5) * (CELL - 1);
      let z = pick.z * CELL + (rand() - 0.5) * (CELL - 1);
      if (!pick.own) {
        // The near half only: pull the sample towards this room's side.
        const ox = pick.other.x * CELL; const oz = pick.other.z * CELL;
        if ((x - ox) ** 2 + (z - oz) ** 2 < (x - cxw) ** 2 + (z - czw) ** 2 + 4) continue;
      }
      x = centreOf(ixOf(x)); z = centreOf(ixOf(z));
      if (ok(x, z)) return { x, y: moundY(x, z, cell.level) ?? cell.level * LEVEL_H, z };
    }
    if (!allowWater) return randomSpot(vnum, rand, { allowWater: true, near, radius, avoid });
    return null;
  }

  // -- paths -------------------------------------------------------------------

  /** Walkable along a straight line, sampled at a third of the grid. */
  function clearLine(level, ax, az, bx, bz, allowWet = true) {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(d / (NAV_RES / 3)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const s = sample(ax + (bx - ax) * t, az + (bz - az) * t, level);
      if (!s || (s === WET && !allowWet)) return false;
    }
    return true;
  }

  /** The nearest open sample to (x, z) within `reach` metres, or null. */
  function nearestOpen(level, x, z, reach = 2, allowed = null) {
    const ix = ixOf(x); const iz = ixOf(z);
    const r = Math.ceil(reach / NAV_RES);
    let best = null;
    let bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = dx * dx + dz * dz;
        if (d >= bestD || d > r * r) continue;
        if (allowed && !allowed.has(cellKey(level, cellOfIndex(ix + dx), cellOfIndex(iz + dz)))) continue;
        if (!sampleAt(level, ix + dx, iz + dz)) continue;
        bestD = d; best = [ix + dx, iz + dz];
      }
    }
    return best;
  }

  /**
   * A* over the half-metre grid, confined to `cells` (layout cells on one
   * level), then pulled taut so a person walks lines and not staircases.
   * Returns world points after the start, or null when there is no way.
   *
   * `near` > 0 accepts ending short: when the goal cannot be reached, the path
   * goes to the reachable sample closest to it, if that is within `near`
   * metres. A stair's foot sits in a pocket the rails close at a person's
   * clearance, and someone about to fade through an archway only has to get
   * to it, not into it.
   */
  function findPath(level, from, to, cells, near = 0) {
    const allowed = new Set(cells.map((c) => cellKey(level, c.x, c.z)));
    const start = nearestOpen(level, from.x, from.z, 1.5, allowed);
    const goal = nearestOpen(level, to.x, to.z, 2.5, allowed);
    if (!start || !goal) return null;
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const c of cells) {
      minX = Math.min(minX, c.x * PER - PER / 2); maxX = Math.max(maxX, c.x * PER + PER / 2 - 1);
      minZ = Math.min(minZ, c.z * PER - PER / 2); maxZ = Math.max(maxZ, c.z * PER + PER / 2 - 1);
    }
    const w = maxX - minX + 1; const h = maxZ - minZ + 1;
    const g = new Float32Array(w * h).fill(Infinity);
    const parent = new Int32Array(w * h).fill(-1);
    const closed = new Uint8Array(w * h);
    const open = new Uint8Array(w * h); // 1 open ground, 2 wet, 0 blocked or not allowed
    for (const c of cells) {
      const grid = gridFor(level, c.x, c.z);
      const bx = c.x * PER - PER / 2 - minX; const bz = c.z * PER - PER / 2 - minZ;
      for (let j = 0; j < PER; j++) for (let i = 0; i < PER; i++) open[(bz + j) * w + bx + i] = grid[j * PER + i];
    }
    const s = (start[1] - minZ) * w + (start[0] - minX);
    let e = (goal[1] - minZ) * w + (goal[0] - minX);
    const gx = goal[0] - minX; const gz = goal[1] - minZ;
    const heur = (i) => {
      const dx = Math.abs((i % w) - gx); const dz = Math.abs(Math.floor(i / w) - gz);
      return Math.max(dx, dz) + 0.41421 * Math.min(dx, dz);
    };
    // Binary heap on f.
    const heap = []; const fOf = [];
    const push = (i, f) => {
      heap.push(i); fOf.push(f);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (fOf[p] <= fOf[k]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]]; [fOf[p], fOf[k]] = [fOf[k], fOf[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const lastI = heap.pop(); const lastF = fOf.pop();
      if (heap.length) {
        heap[0] = lastI; fOf[0] = lastF;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1; const r = l + 1;
          let m = k;
          if (l < heap.length && fOf[l] < fOf[m]) m = l;
          if (r < heap.length && fOf[r] < fOf[m]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]]; [fOf[m], fOf[k]] = [fOf[k], fOf[m]];
          k = m;
        }
      }
      return top;
    };
    g[s] = 0;
    push(s, heur(s));
    const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.41421], [1, -1, 1.41421], [-1, 1, 1.41421], [-1, -1, 1.41421]];
    let found = false;
    let closest = s;
    let closestH = heur(s);
    while (heap.length) {
      const i = pop();
      if (closed[i]) continue;
      if (i === e) { found = true; break; }
      closed[i] = 1;
      if (near > 0) {
        const hh = heur(i);
        if (hh < closestH) { closestH = hh; closest = i; }
      }
      const ix = i % w; const iz = Math.floor(i / w);
      for (const [dx, dz, cost] of NB) {
        const nx = ix + dx; const nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const n = nz * w + nx;
        if (!open[n] || closed[n]) continue;
        // No cutting a corner past a blocked sample.
        if (dx && dz && (!open[iz * w + nx] || !open[nz * w + ix])) continue;
        const step = cost * (open[n] === WET ? 3 : 1);
        const tentative = g[i] + step;
        if (tentative < g[n]) { g[n] = tentative; parent[n] = i; push(n, tentative + heur(n)); }
      }
    }
    if (!found) {
      if (!(near > 0) || closestH * NAV_RES > near || closest === s) return null;
      e = closest;
      to = { x: centreOf((e % w) + minX), z: centreOf(Math.floor(e / w) + minZ) };
    }
    const raw = [];
    for (let i = e; i !== -1; i = parent[i]) {
      raw.push({ x: centreOf((i % w) + minX), z: centreOf(Math.floor(i / w) + minZ) });
    }
    raw.reverse();
    // The exact goal where it is itself open, rather than its sample centre.
    const last = raw[raw.length - 1];
    if (sample(to.x, to.z, level) && clearLine(level, last.x, last.z, to.x, to.z)) raw.push({ x: to.x, z: to.z });
    // String-pull: from each kept point, jump to the furthest one in sight.
    const out = [];
    let anchor = { x: from.x, z: from.z };
    if (!clearLine(level, anchor.x, anchor.z, raw[0].x, raw[0].z)) anchor = raw[0];
    let k = 0;
    while (k < raw.length - 1) {
      let far = k + 1;
      for (let m = raw.length - 1; m > k + 1; m--) {
        if (clearLine(level, anchor.x, anchor.z, raw[m].x, raw[m].z)) { far = m; break; }
      }
      out.push(raw[far]);
      anchor = raw[far];
      k = far;
    }
    if (!out.length) out.push(raw[raw.length - 1]);
    const y = level * LEVEL_H;
    return out.map((p) => ({ x: p.x, y: moundY(p.x, p.z, level) ?? y, z: p.z }));
  }

  /** A walk inside one room's own ground. */
  function pathInRoom(vnum, from, to, near = 0) {
    const t = territory(vnum);
    if (!t) return null;
    return findPath(t.cell.level, from, to, t.cells, near);
  }

  // -- journeys between rooms ---------------------------------------------------

  /**
   * How a mobile gets from room `from` through its exit `dir` into `to`, as the
   * layout built it:
   *
   *   { points, level, portal: null }             -- walked, door to door
   *   { points, level, portal: { arrive, level, after } }
   *                                               -- walked to an archway or a
   *                                                  stair, then through it
   *
   * `points` start after `start`. Null when the world has nothing built to walk.
   */
  function route(from, dir, to, start, rand) {
    const a = layout.cells.get(from);
    const b = layout.cells.get(to);
    const infoA = built.rooms.get(from);
    const infoB = built.rooms.get(to);
    if (!a || !b || !infoA || !infoB || infoA.unbuilt || infoB.unbuilt) return null;
    const room = world.rooms.get(from);
    const exit = room && room.exits[dir];
    const sides = layout.sides.get(from) || [];

    // An ordinary exit: a routed street or corridor between the two.
    let alley = null;
    for (let d = 0; d < 4; d++) {
      const side = sides[d];
      if (!side || side.kind !== 'alley' || !side.target || side.target.vnum !== to) continue;
      if (!alley || side.exit === exit) alley = side.link;
    }
    if (alley && alley.path) {
      const path = alley.from.vnum === from ? alley.path : [...alley.path].reverse();
      const cells = [{ x: a.x, z: a.z }, ...path.map((c) => ({ x: c.x, z: c.z })), { x: b.x, z: b.z }];
      // A few destinations, not one: a forest room can have a pocket the
      // trees close off, and a spot in it is no reason to stay home.
      for (let tries = 0; tries < 3; tries++) {
        const goal = randomSpot(to, rand) || { x: b.x * CELL + 2.4, y: b.level * LEVEL_H, z: b.z * CELL };
        const points = findPath(a.level, start, goal, cells);
        if (points) return { points, level: a.level, portal: null, to };
      }
      return null;
    }

    // An archway: walk into it and come out of the matching one, if there is
    // one. A portal link gets its arch only in the room it was placed from;
    // from the other end the player's compass step simply cuts, so a mobile
    // walks toward that side of the room and fades the same way.
    const link = layout.links.find((l) => l.kind === 'portal' && l.to
      && ((l.from.vnum === from && l.to.vnum === to) || (l.from.vnum === to && l.to.vnum === from)));
    const arch = (built.portals || []).find((p) => p.from === from && p.target === to)
      || (link && dir < 4 ? {
        x: a.x * CELL + DIR_STEP[dir][0] * (ROOM / 2 - 1), z: a.z * CELL + DIR_STEP[dir][2] * (ROOM / 2 - 1),
      } : null);
    if (arch) {
      // A doorway at the head of a flight of steps (build.js `climb`) is
      // walked to by its foot: the landing is no ground a mobile paths on.
      const into = arch.foot || { x: arch.x, z: arch.z };
      const points = pathInRoom(from, start, into, 3);
      if (!points) return null;
      const back = (built.portals || []).find((p) => p.from === to && p.target === from);
      const backAt = back && (back.foot || back);
      const arrive = back ? { x: backAt.x, y: b.level * LEVEL_H, z: backAt.z } : randomSpot(to, rand);
      if (!arrive) return null;
      const goal = randomSpot(to, rand, { near: arrive, radius: 6 }) || randomSpot(to, rand);
      const after = goal ? (pathInRoom(to, arrive, goal) || []) : [];
      return { points, level: a.level, portal: { arrive, level: b.level, after }, to };
    }

    // A staircase: to its foot (or its head), and out at the other end.
    const stair = layout.links.find((l) => l.kind === 'stairs'
      && ((l.from.vnum === from && l.to.vnum === to) || (l.from.vnum === to && l.to.vnum === from)));
    const side = stair ? layout.stairSide.get(stair) : undefined;
    if (stair && side !== undefined) {
      const [dx, , dz] = DIR_STEP[side];
      const up = b.level > a.level;
      const lower = up ? a : b;
      const upper = up ? b : a;
      const foot = { x: lower.x * CELL + dx * (STAIR_START - 0.2), z: lower.z * CELL + dz * (STAIR_START - 0.2) };
      const head = { x: upper.x * CELL + dx * (STAIR_END - 1.4), z: upper.z * CELL + dz * (STAIR_END - 1.4) };
      const leave = up ? foot : head;
      const land = up ? head : foot;
      const points = pathInRoom(from, start, leave, 3);
      if (!points) return null;
      const open = nearestOpen(b.level, land.x, land.z, 3);
      if (!open) return null;
      const arrive = { x: centreOf(open[0]), y: b.level * LEVEL_H, z: centreOf(open[1]) };
      const goal = randomSpot(to, rand);
      const after = goal ? (pathInRoom(to, arrive, goal) || []) : [];
      // The flight itself, tread by tread: a body walks it rather than
      // dissolving at the foot and reappearing 8.7 m away and a storey up.
      const flight = { x: lower.x * CELL, y: lower.level * LEVEL_H, z: lower.z * CELL, dx, dz };
      const on = (along, y) => ({ x: flight.x + dx * along, y, z: flight.z + dz * along });
      const bottom = on(STAIR_START - 0.3, flight.y + STAIR_RISER);
      const top = on(STAIR_END + 0.18, flight.y + LEVEL_H);
      const lip = on(STAIR_END - 0.7, flight.y + LEVEL_H);
      const climb = up ? [bottom, top, lip, arrive] : [lip, top, bottom, arrive];
      return { points, level: a.level, portal: { arrive, level: b.level, after, stair: true, flight, climb }, to };
    }
    return null;
  }

  /**
   * The height of the ground under (x, z) on a flight `route` returned: the
   * top of whichever tread is there, the upper floor past the head, the lower
   * floor off its sides and foot. build.js's buildStair, in numbers.
   */
  function stairY(flight, x, z) {
    const ox = x - flight.x; const oz = z - flight.z;
    const along = ox * flight.dx + oz * flight.dz;
    const across = Math.abs(ox * flight.dz - oz * flight.dx);
    if (along <= STAIR_END) return flight.y + LEVEL_H;
    if (along >= STAIR_START || across > DOOR_W / 2 + 0.15) return flight.y;
    const i = Math.min(STAIR_STEPS - 1, Math.max(0, Math.floor((STAIR_START - along) / STAIR_TREAD)));
    return flight.y + STAIR_RISER * (i + 1);
  }

  /**
   * The nearest wall a person could put their back to: a solid box at least
   * head high, within `reach` of (x, z). Props (they carry a footprint) do
   * not count. Returns the point on its face and the way out of it, or null.
   */
  function wallNear(x, z, level, reach = 2) {
    const y = moundY(x, z, level) ?? level * LEVEL_H;
    let best = null; let bestD = reach;
    for (const c of solids.around(x, z, _near)) {
      if (c.obb || c.y0 > y + 0.4 || c.y1 < y + 1.9) continue;
      const px = Math.min(c.x1, Math.max(c.x0, x));
      const pz = Math.min(c.z1, Math.max(c.z0, z));
      const d = Math.hypot(x - px, z - pz);
      if (d < 1e-3 || d >= bestD) continue;
      // A face, not a corner: square to the box's side.
      const nx = px === c.x0 ? -1 : px === c.x1 ? 1 : 0;
      const nz = pz === c.z0 ? -1 : pz === c.z1 ? 1 : 0;
      if (Math.abs(nx) + Math.abs(nz) !== 1) continue;
      bestD = d; best = { x: px, z: pz, nx, nz, box: c };
    }
    return best;
  }

  /**
   * Whether a body of radius `r` standing at (x, z) touches any solid but
   * `except` -- a lean spot is against its own wall and nothing else. A
   * counter against that wall made the wall look free to lean on, and the
   * leaner stood in the counter.
   */
  function clearOf(x, z, level, r, except = null) {
    const y = moundY(x, z, level) ?? level * LEVEL_H;
    for (const c of solids.around(x, z, _near)) {
      if (c === except || c.y1 < y + 0.1 || c.y0 > y + 1.8) continue;
      if (c.obb) {
        const dx = x - c.obb.x; const dz = z - c.obb.z;
        const u = dx * c.obb.ux + dz * c.obb.uz;
        const v = -dx * c.obb.uz + dz * c.obb.ux;
        if (Math.abs(u) < c.obb.hx + r && Math.abs(v) < c.obb.hz + r) return false;
        continue;
      }
      if (x > c.x0 - r && x < c.x1 + r && z > c.z0 - r && z < c.z1 + r) return false;
    }
    return true;
  }

  /**
   * Whether a wall stands between two points: the segment against every
   * collider box near it (a slab test). What a name over someone's head has
   * to ask before it is drawn on top of the wall they are behind. Doors are
   * not in `solids`, so a closed door does not hide anyone; a crate does,
   * but only where the line actually passes through it.
   */
  const _seen = new Set();
  const _cands = [];
  function sightBlocked(x0, y0, z0, x1, y1, z1) {
    if (!geometric) return false;
    const dx = x1 - x0; const dy = y1 - y0; const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    _seen.clear();
    const n = Math.max(1, Math.ceil(len / 6));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      for (const c of solids.around(x0 + dx * t, z0 + dz * t, _cands)) _seen.add(c);
    }
    for (const c of _seen) {
      let t0 = 0.02; let t1 = 0.98; // not the eye's own wall, nor the body's
      const slab = (o, d, lo, hi) => {
        if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
        let a = (lo - o) / d; let b = (hi - o) / d;
        if (a > b) { const s = a; a = b; b = s; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        return t0 <= t1;
      };
      if (slab(x0, dx, c.x0, c.x1) && slab(z0, dz, c.z0, c.z1) && slab(y0, dy, c.y0, c.y1)) return true;
    }
    return false;
  }

  /** Is the door (if any) on this exit standing open? `doors` is actors.doors, or null headless. */
  function doorOpen(from, dir, to, doors) {
    const room = world.rooms.get(from);
    const exit = room && room.exits[dir];
    if (!doors) {
      // Headless: the .are file's own word, as reset left it.
      return !(exit && (exit.locks & 2));
    }
    const back = dir < 6 ? REVERSE_DIR[dir] : -1;
    for (const door of doors) {
      const spec = door.spec;
      // A one-way gate stands where the mud has no exit; it bars no exit.
      if (spec.oneWay) continue;
      if ((spec.room === from && spec.dir === dir) || (spec.room === to && spec.dir === back)) {
        if (!door.open) return false;
      }
    }
    return true;
  }

  /**
   * Modelled props placed as instances have no collider -- the player walks
   * through a barrel -- but a mobile should not. Called once the instanced
   * meshes exist; `library` maps a mesh back to the asset it came from.
   */
  function addInstances(groups, library, THREE) {
    if (!geometric || !library) return 0;
    const owner = new Map();
    for (const [name, asset] of library.assets) {
      if (!WALK_ROUND.has(name)) continue;
      for (const p of asset.primitives) owner.set(p.geometry, name);
    }
    const box = new THREE.Box3();
    const m = new THREE.Matrix4();
    const centre = new THREE.Vector3();
    const axis = new THREE.Vector3();
    let added = 0;
    const seen = new Set();
    for (const group of groups) {
      group.traverse((node) => {
        if (!node.isInstancedMesh || !owner.has(node.geometry)) return;
        const name = owner.get(node.geometry);
        if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
        for (let i = 0; i < node.count; i++) {
          node.getMatrixAt(i, m);
          const key = `${name}:${m.elements[12].toFixed(2)},${m.elements[13].toFixed(2)},${m.elements[14].toFixed(2)}`;
          if (seen.has(key)) continue; // one prop is several primitives
          seen.add(key);
          const local = node.geometry.boundingBox;
          box.copy(local).applyMatrix4(m);
          // The oriented footprint: InstanceBatch only ever turns a prop about
          // Y, so its local X axis and its scale are all that is needed. An
          // axis-aligned box round a fallen log at 45 degrees claimed twice
          // the ground it lies on and sealed forest trails shut.
          local.getCenter(centre).applyMatrix4(m);
          axis.setFromMatrixColumn(m, 0);
          const sx = axis.length();
          axis.divideScalar(sx || 1);
          const sz = new THREE.Vector3().setFromMatrixColumn(m, 2).length();
          solids.add({
            x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z, y0: box.min.y, y1: box.max.y,
            obb: {
              x: centre.x, z: centre.z, ux: axis.x, uz: axis.z,
              hx: ((local.max.x - local.min.x) / 2) * sx * 0.9, hz: ((local.max.z - local.min.z) / 2) * sz * 0.9,
            },
          });
          added++;
        }
      });
    }
    grids.clear();
    return added;
  }

  return {
    CELL, LEVEL_H, NAV_RES, levelOf,
    sample, roomAt, territory, randomSpot, findPath, pathInRoom, clearLine, nearestOpen, route, doorOpen,
    stairY, moundY, wallNear, clearOf, sightBlocked,
    addInstances,
    /** How many cells have been rasterised so far -- the grid is built on demand. */
    get built() { return grids.size; },
  };
}
