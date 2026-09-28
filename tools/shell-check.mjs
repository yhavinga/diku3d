// The shell vocabulary (src/shells.js) over every stock area.
//
// A room's walls are chosen from its words, and a word only earns its place
// by what it takes across all 45 areas -- `den` in "Gamgee Residence" is the
// kind of thing that only a full count finds. Prints how many walled rooms
// each kind takes per area, every match by name, and with --table a line per
// walled room in the areas named (default: the nine the viewer loads).
//
// With --attrs, what `readShell` reads -- plan, materials and colours, doors,
// water, blood, what is on the walls -- for every walled room in the areas
// named that says anything, with the words it was read from, and a count per
// attribute over all 45.
//
// Run: node tools/shell-check.mjs [--table] [--attrs] [--areas midgaard,haon,...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld, ROOM_INDOORS, SECTOR_NAME } from '../src/are.js';
import { classifyShells, shellFor, SHELL_KINDS, readShell } from '../src/shells.js';

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

if (args.includes('--attrs')) {
  const brief = (a) => {
    const out = [];
    if (a.plan) out.push(`plan ${a.plan}`);
    for (const k of ['wall', 'floor', 'ceil']) {
      const v = a[k];
      if (v) out.push(`${k} ${[v.smooth ? 'smooth' : '', v.colour || '', v.material || ''].filter(Boolean).join(' ')}`);
    }
    a.doors.forEach((d, i) => { if (d) out.push(`door ${'NESW'[i]} ${[d.colour, d.material].filter(Boolean).join(' ')}`); });
    if (a.water) out.push(`${a.water.stuff} ${a.water.depth} m`);
    if (a.gore) out.push(`blood${a.gore.walls ? ' walls' : ''}${a.gore.floor ? ' floor' : ''}`);
    if (a.marks) out.push(`${a.marks.kind}${a.marks.texts.length ? ` "${a.marks.texts.join(' / ').replace(/\s+/g, ' ')}"` : ''}`);
    if (a.named) out.push(`named ${a.named}`);
    if (a.mound) out.push('mound');
    return out.join(', ');
  };
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  console.log('\nshell attributes, walled rooms that say something:');
  for (const room of world.rooms.values()) {
    if (!walled(room)) continue;
    const a = readShell(room);
    if (!a) continue;
    if (a.plan) bump(`plan ${a.plan}`);
    for (const k of ['wall', 'floor', 'ceil']) if (a[k]) bump(`${k} ${a[k].material || a[k].colour}`);
    for (const d of a.doors) if (d) bump(`door ${d.material || d.colour}`);
    if (a.water) bump(`${a.water.stuff} ${a.water.depth}`);
    if (a.gore) bump('blood');
    if (a.marks) bump(a.marks.kind);
    if (a.named) bump(`named ${a.named}`);
    if (a.mound) bump('mound');
    if (!loaded.has(room.areaFile)) continue;
    console.log(`${String(room.vnum).padEnd(5)} ${room.areaFile.replace('.are', '').padEnd(9)} ${room.name.slice(0, 30).padEnd(30)} ${brief(a)}`);
    for (const w of a.why) console.log(`${' '.repeat(47)}| ${w}`);
  }
  console.log('\nper attribute, all 45 areas:');
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${n}`);
}
