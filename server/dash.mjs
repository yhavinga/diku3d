/**
 * The implementor's dashboard: the whole mud at a glance, for whoever holds
 * Merc's top trust (40, MAX_LEVEL) and nobody else.
 *
 *  - who is on: level, class, vitals, room and zone, position, idle time,
 *    link, site, KILLER/THIEF -- once a second;
 *  - what happens: logins and quits, fights begun and ended, deaths, every
 *    say, tell and channel, wizard commands, bans and the wizlock, the
 *    server's own warnings -- in batches four times a second, the last
 *    EVENT_KEEP of them in the snapshot a new subscriber is sent;
 *  - how the server is: tick time, traffic, memory, uptime, area resets;
 *  - actions, each run as the implementor's own typed command (goto,
 *    transfer, snoop, restore, wizlock), so interp.c's levels and act_wiz.c's
 *    refusals apply to them exactly as to a line in the console; and `follow`,
 *    a player's position at 10 Hz with their zone's map.
 *
 * Tells are private in Merc. act_wiz.c's snoop already lets an implementor
 * read a player's whole screen, so the owner of the server sees them here
 * too -- marked `priv`, and only ever sent to trust 40.
 *
 * Trust is read off the character on every message and before every send,
 * never taken from the client: a subscriber whose trust drops is dropped.
 * Nothing here changes the game: the listener only reads events, the fight
 * census only reads `fighting`, and an action is a command the implementor
 * could have typed.
 */

import { CLASS_TABLE } from '../src/game.js';
import { trustOf, PLR_MORE } from '../src/rules/actcomm.js';
import { PLR, oneArgument } from '../src/rules/handler.js';
import { WIZ_LEVEL } from '../src/rules/actwiz.js';

/** Merc's MAX_LEVEL: the implementor. */
export const DASH_TRUST = 40;
/** Events a new subscriber is sent from before it subscribed. */
const EVENT_KEEP = 400;
/** Seconds of tick history kept, one mean and one max a second. */
const HISTORY = 120;
/** The channel commands as act_comm.c names them (interp.c's table). */
const CHANNELS = new Map([
  ['chat', 'chat'], ['.', 'chat'], ['auction', 'auction'], ['music', 'music'], ['question', 'question'],
  ['answer', 'answer'], ['shout', 'shout'], ['yell', 'yell'], ['immtalk', 'immtalk'], [':', 'immtalk'],
]);
const POSITION = ['dead', 'mortally wounded', 'incapacitated', 'stunned', 'sleeping', 'resting', 'fighting', 'standing'];
/** A mob death is shown when a player had a hand in it, or the mobile is this strong. */
const NOTABLE_MOB_LEVEL = 20;

