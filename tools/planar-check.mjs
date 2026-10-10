/**
 * Does the embedding (layout.js) honour its own invariants and the mud?
 *
 *   node tools/planar-check.mjs            # every zone: faults, fidelity, crossings
 *   node tools/planar-check.mjs --areas    # every area laid out alone (layout-check's view)
 *   node tools/planar-check.mjs 3040       # the zone holding #3040, every exit and crossing of it
 *   node tools/planar-check.mjs --strict   # exit 1 on any hard fault
 *   node tools/planar-check.mjs --try X    # a layout.js option against the baseline:
 *                                          # terrace, keepClear, midennirWhole, reach=12,
 *                                          # crossings=forbid|raise
 *   node tools/planar-check.mjs --vertical # what bridges, tunnels, ramps and stacking could buy
 *
 * Hard faults (a bug in layout.js wherever they appear):
 *   odd coordinates     a room off the even grid the spread put it on
 *   two rooms, one cell
 *   street through room a routed cell that is also a room's cell
 *   broken street       a path that is not a chain of adjacent cells from
 *                       the wall it leaves to the wall it arrives through
 *   stairs not stacked  a 'stairs' link whose rooms are not one level apart
 *                       in the same column
 *   exit without link   an exit of a placed room no link carries, or two do
 *   side off its link   layout.sides disagreeing with the link it names
 *   roofed open air     a room in the column directly above an open-air room
 *                       (CLAUDE.md: that street becomes a tunnel). Open, not
 *                       fixed: layout.js guards this only when going *up*
 *                       from open ground, and a room reached by going down
 *                       lands straight under the one above (the Valley of
 *                       the Elves' entrance under the Overlook's stone,
 *                       Juargan's "Up the hill" as a stack of slabs).
 *                       --strict holds the count at CEILING.roofed; lower
 *                       it when a change brings it down.
 *   load order          a zone that lays out differently when area.lst is
 *                       read backwards (a server and its clients must agree)
 *   shortcut crossing   a cell two streets share whose end rooms the mud does
 *                       not join: standing there you can walk from one
 *                       street's room into the other's with no exit between
 *                       them. The server refuses that step (mud.mjs judge:
 *                       "no open way from #3015 to #3006") and the page lets
 *                       you take it. Counted; --strict holds it at
 *                       CEILING.shortcut.
 *
 * Measured, not faulted -- the graph is not Euclidean, see CLAUDE.md:
 *   fidelity            of every level exit between placed rooms, how many
 *                       land where the mud points (straight: the next cell
 *                       in that direction; ahead; sideways; behind), and how
 *                       the passage realises it (both walls right, one wall
 *                       wrong, archway)
 *   reciprocals         A north -> B while B says A is anywhere but south
 *   streets crossing    two routed streets through one cell
 *   beside open ground  street cells beside an open-air room the street's
 *                       rooms are not joined to: the same unexitted step
 *                       without a second street, if build.js leaves that
 *                       side open (it brings a city cell's frontage
 *                       forward, so this over-counts in town)
 *   crossings           for each exit into another zone: the wall its gate
 *                       took, and whether a street or a room of the same
 *                       zone lies behind that wall -- which is what lets
 *                       someone walk round a gate and see its back. And the
 *                       same for the way back in the other zone.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld, DIR_NAME, DIR_STEP, REVERSE_DIR, SECTOR, ROOM_INDOORS } from '../src/are.js';
import { layoutWorld } from '../src/layout.js';
import { planZones, layoutZone } from '../src/zones.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const perArea = argv.includes('--areas');
const focus = Number(argv.find((a) => /^\d+$/.test(a))) || null;
const trial = argv.includes('--try') ? argv[argv.indexOf('--try') + 1] : null;
const vertical = argv.includes('--vertical');

// 48 rooms in 12 zones, none in the home zone, as of wave 13. Shortcuts:
// 408 cells in all zones, 141 of them in the home zone, at reach 12 with
// layout.js crossings 'allow' (wave 17, after re-laying corridors round the
// cells they shared and the black hole's street; 430 and 150 in wave 15);
// 0 with 'forbid' or 'raise', which cost walkable passages -- see --try
// crossings=forbid.
const CEILING = { roofed: 48, shortcut: 408 };
const listed = readFileSync(join(areaDir, 'area.lst'), 'latin1').split(/\s+/).filter((f) => f.endsWith('.are'));
const read = (f) => parseArea(readFileSync(join(areaDir, f), 'latin1'), f);

const OUTDOOR = new Set([SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS, SECTOR.MOUNTAIN,
  SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT, SECTOR.AIR]);
const openAir = (room) => OUTDOOR.has(room.sector) && !(room.flags & ROOM_INDOORS);
const k3 = (l, x, z) => `${l},${x},${z}`;

/** Hard invariants and measurements of one layout. `inZone(v)` says which rooms it was asked to place. */
function audit(world, layout, inZone = () => true) {
  const faults = [];
  const fault = (what, where) => faults.push(`${what.padEnd(20)} ${where}`);
  let roofedCount = 0;
  const cells = layout.cells;

  // Even coordinates, one room per cell.
  const at = new Map();
  for (const c of cells.values()) {
    if (c.x % 2 || c.z % 2) fault('odd coordinates', `#${c.vnum} at ${k3(c.level, c.x, c.z)}`);
    const k = k3(c.level, c.x, c.z);
    if (at.has(k)) fault('two rooms, one cell', `#${at.get(k)} and #${c.vnum} at ${k}`);
    at.set(k, c.vnum);
  }

  // Streets: a chain of free cells out of one wall and into another.
  const owners = new Map(); // cell -> [link]
  for (const l of layout.links) {
    if (l.kind !== 'alley') continue;
    const where = `#${l.from.vnum} ${DIR_NAME[l.dir]} -> #${l.to.vnum}`;
    if (!l.path || !l.path.length) { fault('broken street', `${where}: no path`); continue; }
    if (l.from.level !== l.to.level) fault('broken street', `${where}: ends on levels ${l.from.level} and ${l.to.level}`);
    const [ex, , ez] = DIR_STEP[l.entryDir];
    if (l.path[0].x !== l.from.x + ex || l.path[0].z !== l.from.z + ez) fault('broken street', `${where}: does not start out of the ${DIR_NAME[l.entryDir]} wall`);
    const [xx, , xz] = DIR_STEP[l.exitDir];
    const last = l.path[l.path.length - 1];
    if (last.x + xx !== l.to.x || last.z + xz !== l.to.z) fault('broken street', `${where}: does not arrive ${DIR_NAME[l.exitDir]} into #${l.to.vnum}`);
    for (let i = 1; i < l.path.length; i++) {
      const a = l.path[i - 1]; const b = l.path[i];
      if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== 1) fault('broken street', `${where}: cells ${a.x},${a.z} and ${b.x},${b.z} are not adjacent`);
    }
    for (const c of l.path) {
      const k = k3(l.from.level, c.x, c.z);
      if (at.has(k)) fault('street through room', `${where} runs through #${at.get(k)} at ${k}`);
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push(l);
    }
  }
  const crossingsOfStreets = [...owners.values()].filter((ls) => ls.length > 1).length;
  // Which of those cells join rooms the mud does not: for two streets through
  // one cell, every end room of one must be an end of the other or have an
  // exit to and from each end of the other, else the cell is a shortcut.
  const joined = (a, b) => a === b || (a.room.exits.some((e) => e && e.to === b.vnum) && b.room.exits.some((e) => e && e.to === a.vnum));
  const harmless = (l, m) => [l.from, l.to].every((x) => [m.from, m.to].every((y) => joined(x, y)));
  // A cell a raised street runs over (layout option crossings: 'raise')
  // joins nothing to it.
  const lifted = new Map(); // cell -> the street lifted over it
  for (const b of layout.bridges || []) for (const c of b.cells) lifted.set(k3(b.level, c.x, c.z), b.link);
  const shortcuts = [];
  for (const [k, all] of owners) {
    const ls = all.filter((l) => l !== lifted.get(k));
    if (ls.length < 2) continue;
    let bad = null;
    for (let i = 0; i < ls.length && !bad; i++) for (let j = i + 1; j < ls.length; j++) if (!harmless(ls[i], ls[j])) { bad = [ls[i], ls[j]]; break; }
    if (bad) shortcuts.push(`${k}: #${bad[0].from.vnum}-#${bad[0].to.vnum} and #${bad[1].from.vnum}-#${bad[1].to.vnum}`);
  }
  // A street cell beside the cell of an open-air room that is not one of its
  // ends and not joined to them: open ground with no wall, so the same step
  // is possible there without any second street.
  let beside = 0;
  for (const l of layout.links) {
    if (l.kind !== 'alley') continue;
    for (const c of l.path) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const v = layout.at(l.from.level, c.x + dx, c.z + dz);
        if (v === undefined) continue;
        const r = cells.get(v);
        if (r === l.from || r === l.to || !openAir(r.room)) continue;
        if (!joined(l.from, r) || !joined(l.to, r)) { beside++; break; }
      }
    }
  }

  // Stairs are one level apart in the same column.
  for (const l of layout.links) {
    if (l.kind !== 'stairs') continue;
    const [dx, dl, dz] = DIR_STEP[l.dir];
    if (l.to.level !== l.from.level + dl || l.to.x !== l.from.x + dx || l.to.z !== l.from.z + dz) {
      fault('stairs not stacked', `#${l.from.vnum} ${DIR_NAME[l.dir]} -> #${l.to.vnum}`);
    }
  }

  // Every exit of a placed room is carried by exactly one link. layout.js
  // keys a passage by its two rooms and its axis, so the mud's mazes -- a
  // room with east AND west to the same neighbour, or to itself (Old
  // Thalos, Mahn-Tor) -- fold into one link; those are counted, not faulted.
  const axis = (d) => Math.min(d, REVERSE_DIR[d]);
  const carried = new Map(); // "vnum:dir" -> count
  const bump = (v, d) => carried.set(`${v}:${d}`, (carried.get(`${v}:${d}`) || 0) + 1);
  let oddReciprocals = 0; let folded = 0;
  const oddList = [];
  for (const l of layout.links) {
    bump(l.from.vnum, l.dir);
    if (!l.twoWay) continue;
    // The way back: every exit of `to` that points at `from` on this axis.
    const backs = [];
    l.to.room.exits.forEach((e, d) => { if (e && e.to === l.from.vnum && axis(d) === axis(l.dir) && !(l.to === l.from && d === l.dir)) backs.push(d); });
    if (!backs.length) { fault('exit without link', `#${l.from.vnum} ${DIR_NAME[l.dir]} -> #${l.to.vnum} is two-way but #${l.to.vnum} has no exit back on that axis`); continue; }
    for (const b of backs) bump(l.to.vnum, b);
    if (!backs.includes(REVERSE_DIR[l.dir])) { oddReciprocals++; oddList.push(`#${l.from.vnum} ${DIR_NAME[l.dir]} -> #${l.to.vnum}, and #${l.to.vnum} ${DIR_NAME[backs[0]]} -> #${l.from.vnum}`); }
  }
  for (const c of cells.values()) {
    const seenAxis = new Map();
    c.room.exits.forEach((e, d) => {
      if (!e) return;
      // A second exit of this room to the same target on one axis: folded.
      const ak = `${e.to}:${axis(d)}`;
      if (seenAxis.has(ak)) { folded++; return; }
      seenAxis.set(ak, d);
      const n = carried.get(`${c.vnum}:${d}`) || 0;
      if (n !== 1) fault('exit without link', `#${c.vnum} ${DIR_NAME[d]} -> #${e.to} carried by ${n} links`);
    });
  }

  // layout.sides agrees with the links it names.
  for (const [vnum, sides] of layout.sides) {
    sides.forEach((s, d) => {
      if (!s) return;
      const l = s.link;
      if (!l) { fault('side off its link', `#${vnum} ${DIR_NAME[d]} has no link`); return; }
      if (s.kind === 'alley') {
        const end = l.from.vnum === vnum ? 0 : l.to.vnum === vnum ? 1 : -1;
        if (end < 0) fault('side off its link', `#${vnum} ${DIR_NAME[d]} names a street between #${l.from.vnum} and #${l.to.vnum}`);
        else if ((end === 0 ? l.entryDir : REVERSE_DIR[l.exitDir]) !== d) fault('side off its link', `#${vnum} ${DIR_NAME[d]} is not where its street ${end === 0 ? 'leaves' : 'arrives'}`);
      } else if (s.kind === 'stair') {
        if (layout.stairSide.get(l) !== d) fault('side off its link', `#${vnum} ${DIR_NAME[d]} stair is not where stairSide says`);
      } else if (l.from.vnum === vnum) {
        if (l.side !== d) fault('side off its link', `#${vnum} ${DIR_NAME[d]} ${s.kind} but link.side is ${l.side}`);
      } else if (l.to && l.to.vnum === vnum) {
        if (l.backSide !== d) fault('side off its link', `#${vnum} ${DIR_NAME[d]} ${s.kind} but link.backSide is ${l.backSide}`);
      } else fault('side off its link', `#${vnum} ${DIR_NAME[d]} names a link of other rooms`);
    });
  }

  // A room directly above an open-air room roofs it. Open air below level
  // 0 is under the world's ground plane (build.js builds one plane for the
  // whole zone at -0.47 m, cut only where a stair goes down).
  const roofed = [];
  let sunk = 0; let openStairs = 0;
  for (const c of cells.values()) {
    if (openAir(c.room) && c.room.sector !== SECTOR.AIR && c.level < 0) sunk++;
    const below = layout.at(c.level - 1, c.x, c.z);
    if (below === undefined) continue;
    const under = world.rooms.get(below);
    if (openAir(under) && under.sector !== SECTOR.AIR) roofed.push(`#${c.vnum} ${c.room.name} (${openAir(c.room) ? 'open air' : 'indoors'}) over #${below} ${under.name}`);
  }
  roofedCount = roofed.length;
  for (const l of layout.links) {
    if (l.kind !== 'stairs') continue;
    const lower = l.dir === 4 ? l.from : l.to;
    if (openAir(lower.room) && lower.room.sector !== SECTOR.AIR) openStairs++;
  }

  // Fidelity of every level exit between two placed rooms.
  const fidelity = { exits: 0, straight: 0, ahead: 0, sideways: 0, behind: 0, bothWalls: 0, oneWall: 0, archway: 0 };
  const sideOf = (vnum, target) => (layout.sides.get(vnum) || []).findIndex((s) => s && s.target && s.target.vnum === target);
  for (const c of cells.values()) {
    c.room.exits.forEach((e, d) => {
      if (!e || d > 3 || e.to === c.vnum) return;
      const t = cells.get(e.to);
      if (!t || !inZone(e.to)) return;
      fidelity.exits++;
      const [sx, , sz] = DIR_STEP[d];
      const ox = t.x - c.x; const oz = t.z - c.z;
      const along = ox * sx + oz * sz;
      const across = Math.abs(ox * sz - oz * sx);
      if (t.level === c.level && along === 2 && across === 0) fidelity.straight++;
      else if (along > 0) fidelity.ahead++;
      else if (along === 0) fidelity.sideways++;
      else fidelity.behind++;
      const link = layout.links.find((l) => l.kind === 'alley' && ((l.from.vnum === c.vnum && l.to.vnum === e.to) || (l.twoWay && l.to.vnum === c.vnum && l.from.vnum === e.to)));
      if (!link) { fidelity.archway++; return; }
      const here = sideOf(c.vnum, e.to) === d;
      const there = sideOf(e.to, c.vnum) === REVERSE_DIR[d];
      if (here && there) fidelity.bothWalls++; else fidelity.oneWall++;
    });
  }

  return { faults, fidelity, oddReciprocals, oddList, folded, crossingsOfStreets, shortcuts, beside, bridges: (layout.bridges || []).length, roofed, roofedCount, sunk, openStairs };
}

