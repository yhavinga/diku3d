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
 *
 *     (cd server && npm ci) && node tools/ssh-check.mjs
 *
 * Exits non-zero if any assertion fails.
 */

import { mkdtempSync, rmSync } from 'fs';
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
const { startGateway, newHostKey } = await import('../server/gateway.mjs');
const { directionOf } = await import('../server/term.mjs');

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

/** An SSH connection's one session: what it printed, and a way to wait for something in it. */
async function session({ pty = true } = {}) {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({ host: '127.0.0.1', port: gateway.port, username: 'anyone', readyTimeout: 5000 });
  });
  const stream = await new Promise((resolve, reject) => {
    const done = (error, s) => (error ? reject(error) : resolve(s));
    if (pty) conn.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, done); else conn.shell(false, done);
  });
  const s = {
    conn, stream, raw: '', closed: false,
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
  stream.on('close', () => { s.closed = true; conn.end(); });
  return s;
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

console.log('\nA SCRIPT, WITH NO PTY');
const b = await session({ pty: false });
b.stream.write('Piper\nsecret2\ny\nsecret2\nf\nmag\nnorth\nlook\nquit\n');
await b.see(/Did I get that right, Piper \(Y\/N\)\?\n/, 'each question comes on a line of its own');
const schoolNorth = w.world.rooms.get(school).exits[0].to;
await b.see(new RegExp(`${roomName(schoolNorth)}[\\s\\S]*${roomName(schoolNorth)}`), '"north" then "look" looks at the room walked to', 0, 8000);
check(await b.gone(6000), '"quit" ends the session');
check(!/\x1b\[/.test(b.raw), 'no escape sequences at all without a pty');
check(!b.raw.includes('secret2'), 'and no echo of the password');

console.log('\nREFUSALS');
const e = new Client();
await new Promise((resolve, reject) => e.on('ready', resolve).on('error', reject).connect({ host: '127.0.0.1', port: gateway.port, username: 'x', readyTimeout: 5000 }));
const exec = await new Promise((resolve, reject) => {
  e.exec('ls -la', (error, stream) => {
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
check(exec.code === 1 && /takes no command/.test(exec.out), 'a command on the ssh line is refused, in words, with exit status 1', exec.out.trim().slice(0, 60));
const idle = [await session(), await session()];
const over = await session();
await over.see(/There are already 3 connections from your address\./, 'a fourth connection from one address is refused in words (cap 3 here)');
check(await over.gone(), '...and closed');
for (const s of idle) s.conn.end();
// conn.end() returns before the server has seen the close; opening the next
// session at once races the per-address count (cap 3) and is refused in words.
for (let until = Date.now() + 5000; gateway.openConnections() > 1 && Date.now() < until;) await pause(20);
check(gateway.openConnections() === 1, 'the gateway has let go of every connection but the first terminal');
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
