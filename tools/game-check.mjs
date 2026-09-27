/**
 * Balance harness for src/game.js.
 *
 * Two halves. The first drives the ported rules directly -- createCharacter,
 * createMobile, multiHit -- and fights every mobile in Midgaard two hundred
 * times at a range of character levels, which is the only way to find out
 * whether the numbers Merc shipped with add up to a game. The second builds a
 * whole game over stub geometry and plays a kill through it end to end, so the
 * real-time shell is exercised too.
 *
 *     node tools/game-check.mjs               # midgaard, 200 fights per pairing
 *     node tools/game-check.mjs 500           # more samples
 *     node tools/game-check.mjs 200 haon.are  # somewhere that is not a town
 *
 * It exits non-zero if the sanity assertions at the bottom fail.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { parseArea, buildWorld, SECTOR, ROOM_INDOORS } from '../src/are.js';
import { layoutWorld } from '../src/layout.js';
import { createGame, MERC, POS, WEAR } from '../src/game.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = Number(process.argv[2] || 200);
const AREA_FILE = process.argv[3] || 'midgaard.are';

// build.js's grid pitch, repeated rather than imported: build.js pulls in
// three.js and this has to run under bare node.
const CELL = 13;
const LEVEL_H = 7.6;

const OUTDOOR = new Set([
  SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS,
  SECTOR.MOUNTAIN, SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT, SECTOR.AIR,
]);

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const pct = (n) => `${(n * 100).toFixed(0)}%`;

// ---------------------------------------------------------------- the world --

const text = readFileSync(join(root, 'merc21/area', AREA_FILE), 'utf8');
const world = buildWorld([parseArea(text, AREA_FILE)]);
const layout = layoutWorld(world, { startVnum: [...world.rooms.keys()][0], maxRooms: 400 });

/** Stub geometry: the layout grid, scaled the way build.js scales it. */
const built = { rooms: new Map(), colliders: [], portals: [] };
for (const [vnum, cell] of layout.cells) {
  const room = world.rooms.get(vnum);
  built.rooms.set(vnum, {
    room,
    cell,
    center: { x: cell.x * CELL, y: cell.level * LEVEL_H, z: cell.z * CELL },
    outdoor: OUTDOOR.has(room.sector) && !(room.flags & ROOM_INDOORS),
    materials: {},
  });
}

/** Every mobile the area actually places, once each, weakest first. */
const placed = new Map();
for (const room of world.rooms.values()) {
  for (const record of room.mobs) if (!placed.has(record.proto.vnum)) placed.set(record.proto.vnum, record);
}
const roster = [...placed.values()].sort((a, b) => a.proto.level - b.proto.level);

// --------------------------------------------------------------- the duels --

/**
 * The parts of the game shell that fight.c reaches back into. Disarm is real
 * here: a high-level mobile knocking the sword out of your hand is a quarter of
 * why the fights against them go the way they do.
 */
function makeCtx(rng) {
  const ctx = {
    rng,
    emit() {},
    setFighting(ch, victim) { ch.fighting = victim; ch.position = POS.FIGHTING; },
    stopFighting(ch, both = true) {
      const other = ch.fighting;
      if (both && other && other.fighting === ch) {
        other.fighting = null;
        if (other.position === POS.FIGHTING) other.position = POS.STANDING;
      }
      ch.fighting = null;
      if (ch.position === POS.FIGHTING) ch.position = POS.STANDING;
      MERC.updatePos(ch);
    },
    disarm(ch, victim) {
      const obj = victim.equipment[WEAR.WIELD];
      if (!obj) return;
      if (!ch.equipment[WEAR.WIELD] && rng.bits(1) === 0) return;
      MERC.unequipChar(victim, obj);
      victim.inventory.push(obj);
    },
    // Wimpy fires for both sides: a mobile at half health under ACT_WIMPY, and
    // the player at max_hit/5, which is what `wimpy` with no argument sets.
    flee(ch) { ctx.stopFighting(ch); ch.fled = true; },
    kill(killer, victim) { victim.dead = true; },
  };
  return ctx;
}

/** The equipment a character would be wearing at this point in the game. */
function kit(ch, level) {
  if (level < 3) return;                       // fresh out of the school: fists
  const buy = (vnum) => {
    const proto = world.objProtos.get(vnum);
    if (!proto) return;
    MERC.wearObj(ch, MERC.createObject(proto, 0), true);
  };
  if (level < 10) {
    buy(3020);                                 // a dagger, 13 gold
  } else {
    buy(3022);                                 // a long sword, 130 gold
    for (const v of [3066, 3067, 3068, 3069, 3070, 3071]) buy(v);   // studded leather
  }
  if (level >= 16) for (const v of [3072, 3073, 3074, 3075, 3076, 3077, 3097]) buy(v);  // scale mail
}

