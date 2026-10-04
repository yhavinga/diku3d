// Every spoken event has its clip: runs voices.js planFor over every caster and
// speaker of the stock world, every spell and each class of listener, and
// fails if a plan names a clip the manifest does not have. Also prints which
// voice each kind of speaker got, as a census.
//   node tools/audio/voice-check.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld } from '../../src/are.js';
import { SPELLS } from '../../src/magic.js';
import { planFor, CASTER_CLASS, ADEPT_WORDS, MONSTER_SPELLS, LINES, VOICES } from '../../src/voices.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'merc21', 'area');
const world = buildWorld(readdirSync(dir).filter((f) => f.endsWith('.are')).sort().map((f) => parseArea(readFileSync(join(dir, f), 'latin1'), f)));
const manifest = new Map(JSON.parse(readFileSync(join(root, 'assets', 'audio', 'manifest.json'), 'utf8')).clips.map((c) => [c.id, c]));
let bad = 0; let plans = 0;
const census = {};
const fail = (msg) => { bad++; if (bad < 20) console.log('FAIL', msg); };
const SAID = SPELLS.filter((s) => !s.family.startsWith('breath') && !['general purpose', 'high explosive'].includes(s.name)).map((s) => s.name);

for (const proto of world.mobProtos.values()) {
  const special = world.specials.get(proto.vnum) || null;
  const slot = { proto, record: { special, shop: world.shops.has(proto.vnum) }, here: true };
  if (special === 'spec_cast_adept') {
    for (const spell of Object.keys(ADEPT_WORDS)) {
      const p = planFor({ kind: 'cast', source: 'spec', spell, from: slot }, { cls: 0, sex: 1 });
      plans++;
      if (!p || !manifest.has(p.id)) fail(`adept ${proto.short} ${spell}: ${p && p.id}`);
    }
  }
  if (special in CASTER_CLASS) {
    for (const cls of [0, 1, 2, 3]) {
      for (const spell of SAID) {
        // The tables are magic.js's; every spell is tried so a new table row cannot silently lack a clip.
        const p = planFor({ kind: 'cast', source: 'spec', spell, from: slot }, { cls, sex: 1 });
        if (!p) { census[`${proto.short} (silent)`] = 1; continue; }
        plans++;
        census[p.kind] = (census[p.kind] || 0) + 0;
        if ((p.kind === 'monster' || p.kind === 'witch') && !MONSTER_SPELLS.includes(spell)) continue;
        if (!manifest.has(p.id)) fail(`${proto.short} ${special} ${spell} cls ${cls}: ${p.id}`);
      }
    }
  }
}
for (const cls of [0, 1]) for (const sex of [1, 2]) for (const spell of SAID) {
  const p = planFor({ kind: 'cast', source: 'cast', fromPlayer: true, spell }, { cls, sex });
  plans++;
  if (!p || !manifest.has(p.id)) fail(`player ${cls}/${sex} ${spell}: ${p && p.id}`);
}
// The lines: a speaker of each role, said as the rules say it.
const SAMPLE = {
  mayor: { vnum: 3143, special: 'spec_mayor' }, guard: { special: 'spec_guard' }, exec: { special: 'spec_executioner' },
  keeper: { shop: true }, crowd: {},
};
const SAYS = {
  mayor_honey: 'Hello Honey!', mayor_view: 'What a view!  I must do something about that dump!', mayor_vandals: 'Vandals!  Youngsters have no respect for anything!',
  mayor_day: 'Good day, citizens!', mayor_open: 'I hereby declare the city of Midgaard open!', mayor_closed: 'I hereby declare the city of Midgaard closed!',
  guard_thief: 'Bob is a THIEF!  PROTECT THE INNOCENT!!  BANZAI!!', guard_killer: 'Bob is a KILLER!  PROTECT THE INNOCENT!!  BANZAI!!',
  guard_scream: "The cityguard screams 'PROTECT THE INNOCENT!!  BANZAI!!", exec_thief: 'Bob is a THIEF!  PROTECT THE INNOCENT!  MORE BLOOOOD!!!',
  exec_killer: 'Bob is a KILLER!  PROTECT THE INNOCENT!  MORE BLOOOOD!!!', keeper_later: 'Sorry, come back later.', keeper_tomorrow: 'Sorry, come back tomorrow.',
  keeper_nosell: "I don't sell that -- try 'list'.", keeper_nohave: "You don't have that item.", keeper_afford: "You can't afford to buy a sword.",
  keeper_level: "You can't use a sword yet.", keeper_thieves: 'Thieves are not welcome!', keeper_killers: 'Killers are not welcome!',
  thief_cry: "Bob is a bloody thief!",
};
for (const line of LINES) {
  if (!SAYS[line.key]) { fail(`line ${line.key} has no sample`); continue; }
  const s = SAMPLE[line.speaker];
  for (const sex of [1, 2]) for (const short of ['a man', 'a youth', 'a skeleton']) {
    const slot = { proto: { keywords: short, short, sex }, record: { special: s.special, shop: s.shop }, here: true };
    const p = planFor({ kind: 'mobsay', slot, said: SAYS[line.key] }, { cls: 3, sex: 1 });
    plans++;
    if (!p) { if (line.speaker === 'crowd') continue; fail(`line ${line.key} sex ${sex}: no plan`); continue; }
    if (!manifest.has(p.id)) fail(`line ${line.key}: ${p.id}`);
    census[`${line.speaker}: ${p.kind} (${VOICES[p.kind].name})`] = 1;
  }
}
// Player chat is never voiced.
if (planFor({ kind: 'say', speaker: 'Bob', said: 'Hello Honey!' }, { cls: 0, sex: 1 })) fail('player chat was voiced');
const files = [...manifest.values()].filter((c) => c.kind === 'voice');
for (const c of files) if (!existsSync(join(root, 'assets', 'audio', c.file))) fail(`${c.id}: no file`);
console.log(`${plans} plans checked, ${files.length} voice clips in the manifest, ${bad} failures`);
console.log(Object.keys(census).filter((k) => !k.includes('silent')).sort().join('\n'));
process.exit(bad ? 1 : 0);
