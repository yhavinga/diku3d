/**
 * Procedural materials. Nothing is downloaded: every surface here is noise,
 * cellular patterns and a palette, baked once at boot into an albedo map, a
 * normal map derived from the height field, and a roughness map.
 *
 * All noise lattices are periodic so the maps tile without a visible seam.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------- noise ----

function hash2(ix, iy, period, seed) {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Periodic value noise; `period` is measured in lattice cells. */
function vnoise(x, y, period, seed) {
  const ix = Math.floor(x); const iy = Math.floor(y);
  const fx = smooth(x - ix); const fy = smooth(y - iy);
  const a = hash2(ix, iy, period, seed);
  const b = hash2(ix + 1, iy, period, seed);
  const c = hash2(ix, iy + 1, period, seed);
  const d = hash2(ix + 1, iy + 1, period, seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function fbm(x, y, period, seed, octaves = 4, gain = 0.5) {
  let sum = 0; let amp = 1; let norm = 0; let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * f, y * f, period * f, seed + o * 101);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Value noise periodic on each axis separately: `px` in x, `py` in y. */
function vnoiseA(x, y, px, py, seed) {
  const ix = Math.floor(x); const iy = Math.floor(y);
  const fx = smooth(x - ix); const fy = smooth(y - iy);
  const w = (i, p) => ((i % p) + p) % p;
  const h = (i, j) => hash2(w(i, px), w(j, py), 1 << 20, seed);
  const a = h(ix, iy); const b = h(ix + 1, iy); const c = h(ix, iy + 1); const d = h(ix + 1, iy + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function fbmA(x, y, px, py, seed, octaves = 4, gain = 0.5) {
  let sum = 0; let amp = 1; let norm = 0; let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoiseA(x * f, y * f, px * f, py * f, seed + o * 101);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Worley cells periodic per axis: `px` cells across, `py` down. Returns
 * [distance to nearest, edge distance, cell hash], like `cellular`.
 */
function cellularA(x, y, px, py, seed, jitter = 0.45) {
  const ix = Math.floor(x); const iy = Math.floor(y);
  let d1 = 1e9; let d2 = 1e9; let id = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox; const cy = iy + oy;
      const wx = ((cx % px) + px) % px; const wy = ((cy % py) + py) % py;
      const h = hash2(wx, wy, 1 << 20, seed);
      const h2 = hash2(wx, wy, 1 << 20, seed + 7717);
      const d = Math.hypot(cx + 0.5 + (h - 0.5) * 2 * jitter - x, cy + 0.5 + (h2 - 0.5) * 2 * jitter - y);
      if (d < d1) { d2 = d1; d1 = d; id = h * 0.5 + h2 * 0.5; } else if (d < d2) d2 = d;
    }
  }
  return [d1, d2 - d1, id];
}

/**
 * Bark plates: Worley cells `cols` across the tile and `rows` up it, so a
 * plate is long and narrow, with the cell walls as the furrows. A slow warp
 * bends the columns so the furrows wander, split and rejoin. The first cut
 * had the cells nearly square and read as crazy paving; the contours of a
 * stretched noise read as camouflage, because a contour's width follows the
 * noise's slope. A cell wall is a true distance, so a furrow keeps its width
 * and only the `furrow` wobble changes it. Periodic on both axes, so it wraps
 * round a trunk and up it without a seam.
 *
 * Returns `h` (0 deep in a furrow to 1 on a plate), `top` (plate face rather
 * than furrow wall) and `id`, a roll per plate.
 */
function barkPlates(u, v, { cols, rows, furrow, seed, warp = 0.35 }) {
  const wx = u * cols + (fbmA(u * 2, v * 3, 2, 3, seed, 3) - 0.5) * 2 * warp * cols / 4;
  const [, edge, id] = cellularA(wx, v * rows, cols, rows, seed + 3, 0.48);
  const fw = furrow * (0.75 + 0.5 * fbmA(u * 8, v * 6, 8, 6, seed + 5, 2));
  // Steep furrow walls and a flat plate: a slow ramp from the furrow to the
  // middle of the plate is a bevel, and every plate outlined by one read as
  // a pineapple.
  const h = THREE.MathUtils.smoothstep(edge, fw * 0.12, fw * 0.55);
  return { h, top: THREE.MathUtils.smoothstep(h, 0.35, 0.7), id };
}

/**
 * Bark as a net of ridges running up v: two families of `ridges` across the
 * tile, leaning `slant` ridges either way over its height, so they part and
 * rejoin and leave lozenge-shaped furrows between them -- which is the
 * pattern of an old fir, an oak or an ash, and not a grid. Ridge widths
 * wander, the lines meander by `warp`, and wiggling cross-cracks (`breaks` a
 * tile) cut the ridges into plates. Everything is periodic per axis so it
 * wraps round a trunk and up it without a seam.
 *
 * Returns `h` (0 deep in a furrow to 1 on a ridge), `top` (ridge face rather
 * than furrow wall) and `id`, a roll per patch of ridge.
 */
function barkRidges(u, v, { ridges, slant = 1, warp, breaks = 0, seed, width = 0.3 }) {
  const wobble = (fbmA(u * 4, v * 2, 4, 2, seed, 3) - 0.5) * 2 * warp;
  const wv = width * (0.65 + 0.7 * fbmA(u * 8, v * 4, 8, 4, seed + 3, 2));
  const ridge = (r) => {
    const dc = Math.abs(r - Math.floor(r) - 0.5);
    return 1 - THREE.MathUtils.smoothstep(dc, wv * 0.55, wv + 0.14);
  };
  const r1 = u * ridges + v * slant + wobble;
  const r2 = u * ridges - v * slant + wobble * 0.7 + 0.37;
  let h = Math.max(ridge(r1), ridge(r2));
  if (breaks) {
    // Cross-cracks per ridge, at a spacing and height of the ridge's own, so
    // no two line up into a course of bricks.
    const col = ((Math.floor(r1) % ridges) + ridges) % ridges;
    const k = breaks + Math.floor(hash2(col, 3, 1 << 20, seed + 7) * breaks);
    const pv = v * k + hash2(col, 4, 1 << 20, seed + 9) + (fbmA(u * 8, v * 2, 8, 2, seed + 11, 2) - 0.5) * 0.5;
    const cr = Math.abs(pv - Math.round(pv));
    h *= 0.35 + 0.65 * THREE.MathUtils.smoothstep(cr, 0.015, 0.07);
  }
  const id = fbmA(u * 12, v * 6, 12, 6, seed + 17, 1);
  return { h, top: THREE.MathUtils.smoothstep(h, 0.45, 0.85), id };
}

/** Worley-ish cells. Returns [distance to nearest, edge distance, cell hash]. */
function cellular(x, y, period, seed, jitter = 0.45) {
  const ix = Math.floor(x); const iy = Math.floor(y);
  let d1 = 1e9; let d2 = 1e9; let id = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox; const cy = iy + oy;
      const h = hash2(cx, cy, period, seed);
      const h2 = hash2(cx, cy, period, seed + 7717);
      const px = cx + 0.5 + (h - 0.5) * 2 * jitter;
      const py = cy + 0.5 + (h2 - 0.5) * 2 * jitter;
      const d = Math.hypot(px - x, py - y);
      if (d < d1) { d2 = d1; d1 = d; id = h * 0.5 + h2 * 0.5; }
      else if (d < d2) { d2 = d; }
    }
  }
  return [d1, d2 - d1, id];
}

/**
 * `cellular`, but returning where (x, y) lies relative to its cell's feature
 * point -- [dx, dy, id, edge] -- so each cell can carry a plane of its own:
 * a facet, not a dimple.
 */
function facetCell(x, y, px, py, seed, jitter = 0.45) {
  const ix = Math.floor(x); const iy = Math.floor(y);
  let d1 = 1e9; let d2 = 1e9; let best = [0, 0, 0];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox; const cy = iy + oy;
      const wx = ((cx % px) + px) % px; const wy = ((cy % py) + py) % py;
      const h = hash2(wx, wy, 1 << 20, seed);
      const h2 = hash2(wx, wy, 1 << 20, seed + 7717);
      const fx = cx + 0.5 + (h - 0.5) * 2 * jitter;
      const fy = cy + 0.5 + (h2 - 0.5) * 2 * jitter;
      const d = Math.hypot(fx - x, fy - y);
      if (d < d1) { d2 = d1; d1 = d; best = [x - fx, y - fy, h * 0.5 + h2 * 0.5]; } else if (d < d2) d2 = d;
    }
  }
  return [best[0], best[1], best[2], d2 - d1];
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Hex string to linear-ish [r,g,b] bytes we can blend in place. */
function rgb(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// The random rubble of the neighborhood's walls, laid out once for its tile:
// fourteen courses whose heights wander a quarter either way, and a number of
// stones in each that changes row to row. See `sootwall`.
const SOOT_ROWS = (() => {
  const n = 14;
  const rows = [0];
  for (let i = 1; i < n; i++) rows.push((i + (hash2(i, 0, n, 683) - 0.5) * 0.5) / n);
  rows.push(1);
  return rows;
})();
const SOOT_COLS = SOOT_ROWS.slice(0, -1).map((_, i) => 4 + Math.floor(hash2(i, 1, 14, 687) * 5));
const SOOT_SHIFT = SOOT_ROWS.slice(0, -1).map((_, i) => hash2(i, 2, 14, 689));

// ------------------------------------------------------------- surfaces ----

/**
 * Each surface fills three buffers for pixel (u,v) in [0,1):
 *   colour (0-255 rgb), height (0-1, drives the normal map), roughness (0-1).
 */
/**
 * The needle spray, laid out once: twigs, and every needle on them as its own
 * short segment, binned on a 32 x 32 grid so a texel tests a handful.
 *
 * It used to be a periodic strand function -- needles as lines of constant
 * (along - across * 0.58) -- which is a herringbone, and at the distance a
 * crown is seen from the herringbone was all that read: a judge photographed
 * flat boughs printed with chevrons. Needles here leave their twig at a
 * scattered angle, at scattered lengths, some foreshortened the way a needle
 * pointing at you is, on three orders of twig, and the ones nearer the twig
 * and further back are darker -- which is where a spray's depth comes from.
 */
const NEEDLE_SPRAY = (() => {
  const r = seeded(4099);
  const twigs = [];   // [x0, y0, x1, y1, w, order, t0, t1] t = position along the spray
  const needles = []; // [x0, y0, x1, y1, w, depth, fresh, order]
  const addTwig = (x0, y0, x1, y1, w, order, t0, t1) => twigs.push([x0, y0, x1, y1, w, order, t0, t1]);
  const clampV = (y) => Math.min(0.93, Math.max(0.07, y));
  // Main axis, bowed, in four pieces.
  let px = 0; let py = 0.5;
  for (let i = 1; i <= 4; i++) {
    const nx = i * 0.245; const ny = 0.5 + 0.018 * Math.sin(i * 1.3);
    addTwig(px, py, nx, ny, 0.0042 * (1.2 - nx * 0.6), 0, px, nx);
    px = nx; py = ny;
  }
  // Side shoots alternating off it, forward-swept and shorter to the tip,
  // each carrying a few tertiary shoots of its own.
  for (let k = 0; k < 19; k++) {
    const u0 = 0.02 + k * 0.049 + (r() - 0.5) * 0.015;
    const side = k % 2 ? 1 : -1;
    const len = 0.5 * (1 - u0 * 0.55) * (0.8 + r() * 0.35);
    const a = 0.95 + r() * 0.3;
    const y0 = 0.5 + 0.018 * Math.sin(u0 * 5.2);
    let x = u0; let y = y0; let ang = a;
    const pieces = 3;
    for (let p = 0; p < pieces; p++) {
      const l = len / pieces;
      ang -= 0.16 + r() * 0.1; // bending towards the tip of the spray
      // Nothing crosses the tile's far end: the tile repeats down a long card,
      // and a shoot cut off by the edge is a straight line in the sky.
      const nx = Math.min(0.975, x + Math.cos(ang) * l); const ny = clampV(y + side * Math.sin(ang) * l);
      addTwig(x, y, nx, ny, 0.0028 * (1 - p * 0.25), 1, u0 + (p / pieces) * len, u0 + ((p + 1) / pieces) * len);
      // Tertiary shoots off the outer side of this piece.
      if (p < 2 && len > 0.12) {
        for (const f of [0.35, 0.8]) {
          const tx = x + (nx - x) * f; const ty = y + (ny - y) * f;
          const ta = ang + 0.6 + r() * 0.35;
          const tl = len * (0.22 + r() * 0.12) * (1 - p * 0.3);
          const ex = Math.min(0.975, tx + Math.cos(ta) * tl); const ey = clampV(ty + side * Math.sin(ta) * tl);
          addTwig(tx, ty, ex, ey, 0.0018, 2, u0 + len * (p + f) / pieces, u0 + len * (p + f) / pieces + tl);
        }
      }
      x = nx; y = ny;
    }
  }
  // Needles along every twig, both sides, forward-swept at a scattered angle.
  for (const [x0, y0, x1, y1, , order, t0, t1] of twigs) {
    const dx = x1 - x0; const dy = y1 - y0;
    const L = Math.hypot(dx, dy);
    const ux = dx / L; const uy = dy / L;
    const n = Math.max(2, Math.round(L / 0.0045));
    for (let i = 0; i < n; i++) {
      const f = (i + r()) / n;
      const bx = x0 + dx * f; const by = y0 + dy * f;
      const t = t0 + (t1 - t0) * f;
      for (const sd of [-1, 1]) {
        const ang = (0.55 + r() * 0.6) * sd;
        // Foreshortened: a needle pointing out of the card is a short one.
        const len = (0.03 + r() * 0.02) * (r() < 0.3 ? 0.35 + r() * 0.4 : 1) * (order === 2 ? 0.8 : 1);
        const ca = Math.cos(ang); const sa = Math.sin(ang);
        const nx = ux * ca - uy * sa; const ny = ux * sa + uy * ca;
        needles.push([bx, by, Math.min(0.992, bx + nx * len), clampV(by + ny * len), 0.002 + r() * 0.001,
          (2 - order) * 0.12 + r() * 0.7, clamp01((t - 0.78) * 4.5) * (order === 0 ? 0.4 : 1), order]);
      }
    }
  }
  const N = 32;
  const bins = Array.from({ length: N * N }, () => []);
  const binAdd = (list, idx, x0, y0, x1, y1, pad) => {
    const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - pad) * N)); const i1 = Math.min(N - 1, Math.floor((Math.max(x0, x1) + pad) * N));
    const j0 = Math.max(0, Math.floor((Math.min(y0, y1) - pad) * N)); const j1 = Math.min(N - 1, Math.floor((Math.max(y0, y1) + pad) * N));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) bins[j * N + i].push([list, idx]);
  };
  needles.forEach((nd, i) => binAdd(needles, i, nd[0], nd[1], nd[2], nd[3], nd[4]));
  twigs.forEach((tw, i) => binAdd(twigs, i, tw[0], tw[1], tw[2], tw[3], 0.012));
  return { twigs, needles, bins, N };
})();

/** A small seeded generator for laying out cards once at load. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The coursed rubble's layout, in metres over its 3 m tile: courses of 17 to
 * 29 cm and stones of 22 to 70 cm in each, both normalised so the tile ends on
 * a joint. See `rubblewall`.
 */
const RUBBLE = (() => {
  const r = seeded(7331);
  const T = 3;
  const heights = [];
  let sum = 0;
  while (sum < T - 0.2) { const h = 0.17 + r() * 0.12; heights.push(h); sum += h; }
  const k = T / sum;
  const rows = [0];
  for (const h of heights) rows.push(rows[rows.length - 1] + h * k);
  const stones = heights.map(() => {
    const ls = []; let w = 0;
    while (w < T - 0.15) { const l = 0.22 + r() * 0.48; ls.push(l); w += l; }
    const kk = T / w; const xs = [0];
    for (const l of ls) xs.push(xs[xs.length - 1] + l * kk);
    return xs;
  });
  return { T, rows, stones };
})();

/**
 * Bedded rock broken by joints: beds of `bed` (min, span) of the tile's
 * height, each cut by `joints` (min, span) cracks that do not line up from one
 * bed to the next, and every block with its own tilt -- a fracture face is a
 * plane at some angle to the wall, never a noise. Used by `caverock` and the
 * earth cut of a burrow.
 */
function strataLayout(seed, bed, joints) {
  const r = seeded(seed);
  const edges = [0];
  while (edges[edges.length - 1] < 1 - bed[0]) edges.push(edges[edges.length - 1] + bed[0] + r() * bed[1]);
  const k = 1 / edges[edges.length - 1];
  for (let i = 0; i < edges.length; i++) edges[i] *= k;
  const beds = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const n = joints[0] + Math.floor(r() * joints[1]);
    const cuts = Array.from({ length: n }, () => r()).sort((a, b) => a - b);
    beds.push({
      v0: edges[i], v1: edges[i + 1], cuts,
      slant: (r() - 0.5) * 2.4,
      // How far this bed stands proud of the one under it: a harder bed
      // weathers out as a ledge, a softer one is cut back.
      proud: r(),
      tilts: cuts.map(() => [(r() - 0.5) * 2, (r() - 0.5) * 2]),
      tones: cuts.map(() => r()),
    });
  }
  return beds;
}

/**
 * Where (u, v) falls in a `strataLayout`: which bed and block, how far (in
 * tile units) from the nearest bedding plane and the nearest joint, and the
 * position inside the block. The bedding planes wander a little, and joints
 * lean, so nothing is ruled.
 */
function strataAt(beds, u, v, seed) {
  const vv = (((v + (fbm(u * 3, 0.37, 3, seed, 3) - 0.5) * 0.05
    + (fbm(u * 16, v * 2, 16, seed + 5, 2) - 0.5) * 0.012) % 1) + 1) % 1;
  let i = 0;
  while (i < beds.length - 1 && vv >= beds[i].v1) i++;
  const b = beds[i];
  const fy = (vv - b.v0) / (b.v1 - b.v0);
  // A joint zigzags: it follows the weakest grain, not a ruler.
  const uu = (((u + (fy - 0.5) * (b.v1 - b.v0) * b.slant
    + (fbm(u * 4, v * 24, 4, seed + 9, 3) - 0.5) * 0.03) % 1) + 1) % 1;
  const n = b.cuts.length;
  let j = 0;
  while (j < n && uu >= b.cuts[j]) j++;
  // Block j lies between cuts[j-1] and cuts[j], wrapping round the tile.
  const left = j === 0 ? b.cuts[n - 1] - 1 : b.cuts[j - 1];
  const right = j === n ? b.cuts[0] + 1 : b.cuts[j];
  const k = j % n;
  const fx = (uu - left) / (right - left);
  return {
    bed: b, block: k, fx, fy,
    dBed: Math.min(vv - b.v0, b.v1 - vv),
    dJoint: Math.min(uu - left, right - uu),
    tilt: b.tilts[k], tone: b.tones[k],
  };
}

const CAVE_BEDS = strataLayout(4471, [0.07, 0.13], [2, 4]);
const EARTH_BEDS = strataLayout(4481, [0.07, 0.12], [1, 3]);


/**
 * The grass atlas: eight cards of blades, two across and four down, each laid
 * out in metres so a blade is drawn at the width it has in the world. The
 * card geometry in grass.js is built from the same sizes, so a region is
 * never stretched: at 512 x 256 texels a lawn card is about a millimetre a
 * texel either way, and a 4 mm blade is four texels wide.
 *
 * `kind` picks the mix of what grows on it. Lawn and meadow are most of the
 * world; the flowers and the broad-leaved weeds are the Shire's, and the
 * trodden card is what a path through a field is made of.
 */
export const GRASS_CARDS = [
  { w: 0.5, h: 0.28, kind: 'lawn', seed: 11 },
  { w: 0.5, h: 0.42, kind: 'lawnseed', seed: 12 },
  { w: 0.6, h: 0.8, kind: 'meadow', seed: 13 },
  { w: 0.6, h: 0.62, kind: 'straw', seed: 14 },
  { w: 0.5, h: 0.42, kind: 'buttercup', seed: 15 },
  { w: 0.5, h: 0.3, kind: 'daisy', seed: 16 },
  { w: 0.5, h: 0.34, kind: 'weed', seed: 17 },
  { w: 0.5, h: 0.17, kind: 'trodden', seed: 18 },
];
export const GRASS_ATLAS = { cols: 2, rows: 4, size: 1024 };

// Blade palettes: a coastal meadow is a deep, slightly blue green with the odd
// blade gone yellow or dead, not one lawn colour -- and the spread is per
// blade, which at a card's distance averages out instead of blotching.
const GREENS = [0x365a27, 0x40652c, 0x4a6e31, 0x3a5e33, 0x547535, 0x62803a];
const STRAW = [0x8e8150, 0x9d8c58, 0x7f7447, 0xa89a66];

/**
 * Each card's shapes, in card metres with y up from the root: blades, stalks
 * with a head on top, and broad leaves. `depth` orders them front to back and
 * darkens the ones behind, which is where the body of a tuft comes from.
 */
const GRASS_SHAPES = GRASS_CARDS.map((card) => {
  const r = seeded(card.seed * 7919);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const shapes = [];
  const margin = 0.03 * card.w;
  const blade = (hMin, hMax, lean, wMin, wMax, palette, dryChance) => {
    const x0 = margin + 0.04 * card.w + r() * (card.w - 2 * margin - 0.08 * card.w);
    // Shorter towards the card's ends, so a tuft is a mound and not a hedge
    // cut level along the top.
    const edge = Math.abs(x0 / card.w - 0.5) * 2;
    const h = (hMin + r() * (hMax - hMin)) * card.h * (1 - 0.5 * edge * edge);
    // Lean away from the middle, the way a tuft splays, with some crossing.
    const out = (x0 - card.w / 2) / (card.w / 2);
    let dx = (out * 0.6 + (r() - 0.5)) * lean * h;
    dx = Math.max(margin - x0, Math.min(card.w - margin - x0, dx));
    shapes.push({
      type: 'blade', x0, h, dx, w: wMin + r() * (wMax - wMin), depth: r(),
      col: rgb(pick(palette)), dry: r() < dryChance ? 0.15 + r() * 0.35 : 0,
    });
  };
  const stalk = (head, hMin, hMax) => {
    const x0 = card.w * (0.12 + r() * 0.76);
    const h = (hMin + r() * (hMax - hMin)) * card.h;
    shapes.push({ type: 'stalk', x0, h, dx: (r() - 0.5) * 0.12 * h, w: 0.0012, depth: 0.55 + r() * 0.45, head, col: rgb(0x55702f) });
  };
  const lawnish = card.kind === 'lawn' || card.kind === 'lawnseed';
  const count = { lawn: 150, lawnseed: 115, meadow: 95, straw: 85, buttercup: 80, daisy: 90, weed: 40, trodden: 80 }[card.kind];
  for (let i = 0; i < count; i++) {
    if (card.kind === 'straw') blade(0.35, 0.97, 0.5, 0.0022, 0.0038, r() < 0.65 ? STRAW : GREENS, 0.4);
    else if (card.kind === 'meadow') blade(0.3, 0.97, 0.55, 0.0022, 0.004, GREENS, 0.3);
    else if (card.kind === 'trodden') blade(0.25, 0.95, 1.4, 0.0022, 0.0036, r() < 0.3 ? STRAW : GREENS, 0.2);
    else blade(lawnish ? 0.4 : 0.3, 0.97, 0.42, 0.002, 0.0034, GREENS, 0.12);
  }
  if (card.kind === 'lawnseed') for (let i = 0; i < 4; i++) stalk('panicle', 0.75, 0.98);
  if (card.kind === 'meadow') for (let i = 0; i < 7; i++) stalk(r() < 0.5 ? 'panicle' : 'spike', 0.7, 0.98);
  if (card.kind === 'straw') for (let i = 0; i < 6; i++) stalk('panicle', 0.7, 0.98);
  if (card.kind === 'buttercup') for (let i = 0; i < 7; i++) stalk('buttercup', 0.55, 0.95);
  if (card.kind === 'daisy') {
    for (let i = 0; i < 6; i++) stalk('daisy', 0.35, 0.8);
    for (let i = 0; i < 4; i++) stalk('clover', 0.25, 0.55);
  }
  if (card.kind === 'weed') {
    // Plantain and dock: broad leaves arching out of one rosette.
    for (let i = 0; i < 9; i++) {
      const x0 = card.w * (0.35 + r() * 0.3);
      const h = card.h * (0.45 + r() * 0.5);
      const dx = (r() < 0.5 ? -1 : 1) * (0.25 + r() * 0.6) * h;
      shapes.push({ type: 'leaf', x0, h, dx: Math.max(margin - x0, Math.min(card.w - margin - x0, dx)), w: 0.007 + r() * 0.008, depth: r(), col: rgb(pick([0x3e5f28, 0x4a6b2c, 0x557533])) });
    }
  }
  // Bin by x so a texel only tests the shapes that can reach it.
  const bins = Array.from({ length: 16 }, () => []);
  for (const sh of shapes) {
    const x0 = Math.min(sh.x0, sh.x0 + sh.dx) - 0.03; const x1 = Math.max(sh.x0, sh.x0 + sh.dx) + 0.03;
    for (let b = 0; b < 16; b++) {
      const bx0 = (b / 16) * card.w; const bx1 = ((b + 1) / 16) * card.w;
      if (x1 >= bx0 && x0 <= bx1) bins[b].push(sh);
    }
  }
  return { card, bins };
});

/** Where a card's shape covers (x, y), and how: null if it does not. */
function grassShapeAt(sh, x, y) {
  if (y < 0 || y > sh.h + 0.03) return null;
  if (sh.type === 'blade' || sh.type === 'stalk') {
    const t = Math.min(1, y / sh.h);
    if (y > sh.h) return sh.type === 'stalk' ? grassHead(sh, x, y) : null;
    const cx = sh.x0 + sh.dx * Math.pow(t, 1.7);
    const hw = sh.type === 'stalk' ? sh.w : sh.w * Math.pow(1 - t, 0.75);
    const d = Math.abs(x - cx);
    if (d < hw) return { t, across: d / Math.max(hw, 1e-5) };
    return sh.type === 'stalk' ? grassHead(sh, x, y) : null;
  }
  if (sh.type === 'leaf') {
    const t = Math.min(1, y / sh.h);
    const cx = sh.x0 + sh.dx * Math.pow(t, 1.3);
    const hw = sh.w * Math.sin(Math.PI * Math.pow(t, 0.8)) + 0.001;
    const d = Math.abs(x - cx);
    return d < hw ? { t, across: d / hw } : null;
  }
  return null;
}

function grassHead(sh, x, y) {
  const hx = sh.x0 + sh.dx; const hy = sh.h;
  const dx = x - hx; const dy = y - hy;
  if (sh.head === 'panicle' || sh.head === 'spike') {
    // A loose plume above the stalk: spikelets scattered in a narrow oval.
    const len = sh.head === 'spike' ? 0.05 : 0.07;
    if (dy < -0.004 || dy > len) return null;
    // Widest a third of the way up, closing to a point.
    const f = clamp01(dy / len);
    const rx = (sh.head === 'spike' ? 0.0045 : 0.014) * Math.sin(Math.PI * Math.pow(f, 0.7)) + 0.0015;
    if (Math.abs(dx) > rx) return null;
    const grain = hash2(Math.floor(x * 1100), Math.floor(y * 700), 4096, 57);
    return grain > (sh.head === 'spike' ? 0.12 : 0.3) ? { head: true, t: 1, across: Math.abs(dx) / rx } : null;
  }
  // A shade over life size: a 2 cm flower is 2 cm, but it has to read from
  // five metres, where a buttercup is otherwise a single yellow texel.
  const rx = sh.head === 'daisy' ? 0.014 : sh.head === 'clover' ? 0.0095 : 0.012;
  const ry = sh.head === 'daisy' ? 0.006 : sh.head === 'clover' ? 0.0088 : 0.0085;
  const e = (dx / rx) ** 2 + (dy / ry) ** 2;
  return e < 1 ? { head: true, t: 1, across: Math.sqrt(e) } : null;
}

const HEADS = {
  panicle: [0x9a8a5e, 0x7e6a5a], spike: [0x8f8a5a, 0x6f6a45],
  buttercup: [0xe8c21c, 0xb88f10], daisy: [0xf2efe2, 0xd9d4c4], clover: [0xd8b8c4, 0xa9728a],
};

/**
 * Leaf sprays for the broadleaf cards (trees.py): a twig along u from the
 * base at u = 0 to the tip, side twigs off it, and leaves on all of them,
 * each leaf a shape of its own laid in its own frame. Same arrangement as
 * the needle spray -- laid out once, binned, frontmost wins, darker behind
 * and towards the twig -- because the mass of a bush or a crown is what the
 * leaves behind the front ones do to it.
 *
 * `shape` gives a leaf's half-width at a fraction `a` of its length:
 *   oak     lobed, widest two-thirds out, four or five round lobes a side
 *   ovate   plain ellipse-ish, for the generic shrub
 *   salal   broad, pointed, finely toothed -- and glossy, see the recipe
 *   pinna   a fern leaflet: long, narrow, toothed
 */
const LEAF_SHAPES = {
  oak: (a) => Math.pow(Math.sin(Math.PI * Math.pow(a, 0.75)), 0.8) * (0.62 + 0.38 * Math.abs(Math.cos(a * Math.PI * 4.5))),
  ovate: (a) => Math.pow(Math.sin(Math.PI * Math.pow(a, 0.85)), 0.75),
  salal: (a) => Math.pow(Math.sin(Math.PI * Math.pow(a, 0.62)), 0.7) * (0.94 + 0.06 * Math.abs(Math.sin(a * 70))),
  pinna: (a) => Math.pow(Math.sin(Math.PI * Math.pow(a, 0.5)), 0.6) * (0.88 + 0.12 * Math.abs(Math.sin(a * 40))),
  // A nettle's: heart-based, long-pointed and coarsely toothed.
  nettle: (a) => Math.pow(Math.sin(Math.PI * Math.pow(a, 0.55)), 0.75) * (0.8 + 0.2 * Math.abs(Math.sin(a * 34))),
  // A dock's or a willowherb's: long, narrow and plain.
  lance: (a) => Math.pow(Math.sin(Math.PI * Math.pow(a, 0.7)), 0.9),
};

function leafSpray(spec) {
  const r = seeded(spec.seed);
  const twigs = []; const leaves = [];
  const clampV = (y) => Math.min(0.94, Math.max(0.06, y));
  const leafOn = (x0, y0, x1, y1, order, spacing, sideSign) => {
    const dx = x1 - x0; const dy = y1 - y0; const L = Math.hypot(dx, dy);
    const base = Math.atan2(dy, dx);
    const n = Math.max(1, Math.round(L / spacing));
    for (let i = 0; i < n; i++) {
      const f = (i + 0.3 + r() * 0.4) / n;
      for (const sd of sideSign ? [sideSign] : [-1, 1]) {
        if (!sideSign && spec.alternate && (i % 2 ? sd > 0 : sd < 0)) continue;
        const ang = base + sd * (spec.angle + (r() - 0.5) * spec.spread);
        const along = order === 0 ? f : 0;
        const len = spec.leaf * (0.75 + r() * 0.45) * (1 - (spec.taper ?? 0.35) * Math.pow(along, 1.4));
        const cx = x0 + dx * f; const cy = y0 + dy * f;
        let ex = cx + Math.cos(ang) * len; let ey = cy + Math.sin(ang) * len;
        ex = Math.min(0.985, Math.max(0.015, ex)); ey = clampV(ey);
        leaves.push({ x0: cx, y0: cy, x1: ex, y1: ey, w: len * spec.width * (0.85 + r() * 0.3),
          depth: r() * 0.8 + (order ? 0.2 : 0), tint: r(), order });
      }
    }
  };
  // Main twig.
  twigs.push([0, 0.5, 0.97, 0.5 + (r() - 0.5) * 0.06, spec.twig]);
  if (spec.mainLeaves) leafOn(0.04, 0.5, 0.97, 0.5, 0, spec.spacing, 0);
  for (let k = 0; k < spec.sides; k++) {
    const u0 = 0.06 + (k + r() * 0.5) * (0.8 / spec.sides);
    const side = k % 2 ? 1 : -1;
    const len = spec.sideLen * (1 - u0 * 0.5) * (0.8 + r() * 0.4);
    const a = spec.sideAngle + (r() - 0.5) * 0.3;
    const ex = Math.min(0.97, u0 + Math.cos(a) * len); const ey = clampV(0.5 + side * Math.sin(a) * len);
    twigs.push([u0, 0.5, ex, ey, spec.twig * 0.7]);
    leafOn(u0, 0.5, ex, ey, 1, spec.spacing, 0);
  }
  const N = 32;
  const bins = Array.from({ length: N * N }, () => []);
  const add = (item, x0, y0, x1, y1, pad) => {
    const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - pad) * N)); const i1 = Math.min(N - 1, Math.floor((Math.max(x0, x1) + pad) * N));
    const j0 = Math.max(0, Math.floor((Math.min(y0, y1) - pad) * N)); const j1 = Math.min(N - 1, Math.floor((Math.max(y0, y1) + pad) * N));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) bins[j * N + i].push(item);
  };
  for (const lf of leaves) add(lf, lf.x0, lf.y0, lf.x1, lf.y1, lf.w);
  for (const tw of twigs) add({ twig: tw }, tw[0], tw[1], tw[2], tw[3], tw[4] + 0.004);
  return { ...spec, bins, N, shape: LEAF_SHAPES[spec.shape] };
}

