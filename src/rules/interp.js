/**
 * interp.c: the command line -- cmd_table in the mud's own order, so its
 * abbreviations resolve as they did (`l` is look, `k` is kill, `s` is south),
 * the position gate with its refusals, the social table, and the act_info.c
 * commands that are only text: look, score, who, where, time, weather,
 * inventory, equipment, consider, exits, practice, wimpy.
 *
 * `game.interpret(line)` runs one line. What it prints goes out as events of
 * kind 'out' (the reply) alongside whatever the command itself emits, so the
 * console shows exactly what the mud would have sent.
 */

import { ITEM, DIR_NAME, EX_CLOSED, EX_ISDOOR, SECTOR } from '../are.js';
import {
  AFF, PLR, COND, LIQUIDS, capitalise, isName, isPrefix, oneArgument, numberArgument, findNamed,
  doorName, hasAff,
} from './handler.js';
import { SOCIALS } from './socials.js';

const WHERE_NAME = [
  '<used as light>     ', '<worn on finger>    ', '<worn on finger>    ', '<worn around neck>  ',
  '<worn around neck>  ', '<worn on body>      ', '<worn on head>      ', '<worn on legs>      ',
  '<worn on feet>      ', '<worn on hands>     ', '<worn on arms>      ', '<worn as shield>    ',
  '<worn about body>   ', '<worn about waist>  ', '<worn around wrist> ', '<worn around wrist> ',
  '<wielded>           ', '<held>              ',
];
const DAY_NAME = ['the Moon', 'the Bull', 'Deception', 'Thunder', 'Freedom', 'the Great Gods', 'the Sun'];
const MONTH_NAME = [
  'Winter', 'the Winter Wolf', 'the Frost Giant', 'the Old Forces', 'the Grand Struggle', 'the Spring',
  'Nature', 'Futility', 'the Dragon', 'the Sun', 'the Heat', 'the Battle', 'the Dark Shades', 'the Shadows',
  'the Long Shadows', 'the Ancient Darkness', 'the Great Evil',
];
const SKY_LOOK = ['cloudless', 'cloudy', 'rainy', 'lit by flashes of lightning'];

/** act()'s $-codes, for the two characters a line can be about. */
export function act(format, ch, victim = null, extra = {}) {
  const he = (c) => ['it', 'he', 'she'][c?.sex ?? 0] || 'it';
  const him = (c) => ['it', 'him', 'her'][c?.sex ?? 0] || 'it';
  const his = (c) => ['its', 'his', 'her'][c?.sex ?? 0] || 'its';
  const name = (c) => (c ? (c.npc ? c.name : (c.displayName || 'you')) : 'someone');
  const text = format.replace(/\$([nNeEmMsSpPTd])/g, (_, code) => {
    switch (code) {
      case 'n': return name(ch);
      case 'N': return name(victim);
      case 'e': return he(ch);
      case 'E': return he(victim);
      case 'm': return him(ch);
      case 'M': return him(victim);
      case 's': return his(ch);
      case 'S': return his(victim);
      case 'p': return extra.p || 'something';
      case 'P': return extra.P || 'something';
      case 'T': return extra.T || '';
      case 'd': return extra.d || 'door';
      default: return '';
    }
  });
  return capitalise(text);
}

