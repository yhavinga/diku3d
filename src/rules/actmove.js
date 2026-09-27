/**
 * The rest of act_move.c: doors and containers -- open, close, lock, unlock,
 * pick -- with keys you actually carry; standing, resting, sleeping, waking;
 * sneak, hide and visible; and train.
 *
 * Doors are the exits' own EX_CLOSED/EX_LOCKED bits (rules/world.js keeps the
 * hinges in step). A command names a door the mud's way, by direction or by
 * the exit's keyword ("gate", "grate"); the 3D world's E key names it by the
 * leaf you are looking at, which is `useDoor`.
 */

import { ITEM, EX_ISDOOR, EX_CLOSED, EX_LOCKED, EX_PICKPROOF, REVERSE_DIR, DIR_NAME } from '../are.js';
import {
  CONT, AFF, DIR_WORDS, capitalise, doorName, isName, affectStrip, affectToChar, isAffected,
} from './handler.js';

const ACT_TRAIN = 512;

export function installMove(k) {
  const { world, state, emit, game } = k;
  const { MERC } = game;
  const { POS } = MERC;
  const out = (ok, text) => ({ ok, text });
  const exitOf = (vnum, dir) => world.rooms.get(vnum)?.exits[dir] || null;
  const learned = (key) => state.learned[key] || 0;

  /** act_move.c: has_key -- anything carried, worn included, with the key's vnum. */
  const hasKey = (key) => key > 0 && (state.inventory.some((o) => o.vnum === key)
    || state.equipment.some((o) => o && o.vnum === key));

  /**
   * act_move.c: find_door -- a direction, or the keyword of a door in the room
   * you are standing in. Returns the direction or `{ error }`.
   */
  function findDoor(arg, vnum = state.roomVnum) {
    const room = world.rooms.get(vnum);
    if (!room) return { error: 'You are completely lost.' };
    let dir = DIR_WORDS.findIndex(([s, l]) => arg === s || arg === l);
    if (dir < 0) {
      dir = room.exits.findIndex((e) => e && (e.locks & EX_ISDOOR) && e.keyword && isName(arg, e.keyword));
      if (dir < 0) return { error: `I see no ${arg} here.` };
      return { dir };
    }
    const exit = room.exits[dir];
    if (!exit) return { error: `I see no door ${arg} here.` };
    if (!(exit.locks & EX_ISDOOR)) return { error: "You can't do that." };
    return { dir };
  }

  /** "The gate opens." for whoever stands on the far side: you, if you do. */
  function otherSide(vnum, dir, verb) {
    const exit = exitOf(vnum, dir);
    const back = exit && exitOf(exit.to, REVERSE_DIR[dir]);
    if (back && back.to === vnum && state.roomVnum === exit.to) {
      emit({ kind: 'note', text: `The ${doorName(back.keyword)} ${verb}.` });
    }
  }

  // -------------------------------------------------------------- doors --
  // Each takes the room it is done from, so a mobile (spec_mayor) can use
  // them as well: `who` is the doer's name for the room, or null for you.

  function openDoor(vnum, dir, who = null) {
    const exit = exitOf(vnum, dir);
    if (!exit || !(exit.locks & EX_ISDOOR)) return out(false, "You can't do that.");
    if (!(exit.locks & EX_CLOSED)) return out(false, "It's already open.");
    if (exit.locks & EX_LOCKED) return out(false, "It's locked.");
    k.setExitFlags(vnum, dir, 0, EX_CLOSED, 'open');
    announce(vnum, dir, who, 'opens', 'Ok.');
    otherSide(vnum, dir, 'opens');
    return out(true, 'Ok.');
  }

  function closeDoor(vnum, dir, who = null) {
    const exit = exitOf(vnum, dir);
    if (!exit || !(exit.locks & EX_ISDOOR)) return out(false, "You can't do that.");
    if (exit.locks & EX_CLOSED) return out(false, "It's already closed.");
    k.setExitFlags(vnum, dir, EX_CLOSED, 0, 'close');
    announce(vnum, dir, who, 'closes', 'Ok.');
    otherSide(vnum, dir, 'closes');
    return out(true, 'Ok.');
  }

  function lockDoor(vnum, dir, who = null, key = hasKey) {
    const exit = exitOf(vnum, dir);
    if (!exit || !(exit.locks & EX_ISDOOR)) return out(false, "You can't do that.");
    if (!(exit.locks & EX_CLOSED)) return out(false, "It's not closed.");
    if (exit.key < 0) return out(false, "It can't be locked.");
    if (!key(exit.key)) return out(false, 'You lack the key.');
    if (exit.locks & EX_LOCKED) return out(false, "It's already locked.");
    k.setExitFlags(vnum, dir, EX_LOCKED, 0, 'lock');
    announce(vnum, dir, who, 'locks', '*Click*');
    return out(true, '*Click*');
  }

  function unlockDoor(vnum, dir, who = null, key = hasKey) {
    const exit = exitOf(vnum, dir);
    if (!exit || !(exit.locks & EX_ISDOOR)) return out(false, "You can't do that.");
    if (!(exit.locks & EX_CLOSED)) return out(false, "It's not closed.");
    if (exit.key < 0) return out(false, "It can't be unlocked.");
    if (!key(exit.key)) return out(false, 'You lack the key.');
    if (!(exit.locks & EX_LOCKED)) return out(false, "It's already unlocked.");
    k.setExitFlags(vnum, dir, 0, EX_LOCKED, 'unlock');
    announce(vnum, dir, who, 'unlocks', '*Click*');
    return out(true, '*Click*');
  }

  /**
   * act_move.c: do_pick, for a door: a guard more than five levels over you
   * standing in the room stops you, then the skill roll, then the lock.
   */
  function pickDoor(vnum, dir) {
    const guard = guardByLock();
    if (guard) return out(false, guard);
    state.wait = Math.max(state.wait, 12);
    if (k.rng.percent() > learned('pickLock')) return failPick();
    const exit = exitOf(vnum, dir);
    if (!(exit.locks & EX_CLOSED)) return out(false, "It's not closed.");
    if (exit.key < 0) return out(false, "It can't be picked.");
    if (!(exit.locks & EX_LOCKED)) return out(false, "It's already unlocked.");
    if (exit.locks & EX_PICKPROOF) return failPick();
    k.setExitFlags(vnum, dir, 0, EX_LOCKED, 'pick');
    emit({ kind: 'pick', text: '*Click*', ok: true });
    return out(true, '*Click*');
  }

  function failPick() {
    emit({ kind: 'pick', text: 'You failed.', ok: false });
    return out(false, 'You failed.');
  }

  function guardByLock() {
    for (const slot of k.mobsNear(k.position, 9)) {
      const mob = slot.instance;
      if (mob && MERC.isAwake(mob) && state.level + 5 < mob.level) {
        return `${capitalise(mob.name)} is standing too close to the lock.`;
      }
    }
    return null;
  }

  /** "Ok." to you, "$n opens the $d." to the room -- and the gate's name in the log either way. */
  function announce(vnum, dir, who, verb, reply) {
    const exit = exitOf(vnum, dir);
    const name = doorName(exit.keyword);
    if (who) k.toRoom(who, `${capitalise(who.proto.short)} ${verb} the ${name}.`, { kind: 'door', dir, vnum });
    else emit({ kind: 'door', text: `You ${verb.replace(/s$/, '')} the ${name}. ${reply === 'Ok.' ? '' : reply}`.trim(), dir, vnum, verb });
  }

  // --------------------------------------------------------- containers --

  function containerCheck(obj) {
    if (obj.itemType !== ITEM.CONTAINER) return "That's not a container.";
    return null;
  }

  function openObj(obj) {
    const bad = containerCheck(obj);
    if (bad) return out(false, bad);
    const v = obj.values[1];
    if (!(v & CONT.CLOSED)) return out(false, "It's already open.");
    if (!(v & CONT.CLOSEABLE)) return out(false, "You can't do that.");
    if (v & CONT.LOCKED) return out(false, "It's locked.");
    obj.values[1] &= ~CONT.CLOSED;
    emit({ kind: 'container', text: `You open ${obj.name}.`, verb: 'open', at: obj.at, item: obj.name });
    return out(true, 'Ok.');
  }

  function closeObj(obj) {
    const bad = containerCheck(obj);
    if (bad) return out(false, bad);
    const v = obj.values[1];
    if (v & CONT.CLOSED) return out(false, "It's already closed.");
    if (!(v & CONT.CLOSEABLE)) return out(false, "You can't do that.");
    obj.values[1] |= CONT.CLOSED;
    emit({ kind: 'container', text: `You close ${obj.name}.`, verb: 'close', at: obj.at, item: obj.name });
    return out(true, 'Ok.');
  }

  function lockObj(obj) {
    const bad = containerCheck(obj);
    if (bad) return out(false, bad);
    const v = obj.values[1];
    if (!(v & CONT.CLOSED)) return out(false, "It's not closed.");
    if (obj.values[2] < 0) return out(false, "It can't be locked.");
    if (!hasKey(obj.values[2])) return out(false, 'You lack the key.');
    if (v & CONT.LOCKED) return out(false, "It's already locked.");
    obj.values[1] |= CONT.LOCKED;
    emit({ kind: 'container', text: '*Click*', verb: 'lock', at: obj.at, item: obj.name });
    return out(true, '*Click*');
  }

  function unlockObj(obj) {
    const bad = containerCheck(obj);
    if (bad) return out(false, bad);
    const v = obj.values[1];
    if (!(v & CONT.CLOSED)) return out(false, "It's not closed.");
    if (obj.values[2] < 0) return out(false, "It can't be unlocked.");
    if (!hasKey(obj.values[2])) return out(false, 'You lack the key.');
    if (!(v & CONT.LOCKED)) return out(false, "It's already unlocked.");
    obj.values[1] &= ~CONT.LOCKED;
    emit({ kind: 'container', text: '*Click*', verb: 'unlock', at: obj.at, item: obj.name });
    return out(true, '*Click*');
  }

  function pickObj(obj) {
    const guard = guardByLock();
    if (guard) return out(false, guard);
    state.wait = Math.max(state.wait, 12);
    if (k.rng.percent() > learned('pickLock')) return failPick();
    const bad = containerCheck(obj);
    if (bad) return out(false, bad);
    const v = obj.values[1];
    if (!(v & CONT.CLOSED)) return out(false, "It's not closed.");
    if (obj.values[2] < 0) return out(false, "It can't be unlocked.");
    if (!(v & CONT.LOCKED)) return out(false, "It's already unlocked.");
    if (v & CONT.PICKPROOF) return failPick();
    obj.values[1] &= ~CONT.LOCKED;
    emit({ kind: 'pick', text: '*Click*', ok: true, at: obj.at });
    return out(true, '*Click*');
  }

  /**
   * The 3D world's one verb for a door: E on the leaf. Shut and locked with
   * the key on you, it is `unlock` then `open`, which is what the mayor's
   * 'O' does; shut and locked without it, the mud's refusal, and what would
   * get you through; open, it is `close`.
   */
  function useDoor(vnum, dir) {
    // Whichever side of it you are on is the side you act from.
    const exit = exitOf(vnum, dir);
    if (exit && state.roomVnum === exit.to && exitOf(exit.to, REVERSE_DIR[dir])?.to === vnum) {
      dir = REVERSE_DIR[dir];
      vnum = exit.to;
    }
    const e = exitOf(vnum, dir);
    if (!e) return out(false, 'Nothing to open there.');
    const name = doorName(e.keyword);
    if (!(e.locks & EX_CLOSED)) return closeDoor(vnum, dir);
    if (e.locks & EX_LOCKED) {
      if (!hasKey(e.key)) {
        const how = e.key <= 0 ? 'and has no keyhole' : (learned('pickLock') > 0 ? `-- the key, or pick it (${game.skillKey ? game.skillKey('pickLock') : 'pick'})` : '-- you need its key');
        const text = `The ${name} is locked ${how}.`;
        emit({ kind: 'locked', text, vnum, dir, key: e.key });
        return out(false, text);
      }
      unlockDoor(vnum, dir);
    }
    return openDoor(vnum, dir);
  }

  // ---------------------------------------------------------- positions --

  const POS_BLOCK = {
    [POS.DEAD]: 'Lie still; you are DEAD.', [POS.MORTAL]: 'You are hurt far too bad for that.',
    [POS.INCAP]: 'You are hurt far too bad for that.', [POS.STUNNED]: 'You are too stunned to do that.',
  };

  function stand() {
    switch (state.position) {
      case POS.SLEEPING:
        if (isAffected(state, AFF.SLEEP)) return out(false, "You can't wake up!");
        state.position = POS.STANDING;
        emit({ kind: 'position', text: 'You wake and stand up.', position: 'standing' });
        return out(true, 'You wake and stand up.');
      case POS.RESTING:
        state.position = POS.STANDING;
        emit({ kind: 'position', text: 'You stand up.', position: 'standing' });
        return out(true, 'You stand up.');
      case POS.STANDING: return out(false, 'You are already standing.');
      case POS.FIGHTING: return out(false, 'You are already fighting!');
      default: return out(false, POS_BLOCK[state.position]);
    }
  }

  function rest() {
    switch (state.position) {
      case POS.SLEEPING: return out(false, 'You are already sleeping.');
      case POS.RESTING: return out(false, 'You are already resting.');
      case POS.STANDING:
        state.position = POS.RESTING;
        emit({ kind: 'position', text: 'You rest.', position: 'resting' });
        return out(true, 'You rest.');
      case POS.FIGHTING: return out(false, 'You are already fighting!');
      default: return out(false, POS_BLOCK[state.position]);
    }
  }

  function sleep() {
    switch (state.position) {
      case POS.SLEEPING: return out(false, 'You are already sleeping.');
      case POS.RESTING: case POS.STANDING:
        state.position = POS.SLEEPING;
        emit({ kind: 'position', text: 'You sleep.', position: 'sleeping' });
        return out(true, 'You sleep.');
      case POS.FIGHTING: return out(false, 'You are already fighting!');
      default: return out(false, POS_BLOCK[state.position]);
    }
  }

  /** The R key: rest, and R again to stand. */
  function toggleRest() {
    if (state.position === POS.RESTING || state.position === POS.SLEEPING) return stand();
    return rest();
  }

  // ----------------------------------------------------- sneak and hide --

  /** do_sneak: an affect lasting your level in ticks, if the roll takes. */
  function sneak() {
    emit({ kind: 'skill', skill: 'sneak', text: 'You attempt to move silently.' });
    affectStrip(state, 'sneak');
    state.wait = Math.max(state.wait, 12);
    if (k.rng.percent() < learned('sneak')) {
      affectToChar(state, { type: 'sneak', duration: state.level, bitvector: AFF.SNEAK });
    }
    return out(true, 'You attempt to move silently.');
  }

  /**
   * do_hide: AFF_HIDE if the roll takes. interp.c strips it on any command;
   * here moving off the spot does too (see `update`), since walking is not a
   * command. You are not told whether it worked -- the mud never says.
   */
  function hide() {
    emit({ kind: 'skill', skill: 'hide', text: 'You attempt to hide.' });
    state.affectedBy &= ~AFF.HIDE;
    state.wait = Math.max(state.wait, 12);
    if (k.rng.percent() < learned('hide')) {
      state.affectedBy |= AFF.HIDE;
      hiddenAt = { x: k.position.x, z: k.position.z };
    }
    return out(true, 'You attempt to hide.');
  }
  let hiddenAt = null;

  function visible() {
    affectStrip(state, 'invis');
    affectStrip(state, 'mass invis');
    affectStrip(state, 'sneak');
    state.affectedBy &= ~(AFF.HIDE | AFF.INVISIBLE | AFF.SNEAK);
    emit({ kind: 'note', text: 'Ok.' });
    return out(true, 'Ok.');
  }

  // -------------------------------------------------------------- train --

  const STATS = {
    str: ['permStr', 'strength', 1], int: ['permInt', 'intelligence', 3], wis: ['permWis', 'wisdom', 4],
    dex: ['permDex', 'dexterity', 2], con: ['permCon', 'constitution', 5],
  };

  /** do_train: at a trainer, five practices a point (three for your prime), to 18. */
  function trainerHere() {
    return k.mobsNear(k.position, 9).find((slot) => slot.proto.act & ACT_TRAIN) || null;
  }

  function train(stat) {
    if (!trainerHere()) return out(false, "You can't do that here.");
    const entry = STATS[stat];
    if (!entry) {
      const can = Object.keys(STATS).filter((s) => state[STATS[s][0]] < 18);
      return out(false, can.length ? `You have ${state.practice} practice sessions. You can train: ${can.join(' ')}.`
        : `You have nothing left to train, you ${state.sex === 1 ? 'big stud' : state.sex === 2 ? 'hot babe' : 'wild thing'}!`);
    }
    const [field, word, apply] = entry;
    const cost = MERC.CLASS_TABLE[state.class].attrPrime === apply ? 3 : 5;
    if (state[field] >= 18) return out(false, `Your ${word} is already at maximum.`);
    if (cost > state.practice) return out(false, "You don't have enough practices.");
    state.practice -= cost;
    state[field] += 1;
    emit({ kind: 'practice', text: `Your ${word} increases!`, skill: word });
    return out(true, `Your ${word} increases!`);
  }

  function trainable() {
    const trainer = trainerHere();
    return Object.entries(STATS).map(([key, [field, word, apply]]) => ({
      key, word, value: state[field],
      cost: MERC.CLASS_TABLE[state.class].attrPrime === apply ? 3 : 5,
      trainer: !!trainer,
    }));
  }

  // -------------------------------------------------------------- frame --

  /** Walking off the spot you hid on gives you away, as a typed command would. */
  function update() {
    if (!hiddenAt || !(state.affectedBy & AFF.HIDE)) { hiddenAt = null; return; }
    if (Math.hypot(k.position.x - hiddenAt.x, k.position.z - hiddenAt.z) > 1.2) {
      state.affectedBy &= ~AFF.HIDE;
      hiddenAt = null;
    }
  }
  k.rules.moveUpdate = update;

  Object.assign(k, { hasKey, findDoor, openDoor, closeDoor, lockDoor, unlockDoor });
  Object.assign(game, {
    findDoor, openDoor, closeDoor, lockDoor, unlockDoor, pickDoor, useDoor,
    openObj, closeObj, lockObj, unlockObj, pickObj, hasKey,
    stand, rest: toggleRest, sit: rest, sleep, sneak, hide, visible, train, trainable, trainerHere,
    /** The door you face: its state in the mud's words, for the look prompt. */
    doorState(vnum, dir) {
      const e = exitOf(vnum, dir);
      if (!e) return null;
      return {
        name: doorName(e.keyword), closed: !!(e.locks & EX_CLOSED), locked: !!(e.locks & EX_LOCKED),
        pickproof: !!(e.locks & EX_PICKPROOF), key: e.key, haveKey: hasKey(e.key), dir: DIR_NAME[dir],
      };
    },
  });
}
