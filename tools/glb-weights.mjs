// node tools/glb-weights.mjs <file.glb> <mesh regex>: per material and 10 cm height band, the share of weight on skirt.L/R and on skirt2.L/R (the thigh and shin twins).
import fs from 'fs';
const [file, meshRe] = process.argv.slice(2);
const b = fs.readFileSync(file); const jl = b.readUInt32LE(12); const j = JSON.parse(b.slice(20, 20 + jl).toString()); const off = 20 + jl; const bin = b.slice(off + 8, off + 8 + b.readUInt32LE(off));
const CT = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function acc(i) { const a = j.accessors[i], bv = j.bufferViews[a.bufferView]; const n = a.count * NC[a.type]; const T = CT[a.componentType]; const s = bin.slice((bv.byteOffset || 0) + (a.byteOffset || 0)); const ab = new ArrayBuffer(n * T.BYTES_PER_ELEMENT); new Uint8Array(ab).set(s.slice(0, n * T.BYTES_PER_ELEMENT)); let out = new T(ab); if (a.normalized && T !== Float32Array) out = Float32Array.from(out, (v) => v / (T === Uint8Array ? 255 : 65535)); return out; }
const skin = j.skins[0]; const names = skin.joints.map((i) => j.nodes[i].name);
const k2 = new Set(names.map((n, i) => (/^skirt2/.test(n) ? i : -1)).filter((i) => i >= 0));
const k1 = new Set(names.map((n, i) => (/^skirt\.|^skirt[LR]$/.test(n) ? i : -1)).filter((i) => i >= 0));
for (const m of j.meshes) {
  if (!new RegExp(meshRe).test(m.name)) continue;
  for (const [pi, p] of m.primitives.entries()) {
    const P = acc(p.attributes.POSITION), J = acc(p.attributes.JOINTS_0), W = acc(p.attributes.WEIGHTS_0);
    const bands = {};
    for (let v = 0; v < P.length / 3; v++) {
      const z = P[v * 3 + 1]; const band = (Math.floor(z * 10) / 10).toFixed(1);
      let s2 = 0, s1 = 0; for (let q = 0; q < 4; q++) { if (k2.has(J[v * 4 + q])) s2 += W[v * 4 + q]; if (k1.has(J[v * 4 + q])) s1 += W[v * 4 + q]; }
      const e = bands[band] || (bands[band] = { n: 0, s1: 0, s2: 0 }); e.n++; e.s1 += s1; e.s2 += s2;
    }
    const mat = j.materials[p.material]?.name;
    console.log(m.name, pi, mat, Object.entries(bands).sort((a, b) => b[0] - a[0]).filter(([, e]) => e.s1 + e.s2 > 0.5).map(([z, e]) => `${z}:${(e.s1 / e.n).toFixed(2)}/${(e.s2 / e.n).toFixed(2)}`).join(' '));
  }
}
console.log('joints', names.filter((n) => /skirt/.test(n)).join(','));
