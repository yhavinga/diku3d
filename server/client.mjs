/**
 * One terminal player's connection to the game server, speaking its own
 * protocol (mud.mjs) the way a page does (src/link.js): hello, then login
 * -- or create, when the server says the name is new -- and `enter`. After
 * that it keeps what a client must keep: the sequence number every position
 * report carries (a report under an older number is dropped unanswered, so
 * the number is adopted from `enter`, from `at` and from any event that
 * carries one), the character (`self`), and who else is in sight and where.
 *
 * A dropped link is not resumed: the gateway runs on the game server's own
 * machine, so a link that drops is the game server restarting, and a deploy
 * restarts the gateway with it.
 *
 * The socket is `ws`'s, not the global WebSocket, for one header:
 * `x-real-ip`, which mud.mjs believes from a loopback peer as it does from
 * nginx, so its per-address cap, its bans and its login guard all see the
 * address the SSH connection came from.
 */

import WebSocket from 'ws';

export const PROTOCOL = 2;
/** The longest line the server takes whole (mud.mjs onMessage). */
export const LINE_MAX = 400;
const HELLO_MS = 6000;
/** A login is a scrypt on the server, about 50 ms; this is for a server that never answers. */
const REPLY_MS = 15000;

const round = (v) => Math.round(v * 100) / 100;

