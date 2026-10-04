/**
 * What the game knows about a place, turned into which clips to play. This is
 * the one table: ambience beds, room music, per-area music and footstep
 * surfaces all live here, as data, so nothing in the audio code names a clip.
 *
 * A `place` is plain data, so the rules run in node as well (tools/audio):
 *   { vnum, areaFile, sector, name, flags, outdoor, openAir, floor, cave, mobs, hour }
 * `outdoor` is build.js's `isOutdoor` (no INDOORS flag, a sky sector); `openAir`
 * is its geometry's answer, which also counts a forest canopy as open.
 *
 * Words are matched on the room *name*, never the description: a description
 * that mentions the tavern next door is not a tavern (the same rule build.js
 * learned for bogs and chapels).
 */

// Sector numbers from are.js, repeated so this file has no imports.
const S = { INSIDE: 0, CITY: 1, FIELD: 2, FOREST: 3, HILLS: 4, MOUNTAIN: 5, SHALLOW: 6, DEEP: 7, AIR: 9, DESERT: 10 };
const INDOORS = 8;

// ---------------------------------------------------------------- footsteps --

/** build.js floor material -> the surface a footstep clip is recorded on. */
export const SURFACE = {
  cobble: 'stone', brokencobble: 'stone', flagstone: 'stone', marble: 'stone', rock: 'stone',
  cliff: 'stone', cavefloor: 'stone', sewerflag: 'stone',
  planks: 'wood',
  dirt: 'dirt', wasteground: 'dirt', ash: 'dirt',
  grass: 'grass',
  duff: 'litter',
  sand: 'sand',
  peat: 'mud', sludge: 'mud',
  water: 'water',
  // 'cloud' (the air rooms) is deliberately absent: nobody walks there.
};

// ---------------------------------------------------------------- one-shots --

/**
 * Name -> the clips a call can draw from (a sheet is cut into variants, see
 * tools/audio/generate.mjs; several sheets are one pool), and how loud. audio.js
 * keeps its synthesised sound for each of these as what plays until the clip has
 * loaded. Gains are against a footstep clip, which plays at 0.55: every clip here
 * is peak-normalised, so the gain is also how loud the thing is meant to be.
 */
export const SOUNDS = {
  hit_flesh: { clips: ['cmb_hit_flesh', 'cmb_hit_flesh_b'], gain: 1 },
  hit_stab: { clips: ['cmb_hit_stab'], gain: 1 },
  hit_claw: { clips: ['cmb_hit_claw'], gain: 1 },
  hit_blunt: { clips: ['cmb_hit_blunt', 'cmb_hit_blunt_b'], gain: 1 },
  hit_armour: { clips: ['cmb_hit_armour'], gain: 0.9 },
  parry: { clips: ['cmb_parry', 'cmb_parry_b'], gain: 0.8 },
  swing: { clips: ['cmb_swing', 'cmb_swing_b'], gain: 0.55 },
  dodge: { clips: ['cmb_dodge'], gain: 0.7 },
  death_human: { clips: ['cmb_death_human', 'cmb_death_human_b'], gain: 0.8 },
  death_beast: { clips: ['cmb_death_beast'], gain: 0.8 },
  death_small: { clips: ['cmb_death_small'], gain: 0.7 },
  bodyfall: { clips: ['cmb_bodyfall'], gain: 0.9 },
  pain: { clips: ['cmb_pain'], gain: 0.7 },
  levelup: { clips: ['ui_levelup'], gain: 0.55 },
  door_open: { clips: ['dr_open', 'dr_open_b'], gain: 0.8 },
  door_close: { clips: ['dr_close', 'dr_close_b'], gain: 0.8 },
  lock: { clips: ['dr_unlock'], gain: 0.7 },
  lockpick: { clips: ['dr_lockpick'], gain: 0.7 },
  coins: { clips: ['sv_coins', 'sv_coins_b'], gain: 0.6 },
  pickup: { clips: ['sv_pickup'], gain: 0.8 },
  drop: { clips: ['sv_drop'], gain: 0.9 },
  eat: { clips: ['sv_eat'], gain: 0.7 },
  drink: { clips: ['sv_drink'], gain: 0.8 },
  fill: { clips: ['sv_fill'], gain: 0.7 },
  shopbell: { clips: ['sv_shopbell'], gain: 0.5 },
  page: { clips: ['ui_page'], gain: 0.6 },
  bell: { clips: ['bell_toll_a', 'bell_toll_b'], gain: 0.5 },
  thunder: { clips: ['wx_thunder', 'wx_thunder_b'], gain: 0.9 },
  spell_gather: { clips: ['sp_gather'], gain: 0.6 },
  spell_missile: { clips: ['sp_missile'], gain: 0.6 },
  spell_fire: { clips: ['sp_fire'], gain: 0.8 },
  spell_lightning: { clips: ['sp_lightning'], gain: 0.8 },
  spell_frost: { clips: ['sp_frost'], gain: 0.6 },
  spell_acid: { clips: ['sp_acid'], gain: 0.6 },
  spell_heal: { clips: ['sp_heal'], gain: 0.55 },
  spell_dark: { clips: ['sp_dark'], gain: 0.6 },
  spell_rumble: { clips: ['sp_rumble'], gain: 0.9 },
  spell_pop: { clips: ['sp_pop'], gain: 0.6 },
  spell_fizzle: { clips: ['sp_fizzle'], gain: 0.5 },
  spell_prism: { clips: ['sp_prism'], gain: 0.55 },
  spell_portal: { clips: ['sp_portal'], gain: 0.6 },
  spell_roar: { clips: ['cr_dragon'], gain: 0.8 },
};

