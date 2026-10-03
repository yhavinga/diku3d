/**
 * What a room's own words put in it, beyond the trade it is kept for.
 *
 * Diku prose names things -- "along the walls skeletons are hanging in rusty
 * chains", "huge oaken tables cluttered with pipes and flasks", "a blackboard
 * in a dark corner" -- and every one of those nouns is a placement
 * instruction, the same move `readFittings` makes on "the bar is set against
 * the northern wall". The room shell is the shells' business and the trade's
 * furniture is `buildInteriorProps`'; this is what is left: the things the
 * text says are lying, standing or hanging in the room.
 *
 * Two halves. `readClutter` is pure and runs in node (tools/clutter-check.mjs
 * prints what it reads for every room in all 45 areas): it turns the prose,
 * the extra descriptions and the fixed objects into requests -- a kind, how
 * many, and where it goes. `placeClutter` is the one hook build.js calls once
 * every room is built: it finds each request a clear place on that room's
 * real floor and walls, measured off the colliders the shells left, so it
 * does not care which shell a room was given.
 */

import { DIR_STEP } from './are.js';

// ------------------------------------------------------------ reading ----

const WALL_WORD = { north: 0, east: 1, south: 2, west: 3 };
// How far in front of the stone a mural's plane is, plus a clear gap.
const MURAL_PROUD = 0.045;

/** build.js asks these too: the altar a statue stands behind is brought out from its wall. */
export const STATUE_OF_ODIN = /\bstatue of odin\b/i;
export const ALTAR_MIDDLE = /\b(?:in the (?:middle|centre|center) of the room[^.]{0,30}\baltar|altar[^.]{0,30}\bin the (?:middle|centre|center) of the room)\b/i;
/** How deep the Odin statue's plinth is, wall to front (tools/blender/statues.py). */
export const STATUE_DEPTH = 2.2;
const NUMBER = { a: 1, an: 1, one: 1, single: 1, another: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };
// Words in front of a noun that say there are a lot of it, as against one.
const MANY = /\b(numerous|many|lots? of|a lot of|several|all kinds of|all sorts of|various|along the walls|all around|piles and piles|piles of|heaps of|rows of|full of|filled with|covered (?:with|in|by)|scattered|strewn|littered|spread|all over|everywhere|countless)\b/i;
// "no furniture", "barren of growth", "the furniture has been stolen": the
// thing is named because it is *not* there.
const NOT_BEFORE = /\b(no|not|without|nothing|never|lacks?|lacking|barren|once full of|used to (?:be|have|hold)|any)\s+(?:\w+[\s,]+){0,3}$/i;
const NOT_AFTER = /^[^.]{0,30}\b(has been stolen|have been stolen|is gone|are gone|has been removed|disappears|(?:have|has) been torn down|pulled down)\b/i;
// "Below you can see a prismatic web with lots of animal bones caught in it":
// somewhere else, seen from here.
const FAR = /\b(below you|beneath you|above you|in the distance|far below|far above|far away|through the window)\b/i;
// "The entrance to the well", "a path leads to the treasure": somewhere else.
const TOWARDS = /\b(?:to|towards?|into|entrance to|way to|door to|path to|leads? to|leading to|reach|reaches)\s+(?:the\s+|a\s+|an\s+)?(?:\w+\s+){0,2}$/i;

/**
 * Each rule: the kind it asks for, the words that name it, and where it goes
 * (`at`, read by placeClutter). `not` is that noun's own reject list -- the
 * figure of speech it is part of -- and each one is there because a room in
 * one of the 45 areas used the word that way (tools/clutter-check.mjs).
 *
 * at: 'hang'   on a wall, off the floor: a painting, chains, a sign
 *     'wall'   standing against a wall: a chest, a hoard, a blackboard
 *     'floor'  free-standing, out in the room: a table, a sarcophagus
 *     'strew'  lying on the floor, walked over: bones, a skull
 *     'mark'   laid flat on the floor: a pentagram
 *     'edge'   out of doors, beside the way through: ruins
 */
