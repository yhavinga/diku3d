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

import { createGame, createCharacter, schoolKit, POS, CLASS_TABLE, ROOM_VNUM_SCHOOL } from '../src/game.js';
import { serialize, restore } from '../src/save.js';
import { titleFor, trustOf, PLR_MORE } from '../src/rules/actcomm.js';
import { PLR, nested } from '../src/rules/handler.js';
import { bootWorld } from './world.mjs';
import { EX_ISDOOR, EX_CLOSED, EX_LOCKED } from '../src/are.js';
import {
  createNotes, createReports, createSite, addrBits, parseSite, underSite,
} from './store.mjs';
import { createDash } from './dash.mjs';
import {
  createAccounts, hashPassword, checkPassword, checkParseName, properName, EXTRA, createLoginGuard, inMinutes,
} from './accounts.mjs';

/**
 * 2: positions are checked and answered with `at`, which a page must obey
 * or every later report is dropped as stale; and `shop`, `gates`, the
 * reconnect token in `enter`. `doors` came later and needs no new number:
 * a page that does not know it ignores it.
 */
export const PROTOCOL = 2;
const ROOM_VNUM_TEMPLE = 3001;
/** The spell events other players see as well as the caster (magic.js invoke, run, and its fizzles). */
const SEEN_SPELLS = new Set(['cast', 'spell', 'spell-fizzle']);
/**
 * What a typed line may not carry: C0 and C1 controls, DEL, the line and
 * paragraph separators and the bidi overrides. Each is something another
 * player's screen acts on -- a newline that starts a forged line of its own,
 * an escape sequence on a terminal at the SSH gateway, text that reads
 * backwards -- and none is something a person types.
 */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/** Where an error was thrown, one line, for the log and the dashboard -- never for a client: it names the server's paths. */
const frameOf = (error) => (error && error.stack ? error.stack.split('\n')[1]?.trim() : null) || 'no stack';
/** How far another player is seen from: the far end of a street, not the zone. */
const SIGHT = 160;
/** Seconds a player whose link dropped stays standing in the world. */
const LINKDEAD_SECONDS = 180;
/** Autosave, as char_update's oldest-save-first does every few minutes. */
const AUTOSAVE_SECONDS = 300;

/**
 * What a socket may do to the server. `ws` allows 100 MiB a message and any
 * number of sockets, and everything here is JSON.parse'd on the one thread
 * that also runs the game. Overridable through startMud's `limits` so a test
 * need not wait minutes; the defaults are what runs live.
 */
export const LIMITS = {
  /**
   * The largest message a page sends is a position report or a typed line
   * (cmd lines are cut at 400 characters; the largest a real page sent in
   * login, sprinting, typing and casting was 73 bytes), and none carries a
   * save. 64 KiB is hundreds of times
   * that and still too small to hurt. The other direction is not capped.
   */
  maxPayload: 64 * 1024,
  /**
   * Sockets from one address (siteOf): a household behind one IPv4 with a few
   * pages open, and a dropped link whose old socket lingers for a heartbeat
   * while the new one logs in. A direct loopback peer carries no x-real-ip
   * (nginx always sets one) and is a local process, so it is not counted.
   */
  socketsPerSite: 4,
  /**
   * Addresses that may hold more (or fewer) than socketsPerSite: a list of
   * { site, n }, the first match wins. `site` is an exact IPv4 or IPv6 address
   * or a CIDR prefix (`2001:db8:1:2::/64`: privacy addresses rotate the low
   * 64 bits, so a /64 matches every interface id under it). Empty unless the
   * operator sets DIKU_SITE_SOCKETS (main.mjs).
   */
  siteSockets: [],
  /**
   * Sockets from everywhere together, loopback included: past the per-address
   * caps, enough addresses can still open sockets until the one thread that
   * runs the game spends its time on them.
   */
  socketsTotal: 500,
  /**
   * Messages a socket may send: a page sends 10 position reports a second and
   * a ping every 2 s; measured peaks in any one second with a real page: 14
   * sprinting, 24 typing commands at 12 a second, 32 at an absurd 25 a second.
   * 30 sustained is double a sprint; a burst of 60 covers a pasted list of
   * commands or a tab waking from throttling, which delivers a second's worth
   * at once.
   */
  ratePerSecond: 30,
  burst: 60,
  /**
   * Past the cap the excess is dropped and the player warned once. A socket
   * that keeps sending FLOOD_FACTOR times the cap for FLOOD_SECONDS in a row
   * is a script, not a player, and is closed.
   */
  floodFactor: 5,
  floodSeconds: 3,
  /** A socket that has not answered a ping in this long is a dropped link nobody told us about; it frees its slot and goes linkdead. */
  heartbeatMs: 30 * 1000,
};

/** The first `siteSockets` entry whose address or prefix holds `host`, or null. */
export function siteEntry(host, lim = LIMITS) {
  const bits = addrBits(host);
  if (bits === null) return null;
  for (const entry of lim.siteSockets || []) {
    const p = parseSite(entry.site);
    if (!p) throw new Error(`siteSockets: cannot read ${JSON.stringify(entry.site)}`);
    if (underSite(bits, p)) return entry;
  }
  return null;
}

/**
 * What the per-address limits count by -- the socket cap, the login guard,
 * new characters: an IPv4 address as it is, an IPv6 address by its /64. One
 * line is given a /64 and privacy addresses rotate the low 64 bits, so
 * counting whole IPv6 addresses gave one household 2^64 tries. Logs, `users`,
 * the dashboard and bans still name the whole address. Anything unreadable
 * counts as its own text.
 */
