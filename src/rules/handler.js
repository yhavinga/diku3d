/**
 * The small, shared half of handler.c and const.c that the rest of the rules
 * lean on: how a word names a thing, what an object weighs, money, the liquid
 * table, affects, and who can see whom.
 *
 * No three.js and no DOM, like game.js: the whole of it runs under plain node.
 */

import { ITEM } from '../are.js';
import { AFF, affectToChar, affectStrip, affectJoin } from '../magic.js';

// One affect system, magic.js's (handler.c's affect_to_char and friends, with
// affect_modify's applies): what this half of the port puts on a character --
// sneak, a poisoned mushroom -- goes through it and ticks with the spells.
export { AFF, affectToChar, affectStrip, affectJoin };

// ---------------------------------------------------------------- merc.h ----

/** CONT_* -- a container's value[1]. */
export const CONT = { CLOSEABLE: 1, PICKPROOF: 2, CLOSED: 4, LOCKED: 8 };

/** COND_* -- indices into pcdata->condition. */
export const COND = { DRUNK: 0, FULL: 1, THIRST: 2 };

/** PLR_* -- a player's act bits. */
export const PLR = { AUTOEXIT: 8, AUTOLOOT: 16, AUTOSAC: 32, THIEF: 4194304, KILLER: 8388608 };

/** ITEM_* extra flags. */
export const XF = {
  GLOW: 1, HUM: 2, DARK: 4, LOCK: 8, EVIL: 16, INVIS: 32, MAGIC: 64, NODROP: 128,
  BLESS: 256, ANTI_GOOD: 512, ANTI_EVIL: 1024, ANTI_NEUTRAL: 2048, NOREMOVE: 4096,
  INVENTORY: 8192,
};

export const ITEM_TAKE = 1;
export const LEVEL_IMMORTAL = 37;

/** limbo.are's fixed vnums, which db.c and fight.c create by number. */
export const OBJ_VNUM = { MONEY_ONE: 2, MONEY_SOME: 3, CORPSE_NPC: 10, CORPSE_PC: 11 };

/** const.c: liq_table -- name, colour, and what a mouthful does to [drunk, full, thirst]. */
export const LIQUIDS = [
  ['water', 'clear', [0, 1, 10]],
  ['beer', 'amber', [3, 2, 5]],
  ['wine', 'rose', [5, 2, 5]],
  ['ale', 'brown', [2, 2, 5]],
  ['dark ale', 'dark', [1, 2, 5]],
  ['whisky', 'golden', [6, 1, 4]],
  ['lemonade', 'pink', [0, 1, 8]],
  ['firebreather', 'boiling', [10, 0, 0]],
  ['local specialty', 'everclear', [3, 3, 3]],
  ['slime mold juice', 'green', [0, 4, -8]],
  ['milk', 'white', [0, 3, 6]],
  ['tea', 'tan', [0, 1, 6]],
  ['coffee', 'black', [0, 1, 6]],
  ['blood', 'red', [0, 2, -1]],
  ['salt water', 'clear', [0, 1, -2]],
  ['cola', 'cherry', [0, 1, 5]],
];

export const DIR_WORDS = [
  ['n', 'north'], ['e', 'east'], ['s', 'south'], ['w', 'west'], ['u', 'up'], ['d', 'down'],
];

// ----------------------------------------------------------------- words ----

export const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** db.c: str_prefix, the right way round: is `a` a prefix of `b`? Case-blind. */
export const isPrefix = (a, b) => b.toLowerCase().startsWith(a.toLowerCase());

/**
 * handler.c: is_name -- `str` is exactly one of the words in the name list.
 * Merc 2.1 does not match prefixes here: `get sw` finds no sword.
 */
export function isName(str, namelist) {
  if (!str || !namelist) return false;
  const want = str.toLowerCase();
  return namelist.toLowerCase().split(/\s+/).some((word) => word === want);
}

/** interp.c: one_argument -- the first word (or 'quoted phrase') and the rest. */
export function oneArgument(text) {
  let s = text.trimStart();
  let quote = ' ';
  if (s[0] === "'" || s[0] === '"') { quote = s[0]; s = s.slice(1); }
  let i = 0;
  while (i < s.length && !(quote === ' ' ? /\s/.test(s[i]) : s[i] === quote)) i++;
  const arg = s.slice(0, i).toLowerCase();
  return [arg, s.slice(i + 1).trimStart()];
}

