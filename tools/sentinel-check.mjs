/**
 * A fighting sentinel steps out to its foe and goes home afterwards.
 *
 * src/game.js used to give an ACT_SENTINEL mobile only a `face` order in a
 * fight, so anyone between MELEE (3.2 m) and BREAK (14 m) of one could cast at
 * it for ever and never be struck. The rule now: it steps out as far from its
 * post as SENTRY and never out of its room; at either limit with the foe still
 * out of reach it breaks the fight off and walks home (a new cast starts a
 * new one). Headless, over Mahn-Tor's stub geometry, the Minotaur Guard #2316
 * in #2362.
 *
 *     node tools/sentinel-check.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseArea, buildWorld, SECTOR, ROOM_INDOORS } from '../src/are.js';
import { layoutWorld } from '../src/layout.js';
import { createGame, POS } from '../src/game.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 13;
const LEVEL_H = 7.6;
const OUTDOOR = new Set([SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS, SECTOR.MOUNTAIN,
  SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT, SECTOR.AIR]);

const text = readFileSync(join(root, 'merc21/area/mahntor.are'), 'utf8');
const world = buildWorld([parseArea(text, 'mahntor.are')]);
const layout = layoutWorld(world, { startVnum: [...world.rooms.keys()][0], maxRooms: 400 });
const built = { rooms: new Map(), colliders: [], portals: [] };
for (const [vnum, cell] of layout.cells) {
  const room = world.rooms.get(vnum);
  built.rooms.set(vnum, {
    room, cell,
    center: { x: cell.x * CELL, y: cell.level * LEVEL_H, z: cell.z * CELL },
    outdoor: OUTDOOR.has(room.sector) && !(room.flags & ROOM_INDOORS),
    materials: {},
  });
}

let failed = 0;
const check = (ok, name, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed++;
};

const ROOM = 2362; const VNUM = 2316;
const DT = 0.05;

/** A fresh game, a level-30 mage `off` metres south of the guard, and the guard woken. */
function stage(seed, off = 9) {
  const game = createGame({ world, layout, built, seed, classIndex: 0 });
  const slot = game.mobs.find((s) => s.proto.vnum === VNUM && s.roomVnum === ROOM);
  if (!slot) throw new Error(`sentinel-check: no #${VNUM} reset in #${ROOM}`);
  if (!(slot.proto.act & 2)) throw new Error('sentinel-check: #2316 is not ACT_SENTINEL');
  const me = { x: slot.pos.x, y: slot.pos.y + 1.72, z: slot.pos.z + off };
  const look = { x: 0, y: 0, z: -1 };
  game.grace(0);
  game.update(DT, me, look);
  Object.assign(game.state, { level: 30, mana: 9000, maxMana: 9000, hit: 5000, maxHit: 5000 });
  game.state.learned['lightning bolt'] = 99;
  slot.instance.hit = slot.instance.maxHit = 99999;
  const feet = () => ({ x: me.x, z: me.z });
  const dist = () => Math.hypot(slot.pos.x - me.x, slot.pos.z - me.z);
  const post = () => Math.hypot(slot.pos.x - slot.anchor.x, slot.pos.z - slot.anchor.z);
  return { game, slot, me, look, feet, dist, post };
}

console.log('\nA SENTINEL STEPS OUT');
{
  const { game, slot, me, look, dist, post } = stage(5);
  const hp0 = game.state.hit;
  const rooms = new Set();
  game.cast('lightning bolt', { target: game.wakeSlot(slot) });
  let struck = 0; let t = 0;
  while (t < 20) {
    game.update(DT, me, look); t += DT; rooms.add(slot.roomVnum);
    if (game.state.hit < hp0 && !struck) struck = t;
  }
  check(slot.instance.fighting || struck, 'it fights');
  check(struck > 0 && struck < 12, 'it closes from 9 m and lands a blow', `first damage to the caster at ${struck.toFixed(1)} s, now ${dist().toFixed(1)} m away`);
  check(rooms.size === 1, 'it never changes room', [...rooms].join(','));
  // The caster dies or flees: the minotaur walks home.
  game.state.hit = -20;
  me.z += 40; me.x += 40;
  let home = null;
  for (let u = 0; u < 40; u += DT) {
    game.update(DT, me, look);
    rooms.add(slot.roomVnum);
    if (home === null && post() < 0.5) home = u;
  }
  check(home !== null && home < 15, 'afterwards it is back within 0.5 m of its post', home === null ? `still ${post().toFixed(1)} m out` : `after ${home.toFixed(1)} s`);
  check(rooms.size === 1 && slot.roomVnum === ROOM, 'in the same room throughout');
}

console.log('\nA CASTER WHO KEEPS OUT OF REACH');
{
  // Out of reach of wherever the guard can get to, standing still, casting again each time the fight has ended: the
  // guard comes out as far as its room or SENTRY allows, finds it cannot reach,
  // gives the fight up and goes home -- and the next cast brings it out again.
  const { game, slot, me, look, dist, post } = stage(6, 13.6);
  const hp0 = game.state.hit;
  const rooms = new Set();
  let breaks = 0; let casts = 0; let maxOut = 0; let was = false;
  const target = game.wakeSlot(slot);
  for (let t = 0; t < 60; t += DT) {
    if (!slot.instance.fighting && post() < 0.5 && Math.round(t / DT) % 100 === 0) { game.cast('lightning bolt', { target }); casts++; }
    game.update(DT, me, look);
    rooms.add(slot.roomVnum);
    maxOut = Math.max(maxOut, post());
    const now = !!slot.instance.fighting;
    if (was && !now) breaks++;
    was = now;
  }
  check(casts >= 2 && breaks >= 2, 'each cast starts a fight and it breaks off again', `${casts} casts, ${breaks} break-offs`);
  check(game.state.hit === hp0, 'the guard never reached the caster', `${hp0 - game.state.hit} damage taken`);
  check(maxOut > 2, 'but it did come out to look', `${maxOut.toFixed(1)} m from its post, caster ${dist().toFixed(1)} m`);
  check(maxOut <= 11.0 + 0.2, 'no further than SENTRY from its post', `${maxOut.toFixed(1)} m`);
  check(rooms.size === 1, 'never out of its room', [...rooms].join(','));
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
