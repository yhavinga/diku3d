/**
 * Who a mobile is, read off its own words: which body, which clothes, what it
 * carries, what it wears on its head, and in what colours.
 *
 * Pure data and string matching, no three.js, so `tools/people-check.mjs` can
 * run it over every mobile in all 45 stock areas and print the result -- which
 * is how every word below got in and every reject got written. The rule the
 * rest of this project learned the hard way applies here too: a vocabulary is
 * tested against the whole corpus before it ships, and the reject list is as
 * load-bearing as the match list.
 *
 * Words are matched in the keywords and the short description only. The long
 * description and the prose mention other people ("a guard watches you"), and
 * running trade words over them dressed half the world by what it can see.
 * The two exceptions read the prose on purpose and say why: halflings, whom the
 * mud mostly names only there, and sex, where the keywords are often silent.
 */

// --- the clips ------------------------------------------------------------

/**
 * Facts about the clips in person_male.glb, person_female.glb and troll.glb,
 * as tools/blender/people.py measured them at build time (people_clips.json).
 * `stride` is metres of ground a full cycle covers at scale 1; `hit` is the
 * fraction of the clip at which the blow lands.
 */
export const CLIP_FACTS = {
  person_male: { walk: 1.20, run: 2.60 },
  person_female: { walk: 1.20 * (0.905 - 0.085) / 0.866, run: 2.60 * (0.905 - 0.085) / 0.866 },
  troll: { walk: 1.20 * (0.860 - 0.095) / 0.866, run: 2.60 * (0.860 - 0.095) / 0.866 },
};
export const HIT_FRAME = { attack: 10 / 19, attack2: 11 / 21 };
export const LOOPS = new Set(['idle', 'idle2', 'walk', 'run', 'fight']);
export const CLIPS = ['idle', 'idle2', 'walk', 'run', 'fight', 'attack', 'attack2', 'hit', 'block', 'death'];

// --- vocabulary -------------------------------------------------------------

const W = (words) => new RegExp(`\\b(${words})\\b`, 'i');

/** Humanoid monsters, first: a skeleton guard is a skeleton before a guard. */
const MONSTERS = [
  ['skeleton', W('skeletons?|skeletal|lich|bones')],
  ['ghost', W('ghosts?|spectres?|specters?|wraiths?|phantoms?|apparitions?|banshees?|spirits?|shades?|poltergeists?|haunts?')],
  ['zombie', W('zombies?|ghouls?|ghasts?|corpses?|mummy|mummies|undead|revenants?|wights?|draugr')],
  // Anything troll-shaped: the troll rig at the right size and in the right
  // hide. `giant` only as a person -- a giant spider is not an ogre.
  ['troll', W('trolls?|ogres?|ogrillons?|ettins?|gnolls?|orcs?|orcish|hobgoblins?|bugbears?|goblins?|kobolds?|gargoyles?|swamp ?thing|trogs?|troglodytes?|yeti|sasquatch|slaads?|lizard ?m[ae]n|bullywugs?')],
  ['troll', /\bgiants?\b(?!\s+(spider|rat|snake|worm|ant|beetle|bat|slug|lizard|frog|toad|eagle|centipede|scorpion|leech|crab|fish|squid|serpent|wasp|bee|fly|spiders|rats|snakes))/i],
];

/** A troll-rigged monster's size and hide, by what it is called. */
const TROLL_KINDS = [
  [W('baby'), { scale: 0.75, skin: 0x6a7a55 }],
  [W('young'), { scale: 1.0, skin: 0x667452 }],
  // A giant or an ogre is one whatever marsh it lives in; a troll's size
  // words only after that.
  [W('ogres?|ogrillons?'), { scale: 1.40, skin: 0x8a7658, hair: true }],
  [/\b(giants?|ettins?)\b(?!\s+troll)/i, { scale: 1.55, skin: 0xa88568, hair: true }],
  [W('swamp|marsh|bog'), { scale: 1.30, skin: 0x4f5c3f }],
  [W('giant|huge|large'), { scale: 1.45, skin: 0x5e6b4c }],
  [W('gargoyles?'), { scale: 1.05, skin: 0x6d6b67 }],
  [W('slaads?|bullywugs?|lizard ?m[ae]n'), { scale: 1.15, skin: 0x4f6a3a }],
  [W('gnolls?'), { scale: 1.05, skin: 0x7a6546 }],
  [W('orcs?|orcish|hobgoblins?|bugbears?'), { scale: 0.95, skin: 0x5d6a45 }],
  [W('goblins?|kobolds?'), { scale: 0.62, skin: 0x6b7a44 }],
  [W('trolls?'), { scale: 1.30, skin: 0x5f6e4c }],
];