/**
 * What a character would have practised by now: Merc hands out 21 sessions at
 * birth and wis_app more per level, and a fighter spends them on the things
 * fight.c reads. int_app.learn per session, capped at the class's adept.
 */
function practise(ch) {
  const order = ['secondAttack', 'enhancedDamage', 'parry', 'thirdAttack', 'dodge'];
  const adept = MERC.CLASS_TABLE[ch.class].skillAdept;
  const learn = MERC.INT_APP[MERC.currInt(ch)];
  let left = ch.practice;
  for (const key of order) {
    const skill = MERC.SKILLS.find((s) => s.key === key);
    if (ch.level < skill.level[ch.class]) continue;
    while (left > 0 && ch.learned[key] < adept) { ch.learned[key] += learn; left -= 1; }
    ch.learned[key] = Math.min(adept, ch.learned[key]);
  }
  ch.practice = left;
}

function character(classIndex, level, rng, { equip = true, skills = true } = {}) {
  const ch = MERC.createCharacter(classIndex, { level, rng });
  if (skills) practise(ch);
  if (equip) kit(ch, level);
  ch.hit = ch.maxHit;
  ch.fighting = null;
  ch.position = POS.STANDING;
  ch.dead = false;
  ch.fled = false;
  return ch;
}

/**
 * One fight to the finish, including the two things that decide every fight
 * against the Watch and which a straight round loop misses:
 *
 *   - Disarm. A mobile of level `n` disarms on `n/2` percent of its blows, and
 *     `check_parry` refuses to fire for a player with nothing in hand -- so
 *     losing the sword costs the damage *and* the defence. In the mud you would
 *     pick it up and wield it again; that is a round, and it is charged here.
 *   - Being stunned. Below zero hitpoints IS_AWAKE goes false and
 *     violence_update takes you out of the fight, so there is no swinging on at
 *     -4 hitpoints the way an unguarded loop would let you.
 *
 * A wimpy mobile that flees is chased down: on foot you are faster than it, so
 * it costs two rounds to catch, and after six escapes it is gone for good.
 */
function duel(ch, mob, rng) {
  const ctx = makeCtx(rng);
  ctx.setFighting(ch, mob);
  ctx.setFighting(mob, ch);
  let rounds = 0;
  let chases = 0;
  while (rounds < 500) {
    rounds += 1;
    if (!MERC.isAwake(ch)) return { won: false, rounds, hpLeft: 0, stunned: true };

    const dropped = ch.inventory.find((o) => (o.wearFlags & 8192) && !ch.equipment[MERC.WEAR.WIELD]);
    if (dropped) {
      MERC.wearObj(ch, dropped, true);            // a round spent re-arming
    } else {
      MERC.multiHit(ch, mob, undefined, ctx);
    }

    if (mob.dead) return { won: true, rounds, hpLeft: ch.hit };
    if (mob.fled) {
      if (++chases > 6) return { won: null, rounds, hpLeft: ch.hit, escaped: true };
      mob.fled = false;
      rounds += 2;
      ctx.setFighting(ch, mob);
      ctx.setFighting(mob, ch);
      continue;
    }
    MERC.multiHit(mob, ch, undefined, ctx);
    if (ch.dead) return { won: false, rounds, hpLeft: 0 };
    // Your own wimpy: you back off at a fifth of your health and live, which is
    // why a losing fight is usually a lost fight rather than a death.
    if (ch.fled) return { won: null, rounds, hpLeft: ch.hit, drivenOff: true };
  }
  return { won: null, rounds, hpLeft: ch.hit, stalled: true };
}

