/**
 * The game: Merc 2.1's rules, running in real time.
 *
 * Nothing here is balanced by hand. The tables are transcribed out of
 * `merc21/src/const.c` and `merc.h`, and the arithmetic is `fight.c`,
 * `update.c`, `act_obj.c` and `db.c` line for line -- including the parts that
 * look wrong (Merc rolls a mobile's hitpoints from its *level*, not from the
 * hitdice in the area file; `db.c` marks those columns "Unused").
 *
 * Two things a mud gets for free that a first-person game does not:
 *
 *   - Rooms. The mud asks "same room?"; here it is metres. `MELEE`, `AGGRO`
 *     and `BREAK` below stand in for room adjacency, and walking out of `BREAK`
 *     is `do_flee` -- with the mud's own 25 exp penalty.
 *   - Turns. The mud pulses four times a second and swings every twelfth pulse.
 *     That clock is kept exactly; `update` just feeds it wall time.
 *
 * Every other divergence is marked DIVERGES in a comment next to the code.
 *
 * No three.js in here on purpose: the whole rules half has to be runnable under
 * plain node, which is what `tools/game-check.mjs` does.
 */

import {
  ACT_SENTINEL, ACT_AGGRESSIVE, ACT_PRACTICE, ACT_SCAVENGER, ITEM,
  ROOM_NO_MOB, ROOM_PRIVATE, ROOM_SOLITARY, DIR_NAME, EX_CLOSED, EX_LOCKED,
  SECTOR, REVERSE_DIR,
} from './are.js';
import { createNav } from './nav.js';
import { openAirIn, shellAttrs } from './shells.js';
import {
  COND, OBJ_VNUM, ITEM_TAKE, LEVEL_IMMORTAL, createMoney, makeObject, hasAff, canSee,
  objWeight, objNumber,
} from './rules/handler.js';
import { installRules } from './rules/index.js';
import { createMagic, SPELL_SKILLS, SPELL, TAR, AFF, ROOM_REACH, ensureMagic } from './magic.js';

// --------------------------------------------------------------- merc.h ----

const PULSE_PER_SECOND = 4;
const PULSE_VIOLENCE = 3 * PULSE_PER_SECOND;
const PULSE_TICK = 30 * PULSE_PER_SECOND;
const PULSE_MOBILE = 4 * PULSE_PER_SECOND;
const PULSE_AREA = 60 * PULSE_PER_SECOND;

const MAX_LEVEL = 40;
const LEVEL_HERO = MAX_LEVEL - 4;
const MAX_WEAR = 18;
const TYPE_HIT = 1000;

const ROOM_VNUM_TEMPLE = 3001;

export const POS = {
  DEAD: 0, MORTAL: 1, INCAP: 2, STUNNED: 3,
  SLEEPING: 4, RESTING: 5, FIGHTING: 6, STANDING: 7,
};

export const WEAR = {
  NONE: -1, LIGHT: 0, FINGER_L: 1, FINGER_R: 2, NECK_1: 3, NECK_2: 4,
  BODY: 5, HEAD: 6, LEGS: 7, FEET: 8, HANDS: 9, ARMS: 10, SHIELD: 11,
  ABOUT: 12, WAIST: 13, WRIST_L: 14, WRIST_R: 15, WIELD: 16, HOLD: 17,
};

/** merc.h: SKY_*, the four states weather_update walks between. */
export const SKY = { CLOUDLESS: 0, CLOUDY: 1, RAINING: 2, LIGHTNING: 3 };

/** How each slot reads in `equipment`, in the mud's own wording. */
export const WEAR_NAME = [
  'light', 'finger', 'finger', 'neck', 'neck', 'body', 'head', 'legs', 'feet',
  'hands', 'arms', 'shield', 'about body', 'waist', 'wrist', 'wrist',
  'wielded', 'held',
];

/** ITEM_WEAR_* / ITEM_WIELD / ITEM_HOLD, the object's wear_flags. */
const W = {
  TAKE: 1, FINGER: 2, NECK: 4, BODY: 8, HEAD: 16, LEGS: 32, FEET: 64,
  HANDS: 128, ARMS: 256, SHIELD: 512, ABOUT: 1024, WAIST: 2048, WRIST: 4096,
  WIELD: 8192, HOLD: 16384,
};

/** ITEM_* extra_flags. */
const X = { NODROP: 128, NOREMOVE: 4096, INVENTORY: 8192 };

const ACT_WIMPY = 128;
const ACT_STAY_AREA = 64;

const APPLY = {
  NONE: 0, STR: 1, DEX: 2, INT: 3, WIS: 4, CON: 5, MANA: 12, HIT: 13,
  MOVE: 14, AC: 17, HITROLL: 18, DAMROLL: 19,
};

// --------------------------------------------------------------- const.c ----

/** class_table. thac0 is interpolated between level 0 and level 32. */
export const CLASS_TABLE = [
  { name: 'mage', who: 'Mag', attrPrime: APPLY.INT, guild: 3018, skillAdept: 95, thac00: 18, thac032: 10, hpMin: 6, hpMax: 8, mana: true },
  { name: 'cleric', who: 'Cle', attrPrime: APPLY.WIS, guild: 3003, skillAdept: 95, thac00: 18, thac032: 12, hpMin: 7, hpMax: 10, mana: true },
  { name: 'thief', who: 'Thi', attrPrime: APPLY.DEX, guild: 3028, skillAdept: 85, thac00: 18, thac032: 8, hpMin: 8, hpMax: 13, mana: false },
  { name: 'warrior', who: 'War', attrPrime: APPLY.STR, guild: 3022, skillAdept: 85, thac00: 18, thac032: 6, hpMin: 11, hpMax: 15, mana: false },
];

/** str_app: [tohit, todam, carry, wield]. */
const STR_APP = [
  [-5, -4, 0, 0], [-5, -4, 3, 1], [-3, -2, 3, 2], [-3, -1, 10, 3],
  [-2, -1, 25, 4], [-2, -1, 55, 5], [-1, 0, 80, 6], [-1, 0, 90, 7],
  [0, 0, 100, 8], [0, 0, 100, 9], [0, 0, 115, 10], [0, 0, 115, 11],
  [0, 0, 140, 12], [0, 0, 140, 13], [0, 1, 170, 14], [1, 1, 170, 15],
  [1, 2, 195, 16], [2, 3, 220, 22], [2, 4, 250, 25], [3, 5, 400, 30],
  [3, 6, 500, 35], [4, 7, 600, 40], [5, 7, 700, 45], [6, 8, 800, 50],
  [8, 10, 900, 55], [10, 12, 999, 60],
];

/** int_app.learn -- percent gained per practice session. */
const INT_APP = [3, 5, 7, 8, 9, 10, 11, 12, 13, 15, 17, 19, 22, 25, 28, 31, 34, 37, 40, 44, 49, 55, 60, 70, 85, 99];

/** wis_app.practice -- practice sessions gained per level. */
const WIS_APP = [0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 4, 5, 5, 5, 6, 6, 6, 6, 7];

/** dex_app.defensive -- added straight onto armour class. */
const DEX_APP = [60, 50, 50, 40, 30, 20, 10, 0, 0, 0, 0, 0, 0, 0, 0, -10, -15, -20, -30, -40, -50, -60, -75, -90, -105, -120];

/** con_app: [hitp, shock]. */
const CON_APP = [
  [-4, 20], [-3, 25], [-2, 30], [-2, 35], [-1, 40], [-1, 45], [-1, 50],
  [0, 55], [0, 60], [0, 65], [0, 70], [0, 75], [0, 80], [0, 85], [0, 88],
  [1, 90], [2, 95], [2, 97], [3, 99], [3, 99], [4, 99], [4, 99], [5, 99],
  [6, 99], [7, 99], [8, 99],
];

/**
 * The combat half of skill_table: name, the level each class may first practise
 * it at (mage, cleric, thief, warrior -- 37 is past LEVEL_HERO, so never), and
 * whether fight.c consults it.
 */
export const SKILLS = [
  { key: 'secondAttack', name: 'second attack', level: [37, 37, 1, 1] },
  { key: 'thirdAttack', name: 'third attack', level: [37, 37, 37, 1] },
  { key: 'parry', name: 'parry', level: [37, 37, 37, 1] },
  { key: 'dodge', name: 'dodge', level: [37, 37, 1, 37] },
  { key: 'enhancedDamage', name: 'enhanced damage', level: [37, 37, 37, 1] },
  { key: 'kick', name: 'kick', level: [37, 37, 37, 1] },
  { key: 'disarm', name: 'disarm', level: [37, 37, 10, 37] },
  // The rest of const.c's non-spell skills: what act_move.c, act_obj.c and
  // fight.c's do_* commands roll against.
  { key: 'backstab', name: 'backstab', level: [37, 37, 1, 37] },
  { key: 'hide', name: 'hide', level: [37, 37, 1, 37] },
  { key: 'peek', name: 'peek', level: [37, 37, 1, 37] },
  { key: 'pickLock', name: 'pick lock', level: [37, 37, 1, 37] },
  { key: 'rescue', name: 'rescue', level: [37, 37, 37, 1] },
  { key: 'sneak', name: 'sneak', level: [37, 37, 1, 37] },
  { key: 'steal', name: 'steal', level: [37, 37, 1, 37] },
];

/** Everything do_practice lists: the combat skills above and magic.js's spells. */
const ALL_SKILLS = SKILLS.concat(SPELL_SKILLS);

/** dam_message's attack_table, indexed by a weapon's value[3]. */
const ATTACK_TABLE = [
  'hit', 'slice', 'stab', 'slash', 'whip', 'claw',
  'blast', 'pound', 'crush', 'grep', 'bite', 'pierce', 'suction',
];

// ------------------------------------------------------------------ maths ----

/** C integer division truncates toward zero; Math.floor does not. */
const idiv = (a, b) => Math.trunc(a / b);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** db.c: interpolate. */
const interpolate = (level, v00, v32) => v00 + idiv(level * (v32 - v00), 32);

/**
 * db.c's Mitchell-Moore generator, replaced by an xorshift of the same shape:
 * what matters downstream is `number_bits`, and every consumer of it here
 * (`number_range`, `number_percent`, `number_fuzzy`) keeps Merc's exact
 * rejection loops, so the distributions come out the same.
 */
export class Rng {
  constructor(seed) {
    this.seeded = seed !== undefined;
    this.s = (seed >>> 0) || 0x2545f491;
  }

  raw() {
    if (!this.seeded) return Math.floor(Math.random() * 0x40000000);
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x >>> 2;
  }

  bits(width) { return this.raw() & ((1 << width) - 1); }

  range(from, to) {
    let span = to - from + 1;
    if (span <= 1) return from;
    let power = 2;
    while (power < span) power <<= 1;
    let n;
    do { n = this.raw() & (power - 1); } while (n >= span);
    return from + n;
  }

  percent() {
    let n;
    do { n = this.raw() & 127; } while (n >= 100);
    return 1 + n;
  }

  fuzzy(n) {
    switch (this.bits(2)) {
      case 0: n -= 1; break;
      case 3: n += 1; break;
      default: break;
    }
    return Math.max(1, n);
  }
}

// -------------------------------------------------------- character maths ----

const isNpc = (ch) => ch.npc === true;
const isAwake = (ch) => ch.position > POS.SLEEPING;
const isGood = (ch) => ch.alignment >= 350;
const isEvil = (ch) => ch.alignment <= -350;

function currStat(ch, apply, perm, mod) {
  if (isNpc(ch)) return 13;
  const max = CLASS_TABLE[ch.class].attrPrime === apply ? 25 : 20;
  return clamp(perm + mod, 3, max);
}
const currStr = (ch) => currStat(ch, APPLY.STR, ch.permStr, ch.modStr);
const currInt = (ch) => currStat(ch, APPLY.INT, ch.permInt, ch.modInt);
const currWis = (ch) => currStat(ch, APPLY.WIS, ch.permWis, ch.modWis);
const currDex = (ch) => currStat(ch, APPLY.DEX, ch.permDex, ch.modDex);
const currCon = (ch) => currStat(ch, APPLY.CON, ch.permCon, ch.modCon);

const getAc = (ch) => ch.armor + (isAwake(ch) ? DEX_APP[currDex(ch)] : 0);
const getHitroll = (ch) => ch.hitroll + STR_APP[currStr(ch)][0];
const getDamroll = (ch) => ch.damroll + STR_APP[currStr(ch)][1];

const canCarryN = (ch) => MAX_WEAR + idiv(2 * currDex(ch), 3);
const canCarryW = (ch) => STR_APP[currStr(ch)][2];

/** fight.c: update_pos. */
function updatePos(victim) {
  if (victim.hit > 0) {
    if (victim.position <= POS.STUNNED) victim.position = POS.STANDING;
    return;
  }
  if (isNpc(victim) || victim.hit <= -11) { victim.position = POS.DEAD; return; }
  if (victim.hit <= -6) victim.position = POS.MORTAL;
  else if (victim.hit <= -3) victim.position = POS.INCAP;
  else victim.position = POS.STUNNED;
}

/**
 * act_info.c: show_char_to_char_1's health line, with the verb the mud puts in
 * front of it ("is"/"has") left off so it reads as a label.
 */
export function condition(ch) {
  const percent = ch.maxHit > 0 ? idiv(100 * ch.hit, ch.maxHit) : -1;
  if (percent >= 100) return 'perfect health';
  if (percent >= 90) return 'slightly scratched';
  if (percent >= 80) return 'a few bruises';
  if (percent >= 70) return 'some cuts';
  if (percent >= 60) return 'several wounds';
  if (percent >= 50) return 'many nasty wounds';
  if (percent >= 40) return 'bleeding freely';
  if (percent >= 30) return 'covered in blood';
  if (percent >= 20) return 'leaking guts';
  if (percent >= 10) return 'almost dead';
  return 'DYING';
}

/** act_info.c: do_score's armour line, which says it better than a number. */
export function armourWord(ch) {
  const ac = getAc(ch);
  if (ac >= 101) return 'WORSE than naked';
  if (ac >= 80) return 'naked';
  if (ac >= 60) return 'wearing clothes';
  if (ac >= 40) return 'slightly armored';
  if (ac >= 20) return 'somewhat armored';
  if (ac >= 0) return 'armored';
  if (ac >= -20) return 'well armored';
  if (ac >= -40) return 'strongly armored';
  if (ac >= -60) return 'heavily armored';
  if (ac >= -80) return 'superbly armored';
  if (ac >= -100) return 'divinely armored';
  return 'invincible';
}

// ---------------------------------------------------------- the character ----

/**
 * comm.c's nanny at CON_READ_MOTD: a level 1 character is 20 hp, 100 mana,
 * 100 move, armour 100, 21 practices, 1000 exp, and 16 in its prime attribute.
 * `level` above 1 runs advance_level the rest of the way, which is how the
 * harness makes a level 12 warrior without playing one.
 */
export function createCharacter(classIndex, { level = 1, sex = 1, rng = new Rng() } = {}) {
  const ch = {
    npc: false,
    class: classIndex,
    className: CLASS_TABLE[classIndex].name,
    name: 'you',
    sex,
    level: 1,
    exp: 1000,
    alignment: 0,
    gold: 0,
    practice: 21,
    armor: 100,
    hitroll: 0,
    damroll: 0,
    position: POS.STANDING,
    hit: 20, maxHit: 20,
    mana: 100, maxMana: 100,
    move: 100, maxMove: 100,
    permStr: 13, permInt: 13, permWis: 13, permDex: 13, permCon: 13,
    modStr: 0, modInt: 0, modWis: 0, modDex: 0, modCon: 0,
    wimpy: 0,
    inventory: [],
    equipment: new Array(MAX_WEAR).fill(null),
    learned: {},
    fighting: null,
    // pcdata->condition, as nanny leaves it: sober, fed and watered.
    condition: [0, 48, 48],
    act: 0,
    affectedBy: 0,
    affected: [],
    // WAIT_STATE, in pulses: what a skill costs you in time before the next.
    wait: 0,
  };
  for (const skill of ALL_SKILLS) ch.learned[skill.key] = 0;
  ensureMagic(ch);

  switch (CLASS_TABLE[classIndex].attrPrime) {
    case APPLY.STR: ch.permStr = 16; break;
    case APPLY.INT: ch.permInt = 16; break;
    case APPLY.WIS: ch.permWis = 16; break;
    case APPLY.DEX: ch.permDex = 16; break;
    case APPLY.CON: ch.permCon = 16; break;
    default: break;
  }
  // DIVERGES: the mud starts every spell at 0% and will not let you practise
  // before third level, so a new mage's one spell fails every time for two
  // levels. A caster starts with its first-level spells at what one session
  // at the guild buys (int_app.learn); everything later is practised as usual.
  for (const skill of SPELL_SKILLS) if (skill.level[classIndex] === 1) ch.learned[skill.key] = INT_APP[currInt(ch)];

  while (ch.level < level && ch.level < LEVEL_HERO) {
    ch.level += 1;
    advanceLevel(ch, rng);
  }
  ch.hit = ch.maxHit;
  ch.mana = ch.maxMana;
  ch.move = ch.maxMove;
  ch.exp = Math.max(ch.exp, 1000 * ch.level);
  // `wimpy` with no argument is max_hit/5 in act_info.c, and standing wimpy is
  // the difference between backing off at a fifth of your health and being
  // beaten to death while stunned -- which is what happens when there is no
  // second player in the room to drag you out.
  ch.wimpy = idiv(ch.maxHit, 5);
  return ch;
}

/** update.c: advance_level. Returns what the mud prints as "Your gain is". */
export function advanceLevel(ch, rng) {
  const klass = CLASS_TABLE[ch.class];
  let addHp = CON_APP[currCon(ch)][0] + rng.range(klass.hpMin, klass.hpMax);
  let addMana = klass.mana ? rng.range(2, idiv(2 * currInt(ch) + currWis(ch), 8)) : 0;
  let addMove = rng.range(5, idiv(currCon(ch) + currDex(ch), 4));
  const addPrac = WIS_APP[currWis(ch)];

  addHp = Math.max(1, addHp);
  addMana = Math.max(0, addMana);
  addMove = Math.max(10, addMove);

  ch.maxHit += addHp;
  ch.maxMana += addMana;
  ch.maxMove += addMove;
  ch.practice += addPrac;
  ch.wimpy = idiv(ch.maxHit, 5);   // the mud makes you re-type `wimpy`; this doesn't
  return { hp: addHp, mana: addMana, move: addMove, prac: addPrac };
}

/** update.c: gain_exp. Merc's whole level curve is 1000 exp a level, flat. */
export function gainExp(ch, gain, rng, onLevel) {
  if (isNpc(ch) || ch.level >= LEVEL_HERO) return;
  ch.exp = Math.max(1000, ch.exp + gain);
  while (ch.level < LEVEL_HERO && ch.exp >= 1000 * (ch.level + 1)) {
    ch.level += 1;
    const gains = advanceLevel(ch, rng);
    if (onLevel) onLevel(gains);
  }
}

export const expToLevel = (ch) => Math.max(0, 1000 * (ch.level + 1) - ch.exp);

/**
 * update.c: hit_gain, mana_gain, move_gain. A player's come off level and
 * position, halved for an empty stomach and again for a dry throat; poison
 * quarters anyone's.
 */
function regain(ch, npcGain, base, sleeping, resting, max, current) {
  let gain;
  if (isNpc(ch)) gain = npcGain;
  else {
    gain = base;
    if (ch.position === POS.SLEEPING) gain += sleeping;
    else if (ch.position === POS.RESTING) gain += resting;
    if (ch.condition[1] === 0) gain = idiv(gain, 2);
    if (ch.condition[2] === 0) gain = idiv(gain, 2);
  }
  if (hasAff(ch, AFF.POISON)) gain = idiv(gain, 4);
  return Math.min(gain, max - current);
}
export const hitGain = (ch) => regain(ch, idiv(ch.level * 3, 2), Math.min(5, ch.level),
  currCon(ch), idiv(currCon(ch), 2), ch.maxHit, ch.hit);
export const manaGain = (ch) => regain(ch, ch.level, Math.min(5, idiv(ch.level, 2)),
  currInt(ch) * 2, currInt(ch), ch.maxMana, ch.mana);
export const moveGain = (ch) => regain(ch, ch.level, Math.max(15, 2 * ch.level),
  currDex(ch), idiv(currDex(ch), 2), ch.maxMove, ch.move);

// ------------------------------------------------------------- the mobile ----

/**
 * db.c: create_mobile.
 *
 * The area file's hitroll, armour class, hitdice, damdice, gold and exp columns
 * are all read and thrown away -- `load_mobiles` writes "Unused" against every
 * one of them, and everything a Merc mobile is comes off its level instead.
 * That is reproduced here rather than corrected.
 *
 * DIVERGES: gold. Merc leaves `ch->gold` at zero, so nothing you kill ever
 * drops a coin and the shops might as well not exist. The area file does carry
 * a gold figure per mobile -- the "old-style stats-in-files method" db.c's own
 * comment points at -- so that column is honoured here, and only that one.
 */
export function createMobile(proto, loadLevel, rng) {
  const level = rng.fuzzy(loadLevel);
  const mob = {
    npc: true,
    proto,
    vnum: proto.vnum,
    name: proto.short,
    keywords: proto.keywords,
    long: proto.long,
    description: proto.description,
    level,
    act: proto.act,
    affectedBy: proto.affected,
    alignment: proto.alignment,
    sex: proto.sex,
    armor: interpolate(level, 100, -100),
    hitroll: 0,
    damroll: 0,
    position: POS.STANDING,
    fighting: null,
    gold: proto.gold,
    equipment: new Array(MAX_WEAR).fill(null),
    inventory: [],
    affected: [],
  };
  mob.maxHit = level * 8 + rng.range(idiv(level * level, 4), level * level);
  mob.hit = mob.maxHit;
  return mob;
}

