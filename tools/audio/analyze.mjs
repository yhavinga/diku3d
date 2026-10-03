// Objective look at the committed clips, since nobody can listen in CI.
//   node tools/audio/analyze.mjs [id ...]
// Per clip: duration, integrated loudness, true-ish peak, share of near-silent
// 100 ms blocks, spectral centroid (a hint: drums and synth lift it, a lute
// does not), a coarse level timeline, and for loops the level at the seam.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SR = 48000;
const manifest = JSON.parse(readFileSync(join(root, 'assets/audio/manifest.json'), 'utf8'));
const ids = process.argv.slice(2);

function decodeMono(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 29 });
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k); const s = Math.sin(ang * k);
        const ur = re[i + k]; const ui = im[i + k];
        const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
        const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

function centroid(x) {
  const N = 2048; let num = 0; let den = 0;
  for (let at = 0; at + N <= x.length; at += SR >> 1) { // a frame every half second
    const re = new Float64Array(N); const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[at + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); num += m * m * k * SR / N; den += m * m; }
  }
  return den ? num / den : 0;
}

const dbOf = (v) => 20 * Math.log10(v + 1e-9);
for (const c of manifest.clips) {
  if (ids.length && !ids.includes(c.id)) continue;
  const x = decodeMono(join(root, 'assets/audio', c.file));
  const block = SR / 10; const levels = [];
  for (let at = 0; at + block <= x.length; at += block) {
    let s = 0; for (let i = at; i < at + block; i++) s += x[i] * x[i];
    levels.push(dbOf(Math.sqrt(s / block)));
  }
  const quiet = levels.filter((l) => l < -60).length / levels.length;
  const line = [];
  for (let i = 0; i < levels.length; i += 50) { const seg = levels.slice(i, i + 50); line.push(Math.round(seg.reduce((a, b) => a + b, 0) / seg.length)); }
  let seam = '';
  if (c.loop) {
    // generate.mjs closes every loop by blending its tail into its head, so the
    // seam is continuous by construction; this only shows whether a loud event
    // (or a hole) sits on it: the level of 100 ms either side against the clip.
    const n = x.length;
    const win = SR / 10; let edge = 0; let sq = 0;
    for (let i = 0; i < n; i++) sq += x[i] * x[i];
    for (let i = 0; i < win; i++) edge += x[i] * x[i] + x[n - 1 - i] * x[n - 1 - i];
    const edgeDb = dbOf(Math.sqrt(edge / (2 * win))) - dbOf(Math.sqrt(sq / n));
    seam = ` seam level ${edgeDb >= 0 ? '+' : ''}${edgeDb.toFixed(0)} dB`;
  }
  console.log(`${c.id.padEnd(24)} ${(x.length / SR).toFixed(1)}s ${c.loudness?.lufs} LUFS pk ${c.loudness?.peak} quiet ${(quiet * 100).toFixed(0)}% centroid ${Math.round(centroid(x))} Hz${seam}  [5s dB: ${line.join(' ')}]`);
}
