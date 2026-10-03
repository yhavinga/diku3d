// Regenerates the committed clips in assets/audio from assets/audio/manifest.json.
//
//   node tools/audio/generate.mjs                 # every clip whose .ogg is missing
//   node tools/audio/generate.mjs id1 id2         # just these (still skips existing ...)
//   node tools/audio/generate.mjs --force id1     # ... unless --force
//   node tools/audio/generate.mjs --post          # re-run only the ffmpeg stage over tools/audio/raw/
//   node tools/audio/generate.mjs --balance       # print the credit balance and stop
//   node tools/audio/generate.mjs --dry           # list what would be called
//
// The key is ELEVENLABS_API_KEY in .env.elevenlabs at the repo root (gitignored).
// The raw API answer is kept in tools/audio/raw/ (gitignored) so a loudness or
// trim change costs no credits: `--post` only. Needs ffmpeg with libopus.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const audioDir = join(root, 'assets', 'audio');
const rawDir = join(root, 'tools', 'audio', 'raw');
const manifestPath = join(audioDir, 'manifest.json');
const SR = 48000;
const CH = 2;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const ids = args.filter((a) => !a.startsWith('--'));

function key() {
  const env = readFileSync(join(root, '.env.elevenlabs'), 'utf8');
  const m = env.match(/^\s*ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/m);
  if (!m) throw new Error('ELEVENLABS_API_KEY not found in .env.elevenlabs');
  return m[1];
}

async function balance() {
  const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key() } });
  if (!r.ok) throw new Error(`subscription: HTTP ${r.status}`);
  const d = await r.json();
  return { used: d.character_count, limit: d.character_limit };
}

// ---------------------------------------------------------------- the API --

async function call(clip) {
  const s = clip.settings;
  let url; let body;
  if (clip.api === 'music') {
    url = 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128';
    // no `lines` in the plan means no vocals; force_instrumental is for prompt mode only
    body = { model_id: 'music_v1', ...s };
  } else {
    url = 'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128';
    body = { text: clip.prompt, model_id: 'eleven_text_to_sound_v2', ...s };
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${clip.id}: HTTP ${r.status} ${(await r.text()).slice(0, 400)}`);
  return { audio: Buffer.from(await r.arrayBuffer()), cost: r.headers.get('character-cost') };
}

// ---------------------------------------------------------------- ffmpeg ---

function decode(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', String(CH), '-ar', String(SR), '-'],
    { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg decode ${file}: ${r.stderr}`);
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function measure(pcm) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-f', 'f32le', '-ar', String(SR), '-ac', String(CH), '-i', '-',
    '-af', 'ebur128=peak=true', '-f', 'null', '-'], { input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), maxBuffer: 1 << 28 });
  const t = r.stderr.toString();
  const summary = t.slice(t.lastIndexOf('Summary:'));
  const num = (re) => { const m = summary.match(re); return m ? parseFloat(m[1]) : null; };
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), peak: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

