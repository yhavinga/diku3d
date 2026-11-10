/**
 * The terminal gateway, end to end: boots server/ and server/gateway.mjs
 * in-process on free ports with a throwaway data directory, and plays over
 * real SSH connections -- with a pty as a person's terminal has, and without
 * one as a script's or an agent's -- while a player on a WebSocket, as a
 * page is, watches. Asserts the nanny (a new character, a wrong password),
 * that a typed direction is walked and counted (no position the server
 * refuses, into another zone and back), that the watcher sees the terminal
 * player arrive and stand somewhere, that a pipe gets no colour and no
 * echo, and that exec and one connection too many are refused in words.
 * And what a port open to anyone needs: no control character from the game
 * or the ssh line reaches a terminal, a line or a queue of lines is held only
 * so far (a long script still runs whole, in order), a client that ignores its
 * window or stays after being refused is cut, and connections held are bounded
 * per address and in all (a second gateway with tight limits).
 *
 *     (cd server && npm ci) && node tools/ssh-check.mjs
 *
 * Exits non-zero if any assertion fails.
 */

import { mkdtempSync, rmSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'server/package.json'));
let WebSocket;
let Client;
try { WebSocket = require('ws'); ({ Client } = require('ssh2')); } catch (error) {
  throw new Error(`tools/ssh-check.mjs needs the server's dependencies: (cd server && npm ci) -- ${error.message}`);
}
const { startMud } = await import('../server/mud.mjs');
const { startGateway, newHostKey, LIMITS } = await import('../server/gateway.mjs');
// As a namespace, so a term.mjs without INBOX_MAX fails its checks rather than this import.
const termModule = await import('../server/term.mjs');
const { directionOf } = termModule;
const { LINE_MAX } = await import('../server/client.mjs');

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

const data = mkdtempSync(join(tmpdir(), 'diku3d-ssh-check-'));
const quiet = [];
const mud = await startMud({ root, dataDir: data, port: 0, seed: 4011, log: (text) => quiet.push(text) });
const url = `ws://127.0.0.1:${mud.port}/ws`;
const gateway = await startGateway({ root, port: 0, host: '127.0.0.1', game: url, keyPath: join(data, 'ssh_host_ed25519_key'), log: (text) => quiet.push(text), limits: { perSite: 3 } });
const w = gateway.world;
const roomName = (vnum) => w.world.rooms.get(vnum).name;

/** A room's middle plus (dx, dz) in its own zone's frame, eye high: where a page stands (as server-check.mjs). */
function spot(vnum, dx = 0, dz = 0) {
  const info = w.built.rooms.get(vnum);
  const z = w.zoneOfVnum(vnum);
  return { zone: z.zone.id, x: info.center.x - z.offset + dx, y: info.center.y + (w.lifts.get(vnum) || 0) + 1.72, z: info.center.z + dz };
}

/**
 * An SSH connection's one session: what it printed, and a way to wait for something in it.
 * With `stay` the client does not hang up when the session's channel closes, as OpenSSH does.
 */
async function session({ pty = true, stay = false } = {}) {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({ host: '127.0.0.1', port: gateway.port, username: 'anyone', readyTimeout: 5000 });
  });
  let connClosed = false;
  conn.on('close', () => { connClosed = true; });
  const stream = await new Promise((resolve, reject) => {
    const done = (error, s) => (error ? reject(error) : resolve(s));
    if (pty) conn.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, done); else conn.shell(false, done);
  });
  const s = {
    conn, stream, raw: '', closed: false,
    /** The connection, not the session: closed by the server when the client does not hang up itself. */
    get connClosed() { return connClosed; },
    get text() { return plain(s.raw); },
    mark: () => s.text.length,
    type: (line) => stream.write(pty ? `${line}\r` : `${line}\n`),
    async see(re, label, from = 0, ms = 6000) {
      for (const until = Date.now() + ms; Date.now() < until;) {
        const m = re.exec(s.text.slice(from));
        if (m) { if (label) check(true, label, m[0].trim().slice(0, 70)); return m; }
        await pause(20);
      }
      if (label) check(false, label, `waited ${ms} ms for ${re}; last: ${JSON.stringify(s.text.slice(-160))}`);
      return null;
    },
    async gone(ms = 5000) {
      for (const until = Date.now() + ms; Date.now() < until && !s.closed;) await pause(20);
      return s.closed;
    },
  };
  stream.on('data', (chunk) => { s.raw += chunk.toString(); });
  stream.stderr.on('data', (chunk) => { s.raw += chunk.toString(); });
  stream.on('close', () => { s.closed = true; if (!stay) conn.end(); });
  return s;
}