/**
 * Sounds loaded as soon as the game begins, in this order, one after another: all
 * of them are heard often enough that a first blow or first fireball must not be a
 * synth. Only thunder waits for a storm, and creatures for someone to be near.
 */
export const PRELOAD = Object.keys(SOUNDS).filter((name) => name !== 'thunder');

// ----------------------------------------------------------------- creatures --

/**
 * Which mobiles have a voice, matched on keywords and short description (the
 * words a builder wrote for what it is, unlike a room name there is no
 * neighbouring prose to mistake it for). First match wins.
 *   idle   clips for a call now and then while it is within `reach` metres
 *   fight  clips while it is fighting; `death` the sound it makes dying
 *   night  only after dark; `rate` pitch range (a lizard is a small snake)
 * Silent on purpose: rabbits, worms, slimes, fish.
 */
export const CREATURES = [
  { id: 'baby dragon', re: /\b(hatchling|baby|young|pet|fairy)\b.*\bdragon\b|\bdragon\b.*\b(hatchling|baby|pet)\b/, idle: ['cr_cat'], rate: [1.5, 1.8], gain: 0.5, every: [14, 40], reach: 12, death: 'death_small' },
  { id: 'dragon', re: /\b(dragon|wyrm|wyvern|hydra)\b/, idle: ['cr_dragon'], fight: ['cr_dragon'], gain: 0.8, every: [30, 80], reach: 30, death: 'death_beast' },
  { id: 'spider', re: /\b(spider|arachnos|arachnid|tarantula)\b/, idle: ['cr_spider'], fight: ['cr_spider'], gain: 0.55, every: [15, 50], reach: 14, death: 'death_small' },
  { id: 'wolf', re: /\b(wolf|wolves|werewolf|wargs?)\b/, idle: ['cr_wolf'], night: true, fight: ['cr_dog_growl'], gain: 0.7, every: [25, 70], reach: 45, rate: [0.9, 1.05], death: 'death_beast' },
  { id: 'dog', re: /\b(dog|hound|fido|beagle|cooshee|pit ?bull|puppy|rottweiler|doberman|mastiff)\b/, idle: ['cr_dog'], fight: ['cr_dog_growl', 'cr_dog'], gain: 0.7, every: [12, 40], reach: 20, death: 'death_beast' },
  { id: 'fox', re: /\b(fox|jackal|coyote)\b/, idle: ['cr_dog'], fight: ['cr_dog_growl'], rate: [1.35, 1.5], gain: 0.5, every: [20, 60], reach: 14, death: 'death_small' },
  { id: 'cat', re: /\b(cat|kitten|familiar|panther|lion|tiger|cougar|leopard)\b/, idle: ['cr_cat'], fight: ['cr_dog_growl'], gain: 0.6, every: [15, 45], reach: 12, death: 'death_small' },
  { id: 'bear', re: /\b(bear|ursa)\b(?!.*\bteddy)/, idle: ['cr_bear'], fight: ['cr_bear'], gain: 0.8, every: [20, 60], reach: 22, death: 'death_beast' },
  // A centaur is a man from the waist: only now and then the horse in him.
  { id: 'centaur', re: /\bcentaurs?\b/, idle: ['cr_horse'], rate: [0.92, 1.0], gain: 0.5, every: [40, 120], reach: 22, death: 'death_beast' },
  // A lion's growl in a lamia's throat; no meow.
  // No harpy's cry was recorded: a bat's screech, slowed, until one is.
  { id: 'harpy', re: /\bharp(y|ies)\b/, idle: ['cr_bat'], fight: ['cr_bat'], rate: [0.5, 0.6], gain: 0.6, every: [15, 45], reach: 18, death: 'death_small' },
  // A golem has no breath to make a sound with: silent but for its blows.
  { id: 'minotaur', re: /\bminotaurs?\b/, idle: ['cr_cow'], fight: ['cr_beast'], rate: [0.62, 0.72], gain: 0.6, every: [30, 90], reach: 18, death: 'death_beast' },
  { id: 'golem', re: /\bgolems?\b/, idle: [], gain: 0.7, every: [60, 120], reach: 16, death: 'death_beast' },
  { id: 'lamia', re: /\blamias?\b/, idle: [], fight: ['cr_dog_growl'], rate: [0.72, 0.82], gain: 0.6, every: [20, 60], reach: 14, death: 'death_beast' },
  { id: 'horse', re: /\b(horse|pegasus|pony|mule|donkey|stallion|mare|unicorn)\b/, idle: ['cr_horse'], gain: 0.7, every: [15, 50], reach: 22, death: 'death_beast' },
  { id: 'deer', re: /\b(deer|stag|antelope|elk|moose|doe|fawn)\b/, idle: ['cr_deer'], gain: 0.55, every: [30, 90], reach: 30, death: 'death_beast' },
  { id: 'goat', re: /\b(goat|sheep|ram|lamb|ewe|mountain kid)\b/, idle: ['cr_goat'], gain: 0.6, every: [12, 40], reach: 18, death: 'death_beast' },
  { id: 'cow', re: /\b(cow|bull|ox|oxen|cattle|calf)\b/, idle: ['cr_cow'], gain: 0.7, every: [15, 50], reach: 22, death: 'death_beast' },
  { id: 'pig', re: /\b(pig|boar|sow|hog|swine)\b/, idle: ['cr_pig'], fight: ['cr_pig'], gain: 0.65, every: [12, 40], reach: 18, death: 'death_beast' },
  { id: 'chicken', re: /\b(chicken|hen|rooster|cock|chick)\b/, idle: ['cr_chicken'], gain: 0.55, every: [10, 35], reach: 16, death: 'death_small' },
  { id: 'snake', re: /\b(snake|python|anaconda|serpent|viper|cobra|adder)\b/, idle: ['cr_snake'], fight: ['cr_snake'], gain: 0.55, every: [15, 45], reach: 10, death: 'death_small' },
  { id: 'lizard', re: /\b(lizard|newt|gecko|salamander|basilisk)\b/, idle: ['cr_snake'], fight: ['cr_snake'], rate: [1.25, 1.45], gain: 0.5, every: [15, 45], reach: 10, death: 'death_small' },
  { id: 'bat', re: /\b(bat)\b/, idle: ['cr_bat'], fight: ['cr_bat'], gain: 0.55, every: [12, 35], reach: 14, death: 'death_small' },
  { id: 'rat', re: /\b(rat|wererat|mouse|mice|rodent|morkoth)\b/, idle: ['cr_rat'], fight: ['cr_rat'], gain: 0.55, every: [10, 35], reach: 12, death: 'death_small' },
  { id: 'frog', re: /\b(frog|toad)\b/, idle: ['cr_frog'], gain: 0.5, every: [8, 25], reach: 14, death: 'death_small' },
  { id: 'beast', re: /\b(beast|ghoul|zombie|troll|ogre|minotaur|wraith|demon|fiend|gargoyle|golem|treant|mud ?monster|mound|swamp thing)\b/, idle: [], fight: ['cr_beast'], gain: 0.7, every: [20, 60], reach: 16, death: 'death_beast' },
];

