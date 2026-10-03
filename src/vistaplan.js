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
  for (const cell of here.cells.values()) solid.add(key(cell.level, cell.x, cell.z));
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
    if (!from || from.room.sector === SECTOR.AIR) continue;
    const gate = here.links.find((l) => l.kind === 'gate' && l.from === from && l.dir === crossing.dir && l.exit.to === crossing.to);
    if (!gate || gate.side === null || gate.side === undefined || gate.side > 3) continue;
    const arrive = world.rooms.get(crossing.to);
    if (!arrive || arrive.sector === SECTOR.AIR) continue;
    if (!openHere(from.room) && !openAirOf(plan.byId.get(crossing.toZone))(arrive)) continue;
    const side = gate.side;
    const [sx, , sz] = DIR_STEP[side];
    // The arrival room one room-pitch past the gate, on the gate's level --
    // and nothing of the drawn zone's within a cell of it.
    const ox = from.x + 2 * sx; const oz = from.z + 2 * sz;
    if (near(from.level, ox, oz)) continue;
    sites.push({
      crossing, zone: crossing.toZone, from: from.vnum, arrive: crossing.to, side,
      turns: (side - crossing.dir + 4) % 4,
      at: { level: from.level, x: ox, z: oz },
      fromCell: { level: from.level, x: from.x, z: from.z },
      // The cell between the gate and the arrival room, which neither zone builds on.
      bridge: { level: from.level, x: from.x + sx, z: from.z + sz },
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
export function planVista(site, there) {
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
  const clear = (p) => !near(p.level, p.x, p.z);
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
      const ok = next.room.sector !== SECTOR.AIR && p.level >= at.level && beyond(p) && clear(p)
        && (d > 3 || clear(map(next.level, (cell.x + next.x) / 2, (cell.z + next.z) / 2)));
      if (!ok) return;
      if (hops + 1 <= VISTA_HOPS && metres(p) <= VISTA_NEAR_M && kept.has(cell.vnum)) {
        kept.add(next.vnum);
        queue.push([next, hops + 1]);
      } else if (metres(p) <= VISTA_FAR_M) {
        far.push(next);
        queue.push([next, hops + 1]);
      }
    });
  }
  const keepFrontage = (level, x, z) => {
    const p = map(level, x, z);
    return beyond(p) && clear(p);
  };
  return { ...site, map, near: kept, far, start, keepFrontage, layout: there };
}

/**
 * The cells the drawn zone must leave unbuilt so its vistas meet it: the one
 * between each vista's gate and its arrival room. Cell keys as build.js
 * writes them (`level:x,z`).
 */
export function bridgeCells(sites) {
  return new Set(sites.map((v) => key(v.bridge.level, v.bridge.x, v.bridge.z)));
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
