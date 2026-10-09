// What lies outside every doorway of every walled room.
//
// A walled room's doorway should come out on the street of its own exit: the
// passage layout.js routed for that exit, which build.js builds as a corridor
// (walls and a ceiling) when the room at its other end is walled too, and as
// an open street when it is not. But layout.js lets two streets share a cell
// (`crossings: 'allow'`), and two things follow from that for a doorway:
//
//   doorstep     the cell outside the door also carries a street routed for
//                another pair of rooms, so the door opens onto that street;
//   breaks out   the door's own corridor runs through a cell of another
//                pair's open street, and build.js lets the street build that
//                cell (`buildAlley`: "the street builds the cell"), so the
//                corridor stands open onto it a few cells on. The werklijst's
//                example is this: ofcol's bedroom #636, whose corridor to the
//                house north of it comes out on the village street between
//                #5551 and #5552, where a reviewer saw "the bedroom's floor
//                run straight out to the cobbled square";
//   corridors cross  the door's corridor shares a cell with another pair's
//                corridor: both stand their walls in it, each across the
//                other's way or both down one shared run.
//
// Those three are the offenders. A doorway whose own open street crosses
// another street further on (`street crosses`) is a street crossing, which is
// PLAN_BRIDGES' business, not a doorway's; it is counted, not listed. A side
// that is no doorway -- an archway into a portal, a gate into another zone, a
// ladder or a flight against a wall -- is counted with what lies outside it.
// A street another pair shares with a pair the mud joins at every end (layout.js
// `harmless`) joins nothing new and is not counted at all.
//
// No browser: server/world.mjs `bootWorld` lays out every zone as the page
// does, and which rooms are walled is its `walled` (shells.js isOpenAir).
//
//   node tools/judge/headless/doorways.mjs [--repo <checkout>] [--zones home,ofcol]
//        [--list] [--all] [--json out.json] [--work werklijst.json ...]
//
// --list prints every offender; --all every doorway of the zones asked for.
// --work attributes the street pairs of `walkable.mjs --work` files to what
// the layout has at the step each pair was first seen at: a doorway, a
// corridor breaking out, a crossing, or two streets or a street and an
// open-air room merely beside each other.
//
// --page asks the page whether each street can be walked: every zone built
// in a headless page, and a flood (walkable.mjs's body, doors open) from one
// end room's arrival point, kept to the two rooms' cells and the street's
// own, until it reaches the other's. A gap one sample wide is crossed in
// stride (an upper floor's doorway: the room's floor stops at 5 m, the
// street's starts at 6.5 m). Each street the page cannot walk is listed with
// what the layout shares its cells with. Like the other headless tools it
// imports playwright, so it runs from the scratch directory that has it:
//
//   cp <repo>/tools/judge/headless/doorways.mjs /tmp/pw/
//   node /tmp/pw/doorways.mjs --repo <repo> --page [--port 8173] [--zones ...]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const opt = { repo: path.resolve(here, '../../..'), zones: 'all', list: false, all: false, json: null, work: [], page: false, port: 8173 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--repo') { opt.repo = path.resolve(v); i++; }
  else if (a === '--page') opt.page = true;
  else if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--zones') { opt.zones = v; i++; }
  else if (a === '--list') opt.list = true;
  else if (a === '--all') opt.all = true;
  else if (a === '--json') { opt.json = v; i++; }
  else if (a === '--work') { while (args[i + 1] && !args[i + 1].startsWith('--')) opt.work.push(args[++i]); }
  else throw new Error(`doorways: unknown argument ${a}`);
}
const load = (f) => import(pathToFileURL(path.join(opt.repo, f)).href);
const { bootWorld, CELL, LEVEL_H } = await load('server/world.mjs');
const { DIR_STEP, DIR_SHORT, REVERSE_DIR } = await load('src/are.js');
const { openAirIn } = await load('src/shells.js');

const w = bootWorld(opt.repo);
const openAir = openAirIn(w.world);
const zoneIds = opt.zones === 'all' ? w.zones.map((z) => z.zone.id) : opt.zones.split(',');
const OFFENDERS = ['doorstep', 'breaks out', 'corridors cross'];

