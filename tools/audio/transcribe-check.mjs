// Is a spoken clip intelligible? Sends the committed clip to ElevenLabs speech-to-text
// and compares the words heard with the words asked for. Costs a little credit per
// clip (speech-to-text is metered by audio length), so run it on a sample or after a change.
//   node tools/audio/transcribe-check.mjs            # every voice clip
//   node tools/audio/transcribe-check.mjs vo_a vo_b  # just these
//   node tools/audio/transcribe-check.mjs --role spell-cipher
// A cipher word has no spelling to be "right" against, so for those a mismatch is
// reported as distance, not as a failure: judge by the letters that carry over.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const key = readFileSync(join(root, '.env.elevenlabs'), 'utf8').match(/ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const manifest = JSON.parse(readFileSync(join(root, 'assets', 'audio', 'manifest.json'), 'utf8'));
const args = process.argv.slice(2);
const role = args.includes('--role') ? args[args.indexOf('--role') + 1] : null;
const ids = args.filter((a, i) => a.startsWith('vo_') && args[i - 1] !== '--role');
const clips = manifest.clips.filter((c) => c.kind === 'voice' && (!ids.length || ids.includes(c.id)) && (!role || c.role === role));
const norm = (t) => t.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const rows = [];
let next = 0;
async function worker() {
  while (next < clips.length) {
    const c = clips[next++];
    const fd = new FormData();
    fd.append('model_id', 'scribe_v1');
    fd.append('language_code', 'eng');
    fd.append('file', new Blob([readFileSync(join(root, 'assets', 'audio', c.file))]), c.file);
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: fd });
    if (!r.ok) { rows.push({ id: c.id, role: c.role, want: c.text, heard: `HTTP ${r.status}`, dist: 99 }); continue; }
    const heard = (await r.json()).text || '';
    const want = norm(c.text); const got = norm(heard);
    rows.push({ id: c.id, role: c.role, want: c.text, heard, dist: lev(want, got) / Math.max(1, want.length) });
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
rows.sort((a, b) => b.dist - a.dist);
writeFileSync('/tmp/transcribe-check.json', JSON.stringify(rows, null, 1));
const by = {};
for (const r of rows) (by[r.role] ||= []).push(r.dist);
for (const [k, v] of Object.entries(by)) console.log(`${k.padEnd(14)} n=${String(v.length).padStart(3)} exact=${v.filter((d) => d === 0).length} mean-distance=${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)}`);
for (const r of rows.slice(0, 25)) console.log(`${r.dist.toFixed(2)} ${r.id}: asked "${r.want}" heard "${r.heard}"`);
