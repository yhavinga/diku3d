// Every endboss of the stock world must get a boss piece that exists.
//   node tools/audio/boss-music-check.mjs                 # check
//   node tools/audio/boss-music-check.mjs --survey DIR    # also write DIR/survey.json and DIR/survey.md
//   node tools/audio/boss-music-check.mjs --break         # point boss:dragon at a missing clip: must fail
// BOSSES is the survey: the master(s) of each area's place, with the family
// each should fight to and what it is. soundmap.js's rules (bossFamilyOf) are
// tested against it, so a new word list cannot quietly move a boss.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld } from '../../src/are.js';
import { bossFamilyOf, fightPieceFor, FIGHT_MUSIC, BOSS_FAMILIES, BOSS_GAP, BOSS_LEVEL } from '../../src/soundmap.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
if (args.includes('--break')) FIGHT_MUSIC['boss:dragon'] = 'music_boss_missing';

// area file, mobile vnum, family, what it is
const BOSSES = [
  ['air.are', 1001, 'beast', 'griffin'],
  ['arachnos.are', 6314, 'beast', 'giant spider (the empress)'],
  ['arachnos.are', 6302, 'dragon', 'dragon'],
  ['arachnos.are', 6315, 'beast', 'ki-rin (celestial beast)'],
  ['arachnos.are', 6312, 'endboss', 'human warden (donjonkeeper)'],
  ['canyon.are', 9208, 'elemental', 'elemental (earth ruler)'],
  ['canyon.are', 9209, 'elemental', 'elemental (fire ruler)'],
  ['canyon.are', 9210, 'elemental', 'elemental (air ruler)'],
  ['canyon.are', 9211, 'elemental', 'elemental (lightning ruler)'],
  ['canyon.are', 9212, 'elemental', 'elemental (water ruler)'],
  ['catacomb.are', 2017, 'beast', 'beast of darkness'],
  ['catacomb.are', 2016, 'dragon', 'dragon (prism)'],
  ['catacomb.are', 2014, 'undead', 'necromancer'],
  ['catacomb.are', 2013, 'undead', 'vampire'],
  ['chapel.are', 3404, 'undead', 'vampire'],
  ['chapel.are', 3412, 'undead', 'ghost of a king'],
  ['chapel.are', 3410, 'undead', 'undead (Snapper Joe)'],
  ['daycare.are', 6607, 'endboss', 'human guard'],
  ['draconia.are', 2225, 'dragon', 'dragon (green)'],
  ['draconia.are', 2221, 'dragon', 'dragon (red)'],
  ['draconia.are', 2223, 'dragon', 'dragon (white)'],
  ['draconia.are', 2222, 'dragon', 'dragon (black)'],
  ['draconia.are', 2202, 'dragon', 'dragon master'],
  ['draconia.are', 2205, 'dragon', 'draconian king'],
  ['dream.are', 8600, 'endboss', 'keeper of the void'],
  ['drow.are', 5109, 'demon', 'demon (yochlol)'],
  ['drow.are', 5108, 'demon', 'drow matron mother'],
  ['drow.are', 5107, 'demon', 'drow matron mother'],
  ['dwarven.are', 6502, 'undead', 'wraith'],
  ['dwarven.are', 6516, 'endboss', 'mazekeeper'],
  ['dylan.are', 9107, 'sorcerer', 'witch'],
  ['dylan.are', 9106, 'elemental', 'roc (storm bird)'],
  ['dylan.are', 9105, 'elemental', 'roc (storm bird)'],
  ['dylan.are', 9104, 'elemental', 'effreeti'],
  ['dylan.are', 9103, 'elemental', 'air elemental'],
  ['eastern.are', 5005, 'dragon', 'dragon (brass)'],
  ['eastern.are', 5010, 'undead', 'dracolich'],
  ['eastern.are', 5004, 'beast', 'giant sand worm'],
  ['firenewt.are', 2912, 'endboss', 'newt leader'],
  ['firenewt.are', 2914, 'beast', 'fire lizard'],
  ['galaxy.are', 9332, 'titan', 'star (Polaris)'],
  ['galaxy.are', 9329, 'titan', 'constellation (Ursa Major)'],
  ['galaxy.are', 9330, 'titan', 'constellation queen'],
  ['galaxy.are', 9331, 'titan', 'constellation king'],
  ['galaxy.are', 9313, 'titan', 'constellation (Draco)'],
  ['gnome.are', 1505, 'endboss', 'gnome chief'],
  ['gnome.are', 1512, 'giant', 'troll'],
  ['gnome.are', 1519, 'titan', 'hobgoblin king'],
  ['grave.are', 3602, 'undead', 'ghoul'],
  ['grove.are', 8900, 'sorcerer', 'hierophant (druid)'],
  ['grove.are', 8901, 'sorcerer', 'hierophant (druid)'],
  ['haon.are', 6112, 'dragon', 'dragon (green)'],
  ['haon.are', 6319, 'beast', 'queen spider'],
  ['haon.are', 6116, 'sorcerer', 'druid'],
  ['hitower.are', 1364, 'sorcerer', 'archmage (grand mistress)'],
  ['hitower.are', 1356, 'sorcerer', 'guildmaster mage'],
  ['hitower.are', 1359, 'sorcerer', 'guildmaster mage'],
  ['hitower.are', 1362, 'sorcerer', 'guildmaster mage'],
  ['hood.are', 2103, 'endboss', 'human gang leader'],
  ['juargan.are', 4704, 'titan', 'dwarven king'],
  ['juargan.are', 4706, 'titan', 'ancient dwarven king'],
  ['juargan.are', 4707, 'beast', 'rock worm'],
  ['limbo.are', 1, 'dragon', 'dragon (Puff)'],
  ['mahntor.are', 2333, 'beast', 'minotaur (Mahn-Tor)'],
  ['mahntor.are', 2325, 'beast', 'minotaur master'],
  ['mahntor.are', 2326, 'beast', 'minotaur master'],
  ['mahntor.are', 2327, 'beast', 'minotaur master'],
  ['mahntor.are', 2328, 'beast', 'minotaur master'],
  ['mahntor.are', 2329, 'beast', 'minotaur master'],
  ['mahntor.are', 2330, 'beast', 'minotaur master'],
  ['mahntor.are', 2331, 'beast', 'minotaur master'],
  ['mahntor.are', 2332, 'beast', 'minotaur master'],
  ['mahntor.are', 2324, 'beast', 'minotaur ring-keeper'],
  ['mahntor.are', 2311, 'giant', 'ogre chieftain'],
  ['mahntor.are', 2310, 'giant', 'ogre shaman'],
  ['marsh.are', 8304, 'beast', 'swamp thing'],
  ['marsh.are', 8305, 'beast', 'gnoll'],
  ['marsh.are', 8303, 'giant', 'ogre'],
  ['marsh.are', 8313, 'demon', 'slaad'],
  ['mega1.are', 8010, 'titan', 'judge'],
  ['midennir.are', 3507, 'endboss', 'goblin leader'],
  ['midennir.are', 3500, 'dragon', 'wyvern'],
  ['midgaard.are', 3011, 'endboss', 'human executioner'],
  ['mirror.are', 5305, 'endboss', 'human defender (Gordon)'],
  ['mirror.are', 5308, 'giant', 'stone golem'],
  ['mobfact.are', 9402, 'endboss', 'human foreman'],
  ['moria.are', 4156, 'giant', 'troll'],
  ['moria.are', 4101, 'giant', 'troll'],
  ['moria.are', 4100, 'sorcerer', 'mage'],
  ['ofcol.are', 350, 'dragon', 'pet dragon'],
  ['ofcol.are', 306, 'endboss', 'human shopkeeper'],
  ['ofcol2.are', 631, 'dragon', 'dragon (ancient gold)'],
  ['ofcol2.are', 601, 'titan', 'marshall'],
  ['olympus.are', 901, 'titan', 'god (Zeus)'],
  ['olympus.are', 904, 'titan', 'god (Poseidon)'],
  ['olympus.are', 906, 'titan', 'god (Ares)'],
  ['olympus.are', 914, 'titan', 'god (Odin)'],
  ['olympus.are', 919, 'titan', 'god (Ra)'],
  ['olympus.are', 921, 'titan', 'goddess (Hera)'],
  ['plains.are', 305, 'beast', 'worm (Shudde-M\'ell)'],
  ['redferne.are', 7900, 'titan', 'human lord (grand knight)'],
  ['school.are', 3707, 'sorcerer', 'adept'],
  ['school.are', 3718, 'sorcerer', 'adept'],
  ['sewer.are', 7040, 'dragon', 'dragon (red)'],
  ['sewer.are', 7200, 'demon', 'mind flayer'],
  ['sewer.are', 7041, 'undead', 'sea hag'],
  ['sewer.are', 7043, 'beast', 'basilisk'],
  ['shire.are', 1120, 'endboss', 'human blacksmith'],
  ['shire.are', 1121, 'endboss', 'human battle master'],
  ['shire.are', 1100, 'sorcerer', 'elven wizard'],
  ['smurf.are', 111, 'sorcerer', 'wizard (Gargamel)'],
  ['smurf.are', 110, 'sorcerer', 'wizard (Papa Smurf)'],
  ['thalos.are', 5200, 'demon', 'beholder'],
  ['thalos.are', 5208, 'giant', 'stone golem'],
  ['trollden.are', 2804, 'giant', 'giant troll'],
  ['valley.are', 7811, 'sorcerer', 'wizard (Talemon)'],
  ['valley.are', 7812, 'demon', 'guardian daemon'],
  ['valley.are', 7809, 'dragon', 'pyrohydra'],
  ['wyvern.are', 1617, 'undead', 'spectre'],
  ['wyvern.are', 1616, 'dragon', 'ancient wyvern'],
  ['wyvern.are', 1613, 'beast', 'minotaur captain'],
  ['wyvern.are', 1615, 'giant', 'golem'],
];

