// The shell vocabulary (src/shells.js) over every stock area.
//
// A room's walls are chosen from its words, and a word only earns its place
// by what it takes across all 45 areas -- `den` in "Gamgee Residence" is the
// kind of thing that only a full count finds. Prints how many walled rooms
// each kind takes per area, every match by name, and with --table a line per
// walled room in the areas named (default: the nine the viewer loads).
//
// Run: node tools/shell-check.mjs [--table] [--areas midgaard,haon,...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld, ROOM_INDOORS, SECTOR_NAME } from '../src/are.js';
import { classifyShells, shellFor, SHELL_KINDS } from '../src/shells.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');
const args = process.argv.slice(2);
const table = args.includes('--table');
const pick = args.includes('--areas') ? args[args.indexOf('--areas') + 1]
  : 'midgaard,haon,shire,marsh,trollden,grave,sewer,eastern,hood';
const loaded = new Set(pick.split(',').map((a) => `${a}.are`));

const files = readdirSync(areaDir).filter((f) => f.endsWith('.are')).sort();
const areas = [];
for (const file of files) {
  try { areas.push(parseArea(readFileSync(join(areaDir, file), 'latin1'), file)); } catch { /* parse-check reports these */ }
}
const world = buildWorld(areas);
// Walled: what build.js builds with walls unless its own words say otherwise.
const walled = (r) => r.sector === 0 || !!(r.flags & ROOM_INDOORS);

classifyShells(world, walled);
const byKind = new Map(SHELL_KINDS.map((k) => [k, []]));
const perArea = new Map();
let rooms = 0;
for (const room of world.rooms.values()) {
  if (!walled(room)) continue;
  rooms++;
  const shell = shellFor(room);
  if (!shell) continue;
  byKind.get(shell.kind).push(room);
  const row = perArea.get(room.areaFile) || {};
  row[shell.kind] = (row[shell.kind] || 0) + 1;
  perArea.set(room.areaFile, row);
}
console.log(`${rooms} walled rooms in ${areas.length} areas`);
for (const [kind, list] of byKind) {
  const names = new Map();
  for (const r of list) names.set(`${r.name} [${r.areaFile.replace('.are', '')}]`, (names.get(`${r.name} [${r.areaFile.replace('.are', '')}]`) || 0) + 1);
  console.log(`\n${kind}: ${list.length}`);
  console.log('  ' + [...names].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join('; '));
}
if (table) {
  console.log('\nvnum  area       sector    shell       name');
  for (const room of world.rooms.values()) {
    if (!loaded.has(room.areaFile) || !walled(room)) continue;
    const shell = shellFor(room);
    const kind = shell ? `${shell.kind}${shell.vast ? '+vast' : ''}` : '-';
    console.log(`${String(room.vnum).padEnd(5)} ${room.areaFile.replace('.are', '').padEnd(10)} ${String(SECTOR_NAME[room.sector]).padEnd(9)} ${kind.padEnd(11)} ${room.name}`);
  }
}