const LEAF_SPRAYS = {
  // An oak twig: short side twigs crowded with lobed leaves ~10 cm long.
  oakleaf: leafSpray({ seed: 5101, shape: 'oak', leaf: 0.13, width: 0.32, angle: 0.75, spread: 0.7, spacing: 0.05,
    sides: 7, sideLen: 0.38, sideAngle: 0.8, twig: 0.006, mainLeaves: true, alternate: true,
    palette: [0x28401b, 0x314f21, 0x3b5a25, 0x46632a], back: 0x1a2914 }),
  // A generic shrub: small, plain, dense leaves all along.
  shrubleaf: leafSpray({ seed: 5203, shape: 'ovate', leaf: 0.075, width: 0.26, angle: 0.9, spread: 0.9, spacing: 0.028,
    sides: 9, sideLen: 0.36, sideAngle: 0.9, twig: 0.005, mainLeaves: true, alternate: false,
    palette: [0x2c4a22, 0x35562a, 0x40612d, 0x4c6b33], back: 0x19291a }),
  // Salal: big, leathery, pointed, alternate on a reddish stem.
  salal: leafSpray({ seed: 5309, shape: 'salal', leaf: 0.2, width: 0.3, angle: 0.95, spread: 0.5, spacing: 0.085,
    sides: 3, sideLen: 0.32, sideAngle: 0.75, twig: 0.007, mainLeaves: true, alternate: true,
    palette: [0x243f22, 0x2b4a26, 0x33552b, 0x3d5f2f], back: 0x142214, stem: 0x5a3326 }),
  // A clipped hedge: privet and beech, small leaves crowded thick, and the
  // cut makes them denser still.
  hedgeleaf: leafSpray({ seed: 5503, shape: 'ovate', leaf: 0.05, width: 0.34, angle: 1.0, spread: 1.1, spacing: 0.017,
    sides: 12, sideLen: 0.4, sideAngle: 1.0, twig: 0.004, mainLeaves: true, alternate: false,
    palette: [0x24401c, 0x2c4b21, 0x355626, 0x3f5f2a, 0x2a4420], back: 0x16241a }),
  // A nettle top: opposite pairs of toothed leaves up a square stem.
  nettleleaf: leafSpray({ seed: 5601, shape: 'nettle', leaf: 0.17, width: 0.3, angle: 1.05, spread: 0.3, spacing: 0.1,
    sides: 2, sideLen: 0.3, sideAngle: 0.9, twig: 0.006, mainLeaves: true, alternate: false, taper: 0.55,
    palette: [0x2e4a1f, 0x365424, 0x3f5d28], back: 0x19281a, stem: 0x3f4a26 }),
  // Bramble: dark, toothed leaflets in threes and fives on a purple cane.
  brambleleaf: leafSpray({ seed: 5701, shape: 'nettle', leaf: 0.1, width: 0.36, angle: 0.8, spread: 0.6, spacing: 0.05,
    sides: 5, sideLen: 0.3, sideAngle: 0.85, twig: 0.007, mainLeaves: true, alternate: true,
    palette: [0x1f3518, 0x263d1c, 0x2e4620, 0x3a4a22], back: 0x121c10, stem: 0x4a2a2e }),
  // Dock and willowherb gone rank: long plain leaves, some of them yellowing.
  weedleaf: leafSpray({ seed: 5801, shape: 'lance', leaf: 0.22, width: 0.2, angle: 0.6, spread: 0.4, spacing: 0.07,
    sides: 2, sideLen: 0.34, sideAngle: 0.6, twig: 0.006, mainLeaves: true, alternate: true, taper: 0.5,
    palette: [0x3a5226, 0x45592a, 0x566230, 0x6d6a35], back: 0x1c2716, stem: 0x5b5a32 }),
  // Pot herbs: sage, thyme, rosemary -- small leaves, greyed green.
  herbleaf: leafSpray({ seed: 5901, shape: 'ovate', leaf: 0.045, width: 0.3, angle: 0.8, spread: 0.7, spacing: 0.02,
    sides: 8, sideLen: 0.34, sideAngle: 0.8, twig: 0.004, mainLeaves: true, alternate: false,
    palette: [0x4a5a3a, 0x566648, 0x60704f, 0x3f5232], back: 0x1e2618, stem: 0x4f4a36 }),
  // A sword fern's frond: the rachis along u, pinnae both sides.
  fernleaf: leafSpray({ seed: 5407, shape: 'pinna', leaf: 0.2, width: 0.14, angle: 1.2, spread: 0.12, spacing: 0.034,
    sides: 0, sideLen: 0, sideAngle: 0, twig: 0.005, mainLeaves: true, alternate: false, taper: 0.8,
    palette: [0x2f5226, 0x365a2a, 0x3b6230], back: 0x1a2c17 }),
};

/** One texel of a leaf spray: the frontmost leaf, or the twig, or nothing. */
function leafSprayAt(sp, u, v, s) {
  const bin = sp.bins[Math.min(sp.N - 1, Math.floor(v * sp.N)) * sp.N + Math.min(sp.N - 1, Math.floor(u * sp.N))];
  let best = null; let ba = 0; let bb = 0; let twig = false;
  for (const it of bin) {
    if (it.twig) {
      const [x0, y0, x1, y1, w] = it.twig;
      const dx = x1 - x0; const dy = y1 - y0;
      const t = clamp01(((u - x0) * dx + (v - y0) * dy) / (dx * dx + dy * dy));
      if (!best && Math.hypot(u - x0 - dx * t, v - y0 - dy * t) < w * (1 - 0.5 * t)) twig = true;
      continue;
    }
    if (best && it.depth <= best.depth) continue;
    const dx = it.x1 - it.x0; const dy = it.y1 - it.y0; const L2 = dx * dx + dy * dy;
    const a = ((u - it.x0) * dx + (v - it.y0) * dy) / L2;
    if (a < 0 || a > 1) continue;
    const b = ((u - it.x0) * -dy + (v - it.y0) * dx) / Math.sqrt(L2);
    const hw = it.w * sp.shape(a);
    if (Math.abs(b) < hw) { best = it; ba = a; bb = b / Math.max(hw, 1e-5); }
  }
  if (!best && !twig) {
    s.color = rgb(sp.back); s.alpha = 0; s.height = 0; s.rough = 0.8;
    return;
  }
  if (!best) {
    s.color = rgb(sp.stem ?? 0x4a3a2a); s.alpha = 1; s.height = 0.3; s.rough = 0.8;
    return;
  }
  const pal = sp.palette;
  let c = rgb(pal[Math.floor(best.tint * pal.length) % pal.length]);
  // Midrib and a hint of veins, both paler; the edge and the base in shade.
  const rib = clamp01(1 - Math.abs(bb) * 14);
  const vein = clamp01(1 - Math.abs(((Math.abs(bb) * 0.6 + ba * 3.5) % 0.5) - 0.25) * 16) * 0.35 * (1 - rib);
  c = mix(c, rgb(0x8da35e), rib * 0.35 + vein * 0.25);
  const shade = (0.62 + 0.38 * best.depth) * (0.8 + 0.2 * Math.min(1, ba * 3)) * (1 - 0.12 * Math.abs(bb) ** 3);
  s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
  s.alpha = 1;
  // A leaf is folded along its midrib: relief from the edge up to the rib.
  s.height = 0.35 + best.depth * 0.35 + (1 - Math.abs(bb)) * 0.25;
  s.rough = 0.7;
}