// A "dragon master" or a "minotaur butler" is a person: no voice but a person's.
const PERSON = /\b(master|attendant|keeper|butler|citizen|villager|mage|cleric|priest|shaman|sergeant|general|leader|captain|herald|knight|lord|slave|servant|guard|gatekeeper|chieftain|paladin|druid|ranger|thief|teddy|ettin|maker|gang)\b/;
const creatureCache = new Map();
/** The voice rule for a mobile's words, or null. Cached on the words. */
export function creatureOf(words) {
  const key = (words || '').toLowerCase();
  // A minotaur is a person with a bull's throat: its bellow, whatever its trade.
  if (!creatureCache.has(key)) creatureCache.set(key, (PERSON.test(key) && !/\bminotaurs?\b/.test(key) ? null : CREATURES.find((c) => c.re.test(key))) || null);
  return creatureCache.get(key);
}

// ------------------------------------------------------------ positional --

/**
 * Sounds that sit on a thing in the room and are panned from it. `reach` is how
 * far off they are heard; a room names its hearth or its forge in its prose
 * (build.js reads the same words to put one there), and the name is checked
 * first because a description may mention the smithy next door.
 */
export const PLACE_LOOPS = {
  fountain: { clip: 'pos_fountain', reach: 22, gain: 1.0 },
  fire: { clip: 'pos_fire', reach: 11, gain: 0.8 },
  forge: { clip: 'pos_forge', reach: 16, gain: 0.9 },
};

