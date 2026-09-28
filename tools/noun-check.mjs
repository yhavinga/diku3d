// Every concrete thing a room's own words name, and whether anything was built
// for it.
//
// "A room whose prose names a thing and whose frame lacks it should count as a
// failed build" (round-5 judge). The readers -- clutter.js, shells.js,
// build.js's fittings and furniture -- each answer for their own nouns; this
// asks the other way round: here is every noun, who built it?
//
// Evidence is measured, not re-derived. tools/noun-probe.js runs in the page
// and records every model instanced and every decor entry left for actors.js,
// by the room nav.js says it stands in; this reads that file and checks each
// noun against it. What is built without a record -- procedural geometry out
// of build.js's batcher -- is taken from the room's own facts instead (a door
// is an exit with a door on it, a staircase an exit up or down), and says so.
//
//   (in the page)  tools/noun-probe.js  -> placed.json
//   node tools/noun-check.mjs --placed placed.json          summary + worklist
//   node tools/noun-check.mjs --placed placed.json --rooms  every room, noun by noun
//   node tools/noun-check.mjs --placed placed.json --noun statue
//
// Without --placed it lists the nouns and marks all of them unknown.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArea, buildWorld, EX_ISDOOR } from '../src/are.js';
import { readShell } from '../src/shells.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const areaDir = join(root, 'merc21', 'area');
const NINE = ['midgaard', 'sewer', 'shire', 'haon', 'grave', 'hood', 'marsh', 'trollden', 'eastern'];
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const placedFile = opt('--placed');
const nounArg = opt('--noun');
const showRooms = args.includes('--rooms');

