/**
 * Does every exit the mud names have a doorway on the wall it names?
 *
 *   node tools/exit-check.mjs          # one line per zone with a fault
 *   node tools/exit-check.mjs 3700     # every room of the zone that holds #3700
 *
 * Three kinds of fault, all read from the layout (`layout.sides`), which is
 * where build.js takes its doorways from:
 *   wrong wall  the exit has an opening, but on another wall than its direction
 *               (sometimes forced: the graph is not Euclidean, see CLAUDE.md)
 *   no door     the exit has no opening in this room at all -- an archway drawn
 *               only at the other end, or a link the layout could not make
 *   one-way     an opening into a room this room has no exit to (the mud's own
 *               one-way exits, like the Mud School entrance into the arena)
 * Up and down are not checked here: they are stairs or archways, not walls.
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
const only = process.argv[2] ? plan.zoneOf(Number(process.argv[2])) : null;
if (process.argv[2] && !only) throw new Error(`#${process.argv[2]} is in no zone`);

const total = { exits: 0, wrongWall: 0, noDoor: 0, oneWay: 0 };
for (const zone of only ? [only] : plan.zones) {
  const layout = layoutZone(world, plan, zone);
  const count = { exits: 0, wrongWall: 0, noDoor: 0, oneWay: 0 };
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
      else { count.noDoor++; notes.push(`no door     ${D[d]} to #${ex.to} ${world.rooms.get(ex.to).name}`); }
    });
    sides.forEach((s, d) => {
      if (s && s.target && !room.exits.some((ex) => ex && ex.to === s.target.vnum)) {
        count.oneWay++; notes.push(`one-way     ${D[d]} wall opens into #${s.target.vnum}, which this room has no exit to`);
      }
    });
    if (only && notes.length) console.log(`#${v} ${room.name}\n  ${notes.join('\n  ')}`);
  }
  for (const k in count) total[k] += count[k];
  if (!only && (count.wrongWall || count.noDoor)) {
    console.log(`${String(zone.name).padEnd(32)} exits ${String(count.exits).padStart(4)}  wrong wall ${String(count.wrongWall).padStart(3)}  no door ${String(count.noDoor).padStart(2)}  one-way ${count.oneWay}`);
  }
}
console.log(`\n${total.exits} exits: ${total.wrongWall} on the wrong wall, ${total.noDoor} with no door, ${total.oneWay} one-way openings`);