/** interp.c: number_argument -- `2.sword` is the second sword. */
export function numberArgument(arg) {
  const dot = arg.indexOf('.');
  if (dot > 0 && /^\d+$/.test(arg.slice(0, dot))) return [Number(arg.slice(0, dot)), arg.slice(dot + 1)];
  return [1, arg];
}

/** A list search the way get_obj_list does it: `2.dagger` skips the first. */
export function findNamed(list, arg, nameOf = (x) => x.keywords) {
  const [number, name] = numberArgument(arg);
  let count = 0;
  for (const item of list) {
    if (!isName(name, nameOf(item))) continue;
    if (++count === number) return item;
  }
  return null;
}

/** act()'s $d for a door keyword: the first word, or "door". */
export const doorName = (keyword) => ((keyword || '').trim().split(/\s+/)[0] || 'door');

// --------------------------------------------------------------- objects ----

/** handler.c: get_obj_weight -- the object and everything in it. */
export function objWeight(obj) {
  let weight = obj.weight;
  for (const inner of obj.contains || []) weight += objWeight(inner);
  return weight;
}

/** handler.c: get_obj_number -- a container counts as nothing, its contents as themselves. */
export function objNumber(obj) {
  let number = obj.itemType === ITEM.CONTAINER ? 0 : 1;
  for (const inner of obj.contains || []) number += objNumber(inner);
  return number;
}

/**
 * The bare record every object shares, for the few limbo.are objects db.c and
 * fight.c make by number and which no loaded area defines.
 */
export function makeObject(fields) {
  return {
    proto: null, vnum: 0, name: '', keywords: '', description: '',
    itemType: ITEM.TRASH, extraFlags: 0, wearFlags: 0, values: [0, 0, 0, 0],
    weight: 0, cost: 0, level: 0, wearLoc: -1, affects: [], timer: 0,
    contains: [], inRoom: null, at: null,
    ...fields,
  };
}

/** handler.c: create_money, with limbo.are's #2 and #3 words. */
export function createMoney(amount) {
  if (amount <= 0) throw new Error(`createMoney: ${amount} gold is not money`);
  if (amount === 1) {
    return makeObject({
      vnum: OBJ_VNUM.MONEY_ONE, name: 'a gold coin', keywords: 'coin gold',
      description: 'One miserable gold coin.', itemType: ITEM.MONEY,
      wearFlags: ITEM_TAKE, values: [1, 0, 0, 0], weight: 1,
    });
  }
  return makeObject({
    vnum: OBJ_VNUM.MONEY_SOME, name: `${amount} gold coins`, keywords: 'coins gold',
    description: 'A pile of gold coins.', itemType: ITEM.MONEY,
    wearFlags: ITEM_TAKE, values: [amount, 0, 0, 0], weight: 1,
  });
}

/** Everything inside, depth first: what obj_update and the save walk. */
export function* nested(list) {
  for (const obj of list) {
    yield obj;
    if (obj.contains && obj.contains.length) yield* nested(obj.contains);
  }
}

// ---------------------------------------------------------------- seeing ----

/** IS_AFFECTED: a bit of affected_by (magic.js's `isAffected` asks by spell name). */
export const hasAff = (ch, bit) => ((ch.affectedBy || 0) & bit) !== 0;

/**
 * handler.c: can_see, minus what this world has no use for (wizinvis, holy
 * light, dark rooms: every room here is lit by the renderer). Hiding only
 * works across the NPC/PC line, exactly as the C has it.
 */
export function canSee(ch, victim) {
  if (ch === victim) return true;
  if (hasAff(ch, AFF.BLIND)) return false;
  if (hasAff(victim, AFF.INVISIBLE) && !hasAff(ch, AFF.DETECT_INVIS)) return false;
  if (hasAff(victim, AFF.HIDE) && !hasAff(ch, AFF.DETECT_HIDDEN)
    && !victim.fighting && (ch.npc === true) !== (victim.npc === true)) return false;
  return true;
}
