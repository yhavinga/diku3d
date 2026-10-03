/**
 * Magic: Merc 2.1's spells, the spec_funs that cast them, and the magic items
 * that carry them.
 *
 * Transcribed from `merc21/src/magic.c` (the spell_funs, saves_spell, do_cast,
 * obj_cast_spell, say_spell), `special.c` (spec_cast_*, spec_breath_*,
 * spec_poison), `const.c` (skill_table: levels, targets, minimum position,
 * mana, beats, damage nouns, wear-off lines), `handler.c` (the affect list) and
 * `update.c` (affects ticking, poison, the gains poison quarters) and
 * `act_obj.c` (quaff, recite, zap, brandish, and the pill branch of eat).
 *
 * The arithmetic is the mud's, including the parts that look wrong: affects on
 * a mobile set its flags but never its numbers (handler.c's affect_modify
 * returns early for an NPC), so `armor` on a cityguard does nothing to its
 * armour class; acid breath pits the *dragon's* own armour (it walks
 * `ch->carrying`); energy drain on a victim of level 2 or less deals the
 * caster's hitpoints plus one.
 *
 * DIVERGES, once, in time rather than in number: the mud resolves a spell the
 * instant it is uttered. Here the words take `CAST_WINDUP` seconds to say and
 * a bolt takes its flight to cross the room, and the spell is resolved when it
 * arrives -- the log line, the number and the flinch all land on the frame the
 * fire does. Every roll is still the mud's, made at that moment. If the caster
 * is dead before the words are out, nothing is released; if the target is dead
 * before the bolt arrives, it spends itself on nothing.
 *
 * No three.js in here: `tools/magic-check.mjs` runs all of it under node.
 */

import { ITEM } from './are.js';

// ------------------------------------------------------------- merc.h ----

/** AFF_*: the bits in affected_by. */
export const AFF = {
  BLIND: 1, INVISIBLE: 2, DETECT_EVIL: 4, DETECT_INVIS: 8, DETECT_MAGIC: 16,
  DETECT_HIDDEN: 32, HOLD: 64, SANCTUARY: 128, FAERIE_FIRE: 256, INFRARED: 512,
  CURSE: 1024, FLAMING: 2048, POISON: 4096, PROTECT: 8192, PARALYSIS: 16384,
  SNEAK: 32768, HIDE: 65536, SLEEP: 131072, CHARM: 262144, FLYING: 524288,
  PASS_DOOR: 1048576,
};

/** TAR_*: what a spell may be cast at. */
export const TAR = { IGNORE: 0, OFFENSIVE: 1, DEFENSIVE: 2, SELF: 3, OBJ_INV: 4 };

// game.js imports this file, so its POS table is not safely readable at load
// time here; these are merc.h's own numbers.
const POS = { DEAD: 0, MORTAL: 1, INCAP: 2, STUNNED: 3, SLEEPING: 4, RESTING: 5, FIGHTING: 6, STANDING: 7 };

const APPLY = {
  NONE: 0, STR: 1, DEX: 2, INT: 3, WIS: 4, CON: 5, SEX: 6, MANA: 12, HIT: 13,
  MOVE: 14, AC: 17, HITROLL: 18, DAMROLL: 19,
  SAVING_PARA: 20, SAVING_ROD: 21, SAVING_PETRI: 22, SAVING_BREATH: 23, SAVING_SPELL: 24,
};

const LEVEL_HERO = 36;
const PULSE_PER_SECOND = 4;

// -------------------------------------------------------------- maths ----

const idiv = (a, b) => Math.trunc(a / b);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNpc = (ch) => ch.npc === true;
const isAwake = (ch) => ch.position > POS.SLEEPING;
const isGood = (ch) => ch.alignment >= 350;
const isEvil = (ch) => ch.alignment <= -350;
const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** db.c: dice. */
export function dice(rng, number, size) {
  if (size === 0) return 0;
  if (size === 1) return number;
  let sum = 0;
  for (let i = 0; i < number; i++) sum += rng.range(1, size);
  return sum;
}

/** magic.c: saves_spell. Negative saving throws are better. */
export function savesSpell(rng, level, victim) {
  const save = clamp(50 + (victim.level - level - (victim.savingThrow || 0)) * 5, 5, 95);
  return rng.percent() < save;
}

/** A damage table the way every bolt spell reads it: clamped to its own length. */
function fromTable(rng, table, level) {
  const l = clamp(level, 0, table.length - 1);
  return rng.range(idiv(table[l], 2), table[l] * 2);
}

// ------------------------------------------------------------ affects ----

/** Anything the mud keeps per character that this file needs, made to exist. */
export function ensureMagic(ch) {
  if (!ch.affected) ch.affected = [];
  if (ch.affectedBy === undefined) ch.affectedBy = 0;
  if (ch.savingThrow === undefined) ch.savingThrow = 0;
  return ch;
}

/** handler.c: affect_modify. The flags always; the numbers only for a player. */
function affectModify(ch, paf, add) {
  if (add) ch.affectedBy |= paf.bitvector;
  else ch.affectedBy &= ~paf.bitvector;
  if (isNpc(ch)) return;
  const mod = add ? paf.modifier : -paf.modifier;
  switch (paf.location) {
    case APPLY.STR: ch.modStr += mod; break;
    case APPLY.DEX: ch.modDex += mod; break;
    case APPLY.INT: ch.modInt += mod; break;
    case APPLY.WIS: ch.modWis += mod; break;
    case APPLY.CON: ch.modCon += mod; break;
    case APPLY.SEX: ch.sex += mod; break;
    case APPLY.MANA: ch.maxMana += mod; break;
    case APPLY.HIT: ch.maxHit += mod; break;
    case APPLY.MOVE: ch.maxMove += mod; break;
    case APPLY.AC: ch.armor += mod; break;
    case APPLY.HITROLL: ch.hitroll += mod; break;
    case APPLY.DAMROLL: ch.damroll += mod; break;
    case APPLY.SAVING_PARA: case APPLY.SAVING_ROD: case APPLY.SAVING_PETRI:
    case APPLY.SAVING_BREATH: case APPLY.SAVING_SPELL:
      ch.savingThrow += mod; break;
    default: break;
  }
}

/** handler.c: affect_to_char. New affects go on the front, as the list does in C. */
export function affectToChar(ch, af) {
  ensureMagic(ch);
  const paf = { type: af.type, duration: af.duration, location: af.location || 0, modifier: af.modifier || 0, bitvector: af.bitvector || 0 };
  ch.affected.unshift(paf);
  affectModify(ch, paf, true);
  return paf;
}

/** handler.c: affect_remove. */
export function affectRemove(ch, paf) {
  const i = ch.affected.indexOf(paf);
  if (i < 0) throw new Error(`magic.js: affect_remove of ${paf.type}, which ${ch.name} does not carry`);
  affectModify(ch, paf, false);
  ch.affected.splice(i, 1);
}

/** handler.c: affect_strip. */
export function affectStrip(ch, type) {
  ensureMagic(ch);
  for (const paf of ch.affected.slice()) if (paf.type === type) affectRemove(ch, paf);
}

/** handler.c: is_affected. */
export function isAffected(ch, type) {
  return !!(ch.affected && ch.affected.some((paf) => paf.type === type));
}

/** handler.c: affect_join -- durations and modifiers add up. */
export function affectJoin(ch, af) {
  ensureMagic(ch);
  const old = ch.affected.find((paf) => paf.type === af.type);
  const joined = { ...af };
  if (old) {
    joined.duration += old.duration;
    joined.modifier += old.modifier;
    affectRemove(ch, old);
  }
  return affectToChar(ch, joined);
}

// -------------------------------------------------------- say_spell ----

const SYLLABLES = [
  [' ', ' '], ['ar', 'abra'], ['au', 'kada'], ['bless', 'fido'], ['blind', 'nose'],
  ['bur', 'mosa'], ['cu', 'judi'], ['de', 'oculo'], ['en', 'unso'], ['light', 'dies'],
  ['lo', 'hi'], ['mor', 'zak'], ['move', 'sido'], ['ness', 'lacri'], ['ning', 'illa'],
  ['per', 'duda'], ['ra', 'gru'], ['re', 'candus'], ['son', 'sabru'], ['tect', 'infra'],
  ['tri', 'cula'], ['ven', 'nofo'],
  ['a', 'a'], ['b', 'b'], ['c', 'q'], ['d', 'e'], ['e', 'z'], ['f', 'y'], ['g', 'o'],
  ['h', 'p'], ['i', 'u'], ['j', 'y'], ['k', 't'], ['l', 'r'], ['m', 'w'], ['n', 'i'],
  ['o', 'a'], ['p', 's'], ['q', 'd'], ['r', 'f'], ['s', 'g'], ['t', 'h'], ['u', 'j'],
  ['v', 'z'], ['w', 'x'], ['x', 'n'], ['y', 'l'], ['z', 'k'],
];