const dir = join(root, 'merc21', 'area');
const files = readdirSync(dir).filter((f) => f.endsWith('.are')).sort();
const world = buildWorld(files.map((f) => parseArea(readFileSync(join(dir, f), 'latin1'), f)));
const manifest = JSON.parse(readFileSync(join(root, 'assets', 'audio', 'manifest.json'), 'utf8'));
const inManifest = new Set(manifest.clips.map((c) => c.id));
const fails = [];
const fail = (m) => fails.push(m);

const resets = new Map(); // vnum -> { rooms, special, areaFile }
for (const room of world.rooms.values()) {
  for (const m of room.mobs) {
    const e = resets.get(m.proto.vnum) || { rooms: [], special: null };
    e.rooms.push(`#${room.vnum} ${room.name}`);
    if (m.special) e.special = typeof m.special === 'string' ? m.special : JSON.stringify(m.special);
    resets.set(m.proto.vnum, e);
  }
}

function clipOk(key, who) {
  const id = FIGHT_MUSIC[key];
  if (!id) return fail(`${who}: no FIGHT_MUSIC entry for ${key}`);
  const entry = manifest.clips.find((c) => c.id === id);
  if (!entry) return fail(`${who}: ${id} is not in the manifest`);
  if (!existsSync(join(root, 'assets', 'audio', entry.file))) fail(`${who}: ${entry.file} is not on disk`);
}

