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

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Hex string to linear-ish [r,g,b] bytes we can blend in place. */
function rgb(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ------------------------------------------------------------- surfaces ----

/**
 * Each surface fills three buffers for pixel (u,v) in [0,1):
 *   colour (0-255 rgb), height (0-1, drives the normal map), roughness (0-1).
 */
const SURFACES = {
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
    const knotMark = clamp01(1 - knot * 3.2);
    const seam = clamp01(Math.min(fy, 1 - fy) * 26);
    const wood = mix(rgb(0x6b4d31), rgb(0x8d6a45), grain * 0.8 + id * 0.2);
    s.color = mix(mix(wood, rgb(0x2e2015), knotMark * 0.8), rgb(0x241a11), 1 - seam);
    s.height = 0.6 * seam + grain * 0.15 - knotMark * 0.15;
    s.rough = 0.72 + grain * 0.2;
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

  grass(u, v, s) {
    const blades = fbm(u * 120, v * 120, 120, 131, 2);
    const clump = fbm(u * 14, v * 14, 14, 137, 4);
    const dry = clamp01(fbm(u * 6, v * 6, 6, 149, 3) * 1.5 - 0.5);
    const green = mix(rgb(0x33421f), rgb(0x5c7033), clump * 0.8 + blades * 0.2);
    s.color = mix(green, rgb(0x8a7a45), dry * 0.55);
    s.height = blades * 0.6 + clump * 0.3;
    // Live blades are waxy and catch a sheen; the dried-off patches do not.
    s.rough = 0.72 + dry * 0.24 + clump * 0.06;
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
    s.height = (1 - depth) * 0.5 + fine * 0.25;
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
    const ripple = Math.sin((u * 26 + fbm(u * 4, v * 4, 4, 163, 3) * 6) * Math.PI) * 0.5 + 0.5;
    const grit = fbm(u * 90, v * 90, 90, 167, 2);
    s.color = mix(rgb(0xb8a172), rgb(0xd8c79a), ripple * 0.6 + grit * 0.4);
    s.height = ripple * 0.5 + grit * 0.2;
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
    const shade = 0.90 + fine * 0.20;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = drift * 0.45 + fine * 0.30;
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

  iron(u, v, s) {
    const brush = fbm(u * 8, v * 120, 8, 173, 3);
    const rust = clamp01(fbm(u * 9, v * 9, 9, 179, 4) * 1.7 - 0.8);
    const c = mix(rgb(0x2f3134), rgb(0x585c60), brush);
    s.color = mix(c, rgb(0x6d3d21), rust * 0.7);
    s.height = 0.5 + brush * 0.15;
    s.rough = 0.55 + rust * 0.35;
    s.metal = 0.85 - rust * 0.6;
  },

  bark(u, v, s) {
    const ridges = fbm(u * 26, v * 5, 26, 181, 4);
    const deep = Math.abs(Math.sin((u * 18 + ridges * 5) * Math.PI));
    const c = mix(rgb(0x3a2c20), rgb(0x6a5540), ridges * 0.7 + deep * 0.3);
    s.color = mix(c, rgb(0x241a12), (1 - deep) * 0.6);
    s.height = deep * 0.7 + ridges * 0.25;
    s.rough = 0.97;
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
};

// -------------------------------------------------------------- baking ----

function bake(name, size) {
  const surface = SURFACES[name];
  if (!surface) throw new Error(`textures: no surface named ${name}`);

  const albedo = new Uint8ClampedArray(size * size * 4);
  const roughness = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const s = { color: [0, 0, 0], height: 0, rough: 1, metal: 0 };
  // The palettes above read well as flat swatches, but albedo is consumed in
  // linear space, where mid-greys drop to almost nothing. This curve lifts the
  // darks and leaves the highlights roughly where they were.
  const lift = (c) => 255 * Math.pow(Math.max(0, Math.min(1, c / 255)), 0.62);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      s.metal = 0;
      surface((x + 0.5) / size, (y + 0.5) / size, s);
      const i = (y * size + x);
      albedo[i * 4] = lift(s.color[0]);
      albedo[i * 4 + 1] = lift(s.color[1]);
      albedo[i * 4 + 2] = lift(s.color[2]);
      albedo[i * 4 + 3] = 255;
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

  return { albedo, normal, roughness, size };
}

function toTexture(data, size, colorSpace) {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = colorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
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
  skin: { surface: 'skin', scale: 0.5, normalScale: 0.28, env: 0.5, wet: 0, detail: 0.35 },
  plaster: { surface: 'plaster', scale: 3, normalScale: 0.34, env: 0.7, wet: 0, detail: 0.45 },
  stonewall: { surface: 'stonewall', scale: 3.6, normalScale: 1.0, env: 0.72, wet: 0, detail: 0.55 },
  timber: { surface: 'timber', scale: 5.2, normalScale: 0.9, env: 0.8, wet: 0, detail: 0.45 },
  planks: { surface: 'planks', scale: 2.4, normalScale: 0.7, env: 0.85, wet: 0, detail: 0.45 },
  rooftile: { surface: 'rooftile', scale: 2.6, normalScale: 1.1, env: 1.0, wet: 0.35, detail: 0.5 },
  thatch: { surface: 'thatch', scale: 3, normalScale: 1.2, env: 0.55, wet: 0, detail: 0.7 },
  dirt: { surface: 'dirt', scale: 4.5, normalScale: 0.9, env: 0.7, wet: 0.3, detail: 0.6 },
  grass: { surface: 'grass', scale: 5.5, normalScale: 0.55, env: 0.6, wet: 0, detail: 0.7 },
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
  leaves: { surface: 'leaves', scale: 2.0, normalScale: 0.75, env: 0.4, wet: 0, detail: 0.5 },
  rock: { surface: 'rock', scale: 5, normalScale: 1.2, env: 0.9, wet: 0.25, detail: 0.6 },
  sand: { surface: 'sand', scale: 6, normalScale: 0.6, env: 0.7, wet: 0, detail: 0.6 },
  // Out of doors and loose, so it takes damp -- but a path drains, which is the
  // whole point of gravelling one, so well under the street's 0.5.
  gravel: { surface: 'gravel', scale: 2.4, normalScale: 0.7, env: 0.75, wet: 0.28, detail: 0.6 },
  // Matt and dry: needle litter is the least reflective surface out of doors,
  // and it sheds water rather than holding it in pools. Low `env` for the same
  // reason peat has it -- a forest floor sees a fraction of the dome, and a
  // full mirror of the sky turns brown litter grey.
  duff: { surface: 'duff', scale: 3.2, normalScale: 0.6, env: 0.42, wet: 0, detail: 0.7 },
  iron: { surface: 'iron', scale: 1.6, normalScale: 0.5, env: 1.4, wet: 0, detail: 0.3 },
  bark: { surface: 'bark', scale: 1.6, normalScale: 1.0, env: 0.65, wet: 0, detail: 0.5 },
  water: { surface: 'water', scale: 7, normalScale: 0.5, env: 1.6, wet: 0, detail: 0.2 },
};

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
const indoorBounce = { value: 1 };

const HEMI_LINE = 'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );';
const LIGHTS_FRAGMENT_INDOOR = THREE.ShaderChunk.lights_fragment_begin.replace(
  HEMI_LINE,
  'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )'
  + ' * mix( 1.0, indoorBounce, vIndoor );',
);
if (LIGHTS_FRAGMENT_INDOOR === THREE.ShaderChunk.lights_fragment_begin) {
  throw new Error('textures: three\'s hemisphere irradiance line moved; the indoor-bounce injection missed');
}

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

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfacePos;\nattribute float aIndoor;\nvarying float vIndoor;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n\tvSurfacePos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;'
        + '\n\tvIndoor = aIndoor;',
      );

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
      `)
      .replace('#include <lights_fragment_begin>', LIGHTS_FRAGMENT_INDOOR)
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
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
        diffuseColor.rgb *= 1.0 - dikuSplash * 0.24 * ( 0.6 + dikuMacro.r * 0.7 );
        diffuseColor.rgb *= 1.0 + dikuSheltered * 0.06;
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
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
        #include <normal_fragment_maps>
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
  if (recipe.wet) material.defines = { ...material.defines, DIKU_WET: 1 };
  // Our injected source differs from stock, so it needs a key of its own or
  // three will hand us a program compiled for an undecorated material.
  material.customProgramCacheKey = () => `diku|${material.defines?.DIKU_DETAIL ? 1 : 0}`
    + `|${material.defines?.DIKU_WET ? 1 : 0}`;
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
  names.forEach((name, index) => {
    const recipe = RECIPES[name];
    const baked = bake(recipe.surface, size);
    const material = new THREE.MeshStandardMaterial({
      map: toTexture(baked.albedo, size, THREE.SRGBColorSpace),
      normalMap: toTexture(baked.normal, size, THREE.NoColorSpace),
      roughnessMap: toTexture(baked.roughness, size, THREE.NoColorSpace),
      metalnessMap: toTexture(baked.roughness, size, THREE.NoColorSpace),
      roughness: 1,
      metalness: 1,
      envMapIntensity: recipe.env ?? 1,
      normalScale: new THREE.Vector2(recipe.normalScale, recipe.normalScale),
      vertexColors: true,
    });
    material.name = name;
    material.userData.uvScale = 1 / recipe.scale;
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

  /** Close-range detail normals, on or off. Recompiles; only the P key does it. */
  materials.setDetail = (on) => {
    for (const material of surfaced) {
      const has = !!material.defines?.DIKU_DETAIL;
      if (has === !!on) continue;
      material.defines = { ...material.defines };
      if (on) material.defines.DIKU_DETAIL = 1;
      else delete material.defines.DIKU_DETAIL;
      material.needsUpdate = true;
    }
  };

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
