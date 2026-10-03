/**
 * Turns the room graph into positions on an integer grid.
 *
 * A Diku world is not Euclidean: north-then-south does not have to bring you
 * back, and two rooms can happily claim the same spot. So we walk the graph
 * breadth-first from the temple, hand every room the cell its exit asks for,
 * and when that cell is taken we spiral outward for the nearest free one; then
 * relax the whole thing, spread it so every room has open ground around it, and
 * route each exit through that open ground as a street. What can't be routed
 * becomes an archway you step through. Nothing is dropped and nothing overlaps.
 */

import { DIR_STEP, REVERSE_DIR, SECTOR, ROOM_INDOORS } from './are.js';

const OUTDOOR_SECTORS = new Set([
  SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS,
  SECTOR.MOUNTAIN, SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT, SECTOR.AIR,
]);
const openToSky = (room) => OUTDOOR_SECTORS.has(room.sector) && !(room.flags & ROOM_INDOORS);

const key = (level, x, z) => `${level}:${x},${z}`;

/** Cells in rings around the origin, nearest first -- used to find a free spot. */
function spiralOffsets(radius) {
  const out = [];
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      if (x === 0 && z === 0) continue;
      out.push([x, z, Math.hypot(x, z)]);
    }
  }
  out.sort((a, b) => a[2] - b[2]);
  return out;
}
const SPIRAL = spiralOffsets(6);

/**
 * Breadth-first placement is greedy: the first room to claim a cell keeps it,
 * and everything discovered later has to work around that. This pass walks back
 * over the result and offers every room the free cells nearby, keeping any move
 * that joins up more exits than it breaks. A handful of sweeps is enough to
 * pull a district like Midgaard's park back onto its own street grid.
 */
function relax(world, cells, occupied, order, passes = 12, { terrace = false, reserved = new Set() } = {}) {
  const incoming = new Map();
  for (const cell of order) {
    for (let dir = 0; dir < 6; dir++) {
      const exit = cell.room.exits[dir];
      if (!exit || exit.offMap || !cells.has(exit.to)) continue;
      if (!incoming.has(exit.to)) incoming.set(exit.to, []);
      incoming.get(exit.to).push({ from: cell.vnum, dir });
    }
  }

  const satisfied = (cell, level, x, z) => {
    let score = 0;
    for (let dir = 0; dir < 6; dir++) {
      const exit = cell.room.exits[dir];
      if (!exit || exit.offMap) continue;
      const other = cells.get(exit.to);
      if (!other || other === cell) continue;
      const [dx, dl, dz] = DIR_STEP[dir];
      if (other.level === level + dl && other.x === x + dx && other.z === z + dz) score++;
    }
    for (const { from, dir } of incoming.get(cell.vnum) || []) {
      const other = cells.get(from);
      if (!other || other === cell) continue;
      const [dx, dl, dz] = DIR_STEP[dir];
      if (level === other.level + dl && x === other.x + dx && z === other.z + dz) score++;
    }
    return score;
  };

  const CANDIDATES = [[0, 0], ...SPIRAL.filter(([, , d]) => d <= 2.9)];
  let moved = 0;
  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    for (const cell of order) {
      // Standing on ground kept clear beyond a crossing costs half an exit,
      // so an equally good free cell nearby wins.
      const current = satisfied(cell, cell.level, cell.x, cell.z) - (reserved.has(key(cell.level, cell.x, cell.z)) ? 0.5 : 0);
      let best = null;
      let bestScore = current;
      for (const [ox, oz] of CANDIDATES) {
        if (ox === 0 && oz === 0) continue;
        const x = cell.x + ox;
        const z = cell.z + oz;
        if (occupied.has(key(cell.level, x, z)) || reserved.has(key(cell.level, x, z))) continue;
        if (cell.level > 0 && openToSky(cell.room)) {
          const below = occupied.get(key(cell.level - 1, x, z));
          if (below !== undefined && openToSky(world.rooms.get(below))) continue;
        }
        if (terrace) {
          const below = occupied.get(key(cell.level - 1, x, z));
          if (below !== undefined && openToSky(world.rooms.get(below))) continue;
          if (openToSky(cell.room) && occupied.has(key(cell.level + 1, x, z))) continue;
        }
        const score = satisfied(cell, cell.level, x, z) - Math.hypot(ox, oz) * 0.01;
        if (score > bestScore) { bestScore = score; best = [x, z]; }
      }
      if (!best) continue;
      occupied.delete(key(cell.level, cell.x, cell.z));
      cell.x = best[0];
      cell.z = best[1];
      occupied.set(key(cell.level, cell.x, cell.z), cell.vnum);
      changed++;
    }
    moved += changed;
    if (!changed) break;
  }
  return moved;
}

