/**
 * The dracolich (#5010) gets up before anyone strikes, and strikes first.
 *
 * It lies as a heap of bones and rises over RISE_SECONDS when a fight starts.
 * Nobody's melee lands on the heap meanwhile (spells still do), and the moment
 * it is up it makes its first round at once, rather than at the next pulse --
 * so the group never gets in a blow before the thing they woke. Headless, over
 * eastern's stub geometry, a level-30 warrior in #5011.
 *
 *     node tools/rise-check.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseArea, buildWorld, SECTOR, ROOM_INDOORS } from '../src/are.js';
import { layoutWorld } from '../src/layout.js';
import { createGame } from '../src/game.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 13;
const LEVEL_H = 7.6;
const OUTDOOR = new Set([SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS, SECTOR.MOUNTAIN,
  SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT, SECTOR.AIR]);

const text = readFileSync(join(root, 'merc21/area/eastern.are'), 'utf8');
const world = buildWorld([parseArea(text, 'eastern.are')]);
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

const ROOM = 5011; const VNUM = 5010;
const DT = 0.05;
const RISE = 4.0;

console.log('\nTHE DRACOLICH STRIKES FIRST');
for (const seed of [1, 2, 3]) {
  const game = createGame({ world, layout, built, seed, classIndex: 3 });
  const slot = game.mobs.find((s) => s.proto.vnum === VNUM && s.roomVnum === ROOM);
  if (!slot) throw new Error(`rise-check: no #${VNUM} reset in #${ROOM}`);
  const me = { x: slot.pos.x, y: slot.pos.y + 1.72, z: slot.pos.z + 2 };
  const look = { x: 0, y: 0, z: -1 };
  game.grace(0);
  game.update(DT, me, look);
  Object.assign(game.state, { level: 30, hit: 90000, maxHit: 90000, hitroll: 100, damroll: 20 });
  const mob = game.wakeSlot(slot);
  mob.hit = mob.maxHit = 90000;
  const hp0 = game.state.hit; const mob0 = mob.hit;
  game.attackSlot(slot);
  let t = 0; let mine = null; let theirs = null; let hurtDuring = false;
  // The clock the rise runs on is the game's own; t counts from the attack.
  let riseEnd = null;
  for (; t < 40; t += DT) {
    game.update(DT, me, look);
    if (riseEnd === null && t + DT >= RISE - 1e-9) riseEnd = t + DT;
    const heapHit = mob.hit < mob0; const meHit = game.state.hit < hp0;
    if (heapHit && mine === null) mine = t;
    if (meHit && theirs === null) theirs = t;
    if (riseEnd === null && (heapHit || meHit)) hurtDuring = true;
    if (mine !== null && theirs !== null) break;
  }
  console.log(`  seed ${seed}: rise ended ${riseEnd?.toFixed(2)} s, dracolich first blow ${theirs?.toFixed(2)} s, warrior first blow ${mine?.toFixed(2)} s`);
  check(riseEnd !== null && Math.abs(riseEnd - RISE) < 0.3, 'the rise lasts its four seconds');
  check(!hurtDuring, 'no blow from either side lands during the rise');
  check(theirs !== null && riseEnd !== null && theirs - riseEnd <= 0.1 + 1e-9, 'its first blow comes within 0.1 s of the rise ending', theirs === null ? 'never' : `${(theirs - riseEnd).toFixed(2)} s after`);
  check(mine !== null && theirs !== null && mine > theirs, 'the warrior\'s first blow comes after it');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
