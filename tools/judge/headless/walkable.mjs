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
// which finds the page letting a body round a shut door. The gate at the far
// end of a one-way exit is a wall either way: the page opens it only for an
// eye coming down the street, and never from inside the room. A lid on a way
// up or down (build.js `buildLidStair`, `hangLid`) is walked as the page
// walks it in each case: open, its hole is a hole, its leaf stands up on its
// hinge as a wall, and the portal it shuts is a portal; shut, it is floor
// over the hole and a ceiling over the flight under it, and its portal goes
// nowhere. --jumps lets a
// step clear what a standing jump does (player.js: 1.1 m up, landing on
// ground a step above that), over-generously, for the whole step.
//
// --work <file> writes the werklijst: every place where the page walks a
// body from one room into another that no open exit joins, which is where
// the world joins what the mud keeps apart. A body is in a room on an
// open-air room's cell or inside a walled room's walls, and on a street on a
// street's cell; anywhere else is open ground. A step from one room or
// street straight into another is listed as a `street` pair. A stretch of
// open ground (the grass, a gap between buildings, the strip outside a wall)
// is listed once, as a patch, with a pair for every room a body steps off
// onto it and every room it steps from it into. Turning back halfway down an
// exit's own street is not listed. Each pair has its distance in the mud's
// graph (`dist`) and within its zone (`zoneDist`), and its kind, the first
// that fits:
//   sealed      out of a room with no way out, into one no exit leads into,
//               or into one only ever entered by exits with no way back;
//   door/guard  within the zone only through a door the resets shut, or past
//               a mobile that stays put and attacks on sight (with --shut:
//               round such a door);
//   one-way     back along a one-way exit;
//   street, open  none of those.
// and a tag where the mud joins the two only through another zone.
//
//   cp <repo>/tools/judge/headless/walkable.mjs /tmp/pw/
//   node --max-old-space-size=8192 /tmp/pw/walkable.mjs --repo <repo> [--port 8173]
//        [--zones home,ofcol | all] [--shut] [--jumps] [--res 0.5] [--out /tmp/walkable.json]
//        [--work /tmp/werklijst.json]
//
// Prints each zone's count and its refusals; exits 1 if any step was refused.
// Deterministic: the set of steps reached does not depend on the order they
// are reached in. About ten minutes for every zone, most of it building them.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = { repo: null, port: 8173, zones: 'all', shut: false, jumps: false, res: 0.5, out: null, work: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--repo') { opt.repo = v; i++; }
  else if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--zones') { opt.zones = v; i++; }
  else if (a === '--shut') opt.shut = true;
  else if (a === '--jumps') opt.jumps = true;
  else if (a === '--res') { opt.res = +v; i++; }
  else if (a === '--out') { opt.out = v; i++; }
  else if (a === '--work') { opt.work = v; i++; }
}
if (!opt.repo) throw new Error('walkable: --repo <the diku3d checkout> is needed, for the server code');
const { bootWorld, CELL, LEVEL_H } = await import(pathToFileURL(path.join(opt.repo, 'server/world.mjs')).href);
const { EX_ISDOOR, EX_CLOSED, EX_LOCKED, ACT_SENTINEL, ACT_AGGRESSIVE } = await import(pathToFileURL(path.join(opt.repo, 'src/are.js')).href);

// player.js's body.
const RADIUS = 0.42, STEP_UP = 0.62, HEIGHT = 1.8, EYE = 1.72, GRAVITY = 24, JUMP = 7.4;
const JUMP_UP = (JUMP * JUMP) / (2 * GRAVITY);
const RES = opt.res;
const HZ = 10; // link.js SEND_HZ

const w = bootWorld(opt.repo);