const RULES = [
  // Set pieces, before anything that might take their floor. "There are
  // flames surrounding you": a fire all round the walls.
  {
    kind: 'fire_ring', at: 'walls', many: 1, indoor: true,
    re: /\bflames surround\w*\b|\bsurrounded by (?:flames|fire)\b|\b(?:wall|ring) of (?:fire|flames)\b/i,
  },
  // "Behind it is a ten foot tall sitting statue of Odin": stood behind the
  // altar the same sentence names (build.js stands the altar out for it).
  { kind: 'statue_odin', at: 'behind', many: 1, indoor: true, re: STATUE_OF_ODIN },
  // "In the middle of the room there is a small altar" -- out on the floor,
  // not against a wall; build.js's readFittings leaves this one alone.
  { kind: 'altar', at: 'centre', many: 1, indoor: true, re: ALTAR_MIDDLE },
  // "Some faces are staring at you from inside the walls."
  {
    kind: 'wall_faces', at: 'hang', many: 7, indoor: true,
    re: /\bfaces?\b[^.]{0,40}\b(?:from|in|out of|inside)\s+(?:the\s+)?walls\b/i,
  },
  // Small statues the extra descriptions say what of: "a statue of a imp,
  // pointing to the west"; "a small statue of a Dragon sleeping", on the table.
  { kind: 'statue_imp', at: 'floor', many: 1, indoor: true, re: /\bstatue of an? imp\b/i },
  { kind: 'figurine_dragons', at: 'table', many: 1, indoor: true, re: /\bsmall statue of a dragon\b/i },
  // "The Watermill", and "the sound of a creaking mill" from its door.
  { kind: 'millstones', at: 'floor', many: 1, indoor: true, re: /^the (?:water)?mill\.?$/i },
  // "Small flames sometimes shoot up from the hot mud."
  { kind: 'ground_flames', at: 'floor', many: 1, re: /\bflames\b[^.]{0,30}\bshoot up\b|\bflames\b[^.]{0,20}\bfrom the (?:hot )?(?:mud|ground|floor)\b/i },

  // Out of doors, what grows and stands beside the way. "An old elm tree
  // grows here"; "on both sides of the road grow dark evergreen trees".
  { kind: 'tree', at: 'corner', many: 1, outdoor: true, re: /\b(?:\w+ )?(?:elm|oak|beech|ash|willow|yew|chestnut|apple)? ?tree grows here\b/i },
  {
    kind: 'evergreens', at: 'corner', many: 4, outdoor: true,
    re: /\b(?:grow|between|among|lined with|line the)\b[^.]{0,30}\b(?:evergreen|fir|pine|yew|cypress|spruce) trees\b/i,
  },
  // "The strangest plant life you have ever seen, a mixture of tumescent
  // vegetables, evil-smelling fruit trees, and malignant ferns."
  { kind: 'hell_plants', at: 'corner', many: 4, outdoor: true, re: /\bstrangest plant life\b|\bmalignant ferns\b/i },
  // "The trees are quite tall considering most of them appear to be quite
  // young. On one of the trees, crude letters forming the word "Haon-Dor"
  // have been carved into the bark."
  { kind: 'carved_tree', at: 'corner', many: 3, outdoor: true, re: /\bletters\b[^.]{0,60}\bcarved into the bark\b/i },
  // "Three tents and some camels make up the party": the oasis pavilion
  // (tools/blender/desert.py) at a third of its size, a nomad's tent.
  { kind: 'tents', at: 'corner', many: 3, outdoor: true, re: /\b(?:two|three|four|some|several) tents\b/i },
  // "The stairs leading up to the guest rooms here do not seem advisable to climb."
  { kind: 'broken_stair', at: 'wall', many: 1, indoor: true, re: /\bstairs?\b[^.]{0,60}\b(?:not (?:seem )?(?:advisable|safe)|broken|collapsed|rotten)\b/i },
  // "A road sign is here."
  { kind: 'signpost', at: 'corner', many: 1, outdoor: true, re: /\broad ?sign\b|\bsign ?post\b/i },
  // "The street is full of garbage here"; the junction under the Dump.
  {
    kind: 'refuse', at: 'strew', many: 2,
    re: /\b(?:full of|piles? of|heaps? of|covered (?:in|with)|strewn with) (?:garbage|refuse|rubbish|trash)\b|\bunder the dump\b/i,
  },
  // "Various sorts of debris cover the stone floor."
  { kind: 'debris', at: 'strew', many: 3, re: /\bdebris\b[^.]{0,30}\b(?:cover|covers|lies|lie|strewn|scattered)\b|\b(?:covered|strewn|littered) with debris\b/i },
  // "A large room with chairs set in the walls"; "a chair, and that's tight
  // to the rock floor". buildInteriorProps seats rooms it furnishes itself.
  { kind: 'chair', at: 'wall', many: 4, indoor: true, re: /\bchairs? (?:set|carved|built|cut) in(?:to)? the walls?\b|\ba chair\b[^.]{0,40}\b(?:floor|fixed|tight)\b/i },

  // The dead. A skeleton in chains is not a skeleton lying about, and five
  // round a table are sitting at it.
  {
    kind: 'skeleton_hanging', at: 'hang', many: 3,
    re: /\bskeletons?\b[^.]{0,40}\bhang\w*\b[^.]{0,30}\bchains?\b|\bchained\s+skeletons?\b/i,
  },
  {
    kind: 'skeleton_seated', at: 'table', many: 5,
    re: /\bskeletons?\b[^.]{0,30}\b(?:sit|sits|sitting|siting|seated)\b|\b(?:sitting|seated)\b[^.]{0,20}\bskeletons?\b/i,
  },
  // "Two creatures are melted into the floor": what is left of them.
  { kind: 'skeleton', at: 'strew', many: 3, re: /\b(?:creatures?|bodies|adventurers?)\b[^.]{0,25}\bmelted\b/i },
  {
    kind: 'skeleton', at: 'strew', many: 3,
    re: /\bskeletons?\b/i,
    // An undead mobile's short description reads "a skeleton" too, but that
    // is read off the prose, which never names its mobiles as lying there.
    not: /\bskeletons?\s+(?:key|warriors?|guards?|of the)\b|\bskeletons?\b[^.]{0,40}\bhang\w*\b|\bskeletons?\b[^.]{0,30}\b(?:sit|sits|sitting|siting|seated)\b/i,
  },
  { kind: 'skull', at: 'strew', many: 5, re: /\bskulls\b|\ba skull\b/i, not: /\bskull\s+(?:cap|and crossbones)\b|\bskull[- ]shaped\b|\b(?:adorned|decorated|inlaid|carved|studded)\b[^.]{0,20}\bskulls\b/i },
  {
    kind: 'bones', at: 'strew', many: 4,
    re: /\b(?:bones|bone shards|bone fragments|gnawed bones)\b/i,
    not: /\b(?:to|in|into|through) (?:your|his|her|the) (?:very )?bones\b|\bbones? (?:ache|chill|cold)\b|\blazy\s*bones\b|\b(?:clank\w*|rattl\w*|sound) of bones\b/i,
  },
  {
    kind: 'carcass', at: 'strew', many: 3,
    re: /\b(?:corpses?|carcass(?:es)?|cadavers?|half-eaten (?:body|bodies)|body parts|rotting (?:body|bodies|parts)|mangled bod(?:y|ies))\b/i,
    not: /\bcorpse (?:light|candle)\b|\b(?:contain\w*|jars?|bottles?)\b[^.]{0,30}\bbody parts\b|\bcarrying\b|\b(?:loot|sacrifice|command|get all)\b/i,
  },
  // "Plastered on the far wall you see what looks like a human arm."
  {
    kind: 'arm', at: 'hang', many: 1,
    re: /\b(?:plastered|nailed|stuck|pinned)\b[^.]{0,50}\b(?:human |severed |rotting )?arm\b|\b(?:human|severed|rotting) arm\b[^.]{0,40}\b(?:plastered|nailed|stuck|pinned|hang\w*)\b/i,
    not: /\barm ?(?:chair|rest|our|band)\b|\bcoat of arms\b|\barms? of\b/i,
  },
  {
    kind: 'shackles', at: 'hang', many: 2,
    re: /\b(?:shackles?|manacles?|fetters?|chains?)\b[^.]{0,40}\b(?:walls?|hang\w*|fastened|bolted)\b|\b(?:walls?)\b[^.]{0,30}\b(?:shackles|manacles|chains)\b/i,
    not: /\bchain ?mail|\bchains? of (?:command|mountains|hills|islands|events)|\bmail\b|\bground\b/i,
  },
  {
    // "A huge black iron chain as thick as a tree trunk is fastened into the
    // ground at the centre of the road cross ... The chain reaches the clouds."
    kind: 'giant_chain', at: 'centre', many: 1, outdoor: true,
    re: /\bchain\b[^.]{0,80}\bfastened\b[^.]{0,30}\bground\b/i,
  },

  // Locked things and the gold in them.
  {
    kind: 'strongbox', at: 'floor', many: 1,
    re: /\b(?:metal box|iron box|steel box|strong ?box|coffer|iron[- ]bound chest|iron chest|money chest)\b/i,
  },
  {
    kind: 'chest', at: 'wall', many: 1,
    re: /\b(?:a|an|the|large|small|big|wooden|old|oak|heavy|treasure)\s+(?:\w+\s+)?chests?\b/i,
    not: /\b(?:your|his|her|its|their|my)\s+(?:\w+\s+)?chests?\b|\bchests?\s+(?:ripped|torn|high|deep|level|height)\b|\bchest[- ]?(?:high|deep)\b|\bto (?:the|your) chest\b/i,
  },
  {
    kind: 'treasure', at: 'wall', many: 1,
    re: /\btreasure\b[^.]{0,40}\b(?:strewn|piled|heaped|scattered|lies|lying|everywhere|about)\b|\b(?:piles?|heaps?|mounds?) of (?:gold|coins|treasure|jewels|gems)\b|\btreasure ?(?:room|chamber|vault|hoard)\b|\btreasury\b|\bhoard\b/i,
    not: /\btreasure (?:hunters?|map)\b/i,
  },

  // The dead in their tombs.
  {
    kind: 'sarcophagus', at: 'floor', many: 1, indoor: true,
    re: /\b(?:sarcophag\w*|coffins?|caskets?|biers?|burial chamber|crypt|tomb)\b/i,
    not: /\btomb ?stones?\b|\b(?:to|into|entrance to|towards?) (?:(?:the|a) )?(?:\w+ )?(?:tomb|crypt)\b|\bcasket of\b|\btomb's\b/i,
  },

  // The laboratory.
  {
    kind: 'alchemy', at: 'floor', many: 3,
    re: /\b(?:flasks?|alembics?|retorts?|vials|crucibles?|test ?tubes?|laboratory|beakers?)\b/i,
  },
  {
    kind: 'pentagram', at: 'mark', many: 2,
    re: /\b(?:pentagrams?|pentacles?|magic (?:circle|circles|symbols)|summoning circle|hexagrams?)\b/i,
  },
  { kind: 'blackboard', at: 'hang', many: 1, re: /\b(?:black ?board|chalk ?board|slate board)\b/i },

  // What hangs on a wall to be read or looked at.
  {
    kind: 'plaque', at: 'hang', many: 1,
    re: /\bplaques?\b/i,
  },
  {
    kind: 'sign', at: 'hang', many: 1, indoor: true,
    re: /\b(?:a|the|another|small|large|big|wooden|bronze|brass)\s+(?:\w+\s+)?signs?\b(?!\s+(?:of|that|language|says that))/i,
    not: /\bsigns? of\b|\bno signs?\b|\broad ?sign\b|\bsign on the door\b|\bsigns?\b[^.]{0,30}\b(?:on|upon|stands on|fastened to|set on|nailed to) the (?:counter|desk|bar|table|door)\b|\bsign[^.]{0,20}\bblocking\b/i,
  },
  {
    kind: 'painting', at: 'hang', many: 3,
    re: /\b(?:paintings?|portraits?|pictures?|murals?|frescoe?s?|coat of arms)\b/i,
    not: /\bpicture (?:yourself|it|the)\b|\bpicturing\b|\bget the picture\b|\bpicture perfect\b|\bpretty as a picture\b|\b(?:engraved|carved|etched|chiselled)\b[^.]{0,30}\b(?:pictures?|paintings?)\b|\bon the ceiling\b/i,
  },
  { kind: 'tapestry', at: 'hang', many: 3, re: /\btapestr(?:y|ies)\b|\bwall ?hangings?\b/i },

  // Silk.
  {
    kind: 'web', at: 'web', many: 3,
    re: /\b(?:cobwebs?|spider ?webs?|webs?\b(?! of (?:lies|intrigue|deceit))|sticky (?:ropes|wires|threads|strands)|giant threads)\b/i,
    not: /\bweb of (?:lies|intrigue|deceit|roads|streets|paths|tunnels|corridors)\b|\bwebbed (?:feet|toes)\b|\bweb-like\b/i,
  },

  { kind: 'cocoon', at: 'hang', many: 3, re: /\bcocoons\b|\ba cocoon\b/i, not: /\bcocoon of (?:blankets|warmth|silence)\b/i },

  // Things kept.
  { kind: 'cage', at: 'wall', many: 3, re: /\bcages?\b/i, not: /\brib ?cage\b|\bcage of (?:bones|ribs)\b/i },
  {
    kind: 'globe', at: 'centre', many: 1,
    re: /\b(?:crystal (?:globe|ball|sphere|orb)|glowing (?:globe|orb|sphere))\b/i,
  },
  {
    kind: 'feast', at: 'floor', many: 3,
    re: /\btables? (?:of|laden with|covered with|full of|piled with) (?:food|meat|delicacies|fruit)\b|\b(?:feast|banquet)\b(?! hall)/i,
    not: /\bfeast your eyes\b|\bfeast (?:on|upon) (?:you|your|the living)\b|\bfor a feast\b|\bhave you for\b/i,
  },
  {
    kind: 'pelts', at: 'strew', many: 3,
    re: /\b(?:furs|pelts|animal skins|hides)\b[^.]{0,30}\b(?:spread|lie|lying|cover|floor)\b|\b(?:bear ?skin|fur) rugs?\b/i,
    not: /\bshelves\b/i,
  },
  { kind: 'hay', at: 'strew', many: 3, re: /\b(?:hay|straw)\b[^.]{0,30}\b(?:spread|strewn|scattered|covers?|lies|on the floor)\b|\bbed of (?:hay|straw)\b/i },
  {
    kind: 'wreckage', at: 'strew', many: 4,
    re: /\bfurniture\b[^.]{0,30}\b(?:pieces|broken|smashed|splinters|wrecked|overturned)\b|\b(?:broken|smashed|overturned|wrecked) (?:furniture|chairs|tables)\b/i,
  },
  {
    kind: 'candles', at: 'table', many: 3,
    re: /\b(?:candles?|candelabr\w*|candlesticks?|tapers)\b/i,
    not: /\bcandle ?light\b|\bcandlelit\b|\bhold a candle\b|\bcandle (?:shop|maker)\b/i,
  },

  // Out of doors.
  {
    kind: 'ruin', at: 'edge', many: 2, outdoor: true,
    re: /\b(?:caved[- ]in|collapsed|ruined|burnt[- ]out|tumbled[- ]down) (?:buildings?|houses?|huts?|cottages?|homes?)\b|\bruins of (?:buildings|houses|a (?:house|building|village))\b/i,
  },
  {
    // "An old and worn well", "a well in the middle of the floor": a noun,
    // not "well equipped", "well-kept", "as well" or "well lighted".
    kind: 'well', at: 'centre', many: 1, place: true,
    re: /\b(?:a|an|the|old|worn|stone|deep|dry|ancient|small)\s+(?:\w+\s+){0,2}?well\b(?![- ](?:equipped|kept|lit|lighted|made|built|known|worn|trodden|used|dressed|armed|done|preserved|hidden|guarded|maintained|placed|furnished))(?!\s+(?:equipped|kept|lit|lighted|made|built|known|worn|trodden|used|dressed|armed|as|enough|done|preserved|hidden|guarded|maintained|placed|furnished|off|be|over|above|below|into|beyond|past|before|after|behind))/i,
    not: /\bas well\b|\bwell,|\bwell\s+(?:enough|done|then)\b|\bwell(?:-|\s+)\w+(?:ed|en)\b|\b(?:sun|it|them|him|her|you|very|quite|so|pretty)\s+well\b/i,
  },
];