/** Everything about one zone's streets the census asks. */
function streetsOf(Z) {
  const L = Z.layout;
  const info = (v) => w.built.rooms.get(v);
  // build.js builds no street to or from an "In the air..." room.
  const built = (l) => l.kind === 'alley' && l.to && !info(l.from.vnum)?.unbuilt && !info(l.to.vnum)?.unbuilt;
  const at = new Map(); // "level,x,z" -> [link]
  for (const l of L.links) {
    if (!built(l)) continue;
    for (const c of l.path) {
      const k = `${l.from.level},${c.x},${c.z}`;
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(l);
    }
  }
  // layout.js `harmless`: every end of one joined, by exits both ways, to every end of the other.
  const exitTo = (a, b) => a.room.exits.some((e) => e && e.to === b.vnum);
  const joined = (a, b) => a === b || (exitTo(a, b) && exitTo(b, a));
  const harmless = (l, m) => [l.from, l.to].every((x) => [m.from, m.to].every((y) => joined(x, y)));
  // build.js `alleyEnclosed`: walls and a ceiling when both ends are walled.
  const corridor = (l) => !openAir(l.from.room) && !openAir(l.to.room);
  const name = (l) => `#${l.from.vnum}-#${l.to.vnum}`;
  const cellKey = (level, x, z) => `${level},${x},${z}`;
  const foreign = (l, level, x, z) => (at.get(cellKey(level, x, z)) || []).filter((m) => m !== l && !harmless(l, m));
  return { L, at, built, harmless, corridor, name, cellKey, foreign };
}

/** Every side of every walled room in a zone, and what is outside it. */
function census(zoneId) {
  const Z = w.byId.get(zoneId);
  if (!Z) throw new Error(`doorways: no zone ${zoneId}`);
  const S = streetsOf(Z);
  const { L } = S;
  const out = [];
  for (const [vnum, cell] of L.cells) {
    const room = w.world.rooms.get(vnum);
    const inf = w.built.rooms.get(vnum);
    if (!inf || !inf.walled || inf.unbuilt) continue;
    const sides = L.sides.get(vnum) || [];
    for (let d = 0; d < 4; d++) {
      const s = sides[d];
      if (!s) continue;
      const [dx, , dz] = DIR_STEP[d];
      const fx = cell.x + dx, fz = cell.z + dz;
      const front = S.at.get(S.cellKey(cell.level, fx, fz)) || [];
      const rec = {
        zone: zoneId, room: vnum, name: room.name, side: DIR_SHORT[d], kind: s.kind,
        target: s.target?.vnum ?? null, cell: [cell.level, fx, fz],
      };
      if (s.kind !== 'alley' || !s.link || !S.built(s.link)) {
        // Not a doorway: what stands outside the wall is all there is to say.
        rec.outside = L.at(cell.level, fx, fz) !== undefined ? 'a room' : front.length ? 'a street' : 'open ground';
        rec.streets = front.map(S.name);
        out.push(rec);
        continue;
      }
      const own = s.link;
      rec.link = S.name(own);
      rec.street = S.corridor(own) ? 'corridor' : 'open';
      if (!front.includes(own)) throw new Error(`doorways: #${vnum} ${DIR_SHORT[d]} is ${rec.link}'s doorway, but that street is not outside it`);
      // Its own street, cell by cell from this door.
      const path = own.from.vnum === vnum ? own.path : [...own.path].reverse();
      rec.outside = 'own';
      for (let i = 0; i < path.length; i++) {
        const others = S.foreign(own, cell.level, path[i].x, path[i].z);
        if (!others.length) continue;
        const open = others.filter((m) => !S.corridor(m));
        if (i === 0) rec.outside = 'doorstep';
        else if (rec.street === 'corridor') rec.outside = open.length ? 'breaks out' : 'corridors cross';
        else rec.outside = 'street crosses';
        rec.at = i + 1;
        rec.where = [cell.level, path[i].x, path[i].z];
        rec.others = others.map((m) => ({ link: S.name(m), street: S.corridor(m) ? 'corridor' : 'open' }));
        break;
      }
      out.push(rec);
    }
  }
  return out;
}

/** One line for a doorway. */
function line(r) {
  const head = `#${r.room} ${r.name} ${r.side}`;
  if (r.kind !== 'alley' || !r.link) return `${head}: ${r.kind}${r.target ? ` to #${r.target}` : ''}, ${r.outside} outside${r.streets?.length ? ` (${r.streets.join(' ')})` : ''}`;
  const where = r.where ? ` at ${r.where.slice(1).join(',')}` : '';
  const what = {
    own: 'its own street',
    doorstep: `its ${r.street === 'corridor' ? 'corridor' : 'street'} shares the doorstep with ${r.others?.map((o) => `${o.link} (${o.street})`).join(', ')}`,
    'breaks out': `its corridor comes out on ${r.others?.filter((o) => o.street === 'open').map((o) => o.link).join(', ')}'s street ${r.at} cells from the door${where}`,
    'corridors cross': `its corridor shares a cell with ${r.others?.map((o) => o.link).join(', ')}'s corridor ${r.at} cells from the door${where}`,
    'street crosses': `its street crosses ${r.others?.map((o) => o.link).join(', ')} ${r.at} cells from the door${where}`,
  }[r.outside];
  return `${head} -> #${r.target} (${r.link}, ${r.street}): ${what}`;
}