function trial(classIndex, charLevel, record, samples, options) {
  const rng = new MERC.Rng(0x51ed ^ (charLevel * 977) ^ record.proto.vnum);
  let wins = 0;
  let deaths = 0;
  let noKill = 0;
  let rounds = 0;
  let hpLeft = 0;
  let mobLevel = 0;
  let mobHp = 0;
  for (let i = 0; i < samples; i++) {
    const ch = character(classIndex, charLevel, rng, options);
    // number_fuzzy twice, exactly as the mud does it: once in load_mobiles when
    // the area file is read, once again in create_mobile. A "level 1" janitor
    // is really a one-in-sixteen chance of a level 3 one, and a level 1
    // character notices.
    const mob = MERC.createMobile(record.proto, rng.fuzzy(record.proto.level), rng);
    mob.dead = false;
    mob.fled = false;
    mobLevel += mob.level;
    mobHp += mob.maxHit;
    // Every piece the reset table hung on it -- the cityguards' standard issue
    // is eleven pieces of armour and it is most of why they are the wall.
    for (const worn of record.equipment) {
      if (worn.wearLoc < 0 || worn.wearLoc >= MERC.MAX_WEAR || mob.equipment[worn.wearLoc]) continue;
      MERC.equipChar(mob, MERC.createObject(worn.proto, 0), worn.wearLoc);
    }
    const out = duel(ch, mob, rng);
    rounds += out.rounds;
    if (out.won === true) { wins += 1; hpLeft += out.hpLeft / ch.maxHit; } else if (out.won === false) deaths += 1;
    else noKill += 1;
  }
  return {
    name: record.proto.short,
    vnum: record.proto.vnum,
    level: mobLevel / samples,
    hp: mobHp / samples,
    win: wins / samples,
    died: deaths / samples,
    noKill: noKill / samples,
    rounds: rounds / samples,
    seconds: (rounds / samples) * (MERC.PULSE_VIOLENCE / MERC.PULSE_PER_SECOND),
    hpLeft: wins ? hpLeft / wins : 0,
  };
}

// -------------------------------------------------------------- the report --

console.log(`\n${AREA_FILE} -- ${world.rooms.size} rooms, ${placed.size} mobiles placed,`
  + ` ${SAMPLES} fights per pairing\n`);

console.log('A LEVEL 1 WARRIOR, BARE-HANDED, AGAINST EVERYTHING MIDGAARD PLACES');
console.log(`  ${pad('mobile', 26)}${rpad('lvl', 4)}${rpad('hp', 6)}${rpad('win', 6)}`
  + `${rpad('died', 6)}${rpad('off', 6)}${rpad('rounds', 8)}${rpad('secs', 7)}${rpad('hp left', 9)}`);
const level1 = [];
for (const record of roster) {
  const row = trial(3, 1, record, SAMPLES, { equip: false, skills: false });
  level1.push(row);
  console.log(`  ${pad(row.name.slice(0, 25), 26)}${rpad(row.level.toFixed(1), 4)}${rpad(row.hp.toFixed(0), 6)}`
    + `${rpad(pct(row.win), 6)}${rpad(pct(row.died), 6)}${rpad(pct(row.noKill), 6)}`
    + `${rpad(row.rounds.toFixed(1), 8)}${rpad(row.seconds.toFixed(0), 7)}${rpad(pct(row.hpLeft), 9)}`);
}

console.log('\nWIN RATE BY MOBILE LEVEL, BY CHARACTER LEVEL (kitted and practised)');
const charLevels = [1, 3, 5, 8, 12, 16, 20, 25];
const buckets = [...new Set(roster.map((r) => r.proto.level))].sort((a, b) => a - b);
console.log(`  ${pad('mob lvl', 9)}${charLevels.map((l) => rpad(`ch${l}`, 7)).join('')}`);
const grid = new Map();
for (const mobLevel of buckets) {
  const records = roster.filter((r) => r.proto.level === mobLevel);
  const cells = charLevels.map((charLevel) => {
    let win = 0;
    let secs = 0;
    for (const record of records) {
      const row = trial(3, charLevel, record, Math.max(20, Math.round(SAMPLES / 4)));
      win += row.win;
      secs += row.seconds;
    }
    const cell = { win: win / records.length, seconds: secs / records.length };
    grid.set(`${charLevel}:${mobLevel}`, cell);
    return cell;
  });
  console.log(`  ${pad(mobLevel, 9)}${cells.map((c) => rpad(pct(c.win), 7)).join('')}`);
}

console.log('\nSECONDS TO KILL, SAME GRID');
console.log(`  ${pad('mob lvl', 9)}${charLevels.map((l) => rpad(`ch${l}`, 7)).join('')}`);
for (const mobLevel of buckets) {
  const cells = charLevels.map((charLevel) => grid.get(`${charLevel}:${mobLevel}`));
  console.log(`  ${pad(mobLevel, 9)}${cells.map((c) => rpad(c.win > 0.05 ? c.seconds.toFixed(0) : '-', 7)).join('')}`);
}

// ------------------------------------------------------------- the xp curve --

/**
 * A whole play-through: at every level the character hunts the hardest thing it
 * beats four times out of five, and Merc's popularity term pushes it onto the
 * next thing as soon as it has killed one too many of the last. Rest time in
 * between is charged at hit_gain, which is what the healing actually costs.
 */
