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
  ROOM_NO_MOB, ROOM_PRIVATE, ROOM_SOLITARY,
} from './are.js';
import { createNav } from './nav.js';

// --------------------------------------------------------------- merc.h ----

const PULSE_PER_SECOND = 4;
const PULSE_VIOLENCE = 3 * PULSE_PER_SECOND;
const PULSE_TICK = 30 * PULSE_PER_SECOND;
const PULSE_MOBILE = 4 * PULSE_PER_SECOND;

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
];

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
  };
  for (const skill of SKILLS) ch.learned[skill.key] = 0;

  switch (CLASS_TABLE[classIndex].attrPrime) {
    case APPLY.STR: ch.permStr = 16; break;
    case APPLY.INT: ch.permInt = 16; break;
    case APPLY.WIS: ch.permWis = 16; break;
    case APPLY.DEX: ch.permDex = 16; break;
    case APPLY.CON: ch.permCon = 16; break;
    default: break;
  }

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
const objWeight = (obj) => obj.weight;
const carriedWeight = (ch) => ch.inventory.reduce((sum, o) => sum + objWeight(o), 0);

/**
 * act_obj.c: wear_obj, in the same order, so an object that could go in two
 * places lands where the mud would put it. Returns the mud's own reply.
 */
function wearObj(ch, obj, replace = true) {
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

/** fight.c: dam_message, resolved for both audiences that exist here. */
function damMessage(ch, victim, dam, dt) {
  const [vs, vp] = damVerb(dam);
  const punct = dam <= 24 ? '.' : '!';
  if (dt === TYPE_HIT) {
    return {
      toChar: `You ${vs} ${victim.name}${punct}`,
      toVict: `${capitalise(ch.name)} ${vp} you${punct}`,
    };
  }
  const attack = ATTACK_TABLE[dt - TYPE_HIT] || ATTACK_TABLE[0];
  return {
    toChar: `Your ${attack} ${vp} ${victim.name}${punct}`,
    toVict: `${capitalise(ch.name)}'s ${attack} ${vp} you${punct}`,
  };
}

/**
 * Who struck whom, with what, for whoever draws it. `from`/`to` are the
 * mobile's slot in the real-time game, or null for the player; `metal` is
 * whether the blow lands on worn armour (a spark and a clank) or on cloth and
 * skin (a thud); `attack` is attack_table's word for the weapon.
 */
function blow(ch, victim) {
  const wield = ch.equipment[WEAR.WIELD];
  const attack = wield && wield.itemType === ITEM.WEAPON ? (ATTACK_TABLE[wield.values[3]] || 'hit') : 'hit';
  const metal = victim.equipment.some((obj) => obj && obj.itemType === ITEM.ARMOR
    && [WEAR.BODY, WEAR.HEAD, WEAR.SHIELD, WEAR.ARMS, WEAR.LEGS].includes(obj.wearLoc));
  return { from: ch.slot || null, to: victim.slot || null, attack, armed: !!wield, metal };
}

/**
 * fight.c: one_hit. `ctx` carries the rng and the event sink so that the two
 * halves -- the arithmetic and the telling -- stay separable for the harness.
 */
function oneHit(ch, victim, dt, ctx) {
  if (victim.position === POS.DEAD) return;
  // When this blow is *shown* -- the rules resolve a whole round on one pulse,
  // and a round of four blows all landing on the same frame reads as one.
  if (ctx.round) ctx.now = (isNpc(ch) ? ctx.round.npc : ctx.round.player) + (ctx.beat || 0) * SWING_GAP;

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
  const victimAc = Math.max(-15, idiv(getAc(victim), 10));

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
  ctx.emit(isNpc(victim)
    ? { kind: 'parry', text: `${capitalise(victim.name)} parries your attack.`, ...blow(ch, victim) }
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
  ctx.emit(isNpc(victim)
    ? { kind: 'dodge', text: `${capitalise(victim.name)} dodges your attack.`, ...blow(ch, victim) }
    : { kind: 'dodge', text: `You dodge ${ch.name}'s attack.`, defended: true, ...blow(ch, victim) });
  return true;
}

/**
 * fight.c: damage. The parts that only exist for a multiplayer mud -- KILLER
 * flags, charm threads, group assists, link-dead recall -- are the parts left
 * out, along with sanctuary and protection (no spells here) and `trip`, which
 * puts the victim on the floor for two rounds: bearable in a text window,
 * unbearable when the floor is where your camera is.
 */
function damage(ch, victim, dam, dt, ctx) {
  if (victim.position === POS.DEAD) return;
  if (dam > 1000) dam = 1000;

  if (victim !== ch) {
    if (victim.position > POS.STUNNED) {
      if (!victim.fighting) ctx.setFighting(victim, ch);
      victim.position = POS.FIGHTING;
      if (!ch.fighting) ctx.setFighting(ch, victim);
    }
    if (dam < 0) dam = 0;

    if (dt >= TYPE_HIT) {
      if (isNpc(ch) && ctx.rng.percent() < idiv(ch.level, 2)) ctx.disarm(ch, victim);
      if (checkParry(ch, victim, ctx)) return;
      if (checkDodge(ch, victim, ctx)) return;
    }

    const message = damMessage(ch, victim, dam, dt);
    ctx.emit({
      kind: dam === 0 ? 'miss' : 'hit',
      text: isNpc(ch) ? message.toVict : message.toChar,
      dam,
      byPlayer: !isNpc(ch),
      target: victim.name,
      ...blow(ch, victim),
      hp: Math.max(0, victim.hit - dam),
      maxHp: victim.maxHit,
    });
  }

  victim.hit -= dam;
  updatePos(victim);

  switch (victim.position) {
    case POS.MORTAL:
      ctx.emit({ kind: 'state', text: isNpc(victim)
        ? `${capitalise(victim.name)} is mortally wounded, and will die soon, if not aided.`
        : 'You are mortally wounded, and will die soon, if not aided.' });
      break;
    case POS.INCAP:
      ctx.emit({ kind: 'state', text: isNpc(victim)
        ? `${capitalise(victim.name)} is incapacitated and will slowly die, if not aided.`
        : 'You are incapacitated and will slowly die, if not aided.' });
      break;
    case POS.STUNNED:
      ctx.emit({ kind: 'state', text: isNpc(victim)
        ? `${capitalise(victim.name)} is stunned, but will probably recover.`
        : 'You are stunned, but will probably recover.' });
      break;
    case POS.DEAD:
      break;
    default:
      if (!isNpc(victim)) {
        if (dam > idiv(victim.maxHit, 4)) ctx.emit({ kind: 'state', text: 'That really did HURT!' });
        if (victim.hit < idiv(victim.maxHit, 4)) ctx.emit({ kind: 'state', text: 'You sure are BLEEDING!' });
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
  if (ch.fighting !== victim) return;

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

/** A gate is only *held* if something that could stop a novice stands at it. */
const WARDEN_MIN_LEVEL = 5;

const dist2 = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

/**
 * @param {object} deps  world/layout/built from the boot chain. `actors` is
 *   optional: without it the game runs headless, which is how the harness and
 *   any future test drives it.
 */
export function createGame({ world, layout, built, actors = null, seed, classIndex = 3, nav = null } = {}) {
  const rng = new Rng(seed);
  const events = [];
  const listeners = [];
  const emit = (event) => {
    // Stamped with the beat of the blow being resolved, if one is.
    if (event.delay === undefined && ctx.now !== undefined) event.delay = ctx.now;
    if (ctx.round && event.beat === undefined) event.beat = ctx.beat || 0;
    events.push(event);
    if (events.length > 400) events.shift();
    for (const fn of listeners) fn(event);
  };
  // The walkable grid and the routes between rooms. actors.js builds it over
  // the real geometry; headless, it is the layout alone.
  const ways = nav || (actors && actors.nav) || createNav({ layout, built, world });

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
  const roomCentres = [];
  for (const [vnum, info] of built.rooms) {
    roomCentres.push({ vnum, x: info.center.x, y: info.center.y, z: info.center.z, outdoor: !!info.outdoor });
  }
  const roomBucket = new Map();
  const bucketKey = (x, z) => `${Math.floor(x / 26)},${Math.floor(z / 26)}`;
  for (const room of roomCentres) {
    const key = bucketKey(room.x, room.z);
    if (!roomBucket.has(key)) roomBucket.set(key, []);
    roomBucket.get(key).push(room);
  }

  function nearestRoom(p) {
    let best = null;
    let bestD = Infinity;
    const cx = Math.floor(p.x / 26);
    const cz = Math.floor(p.z / 26);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = roomBucket.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const room of bucket) {
          const d = dist2(room, p);
          if (d < bestD) { bestD = d; best = room; }
        }
      }
    }
    if (best) return best;
    for (const room of roomCentres) {
      const d = dist2(room, p);
      if (d < bestD) { bestD = d; best = room; }
    }
    return best;
  }

  // -- mobiles --------------------------------------------------------------
  // actors.js builds one figure per placed mobile, walking built.rooms and then
  // room.mobs; the same walk in the same order pairs them back up. If actors
  // ever hands the record over directly, use that instead.
  const records = [];
  for (const [vnum] of built.rooms) {
    const room = world.rooms.get(vnum);
    if (!room) continue;
    room.mobs.forEach((record, index) => {
      records.push({ record, roomVnum: vnum, index, of: room.mobs.length });
    });
  }
  if (actors && actors.figures && actors.figures.length !== records.length) {
    throw new Error(`game.js: ${actors.figures.length} figures for ${records.length} placed mobiles`
      + ' -- actors.js changed the order it places them in and the pairing is no longer safe');
  }

  const mobs = [];
  records.forEach((entry, index) => {
    const figure = actors && actors.figures ? actors.figures[index] : null;
    const info = built.rooms.get(entry.roomVnum);
    // Headless, stand them in a ring the way actors.js does -- never on the
    // centre, and never on each other, or `attack` cannot tell them apart.
    const angle = (entry.index / entry.of) * Math.PI * 2;
    const home = figure
      ? { x: figure.at ? figure.at.x : figure.home.x, y: figure.home.y, z: figure.at ? figure.at.z : figure.home.z }
      : {
        x: info.center.x + Math.cos(angle) * 2.6,
        y: info.center.y,
        z: info.center.z + Math.sin(angle) * 2.6,
      };
    mobs.push({
      record: entry.record,
      proto: entry.record.proto,
      roomVnum: entry.roomVnum,
      figure,
      anchor: { ...home },
      pos: { ...home },
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
  });

  // Mobiles walk now, so the buckets are kept up as they go.
  const mobBucket = new Map();
  function rebucket(slot) {
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
  for (const slot of mobs) rebucket(slot);
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
  function wake(slot) {
    if (slot.instance || slot.dead) return slot.instance;
    const info = protoInfo.get(slot.proto.vnum);
    const mob = createMobile(slot.proto, info.loadLevel, rng);
    mob.slot = slot;
    // Its gear is exactly what the reset table hung on it -- E into slots,
    // G into its hands -- so the corpse holds what the world said it holds.
    const objectLevel = clamp(mob.level - 2, 0, LEVEL_HERO);
    for (const worn of slot.record.equipment) {
      const obj = createObject(worn.proto, rng.fuzzy(objectLevel));
      if (worn.wearLoc >= 0 && worn.wearLoc < MAX_WEAR && !mob.equipment[worn.wearLoc]) {
        equipChar(mob, obj, worn.wearLoc);
      } else {
        mob.inventory.push(obj);
      }
    }
    for (const held of slot.record.carried) {
      const obj = slot.record.shop
        ? createObject(held.proto, shopLevel(held.proto.itemType))
        : createObject(held.proto, rng.fuzzy(objectLevel));
      if (slot.record.shop) obj.extraFlags |= X.INVENTORY;
      mob.inventory.push(obj);
    }
    slot.instance = mob;
    return mob;
  }

  // -- the player -----------------------------------------------------------
  const state = createCharacter(classIndex, { rng });
  state.name = 'you';
  const position = { x: 0, y: 0, z: 0 };
  const facing = { x: 0, y: 0, z: -1 };

  Object.defineProperty(state, 'expToLevel', { get: () => expToLevel(state), enumerable: true });
  Object.defineProperty(state, 'ac', { get: () => getAc(state), enumerable: true });
  // The mud calls these hit/max_hit and so does everything above; these are the
  // names the rest of the world expects to read them under.
  Object.defineProperty(state, 'hp', { get: () => state.hit, set: (v) => { state.hit = v; } });
  Object.defineProperty(state, 'maxHp', { get: () => state.maxHit });
  Object.defineProperty(state, 'carryWeight', { get: () => carriedWeight(state), enumerable: true });
  Object.defineProperty(state, 'carryMax', { get: () => canCarryW(state), enumerable: true });

  // -- ground ---------------------------------------------------------------
  /** Corpses and anything dropped. Reset objects stay scenery: actors.js owns those meshes. */
  const ground = [];

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
        if (!exit || exit.offMap) continue;
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
      to: link.exit.to,
      outdoor: !!(info && info.outdoor),
      warden: warden.record,
      wardenName: warden.record.proto.short,
      wardenLevel: warden.record.proto.level,
      open: false,
    });
  }
  gates.sort((a, b) => a.wardenLevel - b.wardenLevel || a.vnum - b.vnum);
  /** The roads out of the city: the gates in the open air. Those are the ending. */
  const roads = gates.filter((g) => g.outdoor);

  // -- the combat context ---------------------------------------------------
  let deathHandler = null;
  const ctx = {
    rng,
    emit,
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
        ground.push(makePile(obj, position));
        emit({ kind: 'state', text: `${capitalise(ch.name)} disarms you!` });
      }
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
        breakOff(true);
      }
    },
    kill(ch, victim) { deathHandler(ch, victim); },
  };

  function makePile(obj, at) {
    return {
      kind: 'item', name: obj.name, contents: [obj],
      x: at.x, y: at.y, z: at.z, timer: 0, roomVnum: state.roomVnum,
    };
  }

  // -- death ----------------------------------------------------------------
  deathHandler = function onDeath(killer, victim) {
    if (isNpc(victim)) return mobDied(killer, victim);
    return playerDied(killer);
  };

  /** fight.c: make_corpse, plus create_money for the gold. */
  function makeCorpse(mob) {
    const contents = [];
    for (const obj of mob.equipment) if (obj) contents.push(obj);
    for (const obj of mob.inventory) {
      if (obj.extraFlags & X.INVENTORY) continue;   // shop stock is not real
      contents.push(obj);
    }
    for (const obj of contents) obj.wearLoc = WEAR.NONE;
    if (mob.gold > 0) {
      contents.unshift({
        proto: null, vnum: 3, name: `${mob.gold} gold coins`, keywords: 'gold coins',
        itemType: ITEM.MONEY, extraFlags: 0, wearFlags: W.TAKE,
        values: [mob.gold, 0, 0, 0], weight: 0, cost: 0, level: 0,
        wearLoc: WEAR.NONE, affects: [], timer: 0,
      });
      mob.gold = 0;
    }
    return {
      kind: 'corpse', name: `the corpse of ${mob.name}`, contents,
      x: mob.slot.pos.x, y: mob.slot.pos.y, z: mob.slot.pos.z,
      timer: rng.range(2, 4), roomVnum: mob.slot.roomVnum, slot: mob.slot,
    };
  }

  function mobDied(killer, mob) {
    const slot = mob.slot;
    ctx.stopFighting(mob);
    if (state.fighting === mob) ctx.stopFighting(state);

    const cry = DEATH_CRIES[rng.bits(3) % DEATH_CRIES.length]
      .replace(/\$n/g, mob.name).replace(/\$s/g, mob.sex === 2 ? 'her' : 'his');
    emit({ kind: 'death', text: capitalise(cry), name: mob.name, x: slot.pos.x, y: slot.pos.y, z: slot.pos.z });

    const corpse = makeCorpse(mob);
    ground.push(corpse);
    slot.dead = true;
    slot.corpse = corpse;
    layOut(slot);

    // fight.c: group_gain -- only a player killing an NPC scores.
    if (killer === state) {
      const info = protoInfo.get(mob.proto.vnum);
      const xp = xpComputeWith(state, mob, killTable, info.killed, rng);
      info.killed += 1;
      killTable[clamp(mob.level, 0, MAX_LEVEL - 1)].killed += 1;
      emit({ kind: 'xp', amount: xp, text: `You receive ${xp} experience points.` });
      gainExp(state, xp, rng, (gains) => {
        emit({
          kind: 'level', level: state.level, gains,
          title: titleFor(state),
          text: `You raise a level!!  Your gain is: ${gains.hp} hp, ${gains.mana} m,`
            + ` ${gains.move} mv, ${gains.prac} prac.`,
        });
      });
    }

    let firstRoad = false;
    for (const gate of gates) {
      if (gate.open || gate.warden !== slot.record) continue;
      gate.open = true;
      if (gate.outdoor && !roads.some((g) => g !== gate && g.open)) firstRoad = true;
      emit({
        kind: 'gate', vnum: gate.vnum, to: gate.to, name: gate.name,
        text: `The way out of ${gate.name} is no longer held.`,
      });
    }
    // One road out is the ending. Every road out is not: the gear this city
    // sells cannot beat the guildmasters or the executioner, so the rest of
    // that list is the horizon rather than the goal.
    if (firstRoad) emit({ kind: 'ending', text: 'The road out of Midgaard is open.' });
  }

  /** Merc's death penalty: half the way back to the level you were. */
  function playerDied(killer) {
    emit({ kind: 'death', text: 'You have been KILLED!!', player: true, by: killer ? killer.name : 'something' });
    if (state.exp > 1000 * state.level) {
      const lose = idiv(1000 * state.level - state.exp, 2);
      gainExp(state, lose, rng);
      emit({ kind: 'xp', amount: lose, text: `You lose ${-lose} experience points.` });
    }
    for (const slot of mobs) {
      if (slot.instance && slot.instance.fighting === state) ctx.stopFighting(slot.instance);
    }
    // fight.c: raw_kill for a PC -- affects stripped, armour back to 100,
    // resting, and one point of everything.
    state.fighting = null;
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
    const temple = built.rooms.get(ROOM_VNUM_TEMPLE) || built.rooms.values().next().value;
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
    if (onTeleport) onTeleport(temple.center.x, temple.center.y, temple.center.z);
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
  function breakOff(forced) {
    if (!state.fighting) return;
    const name = state.fighting.name;
    ctx.stopFighting(state);
    gainExp(state, -25, rng);
    invulnerable = Math.max(invulnerable, 1.5);
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
    if (!lines.length || !room || !room.outdoor || !isAwake(state)) return;
    for (const text of lines) emit({ kind: 'weather', text });
  }

  // -- the clock ------------------------------------------------------------
  let pulseAccum = 0;
  let pulseViolence = PULSE_VIOLENCE;
  let pulsePoint = PULSE_TICK;
  let pulseMobile = PULSE_MOBILE;
  let invulnerable = 0;

  /** fight.c: violence_update, with metres where the mud asks about rooms. */
  function violenceUpdate() {
    ctx.round = { player: 0, npc: MOB_BEAT };
    try { violenceRound(); } finally { ctx.round = null; ctx.now = undefined; }
  }

  function violenceRound() {
    if (state.fighting) {
      const mob = state.fighting;
      // Below zero hitpoints you are stunned, and the mud stops your swings
      // dead: IS_AWAKE is false and violence_update drops you out of the fight.
      if (!isAwake(state)) ctx.stopFighting(state, false);
      else if (mob.position === POS.DEAD || dist2(mob.slot.pos, position) > BREAK * BREAK) breakOff(true);
      else if (dist2(mob.slot.pos, position) <= MELEE * MELEE) multiHit(state, mob, undefined, ctx);
    }
    for (const slot of mobs) {
      const mob = slot.instance;
      if (!mob || slot.dead || !mob.fighting) continue;
      if (!isAwake(mob)) { ctx.stopFighting(mob, false); continue; }
      if (dist2(slot.pos, position) > BREAK * BREAK) { ctx.stopFighting(mob); continue; }
      if (dist2(slot.pos, position) > MELEE * MELEE) continue;
      if (invulnerable > 0) continue;
      multiHit(mob, state, undefined, ctx);
    }
  }

  /** update.c: aggr_update. ACT_WIMPY aggressives only jump you in your sleep. */
  function aggrUpdate() {
    if (invulnerable > 0 || state.position === POS.DEAD) return;
    for (const slot of mobsNear(position, AGGRO)) {
      const mob = slot.instance;
      if (!mob || mob.fighting || !isAwake(mob)) continue;
      if (!(mob.act & ACT_AGGRESSIVE)) continue;
      if ((mob.act & ACT_WIMPY) && isAwake(state)) continue;
      // DIVERGES: the mud's multi_hit here is from anywhere in the room, and
      // AGGRO stands in for the room at nine metres -- so the first round
      // used to land from across the street. Out of reach, the mobile only
      // picks the fight (set_fighting, both ways, as damage() would) and
      // comes at you; the violence pulse swings once it is there.
      if (dist2(slot.pos, position) > MELEE * MELEE) {
        ctx.setFighting(mob, state);
        if (!state.fighting) ctx.setFighting(state, mob);
        continue;
      }
      ctx.round = { player: 0, npc: AMBUSH_WINDUP };
      try { multiHit(mob, state, undefined, ctx); } finally { ctx.round = null; ctx.now = undefined; }
    }
  }

  /** update.c: hit_gain / mana_gain / move_gain, at one point-pulse. */
  function charUpdate() {
    if (state.position === POS.DEAD) return;
    let hit = Math.min(5, state.level);
    let mana = Math.min(5, idiv(state.level, 2));
    let move = Math.max(15, 2 * state.level);
    if (state.position === POS.SLEEPING) {
      hit += currCon(state); mana += currInt(state) * 2; move += currDex(state);
    } else if (state.position === POS.RESTING) {
      hit += idiv(currCon(state), 2); mana += currInt(state); move += idiv(currDex(state), 2);
    }
    state.hit = Math.min(state.maxHit, state.hit + hit);
    state.mana = Math.min(state.maxMana, state.mana + mana);
    state.move = Math.min(state.maxMove, state.move + move);

    for (const slot of mobs) {
      const mob = slot.instance;
      if (!mob || slot.dead) continue;
      if (!mob.fighting) mob.hit = Math.min(mob.maxHit, mob.hit + idiv(mob.level * 3, 2));
    }

    for (let i = ground.length - 1; i >= 0; i--) {
      const pile = ground[i];
      if (pile.kind !== 'corpse') continue;
      pile.timer -= 1;
      if (pile.timer > 0) continue;
      emit({ kind: 'note', text: `${capitalise(pile.name)} crumbles into dust.` });
      if (pile.slot) removeBody(pile.slot);
      ground.splice(i, 1);
    }
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
    if (!built.rooms.has(to) || built.rooms.get(to).unbuilt) return false;
    if (!ways.doorOpen(slot.roomVnum, door, to, actors ? actors.doors : null)) return false;
    const route = ways.route(slot.roomVnum, door, to, slot.pos, wanderRand);
    if (!route) return false;
    slot.travel = { from: slot.roomVnum, to, door, route, run };
    order(slot, { kind: 'travel', route, run, wait });
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
  function mobileUpdate() {
    const counts = new Map();
    for (const slot of mobs) if (!slot.dead) counts.set(slot.roomVnum, (counts.get(slot.roomVnum) || 0) + 1);
    if (state.roomVnum !== undefined) counts.set(state.roomVnum, (counts.get(state.roomVnum) || 0) + 1);

    for (const slot of mobs) {
      if (slot.dead || slot.travel) continue;
      const mob = slot.instance;
      const act = slot.proto.act;
      // "Examine call for special procedure": a spec_fun that acted ends this
      // mobile's turn, as in update.c. `game.mobileSpec` is where one plugs in.
      if (mobileSpec && mob && mobileSpec(slot, mob)) continue;
      // "That's all for sleeping / busy monster": fighting is busy.
      if (mob && mob.position !== POS.STANDING) continue;
      const room = world.rooms.get(slot.roomVnum);
      if (!room) continue;

      // Scavenge: the dearest thing lying loose in the room. Only what the
      // player has dropped is loose here; the reset objects are scenery.
      if ((act & ACT_SCAVENGER) && wanderRng.bits(2) === 0) {
        let best = null;
        let max = 1;
        for (const pile of ground) {
          if (pile.kind !== 'item' || pile.roomVnum !== slot.roomVnum) continue;
          const obj = pile.contents[0];
          if (obj && canWear(obj, W.TAKE) && obj.cost > max) { best = pile; max = obj.cost; }
        }
        if (best) {
          const obj = best.contents.shift();
          ground.splice(ground.indexOf(best), 1);
          wake(slot).inventory.push(obj);
          if (slot.roomVnum === state.roomVnum) emit({ kind: 'note', text: `${capitalise(slot.proto.short)} gets ${obj.name}.` });
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
          && state.roomVnum !== to.vnum) {
          moveMobile(slot, door, true);
        }
      }
    }
  }

  /**
   * comm.c/update.c: update_handler, one pulse.
   */
  function pulse() {
    if (--pulseMobile <= 0) { pulseMobile = PULSE_MOBILE; mobileUpdate(); }
    if (--pulseViolence <= 0) { pulseViolence = PULSE_VIOLENCE; violenceUpdate(); }
    if (--pulsePoint <= 0) {
      // DIVERGES: the mud's point-pulse is 30 seconds because you would go and
      // do something else. Resting here means standing still watching a wall,
      // so resting runs the same clock four times as fast. The gains are the
      // mud's, only the waiting is compressed.
      const resting = state.position === POS.RESTING || state.position === POS.SLEEPING;
      pulsePoint = resting ? idiv(PULSE_TICK, 4) : PULSE_TICK;
      charUpdate();
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

  /** The player as a target: feet on the ground, not the eye. */
  const playerFeet = { x: 0, y: 0, z: 0 };

  /**
   * What every mobile's body should be doing this frame. The body itself --
   * the path, the pace, stepping round people -- is actors.js's (motion.js);
   * headless, `stepHeadless` stands in for it in straight lines.
   */
  function moveMobs(dt) {
    playerFeet.x = position.x; playerFeet.z = position.z; playerFeet.y = position.y - 1.72;
    for (const slot of mobs) {
      if (slot.dead) continue;
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
        const target = mob.fighting === state ? playerFeet : (mob.fighting.slot ? mob.fighting.slot.pos : playerFeet);
        // ACT_SENTINEL never leaves its room in the mud; here it never leaves
        // the spot it was reset on, and you have to come to it.
        if (mob.act & ACT_SENTINEL) order(slot, { kind: 'face', target });
        else if (dist2(slot.pos, slot.anchor) > LEASH * LEASH) {
          order(slot, { kind: 'go', to: slot.anchor });
          if (!figure) step(slot, slot.anchor, MOB_SPEED, 0.4, dt);
        } else {
          // Close enough to cross blades with another mobile; with you, a
          // little further, or a figure 1.5 m from your eye fills the frame.
          order(slot, { kind: 'chase', target, stop: target === playerFeet ? 2.0 : 1.5 });
          if (!figure) step(slot, target, MOB_SPEED, MELEE * 0.68, dt);
        }
      } else if (slot.record.shop) {
        order(slot, { kind: 'hold', at: slot.home || (slot.home = { ...slot.pos }) });
      } else {
        order(slot, { kind: 'stroll', room: slot.roomVnum });
      }
      settleRoom(slot);
    }
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
  function facingTarget() {
    let best = null;
    let bestScore = -Infinity;
    for (const slot of mobsNear(position, REACH)) {
      if (!slot.instance) continue;
      const dx = slot.pos.x - position.x;
      const dz = slot.pos.z - position.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) continue;
      const dot = (dx / d) * facing.x + (dz / d) * facing.z;
      if (dot < 0.45) continue;
      const score = dot * 2 - d * 0.12;
      if (score > bestScore) { bestScore = score; best = slot; }
    }
    return best;
  }

  /** Whoever you are fighting, or whoever you are looking at. */
  function currentTarget() {
    if (state.fighting && !state.fighting.slot.dead) return state.fighting;
    const slot = facingTarget();
    return slot ? slot.instance : null;
  }

  // -- the public surface ---------------------------------------------------

  /** fight.c: do_kill. One swing now, and the violence pulse takes it from there. */
  function attack() {
    if (state.position === POS.DEAD) return { ok: false, text: 'You are dead.' };
    if (state.position < POS.RESTING) return { ok: false, text: "You can't do that right now." };
    const slot = facingTarget();
    if (!slot) return { ok: false, text: 'They aren\'t here.' };
    const mob = wake(slot);
    if (state.fighting === mob) return { ok: false, text: 'You do the best you can!' };
    state.position = POS.STANDING;
    ctx.round = { player: CLICK_WINDUP, npc: MOB_BEAT };
    try { multiHit(state, mob, undefined, ctx); } finally { ctx.round = null; ctx.now = undefined; }
    return { ok: true, text: `You attack ${mob.name}.` };
  }

  /** act_obj.c: get_obj, including the carry limits from str_app and dex. */
  function take(obj, container) {
    if (!canWear(obj, W.TAKE)) return { ok: false, text: "You can't take that." };
    if (obj.itemType === ITEM.MONEY) {
      state.gold += obj.values[0];
      if (container) container.contents.splice(container.contents.indexOf(obj), 1);
      emit({ kind: 'gold', amount: obj.values[0], text: `You get ${obj.values[0]} gold coins.` });
      return { ok: true, text: `You get ${obj.values[0]} gold coins.` };
    }
    if (state.inventory.length + 1 > canCarryN(state)) {
      return { ok: false, text: `${capitalise(obj.name)}: you can't carry that many items.` };
    }
    if (carriedWeight(state) + objWeight(obj) > canCarryW(state)) {
      return { ok: false, text: `${capitalise(obj.name)}: you can't carry that much weight.` };
    }
    if (container) container.contents.splice(container.contents.indexOf(obj), 1);
    state.inventory.push(obj);
    emit({ kind: 'pickup', text: `You get ${obj.name}${container ? ` from ${container.name}` : ''}.`, item: obj.name });
    return { ok: true, text: `You get ${obj.name}.` };
  }

  /** What is on the ground within arm's reach, as `look` would list it. */
  function here() {
    return ground.filter((pile) => dist2(pile, position) <= 16);
  }

  function say(text, speaker) {
    emit({ kind: 'say', speaker, text: `${capitalise(speaker)} tells you '${text}'` });
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
      name: slot.proto.short,
      open,
      hours: [shop.openHour, shop.closeHour],
      stock: mob.inventory
        .map((obj) => ({ obj, cost: getCost(shop, obj, true) }))
        .filter((entry) => entry.cost > 0),
      sellsBack: shop.buyType.filter((t) => t > 0),
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
    if (state.hour < shop.openHour) { say('Sorry, come back later.', keeper.name); return { ok: false, text: 'closed' }; }
    if (state.hour > shop.closeHour) { say('Sorry, come back tomorrow.', keeper.name); return { ok: false, text: 'closed' }; }

    const obj = keeper.inventory.find((o) => o.vnum === objVnum);
    const cost = getCost(shop, obj, true);
    if (!obj || cost <= 0) { say("I don't sell that -- try 'list'.", keeper.name); return { ok: false, text: 'not sold' }; }
    if (state.gold < cost) { say(`You can't afford to buy ${obj.name}.`, keeper.name); return { ok: false, text: 'too dear' }; }
    if (obj.level > state.level) { say(`You can't use ${obj.name} yet.`, keeper.name); return { ok: false, text: 'too high' }; }
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
    if (state.inventory.indexOf(obj) < 0) { say("You don't have that item.", keeper.name); return { ok: false, text: 'not carried' }; }
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
    const skill = SKILLS.find((s) => s.key === key);
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
    return SKILLS
      .filter((s) => s.level[state.class] <= LEVEL_HERO)
      .map((s) => ({
        key: s.key, name: s.name, learned: state.learned[s.key],
        adept: CLASS_TABLE[state.class].skillAdept,
        available: state.level >= s.level[state.class],
        level: s.level[state.class],
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
    if (invulnerable > 0) invulnerable -= dt;

    const room = nearestRoom(position);
    if (room) state.roomVnum = room.vnum;

    // You learn a gate is held by walking up to it and finding someone in it.
    // Nothing announces the list; it fills in as you cross the city.
    for (const gate of gates) {
      if (gate.seen) continue;
      const info = built.rooms.get(gate.vnum);
      if (info && dist2(info.center, position) < 18 * 18) {
        gate.seen = true;
        emit({ kind: 'gate-seen', gate, text: `${gate.wardenName} holds the way out of ${gate.name}.` });
      }
    }

    // db.c rolls a mobile the moment it is reset into the world; here it waits
    // until you could actually see it, so an unvisited quarter of the city
    // costs nothing.
    for (const slot of mobsNear(position, 48)) if (!slot.instance) wake(slot);
    moveMobs(dt);

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

  const game = {
    state,
    events,
    gates,
    roads,
    mobs,
    ground,
    MERC,

    /** Take everything queued since the last call. */
    drain() { return events.splice(0, events.length); },

    update,
    attack,
    nav: ways,

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

    /** Seconds until the next violence pulse resolves a round. */
    violenceIn() {
      return ((pulseViolence - 1) + (1 - pulseAccum)) / PULSE_PER_SECOND;
    },

    /** Would this mobile swing at you on the next round, as things stand? */
    willSwing(slot) {
      const mob = slot.instance;
      return !!(mob && !slot.dead && mob.fighting === state && isAwake(mob)
        && invulnerable <= 0 && dist2(slot.pos, position) <= MELEE * MELEE);
    },

    /** Would you swing on the next round? */
    playerWillSwing() {
      const mob = state.fighting;
      return !!(mob && isAwake(state) && !mob.slot.dead && dist2(mob.slot.pos, position) <= MELEE * MELEE);
    },

    recall: () => recall(false),
    breakOff: () => breakOff(false),

    /** Whoever you are fighting, or looking at, with the mud's condition line. */
    target() {
      const mob = currentTarget();
      if (!mob) return null;
      return {
        name: mob.name, level: mob.level, hit: mob.hit, maxHit: mob.maxHit,
        percent: mob.maxHit > 0 ? Math.max(0, idiv(100 * mob.hit, mob.maxHit)) : 0,
        condition: condition(mob),
        fighting: state.fighting === mob,
        aggressive: !!(mob.act & ACT_AGGRESSIVE),
        warden: gates.find((g) => !g.open && g.warden === mob.slot.record) || null,
        slot: mob.slot,
      };
    },

    here,
    take,
    /** Everything a corpse or a pile holds, in one go -- the mud's `get all corpse`. */
    takeAll(pile) {
      const results = [];
      for (const obj of pile.contents.slice()) results.push(take(obj, pile));
      if (pile.kind === 'item' && !pile.contents.length) ground.splice(ground.indexOf(pile), 1);
      return results;
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
      ground.push(makePile(obj, position));
      emit({ kind: 'drop', text: `You drop ${obj.name}.`, item: obj.name });
      return { ok: true, text: `You drop ${obj.name}.` };
    },

    shopHere, buy, sell, practice, skills,

    /** POS_RESTING and POS_SLEEPING, for the regeneration they buy. */
    rest() {
      if (state.fighting) return { ok: false, text: 'Not while you are fighting!' };
      state.position = state.position === POS.RESTING ? POS.STANDING : POS.RESTING;
      const text = state.position === POS.RESTING ? 'You rest.' : 'You stand up.';
      emit({ kind: 'note', text });
      return { ok: true, text };
    },

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
    grace(seconds = 3) { invulnerable = seconds; },
  };

  state.hour = 12;
  game.grace(2);
  return game;
}
