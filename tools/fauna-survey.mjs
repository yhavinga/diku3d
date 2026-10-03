// Every mobile in all 45 areas: what body it gets, what voice, how often met.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld, ITEM } from '../src/are.js';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const vendor = pathToFileURL(join(dirname(dirname(fileURLToPath(import.meta.url))), 'vendor', 'three')).href;
register('data:text/javascript,' + encodeURIComponent(`
  const VENDOR = ${JSON.stringify(vendor)};
  export async function resolve(specifier, context, next) {
    if (specifier === 'three') return next(VENDOR + '/build/three.module.js', context);
    if (specifier.startsWith('three/addons/')) return next(VENDOR + '/examples/jsm/' + specifier.slice(13), context);
    return next(specifier, context);
  }
`), import.meta.url);
globalThis.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, addEventListener() {} };
globalThis.self ??= globalThis.window;
globalThis.document ??= { createElement: () => ({ getContext: () => null, style: {}, setAttribute() {} }),
  createElementNS: () => ({ style: {}, setAttribute() {} }), addEventListener() {}, getElementById: () => null,
  querySelector: () => null, body: { appendChild() {} }, hidden: false };
const { personOf } = await import('../src/people.js');
const { beastKind } = await import('../src/actors.js');
const { creatureOf } = await import('../src/soundmap.js');
const { HOME_AREAS } = await import('../src/zones.js');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');
const files = readdirSync(areaDir).filter((f) => f.endsWith('.are')).sort();
const areas = files.map((f) => parseArea(readFileSync(join(areaDir, f), 'latin1'), f));
const world = buildWorld(areas);
const seen = new Map();
for (const room of world.rooms.values()) {
  for (const mob of room.mobs) {
    const s = seen.get(mob.proto.vnum);
    if (s) { s.n++; continue; }
    seen.set(mob.proto.vnum, { proto: mob.proto, area: room.areaFile, n: 1, room: room.vnum });
  }
}
const rows = [];
for (const { proto, area, n, room } of [...seen.values()].sort((a, b) => a.proto.vnum - b.proto.vnum)) {
  const b = beastKind(proto);
  const p = b ? null : personOf(proto, ITEM);
  const body = b ? (b.asset || (b.wisp ? 'wisp' : 'box')) : p ? `${p.file.replace('person_', '')}/${p.arch}` : 'TOWNSPERSON';
  const v = creatureOf(`${proto.keywords} ${proto.short || ''}`);
  rows.push([HOME_AREAS.includes(area) ? 'H' : '-', area.replace('.are', ''), proto.vnum, n, room, body, v ? v.id : '', proto.short.slice(0, 40), proto.keywords]);
}
for (const r of rows) console.log(r.join('\t'));
