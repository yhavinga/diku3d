// Adds the spoken clips (spells, mobiles' lines) to assets/audio/manifest.json as
// entries without audio; run generate.mjs afterwards to make the files. An id
// already in the manifest has its text and settings refreshed.
//   node tools/audio/add-voices.mjs            # write the manifest
//   node tools/audio/add-voices.mjs --count    # print what it would add, with the characters (= credits)
// Who speaks and what is said is src/voices.js; the spell list and the cipher are magic.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPELLS, mysticWords } from '../../src/magic.js';
import { VOICES, LINES, SPEAKER_KINDS, ADEPT_WORDS, MONSTER_SPELLS, spellClipId, adeptClipId, lineClipId } from '../../src/voices.js';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'audio', 'manifest.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const MODEL = 'eleven_v4';
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
// The cipher can come out with no vowel at all ('yrl' for fly), which the voice reads as a foreign
// word or a language it guesses (it said Finnish). A vowelless word gets a 'u' between its letters.
const speakable = (t) => t.split(' ').map((w) => (/[aeiou]/.test(w) ? w : w.split('').join('u'))).join(' ');

// A spell that is said: not a breath (the dragon has no words) and not the judges' ammunition.
const SAID = SPELLS.filter((s) => !s.family.startsWith('breath') && !['general purpose', 'high explosive'].includes(s.name));

const wanted = [];
const add = (id, kind, text, role, mode) => {
  const v = VOICES[kind];
  wanted.push({
    id, file: `${id}.ogg`, kind: 'voice', api: 'tts', role, loop: false,
    voice: { id: v.id, name: v.name, kind }, text,
    settings: { model_id: MODEL, ...v[mode] },
    post: { lufs: -24, mono: true, kbps: 28, highpass: 70 },
  });
};

for (const kind of ['mage_m', 'mage_f', 'cleric_m', 'cleric_f']) {
  for (const sp of SAID) {
    add(spellClipId(kind, sp.name, 'n'), kind, cap(sp.name), 'spell-name', 'say');
    add(spellClipId(kind, sp.name, 'c'), kind, cap(speakable(mysticWords(sp.name))), 'spell-cipher', 'say');
  }
}
for (const kind of ['monster', 'witch']) {
  for (const name of MONSTER_SPELLS) {
    add(spellClipId(kind, name, 'n'), kind, cap(name), 'spell-name', 'say');
    add(spellClipId(kind, name, 'c'), kind, cap(speakable(mysticWords(name))), 'spell-cipher', 'say');
  }
}
for (const kind of ['cleric_m', 'cleric_f']) for (const [spell, word] of Object.entries(ADEPT_WORDS)) add(adeptClipId(kind, spell), kind, cap(word), 'adept-word', 'say');
for (const line of LINES) for (const kind of SPEAKER_KINDS[line.speaker]) add(lineClipId(kind, line.key), kind, line.text, `line-${line.speaker}`, 'line');

if (process.argv.includes('--count')) {
  const chars = wanted.reduce((n, c) => n + c.text.length, 0);
  const have = new Set(manifest.clips.map((c) => c.id));
  console.log(`${wanted.length} clips, ${chars} characters, ${wanted.filter((c) => !have.has(c.id)).length} new`);
  process.exit(0);
}
const byId = new Map(manifest.clips.map((c) => [c.id, c]));
for (const c of wanted) {
  const old = byId.get(c.id);
  if (old) Object.assign(old, { voice: c.voice, text: c.text, settings: c.settings, post: c.post, role: c.role });
  else manifest.clips.push(c);
}
writeFileSync(path, `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`manifest: ${wanted.length} voice clips`);