export function createDash({ game, w, byPc, stats, site, send, started, run }) {
  const subscribers = new Set();
  const events = [];
  let pending = [];
  let nextEvent = 1;
  /** Per player id, whom they were fighting at the last census. */
  const fights = new Map();
  const resets = { total: 0, recent: [] };
  const tickHistory = [];
  let tickWindow = { n: 0, sum: 0, max: 0 };
  let last = { at: Date.now(), msgsIn: 0, msgsOut: 0, bytesIn: 0, bytesOut: 0, dashBytes: 0, events: 0 };
  let rates = { msgsIn: 0, msgsOut: 0, kbIn: 0, kbOut: 0, kbDash: 0, events: 0 };
  let beat = 0;

  const isImplementor = (s) => !!(s && s.pc && s.open && s.linkdead === null && trustOf(s.pc.ch) >= DASH_TRUST);
  const nameOf = (ch) => (ch ? ch.name : null);
  const roomName = (vnum) => w.world.rooms.get(vnum)?.name || '?';
  const zoneOf = (vnum) => w.zoneOfVnum(vnum)?.zone || null;

  /** One line in the stream: category, words, and whatever a filter or a click needs. */
  function record(c, text, extra = {}) {
    const e = { n: nextEvent++, at: Date.now(), c, text, ...extra };
    events.push(e);
    if (events.length > EVENT_KEEP) events.shift();
    if (subscribers.size) pending.push(e);
    return e;
  }

  // ------------------------------------------------------ what the game says --
  /**
   * game.js's events, read and never touched. A say is one roomcast; a tell
   * one event to its hearer; a group tell one per member, of which the
   * speaker's own copy is kept. Channels are taken from the command instead
   * (`command`), because talk_channel sends nothing when nobody listens.
   */
  game.listen((event) => {
    switch (event.kind) {
      case 'say':
        if (event.slot || !event.speaker || event.room === undefined) return;
        record('talk', `${event.speaker} says '${event.said}'`, { who: event.speaker, vnum: event.room, sub: 'say' });
        return;
      case 'tell': {
        const to = byPc.get(event.pc)?.pc?.ch.name || '?';
        record('talk', `${event.speaker} tells ${to} '${event.said}'`, { who: event.speaker, to, priv: true, sub: 'tell' });
        return;
      }
      case 'gtell': {
        const hearer = byPc.get(event.pc)?.pc?.ch;
        if (!hearer || hearer.name !== event.speaker) return;
        record('talk', `${event.speaker} tells the group '${event.said}'`, { who: event.speaker, sub: 'gtell' });
        return;
      }
      case 'death':
        if (event.player) {
          const pc = byPc.get(event.pc)?.pc;
          if (!pc) return;
          fights.set(pc.id, null);
          record('death', `${pc.ch.name} was KILLED by ${event.by} in #${pc.ch.roomVnum} ${roomName(pc.ch.roomVnum)}`,
            { who: pc.ch.name, vnum: pc.ch.roomVnum, lvl: 'warn' });
        } else if (event.slot) {
          mobDied(event.slot);
        }
        return;
      case 'level': {
        const pc = byPc.get(event.pc)?.pc;
        if (pc) record('fight', `${pc.ch.name} reaches level ${event.level}`, { who: pc.ch.name, sub: 'level' });
        return;
      }
      case 'gate':
        if (event.all) record('fight', `${event.text}`, { vnum: event.vnum, sub: 'gate' });
        return;
      case 'ending':
        record('fight', event.text, { sub: 'gate' });
        return;
      case 'reset':
        resets.total += 1;
        resets.recent.unshift([event.area, Date.now()]);
        if (resets.recent.length > 6) resets.recent.length = 6;
        record('reset', `${event.area} resets`);
        return;
      default:
    }
  });

  /** A mobile died: by whose hand, if a player's, from the last fight census and the turn. */
  function mobDied(slot) {
    const mob = slot.instance;
    const killers = [];
    for (const s of byPc.values()) {
      if (!s.pc) continue;
      if (fights.get(s.pc.id) === mob) { killers.push(s.pc.ch.name); fights.set(s.pc.id, null); }
    }
    const turn = game.current;
    if (turn && byPc.has(turn.id) && turn.ch.roomVnum === slot.roomVnum && !killers.includes(turn.ch.name)) killers.push(turn.ch.name);
    const level = mob ? mob.level : slot.proto.level;
    if (!killers.length && level < NOTABLE_MOB_LEVEL) return;
    record('death', `${slot.proto.short} (L${level}) dies${killers.length ? ` at the hands of ${killers.join(', ')}` : ''} in #${slot.roomVnum} ${roomName(slot.roomVnum)}`,
      { who: killers[0] || null, vnum: slot.roomVnum, sub: 'mob' });
  }

  /** Fights begun and ended since the last look: fight.c sets `fighting`, nothing announces it. */
  function census() {
    for (const s of byPc.values()) {
      if (!s.pc) continue;
      const ch = s.pc.ch;
      const now = ch.fighting || null;
      const before = fights.has(s.pc.id) ? fights.get(s.pc.id) : null;
      if (now === before) continue;
      fights.set(s.pc.id, now);
      if (now) {
        const them = now.npc ? `${now.name} (L${now.level})` : now.name;
        record('fight', `${ch.name} fights ${them} in #${ch.roomVnum} ${roomName(ch.roomVnum)}`, { who: ch.name, vnum: ch.roomVnum, sub: now.npc ? 'mob' : 'pvp', lvl: now.npc ? undefined : 'warn' });
      } else if (before) {
        record('fight', `${ch.name} stops fighting ${nameOf(before)}`, { who: ch.name, sub: 'end' });
      }
    }
    for (const id of [...fights.keys()]) if (!byPc.has(id)) fights.delete(id);
  }

  /**
   * After a typed command ran: channels and wizard commands. `name` is what
   * interpret returned -- the table's name when it found one, the word typed
   * when it did not -- so the player's own command list settles which.
   */
  function command(s, line, name) {
    if (!name || !s.pc) return;
    const ch = s.pc.ch;
    const channel = CHANNELS.get(name);
    const wiz = WIZ_LEVEL.get(name);
    if (channel === undefined && wiz === undefined) return;
    const has = game.withPlayer(s.pc, () => game.commandNames().includes(name)) || !/^[a-z]/.test(name);
    if (!has || trustOf(ch) < (wiz ?? 0)) return;
    const arg = /^[a-z0-9]/i.test(line.trim()) ? oneArgument(line.trim())[1] : line.trim().slice(1).trim();
    if (channel !== undefined) {
      if (!arg || ch.act & PLR_MORE.SILENCE) return;
      record('talk', `${ch.name} ${channel}s '${arg}'`, { who: ch.name, sub: channel });
      return;
    }
    record('wiz', `${ch.name}: ${name}${arg ? ` ${arg}` : ''}`, { who: ch.name, vnum: ch.roomVnum });
  }

  // ------------------------------------------------------------ the views --
  function who() {
    const now = Date.now();
    const list = [];
    for (const s of byPc.values()) {
      if (!s.pc) continue;
      const ch = s.pc.ch;
      const zone = zoneOf(ch.roomVnum);
      const c = w.toClient(s.pc.position);
      list.push({
        id: s.pc.id, name: ch.name, level: ch.level, trust: trustOf(ch), cls: CLASS_TABLE[ch.class]?.who || '?',
        hp: ch.hit, maxHp: ch.maxHit, mana: ch.mana, maxMana: ch.maxMana, move: ch.move, maxMove: ch.maxMove,
        vnum: ch.roomVnum, room: roomName(ch.roomVnum), zone: zone ? zone.id : null, zoneName: zone ? zone.name : '?',
        pos: POSITION[ch.position] || String(ch.position),
        fighting: ch.fighting ? nameOf(ch.fighting) : null,
        idle: Math.round((now - Math.max(s.lastInput || 0, s.lastMoved || 0, s.since || 0)) / 1000),
        linkdead: s.linkdead !== null ? Math.max(0, Math.round(s.linkdead)) : null,
        host: s.host,
        flags: [ch.act & PLR.KILLER ? 'KILLER' : null, ch.act & PLR.THIEF ? 'THIEF' : null,
          ch.act & PLR_MORE.WIZINVIS ? 'WIZINVIS' : null, ch.act & PLR_MORE.FREEZE ? 'FROZEN' : null,
          ch.afk ? 'AFK' : null].filter(Boolean),
        snoopedBy: s.snoopBy && s.snoopBy.pc ? s.snoopBy.pc.ch.name : null,
        x: c ? round(c.x) : null, z: c ? round(c.z) : null, yaw: round(s.yaw || 0),
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  function health() {
    const now = Date.now();
    const mem = process.memoryUsage();
    const recent = tickHistory.slice(-5);
    const playing = [...byPc.values()].filter((s) => s.pc);
    return {
      up: Math.round((now - started) / 1000),
      players: playing.length,
      linkdead: playing.filter((s) => s.linkdead !== null).length,
      subscribers: subscribers.size,
      tickMean: recent.length ? round(recent.reduce((a, t) => a + t[0], 0) / recent.length) : 0,
      tickMax: recent.length ? round(Math.max(...recent.map((t) => t[1]))) : 0,
      ticks: tickHistory.map((t) => [round(t[0]), round(t[1])]),
      ...rates,
      rss: round(mem.rss / 1048576), heap: round(mem.heapUsed / 1048576),
      mobs: game.mobs.filter((m) => !m.dead).length, mobsAll: game.mobs.length,
      resets: { total: resets.total, recent: resets.recent.map(([area, at]) => [area, Math.round((now - at) / 1000)]) },
      wizlock: site.wizlock, bans: site.bans().slice(),
      refused: stats.refused,
    };
  }

  function track(s) {
    const t = s.dash && s.dash.follow != null ? byPc.get(s.dash.follow) : null;
    if (!t || !t.pc) return;
    const c = w.toClient(t.pc.position);
    if (!c) return;
    if (s.dash.mapZone !== c.zone) { s.dash.mapZone = c.zone; dashSend(s, { k: 'map', ...zoneMap(c.zone) }); }
    dashSend(s, { k: 'track', id: t.pc.id, zone: c.zone, vnum: t.pc.ch.roomVnum, x: round(c.x), z: round(c.z), yaw: round(t.yaw || 0) });
  }

  /** A zone's plan, in grid cells: rooms [vnum, x, z, level], streets as runs of cells. */
  const maps = new Map();
  function zoneMap(id) {
    if (maps.has(id)) return maps.get(id);
    const z = w.byId.get(id);
    const rooms = [...z.layout.cells].filter(([vnum]) => !w.built.rooms.get(vnum)?.unbuilt)
      .map(([vnum, cell]) => [vnum, cell.x, cell.z, cell.level]);
    const streets = z.layout.links.filter((l) => l.to && l.path && l.path.length)
      .map((l) => [l.from.level, l.from.x, l.from.z, ...l.path.flatMap((p) => [p.x, p.z]), l.to.x, l.to.z]);
    const map = { zone: id, name: z.zone.name, cell: 13, rooms, streets };
    maps.set(id, map);
    return map;
  }

  // ------------------------------------------------------------- the wire --
  function dashSend(s, msg) {
    const before = stats.bytesOut;
    send(s, { t: 'dash', ...msg });
    stats.dashBytes = (stats.dashBytes || 0) + (stats.bytesOut - before);
  }

  /** Every tick: `fast` is the 10 Hz beat. Batches at 4 Hz, the roster and health at 1 Hz. */
  function tick(fast, tickMs, ticksPerSecond) {
    tickWindow.n += 1; tickWindow.sum += tickMs; tickWindow.max = Math.max(tickWindow.max, tickMs);
    beat += 1;
    const quarter = beat % Math.max(1, Math.round(ticksPerSecond / 4)) === 0;
    const second = beat % ticksPerSecond === 0;
    if (second) {
      tickHistory.push([tickWindow.sum / Math.max(1, tickWindow.n), tickWindow.max]);
      if (tickHistory.length > HISTORY) tickHistory.shift();
      tickWindow = { n: 0, sum: 0, max: 0 };
      const now = Date.now();
      const dt = Math.max(0.001, (now - last.at) / 1000);
      rates = {
        msgsIn: round((stats.msgsIn - last.msgsIn) / dt), msgsOut: round((stats.msgsOut - last.msgsOut) / dt),
        kbIn: round((stats.bytesIn - last.bytesIn) / dt / 1024), kbOut: round((stats.bytesOut - last.bytesOut) / dt / 1024),
        kbDash: round(((stats.dashBytes || 0) - last.dashBytes) / dt / 1024), events: round((stats.events - last.events) / dt),
      };
      last = { at: now, msgsIn: stats.msgsIn, msgsOut: stats.msgsOut, bytesIn: stats.bytesIn, bytesOut: stats.bytesOut, dashBytes: stats.dashBytes || 0, events: stats.events };
    }
    // The census is the only cost paid without a subscriber: fights must be
    // known before anyone asks, or a kill a moment after subscribing has no killer.
    if (quarter) census();
    if (!subscribers.size) { pending = []; return; }
    let batch = null;
    if (quarter && (pending.length || second)) batch = second ? { k: 'batch', ev: pending, who: who(), health: health() } : { k: 'batch', ev: pending };
    for (const s of [...subscribers]) {
      if (!isImplementor(s)) { drop(s, s.open ? 'Your trust no longer reaches the dashboard.' : null); continue; }
      if (fast) track(s);
      if (batch) dashSend(s, batch);
    }
    if (quarter) pending = [];
  }

  function drop(s, why) {
    if (!subscribers.delete(s)) return;
    s.dash = null;
    if (why) dashSend(s, { k: 'off', why });
  }

  /**
   * A client's `dash` message. Trust is checked first, every time: below it
   * the answer is a refusal and nothing of the mud.
   */
  function onMessage(s, msg) {
    if (!isImplementor(s)) {
      // Said once, then every fiftieth time: a mortal cannot flood the stream by asking.
      s.dashRefused = (s.dashRefused || 0) + 1;
      if (s.dashRefused === 1 || s.dashRefused % 50 === 0) {
        record('server', `${s.pc ? s.pc.ch.name : s.host} asked for the dashboard (${String(msg.op).slice(0, 12)}) without the trust for it${s.dashRefused > 1 ? `, ${s.dashRefused} times` : ''}`,
          { lvl: 'warn', who: s.pc ? s.pc.ch.name : null });
      }
      return send(s, { t: 'dash', k: 'no', why: 'Huh?' });
    }
    switch (msg.op) {
      case 'sub':
        s.dash = { follow: null, mapZone: null };
        subscribers.add(s);
        return dashSend(s, { k: 'snap', ev: events.slice(), who: who(), health: health(), zones: w.zones.map((z) => [z.zone.id, z.zone.name]) });
      case 'unsub':
        return drop(s, null);
      case 'follow': {
        if (!s.dash) return dashSend(s, { k: 'did', op: 'follow', ok: false, lines: ['Subscribe first.'] });
        const t = msg.id == null ? null : byPc.get(Number(msg.id));
        s.dash.follow = t && t.pc ? t.pc.id : null;
        s.dash.mapZone = null;
        return dashSend(s, { k: 'did', op: 'follow', ok: true, id: s.dash.follow, lines: [] });
      }
      case 'goto': case 'transfer': case 'snoop': case 'restore':
        return act(s, msg.op, msg.id);
      case 'wizlock': {
        const want = !!msg.on;
        if (site.wizlock === want) return dashSend(s, { k: 'did', op: 'wizlock', ok: true, lines: [want ? 'Already wizlocked.' : 'Already open.'] });
        return dashSend(s, { k: 'did', op: 'wizlock', ok: true, lines: run(s, 'wizlock') });
      }
      default:
        return dashSend(s, { k: 'did', op: String(msg.op).slice(0, 20), ok: false, lines: ['No such dashboard action.'] });
    }
  }

  /**
   * A player-directed action: the target by id, never by a name the client
   * typed, and run as the command the implementor would have typed.
   */
  function act(s, op, id) {
    const t = byPc.get(Number(id));
    if (!t || !t.pc) return dashSend(s, { k: 'did', op, ok: false, lines: ['They are not in the game.'] });
    const name = t.pc.ch.name;
    let line = `${op} ${name}`;
    // do_snoop on someone you already snoop: snooping yourself cancels it (Merc has no other way).
    if (op === 'snoop' && t.snoopBy === s) line = `snoop ${s.pc.ch.name}`;
    return dashSend(s, { k: 'did', op, ok: true, id: t.pc.id, lines: run(s, line) });
  }

  return {
    record, command, tick, onMessage,
    /** A session closed or left the world: it hears nothing more. */
    forget(s) { subscribers.delete(s); },
    /** A reconnect hands the body to a new descriptor; the dashboard is asked for again by the page. */
    get subscribers() { return subscribers; },
  };
}

const round = (v) => Math.round(v * 100) / 100;