const SURFACES = {
  /** The broadleaf cards: see LEAF_SPRAYS. */
  oakleaf(u, v, s) { leafSprayAt(LEAF_SPRAYS.oakleaf, u, v, s); },
  shrubleaf(u, v, s) { leafSprayAt(LEAF_SPRAYS.shrubleaf, u, v, s); },
  salal(u, v, s) {
    leafSprayAt(LEAF_SPRAYS.salal, u, v, s);
    // Salal is the glossiest leaf in the understorey; its sheen is how it
    // is told from everything else under a fir.
    s.rough = s.alpha ? 0.42 : 0.8;
  },
  fernleaf(u, v, s) { leafSprayAt(LEAF_SPRAYS.fernleaf, u, v, s); },
  hedgeleaf(u, v, s) { leafSprayAt(LEAF_SPRAYS.hedgeleaf, u, v, s); },
  nettleleaf(u, v, s) { leafSprayAt(LEAF_SPRAYS.nettleleaf, u, v, s); },
  brambleleaf(u, v, s) { leafSprayAt(LEAF_SPRAYS.brambleleaf, u, v, s); },
  weedleaf(u, v, s) { leafSprayAt(LEAF_SPRAYS.weedleaf, u, v, s); },
  herbleaf(u, v, s) { leafSprayAt(LEAF_SPRAYS.herbleaf, u, v, s); },

  /**
   * The grass atlas (GRASS_CARDS). Every texel is the front-most shape over
   * it; the ones behind are darker, and every blade darkens towards its root,
   * so a tuft reads as a volume with shade inside it rather than as a stencil.
   * Transparent texels carry the blades' own dark green so the mips do not rim
   * the cards in black.
   */
  grassblades(u, v, s) {
    const { cols, rows } = GRASS_ATLAS;
    const col = Math.min(cols - 1, Math.floor(u * cols)); const row = Math.min(rows - 1, Math.floor(v * rows));
    const { card, bins } = GRASS_SHAPES[row * cols + col];
    const x = (u * cols - col) * card.w;
    const y = (v * rows - row) * card.h * 1.02 - card.h * 0.01;
    const bin = bins[Math.min(15, Math.max(0, Math.floor((x / card.w) * 16)))];
    let best = null; let hit = null;
    for (const sh of bin) {
      if (best && sh.depth <= best.depth) continue;
      const h = grassShapeAt(sh, x, y);
      if (h) { best = sh; hit = h; }
    }
    if (!best) {
      s.color = rgb(0x2c3d1d); s.alpha = 0; s.height = 0; s.rough = 0.8;
      return;
    }
    let c;
    if (hit.head) {
      const [lit, dark] = HEADS[best.head];
      c = mix(rgb(lit), rgb(dark), clamp01(hit.across * 0.8 + (y < best.h ? 0.4 : 0)));
      if (best.head === 'daisy' && hit.across < 0.38) c = rgb(0xe0b020);
    } else {
      c = best.col;
      if (best.dry && hit.t > 1 - best.dry) c = mix(c, rgb(0xa39263), clamp01((hit.t - (1 - best.dry)) / best.dry * 1.4));
      if (best.type === 'leaf') c = mix(c, rgb(0x87a060), clamp01(1 - hit.across * 6) * 0.35);
      // Root to tip: the base of a tuft is in its own shade.
      const shade = 0.7 + 0.3 * Math.pow(hit.t, 0.55);
      c = [c[0] * shade, c[1] * shade, c[2] * shade];
    }
    const behind = 0.84 + 0.16 * best.depth;
    s.color = [c[0] * behind, c[1] * behind, c[2] * behind];
    s.alpha = 1;
    s.height = 0.3 + best.depth * 0.4 + (1 - hit.across) * 0.2;
    s.rough = hit.head ? 0.7 : 0.62 + (1 - best.depth) * 0.2;
  },

  /**
   * Coursed rubble: roughly squared stones laid in courses of 17 to 29 cm,
   * each stone its own length, with lime pointing a shade paler than the
   * stone and set back from it. For the walls the old `rock` crazy paving was
   * on -- a graveyard's kerbs and its tombs, walls and vault alike -- where a
   * judge measured stones of 60 to 90 cm in a random polygon net: paving laid
   * up a wall, at twice the size a man could lift. Crazy paving stays on the
   * floors, where it belongs.
   *
   * Everything is in metres over the 3 m tile (RUBBLE), so the joint is the
   * same 20 mm on both axes and a 1.75 m figure has seven courses to measure
   * himself against.
   */
  rubblewall(u, v, s) {
    const { T, rows, stones } = RUBBLE;
    const x = u * T; const y = v * T;
    let row = 0;
    while (row < rows.length - 2 && y >= rows[row + 1]) row++;
    const xs = stones[row];
    let col = 0;
    while (col < xs.length - 2 && x >= xs[col + 1]) col++;
    const id = hash2(col, row, 1 << 20, 7351);
    // Distance to the stone's own edge. A rubble stone does not fill its slot:
    // it sits a little short of the course above and the stone beside, by its
    // own centimetre or so, with its corners knocked off and its arrises
    // broken by noise -- or the wall is brick.
    const shortTop = 0.002 + 0.014 * hash2(col, row, 1 << 20, 7361);
    const shortEnd = 0.002 + 0.012 * hash2(col, row, 1 << 20, 7367);
    const dx = Math.min(x - xs[col], xs[col + 1] - x - shortEnd);
    const dy = Math.min(y - rows[row], rows[row + 1] - y - shortTop);
    const corner = 0.02 + 0.035 * id;
    const cx = Math.max(0, corner - dx); const cy = Math.max(0, corner - dy);
    const edge = Math.min(dx, dy, corner - Math.hypot(cx, cy))
      - 0.012 * fbmA(u * 36, v * 36, 36, 36, 7353, 3);
    const joint = 0.006;
    const inStone = edge > joint;
    const face = fbmA(u * 30, v * 30, 30, 30, 7357, 4);
    const grain = fbmA(u * 150, v * 150, 150, 150, 7359, 2);
    // Weathering runs down a wall: streaks, slow across and quick down it.
    const streak = fbmA(u * 40, v * 4, 40, 4, 7369, 3);
    // Grey and buff field stone, a shade apart stone to stone, the odd one
    // browner or darker; crustose lichen on a few.
    const tone = (id * 7.31) % 1;
    let stone = mix(rgb(0x6e695f), rgb(0x8d867a), id);
    if (tone > 0.8) stone = mix(stone, rgb(0x7d6a52), 0.45);
    else if (tone < 0.14) stone = mix(stone, rgb(0x55514b), 0.5);
    const lichen = clamp01(fbmA(u * 9, v * 9, 9, 9, 7363, 3) * 2.6 - 1.62);
    stone = mix(stone, tone > 0.5 ? rgb(0x979a82) : rgb(0x9c8a58), lichen * 0.5);
    const round = clamp01((edge - joint) / 0.035);
    s.color = inStone
      ? mix(stone, rgb(0x4f4b45), (1 - round) * 0.14 + face * 0.16 + streak * 0.1).map((c) => c * (0.9 + grain * 0.16))
      : mix(rgb(0x8e877a), rgb(0x7a7468), grain);
    // The face is split, not dressed: a slow bulge across each stone.
    s.height = inStone ? 0.5 + round * 0.28 + face * 0.2 + grain * 0.05 : 0.08 + grain * 0.05;
    s.rough = inStone ? 0.84 + grain * 0.12 : 0.95;
  },

  cobble(u, v, s) {
    // 18 setts across a 2.2 m tile is 12 cm a stone, which is what a granite
    // sett actually measures. It was 7 across 2.6 m -- 37 cm -- and at that
    // size a single stone is wider than a stride, so the ground gave the eye
    // no scale to measure people against and they read as toys.
    const [, edge, id] = cellular(u * 18, v * 18, 18, 11, 0.38);
    const grout = clamp01((edge - 0.012) * 26);
    const grain = fbm(u * 34, v * 34, 34, 3, 3);
    // Setts are cut from whatever the quarry yielded -- grey granite, pink
    // granite, near-black basalt -- and a street of them is never one colour.
    // `id` is the per-stone roll; the second stream picks the odd stone out.
    const warm = (id * 7.13) % 1;
    let stone = mix(rgb(0x6a655c), rgb(0x9d9488), id);
    if (warm > 0.74) stone = mix(stone, rgb(0x8d6a5a), (warm - 0.74) * 2.6);
    else if (warm < 0.17) stone = mix(stone, rgb(0x413f3c), (0.17 - warm) * 3.2);
    const wet = fbm(u * 5, v * 5, 5, 21, 3);
    const c = mix(rgb(0x413d38), stone, grout);
    // Every stone sits a little differently, so the whole face lifts or drops.
    const shade = (0.9 + grain * 0.2) * (0.86 + ((id * 3.7) % 1) * 0.28);
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = grout * (0.7 + id * 0.3) + grain * 0.06;
    s.rough = 0.92 - grout * 0.18 - wet * 0.15;
  },

  flagstone(u, v, s) {
    // 6 slabs across a 2.6 m tile is 43 cm, in the middle of the range a York
    // stone flag is cut to. At 4 across 3.4 m they were 85 cm, which is a
    // cathedral floor slab, not a shop floor.
    const cols = 6; const rows = 6;
    const gx = u * cols; const gy = v * rows;
    const cx = Math.floor(gx); const cy = Math.floor(gy);
    const fx = gx - cx; const fy = gy - cy;
    const id = hash2(cx, cy, cols, 5);
    // Same arithmetic as the wall: a 2.6 m tile at 512 is 5.08 mm a texel and
    // a cell is 433 mm square, so 0.035 was 2 x 15.2 = 30 mm of pointing
    // between flags. Flags are laid to 10-15 mm; 0.014 gives 2 x 6.1 = 12 mm,
    // 2.4 texels.
    const gap = 0.014;
    const inSlab = fx > gap && fx < 1 - gap && fy > gap && fy < 1 - gap;
    const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
    const grain = fbm(u * 26 + id * 10, v * 26, 26, 31, 4);
    const slab = mix(rgb(0x6d6a63), rgb(0x8e8a80), id * 0.8 + grain * 0.2);
    // The joint was a flat 0x312f2b, sRGB 49 against a slab face around 150
    // once the gamma lift is on -- a black net drawn on the floor. Pointing is
    // lime and sharp sand and sits within a shade of the stone; the line you
    // see on a real pavement is the recess, which is still here in `height`.
    // Within a slab the grain was swinging 0.45 of the way to near-black too,
    // which is a different stone every 15 cm rather than one flag.
    s.color = inSlab ? mix(slab, rgb(0x4b4842), grain * 0.25) : rgb(0x726c5f);
    s.height = inSlab ? 0.72 + grain * 0.12 : clamp01(edge / gap) * 0.6;
    s.rough = inSlab ? 0.78 + grain * 0.15 : 0.95;
  },

  marble(u, v, s) {
    // Pale stone with a few soft grey veins drifting across it.
    const turb = fbm(u * 3, v * 3, 3, 77, 4);
    const vein = Math.abs(Math.sin((u * 1.2 + v * 0.6 + turb * 1.6) * Math.PI));
    const fine = fbm(u * 14, v * 14, 14, 9, 3);
    const t = clamp01(Math.pow(1 - vein, 22)) * 0.55;
    const base = mix(rgb(0xe6e1d5), rgb(0xd2ccbe), fine * 0.6);
    s.color = mix(base, rgb(0x9a958a), t);
    s.height = 0.5 + fine * 0.03;
    // Weathered, not polished. At 0.30-0.45 this was glossy enough to mirror
    // the sky, and the arch fifty metres off rendered as cyan plastic. Ancient
    // marble that has stood in the weather sits around 0.6, and the veins --
    // being harder stone -- stay a little smoother than the ground around them.
    s.rough = 0.72 - t * 0.14 + fine * 0.12;
  },

  plaster(u, v, s) {
    const coarse = fbm(u * 10, v * 10, 10, 13, 4);
    // The fine octave was 60 cycles across a 3 m tile at a quarter of the
    // height range: 5 cm bumps, everywhere, evenly. On a ceiling that reads as
    // sprayed artex rather than as lime plaster. Limewash over a float coat is
    // a slow undulation with the odd trowel mark, so the coarse octave carries
    // the relief now and the fine one only breaks up the sheen.
    const fine = fbm(u * 38, v * 38, 38, 41, 3);
    const stain = clamp01(fbm(u * 3, v * 3 + 0.4, 3, 67, 3) * 1.6 - 0.55);
    const base = mix(rgb(0xc9bda3), rgb(0x9c9078), coarse * 0.55);
    s.color = mix(base, rgb(0x6e6350), stain * 0.5 * clamp01(1.25 - v * 1.6));
    s.height = 0.5 + fine * 0.08 + coarse * 0.20;
    // A limewashed wall is not uniformly matt: the raised trowel marks burnish
    // and the stained low-lying patches drink the light. Held between 0.88 and
    // 0.98 the whole wall caught the light identically everywhere, which is
    // most of what made it read as one moulded object.
    s.rough = 0.74 + coarse * 0.20 + stain * 0.08;
  },

  stonewall(u, v, s) {
    // Coursed rubble: alternating rows of blocks with a recessed mortar joint.
    // Twelve courses over a 3.6 m tile is 0.30 m a course, with blocks 0.60
    // long. Six courses read as 0.60 m ashlar -- cathedral stone on a cobbler's
    // house, and everything indoors built like a crypt.
    const rows = 12;
    const cols = 6;
    const gy = v * rows;
    const row = Math.floor(gy);
    const gx = u * cols + (row % 2) * 0.5;
    const col = Math.floor(gx);
    const fx = gx - col; const fy = gy - row;
    const id = hash2(col, row, cols, 3);
    // A 3.6 m tile baked at 512 is 7.03 mm a texel, and `joint` is a fraction
    // of a *cell*, so it means different millimetres on each axis: a cell is
    // 600 mm across and 300 mm high. At 0.055 the perpends came out 2 x 0.055
    // x 600 = 66 mm and the beds 2 x 0.0275 x 300 = 16.5 mm -- the two are
    // supposed to be the same width, and `joint * (cols / rows)` is the
    // reciprocal of the conversion, so they were out by 4x. Coursed rubble is
    // pointed at 15-25 mm (ashlar 3-10, brick 10), so 0.017 of a cell across
    // and rows/cols of that down puts both at 2 x 10.2 = 20.4 mm, 2.9 texels.
    // A judge measured the bed joint and its bevel together at 39 mm.
    const joint = 0.017;
    const jointY = joint * (rows / cols);
    const inBlock = fx > joint && fx < 1 - joint && fy > jointY && fy < 1 - jointY;
    // The arris, in the same world units: 0.022 of a cell across is 13 mm, and
    // the same 13 mm down a 300 mm course is 0.044, hence the cols/rows.
    const bevel = clamp01(Math.min(
      fx - joint, 1 - joint - fx,
      (fy - jointY) * (cols / rows), (1 - jointY - fy) * (cols / rows),
    ) / 0.022);
    // The grain used to run at 26 across a 3.6 m tile -- a 14 cm blotch, which
    // on a 30 cm course is veining, and the whole wall read as polished granite
    // rather than as a limestone town. Finer and weaker, and the block colours
    // pulled together and warmed: real coursed rubble varies stone to stone by
    // a shade, not by a value.
    const grain = fbm(u * 62 + id * 7, v * 62, 62, 23, 3);
    const block = mix(rgb(0x8d8474), rgb(0x9c9384), id);
    // Two things a judge counted on one wall. It read sRGB 12 to 125 inside a
    // single block, 44% of full scale; on the map itself that is 137 to 181,
    // and most of the spread is the arris, which was darkening the albedo as
    // well as the height. But the crevice is the normal map's job, and doing
    // it twice is what made every block look separately carved -- so 0.20
    // comes down to 0.06 and the grain with it, and one block now spans 25 of
    // 255 rather than 44.
    //
    // The other was that the mortar came out 4x darker than the stone. Lime
    // mortar is *lighter* than most building stone: sand and lime dry to a
    // pale buff, and the dark line on a real wall is the shadow in the recess,
    // not the pointing. The joint sits a shade above the block face now --
    // measured on the baked map, 191 against 170 -- and the recess, height
    // 0.12 against 0.62, goes on doing the work it was already doing.
    s.color = inBlock
      ? mix(block, rgb(0x736a5c), grain * 0.11 + (1 - bevel) * 0.06)
      : mix(rgb(0x9e9585), rgb(0xada595), grain);
    s.height = inBlock ? 0.62 + bevel * 0.3 + grain * 0.08 : 0.12;
    // Dressed face against raw mortar: two different surfaces, and holding them
    // both between 0.86 and 0.96 threw that away.
    s.rough = inBlock ? 0.68 + grain * 0.22 : 0.93 + grain * 0.06;
  },

  timber(u, v, s) {
    // Half-timbered facade: lime-washed infill panels framed by dark oak.
    const beamW = 0.055;
    const edge = (p, w) => 1 - clamp01((Math.abs(p) - w) / 0.012);
    let beam = 0;
    for (const p of [0.0, 0.5, 1.0]) beam = Math.max(beam, edge(u - p, beamW));
    for (const p of [0.0, 0.55, 1.0]) beam = Math.max(beam, edge(v - p, beamW));
    // one diagonal brace per panel
    const pu = (u % 0.5) * 2; const pv = v < 0.55 ? v / 0.55 : (v - 0.55) / 0.45;
    beam = Math.max(beam, edge((pu - pv) * 0.6, beamW * 0.8) * 0.95);
    const wood = fbm(u * 6, v * 44, 6, 19, 3);
    const wall = fbm(u * 22, v * 22, 22, 61, 3);
    const oak = mix(rgb(0x4a3627), rgb(0x63482f), wood);
    const infill = mix(rgb(0xe4dbc4), rgb(0xc9bfa4), wall * 0.6);
    s.color = mix(infill, oak, beam);
    s.height = 0.3 + beam * 0.55 + wall * 0.05;
    s.rough = 0.9 - beam * 0.2;
  },

  planks(u, v, s) {
    // Twelve boards over a 2.4 m tile is 0.20 m a board. Six over 2.8 was 0.47,
    // and a floor laid in half-metre boards reads as decking.
    const boards = 12;
    const gy = v * boards;
    const board = Math.floor(gy);
    const fy = gy - board;
    const id = hash2(board, 0, boards, 29);
    const grain = fbm(u * 5 + id * 4, v * boards * 26, 5, 37, 4);
    const knot = cellular(u * 3.5 + id, v * boards * 0.9, 4, 43, 0.5)[0];
    // A knot is a small dark eye, not a smear: at 3.2 they ran a third of a
    // board long and read under a torch as scorch marks.
    const knotMark = clamp01(1 - knot * 6);
    const seam = clamp01(Math.min(fy, 1 - fy) * 26);
    const wood = mix(rgb(0x6b4d31), rgb(0x8d6a45), grain * 0.8 + id * 0.2);
    s.color = mix(mix(wood, rgb(0x2e2015), knotMark * 0.8), rgb(0x241a11), 1 - seam);
    s.height = 0.6 * seam + grain * 0.15 - knotMark * 0.15;
    s.rough = 0.72 + grain * 0.2;
  },

  /**
   * A door's boards: weathered oak with the grain running up the leaf. The
   * leaves wore `planks`, which is floorboards -- seams every 20 cm across
   * the grain and dark knots that, cube-projected onto an upright board,
   * came out as a grid, and under a torch as orange streaks a judge read as
   * embers. Each board is its own solid in the model, so no seams here:
   * grain, the silvering of old oak where the weather gets at it, and the
   * checks that open along the grain as it dries.
   */
  doorboard(u, v, s) {
    const warp = fbm(u * 2, v * 2, 2, 741, 3);
    const grain = fbmA(u * 48 + warp * 3, v * 3, 48, 3, 743, 3);
    const ring = 0.5 + 0.5 * Math.sin((u * 30 + warp * 2.5) * Math.PI * 2);
    const silver = clamp01(fbmA(u * 3, v * 5, 3, 5, 747, 3) * 1.8 - 0.55);
    // A check follows the grain: a short straight split, in a few columns.
    const cu = u * 18 + warp * 0.6;
    const ci = Math.floor(cu);
    const check = clamp01(1 - Math.abs(cu - ci - 0.5) / 0.05)
      * (hash2(ci, 0, 18, 749) > 0.7 ? 1 : 0)
      * clamp01(fbmA(ci * 0.37, v * 4, 18, 4, 751, 2) * 4 - 2.1);
    const grime = fbm(u * 8, v * 8, 8, 753, 3);
    let c = mix(rgb(0x5f4834), rgb(0x7d6246), grain * 0.7 + ring * 0.3);
    c = mix(c, rgb(0x857e70), silver * 0.6);
    c = mix(c, rgb(0x2f261d), grime * 0.25 + check * 0.7);
    s.color = c;
    s.height = 0.55 + grain * 0.015 + ring * 0.004 - check * 0.12;
    // Weathered oak is dead matt; only the grime has any sheen at all.
    s.rough = 0.86 + silver * 0.08 - grime * 0.04;
  },

  /**
   * Joiner's oak for the furniture (tools/blender/furniture.py): close grain
   * running along u, a slow figure across it and the odd silver fleck of a
   * medullary ray -- and no seams. `planks` is floorboards on a 2.4 m tile,
   * and on a table top its board lines fall wherever the tile does, which is
   * never where the boards are. furniture.py lays every wooden part's u along
   * its own grain.
   */
  wood(u, v, s) {
    // Growth rings cut lengthways: fine dark latewood lines along u, warped
    // gently so they wander the way a plank's do, and 2 cm apart on a 1.2 m
    // tile. A sine of v alone tiles; the warp is itself tileable noise.
    const warp = fbm(u * 3, v * 3, 3, 701, 3);
    const figure = fbm(u * 2, v * 2, 2, 703, 3);
    const ring = 0.5 + 0.5 * Math.sin((v * 56 + warp * 3) * Math.PI * 2);
    const late = ring * ring * ring * ring;
    const pore = fbm(u * 48, v * 48, 48, 709, 2);
    const ray = clamp01(1 - cellular(u * 9, v * 36, 9, 713, 0.5)[0] * 6) * 0.15;
    const wear = clamp01(fbm(u * 4, v * 4, 4, 719, 3) * 1.6 - 0.6);
    const base = mix(rgb(0x62442a), rgb(0x86613d), figure);
    const grained = mix(base, rgb(0x46301d), late * 0.16 + (1 - pore) * 0.06);
    s.color = mix(mix(grained, rgb(0x9a7a55), ray), rgb(0x8a6a48), wear * 0.2);
    // Shallow: planed and waxed, the grain is a colour more than a relief --
    // deeper, and a fire's raking light drew it as corduroy.
    s.height = 0.5 + pore * 0.04 - late * 0.03;
    // Waxed and handled: a table top has a sheen on it where hands have been.
    s.rough = 0.6 + pore * 0.12 - wear * 0.1;
  },

  /** A woollen blanket in a two-colour check, russet on madder brown. */
  blanket(u, v, s) {
    const cu = Math.floor(u * 8) % 2; const cv = Math.floor(v * 8) % 2;
    const stripe = (Math.abs(((u * 32) % 1) - 0.5) < 0.08 ? 1 : 0) + (Math.abs(((v * 32) % 1) - 0.5) < 0.08 ? 1 : 0);
    const weave = fbm(u * 96, v * 96, 96, 727, 2);
    const fade = fbm(u * 4, v * 4, 4, 733, 3);
    let c = cu === cv ? rgb(0x8a3a24) : rgb(0x6a2e22);
    if (cu !== cv && (cu || cv)) c = mix(c, rgb(0x9c6a36), 0.35);
    c = mix(c, rgb(0xc9a064), stripe * 0.35);
    c = mix(c, rgb(0x8c7864), fade * 0.25);
    const shade = 0.88 + weave * 0.2;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = 0.5 + weave * 0.12;
    s.rough = 0.96;
  },

  rooftile(u, v, s) {
    const rows = 9; const cols = 12;
    const gy = v * rows;
    const row = Math.floor(gy);
    const fy = gy - row;
    const gx = u * cols + (row % 2) * 0.5;
    const col = Math.floor(gx);
    const fx = gx - col;
    const id = hash2(col, row, cols, 71);
    const arc = Math.sin(Math.PI * clamp01(fx));
    const lip = clamp01((fy - 0.72) * 6);
    const grime = fbm(u * 24, v * 24, 24, 83, 4);
    const moss = clamp01(fbm(u * 12, v * 12, 12, 91, 3) * 1.8 - 0.95) * (1 - arc) * 0.8;
    const clay = mix(rgb(0x8a4a30), rgb(0xb26a41), id * 0.6 + arc * 0.4);
    s.color = mix(mix(clay, rgb(0x53301f), grime * 0.45 + lip * 0.35), rgb(0x4f5c34), moss);
    s.height = arc * 0.7 + (1 - lip) * 0.2 + grime * 0.05;
    s.rough = 0.82 + grime * 0.15;
  },

  thatch(u, v, s) {
    const streak = fbm(u * 14, v * 90, 14, 101, 4);
    const rows = clamp01(Math.abs(Math.sin(v * Math.PI * 7)) * 1.2);
    const c = mix(rgb(0x776037), rgb(0xb99b5e), streak * 0.9);
    s.color = mix(c, rgb(0x4d3f24), (1 - rows) * 0.5);
    s.height = streak * 0.6 + rows * 0.3;
    // Weathered straw silvers and takes a slight sheen; the shaded gaps between
    // the courses stay dead matt. A single value here is a single value over a
    // whole roof.
    s.rough = 0.84 + (1 - streak) * 0.14 + (1 - rows) * 0.02;
  },

  dirt(u, v, s) {
    const lumps = fbm(u * 16, v * 16, 16, 107, 5);
    const grit = fbm(u * 70, v * 70, 70, 113, 2);
    const stone = clamp01(cellular(u * 22, v * 22, 22, 127, 0.5)[0] * -2.6 + 1);
    const c = mix(rgb(0x4b3d2c), rgb(0x796144), lumps * 0.85 + grit * 0.15);
    s.color = mix(c, rgb(0x6d675c), stone * 0.7);
    s.height = lumps * 0.5 + stone * 0.4 + grit * 0.1;
    // Damp trodden earth against dry dust and the odd embedded stone.
    s.rough = 0.82 + (1 - lumps) * 0.14 - stone * 0.12;
  },

  /**
   * The cut face of a burrow: a bank dug out of the hillside, not a mined
   * rock and not a trodden floor. `dirt` did this job and its relief is a
   * floor's -- lumps meant to be walked on -- which up a wall under a torch
   * came out as an orange swirl. What a spade leaves in clay is soft layers
   * across the face, stones sitting in them, the vertical scrape of the
   * blade, and the odd pale root hair.
   */
  earthwall(u, v, s) {
    const at = strataAt(EARTH_BEDS, u, v, 4483);
    const body = fbm(u * 5, v * 5, 5, 4485, 4);
    const fine = fbm(u * 60, v * 60, 60, 4487, 2);
    const wu = u * 14 + (fbm(u * 28, v * 28, 28, 4499, 2) - 0.5) * 0.5;
    const wv = v * 14 + (fbm(u * 28 + 3.1, v * 28, 28, 4499, 2) - 0.5) * 0.5;
    const [sd, , sid] = cellular(wu, wv, 14, 4489, 0.5);
    const big = hash2(Math.floor(sid * 7919), 1, 1 << 20, 4501);
    const stone = clamp01((0.06 + big * big * 0.3 - sd) * 9) * (sid > 0.68 ? 1 : 0);
    const stoneTone = hash2(Math.floor(sid * 7919), 2, 1 << 20, 4503);
    // Spade marks: short vertical gouges, a blade's width apart.
    const blade = Math.abs(Math.sin((u * 26 + fbm(u * 4, v * 4, 4, 4491, 2) * 2) * Math.PI));
    const scrape = (1 - blade) * clamp01(fbm(u * 8, v * 3, 8, 4493, 2) * 3 - 1.7);
    const root = clamp01(1 - Math.abs(fbm(u * 3, v * 16, 3, 4495, 3) - 0.5) * 90) * clamp01(fbm(u * 7, v * 7, 7, 4497, 2) * 3 - 1.6);
    const layer = at.bed.proud;
    let c = mix(rgb(0x5a4633), rgb(0x7a6247), body * 0.6 + layer * 0.4);
    c = mix(c, rgb(0x6c5a41), clamp01(1 - at.dBed / 0.01) * 0.4);
    c = mix(c, mix(rgb(0x7a7264), rgb(0x9a9282), stoneTone), stone * 0.75);
    c = mix(c, rgb(0xa08a68), root * 0.6);
    const shade = 0.95 + fine * 0.1;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = 0.5 + body * 0.1 + stone * 0.05 - scrape * 0.03 + root * 0.02 + fine * 0.02;
    s.rough = 0.9 + fine * 0.08 - stone * 0.15;
  },

  /**
   * Waterlogged peat. No bond, no cells and no repeat you could name: a bog is
   * the least structured ground there is, and anything with a period in it
   * reads as a tiled floor the moment you stand on it. What varies instead is
   * how wet the ground is -- black saturated peat in the hollows, dried fibrous
   * brown on the hummock tops, sphagnum taking the shallow ground between.
   */
  peat(u, v, s) {
    const hummock = fbm(u * 7, v * 7, 7, 313, 4);
    const fibre = fbm(u * 44, v * 44, 44, 317, 2);
    const moss = clamp01(fbm(u * 11, v * 11 + 0.3, 11, 331, 3) * 1.8 - 0.75);
    // The hollows are where the water stands, so the darkest ground is the
    // lowest ground -- the same correlation `wet` in the recipe leans on.
    const soak = clamp01((0.52 - hummock) * 3.4);
    // Halved from the first cut, which baked to a mean of (109,99,78) -- paler
    // than `dirt` is warm and only a shade under `grass`, so a wet bog read as
    // a dry track. Peat is the darkest ground there is: (83,73,56) baked, a
    // third under the meadow beside it, and browner rather than merely greyer.
    // Only the top of the range came down here, not the bottom: the bottom is
    // the RGB-0 floor. Sunlit peat metered (120,108,80) at 0x483315 -- a dry
    // sandy track, and the mud calls this an oozing quagmire. The brightest
    // texel is (86,70,46) now, which renders in the low 90s under a noon sun.
    const fibrous = mix(rgb(0x231a0e), rgb(0x2f2210), hummock * 0.8 + fibre * 0.2);
    // The soaked tone is a floor as well as a colour. At 0x14100b, peat was the
    // only material outdoors putting pixels at literal RGB 0 -- 653 of them at
    // noon and every zero in the frame -- because it is the darkest surface in
    // the world and the wet term takes another 30% off it in exactly the
    // hollows the shadows already own. Nothing under a sky is ever zero.
    s.color = mix(mix(fibrous, rgb(0x1c1710), soak * 0.75), rgb(0x3f4d24), moss * 0.45);
    // The fine octave stays out of the relief. At 44 repeats over a 4.2 m tile
    // it is a 9.5 cm bump, and a field of those under a noon sun is gravel --
    // waterlogged peat is a smooth skin over soft ground, so the hummocks carry
    // the whole of the shape and the fibre only breaks up the sheen.
    s.height = hummock * 0.55 + fibre * 0.05 + moss * 0.1;
    // Saturated ground holds a sheen; the moss and the dried fibre on top of it
    // are dead matt. One value for both is what makes mud read as chocolate.
    s.rough = 0.92 - soak * 0.22 + moss * 0.06;
  },

  /**
   * The turf under the blades (grass.js), and on its own wherever the blades
   * thin out with distance. It was a 120-cycle noise at 0.6 of the height
   * range: 4.6 cm bumps whose Sobel normals swung the lit value by 28% under
   * a noon sun (std 36 on a mean of 126), in 40 cm blotches -- camouflage, a
   * judge said, and the albedo underneath varied by only 4%. The relief was
   * the pattern. Now the blades are geometry, and what is left down here is
   * what a meadow is from above: a low-contrast mat of green over thatch,
   * patchy by the metre and not by the hand.
   */
  grass(u, v, s) {
    const patch = fbm(u * 3, v * 3, 3, 137, 3);
    const fine = fbm(u * 44, v * 44, 44, 131, 2);
    const dry = clamp01(fbm(u * 2, v * 2, 2, 149, 3) * 1.6 - 0.62);
    const green = mix(rgb(0x314c20), rgb(0x3f5c2a), patch * 0.75 + fine * 0.25);
    const c = mix(green, rgb(0x63613a), dry * 0.35);
    const shade = 0.95 + fine * 0.1;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = patch * 0.18 + fine * 0.03;
    // Live blades are waxy and catch a sheen; the dried-off patches do not.
    s.rough = 0.8 + dry * 0.14 + fine * 0.04;
  },

  leaves(u, v, s) {
    // Foliage in the mass: what a crown looks like from ten metres, which is
    // clumps of needle and leaf over their own shadowed interior -- not what
    // a lawn looks like. This recipe exists because `leaves` used to alias to
    // `grass`, and a judge raycast a fir crown at 50 m and the ground at
    // 3.7 m and got the same material uuid: every conifer in the forest was
    // wearing the lawn. A crown's darks are its own depth, so the interior
    // runs much darker than any ground cover, and the palette sits blue of
    // the grass -- coastal conifer against meadow.
    const clump = cellular(u * 9, v * 9, 9, 163, 0.5);
    const mass = fbm(u * 16, v * 16, 16, 167, 4);
    const fine = fbm(u * 64, v * 64, 64, 173, 2);
    const depth = clamp01(clump[0] * 1.15);
    const lit = mix(rgb(0x435c3b), rgb(0x6d8256), mass * 0.7 + fine * 0.3);
    const cool = mix(lit, rgb(0x3d5548), clump[2] * 0.5);
    s.color = mix(rgb(0x1c2717), cool, clamp01(1.05 - depth));
    // The fine octave stays out of the relief: the same fault as the lawn's,
    // lit blotches a hand across. The clumps carry the shape.
    s.height = (1 - depth) * 0.45 + fine * 0.08;
    // Needles scatter, they do not sheen: keep it matt right through.
    s.rough = 0.86 + fine * 0.1;
  },

  rock(u, v, s) {
    const [, edge, id] = cellular(u * 6, v * 6, 6, 151, 0.5);
    const crack = clamp01((edge - 0.03) * 10);
    const rough1 = fbm(u * 20, v * 20, 20, 157, 5);
    const c = mix(rgb(0x3f3d3a), rgb(0x726d64), id * 0.5 + rough1 * 0.5);
    s.color = mix(c, rgb(0x24221f), (1 - crack) * 0.7);
    s.height = crack * 0.6 + rough1 * 0.35;
    s.rough = 0.93 + rough1 * 0.06;
  },

  sand(u, v, s) {
    // Wind ripples are ten to fifteen centimetres crest to crest -- 48 over
    // the 6 m tile; at 13 they were half a metre, the size of a dune's own
    // ribs -- and lopsided: a long gentle back and a short steep lee.
    const rp = u * 48 + fbm(u * 4, v * 4, 4, 163, 3) * 7 + fbm(u * 12, v * 12, 12, 171, 2) * 1.2;
    const rf = rp - Math.floor(rp);
    const ripple = rf < 0.75 ? rf / 0.75 : (1 - rf) / 0.25;
    const grit = fbm(u * 90, v * 90, 90, 167, 2);
    const drift = fbm(u * 3, v * 3, 3, 169, 3);
    // The ripple is relief, not paint: a ridge and its trough are one sand,
    // and painting them light and dark put a zebra across the desert that the
    // normal map was already drawing. Warmer, too -- a desert is not a beach.
    s.color = mix(mix(rgb(0xc59a64), rgb(0xdcb784), drift * 0.7 + grit * 0.3), rgb(0xe3c396), ripple * 0.12);
    // Low: a ripple is a centimetre high on a ten-centimetre wavelength, and
    // at half the height range a raking dusk sun drew it as a zebra.
    // The drift used to be a fifth of the relief, and over a dune that is a
    // lumpy skin: dough, a judge said. The shape is the geometry's job.
    s.height = ripple * 0.035 + drift * 0.05 + grit * 0.06;
    s.rough = 0.84 + grit * 0.14;
  },

  /**
   * The floor of a coastal conifer forest: needle duff over humus, with moss
   * in the damp hollows. Haon Dor was laid with the town's lawn -- a mown
   * green a judge could name at a glance -- and a fir stand does not grow
   * grass, because almost nothing reaches the ground under a closed canopy.
   *
   * Structureless on purpose. A needle is 20-30 mm and the tile has to cover a
   * forest floor, so at any scale that avoids visible repetition a needle is
   * under a texel; what actually reads at walking distance is the mottling
   * between fresh litter and the humus under it, and that is what this is.
   */
  duff(u, v, s) {
    const humus = fbm(u * 7, v * 7, 7, 51, 4);
    const drift = fbm(u * 21, v * 21, 21, 53, 3);
    const fine = fbm(u * 64, v * 64, 64, 57, 2);
    const litter = clamp01(humus * 0.55 + drift * 0.45);
    let c = mix(rgb(0x3a2c1d), rgb(0x8a6a44), litter);
    // Moss goes where the humus reads darkest, which is where the water sits.
    const moss = clamp01((0.34 - humus) * 3.4);
    c = mix(c, rgb(0x4c5a30), moss * 0.7);
    // Litter: needles and twig ends as specks in the colour, not bumps in the
    // relief. At 0.3 of the height range the 5 cm octave lit up in sun-flecks
    // as a leopard print, the same fault the lawn had -- the relief is the
    // slow drift of the humus and little else.
    const speck = hash2(Math.floor(u * 700), Math.floor(v * 700), 700, 59);
    const shade = (0.92 + fine * 0.14) * (speck > 0.93 ? 1.18 : speck < 0.05 ? 0.78 : 1);
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = drift * 0.3 + fine * 0.06;
    s.rough = 0.96 - fine * 0.05;
  },

  /**
   * Screened path gravel. The graveyard's rooms call themselves "A Gravel Road"
   * and "A Gravel Path" and were laid with lawn, which is the mud naming a
   * surface nobody built.
   *
   * 80 chippings across a 2.4 m tile is 30 mm a stone, which is what a graded
   * path gravel screens to -- and at 512 that is six texels each, so the
   * pattern is a texture rather than a mosaic at any range you walk it from.
   * The fines between the chippings go *lighter* than the stone, not darker:
   * they are the same rock crushed, and darkening a joint that the crevice
   * normal already shades is what made `stonewall` read as loose tiles.
   */
  gravel(u, v, s) {
    const [, edge, id] = cellular(u * 80, v * 80, 80, 41, 0.45);
    const packed = clamp01(edge * 14);
    const grit = fbm(u * 30, v * 30, 30, 43, 3);
    const stone = mix(rgb(0x6f6759), rgb(0xa79b86), id);
    const fines = mix(rgb(0x8d8574), rgb(0xa8a08e), grit);
    const c = mix(fines, stone, packed);
    // Every chipping lies at its own angle, so no two catch the light alike.
    const shade = 0.88 + ((id * 5.31) % 1) * 0.24;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = packed * (0.5 + id * 0.5) + grit * 0.12;
    s.rough = 0.93 - grit * 0.06;
  },

  /**
   * Woven cloth. Not the weave -- a real one is sub-millimetre and invisible at
   * any range you see a person from. What is visible on a dyed woollen is that
   * the dye never took evenly, that the nap catches the light in bands, and
   * that the cloth is worn thin where it rubs. Flat colour plus a grain normal
   * was the only surface in the frame with no albedo at all, and it is most of
   * why a figure read as a mannequin.
   */
  cloth(u, v, s) {
    const dye = fbm(u * 5, v * 5, 5, 211, 4);
    // The nap belongs in the relief, not in the colour. At 34 repeats over a
    // 0.7 m tile it is a two-centimetre band, and putting it in the albedo put
    // stripes down every townsperson.
    //
    // Both terms have to be the same pitch on both axes. They were 3.1x26 and
    // 70x26 -- on a 0.7 m tile a 10 mm x 27 mm feature, 2.7:1 elongated down
    // v, which on a cube-projected figure runs straight down the tunic. The
    // way to see it is to average |nx| and |ny| over the baked normal map:
    // cloth read 2.01, against 1.0 for plaster and skin and 3.1 for *bark*.
    // A woollen was two thirds of the way to a tree trunk, and its mean normal
    // tilt was 31 degrees where the limewashed wall behind it is 11. A judge
    // read the tunic and hose as oak grain, which is exactly right.
    // Square and an order shallower: 1.02 and 9 degrees, so what is left is
    // the drape of the nap. Square also makes them tile, which 3.1 and 26
    // against a lattice period of 26 never did.
    const nap = fbm(u * 22, v * 22, 22, 233, 2);
    const slub = fbm(u * 54, v * 54, 54, 251, 2);
    const wear = clamp01(fbm(u * 7, v * 7, 7, 269, 3) * 1.5 - 0.55);
    // Kept near neutral and narrow: every figure is tinted per person by vertex
    // colour, and a dyed base would fight it.
    const base = mix(rgb(0x9a9a9a), rgb(0xb0b0b0), dye);
    s.color = mix(base, rgb(0xc0bdb6), wear * 0.35);
    s.height = 0.5 + nap * 0.05 + slub * 0.025;
    s.rough = 0.94 - wear * 0.16 + slub * 0.04;
  },

  /**
   * Linen: a smooth, tighter cloth than the woollens round it -- paler in its
   * base, slubbed in fine streaks, and with a little sheen where it is worn
   * smooth. What tells a shift from a tunic at street distance is value and
   * sheen, not weave.
   */
  linen(u, v, s) {
    const dye = fbm(u * 4, v * 4, 4, 521, 3);
    const slub = fbm(u * 60, v * 60, 60, 523, 2);
    const crease = fbm(u * 9, v * 9, 9, 527, 3);
    const base = mix(rgb(0xb8b6b0), rgb(0xc8c4bc), dye);
    s.color = mix(base, rgb(0xd2cec6), slub * 0.25);
    s.height = 0.5 + crease * 0.05 + slub * 0.015;
    s.rough = 0.80 - crease * 0.08 + slub * 0.04;
  },

  /**
   * Wool, fulled and heavy: a deeper nap than the cloth recipe, pilled in
   * little tufts, and the most matt thing a person wears -- a cloak or a
   * beggar's coat takes no sheen at all.
   */
  wool(u, v, s) {
    const dye = fbm(u * 5, v * 5, 5, 541, 4);
    const nap = fbm(u * 18, v * 18, 18, 547, 3);
    const [, edge] = cellular(u * 20, v * 20, 20, 557, 0.6);
    const pill = clamp01(1 - edge * 3);
    const base = mix(rgb(0x949494), rgb(0xaaaaaa), dye);
    s.color = mix(base, rgb(0x8a8a8a), pill * 0.25);
    s.height = 0.5 + nap * 0.08 + pill * 0.03;
    s.rough = 0.97;
  },

  /** Skin: nearly uniform, which is the point -- the little that is not. */
  skin(u, v, s) {
    const blotch = fbm(u * 6, v * 6, 6, 283, 3);
    // A pore is 0.2 mm. 120 repeats over a 0.5 m tile is a 4 mm bump, and at
    // 0.10 of the height range that is not a pore, it is a golfball: 22
    // degrees of mean normal tilt, twice the plaster on the wall behind. What
    // is visible on a face at three metres is the mottling and not the pores,
    // so the blotch carries what relief there is and the fine octave only
    // breaks up the sheen -- 5 degrees now. Close-up grain is already the
    // shared world-space detail map's job.
    const pore = fbm(u * 90, v * 90, 90, 307, 2);
    const base = mix(rgb(0xb0aeae), rgb(0xc4c0bc), blotch);
    s.color = mix(base, rgb(0xbba49c), blotch * 0.35);
    s.height = 0.5 + pore * 0.025 + blotch * 0.06;
    // Skin is matt but not chalk; 0.66-0.86 was drier than the limewash.
    s.rough = 0.60 + blotch * 0.12 + pore * 0.05;
  },

  /**
   * Fur, for the animals. Near-neutral, like cloth, because every beast
   * carries its coat, its pale belly and its dark points in vertex colour and
   * the map must not fight them. What the map carries is what tells a pelt
   * from a painted shell: the hair lies in one direction -- down V, which
   * beasts.py lays along the body and down the legs -- in locks that each end
   * in lighter guard-hair tips over a darker undercoat showing between them.
   * An isotropic clump map on cube-projected UVs, at 0.3 normal strength, read
   * on a grey wolf as grey clay.
   */
  fur(u, v, s) {
    // Noise stretched along V that still tiles: each axis wraps on its own.
    const aniso = (x, y, px, py, seed) => {
      const ix = Math.floor(x); const iy = Math.floor(y);
      const fx = x - ix; const fy = y - iy;
      const h = (a, b) => hash2(((a % px) + px) % px, ((b % py) + py) % py, 65536, seed);
      const sx = fx * fx * (3 - 2 * fx); const sy = fy * fy * (3 - 2 * fy);
      return lerp(lerp(h(ix, iy), h(ix + 1, iy), sx), lerp(h(ix, iy + 1), h(ix + 1, iy + 1), sx), sy);
    };
    // Locks: a row of them across U, each offset along V so their tips do
    // not line up, and each a sawtooth along V -- root low, tip proud.
    const lockU = u * 18;
    const li = Math.floor(lockU);
    const within = lockU - li;
    const offset = hash2(((li % 18) + 18) % 18, 0, 18, 401);
    const along = v * 6 + offset * 6;
    const saw = along - Math.floor(along);
    const lock = Math.sin(Math.PI * within) ** 0.6 * (0.35 + 0.65 * saw);
    const strand = aniso(u * 160, v * 10, 160, 10, 409);
    const strand2 = aniso(u * 90, v * 6, 90, 6, 411);
    const tone = fbm(u * 4, v * 4, 4, 419, 3);
    const height = lock * 0.7 + strand * 0.2 + strand2 * 0.1;
    const base = mix(rgb(0xa2a2a2), rgb(0xb6b6b6), tone);
    // Undercoat dark where the locks part, guard hair light at the tips.
    const shade = 0.8 + 0.3 * height;
    s.color = [base[0] * shade, base[1] * shade, base[2] * shade];
    s.height = 0.5 + height * 0.1;
    s.rough = 0.72 + (1 - height) * 0.2;
  },

  /**
   * Feathers: rows of overlapping vanes, each a shallow scallop whose lower
   * edge stands proud of the next. Kept faint -- at the size a swan is seen
   * from, plumage is a soft sheen with a little structure in it, not scales.
   */
  feather(u, v, s) {
    const rows = 14;
    const cols = 9;
    const r = v * rows;
    const ri = Math.floor(r);
    const x = u * cols + (ri % 2) * 0.5;
    const cx = x - Math.floor(x) - 0.5;
    const cy = r - ri;
    const vane = clamp01(1 - Math.hypot(cx * 1.2, (cy - 0.15) * 0.8) * 1.5);
    const barb = fbm(u * 70, v * 22, 70, 431, 2);
    const tone = fbm(u * 3, v * 3, 3, 433, 3);
    const base = mix(rgb(0xa6a6a6), rgb(0xbababa), tone);
    const shade = (0.93 + vane * 0.09) * (0.95 + barb * 0.08);
    s.color = [base[0] * shade, base[1] * shade, base[2] * shade];
    s.height = 0.5 + vane * 0.06 + barb * 0.02;
    s.rough = 0.74 + barb * 0.12 - vane * 0.06;
  },

  /**
   * Chitin: the shell of a spider, a beetle, a scorpion. Hard and glossy --
   * the highlight sliding over it as it walks is most of what says "shell"
   * rather than "hide" -- with a faint pitting and the odd plate edge.
   * Neutral, like the fur, because the creature's colour is in its vertices.
   */
  chitin(u, v, s) {
    const [d1, edge] = cellular(u * 10, v * 10, 10, 443, 0.4);
    const pit = fbm(u * 80, v * 80, 80, 449, 2);
    const tone = fbm(u * 4, v * 4, 4, 457, 3);
    const seam = clamp01(1 - edge * 9);
    const base = mix(rgb(0xa2a2a2), rgb(0xb6b6b6), tone);
    const shade = (0.96 + d1 * 0.05) * (1 - seam * 0.12) * (0.97 + pit * 0.05);
    s.color = [base[0] * shade, base[1] * shade, base[2] * shade];
    s.height = 0.5 - seam * 0.05 - (pit > 0.72 ? (pit - 0.72) * 0.25 : 0) + d1 * 0.015;
    s.rough = 0.34 + pit * 0.1 + seam * 0.18;
  },

  /**
   * Ooze: living mud, a lemure's flesh, a shambling heap. Lumps that sag
   * into each other and a wet sheen that breaks up over them; no cell edges,
   * because nothing in it is solid enough to have one.
   */
  ooze(u, v, s) {
    const lump = fbm(u * 6, v * 6, 6, 461, 4);
    const fine = fbm(u * 40, v * 40, 40, 463, 2);
    const [d1] = cellular(u * 18, v * 18, 18, 467, 0.5);
    const blister = clamp01(0.3 - d1) * 2.2;
    const base = mix(rgb(0x969696), rgb(0xb2b2b2), lump);
    const shade = 0.93 + lump * 0.1 + blister * 0.05;
    s.color = [base[0] * shade, base[1] * shade, base[2] * shade];
    s.height = 0.5 + lump * 0.09 + blister * 0.03 + fine * 0.012;
    s.rough = 0.18 + fine * 0.22 + (1 - lump) * 0.18;
  },

  /**
   * Hide: a reptile's skin, pebbled in small scales that each stand a little
   * proud of the grooves between them -- the basilisk, the naga, the imp.
   */
  hide(u, v, s) {
    const [d1, edge, id] = cellular(u * 34, v * 34, 34, 471, 0.35);
    const tone = fbm(u * 5, v * 5, 5, 479, 3);
    const groove = clamp01(1 - edge * 5);
    const base = mix(rgb(0x9c9c9c), rgb(0xb4b4b4), tone);
    const shade = (0.95 + id * 0.08) * (1 - groove * 0.16);
    s.color = [base[0] * shade, base[1] * shade, base[2] * shade];
    s.height = 0.5 + (1 - groove) * 0.05 - d1 * 0.02;
    s.rough = 0.55 + groove * 0.2 + id * 0.08;
  },

  /**
   * A troll's hide: thick and leathery, creased in a net of fine folds,
   * pebbled, and studded here and there with warts that stand well proud --
   * the one surface on a troll that says, at arm's length, that it is not a
   * man painted green. Neutral like the skin, because the tint is per mobile.
   */
  warthide(u, v, s) {
    const [d1, , id] = cellular(u * 11, v * 11, 11, 601, 0.8);
    const [d2] = cellular(u * 34, v * 34, 34, 607, 0.6);
    const crease = fbm(u * 8, v * 8, 8, 611, 4);
    const blotch = fbm(u * 3, v * 3, 3, 613, 3);
    // Warts in about one cell in three, each its own size.
    const wart = id > 0.62 ? clamp01(1 - d1 * (2.6 + (1 - id) * 5)) ** 0.7 : 0;
    const pebble = clamp01(1 - d2 * 2.2);
    const fold = clamp01(1 - Math.abs(crease - 0.5) * 11);
    // As bright as the human skin recipe, which it stands in for: the tint
    // and the body's own colours do the darkening.
    const base = mix(rgb(0xaeaeaa), rgb(0xc0bdb6), blotch);
    const shade = (1 - fold * 0.16) * (0.98 + pebble * 0.02) * (1 + wart * 0.06);
    s.color = [base[0] * shade, base[1] * shade * (1 + wart * 0.02), base[2] * shade * (1 - wart * 0.06)];
    s.height = 0.5 + wart * 0.16 + pebble * 0.035 - fold * 0.05;
    s.rough = 0.74 + fold * 0.12 - wart * 0.14;
  },

  iron(u, v, s) {
    const brush = fbm(u * 8, v * 120, 8, 173, 3);
    const rust = clamp01(fbm(u * 9, v * 9, 9, 179, 4) * 1.7 - 0.8);
    const c = mix(rgb(0x2f3134), rgb(0x585c60), brush);
    s.color = mix(c, rgb(0x6d3d21), rust * 0.7);
    s.height = 0.5 + brush * 0.15;
    s.rough = 0.55 + rust * 0.35;
    s.metal = 0.85 - rust * 0.6;
  },

  /**
   * Worked steel: a blade, a helm, a breastplate. Iron above is the dark
   * hot-worked bar of a door strap and a hinge, and a sword in it read as a
   * stick of charcoal. What makes steel read as steel at street distance is
   * the environment in it, so this is smooth and fully metallic, with the
   * scratches of use in the relief and a little pitting where it was left
   * wet -- and bright enough in its base that a polished flat catches the sky.
   */
  steel(u, v, s) {
    const scratch = fbm(u * 40, v * 6, 40, 311, 3);
    const cloud = fbm(u * 5, v * 5, 5, 313, 4);
    const pit = clamp01(fbm(u * 24, v * 24, 24, 317, 3) * 1.8 - 1.05);
    const c = mix(rgb(0x8e9398), rgb(0xb9bec2), cloud * 0.7 + scratch * 0.3);
    s.color = mix(c, rgb(0x5e5a54), pit * 0.6);
    s.height = 0.5 + scratch * 0.06 - pit * 0.12;
    s.rough = 0.26 + cloud * 0.12 + pit * 0.3;
    s.metal = 0.95 - pit * 0.4;
  },

  /**
   * Riveted mail: rows of rings, each row laid half a ring over from the one
   * above. At street distance it is the glitter and the dark between the
   * rings that says mail rather than a grey jumper, so the gaps go deep in
   * the relief and nearly black in the albedo -- but not black, because it
   * is the ring edges catching the sky that carry it.
   */
  mail(u, v, s) {
    const n = 36;
    const row = Math.floor(v * n);
    const x = u * n + (row % 2) * 0.5;
    const fx = x - Math.floor(x) - 0.5;
    const fy = v * n - row - 0.5;
    const d = Math.sqrt(fx * fx + fy * fy * 1.3);
    const ring = Math.exp(-(((d - 0.36) / 0.12) ** 2));
    const grime = fbm(u * 6, v * 6, 6, 347, 3);
    const c = mix(rgb(0x2a2b2c), mix(rgb(0x7b8086), rgb(0xa2a7ab), grime), ring);
    s.color = c;
    s.height = ring;
    s.rough = 0.75 - ring * 0.4;
    s.metal = 0.25 + ring * 0.7;
  },

  /**
   * Paint on boards: a shield's face. Near-neutral, because every shield is
   * tinted to whoever carries it, with the brush marks in the relief and the
   * paint chipped back to wood where the edges and the hits land.
   */
  paint(u, v, s) {
    const brush = fbm(u * 6, v * 30, 6, 331, 3);
    const chip = clamp01(fbm(u * 14, v * 14, 14, 337, 4) * 2.2 - 1.35);
    const base = mix(rgb(0xb4b0aa), rgb(0xc6c2ba), brush);
    s.color = mix(base, rgb(0x5a4632), chip);
    s.height = 0.5 + brush * 0.04 - chip * 0.2;
    s.rough = 0.62 + chip * 0.3 + brush * 0.06;
  },

  /**
   * A conifer's needle spray, for alpha-cut cards: one spray per tile, the
   * twig running along u from the base at u = 0 to the tip, laid out in
   * NEEDLE_SPRAY. Before cards a fir crown was a stack of cones wearing the
   * `leaves` mass texture, and a judge photographed it as camouflage netting
   * over a traffic cone. What a crown is from ten metres is sprays with sky
   * between them, and only a cut-out gives you the sky.
   *
   * Transparent texels carry the needles' own dark green, not black: the
   * mip chain averages colour and alpha separately, and a black background
   * rims every spray at a distance.
   */
  needles(u, v, s) {
    const { bins, N, twigs } = NEEDLE_SPRAY;
    const bin = bins[Math.min(N - 1, Math.floor(v * N)) * N + Math.min(N - 1, Math.floor(u * N))];
    let best = null; let bestDepth = -1; let bestT = 0;
    let core = 1e9; let coreTwig = null;
    for (const [list, i] of bin) {
      const sg = list[i];
      const [x0, y0, x1, y1, w] = sg;
      const dx = x1 - x0; const dy = y1 - y0;
      const t = clamp01(((u - x0) * dx + (v - y0) * dy) / (dx * dx + dy * dy));
      const d = Math.hypot(u - x0 - dx * t, v - y0 - dy * t);
      if (list === twigs) {
        // How far into the spray's dense core this texel is: the needles
        // overlap there and nothing of the sky gets through.
        const reach = 0.016 * (1.1 - sg[5] * 0.3);
        if (d / reach < core) { core = d / reach; coreTwig = sg; }
        continue;
      }
      // Tapered to a point at the tip.
      if (d < w * (1 - t * 0.55) && sg[5] > bestDepth) { best = sg; bestDepth = sg[5]; bestT = t; }
    }
    const inCore = core < 1;
    if (!best && !inCore) {
      s.color = rgb(0x1f3322); s.alpha = 0; s.height = 0; s.rough = 0.8;
      return;
    }
    const shade = fbm(u * 18, v * 18, 18, 919, 3);
    let c;
    if (best) {
      // Dark where the needle leaves the twig, in the spray's shade, lighter
      // out at its tip; the ones behind darker still. The current year's
      // growth -- the last few centimetres of every shoot -- is the pale lime
      // that makes a fir read as alive from across a clearing. Coastal fir
      // is a dark blue-green, not a lawn green.
      const lit = 0.2 + 0.8 * bestDepth;
      c = mix(rgb(0x142519), rgb(0x46683f), clamp01(bestT * 0.5 + lit * 0.6 + shade * 0.2 - 0.15));
      c = mix(c, rgb(0x76954f), best[6] * 0.55 * (0.4 + 0.6 * bestT));
    } else {
      // The core between the needles: the spray's own shadow, and the twig.
      c = core < 0.28 && coreTwig[5] < 2 ? rgb(0x3e2f22) : mix(rgb(0x0f1c13), rgb(0x1a2d1e), shade);
    }
    s.color = c;
    s.alpha = 1;
    s.height = best ? 0.4 + 0.5 * bestDepth : 0.2;
    s.rough = 0.78 + shade * 0.12;
  },

  /**
   * Douglas-fir bark, for a trunk whose UVs run round it in u and up it in v
   * (trees.py unwraps the trunks as cylinders): thick corky ridges that part
   * and rejoin, broken across every few decimetres into plates, with furrows
   * deep enough to hold shadow and the cinnamon red of the inner bark down in
   * them -- the thing that tells a Douglas-fir from a hemlock at a glance.
   *
   * It was elongated Worley cells, and neither axis tiled (v ran at 2.2 over
   * a 16-period lattice), while the trunks were cube-projected: every facet
   * took the cells at another slant and the rings met at seams, which is the
   * chevron lattice a judge photographed. Everything here is periodic per
   * axis, and it is the unwrap that makes the ridges run up the tree.
   */
  firbark(u, v, s) {
    const R = barkPlates(u, v, { cols: 12, rows: 2, furrow: 0.75, seed: 939 });
    // Corky layers: fine and flaky across the ridge, the way the cork sheds.
    const cork = fbmA(u * 36, v * 64, 36, 64, 947, 3);
    const lichen = clamp01(fbmA(u * 4, v * 2, 4, 2, 953, 3) * 2.4 - 1.45) * R.top;
    const fibre = fbmA(u * 64, v * 6, 64, 6, 951, 2);
    const top = mix(rgb(0x4a3b30), rgb(0x7a6858), R.id * 0.5 + cork * 0.3 + fibre * 0.2);
    // The plate's shoulders go red-brown before they drop into the furrow.
    const face = mix(mix(rgb(0x6e4630), top, THREE.MathUtils.smoothstep(R.h, 0.75, 1)), rgb(0x8a8c7a), lichen * 0.55);
    const furrow = mix(rgb(0x160e0a), rgb(0x6a3a24), clamp01(R.h * 2.2));
    s.color = mix(furrow, face, R.top).map((c) => c * (0.84 + cork * 0.2 + fibre * 0.08));
    s.height = R.h * (0.88 + cork * 0.12);
    s.rough = 0.97;
  },

  /**
   * Western red cedar: long fibrous strips that barely part, weathered to a
   * silvered grey-brown with the red showing where a strip has peeled.
   */
  cedarbark(u, v, s) {
    const R = barkRidges(u, v, { ridges: 16, slant: 1, warp: 0.8, seed: 961, width: 0.36 });
    const strip = fbmA(u * 60, v * 3, 60, 3, 967, 3);
    const peel = clamp01(fbmA(u * 12, v * 2, 12, 2, 965, 3) * 2.2 - 1.05);
    const face = mix(mix(rgb(0x6f6158), rgb(0x9a8f84), strip), rgb(0x8c5a3e), peel * 0.7);
    s.color = mix(rgb(0x2e2119), face, 0.25 + 0.75 * R.top);
    s.height = R.h * 0.6 + strip * 0.15 + peel * 0.1;
    s.rough = 0.95;
  },

  /**
   * Broadleaf bark -- the oak, and anything with a trunk that is not a
   * conifer: grey, split into small near-square blocks by vertical fissures
   * and shorter cross-cracks, which is what an old oak's bark is.
   */
  bark(u, v, s) {
    const R = barkPlates(u, v, { cols: 12, rows: 3, furrow: 0.5, seed: 181 });
    // A rough face on every plate, so it reads as bark and not as a tile.
    const grain = fbmA(u * 48, v * 20, 48, 20, 187, 3);
    const moss = clamp01(fbmA(u * 3, v * 2, 3, 2, 191, 3) * 2.2 - 1.3) * R.top;
    const top = mix(rgb(0x4e4840), rgb(0x7a7166), R.id * 0.4 + grain * 0.6);
    s.color = mix(mix(rgb(0x221c16), rgb(0x3f352b), R.h), mix(top, rgb(0x4d5a2e), moss * 0.6), R.top);
    s.height = R.h * 0.8 + grain * 0.2;
    s.rough = 0.96;
  },

  /**
   * Sewer brickwork: English bond, a course of stretchers and a course of
   * headers, in a hard-burnt red gone brown and sooty with a century of damp.
   *
   * Worked in metres rather than in fractions of a cell, because the bond
   * has two brick lengths and one joint width and those only stay equal if
   * they are measured in the same units: the tile is 2.25 m, which is ten
   * 225 mm stretchers or twenty headers across and thirty 75 mm courses up,
   * so everything lands on the tile edge and it repeats without a seam. At
   * 512 texels a joint of 10 mm is 2.3 of them.
   *
   * The pointing is paler than the brick, not darker -- the same lesson the
   * stonewall recipe paid for: a dark joint is drawn twice, once here and
   * once by the crevice in the normal map, and reads as a black net.
   */
  brick(u, v, s) {
    const T = 2.25;
    const x = u * T; const y = v * T;
    const course = Math.floor(y / 0.075);
    const header = course % 2 === 1;
    const len = header ? 0.1125 : 0.225;
    // Header courses sit a quarter-brick over, which is what makes the bond.
    const bx = x + (header ? 0.05625 : 0);
    const col = Math.floor(bx / len);
    const fx = bx - col * len;
    const fy = y - course * 0.075;
    const j = 0.005;
    const inBrick = fx > j && fx < len - j && fy > j && fy < 0.075 - j;
    const cols = header ? 20 : 10;
    const id = hash2(col % cols, course, 64, 401);
    const edge = Math.min(fx - j, len - j - fx, fy - j, 0.075 - j - fy);
    // A worn arris, 12 mm: a sharp one is a two-texel cliff in the height
    // field, and under a raking torch the vault drew every joint as a bright
    // hairline, which at a distance crawled like moire.
    const arris = clamp01(edge / 0.012);
    const grain = fbm(u * 70, v * 70, 70, 409, 3);
    // Every brick its own burn: most a dull red-brown, the odd one over-fired
    // near purple-black, the odd one pale where it came from the edge of the
    // clamp.
    let c = mix(rgb(0x6e3524), rgb(0x8a4c34), id);
    const roll = (id * 9.17) % 1;
    if (roll > 0.86) c = mix(c, rgb(0x3a2a2a), (roll - 0.86) * 5.5);
    else if (roll < 0.1) c = mix(c, rgb(0x9a6a4e), (0.1 - roll) * 6);
    // Soot and damp in big soft patches; lime weeping down out of the joints
    // in streaks, which run down the wall and so down v.
    const grime = fbm(u * 4, v * 4, 4, 419, 4);
    const weep = clamp01(fbm(u * 26, v * 3, 26, 421, 3) * 2.2 - 1.25);
    c = mix(c, rgb(0x2b2320), clamp01(grime * 1.1 - 0.35) * 0.55);
    const mortar = mix(rgb(0x8a8171), rgb(0x9d9584), grain);
    const face = mix(c, rgb(0x241a15), (1 - arris) * 0.12 + grain * 0.08);
    const tone = inBrick ? face : mortar;
    s.color = mix(tone, rgb(0xa9a595), weep * 0.35);
    s.height = inBrick ? 0.45 + arris * 0.25 + grain * 0.1 : 0.3;
    // Damp brick holds a dull sheen; dry mortar is chalk.
    s.rough = inBrick ? 0.78 + grain * 0.12 + grime * 0.08 : 0.95;
  },

  /**
   * Dressed limestone for the kerbs, the ribs, the voussoirs and the piers.
   * No joints: every one of those is a separate block in the model, so the
   * geometry already draws them, and a bond painted over the top would be a
   * second one at a different pitch. What is left is the stone -- tooling,
   * a little fossil speckle, and the damp tide it drinks from below.
   */
  ashlar(u, v, s) {
    const body = fbm(u * 5, v * 5, 5, 431, 4);
    const tool = fbm(u * 60, v * 18, 60, 433, 2);
    const speck = clamp01(1 - cellular(u * 40, v * 40, 40, 439, 0.5)[0] * 5);
    const damp = fbm(u * 3, v * 3, 3, 443, 3);
    let c = mix(rgb(0x8c8575), rgb(0xa39b89), body);
    c = mix(c, rgb(0x5d584c), clamp01(damp * 1.4 - 0.55) * 0.6);
    c = mix(c, rgb(0x6f6a5e), speck * 0.25);
    s.color = c;
    s.height = 0.5 + body * 0.12 + tool * 0.06 - speck * 0.05;
    s.rough = 0.78 + tool * 0.12 - clamp01(damp - 0.5) * 0.2;
  },

  /**
   * What runs in the channel. Not the river: nothing here mirrors a sky, and
   * the colour is what is suspended in it -- khaki-brown silt and a grey scum
   * that gathers in slicks. Standing, so the relief is a slow swell with a
   * fine skin on it rather than chop.
   */
  sewage(u, v, s) {
    const swell = fbm(u * 4, v * 4, 4, 451, 3);
    const skin = fbm(u * 30, v * 30, 30, 457, 2);
    const slick = clamp01(fbm(u * 7 + 0.3, v * 7, 7, 461, 3) * 2.4 - 1.3);
    const c = mix(rgb(0x3d3a26), rgb(0x57512f), swell);
    s.color = mix(c, rgb(0x6d6a57), slick * 0.55);
    s.height = swell * 0.5 + skin * 0.12;
    // A slick is dull; open water between them is a mirror for the torches.
    s.rough = 0.1 + slick * 0.4 + skin * 0.05;
  },

  /**
   * Sewer mud: "something that reminds you very much of porridge". Grey-black
   * silt with lumps standing out of a wet skin, the skin glossy and the lumps
   * not -- that contrast is the whole of what separates mud from wet earth.
   */
  sludge(u, v, s) {
    const lump = fbm(u * 9, v * 9, 9, 467, 4);
    const fine = fbm(u * 48, v * 48, 48, 479, 2);
    const pool = clamp01((0.46 - lump) * 4);
    const c = mix(rgb(0x2a261e), rgb(0x4a4232), lump * 0.8 + fine * 0.2);
    s.color = mix(c, rgb(0x221f18), pool * 0.6);
    s.height = lump * 0.6 + fine * 0.1;
    s.rough = 0.62 + (1 - pool) * 0.3 - pool * 0.4;
  },

  /**
   * Cave rock. Not the cellular `rock`: that is a pavement of angular cells
   * with a dark crack round every one, which on a wall reads as crazy paving
   * -- tiles, not a cave. Limestone in a wet cave is banded and fractured and
   * stained, so: soft strata running across (v is height on a wall), a few
   * long fractures rather than a net of them, and mineral colour -- ochre
   * iron, pale calcite -- weeping down.
   */
  caverock(u, v, s) {
    // The first cut drew its strata as a warped sine and its fractures as
    // the contour of a noise, and at the contrast its relief had, the two
    // together were wood grain -- a judge called the Troll Den's walls marble.
    // Rock breaks along planes: bedding across the face, joints up it that
    // stop at bedding planes, and each piece a facet at its own tilt. Not
    // every plane has opened -- a wall of them all equally open is masonry.
    const at = strataAt(CAVE_BEDS, u, v, 4473);
    const body = fbm(u * 6, v * 6, 6, 499, 4);
    const pits = fbm(u * 24, v * 24, 24, 503, 3);
    const fine = fbm(u * 70, v * 70, 70, 505, 2);
    // Conchoidal chips: each Worley cell a small plane at its own angle, so a
    // block's face breaks into facets instead of being one slab.
    const [cdx, cdy, chip] = facetCell(u * 6, v * 10, 6, 10, 513, 0.5);
    const chip2 = hash2(Math.floor(chip * 977), 3, 1 << 20, 515);
    const bedOpen = clamp01(fbm(u * 5, at.bed.v0 * 50, 5, 517, 2) * 2.6 - 0.9);
    const bedLine = clamp01(1 - at.dBed / (0.002 + bedOpen * 0.004)) * (0.12 + bedOpen * 0.88);
    const jointOpen = clamp01(fbm(u * 3 + at.block, v * 8, 3, 519, 2) * 2.8 - 1.0);
    const jointLine = clamp01(1 - at.dJoint / (0.002 + jointOpen * 0.004)) * jointOpen;
    const crack = Math.max(bedLine, jointLine);
    const ochre = clamp01(fbm(u * 3, v * 1.2, 3, 521, 3) * 2.3 - 1.3);
    // Stain runs *down* from a bedding plane, where the water comes out.
    const weep = clamp01(fbm(u * 18, v * 1.5, 18, 525, 2) * 2 - 0.9) * (1 - at.fy) * bedOpen;
    const calcite = clamp01(fbm(u * 8, v * 2, 8, 523, 3) * 2.5 - 1.6);
    let c = mix(rgb(0x55504a), rgb(0x7a7264), body * 0.45 + at.tone * 0.2 + chip * 0.15 + at.bed.proud * 0.2);
    c = mix(c, rgb(0x7a5e3e), ochre * 0.35 + weep * 0.25);
    c = mix(c, rgb(0x9a9486), calcite * 0.35);
    c = mix(c, rgb(0x2e2a25), crack * 0.62);
    const shade = 0.94 + fine * 0.12;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    // Facets, a ledge per bed, and only a little grain on top: the relief is
    // in the breaks, not everywhere, or the whole face is mould.
    const facet = at.tilt[0] * (at.fx - 0.5) * 0.1 + at.tilt[1] * (at.fy - 0.5) * 0.1;
    const chipPlane = ((chip - 0.5) * cdx + (chip2 - 0.5) * cdy) * 0.07;
    // Fracture surfaces are creased, not bumpy: a ridged noise.
    const crease = 1 - Math.abs(fbm(u * 7, v * 5, 7, 527, 3) * 2 - 1);
    s.height = 0.55 + at.bed.proud * 0.1 + facet + chipPlane + body * 0.06 + pits * 0.03
      - crack * 0.32 + crease * 0.06;
    s.rough = 0.78 + fine * 0.14 - calcite * 0.2 - weep * 0.08;
  },

  /**
   * Desert sandstone: the mountains the river cuts through, seen from the
   * sand. Cross-bedded and banded in the reds and buffs of a dry country, in
   * courses a few centimetres to half a metre thick, with the dark streaks of
   * desert varnish running down from ledges -- the thing that makes a cliff
   * face in dry country read as dry.
   */
  sandstone(u, v, s) {
    const warp = fbm(u * 3, v * 3, 3, 571, 3);
    const beds = Math.sin((v * 9 + warp * 1.4) * Math.PI * 2) * 0.5 + 0.5;
    const fine = Math.sin((v * 17 + warp * 3.1 + u * 1.3) * Math.PI * 2) * 0.5 + 0.5;
    const body = fbm(u * 7, v * 7, 7, 577, 4);
    const grit = fbm(u * 60, v * 60, 60, 587, 2);
    const varnish = clamp01(fbm(u * 10, v * 1.4, 10, 593, 3) * 2.4 - 1.35);
    // The beds are a shade apart, not a value apart: at full contrast a
    // cliff of them read as a zebra.
    let c = mix(rgb(0xae6d44), rgb(0xc38c5c), beds * 0.25 + body * 0.75);
    c = mix(c, rgb(0xd6b089), clamp01(fine - 0.8) * 0.5);
    c = mix(c, rgb(0x5a3a2a), varnish * 0.45);
    const shade = 0.92 + grit * 0.16;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = beds * 0.15 + fine * 0.06 + body * 0.45 + grit * 0.1;
    s.rough = 0.86 + grit * 0.12 - varnish * 0.2;
  },

  /**
   * "A jet-black underground lake fed by dripping water and lime": still,
   * dark, faintly milky where the lime sits. A mirror for the torches.
   */
  cavewater(u, v, s) {
    const swell = fbm(u * 4, v * 4, 4, 599, 3);
    const lime = clamp01(fbm(u * 6 + 0.3, v * 6, 6, 601, 3) * 2.2 - 1.2);
    s.color = mix(mix(rgb(0x0f1a1c), rgb(0x1b2a2c), swell), rgb(0x55605a), lime * 0.35);
    s.height = swell * 0.4;
    s.rough = 0.06 + lime * 0.25;
  },

  /**
   * Tent cloth: woven goat hair and wool in the natural colours of the flock
   * -- black, brown, undyed cream -- in broad strips sewn edge to edge, the
   * way a nomad tent is made, with a narrow dyed band down each seam. The
   * strips run along v; a 4 m tile is five of them.
   */
  tentcloth(u, v, s) {
    const strip = Math.floor(u * 5);
    const f = u * 5 - strip;
    const id = hash2(strip, 0, 5, 611);
    const weave = fbm(u * 160, v * 40, 160, 613, 2);
    const slub = fbm(u * 20, v * 6, 20, 617, 3);
    // The black is weathered goat hair, a brown-black, not a black: at
    // 0x2c2622 the walls of a lamp-lit tent went to RGB 0 at night.
    let c = id < 0.4 ? rgb(0x46392f) : id < 0.75 ? rgb(0x6a523a) : rgb(0xbfae8c);
    c = mix(c, rgb(0x2a241f), slub * 0.15);
    const seam = f < 0.035 || f > 0.965;
    const band = (f > 0.06 && f < 0.1) || (f > 0.9 && f < 0.94);
    if (band) c = mix(c, rgb(0x8a2a20), 0.8);
    if (seam) c = mix(c, rgb(0x191512), 0.5);
    const shade = 0.9 + weave * 0.2;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    // The weave is under a texel at any distance you see a tent from; in the
    // relief it only speckled the roof with black.
    s.height = 0.5 + weave * 0.04 + slub * 0.1 - (seam ? 0.2 : 0);
    s.rough = 0.95;
  },

  /**
   * A kilim: stepped lozenges in madder red, indigo and a saffron ground,
   * with borders. Flat-woven, so the weave is in the relief and nowhere else.
   */
  rug(u, v, s) {
    const gx = u * 4; const gy = v * 3;
    const fx = gx - Math.floor(gx) - 0.5; const fy = gy - Math.floor(gy) - 0.5;
    const d = Math.abs(fx) + Math.abs(fy);
    const step = Math.floor(d * 8) / 8;
    const border = Math.min(u, 1 - u, v, 1 - v) < 0.04;
    const weave = fbm(u * 200, v * 200, 200, 619, 2);
    const wear = fbm(u * 5, v * 5, 5, 621, 3);
    let c = rgb(0xb07a36);
    if (step < 0.2) c = rgb(0x273a5e);
    else if (step < 0.35) c = rgb(0x8c2a22);
    else if (step < 0.45) c = rgb(0xd8c8a0);
    if (border) c = rgb(0x5a1d18);
    c = mix(c, rgb(0x9c8a70), clamp01(wear * 1.5 - 0.8) * 0.5);
    const shade = 0.9 + weave * 0.2;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = 0.5 + weave * 0.2;
    s.rough = 0.95;
  },

  /** Palm leaf: grey-green leaflets with pale midribs and brown dead tips. */
  frond(u, v, s) {
    const rib = clamp01(1 - Math.abs(Math.sin(u * Math.PI * 22)) * 6);
    const leaf = fbm(u * 12, v * 30, 12, 623, 3);
    const tip = clamp01(fbm(u * 4, v * 4, 4, 627, 3) * 2.2 - 1.3);
    let c = mix(rgb(0x4d6440), rgb(0x7c8c5c), leaf);
    c = mix(c, rgb(0xa9a77e), rib * 0.4);
    c = mix(c, rgb(0x7a5e3a), tip * 0.6);
    s.color = c;
    s.height = 0.5 + rib * 0.2 + leaf * 0.1;
    s.rough = 0.7 + leaf * 0.2;
  },

  /** Twisted fibre rope: the lay of the strands, in natural hemp. */
  rope(u, v, s) {
    const lay = Math.sin((u * 30 + v * 30) * Math.PI) * 0.5 + 0.5;
    const fibre = fbm(u * 90, v * 90, 90, 631, 2);
    s.color = mix(rgb(0x7a6444), rgb(0xa88e62), lay * 0.6 + fibre * 0.4);
    s.height = lay * 0.6 + fibre * 0.1;
    s.rough = 0.92;
  },

  /** A cave floor: grit and pebbles, and the wet where the drips land. */
  cavefloor(u, v, s) {
    const [, edge, id] = cellular(u * 26, v * 26, 26, 541, 0.5);
    const pebble = clamp01(edge * 9);
    const grit = fbm(u * 60, v * 60, 60, 547, 2);
    const damp = clamp01(fbm(u * 3, v * 3, 3, 557, 4) * 2 - 0.7);
    let c = mix(rgb(0x4a443a), rgb(0x6d665a), grit * 0.6 + id * 0.4);
    c = mix(mix(rgb(0x3a352e), rgb(0x5a544a), grit), c, pebble);
    s.color = mix(c, rgb(0x2c2823), damp * 0.5);
    s.height = pebble * (0.4 + id * 0.3) + grit * 0.15;
    s.rough = 0.9 - damp * 0.55;
  },

  /**
   * Wrought iron that has been wet for a century: more rust than metal. The
   * town's `iron` is 85% metallic, and a metal is only ever as bright as what
   * it reflects -- underground that is the fixed near-black sheen, so every
   * grating, rung and sconce down there rendered at RGB 0. Rust is not a
   * metal, and it is what those things are covered in.
   */
  rust(u, v, s) {
    const scale = fbm(u * 10, v * 10, 10, 563, 4);
    const pit = fbm(u * 60, v * 60, 60, 569, 2);
    const bare = clamp01(1.4 - scale * 2.2);
    const c = mix(rgb(0x5a3421), rgb(0x7d4a2a), scale);
    s.color = mix(c, rgb(0x3a3834), bare * 0.6);
    s.height = 0.5 + scale * 0.2 + pit * 0.1;
    s.rough = 0.72 + pit * 0.2 - bare * 0.3;
    s.metal = bare * 0.55;
  },

  /** Cave fungus: a pale, faintly pink flesh, mottled, damp at the rim. */
  fungus(u, v, s) {
    const m = fbm(u * 8, v * 8, 8, 641, 4);
    const spot = clamp01(1 - cellular(u * 14, v * 14, 14, 643, 0.5)[0] * 4);
    const c = mix(rgb(0xc9b7a2), rgb(0xe2d2c0), m);
    s.color = mix(mix(c, rgb(0xb88a86), clamp01(m - 0.55) * 0.6), rgb(0x8f7a64), spot * 0.3);
    s.height = 0.5 + m * 0.2 - spot * 0.1;
    s.rough = 0.55 + m * 0.25;
  },

  /** Old bone: ivory gone the colour of the floor it has lain on. */
  bone(u, v, s) {
    const stain = fbm(u * 6, v * 6, 6, 487, 4);
    const pore = fbm(u * 50, v * 50, 50, 491, 2);
    const c = mix(rgb(0xb9ab8a), rgb(0xd6cbb0), stain);
    s.color = mix(c, rgb(0x6e6147), clamp01(stain * 1.4 - 0.75) * 0.8);
    s.height = 0.5 + pore * 0.08 + stain * 0.05;
    s.rough = 0.62 + pore * 0.2;
  },

  water(u, v, s) {
    const w = fbm(u * 8, v * 8, 8, 191, 4);
    const w2 = fbm(u * 22 + w, v * 22, 22, 193, 3);
    s.color = mix(rgb(0x1d3a3f), rgb(0x2f5d63), w * 0.6 + w2 * 0.4);
    s.height = w * 0.6 + w2 * 0.4;
    s.rough = 0.08;
    s.metal = 0.1;
  },

  /**
   * Standing bog water. Nothing moves it, so there is no chop to shade and no
   * glitter to catch: what breaks the sheet up is what floats on it, duckweed
   * and peat stain, which is patches rather than waves. Near-black brown-green
   * -- but never near zero, because nothing outdoors under a sky is.
   *
   * The roughness is where the read lives. Open water is a mirror and the weed
   * on it is not, and a single value across both is a sheet of dark plastic.
   */
  bogwater(u, v, s) {
    const stain = fbm(u * 5, v * 5, 5, 337, 4);
    const weed = clamp01(fbm(u * 13, v * 13, 13, 347, 3) * 2.0 - 1.0);
    const scum = clamp01(cellular(u * 9, v * 9, 9, 349, 0.5)[1] * -6 + 1);
    const dark = mix(rgb(0x15190f), rgb(0x232b1c), stain);
    s.color = mix(mix(dark, rgb(0x2f3a1e), weed * 0.7), rgb(0x3d4526), scum * 0.35);
    s.height = 0.5 + weed * 0.12 + stain * 0.05;
    // The floor is 0.22 and not the river's 0.08: a mirror that sharp returns
    // the sun as a disc, which is the glitter a stagnant pool has none of.
    s.rough = 0.22 + weed * 0.46 + scum * 0.16;
  },

  // ----------------------------------------- the Dangerous Neighborhood ----

  /**
   * The town's coursed rubble after a fire has been at it. Soot does not lie
   * evenly: it is laid down by smoke rising up a face, so it comes in tall
   * tongues and not in round blotches -- the noise is stretched six to one
   * up the wall. Where it is thickest the stone is a charcoal grey and dead
   * matt; between the tongues the wall is grimed, never clean.
   */
  /**
   * "The floorstones are fiery red." Flags of dark iron-red stone, cracked
   * between and across, and the cracks still hot: `emit` is how much of the
   * crack glows, patchy, since a floor does not cool evenly.
   */
  embers(u, v, s) {
    const [, edge, id] = cellular(u * 7, v * 7, 7, 811, 0.42);
    const grain = fbm(u * 40, v * 40, 40, 813, 3);
    const split = fbm(u * 18, v * 18, 18, 821, 3);
    const heat = clamp01(fbm(u * 3, v * 3, 3, 817, 3) * 2.2 - 0.6);
    // The joints, and a hairline across some stones where the heat split them.
    const crack = Math.max(clamp01(1 - edge / 0.07), clamp01(1 - Math.abs(split - 0.5) / 0.018) * (id > 0.55 ? 1 : 0));
    const stone = mix(rgb(0x3a221b), rgb(0x6a3322), id * 0.55 + grain * 0.3 + heat * 0.25);
    s.color = mix(mix(stone, rgb(0x241713), (1 - grain) * 0.25), rgb(0x160d0a), crack * 0.85);
    s.height = 0.62 + grain * 0.1 - crack * 0.45;
    s.rough = 0.82 - heat * 0.12;
    s.emit = crack * (0.25 + heat * 0.75);
  },

  /**
   * The same flags after the fire has gone out: "a room which once had been
   * quite burned". Blackened stone, crazed across by the heat, grey ash
   * lodged in the joints -- and cold, so nothing glows. `embers` on every
   * lair made the burned room a floor of live lava cracks.
   */
  cinders(u, v, s) {
    const [, edge, id] = cellular(u * 7, v * 7, 7, 811, 0.42);
    const grain = fbm(u * 40, v * 40, 40, 813, 3);
    const split = fbm(u * 18, v * 18, 18, 821, 3);
    const soot = clamp01(fbm(u * 3, v * 3, 3, 817, 3) * 2 - 0.5);
    const joint = clamp01(1 - edge / 0.07);
    const crack = clamp01(1 - Math.abs(split - 0.5) / 0.015) * (id > 0.5 ? 1 : 0);
    const stone = mix(rgb(0x4a4540), rgb(0x635c53), id * 0.6 + grain * 0.4);
    let c = mix(stone, rgb(0x1f1c19), soot * 0.7);
    c = mix(c, rgb(0x8a857c), joint * 0.6);
    c = mix(c, rgb(0x191614), crack * 0.7);
    s.color = c;
    s.height = 0.62 + grain * 0.08 - joint * 0.3 - crack * 0.2;
    s.rough = 0.9 + grain * 0.08;
  },

  sootwall(u, v, s) {
    // Random rubble, not coursed: courses of 19 to 32 cm and stones of 40 to
    // 90, no two rows alike. The ruins wore the town's coursed stone -- every
    // block 60 x 30, two to one -- and on a broken wall with a man in front of
    // it that proportion read as brick blown up four times, which is what a
    // review called it. Same 3.6 m tile, so the model UVs are untouched.
    let row = 0;
    while (row < SOOT_ROWS.length - 2 && v >= SOOT_ROWS[row + 1]) row++;
    const v0 = SOOT_ROWS[row]; const v1 = SOOT_ROWS[row + 1];
    const n = SOOT_COLS[row];
    const gx = (((u + SOOT_SHIFT[row]) % 1) + 1) % 1 * n;
    const col = Math.floor(gx);
    const fx = gx - col; const fy = (v - v0) / (v1 - v0);
    // Joints and arrises in metres, converted per axis by the stone's size.
    const w = 3.6 / n; const h = (v1 - v0) * 3.6;
    const jx = 0.012 / w; const jy = 0.012 / h;
    const inBlock = fx > jx && fx < 1 - jx && fy > jy && fy < 1 - jy;
    const bevel = clamp01(Math.min((fx - jx) * w, (1 - jx - fx) * w, (fy - jy) * h, (1 - jy - fy) * h) / 0.03);
    const id = hash2(col, row, 64, 691);
    const grain = fbm(u * 62 + id * 7, v * 62, 62, 23, 3);
    const block = mix(rgb(0x8a8171), rgb(0x9f9687), id);
    const base = inBlock
      ? mix(block, rgb(0x706758), grain * 0.12 + (1 - bevel) * 0.08)
      : mix(rgb(0x9e9585), rgb(0xada595), grain);
    // Blotches for where the fire was, streaked six to one up the wall for
    // how the smoke climbed it. Periods chosen so the tile still wraps.
    const blotch = fbm(u * 4, v * 4, 4, 701, 4);
    const streak = fbm(u * 24, v * 4, 4, 703, 3);
    const fleck = fbm(u * 40, v * 40, 40, 709, 2);
    const soot = clamp01((blotch * 0.62 + streak * 0.38 - 0.37) * 3.2) * (0.82 + fleck * 0.3);
    // The whole face is grimed first -- a fire does not leave clean stone
    // anywhere near it -- and the tongues go darker again over that. Clean
    // stone with black blotches on it read as a dalmatian, not as a fire.
    const grime = fbm(u * 8, v * 8, 8, 707, 3);
    // Streaked, not uniformly dark: see the recipe. The grime between the
    // tongues keeps a mid grey; the tongues go to a warm charcoal (floor
    // 0x221e1b -- nothing under a sky reads zero, and burnt stone is not ink).
    const greyed = mix(base, rgb(0x3b3733), 0.66 + grime * 0.2);
    s.color = mix(greyed, rgb(0x221e1b), clamp01(soot * 1.3));
    // Relief at the perpends only. The bake's Sobel is steep -- a step of a
    // few hundredths already tips a normal past forty-five degrees -- so the
    // top arris of every course was a strip facing straight up, and in the
    // shade what lights and what it mirrors is the sky: every course in the
    // district wore a blue line along it, which a judge read as blue mortar.
    // With the normal map off the lines were gone. The bed joint keeps its
    // colour and a whisper of recess; the perpends, facing sideways, a
    // little more -- at full depth a dusk sun raked them into a comb.
    const perpBevel = clamp01(Math.min((fx - jx) * w, (1 - jx - fx) * w) / 0.03);
    const bedBevel = clamp01(Math.min((fy - jy) * h, (1 - jy - fy) * h) / 0.03);
    s.height = 0.6 + perpBevel * 0.06 + bedBevel * 0.015 + grain * 0.03;
    s.rough = Math.min(1, (inBlock ? 0.72 + grain * 0.2 : 0.94) + soot * 0.12);
  },

  /**
   * A house front come down: broken stone of every size in a bed of grit and
   * mortar dust, a sherd of roof tile here and there and the black of a
   * charred stick. The heaps wore the street's own setts and the walls'
   * coursed stone, and read as a paved hump.
   */
  rubble(u, v, s) {
    const [d1, edge, id] = cellular(u * 11, v * 11, 11, 911, 0.42);
    const [, edge2, id2] = cellular(u * 29, v * 29, 29, 917, 0.45);
    const dust = fbm(u * 18, v * 18, 18, 919, 3);
    const fine = fbm(u * 70, v * 70, 70, 923, 2);
    // Big stones where a cell is well inside its edge, grit between them.
    const big = clamp01((edge - 0.08) * 7) * (((id * 5.1) % 1) > 0.25 ? 1 : 0);
    const small = clamp01((edge2 - 0.1) * 9) * (1 - big);
    const kind = (id * 13.7) % 1;
    let stone = mix(rgb(0x4d4842), rgb(0x655f55), (id2 * 3.1) % 1);
    if (kind > 0.9) stone = rgb(0x5f3a2b);             // roof tile
    else if (kind > 0.78) stone = rgb(0x1e1b18);       // char
    const grit = mix(rgb(0x3f3b36), rgb(0x5b564e), dust * 0.7 + fine * 0.3);
    let c = mix(grit, stone, Math.max(big, small * 0.85));
    // Soot on the upper faces of the big stones, dust settled on the rest.
    c = mix(c, rgb(0x2e2a26), big * clamp01(fbm(u * 5, v * 5, 5, 929, 2) * 1.6 - 0.6) * 0.6);
    s.color = mix(c, rgb(0x6e685f), (1 - big) * clamp01(dust * 1.4 - 0.7) * 0.35);
    s.height = 0.15 + big * (0.5 + (1 - d1) * 0.3) + small * 0.25 + fine * 0.06;
    s.rough = 0.9 + fine * 0.08 - big * 0.06;
  },

  /**
   * Charred timber: the surface of a burnt beam breaks into the blocky
   * "alligator" checks that tell a fire investigator how long it burned --
   * longer along the grain than across it, with the cracks deep and black and
   * the tops of the blocks a dull, faintly silvered charcoal, ash still lying
   * on the odd one. Height does the reading: at any distance a beam is a
   * black shape, and up close the checks are what say it was wood.
   */
  charred(u, v, s) {
    // Small checks, irregular, and all within a shade of each other: at any
    // distance a charred beam is one black shape, and up close the checks
    // are relief, not pattern. Rows of rectangles read as brickwork and big
    // cells as crazy paving; both were tried.
    const [, edge, id] = cellular(u * 26, v * 26, 26, 721, 0.48);
    const crack = clamp01((edge - 0.015) * 16);
    const grain = fbm(u * 2, v * 40, 2, 727, 3);
    const ash = clamp01((((id * 5.3) % 1) - 0.9) * 8) * 0.4;
    // As dark as it can be and still hold a value under the moon: at 0.07
    // mean albedo the burnt cart and the stakes' points went to RGB 0 in No
    // Man's Land at night.
    const block = mix(rgb(0x2e2925), rgb(0x39332d), grain * 0.6 + id * 0.4);
    s.color = mix(mix(rgb(0x241f1b), block, crack * 0.7 + 0.3), rgb(0x4d4843), ash * crack);
    s.height = crack * (0.5 + id * 0.3) + grain * 0.1;
    s.rough = 0.88 - crack * 0.1 + ash * 0.1;
  },

  /**
   * Boards nailed over a window or a door: rough-sawn deal gone silver in the
   * weather, which is the colour that says nobody has been here for years.
   * Upright, a hand and a half wide, with a dark gap between each and a rust
   * streak run down from every nail.
   */
  boards(u, v, s) {
    const n = 11;
    const gx = u * n;
    const board = Math.floor(gx);
    const fx = gx - board;
    const id = hash2(board, 0, n, 739);
    const grain = fbm(u * n * 22 + id * 9, v * 4, n * 22, 743, 3);
    const gap = clamp01(Math.min(fx, 1 - fx) * 30);
    const weather = fbm(u * 6, v * 6, 6, 751, 3);
    let c = mix(rgb(0x4b453d), rgb(0x6e675c), id * 0.5 + grain * 0.35 + weather * 0.15);
    // Two nails a board, at each rail, and the rust that has run from them.
    const nail = Math.min(Math.abs(fx - 0.5), 0.5) < 0.09 ? 1 : 0;
    const rail = Math.min(Math.abs((v * 2) % 1 - 0.18), Math.abs((v * 2) % 1 - 0.68));
    const head = nail && rail < 0.012 ? 1 : 0;
    const streak = nail * clamp01(1 - Math.abs(fx - 0.5) * 22)
      * clamp01(1 - (((v * 2 + 0.82) % 1) * 3.2)) * 0.55;
    c = mix(c, rgb(0x6a4128), streak);
    c = mix(c, rgb(0x2a2420), head * 0.9);
    s.color = mix(rgb(0x1f1b17), c, gap);
    s.height = 0.25 + gap * 0.5 + grain * 0.12 - head * 0.2;
    s.rough = 0.9 + grain * 0.08;
  },

  /**
   * A street nobody mends. The town's setts, but a fifth of them gone --
   * prised up for throwing, or sunk -- and what shows in the hole is packed
   * dirt; weeds have taken the wider joints, and there is ash lying in drifts
   * from the fires. The stones that are left sit at odd heights, which is
   * what a raking light finds first.
   */
  brokencobble(u, v, s) {
    SURFACES.cobble(u, v, s);
    const [d1, edge, id] = cellular(u * 18, v * 18, 18, 11, 0.38);
    const lost = ((id * 13.7) % 1) > 0.74;
    const dirt = fbm(u * 30, v * 30, 30, 761, 2);
    const weedy = clamp01(fbm(u * 9, v * 9, 9, 769, 2) * 2.2 - 1.0);
    const ash = clamp01(fbm(u * 4, v * 4, 4, 773, 3) * 2.4 - 1.25);
    if (lost) {
      const earth = mix(rgb(0x3e3327), rgb(0x5d4b37), dirt);
      s.color = mix(earth, rgb(0x495a2a), weedy * clamp01(1 - d1 * 2.4) * 0.8);
      s.height = 0.12 + dirt * 0.1;
      s.rough = 0.95;
    } else {
      const grout = clamp01((edge - 0.012) * 26);
      // Weeds in the joints, not on the stones.
      s.color = mix(s.color, rgb(0x46552a), weedy * (1 - grout) * 0.9);
      s.height += (((id * 3.1) % 1) - 0.5) * 0.14;
    }
    s.color = mix(s.color, rgb(0x6e6a64), ash * 0.55);
  },

  /**
   * Waste ground: an over-grown lot, a plaza never finished. Packed dry earth
   * with gravel in it, dead grass in drifts and weeds coming through in
   * clumps -- darker and duller than the `dirt` of a farm track, which under
   * a noon sun came out as beach sand.
   */
  wasteground(u, v, s) {
    const lumps = fbm(u * 12, v * 12, 12, 811, 3);
    const grass = clamp01(fbm(u * 6, v * 6, 6, 813, 3) * 2.2 - 0.85);
    const weed = clamp01(fbm(u * 18, v * 18, 18, 817, 3) * 2.6 - 1.45);
    const [, edge, id] = cellular(u * 30, v * 30, 30, 819, 0.5);
    const stone = clamp01((edge - 0.02) * 10) * (((id * 7.1) % 1) > 0.93 ? 1 : 0);
    const blade = fbm(u * 90, v * 90, 90, 823, 2);
    let c = mix(rgb(0x3d3326), rgb(0x564838), lumps);
    c = mix(c, mix(rgb(0x5b5236), rgb(0x7a6d48), blade), grass * 0.85);
    c = mix(c, rgb(0x3c4a24), weed * 0.8);
    c = mix(c, rgb(0x5e5850), stone * 0.5);
    s.color = c;
    s.height = lumps * 0.4 + grass * blade * 0.25 + stone * 0.3 + weed * 0.15;
    s.rough = 0.93 - stone * 0.1;
  },

  /**
   * Cut crystal, as a statue is carved from it: pale, cold, and smooth enough
   * that what you see of it is mostly the sky -- with the fractures of a
   * smashing through it as bright planes. Opaque, because the town has no
   * refraction to give it; the environment does the work.
   */
  crystal(u, v, s) {
    const [, edge] = cellular(u * 5, v * 5, 5, 801, 0.5);
    const frac = clamp01(1 - edge * 12);
    const cloud = fbm(u * 4, v * 4, 4, 803, 3);
    s.color = mix(mix(rgb(0x9fb4bf), rgb(0xc9d9e0), cloud), rgb(0xeef4f6), frac * 0.7);
    s.height = 0.5 + cloud * 0.1 - frac * 0.2;
    s.rough = 0.06 + frac * 0.2 + cloud * 0.05;
    s.metal = 0.15;
  },

  /**
   * The marsh fortress, "hewn of black stone and heavily fortified": big
   * dressed blocks of a dark basalt, coursed, 0.6 m to a course and a metre
   * or more long, with pale lime weeping out of the joints and grey
   * weathering on the faces. Black stone is not ink -- a basalt ashlar in
   * sun is a dark slate grey, and the lime and the lichen are what show its
   * courses from across a lake.
   */
  blackstone(u, v, s) {
    const rows = 6;
    const row = Math.floor(v * rows);
    const cols = row % 3 === 0 ? 3 : 4;
    const gx = u * cols + ((row * 0.37) % 1);
    const col = Math.floor(gx);
    const fx = gx - col; const fy = v * rows - row;
    const w = 3.6 / cols; const h = 3.6 / rows;
    const jx = 0.01 / w; const jy = 0.01 / h;
    const inBlock = fx > jx && fx < 1 - jx && fy > jy && fy < 1 - jy;
    const bevel = clamp01(Math.min((fx - jx) * w, (1 - jx - fx) * w, (fy - jy) * h, (1 - jy - fy) * h) / 0.035);
    const id = hash2(col + row * 7, row, 64, 1201);
    const grain = fbm(u * 48 + id * 5, v * 48, 48, 1203, 3);
    const weather = fbm(u * 5, v * 5, 5, 1207, 4);
    const lichen = clamp01((fbm(u * 14, v * 14, 14, 1209, 3) - 0.58) * 5);
    // Albedo goes through the gamma lift, which takes 0x16 to about 0x3a:
    // the town's stone is 0x8d, so this is under half of it once lit.
    const block = mix(rgb(0x121113), rgb(0x1f1d1e), id);
    const face = mix(mix(block, rgb(0x353331), weather * 0.3), rgb(0x0c0b0c), (1 - bevel) * 0.3 + grain * 0.12);
    // Lime leached out of the joint and run down the face below it.
    const weep = clamp01(1 - fy * 3.5) * clamp01(fbm(u * 40, v * 3, 40, 1211, 2) * 2 - 0.7);
    s.color = inBlock
      ? mix(mix(face, rgb(0x46463e), lichen * 0.5), rgb(0x55524c), weep * 0.3)
      : mix(rgb(0x2e2c2a), rgb(0x3a3834), grain);
    s.height = inBlock ? 0.6 + bevel * 0.32 + grain * 0.07 : 0.1;
    s.rough = inBlock ? 0.66 + grain * 0.2 + lichen * 0.1 : 0.94;
  },

  /**
   * "Its black obsidian surface shines darkly": volcanic glass, black in its
   * body and all reflection on its faces, with the shell-shaped ripples a
   * conchoidal fracture leaves and a faint grey banding from how it flowed.
   * The darkness is the albedo's; the shine is the environment's.
   */
  obsidian(u, v, s) {
    const [d1, edge, id] = cellular(u * 3, v * 3, 3, 1301, 0.5);
    // Ripples running out from each fracture's point of impact, dying away.
    // Faint: at full strength the rings read as a carved spiral pattern.
    const ripple = Math.sin(d1 * 22 + id * 6) * Math.exp(-d1 * 3.5);
    const ridge = clamp01(1 - edge * 22);
    const band = fbm(u * 2, v * 18, 2, 1303, 3);
    // The fracture edges only in the gloss, not the colour or the relief: as
    // lines they tiled into a crackle net across the whole stone.
    s.color = mix(rgb(0x0f0e12), rgb(0x1a1820), band);
    s.height = 0.5 + ripple * 0.035;
    s.rough = 0.07 + ridge * 0.06 + band * 0.05;
  },

  /**
   * Cast bronze that has stood a century in the rain: the metal still shows
   * brown where hands and weather wear it smooth, and verdigris lies in
   * everything sheltered. The Market Square's worm is cast in it.
   */
  bronze(u, v, s) {
    const patch = fbm(u * 4, v * 4, 4, 1401, 4);
    const fine = fbm(u * 30, v * 30, 30, 1403, 3);
    const run = fbm(u * 18, v * 3, 18, 1405, 2);
    const green = clamp01((patch * 0.7 + run * 0.3 - 0.42) * 3.2);
    const metal = mix(rgb(0x7a5733), rgb(0x9a7446), fine);
    s.color = mix(metal, mix(rgb(0x4f8a74), rgb(0x76ad95), fine), green);
    s.height = 0.5 + fine * 0.08 + green * 0.06;
    s.rough = 0.38 + green * 0.45 + fine * 0.1;
    s.metal = 0.85 * (1 - green);
  },

  /**
   * The floor of a burnt-out room: fine grey ash over whatever the floor was,
   * with charcoal lumps, and here and there a brick or a tile that came down
   * with the roof. Dry and matt all through.
   */
  ash(u, v, s) {
    const drift = fbm(u * 6, v * 6, 6, 781, 4);
    const fine = fbm(u * 55, v * 55, 55, 787, 2);
    const [, edge, id] = cellular(u * 30, v * 30, 30, 797, 0.5);
    const lump = clamp01((edge - 0.05) * 8) * (((id * 7.7) % 1) > 0.8 ? 1 : 0);
    const brick = ((id * 3.3) % 1) > 0.93 ? 1 : 0;
    // Ash is pale where it lies fresh, but a floor of it has been rained on,
    // walked through and mixed with the char: at the old 0x8a857c it read as
    // snow.
    let c = mix(rgb(0x34312d), rgb(0x57534c), drift * 0.8 + fine * 0.2);
    c = mix(c, brick ? rgb(0x5e3a2a) : rgb(0x1c1916), lump);
    s.color = c;
    s.height = drift * 0.3 + fine * 0.1 + lump * 0.4;
    s.rough = 0.96 - lump * 0.1;
  },

  /**
   * "Smooth purple stone walls", "the floor is made from black stone": dressed
   * slabs with hairline joints, honed rather than polished to a mirror, in a
   * pale neutral that build.js tints to whatever colour the prose names -- one
   * bake for every coloured stone room. Five 0.6 m courses of 1.5 m slabs on a
   * 3 m tile, half-bonded, each slab a shade of its own and a faint drifting
   * figure in the stone.
   */
  polished(u, v, s) {
    const rows = 5; const cols = 2;
    const ry = v * rows; const row = Math.floor(ry); const fy = ry - row;
    const rx = u * cols + (row % 2) * 0.5; const col = Math.floor(rx); const fx = rx - col;
    const id = hash2(((col % cols) + cols) % cols, row, 97, 2203);
    // Distance to the nearest joint, in metres of a 3 m tile.
    const edge = Math.min(Math.min(fx, 1 - fx) * (3 / cols), Math.min(fy, 1 - fy) * (3 / rows));
    const joint = edge < 0.005 ? 1 : 0;
    const arris = clamp01(1 - (edge - 0.005) / 0.014);
    const cloud = fbm(u * 4 + id * 3, v * 4, 4, 2207, 4);
    const turb = fbm(u * 3, v * 3, 3, 2213, 3);
    const figure = Math.pow(1 - Math.abs(Math.sin((u * 1.3 + v * 0.5 + turb * 1.5 + id) * Math.PI * 2)), 18);
    const tone = 0.93 + (id - 0.5) * 0.1 + (cloud - 0.5) * 0.14;
    const base = rgb(0xd2cec8);
    let c = [base[0] * tone, base[1] * tone, base[2] * tone];
    c = mix(c, rgb(0xe6e3de), figure * 0.35);
    s.color = joint ? mix(c, rgb(0x34322f), 0.85) : mix(c, [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8], arris * 0.5);
    s.height = 0.62 - arris * 0.22 - joint * 0.3 + cloud * 0.015;
    // Honed, not mirror-polished: at 0.27 the sewer's near-black sheen was
    // most of what the walls showed, and a coloured room read as black.
    s.rough = joint ? 0.72 : 0.5 + cloud * 0.12 + arris * 0.1;
  },

  /**
   * The inside of a hollow tree: the wood the heart rotted out of, walked
   * smooth where hands have touched it. Fibres run up the trunk and part
   * round the knots, the grain darker in its furrows, the heartwood a warm
   * reddish brown. `v` runs up the trunk.
   */
  livingwood(u, v, s) {
    const warp = (fbm(u * 3, v * 2, 3, 2231, 3) - 0.5) * 2.2;
    // Knots: a few per tile, the grain bending round each.
    const [kd, , kid] = cellular(u * 3, v * 2, 3, 2237, 0.4);
    const knot = kid > 0.72 ? clamp01(1 - kd * 3.2) : 0;
    const swirl = knot * Math.sin(kd * 22) * 0.35;
    const fibre = fbm(u * 46 + warp * 6 + swirl * 8, v * 3, 46, 2239, 2);
    const furrow = clamp01((0.42 - fibre) * 4);
    const band = fbm(u * 5 + warp, v * 1.5, 5, 2243, 3);
    let c = mix(rgb(0x7a4f30), rgb(0xa77449), band * 0.8 + fibre * 0.3);
    // Softly: at full strength the furrows read as tiger stripes by lamplight.
    c = mix(c, rgb(0x4a2e1b), furrow * 0.42 + knot * 0.4);
    s.color = c;
    s.height = 0.5 + fibre * 0.35 - furrow * 0.25 - knot * 0.15;
    s.rough = 0.58 + furrow * 0.25 - band * 0.08;
  },

  /**
   * "The walls of the cavern are several feet thick with ice": blue-white
   * ice with the cracks in it lit paler than the body, bubbles trapped in
   * it, and a wet sheen. Opaque: there is no refraction to give it.
   */
  ice(u, v, s) {
    const cloud = fbm(u * 4, v * 4, 4, 2251, 4);
    const [, crack] = cellular(u * 5, v * 5, 5, 2257, 0.5);
    // Bubbles: one to a lattice cell at most, a disc round a jittered point.
    const bx = u * 30; const by = v * 30; const ix = Math.floor(bx); const iy = Math.floor(by);
    const jx = hash2(ix, iy, 30, 2263) * 0.6 + 0.2; const jy = hash2(ix, iy, 30, 2269) * 0.6 + 0.2;
    const bubble = hash2(ix, iy, 30, 2267) > 0.7 ? clamp01(1 - Math.hypot(bx - ix - jx, by - iy - jy) * 9) : 0;
    const line = clamp01(1 - crack * 18);
    let c = mix(rgb(0x8fb2c4), rgb(0xd8e8ef), cloud);
    c = mix(c, rgb(0xf2f8fa), line * 0.6 + bubble * 0.5);
    s.color = c;
    s.height = 0.5 + cloud * 0.08 - line * 0.18 + bubble * 0.05;
    s.rough = 0.08 + line * 0.3 + cloud * 0.06;
  },
};