/** What the layout put on the far side of a wall: the cell past it and the room cell beyond that. */
function behind(layout, cell, dir) {
  const [dx, , dz] = DIR_STEP[dir];
  const street = layout.passageAt(cell.level, cell.x + dx, cell.z + dz);
  const room = layout.at(cell.level, cell.x + 2 * dx, cell.z + 2 * dz);
  const sideRooms = [[-dz, dx], [dz, -dx]].map(([ax, az]) => layout.at(cell.level, cell.x + dx + ax, cell.z + dz + az)).filter((v) => v !== undefined);
  return { street, room, sideRooms };
}

/** Every crossing, seen from both zones. */
function crossings(world, plan, layouts) {
  const rows = [];
  for (const c of plan.crossings) {
    const L1 = layouts.get(c.fromZone); const L2 = layouts.get(c.toZone);
    const from = L1.cells.get(c.from);
    const to = L2.cells.get(c.to);
    const row = { ...c, placed: !!from, arrived: !!to };
    if (from) {
      const link = L1.links.find((l) => l.from.vnum === c.from && l.dir === c.dir);
      row.kind = link ? link.kind : 'none';
      row.side = link ? link.side : null;
      if (row.side !== null && row.side !== undefined && c.dir <= 3) row.behind = behind(L1, from, row.side);
      if (c.dir <= 3) row.named = behind(L1, from, c.dir);
    }
    const back = to ? to.room.exits.findIndex((e) => e && e.to === c.from) : -1;
    row.back = back;
    if (to && back >= 0) {
      const link = L2.links.find((l) => l.from.vnum === c.to && l.dir === back);
      row.backKind = link ? link.kind : 'none';
      row.backSide = link ? link.side : null;
      if (row.backSide !== null && row.backSide !== undefined && back <= 3) row.backBehind = behind(L2, to, row.backSide);
    }
    rows.push(row);
  }
  return rows;
}