/** magic.c: say_spell's cipher -- what a spell sounds like to someone not of your class. */
export function mysticWords(name) {
  let out = '';
  for (let i = 0; i < name.length;) {
    const syl = SYLLABLES.find(([old]) => name.startsWith(old, i));
    if (syl) { out += syl[1]; i += syl[0].length; } else i += 1;
  }
  return out;
}

// -------------------------------------------------------- skill_table ----

/**
 * The spells, in const.c's order and with its numbers: level per class (mage,
 * cleric, thief, warrior; 37 is never), target, minimum position, #OBJECTS
 * slot, minimum mana, beats, damage noun and wear-off line.
 *
 * `family` is not the mud's: it is which kind of light and sound a spell makes,
 * for spellfx.js. `bar` marks the ones worth a key in a fight.
 */
const T = TAR;
const P = POS;
function spell(name, level, target, minPos, slot, minMana, beats, noun, msgOff, family, bar = false) {
  return { name, level, target, minPos, slot, minMana, beats, noun, msgOff, family, bar };
}
export const SPELLS = [
  spell('acid blast', [20, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 70, 20, 12, 'acid blast', '', 'acid', true),
  spell('armor', [5, 1, 37, 37], T.DEFENSIVE, P.STANDING, 1, 5, 12, '', 'You feel less protected.', 'ward', true),
  spell('bless', [37, 5, 37, 37], T.DEFENSIVE, P.STANDING, 3, 5, 12, '', 'You feel less righteous.', 'bless', true),
  spell('blindness', [8, 5, 37, 37], T.OFFENSIVE, P.FIGHTING, 4, 5, 12, '', 'You can see again.', 'blind', true),
  spell('burning hands', [5, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 5, 15, 12, 'burning hands', '', 'flame', true),
  spell('call lightning', [37, 12, 37, 37], T.IGNORE, P.FIGHTING, 6, 15, 12, 'lightning bolt', '', 'storm', true),
  spell('cause critical', [37, 9, 37, 37], T.OFFENSIVE, P.FIGHTING, 63, 20, 12, 'spell', '', 'harm', true),
  spell('cause light', [37, 1, 37, 37], T.OFFENSIVE, P.FIGHTING, 62, 15, 12, 'spell', '', 'harm', true),
  spell('cause serious', [37, 5, 37, 37], T.OFFENSIVE, P.FIGHTING, 64, 17, 12, 'spell', '', 'harm', true),
  spell('change sex', [37, 37, 37, 37], T.DEFENSIVE, P.FIGHTING, 82, 15, 12, '', 'Your body feels familiar again.', 'hex'),
  spell('chill touch', [3, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 8, 15, 12, 'chilling touch', 'You feel less cold.', 'frost', true),
  spell('colour spray', [11, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 10, 15, 12, 'colour spray', '', 'prism', true),
  spell('cure blindness', [37, 4, 37, 37], T.DEFENSIVE, P.FIGHTING, 14, 5, 12, '', '', 'heal'),
  spell('cure critical', [37, 9, 37, 37], T.DEFENSIVE, P.FIGHTING, 15, 20, 12, '', '', 'heal', true),
  spell('cure light', [37, 1, 37, 37], T.DEFENSIVE, P.FIGHTING, 16, 10, 12, '', '', 'heal', true),
  spell('cure poison', [37, 9, 37, 37], T.DEFENSIVE, P.STANDING, 43, 5, 12, '', '', 'heal'),
  spell('cure serious', [37, 5, 37, 37], T.DEFENSIVE, P.FIGHTING, 61, 15, 12, '', '', 'heal', true),
  spell('curse', [12, 12, 37, 37], T.OFFENSIVE, P.STANDING, 17, 20, 12, 'curse', 'The curse wears off.', 'curse', true),
  spell('detect evil', [37, 4, 37, 37], T.SELF, P.STANDING, 18, 5, 12, '', 'The red in your vision disappears.', 'sight'),
  spell('detect hidden', [37, 7, 37, 37], T.SELF, P.STANDING, 44, 5, 12, '', 'You feel less aware of your suroundings.', 'sight'),
  spell('detect invis', [2, 5, 37, 37], T.SELF, P.STANDING, 19, 5, 12, '', 'You no longer see invisible objects.', 'sight'),
  spell('detect magic', [2, 3, 37, 37], T.SELF, P.STANDING, 20, 5, 12, '', 'The detect magic wears off.', 'sight'),
  spell('dispel evil', [37, 10, 37, 37], T.OFFENSIVE, P.FIGHTING, 22, 15, 12, 'dispel evil', '', 'holy', true),
  spell('dispel magic', [11, 16, 37, 37], T.OFFENSIVE, P.FIGHTING, 59, 15, 12, '', '', 'dispel', true),
  spell('earthquake', [37, 7, 37, 37], T.IGNORE, P.FIGHTING, 23, 15, 12, 'earthquake', '', 'quake', true),
  spell('energy drain', [13, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 25, 35, 12, 'energy drain', '', 'drain', true),
  spell('faerie fire', [4, 2, 37, 37], T.OFFENSIVE, P.FIGHTING, 72, 5, 12, 'faerie fire', 'The pink aura around you fades away.', 'faerie', true),
  spell('fireball', [15, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 26, 15, 12, 'fireball', '', 'fireball', true),
  spell('flamestrike', [37, 13, 37, 37], T.OFFENSIVE, P.FIGHTING, 65, 20, 12, 'flamestrike', '', 'flamestrike', true),
  spell('fly', [7, 12, 37, 37], T.DEFENSIVE, P.STANDING, 56, 10, 18, '', 'You slowly float to the ground.', 'ward'),
  spell('gate', [37, 37, 37, 37], T.DEFENSIVE, P.FIGHTING, 83, 50, 12, '', '', 'hex'),
  spell('giant strength', [7, 37, 37, 37], T.DEFENSIVE, P.STANDING, 39, 20, 12, '', 'You feel weaker.', 'ward', true),
  spell('harm', [37, 15, 37, 37], T.OFFENSIVE, P.FIGHTING, 27, 35, 12, 'harm spell', '', 'harm', true),
  spell('heal', [37, 14, 37, 37], T.DEFENSIVE, P.FIGHTING, 28, 50, 12, '', '', 'heal', true),
  spell('identify', [10, 10, 37, 37], T.OBJ_INV, P.STANDING, 53, 12, 24, '', '', 'sight'),
  spell('infravision', [6, 9, 37, 37], T.DEFENSIVE, P.STANDING, 77, 5, 18, '', 'You no longer see in the dark.', 'sight'),
  spell('know alignment', [8, 5, 37, 37], T.OFFENSIVE, P.FIGHTING, 58, 9, 12, '', '', 'sight'),
  spell('lightning bolt', [9, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 30, 15, 12, 'lightning bolt', '', 'lightning', true),
  spell('magic missile', [1, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 32, 15, 12, 'magic missile', '', 'missile', true),
  spell('pass door', [18, 37, 37, 37], T.SELF, P.STANDING, 74, 20, 12, '', 'You feel solid again.', 'ward'),
  spell('poison', [37, 8, 37, 37], T.OFFENSIVE, P.STANDING, 33, 10, 12, 'poison', 'You feel less sick.', 'poison', true),
  spell('protection', [37, 6, 37, 37], T.SELF, P.STANDING, 34, 5, 12, '', 'You feel less protected.', 'ward', true),
  spell('refresh', [5, 3, 37, 37], T.DEFENSIVE, P.STANDING, 81, 12, 18, 'refresh', '', 'refresh', true),
  spell('remove curse', [37, 12, 37, 37], T.DEFENSIVE, P.STANDING, 35, 5, 12, '', '', 'heal'),
  spell('sanctuary', [37, 13, 37, 37], T.DEFENSIVE, P.STANDING, 36, 75, 12, '', 'The white aura around your body fades.', 'sanctuary', true),
  spell('shield', [13, 37, 37, 37], T.DEFENSIVE, P.STANDING, 67, 12, 18, '', 'Your force shield shimmers then fades away.', 'ward', true),
  spell('shocking grasp', [7, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 37, 15, 12, 'shocking grasp', '', 'shock', true),
  spell('stone skin', [17, 37, 37, 37], T.SELF, P.STANDING, 66, 12, 18, '', 'Your skin feels soft again.', 'ward', true),
  spell('teleport', [8, 37, 37, 37], T.SELF, P.FIGHTING, 2, 35, 12, '', '', 'teleport'),
  spell('weaken', [7, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 68, 20, 12, 'spell', 'You feel stronger.', 'weaken', true),
  spell('word of recall', [37, 37, 37, 37], T.SELF, P.RESTING, 42, 5, 12, '', '', 'teleport'),
  // Dragon breath: level 31-35 for a mage in the table, which no mage reaches.
  spell('acid breath', [33, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 200, 0, 4, 'blast of acid', '', 'breath-acid'),
  spell('fire breath', [34, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 201, 0, 4, 'blast of flame', '', 'breath-fire'),
  spell('frost breath', [31, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 202, 0, 4, 'blast of frost', '', 'breath-frost'),
  spell('gas breath', [35, 37, 37, 37], T.IGNORE, P.FIGHTING, 203, 0, 4, 'blast of gas', '', 'breath-gas'),
  spell('lightning breath', [32, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 204, 0, 4, 'blast of lightning', '', 'breath-lightning'),
  // mega1.are's, for spec_cast_judge.
  spell('general purpose', [37, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 501, 0, 12, 'general purpose ammo', '', 'fireball'),
  spell('high explosive', [37, 37, 37, 37], T.OFFENSIVE, P.FIGHTING, 502, 0, 12, 'high explosive ammo', '', 'fireball'),
];
export const SPELL = Object.fromEntries(SPELLS.map((s) => [s.name, s]));
const BY_SLOT = new Map(SPELLS.map((s) => [s.slot, s]));

/** skill_lookup: the first spell whose name the word begins, as `cast 'fire'` finds fireball. */
export function skillLookup(word) {
  const w = word.toLowerCase();
  return SPELLS.find((s) => s.name.startsWith(w)) || null;
}

/**
 * The spells a player can practise, in the shape game.js keeps its combat
 * skills in: `key` is the mud's own name, which is also what `learned` is
 * indexed by.
 */
export const SPELL_SKILLS = SPELLS
  .filter((s) => s.level.some((l) => l <= LEVEL_HERO))
  .map((s) => ({ key: s.name, name: s.name, level: s.level, spell: true }));

/** do_cast's mana: the minimum, or 100 / (2 + levels past the spell's own), whichever is more. */
export function manaCost(ch, sp) {
  return Math.max(sp.minMana, idiv(100, 2 + ch.level - sp.level[ch.class]));
}

// ------------------------------------------------------------- timing ----

/** Seconds to say the words: the caster's hands come up and it gathers. */
export const CAST_WINDUP = 0.62;
/** A potion or a pill has no words; a scroll or a wand has a gesture's worth. */
const ITEM_WINDUP = { quaff: 0.3, eat: 0.3, recite: 0.5, zap: 0.35, brandish: 0.5 };
const BITE_WINDUP = 0.34;
const BREATH_WINDUP = 0.7;

/**
 * How long a spell takes to reach its target once released, by family:
 * a speed (metres a second) for what flies, or a fixed time for what doesn't.
 */
const FLIGHT = {
  missile: { speed: 15, min: 0.28 },
  fireball: { speed: 12, min: 0.3 },
  acid: { speed: 13, min: 0.22 },
  lightning: { fixed: 0.07 },
  shock: { fixed: 0.12 },
  frost: { speed: 16, min: 0.18 },
  flame: { fixed: 0.32 },
  prism: { fixed: 0.26 },
  flamestrike: { fixed: 0.5 },
  storm: { fixed: 0.55 },
  quake: { fixed: 0.45 },
  drain: { fixed: 0.5 },
  harm: { fixed: 0.36 },
  holy: { fixed: 0.3 },
  'breath-fire': { fixed: 0.4 },
  'breath-frost': { fixed: 0.4 },
  'breath-acid': { fixed: 0.4 },
  'breath-gas': { fixed: 0.55 },
  'breath-lightning': { fixed: 0.14 },
};
const DEFAULT_FLIGHT = { fixed: 0.28 };

export function flightTime(family, metres) {
  const f = FLIGHT[family] || DEFAULT_FLIGHT;
  if (f.fixed !== undefined) return f.fixed;
  return Math.max(f.min, metres / f.speed);
}

/** Metres standing in for "in the room" -- a grid cell, which is what a room is here. */
export const ROOM_REACH = 13;

// ================================================================ engine ====

/**
 * The spell engine for one game.
 *
 * @param {object} deps what magic.c reaches back into, supplied by game.js:
 *   rng, emit, ctx (the combat context `damage` takes), damage(ch, victim, dam,
 *   noun, ctx), updatePos(ch), gainExp(ch, gain), player, people(ch, radius)
 *   -> characters near ch (woken mobiles and the player), distance(a, b),
 *   strikeBack(victim, ch) (the retaliation after an offensive spell), recall(ch),
 *   teleport(ch) -> bool, sky() -> SKY_*, outdoors(ch), extract(ch, obj),
 *   stopFighting(ch, both).
 */
export function createMagic(deps) {
  const { rng, emit, ctx } = deps;
  // The player whose turn it is (game.js `bind`): the one this reads as "you".
  let player = deps.player;
  const pending = [];
  let clock = 0;
  let nextId = 1;
  // WAIT_STATE for the player, in seconds; mobiles casting through a spec_fun
  // never wait, in the mud or here. On a server, every other player's is kept
  // in `waits` while it is not their turn.
  let wait = 0;
  const waits = new Map();
  function bindPlayer(ch) {
    if (player) waits.set(player, wait);
    player = ch;
    wait = ch ? waits.get(ch) || 0 : 0;
  }

  const slotOf = (ch) => (ch && ch !== player ? ch.slot || null : null);
  const nameOf = (ch) => (ch === player ? 'you' : ch.name);
  const Name = (ch) => capitalise(nameOf(ch));
  const nearPlayer = (ch) => ch === player || deps.distance(ch, player) <= ROOM_REACH * ROOM_REACH;

  /** Text for the one reader there is: `tone` is how game-ui colours it. */
  function say(text, tone = 'faint') { emit({ kind: 'magic', text, tone }); }
  /** send_to_char: read if `to` is the player -- or, on a server, any player. */
  function toChar(to, text, tone) {
    if (to === player) say(text, tone);
    else if (deps.tell && to && !isNpc(to)) deps.tell(to, { kind: 'magic', text, tone });
  }
  /** act(TO_ROOM) with `actor` as $n: read if you are there and are not $n. */
  function toRoom(actor, text, tone) {
    if (deps.roomcast) { deps.roomcast(actor, { kind: 'magic', text, tone }); return; }
    if (actor !== player && nearPlayer(actor)) say(text, tone);
  }
  /** Both sides of a spell by name, for a server to tell each reader apart. */
  const sides = (ch, victim) => (deps.tell ? { fromCh: ch, toCh: victim } : null);
  /** The "Ok." a caster gets when the spell was on someone else. */
  function ok(ch, victim) { if (ch !== victim) toChar(ch, 'Ok.', 'faint'); }

  // Everything a spell_fun touched, for the picture: who was hurt, who saved.
  let hits = null;
  let saved = false;
  function hurt(ch, victim, dam, noun) {
    if (hits) hits.push({ to: slotOf(victim), player: victim === player, dam });
    deps.damage(ch, victim, dam, noun, ctx);
  }
  const saves = (level, victim) => {
    const s = savesSpell(rng, level, victim);
    if (s) saved = true;
    return s;
  };
  const d = (n, s) => dice(rng, n, s);
  const opposite = (ch, vch) => (isNpc(ch) ? !isNpc(vch) : isNpc(vch));

  // ---------------------------------------------------------- spell_funs --

  const FUN = {
    'acid blast'(level, ch, victim) {
      let dam = d(level, 6);
      if (saves(level, victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'acid blast');
    },
    armor(level, ch, victim) {
      if (isAffected(victim, 'armor')) return;
      affectToChar(victim, { type: 'armor', duration: 24, modifier: -20, location: APPLY.AC });
      toChar(victim, 'You feel someone protecting you.', 'gain');
      ok(ch, victim);
    },
    bless(level, ch, victim) {
      if (victim.position === POS.FIGHTING || isAffected(victim, 'bless')) return;
      affectToChar(victim, { type: 'bless', duration: 6 + level, location: APPLY.HITROLL, modifier: idiv(level, 8) });
      affectToChar(victim, { type: 'bless', duration: 6 + level, location: APPLY.SAVING_SPELL, modifier: -idiv(level, 8) });
      toChar(victim, 'You feel righteous.', 'gain');
      ok(ch, victim);
    },
    blindness(level, ch, victim) {
      if ((victim.affectedBy & AFF.BLIND) || saves(level, victim)) return;
      affectToChar(victim, { type: 'blindness', location: APPLY.HITROLL, modifier: -4, duration: 1 + level, bitvector: AFF.BLIND });
      toChar(victim, 'You are blinded!', 'them');
      ok(ch, victim);
    },
    'burning hands'(level, ch, victim) {
      const table = [0, 0, 0, 0, 0, 14, 17, 20, 23, 26, 29, 29, 29, 30, 30, 31, 31, 32, 32, 33, 33,
        34, 34, 35, 35, 36, 36, 37, 37, 38, 38, 39, 39, 40, 40, 41, 41, 42, 42, 43, 43,
        44, 44, 45, 45, 46, 46, 47, 47, 48, 48];
      let dam = fromTable(rng, table, level);
      if (saves(clamp(level, 0, table.length - 1), victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'burning hands');
    },
    'call lightning'(level, ch) {
      if (!deps.outdoors(ch)) { toChar(ch, 'You must be out of doors.'); return false; }
      if (deps.sky() < 2) { toChar(ch, 'You need bad weather.'); return false; }
      const dam = d(idiv(level, 2), 8);
      toChar(ch, "God's lightning strikes your foes!", 'you');
      toRoom(ch, `${Name(ch)} calls God's lightning to strike ${ch.sex === 2 ? 'her' : 'his'} foes!`, 'them');
      for (const vch of deps.people(ch, ROOM_REACH)) {
        if (vch !== ch && opposite(ch, vch)) hurt(ch, vch, saves(level, vch) ? idiv(dam, 2) : dam, 'lightning bolt');
      }
      return true;
    },
    'cause light'(level, ch, victim) { hurt(ch, victim, d(1, 8) + idiv(level, 3), 'spell'); },
    'cause critical'(level, ch, victim) { hurt(ch, victim, d(3, 8) + level - 6, 'spell'); },
    'cause serious'(level, ch, victim) { hurt(ch, victim, d(2, 8) + idiv(level, 2), 'spell'); },
    'change sex'(level, ch, victim) {
      if (isAffected(victim, 'change sex')) return;
      let modifier;
      do { modifier = rng.range(0, 2) - victim.sex; } while (modifier === 0);
      affectToChar(victim, { type: 'change sex', duration: 10 * level, location: APPLY.SEX, modifier });
      toChar(victim, 'You feel different.', 'them');
      ok(ch, victim);
    },
    'chill touch'(level, ch, victim) {
      const table = [0, 0, 0, 6, 7, 8, 9, 12, 13, 13, 13, 14, 14, 14, 15, 15, 15, 16, 16, 16, 17,
        17, 17, 18, 18, 18, 19, 19, 19, 20, 20, 20, 21, 21, 21, 22, 22, 22, 23, 23, 23,
        24, 24, 24, 25, 25, 25, 26, 26, 26, 27];
      const l = clamp(level, 0, table.length - 1);
      let dam = fromTable(rng, table, level);
      if (!saves(l, victim)) {
        affectJoin(victim, { type: 'chill touch', duration: 6, location: APPLY.STR, modifier: -1 });
      } else {
        dam = idiv(dam, 2);
      }
      hurt(ch, victim, dam, 'chilling touch');
    },
    'colour spray'(level, ch, victim) {
      const table = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 35, 40, 45, 50, 55, 55, 55, 56, 57,
        58, 58, 59, 60, 61, 61, 62, 63, 64, 64, 65, 66, 67, 67, 68, 69, 70, 70, 71, 72,
        73, 73, 74, 75, 76, 76, 77, 78, 79, 79];
      let dam = fromTable(rng, table, level);
      if (saves(clamp(level, 0, table.length - 1), victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'colour spray');
    },
    'cure blindness'(level, ch, victim) {
      if (!isAffected(victim, 'blindness')) return;
      affectStrip(victim, 'blindness');
      toChar(victim, 'Your vision returns!', 'gain');
      ok(ch, victim);
    },
    'cure critical'(level, ch, victim) { heal(ch, victim, d(3, 8) + level - 6, 'You feel better!'); },
    'cure light'(level, ch, victim) { heal(ch, victim, d(1, 8) + idiv(level, 3), 'You feel better!'); },
    'cure serious'(level, ch, victim) { heal(ch, victim, d(2, 8) + idiv(level, 2), 'You feel better!'); },
    'cure poison'(level, ch, victim) {
      if (!isAffected(victim, 'poison')) return;
      affectStrip(victim, 'poison');
      toRoom(victim, `${Name(victim)} looks better.`);
      toChar(victim, 'A warm feeling runs through your body.', 'gain');
      toChar(ch, 'Ok.');
    },
    curse(level, ch, victim) {
      if ((victim.affectedBy & AFF.CURSE) || saves(level, victim)) return;
      affectToChar(victim, { type: 'curse', duration: 4 * level, location: APPLY.HITROLL, modifier: -1, bitvector: AFF.CURSE });
      affectToChar(victim, { type: 'curse', duration: 4 * level, location: APPLY.SAVING_SPELL, modifier: 1, bitvector: AFF.CURSE });
      toChar(victim, 'You feel unclean.', 'them');
      ok(ch, victim);
    },
    'detect evil'(level, ch, victim) { detect(ch, victim, 'detect evil', AFF.DETECT_EVIL, level, 'Your eyes tingle.'); },
    'detect hidden'(level, ch, victim) { detect(ch, victim, 'detect hidden', AFF.DETECT_HIDDEN, level, 'Your awareness improves.'); },
    'detect invis'(level, ch, victim) { detect(ch, victim, 'detect invis', AFF.DETECT_INVIS, level, 'Your eyes tingle.'); },
    'detect magic'(level, ch, victim) { detect(ch, victim, 'detect magic', AFF.DETECT_MAGIC, level, 'Your eyes tingle.'); },
    'dispel evil'(level, ch, victim) {
      if (!isNpc(ch) && isEvil(ch)) victim = ch;
      if (isGood(victim)) { toRoom(ch, `God protects ${nameOf(victim)}.`); if (ch === player) say(`God protects ${nameOf(victim)}.`); return false; }
      if (!isGood(victim) && !isEvil(victim)) { toChar(ch, `${Name(victim)} does not seem to be affected.`); return false; }
      let dam = d(level, 4);
      if (saves(level, victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'dispel evil');
      return true;
    },
    'dispel magic'(level, ch, victim) {
      if (!victim.affectedBy || level < victim.level || saves(level, victim)) { toChar(ch, 'You failed.'); return false; }
      let bit;
      do { bit = 1 << rng.bits(5); } while (!(victim.affectedBy & bit));
      victim.affectedBy &= ~bit;
      toChar(ch, 'Ok.');
      return true;
    },
    earthquake(level, ch) {
      toChar(ch, 'The earth trembles beneath your feet!', 'you');
      toRoom(ch, `${Name(ch)} makes the earth tremble and shiver.`, 'them');
      for (const vch of deps.people(ch, ROOM_REACH)) {
        if (vch !== ch && opposite(ch, vch)) hurt(ch, vch, level + d(2, 8), 'earthquake');
      }
      return true;
    },
    'energy drain'(level, ch, victim) {
      if (saves(level, victim)) return false;
      ch.alignment = Math.max(-1000, ch.alignment - 200);
      let dam;
      if (victim.level <= 2) {
        dam = ch.hit + 1;
      } else {
        deps.gainExp(victim, -rng.range(idiv(level, 2), idiv(3 * level, 2)));
        if (victim.mana !== undefined) victim.mana = idiv(victim.mana, 2);
        if (victim.move !== undefined) victim.move = idiv(victim.move, 2);
        dam = d(1, level);
        ch.hit += dam;
      }
      hurt(ch, victim, dam, 'energy drain');
      return true;
    },
    'faerie fire'(level, ch, victim) {
      if (victim.affectedBy & AFF.FAERIE_FIRE) return false;
      affectToChar(victim, { type: 'faerie fire', duration: level, location: APPLY.AC, modifier: 2 * level, bitvector: AFF.FAERIE_FIRE });
      toChar(victim, 'You are surrounded by a pink outline.', 'them');
      toRoom(victim, `${Name(victim)} is surrounded by a pink outline.`);
      return true;
    },
    fireball(level, ch, victim) {
      const table = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 35, 40, 45, 50, 55,
        60, 65, 70, 75, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110,
        112, 114, 116, 118, 120, 122, 124, 126, 128, 130];
      let dam = fromTable(rng, table, level);
      if (saves(clamp(level, 0, table.length - 1), victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'fireball');
    },
    flamestrike(level, ch, victim) {
      let dam = d(6, 8);
      if (saves(level, victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'flamestrike');
    },
    fly(level, ch, victim) {
      if (victim.affectedBy & AFF.FLYING) return;
      affectToChar(victim, { type: 'fly', duration: level + 3, bitvector: AFF.FLYING });
      toChar(victim, 'Your feet rise off the ground.', 'gain');
      toRoom(victim, `${Name(victim)}'s feet rise off the ground.`);
    },
    // DIVERGES: gate calls a vampire (#3404) into the room. No area that is
    // loaded here has one -- in the C that is create_mobile(NULL) and a crash
    // -- and a mobile with no figure has nowhere to stand, so it calls nobody.
    gate() { return false; },
    'giant strength'(level, ch, victim) {
      if (isAffected(victim, 'giant strength')) return;
      affectToChar(victim, { type: 'giant strength', duration: level, location: APPLY.STR, modifier: 1 + (level >= 18) + (level >= 25) });
      toChar(victim, 'You feel stronger.', 'gain');
      ok(ch, victim);
    },
    harm(level, ch, victim) {
      let dam = Math.max(20, victim.hit - d(1, 4));
      if (saves(level, victim)) dam = Math.min(50, idiv(dam, 4));
      dam = Math.min(100, dam);
      hurt(ch, victim, dam, 'harm spell');
    },
    heal(level, ch, victim) { heal(ch, victim, 100, 'A warm feeling fills your body.'); },
    identify(level, ch, obj) {
      if (!obj) return false;
      const type = Object.keys(ITEM).find((k) => ITEM[k] === obj.itemType) || 'thing';
      toChar(ch, `Object '${obj.keywords}' is type ${type.toLowerCase()}, weight ${obj.weight}, value ${obj.cost}, level ${obj.level}.`, 'gain');
      if (obj.itemType === ITEM.WEAPON) {
        toChar(ch, `Damage is ${obj.values[1]} to ${obj.values[2]} (average ${idiv(obj.values[1] + obj.values[2], 2)}).`, 'gain');
      } else if (obj.itemType === ITEM.ARMOR) {
        toChar(ch, `Armor class is ${obj.values[0]}.`, 'gain');
      } else if ([ITEM.SCROLL, ITEM.POTION, ITEM.PILL].includes(obj.itemType)) {
        const names = [1, 2, 3].map((i) => BY_SLOT.get(obj.values[i])).filter(Boolean).map((s) => `'${s.name}'`);
        toChar(ch, `Level ${obj.values[0]} spells of: ${names.join(' ')}.`, 'gain');
      } else if (obj.itemType === ITEM.WAND || obj.itemType === ITEM.STAFF) {
        const s = BY_SLOT.get(obj.values[3]);
        toChar(ch, `Has ${obj.values[1]}(${obj.values[2]}) charges of level ${obj.values[0]}${s ? ` '${s.name}'` : ''}.`, 'gain');
      }
      for (const af of obj.affects || []) {
        if (af.location && af.modifier) toChar(ch, `Affects ${affectLocName(af.location)} by ${af.modifier}.`, 'gain');
      }
      return true;
    },
    infravision(level, ch, victim) {
      if (victim.affectedBy & AFF.INFRARED) return;
      toRoom(ch, `${Name(ch)}'s eyes glow red.`);
      affectToChar(victim, { type: 'infravision', duration: 2 * level, bitvector: AFF.INFRARED });
      toChar(victim, 'Your eyes glow red.', 'gain');
      ok(ch, victim);
    },
    'know alignment'(level, ch, victim) {
      const ap = victim.alignment;
      const n = nameOf(victim);
      const msg = ap > 700 ? `${capitalise(n)} has an aura as white as the driven snow.`
        : ap > 350 ? `${capitalise(n)} is of excellent moral character.`
          : ap > 100 ? `${capitalise(n)} is often kind and thoughtful.`
            : ap > -100 ? `${capitalise(n)} doesn't have a firm moral commitment.`
              : ap > -350 ? `${capitalise(n)} lies to ${victim.sex === 2 ? 'her' : 'his'} friends.`
                : ap > -700 ? `${capitalise(n)}'s slash DISEMBOWELS you!`
                  : `I'd rather just not say anything at all about ${n}.`;
      toChar(ch, msg, 'gain');
    },
    'lightning bolt'(level, ch, victim) {
      const table = [0, 0, 0, 0, 0, 0, 0, 0, 0, 25, 28, 31, 34, 37, 40, 40, 41, 42, 42, 43, 44,
        44, 45, 46, 46, 47, 48, 48, 49, 50, 50, 51, 52, 52, 53, 54, 54, 55, 56, 56, 57,
        58, 58, 59, 60, 60, 61, 62, 62, 63, 64];
      let dam = fromTable(rng, table, level);
      if (saves(clamp(level, 0, table.length - 1), victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'lightning bolt');
    },
    'magic missile'(level, ch, victim) {
      const table = [0, 3, 3, 4, 4, 5, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8,
        9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 12, 12, 12, 12, 12,
        13, 13, 13, 13, 13, 14, 14, 14, 14, 14];
      let dam = fromTable(rng, table, level);
      if (saves(clamp(level, 0, table.length - 1), victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'magic missile');
    },
    'pass door'(level, ch, victim) {
      if (victim.affectedBy & AFF.PASS_DOOR) return;
      affectToChar(victim, { type: 'pass door', duration: rng.fuzzy(idiv(level, 4)), bitvector: AFF.PASS_DOOR });
      toRoom(victim, `${Name(victim)} turns translucent.`);
      toChar(victim, 'You turn translucent.', 'gain');
    },
    poison(level, ch, victim) {
      if (saves(level, victim)) return false;
      affectJoin(victim, { type: 'poison', duration: level, location: APPLY.STR, modifier: -2, bitvector: AFF.POISON });
      toChar(victim, 'You feel very sick.', 'them');
      ok(ch, victim);
      return true;
    },
    protection(level, ch, victim) {
      if (victim.affectedBy & AFF.PROTECT) return;
      affectToChar(victim, { type: 'protection', duration: 24, bitvector: AFF.PROTECT });
      toChar(victim, 'You feel protected.', 'gain');
      ok(ch, victim);
    },
    refresh(level, ch, victim) {
      if (victim.move !== undefined) victim.move = Math.min(victim.move + level, victim.maxMove);
      toChar(victim, 'You feel less tired.', 'gain');
      ok(ch, victim);
    },
    'remove curse'(level, ch, victim) {
      if (!isAffected(victim, 'curse')) return;
      affectStrip(victim, 'curse');
      toChar(victim, 'You feel better.', 'gain');
      ok(ch, victim);
    },
    sanctuary(level, ch, victim) {
      if (victim.affectedBy & AFF.SANCTUARY) return false;
      affectToChar(victim, { type: 'sanctuary', duration: rng.fuzzy(idiv(level, 8)), bitvector: AFF.SANCTUARY });
      toRoom(victim, `${Name(victim)} is surrounded by a white aura.`);
      toChar(victim, 'You are surrounded by a white aura.', 'gain');
      return true;
    },
    shield(level, ch, victim) {
      if (isAffected(victim, 'shield')) return;
      affectToChar(victim, { type: 'shield', duration: 8 + level, location: APPLY.AC, modifier: -20 });
      toRoom(victim, `${Name(victim)} is surrounded by a force shield.`);
      toChar(victim, 'You are surrounded by a force shield.', 'gain');
    },
    'shocking grasp'(level, ch, victim) {
      const table = [0, 0, 0, 0, 0, 0, 0, 20, 25, 29, 33, 36, 39, 39, 39, 40, 40, 41, 41, 42, 42,
        43, 43, 44, 44, 45, 45, 46, 46, 47, 47, 48, 48, 49, 49, 50, 50, 51, 51, 52, 52,
        53, 53, 54, 54, 55, 55, 56, 56, 57, 57];
      let dam = fromTable(rng, table, level);
      if (saves(clamp(level, 0, table.length - 1), victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'shocking grasp');
    },
    // Merc's own slip, kept: it asks whether the *caster* has stone skin.
    'stone skin'(level, ch, victim) {
      if (isAffected(ch, 'stone skin')) return;
      affectToChar(victim, { type: 'stone skin', duration: level, location: APPLY.AC, modifier: -40 });
      toRoom(victim, `${Name(victim)}'s skin turns to stone.`);
      toChar(victim, 'Your skin turns to stone.', 'gain');
    },
    teleport(level, ch, victim) {
      if ((!isNpc(ch) && victim.fighting)
        || (victim !== ch && (saves(level, victim) || saves(level, victim)))
        || !deps.teleport(victim)) {
        toChar(ch, 'You failed.');
        return false;
      }
      toRoom(victim, `${Name(victim)} slowly fades out of existence.`);
      toChar(victim, 'You slowly fade into existence somewhere else.', 'gate');
      return true;
    },
    weaken(level, ch, victim) {
      if (isAffected(victim, 'weaken') || saves(level, victim)) return false;
      affectToChar(victim, { type: 'weaken', duration: idiv(level, 2), location: APPLY.STR, modifier: -2 });
      toChar(victim, 'You feel weaker.', 'them');
      ok(ch, victim);
      return true;
    },
    'word of recall'(level, ch, victim) { deps.recall(victim); },

    // -- NPC spells -------------------------------------------------------
    'acid breath'(level, ch, victim) {
      // The C walks ch->carrying, the dragon's own pack, while telling the
      // victim about it -- kept, so the acid etches the dragon's own gear.
      if (rng.percent() < 2 * level && !saves(level, victim)) {
        for (const obj of (ch.inventory || []).slice()) {
          if (rng.bits(2) !== 0) continue;
          if (obj.itemType === ITEM.ARMOR && obj.values[0] > 0) {
            toChar(victim, `${capitalise(obj.name)} is pitted and etched!`, 'them');
            obj.values[0] -= 1;
            obj.cost = 0;
          } else if (obj.itemType === ITEM.CONTAINER) {
            toChar(victim, `${capitalise(obj.name)} fumes and dissolves!`, 'them');
            deps.extract(ch, obj);
          }
        }
      }
      breath(level, ch, victim, 'blast of acid');
    },
    'fire breath'(level, ch, victim) {
      if (rng.percent() < 2 * level && !saves(level, victim)) {
        const msg = {
          [ITEM.CONTAINER]: 'ignites and burns!', [ITEM.POTION]: 'bubbles and boils!',
          [ITEM.SCROLL]: 'crackles and burns!', [ITEM.STAFF]: 'smokes and chars!',
          [ITEM.WAND]: 'sparks and sputters!', [ITEM.FOOD]: 'blackens and crisps!', [ITEM.PILL]: 'melts and drips!',
        };
        burnPack(victim, msg);
      }
      breath(level, ch, victim, 'blast of flame');
    },
    'frost breath'(level, ch, victim) {
      if (rng.percent() < 2 * level && !saves(level, victim)) {
        const shatter = 'freezes and shatters!';
        burnPack(victim, { [ITEM.CONTAINER]: shatter, [ITEM.DRINK_CON]: shatter, [ITEM.POTION]: shatter });
      }
      breath(level, ch, victim, 'blast of frost');
    },
    'gas breath'(level, ch) {
      for (const vch of deps.people(ch, ROOM_REACH)) {
        if (!opposite(ch, vch)) continue;
        const hpch = Math.max(10, ch.hit);
        let dam = rng.range(idiv(hpch, 16) + 1, idiv(hpch, 8));
        if (saves(level, vch)) dam = idiv(dam, 2);
        hurt(ch, vch, dam, 'blast of gas');
      }
      return true;
    },
    'lightning breath'(level, ch, victim) { breath(level, ch, victim, 'blast of lightning'); },
    'general purpose'(level, ch, victim) {
      let dam = rng.range(25, 100);
      if (saves(level, victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'general purpose ammo');
    },
    'high explosive'(level, ch, victim) {
      let dam = rng.range(30, 120);
      if (saves(level, victim)) dam = idiv(dam, 2);
      hurt(ch, victim, dam, 'high explosive ammo');
    },
  };

  function heal(ch, victim, amount, text) {
    victim.hit = Math.min(victim.hit + amount, victim.maxHit);
    deps.updatePos(victim);
    toChar(victim, text, 'gain');
    ok(ch, victim);
  }

  function detect(ch, victim, type, bit, level, text) {
    if (victim.affectedBy & bit) return;
    affectToChar(victim, { type, duration: level, bitvector: bit });
    toChar(victim, text, 'gain');
    ok(ch, victim);
  }

  function breath(level, ch, victim, noun) {
    const hpch = Math.max(10, ch.hit);
    let dam = rng.range(idiv(hpch, 16) + 1, idiv(hpch, 8));
    if (saves(level, victim)) dam = idiv(dam, 2);
    hurt(ch, victim, dam, noun);
  }

  function burnPack(victim, messages) {
    for (const obj of (victim.inventory || []).slice()) {
      if (rng.bits(2) !== 0) continue;
      const msg = messages[obj.itemType];
      if (!msg) continue;
      toChar(victim, `${capitalise(obj.name)} ${msg}`, 'them');
      deps.extract(victim, obj);
    }
  }

  // -------------------------------------------------------- invocation --

  /**
   * Start a spell on its way. `source` is how it was set off (cast, spec,
   * bite, breath, or an item verb); the rules run when it arrives.
   */
  function invoke(sp, level, ch, vo, { source = 'cast', offensiveCast = false, words = null, item = null } = {}) {
    const victim = vo && vo.npc !== undefined ? vo : null;   // a character, not an object
    const windup = source === 'spec' || source === 'cast' ? CAST_WINDUP
      : source === 'bite' ? BITE_WINDUP
        : source === 'breath' ? BREATH_WINDUP
          : (ITEM_WINDUP[source] ?? 0.4);
    const metres = victim && victim !== ch ? Math.sqrt(deps.distance(ch, victim)) : 0;
    const flight = victim === ch ? 0.22 : flightTime(sp.family, metres);
    const id = nextId++;
    emit({
      kind: 'cast', id, spell: sp.name, family: sp.family, source, level,
      from: slotOf(ch), fromPlayer: ch === player,
      to: victim ? slotOf(victim) : undefined, toPlayer: victim === player, self: victim === ch,
      area: sp.target === TAR.IGNORE, windup, flight, text: words || '', item: item ? item.name : null,
      ...sides(ch, victim),
    });
    pending.push({ id, sp, level, ch, vo, release: clock + windup, land: clock + windup + flight, released: false, offensiveCast, source });
    return id;
  }

  /** Run a spell_fun now, recording what it did for the picture. */
  function run(p) {
    hits = [];
    saved = false;
    let result;
    try { result = FUN[p.sp.name](p.level, p.ch, p.vo); } finally {
      const victim = p.vo && p.vo.npc !== undefined ? p.vo : null;
      emit({
        kind: 'spell', id: p.id, spell: p.sp.name, family: p.sp.family, source: p.source,
        from: slotOf(p.ch), fromPlayer: p.ch === player,
        to: victim ? slotOf(victim) : undefined, toPlayer: victim === player, self: victim === p.ch,
        hits, saved, failed: result === false,
        ...sides(p.ch, victim),
      });
      hits = null;
    }
    // do_cast / obj_cast_spell: an offensive spell starts the fight it asks for.
    const victim = p.vo;
    if (p.offensiveCast && victim && victim !== p.ch && victim.npc !== undefined
      && victim.position > POS.DEAD && !victim.fighting && !(victim.slot && victim.slot.dead)) {
      deps.strikeBack(victim, p.ch);
    }
  }

  const alive = (ch) => ch && ch.position > POS.DEAD && !(ch.slot && ch.slot.dead);

  /** Seconds of wall time: release what has been said, land what has arrived. */
  function update(dt) {
    clock += dt;
    if (wait > 0) wait = Math.max(0, wait - dt);
    for (const [ch, w] of waits) if (ch !== player && w > 0) waits.set(ch, Math.max(0, w - dt));
    // Each spell lands on its caster's turn: their screen, their "you".
    const asCaster = deps.asCaster || ((ch, fn) => fn());
    for (let i = 0; i < pending.length;) {
      const p = pending[i];
      if (!p.released && clock >= p.release) {
        p.released = true;
        // The words were never finished: stunned, or dead, mid-sentence.
        if (!alive(p.ch) || p.ch.position <= POS.STUNNED) {
          pending.splice(i, 1);
          asCaster(p.ch, () => emit({ kind: 'spell-fizzle', id: p.id, from: slotOf(p.ch), fromPlayer: p.ch === player, ...sides(p.ch, null) }));
          continue;
        }
      }
      if (p.released && clock >= p.land) {
        pending.splice(i, 1);
        const victim = p.vo && p.vo.npc !== undefined ? p.vo : null;
        if (victim && victim !== p.ch && !alive(victim)) {
          asCaster(p.ch, () => emit({ kind: 'spell-fizzle', id: p.id, from: slotOf(p.ch), fromPlayer: p.ch === player, spent: true, ...sides(p.ch, null) }));
          continue;
        }
        asCaster(p.ch, () => run(p));
        continue;
      }
      i++;
    }
  }

  // ------------------------------------------------------------ do_cast --

  /**
   * magic.c: do_cast, for the player. `target` is whoever the player means --
   * game.js decides that from where you are looking -- and `obj` an object in
   * the pack for the object spells.
   */
  function cast(name, { target = null, obj = null } = {}) {
    const ch = player;
    const sp = SPELL[name] || skillLookup(name);
    if (!sp || !FUN[sp.name] || ch.level < sp.level[ch.class]) return { ok: false, text: "You can't do that." };
    if (ch.position < sp.minPos) return { ok: false, text: "You can't concentrate enough." };
    if (wait > 0) return { ok: false, text: 'You are still gathering yourself.', wait };
    const mana = manaCost(ch, sp);

    let vo = null;
    switch (sp.target) {
      case TAR.IGNORE: break;
      case TAR.OFFENSIVE:
        vo = target || ch.fighting;
        if (!vo) return { ok: false, text: 'Cast the spell on whom?' };
        if (vo === ch) return { ok: false, text: "You can't do that to yourself." };
        if (!isNpc(vo)) return { ok: false, text: "You can't do that on a player." };
        break;
      case TAR.DEFENSIVE: vo = target || ch; break;
      case TAR.SELF:
        if (target && target !== ch) return { ok: false, text: 'You cannot cast this spell on another.' };
        vo = ch; break;
      case TAR.OBJ_INV:
        if (!obj) return { ok: false, text: 'What should the spell be cast upon?' };
        if (ch.inventory.indexOf(obj) < 0) return { ok: false, text: 'You are not carrying that.' };
        vo = obj; break;
      default: throw new Error(`magic.js: ${sp.name} has no target type`);
    }
    if (ch.mana < mana) return { ok: false, text: "You don't have enough mana." };

    wait = sp.beats / PULSE_PER_SECOND;
    if (rng.percent() > (ch.learned[sp.name] || 0)) {
      ch.mana -= idiv(mana, 2);
      emit({ kind: 'cast', id: nextId++, spell: sp.name, family: sp.family, source: 'cast', fromPlayer: true, from: null, lost: true, windup: CAST_WINDUP * 0.6, flight: 0 });
      say('You lost your concentration.', 'faint');
      return { ok: false, text: 'You lost your concentration.', lost: true };
    }
    ch.mana -= mana;
    invoke(sp, ch.level, ch, vo, { source: 'cast', offensiveCast: sp.target === TAR.OFFENSIVE });
    return { ok: true, text: `You cast ${sp.name}.`, spell: sp.name, mana };
  }

  /** The spells the player could cast right now, for the spell bar. */
  function known(ch = player) {
    return SPELLS.filter((sp) => sp.bar && ch.level >= sp.level[ch.class] && sp.level[ch.class] <= LEVEL_HERO)
      .map((sp) => ({
        name: sp.name, family: sp.family, target: sp.target, mana: manaCost(ch, sp),
        learned: ch.learned[sp.name] || 0, level: sp.level[ch.class],
      }));
  }

  // ------------------------------------------------------ obj_cast_spell --

  /**
   * magic.c: obj_cast_spell. `slot` is the #OBJECTS slot number the item
   * carries; the mud converts it with slot_lookup at boot, here on use.
   */
  function objCastSpell(slot, level, ch, victim, obj, source, item) {
    if (slot <= 0) return;
    const sp = BY_SLOT.get(slot);
    if (!sp || !FUN[sp.name]) throw new Error(`magic.js: no spell in slot ${slot} (on ${item ? item.name : 'an item'})`);
    let vo;
    switch (sp.target) {
      case TAR.IGNORE: vo = null; break;
      case TAR.OFFENSIVE:
        if (!victim) victim = ch.fighting;
        if (!victim || !isNpc(victim)) { toChar(ch, "You can't do that."); return; }
        vo = victim; break;
      case TAR.DEFENSIVE: vo = victim || ch; break;
      case TAR.SELF: vo = ch; break;
      case TAR.OBJ_INV:
        if (!obj) { toChar(ch, "You can't do that."); return; }
        vo = obj; break;
      default: throw new Error(`magic.js: ${sp.name} has no target type`);
    }
    invoke(sp, level, ch, vo, { source, offensiveCast: sp.target === TAR.OFFENSIVE, item });
  }

  const held = (ch) => ch.equipment && ch.equipment[17];

  /** act_obj.c: do_quaff. */
  function quaff(obj) {
    if (player.inventory.indexOf(obj) < 0) return { ok: false, text: 'You do not have that potion.' };
    if (obj.itemType !== ITEM.POTION) return { ok: false, text: 'You can quaff only potions.' };
    say(`You quaff ${obj.name}.`, 'gain');
    for (const i of [1, 2, 3]) objCastSpell(obj.values[i], obj.values[0], player, player, null, 'quaff', obj);
    deps.extract(player, obj);
    return { ok: true, text: `You quaff ${obj.name}.` };
  }

  /** act_obj.c: do_eat, the ITEM_PILL branch. */
  function eatPill(obj) {
    if (player.inventory.indexOf(obj) < 0) return { ok: false, text: 'You do not have that item.' };
    if (obj.itemType !== ITEM.PILL) return { ok: false, text: "That's not a pill." };
    say(`You eat ${obj.name}.`, 'gain');
    for (const i of [1, 2, 3]) objCastSpell(obj.values[i], obj.values[0], player, player, null, 'eat', obj);
    deps.extract(player, obj);
    return { ok: true, text: `You eat ${obj.name}.` };
  }

  /** act_obj.c: do_recite. `target` a character, or `targetObj` a thing in the pack. */
  function recite(scroll, { target = null, targetObj = null } = {}) {
    if (player.inventory.indexOf(scroll) < 0) return { ok: false, text: 'You do not have that scroll.' };
    if (scroll.itemType !== ITEM.SCROLL) return { ok: false, text: 'You can recite only scrolls.' };
    say(`You recite ${scroll.name}.`, 'gain');
    const victim = targetObj ? null : (target || player);
    for (const i of [1, 2, 3]) objCastSpell(scroll.values[i], scroll.values[0], player, victim, targetObj, 'recite', scroll);
    deps.extract(player, scroll);
    return { ok: true, text: `You recite ${scroll.name}.` };
  }

  /** act_obj.c: do_zap -- at whoever you are fighting, or `target`. */
  function zap(target = null) {
    const wand = held(player);
    if (!wand) return { ok: false, text: 'You hold nothing in your hand.' };
    if (wand.itemType !== ITEM.WAND) return { ok: false, text: 'You can zap only with a wand.' };
    const victim = target || player.fighting;
    if (!victim) return { ok: false, text: 'Zap whom or what?' };
    wait = Math.max(wait, (2 * 12) / PULSE_PER_SECOND);
    if (wand.values[2] > 0) {
      say(`You zap ${nameOf(victim)} with ${wand.name}.`, 'you');
      objCastSpell(wand.values[3], wand.values[0], player, victim, null, 'zap', wand);
    }
    if (--wand.values[2] <= 0) {
      say(`Your ${wand.name} explodes into fragments.`, 'faint');
      deps.extract(player, wand);
    }
    return { ok: true, text: `You zap ${nameOf(victim)}.` };
  }

  /** act_obj.c: do_brandish -- over everyone in the room the spell is for. */
  function brandish() {
    const staff = held(player);
    if (!staff) return { ok: false, text: 'You hold nothing in your hand.' };
    if (staff.itemType !== ITEM.STAFF) return { ok: false, text: 'You can brandish only with a staff.' };
    const sp = BY_SLOT.get(staff.values[3]);
    if (!sp) throw new Error(`magic.js: ${staff.name} carries no spell (slot ${staff.values[3]})`);
    wait = Math.max(wait, (2 * 12) / PULSE_PER_SECOND);
    if (staff.values[2] > 0) {
      say(`You brandish ${staff.name}.`, 'you');
      for (const vch of deps.people(player, ROOM_REACH)) {
        if (sp.target === TAR.IGNORE || sp.target === TAR.SELF) { if (vch !== player) continue; }
        else if (sp.target === TAR.OFFENSIVE) { if (!isNpc(vch)) continue; }
        else if (sp.target === TAR.DEFENSIVE) { if (isNpc(vch)) continue; }
        objCastSpell(staff.values[3], staff.values[0], player, vch, null, 'brandish', staff);
      }
    }
    if (--staff.values[2] <= 0) {
      say(`Your ${staff.name} blazes bright and is gone.`, 'faint');
      deps.extract(player, staff);
    }
    return { ok: true, text: `You brandish ${staff.name}.` };
  }

  /** Whichever of the above an object is for, as the inventory offers it. */
  function useItem(obj, options = {}) {
    switch (obj.itemType) {
      case ITEM.POTION: return quaff(obj);
      case ITEM.PILL: return eatPill(obj);
      case ITEM.SCROLL: return recite(obj, options);
      case ITEM.WAND: return held(player) === obj ? zap(options.target) : { ok: false, text: 'Hold it first.' };
      case ITEM.STAFF: return held(player) === obj ? brandish() : { ok: false, text: 'Hold it first.' };
      default: return { ok: false, text: "You can't use that." };
    }
  }

  /** What a magic item's verb is, or null for anything else. */
  function itemVerb(obj) {
    return ({ [ITEM.POTION]: 'quaff', [ITEM.PILL]: 'eat', [ITEM.SCROLL]: 'recite', [ITEM.WAND]: 'zap', [ITEM.STAFF]: 'brandish' })[obj.itemType] || null;
  }

  /** Does a scroll want an object to be read at (identify)? */
  function wantsObject(obj) {
    return obj.itemType === ITEM.SCROLL && [1, 2, 3].some((i) => BY_SLOT.get(obj.values[i])?.target === TAR.OBJ_INV);
  }

  // ---------------------------------------------------------- spec_funs --

  /** The first in the room fighting `ch`, one in four each -- special.c's victim loop. */
  function foe(ch) {
    for (const vch of deps.people(ch, ROOM_REACH)) {
      if (vch.fighting === ch && rng.bits(2) === 0) return vch;
    }
    return null;
  }

  /** The level-gated spell table every caster spec_fun rolls in a loop. */
  function pick(ch, table) {
    for (;;) {
      const [minLevel, name] = table[rng.bits(4)] || table[table.length - 1];
      if (ch.level >= minLevel) return name;
    }
  }

  const expand = (rows) => {
    // rows: [ [cases, minLevel, spell], ... ]; a switch on number_bits(4)
    const table = new Array(16);
    let fallback = null;
    for (const [cases, minLevel, name] of rows) {
      if (cases === 'default') fallback = [minLevel, name];
      else for (const c of cases) table[c] = [minLevel, name];
    }
    for (let i = 0; i < 16; i++) if (!table[i]) table[i] = fallback;
    return table;
  };
  const MAGE = expand([
    [[0], 0, 'blindness'], [[1], 3, 'chill touch'], [[2], 7, 'weaken'], [[3], 8, 'teleport'],
    [[4], 11, 'colour spray'], [[5], 12, 'change sex'], [[6], 13, 'energy drain'],
    [[7, 8, 9], 15, 'fireball'], ['default', 20, 'acid blast'],
  ]);
  const CLERIC = expand([
    [[0], 0, 'blindness'], [[1], 3, 'cause serious'], [[2], 7, 'earthquake'], [[3], 9, 'cause critical'],
    [[4], 10, 'dispel evil'], [[5], 12, 'curse'], [[6], 12, 'change sex'], [[7], 13, 'flamestrike'],
    [[8, 9, 10], 15, 'harm'], ['default', 16, 'dispel magic'],
  ]);
  const UNDEAD = expand([
    [[0], 0, 'curse'], [[1], 3, 'weaken'], [[2], 6, 'chill touch'], [[3], 9, 'blindness'],
    [[4], 12, 'poison'], [[5], 15, 'energy drain'], [[6], 18, 'harm'], [[7], 21, 'teleport'],
    ['default', 24, 'gate'],
  ]);

  function caster(table) {
    return (slot, ch) => {
      if (ch.position !== POS.FIGHTING) return false;
      const victim = foe(ch);
      if (!victim) return false;
      const sp = SPELL[pick(ch, table)];
      invoke(sp, ch.level, ch, victim, { source: 'spec' });
      return true;
    };
  }

  /** special.c: dragon. */
  function dragon(name) {
    return (slot, ch) => {
      if (ch.position !== POS.FIGHTING) return false;
      const victim = foe(ch);
      if (!victim) return false;
      invoke(SPELL[name], ch.level, ch, victim, { source: 'breath' });
      return true;
    };
  }

  const ADEPT = [
    ['tehctah', 'armor'], ['nhak', 'bless'], ['yeruf', 'cure blindness'],
    ['garf', 'cure light'], ['rozar', 'cure poison'], ['nadroj', 'refresh'],
  ];

  const SPECS = {
    spec_cast_mage: caster(MAGE),
    spec_cast_cleric: caster(CLERIC),
    spec_cast_undead: caster(UNDEAD),
    spec_cast_judge: (slot, ch) => {
      if (ch.position !== POS.FIGHTING) return false;
      const victim = foe(ch);
      if (!victim) return false;
      invoke(SPELL['high explosive'], ch.level, ch, victim, { source: 'spec' });
      return true;
    },
    spec_cast_adept: (slot, ch) => {
      if (!isAwake(ch)) return false;
      let victim = null;
      for (const vch of deps.people(ch, ROOM_REACH)) {
        if (vch !== ch && rng.bits(1) === 0) { victim = vch; break; }
      }
      if (!victim) return false;
      const n = rng.bits(3);
      if (n >= ADEPT.length) return false;
      const [word, name] = ADEPT[n];
      const words = `${Name(ch)} utters the word${n >= 4 ? 's' : ''} '${word}'.`;
      toRoom(ch, words, 'faint');
      invoke(SPELL[name], ch.level, ch, victim, { source: 'spec' });
      return true;
    },
    spec_breath_any: (slot, ch) => {
      if (ch.position !== POS.FIGHTING) return false;
      switch (rng.bits(3)) {
        case 0: return SPECS.spec_breath_fire(slot, ch);
        case 1: case 2: return SPECS.spec_breath_lightning(slot, ch);
        case 3: return SPECS.spec_breath_gas(slot, ch);
        case 4: return SPECS.spec_breath_acid(slot, ch);
        default: return SPECS.spec_breath_frost(slot, ch);
      }
    },
    spec_breath_acid: dragon('acid breath'),
    spec_breath_fire: dragon('fire breath'),
    spec_breath_frost: dragon('frost breath'),
    spec_breath_lightning: dragon('lightning breath'),
    spec_breath_gas: (slot, ch) => {
      if (ch.position !== POS.FIGHTING) return false;
      invoke(SPELL['gas breath'], ch.level, ch, null, { source: 'breath' });
      return true;
    },
    spec_poison: (slot, ch) => {
      const victim = ch.fighting;
      if (ch.position !== POS.FIGHTING || !victim || rng.percent() > 2 * ch.level) return false;
      toChar(victim, `${Name(ch)} bites you!`, 'them');
      toRoom(ch, `${Name(ch)} bites ${nameOf(victim)}!`);
      invoke(SPELL.poison, ch.level, ch, victim, { source: 'bite' });
      return true;
    },
  };

  /** Put these spec_funs into game.js's spec_lookup table. */
  function install(table) {
    for (const [name, fn] of Object.entries(SPECS)) table[name] = fn;
  }

  // -------------------------------------------------------- char_update --

  /**
   * update.c: char_update's affect loop and the poison after it, for one
   * character. Called once a tick for the player and every woken mobile.
   */
  function tick(ch) {
    if (!ch.affected || !ch.affected.length) {
      if (!(ch.affectedBy & AFF.POISON)) return;
    } else {
      const list = ch.affected.slice();
      list.forEach((paf, i) => {
        if (paf.duration > 0) { paf.duration -= 1; return; }
        if (paf.duration < 0) return;
        const next = list[i + 1];
        if (!next || next.type !== paf.type || next.duration > 0) {
          const sp = SPELL[paf.type];
          if (sp && sp.msgOff) toChar(ch, sp.msgOff, 'faint');
        }
        affectRemove(ch, paf);
      });
    }
    if (ch.affectedBy & AFF.POISON) {
      toRoom(ch, `${Name(ch)} shivers and suffers.`);
      toChar(ch, 'You shiver and suffer.', 'them');
      emit({ kind: 'suffer', from: slotOf(ch), fromPlayer: ch === player, ...sides(ch, null) });
      deps.damage(ch, ch, 2, 'poison', ctx);
    }
  }

  /** fight.c: raw_kill for a player -- every affect goes, and affected_by with them. */
  function stripAll(ch) {
    ensureMagic(ch);
    while (ch.affected.length) affectRemove(ch, ch.affected[0]);
    ch.affectedBy = 0;
  }

  /** The spell being run now, if any, for anyone who wants to see the picture. */
  function pendingFor(ch) {
    return pending.filter((p) => p.ch === ch).map((p) => ({ id: p.id, spell: p.sp.name, released: p.released }));
  }

  return {
    cast, known, invoke, update, tick, install, stripAll, pendingFor,
    quaff, recite, zap, brandish, eatPill, useItem, itemVerb, wantsObject, objCastSpell,
    /** Call a spell_fun directly and now, the way the harness measures balance. */
    now(name, level, ch, vo) {
      const sp = SPELL[name];
      if (!sp || !FUN[name]) throw new Error(`magic.js: no spell called '${name}'`);
      run({ id: nextId++, sp, level, ch, vo, source: 'direct', offensiveCast: false });
    },
    get wait() { return wait; },
    set wait(v) { wait = v; },
    /** game.js `bind`: whose turn it is, and their WAIT_STATE with it. */
    bindPlayer,
    /** A player gone from the world: nothing more to count down for them. */
    forget(ch) { waits.delete(ch); },
    specs: SPECS,
    SPELL, SPELLS,
  };
}

/** handler.c: affect_loc_name, for identify. */
function affectLocName(location) {
  return ({
    1: 'strength', 2: 'dexterity', 3: 'intelligence', 4: 'wisdom', 5: 'constitution', 6: 'sex',
    12: 'mana', 13: 'hp', 14: 'moves', 17: 'armor class', 18: 'hit roll', 19: 'damage roll',
    20: 'save vs paralysis', 21: 'save vs rod', 22: 'save vs petrification', 23: 'save vs breath', 24: 'save vs spell',
  })[location] || 'unknown';
}
