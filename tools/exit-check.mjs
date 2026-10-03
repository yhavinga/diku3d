/**
 * Does every exit the mud names have a doorway on the wall it names?
 *
 *   node tools/exit-check.mjs            # one line per zone with a fault
 *   node tools/exit-check.mjs 3700       # every room of the zone that holds #3700
 *   node tools/exit-check.mjs --strict   # exit 1 on a fault that must not ship
 *
 * Read from the layout (`layout.sides`, `link.side`, `link.backSide`), which
 * is where build.js takes its doorways from:
 *   wrong wall  the exit has an opening, but on another wall than its direction
 *               (sometimes forced: the graph is not Euclidean, see CLAUDE.md)
 *   in corner   no wall was left for it, so its archway stands in a corner
 *               against a wall, beside that wall's own doorway (The Void in
 *               Machine Dreams: four exits a room, routed across each other)
 *               -- visible and walkable, but not on the wall it names
 *   no door     the exit has no opening in this room at all, and the compass
 *               step would cut through a wall
 *   one-way     an opening into a room this room has no exit to (the mud's own
 *               one-way exits, like the Mud School entrance into the arena);
 *               `open` if nothing bars it -- layout.js marks such an end
 *               `oneWay` and build.js shuts it with a gate
 * Up and down are not checked here: they are stairs or archways, not walls.
 *
 * --strict fails on any exit with no door, on any one-way opening left open,
 * and on more wrong walls or corner archways than the CEILING below --
 * lower the ceiling when a change brings the counts down.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld } from '../src/are.js';
import { planZones, layoutZone } from '../src/zones.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');
const files = readFileSync(join(areaDir, 'area.lst'), 'utf8').split(/\s+/).filter((f) => f.endsWith('.are'));
const world = buildWorld(files.map((f) => parseArea(readFileSync(join(areaDir, f), 'latin1'), f)));
const plan = planZones(world, {});
const D = ['north', 'east', 'south', 'west', 'up', 'down'];
const strict = process.argv.includes('--strict');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const only = arg ? plan.zoneOf(Number(arg)) : null;
if (arg && !only) throw new Error(`#${arg} is in no zone`);
const CEILING = { wrongWall: 157, inRoom: 8 };

const total = { exits: 0, wrongWall: 0, inRoom: 0, noDoor: 0, oneWay: 0, oneWayOpen: 0 };
for (const zone of only ? [only] : plan.zones) {
  const layout = layoutZone(world, plan, zone);
  const count = { exits: 0, wrongWall: 0, inRoom: 0, noDoor: 0, oneWay: 0, oneWayOpen: 0 };
  // Archways with no wall of their own: build.js stands them in a corner.
  const freeArch = new Set();
  for (const l of layout.links) {
    if (!l.to || (l.kind !== 'portal' && l.kind !== 'gate')) continue;
    if (l.side === null) freeArch.add(`${l.from.vnum}>${l.to.vnum}`);
    if (l.backSide === null) freeArch.add(`${l.to.vnum}>${l.from.vnum}`);
  }
  const rooms = [...world.rooms.keys()].filter((v) => plan.zoneOf(v) === zone && layout.cells.get(v)).sort((a, b) => a - b);
  for (const v of rooms) {
    const room = world.rooms.get(v);
    const sides = layout.sides.get(v) || [];
    const notes = [];
    room.exits.forEach((ex, d) => {
      if (!ex || d > 3 || plan.zoneOf(ex.to) !== zone || !layout.cells.get(ex.to)) return;
      count.exits++;
      const s = sides[d];
      if (s && s.target && s.target.vnum === ex.to) return;
      const at = sides.findIndex((x) => x && x.target && x.target.vnum === ex.to);
      if (at >= 0) { count.wrongWall++; notes.push(`wrong wall  ${D[d]} to #${ex.to} opens in the ${D[at]} wall (${sides[at].kind})`); }
      else if (freeArch.has(`${v}>${ex.to}`)) { count.inRoom++; notes.push(`in corner   ${D[d]} to #${ex.to} is an archway in a corner, beside another door`); }
      else { count.noDoor++; notes.push(`no door     ${D[d]} to #${ex.to} ${world.rooms.get(ex.to).name}`); }
    });
    sides.forEach((s, d) => {
      if (s && s.target && !room.exits.some((ex) => ex && ex.to === s.target.vnum)) {
        count.oneWay++;
        if (!s.oneWay) count.oneWayOpen++;
        notes.push(`one-way     ${D[d]} wall ${s.oneWay ? 'is a shut gate' : 'opens'} into #${s.target.vnum}, which this room has no exit to${s.oneWay ? '' : ' -- NOT BARRED'}`);
      }
    });
    if (only && notes.length) console.log(`#${v} ${room.name}\n  ${notes.join('\n  ')}`);
  }
  for (const k in count) total[k] += count[k];
  if (!only && (count.wrongWall || count.inRoom || count.noDoor || count.oneWayOpen)) {
    console.log(`${String(zone.name).padEnd(32)} exits ${String(count.exits).padStart(4)}  wrong wall ${String(count.wrongWall).padStart(3)}`
      + `  in corner ${String(count.inRoom).padStart(2)}  no door ${String(count.noDoor).padStart(2)}  one-way ${count.oneWay}${count.oneWayOpen ? ` (${count.oneWayOpen} open)` : ''}`);
  }
}
console.log(`\n${total.exits} exits: ${total.wrongWall} on the wrong wall, ${total.inRoom} archways in a corner, `
  + `${total.noDoor} with no door, ${total.oneWay} one-way openings (${total.oneWayOpen} not barred)`);
if (strict) {
  const faults = [];
  if (total.noDoor) faults.push(`${total.noDoor} exits with no door`);
  if (total.oneWayOpen) faults.push(`${total.oneWayOpen} one-way openings not barred`);
  if (!only && total.wrongWall > CEILING.wrongWall) faults.push(`${total.wrongWall} wrong walls, ceiling ${CEILING.wrongWall}`);
  if (!only && total.inRoom > CEILING.inRoom) faults.push(`${total.inRoom} corner archways, ceiling ${CEILING.inRoom}`);
  if (faults.length) { console.log(`strict: FAIL -- ${faults.join('; ')}`); process.exit(1); }
  console.log('strict: ok');
}