const describe = (b) => {
  if (!b) return '';
  const parts = [];
  if (b.street) parts.push(`street #${b.street.from.vnum}-#${b.street.to.vnum} past the wall`);
  if (b.room !== undefined) parts.push(`room #${b.room} beyond`);
  if (b.sideRooms.length) parts.push(`rooms ${b.sideRooms.map((v) => '#' + v).join(' ')} flanking the cell past the wall`);
  return parts.length ? parts.join(', ') : 'clear';
};

/** The same zone laid out from a world whose areas were read in another order. */
function loadOrderDiff(files, plan, layouts) {
  const world2 = buildWorld([...files].reverse().map(read));
  const plan2 = planZones(world2, {});
  const out = [];
  for (const zone of plan.zones) {
    const other = plan2.zones.find((z) => z.id === zone.id);
    if (!other) { out.push(`${zone.id}: not a zone when read backwards`); continue; }
    const a = layouts.get(zone.id); const b = layoutZone(world2, plan2, other);
    let moved = 0;
    for (const c of a.cells.values()) {
      const d = b.cells.get(c.vnum);
      if (!d || d.x !== c.x || d.z !== c.z || d.level !== c.level) moved++;
    }
    const sig = (L) => L.links.map((l) => `${l.from.vnum}:${l.dir}:${l.kind}:${l.side}:${l.backSide}:${(l.path || []).map((p) => p.x + ',' + p.z).join(' ')}`).sort().join('|');
    const streets = sig(a) !== sig(b);
    if (moved || a.cells.size !== b.cells.size || streets) out.push(`${zone.id}: ${moved} rooms moved${streets ? ', streets differ' : ''}`);
  }
  return out;
}