/** Sentences, each with where it came from. The name is a sentence too. */
function sentencesOf(room) {
  const out = [];
  const push = (text, from) => {
    for (const s of String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)) {
      if (s.trim()) out.push({ s: s.trim(), from });
    }
  };
  push(room.name, 'name');
  push(room.description, 'prose');
  // An extra description is what you see when you look at something that is
  // in the room -- "exa skeletons" -- so it counts as the room's own words.
  for (const e of room.extra || []) push(`${e.keyword}: ${e.description}`, 'extra');
  // What stands in the room and cannot be picked up is named by the mud as
  // well: "the safe", "the heap of carnage". actors.js draws those already,
  // so the object's own name is read only to know the thing is taken care of.
  return out;
}

/** How many a sentence asks for: a number word before the noun, or a lot. */
function countIn(sentence, index, many) {
  const before = sentence.slice(Math.max(0, index - 40), index).toLowerCase();
  const number = before.match(/\b(a|an|one|single|another|two|three|four|five|six|seven|ten)\s+(?:[\w-]+\s+){0,2}$/);
  if (number) return NUMBER[number[1]];
  if (MANY.test(sentence)) return many;
  // A plural with no number is a few of them.
  return /s\b/.test(sentence.slice(index).match(/^[\w-]+/)?.[0] || '') ? Math.min(2, many) : 1;
}

/** "On the western wall", "to the north you see": which wall, if the text says. */
function wallIn(sentence, exits) {
  const on = sentence.match(/\b(?:on|against|in|at|along|by|upon)\s+the\s+(north|south|east|west)(?:ern)?\s+(?:wall|side|end)\b/i)
    || sentence.match(/\b(north|south|east|west)(?:ern)?\s+wall\b/i);
  if (on) return { dir: WALL_WORD[on[1].toLowerCase()], door: false };
  // "The far wall" of a room with one way in is the one facing it.
  const ways = [0, 1, 2, 3].filter((d) => exits[d]);
  if (/\bfar wall\b/i.test(sentence) && ways.length === 1) return { dir: (ways[0] + 2) % 4, door: false };
  const see = sentence.match(/\bto the (north|south|east|west)\b/i);
  if (see) {
    const dir = WALL_WORD[see[1].toLowerCase()];
    return { dir, door: !!exits[dir] };
  }
  return null;
}

/**
 * "A small plaque is on this wall": the wall the sentence before it was
 * about. The temple's is "steps lead UP through a small door", so the way up
 * -- which build.js puts in a wall of its own -- and not a blank wall picked
 * at random, where it had been hung over the middle of a mural.
 */
function thisWall(sentence, before) {
  if (!/\bthis wall\b/i.test(sentence) || !before) return null;
  const named = before.match(/\b(north|south|east|west)(?:ern)?\b/i);
  if (named) return { dir: WALL_WORD[named[1].toLowerCase()], door: false };
  if (/\bup\b/i.test(before)) return { dir: null, way: 4, door: false };
  if (/\bdown\b/i.test(before)) return { dir: null, way: 5, door: false };
  return null;
}

/**
 * The requests for one room: [{ kind, count, at, dir, why }]. `dir` is the
 * wall the text names or null. `why` is the words it was read from, for the
 * check tool and for anyone wondering why a room has a skull in it.
 */
export function readClutter(room) {
  const exits = room.exits || [];
  const found = new Map();
  const fixed = (room.items || []).filter((o) => !(o.proto.wearFlags & 1)).map((o) => `${o.proto.keywords} ${o.proto.short}`).join(' ');
  let said = '';
  for (const { s, from } of sentencesOf(room)) {
    const prevSaid = said;
    said = s;
    for (const rule of RULES) {
      if (found.has(rule.kind) && found.get(rule.kind).count >= rule.many) continue;
      const m = s.match(rule.re);
      if (!m) continue;
      if (rule.not && rule.not.test(s)) continue;
      const before = s.slice(0, m.index);
      if (NOT_BEFORE.test(before) || NOT_AFTER.test(s.slice(m.index + m[0].length)) || FAR.test(before)) continue;
      const wall = wallIn(s, exits) || thisWall(s, prevSaid);
      // "To the east is the well" is a direction when there is a way east;
      // "to the north you see a primitive picture" in a blind end is its wall.
      if (rule.place && (TOWARDS.test(before) || (wall && wall.door))) continue;
      const count = Math.min(rule.many, Math.max(1, countIn(s, m.index + m[0].search(/\S/), rule.many)));
      const prev = found.get(rule.kind);
      if (prev) { prev.count = Math.max(prev.count, count); continue; }
      found.set(rule.kind, {
        kind: rule.kind, count, at: rule.at, dir: wall ? wall.dir : null, way: wall ? wall.way ?? null : null,
        outdoor: !!rule.outdoor, indoor: !!rule.indoor, why: `${from}: ${s}`,
      });
    }
  }
  // Already stood in the room by actors.js from the reset table.
  if (/\bsafe\b|\bchest\b/.test(fixed)) found.delete('strongbox');
  if (/\bchest\b/.test(fixed)) found.delete('chest');
  if (/\b(treasure|gold)\b/.test(fixed)) found.delete('treasure');
  if (/\b(heap of carnage|corpse|cadaver)\b/.test(fixed)) found.delete('carcass');
  if (/\bwell\b/.test(fixed)) found.delete('well');
  // Skeletons sitting round a table are the skeletons in the room.
  if (found.has('skeleton_seated') || found.has('skeleton_hanging')) found.delete('skeleton');
  return [...found.values()];
}

// ------------------------------------------------------------ placing ----

/** Everything tools/blender/clutter.py makes, for assets.js to load. */
export const CLUTTER_NAMES = [
  'clutter_skull', 'clutter_bones', 'clutter_skeleton', 'clutter_skeleton_seated', 'clutter_skeleton_hanging',
  'clutter_shackles', 'clutter_strongbox', 'clutter_chest', 'clutter_hoard', 'clutter_sarcophagus',
  'clutter_alchemy', 'clutter_pentagram', 'clutter_blackboard', 'clutter_plaque', 'clutter_sign',
  'clutter_painting_portrait', 'clutter_painting_landscape', 'clutter_painting_gathering', 'clutter_mural',
  'clutter_arms', 'clutter_tapestry', 'clutter_web', 'clutter_cocoon', 'clutter_cages', 'clutter_globe',
  'clutter_feast', 'clutter_carcass', 'clutter_pelts', 'clutter_hay', 'clutter_wreckage',
  'clutter_chain_run', 'clutter_chain_anchor', 'clutter_arm',
  // tools/blender/statues.py
  'statue_odin', 'altar_marble', 'altar_faces', 'relief_face', 'fire_bed',
  'statue_imp', 'figurine_dragons', 'millstones',
];

