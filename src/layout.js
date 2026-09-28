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
function relax(world, cells, occupied, order, passes = 12) {
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
      const current = satisfied(cell, cell.level, cell.x, cell.z);
      let best = null;
      let bestScore = current;
      for (const [ox, oz] of CANDIDATES) {
        if (ox === 0 && oz === 0) continue;
        const x = cell.x + ox;
        const z = cell.z + oz;
        if (occupied.has(key(cell.level, x, z))) continue;
        if (cell.level > 0 && openToSky(cell.room)) {
          const below = occupied.get(key(cell.level - 1, x, z));
          if (below !== undefined && openToSky(world.rooms.get(below))) continue;
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
function routePath(from, to, nominalDir, occupied, MAX = 6, forbidFirst = new Set(), forbidLast = new Set(), avoid = null) {
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
      if (occupied.has(key(from.level, x, z))) continue;
      if (avoid && avoid.has(key(from.level, x, z))) continue;
      seen.add(seenKey);
      queue.push({ x, z, cells: [...node.cells, { x, z }], entryDir: node.entryDir ?? dir });
    }
  }
  return null;
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
 */
const LAID_WHOLE = new Set(['hood.are']);

/**
 * Whether a room is open to the sky, as far as its passages go: the same
 * test build.js makes before it walls and roofs a corridor, reduced to what
 * the mud's flags and sector say (build.js also reads the prose).
 */
const OPEN_SECTORS = new Set([SECTOR.CITY, SECTOR.FIELD, SECTOR.FOREST, SECTOR.HILLS, SECTOR.MOUNTAIN,
  SECTOR.WATER_SWIM, SECTOR.WATER_NOSWIM, SECTOR.DESERT]);
const openAir = (room) => OPEN_SECTORS.has(room.sector) && !(room.flags & ROOM_INDOORS);

export function layoutWorld(world, options = {}) {
  const {
    startVnum = 3001,
    maxRooms = Infinity,
    includeVnum = () => true,
  } = options;

  const cells = new Map();      // vnum -> {x, level, z, room}
  const occupied = new Map();   // grid key -> vnum
  const order = [];             // placement order, for deterministic building

  const start = world.rooms.get(startVnum) || world.rooms.values().next().value;
  if (!start) throw new Error('layout: the world has no rooms');

  const place = (room, level, x, z) => {
    const cell = { x, level, z, room, vnum: room.vnum };
    cells.set(room.vnum, cell);
    occupied.set(key(level, x, z), room.vnum);
    order.push(cell);
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
    if (!LAID_WHOLE.has(file) || file === room.areaFile || dir > 3) return false;
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
          reach.set(pair(room.vnum, target.vnum), 2 * far + 12);
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
          if (occupied.has(key(level, x, z))) continue;
          if (airborne && shadesStreet(level, x, z)) continue;
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

  relax(world, cells, occupied, order);
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
  const sides = new Map();
  for (const cell of order) sides.set(cell.vnum, [null, null, null, null]);
  const free = (vnum, dir) => dir <= 3 && !sides.get(vnum)[dir];
  const claim = (vnum, dir, entry) => {
    if (!free(vnum, dir)) return false;
    sides.get(vnum)[dir] = entry;
    return true;
  };

  // A staircase runs along one wall, so that wall can't also hold a door.
  const stairSide = new Map();
  for (const link of links) {
    if (link.kind !== 'stairs') continue;
    const lower = link.dir === 4 ? link.from : link.to;
    const dir = [3, 1, 0, 2].find((d) => free(lower.vnum, d));
    if (dir === undefined) { link.kind = 'portal'; continue; }
    claim(lower.vnum, dir, { kind: 'stair', link });
    stairSide.set(link, dir);
  }

  const pathCells = new Set();
  const pathOwner = new Map(); // which passage runs through this cell
  // Two passages may share a cell, but not a street and a corridor: the
  // corridor between two buildings is walled and roofed, and where it
  // crossed an open street it stood a wall across it -- ten cells in the
  // nine default areas, nine of them in Midgaard. Each kind keeps off the
  // other's cells where it can, and shares where there is no other way.
  const walled = { true: new Set(), false: new Set() };
  for (const link of links) {
    if (link.kind !== 'portal' || !link.to) continue;
    if (link.from.level !== link.to.level) continue;
    const forbidFirst = new Set([0, 1, 2, 3].filter((d) => !free(link.from.vnum, d)));
    const forbidLast = new Set([0, 1, 2, 3].filter((d) => !free(link.to.vnum, REVERSE_DIR[d])));
    const enclosed = !openAir(link.from.room) && !openAir(link.to.room);
    const reachOf = reach.get(pair(link.from.vnum, link.to.vnum)) || 6;
    const route = routePath(link.from, link.to, link.dir, occupied, reachOf, forbidFirst, forbidLast, walled[!enclosed])
      || routePath(link.from, link.to, link.dir, occupied, reachOf, forbidFirst, forbidLast);
    if (!route) continue;
    for (const c of route.cells) walled[enclosed].add(key(link.from.level, c.x, c.z));
    link.kind = 'alley';
    link.path = route.cells;
    link.entryDir = route.entryDir;
    link.exitDir = route.exitDir;
    claim(link.from.vnum, route.entryDir, { kind: 'alley', link, exit: link.exit, target: link.to });
    claim(link.to.vnum, REVERSE_DIR[route.exitDir], { kind: 'alley', link, exit: link.exitBack || null, target: link.from });
    for (const c of route.cells) {
      pathCells.add(key(link.from.level, c.x, c.z));
      pathOwner.set(key(link.from.level, c.x, c.z), link);
    }
  }

  // Whatever is left is an archway: a door onto somewhere the grid can't reach.
  for (const link of links) {
    if (link.kind !== 'portal' && link.kind !== 'gate') continue;
    const entry = { kind: link.kind, link, exit: link.exit, target: link.to };
    if (link.dir <= 3 && claim(link.from.vnum, link.dir, entry)) { link.side = link.dir; continue; }
    const spare = [0, 1, 2, 3].find((d) => free(link.from.vnum, d));
    if (spare !== undefined) { claim(link.from.vnum, spare, entry); link.side = spare; }
    else link.side = null; // free-standing, in the middle of the room
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
