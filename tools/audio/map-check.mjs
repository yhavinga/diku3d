// Runs src/soundmap.js over every room of the stock world and prints which
// bed, room music and area piece each kind of place gets -- the test for
// the word lists (a regex is only as good as its false positives).
//   node tools/audio/map-check.mjs [bed-id]   # with an id: list its room names
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld } from '../../src/are.js';
import { ambienceFor, roomMusicFor, areaMusicFor, AMBIENCE, creatureOf, placeLoopOf, SOUNDS } from '../../src/soundmap.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'merc21', 'area');
const world = buildWorld(readdirSync(dir).filter((f) => f.endsWith('.are')).sort().map((f) => parseArea(readFileSync(join(dir, f), 'latin1'), f)));
// build.js's isOutdoor, copied because build.js needs three and a browser-shaped import map.
const isOutdoor = (r) => [1, 2, 3, 4, 5, 6, 7, 9, 10].includes(r.sector) && !(r.flags & 8);
const only = process.argv[2];
const loopRooms = {}; const voices = {}; const silent = new Set();
const bedCount = {}; const musicCount = {}; const areaCount = {}; const names = {};
for (const room of world.rooms.values()) {
  const outdoor = isOutdoor(room);
  // Close to build.js's openAir: a FOREST room under the canopy is open air.
  const openAir = outdoor || (room.sector === 3 && !!(room.flags & 8) && !/\b(cave|underground|temple|hall|inside|web|tunnel|sewer)\b/i.test(room.name));
  const p = {
    vnum: room.vnum, areaFile: room.areaFile, sector: room.sector, name: room.name, flags: room.flags,
    outdoor, openAir, floor: null, cave: false, mobs: room.mobs.map((m) => m.proto.keywords), hour: 'noon',
  };
  const loop = placeLoopOf(room, openAir);
  if (loop) (loopRooms[loop.kind] ||= []).push(`${room.areaFile}:${room.name}`);
  for (const m of room.mobs) {
    const rule = creatureOf(`${m.proto.keywords} ${m.proto.short || ''}`);
    if (rule) (voices[rule.id] ||= new Set()).add(m.proto.keywords); else silent.add(m.proto.keywords);
  }
  const a = ambienceFor(p);
  bedCount[a.rule] = (bedCount[a.rule] || 0) + 1;
  (names[a.rule] ||= []).push(`${room.areaFile}:${room.name}`);
  const m = roomMusicFor(p);
  if (m) { musicCount[m.id] = (musicCount[m.id] || 0) + 1; (names[`music:${m.id}`] ||= []).push(`${room.areaFile}:${room.name}`); }
  const ac = areaMusicFor(p) || '(none)';
  areaCount[ac] = (areaCount[ac] || 0) + 1;
}
console.log('ambience rules (rooms):', bedCount);
console.log('room music (rooms):', musicCount);
console.log('area pieces (rooms):', areaCount);
console.log('positional loops (rooms):', Object.fromEntries(Object.entries(loopRooms).map(([k, v]) => [k, v.length])));
if (only === 'loops') for (const [k, v] of Object.entries(loopRooms)) console.log(k, [...new Set(v)].join(' | '));
console.log('creature voices (mob kinds):', Object.fromEntries(Object.entries(voices).map(([k, v]) => [k, v.size])));
if (only === 'voices') for (const [k, v] of Object.entries(voices)) console.log(k, [...v].join(' | '));
if (only === 'silent') console.log([...silent].join('\n'));
for (const [name, def] of Object.entries(SOUNDS)) if (!def.clips.length) console.log(`sound without clips: ${name}`);
for (const r of AMBIENCE) if (!bedCount[r.id]) console.log(`rule never matches: ${r.id}`);
if (only) console.log([...new Set(names[only] || [])].join('\n'));