// ---------------------------------------------------------------- objects ----

/** db.c: create_object, for the shape of it that matters here. */
export function createObject(proto, level) {
  return {
    proto,
    vnum: proto.vnum,
    name: proto.short,
    keywords: proto.keywords,
    itemType: proto.itemType,
    extraFlags: proto.extraFlags,
    wearFlags: proto.wearFlags,
    values: proto.values.slice(),
    weight: proto.weight,
    cost: proto.cost,
    level,
    wearLoc: WEAR.NONE,
    affects: proto.affects || [],
    timer: 0,
    description: proto.long,
    // Where it is: in a container (`contains` of another), or lying in a
    // room at a point on the floor. Carried objects have neither.
    contains: [],
    inRoom: null,
    at: null,
  };
}

/** handler.c: apply_ac. Only ITEM_ARMOR counts, and body/head/legs/about double. */
function applyAc(obj, iWear) {
  if (obj.itemType !== ITEM.ARMOR) return 0;
  switch (iWear) {
    case WEAR.BODY: return 3 * obj.values[0];
    case WEAR.HEAD: case WEAR.LEGS: case WEAR.ABOUT: return 2 * obj.values[0];
    case WEAR.FEET: case WEAR.HANDS: case WEAR.ARMS: case WEAR.SHIELD:
    case WEAR.FINGER_L: case WEAR.FINGER_R: case WEAR.NECK_1: case WEAR.NECK_2:
    case WEAR.WAIST: case WEAR.WRIST_L: case WEAR.WRIST_R: case WEAR.HOLD:
      return obj.values[0];
    default: return 0;
  }
}

/**
 * handler.c: affect_modify.
 *
 * The early return matters more than it looks: a mobile gets the armour class
 * off its equipment but *not* the applies, so a cityguard's standard issue
 * sword gives it nothing beyond a weapon in hand, and the +2 hitroll +2 damroll
 * on that sword only ever works for whoever takes it off the corpse.
 */
function affectModify(ch, affect, add) {
  if (isNpc(ch)) return;
  const mod = add ? affect.modifier : -affect.modifier;
  switch (affect.location) {
    case APPLY.STR: ch.modStr += mod; break;
    case APPLY.DEX: ch.modDex += mod; break;
    case APPLY.INT: ch.modInt += mod; break;
    case APPLY.WIS: ch.modWis += mod; break;
    case APPLY.CON: ch.modCon += mod; break;
    case APPLY.MANA: ch.maxMana += mod; break;
    case APPLY.HIT: ch.maxHit += mod; break;
    case APPLY.MOVE: ch.maxMove += mod; break;
    case APPLY.AC: ch.armor += mod; break;
    case APPLY.HITROLL: ch.hitroll += mod; break;
    case APPLY.DAMROLL: ch.damroll += mod; break;
    default: break;
  }
}

/** handler.c: equip_char. */
function equipChar(ch, obj, iWear) {
  ch.armor -= applyAc(obj, iWear);
  obj.wearLoc = iWear;
  ch.equipment[iWear] = obj;
  for (const affect of obj.affects) affectModify(ch, affect, true);
}

/** handler.c: unequip_char. */
function unequipChar(ch, obj) {
  ch.armor += applyAc(obj, obj.wearLoc);
  ch.equipment[obj.wearLoc] = null;
  obj.wearLoc = WEAR.NONE;
  for (const affect of obj.affects) affectModify(ch, affect, false);
}

const canWear = (obj, flag) => (obj.wearFlags & flag) !== 0;
const carriedWeight = (ch) => ch.inventory.reduce((sum, o) => sum + objWeight(o), 0);

/**
 * act_obj.c: wear_obj, in the same order, so an object that could go in two
 * places lands where the mud would put it. Returns the mud's own reply.
 */
function wearObj(ch, obj, replace = true) {
  if (ch.level < obj.level) return { ok: false, text: `You must be level ${obj.level} to use this object.` };
  // equip_char's zap: gear that hates what you are drops out of your hands.
  if (((obj.extraFlags & 1024) && isEvil(ch))
    || ((obj.extraFlags & 512) && isGood(ch))
    || ((obj.extraFlags & 2048) && !isGood(ch) && !isEvil(ch))) {
    return { ok: false, zapped: true, text: `You are zapped by ${obj.name} and drop it.` };
  }
  const slot = (iWear, message) => {
    const worn = ch.equipment[iWear];
    if (worn) {
      if (!replace) return null;
      if (worn.extraFlags & X.NOREMOVE) return { ok: false, text: `You can't remove ${worn.name}.` };
      unequipChar(ch, worn);
    }
    equipChar(ch, obj, iWear);
    const index = ch.inventory.indexOf(obj);
    if (index >= 0) ch.inventory.splice(index, 1);
    return { ok: true, text: message };
  };
  const pair = (a, b, message) => {
    if (!ch.equipment[a]) return slot(a, message);
    if (!ch.equipment[b]) return slot(b, message);
    return slot(a, message);
  };

  if (obj.itemType === ITEM.LIGHT) return slot(WEAR.LIGHT, `You light ${obj.name} and hold it.`);
  if (canWear(obj, W.FINGER)) return pair(WEAR.FINGER_L, WEAR.FINGER_R, `You wear ${obj.name} on your finger.`);
  if (canWear(obj, W.NECK)) return pair(WEAR.NECK_1, WEAR.NECK_2, `You wear ${obj.name} around your neck.`);
  if (canWear(obj, W.BODY)) return slot(WEAR.BODY, `You wear ${obj.name} on your body.`);
  if (canWear(obj, W.HEAD)) return slot(WEAR.HEAD, `You wear ${obj.name} on your head.`);
  if (canWear(obj, W.LEGS)) return slot(WEAR.LEGS, `You wear ${obj.name} on your legs.`);
  if (canWear(obj, W.FEET)) return slot(WEAR.FEET, `You wear ${obj.name} on your feet.`);
  if (canWear(obj, W.HANDS)) return slot(WEAR.HANDS, `You wear ${obj.name} on your hands.`);
  if (canWear(obj, W.ARMS)) return slot(WEAR.ARMS, `You wear ${obj.name} on your arms.`);
  if (canWear(obj, W.ABOUT)) return slot(WEAR.ABOUT, `You wear ${obj.name} about your body.`);
  if (canWear(obj, W.WAIST)) return slot(WEAR.WAIST, `You wear ${obj.name} about your waist.`);
  if (canWear(obj, W.WRIST)) return pair(WEAR.WRIST_L, WEAR.WRIST_R, `You wear ${obj.name} around your wrist.`);
  if (canWear(obj, W.SHIELD)) return slot(WEAR.SHIELD, `You wear ${obj.name} as a shield.`);
  if (canWear(obj, W.WIELD)) {
    if (objWeight(obj) > STR_APP[currStr(ch)][3]) {
      return { ok: false, text: 'It is too heavy for you to wield.' };
    }
    return slot(WEAR.WIELD, `You wield ${obj.name}.`);
  }
  if (canWear(obj, W.HOLD)) return slot(WEAR.HOLD, `You hold ${obj.name} in your hands.`);
  return { ok: false, text: "You can't wear, wield, or hold that." };
}

/** act_obj.c: get_cost. */
function getCost(shop, obj, fBuy) {
  if (!obj) return 0;
  let cost;
  if (fBuy) {
    cost = idiv(obj.cost * shop.profitBuy, 100);
  } else {
    cost = 0;
    for (const type of shop.buyType) {
      if (obj.itemType === type) { cost = idiv(obj.cost * shop.profitSell, 100); break; }
    }
  }
  if (obj.itemType === ITEM.STAFF || obj.itemType === ITEM.WAND) {
    cost = idiv(cost * obj.values[2], obj.values[1]);
  }
  return cost;
}

// ----------------------------------------------------------------- combat ----

/** fight.c: dam_message's verb table. */
export function damVerb(dam) {
  if (dam === 0) return ['miss', 'misses'];
  if (dam <= 4) return ['scratch', 'scratches'];
  if (dam <= 8) return ['graze', 'grazes'];
  if (dam <= 12) return ['hit', 'hits'];
  if (dam <= 16) return ['injure', 'injures'];
  if (dam <= 20) return ['wound', 'wounds'];
  if (dam <= 24) return ['maul', 'mauls'];
  if (dam <= 28) return ['devastate', 'devastates'];
  if (dam <= 32) return ['maim', 'maims'];
  if (dam <= 36) return ['MUTILATE', 'MUTILATES'];
  if (dam <= 40) return ['DISEMBOWEL', 'DISEMBOWELS'];
  if (dam <= 44) return ['EVISCERATE', 'EVISCERATES'];
  if (dam <= 48) return ['MASSACRE', 'MASSACRES'];
  if (dam <= 100) return ['*** DEMOLISH ***', '*** DEMOLISHES ***'];
  return ['*** ANNIHILATE ***', '*** ANNIHILATES ***'];
}

