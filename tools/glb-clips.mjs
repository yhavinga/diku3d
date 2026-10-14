// node tools/glb-clips.mjs <refDir> <newDir> [clip,clip,...]: every clip of ref (or the listed ones) against new, max abs diff.
import fs from 'fs';
const [refDir, newDir, only] = process.argv.slice(2);
const pick = only ? new Set(only.split(',')) : null;
function load(p) { const b = fs.readFileSync(p); const jl = b.readUInt32LE(12); const j = JSON.parse(b.slice(20, 20 + jl).toString()); const off = 20 + jl; const bl = b.readUInt32LE(off); return { j, bin: b.slice(off + 8, off + 8 + bl) }; }
const CT = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array, 5122: Int16Array };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function acc({ j, bin }, i) { const a = j.accessors[i], bv = j.bufferViews[a.bufferView]; const n = a.count * NC[a.type]; const T = CT[a.componentType]; const bytes = bin.slice((bv.byteOffset || 0) + (a.byteOffset || 0)); const ab = new ArrayBuffer(n * T.BYTES_PER_ELEMENT); new Uint8Array(ab).set(bytes.slice(0, n * T.BYTES_PER_ELEMENT)); return new T(ab); }
let fail = 0;
for (const n of ['person_male', 'person_female', 'troll', 'minotaur']) {
  const o = load(`${refDir}/${n}.glb`), w = load(`${newDir}/${n}.glb`);
  const key = (g, c) => g.j.nodes[c.target.node].name + '/' + c.target.path;
  let worst = 0; const bad = []; let count = 0;
  for (const a of o.j.animations) {
    if (pick && !pick.has(a.name)) continue;
    const b = w.j.animations.find((x) => x.name === a.name);
    if (!b) { bad.push(a.name + ' gone'); continue; }
    const bm = new Map(b.channels.map((c) => [key(w, c), c]));
    for (const c of a.channels) {
      const d = bm.get(key(o, c)); if (!d) { bad.push(a.name + ' nochan'); continue; }
      for (const [ia, ib] of [[a.samplers[c.sampler].input, b.samplers[d.sampler].input], [a.samplers[c.sampler].output, b.samplers[d.sampler].output]]) {
        const x = acc(o, ia), y = acc(w, ib); if (x.length !== y.length) { bad.push(a.name + ' len'); continue; }
        for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
      }
    }
    count++;
  }
  const vc = (g) => g.j.meshes.map((m) => m.name + ':' + m.primitives.map((p) => g.j.accessors[p.attributes.POSITION].count).join('+')).sort().join(' ');
  const jn = (g) => g.j.skins.map((s) => s.joints.map((i) => g.j.nodes[i].name).join(',')).join('|');
  const meshSame = vc(o) === vc(w); const jointsSame = jn(o) === jn(w);
  const newOnly = w.j.animations.map((x) => x.name).filter((x) => !o.j.animations.some((y) => y.name === x));
  console.log(n, 'clips', count, 'worst', worst, 'meshes same', meshSame, 'joints same', jointsSame, 'bad', bad.join(';') || 'none', 'new', newOnly.join(','));
  if (worst !== 0 || bad.length) fail = 1;
}
process.exit(fail);
