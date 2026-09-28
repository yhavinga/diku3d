/**
 * What a walled room is built as, read from its own words.
 *
 * Every room with walls used to come out as the same box -- the stone kit, or
 * plaster and boards -- whatever it said it was. The prose is a construction
 * drawing: "You are in a natural cave", "a dark burial chamber beneath a large
 * tomb stone", "The cafe is built from large logs", "You can see burned walls,
 * the floorstones are fiery red", "Dark smoke-stained stones arch over". The
 * name says it more often than the description does, and the sector code says
 * it almost never (the tombs are CITY), so the words decide and the sector is
 * not consulted at all.
 *
 * Pure -- no three.js -- so tools/shell-check.mjs can run the vocabulary over
 * all 45 stock areas in node. Every word here was kept or dropped by that
 * count; the NOT lists are as load-bearing as the matches.
 *
 * Kinds:
 *  - `cave`: bare rock somebody found rather than built. `vast` when the prose
 *    says the walls are out of sight.
 *  - `tomb`: a burial chamber -- a low stone vault, niches in the walls.
 *  - `vault`: a stone room that the prose says is arched: a laboratory, a
 *    cellar, a crypt-like hall that nobody is buried in.
 *  - `dungeon`: a jail, a cell, a torture chamber. Damp stone, iron in it.
 *  - `lair`: a room something has burned out -- scorched walls, a floor hot
 *    enough to glow.
 *  - `log`: a room the prose says is built of logs.
 *  - `panelled`: an office, a waiting room, a council chamber -- the town's
 *    civic rooms, panelled to the dado and plastered above it.
 *  - `well`: a room built round a well shaft.
 *  - `farmhouse`, `inn`: the Shire's two other kinds of house besides a smial,
 *    which build.js already reads for itself by name.
 *  - `smial`: only ever inherited -- Bag End's "Bedroom" and "Pantry" are the
 *    rooms of a hole in a hill, and say so only by the door they share with it.
 */

// A cave named as one, or one the prose says is natural. `cave` alone in the
// description is not enough: "the cave entrance is to the north" is a room
// that can see one. Named `den` and `grotto` are left to build.js's ROCK_CAVE,
// which already dresses them in rock.
const CAVE_NAME = /\b(caves?|cavern|caverns|grotto)\b/i;
const CAVE_PROSE = /\b(natural cave|in a (?:big |small |large )?(?:natural )?cave|cave-like|inside (?:the|a) cave|small cavern|large cave|big natural cave)\b/i;
// "Outside a cave", "Cave entrance" with the sky over it, "the cave mouth" are
// rooms at a cave, and the web-cave of Haon Dor is made of web, not rock.
const CAVE_NOT = /\b(outside|entrance to the|before the|web|mouth)\b/i;
/** "The walls and ceiling seem miles away." */
const VAST = /\b(miles away|overwhelms you|enormous cavern|huge cavern|vast cavern|immense cavern|giant cave|very large cavern|ceiling (?:is )?(?:lost|far) (?:in|above))\b/i;

const TOMB = /\b(tombs?|crypts?|burial chamber|sepulchre|mausoleum|catacombs?|ossuary|barrow)\b/i;
// A tomb in the name of a street, a yard or a gate is outside one.
const TOMB_NOT = /\b(road|street|path|gate|yard|entrance|outside|before|graveyard|garden|hill)\b/i;

const VAULT = /\b(laborator(?:y|ies)|alchemist|cellars?|wine cellar|undercroft|vaulted|stones arch over|arched (?:stone )?ceiling|vaulted ceiling)\b/i;

const DUNGEON = /\b(jail|gaol|prison|dungeons?|cell ?block|torture ?room|torture chamber|tortureroom|oubliette|holding cell)\b/i;
// "the jail is to the north" is a guard room; a name decides first.
const DUNGEON_PROSE = /\b(rusty chains|in chains|shackles|manacles|damp and humid jail|dark and humid jail)\b/i;

const SCORCHED = /\b(burned walls|burnt walls|scorched|charred walls|fiery red|walls are blackened|burned room|burnt room)\b/i;

