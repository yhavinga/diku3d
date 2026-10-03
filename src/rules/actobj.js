/**
 * The rest of act_obj.c: containers (corpses included), give, eat, drink,
 * fill, sacrifice, value, compare, and the "all" forms of wear and drop.
 * quaff, recite, zap, brandish and pills are spells and belong to magic.js;
 * `game.itemVerbs` is where it hangs them on an object.
 *
 * Each function is the do_* command's body with its argument already resolved
 * to an object, returning the mud's reply as `{ ok, text }` and emitting an
 * event for what the world should see and hear.
 */

import { ITEM } from '../are.js';
import {
  CONT, COND, LIQUIDS, AFF, XF, ITEM_TAKE, capitalise, objWeight, objNumber, affectJoin, createMoney,
} from './handler.js';

export function installObjects(k) {
  const { ground, emit, game } = k;
  // Whoever's turn it is (game.js `bind`): Merc's `ch`.
  let state = k.state;
  k.onBind((ch) => { state = ch; });
  const { MERC } = game;
  const { idiv } = MERC;

  const isContainer = (obj) => obj.itemType === ITEM.CONTAINER
    || obj.itemType === ITEM.CORPSE_NPC || obj.itemType === ITEM.CORPSE_PC;
  const closed = (obj) => obj.itemType === ITEM.CONTAINER && (obj.values[1] & CONT.CLOSED);
  const word = (obj) => obj.keywords.split(/\s+/)[0];
  const carried = () => state.inventory;
  const canDrop = (obj) => !(obj.extraFlags & XF.NODROP);
  const out = (ok, text) => ({ ok, text });

  /** Where a sound or a gesture happens: the thing if it is on the floor, else you. */
  const whereOf = (obj) => (obj && obj.at ? obj.at : { x: k.position.x, y: k.position.y - 0.4, z: k.position.z });

  // ------------------------------------------------------------ containers --

  /** do_get's container half: `get <obj> <container>`. */
  function getFrom(obj, container) {
    if (!isContainer(container)) return out(false, "That's not a container.");
    if (container.itemType === ITEM.CORPSE_PC && container.owner !== state.name) return out(false, "You can't do that.");
    if (closed(container)) return out(false, `The ${word(container)} is closed.`);
    if (!container.contains.includes(obj)) return out(false, `I see nothing like that in the ${word(container)}.`);
    return game.take(obj, container);
  }

  /** do_put. */
  function put(obj, container) {
    if (container.itemType !== ITEM.CONTAINER) return out(false, "That's not a container.");
    if (closed(container)) return out(false, `The ${word(container)} is closed.`);
    if (!carried().includes(obj)) return out(false, 'You do not have that item.');
    if (obj === container) return out(false, "You can't fold it into itself.");
    if (!canDrop(obj)) return out(false, "You can't let go of it.");
    if (objWeight(obj) + objWeight(container) > container.values[0]) return out(false, "It won't fit.");
    carried().splice(carried().indexOf(obj), 1);
    container.contains.push(obj);
    const text = `You put ${obj.name} in ${container.name}.`;
    emit({ kind: 'put', text, item: obj.name, at: whereOf(container) });
    return out(true, text);
  }

  // ----------------------------------------------------------------- give --

  /** do_give, to a mobile standing by you. */
  function give(obj, slot) {
    const victim = k.wake(slot);
    if (!carried().includes(obj)) return out(false, 'You do not have that item.');
    if (!canDrop(obj)) return out(false, "You can't let go of it.");
    if (victim.inventory.length + objNumber(obj) > MERC.canCarryN(victim) && !victim.npc) {
      return out(false, `${capitalise(victim.name)} has ${victim.sex === 2 ? 'her' : 'his'} hands full.`);
    }
    carried().splice(carried().indexOf(obj), 1);
    victim.inventory.push(obj);
    const text = `You give ${obj.name} to ${victim.name}.`;
    emit({ kind: 'give', text, item: obj.name, at: slot.pos });
    return out(true, text);
  }

  /** do_give's `give N coins <victim>`. */
  function giveGold(amount, slot) {
    if (!(amount > 0)) return out(false, "Sorry, you can't do that.");
    if (state.gold < amount) return out(false, "You haven't got that much gold.");
    const victim = k.wake(slot);
    state.gold -= amount;
    victim.gold += amount;
    emit({ kind: 'give', text: `You give ${victim.name} some gold.`, at: slot.pos, gold: amount });
    return out(true, 'OK.');
  }

  /** do_drop's `drop N coins`: into whatever pile is already lying here. */
  function dropGold(amount) {
    if (!(amount > 0)) return out(false, "Sorry, you can't do that.");
    if (state.gold < amount) return out(false, "You haven't got that many coins.");
    state.gold -= amount;
    for (const obj of ground.filter((o) => o.inRoom === state.roomVnum && o.itemType === ITEM.MONEY)) {
      if (Math.hypot(obj.at.x - k.position.x, obj.at.z - k.position.z) > 4) continue;
      amount += obj.values[0];
      k.objFromRoom(obj);
    }
    const coins = k.objToRoom(createMoney(amount), state.roomVnum, k.dropSpot());
    emit({ kind: 'drop', text: `You drop ${coins.name}.`, item: coins.name, obj: coins, gold: true });
    return out(true, 'OK.');
  }

  // ------------------------------------------------------- eat and drink --

  /** do_eat. A pill is a spell: magic.js's `objCastSpell`, through itemVerbs. */
  function eat(obj) {
    if (!carried().includes(obj)) return out(false, 'You do not have that item.');
    if (obj.itemType === ITEM.PILL && game.useItem) return game.useItem(obj);
    if (obj.itemType !== ITEM.FOOD && obj.itemType !== ITEM.PILL) return out(false, "That's not edible.");
    if (state.condition[COND.FULL] > 40) return out(false, 'You are too full to eat more.');
    const lines = [`You eat ${obj.name}.`];
    if (obj.itemType === ITEM.FOOD) {
      const before = state.condition[COND.FULL];
      k.gainCondition(state, COND.FULL, obj.values[0]);
      if (before === 0 && state.condition[COND.FULL] > 0) lines.push('You are no longer hungry.');
      else if (state.condition[COND.FULL] > 40) lines.push('You are full.');
      if (obj.values[3] !== 0) {
        lines.push('You choke and gag.');
        affectJoin(state, { type: 'poison', duration: 2 * obj.values[0], bitvector: AFF.POISON });
      }
    }
    carried().splice(carried().indexOf(obj), 1);
    emit({ kind: 'eat', text: lines.join(' '), item: obj.name, poisoned: obj.values[3] !== 0 });
    return out(true, lines.join(' '));
  }

  /** Which fountain is here, if you are in reach of one. */
  const fountainHere = () => game.here(3).find((o) => o.itemType === ITEM.FOUNTAIN) || null;

  /** do_drink: a container you carry or that stands here, or with no argument, the fountain. */
  function drink(obj = null) {
    if (!obj) obj = fountainHere();
    if (!obj) return out(false, 'Drink what?');
    if (state.condition[COND.DRUNK] > 10) return out(false, 'You fail to reach your mouth.  *Hic*');
    if (obj.itemType === ITEM.FOUNTAIN) {
      state.condition[COND.THIRST] = 48;
      emit({ kind: 'drink', text: 'You drink from the fountain. You are not thirsty.', item: obj.name, at: obj.at, fountain: true });
      return out(true, 'You are not thirsty.');
    }
    if (obj.itemType !== ITEM.DRINK_CON) return out(false, "You can't drink from that.");
    if (obj.values[1] <= 0) return out(false, 'It is already empty.');
    let liquid = obj.values[2];
    if (liquid < 0 || liquid >= LIQUIDS.length) { liquid = 0; obj.values[2] = 0; }
    const [name, , effect] = LIQUIDS[liquid];
    const lines = [`You drink ${name} from ${obj.name}.`];
    const amount = Math.min(k.rng.range(3, 10), obj.values[1]);
    k.gainCondition(state, COND.DRUNK, amount * effect[COND.DRUNK]);
    k.gainCondition(state, COND.FULL, amount * effect[COND.FULL]);
    k.gainCondition(state, COND.THIRST, amount * effect[COND.THIRST]);
    if (state.condition[COND.DRUNK] > 10) lines.push('You feel drunk.');
    if (state.condition[COND.FULL] > 40) lines.push('You are full.');
    if (state.condition[COND.THIRST] > 40) lines.push('You do not feel thirsty.');
    if (obj.values[3] !== 0) {
      lines.push('You choke and gag.');
      affectJoin(state, { type: 'poison', duration: 3 * amount, bitvector: AFF.POISON });
    }
    obj.values[1] -= amount;
    if (obj.values[1] <= 0) {
      lines.push('The empty container vanishes.');
      if (carried().includes(obj)) carried().splice(carried().indexOf(obj), 1);
      else if (obj.inRoom !== null) k.objFromRoom(obj);
    }
    emit({ kind: 'drink', text: lines.join(' '), item: obj.name, liquid: name, at: whereOf(obj) });
    return out(true, lines.join(' '));
  }

  /** do_fill, at the fountain. */
  function fill(obj) {
    if (!carried().includes(obj)) return out(false, 'You do not have that item.');
    const fountain = fountainHere();
    if (!fountain) return out(false, 'There is no fountain here!');
    if (obj.itemType !== ITEM.DRINK_CON) return out(false, "You can't fill that.");
    if (obj.values[1] !== 0 && obj.values[2] !== 0) return out(false, 'There is already another liquid in it.');
    if (obj.values[1] >= obj.values[0]) return out(false, 'Your container is full.');
    obj.values[2] = 0;
    obj.values[1] = obj.values[0];
    emit({ kind: 'fill', text: `You fill ${obj.name}.`, item: obj.name, at: fountain.at });
    return out(true, `You fill ${obj.name}.`);
  }

  // ---------------------------------------------------------- sacrifice --

  /** do_sacrifice: anything you could pick up, for one gold coin. */
  function sacrifice(obj) {
    if (!obj) {
      return out(true, 'God appreciates your offer and may accept it later.');
    }
    if (!(obj.wearFlags & ITEM_TAKE)) return out(false, `${capitalise(obj.name)} is not an acceptable sacrifice.`);
    state.gold += 1;
    const at = obj.at;
    k.objFromRoom(obj);
    if (obj.slot) { k.removeBody(obj.slot); obj.slot.corpse = null; }
    emit({ kind: 'sacrifice', text: 'God gives you one gold coin for your sacrifice.', item: obj.name, at });
    return out(true, 'God gives you one gold coin for your sacrifice.');
  }

  // ------------------------------------------------------------- compare --

  /** act_info.c: do_compare -- armour by value[0], weapons by their dice. */
  function compare(a, b = null) {
    if (!b) {
      b = state.equipment.find((o) => o && o.itemType === a.itemType && (a.wearFlags & o.wearFlags & ~ITEM_TAKE));
      if (!b) return out(false, "You aren't wearing anything comparable.");
    }
    if (a === b) return out(true, `You compare ${a.name} to itself.  It looks about the same.`);
    if (a.itemType !== b.itemType || (a.itemType !== ITEM.ARMOR && a.itemType !== ITEM.WEAPON)) {
      return out(true, `You can't compare ${a.name} and ${b.name}.`);
    }
    const value = (o) => (o.itemType === ITEM.ARMOR ? o.values[0] : o.values[1] + o.values[2]);
    const [v1, v2] = [value(a), value(b)];
    const text = v1 === v2 ? `${capitalise(a.name)} and ${b.name} look about the same.`
      : v1 > v2 ? `${capitalise(a.name)} looks better than ${b.name}.` : `${capitalise(a.name)} looks worse than ${b.name}.`;
    return out(true, text);
  }

  // ------------------------------------------------------------ shops --

  /** do_value: what the keeper standing here would pay. */
  function value(obj) {
    const shop = game.shopHere();
    if (!shop) return out(false, "You can't do that here.");
    const refusal = game.keeperRefuses ? game.keeperRefuses(shop) : null;
    if (refusal) return out(false, refusal);
    if (!carried().includes(obj)) return { ...out(false, `${capitalise(shop.name)} tells you 'You don't have that item'.`), slot: shop.slot, said: "You don't have that item." };
    if (!canDrop(obj)) return out(false, "You can't let go of it.");
    const keeperSlot = k.mobs.find((s) => s.proto.vnum === shop.keeper && !s.dead);
    const cost = MERC.getCost(keeperSlot.record.shop, obj, false);
    if (cost <= 0) return out(false, `${capitalise(shop.name)} looks uninterested in ${obj.name}.`);
    const said = `I'll give you ${cost} gold coins for ${obj.name}.`;
    return { ...out(true, `${capitalise(shop.name)} tells you 'I'll give you ${cost} gold coins for ${obj.name}'.`), slot: keeperSlot, said };
  }

  // ----------------------------------------------------------- all forms --

  /** do_wear all: everything that fits, without replacing what you have on. */
  function wearAll() {
    const lines = [];
    for (const obj of carried().slice()) {
      const r = MERC.wearObj(state, obj, false);
      if (r && r.ok) { lines.push(r.text); emit({ kind: 'wear', text: r.text, item: obj.name }); }
    }
    return out(lines.length > 0, lines.length ? lines.join(' ') : '');
  }

  /** do_drop all. */
  function dropAll(keyword = null) {
    const lines = [];
    for (const obj of carried().slice()) {
      if (keyword && !obj.keywords.toLowerCase().split(/\s+/).includes(keyword)) continue;
      if (!canDrop(obj)) continue;
      lines.push(game.drop(obj).text);
    }
    if (!lines.length) return out(false, keyword ? `You are not carrying any ${keyword}.` : 'You are not carrying anything.');
    return out(true, lines.join(' '));
  }

  // --------------------------------------------------------------- verbs --

  /**
   * What can be done with an object, for the inventory sheet and the loot
   * panel: a list of `{ verb, label, run }`. The mud's own verbs are here; a
   * module adds its own with `game.addItemVerbs(fn)`, fn(obj, where) -> [...]
   * (magic.js: quaff, recite, zap, brandish). `where` is 'carried', 'worn',
   * 'ground' or the container it is in.
   */
  const verbSources = [];
  function itemVerbs(obj, where) {
    const verbs = [];
    if (where === 'carried') {
      if (obj.itemType === ITEM.FOOD) verbs.push({ verb: 'eat', run: () => eat(obj) });
      if (obj.itemType === ITEM.DRINK_CON) {
        verbs.push({ verb: 'drink', run: () => drink(obj) });
        if (fountainHere()) verbs.push({ verb: 'fill', run: () => fill(obj) });
      }
      if (obj.itemType === ITEM.LIGHT) verbs.push({ verb: 'hold', run: () => game.wear(obj) });
      else if (obj.wearFlags & ~ITEM_TAKE) {
        const verb = obj.wearFlags & 8192 ? 'wield' : (obj.wearFlags & 16384 ? 'hold' : 'wear');
        verbs.push({ verb, run: () => game.wear(obj) });
      }
      const shop = game.shopHere();
      if (!shop) verbs.push({ verb: 'drop', run: () => game.drop(obj) });
    } else if (where === 'ground') {
      if (obj.wearFlags & ITEM_TAKE) verbs.push({ verb: 'get', run: () => game.take(obj, null) });
      if (obj.itemType === ITEM.FOUNTAIN) verbs.push({ verb: 'drink', run: () => drink(obj) });
      if (obj.wearFlags & ITEM_TAKE) verbs.push({ verb: 'sacrifice', run: () => sacrifice(obj) });
    } else if (where && typeof where === 'object') {
      verbs.push({ verb: 'get', run: () => getFrom(obj, where) });
    }
    for (const source of verbSources) verbs.push(...(source(obj, where) || []));
    return verbs;
  }

  Object.assign(k, { isContainer, closed, fountainHere });
  Object.assign(game, {
    getFrom, put, give, giveGold, dropGold, eat, drink, fill, sacrifice, compare, value,
    wearAll, dropAll, itemVerbs,
    addItemVerbs(fn) { verbSources.push(fn); },
    isContainer,
    /** What is inside, or null if it is shut: do_look's `look in`. */
    lookIn(obj) {
      if (obj.itemType === ITEM.DRINK_CON) {
        if (obj.values[1] <= 0) return { text: 'It is empty.' };
        const amount = obj.values[1] < idiv(obj.values[0], 4) ? 'less than'
          : obj.values[1] < idiv(3 * obj.values[0], 4) ? 'about' : 'more than';
        const liquid = LIQUIDS[obj.values[2]] || LIQUIDS[0];
        return { text: `It's ${amount} half full of a ${liquid[1]} liquid.`.replace(' half', '') };
      }
      if (!isContainer(obj)) return { text: 'That is not a container.' };
      if (closed(obj)) return { text: 'It is closed.', closed: true };
      return { text: `${capitalise(obj.name)} contains:`, contains: obj.contains };
    },
  });
}
