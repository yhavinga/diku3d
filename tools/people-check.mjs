// What every mobile in the stock areas would be dressed as.
// Run: node tools/people-check.mjs [area ...]   (default: the six the viewer loads)
//      node tools/people-check.mjs --all        (summary over all 45)
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld, ITEM } from '../src/are.js';
import { personOf } from '../src/people.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');
const argv = process.argv.slice(2);
const all = argv.includes('--all');
const only = (argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const pickAreas = argv.filter((a) => !a.startsWith('--'));
const DEFAULT = ['midgaard', 'haon', 'shire', 'marsh', 'trollden', 'grave'];
const files = readdirSync(areaDir).filter((f) => f.endsWith('.are')).sort()
  .filter((f) => all || (pickAreas.length ? pickAreas : DEFAULT).some((a) => f.startsWith(a)));
const areas = files.map((f) => parseArea(readFileSync(join(areaDir, f), 'latin1'), f));
const world = buildWorld(areas);

// One line per distinct mobile, with its equipment and shop as the resets set them.
const seen = new Map();
for (const room of world.rooms.values()) {
  for (const mob of room.mobs) {
    if (seen.has(mob.proto.vnum)) continue;
    seen.set(mob.proto.vnum, { ...mob.proto, equipment: mob.equipment, shop: mob.shop, area: room.area });
  }
}
const counts = {};
for (const proto of [...seen.values()].sort((a, b) => a.vnum - b.vnum)) {
  const p = personOf(proto, ITEM);
  const key = p ? `${p.file}/${p.arch}` : 'not a person';
  counts[key] = (counts[key] || 0) + 1;
  if (only) { if (key.includes(only)) console.log(`${proto.area.padEnd(10)} ${proto.short.slice(0, 34).padEnd(34)} [${proto.keywords}]`); continue; }
  if (!p) { if (!all) console.log(`${String(proto.vnum).padStart(5)} ${proto.short.slice(0, 30).padEnd(30)} -- not a person  [${proto.keywords}]`); continue; }
  if (!all) {
    console.log(`${String(proto.vnum).padStart(5)} ${proto.short.slice(0, 30).padEnd(30)} ${key.padEnd(24)}`
      + ` s${p.scale.toFixed(2)} ${(p.weapon || '-').replace('weapon_', '').padEnd(6)} ${(p.shield || '-').replace('shield_', '').padEnd(5)}`
      + ` ${p.pieces.join(',')}  [${proto.keywords}]`);
  }
}
console.log('\n' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('\n'));