/**
 * The trades. First match wins, so the order is the order of precedence:
 * a knight templar is a knight, a guard captain is a guard, a shopkeeping
 * wizard is a wizard.
 */
const TRADES = [
  ['knight', W('knights?|paladins?|templars?|crusaders?|cavaliers?|champions?')],
  ['guard', W('guards?|guardsman|guardsmen|cityguards?|soldiers?|watchman|watchmen|sentry|sentries|sentinels?|captains?|sergeants?|warriors?|mercenar(y|ies)|legionnaires?|militia|patrol|trainees?|battle ?masters?|swordsman|swordsmen|fighters?|gladiators?|shiriffs?|sheriffs?|constables?|bodyguards?|adventurers?|veterans?|recruits?|squires?|archers?|bowman|lancers?|infantry|troopers?|wardens?|gatekeepers?')],
  ['mage', W('wizards?|mages?|magicians?|sorcerer|sorceress|sorcerers|warlocks?|witch|witches|enchanter|enchantress|necromancers?|conjurers?|illusionists?|magus|magi|alchemists?|sages?|seers?|mystics?|diviners?|astrologers?|oracles?')],
  ['priest', W('priests?|priestess|clerics?|monks?|acolytes?|nuns?|abbots?|abbess|bishops?|healers?|druids?|chaplains?|friars?|sextons?|shamans?|hermits?|pilgrims?|curates?|deacons?|vicars?|prophets?|templekeeper')],
  ['rogue', W('thief|thieves|rogues?|assassins?|cutpurses?|pickpockets?|bandits?|brigands?|robbers?|highwaym[ae]n|spies|spy|burglars?|smugglers?|dealers?|ruffians?|thugs?|cutthroats?|outlaws?|poachers?|rangers?|hunters?|scouts?|executioners?|headsm[ae]n')],
  ['beggar', W('beggars?|vagabonds?|tramps?|drunks?|drunkards?|bums?|hobos?|paupers?|urchins?|lepers?|filthy|wretch(es)?|madm[ae]n|lunatics?|vagrants?|idiots?|fools?')],
  ['smith', W('smiths?|blacksmiths?|weaponsmiths?|armourers?|armorers?|farriers?|tanners?|leather ?workers?|cobblers?|coopers?|masons?|miners?')],
  ['noble', W('kings?|queens?|princes?|princess(es)?|dukes?|duchess(es)?|lords?|lady|ladies|barons?|baroness(es)?|counts?|countess(es)?|earls?|mayors?|nobles?|nobleman|noblemen|noblewoman|thains?|guildmasters?|chancellors?|magistrates?|judges?|urbanites?|aristocrats?|courtiers?|criers?|diplomats?|ambassadors?|keepers?|masters?|governors?|regents?|emperors?|empress|elders?|chieftains?|chiefs?|heralds?|gods?|goddess(es)?|zeus|odin|hera|apollo|ares|hermes|poseidon|prometheus|hierophant|leaders?|commanders?|generals?|foremen|foreman')],
  ['merchant', W('shopkeepers?|shopkeeps?|merchants?|grocers?|bakers?|butchers?|jewell?ers?|traders?|pedlars?|peddlers?|vendors?|tailors?|innkeepers?|barkeeps?|bartenders?|barmen|barman|waiters?|cooks?|chefs?|brewers?|vintners?|apothecar(y|ies)|herbalists?|clerks?|secretar(y|ies)|receptionists?|bankers?|moneychangers?|changers?|storekeepers?|hostelers?|landlords?|tavernkeepers?|fishmongers?|florists?|cartographers?|scribes?|librarians?|teachers?|tutors?|stewards?|butlers?|servants?')],
  ['peasant', W('peasants?|farmers?|labou?rers?|farmhands?|shepherds?|herdsm[ae]n|stablehands?|stableboys?|grooms?|fishermen|fisherman|sailors?|seam[ae]n|gardeners?|bumpkins?|serfs?|slaves?|porters?|janitors?|sweepers?|lumberjacks?|woodcutters?|woodsm[ae]n|millers?|millworkers?|workers?|carpenters?|gravediggers?|diggers?|boatm[ae]n|ferrym[ae]n|drovers?|carters?|travell?ers?|citizens?|townsm[ae]n|townsfolk|villagers?|locals?|commoners?|youths?|boys?|lads?|m[ae]n|persons?|people|humans?|elves|elf|elven|hobbits?|halflings?|gamgees?|residents?|farmer|peasantry')],
];