const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * fight.c: dam_message, for all three audiences. A skill's dt is its name
 * (skill_table's noun_damage: 'kick', 'backstab'), where Merc uses the gsn.
 */
function damMessage(ch, victim, dam, dt) {
  const [vs, vp] = damVerb(dam);
  const punct = dam <= 24 ? '.' : '!';
  if (dt === TYPE_HIT) {
    return {
      toChar: `You ${vs} ${victim.name}${punct}`,
      toVict: `${capitalise(ch.name)} ${vp} you${punct}`,
      toRoom: `${capitalise(ch.name)} ${vp} ${victim.name}${punct}`,
    };
  }
  // A spell passes skill_table's noun_damage ("fireball") in place of a number.
  const attack = typeof dt === 'string' ? dt : (ATTACK_TABLE[dt - TYPE_HIT] || ATTACK_TABLE[0]);
  return {
    toChar: `Your ${attack} ${vp} ${victim.name}${punct}`,
    toVict: `${capitalise(ch.name)}'s ${attack} ${vp} you${punct}`,
    toRoom: `${capitalise(ch.name)}'s ${attack} ${vp} ${victim.name}${punct}`,
  };
}

/** Which of act()'s three lines the player reads: they are ch, victim, or neither. */
const heard = (ch, victim, m) => (!isNpc(ch) ? m.toChar : (!isNpc(victim) ? m.toVict : m.toRoom));

/**
 * Who struck whom, with what, for whoever draws it. `from`/`to` are the
 * mobile's slot in the real-time game, or null for the player; `metal` is
 * whether the blow lands on worn armour (a spark and a clank) or on cloth and
 * skin (a thud); `attack` is attack_table's word for the weapon.
 */
function blow(ch, victim, ctx = null) {
  const wield = ch.equipment[WEAR.WIELD];
  const attack = wield && wield.itemType === ITEM.WEAPON ? (ATTACK_TABLE[wield.values[3]] || 'hit') : 'hit';
  const metal = victim.equipment.some((obj) => obj && obj.itemType === ITEM.ARMOR
    && [WEAR.BODY, WEAR.HEAD, WEAR.SHIELD, WEAR.ARMS, WEAR.LEGS].includes(obj.wearLoc));
  const out = { from: ch.slot || null, to: victim.slot || null, attack, armed: !!wield, metal };
  // On a server `from`/`to` null no longer means "you": name both sides.
  if (ctx && ctx.multi) { out.fromCh = ch; out.toCh = victim; }
  return out;
}

/**
 * act()'s three audiences on a server (createGame's ctx.multi): `toChar` for
 * a player who struck, `toVict` for a player struck, `toRoom` for everyone
 * else in the room. In the page there is one reader and `heard` picks for it.
 */
function told(ctx, ch, victim, event, m) {
  const reader = !isNpc(ch) ? ch : (!isNpc(victim) ? victim : null);
  ctx.emit({ ...event, text: heard(ch, victim, m), pc: ctx.pcId(reader) });
  if (!isNpc(ch) && !isNpc(victim) && ch !== victim) ctx.emit({ ...event, text: m.toVict, byPlayer: false, defended: undefined, pc: ctx.pcId(victim) });
  if (reader) ctx.roomcast(victim, { kind: 'room', text: m.toRoom, combat: event.kind, ...blow(ch, victim, ctx) }, [ch, victim]);
}

/**
 * fight.c: one_hit. `ctx` carries the rng and the event sink so that the two
 * halves -- the arithmetic and the telling -- stay separable for the harness.
 */
function oneHit(ch, victim, dt, ctx) {
  if (victim.position === POS.DEAD) return;
  // When this blow is *shown* -- the rules resolve a whole round on one pulse,
  // and a round of four blows all landing on the same frame reads as one.
  if (ctx.round) {
    ctx.now = (isNpc(ch) ? ctx.round.npc : ctx.round.player) + (ctx.beat || 0) * SWING_GAP;
    // One body, one blow at a time. A click's round and the pulse after it
    // can put two of the same attacker's blows 0.1 s apart, and then one
    // swing landed two hits. Push the later one back until the first has
    // been seen to land; everything this blow emits (the state line, the
    // death, the body falling) rides on ctx.now and moves with it.
    if (ctx.clock !== undefined) {
      const at = ctx.clock + ctx.now;
      if (ch.blowAt !== undefined && at < ch.blowAt + MIN_BLOW_GAP) ctx.now += ch.blowAt + MIN_BLOW_GAP - at;
      ch.blowAt = ctx.clock + ctx.now;
    }
  }

  const wield = ch.equipment[WEAR.WIELD];
  if (dt === undefined || dt === null) {
    dt = TYPE_HIT;
    if (wield && wield.itemType === ITEM.WEAPON) dt += wield.values[3];
  }

  let thac000;
  let thac032;
  if (isNpc(ch)) { thac000 = 20; thac032 = 0; } else {
    thac000 = CLASS_TABLE[ch.class].thac00;
    thac032 = CLASS_TABLE[ch.class].thac032;
  }
  const thac0 = interpolate(ch.level, thac000, thac032) - getHitroll(ch);
  // The C also gives an unseen victim four points of AC; nothing here can be
  // invisible, so that branch has nothing to fire on.
  let victimAc = Math.max(-15, idiv(getAc(victim), 10));
  if (ch.affectedBy & AFF.BLIND) victimAc -= 4;   // !can_see(ch, victim)

  let diceroll;
  do { diceroll = ctx.rng.bits(5); } while (diceroll >= 20);

  if (diceroll === 0 || (diceroll !== 19 && diceroll < thac0 - victimAc)) {
    damage(ch, victim, 0, dt, ctx);
    return;
  }

  let dam;
  if (isNpc(ch)) {
    dam = ctx.rng.range(idiv(ch.level, 2), idiv(ch.level * 3, 2));
    if (wield) dam += idiv(dam, 2);
  } else if (wield) {
    dam = ctx.rng.range(wield.values[1], wield.values[2]);
  } else {
    dam = ctx.rng.range(1, 4);
  }

  dam += getDamroll(ch);
  if (!isNpc(ch) && ch.learned.enhancedDamage > 0) {
    dam += idiv(dam * ch.learned.enhancedDamage, 100);
  }
  if (!isAwake(victim)) dam *= 2;
  if (dt === 'backstab') dam *= 2 + idiv(ch.level, 8);
  if (dam <= 0) dam = 1;

  damage(ch, victim, dam, dt, ctx);
}

/** fight.c: check_parry. */
function checkParry(ch, victim, ctx) {
  if (!isAwake(victim)) return false;
  let chance;
  if (isNpc(victim)) chance = Math.min(60, 2 * victim.level);
  else {
    if (!victim.equipment[WEAR.WIELD]) return false;
    chance = idiv(victim.learned.parry, 2);
  }
  if (ctx.rng.percent() >= chance + victim.level - ch.level) return false;
  if (ctx.multi) {
    told(ctx, ch, victim, { kind: 'parry', defended: !isNpc(victim) || undefined, ...blow(ch, victim, ctx) }, {
      toChar: `${capitalise(victim.name)} parries your attack.`, toVict: `You parry ${ch.name}'s attack.`,
      toRoom: `${capitalise(victim.name)} parries ${ch.name}'s attack.`,
    });
    return true;
  }
  ctx.emit(isNpc(victim)
    ? { kind: 'parry', text: isNpc(ch) ? `${capitalise(victim.name)} parries ${ch.name}'s attack.` : `${capitalise(victim.name)} parries your attack.`, ...blow(ch, victim) }
    : { kind: 'parry', text: `You parry ${ch.name}'s attack.`, defended: true, ...blow(ch, victim) });
  return true;
}

/** fight.c: check_dodge. */
function checkDodge(ch, victim, ctx) {
  if (!isAwake(victim)) return false;
  const chance = isNpc(victim)
    ? Math.min(60, 2 * victim.level)
    : idiv(victim.learned.dodge, 2);
  if (ctx.rng.percent() >= chance + victim.level - ch.level) return false;
  if (ctx.multi) {
    told(ctx, ch, victim, { kind: 'dodge', defended: !isNpc(victim) || undefined, ...blow(ch, victim, ctx) }, {
      toChar: `${capitalise(victim.name)} dodges your attack.`, toVict: `You dodge ${ch.name}'s attack.`,
      toRoom: `${capitalise(victim.name)} dodges ${ch.name}'s attack.`,
    });
    return true;
  }
  ctx.emit(isNpc(victim)
    ? { kind: 'dodge', text: isNpc(ch) ? `${capitalise(victim.name)} dodges ${ch.name}'s attack.` : `${capitalise(victim.name)} dodges your attack.`, ...blow(ch, victim) }
    : { kind: 'dodge', text: `You dodge ${ch.name}'s attack.`, defended: true, ...blow(ch, victim) });
  return true;
}

/**
 * fight.c: damage. The parts that only exist for a multiplayer mud -- KILLER
 * flags, charm threads, group assists, link-dead recall -- are the parts left
 * out, along with `trip`, which
 * puts the victim on the floor for two rounds: bearable in a text window,
 * unbearable when the floor is where your camera is.
 */
function damage(ch, victim, dam, dt, ctx) {
  if (victim.position === POS.DEAD) return;
  if (dam > 1000) dam = 1000;

  if (victim !== ch) {
    // fight.c: "Certain attacks are forbidden" -- is_safe and check_killer,
    // which only ever have anything to say when both sides are players.
    if (ctx.multi && !isNpc(ch) && !isNpc(victim)) {
      if (ctx.isSafe(ch, victim)) return;
      ctx.checkKiller(ch, victim);
    }
    if (victim.position > POS.STUNNED) {
      if (!victim.fighting) ctx.setFighting(victim, ch);
      victim.position = POS.FIGHTING;
      if (!ch.fighting) ctx.setFighting(ch, victim);
    }
    if (victim.affectedBy & AFF.SANCTUARY) dam = idiv(dam, 2);
    if ((victim.affectedBy & AFF.PROTECT) && isEvil(ch)) dam -= idiv(dam, 4);
    if (dam < 0) dam = 0;

    if (dt >= TYPE_HIT) {
      if (isNpc(ch) && ctx.rng.percent() < idiv(ch.level, 2)) ctx.disarm(ch, victim);
      if (checkParry(ch, victim, ctx)) return;
      if (checkDodge(ch, victim, ctx)) return;
    }

    const message = damMessage(ch, victim, dam, dt);
    const event = {
      kind: dam === 0 ? 'miss' : 'hit',
      text: heard(ch, victim, message),
      skill: typeof dt === 'string' ? dt : undefined,
      dam,
      byPlayer: !isNpc(ch),
      target: victim.name,
      ...blow(ch, victim, ctx),
      hp: Math.max(0, victim.hit - dam),
      maxHp: victim.maxHit,
      // A spell's blow: spellfx.js draws it, and fx.js leaves the swing out.
      ...(typeof dt === 'string' ? { spell: dt } : null),
    };
    if (ctx.multi) told(ctx, ch, victim, event, message);
    else ctx.emit(event);
  }

  victim.hit -= dam;
  // An immortal is never brought below one hitpoint (fight.c).
  if (!isNpc(victim) && victim.level >= LEVEL_IMMORTAL && victim.hit < 1) victim.hit = 1;
  updatePos(victim);

  // The victim's own lines go to the victim; the room hears $n's (fight.c).
  const said = (text, roomText) => {
    if (!ctx.multi) { ctx.emit({ kind: 'state', text }); return; }
    if (!isNpc(victim)) ctx.emit({ kind: 'state', text, pc: ctx.pcId(victim) });
    if (roomText) ctx.roomcast(victim, { kind: 'room', text: roomText }, isNpc(victim) ? [] : [victim]);
  };
  const Victim = capitalise(victim.name);
  switch (victim.position) {
    case POS.MORTAL:
      said(isNpc(victim) ? `${Victim} is mortally wounded, and will die soon, if not aided.`
        : 'You are mortally wounded, and will die soon, if not aided.', `${Victim} is mortally wounded, and will die soon, if not aided.`);
      break;
    case POS.INCAP:
      said(isNpc(victim) ? `${Victim} is incapacitated and will slowly die, if not aided.`
        : 'You are incapacitated and will slowly die, if not aided.', `${Victim} is incapacitated and will slowly die, if not aided.`);
      break;
    case POS.STUNNED:
      said(isNpc(victim) ? `${Victim} is stunned, but will probably recover.`
        : 'You are stunned, but will probably recover.', `${Victim} is stunned, but will probably recover.`);
      break;
    case POS.DEAD:
      break;
    default:
      if (!isNpc(victim)) {
        if (dam > idiv(victim.maxHit, 4)) said('That really did HURT!');
        if (victim.hit < idiv(victim.maxHit, 4)) said('You sure are BLEEDING!');
      }
      break;
  }

  if (!isAwake(victim)) ctx.stopFighting(victim, false);

  if (victim.position === POS.DEAD) {
    ctx.kill(ch, victim);
    return;
  }
  if (victim === ch) return;

  // Wimpy mobiles run at half health; the player runs at their wimpy setting.
  if (isNpc(victim) && dam > 0) {
    if ((victim.act & ACT_WIMPY) && ctx.rng.bits(1) === 0
      && victim.hit < idiv(victim.maxHit, 2)) ctx.flee(victim);
  }
  if (!isNpc(victim) && victim.hit > 0 && victim.hit <= victim.wimpy) ctx.flee(victim);
}

/** fight.c: multi_hit. A mobile's extra swings come off its level, a player's off skills. */
function multiHit(ch, victim, dt, ctx) {
  ctx.beat = 0;
  oneHit(ch, victim, dt, ctx);
  if (ch.fighting !== victim || dt === 'backstab') return;

  let chance = isNpc(ch) ? ch.level : idiv(ch.learned.secondAttack, 2);
  if (ctx.rng.percent() < chance) {
    ctx.beat += 1;
    oneHit(ch, victim, dt, ctx);
    if (ch.fighting !== victim) return;
  }

  chance = isNpc(ch) ? ch.level : idiv(ch.learned.thirdAttack, 4);
  if (ctx.rng.percent() < chance) {
    ctx.beat += 1;
    oneHit(ch, victim, dt, ctx);
    if (ch.fighting !== victim) return;
  }

  chance = isNpc(ch) ? idiv(ch.level, 2) : 0;
  if (ctx.rng.percent() < chance) { ctx.beat += 1; oneHit(ch, victim, dt, ctx); }
}

/**
 * fight.c: xp_compute, kill_table and all. It also shifts your alignment, which
 * is why it takes the killer by reference.
 *
 * The popularity term is the reason to walk further: kill the same beggar eight
 * times over and it is worth nothing, while the first kill of something nobody
 * has touched is worth a quarter more.
 */
function xpComputeWith(gch, victim, killTable, protoKilled, rng) {
  let xp = 300 - clamp(gch.level - victim.level, -3, 6) * 50;
  const align = gch.alignment - victim.alignment;
  if (align > 500) {
    gch.alignment = Math.min(gch.alignment + idiv(align - 500, 4), 1000);
    xp = idiv(5 * xp, 4);
  } else if (align < -500) {
    gch.alignment = Math.max(gch.alignment + idiv(align + 500, 4), -1000);
  } else {
    gch.alignment -= idiv(gch.alignment, 4);
    xp = idiv(3 * xp, 4);
  }
  const level = clamp(victim.level, 0, MAX_LEVEL - 1);
  const number = Math.max(1, killTable[level].number);
  const extra = protoKilled - idiv(killTable[level].killed, number);
  xp -= idiv(xp * clamp(extra, -2, 8), 8);
  return Math.max(0, rng.range(idiv(xp * 3, 4), idiv(xp * 5, 4)));
}

/** fight.c: death_cry, keeping only the messages (the body parts are objects we have no meshes for). */
const DEATH_CRIES = [
  '$n hits the ground ... DEAD.',
  '$n splatters blood on your armor.',
  "You smell $n's sphincter releasing in death.",
  "$n's severed head plops on the ground.",
  "$n's heart is torn from $s chest.",
  "$n's arm is sliced from $s dead body.",
  "$n's leg is sliced from $s dead body.",
];

/** Everything above, bundled so tools/game-check.mjs can drive the rules alone. */
export const MERC = {
  PULSE_PER_SECOND, PULSE_VIOLENCE, PULSE_TICK,
  MAX_LEVEL, LEVEL_HERO, MAX_WEAR, TYPE_HIT, POS, WEAR, WEAR_NAME, SKY,
  CLASS_TABLE, SKILLS, STR_APP, INT_APP, WIS_APP, DEX_APP, CON_APP,
  Rng, idiv, interpolate, clamp,
  isNpc, isAwake, isGood, isEvil, currStr, currInt, currWis, currDex, currCon,
  getAc, getHitroll, getDamroll, canCarryN, canCarryW, updatePos, condition,
  createCharacter, advanceLevel, gainExp, expToLevel, createMobile, createObject, armourWord,
  hitGain, manaGain, moveGain,
  applyAc, equipChar, unequipChar, wearObj, getCost, objWeight, carriedWeight,
  oneHit, multiHit, damage, damVerb, damMessage, xpCompute: xpComputeWith,
};

// ==========================================================================
//                        the real-time game around it
// ==========================================================================

/** Metres, standing in for the mud's "same room?". */
const MELEE = 3.2;      // you can reach each other
const REACH = 4.6;      // how far `attack` will look for something to swing at
const AGGRO = 9;        // an aggressive mobile notices you
const BREAK = 14;       // out this far the fight is over -- this is do_flee
const MOB_SPEED = 2.6;  // metres a second, closing
const LEASH = 26;       // how far a mobile will chase before going home

/**
 * Presentation beats, in seconds after the pulse that resolved them. Every
 * combat event carries its `delay`, and whatever draws or sounds it waits that
 * long, so the text, the number, the flinch and the clang all land on the
 * frame the swing connects. The rules are untouched: the round is still
 * resolved on the pulse, all at once.
 */
export const SWING_GAP = 0.62;   // between one blow of a round and the next
export const MOB_BEAT = 0.31;    // a mobile's blows fall between yours
export const CLICK_WINDUP = 0.24;  // a click swings now; the blow lands this much later
export const AMBUSH_WINDUP = 0.5;  // an aggressive mobile's first swing is seen coming
export const MIN_BLOW_GAP = 0.45;  // one attacker's blows are never shown closer than this

/** A gate is only *held* if something that could stop a novice stands at it. */
const WARDEN_MIN_LEVEL = 5;

/**
 * "the way north", "the ways north and east": what a warden holds, said by the
 * direction and not by the room. The room is where you are standing already,
 * and room names are not noun phrases -- "holds the way out of Outside the West
 * Gate of Midgaard" is what reading them as one produced.
 */
export function waysPhrase(gates, lead = null) {
  // `lead(gate)` words a gate from where the reader stands. A warden can hold
  // an exit of the room next door -- the sailor in the Abandoned Warehouse
  // holds the east end of the alley -- and bare "east" in the warehouse named
  // a way the warehouse does not have. Its own ways first, then the others.
  const worded = gates.map((g) => (lead && lead(g)) || { way: g.way, near: true });
  worded.sort((a, b) => b.near - a.near);
  const ways = [...new Set(worded.map((w) => w.way))];
  if (!ways.length) return '';
  // "up, and north then east": the comma keeps a two-step way in one piece.
  const joint = ways.some((w) => w.includes(' then ')) ? ', and ' : ' and ';
  const list = ways.length === 1 ? ways[0] : `${ways.slice(0, -1).join(', ')}${joint}${ways[ways.length - 1]}`;
  return `the way${ways.length > 1 ? 's' : ''} ${list}`;
}
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const dist2 = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

/**
 * Where a mobile is when it is in no zone being drawn: far enough from any
 * laid-out coordinate that no reach, no hearing and no aggression test can
 * mistake it for being near you. Such a mobile still has a room -- the mud's
 * own idea of where it is -- and that is all the rules ask of it.
 */
export const FAR = 1e7;

// build.js's grid and walls, as server/world.mjs models them: the count reads
// the layout, never the geometry, so the page and the server decide alike.
const CELL = 13;
const LEVEL_H = 7.6;
const WALL_LINE = 5.35;  // clear of where a body stops: about 4.5 m inside a box wall, 6.1 m outside
const TREE_LINE = 5.4;   // a hollow tree's wall is a ring
const DOOR_HALF = 1.9;   // half a doorway (build.js DOOR_W 3.2) and some

/**
 * Which room a body is counted in: inside a walled room's walls or in its
 * doorway, that room; on an open-air room's cell, that room; on a street, its
 * nearer end (where streets share a cell, one with `last` at an end); on open
 * ground, the nearest room the level's open ground reaches (open-air rooms a
 * two-way street leaves, and what two-way streets join to them); else null,
 * "keep the last room". Read from the layout alone, so the page and the server
 * decide alike; tools/judge/headless/roomcount.mjs measures it against a flood
 * of the page's own ground. `rooms` is built.rooms, `links` layout.links;
 * positions are feet, in the frame `rooms` is in.
 */
export function createRoomCounter({ world, rooms, links, zoneOf = null }) {
  const openAir = openAirIn(world);
  const key = (level, x, z) => `${level},${x},${z}`;
  const entries = new Map();
  const byCell = new Map();
  const zoneId = (v) => (zoneOf && zoneOf(v) ? zoneOf(v).id : '');
  for (const [vnum, info] of rooms) {
    const room = world.rooms.get(vnum);
    if (!room) throw new Error(`game.js: built room #${vnum} is not in the world`);
    // build.js builds nothing for an "In the air..." room: nobody stands there.
    if (room.sector === SECTOR.AIR) continue;
    if (!info.cell) throw new Error(`game.js: built room #${vnum} has no layout cell to be counted in`);
    // The cell is the grid's, and only the frame comes from the centre: on the
    // server a zone is a whole number of cells along x, and the page's centres
    // stand at most 3.5 m off the grid (a stair's hole), which rounds to none.
    const ox = Math.round((info.center.x - info.cell.x * CELL) / CELL);
    const oz = Math.round((info.center.z - info.cell.z * CELL) / CELL);
    const walled = !openAir(room);
    const e = {
      vnum, level: info.cell.level, gx: info.cell.x + ox, gz: info.cell.z + oz, ox, oz,
      walled, round: walled && shellAttrs(room)?.named === 'tree', zone: zoneId(vnum),
      doorways: [false, false, false, false],
    };
    e.x = e.gx * CELL; e.z = e.gz * CELL;
    entries.set(vnum, e);
    byCell.set(key(e.level, e.gx, e.gz), e);
  }
  // layout.js's own test: the far end of a one-way exit has no way back.
  const oneWay = (link) => !world.rooms.get(link.to.vnum).exits.some((exit) => exit && exit.to === link.from.vnum);
  const streets = new Map();
  const parent = new Map();
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(b, a); };
  for (const e of entries.values()) parent.set(e.vnum, e.vnum);
  const streeted = new Set();
  for (const link of links) {
    if (link.kind !== 'alley' || !link.to || !link.path) continue;
    const a = entries.get(link.from.vnum);
    const b = entries.get(link.to.vnum);
    if (!a || !b) continue;
    // A street's cells are on its `from` room's level. layout.js would put the
    // cells between a raised street's ramps a level up (`crossings: 'raise'`,
    // layout.bridges); it is 'allow' and none is raised, so none is keyed there.
    for (const c of link.path) {
      const k = key(link.from.level, c.x + a.ox, c.z + a.oz);
      if (!streets.has(k)) streets.set(k, []);
      streets.get(k).push([a, b]);
    }
    a.doorways[link.entryDir] = true;
    b.doorways[REVERSE_DIR[link.exitDir]] = true;
    if (oneWay(link)) continue;
    join(a.vnum, b.vnum);
    streeted.add(a.vnum); streeted.add(b.vnum);
  }
  // A level's open ground reaches the open-air rooms a two-way street leaves,
  // not every open-air room: olympus' #901 and canyon's #9201 have only a gate
  // and a portal, plains' #345 no exit, and counting them from the whole
  // level's ground was wrong over all of olympus and canyon (roomcount.mjs
  // spec-all against spec).
  for (const e of entries.values()) {
    if (e.walled || !streeted.has(e.vnum)) continue;
    const out = `out|${e.zone}|${e.level}`;
    if (!parent.has(out)) parent.set(out, out);
    join(out, e.vnum);
  }
  const reached = new Map(); // `${zone}|${level}` -> rooms, nearest first by a 26 m grid
  const outsideOf = (zone, level) => {
    const k = `${zone}|${level}`;
    if (reached.has(k)) return reached.get(k);
    const out = `out|${zone}|${level}`;
    let index = null;
    if (parent.has(out)) {
      const root = find(out);
      const list = [...entries.values()].filter((e) => e.zone === zone && e.level === level && find(e.vnum) === root);
      index = gridOf(list);
    }
    reached.set(k, index);
    return index;
  };
  // Which zone a point is in: the one whose frame is nearest along x (one zone in a page).
  const frames = new Map();
  for (const e of entries.values()) if (!frames.has(e.zone)) frames.set(e.zone, e.ox);
  const zoneAt = (gx) => {
    let best = null;
    let bd = Infinity;
    for (const [zone, ox] of frames) { const d = Math.abs(gx - ox); if (d < bd) { bd = d; best = zone; } }
    return best;
  };
  /** Where a point is: in a room ({ room }), on a street ({ streets }), or on open ground ({ level, gx }). */
  function region(p) {
    const level = Math.round(p.y / LEVEL_H);
    const gx = Math.round(p.x / CELL);
    const gz = Math.round(p.z / CELL);
    const r = byCell.get(key(level, gx, gz));
    if (r) {
      if (!r.walled) return { room: r.vnum };
      const dx = p.x - r.x;
      const dz = p.z - r.z;
      if (r.round ? dx * dx + dz * dz < TREE_LINE * TREE_LINE : Math.abs(dx) < WALL_LINE && Math.abs(dz) < WALL_LINE) return { room: r.vnum };
      // In a doorway: out past the wall line, but within a doorway's half-width of a side a street leaves by.
      const dir = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : (dz > 0 ? 2 : 0);
      if (r.doorways[dir] && Math.abs(dir === 1 || dir === 3 ? dz : dx) < DOOR_HALF) return { room: r.vnum };
      return { level, gx };
    }
    const list = streets.get(key(level, gx, gz));
    return list ? { streets: list } : { level, gx };
  }
  /** The room counted at feet `p` for a body last counted in `last`, or null: keep `last`. */
  function at(p, last) {
    const where = region(p);
    if (where.room !== undefined) return where.room;
    if (where.streets) {
      // Where streets share the cell, the one the body is walking: one with its last room at an end.
      const mine = where.streets.filter(([a, b]) => a.vnum === last || b.vnum === last);
      let best = null;
      let bd = Infinity;
      for (const pair of mine.length ? mine : where.streets) {
        for (const end of pair) {
          const d = (end.x - p.x) ** 2 + (end.z - p.z) ** 2;
          if (d < bd || (d === bd && end.vnum < best)) { bd = d; best = end.vnum; }
        }
      }
      return best;
    }
    const index = outsideOf(zoneAt(where.gx), where.level);
    return index ? index.nearest(p.x, p.z) : null;
  }
  return { at, region, entries };
}

/**
 * The nearest of `list` ({ vnum, x, z }) to a point, flat, ties to the lower
 * vnum -- built.rooms is walked in one order on the page and in another on the
 * server, and the two must pick alike. A 26 m grid, searched in rings.
 */