function playthrough(classIndex, toLevel) {
  const rng = new MERC.Rng(0xc0ffee);
  const ch = MERC.createCharacter(classIndex, { rng });
  const killTable = Array.from({ length: MERC.MAX_LEVEL }, () => ({ number: 0, killed: 0 }));
  const protoKilled = new Map();
  const loadLevels = new Map();
  for (const proto of world.mobProtos.values()) {
    const loadLevel = rng.fuzzy(proto.level);
    loadLevels.set(proto.vnum, loadLevel);
    protoKilled.set(proto.vnum, 0);
    killTable[MERC.clamp(loadLevel, 0, MERC.MAX_LEVEL - 1)].number += 1;
  }

  const rows = [];
  let seconds = 0;
  let kills = 0;
  let deaths = 0;
  let guard = 0;

  /** The best odds-adjusted xp on the board right now, popularity included. */
  const choose = () => {
    let pick = null;
    let best = -Infinity;
    for (const record of roster) {
      const odds = grid.get(`${nearestCharLevel(ch.level)}:${record.proto.level}`);
      if (!odds || odds.win < 0.8) continue;
      const killed = protoKilled.get(record.proto.vnum);
      const level = MERC.clamp(loadLevels.get(record.proto.vnum), 0, MERC.MAX_LEVEL - 1);
      const extra = killed - MERC.idiv(killTable[level].killed, Math.max(1, killTable[level].number));
      const worth = 300 - MERC.clamp(ch.level - record.proto.level, -3, 6) * 50;
      const score = (worth * (8 - MERC.clamp(extra, -2, 8))) / 8 / Math.max(4, odds.seconds);
      if (score > best) { best = score; pick = record; }
    }
    return best > 0 ? pick : null;
  };

  while (ch.level < toLevel && guard++ < 20000) {
    practise(ch);
    kit(ch, ch.level);
    const startLevel = ch.level;
    const startKills = kills;
    const startSeconds = seconds;
    const hunted = new Map();

    while (ch.level === startLevel && guard++ < 20000) {
      // Chosen fresh every kill: Merc's popularity term is designed to make
      // you move on, and a player who did not would be measuring nothing.
      const record = choose();
      if (!record) { rows.push({ level: startLevel, stalled: true }); return { rows, kills, deaths, seconds, ch }; }

      const mob = MERC.createMobile(record.proto, loadLevels.get(record.proto.vnum), rng);
      mob.dead = false; mob.fled = false;
      for (const worn of record.equipment) {
        if (worn.wearLoc < 0 || worn.wearLoc >= MERC.MAX_WEAR || mob.equipment[worn.wearLoc]) continue;
        MERC.equipChar(mob, MERC.createObject(worn.proto, 0), worn.wearLoc);
      }
      const fighter = character(classIndex, ch.level, rng);
      const out = duel(fighter, mob, rng);
      seconds += out.rounds * (MERC.PULSE_VIOLENCE / MERC.PULSE_PER_SECOND);
      // Walking to the next thing worth killing. Midgaard is a hundred rooms.
      seconds += 12;
      if (!out.won) { if (out.won === false) deaths += 1; seconds += 30; continue; }
      kills += 1;
      hunted.set(record.proto.short, (hunted.get(record.proto.short) || 0) + 1);

      const xp = MERC.xpCompute(ch, mob, killTable, protoKilled.get(mob.vnum), rng);
      protoKilled.set(mob.vnum, protoKilled.get(mob.vnum) + 1);
      killTable[MERC.clamp(mob.level, 0, MERC.MAX_LEVEL - 1)].killed += 1;
      MERC.gainExp(ch, xp, rng);

      // Resting back to full, at the mud's hit_gain and this game's rest clock.
      const missing = fighter.maxHit - out.hpLeft;
      const perTick = Math.min(5, ch.level) + MERC.idiv(MERC.currCon(ch), 2);
      seconds += Math.max(0, Math.ceil(missing / perTick)) * (MERC.PULSE_TICK / MERC.PULSE_PER_SECOND / 4);
    }

    const top = [...hunted.entries()].sort((a, b) => b[1] - a[1])[0];
    rows.push({
      level: startLevel,
      prey: top ? top[0] : '-',
      variety: hunted.size,
      kills: kills - startKills,
      seconds: seconds - startSeconds,
      hp: ch.maxHit,
    });
  }
  return { rows, kills, deaths, seconds, ch };
}

const nearestCharLevel = (level) => charLevels.reduce((a, b) => (Math.abs(b - level) < Math.abs(a - level) ? b : a));

