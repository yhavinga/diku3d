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
