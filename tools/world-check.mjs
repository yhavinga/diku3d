// Structural faults in a laid-out world, found without a browser.
//
// This exists because of what the last few review rounds actually cost. The
// checks that were already here catch a syntax slip, a bad .are read and a bad
// walkable percentage -- and every one of the bugs that mattered walked past
// all three. A corridor was routed, walled and roofed to a room that build.js
// then declined to build, and it hung over the town as a black slab for weeks.
// Nothing in the pipeline could have said so, because the fault is not in any
// one file: it is layout.js and build.js disagreeing about which rooms exist.
//
// So the rule here is: only invariants that span two stages, and only ones that
// need no three.js -- are.js and layout.js are pure, which is what makes this
// runnable in node at all. Anything needing real geometry belongs in a browser
// and in tools/judge/shots.md.
//
// Run: node tools/world-check.mjs [area.are ...]
// Exits non-zero if any fault is found, so it can gate a commit.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld, SECTOR, DIR_NAME } from '../src/are.js';
import { layoutWorld } from '../src/layout.js';
import { planZones, layoutZone, HOME_AREAS, HOME_MAX_ROOMS } from '../src/zones.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');
const args = process.argv.slice(2);
const files = args.length ? args
  : readdirSync(areaDir).filter((f) => f.endsWith('.are')).sort();

/**
 * The rooms build.js will not build. Kept as one predicate so this check and
 * build.js can be compared by eye: if that list grows, this has to grow with
 * it, and the whole point is that the two agree.
 */
const isUnbuilt = (room) => room.sector === SECTOR.AIR;

/**
 * Hard invariants: things that are wrong wherever they appear. All four are
 * silent across all 43 stock areas, which is the bar -- a check that reports
 * something on a healthy world teaches everyone to ignore it, and then it is
 * worth less than nothing when it finally has something to say.
 */
const CHECKS = [
  {
    name: 'two rooms in one cell',
    why: 'they would be built inside each other',
    run(world, layout) {
      const seen = new Map();
      const faults = [];
      for (const cell of layout.cells.values()) {
        const k = `${cell.level},${cell.x},${cell.z}`;
        if (seen.has(k)) faults.push(`#${seen.get(k)} and #${cell.vnum} both at ${k}`);
        else seen.set(k, cell.vnum);
      }
      return faults;
    },
  },
  {
    name: 'passage routed through a room',
    why: 'the street would be built straight through somebody\'s floor',
    run(world, layout) {
      const faults = [];
      for (const link of layout.links) {
        if (link.kind !== 'alley' || !link.path) continue;
        for (const c of link.path) {
          const hit = layout.at(link.from.level, c.x, c.z);
          if (hit !== undefined) {
            faults.push(`#${link.from.vnum} -> #${link.to.vnum} crosses #${hit}`);
            break;
          }
        }
      }
      return faults;
    },
  },
  {
    name: 'two exits sharing one wall',
    why: 'CLAUDE.md names this as the failure mode wall sides are allocated '
       + 'once in layout.js to prevent',
    run(world, layout) {
      const faults = [];
      for (const [vnum, sides] of layout.sides) {
        const used = new Map();
        sides.forEach((side, dir) => {
          if (!side) return;
          if (used.has(dir)) faults.push(`#${vnum} ${DIR_NAME[dir]} allocated twice`);
          used.set(dir, side);
        });
      }
      return faults;
    },
  },
  {
    name: 'coordinates that are not finite',
    why: 'a NaN reaches the GPU as geometry that is everywhere and nowhere',
    run(world, layout) {
      const faults = [];
      for (const cell of layout.cells.values()) {
        if ([cell.x, cell.z, cell.level].every(Number.isFinite)) continue;
        faults.push(`#${cell.vnum} at ${cell.level},${cell.x},${cell.z}`);
      }
      return faults;
    },
  },
];

