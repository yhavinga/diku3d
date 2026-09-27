/**
 * special.c's spec_funs that are not spells: guard, janitor, fido, thief,
 * executioner and the mayor. magic.js registers the casters, breathers and
 * poisoners into the same table, `game.specFuns[name] = fn(slot, mob)`,
 * returning true if the mobile acted -- which, as in update.c, ends its turn.
 *
 * "In the room" is the mud's; what the room sees is the viewer's. A janitor
 * does not conjure the litter into its pocket -- it walks over and bends down
 * -- and fido crosses the room to the corpse. The rule fires when the mud's
 * would; the body carries it out, and the effect lands when it gets there.
 */

import { ITEM } from '../are.js';
import { AFF, PLR, ITEM_TAKE, capitalise, canSee, isAffected, doorName } from './handler.js';

const MOB_VNUM_CITYGUARD = 3060;
const LEVEL_IMMORTAL = 37;

export function installSpecials(k) {
  const { state, ground, mobs, emit, game, SPEC_FUNS } = k;
  const { MERC } = game;
  const { POS, isAwake } = MERC;

  /** Everyone in a mobile's room: you (if you are there) and the other mobiles. */
  function people(slot) {
    const list = mobs.filter((s) => s !== slot && !s.dead && s.instance && s.roomVnum === slot.roomVnum)
      .map((s) => s.instance);
    if (state.roomVnum === slot.roomVnum || near(slot)) list.unshift(state);
    return list;
  }
  const near = (slot) => Math.hypot(slot.pos.x - k.position.x, slot.pos.z - k.position.z) < 10;

  const says = (slot, text) => {
    emit({ kind: 'mobsay', slot, speaker: slot.proto.short, said: text,
      text: `${capitalise(slot.proto.short)} says '${text}'`, heard: state.roomVnum === slot.roomVnum || near(slot) });
  };
  const emotes = (slot, text) => {
    emit({ kind: 'emote', slot, speaker: slot.proto.short, said: null,
      text: `${capitalise(slot.proto.short)} ${text}`, heard: state.roomVnum === slot.roomVnum || near(slot) });
  };
  const shouts = (slot, text) => {
    // do_shout reaches every player in the world who is awake.
    emit({ kind: 'mobsay', slot, speaker: slot.proto.short, said: text, shout: true,
      text: `${capitalise(slot.proto.short)} shouts '${text}'`, heard: true });
  };

  /** One round of multi_hit, timed as the aggressive mobiles' first swing is. */
  function attack(slot, victim) {
    const there = victim === state ? k.position : victim.slot.pos;
    if (Math.hypot(there.x - slot.pos.x, there.z - slot.pos.z) > 3.2) {
      // DIVERGES as aggr_update does: from across the room, it takes the
      // fight up and closes; the violence pulse swings once it is there.
      k.ctx.setFighting(slot.instance, victim);
      if (!victim.fighting) k.ctx.setFighting(victim, slot.instance);
      return;
    }
    k.ctx.round = { player: 0, npc: 0.5 };
    try { k.multiHit(slot.instance, victim); } finally { k.ctx.round = null; k.ctx.now = undefined; }
  }

  // ---------------------------------------------------------- spec_guard --

  /**
   * A KILLER or THIEF in the room is shouted down and attacked; failing that,
   * whoever is fighting someone other than the guard and is the most evil of
   * them (alignment under 300) is set upon. Fight a beggar in front of the
   * Watch while you are more evil than the beggar, and it is you.
   */
  SPEC_FUNS.spec_guard = (slot, ch) => {
    if (!isAwake(ch) || ch.fighting) return false;
    let maxEvil = 300;
    let ech = null;
    for (const victim of people(slot)) {
      if (victim === state && (state.act & (PLR.KILLER | PLR.THIEF))) {
        shouts(slot, `${capitalise(state.name)} is a ${state.act & PLR.KILLER ? 'KILLER' : 'THIEF'}!  PROTECT THE INNOCENT!!  BANZAI!!`);
        attack(slot, state);
        return true;
      }
      if (victim.fighting && victim.fighting !== ch && victim.alignment < maxEvil) {
        maxEvil = victim.alignment;
        ech = victim;
      }
    }
    if (!ech || !canSee(ch, ech)) return false;
    emotes(slot, "screams 'PROTECT THE INNOCENT!!  BANZAI!!");
    attack(slot, ech);
    return true;
  };

  // ------------------------------------------------------ spec_executioner --

  /**
   * As the guard, for KILLERs and THIEVES only, and with two cityguards
   * summoned into the room. In one-player Merc neither flag can ever be set --
   * check_killer skips NPC victims and a failed steal from one sets no THIEF --
   * so this watches the temple for the thing that never happens, as the
   * mud's does. The summons are marked for whoever makes those flags reachable.
   */
  SPEC_FUNS.spec_executioner = (slot, ch) => {
    if (!isAwake(ch) || ch.fighting) return false;
    if (!people(slot).includes(state) || !(state.act & (PLR.KILLER | PLR.THIEF))) return false;
    shouts(slot, `${capitalise(state.name)} is a ${state.act & PLR.KILLER ? 'KILLER' : 'THIEF'}!  PROTECT THE INNOCENT!  MORE BLOOOOD!!!`);
    attack(slot, state);
    if (k.summon) { k.summon(MOB_VNUM_CITYGUARD, slot.roomVnum); k.summon(MOB_VNUM_CITYGUARD, slot.roomVnum); }
    return true;
  };

  // --------------------------------------------------------- spec_janitor --

  /**
   * Picks up trash: anything takeable that is a drink container, ITEM_TRASH,
   * or worth under ten -- which is most of what anyone drops. It walks to the
   * thing first and the pick-up lands when it gets there (and only if the
   * thing is still lying there).
   */
  SPEC_FUNS.spec_janitor = (slot, ch) => {
    if (!isAwake(ch)) return false;
    if (slot.task) return true;
    const trash = ground.find((o) => o.inRoom === slot.roomVnum && (o.wearFlags & ITEM_TAKE)
      && (o.itemType === ITEM.DRINK_CON || o.itemType === ITEM.TRASH || o.cost < 10)
      && o.itemType !== ITEM.CORPSE_NPC);
    if (!trash) return false;
    fetch(slot, trash, () => {
      k.objFromRoom(trash);
      ch.inventory.push(trash);
      k.toRoom(slot, `${capitalise(slot.proto.short)} picks up some trash.`, { kind: 'room', slot });
    });
    return true;
  };

  // ------------------------------------------------------------ spec_fido --

  /** Devours an NPC corpse in the room; what was in it is left on the floor. */
  SPEC_FUNS.spec_fido = (slot, ch) => {
    if (!isAwake(ch)) return false;
    if (slot.task) return true;
    const corpse = ground.find((o) => o.inRoom === slot.roomVnum && o.itemType === ITEM.CORPSE_NPC);
    if (!corpse) return false;
    fetch(slot, corpse, () => {
      k.toRoom(slot, `${capitalise(slot.proto.short)} savagely devours a corpse.`, { kind: 'room', slot });
      k.perform && k.perform(slot, 'attack');
      const at = corpse.at;
      const vnum = corpse.inRoom;
      k.objFromRoom(corpse);
      if (corpse.slot) { k.removeBody(corpse.slot); corpse.slot.corpse = null; }
      corpse.contains.forEach((obj, i) => {
        const a = (i / Math.max(1, corpse.contains.length)) * Math.PI * 2 + 0.7;
        k.objToRoom(obj, vnum, { x: at.x + Math.cos(a) * 0.5, y: at.y, z: at.z + Math.sin(a) * 0.5 });
      });
      corpse.contains = [];
    });
    return true;
  };

  /** Walk to `obj` and, if it is still where it was, do `then` there. */
  function fetch(slot, obj, then) {
    const at = { ...obj.at };
    slot.task = {
      kind: 'fetch',
      order: { kind: 'go', to: at },
      onArrive: () => {
        if (obj.inRoom === null || Math.hypot(obj.at.x - at.x, obj.at.z - at.z) > 0.2) return;
        if (k.perform) k.perform(slot, 'pickup');
        then();
      },
    };
  }

  // ----------------------------------------------------------- spec_thief --

  /**
   * One chance in four a mobile pulse, against whoever it can see: caught
   * with its hand in your wallet (1 in level+1), or up to a fifth of your gold
   * gone, seven eighths of it to the thief. It sidles up first -- the mud's
   * room is thirteen metres across and a purse is not -- and the dip happens
   * when it is at your elbow.
   */
  SPEC_FUNS.spec_thief = (slot, ch) => {
    if (ch.position !== POS.STANDING) return false;
    if (slot.task) return true;
    if (!people(slot).includes(state) || state.level >= LEVEL_IMMORTAL) return false;
    if (k.wanderRng.bits(2) !== 0 || !canSee(ch, state)) return false;
    const target = k.playerFeet;
    slot.task = {
      kind: 'pickpocket',
      order: { kind: 'go', to: target },
      reach: 1.4,
      onArrive: () => {
        if (ch.fighting || slot.dead) return;
        if (isAwake(state) && k.rng.range(0, ch.level) === 0) {
          emit({ kind: 'caught', slot, text: `You discover ${ch.name}'s hands in your wallet!` });
          return;
        }
        const gold = MERC.idiv(state.gold * k.rng.range(1, 20), 100);
        ch.gold += MERC.idiv(7 * gold, 8);
        state.gold -= gold;
        // The mud tells you nothing. The purse is lighter; the log says so
        // only because the number on screen would otherwise just drop.
        if (gold > 0) emit({ kind: 'stolen', slot, amount: gold, text: '' });
      },
    };
    return true;
  };

  // ----------------------------------------------------------- spec_mayor --

  /**
   * The mayor's day, character for character: wake at six (or twenty), walk
   * the city by the path below, open (or close) the two gates with the City
   * Key he wears, say his lines, go home and sleep. 0-3 are moves; the
   * letters are the speeches and the gate business. In a fight he casts as a
   * cleric, which is magic.js's spec_cast_cleric.
   */
  const OPEN_PATH = 'W3a3003b33000c111d0d111Oe333333Oe22c222112212111a1S.';
  const CLOSE_PATH = 'W3a3003b33000c111d0d111CE333333CE22c222112212111a1S.';
  const mayor = { path: null, pos: 0, move: false };

  SPEC_FUNS.spec_mayor = (slot, ch) => {
    const hour = k.weather().hour;
    if (!mayor.move) {
      if (hour === 6) { mayor.path = OPEN_PATH; mayor.move = true; mayor.pos = 0; }
      if (hour === 20) { mayor.path = CLOSE_PATH; mayor.move = true; mayor.pos = 0; }
    }
    if (ch.fighting) return SPEC_FUNS.spec_cast_cleric ? SPEC_FUNS.spec_cast_cleric(slot, ch) : false;
    if (!mayor.move || ch.position < POS.SLEEPING) return false;
    const c = mayor.path[mayor.pos];
    switch (c) {
      case '0': case '1': case '2': case '3':
        k.moveMobile(slot, Number(c));
        break;
      case 'W':
        ch.position = POS.STANDING;
        emotes(slot, 'awakens and groans loudly.');
        break;
      case 'S':
        ch.position = POS.SLEEPING;
        emotes(slot, 'lies down and falls asleep.');
        break;
      case 'a': says(slot, 'Hello Honey!'); break;
      case 'b': says(slot, 'What a view!  I must do something about that dump!'); break;
      case 'c': says(slot, 'Vandals!  Youngsters have no respect for anything!'); break;
      case 'd': says(slot, 'Good day, citizens!'); break;
      case 'e': says(slot, 'I hereby declare the city of Midgaard open!'); break;
      case 'E': says(slot, 'I hereby declare the city of Midgaard closed!'); break;
      case 'O': gate(slot, ch, true); break;
      case 'C': gate(slot, ch, false); break;
      case '.': mayor.move = false; break;
      default: break;
    }
    mayor.pos++;
    return false;
  };

  /** do_unlock + do_open "gate" (or do_close + do_lock), with his own keys. */
  function gate(slot, ch, open) {
    const found = k.findDoor('gate', slot.roomVnum);
    if (found.error) return;
    const dir = found.dir;
    const hasKey = (key) => [...ch.inventory, ...ch.equipment].some((o) => o && o.vnum === key);
    if (open) {
      k.unlockDoor(slot.roomVnum, dir, slot, hasKey);
      k.openDoor(slot.roomVnum, dir, slot);
    } else {
      k.closeDoor(slot.roomVnum, dir, slot);
      k.lockDoor(slot.roomVnum, dir, slot, hasKey);
    }
    if (k.perform) k.perform(slot, 'pickup');
    void doorName;
  }

  // The mayor has to be up and about to keep his hours whether or not you
  // are near him: a spec_fun only runs for a mobile that has been created,
  // and this viewer creates them when first seen. Everyone with a spec_fun
  // is created at once, as db.c creates everyone.
  for (const slot of mobs) if (slot.record.special) k.wake(slot);

  Object.assign(game, {
    /** The mayor's progress through his day, for the harness and the curious. */
    mayorState: () => ({ ...mayor, next: mayor.path ? mayor.path[mayor.pos] : null }),
    setMudHour(hour) { k.weather().hour = hour; },
  });
  void isAffected; void AFF;
}
