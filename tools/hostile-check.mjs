/**
 * What a client that does not play by the page's rules can do to the server:
 * objects and references it made up, a verb named with the wrong arguments,
 * two logins at once, control characters in a typed line, floods of notes and
 * password changes, guessing from many addresses, a page on another site, a
 * ban that matched a suffix, and a session whose character breaks a save. Boots
 * server/ in-process on a free port with a throwaway data directory and talks
 * to it over real WebSockets, from made-up addresses (x-real-ip, which the
 * server believes from loopback, as from nginx).
 *
 *     (cd server && npm ci) && node tools/hostile-check.mjs [repository root]
 *
 * The root defaults to this checkout; another (an older commit, unpacked) is
 * how the checks are shown to fail on the code they guard against. Exits
 * non-zero if any assertion fails, or if anything escaped to the process.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'));
const from = (path) => import(pathToFileURL(join(root, path)).href);
const require = createRequire(join(root, 'server/package.json'));
let WebSocket;
try { WebSocket = require('ws'); } catch (error) {
  throw new Error(`tools/hostile-check.mjs needs the server's dependencies: (cd server && npm ci) -- ${error.message}`);
}
const { startMud } = await from('server/mud.mjs');
const { createAccounts, hashPassword, checkPassword } = await from('server/accounts.mjs');
const { createNotes, createSite } = await from('server/store.mjs');
const { serialize } = await from('src/save.js');
const { createCharacter, advanceLevel, createObject, Rng } = await from('src/game.js');
const { EX_CLOSED } = await from('src/are.js');

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};
// What reaches the process instead of a session: on the code this guards, the end of the mud.
const escaped = [];
const self = fileURLToPath(import.meta.url);
/** Errors this file throws into the server on purpose: what the server does with them is what is checked. */
const planted = new Set();
const caught = (error) => {
  // Thrown by this file's own code: the check cannot go on, and says where.
  if (!planted.has(error) && String(error && error.stack).split('\n')[1]?.includes(self)) {
    console.log(`\nthe check itself failed: ${error.stack}`);
    process.exit(2);
  }
  escaped.push(error);
};
process.on('uncaughtException', caught);
process.on('unhandledRejection', caught);

const data = mkdtempSync(join(tmpdir(), 'diku3d-hostile-check-'));
// A board ten short of full, none of it to anyone who plays here.
const BOARD_MAX = 2000;
writeFileSync(join(data, 'notes.json'), `${JSON.stringify({
  version: 1,
  notes: Array.from({ length: BOARD_MAX - 10 }, (_, i) => ({ sender: 'Nobody', date: 'Thu Jan  1 00:00:00 2026', stamp: i + 1, to: 'nobody', subject: `old ${i}`, text: '' })),
})}\n`);
const logs = [];
const TOTAL = 16;
const mud = await startMud({ root, dataDir: data, port: 0, seed: 4011, log: (text) => logs.push(text), limits: { socketsTotal: TOTAL } });
const { game, world: w } = mud;
const url = `ws://127.0.0.1:${mud.port}/ws`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const logged = (re) => logs.some((line) => re.test(line));

/** A room's middle in its own zone's frame, eye high: where a client stands (as server-check). */
function spot(vnum, dx = 0, dz = 0) {
  const info = w.built.rooms.get(vnum);
  const z = w.zoneOfVnum(vnum);
  return { zone: z.zone.id, x: info.center.x - z.offset + dx, y: info.center.y + (w.lifts.get(vnum) || 0) + 1.72, z: info.center.z + dz };
}