const FIRE = /\b(fireplace|hearth|campfire|bonfire|brazier)\b/i;
const FORGE = /\b(forge|smithy|anvil|blacksmith|furnace)\b/i;
// build.js puts a forge in a weapon shop; the name alone says so.
const FORGE_NAME = /\b(forge|smithy|blacksmith|weapon ?shop|house of arms)\b/i;
const WALL = /\b(north|south|east|west)(?:ern)?\s+(?:wall|side|end)\b/i;
const TOWARD = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

/**
 * `{ kind, dx, dz }` for a room that has a fire or a forge in it (dx/dz: metres
 * from the room's centre, towards the wall the prose names, else the middle,
 * which is where the player arrives -- so offset a little anyway). Indoors only:
 * an outdoor "forge" in a field is a name.
 */
export function placeLoopOf(room, openAir) {
  if (openAir) return null;
  const text = `${room.name}. ${room.description || ''}`;
  const forge = FORGE_NAME.test(room.name) || (FORGE.test(room.description || '') && /\b(hammer|bellows|iron)\b/i.test(room.description || ''));
  const fire = FIRE.test(text);
  if (!forge && !fire) return null;
  const kind = forge ? 'forge' : 'fire';
  // The wall named closest after the word, as build.js's fitting reader takes it.
  const hit = (forge ? FORGE : FIRE).exec(text);
  const after = hit ? WALL.exec(text.slice(hit.index, hit.index + 140)) : null;
  const [ux, uz] = after ? TOWARD[after[1].toLowerCase()] : [0.7, 0.7];
  return { kind, dx: ux * 3.4, dz: uz * 3.4 };
}

// ------------------------------------------------------------------ ambience --

const has = (re) => (p) => re.test(p.name);
const inAreas = (...files) => (p) => files.includes(p.areaFile);