const rows = [];
const perFamily = {};
for (const [areaFile, vnum, family, kind] of BOSSES) {
  const proto = world.mobProtos.get(vnum);
  const who = `${areaFile} #${vnum}`;
  if (!proto) { fail(`${who}: no such mobile`); continue; }
  const got = bossFamilyOf(proto);
  if (got !== family) fail(`${who} ${proto.short}: survey says ${family}, soundmap says ${got}`);
  if (!BOSS_FAMILIES.includes(got)) fail(`${who}: ${got} is not a family`);
  clipOk(`boss:${got}`, who);
  // A player level 1 and one at the boss's own level both reach the boss piece when the boss is high enough.
  if (proto.level >= BOSS_LEVEL || proto.level >= 1 + BOSS_GAP) {
    if (fightPieceFor(proto, { level: 1 }) !== `boss:${got}`) fail(`${who}: a level 1 player does not get boss:${got}`);
  }
  (perFamily[family] ||= []).push(proto.short);
  const res = resets.get(vnum) || { rooms: [], special: null };
  if (!res.rooms.length) fail(`${who}: never reset into a room`);
  rows.push({ area: areaFile, vnum, name: proto.short, keywords: proto.keywords, level: proto.level, act: proto.act, spec: res.special, room: res.rooms[0], kind, family, clip: FIGHT_MUSIC[`boss:${got}`] });
}