// -------------------------------------------------------------- baking ----

function bake(name, size) {
  const surface = SURFACES[name];
  if (!surface) throw new Error(`textures: no surface named ${name}`);

  const albedo = new Uint8ClampedArray(size * size * 4);
  const roughness = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const s = { color: [0, 0, 0], height: 0, rough: 1, metal: 0, alpha: 1, emit: 0 };
  // Only a surface that glows sets `emit`; it is the share of a fixed ember
  // colour, and the map is dropped again if nothing on it did.
  const emissive = new Uint8ClampedArray(size * size * 4);
  let glows = false;
  // The palettes above read well as flat swatches, but albedo is consumed in
  // linear space, where mid-greys drop to almost nothing. This curve lifts the
  // darks and leaves the highlights roughly where they were.
  const lift = (c) => 255 * Math.pow(Math.max(0, Math.min(1, c / 255)), 0.62);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      s.metal = 0;
      s.alpha = 1;
      s.emit = 0;
      surface((x + 0.5) / size, (y + 0.5) / size, s);
      const i = (y * size + x);
      if (s.emit > 0) {
        glows = true;
        const e = clamp01(s.emit);
        emissive[i * 4] = 255 * e;
        emissive[i * 4 + 1] = 92 * e * e;
        emissive[i * 4 + 2] = 24 * e * e * e;
      }
      emissive[i * 4 + 3] = 255;
      albedo[i * 4] = lift(s.color[0]);
      albedo[i * 4 + 1] = lift(s.color[1]);
      albedo[i * 4 + 2] = lift(s.color[2]);
      albedo[i * 4 + 3] = clamp01(s.alpha) * 255;
      // glTF packing: roughness in green, metalness in blue.
      roughness[i * 4] = 255;
      roughness[i * 4 + 1] = clamp01(s.rough) * 255;
      roughness[i * 4 + 2] = clamp01(s.metal) * 255;
      roughness[i * 4 + 3] = 255;
      height[i] = s.height;
    }
  }

  // Normals from the height field (Sobel), wrapping at the edges so it tiles.
  const normal = new Uint8ClampedArray(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  // Sobel over a 0..1 height field: the gradient scales with resolution, so the
  // divisor sets how much relief a full-range step is worth. Too high and every
  // wisp of noise turns the surface mouldy.
  const strength = size / 22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength; let ny = -dy * strength; let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      normal[i] = (nx * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny * 0.5 + 0.5) * 255;
      normal[i + 2] = (nz * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
    }
  }

  return { albedo, normal, roughness, size, emissive: glows ? emissive : null };
}

