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
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { parseArea, buildWorld, SECTOR, ROOM_INDOORS } from '../src/are.js';
import { planZones, layoutZone, HOME_AREAS } from '../src/zones.js';
import { createNav } from '../src/nav.js';
import { readShell } from '../src/shells.js';

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

  return {
    world, plan, zones, byId, built, zoneOfVnum, zoneAtX, lifts, liftAt,
    layout: { links, cells: new Map() },
    nav: compositeNav({ zones, zoneOfVnum, zoneAtX, navOf }),
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