// ------------------------------------------------------------ vocabulary ----
//
// Each entry: the words (`re`), the words' other senses (`not`), and what
// counts as built: model names placed in the room (`models`), decor kinds
// (`decor`), the shell (`shell`, over readShell's attributes and the built
// shell kind), a mobile or a fixed object in the room answering to the word
// (`mob`, `item`), or a fact of the room build.js builds from (`fact`).
// Material words (stone, marble, wood) and the ground itself (street, path,
// forest, floor, wall) are the shell's and the terrain's, not nouns here.
const M = (re) => (names) => names.some((n) => re.test(n));
const NOUNS = [
  { noun: 'altar', re: /\baltars?\b/, models: M(/^altar_/), decor: /^fitting:altar$/ },
  { noun: 'statue', re: /\bstatues?\b/, models: M(/^statue_|^crystal_stump$|^khan_memorial$|^dracolich_idol$/),
    fact: (r) => r.outdoor && /\bstatue\b[^.]{0,60}?\b(?:is|stands|standing|rises|towers)\b|statue here depicting/i.test(r.description) && 'buildStatue (procedural)' },
  { noun: 'throne', re: /\bthrones?\b/, models: M(/^statue_odin$|throne/) },
  { noun: 'fountain', re: /\bfountains?\b/, models: M(/^fountain$/), item: /fountain/ },
  { noun: 'well', re: /\b(?:old|a|the|stone|deep|dry)\s+well\b|\bwell ?house\b/, not: /\bas well\b|\bwell[- ](?:kept|lit|made|built|known|worn|trodden|used)\b/,
    models: M(/well$/), shell: (a, k) => k === 'well', item: /\bwell\b/ },
  { noun: 'table', re: /\btables?\b/, not: /\btable of contents\b/, models: M(/^furn_table|^clutter_feast$|^market_stall$|^clutter_alchemy$/), decor: /^table$|^piece:(worktable|desk)$/ },
  { noun: 'chair/bench/stool', re: /\b(?:chairs?|benches|bench|stools?|armchairs?|settles?)\b/, models: M(/^furn_(chair|armchair|stool|bench|settle)|^bench$/), decor: /^table$|^piece:(chair|armchair)$/ },
  { noun: 'bed', re: /\b(?:beds?|cots?|bunks?|bedrolls?)\b/, not: /\b(?:river|sea|flower|stream|lava) ?beds?\b|\bbedroom\b|\b(?:resembles|like|as in) a bed\b/, models: M(/^furn_bed$/), decor: /^piece:bed$/ },
  { noun: 'desk', re: /\bdesks?\b/, decor: /^piece:desk$/ },
  { noun: 'shelves', re: /\b(?:shelves|shelf|bookcases?|bookshelf|bookshelves)\b/, models: M(/^furn_shelves/), decor: /^fitting:shelves$/ },
  { noun: 'counter/bar', re: /\bcounter\b|\bthe bar\b/, decor: /^fitting:counter$/, models: M(/counter/) },
  { noun: 'fireplace', re: /\b(?:fireplace|hearth)\b/, decor: /^fitting:hearth$/ },
  { noun: 'forge/anvil', re: /\b(?:forge|anvil)\b/, decor: /^piece:(forge|anvil)$|^fitting:hearth$/ },
  { noun: 'oven', re: /\bovens?\b/, decor: /^piece:oven$/ },
  { noun: 'barrel', re: /\b(?:barrels?|casks?|kegs?)\b/, models: M(/barrel|cask|water_butt/) },
  { noun: 'crate/box', re: /\b(?:crates?|boxes|box)\b/, not: /\bstrong ?box\b|\bmetal box\b|\biron box\b/, models: M(/crate|strongbox|chest/) },
  { noun: 'sack', re: /\b(?:sacks?|bags)\b/, models: M(/^sack$/) },
  { noun: 'chest/safe', re: /\b(?:chests?|coffers?|safe|strong ?box|metal box|iron box)\b/, not: /\b(?:your|his|her|its|their) chest\b|\bsafe(?:ly|ty)?\s+(?:to|from|place|and)\b|\bnot safe\b|\bof safe\b|\bsafe,? solid\b/,
    models: M(/chest|strongbox|hoard/), item: /\b(chest|safe|box|coffer)\b/ },
  { noun: 'coffin/sarcophagus', re: /\b(?:coffins?|sarcophag\w*|caskets?|biers?)\b/, models: M(/sarcophagus/), shell: (a, k) => k === 'tomb' },
  { noun: 'skeleton', re: /\bskeletons?\b/, not: /\bskeleton (?:key|warriors?|guards?)\b/, models: M(/skeleton/), mob: /skeleton/ },
  { noun: 'bones/skulls', re: /\b(?:bones|skulls?|bone)\b/, not: /\b(?:your|the) bones\b/, models: M(/bone|skull|skeleton/) },
  { noun: 'corpse/carcass', re: /\b(?:corpses?|carcass(?:es)?|cadavers?|dead bod(?:y|ies)|body parts)\b/, not: /\b(?:contain\w*|jars?|bottles?)\b[^.]{0,40}\b(?:body parts|corpses?)\b/, models: M(/carcass|skeleton/), item: /corpse|carcass|carnage/ },
  { noun: 'web', re: /\b(?:webs?|cobwebs?)\b/, models: M(/web/) },
  { noun: 'cocoon', re: /\bcocoons?\b/, models: M(/cocoon/) },
  { noun: 'cage', re: /\bcages?\b/, not: /\brib ?cage\b/, models: M(/cage/) },
  { noun: 'chains/shackles', re: /\b(?:chains?|shackles?|manacles?|fetters)\b/, not: /\bchain ?mail\b/, models: M(/shackles|chain|skeleton_hanging/), shell: (a, k) => k === 'dungeon' },
  { noun: 'painting/picture', re: /\b(?:paintings?|pictures?|portraits?|murals?|frescoe?s?)\b/, not: /\bpicture (?:yourself|it)\b/, models: M(/painting|mural|arms/), shell: (a) => a && a.marks && a.marks.kind === 'mural' },
  { noun: 'tapestry', re: /\btapestr(?:y|ies)\b|\bwall ?hangings?\b/, models: M(/tapestry/) },
  { noun: 'banner/flag', re: /\b(?:banners?|flags?|pennants?)\b/, decor: /^banner$/ },
  { noun: 'sign', re: /\b(?:signs?|signposts?|notice ?board|placards?)\b/, not: /\bsigns? of\b|\bno signs?\b/, models: M(/sign|plaque/), decor: /^sign$/ },
  { noun: 'plaque', re: /\bplaques?\b/, models: M(/plaque/) },
  { noun: 'blackboard', re: /\b(?:black ?boards?|chalk ?boards?)\b/, models: M(/blackboard/) },
  { noun: 'pillar/column', re: /\b(?:pillars?|columns?)\b/, not: /\bcolumns? of (?:smoke|light|ants)\b|\blike (?:\w+ )?(?:pillars|columns)\b/, models: M(/column|pillar|pell/) },
  { noun: 'torch/sconce', re: /\b(?:torch(?:es)?|sconces?)\b/, models: M(/sconce/), decor: /^torch$/ },
  { noun: 'candle', re: /\b(?:candles?|candelabr\w*|candlesticks?)\b/, not: /\bcandle ?light\b/, models: M(/candle|altar_marble/), decor: /^flame$/ },
  { noun: 'lamp/lantern', re: /\b(?:lamps?|lanterns?|lamp ?posts?|street ?lights?)\b/, models: M(/lamp|lantern/), decor: /^lamp$/ },
  { noun: 'rug/carpet', re: /\b(?:rugs?|carpets?)\b/, models: M(/^rug$|pelts/) },
  { noun: 'curtain/drape', re: /\b(?:curtains?|drapes?|draperies)\b/, models: M(/curtain/) },
  { noun: 'mirror', re: /\bmirrors?\b/, models: M(/mirror/) },
  { noun: 'book/scroll', re: /\b(?:books?|tomes?|scrolls?)\b/, not: /\bbook ?keeper\b/, models: M(/shelves_jars|books?/) },
  { noun: 'pentagram', re: /\b(?:pentagrams?|pentacles?|magic circles?|summoning circles?)\b/, models: M(/pentagram/) },
  { noun: 'flask/bottle', re: /\b(?:flasks?|bottles?|vials?|phials?|jars?|beakers?|potions?)\b/, models: M(/alchemy|shelves_jars|bottle|jug/) },
  { noun: 'cauldron/pot', re: /\b(?:cauldrons?|kettles?|iron pot)\b/, models: M(/hearth_pot|cauldron/) },
  { noun: 'hay/straw', re: /\b(?:hay|straw)\b/, models: M(/hay/) },
  { noun: 'garbage/refuse', re: /\b(?:garbage|refuse|rubbish|trash|filth|dump)\b/, models: M(/refuse/) },
  { noun: 'rubble/debris', re: /\b(?:rubble|debris|ruins?)\b/, models: M(/rubble|debris|collapsed|charred_beams|ruin_/) },
  { noun: 'fire/flames', re: /\b(?:fires?|flames?|bonfires?|campfires?|embers)\b/, not: /\bfire ?(?:ball|breath|newt|place)\b|\b(?:on|under|open) fire\b|\bcease ?fire\b/, models: M(/brazier|fire_bed|forge|hearth/), decor: /^fire$|^flame$|^fitting:hearth$|^piece:forge$/ },
  { noun: 'smoke', re: /\bsmoke\b/, not: /\bsmoke-stained\b/, decor: /^smoke$/, models: M(/chimney/) },
  { noun: 'writing/graffiti', re: /\b(?:graffiti|writings?|inscriptions?|runes|letters|words)\b[^.]{0,40}\b(?:walls?|carved|written|painted|scratched|sprayed)\b|\b(?:walls?|carved|written|painted|scratched)\b[^.]{0,30}\b(?:graffiti|writings?|inscriptions?|runes|letters)\b/,
    shell: (a) => a && a.marks && (a.marks.kind === 'writing' || a.marks.kind === 'faces') },
  { noun: 'fence', re: /\b(?:fences?|railings?|palisade)\b/, models: M(/fence|stakes/) },
  { noun: 'gate/portcullis', re: /\b(?:gates?|portcullis|gateway)\b/, not: /\bgate(?:house)? (?:is|lies) (?:to|in) the\b/, models: M(/gate|portcullis|stone_arch|fortress/),
    fact: (r) => r.exits.some((e) => e && e.offMap) && 'sealed gate' },
  { noun: 'bridge', re: /\b(?:bridges?|footbridge)\b/, models: M(/gatehouse|fortress/), fact: (r) => /\bbridge\b/i.test(r.name) && 'bridge deck (procedural)' },
  { noun: 'tower', re: /\btowers?\b/, not: /\btowers? (?:above|over|high)\b/, models: M(/gatehouse|fortress|tower/) },
  { noun: 'monolith', re: /\bmonolith\b/, models: M(/monolith/) },
  { noun: 'grave/headstone', re: /\b(?:graves?|headstones?|tombstones?|grave ?stones?)\b/, not: /\bgraveyard\b/, models: M(/headstone|grave_slab/), shell: (a, k) => k === 'tomb' },
  { noun: 'tent', re: /\btents?\b/, models: M(/^tent_/) },
  { noun: 'palm', re: /\bpalms?\b/, not: /\bpalm of (?:your|his|her)\b/, models: M(/^palm_/) },
  { noun: 'rocks/boulders', re: /\b(?:rocks|boulders?)\b/, not: /\b(?:built|made|constructed) (?:from|of)\b[^.]{0,30}\brocks\b/, models: M(/rock|massif|crag|boulder|cave_/) },
  { noun: 'stalagmite', re: /\bstala[cg]\w+\b/, models: M(/stala/) },
  { noun: 'mushroom/fungus', re: /\b(?:mushrooms?|fung(?:us|i)|toadstools?|spores)\b/, models: M(/fungus|myconoid/), mob: /myconoid|fungus|mushroom/ },
  { noun: 'bush/hedge', re: /\b(?:bush(?:es)?|shrubs?|hedges?|brambles?|thorns|undergrowth)\b/, not: /\bivy bush\b/, models: M(/bush|hedge|bramble|salal|fern|nettles/) },
  { noun: 'tree', re: /\b(?:trees?|trunks?|oaks?|beeches|elms?|pines?|firs?|evergreens?|willows?)\b/, not: /\bpine ?(?:apple|cone)s?\b|\boak(?:en)? (?:table|door|chest|bench|chair|desk|beams?|floor)s?\b|\belm street\b/,
    models: M(/^tree_|dead_log|crystal_stump|palm_/), decor: /^tree$/, shell: (a) => a && (a.named === 'tree' || a.named === 'root') },
  { noun: 'roots', re: /\broots\b/, models: M(/^tree_/), decor: /^tree$/, shell: (a) => a && (a.named === 'tree' || a.named === 'root') },
  { noun: 'log', re: /\blogs?\b/, not: /\blog ?(?:cabin|house)\b/, models: M(/dead_log|log_cabin|firewood|fire_bed/), shell: (a, k) => k === 'log' },
  { noun: 'reeds', re: /\b(?:reeds?|rushes|cattails?)\b/, models: M(/reed|tussock/) },
  { noun: 'ladder', re: /\bladders?\b/, models: M(/ladder|sewer_pit/), fact: (r) => (r.exits[4] || r.exits[5]) && 'rungs on a way up or down (build.js)' },
  { noun: 'pipe', re: /\bpipes?\b/, not: /\bpipe ?weed\b|\bsmok\w+ (?:a |his )?pipes?\b|\bpipes and flasks\b/, models: M(/^sewer_/) },
  { noun: 'grate', re: /\bgrat(?:e|es|ing)\b/, models: M(/grate/), fact: (r) => r.exits.some((e) => e && (e.locks & EX_ISDOOR) && /grate/i.test(e.keyword || '')) && 'a grate on an exit' },
  { noun: 'door', re: /\bdoors?\b/, not: /\bdoorway\b|\bout ?doors\b|\bnext door\b|\bdoor-like\b/, fact: (r) => r.exits.some((e) => e && (e.locks & EX_ISDOOR)) && 'door on an exit' },
  { noun: 'stairs', re: /\b(?:stairs?|staircase|stairway|steps)\b/, not: /\bsteps? (?:back|aside|forward|lightly)\b|\byour steps\b/,
    models: M(/stair|ladder|steps/), fact: (r) => (r.exits[4] || r.exits[5]) && 'exit up or down' },
  { noun: 'window', re: /\bwindows?\b/, models: M(/window|house_/), decor: /^windows$/ },
  { noun: 'crystal', re: /\bcrystals?\b/, not: /\bcrystal(?:-| )clear\b/, models: M(/crystal|globe/) },
  { noun: 'stall', re: /\b(?:stalls?|booths?)\b/, not: /\bstall(?:s|ed)? (?:for|the)\b/, models: M(/market_stall/) },
  { noun: 'cart/wagon', re: /\b(?:carts?|wagons?|wheelbarrows?)\b/, models: M(/cart/) },
  { noun: 'trough', re: /\btroughs?\b/, models: M(/trough/) },
  { noun: 'idol', re: /\bidols?\b/, models: M(/idol/) },
  { noun: 'cushion', re: /\b(?:cushions?|pillows?)\b/, models: M(/cushion/) },
  { noun: 'barricade', re: /\bbarricades?\b/, models: M(/barricade/) },
  { noun: 'brazier', re: /\bbraziers?\b/, models: M(/brazier/) },
  { noun: 'weapons/armour', re: /\b(?:weapons|swords|axes|spears|armou?rs?|shields|halberds)\b/, not: /\bweapon ?shop\b|\barmou?ry\b/, models: M(/weapon|armour/), decor: /^piece:(weapon_rack|weapon_board|armour_stand)$/ },
  { noun: 'basket/jar', re: /\bbaskets?\b/, models: M(/basket/) },
  { noun: 'food', re: /\b(?:bread|loaves|meat|fruits?|vegetables|cheeses?|hams?|feast|pies?)\b/, models: M(/bread|feast|produce/) },
  { noun: 'treasure/coins', re: /\b(?:treasure|coins|jewels|gems|hoard)\b/, not: /\btreasurer?\b/, models: M(/hoard/) },
  { noun: 'blood', re: /\b(?:blood|gore)\b/, not: /\bblood[- ]?(?:red|shot|thirsty|lust|curdling)\b|\bcold blood\b/, shell: (a) => a && !!a.gore },
  { noun: 'faces (carved)', re: /\bfaces\b[^.]{0,40}\b(?:walls?|stone|carved|altar)\b|\bfaces are\b/, models: M(/relief_face|altar_faces/), shell: (a) => a && a.marks && a.marks.kind === 'faces' },
  { noun: 'triangle', re: /\btriangle\b/, models: M(/altar_faces/) },
  { noun: 'chandelier', re: /\bchandeliers?\b/, models: M(/chandelier/) },
  { noun: 'cabinet/wardrobe', re: /\b(?:cabinets?|cupboards?|wardrobes?|dressers?)\b/, models: M(/cabinet|cupboard|wardrobe/) },
  { noun: 'wheel/mill', re: /\b(?:water ?wheel|mill ?wheel|watermill|mill ?stones?)\b/, models: M(/mill|wheel/) },
  { noun: 'boat', re: /\b(?:boats?|rafts?|canoes?|ships?)\b/, not: /\bship ?shape\b/, models: M(/boat|raft/) },
  { noun: 'nest', re: /\bnests?\b/, models: M(/nest/) },
  { noun: 'machine/device', re: /\b(?:machines?|machinery|devices?|contraptions?|levers?)\b/, models: M(/machine|lever/) },
];

