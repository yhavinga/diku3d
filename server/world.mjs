/**
 * The server's world: every area in area.lst, read the way the page reads
 * it (main.js), partitioned into the same zones (zones.js) and laid out
 * from the same fixed roots, so a room's coordinates here are a room's
 * coordinates in every client.
 *
 * The page draws one zone at a time; the server holds them all at once. Two
 * zones' layouts overlap -- each is laid out round its own origin -- so here
 * each is moved along x by its own multiple of SPAN, far enough that no
 * reach, hearing or aggression test can mistake one zone for the next. game.js
 * then runs over one `built` holding every room. A client still speaks in its
 * own zone's coordinates; `toServer`/`toClient` are the whole translation.
 *
 * What the server cannot have is the geometry: build.js is three.js. Its rooms
 * are the layout grid, as tools/game-check.mjs stubs them, and the server's
 * game stands everyone on that grid. Where build.js raises a room -- the
 * temple's mound, `mounds` below -- a client's report comes down by the lift
 * on the way in and goes back up on the way out (`liftAt`), so a player on
 * the temple steps and a mobile beside them are on one floor for reach. The
 * arrival point moved off a stair opening is still the client's alone.
 *
 * Nor can it have build.js's walls, bar one kind: which rooms are walled at
 * all is shells.js `isOpenAir`, build.js's own answer, and a walled room's
 * walls stand where build.js stands them, with a doorway on every side the
 * layout gave an exit. That is all `judge` holds a client's walking to.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { parseArea, buildWorld, SECTOR, ROOM_INDOORS, EX_CLOSED } from '../src/are.js';
import { planZones, layoutZone, HOME_AREAS } from '../src/zones.js';
import { createNav } from '../src/nav.js';
import { readShell, shellAttrs, openAirIn } from '../src/shells.js';
import { AFF } from '../src/rules/handler.js';

/** build.js's grid, as nav.js and game-check.mjs repeat it. */
export const CELL = 13;
export const LEVEL_H = 7.6;
/**
 * Metres between two zones' frames: a multiple of a cell (13), of game.js's
 * buckets (26) and of the nav grid (0.5), so a bucket or a sample never
 * straddles two zones; and far past any zone's own extent (Midgaard's home
 * zone spans about 1.6 km).
 */
export const SPAN = 26000;
/** Metres a second a page may move its player: a glide's top speed and some. */
const MAX_SPEED = 45;
/** ...and up: a jump, a glide up a stair. */
const MAX_CLIMB = 30;
/**
 * ...and down, which is a fall: off the canyon's highest ledge it is 84 m to
 * the ground (tools/judge/headless/walkable.mjs), and at player.js's 24 m/s2
 * the last tenth of a second of it is 6.4 m.
 */
const MAX_FALL = 70;
/** Metres of jitter on top: two reports in one packet, a frame's rounding. */
const SPEED_SLACK = 3;
/**
 * Where a walled room's wall is, for a step through it: build.js's box (the
 * middle of a wall whose inner face is ROOM/2 out, KIT_LINE), or the ring of
 * a hollow tree (`buildGreatTree`: hollow to 4.2-4.9 m, bark from 6.0 m).
 * A body is stopped 0.9 m short of the line, at 4.44 m from the middle.
 */
const WALL_LINE = 5.35;
const TREE_LINE = 5.4;
/** Half a doorway (build.js DOOR_W 3.2) and some: through a wall there is through its door. */
const DOOR_HALF = 1.9;

const OUTDOOR = new Set([
  SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS, SECTOR.MOUNTAIN,
  SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT, SECTOR.AIR,
]);