/** Women, when the mud says so. Keywords and short first; see `female()`. */
const FEMALE = W('wom[ae]n|lady|ladies|queens?|princess(es)?|duchess(es)?|countess(es)?|baroness(es)?|girls?|maids?|maidens?|nursemaids?|nurses?|wi(fe|ves)|widows?|mothers?|grandmothers?|granny|grannies|daughters?|sisters?|priestess(es)?|sorceress(es)?|enchantress(es)?|witch(es)?|hags?|crones?|matrons?|madam|madame|lass(es)?|wench(es)?|barmaids?|waitress(es)?|seamstress(es)?|beauty|beauties|nuns?|mistress(es)?|gossips?|females?|abbess|empress|heroine|milkmaids?|housewi(fe|ves)|fishwi(fe|ves)|dame|dames|she-\\w+');
/** "She" in a description, when the keywords are silent. Pronouns only. */
const SHE = /\b(she|her|hers|herself)\b/i;
const HE = /\b(he|him|his|himself)\b/i;

const CHILD = W('child|children|kids?|boys?|girls?|urchins?|lads?|lass(es)?|pupils?|pages?|youngsters?|youths?|babes?|infants?|toddlers?|bab(y|ies)|newborns?|orphans?');
const TODDLER = W('toddlers?|infants?|bab(y|ies)|newborns?|babes?');
/** Halflings are mostly only halflings in their descriptions -- see actors.js. */
const HALFLING = /\b(halflings?|hobbits?)\b/i;
const DWARF = W('dwarf|dwarves|dwarven|dwarfish');
const ELF = W('elf|elves|elven|elvish|drow');
const OLD = W('old|elder|elderly|aged|ancient|grey|gray|venerable|wizened|hag|crone|granny|grandmother|grandfather|grandpa|grandma');

/** What an equipped weapon is, from its own keywords. Order matters: a
 * sword-breaker is a dagger, not a sword. */
const WEAPON_WORDS = [
  ['weapon_dagger', W('daggers?|knife|knives|dirks?|stilettos?|kris|shivs?|sword-breaker|main-gauche|poniard')],
  ['weapon_spear', W('spears?|pikes?|lances?|halberds?|bardiches?|voulges?|guisarmes?|polearms?|tridents?|javelins?|glaives?|partisans?|bills?|pitchforks?|forks?')],
  ['weapon_staff', W('staff|staves|staffs|sticks?|canes?|rods?|quarterstaffs?|wands?|crooks?|walking')],
  ['weapon_axe', W('axes?|hatchets?|cleavers?|tomahawks?|choppers?')],
  ['weapon_mace', W('maces?|clubs?|hammers?|morningstars?|morning|flails?|cudgels?|bludgeons?|mauls?|truncheons?|scepters?|sceptres?|whips?|mallets?|shovels?|spades?|rakes?|hoes?|sickles?|scythes?')],
  ['weapon_sword', W('swords?|blades?|sabres?|sabers?|scimitars?|rapiers?|longswords?|broadswords?|cutlass(es)?|falchions?|katanas?|claymores?|epees?|foils?')],
];

// --- palettes ---------------------------------------------------------------