// Negation and distance, the same moves clutter.js makes: "no furniture",
// "the furniture has been stolen", "far below you", "to the north is the
// fountain" -- named, and not here.
const NOT_BEFORE = /\b(no|not|without|nothing|never|lacks?|lacking|barren|any)\s+(?:\w+[\s,]+){0,3}$/i;
const NOT_AFTER = /^[^.]{0,30}\b(has been stolen|have been stolen|is gone|are gone|has been removed|pulled down)\b/i;
const FAR = /\b(below you|beneath you|above you|in the distance|far below|far above|far away|through the window|you can see|you see|in front of you lies|leads? (?:to|into|up|down|through)|lead \w+ through|entrance (?:to|of)|towards?|way to|to the (?:north|south|east|west|up|down)|north(?:ward)?s? (?:is|lies)|south(?:ward)?s? (?:is|lies)|east(?:ward)?s? (?:is|lies)|west(?:ward)?s? (?:is|lies))\b[^.]{0,40}$/i;

// "The bar is to the east", "the bridge is just north of here".
const THERE = /^\s+(?:is|are|lies|lie|can be (?:found|seen))\s+(?:just\s+|further\s+)?(?:to the\s+)?(?:north|south|east|west|up|down|above|below)\b/i;

function sentencesOf(room) {
  const out = [];
  const push = (text, from) => {
    for (const s of String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)) if (s.trim()) out.push({ s: s.trim(), from });
  };
  push(room.name, 'name');
  push(room.description, 'prose');
  for (const e of room.extra || []) push(`${e.keyword}: ${e.description}`, 'extra');
  return out;
}

