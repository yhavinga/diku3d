/**
 * What a floor's height is, at a point: the one place that says so.
 *
 * A platform (`build.js` `addPlatform`) is a rectangle with a `top`. A *ramp*
 * is a rectangle whose top is a plane, `slope: { top0, ax, az }` -- the height
 * at the rectangle's (x0, z0) corner and the rise per metre along x and z.
 * Every reader of a platform's height asks `topAt`, so a ramp is as true to
 * the player, the camera, the mobiles' grid and the tools as a flat floor is.
 * `top` stays the highest the platform gets, which is what a reader that only
 * needs an upper bound (a sort, a filter) keeps using.
 *
 * Also here, pure and without three.js so that the server can use it: the
 * terraces and the inclines. The temple stands on its mound; the square below
 * its steps is the first tier down (`TERRACE_LIFT`), level, as a square must
 * be; and the streets that leave it for lower ground are ramps of a few
 * degrees, one plane each cell, instead of steps. build.js lays them, and
 * the server's `liftAt` takes the same heights for a body on one, so a page
 * and a server agree on where the floor is.
 */

export const CELL = 13;
const HALF = CELL / 2;
/** The square under the temple's mound stands this high over its level. */
export const TERRACE_LIFT = 0.6;

/**
 * The height of platform `p` at (x, z). A point off the rectangle is taken
 * at the nearest point on it, which is how player.js has always read a
 * platform within a body's radius.
 */
export function topAt(p, x, z) {
  const s = p.slope;
  if (!s) return p.top;
  const cx = x < p.x0 ? p.x0 : x > p.x1 ? p.x1 : x;
  const cz = z < p.z0 ? p.z0 : z > p.z1 ? p.z1 : z;
  return s.top0 + s.ax * (cx - p.x0) + s.az * (cz - p.z0);
}

/** The lowest a platform gets. */
export const lowAt = (p) => (p.slope ? p.slope.low ?? p.top : p.top);

/**
 * The plane through a rectangle for a rise `dh` over `along` metres in
 * direction (dx, dz), the height at the rectangle's (x0, z0) corner being
 * `top0`. Returns what a platform's `slope` holds, with the platform's own
 * highest and lowest points.
 */
export function planeOf(rect, top0, ax, az) {
  const hi = Math.max(top0, top0 + ax * (rect.x1 - rect.x0), top0 + az * (rect.z1 - rect.z0), top0 + ax * (rect.x1 - rect.x0) + az * (rect.z1 - rect.z0));
  const lo = Math.min(top0, top0 + ax * (rect.x1 - rect.x0), top0 + az * (rect.z1 - rect.z0), top0 + ax * (rect.x1 - rect.x0) + az * (rect.z1 - rect.z0));
  return { slope: { top0, ax, az, low: lo }, top: hi };
}

/**
 * Raise the open-air room a mound's steps come down to by `TERRACE_LIFT`:
 * "huge marble steps lead up to the temple gate" from the square, which is
 * the first tier of the hill. `lifts` already holds the mound's rooms;
 * `openAir(vnum)` is the caller's own answer (build.js's by the walls, the
 * server's by the sector). Only on a level with nothing above the room.
 */
export function addTerraces(world, layout, lifts, openAir, MOUND_LIFT) {
  for (const [vnum, lift] of [...lifts]) {
    if (lift !== MOUND_LIFT) continue;
    const room = world.rooms.get(vnum);
    const cell = layout.cells.get(vnum);
    if (!room || !cell) continue;
    for (const e of room.exits.slice(0, 4)) {
      if (!e || e.offMap) continue;
      const next = world.rooms.get(e.to);
      const c = next && layout.cells.get(next.vnum);
      if (!c || c.level !== cell.level || lifts.has(next.vnum) || !openAir(next.vnum)) continue;
      if (layout.at(c.level + 1, c.x, c.z) !== undefined) continue;
      lifts.set(next.vnum, TERRACE_LIFT);
    }
  }
  return lifts;
}

/**
 * The streets that run from a terrace down to lower ground: for every cell of
 * such a street, the plane it lies in. A street joins two rooms whose lifts
 * differ, the higher of them out of doors (a terrace); between the two it
 * climbs at one grade along the whole of its length, level with each room at
 * its edge. Only straight runs: a bend has no one direction to climb in.
 * Returns Map "level:x,z" -> { level, x, z, link, hA, hB, n, dx, dz, a: {x, z} }
 * where `a` is the room the street starts from, `hA`/`hB` the lifts at the
 * ends, n the number of cells, (dx, dz) the step from one cell to the next.
 */
export function inclines(layout, lifts, openAir) {
  const out = new Map();
  for (const link of layout.links) {
    if (link.kind !== 'alley' || !link.to || !link.path || !link.path.length) continue;
    const hA = lifts.get(link.from.vnum) || 0; const hB = lifts.get(link.to.vnum) || 0;
    if (hA === hB || hA < 0 || hB < 0) continue;
    if (!openAir(hA > hB ? link.from.vnum : link.to.vnum)) continue;
    const chain = [link.from, ...link.path, link.to];
    const dx = Math.sign(chain[1].x - chain[0].x); const dz = Math.sign(chain[1].z - chain[0].z);
    for (let i = 1; i < chain.length; i++) {
      if (Math.sign(chain[i].x - chain[i - 1].x) !== dx || Math.sign(chain[i].z - chain[i - 1].z) !== dz
        || Math.abs(chain[i].x - chain[i - 1].x) + Math.abs(chain[i].z - chain[i - 1].z) !== 1) {
        throw new Error(`surface: the street #${link.from.vnum} to #${link.to.vnum} climbs between rooms of different height but is not a straight run (cell ${i})`);
      }
    }
    const n = link.path.length;
    link.path.forEach((c) => {
      out.set(`${link.from.level}:${c.x},${c.z}`, { level: link.from.level, x: c.x, z: c.z, link, hA, hB, n, dx, dz, a: { x: link.from.x, z: link.from.z } });
    });
  }
  return out;
}

/**
 * How high the floor of an incline's street stands over its level at
 * (x, z), world metres: linear from room A's cell edge to room B's.
 */
export function inclineLift(inc, x, z) {
  const s = ((x - inc.a.x * CELL) * inc.dx + (z - inc.a.z * CELL) * inc.dz) / CELL;
  const t = Math.min(1, Math.max(0, (s - 0.5) / inc.n));
  return inc.hA + (inc.hB - inc.hA) * t;
}

/**
 * The plane of one cell of an incline, as `planeOf` gives it for the cell's
 * rectangle: `base` the level's height. The rectangle is the whole cell.
 */
export function inclineCell(inc, base) {
  const cx = inc.x * CELL; const cz = inc.z * CELL;
  const rect = { x0: cx - HALF, x1: cx + HALF, z0: cz - HALF, z1: cz + HALF };
  const rise = (inc.hB - inc.hA) / inc.n / CELL;
  const top0 = base + inclineLift(inc, rect.x0, rect.z0);
  return { rect, ...planeOf(rect, top0, rise * inc.dx, rise * inc.dz) };
}
