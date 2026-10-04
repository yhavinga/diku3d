// The promo's sound from ElevenLabs: voice-over lines, the music bed, effects.
// Clips are described in tools/promo/audio.json; the answers land, untouched,
// in <out>/<id>.mp3 (default /Users/yeb/Movies/diku3d-promo/audio) and are
// never committed. A clip whose file exists is skipped unless --force.
//
//   node tools/promo/audio.mjs                 # every missing clip
//   node tools/promo/audio.mjs id1 id2 --force # just these, again
//   node tools/promo/audio.mjs --balance       # credits used / limit
//   node tools/promo/audio.mjs --stt file.mp3  # speech-to-text, printed with word timings
//
// The key is ELEVENLABS_API_KEY in .env.elevenlabs at the repo root (gitignored).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const out = value('--out') || '/Users/yeb/Movies/diku3d-promo/audio';
const ids = args.filter((a, i) => !a.startsWith('--') && !['--out', '--stt', '--manifest'].includes(args[i - 1]));
mkdirSync(out, { recursive: true });

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

async function stt(file) {
  const fd = new FormData();
  fd.append('model_id', 'scribe_v1');
  fd.append('language_code', 'eng');
  fd.append('timestamps_granularity', 'word');
  fd.append('file', new Blob([readFileSync(file)]), file.split('/').pop());
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key() }, body: fd });
  if (!r.ok) throw new Error(`stt ${file}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function call(clip) {
  let url; let body;
  if (clip.api === 'tts') {
    url = `https://api.elevenlabs.io/v1/text-to-speech/${clip.voice}?output_format=mp3_44100_192`;
    const { model_id: model, ...voice_settings } = clip.settings;
    body = { text: clip.text, model_id: model, voice_settings, ...(clip.seed !== undefined ? { seed: clip.seed } : null),
      ...(clip.previous_text ? { previous_text: clip.previous_text } : null), ...(clip.next_text ? { next_text: clip.next_text } : null) };
  } else if (clip.api === 'music') {
    url = 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192';
    body = { model_id: 'music_v1', ...clip.settings };
  } else {
    url = 'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_192';
    body = { text: clip.prompt, model_id: 'eleven_text_to_sound_v2', ...clip.settings };
  }
  const r = await fetch(url, { method: 'POST', headers: { 'xi-api-key': key(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${clip.id}: HTTP ${r.status} ${(await r.text()).slice(0, 400)}`);
  return { audio: Buffer.from(await r.arrayBuffer()), cost: r.headers.get('character-cost') };
}

if (flag('--balance')) { console.log(await balance()); process.exit(0); }
if (value('--stt')) {
  const d = await stt(value('--stt'));
  console.log(d.text);
  console.log((d.words || []).filter((w) => w.type === 'word').map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`).join('\n'));
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(value('--manifest') || join(root, 'tools', 'promo', 'audio.json'), 'utf8'));
const before = await balance();
for (const clip of manifest.clips) {
  if (ids.length && !ids.includes(clip.id)) continue;
  const file = join(out, `${clip.id}.mp3`);
  if (existsSync(file) && !flag('--force')) continue;
  const { audio, cost } = await call(clip);
  writeFileSync(file, audio);
  appendFileSync(join(out, 'credits.log'), `${new Date().toISOString()} ${clip.id} cost=${cost}\n`);
  console.log(`${clip.id}: ${audio.length} bytes, cost ${cost}`);
}
const after = await balance();
console.log(`credits: ${after.used - before.used} this run (${after.used}/${after.limit})`);