/**
 * Shortest run of empty cells from one room to another, preferring to set off
 * in the direction the exit claims to go, and refusing walls already spoken for
 * at either end.
 */
function routeShortest(from, to, nominalDir, occupied, MAX = 6, forbidFirst = new Set(), forbidLast = new Set(), blocked = new Set()) {
  const first = [nominalDir, ...[0, 1, 2, 3].filter((d) => d !== nominalDir)]
    .filter((d) => !forbidFirst.has(d));
  const queue = [{ x: from.x, z: from.z, cells: [], entryDir: null }];
  const seen = new Set([`${from.x},${from.z}`]);
  while (queue.length) {
    const node = queue.shift();
    if (node.cells.length >= MAX) continue;
    const dirs = node.entryDir === null ? first : [0, 1, 2, 3];
    for (const dir of dirs) {
      const [dx, , dz] = DIR_STEP[dir];
      const x = node.x + dx;
      const z = node.z + dz;
      if (x === to.x && z === to.z) {
        if (!node.cells.length || forbidLast.has(dir)) continue;
        return { cells: node.cells, entryDir: node.entryDir, exitDir: dir };
      }
      const seenKey = `${x},${z}`;
      if (seen.has(seenKey)) continue;
      if (occupied.has(key(from.level, x, z)) || blocked.has(key(from.level, x, z))) continue;
      seen.add(seenKey);
      queue.push({ x, z, cells: [...node.cells, { x, z }], entryDir: node.entryDir ?? dir });
    }
  }
  return null;
}

/**
 * Cheapest run of empty cells from one room to another, refusing walls
 * already spoken for at either end. A cell costs 1; so does leaving or
 * arriving through another wall than the one the exit names, and a wall
 * the room needs for one of its own exits costs 3 more, because taking it
 * is how that exit ended up with no door at all. A street two cells longer
 * that leaves north out of the north wall is the better street.
 * `cost(end, dir)` is that price for setting off (end 0) or arriving (end 1).
 */
function routePath(from, to, occupied, MAX = 6, cost = () => 0, blocked = new Set()) {
  // Breadth-first by length, but a state is the cell *and* the wall it left
  // by: the same cell reached out of two walls is two different routes.
  // Cells are kept as a chain back to the first, not copied at every step.
  let frontier = [];
  const seen = new Set();
  for (const dir of [0, 1, 2, 3]) {
    const c0 = cost(0, dir);
    if (c0 === Infinity) continue;
    const [dx, , dz] = DIR_STEP[dir];
    const x = from.x + dx; const z = from.z + dz;
    if ((x === to.x && z === to.z) || occupied.has(key(from.level, x, z)) || blocked.has(key(from.level, x, z))) continue;
    seen.add(`${x},${z},${dir}`);
    frontier.push({ x, z, back: null, entryDir: dir, c0 });
  }
  let best = null;
  for (let len = 1; len <= MAX && frontier.length; len++) {
    // Nothing longer can beat what is in hand: the ends cost nothing below 0.
    if (best && len >= best.score) break;
    const next = [];
    for (const node of frontier) {
      for (const dir of [0, 1, 2, 3]) {
        const [dx, , dz] = DIR_STEP[dir];
        const x = node.x + dx; const z = node.z + dz;
        if (x === to.x && z === to.z) {
          const c1 = cost(1, dir);
          if (c1 === Infinity) continue;
          const score = len + node.c0 + c1;
          if (!best || score < best.score) best = { score, node, entryDir: node.entryDir, exitDir: dir };
          continue;
        }
        if (len >= MAX) continue;
        const seenKey = `${x},${z},${node.entryDir}`;
        if (seen.has(seenKey) || occupied.has(key(from.level, x, z)) || blocked.has(key(from.level, x, z))) continue;
        seen.add(seenKey);
        next.push({ x, z, back: node, entryDir: node.entryDir, c0: node.c0 });
      }
    }
    frontier = next;
  }
  if (!best) return null;
  const cells = [];
  for (let n = best.node; n; n = n.back) cells.unshift({ x: n.x, z: n.z });
  return { score: best.score, cells, entryDir: best.entryDir, exitDir: best.exitDir };
}