/**
 * CLAUDE.md's floor for Midgaard: label each direction with a vector and a
 * cycle closes when its vectors sum to zero. With a breadth-first spanning
 * tree from the temple, count the fundamental cycles that do not close, and
 * confirm that cutting the seven exits named there closes every cycle left.
 */
function midgaardCycles(area) {
  const world = buildWorld([area]);
  const rooms = world.rooms;
  // The exits named in CLAUDE.md, as the undirected edges they are: cutting
  // #3042 south alone leaves #3043 north to put the same edge back.
  const pairOf = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;
  const CUT = new Set([[3042, 2], [3104, 2], [3107, 2], [3114, 1], [3115, 1], [3120, 1], [3120, 2]]
    .map(([v, d]) => pairOf(v, rooms.get(v).exits[d].to)));
  const count = (cut) => {
    const edges = new Map(); // "a-b" -> {a, b, vec}
    for (const r of rooms.values()) {
      r.exits.forEach((e, d) => {
        if (!e || e.offMap || e.to === r.vnum) return;
        const kk = pairOf(r.vnum, e.to);
        if (cut.has(kk) || edges.has(kk)) return;
        const v = DIR_STEP[d];
        edges.set(kk, r.vnum < e.to ? { a: r.vnum, b: e.to, v } : { a: e.to, b: r.vnum, v: v.map((x) => -x) });
      });
    }
    const adj = new Map();
    for (const e of edges.values()) {
      if (!adj.has(e.a)) adj.set(e.a, []);
      if (!adj.has(e.b)) adj.set(e.b, []);
      adj.get(e.a).push({ to: e.b, v: e.v, e }); adj.get(e.b).push({ to: e.a, v: e.v.map((x) => -x), e });
    }
    const pos = new Map([[3001, [0, 0, 0]]]);
    const tree = new Set();
    const queue = [3001];
    while (queue.length) {
      const v = queue.shift();
      for (const n of adj.get(v) || []) {
        if (pos.has(n.to)) continue;
        pos.set(n.to, pos.get(v).map((x, i) => x + n.v[i]));
        tree.add(n.e); queue.push(n.to);
      }
    }
    let open = 0; let total = 0;
    for (const e of edges.values()) {
      if (tree.has(e) || !pos.has(e.a) || !pos.has(e.b)) continue;
      total++;
      const pa = pos.get(e.a); const pb = pos.get(e.b);
      if (pb.some((x, i) => x !== pa[i] + e.v[i])) open++;
    }
    return { reachable: pos.size, edges: edges.size, cycles: total, open };
  };
  return { whole: count(new Set()), cut: count(CUT) };
}

