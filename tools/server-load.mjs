/**
 * How much a crowd costs the server: starts server/main.mjs as its own
 * process, connects N simulated players over real WebSockets, walks them
 * along Midgaard's streets at a walk, sending their position ten times a
 * second (the server checks each one; the count it refused is reported), has them talk now and then, and reports per player per second
 * what came back -- messages and bytes -- and the server's own CPU.
 *
 *     (cd server && npm ci) && node tools/server-load.mjs [N ...] [--seconds 20] [--dash]
 *
 * --dash adds an implementor with the dashboard open (server/dash.mjs),
 * following the first walker, and reports what it was sent: run it with
 * and without to see what the dashboard costs the server.
 *
 * Every N in the list is a fresh server and a fresh data directory.
 */

import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'server/package.json'));
const WebSocket = require('ws');
const { bootWorld } = await import('../server/world.mjs');
const { createAccounts, hashPassword } = await import('../server/accounts.mjs');
const { createCharacter, advanceLevel, Rng } = await import('../src/game.js');
const { serialize } = await import('../src/save.js');

const args = process.argv.slice(2);
let seconds = 20;
let withDash = false;
const counts = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seconds') seconds = Number(args[++i]);
  else if (args[i] === '--dash') withDash = true;
  else counts.push(Number(args[i]));
}
if (!counts.length) counts.push(1, 10, 50);

const w = bootWorld(root);
const home = w.zoneOfVnum(3001);
// Midgaard's streets: rooms in the home zone and its area, with their level neighbours.
const streets = [...w.world.rooms.values()].filter((r) => r.areaFile === 'midgaard.are' && w.built.rooms.has(r.vnum)
  && !w.built.rooms.get(r.vnum).unbuilt && r.exits.some((e, d) => e && d < 4 && w.built.rooms.has(e.to)));
const centre = (vnum) => { const c = w.built.rooms.get(vnum).center; return { x: c.x - home.offset, y: c.y + 1.72, z: c.z }; };
/**
 * The street between two rooms as the layout routed it: the server checks
 * every report against it (server/mud.mjs `position`), so a walker goes
 * along it, not across whatever lies between the two centres.
 */
const street = (from, to) => home.layout.links.find((l) => l.kind === 'alley' && l.to
  && ((l.from.vnum === from && l.to.vnum === to) || (l.from.vnum === to && l.to.vnum === from)));
const waypoints = (from, to) => {
  // A room with no street out: stand in it.
  if (from === to) return [centre(from)];
  const link = street(from, to);
  const cells = link.from.vnum === from ? link.path : [...link.path].reverse();
  const y = centre(from).y;
  return [...cells.map((c) => ({ x: c.x * 13, y, z: c.z * 13 })), centre(to)];
};
const next = (vnum, rand) => {
  const ways = w.world.rooms.get(vnum).exits.map((e, d) => (e && d < 4 && !(e.locks & 2) && w.built.rooms.has(e.to)
    && w.zoneOfVnum(e.to) === home && street(vnum, e.to) ? e.to : null)).filter(Boolean);
  return ways.length ? ways[Math.floor(rand() * ways.length)] : vnum;
};
const cpuSeconds = (pid) => {
  const text = execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)]).toString().trim();
  const parts = text.split(':').map(Number);
  return parts.reduce((s, p) => s * 60 + p, 0);
};

