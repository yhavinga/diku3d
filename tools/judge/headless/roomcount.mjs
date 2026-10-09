// Which room the game counts a body in, over every step a body can take.
//
// The rule (the user's, 2026-10-09): inside a walled room's walls, that room;
// on a street, its nearer end; on open ground, the nearest room on the level
// that the body can reach on foot; otherwise the room it was counted in last.
// (And, since the lids: in the shaft of a lid or a drop, under the floor above,
// the room below -- the judge's rule, which the game was to hold to.)
// "Can reach on foot" is exactly a flood of the page's own ground, which
// neither the server (no geometry) nor the page (seconds per zone) can run as
// it walks. So the game approximates it from the layout, and this measures
// how often the approximation decides differently from the flood.
//
//  - each zone is built in a headless page and its colliders, platforms,
//    portals and rooms read back (or read from --geo, written there the first
//    time), as walkable.mjs reads them;
//  - every step player.js allows is flooded, half a metre at a time (feet in
//    float64: stored as float32 the flood loses steps that land exactly a
//    STEP_UP higher, and juargan's ground plane came apart from its city);
//    an undirected union over the steps says which samples are in one piece;
//  - a rule is walked over that step graph carrying the room it counts, from
//    every room's arrival point (as after a placement), because what it
//    decides can depend on the room it counted last. Each decision is
//    compared with the exact rule's -- the same rule, with the flood's piece
//    for "reach on foot" -- given the same last room.
//
// Rules (--rules, default old,spec):
//   old   game.js before wave 17: the nearest room centre in 3D, from the eye,
//         over every room the page built (centres as build.js placed them);
//   spec  the rule game.js is to run, built here (`referenceCounter`, and
//         importable: `loadReference(repo)`, for mp-room.mjs and traces);
//   spec-all, spec-walls  the two variants measured and not taken: every
//         open-air room on the level's open ground, street or no street; and
//         on a street, a walled end only once inside its walls;
//   game  the page's own function, once game.js has it: createRoomCounter
//         imported from <repo>/src/game.js and given what the server gives it
//         (world.mjs's rooms on the layout grid, the layout's links).
// --page-check N also puts N decisions per zone to the page's own game
// (`diku.game.roomAt(feet, last)`) and compares them with `game` in node:
// the page and the server must decide alike.
//
// Per zone and rule it prints, for samples in a room, on a street and on open
// ground, how often the rule disagrees with the exact rule and how (counts a
// room none can be walked to / keeps its last room where one can / counts a
// room the body cannot walk to / another reachable room), and, as the first
// measurement did (LEARNINGS, 2026-10-09, "The room the game counts you in"),
// how often the room counted is on another level, walled with the body outside
// its walls, or not walkable to at all.
//
//   cp <repo>/tools/judge/headless/roomcount.mjs /tmp/pw/roomcount-<you>.mjs
//   node --max-old-space-size=24000 /tmp/pw/roomcount-<you>.mjs --repo <repo> --port 8251
//        [--zones all|home,ofcol] [--rules old,spec,game] [--geo <dir>] [--page-check 2000]
//        [--shut] [--out <file.json>]
//
// Doors stand open (--shut: every door is a wall), as walkable.mjs takes them;
// the gate at the far end of a one-way exit is a wall either way. Every zone
// and two rules took 383 s from a --geo cache (home 102 s, mahntor 84 s), and
// building the zones in the page about two minutes more.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// player.js's body, as walkable.mjs has it.
const RADIUS = 0.42, STEP_UP = 0.62, HEIGHT = 1.8, EYE = 1.72, RES = 0.5;
// build.js's walls, as server/world.mjs models them.
const WALL_LINE = 5.35, TREE_LINE = 5.4, DOOR_HALF = 1.9;

/**
 * The rule game.js is to run, bound to a checkout's own modules:
 * `(await loadReference(repo))({ world, rooms, links, zoneOf })` is
 * { at(feet, last), region(feet), entries } -- what mp-room.mjs and a trace
 * can hold the page and the server to.
 */
export async function loadReference(repo) {
  const mod = (p) => import(pathToFileURL(path.join(repo, p)).href);
  const { CELL, LEVEL_H } = await mod('server/world.mjs');
  const { SECTOR, REVERSE_DIR } = await mod('src/are.js');
  const { openAirIn, shellAttrs, wayLid, isDrop } = await mod('src/shells.js');
  return (inputs, variant = {}) => referenceCounter(inputs, { CELL, LEVEL_H, SECTOR, REVERSE_DIR, openAirIn, shellAttrs, wayLid, isDrop }, variant);
}

// ------------------------------------------------------------- the rule --
/**
 * The rule game.js is to run, from what both the page and
 * the server have: built.rooms (each room's layout cell; its centre only to
 * find the zone's frame), layout.links, the world, zoneOf. Positions are feet,
 * in the frame `rooms` is in.
 */
