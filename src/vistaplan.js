/**
 * Where a neighbouring zone is seen from, and which of its rooms (vista.js).
 *
 * Only one zone is drawn at a time (zones.js), so through a crossing's gate
 * there used to be the generic skyline, and once across, the zone you came
 * from was not there behind you. A vista is the start of the zone beyond,
 * laid where the crossing leads: the arrival room one room-pitch past the
 * gate, as it would be if the two zones were one walkable world, the rest of
 * that zone's own layout around it in that zone's own coordinates -- turned
 * only when the gate stands in another wall than the exit's direction, and
 * then so that what you look at through the gate is what you face on
 * arriving (`arrivalYaw` faces you on along the exit's direction).
 *
 * Pure data, like zones.js: same files in, same vista out, so a layout check
 * can run it in node.
 *
 * What is chosen, and why:
 * - Level crossings only. Up and down are a stair or a ladder in a corner;
 *   nothing level can be seen through one, and a zone laid a level under the
 *   ground plane is not seen at all.
 * - The crossing's gate must stand in a wall (`link.side`), and the room it
 *   is in or the room it arrives in must be open to the sky: from inside a
 *   building to inside another there is a doorway onto a doorway, and
 *   nothing in between to see.
 * - The neighbour's rooms are taken outward from the arrival room through
 *   its own exits, as long as each stays clear of everything the drawn zone
 *   builds: no room or street of the neighbour within one cell of one of the
 *   drawn zone's (that ring is where its houses and fields stand), and none
 *   on the near side of the gate. Two zones laid out apart overlap freely --
 *   Moria's trail runs round the city wall in the mud's own words -- and a
 *   vista that drew both would be a town inside a forest.
 */

import { DIR_STEP, REVERSE_DIR, SECTOR } from './are.js';

/** Exits followed out from the arrival room, at most. */
export const VISTA_HOPS = 4;
/** Rooms further than this from the arrival room, in metres, are left to the far silhouettes. */
export const VISTA_NEAR_M = 80;
/** And past this nothing of the neighbour is drawn at all: the skyline takes over. */
export const VISTA_FAR_M = 300;
const CELL_M = 13;
/** Room-pitches past the gate the arrival room may be set, when the first is the drawn zone's. */
export const VISTA_REACH = 3;

const key = (level, x, z) => `${level}:${x},${z}`;

/** `[x, z]` turned `q` quarter-turns clockwise seen from above: north -> east. */
export function turn(x, z, q) {
  let a = x; let b = z;
  for (let i = 0; i < ((q % 4) + 4) % 4; i++) { const t = a; a = -b; b = t; }
  return [a, b];
}

/**
 * Where the drawn zone `zone` (laid out as `here`) shows a neighbour: one
 * site per level crossing whose gate stands in a wall with open ground past
 * it. Decided from the drawn zone alone, so it is known before that zone is
 * built (its bridge cells must be left clear) and before any neighbour is
 * laid out. `openAirOf(zone)` is build.js's `openAirIn` for that zone's rooms.
 */
