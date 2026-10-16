/**
 * The Shire's rolling ground, as one function of (x, z).
 *
 * Pure, with no three.js, so that the page's build and a server read the same
 * heights from the same layout: `build.js` lifts everything it builds in the
 * Shire's box by `at(x, z)` (a vertical shear, so walls stay upright and floors
 * follow the ground), and `surface.js` `topAt` reads it back for a floor.
 *
 * What it is made of, in order:
 *
 *  - a field of rounded hills, flat in the valleys and 3 to 8 m on the crests;
 *  - held down along the roads (every room and every street between them), so a
 *    road that crosses a hill climbs by a few degrees and not by a ramp;
 *  - a pad under every walled room, level over its whole footprint and for a
 *    few metres in front of each door, with the hill let in round it: a smial
 *    is cut into its hillside, and the hill is let rise behind it;
 *  - nothing near a room of another area, where `at` is 0 -- Midgaard's flat
 *    streets and its terraces are not ours to move.
 *
 * The grid is 1 m; `at` is bilinear in it.
 */

import { CELL } from './surface.js';

const HALF = CELL / 2;
const RES = 1;
/** How far past the outermost Shire cell the hills run before they sink to the plain. */
const MARGIN = 340;
/** A walled room's pad: half the footprint, and the apron in front of a door. */
const PAD_HALF = HALF + 0.5;
const APRON_LEN = HALF + 4.5;
const APRON_HALF = 2.9;
/** How far the pad takes to give way to the hill. */
const PAD_BLEND = 12;
/** The steepest a road may climb along its own length: 7 degrees. */
export const ROAD_GRADE = Math.tan((7 * Math.PI) / 180);
/** ...and a lane between two walls, a short pitch between two level floors, 9. */
const LANE_GRADE = Math.tan((9 * Math.PI) / 180);
/** The most a hill rises over the plain. */
const CREST = 19;
/** How far a pad may be cut into the hill beside it. */
const CUT = 0.6;
/** The lowest level that rides on the ground: the Shire's tunnels are at -1, the sewer's pits at -2 and under are the rock's. */
export const LOWEST = -1;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Integer hash, so that two engines draw the same hills.
function hash(ix, iz, salt) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(salt | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise(x, z, salt) {
  const ix = Math.floor(x); const iz = Math.floor(z);
  const fx = x - ix; const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx); const sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, salt); const b = hash(ix + 1, iz, salt);
  const c = hash(ix, iz + 1, salt); const d = hash(ix + 1, iz + 1, salt);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/**
 * The hills the mud's own words put in the Shire, as [room, dx, dz, height,
 * radius]: Took Hill is "a small hill" with the Bywater Road climbing to the
 * top of it, Delving Lane climbs north to Bag End, and the fields to the west
 * "extend toward the south and the west". A hill is a bell of cosine, so the
 * crest and the toe are round.
 */
const KNOLLS = [
  [1126, -24, -6, 8.5, 215],   // Took Hill, which the Bywater Road climbs to
  [1104, -14, -34, 6.5, 95],     // the rise the road crosses east of the bridge
  [1118, 10, 85, 5.5, 75],     // and the one south of the bridge end
  [1135, 8, -60, 9.5, 190],    // Bag End's hill, up Delving Lane
  [1117, -10, -190, 7, 170],
  [1129, -100, 20, 6, 150],
  [1100, -14, 90, 6.5, 130],
];
/** The hills round the dale, well off the roads, which no road has to climb: [room, dx, dz, height, radius]. */
const RIM = [
  [1135, 10, -85, 17, 95],
  [1141, -88, -20, 15, 90],
  [1130, -82, 10, 16, 90],
  [1125, -92, 50, 12, 85],
  [1111, 10, -150, 15, 90],
  [1100, 0, 95, 11, 80],
];
const bell = (d, r) => (d >= r ? 0 : (0.5 + 0.5 * Math.cos((Math.PI * d) / r)) ** 1.1);