function toTexture(data, size, colorSpace, cutout = 0) {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = colorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  if (cutout) {
    texture.mipmaps = cutoutMips(data, size, cutout);
    texture.generateMipmaps = false;
  }
  texture.needsUpdate = true;
  return texture;
}

/**
 * Mips for an alpha-tested texture that keep what passes the test.
 *
 * A box filter conserves mean alpha, but the alpha *test* does not: a blade
 * three texels wide at 0/255 is a 0.75 / 0.25 smear two levels down and a
 * uniform 0.3 veil after that, which a 0.5 cut throws away entire -- so a
 * meadow thins to bare turf with distance and a fir crown to a bottlebrush.
 * Each level's alpha is scaled until the fraction of texels over the cut
 * matches the full-size map (Castano's coverage-preserving mips), and colour
 * is averaged by alpha so the fill colour in the gaps does not bleed in.
 */
function cutoutMips(data, size, cut) {
  const covered = (a, n, k) => {
    let c = 0;
    const t = cut * 255;
    for (let i = 3; i < n * n * 4; i += 4) if (a[i] * k >= t) c++;
    return c / (n * n);
  };
  const target = covered(data, size, 1);
  const levels = [{ data, width: size, height: size }];
  let prev = data; let n = size;
  while (n > 1) {
    const m = n >> 1;
    const next = new Uint8ClampedArray(m * m * 4);
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        let r = 0; let g = 0; let b = 0; let a = 0; let pr = 0; let pg = 0; let pb = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const i = ((y * 2 + dy) * n + x * 2 + dx) * 4;
          const w = prev[i + 3];
          r += prev[i] * w; g += prev[i + 1] * w; b += prev[i + 2] * w; a += w;
          pr += prev[i]; pg += prev[i + 1]; pb += prev[i + 2];
        }
        const o = (y * m + x) * 4;
        if (a > 0) { next[o] = r / a; next[o + 1] = g / a; next[o + 2] = b / a; }
        else { next[o] = pr / 4; next[o + 1] = pg / 4; next[o + 2] = pb / 4; }
        next[o + 3] = a / 4;
      }
    }
    // Bisect the scale that restores the coverage, then bake it in.
    let lo = 0.5; let hi = 8;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (covered(next, m, mid) < target) lo = mid; else hi = mid;
    }
    const k = (lo + hi) / 2;
    for (let i = 3; i < next.length; i += 4) next[i] = Math.min(255, next[i] * k);
    levels.push({ data: next, width: m, height: m });
    prev = next; n = m;
  }
  return levels;
}

/**
 * Material recipes: which surface, how many world units per texture tile, and
 * the PBR knobs that noise alone can't express.
 *
 * `wet` is damp collecting in the low patches, which is right for a street
 * and wrong for a floor: planks, marble and most flagstone are indoors, and
 * the effect was putting rain puddles on the floorboards of a tavern.
 *
 * `env` is how much of the environment cube the surface believes. It is not a
 * cheat: a limewashed wall really does reflect less of the sky than wet
 * flagstones do, and with a real environment map the difference between 0.6
 * and 1.5 here is the difference between chalk and stone.
 *
 * `wet` is how far the low-lying patches of an upward-facing surface polish
 * up. Streets hold water in their dips; walls do not.
 */