export function installInterp(k) {
  const { world, built, state, ground, mobs, emit, game } = k;
  const { MERC } = game;
  const { POS } = MERC;

  // `extra` carries a speaker's slot and words, so a keeper's reply is also said aloud.
  const send = (text, extra) => { if (text) emit({ kind: 'out', text, ...extra }); };

  // ------------------------------------------------------------ finding --

  /** get_char_room: the mobiles about you, nearest first, and 'self'. */
  function charsHere() {
    return mobs
      .filter((s) => !s.dead && (s.roomVnum === state.roomVnum
        || Math.hypot(s.pos.x - k.position.x, s.pos.z - k.position.z) < 9))
      .sort((a, b) => Math.hypot(a.pos.x - k.position.x, a.pos.z - k.position.z)
        - Math.hypot(b.pos.x - k.position.x, b.pos.z - k.position.z));
  }
  function getCharRoom(arg) {
    if (arg === 'self') return 'self';
    return findNamed(charsHere(), arg, (s) => s.proto.keywords);
  }

  /** The room's contents: what is lying in the room you stand in, nearest first. */
  function roomObjects() {
    const feet = { x: k.position.x, z: k.position.z };
    return ground
      .filter((o) => o.inRoom === state.roomVnum || Math.hypot(o.at.x - feet.x, o.at.z - feet.z) < 5)
      .sort((a, b) => Math.hypot(a.at.x - feet.x, a.at.z - feet.z) - Math.hypot(b.at.x - feet.x, b.at.z - feet.z));
  }
  const getObjCarry = (arg) => findNamed(state.inventory, arg);
  const getObjWear = (arg) => findNamed(state.equipment.filter(Boolean), arg);
  const getObjRoom = (arg) => findNamed(roomObjects(), arg);
  /** handler.c: get_obj_here -- the room, then what you carry, then what you wear. */
  const getObjHere = (arg) => getObjRoom(arg) || getObjCarry(arg) || getObjWear(arg);

  const allArg = (arg) => arg === 'all' || arg.startsWith('all.');
  const allName = (arg) => (arg.startsWith('all.') ? arg.slice(4) : null);

  /** Speak a { ok, text } reply, unless the command already said something. */
  const reply = (r) => { if (r && r.text && !r.ok) send(r.text, r.said ? { slot: r.slot, said: r.said } : undefined); else if (r && r.text && r.quiet !== false) quietReply(r.text, r.said ? { slot: r.slot, said: r.said } : undefined); };
  let spoke = false;
  const quietReply = (text, extra) => { if (!spoke) send(text, extra); };

  // --------------------------------------------------------------- look --

  function doLook(arg) {
    if (state.position < POS.SLEEPING) return send("You can't see anything but stars!");
    if (state.position === POS.SLEEPING) return send("You can't see anything, you're sleeping!");
    const [arg1, rest] = oneArgument(arg);
    const [arg2] = oneArgument(rest);
    const room = world.rooms.get(state.roomVnum);
    if (!room) return send('You are completely lost.');
    if (!arg1 || arg1 === 'auto') {
      send(room.name);
      if (state.act & PLR.AUTOEXIT) doExits('auto');
      send(room.description.trim());
      for (const obj of roomObjects()) if (obj.description) send(obj.description);
      for (const slot of charsHere()) send(showChar0(slot));
      return;
    }
    if (arg1 === 'i' || arg1 === 'in') {
      if (!arg2) return send('Look in what?');
      const obj = getObjHere(arg2);
      if (!obj) return send('You do not see that here.');
      const inside = game.lookIn(obj);
      send(inside.text);
      if (inside.contains) listObjects(inside.contains, true);
      return;
    }
    const target = getCharRoom(arg1);
    if (target === 'self') return send(lookAtSelf());
    if (target) return lookAtChar(target);
    for (const obj of [...state.inventory, ...roomObjects()]) {
      const ed = extraDescr(arg1, obj);
      if (ed) return send(ed);
      if (isName(arg1, obj.keywords)) return send(obj.description || `You see nothing special about ${obj.name}.`);
    }
    const red = (room.extra || []).find((e) => isName(arg1, e.keyword));
    if (red) return send(red.description.trim());
    const dir = ['n', 'e', 's', 'w', 'u', 'd'].indexOf(arg1[0]) >= 0
      && ['north', 'east', 'south', 'west', 'up', 'down'].some((w) => isPrefix(arg1, w) && (arg1.length === 1 || arg1 === w))
      ? ['n', 'e', 's', 'w', 'u', 'd'].indexOf(arg1[0]) : -1;
    if (dir < 0) return send('You do not see that here.');
    const exit = room.exits[dir];
    if (!exit) return send('Nothing special there.');
    send(exit.description && exit.description.trim() ? exit.description.trim() : 'Nothing special there.');
    if (exit.keyword && exit.keyword.trim()) {
      if (exit.locks & EX_CLOSED) send(`The ${doorName(exit.keyword)} is closed.`);
      else if (exit.locks & EX_ISDOOR) send(`The ${doorName(exit.keyword)} is open.`);
    }
  }

  const extraDescr = (arg, obj) => {
    const list = [...(obj.extra || []), ...((obj.proto && obj.proto.extra) || [])];
    const hit = list.find((e) => isName(arg, e.keyword));
    return hit ? hit.description.trim() : null;
  };

  /** act_info.c: show_char_to_char_0 -- one line for someone in the room. */
  function showChar0(slot) {
    const mob = slot.instance;
    const flags = mob && hasAff(mob, AFF.SANCTUARY) ? '(White Aura) ' : '';
    if (!mob || mob.position === POS.STANDING) return `${flags}${slot.proto.long}`;
    const where = {
      [POS.DEAD]: ' is DEAD!!', [POS.MORTAL]: ' is mortally wounded.', [POS.INCAP]: ' is incapacitated.',
      [POS.STUNNED]: ' is lying here stunned.', [POS.SLEEPING]: ' is sleeping here.', [POS.RESTING]: ' is resting here.',
      [POS.STANDING]: ' is here.',
    }[mob.position];
    if (mob.position === POS.FIGHTING) {
      const who = mob.fighting === state ? 'YOU!' : (mob.fighting ? `${mob.fighting.name}.` : 'thin air??');
      return capitalise(`${flags}${mob.name} is here, fighting ${who}`);
    }
    return capitalise(`${flags}${mob.name}${where}`);
  }

  /** act_info.c: show_char_to_char_1 -- looking at someone: prose, health, gear, and a peek. */
  function lookAtChar(slot) {
    const mob = k.wake(slot);
    send(slot.proto.description.trim() || `You see nothing special about ${act('$M', null, mob)}.`);
    send(`${capitalise(mob.name)} ${MERC.condition(mob) === 'perfect health' ? 'is in perfect health' : conditionLine(mob)}.`);
    const worn = mob.equipment.map((o, i) => (o ? `${WHERE_NAME[i]}${o.name}` : null)).filter(Boolean);
    if (worn.length) { send(`${capitalise(mob.name)} is using:`); worn.forEach(send); }
    if (k.rng.percent() < (state.learned.peek || 0)) {
      send('You peek at the inventory:');
      listObjects(mob.inventory, true);
    }
  }
  const conditionLine = (mob) => {
    const c = MERC.condition(mob);
    return ['a few bruises', 'some cuts', 'several wounds', 'many nasty wounds'].includes(c) ? `has ${c}` : `is ${c}`;
  };
  const lookAtSelf = () => 'You see nothing special about yourself.';

  /** act_info.c: show_list_to_char, with PLR_COMBINE's "( 2)" counts. */
  function listObjects(list, short) {
    const lines = [];
    const counts = [];
    for (const obj of list) {
      if (obj.wearLoc >= 0) continue;
      const text = short ? obj.name : obj.description;
      const at = lines.lastIndexOf(text);
      if (at >= 0) counts[at] += 1; else { lines.push(text); counts.push(1); }
    }
    if (!lines.length) return send('     Nothing.');
    lines.forEach((line, i) => send(`${counts[i] > 1 ? `(${String(counts[i]).padStart(2)}) ` : '     '}${line}`));
  }

  function doExits(arg) {
    const room = world.rooms.get(state.roomVnum);
    if (!room) return;
    const auto = arg === 'auto';
    const open = room.exits.map((e, d) => (e && !(e.locks & EX_CLOSED) ? d : -1)).filter((d) => d >= 0);
    if (auto) return send(`[Exits:${open.length ? open.map((d) => ` ${DIR_NAME[d]}`).join('') : ' none'}]`);
    send('Obvious exits:');
    if (!open.length) return send('None.');
    for (const d of open) {
      const to = world.rooms.get(room.exits[d].to);
      send(`${capitalise(DIR_NAME[d]).padEnd(5)} - ${to ? to.name : 'somewhere not loaded'}`);
    }
  }

  // -------------------------------------------------------------- score --

  function doScore() {
    const s = state;
    send(`You are ${s.displayName ? `${s.displayName} ` : ''}the ${MERC.CLASS_TABLE[s.class].name}, level ${s.level}.`);
    send(`You have ${s.hit}/${s.maxHit} hit, ${s.mana}/${s.maxMana} mana, ${s.move}/${s.maxMove} movement, ${s.practice} practices.`);
    send(`You are carrying ${s.inventory.length}/${MERC.canCarryN(s)} items with weight ${MERC.carriedWeight(s)}/${MERC.canCarryW(s)} kg.`);
    send(`Str: ${MERC.currStr(s)}  Int: ${MERC.currInt(s)}  Wis: ${MERC.currWis(s)}  Dex: ${MERC.currDex(s)}  Con: ${MERC.currCon(s)}.`);
    send(`You have scored ${s.exp} exp, and have ${s.gold} gold coins.`);
    send(`Autoexit: ${s.act & PLR.AUTOEXIT ? 'yes' : 'no'}.  Autoloot: ${s.act & PLR.AUTOLOOT ? 'yes' : 'no'}.  Autosac: ${s.act & PLR.AUTOSAC ? 'yes' : 'no'}.`);
    send(`Wimpy set to ${s.wimpy} hit points.`);
    if (s.condition[COND.DRUNK] > 10) send('You are drunk.');
    if (s.condition[COND.THIRST] === 0) send('You are thirsty.');
    if (s.condition[COND.FULL] === 0) send('You are hungry.');
    send({
      [POS.DEAD]: 'You are DEAD!!', [POS.MORTAL]: 'You are mortally wounded.', [POS.INCAP]: 'You are incapacitated.',
      [POS.STUNNED]: 'You are stunned.', [POS.SLEEPING]: 'You are sleeping.', [POS.RESTING]: 'You are resting.',
      [POS.STANDING]: 'You are standing.', [POS.FIGHTING]: 'You are fighting.',
    }[s.position]);
    send(`${s.level >= 25 ? `AC: ${MERC.getAc(s)}.  ` : ''}You are ${MERC.armourWord(s)}${MERC.getAc(s) >= 101 || MERC.getAc(s) < -100 ? '!' : '.'}`);
    if (s.level >= 15) send(`Hitroll: ${MERC.getHitroll(s)}  Damroll: ${MERC.getDamroll(s)}.`);
    const a = s.alignment;
    const word = a > 900 ? 'angelic' : a > 700 ? 'saintly' : a > 350 ? 'good' : a > 100 ? 'kind'
      : a > -100 ? 'neutral' : a > -350 ? 'mean' : a > -700 ? 'evil' : a > -900 ? 'demonic' : 'satanic';
    send(`${s.level >= 10 ? `Alignment: ${a}.  ` : ''}You are ${word}.`);
    if (s.affected && s.affected.length) {
      send('You are affected by:');
      for (const af of s.affected) send(`Spell: '${af.type}'${s.level >= 20 ? ` modifies none by ${af.modifier || 0} for ${af.duration} hours` : ''}.`);
    }
  }

  function doTime() {
    const w = k.weather();
    const day = w.day + 1;
    const suf = day > 4 && day < 20 ? 'th' : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
    send(`It is ${w.hour % 12 === 0 ? 12 : w.hour % 12} o'clock ${w.hour >= 12 ? 'pm' : 'am'}, Day of ${DAY_NAME[day % 7]}, ${day}${suf} the Month of ${MONTH_NAME[w.month]}.`);
  }

  function doWeather() {
    const info = built.rooms.get(state.roomVnum);
    if (!info || !info.outdoor) return send("You can't see the weather indoors.");
    const w = k.weather();
    send(`The sky is ${SKY_LOOK[w.sky]} and ${w.change >= 0 ? 'a warm southerly breeze blows' : 'a cold northern gust blows'}.`);
  }

  function doWho() {
    const klass = MERC.CLASS_TABLE[state.class].who;
    const flags = `${state.act & PLR.KILLER ? ' (KILLER)' : ''}${state.act & PLR.THIEF ? ' (THIEF)' : ''}`;
    send(`[${String(state.level).padStart(2)} ${klass}] ${state.displayName || 'You'}${flags} the ${MERC.CLASS_TABLE[state.class].name}`);
    send('You see 1 player.');
  }

  function doWhere(arg) {
    const room = world.rooms.get(state.roomVnum);
    if (!arg) {
      send('Players near you:');
      send(`${(state.displayName || 'You').padEnd(28)} ${room ? room.name : ''}`);
      return;
    }
    const area = room && room.area;
    const slot = mobs.find((s) => !s.dead && world.rooms.get(s.roomVnum)?.area === area && isName(arg, s.proto.keywords)
      && !(s.instance && hasAff(s.instance, AFF.HIDE | AFF.SNEAK)));
    if (!slot) return send(`You didn't find any ${arg}.`);
    send(`${capitalise(slot.proto.short).padEnd(28)} ${world.rooms.get(slot.roomVnum).name}`);
  }

  function doInventory() {
    send('You are carrying:');
    listObjects(state.inventory, true);
  }

  function doEquipment() {
    send('You are using:');
    let found = false;
    state.equipment.forEach((obj, i) => { if (obj) { found = true; send(`${WHERE_NAME[i]}${obj.name}`); } });
    if (!found) send('Nothing.');
  }

  function doConsider(arg) {
    if (!arg) return send('Consider killing whom?');
    const slot = getCharRoom(arg);
    if (!slot || slot === 'self') return send("They're not here.");
    const mob = k.wake(slot);
    const diff = mob.level - state.level;
    const msg = diff <= -10 ? 'You can kill $N naked and weaponless.' : diff <= -5 ? '$N is no match for you.'
      : diff <= -2 ? '$N looks like an easy kill.' : diff <= 1 ? 'The perfect match!'
        : diff <= 4 ? "$N says 'Do you feel lucky, punk?'." : diff <= 9 ? '$N laughs at you mercilessly.'
          : 'Death will thank you for your gift.';
    send(act(msg, state, mob));
  }

  function doPractice(arg) {
    if (state.level < 3) return send('You must be third level to practice.  Go train instead!');
    if (!arg) {
      const row = [];
      for (const skill of game.skills()) {
        if (!skill.available) continue;
        row.push(`${skill.name.padEnd(18)} ${String(skill.learned).padStart(3)}%  `);
      }
      for (let i = 0; i < row.length; i += 3) send(row.slice(i, i + 3).join(''));
      return send(`You have ${state.practice} practice sessions left.`);
    }
    const skill = MERC.SKILLS.find((s) => isPrefix(arg, s.name));
    reply(game.practice(skill ? skill.key : '-'));
  }

  function doWimpy(arg) {
    const wimpy = arg ? Number.parseInt(arg, 10) : MERC.idiv(state.maxHit, 5);
    if (!Number.isFinite(wimpy) || wimpy < 0) return send('Your courage exceeds your wisdom.');
    if (wimpy > state.maxHit) return send('Such cowardice ill becomes you.');
    state.wimpy = wimpy;
    send(`Wimpy set to ${wimpy} hit points.`);
  }

  // ------------------------------------------------------------ objects --

  function doGet(arg) {
    const [arg1, rest] = oneArgument(arg);
    const [arg2] = oneArgument(rest);
    if (!arg1) return send('Get what?');
    if (!arg2) {
      if (!allArg(arg1)) {
        const obj = getObjRoom(arg1);
        if (!obj) return send(`I see no ${arg1} here.`);
        return reply(game.take(obj, null));
      }
      const want = allName(arg1);
      const list = roomObjects().filter((o) => !want || isName(want, o.keywords));
      if (!list.length) return send(want ? `I see no ${want} here.` : 'I see nothing here.');
      for (const obj of list) {
        const r = game.take(obj, null);
        if (!r.ok && (obj.wearFlags & 1)) send(r.text);
      }
      return;
    }
    if (allArg(arg2)) return send("You can't do that.");
    const container = getObjHere(arg2);
    if (!container) return send(`I see no ${arg2} here.`);
    if (!game.isContainer(container)) return send("That's not a container.");
    if (!allArg(arg1)) {
      const obj = findNamed(container.contains, arg1);
      if (!obj) return send(`I see nothing like that in the ${arg2}.`);
      return reply(game.getFrom(obj, container));
    }
    const want = allName(arg1);
    const list = container.contains.filter((o) => !want || isName(want, o.keywords));
    if (container.values[1] & 4) return send(`The ${container.keywords.split(' ')[0]} is closed.`);
    if (!list.length) return send(want ? `I see nothing like that in the ${arg2}.` : `I see nothing in the ${arg2}.`);
    for (const obj of list) reply(game.getFrom(obj, container));
  }

  function doPut(arg) {
    const [arg1, rest] = oneArgument(arg);
    const [arg2] = oneArgument(rest);
    if (!arg1 || !arg2) return send('Put what in what?');
    if (allArg(arg2)) return send("You can't do that.");
    const container = getObjHere(arg2);
    if (!container) return send(`I see no ${arg2} here.`);
    if (!allArg(arg1)) {
      const obj = getObjCarry(arg1);
      if (!obj && container.itemType === ITEM.CONTAINER) return send('You do not have that item.');
      return reply(game.put(obj, container));
    }
    const want = allName(arg1);
    for (const obj of state.inventory.slice()) {
      if (obj === container || (want && !isName(want, obj.keywords))) continue;
      const r = game.put(obj, container);
      if (!r.ok && r.text !== "It won't fit.") { send(r.text); break; }
    }
  }

  function doDrop(arg) {
    const [arg1, rest] = oneArgument(arg);
    if (!arg1) return send('Drop what?');
    if (/^\d+$/.test(arg1)) {
      const [what] = oneArgument(rest);
      if (what !== 'coins' && what !== 'coin') return send("Sorry, you can't do that.");
      return reply(game.dropGold(Number(arg1)));
    }
    if (allArg(arg1)) return reply(game.dropAll(allName(arg1)));
    const obj = getObjCarry(arg1);
    if (!obj) return send('You do not have that item.');
    reply(game.drop(obj));
  }

  function doGive(arg) {
    const [arg1, rest] = oneArgument(arg);
    let [arg2, rest2] = oneArgument(rest);
    if (!arg1 || !arg2) return send('Give what to whom?');
    if (/^\d+$/.test(arg1)) {
      if (arg2 !== 'coins' && arg2 !== 'coin') return send("Sorry, you can't do that.");
      [arg2] = oneArgument(rest2);
      if (!arg2) return send('Give what to whom?');
      const slot = getCharRoom(arg2);
      if (!slot || slot === 'self') return send("They aren't here.");
      return reply(game.giveGold(Number(arg1), slot));
    }
    const obj = getObjCarry(arg1);
    if (!obj) return send(getObjWear(arg1) ? 'You must remove it first.' : 'You do not have that item.');
    const slot = getCharRoom(arg2);
    if (!slot || slot === 'self') return send("They aren't here.");
    reply(game.give(obj, slot));
  }

  function doWear(arg) {
    const [arg1] = oneArgument(arg);
    if (!arg1) return send('Wear, wield, or hold what?');
    if (arg1 === 'all') return reply(game.wearAll());
    const obj = getObjCarry(arg1);
    if (!obj) return send('You do not have that item.');
    reply(game.wear(obj));
  }

  function doRemove(arg) {
    const [arg1] = oneArgument(arg);
    if (!arg1) return send('Remove what?');
    const obj = getObjWear(arg1);
    if (!obj) return send('You do not have that item.');
    reply(game.remove(obj.wearLoc));
  }

  const withCarried = (verb, fn) => (arg) => {
    const [arg1] = oneArgument(arg);
    if (!arg1) return send(`${capitalise(verb)} what?`);
    const obj = getObjCarry(arg1);
    if (!obj) return send('You do not have that item.');
    reply(fn(obj));
  };

  function doDrink(arg) {
    const [arg1] = oneArgument(arg);
    if (!arg1) return reply(game.drink(null));
    const obj = getObjHere(arg1);
    if (!obj) return send("You can't find it.");
    reply(game.drink(obj));
  }

  function doSacrifice(arg) {
    const [arg1] = oneArgument(arg);
    if (!arg1 || arg1 === 'self') return send('God appreciates your offer and may accept it later.');
    const obj = getObjRoom(arg1);
    if (!obj) return send("You can't find it.");
    reply(game.sacrifice(obj));
  }

  function doCompare(arg) {
    const [arg1, rest] = oneArgument(arg);
    const [arg2] = oneArgument(rest);
    if (!arg1) return send('Compare what to what?');
    const a = getObjCarry(arg1);
    if (!a) return send('You do not have that item.');
    const b = arg2 ? getObjCarry(arg2) : null;
    if (arg2 && !b) return send('You do not have that item.');
    reply({ ...game.compare(a, b), ok: false });
  }

  // -------------------------------------------------------------- doors --

  /** open/close/lock/unlock/pick: an object here first, then a door. */
  function doorCommand(verb, onObj, onDoor) {
    return (arg) => {
      const [arg1] = oneArgument(arg);
      if (!arg1) return send(`${capitalise(verb)} what?`);
      const obj = getObjHere(arg1);
      if (obj) return reply(onObj(obj));
      const found = game.findDoor(arg1);
      if (found.error) return send(found.error);
      reply(onDoor(state.roomVnum, found.dir));
    };
  }

  // -------------------------------------------------------------- shops --

  function keeperOr() {
    const shop = game.shopHere();
    if (!shop) { send("You can't do that here."); return null; }
    if (state.act & (PLR.KILLER | PLR.THIEF)) {
      const said = `${state.act & PLR.KILLER ? 'Killers' : 'Thieves'} are not welcome!`;
      send(`${capitalise(shop.name)} says '${said}'`, { slot: shop.slot, said });
      return null;
    }
    if (!shop.open) {
      const said = state.hour < shop.hours[0] ? 'Sorry, come back later.' : 'Sorry, come back tomorrow.';
      send(`${capitalise(shop.name)} says '${said}'`, { slot: shop.slot, said });
      return null;
    }
    return shop;
  }

  function doList(arg) {
    const shop = keeperOr();
    if (!shop) return;
    const [want] = oneArgument(arg);
    const rows = shop.stock.filter((e) => !want || isName(want, e.obj.keywords));
    if (!rows.length) return send(want ? "You can't buy that here." : "You can't buy anything here.");
    send('[Lv Price] Item');
    const seen = new Set();
    for (const e of rows) {
      const key = `${e.obj.vnum}:${e.obj.level}`;
      if (seen.has(key)) continue;
      seen.add(key);
      send(`[${String(e.obj.level).padStart(2)} ${String(e.cost).padStart(5)}] ${capitalise(e.obj.name)}.`);
    }
  }

  function doBuy(arg) {
    const shop = keeperOr();
    if (!shop) return;
    const [want] = oneArgument(arg);
    if (!want) return send('Buy what?');
    const entry = findNamed(shop.stock, want, (e) => e.obj.keywords);
    if (!entry) return send(`${capitalise(shop.name)} tells you 'I don't sell that -- try 'list'.'`, { slot: shop.slot, said: "I don't sell that -- try 'list'." });
    reply(game.buy(shop.keeper, entry.obj.vnum));
  }

  function doSell(arg) {
    const shop = keeperOr();
    if (!shop) return;
    const [want] = oneArgument(arg);
    if (!want) return send('Sell what?');
    const obj = getObjCarry(want);
    if (!obj) return send(`${capitalise(shop.name)} tells you 'You don't have that item'.`, { slot: shop.slot, said: "You don't have that item." });
    reply(game.sell(shop.keeper, obj));
  }

  // --------------------------------------------------------------- fight --

  function doKill(arg) {
    const [arg1] = oneArgument(arg);
    if (!arg1) return send('Kill whom?');
    const slot = getCharRoom(arg1);
    if (!slot) return send("They aren't here.");
    if (slot === 'self') return send('You hit yourself.  Ouch!');
    if (state.position === POS.FIGHTING) return send('You do the best you can!');
    reply(game.attackSlot(slot));
  }

  function doBackstab(arg) {
    const [arg1] = oneArgument(arg);
    if (!arg1) return send('Backstab whom?');
    const slot = getCharRoom(arg1);
    if (!slot) return send("They aren't here.");
    if (slot === 'self') return send('How can you sneak up on yourself?');
    if (Math.hypot(slot.pos.x - k.position.x, slot.pos.z - k.position.z) > 3.2) {
      return send(`${capitalise(slot.proto.short)} is too far away to reach.`);
    }
    reply(game.backstab(slot));
  }

  function doSteal(arg) {
    const [arg1, rest] = oneArgument(arg);
    const [arg2] = oneArgument(rest);
    if (!arg1 || !arg2) return send('Steal what from whom?');
    const slot = getCharRoom(arg2);
    if (!slot) return send("They aren't here.");
    if (slot === 'self') return send("That's pointless.");
    if (Math.hypot(slot.pos.x - k.position.x, slot.pos.z - k.position.z) > 3.2) {
      return send(`You would have to get closer to ${slot.proto.short}.`);
    }
    const coins = ['coin', 'coins', 'gold'].includes(arg1);
    const victim = k.wake(slot);
    reply(game.steal(coins ? 'gold' : (findNamed(victim.inventory, arg1) || '-'), slot));
  }

  function doFlee() {
    if (!state.fighting) return send("You aren't fighting anyone.");
    game.breakOff();
  }

  // --------------------------------------------------------------- magic --

  /**
   * magic.c: do_cast's parsing -- `cast 'magic missile' guard`, the spell
   * quoted when it is two words -- handed to magic.js through `game.cast`,
   * which says its own refusals.
   */
  function doCast(arg) {
    if (!game.cast) return send('You do not know any spells.');
    const [spell, rest] = oneArgument(arg);
    const [who] = oneArgument(rest);
    if (!spell) return send('Cast which what where?');
    let target = null;
    let obj = null;
    if (who) {
      const slot = getCharRoom(who);
      if (slot === 'self') target = state;
      else if (slot) target = k.wake(slot);
      else obj = getObjCarry(who);
      if (!target && !obj) return send("They aren't here.");
    }
    game.cast(spell, { target, obj });
  }

  // ---------------------------------------------------------------- talk --

  function doSay(arg) {
    if (!arg) return send('Say what?');
    emit({ kind: 'say-self', text: `You say '${arg}'` });
  }

  function doEmote(arg) {
    if (!arg) return send('Emote what?');
    const text = /[a-z]$/i.test(arg) ? `${arg}.` : arg;
    emit({ kind: 'say-self', text: `${state.displayName || 'You'} ${text}` });
  }

  /** interp.c: check_social -- and a mobile at the end of one answers back, one time in... */
  function social(entry, arg) {
    const [name, charNoArg, , charFound, , , charAuto] = entry;
    if (state.position === POS.DEAD) { send('Lie still; you are DEAD.'); return true; }
    if (state.position === POS.INCAP || state.position === POS.MORTAL) { send('You are hurt far too bad for that.'); return true; }
    if (state.position === POS.STUNNED) { send('You are too stunned to do that.'); return true; }
    if (state.position === POS.SLEEPING && name !== 'snore') { send('In your dreams, or what?'); return true; }
    const [target] = oneArgument(arg);
    if (!target) { if (charNoArg) send(act(charNoArg, state)); return true; }
    const slot = getCharRoom(target);
    if (!slot) { send("They aren't here."); return true; }
    if (slot === 'self') { if (charAuto) send(act(charAuto, state)); return true; }
    const victim = k.wake(slot);
    if (charFound) send(act(charFound, state, victim));
    if (!victim.npc || hasAff(victim, AFF.CHARM) || !MERC.isAwake(victim)) return true;
    const roll = k.rng.bits(4);
    if (roll === 0) {
      k.ctx.round = { player: 0, npc: 0.5 };
      try { k.multiHit(victim, state); } finally { k.ctx.round = null; k.ctx.now = undefined; }
    } else if (roll <= 8) {
      const back = entry[5];
      if (back) emit({ kind: 'emote', slot, text: act(back, victim, state), speaker: slot.proto.short, heard: true });
    } else if (roll <= 12) {
      emit({ kind: 'emote', slot, text: act('$n slaps you.', victim, state), speaker: slot.proto.short, heard: true });
    }
    return true;
  }

  // --------------------------------------------------------- the table --

  const P = POS;
  const walk = (dir) => () => {
    if (!game.walk) return send('Alas, you cannot go that way.');
    const r = game.walk(dir);
    if (r && r.text) send(r.text);
  };
  const notHere = (text) => () => send(text);
  const alone = 'There is nobody else in this world to hear you.';

  /** cmd_table, in interp.c's order: name, function, minimum position. */
  const commands = [
    ['north', walk(0), P.STANDING], ['east', walk(1), P.STANDING], ['south', walk(2), P.STANDING],
    ['west', walk(3), P.STANDING], ['up', walk(4), P.STANDING], ['down', walk(5), P.STANDING],
    ['buy', doBuy, P.RESTING], ['cast', doCast, P.FIGHTING],
    ['exits', doExits, P.RESTING], ['get', doGet, P.RESTING], ['inventory', doInventory, P.DEAD],
    ['kill', doKill, P.FIGHTING], ['look', doLook, P.RESTING],
    ['order', notHere('You have no followers here.'), P.RESTING],
    ['rest', () => reply(game.sit()), P.RESTING], ['stand', () => reply(game.stand()), P.SLEEPING],
    ['tell', notHere(alone), P.RESTING], ['wield', doWear, P.RESTING],
    ['areas', () => { send('Loaded areas:'); for (const a of game.areas) send(`  ${a.name}`); }, P.DEAD],
    ['bug', notHere('Ok.  Thanks.'), P.DEAD],
    ['commands', () => { for (let i = 0; i < commands.length; i += 6) send(commands.slice(i, i + 6).map((c) => c[0].padEnd(12)).join('')); }, P.DEAD],
    ['compare', doCompare, P.RESTING], ['consider', doConsider, P.RESTING],
    ['credits', notHere('Diku Mud by Hans Henrik Staerfeldt, Katja Nyboe, Tom Madsen, Michael Seifert and Sebastian Hammer. Merc 2.1 by Furey, Hatchet and Kahn.'), P.DEAD],
    ['equipment', doEquipment, P.DEAD], ['examine', (arg) => {
      const [arg1] = oneArgument(arg);
      if (!arg1) return send('Examine what?');
      doLook(arg1);
      const obj = getObjHere(arg1);
      if (obj && (obj.itemType === ITEM.DRINK_CON || game.isContainer(obj))) {
        send('When you look inside, you see:');
        doLook(`in ${arg1}`);
      }
    }, P.RESTING],
    ['help', doHelp, P.DEAD], ['idea', notHere('Ok.  Thanks.'), P.DEAD],
    ['report', () => send(`You report: ${state.hit}/${state.maxHit} hp ${state.mana}/${state.maxMana} mana ${state.move}/${state.maxMove} mv ${state.exp} xp.`), P.DEAD],
    ['score', doScore, P.DEAD],
    ['socials', () => { for (let i = 0; i < SOCIALS.length; i += 6) send(SOCIALS.slice(i, i + 6).map((s) => s[0].padEnd(12)).join('')); }, P.DEAD],
    ['time', doTime, P.DEAD], ['typo', notHere('Ok.  Thanks.'), P.DEAD], ['weather', doWeather, P.RESTING],
    ['who', doWho, P.DEAD], ['channels', notHere(alone), P.DEAD],
    ['config', () => {
      send(`[ ${state.act & PLR.AUTOEXIT ? '+AUTOEXIT' : '-autoexit'} ]  config autoexit toggles the exits line on look.`);
    }, P.DEAD],
    ['description', notHere('Your description is what the town sees of you, and here it sees your gear.'), P.DEAD],
    ['password', notHere('There is no password here: this world is yours alone.'), P.DEAD],
    ['title', () => send(`Your title is the ${MERC.CLASS_TABLE[state.class].name}'s.`), P.DEAD],
    ['wimpy', doWimpy, P.DEAD],
    ['answer', notHere(alone), P.SLEEPING], ['auction', notHere(alone), P.SLEEPING], ['chat', notHere(alone), P.SLEEPING],
    ['.', notHere(alone), P.SLEEPING], ['emote', doEmote, P.RESTING], [',', doEmote, P.RESTING],
    ['gtell', notHere('You have no group.'), P.DEAD], [';', notHere('You have no group.'), P.DEAD],
    ['music', notHere(alone), P.SLEEPING], ['note', notHere('There are no notes here.'), P.RESTING],
    ['pose', notHere('You strike a pose.'), P.RESTING], ['question', notHere(alone), P.SLEEPING],
    ['reply', notHere(alone), P.RESTING], ['say', doSay, P.RESTING], ["'", doSay, P.RESTING],
    ['shout', notHere(alone), P.RESTING], ['yell', notHere(alone), P.RESTING],
    ['brandish', (a) => magicVerb('brandish', a), P.RESTING],
    ['close', doorCommand('close', game.closeObj, game.closeDoor), P.RESTING],
    ['drink', doDrink, P.RESTING], ['drop', doDrop, P.RESTING],
    ['eat', withCarried('eat', game.eat), P.RESTING],
    ['fill', withCarried('fill', game.fill), P.RESTING], ['give', doGive, P.RESTING],
    ['hold', doWear, P.RESTING], ['list', doList, P.RESTING],
    ['lock', doorCommand('lock', game.lockObj, game.lockDoor), P.RESTING],
    ['open', doorCommand('open', game.openObj, game.openDoor), P.RESTING],
    ['pick', doorCommand('pick', game.pickObj, game.pickDoor), P.RESTING],
    ['put', doPut, P.RESTING],
    ['quaff', (a) => magicVerb('quaff', a), P.RESTING], ['recite', (a) => magicVerb('recite', a), P.RESTING],
    ['remove', doRemove, P.RESTING], ['sell', doSell, P.RESTING], ['take', doGet, P.RESTING],
    ['sacrifice', doSacrifice, P.RESTING],
    ['unlock', doorCommand('unlock', game.unlockObj, game.unlockDoor), P.RESTING],
    ['value', withCarried('value', game.value), P.RESTING], ['wear', doWear, P.RESTING],
    ['zap', (a) => magicVerb('zap', a), P.RESTING],
    ['backstab', doBackstab, P.STANDING], ['bs', doBackstab, P.STANDING],
    ['disarm', () => reply(game.disarm()), P.FIGHTING], ['flee', doFlee, P.FIGHTING],
    ['kick', () => reply(game.kick()), P.FIGHTING],
    ['murde', notHere('If you want to MURDER, spell it out.'), P.FIGHTING],
    ['murder', notHere('There is no one here you may murder.'), P.FIGHTING],
    ['rescue', (a) => { const [t] = oneArgument(a); if (!t) return send('Rescue whom?'); const s = getCharRoom(t); if (!s) return send("They aren't here."); if (s === 'self') return send('What about fleeing instead?'); reply(game.rescue(s)); }, P.FIGHTING],
    ['follow', notHere('You follow no one but yourself.'), P.RESTING],
    ['group', notHere('You have no group.'), P.SLEEPING],
    ['hide', () => reply(game.hide()), P.RESTING], ['practice', doPractice, P.SLEEPING],
    ['qui', notHere('If you want to QUIT, you have to spell it out.'), P.DEAD],
    ['quit', () => (game.quit ? reply(game.quit()) : send('Ok.')), P.DEAD],
    ['recall', () => { if (!game.recall()) send('You failed!'); }, P.FIGHTING], ['/', () => game.recall(), P.FIGHTING],
    ['rent', notHere('There is no rent here.  Just save and quit.'), P.DEAD],
    ['save', () => (game.save ? reply(game.save()) : send('Ok.')), P.DEAD],
    ['sleep', () => reply(game.sleep()), P.SLEEPING], ['sneak', () => reply(game.sneak()), P.STANDING],
    ['split', notHere('You have no group to split with.'), P.RESTING],
    ['steal', doSteal, P.STANDING], ['train', (a) => reply(game.train(oneArgument(a)[0])), P.RESTING],
    ['visible', () => reply(game.visible()), P.SLEEPING],
    ['wake', (a) => { const [t] = oneArgument(a); if (!t) return reply(game.stand()); send('They are already awake.'); }, P.SLEEPING],
    ['where', (a) => doWhere(oneArgument(a)[0]), P.RESTING],
  ];

  /** quaff, recite, zap, brandish: magic.js's, through the item verbs it adds. */
  function magicVerb(verb, arg) {
    const [arg1] = oneArgument(arg);
    if (!arg1) return send(`${capitalise(verb)} what?`);
    const obj = getObjCarry(arg1) || getObjWear(arg1);
    if (!obj) return send('You do not have that item.');
    if (!game.magic || game.magic.itemVerb(obj) !== verb || !game.useItem) {
      return send(`You can ${verb} only what is made for it.`);
    }
    reply(game.useItem(obj));
  }

  /** DIVERGES: help.are is not loaded; this is the list of what there is to type. */
  function doHelp() {
    send('Moving: north east south west up down (n e s w u d), recall.');
    send('Looking: look, examine, exits, score, inventory, equipment, time, weather, where, who, consider.');
    send('Things: get, put, drop, give, wear, wield, hold, remove, eat, drink, fill, sacrifice, compare.');
    send('Doors and locks: open, close, lock, unlock, pick.');
    send('Shops: list, buy, sell, value.  Guilds: practice, train.');
    send('Fighting: kill, flee, kick, backstab, disarm, rescue, wimpy.  Thieving: sneak, hide, visible, steal.');
    send('Resting: rest, sleep, stand, wake.  Talking: say, emote, and the socials.  Keeping: save, quit.');
  }

  /**
   * interp.c: interpret. Any command brings you out of hiding. Returns the
   * command it ran, for the console's history.
   */
  function interpret(line) {
    let text = line.trim();
    if (!text) return null;
    state.affectedBy &= ~AFF.HIDE;
    let command;
    let arg;
    if (!/^[a-z0-9]/i.test(text)) { command = text[0]; arg = text.slice(1).trim(); } else {
      [command, arg] = oneArgument(text);
    }
    spoke = false;
    const off = game.listen((event) => { if (event.text && event.kind !== 'out') spoke = true; });
    try {
      const entry = [...extra, ...commands].find(([name]) => command[0] === name[0] && isPrefix(command, name));
      if (!entry) {
        const soc = SOCIALS.find((s) => command[0] === s[0][0] && isPrefix(command, s[0]));
        if (!soc || !social(soc, arg)) send('Huh?');
        return command;
      }
      const [name, fn, position] = entry;
      if (state.position < position) {
        send({
          [POS.DEAD]: 'Lie still; you are DEAD.', [POS.MORTAL]: 'You are hurt far too bad for that.',
          [POS.INCAP]: 'You are hurt far too bad for that.', [POS.STUNNED]: 'You are too stunned to do that.',
          [POS.SLEEPING]: 'In your dreams, or what?', [POS.RESTING]: 'Nah... You feel too relaxed...',
          [POS.FIGHTING]: 'No way!  You are still fighting!',
        }[state.position]);
        return name;
      }
      fn(arg || '');
      return name;
    } finally { off(); }
  }

  /** Commands added from elsewhere (magic.js's `cast`), matched before the table. */
  const extra = [];

  Object.assign(game, {
    interpret,
    addCommand(name, fn, position = POS.RESTING) { extra.push([name, fn, position]); },
    commandNames: () => [...extra, ...commands].map((c) => c[0]).filter((n) => /^[a-z]/.test(n)),
    look: () => doLook(''),
  });
  void LIQUIDS; void SECTOR; void numberArgument;
}