let nextIp = 1;
/** One connection, from its own address unless told otherwise. */
function client(label, { ip = `198.51.100.${nextIp++}`, origin, headers = {} } = {}) {
  const ws = new WebSocket(url, { headers: { ...(ip ? { 'x-real-ip': ip } : {}), ...headers }, ...(origin ? { origin } : {}) });
  const c = {
    label, ws, ip, messages: [], events: [], id: null, seq: 0, self: {}, kit: null, closed: null, error: null,
    send: (msg) => ws.send(JSON.stringify(msg)),
    say: (line) => c.send({ t: 'cmd', line }),
    op: (op, ...a) => c.send({ t: 'op', op, a }),
    mark: () => c.events.length,
    text: (from = 0) => c.events.slice(from).map((e) => e.text).filter(Boolean),
    line: (re, from = 0) => c.events.slice(from).find((e) => e.text && re.test(e.text)),
    async waitFor(pred, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { const hit = pred(c); if (hit) return hit; await pause(15); }
      return null;
    },
    async at(vnum, dx = 0, dz = 0) {
      const seq = c.seq;
      if (mud.place(c.id, vnum)) await c.waitFor((x) => x.seq > seq);
      c.send({ t: 'pos', ...spot(vnum, dx, dz), yaw: 0, seq: c.seq });
      await pause(150);
    },
  };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    c.messages.push(msg);
    if (msg.t === 'ev') c.events.push(...msg.e);
    else if (msg.t === 'enter') { c.id = msg.id; c.seq = msg.seq; c.token = msg.token; }
    else if (msg.t === 'at') c.seq = Math.max(c.seq, msg.seq);
    else if (msg.t === 'self') { Object.assign(c.self, msg.c); if (msg.k) c.kit = msg.k; }
    if (msg.t === 'ev') for (const e of msg.e) if (e.seq) c.seq = Math.max(c.seq, e.seq);
  });
  ws.on('close', (code, reason) => { c.closed = { code, reason: reason.toString() }; });
  ws.on('error', (error) => { c.error = error.message; });
  c.opened = new Promise((r) => { ws.once('open', () => r(true)); ws.once('close', () => r(false)); ws.once('error', () => r(false)); });
  return c;
}
const loginReply = (c, n = 1) => c.waitFor((x) => x.messages.filter((mm) => mm.t === 'login' || mm.t === 'enter').length >= n && x.messages.filter((mm) => mm.t === 'login' || mm.t === 'enter')[n - 1]);
/** A new character, in the world, waiting at the Mud School. */
async function player(name, { cls = 3, ip, password = 'hunter22' } = {}) {
  const c = client(name, { ip });
  await c.opened;
  c.send({ t: 'create', name, password, cls, sex: 'f' });
  await c.waitFor((x) => x.id !== null, 5000);
  if (c.id === null) throw new Error(`${name} did not enter: ${JSON.stringify(c.messages.filter((mm) => mm.t === 'login'))}`);
  await c.waitFor((x) => x.kit, 2000);
  return c;
}
const pcOf = (name) => game.players.find((p) => p.ch.name === name);
const bodies = (name) => game.players.filter((p) => p.ch.name === name).length;
const closeAll = async (list) => { for (const c of list) c.ws.close(); await pause(200); };
const openSockets = () => [...mud.sessions].filter((s) => s.open).length;

// ------------------------------------------------------------- the door --
console.log('\nA PAGE ON ANOTHER SITE, AND HOW MANY SOCKETS');
{
  const evil = client('evil page', { origin: 'https://evil.example' });
  check(!(await evil.opened), "a socket opened by another site's page (Origin https://evil.example) is refused", evil.error || 'it opened');
  const local = client('local page', { origin: 'http://localhost:8173' });
  check(await local.opened, 'a page on this machine (Origin http://localhost:8173) may open one', local.error);
  const own = client("the mud's own page", { origin: 'https://diku3d.test', headers: { host: 'diku3d.test' } });
  check(await own.opened, "a page of the host the socket was asked of (Origin https://diku3d.test, Host diku3d.test) may", own.error);
  const bare = client('no origin');
  check(await bare.opened, 'a client that is no browser sends no Origin, and may', bare.error);
  await closeAll([evil, local, own, bare]);

  const held = [];
  while (openSockets() < TOTAL && held.length < TOTAL + 2) {
    const c = client(`socket ${held.length}`, { ip: null });
    held.push(c);
    if (!(await c.opened)) break;
    await pause(10);
  }
  const over = client('one too many', { ip: null });
  const opened = await over.opened;
  await over.waitFor((x) => x.closed, 1000);
  check(openSockets() <= TOTAL && (!opened || (over.closed && over.closed.code === 1013)) && over.closed && /as many connections/.test(over.closed.reason),
    `past ${TOTAL} sockets in all the next is refused in words`, over.closed ? `${over.closed.code} ${over.closed.reason}` : `still open, ${openSockets()} open`);
  await closeAll([...held, over]);
}