function referenceCounter({ world, rooms, links, zoneOf = null }, { CELL, LEVEL_H, SECTOR, REVERSE_DIR, openAirIn, shellAttrs, wayLid, isDrop }, variant = {}) {
  const openAir = openAirIn(world);
  const key = (level, x, z) => `${level},${x},${z}`;
  const entries = new Map();
  const byCell = new Map();
  const zoneId = (v) => (zoneOf && zoneOf(v) ? zoneOf(v).id : '');
  for (const [vnum, info] of rooms) {
    const room = world.rooms.get(vnum);
    if (!room || room.sector === SECTOR.AIR) continue;
    // A zone's frame on the server is a whole number of cells along x; the
    // page's centres stand at most 3.5 m off the grid (a stair's hole).
    const ox = Math.round((info.center.x - info.cell.x * CELL) / CELL);
    const oz = Math.round((info.center.z - info.cell.z * CELL) / CELL);
    const walled = !openAir(room);
    const e = {
      vnum, level: info.cell.level, gx: info.cell.x + ox, gz: info.cell.z + oz, ox, oz,
      walled, round: walled && shellAttrs(room)?.named === 'tree', zone: zoneId(vnum),
      doorways: [false, false, false, false],
    };
    e.x = e.gx * CELL; e.z = e.gz * CELL;
    entries.set(vnum, e);
    byCell.set(key(e.level, e.gx, e.gz), e);
  }
  // The shaft of every lid (wayLid, but a passage) and drop (isDrop) on a stair,
  // by the cell of the room above in this frame. Written out again here, not
  // shells.js's shaftsOf, or the game could not be held to it.
  const shafts = new Map();
  for (const link of links) {
    if (link.kind !== 'stairs' || !link.to) continue;
    const lower = link.dir === 4 ? link.from : link.to, upper = link.dir === 4 ? link.to : link.from;
    const lid = wayLid(world, link.from.vnum, link.dir);
    if (lid ? lid.kind === 'none' : !isDrop(world, upper.vnum, lower.vnum)) continue;
    const above = entries.get(upper.vnum);
    if (!above) throw new Error(`roomcount: the shaft under #${upper.vnum} has no room counted there`);
    shafts.set(key(above.level, above.gx, above.gz), { lower: lower.vnum, floor: upper.level * LEVEL_H });
  }
  // layout.js's own test: the far end of a one-way exit has no way back.
  const oneWay = (link) => !world.rooms.get(link.to.vnum).exits.some((x) => x && x.to === link.from.vnum);
  const streets = new Map();
  const parent = new Map();
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(b, a); };
  for (const e of entries.values()) parent.set(e.vnum, e.vnum);
  const streeted = new Set();
  for (const link of links) {
    if (link.kind !== 'alley' || !link.to || !link.path) continue;
    const a = entries.get(link.from.vnum), b = entries.get(link.to.vnum);
    if (!a || !b) continue;
    for (const c of link.path) {
      const k = key(link.from.level, c.x + a.ox, c.z + a.oz);
      if (!streets.has(k)) streets.set(k, []);
      streets.get(k).push([a, b]);
    }
    a.doorways[link.entryDir] = true;
    b.doorways[REVERSE_DIR[link.exitDir]] = true;
    if (oneWay(link)) continue;
    join(a.vnum, b.vnum);
    streeted.add(a.vnum); streeted.add(b.vnum);
  }
  // A level's open ground reaches every open-air room a two-way street leaves
  // (variant.outsideAll, measured and not taken: every open-air room).
  for (const e of entries.values()) {
    if (e.walled || (!streeted.has(e.vnum) && !variant.outsideAll)) continue;
    const out = `out|${e.zone}|${e.level}`;
    if (!parent.has(out)) parent.set(out, out);
    join(out, e.vnum);
  }
  const reached = new Map(); // `${zone}|${level}` -> rooms, nearest first by a 26 m grid
  const outsideOf = (zone, level) => {
    const k = `${zone}|${level}`;
    if (reached.has(k)) return reached.get(k);
    const out = `out|${zone}|${level}`;
    let index = null;
    if (parent.has(out)) {
      const root = find(out);
      const list = [...entries.values()].filter((e) => e.zone === zone && e.level === level && find(e.vnum) === root);
      index = gridOf(list);
    }
    reached.set(k, index);
    return index;
  };
  // Which zone a point is in: the one whose frame is nearest along x (one zone in a page).
  const frames = new Map();
  for (const e of entries.values()) if (!frames.has(e.zone)) frames.set(e.zone, e.ox);
  const zoneAt = (gx) => {
    let best = null, bd = Infinity;
    for (const [zone, ox] of frames) { const d = Math.abs(gx - ox); if (d < bd) { bd = d; best = zone; } }
    return best;
  };
  /** Where a point is: in a room ({ room }), on a street ({ streets }), or on open ground ({}). */
  function region(p) {
    const level = Math.round(p.y / LEVEL_H), gx = Math.round(p.x / CELL), gz = Math.round(p.z / CELL);
    // Under the floor above, in the column of a shaft: the room below.
    const shaft = shafts.get(key(level, gx, gz));
    if (shaft && p.y < shaft.floor - 0.3) return { room: shaft.lower };
    const r = byCell.get(key(level, gx, gz));
    if (r) {
      if (!r.walled) return { room: r.vnum };
      const dx = p.x - r.x, dz = p.z - r.z;
      if (r.round ? dx * dx + dz * dz < TREE_LINE * TREE_LINE : Math.abs(dx) < WALL_LINE && Math.abs(dz) < WALL_LINE) return { room: r.vnum };
      // In a doorway: out past the wall line, but within a doorway's half-width of a side a street leaves by.
      const dir = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : (dz > 0 ? 2 : 0);
      if (r.doorways[dir] && Math.abs(dir === 1 || dir === 3 ? dz : dx) < DOOR_HALF) return { room: r.vnum };
      return { level, gx };
    }
    const list = streets.get(key(level, gx, gz));
    return list ? { streets: list } : { level, gx };
  }
  /** The room counted at feet `p` for a body last counted in `last`, or null: keep `last`. */
  function at(p, last) {
    const where = region(p);
    if (where.room !== undefined) return where.room;
    if (where.streets) {
      // Where streets share the cell, the one the body is walking: one with its last room at an end.
      const mine = where.streets.filter(([a, b]) => a.vnum === last || b.vnum === last);
      let best = null, bd = Infinity;
      for (const pair of mine.length ? mine : where.streets) {
        for (const end of pair) {
          // variant.streetWalls, measured and not taken: a walled end only once inside its walls.
          if (variant.streetWalls && end.walled && pair.some((other) => !other.walled)) continue;
          const d = (end.x - p.x) ** 2 + (end.z - p.z) ** 2;
          if (d < bd || (d === bd && end.vnum < best)) { bd = d; best = end.vnum; }
        }
      }
      return best;
    }
    const index = outsideOf(zoneAt(where.gx), where.level);
    return index ? index.nearest(p.x, p.z) : null;
  }
  return { at, region, entries };
}