/**
 * A bare TCP connection that says `ident` (or nothing) and never hangs up of its own accord: a
 * FIN from the server leaves it open (allowHalfOpen). What it read, and whether the server ended
 * it, with a FIN or with a reset (a socket destroyed with unread data in it).
 */
function bare(port, ident = null) {
  const r = { got: '', ended: false };
  r.sock = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => { if (ident) r.sock.write(ident); });
  r.sock.on('data', (d) => { r.got += d.toString('latin1'); });
  r.sock.on('end', () => { r.ended = true; });
  r.sock.on('error', () => { r.ended = true; });
  return r;
}
/** Bare connections, once each has had the server's banner or its end. */
async function settled(list, ms = 3000) {
  for (const until = Date.now() + ms; Date.now() < until && !list.every((r) => r.ended || r.got.startsWith('SSH-2.0-diku3d')); ) await pause(20);
  await pause(200);
  return { held: list.filter((r) => r.got.startsWith('SSH-2.0-diku3d') && !r.ended).length, cut: list.filter((r) => r.ended && !r.got).length };
}

/** A player on a WebSocket, as a page is: what arrived. */
function watcher() {
  const ws = new WebSocket(url);
  const c = {
    ws, events: [], id: null, seq: 0, roster: new Map(), positions: new Map(),
    send: (msg) => ws.send(JSON.stringify(msg)),
    line: (re) => c.events.find((e) => e.text && re.test(e.text)),
  };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.t === 'ev') c.events.push(...msg.e);
    else if (msg.t === 'enter') { c.id = msg.id; c.seq = msg.seq; }
    else if (msg.t === 'who') { for (const [id, name] of msg.add) c.roster.set(id, name); for (const id of msg.del) c.roster.delete(id); }
    else if (msg.t === 'pos') for (const [id, x, y, z] of msg.p) c.positions.set(id, { x, y, z });
    if (msg.t === 'at') c.seq = Math.max(c.seq, msg.seq);
    if (msg.t === 'ev') for (const e of msg.e) if (e.seq) c.seq = Math.max(c.seq, e.seq);
  });
  c.opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return c;
}
async function until(pred, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (pred()) return true; await pause(20); }
  return false;
}

console.log('\nTHE HOST KEY');
// ssh2's own generator wrote 1 key in 256 unparseable (its public key starts with a zero byte), which crashed a start now and then.
{
  const { utils } = require('ssh2');
  let unparsed = 0;
  for (let i = 0; i < 3000; i++) { const key = utils.parseKey(newHostKey()); if (key instanceof Error || !key.isPrivateKey()) unparsed += 1; }
  check(unparsed === 0, 'every new host key parses (3000 made)', `${unparsed} did not`);
}

console.log('\nREADING A DIRECTION');
check(directionOf('n') === 0 && directionOf('s') === 2 && directionOf('we') === 3 && directionOf('do') === 5, 'n, s, we and do are north, south, west and down, as interp.c reads them');
check(directionOf('sa') === -1 && directionOf('l') === -1 && directionOf('') === -1, 'sa, l and an empty word are not directions');

