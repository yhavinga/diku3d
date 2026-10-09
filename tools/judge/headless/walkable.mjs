// Every step the page lets a player take, put to the server's judge.
//
// The page walks a body over build.js's platforms and round its colliders
// (player.js); the server cannot see either, and believes or refuses each
// position report by its own rules (server/world.mjs `judge`). Where the two
// disagree a player is walking somewhere the screen plainly allows and is put
// back by the server -- the grass south of the West Gate, a street that
// touches another, a ledge stepped off. This finds every such place, without
// walking anywhere by hand:
//
//  - each zone is built in a headless page, and its colliders, platforms and
//    portals read back out;
//  - a flood over a grid, from every room's arrival point, takes each step
//    player.js would let a body take: half a metre at a time, onto ground
//    no more than STEP_UP above, clear of every collider by RADIUS, down off
//    any edge (the fall reported ten times a second, as link.js reports it);
//    a portal's trigger ends the step, as the page fades you through it;
//  - each step goes to the server's own `judge`, as the report a page would
//    send, with the session the reports before it left. A refusal is
//    recorded where it happened; a step believed carries on from the room
//    the judge said.
//
// Doors stand open, and so do their exits, unless --shut: then every door
// in the page is a wall and every door exit in the server's world is shut,
// which finds the page letting a body round a shut door. --jumps lets a
// step clear what a standing jump does (player.js: 1.1 m up, landing on
// ground a step above that), over-generously, for the whole step.
//
//   cp <repo>/tools/judge/headless/walkable.mjs /tmp/pw/
//   node --max-old-space-size=8192 /tmp/pw/walkable.mjs --repo <repo> [--port 8173]
//        [--zones home,ofcol | all] [--shut] [--jumps] [--res 0.5] [--out /tmp/walkable.json]
//
// Prints each zone's count and its refusals; exits 1 if any step was refused.
// Deterministic: the set of steps reached does not depend on the order they
// are reached in. About ten minutes for every zone, most of it building them.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = { repo: null, port: 8173, zones: 'all', shut: false, jumps: false, res: 0.5, out: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--repo') { opt.repo = v; i++; }
  else if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--zones') { opt.zones = v; i++; }
  else if (a === '--shut') opt.shut = true;
  else if (a === '--jumps') opt.jumps = true;
  else if (a === '--res') { opt.res = +v; i++; }
  else if (a === '--out') { opt.out = v; i++; }
}
if (!opt.repo) throw new Error('walkable: --repo <the diku3d checkout> is needed, for the server code');
const { bootWorld, CELL, LEVEL_H } = await import(pathToFileURL(path.join(opt.repo, 'server/world.mjs')).href);
const { EX_ISDOOR, EX_CLOSED, EX_LOCKED } = await import(pathToFileURL(path.join(opt.repo, 'src/are.js')).href);

// player.js's body.
const RADIUS = 0.42, STEP_UP = 0.62, HEIGHT = 1.8, EYE = 1.72, GRAVITY = 24, JUMP = 7.4;
const JUMP_UP = (JUMP * JUMP) / (2 * GRAVITY);
const RES = opt.res;
const HZ = 10; // link.js SEND_HZ

