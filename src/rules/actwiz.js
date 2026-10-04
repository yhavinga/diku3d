/**
 * act_wiz.c, the immortals' commands, at interp.c's levels: 36 a hero's
 * immtalk and wizhelp, 37 the angels' looking and moving, 38 the deities'
 * restore, transfer and purge, 39 the supremacies' shutdown and freeze, 40
 * the implementor's advance and trust.
 *
 * Installed on a server only (`k.multi`), appended to the command table
 * where interp.c keeps them, after every mortal command, so no mortal
 * abbreviation changes. A command above your trust is not there at all.
 *
 * What this engine cannot carry is left out rather than faked: mload (a
 * mobile here is one slot per reset line, and a new one has no body on any
 * client), and switch and return (a player's descriptor into a mobile's
 * body, which has no camera to look out of). See the server's report.
 */

import { ITEM } from '../are.js';
import { PLR, capitalise, isName, oneArgument, findNamed, canSee, nested } from './handler.js';
import { PLR_MORE, CHANNEL, trustOf, ageOf } from './actcomm.js';

const MAX_LEVEL = 40;
const LEVEL_HERO = MAX_LEVEL - 4;

/**
 * Every immortal command's level, filled in when a server installs them:
 * the server's dashboard (server/dash.mjs) reports a command as a wizard's
 * by this table, rather than by a second list that could drift from it.
 */
export const WIZ_LEVEL = new Map();

/** handler.c: affect_bit_name, for mstat. */
const AFFECT_BITS = [
  [1, 'blind'], [2, 'invisible'], [4, 'detect_evil'], [8, 'detect_invis'], [16, 'detect_magic'],
  [32, 'detect_hidden'], [128, 'sanctuary'], [256, 'faerie_fire'], [512, 'infrared'], [1024, 'curse'],
  [4096, 'poison'], [8192, 'protect'], [32768, 'sneak'], [65536, 'hide'], [131072, 'sleep'],
  [262144, 'charm'], [524288, 'flying'], [1048576, 'pass_door'],
];
const bitNames = (bits) => AFFECT_BITS.filter(([b]) => bits & b).map(([, n]) => n).join(' ') || 'none';
const ITEM_NAMES = Object.fromEntries(Object.entries(ITEM).map(([name, v]) => [v, name.toLowerCase()]));