// --work: the mud's graph, and which of its doors the resets leave shut,
// read before the doors below are opened or shut for the walk.
const rooms = w.world.rooms;
const bootShut = new Set();
for (const room of rooms.values()) {
  room.exits.forEach((e, dir) => { if (e && (e.locks & EX_ISDOOR) && (e.locks & EX_CLOSED)) bootShut.add(`${room.vnum},${dir}`); });
}
const ways = (v) => (rooms.get(v)?.exits || []).flatMap((e, dir) => (e && !e.offMap && rooms.has(e.to)
  ? [{ to: e.to, dir, shut: bootShut.has(`${v},${dir}`) }] : []));
const exitTo = (a, b) => ways(a).some((e) => e.to === b);
/** A door the resets shut, on an exit either way between the two. */
const doorBetween = (a, b) => [[a, b], [b, a]].some(([p, q]) => ways(p).some((e) => e.to === q && e.shut));
const into = new Map();
for (const v of rooms.keys()) for (const e of ways(v)) { if (!into.has(e.to)) into.set(e.to, new Set()); into.get(e.to).add(v); }
// A guard is one that stays where it is and attacks on sight: a way past it
// is a fight. A wimpy aggressive only jumps you in your sleep (game.js aggrOn).
const ACT_WIMPY = 128;
const guards = new Map();
for (const room of rooms.values()) {
  const mob = (room.mobs || []).find((m) => (m.proto.act & ACT_SENTINEL) && (m.proto.act & ACT_AGGRESSIVE) && !(m.proto.act & ACT_WIMPY));
  if (mob) guards.set(room.vnum, mob.proto.short);
}
const zoneRooms = new Map(w.zones.map((z) => [z.zone.id, new Set(z.layout.cells.keys())]));
const trees = new Map();
/**
 * The mud's shortest ways out of `a`, by breadth: room -> the room before it.
 * Within one zone's rooms if `zone` is given; not through guarded rooms or
 * doors the resets shut, as `avoid` says.
 */
const treeFrom = (a, avoid = 'none', zone = null) => {
  const key = `${a}|${avoid}|${zone}`;
  if (trees.has(key)) return trees.get(key);
  const inside = zone && zoneRooms.get(zone);
  const prev = new Map([[a, null]]); const q = [a];
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    if (avoid === 'guards' && v !== a && guards.has(v)) continue;
    for (const e of ways(v)) {
      if (prev.has(e.to) || (avoid === 'doors' && e.shut) || (inside && !inside.has(e.to))) continue;
      prev.set(e.to, v); q.push(e.to);
    }
  }
  trees.set(key, prev);
  return prev;
};
const pathIn = (prev, b) => { if (!prev.has(b)) return null; const path = []; for (let v = b; v !== null; v = prev.get(v)) path.push(v); return path.reverse(); };
const PRECEDENCE = ['sealed', 'door/guard', 'one-way'];
/**
 * A pair the page walks with no open exit: how far apart the mud has them,
 * in the whole world and within the zone, and what the walk skips.
 */