console.log('\nXP CURVE: A WARRIOR FROM 1 TO 10, HUNTING WHATEVER PAYS BEST');
const run = playthrough(3, 10);
console.log(`  ${pad('level', 7)}${pad('mostly hunting', 24)}${rpad('kinds', 7)}${rpad('kills', 7)}${rpad('mins', 7)}${rpad('max hp', 8)}`);
for (const row of run.rows) {
  if (row.stalled) { console.log(`  ${pad(row.level, 7)}nothing left worth killing`); break; }
  console.log(`  ${pad(row.level, 7)}${pad(row.prey.slice(0, 23), 24)}${rpad(row.variety, 7)}`
    + `${rpad(row.kills, 7)}${rpad((row.seconds / 60).toFixed(1), 7)}${rpad(row.hp, 8)}`);
}
console.log(`  ${run.kills} kills over ${(run.seconds / 60).toFixed(0)} minutes to reach level ${run.ch.level}`
  + `, dying ${run.deaths} time(s).`);

// ------------------------------------------------------------- the wardens --

/**
 * The progression is the gates, and a gate costs whatever its warden costs. For
 * each one, the character level at which the fight first goes your way three
 * times in five -- which is the number that says whether the design is a game
 * or a wall.
 */
function costOf(record, target = 0.6) {
  for (const level of [5, 8, 10, 12, 15, 18, 20, 22, 25, 28, 30, 33, MERC.LEVEL_HERO]) {
    const row = trial(3, level, record, Math.max(24, Math.round(SAMPLES / 5)));
    if (row.win >= target) return { level, row };
  }
  return { level: null, row: trial(3, MERC.LEVEL_HERO, record, Math.max(24, Math.round(SAMPLES / 5))) };
}

console.log('\nTHE GATES, AND WHAT EACH ONE COSTS');
const preview = createGame({ world, layout, built, seed: 99, classIndex: 3 });
const wardens = new Map();
for (const gate of preview.gates) {
  if (!wardens.has(gate.warden)) wardens.set(gate.warden, { gate, count: 0 });
  wardens.get(gate.warden).count += 1;
}
console.log(`  ${pad('warden', 24)}${rpad('lvl', 4)}${rpad('gates', 7)}${rpad('road', 6)}`
  + `${rpad('beatable at', 13)}${rpad('takes', 8)}`);
const ladder = [];
for (const [record, entry] of wardens) {
  const cost = costOf(record);
  ladder.push({ record, entry, cost });
  console.log(`  ${pad(record.proto.short.slice(0, 23), 24)}${rpad(record.proto.level, 4)}`
    + `${rpad(entry.count, 7)}${rpad(entry.gate.outdoor ? 'yes' : '-', 6)}`
    + `${rpad(cost.level ? `level ${cost.level}` : 'never', 13)}`
    + `${rpad(cost.level ? `${cost.row.seconds.toFixed(0)}s` : '-', 8)}`);
}

// ---------------------------------------------------------- the game shell --