function encode(pcm, out, kbps) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', String(CH), '-i', '-',
    '-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', '-application', 'audio', out],
  { input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg encode ${out}: ${r.stderr}`);
}

// ------------------------------------------------------------ the editing --

const frames = (pcm) => pcm.length / CH;

/** Cut leading/trailing air under `db` (keeps `pad` s of it): the API pads one-shots. */
function trim(pcm, db = -48, pad = 0.01) {
  const th = 10 ** (db / 20);
  let a = 0; let b = frames(pcm) - 1;
  const loud = (i) => Math.abs(pcm[i * CH]) > th || Math.abs(pcm[i * CH + 1]) > th;
  while (a < b && !loud(a)) a++;
  while (b > a && !loud(b)) b--;
  a = Math.max(0, a - Math.round(pad * SR));
  b = Math.min(frames(pcm) - 1, b + Math.round(pad * SR));
  return pcm.slice(a * CH, (b + 1) * CH);
}

/**
 * Makes a loop that closes on itself whatever the API did at its ends: the last
 * `x` seconds are blended (equal power) into the first, then dropped. Playing
 * the result round and round the tail's continuation *is* the head.
 */
function loopify(pcm, x) {
  const n = frames(pcm); const k = Math.min(Math.round(x * SR), Math.floor(n / 3));
  const out = pcm.slice(0, (n - k) * CH);
  for (let i = 0; i < k; i++) {
    const t = i / k; const wHead = Math.sin(t * Math.PI / 2); const wTail = Math.cos(t * Math.PI / 2);
    for (let c = 0; c < CH; c++) out[i * CH + c] = pcm[i * CH + c] * wHead + pcm[(n - k + i) * CH + c] * wTail;
  }
  return out;
}

function fade(pcm, inS, outS) {
  const n = frames(pcm); const a = Math.round(inS * SR); const b = Math.round(outS * SR);
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < a) g = i / a;
    if (i > n - b) g = Math.min(g, (n - i) / b);
    if (g < 1) for (let c = 0; c < CH; c++) pcm[i * CH + c] *= g;
  }
  return pcm;
}

/**
 * Individual steps in a walking clip: peaks of the 10 ms level (dB) that stand
 * `prominence` dB above the quietest point within `gap` s on both sides, which
 * is relative on purpose -- grass and sand are 20 dB softer than boots on stone
 * and their steps are swishes, not clicks. Each segment starts where the level
 * last sat `lead` dB under its peak (at most 0.12 s back) and ends at the next
 * step, at most 0.5 s on.
 */
function findSteps(pcm, gap = 0.28, prominence = 7, lead = 14) {
  const win = Math.round(0.01 * SR); const n = Math.floor(frames(pcm) / win);
  const db = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let s = 0;
    for (let i = w * win; i < (w + 1) * win; i++) s += pcm[i * CH] ** 2 + pcm[i * CH + 1] ** 2;
    db[w] = 10 * Math.log10(s / (win * CH) + 1e-12);
  }
  const sm = db.map((_, w) => (db[Math.max(0, w - 1)] + db[w] + db[Math.min(n - 1, w + 1)]) / 3);
  const span = Math.round(gap / 0.01);
  const sorted = [...sm].sort((x, y) => x - y);
  const floor = sorted[Math.floor(n * 0.95)] - 30; // nothing quieter than this is a step
  const peaks = [];
  for (let w = 1; w < n - 1; w++) {
    if (!(sm[w] >= sm[w - 1] && sm[w] > sm[w + 1]) || sm[w] < floor) continue;
    let lo = 1e9; let hi = 1e9;
    for (let k = 1; k <= span; k++) { if (w - k >= 0) lo = Math.min(lo, sm[w - k]); }
    for (let k = 1; k <= span; k++) { if (w + k < n) hi = Math.min(hi, sm[w + k]); }
    if (sm[w] - Math.max(lo === 1e9 ? -1e9 : lo, hi === 1e9 ? -1e9 : hi) < prominence) continue;
    if (peaks.length && (w - peaks[peaks.length - 1]) * 0.01 < gap) {
      if (sm[w] > sm[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = w;
      continue;
    }
    peaks.push(w);
  }
  return peaks.map((w, i) => {
    let a = w; while (a > 0 && w - a < 12 && sm[a] > sm[w] - lead) a--;
    const start = Math.max(0, a * 0.01 - 0.01);
    const next = peaks[i + 1] !== undefined ? peaks[i + 1] * 0.01 - 0.09 : frames(pcm) / SR;
    return [+start.toFixed(3), +Math.min(next - start, 0.5).toFixed(3)];
  }).filter(([, d]) => d > 0.12);
}

/**
 * 2nd-order Butterworth high-pass, in place per channel. The API's ambience
 * carries a lot of energy under 50 Hz (centroids of 35-50 Hz): inaudible on
 * laptop speakers, but it eats headroom and ebur128's K-weighting does not see it.
 */
function highpass(pcm, hz) {
  const w = 2 * Math.PI * hz / SR; const cos = Math.cos(w); const alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0; const b1 = -(1 + cos) / a0; const b2 = b0;
  const a1 = -2 * cos / a0; const a2 = (1 - alpha) / a0;
  for (let c = 0; c < CH; c++) {
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    for (let i = c; i < pcm.length; i += CH) {
      const x0 = pcm[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      pcm[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
  }
}

/** Soft knee above `knee`: spiky ambience is tamed rather than left to set the level. */
function softClip(pcm, knee = 0.5) {
  const span = 1 - knee;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > knee) pcm[i] = Math.sign(pcm[i]) * (knee + span * Math.tanh((a - knee) / span));
  }
}

function post(clip, rawFile) {
  let pcm = decode(rawFile);
  const p = clip.post || {};
  highpass(pcm, p.highpass ?? (clip.kind === 'ambience' ? 80 : 35));
  if (clip.kind === 'footstep' || clip.kind === 'sfx') pcm = trim(pcm);
  if (clip.loop) pcm = loopify(pcm, p.crossfade ?? 1.5);
  else if (clip.kind === 'music') pcm = fade(trim(pcm, -55, 0.02), p.fadeIn ?? 0.05, p.fadeOut ?? 2.5);
  let steps = null;
  if (clip.kind === 'footstep') steps = findSteps(pcm, p.stepGap ?? 0.28, p.stepRise, p.stepFloor);
  const before = measure(pcm);
  let gainDb = 0;
  if (clip.kind === 'footstep' || clip.kind === 'sfx') gainDb = (p.peakDb ?? -4) - before.peak;
  else gainDb = (p.lufs ?? -26) - before.lufs;
  if (clip.kind === 'ambience') {
    // Level first, then tame the spikes that kept the level down, then level again.
    for (let pass = 0; pass < 2; pass++) {
      const m = measure(pcm);
      const g1 = 10 ** ((p.lufs - m.lufs) / 20);
      for (let i = 0; i < pcm.length; i++) pcm[i] *= g1;
      softClip(pcm, 0.35);
    }
    gainDb = 0;
  }
  gainDb = Math.min(gainDb, -0.5 - before.peak); // never past -0.5 dBFS
  const g = 10 ** (gainDb / 20);
  for (let i = 0; i < pcm.length; i++) pcm[i] *= g;
  const after = measure(pcm);
  const out = join(audioDir, clip.file);
  encode(pcm, out, p.kbps ?? (clip.kind === 'music' ? 72 : 56));
  return {
    duration: +(frames(pcm) / SR).toFixed(2), bytes: statSync(out).size, steps,
    loudness: { lufs: after.lufs, peak: after.peak, lra: after.lra },
  };
}

// ------------------------------------------------------------------ main ---

mkdirSync(rawDir, { recursive: true });
if (flag('--balance')) { console.log(await balance()); process.exit(0); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const wanted = manifest.clips.filter((c) => !ids.length || ids.includes(c.id));
if (ids.length && wanted.length !== ids.length) throw new Error(`unknown id in ${ids.join(', ')}`);

const start = flag('--dry') ? null : await balance();
let spent = 0;
for (const clip of wanted) {
  const out = join(audioDir, clip.file);
  const raw = join(rawDir, `${clip.id}.mp3`);
  if (flag('--dry')) { console.log(clip.id, existsSync(out) ? '(exists)' : '(missing)'); continue; }
  if (flag('--post')) {
    if (!existsSync(raw)) { console.log(`${clip.id}: no raw file, skipped`); continue; }
  } else {
    if (existsSync(out) && !flag('--force')) { console.log(`${clip.id}: exists`); continue; }
    if (existsSync(raw) && !flag('--force')) {
      console.log(`${clip.id}: reusing raw`);
    } else {
      const { audio, cost } = await call(clip);
      writeFileSync(raw, audio);
      spent += Number(cost) || 0;
      console.log(`${clip.id}: generated, cost ${cost}`);
    }
  }
  Object.assign(clip, post(clip, raw));
  console.log(`${clip.id}: ${clip.duration}s ${clip.bytes}B ${clip.loudness.lufs} LUFS peak ${clip.loudness.peak}${clip.steps ? ` steps ${clip.steps.length}` : ''}`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
}
if (start) {
  const end = await balance();
  console.log(`credits: ${start.used} -> ${end.used} of ${end.limit} (this run ${end.used - start.used}, header sum ${spent})`);
}