/** Low rolling swell under everything, 0 to about 3 m. */
function swell(x, z) {
  const n = 0.7 * noise(x / 125 + 11.3, z / 125 + 4.1, 3) + 0.3 * noise(x / 58 + 2.7, z / 58 + 8.9, 5);
  return 4.8 * smooth(0.2, 0.9, n);
}

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * Build the relief of a layout, or null where there is no such area in it.
 * `openAir(room)` is the walls' answer (shells.js `isOpenAir`).
 */
export function buildRelief(layout, { areaFile = 'shire.are', openAir, smialName = /\b(smial|bag ?end)\b/i, fit = true } = {}) {
  const mine = layout.order.filter((c) => c.room.areaFile === areaFile);
  if (!mine.length) return null;
  // Deeper than this the ground is not shifted, so nothing there is in the way.
  const foreign = layout.order.filter((c) => c.room.areaFile !== areaFile && c.level >= 0);
  // ...and what is built at the lowest level that rides, of another area (the sewer
  // under the road), is a room like ours: level over its own footprint, with the hill over it.
  const under = layout.order.filter((c) => c.room.areaFile !== areaFile && c.level === LOWEST);

  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  for (const c of mine) {
    x0 = Math.min(x0, c.x * CELL); x1 = Math.max(x1, c.x * CELL);
    z0 = Math.min(z0, c.z * CELL); z1 = Math.max(z1, c.z * CELL);
  }
  x0 = Math.floor(x0 - HALF - MARGIN); x1 = Math.ceil(x1 + HALF + MARGIN);
  z0 = Math.floor(z0 - HALF - MARGIN); z1 = Math.ceil(z1 + HALF + MARGIN);
  const nx = Math.round((x1 - x0) / RES) + 1; const nz = Math.round((z1 - z0) / RES) + 1;
  const I = (x) => (x - x0) / RES; const J = (z) => (z - z0) / RES;

  // --- distances: to the roads, and to anything of another area -----------
  const BIG = 1e6;
  const dRoad = new Float32Array(nx * nz).fill(BIG);
  const dForeign = new Float32Array(nx * nz).fill(BIG);
  const stamp = (grid, x, z) => {
    const i = Math.round(I(x)); const j = Math.round(J(z));
    if (i >= 0 && i < nx && j >= 0 && j < nz) grid[j * nx + i] = 0;
  };
  for (const c of mine) stamp(dRoad, c.x * CELL, c.z * CELL);
  const runs = []; // every road as points two metres apart, to measure its grade by
  for (const l of layout.links) {
    // A portal is an archway across country, not a road; only streets count.
    if (l.kind !== 'alley' || (l.from.room.areaFile !== areaFile && !(l.to && l.to.room.areaFile === areaFile))) continue;
    const chain = [l.from, ...(l.path || []), ...(l.to ? [l.to] : [])];
    for (let k = 1; k < chain.length; k++) {
      const a = chain[k - 1]; const b = chain[k];
      // A lane between two walls is a short pitch between two level floors.
      const run = [];
      run.limit = l.to && !openAir(l.from.room) && !openAir(l.to.room) ? LANE_GRADE : ROAD_GRADE;
      for (let t = 0; t <= 1.0001; t += 0.5 / CELL) stamp(dRoad, (a.x + (b.x - a.x) * t) * CELL, (a.z + (b.z - a.z) * t) * CELL);
      for (let t = 0; t <= 1.0001; t += 2 / CELL) run.push([(a.x + (b.x - a.x) * t) * CELL, (a.z + (b.z - a.z) * t) * CELL]);
      runs.push(run);
    }
  }
  for (const c of foreign) {
    // Anything within the box: the squares of every cell, at any level.
    const cx = c.x * CELL; const cz = c.z * CELL;
    if (cx < x0 - HALF || cx > x1 + HALF || cz < z0 - HALF || cz > z1 + HALF) continue;
    for (let z = cz - HALF; z <= cz + HALF; z += RES) for (let x = cx - HALF; x <= cx + HALF; x += RES) stamp(dForeign, x, z);
  }
  for (const l of layout.links) {
    if (l.from.level < 0 || (l.from.room.areaFile === areaFile && (!l.to || l.to.room.areaFile === areaFile))) continue;
    const chain = [l.from, ...(l.path || []), ...(l.to ? [l.to] : [])];
    for (const c of chain) for (let z = c.z * CELL - HALF; z <= c.z * CELL + HALF; z += RES) for (let x = c.x * CELL - HALF; x <= c.x * CELL + HALF; x += RES) stamp(dForeign, x, z);
  }
  chamfer(dRoad, nx, nz); chamfer(dForeign, nx, nz);

  // --- the pads -----------------------------------------------------------
  const walled = [...mine, ...under.filter((c) => c.x * CELL > x0 && c.x * CELL < x1 && c.z * CELL > z0 && c.z * CELL < z1)].filter((c) => !openAir(c.room));
  const held = (i, j) => road + (1 - road) * smooth(12, 80, dRoad[j * nx + i]);
  const base = (x, z, i, j) => {
    // The hills are the village's own: they sink to the plain a few hundred metres out.
    const fade = 1 - smooth(220, 330, dRoad[j * nx + i]);
    let k = 0;
    for (const n of knolls) k += n.h * bell(Math.hypot(x - n.x, z - n.z), n.r);
    // Two knolls over each other make one hill, not a taller: a soft ceiling.
    k = CREST * (1 - Math.exp(-k / CREST));
    let rim = 0;
    for (const n of rimHills) rim += n.h * bell(Math.hypot(x - n.x, z - n.z), n.r);
    rim = CREST * (1 - Math.exp(-rim / CREST));
    return ((k * quiet + rim) + swell(x, z) * (0.55 + 0.45 * quiet)) * smooth(14, 120, dForeign[j * nx + i]) * fade;
  };
  let road = 0.5;
  let quiet = 1;
  const place = (list) => list.flatMap(([vnum, dx, dz, h, r]) => {
    const c = layout.cells.get(vnum);
    return c && c.room.areaFile === areaFile ? [{ x: c.x * CELL + dx, z: c.z * CELL + dz, h, r }] : [];
  });
  const rimHills = place(RIM);
  const knolls = KNOLLS.flatMap(([vnum, dx, dz, h, r]) => {
    const c = layout.cells.get(vnum);
    return c && c.room.areaFile === areaFile ? [{ x: c.x * CELL + dx, z: c.z * CELL + dz, h, r }] : [];
  });
  const H = new Float32Array(nx * nz);

  const pads = walled.map((c) => {
    const sides = layout.sides.get(c.vnum) || [];
    const open = c.room.areaFile !== areaFile ? [] : [0, 1, 2, 3].filter((d) => sides[d] && (sides[d].link || sides[d].exit));
    const smial = c.level === 0 && smialName.test(c.room.name);
    // A smial's hill rises behind it, away from the doors.
    let bx = 0; let bz = 0;
    for (const d of open) { bx -= DIRS[d][0]; bz -= DIRS[d][1]; }
    const bl = Math.hypot(bx, bz);
    return { x: c.x * CELL, z: c.z * CELL, open, smial, back: bl ? [bx / bl, bz / bl] : null, height: 0 };
  });
  // The hill a smial is dug into: behind it, away from its doors, and round
  // its sides, as high as its own dome, so that the dome comes out of the hill.
  const bumpOf = (x, z) => {
    let b = 0;
    for (const p of pads) {
      if (!p.smial || !p.back) continue;
      const cx = p.x + p.back[0] * (PAD_HALF + 10); const cz = p.z + p.back[1] * (PAD_HALF + 10);
      const along = (x - cx) * p.back[0] + (z - cz) * p.back[1];
      const across = (x - cx) * -p.back[1] + (z - cz) * p.back[0];
      const d = Math.hypot(along / (along > 0 ? 20 : 15), across / 26);
      b += 9.5 * (1 - smooth(0, 1, d));
    }
    return b;
  };


  function compute() {
    for (let j = 0; j < nz; j++) {
      const z = z0 + j * RES;
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * RES;
        H[j * nx + i] = base(x, z, i, j) + bumpOf(x, z) * (0.6 + 0.4 * quiet) * smooth(8, 26, dForeign[j * nx + i]);
      }
    }
    // A pad stands where its streets meet it: the hill's height at the ends
    // of its aprons (or, with none, over its footprint), so the streets
    // leave it level with the ground they go on across.
    for (const p of pads) {
      const at4 = (px, pz) => {
        const i = Math.min(nx - 1, Math.max(0, Math.round(I(px)))); const j = Math.min(nz - 1, Math.max(0, Math.round(J(pz))));
        return H[j * nx + i];
      };
      let sum = 0; let n = 0;
      for (const dir of p.open) { sum += at4(p.x + DIRS[dir][0] * APRON_LEN, p.z + DIRS[dir][1] * APRON_LEN); n++; }
      if (!n) { for (const [a, b] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) { sum += at4(p.x + a * PAD_HALF, p.z + b * PAD_HALF); n++; } }
      p.height = sum / n;
    }
    // Let the pads in.
    const W = new Float32Array(nx * nz); const P = new Float32Array(nx * nz);
    for (const p of pads) {
      const reach = Math.max(PAD_HALF, APRON_LEN) + PAD_BLEND + 1;
      const ia = Math.max(0, Math.floor(I(p.x - reach))); const ib = Math.min(nx - 1, Math.ceil(I(p.x + reach)));
      const ja = Math.max(0, Math.floor(J(p.z - reach))); const jb = Math.min(nz - 1, Math.ceil(J(p.z + reach)));
      for (let j = ja; j <= jb; j++) {
        for (let i = ia; i <= ib; i++) {
          const x = x0 + i * RES - p.x; const z = z0 + j * RES - p.z;
          let d = Math.hypot(Math.max(0, Math.abs(x) - PAD_HALF), Math.max(0, Math.abs(z) - PAD_HALF));
          for (const dir of p.open) {
            const [dx, dz] = DIRS[dir];
            const along = x * dx + z * dz; const across = Math.abs(x * dz - z * dx);
            d = Math.min(d, Math.hypot(along < 0 ? -along : Math.max(0, along - APRON_LEN), Math.max(0, across - APRON_HALF)));
          }
          // Behind a smial the hill is let come close: its blend is short.
          const behind = p.smial && p.back && x * p.back[0] + z * p.back[1] > PAD_HALF * 0.5;
          const w = 1 - smooth(0, behind ? 3 : PAD_BLEND, d);
          if (w <= 0) continue;
          W[j * nx + i] += w; P[j * nx + i] += w * p.height;
        }
      }
    }
    for (let k = 0; k < H.length; k++) {
      const w = W[k];
      if (w > 0) H[k] = (H[k] * Math.max(0, 1 - w) + P[k]) / Math.max(1, w);
    }
  }

  // --- the roads climb no more than ROAD_GRADE ----------------------------
  const at = (x, z) => {
    const fi = I(x); const fj = J(z);
    if (fi < 0 || fj < 0 || fi >= nx - 1 || fj >= nz - 1) return 0;
    const i = Math.floor(fi); const j = Math.floor(fj);
    const tx = fi - i; const tz = fj - j;
    const k = j * nx + i;
    return H[k] * (1 - tx) * (1 - tz) + H[k + 1] * tx * (1 - tz) + H[k + nx] * (1 - tx) * tz + H[k + nx + 1] * tx * tz;
  };
  const worst = () => {
    let m = 0;
    for (const run of runs) {
      for (let k = 1; k < run.length; k++) {
        // As a share of what this road may climb.
        const g = Math.abs(at(run[k][0], run[k][1]) - at(run[k - 1][0], run[k - 1][1])) / Math.hypot(run[k][0] - run[k - 1][0], run[k][1] - run[k - 1][1]) / run.limit * ROAD_GRADE;
        if (g > m) m = g;
      }
    }
    return m;
  };
  compute();
  let measured = worst();
  for (let n = 0; fit && n < 8 && measured > ROAD_GRADE * 1.04; n++) {
    // Everything comes down together: the road is held by the same ratio as the hills over it.
    const f = Math.max(0.5, (ROAD_GRADE / measured) * 0.97);
    quiet = Math.max(0.45, quiet * f); road = Math.max(0.2, road * f);
    compute();
    measured = worst();
  }

  let max = 0;
  for (const h of H) max = Math.max(max, h);

  const E = 1.2;
  return {
    box: { x0, x1, z0, z1 },
    max,
    road,
    grade: measured,
    at,
    /** Where a road climbs more than it may, as [x, z, degrees] (for tools). */
    steep: () => runs.flatMap((run) => run.slice(1).map((q, k) => [q[0], q[1], Math.atan(Math.abs(at(q[0], q[1]) - at(run[k][0], run[k][1])) / Math.hypot(q[0] - run[k][0], q[1] - run[k][1]) / run.limit * ROAD_GRADE) * 180 / Math.PI]).filter((v) => v[2] > 7.05)),
    quiet,
    /** The hills before the pads are let in (for tools). */
    raw: (x, z) => { const i = Math.round(I(x)); const j = Math.round(J(z)); return base(x, z, i, j) + bumpOf(x, z) * (0.6 + 0.4 * quiet) * smooth(8, 26, dForeign[j * nx + i]); },
    dForeign: (x, z) => dForeign[Math.round(J(z)) * nx + Math.round(I(x))],
    /** The slope at (x, z): [d/dx, d/dz]. */
    grad: (x, z) => [(at(x + E, z) - at(x - E, z)) / (2 * E), (at(x, z + E) - at(x, z - E)) / (2 * E)],
    /** Lowest and highest over a rectangle. */
    range(ax, bx, az, bz) {
      let lo = Infinity; let hi = -Infinity;
      const sx = Math.max(1, Math.ceil((bx - ax) / 1.5)); const sz = Math.max(1, Math.ceil((bz - az) / 1.5));
      for (let a = 0; a <= sx; a++) {
        for (let b = 0; b <= sz; b++) {
          const h = at(ax + ((bx - ax) * a) / sx, az + ((bz - az) * b) / sz);
          if (h < lo) lo = h; if (h > hi) hi = h;
        }
      }
      return [lo, hi];
    },
    touches: (ax, bx, az, bz) => bx >= x0 && ax <= x1 && bz >= z0 && az <= z1,
    pads: pads.map((p) => ({ x: p.x, z: p.z, height: p.height, smial: p.smial })),
  };
}