// Only ever indoors, so they carry the `aIndoor` flag the room kits do (no sky
// bounce off a floor they cannot see). The rest go out of doors as well --
// bones in a cave mouth, a web between trees -- and keep the default.
const INDOOR_ONLY = new Set([
  'clutter_skeleton_seated', 'clutter_skeleton_hanging', 'clutter_shackles', 'clutter_strongbox',
  'clutter_sarcophagus', 'clutter_alchemy', 'clutter_pentagram', 'clutter_blackboard', 'clutter_plaque',
  'clutter_sign', 'clutter_painting_portrait', 'clutter_painting_landscape', 'clutter_painting_gathering',
  'clutter_mural', 'clutter_arms', 'clutter_tapestry', 'clutter_cocoon', 'clutter_cages', 'clutter_globe',
  'clutter_pelts', 'clutter_wreckage', 'clutter_hoard', 'clutter_arm',
  'statue_odin', 'altar_marble', 'altar_faces', 'relief_face', 'fire_bed',
  'statue_imp', 'figurine_dragons', 'millstones',
]);

// clutter.py authors bone, iron and stone for a room under the sky; under the
// ground the same surfaces are their `buried` twins (textures.js), lit by the
// fixed fill down there instead of by the hour.
const BURIED = { oldbone: 'bone', rust: 'rustiron', flagstone: 'sewerflag' };

const FACE_ROT = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
// Lying flat, walked over: these may lie in a doorway's lane.
const FLAT = new Set(['bones', 'skull', 'pelts', 'hay', 'carcass', 'skeleton', 'wreckage']);

/**
 * What each kind puts down. `models` by variant; `solid` is a collider to its
 * own height; `pad` is floor kept clear round it.
 */
const KINDS = {
  skull: { models: ['clutter_skull'] },
  bones: { models: ['clutter_bones'] },
  skeleton: { models: ['clutter_skeleton'] },
  carcass: { models: ['clutter_carcass'] },
  pelts: { models: ['clutter_pelts'] },
  hay: { models: ['clutter_hay'] },
  wreckage: { models: ['clutter_wreckage'] },
  skeleton_hanging: { models: ['clutter_skeleton_hanging'], solid: true },
  shackles: { models: ['clutter_shackles'] },
  arm: { models: ['clutter_arm'] },
  blackboard: { models: ['clutter_blackboard'] },
  plaque: { models: ['clutter_plaque'] },
  sign: { models: ['clutter_sign'] },
  painting: { models: ['clutter_painting_landscape', 'clutter_painting_portrait', 'clutter_painting_gathering'] },
  tapestry: { models: ['clutter_tapestry'] },
  cocoon: { models: ['clutter_cocoon'] },
  strongbox: { models: ['clutter_strongbox'], solid: true, pad: 0.5 },
  chest: { models: ['clutter_chest'], solid: true },
  treasure: { models: ['clutter_hoard'], solid: true },
  sarcophagus: { models: ['clutter_sarcophagus'], solid: true, pad: 0.25 },
  alchemy: { models: ['clutter_alchemy'], solid: true, pad: 0.7 },
  cage: { models: ['clutter_cages'], solid: true },
  globe: { models: ['clutter_globe'], solid: true, pad: 0.8 },
  feast: { models: ['clutter_feast'], solid: true, pad: 0.9 },
  pentagram: { models: ['clutter_pentagram'] },
  web: { models: ['clutter_web'] },
  ruin: { models: ['collapsed_shed', 'rubble_heap', 'charred_beams'], solid: true },
  well: { models: ['well'], solid: true, pad: 0.6 },
  altar: { models: ['altar_faces'], solid: true, pad: 0.5 },
  refuse: { models: ['refuse_heap'], solid: true },
  debris: { models: ['debris', 'rubble'] },
  chair: { models: ['furn_chair'], solid: true },
  millstones: { models: ['millstones'], solid: true, pad: 0.5 },
  broken_stair: { models: ['broken_stair'], solid: true },
};

/** Which painting a sentence is about. */
function paintingModel(why, k) {
  if (/\bprimitive picture|\bmural|\bfresco/i.test(why)) return 'clutter_mural';
  if (/\bcoat of arms\b/i.test(why)) return 'clutter_arms';
  if (/\bportraits?\b|\bpicture of the mighty\b/i.test(why)) return 'clutter_painting_portrait';
  if (/\b(at work|at play|scenes?|battles?|people|halflings)\b/i.test(why)) {
    return k % 2 ? 'clutter_painting_landscape' : 'clutter_painting_gathering';
  }
  return k % 2 ? 'clutter_painting_portrait' : 'clutter_painting_landscape';
}

/** A small deterministic hash, 0..1. */
function roll(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The axis-aligned box a model covers on the floor, turned by rotY, about (x, z). */
function footprint(bounds, x, z, rotY, scale = 1, pad = 0) {
  const c = Math.cos(rotY); const s = Math.sin(rotY);
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  for (const bx of [bounds.min.x, bounds.max.x]) {
    for (const bz of [bounds.min.z, bounds.max.z]) {
      const wx = x + (bx * c + bz * s) * scale; const wz = z + (-bx * s + bz * c) * scale;
      x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); z0 = Math.min(z0, wz); z1 = Math.max(z1, wz);
    }
  }
  return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
}

const overlaps = (a, b, m = 0) => a.x0 < b.x1 + m && a.x1 > b.x0 - m && a.z0 < b.z1 + m && a.z1 > b.z0 - m;

/**
 * The hook: every built room whose words ask for something gets it, in a
 * clear place. Runs once, after every room, street and filler is built, so
 * the colliders it measures against are the finished ones.
 *
 * ctx: { world, rooms (build.js's map), decor, colliders, addCollider,
 *        instances, lights, worldOf(cell), openAir(room), ROOM, HALF }
 */