/** The nearest of `list` ({ vnum, x, z }) to a point, flat, ties to the lower vnum: a 26 m grid, searched in rings. */
function gridOf(list) {
  const S = 26, grid = new Map();
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const e of list) {
    const k = `${Math.floor(e.x / S)},${Math.floor(e.z / S)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(e);
    x0 = Math.min(x0, e.x); x1 = Math.max(x1, e.x); z0 = Math.min(z0, e.z); z1 = Math.max(z1, e.z);
  }
  if (!list.length) return null;
  return {
    nearest(x, z) {
      const bx = Math.floor(x / S), bz = Math.floor(z / S);
      // Far enough out to hold every room, from wherever the point is.
      const reach = Math.ceil(Math.max(Math.abs(x - x0), Math.abs(x - x1), Math.abs(z - z0), Math.abs(z - z1)) / S) + 1;
      let best = null, bd = Infinity;
      const look = (cx, cz) => {
        for (const e of grid.get(`${cx},${cz}`) || []) {
          const d = (e.x - x) ** 2 + (e.z - z) ** 2;
          if (d < bd || (d === bd && e.vnum < best.vnum)) { bd = d; best = e; }
        }
      };
      for (let ring = 0; ring <= reach; ring++) {
        // Nothing in ring r is nearer than (r - 1) buckets: stop once the best found is nearer.
        if (best && ((ring - 1) * S) ** 2 > bd) break;
        if (ring === 0) { look(bx, bz); continue; }
        for (let d = -ring; d <= ring; d++) { look(bx + d, bz - ring); look(bx + d, bz + ring); }
        for (let d = -ring + 1; d <= ring - 1; d++) { look(bx - ring, bz + d); look(bx + ring, bz + d); }
      }
      return best.vnum;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = { repo: null, port: 8173, zones: 'all', rules: 'old,spec', geo: null, out: null, pageCheck: 0, shut: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = args[i + 1];
    if (a === '--repo') { opt.repo = v; i++; } else if (a === '--port') { opt.port = +v; i++; }
    else if (a === '--zones') { opt.zones = v; i++; } else if (a === '--rules') { opt.rules = v; i++; }
    else if (a === '--geo') { opt.geo = v; i++; } else if (a === '--out') { opt.out = v; i++; }
    else if (a === '--page-check') { opt.pageCheck = +v; i++; } else if (a === '--shut') opt.shut = true;
    else throw new Error(`roomcount: what is ${a}?`);
  }
  if (!opt.repo) throw new Error('roomcount: --repo <the diku3d checkout> is needed');
  const mod = (p) => import(pathToFileURL(path.join(opt.repo, p)).href);
  const { bootWorld, CELL, LEVEL_H } = await mod('server/world.mjs');
  const makeReference = await loadReference(opt.repo);
  const RULES = opt.rules.split(',');
  let gameCounter = null;
  if (RULES.includes('game') || opt.pageCheck) {
    gameCounter = (await mod('src/game.js')).createRoomCounter;
    if (typeof gameCounter !== 'function') throw new Error('roomcount: src/game.js exports no createRoomCounter yet');
  }

  // --------------------------------------------------------- the geometry --
  const w = bootWorld(opt.repo);
  const zoneIds = opt.zones === 'all' ? w.zones.map((z) => z.zone.id) : opt.zones.split(',');
  let browser = null, page = null;
  async function openPage() {
    if (page) return page;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    page = await browser.newPage({ viewport: { width: 480, height: 270 } });
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await page.goto(`http://localhost:${opt.port}/`);
    await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 240000 });
    await page.waitForTimeout(3000);
    return page;
  }
  async function drawZone(zoneId) {
    const p = await openPage();
    return p.evaluate(async (zoneId) => {
      const d = window.diku; const zone = d.plan.byId.get(zoneId);
      if (!zone) return { error: `no zone ${zoneId}` };
      if (d.zone !== zone) {
        const stand = [zone.start, ...zone.rooms].find((v) => d.world.rooms.get(v)?.sector !== 9) ?? zone.start;
        try { await d.goto(stand); } catch (e) { return { skipped: e.message }; }
      }
      if (d.zone !== zone) return { skipped: `goto drew ${d.zone.id}` };
      d.state.paused = true;
      return { ok: true };
    }, zoneId);
  }
  async function geometryOf(zoneId) {
    const file = opt.geo && path.join(opt.geo, `geo-${zoneId}.json`);
    if (file && fs.existsSync(file)) {
      const geo = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (geo.format !== 2) throw new Error(`roomcount: ${file} was written before the lids (format ${geo.format}); point --geo at an empty directory`);
      return geo;
    }
    const drawn = await drawZone(zoneId);
    if (drawn.error) throw new Error(`roomcount: ${drawn.error}`);
    if (drawn.skipped) return { skipped: drawn.skipped };
    const geo = await page.evaluate(() => {
      const d = window.diku;
      // Each door collider's last number says when it stands: 0 a door's leaf (shut),
      // 1 a one-way gate (always), 2 a lid's leaf standing on its hinge (open),
      // 3 a lid's cover (shut). A lid's collider has the lid for `door`, which has no `spec`.
      const col = []; const doors = [];
      for (const c of d.built.colliders) {
        const row = [c.x0, c.x1, c.z0, c.z1, c.y0, c.y1, c.r || 0];
        if (!c.door) col.push(...row);
        else if (!c.door.spec) doors.push([...row, c.whenOpen ? 2 : 3]);
        else doors.push([...row, c.door.spec.oneWay ? 1 : 0]);
      }
      // A shut lid's floor is ground only while it is shut; its portal exists only while it is open.
      const plat = []; const platShut = [];
      for (const p of d.built.platforms) (p.door ? platShut : plat).push(p.x0, p.x1, p.z0, p.z1, p.top);
      const portals = d.built.portals.filter((p) => !p.hatch).map((p) => [p.x, p.y, p.z, p.radius]);
      const hatchPortals = (d.built.hatchPortals || []).map((p) => [p.x, p.y, p.z, p.radius]);
      const rooms = [];
      for (const [vnum, info] of d.built.rooms) {
        const own = d.plan.zoneOf(vnum) === d.zone;
        const arrive = own && !info.unbuilt ? d.player.resolvePoint(info.center.x, info.center.z, info.center.y) : [info.center.x, info.center.z];
        rooms.push({ vnum, own, unbuilt: !!info.unbuilt, center: [info.center.x, info.center.y, info.center.z], arrive });
      }
      return { format: 2, col, doors, plat, platShut, portals, hatchPortals, rooms, bounds: d.layout.bounds };
    });
    if (file) { fs.mkdirSync(opt.geo, { recursive: true }); fs.writeFileSync(file, JSON.stringify(geo)); }
    return geo;
  }

  /** player.js's ground and walls over the zone's boxes (walkable.mjs's), and the step graph from every arrival point. */
  function stepGraph(geo, Z) {
    const C = geo.col.slice();
    for (const d of geo.doors) if (d[7] === 2 ? !opt.shut : opt.shut || d[7] === 1) C.push(...d.slice(0, 7));
    const P = opt.shut ? geo.plat.concat(geo.platShut) : geo.plat;
    const portals = opt.shut ? geo.portals : geo.portals.concat(geo.hatchPortals);
    const B = 4, bk = (bx, bz) => bx * 100003 + bz;
    const bucketsOf = (arr, stride) => {
      const m = new Map();
      for (let k = 0; k < arr.length; k += stride) {
        const xa = Math.min(arr[k], arr[k + 1]), xb = Math.max(arr[k], arr[k + 1]);
        const za = Math.min(arr[k + 2], arr[k + 3]), zb = Math.max(arr[k + 2], arr[k + 3]);
        for (let bx = Math.floor((xa - RADIUS) / B); bx <= Math.floor((xb + RADIUS) / B); bx++) {
          for (let bz = Math.floor((za - RADIUS) / B); bz <= Math.floor((zb + RADIUS) / B); bz++) {
            const key = bk(bx, bz); let l = m.get(key); if (!l) m.set(key, (l = [])); l.push(k);
          }
        }
      }
      return m;
    };
    const pb = bucketsOf(P, 5), cb = bucketsOf(C, 7);
    const near = (m, x, z) => m.get(bk(Math.floor(x / B), Math.floor(z / B))) || [];
    const groundAt = (x, z, feet, reach = STEP_UP) => {
      let best = -Infinity;
      for (const k of near(pb, x, z)) {
        if (x < P[k] - RADIUS || x > P[k + 1] + RADIUS || z < P[k + 2] - RADIUS || z > P[k + 3] + RADIUS) continue;
        const top = P[k + 4]; if (top <= feet + reach && top > best) best = top;
      }
      return best;
    };
    const blocked = (x, z, feet) => {
      for (const k of near(cb, x, z)) {
        if (C[k + 5] <= feet + STEP_UP || C[k + 4] >= feet + HEIGHT) continue;
        if (x < C[k] - RADIUS || x > C[k + 1] + RADIUS || z < C[k + 2] - RADIUS || z > C[k + 3] + RADIUS) continue;
        if (C[k + 6] && Math.hypot(x - (C[k] + C[k + 1]) / 2, z - (C[k + 2] + C[k + 3]) / 2) >= C[k + 6] + RADIUS) continue;
        return true;
      }
      return false;
    };
    const inPortal = (x, z, feet) => portals.some(([px, py, pz, pr]) => Math.abs(py - feet) <= 3 && (px - x) ** 2 + (pz - z) ** 2 < pr * pr);
    const bb = geo.bounds, M = 6;
    const I0 = Math.floor(((bb.minX - M) * CELL - CELL / 2) / RES), I1 = Math.ceil(((bb.maxX + M) * CELL + CELL / 2) / RES);
    const J0 = Math.floor(((bb.minZ - M) * CELL - CELL / 2) / RES), J1 = Math.ceil(((bb.maxZ + M) * CELL + CELL / 2) / RES);
    const NI = I1 - I0 + 1;
    const keyOf = (i, j, feet) => ((j - J0) * NI + (i - I0)) * 40000 + Math.round(feet * 100) + 20000;
    const index = new Map();
    const I = [], J = [], F = [];
    const add = (i, j, feet) => {
      const k = keyOf(i, j, feet); let s = index.get(k);
      if (s !== undefined) return [s, false];
      s = I.length; I.push(i); J.push(j); F.push(feet); index.set(k, s);
      return [s, true];
    };
    const queue = []; const seeds = [];
    for (const r of geo.rooms) {
      if (!r.own || r.unbuilt) continue;
      const i0 = Math.floor(r.arrive[0] / RES), j0 = Math.floor(r.arrive[1] / RES);
      const f0 = groundAt((i0 + 0.5) * RES, (j0 + 0.5) * RES, r.center[1], 2);
      if (f0 === -Infinity || blocked((i0 + 0.5) * RES, (j0 + 0.5) * RES, f0)) continue;
      const [s, fresh] = add(i0, j0, f0);
      seeds.push([s, r.vnum]);
      if (fresh) queue.push(s);
    }
    const edges = [];
    const moves = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (queue.length) {
      const s = queue.pop(); const i = I[s], j = J[s], feet = F[s];
      const out = [];
      for (const [di, dj] of moves) {
        const a = i + di, c = j + dj;
        if (a < I0 || a > I1 || c < J0 || c > J1) continue;
        const nx = (a + 0.5) * RES, nz = (c + 0.5) * RES;
        const nf = groundAt(nx, nz, feet);
        if (nf === -Infinity || blocked(nx, nz, feet) || inPortal(nx, nz, nf)) continue;
        const [t, fresh] = add(a, c, nf);
        out.push(t);
        if (fresh) queue.push(t);
      }
      edges[s] = out;
    }
    const n = I.length;
    const parent = new Int32Array(n); for (let s = 0; s < n; s++) parent[s] = s;
    const find = (s) => { let r = s; while (parent[r] !== r) r = parent[r]; while (parent[s] !== r) { const q = parent[s]; parent[s] = r; s = q; } return r; };
    for (let s = 0; s < n; s++) for (const t of edges[s]) { const a = find(s), b = find(t); if (a !== b) parent[a] = b; }
    const comp = new Int32Array(n); for (let s = 0; s < n; s++) comp[s] = find(s);
    return { n, I, J, F, edges, comp, seeds, x: (s) => (I[s] + 0.5) * RES, z: (s) => (J[s] + 0.5) * RES };
  }

  // ----------------------------------------------------------- the rules --
  /** game.js before wave 17 (nearestRoom): every built room's centre as the page has it, nearest in 3D to the eye. */
  function oldRule(geo) {
    const list = geo.rooms.map((r) => ({ vnum: r.vnum, x: r.center[0], y: r.center[1], z: r.center[2] }));
    const buckets = new Map();
    for (const r of list) { const k = `${Math.floor(r.x / 26)},${Math.floor(r.z / 26)}`; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(r); }
    return (p) => {
      const eye = { x: p.x, y: p.y + EYE, z: p.z };
      let best = null, bd = Infinity;
      const take = (r) => { const d = (r.x - eye.x) ** 2 + (r.y - eye.y) ** 2 + (r.z - eye.z) ** 2; if (d < bd) { bd = d; best = r; } };
      const cx = Math.floor(eye.x / 26), cz = Math.floor(eye.z / 26);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const r of buckets.get(`${cx + dx},${cz + dz}`) || []) take(r);
      if (!best) for (const r of list) take(r);
      return best ? best.vnum : null;
    };
  }

  const pc = (a, b) => (b ? `${(100 * (a || 0) / b).toFixed(2)}%` : '-');
  const report = { rules: RULES, shut: opt.shut, zones: {} };
  const grand = {};
  for (const zoneId of zoneIds) {
    const t0 = Date.now();
    const geo = await geometryOf(zoneId);
    if (geo.skipped) { console.log(`${zoneId.padEnd(9)} skipped: ${geo.skipped}`); report.zones[zoneId] = { skipped: geo.skipped }; continue; }
    const Z = w.byId.get(zoneId);
    const inputs = { world: w.world, rooms: Z.local.rooms, links: Z.layout.links, zoneOf: (v) => w.plan.zoneOf(v) };
    const ref = makeReference(inputs);
    const G = stepGraph(geo, Z);
    // Where each sample is, by the rule's own regions, and the rooms each piece reaches.
    const where = new Int8Array(G.n); const cellRoom = new Int32Array(G.n).fill(-1);
    const pieceRooms = new Map();
    for (let s = 0; s < G.n; s++) {
      const here = ref.region({ x: G.x(s), y: G.F[s], z: G.z(s) });
      if (here.room !== undefined) {
        where[s] = 1; cellRoom[s] = here.room;
        if (!pieceRooms.has(G.comp[s])) pieceRooms.set(G.comp[s], new Set());
        pieceRooms.get(G.comp[s]).add(here.room);
      } else if (here.streets) where[s] = 2;
    }
    const exactIndex = new Map();
    const exactOpen = (s) => {
      const level = Math.round(G.F[s] / LEVEL_H), c = G.comp[s], k = `${c}|${level}`;
      if (!exactIndex.has(k)) {
        const set = pieceRooms.get(c) || new Set();
        exactIndex.set(k, gridOf([...ref.entries.values()].filter((e) => e.level === level && set.has(e.vnum))));
      }
      const ix = exactIndex.get(k);
      return ix ? ix.nearest(G.x(s), G.z(s)) : null;
    };
    const exactAt = (s, last) => (where[s] === 1 ? cellRoom[s] : where[s] === 2 ? ref.at({ x: G.x(s), y: G.F[s], z: G.z(s) }, last) : exactOpen(s));
    const ruleFns = {};
    for (const name of RULES) {
      if (name === 'old') { const f = oldRule(geo); ruleFns.old = (p) => f(p); }
      else if (name === 'spec') ruleFns.spec = (p, last) => ref.at(p, last);
    else if (name === 'spec-all') { const r = makeReference(inputs, { outsideAll: true }); ruleFns[name] = (p, last) => r.at(p, last); }
    else if (name === 'spec-walls') { const r = makeReference(inputs, { streetWalls: true }); ruleFns[name] = (p, last) => r.at(p, last); }
      else if (name === 'game') { const g = gameCounter(inputs); ruleFns.game = (p, last) => g.at(p, last); }
      else throw new Error(`roomcount: no rule ${name}`);
    }
    const vlist = [...new Set([...ref.entries.keys(), ...geo.rooms.map((r) => r.vnum)])];
    const vidx = new Map(vlist.map((v, k) => [v, k]));
    const NONE = vlist.length;
    const zoneOut = { states: {}, samples: G.n, ms: 0 };
    for (const [name, fn] of Object.entries(ruleFns)) {
      const tr = Date.now();
      // Each sample's last-room keys: one inline, the rest aside (a Set tops out at 2^24 entries).
      const first = new Int32Array(G.n).fill(-1); const extra = new Map();
      const visit = (s, k) => {
        if (first[s] === k) return false;
        if (first[s] === -1) { first[s] = k; return true; }
        let l = extra.get(s); if (!l) extra.set(s, (l = []));
        if (l.includes(k)) return false;
        l.push(k); return true;
      };
      const q = [];
      for (const [s, v] of G.seeds) { const k = vidx.get(v); if (visit(s, k)) q.push(s, k); }
      const T = { room: {}, street: {}, open: {} };
      // ...and per sample, every class any of its states fell in (a sample walked to from many rooms has many states).
      const seenAs = new Uint16Array(G.n);
      const BIT = { agree: 1, roomWhereNoneReachable: 2, keepsLastWhereReachable: 4, unreachableRoom: 8, otherReachableRoom: 16, otherLevel: 32, walledOutside: 64, notWalkable: 128, nothing: 256 };
      const bad = new Uint8Array(G.n);
      const examples = new Map();
      const vsSpec = { n: 0, first: [] };
      let current = 0;
      const bump = (o, k) => { o[k] = (o[k] || 0) + 1; if (BIT[k]) seenAs[current] |= BIT[k]; };
      while (q.length) {
        const k = q.pop(), s = q.pop();
        current = s;
        const last = k === NONE ? null : vlist[k];
        const p = { x: G.x(s), y: G.F[s], z: G.z(s) };
        const got = fn(p, last);
        // The page's own function must decide exactly as the reference, decision by decision.
        if (name === 'game') {
          const want = ref.at(p, last);
          if (want !== got) { vsSpec.n++; if (vsSpec.first.length < 5) vsSpec.first.push({ at: [p.x, p.y, p.z], last, game: got, spec: want }); }
        }
        const exact = exactAt(s, last);
        const t = T[['open', 'room', 'street'][where[s]]];
        bump(t, 'n');
        let cls;
        const reach = pieceRooms.get(G.comp[s]);
        if (got === exact) cls = 'agree';
        else if (exact === null) cls = 'roomWhereNoneReachable';
        else if (got === null) cls = 'keepsLastWhereReachable';
        else if (!reach || !reach.has(got)) cls = 'unreachableRoom';
        else cls = 'otherReachableRoom';
        bump(t, cls);
        if (cls !== 'agree') {
          bad[s] = 1;
          const ek = `${['open', 'room', 'street'][where[s]]} ${cls} ${got}>${exact}`;
          const e = examples.get(ek) || { n: 0, at: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], last };
          e.n++; examples.set(ek, e);
        }
        // What the room counted is, whatever the exact rule says.
        const counted = got ?? last;
        if (counted !== null) {
          const e = ref.entries.get(counted);
          const level = Math.round(p.y / LEVEL_H);
          if (!e || e.level !== level) bump(t, 'otherLevel');
          if (e && e.walled) {
            const dx = p.x - e.x, dz = p.z - e.z;
            const inside = e.level === level && (e.round ? dx * dx + dz * dz < TREE_LINE ** 2 : Math.abs(dx) < WALL_LINE && Math.abs(dz) < WALL_LINE);
            if (!inside) bump(t, 'walledOutside');
          }
          if (!reach || !reach.has(counted)) bump(t, 'notWalkable');
        } else bump(t, 'nothing');
        const nk = counted === null ? NONE : vidx.get(counted);
        for (const u of G.edges[s]) if (visit(u, nk)) q.push(u, nk);
      }
      let badSamples = 0, reached = 0;
      const S = { room: {}, street: {}, open: {} };
      for (let s = 0; s < G.n; s++) {
        if (first[s] === -1) continue;
        reached++;
        if (bad[s]) badSamples++;
        const o = S[['open', 'room', 'street'][where[s]]];
        o.n = (o.n || 0) + 1;
        for (const [c, b] of Object.entries(BIT)) if (seenAs[s] & b) o[c] = (o[c] || 0) + 1;
        if (seenAs[s] & 30) o.otherwise = (o.otherwise || 0) + 1;
      }
      zoneOut.states[name] = {
        samples: reached, badSamples, byWhere: T, bySample: S, ms: Date.now() - tr, ...(name === 'game' ? { vsSpec } : {}),
        examples: [...examples].sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([key, e]) => ({ key, ...e })),
      };
      grand[name] ||= { samples: 0, badSamples: 0, byWhere: { room: {}, street: {}, open: {} }, bySample: { room: {}, street: {}, open: {} } };
      grand[name].samples += reached; grand[name].badSamples += badSamples;
      for (const wh of ['room', 'street', 'open']) {
        for (const [c, m] of Object.entries(T[wh])) grand[name].byWhere[wh][c] = (grand[name].byWhere[wh][c] || 0) + m;
        for (const [c, m] of Object.entries(S[wh])) grand[name].bySample[wh][c] = (grand[name].bySample[wh][c] || 0) + m;
      }
    }
    zoneOut.ms = Date.now() - t0;
    report.zones[zoneId] = zoneOut;
    for (const [name, r] of Object.entries(zoneOut.states)) {
      // Shares of samples (a sample counts once in each class any of its states fell in).
      const o = r.bySample.open, st = r.bySample.street;
      console.log(`${zoneId.padEnd(9)} ${name.padEnd(5)} ${String(r.samples).padStart(8)} samples, ${pc(r.badSamples, r.samples).padStart(7)} decided otherwise (${(r.ms / 1000).toFixed(1)} s)`
        + ` | open ${o.n || 0}: otherwise ${pc(o.otherwise, o.n)} (none reachable ${pc(o.roomWhereNoneReachable, o.n)}, kept last ${pc(o.keepsLastWhereReachable, o.n)}, unreachable ${pc(o.unreachableRoom, o.n)}, other ${pc(o.otherReachableRoom, o.n)});`
        + ` other level ${pc(o.otherLevel, o.n)}, walled outside ${pc(o.walledOutside, o.n)}, not walkable ${pc(o.notWalkable, o.n)}`
        + ` | street ${st.n || 0}: otherwise ${pc(st.otherwise, st.n)}, walled outside ${pc(st.walledOutside, st.n)}, not walkable ${pc(st.notWalkable, st.n)}`);
      for (const e of r.examples.slice(0, 4)) console.log(`      ${e.key} x${e.n} at ${e.at.join(',')} (last ${e.last})`);
      if (r.vsSpec) console.log(`${zoneId.padEnd(9)} game against spec: ${r.vsSpec.n} decisions differ${r.vsSpec.n ? ` (first ${JSON.stringify(r.vsSpec.first[0])})` : ''}`);
    }
    // The page's own game against the same function in node.
    if (opt.pageCheck) {
      const drawn = await drawZone(zoneId);
      if (drawn.ok) {
        const g = gameCounter(inputs);
        let r = 12345; const rand = () => ((r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296);
        const asks = [];
        const lasts = [null, ...ref.entries.keys()];
        for (let k = 0; k < opt.pageCheck; k++) {
          const s = Math.floor(rand() * G.n);
          asks.push([G.x(s), G.F[s], G.z(s), lasts[Math.floor(rand() * lasts.length)]]);
        }
        const answers = await page.evaluate((asks) => {
          const game = window.diku.game;
          if (typeof game.roomAt !== 'function') return null;
          return asks.map(([x, y, z, last]) => game.roomAt({ x, y, z }, last));
        }, asks);
        if (!answers) console.log(`${zoneId.padEnd(9)} page check: diku.game.roomAt is not there`);
        else {
          const differ = asks.filter((a, k) => g.at({ x: a[0], y: a[1], z: a[2] }, a[3]) !== answers[k]);
          zoneOut.pageCheck = { asked: asks.length, differ: differ.length, first: differ.slice(0, 5) };
          console.log(`${zoneId.padEnd(9)} page check: ${asks.length} decisions, ${differ.length} differ between the page and node${differ.length ? ` (first ${JSON.stringify(differ[0])})` : ''}`);
        }
      }
    }
  }

  console.log('\nALL ZONES');
  for (const [name, g] of Object.entries(grand)) {
    if (name === 'game') console.log(`  game against spec: ${Object.values(report.zones).reduce((n, z) => n + (z.states?.game?.vsSpec?.n || 0), 0)} decisions differ in all`);
    console.log(`  ${name}: ${g.samples} samples, ${pc(g.badSamples, g.samples)} decided otherwise than the exact rule somewhere`);
    for (const wh of ['room', 'street', 'open']) {
      const o = g.bySample[wh];
      console.log(`    ${wh.padEnd(6)} ${o.n || 0} samples: otherwise ${pc(o.otherwise, o.n)}; none reachable ${pc(o.roomWhereNoneReachable, o.n)}, kept last ${pc(o.keepsLastWhereReachable, o.n)},`
        + ` unreachable ${pc(o.unreachableRoom, o.n)}, other reachable ${pc(o.otherReachableRoom, o.n)}; other level ${pc(o.otherLevel, o.n)}, walled outside ${pc(o.walledOutside, o.n)}, not walkable ${pc(o.notWalkable, o.n)}`);
      console.log(`           states ${JSON.stringify(g.byWhere[wh])}`);
    }
  }
  report.all = grand;
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(report, null, 1));
  if (browser) await browser.close();
}

// Run as a tool; imported (loadReference), only the rule.
// (Real paths: /tmp is /private/tmp on macOS, and node names the module by the latter.)
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) await main();
