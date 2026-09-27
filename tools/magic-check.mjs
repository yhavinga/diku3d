/**
 * Balance and bookkeeping harness for src/magic.js.
 *
 * Three halves. The first holds the spell table against the numbers in
 * merc21/src/const.c and measures what each damage spell does at a range of
 * levels -- against the formula in magic.c, not against taste. The second is
 * the affect list: durations that tick on char_update and wear off with the
 * mud's line, poison that bites every tick, sanctuary halving damage. The third
 * builds a whole game over stub geometry and lets the casters of Midgaard
 * fight: spec_funs firing on the mobile pulse, spells arriving after their
 * flight, the player casting, and the magic items.
 *
 *     node tools/magic-check.mjs            # 2000 samples per measurement
 *     node tools/magic-check.mjs 20000
 *
 * Exits non-zero if an assertion fails.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { parseArea, buildWorld, SECTOR, ROOM_INDOORS } from '../src/are.js';
import { layoutWorld } from '../src/layout.js';
import { createGame, createMobile, MERC, POS, Rng } from '../src/game.js';
import {
  SPELLS, SPELL, TAR, AFF, createMagic, savesSpell, manaCost, mysticWords, isAffected, flightTime, CAST_WINDUP,
} from '../src/magic.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = Number(process.argv[2] || 2000);
const CELL = 13;
const LEVEL_H = 7.6;
const OUTDOOR = new Set([
  SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS,
  SECTOR.MOUNTAIN, SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT, SECTOR.AIR,
]);

const checks = [];
function check(ok, what, detail = '') {
  checks.push({ ok: !!ok, what, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

// ------------------------------------------------------------ the table --

console.log('THE SPELL TABLE, AGAINST CONST.C');
const spot = [
  ['fireball', [15, 37, 37, 37], TAR.OFFENSIVE, 15, 12, 26],
  ['sanctuary', [37, 13, 37, 37], TAR.DEFENSIVE, 75, 12, 36],
  ['magic missile', [1, 37, 37, 37], TAR.OFFENSIVE, 15, 12, 32],
  ['heal', [37, 14, 37, 37], TAR.DEFENSIVE, 50, 12, 28],
  ['earthquake', [37, 7, 37, 37], TAR.IGNORE, 15, 12, 23],
  ['gas breath', [35, 37, 37, 37], TAR.IGNORE, 0, 4, 203],
  ['refresh', [5, 3, 37, 37], TAR.DEFENSIVE, 12, 18, 81],
];
for (const [name, level, target, mana, beats, slot] of spot) {
  const sp = SPELL[name];
  check(sp && String(sp.level) === String(level) && sp.target === target && sp.minMana === mana
    && sp.beats === beats && sp.slot === slot, `${name}: levels, target, mana, beats, slot`);
}
check(new Set(SPELLS.map((s) => s.slot)).size === SPELLS.length, 'every #OBJECTS slot is used once');
check(mysticWords('cure light') === 'judicandus dies', "say_spell: cure light is 'judicandus dies'", mysticWords('cure light'));
check(mysticWords('fireball') === 'yucandusbarr', "and fireball 'yucandusbarr'", mysticWords('fireball'));

// ------------------------------------------------------------- the rolls --

console.log('\nSAVES AND DAMAGE, MEASURED');
{
  const rng = new Rng(4242);
  const v = { level: 10, savingThrow: 0 };
  let s = 0;
  for (let i = 0; i < SAMPLES * 5; i++) if (savesSpell(rng, 10, v)) s += 1;
  const rate = s / (SAMPLES * 5);
  // number_percent() < 50 over 1..100 is 49 in 100.
  check(near(rate, 0.49, 0.02), 'saves_spell at equal level is 49%', `${(rate * 100).toFixed(1)}%`);
  let t = 0;
  for (let i = 0; i < SAMPLES * 5; i++) if (savesSpell(rng, 30, v)) t += 1;
  check(near(t / (SAMPLES * 5), 0.04, 0.015), 'twenty levels up, the floor of 5 (4 in 100)', `${(t / SAMPLES / 5 * 100).toFixed(1)}%`);
}

/**
 * A magic engine over two bare characters, to call spell_funs directly and
 * read what they did. `damage` is fight.c's, through MERC.
 */
