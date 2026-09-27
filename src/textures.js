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
    const drift = fbm(u * 3, v * 3, 3, 169, 3);
    // The ripple is relief, not paint: a ridge and its trough are one sand,
    // and painting them light and dark put a zebra across the desert that the
    // normal map was already drawing. Warmer, too -- a desert is not a beach.
    s.color = mix(mix(rgb(0xc59a64), rgb(0xdcb784), drift * 0.7 + grit * 0.3), rgb(0xe3c396), ripple * 0.12);
    // Low: a ripple is a centimetre high on a ten-centimetre wavelength, and
    // at half the height range a raking dusk sun drew it as a zebra.
    s.height = ripple * 0.06 + drift * 0.22 + grit * 0.1;
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

  /**
   * Fur and hide, for the animals. Near-neutral, like cloth, because every
   * beast carries its coat, its pale belly and its dark points in vertex colour
   * and the map must not fight them. What the map does carry is the one thing
   * that tells a pelt from a painted shell at a few metres: the coat lies in
   * clumps that each catch the light a little differently, and the gaps
   * between them are shadowed. Isotropic on purpose -- the UVs are cube
   * projected, so a strand direction would change at every projection seam.
   */
  fur(u, v, s) {
    const [d1, edge, id] = cellular(u * 16, v * 16, 16, 401, 0.5);
    const fine = fbm(u * 64, v * 64, 64, 409, 2);
    const tone = fbm(u * 4, v * 4, 4, 419, 3);
    const clump = clamp01(edge * 3.2);
    const base = mix(rgb(0x9e9e9e), rgb(0xb4b4b4), tone);
    // Kept low: at 0.16 of tone and 0.07 of relief a horse's short coat read
    // as a fleece at two metres.
    const shade = (0.95 + id * 0.08) * (0.95 + clump * 0.05) * (0.95 + fine * 0.08);
    s.color = [base[0] * shade, base[1] * shade, base[2] * shade];
    s.height = 0.5 + clump * 0.035 + fine * 0.025 - d1 * 0.01;
    s.rough = 0.86 + fine * 0.1;
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

  bark(u, v, s) {
    const ridges = fbm(u * 26, v * 5, 26, 181, 4);
    const deep = Math.abs(Math.sin((u * 18 + ridges * 5) * Math.PI));
    const c = mix(rgb(0x3a2c20), rgb(0x6a5540), ridges * 0.7 + deep * 0.3);
    s.color = mix(c, rgb(0x241a12), (1 - deep) * 0.6);
    s.height = deep * 0.7 + ridges * 0.25;
    s.rough = 0.97;
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
    const warp = fbm(u * 4, v * 4, 4, 497, 3);
    // Beds a few centimetres to a couple of decimetres thick, gently warped.
    const strata = Math.sin((v * 11 + warp * 2.2 + fbm(u * 9, v * 9, 9, 501, 2) * 0.8) * Math.PI * 2) * 0.5 + 0.5;
    const body = fbm(u * 6, v * 6, 6, 499, 4);
    const pits = fbm(u * 24, v * 24, 24, 503, 3);
    const fine = fbm(u * 70, v * 70, 70, 505, 2);
    const crack = clamp01(1 - Math.abs(fbm(u * 4 + 0.7, v * 3, 4, 509, 3) - 0.5) * 26);
    const ochre = clamp01(fbm(u * 3, v * 1.2, 3, 521, 3) * 2.3 - 1.3);
    const calcite = clamp01(fbm(u * 8, v * 2, 8, 523, 3) * 2.5 - 1.5);
    let c = mix(rgb(0x4a453d), rgb(0x736b5e), body * 0.65 + pits * 0.27 + strata * 0.08);
    c = mix(c, rgb(0x7d5c38), ochre * 0.5);
    c = mix(c, rgb(0xa39d8f), calcite * 0.45);
    c = mix(c, rgb(0x2c2823), crack * 0.32);
    const shade = 0.9 + fine * 0.2;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = body * 0.3 + pits * 0.3 + strata * 0.05 + fine * 0.1 - crack * 0.22;
    s.rough = 0.7 + fine * 0.2 - calcite * 0.25;
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
  sootwall(u, v, s) {
    SURFACES.stonewall(u, v, s);
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
    // Measured, not guessed: at 0.10 mean albedo the district's walls went to
    // RGB 0 in their own shade after dusk (0.76% of a night street, 3.3% of a
    // ruin at dusk, against 0.01% anywhere in Midgaard). 0.16 keeps the soot
    // and loses the holes.
    const greyed = mix(s.color, rgb(0x3a3632), 0.72 + grime * 0.15);
    // Floor at 0x221e1b: nothing under a sky reads zero, and burnt stone is a
    // warm charcoal, not ink.
    s.color = mix(greyed, rgb(0x2c2825), clamp01(soot * 0.7));
    s.rough = Math.min(1, s.rough + soot * 0.12);
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
  sand: { surface: 'sand', scale: 6, normalScale: 0.4, env: 0.55, wet: 0, detail: 0.6 },
  // Out of doors and loose, so it takes damp -- but a path drains, which is the
  // whole point of gravelling one, so well under the street's 0.5.
  gravel: { surface: 'gravel', scale: 2.4, normalScale: 0.7, env: 0.75, wet: 0.28, detail: 0.6 },
  // Matt and dry: needle litter is the least reflective surface out of doors,
  // and it sheds water rather than holding it in pools. Low `env` for the same
  // reason peat has it -- a forest floor sees a fraction of the dome, and a
  // full mirror of the sky turns brown litter grey.
  duff: { surface: 'duff', scale: 3.2, normalScale: 0.6, env: 0.42, wet: 0, detail: 0.7 },
  iron: { surface: 'iron', scale: 1.6, normalScale: 0.5, env: 1.4, wet: 0, detail: 0.3 },
  // Arms and armour. Tile sizes are the size of the things: a blade is 5 cm
  // across and a shield 70.
  steel: { surface: 'steel', scale: 0.6, normalScale: 0.35, env: 1.5, wet: 0, detail: 0.25 },
  mail: { surface: 'mail', scale: 0.3, normalScale: 0.6, env: 1.3, wet: 0, detail: 0.2 },
  paint: { surface: 'paint', scale: 0.8, normalScale: 0.5, env: 0.6, wet: 0, detail: 0.4 },
  bark: { surface: 'bark', scale: 1.6, normalScale: 1.0, env: 0.65, wet: 0, detail: 0.5 },
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
  caverock: { surface: 'caverock', scale: 4.4, normalScale: 1.0, env: 1, wet: 0, detail: 0.6, buried: true },
  cavefloor: { surface: 'cavefloor', scale: 3.2, normalScale: 0.8, env: 1, wet: 0, detail: 0.6, buried: true },
  rustiron: { surface: 'rust', scale: 1.2, normalScale: 0.5, env: 1, wet: 0, detail: 0.3, buried: true },
  // The same, above ground: the guild wells' rungs.
  rust: { surface: 'rust', scale: 1.2, normalScale: 0.5, env: 0.9, wet: 0, detail: 0.3 },
  fungus: { surface: 'fungus', scale: 0.8, normalScale: 0.4, env: 1, wet: 0, detail: 0.3, buried: true },
  bone: { surface: 'bone', scale: 0.6, normalScale: 0.4, env: 1, wet: 0, detail: 0.3, buried: true },
  sewerwood: { surface: 'bark', scale: 1.6, normalScale: 0.6, env: 1, wet: 0, detail: 0.4, buried: true },
  // The eastern mountains, outside and in.
  cliff: { surface: 'sandstone', scale: 9, normalScale: 0.35, env: 0.3, wet: 0, detail: 0.6 },
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
  sootwall: { surface: 'sootwall', scale: 3.6, normalScale: 1.0, env: 0.6, wet: 0, detail: 0.55 },
  charred: { surface: 'charred', scale: 1.4, normalScale: 0.55, env: 0.5, wet: 0, detail: 0.5 },
  boards: { surface: 'boards', scale: 2.0, normalScale: 0.7, env: 0.7, wet: 0, detail: 0.45 },
  brokencobble: { surface: 'brokencobble', scale: 2.2, normalScale: 1.0, env: 1.05, wet: 0.55, detail: 0.5 },
  ash: { surface: 'ash', scale: 3.0, normalScale: 0.6, env: 0.6, wet: 0, detail: 0.6 },
  wasteground: { surface: 'wasteground', scale: 4.0, normalScale: 0.7, env: 0.45, wet: 0, detail: 0.6 },
  oldbone: { surface: 'bone', scale: 0.6, normalScale: 0.4, env: 0.7, wet: 0, detail: 0.3 },
  // Ice Dragon Way's smashed crystal statues: nearly all reflection.
  crystal: { surface: 'crystal', scale: 0.8, normalScale: 0.35, env: 1.7, wet: 0, detail: 0.1 },
  // The animals. A 0.4 m tile is a hand's-breadth clump pattern on a dog and
  // still reads as a coat on a horse. `moving` keeps the world-space effects
  // off them: a splash line fixed to the paving and a grain fixed to the world
  // both slide over anything that walks through them.
  fur: { surface: 'fur', scale: 0.4, normalScale: 0.3, env: 0.35, wet: 0, detail: 0, moving: true },
  feather: { surface: 'feather', scale: 0.3, normalScale: 0.3, env: 0.5, wet: 0, detail: 0, moving: true },
  // The monsters (tools/blender/monsters.py): shell, living mud and reptile
  // skin, all coloured per creature in its vertices like the fur.
  chitin: { surface: 'chitin', scale: 0.35, normalScale: 0.35, env: 0.9, wet: 0, detail: 0, moving: true },
  ooze: { surface: 'ooze', scale: 0.6, normalScale: 0.5, env: 1.1, wet: 0, detail: 0, moving: true },
  hide: { surface: 'hide', scale: 0.25, normalScale: 0.4, env: 0.5, wet: 0, detail: 0, moving: true },
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
const POINT_LINE = 'getPointLightInfo( pointLight, geometryPosition, directLight );';
const SUN_LINE = 'getDirectionalLightInfo( directionalLight, directLight );';
const LIGHTS_FRAGMENT_INDOOR = THREE.ShaderChunk.lights_fragment_begin.replace(
  HEMI_LINE,
  'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )'
  + ' * mix( 1.0, indoorBounce, vIndoor );',
).replace(
  POINT_LINE,
  `${POINT_LINE}\n#ifdef DIKU_BURIED\n\t\tdirectLight.color *= dikuBuriedGain;\n#endif`,
).replace(
  SUN_LINE,
  // The night "sun" is the moon at -8 degrees: a light from *under* the
  // world, which nothing underground is between -- it drew moonlit blue
  // hairlines down every corner of the sewer. Underground, a sun below the
  // horizon gives nothing; one above it still falls down a shaft.
  `${SUN_LINE}\n#ifdef DIKU_BURIED\n\t\tdirectLight.color *= smoothstep( 0.02, 0.12, dot( directionalLight.direction, viewMatrix[ 1 ].xyz ) );\n#endif`,
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
    shader.uniforms.dikuBuriedGain = buried.gain;
    shader.uniforms.dikuBuriedIrradiance = buried.irradiance;
    shader.uniforms.dikuBuriedRadiance = buried.radiance;
    shader.uniforms.dikuMurk = buried.murk;
    shader.uniforms.dikuMurkDensity = buried.murkDensity;

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
        uniform float dikuBuriedGain;
        uniform vec3 dikuBuriedIrradiance;
        uniform vec3 dikuBuriedRadiance;
        uniform vec3 dikuMurk;
        uniform float dikuMurkDensity;
      `)
      .replace('#include <lights_fragment_begin>', LIGHTS_FRAGMENT_INDOOR)
      .replace('#include <lights_fragment_end>', /* glsl */`
        #ifdef DIKU_BURIED
          // No sky down here: a fixed fill for the ambient and a near-black
          // for anything glossy to mirror, whatever the hour.
          // A little more from above than from below, the way a room lit by
          // torches on its walls is: a fill with no direction at all modelled
          // nothing, and a vault read as flat as the floor under it.
          float dikuUpFill = 0.8 + 0.2 * dot( geometryNormal, viewMatrix[ 1 ].xyz );
          irradiance = dikuBuriedIrradiance * dikuUpFill;
          iblIrradiance = irradiance;
          radiance = dikuBuriedRadiance;
        #endif
        #include <lights_fragment_end>
      `)
      .replace('#include <fog_fragment>', /* glsl */`
        #ifdef DIKU_BURIED
          #ifdef USE_FOG
            // The sewer's own murk, not the hour's haze: a night fog is blue
            // and a noon one is sky-pale, and neither is the air in a drain.
            float dikuMurkF = 1.0 - exp( - dikuMurkDensity * dikuMurkDensity * vFogDepth * vFogDepth );
            gl_FragColor.rgb = mix( gl_FragColor.rgb, dikuMurk, dikuMurkF );
          #endif
        #else
          #include <fog_fragment>
        #endif
      `)
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
        #ifndef DIKU_MOVING
        diffuseColor.rgb *= 1.0 - dikuSplash * 0.24 * ( 0.6 + dikuMacro.r * 0.7 );
        diffuseColor.rgb *= 1.0 + dikuSheltered * 0.06;
        #endif
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
  if (recipe.buried) {
    material.defines = { ...material.defines, DIKU_BURIED: 1 };
    // Read the hour's exposure where it is certain to be current: at draw
    // time, from the renderer itself. One compare when nothing changed.
    material.onBeforeRender = (renderer) => updateBuried(renderer.toneMappingExposure);
  }
  if (recipe.moving) material.defines = { ...material.defines, DIKU_MOVING: 1 };
  // Our injected source differs from stock, so it needs a key of its own or
  // three will hand us a program compiled for an undecorated material.
  material.customProgramCacheKey = () => `diku|${material.defines?.DIKU_DETAIL ? 1 : 0}`
    + `|${material.defines?.DIKU_WET ? 1 : 0}|${material.defines?.DIKU_BURIED ? 1 : 0}`
    + `|${material.defines?.DIKU_MOVING ? 1 : 0}`;
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
    if (!bakes.has(recipe.surface)) bakes.set(recipe.surface, bake(recipe.surface, size));
    const baked = bakes.get(recipe.surface);
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

  createDecals(materials);

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
