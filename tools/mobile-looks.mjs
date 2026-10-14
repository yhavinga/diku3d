// personOf over every mobile of all areas (3 instances each) as JSON, to diff before/after a change.
// node tools/mobile-looks.mjs <worktree> <out.json>, then cmp two outputs: a change for players must leave this byte-identical.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
const { parseArea, buildWorld, ITEM } = await import(join(root, 'src/are.js'));
const { personOf } = await import(join(root, 'src/people.js'));
const areaDir = join(root, 'merc21', 'area');
const areas = readdirSync(areaDir).filter((f) => f.endsWith('.are')).sort().map((f) => parseArea(readFileSync(join(areaDir, f), 'latin1'), f));
const world = buildWorld(areas);
const seen = new Map();
for (const room of world.rooms.values()) for (const mob of room.mobs) {
  if (!seen.has(mob.proto.vnum)) seen.set(mob.proto.vnum, { ...mob.proto, equipment: mob.equipment, shop: mob.shop, area: room.area });
}
const out = [];
for (const proto of [...seen.values()].sort((a, b) => a.vnum - b.vnum)) for (const i of [0, 1, 2]) out.push([proto.vnum, i, personOf(proto, ITEM, i)]);
writeFileSync(process.argv[3], JSON.stringify(out));
console.log(seen.size, 'protos', out.length, 'calls');