// Every area that has any mobile has a surveyed master.
const surveyed = new Set(BOSSES.map((b) => b[0]));
const withMobs = new Set([...world.rooms.values()].filter((r) => r.mobs.length).map((r) => r.areaFile));
for (const a of withMobs) if (!surveyed.has(a)) fail(`${a} has mobiles and no surveyed endboss`);
for (const f of BOSS_FAMILIES) if (!perFamily[f]) fail(`family ${f} has no boss`);

// Every mobile in the world, boss or not, lands on a family with a clip: nothing is unmapped.
for (const proto of world.mobProtos.values()) {
  const fam = bossFamilyOf(proto);
  if (!BOSS_FAMILIES.includes(fam)) fail(`#${proto.vnum} ${proto.short}: ${fam} is not a family`);
}

// Ordinary fights keep the ordinary piece; the boss rule itself is unchanged.
const ord = fightPieceFor({ level: 5, vnum: 3001, keywords: 'dragon' }, { level: 5 });
if (ord !== 'fight' || FIGHT_MUSIC[ord] !== 'music_fight') fail(`an even-level fight gives ${ord}, not fight/music_fight`);
if (fightPieceFor({ level: 11, keywords: 'dragon' }, { level: 5 }) !== 'boss:dragon') fail('a foe BOSS_GAP over you is not a dragon boss');
if (fightPieceFor({ level: 10, keywords: 'dragon' }, { level: 5 }) !== 'fight') fail('a foe below BOSS_GAP gets a boss piece');
if (fightPieceFor(null, { level: 5 }) !== null) fail('no foe gives a piece');
for (const [key, id] of Object.entries(FIGHT_MUSIC)) if (!inManifest.has(id)) fail(`${key}: ${id} missing from the manifest`);

if (args.includes('--survey')) {
  const out = args[args.indexOf('--survey') + 1];
  mkdirSync(out, { recursive: true });
  const noMobs = files.filter((f) => !withMobs.has(f));
  writeFileSync(join(out, 'survey.json'), `${JSON.stringify({ bossRule: { BOSS_GAP, BOSS_LEVEL }, areasWithoutMobiles: noMobs, families: perFamily, bosses: rows }, null, 1)}\n`);
  const md = ['| area | vnum | name | lvl | act | spec_fun | resets in | what | family |', '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.area} | ${r.vnum} | ${r.name} | ${r.level} | ${r.act} | ${r.spec || ''} | ${r.room} | ${r.kind} | ${r.family} |`)];
  writeFileSync(join(out, 'survey.md'), `${md.join('\n')}\n\nAreas with no mobiles: ${noMobs.join(', ')}.\n`);
}

console.log(`${rows.length} endbosses in ${surveyed.size} areas:`, Object.fromEntries(Object.entries(perFamily).map(([k, v]) => [k, v.length])));
if (fails.length) { console.error(`${fails.length} FAILURES\n${fails.join('\n')}`); process.exit(1); }
console.log('ok');