/** Every noun a room names, once each: { noun, why, where: 'here' | 'elsewhere' }. */
function nounsOf(room) {
  const found = new Map();
  for (const { s, from } of sentencesOf(room)) {
    for (const n of NOUNS) {
      const m = s.match(new RegExp(n.re.source, 'i'));
      if (!m) continue;
      if (n.not && new RegExp(n.not.source, 'i').test(s)) continue;
      const before = s.slice(0, m.index);
      const after = s.slice(m.index + m[0].length);
      if (NOT_BEFORE.test(before) || NOT_AFTER.test(after)) continue;
      // An extra description is what you see looking at something here.
      const where = from !== 'extra' && (FAR.test(before) || THERE.test(after)) ? 'elsewhere' : 'here';
      const prev = found.get(n.noun);
      if (prev && (prev.where === 'here' || where === 'elsewhere')) continue;
      found.set(n.noun, { noun: n.noun, why: `${from}: ${s}`, where, spec: n });
    }
  }
  return [...found.values()];
}

/** What in the room answers to a noun, or null. */
function evidence(n, room, placed, shellKind, attrs) {
  const models = placed ? Object.keys(placed.models || {}) : [];
  const decor = placed ? Object.keys(placed.decor || {}) : [];
  const out = [];
  if (n.models && n.models(models)) out.push(`model ${models.filter((x) => n.models([x])).slice(0, 3).join('/')}`);
  if (n.decor) { const d = decor.filter((x) => n.decor.test(x)); if (d.length) out.push(`decor ${d.slice(0, 3).join('/')}`); }
  if (n.shell && n.shell(attrs, shellKind)) out.push(`shell ${shellKind || 'attrs'}`);
  // A mobile or a fixed object answering to the word: actors.js draws both.
  const word = new RegExp(n.mob ? n.mob.source : n.re.source, 'i');
  const mob = (room.mobs || []).find((mb) => word.test(`${mb.proto.keywords} ${mb.proto.short}`));
  if (mob) out.push(`figure ${mob.proto.short}`);
  const iw = new RegExp(n.item ? n.item.source : n.re.source, 'i');
  const item = (room.items || []).find((o) => iw.test(`${o.proto.keywords} ${o.proto.short}`));
  if (item) out.push(`object ${item.proto.short}`);
  return out.length ? out.join(', ') : null;
}