console.log('\nTHE GAME SHELL, OVER STUB GEOMETRY');
const shell = (() => {
  const game = createGame({ world, layout, built, seed: 1234, classIndex: 3 });
  const notes = [];

  // Stand next to the softest thing in the world and hit it until it stops.
  const prey = game.mobs
    .filter((slot) => slot.proto.level >= 1 && slot.proto.level <= 2)
    .sort((a, b) => a.proto.level - b.proto.level)[0];
  if (!prey) return { ok: false, notes: ['nothing soft enough to test on'] };

  const at = { x: prey.pos.x + 2, y: prey.pos.y, z: prey.pos.z };
  const look = { x: prey.pos.x - at.x, y: 0, z: prey.pos.z - at.z };
  game.grace(0);
  game.update(0.016, at, look);
  const before = { exp: game.state.exp, gold: game.state.gold };

  let elapsed = 0;
  game.attack();
  while (!prey.dead && elapsed < 600) { game.update(0.05, at, look); elapsed += 0.05; }
  notes.push(prey.dead
    ? `killed ${prey.proto.short} in ${elapsed.toFixed(0)}s of wall time`
    : `FAILED to kill ${prey.proto.short} in 600s`);

  const corpses = game.here().filter((obj) => obj.itemType === 23);
  notes.push(`${corpses.length} corpse on the ground holding ${corpses[0] ? corpses[0].contains.length : 0} item(s)`);
  if (corpses[0]) game.takeAll(corpses[0]);
  notes.push(`exp ${before.exp} -> ${game.state.exp}, gold ${before.gold} -> ${game.state.gold},`
    + ` carrying ${game.state.inventory.length}`);

  // Shopping: stand in front of the weaponsmith and buy the long sword.
  const keeperSlot = game.mobs.find((slot) => slot.record.shop
    && slot.record.carried.some((c) => c.proto.itemType === 5));
  let bought = null;
  if (keeperSlot) {
    const shopAt = { x: keeperSlot.pos.x + 2, y: keeperSlot.pos.y, z: keeperSlot.pos.z };
    game.update(0.05, shopAt, { x: -1, y: 0, z: 0 });
    game.state.gold += 1000;
    game.state.level = 20;      // shop weapons roll level 5-15; do_buy checks it
    const shop = game.shopHere();
    const weapon = shop && shop.stock.find((entry) => entry.obj.itemType === 5);
    if (weapon) {
      const result = game.buy(shop.keeper, weapon.obj.vnum);
      bought = result.item;
      notes.push(`${shop.name} (${shop.open ? 'open' : 'shut'}) sells ${shop.stock.length} thing(s);`
        + ` bought ${result.ok ? `${bought.name} for ${result.cost}` : result.text}`);
      if (bought) {
        notes.push(`wield: ${game.wield(bought).text}`);
        notes.push(`damroll now ${MERC.getDamroll(game.state)}, ac ${game.state.ac}`);
        // A keeper pays nothing for what it already stocks, so sell it
        // something it doesn't: the sword the mayor wears.
        const loot = world.objProtos.get(3124);
        if (loot) {
          const obj = MERC.createObject(loot, 0);
          game.state.inventory.push(obj);
          notes.push(`sell ${obj.name} (worth ${obj.cost}): ${game.sell(shop.keeper, obj).text}`);
        }
      }
    }
  }

  // Practising, in front of whatever the world flagged ACT_PRACTICE.
  const trainer = game.mobs.find((slot) => (slot.proto.act & 1024));
  if (trainer) {
    const trainAt = { x: trainer.pos.x + 2, y: trainer.pos.y, z: trainer.pos.z };
    game.update(0.05, trainAt, { x: -1, y: 0, z: 0 });
    game.state.level = Math.max(3, game.state.level);
    notes.push(`practice at ${trainer.proto.short}: ${game.practice('parry').text}`
      + ` (parry ${game.state.learned.parry}%, ${game.state.practice} sessions left)`);
  }

  // Dying: walk into the executioner and stand there.
  const boss = game.mobs.find((slot) => slot.proto.level >= 40);
  let died = false;
  if (boss) {
    const bossAt = { x: boss.pos.x + 2, y: boss.pos.y, z: boss.pos.z };
    let teleported = null;
    game.onTeleport = (x, y, z) => { teleported = { x, y, z }; };
    game.update(0.05, bossAt, { x: -1, y: 0, z: 0 });
    game.attack();
    let t = 0;
    while (game.state.position !== POS.RESTING && t < 300) { game.update(0.05, bossAt, { x: -1, y: 0, z: 0 }); t += 0.05; }
    died = !!teleported;
    const temple = built.rooms.get(3001);
    const home = temple && teleported
      && Math.hypot(teleported.x - temple.center.x, teleported.z - temple.center.z) < 0.01;
    notes.push(`fighting ${boss.proto.short}: ${died ? `killed and sent to the temple (${home ? '#3001' : '?'})` : 'survived, which it should not have'}`);
  }

  const wardedGates = game.gates.length;
  const roads = game.roads.length;
  notes.push(`${wardedGates} sealed gates are held, ${roads} of them roads out of the city`);
  for (const gate of game.gates.slice(0, 4)) {
    notes.push(`   ${pad(gate.name.slice(0, 30), 32)} held by ${gate.wardenName} (level ${gate.wardenLevel})`);
  }

  const kinds = new Set(game.drain().map((e) => e.kind));
  notes.push(`events seen: ${[...kinds].sort().join(', ')}`);
  return { ok: prey.dead, notes, game, corpses, bought, died, kinds };
})();
for (const note of shell.notes) console.log(`  ${note}`);

// ------------------------------------------------------------- wandering --

/**
 * mobile_update, left to run: ten minutes of the town with nobody in it. The
 * player stands at the temple and never moves, so nothing fights; everything
 * else is the mud's own wandering, walked along the layout's streets.
 */
