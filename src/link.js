/**
 * The page's one road to the game: `LocalLink` when the rules run here, as
 * they always have, and `SocketLink` when they run on a server (server/).
 * Both take the same commands -- a typed line, the page's own verbs (take,
 * wear, attack, cast ...) -- and hand back the same events, so main.js,
 * game-ui.js, fx.js and the rest read one game object either way.
 *
 * Connected, the page's game becomes the server's copy (game.js `mirror`):
 * it stops running the rules, its verbs are sent instead of done, and what
 * the server decides comes back -- the character, the zone's mobiles and
 * ground, the players in sight and the sky. What the page still owns is the
 * picture: the world's layout (deterministic per zone, the same on every
 * client and the server) and how a mobile strolls inside its room, which
 * comes from the server's clock rather than from the wire -- see `timedRand`.
 *
 * Messages are JSON, one object a frame, `t` its kind. See server/mud.mjs for
 * the other side and the README for the table.
 */

import { createPlayerFigure } from './actors.js';
import { DIR_NAME } from './are.js';
import { TAR } from './magic.js';
import { PLR } from './rules/handler.js';

/** The protocol this page speaks; the server says its own in `hello`. */
export const PROTOCOL = 1;
/** How far behind the server's clock other players are drawn, so there are two reports to blend. */
const BEHIND_MS = 100;
/** Positions go out at this rate, and come in at it. */
const SEND_HZ = 10;
/** One NPC decision epoch: a stroll's choices are drawn afresh from the clock every this many seconds. */
const EPOCH_SECONDS = 8;

// ------------------------------------------------------------- addresses --

const isLocalHost = (host) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\])$/i.test(host);

/**
 * Where to connect. Empty is this page's own origin at /ws (wss:// on an
 * https page); "host:port" is for development -- ws:// for localhost and a
 * bare IP, wss:// for a name -- and a full ws:// or wss:// URL is taken as
 * it is. An https page may not open ws://: that is refused here, in words,
 * before the browser refuses it without any.
 */
export function resolveAddress(input, location = globalThis.location) {
  const raw = String(input || '').trim();
  const secure = location && location.protocol === 'https:';
  let url;
  if (!raw) {
    if (!location || !location.host) return { error: 'This page has no origin to connect back to; give a host:port.' };
    url = `${secure ? 'wss' : 'ws'}://${location.host}/ws`;
  } else if (/^wss?:\/\//i.test(raw)) {
    url = raw;
  } else {
    const hostPort = raw.replace(/\/.*$/, '');
    const host = hostPort.replace(/:\d+$/, '');
    const path = raw.includes('/') ? raw.slice(raw.indexOf('/')) : '/ws';
    url = `${isLocalHost(host) && !secure ? 'ws' : 'wss'}://${hostPort}${path}`;
  }
  let parsed;
  try { parsed = new URL(url); } catch (error) { return { error: `"${raw}" is not an address: ${error.message}` }; }
  if (secure && parsed.protocol === 'ws:') {
    return {
      error: `This page came over https, and a browser will not open an unencrypted ws:// connection from it. `
        + `Use a wss:// address, or open the page over http (python3 serve.py) to reach a local server.`,
    };
  }
  return { url: parsed.href };
}

// ------------------------------------------------------------ the links --

/** The game in this page, as it always ran. Nothing to connect, nothing to send. */
export function createLocalLink(game) {
  return {
    mode: 'local', game,
    attach() {},
    update() {},
    close() {},
  };
}

/**
 * A connection to a server: `open()` resolves on its hello and rejects with
 * a sentence a player can act on. Then `login`, or `create` for a new name;
 * both resolve with the server's answer.
 */