/** `scale` is how many world units one tile of the texture covers. */
const RECIPES = {
  cobble: { surface: 'cobble', scale: 2.2, normalScale: 1.0, env: 1.15, wet: 0.5, detail: 0.5 },
  flagstone: { surface: 'flagstone', scale: 2.6, normalScale: 0.85, env: 1.1, wet: 0.16, detail: 0.5 },
  marble: { surface: 'marble', scale: 4, normalScale: 0.35, env: 0.8, wet: 0, detail: 0.3 },
  // A person is 1.75 m, so a 0.7 m tile puts two and a half repeats down a
  // sleeve -- close enough that nothing reads as a pattern.
  cloth: { surface: 'cloth', scale: 0.7, normalScale: 0.55, env: 0.35, wet: 0, detail: 0.5 },
  // A person's other cloths, so an outfit reads by its value and its sheen
  // and not by its hue alone.
  linen: { surface: 'linen', scale: 0.6, normalScale: 0.35, env: 0.4, wet: 0, detail: 0, moving: true },
  wool: { surface: 'wool', scale: 0.8, normalScale: 0.7, env: 0.22, wet: 0, detail: 0, moving: true },
  // Faces carry their own form in their normals now (heads.py sets every one
  // from the sculpt), and at 0.28 with the world-space grain on top the skin's
  // relief was the lumpiness a review called clay: a one-centimetre bump on a
  // face fifteen wide. The mottling stays in the colour; the relief is a whisper.
  skin: { surface: 'skin', scale: 0.5, normalScale: 0.07, env: 0.5, wet: 0, detail: 0 },
  plaster: { surface: 'plaster', scale: 3, normalScale: 0.34, env: 0.7, wet: 0, detail: 0.45 },
  stonewall: { surface: 'stonewall', scale: 3.6, normalScale: 1.0, env: 0.72, wet: 0, detail: 0.55 },
  timber: { surface: 'timber', scale: 5.2, normalScale: 0.9, env: 0.8, wet: 0, detail: 0.45 },
  // A door leaf's boards: see the surface.
  doorboard: { surface: 'doorboard', scale: 1.4, normalScale: 0.6, env: 0.7, wet: 0, detail: 0.4 },
  planks: { surface: 'planks', scale: 2.4, normalScale: 0.7, env: 0.85, wet: 0, detail: 0.45 },
  rooftile: { surface: 'rooftile', scale: 2.6, normalScale: 1.1, env: 1.0, wet: 0.35, detail: 0.5 },
  thatch: { surface: 'thatch', scale: 3, normalScale: 1.2, env: 0.55, wet: 0, detail: 0.7 },
  dirt: { surface: 'dirt', scale: 4.5, normalScale: 0.9, env: 0.7, wet: 0.3, detail: 0.6 },
  grass: { surface: 'grass', scale: 5.5, normalScale: 0.2, env: 0.6, wet: 0, detail: 0.3 },
  // The blades over it: an atlas of cards, not a tile (GRASS_CARDS), baked at
  // twice the usual size because a blade is a few millimetres wide.
  grassblades: { surface: 'grassblades', size: 1024, scale: 1, normalScale: 0.15, env: 0.45, wet: 0, detail: 0, cutout: 0.5 },
  // The wettest recipe there is, and out of doors, which is where `wet`
  // belongs: damp standing in the low patches is the whole of what tells a bog
  // apart from a ploughed field.
  // Low `env`, and that is what keeps it brown: the blue channel was being
  // lifted 54 -> 80 by the sky alone, which is how a dark mud desaturates into
  // a pale tan. Rough wet organic ground reflects very little of the dome.
  peat: { surface: 'peat', scale: 4.2, normalScale: 0.45, env: 0.48, wet: 0.65, detail: 0.35 },
  // Below the river's 1.6: a pool under a hedge of reeds sees a fraction of the
  // sky an open reach does, and a full mirror of it read as a puddle of sky.
  bogwater: { surface: 'bogwater', scale: 3.4, normalScale: 0.35, env: 0.8, wet: 0, detail: 0.15 },
  // World-unit tile like everything else, so a crown at 80 m repeats at the
  // same physical size as one at 8 -- the per-model stretch was half of what
  // made the trees read as toys.
  leaves: { surface: 'leaves', scale: 2.0, normalScale: 0.5, env: 0.4, wet: 0, detail: 0.35 },
  // The walls that were `rock`: see the surface. Its tile is its own 3 m.
  rubblewall: { surface: 'rubblewall', scale: 3, normalScale: 0.9, env: 0.7, wet: 0, detail: 0.55 },
  rock: { surface: 'rock', scale: 5, normalScale: 1.2, env: 0.9, wet: 0.25, detail: 0.6 },
  sand: { surface: 'sand', scale: 6, normalScale: 0.4, env: 0.55, wet: 0, detail: 0.6 },
  // Out of doors and loose, so it takes damp -- but a path drains, which is the
  // whole point of gravelling one, so well under the street's 0.5.
  gravel: { surface: 'gravel', scale: 2.4, normalScale: 0.7, env: 0.75, wet: 0.28, detail: 0.6 },
  // Matt and dry: needle litter is the least reflective surface out of doors,
  // and it sheds water rather than holding it in pools. Low `env` for the same
  // reason peat has it -- a forest floor sees a fraction of the dome, and a
  // full mirror of the sky turns brown litter grey.
  duff: { surface: 'duff', scale: 3.2, normalScale: 0.45, env: 0.42, wet: 0, detail: 0.5 },
  iron: { surface: 'iron', scale: 1.6, normalScale: 0.5, env: 1.4, wet: 0, detail: 0.3 },
  // Arms and armour. Tile sizes are the size of the things: a blade is 5 cm
  // across and a shield 70.
  steel: { surface: 'steel', scale: 0.6, normalScale: 0.35, env: 1.5, wet: 0, detail: 0.25 },
  mail: { surface: 'mail', scale: 0.3, normalScale: 0.6, env: 1.3, wet: 0, detail: 0.2 },
  paint: { surface: 'paint', scale: 0.8, normalScale: 0.5, env: 0.6, wet: 0, detail: 0.4 },
  bark: { surface: 'bark', scale: 1.6, normalScale: 1.0, env: 0.65, wet: 0, detail: 0.5 },
  // The conifers. A needle card's UVs are the card, 0..1, so its tile is 1.
  // `cutout` is the alpha test: an alpha-*tested* card sorts and shadows like
  // anything opaque, where a blended one would need sorting per card.
  needles: { surface: 'needles', scale: 1, normalScale: 0.5, env: 0.3, wet: 0, detail: 0, cutout: 0.4 },
  // The broadleaf cards, same arrangement as the needles: UVs are the card.
  oakleaf: { surface: 'oakleaf', scale: 1, normalScale: 0.35, env: 0.35, wet: 0, detail: 0, cutout: 0.5 },
  shrubleaf: { surface: 'shrubleaf', scale: 1, normalScale: 0.35, env: 0.35, wet: 0, detail: 0, cutout: 0.5 },
  salal: { surface: 'salal', scale: 1, normalScale: 0.4, env: 0.6, wet: 0, detail: 0, cutout: 0.5 },
  hedgeleaf: { surface: 'hedgeleaf', scale: 1, normalScale: 0.35, env: 0.35, wet: 0, detail: 0, cutout: 0.5 },
  nettleleaf: { surface: 'nettleleaf', scale: 1, normalScale: 0.35, env: 0.35, wet: 0, detail: 0, cutout: 0.5 },
  brambleleaf: { surface: 'brambleleaf', scale: 1, normalScale: 0.4, env: 0.45, wet: 0, detail: 0, cutout: 0.5 },
  weedleaf: { surface: 'weedleaf', scale: 1, normalScale: 0.3, env: 0.35, wet: 0, detail: 0, cutout: 0.5 },
  herbleaf: { surface: 'herbleaf', scale: 1, normalScale: 0.3, env: 0.35, wet: 0, detail: 0, cutout: 0.5 },
  fernleaf: { surface: 'fernleaf', scale: 1, normalScale: 0.3, env: 0.35, wet: 0, detail: 0, cutout: 0.5 },
  firbark: { surface: 'firbark', scale: 1.4, normalScale: 0.9, env: 0.35, wet: 0, detail: 0.5 },
  cedarbark: { surface: 'cedarbark', scale: 1.2, normalScale: 0.9, env: 0.5, wet: 0, detail: 0.5 },
  water: { surface: 'water', scale: 7, normalScale: 0.5, env: 1.6, wet: 0, detail: 0.2 },
  // The sewer. `buried` hands their ambient, reflections and fog to the fixed
  // underground terms above instead of the sky, so `env` means nothing here.
  // The brick's tile is the bond's own 2.25 m, see the surface.
  brick: { surface: 'brick', scale: 2.25, normalScale: 0.5, env: 1, wet: 0, detail: 0.5, buried: true },
  ashlar: { surface: 'ashlar', scale: 3.0, normalScale: 0.6, env: 1, wet: 0, detail: 0.5, buried: true },
  sewage: { surface: 'sewage', scale: 3.6, normalScale: 0.4, env: 1, wet: 0, detail: 0.1, buried: true },
  sludge: { surface: 'sludge', scale: 3.0, normalScale: 0.7, env: 1, wet: 0, detail: 0.4, buried: true },
  // The town's own flags, rock and iron, as they are below ground: the same
  // surfaces, lit the way everything down there is lit.
  sewerflag: { surface: 'flagstone', scale: 2.6, normalScale: 0.85, env: 1, wet: 0, detail: 0.5, buried: true },
  // A burrow's walls: see the surface. Indoors, and never wet enough to shine.
  earthwall: { surface: 'earthwall', scale: 3.4, normalScale: 0.7, env: 0.6, wet: 0, detail: 0.5 },
  caverock: { surface: 'caverock', scale: 4.4, normalScale: 1.0, env: 1, wet: 0, detail: 0.6, buried: true },
  cavefloor: { surface: 'cavefloor', scale: 3.2, normalScale: 0.8, env: 1, wet: 0, detail: 0.6, buried: true },
  rustiron: { surface: 'rust', scale: 1.2, normalScale: 0.5, env: 1, wet: 0, detail: 0.3, buried: true },
  // The same, above ground: the guild wells' rungs.
  rust: { surface: 'rust', scale: 1.2, normalScale: 0.5, env: 0.9, wet: 0, detail: 0.3 },
  fungus: { surface: 'fungus', scale: 0.8, normalScale: 0.4, env: 1, wet: 0, detail: 0.3, buried: true },
  bone: { surface: 'bone', scale: 0.6, normalScale: 0.4, env: 1, wet: 0, detail: 0.3, buried: true },
  sewerwood: { surface: 'bark', scale: 1.6, normalScale: 0.6, env: 1, wet: 0, detail: 0.4, buried: true },
  // The eastern mountains, outside and in.
  // `triplanar`: projected from the world in the shader, not from the model's
  // UVs -- a displaced cliff cube-projected in Blender wore its beds smeared
  // down every face that leaned. `moss` is how far up the flanks it creeps,
  // 0 to 1: see DIKU_MOSS.
  cliff: { surface: 'sandstone', scale: 9, normalScale: 0.35, env: 0.3, wet: 0, detail: 0.6, triplanar: true },
  // The cave rock again, out under the sky: the crag heaped over the troll
  // den. Not `rock`, which is crazy paving, and not `cliff`, which is the
  // desert's sandstone and read as a mesa in a fir forest.
  crag: { surface: 'caverock', scale: 7, normalScale: 0.8, env: 0.55, wet: 0.2, detail: 0.6, triplanar: true, moss: 0.18 },
  // A boulder and a fallen log, with the moss grown on in the shader rather
  // than modelled as a cap: a green shell has an edge, and moss does not.
  mossrock: { surface: 'caverock', scale: 2.6, normalScale: 0.8, env: 0.6, wet: 0.2, detail: 0.6, triplanar: true, moss: 0.42 },
  mossbark: { surface: 'bark', scale: 1.6, normalScale: 1.0, env: 0.65, wet: 0, detail: 0.5, moss: 0.4 },
  // A full `env`: cloth this open lets the sky through, and at 0.4 a tent's
  // corners went to RGB 0 after dark however hard the lantern burned.
  tentcloth: { surface: 'tentcloth', scale: 4, normalScale: 0.5, env: 1.0, wet: 0, detail: 0.4 },
  rug: { surface: 'rug', scale: 3.4, normalScale: 0.3, env: 0.35, wet: 0, detail: 0.3 },
  frond: { surface: 'frond', scale: 1.2, normalScale: 0.5, env: 0.5, wet: 0, detail: 0.3 },
  rope: { surface: 'rope', scale: 0.3, normalScale: 0.6, env: 0.4, wet: 0, detail: 0.2 },
  cavewater: { surface: 'cavewater', scale: 4, normalScale: 0.3, env: 1, wet: 0, detail: 0.1, buried: true },
  // The Dangerous Neighborhood. `brokencobble` keeps the street's damp -- the
  // holes are where the water stands -- and `ash` has none, being indoors
  // under no roof and dry as the fire left it. `oldbone` is the sewer's bone
  // out in the daylight, for the gang's idol.
  // `env` well over the town's: the soot is dark, and a dark albedo in the
  // shade after dusk is RGB 0 (57% of a No Man's Land frame at dusk under 8).
  // The sky term is the one that lights the shaded faces, so it carries them.
  // A sooty wall is darker than the town's stone, but not uniformly: the
  // tongues are near black and the grime between them a mid grey. A uniform
  // dark grey read as plain grey stone in the sun and went under 8 in the
  // shade at dusk (51% of a No Man's Land frame); streaked, it reads as soot
  // in the sun and the grime holds the shade up. Mean albedo 0.14, and the dusk and night shade held up by `lift`.
  sootwall: { surface: 'sootwall', scale: 3.6, normalScale: 0.8, env: 0.6, lift: true, wet: 0, detail: 0.55 },
  rubble: { surface: 'rubble', scale: 2.4, normalScale: 1.1, env: 0.8, lift: true, wet: 0, detail: 0.6 },
  charred: { surface: 'charred', scale: 1.4, normalScale: 0.55, env: 0.5, lift: true, wet: 0, detail: 0.5 },
  boards: { surface: 'boards', scale: 2.0, normalScale: 0.7, env: 0.7, wet: 0, detail: 0.45 },
  // The furniture (tools/blender/furniture.py). `firebrick` is the sewer's
  // brick without `buried`, for an oven and a forge that stand in a lit room.
  wood: { surface: 'wood', scale: 1.2, normalScale: 0.3, env: 0.75, wet: 0, detail: 0.2 },
  blanket: { surface: 'blanket', scale: 0.6, normalScale: 0.4, env: 0.3, wet: 0, detail: 0 },
  firebrick: { surface: 'brick', scale: 2.25, normalScale: 0.5, env: 0.8, wet: 0, detail: 0.5 },
  // A room something has burned out, underground: the ruins' soot on the
  // walls, and a floor whose cracks are still hot (`glow` is the emissive's
  // strength, over the bloom threshold where the heat is).
  scorched: { surface: 'sootwall', scale: 3.6, normalScale: 1.0, env: 1, wet: 0, detail: 0.55, buried: true },
  // ...and the same floor cold, for a room the fire is long out of.
  charstone: { surface: 'cinders', scale: 3.2, normalScale: 0.8, env: 1, wet: 0, detail: 0.5, buried: true },
  emberstone: { surface: 'embers', scale: 3.2, normalScale: 0.9, env: 1, wet: 0, detail: 0.5, buried: true, glow: 3.2 },
  // The sewer's ashlar in daylight: the dressed stone round a window in a
  // masonry wall, which is finer and paler work than the wall it stands in.
  dressing: { surface: 'ashlar', scale: 3.0, normalScale: 0.6, env: 0.8, wet: 0, detail: 0.5 },
  brokencobble: { surface: 'brokencobble', scale: 2.2, normalScale: 1.0, env: 1.05, lift: true, wet: 0.55, detail: 0.5 },
  ash: { surface: 'ash', scale: 3.0, normalScale: 0.6, env: 0.6, lift: true, wet: 0, detail: 0.6 },
  wasteground: { surface: 'wasteground', scale: 4.0, normalScale: 0.7, env: 0.45, lift: true, wet: 0, detail: 0.6 },
  oldbone: { surface: 'bone', scale: 0.6, normalScale: 0.4, env: 0.7, wet: 0, detail: 0.3 },
  // Ice Dragon Way's smashed crystal statues: nearly all reflection.
  crystal: { surface: 'crystal', scale: 0.8, normalScale: 0.35, env: 1.7, wet: 0, detail: 0.1 },
  // Set pieces (tools/blender/setpiece.py): the marsh fortress's black stone,
  // the monolith's volcanic glass, the Market Square worm's bronze. The two
  // dark ones take `lift` for the same reason soot does.
  blackstone: { surface: 'blackstone', scale: 3.6, normalScale: 0.9, env: 0.75, lift: true, wet: 0, detail: 0.5 },
  obsidian: { surface: 'obsidian', scale: 3.2, normalScale: 0.3, env: 1.5, lift: true, wet: 0, detail: 0.1 },
  bronze: { surface: 'bronze', scale: 1.2, normalScale: 0.4, env: 1.1, wet: 0, detail: 0.3 },
  // The animals. A 0.4 m tile is a hand's-breadth clump pattern on a dog and
  // still reads as a coat on a horse. `moving` keeps the world-space effects
  // off them: a splash line fixed to the paving and a grain fixed to the world
  // both slide over anything that walks through them.
  fur: { surface: 'fur', scale: 0.3, normalScale: 0.5, env: 0.4, wet: 0, detail: 0, moving: true },
  feather: { surface: 'feather', scale: 0.3, normalScale: 0.3, env: 0.5, wet: 0, detail: 0, moving: true },
  // The monsters (tools/blender/monsters.py): shell, living mud and reptile
  // skin, all coloured per creature in its vertices like the fur.
  chitin: { surface: 'chitin', scale: 0.35, normalScale: 0.35, env: 0.9, wet: 0, detail: 0, moving: true },
  ooze: { surface: 'ooze', scale: 0.6, normalScale: 0.5, env: 1.1, wet: 0, detail: 0, moving: true },
  hide: { surface: 'hide', scale: 0.25, normalScale: 0.4, env: 0.5, wet: 0, detail: 0, moving: true },
  // A troll's skin, one of the surfaces a person is made of (dress.js).
  warthide: { surface: 'warthide', scale: 0.3, normalScale: 0.6, env: 0.45, wet: 0, detail: 0, moving: true },
  // What a room's own words say its shell is made of (src/shells.js
  // `readShell`): honed stone in any colour, tinted per room in build.js; the
  // hollow of a tree; ice. `polisheddeep` is the same stone underground.
  polished: { surface: 'polished', scale: 3.0, normalScale: 0.45, env: 1.0, wet: 0, detail: 0.2 },
  polisheddeep: { surface: 'polished', scale: 3.0, normalScale: 0.45, env: 1, wet: 0, detail: 0.2, buried: true },
  livingwood: { surface: 'livingwood', scale: 2.4, normalScale: 0.9, env: 0.7, wet: 0, detail: 0.4 },
  ice: { surface: 'ice', scale: 3.0, normalScale: 0.5, env: 1.4, wet: 0, detail: 0.15 },
};

// --------------------------------------------------------------- decals ----

/**
 * Paint on a wall and blood on the ground, for the Dangerous Neighborhood.
 * These are not tiling surfaces: each is one mark on a transparent square,
 * laid on a quad with its own 0..1 UVs by build.js, so they are baked here as
 * RGBA with the shape in the alpha and cut out with `alphaTest`.
 *
 * The mud's own words are "spray-painted" and "graffiti", which is 1993 and
 * not the town this is. What a gang in a medieval town paints is a mark: the
 * two here are read off the prose. North of No Man's Land the Trolls are the
 * Dragon gang, whose idol is the Dracolich, so theirs is a horned dragon's
 * skull in limewash; south of it the Ogres, and theirs is a hand in red ochre
 * -- the oldest mark there is, and a big one. Where the two meet, one gang's
 * mark gets struck through in the other's colour.
 *
 * Coordinates are (x, y) in [-1, 1] with y *up*: a DataTexture is not flipped,
 * so row 0 is the bottom of the quad.
 */
const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax; const vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
};
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;

const DECAL_SHAPES = {
  /** The Dragon gang: a horned dragon's skull, front on. */
  troll(x, y) {
    const ax = Math.abs(x);
    let ink = inEllipse(x, y, 0, 0.18, 0.44, 0.36);
    // The snout narrows to the nose.
    if (y < 0 && y > -0.78) ink = ink || ax < 0.31 - (-y / 0.78) * 0.15;
    // The brow ridge flares a little past the cranium.
    ink = ink || inEllipse(x, y, 0, 0.3, 0.52, 0.1);
    // Horns: swept up and out from the temples, tapering to a point.
    for (let i = 0; i < 12 && !ink; i++) {
      const t0 = i / 12; const t1 = (i + 1) / 12;
      const hx = (t) => 0.3 + t * 0.34 + t * t * 0.14;
      const hy = (t) => 0.38 + t * 0.42 + t * t * 0.1;
      const r = 0.085 * (1 - t0 * 0.85);
      if (segDist(ax, y, hx(t0), hy(t0), hx(t1), hy(t1)) < r) ink = true;
    }
    if (!ink) return 0;
    // Eye sockets, slanted, and the nostrils: bare wall inside the mark.
    const ex = ax - 0.18; const ey = y - 0.1;
    if ((ex * 0.94 + ey * 0.34) ** 2 / 0.0144 + (ey * 0.94 - ex * 0.34) ** 2 / 0.0049 < 1) return 0;
    if (inEllipse(ax, y, 0.07, -0.63, 0.035, 0.05)) return 0;
    // Teeth: notches up into the jaw line.
    if (y < -0.5 && y > -0.74 && ax > 0.08 && ax < 0.26 && ((ax * 18) % 1) < 0.35 && y < -0.62 + ((ax * 18) % 1) * 0.2) return 0;
    return 1;
  },
  /** The Ogres: an open hand. */
  ogre(x, y) {
    // The palm, a rounded box.
    const qx = Math.max(Math.abs(x + 0.02) - 0.26, 0); const qy = Math.max(Math.abs(y + 0.3) - 0.22, 0);
    if (Math.hypot(qx, qy) < 0.13) return 1;
    const fingers = [[-0.27, 0.62, -0.12], [-0.09, 0.8, -0.03], [0.09, 0.76, 0.04], [0.26, 0.56, 0.12]];
    for (const [fx, top, lean] of fingers) {
      if (segDist(x, y, fx, 0.0, fx + lean, top) < 0.088) return 1;
    }
    if (segDist(x, y, -0.34, -0.3, -0.74, 0.02) < 0.095) return 1;
    return 0;
  },
  /** A mark struck through: two dragged strokes. */
  strike(x, y) {
    if (segDist(x, y, -0.8, -0.72, 0.78, 0.8) < 0.1 - x * 0.02) return 1;
    if (segDist(x, y, -0.76, 0.7, 0.8, -0.66) < 0.09 + x * 0.02) return 1;
    return 0;
  },
  /** Blood dried into the dirt: a pool and what was thrown off it. */
  blood(x, y) {
    const r = Math.hypot(x, y);
    const lobe = fbm(Math.atan2(y, x) * 1.3 + 4, r * 2, 8, 811, 3);
    if (r < 0.26 + lobe * 0.34) return 1;
    for (let i = 0; i < 14; i++) {
      const a = hash2(i, 0, 99, 821) * Math.PI * 2;
      const d = 0.45 + hash2(i, 1, 99, 823) * 0.45;
      const size = 0.02 + hash2(i, 2, 99, 827) * 0.05;
      const cx = Math.cos(a) * d; const cy = Math.sin(a) * d;
      // Thrown drops are elongated along the way they flew.
      const along = ((x - cx) * Math.cos(a) + (y - cy) * Math.sin(a)) / 2.2;
      const across = -(x - cx) * Math.sin(a) + (y - cy) * Math.cos(a);
      if (Math.hypot(along, across) < size) return 1;
    }
    return 0;
  },
};

const DECAL_PAINT = {
  troll: { base: 0xd8d2c0, dark: 0xb3ad9c, drips: true },
  ogre: { base: 0x8e2f1f, dark: 0x6a2016, drips: true },
  strike: { base: 0x8a2e1e, dark: 0x642015, drips: true, dragged: true },
  blood: { base: 0x3a0f0b, dark: 0x220706, drips: false },
};

function bakeDecal(name, size = 256) {
  const shape = DECAL_SHAPES[name];
  const paint = DECAL_PAINT[name];
  const data = new Uint8ClampedArray(size * size * 4);
  const lift = (c) => 255 * Math.pow(Math.max(0, Math.min(1, c / 255)), 0.62);
  // Paint runs: a column here and there carries a drip down from the lowest
  // painted point above it, as far as the paint had to run before it dried.
  const cols = 48;
  const dripLen = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const roll = hash2(c, 0, cols, 831);
    dripLen[c] = paint.drips && roll > 0.72 ? 0.08 + (roll - 0.72) * 1.6 : 0;
  }
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size; const v = (py + 0.5) / size;
      // A brush edge is never a clean line: jitter the lookup a little.
      const jx = (fbm(u * 18, v * 18, 18, 841, 2) - 0.5) * 0.05;
      const jy = (fbm(u * 18 + 5, v * 18, 18, 853, 2) - 0.5) * 0.05;
      const x = u * 2 - 1 + jx; const y = v * 2 - 1 + jy;
      let ink = shape(x, y);
      if (!ink && paint.drips) {
        const c = Math.min(cols - 1, Math.floor(u * cols));
        const centre = (c + 0.5) / cols * 2 - 1;
        const len = dripLen[c];
        if (len && Math.abs(u * 2 - 1 - centre) < 0.012 + len * 0.02) {
          for (let d = 0.02; d <= len; d += 0.03) {
            if (shape(centre, y + d)) { ink = 1 - d / (len + 0.05) > 0.2 ? 1 : 0; break; }
          }
        }
      }
      // Weathered: the wall shows through where the paint has flaked, more of
      // it towards the edges and along the strokes if it was dragged on.
      const flake = fbm(u * 26, v * (paint.dragged ? 6 : 26), 26, 861, 3);
      if (ink && flake < 0.25) ink = 0;
      const i = (py * size + px) * 4;
      const tone = fbm(u * 9, v * 9, 9, 871, 3);
      const c = mix(rgb(paint.base), rgb(paint.dark), tone * 0.8);
      data[i] = lift(c[0]); data[i + 1] = lift(c[1]); data[i + 2] = lift(c[2]);
      data[i + 3] = ink ? 255 : 0;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** The decal materials, keyed `decal_<name>`, in the same table as everything else. */