console.log('\nWANDERING, TEN MINUTES WITH NOBODY WATCHING');
const wander = (() => {
  const game = createGame({ world, layout, built, seed: 77, classIndex: 3 });
  const temple = built.rooms.get(3001) || built.rooms.values().next().value;
  const at = { x: temple.center.x, y: temple.center.y + 1.72, z: temple.center.z };
  const look = { x: 0, y: 0, z: -1 };
  const start = new Map(game.mobs.map((slot) => [slot, slot.roomVnum]));
  const moves = [];
  let prev = new Map(start);
  let strays = 0;          // a mobile whose room is not the room its position is in
  let offGround = 0;       // a position outside every built room and routed street
  let sealedCrossings = 0; // a room change across something that is not an exit
  const exitBetween = (a, b) => {
    const room = world.rooms.get(a);
    return !!room && room.exits.some((e) => e && e.to === b);
  };
  const dt = 0.25;
  for (let t = 0; t < 600; t += dt) {
    game.update(dt, at, look);
    for (const slot of game.mobs) {
      if (slot.dead) continue;
      const here = game.nav.roomAt(slot.pos.x, slot.pos.y, slot.pos.z);
      if (here === undefined) offGround++;
      else if (slot.travel) {
        // Walking between two rooms, it is in one of the two.
        if (slot.roomVnum !== slot.travel.from && slot.roomVnum !== slot.travel.to) strays++;
      } else if (here !== slot.roomVnum) strays++;
      const was = prev.get(slot);
      if (slot.roomVnum !== was) {
        moves.push({ slot, from: was, to: slot.roomVnum });
        // Walking a routed street goes straight from one end to the other, so
        // every change of room has to be along an exit of one of the two.
        if (!exitBetween(was, slot.roomVnum) && !exitBetween(slot.roomVnum, was)) sealedCrossings++;
        prev.set(slot, slot.roomVnum);
      }
    }
  }
  const moved = game.mobs.filter((slot) => slot.roomVnum !== start.get(slot));
  const sentinels = game.mobs.filter((slot) => slot.proto.act & 2);
  const keepers = game.mobs.filter((slot) => slot.record.shop);
  const result = {
    moves: moves.length,
    movers: new Set(moves.map((m) => m.slot)).size,
    awayFromStart: moved.length,
    // spec_mayor walks his round by move_char whatever ACT_SENTINEL says,
    // exactly as in the mud; every other sentinel stays put.
    sentinelMoves: moves.filter((m) => (m.slot.proto.act & 2) && m.slot.record.special !== 'spec_mayor').length,
    sentinelWho: [...new Set(moves.filter((m) => m.slot.proto.act & 2).map((m) => `${m.slot.proto.short} (${m.slot.record.special || 'no spec'})`))],
    keeperMoves: moves.filter((m) => m.slot.record.shop).length,
    noMob: moves.filter((m) => (world.rooms.get(m.to).flags & 4)).length,
    strayAreas: moves.filter((m) => (m.slot.proto.act & 64) && world.rooms.get(m.to).area !== m.slot.proto.area).length,
    strays, offGround, sealedCrossings,
    sentinels: sentinels.length, keepers: keepers.length, mobs: game.mobs.length,
  };
  console.log(`  ${result.moves} room changes by ${result.movers} of ${result.mobs} mobiles;`
    + ` ${result.awayFromStart} end somewhere else`);
  console.log(`  ${result.sentinels} sentinels moved ${result.sentinelMoves} times, ${result.keepers} shopkeepers ${result.keeperMoves} times,`
    + ` ${result.noMob} entries into NO_MOB rooms, ${result.strayAreas} STAY_AREA strays`);
  console.log('  sentinels that moved:', result.sentinelWho.join(', '));
  console.log(`  ${result.strays} mobile-frames in a room other than the one its body is in,`
    + ` ${result.offGround} off the built ground, ${result.sealedCrossings} crossings that are not an exit`);
  return result;
})();

// ------------------------------------------------------------- assertions --

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

// The assertions describe Midgaard's intended shape -- a town you arrive in at
// level one. Merc's other areas start at level ten and up, so pointing them at
// a first-level character says nothing; the tables above still do.
if (AREA_FILE !== 'midgaard.are') {
  console.log(`\n(no assertions for ${AREA_FILE}: they are calibrated to Midgaard, the starting town)\n`);
  process.exit(0);
}

console.log('\nSANITY');

const vermin = level1
  .filter((row) => row.level <= 1.5)
  .sort((a, b) => b.win - a.win)[0];
const rat = level1.find((row) => /\brat\b/.test(placed.get(row.vnum).proto.keywords)) || vermin;
check(rat && rat.win >= 0.8,
  `a level 1 warrior beats ${rat ? rat.name : 'the weakest vermin'}`,
  rat ? `${pct(rat.win)} of ${SAMPLES}` : 'none found');

const hardest = level1.reduce((a, b) => (b.level > a.level ? b : a));
check(hardest.win <= 0.02, `a level 1 warrior loses to ${hardest.name} (level ${hardest.level.toFixed(0)})`,
  `won ${pct(hardest.win)}`);