export function limitKey(host) {
  const bits = addrBits(host);
  if (bits === null) return String(host);
  if ((bits >> 32n) === 0xffffn) return [24n, 16n, 8n, 0n].map((s) => (bits >> s) & 255n).join('.');
  return `${[112n, 96n, 80n, 64n].map((s) => ((bits >> s) & 0xffffn).toString(16)).join(':')}::/64`;
}

/** How many open sockets `host` may hold: the first matching `siteSockets` entry, else `socketsPerSite`. */
export function capFor(host, lim = LIMITS) {
  const entry = siteEntry(host, lim);
  return entry ? entry.n : lim.socketsPerSite;
}

/** DIKU_SITE_SOCKETS ("site=n,site=n") as a siteSockets list; a bad entry throws, naming it. */
export function parseSiteSockets(text) {
  if (!text || !text.trim()) return [];
  return text.split(',').map((raw) => {
    const entry = raw.trim();
    const eq = entry.lastIndexOf('=');
    if (eq < 1) throw new Error(`DIKU_SITE_SOCKETS: entry ${JSON.stringify(entry)} is not site=n`);
    const site = entry.slice(0, eq).trim();
    const count = entry.slice(eq + 1).trim();
    if (!/^[1-9]\d*$/.test(count)) throw new Error(`DIKU_SITE_SOCKETS: entry ${JSON.stringify(entry)} has no positive integer after '='`);
    if (!parseSite(site)) throw new Error(`DIKU_SITE_SOCKETS: entry ${JSON.stringify(entry)} has an address or prefix that cannot be read`);
    return { site, n: +count };
  });
}