/** Open a socket to the game and resolve once the server has said hello. */
export function openLink({ url, ip, log }) {
  if (typeof url !== 'string' || !/^wss?:\/\/./.test(url)) throw new Error(`client.mjs: openLink needs a ws:// or wss:// url; got ${JSON.stringify(url)}`);
  if (typeof log !== 'function') throw new Error('client.mjs: openLink needs a log function');

  const handlers = new Map();
  let awaiting = null;
  let finished = false;
  let byeWhy = null;

  const link = {
    id: null, name: null, room: null, seq: 0, self: null, hello: null, trust: null,
    /** id -> { name, title, level, cls, sex, position, flags, percent, linkdead, fighting, weapon, shield } */
    roster: new Map(),
    /** id -> { x, y, z, yaw }: eye height, in this player's zone's frame. */
    positions: new Map(),
    /** Logged in, with the socket open. */
    up: false,

    /** Server message types ('ev', 'at', 'self', ...), 'event' per ev item, and 'closed'. */
    on(type, fn) {
      if (typeof fn !== 'function') throw new Error(`client.mjs: on(${type}) needs a function`);
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
      return () => {
        const list = handlers.get(type);
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },

    login: (name, password) => ask({ t: 'login', name, password }),
    create: (name, password, cls, sex) => ask({ t: 'create', name, password, cls, sex }),

    /** A typed command, as the page's input line sends it. */
    cmd(line) {
      if (typeof line !== 'string' || !line.trim()) throw new Error(`client.mjs: cmd needs a line of text; got ${JSON.stringify(line)}`);
      if (line.length > LINE_MAX) throw new Error(`client.mjs: a command is at most ${LINE_MAX} characters; this one is ${line.length}`);
      if (/[\r\n]/.test(line)) throw new Error(`client.mjs: one command per line; got ${JSON.stringify(line.slice(0, 60))}`);
      if (!link.up) return false;
      send({ t: 'cmd', line });
      return true;
    },

    /** Where the body stands, eye high, in its zone's frame. False when the link is down. */
    pos({ zone, x, y, z, yaw } = {}) {
      if (typeof zone !== 'string' || ![x, y, z, yaw].every(Number.isFinite)) {
        throw new Error(`client.mjs: pos needs a zone and finite x, y, z, yaw; got ${JSON.stringify({ zone, x, y, z, yaw })}`);
      }
      if (!link.up) return false;
      send({ t: 'pos', zone, x: round(x), y: round(y), z: round(z), yaw: round(yaw), seq: link.seq });
      return true;
    },

    close(why = 'closed by the terminal') {
      byeWhy = byeWhy || why;
      if (ws.readyState <= 1) ws.close();
      else finish(byeWhy);
    },
  };

  function dispatch(type, payload) {
    for (const fn of [...(handlers.get(type) || [])]) fn(payload);
  }

  function send(msg) {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(msg));
  }

  /** The server's answer to a login or a create: its `login` refusal, or its `enter`. */
  function ask(msg) {
    if (awaiting) throw new Error(`client.mjs: ${msg.t} while the server has not yet answered the last one`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(new Error(`no answer from the game to ${msg.t} in ${REPLY_MS / 1000} s`)), REPLY_MS);
      const settle = (result) => {
        clearTimeout(timer);
        awaiting = null;
        if (result instanceof Error) reject(result); else resolve(result);
      };
      awaiting = settle;
      send(msg);
    });
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'enter':
        link.id = msg.id;
        link.name = msg.name;
        link.room = msg.room;
        link.seq = msg.seq;
        link.trust = msg.trust;
        link.up = true;
        log(`${msg.name} entered #${msg.room} as player ${msg.id}`);
        break;
      case 'self':
        link.self = { ...link.self, ...msg.c, ...(msg.k || {}) };
        if (msg.c && Number.isInteger(msg.c.room)) link.room = msg.c.room;
        break;
      case 'at':
        link.seq = Math.max(link.seq, msg.seq);
        if (Number.isInteger(msg.room)) link.room = msg.room;
        break;
      case 'ev':
        for (const e of msg.e) {
          if (e.seq) link.seq = Math.max(link.seq, e.seq);
          if ((e.kind === 'teleport' || e.kind === 'recall') && Number.isInteger(e.vnum)) link.room = e.vnum;
        }
        break;
      case 'who':
        for (const [id, name, title, level, cls, sex, position, flags, percent, linkdead, fighting, weapon, shield] of msg.add) {
          link.roster.set(id, { name, title, level, cls, sex, position, flags, percent, linkdead, fighting, weapon, shield });
        }
        for (const id of msg.del) { link.roster.delete(id); link.positions.delete(id); }
        break;
      case 'pos':
        for (const [id, x, y, z, yaw] of msg.p) link.positions.set(id, { x, y, z, yaw });
        break;
      case 'bye':
        byeWhy = msg.why;
        break;
      default: break;
    }
    if (awaiting && (msg.t === 'login' || msg.t === 'enter')) awaiting(msg);
    dispatch(msg.t, msg);
    if (msg.t === 'ev') for (const e of msg.e) dispatch('event', e);
  }

  function finish(why) {
    if (finished) return;
    finished = true;
    link.up = false;
    if (awaiting) awaiting(new Error(`the game closed the connection: ${why}`));
    dispatch('closed', { why });
  }

  const ws = new WebSocket(url, { headers: ip ? { 'x-real-ip': ip } : {} });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* a socket that never opened has nothing to close */ }
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail(`no hello from ${url} in ${HELLO_MS / 1000} s`), HELLO_MS);
    ws.on('error', (error) => { if (!settled) fail(`could not reach the game at ${url}: ${error.message}`); else log(`socket error: ${error.message}`); });
    ws.on('close', (code, reason) => {
      if (!settled) fail(`${url} closed the connection (code ${code}) before it said hello`);
      else finish(byeWhy || `the game server closed the connection (code ${code}${reason?.length ? `, ${reason}` : ''})`);
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (error) {
        throw new Error(`client.mjs: the server sent something that is not JSON (${error.message}): ${String(raw).slice(0, 80)}`);
      }
      if (!settled) {
        if (msg.t !== 'hello') return fail(`the server's first message was ${JSON.stringify(msg.t)}, not hello`);
        if (msg.v !== PROTOCOL) return fail(`the server speaks protocol ${msg.v}; the gateway speaks ${PROTOCOL}`);
        settled = true;
        clearTimeout(timer);
        link.hello = msg;
        return resolve(link);
      }
      return onMessage(msg);
    });
  });
}
