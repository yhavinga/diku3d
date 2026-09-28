// What the prose puts in each room (src/clutter.js `readClutter`), read over
// the stock areas. Prints every room that asks for something, the words it
// was read from, and a count per kind for the default nine and for all 45 --
// a vocabulary is only as good as its reject list, and this is where a word
// used the other way turns up.
//
// Run: node tools/clutter-check.mjs            the nine default areas, room by room
//      node tools/clutter-check.mjs --all      all 45, room by room
//      node tools/clutter-check.mjs --kind web every match of one kind, all 45
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld } from '../src/are.js';
import { readClutter } from '../src/clutter.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');
const NINE = ['midgaard', 'haon', 'shire', 'marsh', 'trollden', 'grave', 'sewer', 'eastern', 'hood'];
const args = process.argv.slice(2);
const kindArg = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : null;
const everything = args.includes('--all') || !!kindArg;

const load = (names) => {
  const areas = names.map((n) => {
    const area = parseArea(readFileSync(join(areaDir, `${n}.are`), 'latin1'), `${n}.are`);
    for (const r of area.rooms) r.file = n;
    return area;
  });
  return buildWorld(areas);
};
const all = readdirSync(areaDir).filter((f) => f.endsWith('.are')).map((f) => f.slice(0, -4)).sort();
const tally = (world) => {
  const counts = new Map();
  for (const room of world.rooms.values()) {
    for (const r of readClutter(room)) counts.set(r.kind, (counts.get(r.kind) || 0) + 1);
  }
  return counts;
};

const world = load(everything ? all : NINE);
let rooms = 0;
for (const room of world.rooms.values()) {
  const asks = readClutter(room).filter((r) => !kindArg || r.kind === kindArg);
  if (!asks.length) continue;
  rooms++;
  if (kindArg) {
    for (const r of asks) console.log(`${room.file}#${room.vnum} ${room.name} x${r.count}${r.dir !== null ? ` wall ${r.dir}` : ''} | ${r.why}`);
    continue;
  }
  console.log(`${room.file}#${room.vnum} ${room.name}`);
  for (const r of asks) {
    console.log(`   ${r.kind.padEnd(17)} x${r.count} ${r.at.padEnd(6)}${r.dir !== null ? ` wall ${r.dir}` : ''}  | ${r.why.slice(0, 150)}`);
  }
}
if (!kindArg) {
  const nine = tally(load(NINE));
  const every = tally(load(all));
  console.log(`\n${rooms} rooms ask for something. rooms per kind, nine default areas / all 45:`);
  for (const [kind, n] of [...every].sort((a, b) => (nine.get(b[0]) || 0) - (nine.get(a[0]) || 0) || b[1] - a[1])) {
    console.log(`  ${kind.padEnd(17)} ${String(nine.get(kind) || 0).padStart(4)} / ${String(n).padStart(4)}`);
  }
}