export async function startMud({
  root, dataDir, port = 4011, host = '127.0.0.1', seed, tickMs = 50, log = console.log,
  wizlock = false, server = null, limits = {}, loginLimits = {},
} = {}) {
  const lim = { ...LIMITS, ...limits };
  const guard = createLoginGuard(loginLimits);
  const started = Date.now();
  const w = bootWorld(root, { log });
  const accounts = createAccounts(dataDir);
  const notes = createNotes(dataDir);
  const reports = createReports(dataDir);
  /**
   * bug, idea and typo write to disk, and an alias repeats a command up to
   * twenty times a line: ten reports an hour per player are kept. False when
   * the report was over that and not kept.
   */
  const REPORTS_PER_HOUR = 10;
  const reported = new Map();
  function report(ch, kind, text) {
    const now = Date.now();
    const recent = (reported.get(ch.name) || []).filter((t) => now - t < 3600e3);
    reported.set(ch.name, recent);
    if (recent.length >= REPORTS_PER_HOUR) {
      log(`${ch.name}: over ${REPORTS_PER_HOUR} reports an hour, ${kind} not kept`);
      return false;
    }
    recent.push(now);
    reports.add({ kind, who: ch.name, room: ch.roomVnum, date: new Date(now).toISOString(), text });
    return true;
  }
  /**
   * The board as the rules see it (actcomm.js do_note). Every post rewrites
   * notes.json whole and a note to all is listed to everyone at login, so
   * one player posts ten an hour -- tried, not only kept, or a full board
   * would hear from a flooder at every line -- and the board holds
   * BOARD_MAX. `post` is null when the note went up, else the words the
   * player is told; nothing is kept then.
   */
  const NOTES_PER_HOUR = 10;
  const BOARD_MAX = 2000;
  const posted = new Map();
  const board = {
    list: notes.list,
    update: notes.update,
    remove: notes.remove,
    post(note) {
      const now = Date.now();
      const recent = (posted.get(note.sender) || []).filter((t) => now - t < 3600e3);
      posted.set(note.sender, recent);
      if (recent.length >= NOTES_PER_HOUR) {
        log(`${note.sender}: over ${NOTES_PER_HOUR} notes an hour, not posted`);
        return 'You have posted enough notes for now; try again in a while.';
      }
      recent.push(now);
      if (notes.list().length >= BOARD_MAX) {
        log(`${note.sender}: the board is full (${BOARD_MAX} notes), not posted`);
        dash.record('server', `${note.sender} could not post "${note.subject}": the board is full (${BOARD_MAX} notes); remove some`, { who: note.sender, lvl: 'warn' });
        return 'The board is full; the implementor has been told.';
      }
      notes.post(note);
      return null;
    },
  };
  // The ban list and the wizlock, kept across reboots; `wizlock` is only the first boot's.
  const site = createSite(dataDir, { wizlock, log });
  const sessions = new Set();
  const byPc = new Map();
  let nextPcId = 1;
  const stats = { refused: 0, floodDropped: 0, events: 0, routed: 0, dropped: 0, msgsOut: 0, bytesOut: 0, msgsIn: 0, bytesIn: 0, dashBytes: 0, ticks: 0, tickMs: 0, tickMax: 0 };

  // -------------------------------------------------------------- the game --
  const hooks = {
    save: (ch) => { const s = sessionOf(ch); if (s) saveSession(s); },
    quit: (ch) => quit(sessionOf(ch)),
    // do_password returns before the scrypt is done: a failure there is logged and told, never left to end the process.
    password: (ch, arg) => changePassword(sessionOf(ch), arg).catch((error) => {
      log(`${ch.name}: password failed: ${error.stack}`);
      dash.record('server', `${ch.name}: password failed: ${error.message} (${frameOf(error)})`, { who: ch.name, lvl: 'error' });
      say(ch, `The mud stumbles: ${error.message}`);
    }),
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
    notes: board,
    report,
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
    // advance_level saves the character (save.c); so does a level here. This
    // runs inside game.tick, so a save that fails ends the session after it.
    if (event.kind === 'level' && event.pc != null) {
      const s = byPc.get(event.pc);
      if (s) try { saveSession(s); } catch (error) { s.failed = { where: 'the save at a new level', error }; }
    }
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
    // One session's failure here ends that session (endSession), never the
    // loop: an exception out of this callback would end the process.
    for (const s of sessions) {
      if (s.failed) { endSession(s, s.failed.where, s.failed.error); continue; }
      if (s.pc) s.played += dt;
      if (s.pc && s.linkdead !== null && (s.linkdead -= dt) <= 0) {
        try { extract(s, `${s.pc.ch.name} has left the game.`); } catch (error) { endSession(s, 'leaving with its link dead', error); }
      }
    }
    reap();
    const fast = stats.ticks % Math.max(1, Math.round(100 / tickMs)) === 0;
    for (const s of sessions) {
      if (!s.pc || !s.open) continue;
      try {
        if (fast) { sendSelf(s); sendMobs(s); sendGround(s); sendPlayers(s); sendShop(s); sendGates(s); sendDoors(s); }
        flush(s);
        if ((s.saveIn -= dt) <= 0) { s.saveIn = AUTOSAVE_SECONDS; saveSession(s); }
      } catch (error) { endSession(s, 'the tick (what it is sent, or its autosave)', error); }
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
  /**
   * A browser names the page that opens a socket in Origin, and any website
   * can open one to here from its visitors' browsers -- and try logins from
   * their addresses. A page of the mud's own host may, and a page on this
   * machine (python3 serve.py beside a local server); a client that is no
   * browser (the SSH gateway, the tools) sends no Origin and is not asked.
   */
  let originRefused = 0;
  function verifyClient({ req }, done) {
    const origin = req.headers.origin;
    if (origin === undefined) return done(true);
    let name = null;
    try { name = new URL(origin).hostname.toLowerCase(); } catch { /* not a URL: refused below, by name */ }
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (name && (['localhost', '127.0.0.1', '[::1]'].includes(name) || name === host)) return done(true);
    originRefused += 1;
    if (originRefused <= 3 || originRefused % 50 === 0) {
      const from = siteOf(req);
      log(`${from}: socket from a page at ${JSON.stringify(origin)} refused (host ${JSON.stringify(req.headers.host || '')}), ${originRefused} so far`);
      dash.record('site', `${from}: a socket opened by a page at ${String(origin).slice(0, 80)} was refused, ${originRefused} so far`, { lvl: 'warn' });
    }
    return done(false, 403, 'Forbidden: this page may not open the mud');
  }
  const wss = server ? new WebSocketServer({ server, maxPayload: lim.maxPayload, verifyClient })
    : new WebSocketServer({ port, host, maxPayload: lim.maxPayload, verifyClient });
  await new Promise((resolve) => (server ? resolve() : wss.once('listening', resolve)));
  const address = wss.address();
  log(`listening on ws://${host}:${address.port}/ws`);
  // The hills are worked out now, after listening, and not on the first player's first report.
  setImmediate(() => { for (const z of w.zones) z.relief; });

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
    const host = siteOf(request);
    const s = {
      ws, open: true, host, siteKey: limitKey(host), state: 'name', pc: null, record: null,
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
    // Counted by open sockets: a linkdead body holds no socket, so its owner can always come back.
    if ([...sessions].filter((o) => o.open).length >= lim.socketsTotal) {
      const why = `The mud has as many connections as it takes (${lim.socketsTotal}). Try again in a while.`;
      log(`${s.host}: connection refused, ${lim.socketsTotal} sockets open in all`);
      dash.record('site', `${s.host}: connection refused, ${lim.socketsTotal} sockets open in all`, { lvl: 'error' });
      s.open = false;
      ws.on('error', (error) => log(`${s.host}: socket error: ${error.message}`));
      ws.close(1013, why);
      return;
    }
    const cap = capFor(s.host, lim);
    // Under a listed prefix every address in it shares the one count; otherwise
    // the address's limitKey does (an IPv6 /64): privacy addresses rotate within it.
    const entry = siteEntry(s.host, lim);
    const sameSite = (o) => (entry ? siteEntry(o.host, lim) === entry : o.siteKey === s.siteKey);
    if (!directLoopback(request) && [...sessions].filter((o) => o.open && sameSite(o)).length >= cap) {
      const why = `Too many connections from your address (${cap} at most). Close another page and try again.`;
      log(`${s.host}: connection refused, ${cap} sockets open already`);
      dash.record('site', `${s.host}: connection refused, ${cap} sockets open already`, { lvl: 'warn' });
      s.open = false;
      ws.on('error', (error) => log(`${s.host}: socket error: ${error.message}`));
      ws.close(1013, why);
      return;
    }
    sessions.add(s);
    s.alive = true;
    s.tokens = lim.burst;
    s.tokenAt = performance.now();
    s.windowAt = s.tokenAt;
    s.windowCount = 0;
    s.hot = 0;
    s.warned = false;
    ws.on('pong', () => { s.alive = true; });
    // ws emits 'error' on a protocol violation (a message past maxPayload is one) and closes
    // the socket; unhandled, an 'error' event would take the whole mud down.
    ws.on('error', (error) => {
      log(`${s.pc ? s.pc.ch.name : '?'}@${s.host}: socket error: ${error.message}`);
      dash.record('site', `${s.pc ? s.pc.ch.name : '?'}@${s.host}: socket closed: ${error.message}`, { who: s.pc ? s.pc.ch.name : undefined, lvl: 'warn' });
    });
    // `features`: what this server offers past the protocol; a page asks only for what is listed.
    // `online` is for the title screen, which asks before anyone logs in.
    send(s, { t: 'hello', v: PROTOCOL, features: ['dash'], world: fingerprint, online: online(), motd: 'Welcome to Merc Diku Mud.  May your visit here be ... Mercenary.' });
    ws.on('message', (data) => {
      stats.msgsIn += 1;
      stats.bytesIn += data.length;
      if (!admit(s)) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (error) { return sendError(s, `bad message: ${error.message}`); }
      // Not swallowed: a command that throws is logged with its stack, the
      // player is told what failed (where -- the frame, the server's own paths --
      // is for the log and the dashboard), and the mud goes on for everyone else.
      onMessage(s, msg).catch((error) => {
        log(`error handling ${msg && msg.t} from ${s.pc ? s.pc.ch.name : s.host}: ${error.stack}`);
        dash.record('server', `error handling ${msg && msg.t} from ${s.pc ? s.pc.ch.name : s.host}: ${error.message} (${frameOf(error)})`, { lvl: 'error' });
        sendError(s, `The mud stumbles: ${error.message}`);
      }).finally(reap);
    });
    ws.on('close', () => {
      s.open = false;
      if (s.pc && s.linkdead === null) {
        // comm.c: close_socket -- the character stays, "$n has lost $s link."
        const ch = s.pc.ch;
        game.roomcast(ch.roomVnum, { kind: 'room', text: `${ch.name} has lost ${['its', 'his', 'her'][ch.sex] || 'its'} link.` }, [ch]);
        s.linkdead = LINKDEAD_SECONDS;
        // An exception out of a socket's event would end the process: a save that fails ends this session instead.
        try { saveSession(s); } catch (error) { endSession(s, 'the save when its link was lost', error); return; }
        log(`${ch.name}@${s.host}: link lost`);
        dash.record('conn', `${ch.name}@${s.host} lost the link`, { who: ch.name, sub: 'linkdead' });
      } else if (!s.pc) sessions.delete(s);
      dash.forget(s);
    });
  });

  /** A loopback peer with no x-real-ip is a process on this machine, not a player behind nginx. */
  const directLoopback = (request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
    && !(request.headers['x-real-ip'] || '').trim();

  /**
   * A token bucket per socket. True when the message may be handled; false
   * when it is dropped (warned once per episode) -- and a socket that keeps
   * at it is closed. Everything a socket sends passes here, before JSON.parse.
   */
  function admit(s) {
    if (s.flooded) return false;
    const t = performance.now();
    s.tokens = Math.min(lim.burst, s.tokens + (t - s.tokenAt) / 1000 * lim.ratePerSecond);
    s.tokenAt = t;
    // Seconds in a row that the socket sent floodFactor times the cap: counted
    // over one-second windows; a quiet second ends the run.
    s.windowCount += 1;
    if (t - s.windowAt >= 1000) {
      s.hot = s.windowCount >= lim.floodFactor * lim.ratePerSecond * ((t - s.windowAt) / 1000) ? s.hot + 1 : 0;
      s.windowAt = t;
      s.windowCount = 0;
    }
    if (s.tokens >= 1) {
      s.tokens -= 1;
      if (s.tokens >= lim.burst / 2) s.warned = false;
      return true;
    }
    stats.floodDropped += 1;
    const who = s.pc ? s.pc.ch.name : '?';
    if (!s.warned) {
      s.warned = true;
      log(`${who}@${s.host}: sending too fast, messages dropped`);
      dash.record('site', `${who}@${s.host}: over ${lim.ratePerSecond} messages a second, dropping`, { who: s.pc ? who : undefined, lvl: 'warn' });
      sendError(s, `You are sending too many messages (over ${lim.ratePerSecond} a second); the excess is dropped.`);
    }
    if (s.hot >= lim.floodSeconds) {
      const why = 'Disconnected: you kept sending far too many messages.';
      log(`${who}@${s.host}: flooding, closed`);
      dash.record('site', `${who}@${s.host}: flooding, closed the socket`, { who: s.pc ? who : undefined, lvl: 'error' });
      s.flooded = true;
      send(s, { t: 'bye', why });
      s.ws.close(1008, why);
    }
    return false;
  }

  // A browser that vanishes (a laptop lid, a tunnel) sends no FIN; without this its
  // socket stays "open" for hours, holds a slot of the address's cap and never goes linkdead.
  const heartbeat = setInterval(() => {
    for (const s of sessions) {
      if (!s.open) continue;
      if (!s.alive) { s.ws.terminate(); continue; }
      s.alive = false;
      s.ws.ping();
    }
  }, lim.heartbeatMs);

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
      case 'login': return oneAtATime(s, 'login', () => login(s, msg));
      case 'create': return oneAtATime(s, 'create', () => create(s, msg));
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

  /**
   * One login or create at a time on a socket: each awaits a scrypt, and a
   * second sent behind the first would pass every check the first had not
   * yet acted on -- two bodies for one socket, one of them nobody's.
   */
  async function oneAtATime(s, kind, fn) {
    if (s.pc) return;
    if (s.nanny) {
      log(`${s.host}: ${kind} while a ${s.nanny} is under way, ignored`);
      return;
    }
    s.nanny = kind;
    try { await fn(); } finally { s.nanny = null; }
  }

  async function login(s, { name: raw = '', password = '', token = null }) {
    const name = properName(String(raw).trim());
    // A page whose link dropped asks for its body back with the token it was
    // given on entering, not the password, which it never kept. Only while
    // that body still stands in the world (LINKDEAD_SECONDS).
    if (token !== null) {
      const body = [...sessions].find((o) => o !== s && o.pc && o.pc.ch.name === name && o.token && sameToken(o.token, String(token)));
      if (!body) return send(s, { t: 'login', ok: false, why: 'Your link is gone; log in again.' });
      return enter(s, body.record, false);
    }
    // Before any scrypt: a paused name or address is told so and nothing is computed.
    if (!refuseGuess(s, name, false)) return undefined;
    if (!checkParseName(name, w.world)) return send(s, { t: 'login', ok: false, why: 'Illegal name, try another.' });
    const record = accounts.load(name);
    if (!record) return send(s, { t: 'login', ok: false, new: true, name, why: `Did I get that right, ${name} (Y/N)?` });
    if (record.char.act & PLR_MORE.DENY) return send(s, { t: 'login', ok: false, why: 'You are denied access.' });
    const right = await checkPassword(String(password), record.password);
    if (!right) {
      const paused = guard.wrong(s.siteKey, name);
      log(`${name}@${s.host}: wrong password${paused ? `, paused for ${Math.round(paused / 1000)} s` : ''}`);
      dash.record('conn', `${name}@${s.host}: wrong password${paused ? `, paused for ${inMinutes(paused)}` : ''}`, { who: name, lvl: paused ? 'error' : 'warn', sub: 'refused' });
      return send(s, { t: 'login', ok: false, why: paused ? `Wrong password. Too many wrong passwords. Try again in ${inMinutes(paused)}.` : 'Wrong password.' });
    }
    guard.right(s.siteKey, name);
    // The scrypt took a while: the socket may have gone, and the file may have changed (a deny).
    if (!s.open) return undefined;
    const fresh = accounts.load(name);
    if (fresh.char.act & PLR_MORE.DENY) return send(s, { t: 'login', ok: false, why: 'You are denied access.' });
    // IS_HERO: by trust, which is what lets an immortal past a wizlock.
    if (site.wizlock && (fresh.char.trust || fresh.char.level) < 36) return send(s, { t: 'login', ok: false, why: 'The game is wizlocked.' });
    enter(s, fresh, false);
  }

  /** Names being created now: two sockets asking for one name both found it free while the first hashed. */
  const beingCreated = new Set();
  async function create(s, { name: raw = '', password = '', cls, sex }) {
    const name = properName(String(raw).trim());
    if (!refuseGuess(s, name, true)) return undefined;
    if (!checkParseName(name, w.world)) return send(s, { t: 'login', ok: false, why: 'Illegal name, try another.' });
    if (accounts.exists(name) || beingCreated.has(name)) return send(s, { t: 'login', ok: false, why: 'That name is taken.' });
    if (String(password).length < 5) return send(s, { t: 'login', ok: false, new: true, name, why: 'Password must be at least five characters long.' });
    if (site.wizlock) return send(s, { t: 'login', ok: false, why: 'The game is wizlocked.' });
    const classIndex = Number(cls);
    if (!(classIndex >= 0 && classIndex < CLASS_TABLE.length)) return send(s, { t: 'login', ok: false, new: true, name, why: "That's not a class." });
    const sexIndex = { m: 1, f: 2, n: 0 }[String(sex || 'm').toLowerCase()[0]] ?? 1;
    guard.created(s.siteKey);
    const ch = createCharacter(classIndex, { sex: sexIndex });
    ch.name = name;
    ch.displayName = name;
    schoolKit(ch, w.world);
    beingCreated.add(name);
    let hashed;
    try { hashed = await hashPassword(String(password)); } finally { beingCreated.delete(name); }
    // Nothing is made for a socket that went while the password was hashed, nor over a file written meanwhile.
    if (!s.open) return undefined;
    if (accounts.exists(name)) return send(s, { t: 'login', ok: false, why: 'That name is taken.' });
    const record = {
      version: 1, name, created: new Date().toISOString(),
      password: hashed,
      char: { ...serialize(ch), room: ROOM_VNUM_SCHOOL, title: titleFor(ch), played: 0 },
    };
    accounts.store(record);
    log(`${name}@${s.host} new player.`);
    enter(s, record, true);
  }

  /**
   * login.guard: false (and the player told, in words the page shows) when
   * this name or address is paused; otherwise the attempt is counted and true.
   */
  function refuseGuess(s, name, creating) {
    const no = guard.refusal(s.siteKey, name, { creating });
    if (no) {
      log(`${name}@${s.host}: attempt refused, paused for ${Math.round(no.ms / 1000)} s`);
      dash.record('conn', `${name}@${s.host}: attempt refused while paused (${inMinutes(no.ms)} left)`, { who: name, lvl: 'warn', sub: 'refused' });
      send(s, { t: 'login', ok: false, why: no.why, wait: Math.ceil(no.ms / 1000) });
      return false;
    }
    const paused = guard.attempt(s.siteKey);
    if (paused) {
      log(`${s.host}: too many login attempts, paused for ${Math.round(paused / 1000)} s`);
      dash.record('site', `${s.host}: too many login attempts, paused for ${inMinutes(paused)}`, { lvl: 'error' });
    }
    return true;
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
    welcome(s, '\nWelcome to Merc Diku Mud.  May your visit here be ... Mercenary.', fresh);
    game.withPlayer(pc, () => game.noteNews());
  }

  /** By bytes: a token of as many characters, some of them multibyte, is longer in bytes, and timingSafeEqual throws on that. */
  const sameToken = (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  function welcome(s, text, fresh = false) {
    const pc = s.pc;
    s.token = randomBytes(24).toString('base64url');
    s.seq += 1;
    s.posAt = null;
    s.navRoom = null;
    s.sent = { self: '', kit: '', mobs: new Map(), ground: new Map(), roster: new Map(), weather: '' };
    send(s, {
      t: 'enter', id: pc.id, name: pc.ch.name, room: pc.ch.roomVnum, seq: s.seq, now: Date.now() - started, token: s.token,
      trust: trustOf(pc.ch), ...(fresh ? { fresh: true } : null),
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

  function command(s, raw) {
    const pc = s.pc;
    s.lastInput = Date.now();
    // Every typed line comes in here (a page's, the SSH gateway's, the dashboard's), and
    // titles, descriptions, notes and aliases are typed lines: none of them keeps a control.
    const line = raw.replace(CONTROLS, '');
    // An alias is read first, so that the log and the dashboard see the commands it ran and not the word that stood for them.
    for (const one of game.withPlayer(pc, () => game.aliasLines(line))) {
      const name = game.withPlayer(pc, () => game.interpret(one));
      // interp.c's LOG_NEVER: password is logged without what was typed after it. Known
      // only once interpret has found the command, so the line is logged after it ran.
      if (pc.ch.act & PLR_MORE.LOG || s.logged) log(`Log ${pc.ch.name}: ${name === 'password' ? name : one}`);
      dash.command(s, one, name);
    }
  }

  /** A line run as `s`'s own command, and what it told them: the dashboard's actions. */
  function runFor(s, line) {
    const lines = [];
    const off = game.listen((event) => { if (event.pc === s.pc.id && event.text) lines.push(event.text); });
    try { command(s, line); } finally { off(); }
    return lines;
  }

  /**
   * The page's own verbs (game-ui.js, main.js): a click, E on a thing, a
   * panel's button. Each is a game.js method run as this player's turn, its
   * arguments by reference ({ o }, { m }, { p }) and its refusal sent back.
   *
   * Beside each, what it takes, from what the page sends (src/link.js `ref`
   * and its callers): 'obj' an object at hand -- carried, worn, or lying in
   * reach; 'inner' one at hand or inside one that is (`get` out of a
   * corpse); 'mob' a mobile in reach; 'char' a mobile or a player in reach;
   * 'int' a whole number; 'str' a short word. A '?' may be left out or null.
   * An object is an options object, which may be left out, with those keys
   * and a reference for each. Anything else is refused before game.js sees
   * it, and logged: no page sends it.
   */
  const DOOR = ['int', 'int'];
  const OPS = {
    attackSlot: ['mob'],
    take: ['inner', 'obj?'], takeAll: ['obj'], getFrom: ['inner', 'obj'],
    wear: ['obj'], wield: ['obj'], remove: ['int'], drop: ['obj'], put: ['obj', 'obj'],
    useItem: ['obj', { targetObj: 'obj', target: 'char' }],
    cast: ['str', { target: 'char', obj: 'obj' }],
    buy: ['int', 'int'], sell: ['int', 'obj'], practice: ['str'], train: ['str'],
    openObj: ['obj'], closeObj: ['obj'], lockObj: ['obj'], unlockObj: ['obj'], pickObj: ['obj'],
    openDoor: DOOR, closeDoor: DOOR, lockDoor: DOOR, unlockDoor: DOOR, pickDoor: DOOR, useDoor: DOOR,
    rest: [], sit: [], sleep: [], stand: [], sneak: [], hide: [], visible: [], recall: [], breakOff: [],
    useAction: ['str'],
    // The bar runs these with no arguments (useAction); a slot or a thing to steal is the server's to find.
    kick: [], backstab: [], disarm: [], steal: [], rescue: [],
    drink: ['obj?'], eat: ['obj'], fill: ['obj'], sacrifice: ['obj'], dropGold: ['int'], dropAll: ['str?'],
    wearAll: [], value: ['obj'], compare: ['obj', 'obj?'],
    setTimeOfDay: ['str'], focus: ['mob?'],
  };
  function operation(s, { op, a = [] }) {
    if (typeof op !== 'string' || !Object.hasOwn(OPS, op) || typeof game[op] !== 'function') return sendError(s, `no such action ${JSON.stringify(op)}`);
    const pc = s.pc;
    if (op !== 'focus') s.lastInput = Date.now();
    if (pc.ch.act & PLR_MORE.FREEZE) return game.tell(pc.ch, { kind: 'note', text: "You're totally frozen!" });
    let args;
    try { args = decodeArgs(pc, OPS[op], a); } catch (error) {
      if (!(error instanceof Malformed)) throw error;
      s.malformed = (s.malformed || 0) + 1;
      if (s.malformed <= 3 || s.malformed % 50 === 0) {
        log(`${pc.ch.name}@${s.host}: ${op} refused, ${error.message}: ${JSON.stringify(a).slice(0, 200)}; ${s.malformed} so far`);
        dash.record('server', `${pc.ch.name}: ${op} refused, ${error.message}; ${s.malformed} so far`, { who: pc.ch.name, lvl: 'warn' });
      }
      return sendError(s, `${op}: ${error.message}`);
    }
    // A door is opened from beside it, as E on its leaf does: not one across the world.
    if (OPS[op] === DOOR && !doorInReach(pc, args[0], args[1])) args = [MISSING];
    game.withPlayer(pc, () => {
      if (op === 'focus') { pc.focusSlot = args[0] === MISSING ? null : args[0]; return; }
      const options = (i) => typeof OPS[op][i] === 'object';
      if (args.some((arg, i) => arg === MISSING || (options(i) && Object.values(arg).includes(MISSING)))) {
        return game.tell(pc.ch, { kind: 'note', text: "You don't see that here." });
      }
      const result = op === 'cast' ? game.cast(args[0], args[1]) : game[op](...args);
      const results = Array.isArray(result) ? result : [result];
      for (const r of results) if (r && !r.ok && r.text && op !== 'cast' && op !== 'useItem') game.tell(pc.ch, { kind: 'note', text: r.text });
    });
  }

  /**
   * A door a client names by room and direction must be one it could be
   * facing: its leaf stands in the wall of the room it belongs to or of the
   * room it leads to, so the player is within DOOR_REACH of one of their
   * middles, on that floor.
   */
  const DOOR_REACH = 20;
  function doorInReach(pc, vnum, dir) {
    const exit = w.world.rooms.get(vnum)?.exits[dir];
    if (!exit || !(exit.locks & EX_ISDOOR)) return false;
    const p = pc.position;
    return [vnum, exit.to].some((v) => {
      const room = w.built.rooms.get(v);
      if (!room || room.unbuilt) return false;
      const c = room.center;
      // The server's feet are on the grid's floor, without build.js's lifts (position()).
      return Math.abs(c.x - p.x) < DOOR_REACH && Math.abs(c.z - p.z) < DOOR_REACH && Math.abs(c.y - (p.y - 1.72)) < 6;
    });
  }

  // ------------------------------------------------------------ references --
  const objIds = new WeakMap();
  let nextObj = 1;
  const idOf = (obj) => { let id = objIds.get(obj); if (!id) { id = nextObj++; objIds.set(obj, id); } return id; };
  /** A reference that is well formed but names nothing this player can reach now: "You don't see that here." */
  const MISSING = Symbol('missing');
  /** An argument no page sends: the op is refused and logged. */
  class Malformed extends Error {}
  /** How far a mobile or a player may be and still be named: a room, or a long look across one (cast reaches 13 m on the page's own figures). */
  const CHAR_REACH = 26;

  /** `a`, a client's arguments, against `shape` (OPS): the values game.js is called with. Throws Malformed. */
  function decodeArgs(pc, shape, a) {
    if (!Array.isArray(a)) throw new Malformed('its arguments are not a list');
    if (a.length > shape.length) throw new Malformed(`${a.length} arguments where it takes ${shape.length}`);
    return shape.map((kind, i) => decodeArg(pc, kind, a[i], `argument ${i + 1}`));
  }

  function decodeArg(pc, kind, value, what) {
    if (typeof kind === 'object') {
      if (value === undefined) return {};
      if (!isPlainObject(value)) throw new Malformed(`${what} is not an options object`);
      const out = {};
      for (const [key, v] of Object.entries(value)) {
        if (!Object.hasOwn(kind, key)) throw new Malformed(`${what} has an option ${JSON.stringify(key).slice(0, 40)} it does not take`);
        out[key] = decodeArg(pc, kind[key], v, `${what}'s ${key}`);
      }
      return out;
    }
    const optional = kind.endsWith('?');
    const base = optional ? kind.slice(0, -1) : kind;
    if (value === undefined || value === null) {
      if (optional) return null;
      throw new Malformed(`${what} is missing`);
    }
    switch (base) {
      case 'int':
        if (!Number.isSafeInteger(value)) throw new Malformed(`${what} is not a whole number`);
        return value;
      case 'str':
        if (typeof value !== 'string' || value.length > 40 || value.replace(CONTROLS, '') !== value) throw new Malformed(`${what} is not a word`);
        return value;
      case 'obj': case 'inner': return objectAt(pc, refOf(value, ['o'], what).id, base === 'inner');
      case 'mob': return mobileAt(pc, refOf(value, ['m'], what).id);
      case 'char': {
        const r = refOf(value, ['m', 'p'], what);
        if (r.key === 'p') return playerAt(pc, r.id);
        const slot = mobileAt(pc, r.id);
        // cast and a wand want the mobile itself, not its slot.
        return slot === MISSING || slot.dead ? MISSING : game.wakeSlot(slot);
      }
      default: throw new Error(`mud.mjs: OPS names an argument kind ${JSON.stringify(kind)} decodeArg does not know`);
    }
  }

  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** A reference: an object of one key out of `keys`, whose value is an index or an id. */
  function refOf(value, keys, what) {
    const entries = isPlainObject(value) ? Object.entries(value) : [];
    if (entries.length !== 1 || !keys.includes(entries[0][0]) || !Number.isSafeInteger(entries[0][1]) || entries[0][1] < 0) {
      throw new Malformed(`${what} is not a reference ({ ${keys.join(' } or { ')} } and a number)`);
    }
    return { key: entries[0][0], id: entries[0][1] };
  }

  /** An object by id: carried, worn, or lying in the room or within reach -- and with `inner`, inside one of those. */
  function objectAt(pc, id, inner) {
    const lists = [pc.ch.inventory, pc.ch.equipment.filter(Boolean), game.ground.filter((o) => o.inRoom === pc.ch.roomVnum || near(o.at, pc.position, 8))];
    for (const list of lists) for (const obj of (inner ? nested(list) : list)) if (objIds.get(obj) === id) return obj;
    return MISSING;
  }
  /** A mobile by its index, if it stands in your room or within CHAR_REACH. */
  function mobileAt(pc, index) {
    const slot = index < game.mobs.length ? game.mobs[index] : null;
    if (!slot || !(slot.roomVnum === pc.ch.roomVnum || near(slot.pos, pc.position, CHAR_REACH))) return MISSING;
    return slot;
  }
  /** Another player by id, likewise. */
  function playerAt(pc, id) {
    const o = byPc.get(id);
    if (!o || !o.pc || !(o.pc.ch.roomVnum === pc.ch.roomVnum || near(o.pc.position, pc.position, CHAR_REACH))) return MISSING;
    return o.pc.ch;
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
      // Who a spell struck, per reader: "you" (to null, player true) is only the one struck.
      if (key === 'hits' && Array.isArray(value)) {
        out.hits = value.map((h) => (h.toCh ? { to: who(h.toCh), player: h.toCh === self, dam: h.dam } : plain(h, reader)));
        continue;
      }
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
      // A spell is seen by whoever is in sight of its caster, not only by the caster: the gesture, the
      // light and where it lands are drawn on their pages off these. The words it carries are the caster's.
      if (SEEN_SPELLS.has(event.kind) && event.fromCh && s) {
        const at = event.fromCh.roomVnum !== undefined ? s.pc.position : null;
        for (const o of playing) {
          if (o === s || !at) continue;
          if (o.pc.ch.roomVnum === event.fromCh.roomVnum || Math.hypot(o.pc.position.x - at.x, o.pc.position.z - at.z) < 40) {
            const out = encode(event, o);
            if (out.text) out.text = '';
            o.out.push(out);
            stats.routed += 1;
          }
        }
      }
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
        ch.equipment[16] ? ch.equipment[16].vnum : 0, ch.equipment[11] ? ch.equipment[11].vnum : 0,
        // Everything else worn, as [wearLoc, vnum]: what a passer-by sees on you anyway (a robe's colour), never the pack.
        ch.equipment.flatMap((o, loc) => (o && loc !== 16 && loc !== 11 ? [[loc, o.vnum]] : [])),
        // The spells on them (sanctuary, bless, armor ...): what the others' pages draw round the body.
        ch.affectedBy];
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
      try {
        flush(s);
        extract(s, `${s.pc.ch.name} has left the game.`);
      } catch (error) { endSession(s, `leaving (${why})`, error); continue; }
      send(s, { t: 'bye', why });
      s.open = false;
      s.ws.close();
    }
  }

  /**
   * One session's own failure -- what it is sent, its save -- ends that
   * session and leaves everyone else playing: the stack logged and recorded
   * on the dashboard, the body out of the world unsaved (a save may be what
   * failed, and its file keeps the last good one), the socket closed.
   */
  function endSession(s, where, error) {
    const pc = s.pc;
    const who = pc ? pc.ch.name : '?';
    log(`${who}@${s.host}: ${where} failed, session ended: ${error.stack || error}`);
    dash.record('server', `${who}@${s.host}: ${where} failed, session ended: ${error.message} (${frameOf(error)})`, { who: pc ? who : undefined, lvl: 'error' });
    s.failed = null;
    s.pc = null;
    if (pc) {
      if (s.snoopBy && s.snoopBy.pc) game.tell(s.snoopBy.pc.ch, { kind: 'out', text: 'Your victim has left the game.' });
      game.roomcast(pc.ch.roomVnum, { kind: 'room', text: `${pc.ch.name} has left the game.` }, [pc.ch]);
      game.magic.forget(pc.ch);
      game.removePlayer(pc);
      byPc.delete(pc.id);
    }
    s.snoopBy = null;
    for (const o of sessions) if (o.snoopBy === s) o.snoopBy = null;
    sessions.delete(s);
    dash.forget(s);
    if (s.open) {
      send(s, { t: 'bye', why: 'The mud failed on your character and closed your link; the implementor can see why. Your last save is kept.' });
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

  /**
   * act_comm.c: do_password. Each one runs a scrypt or two on the thread
   * every login waits behind, so a session has one under way at a time, a
   * paused address or name is told so before any runs, and a wrong old
   * password counts with the login guard as a wrong login does.
   */
  async function changePassword(s, argument) {
    if (!s) return;
    const ch = s.pc.ch;
    const words = String(argument || '').trim().split(/\s+/);
    if (words.length < 2 || !words[0] || !words[1]) return say(ch, 'Syntax: password <old> <new>.');
    if (s.changingPassword) return say(ch, 'You are changing your password already; wait for the answer.');
    const no = guard.refusal(s.siteKey, ch.name);
    if (no) return say(ch, no.why);
    s.changingPassword = true;
    try {
      if (!(await checkPassword(words[0], s.record.password))) {
        const paused = guard.wrong(s.siteKey, ch.name);
        log(`${ch.name}@${s.host}: wrong old password${paused ? `, paused for ${Math.round(paused / 1000)} s` : ''}`);
        dash.record('conn', `${ch.name}@${s.host}: wrong old password to password${paused ? `, paused for ${inMinutes(paused)}` : ''}`, { who: ch.name, lvl: paused ? 'error' : 'warn', sub: 'refused' });
        ch.wait = Math.max(ch.wait, 40);
        return say(ch, paused ? `Wrong password.  Too many wrong passwords. Try again in ${inMinutes(paused)}.` : 'Wrong password.  Wait 10 seconds.');
      }
      guard.right(s.siteKey, ch.name);
      if (words[1].length < 5) return say(ch, 'New password must be at least five characters long.');
      s.record.password = await hashPassword(words[1]);
      // Quit or taken over while it hashed: the record is the one the body's file is written from either way.
      if (s.pc) saveSession(s); else accounts.store(s.record);
      return say(ch, 'Ok.');
    } finally { s.changingPassword = false; }
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
    // A ban matches by address bits (store.mjs banned), so it has to be an address or a prefix.
    const p = parseSite(arg);
    if (!p) { say(ch, 'Ban an address or a prefix: 1.2.3.4, 1.2.3.0/24, 2001:db8::/48.'); return; }
    if (site.bans().some((b) => { const q = parseSite(b); return q ? q.bits === p.bits && q.len === p.len : b.toLowerCase() === arg.toLowerCase(); })) {
      say(ch, 'That site is already banned!');
      return;
    }
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
    clearInterval(heartbeat);
    // One save that fails must not keep the rest from being written.
    for (const s of [...byPc.values()]) try { saveSession(s); } catch (error) { endSession(s, 'the save at shutdown', error); }
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