/**
 * Areas laid down whole, as a block, after everything else is placed.
 *
 * Breadth-first placement grows every area outward from its anchor at once,
 * and two areas that hang off the same side of town share whatever ground is
 * there. The Dangerous Neighborhood and the Great Eastern Desert both leave
 * Midgaard eastward -- one through the East Gate, one down the river through
 * the wall -- and the mud's own distances put them on the same cells: laid
 * out together, the desert's river caves ran straight through the middle of
 * the neighborhood, its mountain stood between Yellow Dragon Road and
 * No Man's Land and its dunes came up to Bronze Dragon Street (measured:
 * 38 of the neighborhood's 72 rooms had one of the desert's rooms within
 * two cells).
 *
 * So the neighborhood is laid out on its own -- where it is 100% walkable --
 * and set down whole in the nearest free ground along its anchor, with one
 * empty ring round it. What that costs is the anchor: Wall Road becomes a
 * long street, which is what the mud says it is ("The road extends south
 * along the inside of the wall surrounding the city"). Nothing else moves:
 * every other area's placement is identical to the world without it.
 * Miden'nir is laid whole for the same reason: placed room by room it moved
 * 107 of Midgaard's rooms (the park, the river) to sit against both its
 * links; whole, nothing moves and the Dump's link south is the long one.
 */
const LAID_WHOLE = new Set(['hood.are', 'midennir.are']);