function bench(rng) {
  const events = [];
  const ctx = {
    rng,
    emit: (e) => events.push(e),
    setFighting(ch, victim) { ch.fighting = victim; ch.position = POS.FIGHTING; },
    stopFighting(ch) { ch.fighting = null; if (ch.position === POS.FIGHTING) ch.position = POS.STANDING; },
    disarm() {}, flee() {}, kill(k, v) { v.dead = true; },
  };
  const caster = MERC.createCharacter(0, { level: 20, rng });
  const magic = createMagic({
    rng, emit: ctx.emit, ctx, player: caster, damage: MERC.damage, updatePos: MERC.updatePos,
    gainExp: (ch, g) => MERC.gainExp(ch, g, rng), distance: () => 25, people: () => [],
    strikeBack() {}, recall() {}, teleport: () => false, sky: () => 0, outdoors: () => true,
    extract() {},
  });
  return { magic, events, caster, ctx };
}

const protoOf = (level) => ({
  vnum: 1, short: 'a target', keywords: 'target', long: '', description: '', level, act: 0,
  affected: 0, alignment: -1000, sex: 1, gold: 0,
});

/** Mean damage of one spell cast at `level` on a fresh mobile of the same level. */
function meanDamage(name, level) {
  const rng = new Rng(1000 + level);
  const { magic, caster } = bench(rng);
  const dams = [];
  for (let i = 0; i < SAMPLES; i++) {
    const mob = createMobile(protoOf(level), level, rng);
    mob.level = level;
    mob.hit = mob.maxHit = 100000;
    caster.fighting = null;
    magic.now(name, level, caster, mob);
    dams.push(100000 - mob.hit);
  }
  return mean(dams);
}

/**
 * What magic.c's own arithmetic says the mean is: the table's
 * number_range(d/2, 2d), halved on a save of 49 in 100 at equal level.
 */
function expectedTable(table, level) {
  const d = table[Math.min(level, table.length - 1)];
  const lo = Math.trunc(d / 2);
  const hi = d * 2;
  let sum = 0;
  for (let x = lo; x <= hi; x++) sum += 0.51 * x + 0.49 * Math.trunc(x / 2);
  return sum / (hi - lo + 1);
}

const TABLES = {
  'magic missile': [0, 3, 3, 4, 4, 5, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 10],
  fireball: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 82],
  'lightning bolt': [0, 0, 0, 0, 0, 0, 0, 0, 0, 25, 28, 31, 34, 37, 40, 40, 41, 42, 42, 43, 44, 44, 45, 46, 46, 47, 48],
  'colour spray': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 35, 40, 45, 50, 55, 55, 55, 56, 57, 58, 58, 59, 60, 61, 61],
};
const rows = [];
for (const level of [5, 10, 15, 20, 25]) {
  const row = { level };
  for (const name of ['magic missile', 'burning hands', 'chill touch', 'shocking grasp', 'lightning bolt',
    'colour spray', 'fireball', 'acid blast', 'cause light', 'cause serious', 'cause critical', 'flamestrike', 'harm']) {
    const sp = SPELL[name];
    if (sp.level[0] > level && sp.level[1] > level) { row[name] = '-'; continue; }
    row[name] = meanDamage(name, level);
  }
  rows.push(row);
}
const cols = Object.keys(rows[0]).filter((k) => k !== 'level');
console.log(`  ${'lvl'.padEnd(4)}${cols.map((c) => c.split(' ').map((w) => w.slice(0, 5)).join(' ').padStart(13)).join('')}`);
for (const row of rows) {
  console.log(`  ${String(row.level).padEnd(4)}${cols.map((c) => (typeof row[c] === 'number' ? row[c].toFixed(1) : row[c]).padStart(13)).join('')}`);
}
for (const [name, table] of Object.entries(TABLES)) {
  for (const row of rows) {
    if (typeof row[name] !== 'number') continue;
    const want = expectedTable(table, row.level);
    check(near(row[name], want, want * 0.06 + 0.3), `${name} at level ${row.level} averages magic.c's number`,
      `${row[name].toFixed(1)} against ${want.toFixed(1)}`);
  }
}
{
  // cause critical: dice(3,8) + level - 6, no save.
  const r = rows.find((x) => x.level === 20);
  check(near(r['cause critical'], 13.5 + 14, 0.8), 'cause critical is 3d8 + level - 6, unsaved', r['cause critical'].toFixed(1));
  // harm on a victim with 100000 hp: min(100, ...) = 100, or min(50, big/4)=50 on a save.
  check(near(r.harm, 0.51 * 100 + 0.49 * 50, 3), 'harm caps at 100, and at 50 on a save', r.harm.toFixed(1));
  check(rows.find((x) => x.level === 25).fireball > rows.find((x) => x.level === 15).fireball * 1.8,
    'fireball more than doubles from level 15 to 25', `${rows[2].fireball.toFixed(0)} -> ${rows[4].fireball.toFixed(0)}`);
}