// ---------------------------------------------------------------------------

/**
 * One of layout.js's measurement options, run over every area alone and
 * every zone, against the baseline: what it costs and what it buys. The
 * numbers that decide: per-area walkable (must not drop), the home zone,
 * exit-check's counts, open air roofed, crossings with own ground behind.
 */
const TRIALS = {
  terrace: { terrace: true },
  keepClear: { keepClear: true },
  midennirWhole: { laidWhole: new Set(['hood.are', 'midennir.are']) },
  // Laid whole, but the street to its block gets no more reach than any other.
  midennirShort: { laidWhole: new Set(['hood.are', 'midennir.are']), anchorReach: false },
};
function runTrial(name) {
  // Several at once: --try midennirWhole,reach=6
  const opts = {};
  for (const part of name.split(',')) {
    const o = TRIALS[part] || (part.startsWith('reach=') ? { reach: Number(part.slice(6)) } : null)
      || (part.startsWith('crossings=') ? { crossings: part.slice(10) } : null);
    if (!o) throw new Error(`no trial ${part}: ${[...Object.keys(TRIALS), 'reach=N', 'crossings=allow|forbid|raise'].join(', ')}`);
    Object.assign(opts, o);
  }
  const world = buildWorld(listed.map(read));
  const plan = planZones(world, {});
  const lay = (zone, o) => layoutWorld(world, { startVnum: zone.start, maxRooms: zone.maxRooms, includeVnum: (v) => plan.zoneOf(v) === zone, roots: zone.arrivals, ...o });
  const perArea = (o) => {
    const out = new Map();
    for (const f of listed) {
      const area = read(f);
      if (!area.rooms.length) continue;
      const s = layoutWorld(buildWorld([area]), { startVnum: area.rooms[0].vnum, maxRooms: 600, ...o }).stats;
      const linked = s.alleys + s.stairs + s.portals;
      out.set(f, linked ? (100 * (s.alleys + s.stairs)) / linked : 100);
    }
    return out;
  };
  const measure = (o) => {
    const pa = perArea(o);
    const r = { pa, mean: [...pa.values()].reduce((a, b) => a + b, 0) / pa.size, midgaard: pa.get('midgaard.are'), walk: 0, arch: 0, wrong: 0, corner: 0, noDoor: 0, roofed: 0, behind: 0, layouts: new Map() };
    for (const zone of plan.zones) {
      const L = lay(zone, o);
      r.layouts.set(zone.id, L);
      r.walk += L.stats.alleys + L.stats.stairs; r.arch += L.stats.portals;
      const a = audit(world, L, (v) => plan.zoneOf(v) === zone);
      r.roofed += a.roofed.length; r.shortcut = (r.shortcut || 0) + a.shortcuts.length; r.beside = (r.beside || 0) + a.beside; r.bridges = (r.bridges || 0) + a.bridges;
      if (zone.id === 'home') { r.homeShortcut = a.shortcuts.length; r.homeBeside = a.beside; r.homeBridges = a.bridges; }
      const freeArch = new Set();
      for (const l of L.links) if (l.to && (l.kind === 'portal' || l.kind === 'gate')) { if (l.side === null) freeArch.add(`${l.from.vnum}>${l.to.vnum}`); if (l.backSide === null) freeArch.add(`${l.to.vnum}>${l.from.vnum}`); }
      for (const [v, sides] of L.sides) {
        world.rooms.get(v).exits.forEach((ex, d) => {
          if (!ex || d > 3 || plan.zoneOf(ex.to) !== zone || !L.cells.get(ex.to)) return;
          const sd = sides[d];
          if (sd && sd.target && sd.target.vnum === ex.to) return;
          if (sides.some((x) => x && x.target && x.target.vnum === ex.to)) r.wrong++;
          else if (freeArch.has(`${v}>${ex.to}`)) r.corner++; else r.noDoor++;
        });
      }
    }
    for (const c of crossings(world, plan, r.layouts)) { const b = c.behind || c.named; if (b && (b.street || b.room !== undefined)) r.behind++; }
    return r;
  };
  const base = measure({});
  const t = measure(opts);
  const home = (r) => { const s = r.layouts.get('home').stats; return { pct: (100 * (s.alleys + s.stairs)) / (s.alleys + s.stairs + s.portals), arch: s.portals }; };
  let moved = 0;
  for (const c of base.layouts.get('home').cells.values()) { const d = t.layouts.get('home').cells.get(c.vnum); if (!d || d.x !== c.x || d.z !== c.z || d.level !== c.level) moved++; }
  const changed = [...base.pa.keys()].filter((f) => Math.abs(t.pa.get(f) - base.pa.get(f)) > 0.05).map((f) => `${f.replace('.are', '')} ${base.pa.get(f).toFixed(0)}->${t.pa.get(f).toFixed(0)}`);
  const line = (label, r) => `  ${label.padEnd(9)} per-area Midgaard ${r.midgaard.toFixed(1)}% mean ${r.mean.toFixed(2)}% | home ${home(r).pct.toFixed(1)}% walkable, ${home(r).arch} archways, shortcuts ${r.homeShortcut} (beside ${r.homeBeside}), raised streets ${r.homeBridges} | all zones: walkable ${r.walk} archways ${r.arch}, wrong walls ${r.wrong}, corner ${r.corner}, no door ${r.noDoor}, shortcuts ${r.shortcut} (beside ${r.beside}), raised streets ${r.bridges} | open air roofed ${r.roofed} | own ground behind a crossing ${r.behind}`;
  console.log(`trial ${name}:`);
  console.log(line('baseline', base));
  console.log(line(name, t));
  console.log(`  per-area changes: ${changed.length ? changed.join(', ') : 'none'}; home rooms moved: ${moved}`);
}

