// Adds the second wave of recorded one-shots (combat, doors, purse, spells, creatures,
// positional loops) to assets/audio/manifest.json as entries without audio; run
// generate.mjs afterwards to make the files. An id already in the manifest has its prompt and settings refreshed.
//   node tools/audio/add-clips.mjs
// A "sheet" is one generation of several separate sounds, cut into variants (see generate.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'audio', 'manifest.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));

/** [id, group, seconds, prompt, post] -- a sheet when post.sheet is set. */
const SHEETS = [
  // combat
  ['cmb_hit_flesh', 'combat', 8, 'Six separate blows of a sword cutting into flesh and leather, each a short dull wet slash with a thump, one blow about every 1.2 seconds, close microphone, dry room, no voices.', { sheet: true, stepGap: 0.7, stepMax: 0.7 }],
  ['cmb_hit_stab', 'combat', 8, 'Six separate stabs of a dagger into flesh and leather, each a quick sharp puncture with a small wet sound, with a full second of silence between stabs, close microphone, dry room, no voices.', { sheet: true, stepGap: 0.7, stepMax: 0.6 }],
  ['cmb_hit_claw', 'combat', 8, 'Six separate attacks of a wild animal tearing with claws and teeth at leather and flesh, each a short ripping scratch and a snap, with a full second of silence between, close microphone, dry room, no growling.', { sheet: true, stepGap: 0.7, stepMax: 0.7 }],
  ['cmb_hit_blunt', 'combat', 8, 'Six separate hits of a wooden club thudding into a body, each a heavy dull thump with a short crunch, one about every 1.2 seconds, close microphone, dry room, no voices.', { sheet: true, stepGap: 0.7, stepMax: 0.7 }],
  ['cmb_hit_armour', 'combat', 8, 'Six separate sword blows landing on a steel breastplate, each a short metallic clank with a dull thud underneath, with a full second of silence between blows, close microphone, dry room, no voices.', { sheet: true, stepGap: 0.8, stepMax: 0.9 }],
  ['cmb_parry', 'combat', 10, 'Six separate clashes of two steel swords meeting, each a sharp bright strike with a ringing tail that fades, one about every 1.6 seconds, outdoors, close microphone, no voices.', { sheet: true, stepGap: 1.0, stepMax: 1.4 }],
  ['cmb_swing', 'combat', 6, 'Six separate quick sword swings through the air, each a thin swish of a blade, one about every second, close microphone, dry, no impact, no voices.', { sheet: true, stepGap: 0.6, stepMax: 0.5 }],
  ['cmb_dodge', 'combat', 5, 'Five separate quick sidesteps of a person on packed dirt, a scuff of boots and a brush of cloth, one about every second, close microphone, dry.', { sheet: true, stepGap: 0.6, stepMax: 0.5 }],
  ['cmb_death_human', 'combat', 10, 'Four separate death cries of a man struck down in a medieval fight, a short pained shout that trails into a last gasp, one about every 2.5 seconds, no words, close microphone, dry.', { sheet: true, stepGap: 1.5, stepMax: 1.8 }],
  ['cmb_death_beast', 'combat', 10, 'Four separate dying cries of a large wild animal, a snarling roar that sinks into a low rattling breath, one about every 2.5 seconds, close microphone, dry, no words.', { sheet: true, stepGap: 1.5, stepMax: 1.8 }],
  ['cmb_death_small', 'combat', 6, 'Five separate short dying squeals of a small animal, rat or bird-sized, high and thin and cut off, one about every 1.2 seconds, close microphone, dry.', { sheet: true, stepGap: 0.7, stepMax: 0.8 }],
  ['cmb_bodyfall', 'combat', 6, 'Four separate sounds of a heavily armed man collapsing onto packed earth, a heavy thud then a short clatter of mail and metal, one about every 1.5 seconds, close microphone, dry.', { sheet: true, stepGap: 0.9, stepMax: 1.0 }],
  ['cmb_pain', 'combat', 6, 'Five separate short grunts of a man struck in the body, a breathy hnh of pain, one about every 1.2 seconds, no words, close microphone, dry.', { sheet: true, stepGap: 0.7, stepMax: 0.6 }],
  ['ui_levelup', 'ui', 4, 'A short medieval fanfare on two natural trumpets, three rising notes then a held fourth, bright and brief, outdoors, no drums, no other instruments.', { peakDb: -4 }],
  // second sheets of what is heard most, so no blow repeats within a fight
  ['cmb_hit_flesh_b', 'combat', 8, 'Six separate heavy sword chops into a body, each a deep meaty thwack with a short wet tail, with a full second of silence between blows, close microphone, dry room, no voices.', { sheet: true, stepGap: 0.7, stepMax: 0.7 }],
  ['cmb_hit_blunt_b', 'combat', 8, 'Six separate heavy mace blows against a body in leather, each a dull crunching thud, with a full second of silence between blows, close microphone, dry room, no voices.', { sheet: true, stepGap: 0.7, stepMax: 0.7 }],
  ['cmb_parry_b', 'combat', 10, 'Five separate sword on sword parries, a quick scrape of steel and a short ring, each followed by a full second of silence, outdoors, close microphone, no voices.', { sheet: true, stepGap: 1.0, stepMax: 1.2 }],
  ['cmb_swing_b', 'combat', 6, 'Six separate heavy axe or sword swings through the air, a low whoosh of a big blade, each followed by a second of silence, close microphone, dry, no impact.', { sheet: true, stepGap: 0.6, stepMax: 0.6 }],
  ['cmb_death_human_b', 'combat', 10, 'Four separate groans of a dying man falling, a choked cry and a long exhale, each followed by two seconds of silence, no words, close microphone, dry.', { sheet: true, stepGap: 1.5, stepMax: 2.0 }],
  ['dr_open_b', 'door', 10, 'Three separate heavy oak doors being pushed open, a low groan of dry hinges and a scrape on a stone floor, each followed by two seconds of silence, indoors, close microphone.', { sheet: true, stepGap: 1.6, stepMax: 2.6 }],
  ['dr_close_b', 'door', 8, 'Three separate wooden doors being shut firmly, a solid thunk of oak against a frame and a latch drop, each followed by two seconds of silence, indoors, close microphone.', { sheet: true, stepGap: 1.4, stepMax: 2.0 }],
  ['sv_coins_b', 'verb', 8, 'Four separate sounds of a few gold coins being counted into a hand, a soft metallic clink, each followed by a second of silence, close microphone, dry.', { sheet: true, stepGap: 0.7, stepMax: 0.8 }],
  // doors, locks, small verbs
  ['dr_open', 'door', 10, 'Three separate old wooden doors being opened, each a latch click then a slow creaking hinge ending in a soft bump, one about every 3 seconds, indoors, close microphone.', { sheet: true, stepGap: 1.6, stepMax: 2.6 }],
  ['dr_close', 'door', 8, 'Three separate heavy wooden doors being closed, each a creak then a solid thud and a latch click, one about every 2.5 seconds, indoors, close microphone.', { sheet: true, stepGap: 1.4, stepMax: 2.0 }],
  ['dr_unlock', 'door', 8, 'Four separate sounds of a large iron key turning in a lock, a scrape then a heavy clunk of the bolt, one about every 2 seconds, close microphone, dry.', { sheet: true, stepGap: 1.1, stepMax: 1.4 }],
  ['dr_lockpick', 'door', 5, 'Lockpicking: delicate metal scraping and tiny clicks of tumblers, ending with a lock springing open, close microphone, dry.', { peakDb: -5 }],
  ['sv_coins', 'verb', 6, 'Five separate small handfuls of gold coins dropped into a leather purse, each a short bright jingle, one about every 1.2 seconds, close microphone, dry.', { sheet: true, stepGap: 0.7, stepMax: 0.8 }],
  ['sv_pickup', 'verb', 8, 'Five separate sounds of picking an object up off a wooden table, a rustle of cloth and leather and a soft grasp, with two seconds of silence between each, close microphone, dry.', { sheet: true, stepGap: 0.6, stepMax: 0.6 }],
  ['sv_drop', 'verb', 8, 'Five separate sounds of dropping a leather pouch onto a stone floor, a soft thud and clack, with two seconds of silence between each, close microphone, dry.', { sheet: true, stepGap: 0.6, stepMax: 0.6, stepMin: 0.05 }],
  ['sv_eat', 'verb', 5, 'A person biting into a crisp apple and chewing, three bites, close microphone, dry, no speech.', { peakDb: -5 }],
  ['sv_drink', 'verb', 4, 'A person drinking water from a wooden cup in three big gulps, close microphone, dry, no speech.', { peakDb: -5 }],
  ['sv_fill', 'verb', 4, 'Water pouring and bubbling into a leather waterskin, close microphone, dry.', { peakDb: -5 }],
  ['sv_shopbell', 'verb', 3, 'A small brass shop bell on a spring above a door, ringing twice, bright, indoors.', { peakDb: -5 }],
  ['ui_page', 'ui', 8, 'Four separate sounds of one thick parchment page being turned, a soft dry paper rustle and flap, with two seconds of silence between each, quiet room, close microphone.', { sheet: true, stepGap: 0.7, stepMax: 0.8 }],
  ['bell_toll_a', 'bell', 12, 'A large church bell tolls once, a deep bronze strike with a long ringing decay, heard from far away across a medieval town, outdoors, wind, no other sounds.', { peakDb: -6, trimDb: -55 }],
  ['bell_toll_b', 'bell', 12, 'A medium church bell tolls once, a bronze strike with a long soft ringing decay, heard from a distance across rooftops, outdoors, no other sounds.', { peakDb: -6, trimDb: -55 }],
  // spells
  ['sp_gather', 'spell', 3, 'A rising magical shimmer with whispered arcane words and a soft airy swell that builds over two seconds, fantasy spell casting.', { peakDb: -6 }],
  ['sp_missile', 'spell', 2, 'A quick magical bolt zipping through the air with a bright whistle and a fizzing tail, short.', { peakDb: -5 }],
  ['sp_fire', 'spell', 3, 'A fireball bursting into flame with a roaring whoomph and crackling embers, outdoors, powerful.', { peakDb: -4 }],
  ['sp_lightning', 'spell', 4, 'A sharp crack of lightning followed by rolling thunder, outdoors, close.', { peakDb: -4 }],
  ['sp_frost', 'spell', 3, 'Ice crystallising, a crackling freeze with glassy tinkling shards, cold, magical.', { peakDb: -5 }],
  ['sp_acid', 'spell', 3, 'Acid sizzling and hissing on stone with small bubbling pops, close microphone.', { peakDb: -5 }],
  ['sp_heal', 'spell', 3, 'A soft warm chime of glass bell tones with a gentle ascending shimmer, healing magic, calm and bright.', { peakDb: -6 }],
  ['sp_dark', 'spell', 3, 'A low ominous magical rumble with a dark whispering swell that fades, a curse being cast.', { peakDb: -6 }],
  ['sp_rumble', 'spell', 4, 'A deep rumble of the ground shaking with falling stones, an earthquake, outdoors.', { peakDb: -4 }],
  ['sp_pop', 'spell', 2, 'A short magical pop with a sparkling glint, like a soap bubble bursting, then silence.', { peakDb: -5 }],
  ['sp_fizzle', 'spell', 2, 'A spell fizzling out, a small sputtering spark and a thin hiss that dies.', { peakDb: -6 }],
  ['sp_prism', 'spell', 3, 'A bright cascade of glass chimes shimmering upward, magical.', { peakDb: -6 }],
  ['sp_portal', 'spell', 3, 'A magical teleport, swirling air and a rising shimmer that ends in a soft pop.', { peakDb: -5 }],
  // weather
  ['wx_thunder', 'weather', 14, 'Three separate rolls of distant thunder over open land, each a low rumbling that swells and fades away slowly, with three seconds of silence between them, outdoors.', { sheet: true, stepGap: 2.0, stepMax: 6, stepMin: 1.5, peakDb: -6 }],
  ['wx_thunder_b', 'weather', 14, 'Two separate heavy thunderclaps, each a sharp crack and a long rolling boom fading into the distance, with several seconds of silence between them, outdoors.', { sheet: true, stepGap: 2.0, stepMax: 8, stepMin: 1.5, peakDb: -6 }],
  // creatures, one sheet each
  ['cr_dog', 'creature', 8, 'Four separate barks of a medium-sized dog, sharp and clear, one about every 2 seconds, outdoors, close microphone, dry.', { sheet: true, stepGap: 1.0, stepMax: 0.9 }],
  ['cr_dog_growl', 'creature', 8, 'Three separate low growls and snarls of an angry dog, each about two seconds long, close microphone, dry.', { sheet: true, stepGap: 1.5, stepMax: 2.0 }],
  ['cr_wolf', 'creature', 10, 'Two separate long howls of a lone wolf, rising and falling, about four seconds each with silence between, far away across open land at night.', { sheet: true, stepGap: 2.5, stepMax: 4.5, stepMin: 1.0 }],
  ['cr_cat', 'creature', 8, 'Four separate meows of a domestic cat, one about every 2 seconds, indoors, close microphone, dry.', { sheet: true, stepGap: 1.0, stepMax: 1.2 }],
  ['cr_rat', 'creature', 6, 'Five separate squeaks of a rat, high and thin, with a tiny scrabble of claws, one about every 1.2 seconds, close microphone, dry.', { sheet: true, stepGap: 0.7, stepMax: 0.8 }],
  ['cr_bat', 'creature', 6, 'Five separate high shrill chitters and screeches of a bat, one about every 1.2 seconds, in a cave, close microphone.', { sheet: true, stepGap: 0.7, stepMax: 0.8 }],
  ['cr_pig', 'creature', 8, 'Four separate grunts and squeals of a pig, one about every 2 seconds, farmyard, close microphone, dry.', { sheet: true, stepGap: 1.0, stepMax: 1.2 }],
  ['cr_cow', 'creature', 10, 'Three separate low moos of a cow, each about two seconds long, one about every 3 seconds, farm field, close microphone.', { sheet: true, stepGap: 1.5, stepMax: 2.4 }],
  ['cr_chicken', 'creature', 8, 'A hen clucking three times, then a rooster crowing once, farmyard, close microphone, dry.', { sheet: true, stepGap: 0.9, stepMax: 2.2 }],
  ['cr_horse', 'creature', 12, 'Three separate calls of a horse, a whinny, a snort and a neigh, each followed by three seconds of silence, stable, close microphone, dry.', { sheet: true, stepGap: 1.5, stepMax: 2.2 }],
  ['cr_snake', 'creature', 10, 'Four separate short hisses of a snake, each one second long, followed by two seconds of complete silence, close microphone, dry.', { sheet: true, stepGap: 1.0, stepMax: 1.4 }],
  ['cr_bear', 'creature', 10, 'Three separate growls and roars of a large brown bear, each about two seconds long, one about every 3 seconds, forest, close microphone.', { sheet: true, stepGap: 1.5, stepMax: 2.4 }],
  ['cr_dragon', 'creature', 14, 'Three separate roars of a huge dragon, deep and rasping, each two seconds long and followed by two seconds of silence, in a large cave.', { sheet: true, stepGap: 2.0, stepMax: 3.4, stepMin: 0.8 }],
  ['cr_frog', 'creature', 8, 'Several separate croaks of a large frog, one about every 1.5 seconds, wet marsh, close microphone.', { sheet: true, stepGap: 0.8, stepMax: 0.9 }],
  ['cr_goat', 'creature', 8, 'Four separate bleats of a goat, one about every 2 seconds, mountain pasture, close microphone, dry.', { sheet: true, stepGap: 1.0, stepMax: 1.2 }],
  ['cr_deer', 'creature', 12, 'Three separate calls of a red deer stag, each a hoarse bellowing groan followed by two seconds of silence, forest, far away.', { sheet: true, stepGap: 1.4, stepMax: 2.0 }],
  ['cr_spider', 'creature', 8, 'Four separate sounds of a giant spider, a dry clicking chitter and a rasping hiss, one about every 2 seconds, in a cave, close microphone.', { sheet: true, stepGap: 1.0, stepMax: 1.2 }],
  ['cr_beast', 'creature', 8, 'Four separate growls and snarls of a monstrous beast, deep and wet, one about every 2 seconds, in a cave, close microphone.', { sheet: true, stepGap: 1.0, stepMax: 1.4 }],
];

