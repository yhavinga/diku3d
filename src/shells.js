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

// -------------------------------------------------------------- attributes ----

/**
 * What a room says its shell is made of, beyond the kind: the shape of its
 * plan, what its walls, floor and ceiling are and what colour, what its doors
 * are, how deep the water in it is, what is on its walls. "You are in a
 * octagonal room with smooth purple stone walls. The floor is made from black
 * stone. In the western wall you see a large black stone door." Each clause is
 * a construction note, and the room used to be square red brick with a pine
 * door.
 *
 * Same rules as the kinds: pure, read from the room's own sentences, and every
 * word kept by what it takes across the 45 areas (tools/shell-check.mjs
 * --attrs). A material word counts only when it is *the surface's* -- "smooth
 * purple stone walls", "the floor is made from black stone" -- never an
 * object's that happens to be near one: "a marble throne carved into the
 * wall", "golden tapestries drape the walls", "the purple robe".
 *
 * Returns null for a room that says nothing, else
 *   { plan, wall, floor, ceil, doors[4], water, gore, marks, named, mound, why[] }
 * where a surface is { material, colour, smooth } in the prose's own words
 * (build.js turns them into recipes), a door { material, colour }, water
 * { depth (m), stuff: 'water' | 'mud' }, gore { walls, floor }, marks
 * { kind: 'mural' | 'faces' | 'writing', subject, texts[] }.
 */

// Colour words, as the prose uses them of stone and paint.
const COLOUR = 'purple|violet|black|jet-black|white|milky white|red|deep red|crimson|blue|green|yellow|grey|gray|golden|dark|pale';
// Not `mud`: Mud School's exits are keyworded "door mud", and mud underfoot
// is the water reader's business.
const MATERIAL = 'living wood|stone|rock|marble|granite|obsidian|basalt|slate|ice|crystals?|wooden|wood|oak|oaken|pine|brick|earthen|earth|gold|silver|iron|steel|metal|glass|ivory';
const FINISH = 'smooth|polished|rough|bare|cold|damp|wet|ancient|old|huge|large|heavy|solid|sturdy|thick|great|stout|tall|low|massive|small|carved|plain|dressed';
// An adjective run in front of a noun: "large black stone", "smooth purple stone".
const RUN = `(?:(?:${FINISH}|${COLOUR}|very|pure|solid)[\\s,-]+)*`;
const SURFACE_OF = new RegExp(`\\b(${RUN})(${MATERIAL})[\\s-]+(walls?|floors?|ceilings?)\\b`, 'i');
const SURFACE_IS = new RegExp(`\\b(walls?|floors?|ceilings?)(?:\\s+(?:here|of (?:the|this) (?:room|cavern|cave|hall|chamber|tunnels?)))?\\s+(?:are|is)\\s+(?:all\\s+|entirely\\s+|completely\\s+)?(?:made|built|carved|constructed|hewn|cut)?\\s*(?:out\\s+)?(?:of|from)\\s+(?:the\\s+|a\\s+)?(${RUN})(${MATERIAL})\\b`, 'i');
const SURFACE_COLOUR = new RegExp(`\\b(walls?)(?:\\s+here)?\\s+(?:are|is)\\s+(?:\\([^)]*\\)\\s+)?(?:a\\s+)?(${COLOUR})(?:\\s+colou?r)?\\b(?![\\s-]+(?:${MATERIAL}))`, 'i');
const BUILT_OF = new RegExp(`\\b(?:constructed|built|made)\\s+(?:entirely\\s+)?(?:from|of|out of)\\s+(?:giant\\s+|huge\\s+|large\\s+|massive\\s+)?(${MATERIAL})\\s+(?:blocks|slabs)\\b`, 'i');
const ICE_COAT = /\b(?:thick with ice|layers of ice on the walls?|walls? (?:are |is )?(?:covered|coated|encrusted) (?:with|in) ice)\b/i;
// The object the material belongs to, when it is not the room's: a throne
// carved into the wall, tapestries on it, anything seen somewhere else.
const SURFACE_NOT = /\b(?:throne|tapestr\w*|banners?|shelves|mirror|cabinet|altar|statue|pillars?|columns?|stairs?|staircase|steps)\b[^.]{0,30}$|\bto the (?:north|south|east|west)\b[^.]{0,12}$|\b(?:outside|beyond|through|you see|you can see)\b[^.]{0,20}$/i;

