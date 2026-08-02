// How well does an area survive being forced onto a grid? Reports how many
// exits stay real passages versus how many degrade to archways.
// Run: node tools/layout-check.mjs [start-vnum] [area.are ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld } from '../src/are.js';
import { layoutWorld } from '../src/layout.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');

const args = process.argv.slice(2);
const start = Number(args[0]) || 3001;
const files = args.length > 1 ? args.slice(1)
  : readdirSync(areaDir).filter((f) => f.endsWith('.are')).sort();

const single = args.length > 1;
const areas = files.map((f) => parseArea(readFileSync(join(areaDir, f), 'latin1'), f));

if (single) {
  const world = buildWorld(areas);
  const layout = layoutWorld(world, { startVnum: start, maxRooms: 600 });
  report(files.join(' + '), layout);
} else {
  // Each area laid out on its own, starting from its first room.
  for (const area of areas) {
    if (!area.rooms.length) continue;
    const world = buildWorld([area]);
    const layout = layoutWorld(world, { startVnum: area.rooms[0].vnum, maxRooms: 600 });
    report(`${area.file} (${area.name})`, layout, area.rooms.length);
  }
}

function report(label, layout, total) {
  const s = layout.stats;
  const linked = s.alleys + s.stairs + s.portals;
  const share = linked ? ((s.alleys + s.stairs) / linked) * 100 : 100;
  console.log(
    `${label.padEnd(34)} placed ${String(s.placed).padStart(3)}`
    + `${total ? `/${String(total).padEnd(3)}` : '    '}`
    + `  passages ${String(s.alleys).padStart(3)}`
    + `  stairs ${String(s.stairs).padStart(2)}`
    + `  archways ${String(s.portals).padStart(3)}  gates ${String(s.gates).padStart(3)}`
    + `  → ${share.toFixed(0)}% walkable`,
  );
}