// --------------------------------------------- what a client makes up --
console.log('\nOBJECTS AND REFERENCES A CLIENT MAKES UP');
const mal = await player('Mallory', { cls: 0 });
const mpc = () => pcOf('Mallory');
{
  const gold = mpc().ch.gold;
  mal.op('take', { wearFlags: 1, itemType: 20, values: [1000000], name: 'a pile', keywords: 'pile' });
  await pause(400);
  check(mpc().ch.gold === gold, 'a money object the client wrote itself gives no gold', `${gold} -> ${mpc().ch.gold}`);
  check(logged(/^Mallory@[^:]+: take refused/), '...the op is refused and logged, naming who and which op', logs.filter((l) => /refused/.test(l)).slice(-1)[0]);
  mal.op('take', {
    vnum: 0, name: 'a fabricated blade', keywords: 'blade', description: '', itemType: 5, extraFlags: 0, wearFlags: 8193,
    values: [0, 500, 500, 3], weight: 1, cost: 0, level: 0, wearLoc: -1, timer: 0, contains: [], affects: [],
  });
  await pause(400);
  check(!mpc().ch.inventory.some((o) => o.name === 'a fabricated blade'), 'nor does a 500d500 weapon it wrote reach the pack');

  let m = mal.mark();
  mal.op('buy', { keeper: 1 }, 3001);
  await pause(300);
  check(!!mal.line(/^buy: /, m), "buy with an object where the keeper's number goes is refused", mal.text(m).slice(-1)[0]);
  m = mal.mark();
  mal.op('remove', '__proto__');
  await pause(300);
  check(Array.prototype.wearLoc === undefined && !mal.line(/stumbles/, m) && !!mal.line(/^remove: /, m), "remove('__proto__') is refused, and Array.prototype is left alone", mal.text(m).slice(-1)[0]);
  delete Array.prototype.wearLoc;
  m = mal.mark();
  mal.op('remove', 'length');
  await pause(300);
  check(!mal.line(/stumbles/, m) && !!mal.line(/^remove: /, m), "remove('length') is refused, not thrown", mal.text(m).slice(-1)[0]);
  m = mal.mark();
  mal.op('openDoor', 3700, 2, { m: 0 });
  await pause(300);
  check(!!(w.world.rooms.get(3700).exits[2].locks & EX_CLOSED) && !!mal.line(/^openDoor: /, m), 'a door verb with a third argument (a mobile to do it) is refused, and the door stays shut', mal.text(m).slice(-1)[0]);
  const dagger = mal.kit.equipment[16];
  m = mal.mark();
  mal.op('useItem', { o: dagger.id }, { evil: 1 });
  await pause(300);
  check(!!mal.line(/^useItem: /, m), 'an option useItem does not take is refused', mal.text(m).slice(-1)[0]);
  m = mal.mark();
  mal.op('take', { o: dagger.id, values: [1] });
  await pause(300);
  check(!!mal.line(/^take: /, m), 'a reference with more than its one key is refused', mal.text(m).slice(-1)[0]);
}