const w = bootWorld(opt.repo);
// The doors as the page's are taken: all open, or with --shut all shut. The
// resets shut some at boot, and a page walked with its doors open would be
// refused at every one of those.
for (const room of w.world.rooms.values()) {
  for (const e of room.exits) {
    if (!e || !(e.locks & EX_ISDOOR)) continue;
    if (opt.shut) e.locks |= EX_CLOSED; else e.locks &= ~(EX_CLOSED | EX_LOCKED);
  }
}
const zoneIds = opt.zones === 'all' ? w.zones.map((z) => z.zone.id) : opt.zones.split(',');

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${opt.port}/`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 240000 });
await page.waitForTimeout(6000);

const report = { shut: opt.shut, jumps: opt.jumps, res: RES, zones: {} };
let refusedAll = 0;
for (const zoneId of zoneIds) {
  const data = await page.evaluate(async ({ zoneId, shut }) => {
    const d = window.diku;
    const zone = d.plan.byId.get(zoneId);
    if (!zone) return { error: `no zone ${zoneId}` };
    if (d.zone !== zone) {
      const stand = [zone.start, ...zone.rooms].find((v) => d.world.rooms.get(v)?.sector !== 9) ?? zone.start;
      try { await d.goto(stand); } catch (e) { return { skipped: e.message }; }
    }
    if (d.zone !== zone) return { skipped: `goto(${zone.start}) drew ${d.zone.id}` };
    d.state.paused = true;
    const col = [];
    for (const c of d.built.colliders) if (!c.door || shut) col.push(c.x0, c.x1, c.z0, c.z1, c.y0, c.y1, c.r || 0);
    const plat = [];
    for (const p of d.built.platforms) plat.push(p.x0, p.x1, p.z0, p.z1, p.top);
    const portals = d.built.portals.map((p) => [p.x, p.y, p.z, p.radius]);
    const rooms = [];
    for (const [vnum, info] of d.built.rooms) {
      if (info.unbuilt || d.plan.zoneOf(vnum) !== zone) continue;
      const [x, z] = d.player.resolvePoint(info.center.x, info.center.z, info.center.y);
      rooms.push([vnum, x, info.center.y, z]);
    }
    return { col, plat, portals, rooms };
  }, { zoneId, shut: opt.shut });
  if (data.error) throw new Error(`walkable: ${data.error}`);
  if (data.skipped) { console.log(`${zoneId.padEnd(9)} skipped: ${data.skipped}`); report.zones[zoneId] = { skipped: data.skipped }; continue; }
  const Z = w.byId.get(zoneId);
  const off = Z.offset;

  // Buckets of 4 m over the zone's own frame.
  const B = 4;
  const bucketKey = (bx, bz) => bx * 100003 + bz;
  const bucketsOf = (arr, stride) => {
    const m = new Map();
    for (let k = 0; k < arr.length; k += stride) {
      for (let bx = Math.floor((arr[k] - RADIUS) / B); bx <= Math.floor((arr[k + 1] + RADIUS) / B); bx++) {
        for (let bz = Math.floor((arr[k + 2] - RADIUS) / B); bz <= Math.floor((arr[k + 3] + RADIUS) / B); bz++) {
          const key = bucketKey(bx, bz);
          let list = m.get(key);
          if (!list) m.set(key, (list = []));
          list.push(k);
        }
      }
    }
    return m;
  };
  const P = data.plat, C = data.col;
  const pb = bucketsOf(P, 5), cb = bucketsOf(C, 7);
  const near = (m, x, z) => m.get(bucketKey(Math.floor(x / B), Math.floor(z / B))) || [];
  /** player.js groundAt: the highest platform under (x, z), a body's radius round, a step or less above the feet. */
  const groundAt = (x, z, feet, reach = STEP_UP) => {
    let best = -Infinity;
    for (const k of near(pb, x, z)) {
      if (x < P[k] - RADIUS || x > P[k + 1] + RADIUS || z < P[k + 2] - RADIUS || z > P[k + 3] + RADIUS) continue;
      const top = P[k + 4];
      if (top <= feet + reach && top > best) best = top;
    }
    return best;
  };
  /** player.js resolveCollisions, at the feet the step starts from: anything between a step up and the head. */
  const blocked = (x, z, feet) => {
    for (const k of near(cb, x, z)) {
      if (C[k + 5] <= feet + STEP_UP || C[k + 4] >= feet + HEIGHT) continue;
      if (x < C[k] - RADIUS || x > C[k + 1] + RADIUS || z < C[k + 2] - RADIUS || z > C[k + 3] + RADIUS) continue;
      if (C[k + 6] && Math.hypot(x - (C[k] + C[k + 1]) / 2, z - (C[k + 2] + C[k + 3]) / 2) >= C[k + 6] + RADIUS) continue;
      return true;
    }
    return false;
  };
  const inPortal = (x, z, feet) => data.portals.some(([px, py, pz, pr]) => Math.abs(py - feet) <= 3 && (px - x) ** 2 + (pz - z) ** 2 < pr * pr);

  const b = Z.layout.bounds;
  const M = 6;
  const I0 = Math.floor(((b.minX - M) * CELL - CELL / 2) / RES), I1 = Math.ceil(((b.maxX + M) * CELL + CELL / 2) / RES);
  const J0 = Math.floor(((b.minZ - M) * CELL - CELL / 2) / RES), J1 = Math.ceil(((b.maxZ + M) * CELL + CELL / 2) / RES);
  const NI = I1 - I0 + 1;
  // A state is a sample, the floor under it (cm) and the room the judge has
  // the body in: those decide everything about the next step.
  const seen = new Map();
  const queue = [];
  const visit = (i, j, feet, room) => {
    const key = ((j - J0) * NI + (i - I0)) * 40000 + Math.round(feet * 100) + 20000;
    const had = seen.get(key);
    if (had === room || (Array.isArray(had) && had.includes(room))) return;
    if (had === undefined) seen.set(key, room);
    else if (Array.isArray(had)) had.push(room);
    else seen.set(key, [had, room]);
    queue.push(i, j, feet, room);
  };
  const refusals = new Map();
  let steps = 0, falls = 0, deepest = 0;
  const ch = { roomVnum: null, affectedBy: 0 };
  /** The page's report at zone-local (x, feet, z), as the server reads it: eye height, the mound's lift off. */
  const report1 = (x, feet, z) => ({ x: x + off, y: feet + EYE - w.liftAt(x + off, feet, z), z });
  /**
   * One step to the judge: the reports a page sends going from (x, feet, z)
   * to (nx, nfeet, nz) -- one, or a fall's worth -- and the room it ends in,
   * or the refusal.
   */
  const judged = (room, x, feet, z, nx, nfeet, nz) => {
    let at = report1(x, feet, z);
    let now = 1e6;
    const reports = [];
    if (nfeet < feet - STEP_UP) {
      // Off an edge: falling, reported ten times a second until it lands.
      falls++;
      deepest = Math.max(deepest, feet - nfeet);
      for (let t = 1 / HZ; feet - 0.5 * GRAVITY * t * t > nfeet; t += 1 / HZ) reports.push(report1(nx, feet - 0.5 * GRAVITY * t * t, nz));
    }
    reports.push(report1(nx, nfeet, nz));
    for (const r of reports) {
      const s = { navRoom: room, posAt: now - 1000 / HZ };
      const pc = { ch, position: at };
      const verdict = w.judge(s, pc, r.x, r.y, r.z, now);
      if (verdict.why) return { why: verdict.why, at: r, was: at, from: room };
      room = verdict.room;
      at = r;
    }
    return { room };
  };

  for (const [vnum, x, y, z] of data.rooms) {
    const i = Math.floor(x / RES), j = Math.floor(z / RES);
    const cx = (i + 0.5) * RES, cz = (j + 0.5) * RES;
    const feet = groundAt(cx, cz, y, 2);
    if (feet === -Infinity || blocked(cx, cz, feet)) continue;
    visit(i, j, feet, vnum);
  }
  const t0 = Date.now();
  const moves = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length) {
    const room = queue.pop(), feet = queue.pop(), j = queue.pop(), i = queue.pop();
    const x = (i + 0.5) * RES, z = (j + 0.5) * RES;
    for (const [di, dj] of moves) {
      const a = i + di, c = j + dj;
      if (a < I0 || a > I1 || c < J0 || c > J1) continue;
      const nx = (a + 0.5) * RES, nz = (c + 0.5) * RES;
      // A jump takes the step from the top of its rise.
      for (const rise of opt.jumps ? [0, JUMP_UP] : [0]) {
        const nfeet = groundAt(nx, nz, feet + rise);
        if (nfeet === -Infinity || blocked(nx, nz, feet + rise)) continue;
        if (inPortal(nx, nz, nfeet)) continue;
        steps++;
        const v = judged(room, x, feet, z, nx, nfeet, nz);
        if (v.why) {
          const cell = `${Math.round(v.at.y / LEVEL_H - EYE / LEVEL_H)},${Math.round(nx / CELL)},${Math.round(nz / CELL)}`;
          const key = `${v.from}|${v.why}|${cell}`;
          let e = refusals.get(key);
          if (!e) {
            refusals.set(key, (e = {
              from: v.from, why: v.why, cell, n: 0,
              at: [+(v.at.x - off).toFixed(1), +(v.at.y - EYE).toFixed(2), +v.at.z.toFixed(1)],
              was: [+(v.was.x - off).toFixed(1), +(v.was.y - EYE).toFixed(2), +v.was.z.toFixed(1)],
            }));
          }
          e.n++;
          continue;
        }
        visit(a, c, nfeet, v.room);
      }
    }
  }
  const list = [...refusals.values()].sort((p, q) => q.n - p.n || (p.from - q.from) || p.why.localeCompare(q.why));
  refusedAll += list.length;
  report.zones[zoneId] = { states: seen.size, steps, falls, deepest: +deepest.toFixed(1), refused: list.length, ms: Date.now() - t0, refusals: list };
  console.log(`${zoneId.padEnd(9)} ${String(steps).padStart(9)} steps, ${falls} falls (deepest ${deepest.toFixed(1)} m): ${list.length ? `${list.length} REFUSED` : 'none refused'}`);
  for (const e of list.slice(0, 20)) {
    console.log(`    from #${e.from}: ${e.why} -- at ${e.at.join(', ')} from ${e.was.join(', ')} (cell ${e.cell}, ${e.n} steps)`);
  }
}
await browser.close();
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(report, null, 1));
console.log(refusedAll ? `${refusedAll} places where a step the page allows is refused` : 'every step the page allows is believed');
process.exit(refusedAll ? 1 : 0);