const SKIN = [0xe2bf9a, 0xd5a67a, 0xc49068, 0xa87650, 0x8a5a38, 0x6d4526, 0xe8c8a8, 0xb98a60];
const HAIR = [0x2a1d14, 0x3b2a1c, 0x4f3622, 0x6b4a2a, 0x8f6d3e, 0x1c1714, 0x7a3a1e, 0x5a4a3a];
const HAIR_OLD = [0x9a968c, 0xb8b4aa, 0x7e7a72, 0xcfcac0];
const EARTH = [0x6b4f3a, 0x5a5a44, 0x4d5a3c, 0x6e5f44, 0x7a6048, 0x55493c, 0x646a58, 0x7c6a52,
  0x5a4636, 0x4c4f55];
const DYED = [0x6b2f2f, 0x2f4a6b, 0x3f5a2f, 0x6b5a2f, 0x4f2f5a, 0x7a4a24, 0x2f5a5a, 0x5a2f44];
const RICH = [0x6b1f2f, 0x1f2f6b, 0x2f4f1f, 0x4a1f5a, 0x7a5a1a, 0x1f4a4a];
const DARK = [0x2a2724, 0x2f3329, 0x33302d, 0x282a2e, 0x3a322a];
const DRAB = [0x5c5347, 0x4f4a3c, 0x625a4a, 0x57524a, 0x4a4238];
const ROBES = {
  priest: [0x6a6152, 0x2d2a26, 0xcfc6b0, 0x7a6a4a, 0x4a4a52],
  druid: [0x3c4a2a, 0x4a5a32, 0x5a5a3a],
  mage: [0x2f2a4a, 0x3a1f3a, 0x1f3a3a, 0x5a1c1c, 0x1f2a4f, 0x2a2a2a],
};
const DRESSES = [0x7a3b3b, 0x3b5a7a, 0x6b6b3b, 0x5a3b6b, 0x8a6a4a, 0x3b6b5a, 0x7a5a6b, 0x6b4a3b];
/** The watch of each town, in its colours. A tabard is a uniform. */
const LIVERY = {
  default: [0x2c3e6e, 0x6e2c2c],
};

// --- choosing ---------------------------------------------------------------

const strHash = (s, salt = 0) => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
};
const pick = (list, seed) => list[Math.floor(seed * list.length) % list.length];

function words(proto) {
  return `${proto.keywords} ${proto.short}`;
}

function female(proto) {
  const w = words(proto);
  if (FEMALE.test(w)) return true;
  // Only when the name is silent: count pronouns in the prose, which is
  // written about the mobile itself. Needs a clear majority, so a man whose
  // description mentions his wife stays a man.
  const prose = `${proto.long || ''} ${proto.description || ''}`;
  const she = (prose.match(new RegExp(SHE.source, 'gi')) || []).length;
  const he = (prose.match(new RegExp(HE.source, 'gi')) || []).length;
  return she >= 2 && she > he * 2;
}

/** Things there is no model for, which leave the archetype's own weapon. */
const UNMODELLED = W('bows?|longbows?|crossbows?|slings?|nets?|blowguns?');

function weaponOf(item) {
  const w = `${item.keywords} ${item.short}`;
  for (const [name, re] of WEAPON_WORDS) if (re.test(w)) return name;
  return UNMODELLED.test(w) ? null : 'weapon_sword';
}

/**
 * Who carries the weapon their resets give them. Stock Merc arms every
 * Midgaard shopkeeper with a long sword -- the baker, the grocer, all four
 * waiters, the mayor, the sorcerer and Filthy the beggar -- as the game's
 * way of making them dangerous to rob, and a baker holding a longsword
 * behind his counter reads as a joke. So the civil trades keep their own
 * things and only the fighting ones take what the mud hands them.
 */
const ARMED = new Set(['guard', 'knight', 'rogue', 'smith', 'troll', 'skeleton', 'zombie']);

/**
 * Everything the viewer needs to dress one mobile.
 *
 * @param proto the mobile prototype, with `equipment` [{proto, wearLoc}] from
 *   its resets and `shop` if it keeps one
 * @param ITEM the item-type table from are.js
 * @returns {{file, arch, scale, headScale, female, weapon, shield, pieces,
 *   tint, sex, kind}} or null for anything that is not a person
 */
/**
 * Not people, and not built like them. Beasts are actors.js's BEASTS; this is
 * the rest the stock areas have that would otherwise be dressed as a
 * peasant -- a dragon in a tunic, a snake in hose. The caller keeps its own
 * figure for these.
 */
