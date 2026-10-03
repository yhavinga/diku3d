/**
 * fight.c's skill commands -- kick, backstab, disarm, rescue -- and act_obj.c's
 * steal, with the WAIT_STATE each one costs, and the skill bar they live on.
 *
 * The rules are the mud's. Two things are the first-person world's own:
 *
 *   - Reach. `get_char_room` becomes "the one you are looking at, within
 *     arm's length" -- the same `facingTarget` a click uses.
 *   - A back. do_backstab wants the victim unhurt and not fighting; here it
 *     also has to have its back to you, and it turns round at footsteps
 *     (game.js `noticed`), so the way in is to sneak.
 */

import { ITEM } from '../are.js';
import { AFF, XF, capitalise, hasAff, canSee } from './handler.js';

const WEAR_WIELD = 16;
const MELEE = 3.2;
/** How it lands on screen: a kick's boot and a stab's thrust, timed like a click. */
const WINDUP = 0.28;

export function installSkills(k) {
  const { emit, game, ctx } = k;
  // Whoever's turn it is (game.js `bind`): Merc's `ch`.
  let state = k.state;
  k.onBind((ch) => { state = ch; });
  const { MERC } = game;
  const { POS, isNpc } = MERC;
  const out = (ok, text) => ({ ok, text });
  const learned = (key) => state.learned[key] || 0;
  const skillLevel = (key) => MERC.SKILLS.find((s) => s.key === key).level[state.class];

  /** The one you are looking at and could touch -- or null. */
  function inReach(max = MELEE) {
    const t = game.target();
    if (!t || !t.slot || t.slot.dead) return null;
    const d = Math.hypot(t.slot.pos.x - k.position.x, t.slot.pos.z - k.position.z);
    return d <= max ? t.slot : null;
  }

  /** A round started from a command lands its blows the way a click does. */
  function strike(fn) {
    ctx.round = { player: WINDUP, npc: 0.31 };
    try { fn(); } finally { ctx.round = null; ctx.now = undefined; }
  }

  // --------------------------------------------------------------- kick --

  /** fight.c: do_kick -- 1 to level damage on whoever you are fighting. */
  function kick() {
    if (state.level < skillLevel('kick')) return out(false, 'You better leave the martial arts to fighters.');
    const victim = state.fighting;
    if (!victim) return out(false, "You aren't fighting anyone.");
    const d = Math.hypot(victim.slot.pos.x - k.position.x, victim.slot.pos.z - k.position.z);
    if (d > MELEE) return out(false, `${capitalise(victim.name)} is out of reach.`);
    state.wait = 8;
    emit({ kind: 'kick', text: '', to: victim.slot, delay: 0 });
    strike(() => {
      const hit = k.rng.percent() < learned('kick');
      k.damage(state, victim, hit ? k.rng.range(1, state.level) : 0, 'kick');
    });
    return out(true, '');
  }

  // ----------------------------------------------------------- backstab --

  /**
   * fight.c: do_backstab. A piercing weapon (value[3] == 11), a victim who is
   * not fighting and not hurt, and the roll -- or a sleeping victim, which
   * needs no roll. The damage is one_hit's times 2 + level/8.
   */
  function backstab(slot = inReach()) {
    if (!slot) return out(false, 'They aren\'t here.');
    const victim = k.wake(slot);
    const wield = state.equipment[WEAR_WIELD];
    if (!wield || wield.values[3] !== 11) return out(false, 'You need to wield a piercing weapon.');
    if (victim.fighting) return out(false, "You can't backstab a fighting person.");
    if (victim.hit < victim.maxHit) return out(false, `${capitalise(victim.name)} is hurt and suspicious ... you can't sneak up.`);
    state.wait = 24;
    // DIVERGES: from in front, it is a stab they saw coming, and it misses.
    const behind = k.facingAway(slot) > 0.35;
    emit({ kind: 'backstab', text: '', to: slot, behind, delay: 0 });
    strike(() => {
      if (behind && (!MERC.isAwake(victim) || k.rng.percent() < learned('backstab'))) {
        k.multiHit(state, victim, 'backstab');
      } else {
        k.damage(state, victim, 0, 'backstab');
      }
    });
    if (!behind) emit({ kind: 'note', text: `${capitalise(victim.name)} turns and sees you coming.` });
    return out(true, '');
  }

  // ------------------------------------------------------------- disarm --

  /** fight.c: do_disarm -- two thirds of your skill against the level gap. */
  function disarm() {
    if (state.level < skillLevel('disarm')) return out(false, "You don't know how to disarm opponents.");
    if (!state.equipment[WEAR_WIELD]) return out(false, 'You must wield a weapon to disarm.');
    const victim = state.fighting;
    if (!victim) return out(false, "You aren't fighting anyone.");
    if (!victim.equipment[WEAR_WIELD]) return out(false, 'Your opponent is not wielding a weapon.');
    state.wait = 24;
    const percent = k.rng.percent() + victim.level - state.level;
    if (percent < MERC.idiv(learned('disarm') * 2, 3)) ctx.disarm(state, victim);
    else emit({ kind: 'note', text: 'You failed.' });
    return out(true, '');
  }

  // ------------------------------------------------------------- rescue --

  /** fight.c: do_rescue. There is nobody here for a player to rescue but players. */
  function rescue(slot = inReach(9)) {
    if (!slot) return out(false, 'They aren\'t here.');
    return out(false, 'Doesn\'t need your help!');
  }

  // -------------------------------------------------------------- steal --

  /**
   * act_obj.c: do_steal -- gold, or a named thing from what it carries. Caught
   * (the roll, a victim five levels over you, or one mid-fight), it shouts and
   * turns on you. `what` is 'gold' or an object from the victim's pack.
   */
  function steal(what = 'gold', slot = inReach()) {
    if (!slot) return out(false, 'They aren\'t here.');
    const victim = k.wake(slot);
    state.wait = 24;
    const percent = k.rng.percent() + (MERC.isAwake(victim) ? 10 : -50);
    if (state.level + 5 < victim.level || victim.position === POS.FIGHTING || percent > learned('steal')) {
      emit({ kind: 'note', text: 'Oops.' });
      k.toRoom(slot, `${capitalise(victim.name)} shouts '${capitalise(state.name)} is a bloody thief!'`, { kind: 'shout', slot });
      strike(() => k.multiHit(victim, state));
      return out(false, 'Oops.');
    }
    if (what === 'gold' || what === 'coins' || what === 'coin') {
      const amount = MERC.idiv(victim.gold * k.rng.range(1, 10), 100);
      if (amount <= 0) return out(false, "You couldn't get any gold.");
      state.gold += amount;
      victim.gold -= amount;
      emit({ kind: 'gold', amount, text: `Bingo!  You got ${amount} gold coins.` });
      return out(true, `Bingo!  You got ${amount} gold coins.`);
    }
    const obj = typeof what === 'object' ? what : null;
    if (!obj || !victim.inventory.includes(obj)) return out(false, "You can't find it.");
    if ((obj.extraFlags & XF.NODROP) || (obj.extraFlags & XF.INVENTORY) || obj.level > state.level) {
      return out(false, "You can't pry it away.");
    }
    if (state.inventory.length + 1 > MERC.canCarryN(state)) return out(false, 'You have your hands full.');
    if (MERC.carriedWeight(state) + obj.weight > MERC.canCarryW(state)) return out(false, "You can't carry that much weight.");
    victim.inventory.splice(victim.inventory.indexOf(obj), 1);
    state.inventory.push(obj);
    emit({ kind: 'pickup', text: `You steal ${obj.name}.`, item: obj.name });
    return out(true, 'Ok.');
  }

  // ------------------------------------------------------------ the bar --

  /**
   * The skill bar: what this class can do, on which key. Merc's skills in the
   * order a fighter reaches for them; whatever else (magic.js's spells) adds
   * itself with `game.addActions(fn)`, fn() -> [{ key, label, keyCode, ... }].
   */
  const BAR = [
    { key: 'kick', label: 'kick', run: () => kick(), needs: () => !!state.fighting },
    { key: 'backstab', label: 'backstab', run: () => backstab(), needs: () => !state.fighting && !!inReach() },
    { key: 'disarm', label: 'disarm', run: () => disarm(), needs: () => !!state.fighting },
    { key: 'sneak', label: 'sneak', run: () => game.sneak(), needs: () => !state.fighting, on: () => hasAff(state, AFF.SNEAK) },
    { key: 'hide', label: 'hide', run: () => game.hide(), needs: () => !state.fighting, on: () => hasAff(state, AFF.HIDE) },
    { key: 'steal', label: 'steal', run: () => steal('gold'), needs: () => !state.fighting && !!inReach() },
    { key: 'pickLock', label: 'pick', run: () => pickFacing(), needs: () => !state.fighting },
  ];
  const KEYS = ['KeyZ', 'KeyX', 'KeyC', 'KeyH', 'KeyJ', 'KeyL', 'KeyN'];
  const actionSources = [];

  /** Pick whatever lock is nearest: a door you stand by, or a chest. */
  function pickFacing() {
    const obj = game.here(3).find((o) => o.itemType === ITEM.CONTAINER && (o.values[1] & 8));
    if (obj) return game.pickObj(obj);
    const door = game.nearDoor ? game.nearDoor() : null;
    if (!door) return out(false, 'Pick what?');
    return game.pickDoor(door.vnum, door.dir);
  }

  function actions() {
    const mine = BAR.filter((a) => MERC.SKILLS.find((s) => s.key === a.key).level[state.class] <= MERC.LEVEL_HERO);
    const list = mine.map((a) => ({
      id: a.key, label: a.label, learned: learned(a.key),
      known: state.level >= skillLevel(a.key),
      ready: state.wait <= 0 && a.needs(), on: a.on ? a.on() : false,
      run: a.run,
    }));
    for (const source of actionSources) list.push(...(source() || []));
    list.forEach((a, i) => { a.code = KEYS[i] || null; a.keyLabel = a.code ? a.code.replace('Key', '') : ''; });
    return list;
  }

  /**
   * One command may wait behind a WAIT_STATE, the way the mud's input buffer
   * holds the next line: pressed early, it goes when the wait runs out.
   */
  // The line held behind a WAIT_STATE is each player's own (k.pc.queued).
  function use(id) {
    const action = actions().find((a) => a.id === id);
    if (!action) return out(false, 'Huh?');
    if (!action.known) return out(false, `You don't know how to ${action.label}.`);
    if (state.position < POS.RESTING) return out(false, "You can't do that right now.");
    if (state.wait > 0) { k.pc.queued = id; return out(true, ''); }
    return action.run();
  }
  k.rules.onWaitOver = () => {
    if (!k.pc.queued) return;
    const id = k.pc.queued;
    k.pc.queued = null;
    const r = use(id);
    if (r && !r.ok && r.text) emit({ kind: 'note', text: r.text });
  };

  Object.assign(game, {
    kick, backstab, disarm, rescue, steal, actions, useAction: use,
    addActions(fn) { actionSources.push(fn); },
    skillKey(id) { const a = actions().find((x) => x.id === id); return a && a.keyLabel ? a.keyLabel : id; },
    inReach,
  });
  void canSee; void isNpc;
}