async function run(n) {
  const data = mkdtempSync(join(tmpdir(), 'diku3d-load-'));
  const accounts = createAccounts(data);
  for (let i = 0; i < n; i++) {
    const ch = createCharacter(i % 4, { sex: 1 });
    const name = `Walker${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}`;
    ch.name = name;
    // Each starts in a street of its own, where its file says it was.
    const room = streets[(i * 7919 + 13) % streets.length].vnum;
    accounts.store({ version: 1, name, created: 'load', password: await hashPassword('walkwalk'), char: { ...serialize(ch), room } });
  }
  if (withDash) {
    const rng = new Rng(40);
    const ch = createCharacter(0, { level: 36, sex: 1, rng });
    while (ch.level < 40) { ch.level += 1; advanceLevel(ch, rng); }
    ch.name = 'Overseer';
    accounts.store({ version: 1, name: 'Overseer', created: 'load', password: await hashPassword('overseer'), char: { ...serialize(ch), room: 3001, trust: 40 } });
  }
  const port = 4600 + n;
  const server = spawn(process.execPath, [join(root, 'server/main.mjs'), '--port', String(port), '--data', data], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => server.stdout.on('data', (chunk) => { if (/listening/.test(chunk.toString())) resolve(); }));

  const clients = [];
  for (let i = 0; i < n; i++) {
    const name = `Walker${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, name, bytes: 0, msgs: 0, kinds: new Map(), seq: 0, entered: false, refused: 0, room: null };
    let seed = i * 7919 + 1;
    c.rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    ws.on('message', (raw) => {
      c.bytes += raw.length;
      c.msgs += 1;
      const msg = JSON.parse(raw.toString());
      c.kinds.set(msg.t, (c.kinds.get(msg.t) || 0) + raw.length);
      if (msg.t === 'enter') { c.entered = true; c.seq = msg.seq; c.room = msg.room; }
      if (msg.t === 'at') {
        // Put back: stand where the server says, and walk on from that room.
        c.refused += 1;
        c.seq = msg.seq;
        c.room = msg.room;
        c.at = { x: msg.x, y: msg.y + 1.72, z: msg.z };
        c.to = next(c.room, c.rand);
        c.path = waypoints(c.room, c.to);
      }
      if (msg.t === 'ev') for (const e of msg.e) if (e.seq) c.seq = Math.max(c.seq, e.seq);
    });
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ t: 'login', name, password: 'walkwalk' }));
    clients.push(c);
  }
  while (!clients.every((c) => c.entered)) await new Promise((r) => setTimeout(r, 50));
  let overseer = null;
  if (withDash) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    overseer = { ws, bytes: 0, msgs: 0, kinds: new Map(), entered: false, enterId: null };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'enter') overseer.entered = true;
      if (msg.t !== 'dash') return;
      overseer.bytes += raw.length;
      overseer.msgs += 1;
      overseer.kinds.set(msg.k, (overseer.kinds.get(msg.k) || 0) + raw.length);
      if (msg.k === 'snap') ws.send(JSON.stringify({ t: 'dash', op: 'follow', id: msg.who.find((p) => p.name !== 'Overseer').id }));
    });
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ t: 'login', name: 'Overseer', password: 'overseer' }));
    while (!overseer.entered) await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ t: 'dash', op: 'sub' }));
    await new Promise((r) => setTimeout(r, 500));
  }
  // Each walks from the square to a neighbour, and on, at 1.6 m/s.
  for (const c of clients) {
    c.at = centre(c.room);
    c.to = next(c.room, c.rand);
    c.path = waypoints(c.room, c.to);
  }
  for (const c of [...clients, ...(overseer ? [overseer] : [])]) { c.bytes = 0; c.msgs = 0; c.kinds.clear(); }
  const cpu0 = cpuSeconds(server.pid);
  const t0 = Date.now();
  let talk = 0;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const dt = 0.1;
      for (const c of clients) {
        const goal = c.path[0];
        const dx = goal.x - c.at.x; const dz = goal.z - c.at.z; const d = Math.hypot(dx, dz);
        if (d < 0.3) {
          c.path.shift();
          if (!c.path.length) { c.room = c.to; c.to = next(c.room, c.rand); c.path = waypoints(c.room, c.to); }
        } else { c.at.x += (dx / d) * Math.min(d, 1.6 * dt); c.at.z += (dz / d) * Math.min(d, 1.6 * dt); }
        c.at.y = goal.y;
        c.ws.send(JSON.stringify({ t: 'pos', zone: home.zone.id, x: c.at.x, y: c.at.y, z: c.at.z, yaw: Math.atan2(-dx, -dz), seq: c.seq }));
      }
      // Someone says something about every half second.
      if (++talk % 5 === 0) {
        const c = clients[Math.floor(Math.random() * clients.length)];
        c.ws.send(JSON.stringify({ t: 'cmd', line: Math.random() < 0.5 ? 'say nice weather' : 'look' }));
      }
      if (Date.now() - t0 >= seconds * 1000) { clearInterval(timer); resolve(); }
    }, 100);
  });
  const secs = (Date.now() - t0) / 1000;
  const cpu = cpuSeconds(server.pid) - cpu0;
  const bytes = clients.reduce((s, c) => s + c.bytes, 0);
  const msgs = clients.reduce((s, c) => s + c.msgs, 0);
  const kinds = new Map();
  for (const c of clients) for (const [k, b] of c.kinds) kinds.set(k, (kinds.get(k) || 0) + b);
  const share = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, b]) => `${k} ${(100 * b / bytes).toFixed(0)}%`).join(', ');
  console.log(`${String(n).padStart(4)} players: ${(msgs / n / secs).toFixed(1)} msgs and ${(bytes / n / secs / 1024).toFixed(2)} KB in`
    + ` per player per second (${share}); positions out 10/s each; server CPU ${(100 * cpu / secs).toFixed(1)}% of a core;`
    + ` ${clients.reduce((s, c) => s + c.refused, 0)} reports refused`);
  if (overseer) {
    console.log(`       the dashboard: ${(overseer.msgs / secs).toFixed(1)} msgs and ${(overseer.bytes / secs / 1024).toFixed(2)} KB a second`
      + ` (${[...overseer.kinds].map(([k, b]) => `${k} ${(b / secs / 1024).toFixed(2)} KB/s`).join(', ')})`);
    overseer.ws.close();
  }
  for (const c of clients) c.ws.close();
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  rmSync(data, { recursive: true, force: true });
}

console.log(`${streets.length} Midgaard rooms to walk; ${seconds} s per run`);
for (const n of counts) await run(n);