// ---------------------------------------------------------- the affects --

console.log('\nAFFECTS, TICKING');
{
  const rng = new Rng(7);
  const { magic, caster, events } = bench(rng);
  const you = caster;
  const ac0 = you.armor;
  magic.now('armor', 20, you, you);
  check(you.armor === ac0 - 20 && isAffected(you, 'armor'), 'armor takes 20 off your armour class', `${ac0} -> ${you.armor}`);
  let ticks = 0;
  while (isAffected(you, 'armor') && ticks < 100) { magic.tick(you); ticks += 1; }
  check(ticks === 25, 'and lasts its 24 ticks, gone on the 25th', `${ticks}`);
  check(you.armor === ac0, 'the armour class comes back with it', `${you.armor}`);
  check(events.some((e) => e.kind === 'magic' && e.text === 'You feel less protected.'), "with const.c's wear-off line");

  const mob = createMobile(protoOf(10), 10, rng);
  magic.now('armor', 20, you, mob);
  check(isAffected(mob, 'armor') && mob.armor === MERC.interpolate(mob.level, 100, -100),
    "on a mobile the affect is there but its number is not (affect_modify's NPC return)");

  magic.now('sanctuary', 16, you, you);
  const sanctTicks = you.affected.find((a) => a.type === 'sanctuary').duration;
  check(you.affectedBy & AFF.SANCTUARY, 'sanctuary sets AFF_SANCTUARY', `for number_fuzzy(16/8) = ${sanctTicks} ticks`);
  const ctx = { rng, emit() {}, setFighting(c, v) { c.fighting = v; }, stopFighting() {}, disarm() {}, flee() {}, kill() {} };
  const hitter = createMobile(protoOf(10), 10, rng);
  const before = you.hit = you.maxHit = 1000;
  MERC.damage(hitter, you, 41, 'test', ctx);
  check(before - you.hit === 20, 'and damage() halves a blow under it', `41 -> ${before - you.hit}`);
  for (let i = 0; i <= sanctTicks; i++) magic.tick(you);
  check(!(you.affectedBy & AFF.SANCTUARY), 'then wears off on time', `${sanctTicks + 1} ticks`);
  you.hit = 1000;
  MERC.damage(hitter, you, 41, 'test', ctx);
  check(1000 - you.hit === 41, 'after which a blow lands whole', `${1000 - you.hit}`);

  // Poison: joins, bites for 2 a tick, and a tick's healing is quartered.
  const victim = createMobile(protoOf(5), 5, rng);
  victim.savingThrow = 50;   // a victim that cannot save, so the join is measured
  magic.now('poison', 10, you, victim);
  magic.now('poison', 10, you, victim);
  const paf = victim.affected.find((a) => a.type === 'poison');
  check(paf && paf.duration === 20 && paf.modifier === -4, 'poison twice joins: 20 ticks, -4 str', paf ? `${paf.duration}, ${paf.modifier}` : 'none');
  const hp = victim.hit;
  magic.tick(victim);
  check(hp - victim.hit === 2, 'poison takes 2 hitpoints a tick', `${hp - victim.hit}`);

  // Blindness on you: -4 hitroll while it lasts.
  const hr = you.hitroll;
  you.savingThrow = 100;
  magic.now('blindness', 20, hitter, you);
  check((you.affectedBy & AFF.BLIND) && you.hitroll === hr - 4, 'blindness: AFF_BLIND and -4 hitroll');
  magic.stripAll(you);
  check(you.hitroll === hr && you.affectedBy === 0 && you.affected.length === 0, 'raw_kill strips every affect and puts the numbers back');
  you.savingThrow = 0;

  // Dispel magic takes an innate flag off a mobile of a lower level.
  const saint = createMobile({ ...protoOf(5), affected: AFF.SANCTUARY | AFF.DETECT_INVIS }, 5, rng);
  saint.savingThrow = 100;
  let tries = 0;
  while (saint.affectedBy === (AFF.SANCTUARY | AFF.DETECT_INVIS) && tries < 20) { magic.now('dispel magic', 20, you, saint); tries += 1; }
  check(saint.affectedBy !== (AFF.SANCTUARY | AFF.DETECT_INVIS), 'dispel magic strips a bit it was born with', `affected_by ${saint.affectedBy}`);
}

