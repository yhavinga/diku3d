// Coincident faces inside the generated models: the source of most z-fighting.
//
//   node tools/coplanar-check.mjs [--tol 0.002] [--min 0.0004] [name ...]
//
// Two triangles facing the same way, lying in the same plane (within `tol`
// metres) and overlapping by more than `min` square metres draw in an order
// decided by depth rounding, which changes with every step the camera takes:
// the flicker. A closed solid never has such a pair, so every one found is
// two parts of a model laid face to face -- a corner post flush with the
// next wall, a fillet sharing the bressumer's face, a slab on a slab. Faces
// that meet back to back (a block on a floor) are not counted: one of them
// is always culled.
//
// Reads assets/*.glb directly; nothing is loaded through three. Reports per
// model the overlapping area by material pair, and the worst places.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
let tol = 0.002, minArea = 0.0004, verbose = false;
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tol') tol = +args[++i];
  else if (args[i] === '--min') minArea = +args[++i];
  else if (args[i] === '-v') verbose = true;
  else names.push(args[i]);
}

function readGlb(file) {
  const b = fs.readFileSync(file);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString());
  const binStart = 20 + jsonLen + 8;
  const bin = b.subarray(binStart);
  const access = (i) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    const off = (v.byteOffset || 0) + (a.byteOffset || 0);
    const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    const stride = v.byteStride || n * T.BYTES_PER_ELEMENT;
    const out = new (T === Float32Array ? Float32Array : Uint32Array)(a.count * n);
    const dv = new DataView(bin.buffer, bin.byteOffset + off);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
      const o = k * stride + c * T.BYTES_PER_ELEMENT;
      out[k * n + c] = T === Float32Array ? dv.getFloat32(o, true) : T === Uint32Array ? dv.getUint32(o, true)
        : T === Uint16Array ? dv.getUint16(o, true) : dv.getUint8(o);
    }
    return out;
  };
  return { json, access };
}

const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const trs = (n) => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
};

function triangles(file) {
  const { json, access } = readGlb(file);
  const tris = [];
  const visit = (ni, parent) => {
    const node = json.nodes[ni];
    const m = mul(parent, trs(node));
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        const pos = access(prim.attributes.POSITION);
        const idx = prim.indices !== undefined ? access(prim.indices) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        const mat = prim.material !== undefined ? json.materials[prim.material].name.replace(/^MAT:/, '') : '?';
        const P = (i) => {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
        };
        for (let t = 0; t < idx.length; t += 3) {
          const a = P(idx[t]), b = P(idx[t + 1]), c = P(idx[t + 2]);
          const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const len = Math.hypot(...n);
          if (len < 1e-9) continue;
          n[0] /= len; n[1] /= len; n[2] /= len;
          tris.push({ a, b, c, n, d: n[0] * a[0] + n[1] * a[1] + n[2] * a[2], mat, area: len / 2 });
        }
      }
    }
    for (const ch of node.children || []) visit(ch, m);
  };
  const scene = json.scenes[json.scene || 0];
  for (const ni of scene.nodes) visit(ni, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return tris;
}

// Overlap of two coplanar triangles: clip one by the other in the plane.
function overlap(t, s) {
  const n = t.n;
  const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
  const i0 = (ax + 1) % 3, i1 = (ax + 2) % 3;
  const flat = (p) => [p[i0], p[i1]];
  let poly = [t.a, t.b, t.c].map(flat);
  let clip = [s.a, s.b, s.c].map(flat);
  const area = (p) => { let s2 = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; s2 += q[0] * r[1] - r[0] * q[1]; } return s2 / 2; };
  if (area(clip) < 0) clip = clip.reverse();
  for (let i = 0; i < 3 && poly.length; i++) {
    const p0 = clip[i], p1 = clip[(i + 1) % 3];
    const side = (p) => (p1[0] - p0[0]) * (p[1] - p0[1]) - (p1[1] - p0[1]) * (p[0] - p0[0]);
    const next = [];
    for (let k = 0; k < poly.length; k++) {
      const cur = poly[k], prv = poly[(k + poly.length - 1) % poly.length];
      const sc = side(cur), sp = side(prv);
      if (sc >= 0) {
        if (sp < 0) { const f = sp / (sp - sc); next.push([prv[0] + (cur[0] - prv[0]) * f, prv[1] + (cur[1] - prv[1]) * f]); }
        next.push(cur);
      } else if (sp >= 0) { const f = sp / (sp - sc); next.push([prv[0] + (cur[0] - prv[0]) * f, prv[1] + (cur[1] - prv[1]) * f]); }
    }
    poly = next;
  }
  // Projected area -> true area in the plane.
  return poly.length < 3 ? 0 : Math.abs(area(poly)) / Math.abs(n[ax]);
}

export function check(file) {
  const tris = triangles(file);
  const buckets = new Map();
  const key = (t, dd = 0) => `${Math.round(t.n[0] * 50)},${Math.round(t.n[1] * 50)},${Math.round(t.n[2] * 50)},${Math.round(t.d / 0.01) + dd}`;
  tris.forEach((t, i) => { const k = key(t); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(i); });
  const pairs = new Map();
  const worst = [];
  let total = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    for (const dd of [0, 1]) {
      for (const j of buckets.get(key(t, dd)) || []) {
        if (dd === 0 && j <= i) continue;
        const s = tris[j];
        if (t.n[0] * s.n[0] + t.n[1] * s.n[1] + t.n[2] * s.n[2] < 0.9995) continue;
        if (Math.abs(t.d - s.d) > tol) continue;
        const a = overlap(t, s);
        if (a < 1e-6) continue;
        const pk = [t.mat, s.mat].sort().join('/');
        pairs.set(pk, (pairs.get(pk) || 0) + a);
        total += a;
        worst.push({ a, mats: pk, at: t.a.map((v) => +v.toFixed(3)), n: t.n.map((v) => +v.toFixed(2)) });
      }
    }
  }
  worst.sort((p, q) => q.a - p.a);
  return { total, pairs, worst, tris: tris.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const dir = path.join(ROOT, 'assets');
  const files = (names.length ? names.map((n) => n.replace(/\.glb$/, '') + '.glb') : fs.readdirSync(dir).filter((f) => f.endsWith('.glb'))).sort();
  let bad = 0, sum = 0;
  for (const f of files) {
    const r = check(path.join(dir, f));
    if (r.total < minArea) continue;
    bad++; sum += r.total;
    const by = [...r.pairs.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ');
    console.log(`${f.padEnd(30)} ${r.total.toFixed(3).padStart(8)} m2  ${by}`);
    if (verbose) for (const w of r.worst.slice(0, 6)) console.log(`    ${w.a.toFixed(4)} ${w.mats} at ${w.at} n ${w.n}`);
  }
  console.log(`${bad} of ${files.length} models have coincident faces, ${sum.toFixed(2)} m2 in all`);
}
