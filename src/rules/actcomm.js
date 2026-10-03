/**
 * The half of Merc that only exists with a second player in the world:
 * act_comm.c's talking, channels, tell and reply, following and groups;
 * act_info.c's who, where, title, description and config; and fight.c's
 * is_safe and check_killer, with the KILLER and THIEF flags they set.
 *
 * Installed only on a server (`k.multi`): in the page there is nobody to
 * talk to, and interp.js keeps its one-player answers ("There is nobody
 * else in this world to hear you."). Each command here takes the place of
 * that entry in interp.c's table, so `t` is still tell and `sh` shout.
 *
 * The server supplies what a descriptor list would (`k.server`): saving,
 * quitting, a password check. Everything else is the rules.
 */

import { DIR_NAME } from '../are.js';
import { AFF, PLR, capitalise, isName, oneArgument, canSee, hasAff } from './handler.js';
import { TITLES, POSES } from './titles.js';

/** merc.h: CHANNEL_*, the bits of `deaf`. */
export const CHANNEL = { AUCTION: 1, CHAT: 2, HACKER: 4, IMMTALK: 8, MUSIC: 16, QUESTION: 32, SHOUT: 64, YELL: 128 };

/** merc.h: the PLR_* bits act_comm.c and act_wiz.c read. */
export const PLR_MORE = {
  BLANK: 64, BRIEF: 128, COMBINE: 512, PROMPT: 1024, TELNET_GA: 2048, HOLYLIGHT: 4096, WIZINVIS: 8192,
  SILENCE: 32768, NO_EMOTE: 65536, NO_TELL: 262144, LOG: 524288, DENY: 1048576, FREEZE: 2097152,
};

const ROOM_SAFE = 1024;
const MAX_LEVEL = 40;
const LEVEL_HERO = MAX_LEVEL - 4;
const LEVEL_IMMORTAL = MAX_LEVEL - 3;

/** handler.c: get_age -- seventeen, and a year for every two hours played. */
export const ageOf = (ch, now = Date.now()) => 17 + Math.trunc(((ch.played || 0) + (ch.logon ? (now - ch.logon) / 1000 : 0)) / 7200);

/** nanny and advance_level: "the <title>" for the class, level and sex. */
export const titleFor = (ch) => ` the ${TITLES[ch.class][Math.min(ch.level, MAX_LEVEL)][ch.sex === 2 ? 1 : 0]}`;

/** handler.c: get_trust. */
export const trustOf = (ch) => (ch.npc ? ch.level : (ch.trust || ch.level));