const CREATURE = W('beasts?|worms?|snakes?|serpents?|dragons?|drakes?|wyrms?|wyverns?|foxe?s?|deer|stags?|does|wargs?|wolf|wolves|will-o-wisp|wisps?|mounds?|slimes?|oozes?|jell(y|ies)|spiders?|scorpions?|beetles?|ants?|bats?|lizards?|toads?|frogs?|leeches?|eels?|fish|sharks?|crabs?|squids?|octopus|elementals?|golems?|hydras?|basilisks?|cockatrices?|griffons?|gryphons?|manticores?|chimaeras?|unicorns?|pegasus|centipedes?|slugs?|crocodiles?|alligators?|boars?|cows?|bulls?|horses?|pigs?|chickens?|hens?|roosters?|geese|goose|ducks?|ducklings?|swans?|sparrows?|birds?|crows?|ravens?|hawks?|eagles?|owls?|cats?|kittens?|dogs?|puppy|puppies|fido|beagles?|rottweilers?|bears?|rats?|mice|mouse|sheep|goats?|mules?|donkeys?|oxen|ox|calf|calves|lions?|tigers?|panthers?|apes?|monkeys?|gorillas?|' +
  'rabbits?|bunn(y|ies)|chimeras?|rocs?|griffins?|minotaurs?|centaurs?|treants?|trees?|willows?|plants?|weeds|puddings?|blobs?|monsters?|creatures?|snails?|camels?|antelopes?|ewes?|beholders?|mimics?|mists?|mistlings?|horrors?|nightgaunts?|mi-go|fungi|myconoids?|lemures?|maggots?|morkoths?|mudmonsters?|homonculus|effreetis?|efreets?|djinn|does?|wasps?|harp(y|ies)|nagas?|ki-rin|mermaids?|stars?|nebulas?|comets?|supergiants?|flames?|hurricanes?|magneto|dolls?|brooms?|dancing|hands|eyes|quasits?|imps?|yochlols?|driders?|lamias?|dustdiggers?|puff|newts?|shadows?|dervish|daemons?|demons?|devils?|mindflayers?|dustdigger|chreffn|draco|pleiades|polaris|aries|taurus|gemini|cancer|leo|virgo|libra|scorpio|sagittarius|capricon|aquarius|it');

