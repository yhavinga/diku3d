/**
 * The mud: one game.js running every area for every player, and the
 * descriptor list round it -- comm.c's nanny for logging in, the game loop's
 * pulse, and what each connected client is sent so it can draw the world.
 *
 * game.js already speaks in events; on a server each carries who it is for
 * (`pc`, `room`, `all`, or nothing: then where it happened decides), and
 * `route` below hands every one to the right descriptors, rewritten for each
 * reader: "you" is the reader, a slot is a mobile's index, a player an id,
 * and a point is in the reader's own zone's frame.
 *
 * What a client draws but the server does not stream: how a mobile strolls
 * inside its room. That comes from the clock (see src/link.js); the server
 * sends only what the mud decides -- rooms, fights, deaths, the ground.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { WebSocketServer } from 'ws';

import { createGame, createCharacter, POS, CLASS_TABLE } from '../src/game.js';
import { serialize, restore } from '../src/save.js';
import { titleFor, trustOf, PLR_MORE } from '../src/rules/actcomm.js';
import { PLR, nested } from '../src/rules/handler.js';
import { bootWorld } from './world.mjs';
import { EX_ISDOOR, EX_CLOSED, EX_LOCKED } from '../src/are.js';
import { createNotes, createSite } from './store.mjs';
import { createDash } from './dash.mjs';
import {
  createAccounts, hashPassword, checkPassword, checkParseName, properName, EXTRA,
} from './accounts.mjs';

/**
 * 2: positions are checked and answered with `at`, which a page must obey
 * or every later report is dropped as stale; and `shop`, `gates`, the
 * reconnect token in `enter`. `doors` came later and needs no new number:
 * a page that does not know it ignores it.
 */
export const PROTOCOL = 2;
const ROOM_VNUM_TEMPLE = 3001;
/** How far another player is seen from: the far end of a street, not the zone. */
const SIGHT = 160;
/** Seconds a player whose link dropped stays standing in the world. */
const LINKDEAD_SECONDS = 180;
/** Autosave, as char_update's oldest-save-first does every few minutes. */
const AUTOSAVE_SECONDS = 300;

