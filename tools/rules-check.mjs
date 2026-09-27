/**
 * Assertions for the rest of the Merc port (src/rules/*, src/save.js): area
 * resets, conditions, containers and corpses, doors and keys, decay, the
 * spec_funs, the command line, and a save/load round trip -- all over the
 * default six areas, headless, under plain node.
 *
 *     node tools/rules-check.mjs
 *
 * Exits non-zero if any assertion fails.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { parseArea, buildWorld, SECTOR, ROOM_INDOORS, ITEM, EX_CLOSED, EX_LOCKED } from '../src/are.js';
import { layoutWorld } from '../src/layout.js';
import { createGame, POS, WEAR } from '../src/game.js';
import { installSave, serialize } from '../src/save.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['midgaard', 'haon', 'shire', 'marsh', 'trollden', 'grave'];
const world = buildWorld(FILES.map((f) => parseArea(readFileSync(join(root, 'merc21/area', `${f}.are`), 'utf8'), `${f}.are`)));
const layout = layoutWorld(world, { startVnum: 3001, maxRooms: 400 });
const CELL = 13;
const LEVEL_H = 7.6;
const OUTDOOR = new Set([SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS, SECTOR.MOUNTAIN,
  SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT, SECTOR.AIR]);
const built = { rooms: new Map(), colliders: [], portals: [] };
for (const [vnum, cell] of layout.cells) {
  const room = world.rooms.get(vnum);
  built.rooms.set(vnum, {
    room, cell, center: { x: cell.x * CELL, y: cell.level * LEVEL_H, z: cell.z * CELL },
    outdoor: OUTDOOR.has(room.sector) && !(room.flags & ROOM_INDOORS), materials: {},
  });
}

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

/** A fresh game, a transcript of what it said, and a way to stand somewhere. */
function fresh(classIndex = 3, seed = 7) {
  const game = createGame({ world, layout, built, seed, classIndex });
  const said = [];
  game.listen((e) => { if (e.text) said.push(e.text); });
  const eye = { x: 0, y: 0, z: 0 };
  const look = { x: 0, y: 0, z: -1 };
  const stand = (vnum, dx = 0.4, dz = 0.4) => {
    const c = built.rooms.get(vnum).center;
    eye.x = c.x + dx; eye.y = c.y + 1.72; eye.z = c.z + dz;
    game.update(0.02, eye, look);
  };
  const run = (seconds, dt = 0.05) => { for (let t = 0; t < seconds; t += dt) game.update(dt, eye, look); };
  const say = (line) => { said.length = 0; game.interpret(line); return said.join(' | '); };
  const obj = (vnum) => game.MERC.createObject(world.objProtos.get(vnum), 1);
  return { game, said, stand, run, say, obj, eye, look };
}

// ------------------------------------------------------------ interp.c --
console.log('\nTHE COMMAND LINE');
{
  const t = fresh();
  t.stand(3001);
  check(t.say('l').startsWith('The Temple Of Midgaard'), "'l' is look", t.say('l').slice(0, 40));
  check(/You are carrying/.test(t.say('i')), "'i' is inventory");
  check(t.say('xyzzy') === 'Huh?', 'an unknown word is Huh?');
  check(/perfect match|Death will thank/.test(t.say('con executioner')), 'consider reads the level gap');
  check(/You smile/.test(t.say('smile')), 'the socials are there', `${t.say('socials').split('|').length} lines of them`);
  t.game.state.position = POS.SLEEPING;
  check(t.say('look') === 'In your dreams, or what?', 'position gates a command the way interp.c does');
  check(t.say('score').startsWith('You are'), '...and lets through one that needs no position');
  t.game.state.position = POS.STANDING;
}