console.log('\nTHE VERBS THEMSELVES');
{
  const dagger = mal.kit.equipment[16];
  mal.op('remove', 16);
  await mal.waitFor((x) => x.kit.inventory.some((o) => o.id === dagger.id));
  const daggers = () => mpc().ch.inventory.filter((o) => o.name === dagger.name).length;
  check(daggers() === 1, 'remove with a wear slot still works', daggers());
  let m = mal.mark();
  mal.op('take', { o: dagger.id });
  await pause(300);
  check(daggers() === 1, "take of what the pack holds already does not put it in twice", `${daggers()} daggers`);
  const gold = mpc().ch.gold;
  mal.op('sacrifice', { o: dagger.id });
  await pause(300);
  check(mpc().ch.gold === gold && daggers() >= 1, 'sacrifice of a thing carried pays nothing and leaves it carried', `gold ${gold} -> ${mpc().ch.gold}, ${daggers()} daggers`);

  // A bag in the pack with a thing in it, and a shut one.
  const proto = (vnum) => w.world.objProtos.get(vnum);
  const bag = createObject(proto(1111), 1);
  const ration = createObject(proto(dagger.vnum), 1);
  bag.contains.push(ration);
  const shut = createObject(proto(1111), 1);
  shut.values[1] = 1 | 4;
  const locked = createObject(proto(dagger.vnum), 1);
  shut.contains.push(locked);
  mpc().ch.inventory.push(bag, shut);
  // The kit lists the pack in its order, so a thing's id is at its place there.
  const viewOf = (obj) => mal.kit.inventory[mpc().ch.inventory.indexOf(obj)];
  await mal.waitFor(() => viewOf(shut) && viewOf(shut).contains.length === 1 && viewOf(bag) && viewOf(bag).contains.length === 1);
  const bagId = viewOf(bag).id;
  const shutId = viewOf(shut).id;
  const lockedId = viewOf(shut).contains[0].id;
  mal.op('drop', { o: dagger.id });
  await pause(300);
  const lying = game.ground.find((o) => o.name === dagger.name && o.inRoom === mpc().ch.roomVnum);
  check(!!lying, 'drop puts it on the ground');
  m = mal.mark();
  mal.op('take', { o: dagger.id }, { o: bagId });
  await pause(300);
  check(bag.contains.length === 1 && bag.contains[0] === ration && game.ground.includes(lying) && !mpc().ch.inventory.includes(lying),
    'take of a thing on the ground "from" a bag that does not hold it takes nothing, and empties nothing out of the bag',
    `bag holds ${bag.contains.length}, on the ground ${game.ground.includes(lying)}, carried ${mpc().ch.inventory.includes(lying)}`);
  mal.op('take', { o: lockedId }, { o: shutId });
  await pause(300);
  check(shut.contains.includes(locked) && !mpc().ch.inventory.includes(locked), 'nothing is taken out of a shut container', mal.text(m).slice(-1)[0]);

  mal.op('setTimeOfDay', '__proto__');
  await pause(300);
  check(typeof mpc().ch.hour === 'number', "setTimeOfDay('__proto__') leaves the hour a number", typeof mpc().ch.hour);
  mpc().ch.hour = 12;

  // A mobile of this zone well out of reach, by its index: the spell flies to it (and so lands within seconds).
  const here = w.zoneOfVnum(mpc().ch.roomVnum)?.zone.id;
  const at = mpc().position;
  const far = game.mobs.findIndex((s) => !s.dead && s.roomVnum !== mpc().ch.roomVnum
    && w.zoneOfVnum(s.roomVnum)?.zone.id === here && Math.max(Math.abs(s.pos.x - at.x), Math.abs(s.pos.z - at.z)) > 30);
  if (far < 0) throw new Error(`no living mobile in zone ${here} more than 30 m from the player`);
  // A mobile is made when first needed (db.c create_mobile, game.js wake).
  const victim = game.wakeSlot(game.mobs[far]);
  const hp = victim.hit;
  Object.assign(mpc().ch, { mana: 500 });
  mpc().ch.learned['magic missile'] = 100;
  m = mal.mark();
  mal.op('cast', 'magic missile', { target: { m: far } });
  // magic.js FLIGHT: a missile flies 15 m a second; give it that and two seconds more to land.
  const metres = Math.hypot(game.mobs[far].pos.x - at.x, game.mobs[far].pos.z - at.z);
  await pause(1000 * (metres / 15 + 2));
  check(victim.hit === hp, `a spell cast at a mobile out of reach (#${game.mobs[far].roomVnum}, over 30 m off) does not reach it`, `hp ${hp} -> ${victim.hit}; ${mal.text(m).slice(-1)[0]}`);

  // A door across the world, and one at hand.
  const farDoor = w.world.rooms.get(9141).exits[1];
  const wasShut = !!(farDoor.locks & EX_CLOSED);
  mal.op('openDoor', 9141, 1);
  await pause(300);
  check(wasShut && !!(farDoor.locks & EX_CLOSED), 'a door in another zone (#9141 east) cannot be opened from the Mud School');
  mal.op('openDoor', 3700, 2);
  await pause(300);
  check(!(w.world.rooms.get(3700).exits[2].locks & EX_CLOSED), "...and the school's own door, by the player, still opens");

  // train at a trainer, with a word that is a key of every object.
  const trainer = game.mobs.find((s) => !s.dead && (s.proto.act & 512));
  const pc = mpc();
  Object.assign(pc.position, { x: trainer.pos.x + 1, y: trainer.pos.y + 1.72, z: trainer.pos.z });
  pc.ch.roomVnum = trainer.roomVnum;
  m = mal.mark();
  mal.op('train', '__proto__');
  await pause(300);
  check(!mal.line(/stumbles/, m) && !!mal.line(/practice sessions|nothing left to train/, m), "train('__proto__') at a trainer is answered as an unknown stat, not thrown", mal.text(m).slice(-1)[0]);
  game.placePlayer(pc, 3700, { quiet: true });
}