export function vistaSites(world, plan, here, zone, openAirOf) {
  // What the drawn zone stands on: its rooms and its streets.
  const solid = new Set();
  const roomCells = new Set();
  for (const cell of here.cells.values()) { solid.add(key(cell.level, cell.x, cell.z)); roomCells.add(key(cell.level, cell.x, cell.z)); }
  for (const link of here.links) {
    if (link.kind !== 'alley' || !link.path) continue;
    for (const c of link.path) solid.add(key(link.from.level, c.x, c.z));
  }
  // And the ring round that, where its frontage and fields are built.
  const near = (level, x, z) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (solid.has(key(level, x + a, z + b))) return true;
    return false;
  };
  const openHere = openAirOf(zone);
  const sites = [];
  for (const crossing of plan.crossings) {
    if (crossing.fromZone !== zone.id || crossing.dir > 3) continue;
    const from = here.cells.get(crossing.from);
    // Below level 0 the drawn zone's ground plane lies over the gate: a
    // vista there would be built under the ground (Thalos #5279).
    if (!from || from.room.sector === SECTOR.AIR || from.level < 0) continue;
    const gate = here.links.find((l) => l.kind === 'gate' && l.from === from && l.dir === crossing.dir && l.exit.to === crossing.to);
    if (!gate || gate.side === null || gate.side === undefined || gate.side > 3) continue;
    const arrive = world.rooms.get(crossing.to);
    if (!arrive || arrive.sector === SECTOR.AIR) continue;
    if (!openHere(from.room) && !openAirOf(plan.byId.get(crossing.toZone))(arrive)) continue;
    const side = gate.side;
    const [sx, , sz] = DIR_STEP[side];
    // The arrival room one room-pitch past the gate, on the gate's level,
    // with nothing of the drawn zone's within a cell of it. Where the drawn
    // zone has a room or a street there, a pitch or two further on, along a
    // lane from the gate that crosses none of its rooms -- its frontage
    // gives way to the lane, and a street of its own is crossed: a little
    // further than the crossing walks, and seen, rather than a house past
    // the gate.
    let reach = 0;
    for (let k = 1; k <= VISTA_REACH && !reach; k++) {
      let lane = true;
      for (let j = 1; j < 2 * k && lane; j++) if (roomCells.has(key(from.level, from.x + j * sx, from.z + j * sz))) lane = false;
      if (!lane) break;
      if (!near(from.level, from.x + 2 * k * sx, from.z + 2 * k * sz)) reach = 2 * k;
    }
    if (!reach) continue;
    const ox = from.x + reach * sx; const oz = from.z + reach * sz;
    sites.push({
      crossing, zone: crossing.toZone, from: from.vnum, arrive: crossing.to, side,
      turns: (side - crossing.dir + 4) % 4,
      at: { level: from.level, x: ox, z: oz },
      fromCell: { level: from.level, x: from.x, z: from.z },
      // The cells between the gate and the arrival room, which neither zone
      // builds on and the vista paves -- all but the drawn zone's own
      // streets, which keep their paving. `back` counts from the arrival room.
      bridge: Array.from({ length: reach - 1 }, (_, j) => ({ level: from.level, x: from.x + (j + 1) * sx, z: from.z + (j + 1) * sz, back: reach - 1 - j }))
        .filter((b) => !solid.has(key(b.level, b.x, b.z))),
      near,
    });
  }
  return sites;
}

/**
 * A site's vista, once the neighbour is laid out (`there`): how its grid
 * maps onto the drawn zone's (`map`), the rooms built for real (`near`) and
 * the ones further off drawn only as a silhouette (`far`), and which of its
 * own frontage cells it may build on (`keepFrontage`, in its own grid).
 */
export function planVista(site, there, taken = null) {
  const start = there.cells.get(site.arrive);
  if (!start) throw new Error(`vista: #${site.arrive} is not laid out in zone ${site.zone}`);
  const { at, fromCell, near, turns: q } = site;
  const [sx, , sz] = DIR_STEP[site.side];
  const map = (level, x, z) => {
    const [rx, rz] = turn(x - start.x, z - start.z, q);
    return { level: level - start.level + at.level, x: rx + at.x, z: rz + at.z };
  };
  // Past the gate: at least as far out along the gate's facing as the
  // arrival room itself.
  const beyond = (p) => (p.x - fromCell.x) * sx + (p.z - fromCell.z) * sz >= 2;
  // Clear of the drawn zone, and of the vistas planned before this one
  // (`taken`, their `vistaCells`): two crossings a street apart lead to two
  // zones that would otherwise be laid over each other.
  const free = (p) => {
    if (!taken) return true;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (taken.has(key(p.level, p.x + a, p.z + b))) return false;
    return true;
  };
  const clear = (p) => !near(p.level, p.x, p.z) && free(p);
  const metres = (p) => Math.hypot(p.x - at.x, p.z - at.z) * CELL_M;

  const kept = new Set([start.vnum]);
  const far = [];
  const queue = [[start, 0]];
  const seen = new Set([start.vnum]);
  while (queue.length) {
    const [cell, hops] = queue.shift();
    cell.room.exits.forEach((exit, d) => {
      if (!exit || exit.offMap) return;
      const next = there.cells.get(exit.to);
      if (!next || seen.has(next.vnum)) return;
      seen.add(next.vnum);
      const p = map(next.level, next.x, next.z);
      // On the arrival room's own level only. A room a level up stands on
      // whatever its own zone put under it -- Juargan's "Up the hill" on
      // nothing, a stack of slabs with sky between -- and in a vista nothing
      // may float; a level down is under the drawn zone's ground.
      const ok = next.room.sector !== SECTOR.AIR && p.level === at.level && beyond(p) && clear(p)
        && (d > 3 || clear(map(next.level, (cell.x + next.x) / 2, (cell.z + next.z) / 2)));
      if (!ok) return;
      if (hops + 1 <= VISTA_HOPS && metres(p) <= VISTA_NEAR_M && kept.has(cell.vnum)) {
        kept.add(next.vnum);
        queue.push([next, hops + 1]);
      } else if (metres(p) <= VISTA_FAR_M && !taken?.has(key(p.level, p.x, p.z))) {
        // Outlined only on the arrival room's own level: a far room up or
        // down a level has nothing under it here but air or ground, and its
        // mound or house would hang there or be buried.
        if (p.level === at.level) far.push(next);
        queue.push([next, hops + 1]);
      }
    });
  }
  const keepFrontage = (level, x, z) => {
    const p = map(level, x, z);
    return beyond(p) && !near(p.level, p.x, p.z) && !taken?.has(key(p.level, p.x, p.z));
  };
  return { ...site, map, near: kept, far, start, keepFrontage, layout: there };
}