// ------------------------------------------------------------ doors ------
console.log('\nDOORS AND KEYS');
{
  const t = fresh();
  t.stand(3142);   // the captain's office: its south door is the jail, key 3137
  const exit = world.rooms.get(3142).exits[2];
  const back = world.rooms.get(3143).exits[0];
  check((exit.locks & EX_LOCKED) && (exit.locks & EX_CLOSED), 'the jail door is shut and locked by its D reset');
  check(t.say('open s') === "It's locked.", 'open a locked door: "It\'s locked."');
  check(t.say('unlock door') === 'You lack the key.', 'unlock without the key: "You lack the key."');
  t.game.state.inventory.push(t.obj(3137));
  check(/lack the key/.test(t.say('unlock door')), "'door' finds the first door, east, as find_door does -- its key is 3120");
  check(/Click/.test(t.say('unlock s')), 'unlock with the key carried: *Click*');
  check(!(exit.locks & EX_LOCKED) && !(back.locks & EX_LOCKED), 'unlocking unlocks both sides');
  t.say('open s');
  check(!(exit.locks & EX_CLOSED) && !(back.locks & EX_CLOSED), 'opening opens both sides');
  t.say('close s');
  t.say('lock s');
  check((exit.locks & EX_LOCKED) && (back.locks & EX_LOCKED), 'lock with the key locks it again');
  t.game.state.inventory.length = 0;
  const r = t.game.useDoor(3142, 2);
  check(!r.ok && /locked/.test(r.text), 'E on a locked door without its key refuses and says why', r.text);
  t.game.state.inventory.push(t.obj(3137));
  const r2 = t.game.useDoor(3142, 2);
  check(r2.ok && !(exit.locks & EX_CLOSED), 'E on it with the key unlocks and opens', r2.text);

  // pick lock: a thief with the skill, no key -- and the captain in the room.
  const thief = fresh(2);
  thief.stand(3142);
  thief.game.state.level = 30;
  thief.game.state.learned.pickLock = 100;
  thief.game.forceLocks();
  check(!(world.rooms.get(3142).exits[1].locks & EX_LOCKED), 'G forces every lock');
}

// ------------------------------------------------------ containers --------
console.log('\nCONTAINERS AND CORPSES');
{
  const t = fresh();
  t.stand(3142);
  const desk = t.game.ground.find((o) => o.vnum === 3130);
  check(!!desk && desk.contains.length === 1, 'the captain\'s desk is laid out with a key in it',
    desk ? desk.contains.map((o) => o.name).join(', ') : 'no desk');
  t.eye.x = desk.at.x + 1.2; t.eye.z = desk.at.z; t.game.update(0.02, t.eye, t.look);
  check(t.say('get key desk') === 'The desk is closed.', 'a closed container keeps its contents');
  t.game.state.inventory.push(t.obj(3122));
  t.say('unlock desk');
  t.say('open desk');
  t.say('get key desk');
  check(t.game.state.inventory.some((o) => o.vnum === 3123), 'unlock, open, get key desk', t.said.join(' | '));
  const bag = t.obj(3032);
  t.game.state.inventory.push(bag, t.obj(3009));
  t.say('put pie bag');
  check(bag.contains.length === 1, 'put pie bag', t.said.join(' | '));
  t.say('get pie bag');
  check(bag.contains.length === 0 && t.game.state.inventory.some((o) => o.vnum === 3009), 'get pie bag');
}

// --------------------------------------------------------- conditions ----
console.log('\nHUNGER, THIRST, REGENERATION');
{
  const t = fresh();
  t.stand(3001);
  const s = t.game.state;
  check(s.condition[1] === 48 && s.condition[2] === 48, 'a new character is fed and watered');
  s.condition[1] = 1;
  s.condition[2] = 1;
  s.hit = 1;
  t.run(31);
  check(t.said.includes('You are hungry.') && t.said.includes('You are thirsty.'), 'a tick at 1 says hungry and thirsty');
  const fed = t.game.MERC.hitGain;
  s.hit = 1;
  const starving = fed(s);
  s.condition[1] = 20; s.condition[2] = 20;
  check(fed(s) >= starving * 3, 'hunger and thirst each halve hit_gain', `${starving} starving vs ${fed(s)} fed`);
  s.condition[1] = 0;
  t.game.state.inventory.push(t.obj(3009));
  check(/no longer hungry/.test(t.say('eat pie')), 'eat pie: "You are no longer hungry."', t.said.join(' | '));
  t.stand(3005);
  s.condition[2] = 0;
  const fountain = t.game.ground.find((o) => o.itemType === ITEM.FOUNTAIN && o.inRoom === 3005);
  t.eye.x = fountain.at.x + 1.5; t.eye.z = fountain.at.z; t.game.update(0.02, t.eye, t.look);
  check(/not thirsty/.test(t.say('drink')), 'drink at the Temple Square fountain', t.said.join(' | '));
  check(s.condition[2] === 48, 'the fountain fills you to 48');
  const skin = t.obj(3138);
  skin.values[1] = 0;
  t.game.state.inventory.push(skin);
  t.say('fill skin');
  check(skin.values[1] === skin.values[0], 'fill a water skin at the fountain', t.said.join(' | '));
  s.condition[0] = 12;
  check(/Hic/.test(t.say('drink skin')), 'too drunk to drink: *Hic*');
  const torch = t.obj(3030);
  torch.values[2] = 1;
  t.game.state.inventory.push(torch);
  t.say('hold torch');
  t.run(31);
  check(!t.game.state.equipment[WEAR.LIGHT] && t.said.some((l) => /goes out/.test(l)), 'a torch burns down and goes out');
}