function judgePair(a, b, via, zone) {
  const whole = pathIn(treeFrom(a), b);
  const local = pathIn(treeFrom(a, 'none', zone), b);
  const tags = [];
  if (!ways(a).length) tags.push('sealed: no way out of the first');
  if (!into.has(b)) tags.push('sealed: no exit leads into the second');
  else if ([...into.get(b)].every((x) => !exitTo(b, x))) tags.push('sealed: the second is only entered one way');
  if (opt.shut && doorBetween(a, b)) tags.push('door/guard: round the door between them');
  if (local && !treeFrom(a, 'doors', zone).has(b)) tags.push('door/guard: only through a door the resets shut');
  if (local && !treeFrom(a, 'guards', zone).has(b)) {
    const g = local.slice(1, -1).find((v) => guards.has(v));
    tags.push(`door/guard: only past ${g ? `${guards.get(g)} in #${g}` : 'a guard'}`);
  }
  if (exitTo(b, a) && !exitTo(a, b)) tags.push('one-way: back along a one-way exit');
  if (whole && !local) tags.push('only through another zone');
  if (!whole) tags.push('no way at all in the mud');
  const kind = PRECEDENCE.find((k) => tags.some((t) => t.startsWith(`${k}:`))) || via;
  return { from: a, to: b, kind, dist: whole ? whole.length - 1 : null, zoneDist: local ? local.length - 1 : null, tags };
}
const work = { shut: opt.shut, zones: {} };

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
    for (const c of d.built.colliders) {
      // A door's leaves, a lid's (`c.door` is then the lid, with its faces),
      // and a lid's leaf standing on its hinge, which is there only open.
      const lid = !!c.door && !c.door.spec;
      const keep = !c.door || (lid ? (c.whenOpen ? !shut : shut) : (shut || c.door.spec.oneWay));
      if (keep) col.push(c.x0, c.x1, c.z0, c.z1, c.y0, c.y1, c.r || 0);
    }
    const plat = [];
    for (const p of d.built.platforms) if (!p.door || shut) plat.push(p.x0, p.x1, p.z0, p.z1, p.top);
    // The page keeps a lid's portal only while the lid is open; here every
    // lid is open or every lid is shut.
    const portals = [...d.built.portals.filter((p) => !p.hatch), ...(shut ? [] : d.built.hatchPortals || [])]
      .map((p) => [p.x, p.y, p.z, p.radius]);
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

  // --work. Open ground is joined into patches as it is walked (a union over
  // its samples); a step between it and a room's cell or a street's is where
  // that patch meets the room; a step straight from one room's or street's
  // cell onto another's, with no open exit between them, is a street pair.
  const parent = new Map();
  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let c = k; c !== r;) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const join = (p, q) => {
    if (!parent.has(p)) parent.set(p, p);
    if (!parent.has(q)) parent.set(q, q);
    const a = find(p), b = find(q);
    if (a !== b) parent.set(a, b);
  };
  const borders = new Map();
  const streets = new Map();
  const sample = (i, j, feet) => ((j - J0) * NI + (i - I0)) * 40000 + Math.round(feet * 100) + 20000;
  /**
   * In a room or on a street: on an open-air room's cell or a street's (as
   * placeAt's `exact` has it), or inside a walled room's walls. The rest of
   * a walled room's cell is outside it, and is open ground.
   */
  const onCell = (x, feet, z) => {
    const level = Math.round(feet / LEVEL_H), cx = Math.round(x / CELL), cz = Math.round(z / CELL);
    const vnum = Z.layout.at(level, cx, cz);
    if (vnum === undefined) return !!Z.layout.passageAt(level, cx, cz);
    return !w.built.rooms.get(vnum)?.walled || w.walledAround({ x: x + off, y: feet, z }) === vnum;
  };
  // The street of an exit is that exit's: turning back halfway down a one-way
  // street crosses the middle where the judge's label changes ends, and is no
  // way the world opens between the two rooms.
  const along = new Map();
  for (const link of Z.layout.links) {
    for (const c of link.path || []) {
      const key = `${link.from.level},${c.x},${c.z}`;
      if (!along.has(key)) along.set(key, []);
      along.get(key).push(link);
    }
  }
  const sameStreet = (x, feet, z, a, b) => (along.get(`${Math.round(feet / LEVEL_H)},${Math.round(x / CELL)},${Math.round(z / CELL)}`) || [])
    .some((link) => link.to && ((link.from.vnum === a && link.to.vnum === b) || (link.from.vnum === b && link.to.vnum === a)));
  /** Where to stand to see a step, facing along it (zone-local). */
  const where = (x, feet, z, nx, nz) => [+x.toFixed(2), +feet.toFixed(2), +z.toFixed(2), +Math.atan2(-(nx - x), -(nz - z)).toFixed(2)];
  const note = (i, j, x, feet, z, room, a, c, nx, nfeet, nz, to) => {
    const p = onCell(x, feet, z), q = onCell(nx, nfeet, nz);
    if (!p && !q) { join(sample(i, j, feet), sample(a, c, nfeet)); return; }
    if (!p || !q) {
      const k = p ? sample(a, c, nfeet) : sample(i, j, feet);
      if (!parent.has(k)) parent.set(k, k);
      if (!borders.has(k)) borders.set(k, new Map());
      const m = borders.get(k);
      const r = p ? room : to;
      if (!m.has(r)) m.set(r, {});
      const b = m.get(r);
      if (p && !b.off) b.off = where(x, feet, z, nx, nz);
      if (q && !b.on) b.on = where(x, feet, z, nx, nz);
      return;
    }
    if (room === to || w.adjacent(ch, room, to)) return;
    if (sameStreet(x, feet, z, room, to) && sameStreet(nx, nfeet, nz, room, to)) return;
    const key = `${room}|${to}`;
    if (!streets.has(key)) streets.set(key, { n: 0, at: where(x, feet, z, nx, nz), cells: new Set() });
    const e = streets.get(key);
    e.n++;
    if (e.cells.size < 8) e.cells.add(`${Math.round(nfeet / LEVEL_H)},${Math.round(nx / CELL)},${Math.round(nz / CELL)}`);
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
        let nfeet = groundAt(nx, nz, feet + rise);
        if (nfeet === -Infinity || blocked(nx, nz, feet + rise)) continue;
        // player.js steps up onto whatever is within a step of the feet, frame
        // after frame while the body stands there, so on a flight it stands on
        // the highest tread its radius reaches -- not the first one it could
        // step to from half a metre back. On a flight steeper than a step per
        // sample (a lid's, 60 degrees: 0.86 m in 0.5 m) the flood fell off the
        // flight four samples up without this, and never came near the lid.
        for (let g = groundAt(nx, nz, nfeet); g > nfeet + 1e-6 && !blocked(nx, nz, g); g = groundAt(nx, nz, nfeet)) nfeet = g;
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
        if (opt.work) note(i, j, x, feet, z, room, a, c, nx, nfeet, nz, v.room);
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
  if (!opt.work) continue;
  const named = (pair) => ({ ...pair, names: [rooms.get(pair.from)?.name, rooms.get(pair.to)?.name] });
  const street = [...streets].map(([key, e]) => {
    const [a, b] = key.split('|').map(Number);
    return { ...named(judgePair(a, b, 'street', zoneId)), n: e.n, at: e.at, cells: [...e.cells] };
  });
  const patches = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    if (!patches.has(r)) patches.set(r, { samples: 0, rooms: new Map() });
    patches.get(r).samples++;
  }
  for (const [k, m] of borders) {
    const patch = patches.get(find(k));
    for (const [r, b] of m) {
      if (!patch.rooms.has(r)) patch.rooms.set(r, {});
      const e = patch.rooms.get(r);
      if (b.off && !e.off) e.off = b.off;
      if (b.on && !e.on) e.on = b.on;
    }
  }
  const open = [];
  for (const patch of patches.values()) {
    const pairs = [];
    for (const [a, ea] of patch.rooms) {
      if (!ea.off) continue;
      for (const [b, eb] of patch.rooms) {
        if (!eb.on || a === b || w.adjacent(ch, a, b)) continue;
        pairs.push({ ...named(judgePair(a, b, 'open', zoneId)), off: ea.off, on: eb.on });
      }
    }
    if (pairs.length) open.push({ m2: Math.round(patch.samples * RES * RES), rooms: [...patch.rooms.keys()], pairs });
  }
  open.sort((p, q) => q.pairs.length - p.pairs.length);
  const counts = {};
  for (const pair of [...street, ...open.flatMap((p) => p.pairs)]) counts[pair.kind] = (counts[pair.kind] || 0) + 1;
  work.zones[zoneId] = { counts, street, open };
  console.log(`    werklijst: ${street.length} street pairs, ${open.length} patches of open ground with ${open.reduce((s, p) => s + p.pairs.length, 0)} pairs; by kind ${JSON.stringify(counts)}`);
}
await browser.close();
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(report, null, 1));
if (opt.work) fs.writeFileSync(opt.work, JSON.stringify(work));
console.log(refusedAll ? `${refusedAll} places where a step the page allows is refused` : 'every step the page allows is believed');
process.exit(refusedAll ? 1 : 0);