// -------------------------------------------------------- the nanny --
console.log('\nTWO LOGINS AT ONCE');
{
  const nadia = await player('Nadia');
  nadia.say('quit');
  await nadia.waitFor((x) => x.closed);
  const again = client('Nadia twice');
  await again.opened;
  again.send({ t: 'login', name: 'Nadia', password: 'hunter22' });
  again.send({ t: 'login', name: 'Nadia', password: 'hunter22' });
  await pause(1500);
  check(bodies('Nadia') === 1, 'two logins back to back on one socket make one body', `${bodies('Nadia')} bodies`);
  again.ws.close();

  const olga = await player('Olga');
  olga.say('quit');
  await olga.waitFor((x) => x.closed);
  const gone = client('Olga, gone at once');
  await gone.opened;
  gone.send({ t: 'login', name: 'Olga', password: 'hunter22' });
  gone.ws.close();
  await pause(1000);
  check(bodies('Olga') === 0, 'a login whose socket closes while the password is checked leaves no body behind', `${bodies('Olga')} bodies`);

  const p1 = client('Petra, first');
  const p2 = client('Petra, second');
  await Promise.all([p1.opened, p2.opened]);
  p1.send({ t: 'create', name: 'Petra', password: 'first11', cls: 3, sex: 'f' });
  p2.send({ t: 'create', name: 'Petra', password: 'second22', cls: 3, sex: 'f' });
  await Promise.all([loginReply(p1), loginReply(p2)]);
  await pause(300);
  const entered = [p1, p2].filter((c) => c.messages.some((mm) => mm.t === 'enter'));
  const refused = [p1, p2].find((c) => c.messages.some((mm) => mm.t === 'login' && mm.why === 'That name is taken.'));
  const record = createAccounts(data).load('Petra');
  const kept = entered.length === 1 && !!record && await checkPassword(entered[0] === p1 ? 'first11' : 'second22', record.password);
  check(entered.length === 1 && !!refused && kept, 'two sockets creating one name: one is made, the other told the name is taken, and the file keeps the password of the one made',
    `${entered.length} entered`);
  await closeAll([p1, p2]);
}