// ------------------------------------------------------ death and decay --
console.log('\nCORPSES, DECAY, AND RESETS');
{
  const t = fresh(3, 11);
  const prey = t.game.mobs.find((s) => s.proto.vnum === 3066);   // an alley cat
  const home = prey.originRoom;
  t.stand(home);
  const mob = t.game.MERC.createMobile(prey.proto, 1, new t.game.MERC.Rng(1));
  void mob;
  const cat = t.game.mobs.find((s) => s === prey);
  t.eye.x = cat.pos.x + 1.4; t.eye.z = cat.pos.z; t.game.update(0.02, t.eye, t.look);
  t.game.state.level = 20;
  t.game.state.hitroll = 30;
  t.game.state.damroll = 40;
  t.game.attackSlot(cat);
  t.run(20);
  check(cat.dead, 'kill an alley cat');
  const corpse = t.game.ground.find((o) => o.itemType === ITEM.CORPSE_NPC);
  check(!!corpse && corpse.name === 'corpse of an alley cat', 'make_corpse: "corpse of an alley cat"', corpse && corpse.name);
  corpse.contains.push(t.obj(3009));
  const area = t.game.areas.find((a) => a.name === world.rooms.get(home).area);
  t.game.resetArea(area.name);
  check(cat.dead, 'the line does not refill while its body is still lying there');
  for (let i = 0; i < 5; i++) t.game.MERC && t.run(30.2);
  check(!t.game.ground.includes(corpse), 'the corpse decays into dust within four ticks',
    t.said.filter((l) => /dust/.test(l)).join(' | '));
  // ...unless the vagabond who scavenges the Dark Alley has had it since.
  const pie = t.game.ground.find((o) => o.vnum === 3009 && o.inRoom !== null)
    || t.game.mobs.find((m) => m.instance && m.instance.inventory.some((o) => o.vnum === 3009));
  check(!!pie, 'and what was in it is left on the floor', pie && pie.inRoom ? 'on the floor' : 'scavenged');
  t.game.resetArea(area.name);
  check(!cat.dead && !!cat.instance, 'area reset brings the alley cat back');
  check(!!cat.task && cat.task.kind === 'arrive', 'and it walks in from a way into the room');
  // Objects: take the mushroom in #6006 and the reset puts another there.
  const t2 = fresh();
  t2.stand(3001);
  const shroom = () => t2.game.ground.filter((o) => o.vnum === 6011 && o.inRoom === 6006);
  check(shroom().length === 1, 'the reset laid a mushroom in #6006');
  t2.game.objFromRoom ? null : null;
  const taken = shroom()[0];
  t2.game.ground.splice(t2.game.ground.indexOf(taken), 1);
  taken.inRoom = null;
  const haon = world.rooms.get(6006).area;
  t2.game.resetArea(haon);
  check(shroom().length === 1, 'an empty area resets its objects', `${shroom().length}`);
  const doorExit = world.rooms.get(6009).exits[0];
  doorExit.locks &= ~EX_CLOSED;
  t2.game.resetArea(haon);
  check(!!(doorExit.locks & EX_CLOSED), 'and shuts its doors to their D state');
}

// --------------------------------------------------------- spec_funs ----
console.log('\nSPEC_FUNS');
{
  const t = fresh();
  const spec = t.game.specFuns;
  check(['spec_guard', 'spec_janitor', 'spec_fido', 'spec_thief', 'spec_executioner', 'spec_mayor']
    .every((n) => typeof spec[n] === 'function'), 'the six non-magic spec_funs are registered');
  // The mayor: set the mud clock to eight in the evening and let him walk.
  const mayor = t.game.mobs.find((s) => s.record.special === 'spec_mayor');
  t.stand(3014);
  t.game.setMudHour(20);
  const gateE = world.rooms.get(3041).exits[1];
  let saidClosed = false;
  for (let i = 0; i < 20 * 60 * 4 && !(gateE.locks & EX_LOCKED); i++) {
    t.game.update(0.25, t.eye, t.look);
    if (t.game.weather().hour !== 20) t.game.setMudHour(20);
    saidClosed = saidClosed || t.said.some((l) => /closed!/.test(l));
  }
  check(!!(gateE.locks & EX_CLOSED) && !!(gateE.locks & EX_LOCKED), 'the mayor closes and locks the east gate at 20:00',
    `at #${mayor.roomVnum}, path at ${t.game.mayorState().pos}`);
  // The janitor: drop a bottle in his room and wait.
  const janitor = t.game.mobs.find((s) => s.record.special === 'spec_janitor');
  t.stand(janitor.roomVnum);
  const bottle = t.obj(3001);
  const at = { ...janitor.pos, x: janitor.pos.x + 2 };
  t.game.ground.push(Object.assign(bottle, { inRoom: janitor.roomVnum, at }));
  for (let i = 0; i < 400 && bottle.inRoom !== null; i++) t.game.update(0.1, t.eye, t.look);
  check(bottle.inRoom === null && janitor.instance.inventory.includes(bottle), 'the janitor walks over and picks up a bottle');
}