/** Loops that sit on an object in the world and are panned from it. */
const LOOPS = [
  ['pos_fountain', 'place', 15, 'A stone fountain in a town square, water falling and splashing into a basin, steady, close, outdoors, no voices.', -26],
  ['pos_fire', 'place', 15, 'A wood fire crackling and popping softly in a stone hearth, steady, close, indoors, no voices.', -29],
  ['wx_rain', 'weather', 15, 'Steady rain falling on grass, mud and cobblestones outdoors, a soft wide hiss with small drips, no thunder, no wind gusts, no voices.', -26],
  ['wx_rain_roof', 'weather', 15, 'Steady rain falling on a wooden shingle roof heard from inside a room, a soft patter with muffled drips and gutters, no thunder, no voices.', -27],
  ['pos_forge', 'place', 15, 'A blacksmith hammering iron on an anvil, rhythmic ringing blows, with the soft breath of a bellows and a forge fire, steady, indoors, no speech.', -26],
];

/** The source-of-truth fields of an entry; an existing entry keeps its measured ones (duration, bytes, steps ...). */
const sheetEntry = (id, group, seconds, prompt, post) => ({
  id, file: `${id}.ogg`, kind: 'sfx', api: 'sfx', group, loop: false,
  prompt: `${prompt} No other sounds, no music, no engines, no electronic hum.`,
  settings: { duration_seconds: seconds, prompt_influence: 0.8 },
  post: { peakDb: -4, kbps: 40, mono: true, ...post },
});
const loopEntry = (id, group, seconds, prompt, lufs) => ({
  id, file: `${id}.ogg`, kind: 'ambience', api: 'sfx', group, loop: true,
  prompt: `${prompt} Steady, no sudden standout events, no music, no engines, no electronic hum.`,
  settings: { duration_seconds: seconds, loop: true, prompt_influence: 0.4 },
  post: { lufs, crossfade: 1.5, kbps: 40, mono: true },
});

let added = 0;
const put = (entry) => {
  const old = manifest.clips.find((c) => c.id === entry.id);
  if (old) Object.assign(old, entry); else { manifest.clips.push(entry); added++; }
};
for (const [id, group, seconds, prompt, post] of SHEETS) put(sheetEntry(id, group, seconds, prompt, post));
for (const [id, group, seconds, prompt, lufs] of LOOPS) put(loopEntry(id, group, seconds, prompt, lufs));
writeFileSync(path, `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`added ${added} entries; ${manifest.clips.length} in the manifest`);
