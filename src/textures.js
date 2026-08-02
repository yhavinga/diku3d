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
    const [, edge, id] = cellular(u * 7, v * 7, 7, 11, 0.38);
    const grout = clamp01((edge - 0.012) * 26);
    const grain = fbm(u * 34, v * 34, 34, 3, 3);
    const stone = mix(rgb(0x6f6a61), rgb(0x958d80), id);
    const wet = fbm(u * 5, v * 5, 5, 21, 3);
    const c = mix(rgb(0x413d38), stone, grout);
    const shade = 0.9 + grain * 0.2;
    s.color = [c[0] * shade, c[1] * shade, c[2] * shade];
    s.height = grout * (0.7 + id * 0.3) + grain * 0.06;
    s.rough = 0.92 - grout * 0.18 - wet * 0.15;
  },

  flagstone(u, v, s) {
    const cols = 4; const rows = 4;
    const gx = u * cols; const gy = v * rows;
    const cx = Math.floor(gx); const cy = Math.floor(gy);
    const fx = gx - cx; const fy = gy - cy;
    const id = hash2(cx, cy, cols, 5);
    const gap = 0.035;
    const inSlab = fx > gap && fx < 1 - gap && fy > gap && fy < 1 - gap;
    const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
    const grain = fbm(u * 26 + id * 10, v * 26, 26, 31, 4);
    const slab = mix(rgb(0x6d6a63), rgb(0x8e8a80), id * 0.8 + grain * 0.2);
    s.color = inSlab ? mix(slab, rgb(0x4b4842), grain * 0.45) : rgb(0x312f2b);
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
    s.rough = 0.3 + fine * 0.15;
  },

  plaster(u, v, s) {
    const coarse = fbm(u * 10, v * 10, 10, 13, 4);
    const fine = fbm(u * 60, v * 60, 60, 41, 3);
    const stain = clamp01(fbm(u * 3, v * 3 + 0.4, 3, 67, 3) * 1.6 - 0.55);
    const base = mix(rgb(0xc9bda3), rgb(0x9c9078), coarse * 0.55);
    s.color = mix(base, rgb(0x6e6350), stain * 0.5 * clamp01(1.25 - v * 1.6));
    s.height = 0.5 + fine * 0.25 + coarse * 0.1;
    s.rough = 0.88 + fine * 0.1;
  },

  stonewall(u, v, s) {
    // Coursed rubble: alternating rows of blocks with a recessed mortar joint.
    const rows = 6;
    const cols = 4;
    const gy = v * rows;
    const row = Math.floor(gy);
    const gx = u * cols + (row % 2) * 0.5;
    const col = Math.floor(gx);
    const fx = gx - col; const fy = gy - row;
    const id = hash2(col, row, cols, 3);
    const joint = 0.055;
    const jointY = joint * (cols / rows);
    const inBlock = fx > joint && fx < 1 - joint && fy > jointY && fy < 1 - jointY;
    const bevel = clamp01(Math.min(fx - joint, 1 - joint - fx, (fy - jointY) * 1.4, (1 - jointY - fy) * 1.4) / 0.06);
    const grain = fbm(u * 26 + id * 7, v * 26, 26, 23, 3);
    const block = mix(rgb(0x8b8478), rgb(0xa8a094), id);
    s.color = inBlock
      ? mix(block, rgb(0x6a6459), grain * 0.35 + (1 - bevel) * 0.3)
      : mix(rgb(0x5d574e), rgb(0x6d675e), grain);
    s.height = inBlock ? 0.62 + bevel * 0.3 + grain * 0.08 : 0.12;
    s.rough = 0.86 + grain * 0.1;
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
    const boards = 6;
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
    s.rough = 0.97;
  },

  dirt(u, v, s) {
    const lumps = fbm(u * 16, v * 16, 16, 107, 5);
    const grit = fbm(u * 70, v * 70, 70, 113, 2);
    const stone = clamp01(cellular(u * 22, v * 22, 22, 127, 0.5)[0] * -2.6 + 1);
    const c = mix(rgb(0x4b3d2c), rgb(0x796144), lumps * 0.85 + grit * 0.15);
    s.color = mix(c, rgb(0x6d675c), stone * 0.7);
    s.height = lumps * 0.5 + stone * 0.4 + grit * 0.1;
    s.rough = 0.96;
  },

  grass(u, v, s) {
    const blades = fbm(u * 120, v * 120, 120, 131, 2);
    const clump = fbm(u * 14, v * 14, 14, 137, 4);
    const dry = clamp01(fbm(u * 6, v * 6, 6, 149, 3) * 1.5 - 0.5);
    const green = mix(rgb(0x33421f), rgb(0x5c7033), clump * 0.8 + blades * 0.2);
    s.color = mix(green, rgb(0x8a7a45), dry * 0.55);
    s.height = blades * 0.6 + clump * 0.3;
    s.rough = 0.94;
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
    s.rough = 0.9;
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
  cobble: { surface: 'cobble', scale: 2.6, normalScale: 1.0, env: 1.15, wet: 0.5, detail: 0.5 },
  flagstone: { surface: 'flagstone', scale: 3.4, normalScale: 0.85, env: 1.1, wet: 0.45, detail: 0.5 },
  marble: { surface: 'marble', scale: 4, normalScale: 0.35, env: 1.35, wet: 0.2, detail: 0.3 },
  plaster: { surface: 'plaster', scale: 3, normalScale: 0.5, env: 0.7, wet: 0, detail: 0.6 },
  stonewall: { surface: 'stonewall', scale: 3.6, normalScale: 1.0, env: 0.95, wet: 0, detail: 0.55 },
  timber: { surface: 'timber', scale: 5.2, normalScale: 0.9, env: 0.8, wet: 0, detail: 0.45 },
  planks: { surface: 'planks', scale: 2.8, normalScale: 0.7, env: 0.85, wet: 0.2, detail: 0.45 },
  rooftile: { surface: 'rooftile', scale: 2.6, normalScale: 1.1, env: 1.0, wet: 0.35, detail: 0.5 },
  thatch: { surface: 'thatch', scale: 3, normalScale: 1.2, env: 0.55, wet: 0, detail: 0.7 },
  dirt: { surface: 'dirt', scale: 4.5, normalScale: 0.9, env: 0.7, wet: 0.3, detail: 0.6 },
  grass: { surface: 'grass', scale: 5.5, normalScale: 0.55, env: 0.6, wet: 0, detail: 0.7 },
  rock: { surface: 'rock', scale: 5, normalScale: 1.2, env: 0.9, wet: 0.25, detail: 0.6 },
  sand: { surface: 'sand', scale: 6, normalScale: 0.6, env: 0.7, wet: 0, detail: 0.6 },
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
function decorate(material, recipe, macro) {
  material.userData.detailStrength = recipe.detail ?? 0.5;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.macroMap = { value: macro };
    shader.uniforms.macroScale = { value: 1 / 26 };
    shader.uniforms.detailScale = { value: 6.3 };
    shader.uniforms.detailStrength = { value: material.userData.detailStrength };
    shader.uniforms.wetness = { value: recipe.wet ?? 0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfacePos;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n\tvSurfacePos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec3 vSurfacePos;
        uniform sampler2D macroMap;
        uniform float macroScale;
        uniform float detailScale;
        uniform float detailStrength;
        uniform float wetness;
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
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        roughnessFactor *= 0.84 + dikuMacro.b * 0.32;
        #ifdef DIKU_WET
          // World normal, from the view normal and an orthonormal view matrix.
          float dikuUp = clamp( dot( viewMatrix[ 1 ].xyz, vNormal ), 0.0, 1.0 );
          // Water sits in the low patches, and the low patches are where the
          // height field -- and so the macro tone -- is darkest.
          float dikuDamp = wetness * dikuUp * dikuUp
            * smoothstep( 0.58, 0.18, dikuMacro.r ) * smoothstep( 0.30, 0.62, dikuMacro.b );
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
            vec3 dikuN = texture2D( normalMap, vNormalMapUv * detailScale ).xyz * 2.0 - 1.0;
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
    decorate(material, recipe, macro);
    materials[name] = material;
    surfaced.push(material);
    onProgress((index + 1) / names.length, name);
  });

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

  return materials;
}

export const MATERIAL_NAMES = Object.keys(RECIPES);