const UNDERGROUND_AREAS = ['moria.are', 'catacomb.are', 'chapel.are', 'dwarven.are', 'drow.are', 'sewer.are', 'grave.are'];
const CASTLE_AREAS = ['mahntor.are', 'draconia.are', 'wyvern.are', 'hitower.are', 'juargan.are', 'thalos.are', 'mirror.are'];

const BOG = /\b(bogs?|marsh(?:es|y)?|swamps?|swampy|mire|fen|quagmire|morass|oozing|peat)\b/i;
const WATERY = /\b(lakes?|rivers?|shore|beach|ponds?|streams?|sea|coast|banks?|brook)\b/i;
const TAVERN = /\b(taverns?|inn|pub|taproom|alehouse|ale|bar|boar|saloon|bard'?s)\b/i;
const TEMPLE = /\b(temples?|chapel|church|altar|shrine|cathedral|sanctum|sanctuary|monastery|abbey|cloister)\b/i;
const MARKET = /\b(market|bazaar|marketplace)\b/i;
const HALL = /\b(hall|throne|keep|castle|armou?ry|barracks|guardroom|dining|great|library|vault|dungeon|gatehouse)\b/i;
const CAVE = /\b(caves?|caverns?|catacombs?|crypts?|tombs?|tunnels?|mines?|grotto|underground|dungeon|passage|sewer|drain)\b/i;

/**
 * First matching rule wins. `beds` are layered (all play, each at its own
 * start offset) so a two-variant bed never repeats in step with itself.
 * `night` swaps beds after dark; `gain` is relative to the normalised clip.
 */
export const AMBIENCE = [
  { id: 'sewer', when: (p) => p.areaFile === 'sewer.are' || /sewer/i.test(p.name) || p.floor === 'sludge' || p.floor === 'sewerflag', beds: ['amb_sewer'] },
  { id: 'temple', when: (p) => !p.openAir && TEMPLE.test(p.name), beds: ['amb_temple'] },
  { id: 'cave', when: (p) => !p.openAir && (p.cave || CAVE.test(p.name) || (inAreas(...UNDERGROUND_AREAS)(p) && !p.outdoor)), beds: ['amb_cave', 'amb_cave_b'], gain: 0.9 },
  { id: 'shallows', when: (p) => p.sector === S.SHALLOW, beds: ['amb_water', 'amb_shore'], gain: 0.8 },
  { id: 'shore', when: (p) => p.sector === S.DEEP || (p.openAir && WATERY.test(p.name)), beds: ['amb_shore'] },
  { id: 'tavern', when: (p) => !p.openAir && TAVERN.test(p.name), beds: ['amb_tavern', 'amb_tavern_b'] },
  { id: 'market', when: (p) => p.openAir && p.sector === S.CITY && MARKET.test(p.name), beds: ['amb_market', 'amb_town_day_b'], night: ['amb_town_night'], gain: 0.9 },
  { id: 'hall', when: (p) => !p.openAir && (HALL.test(p.name) || inAreas(...CASTLE_AREAS)(p)), beds: ['amb_castle'] },
  { id: 'marsh', when: (p) => p.openAir && (p.areaFile === 'marsh.are' || p.floor === 'peat' || BOG.test(p.name)), beds: ['amb_marsh', 'amb_marsh_b'] },
  { id: 'desert', when: (p) => p.openAir && (p.sector === S.DESERT || p.areaFile === 'eastern.are'), beds: ['amb_desert'] },
  { id: 'mountain', when: (p) => p.openAir && p.sector === S.MOUNTAIN, beds: ['amb_mountain'] },
  { id: 'deep wood', when: (p) => p.sector === S.FOREST && !p.outdoor && p.openAir, beds: ['amb_forest_deep'] },
  { id: 'forest', when: (p) => p.openAir && p.sector === S.FOREST, beds: ['amb_forest', 'amb_forest_b'] },
  { id: 'fields', when: (p) => p.openAir && (p.sector === S.FIELD || p.sector === S.HILLS), beds: ['amb_fields', 'amb_fields_b'] },
  { id: 'street', when: (p) => p.openAir && p.sector === S.CITY, beds: ['amb_town_day', 'amb_town_day_b'], night: ['amb_town_night'] },
  { id: 'air', when: (p) => p.sector === S.AIR, beds: ['amb_mountain'], gain: 0.7 },
  { id: 'house', when: (p) => !p.openAir, beds: ['amb_house'] },
  { id: 'open', when: () => true, beds: ['amb_fields'], gain: 0.7 },
];

export function ambienceFor(place) {
  const rule = AMBIENCE.find((r) => r.when(place));
  const night = place.hour === 'night' && rule.night;
  return { rule: rule.id, beds: night || rule.beds, gain: rule.gain ?? 1 };
}

// --------------------------------------------------------------------- music --

const hasBard = (p) => /\bbard'?s?\b/i.test(p.name) || (p.mobs || []).some((k) => /\b(bard|minstrel|musician)\b/i.test(k));

/**
 * Music that belongs to a room and plays while you are in it. First match
 * wins; a rule with several `clips` takes them in turn. `idle` is the quiet
 * between pieces in seconds -- music in a tavern is not constant either.
 */
export const ROOM_MUSIC = [
  { id: 'bard', when: hasBard, clips: ['music_bard'], idle: [60, 150] },
  { id: 'temple', when: (p) => !p.openAir && TEMPLE.test(p.name), clips: ['music_temple'], idle: [90, 200] },
  { id: 'tavern', when: (p) => !p.openAir && TAVERN.test(p.name), clips: ['music_tavern_a', 'music_tavern_b'], idle: [45, 120] },
];

export function roomMusicFor(place) {
  return ROOM_MUSIC.find((r) => r.when(place)) || null;
}

/** .are file -> the piece that suits it, for the occasional piece in play. */
const AREA_MUSIC = {
  town: ['midgaard.are', 'hood.are', 'midennir.are', 'ofcol.are', 'ofcol2.are', 'school.are', 'redferne.are', 'daycare.are', 'thalos.are', 'mirror.are'],
  wild: ['shire.are', 'plains.are', 'valley.are', 'grove.are', 'haon.are', 'smurf.are', 'gnome.are', 'olympus.are', 'dylan.are'],
  marsh: ['marsh.are', 'grave.are', 'trollden.are', 'arachnos.are', 'firenewt.are'],
  underground: ['sewer.are', 'catacomb.are', 'chapel.are', 'moria.are', 'dwarven.are', 'drow.are'],
  castle: ['mahntor.are', 'draconia.are', 'wyvern.are', 'hitower.are', 'juargan.are'],
  desert: ['eastern.are', 'canyon.are'],
  // air, dream, galaxy, mega1, limbo, mobfact, help, proto: no medieval music fits them.
};
const AREA_CLIP = {
  town: 'music_area_town', wild: 'music_area_wild', marsh: 'music_area_marsh',
  underground: 'music_area_underground', castle: 'music_area_castle', desert: 'music_area_desert',
};

export function areaMusicFor(place) {
  let kind = Object.keys(AREA_MUSIC).find((k) => AREA_MUSIC[k].includes(place.areaFile));
  // Mountains read as mountains whatever area they are in.
  if (place.openAir && place.sector === S.MOUNTAIN && kind !== 'desert') return 'music_area_mountain';
  if (kind && kind !== 'underground' && (place.cave || (!place.openAir && CAVE.test(place.name)))) kind = 'underground';
  return kind ? AREA_CLIP[kind] : null;
}

export const TITLE_MUSIC = 'music_title';

/** The shape `Audio.setPlace` builds from build.js's room record. */
export function placeOf(info, hour) {
  const room = info.room;
  return {
    vnum: room.vnum,
    areaFile: room.areaFile,
    sector: room.sector,
    name: room.name,
    flags: room.flags,
    indoorsFlag: !!(room.flags & INDOORS),
    outdoor: !!info.outdoor,
    openAir: info.openAir ?? !!info.outdoor,
    floor: info.materials && info.materials.floor,
    cave: !!(info.materials && info.materials.cave),
    mobs: (room.mobs || []).map((m) => (m.proto && m.proto.keywords) || ''),
    hour,
  };
}