export function installComm(k) {
  if (!k.multi) return;
  const { world, emit, game, rules } = k;
  const I = k.interp;
  const { send, act, getCharRoom, isPc } = I;
  const { MERC } = game;
  const { POS, CLASS_TABLE, isAwake } = MERC;
  let state = k.state;
  k.onBind((ch) => { state = ch; });

  const Name = (ch) => capitalise(ch.name);
  const isImmortal = (ch) => trustOf(ch) >= LEVEL_IMMORTAL;
  const isHero = (ch) => trustOf(ch) >= LEVEL_HERO;
  const roomOf = (ch) => world.rooms.get(ch.npc ? ch.slot.roomVnum : ch.roomVnum);
  const areaOf = (ch) => roomOf(ch)?.area;
  /** act(TO_ROOM) from the bound player. */
  const toRoom = (text, except = [state], extra = {}) => k.roomcast(state.roomVnum, { kind: 'room', ...extra, text }, except);
  /** act(TO_VICT): straight to that player's screen, whoever's turn it is. */
  const toVict = (ch, text, extra = {}) => k.tell(ch, { kind: 'room', ...extra, text });
  const playerNamed = (arg) => k.players.find((pc) => isName(arg, pc.ch.name) && canSee(state, pc.ch)) || null;

  /**
   * handler.c: get_char_world -- the room first, then everyone. Players by
   * name; a mobile anywhere by its keywords, as the mud allows.
   */
  function getCharWorld(arg) {
    const here = getCharRoom(arg);
    if (here === 'self') return { ch: state };
    if (here) return isPc(here) ? { ch: here.ch } : { ch: k.wake(here), slot: here };
    const pc = playerNamed(arg);
    if (pc) return { ch: pc.ch };
    const slot = k.mobs.find((s) => !s.dead && isName(arg, s.proto.keywords));
    return slot ? { ch: k.wake(slot, k.wanderRng), slot } : null;
  }

  // -------------------------------------------------------------- talk --

  /** act_comm.c: do_say -- "$n says '$T'." to the room. */
  function doSay(arg) {
    if (!arg) return send('Say what?');
    toRoom(`${Name(state)} says '${arg}'.`, [state], { kind: 'say', speaker: state.name, said: arg });
    emit({ kind: 'say-self', text: `You say '${arg}'.` });
  }

  /** act_comm.c: do_emote. */
  function doEmote(arg) {
    if (state.act & PLR_MORE.NO_EMOTE) return send("You can't show your emotions.");
    if (!arg) return send('Emote what?');
    const text = /[a-z]$/i.test(arg) ? `${arg}.` : arg;
    toRoom(`${Name(state)} ${text}`, [state], { kind: 'emote' });
    emit({ kind: 'say-self', text: `${Name(state)} ${text}` });
  }

  /** act_comm.c: do_pose -- a row of the table up to your level, by class. */
  function doPose() {
    const level = Math.min(state.level, POSES.length - 1);
    const pose = k.rng.range(0, level);
    send(act(POSES[pose][2 * state.class], state));
    toRoom(act(POSES[pose][2 * state.class + 1], state), [state], { kind: 'emote' });
  }

  /** act_comm.c: do_tell -- a player anywhere, a mobile only in your room. */
  function doTell(argument) {
    if (state.act & PLR_MORE.SILENCE) return send("Your message didn't get through.");
    const [arg, text] = oneArgument(argument);
    if (!arg || !text) return send('Tell whom what?');
    const found = getCharWorld(arg);
    if (!found || (found.ch.npc && found.slot.roomVnum !== state.roomVnum)) return send("They aren't here.");
    tellTo(found.ch, text);
  }

  /** act_comm.c: do_reply -- to whoever told you last. */
  function doReply(text) {
    if (state.act & PLR_MORE.SILENCE) return send("Your message didn't get through.");
    const victim = state.reply;
    if (!victim || (!victim.npc && !k.pcOf(victim))) return send("They aren't here.");
    tellTo(victim, text);
  }

  function tellTo(victim, text) {
    if (!isImmortal(state) && !isAwake(victim)) return send(act("$E can't hear you.", state, victim));
    send(`You tell ${victim.name} '${text}'.`);
    if (victim.npc) return;
    k.tell(victim, { kind: 'tell', from: null, speaker: state.name, said: text, text: `${Name(state)} tells you '${text}'.` });
    victim.reply = state;
    // DIVERGES: Merc 2.1 has no AFK. A tell to someone away is still kept.
    if (victim.afk) send(`${Name(victim)} is AFK, and will see that later.`);
  }

  /**
   * act_comm.c: talk_channel. Saying something on a channel turns it on.
   * Shout and yell keep act()'s rule that a sleeper hears nothing; the
   * others reach a sleeping player too, as the mud wakes them for it.
   */
  function talkChannel(arg, bit, verb) {
    // DIVERGES: the mud builds "Chat what?" here and never sends it.
    if (!arg) return send(`${capitalise(verb)} what?`);
    if (state.act & PLR_MORE.SILENCE) return send(`You can't ${verb}.`);
    state.deaf = (state.deaf || 0) & ~bit;
    const line = bit === CHANNEL.IMMTALK ? `${Name(state)}: ${arg}.` : `${Name(state)} ${verb}s '${arg}'.`;
    send(bit === CHANNEL.IMMTALK ? line : `You ${verb} '${arg}'.`);
    for (const pc of k.players) {
      const vch = pc.ch;
      if (vch === state || ((vch.deaf || 0) & bit)) continue;
      if (bit === CHANNEL.IMMTALK && !isHero(vch)) continue;
      if (bit === CHANNEL.YELL && areaOf(vch) !== areaOf(state)) continue;
      if ((bit === CHANNEL.SHOUT || bit === CHANNEL.YELL) && !isAwake(vch)) continue;
      k.tell(vch, { kind: 'channel', channel: verb, speaker: state.name, said: arg, text: line });
    }
  }

  /** act_info.c: do_channels -- the list, or +channel / -channel. */
  function doChannels(argument) {
    const [arg] = oneArgument(argument);
    const deaf = state.deaf || 0;
    if (!arg) {
      if (state.act & PLR_MORE.SILENCE) return send('You are silenced.');
      const on = (bit, name) => (!(deaf & bit) ? ` +${name.toUpperCase()}` : ` -${name}`);
      return send(`Channels:${on(CHANNEL.AUCTION, 'auction')}${on(CHANNEL.CHAT, 'chat')}`
        + `${isHero(state) ? on(CHANNEL.IMMTALK, 'immtalk') : ''}${on(CHANNEL.MUSIC, 'music')}`
        + `${on(CHANNEL.QUESTION, 'question')}${on(CHANNEL.SHOUT, 'shout')}${on(CHANNEL.YELL, 'yell')}.`);
    }
    if (arg[0] !== '+' && arg[0] !== '-') return send('Channels -channel or +channel?');
    const bit = { auction: CHANNEL.AUCTION, chat: CHANNEL.CHAT, immtalk: CHANNEL.IMMTALK, music: CHANNEL.MUSIC,
      question: CHANNEL.QUESTION, shout: CHANNEL.SHOUT, yell: CHANNEL.YELL }[arg.slice(1)];
    if (!bit) return send('Set or clear which channel?');
    state.deaf = arg[0] === '+' ? deaf & ~bit : deaf | bit;
    send('Ok.');
  }

  /** act_comm.c: do_gtell -- send_to_char, so it reaches sleepers too. */
  function doGtell(arg) {
    if (!arg) return send('Tell your group what?');
    if (state.act & PLR_MORE.NO_TELL) return send("Your message didn't get through!");
    const text = `${state.name} tells the group '${arg}'.`;
    for (const pc of k.players) if (isSameGroup(pc.ch, state)) k.tell(pc.ch, { kind: 'gtell', speaker: state.name, said: arg, text });
  }

  // --------------------------------------------------------- following --

  /** act_comm.c: is_same_group -- an equivalence, through the leader. */
  const isSameGroup = (a, b) => (a.leader || a) === (b.leader || b);

  function addFollower(ch, master) {
    ch.master = master;
    ch.leader = null;
    if (!master.npc && canSee(master, ch)) toVict(master, `${Name(ch)} now follows you.`);
    send(act('You now follow $N.', ch, master));
  }

  /** act_comm.c: stop_follower -- for the bound player, or `ch` from elsewhere. */
  function stopFollower(ch) {
    const master = ch.master;
    if (!master) return;
    if (!master.npc && canSee(master, ch)) toVict(master, `${Name(ch)} stops following you.`);
    toVict(ch, `You stop following ${master.name}.`);
    ch.master = null;
    ch.leader = null;
  }

  /** act_comm.c: die_follower -- leaving the world lets go of everyone. */
  function dieFollower(ch) {
    if (ch.master) stopFollower(ch);
    ch.leader = null;
    for (const pc of k.players) {
      if (pc.ch.master === ch) stopFollower(pc.ch);
      if (pc.ch.leader === ch) pc.ch.leader = pc.ch;
    }
  }

  function doFollow(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Follow whom?');
    const found = getCharRoom(arg);
    if (!found) return send("They aren't here.");
    const victim = found === 'self' ? state : (isPc(found) ? found.ch : k.wake(found));
    if (victim === state) {
      if (!state.master) return send('You already follow yourself.');
      return stopFollower(state);
    }
    if ((state.level - victim.level < -5 || state.level - victim.level > 5) && !isHero(state)) {
      return send('You are not of the right caliber to follow.');
    }
    if (state.master) stopFollower(state);
    addFollower(state, victim);
  }

  /** act_comm.c: do_group -- the list, or take someone following you in. */
  function doGroup(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) {
      const leader = state.leader || state;
      send(`${capitalise(leader.name)}'s group:`);
      for (const pc of k.players) {
        const g = pc.ch;
        if (!isSameGroup(g, state)) continue;
        send(`[${String(g.level).padStart(2)} ${CLASS_TABLE[g.class].who}] ${capitalise(g.name).padEnd(16)} `
          + `${String(g.hit).padStart(4)}/${String(g.maxHit).padStart(4)} hp ${String(g.mana).padStart(4)}/${String(g.maxMana).padStart(4)} mana `
          + `${String(g.move).padStart(4)}/${String(g.maxMove).padStart(4)} mv ${String(g.exp).padStart(5)} xp`);
      }
      return;
    }
    const found = getCharRoom(arg);
    if (!found) return send("They aren't here.");
    if (!isPc(found) && found !== 'self') return send(act("$N isn't following you.", state, k.wake(found)));
    const victim = found === 'self' ? state : found.ch;
    if (state.master || (state.leader && state.leader !== state)) return send('But you are following someone else!');
    if (victim.master !== state && victim !== state) return send(act("$N isn't following you.", state, victim));
    if (isSameGroup(victim, state) && victim !== state) {
      victim.leader = null;
      toRoom(`${Name(state)} removes ${victim.name} from ${his(state)} group.`, [state, victim]);
      toVict(victim, `${Name(state)} removes you from ${his(state)} group.`);
      return send(`You remove ${victim.name} from your group.`);
    }
    if (state.level - victim.level < -5 || state.level - victim.level > 5) {
      toRoom(`${Name(victim)} cannot join ${state.name}'s group.`, [state, victim]);
      toVict(victim, `You cannot join ${state.name}'s group.`);
      return send(`${Name(victim)} cannot join your group.`);
    }
    victim.leader = state;
    toRoom(`${Name(victim)} joins ${state.name}'s group.`, [state, victim]);
    toVict(victim, `You join ${state.name}'s group.`);
    send(`${Name(victim)} joins your group.`);
  }
  const his = (ch) => ['its', 'his', 'her'][ch.sex] || 'its';

  /** act_comm.c: do_split -- gold among the group members in the room. */
  function doSplit(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Split how much?');
    const amount = Number.parseInt(arg, 10) || 0;
    if (amount < 0) return send("Your group wouldn't like that.");
    if (amount === 0) return send('You hand out zero coins, but no one notices.');
    if (state.gold < amount) return send("You don't have that much gold.");
    const members = k.players.filter((pc) => pc.ch.roomVnum === state.roomVnum && isSameGroup(pc.ch, state));
    if (members.length < 2) return send('Just keep it all.');
    const share = Math.trunc(amount / members.length);
    const extra = amount % members.length;
    if (share === 0) return send("Don't even bother, cheapskate.");
    state.gold -= amount;
    state.gold += share + extra;
    send(`You split ${amount} gold coins.  Your share is ${share + extra} gold coins.`);
    for (const pc of members) {
      if (pc.ch === state) continue;
      toVict(pc.ch, `${Name(state)} splits ${amount} gold coins.  Your share is ${share} gold coins.`);
      pc.ch.gold += share;
    }
  }

  /** act_comm.c: do_order -- only charmed followers obey, and nothing here charms. */
  function doOrder(argument) {
    const [arg, rest] = oneArgument(argument);
    if (!arg || !rest) return send('Order whom to do what?');
    if (hasAff(state, AFF.CHARM)) return send('You feel like taking, not giving, orders.');
    if (arg !== 'all') {
      const found = getCharRoom(arg);
      if (!found) return send("They aren't here.");
      if (found === 'self') return send('Aye aye, right away!');
      return send('Do it yourself!');
    }
    send('You have no followers here.');
  }

  // ------------------------------------------------------- who and where --

  /** act_info.c: do_who -- level range and classes, "imm" for heroes and up. */
  function doWho(argument) {
    let lower = 0;
    let upper = MAX_LEVEL;
    let numbers = 0;
    let classes = null;
    let immortalOnly = false;
    for (let rest = argument; ;) {
      const [arg, after] = oneArgument(rest);
      rest = after;
      if (!arg) break;
      if (/^\d+$/.test(arg)) {
        numbers += 1;
        if (numbers === 1) lower = Number(arg);
        else if (numbers === 2) upper = Number(arg);
        else return send('Only two level numbers allowed.');
        continue;
      }
      if (arg.length < 3) return send('Classes must be longer than that.');
      const three = arg.slice(0, 3);
      if (three === 'imm') { immortalOnly = true; continue; }
      const index = CLASS_TABLE.findIndex((c) => c.who.toLowerCase() === three);
      if (index < 0) return send("That's not a class.");
      (classes = classes || new Set()).add(index);
    }
    const lines = [];
    for (const pc of k.players) {
      const w = pc.ch;
      if (!canSee(state, w)) continue;
      if (w.level < lower || w.level > upper || (immortalOnly && w.level < LEVEL_HERO) || (classes && !classes.has(w.class))) continue;
      const klass = { [MAX_LEVEL]: 'GOD', [MAX_LEVEL - 1]: 'SUP', [MAX_LEVEL - 2]: 'DEI', [MAX_LEVEL - 3]: 'ANG' }[w.level]
        || CLASS_TABLE[w.class].who;
      lines.push(`[${String(w.level).padStart(2)} ${klass}] ${w.act & PLR.KILLER ? '(KILLER) ' : ''}${w.act & PLR.THIEF ? '(THIEF) ' : ''}`
        + `${w.afk ? '(AFK) ' : ''}${w.name}${w.title || ''}`);
    }
    send(`${lines.length} player${lines.length === 1 ? '' : 's'}.`);
    lines.forEach((line) => send(line));
  }

  /** act_info.c: do_where -- the players in your area, or the first one named. */
  function doWhere(argument) {
    const [arg] = oneArgument(argument);
    const area = areaOf(state);
    if (!arg) {
      send('Players near you:');
      const near = k.players.filter((pc) => areaOf(pc.ch) === area && canSee(state, pc.ch));
      if (!near.length) return send('None');
      for (const pc of near) send(`${pc.ch.name.padEnd(28)} ${roomOf(pc.ch)?.name || ''}`);
      return;
    }
    const hidden = (ch) => hasAff(ch, AFF.HIDE) || hasAff(ch, AFF.SNEAK);
    for (const pc of k.players) {
      if (areaOf(pc.ch) === area && !hidden(pc.ch) && canSee(state, pc.ch) && isName(arg, pc.ch.name)) {
        return send(`${pc.ch.name.padEnd(28)} ${roomOf(pc.ch)?.name || ''}`);
      }
    }
    for (const slot of k.mobs) {
      if (slot.dead || world.rooms.get(slot.roomVnum)?.area !== area || !isName(arg, slot.proto.keywords)) continue;
      if (slot.instance && (hidden(slot.instance) || !canSee(state, slot.instance))) continue;
      return send(`${capitalise(slot.proto.short).padEnd(28)} ${world.rooms.get(slot.roomVnum).name}`);
    }
    send(`You didn't find any ${arg}.`);
  }

  // ------------------------------------------------------------ yourself --

  /** act_info.c: do_title and set_title. */
  function doTitle(arg) {
    if (!arg) return send('Change your title to what?');
    const title = arg.slice(0, 50).replace(/~/g, '-');
    state.title = /^[a-z0-9]/i.test(title) ? ` ${title}` : title;
    send('Ok.');
  }

  /** act_info.c: do_description -- replace it, or "+ more" to add a line. */
  function doDescription(arg) {
    if (arg) {
      let text = arg.replace(/~/g, '-');
      let before = '';
      if (text[0] === '+') { before = state.description || ''; text = text.slice(1).trimStart(); }
      if (before.length + text.length >= 4600) return send('Description too long.');
      state.description = `${before}${text}\n`;
    }
    send('Your description is:');
    send(state.description ? state.description.trim() : '(None).');
  }

  /** act_info.c: do_config -- the list, or +keyword / -keyword. */
  const CONFIG = [
    ['autoexit', PLR.AUTOEXIT, 'You automatically see exits.', "You don't automatically see exits."],
    ['autoloot', PLR.AUTOLOOT, 'You automatically loot corpses.', "You don't automatically loot corpses."],
    ['autosac', PLR.AUTOSAC, 'You automatically sacrifice corpses.', "You don't automatically sacrifice corpses."],
    ['blank', PLR_MORE.BLANK, 'You have a blank line before your prompt.', 'You have no blank line before your prompt.'],
    ['brief', PLR_MORE.BRIEF, 'You see brief descriptions.', 'You see long descriptions.'],
    ['combine', PLR_MORE.COMBINE, 'You see object lists in combined format.', 'You see object lists in single format.'],
    ['prompt', PLR_MORE.PROMPT, 'You have a prompt.', "You don't have a prompt."],
    ['telnetga', PLR_MORE.TELNET_GA, 'You receive a telnet GA sequence.', "You don't receive a telnet GA sequence."],
  ];
  function doConfig(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) {
      send('[ Keyword  ] Option');
      for (const [word, bit, on, off] of CONFIG) {
        send(state.act & bit ? `[+${word.toUpperCase().padEnd(9)}] ${on}` : `[-${word.padEnd(9)}] ${off}`);
      }
      return;
    }
    if (arg[0] !== '+' && arg[0] !== '-') return send('Config -option or +option?');
    const entry = CONFIG.find(([word]) => word === arg.slice(1));
    if (!entry) return send('Config which option?');
    if (arg[0] === '+') state.act |= entry[1]; else state.act &= ~entry[1];
    send('Ok.');
  }

  /** act_info.c: do_report -- to you, and to the room. */
  function doReport() {
    const s = state;
    send(`You report: ${s.hit}/${s.maxHit} hp ${s.mana}/${s.maxMana} mana ${s.move}/${s.maxMove} mv ${s.exp} xp.`);
    toRoom(`${Name(s)} reports: ${s.hit}/${s.maxHit} hp ${s.mana}/${s.maxMana} mana ${s.move}/${s.maxMove} mv ${s.exp} xp.`);
  }

  /** DIVERGES: Merc 2.1 has no AFK; a browser tab left open is the usual reason for one. */
  function doAfk() {
    state.afk = !state.afk;
    send(state.afk ? 'You are now away from keyboard.' : 'You are back.');
    toRoom(state.afk ? `${Name(state)} is away from the keyboard.` : `${Name(state)} is back.`);
  }

  // ----------------------------------------------------- player killing --

  /**
   * fight.c: is_safe. The mud's own two rules: you must be 21 (eight hours
   * played -- get_age adds a year for every two), and you may only attack a
   * player of a *higher* level than your own -- which is how 2.1 reads, not
   * a slip here. A player already fighting you is always fair game.
   *
   * DIVERGES: the area files mark the Temple and the Altar ROOM_SAFE, but
   * Merc 2.1 only reads that flag in spell_summon. Here no violence between
   * players starts in a safe room either.
   */
  function isSafe(ch, victim, quiet = false) {
    if (ch.npc || victim.npc) return false;
    if (victim.fighting === ch) return false;
    const say = (text) => { if (!quiet) k.withPlayer(k.pcOf(ch), () => emit({ kind: 'note', text })); };
    if ((roomOf(ch)?.flags & ROOM_SAFE) || (roomOf(victim)?.flags & ROOM_SAFE)) { say('Not in a place of sanctuary.'); return true; }
    if (ageOf(ch) < 21) { say("You aren't old enough."); return true; }
    if (ch.level >= victim.level) { say('You may not attack a lower level player.'); return true; }
    return false;
  }

  /** fight.c: check_killer -- attacking an innocent player makes you a KILLER. */
  function checkKiller(ch, victim) {
    if (victim.npc || (victim.act & PLR.KILLER) || (victim.act & PLR.THIEF)) return;
    if (ch.npc || ch === victim || ch.level >= LEVEL_IMMORTAL || (ch.act & PLR.KILLER)) return;
    ch.act |= PLR.KILLER;
    k.withPlayer(k.pcOf(ch), () => emit({ kind: 'note', text: '*** You are now a KILLER!! ***' }));
    if (k.server && k.server.save) k.server.save(ch);
  }

  /** fight.c: do_kill on a player -- only a KILLER or THIEF; do_murder for the rest. */
  function killPlayer(victim, murder) {
    if (!murder && !(victim.act & PLR.KILLER) && !(victim.act & PLR.THIEF)) return send('You must MURDER a player.');
    if (isSafe(state, victim)) return;
    if (state.position === POS.FIGHTING) return send('You do the best you can!');
    if (murder) {
      // "Help!  I am being attacked by $n!" -- do_shout, from the victim.
      const text = `Help!  I am being attacked by ${state.name}!`;
      k.withPlayer(k.pcOf(victim), () => talkChannel(text, CHANNEL.SHOUT, 'shout'));
    }
    const r = game.attackPlayer(victim);
    if (r.text) send(r.text);
  }

  function doMurder(argument) {
    const [arg] = oneArgument(argument);
    if (!arg) return send('Murder whom?');
    const found = getCharRoom(arg);
    if (!found) return send("They aren't here.");
    if (found === 'self') return send('Suicide is a mortal sin.');
    if (!isPc(found)) {
      // do_murder on a mobile is do_kill without the refusal for players.
      if (state.position === POS.FIGHTING) return send('You do the best you can!');
      const r = game.attackSlot(found);
      if (r && r.text) send(r.text);
      return;
    }
    killPlayer(found.ch, true);
  }

  /**
   * act_obj.c: do_steal from a player. 2.1 fails it every time -- the
   * `!IS_NPC(victim)` test sits in the failure branch -- so all a thief
   * gets from another player is caught, shouted at, and a THIEF flag.
   */
  function stealFromPlayer(victim) {
    state.wait = Math.max(state.wait, 24);
    send('Oops.');
    toVict(victim, `${Name(state)} tried to steal from you.`);
    toRoom(`${Name(state)} tried to steal from ${victim.name}.`, [state, victim]);
    const shout = `${state.name} is a bloody thief!`;
    k.withPlayer(k.pcOf(victim), () => talkChannel(shout, CHANNEL.SHOUT, 'shout'));
    if (!(state.act & PLR.THIEF)) {
      state.act |= PLR.THIEF;
      send('*** You are now a THIEF!! ***');
      if (k.server && k.server.save) k.server.save(state);
    }
  }

  /** act_obj.c: do_give, to a player. */
  function giveToPlayer(obj, victim) {
    if (obj.extraFlags & 128) return send("You can't let go of it.");
    if (victim.inventory.length + 1 > MERC.canCarryN(victim)) return send(`${Name(victim)} has ${his(victim)} hands full.`);
    if (MERC.carriedWeight(victim) + MERC.objWeight(obj) > MERC.canCarryW(victim)) return send(`${Name(victim)} can't carry that much weight.`);
    state.inventory.splice(state.inventory.indexOf(obj), 1);
    victim.inventory.push(obj);
    toRoom(`${Name(state)} gives ${obj.name} to ${victim.name}.`, [state, victim]);
    k.tell(victim, { kind: 'give', text: `${Name(state)} gives you ${obj.name}.`, item: obj.name });
    emit({ kind: 'give', text: `You give ${obj.name} to ${victim.name}.`, item: obj.name });
  }

  function giveGoldToPlayer(amount, victim) {
    if (!(amount > 0)) return send("Sorry, you can't do that.");
    if (state.gold < amount) return send("You haven't got that much gold.");
    state.gold -= amount;
    victim.gold += amount;
    k.tell(victim, { kind: 'gold', amount, text: `${Name(state)} gives you some gold.` });
    toRoom(`${Name(state)} gives ${victim.name} some gold.`, [state, victim]);
    send(`You give ${victim.name} some gold.`);
    send('OK.');
  }

  /** fight.c: do_rescue, of a player -- you take over the fight. */
  function rescuePlayer(victim) {
    if (state.fighting === victim) return send('Too late.');
    const fch = victim.fighting;
    if (!fch) return send('That person is not fighting right now.');
    state.wait = Math.max(state.wait, 12);
    if (k.rng.percent() > (state.learned.rescue || 0)) return send('You fail the rescue.');
    send(`You rescue ${victim.name}!`);
    toVict(victim, `${Name(state)} rescues you!`);
    toRoom(`${Name(state)} rescues ${victim.name}!`, [state, victim]);
    k.ctx.stopFighting(fch, false);
    k.ctx.stopFighting(victim, false);
    checkKiller(state, fch);
    k.ctx.setFighting(state, fch);
    k.ctx.setFighting(fch, state);
  }

  // ------------------------------------------------- comings and goings --

  /**
   * act_move.c: move_char, the half that is not the walking -- which here is
   * the body's: the room is told who left which way and who arrived, and
   * anyone standing who follows you is sent after you.
   */
  rules.playerMoved = (from, to) => {
    const dir = world.rooms.get(from)?.exits.findIndex((e) => e && e.to === to) ?? -1;
    if (!hasAff(state, AFF.SNEAK) && !(state.act & PLR_MORE.WIZINVIS)) {
      k.roomcast(from, { kind: 'room', moved: 'leave', text: dir >= 0 ? `${Name(state)} leaves ${DIR_NAME[dir]}.` : `${Name(state)} leaves.` }, [state]);
      k.roomcast(to, { kind: 'room', moved: 'arrive', text: `${Name(state)} has arrived.` }, [state]);
    }
    if (dir >= 0) followed(state, from, to, dir);
  };
  rules.mobMoved = (slot, from, to, dir) => { if (slot.instance) followed(slot.instance, from, to, dir); };

  /** Every standing follower of `leader` still in `from` is told to go `dir`. */
  function followed(leader, from, to, dir) {
    for (const pc of k.players) {
      const fch = pc.ch;
      if (fch.master !== leader || fch.roomVnum !== from || fch.position !== POS.STANDING) continue;
      k.tell(fch, { kind: 'follow', dir, from, to, leader: leader.name, text: `You follow ${leader.name}.` });
    }
  }

  rules.playerLeaving = (ch) => dieFollower(ch);
  rules.isSafe = isSafe;
  rules.checkKiller = checkKiller;
  /** fight.c: group_gain's members -- everyone in the killer's group in the room. */
  rules.groupGain = (killer) => {
    const members = k.players.filter((pc) => pc.ch.roomVnum === killer.roomVnum && isSameGroup(pc.ch, killer)).map((pc) => pc.ch);
    return members.length ? members : [killer];
  };
  rules.groupMayShare = (gch, killer) => {
    const lch = killer.leader || killer;
    if (gch.level - lch.level > 5) { emit({ kind: 'note', text: 'You are too high for this group.' }); return false; }
    if (gch.level - lch.level < -5) { emit({ kind: 'note', text: 'You are too low for this group.' }); return false; }
    return true;
  };
  // advance_level's set_title: every level, the class's title for it.
  game.listen((event) => {
    if (event.kind !== 'level' || event.pc === undefined) return;
    const pc = k.players.find((p) => p.id === event.pc);
    if (pc) pc.ch.title = titleFor(pc.ch);
  });

  // ------------------------------------------------------------ the table --

  const P = POS;
  const channel = (bit, verb) => (arg) => talkChannel(arg, bit, verb);
  I.replace('tell', doTell);
  I.replace('reply', doReply);
  I.replace('say', doSay);
  I.replace("'", doSay);
  I.replace('emote', doEmote);
  I.replace(',', doEmote);
  I.replace('pose', doPose);
  I.replace('chat', channel(CHANNEL.CHAT, 'chat'));
  I.replace('.', channel(CHANNEL.CHAT, 'chat'));
  I.replace('auction', channel(CHANNEL.AUCTION, 'auction'));
  I.replace('music', channel(CHANNEL.MUSIC, 'music'));
  I.replace('question', channel(CHANNEL.QUESTION, 'question'));
  I.replace('answer', channel(CHANNEL.QUESTION, 'answer'));
  I.replace('shout', (arg) => { talkChannel(arg, CHANNEL.SHOUT, 'shout'); state.wait = Math.max(state.wait, 12); });
  I.replace('yell', channel(CHANNEL.YELL, 'yell'));
  I.replace('channels', doChannels);
  I.replace('gtell', doGtell);
  I.replace(';', doGtell);
  I.replace('follow', doFollow);
  I.replace('group', doGroup);
  I.replace('split', doSplit);
  I.replace('order', doOrder);
  I.replace('who', doWho);
  I.replace('where', doWhere);
  I.replace('title', doTitle);
  I.replace('description', doDescription);
  I.replace('config', doConfig);
  I.replace('report', doReport);
  I.replace('murde', () => send('If you want to MURDER, spell it out.'));
  I.replace('murder', doMurder);
  I.replace('password', (arg) => (k.server && k.server.password ? k.server.password(state, arg) : send('Ok.')));
  I.replace('quit', () => (k.server && k.server.quit ? k.server.quit(state) : send('Ok.')));
  I.replace('save', () => { if (k.server && k.server.save) k.server.save(state); send('Ok.'); });
  I.replace('commands', () => {
    const names = I.commands.filter((c) => c[3] === undefined || c[3] <= trustOf(state)).map((c) => c[0]).filter((n) => /^[a-z]/.test(n));
    for (let i = 0; i < names.length; i += 6) send(names.slice(i, i + 6).map((n) => n.padEnd(12)).join(''));
  });
  // Not in interp.c: in the table's last stretch before the immortals' own.
  I.insert(['afk', doAfk, P.DEAD], 'where');
  // interp.c's levels for the mortal commands that have one.
  for (const [name, level] of [['shout', 3], ['murder', 5], ['murde', 5]]) I.commands.find((c) => c[0] === name)[3] = level;

  Object.assign(k, {
    killPlayer, stealFromPlayer, giveToPlayer, giveGoldToPlayer, rescuePlayer,
    getCharWorld, isSameGroup, stopFollower, dieFollower, talkChannel, isSafe,
  });
  Object.assign(game, {
    /** For a server: the channel bits, and what the world says of a player. */
    CHANNEL, isSafe: (ch, victim) => isSafe(ch, victim, true), titleFor, ageOf, trustOf,
  });
}
