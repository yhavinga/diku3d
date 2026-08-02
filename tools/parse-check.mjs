// Smoke test for the .are reader: parse every stock area, report what came out.
// Run: node tools/parse-check.mjs [area-file ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld } from '../src/are.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');
const files = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync(areaDir).filter((f) => f.endsWith('.are')).sort();

const areas = [];
let failed = 0;
for (const file of files) {
  try {
    const area = parseArea(readFileSync(join(areaDir, file), 'latin1'), file);
    areas.push(area);
    console.log(
      `${file.padEnd(16)} ${String(area.name).padEnd(22)} `
      + `rooms ${String(area.rooms.length).padStart(4)}  mobs ${String(area.mobiles.length).padStart(4)}  `
      + `objs ${String(area.objects.length).padStart(4)}  resets ${String(area.resets.length).padStart(4)}`,
    );
  } catch (err) {
    failed++;
    console.log(`${file.padEnd(16)} FAILED  ${err.message}`);
  }
}

const world = buildWorld(areas);
let exits = 0; let offMap = 0; let doors = 0; let mobs = 0; let items = 0;
for (const room of world.rooms.values()) {
  mobs += room.mobs.length;
  items += room.items.length;
  for (const exit of room.exits) {
    if (!exit) continue;
    exits++;
    if (exit.offMap) offMap++;
    if (exit.locks & 1) doors++;
  }
}
console.log(`\n${areas.length} areas parsed, ${failed} failed`);
console.log(`rooms ${world.rooms.size}  exits ${exits} (${offMap} dangling)  doors ${doors}`);
console.log(`reset population: ${mobs} mobs, ${items} objects on the ground`);

const temple = world.rooms.get(3001);
console.log(`\n#3001 ${temple.name} [${temple.area}]`);
console.log(temple.description.trim().split('\n').slice(0, 3).join('\n'));
console.log('exits:', temple.exits.map((e, i) => e && `${'NESWUD'[i]}->${e.to}`).filter(Boolean).join(' '));
console.log('mobs:', temple.mobs.map((m) => m.proto.short).join(', ') || '(none)');
const square = world.rooms.get(3005);
console.log(`\n#3005 ${square.name}: mobs ${square.mobs.map((m) => m.proto.short).join(', ')}`);
console.log(`  items ${square.items.map((o) => o.proto.short).join(', ')}`);
