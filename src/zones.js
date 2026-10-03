/**
 * Zones: which rooms are laid out and built together.
 *
 * The world the rules engine runs is every area in area.lst at once -- the
 * mobiles of the Mud School reset and wander whether or not anyone is looking
 * at them, as they would on a server holding the whole mud. What is *drawn* is
 * one zone at a time. The home zone is the nine areas that make one walkable
 * world round Midgaard; every other area (or a small group that only makes
 * sense together) is a zone of its own, laid out by itself. An exit whose far
 * end is in another zone is a crossing: taking it tears down one zone and
 * builds the next.
 *
 * Pure data, no three.js and no DOM: a server (see the multiplayer plan) runs
 * this unchanged to agree with every client about where a room is. Same files
 * in, same coordinates out -- the start room of every zone is fixed here and
 * never depends on where the player happens to enter.
 */

import { DIR_STEP, REVERSE_DIR } from './are.js';
import { layoutWorld } from './layout.js';

/**
 * The default world. Measured choices, each one documented where main.js
 * used to list them: clean branches off the town, the sewer under it, and the
 * neighborhood laid down whole beside the desert.
 */
export const HOME_AREAS = ['midgaard.are', 'haon.are', 'shire.are', 'marsh.are',
  'trollden.are', 'grave.are', 'sewer.are', 'eastern.are', 'hood.are'];
export const HOME_START = 3001;
// A live trap: the breadth-first placement stops mid-walk at the cap, and
// whole areas silently get zero rooms while their exits degrade to gates.
// tools/world-check.mjs guards this number for the shipping set.
export const HOME_MAX_ROOMS = 640;

/**
 * Areas that are one place in two files. Ofcol is an eight-room gatehouse to
 * New Ofcol and nothing else; a crossing between them would be a load screen
 * between a gate and the street behind it.
 */
export const ZONE_GROUPS = [['ofcol.are', 'ofcol2.are']];

const zoneName = (file) => file.replace(/\.are$/, '');

/**
 * Partition the loaded areas into zones. `home` is the list of files that
 * make the home zone (the default nine, or `?areas=`), `homeStart` its
 * layout root.
 */
export function planZones(world, { home = HOME_AREAS, homeStart = HOME_START, homeMax = HOME_MAX_ROOMS } = {}) {
  const loaded = new Set(world.areas.map((a) => a.file));
  const zones = [];
  const byFile = new Map();
  const add = (files, start, maxRooms) => {
    const present = files.filter((f) => loaded.has(f) && !byFile.has(f));
    if (!present.length) return;
    const areas = present.map((f) => world.areas.find((a) => a.file === f));
    const first = areas.find((a) => a.rooms.length);
    if (!first) return;
    const zone = {
      id: zones.length ? zoneName(present[0]) : 'home',
      files: present,
      name: zones.length ? first.name : 'Midgaard',
      start: world.rooms.has(start) && present.includes(world.rooms.get(start).areaFile) ? start : first.rooms[0].vnum,
      maxRooms,
      rooms: new Set(areas.flatMap((a) => a.rooms.map((r) => r.vnum))),
    };
    zones.push(zone);
    for (const f of present) byFile.set(f, zone);
  };
  add(home, homeStart, homeMax);
  for (const group of ZONE_GROUPS) add(group, -1, Infinity);
  for (const area of world.areas) add([area.file], -1, Infinity);

  const byId = new Map(zones.map((z) => [z.id, z]));
  const zoneOf = (vnum) => {
    const room = world.rooms.get(vnum);
    return room ? byFile.get(room.areaFile) || null : null;
  };

  // Every exit whose far end is in another zone, and the rooms such exits
  // arrive in: those have to be laid out even when the zone's own start
  // cannot walk to them (the High Tower's crossings land in rooms its first
  // room never reaches).
  const crossings = [];
  for (const room of world.rooms.values()) {
    const from = zoneOf(room.vnum);
    room.exits.forEach((exit, dir) => {
      if (!exit || exit.offMap) return;
      const to = zoneOf(exit.to);
      if (!from || !to || to === from) return;
      crossings.push({ from: room.vnum, dir, to: exit.to, fromZone: from.id, toZone: to.id });
    });
  }
  for (const zone of zones) {
    zone.arrivals = [...new Set(crossings.filter((c) => c.toZone === zone.id).map((c) => c.to))].sort((a, b) => a - b);
  }
  return { zones, byId, zoneOf, crossings, home: zones[0] };
}

/**
 * The zone as build.js and actors.js see a world: its own rooms only, so
 * anything that walks `world.rooms` (the sewer's styles, the temple mound,
 * the Shire's smials) sees what it saw when only these areas were loaded.
 * The rooms are the same objects the rules engine holds, so a door the game
 * opens is open in the geometry too.
 */
export function zoneWorld(world, zone) {
  const rooms = new Map();
  for (const [vnum, room] of world.rooms) if (zone.rooms.has(vnum)) rooms.set(vnum, room);
  return {
    areas: world.areas.filter((a) => zone.files.includes(a.file)),
    rooms, mobProtos: world.mobProtos, objProtos: world.objProtos, shops: world.shops, specials: world.specials,
  };
}

/**
 * Lay a zone out: layout.js's own placement from the zone's fixed start,
 * with every arrival room it could not walk to laid down whole beside it.
 */
export function layoutZone(world, plan, zone) {
  return layoutWorld(world, {
    startVnum: zone.start,
    maxRooms: zone.maxRooms,
    includeVnum: (v) => plan.zoneOf(v) === zone,
    roots: zone.arrivals,
  });
}

/**
 * Which way to face on arriving through a crossing: on along the way you
 * came for a step north, east, south or west; for up and down, away from
 * the way back if it is level, otherwise out of the room by its first level
 * exit. Yaw in the camera's convention (forward is (-sin, 0, -cos)).
 */
export function arrivalYaw(world, arrive, dir) {
  const yawOf = (d) => Math.atan2(-DIR_STEP[d][0], -DIR_STEP[d][2]);
  if (dir !== undefined && dir !== null && dir < 4) return yawOf(dir);
  const room = world.rooms.get(arrive);
  if (!room) return 0;
  const back = dir !== undefined && dir !== null ? REVERSE_DIR[dir] : -1;
  if (back >= 0 && back < 4 && room.exits[back]) return yawOf(REVERSE_DIR[back]);
  const level = [0, 1, 2, 3].filter((d) => room.exits[d] && d !== back);
  return level.length ? yawOf(level[0]) : 0;
}