// ------------------------------------------------------------------ run ----

const load = (names) => {
  const areas = names.map((n) => {
    const area = parseArea(readFileSync(join(areaDir, `${n}.are`), 'latin1'), `${n}.are`);
    for (const r of area.rooms) r.file = n;
    return area;
  });
  return buildWorld(areas);
};
const all = args.includes('--all') ? readdirSync(areaDir).filter((f) => f.endsWith('.are')).map((f) => f.slice(0, -4)) : NINE;
const world = load(all);
const placed = placedFile ? JSON.parse(readFileSync(placedFile, 'utf8')) : null;

// How near the start a room is, by exits walked from the temple: the rooms
// every player passes through come first on the worklist.
const dist = new Map([[3001, 0]]);
for (const q = [3001]; q.length;) {
  const v = q.shift();
  for (const e of world.rooms.get(v)?.exits || []) {
    if (!e || e.offMap || dist.has(e.to) || !world.rooms.has(e.to)) continue;
    dist.set(e.to, dist.get(v) + 1);
    q.push(e.to);
  }
}

const perArea = new Map();
const perNoun = new Map();
const missing = [];
let mentions = 0; let covered = 0;
for (const room of world.rooms.values()) {
  const shell = placed ? placed.shells[room.vnum] : null;
  if (placed && !shell) continue; // not built (in the air)
  const attrs = readShell(room);
  const here = placed ? placed.rooms[room.vnum] : null;
  const list = nounsOf(room).filter((x) => !nounArg || x.noun.includes(nounArg));
  const lines = [];
  for (const x of list) {
    if (x.where === 'elsewhere') { if (showRooms) lines.push(`   ${'-'.padEnd(2)} ${x.noun.padEnd(20)} (elsewhere) | ${x.why.slice(0, 110)}`); continue; }
    const ev = placed ? evidence(x.spec, room, here, shell.shell, attrs) : null;
    const factRoom = { ...room, outdoor: shell ? shell.outdoor : false };
    const fact = placed && x.spec.fact ? x.spec.fact(factRoom) : null;
    const got = ev || (fact ? `fact ${fact}` : null);
    mentions++;
    if (got) covered++;
    const a = perArea.get(room.file) || { m: 0, c: 0 };
    a.m++; if (got) a.c++; perArea.set(room.file, a);
    const nn = perNoun.get(x.noun) || { m: 0, c: 0 };
    nn.m++; if (got) nn.c++; perNoun.set(x.noun, nn);
    if (!got) missing.push({ room, noun: x.noun, why: x.why, d: dist.get(room.vnum) ?? 999 });
    if (showRooms || nounArg) lines.push(`   ${got ? 'ok' : '--'} ${x.noun.padEnd(20)} ${got ? `[${got}]` : ''} | ${x.why.slice(0, 110)}`);
  }
  if (lines.length) console.log(`${room.file}#${room.vnum} ${room.name}\n${lines.join('\n')}`);
}