const all = [];
const totals = {};
const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
for (const zoneId of zoneIds) {
  const recs = census(zoneId);
  all.push(...recs);
  const doors = recs.filter((r) => r.kind === 'alley' && r.link);
  const counts = {};
  for (const r of doors) bump(counts, r.outside);
  const rest = {};
  for (const r of recs.filter((x) => !(x.kind === 'alley' && x.link))) bump(rest, `${r.kind}: ${r.outside}`);
  for (const [k, n] of Object.entries(counts)) totals[k] = (totals[k] || 0) + n;
  const off = doors.filter((r) => OFFENDERS.includes(r.outside));
  const walledRooms = new Set(recs.map((r) => r.room)).size;
  console.log(`${zoneId.padEnd(9)} walled rooms ${String(walledRooms).padStart(3)}  doorways ${String(doors.length).padStart(4)}  `
    + `own ${String(counts.own || 0).padStart(4)}  doorstep ${String(counts.doorstep || 0).padStart(3)}  breaks out ${String(counts['breaks out'] || 0).padStart(3)}  `
    + `corridors cross ${String(counts['corridors cross'] || 0).padStart(3)}  street crosses ${String(counts['street crosses'] || 0).padStart(3)}`
    + `${Object.keys(rest).length ? `  | ${Object.entries(rest).sort().map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`);
  if (opt.list || opt.all) for (const r of (opt.all ? recs : off)) console.log(`    ${line(r)}`);
}
const doorsAll = all.filter((r) => r.kind === 'alley' && r.link);
const offAll = doorsAll.filter((r) => OFFENDERS.includes(r.outside));
console.log(`\n${doorsAll.length} doorways of walled rooms in ${zoneIds.length} zones: ${totals.own || 0} come out on their own street; `
  + `offenders ${offAll.length} (doorstep ${totals.doorstep || 0}, breaks out ${totals['breaks out'] || 0}, corridors cross ${totals['corridors cross'] || 0}); `
  + `${totals['street crosses'] || 0} whose open street crosses another further on`);

// --work: what the layout has where each street pair of a werklijst was first seen.
const attribution = [];
if (opt.work.length) {
  const RES = 0.5;
  const kinds = {};
  for (const f of opt.work) {
    const work = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const [zoneId, d] of Object.entries(work.zones)) {
      const Z = w.byId.get(zoneId);
      if (!Z) continue;
      const S = streetsOf(Z);
      const doorstepOf = new Map(); // "level,x,z" -> [walled rooms whose doorway it is]
      for (const r of all.filter((x) => x.zone === zoneId && x.kind === 'alley' && x.link)) {
        const k = r.cell.join(',');
        if (!doorstepOf.has(k)) doorstepOf.set(k, []);
        doorstepOf.get(k).push(r.room);
      }
      if (!all.some((x) => x.zone === zoneId)) {
        for (const r of census(zoneId)) {
          if (!(r.kind === 'alley' && r.link)) continue;
          const k = r.cell.join(',');
          if (!doorstepOf.has(k)) doorstepOf.set(k, []);
          doorstepOf.get(k).push(r.room);
        }
      }
      for (const p of d.street) {
        const [x, feet, z, yaw] = p.at;
        const nx = x - Math.sin(yaw) * RES, nz = z - Math.cos(yaw) * RES;
        const level = Math.round(feet / LEVEL_H);
        const P = [level, Math.round(x / CELL), Math.round(z / CELL)];
        const Q = [level, Math.round(nx / CELL), Math.round(nz / CELL)];
        const what = (c) => {
          const room = S.L.at(...c);
          const links = S.at.get(c.join(',')) || [];
          const shared = links.filter((l) => links.some((m) => m !== l && !S.harmless(l, m)));
          return { c, room, links, shared };
        };
        const a = what(P), b = what(Q);
        let cause;
        const sharedCell = a.shared.length ? a : b.shared.length ? b : null;
        if (sharedCell) {
          const k = sharedCell.c.join(',');
          const ls = sharedCell.shared;
          if (doorstepOf.has(k) && ls.some((l) => doorstepOf.get(k).some((v) => l.from.vnum === v || l.to.vnum === v))) cause = 'doorstep of a walled room';
          else if (ls.some((l) => S.corridor(l)) && ls.some((l) => !S.corridor(l))) cause = 'corridor breaks out';
          else if (ls.every((l) => S.corridor(l))) cause = 'corridors cross';
          else cause = 'streets cross';
        } else if (a.room !== undefined || b.room !== undefined) {
          cause = 'street beside an open-air room';
        } else if (a.links.length && b.links.length) {
          cause = a.links.some((l) => b.links.includes(l)) ? 'along one street' : 'streets side by side';
        } else cause = 'elsewhere';
        bump(kinds, `${work.shut ? 'shut' : 'open'}: ${cause}`);
        attribution.push({ file: path.basename(f), shut: !!work.shut, zone: zoneId, from: p.from, to: p.to, kind: p.kind, cause, at: P, into: Q });
      }
    }
  }
  console.log('\nwerklijst street pairs, by what the layout has where each was first seen:');
  for (const [k, n] of Object.entries(kinds).sort()) console.log(`  ${k.padEnd(48)} ${n}`);
}

// --page: can the page walk each street from one room to the other?
const walked = {};
if (opt.page) {
  if (!fs.existsSync(path.join(opt.repo, 'server/world.mjs'))) throw new Error(`doorways: --page needs --repo <the diku3d checkout>, not ${opt.repo}`);
  const { chromium } = await import('playwright');
  const RADIUS = 0.42, STEP_UP = 0.62, HEIGHT = 1.8, RES = 0.5;
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:${opt.port}/`);
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 240000 });
  await page.waitForTimeout(3000);
  let total = 0, stuck = 0;
  console.log('\nstreets the page cannot walk from one room to the other inside their own cells, doors open:');
  for (const zoneId of zoneIds) {
    const data = await page.evaluate(async (zoneId) => {
      const d = window.diku; const zone = d.plan.byId.get(zoneId);
      if (d.zone !== zone) {
        const stand = [zone.start, ...zone.rooms].find((v) => d.world.rooms.get(v)?.sector !== 9) ?? zone.start;
        try { await d.goto(stand); } catch (e) { return { skipped: e.message }; }
      }
      if (d.zone !== zone) return { skipped: 'not drawn' };
      d.state.paused = true;
      const col = [];
      for (const c of d.built.colliders) if (!c.door) col.push(Math.min(c.x0, c.x1), Math.max(c.x0, c.x1), Math.min(c.z0, c.z1), Math.max(c.z0, c.z1), c.y0, c.y1, c.r || 0);
      const plat = []; for (const p of d.built.platforms) plat.push(p.x0, p.x1, p.z0, p.z1, p.top);
      const rooms = {};
      for (const [vnum, info] of d.built.rooms) {
        if (info.unbuilt || d.plan.zoneOf(vnum) !== zone) continue;
        const [x, z] = d.player.resolvePoint(info.center.x, info.center.z, info.center.y);
        rooms[vnum] = [x, info.center.y, z];
      }
      const links = d.layout.links.filter((l) => l.kind === 'alley' && l.to && rooms[l.from.vnum] && rooms[l.to.vnum])
        .map((l) => ({ a: l.from.vnum, b: l.to.vnum, cells: [[l.from.x, l.from.z], ...l.path.map((c) => [c.x, c.z]), [l.to.x, l.to.z]] }));
      return { col, plat, rooms, links };
    }, zoneId);
    if (data.skipped) { console.log(`${zoneId.padEnd(9)} skipped: ${data.skipped}`); continue; }
    const B = 4, bucketKey = (bx, bz) => bx * 100003 + bz;
    const bucketsOf = (arr, stride) => {
      const m = new Map();
      for (let k = 0; k < arr.length; k += stride) {
        for (let bx = Math.floor((arr[k] - RADIUS) / B); bx <= Math.floor((arr[k + 1] + RADIUS) / B); bx++) {
          for (let bz = Math.floor((arr[k + 2] - RADIUS) / B); bz <= Math.floor((arr[k + 3] + RADIUS) / B); bz++) {
            const key = bucketKey(bx, bz); let l = m.get(key); if (!l) m.set(key, (l = [])); l.push(k);
          }
        }
      }
      return m;
    };
    const P = data.plat, C = data.col; const pb = bucketsOf(P, 5), cb = bucketsOf(C, 7);
    const near = (m, x, z) => m.get(bucketKey(Math.floor(x / B), Math.floor(z / B))) || [];
    /** player.js groundAt: the highest platform under the body, a step or less above the feet. */
    const groundAt = (x, z, feet, reach = STEP_UP) => {
      let best = -Infinity;
      for (const k of near(pb, x, z)) {
        if (x < P[k] - RADIUS || x > P[k + 1] + RADIUS || z < P[k + 2] - RADIUS || z > P[k + 3] + RADIUS) continue;
        const top = P[k + 4]; if (top <= feet + reach && top > best) best = top;
      }
      return best;
    };
    /** player.js resolveCollisions: anything between a step up and the head. */
    const blocked = (x, z, feet) => {
      for (const k of near(cb, x, z)) {
        if (C[k + 5] <= feet + STEP_UP || C[k + 4] >= feet + HEIGHT) continue;
        if (x < C[k] - RADIUS || x > C[k + 1] + RADIUS || z < C[k + 2] - RADIUS || z > C[k + 3] + RADIUS) continue;
        if (C[k + 6] && Math.hypot(x - (C[k] + C[k + 1]) / 2, z - (C[k + 2] + C[k + 3]) / 2) >= C[k + 6] + RADIUS) continue;
        return true;
      }
      return false;
    };
    const S = streetsOf(w.byId.get(zoneId));
    const shut = [];
    for (const L of data.links) {
      const inside = new Set(L.cells.map(([x, z]) => `${x},${z}`));
      const [ax, ay, az] = data.rooms[L.a]; const [bx, by, bz] = data.rooms[L.b];
      const i0 = Math.floor(ax / RES), j0 = Math.floor(az / RES);
      const f0 = groundAt((i0 + 0.5) * RES, (j0 + 0.5) * RES, ay, 2);
      let reached = false;
      if (f0 !== -Infinity) {
        const seen = new Set([`${i0},${j0},${Math.round(f0 * 100)}`]); const q = [i0, j0, f0];
        while (q.length && !reached) {
          const feet = q.pop(), j = q.pop(), i = q.pop();
          const x = (i + 0.5) * RES, z = (j + 0.5) * RES;
          if (Math.abs(x - bx) <= 1 && Math.abs(z - bz) <= 1 && Math.abs(feet - by) <= 0.8) { reached = true; break; }
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const a = i + di, c = j + dj; const nx = (a + 0.5) * RES, nz = (c + 0.5) * RES;
            if (!inside.has(`${Math.round(nx / CELL)},${Math.round(nz / CELL)}`)) continue;
            let nf = groundAt(nx, nz, feet);
            if ((nf === -Infinity || nf < feet - STEP_UP) && Math.abs(groundAt(nx + di * RES, nz + dj * RES, feet) - feet) <= STEP_UP) nf = feet;
            if (nf === -Infinity || nf < feet - STEP_UP || blocked(nx, nz, feet)) continue;
            const key = `${a},${c},${Math.round(nf * 100)}`;
            if (seen.has(key)) continue; seen.add(key); q.push(a, c, nf);
          }
        }
      }
      total++;
      if (reached) continue;
      stuck++;
      // What the layout shares this street's cells with.
      const link = S.L.links.find((l) => l.kind === 'alley' && l.from.vnum === L.a && l.to?.vnum === L.b && l.path.length === L.cells.length - 2);
      const others = new Set();
      for (const c of link?.path || []) for (const m of S.foreign(link, link.from.level, c.x, c.z)) others.add(`${S.name(m)} (${S.corridor(m) ? 'corridor' : 'open'})`);
      shut.push({ a: L.a, b: L.b, street: link && S.corridor(link) ? 'corridor' : 'open', shares: [...others] });
    }
    walked[zoneId] = { streets: data.links.length, shut };
    const byShare = {};
    for (const s2 of shut) { const k = `${s2.street}${s2.shares.length ? ` sharing with ${[...new Set(s2.shares.map((x) => x.replace(/^.* \(/, '').replace(')', '')))].sort().join('+')}` : ', sharing no cell'}`; byShare[k] = (byShare[k] || 0) + 1; }
    console.log(`${zoneId.padEnd(9)} ${String(shut.length).padStart(3)} of ${String(data.links.length).padStart(4)}${shut.length ? `  ${JSON.stringify(byShare)}` : ''}`);
    if (opt.list) for (const s2 of shut) console.log(`    #${s2.a}-#${s2.b} ${s2.street}${s2.shares.length ? `, shares cells with ${s2.shares.join(', ')}` : ''}`);
  }
  await browser.close();
  console.log(`${stuck} of ${total} streets cannot be walked from one room to the other inside their own cells`);
}

if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ repo: opt.repo, zones: zoneIds, doorways: all, attribution, walked }, null, 1));