// ------------------------------------------------------------ the world --

console.log('\nTHE CASTERS OF MIDGAARD, OVER STUB GEOMETRY');
const text = readFileSync(join(root, 'merc21/area/midgaard.are'), 'utf8');
const world = buildWorld([parseArea(text, 'midgaard.are')]);
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

/** Stand two metres off a mobile, facing it, and fight it for `seconds`. */
function fightNear(game, slot, seconds, { attack = true, events = [] } = {}) {
  const at = () => ({ x: slot.pos.x + 2, y: slot.pos.y + 1.72, z: slot.pos.z });
  const look = () => ({ x: -1, y: 0, z: 0 });
  game.grace(0);
  game.update(0.016, at(), look());
  if (attack) game.attack();
  let t = 0;
  while (t < seconds && !slot.dead && game.state.position > POS.STUNNED) {
    game.update(0.05, at(), look());
    for (const e of game.drain()) events.push(e);
    t += 0.05;
    // Keep the player alive: this is about what the caster does, not who wins.
    game.state.hit = game.state.maxHit;
  }
  return events;
}

{
  const game = createGame({ world, layout, built, seed: 31337, classIndex: 3 });
  game.chooseClass(3, { level: 30 });
  const wizard = game.mobs.find((s) => s.proto.vnum === 3000);
  const events = fightNear(game, wizard, 90);
  const casts = events.filter((e) => e.kind === 'cast' && e.from === wizard);
  const lands = events.filter((e) => e.kind === 'spell' && e.from === wizard);
  const spellHits = events.filter((e) => e.kind === 'hit' && e.spell);
  const kinds = [...new Set(casts.map((e) => e.spell))];
  check(casts.length >= 3, 'the wizard casts in a fight (spec_cast_mage on the mobile pulse)', `${casts.length} casts in 90s: ${kinds.join(', ')}`);
  check(lands.length >= casts.length - 1, 'and every spell lands after it is released', `${lands.length} of ${casts.length}`);
  check(casts.every((e) => !e.text), 'spec_cast_mage says no words (it calls spell_fun, not do_cast)');
  check(spellHits.every((e) => typeof e.spell === 'string'), "a spell's blow carries its noun", [...new Set(spellHits.map((e) => e.spell))].join(', '));
  // The wizard is level 23: fireball at 15+ is 3 of the 16 rolls, acid blast
  // at 20+ is 6 of them; blindness, chill touch, weaken, teleport, colour
  // spray, change sex and energy drain one each.
  check(kinds.includes('fireball') || kinds.includes('acid blast'), 'a level 23 mage throws its big spells');
  const pace = 90 / Math.max(1, casts.length);
  check(pace > 6 && pace < 40, 'at the mud\'s pace: one cast per 4s pulse at 1-in-4', `one every ${pace.toFixed(1)}s`);
}

{
  // The healer (spec_cast_adept) looks after whoever is standing in the temple.
  const game = createGame({ world, layout, built, seed: 5, classIndex: 3 });
  const healer = game.mobs.find((s) => s.proto.vnum === 3012);
  const at = { x: healer.pos.x + 2, y: healer.pos.y + 1.72, z: healer.pos.z };
  game.update(0.016, at, { x: -1, y: 0, z: 0 });
  game.state.hit = 5;
  const events = [];
  for (let t = 0; t < 180; t += 0.05) {
    game.state.hit = Math.min(game.state.hit, 5);   // stay hurt, so a cure is measurable
    game.update(0.05, at, { x: -1, y: 0, z: 0 });
    events.push(...game.drain());
  }
  const casts = events.filter((e) => e.kind === 'cast' && e.from === healer);
  const words = events.filter((e) => e.kind === 'magic' && /utters the word/.test(e.text));
  check(casts.length >= 8, 'the healer casts on the people in the temple', `${casts.length} in 180s: ${[...new Set(casts.map((e) => e.spell))].join(', ')}`);
  check(words.length >= 1, "saying the adept's words", words[0] ? words[0].text : '');
  const cures = events.filter((e) => e.kind === 'spell' && e.from === healer && e.toPlayer && e.spell === 'cure light');
  check(cures.length >= 1 && events.some((e) => e.kind === 'magic' && e.text === 'You feel better!'), 'and you are cured by it', `${cures.length} cure light on you`);
}