// A fido and a corpse: it crosses the room and eats it, leaving the gear.
{
  const t = fresh(3, 31);
  const fido = t.game.mobs.find((s) => s.record.special === 'spec_fido');
  t.stand(fido.roomVnum);
  const corpse = t.game.MERC.createObject(world.objProtos.get(3009), 1);
  Object.assign(corpse, { itemType: ITEM.CORPSE_NPC, name: 'corpse of a rat', keywords: 'corpse', contains: [t.obj(3020)], inRoom: fido.roomVnum, at: { ...fido.pos, x: fido.pos.x + 2 } });
  t.game.ground.push(corpse);
  for (let i = 0; i < 600 && corpse.inRoom !== null; i++) t.game.update(0.1, t.eye, t.look);
  check(corpse.inRoom === null && t.game.ground.some((o) => o.vnum === 3020), 'fido walks to a corpse, devours it and leaves the dagger',
    t.said.filter((l) => /devours/.test(l)).join(' | '));
}
// spec_guard: a mobile fighting you, more evil than you, is set upon.
{
  const t = fresh(3, 41);
  const guard = t.game.mobs.find((s) => s.record.special === 'spec_guard' && s.roomVnum === 3014);
  t.stand(3014);
  t.game.grace(1e9);
  const evil = t.game.mobs.find((s) => s !== guard && s.roomVnum === 3014 && !s.record.special)
    || t.game.mobs.find((s) => s.proto.vnum === 3065);
  const mob = t.game.MERC && evil ? (evil.instance || null) : null;
  void mob;
  const beggar = t.game.mobs.find((s) => s.proto.vnum === 3065);
  // Walk a beggar into the square and have it pick a fight with you.
  beggar.roomVnum = 3014; beggar.pos = { ...guard.pos, x: guard.pos.x + 1.5 }; beggar.anchor = { ...beggar.pos };
  t.eye.x = beggar.pos.x + 1.2; t.eye.z = beggar.pos.z; t.game.update(0.02, t.eye, t.look);
  t.game.attackSlot(beggar);
  beggar.instance.alignment = -800;
  for (let i = 0; i < 200 && !(guard.instance && guard.instance.fighting); i++) t.game.update(0.1, t.eye, t.look);
  check(guard.instance && guard.instance.fighting === beggar.instance, 'spec_guard sets upon the evil one fighting you',
    t.said.filter((l) => /PROTECT/.test(l)).join(' | '));
}
// spec_thief: stand by a thief with a purse and it sidles up and dips.
{
  const t = fresh(3, 51);
  const thief = t.game.mobs.find((s) => s.record.special === 'spec_thief' && s.proto.vnum === 3005);
  t.stand(thief.roomVnum);
  t.eye.x = thief.pos.x + 4; t.eye.z = thief.pos.z; t.game.update(0.02, t.eye, t.look);
  t.game.state.gold = 1000;
  let caught = false;
  for (let i = 0; i < 1200 && t.game.state.gold === 1000 && !caught; i++) {
    t.game.update(0.1, t.eye, t.look);
    caught = t.said.some((l) => /hands in your wallet/.test(l));
  }
  check(t.game.state.gold < 1000 || caught, 'spec_thief comes up and steals gold (or is caught at it)',
    caught ? 'caught' : `${1000 - t.game.state.gold} gold gone`);
}
// Training at the sailor.
{
  const t = fresh(3, 61);
  const sailor = t.game.mobs.find((s) => s.proto.vnum === 3007);
  t.stand(sailor.roomVnum);
  t.eye.x = sailor.pos.x + 1.5; t.eye.z = sailor.pos.z; t.game.update(0.02, t.eye, t.look);
  const before = t.game.state.permStr;
  t.say('train str');
  check(t.game.state.permStr === before + 1 && t.game.state.practice === 18, 'train str at the sailor: +1 for 3 practices (a warrior\'s prime)',
    t.said.join(' | '));
}
// Hiding: an aggressive mobile cannot see you -- a grey wolf in Haon Dor,
// which jumps anyone it can see (it is not ACT_WIMPY).
{
  const wolf = (t) => t.game.mobs.find((m) => m.proto.vnum === 6102);
  const seen = fresh(2, 71);
  const w0 = wolf(seen);
  seen.stand(w0.roomVnum);
  seen.eye.x = w0.pos.x + 2; seen.eye.z = w0.pos.z; seen.game.grace(0);
  for (let i = 0; i < 40; i++) seen.game.update(0.1, seen.eye, seen.look);
  check(!!(w0.instance && w0.instance.fighting === seen.game.state), 'a grey wolf jumps you in plain sight');
  const t = fresh(2, 71);
  const s = t.game.state;
  s.level = 20; s.learned.hide = 100;
  const agg = wolf(t);
  t.stand(agg.roomVnum);
  t.eye.x = agg.pos.x + 2; t.eye.z = agg.pos.z; t.game.update(0.02, t.eye, t.look);
  s.fighting = null;
  t.say('hide');
  const hidden = !!(s.affectedBy & 65536);
  t.game.grace(0);
  for (let i = 0; i < 40; i++) t.game.update(0.1, t.eye, t.look);
  check(hidden && !(agg.instance && agg.instance.fighting === s), `hidden, ${agg.proto.short} (aggressive) leaves you be`);
  t.eye.x += 3; t.game.update(0.1, t.eye, t.look);
  check(!(s.affectedBy & 65536), 'and walking off the spot gives you away');
}