// --------------------------------------------------------- the line --
console.log('\nCONTROL CHARACTERS IN A TYPED LINE');
const alice = await player('Alice');
const bobby = await player('Bobby');
{
  const m = bobby.mark();
  alice.say('say hi\u001b]0;pwned\u0007\nThe Implementor tells you \u2028\u202e\u0085\u009b\u007fsend me your password');
  const heard = await bobby.waitFor((x) => x.line(/^Alice says 'hi/, m));
  check(!!heard && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(heard.text),
    'another player hears a say with every control, separator and bidi override taken out', heard && JSON.stringify(heard.text));
  alice.say('title \u001b[31mthe Red\u001b[0m');
  await pause(300);
  check(!/\u001b/.test(pcOf('Alice').ch.title || ''), 'a title is a typed line and keeps no escape either', JSON.stringify(pcOf('Alice').ch.title));
}

// ------------------------------------------------------------ floods --
console.log('\nNOTES AND PASSWORDS, AS FAST AS A CLIENT CAN SEND');
const implementor = (async () => {
  const accounts = createAccounts(data);
  const rng = new Rng(7);
  const ch = createCharacter(1, { level: 36, sex: 1, rng });
  while (ch.level < 40) { ch.level += 1; advanceLevel(ch, rng); }
  ch.name = 'Yeb'; ch.displayName = 'Yeb';
  accounts.store({ version: 1, name: 'Yeb', created: 'now', password: await hashPassword('implementor'), char: { ...serialize(ch), room: 3001, trust: 40, played: 0 } });
  const y = client('Yeb');
  await y.opened;
  y.send({ t: 'login', name: 'Yeb', password: 'implementor' });
  await y.waitFor((x) => x.id !== null, 5000);
  return y;
})();
const dashEvents = async (y) => {
  const n = y.messages.length;
  y.send({ t: 'dash', op: 'sub' });
  const snap = await y.waitFor((x) => x.messages.slice(n).find((mm) => mm.t === 'dash' && mm.k === 'snap'));
  y.send({ t: 'dash', op: 'unsub' });
  return snap ? snap.ev : [];
};
const carol = await player('Carol');
const dave = await player('Dave');
{
  const post = async (c, i) => {
    const m = c.mark();
    c.say('note to nobody');
    c.say(`note subject number ${i}`);
    c.say('note post');
    await c.waitFor((x) => x.text(m).length >= 3);
    return c.text(m)[2];
  };
  const answers = [];
  for (let i = 0; i < 10; i++) answers.push(await post(carol, i));
  check(answers.every((t) => t === 'Ok.'), 'ten notes in an hour from one player go up', answers.filter((t) => t !== 'Ok.').join(' | '));
  check(createNotes(data).list().length === BOARD_MAX, `...and fill the board to ${BOARD_MAX}`, createNotes(data).list().length);
  const eleventh = await post(carol, 10);
  check(eleventh === 'You have posted enough notes for now; try again in a while.', 'the eleventh is refused, in words', eleventh);
  const full = await post(dave, 0);
  check(full === 'The board is full; the implementor has been told.', 'a note to a full board is refused, in words', full);
  check(createNotes(data).list().length === BOARD_MAX, `...and the board stays at ${BOARD_MAX}`, createNotes(data).list().length);
  const y = await implementor;
  const ev = await dashEvents(y);
  check(ev.some((e) => /Dave could not post .*the board is full/.test(e.text)), '...and the implementor sees it on the dashboard', ev.filter((e) => /board/.test(e.text)).map((e) => e.text).join(' | '));

  mud.sessionNamed('Dave').logged = true;
  let m = dave.mark();
  dave.say('password wrongold newpass1');
  dave.say('password wrongold newpass1');
  await pause(800);
  const wrongs = dave.text(m).filter((t) => /^Wrong password/.test(t)).length;
  check(wrongs === 1 && !!dave.line(/changing your password already/, m), 'two password changes back to back: one runs, the other is told to wait', dave.text(m).join(' | '));
  check(logged(/^Log Dave: password$/) && !logged(/wrongold/), "a logged player's password is logged without what he typed after it", logs.filter((l) => /^Log Dave/.test(l)).join(' | '));
  for (let i = 0; i < 4; i++) {
    m = dave.mark();
    dave.say('password wrongold newpass1');
    await dave.waitFor((x) => x.text(m).length >= 1);
  }
  m = dave.mark();
  dave.say('password wrongold newpass1');
  await dave.waitFor((x) => x.text(m).length >= 1);
  check(/^Too many wrong passwords\./.test(dave.text(m)[0] || ''), 'past five wrong old passwords the login guard pauses the password command too', dave.text(m)[0]);
}

// --------------------------------------------------- many addresses --
console.log('\nMANY ADDRESSES');
{
  const once = async (msg, ip) => {
    const c = client(msg.name, { ip });
    await c.opened;
    c.send(msg);
    const reply = await loginReply(c, 1);
    c.ws.close();
    return reply;
  };
  const erin = await player('Erin');
  erin.ws.close();
  const wrong = { t: 'login', name: 'Erin', password: 'notherpassword' };
  for (let i = 1; i <= 5; i++) await once(wrong, `2001:db8:77:1::${i}`);
  const sixth = await once(wrong, '2001:db8:77:1::6');
  check(sixth && /^Too many wrong passwords\./.test(sixth.why), 'five wrong passwords from five addresses of one IPv6 /64 pause the sixth address in it', sixth && sixth.why);
  const made = [];
  for (let i = 1; i <= 5; i++) made.push(await once({ t: 'create', name: `Vex${'abcde'[i - 1]}`, password: 'hunter22', cls: 3, sex: 'f' }, `2001:db8:88:1::${i}`));
  const sixthNew = await once({ t: 'create', name: 'Vexf', password: 'hunter22', cls: 3, sex: 'f' }, '2001:db8:88:1::6');
  check(made.every((r) => r && r.t === 'enter') && sixthNew && /Too many new characters/.test(sixthNew.why || ''), 'five new characters from one /64, and the sixth is refused', sixthNew && (sixthNew.why || sixthNew.t));

  const fiona = await player('Fiona', { password: 'rightpass' });
  const token = fiona.token;
  fiona.ws.close();
  await pause(200);
  for (let i = 1; i <= 20; i++) await once({ t: 'login', name: 'Fiona', password: `guess${i}x` }, `203.0.113.${i}`);
  const right = await once({ t: 'login', name: 'Fiona', password: 'rightpass' }, '203.0.113.21');
  check(right && right.t === 'login' && /^Too many wrong passwords for Fiona\./.test(right.why), 'twenty wrong passwords for one name from twenty addresses pause password logins for that name', right && (right.why || right.t));
  const back = await once({ t: 'login', name: 'Fiona', token }, '203.0.113.22');
  check(back && back.t === 'enter', '...but not a reconnect with the token the last enter gave', back && (back.why || back.t));
}

console.log('\nBANS');
{
  const dir = mkdtempSync(join(tmpdir(), 'diku3d-hostile-site-'));
  writeFileSync(join(dir, 'site.json'), `${JSON.stringify({ version: 1, wizlock: false, bans: ['1.2.3.4', '10.0.0.0/8', 'bogus.example', '2001:db8:aa::/48'] })}\n`);
  const heard = [];
  const site = createSite(dir, { log: (t) => heard.push(t) });
  check(!site.banned('11.2.3.4') && site.banned('1.2.3.4') && site.banned('::ffff:1.2.3.4'), 'a banned address bans that address, mapped or not, and not one it is the tail of (11.2.3.4)');
  check(site.banned('10.200.3.4') && !site.banned('11.0.0.1'), 'a banned prefix bans what lies under it, by bits');
  check(site.banned('2001:db8:aa:5::1') && !site.banned('2001:db8:ab::1'), '...IPv6 as well');
  check(heard.length === 1 && /bogus\.example/.test(heard[0]), 'an entry in the file that is no address boots, and is logged once', heard.join(' | '));
  check(site.banned('bogus.example') && !site.banned('x.bogus.example'), '...and matches only its own exact text');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nTOKENS AND ERRORS');
{
  const gwen = await player('Gwen');
  const token = gwen.token;
  gwen.ws.close();
  await pause(200);
  const c = client('Gwen, odd token');
  await c.opened;
  c.send({ t: 'login', name: 'Gwen', token: 'é'.repeat(token.length) });
  const reply = await c.waitFor((x) => x.messages.find((mm) => mm.t === 'login' || (mm.t === 'ev' && mm.e.some((e) => /stumbles/.test(e.text || '')))));
  check(reply && reply.t === 'login' && /log in again/.test(reply.why), 'a reconnect token as long in characters but not in bytes is refused, not thrown', JSON.stringify(reply));
  c.ws.close();

  const original = game.interpret;
  const failure = new Error('a test failure');
  planted.add(failure);
  game.interpret = () => { game.interpret = original; throw failure; };
  const m = alice.mark();
  alice.say('look');
  const told = await alice.waitFor((x) => x.line(/^The mud stumbles/, m));
  check(told && told.text === 'The mud stumbles: a test failure', 'a client is told what failed but not where (no frame, no server path)', told && told.text);
  check(logged(/error handling cmd from Alice: Error: a test failure\n\s+at /), '...which stays in the log, stack and all');
}

// ---------------------------------------------- what ends a session --
console.log('\nA SESSION THAT FAILS, AND EVERYONE ELSE');
{
  const y = await implementor;
  const hana = await player('Hana');
  const ivan = await player('Ivan');
  const before = escaped.length;
  // Something no save can write, as a made-up object once was: the tick's sendSelf and autosave throw on it.
  pcOf('Hana').ch.inventory.push({ name: 'a broken thing' });
  await hana.waitFor((x) => x.closed, 2000);
  check(escaped.length === before, 'a character that breaks the tick ends nothing outside its session', escaped.slice(before).map((e) => e.message).join(' | '));
  check(!!hana.messages.find((mm) => mm.t === 'bye') && bodies('Hana') === 0, '...its session is ended, told so, and its body is out of the world', `${bodies('Hana')} bodies`);
  check(logged(/^Hana@[^:]+: the tick .* failed, session ended: TypeError[^\n]*\n\s+at /), '...with the stack in the log');
  check((await dashEvents(y)).some((e) => /^Hana@.*session ended/.test(e.text)), '...and on the dashboard');
  const m = ivan.mark();
  ivan.say('say still here');
  check(!!(await ivan.waitFor((x) => x.line(/^You say 'still here'\.$/, m))), 'everyone else plays on');

  const kesta = await player('Kesta');
  const store = mud.accounts.store;
  const full = new Error('the disk is full');
  planted.add(full);
  mud.accounts.store = (record) => { if (record.name === 'Kesta') throw full; return store(record); };
  const was = escaped.length;
  kesta.ws.close();
  await pause(600);
  mud.accounts.store = store;
  check(escaped.length === was && bodies('Kesta') === 0 && logged(/^Kesta@[^:]+: the save when its link was lost failed, session ended: Error: the disk is full/),
    "a save that fails when a link drops ends that session, not the process", escaped.slice(was).map((e) => e.message).join(' | '));

  // A bag put into a bag it holds is a loop: every save of it recursed until the stack ran out.
  const mp = mpc();
  const outer = createObject(w.world.objProtos.get(1111), 1);
  const inner = createObject(w.world.objProtos.get(1111), 1);
  outer.contains.push(inner);
  mp.ch.inventory.push(outer);
  const view = await mal.waitFor((x) => { const v = x.kit.inventory[mp.ch.inventory.indexOf(outer)]; return v && v.contains.length === 1 && v; });
  if (!view) check(false, 'put of a bag into a bag it holds is refused', 'the pack was never sent with the bags in it');
  else {
    const cyc = escaped.length;
    mal.op('put', { o: view.id }, { o: view.contains[0].id });
    await pause(600);
    check(escaped.length === cyc && mp.ch.inventory.includes(outer) && !inner.contains.includes(outer), 'put of a bag into a bag it holds is refused', escaped.slice(cyc).map((e) => e.message).join(' | '));
  }

  const crash = escaped.length;
  mal.op('take', { wearFlags: 1, itemType: 1, weight: 0, name: 'x', keywords: 'x' });
  await pause(600);
  check(escaped.length === crash && !!pcOf('Mallory'), 'an object with no values, as the review sent it, ends nothing', escaped.slice(crash).map((e) => e.message).join(' | '));
}

if (escaped.length) console.log(`\n${escaped.length} error(s) reached the process:\n${escaped.slice(0, 3).map((e) => e.stack || e).join('\n')}`);
await mud.close();
rmSync(data, { recursive: true, force: true });
const n = failures.length + (escaped.length ? 1 : 0);
console.log(n ? `\n${failures.length} FAILED${escaped.length ? ', and errors reached the process' : ''}: ${failures.join('; ')}` : '\nall checks passed');
process.exit(n ? 1 : 0);