/** Read and lay out the whole mud. `root` is the repository. */
export function bootWorld(root, { log = () => {} } = {}) {
  const areaDir = join(root, 'merc21/area');
  const listed = readFileSync(join(areaDir, 'area.lst'), 'utf8').split(/\s+/).filter((f) => f.endsWith('.are'));
  const files = [...listed, ...HOME_AREAS.filter((f) => !listed.includes(f))];
  const world = buildWorld(files.map((f) => parseArea(readFileSync(join(areaDir, f), 'utf8'), f)));
  const plan = planZones(world);
  log(`${world.rooms.size} rooms in ${files.length} areas, ${plan.zones.length} zones`);

  const zones = [];
  const built = { rooms: new Map(), colliders: [], portals: [] };
  const openAir = openAirIn(world);
  const links = [];
  for (const [index, zone] of plan.zones.entries()) {
    const layout = layoutZone(world, plan, zone);
    const offset = index * SPAN;
    // The zone's own frame, which nav.js plans routes in.
    const local = { rooms: new Map(), colliders: [], portals: [] };
    for (const [vnum, cell] of layout.cells) {
      const room = world.rooms.get(vnum);
      const centre = { x: cell.x * CELL, y: cell.level * LEVEL_H, z: cell.z * CELL };
      const info = {
        room, cell, center: centre,
        outdoor: OUTDOOR.has(room.sector) && !(room.flags & ROOM_INDOORS),
        // build.js builds nothing for an "In the air..." room: nobody stands there.
        unbuilt: room.sector === SECTOR.AIR || undefined,
        // Built with walls round it, and a hollow tree's are round.
        walled: room.sector !== SECTOR.AIR && !openAir(room),
        round: !openAir(room) && shellAttrs(room)?.named === 'tree',
        materials: {},
      };
      local.rooms.set(vnum, info);
      built.rooms.set(vnum, { ...info, center: { x: centre.x + offset, y: centre.y, z: centre.z }, zone: zone.id });
    }
    links.push(...layout.links);
    zones.push({ zone, index, offset, layout, local, nav: null });
  }
  const byId = new Map(zones.map((z) => [z.zone.id, z]));
  const lifts = mounds(world, zones);
  /** How far build.js raises the floor at a server point: the lift of the room it belongs to. */
  const liftAt = (x, y, z) => {
    const zone = zoneAtX(x);
    if (!zone) return 0;
    const vnum = navOf(zone).roomAt(x - zone.offset, y, z);
    return lifts.get(vnum) || 0;
  };
  const zoneOfVnum = (vnum) => byId.get(plan.zoneOf(vnum)?.id) || null;
  const zoneAtX = (x) => zones[Math.floor((x + SPAN / 2) / SPAN)] || null;
  // nav.js per zone, made the first time anything asks about that zone.
  const navOf = (z) => {
    if (!z.nav) z.nav = createNav({ layout: z.layout, built: z.local, world });
    return z.nav;
  };

  /**
   * What the layout says of a server point: `exact` when it lies in a room's
   * own cell or a street's, and `near`, every room whose cell -- or whose
   * street -- is that cell or one beside it. A glide cuts the corners of a
   * bent street, and there nav's `roomAt` falls back to the nearest room
   * centre, which can be a room the street never meets.
   */
  const placeAt = (x, y, z) => {
    const zone = zoneAtX(x);
    if (!zone) return null;
    const L = zone.layout;
    const level = Math.round(y / LEVEL_H);
    const cx = Math.round((x - zone.offset) / CELL);
    const cz = Math.round(z / CELL);
    const exact = L.at(level, cx, cz) !== undefined || !!L.passageAt(level, cx, cz);
    // Every room this point could be standing in: the room whose cell it is,
    // and the nearer end of every street through the cell -- streets cross,
    // and layout.passageAt keeps only one of them.
    const candidates = new Set();
    if (L.at(level, cx, cz) !== undefined) candidates.add(L.at(level, cx, cz));
    for (const street of streetsAt(zone).get(`${level},${cx},${cz}`) || []) {
      if (!street.to) { candidates.add(street.from.vnum); continue; }
      const da = (street.from.x * CELL + zone.offset - x) ** 2 + (street.from.z * CELL - z) ** 2;
      const db = (street.to.x * CELL + zone.offset - x) ** 2 + (street.to.z * CELL - z) ** 2;
      candidates.add(da <= db ? street.from.vnum : street.to.vnum);
    }
    const near = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const room = L.at(level, cx + dx, cz + dz);
        if (room !== undefined) near.add(room);
        const street = L.passageAt(level, cx + dx, cz + dz);
        if (street) { near.add(street.from.vnum); if (street.to) near.add(street.to.vnum); }
      }
    }
    return { exact, near, candidates };
  };
  // ----------------------------------------------------- what a client says --
  const nav = compositeNav({ zones, zoneOfVnum, zoneAtX, navOf });
  const levelOf = (feet) => Math.round(feet / LEVEL_H);
  /** The layout cell a server point (at its feet) is in, and its zone. */
  const cellAt = (p) => {
    const zone = zoneAtX(p.x);
    return zone && { zone, level: levelOf(p.y), x: Math.round((p.x - zone.offset) / CELL), z: Math.round(p.z / CELL) };
  };
  /** A step a body takes: in one zone, into a cell beside it, no more than a level up or down. */
  const walk = (p, q) => {
    const a = cellAt(p); const b = cellAt(q);
    return !!a && !!b && a.zone === b.zone && Math.abs(a.level - b.level) <= 1
      && Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= 1;
  };
  // game.js's `nearestRoom` over the same rooms, for a body out in the open:
  // the room the game counts it as standing in.
  const centres = new Map();
  for (const [vnum, info] of built.rooms) {
    const key = `${Math.floor(info.center.x / 26)},${Math.floor(info.center.z / 26)}`;
    if (!centres.has(key)) centres.set(key, []);
    centres.get(key).push({ vnum, ...info.center });
  }
  const nearestRoom = (x, y, z) => {
    let best; let bestD = Infinity;
    const take = (r) => { const d = (r.x - x) ** 2 + (r.y - y) ** 2 + (r.z - z) ** 2; if (d < bestD) { bestD = d; best = r.vnum; } };
    const bx = Math.floor(x / 26); const bz = Math.floor(z / 26);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const r of centres.get(`${bx + dx},${bz + dz}`) || []) take(r);
    if (best === undefined) for (const vnum of zoneAtX(x).layout.cells.keys()) take({ vnum, ...built.rooms.get(vnum).center });
    return best;
  };
  /** Within a walled room's walls, seen from above: its box, or a hollow tree's ring. */
  const withinWalls = (info, p) => {
    const dx = p.x - info.center.x; const dz = p.z - info.center.z;
    return info.round ? dx * dx + dz * dz < TREE_LINE * TREE_LINE : Math.abs(dx) < WALL_LINE && Math.abs(dz) < WALL_LINE;
  };
  /** The walled room a server point is inside the walls of, on its own level, or null. */
  const walledAround = (p) => {
    const c = cellAt(p);
    const vnum = c ? c.zone.layout.at(c.level, c.x, c.z) : undefined;
    const info = vnum !== undefined && built.rooms.get(vnum);
    return info && info.walled && withinWalls(info, p) ? vnum : null;
  };
  /**
   * The wall a step on one level goes through, if it goes through a walled
   * room's: { room } for the wall itself, { room, door } for a doorway whose
   * door is shut -- or null, for a step through an open doorway or no wall at
   * all. A doorway is the middle of a side the layout gave an exit, which is
   * where build.js cuts it.
   */
  const wallCrossed = (p, q, passDoor) => {
    const a = cellAt(p);
    if (!a || !walk(p, q) || levelOf(q.y) !== a.level) return null;
    const L = a.zone.layout;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const vnum = L.at(a.level, a.x + dx, a.z + dz);
        const info = vnum !== undefined && built.rooms.get(vnum);
        if (!info || !info.walled) continue;
        const inside = withinWalls(info, p);
        if (inside === withinWalls(info, q)) continue;
        // Where the step meets the wall, to a few millimetres.
        let lo = 0; let hi = 1;
        for (let k = 0; k < 12; k++) {
          const m = (lo + hi) / 2;
          if (withinWalls(info, { x: p.x + (q.x - p.x) * m, z: p.z + (q.z - p.z) * m }) === inside) lo = m; else hi = m;
        }
        const ox = p.x + (q.x - p.x) * hi - info.center.x; const oz = p.z + (q.z - p.z) * hi - info.center.z;
        const dir = Math.abs(ox) > Math.abs(oz) ? (ox > 0 ? 1 : 3) : (oz > 0 ? 2 : 0);
        const side = (L.sides.get(vnum) || [])[dir];
        if (!side || Math.abs(dir === 1 || dir === 3 ? oz : ox) >= DOOR_HALF) return { room: vnum };
        // The far end of a one-way exit has no exit of its own: the door is the one leading in.
        const exit = side.exit || side.link?.exit;
        if (exit && (exit.locks & EX_CLOSED) && !passDoor) return { room: vnum, door: exit };
      }
    }
    return null;
  };
  /**
   * A way up or down between two rooms, either way, shut or not. build.js
   * stands a flight, a ladder or a shaft in it and never a door, so a shut
   * trapdoor stops a typed `down` but not a body on the stair (57 of the 71
   * doors on ways up or down are shut by their resets).
   */
  const stairBetween = (a, b) => [[a, b], [b, a]].some(([p, q]) => (world.rooms.get(p)?.exits || []).some((e, d) => e && d > 3 && e.to === q));
  /** move_char's question: an exit from `from` to `to`, not shut -- unless you pass doors. */
  function adjacent(ch, from, to) {
    const room = world.rooms.get(from);
    if (!room) return false;
    const passDoor = (ch.affectedBy || 0) & AFF.PASS_DOOR;
    return room.exits.some((e) => e && !e.offMap && e.to === to && (!(e.locks & EX_CLOSED) || passDoor));
  }
  /**
   * Whether a reported point can be where this player is: { room } when it
   * can -- the room it counts as standing in -- or { why } when it cannot.
   * `s` is the session ({ navRoom, posAt }), (x, y, z) the report in the
   * server's frame, eye height, the mound's lift already off it.
   *
   * The body is the page's to walk, and the page's ground runs on where the
   * mud joins nothing: streets cross and touch, the grass outside the walls
   * reaches every room on it, and a ledge can be walked off. So a move along
   * an open exit is believed as it always was, any other step wherever it
   * goes, and a report is refused only for what a page cannot do:
   *  - stand inside the rock (below ground, on no room's floor nor a street's);
   *  - turn up in another room, more than a step away, that no open exit
   *    leads to (a jump: a page's glide follows an exit);
   *  - go through the wall of a walled room, or its doorway with the door
   *    shut; nor up or down into or out of one but by an exit's own way;
   *  - off an exit, move faster than anything a page does (a run is 9.5 m/s,
   *    a glide tops out near 40), or climb or fall faster.
   * tools/judge/headless/walkable.mjs walks every step the page allows, in
   * every zone, through this, and none may be refused.
   */
  function judge(s, pc, x, y, z, now) {
    const feet = y - 1.72;
    let vnum = nav.roomAt(x, feet, z);
    // The room of the last report believed, by the same rule as this one's;
    // after a jump, the room the server put the player in.
    const from = s.navRoom ?? pc.ch.roomVnum;
    if (vnum === undefined || !built.rooms.has(vnum)) {
      // On no room's floor nor a street's: out in the open, on the grass
      // between them or falling past them -- unless this is below the ground.
      if (!zoneAtX(x) || levelOf(feet) < 0) return { why: 'off the map' };
      vnum = nearestRoom(x, y, z);
    } else if (vnum !== from) {
      const place = placeAt(x, feet, z);
      if (place && place.exact) {
        // Where two streets cross, the cell is on both: this room's, or a neighbour's, first.
        if (place.candidates.has(from)) vnum = from;
        else vnum = [...place.candidates].find((v) => adjacent(pc.ch, from, v)) ?? vnum;
      } else if (place && [...place.near].some((v) => v === from || adjacent(pc.ch, from, v))) {
        // Off the street, on a corner a glide cut: still where it was, if the
        // street it is beside is one of this room's or a neighbour's.
        vnum = from;
      }
    }
    const was = { x: pc.position.x, y: pc.position.y - 1.72, z: pc.position.z };
    const here = { x, y: feet, z };
    // Just placed (enter, teleport, recall): the next report is the first,
    // and is where it was put or a step from it.
    if (s.posAt === null) {
      return vnum === from || adjacent(pc.ch, from, vnum) || walk(was, here) ? { room: vnum } : { why: `#${vnum} is not #${from}` };
    }
    // Along an open exit: a step, a glide down the street, a fade through an arch.
    if (vnum !== from && adjacent(pc.ch, from, vnum)) return { room: vnum };
    if (vnum !== from) {
      if (!walk(was, here)) return { why: `no open way from #${from} to #${vnum}` };
      // A stair is climbed both ways, whichever way the mud's exit runs.
      if (levelOf(was.y) !== levelOf(feet) && !adjacent(pc.ch, vnum, from) && !stairBetween(from, vnum)
        && (walledAround(here) !== null || walledAround(was) !== null)) {
        return { why: `no way up or down from #${from} to #${vnum}` };
      }
    }
    const wall = wallCrossed(was, here, (pc.ch.affectedBy || 0) & AFF.PASS_DOOR);
    if (wall) return { why: wall.door ? `the ${wall.door.keyword || 'door'} of #${wall.room} is shut` : `through the wall of #${wall.room}` };
    const dt = Math.max(0.05, (now - s.posAt) / 1000);
    const d = Math.hypot(x - pc.position.x, z - pc.position.z);
    if (d > MAX_SPEED * dt + SPEED_SLACK) return { why: `${d.toFixed(1)} m in ${dt.toFixed(2)} s` };
    const dy = y - pc.position.y;
    if (dy > MAX_CLIMB * dt + SPEED_SLACK || -dy > MAX_FALL * dt + SPEED_SLACK) return { why: `${Math.abs(dy).toFixed(1)} m up or down in ${dt.toFixed(2)} s` };
    return { room: vnum };
  }
  /** Per zone, every street through each cell: "level,x,z" -> [link]. */
  const streetsAt = (zone) => {
    if (!zone.streets) {
      zone.streets = new Map();
      for (const link of zone.layout.links) {
        for (const c of link.path || []) {
          const key = `${link.from.level},${c.x},${c.z}`;
          if (!zone.streets.has(key)) zone.streets.set(key, []);
          zone.streets.get(key).push(link);
        }
      }
    }
    return zone.streets;
  };

  return {
    world, plan, zones, byId, built, zoneOfVnum, zoneAtX, lifts, liftAt, placeAt, judge, adjacent,
    layout: { links, cells: new Map() },
    nav,
    /** A client's zone-local point into the server's frame. */
    toServer: (zoneId, p) => ({ x: p.x + (byId.get(zoneId)?.offset ?? NaN), y: p.y, z: p.z }),
    /** A server point into the frame of the zone it is in. */
    toClient: (p) => {
      const z = zoneAtX(p.x);
      return z ? { zone: z.zone.id, x: p.x - z.offset, y: p.y, z: p.z } : null;
    },
  };
}