/** Distance to the nearest zero, in metres, in place (Felzenszwalb's exact transform, a column then a row). */
function chamfer(d, nx, nz) {
  const INF = 1e12;
  const f = new Float64Array(Math.max(nx, nz)); const v = new Int32Array(Math.max(nx, nz)); const z = new Float64Array(Math.max(nx, nz) + 1);
  const pass = (n, read, write) => {
    for (let q = 0; q < n; q++) f[q] = read(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      for (;;) {
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        if (s <= z[k] && k > 0) k--; else break;
      }
      if (s <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      write(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
    }
  };
  for (let i = 0; i < nx; i++) pass(nz, (j) => (d[j * nx + i] === 0 ? 0 : INF), (j, val) => { d[j * nx + i] = val; });
  for (let j = 0; j < nz; j++) pass(nx, (i) => d[j * nx + i], (i, val) => { d[j * nx + i] = Math.sqrt(val) * RES; });
}

/**
 * The ground of a dump: heaps of refuse and earth over a floor that is
 * humped and rutted, 0 at the cell's edge where the streets meet it. Pure,
 * like the hills, so that a server can read the same heights.
 *
 * What is left clear: a cart track down the middle from the lane on the north
 * side to the one on the south, a yard round the way in from the east, and the
 * middle of the cell, where a body arrives. The low heaps can be walked over;
 * the high ones are steeper than a body climbs (player.js `MAX_SLOPE`) and are
 * simply too steep.
 */
export function dumpLumps(cx, cz, salt = 3030) {
  const x0 = cx - HALF; const x1 = cx + HALF; const z0 = cz - HALF; const z1 = cz + HALF;
  // [u, v, height, radius along, radius across, turn]: ridges and lobes, not cones.
  const heaps = [
    [-4.2, -3.2, 1.9, 3.3, 2.0, 0.6], [-3.6, 4.0, 0.7, 2.9, 1.7, -0.4], [4.0, -3.7, 1.7, 2.8, 2.1, -0.9], [3.5, 4.0, 0.6, 2.4, 1.6, 0.3],
    [-5.3, 0.4, 0.55, 2.3, 1.4, 1.4], [-2.2, -5.3, 0.5, 2.0, 1.3, 0.1], [2.8, 5.2, 0.55, 2.2, 1.2, -0.2],
    [-2.7, 1.2, 0.4, 1.7, 1.2, 0.8], [2.7, -2.0, 0.4, 2.0, 1.1, -0.5], [5.0, -1.4, 0.35, 1.8, 1.0, 1.2],
    [-1.0, 5.4, 1.15, 2.2, 1.3, 1.5], [1.2, -5.6, 0.9, 2.4, 1.4, -1.1],
  ];
  const at = (x, z) => {
    const u = x - cx; const v = z - cz;
    const edge = Math.min(HALF - Math.abs(u), HALF - Math.abs(v));
    if (edge <= 0) return 0;
    // The ground is dragged about by the carts: warp where the heaps lie.
    const wu = u + 0.9 * (noise(u * 0.45 + 2.2, v * 0.45 + 6.1, salt + 3) - 0.5) * 2;
    const wv = v + 0.9 * (noise(u * 0.45 + 8.8, v * 0.45 + 1.7, salt + 5) - 0.5) * 2;
    let h = 0.24 + 0.16 * (noise(u * 0.7 + 4.1, v * 0.7 + 9.3, salt) - 0.5);
    for (const [hu, hv, hh, ra, rb, turn] of heaps) {
      const c = Math.cos(turn); const sn = Math.sin(turn);
      const du = wu - hu; const dv = wv - hv;
      const d = Math.hypot((du * c + dv * sn) / ra, (-du * sn + dv * c) / rb);
      if (d >= 1) continue;
      // A broad, uneven crown and a soft foot, not a point.
      const k = smooth(0, 0.85, 1 - d);
      const crown = 0.72 + 0.56 * noise(u * 1.1 + hu, v * 1.1 + hv, salt + 7);
      h += hh * k * crown;
    }
    // Rags and shards: a low roughness on everything.
    h += 0.07 * (noise(u * 2.6, v * 2.6, salt + 13) - 0.5) * (h > 0.4 ? 1.6 : 0.8);
    // The cart's ruts, and hollows where the rain stands.
    const track = Math.exp(-(((Math.abs(u) - 0.75) / 0.35) ** 2)) * smooth(-HALF, -HALF + 2, v) * (1 - smooth(HALF - 2, HALF, v));
    h -= 0.2 * track * (0.7 + 0.3 * noise(v * 0.6, 3.3, salt + 11));
    for (const [pu, pv, pr] of [[0.2, 2.6, 1.7], [-1.9, -2.4, 1.3], [2.4, 0.6, 1.1]]) h -= 0.17 * (1 - smooth(0, pr, Math.hypot(u - pu, v - pv)));
    return Math.max(0.05, h) * smooth(0, 2.6, edge);
  };
  let max = 0;
  for (let u = -HALF; u <= HALF; u += 0.25) for (let v = -HALF; v <= HALF; v += 0.25) max = Math.max(max, at(cx + u, cz + v));
  const E = 0.3;
  return {
    x0, x1, z0, z1, max, at,
    grad: (x, z) => [(at(x + E, z) - at(x - E, z)) / (2 * E), (at(x, z + E) - at(x, z - E)) / (2 * E)],
    inside: (x, z) => x > x0 && x < x1 && z > z0 && z < z1,
    range(ax, bx, az, bz) {
      let lo = Infinity; let hi = -Infinity;
      for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6; b++) { const h = at(ax + ((bx - ax) * a) / 6, az + ((bz - az) * b) / 6); if (h < lo) lo = h; if (h > hi) hi = h; }
      return [lo, hi];
    },
  };
}