/**
 * Not a fault, but worth a number: layout still routes passages to rooms
 * build.js declines to build, and build.js has to keep declining to build
 * those passages too. If that ever stops being true they come back as
 * corridors hanging in the sky. Counted rather than failed, because the
 * condition is normal and the handling is what matters.
 *
 * Midgaard reports zero here, which is worth knowing: its one airborne room
 * hangs off a portal and a gate, never an alley. A fix aimed at this in
 * build.js does nothing for the default world.
 */
function passagesToUnbuilt(layout) {
  let n = 0;
  for (const link of layout.links) {
    if (link.kind !== 'alley') continue;
    if ([link.from, link.to].some((e) => e && e.room && isUnbuilt(e.room))) n++;
  }
  return n;
}

let total = 0;
let dangling = 0;
const areas = files.map((f) => parseArea(readFileSync(join(areaDir, f), 'latin1'), f));

for (const area of areas) {
  if (!area.rooms.length) continue;
  const world = buildWorld([area]);
  const layout = layoutWorld(world, { startVnum: area.rooms[0].vnum, maxRooms: 600 });
  dangling += passagesToUnbuilt(layout);
  const found = [];
  for (const check of CHECKS) {
    const faults = check.run(world, layout);
    if (faults.length) found.push({ check, faults });
  }
  if (!found.length) continue;
  console.log(`\n${area.file}  (${area.name})`);
  for (const { check, faults } of found) {
    total += faults.length;
    console.log(`  ${check.name} -- ${faults.length}`);
    console.log(`    ${check.why}`);
    for (const f of faults.slice(0, 6)) console.log(`      ${f}`);
    if (faults.length > 6) console.log(`      ... and ${faults.length - 6} more`);
  }
}

// The shipping configuration is a multi-area world, and the per-area passes
// above never exercised it: layout.js runs ONE breadth-first placement over
// the combined graph, a genuinely different path from 43 separate ones (the
// cross-area exits only resolve when both ends are loaded). So the default
// set gets its own pass, with the viewer's own start room and cap.
const DEFAULT_WORLD = ['midgaard.are', 'haon.are', 'shire.are', 'marsh.are',
  'trollden.are', 'grave.are', 'sewer.are', 'eastern.are', 'hood.are'];
// The home zone (src/zones.js), which is what main.js lays out by default.
const MAX_ROOMS = HOME_MAX_ROOMS;
const defaultSet = areas.filter((a) => DEFAULT_WORLD.includes(a.file));
if (defaultSet.length === DEFAULT_WORLD.length) {
  const world = buildWorld(defaultSet);
  const layout = layoutWorld(world, { startVnum: 3001, maxRooms: MAX_ROOMS });
  // What the set actually demands, with the cap lifted. The cap does not fail
  // when it bites, it truncates: the breadth-first walk stops mid-graph, whole
  // areas end up with zero rooms and their exits quietly degrade to gates, and
  // nothing downstream says a word. So the two counts are compared here.
  const uncapped = layoutWorld(world, { startVnum: 3001, maxRooms: Infinity });
  dangling += passagesToUnbuilt(layout);
  const found = [];
  for (const check of CHECKS) {
    const faults = check.run(world, layout);
    if (faults.length) found.push({ check, faults });
  }
  const spare = MAX_ROOMS - uncapped.cells.size;
  console.log(`\none world (${DEFAULT_WORLD.map((f) => f.replace('.are', '')).join('+')}): `
    + `${layout.cells.size} rooms placed, ${uncapped.cells.size} reachable, `
    + `cap ${MAX_ROOMS} (${spare >= 0 ? `${spare} spare` : `${-spare} over`})`);
  if (uncapped.cells.size > MAX_ROOMS) {
    total++;
    console.log(`  room cap exceeded -- ${uncapped.cells.size} reachable against ${MAX_ROOMS}`);
    console.log('    the shipping set is truncated mid-walk: these areas lose rooms');
    for (const area of defaultSet) {
      const placed = area.rooms.filter((r) => layout.cells.has(r.vnum)).length;
      const want = area.rooms.filter((r) => uncapped.cells.has(r.vnum)).length;
      if (placed < want) console.log(`      ${area.file}: ${placed}/${want} rooms placed`);
    }
  }
  for (const { check, faults } of found) {
    total += faults.length;
    console.log(`  ${check.name} -- ${faults.length}`);
    for (const f of faults.slice(0, 6)) console.log(`      ${f}`);
  }
}