/**
 * build.js `mounds`, without three.js: "the huge mound upon which the temple
 * is built" raises that room and the temple rooms joined to it on its level
 * MOUND_LIFT, unless something stands on the level above. build.js keeps
 * open-air rooms off the mound by its own `isOpenAir`; here the mud's sector
 * stands in for it, which is the same set wherever a mound is written.
 * tools/server-check.mjs holds the result to what a page builds.
 */
export const MOUND_LIFT = 1.2;
function mounds(world, zones) {
  const lifts = new Map();
  const openAir = (room) => OUTDOOR.has(room.sector) && !(room.flags & ROOM_INDOORS);
  const temple = /\btemple\b/i;
  for (const { layout } of zones) {
    for (const vnum of layout.cells.keys()) {
      const room = world.rooms.get(vnum);
      if (openAir(room) || !readShell(room)?.mound) continue;
      const cell = layout.cells.get(vnum);
      const queue = [room];
      while (queue.length) {
        const r = queue.shift();
        const c = layout.cells.get(r.vnum);
        if (!c || lifts.has(r.vnum) || c.level !== cell.level || layout.at(c.level + 1, c.x, c.z) !== undefined) continue;
        lifts.set(r.vnum, MOUND_LIFT);
        for (const e of r.exits.slice(0, 4)) {
          const next = e && world.rooms.get(e.to);
          if (next && !openAir(next) && temple.test(next.name) && !lifts.has(next.vnum)) queue.push(next);
        }
      }
    }
  }
  return lifts;
}