// -------------------------------------------------------------- skills ----
console.log('\nSKILLS');
{
  const t = fresh(2);
  const s = t.game.state;
  s.level = 12;
  s.learned.backstab = 100;
  s.learned.sneak = 100;
  const prey = t.game.mobs.find((m) => m.proto.vnum === 3065);   // a beggar
  t.stand(prey.roomVnum);
  t.game.update(0.02, { x: prey.pos.x + 1.2, y: prey.pos.y + 1.72, z: prey.pos.z }, { x: -1, y: 0, z: 0 });
  check(/piercing weapon/.test(t.say('backstab beggar')), 'backstab needs a piercing weapon');
  const dagger = t.obj(3020);
  s.inventory.push(dagger);
  t.say('wield dagger');
  s.wait = 0;
  t.say('backstab beggar');
  check(t.said.some((l) => /backstab/.test(l)), 'backstab lands with its own noun', t.said.join(' | '));
  check(s.wait === 24, 'and costs its 24-pulse wait');
  const w = fresh(3);
  w.stand(3001);
  check(/aren't fighting/.test(w.say('kick')), 'kick needs a fight');
  check(w.game.actions().some((a) => a.id === 'kick'), 'a warrior has kick on the skill bar');
  check(!fresh(3).game.actions().some((a) => a.id === 'backstab'), 'and no backstab');
}

// ------------------------------------------------------------ save.c ----
console.log('\nSAVE AND LOAD');
{
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const a = fresh(2, 21);
  installSave(a.game, { world, storage });
  a.stand(3014);
  const s = a.game.state;
  s.level = 7; s.exp = 7300; s.gold = 321; s.practice = 4; s.learned.steal = 44;
  s.condition = [3, 20, 30];
  const bag = a.obj(3032);
  bag.contains.push(a.obj(3009));
  s.inventory.push(bag);
  const dagger = a.obj(3020);
  s.inventory.push(dagger);
  a.say('wield dagger');
  a.say('save');
  const before = JSON.stringify({ ...serialize(s), savedAt: 0 });
  const b = fresh(3, 99);
  let landed = null;
  installSave(b.game, { world, storage, onRestore: (room) => { landed = room; } });
  check(b.game.loadSave(), 'a saved character loads');
  const after = JSON.stringify({ ...serialize(b.game.state), savedAt: 0, room: s.roomVnum });
  check(before === after, 'the round trip is exact: stats, skills, conditions, gear, containers');
  check(landed === 3014, 'and puts you back in the room you saved in', landed);
  check(b.game.state.equipment[WEAR.WIELD]?.vnum === 3020 && b.game.state.inventory[0].contains.length === 1,
    'wielded dagger and the pie in the bag both come back');
}

console.log(failures.length ? `\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