/**
 * The vertical dimension, measured: for every archway between two rooms on
 * one level, could a street run on the level above (a bridge) or below (a
 * tunnel) through cells that hold no room -- against simply allowing a
 * longer street on its own level; and how many exits miss their straight
 * cell only because an indoor room holds it while the target is indoor too
 * (the two could stack). A height change adds nothing to a cycle's
 * horizontal sum, so CLAUDE.md's seven residuals stay open whatever the
 * levels: what height can buy is free cells, and this is how many.
 */
function verticalReport() {
  const world = buildWorld(listed.map(read));
  const plan = planZones(world, {});
  const route = (L, from, to, level, MAX) => {
    const free = (x, z) => L.at(level, x, z) === undefined;
    const seen = new Set();
    let frontier = [];
    for (let d = 0; d < 4; d++) {
      const [dx, , dz] = DIR_STEP[d];
      const x = from.x + dx; const z = from.z + dz;
      if (!free(x, z)) continue;
      seen.add(`${x},${z}`); frontier.push({ x, z, n: 1 });
    }
    while (frontier.length) {
      const next = [];
      for (const node of frontier) {
        for (let d = 0; d < 4; d++) {
          const [dx, , dz] = DIR_STEP[d];
          const x = node.x + dx; const z = node.z + dz;
          if (x === to.x && z === to.z) return node.n;
          if (node.n >= MAX || seen.has(`${x},${z}`) || !free(x, z)) continue;
          seen.add(`${x},${z}`); next.push({ x, z, n: node.n + 1 });
        }
      }
      frontier = next;
    }
    return null;
  };
  const t = { arch: 0, same12: 0, same20: 0, bridge: 0, tunnel: 0, either: 0, vertical: 0, notStraight: 0, stackable: 0, stairsOpen: 0, rampable: 0 };
  for (const zone of plan.zones) {
    const L = layoutZone(world, plan, zone);
    const z = { arch: 0, same12: 0, bridge: 0, tunnel: 0, either: 0 };
    for (const l of L.links) {
      if (l.kind !== 'portal' || !l.to) continue;
      if (l.dir > 3 || l.from.level !== l.to.level) { t.vertical++; continue; }
      z.arch++;
      if (route(L, l.from, l.to, l.from.level, 12)) z.same12++;
      if (route(L, l.from, l.to, l.from.level, 20)) t.same20++;
      const up = route(L, l.from, l.to, l.from.level + 1, 6); const dn = route(L, l.from, l.to, l.from.level - 1, 6);
      if (up) z.bridge++; if (dn) z.tunnel++; if (up || dn) z.either++;
    }
    for (const k in z) t[k] += z[k];
    if (z.arch) console.log(`${zone.id.padEnd(10)} level archways ${String(z.arch).padStart(3)}  routable on its own level within 12: ${z.same12}  bridge within 6: ${z.bridge}  tunnel within 6: ${z.tunnel}  either: ${z.either}`);
    for (const c of L.cells.values()) {
      c.room.exits.forEach((e, d) => {
        if (!e || d > 3) return;
        const to = L.cells.get(e.to); if (!to || to === c) return;
        const [dx, , dz] = DIR_STEP[d];
        if (to.level === c.level && to.x === c.x + 2 * dx && to.z === c.z + 2 * dz) return;
        t.notStraight++;
        const holder = L.at(c.level, c.x + 2 * dx, c.z + 2 * dz);
        if (holder !== undefined && !openAir(to.room) && !openAir(world.rooms.get(holder))) t.stackable++;
      });
    }
    // Stairs off open ground: with `terrace` these become archways; the ones one level and one cell over could be a ramp.
    const T = layoutWorld(world, { startVnum: zone.start, maxRooms: zone.maxRooms, includeVnum: (v) => plan.zoneOf(v) === zone, roots: zone.arrivals, terrace: true });
    const was = new Map(L.links.map((l) => [`${l.from.vnum}:${l.dir}`, l.kind]));
    for (const l of T.links) {
      if (was.get(`${l.from.vnum}:${l.dir}`) !== 'stairs' || l.kind === 'stairs') continue;
      t.stairsOpen++;
      if (Math.abs(l.to.level - l.from.level) === 1 && Math.abs(l.to.x - l.from.x) + Math.abs(l.to.z - l.from.z) === 2) t.rampable++;
    }
  }
  console.log(`\nall zones: ${t.arch} archways between rooms on one level; a street within 12 on that level would carry ${t.same12}, within 20 ${t.same20};`
    + ` a bridge within 6 ${t.bridge}, a tunnel within 6 ${t.tunnel}, either ${t.either}; ${t.vertical} archways are ways up or down`);
  console.log(`exits not landing on their straight cell: ${t.notStraight}, of which ${t.stackable} have an indoor room on that cell with an indoor target (could stack on the level above)`);
  console.log(`stairs the terrace rule turns into archways: ${t.stairsOpen}, of which ${t.rampable} end one level and one cell over (a ramp, if build.js drew one)`);
}