export function personOf(proto, ITEM, instance = 0) {
  const w = words(proto);
  // A lizard man is a man; a "lizard" is a lizard.
  if (CREATURE.test(w) && !/\b(m[ae]n|wom[ae]n|folk)\b/i.test(w)) return null;
  const seed = strHash(proto.keywords, proto.vnum);
  // The trade and the livery come from the prototype; the hair, the beard and
  // the colour of a tunic also from which one of them this is, so the twenty
  // cityguards of Midgaard are not one man twenty times.
  const seed2 = strHash(`${proto.short}#${instance}`, 31);
  const seed3 = strHash(`${proto.keywords}#${instance}`, 57);
  const out = {
    file: 'person_male', arch: 'peasant', kind: 'person', scale: 1, headScale: 1,
    weapon: null, shield: null, pieces: [], tint: {}, sex: 'male',
  };
  const old = OLD.test(w);
  const hair = old ? pick(HAIR_OLD, seed2) : pick(HAIR, seed2);

  // Monsters.
  for (const [kind, re] of MONSTERS) {
    if (!re.test(w)) continue;
    out.kind = kind;
    if (kind === 'troll') {
      out.file = 'troll';
      out.arch = 'troll';
      const k = TROLL_KINDS.find(([r]) => r.test(w));
      const spec = k ? k[1] : { scale: 1.3, skin: 0x5f6e4c };
      out.scale = spec.scale;
      out.tint = { skin: spec.skin, leather: 0x4a3a2a, linen: 0x8a7a5a, hair: 0x2a2418 };
      if (/\b(ogres?|giants?|ettins?|gnolls?|orcs?|hobgoblins?|bugbears?)\b/i.test(w)) out.weapon = 'weapon_mace';
      if (/\b(orcs?|hobgoblins?|goblins?|kobolds?)\b/i.test(w)) out.weapon = pick(['weapon_axe', 'weapon_spear', 'weapon_mace'], seed);
    } else {
      out.arch = kind;
      if (kind === 'skeleton') {
        out.tint = { bone: 0xcfc4a6 };
        if (seed < 0.6) out.weapon = 'weapon_sword';
        if (seed < 0.35) out.shield = 'shield_round';
      } else if (kind === 'zombie') {
        const ghoul = /\bghouls?|ghasts?\b/i.test(w);
        out.tint = { skin: ghoul ? 0x6a7362 : 0x7f8a6c, cloth: pick(DRAB, seed), cloth2: pick(DRAB, seed3), hair: 0x4a4238 };
        out.pieces = seed < 0.5 ? ['hair_fringe'] : ['hair_long'];
      } else {
        out.tint = { skin: 0xb8c4cc, cloth: 0x9fb2c2, cloth2: 0x8a9eb0 };
        out.pieces = ['hood'];
      }
    }
    applyEquipment(out, proto, ITEM, seed);
    return out;
  }

  // People.
  const isFemale = female(proto);
  let arch = null;
  for (const [a, re] of TRADES) if (re.test(w)) { arch = a; break; }
  if (!arch && proto.shop) arch = 'merchant';
  if (!arch) arch = 'peasant';
  // A smith word for a dwarf only makes him stocky, not a smith.
  if (arch === 'smith' && DWARF.test(w) && !/\bsmith|armou?rer\b/i.test(w)) arch = 'guard';
  if (/\b(lumberjacks?|woodcutters?|woodsm[ae]n)\b/i.test(w)) out.weapon = 'weapon_axe';
  if (/\b(executioners?|headsm[ae]n)\b/i.test(w)) arch = 'smith';

  out.tint.skin = pick(SKIN, strHash(proto.keywords, 7));
  out.tint.hair = hair;
  const cloth = pick(EARTH, seed);
  const cloth2 = pick(EARTH, seed3);

  if (isFemale) {
    out.file = 'person_female';
    out.sex = 'female';
    arch = arch === 'merchant' || /\b(maids?|nursemaids?|nurses?|barmaids?|waitress|servants?|cooks?|milkmaids?)\b/i.test(w)
      ? 'maid'
      : (/\b(hags?|crones?|witch(es)?|granny|beggars?)\b/i.test(w) || (old && arch !== 'noble')) ? 'crone' : 'woman';
    out.arch = arch;
    out.tint.cloth = arch === 'crone' ? pick(DRAB, seed) : pick(DRESSES, seed);
    out.tint.cloth2 = pick(EARTH, seed3);
    out.tint.linen = 0xd8cfbc;
    out.pieces = arch === 'maid' ? [pick(['coif', 'hair_bun', 'coif'], seed2)]
      : arch === 'crone' ? [pick(['scarf', 'hood', 'hair_bun'], seed2)]
        : [pick(['hair_long', 'hair_bun', 'scarf', 'hair_long'], seed2)];
    if (/\b(sorceress|witch|enchantress|priestess|nuns?|abbess)\b/i.test(w)) {
      out.pieces = ['hood'];
      out.tint.cloth = pick(/\b(priestess|nuns?|abbess)\b/i.test(w) ? ROBES.priest : ROBES.mage, seed);
      if (/\b(sorceress|witch|enchantress)\b/i.test(w)) out.weapon = 'weapon_staff';
    }
    if (/\b(lady|queen|princess|duchess|countess|baroness|empress|beauty)\b/i.test(w)) {
      out.tint.cloth = pick(RICH, seed);
      out.pieces = ['hair_long'];
    }
  } else {
    out.arch = arch;
    const beard = () => (seed3 < 0.35 ? 'beard_full' : seed3 < 0.55 ? 'beard_short' : seed3 < 0.7 ? 'moustache' : null);
    const hairs = (list) => pick(list, seed2);
    const P = [];
    switch (arch) {
      case 'guard':
        out.tint = { ...out.tint, cloth: pick(LIVERY.default, 0), cloth2: pick(DARK, seed3), leather: 0x3a2a1c };
        P.push(pick(['helm_kettle', 'helm_nasal', 'helm_kettle'], seed2));
        if (!out.weapon) out.weapon = seed < 0.55 ? 'weapon_spear' : 'weapon_sword';
        if (out.weapon === 'weapon_sword' && seed3 < 0.7) out.shield = 'shield_round';
        if (/\b(adventurers?|mercenar(y|ies)|warriors?|fighters?|gladiators?|veterans?)\b/i.test(w)) {
          // Not in anyone's livery.
          out.tint.cloth = pick(DYED, seed);
          P[0] = pick(['helm_nasal', 'hair_short', 'hair_long'], seed2);
          if (out.weapon === 'weapon_spear') out.weapon = pick(['weapon_sword', 'weapon_axe', 'weapon_mace'], seed3);
        }
        if (/\b(trainees?|recruits?|squires?)\b/i.test(w)) { P[0] = hairs(['hair_short', 'hair_crop']); out.shield = null; }
        if (/\b(shiriffs?|sheriffs?)\b/i.test(w)) { P[0] = 'hat_cap'; out.tint.cloth = 0x3f5a2f; }
        break;
      case 'knight':
        out.tint = { ...out.tint, cloth: /\btemplars?\b/i.test(w) ? 0xd8d2c0 : pick(RICH, seed), cloth2: pick(DARK, seed3) };
        P.push(/\btemplars?\b/i.test(w) || seed < 0.5 ? 'helm_great' : 'helm_nasal');
        out.weapon = out.weapon || 'weapon_sword';
        out.shield = 'shield_kite';
        break;
      case 'mage':
        out.tint = { ...out.tint, cloth: pick(ROBES.mage, seed), cloth2: pick(RICH, seed3) };
        P.push(seed2 < 0.55 ? 'hat_wizard' : 'hood');
        if (seed3 < 0.7 || old) P.push('beard_full');
        out.weapon = out.weapon || 'weapon_staff';
        break;
      case 'priest': {
        const druid = /\b(druids?|shamans?)\b/i.test(w);
        out.tint = { ...out.tint, cloth: pick(druid ? ROBES.druid : ROBES.priest, seed), linen: 0xc8bca0 };
        P.push(pick(['hair_fringe', 'hood', 'hair_short', 'hair_fringe'], seed2));
        const b = beard();
        if (b) P.push(b);
        if (druid || /\b(hermits?|pilgrims?|healers?)\b/i.test(w)) out.weapon = out.weapon || 'weapon_staff';
        else if (seed < 0.3) out.weapon = out.weapon || 'weapon_mace';
        break;
      }
      case 'rogue':
        out.tint = { ...out.tint, cloth: pick(DARK, seed), cloth2: pick(DARK, seed3), leather: 0x2e241a };
        P.push(seed2 < 0.7 ? 'hood' : hairs(['hair_short', 'hair_long']));
        if (seed2 >= 0.7) { const b = beard(); if (b) P.push(b); }
        out.weapon = out.weapon || (/\b(executioners?|headsm[ae]n)\b/i.test(w) ? 'weapon_axe' : 'weapon_dagger');
        break;
      case 'beggar':
        out.tint = { ...out.tint, cloth: pick(DRAB, seed), cloth2: pick(DRAB, seed3), linen: 0x7a6e5a };
        P.push(hairs(['hair_long', 'hair_short', 'hair_fringe', 'hair_long']));
        P.push(seed3 < 0.6 ? 'beard_full' : 'beard_short');
        if (seed < 0.4) out.weapon = out.weapon || 'weapon_staff';
        break;
      case 'smith':
        out.tint = { ...out.tint, cloth: pick(EARTH, seed), cloth2: pick(DARK, seed3), leather: 0x4a3322 };
        if (/\b(executioners?|headsm[ae]n)\b/i.test(w)) {
          P.push('hood');
          out.tint.cloth = 0x2b2320;
          out.weapon = 'weapon_axe';
        } else {
          P.push(hairs(['hair_crop', 'hair_fringe', 'hair_short']));
          P.push(seed3 < 0.5 ? 'beard_full' : 'moustache');
          out.weapon = out.weapon || (/\b(weaponsmiths?|armou?rers?|blacksmiths?|smiths?|dwarf|dwarves|dwarven)\b/i.test(w) ? 'weapon_mace' : null);
        }
        break;
      case 'noble':
        out.tint = { ...out.tint, cloth: pick(RICH, seed), cloth2: pick(RICH, seed3), leather: 0x2e2218 };
        P.push(hairs(['hair_short', 'hair_long', 'hair_short']));
        if (seed3 < 0.4) P.push('hat_cap');
        { const b = beard(); if (b) P.push(b); }
        break;
      case 'merchant':
        out.tint = { ...out.tint, cloth: pick(DYED, seed), cloth2: pick(EARTH, seed3), linen: 0xd8cdb4 };
        P.push(hairs(['hair_short', 'hair_crop', 'hair_fringe', 'hair_short']));
        if (seed < 0.25) P.push('hat_cap');
        { const b = beard(); if (b) P.push(b); }
        break;
      default: // peasant
        out.tint = { ...out.tint, cloth, cloth2, leather: 0x4a3524 };
        P.push(hairs(['hair_short', 'hair_crop', 'hair_long', 'hair_short']));
        if (seed < 0.3) P.push(seed < 0.15 ? 'hat_cap' : 'coif');
        { const b = beard(); if (b) P.push(b); }
    }
    out.pieces = P;
  }

  // Size. A word for how old someone is is a word for how tall they are.
  const prose = `${w} ${proto.long || ''} ${proto.description || ''}`;
  if (TODDLER.test(w)) { out.scale = 0.50; out.headScale = 1.32; }
  else if (CHILD.test(w) && !/\b(youths?)\b/i.test(w)) { out.scale = 0.66; out.headScale = 1.18; }
  else if (/\b(youths?)\b/i.test(w)) { out.scale = 0.88; out.headScale = 1.05; }
  if (/\b(brownies?|pixies?|sprites?|leprechauns?|gnomes?)\b/i.test(w)) { out.scale = 0.5; out.headScale = 1.2; }
  // Smurfs are three apples high, blue, and wear a white cap; the mud says the first two.
  if (/\bsmurfs?\b/i.test(w)) { out.scale = 0.32; out.headScale = 1.45; out.tint.skin = 0x6a9ad8; out.tint.cloth = 0xe8e4dc; out.tint.cloth2 = 0xe8e4dc; out.pieces = /papa/i.test(w) ? ['hat_cap', 'beard_full'] : ['hat_cap']; }
  if (DWARF.test(w)) { out.scale = 0.74; out.headScale = 1.1; if (out.sex === 'male') out.pieces = [...out.pieces.filter((p) => !p.startsWith('beard') && p !== 'moustache'), 'beard_full']; }
  if (ELF.test(w)) { out.scale = 1.03; out.pieces = out.pieces.filter((p) => !p.startsWith('beard') && p !== 'moustache'); }
  // Last, so nothing above can put a halfling back at a man's height; it
  // reads the prose on purpose, because the Shire mostly only says so there.
  if (HALFLING.test(prose)) { out.scale = Math.min(out.scale, 1) * 0.6; out.headScale = Math.max(out.headScale, 1.1); }
  if (out.scale < 0.9) out.pieces = out.pieces.filter((p) => !p.startsWith('beard') && p !== 'moustache' || DWARF.test(w));
  applyEquipment(out, proto, ITEM, seed);
  return out;
}

function applyEquipment(out, proto, ITEM, seed) {
  for (const item of proto.equipment || []) {
    if (ITEM && item.proto.itemType === ITEM.WEAPON && ARMED.has(out.arch)) {
      out.weapon = weaponOf(item.proto) || out.weapon;
    }
    if (item.wearLoc === 11) out.shield = out.arch === 'knight' ? 'shield_kite' : (out.shield || 'shield_round');
  }
  // A staff or a spear is held in both hands' worth of arm; nobody carries a
  // shield with a staff.
  if (out.weapon === 'weapon_staff') out.shield = null;
  // Someone the size of a toddler carries nothing.
  if (out.scale < 0.55) { out.weapon = null; out.shield = null; }
}

/** The arm poses a carried thing needs in the standing and walking clips. */
export function carryOf(person) {
  const right = !person.weapon ? null
    : (person.weapon === 'weapon_spear' || person.weapon === 'weapon_staff') ? 'carry_pole' : 'carry_blade';
  return { right, left: person.shield ? 'carry_shield' : null };
}