{
  // The player as a mage.
  const game = createGame({ world, layout, built, seed: 99, classIndex: 0 });
  check(game.state.learned['magic missile'] === MERC.INT_APP[16], 'a new mage knows magic missile at one session\'s worth',
    `${game.state.learned['magic missile']}%`);
  game.chooseClass(0, { level: 20 });
  for (const s of game.spells()) game.state.learned[s.name] = 95;
  const bar = game.spells().map((s) => s.name);
  check(bar.includes('fireball') && bar.includes('acid blast') && !bar.includes('heal'), 'a level 20 mage has fireball and acid blast, not heal', bar.join(', '));
  const prey = game.mobs.find((s) => s.proto.level >= 5 && s.proto.level <= 10 && !(s.proto.act & 2));
  const at = { x: prey.pos.x + 8, y: prey.pos.y + 1.72, z: prey.pos.z };
  const look = { x: -1, y: 0, z: 0 };
  game.grace(0);
  game.update(0.016, at, look);
  const mana0 = game.state.mana;
  const r = game.cast('fireball');
  check(r.ok, 'casting fireball at a mobile eight metres off', r.text);
  check(mana0 - game.state.mana === manaCost(game.state, SPELL.fireball), 'costs do_cast\'s mana', `${mana0 - game.state.mana}`);
  check(!game.cast('magic missile').ok, 'and the next spell waits out the beats', `${game.magic.wait.toFixed(2)}s`);
  const wizardHp = prey.instance.hit;
  let t = 0;
  const events = [];
  const expected = CAST_WINDUP + flightTime('fireball', 8);
  while (t < 3) {
    game.update(0.02, at, look);
    t += 0.02;
    const batch = game.drain();
    events.push(...batch);
    if (batch.some((e) => e.kind === 'spell')) break;
  }
  check(near(t, expected, 0.06), 'the fireball lands after the words and its flight', `${t.toFixed(2)}s, expected ${expected.toFixed(2)}s`);
  check(prey.dead || prey.instance.hit < wizardHp, 'and burns', `${wizardHp} -> ${prey.dead ? 'dead' : prey.instance.hit}`);
  check(prey.dead || prey.instance.fighting === game.state, 'the victim turns on you');

  // Sanctuary on yourself as a cleric, and the aura's flag.
  game.chooseClass(1, { level: 20 });
  game.state.learned.sanctuary = 95;
  let s = { ok: false };
  for (let i = 0; i < 6 && !s.ok; i++) { game.magic.wait = 0; s = game.cast('sanctuary'); }
  for (let i = 0; i < 60; i++) game.update(0.02, at, look);
  check(game.state.affectedBy & AFF.SANCTUARY, 'a cleric casts sanctuary on itself', s.text);
}

{
  // The magic items the loaded areas carry.
  const game = createGame({ world, layout, built, seed: 3, classIndex: 3 });
  const potion = world.objProtos.get(3041);
  const obj = MERC.createObject(potion, 5);
  game.state.inventory.push(obj);
  game.update(0.05, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  const r = game.useItem(obj);
  for (let i = 0; i < 40; i++) game.update(0.02, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  check(r.ok && (game.state.affectedBy & AFF.DETECT_INVIS) && !game.state.inventory.includes(obj),
    `quaffing ${potion.short} casts detect invis on you and uses it up`);
  const scroll = MERC.createObject(world.objProtos.get(3042), 5);
  game.state.inventory.push(scroll);
  let sent = null;
  game.onTeleport = (x, y, z) => { sent = { x, y, z }; };
  game.useItem(scroll);
  for (let i = 0; i < 40; i++) game.update(0.02, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  const temple = built.rooms.get(3001);
  check(sent && near(sent.x, temple.center.x, 0.01) && near(sent.z, temple.center.z, 0.01), 'reciting a scroll of recall takes you to the temple');
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length ? `${failed.length} check(s) FAILED` : 'all checks passed'}`);
process.exit(failed.length ? 1 : 0);