export async function startMud({
  root, dataDir, port = 4011, host = '127.0.0.1', seed, tickMs = 50, log = console.log,
  wizlock = false, server = null,
} = {}) {
  const started = Date.now();
  const w = bootWorld(root, { log });
  const accounts = createAccounts(dataDir);
  const notes = createNotes(dataDir);
  // The ban list and the wizlock, kept across reboots; `wizlock` is only the first boot's.
  const site = createSite(dataDir, { wizlock });
  const sessions = new Set();
  const byPc = new Map();
  let nextPcId = 1;
  const stats = { refused: 0, events: 0, routed: 0, dropped: 0, msgsOut: 0, bytesOut: 0, msgsIn: 0, bytesIn: 0, dashBytes: 0, ticks: 0, tickMs: 0, tickMax: 0 };

  // -------------------------------------------------------------- the game --
  const hooks = {
    save: (ch) => { const s = sessionOf(ch); if (s) saveSession(s); },
    quit: (ch) => quit(sessionOf(ch)),
    password: (ch, arg) => changePassword(sessionOf(ch), arg),
    users: (ch) => users(ch),
    shutdown: (ch, text) => shutdown(text),
    disconnect: (ch, name) => disconnect(ch, name),
    deny: (ch, name) => deny(ch, name),
    wizlock: (ch) => {
      site.wizlock = !site.wizlock;
      say(ch, site.wizlock ? 'Game wizlocked.' : 'Game un-wizlocked.');
      dash.record('site', `${ch.name} ${site.wizlock ? 'wizlocked the game' : 'lifted the wizlock'}`, { who: ch.name, lvl: 'warn' });
    },
    ban: (ch, arg) => ban(ch, arg),
    allow: (ch, arg) => allow(ch, arg),
    snoop: (ch, name) => snoop(ch, name),
    notes,
    log: (ch, name) => toggleLog(ch, name),
    // The page opens the dashboard on this; what it shows is asked for apart (dash.mjs).
    dashboard: (ch) => game.tell(ch, { kind: 'dashboard' }),
  };
  const game = createGame({
    world: w.world, layout: w.layout, built: w.built, nav: w.nav, seed,
    zoneOf: (vnum) => w.plan.zoneOf(vnum), server: hooks,
  });
  log(`game: ${game.mobs.length} mobiles, ${game.ground.length} objects on the ground, ${Date.now() - started} ms to boot`);
  // A mobile never leaves its zone (game.js sameZone): its zone is its home's.
  const mobZone = game.mobs.map((slot) => w.zoneOfVnum(slot.originRoom ?? slot.roomVnum)?.zone.id ?? null);
  const slotIndex = new Map(game.mobs.map((slot, i) => [slot, i]));
  const mobsInZone = new Map();
  game.mobs.forEach((slot, i) => {
    const z = mobZone[i];
    if (!mobsInZone.has(z)) mobsInZone.set(z, []);
    mobsInZone.get(z).push(i);
  });
  // recall, teleport: the one whose turn it is goes to the room's middle.
  game.onTeleport = (x, y, z, vnum) => {
    const pc = game.current;
    if (!pc) return;
    if (x === undefined) game.placePlayer(pc, vnum, { quiet: true });
    else { pc.position.x = x; pc.position.y = y + 1.72; pc.position.z = z; pc.ch.roomVnum = vnum; }
  };
  game.listen(route);
  const dash = createDash({ game, w, byPc, stats, site, send, started, run: runFor });
  game.listen((event) => {
    // advance_level saves the character (save.c); so does a level here.
    if (event.kind === 'level' && event.pc != null) { const s = byPc.get(event.pc); if (s) saveSession(s); }
  });

  /** A world fingerprint the client checks: same files, same mobiles, same order. */
  const fingerprint = (() => {
    let h = 2166136261;
    const mix = (n) => { h ^= n; h = Math.imul(h, 16777619) >>> 0; };
    for (const slot of game.mobs) { mix(slot.proto.vnum); mix(slot.originRoom ?? slot.roomVnum); }
    return { rooms: w.world.rooms.size, mobs: game.mobs.length, hash: h.toString(16) };
  })();

  // ---------------------------------------------------------- the clock --
  let last = performance.now();
  const timer = setInterval(() => {
    const t0 = performance.now();
    const dt = Math.min(0.25, (t0 - last) / 1000);
    last = t0;
    game.tick(dt);
    stats.ticks += 1;
    for (const s of sessions) {
      if (s.pc) s.played += dt;
      if (s.pc && s.linkdead !== null && (s.linkdead -= dt) <= 0) extract(s, `${s.pc.ch.name} has left the game.`);
    }
    reap();
    const fast = stats.ticks % Math.max(1, Math.round(100 / tickMs)) === 0;
    for (const s of sessions) {
      if (!s.pc || !s.open) continue;
      if (fast) { sendSelf(s); sendMobs(s); sendGround(s); sendPlayers(s); sendShop(s); sendGates(s); sendDoors(s); }
      flush(s);
      if ((s.saveIn -= dt) <= 0) { s.saveIn = AUTOSAVE_SECONDS; saveSession(s); }
    }
    if (fast) sendWeather();
    const ms = performance.now() - t0;
    stats.tickMs += ms;
    stats.tickMax = Math.max(stats.tickMax, ms);
    dash.tick(fast, ms, Math.round(1000 / tickMs));
  }, tickMs);

  /**
   * do_who's count as someone with no character would see it: no wizinvis
   * immortal, and no lost link -- Merc's who walks the descriptors, and a
   * linkdead character has none.
   */
  const online = () => [...byPc.values()]
    .filter((o) => o.pc && o.linkdead === null && !(o.pc.ch.act & PLR_MORE.WIZINVIS)).length;

  // ------------------------------------------------------------- sockets --
  const wss = server ? new WebSocketServer({ server }) : new WebSocketServer({ port, host });
  await new Promise((resolve) => (server ? resolve() : wss.once('listening', resolve)));
  const address = wss.address();
  log(`listening on ws://${host}:${address.port}/ws`);

  // Behind nginx and Cloudflare every socket comes from loopback; the
  // player's own address is in the header nginx passes on. Only trusted
  // from loopback, or anyone could claim any site past a ban.
  const siteOf = (request) => {
    const peer = request.socket.remoteAddress || '?';
    const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    const told = loopback && (request.headers['x-real-ip'] || '').trim();
    return told || peer;
  };

  wss.on('connection', (ws, request) => {
    const s = {
      ws, open: true, host: siteOf(request), state: 'name', pc: null, record: null,
      out: [], zone: null, seq: 0, posAt: null, played: 0, saveIn: AUTOSAVE_SECONDS, linkdead: null, logged: false,
      sent: { self: '', mobs: new Map(), ground: new Map(), roster: new Map(), weather: '' }, pending: null,
    };
    // comm.c: new_descriptor -- a banned site hears why, and nothing else.
    if (site.banned(s.host)) {
      log(`${s.host}: banned site refused`);
      dash.record('site', `${s.host}: a banned site was refused`, { lvl: 'warn' });
      send(s, { t: 'bye', why: 'Your site has been banned from this Mud.' });
      s.open = false;
      ws.close();
      return;
    }
    sessions.add(s);
    // `features`: what this server offers past the protocol; a page asks only for what is listed.
    // `online` is for the title screen, which asks before anyone logs in.
    send(s, { t: 'hello', v: PROTOCOL, features: ['dash'], world: fingerprint, online: online(), motd: 'Welcome to Merc Diku Mud.  May your visit here be ... Mercenary.' });
    ws.on('message', (data) => {
      stats.msgsIn += 1;
      stats.bytesIn += data.length;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (error) { return sendError(s, `bad message: ${error.message}`); }
      // Not swallowed: a command that throws is logged with its stack and the
      // player is told where, and the mud goes on for everyone else.
      onMessage(s, msg).catch((error) => {
        log(`error handling ${msg && msg.t} from ${s.pc ? s.pc.ch.name : s.host}: ${error.stack}`);
        dash.record('server', `error handling ${msg && msg.t} from ${s.pc ? s.pc.ch.name : s.host}: ${error.message} (${(error.stack || '').split('\n')[1]?.trim() || 'no stack'})`, { lvl: 'error' });
        sendError(s, `The mud stumbles: ${error.message} (${(error.stack || '').split('\n')[1]?.trim() || 'no stack'})`);
      }).finally(reap);
    });
    ws.on('close', () => {
      s.open = false;
      if (s.pc && s.linkdead === null) {
        // comm.c: close_socket -- the character stays, "$n has lost $s link."
        const ch = s.pc.ch;
        game.roomcast(ch.roomVnum, { kind: 'room', text: `${ch.name} has lost ${['its', 'his', 'her'][ch.sex] || 'its'} link.` }, [ch]);
        s.linkdead = LINKDEAD_SECONDS;
        saveSession(s);
        log(`${ch.name}@${s.host}: link lost`);
        dash.record('conn', `${ch.name}@${s.host} lost the link`, { who: ch.name, sub: 'linkdead' });
      } else if (!s.pc) sessions.delete(s);
      dash.forget(s);
    });
  });

  function send(s, msg) {
    if (!s.open || s.ws.readyState !== 1) return;
    const text = JSON.stringify(msg);
    stats.msgsOut += 1;
    stats.bytesOut += text.length;
    s.ws.send(text);
  }
  const sendError = (s, text) => send(s, { t: 'ev', e: [{ kind: 'error', text }] });
  const say = (ch, text) => game.tell(ch, { kind: 'out', text });
  const sessionOf = (ch) => byPc.get(game.pcOf(ch)?.id) || null;

  // ------------------------------------------------------------ the nanny --
  async function onMessage(s, msg) {
    switch (msg.t) {
      case 'ping': return send(s, { t: 'pong', at: msg.at, now: Date.now() - started });
      case 'login': return login(s, msg);
      case 'create': return create(s, msg);
      default: break;
    }
    if (!s.pc || s.linkdead !== null) return sendError(s, 'Not playing: log in first.');
    switch (msg.t) {
      case 'pos': return position(s, msg);
      case 'cmd': return command(s, String(msg.line || '').slice(0, 400));
      case 'op': return operation(s, msg);
      case 'dash': return dash.onMessage(s, msg);
      default: return sendError(s, `unknown message ${JSON.stringify(msg.t)}`);
    }
  }

  async function login(s, { name: raw = '', password = '', token = null }) {
    if (s.pc) return;
    const name = properName(String(raw).trim());
    // A page whose link dropped asks for its body back with the token it was
    // given on entering, not the password, which it never kept. Only while
    // that body still stands in the world (LINKDEAD_SECONDS).
    if (token !== null) {
      const body = [...sessions].find((o) => o !== s && o.pc && o.pc.ch.name === name && o.token && sameToken(o.token, String(token)));
      if (!body) return send(s, { t: 'login', ok: false, why: 'Your link is gone; log in again.' });
      return enter(s, body.record, false);
    }
    if (!checkParseName(name, w.world)) return send(s, { t: 'login', ok: false, why: 'Illegal name, try another.' });
    const record = accounts.load(name);
    if (!record) return send(s, { t: 'login', ok: false, new: true, name, why: `Did I get that right, ${name} (Y/N)?` });
    if (record.char.act & PLR_MORE.DENY) return send(s, { t: 'login', ok: false, why: 'You are denied access.' });
    if (!(await checkPassword(String(password), record.password))) {
      log(`${name}@${s.host}: wrong password`);
      dash.record('conn', `${name}@${s.host}: wrong password`, { who: name, lvl: 'warn', sub: 'refused' });
      return send(s, { t: 'login', ok: false, why: 'Wrong password.' });
    }
    // IS_HERO: by trust, which is what lets an immortal past a wizlock.
    if (site.wizlock && (record.char.trust || record.char.level) < 36) return send(s, { t: 'login', ok: false, why: 'The game is wizlocked.' });
    enter(s, record, false);
  }

  async function create(s, { name: raw = '', password = '', cls, sex }) {
    if (s.pc) return;
    const name = properName(String(raw).trim());
    if (!checkParseName(name, w.world)) return send(s, { t: 'login', ok: false, why: 'Illegal name, try another.' });
    if (accounts.exists(name)) return send(s, { t: 'login', ok: false, why: 'That name is taken.' });
    if (String(password).length < 5) return send(s, { t: 'login', ok: false, new: true, name, why: 'Password must be at least five characters long.' });
    if (site.wizlock) return send(s, { t: 'login', ok: false, why: 'The game is wizlocked.' });
    const classIndex = Number(cls);
    if (!(classIndex >= 0 && classIndex < CLASS_TABLE.length)) return send(s, { t: 'login', ok: false, new: true, name, why: "That's not a class." });
    const sexIndex = { m: 1, f: 2, n: 0 }[String(sex || 'm').toLowerCase()[0]] ?? 1;
    const ch = createCharacter(classIndex, { sex: sexIndex });
    ch.name = name;
    ch.displayName = name;
    const record = {
      version: 1, name, created: new Date().toISOString(),
      password: await hashPassword(String(password)),
      char: { ...serialize(ch), room: ROOM_VNUM_TEMPLE, title: titleFor(ch), played: 0 },
    };
    accounts.store(record);
    log(`${name}@${s.host} new player.`);
    enter(s, record, true);
  }

  /** CON_READ_MOTD: into the world -- or back into the body a dropped link left. */
  function enter(s, record, fresh) {
    const name = record.name;
    // check_reconnect: a body already standing in the world under this name.
    const old = [...sessions].find((o) => o !== s && o.pc && o.pc.ch.name === name);
    if (old) {
      // DIVERGES: 2.1 refuses a second login while the first link is up
      // ("Already playing."); a browser reload is that second login, so the
      // new link takes the body over.
      if (old.open) { send(old, { t: 'bye', why: 'Someone logged in as you elsewhere.' }); old.open = false; old.ws.close(); }
      s.pc = old.pc; s.record = old.record; s.played = old.played; s.zone = old.zone; s.logged = old.logged;
      // Snooping, either way, follows the descriptor over.
      s.snoopBy = old.snoopBy || null;
      for (const o of sessions) if (o.snoopBy === old) o.snoopBy = s;
      dash.forget(old);
      s.since = old.since; s.lastInput = old.lastInput; s.lastMoved = old.lastMoved;
      old.pc = null;
      sessions.delete(old);
      byPc.set(s.pc.id, s);
      s.linkdead = null;
      const ch = s.pc.ch;
      game.roomcast(ch.roomVnum, { kind: 'room', text: `${ch.name} has reconnected.` }, [ch]);
      log(`${name}@${s.host} reconnected.`);
      dash.record('conn', `${name}@${s.host} reconnected`, { who: name, sub: 'reconnect' });
      welcome(s, 'Reconnecting.');
      return;
    }
    const ch = createCharacter(record.char.class ?? 3, { sex: record.char.sex ?? 1 });
    const room = restore(ch, record.char, w.world, POS);
    for (const key of EXTRA) if (record.char[key] !== undefined) ch[key] = record.char[key];
    ch.name = name;
    ch.displayName = name;
    ch.logon = Date.now();
    ch.hour = 12;
    const vnum = w.built.rooms.has(room) && !w.built.rooms.get(room).unbuilt ? room : ROOM_VNUM_TEMPLE;
    const pc = game.addPlayer(ch, { id: nextPcId++ });
    game.placePlayer(pc, vnum, { quiet: true });
    s.pc = pc;
    s.record = record;
    s.played = 0;
    s.linkdead = null;
    byPc.set(pc.id, s);
    log(`${name}@${s.host} has ${fresh ? 'entered the game as a new player' : 'connected'}.`);
    s.since = Date.now();
    dash.record('conn', `${name}@${s.host} ${fresh ? 'entered the game as a new player' : 'logged in'} (L${ch.level} ${CLASS_TABLE[ch.class]?.who || '?'}) in #${vnum}`,
      { who: name, vnum, sub: fresh ? 'new' : 'login' });
    game.roomcast(vnum, { kind: 'room', text: `${name} has entered the game.` }, [ch]);
    welcome(s, '\nWelcome to Merc Diku Mud.  May your visit here be ... Mercenary.');
  }

  const sameToken = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  function welcome(s, text) {
    const pc = s.pc;
    s.token = randomBytes(24).toString('base64url');
    s.seq += 1;
    s.posAt = null;
    s.navRoom = null;
    s.sent = { self: '', kit: '', mobs: new Map(), ground: new Map(), roster: new Map(), weather: '' };
    send(s, {
      t: 'enter', id: pc.id, name: pc.ch.name, room: pc.ch.roomVnum, seq: s.seq, now: Date.now() - started, token: s.token,
      trust: trustOf(pc.ch),
    });
    sendSelf(s);
    sendWeather(s);
    game.tell(pc.ch, { kind: 'out', text });
    game.withPlayer(pc, () => game.look());
  }

  // ---------------------------------------------------- what a client says --
  /**
   * Where a client says its player is, checked before it is believed
   * (world.mjs `judge`): the body is the page's to walk, but not to put
   * anywhere it likes. A report refused puts the client back where the
   * server has it (`at`). Never a kick: a page that lagged or fell is put
   * back, not thrown out.
   */
  function position(s, msg) {
    const { zone, x, y, z, yaw = 0, seq = 0 } = msg;
    // A report from before the last jump would put the body back where it was.
    if (seq < s.seq) return;
    const local = w.byId.get(zone);
    if (!local || ![x, y, z, yaw].every(Number.isFinite)) return sendError(s, `bad position in zone ${JSON.stringify(zone)}`);
    const pc = s.pc;
    const now = performance.now();
    const sx = x + local.offset;
    // The client stands on build.js's floor; the server's game on the grid.
    const sy = y - w.liftAt(sx, y - 1.72, z);
    const judged = w.judge(s, pc, sx, sy, z, now);
    const why = judged.why;
    if (why) {
      stats.refused += 1;
      s.refused = (s.refused || 0) + 1;
      if (s.refused <= 3 || s.refused % 50 === 0) {
        log(`${pc.ch.name}@${s.host}: position refused (${why}) at ${zone} ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}, ${s.refused} so far`);
        dash.record('server', `${pc.ch.name}: position refused (${why}), ${s.refused} so far`, { who: pc.ch.name, lvl: 'warn' });
      }
      return resync(s, why);
    }
    if (Math.abs(sx - pc.position.x) + Math.abs(z - pc.position.z) > 0.05 || Math.abs(yaw - (s.yaw || 0)) > 0.02) s.lastMoved = Date.now();
    pc.position.x = sx; pc.position.y = sy; pc.position.z = z;
    pc.facing.x = -Math.sin(yaw); pc.facing.z = -Math.cos(yaw);
    s.zone = zone;
    s.yaw = yaw;
    s.posAt = now;
    s.navRoom = judged.room;
  }

  /** Put the client back where the server has its player, under a new sequence number. */
  function resync(s, why) {
    const pc = s.pc;
    s.seq += 1;
    s.posAt = null;
    const c = w.toClient(pc.position);
    const lift = w.liftAt(pc.position.x, pc.position.y - 1.72, pc.position.z);
    send(s, {
      t: 'at', seq: s.seq, room: pc.ch.roomVnum, zone: c ? c.zone : null, why,
      x: c ? round(c.x) : null, y: round(pc.position.y - 1.72 + lift), z: round(pc.position.z),
    });
  }

  function command(s, line) {
    const pc = s.pc;
    s.lastInput = Date.now();
    if (pc.ch.act & PLR_MORE.LOG || s.logged) log(`Log ${pc.ch.name}: ${line}`);
    const name = game.withPlayer(pc, () => game.interpret(line));
    dash.command(s, line, name);
  }

  /** A line run as `s`'s own command, and what it told them: the dashboard's actions. */
  function runFor(s, line) {
    const lines = [];
    const off = game.listen((event) => { if (event.pc === s.pc.id && event.text) lines.push(event.text); });
    try { command(s, line); } finally { off(); }
    return lines;
  }

  /**
   * The page's own verbs (game-ui.js): a click, E on a thing, a panel's
   * button. Each is a game.js method run as this player's turn, its
   * arguments by reference ({ o }, { m }, { p }) and its refusal sent back.
   */
  const OPS = new Set([
    'attackSlot', 'take', 'takeAll', 'wear', 'wield', 'remove', 'drop', 'put', 'getFrom', 'useItem', 'cast',
    'buy', 'sell', 'practice', 'train', 'openObj', 'closeObj', 'lockObj', 'unlockObj', 'pickObj',
    'openDoor', 'closeDoor', 'lockDoor', 'unlockDoor', 'pickDoor', 'useDoor', 'rest', 'sit', 'sleep', 'stand',
    'sneak', 'hide', 'visible', 'recall', 'breakOff', 'useAction', 'kick', 'backstab', 'disarm', 'steal',
    'rescue', 'drink', 'eat', 'fill', 'sacrifice', 'dropGold', 'dropAll', 'wearAll', 'value', 'compare',
    'setTimeOfDay', 'focus',
  ]);
  function operation(s, { op, a = [] }) {
    if (!OPS.has(op) || typeof game[op] !== 'function') return sendError(s, `no such action ${JSON.stringify(op)}`);
    const pc = s.pc;
    if (op !== 'focus') s.lastInput = Date.now();
    if (pc.ch.act & PLR_MORE.FREEZE) return game.tell(pc.ch, { kind: 'note', text: "You're totally frozen!" });
    game.withPlayer(pc, () => {
      if (op === 'focus') { pc.focusSlot = a[0] && a[0].m !== undefined ? game.mobs[a[0].m] || null : null; return; }
      const args = a.map((arg) => decode(pc, arg));
      if (args.some((arg) => arg === MISSING)) return game.tell(pc.ch, { kind: 'note', text: "You don't see that here." });
      const result = op === 'cast' ? game.cast(args[0], args[1] || {}) : game[op](...args);
      const results = Array.isArray(result) ? result : [result];
      for (const r of results) if (r && !r.ok && r.text && op !== 'cast' && op !== 'useItem') game.tell(pc.ch, { kind: 'note', text: r.text });
    });
  }

  // ------------------------------------------------------------ references --
  const objIds = new WeakMap();
  let nextObj = 1;
  const idOf = (obj) => { let id = objIds.get(obj); if (!id) { id = nextObj++; objIds.set(obj, id); } return id; };
  const MISSING = Symbol('missing');
  /** A reference from a client, back into the world -- only what this player could touch. */
  function decode(pc, arg) {
    if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) return arg;
    if (arg.o !== undefined) {
      const lists = [pc.ch.inventory, pc.ch.equipment.filter(Boolean), game.ground.filter((o) => o.inRoom === pc.ch.roomVnum || near(o.at, pc.position, 8))];
      for (const list of lists) for (const obj of nested(list)) if (objIds.get(obj) === arg.o) return obj;
      return MISSING;
    }
    if (arg.m !== undefined) return game.mobs[arg.m] || MISSING;
    if (arg.p !== undefined) return byPc.get(arg.p)?.pc.ch || MISSING;
    // A plain options object (cast's { target }, useItem's { targetObj }).
    const out = {};
    for (const [key, value] of Object.entries(arg)) {
      const v = decode(pc, value);
      if (v === MISSING) return MISSING;
      // cast wants the mobile itself, not its slot.
      out[key] = v && v.record && v.proto ? (key === 'target' ? game.wakeSlot(v) : v) : v;
    }
    return out;
  }
  const near = (a, b, r) => !!(a && b && Math.abs(a.x - b.x) < r && Math.abs(a.z - b.z) < r);

  /**
   * One event, rewritten for one reader: "you" is the reader (a null
   * `from`/`to` or `fromPlayer`), a mobile is its slot's index, another
   * player an id, an object its id, and a point is in the reader's zone.
   */
  function encode(event, reader) {
    const out = {};
    const self = reader.pc.ch;
    const who = (ch) => (!ch ? null : (ch === self ? null : (ch.npc ? (ch.slot ? { m: slotIndex.get(ch.slot) } : null) : { p: game.pcOf(ch)?.id ?? -1 })));
    for (const [key, value] of Object.entries(event)) {
      if (key === 'fromCh' || key === 'toCh' || key === 'pc' || key === 'room' || key === 'except' || key === 'all' || key === 'near') continue;
      if (value === undefined || typeof value === 'function') continue;
      if ((key === 'from' || key === 'to') && ('fromCh' in event || 'toCh' in event)) {
        out[key] = who(key === 'from' ? event.fromCh : event.toCh);
        continue;
      }
      out[key] = plain(value, reader);
    }
    if ('fromCh' in event) out.fromPlayer = event.fromCh === self;
    if ('toCh' in event) out.toPlayer = event.toCh === self;
    if (typeof event.x === 'number') Object.assign(out, local(reader, { x: event.x, y: event.y, z: event.z }));
    return out;
  }
  /** A value in an event, as far as it means anything on the wire. */
  function plain(value, reader, depth = 0) {
    if (value === null || typeof value !== 'object') return value;
    if (depth > 3) return undefined;
    if (value.record && value.proto && slotIndex.has(value)) return { m: slotIndex.get(value) };
    if (value.itemType !== undefined && Array.isArray(value.values)) return { o: idOf(value), name: value.name };
    if (value.npc !== undefined) return value.npc ? { m: slotIndex.get(value.slot) } : { p: game.pcOf(value)?.id ?? -1, name: value.name };
    if (Array.isArray(value)) return value.map((v) => plain(v, reader, depth + 1));
    if (typeof value.x === 'number' && typeof value.z === 'number' && Object.keys(value).length <= 3) return local(reader, value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'warden' || typeof v === 'function') continue;
      const p = plain(v, reader, depth + 1);
      if (p !== undefined) out[k] = p;
    }
    return out;
  }
  /** A point in the server's frame, in the reader's zone's. */
  function local(reader, p) {
    const c = w.toClient(p);
    return c ? { x: round(c.x), y: round(p.y), z: round(c.z) } : { x: p.x, y: p.y, z: p.z };
  }
  const round = (v) => Math.round(v * 100) / 100;

  /** Who an event is for (see the top of this file), and on to them. */
  function route(event) {
    stats.events += 1;
    const readers = [];
    const playing = [...byPc.values()].filter((s) => s.pc && s.linkdead === null);
    if (event.pc !== undefined && event.pc !== null) {
      const s = byPc.get(event.pc);
      if (s) readers.push(s);
    } else if (event.all) {
      readers.push(...playing);
    } else if (event.room !== undefined) {
      const except = new Set(event.except || []);
      for (const s of playing) {
        const ch = s.pc.ch;
        if (except.has(s.pc.id)) continue;
        // act(TO_ROOM) reaches only those awake.
        if (ch.position <= POS.SLEEPING) continue;
        const nearBy = event.near && Math.hypot(event.near.x - s.pc.position.x, event.near.z - s.pc.position.z) < 14
          && Math.abs(event.near.y - (s.pc.position.y - 1.72)) < 4;
        if (ch.roomVnum === event.room || nearBy) readers.push(s);
      }
    } else {
      // Said where it happened: the room of whatever it is about, or near it.
      const slot = [event.slot, event.from, event.to].find((v) => v && v.record && v.pos);
      const at = slot ? slot.pos : (typeof event.x === 'number' ? event : null);
      const vnum = slot ? slot.roomVnum : event.vnum;
      if (!at && vnum === undefined) { stats.dropped += 1; return; }
      for (const s of playing) {
        const p = s.pc.position;
        if ((vnum !== undefined && s.pc.ch.roomVnum === vnum) || (at && Math.hypot(at.x - p.x, at.z - p.z) < 20)) readers.push(s);
      }
    }
    for (const s of readers) {
      const out = encode(event, s);
      if (event.kind === 'teleport' || event.kind === 'recall') { s.seq += 1; out.seq = s.seq; s.posAt = null; s.navRoom = null; }
      s.out.push(out);
      stats.routed += 1;
    }
  }

  function flush(s) {
    if (!s.out.length) return;
    // comm.c: process_output's snoop-o-rama -- everything the victim reads, after "% ".
    const by = s.snoopBy;
    if (by && by.pc && by.open) {
      for (const e of s.out) if (e.text) by.out.push({ kind: 'snoop', text: `% ${e.text}` });
    }
    send(s, { t: 'ev', e: s.out });
    s.out = [];
  }

  // ----------------------------------------------------- what a client sees --
  /** The character itself, as save.js writes it, objects with their ids. */
  function sendSelf(s) {
    const ch = s.pc.ch;
    const data = serialize(ch);
    delete data.savedAt;
    const withIds = (list, objs) => list.forEach((o, i) => {
      if (!o) return;
      o.id = idOf(objs[i]);
      if (o.contains && o.contains.length) withIds(o.contains, objs[i].contains);
    });
    withIds(data.inventory, ch.inventory);
    withIds(data.equipment, ch.equipment);
    data.name = ch.name;
    data.title = ch.title || '';
    data.wait = ch.wait;
    data.hour = ch.hour;
    data.trust = trustOf(ch);
    data.fighting = ch.fighting ? (ch.fighting.npc ? { m: slotIndex.get(ch.fighting.slot) } : { p: game.pcOf(ch.fighting)?.id ?? -1 }) : null;
    data.afk = !!ch.afk;
    data.age = game.ageOf(ch);
    // The kit (what is carried and known) changes far less often than the
    // vitals (a WAIT_STATE counts down four times a second): sent apart.
    const kit = { inventory: data.inventory, equipment: data.equipment, learned: data.learned, affected: data.affected };
    for (const key of Object.keys(kit)) delete data[key];
    const core = JSON.stringify(data);
    const kitText = JSON.stringify(kit);
    const kitChanged = kitText !== s.sent.kit;
    if (core === s.sent.self && !kitChanged) return;
    s.sent.self = core;
    s.sent.kit = kitText;
    send(s, kitChanged ? { t: 'self', c: data, k: kit } : { t: 'self', c: data });
  }

  /**
   * The mobiles of the reader's zone, each as [room, body, fighting, hp, max
   * hp, level, travelling to, by door]: body 0 standing, 1 a corpse, 2 gone.
   * Only what changed since the last send.
   */
  function sendMobs(s) {
    const zone = s.zone || w.zoneOfVnum(s.pc.ch.roomVnum)?.zone.id;
    if (!zone) return;
    if (s.sent.mobZone !== zone) { s.sent.mobs = new Map(); s.sent.mobZone = zone; }
    const changed = [];
    for (const i of mobsInZone.get(zone) || []) {
      const slot = game.mobs[i];
      const mob = slot.instance;
      const fighting = mob && mob.fighting ? (mob.fighting.npc ? { m: slotIndex.get(mob.fighting.slot) }
        : (mob.fighting === s.pc.ch ? { me: 1 } : { p: game.pcOf(mob.fighting)?.id ?? -1 })) : null;
      const view = [slot.roomVnum, slot.dead ? (slot.corpse ? 1 : 2) : 0, fighting,
        mob ? mob.hit : null, mob ? mob.maxHit : null, mob ? mob.level : null,
        slot.travel ? slot.travel.to : null, slot.travel ? slot.travel.door : null];
      const key = JSON.stringify(view);
      if (s.sent.mobs.get(i) === key) continue;
      s.sent.mobs.set(i, key);
      changed.push([i, ...view]);
    }
    if (changed.length) send(s, { t: 'mob', z: zone, m: changed });
  }

  /** Everything lying in the reader's zone, whole, when any of it changed. */
  function sendGround(s) {
    const zone = s.zone || w.zoneOfVnum(s.pc.ch.roomVnum)?.zone.id;
    if (!zone) return;
    const z = w.byId.get(zone);
    const list = [];
    const objView = (obj) => ({
      id: idOf(obj), vnum: obj.vnum, name: obj.name, keywords: obj.keywords, description: obj.description,
      itemType: obj.itemType, wearFlags: obj.wearFlags, extraFlags: obj.extraFlags, values: obj.values,
      weight: obj.weight, cost: obj.cost, level: obj.level, timer: obj.timer,
      contains: (obj.contains || []).map(objView),
    });
    for (const obj of game.ground) {
      if (obj.inRoom === null || w.zoneOfVnum(obj.inRoom) !== z || !obj.at) continue;
      const view = objView(obj);
      view.inRoom = obj.inRoom;
      view.at = local(s, obj.at);
      if (obj.resetIndex !== undefined) view.resetIndex = obj.resetIndex;
      if (obj.radius) view.radius = obj.radius;
      if (obj.slot) view.corpseOf = slotIndex.get(obj.slot);
      if (obj.owner) view.owner = obj.owner;
      if (obj.look) view.look = obj.look;
      list.push(view);
    }
    const text = JSON.stringify(list);
    if (s.sent.ground.get(zone) === text) return;
    s.sent.ground = new Map([[zone, text]]);
    send(s, { t: 'ground', z: zone, o: list });
  }

  /**
   * The other players: who they are (when that changes) and where they are
   * (every send, ~10 Hz), for those in the reader's zone within SIGHT.
   */
  function sendPlayers(s) {
    const me = s.pc;
    const roster = [];
    const pos = [];
    const seen = new Set();
    for (const o of byPc.values()) {
      if (o === s || !o.pc || o.zone !== s.zone || !o.zone) continue;
      const ch = o.pc.ch;
      if (ch.act & PLR_MORE.WIZINVIS && trustOf(s.pc.ch) < trustOf(ch)) continue;
      const p = o.pc.position;
      if (Math.hypot(p.x - me.position.x, p.z - me.position.z) > SIGHT) continue;
      seen.add(o.pc.id);
      const info = [ch.name, ch.title || '', ch.level, ch.class, ch.sex, ch.position, ch.act & (PLR.KILLER | PLR.THIEF),
        ch.maxHit > 0 ? Math.round((100 * ch.hit) / ch.maxHit) : 0, o.linkdead !== null ? 1 : 0,
        ch.fighting ? (ch.fighting.npc ? { m: slotIndex.get(ch.fighting.slot) } : { p: game.pcOf(ch.fighting)?.id ?? -1 }) : null,
        ch.equipment[16] ? ch.equipment[16].vnum : 0, ch.equipment[11] ? ch.equipment[11].vnum : 0];
      const key = JSON.stringify(info);
      if (s.sent.roster.get(o.pc.id) !== key) { s.sent.roster.set(o.pc.id, key); roster.push([o.pc.id, ...info]); }
      const c = local(s, p);
      // Back up onto whatever build.js raised there (the temple mound).
      pos.push([o.pc.id, c.x, round(p.y + w.liftAt(p.x, p.y - 1.72, p.z)), c.z, round(o.yaw || 0)]);
    }
    const gone = [...s.sent.roster.keys()].filter((id) => !seen.has(id));
    for (const id of gone) s.sent.roster.delete(id);
    if (roster.length || gone.length) send(s, { t: 'who', add: roster, del: gone });
    if (pos.length) send(s, { t: 'pos', at: Date.now() - started, p: pos });
  }

  /**
   * The shop the reader is standing at, as the server's keeper has it: the
   * stock it actually holds (db.c rolled each piece's level here, not in the
   * page), what it asks, and what it would pay for each thing carried. Null
   * when no keeper is in reach. Sent when it changes.
   */
  function sendShop(s) {
    const pc = s.pc;
    const shop = game.withPlayer(pc, () => game.shopHere());
    const view = shop && {
      keeper: shop.keeper, m: slotIndex.get(shop.slot), name: shop.name, open: shop.open, hours: shop.hours,
      sellsBack: shop.sellsBack,
      stock: shop.stock.map(({ obj, cost }) => ({
        vnum: obj.vnum, name: obj.name, level: obj.level, itemType: obj.itemType, cost,
      })),
      offers: shop.offers.map(({ obj, cost }) => [idOf(obj), cost]),
    };
    const text = JSON.stringify(view || null);
    if (s.sent.shop === text) return;
    s.sent.shop = text;
    send(s, { t: 'shop', s: view || null });
  }

  /**
   * The gates of the reader's zone: [room, direction, open, warden's level]
   * -- the level of the warden actually standing there (db.c fuzzes it at
   * reset), and open once that warden is dead, for every player at once.
   */
  const gateViews = { tick: -1, byZone: new Map() };
  function sendGates(s) {
    const zone = s.zone || w.zoneOfVnum(s.pc.ch.roomVnum)?.zone.id;
    if (!zone) return;
    if (gateViews.tick !== stats.ticks) {
      gateViews.tick = stats.ticks;
      gateViews.byZone = new Map();
      const wardens = new Map();
      for (const slot of game.mobs) if (!slot.dead && slot.instance) wardens.set(slot.record, slot.instance);
      for (const gate of game.gates) {
        const id = w.zoneOfVnum(gate.vnum)?.zone.id;
        if (!gateViews.byZone.has(id)) gateViews.byZone.set(id, []);
        const warden = wardens.get(gate.warden);
        gateViews.byZone.get(id).push([gate.vnum, gate.dir, gate.open ? 1 : 0, warden ? warden.level : gate.wardenLevel]);
      }
    }
    const list = gateViews.byZone.get(zone) || [];
    const text = JSON.stringify(list);
    if (s.sent.gates === text) return;
    s.sent.gates = text;
    send(s, { t: 'gates', z: zone, g: list });
  }

  /**
   * The doors of the reader's zone: [room, direction, the exit's shut and
   * locked bits] for every exit with a door. The rules that open, close and
   * reset them run here, where no page's hinges are (rules/world.js
   * `syncDoor`), so a page learns what its doors say from this.
   */
  const doorViews = { tick: -1, byZone: new Map() };
  function sendDoors(s) {
    const zone = s.zone || w.zoneOfVnum(s.pc.ch.roomVnum)?.zone.id;
    if (!zone || !w.byId.has(zone)) return;
    if (doorViews.tick !== stats.ticks) {
      doorViews.tick = stats.ticks;
      doorViews.byZone = new Map();
    }
    let list = doorViews.byZone.get(zone);
    if (!list) {
      list = [];
      for (const vnum of w.byId.get(zone).layout.cells.keys()) {
        w.world.rooms.get(vnum).exits.forEach((e, dir) => {
          if (e && (e.locks & EX_ISDOOR)) list.push([vnum, dir, e.locks & (EX_CLOSED | EX_LOCKED)]);
        });
      }
      doorViews.byZone.set(zone, list);
    }
    const text = JSON.stringify(list);
    if (s.sent.doors === text) return;
    s.sent.doors = text;
    send(s, { t: 'doors', z: zone, d: list });
  }

  function sendWeather(only = null) {
    const wx = game.weather();
    const text = JSON.stringify([wx.sky, wx.mmhg, wx.change, wx.hour, wx.day, wx.month, wx.year]);
    for (const s of only ? [only] : byPc.values()) {
      if (!s.pc || s.sent.weather === text) continue;
      s.sent.weather = text;
      send(s, { t: 'weather', w: { sky: wx.sky, mmhg: wx.mmhg, change: wx.change, hour: wx.hour, day: wx.day, month: wx.month, year: wx.year } });
    }
  }

  // -------------------------------------------------------- save and quit --
  function saveSession(s) {
    if (!s || !s.pc || !s.record) return;
    const ch = s.pc.ch;
    ch.played = (ch.played || 0) + s.played;
    ch.logon = Date.now();
    s.played = 0;
    const data = serialize(ch);
    for (const key of EXTRA) if (ch[key] !== undefined) data[key] = ch[key];
    s.record.char = data;
    s.record.lastSaved = new Date().toISOString();
    accounts.store(s.record);
  }

  /**
   * act_comm.c: do_quit -- the verse, the room told, the file saved, the
   * link closed. The character leaves once the command that asked is done
   * (`reap`): it is still the one whose turn it is until then.
   */
  function quit(s) {
    if (!s) return;
    const ch = s.pc.ch;
    if (ch.position === POS.FIGHTING) return say(ch, 'No way! You are fighting.');
    if (ch.position < POS.STUNNED) return say(ch, "You're not DEAD yet.");
    say(ch, 'Had I but time--as this fell sergeant, Death,');
    say(ch, 'Is strict in his arrest--O, I could tell you--');
    say(ch, 'But let it be.');
    s.leaving = 'quit';
  }

  /** Whoever quit or was denied during the last command, out of the world now. */
  function reap() {
    for (const s of [...sessions]) {
      if (!s.leaving || !s.pc) continue;
      const why = s.leaving;
      s.leaving = null;
      flush(s);
      extract(s, `${s.pc.ch.name} has left the game.`);
      send(s, { t: 'bye', why });
      s.open = false;
      s.ws.close();
    }
  }

  /** extract_char for a player: saved, gone from the world, its descriptor dropped. */
  function extract(s, roomText) {
    const pc = s.pc;
    if (!pc) return;
    // close_socket: whoever was snooping is told, and whatever this one snooped is let go.
    if (s.snoopBy && s.snoopBy.pc) game.tell(s.snoopBy.pc.ch, { kind: 'out', text: 'Your victim has left the game.' });
    s.snoopBy = null;
    for (const o of sessions) if (o.snoopBy === s) o.snoopBy = null;
    saveSession(s);
    game.roomcast(pc.ch.roomVnum, { kind: 'room', text: roomText }, [pc.ch]);
    game.magic.forget(pc.ch);
    game.removePlayer(pc);
    byPc.delete(pc.id);
    s.pc = null;
    sessions.delete(s);
    dash.forget(s);
    dash.record('conn', `${pc.ch.name}@${s.host} left the game${s.linkdead !== null ? ' (link dead too long)' : ''}`, { who: pc.ch.name, sub: 'quit' });
    log(`${roomText}`);
  }

  async function changePassword(s, argument) {
    if (!s) return;
    const ch = s.pc.ch;
    const words = String(argument || '').trim().split(/\s+/);
    if (words.length < 2 || !words[0] || !words[1]) return say(ch, 'Syntax: password <old> <new>.');
    if (!(await checkPassword(words[0], s.record.password))) {
      ch.wait = Math.max(ch.wait, 40);
      return say(ch, 'Wrong password.  Wait 10 seconds.');
    }
    if (words[1].length < 5) return say(ch, 'New password must be at least five characters long.');
    s.record.password = await hashPassword(words[1]);
    saveSession(s);
    say(ch, 'Ok.');
  }

  function users(ch) {
    const list = [...sessions].filter((s) => s.pc && game.pcOf(s.pc.ch));
    say(ch, `${list.length} user${list.length === 1 ? '' : 's'}`);
    for (const s of list) say(ch, `[${String(s.pc.id).padStart(3)} ${String(s.linkdead === null ? 0 : 1).padStart(2)}] ${s.pc.ch.name}@${s.host}`);
  }

  function findPlaying(name) {
    return [...byPc.values()].find((s) => s.pc && s.pc.ch.name.toLowerCase().startsWith(String(name || '').toLowerCase())) || null;
  }

  function disconnect(ch, name) {
    if (!name) return say(ch, 'Disconnect whom?');
    const s = findPlaying(name);
    if (!s) return say(ch, "They aren't here.");
    if (!s.open) return say(ch, `${s.pc.ch.name} doesn't have a descriptor.`);
    s.ws.close();
    say(ch, 'Ok.');
  }

  function deny(ch, name) {
    if (!name) return say(ch, 'Deny whom?');
    const s = findPlaying(name);
    if (!s) return say(ch, "They aren't here.");
    if (trustOf(s.pc.ch) >= trustOf(ch)) return say(ch, 'You failed.');
    s.pc.ch.act |= PLR_MORE.DENY;
    say(s.pc.ch, 'You are denied access!');
    say(ch, 'OK.');
    s.leaving = 'denied';
  }

  function toggleLog(ch, name) {
    if (!name) return say(ch, 'Log whom?');
    const s = findPlaying(name);
    if (!s) return say(ch, "They aren't here.");
    s.logged = !s.logged;
    say(ch, s.logged ? 'LOG set.' : 'LOG removed.');
  }

  /** act_wiz.c: do_ban -- the list, or a site added to it. */
  function ban(ch, arg) {
    if (!arg) {
      say(ch, ['Banned sites:', ...site.bans()].join('\n'));
      return;
    }
    if (site.bans().some((b) => b.toLowerCase() === arg.toLowerCase())) { say(ch, 'That site is already banned!'); return; }
    site.ban(arg);
    dash.record('site', `${ch.name} banned ${arg}`, { who: ch.name, lvl: 'warn' });
    say(ch, 'Ok.');
  }

  /** act_wiz.c: do_allow. */
  function allow(ch, arg) {
    if (!arg) { say(ch, 'Remove which site from the ban list?'); return; }
    const allowed = site.allow(arg);
    say(ch, allowed ? 'Ok.' : 'Site is not banned.');
    if (allowed) dash.record('site', `${ch.name} lifted the ban on ${arg}`, { who: ch.name });
  }

  /**
   * act_wiz.c: do_snoop, from get_char_world on -- a player's descriptor
   * copied to yours, until you snoop yourself ("Cancelling all snoops.") or
   * they leave. A mobile has no descriptor.
   */
  function snoop(ch, victim) {
    const mine = sessionOf(ch);
    const s = victim.npc ? null : byPc.get(game.pcOf(victim)?.id);
    if (!s || !s.open) return say(ch, 'No descriptor to snoop.');
    if (s === mine) {
      say(ch, 'Cancelling all snoops.');
      for (const o of sessions) if (o.snoopBy === mine) o.snoopBy = null;
      return undefined;
    }
    if (s.snoopBy) return say(ch, 'Busy already.');
    if (trustOf(victim) >= trustOf(ch)) return say(ch, 'You failed.');
    for (let d = mine.snoopBy; d; d = d.snoopBy) {
      if (d === s) return say(ch, 'No snoop loops.');
    }
    s.snoopBy = mine;
    return say(ch, 'Ok.');
  }

  let closing = null;
  /** do_shutdown: everyone told, everyone saved, the port closed. */
  function shutdown(text = 'Shutdown.') {
    if (closing) return closing;
    for (const s of byPc.values()) { if (s.pc) { game.tell(s.pc.ch, { kind: 'echo', text }); flush(s); } }
    log(text);
    dash.record('server', text, { lvl: 'warn' });
    closing = close();
    return closing;
  }

  async function close() {
    clearInterval(timer);
    for (const s of [...byPc.values()]) saveSession(s);
    for (const s of sessions) { s.open = false; try { s.ws.close(); } catch { /* already gone */ } }
    await new Promise((resolve) => wss.close(resolve));
    if (onClose) onClose();
  }
  let onClose = null;

  return {
    port: address.port, game, world: w, sessions, stats, accounts, started,
    close: () => shutdown('Shutdown.'),
    set onClose(fn) { onClose = fn; },
    /** For a harness: the session of a character by name. */
    sessionNamed: (name) => findPlaying(name),
    /**
     * For a harness: put player `id` in room `vnum` the way goto does (a
     * 'teleport' with a sequence number), unless the last report it believed
     * is in that room already or one open exit away. True when it jumped.
     */
    place(id, vnum) {
      const s = byPc.get(id);
      if (!s || !s.pc) throw new Error(`place: no player ${id}`);
      const from = s.navRoom ?? s.pc.ch.roomVnum;
      // A room it could walk into is walked into: the report alone is believed.
      if (from === vnum || w.adjacent(s.pc.ch, from, vnum)) return false;
      if (!game.placePlayer(s.pc, vnum)) throw new Error(`place: #${vnum} has nowhere to stand`);
      return true;
    },
  };
}