/**
 * nav.js's interface over every zone at once: a question about a room goes
 * to its zone's nav, one about a point to the zone that point lies in, and
 * every coordinate crosses the offset on the way in and out.
 */
function compositeNav({ zones, zoneOfVnum, zoneAtX, navOf }) {
  const NAV_RES = 0.5;
  const shiftPoint = (p, dx) => (p && typeof p.x === 'number' ? { ...p, x: p.x + dx } : p);
  const shiftList = (list, dx) => (Array.isArray(list) ? list.map((p) => shiftPoint(p, dx)) : list);
  /** A route out of nav.js, every point on it moved into the server's frame. */
  function shiftRoute(route, dx) {
    if (!route) return route;
    const out = { ...route, points: shiftList(route.points, dx) };
    if (route.portal) {
      out.portal = {
        ...route.portal,
        arrive: shiftPoint(route.portal.arrive, dx),
        after: shiftList(route.portal.after, dx),
        climb: shiftList(route.portal.climb, dx),
        flight: shiftPoint(route.portal.flight, dx),
      };
    }
    return out;
  }
  return {
    CELL, LEVEL_H, NAV_RES,
    levelOf: (y) => Math.round(y / LEVEL_H),
    doorOpen(from, dir, to, doors) {
      const z = zoneOfVnum(from);
      return z ? navOf(z).doorOpen(from, dir, to, doors) : false;
    },
    route(from, dir, to, start, rand) {
      const z = zoneOfVnum(from);
      if (!z) return null;
      return shiftRoute(navOf(z).route(from, dir, to, shiftPoint(start, -z.offset), rand), z.offset);
    },
    roomAt(x, y, z) {
      const zone = zoneAtX(x);
      return zone ? navOf(zone).roomAt(x - zone.offset, y, z) : undefined;
    },
    sample(x, z, level) {
      const zone = zoneAtX(x);
      return zone ? navOf(zone).sample(x - zone.offset, z, level) : 0;
    },
    nearestOpen(level, x, z, reach, allowed) {
      const zone = zoneAtX(x);
      if (!zone) return null;
      const open = navOf(zone).nearestOpen(level, x - zone.offset, z, reach, allowed);
      return open ? [open[0] + zone.offset / NAV_RES, open[1]] : null;
    },
    randomSpot(vnum, rand, options = {}) {
      const zone = zoneOfVnum(vnum);
      if (!zone) return null;
      const near = options.near ? shiftPoint(options.near, -zone.offset) : null;
      return shiftPoint(navOf(zone).randomSpot(vnum, rand, { ...options, near }), zone.offset);
    },
    get zonesWithNav() { return zones.filter((z) => z.nav).length; },
  };
}