const pct = (c, m) => (m ? `${((100 * c) / m).toFixed(0)}%` : '-');
console.log(`\nnoun mentions in rooms: ${mentions}, something built for ${covered} (${pct(covered, mentions)})${placed ? '' : ' -- no --placed file, nothing measured'}`);
console.log('\nby area:');
for (const [a, v] of [...perArea].sort((p, q) => NINE.indexOf(p[0]) - NINE.indexOf(q[0]))) console.log(`  ${a.padEnd(10)} ${String(v.c).padStart(4)} / ${String(v.m).padStart(4)}  ${pct(v.c, v.m)}`);
console.log('\nby noun (unbuilt first):');
for (const [n, v] of [...perNoun].sort((p, q) => (q[1].m - q[1].c) - (p[1].m - p[1].c))) console.log(`  ${n.padEnd(20)} ${String(v.c).padStart(4)} / ${String(v.m).padStart(4)}`);
if (placed && !showRooms && !nounArg) {
  console.log('\nworklist, nearest the temple first:');
  missing.sort((p, q) => p.d - q.d);
  for (const x of missing.slice(0, 80)) console.log(`  ${String(x.d).padStart(3)} ${x.room.file}#${x.room.vnum} ${x.room.name.padEnd(28)} ${x.noun.padEnd(18)} | ${x.why.slice(0, 90)}`);
}
