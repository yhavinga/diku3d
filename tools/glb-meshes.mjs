// node tools/glb-meshes.mjs <ref.glb> <new.glb> [regex]: meshes of ref (matching regex) against new, by name, every attribute.
import fs from 'fs';
const [refP, newP, re] = process.argv.slice(2);
const want = re ? new RegExp(re) : null;
function load(p) { const b = fs.readFileSync(p); const jl = b.readUInt32LE(12); const j = JSON.parse(b.slice(20, 20 + jl).toString()); const off = 20 + jl; const bl = b.readUInt32LE(off); return { j, bin: b.slice(off + 8, off + 8 + bl) }; }
const CT = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array, 5122: Int16Array };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function acc({ j, bin }, i) { const a = j.accessors[i], bv = j.bufferViews[a.bufferView]; const n = a.count * NC[a.type]; const T = CT[a.componentType]; const bytes = bin.slice((bv.byteOffset || 0) + (a.byteOffset || 0)); const ab = new ArrayBuffer(n * T.BYTES_PER_ELEMENT); new Uint8Array(ab).set(bytes.slice(0, n * T.BYTES_PER_ELEMENT)); return new T(ab); }
const o = load(refP), w = load(newP);
let same = 0, diff = [], missing = [];
for (const m of o.j.meshes) {
  if (want && !want.test(m.name)) continue;
  const n = w.j.meshes.find((x) => x.name === m.name);
  if (!n) { missing.push(m.name); continue; }
  let worst = 0, ok = m.primitives.length === n.primitives.length;
  m.primitives.forEach((p, k) => {
    const q = n.primitives[k]; if (!q) { ok = false; return; }
    for (const at of Object.keys(p.attributes)) {
      if (!(at in q.attributes)) { ok = false; continue; }
      const x = acc(o, p.attributes[at]), y = acc(w, q.attributes[at]);
      if (x.length !== y.length) { ok = false; continue; }
      for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
    }
    if (p.indices !== undefined) { const x = acc(o, p.indices), y = acc(w, q.indices); if (x.length !== y.length || x.some((v, i) => v !== y[i])) ok = false; }
  });
  if (ok && worst === 0) same++; else diff.push(`${m.name}(${ok ? worst.toExponential(1) : 'shape'})`);
}
console.log(newP.split('/').pop(), 'vs', refP, want ? `/${re}/` : '', 'same', same, 'diff', diff.length, diff.slice(0, 8).join(' '), 'missing', missing.join(',') || 'none');
process.exit(diff.length || missing.length ? 1 : 0);