const LOGS = /\b(built (?:from|of) (?:large |heavy |huge |rough )?logs|made (?:entirely )?(?:from|of) (?:heavy |large |huge |rough )?logs|log cabin|log house|log walls)\b/i;

const CIVIC = /\b(office|waiting room|town hall|reception|head ?quarters|council|court ?room|study|library|archives?|guild ?hall|audience chamber)\b/i;
// A "post office" in some area is a shop; "reception" at the Grunting Boar is
// defunct and dusty but still a reception. Rooms named for a street keep out.
const CIVIC_NOT = /\b(street|road|lane|square|yard|shop|store)\b/i;

const WELL = /\bold well\b|\bwell house\b|\bwellhouse\b/i;

const FARM = /\b(gamgee|farm(?:house|stead)?|cottage|homestead)\b/i;
const INN = /\b(inn|tavern|pub|alehouse|green dragon|ivy bush)\b/i;

export const SHELL_KINDS = ['cave', 'tomb', 'vault', 'dungeon', 'lair', 'log', 'panelled', 'well', 'farmhouse', 'inn', 'smial'];

/**
 * The shell a walled room is built as, or null for the ordinary one. Only
 * asked of rooms that have walls; open ground never gets here.
 */
export function shellOf(room) {
  const name = room.name || '';
  const text = (room.description || '').replace(/\s+/g, ' ');
  const both = `${name} ${text}`;
  const vast = VAST.test(both);

  if (SCORCHED.test(both) && !/\b(fireplace|hearth|forge|kitchen)\b/i.test(name)) return { kind: 'lair' };
  if (TOMB.test(name) && !TOMB_NOT.test(name)) return { kind: 'tomb' };
  if (/\bburial chamber\b/i.test(text)) return { kind: 'tomb' };
  if (DUNGEON.test(name) || (DUNGEON_PROSE.test(text) && !CIVIC.test(name))) return { kind: 'dungeon' };
  if ((CAVE_NAME.test(name) && !CAVE_NOT.test(name)) || CAVE_PROSE.test(text)) {
    if (!/\bweb\b/i.test(both)) return { kind: 'cave', vast };
  }
  if (LOGS.test(text) || /\blog cabin\b/i.test(name)) return { kind: 'log' };
  if (WELL.test(name)) return { kind: 'well' };
  if (VAULT.test(name) || /\b(stones arch over|vaulted ceiling|arched ceiling)\b/i.test(text)) return { kind: 'vault' };
  if (room.areaFile === 'shire.are') {
    if (FARM.test(name)) return { kind: 'farmhouse' };
    if (INN.test(name)) return { kind: 'inn' };
  }
  if (CIVIC.test(name) && !CIVIC_NOT.test(name)) return { kind: 'panelled' };
  return null;
}

const SMIAL = /\b(smial|bag ?end|halfling hole)\b/i;
const shells = new WeakMap();

/**
 * Every walled room's shell, once per world, with the one thing a room cannot
 * say about itself: the Shire's back rooms are dug into the same hill as the
 * smial whose door they open off, so a room with no words of its own next to
 * one is part of it. `walled` is build.js's own answer to "has this walls".
 */
export function classifyShells(world, walled) {
  for (const room of world.rooms.values()) {
    if (!walled(room)) { shells.set(room, null); continue; }
    shells.set(room, shellOf(room));
  }
  for (const room of world.rooms.values()) {
    if (room.areaFile !== 'shire.are' || shells.get(room) || !walled(room) || SMIAL.test(room.name)) continue;
    if (/\b(tunnel|intersection|post|office|store|shop|inn|mill)\b/i.test(room.name)) continue;
    const next = room.exits.filter(Boolean).map((e) => world.rooms.get(e.to)).filter(Boolean);
    if (next.some((r) => SMIAL.test(r.name) && walled(r))) shells.set(room, { kind: 'smial' });
  }
}

/** The shell `classifyShells` chose, or what the room says if it was never asked. */
export const shellFor = (room) => (shells.has(room) ? shells.get(room) : shellOf(room));