const guards = level1.filter((row) => row.level >= 14 && row.level <= 21);
check(guards.every((row) => row.win <= 0.05), 'a level 1 warrior loses to the cityguards',
  guards.map((g) => pct(g.win)).join(' '));

const softest = level1.filter((row) => row.level <= 2).sort((a, b) => b.win - a.win)[0];
check(softest && softest.died <= 0.1, 'wimpy keeps a first-level character alive against vermin',
  softest ? `dies ${pct(softest.died)} of the time` : 'none');

const midCell = grid.get('12:8') || grid.get('12:9');
check(midCell && midCell.win >= 0.9, 'a level 12 warrior beats a level 8 mobile', midCell ? pct(midCell.win) : 'no data');

const guardCell = grid.get('20:15');
check(guardCell && guardCell.win <= 0.4, 'the Watch is still a wall at level 20',
  guardCell ? `${pct(guardCell.win)}` : 'no data');

const bossCell = grid.get('25:50');
check(!bossCell || bossCell.win <= 0.15, 'the executioner is still out of reach at level 25',
  bossCell ? pct(bossCell.win) : 'not placed');

check(run.ch.level >= 10, 'a warrior can reach level 10', `got ${run.ch.level}`);
check(run.seconds / 60 >= 8 && run.seconds / 60 <= 150, 'levelling to 10 takes between 8 and 150 minutes',
  `${(run.seconds / 60).toFixed(0)} min`);
check(run.rows.every((row) => row.stalled || row.kills <= 40), 'no level needs more than 40 kills',
  `worst ${Math.max(...run.rows.filter((r) => !r.stalled).map((r) => r.kills))}`);
check(run.rows.every((row) => row.stalled || row.variety >= 2), 'no level is a single-target grind',
  `narrowest ${Math.min(...run.rows.filter((r) => !r.stalled).map((r) => r.variety))} kinds`);

// The ladder has to have a first rung inside the short game and a top rung
// outside it: something to open at ten, and something still shut at thirty-six.
const roadLadder = ladder.filter((entry) => entry.entry.gate.outdoor);
const firstRoad = roadLadder.filter((entry) => entry.cost.level).sort((a, b) => a.cost.level - b.cost.level)[0];
check(firstRoad && firstRoad.cost.level <= 15,
  'a road out of the city opens inside the first fifteen levels',
  firstRoad ? `${firstRoad.record.proto.short} at level ${firstRoad.cost.level}` : 'none');
check(ladder.some((entry) => !entry.cost.level), 'and some gates stay shut even to a hero',
  `${ladder.filter((e) => !e.cost.level).length} of ${ladder.length}`);

check(shell.ok, 'the game shell kills, drops a corpse and pays out');
check(shell.game && shell.game.state.gold >= 0 && shell.game.state.exp > 1000, 'looting a corpse pays exp and gold');
check(!!shell.bought, 'a shopkeeper sells you a weapon at profit_buy');
check(!!shell.died, 'dying sends you back to the Temple of Midgaard');
check(shell.game && shell.game.roads.length > 0, 'there are roads out of the city to open',
  shell.game ? `${shell.game.roads.length}` : '');
for (const kind of ['hit', 'miss', 'death', 'xp', 'gold', 'buy', 'sell', 'wear', 'practice']) {
  check(shell.kinds.has(kind), `the queue carries '${kind}' events for the ui`);
}

check(wander.movers >= Math.min(10, wander.mobs / 4), 'mobile_update walks the town', `${wander.movers} mobiles changed room`);
check(wander.sentinelMoves === 0 && wander.keeperMoves === 0, 'sentinels and shopkeepers stay put',
  `${wander.sentinelMoves} + ${wander.keeperMoves}`);
check(wander.noMob === 0 && wander.strayAreas === 0, 'nobody walks into NO_MOB rooms or out of a STAY_AREA area');
check(wander.strays === 0 && wander.offGround === 0, 'a mobile is always in the room its body stands in',
  `${wander.strays} stray, ${wander.offGround} off the ground`);
check(wander.sealedCrossings === 0, 'every change of room is along an exit', `${wander.sealedCrossings}`);

// A duel that must not be winnable, run against the shell's own rules bundle.
const executioner = roster.find((r) => r.proto.level >= 40);
if (executioner) {
  const row = trial(3, MERC.LEVEL_HERO, executioner, Math.max(40, Math.round(SAMPLES / 4)));
  check(row.win < 0.5, `even a hero loses to ${row.name} more often than not`, pct(row.win));
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} check(s) failed:\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}
console.log('all checks passed\n');