console.log('\nA NEW CHARACTER, AT A TERMINAL');
const temple = 3001;
const school = 3700;
const exits = w.world.rooms.get(temple).exits;
const north = exits[0].to;
const up = exits[4].to;
check(w.zoneOfVnum(up) !== w.zoneOfVnum(temple), `up from the temple (#${up}) is in another zone, so a walk there crosses zones`);
const a = await session();
await a.see(/Diku Mud was created by Hans Henrik Stærfeldt/, 'the greeting is help.are\'s, with the credits the licence keeps');
await a.see(/By what name do you wish to be known\? $/, '...ending in the name prompt');
a.type('Tester');
await a.see(/Password: $/, 'a password is asked for');
a.type('secret1');
await a.see(/Did I get that right, Tester \(Y\/N\)\? $/, 'a new name is confirmed, as comm.c does');
a.type('y');
await a.see(/Please retype password: $/, 'the password is asked again');
a.type('secret1');
await a.see(/What is your sex \(M\/F\/N\)\? $/, 'then the sex');
a.type('x');
await a.see(/That's not a sex\.\s+What IS your sex\? $/, 'a sex that is not one is asked again');
a.type('m');
await a.see(/Select a class \[Mag Cle Thi War\]: $/, 'then the class');
a.type('war');
await a.see(/Welcome to Merc Diku Mud/, 'the character is made and enters the game');
await a.see(new RegExp(roomName(school)), '...and sees the Mud School, where nanny puts a new character');
await a.see(/<\d+hp \d+m \d+mv> $/, 'the prompt shows the vitals');
check(!a.raw.includes('secret1'), 'the password is never echoed');
check(/\x1b\[1;36m/.test(a.raw), 'a pty gets colour: the room name is bold');
const leftSchool = a.mark();
a.type('down');
await a.see(new RegExp(roomName(temple)), `"down" walks out of the school, into the next zone: the temple (#${temple})`, leftSchool, 8000);

console.log('\nWALKING');
const w1 = watcher();
await w1.opened;
w1.send({ t: 'create', name: 'Watcher', password: 'secret9', cls: 1, sex: 'f' });
check(await until(() => w1.id !== null), 'a watcher logs in on a WebSocket');
// One exit away the server believes a walk, not a jump: place() moves nobody, and the report walks there.
const seq = w1.seq;
if (mud.place(w1.id, north)) await until(() => w1.seq > seq);
w1.send({ t: 'pos', ...spot(north, -2.5, 1), yaw: 0, seq: w1.seq });
check(await until(() => mud.sessionNamed('Watcher')?.pc?.ch.roomVnum === north), `...and stands in #${north}, north of the temple`);
const tester = mud.sessionNamed('Tester');
check(!!tester && tester.pc.ch.roomVnum === temple, 'the server has Tester in the temple');
const refusedBefore = mud.stats.refused;
let from = a.mark();
const t0 = Date.now();
a.type('north');
await a.see(new RegExp(`${roomName(north)}`), `"north" is walked, and the room it leads to (#${north}) is looked at`, from);
check(mud.sessionNamed('Tester').pc.ch.roomVnum === north, 'the server counts Tester in that room', `${Date.now() - t0} ms`);
check(await until(() => w1.line(/Tester has arrived\./)), 'a player there on a WebSocket sees Tester arrive');
const testerId = mud.sessionNamed('Tester').pc.id;
check(await until(() => w1.positions.has(testerId) && w1.roster.has(testerId)), '...and has Tester in sight, with a position to draw the figure at');
const none = w.world.rooms.get(north).exits.findIndex((x) => !x);
check(none >= 0, `#${north} has a direction with no exit`);
from = a.mark();
a.type(['north', 'east', 'south', 'west', 'up', 'down'][none]);
await a.see(/Alas, you cannot go that way\./, `a direction with no exit from #${north} is refused as Merc refuses it`, from);
from = a.mark();
a.type('say hello there');
await a.see(/You say 'hello there'/, 'anything else goes to the game as typed', from);
check(await until(() => w1.line(/Tester says 'hello there'/)), '...and the watcher hears it');
from = a.mark();
a.type('s');
await a.see(new RegExp(roomName(temple)), '"s" walks south, back to the temple', from);
from = a.mark();
a.type('up');
await a.see(new RegExp(roomName(up)), `"up" crosses into the next zone (#${up})`, from, 8000);
check(mud.sessionNamed('Tester').pc.ch.roomVnum === up, '...and the server counts Tester there');
from = a.mark();
a.type('down');
a.type('look');
// Two looks at the temple, the arrival's and the typed one, and none at Mud School: the typed look waited for the walk.
await a.see(new RegExp(`${roomName(temple)}[\\s\\S]*${roomName(temple)}`), 'a line typed during a walk waits for it: "look" after "down" looks at the temple', from, 8000);
check(!a.text.slice(from).includes(roomName(up)), '...not at the room the walk set out from');
check(mud.stats.refused === refusedBefore, 'the server refused none of the walking body\'s positions', `${mud.stats.refused - refusedBefore} refused`);

console.log('\nTEXT FROM THE GAME, AT A TERMINAL');
/** What the game could be made to say (a title, a note, a say): a title-setting OSC, a clear screen, a bell, an 8-bit CSI, DEL, NUL, the Unicode separators and a tab. */
const hostile = 'Glyph \x1b]0;owned\x07title, \x1b[2Jclear, bell\x07, csi\x9b31m, del\x7f, nul\x00, line\u2028para\u2029end, tab\there.';
/** ...and what may reach a terminal of it: no control left, every printable character kept, the tab a space. */
const safe = 'Glyph ]0;ownedtitle, [2Jclear, bell, csi31m, del, nul, lineparaend, tab here.';
/** The line as the terminal got it, escape sequences and all. */
async function heard(s, from) {
  if (!await until(() => s.raw.indexOf('here.', from) >= 0)) return null;
  return s.raw.slice(s.raw.indexOf('Glyph ', from), s.raw.indexOf('here.', from) + 5);
}
let rawFrom = a.raw.length;
mud.game.tell(mud.sessionNamed('Tester').pc.ch, { kind: 'out', text: hostile });
let line = await heard(a, rawFrom);
check(line === safe, 'a pty is sent what the game says without ESC, BEL, a C1 control, DEL, NUL or U+2028/2029, its printable text intact', JSON.stringify(line));

console.log('\nA SCRIPT, WITH NO PTY');
const b = await session({ pty: false });
b.stream.write('Piper\nsecret2\ny\nsecret2\nf\nmag\nnorth\nlook\nquit\n');
await b.see(/Did I get that right, Piper \(Y\/N\)\?\n/, 'each question comes on a line of its own');
const schoolNorth = w.world.rooms.get(school).exits[0].to;
await b.see(new RegExp(`${roomName(schoolNorth)}[\\s\\S]*${roomName(schoolNorth)}`), '"north" then "look" looks at the room walked to', 0, 8000);
check(await b.gone(6000), '"quit" ends the session');
check(!/\x1b\[/.test(b.raw), 'no escape sequences at all without a pty');
check(!b.raw.includes('secret2'), 'and no echo of the password');

console.log('\nA LONG LINE AND A LONG SCRIPT, WITH NO PTY');
const p = await session({ pty: false });
p.stream.write('Penna\nsecret4\ny\nsecret4\nf\ncle\n');
await p.see(new RegExp(roomName(school)), 'a second script logs in, in the Mud School', 0, 8000);
rawFrom = p.raw.length;
mud.game.tell(mud.sessionNamed('Penna').pc.ch, { kind: 'out', text: hostile });
line = await heard(p, rawFrom);
check(line === safe, 'a pipe is sent the same text without them too, its printable text intact', JSON.stringify(line));

/** The most each session held of its input since the last call, read every 5 ms. */
const peak = { lines: 0, chars: 0, bytes: 0 };
const sampler = setInterval(() => {
  for (const h of gateway.inputHeld?.() || []) for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], h[k]);
}, 5);
const peaked = () => { const was = { ...peak }; for (const k of Object.keys(peak)) peak[k] = 0; return was; };

// Four megabytes with no newline, as a pipe can send: the gateway used to keep every byte of it.
from = p.mark();
peaked();
const block = 'x'.repeat(64 * 1024);
for (let i = 0; i < 64; i++) p.stream.write(block);
p.stream.write('\n');
await p.see(/Line too long\./, `four megabytes with no newline are "Line too long.", as comm.c says it (LINE_MAX ${LINE_MAX})`, from, 15000);
let most = peaked();
check(most.chars <= LINE_MAX + 1, '...and of them the gateway held no more than one past LINE_MAX characters at any time', `${most.chars} at most`);
p.type('say still here');
await p.see(/You say 'still here'/, '...and the session goes on', from, 8000);
check(!/went wrong in the gateway/.test(p.text.slice(from)), '...without the gateway failing on the line');

// A script as `ssh host < script` sends it, one line a packet, with directions among the lines: the game takes
// lines more slowly than they come (a walk holds them), so they queue, and the queue holds back the channel.
const LINES = 300;
check(w.world.rooms.get(schoolNorth).exits[2]?.to === school, `south of #${schoolNorth} is the school's entrance again (#${school}), so the script walks to and fro`);
// North first, then south, north and south again between the says: N L1..L75 S L76..L150 N ...
const script = ['north'];
const expected = ['N'];
for (let i = 1; i <= LINES; i++) {
  script.push(`say line ${i}`);
  expected.push(`L${i}`);
  if (i % 75 === 0 && i < LINES) {
    const back = (i / 75) % 2 === 1;
    script.push(back ? 'south' : 'north');
    expected.push(back ? 'S' : 'N');
  }
}
const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const schoolNorthName = roomName(schoolNorth);
from = p.mark();
peaked();
const started = Date.now();
for (const l of script) p.stream.write(`${l}\n`);
p.stream.end();
check(await p.gone(90000), `a script of ${LINES} lines with ${script.length - LINES} directions among them runs to its end`, `${((Date.now() - started) / 1000).toFixed(1)} s`);
most = peaked();
const said = [...p.text.slice(from).matchAll(new RegExp(`You say 'line (\\d+)'|^(${quote(schoolNorthName)}|${quote(roomName(school))})$`, 'gm'))]
  .map((m) => (m[1] ? `L${m[1]}` : m[2] === schoolNorthName ? 'N' : 'S'));
check(said.length === expected.length && said.every((t, i) => t === expected[i]), '...and every line is answered, the directions walked, all in the order sent',
  `${said.filter((t) => t[0] === 'L').length} of ${LINES} said; first difference at ${said.findIndex((t, i) => t !== expected[i])}`);
check(most.lines > 0 && most.lines <= termModule.INBOX_MAX, `...while the lines held never went past INBOX_MAX (${termModule.INBOX_MAX}): the rest waited in the channel`, `${most.lines} at most`);
check(!quiet.some((l) => /Penna.*too fast/.test(l)), '...and the game dropped none of them for coming too fast');

console.log('\nINPUT THAT IGNORES ITS WINDOW');
const f = await session({ pty: false });
f.stream.write('Deluge\nsecret5\ny\nsecret5\nm\nthi\n');
await f.see(new RegExp(roomName(school)), 'a third script logs in', 0, 8000);
// Enough lines that the queue is full and the channel held back...
for (let i = 0; i < 100; i++) f.stream.write(`say hold ${i}\n`);
await pause(500);
peaked();
// ...then a client that sends past its window: ssh2's client keeps the window it may still send in
// outgoing.window, and with that past any window the server gave, it sends whatever it is given.
f.stream.outgoing.window = 2 ** 50;
const flood = Buffer.from('say flood\n'.repeat(6554));
for (let i = 0; i < 128; i++) f.stream.write(flood);
check(await until(() => f.connClosed, 8000), 'a client that sends past its window while its input is held back is cut');
most = peaked();
const cutAt = quiet.map((l) => /(\d+) bytes of input unread, over \d+; cut/.exec(l)).find(Boolean);
check(!!cutAt, '...and the gateway logs why', cutAt?.[0]);
// The cut is seen at the socket's next read (64 KB at most) after the channel passed heldInput.
check(!!cutAt && +cutAt[1] <= LIMITS.heldInput + 128 * 1024 && most.bytes <= LIMITS.heldInput + 128 * 1024,
  `...having held no more than heldInput (${LIMITS.heldInput}) and a read or two of it`, `${cutAt?.[1]} bytes when cut; ${most.bytes} at most between reads`);
clearInterval(sampler);
f.conn.end();

console.log('\nREFUSALS');
/** A command on the ssh line, on a connection of its own: its exit status and everything it printed. */
async function execOnce(command) {
  const e = new Client();
  await new Promise((resolve, reject) => e.on('ready', resolve).on('error', reject).connect({ host: '127.0.0.1', port: gateway.port, username: 'x', readyTimeout: 5000 }));
  const result = await new Promise((resolve, reject) => {
    e.exec(command, (error, stream) => {
      if (error) return reject(error);
      let out = '';
      stream.stderr.on('data', (d) => { out += d; });
      stream.on('data', (d) => { out += d; });
      let code = null;
      // ssh2's client tells the exit status before the stderr that came ahead of it.
      stream.on('exit', (status) => { code = status; });
      stream.on('close', () => resolve({ code, out }));
      return undefined;
    });
  });
  e.end();
  return result;
}
const exec = await execOnce('ls -la');
check(exec.code === 1 && /takes no command/.test(exec.out), 'a command on the ssh line is refused, in words, with exit status 1', exec.out.trim().slice(0, 60));
const shown = (await execOnce('\x1b]0;owned\x07ls\x9b2J\x7f')).out;
check(/\("\]0;ownedls2J"\)/.test(shown) && !/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(shown.replace(/\n$/, '')), '...and the command it quotes back has no control character in it', JSON.stringify(shown.slice(0, 60)));
// The scripts' connections above are let go of once the server has seen them close.
for (let until = Date.now() + 5000; gateway.openConnections() > 1 && Date.now() < until;) await pause(20);
const idle = [await session(), await session()];
const over = await session();
await over.see(/There are already 3 connections from your address\./, 'a fourth connection from one address is refused in words (cap 3 here)');
check(await over.gone(), '...and closed');
const stay = await session({ stay: true });
await stay.see(/There are already 3 connections from your address\./, 'a fifth, whose client stays connected after the words, is refused in words too');
check(await until(() => stay.connClosed, 8000), '...and the server hangs up on it a few seconds later');
// Whatever the server did, so that the gateway's close below has nothing of ours to wait for.
stay.conn.end();
for (const s of idle) s.conn.end();
// conn.end() returns before the server has seen the close; opening the next
// session at once races the per-address count (cap 3) and is refused in words.
for (let until = Date.now() + 5000; gateway.openConnections() > 1 && Date.now() < until;) await pause(20);
check(gateway.openConnections() === 1, 'the gateway has let go of every connection but the first terminal');
// Connections held from one address are bounded as they are accepted, before a word of SSH:
// bare connections that never say anything, on top of the terminal still playing.
for (let until = Date.now() + 5000; gateway.heldConnections?.() !== 1 && Date.now() < until;) await pause(20);
const bares = Array.from({ length: LIMITS.perSiteHeld + 2 }, () => bare(gateway.port));
const room = LIMITS.perSiteHeld - 1;
const counted = await settled(bares);
check(counted.held === room && counted.cut === bares.length - room, `of ${bares.length} more connections from the address of a terminal already playing, ${room} are held (perSiteHeld ${LIMITS.perSiteHeld}) and the rest cut before the server's banner`,
  `${counted.held} held, ${counted.cut} cut, gateway holds ${gateway.heldConnections?.()}`);
for (const r of bares) r.sock.destroy();
for (let until = Date.now() + 5000; gateway.heldConnections?.() !== 1 && Date.now() < until;) await pause(20);
const c = await session();
await c.see(/By what name do you wish to be known\? $/);
c.type('Tester');
for (let i = 0; i < 3; i++) {
  await c.see(/Password: $/, null, c.mark() - 12);
  c.type('wrongpw');
  await pause(150);
}
await c.see(/Wrong password\.[\s\S]*Wrong password\.[\s\S]*Wrong password\./, 'three wrong passwords are each told');
check(await c.gone(), '...and the third closes the connection');
check(!!mud.sessionNamed('Tester'), 'Tester, playing at the other terminal, is still in the game');

console.log('\nA GATEWAY WITH TIGHT LIMITS');
const tightLog = [];
const tight = await startGateway({
  root, port: 0, host: '127.0.0.1', game: url, keyPath: join(data, 'ssh_host_ed25519_key'), log: (text) => tightLog.push(text),
  limits: { totalHeld: 3, perSiteHeld: 100, perMinute: 2, handshakeMs: 800, letGoMs: 300 },
});
const silent = Array.from({ length: 5 }, () => bare(tight.port));
const inAll = await settled(silent);
check(inAll.held === 3 && inAll.cut === 2, 'of five connections, three are held (totalHeld 3) and two cut before the server\'s banner', `${inAll.held} held, ${inAll.cut} cut, gateway holds ${tight.heldConnections?.()}`);
// None of the three ever sends its ident line: the handshake's time runs from the TCP connection.
check(await until(() => silent.filter((r) => r.got).every((r) => r.ended), 3000), 'a connection that never says a word is hung up on when handshakeMs (0.8 s here) runs out');
check(await until(() => tight.heldConnections?.() === 0, 3000), '...and, as it does not hang up itself, its socket is destroyed letGoMs later', `gateway holds ${tight.heldConnections?.()}`);
for (const r of silent) r.sock.destroy();
// A reset on a connection cut for coming too often (perMinute 2 here) reached ssh2's
// connection object before any 'error' listener did, and took the gateway down.
const crashes = [];
const crashed = (error) => crashes.push(error.message);
process.on('uncaughtException', crashed);
const often = [];
for (let i = 0; i < 3; i++) { often.push(bare(tight.port, 'SSH-2.0-check\r\n')); await pause(150); }
check(await until(() => often[2].ended), 'a third connection in a minute is cut (perMinute 2 here)');
for (const r of often) r.sock.resetAndDestroy();
await pause(500);
process.off('uncaughtException', crashed);
check(!crashes.length, '...and its reset after the cut does not take the gateway down', crashes.join('; ') || 'nothing uncaught');
await tight.close();

console.log('\nQUITTING');
from = a.mark();
a.type('quit');
check(await a.gone(), '"quit" ends the terminal session', plain(a.text.slice(from)).trim().split('\n').slice(-2).join(' / '));
check(await until(() => !mud.sessionNamed('Tester')), '...and Tester leaves the game');

w1.ws.close();
await gateway.close();
mud.close();
rmSync(data, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILED:\n  ${failures.join('\n  ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