/**
 * Every cell of the drawn zone's grid a vista stands on, which the drawn
 * zone must not build its own fields, dunes or rock over: the bridge, the
 * kept rooms and the streets between them, the ring round those where the
 * neighbour builds its frontage, and the far rooms. Cell keys as build.js
 * writes them (`level:x,z`).
 */
export function vistaCells(vistas) {
  const out = new Set();
  for (const v of vistas) {
    for (const b of v.bridge) out.add(key(b.level, b.x, b.z));
    const take = (level, x, z, ring) => {
      for (let a = -ring; a <= ring; a++) {
        for (let b = -ring; b <= ring; b++) {
          if ((a || b) && !v.keepFrontage(level, x + a, z + b)) continue;
          const p = v.map(level, x + a, z + b);
          out.add(key(p.level, p.x, p.z));
        }
      }
    };
    for (const vnum of v.near) { const c = v.layout.cells.get(vnum); take(c.level, c.x, c.z, 1); }
    for (const l of v.layout.links) {
      if (l.kind !== 'alley' || !l.path || !l.to || !v.near.has(l.from.vnum) || !v.near.has(l.to.vnum)) continue;
      for (const c of l.path) take(l.from.level, c.x, c.z, 1);
    }
    for (const c of v.far) take(c.level, c.x, c.z, 0);
  }
  return out;
}

/**
 * The neighbour's layout cut down to the rooms a vista keeps, in the shape
 * build.js reads a layout in: the same cell, link and side objects, so what
 * is built for a room is what its own zone builds for it. A passage to a
 * room left out is left out with it; the room keeps its opening onto it.
 */
export function cutLayout(layout, keep) {
  const cells = new Map();
  for (const [vnum, cell] of layout.cells) if (keep.has(vnum)) cells.set(vnum, cell);
  const order = layout.order.filter((c) => keep.has(c.vnum));
  const links = layout.links.filter((l) => keep.has(l.from.vnum) && (!l.to || keep.has(l.to.vnum)));
  const occupied = new Map();
  for (const cell of cells.values()) occupied.set(key(cell.level, cell.x, cell.z), cell.vnum);
  const pathOwner = new Map();
  for (const link of links) {
    if (link.kind !== 'alley' || !link.path) continue;
    for (const c of link.path) pathOwner.set(key(link.from.level, c.x, c.z), link);
  }
  const sides = new Map();
  for (const vnum of cells.keys()) sides.set(vnum, layout.sides.get(vnum));
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  let minLevel = Infinity; let maxLevel = -Infinity;
  for (const cell of cells.values()) {
    minX = Math.min(minX, cell.x); maxX = Math.max(maxX, cell.x);
    minZ = Math.min(minZ, cell.z); maxZ = Math.max(maxZ, cell.z);
    minLevel = Math.min(minLevel, cell.level); maxLevel = Math.max(maxLevel, cell.level);
  }
  return {
    cells, links, order, pathCells: new Set(pathOwner.keys()), sides, stairSide: layout.stairSide,
    start: order[0], bounds: { minX, maxX, minZ, maxZ, minLevel, maxLevel },
    stats: {
      placed: cells.size,
      alleys: links.filter((l) => l.kind === 'alley').length,
      stairs: links.filter((l) => l.kind === 'stairs').length,
      portals: links.filter((l) => l.kind === 'portal').length,
      gates: links.filter((l) => l.kind === 'gate').length,
    },
    at: (level, x, z) => occupied.get(key(level, x, z)),
    isPath: (level, x, z) => pathOwner.has(key(level, x, z)),
    passageAt: (level, x, z) => pathOwner.get(key(level, x, z)),
  };
}

export { REVERSE_DIR };