export function placeClutter(ctx) {
  const { rooms, decor, colliders, addCollider, instances, lights, worldOf, openAir, ROOM, HALF, BufferAttribute } = ctx;
  if (!instances) return { placed: 0 };
  const library = instances.library;
  for (const name of INDOOR_ONLY) markIndoor(library.get(name), BufferAttribute);

  // Small placements already made, by cell, so a sarcophagus is not stood in
  // a bone pile: everything instanced whose footprint is under 4 m a side.
  const small = new Map();
  const cellOf = (x, z) => `${Math.round(x / 13)},${Math.round(z / 13)}`;
  for (const bucket of instances.buckets.values()) {
    const b = bucket.asset.bounds;
    if (b.max.x - b.min.x > 4 || b.max.z - b.min.z > 4) continue;
    for (const t of bucket.transforms) {
      const key = cellOf(t.x, t.z);
      if (!small.has(key)) small.set(key, []);
      small.get(key).push({ ...footprint(b, t.x, t.z, t.rotY || 0, t.scale ?? 1), y: t.y, h: b.max.y * (t.scaleY ?? t.scale ?? 1) });
    }
  }
  const byCell = new Map();
  for (const d of decor) {
    const key = cellOf(d.x, d.z);
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(d);
  }

  let placed = 0;
  const missed = [];
  const where = []; // every placement, for probes: diku.built.stats.clutter
  for (const [vnum, info] of rooms) {
    if (info.unbuilt) continue;
    const room = info.room;
    const asks = readClutter(room);
    if (!asks.length) continue;
    const pos = worldOf(info.cell);
    const outside = openAir(room);
    const chunk = info.chunk;
    const sides = info.sides || [];
    const swap = info.cell.level < 0 ? BURIED : null;
    const here = byCell.get(cellOf(pos.x, pos.z)) || [];
    const plan = info.plan || null;

    // What is solid in this room, in world coordinates.
    const lo = pos.y + 0.15; const hi = pos.y + 2.0;
    const solid = colliders.filter((c) => c.y1 > lo && c.y0 < hi && c.x1 > pos.x - 8 && c.x0 < pos.x + 8
      && c.z1 > pos.z - 8 && c.z0 < pos.z + 8)
      .map((c) => ({ x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1 }));
    const blocked = [...solid];
    for (const r of small.get(cellOf(pos.x, pos.z)) || []) if (Math.abs(r.y - pos.y) < 2) blocked.push(r);
    // Where you arrive, and a lane in from every way out.
    const arrive = { x0: info.center.x - 1.3, x1: info.center.x + 1.3, z0: info.center.z - 1.3, z1: info.center.z + 1.3 };
    const keep = [arrive];
    const core = [];
    const lanes = [];
    // "Most of the walls are covered by ancient wall paintings" (build.js
    // `buildMarks`): the plaster is painted 3 cm proud of the stone, and the
    // temple's plaque hung at the stone showed through it as a ghost.
    const painted = !outside && info.materials?.said?.marks?.kind === 'mural';
    if (plan) for (const t of plan.taken) keep.push({ x0: pos.x + t.x0, x1: pos.x + t.x1, z0: pos.z + t.z0, z1: pos.z + t.z1 });
    for (let d = 0; d < 4; d++) {
      if (!sides[d]) continue;
      const [dx, , dz] = DIR_STEP[d];
      const far = outside ? HALF : ROOM / 2 + 0.5;
      const near = 0.8;
      const ax = dx ? [pos.x + dx * near, pos.x + dx * far] : [pos.x - 2.0, pos.x + 2.0];
      const az = dz ? [pos.z + dz * near, pos.z + dz * far] : [pos.z - 2.0, pos.z + 2.0];
      lanes[d] = { x0: Math.min(...ax), x1: Math.max(...ax), z0: Math.min(...az), z1: Math.max(...az) };
      keep.push(lanes[d]);
      // The middle of that lane, which even a heap of garbage leaves open.
      const cx = dx ? ax : [pos.x - 0.9, pos.x + 0.9];
      const cz = dz ? az : [pos.z - 0.9, pos.z + 0.9];
      core.push({ x0: Math.min(...cx), x1: Math.max(...cx), z0: Math.min(...cz), z1: Math.max(...cz) });
    }
    // A dungeon's shell already hangs empty irons on its blank walls, a pair
    // to a wall 2.3 m either side of the middle (build.js `buildShackles`):
    // the dead hang between them in their own, and no second set goes up.
    const shellKind = info.materials && info.materials.shell ? info.materials.shell.kind : null;
    if (shellKind === 'dungeon') {
      for (let d = 0; d < 4; d++) {
        if (sides[d]) continue;
        const [dx, , dz] = DIR_STEP[d];
        for (const along of [-2.3, 2.3]) {
          const cx = pos.x + dx * (ROOM / 2 - 0.2) + (dz ? along : 0); const cz = pos.z + dz * (ROOM / 2 - 0.2) + (dx ? along : 0);
          keep.push({ x0: cx - 0.3, x1: cx + 0.3, z0: cz - 0.3, z1: cz + 0.3 });
        }
      }
    }
    // Things on the walls a hanging must not cover: torches, and furniture.
    const torches = here.filter((d) => d.kind === 'torch');
    for (const d of here) {
      if (d.kind === 'table') keep.push({ x0: d.x - 1.15, x1: d.x + 1.15, z0: d.z - 1.15, z1: d.z + 1.15 });
    }
    // `flat`: true for what is walked over (only the arrival point is kept),
    // 'core' for what a street is full of (the middle of each lane is kept).
    const clear = (r, floor = true, flat = false) => !(flat === 'core' ? [arrive, ...core] : flat ? [arrive] : keep).some((k) => overlaps(r, k))
      && (!floor || !blocked.some((b) => overlaps(r, b, -0.02)));
    const take = (r, solidToo) => { keep.push(r); if (solidToo) blocked.push(r); };

    /** How far the wall is from the room's middle, out along `dir`, `along` to one side. */
    const wallAt = (dir, along) => {
      const [dx, , dz] = DIR_STEP[dir];
      const px = pos.x + (dz ? along : 0); const pz = pos.z + (dx ? along : 0);
      // The stone and temple kits' inner face is at 5.13 (raycast), the
      // procedural walls' and a Shire room's plaster at 5.0; the plan's
      // `face` says which, but is measured for the floor, not the wall.
      // A log room's round logs stand proud everywhere (the shell's lining).
      // A rock cave's lining (build.js `buildCaveLining`) stands up to 0.85 m
      // proud of the wall line, and its collider only 0.55: hang on its crowns.
      if (!outside && info.materials && info.materials.rockCave) return ROOM / 2 - 0.86;
      if (plan && !outside) return ROOM / 2 + ((plan.face || 0) > 0 ? 0.13 : (shellKind === 'log' ? plan.face : 0));
      // A walled room's wall is never further out than ROOM / 2: a wall with
      // a doorway in it has had no collider past the opening's jambs.
      const most = outside ? 7.2 : ROOM / 2 + 0.01;
      for (let s = 1.5; s < most; s += 0.05) {
        const x = px + dx * s; const z = pz + dz * s;
        if (solid.some((c) => x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1)) return s;
      }
      return outside ? HALF : ROOM / 2;
    };

    const put = (name, x, z, rotY, { scale = 1, collide = false, y = pos.y, far = false, examine = null } = {}) => {
      if (!library.get(name)) return null;
      // Indoors above ground it goes with the furniture (actors.js), which
      // is switched off past 32 m: from the Market Square every room to the
      // north is in the frustum, walls and all. Underground the zones hide
      // it whole, and out of doors it is seen from afar. `far` is for what a
      // room is built round -- Odin is the end of the temple's axis, 33 m
      // from its door -- and is left to the visibility cull like the walls.
      if (!outside && info.cell.level >= 0 && !far) decor.push({ kind: 'prop', name, x, y, z, rotY, scale });
      else instances.add(name, { x, y, z, rotY, scale }, chunk, swap);
      if (examine) decor.push({ kind: 'examine', x, y: examine.y, z, title: examine.title, body: examine.body });
      where.push({ vnum, name, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), rotY: +rotY.toFixed(2) });
      const b = library.get(name).bounds;
      const r = footprint(b, x, z, rotY, scale);
      if (collide) addCollider(r.x0, r.x1, r.z0, r.z1, y, y + b.max.y * scale);
      placed++;
      return r;
    };

    // Against a wall: the named one first, then walls with no way through
    // them, then the rest. Slides along the wall until it is clear.
    const onWall = (name, ask, k, { depthPad = 0.05, hang = false, scale = 1 } = {}) => {
      // Silk hangs over everything; reeds and barrels do not get in its way.
      const high = ask.kind === 'web' || ask.kind === 'cocoon';
      const b = library.get(name)?.bounds;
      if (!b) return null;
      const blank = [0, 1, 2, 3].filter((d) => !sides[d]);
      const doors = [0, 1, 2, 3].filter((d) => sides[d]);
      // A way up or down named as "this wall": whichever wall build.js gave it.
      if (ask.dir === null && ask.way) {
        const d = doors.find((w) => sides[w].link && sides[w].link.dir === ask.way);
        if (d !== undefined) ask.dir = d;
      }
      const order = ask.dir !== null ? [ask.dir, ...blank, ...doors].filter((d, i, a) => a.indexOf(d) === i)
        : [...blank, ...doors];
      const start = Math.floor(roll(room.vnum, k, 5) * order.length);
      const walls = ask.dir !== null ? order : [...order.slice(start % Math.max(1, blank.length)), ...order.slice(0, start % Math.max(1, blank.length))];
      const alongs = /\bcorner\b/i.test(ask.why) ? [3.3, -3.3, 2.6, -2.6, 1.6, -1.6, 0] : [0, 1.6, -1.6, 3.0, -3.0, 0.8, -0.8, 2.3, -2.3, 3.6, -3.6];
      for (let a = -4.2; a <= 4.21; a += 0.3) alongs.push(Math.round(a * 10) / 10);
      // "A picture ... hanging on the wall, just above the altar": over the
      // fitting, on its wall, where the floor below it is the fitting's own.
      const overWhat = ask.why.match(/\babove the (altar|fireplace|hearth|bar|counter|shelves)\b/i);
      const FIT = { altar: 'altar', fireplace: 'hearth', hearth: 'hearth', bar: 'counter', counter: 'counter', shelves: 'shelves' };
      const fitting = overWhat && here.find((d) => d.kind === 'fitting' && d.fitting === FIT[overWhat[1].toLowerCase()]);
      const above = hang && !!fitting;
      // The fitting frame's `along` runs against the world axis on the
      // south and west walls; a chimney breast and a gantry stand proud and
      // tall, so what hangs over them goes higher and further out.
      const lift = above ? { altar: [0.25, 0], hearth: [0.95, 0.5], counter: [1.0, 0.25], shelves: [1.0, 0.3] }[fitting.fitting] : [0, 0];
      if (above) {
        walls.unshift(fitting.dir);
        alongs.unshift((fitting.dir === 2 || fitting.dir === 3 ? -1 : 1) * (fitting.shift || 0));
      }
      for (const dir of walls) {
        for (const along of alongs) {
          const face = wallAt(dir, along) - 0.02 - (above && dir === fitting.dir ? lift[1] : 0) - (hang && painted ? MURAL_PROUD : 0);
          const [dx, , dz] = DIR_STEP[dir];
          const x = pos.x + dx * face + (dz ? along : 0);
          const z = pos.z + dz * face + (dx ? along : 0);
          const rotY = FACE_ROT[dir];
          const r = footprint(b, x, z, rotY, scale, depthPad);
          // The whole of it has to be on this side of the wall's ends.
          const span = Math.abs(dz ? along : along) + (b.max.x - b.min.x) * scale / 2;
          if (span > (outside ? HALF : ROOM / 2) - 0.25) continue;
          // A torch's bracket stands 0.7 m off its wall: test the whole
          // depth, and a hand's breadth either side of the flame.
          const reach = { x0: r.x0 - Math.abs(dz) * 0.3 - Math.abs(dx) * 1.2, x1: r.x1 + Math.abs(dz) * 0.3 + Math.abs(dx) * 1.2,
            z0: r.z0 - Math.abs(dx) * 0.3 - Math.abs(dz) * 1.2, z1: r.z1 + Math.abs(dx) * 0.3 + Math.abs(dz) * 1.2 };
          if (torches.some((t) => t.x > reach.x0 && t.x < reach.x1 && t.z > reach.z0 && t.z < reach.z1)) continue;
          // On the wall of a way up or down ("a small plaque is on this
          // wall"): no lane walks through it at floor level, but the steps
          // stand against it, so beside them, never sunk in a tread.
          const wayWall = !!ask.way && dir === ask.dir;
          if (wayWall) {
            if (Math.abs(along) < 1.5 || keep.some((q) => q !== lanes[dir] && overlaps(r, q))) continue;
            const bottom = pos.y + b.min.y * scale;
            const wide = (c) => Math.max(c.x1 - c.x0, c.z1 - c.z0) > 3;
            if (colliders.some((c) => !wide(c) && c.y1 > bottom && c.y0 < pos.y + b.max.y * scale && overlaps(r, c, 0.1))) continue;
          } else if (hang ? (!above && !clear(r, false)) : !clear(r)) continue;
          // A barrel under a painting is where barrels go; a cupboard in
          // front of one is not.
          if (hang && !high && blocked.some((q) => overlaps(r, q, -0.05) && !solid.includes(q) && (q.h ?? 9) > 1.2)) continue;
          // Nothing tall between it and the room: a temple's columns stand
          // 2.5 m off the wall, and a picture behind one is no picture.
          if (hang && !high) {
            const view = { x0: Math.min(r.x0, x - dx * 3), x1: Math.max(r.x1, x - dx * 3), z0: Math.min(r.z0, z - dz * 3), z1: Math.max(r.z1, z - dz * 3) };
            if ((small.get(cellOf(pos.x, pos.z)) || []).some((q) => q.h > 1.6 && Math.abs(q.y - pos.y) < 2 && overlaps(view, q, -0.05))) continue;
          }
          return { x, z, rotY, dir, r, y: pos.y + (above && dir === fitting.dir ? lift[0] : 0) };
        }
      }
      return null;
    };

    // Out on the floor, off the middle: every clear spot on a 25 cm grid,
    // best first by how near it is to the distance wanted from the middle.
    // A ring of candidates missed the strips a staircase leaves either side
    // of itself, which is all the floor a tomb has.
    const onFloor = (name, k, { pad = 0.3, ring = [2.4], spinAny = false, scale = 1, flat = false } = {}) => {
      const b = library.get(name)?.bounds;
      if (!b) return null;
      const want = ring[0];
      const lim = (outside ? HALF : ROOM / 2 + 0.6);
      const spots = [];
      for (let gx = -lim; gx <= lim + 1e-6; gx += 0.25) {
        for (let gz = -lim; gz <= lim + 1e-6; gz += 0.25) {
          const d = Math.hypot(gx, gz);
          if (d < 1.2) continue;
          spots.push({ gx, gz, score: Math.abs(d - want) + roll(room.vnum * 7 + k, gx * 4, gz * 4) * 0.9 });
        }
      }
      spots.sort((p1, p2) => p1.score - p2.score);
      for (const { gx, gz } of spots) {
        const x = pos.x + gx; const z = pos.z + gz;
        const facing = Math.abs(gx) > Math.abs(gz) ? Math.PI / 2 : 0;
        for (const rotY of spinAny ? [roll(room.vnum, k, gx * 4 + gz) * Math.PI * 2] : [facing, facing + Math.PI / 2]) {
          const r = footprint(b, x, z, rotY, scale, pad);
          if (!clear(r, true, flat)) continue;
          return { x, z, rotY, r: footprint(b, x, z, rotY, scale) };
        }
      }
      return null;
    };

    const strewn = []; // local rects, for the barrels in actors.js
    let tableAt = null; // the table `seated` set down, for what stands on it
    for (const ask of asks) {
      if (ask.outdoor && !outside) continue;
      if (ask.indoor && outside) continue;
      if (ask.kind === 'well' && room.exits && room.exits[5]) continue; // the way down is its well already
      if (ask.kind === 'shackles' && shellKind === 'dungeon') continue;
      const spec = KINDS[ask.kind];
      if (ask.kind === 'giant_chain') { placeChain(); continue; }
      if (ask.kind === 'fire_ring') { fireRing(); continue; }
      if (ask.kind === 'statue_odin') { statueBehindAltar('statue_odin'); continue; }
      if (ask.kind === 'wall_faces') { wallFaces(ask); continue; }
      if (ask.kind === 'ground_flames') { groundFlames(); continue; }
      if (ask.kind === 'statue_imp') { pointing('statue_imp'); continue; }
      if (ask.kind === 'figurine_dragons') { onTable('figurine_dragons'); continue; }
      if (ask.at === 'corner') { corners(ask); continue; }
      if (ask.kind === 'chair' && here.some((d) => d.kind === 'piece' && /chair/.test(d.piece))) continue;
      if (ask.kind === 'skeleton_seated') { seated(ask); continue; }
      if (ask.kind === 'candles') { candles(); continue; }
      if (!spec) continue;
      const n = Math.max(1, ask.count);
      for (let k = 0; k < n; k++) {
        const name = ask.kind === 'painting' ? paintingModel(ask.why, k)
          : spec.models[Math.floor(roll(room.vnum, k, 3) * spec.models.length)];
        if (!library.get(name)) continue;
        let at = null;
        if (ask.at === 'hang' || (ask.kind === 'web' && !outside)) {
          const scale = ask.kind === 'web' ? 0.42 : 1;
          at = onWall(name, ask, k, { hang: !spec.solid, depthPad: 0.02, scale });
          if (at) {
            // What the mud says you see when you look at it, for E: the
            // plaque's credits to Hatchet, Kahn and Furey.
            const extra = (room.extra || []).find((e) => e.keyword.split(/\s+/).some((w) => w.toLowerCase() === ask.kind));
            const b = extra && library.get(name).bounds;
            put(name, at.x, at.z, at.rotY, {
              scale, collide: !!spec.solid, y: at.y,
              examine: extra ? { title: ask.kind, body: extra.description.trim(), y: at.y + ((b.min.y + b.max.y) / 2) * scale } : null,
            });
            take(at.r, !!spec.solid);
            if (ask.kind === 'cocoon' || ask.kind === 'web') ask.dir = null;
          }
        } else if (ask.at === 'wall') {
          at = onWall(name, ask, k, { depthPad: 0.1 }) || onFloor(name, k, { pad: 0.2, ring: [3.2] });
          if (at) { put(name, at.x, at.z, at.rotY, { collide: true }); take(at.r, true); }
          // Gold is a mirror, and in a dark lair a mirror of nothing is
          // black: it needs a light of its own to glint by.
          if (at && ask.kind === 'treasure') {
            const f = [Math.sin(at.rotY), Math.cos(at.rotY)];
            lights.push({ x: at.x + f[0] * 1.6, y: pos.y + 1.4, z: at.z + f[1] * 1.6, color: 0xffc46a, intensity: 7, radius: 8 });
          }
        } else if (ask.at === 'floor' || ask.at === 'centre' || ask.at === 'mark') {
          const ring = ask.at === 'mark' ? [1.9, 2.4, 1.5] : ask.at === 'centre' ? [2.0, 2.5, 3.0] : [2.4, 3.0, 1.9, 3.4];
          at = onFloor(name, k, { pad: ask.at === 'mark' ? -0.3 : (spec.pad ?? 0.3), ring });
          if (at) {
            put(name, at.x, at.z, at.rotY, { collide: !!spec.solid });
            take(at.r, !!spec.solid);
            if (ask.kind === 'globe') lights.push({ x: at.x, y: pos.y + 1.2, z: at.z, color: 0xa8b4ff, intensity: 6, radius: 9 });
          }
        } else if (ask.at === 'strew') {
          // What lies flat is walked over: it may lie in a doorway's lane.
          // Garbage heaps up at the sides of a street, into its lanes but
          // never across the middle of one; a heap is walked round.
          const heap = !!spec.solid;
          const scale = heap ? 0.75 : 1;
          at = onFloor(name, k + 7, { pad: 0.05, ring: [2.4 + (k % 3) * 0.8], spinAny: true, flat: heap ? 'core' : FLAT.has(ask.kind), scale });
          if (at) { put(name, at.x, at.z, at.rotY, { scale, collide: heap }); keep.push(at.r); if (heap) blocked.push(at.r); }
        } else if (ask.at === 'edge' || ask.kind === 'web') {
          at = edge(name, ask, k);
        }
        if (!at) missed.push(`${vnum} ${ask.kind} ${name}`);
        if (at && at.r) strewn.push({ x0: at.r.x0 - pos.x, x1: at.r.x1 - pos.x, z0: at.r.z0 - pos.z, z1: at.r.z1 - pos.z });
      }
    }
    // The barrels actors.js stacks against the walls keep out of all of it.
    const loose = here.find((d) => d.kind === 'clutter' && d.x === pos.x && d.z === pos.z);
    if (loose && strewn.length) loose.busy = [...(loose.busy || []), ...strewn];

    // --- the special cases ---------------------------------------------

    // Out of doors, towards a side with no way out of it: a ruin, a web.
    function edge(name, ask, k) {
      const b = library.get(name).bounds;
      const blank = [0, 1, 2, 3].filter((d) => !sides[d]);
      const web = ask.kind === 'web';
      // A web goes across the path first -- "crossing the path just out of reach".
      const ways = web && k === 0 ? [0, 1, 2, 3].filter((d) => sides[d]) : [];
      for (const dir of [...ways, ...blank, ...[0, 1, 2, 3]]) {
        const [dx, , dz] = DIR_STEP[dir];
        if (web) {
          const x = pos.x + dx * 3.6; const z = pos.z + dz * 3.6;
          put(name, x, z, FACE_ROT[dir], { y: pos.y + (ways.includes(dir) ? 0.9 : 0.2) });
          return { r: null };
        }
        if (sides[dir]) continue;
        // Between the lane in from the ways out and the edge of the cell,
        // turned whichever way fits, and made smaller if it has to be.
        const inner = 2.1;
        const outer = wallAt(dir, 0) - 0.15;
        for (const turn of [0, Math.PI / 2]) {
          const rotY = FACE_ROT[dir] + turn + (roll(room.vnum, k, dir) - 0.5) * 0.2;
          const f0 = footprint(b, 0, 0, rotY);
          const depth = dx ? f0.x1 - f0.x0 : f0.z1 - f0.z0;
          const scale = Math.min(1, (outer - inner) / depth);
          if (scale < 0.65) continue;
          for (const along of [0, 1.6, -1.6, 2.8, -2.8]) {
            // Centre so the footprint's near edge sits on the lane.
            const near = dx ? (dx > 0 ? f0.x0 : -f0.x1) : (dz > 0 ? f0.z0 : -f0.z1);
            const out = inner - near * scale;
            const x = pos.x + dx * out + (dz ? along : 0); const z = pos.z + dz * out + (dx ? along : 0);
            const r = footprint(b, x, z, rotY, scale, 0.1);
            // Reeds and tussocks grow through a ruin; only what is solid stops one.
            if (keep.some((q) => overlaps(r, q)) || solid.some((q) => overlaps(r, q, -0.02))) continue;
            put(name, x, z, rotY, { collide: true, scale });
            take(r, true);
            return { r };
          }
        }
      }
      return null;
    }

    // "Around the table five skeletons are siting."
    function seated(ask) {
      const b = { min: { x: -1.15, z: -1.15 }, max: { x: 1.15, z: 1.15 } };
      let spot = null;
      for (const radius of [1.9, 2.5, 3.0]) {
        for (let i = 0; i < 12 && !spot; i++) {
          const a = (i * Math.PI) / 6 + 0.3;
          const x = pos.x + Math.cos(a) * radius; const z = pos.z + Math.sin(a) * radius;
          const r = footprint(b, x, z, 0, 1, 0.3);
          if (clear(r)) spot = { x, z, r };
        }
        if (spot) break;
      }
      if (!spot) return;
      const spin = roll(room.vnum, 1, 17) * 0.4 - 0.2;
      decor.push({ kind: 'table', x: spot.x, y: pos.y, z: spot.z, spin });
      tableAt = { x: spot.x, z: spot.z, spin };
      take(spot.r, true);
      const c2 = Math.cos(spin); const s2 = Math.sin(spin);
      let n = Math.min(4, ask.count);
      for (const side of [-1, 1]) {
        for (const lx of [-0.3, 0.3]) {
          if (n-- <= 0) break;
          const lz = side * 0.77;
          put('clutter_skeleton_seated', spot.x + lx * c2 + lz * s2, spot.z - lx * s2 + lz * c2,
            spin + (side > 0 ? Math.PI : 0) + (roll(room.vnum, lx * 10, side) - 0.5) * 0.3);
        }
      }
      // The fifth has slid off his bench and lies at the table's end.
      if (ask.count > 4) {
        const at = onFloor('clutter_skeleton', 31, { pad: 0.05, ring: [1.6, 2.3, 3.0], spinAny: true });
        if (at) { put('clutter_skeleton', at.x, at.z, at.rotY); keep.push(at.r); }
      }
      strewn.push({ x0: spot.r.x0 - pos.x, x1: spot.r.x1 - pos.x, z0: spot.r.z0 - pos.z, z1: spot.r.z1 - pos.z });
    }

    // "A large burning candle stands directly on the table surface."
    function candles() {
      const table = here.find((d) => d.kind === 'piece' && (d.piece === 'worktable' || d.piece === 'desk'))
        || here.find((d) => d.kind === 'table');
      if (!table || !library.get('furn_candle')) return;
      let x = table.x; let z = table.z; let top = 0.83;
      if (table.kind === 'piece') {
        // actors.js's fitting frame: along the wall, then out from it.
        const base = FACE_ROT[table.dir];
        const lz = -ROOM / 2 - (table.face || 0) + table.out;
        x = table.x + table.along * Math.cos(base) + lz * Math.sin(base);
        z = table.z - table.along * Math.sin(base) + lz * Math.cos(base);
        top = table.piece === 'desk' ? 0.8 : 0.83;
      }
      instances.add('furn_candle', { x: x + 0.3, y: pos.y + top, z: z + 0.15, rotY: 0 }, chunk);
      lights.push({ x: x + 0.3, y: pos.y + top + 0.4, z: z + 0.15, color: 0xffb35a, intensity: 3, radius: 6, flicker: true });
      placed++;
    }

    // "There are flames surrounding you": a bed of embers and burning logs
    // along every wall, flames standing out of it, and the room lit by them.
    // Nothing in the doorway lanes -- a way out is kept whatever the prose
    // says about it -- and nothing at the arrival point.
    function fireRing() {
      const bed = library.get('fire_bed');
      for (let d = 0; d < 4; d++) {
        const [dx, , dz] = DIR_STEP[d];
        const face = wallAt(d, 0) - 0.02;
        const rotY = FACE_ROT[d];
        for (const along of [-3.2, 0, 3.2]) {
          if (sides[d] && Math.abs(along) < 2.4) continue;
          const x = pos.x + dx * face + (dz ? along : 0); const z = pos.z + dz * face + (dx ? along : 0);
          if (bed) {
            const r = put('fire_bed', x, z, rotY, { collide: true });
            if (r) take(r, true);
          }
        }
        // The flames: tall tongues out of the back of the bed, close enough to
        // run together, and short ones licking along its front.
        for (const [step, back, lo, hi] of [[0.42, 0.45, 1.6, 2.9], [0.6, 0.78, 0.7, 1.4]]) {
          for (let a = -4.5; a <= 4.51; a += step) {
            if (sides[d] && Math.abs(a) < 2.4) continue;
            const j = roll(room.vnum, d * 131 + Math.round(a * 100), Math.round(step * 100));
            const out = face - back - j * 0.12;
            const along = a + (j - 0.5) * step * 0.6;
            decor.push({
              kind: 'torch', bare: true, blaze: lo + (hi - lo) * roll(room.vnum, d * 7 + Math.round(a * 100), 29),
              x: pos.x + dx * out + (dz ? along : 0), y: pos.y - 0.02, z: pos.z + dz * out + (dx ? along : 0),
            });
          }
        }
        lights.push({
          x: pos.x + dx * (face - 1.1), y: pos.y + 1.1, z: pos.z + dz * (face - 1.1),
          color: 0xff6424, intensity: 12, radius: 11, flicker: true,
        });
      }
      placed++;
    }

    // "Behind it is a ten foot tall sitting statue": against the altar's own
    // wall, centred on it, facing out over it. Its plinth is STATUE_DEPTH deep
    // and build.js brought the altar that far out.
    function statueBehindAltar(name) {
      const altar = here.find((d) => d.kind === 'fitting' && d.fitting === 'altar');
      const asset = library.get(name);
      if (!altar || !asset) { missed.push(`${vnum} ${name} (no altar to stand behind)`); return; }
      const dir = altar.dir;
      const [dx, , dz] = DIR_STEP[dir];
      // The fitting frame's `along` runs against the world axis on the south
      // and west walls.
      const along = (dir === 2 || dir === 3 ? -1 : 1) * (altar.shift || 0);
      const back = STATUE_DEPTH / 2;
      const face = wallAt(dir, along) - back - 0.01;
      const x = pos.x + dx * face + (dz ? along : 0); const z = pos.z + dz * face + (dx ? along : 0);
      const rotY = FACE_ROT[dir];
      put(name, x, z, rotY, { collide: true, far: true });
      take(footprint(asset.bounds, x, z, rotY), true);
      // Lit from in front and above, the way a cult statue is: a warm light
      // over the altar, clear of the figure, so the face is not only lit by
      // the wall torches at its sides.
      lights.push({ x: x - dx * 3.2, y: pos.y + 4.2, z: z - dz * 3.2, color: 0xffd6a0, intensity: 7, radius: 9 });
    }

    // "Faces are staring at you from inside the walls": carved heads pushing
    // out of the masonry, scattered along every wall at uneven heights.
    function wallFaces(ask) {
      const n = Math.max(ask.count, 7);
      for (let k = 0; k < n; k++) {
        const at = onWall('relief_face', ask, k * 3 + 1, { hang: true, depthPad: 0.02 });
        if (!at) { missed.push(`${vnum} wall_faces relief_face`); continue; }
        const lift = (roll(room.vnum, k, 41) - 0.35) * 1.1;
        const scale = 0.9 + roll(room.vnum, k, 43) * 0.3;
        put('relief_face', at.x, at.z, at.rotY + (roll(room.vnum, k, 47) - 0.5) * 0.25, { y: at.y + lift, scale });
        // A face's neighbour is a hand's breadth further along, not on top of it.
        keep.push({ x0: at.r.x0 - 0.5, x1: at.r.x1 + 0.5, z0: at.r.z0 - 0.5, z1: at.r.z1 + 0.5 });
      }
    }

    // "A statue of a imp, pointing to the west": its arm is its own right,
    // three's -X at rotY 0, so it stands unturned whatever floor it gets --
    // facing south, pointing west.
    function pointing(name) {
      const b = library.get(name)?.bounds;
      if (!b) return;
      const lim = ROOM / 2 - 0.4;
      let best = null;
      for (let gx = -lim; gx <= lim; gx += 0.25) {
        for (let gz = -lim; gz <= lim; gz += 0.25) {
          const d = Math.hypot(gx, gz);
          if (d < 1.4) continue;
          const r = footprint(b, pos.x + gx, pos.z + gz, 0, 1, 0.3);
          if (!clear(r)) continue;
          // Towards the middle of the room, with its back to the east wall
          // side it points away from.
          const score = Math.abs(d - 2.6) + (gx < 0 ? 0.8 : 0) + roll(room.vnum, gx * 4, gz * 4) * 0.3;
          if (!best || score < best.score) best = { x: pos.x + gx, z: pos.z + gz, score };
        }
      }
      if (!best) { missed.push(`${vnum} ${name}`); return; }
      const r = put(name, best.x, best.z, 0, { collide: true });
      take(r, true);
      lights.push({ x: best.x + 0.8, y: pos.y + 2.2, z: best.z + 1.2, color: 0xffc890, intensity: 3, radius: 5 });
    }

    // On the table the room already has: the one its skeletons sit round,
    // or any other. "It is nailed onto the table", in the middle of it.
    function onTable(name) {
      const t = tableAt || here.find((d) => d.kind === 'table');
      if (!t || !library.get(name)) { missed.push(`${vnum} ${name} (no table)`); return; }
      put(name, t.x, t.z, (t.spin || 0) + 0.4, { y: pos.y + 0.83 });
      // "The eyes of the red dragon is glowing pulsating red."
      lights.push({ x: t.x, y: pos.y + 1.05, z: t.z, color: 0xff2a14, intensity: 0.5, radius: 1.6, flicker: true });
    }

    // "Small flames sometimes shoot up from the hot mud": a few low fires
    // scattered over the floor, off the way through, and their light.
    function groundFlames() {
      let k = 0;
      for (let tries = 0; tries < 40 && k < 5; tries++) {
        const a = roll(room.vnum, tries, 61) * Math.PI * 2;
        const r = 1.8 + roll(room.vnum, tries, 67) * 2.6;
        const x = pos.x + Math.cos(a) * r; const z = pos.z + Math.sin(a) * r;
        const spot = { x0: x - 0.4, x1: x + 0.4, z0: z - 0.4, z1: z + 0.4 };
        if (!clear(spot)) continue;
        keep.push(spot);
        decor.push({ kind: 'torch', bare: true, blaze: 0.7 + roll(room.vnum, tries, 71) * 0.6, x, y: pos.y - 0.05, z });
        if (k % 2 === 0) lights.push({ x, y: pos.y + 0.7, z, color: 0xff6a2a, intensity: 6, radius: 7, flicker: true });
        k++;
      }
      if (k) placed++;
    }

    // Out of doors, on whatever ground the room has that is not road: the
    // angles between the ways out on open ground, the dead end of a street
    // whose sides are built up to 3.3 m from its middle. Every spot on a
    // 25 cm grid clear of the lanes and a crown's breadth off any wall, the
    // nearest to `ideal` from the middle first; a second one as far from the
    // first as it can be -- "on both sides of the road".
    function corners(ask) {
      const models = {
        tree: ['tree_oak'], evergreens: ['tree_fir', 'tree_cedar', 'tree_fir', 'tree_pine'], signpost: ['signpost'],
        hell_plants: ['tree_snag', 'bramble', 'fern', 'fungus_cluster'],
        carved_tree: ['tree_fir', 'tree_pine', 'tree_cedar'],
        tents: ['tent_roof'],
      }[ask.kind];
      const sign = ask.kind === 'signpost';
      const TENT = 0.34; // of the 10 m pavilion: a 3.4 m tent, 1.5 m to the ridge
      const tent = ask.kind === 'tents';
      const trunk = sign ? 0.25 : tent ? 5 * TENT + 0.1 : 0.5;
      const reachWall = sign ? 0.2 : 0.6;
      const ideal = sign ? 2.6 : tent ? 3.6 : 4.0;
      const want = ask.kind === 'evergreens' ? Math.min(4, Math.max(2, ask.count)) : ask.kind === 'hell_plants' ? 4
        : ask.kind === 'carved_tree' || tent ? 3 : 1;
      const mine = [];
      for (let k = 0; k < want; k++) {
        let best = null;
        for (let gx = -5.75; gx <= 5.76; gx += 0.25) {
          for (let gz = -5.75; gz <= 5.76; gz += 0.25) {
            const x = pos.x + gx; const z = pos.z + gz;
            const r = { x0: x - trunk, x1: x + trunk, z0: z - trunk, z1: z + trunk };
            if (keep.some((q) => overlaps(r, q))) continue;
            if (blocked.some((q) => overlaps(r, q, reachWall))) continue;
            const apart = mine.length ? Math.min(...mine.map((m) => Math.hypot(m.x - x, m.z - z))) : 0;
            const score = Math.abs(Math.hypot(gx, gz) - ideal) - apart * 0.6 + roll(room.vnum, gx * 4, gz * 4 + k) * 0.4;
            if (!best || score < best.score) best = { x, z, r, gx, gz, score };
          }
        }
        if (!best) break;
        // The first of a carved stand is the fir the words are cut in.
        const name = ask.kind === 'carved_tree' ? models[k % models.length] : models[(k + room.vnum) % models.length];
        if (!library.get(name)) break;
        const { x, z, r, gx, gz } = best;
        const scale = sign ? 1 : tent ? TENT : 0.8 + roll(room.vnum, k, 79) * 0.35;
        // A signpost's arms point along the roads, not into a wall.
        const rotY = sign ? Math.atan2(gx, gz) + Math.PI / 4 : tent ? 0 : roll(room.vnum, k, 83) * Math.PI * 2;
        instances.add(name, { x, y: pos.y, z, rotY, scale }, chunk);
        if (tent) {
          // Walls all round, the one facing the middle of the camp open.
          const face = Math.abs(gx) > Math.abs(gz) ? (gx > 0 ? 3 : 1) : (gz > 0 ? 0 : 2);
          for (let d = 0; d < 4; d++) instances.add(d === face ? 'tent_wall_door' : 'tent_wall', { x, y: pos.y, z, rotY: FACE_ROT[d], scale: TENT }, chunk);
        }
        where.push({ vnum, name, x: +x.toFixed(2), y: +pos.y.toFixed(2), z: +z.toFixed(2), rotY: +rotY.toFixed(2) });
        // A trunk or a post is walked round, not along a box's side.
        if (tent) addCollider(r.x0, r.x1, r.z0, r.z1, pos.y, pos.y + 4);
        else ctx.colliders.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y0: pos.y, y1: pos.y + 4, r: sign ? 0.18 : 0.42 * scale });
        take(r, true);
        mine.push({ x, z });
        placed++;
        // The words, on the first tree, cut into the side facing the way
        // through: a blaze of pale wood at eye height.
        const words = ask.kind === 'carved_tree' && k === 0 && ask.why.match(/"([^"]+)"/);
        if (words && ctx.words && name === 'tree_fir') {
          // tree_fir's bark stands 0.53 m out at eye height (measured off
          // the model); the words are wrapped round it, a hair proud.
          const toward = Math.atan2(pos.x - x, pos.z - z);
          if (ctx.words([words[1]], room.vnum, x, pos.y + 1.55, z, toward, 0.5, 0.22, chunk, 0.51 * scale)) {
            where.push({ vnum, name: 'words', x: +x.toFixed(2), y: +(pos.y + 1.55).toFixed(2), z: +z.toFixed(2), rotY: +toward.toFixed(2) });
          }
        }
      }
      if (!mine.length) missed.push(`${vnum} ${ask.kind}`);
    }

    // "The chain reaches the clouds high above you."
    function placeChain() {
      const anchor = library.get('clutter_chain_anchor');
      const run = library.get('clutter_chain_run');
      if (!anchor || !run) return;
      // Not on the middle of the crossing: that is where you arrive.
      const x = pos.x + 3.1; const z = pos.z - 3.1;
      put('clutter_chain_anchor', x, z, 0.3, { collide: true });
      // clutter.py: eight links a run at a 1.02 m pitch, the anchor's own
      // link centred 1.6 m up and turned across the first of them.
      const pitch = 1.02 * 8;
      const base = pos.y + 1.6 + 1.02 - 0.51;
      // Five runs, up into the cloud actors.js heaps round its end: sixteen
      // were 130 m of chain, a line down from the top of every frame that
      // could see it, and the prose has it vanish into the clouds.
      const RUNS = 5;
      for (let i = 0; i < RUNS; i++) instances.add('clutter_chain_run', { x, y: base + i * pitch, z, rotY: 0.3 }, chunk);
      decor.push({ kind: 'chainMist', x, y: base + (RUNS - 1.6) * pitch, z, top: base + RUNS * pitch });
      addCollider(x - 0.5, x + 0.5, z - 0.5, z + 0.5, pos.y, pos.y + 12);
      strewn.push({ x0: 1.8, x1: 4.4, z0: -4.4, z1: -1.8 });
      placed++;
    }
  }
  return { placed, missed, where };
}

function markIndoor(asset, BufferAttribute) {
  if (!asset) return;
  for (const { geometry } of asset.primitives) {
    if (geometry.getAttribute('aIndoor')) continue;
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('aIndoor', new BufferAttribute(new Float32Array(count).fill(1), 1));
  }
}