export class SocketLink {
  constructor(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
    this.mode = 'socket';
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.hello = null;
    this.handlers = new Map();
    this.queue = [];
    this.clock = { offset: null, rtt: Infinity };
    this.closed = false;
    this.stats = { msgsIn: 0, bytesIn: 0, msgsOut: 0, bytesOut: 0 };
    // Between the server's "enter" and the page attaching its copy of the
    // game, what arrives is held rather than handed to nobody.
    this.holding = null;
  }

  open(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (text) => { if (settled) return; settled = true; try { this.ws && this.ws.close(); } catch { /* closing a socket that never opened */ } reject(new Error(text)); };
      let ws;
      try { ws = new this.WebSocketImpl(this.url); } catch (error) { fail(`Could not open ${this.url}: ${error.message}`); return; }
      this.ws = ws;
      const timer = setTimeout(() => fail(`No answer from ${this.url} in ${timeoutMs / 1000} s. Is the server running?`), timeoutMs);
      ws.onerror = () => fail(`Could not reach a game server at ${this.url}. Is it running, and is the address right?`);
      ws.onclose = (event) => {
        clearTimeout(timer);
        if (!settled) fail(`The connection to ${this.url} closed before the server said hello (code ${event.code}).`);
        else { this.closed = true; this.dispatch({ t: 'closed', code: event.code, reason: event.reason }); }
      };
      ws.onmessage = (event) => {
        this.stats.msgsIn += 1;
        this.stats.bytesIn += event.data.length;
        let msg;
        try { msg = JSON.parse(event.data); } catch (error) { console.error(`link: unreadable message: ${error.message}`); return; }
        if (msg.t === 'hello' && !settled) {
          clearTimeout(timer);
          if (msg.v !== PROTOCOL) { fail(`The server speaks protocol ${msg.v}; this page speaks ${PROTOCOL}. Reload the page.`); return; }
          settled = true;
          this.hello = msg;
          resolve(msg);
          return;
        }
        if (msg.t === 'pong') this.onPong(msg);
        this.dispatch(msg);
      };
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return () => this.handlers.get(type).splice(this.handlers.get(type).indexOf(fn), 1);
  }

  dispatch(msg) {
    if (this.holding && msg.t !== 'enter' && msg.t !== 'login' && msg.t !== 'closed') { this.holding.push(msg); return; }
    for (const fn of this.handlers.get(msg.t) || []) fn(msg);
    for (const fn of this.handlers.get('*') || []) fn(msg);
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const text = JSON.stringify(msg);
    this.stats.msgsOut += 1;
    this.stats.bytesOut += text.length;
    this.ws.send(text);
    return true;
  }

  /** The server's answer to a login or a create: { ok, new, why } or the enter message. */
  answer() {
    return new Promise((resolve) => {
      const offs = [];
      const done = (msg) => { offs.forEach((off) => off()); resolve(msg); };
      offs.push(this.on('login', done), this.on('enter', (msg) => { this.holding = []; done({ ok: true, enter: msg }); }),
        this.on('closed', () => done({ ok: false, why: 'The server closed the connection.' })));
    });
  }

  login(name, password) { const reply = this.answer(); this.send({ t: 'login', name, password }); return reply; }

  create(name, password, cls, sex) { const reply = this.answer(); this.send({ t: 'create', name, password, cls, sex }); return reply; }

  ping() { this.send({ t: 'ping', at: performance.now() }); }

  /** Hand on everything held since "enter", in order. */
  release() {
    const held = this.holding || [];
    this.holding = null;
    for (const msg of held) this.dispatch(msg);
  }

  /** Keep the best estimate of the server's clock: the reply with the shortest round trip. */
  onPong({ at, now }) {
    const t = performance.now();
    const rtt = t - at;
    if (rtt <= this.clock.rtt * 1.5 || this.clock.offset === null) {
      this.clock.rtt = Math.min(this.clock.rtt, rtt);
      this.clock.offset = now + rtt / 2 - t;
    }
  }

  /** Milliseconds on the server's clock, now. */
  serverNow() { return performance.now() + (this.clock.offset || 0); }