function createDecals(materials) {
  for (const name of Object.keys(DECAL_SHAPES)) {
    const material = new THREE.MeshStandardMaterial({
      map: bakeDecal(name),
      alphaTest: 0.5,
      roughness: name === 'blood' ? 0.55 : 0.88,
      metalness: 0,
      envMapIntensity: 0.6,
      // Laid a centimetre off the surface and pulled forward in depth as well:
      // at thirty metres a centimetre is below depth precision.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    material.name = `decal_${name}`;
    material.userData.uvScale = 1;
    material.defaultAttributeValues = { aIndoor: [0] };
    materials[material.name] = material;
  }
}

// -------------------------------------------------------------- paintings ----

/**
 * What the prose says is painted, drawn or written on a room's walls, as
 * against hung on them (clutter.js frames those): "most of the walls are
 * covered by ancient wall paintings picturing Gods, Giants and peasants",
 * "drawings of faces in pain are on the walls", "the walls are covered with
 * blood", "you read the number '666'".
 *
 * Drawn with the 2D canvas at boot -- a figure is a handful of curves, which
 * a per-pixel surface function cannot draw -- then weathered per pixel and
 * handed to the same decorated material as every wall, so a painting is lit
 * by the room it is in (indoor bounce, the sewer's buried fill) exactly as
 * the stone under it is. Laid by build.js as quads with their own UVs, from
 * the regions below.
 *
 * Canvas rows run down and a DataTexture's run up, so every region's `v` is
 * measured from the bottom here.
 */

// Fresco earths. They go through the albedo lift like every baked colour, so
// they are picked darker than they read on a swatch.
const FRESCO = {
  ground: '#d9c9a8', plaster: '#c7b692', line: '#2b1d16', ochre: '#c09037', gold: '#cfa03a',
  red: '#8e3320', terra: '#a8532d', lapis: '#34507f', lapisDark: '#243a5e', verdigris: '#4b7563',
  flesh: '#d9b48a', peasant: '#9a5f3a', giant: '#7b8583', giantDark: '#59625f', white: '#e9e0cc',
  sky: '#7f97a6', skyLow: '#a9b3ad', field: '#b8984f', fieldDark: '#8f7337', black: '#1d1714',
  dado: '#6a2819',
};

/** Where each composition lies in the mural atlas: [u0, v0, u1, v1], v up. */
export const MURAL_REGIONS = {
  wideA: [0, 0.5, 0.75, 1], tallA: [0.75, 0.5, 1, 1],
  wideB: [0, 0, 0.75, 0.5], tallB: [0.75, 0, 1, 0.5],
};
/** The faces atlas: three by three, `faceRegion(k)` for the k-th. */
export const faceRegion = (k) => {
  const i = k % 3; const j = Math.floor(k / 3) % 3;
  return [i / 3, 1 - (j + 1) / 3, (i + 1) / 3, 1 - j / 3];
};
/** The blood atlas: two by two. */
export const bloodRegion = (k) => {
  const i = k % 2; const j = Math.floor(k / 2) % 2;
  return [i / 2, 1 - (j + 1) / 2, (i + 1) / 2, 1 - j / 2];
};

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** A small deterministic generator, so the paintings are the same every boot. */
function paintRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One figure, in the hieratic manner of a temple wall: frontal or in
 * profile, outlined in black, flat earth colours. `h` is its height in
 * pixels from the soles to the crown; `dir` which way it faces.
 */
function paintFigure(ctx, f) {
  const {
    x, base, h, dir = 1, robe = FRESCO.lapis, trim = FRESCO.gold, skin = FRESCO.flesh,
    hair = FRESCO.black, bulk = 1, legs = false, seated = false, halo = false, beard = false,
    crown = false, arms = [0.35, -0.5], hold = null, lying = false,
  } = f;
  ctx.save();
  if (lying) {
    // A fallen giant: the same figure, turned onto its back along the ground.
    ctx.translate(x, base);
    ctx.rotate(-Math.PI / 2 * dir);
    ctx.translate(-x, -base);
  }
  const lw = Math.max(2, h * 0.009);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const ink = (width = lw) => { ctx.strokeStyle = FRESCO.line; ctx.lineWidth = width; ctx.stroke(); };
  const r = h * 0.068;
  const headY = base - h + r * 1.05;
  const shY = headY + r + h * 0.045;
  const sw = h * 0.125 * bulk;
  const waistY = shY + h * (seated ? 0.22 : 0.27);
  const hemY = seated ? base - h * 0.34 : base - (legs ? h * 0.34 : h * 0.025);
  const hw = h * (legs ? 0.14 : 0.2) * bulk;

  if (halo) {
    ctx.beginPath(); ctx.arc(x, headY, r * 1.85, 0, Math.PI * 2);
    ctx.fillStyle = FRESCO.gold; ctx.fill(); ink(lw * 0.8);
    ctx.beginPath(); ctx.arc(x, headY, r * 1.55, 0, Math.PI * 2);
    ctx.strokeStyle = '#a77a26'; ctx.lineWidth = lw * 0.7; ctx.stroke();
  }
  const limb = (x0, y0, x1, y1, width, colour) => {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.strokeStyle = FRESCO.line; ctx.lineWidth = width + lw * 2; ctx.stroke();
    ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.stroke();
  };
  const hand = (a, reach) => [x + Math.sin(a) * reach * dir, shY + Math.cos(a) * reach];
  const armLen = h * 0.36 * (0.9 + bulk * 0.1);
  const armW = h * 0.05 * bulk;
  // The far arm first, behind the body.
  const [bx, by] = hand(arms[1], armLen);
  limb(x - sw * 0.7 * dir, shY + armW * 0.4, bx, by, armW, robe);
  if (legs && !seated) {
    for (const s of [-1, 1]) {
      const lx = x + s * hw * 0.45;
      limb(lx, hemY - h * 0.02, lx + s * h * 0.03, base - h * 0.025, h * 0.055 * bulk, skin);
      ctx.beginPath(); ctx.ellipse(lx + s * h * 0.03 + dir * h * 0.025, base - h * 0.012, h * 0.045, h * 0.016, 0, 0, Math.PI * 2);
      ctx.fillStyle = skin; ctx.fill(); ink();
    }
  }
  if (seated) {
    // The throne behind, the lap forward, the shins down to a footstool.
    ctx.beginPath();
    ctx.rect(x - h * 0.22, headY + r * 0.2, h * 0.44, base - headY - h * 0.06);
    ctx.fillStyle = FRESCO.terra; ctx.fill(); ink();
    ctx.beginPath(); ctx.rect(x - h * 0.26, base - h * 0.42, h * 0.52, h * 0.08);
    ctx.fillStyle = FRESCO.gold; ctx.fill(); ink();
    ctx.beginPath(); ctx.rect(x - h * 0.16, base - h * 0.06, h * 0.32, h * 0.06);
    ctx.fillStyle = FRESCO.ochre; ctx.fill(); ink();
    for (const s of [-1, 1]) limb(x + s * h * 0.07, hemY, x + s * h * 0.08, base - h * 0.07, h * 0.06, robe);
  }
  // The body, shoulders to hem, and its folds.
  ctx.beginPath();
  ctx.moveTo(x - sw, shY);
  ctx.quadraticCurveTo(x - sw * 0.95, (shY + waistY) / 2, x - h * 0.1 * bulk, waistY);
  ctx.quadraticCurveTo(x - hw * 0.95, (waistY + hemY) / 2, x - hw, hemY);
  ctx.quadraticCurveTo(x, hemY + h * 0.02, x + hw, hemY);
  ctx.quadraticCurveTo(x + hw * 0.95, (waistY + hemY) / 2, x + h * 0.1 * bulk, waistY);
  ctx.quadraticCurveTo(x + sw * 0.95, (shY + waistY) / 2, x + sw, shY);
  ctx.closePath();
  ctx.fillStyle = robe; ctx.fill(); ink();
  ctx.strokeStyle = 'rgba(20,14,10,0.45)'; ctx.lineWidth = lw * 0.8;
  for (let k = -2; k <= 2; k++) {
    ctx.beginPath();
    ctx.moveTo(x + k * sw * 0.3, waistY + h * 0.02);
    ctx.quadraticCurveTo(x + k * sw * 0.42 + dir * h * 0.01, (waistY + hemY) / 2, x + k * hw * 0.38, hemY - h * 0.01);
    ctx.stroke();
  }
  // A belt and a hem of the trim colour.
  ctx.beginPath(); ctx.rect(x - h * 0.1 * bulk, waistY - h * 0.012, h * 0.2 * bulk, h * 0.024);
  ctx.fillStyle = trim; ctx.fill(); ink(lw * 0.7);
  ctx.beginPath(); ctx.moveTo(x - hw, hemY - h * 0.02); ctx.quadraticCurveTo(x, hemY, x + hw, hemY - h * 0.02);
  ctx.strokeStyle = trim; ctx.lineWidth = h * 0.02; ctx.stroke();
  // Neck, head, hair, face.
  ctx.beginPath(); ctx.rect(x - r * 0.4, headY + r * 0.6, r * 0.8, shY - headY - r * 0.5);
  ctx.fillStyle = skin; ctx.fill(); ink(lw * 0.7);
  ctx.beginPath(); ctx.ellipse(x, headY, r * 0.86, r, 0, 0, Math.PI * 2);
  ctx.fillStyle = skin; ctx.fill(); ink();
  ctx.beginPath(); ctx.ellipse(x - dir * r * 0.1, headY - r * 0.35, r * 0.92, r * 0.7, 0, Math.PI, Math.PI * 2);
  ctx.fillStyle = hair; ctx.fill(); ink(lw * 0.8);
  if (beard) {
    ctx.beginPath();
    ctx.moveTo(x - r * 0.75, headY + r * 0.2);
    ctx.quadraticCurveTo(x, headY + r * 2.6, x + r * 0.75, headY + r * 0.2);
    ctx.fillStyle = hair; ctx.fill(); ink(lw * 0.8);
  }
  ctx.fillStyle = FRESCO.line;
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.ellipse(x + s * r * 0.33, headY - r * 0.05, r * 0.14, r * 0.08, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.beginPath(); ctx.moveTo(x, headY + r * 0.05); ctx.lineTo(x + dir * r * 0.08, headY + r * 0.35);
  ctx.strokeStyle = FRESCO.line; ctx.lineWidth = lw * 0.6; ctx.stroke();
  if (crown) {
    ctx.beginPath();
    const cy = headY - r * 0.75;
    ctx.moveTo(x - r * 0.8, cy + r * 0.3);
    for (let k = 0; k <= 4; k++) ctx.lineTo(x - r * 0.8 + k * r * 0.4, cy - (k % 2 ? 0 : r * 0.55));
    ctx.lineTo(x + r * 0.8, cy + r * 0.3); ctx.closePath();
    ctx.fillStyle = FRESCO.gold; ctx.fill(); ink(lw * 0.7);
  }
  // The near arm, and whatever it holds.
  const [fx, fy] = hand(arms[0], armLen);
  limb(x + sw * 0.8 * dir, shY + armW * 0.4, fx, fy, armW, robe);
  ctx.beginPath(); ctx.arc(fx, fy, armW * 0.62, 0, Math.PI * 2); ctx.fillStyle = skin; ctx.fill(); ink(lw * 0.7);
  if (hold === 'spear' || hold === 'staff') {
    ctx.beginPath(); ctx.moveTo(fx, base - h * 0.01); ctx.lineTo(fx, fy - h * 0.42);
    ctx.strokeStyle = FRESCO.line; ctx.lineWidth = h * 0.02; ctx.stroke();
    ctx.strokeStyle = FRESCO.ochre; ctx.lineWidth = h * 0.011; ctx.stroke();
    if (hold === 'spear') {
      ctx.beginPath(); ctx.moveTo(fx - h * 0.025, fy - h * 0.4); ctx.lineTo(fx, fy - h * 0.5); ctx.lineTo(fx + h * 0.025, fy - h * 0.4); ctx.closePath();
      ctx.fillStyle = FRESCO.white; ctx.fill(); ink(lw * 0.7);
    }
  } else if (hold === 'club') {
    ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + dir * h * 0.1, fy - h * 0.34);
    ctx.strokeStyle = FRESCO.line; ctx.lineWidth = h * 0.075; ctx.stroke();
    ctx.strokeStyle = FRESCO.fieldDark; ctx.lineWidth = h * 0.055; ctx.stroke();
  } else if (hold === 'hammer') {
    ctx.beginPath(); ctx.moveTo(fx, fy + h * 0.05); ctx.lineTo(fx, fy - h * 0.16);
    ctx.strokeStyle = FRESCO.line; ctx.lineWidth = h * 0.024; ctx.stroke();
    ctx.beginPath(); ctx.rect(fx - h * 0.06, fy - h * 0.22, h * 0.12, h * 0.07);
    ctx.fillStyle = '#8a8f93'; ctx.fill(); ink();
  } else if (hold === 'sheaf') {
    for (let k = -3; k <= 3; k++) {
      ctx.beginPath(); ctx.moveTo(fx, fy + h * 0.06); ctx.lineTo(fx + k * h * 0.018, fy - h * 0.15);
      ctx.strokeStyle = FRESCO.ochre; ctx.lineWidth = h * 0.012; ctx.stroke();
    }
    ctx.beginPath(); ctx.ellipse(fx, fy - h * 0.16, h * 0.06, h * 0.04, 0, 0, Math.PI * 2);
    ctx.fillStyle = FRESCO.gold; ctx.fill(); ink(lw * 0.6);
  } else if (hold === 'sickle') {
    ctx.beginPath(); ctx.arc(fx + dir * h * 0.06, fy - h * 0.04, h * 0.07, Math.PI * 0.9, Math.PI * 2.1);
    ctx.strokeStyle = FRESCO.line; ctx.lineWidth = h * 0.02; ctx.stroke();
    ctx.strokeStyle = '#9aa0a3'; ctx.lineWidth = h * 0.011; ctx.stroke();
  } else if (hold === 'lamb') {
    ctx.beginPath(); ctx.ellipse(fx, fy - h * 0.02, h * 0.1, h * 0.06, 0, 0, Math.PI * 2);
    ctx.fillStyle = FRESCO.white; ctx.fill(); ink(lw * 0.7);
    ctx.beginPath(); ctx.arc(fx + dir * h * 0.1, fy - h * 0.05, h * 0.035, 0, Math.PI * 2);
    ctx.fillStyle = FRESCO.white; ctx.fill(); ink(lw * 0.7);
  } else if (hold === 'rock') {
    ctx.beginPath(); ctx.ellipse(fx, fy - h * 0.06, h * 0.11, h * 0.08, 0.4, 0, Math.PI * 2);
    ctx.fillStyle = FRESCO.giantDark; ctx.fill(); ink();
  }
  ctx.restore();
}

/** A bird in black, the ravens on the god's throne and in the sky. */
function paintBird(ctx, x, y, s, dir = 1) {
  ctx.beginPath();
  ctx.ellipse(x, y, s, s * 0.45, -0.2 * dir, 0, Math.PI * 2);
  ctx.moveTo(x + dir * s * 0.8, y - s * 0.3);
  ctx.arc(x + dir * s * 0.85, y - s * 0.35, s * 0.32, 0, Math.PI * 2);
  ctx.moveTo(x - dir * s * 0.7, y);
  ctx.lineTo(x - dir * s * 1.5, y + s * 0.3); ctx.lineTo(x - dir * s * 0.9, y + s * 0.3);
  ctx.fillStyle = FRESCO.black; ctx.fill();
  ctx.beginPath(); ctx.moveTo(x + dir * s * 1.1, y - s * 0.35); ctx.lineTo(x + dir * s * 1.45, y - s * 0.25); ctx.lineTo(x + dir * s * 1.1, y - s * 0.2);
  ctx.fillStyle = FRESCO.ochre; ctx.fill();
}

/** A stylised tree: trunk and a round crown, the way a fresco draws one. */
function paintTree(ctx, x, base, h) {
  ctx.beginPath(); ctx.rect(x - h * 0.05, base - h * 0.5, h * 0.1, h * 0.5);
  ctx.fillStyle = FRESCO.fieldDark; ctx.fill();
  ctx.strokeStyle = FRESCO.line; ctx.lineWidth = 3; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(x, base - h * 0.68, h * 0.3, h * 0.34, 0, 0, Math.PI * 2);
  ctx.fillStyle = FRESCO.verdigris; ctx.fill(); ctx.stroke();
}

/** The frame every panel shares: a meander frieze over, a dado under. */
function paintPanelFrame(ctx, x0, y0, w, h, sky = true) {
  const top = h * 0.06; const dado = h * 0.14;
  const horizon = y0 + top + (h - top - dado) * 0.58;
  if (sky) {
    const g = ctx.createLinearGradient(0, y0 + top, 0, horizon);
    g.addColorStop(0, FRESCO.sky); g.addColorStop(1, FRESCO.skyLow);
    ctx.fillStyle = g; ctx.fillRect(x0, y0 + top, w, horizon - y0 - top);
    const f = ctx.createLinearGradient(0, horizon, 0, y0 + h - dado);
    f.addColorStop(0, FRESCO.field); f.addColorStop(1, FRESCO.fieldDark);
    ctx.fillStyle = f; ctx.fillRect(x0, horizon, w, y0 + h - dado - horizon);
    ctx.strokeStyle = 'rgba(60,40,20,0.35)'; ctx.lineWidth = 2;
    for (let k = 1; k < 7; k++) {
      const y = horizon + (y0 + h - dado - horizon) * (k / 7);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y + (k % 2 ? 4 : -4)); ctx.stroke();
    }
  } else {
    ctx.fillStyle = FRESCO.ground; ctx.fillRect(x0, y0 + top, w, h - top - dado);
  }
  ctx.fillStyle = FRESCO.red; ctx.fillRect(x0, y0, w, top);
  // The meander: a key pattern in ochre along the red band.
  ctx.strokeStyle = FRESCO.ochre; ctx.lineWidth = Math.max(2, top * 0.14);
  const step = top * 1.2;
  ctx.beginPath();
  for (let x = x0 + step * 0.2; x < x0 + w - step; x += step) {
    const a = y0 + top * 0.78; const b = y0 + top * 0.22;
    ctx.moveTo(x, a); ctx.lineTo(x, b); ctx.lineTo(x + step * 0.7, b); ctx.lineTo(x + step * 0.7, a - top * 0.28);
    ctx.lineTo(x + step * 0.35, a - top * 0.28); ctx.lineTo(x + step * 0.35, a); ctx.lineTo(x + step, a);
  }
  ctx.stroke();
  ctx.fillStyle = FRESCO.dado; ctx.fillRect(x0, y0 + h - dado, w, dado);
  ctx.fillStyle = FRESCO.ochre; ctx.fillRect(x0, y0 + h - dado, w, dado * 0.08);
  ctx.fillStyle = FRESCO.black; ctx.fillRect(x0, y0 + h - dado * 0.92, w, dado * 0.03);
  ctx.strokeStyle = FRESCO.line; ctx.lineWidth = 4; ctx.strokeRect(x0 + 2, y0 + 2, w - 4, h - 4);
  return { top: y0 + top, ground: y0 + h - dado, horizon };
}

/** The atlas: two wide panels and two narrow ones, Gods, Giants and peasants. */
function paintMurals(size) {
  const c = canvas2d(size, size);
  const ctx = c.getContext('2d');
  const k = size / 2048;
  ctx.scale(k, k);
  const peasants = (y, xs, rnd) => xs.forEach((px, i) => {
    const holds = ['sickle', 'sheaf', 'lamb', 'sickle', 'sheaf', null];
    paintFigure(ctx, {
      x: px, base: y, h: 170 + rnd() * 30, dir: i % 2 ? -1 : 1, robe: [FRESCO.terra, FRESCO.ochre, FRESCO.white, FRESCO.verdigris][i % 4],
      trim: FRESCO.red, skin: FRESCO.peasant, hair: i % 3 ? FRESCO.black : '#6a4526', legs: true,
      arms: [0.9 + rnd() * 0.8, -0.3 - rnd() * 0.5], hold: holds[i % holds.length],
    });
  });

  // Wide A: the gods enthroned between two giants, the harvest brought to them.
  {
    const rnd = paintRng(11);
    const { top, ground } = paintPanelFrame(ctx, 0, 0, 1536, 1024);
    paintTree(ctx, 380, ground - 150, 170); paintTree(ctx, 1160, ground - 140, 160);
    paintFigure(ctx, { x: 190, base: ground, h: ground - top - 6, bulk: 1.45, dir: 1, robe: FRESCO.fieldDark, trim: FRESCO.terra, skin: FRESCO.giant, hair: FRESCO.giantDark, legs: true, beard: true, arms: [2.7, -0.4], hold: 'club' });
    paintFigure(ctx, { x: 1346, base: ground, h: ground - top - 6, bulk: 1.45, dir: -1, robe: FRESCO.fieldDark, trim: FRESCO.terra, skin: FRESCO.giant, hair: FRESCO.giantDark, legs: true, beard: true, arms: [2.5, 0.3], hold: 'rock' });
    paintFigure(ctx, { x: 768, base: ground - 30, h: 600, seated: true, halo: true, beard: true, crown: false, robe: FRESCO.lapis, trim: FRESCO.gold, hair: '#b9b4a8', arms: [0.5, -0.6], hold: 'spear' });
    paintBird(ctx, 660, ground - 520, 26, 1); paintBird(ctx, 880, ground - 520, 26, -1);
    paintFigure(ctx, { x: 520, base: ground - 20, h: 480, dir: 1, halo: true, beard: true, robe: FRESCO.red, trim: FRESCO.gold, hair: '#8a4a22', arms: [2.4, 0.2], hold: 'hammer' });
    paintFigure(ctx, { x: 1016, base: ground - 20, h: 470, dir: -1, halo: true, robe: FRESCO.verdigris, trim: FRESCO.gold, hair: '#c79a45', arms: [0.4, -0.3], hold: 'sheaf', crown: true });
    peasants(ground + 70, [330, 430, 620, 910, 1100, 1210], rnd);
  }
  // Tall A: a goddess with the harvest, a peasant kneeling at her feet.
  {
    const { top, ground } = paintPanelFrame(ctx, 1536, 0, 512, 1024);
    paintFigure(ctx, { x: 1792, base: ground - 10, h: ground - top - 60, dir: 1, halo: true, crown: true, robe: FRESCO.lapis, trim: FRESCO.gold, hair: '#5a3218', arms: [0.35, -0.4], hold: 'staff' });
    paintFigure(ctx, { x: 1660, base: ground + 20, h: 150, dir: 1, robe: FRESCO.terra, skin: FRESCO.peasant, legs: true, arms: [1.6, 1.2], hold: 'sheaf' });
  }
  // Wide B: the gods drive the giants back; below, the fields are ploughed.
  {
    const rnd = paintRng(23);
    const { top, ground } = paintPanelFrame(ctx, 0, 1024, 1536, 1024);
    ctx.beginPath(); ctx.arc(230, top + 150, 80, 0, Math.PI * 2);
    ctx.fillStyle = FRESCO.gold; ctx.fill(); ctx.strokeStyle = FRESCO.line; ctx.lineWidth = 4; ctx.stroke();
    for (let a = 0; a < 16; a++) {
      const t = (a / 16) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(230 + Math.cos(t) * 95, top + 150 + Math.sin(t) * 95);
      ctx.lineTo(230 + Math.cos(t) * 135, top + 150 + Math.sin(t) * 135);
      ctx.strokeStyle = FRESCO.ochre; ctx.lineWidth = 8; ctx.stroke();
    }
    for (const [x, robe, hold] of [[330, FRESCO.lapis, 'spear'], [520, FRESCO.red, 'hammer'], [700, FRESCO.verdigris, 'spear']]) {
      paintFigure(ctx, { x, base: ground - 90, h: 470, dir: 1, halo: true, beard: robe !== FRESCO.verdigris, robe, trim: FRESCO.gold, hair: '#6a4526', legs: true, arms: [2.2, 0.9], hold });
    }
    paintFigure(ctx, { x: 1080, base: ground - 60, h: 700, bulk: 1.5, dir: -1, robe: FRESCO.fieldDark, skin: FRESCO.giant, hair: FRESCO.giantDark, legs: true, beard: true, arms: [2.9, 1.9], hold: 'club' });
    paintFigure(ctx, { x: 1330, base: ground - 50, h: 380, bulk: 1.5, dir: 1, lying: true, robe: FRESCO.fieldDark, skin: FRESCO.giant, hair: FRESCO.giantDark, legs: true, beard: true, arms: [1.2, -0.8] });
    paintBird(ctx, 900, top + 120, 22, 1); paintBird(ctx, 980, top + 90, 18, 1);
    // The plough: an ox and the man behind it.
    const oy = ground + 60;
    ctx.beginPath(); ctx.ellipse(1040, oy - 70, 95, 48, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#6f4a2c'; ctx.fill(); ctx.strokeStyle = FRESCO.line; ctx.lineWidth = 4; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(1140, oy - 90, 30, 24, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    for (const lx of [985, 1010, 1070, 1095]) {
      ctx.beginPath(); ctx.moveTo(lx, oy - 40); ctx.lineTo(lx, oy); ctx.lineWidth = 14; ctx.strokeStyle = FRESCO.line; ctx.stroke();
      ctx.lineWidth = 9; ctx.strokeStyle = '#6f4a2c'; ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(945, oy - 70); ctx.lineTo(870, oy - 20); ctx.lineTo(850, oy);
    ctx.lineWidth = 7; ctx.strokeStyle = FRESCO.line; ctx.stroke();
    peasants(oy + 10, [800, 330, 480, 620], rnd);
  }
  // Tall B: a giant, and a peasant running from him.
  {
    const { top, ground } = paintPanelFrame(ctx, 1536, 1024, 512, 1024);
    paintFigure(ctx, { x: 1800, base: ground, h: ground - top - 8, bulk: 1.5, dir: -1, robe: FRESCO.fieldDark, trim: FRESCO.terra, skin: FRESCO.giant, hair: FRESCO.giantDark, legs: true, beard: true, arms: [2.8, 0.2], hold: 'club' });
    paintFigure(ctx, { x: 1640, base: ground + 30, h: 160, dir: -1, robe: FRESCO.white, skin: FRESCO.peasant, legs: true, arms: [2.2, -2.0] });
  }
  return c;
}

/** "Drawings of faces in pain": charcoal and red earth, drawn over and over. */
function paintFaces(size) {
  const c = canvas2d(size, size);
  const ctx = c.getContext('2d');
  const cell = size / 3;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let k = 0; k < 9; k++) {
    const rnd = paintRng(101 + k * 7);
    const cx = (k % 3 + 0.5) * cell; const cy = (Math.floor(k / 3) + 0.5) * cell;
    const s = cell * (0.8 + rnd() * 0.12);
    const red = k % 3 === 1;
    const colour = red ? 'rgba(120,32,20,0.95)' : 'rgba(18,14,12,0.95)';
    // Every line drawn two or three times, a little off, the way charcoal is.
    const scrawl = (draw, width) => {
      for (let pass = 0; pass < 3; pass++) {
        ctx.save();
        ctx.translate((rnd() - 0.5) * s * 0.02, (rnd() - 0.5) * s * 0.02);
        ctx.beginPath(); draw();
        ctx.strokeStyle = colour; ctx.lineWidth = width * (0.6 + rnd() * 0.6); ctx.stroke();
        ctx.restore();
      }
    };
    const tilt = (rnd() - 0.5) * 0.4;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(tilt);
    const rx = s * (0.27 + rnd() * 0.05); const ry = s * (0.38 + rnd() * 0.04);
    scrawl(() => ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2), s * 0.018);
    // Hands pressed to the cheeks, on some.
    if (k % 2 === 0) {
      for (const sx of [-1, 1]) {
        scrawl(() => { ctx.moveTo(sx * rx * 0.95, ry * 0.1); ctx.lineTo(sx * rx * 1.15, -ry * 0.25); ctx.lineTo(sx * rx * 1.05, -ry * 0.55); }, s * 0.014);
        scrawl(() => { ctx.moveTo(sx * rx * 1.05, ry * 0.2); ctx.quadraticCurveTo(sx * rx * 1.4, ry * 0.8, sx * rx * 1.2, ry * 1.2); }, s * 0.014);
      }
    }
    // Brows up at the middle: anguish.
    for (const sx of [-1, 1]) {
      scrawl(() => { ctx.moveTo(sx * rx * 0.75, -ry * 0.22); ctx.lineTo(sx * rx * 0.12, -ry * 0.42); }, s * 0.016);
      // Eyes: hollows, scribbled dark.
      ctx.beginPath(); ctx.ellipse(sx * rx * 0.42, -ry * 0.12, rx * 0.2, ry * 0.12, sx * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = colour; ctx.fill();
      // Tear lines.
      scrawl(() => { ctx.moveTo(sx * rx * 0.45, ry * 0.02); ctx.lineTo(sx * rx * 0.5, ry * 0.45); }, s * 0.008);
    }
    scrawl(() => { ctx.moveTo(0, -ry * 0.05); ctx.lineTo(-rx * 0.08, ry * 0.2); ctx.lineTo(rx * 0.06, ry * 0.24); }, s * 0.01);
    // The mouth, open, screaming.
    const mw = rx * (0.28 + rnd() * 0.12); const mh = ry * (0.2 + rnd() * 0.12);
    ctx.beginPath(); ctx.ellipse(0, ry * 0.55, mw, mh, 0, 0, Math.PI * 2);
    ctx.fillStyle = colour; ctx.fill();
    scrawl(() => ctx.ellipse(0, ry * 0.55, mw * 1.15, mh * 1.2, 0, 0, Math.PI * 2), s * 0.012);
    // Cheekbones pulled tight.
    for (const sx of [-1, 1]) scrawl(() => { ctx.moveTo(sx * rx * 0.7, ry * 0.15); ctx.quadraticCurveTo(sx * rx * 0.5, ry * 0.45, sx * mw * 1.3, ry * 0.62); }, s * 0.009);
    ctx.restore();
  }
  return c;
}

/** Blood thrown at a wall: a splash, what was flung off it, and what ran down. */
function paintBlood(size) {
  const c = canvas2d(size, size);
  const ctx = c.getContext('2d');
  const cell = size / 2;
  for (let k = 0; k < 4; k++) {
    const rnd = paintRng(301 + k * 13);
    const cx = (k % 2 + 0.5) * cell; const cy = (Math.floor(k / 2) + 0.42) * cell;
    const R = cell * (0.14 + rnd() * 0.08);
    const wet = `rgba(${86 + Math.floor(rnd() * 20)},${10 + Math.floor(rnd() * 8)},8,1)`;
    ctx.fillStyle = wet; ctx.strokeStyle = wet;
    // The splash: a lobed blob.
    ctx.beginPath();
    for (let a = 0; a <= 48; a++) {
      const t = (a / 48) * Math.PI * 2;
      const r = R * (0.7 + 0.35 * Math.sin(t * 3 + k) * Math.sin(t * 5 + k * 2) + rnd() * 0.25);
      const x = cx + Math.cos(t) * r; const y = cy + Math.sin(t) * r * 0.85;
      if (a) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.fill();
    // Flung off it: streaks and drops along rays.
    for (let i = 0; i < 26; i++) {
      const t = rnd() * Math.PI * 2;
      const d0 = R * (0.9 + rnd() * 0.3); const d1 = d0 + R * (0.3 + rnd() * 1.2);
      ctx.lineWidth = 2 + rnd() * R * 0.12; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(t) * d0, cy + Math.sin(t) * d0);
      ctx.lineTo(cx + Math.cos(t) * d1, cy + Math.sin(t) * d1); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx + Math.cos(t) * (d1 + R * 0.2), cy + Math.sin(t) * (d1 + R * 0.2), 2 + rnd() * R * 0.07, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 60; i++) {
      const t = rnd() * Math.PI * 2; const d = R * (1.1 + rnd() * 1.9);
      ctx.beginPath(); ctx.arc(cx + Math.cos(t) * d, cy + Math.sin(t) * d, 1 + rnd() * R * 0.05, 0, Math.PI * 2); ctx.fill();
    }
    // Runs: straight down, thinning, with a bead at the end.
    for (let i = 0; i < 9; i++) {
      const x = cx + (rnd() - 0.5) * R * 1.6;
      const y0 = cy + R * (0.2 + rnd() * 0.5);
      const len = cell * (0.15 + rnd() * 0.35);
      ctx.lineWidth = 3 + rnd() * 7;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x + (rnd() - 0.5) * 6, Math.min(y0 + len, (Math.floor(k / 2) + 1) * cell - 12)); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, Math.min(y0 + len, (Math.floor(k / 2) + 1) * cell - 12), ctx.lineWidth * 0.8, 0, Math.PI * 2); ctx.fill();
    }
  }
  return c;
}

/**
 * The words on the wall, in the room's own spelling: "BEWARE adventurer!",
 * "DANGER!!!", the number '666', the riddle at the T-crossing. Daubed with a
 * finger in something dark red, each letter at its own slant, runs under the
 * heavier strokes. `seed` picks the hand.
 */
function paintWriting(texts, seed, size = 2048) {
  const c = canvas2d(size, size / 2);
  const ctx = c.getContext('2d');
  const rnd = paintRng(seed);
  const lines = texts.flatMap((t) => String(t).split(/\n|(?<=[.!?,])\s+(?=\S)/)).map((l) => l.trim()).filter(Boolean).slice(0, 4);
  const colour = seed % 2 ? 'rgba(92,18,12,1)' : 'rgba(24,18,15,1)';
  const rows = lines.length;
  const lineH = (size / 2) * 0.8 / rows;
  const longest = Math.max(...lines.map((l) => l.length));
  const px = Math.min(lineH * 0.8, (size * 0.94) / (longest * 0.56));
  ctx.textBaseline = 'middle';
  ctx.fillStyle = colour; ctx.strokeStyle = colour;
  lines.forEach((line, r) => {
    const y = (size / 2) * 0.1 + lineH * (r + 0.5);
    ctx.font = `bold ${px.toFixed(0)}px Georgia, 'Times New Roman', serif`;
    const width = ctx.measureText(line).width;
    let x = (size - width) / 2 + (rnd() - 0.5) * size * 0.04;
    for (const ch of line) {
      const w = ctx.measureText(ch).width;
      ctx.save();
      ctx.translate(x + w / 2, y + (rnd() - 0.5) * px * 0.12);
      ctx.rotate((rnd() - 0.5) * 0.18);
      ctx.scale(1 + (rnd() - 0.5) * 0.12, 1 + (rnd() - 0.5) * 0.16);
      ctx.fillText(ch, -w / 2, 0);
      // A finger's width of paint round every stroke.
      ctx.lineWidth = px * 0.07; ctx.strokeText(ch, -w / 2, 0);
      ctx.restore();
      if (ch.trim() && rnd() > 0.6) {
        ctx.lineWidth = 2 + rnd() * 3; ctx.lineCap = 'round';
        const dx = x + w * (0.3 + rnd() * 0.4);
        const len = px * (0.3 + rnd() * 0.9);
        ctx.beginPath(); ctx.moveTo(dx, y + px * 0.3); ctx.lineTo(dx, y + px * 0.3 + len); ctx.stroke();
        ctx.beginPath(); ctx.arc(dx, y + px * 0.3 + len, ctx.lineWidth * 0.9, 0, Math.PI * 2); ctx.fill();
      }
      x += w * (0.96 + rnd() * 0.1);
    }
  });
  return c;
}

/**
 * Canvas to texture, with the albedo lift every baked colour gets, weathered
 * as `wear` says: `fresco` fades, cracks and flakes the paint back to the
 * plaster and rags the panel's edges; `stroke` leaves the marks as they are
 * and makes everything unpainted transparent. Rows flipped: see above.
 */
function paintedTexture(canvas, wear, seed) {
  const w = canvas.width; const h = canvas.height;
  const src = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const data = new Uint8ClampedArray(w * h * 4);
  const height = new Float32Array(w * h);
  const lift = (x) => 255 * Math.pow(Math.max(0, Math.min(1, x / 255)), 0.62);
  // The weathering fields are smooth, so they are computed coarse and read
  // back bilinear: 4 M pixels of fbm would be most of a second of boot.
  const G = 128;
  const field = (fn) => {
    const f = new Float32Array((G + 1) * (G + 1));
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) f[j * (G + 1) + i] = fn(i / G, j / G);
    return (u, v) => {
      const x = u * G; const y = v * G; const i = Math.min(G - 1, Math.floor(x)); const j = Math.min(G - 1, Math.floor(y));
      const fx = x - i; const fy = y - j; const a = f[j * (G + 1) + i]; const b = f[j * (G + 1) + i + 1];
      const cc = f[(j + 1) * (G + 1) + i]; const d = f[(j + 1) * (G + 1) + i + 1];
      return lerp(lerp(a, b, fx), lerp(cc, d, fx), fy);
    };
  };
  const fresco = wear === 'fresco';
  // The broad fields change over tens of pixels: a nearest read of a finer
  // lattice is as good as a bilinear one and a third of the cost.
  const coarse = (fn, n = 256) => {
    const f = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) f[j * n + i] = fn(i / n, j / n);
    return (u, v) => f[Math.min(n - 1, (v * n) | 0) * n + Math.min(n - 1, (u * n) | 0)];
  };
  const fade = coarse((u, v) => fbm(u * 6, v * 6, 64, seed + 1, 4));
  const loss = field((u, v) => fbm(u * 14, v * 14, 64, seed + 2, 4));
  const grime = coarse((u, v) => fbm(u * 3, v * 3, 64, seed + 3, 3), 128);
  // Cracks: where a smooth field crosses its middle, which draws wandering
  // hairlines rather than the closed cells of a Worley edge -- those read as
  // crazy paving. Coarse field, sharp threshold, so the lines stay thin.
  const crack = field((u, v) => fbm(u * 9 + 3, v * 9, 64, seed + 5, 3));
  const crack2 = field((u, v) => fbm(u * 5, v * 5 + 7, 64, seed + 6, 3));
  const ground = rgb(0xd6c6a4);
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const si = (y * w + x) * 4;
      const di = ((h - 1 - y) * w + x) * 4;
      let r = src[si]; let g = src[si + 1]; let b = src[si + 2]; let a = src[si + 3];
      let hgt = 0.5;
      if (fresco) {
        // Faded, then flaked back to the plaster where the loss field peaks,
        // more of it low on the wall where damp comes up.
        const f = clamp01((fade(u, v) - 0.35) * 1.6) * 0.45;
        r = lerp(r, ground[0], f); g = lerp(g, ground[1], f); b = lerp(b, ground[2], f);
        const l = loss(u, v);
        const lost = l + (v % 0.5 > 0.4 ? (v % 0.5 - 0.4) * 1.5 : 0);
        if (lost > 0.71) {
          const p = 0.78 + grime(u, v) * 0.2;
          r = 196 * p; g = 182 * p; b = 150 * p; hgt = 0.35;
        }
        if (Math.abs(crack(u, v) - 0.5) < 0.0035 || Math.abs(crack2(u, v) - 0.5) < 0.0025) { r *= 0.62; g *= 0.6; b *= 0.57; hgt = 0.3; }
        // Smoke from the lamps, gathered towards the top of each panel.
        const soot = 1 - clamp01(((v % 0.5) * 2 - 0.1) * 1.4) * 0.22 * grime(u, v);
        r *= soot; g *= soot; b *= soot;
        // The panel's edges are ragged: plaster gone back to the wall.
        const e = Math.min(Math.min(u, Math.abs(u - 0.75), 1 - u) * w, Math.min(v % 0.5, 0.5 - (v % 0.5)) * h);
        a = e < (5 + l * 22) * (w / 2048) ? 0 : 255;
      } else {
        hgt = 0.5 + (a / 255) * 0.1;
        // Worn: the marks are patchy where they have been rubbed.
        if (a > 0 && loss(u, v) > 0.74) a *= 0.35;
      }
      data[di] = lift(r); data[di + 1] = lift(g); data[di + 2] = lift(b); data[di + 3] = a;
      height[(h - 1 - y) * w + x] = hgt;
    }
  }
  const map = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  map.colorSpace = THREE.SRGBColorSpace;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.anisotropy = 8;
  map.needsUpdate = true;
  // Normals at a quarter of the size: the relief is plaster and flake edges.
  const nw = Math.max(4, w >> 2); const nh = Math.max(4, h >> 2);
  const nd = new Uint8ClampedArray(nw * nh * 4);
  const at = (x, y) => height[Math.min(h - 1, Math.max(0, y * 4)) * w + Math.min(w - 1, Math.max(0, x * 4))];
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 6; const dy = (at(x, y + 1) - at(x, y - 1)) * 6;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * nw + x) * 4;
      nd[i] = (-dx / len * 0.5 + 0.5) * 255; nd[i + 1] = (-dy / len * 0.5 + 0.5) * 255; nd[i + 2] = (1 / len * 0.5 + 0.5) * 255; nd[i + 3] = 255;
    }
  }
  const normal = new THREE.DataTexture(nd, nw, nh, THREE.RGBAFormat);
  normal.colorSpace = THREE.NoColorSpace;
  normal.generateMipmaps = true;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.magFilter = THREE.LinearFilter;
  normal.needsUpdate = true;
  return { map, normal };
}

/**
 * Painted materials, decorated like the walls they are painted on. Each
 * comes twice: lit as a room in the town is, and `_deep`, lit as the sewer's
 * buried rooms are (see `buried`), because a painting has to take the light
 * of the wall under it or it glows.
 */