function gridOf(list) {
  const S = 26;
  const grid = new Map();
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const e of list) {
    const k = `${Math.floor(e.x / S)},${Math.floor(e.z / S)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(e);
    x0 = Math.min(x0, e.x); x1 = Math.max(x1, e.x); z0 = Math.min(z0, e.z); z1 = Math.max(z1, e.z);
  }
  if (!list.length) return null;
  return {
    nearest(x, z) {
      const bx = Math.floor(x / S);
      const bz = Math.floor(z / S);
      // Far enough out to hold every room, from wherever the point is.
      const reach = Math.ceil(Math.max(Math.abs(x - x0), Math.abs(x - x1), Math.abs(z - z0), Math.abs(z - z1)) / S) + 1;
      let best = null;
      let bd = Infinity;
      const look = (cx, cz) => {
        for (const e of grid.get(`${cx},${cz}`) || []) {
          const d = (e.x - x) ** 2 + (e.z - z) ** 2;
          if (d < bd || (d === bd && e.vnum < best.vnum)) { bd = d; best = e; }
        }
      };
      for (let ring = 0; ring <= reach; ring++) {
        // Nothing in ring r is nearer than (r - 1) buckets: stop once the best found is nearer.
        if (best && ((ring - 1) * S) ** 2 > bd) break;
        if (ring === 0) { look(bx, bz); continue; }
        for (let d = -ring; d <= ring; d++) { look(bx + d, bz - ring); look(bx + d, bz + ring); }
        for (let d = -ring + 1; d <= ring - 1; d++) { look(bx - ring, bz + d); look(bx + ring, bz + d); }
      }
      return best.vnum;
    },
  };
}

/**
 * @param {object} deps  world/layout/built from the boot chain. `actors` is
 *   optional: without it the game runs headless, which is how the harness and
 *   any future test drives it.
 *
 *   `world` is everything the mud holds; `layout`/`built`/`actors` are only
 *   the zone being drawn (zones.js). `zoneOf(vnum)` says which zone a room is
 *   in; without it the whole world is one zone, as it always was. Mobiles in
 *   rooms the current zone did not build are kept by room alone: they reset,
 *   wander and run their spec_funs, but have no body and no position until a
 *   zone holding their room is entered (`game.enterZone`).
 */
export function createGame({
  world, layout, built, actors = null, seed, classIndex = 3, nav = null, zoneOf = null,
  server = null, puppet: startAsPuppet = false,
} = {}) {
  let puppet = startAsPuppet;
  const rng = new Rng(seed);
  const events = [];
  const listeners = [];
  /**
   * `server`: this game is the mud's, with char_list's players in it (see
   * server/). Every path that only a second player can reach is gated on it,
   * so the game in the page runs exactly the code it always ran. `puppet`:
   * the page's copy of a game the server runs -- bodies, no rules (update).
   */
  const multi = !!server;
  // char_list's players, and the one whose turn it is (Merc's `ch`): see bind.
  const players = [];
  let current = null;
  const emit = (event) => {
    // Stamped with the beat of the blow being resolved, if one is.
    if (event.delay === undefined && ctx.now !== undefined) event.delay = ctx.now;
    if (ctx.round && event.beat === undefined) event.beat = ctx.beat || 0;
    // Whose screen it is for: send_to_char's `ch` is whoever's turn it is.
    if (multi && event.pc === undefined && event.room === undefined && current) event.pc = current.id;
    events.push(event);
    if (events.length > 400) events.shift();
    for (const fn of listeners) fn(event);
  };
  // The walkable grid and the routes between rooms. actors.js builds it over
  // the real geometry; headless, it is the layout alone.
  let ways = nav || (actors && actors.nav) || createNav({ layout, built, world });
  /** Mobiles do not walk out of their zone: the body would have nowhere to go. */
  const sameZone = (a, b) => !zoneOf || zoneOf(a) === zoneOf(b);

  // -- kill_table -----------------------------------------------------------
  // db.c counts every mobile prototype into kill_table at boot, after fuzzing
  // its level once. xp_compute divides by those counts, so they have to exist
  // before the first blow lands.
  const killTable = Array.from({ length: MAX_LEVEL }, () => ({ number: 0, killed: 0 }));
  const protoInfo = new Map();
  for (const proto of world.mobProtos.values()) {
    const loadLevel = rng.fuzzy(proto.level);
    protoInfo.set(proto.vnum, { loadLevel, killed: 0 });
    killTable[clamp(loadLevel, 0, MAX_LEVEL - 1)].number += 1;
  }

  // -- rooms ----------------------------------------------------------------
  // The zone's rooms as the count reads them (createRoomCounter); made in enterZone.
  let counter = null;
  const bucketKey = (x, z) => `${Math.floor(x / 26)},${Math.floor(z / 26)}`;

  // -- mobiles --------------------------------------------------------------
  // One slot per M line in the whole world, whether or not its room is drawn.
  // `here` is whether it is in the zone being drawn and so has a position (and,
  // with actors, a body); see enterZone for how the two are paired.
  const mobs = [];
  for (const room of world.rooms.values()) {
    for (const record of room.mobs) {
      mobs.push({
        record,
        proto: record.proto,
        roomVnum: room.vnum,
        figure: null,
        here: false,
        anchor: { x: FAR, y: 0, z: FAR },
        pos: { x: FAR, y: 0, z: FAR },
        instance: null,
        dead: false,
        corpse: null,
        // What the body is doing, as an order actors.js carries out (see
        // motion.js); `travel` is a walk to the next room that mobile_update
        // started and has not finished yet.
        order: null,
        travel: null,
        bucket: null,
      });
    }
  }
  const slotOfRecord = new Map(mobs.map((slot) => [slot.record, slot]));
  const figureSlot = new Map();

  // Mobiles walk now, so the buckets are kept up as they go. Only the ones
  // in the zone being drawn are in them: nobody else has a position.
  const mobBucket = new Map();
  function unbucket(slot) {
    if (slot.bucket === null) return;
    const old = mobBucket.get(slot.bucket);
    if (old) old.splice(old.indexOf(slot), 1);
    slot.bucket = null;
  }
  function rebucket(slot) {
    if (!slot.here) { unbucket(slot); return; }
    const key = bucketKey(slot.pos.x, slot.pos.z);
    if (key === slot.bucket) return;
    if (slot.bucket !== null) {
      const old = mobBucket.get(slot.bucket);
      if (old) old.splice(old.indexOf(slot), 1);
    }
    if (!mobBucket.has(key)) mobBucket.set(key, []);
    mobBucket.get(key).push(slot);
    slot.bucket = key;
  }
  function mobsNear(p, radius) {
    const out = [];
    const span = Math.ceil(radius / 26) + 1;
    const cx = Math.floor(p.x / 26);
    const cz = Math.floor(p.z / 26);
    for (let dx = -span; dx <= span; dx++) {
      for (let dz = -span; dz <= span; dz++) {
        const bucket = mobBucket.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const slot of bucket) {
          if (slot.dead) continue;
          if (dist2(slot.pos, p) <= radius * radius) out.push(slot);
        }
      }
    }
    return out;
  }

  /**
   * db.c: reset_area's 'G' branch for a keeper. Shop stock does not take its
   * level from the shopkeeper -- it gets its own roll by item type, and
   * `do_buy` refuses to sell you anything above your own level. That is the
   * mud's gate on the shops: the weaponsmith's swords are level 5 to 15, so a
   * first-level character walks in and walks out again.
   */
  function shopLevel(itemType) {
    switch (itemType) {
      case ITEM.PILL: case ITEM.POTION: return rng.range(0, 10);
      case ITEM.SCROLL: return rng.range(5, 15);
      case ITEM.WAND: return rng.range(10, 20);
      case ITEM.STAFF: return rng.range(15, 25);
      case ITEM.ARMOR: case ITEM.WEAPON: return rng.range(5, 15);
      default: return 0;
    }
  }

  /** db.c: create_mobile, run the first time you can see the thing. */
  /**
   * `r` is the generator its rolls come from: the fights' own, unless the
   * world is making it for its own reasons (a reset, the mayor's hours), when
   * it is the wandering one -- so a fight's rolls do not depend on it.
   */
  function wake(slot, r = rng) {
    if (slot.instance || slot.dead) return slot.instance;
    const info = protoInfo.get(slot.proto.vnum);
    const mob = createMobile(slot.proto, info.loadLevel, r);
    mob.slot = slot;
    // Its gear is exactly what the reset table hung on it -- E into slots,
    // G into its hands -- so the corpse holds what the world said it holds.
    const objectLevel = clamp(mob.level - 2, 0, LEVEL_HERO);
    for (const worn of slot.record.equipment) {
      const obj = createObject(worn.proto, r.fuzzy(objectLevel));
      if (worn.wearLoc >= 0 && worn.wearLoc < MAX_WEAR && !mob.equipment[worn.wearLoc]) {
        equipChar(mob, obj, worn.wearLoc);
      } else {
        mob.inventory.push(obj);
      }
    }
    for (const held of slot.record.carried) {
      const obj = slot.record.shop
        ? createObject(held.proto, shopLevel(held.proto.itemType))
        : createObject(held.proto, r.fuzzy(objectLevel));
      if (slot.record.shop) obj.extraFlags |= X.INVENTORY;
      mob.inventory.push(obj);
    }
    slot.instance = mob;
    return mob;
  }

  // -- the players ----------------------------------------------------------
  /**
   * comm.c's char_list, for its player half: each one a character and where
   * its body is. `position` is the eye, 1.72 m up; a mobile's is its feet.
   * Reach is measured feet to feet, as between two mobiles. Eye to feet,
   * MELEE's 3.2 m was 2.7 m on the ground -- and the kick, which measures on
   * the ground, still reached: from 2.7 to 3.2 m a fight was on, nobody
   * swung, a sentinel never closed in, and the only thing that happened was
   * the kick.
   *
   * Merc passes `ch` to every function; this port was written for one player
   * and reads `state`, `position` and `facing` instead. Those are now whoever
   * is bound (`bind`): in the page that is always the one player, so nothing
   * changes there; on the server each player's turn binds it first.
   */
  const pcOfCh = new Map();
  const pcOf = (ch) => (ch && !isNpc(ch) ? pcOfCh.get(ch) || null : null);
  let nextPc = 1;
  function makePc(ch, id = nextPc++) {
    const pc = {
      id, ch,
      position: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: -1 }, feet: { x: 0, y: 0, z: 0 },
      invulnerable: 0, restAt: null, focusSlot: null,
    };
    Object.defineProperty(ch, 'expToLevel', { get: () => expToLevel(ch), enumerable: true, configurable: true });
    Object.defineProperty(ch, 'ac', { get: () => getAc(ch), enumerable: true, configurable: true });
    // The mud calls these hit/max_hit and so does everything above; these are the
    // names the rest of the world expects to read them under.
    Object.defineProperty(ch, 'hp', { get: () => ch.hit, set: (v) => { ch.hit = v; }, configurable: true });
    Object.defineProperty(ch, 'maxHp', { get: () => ch.maxHit, configurable: true });
    Object.defineProperty(ch, 'carryWeight', { get: () => carriedWeight(ch), enumerable: true, configurable: true });
    Object.defineProperty(ch, 'carryMax', { get: () => canCarryW(ch), enumerable: true, configurable: true });
    pcOfCh.set(ch, pc);
    return pc;
  }
  /** A player's feet, from its eye. */
  const pcFeet = (pc) => { pc.feet.x = pc.position.x; pc.feet.y = pc.position.y - 1.72; pc.feet.z = pc.position.z; return pc.feet; };
  /** Where anyone stands: a mobile's feet, a player's feet. */
  const feetOf = (ch) => (isNpc(ch) ? ch.slot.pos : (pcOf(ch) ? pcFeet(pcOf(ch)) : null));

  const pc0 = makePc(createCharacter(classIndex, { rng }), 0);
  pc0.ch.name = 'you';
  players.push(pc0);
  let state = pc0.ch;
  let position = pc0.position;
  let facing = pc0.facing;
  // Rules modules keep `state` in a closure; they register here to follow it.
  const rebinders = [];
  current = pc0;
  /** Make `pc` the one whose turn it is: Merc's `ch` (null: nobody's). */
  function bind(pc) {
    if (pc === current) return;
    current = pc;
    state = pc ? pc.ch : null;
    position = pc ? pc.position : null;
    facing = pc ? pc.facing : null;
    for (const fn of rebinders) fn(state, pc);
  }
  /** Run fn as `pc`'s turn. In the page there is only ever the one. */
  function withPlayer(pc, fn) {
    if (!multi || pc === current) return fn();
    const prev = current;
    bind(pc);
    try { return fn(); } finally { bind(prev); }
  }
  /** send_to_char for a player who need not be the one whose turn it is. */
  function tell(ch, event) {
    const pc = pcOf(ch);
    if (pc) emit({ ...event, pc: pc.id });
  }
  /** act(TO_ROOM): everyone awake in `vnum` but `except` (characters). */
  function roomcast(vnum, event, except = []) {
    if (!multi) return;
    emit({ ...event, room: vnum, except: except.map((ch) => pcOf(ch)?.id).filter((id) => id !== undefined) });
  }
  const feetAt = { x: 0, y: 0, z: 0 };
  const feet = () => { feetAt.x = position.x; feetAt.y = position.y - 1.72; feetAt.z = position.z; return feetAt; };

  // -- ground ---------------------------------------------------------------
  /**
   * Every object lying in a room: ROOM_INDEX_DATA's `contents`, flattened into
   * one list, each object carrying `inRoom` (its vnum) and `at` (where on the
   * floor). The reset table's objects are here too; the ones that cannot be
   * picked up (a fountain, a desk) are drawn by actors.js as scenery, the rest
   * by items.js, and corpses by the dead body itself.
   */
  const ground = [];

  /** handler.c: obj_to_room, with a point on the floor for the renderer. */
  function objToRoom(obj, vnum, at) {
    obj.inRoom = vnum;
    obj.at = { x: at.x, y: at.y, z: at.z };
    obj.carriedBy = null;
    ground.push(obj);
    return obj;
  }

  /** handler.c: obj_from_room. */
  function objFromRoom(obj) {
    const index = ground.indexOf(obj);
    if (index >= 0) ground.splice(index, 1);
    obj.inRoom = null;
    obj.at = null;
  }

  /**
   * Somewhere near your feet for a thing you let go of: a little ahead and to
   * one side, never the same spot twice, so a pile of three is three things.
   */
  let dropCount = 0;
  function dropSpot(from = position, ahead = facing) {
    dropCount += 1;
    const side = ((dropCount % 5) - 2) * 0.28;
    // A player's position is the eye; anything else handed in is a floor.
    const eye = from === position || players.some((pc) => pc.position === from);
    return {
      x: from.x + ahead.x * 0.9 - ahead.z * side,
      y: (eye ? from.y - 1.72 : from.y),
      z: from.z + ahead.z * 0.9 + ahead.x * side,
    };
  }

  // -- gates ----------------------------------------------------------------
  /**
   * The carrot. Every exit into an area that was never loaded is a sealed gate
   * on the map already. A gate is *held* by the strongest mobile standing in
   * the room it leaves, or failing that one step back into the city -- which in
   * Midgaard puts the cityguards on the two city gates, the guildmasters on
   * their guilds, and the executioner on the temple stair. Kill the warden and
   * the gate is yours. Nobody has to be told this; the guard is standing in it.
   */
  const gates = [];
  for (const link of (layout.links || [])) {
    if (link.kind !== 'gate') continue;
    const fromVnum = link.from.vnum;
    const room = world.rooms.get(fromVnum);
    if (!room) continue;

    let warden = null;
    const consider = (candidates, hops) => {
      for (const record of candidates) {
        if (record.proto.level < WARDEN_MIN_LEVEL) continue;
        if (!warden || record.proto.level > warden.record.proto.level) warden = { record, hops };
      }
    };
    consider(room.mobs, 0);
    if (!warden) {
      for (const exit of room.exits) {
        // One step back into the city: never across into another zone,
        // which is what the gate leads to, not what holds it.
        if (!exit || exit.offMap || !sameZone(fromVnum, exit.to)) continue;
        const next = world.rooms.get(exit.to);
        if (next) consider(next.mobs, 1);
      }
    }
    if (!warden) continue;

    const info = built.rooms.get(fromVnum);
    gates.push({
      vnum: fromVnum,
      name: room.name,
      dir: link.dir,
      way: DIR_NAME[link.dir],
      to: link.exit.to,
      outdoor: !!(info && info.outdoor),
      warden: warden.record,
      wardenRoom: warden.record.room ? warden.record.room.vnum : fromVnum,
      wardenName: warden.record.proto.short,
      wardenLevel: warden.record.proto.level,
      open: false,
    });
  }
  gates.sort((a, b) => a.wardenLevel - b.wardenLevel || a.vnum - b.vnum);
  /** waysPhrase's `lead` for someone standing in room `vnum`. */
  const wayFrom = (vnum) => (gate) => {
    if (gate.vnum === vnum) return { way: gate.way, near: true };
    const room = world.rooms.get(vnum);
    const dir = room ? room.exits.findIndex((e) => e && e.to === gate.vnum) : -1;
    return dir >= 0 ? { way: `${DIR_NAME[dir]} then ${gate.way}`, near: false } : null;
  };
  /** The roads out of the city: the gates in the open air. Those are the ending. */
  const roads = gates.filter((g) => g.outdoor);

  // -- the combat context ---------------------------------------------------
  let deathHandler = null;
  const ctx = {
    rng,
    emit,
    // On a server, who an act() line is for (see `told` and `blow`).
    multi,
    pcId: (ch) => (ch && !isNpc(ch) && pcOf(ch) ? pcOf(ch).id : null),
    roomcast: (ch, event, except) => roomcast(isNpc(ch) ? ch.slot.roomVnum : ch.roomVnum, event, except),
    /** Seconds of game time, for spacing blows on screen (oneHit). */
    clock: 0,
    setFighting(ch, victim) {
      ch.fighting = victim;
      ch.position = POS.FIGHTING;
    },
    /** fight.c: stop_fighting. `both` clears whoever was swinging back, too. */
    stopFighting(ch, both = true) {
      const other = ch.fighting;
      if (both && other && other.fighting === ch) {
        other.fighting = null;
        if (other.position === POS.FIGHTING) other.position = POS.STANDING;
        updatePos(other);
      }
      ch.fighting = null;
      if (ch.position === POS.FIGHTING) ch.position = POS.STANDING;
      updatePos(ch);
    },
    /** fight.c: disarm. A disarmed player's weapon lands on the ground. */
    disarm(ch, victim) {
      const obj = victim.equipment[WEAR.WIELD];
      if (!obj) return;
      if (!ch.equipment[WEAR.WIELD] && rng.bits(1) === 0) return;
      unequipChar(victim, obj);
      if (isNpc(victim)) victim.inventory.push(obj);
      else {
        const vpc = pcOf(victim);
        objToRoom(obj, victim.roomVnum, dropSpot(vpc.position, vpc.facing));
      }
      const text = !isNpc(victim) ? `${capitalise(ch.name)} disarms you!`
        : (!isNpc(ch) ? `You disarm ${victim.name}!` : `${capitalise(ch.name)} disarms ${victim.name}!`);
      if (multi && !isNpc(victim)) {
        // The one disarmed hears it; a player who did it hears their own line.
        tell(victim, { kind: 'disarm', text, item: obj.name, ...blow(ch, victim) });
        if (!isNpc(ch)) tell(ch, { kind: 'disarm', text: `You disarm ${victim.name}!`, item: obj.name });
        roomcast(victim.roomVnum, { kind: 'room', text: `${capitalise(ch.name)} disarms ${victim.name}!` }, [ch, victim]);
        return;
      }
      emit({ kind: 'disarm', text, item: obj.name, ...blow(ch, victim) });
    },
    /**
     * fight.c: do_flee, for a mobile: six tries at a random door, and out
     * through the first one that is open and not NO_MOB -- run, not walked,
     * and only once the blow that frightened it has been seen to land. If none
     * opens, it stays and fights, as it does in the mud.
     */
    flee(ch) {
      if (isNpc(ch)) {
        const slot = ch.slot;
        if (!slot) return;
        const room = world.rooms.get(slot.roomVnum);
        for (let attempt = 0; attempt < 6; attempt++) {
          const door = rng.range(0, 5);
          const exit = room && room.exits[door];
          const to = exit && !exit.offMap ? world.rooms.get(exit.to) : null;
          if (!to || (to.flags & ROOM_NO_MOB)) continue;
          if (!moveMobile(slot, door, true, (ctx.now ?? 0) + 0.35)) continue;
          ctx.stopFighting(ch);
          emit({ kind: 'flee', text: `${capitalise(ch.name)} has fled!`, from: slot });
          return;
        }
      } else {
        withPlayer(pcOf(ch), () => breakOff(true));
      }
    },
    kill(ch, victim) { deathHandler(ch, victim); },
    // fight.c's is_safe and check_killer (rules/actcomm.js), which only ever
    // have anything to say when both sides are players.
    isSafe: (ch, victim) => (rules.isSafe ? rules.isSafe(ch, victim) : false),
    checkKiller: (ch, victim) => { if (rules.checkKiller) rules.checkKiller(ch, victim); },
  };

  // -- magic ----------------------------------------------------------------
  // magic.js holds the spells; these are the places magic.c reaches back
  // into the rest of the mud, answered in metres.
  const posOf = (ch) => (isNpc(ch) ? ch.slot.pos : pcOf(ch).position);
  const magic = createMagic({
    rng, emit, ctx, player: state, damage, updatePos,
    gainExp: (ch, gain) => gainExp(ch, gain, rng),
    distance: (a, b) => dist2(posOf(a), posOf(b)),
    people(ch, radius) {
      const at = posOf(ch);
      const out = [];
      for (const pc of players) {
        if (pc.ch.position !== POS.DEAD && dist2(pc.position, at) <= radius * radius) out.push(pc.ch);
      }
      for (const slot of mobsNear(at, radius)) if (slot.instance && !slot.dead) out.push(slot.instance);
      return out;
    },
    // A player who is not the caster: their own lines, and the room's.
    tell: multi ? tell : null,
    roomcast: multi ? (actor, event) => roomcast(isNpc(actor) ? actor.slot.roomVnum : actor.roomVnum, event, [actor]) : null,
    /** A spell set off on one player's turn lands on whoever's turn it is then. */
    asCaster: (ch, fn) => withPlayer(isNpc(ch) ? current : pcOf(ch), fn),
    /**
     * do_cast's last act: the victim of an offensive spell fights back. As
     * with an aggressive mobile (aggrUpdate), out of reach it only picks the
     * fight and comes for you; the violence pulse swings once it is there.
     */
    strikeBack(victim, ch) {
      if (victim.fighting || !isAwake(victim)) return;
      if (dist2(feetOf(victim), feetOf(ch)) > MELEE * MELEE) {
        ctx.setFighting(victim, ch);
        if (!ch.fighting) ctx.setFighting(ch, victim);
        return;
      }
      ctx.round = { player: 0, npc: MOB_BEAT };
      try { multiHit(victim, ch, undefined, ctx); } finally { ctx.round = null; ctx.now = undefined; }
    },
    recall(ch) { if (!isNpc(ch)) withPlayer(pcOf(ch), () => recall(false)); },
    /**
     * spell_teleport: a random room, any room the mud has that is not private.
     * DIVERGES: only the player is ever moved -- a mobile's body walks, and
     * cannot be put down across the map -- and only to a room that was built.
     */
    teleport(ch) {
      if (isNpc(ch)) return false;
      return withPlayer(pcOf(ch), () => teleport());
    },
    sky: () => weather.sky,
    outdoors(ch) {
      const info = built.rooms.get(isNpc(ch) ? ch.slot.roomVnum : ch.roomVnum);
      return !!(info && info.outdoor);
    },
    extract(ch, obj) {
      const i = ch.inventory.indexOf(obj);
      if (i >= 0) { ch.inventory.splice(i, 1); return; }
      if (obj.wearLoc >= 0 && ch.equipment[obj.wearLoc] === obj) { unequipChar(ch, obj); return; }
      throw new Error(`game.js: extract of ${obj.name}, which ${ch.name} does not have`);
    },
  });
  rebinders.push((ch) => magic.bindPlayer(ch));

  /** spell_teleport for the player whose turn it is. */
  function teleport() {
    const rooms = [...built.rooms.values()]
      .filter((info) => !info.unbuilt && info.room && !(info.room.flags & (ROOM_PRIVATE | ROOM_SOLITARY)));
    if (!rooms.length) return false;
    const info = rooms[rng.range(0, rooms.length - 1)];
    if (state.fighting) ctx.stopFighting(state);
    emit({ kind: 'teleport', x: info.center.x, y: info.center.y, z: info.center.z, vnum: info.room.vnum });
    if (onTeleport) onTeleport(info.center.x, info.center.y, info.center.z, info.room.vnum);
    return true;
  }

  // -- death ----------------------------------------------------------------
  deathHandler = function onDeath(killer, victim) {
    if (isNpc(victim)) return mobDied(killer, victim);
    return withPlayer(pcOf(victim), () => playerDied(killer));
  };

  /**
   * fight.c: make_corpse, and limbo.are's #10 it is made from: "corpse of %s",
   * a timer of two to four ticks, the gold as create_money inside it, and
   * everything carried or worn except a shopkeeper's ITEM_INVENTORY stock.
   */
  function makeCorpse(mob) {
    const contains = [];
    if (mob.gold > 0) {
      contains.push(createMoney(mob.gold));
      mob.gold = 0;
    }
    for (const obj of mob.inventory) {
      if (obj.extraFlags & X.INVENTORY) continue;   // shop stock is not real
      contains.push(obj);
    }
    for (const obj of mob.equipment) if (obj) contains.push(obj);
    for (const obj of contains) obj.wearLoc = WEAR.NONE;
    // What the body still has in its hands, for whoever draws it.
    const wornWeapon = mob.equipment[WEAR.WIELD];
    const wornShield = mob.equipment[WEAR.SHIELD];
    mob.inventory = [];
    mob.equipment = new Array(MAX_WEAR).fill(null);
    return makeObject({
      vnum: OBJ_VNUM.CORPSE_NPC, name: `corpse of ${mob.name}`, keywords: 'corpse',
      description: `The corpse of ${mob.name} is lying here.`,
      itemType: ITEM.CORPSE_NPC, wearFlags: ITEM_TAKE, values: [0, 0, 0, 1], weight: 100,
      timer: rng.range(2, 4), contains, slot: mob.slot, wornWeapon, wornShield,
    });
  }

  /**
   * make_corpse for a player: limbo.are's #11, "corpse of %s", a timer of
   * 25 to 40 ticks, and everything carried or worn -- taken off first, so
   * its affects go with it. The gold stays with the player, as 2.1 has it.
   * `owner` is the name do_get reads off the short description; `look` is
   * for drawing the body.
   */
  function makePlayerCorpse(ch) {
    const contains = [];
    for (const obj of ch.equipment) if (obj) { unequipChar(ch, obj); contains.push(obj); }
    for (const obj of ch.inventory) if (!(obj.extraFlags & X.INVENTORY)) contains.push(obj);
    ch.inventory = [];
    for (const obj of contains) obj.wearLoc = WEAR.NONE;
    return makeObject({
      vnum: OBJ_VNUM.CORPSE_PC, name: `corpse of ${ch.name}`, keywords: 'corpse',
      description: `The corpse of ${ch.name} is lying here.`,
      itemType: ITEM.CORPSE_PC, wearFlags: 0, values: [0, 0, 0, 1], weight: 100,
      timer: rng.range(25, 40), contains, owner: ch.name, look: { cls: ch.class, sex: ch.sex, level: ch.level },
    });
  }

  function mobDied(killer, mob) {
    const slot = mob.slot;
    ctx.stopFighting(mob);
    for (const pc of players) if (pc.ch.fighting === mob) ctx.stopFighting(pc.ch);

    const cry = DEATH_CRIES[rng.bits(3) % DEATH_CRIES.length]
      .replace(/\$n/g, mob.name).replace(/\$s/g, mob.sex === 2 ? 'her' : 'his');
    emit({
      kind: 'death', text: capitalise(cry), name: mob.name, x: slot.pos.x, y: slot.pos.y, z: slot.pos.z,
      ...(multi ? { room: slot.roomVnum, except: [], slot } : null),
    });

    const corpse = makeCorpse(mob);
    objToRoom(corpse, slot.roomVnum, slot.pos);
    slot.dead = true;
    slot.corpse = corpse;
    slot.instance = null;
    layOut(slot);

    // fight.c: group_gain -- only a player killing an NPC scores, and every
    // member of the killer's group standing in the room shares it.
    if (!isNpc(killer)) {
      const info = protoInfo.get(mob.proto.vnum);
      const group = rules.groupGain ? rules.groupGain(killer) : [killer];
      for (const gch of group) {
        withPlayer(pcOf(gch), () => {
          // "You are too high for this group." and the like: rules/actcomm.js.
          if (rules.groupMayShare && !rules.groupMayShare(gch, killer)) return;
          const xp = idiv(xpComputeWith(state, mob, killTable, info.killed, rng), group.length);
          emit({ kind: 'xp', amount: xp, text: `You receive ${xp} experience points.` });
          gainExp(state, xp, rng, (gains) => {
            emit({
              kind: 'level', level: state.level, gains,
              title: titleFor(state),
              text: `You raise a level!!  Your gain is: ${gains.hp} hp, ${gains.mana} m,`
                + ` ${gains.move} mv, ${gains.prac} prac.`,
            });
          });
        });
      }
      // raw_kill's count, after everyone's share was worked out on the old one.
      info.killed += 1;
      killTable[clamp(mob.level, 0, MAX_LEVEL - 1)].killed += 1;
    }

    let firstRoad = false;
    const opened = gates.filter((gate) => !gate.open && gate.warden === slot.record);
    for (const gate of opened) {
      gate.open = true;
      gate.openedAt = ctx.clock;
      if (gate.outdoor && !roads.some((g) => g !== gate && g.open)) firstRoad = true;
    }
    if (opened.length) {
      const ways = waysPhrase(opened, wayFrom(state ? state.roomVnum : slot.roomVnum));
      emit({
        kind: 'gate', vnum: opened[0].vnum, to: opened[0].to, name: opened[0].name, gates: opened,
        text: `${capital(ways)} ${opened.length > 1 && ways.startsWith('the ways') ? 'are' : 'is'} no longer held.`,
        // A gate is the world's, not the killer's: everyone's map opens it.
        ...(multi ? { pc: null, all: true } : null),
      });
    }
    // One road out is the ending. Every road out is not: the gear this city
    // sells cannot beat the guildmasters or the executioner, so the rest of
    // that list is the horizon rather than the goal.
    if (firstRoad) emit({ kind: 'ending', text: 'The road out of Midgaard is open.', ...(multi ? { pc: null, all: true } : null) });
  }

  /** Merc's death penalty: half the way back to the level you were. */
  function playerDied(killer) {
    emit({ kind: 'death', text: 'You have been KILLED!!', player: true, by: killer ? killer.name : 'something' });
    roomcast(state.roomVnum, { kind: 'room', text: `${capitalise(state.name)} is DEAD!!` }, [state]);
    if (rules.playerKilled) rules.playerKilled(killer, state);
    if (state.exp > 1000 * state.level) {
      const lose = idiv(1000 * state.level - state.exp, 2);
      gainExp(state, lose, rng);
      emit({ kind: 'xp', amount: lose, text: `You lose ${-lose} experience points.` });
    }
    for (const slot of mobs) {
      if (slot.instance && slot.instance.fighting === state) ctx.stopFighting(slot.instance);
    }
    for (const pc of players) if (pc.ch.fighting === state) ctx.stopFighting(pc.ch);
    // fight.c: raw_kill for a PC -- make_corpse first, on a server, where
    // there is somebody else to come across it. DIVERGES: alone, the page
    // keeps your gear on you, as it always has.
    if (multi) objToRoom(makePlayerCorpse(state), state.roomVnum, feet());
    // Then affects stripped, armour back to 100, resting, and one point of everything.
    state.fighting = null;
    magic.stripAll(state);
    state.armor = 100;
    for (const obj of state.equipment) if (obj) state.armor -= applyAc(obj, obj.wearLoc);
    state.position = POS.RESTING;
    state.hit = Math.max(1, state.hit);
    state.mana = Math.max(1, state.mana);
    state.move = Math.max(1, state.move);
    recall(true);
  }

  function titleFor(ch) {
    // title_table is 40 levels x 4 classes of prose; the class name and level
    // carry the same information without transcribing 160 strings.
    return `${CLASS_TABLE[ch.class].name} of the ${ch.level}th level`;
  }

  /**
   * The body drops where it stood -- on the beat of the blow that killed it,
   * which is `ctx.now` while the round is being resolved.
   */
  function layOut(slot) {
    slot.travel = null;
    order(slot, { kind: 'dead', delay: (ctx.now ?? 0) + 0.08 });
  }

  /** The corpse crumbling to dust: the body sinks and goes. */
  function removeBody(slot) {
    order(slot, { kind: 'gone' });
  }

  // -- recall ---------------------------------------------------------------
  let onTeleport = null;

  /** act_move.c: do_recall. Half your movement, and the temple. */
  function recall(afterDeath = false) {
    // The temple may be in a zone that is not drawn: then there is no point
    // to stand on yet, only the room, and main.js crosses to it.
    const temple = built.rooms.get(ROOM_VNUM_TEMPLE)
      || (world.rooms.has(ROOM_VNUM_TEMPLE) ? { center: { x: undefined, y: undefined, z: undefined } } : null)
      || built.rooms.values().next().value;
    if (!temple) return false;
    if (!afterDeath && state.fighting) {
      if (rng.bits(1) === 0) {
        gainExp(state, -50, rng);
        emit({ kind: 'note', text: 'You failed!  You lose 50 exps.' });
        return false;
      }
      gainExp(state, -100, rng);
      emit({ kind: 'note', text: 'You recall from combat!  You lose 100 exps.' });
      ctx.stopFighting(state);
    }
    state.move = idiv(state.move, 2);
    emit({
      kind: 'recall', vnum: ROOM_VNUM_TEMPLE, text: 'You pray for transportation!',
      x: temple.center.x, y: temple.center.y, z: temple.center.z,
    });
    if (onTeleport) onTeleport(temple.center.x, temple.center.y, temple.center.z, temple.room ? temple.room.vnum : ROOM_VNUM_TEMPLE);
    return true;
  }

  /**
   * fight.c: do_flee. Breaking off costs the mud's 25 exps.
   *
   * do_flee moves you to another room and the fight is simply over. There is no
   * other room to be moved to here, so instead you get a second and a half of
   * nobody swinging at you -- long enough to turn round and run, which is the
   * same bargain in a different shape.
   */
  /**
   * fight.c's violence_update ends a fight whenever the two are no longer in
   * one room: stop_fighting, not a flight, so it costs nothing. A fight here
   * spans a few metres of street, so it holds while the foe is in this room
   * or the next one, or within BREAK -- past all of that you were carried
   * off (recall, a portal, a debug jump), and the troll's plate used to ride
   * along through two rooms of another area saying "fighting you".
   */
  function loseTouch() {
    const mob = state.fighting;
    if (!mob || (isNpc(mob) ? !mob.slot : !pcOf(mob))) return;
    if (dist2(isNpc(mob) ? mob.slot.pos : pcOf(mob).position, position) <= BREAK * BREAK) return;
    const here = world.rooms.get(state.roomVnum);
    const there = world.rooms.get(isNpc(mob) ? mob.slot.roomVnum : mob.roomVnum);
    if (here && here === there) return;
    const joined = (a, b) => !!(a && b && a.exits.some((e) => e && e.to === b.vnum));
    if (joined(here, there) || joined(there, here)) return;
    ctx.stopFighting(state);
  }

  function breakOff(forced) {
    if (!state.fighting) return;
    const name = state.fighting.name;
    ctx.stopFighting(state);
    gainExp(state, -25, rng);
    current.invulnerable = Math.max(current.invulnerable, 1.5);
    emit({
      kind: 'flee',
      text: forced ? 'You flee from combat!  You lose 25 exps.' : `You break off from ${name}.  You lose 25 exps.`,
    });
  }

  // -- weather --------------------------------------------------------------
  /**
   * update.c: weather_update, over db.c's boot seeding. The mud has always had
   * real weather -- a barometer that wanders, and four sky states it walks
   * between -- so the viewer's sky comes from here rather than from a dial.
   *
   * Three things about this are not the mud's:
   *
   * A generator of its own. Merc rolls the weather out of the one global
   * stream; here that stream is pinned by `seed` and driven by a test harness,
   * and a sky that quietly shifted every combat roll after it would be a poor
   * trade for a cloud.
   *
   * A calendar of its own. `state.hour` is the *player's* hour -- whatever the
   * time-of-day preset was last set to, which is what shop hours read -- and it
   * does not advance. This one does, at `WEATHER_SECONDS` a mud hour, and only
   * so the day and month can roll over, because the month is the season term in
   * the pressure walk. The two are deliberately not the same clock: tying them
   * would make an hour of weather also move the sun.
   *
   * No sunlight. weather_update also sets SUN_* and announces sunrise and
   * sunset; the viewer's daylight is `applyTime` in main.js and belongs to the
   * player, so porting a second one would put two suns in the state.
   */
  const weatherRng = new Rng(seed === undefined ? undefined : (seed ^ 0x9e3779b9) >>> 0);
  const wdice = (number, size) => {
    let sum = 0;
    for (let i = 0; i < number; i++) sum += weatherRng.range(1, size);
    return sum;
  };

  /**
   * db.c: the calendar is read off the wall clock at boot -- one mud hour per
   * PULSE_TICK, counted from Merc's own epoch -- so a session started in the
   * mud's month 11 gets month 11's weather, exactly as the 1993 server would.
   */
  const MERC_EPOCH = 650336715;
  const lhour = idiv(Date.now() / 1000 - MERC_EPOCH, PULSE_TICK / PULSE_PER_SECOND);
  const lday = idiv(lhour, 24);
  const lmonth = idiv(lday, 35);
  const weather = {
    hour: lhour % 24,
    day: lday % 35,
    month: lmonth % 17,
    year: idiv(lmonth, 17),
    change: 0,
    mmhg: 960,
    sky: SKY.CLOUDLESS,
  };
  weather.mmhg += weather.month >= 7 && weather.month <= 12
    ? weatherRng.range(1, 50)
    : weatherRng.range(1, 80);
  if (weather.mmhg <= 980) weather.sky = SKY.LIGHTNING;
  else if (weather.mmhg <= 1000) weather.sky = SKY.RAINING;
  else if (weather.mmhg <= 1020) weather.sky = SKY.CLOUDY;
  else weather.sky = SKY.CLOUDLESS;
  state.weather = weather;

  /**
   * How long a mud hour of weather takes. Merc runs weather_update off the
   * point-pulse, which reschedules itself with number_range(PULSE_TICK / 2,
   * 3 * PULSE_TICK / 2) -- 15 to 45 real seconds, averaging 30. This sits
   * inside that band, at the slow end: the sky here is a thing you notice
   * while walking, not while standing still reading a shop list.
   */
  const WEATHER_SECONDS = 40;
  let weatherAccum = 0;

  /** update.c: weather_update, minus the sunlight. `room` is where you stand. */
  function weatherUpdate(room) {
    const lines = [];

    if (++weather.hour >= 24) { weather.hour = 0; weather.day++; }
    if (weather.day >= 35) { weather.day = 0; weather.month++; }
    if (weather.month >= 17) { weather.month = 0; weather.year++; }

    // The season: months 9-16 are the low-pressure half of the year, and the
    // barometer is pushed back towards a lower resting point in them.
    const diff = weather.month >= 9 && weather.month <= 16
      ? (weather.mmhg > 985 ? -2 : 2)
      : (weather.mmhg > 1015 ? -2 : 2);

    weather.change = clamp(weather.change + diff * wdice(1, 4) + wdice(2, 6) - wdice(2, 6), -12, 12);
    weather.mmhg = clamp(weather.mmhg + weather.change, 960, 1040);

    switch (weather.sky) {
      case SKY.CLOUDLESS:
        if (weather.mmhg < 990 || (weather.mmhg < 1010 && weatherRng.bits(2) === 0)) {
          lines.push('The sky is getting cloudy.');
          weather.sky = SKY.CLOUDY;
        }
        break;

      case SKY.CLOUDY:
        if (weather.mmhg < 970 || (weather.mmhg < 990 && weatherRng.bits(2) === 0)) {
          lines.push('It starts to rain.');
          weather.sky = SKY.RAINING;
        }
        if (weather.mmhg > 1030 && weatherRng.bits(2) === 0) {
          lines.push('The clouds disappear.');
          weather.sky = SKY.CLOUDLESS;
        }
        break;

      case SKY.RAINING:
        if (weather.mmhg < 970 && weatherRng.bits(2) === 0) {
          lines.push('Lightning flashes in the sky.');
          weather.sky = SKY.LIGHTNING;
        }
        if (weather.mmhg > 1030 || (weather.mmhg > 1010 && weatherRng.bits(2) === 0)) {
          lines.push('The rain stopped.');
          weather.sky = SKY.CLOUDY;
        }
        break;

      case SKY.LIGHTNING:
        if (weather.mmhg > 1010 || (weather.mmhg > 990 && weatherRng.bits(2) === 0)) {
          lines.push('The lightning has stopped.');
          weather.sky = SKY.RAINING;
        }
        break;

      // Merc's own default arm: it bug()s a bad sky and resets. Unreachable
      // here, since nothing but this function ever writes `sky`.
      default:
        weather.sky = SKY.CLOUDLESS;
        break;
    }

    // The weather changes whether or not anyone is under it, but only someone
    // outside and awake is told: the mud walks the descriptor list with
    // IS_OUTSIDE and IS_AWAKE before sending a line.
    if (multi) {
      for (const pc of players) {
        const info = built.rooms.get(pc.ch.roomVnum);
        if (!info || !info.outdoor || !isAwake(pc.ch)) continue;
        for (const text of lines) tell(pc.ch, { kind: 'weather', text });
      }
      return;
    }
    if (!lines.length || !room || !room.outdoor || !isAwake(state)) return;
    for (const text of lines) emit({ kind: 'weather', text });
  }

  // -- the clock ------------------------------------------------------------
  let pulseAccum = 0;
  let pulseViolence = PULSE_VIOLENCE;
  let pulsePoint = PULSE_TICK;
  let pulseMobile = PULSE_MOBILE;

  /** fight.c: violence_update, with metres where the mud asks about rooms. */
  function violenceUpdate() {
    ctx.round = { player: 0, npc: MOB_BEAT };
    try { violenceRound(); } finally { ctx.round = null; ctx.now = undefined; }
  }

  function violenceRound() {
    for (const pc of players.slice()) withPlayer(pc, playerRound);
    for (const slot of mobs) {
      const mob = slot.instance;
      if (!mob || slot.dead || !mob.fighting) continue;
      if (!isAwake(mob)) { ctx.stopFighting(mob, false); continue; }
      // Whoever it is fighting: you, or -- a cityguard answering a scream -- another mobile.
      const victim = mob.fighting;
      const there = isNpc(victim) ? (victim.slot && !victim.slot.dead ? victim.slot.pos : null)
        : (pcOf(victim) ? pcFeet(pcOf(victim)) : null);
      if (!there || victim.position === POS.DEAD) { ctx.stopFighting(mob, false); continue; }
      if (dist2(slot.pos, there) > BREAK * BREAK) { ctx.stopFighting(mob); continue; }
      if (dist2(slot.pos, there) > MELEE * MELEE) continue;
      if (!isNpc(victim) && pcOf(victim).invulnerable > 0) continue;
      // The blows land on the victim's screen when the victim is a player.
      withPlayer(isNpc(victim) ? null : pcOf(victim), () => {
        multiHit(mob, victim, undefined, ctx);
        if (mob.fighting) assist(slot, mob, mob.fighting);
      });
    }
  }

  /** The bound player's swings this round, at a mobile -- or another player. */
  function playerRound() {
    if (!state.fighting) return;
    const mob = state.fighting;
    const foe = isNpc(mob) ? mob.slot.pos : (pcOf(mob) ? pcFeet(pcOf(mob)) : null);
    // Below zero hitpoints you are stunned, and the mud stops your swings
    // dead: IS_AWAKE is false and violence_update drops you out of the fight.
    if (!isAwake(state)) ctx.stopFighting(state, false);
    else if (!foe || mob.position === POS.DEAD || dist2(foe, position) > BREAK * BREAK) breakOff(true);
    else if (!isNpc(mob) && pcOf(mob).invulnerable > 0) return;
    else if (dist2(foe, feet()) <= MELEE * MELEE) multiHit(state, mob, undefined, ctx);
  }

  /**
   * violence_update's "Fun for the whole family!": every idle, awake mobile in
   * the room joins a fight on the side of one of its own kind, and one in eight
   * joins whatever fight is going. DIVERGES the way aggr_update does: out of
   * reach it takes the fight up and comes at the target, and the next round's
   * pulse swings once it is there.
   */
  function assist(fromSlot, ch, victim) {
    for (const slot of mobs) {
      const rch = slot.instance;
      if (!rch || slot === fromSlot || slot.dead || rch.fighting || !isAwake(rch)) continue;
      if (slot.roomVnum !== fromSlot.roomVnum) continue;
      if (rch.proto !== ch.proto && rng.bits(3) !== 0) continue;
      if (!canSee(rch, victim)) continue;
      if (!isNpc(victim) && pcOf(victim).invulnerable > 0) continue;
      const there = feetOf(victim);
      if (dist2(slot.pos, there) > MELEE * MELEE) {
        ctx.setFighting(rch, victim);
        if (!victim.fighting) ctx.setFighting(victim, rch);
        continue;
      }
      multiHit(rch, victim, undefined, ctx);
    }
  }

  /** update.c: aggr_update, for every player. */
  function aggrUpdate() {
    for (const pc of players.slice()) withPlayer(pc, aggrOn);
  }

  /** ...and for the bound one. ACT_WIMPY aggressives only jump you in your sleep. */
  function aggrOn() {
    if (current.invulnerable > 0 || state.position === POS.DEAD) return;
    for (const slot of mobsNear(position, AGGRO)) {
      const mob = slot.instance;
      if (!mob || mob.fighting || !isAwake(mob)) continue;
      if (!(mob.act & ACT_AGGRESSIVE)) continue;
      if ((mob.act & ACT_WIMPY) && isAwake(state)) continue;
      if (!canSee(mob, state)) continue;        // hidden: act_move.c's do_hide pays off here
      // DIVERGES: the mud's multi_hit here is from anywhere in the room, and
      // AGGRO stands in for the room at nine metres -- so the first round
      // used to land from across the street. Out of reach, the mobile only
      // picks the fight (set_fighting, both ways, as damage() would) and
      // comes at you; the violence pulse swings once it is there.
      if (dist2(slot.pos, feet()) > MELEE * MELEE) {
        ctx.setFighting(mob, state);
        if (!state.fighting) ctx.setFighting(state, mob);
        continue;
      }
      ctx.round = { player: 0, npc: AMBUSH_WINDUP };
      try { multiHit(mob, state, undefined, ctx); } finally { ctx.round = null; ctx.now = undefined; }
    }
  }

  /**
   * update.c: char_update, for the player -- regeneration by position (and
   * halved by hunger and by thirst, quartered by poison), a worn light burning
   * down, the three conditions ticking toward empty, and the slow death of
   * someone left incapacitated -- and hit_gain for every woken mobile.
   */
  function charUpdate() {
    // The page's one player, as it always was: dead, nothing ticks.
    if (!multi && state.position === POS.DEAD) return;
    for (const pc of players.slice()) withPlayer(pc, charUpdatePlayer);

    for (const slot of mobs) {
      const mob = slot.instance;
      if (!mob || slot.dead) continue;
      if (!mob.fighting) mob.hit = Math.min(mob.maxHit, mob.hit + idiv(idiv(mob.level * 3, 2), (mob.affectedBy & AFF.POISON) ? 4 : 1));
    }

    // char_update's affect loop, then poison: the players and everyone woken.
    for (const pc of players.slice()) withPlayer(pc, () => magic.tick(state));
    for (const slot of mobs) if (slot.instance && !slot.dead) magic.tick(slot.instance);
  }

  /** char_update's half that is not the players': the mobiles' regain and their spells. */
  function charUpdateWorld() {
    for (const slot of mobs) {
      const mob = slot.instance;
      if (!mob || slot.dead) continue;
      if (!mob.fighting) mob.hit = Math.min(mob.maxHit, mob.hit + idiv(idiv(mob.level * 3, 2), (mob.affectedBy & AFF.POISON) ? 4 : 1));
    }
    for (const slot of mobs) if (slot.instance && !slot.dead) magic.tick(slot.instance);
  }

  /** char_update's player half, for the bound one. */
  function charUpdatePlayer() {
    if (state.position === POS.DEAD) return;
    if (state.position >= POS.STUNNED) {
      if (state.hit < state.maxHit) state.hit += hitGain(state);
      if (state.mana < state.maxMana) state.mana += manaGain(state);
      if (state.move < state.maxMove) state.move += moveGain(state);
    }
    if (state.position === POS.STUNNED) updatePos(state);

    if (state.level < LEVEL_IMMORTAL) {
      const light = state.equipment[WEAR.LIGHT];
      if (light && light.itemType === ITEM.LIGHT && light.values[2] > 0) {
        if (--light.values[2] === 0) {
          emit({ kind: 'light-out', text: `${capitalise(light.name)} goes out.`, item: light.name });
          unequipChar(state, light);
        }
      }
      // DIVERGES: ch->timer, the idle clock that sends a player who has not
      // typed for twelve ticks into the void and quits them at thirty, is not
      // kept -- a browser tab left open is not a link that has gone dead.
      gainCondition(state, COND.DRUNK, -1);
      gainCondition(state, COND.FULL, -1);
      gainCondition(state, COND.THIRST, -1);
    }

    if (state.position === POS.INCAP) damage(state, state, 1, -1, ctx);
    else if (state.position === POS.MORTAL) damage(state, state, 2, -1, ctx);
  }

  /** update.c: gain_condition, with its three messages. */
  function gainCondition(ch, iCond, value) {
    if (value === 0 || isNpc(ch) || ch.level >= LEVEL_HERO) return;
    const before = ch.condition[iCond];
    ch.condition[iCond] = clamp(before + value, 0, 48);
    if (ch.condition[iCond] !== 0) return;
    if (iCond === COND.FULL) emit({ kind: 'condition', cond: 'hungry', text: 'You are hungry.' });
    else if (iCond === COND.THIRST) emit({ kind: 'condition', cond: 'thirsty', text: 'You are thirsty.' });
    else if (before !== 0) emit({ kind: 'condition', cond: 'sober', text: 'You are sober.' });
  }

  // -- mobile_update ------------------------------------------------------------
  /**
   * Its own generator, for the weather's reason: how often a beggar crosses the
   * street should not move a single combat roll. Merc draws both from the one
   * stream.
   */
  const wanderRng = new Rng(seed === undefined ? undefined : (seed ^ 0x51ed270b) >>> 0);
  const wanderRand = () => wanderRng.raw() / 0x80000000;

  /** db.c: room_is_private, with the people counted from where the bodies are. */
  function roomIsPrivate(vnum, counts) {
    const room = world.rooms.get(vnum);
    if (!room) return true;
    const count = counts.get(vnum) || 0;
    if ((room.flags & ROOM_PRIVATE) && count >= 2) return true;
    if ((room.flags & ROOM_SOLITARY) && count >= 1) return true;
    return false;
  }

  /**
   * act_move.c: move_char, for a mobile, as far as the viewer can carry it out.
   * The mud moves a character between rooms in one step; here the body walks
   * the street the layout routed for that exit, or goes through the archway,
   * and it is in the new room when it gets there. Refusals are move_char's:
   * no exit, a closed door, a private room. What cannot be walked at all -- an
   * exit into an area that was not loaded, a room that was never built -- is
   * one more refusal, which the mud never needed.
   */
  function moveMobile(slot, door, run = false, wait = 0) {
    const room = world.rooms.get(slot.roomVnum);
    const exit = room && room.exits[door];
    if (!exit || exit.offMap) return false;
    const to = exit.to;
    if (!sameZone(slot.roomVnum, to)) return false;
    // Out of the drawn zone the move is the mud's own: instant, refused only
    // by a shut door. Never into a room the drawn zone built, though -- a
    // body would have to appear there from nowhere.
    if (!slot.here) {
      if (built.rooms.has(to) || (exit.locks & EX_CLOSED)) return false;
      slot.roomVnum = to;
      return true;
    }
    if (!built.rooms.has(to) || built.rooms.get(to).unbuilt) return false;
    if (!ways.doorOpen(slot.roomVnum, door, to, actors ? actors.doors : null)) return false;
    const route = ways.route(slot.roomVnum, door, to, slot.pos, wanderRand);
    if (!route) return false;
    slot.travel = { from: slot.roomVnum, to, door, route, run };
    order(slot, { kind: 'travel', route, run, wait });
    // Anyone following it goes the same way (rules/actcomm.js).
    if (multi && rules.mobMoved) rules.mobMoved(slot, slot.roomVnum, to, door);
    return true;
  }

  /**
   * update.c: mobile_update -- scavenging, wandering and the wounded slipping
   * away -- every PULSE_MOBILE, over every mobile in the world.
   *
   * The spec_funs themselves are not in this file: `game.mobileSpec`, when
   * set, is called first for each woken mobile and a true return ends its
   * turn. DIVERGES: a mobile already walking between two rooms is left to
   * finish: the mud's move is instant, so it never has to ask.
   */
  let mobileSpec = null;
  /**
   * special.c's spec_lookup, as a table: the #SPECIALS name (`record.special`)
   * to fn(slot, mob), true if it acted. Filled from outside -- magic.js puts
   * the casters and breathers in -- and exposed as `game.specFuns`.
   */
  const SPEC_FUNS = {};
  magic.install(SPEC_FUNS);
  // What rules/*.js install: area_update, obj_update and the like.
  const rules = {};
  function mobileUpdate() {
    const counts = new Map();
    for (const slot of mobs) if (!slot.dead) counts.set(slot.roomVnum, (counts.get(slot.roomVnum) || 0) + 1);
    for (const pc of players) {
      if (pc.ch.roomVnum !== undefined) counts.set(pc.ch.roomVnum, (counts.get(pc.ch.roomVnum) || 0) + 1);
    }

    for (const slot of mobs) {
      if (slot.dead || slot.travel) continue;
      // Out of the drawn zone and never seen: made when the zone was left (or
      // at boot), or here if a reset brought it back since.
      if (!slot.here && !slot.instance) wake(slot, wanderRng);
      const mob = slot.instance;
      const act = slot.proto.act;
      // "Examine call for special procedure": a spec_fun that acted ends this
      // mobile's turn, as in update.c. `game.mobileSpec` is where one plugs in.
      const spec = SPEC_FUNS[slot.record.special];
      if (mob && ((spec && spec(slot, mob)) || (mobileSpec && mobileSpec(slot, mob)))) continue;
      // "That's all for sleeping / busy monster": fighting is busy.
      if (mob && mob.position !== POS.STANDING) continue;
      const room = world.rooms.get(slot.roomVnum);
      if (!room) continue;

      // Scavenge: the dearest thing lying loose in the room.
      if ((act & ACT_SCAVENGER) && wanderRng.bits(2) === 0) {
        let best = null;
        let max = 1;
        for (const obj of ground) {
          if (obj.inRoom !== slot.roomVnum) continue;
          if (canWear(obj, W.TAKE) && obj.cost > max) { best = obj; max = obj.cost; }
        }
        if (best) {
          objFromRoom(best);
          if (best.slot) removeBody(best.slot);    // a corpse is a thing to carry off, too
          wake(slot).inventory.push(best);
          toRoom(slot, `${capitalise(slot.proto.short)} gets ${best.name}.`, { kind: 'room', item: best.name });
        }
      }

      // Wander. Shopkeepers stay behind their counters whatever their flags
      // say: a shop the keeper has walked out of cannot be traded with.
      let door;
      if (!(act & ACT_SENTINEL) && !slot.record.shop
        && (door = wanderRng.bits(5)) <= 5) {
        const exit = room.exits[door];
        const to = exit && !exit.offMap ? world.rooms.get(exit.to) : null;
        if (to && !(to.flags & ROOM_NO_MOB)
          && (!(act & ACT_STAY_AREA) || to.area === room.area)
          && !roomIsPrivate(to.vnum, counts)
          && moveMobile(slot, door)) {
          counts.set(slot.roomVnum, counts.get(slot.roomVnum) - 1);
          counts.set(to.vnum, (counts.get(to.vnum) || 0) + 1);
          continue;
        }
      }

      // Flee: hurt, and somewhere nobody is.
      if (mob && mob.hit < idiv(mob.maxHit, 2) && (door = wanderRng.bits(3)) <= 5) {
        const exit = room.exits[door];
        const to = exit && !exit.offMap ? world.rooms.get(exit.to) : null;
        if (to && !(to.flags & ROOM_NO_MOB) && !roomIsPrivate(to.vnum, counts)
          && !players.some((pc) => pc.ch.roomVnum === to.vnum)) {
          moveMobile(slot, door, true);
        }
      }
    }
  }

  /**
   * comm.c/update.c: update_handler, one pulse.
   */
  let pulseArea = 0;
  function pulse() {
    for (const pc of players.slice()) {
      withPlayer(pc, () => { if (state.wait > 0 && --state.wait === 0 && rules.onWaitOver) rules.onWaitOver(); });
    }
    if (--pulseArea <= 0) {
      pulseArea = wanderRng.range(idiv(PULSE_AREA, 2), idiv(3 * PULSE_AREA, 2));
      if (rules.areaUpdate) rules.areaUpdate();
    }
    if (--pulseMobile <= 0) { pulseMobile = PULSE_MOBILE; mobileUpdate(); }
    if (--pulseViolence <= 0) { pulseViolence = PULSE_VIOLENCE; violenceUpdate(); }
    if (--pulsePoint <= 0) {
      // DIVERGES: the mud's point-pulse is 30 seconds because you would go and
      // do something else. Resting here means standing still watching a wall,
      // so resting runs the same clock four times as fast. The gains are the
      // mud's, only the waiting is compressed.
      const resting = !multi && players.length > 0
        && players.every((pc) => pc.ch.position === POS.RESTING || pc.ch.position === POS.SLEEPING);
      pulsePoint = resting ? idiv(PULSE_TICK, 4) : PULSE_TICK;
      // On a server the world keeps the mud's own clock; each player's half
      // runs on that player's (below).
      if (multi) charUpdateWorld(); else charUpdate();
      if (rules.objUpdate) rules.objUpdate();
    }
    // With more than one player, resting is each player's own: whoever lies
    // down gets the quick clock -- regaining, hungering, their spells wearing
    // off -- and nobody else's waiting is cut short by it.
    if (multi) {
      for (const pc of players.slice()) {
        if (pc.pulsePoint === undefined) pc.pulsePoint = PULSE_TICK;
        if (--pc.pulsePoint > 0) continue;
        const lying = pc.ch.position === POS.RESTING || pc.ch.position === POS.SLEEPING;
        pc.pulsePoint = lying ? idiv(PULSE_TICK, 4) : PULSE_TICK;
        withPlayer(pc, () => { charUpdatePlayer(); if (pcOf(pc.ch)) magic.tick(state); });
      }
    }
    aggrUpdate();
  }

  // -- movement -------------------------------------------------------------

  /** Hand a figure its order, keeping the same object while nothing changes. */
  function order(slot, next) {
    const current = slot.order;
    if (current && current.kind === next.kind && next.kind !== 'travel' && next.kind !== 'dead'
      && current.target === next.target && current.room === next.room && current.to === next.to
      && current.run === next.run) return current;
    slot.order = next;
    if (slot.figure) slot.figure.order = next;
    return next;
  }


  /**
   * What every mobile's body should be doing this frame. The body itself --
   * the path, the pace, stepping round people -- is actors.js's (motion.js);
   * headless, `stepHeadless` stands in for it in straight lines.
   */
  function moveMobs(dt) {
    // Every player as a target: feet on the ground, not the eye.
    for (const pc of players) pcFeet(pc);
    for (const slot of mobs) {
      if (slot.dead) continue;
      if (!slot.here) {
        // No body to walk an errand: it is done the moment it is set.
        const task = slot.task;
        slot.task = null;
        if (task && task.onArrive) task.onArrive();
        continue;
      }
      const mob = slot.instance;
      const figure = slot.figure;
      // The body is the truth about where a mobile is; the game follows it.
      if (figure && figure.at) {
        slot.pos.x = figure.at.x; slot.pos.y = figure.at.y; slot.pos.z = figure.at.z;
      }

      if (slot.travel) {
        const o = slot.order;
        if (o && (o.done || o.failed)) {
          slot.travel = null;
          slot.anchor = { ...slot.pos };
        } else if (mob && mob.fighting) {
          slot.travel = null;          // caught on the way: stand and fight
        } else {
          if (!figure) stepHeadless(slot, dt);
          // On the way, the room is whichever end of the journey is nearer --
          // not whatever `roomAt` says of the street underfoot, because
          // layout.js lets two passages share a cell and names only one of
          // them its owner (measured: 78 of 179 room changes in ten minutes
          // went through a room that was neither end).
          const from = built.rooms.get(slot.travel.from).center;
          const to = built.rooms.get(slot.travel.to).center;
          slot.roomVnum = dist2(slot.pos, to) < dist2(slot.pos, from) ? slot.travel.to : slot.travel.from;
          rebucket(slot);
          continue;
        }
      }

      if (mob && mob.fighting) {
        const foe = mob.fighting;
        const target = isNpc(foe) ? foe.slot.pos : (pcOf(foe) ? pcOf(foe).feet : slot.pos);
        // ACT_SENTINEL never leaves its room in the mud; here it never leaves
        // the spot it was reset on, and you have to come to it.
        if (mob.act & ACT_SENTINEL) order(slot, { kind: 'face', target });
        else if (dist2(slot.pos, slot.anchor) > LEASH * LEASH) {
          order(slot, { kind: 'go', to: slot.anchor });
          if (!figure) step(slot, slot.anchor, MOB_SPEED, 0.4, dt);
        } else {
          // Close enough to cross blades with another mobile; with you, a
          // little further, or a figure 1.5 m from your eye fills the frame.
          order(slot, { kind: 'chase', target, stop: !isNpc(foe) ? 2.0 : 1.5 });
          if (!figure) step(slot, target, MOB_SPEED, MELEE * 0.68, dt);
        }
      } else if (slot.task) {
        // A spec_fun's errand -- spec_janitor walking to the litter, spec_fido
        // to a corpse, spec_thief sidling up to you -- is an order of its own.
        const task = slot.task;
        const next = order(slot, task.order);
        if (!figure && next.kind === 'go') step(slot, next.to, 1.3, 0.3, dt);
        else if (!figure && next.kind === 'chase') step(slot, next.target, 1.3, next.stop ?? 1.2, dt);
        const goal = next.kind === 'go' ? next.to : next.target;
        const d = goal ? Math.hypot(goal.x - slot.pos.x, goal.z - slot.pos.z) : 0;
        task.age = (task.age || 0) + dt;
        const reached = (next.done && task.reach === undefined)
          || d <= (task.reach ?? (next.kind === 'go' ? 0.6 : (next.stop ?? 1.2) + 0.35));
        // An errand that cannot be walked in twenty seconds is given up.
        if (reached || next.failed || task.age > 20) {
          slot.task = null;
          if (reached && task.onArrive) task.onArrive();
        }
      } else if (slot.record.shop) {
        order(slot, { kind: 'hold', at: slot.home || (slot.home = { ...slot.pos }) });
      } else if (noticed(slot, dt)) {
        order(slot, slot.notice.order);
      } else {
        order(slot, { kind: 'stroll', room: slot.roomVnum });
      }
      settleRoom(slot);
    }
  }

  /**
   * Footsteps: someone who is not sneaking, coming up within a few metres of
   * a mobile's back, is heard, and it turns round to see who it is -- which is
   * what makes a backstab (fight.c's do_backstab, see rules/skills.js) a
   * matter of sneaking up behind. DIVERGES: the mud has no facing, and sneak
   * only ever hid your comings and goings from the room.
   */
  function noticed(slot, dt) {
    const mob = slot.instance;
    if (slot.notice) {
      slot.notice.left -= dt;
      if (slot.notice.left > 0) return true;
      slot.notice = null;
    }
    if (!mob || !slot.figure || !isAwake(mob)) return false;
    for (const pc of players) {
      if (hasAff(pc.ch, AFF.SNEAK)) continue;
      if (!canSee(mob, pc.ch) || dist2(slot.pos, pc.feet) > 3.4 * 3.4) continue;
      if (facingAway(slot, pc.feet) < 0.2) continue;
      slot.notice = { left: 3.5, order: { kind: 'hold', at: { ...slot.pos } } };
      return true;
    }
    return false;
  }

  /**
   * How far round the body is from you: 1 with its back square to you, -1
   * looking straight at you. A figure faces +Z at yaw 0 (motion.js turns it
   * with atan2(dx, dz)); headless there is no facing, and nobody has a back.
   */
  function facingAway(slot, from = current.feet) {
    const fig = slot.figure;
    if (!fig || !fig.object) return 1;
    const yaw = fig.object.rotation.y;
    const dx = from.x - slot.pos.x;
    const dz = from.z - slot.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    return -(Math.sin(yaw) * dx + Math.cos(yaw) * dz) / d;
  }

  /** Which room the body is standing in -- the half of a street nearer to it. */
  function settleRoom(slot) {
    const vnum = ways.roomAt(slot.pos.x, slot.pos.y, slot.pos.z);
    if (vnum !== undefined && vnum !== slot.roomVnum && built.rooms.has(vnum)) slot.roomVnum = vnum;
    rebucket(slot);
  }

  /** A route walked with no body to walk it: straight legs at a walking pace. */
  function stepHeadless(slot, dt) {
    const t = slot.travel;
    if (!t.leg) { t.leg = t.route.points.slice(); t.stage = 'walk'; }
    let budget = (t.run ? MOB_SPEED * 1.4 : 1.3) * dt;
    while (budget > 0) {
      const next = t.leg[0];
      if (!next) {
        if (t.stage === 'walk' && t.route.portal) {
          const p = t.route.portal;
          slot.pos.x = p.arrive.x; slot.pos.y = p.arrive.y; slot.pos.z = p.arrive.z;
          t.leg = (p.after || []).slice();
          t.stage = 'after';
          continue;
        }
        slot.order.done = true;
        return;
      }
      const dx = next.x - slot.pos.x; const dz = next.z - slot.pos.z;
      const d = Math.hypot(dx, dz);
      if (d <= budget) { slot.pos.x = next.x; slot.pos.z = next.z; budget -= d; t.leg.shift(); } else {
        slot.pos.x += (dx / d) * budget; slot.pos.z += (dz / d) * budget; budget = 0;
      }
    }
  }

  /** Headless only: with a body, motion.js walks it. */
  function step(slot, target, speed, stopAt, dt) {
    const dx = target.x - slot.pos.x;
    const dz = target.z - slot.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= stopAt || d < 1e-4) return;
    const travel = Math.min(speed * dt, d - stopAt);
    slot.pos.x += (dx / d) * travel;
    slot.pos.z += (dz / d) * travel;
  }

  // -- targeting ------------------------------------------------------------
  /**
   * Whatever the viewer has in its crosshair (`game.focus`), if it is a
   * mobile in reach: what `attack` swings at and what `target` describes.
   * The cone below used to decide on its own, 63 degrees wide, and a click
   * under a swamp troll's name could start a fight with the marsh wolf
   * beside it.
   */
  function facingTarget(reach = REACH, cone = 0.45) {
    const focusSlot = current.focusSlot;
    if (focusSlot && focusSlot.instance && !focusSlot.dead
      && dist2(focusSlot.pos, position) <= (reach + 1.8) * (reach + 1.8)) return focusSlot;
    let best = null;
    let bestScore = -Infinity;
    for (const slot of mobsNear(position, reach)) {
      if (!slot.instance) continue;
      const dx = slot.pos.x - position.x;
      const dz = slot.pos.z - position.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) continue;
      const dot = (dx / d) * facing.x + (dz / d) * facing.z;
      if (dot < cone) continue;
      const score = dot * 2 - d * 0.12;
      if (score > bestScore) { bestScore = score; best = slot; }
    }
    return best;
  }

  /** Whoever you are fighting, or whoever you are looking at. */
  function currentTarget() {
    if (state.fighting && (!isNpc(state.fighting) || !state.fighting.slot.dead)) return state.fighting;
    const slot = facingTarget();
    return slot ? slot.instance : null;
  }

  // -- the public surface ---------------------------------------------------

  /** fight.c: do_kill. One swing now, and the violence pulse takes it from there. */
  function attack() {
    return attackSlot(facingTarget());
  }

  /**
   * do_kill on a mobile named rather than looked at. Out of reach, the fight
   * is on and it comes to you, as aggr_update's does (see there).
   */
  function attackSlot(slot) {
    if (state.position === POS.DEAD) return { ok: false, text: 'You are dead.' };
    if (state.position < POS.RESTING) return { ok: false, text: "You can't do that right now." };
    if (!slot || slot.dead) return { ok: false, text: 'They aren\'t here.' };
    const mob = wake(slot);
    if (dist2(slot.pos, feet()) > MELEE * MELEE && state.fighting !== mob) {
      ctx.setFighting(state, mob);
      if (!mob.fighting) ctx.setFighting(mob, state);
      return { ok: true, text: `You attack ${mob.name}.` };
    }
    // fight.c do_kill refuses anyone at all while you are fighting, not just
    // the one you are fighting: a click on the troll in the crosshair must not
    // open a second fight beside the marsh wolf you are already in.
    if (state.fighting && (!isNpc(state.fighting) || !state.fighting.slot.dead)) return { ok: false, text: 'You do the best you can!' };
    state.position = POS.STANDING;
    ctx.round = { player: CLICK_WINDUP, npc: MOB_BEAT };
    try { multiHit(state, mob, undefined, ctx); } finally { ctx.round = null; ctx.now = undefined; }
    return { ok: true, text: `You attack ${mob.name}.` };
  }

  /**
   * do_kill on a KILLER or THIEF, and do_murder, once is_safe has let it
   * through: WAIT_STATE, check_killer, and one round now. Out of reach the
   * fight is on and the violence pulse swings once you are close -- a player
   * is not walked to anyone, so close it yourself.
   */
  function attackPlayer(victim) {
    const vpc = pcOf(victim);
    if (!vpc || victim === state) return { ok: false, text: "They aren't here." };
    if (state.position === POS.DEAD) return { ok: false, text: 'You are dead.' };
    state.wait = Math.max(state.wait, PULSE_VIOLENCE);
    ctx.checkKiller(state, victim);
    if (dist2(pcFeet(vpc), feet()) > MELEE * MELEE) {
      ctx.setFighting(state, victim);
      if (!victim.fighting) ctx.setFighting(victim, state);
      return { ok: true, text: `You attack ${victim.name}.` };
    }
    state.position = POS.STANDING;
    ctx.round = { player: CLICK_WINDUP, npc: MOB_BEAT };
    try { multiHit(state, victim, undefined, ctx); } finally { ctx.round = null; ctx.now = undefined; }
    return { ok: true, text: '' };
  }

  /**
   * act_obj.c: get_obj -- from the floor, or from `container` -- including the
   * carry limits from str_app and dex, and money going straight into the purse.
   */
  function take(obj, container) {
    if (container && container.itemType === ITEM.CORPSE_PC && rules.mayLoot && !rules.mayLoot(container)) {
      return { ok: false, text: "You can't do that." };
    }
    if (!canWear(obj, W.TAKE)) return { ok: false, text: "You can't take that." };
    if (obj.itemType !== ITEM.MONEY) {
      if (state.inventory.length + objNumber(obj) > canCarryN(state)) {
        return { ok: false, text: `${capitalise(obj.keywords.split(' ')[0])}: you can't carry that many items.` };
      }
      if (carriedWeight(state) + objWeight(obj) > canCarryW(state)) {
        return { ok: false, text: `${capitalise(obj.keywords.split(' ')[0])}: you can't carry that much weight.` };
      }
    }
    const from = container ? ` from ${container.name}` : '';
    if (container) container.contains.splice(container.contains.indexOf(obj), 1);
    else {
      objFromRoom(obj);
      // A corpse picked up whole leaves nothing lying where it fell.
      if (obj.slot) removeBody(obj.slot);
    }
    if (obj.itemType === ITEM.MONEY) {
      state.gold += obj.values[0];
      emit({ kind: 'gold', amount: obj.values[0], text: `You get ${obj.name}${from}.` });
      return { ok: true, text: `You get ${obj.name}${from}.` };
    }
    state.inventory.push(obj);
    emit({ kind: 'pickup', text: `You get ${obj.name}${from}.`, item: obj.name, obj });
    return { ok: true, text: `You get ${obj.name}${from}.` };
  }

  /**
   * What lies within reach, nearest first -- the mud's `ch->in_room->contents`
   * where a room is thirteen metres across and you are standing in one corner
   * of it. Scenery (a fountain, a desk) is further across than a coin, so
   * reach is measured to its edge rather than its middle.
   */
  function here(reach = 4) {
    const feet = { x: position.x, y: position.y - 1.72, z: position.z };
    return ground
      .map((obj) => ({ obj, d: Math.hypot(obj.at.x - feet.x, obj.at.z - feet.z) - (obj.radius || 0) }))
      .filter((e) => e.d <= reach && Math.abs(e.obj.at.y - feet.y) < 2.5)
      .sort((a, b) => a.d - b.d)
      .map((e) => e.obj);
  }

  // The keeper's slot rides along so the body can say it too (motion.speak).
  function say(text, speaker, slot) {
    emit({ kind: 'say', speaker, slot, said: text, text: `${capitalise(speaker)} tells you '${text}'` });
  }

  /** act_obj.c: find_keeper -- shop hours included, since the sky already has a clock. */
  function keeperNear() {
    for (const slot of mobsNear(position, 6)) {
      if (!slot.record.shop || slot.dead) continue;
      return slot;
    }
    return null;
  }

  function shopHere() {
    const slot = keeperNear();
    if (!slot) return null;
    const mob = wake(slot);
    const shop = slot.record.shop;
    const open = state.hour >= shop.openHour && state.hour <= shop.closeHour;
    return {
      keeper: slot.proto.vnum,
      slot,
      name: slot.proto.short,
      open,
      hours: [shop.openHour, shop.closeHour],
      stock: mob.inventory
        .map((obj) => ({ obj, cost: getCost(shop, obj, true) }))
        .filter((entry) => entry.cost > 0),
      sellsBack: shop.buyType.filter((t) => t > 0),
      // do_sell's price for each thing you carry: nothing for what the keeper already stocks.
      offers: state.inventory.map((obj) => ({
        obj, cost: mob.inventory.some((o) => o.vnum === obj.vnum) ? 0 : getCost(shop, obj, false),
      })),
    };
  }

  function findKeeper(keeperVnum) {
    for (const slot of mobsNear(position, 6)) {
      if (slot.proto.vnum === keeperVnum && slot.record.shop) return slot;
    }
    return null;
  }

  /** act_obj.c: do_buy. */
  function buy(keeperVnum, objVnum) {
    const slot = findKeeper(keeperVnum);
    if (!slot) return { ok: false, text: "You can't do that here." };
    const shop = slot.record.shop;
    const keeper = wake(slot);
    if (state.hour < shop.openHour) { say('Sorry, come back later.', keeper.name, slot); return { ok: false, text: 'closed' }; }
    if (state.hour > shop.closeHour) { say('Sorry, come back tomorrow.', keeper.name, slot); return { ok: false, text: 'closed' }; }

    const obj = keeper.inventory.find((o) => o.vnum === objVnum);
    const cost = getCost(shop, obj, true);
    if (!obj || cost <= 0) { say("I don't sell that -- try 'list'.", keeper.name, slot); return { ok: false, text: 'not sold' }; }
    if (state.gold < cost) { say(`You can't afford to buy ${obj.name}.`, keeper.name, slot); return { ok: false, text: 'too dear' }; }
    if (obj.level > state.level) { say(`You can't use ${obj.name} yet.`, keeper.name, slot); return { ok: false, text: 'too high' }; }
    if (state.inventory.length + 1 > canCarryN(state)) return { ok: false, text: "You can't carry that many items." };
    if (carriedWeight(state) + objWeight(obj) > canCarryW(state)) return { ok: false, text: "You can't carry that much weight." };

    state.gold -= cost;
    keeper.gold += cost;
    // ITEM_INVENTORY is the shopkeeper's bottomless crate: the stock object
    // stays on the shelf and you walk off with a copy.
    const bought = (obj.extraFlags & X.INVENTORY)
      ? createObject(obj.proto, obj.level)
      : keeper.inventory.splice(keeper.inventory.indexOf(obj), 1)[0];
    state.inventory.push(bought);
    emit({ kind: 'buy', text: `You buy ${bought.name} for ${cost} gold.`, cost, item: bought.name });
    return { ok: true, text: `You buy ${bought.name}.`, item: bought, cost };
  }

  /** act_obj.c: do_sell. A keeper pays nothing for what it already has. */
  function sell(keeperVnum, obj) {
    const slot = findKeeper(keeperVnum);
    if (!slot) return { ok: false, text: "You can't do that here." };
    const shop = slot.record.shop;
    const keeper = wake(slot);
    if (state.inventory.indexOf(obj) < 0) { say("You don't have that item.", keeper.name, slot); return { ok: false, text: 'not carried' }; }
    if (obj.extraFlags & X.NODROP) return { ok: false, text: "You can't let go of it." };

    let cost = getCost(shop, obj, false);
    if (keeper.inventory.some((o) => o.vnum === obj.vnum)) cost = 0;
    if (cost <= 0) { emit({ kind: 'say', speaker: keeper.name, text: `${capitalise(keeper.name)} looks uninterested in ${obj.name}.` }); return { ok: false, text: 'uninterested' }; }

    state.gold += cost;
    keeper.gold = Math.max(0, keeper.gold - cost);
    state.inventory.splice(state.inventory.indexOf(obj), 1);
    if (obj.itemType !== ITEM.TRASH) keeper.inventory.push(obj);
    emit({ kind: 'sell', text: `You sell ${obj.name} for ${cost} gold piece${cost === 1 ? '' : 's'}.`, cost, item: obj.name });
    return { ok: true, text: `You sell ${obj.name}.`, cost };
  }

  /** act_info.c: do_practice. Only in front of a mobile the world flagged ACT_PRACTICE. */
  function practice(key) {
    if (state.level < 3) return { ok: false, text: 'You must be third level to practice.  Go train instead!' };
    const trainer = mobsNear(position, 6).find((slot) => (slot.proto.act & ACT_PRACTICE));
    if (!trainer) return { ok: false, text: "You can't do that here." };
    if (state.practice <= 0) return { ok: false, text: 'You have no practice sessions left.' };
    const skill = ALL_SKILLS.find((s) => s.key === key);
    if (!skill || state.level < skill.level[state.class]) return { ok: false, text: "You can't practice that." };

    const adept = CLASS_TABLE[state.class].skillAdept;
    if (state.learned[key] >= adept) return { ok: false, text: `You are already an adept of ${skill.name}.` };
    state.practice -= 1;
    state.learned[key] += INT_APP[currInt(state)];
    if (state.learned[key] >= adept) {
      state.learned[key] = adept;
      emit({ kind: 'practice', text: `You are now an adept of ${skill.name}.`, skill: skill.name });
      return { ok: true, text: `You are now an adept of ${skill.name}.` };
    }
    emit({ kind: 'practice', text: `You practice ${skill.name}.`, skill: skill.name });
    return { ok: true, text: `You practice ${skill.name}.` };
  }

  /** Which skills this class may practise at all, and where they stand. */
  function skills() {
    return ALL_SKILLS
      .filter((s) => s.level[state.class] <= LEVEL_HERO)
      .map((s) => ({
        key: s.key, name: s.name, learned: state.learned[s.key],
        adept: CLASS_TABLE[state.class].skillAdept,
        available: state.level >= s.level[state.class],
        level: s.level[state.class],
        spell: !!s.spell,
      }));
  }

  // -- the frame ------------------------------------------------------------
  function update(dt, playerPosition, cameraDirection) {
    if (playerPosition) { position.x = playerPosition.x; position.y = playerPosition.y; position.z = playerPosition.z; }
    if (cameraDirection) {
      const d = Math.hypot(cameraDirection.x, cameraDirection.z) || 1;
      facing.x = cameraDirection.x / d;
      facing.z = cameraDirection.z / d;
    }
    if (current.invulnerable > 0) current.invulnerable -= dt;
    ctx.clock += dt;
    const room = playerFrame();
    worldFrame(dt, room);
  }

  /**
   * The server's frame: each player's half, bound in turn, then the world's
   * once. Positions are set beforehand from what each client reported.
   */
  function tick(dt) {
    for (const pc of players.slice()) {
      withPlayer(pc, () => {
        if (current.invulnerable > 0) current.invulnerable -= dt;
        playerFrame();
      });
    }
    ctx.clock += dt;
    worldFrame(dt, null);
  }

  /** The bound player's half of a frame: where you are, and what that ends. */
  function playerFrame() {
    // null: the level's open ground reaches no room, and the last one stands.
    const at = counter.at(feet(), state.roomVnum);
    const before = state.roomVnum;
    if (at !== null) state.roomVnum = at;
    // move_char's half that is not the walking: "$n leaves north." and the followers.
    if (multi && rules.playerMoved && before !== undefined && before !== state.roomVnum) rules.playerMoved(before, state.roomVnum);
    if (!puppet) {
      loseTouch();
      // Walking is the body's, not a typed command, so what a command would end
      // ends when you walk: resting and sleeping (you get up) and hiding.
      if (state.position === POS.RESTING || state.position === POS.SLEEPING) {
        if (!current.restAt) current.restAt = { x: position.x, z: position.z };
        else if (Math.hypot(position.x - current.restAt.x, position.z - current.restAt.z) > 0.6) {
          state.position = POS.STANDING;
          current.restAt = null;
          emit({ kind: 'position', text: 'You stand up.', position: 'standing' });
        }
      } else current.restAt = null;
      if (rules.moveUpdate) rules.moveUpdate();
    }

    // You learn a gate is held by walking up to it and finding someone in it.
    // Nothing announces the list; it fills in as you cross the city.
    // Seen from the gate's own room or the warden's, which is where the guard
    // is standing -- and once per warden, however many exits it holds.
    // On a server the board is each client's own: it walks the same gates.
    for (const gate of multi ? [] : gates) {
      if (gate.seen || gate.open) continue;
      // Not by distance: eighteen metres from the temple's stair reaches into
      // the Cleric's sanctum next door, which then announced the executioner.
      if (state.roomVnum !== gate.vnum && state.roomVnum !== gate.wardenRoom) continue;
      const held = gates.filter((g) => !g.open && g.warden === gate.warden);
      // The level of the one actually standing there -- db.c fuzzes it at
      // reset -- and not the prototype's, which is what the board used to
      // show beside a plate that said something else.
      const warden = mobs.find((slot) => slot.record === gate.warden && !slot.dead);
      const level = warden ? wake(warden).level : gate.wardenLevel;
      for (const g of held) { g.seen = true; g.wardenLevel = level; }
      emit({ kind: 'gate-seen', gate, gates: held, text: `${capital(gate.wardenName)} holds ${waysPhrase(held, wayFrom(state.roomVnum))}.` });
    }

    // db.c rolls a mobile the moment it is reset into the world; here it waits
    // until you could actually see it, so an unvisited quarter of the city
    // costs nothing.
    for (const slot of mobsNear(position, 48)) if (!slot.instance) wake(slot);
    // The counted room's own entry (weatherUpdate reads `.outdoor` off it); none
    // when the room kept is in a zone that is not drawn.
    return built.rooms.get(state.roomVnum) || null;
  }

  /** The world's half: bodies, spells in flight, the pulses, the sky. */
  function worldFrame(dt, room) {
    moveMobs(dt);
    magic.update(dt);
    // The page's copy of a server's game moves bodies; the rules are the server's.
    if (puppet) return;

    pulseAccum += dt * PULSE_PER_SECOND;
    let guard = 0;
    while (pulseAccum >= 1 && guard++ < 32) { pulseAccum -= 1; pulse(); }

    // The weather runs on its own clock, not the point-pulse, because resting
    // runs the point-pulse four times as fast and a nap should not summon rain.
    weatherAccum += dt;
    let weatherGuard = 0;
    while (weatherAccum >= WEATHER_SECONDS && weatherGuard++ < 8) {
      weatherAccum -= WEATHER_SECONDS;
      weatherUpdate(room);
    }
  }

  // -- zones ----------------------------------------------------------------
  /**
   * Hooks run after a zone is entered (rules/world.js: the hinges told what
   * the exits say, and objects left in rooms nobody had built given a place).
   */
  const zoneHooks = [];

  /** A spot on open floor near `vnum`'s middle, `index` of `of` round a ring. */
  function ringSpot(vnum, index, of) {
    const info = built.rooms.get(vnum);
    const angle = (index / Math.max(1, of)) * Math.PI * 2;
    let at = { x: info.center.x + Math.cos(angle) * 2.6, y: info.center.y, z: info.center.z + Math.sin(angle) * 2.6 };
    if (ways.sample && ways.nearestOpen) {
      const level = ways.levelOf ? ways.levelOf(at.y) : 0;
      if (!ways.sample(at.x, at.z, level)) {
        const open = ways.nearestOpen(level, at.x, at.z, 4);
        if (open) at = { x: (open[0] + 0.5) * ways.NAV_RES, y: at.y, z: (open[1] + 0.5) * ways.NAV_RES };
      }
    }
    return at;
  }

  /** Out of the drawn world: a room, and no position. */
  function disembody(slot) {
    slot.here = false;
    slot.figure = null;
    unbucket(slot);
    slot.pos = { x: FAR, y: 0, z: FAR };
    slot.anchor = { ...slot.pos };
  }

  /** Into it, standing at `at`. */
  function embody(slot, at) {
    slot.here = true;
    slot.pos = { ...at };
    slot.anchor = { ...at };
    rebucket(slot);
  }

  /**
   * Leave the zone being drawn: every fight in it ends (fight.c's
   * violence_update stops a fight whenever the two are no longer in one
   * room), a walk half done is finished -- the mud's move is instant -- and
   * everyone in it is put back to a room and no position.
   */
  function leaveZone() {
    if (state.fighting) ctx.stopFighting(state);
    for (const slot of mobs) {
      if (!slot.here) continue;
      if (slot.instance && slot.instance.fighting) ctx.stopFighting(slot.instance);
      if (slot.travel) { slot.roomVnum = slot.travel.to; slot.travel = null; }
      slot.task = null;
      slot.notice = null;
      slot.order = null;
      slot.home = null;
      disembody(slot);
    }
    figureSlot.clear();
    for (const pc of players) pc.focusSlot = null;
  }

  /**
   * Draw another zone: its layout, its build and (with a viewer) its bodies.
   * actors.js builds one figure per M line whose room it built, walking
   * built.rooms and then room.mobs; the same walk pairs them with the slots.
   * Whatever the mud did while the zone was not drawn is honoured: a body
   * whose mobile wandered is stood in the room it wandered to, a dead one
   * lies where it fell or is not there at all.
   */
  function enterZone(next) {
    leaveZone();
    layout = next.layout;
    built = next.built;
    actors = next.actors || null;
    ways = next.nav || (actors && actors.nav) || createNav({ layout, built, world });
    counter = createRoomCounter({ world, rooms: built.rooms, links: layout.links || [], zoneOf });

    const placed = [];
    for (const [vnum] of built.rooms) {
      const room = world.rooms.get(vnum);
      if (!room) continue;
      room.mobs.forEach((record, index) => {
        placed.push({ slot: slotOfRecord.get(record), vnum, index, of: room.mobs.length });
      });
    }
    const figures = actors && actors.figures ? actors.figures : null;
    if (figures && figures.length !== placed.length) {
      throw new Error(`game.js: ${figures.length} figures for ${placed.length} placed mobiles`
        + ' -- actors.js changed the order it places them in and the pairing is no longer safe');
    }
    placed.forEach((entry, i) => {
      const { slot } = entry;
      const figure = figures ? figures[i] : null;
      const info = built.rooms.get(entry.vnum);
      // Headless, stand them in a ring the way actors.js does -- never on the
      // centre, and never on each other, or `attack` cannot tell them apart.
      const angle = (entry.index / entry.of) * Math.PI * 2;
      const home = figure
        ? { x: figure.at ? figure.at.x : figure.home.x, y: figure.home.y, z: figure.at ? figure.at.z : figure.home.z }
        : { x: info.center.x + Math.cos(angle) * 2.6, y: info.center.y, z: info.center.z + Math.sin(angle) * 2.6 };
      slot.origin = { ...home };
      slot.originRoom = entry.vnum;
      slot.figure = figure;
      if (figure) figureSlot.set(figure, slot);
      // A room this zone did not build is somewhere a body cannot stand; the
      // mobile is put back on its post rather than drawn in mid-air.
      const there = built.rooms.get(slot.roomVnum);
      if (!there || there.unbuilt) slot.roomVnum = entry.vnum;
      if (slot.dead) {
        const corpse = slot.corpse && slot.corpse.inRoom !== null && slot.corpse.at ? slot.corpse : null;
        embody(slot, corpse ? corpse.at : home);
        if (figure && actors.respawn) actors.respawn(figure, slot.pos);
        if (corpse) order(slot, { kind: 'dead', delay: 0 });
        else if (figure) {
          // Already gone before anyone came back: no fade, no body.
          order(slot, { kind: 'gone' });
          if (figure.m) figure.m.gone = { t: 3.5 };
          figure.object.visible = false;
        }
        return;
      }
      if (slot.roomVnum === entry.vnum) { embody(slot, home); return; }
      const others = placed.filter((p) => p.slot.roomVnum === slot.roomVnum);
      const at = ringSpot(slot.roomVnum, others.indexOf(entry) + 1, others.length + 1);
      embody(slot, at);
      if (figure && actors.respawn) actors.respawn(figure, at);
    });
    for (const fn of zoneHooks) fn();
  }

  const game = {
    get state() { return state; },
    world,
    events,
    gates,
    /** waysPhrase's `lead` for room `vnum`: how a gate is reached from there. */
    wayFrom,
    roads,
    mobs,
    ground,
    MERC,

    /** Take everything queued since the last call. */
    drain() { return events.splice(0, events.length); },

    update,
    attack,
    attackSlot,
    attackPlayer,
    /** db.c's create_mobile for a slot, if it has not been yet: the mobile itself. */
    wakeSlot: (slot) => wake(slot),
    get nav() { return ways; },
    /** Draw another zone (see enterZone); the rules keep running everywhere. */
    enterZone,
    /** Which zone a room is in, or null when the world is one zone. */
    zoneOf: (vnum) => (zoneOf ? zoneOf(vnum) : null),
    /**
     * The room counted at `feet` for a body last counted in `last` (null:
     * keep it). For tools -- roomcount.mjs --page-check, mp-room.mjs; the
     * frame asks the counter itself.
     */
    roomAt: (feet, last) => counter.at(feet, last),

    // -- magic --------------------------------------------------------------
    magic,
    /** spec_lookup's table (see mobileUpdate): name -> fn(slot, mob). */
    specFuns: SPEC_FUNS,
    /**
     * do_cast. An offensive spell goes at whoever you are fighting, else at
     * whoever you are looking at in the room; anything else at yourself unless
     * `target` (a mobile instance) says otherwise.
     */
    cast(name, { target = null, obj = null } = {}) {
      if (state.position === POS.DEAD) return { ok: false, text: 'You are dead.' };
      const sp = SPELL[name];
      if (!target && sp && sp.target === TAR.OFFENSIVE && !state.fighting) {
        const slot = facingTarget(ROOM_REACH, 0.82);
        if (slot) target = wake(slot);
      }
      const result = magic.cast(name, { target, obj });
      if (!result.ok && !result.lost) emit({ kind: 'note', text: result.text });
      return result;
    },
    /** The spells you could cast now, with their mana. */
    spells: () => magic.known(),
    /** quaff, recite, zap, brandish or eat, by what the object is. */
    useItem: (obj, options) => {
      const result = magic.useItem(obj, options);
      if (!result.ok) emit({ kind: 'note', text: result.text });
      return result;
    },
    /**
     * The mobile in your crosshair and reach, as `attack` and an offensive
     * `cast` pick it (facingTarget) -- for a page whose rules are a server's.
     */
    facingSlot: (reach = REACH, cone = 0.45) => facingTarget(reach, cone),
    /** An event the server decided, into this game's stream (src/link.js). */
    inject(event) { emit(event); },
    /** Start over as another class -- the title screen's choice, before you play. */
    chooseClass(index, { level = 1 } = {}) {
      if (state.fighting) return false;
      const fresh = createCharacter(index, { level, rng });
      for (const key of Object.keys(fresh)) state[key] = fresh[key];
      magic.wait = 0;
      return true;
    },

    /**
     * Hear every event as it is emitted, alongside the `drain()` queue. Combat
     * events carry `delay` (seconds after now that the blow should be seen to
     * land), `from`/`to` (a mobile's slot, or null for the player), `metal`
     * and `attack`. Returns an unsubscribe.
     */
    listen(fn) {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },

    /**
     * update.c's spec_fun call in mobile_update: fn(slot, mob) -> true if it
     * acted, which ends that mobile's turn (no wandering, no scavenging).
     */
    set mobileSpec(fn) { mobileSpec = fn; },
    get mobileSpec() { return mobileSpec; },

    /** Where your eye is, as the last update was told: for what can be seen from it. */
    get eye() { return position; },
    /** Which way you face on the ground, unit length. */
    get facing() { return facing; },

    /** Seconds until the next violence pulse resolves a round. */
    violenceIn() {
      return ((pulseViolence - 1) + (1 - pulseAccum)) / PULSE_PER_SECOND;
    },

    /** Would this mobile swing at you on the next round, as things stand? */
    willSwing(slot) {
      const mob = slot.instance;
      return !!(mob && !slot.dead && mob.fighting === state && isAwake(mob)
        && current.invulnerable <= 0 && dist2(slot.pos, feet()) <= MELEE * MELEE);
    },

    /** Would you swing on the next round? */
    playerWillSwing() {
      const mob = state.fighting;
      if (mob && !isNpc(mob)) return !!(isAwake(state) && pcOf(mob) && dist2(pcFeet(pcOf(mob)), feet()) <= MELEE * MELEE);
      return !!(mob && isAwake(state) && !mob.slot.dead && dist2(mob.slot.pos, feet()) <= MELEE * MELEE);
    },

    recall: () => recall(false),
    breakOff: () => breakOff(false),

    /** Whoever you are fighting, or looking at, with the mud's condition line. */
    target() {
      loseTouch();
      const mob = currentTarget();
      if (!mob) return null;
      if (!isNpc(mob)) {
        // Another player, on a server: what the plate can say of them.
        return {
          name: mob.name, level: mob.level, hit: mob.hit, maxHit: mob.maxHit,
          percent: mob.maxHit > 0 ? Math.max(0, idiv(100 * mob.hit, mob.maxHit)) : 0,
          condition: condition(mob), fighting: state.fighting === mob, aggressive: false,
          warden: null, holds: '', shop: false, focused: false, slot: null, player: true,
        };
      }
      return {
        name: mob.name, level: mob.level, hit: mob.hit, maxHit: mob.maxHit,
        percent: mob.maxHit > 0 ? Math.max(0, idiv(100 * mob.hit, mob.maxHit)) : 0,
        condition: condition(mob),
        fighting: state.fighting === mob,
        aggressive: !!(mob.act & ACT_AGGRESSIVE),
        warden: gates.find((g) => !g.open && g.warden === mob.slot.record) || null,
        holds: waysPhrase(gates.filter((g) => !g.open && g.warden === mob.slot.record), wayFrom(state.roomVnum)),
        shop: !!mob.slot.record.shop,
        focused: mob.slot === current.focusSlot,
        slot: mob.slot,
      };
    },

    /**
     * The mobile the viewer is looking at (its figure), or null. Set every
     * frame from the same pick that shows the examine prompt, so the click,
     * the prompt and the plate agree on who is meant.
     */
    focus(figure) {
      current.focusSlot = figure ? (figureSlot.get(figure) || null) : null;
    },

    /** The one the viewer is looking at, as `target()` describes it -- even mid-fight with someone else. */
    focused() {
      const slot = current.focusSlot;
      if (!slot || slot.dead || !slot.instance) return null;
      const mob = slot.instance;
      return {
        name: mob.name, level: mob.level, aggressive: !!(mob.act & ACT_AGGRESSIVE),
        shop: !!slot.record.shop, fighting: state.fighting === mob,
        warden: gates.find((g) => !g.open && g.warden === slot.record) || null, slot,
        holds: waysPhrase(gates.filter((g) => !g.open && g.warden === slot.record), wayFrom(state.roomVnum)),
      };
    },

    here,
    take,
    /**
     * `get all <container>` for a corpse or an open container; `get <obj>` for
     * anything else. Refuses a closed lid the way do_get does.
     */
    takeAll(obj) {
      const holds = obj.itemType === ITEM.CONTAINER || obj.itemType === ITEM.CORPSE_NPC || obj.itemType === ITEM.CORPSE_PC;
      if (!holds) return [take(obj, null)];
      if (obj.values[1] & 4) return [{ ok: false, text: `The ${obj.keywords.split(' ')[0]} is closed.` }];
      if (obj.itemType === ITEM.CORPSE_PC && rules.mayLoot && !rules.mayLoot(obj)) return [{ ok: false, text: "You can't do that." }];
      return obj.contains.slice().map((inner) => take(inner, obj));
    },

    wear(obj) {
      if (state.inventory.indexOf(obj) < 0) return { ok: false, text: 'You do not have that item.' };
      const result = wearObj(state, obj, true);
      if (result && result.ok) emit({ kind: 'wear', text: result.text, item: obj.name });
      return result || { ok: false, text: "You can't wear that." };
    },
    wield(obj) { return game.wear(obj); },

    remove(iWear) {
      const obj = state.equipment[iWear];
      if (!obj) return { ok: false, text: 'You do not have that item.' };
      if (obj.extraFlags & X.NOREMOVE) return { ok: false, text: `You can't remove ${obj.name}.` };
      unequipChar(state, obj);
      state.inventory.push(obj);
      emit({ kind: 'remove', text: `You stop using ${obj.name}.`, item: obj.name });
      return { ok: true, text: `You stop using ${obj.name}.` };
    },

    drop(obj) {
      const index = state.inventory.indexOf(obj);
      if (index < 0) return { ok: false, text: 'You do not have that item.' };
      if (obj.extraFlags & X.NODROP) return { ok: false, text: "You can't let go of it." };
      state.inventory.splice(index, 1);
      objToRoom(obj, state.roomVnum, dropSpot());
      emit({ kind: 'drop', text: `You drop ${obj.name}.`, item: obj.name, obj });
      return { ok: true, text: `You drop ${obj.name}.` };
    },

    shopHere, buy, sell, practice, skills,

    /** Where the sky is: shops keep the mud's opening hours. */
    setTimeOfDay(name) {
      state.hour = { dawn: 6, noon: 12, dusk: 19, night: 1 }[name] ?? 12;
    },

    /**
     * The mud's own sky, live -- `sky` is one of SKY.*, with the barometer that
     * moved it. main.js renders CLOUDLESS as its clear preset and the other
     * three as overcast; a rain pass would want RAINING and LIGHTNING apart.
     */
    weather() { return weather; },

    /** main.js hands this in so death and recall can actually move the camera. */
    set onTeleport(fn) { onTeleport = fn; },
    get onTeleport() { return onTeleport; },

    /** Seconds of grace after respawning, so nothing kills you as you land. */
    grace(seconds = 3) { current.invulnerable = seconds; },

    // -- char_list --------------------------------------------------------
    /** Every player in the world; `current` is the one whose turn it is. */
    players,
    get current() { return current; },
    pcOf,
    /** Run fn as `pc`'s turn: their commands, their screen. */
    withPlayer,
    /** The server's frame (see tick); the page calls update. */
    tick,
    tell,
    roomcast,
    feetOf,
    /**
     * char_to_room for a player logging in: a record for where its body is.
     * `id` keys the events meant for it (`event.pc`).
     */
    addPlayer(ch, { id, at = null, facing: face = null } = {}) {
      const pc = makePc(ch, id);
      if (at) Object.assign(pc.position, at);
      if (face) Object.assign(pc.facing, face);
      players.push(pc);
      return pc;
    },
    /** extract_char for a player leaving: every fight with them ends. */
    removePlayer(pc) {
      const ch = pc.ch;
      if (rules.playerLeaving) withPlayer(pc, () => rules.playerLeaving(ch));
      for (const slot of mobs) if (slot.instance && slot.instance.fighting === ch) ctx.stopFighting(slot.instance);
      for (const other of players) if (other.ch.fighting === ch) ctx.stopFighting(other.ch);
      if (ch.fighting) ctx.stopFighting(ch);
      const i = players.indexOf(pc);
      if (i >= 0) players.splice(i, 1);
      pcOfCh.delete(ch);
      if (current === pc) bind(null);
    },
    /**
     * A player the page draws but does not run: someone else on the server.
     * Their record gives the bodies a target to chase (`feetOf`); nothing in
     * the rules ever binds it.
     */
    addRemote(ch, id) { return makePc(ch, id); },
    /**
     * char_from_room and char_to_room for a player the rules move (goto,
     * transfer, at): stood in the room's middle, where everyone arrives. The
     * 'teleport' event tells their own screen to follow. False when the room
     * has nowhere to stand.
     */
    placePlayer(pc, vnum, { quiet = false } = {}) {
      const info = built.rooms.get(vnum);
      if (!info || info.unbuilt) return false;
      pc.position.x = info.center.x; pc.position.y = info.center.y + 1.72; pc.position.z = info.center.z;
      pc.ch.roomVnum = vnum;
      pc.restAt = null;
      if (!quiet) emit({ kind: 'teleport', x: info.center.x, y: info.center.y, z: info.center.z, vnum, pc: pc.id, placed: true });
      return true;
    },
    removeRemote(pc) { pcOfCh.delete(pc.ch); },

  };

  /**
   * act()'s TO_ROOM, as far as one player can overhear it: said in the room you
   * are in, or near enough to you across a street to have been heard.
   */
  function toRoom(actor, text, extra = {}) {
    const vnum = actor.roomVnum !== undefined ? actor.roomVnum : actor.inRoom;
    const at = actor.pos || actor.at || actor;
    const hears = (pc) => pc.ch.roomVnum === vnum || (at && at.x !== undefined
      && Math.hypot(at.x - pc.position.x, at.z - pc.position.z) < 14 && Math.abs(at.y - (pc.position.y - 1.72)) < 4);
    if (multi) {
      // Everyone in the room, or near enough across a street (server/ asks hears()).
      if (!players.some(hears)) return false;
      emit({ kind: 'room', ...extra, text, room: vnum, near: at && at.x !== undefined ? { x: at.x, y: at.y, z: at.z } : null, except: [] });
      return true;
    }
    if (!hears(current)) return false;
    emit({ kind: 'room', ...extra, text });
    return true;
  }

  Object.defineProperty(game, 'specFuns', { get: () => SPEC_FUNS, enumerable: true });

  enterZone({ layout, built, actors, nav: ways });
  // db.c creates every mobile at boot. The drawn zone's wait until they are
  // first seen (update); the rest are made now, behind the loading screen --
  // made on the first mobile pulse instead, the 1,440 of them were a 21 ms
  // hitch in the first second of play -- so their spec_funs run unwatched.
  for (const slot of mobs) if (!slot.here) wake(slot, wanderRng);

  const kernel = {
    world, rng, wanderRng,
    // Whoever's turn it is (bind): read when used, or follow it with onBind.
    get state() { return state; },
    get position() { return position; },
    get facing() { return facing; },
    get playerFeet() { return current.feet; },
    get pc() { return current; },
    onBind(fn) { rebinders.push(fn); },
    players, pcOf, withPlayer, tell, roomcast, multi, feetOf,
    // What a descriptor list would give the rules: save, quit, the password.
    server,
    // The zone being drawn, read when used: entering another one swaps them.
    get layout() { return layout; },
    get built() { return built; },
    get actors() { return actors; },
    get ways() { return ways; },
    zoneHooks, sameZone, embody, disembody, ringSpot, FAR,
    mobs, ground, gates, protoInfo, emit, ctx, game, SPEC_FUNS, rules,
    wake, order, moveMobile, mobsNear, objToRoom, objFromRoom, dropSpot, removeBody,
    toRoom, recall, breakOff, facingAway, weather: () => weather, dist2, updatePos,
    damage: (ch, victim, dam, dt) => damage(ch, victim, dam, dt, ctx),
    multiHit: (ch, victim, dt) => multiHit(ch, victim, dt, ctx),
    gainCondition, unequipChar, equipChar, wearObj, getCost, canCarryN, canCarryW, carriedWeight,
    grace: (s) => { current.invulnerable = s; },
    invulnerable: () => current.invulnerable,
  };
  installRules(kernel);

  // -- the page's copy of a server's game -----------------------------------
  /**
   * In a page connected to a server the rules are the server's: this game
   * stops running them (`puppet`) and is told instead what the mud decided
   * -- where each mobile is and whom it fights, what lies on the ground, what
   * your character is now -- and keeps the bodies, the walking and the
   * strolling, which are the page's. src/link.js is the one caller.
   */
  const remotes = new Map();
  /** A reference off the wire ({ me }, { m }, { p }) to a character here. */
  function resolveRef(ref) {
    if (!ref) return null;
    if (ref.me) return state;
    if (ref.m !== undefined) { const slot = mobs[ref.m]; return slot && !slot.dead ? wake(slot) : null; }
    if (ref.p !== undefined) return remotes.get(ref.p)?.ch || null;
    return null;
  }

  /** One mobile as the server has it: [room, body, fighting, hp, max hp, level, travelling to, door]. */
  function mirrorMob(index, [room, body, fighting, hp, maxHp, level, travelTo, door]) {
    const slot = mobs[index];
    if (!slot) throw new Error(`game.js: the server names mobile ${index}, and this world has ${mobs.length}`);
    if (!slot.here) { slot.roomVnum = room; slot.dead = body > 0; if (body > 0) slot.instance = null; return; }
    if (body > 0) {
      if (!slot.dead) {
        const mob = slot.instance;
        if (state.fighting && state.fighting === mob) state.fighting = null;
        slot.dead = true;
        slot.instance = null;
        slot.travel = null;
        slot.task = null;
        layOut(slot);
      }
      if (body === 2 && slot.order && slot.order.kind !== 'gone') removeBody(slot);
      return;
    }
    // Back from the dead: an area reset on the server, the body walking in.
    if (slot.dead) kernel.respawn(slot);
    if (travelTo !== null) {
      if (!slot.travel) {
        if (slot.roomVnum !== room) standIn(slot, room);
        moveMobile(slot, door);
      }
    } else if (!slot.travel && slot.roomVnum !== room) {
      // The mud put it somewhere this page did not see it go.
      standIn(slot, room);
    }
    const mob = wake(slot);
    if (hp !== null) { mob.hit = hp; mob.maxHit = maxHp; mob.level = level; }
    const foe = resolveRef(fighting);
    mob.fighting = foe;
    if (foe) mob.position = POS.FIGHTING;
    else if (mob.position === POS.FIGHTING) mob.position = POS.STANDING;
  }
  function standIn(slot, room) {
    if (!built.rooms.has(room) || built.rooms.get(room).unbuilt) { slot.roomVnum = room; return; }
    const at = ringSpot(room, 1 + (mobs.indexOf(slot) % 5), 6);
    slot.roomVnum = room;
    embody(slot, at);
    if (slot.figure && actors && actors.respawn) actors.respawn(slot.figure, at);
    order(slot, { kind: 'stroll', room });
  }

  /**
   * What lies in the drawn zone, by the server's ids. Scenery the reset table
   * put here (a fountain, a desk) stays the page's own object -- actors.js
   * drew it and E finds it by room, vnum and reset index -- and takes the
   * server's id and contents; anything else is the server's word entirely.
   */
  const mirrored = new Map();
  function mirrorObject(view, obj = null) {
    if (!obj) {
      const proto = world.objProtos.get(view.vnum);
      obj = proto ? createObject(proto, view.level) : makeObject({});
    }
    obj.mirrorId = view.id;
    for (const key of ['vnum', 'name', 'keywords', 'description', 'itemType', 'wearFlags', 'extraFlags', 'weight', 'cost', 'level', 'timer']) {
      if (view[key] !== undefined) obj[key] = view[key];
    }
    obj.values = view.values.slice();
    obj.contains = (view.contains || []).map((inner) => mirrorObject(inner, mirrored.get(inner.id) || null));
    for (const inner of obj.contains) mirrored.set(inner.mirrorId, inner);
    if (view.owner) obj.owner = view.owner;
    if (view.look) obj.look = view.look;
    return obj;
  }
  function mirrorGround(list) {
    const keep = new Set();
    for (const view of list) {
      if (!built.rooms.has(view.inRoom)) continue;
      let obj = mirrored.get(view.id);
      if (!obj && view.resetIndex !== undefined) {
        obj = ground.find((o) => o.mirrorId === undefined && o.inRoom === view.inRoom && o.vnum === view.vnum && o.resetIndex === view.resetIndex) || null;
      }
      const fresh = !obj || !ground.includes(obj);
      obj = mirrorObject(view, obj);
      mirrored.set(view.id, obj);
      const scenery = view.resetIndex !== undefined && !(view.wearFlags & ITEM_TAKE);
      if (!scenery || !obj.at) {
        // The server's floor is the layout grid's; this page's may stand on a mound.
        const info = built.rooms.get(view.inRoom);
        const lift = info.center.y - info.cell.level * 7.6;
        obj.at = { x: view.at.x, y: view.at.y + lift, z: view.at.z };
      }
      obj.inRoom = view.inRoom;
      if (view.resetIndex !== undefined) obj.resetIndex = view.resetIndex;
      if (view.radius) obj.radius = view.radius;
      if (view.corpseOf !== undefined) { obj.slot = mobs[view.corpseOf]; obj.slot.corpse = obj; }
      if (fresh) ground.push(obj);
      keep.add(obj);
    }
    for (let i = ground.length - 1; i >= 0; i--) {
      const obj = ground[i];
      if (keep.has(obj) || !built.rooms.has(obj.inRoom)) continue;
      ground.splice(i, 1);
      obj.inRoom = null;
      if (obj.mirrorId !== undefined) mirrored.delete(obj.mirrorId);
    }
  }

  /** Your character as save.js writes it, with what a server adds (see server/mud.mjs sendSelf). */
  const carried = new Map();
  function carriedObject(view) {
    const obj = mirrorObject(view, carried.get(view.id) || null);
    obj.wearLoc = view.wearLoc;
    obj.affects = obj.proto ? obj.proto.affects || [] : [];
    obj.inRoom = null; obj.at = null;
    carried.set(view.id, obj);
    return obj;
  }
  function mirrorSelf(core, kit) {
    for (const [key, value] of Object.entries(core)) {
      if (key === 'room' || key === 'version' || key === 'fighting' || key === 'condition') continue;
      state[key] = value;
    }
    state.condition = core.condition.slice();
    state.displayName = core.name;
    state.fighting = resolveRef(core.fighting);
    if (kit) {
      state.learned = { ...state.learned, ...kit.learned };
      state.affected = kit.affected.map((af) => ({ ...af }));
      state.inventory = kit.inventory.map(carriedObject);
      state.equipment = kit.equipment.map((v) => (v ? carriedObject(v) : null));
    }
  }

  game.mirror = {
    mob: mirrorMob, ground: mirrorGround, self: mirrorSelf, resolve: resolveRef, remotes,
    /** The weather the server's barometer is at. */
    weather(w) { Object.assign(weather, w); },
    /**
     * Whether each door is shut and locked, [room, direction, those two
     * bits]: the exit takes the server's word and its hinge swings, as the
     * rules swing it here alone. `quiet` for the first word on a zone, which
     * only catches the page up and is no door being opened.
     */
    doors(list, quiet = false) {
      const BITS = EX_CLOSED | EX_LOCKED;
      for (const [vnum, dir, bits] of list) {
        const was = world.rooms.get(vnum)?.exits[dir]?.locks;
        if (was === undefined || (was & BITS) === bits) continue;
        const sound = quiet ? null : (was & EX_CLOSED) !== (bits & EX_CLOSED) ? (bits & EX_CLOSED ? 'close' : 'open')
          : (bits & EX_LOCKED ? 'lock' : 'unlock');
        kernel.setExitFlags(vnum, dir, bits, BITS & ~bits, sound);
      }
    },
    /** Stop running the rules here: the server runs them. */
    become() { puppet = true; },
    get puppet() { return puppet; },
  };

  state.hour = 12;
  game.grace(2);
  // A server starts with nobody in it: players come in through addPlayer.
  if (multi) game.removePlayer(pc0);
  return game;
}