let hard = 0;
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '-');
const fidelityLine = (f) => `exits ${String(f.exits).padStart(4)}  straight ${pct(f.straight, f.exits).padStart(5)}%  ahead ${pct(f.ahead, f.exits).padStart(5)}%`
  + `  sideways ${pct(f.sideways, f.exits).padStart(4)}%  behind ${pct(f.behind, f.exits).padStart(4)}%`
  + `  | both walls ${pct(f.bothWalls, f.exits).padStart(5)}%  one wrong ${pct(f.oneWall, f.exits).padStart(4)}%  archway ${pct(f.archway, f.exits).padStart(4)}%`;

if (trial) {
  runTrial(trial);
} else if (vertical) {
  verticalReport();
} else if (perArea) {
  const sum = { exits: 0, straight: 0, ahead: 0, sideways: 0, behind: 0, bothWalls: 0, oneWall: 0, archway: 0 };
  for (const file of listed) {
    const area = read(file);
    if (!area.rooms.length) continue;
    const world = buildWorld([area]);
    const layout = layoutWorld(world, { startVnum: area.rooms[0].vnum, maxRooms: 600 });
    const r = audit(world, layout);
    for (const k in sum) sum[k] += r.fidelity[k];
    console.log(`${file.padEnd(14)} ${fidelityLine(r.fidelity)}  streets crossing ${String(r.crossingsOfStreets).padStart(2)} (shortcuts ${r.shortcuts.length})  odd ${r.oddReciprocals}  folded ${r.folded}  open air sunk ${r.sunk}  stairs off open ground ${r.openStairs}  roofed ${r.roofed.length}${r.faults.length ? `  FAULTS ${r.faults.length}` : ''}`);
    for (const f of r.faults) { hard++; console.log(`    ${f}`); }
    for (const f of r.roofed) console.log(`    roofed open air      ${f}`);
  }
  console.log(`${'all areas'.padEnd(14)} ${fidelityLine(sum)}`);
} else {
  const world = buildWorld(listed.map(read));
  const plan = planZones(world, {});
  const layouts = new Map();
  for (const zone of plan.zones) layouts.set(zone.id, layoutZone(world, plan, zone));
  const sum = { exits: 0, straight: 0, ahead: 0, sideways: 0, behind: 0, bothWalls: 0, oneWall: 0, archway: 0 };
  const only = focus ? plan.zoneOf(focus) : null;
  if (focus && !only) throw new Error(`#${focus} is in no zone`);
  console.log(`${plan.zones.length} zones over ${listed.length} areas, ${plan.crossings.length} crossings\n`);
  let oddTotal = 0; let crossTotal = 0; let roofedTotal = 0; let shortcutTotal = 0; let besideTotal = 0;
  for (const zone of only ? [only] : plan.zones) {
    const layout = layouts.get(zone.id);
    const r = audit(world, layout, (v) => plan.zoneOf(v) === zone);
    for (const k in sum) sum[k] += r.fidelity[k];
    oddTotal += r.oddReciprocals; crossTotal += r.crossingsOfStreets;
    roofedTotal += r.roofed.length; shortcutTotal += r.shortcuts.length; besideTotal += r.beside;
    console.log(`${zone.id.padEnd(10)} rooms ${String(layout.cells.size).padStart(3)}  ${fidelityLine(r.fidelity)}  streets crossing ${String(r.crossingsOfStreets).padStart(2)} (shortcuts ${r.shortcuts.length}, beside open ground ${r.beside})  odd ${r.oddReciprocals}  folded ${r.folded}  open air sunk ${r.sunk}  stairs off open ground ${r.openStairs}  roofed ${r.roofed.length}${r.faults.length ? `  FAULTS ${r.faults.length}` : ''}`);
    for (const f of r.faults) { hard++; console.log(`    ${f}`); }
    for (const f of r.roofed) console.log(`    roofed open air      ${f}`);
    if (only) for (const f of r.shortcuts) console.log(`    shortcut crossing    ${f}`);
    if (only) for (const o of r.oddList) console.log(`    odd reciprocal      ${o}`);
  }
  console.log(`${'all zones'.padEnd(10)} ${''.padStart(10)} ${fidelityLine(sum)}  streets crossing ${crossTotal} (shortcuts ${shortcutTotal}, ceiling ${CEILING.shortcut}; beside open ground ${besideTotal})  odd reciprocals ${oddTotal}  roofed open air ${roofedTotal} (ceiling ${CEILING.roofed})`);
  if (!only && roofedTotal > CEILING.roofed) { hard++; console.log(`  roofed open air ${roofedTotal} is over the ceiling of ${CEILING.roofed}`); }
  if (!only && shortcutTotal > CEILING.shortcut) { hard++; console.log(`  shortcut crossings ${shortcutTotal} is over the ceiling of ${CEILING.shortcut}`); }

  console.log('\ncrossings: the wall each gate took, and what the same zone put behind it');
  const rows = crossings(world, plan, layouts).filter((c) => !only || c.fromZone === only.id || c.toZone === only.id);
  let behindCount = 0; let wrongWall = 0; let oneWayCount = 0; let backWrong = 0; let backBehind = 0;
  for (const c of rows) {
    const flags = [];
    if (!c.placed) flags.push('FROM ROOM NOT PLACED');
    if (!c.arrived) flags.push('ARRIVAL NOT PLACED');
    if (c.placed && c.dir <= 3 && c.side !== c.dir) { wrongWall++; flags.push(`gate on the ${c.side === null ? 'no' : DIR_NAME[c.side]} wall`); }
    const b = c.behind || c.named;
    if (b && (b.street || b.room !== undefined)) behindCount++;
    if (c.back < 0) { oneWayCount++; flags.push('one-way (no exit back)'); } else if (c.back !== REVERSE_DIR[c.dir]) flags.push(`back exit is ${DIR_NAME[c.back]}, not ${DIR_NAME[REVERSE_DIR[c.dir]]}`);
    if (c.back >= 0 && c.back <= 3 && c.arrived && c.backSide !== c.back) { backWrong++; flags.push(`return gate on the ${c.backSide === null ? 'no' : DIR_NAME[c.backSide]} wall`); }
    if (c.backBehind && (c.backBehind.street || c.backBehind.room !== undefined)) backBehind++;
    if (!only && !flags.length && !(b && (b.street || b.room !== undefined)) && !(c.backBehind && (c.backBehind.street || c.backBehind.room !== undefined))) continue;
    console.log(`  #${c.from} ${DIR_NAME[c.dir].padEnd(5)} -> #${c.to}  ${c.fromZone} -> ${c.toZone}${flags.length ? `  [${flags.join('; ')}]` : ''}`);
    if (b) console.log(`      behind the gate: ${describe(b)}`);
    if (c.backBehind) console.log(`      behind the way back (#${c.to} ${DIR_NAME[c.back]}): ${describe(c.backBehind)}`);
  }
  console.log(`  ${rows.length} crossings: ${behindCount} with a street or room of their own zone behind the gate, ${wrongWall} gates off the named wall,`
    + ` ${backWrong} return gates off the named wall, ${backBehind} with something behind the way back, ${oneWayCount} one-way`);

  if (!only) {
    console.log('\nload order: every zone laid out again with area.lst read backwards');
    const diffs = loadOrderDiff(listed, plan, layouts);
    if (!diffs.length) console.log('  identical: same cells, same streets, same walls');
    for (const d of diffs) { hard++; console.log(`  ${d}`); }

    const mid = midgaardCycles(read('midgaard.are'));
    console.log(`\nMidgaard alone: ${mid.whole.reachable} rooms reachable, ${mid.whole.edges} in-world edges, cycle space ${mid.whole.cycles}, ${mid.whole.open} cycles do not close`);
    console.log(`  with the seven exits CLAUDE.md names cut: ${mid.cut.cycles} cycles, ${mid.cut.open} open`);
    const midLayout = layoutWorld(buildWorld([read('midgaard.are')]), { startVnum: 3001, maxRooms: 600 });
    const s = midLayout.stats;
    console.log(`  layout: ${s.alleys} streets, ${s.stairs} stairs, ${s.portals} archways -> ${((100 * (s.alleys + s.stairs)) / (s.alleys + s.stairs + s.portals)).toFixed(0)}% walkable (CLAUDE.md: 93%, floor 7 archways)`);
  }
}

if (hard) console.log(`\n${hard} hard fault(s)`);
else console.log('\nno hard faults');
if (strict && hard) process.exit(1);