const DOOR = new RegExp(`\\b(${RUN})(${MATERIAL}|${COLOUR})(?:[\\s-]+(?:${MATERIAL}))?[\\s-]+(?:double\\s+)?doors?\\b`, 'i');
const DIR_WORD = { north: 0, east: 1, south: 2, west: 3 };

/** Depth of the water or mud a room says you stand in, up the body. */
const DEPTH = [
  [/\b(?:neck|chin|shoulders|swimming|swim|holding (?:you|your) breath|under water)\b/i, 1.45],
  [/\b(?:chest)\b/i, 1.25],
  [/\b(?:waist|hips|thighs)\b/i, 0.95],
  [/\bknees?\b|\bknee[- ]deep\b/i, 0.5],
  [/\b(?:ankles?|ankle[- ]deep|wet feet|floor is (?:completely )?covered (?:with|in|by) (?:yucky )?water)\b/i, 0.14],
];
const IN_WATER = /\b(?:standing in water|stand in water|in water (?:up )?to|water (?:you're|you are) in|water to your|wading|swimming|swim in|you have wet feet|floor is (?:completely )?covered (?:with|in|by) (?:yucky )?water|under water in|holding (?:you|your) breath|in water up)\b/i;
const IN_MUD = /\b(?:mud|something that resembles mud)\b[^.]{0,40}\b(?:knees?|thighs|hips|ankles|waist)\b|\b(?:knees?|thighs|hips|ankles|waist)\b[^.]{0,30}\bmud\b/i;

// Blood said to be on the walls or the floor, as a fact of the room. Not the
// altar's, not "blood-red", not stalactites that "resemble dripping blood".
const GORE_WALLS = /\b(?:blood|gore)\b[^.]{0,40}\bwalls?\b|\bwalls?\b[^.]{0,30}\b(?:blood|gore)\b|\bblood everywhere\b/i;
const GORE_FLOOR = /\bblood (?:and gore )?is ankle deep\b|\bblood(?:y)? (?:stains|pools?)\b[^.]{0,30}\bfloor\b|\bfloor\b[^.]{0,30}\bblood\b|\bblood and gore are everywhere\b|\bblood everywhere\b/i;
const GORE_NOT = /\bresembl\w*|\baltar\b|\bblood[- ]?(?:red|shot|thirsty|lust|curdling)\b|\btrail of blood\b|\bstained the grass\b/i;

// Painting on the walls themselves, as against a picture hanging on one.
const MURAL = /\bwall paintings\b|\bmurals?\b|\bfrescoe?s?\b|\bwalls (?:are|is) (?:covered|painted) (?:in|with|by) (?:\w+ )?paintings\b/i;
const MURAL_NOT = /\bhang\w*\b|\bframed?\b/i;
const FACES = /\bdrawings? of faces\b|\bfaces? (?:drawn|painted|scratched) (?:on|into) the walls?\b/i;
const WRITING = /\b(?:writing|words|letters|runes)\s+(?:on|in|at|upon)\s+the\s+wall\b|\bspray-painted on the wall\b|\bscrawled on the wall\b/i;

const TREE = /\b(?:inside (?:of )?(?:the|this|a) (?:great |huge |hollow(?:ed)? |giant |old )?tree|hollow(?:ed)? (?:out )?(?:tree|trunk))\b/i;
const ROOT = /\broots? of the tree hollowed\b|\bhollowed(?:-| )out roots?\b/i;
const MOUND = /\bmound upon which the temple is built\b|\btemple (?:is built|stands) (?:up)?on (?:a|the) (?:huge |great |large )?mound\b/i;

const sentences = (text) => String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((s) => s.trim());
const colourOf = (run) => (run.match(new RegExp(`\\b(${COLOUR})\\b`, 'i')) || [])[1]?.toLowerCase() ?? null;
const smoothOf = (run) => /\b(smooth|polished)\b/i.test(run);
const normMaterial = (m) => {
  const w = m.toLowerCase();
  if (/^crystal/.test(w)) return 'crystal';
  if (w === 'wooden' || w === 'oak' || w === 'oaken' || w === 'pine') return 'wood';
  if (w === 'earthen') return 'earth';
  if (w === 'rock') return 'stone';
  if (w === 'steel' || w === 'metal') return 'iron';
  return w;
};
const surfaceKey = (noun) => (/^wall/i.test(noun) ? 'wall' : /^floor/i.test(noun) ? 'floor' : 'ceil');

/** Which wall a sentence puts a door in: "in the western wall", "to the north", "leads east". */
function doorWall(s, index) {
  const after = s.slice(index);
  const before = s.slice(0, index);
  const m = after.match(/\b(?:to the|to your|leads?|lead|is to the|can be seen to the|stands in the)\s+(north|south|east|west)(?:ern)?\b/i)
    || before.match(/\b(?:in|on) the (north|south|east|west)(?:ern)? wall\b/i)
    || before.match(/\bto (?:the|your) (north|south|east|west)\b/i)
    || after.match(/\b(north|south|east|west)(?:ern)? wall\b/i);
  return m ? DIR_WORD[m[1].toLowerCase()] : -1;
}

export function readShell(room) {
  const name = room.name || '';
  const text = (room.description || '').replace(/\s+/g, ' ');
  const out = {
    plan: null, wall: null, floor: null, ceil: null, doors: [null, null, null, null],
    water: null, gore: null, marks: null, named: null, mound: false, why: [],
  };
  const note = (what, s) => out.why.push(`${what}: ${s.length > 90 ? `${s.slice(0, 87)}...` : s}`);
  const setSurface = (key, material, run, s) => {
    if (out[key]) return;
    out[key] = { material: normMaterial(material), colour: colourOf(run), smooth: smoothOf(run) };
    note(key, s);
  };

  for (const s of [name, ...sentences(text)]) {
    // Plan.
    if (!out.plan) {
      if (/\b(?:octagonal|eight-sided)\b/i.test(s)) { out.plan = 'octagon'; note('plan', s); }
      else if (/\b(?:round|circular) (?:room|hall|chamber)\b|\b(?:room|hall|chamber) is (?:round|circular)\b|\bcircular in shape\b/i.test(s)) {
        out.plan = 'round'; note('plan', s);
      }
    }
    // Surfaces, "smooth purple stone walls".
    let m = s.match(SURFACE_OF);
    if (m && !SURFACE_NOT.test(s.slice(0, m.index))) setSurface(surfaceKey(m[3]), m[2], m[1], s);
    // "The floor is made from black stone."
    m = s.match(SURFACE_IS);
    if (m && !SURFACE_NOT.test(s.slice(0, m.index))) setSurface(surfaceKey(m[1]), m[3], m[2], s);
    // "The walls are (surprise!) blue", "a milky white color".
    m = s.match(SURFACE_COLOUR);
    if (m && !out.wall) { out.wall = { material: null, colour: m[2].toLowerCase(), smooth: false }; note('wall', s); }
    // "Constructed from giant marble blocks."
    m = s.match(BUILT_OF);
    if (m) setSurface('wall', m[1], '', s);
    if (ICE_COAT.test(s)) setSurface('wall', 'ice', '', s);
    if (/\bwhole room is carved out of\b/i.test(s)) {
      const mm = s.match(new RegExp(`carved out of (?:pure )?(${MATERIAL})`, 'i'));
      if (mm) for (const k of ['wall', 'floor', 'ceil']) setSurface(k, mm[1], '', s);
    }

    // Doors, and the wall they are in.
    m = s.match(DOOR);
    if (m && !/\bdoorway\b/i.test(m[0])) {
      const dir = doorWall(s, m.index);
      const words = `${m[1]} ${m[2]} ${m[0]}`;
      const mat = words.match(new RegExp(`\\b(${MATERIAL})\\b`, 'i'));
      const door = { material: mat ? normMaterial(mat[1]) : null, colour: colourOf(words) };
      if (dir >= 0 && (door.material || door.colour) && !out.doors[dir]) { out.doors[dir] = door; note(`door ${'NESW'[dir]}`, s); }
    }

    // Water or mud, and how far up.
    const wet = IN_WATER.test(s);
    const mud = IN_MUD.test(s);
    // "To the south the floor is covered with yucky water" is the next room.
    if (!out.water && (wet || mud) && !/\bto the (?:north|south|east|west)\b|\bhalf of the floor\b/i.test(s)) {
      const hit = DEPTH.find(([re]) => re.test(s));
      if (hit) { out.water = { depth: hit[1], stuff: mud && !wet ? 'mud' : 'water' }; note('water', s); }
    }

    // Blood.
    if (!GORE_NOT.test(s)) {
      const walls = GORE_WALLS.test(s); const floor = GORE_FLOOR.test(s);
      if (walls || floor) {
        out.gore = { walls: walls || !!out.gore?.walls, floor: floor || !!out.gore?.floor };
        note('gore', s);
      }
    }

    // What is on the walls.
    if (!out.marks && MURAL.test(s) && !MURAL_NOT.test(s)) {
      const subject = (s.match(/\b(?:picturing|depicting|show(?:ing)?|of)\s+([^.]+)/i) || [])[1] || '';
      out.marks = { kind: 'mural', subject, texts: [] }; note('marks', s);
    } else if (!out.marks && FACES.test(s)) {
      out.marks = { kind: 'faces', subject: s, texts: [] }; note('marks', s);
    } else if (!out.marks && WRITING.test(s)) {
      out.marks = { kind: 'writing', subject: '', texts: [] }; note('marks', s);
    }

    if (!out.named && (TREE.test(s))) { out.named = 'tree'; note('named', s); }
    else if (!out.named && ROOT.test(s)) { out.named = 'root'; note('named', s); }
    if (MOUND.test(s)) { out.mound = true; note('mound', s); }
  }

  // What the writing says, if the room lets you read it.
  if (out.marks && out.marks.kind === 'writing') {
    for (const e of room.extra || []) {
      if (!/\b(writing|wall|words|runes)\b/i.test(e.keyword)) continue;
      const quoted = String(e.description).match(/'([^']+)'/g);
      if (quoted) out.marks.texts.push(...quoted.map((q) => q.slice(1, -1)));
    }
  }
  // A door the exit itself names: "door stone", "door wooden".
  (room.exits || []).forEach((exit, dir) => {
    if (!exit || dir > 3 || out.doors[dir] || !exit.keyword) return;
    const words = `${exit.keyword} ${exit.description || ''}`;
    const mat = words.match(new RegExp(`\\b(${MATERIAL})\\b`, 'i'));
    if (!mat || !/\bdoor\b/i.test(exit.keyword)) return;
    out.doors[dir] = { material: normMaterial(mat[1]), colour: colourOf(words) };
    note(`door ${'NESW'[dir]}`, `exit keyword '${exit.keyword}'`);
  });
  // The tree's own door is "carved beautifully" out of it.
  if (out.named === 'tree') {
    (room.exits || []).forEach((exit, dir) => {
      if (exit && dir < 4 && !out.doors[dir]) out.doors[dir] = { material: 'living wood', colour: null };
    });
  }
  return out.why.length ? out : null;
}

const attrsOf = new WeakMap();
/** `readShell`, once per room. */
export function shellAttrs(room) {
  if (!attrsOf.has(room)) attrsOf.set(room, readShell(room));
  return attrsOf.get(room);
}