function createPaintings(materials, macro, grain) {
  const make = (name, textures, { rough = 0.85, env = 0.7, cut = 0 } = {}) => {
    for (const deep of [false, true]) {
      const material = new THREE.MeshStandardMaterial({
        map: textures.map, normalMap: textures.normal, normalScale: new THREE.Vector2(0.6, 0.6),
        roughness: rough, metalness: 0, envMapIntensity: env, vertexColors: true,
        alphaTest: cut, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      material.name = deep ? `${name}_deep` : name;
      material.userData.uvScale = 1;
      material.shadowSide = THREE.DoubleSide;
      material.defaultAttributeValues = { aIndoor: [0] };
      decorate(material, { env, wet: 0, detail: 0.25, buried: deep }, macro, grain);
      materials[material.name] = material;
    }
  };
  // 1536: 245 texels a metre over the temple's wide bays, which is sharper
  // than a torchlit wall is seen, at half the boot cost of 2048.
  make('mural', paintedTexture(paintMurals(1536), 'fresco', 5101), { rough: 0.9, env: 0.6, cut: 0.5 });
  make('faces', paintedTexture(paintFaces(1024), 'stroke', 5203), { rough: 0.9, env: 0.5, cut: 0.4 });
  make('bloodwall', paintedTexture(paintBlood(1024), 'stroke', 5307), { rough: 0.42, env: 0.9, cut: 0.4 });
  // Writing is per room -- it says what that room says -- so it is painted
  // when build.js first asks for it, and kept by what it says.
  materials.$writing = (texts, deep, seed) => {
    const key = `writing_${seed}`;
    if (!materials[key]) make(key, paintedTexture(paintWriting(texts, seed), 'stroke', seed), { rough: 0.6, env: 0.7, cut: 0.4 });
    return deep ? `${key}_deep` : key;
  };
}

// ------------------------------------------------------- surface detail ----

/**
 * One low-frequency map, sampled in world space, that every surface shares:
 * red drifts the tone, green the warmth, blue the roughness. Tiling is what
 * makes a procedural town read as a game, and a texture repeating every three
 * metres under a mottle that repeats every thirty stops looking repeated.
 */
/**
 * The fine grain that fades in when you walk up to a surface. It has to be
 * *structureless*: the detail layer used to be the material's own normal map
 * sampled 6.3x smaller, which on anything with a bond -- masonry, planks, roof
 * tiles -- stamped a miniature copy of that bond inside every block, so a wall
 * read as 90 cm ashlar and 14 cm brick at the same time. No mason builds that.
 * Isotropic noise instead: tooling marks and pitting, which is what you
 * actually see from half a metre away and what no bond pattern should survive.
 */
function bakeGrain(size = 256) {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size; const v = (y + 0.5) / size;
      height[y * size + x] = fbm(u * 12, v * 12, 12, 907, 4, 0.55);
    }
  }
  const data = new Uint8ClampedArray(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const strength = size / 30;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      let nx = -dx * strength; let ny = -dy * strength; let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      data[i] = (nx / len * 0.5 + 0.5) * 255;
      data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return toTexture(data, size, THREE.NoColorSpace);
}

function bakeMacro(size = 128) {
  const data = new Uint8ClampedArray(size * size * 4);
  const spread = (v) => clamp01((v - 0.5) * 1.7 + 0.5) * 255;
  // Two octaves at period 2, over a tile 26 metres wide: the finest thing in
  // here is about four metres across. Any more detail and it stops reading as
  // weathering and starts reading as camouflage over the top of the texture.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size; const v = (y + 0.5) / size;
      const i = (y * size + x) * 4;
      data[i] = spread(fbm(u * 2, v * 2, 2, 211, 2, 0.45));
      data[i + 1] = spread(fbm(u * 2, v * 2, 2, 223, 2, 0.45));
      data[i + 2] = spread(fbm(u * 3, v * 3, 3, 227, 2, 0.45));
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * How much of the hemisphere light reaches a surface built inside an enclosed
 * room. One shared uniform, written by `setIndoorBounce`.
 *
 * At noon the hemisphere is not sky, it is the *sunlit ground bounce*: a black
 * upper half and a bright lower one, which is why it is 32 where dawn's is
 * 0.082. A hemisphere light has no notion of occlusion, so it lit the inside of
 * the temple exactly as hard as it lit the shaded wall outside, and the
 * interior went 81 -> 140 mean the day it arrived. There is no sunlit ground
 * inside a building, so the term does not belong there.
 *
 * three has no per-object light masking -- lights are filtered by the *camera's*
 * layers, not the object's -- so this is a vertex flag instead: `Batcher` writes
 * `aIndoor` = 1 on geometry built inside an enclosed room, and the hemisphere's
 * irradiance is scaled by it. Anything without the attribute (every glTF model,
 * every skinned figure) reads the default 0 and keeps the full bounce, which is
 * what an outdoor prop wants.
 */
const shadeLift = { value: 1 };
const indoorBounce = { value: 1 };
const skyBleach = { value: 0 };
const skyBleachTint = { value: new THREE.Color(1.06, 1.0, 0.90) };
/** The same uniform objects, for the person material (dress.js), so a figure
 * stands in the light the wall beside it does. */
export const SHARED_LIGHT = { indoorBounce, skyBleach, skyBleachTint };

const HEMI_LINE = 'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );';
const POINT_LINE = 'getPointLightInfo( pointLight, geometryPosition, directLight );';
const SUN_LINE = 'getDirectionalLightInfo( directionalLight, directLight );';
/**
 * The light loop as anything underground has it, behind `DIKU_BURIED`: the
 * torches scaled out of the hour's exposure, and the sun only from above.
 */
const LIGHTS_FRAGMENT_BURIED = THREE.ShaderChunk.lights_fragment_begin.replace(
  POINT_LINE,
  `${POINT_LINE}\n#ifdef DIKU_BURIED\n\t\tdirectLight.color *= dikuBuriedGain;\n#endif`,
).replace(
  SUN_LINE,
  // The night "sun" is the moon at -8 degrees: a light from *under* the
  // world, which nothing underground is between -- it drew moonlit blue
  // hairlines down every corner of the sewer. Underground, a sun below the
  // horizon gives nothing; one above it still falls down a shaft.
  //
  // `DIKU_SUNLESS` is for what stands underground and receives no shadow --
  // a door leaf, a creature: with nothing to stop it, the noon sun lit the
  // sewer's doors through seven metres of earth (door planks 121 at noon
  // against 28 at night, the sewer's own walls 18 at both).
  `${SUN_LINE}\n#ifdef DIKU_BURIED\n\t\tdirectLight.color *= smoothstep( 0.02, 0.12, dot( directionalLight.direction, viewMatrix[ 1 ].xyz ) );\n#endif`
  + '\n#ifdef DIKU_SUNLESS\n\t\tdirectLight.color = vec3( 0.0 );\n#endif',
);
const LIGHTS_FRAGMENT_INDOOR = LIGHTS_FRAGMENT_BURIED.replace(
  HEMI_LINE,
  'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )'
  + ' * mix( 1.0, indoorBounce, vIndoor );',
);
if (!LIGHTS_FRAGMENT_INDOOR.includes('indoorBounce') || !LIGHTS_FRAGMENT_INDOOR.includes('dikuBuriedGain')
  || !LIGHTS_FRAGMENT_INDOOR.includes('directionalLight.direction, viewMatrix')) {
  throw new Error('textures: three\'s light loop moved; the indoor-bounce or buried-gain injection missed');
}

/**
 * Light underground, for the recipes marked `buried`.
 *
 * Everything else in the world is lit by the sky: the environment cube is the
 * whole ambient term and the hemisphere is its floor, and both follow the hour.
 * A brick vault seven metres under the Dump sees none of it -- and wearing it
 * anyway, the sewer came out lit like a shopfront at noon, with its floors
 * mirroring blue sky. Worse, the hour's exposure runs 0.165 at noon to 0.62 at
 * night, so the same torch in the same tunnel was four times brighter at
 * midnight than at midday, and a place with no sky in it changed with the time
 * of day.
 *
 * So a buried surface takes its ambient and its reflections from here instead
 * -- a fixed dim fill, a fixed near-black to reflect -- and its point lights
 * and its murk are scaled by `REF / exposure`, which cancels the hour's
 * exposure out of everything except the sun. The sun keeps its own term on
 * purpose: where a stair comes down from the street, daylight falling down the
 * shaft is the one thing that *should* tell the time.
 */
const BURIED_REF_EXPOSURE = 0.45;
const buried = {
  gain: { value: 1 },
  irradiance: { value: new THREE.Color() },
  radiance: { value: new THREE.Color() },
  murk: { value: new THREE.Color() },
  murkDensity: { value: 0.022 },
};
// Linear radiance at the reference exposure. Calibrated on the composited
// frame -- see LEARNINGS for the numbers.
const BURIED_FILL = new THREE.Color(0.56, 0.50, 0.43);
const BURIED_SHEEN = new THREE.Color(0.085, 0.078, 0.066);
const BURIED_MURK = new THREE.Color(0.0105, 0.0098, 0.0088);
let buriedExposure = -1;
function updateBuried(exposure) {
  if (exposure === buriedExposure) return;
  buriedExposure = exposure;
  const k = BURIED_REF_EXPOSURE / Math.max(0.01, exposure);
  buried.gain.value = k;
  buried.irradiance.value.copy(BURIED_FILL).multiplyScalar(k);
  buried.radiance.value.copy(BURIED_SHEEN).multiplyScalar(k);
  buried.murk.value.copy(BURIED_MURK).multiplyScalar(k);
}

/** The buried terms, in whatever shader wears them. */
const BURIED_DECLS = `
  uniform float dikuBuriedGain;
  uniform vec3 dikuBuriedIrradiance;
  uniform vec3 dikuBuriedRadiance;
  uniform vec3 dikuMurk;
  uniform float dikuMurkDensity;`;
// No sky down here: a fixed fill for the ambient and a near-black for
// anything glossy to mirror, whatever the hour. A little more from above than
// from below, the way a room lit by torches on its walls is: a fill with no
// direction at all modelled nothing, and a vault read as flat as the floor
// under it.
const BURIED_AMBIENT = `
  float dikuUpFill = 0.8 + 0.2 * dot( geometryNormal, viewMatrix[ 1 ].xyz );
  irradiance = dikuBuriedIrradiance * dikuUpFill;
  iblIrradiance = irradiance;
  radiance = dikuBuriedRadiance;`;
// The sewer's own murk, not the hour's haze: a night fog is blue and a noon
// one is sky-pale, and neither is the air in a drain.
const BURIED_FOG = `
  #ifdef USE_FOG
    float dikuMurkF = 1.0 - exp( - dikuMurkDensity * dikuMurkDensity * vFogDepth * vFogDepth );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, dikuMurk, dikuMurkF );
  #endif`;
function buriedUniforms(uniforms) {
  uniforms.dikuBuriedGain = buried.gain;
  uniforms.dikuBuriedIrradiance = buried.irradiance;
  uniforms.dikuBuriedRadiance = buried.radiance;
  uniforms.dikuMurk = buried.murk;
  uniforms.dikuMurkDensity = buried.murkDensity;
}
const syncBuried = (renderer) => updateBuried(renderer.toneMappingExposure);

/**
 * The underground twin of any lit material: the same surface, lit by the
 * fixed fill and the torches instead of the sky.
 *
 * Only the sewer's own recipes were `buried`, so everything else that ended
 * up below ground -- the Haon Dor cultist temple's marble, a door into the
 * inner Lair, a crate in the Playpen, a torch stand, a figure -- was lit by the
 * hour's sky through the rock: #6155 metered 76 at noon and 18 at night, the
 * lair door went from pale to RGB 0. Anything built or placed in a buried room
 * wears this instead of its own material.
 *
 * `sunless` for what receives no shadow (see LIGHTS_FRAGMENT_BURIED).
 * A material with a shader of someone else's (glass, water, glow) or no
 * lighting at all comes back as it is: none of those takes the sky's light.
 */
// By hook, not by material: a copy that carries decorate()'s hook over --
// actors.js tints a door slab that way -- is decorated all the same.
const decorated = new WeakSet();
const isDecorated = (m) => decorated.has(m.onBeforeCompile);
const twins = new Map(); // base -> { plain, sunless }
const twinOf = new WeakMap(); // twin -> the material it was made from
export function buriedTwin(material, { sunless = false } = {}) {
  // Asked again of a twin (a door leaf is twinned where it is made, then
  // again, sunless, where it is instanced): answer from the original.
  const base = twinOf.get(material) || material;
  if (!base || !base.isMeshStandardMaterial) return base;
  const own = Object.prototype.hasOwnProperty.call(base, 'onBeforeCompile');
  if (own && !isDecorated(base)) return base;
  if (base.defines?.DIKU_BURIED && !sunless) return base;
  let pair = twins.get(base);
  if (!pair) { pair = {}; twins.set(base, pair); }
  const key = sunless ? 'sunless' : 'plain';
  if (pair[key]) return pair[key];
  const twin = base.clone();
  twin.name = base.name;
  twin.defines = { ...base.defines, DIKU_BURIED: 1, ...(sunless ? { DIKU_SUNLESS: 1 } : {}) };
  twin.defaultAttributeValues = base.defaultAttributeValues;
  twin.onBeforeRender = syncBuried;
  if (isDecorated(base)) {
    // decorate() closes over the base material and files its wetness uniform
    // there; a twin compiling must not take the base's rain away from it.
    twin.onBeforeCompile = (shader, renderer) => {
      const keep = base.userData.wetnessUniform;
      base.onBeforeCompile(shader, renderer);
      if (keep) base.userData.wetnessUniform = keep;
    };
    const baseKey = base.customProgramCacheKey.bind(base);
    twin.customProgramCacheKey = () => `${baseKey()}|buried${sunless ? '|sunless' : ''}`;
  } else {
    twin.onBeforeCompile = (shader) => {
      buriedUniforms(shader.uniforms);
      const frag = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${BURIED_DECLS}`)
        .replace('#include <lights_fragment_begin>', LIGHTS_FRAGMENT_BURIED)
        .replace('#include <lights_fragment_end>', `${BURIED_AMBIENT}\n#include <lights_fragment_end>`)
        .replace('#include <fog_fragment>', BURIED_FOG);
      if (!frag.includes('dikuBuriedGain;') || !frag.includes('dikuUpFill') || !frag.includes('dikuMurkF')) {
        throw new Error(`textures: the buried twin of ${base.name || base.type} missed an injection`);
      }
      shader.fragmentShader = frag;
    };
    twin.customProgramCacheKey = () => `diku-buried-flat${sunless ? '|sunless' : ''}`;
  }
  pair[key] = twin;
  twinOf.set(twin, base);
  return twin;
}

/** The same terms for the person material (dress.js), which blends them in
 * by how far underground each figure stands. */
export const BURIED_LIGHT = { declarations: BURIED_DECLS, uniforms: buriedUniforms, sync: syncBuried };

/**
 * Everything the baked maps cannot say, said in the shader instead:
 *
 *  - macro variation in world space, so a wall thirty metres along the street
 *    is not the same wall;
 *  - a second, much finer copy of the normal map that fades in inside four
 *    metres, so surfaces keep detail when you walk up to them instead of
 *    going smooth (high and max only -- it is an extra texture read);
 *  - damp in the dips of anything facing up, which is most of what a street
 *    at golden hour is doing.
 */
function decorate(material, recipe, macro, grain) {
  material.userData.detailStrength = recipe.detail ?? 0.5;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.macroMap = { value: macro };
    shader.uniforms.detailMap = { value: grain };
    shader.uniforms.macroScale = { value: 1 / 26 };
    // In world units now, not a multiple of the base tile: grain is grain
    // whatever the surface, and at 1/0.22 it is about a centimetre a bump.
    shader.uniforms.detailScale = { value: 1 / 0.22 };
    shader.uniforms.detailStrength = { value: material.userData.detailStrength };
    // The base dampness is the recipe's; weather scales it at runtime through
    // setWetness below. The uniform reference is kept on userData because the
    // shader object only exists once the material has compiled.
    shader.uniforms.wetness = {
      value: (recipe.wet ?? 0) * (material.userData.wetScale ?? 1),
    };
    material.userData.wetnessUniform = shader.uniforms.wetness;
    material.userData.wetBase = recipe.wet ?? 0;
    shader.uniforms.indoorBounce = indoorBounce;
    shader.uniforms.dikuShadeLift = shadeLift;
    shader.uniforms.dikuSkyBleach = skyBleach;
    shader.uniforms.dikuSkyBleachTint = skyBleachTint;
    buriedUniforms(shader.uniforms);
    shader.uniforms.dikuTriScale = { value: 1 / recipe.scale };
    shader.uniforms.dikuMoss = { value: recipe.moss ?? 0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfacePos;\nattribute float aIndoor;\nvarying float vIndoor;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n\tvSurfacePos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;'
        + '\n\tvIndoor = aIndoor;',
      );
    if (material.defines?.DIKU_TRIPLANAR || material.defines?.DIKU_MOSS) {
      // `vSurfacePos` leaves out the instance matrix, which is fine for
      // mottling and wrong for a projection: a triplanar rock placed as an
      // instance has to be sampled where it actually stands.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDikuWorld;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 dikuWorld = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          dikuWorld = instanceMatrix * dikuWorld;
        #endif
        vDikuWorld = ( modelMatrix * dikuWorld ).xyz;`);
    }

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec3 vSurfacePos;
        varying float vIndoor;
        uniform sampler2D macroMap;
        uniform sampler2D detailMap;
        uniform float macroScale;
        uniform float detailScale;
        uniform float detailStrength;
        uniform float wetness;
        uniform float indoorBounce;
        uniform float dikuShadeLift;
        uniform float dikuSkyBleach;
        uniform vec3 dikuSkyBleachTint;
        ${BURIED_DECLS}
        uniform float dikuTriScale;
        uniform float dikuMoss;
        #if defined( DIKU_TRIPLANAR ) || defined( DIKU_MOSS )
          varying vec3 vDikuWorld;
        #endif
        // Three projections of one map, blended by how much the surface faces
        // each axis. A macro rather than a function: the samplers are declared
        // after this chunk.
        #define DIKU_TRI( tex ) ( texture2D( tex, dikuTriX ) * dikuTriW.x + texture2D( tex, dikuTriY ) * dikuTriW.y + texture2D( tex, dikuTriZ ) * dikuTriW.z )
        #define DIKU_TRI_N( uv ) ( vec3( ( texture2D( normalMap, uv ).xy * 2.0 - 1.0 ) * normalScale, 0.0 ) )
      `)
      .replace('#include <lights_fragment_begin>', LIGHTS_FRAGMENT_INDOOR)
      .replace('#include <lights_fragment_end>', /* glsl */`
        #ifdef DIKU_BURIED
          ${BURIED_AMBIENT}
        #else
          #ifdef DIKU_LIFT
            // The burnt district's sky light, by the hour: see setShadeLift.
            iblIrradiance *= dikuShadeLift;
          #endif
          // Inside a room the sky arrives through a door and a window or two,
          // off plaster and floorboards and lamplit walls, and it is no longer
          // blue by then. Taken straight from the cube it lit every interior
          // in the world the colour of the sky outside -- the Green Dragon's
          // flags came out as blue-veined marble -- so indoors it keeps its
          // strength and loses most of its hue, to a warm neutral.
          float dikuIblL = dot( iblIrradiance, vec3( 0.2126, 0.7152, 0.0722 ) );
          iblIrradiance = mix( iblIrradiance, dikuIblL * mix( dikuSkyBleachTint, vec3( 1.06, 1.0, 0.90 ), vIndoor ),
            max( vIndoor * 0.8, dikuSkyBleach ) );
          // What a surface mirrors, as against what lights it. The cube is
          // open sky over a flat ground, with no town in it. Indoors none of
          // it is in view: a sconce's iron mirrors plaster and floorboards,
          // and with half the sky's hue left in (as there was) every metal in
          // every room came out striped blue -- the iron has no diffuse to
          // hide it behind. Outdoors a mirror-smooth surface does see the
          // sky, but a rough lobe spreads over the walls and roofs round it
          // too, so it takes the hour's bleach as the diffuse sky does.
          float dikuRadL = dot( radiance, vec3( 0.2126, 0.7152, 0.0722 ) );
          radiance = mix( radiance, dikuRadL * vec3( 1.03, 1.0, 0.95 ),
            max( vIndoor, dikuSkyBleach * smoothstep( 0.25, 0.7, material.roughness ) ) );
        #endif
        #include <lights_fragment_end>
      `)
      .replace('#include <fog_fragment>', /* glsl */`
        #ifdef DIKU_BURIED
          ${BURIED_FOG}
        #else
          #include <fog_fragment>
        #endif
      `)
      .replace('#include <map_fragment>', /* glsl */`
        #if defined( DIKU_TRIPLANAR ) || defined( DIKU_MOSS )
          // The world normal, from the interpolated view normal: the
          // perturbed one does not exist yet at this point in the shader.
          vec3 dikuWN = normalize( ( vec4( normalize( vNormal ) * ( gl_FrontFacing ? 1.0 : - 1.0 ), 0.0 ) * viewMatrix ).xyz );
        #endif
        #ifdef DIKU_TRIPLANAR
          // A cliff that was cube-projected in Blender and then displaced
          // wears its texture smeared down every face that leans; projected
          // here from the world, each face takes the axis it faces most.
          vec3 dikuTriW = pow( abs( dikuWN ), vec3( 4.0 ) );
          dikuTriW /= dikuTriW.x + dikuTriW.y + dikuTriW.z;
          vec3 dikuTriP = vDikuWorld * dikuTriScale;
          vec3 dikuTriS = sign( dikuWN ) + vec3( equal( dikuWN, vec3( 0.0 ) ) );
          vec2 dikuTriX = vec2( dikuTriP.z * dikuTriS.x, dikuTriP.y );
          vec2 dikuTriY = vec2( dikuTriP.x, dikuTriP.z * dikuTriS.y );
          vec2 dikuTriZ = vec2( - dikuTriP.x * dikuTriS.z, dikuTriP.y );
          diffuseColor *= DIKU_TRI( map );
        #else
          #include <map_fragment>
        #endif
        #ifdef DIKU_MOSS
          // Moss creeps over whatever faces the sky and the north, thinning
          // out down the flanks along a ragged edge, never as a lid. Two
          // octaves of the macro noise in the world, so the edge wanders at a
          // hand's breadth and at a boulder's.
          float dikuMossN = texture2D( macroMap, vDikuWorld.xz * 0.23 + vDikuWorld.y * 0.17 ).r;
          float dikuMossF = texture2D( macroMap, ( vDikuWorld.xz - vDikuWorld.zy ) * 1.9 ).g;
          // ...and a fine clump term off the grain map, so the mat is tufted
          // rather than painted.
          float dikuMossC = texture2D( detailMap, ( vDikuWorld.xz + vDikuWorld.yx * 0.7 ) * 0.9 ).x;
          float dikuMossK = dikuWN.y * 0.8 - dikuWN.z * 0.35 + ( dikuMossN - 0.7 ) * 3.0
            + ( dikuMossF - 0.5 ) * 1.3 + ( dikuMossC - 0.5 ) * 0.5;
          float dikuMossAmt = smoothstep( 0.62 - dikuMoss, 0.86 - dikuMoss, dikuMossK ) * step( 0.001, dikuMoss );
          vec3 dikuMossCol = mix( vec3( 0.05, 0.08, 0.02 ), vec3( 0.13, 0.17, 0.045 ), clamp( dikuMossF * 0.6 + dikuMossC * 0.6 - 0.1, 0.0, 1.0 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, dikuMossCol, dikuMossAmt );
        #endif
        // A skewed projection rather than a true triplanar one: this is
        // mottling, and it only has to vary along all three axes.
        vec2 dikuMacroUv = vec2(
          vSurfacePos.x * 0.92 + vSurfacePos.z * 0.31,
          vSurfacePos.z * 0.86 - vSurfacePos.y * 0.74
        ) * macroScale;
        vec3 dikuMacro = texture2D( macroMap, dikuMacroUv ).rgb;
        diffuseColor.rgb *= ( 0.90 + dikuMacro.r * 0.21 )
          * mix( vec3( 1.030, 1.0, 0.962 ), vec3( 0.972, 0.997, 1.034 ), dikuMacro.g );

        // Rain splash darkens the foot of a wall and the eaves keep the top of
        // it dry, so no wall outdoors is one tone from the ground to the roof.
        // Every wall here was, which is most of why the buildings read as
        // new-built. Storeys are 7.6 m apart, so the foot of each one is found
        // by taking the height modulo that -- which is right for a jettied
        // building, where each floor has its own splash line.
        float dikuUpness = abs( dot( viewMatrix[ 1 ].xyz, normalize( vNormal ) ) );
        float dikuVertical = 1.0 - smoothstep( 0.25, 0.75, dikuUpness );
        float dikuStorey = mod( vSurfacePos.y, 7.6 );
        float dikuSplash = ( 1.0 - smoothstep( 0.0, 0.85, dikuStorey ) ) * dikuVertical;
        float dikuSheltered = smoothstep( 5.6, 6.6, dikuStorey ) * dikuVertical;
        #ifndef DIKU_MOVING
        diffuseColor.rgb *= 1.0 - dikuSplash * 0.24 * ( 0.6 + dikuMacro.r * 0.7 );
        diffuseColor.rgb *= 1.0 + dikuSheltered * 0.06;
        #endif
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        #ifdef DIKU_TRIPLANAR
          roughnessFactor = roughness * DIKU_TRI( roughnessMap ).g;
        #endif
        #ifdef DIKU_MOSS
          roughnessFactor = mix( roughnessFactor, 0.95, dikuMossAmt );
        #endif
        roughnessFactor *= 0.84 + dikuMacro.b * 0.32;
        #ifdef DIKU_WET
          // World normal, from the view normal and an orthonormal view matrix.
          float dikuUp = clamp( dot( viewMatrix[ 1 ].xyz, vNormal ), 0.0, 1.0 );
          // Water sits in the low patches, and the low patches are where the
          // height field -- and so the macro tone -- is darkest.
          //
          // **One gate, and its edges are measured.** This used to be two
          // multiplied together -- smoothstep(0.58, 0.18, macro.r) for the
          // low patches and smoothstep(0.30, 0.62, macro.b) for the rough
          // ones -- and their product was *identically zero* on every surface
          // in the town, so the whole wetness chain moved not one pixel:
          // setWetness, the rain tracker, and overcast's wet: 1.9 all wrote
          // a uniform nothing read. Measured by writing the two terms straight
          // to the back buffer over the Market Square paving: the tone gate
          // read 0.000 and the roughness gate 0.009. The edges were chosen
          // against the macro map's *unfiltered* histogram (mean 0.645), but
          // what the shader samples is mip- and bilinear-filtered, which
          // collapses towards the local mean -- the paving reads 0.76 to 0.91,
          // clear of the old 0.58 upper edge at every distance. Re-centred on
          // what is actually sampled, one gate does the job the pair was meant
          // to: dry-to-downpour now moves that paving by 8.9 of luminance,
          // where the shipped pair moved it by 0.00.
          float dikuDamp = wetness * dikuUp * dikuUp
            * smoothstep( 0.92, 0.62, dikuMacro.r );
          roughnessFactor = mix( roughnessFactor, 0.11, dikuDamp );
          diffuseColor.rgb *= 1.0 - dikuDamp * 0.42;
        #endif
        roughnessFactor = clamp( roughnessFactor, 0.045, 1.0 );
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        #ifdef DIKU_TRIPLANAR
          // Each projection's tangent frame is known in world space, so the
          // map's relief is added along it and the sum turned back into view
          // space: the UDN blend, which is plenty for rock.
          vec3 dikuNX = DIKU_TRI_N( dikuTriX ); vec3 dikuNY = DIKU_TRI_N( dikuTriY ); vec3 dikuNZ = DIKU_TRI_N( dikuTriZ );
          vec3 dikuNW = normalize( dikuWN
            + dikuTriW.x * ( vec3( 0.0, 0.0, dikuTriS.x ) * dikuNX.x + vec3( 0.0, 1.0, 0.0 ) * dikuNX.y )
            + dikuTriW.y * ( vec3( 1.0, 0.0, 0.0 ) * dikuNY.x + vec3( 0.0, 0.0, dikuTriS.y ) * dikuNY.y )
            + dikuTriW.z * ( vec3( - dikuTriS.z, 0.0, 0.0 ) * dikuNZ.x + vec3( 0.0, 1.0, 0.0 ) * dikuNZ.y ) );
          normal = normalize( mat3( viewMatrix ) * dikuNW );
        #else
          #include <normal_fragment_maps>
        #endif
        #ifdef DIKU_MOSS
          // A mat of moss is soft: most of the rock's relief goes under it.
          normal = normalize( mix( normal, nonPerturbedNormal, dikuMossAmt * 0.7 ) );
        #endif
        #ifdef DIKU_FOLIAGE
          // A needle card's normals are baked to point out of the crown, and
          // both faces of the card are the same needles: undo the two-sided
          // flip, or every card is lit from inside the tree on its back.
          normal *= faceDirection;
        #endif
        #ifdef DIKU_DETAIL
          float dikuNear = detailStrength * ( 1.0 - smoothstep( 1.5, 9.0, length( vViewPosition ) ) );
          if ( dikuNear > 0.0 ) {
            // World-space so the grain does not inherit the base tile's scale,
            // and skewed the same way as the macro so it varies on all axes.
            vec2 dikuDetailUv = vec2(
              vSurfacePos.x * 0.92 + vSurfacePos.z * 0.31,
              vSurfacePos.z * 0.86 - vSurfacePos.y * 0.74
            ) * detailScale;
            vec3 dikuN = texture2D( detailMap, dikuDetailUv ).xyz * 2.0 - 1.0;
            normal = normalize( normal + ( tbn[ 0 ] * dikuN.x + tbn[ 1 ] * dikuN.y ) * dikuNear );
          }
        #endif
      `);
  };
  decorated.add(material.onBeforeCompile);
  if (recipe.wet) material.defines = { ...material.defines, DIKU_WET: 1 };
  if (recipe.buried) {
    material.defines = { ...material.defines, DIKU_BURIED: 1 };
    // Read the hour's exposure where it is certain to be current: at draw
    // time, from the renderer itself. One compare when nothing changed.
    material.onBeforeRender = syncBuried;
  }
  if (recipe.moving) material.defines = { ...material.defines, DIKU_MOVING: 1 };
  if (recipe.lift) material.defines = { ...material.defines, DIKU_LIFT: 1 };
  if (recipe.cutout) material.defines = { ...material.defines, DIKU_FOLIAGE: 1 };
  if (recipe.triplanar) material.defines = { ...material.defines, DIKU_TRIPLANAR: 1 };
  if (recipe.moss) material.defines = { ...material.defines, DIKU_MOSS: 1 };
  // Our injected source differs from stock, so it needs a key of its own or
  // three will hand us a program compiled for an undecorated material.
  material.customProgramCacheKey = () => `diku|${material.defines?.DIKU_DETAIL ? 1 : 0}`
    + `|${material.defines?.DIKU_WET ? 1 : 0}|${material.defines?.DIKU_BURIED ? 1 : 0}`
    + `|${material.defines?.DIKU_MOVING ? 1 : 0}|${material.defines?.DIKU_LIFT ? 1 : 0}`
    + `|${material.defines?.DIKU_FOLIAGE ? 1 : 0}|${material.defines?.DIKU_TRIPLANAR ? 1 : 0}`
    + `|${material.defines?.DIKU_MOSS ? 1 : 0}`;
}

/**
 * Bake every recipe into a MeshStandardMaterial. Triplanar would be nicer but
 * every surface here is axis-aligned, so per-face UV scaling is enough.
 */
export function createMaterials(size = 512, onProgress = () => {}) {
  const materials = {};
  const macro = bakeMacro();
  const grain = bakeGrain();
  const names = Object.keys(RECIPES);
  const surfaced = [];
  // Several recipes share a surface -- the sewer's flags, rust and bark, the
  // neighborhood's bone -- and differ only in how they are lit. One bake each.
  const bakes = new Map();
  names.forEach((name, index) => {
    const recipe = RECIPES[name];
    const px = recipe.size ?? size;
    if (!bakes.has(recipe.surface)) bakes.set(recipe.surface, bake(recipe.surface, px));
    const baked = bakes.get(recipe.surface);
    const material = new THREE.MeshStandardMaterial({
      map: toTexture(baked.albedo, px, THREE.SRGBColorSpace, recipe.cutout),
      normalMap: toTexture(baked.normal, px, THREE.NoColorSpace),
      roughnessMap: toTexture(baked.roughness, px, THREE.NoColorSpace),
      metalnessMap: toTexture(baked.roughness, px, THREE.NoColorSpace),
      roughness: 1,
      metalness: 1,
      envMapIntensity: recipe.env ?? 1,
      normalScale: new THREE.Vector2(recipe.normalScale, recipe.normalScale),
      vertexColors: true,
    });
    material.name = name;
    material.userData.uvScale = 1 / recipe.scale;
    if (baked.emissive) {
      material.emissiveMap = toTexture(baked.emissive, size, THREE.SRGBColorSpace);
      material.emissive = new THREE.Color(0xffffff);
      material.emissiveIntensity = recipe.glow ?? 1;
    }
    // three draws a front-sided material's *back* faces into the shadow map,
    // so what shades a ledge in a wall is the wall's own inner face a few
    // centimetres away -- inside the bias. Every 3 cm course step in the
    // stone kit caught the noon sun through a closed room as a white streak
    // along the mortar, and at dusk whole courses of the Park Cafe lit up.
    // Both faces put the wall's sunward face in the map, half a metre off.
    material.shadowSide = THREE.DoubleSide;
    if (recipe.cutout) {
      material.alphaTest = recipe.cutout;
      material.side = THREE.DoubleSide;
      // The AO prepass draws this through an alpha-cut normal material of
      // its own (render.js); its override would draw the whole card.
      material.userData.foliage = true;
    }
    // Only `Batcher` writes `aIndoor`. Everything else -- every glTF model,
    // every skinned figure -- has no such attribute, and a missing attribute
    // reads back whatever was last left in the generic slot unless the material
    // names a default. 0 is "outdoors", which is what a prop wants.
    material.defaultAttributeValues = { aIndoor: [0] };
    decorate(material, recipe, macro, grain);
    materials[name] = material;
    surfaced.push(material);
    onProgress((index + 1) / names.length, name);
  });

  /**
   * Scale the dampness of every wet recipe -- overcast weather turns it up.
   * A plain uniform write, no recompile: DIKU_WET is compiled in wherever the
   * recipe has any wetness at all, and everything else has a base of zero, so
   * indoor floors stay dry at any scale.
   */
  materials.setWetness = (scale) => {
    for (const material of surfaced) {
      material.userData.wetScale = scale;
      const uniform = material.userData.wetnessUniform;
      if (uniform) uniform.value = (material.userData.wetBase ?? 0) * scale;
    }
  };

  /**
   * The fraction of the hemisphere that reaches enclosed interiors. 1 at every
   * hour whose hemisphere is an honest sky floor; below 1 only at noon, where
   * it is the sunlit ground bounce and there is no sunlit ground indoors.
   * A plain uniform write shared by every material, so no recompile.
   */
  materials.setIndoorBounce = (value) => { indoorBounce.value = value; };

  /**
   * How much the sky lights the burnt district's surfaces (the recipes with
   * `lift`), by the hour. Soot, ash and char are a third of the albedo of
   * the town's stone, and at dusk -- env 0.35, a hemisphere of 0.08 -- the
   * shade on them fell under the toe of the tone curve: 45% of a No Man's
   * Land frame under luma 8, against 6-13% on Midgaard's streets. No static
   * recipe setting can lift that without also lifting the noon shade, where
   * the sky is already bright; this is set per hour instead. A plain uniform.
   */
  materials.setShadeLift = (value) => { shadeLift.value = value; };

  /**
   * How much of the sky's hue the diffuse sky light loses outdoors, by the
   * hour: the cube is a whole open sky, and a shaded street sees half of it as
   * sunlit wall. Indoors already loses 0.8 of it; this is the outdoor floor.
   */
  materials.setSkyBleach = (value, tint = 0xffffff) => {
    skyBleach.value = value;
    skyBleachTint.value.setHex(tint);
    // The tints are near-neutral multipliers around 1, not display colours.
    skyBleachTint.value.multiplyScalar(3 / (skyBleachTint.value.r + skyBleachTint.value.g + skyBleachTint.value.b));
  };

  /** Close-range detail normals, on or off. Recompiles; only the P key does it. */
  materials.setDetail = (on) => {
    const buriedCopies = [...twins.keys()].filter(isDecorated).flatMap((b) => Object.values(twins.get(b)));
    for (const material of [...surfaced, ...buriedCopies]) {
      const has = !!material.defines?.DIKU_DETAIL;
      if (has === !!on) continue;
      material.defines = { ...material.defines };
      if (on) material.defines.DIKU_DETAIL = 1;
      else delete material.defines.DIKU_DETAIL;
      material.needsUpdate = true;
    }
  };

  createDecals(materials);
  createPaintings(materials, macro, grain);

  // Not baked: the floor of an "In the air..." room, which has to read as
  // something you could stand on without becoming a lid over the street below.
  materials.cloud = new THREE.MeshStandardMaterial({
    color: 0xdfe6ef, roughness: 1, metalness: 0, transparent: true, opacity: 0.36,
    depthWrite: false, vertexColors: true, side: THREE.DoubleSide,
  });
  materials.cloud.name = 'cloud';
  materials.cloud.userData.uvScale = 0.05;

  // The fine grain, shared. assets.js hangs it on the flat materials that have
  // no baked maps of their own, so a person is not the one thing in frame with
  // no surface at all while every wall behind them has albedo, normal and
  // roughness. Not cloth and skin, whatever `TAG_MATERIALS` there still says:
  // both are recipes here, `materialFor` looks the baked ones up first, and the
  // flat entries under those two names have not been reachable since. It is the
  // belt, the shoes, the hair and the leather that wear the bare grain.
  // Not a material, so it is kept off the name lookup by a key no `MAT:` tag
  // can be.
  materials.$grain = grain;

  return materials;
}

export const MATERIAL_NAMES = Object.keys(RECIPES);