// The zones the viewer actually draws (src/zones.js): every area in
// area.lst loaded at once, the home zone laid out from the temple and every
// other zone from its own fixed start, with the rooms a crossing arrives in
// laid down whole if the start cannot walk to them. Three more invariants
// span the zones: each zone's layout is free of the faults above, laying it
// out twice gives the same coordinates (a server and every client must
// agree), and every exit from one zone into another arrives in a room the
// target zone placed.
const listed = readFileSync(join(areaDir, 'area.lst'), 'latin1').split(/\s+/).filter((f) => f.endsWith('.are'));
if (!args.length) {
  const all = listed.map((f) => areas.find((a) => a.file === f) || parseArea(readFileSync(join(areaDir, f), 'latin1'), f));
  const world = buildWorld(all);
  const plan = planZones(world);
  const layouts = new Map();
  let zoneFaults = 0;
  const say = (line) => { zoneFaults++; console.log(`  ${line}`); };
  console.log(`\nzones: ${plan.zones.length} over ${all.length} areas in area.lst, ${plan.crossings.length} crossings`);
  for (const zone of plan.zones) {
    const layout = layoutZone(world, plan, zone);
    layouts.set(zone.id, layout);
    for (const check of CHECKS) {
      for (const fault of check.run(world, layout)) say(`${zone.id}: ${check.name} -- ${fault}`);
    }
    const again = layoutZone(world, plan, zone);
    const moved = [...layout.cells.values()].filter((c) => {
      const d = again.cells.get(c.vnum);
      return !d || d.x !== c.x || d.z !== c.z || d.level !== c.level;
    }).length;
    if (moved || again.cells.size !== layout.cells.size) say(`${zone.id}: laid out twice, ${moved} rooms moved`);
  }
  // The home zone is the default world: same rooms, same coordinates.
  const home = layouts.get(plan.home.id);
  const reference = layoutWorld(buildWorld(all.filter((a) => HOME_AREAS.includes(a.file))), { startVnum: 3001, maxRooms: MAX_ROOMS });
  const differ = [...reference.cells.values()].filter((c) => {
    const d = home.cells.get(c.vnum);
    return !d || d.x !== c.x || d.z !== c.z || d.level !== c.level;
  }).length;
  if (differ || home.cells.size !== reference.cells.size) {
    say(`home zone differs from the nine-area world: ${differ} rooms moved, ${home.cells.size} against ${reference.cells.size}`);
  }
  let sky = 0;
  let stranded = 0;
  for (const c of plan.crossings) {
    const arrival = layouts.get(c.toZone).cells.get(c.to);
    if (!arrival) { say(`#${c.from} ${DIR_NAME[c.dir]} -> #${c.to}: ${c.toZone} did not place its arrival`); continue; }
    // build.js does not build the sky; main.js refuses those crossings.
    if (isUnbuilt(arrival.room)) sky++;
    // A crossing out of a room its own zone never placed cannot be taken.
    if (!layouts.get(c.fromZone).cells.has(c.from)) stranded++;
  }
  console.log(`  every crossing arrives in a placed room; ${sky} into rooms build.js does not build (sector AIR),`
    + ` ${stranded} from rooms their own zone did not place`);
  total += zoneFaults;
}

console.log(total === 0
  ? `no structural faults across ${areas.length} areas`
  : `\n${total} structural fault(s)`);
console.log(`${dangling} passage(s) routed to rooms build.js will skip -- `
  + 'build.js must skip these too (it does, in both alley loops)');
process.exit(total === 0 ? 0 : 1);