export function installWiz(k) {
  if (!k.multi) return;
  const { world, emit, game } = k;
  const I = k.interp;
  const { send, act, getCharRoom, isPc } = I;
  const { MERC } = game;
  let state = k.state;
  k.onBind((ch) => { state = ch; });
  const Name = (ch) => capitalise(ch.name);
  const toVict = (ch, text, extra = {}) => k.tell(ch, { kind: 'room', ...extra, text });
  const toRoom = (vnum, text, except = [state]) => k.roomcast(vnum, { kind: 'room', text }, except);

  /** act_wiz.c: find_location -- a vnum, someone's room, something's room. */
  function findLocation(arg) {
    if (/^\d+$/.test(arg)) return world.rooms.get(Number(arg)) || null;
    const found = k.getCharWorld(arg);
    if (found) return world.rooms.get(found.ch.npc ? found.slot.roomVnum : found.ch.roomVnum) || null;
    const obj = getObjWorld(arg);
    return obj ? world.rooms.get(obj.inRoom) || null : null;
  }
  /** handler.c: get_obj_world -- on the ground anywhere, or carried by a player. */
  function getObjWorld(arg) {
    return findNamed(k.ground, arg) || k.players.map((pc) => findNamed([...nested(pc.ch.inventory)], arg)).find(Boolean) || null;
  }
  /** db.c: room_is_private, by the players and mobiles in it. */
  function roomIsPrivate(room) {
    const count = k.players.filter((pc) => pc.ch.roomVnum === room.vnum).length
      + k.mobs.filter((s) => !s.dead && s.roomVnum === room.vnum).length;
    return ((room.flags & 512) && count >= 2) || ((room.flags & 2048) && count >= 1);
  }
  const playerOf = (ch) => (ch && !ch.npc ? k.pcOf(ch) : null);

  /** Move a player as goto and transfer do: out with one line, in with another. */
  function moveTo(pc, room, outText, inText) {
    if (pc.ch.fighting) k.ctx.stopFighting(pc.ch, true);
    const wizinvis = pc.ch.act & PLR_MORE.WIZINVIS;
    if (outText && !wizinvis) toRoom(pc.ch.roomVnum, outText, [pc.ch]);
    if (!game.placePlayer(pc, room.vnum)) return false;
    if (inText && !wizinvis) toRoom(room.vnum, inText, [pc.ch]);
    k.withPlayer(pc, () => game.look());
    return true;
  }

  // -------------------------------------------------------------- moving --

  function doGoto(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Goto where?');
    const room = findLocation(arg);
    if (!room) return send('No such location.');
    if (roomIsPrivate(room)) return send('That room is private right now.');
    if (!moveTo(k.pc, room, `${Name(state)} ${state.bamfout || 'leaves in a swirling mist'}.`,
      `${Name(state)} ${state.bamfin || 'appears in a swirling mist'}.`)) send('There is nowhere to stand there.');
  }

  function doTransfer(argument) {
    const [arg1, rest] = oneArgument(argument);
    const [arg2] = oneArgument(rest);
    if (!arg1) return send('Transfer whom (and where)?');
    if (arg1 === 'all') {
      for (const pc of k.players.slice()) if (pc.ch !== state && canSee(state, pc.ch)) doTransfer(`${pc.ch.name} ${arg2}`);
      return;
    }
    let room = world.rooms.get(state.roomVnum);
    if (arg2) {
      room = findLocation(arg2);
      if (!room) return send('No such location.');
      if (roomIsPrivate(room)) return send('That room is private right now.');
    }
    const found = k.getCharWorld(arg1);
    if (!found) return send("They aren't here.");
    const pc = playerOf(found.ch);
    // DIVERGES: a mobile's body walks; it cannot be put down across the map.
    if (!pc) return send('Not on NPC\'s: their bodies walk.');
    if (!moveTo(pc, room, `${Name(pc.ch)} disappears in a mushroom cloud.`, `${Name(pc.ch)} arrives from a puff of smoke.`)) {
      return send('There is nowhere to stand there.');
    }
    if (pc.ch !== state) toVict(pc.ch, `${Name(state)} has transferred you.`);
    send('Ok.');
  }

  /** act_wiz.c: do_at -- a command run from another room, and back. */
  function doAt(argument) {
    const [arg, command] = oneArgument(argument);
    if (!arg || !command) return send('At where what?');
    const room = findLocation(arg);
    if (!room) return send('No such location.');
    if (roomIsPrivate(room)) return send('That room is private right now.');
    const pc = k.pc;
    const back = { ...pc.position };
    const backRoom = state.roomVnum;
    if (!game.placePlayer(pc, room.vnum, { quiet: true })) return send('There is nowhere to stand there.');
    try { game.interpret(command); } finally {
      if (k.pcOf(pc.ch)) { Object.assign(pc.position, back); pc.ch.roomVnum = backRoom; }
    }
  }

  // ----------------------------------------------------------- looking --

  function doRstat(argument) {
    const [arg] = oneArgument(argument);
    const room = arg ? findLocation(arg) : world.rooms.get(state.roomVnum);
    if (!room) return send('No such location.');
    if (room.vnum !== state.roomVnum && roomIsPrivate(room)) return send('That room is private right now.');
    send(`Name: '${room.name}.'`);
    send(`Area: '${room.area}'.`);
    send(`Vnum: ${room.vnum}.  Sector: ${room.sector}.  Light: 0.`);
    send(`Room flags: ${room.flags}.`);
    send('Description:');
    send(room.description.trim());
    if ((room.extra || []).length) send(`Extra description keywords: '${room.extra.map((e) => e.keyword).join(' ')}'.`);
    const people = [...k.players.filter((pc) => pc.ch.roomVnum === room.vnum).map((pc) => pc.ch.name),
      ...k.mobs.filter((s) => !s.dead && s.roomVnum === room.vnum).map((s) => s.proto.keywords.split(' ')[0])];
    send(`Characters: ${people.join(' ')}.`);
    send(`Objects:    ${k.ground.filter((o) => o.inRoom === room.vnum).map((o) => o.keywords.split(' ')[0]).join(' ')}.`);
    room.exits.forEach((exit, door) => {
      if (!exit) return;
      send(`Door: ${door}.  To: ${exit.to}.  Key: ${exit.key}.  Exit flags: ${exit.locks}.`);
      send(`Keyword: '${exit.keyword || ''}'.  Description: ${exit.description && exit.description.trim() ? exit.description.trim() : '(none).'}`);
    });
  }

  function doOstat(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Ostat what?');
    const obj = findNamed([...nested(state.inventory), ...state.equipment.filter(Boolean)], arg) || getObjWorld(arg);
    if (!obj) return send('Nothing like that in hell, earth, or heaven.');
    send(`Name: ${obj.keywords}.`);
    send(`Vnum: ${obj.vnum}.  Type: ${ITEM_NAMES[obj.itemType] || obj.itemType}.`);
    send(`Short description: ${obj.name}.`);
    send(`Long description: ${obj.description || ''}`);
    send(`Wear bits: ${obj.wearFlags}.  Extra bits: ${obj.extraFlags}.`);
    send(`Number: 1/${MERC.objWeight ? 1 : 1}.  Weight: ${obj.weight}/${MERC.objWeight(obj)}.`);
    send(`Cost: ${obj.cost}.  Timer: ${obj.timer}.  Level: ${obj.level}.`);
    const carrier = k.players.find((pc) => pc.ch.inventory.includes(obj) || pc.ch.equipment.includes(obj));
    send(`In room: ${obj.inRoom || 0}.  In object: (none).  Carried by: ${carrier ? carrier.ch.name : '(none)'}.  Wear_loc: ${obj.wearLoc}.`);
    send(`Values: ${obj.values.join(' ')}.`);
    for (const af of obj.affects || []) send(`Affects ${af.location} by ${af.modifier}.`);
  }

  function doMstat(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Mstat whom?');
    const found = k.getCharWorld(arg);
    if (!found) return send("They aren't here.");
    const v = found.ch;
    const room = v.npc ? found.slot.roomVnum : v.roomVnum;
    send(`Name: ${v.npc ? v.keywords : v.name}.`);
    send(`Vnum: ${v.npc ? v.vnum : 0}.  Sex: ${['neutral', 'male', 'female'][v.sex] || 'neutral'}.  Room: ${room || 0}.`);
    send(`Str: ${MERC.currStr(v)}.  Int: ${MERC.currInt(v)}.  Wis: ${MERC.currWis(v)}.  Dex: ${MERC.currDex(v)}.  Con: ${MERC.currCon(v)}.`);
    send(`Hp: ${v.hit}/${v.maxHit}.  Mana: ${v.mana ?? 0}/${v.maxMana ?? 0}.  Move: ${v.move ?? 0}/${v.maxMove ?? 0}.  Practices: ${v.practice ?? 0}.`);
    send(`Lv: ${v.level}.  Class: ${v.class ?? 0}.  Align: ${v.alignment}.  AC: ${MERC.getAc(v)}.  Gold: ${v.gold}.  Exp: ${v.exp ?? 0}.`);
    send(`Hitroll: ${MERC.getHitroll(v)}.  Damroll: ${MERC.getDamroll(v)}.  Position: ${v.position}.  Wimpy: ${v.wimpy ?? 0}.`);
    send(`Fighting: ${v.fighting ? v.fighting.name : '(none)'}.`);
    if (!v.npc) send(`Thirst: ${v.condition[2]}.  Full: ${v.condition[1]}.  Drunk: ${v.condition[0]}.  Saving throw: ${v.savingThrow || 0}.`);
    send(`Carry number: ${v.inventory.length}.  Carry weight: ${MERC.carriedWeight(v)}.`);
    send(`Age: ${v.npc ? 17 : ageOf(v)}.  Played: ${Math.trunc(v.played || 0)}.  Timer: 0.  Act: ${v.act}.`);
    send(`Master: ${v.master ? v.master.name : '(none)'}.  Leader: ${v.leader ? v.leader.name : '(none)'}.  Affected by: ${bitNames(v.affectedBy || 0)}.`);
    send(`Short description: ${v.name}.`);
    send(`Long  description: ${v.npc ? v.long.trim() : '(none).'}`);
    if (v.npc && found.slot.record.special) send('Mobile has spec fun.');
    for (const af of v.affected || []) send(`Spell: '${af.type}' modifies ${af.location || 0} by ${af.modifier || 0} for ${af.duration} hours with bits ${bitNames(af.bitvector || 0)}.`);
  }

  /** DIVERGES: 2.1 has only mstat, ostat and rstat; `stat` picks for you, as later Mercs do. */
  function doStat(argument) {
    const [arg] = oneArgument(argument);
    if (!arg || /^\d+$/.test(arg)) return doRstat(argument);
    if (k.getCharWorld(arg)) return doMstat(argument);
    if (findNamed([...nested(state.inventory), ...state.equipment.filter(Boolean)], arg) || getObjWorld(arg)) return doOstat(argument);
    send("Nothing like that in hell, earth, or heaven.");
  }

  function doMfind(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Mfind whom?');
    const all = arg === 'all';
    const hits = [...world.mobProtos.values()].filter((p) => all || isName(arg, p.keywords)).sort((a, b) => a.vnum - b.vnum);
    if (!hits.length) return send('Nothing like that in hell, earth, or heaven.');
    for (const p of hits) send(`[${String(p.vnum).padStart(5)}] ${capitalise(p.short)}`);
  }

  function doOfind(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Ofind what?');
    const all = arg === 'all';
    const hits = [...world.objProtos.values()].filter((p) => all || isName(arg, p.keywords)).sort((a, b) => a.vnum - b.vnum);
    if (!hits.length) return send('Nothing like that in hell, earth, or heaven.');
    for (const p of hits) send(`[${String(p.vnum).padStart(5)}] ${capitalise(p.short)}`);
  }

  function doMwhere(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Mwhere whom?');
    const hits = k.mobs.filter((s) => !s.dead && isName(arg, s.proto.keywords));
    if (!hits.length) return send(`You didn't find any ${arg}.`);
    for (const s of hits) {
      send(`[${String(s.proto.vnum).padStart(5)}] ${s.proto.short.padEnd(28)} [${String(s.roomVnum).padStart(5)}] ${world.rooms.get(s.roomVnum)?.name || ''}`);
    }
  }

  // ---------------------------------------------------------- the world --

  function doOload(argument) {
    const [arg1, rest] = oneArgument(argument);
    const [arg2] = oneArgument(rest);
    if (!arg1 || !/^\d+$/.test(arg1)) return send('Syntax: oload <vnum> <level>.');
    let level = trustOf(state);
    if (arg2) {
      if (!/^\d+$/.test(arg2)) return send('Syntax: oload <vnum> <level>.');
      level = Number(arg2);
      if (level < 0 || level > trustOf(state)) return send('Limited to your trust level.');
    }
    const proto = world.objProtos.get(Number(arg1));
    if (!proto) return send('No object has that vnum.');
    const obj = MERC.createObject(proto, level);
    if (obj.wearFlags & 1) state.inventory.push(obj);
    else {
      k.objToRoom(obj, state.roomVnum, k.dropSpot());
      toRoom(state.roomVnum, `${Name(state)} has created ${obj.name}!`);
    }
    send('Ok.');
  }

  /** act_wiz.c: do_purge -- the room's mobiles and objects, or one mobile. */
  function doPurge(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) {
      for (const slot of k.mobs) if (!slot.dead && slot.roomVnum === state.roomVnum) extractMob(slot);
      for (const obj of k.ground.filter((o) => o.inRoom === state.roomVnum && (o.wearFlags & 1))) k.extract(obj, k.ground);
      toRoom(state.roomVnum, `${Name(state)} purges the room!`);
      return send('Ok.');
    }
    const found = k.getCharWorld(arg);
    if (!found) return send("They aren't here.");
    if (!found.ch.npc) return send("Not on PC's.");
    if (found.slot.roomVnum === state.roomVnum) toRoom(state.roomVnum, `${Name(state)} purges ${found.ch.name}.`);
    extractMob(found.slot);
  }

  /**
   * extract_char for a mobile: gone, no corpse, no gear left behind. Here a
   * mobile is its reset line's body, so the line refills it at the area's
   * next reset, as Merc's would have made a new one.
   */
  function extractMob(slot) {
    const mob = slot.instance;
    if (mob) {
      if (mob.fighting) k.ctx.stopFighting(mob, true);
      for (const pc of k.players) if (pc.ch.fighting === mob) k.ctx.stopFighting(pc.ch, true);
    }
    slot.dead = true;
    slot.corpse = null;
    slot.instance = null;
    slot.travel = null;
    k.removeBody(slot);
  }

  /** fight.c: do_slay -- raw_kill, no experience to anyone. */
  function doSlay(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Slay whom?');
    const found = getCharRoom(arg);
    if (!found) return send("They aren't here.");
    if (found === 'self') return send('Suicide is a mortal sin.');
    const victim = isPc(found) ? found.ch : k.wake(found);
    if (!victim.npc && victim.level >= state.level) return send('You failed.');
    send(act('You slay $M in cold blood!', state, victim));
    if (!victim.npc) toVict(victim, `${Name(state)} slays you in cold blood!`);
    toRoom(state.roomVnum, `${Name(state)} slays ${victim.name} in cold blood!`, [state, victim]);
    victim.hit = -11;
    victim.position = MERC.POS.DEAD;
    // The death without the payoff: a mobile's own kill scores nothing.
    k.ctx.kill(victim.npc ? victim : state, victim);
  }

  function doPeace() {
    for (const slot of k.mobs) if (slot.instance && slot.roomVnum === state.roomVnum && slot.instance.fighting) k.ctx.stopFighting(slot.instance, true);
    for (const pc of k.players) if (pc.ch.roomVnum === state.roomVnum && pc.ch.fighting) k.ctx.stopFighting(pc.ch, true);
    send('Ok.');
  }

  function doEcho(arg) {
    if (!arg) return send('Echo what?');
    for (const pc of k.players) k.tell(pc.ch, { kind: 'echo', text: arg });
  }

  function doRecho(arg) {
    if (!arg) return send('Recho what?');
    for (const pc of k.players) if (pc.ch.roomVnum === state.roomVnum) k.tell(pc.ch, { kind: 'echo', text: arg });
  }

  // --------------------------------------------------------- the players --

  function doRestore(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Restore whom?');
    const found = k.getCharWorld(arg);
    if (!found) return send("They aren't here.");
    const v = found.ch;
    v.hit = v.maxHit;
    if (!v.npc) { v.mana = v.maxMana; v.move = v.maxMove; }
    MERC.updatePos(v);
    if (!v.npc && v !== state) toVict(v, `${Name(state)} has restored you.`);
    send('Ok.');
  }

  /** act_wiz.c: do_advance -- down to 1 and up again, or up from where they are. */
  function doAdvance(argument) {
    const [arg1, rest] = oneArgument(argument);
    const [arg2] = oneArgument(rest);
    if (!arg1 || !arg2 || !/^\d+$/.test(arg2)) return send('Syntax: advance <char> <level>.');
    const found = getCharRoom(arg1);
    if (!found) return send('That player is not here.');
    if (found !== 'self' && !isPc(found)) return send("Not on NPC's.");
    const v = found === 'self' ? state : found.ch;
    const level = Number(arg2);
    if (level < 1 || level > MAX_LEVEL) return send('Level must be 1 to 40.');
    if (level > trustOf(state)) return send('Limited to your trust level.');
    const rng = k.rng;
    if (level <= v.level) {
      send('Lowering a player\'s level!');
      toVict(v, '**** OOOOHHHHHHHHHH  NNNNOOOO ****');
      v.level = 1; v.exp = 1000; v.maxHit = 10; v.maxMana = 100; v.maxMove = 100;
      for (const key of Object.keys(v.learned)) v.learned[key] = 0;
      v.practice = 0;
      v.hit = v.maxHit; v.mana = v.maxMana; v.move = v.maxMove;
      MERC.advanceLevel(v, rng);
    } else {
      send('Raising a player\'s level!');
      toVict(v, '**** OOOOHHHHHHHHHH  YYYYEEEESSS ****');
    }
    for (let i = v.level; i < level; i++) {
      v.level += 1;
      const gains = MERC.advanceLevel(v, rng);
      toVict(v, `You raise a level!!  Your gain is: ${gains.hp} hp, ${gains.mana} m, ${gains.move} mv, ${gains.prac} prac.`);
    }
    v.exp = 1000 * Math.max(1, v.level);
    v.trust = 0;
    v.title = game.titleFor(v);
    if (k.server && k.server.save) k.server.save(v);
  }

  function doTrust(argument) {
    const [arg1, rest] = oneArgument(argument);
    const [arg2] = oneArgument(rest);
    if (!arg1 || !arg2 || !/^\d+$/.test(arg2)) return send('Syntax: trust <char> <level>.');
    const found = getCharRoom(arg1);
    if (!found || (found !== 'self' && !isPc(found))) return send('That player is not here.');
    const level = Number(arg2);
    if (level < 0 || level > MAX_LEVEL) return send('Level must be 0 (reset) or 1 to 40.');
    if (level > trustOf(state)) return send('Limited to your trust.');
    (found === 'self' ? state : found.ch).trust = level;
  }

  /** act_wiz.c: the toggles on a player beneath you -- freeze, noemote, notell, silence. */
  const toggle = (verb, bit, onText, offText) => (argument) => {
    const [arg] = oneArgument(argument);
    if (!arg) return send(`${capitalise(verb)} whom?`);
    const found = k.getCharWorld(arg);
    if (!found) return send("They aren't here.");
    const v = found.ch;
    if (v.npc) return send("Not on NPC's.");
    if (trustOf(v) >= trustOf(state)) return send('You failed.');
    if (v.act & bit) {
      v.act &= ~bit;
      toVict(v, offText);
      send(`${verb.toUpperCase()} removed.`);
    } else {
      v.act |= bit;
      toVict(v, onText);
      send(`${verb.toUpperCase()} set.`);
    }
    if (k.server && k.server.save) k.server.save(v);
  };

  function doPardon(argument) {
    const [arg1, rest] = oneArgument(argument);
    const [arg2] = oneArgument(rest);
    if (!arg1 || !arg2) return send('Syntax: pardon <character> <killer|thief>.');
    const found = k.getCharWorld(arg1);
    if (!found) return send("They aren't here.");
    const v = found.ch;
    if (v.npc) return send("Not on NPC's.");
    const flag = { killer: [PLR.KILLER, 'Killer', 'KILLER'], thief: [PLR.THIEF, 'Thief', 'THIEF'] }[arg2];
    if (!flag) return send('Syntax: pardon <character> <killer|thief>.');
    if (v.act & flag[0]) {
      v.act &= ~flag[0];
      send(`${flag[1]} flag removed.`);
      toVict(v, `You are no longer a ${flag[2]}.`);
    }
  }

  function doForce(argument) {
    const [arg, command] = oneArgument(argument);
    if (!arg || !command) return send('Force whom to do what?');
    const forceOne = (v) => {
      toVict(v, `${Name(state)} forces you to '${command}'.`);
      k.withPlayer(k.pcOf(v), () => game.interpret(command));
    };
    if (arg === 'all') {
      for (const pc of k.players.slice()) if (trustOf(pc.ch) < trustOf(state)) forceOne(pc.ch);
    } else {
      const found = k.getCharWorld(arg);
      if (!found) return send("They aren't here.");
      if (found.ch === state) return send('Aye aye, right away!');
      if (trustOf(found.ch) >= trustOf(state)) return send('Do it yourself!');
      // DIVERGES: a mobile has no command line here; only a player can be forced.
      if (found.ch.npc) return send("Not on NPC's.");
      forceOne(found.ch);
    }
    send('Ok.');
  }

  function doInvis() {
    if (state.act & PLR_MORE.WIZINVIS) {
      state.act &= ~PLR_MORE.WIZINVIS;
      toRoom(state.roomVnum, `${Name(state)} slowly fades into existence.`);
      send('You slowly fade back into existence.');
    } else {
      toRoom(state.roomVnum, `${Name(state)} slowly fades into thin air.`);
      state.act |= PLR_MORE.WIZINVIS;
      send('You slowly vanish into thin air.');
    }
  }

  function doHolylight() {
    state.act ^= PLR_MORE.HOLYLIGHT;
    send(state.act & PLR_MORE.HOLYLIGHT ? 'Holy light mode on.' : 'Holy light mode off.');
  }

  function doWizhelp() {
    const names = I.commands.filter((c) => c[3] !== undefined && c[3] >= LEVEL_HERO && c[3] <= trustOf(state)).map((c) => c[0]);
    for (let i = 0; i < names.length; i += 6) send(names.slice(i, i + 6).map((n) => n.padEnd(12)).join(''));
  }

  function doMemory() {
    const objects = k.ground.length + k.players.reduce((n, pc) => n + [...nested(pc.ch.inventory)].length, 0);
    send(`Areas   ${world.areas.length}`);
    send(`Rooms   ${world.rooms.size}`);
    send(`Mobs    ${world.mobProtos.size} prototypes, ${k.mobs.filter((s) => !s.dead).length} in the world`);
    send(`Objs    ${world.objProtos.size} prototypes, ${objects} on the ground or carried`);
    send(`Players ${k.players.length}`);
    if (typeof process !== 'undefined' && process.memoryUsage) {
      const mem = process.memoryUsage();
      send(`Heap    ${(mem.heapUsed / 1e6).toFixed(1)} of ${(mem.heapTotal / 1e6).toFixed(1)} MB`);
    }
  }

  /** act_wiz.c: do_slookup -- a skill or spell by name, or all of them. */
  function doSlookup(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Slookup what?');
    const all = [...MERC.SKILLS.map((s) => s.name), ...game.magic.SPELLS.map((s) => s.name)];
    const hits = arg === 'all' ? all : all.filter((n) => n.startsWith(arg));
    if (!hits.length) return send('No such skill or spell.');
    hits.forEach((n, i) => send(`Sn: ${String(i).padStart(4)}  Skill/spell: '${n}'`));
  }

  /** act_wiz.c: do_sset -- someone's percentage in a skill, or in all of them. */
  function doSset(argument) {
    const [arg1, rest] = oneArgument(argument);
    const [arg2, rest2] = oneArgument(rest);
    const [arg3] = oneArgument(rest2);
    if (!arg1 || !arg2 || !arg3) return send('Syntax: sset <victim> <skill> <value>  or:  sset <victim> all <value>');
    const found = getCharRoom(arg1);
    if (!found) return send("They aren't here.");
    if (found !== 'self' && !isPc(found)) return send("Not on NPC's.");
    const v = found === 'self' ? state : found.ch;
    const value = Number(arg3);
    if (!/^\d+$/.test(arg3)) return send('Value must be numeric.');
    if (value < 0 || value > 100) return send('Value range is 0 to 100.');
    if (arg2 === 'all') { for (const key of Object.keys(v.learned)) v.learned[key] = value; return send('Ok.'); }
    const skill = MERC.SKILLS.find((s) => s.name === arg2) ? MERC.SKILLS.find((s) => s.name === arg2).key
      : game.magic.SPELLS.find((s) => s.name === arg2)?.name;
    if (!skill) return send('No such skill or spell.');
    v.learned[skill] = value;
    send('Ok.');
  }

  // ------------------------------------------------- the set commands --

  /** act_wiz.c: do_mset's usage, sent whenever the arguments do not make a setting. */
  const MSET_USAGE = ['Syntax: mset <victim> <field>  <value>', 'or:     mset <victim> <string> <value>', '',
    'Field being one of:', '  str int wis dex con sex class level', '  gold hp mana move practice align',
    '  thirst drunk full', 'String being one of:', '  name short long description title spec'];
  /** smash_tilde, then arg1, arg2 and the rest as it was typed. */
  function setArgs(argument) {
    const [arg1, rest1] = oneArgument(argument.replace(/~/g, '-'));
    const [arg2, rest2] = oneArgument(rest1);
    return [arg1, arg2, rest2.trim()];
  }
  const isNumber = (text) => /^-?\d+$/.test(text);

  /**
   * act_wiz.c: do_mset -- a field on anyone in the world. Merc says nothing
   * when a setting takes; neither does this. A player is saved once set.
   */
  function doMset(argument) {
    const [arg1, arg2, arg3] = setArgs(argument);
    if (!arg1 || !arg2 || !arg3) return MSET_USAGE.forEach((line) => send(line));
    const found = k.getCharWorld(arg1);
    if (!found) return send("They aren't here.");
    const v = found.ch;
    const value = isNumber(arg3) ? Number(arg3) : -1;
    const pcOnly = () => (v.npc ? (send("Not on NPC's."), false) : true);
    const npcOnly = () => (!v.npc ? (send("Not on PC's."), false) : true);
    const ranged = (lo, hi, text) => (value < lo || value > hi ? (send(text), false) : true);
    const stat = { str: ['permStr', 'Strength'], int: ['permInt', 'Intelligence'], wis: ['permWis', 'Wisdom'], dex: ['permDex', 'Dexterity'], con: ['permCon', 'Constitution'] }[arg2];
    const done = () => { if (!v.npc && k.server && k.server.save) k.server.save(v); };
    if (stat) {
      if (!pcOnly() || !ranged(3, 18, `${stat[1]} range is 3 to 18.`)) return undefined;
      v[stat[0]] = value; return done();
    }
    switch (arg2) {
      case 'sex': if (!ranged(0, 2, 'Sex range is 0 to 2.')) return undefined; v.sex = value; return done();
      case 'class': if (!ranged(0, 3, 'Class range is 0 to 3.')) return undefined; v.class = value; return done();
      case 'level': if (!npcOnly() || !ranged(0, 50, 'Level range is 0 to 50.')) return undefined; v.level = value; return done();
      case 'gold': v.gold = value; return done();
      case 'hp': if (!ranged(-10, 30000, 'Hp range is -10 to 30,000 hit points.')) return undefined; v.maxHit = value; return done();
      case 'mana': if (!ranged(0, 30000, 'Mana range is 0 to 30,000 mana points.')) return undefined; v.maxMana = value; return done();
      case 'move': if (!ranged(0, 30000, 'Move range is 0 to 30,000 move points.')) return undefined; v.maxMove = value; return done();
      case 'practice': if (!ranged(0, 100, 'Practice range is 0 to 100 sessions.')) return undefined; v.practice = value; return done();
      case 'align': if (!ranged(-1000, 1000, 'Alignment range is -1000 to 1000.')) return undefined; v.alignment = value; return done();
      case 'thirst': if (!pcOnly() || !ranged(0, 100, 'Thirst range is 0 to 100.')) return undefined; v.condition[2] = value; return done();
      case 'drunk': if (!pcOnly() || !ranged(0, 100, 'Drunk range is 0 to 100.')) return undefined; v.condition[0] = value; return done();
      case 'full': if (!pcOnly() || !ranged(0, 100, 'Full range is 0 to 100.')) return undefined; v.condition[1] = value; return done();
      case 'name': if (!npcOnly()) return undefined; v.keywords = arg3; return undefined;
      // A mobile's short description is the name it goes by here.
      case 'short': if (v.npc) v.name = arg3; else v.shortDescr = arg3; return done();
      case 'long': if (v.npc) v.long = arg3; else v.longDescr = arg3; return done();
      case 'title': if (!pcOnly()) return undefined; v.title = /^[.,!?]/.test(arg3) ? arg3 : ` ${arg3}`; return done();
      case 'spec':
        if (!npcOnly()) return undefined;
        if (!k.SPEC_FUNS[arg3]) return send('No such spec fun.');
        // DIVERGES: the reset line's, so it outlives this body to the next reset.
        found.slot.record.special = arg3;
        return undefined;
      default: return doMset('');
    }
  }

  const OSET_USAGE = ['Syntax: oset <object> <field>  <value>', 'or:     oset <object> <string> <value>', '',
    'Field being one of:', '  value0 value1 value2 value3', '  extra wear level weight cost timer', '',
    'String being one of:', '  name short long ed'];
  /** act_wiz.c: do_oset -- a field on any object in the world. */
  function doOset(argument) {
    const [arg1, arg2, arg3] = setArgs(argument);
    if (!arg1 || !arg2 || !arg3) return OSET_USAGE.forEach((line) => send(line));
    const obj = findNamed([...nested(state.inventory), ...state.equipment.filter(Boolean)], arg1) || getObjWorld(arg1);
    if (!obj) return send('Nothing like that in hell, earth, or heaven.');
    const value = Number.parseInt(arg3, 10) || 0;
    const index = { value0: 0, v0: 0, value1: 1, v1: 1, value2: 2, v2: 2, value3: 3, v3: 3 }[arg2];
    if (index !== undefined) { obj.values[index] = value; return undefined; }
    const field = { extra: 'extraFlags', wear: 'wearFlags', level: 'level', weight: 'weight', cost: 'cost', timer: 'timer' }[arg2];
    if (field) { obj[field] = value; return undefined; }
    if (arg2 === 'name') { obj.keywords = arg3; return undefined; }
    if (arg2 === 'short') { obj.name = arg3; return undefined; }
    if (arg2 === 'long') { obj.description = arg3; return undefined; }
    if (arg2 === 'ed') {
      const [keyword, text] = oneArgument(arg3);
      obj.extra = [{ keyword, description: text }, ...(obj.extra || [])];
      return undefined;
    }
    return doOset('');
  }

  /** act_wiz.c: do_rset -- a room's flags or sector, by number. */
  function doRset(argument) {
    const [arg1, arg2, arg3] = setArgs(argument);
    if (!arg1 || !arg2 || !arg3) return ['Syntax: rset <location> <field> value', '', 'Field being one of:', '  flags sector'].forEach((line) => send(line));
    const room = findLocation(arg1);
    if (!room) return send('No such location.');
    if (!isNumber(arg3)) return send('Value must be numeric.');
    if (arg2 === 'flags') { room.flags = Number(arg3); return undefined; }
    if (arg2 === 'sector') { room.sector = Number(arg3); return undefined; }
    return doRset('');
  }

  /** act_wiz.c: do_snoop's first half; the descriptors are the server's. */
  function doSnoop(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Snoop whom?');
    const found = k.getCharWorld(arg);
    if (!found) return send("They aren't here.");
    return server('snoop', found.ch);
  }

  /** The server's own: users, shutdown, disconnect, deny, wizlock, log, dashboard. */
  const server = (name, ...args) => (k.server && k.server[name] ? k.server[name](state, ...args) : send('Not on this server.'));

  // ------------------------------------------------------------ the table --

  const P = MERC.POS.DEAD;
  // interp.c's immortal block, in its order and with its levels.
  const table = [
    ['advance', doAdvance, P, 40], ['trust', doTrust, P, 40],
    ['allow', (a) => server('allow', oneArgument(a)[0]), P, 39],
    ['ban', (a) => server('ban', oneArgument(a)[0]), P, 39],
    ['deny', (a) => server('deny', oneArgument(a)[0]), P, 39],
    ['disconnect', (a) => server('disconnect', oneArgument(a)[0]), P, 39],
    ['freeze', toggle('freeze', PLR_MORE.FREEZE, "You can't do ANYthing!", 'You can play again.'), P, 39],
    ['reboo', () => send('If you want to REBOOT, spell it out.'), P, 39],
    ['reboot', () => server('shutdown', `Reboot by ${state.name}.`), P, 39],
    ['shutdow', () => send('If you want to SHUTDOWN, spell it out.'), P, 39],
    ['shutdown', () => server('shutdown', `Shutdown by ${state.name}.`), P, 39],
    ['users', () => server('users'), P, 39],
    ['wizlock', () => server('wizlock'), P, 39],
    ['force', doForce, P, 38],
    ['noemote', toggle('noemote', PLR_MORE.NO_EMOTE, "You can't emote!", 'You can emote again.'), P, 38],
    ['notell', toggle('notell', PLR_MORE.NO_TELL, "You can't tell!", 'You can tell again.'), P, 38],
    ['mset', doMset, P, 38],
    ['oload', doOload, P, 38], ['oset', doOset, P, 38],
    ['pardon', doPardon, P, 38], ['purge', doPurge, P, 38], ['restore', doRestore, P, 38], ['rset', doRset, P, 38],
    ['silence', toggle('silence', PLR_MORE.SILENCE, 'You have been silenced!', 'You can use channels again.'), P, 38],
    ['sla', () => send('If you want to SLAY, spell it out.'), P, 38], ['slay', doSlay, P, 38],
    ['sset', doSset, P, 38], ['transfer', doTransfer, P, 38],
    ['at', doAt, P, 37],
    ['bamfin', (a) => { state.bamfin = a.replace(/~/g, '-'); send('Ok.'); }, P, 37],
    ['bamfout', (a) => { state.bamfout = a.replace(/~/g, '-'); send('Ok.'); }, P, 37],
    ['echo', doEcho, P, 37], ['goto', doGoto, P, 37], ['holylight', doHolylight, P, 37],
    ['invis', doInvis, P, 37], ['log', (a) => server('log', oneArgument(a)[0]), P, 37], ['memory', doMemory, P, 37],
    ['mfind', doMfind, P, 37], ['mstat', doMstat, P, 37], ['mwhere', doMwhere, P, 37], ['ofind', doOfind, P, 37],
    ['ostat', doOstat, P, 37], ['peace', doPeace, P, 37], ['recho', doRecho, P, 37], ['rstat', doRstat, P, 37],
    ['slookup', doSlookup, P, 37], ['snoop', doSnoop, P, 37],
    ['stat', doStat, P, 37],
    ['immtalk', (a) => k.talkChannel(a, CHANNEL.IMMTALK, 'immtalk'), P, 36],
    [':', (a) => k.talkChannel(a, CHANNEL.IMMTALK, 'immtalk'), P, 36],
    // Not Merc's: the server's dashboard (server/dash.mjs), opened on the page.
    // Last, so wizhelp's order and every abbreviation above stay interp.c's.
    ['dashboard', () => server('dashboard'), P, 40],
  ];
  const wizhelp = ['wizhelp', doWizhelp, P, 36];
  I.insert(wizhelp, 'areas');
  I.append(table);
  for (const [name, , , level] of [wizhelp, ...table]) WIZ_LEVEL.set(name, level);
  void emit;
}