export function layoutWorld(world, options = {}) {
  const {
    startVnum = 3001,
    maxRooms = Infinity,
    includeVnum = () => true,
    // Rooms that must be placed even if the start cannot walk to them: where
    // a crossing from another zone arrives (zones.js). Each one the walk
    // missed is laid out with whatever it reaches and set down whole.
    roots = [],
    // Measurement options, all off by default and exercised only by
    // tools/planar-check.mjs --try: `terrace` never roofs open ground in
    // either direction (the default guards only the way up); `keepClear`
    // keeps the cells beyond a crossing into another zone free of rooms and
    // streets; `laidWhole` is the set of areas set down as a block;
    // `anchorReach` lets the street to a block laid whole run as far as
    // the block was set down.
    terrace = false,
    keepClear = false,
    laidWhole = LAID_WHOLE,
    anchorReach = true,
    // How many cells a street may wander: a maximum, never a target, since
    // routing is breadth-first by length. It was 6 from the first commit and
    // never measured; at 12 the home zone goes from 94.3% to 97.4% walkable
    // and wrong walls over all zones from 177 to 73, with no area losing a
    // passage (tools/planar-check.mjs --try reach=6 shows the way back).
    reach: reachDefault = 12,
  } = options;

  const cells = new Map();      // vnum -> {x, level, z, room}
  const occupied = new Map();   // grid key -> vnum
  const order = [];             // placement order, for deterministic building
  const reserved = new Set();   // grid keys kept clear beyond a crossing
  const reservations = [];      // { level, x, z, dx, dz } of the room each crossing leaves

  const start = world.rooms.get(startVnum) || world.rooms.values().next().value;
  if (!start) throw new Error('layout: the world has no rooms');

  const place = (room, level, x, z) => {
    const cell = { x, level, z, room, vnum: room.vnum };
    cells.set(room.vnum, cell);
    occupied.set(key(level, x, z), room.vnum);
    order.push(cell);
    if (keepClear) {
      for (let d = 0; d < 4; d++) {
        const exit = room.exits[d];
        if (!exit || exit.offMap || includeVnum(exit.to) || !world.rooms.has(exit.to)) continue;
        const [dx, , dz] = DIR_STEP[d];
        reservations.push({ level, x, z, dx, dz });
        // Reserved whether or not a room already stands there: relax() then
        // moves a room placed earlier off the ground the crossing wants.
        reserved.add(key(level, x + dx, z + dz));
      }
    }
    return cell;
  };

  place(start, 0, 0, 0);
  const queue = [start];

  // Anchors into a LAID_WHOLE area wait until the rest of the world is down.
  const waiting = [];
  let rest = false;
  const reach = new Map(); // anchor pair -> how long its street may be
  const pair = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;
  const layWhole = (room, target, dir, here) => {
    const file = target.areaFile;
    if (!laidWhole.has(file) || file === room.areaFile || dir > 3) return false;
    if (!rest) { if (!waiting.includes(room)) waiting.push(room); return true; }
    const sub = layoutWorld(world, {
      startVnum: target.vnum, compact: true,
      includeVnum: (v) => world.rooms.get(v)?.areaFile === file && includeVnum(v),
    });
    if (cells.size + sub.order.length > maxRooms) return false;
    const [dx, , dz] = DIR_STEP[dir];
    const clear = (ox, oz) => sub.order.every((c) => {
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) if (occupied.has(key(here.level + c.level, c.x + ox + a, c.z + oz + b))) return false;
      }
      return true;
    });
    // Out along the anchor first, then sideways, nearest first.
    for (let far = 0; far < 40; far++) {
      for (let along = 0; along <= far; along++) {
        const side = far - along;
        for (const sign of side ? [1, -1] : [1]) {
          const ox = here.x + dx * (1 + along) - dz * side * sign;
          const oz = here.z + dz * (1 + along) + dx * side * sign;
          if (!clear(ox, oz)) continue;
          for (const c of sub.order) { place(c.room, here.level + c.level, c.x + ox, c.z + oz); queue.push(c.room); }
          if (anchorReach) reach.set(pair(room.vnum, target.vnum), 2 * far + 12);
          return true;
        }
      }
    }
    return false;
  };

  for (;;) {
    while (queue.length && cells.size < maxRooms) {
      const room = queue.shift();
      const here = cells.get(room.vnum);

      for (let dir = 0; dir < 6; dir++) {
        const exit = room.exits[dir];
        if (!exit || exit.offMap) continue;
        const target = world.rooms.get(exit.to);
        if (!target || cells.has(target.vnum) || !includeVnum(target.vnum)) continue;
        if (cells.size >= maxRooms) break;

        const [dx, dl, dz] = DIR_STEP[dir];
        // A room hung directly over a street turns that street into a tunnel.
        // Anything reached by going up from open ground -- Midgaard's "In the
        // air..." rooms above all -- is pushed clear of the roofs instead.
        const airborne = dl > 0 && openToSky(room);
        const level = here.level + (airborne ? Math.max(dl, 3) : dl);
        const wantX = here.x + dx;
        const wantZ = here.z + dz;

        const shadesStreet = (l, x, z) => {
          const below = occupied.get(key(l - 1, x, z));
          return below !== undefined && openToSky(world.rooms.get(below));
        };

        /**
         * How many of this room's own exits would land on a real neighbour if it
         * stood here. Placing for the best score rather than for the first free
         * cell is what keeps streets joined up instead of scattering archways.
         */
        const fit = (x, z) => {
          let satisfied = (x === wantX && z === wantZ) ? 1 : 0;
          for (let d = 0; d < 4; d++) {
            const other = target.exits[d];
            if (!other || other.offMap) continue;
            const placed = cells.get(other.to);
            if (!placed || placed.level !== level) continue;
            const [ox, , oz] = DIR_STEP[d];
            if (placed.x === x + ox && placed.z === z + oz) satisfied++;
          }
          return satisfied;
        };

        if (layWhole(room, target, dir, here)) continue;
        let best = null;
        let bestScore = -Infinity;
        const candidates = [[0, 0], ...SPIRAL];
        for (const [ox, oz] of candidates) {
          const drift = Math.hypot(ox, oz);
          if (drift > 3.2) break;
          const x = wantX + ox;
          const z = wantZ + oz;
          if (occupied.has(key(level, x, z)) || reserved.has(key(level, x, z))) continue;
          if (airborne && shadesStreet(level, x, z)) continue;
          // Open ground is never roofed: not by a room reached by going
          // down from it, nor by landing open ground under something.
          if (terrace && (shadesStreet(level, x, z) || (openToSky(target) && occupied.has(key(level + 1, x, z))))) continue;
          const backwards = (ox * dx + oz * dz) < 0 ? 0.6 : 0;
          const score = fit(x, z) * 2 - drift * 0.45 - backwards;
          if (score > bestScore) { bestScore = score; best = [x, z]; }
        }
        if (!best) continue; // nowhere within reach; the room stays unplaced
        place(target, level, best[0], best[1]);
        queue.push(target);
      }
    }
    if (rest || !waiting.length) break;
    rest = true;
    queue.push(...waiting);
  }

  // The parts of a zone its start cannot reach -- the High Tower's crossings
  // land in rooms its first room never walks to -- each laid out on its own
  // and set down east of everything placed, one empty ring clear, so nothing
  // already placed moves.
  for (const root of roots) {
    if (cells.has(root) || !world.rooms.has(root) || !includeVnum(root)) continue;
    const sub = layoutWorld(world, {
      startVnum: root, compact: true, includeVnum: (v) => includeVnum(v) && !cells.has(v),
    });
    if (cells.size + sub.order.length > maxRooms) continue;
    let eastmost = -Infinity;
    for (const c of cells.values()) eastmost = Math.max(eastmost, c.x);
    let westmost = Infinity;
    for (const c of sub.order) westmost = Math.min(westmost, c.x);
    const ox = eastmost + 3 - westmost;
    const clear = (oz) => sub.order.every((c) => {
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) if (occupied.has(key(c.level, c.x + ox + a, c.z + oz + b))) return false;
      }
      return true;
    });
    for (let far = 0; far < 200; far++) {
      const oz = far % 2 ? (far + 1) / 2 : -far / 2;
      if (!clear(oz)) continue;
      for (const c of sub.order) place(c.room, c.level, c.x + ox, c.z + oz);
      break;
    }
  }

  relax(world, cells, occupied, order, 12, { terrace, reserved });
  if (options.compact) return { order };

  // Spread the grid: rooms keep the even coordinates and every cell between
  // them becomes routable. That is what turns "the shop is one step north" into
  // a street with a frontage rather than two boxes pushed together.
  occupied.clear();
  for (const cell of cells.values()) {
    cell.x *= 2;
    cell.z *= 2;
    occupied.set(key(cell.level, cell.x, cell.z), cell.vnum);
  }
  // The ground beyond a crossing, spread: the cell past the gate wall and
  // the room cell beyond it, kept out of every street.
  const blocked = new Set();
  for (const r of reservations) {
    blocked.add(key(r.level, 2 * r.x + r.dx, 2 * r.z + r.dz));
    blocked.add(key(r.level, 2 * r.x + 2 * r.dx, 2 * r.z + 2 * r.dz));
  }

  // Classify every exit of every placed room.
  const links = [];
  const seen = new Map();
  for (const cell of order) {
    for (let dir = 0; dir < 6; dir++) {
      const exit = cell.room.exits[dir];
      if (!exit) continue;

      const targetCell = cells.get(exit.to);
      if (!targetCell) {
        links.push({ from: cell, to: null, dir, exit, kind: 'gate' });
        continue;
      }

      const [dx, dl, dz] = DIR_STEP[dir];
      const adjacent = dir > 3 && targetCell.level === cell.level + dl
        && targetCell.x === cell.x + dx && targetCell.z === cell.z + dz;
      const kind = adjacent ? 'stairs' : 'portal';

      // A passage described from both ends is one passage.
      const pairKey = `${Math.min(cell.vnum, targetCell.vnum)}-${Math.max(cell.vnum, targetCell.vnum)}-${Math.min(dir, REVERSE_DIR[dir])}`;
      const twin = seen.get(pairKey);
      if (twin && twin.kind === kind && twin.to === cell) {
        twin.twoWay = true;
        twin.exitBack = exit;
        continue;
      }

      const link = { from: cell, to: targetCell, dir, exit, kind, twoWay: false };
      links.push(link);
      seen.set(pairKey, link);
    }
  }

  // Every horizontal link now has to be walked through the cells between the
  // two rooms, and every passage needs a wall to come out of. Sides are handed
  // out here, once, so a room can never be asked to put two doors in one wall.
  //
  // Handed out a few ways (`allocate`), and the way that keeps the most
  // passages walkable wins, then the one leaving fewest exits without a door
  // of their own, then the fewest on the wrong wall. Greedy allocation is
  // order-dependent and no one order is best everywhere: the cheapest-wall
  // first pass fixes most of the Mud School and loses a street in the desert,
  // the shortest-route first pass the other way round. Same input, same
  // order of trials, same answer: deterministic, as a server and every client
  // must agree.
  const kinds = links.map((l) => l.kind);

  // Which walls a room's own exits name. A wall that one exit names is no
  // place for another exit's door, or for a staircase: the old order handed
  // the Mud School's Center Room its west wall for the stair up, and its
  // west exit was left with no wall at all -- and the room beyond it, which
  // had only that exit, with no door.
  // A one-way exit into a room names a wall of that room too: the Mud
  // School's entrance goes south into the arena's north wall, and the stair
  // up out of the arena had taken it.
  const arriving = new Set();
  for (const cell of order) {
    for (let d = 0; d < 4; d++) {
      const exit = cell.room.exits[d];
      if (exit && cells.has(exit.to) && exit.to !== cell.vnum) arriving.add(`${exit.to}:${REVERSE_DIR[d]}`);
    }
  }
  const wanted = (vnum, dir) => dir <= 3 && (!!cells.get(vnum).room.exits[dir] || arriving.has(`${vnum}:${dir}`));

  // Whether the exit through this wall leads to the room the grid put right
  // there, on the same level -- the exit that is surest to become a street.
  const straight = (cell, dir) => {
    const exit = cell.room.exits[dir];
    const there = exit && cells.get(exit.to);
    const [dx, , dz] = DIR_STEP[dir];
    return !!there && there.level === cell.level && there.x === cell.x + 2 * dx && there.z === cell.z + 2 * dz;
  };

  const allocate = (firstPass, stairRule) => {
    links.forEach((l, i) => {
      l.kind = kinds[i];
      delete l.path; delete l.entryDir; delete l.exitDir; delete l.side; delete l.backSide;
    });
    const sides = new Map();
    for (const cell of order) sides.set(cell.vnum, [null, null, null, null]);
    const free = (vnum, dir) => dir <= 3 && !sides.get(vnum)[dir];
    const claim = (vnum, dir, entry) => {
      if (!free(vnum, dir)) return false;
      sides.get(vnum)[dir] = entry;
      return true;
    };

    // A staircase runs along one wall, so that wall can't also hold a door.
    // A wall no exit names, first; failing that (`stairRule` 'bent') a wall
    // whose exit was not going to be a straight street anyway, or none --
    // and then the flight is an archway up or down standing in the room.
    const stairSide = new Map();
    for (const link of links) {
      if (link.kind !== 'stairs') continue;
      const lower = link.dir === 4 ? link.from : link.to;
      // 'legacy' is the order this always used: west, east, north, south,
      // whatever they hold. Kept as a trial so no layout can come out with
      // fewer walkable passages than it had before.
      const ok = stairRule === 'legacy' ? [() => true] : [
        (d) => !wanted(lower.vnum, d),
        (d) => stairRule !== 'strict' && !straight(lower, d),
      ];
      let dir;
      for (const test of ok) {
        dir = [3, 1, 0, 2].find((d) => free(lower.vnum, d) && test(d));
        if (dir !== undefined) break;
      }
      if (dir === undefined) { link.kind = 'portal'; continue; }
      claim(lower.vnum, dir, { kind: 'stair', link });
      stairSide.set(link, dir);
    }

    // What a street costs to leave or arrive through a wall, on top of its
    // length (see `routePath`).
    const routeCost = (link) => {
      const ends = [link.from, link.to];
      return (end, dir) => {
        const room = ends[end];
        const wall = end === 0 ? dir : REVERSE_DIR[dir];
        if (!free(room.vnum, wall)) return Infinity;
        let c = dir === link.dir ? 0 : 1;
        // Another exit of this room names this wall. The exit this link walks
        // is the one at `from`; at `to` it names the wall it arrives through,
        // whether or not there is a way back.
        const mine = end === 0 ? link.dir : REVERSE_DIR[link.dir];
        if (wall !== mine && wanted(room.vnum, wall)) c += 3;
        return c;
      };
    };
    // The far end of a one-way exit is an opening the mud will not let you
    // back through: build.js shuts it with a gate that opens only from the
    // side that has the exit. A room with any exit back (by another
    // direction, along a passage of its own) is not one-way.
    const oneWay = (link) => !link.to.room.exits.some((e) => e && e.to === link.from.vnum);
    const alleyEnd = (link, end) => (end === 0
      ? { kind: 'alley', link, exit: link.exit, target: link.to }
      : { kind: 'alley', link, exit: link.exitBack || null, target: link.from, oneWay: oneWay(link) });
    const lay = (link, route) => {
      link.kind = 'alley';
      link.path = route.cells;
      link.entryDir = route.entryDir;
      link.exitDir = route.exitDir;
      claim(link.from.vnum, route.entryDir, alleyEnd(link, 0));
      claim(link.to.vnum, REVERSE_DIR[route.exitDir], alleyEnd(link, 1));
    };
    const reachOf = (link) => reach.get(pair(link.from.vnum, link.to.vnum)) || reachDefault;
    const level = (link) => link.kind === 'portal' && link.to && link.from.level === link.to.level;

    // First pass: which exits become streets, greedily in link order --
    // by the shortest route, as it always was, or by the cheapest.
    const streets = [];
    for (const link of links) {
      if (!level(link)) continue;
      let route;
      if (firstPass === 'shortest') {
        const forbidFirst = new Set([0, 1, 2, 3].filter((d) => !free(link.from.vnum, d)));
        const forbidLast = new Set([0, 1, 2, 3].filter((d) => !free(link.to.vnum, REVERSE_DIR[d])));
        route = routeShortest(link.from, link.to, link.dir, occupied, reachOf(link), forbidFirst, forbidLast, blocked);
      } else {
        route = routePath(link.from, link.to, occupied, reachOf(link), routeCost(link), blocked);
      }
      if (!route) continue;
      lay(link, route);
      streets.push(link);
    }
    // Then where each street leaves and arrives: each is taken up in turn
    // and laid again at the cheapest cost with every other claim standing.
    // Its old route is always still there, so no street is ever lost; and a
    // wall one frees can let an exit that found no route become a street.
    for (let pass = 0; pass < 4; pass++) {
      let better = 0;
      for (const link of links) {
        if (!level(link)) continue;
        const route = routePath(link.from, link.to, occupied, reachOf(link), routeCost(link), blocked);
        if (!route) continue;
        lay(link, route);
        streets.push(link);
        better++;
      }
      for (const link of streets) {
        // Straight out of the wall it names, into the wall it names, as short
        // as the grid allows: nothing to improve.
        const shortest = Math.abs(link.to.x - link.from.x) + Math.abs(link.to.z - link.from.z) - 1;
        if (link.entryDir === link.dir && link.exitDir === link.dir && link.path.length === shortest) continue;
        const cost = routeCost(link);
        sides.get(link.from.vnum)[link.entryDir] = null;
        sides.get(link.to.vnum)[REVERSE_DIR[link.exitDir]] = null;
        const now = link.path.length + cost(0, link.entryDir) + cost(1, link.exitDir);
        const route = routePath(link.from, link.to, occupied, reachOf(link), cost, blocked);
        if (route && route.score < now) {
          lay(link, route);
          better++;
        } else {
          claim(link.from.vnum, link.entryDir, alleyEnd(link, 0));
          claim(link.to.vnum, REVERSE_DIR[link.exitDir], alleyEnd(link, 1));
        }
      }
      if (!better) break;
    }

    // Whatever is left is an archway: a door onto somewhere the grid can't
    // reach. The wall the exit names, else one no other exit of the room
    // names, else any free one, else none -- an arch free-standing in the
    // room. Level archways first, so a way up or down does not take the wall
    // a level exit was about to need.
    const wallFor = (vnum, dir) => {
      if (dir <= 3 && free(vnum, dir)) return dir;
      const spare = [0, 1, 2, 3].find((d) => free(vnum, d) && !wanted(vnum, d));
      if (spare !== undefined) return spare;
      const any = [0, 1, 2, 3].find((d) => free(vnum, d));
      return any === undefined ? null : any;
    };
    const archways = links.filter((l) => l.kind === 'portal' || l.kind === 'gate');
    for (const link of [...archways.filter((l) => l.dir <= 3), ...archways.filter((l) => l.dir > 3)]) {
      const side = wallFor(link.from.vnum, link.dir);
      link.side = side;
      // A way up or down on a wall is a ladder or a shaft against it, not a
      // doorway through it: build.js leaves that wall solid.
      const kind = link.kind === 'portal' && link.dir > 3 ? 'shaft' : link.kind;
      if (side !== null) claim(link.from.vnum, side, { kind, link, exit: link.exit, target: link.to });
      // A level archway described from both ends is an archway at both ends.
      // It used to be drawn only where it was placed from, so the room at the
      // other end had a wall where its exit should be.
      if (link.kind !== 'portal' || !link.to || !link.twoWay || link.dir > 3) continue;
      const back = wallFor(link.to.vnum, REVERSE_DIR[link.dir]);
      link.backSide = back;
      if (back !== null) claim(link.to.vnum, back, { kind: 'portal', link, exit: link.exitBack, target: link.from });
    }

    // The score: walkable links, then exits with no door, then wrong walls.
    let walkable = 0;
    for (const link of links) if (link.kind === 'alley' || link.kind === 'stairs') walkable++;
    let doorless = 0; let wrong = 0;
    for (const cell of order) {
      const own = sides.get(cell.vnum);
      for (let d = 0; d < 4; d++) {
        const exit = cell.room.exits[d];
        if (!exit || !cells.has(exit.to)) continue;
        if (own[d] && own[d].target && own[d].target.vnum === exit.to) continue;
        if (own.some((x) => x && x.target && x.target.vnum === exit.to)) wrong++;
        else doorless++;
      }
    }
    return {
      sides, stairSide, score: [walkable, -doorless, -wrong],
      state: links.map((l) => ({ kind: l.kind, path: l.path, entryDir: l.entryDir, exitDir: l.exitDir, side: l.side, backSide: l.backSide })),
    };
  };

  // Lexicographic, and a tie keeps the earlier trial.
  const ahead = (a, b) => {
    const i = a.findIndex((v, k) => v !== b[k]);
    return i >= 0 && a[i] > b[i];
  };
  // Over all 34 zones and 43 areas alone, these five are the only ones that
  // ever win ('shortest'/'legacy' never has, and is kept so that no layout
  // can lose a walkable passage to this).
  let best = null;
  for (const [firstPass, stairRule] of [['shortest', 'strict'], ['cheapest', 'strict'], ['cheapest', 'bent'],
    ['cheapest', 'legacy'], ['shortest', 'legacy']]) {
    const trial = allocate(firstPass, stairRule);
    if (!best || ahead(trial.score, best.score)) best = trial;
  }
  links.forEach((l, i) => {
    const st = best.state[i];
    l.kind = st.kind;
    for (const k of ['path', 'entryDir', 'exitDir', 'side', 'backSide']) {
      if (st[k] === undefined) delete l[k]; else l[k] = st[k];
    }
  });
  const { sides, stairSide } = best;
  const pathCells = new Set();
  const pathOwner = new Map(); // which passage runs through this cell
  for (const link of links) {
    if (link.kind !== 'alley') continue;
    for (const c of link.path) {
      pathCells.add(key(link.from.level, c.x, c.z));
      pathOwner.set(key(link.from.level, c.x, c.z), link);
    }
  }

  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  let minLevel = Infinity; let maxLevel = -Infinity;
  for (const cell of cells.values()) {
    minX = Math.min(minX, cell.x); maxX = Math.max(maxX, cell.x);
    minZ = Math.min(minZ, cell.z); maxZ = Math.max(maxZ, cell.z);
    minLevel = Math.min(minLevel, cell.level); maxLevel = Math.max(maxLevel, cell.level);
  }

  const stats = {
    placed: cells.size,
    alleys: links.filter((l) => l.kind === 'alley').length,
    stairs: links.filter((l) => l.kind === 'stairs').length,
    portals: links.filter((l) => l.kind === 'portal').length,
    gates: links.filter((l) => l.kind === 'gate').length,
  };

  return {
    cells, links, order, pathCells, sides, stairSide, start: cells.get(start.vnum),
    bounds: { minX, maxX, minZ, maxZ, minLevel, maxLevel },
    stats,
    /** Which room, if any, sits in this cell. */
    at: (level, x, z) => occupied.get(key(level, x, z)),
    /** Is this cell part of a routed passage? */
    isPath: (level, x, z) => pathCells.has(key(level, x, z)),
    /** Which passage runs through this cell, if any. */
    passageAt: (level, x, z) => pathOwner.get(key(level, x, z)),
  };
}
