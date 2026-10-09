/**
 * save.c: the player file, in localStorage instead of player/<Name>.
 *
 * fwrite_char and fwrite_obj write what a character *is* -- stats as they
 * stand with the gear on, the gear with its wear locations, the skills, the
 * conditions, the affects, the room -- and fread_* put it back without
 * re-running equip_char, because the saved numbers already include it. That
 * is what this does too, as JSON.
 *
 * Two things are not the mud's:
 *   - DIVERGES: save_char_obj refuses anyone under level 2. A browser has no
 *     disk to keep clean of throwaway characters, and a "continue" that only
 *     appears after the first level would be a strange promise.
 *   - One character, one slot: there is no name to key the file on.
 *
 * Runs under node: pass anything with getItem/setItem/removeItem as `storage`.
 */

export const SAVE_KEY = 'diku3d.player.v1';

/** The fields of a character that are the character. */
const FIELDS = [
  'class', 'className', 'sex', 'level', 'exp', 'alignment', 'gold', 'practice', 'armor', 'hitroll',
  'damroll', 'position', 'hit', 'maxHit', 'mana', 'maxMana', 'move', 'maxMove',
  'permStr', 'permInt', 'permWis', 'permDex', 'permCon', 'modStr', 'modInt', 'modWis', 'modDex', 'modCon',
  'wimpy', 'act', 'affectedBy', 'displayName',
];

/** fwrite_obj: an object and, nested, what is in it. */
function writeObj(obj) {
  return {
    vnum: obj.vnum, name: obj.name, keywords: obj.keywords, description: obj.description,
    itemType: obj.itemType, extraFlags: obj.extraFlags, wearFlags: obj.wearFlags,
    values: obj.values.slice(), weight: obj.weight, cost: obj.cost, level: obj.level,
    wearLoc: obj.wearLoc, timer: obj.timer,
    contains: (obj.contains || []).map(writeObj),
  };
}

/** fread_obj: back onto its prototype, when the area that defines it is loaded. */
function readObj(data, world) {
  const proto = world.objProtos.get(data.vnum) || null;
  return {
    proto, ...data,
    values: data.values.slice(),
    affects: proto ? proto.affects || [] : [],
    contains: (data.contains || []).map((inner) => readObj(inner, world)),
    inRoom: null, at: null,
  };
}

export function serialize(state) {
  const out = { version: 1, savedAt: Date.now() };
  for (const field of FIELDS) out[field] = state[field];
  out.room = state.roomVnum;
  out.learned = { ...state.learned };
  out.condition = state.condition.slice();
  out.affected = (state.affected || []).map((af) => ({ ...af }));
  out.inventory = state.inventory.map(writeObj);
  out.equipment = state.equipment.map((obj) => (obj ? writeObj(obj) : null));
  return out;
}

/**
 * fread_char onto a live character. Returns the saved room, which the caller
 * puts the camera in (char_to_room). A character saved mid-fight wakes up
 * standing: there is nobody left to be fighting.
 */
export function restore(state, data, world, POS) {
  if (!data || data.version !== 1) throw new Error('save.js: not a version 1 player file');
  for (const field of FIELDS) if (data[field] !== undefined) state[field] = data[field];
  state.learned = { ...state.learned, ...data.learned };
  state.condition = data.condition.slice();
  state.affected = data.affected.map((af) => ({ ...af }));
  state.inventory = data.inventory.map((obj) => readObj(obj, world));
  state.equipment = data.equipment.map((obj) => (obj ? readObj(obj, world) : null));
  state.fighting = null;
  state.wait = 0;
  if (state.position === POS.FIGHTING || state.position < POS.SLEEPING) state.position = POS.STANDING;
  return data.room;
}

/**
 * The saved character, or null, read without a game: the title offers
 * "continue" before the world it would continue in has been built.
 */
export function peekSave(storage) {
  const raw = storage.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data && data.version === 1 ? data : null;
  } catch (error) {
    throw new Error(`save.js: the saved character does not parse: ${error.message}`);
  }
}

/**
 * Puts `save`, `quit` and `loadSave` on the game. `onRestore(room)` moves the
 * body; `now` is for the autosave clock.
 */
export function installSave(game, { world, storage, onRestore = null }) {
  const { state, MERC } = game;

  function save() {
    if (state.position === MERC.POS.DEAD) return { ok: false, text: 'Lie still; you are DEAD.' };
    storage.setItem(SAVE_KEY, JSON.stringify(serialize(state)));
    return { ok: true, text: 'Ok.' };
  }

  const peek = () => peekSave(storage);

  function loadSave() {
    const data = peek();
    if (!data) return false;
    const room = restore(state, data, world, MERC.POS);
    if (onRestore) onRestore(room);
    return true;
  }

  /** act_comm.c: do_quit -- the verse, and the save. There is nowhere to disconnect to. */
  function quit() {
    if (state.position === MERC.POS.FIGHTING) return { ok: false, text: 'No way! You are fighting.' };
    if (state.position < MERC.POS.STUNNED) return { ok: false, text: "You're not DEAD yet." };
    save();
    return {
      ok: true,
      text: 'Had I but time--as this fell sergeant, Death, / Is strict in his arrest--O, I could tell you-- / But let it be.',
    };
  }

  // Autosave: on every level, and -- char_update saving the player with the
  // oldest save each tick -- every few minutes of play.
  let lastSave = 0;
  game.listen((event) => { if (event.kind === 'level') save(); });

  Object.assign(game, {
    save, quit, loadSave,
    savedCharacter: peek,
    forgetSave: () => storage.removeItem(SAVE_KEY),
    /** Called from the frame: autosave every `every` seconds of play. */
    autosave(seconds, every = 300) {
      lastSave += seconds;
      if (lastSave < every) return false;
      lastSave = 0;
      save();
      return true;
    },
  });
}