  close() { this.closed = true; try { this.ws && this.ws.close(); } catch { /* already closed */ } }
}

/**
 * Whether this page and a server hold the same world: the same mobiles in
 * the same order (by reset line), which is what every index on the wire
 * leans on. server/mud.mjs computes the same.
 */
export function worldFingerprint(game) {
  let h = 2166136261;
  const mix = (n) => { h ^= n; h = Math.imul(h, 16777619) >>> 0; };
  for (const slot of game.mobs) { mix(slot.proto.vnum); mix(slot.originRoom ?? slot.roomVnum); }
  return { rooms: game.world.rooms.size, mobs: game.mobs.length, hash: h.toString(16) };
}

// --------------------------------------------------------- the server's copy --

/** splitmix32 over a 32-bit seed. */
function splitmix(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}
/** xmur3: a string to a well-mixed 32-bit seed. */
function xmur3(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/**
 * A mobile's private generator (motion.js `fig.rand`), drawn from the
 * server's clock: every EPOCH_SECONDS it starts again from a seed hashed out
 * of the epoch, the mobile and the room it is in -- all three mixed, so two
 * mobiles, two rooms or two epochs never share a stream. Two pages that ask
 * the same mobile for its next stroll in the same epoch get the same answer
 * without a word on the wire.
 */
export function timedRand(clock, index, roomOf) {
  let epoch = -1;
  let room = null;
  let next = null;
  return () => {
    const e = Math.floor(clock() / 1000 / EPOCH_SECONDS);
    const r = roomOf();
    if (e !== epoch || r !== room) {
      epoch = e;
      room = r;
      next = splitmix(xmur3(`${epoch}|${index}|${room}`));
    }
    return next();
  };
}

/** The page's verbs that are the server's to do, by the argument shapes game.js gives them. */
const OPS = [
  'take', 'takeAll', 'wear', 'wield', 'remove', 'drop', 'put', 'getFrom', 'useItem', 'buy', 'sell', 'practice',
  'train', 'openObj', 'closeObj', 'lockObj', 'unlockObj', 'pickObj', 'openDoor', 'closeDoor', 'lockDoor',
  'unlockDoor', 'pickDoor', 'useDoor', 'rest', 'sit', 'sleep', 'stand', 'sneak', 'hide', 'visible', 'recall',
  'breakOff', 'useAction', 'kick', 'backstab', 'disarm', 'steal', 'rescue', 'drink', 'eat', 'fill', 'sacrifice',
  'dropGold', 'dropAll', 'wearAll', 'value', 'compare', 'attackSlot',
];
/** How soon a second click on a player who was refused do_kill becomes do_murder. */
const MURDER_WINDOW_MS = 4000;
/** Typed at the command line, these move the body here: interp.c's first six, by its prefix rule. */
const DIRS = ['north', 'east', 'south', 'west', 'up', 'down'];
/** Combat lines: when another player is one side, the room reads them; nothing is "you". */
const BLOWS = new Set(['hit', 'miss', 'parry', 'dodge', 'disarm', 'kick', 'backstab']);
const SPELLS = new Set(['cast', 'spell', 'spell-fizzle', 'suffer']);

/**
 * Turn the page's game into the server's copy. `host` is what main.js lends
 * it: the drawn zone and its bodies, the camera, the way to move the player
 * (teleport, walk an exit), and what to do when the link drops.
 */
export function attachSocketLink(link, game, host, enter) {
  const { mirror } = game;
  mirror.become();
  const mobs = game.mobs;
  const slotIndex = new Map(mobs.map((slot, i) => [slot, i]));
  let seq = enter.seq;
  let id = enter.id;
  const remotes = new Map();
  const offs = [];

  // -- what goes out ----------------------------------------------------------
  /** A reference to send: an object by its server id, a mobile by its index, a player by id. */
  function ref(value) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(ref);
    if (value.mirrorId !== undefined) return { o: value.mirrorId };
    if (slotIndex.has(value)) return { m: slotIndex.get(value) };
    if (value.npc === true && value.slot) return { m: slotIndex.get(value.slot) };
    if (value.npc === false && value.remoteId !== undefined) return { p: value.remoteId };
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = ref(v);
    return out;
  }
  const pending = { ok: true, text: '', pending: true };
  for (const op of OPS) {
    game[op] = (...args) => { link.send({ t: 'op', op, a: args.map(ref) }); return pending; };
  }
  // takeAll hands back a list in the page; the server sends what it did as events.
  game.takeAll = (obj) => { link.send({ t: 'op', op: 'takeAll', a: [ref(obj)] }); return []; };
  game.attack = () => {
    const slot = game.facingSlot();
    const remote = facingRemote();
    const eye = host.eye();
    const away = (p) => Math.hypot(p.x - eye.x, p.z - eye.z);
    if (remote && (!slot || away(remote.pc.position) < away(slot.pos))) return strikePlayer(remote);
    if (slot) link.send({ t: 'op', op: 'attackSlot', a: [ref(slot)] });
    return pending;
  };
  /**
   * Another player in front of you and within reach, as `facingTarget` finds
   * a mobile: the best of nearness and how square you face them.
   */
  function facingRemote(reach = 4.6, cone = 0.45) {
    const eye = host.eye();
    const yaw = host.yaw();
    const fx = -Math.sin(yaw); const fz = -Math.cos(yaw);
    let best = null;
    let bestScore = -Infinity;
    for (const r of remotes.values()) {
      if (!r.figure.group.visible) continue;
      const dx = r.pc.position.x - eye.x; const dz = r.pc.position.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4 || d > reach || Math.abs(r.pc.position.y - eye.y) > 2.5) continue;
      const dot = (dx / d) * fx + (dz / d) * fz;
      if (dot < cone) continue;
      const score = dot * 2 - d * 0.12;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  }
  /**
   * A click on a player is fight.c's do_kill, which refuses anyone not
   * flagged KILLER or THIEF: "You must MURDER a player." -- the server says
   * so. DIVERGES: a second click on the same player within a few seconds of
   * that refusal is do_murder, the way typing it out would be; one click
   * never makes you a KILLER.
   */
  let refusedKill = null;
  function strikePlayer(r) {
    const name = r.info.name.toLowerCase();
    const now = performance.now();
    if (refusedKill && refusedKill.id === r.id && now - refusedKill.at < MURDER_WINDOW_MS) {
      refusedKill = null;
      link.send({ t: 'cmd', line: `murder ${name}` });
      return pending;
    }
    // The roster carries the two flags do_kill accepts.
    const flagged = (r.info.flags & (PLR.KILLER | PLR.THIEF)) !== 0;
    refusedKill = flagged ? null : { id: r.id, at: now, name: r.info.name, sex: r.info.sex };
    link.send({ t: 'cmd', line: `kill ${name}` });
    return pending;
  }
  game.cast = (name, { target = null, obj = null } = {}) => {
    const options = {};
    // As game.cast does: an offensive spell with nobody named goes at whoever you face.
    const slot = !target && game.magic.SPELL[name] && game.magic.SPELL[name].target === TAR.OFFENSIVE && !game.state.fighting
      ? game.facingSlot(13, 0.82) : null;
    if (target || slot) options.target = ref(target || slot);
    if (obj) options.obj = ref(obj);
    link.send({ t: 'op', op: 'cast', a: [name, options] });
    return { ok: true, text: '', pending: true };
  };
  const setHour = game.setTimeOfDay;
  game.setTimeOfDay = (name) => { setHour(name); link.send({ t: 'op', op: 'setTimeOfDay', a: [name] }); };
  let focused = null;
  const focus = game.focus;
  game.focus = (figure) => {
    focus(figure);
    const slot = mobs.find((s) => s.figure && s.figure === figure) || null;
    if (slot === focused) return;
    focused = slot;
    link.send({ t: 'op', op: 'focus', a: [slot ? ref(slot) : null] });
  };
  game.interpret = (line) => {
    const text = String(line).trim();
    if (!text) return null;
    const word = text.split(/\s+/)[0].toLowerCase();
    const dir = /^[a-z]+$/.test(word) ? DIRS.findIndex((d) => d.startsWith(word)) : -1;
    // The body is this page's: a direction walks it here, and the server sees it arrive.
    if (dir >= 0 && text === word) {
      const r = host.walk(dir);
      if (r && r.text) game.inject({ kind: 'out', text: r.text });
      return DIRS[dir];
    }
    link.send({ t: 'cmd', line: text });
    return word;
  };
  game.save = () => { link.send({ t: 'cmd', line: 'save' }); return pending; };
  game.quit = () => { link.send({ t: 'cmd', line: 'quit' }); return pending; };
  game.autosave = () => false;
  game.chooseClass = () => false;
  game.savedCharacter = () => null;

  // -- what comes in ----------------------------------------------------------
  const local = (r) => {
    if (!r || typeof r !== 'object') return r;
    if (r.m !== undefined) return mobs[r.m] || null;
    if (r.p !== undefined) return remotes.get(r.p) ? { remote: remotes.get(r.p) } : null;
    if (r.o !== undefined) return findObject(r.o) || r;
    return r;
  };
  function findObject(oid) {
    const look = (list) => {
      for (const obj of list) {
        if (!obj) continue;
        if (obj.mirrorId === oid) return obj;
        const inner = obj.contains && obj.contains.length ? look(obj.contains) : null;
        if (inner) return inner;
      }
      return null;
    };
    return look(game.state.inventory) || look(game.state.equipment) || look(game.ground);
  }

  /** One event off the wire, back into game.js's terms, and into its stream. */
  function receive(event) {
    for (const key of ['from', 'to', 'slot']) if (key in event) event[key] = local(event[key]);
    if (event.obj) event.obj = local(event.obj);
    const remoteSide = [event.from, event.to].find((side) => side && side.remote);
    if (remoteSide && (BLOWS.has(event.kind) || SPELLS.has(event.kind))) {
      // Another player struck or was struck: the room's line, and their body moves.
      const attacker = event.from && event.from.remote;
      const victim = event.to && event.to.remote;
      if (attacker && BLOWS.has(event.kind)) attacker.figure?.perform(event.attack === 'hit' && !event.armed ? 'attack2' : 'attack');
      if (victim && event.kind === 'hit') victim.figure?.perform('hit');
      if (!event.text) return;
      game.inject({ kind: 'room', text: event.text, combat: event.kind });
      return;
    }
    if (event.kind === 'teleport' || event.kind === 'recall') {
      if (event.seq) seq = Math.max(seq, event.seq);
      if (event.vnum !== undefined) host.teleport(event.vnum);
    }
    if (event.kind === 'follow') host.walk(event.dir);
    if (refusedKill && event.text === 'You must MURDER a player.' && performance.now() - refusedKill.at < MURDER_WINDOW_MS) {
      game.inject(event);
      const them = refusedKill.sex === 2 ? 'her' : refusedKill.sex === 1 ? 'him' : 'it';
      game.inject({ kind: 'note', text: `Click ${refusedKill.name} again to MURDER ${them}.` });
      return;
    }
    if (event.kind === 'emote' || event.kind === 'say' || event.kind === 'tell' || event.kind === 'channel' || event.kind === 'gtell') {
      event.heard = true;
      // Said aloud in the room: the words over the speaker's head as well as in the log.
      const speaker = event.kind === 'say' && event.speaker && [...remotes.values()].find((r) => r.info.name === event.speaker);
      if (speaker && event.said) speaker.figure.say(event.said);
    }
    game.inject(event);
  }

  offs.push(link.on('ev', (msg) => { for (const event of msg.e) receive(event); }));
  offs.push(link.on('self', (msg) => mirror.self(msg.c, msg.k || null)));
  offs.push(link.on('mob', (msg) => { for (const [i, ...view] of msg.m) mirror.mob(i, view); }));
  offs.push(link.on('ground', (msg) => { if (msg.z === host.zoneId()) mirror.ground(msg.o); }));
  offs.push(link.on('weather', (msg) => mirror.weather(msg.w)));
  // The shop panel reads the server's keeper: its stock rolled there, its
  // prices and offers worked out there. Rolled here, the list showed a
  // different sword at a different price than the one buying gave you.
  let shop = null;
  game.shopHere = () => shop;
  offs.push(link.on('shop', (msg) => {
    const v = msg.s;
    shop = v && {
      keeper: v.keeper, slot: mobs[v.m] || null, name: v.name, open: v.open, hours: v.hours, sellsBack: v.sellsBack,
      stock: v.stock.map(({ vnum, name, level, itemType, cost }) => ({ obj: { vnum, name, level, itemType }, cost })),
      offers: v.offers.map(([oid, cost]) => ({ id: oid, cost })),
    };
  }));
  // Who holds each gate and whether it is still held: the server's word, so a
  // warden killed by someone else opens the gate on this map too.
  offs.push(link.on('gates', (msg) => {
    for (const [vnum, dir, open, level] of msg.g) {
      for (const gate of game.gates) {
        if (gate.vnum !== vnum || gate.dir !== dir) continue;
        gate.open = !!open;
        gate.wardenLevel = level;
      }
    }
  }));
  offs.push(link.on('enter', (msg) => { seq = msg.seq; id = msg.id; host.teleport(msg.room); }));
  // A report the server would not believe: back to where it has you.
  offs.push(link.on('at', (msg) => {
    seq = Math.max(seq, msg.seq);
    host.place(msg);
  }));
  offs.push(link.on('who', (msg) => {
    for (const [rid, name, title, level, cls, sex, position, flags, percent, linkdead, fighting, weapon, shield] of msg.add) {
      const info = { name, title, level, cls, sex, position, flags, percent, linkdead, fighting, weapon, shield };
      const known = remotes.get(rid);
      // A change of gear is a change of body; anything else is only the record.
      if (known && (known.info.weapon !== weapon || known.info.shield !== shield || known.info.cls !== cls)) dropRemote(rid);
      if (remotes.has(rid)) { Object.assign(remotes.get(rid).info, info); syncRemoteCh(remotes.get(rid)); } else addRemote(rid, info);
    }
    for (const rid of msg.del) dropRemote(rid);
  }));
  offs.push(link.on('pos', (msg) => {
    for (const [rid, x, y, z, yaw] of msg.p) {
      const r = remotes.get(rid);
      if (!r) continue;
      r.samples.push({ at: msg.at, x, y, z, yaw });
      if (r.samples.length > 12) r.samples.shift();
    }
  }));
  offs.push(link.on('bye', (msg) => host.disconnected(msg.why === 'quit' ? 'You have left the game.' : msg.why)));
  offs.push(link.on('closed', () => host.disconnected('The connection to the server was lost.')));

  function addRemote(rid, info) {
    const ch = {
      npc: false, remoteId: rid, name: info.name, displayName: info.name, title: info.title, level: info.level, class: info.cls,
      sex: info.sex, position: info.position, act: info.flags, hit: info.percent, maxHit: 100,
      equipment: [], inventory: [], affected: [], affectedBy: 0, alignment: 0, fighting: null,
    };
    const pc = game.addRemote(ch, rid);
    const figure = createPlayerFigure({
      library: host.library, name: info.name, title: info.title, cls: info.cls, sex: info.sex, level: info.level,
      weapon: info.weapon, shield: info.shield, objProtos: host.world.objProtos, roomAt: host.roomAt,
    });
    host.scene.add(figure.group);
    figure.group.visible = false;
    const r = { id: rid, info, ch, pc, figure, samples: [], shown: null, said: null };
    remotes.set(rid, r);
    mirror.remotes.set(rid, r);
  }
  function syncRemoteCh(r) {
    Object.assign(r.ch, { title: r.info.title, level: r.info.level, position: r.info.position, act: r.info.flags, hit: r.info.percent });
  }
  function dropRemote(rid) {
    const r = remotes.get(rid);
    if (!r) return;
    r.figure.dispose();
    game.removeRemote(r.pc);
    remotes.delete(rid);
    mirror.remotes.delete(rid);
  }

  // -- the clock and the frame ------------------------------------------------
  host.teleport(enter.room);
  link.release();
  link.ping();
  const pinger = setInterval(() => link.ping(), 2000);
  let sendIn = 0;
  let restrolled = null;

  /** Every mobile in the drawn zone strolls by the server's clock, not its own. */
  function restroll() {
    const actors = host.actors();
    if (!actors || restrolled === actors) return;
    restrolled = actors;
    const clock = () => link.serverNow();
    mobs.forEach((slot, i) => {
      if (!slot.figure || !slot.figure.m) return;
      slot.figure.rand = timedRand(clock, i, () => slot.roomVnum);
    });
  }

  function update(dt) {
    restroll();
    // Where you are, ten times a second, in your zone's own frame.
    sendIn -= dt;
    if (sendIn <= 0 && !host.crossing()) {
      sendIn += 1 / SEND_HZ;
      if (sendIn < 0) sendIn = 0;
      const eye = host.eye();
      link.send({ t: 'pos', zone: host.zoneId(), x: round(eye.x), y: round(eye.y), z: round(eye.z), yaw: round(host.yaw()), seq });
    }
    // Everyone else, a tenth of a second behind the server, between two reports.
    const at = link.serverNow() - BEHIND_MS;
    for (const r of remotes.values()) drawRemote(r, at, dt);
  }

  function drawRemote(r, at, dt) {
    const s = r.samples;
    if (!s.length) return;
    let a = s[0];
    let b = s[0];
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i].at <= at && s[i + 1].at >= at) { a = s[i]; b = s[i + 1]; break; }
      if (s[i + 1].at < at) { a = s[i + 1]; b = s[i + 1]; }
    }
    const span = b.at - a.at;
    const f = span > 0 ? Math.min(1, Math.max(0, (at - a.at) / span)) : 1;
    const eye = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    const yaw = a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * f;
    const pace = span > 0 ? Math.hypot(b.x - a.x, b.z - a.z) / (span / 1000) : 0;
    // Soft separation: nobody stands inside you; a body overlapping yours is
    // nudged aside on screen, never stopped -- the server holds no collision.
    const me = host.eye();
    const dx = eye.x - me.x; const dz = eye.z - me.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-3 && d < 0.55 && Math.abs(eye.y - me.y) < 1.5) { eye.x = me.x + (dx / d) * 0.55; eye.z = me.z + (dz / d) * 0.55; }
    r.pc.position.x = eye.x; r.pc.position.y = eye.y; r.pc.position.z = eye.z;
    game.feetOf(r.ch);
    r.figure.group.visible = true;
    r.figure.update(dt, { x: eye.x, y: eye.y - 1.72, z: eye.z }, yaw, Math.min(pace, 9));
  }

  return {
    mode: 'socket', link, remotes,
    get id() { return id; },
    update,
    close() {
      clearInterval(pinger);
      for (const off of offs) off();
      for (const rid of [...remotes.keys()]) dropRemote(rid);
      link.close();
    },
    /** The direction words a typed line can walk, for anyone asking. */
    DIR_NAME,
  };
}

const round = (v) => Math.round(v * 100) / 100;
