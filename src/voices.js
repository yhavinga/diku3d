/**
 * Spoken words: the incantations of the casters and the fixed lines the
 * mobiles say. Every clip is a committed ElevenLabs text-to-speech clip in
 * assets/audio (`kind: 'voice'` in manifest.json, made by tools/audio/
 * add-voices.mjs + generate.mjs); nothing is synthesised at runtime, so only a
 * finite, fixed set of words can be heard. What a player types and what the
 * server relays are text only.
 *
 * Everything that maps an event to a clip is data in this file: VOICES (who
 * speaks), LINES (what the mobiles say), and `planFor`, which is pure so
 * tools/audio/voice-check.mjs can run it under bare node. Playback (position,
 * walls, ducking, caps) is the Voices class at the bottom.
 */
import { creatureOf } from './soundmap.js';
import { listen } from './foley.js';

// ------------------------------------------------------------------ voices --

/**
 * The speakers. `id` is an ElevenLabs premade voice (the API key cannot read the
 * shared library, so premade voices are what is reachable). `say` is the
 * incantation delivery -- slow, even -- and `line` the speaking one.
 */
export const VOICES = {
  mage_m: { name: 'George', id: 'JBFqnCBsd6RMkjVDRZzb', say: { stability: 0.7, similarity_boost: 0.8, style: 0.25, speed: 0.85 } },
  mage_f: { name: 'Alice', id: 'Xb7hH8MSUJpSbSDYk0k2', say: { stability: 0.7, similarity_boost: 0.8, style: 0.25, speed: 0.85 } },
  cleric_m: { name: 'Daniel', id: 'onwK4e9ZLuTAKqWW03F9', say: { stability: 0.8, similarity_boost: 0.8, style: 0.2, speed: 0.8 } },
  cleric_f: { name: 'Lily', id: 'pFZP5JQG7iQjIQuC4Bku', say: { stability: 0.8, similarity_boost: 0.8, style: 0.2, speed: 0.8 } },
  monster: { name: 'Callum', id: 'N2lVS1w4EtoT3dr4eOWO', say: { stability: 0.45, similarity_boost: 0.8, style: 0.7, speed: 0.75 } },
  witch: { name: 'Glinda', id: 'z9fAnlkpzviPz146aGWa', say: { stability: 0.5, similarity_boost: 0.8, style: 0.6, speed: 0.8 } },
  mayor: { name: 'Joseph', id: 'Zlb1dXrM653N07WRdFW3', line: { stability: 0.55, similarity_boost: 0.8, style: 0.55, speed: 0.92 } },
  guard_m: { name: 'Clyde', id: '2EiwWnXFnvU5JabPnv8n', line: { stability: 0.4, similarity_boost: 0.8, style: 0.7, speed: 1.0 } },
  guard_f: { name: 'Dorothy', id: 'ThT5KcBeYPX3keUQqHPh', line: { stability: 0.4, similarity_boost: 0.8, style: 0.7, speed: 1.0 } },
  exec: { name: 'Harry', id: 'SOYHLrjzK2X1ezoPC6cr', line: { stability: 0.35, similarity_boost: 0.8, style: 0.8, speed: 0.95 } },
  shop_m: { name: 'Brian', id: 'nPczCjzI2devNBz1zQrb', line: { stability: 0.55, similarity_boost: 0.8, style: 0.3, speed: 1.0 } },
  shop_f: { name: 'Matilda', id: 'XrExE9yKIg1WjnnlVkGX', line: { stability: 0.55, similarity_boost: 0.8, style: 0.3, speed: 1.0 } },
  folk_m: { name: 'Brian', id: 'nPczCjzI2devNBz1zQrb', line: { stability: 0.3, similarity_boost: 0.8, style: 0.7, speed: 1.05 } },
  folk_f: { name: 'Matilda', id: 'XrExE9yKIg1WjnnlVkGX', line: { stability: 0.3, similarity_boost: 0.8, style: 0.7, speed: 1.05 } },
  kid: { name: 'Gigi', id: 'jBpfuIE2acCO8z3wKNLl', line: { stability: 0.35, similarity_boost: 0.8, style: 0.6, speed: 1.05 } },
  monster_line: { name: 'Callum', id: 'N2lVS1w4EtoT3dr4eOWO', line: { stability: 0.3, similarity_boost: 0.8, style: 0.8, speed: 0.9 } },
};

// ----------------------------------------------------------------- spells ---

/** Class index (mage 0, cleric 1) by the spec_fun that makes a mobile cast: special.c's casters. The mayor casts as a cleric. */
export const CASTER_CLASS = { spec_cast_mage: 0, spec_cast_cleric: 1, spec_cast_undead: 0, spec_mayor: 1 };

/** special.c spec_cast_adept's six words, which are not say_spell's cipher but the mud's own letters reversed. */
export const ADEPT_WORDS = {
  armor: 'tehctah', bless: 'nhak', 'cure blindness': 'yeruf', 'cure light': 'garf', 'cure poison': 'rozar', refresh: 'nadroj',
};

/** Which monstrous and witchy voices say which spells: the union of the three tables in magic.js. */
export const MONSTER_SPELLS = ['blindness', 'chill touch', 'weaken', 'teleport', 'colour spray', 'change sex', 'energy drain',
  'fireball', 'acid blast', 'cause serious', 'earthquake', 'cause critical', 'dispel evil', 'curse', 'flamestrike', 'harm',
  'dispel magic', 'poison', 'gate'];

const MONSTROUS = /\b(zombie|skeleton|ghoul|wraith|wight|spectre|spectral|vampire|horror|nightgaunt|flesh eater|undead|half-decomposed|hands|eyes|shadow|slaad|beholder|mindflayer|naga|ogre|orc|troll|cyclops|minotaur|gargoyle|hobgoblin|newt|myconoid|golem|dragon|giant|ethereal|snapper|darkoth|elemental|spirit|guardian vampire)\b/i;
const WITCHY = /\b(witch|hag)\b/i;
const KID = /\b(youth|brat|kid|child|baby|boy|girl|lad|lass|urchin|smurf)\b/i;

export const spellSlug = (name) => name.replace(/ /g, '_');
export const spellClipId = (kind, spell, form) => `vo_${kind}_${spellSlug(spell)}_${form}`;
export const adeptClipId = (kind, spell) => `vo_${kind}_adept_${spellSlug(spell)}`;

const wordsOf = (slot) => `${slot.proto.keywords} ${slot.proto.short || ''}`;
/** A mobile that says its spell aloud has a voice by its sex and trade: a body that is no person's gets a monster's. */
function casterKind(slot, special) {
  const words = wordsOf(slot);
  const monstrous = MONSTROUS.test(words);
  // A cat that casts is still a cat: it has the cat's own cries and no words.
  if (!monstrous && creatureOf(words)) return null;
  if (WITCHY.test(words)) return 'witch';
  if (monstrous || slot.proto.sex === 0) return 'monster';
  const base = CASTER_CLASS[special] === 1 ? 'cleric' : 'mage';
  return `${base}_${slot.proto.sex === 2 ? 'f' : 'm'}`;
}

// ------------------------------------------------------------------ lines ---

/**
 * What the mobiles say, fixed. `re` is tried on what was said (or the log line,
 * for an emote); `speaker` names who says it, and so which voices are made for
 * it. `text` is what is spoken: the lines that carry a name or an object (the
 * guards' "<Name> is a THIEF!", the keeper's "You can't afford to buy <it>")
 * are spoken without it, because the name cannot be in a committed clip.
 */
export const LINES = [
  { key: 'mayor_honey', speaker: 'mayor', re: /Hello Honey!/, text: 'Hello, honey!' },
  { key: 'mayor_view', speaker: 'mayor', re: /What a view!/, text: 'What a view! I must do something about that dump!' },
  { key: 'mayor_vandals', speaker: 'mayor', re: /^Vandals!/, text: 'Vandals! Youngsters have no respect for anything!' },
  { key: 'mayor_day', speaker: 'mayor', re: /Good day, citizens!/, text: 'Good day, citizens!' },
  { key: 'mayor_open', speaker: 'mayor', re: /declare the city of Midgaard open!/, text: 'I hereby declare the city of Midgaard open!' },
  { key: 'mayor_closed', speaker: 'mayor', re: /declare the city of Midgaard closed!/, text: 'I hereby declare the city of Midgaard closed!' },
  { key: 'guard_thief', speaker: 'guard', re: /is a THIEF!.*BANZAI/, text: 'Thief! PROTECT THE INNOCENT! BANZAI!', shout: true },
  { key: 'guard_killer', speaker: 'guard', re: /is a KILLER!.*BANZAI/, text: 'Killer! PROTECT THE INNOCENT! BANZAI!', shout: true },
  { key: 'guard_scream', speaker: 'guard', re: /screams 'PROTECT THE INNOCENT!!\s+BANZAI/, text: 'PROTECT THE INNOCENT! BANZAI!', shout: true },
  { key: 'exec_thief', speaker: 'exec', re: /is a THIEF!.*MORE BLOOO/, text: 'Thief! PROTECT THE INNOCENT! More bloooood!', shout: true },
  { key: 'exec_killer', speaker: 'exec', re: /is a KILLER!.*MORE BLOOO/, text: 'Killer! PROTECT THE INNOCENT! More bloooood!', shout: true },
  { key: 'keeper_later', speaker: 'keeper', re: /Sorry, come back later\./, text: 'Sorry, come back later.' },
  { key: 'keeper_tomorrow', speaker: 'keeper', re: /Sorry, come back tomorrow\./, text: 'Sorry, come back tomorrow.' },
  { key: 'keeper_nosell', speaker: 'keeper', re: /I don't sell that/, text: "I don't sell that. Try list." },
  { key: 'keeper_nohave', speaker: 'keeper', re: /You don't have that item/, text: "You don't have that item." },
  { key: 'keeper_afford', speaker: 'keeper', re: /You can't afford to buy/, text: "You can't afford that." },
  { key: 'keeper_level', speaker: 'keeper', re: /You can't use .* yet\./, text: "You can't use that yet." },
  { key: 'keeper_thieves', speaker: 'keeper', re: /Thieves are not welcome!/, text: 'Thieves are not welcome!' },
  { key: 'keeper_killers', speaker: 'keeper', re: /Killers are not welcome!/, text: 'Killers are not welcome!' },
  { key: 'thief_cry', speaker: 'crowd', re: /is a bloody thief!/, text: "Thief! Thief! You're a bloody thief!", shout: true },
];

/** The voices made for each speaker role, and (below) the line's own delivery. */
export const SPEAKER_KINDS = {
  mayor: ['mayor'], guard: ['guard_m', 'guard_f'], exec: ['exec'], keeper: ['shop_m', 'shop_f'],
  crowd: ['folk_m', 'folk_f', 'kid', 'monster_line'],
};

export const lineClipId = (kind, key) => `vo_${kind}_${key}`;

function lineKind(speaker, slot) {
  const sex = slot.proto.sex;
  const words = wordsOf(slot);
  switch (speaker) {
    case 'mayor': return 'mayor';
    case 'exec': return 'exec';
    case 'guard': return sex === 2 ? 'guard_f' : 'guard_m';
    case 'keeper': return sex === 2 ? 'shop_f' : 'shop_m';
    default: // whoever was robbed
      if (KID.test(words)) return 'kid';
      if (MONSTROUS.test(words) || sex === 0) return !MONSTROUS.test(words) && creatureOf(words) ? null : 'monster_line';
      return sex === 2 ? 'folk_f' : 'folk_m';
  }
}

// ------------------------------------------------------------------- plan ---

/**
 * What an event sounds like: `{ id, slot, own, shout }` or null. `hear` is the
 * listener: `{ cls, sex }`, the player's class (mage 0, cleric 1, thief 2,
 * warrior 3) and sex. Pure on purpose.
 *
 * DIVERGES from the mud, which has the casters' spec_funs call the spell
 * directly and say nothing; here they say it, so a lair sounds like one. Only
 * the sound is added: the log still reads as Merc's.
 */
export function planFor(event, hear) {
  if (event.kind === 'cast') return castPlan(event, hear);
  const slot = event.slot;
  // Player chat is `say` with no mobile, and a remote player's `say` has none either: neither is ever voiced.
  if (!slot || !slot.proto) return null;
  const said = event.said || event.text;
  if (!said) return null;
  for (const line of LINES) {
    if (!line.re.test(said)) continue;
    // A shop line is only the keeper's if the slot is one; a theft cry is anyone's.
    if (line.speaker === 'keeper' && !(slot.record && slot.record.shop)) continue;
    if (line.speaker === 'mayor' && !(slot.record && slot.record.special === 'spec_mayor')) continue;
    const kind = lineKind(line.speaker, slot);
    if (!kind) return null;
    return { id: lineClipId(kind, line.key), slot, own: false, shout: !!line.shout, kind };
  }
  return null;
}

function castPlan(e, hear) {
  if (!['cast', 'spec'].includes(e.source) || e.lost) return null;
  if (e.fromPlayer) {
    const base = hear.cls === 0 ? 'mage' : hear.cls === 1 ? 'cleric' : null;
    if (!base) return null;
    const kind = `${base}_${hear.sex === 2 ? 'f' : 'm'}`;
    return { id: spellClipId(kind, e.spell, 'n'), slot: null, own: true, shout: false, kind };
  }
  const slot = e.from;
  if (!slot || !slot.proto || !slot.record) return null;
  const special = slot.record.special;
  if (special === 'spec_cast_adept') {
    if (!(e.spell in ADEPT_WORDS)) return null;
    const kind = slot.proto.sex === 2 ? 'cleric_f' : 'cleric_m';
    return { id: adeptClipId(kind, e.spell), slot, own: false, shout: false, kind };
  }
  if (!(special in CASTER_CLASS)) return null;
  const kind = casterKind(slot, special);
  if (!kind) return null;
  // Your own class hears the real name; anyone else, the cipher (magic.c say_spell).
  const form = hear.cls === CASTER_CLASS[special] ? 'n' : 'c';
  return { id: spellClipId(kind, e.spell, form), slot, own: false, shout: false, kind };
}

// ---------------------------------------------------------------- playback --

const REACH = 24;          // metres a voice carries; a shout carries further
const REACH_SHOUT = 44;
const LEVEL = 1.15;        // clips are levelled to -24 LUFS; this puts speech just above the footsteps
const MAX_VOICES = 3;
const DUCK_DEPTH = 0.5;    // the beds lose up to half their level under a near voice
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Voices {
  constructor(audio) {
    this.audio = audio;
    this.enabled = true;
    this.active = [];              // { key, source, env, level, end }
    this.log = [];                 // what was asked for, kept for the harness
    this.missing = new Set();
  }

  /** Starts loading what the player's own spells sound like, so the first cast is not silent. */
  preloadOwn(cls, sex) {
    const base = cls === 0 ? 'mage' : cls === 1 ? 'cleric' : null;
    if (!base) return;
    const kind = `${base}_${sex === 2 ? 'f' : 'm'}`;
    const prefix = `vo_${kind}_`;
    this.audio.clips.index().then((entries) => {
      for (const id of entries.keys()) if (id.startsWith(prefix) && id.endsWith('_n')) this.audio.clips.load(id);
    });
  }

  /** The event's clip, if it has one, played from where its speaker stands. Returns what was decided. */
  hear(event, diku) {
    const state = diku.game.state;
    const plan = planFor(event, { cls: state.class, sex: state.sex });
    if (!plan) return null;
    return this.play(plan, diku);
  }

  play(plan, diku) {
    const { audio } = this;
    const entry = audio.clips.entry(plan.id);
    const decision = { id: plan.id, kind: plan.kind, played: false };
    this.log.push(decision);
    if (this.log.length > 100) this.log.shift();
    if (!this.enabled || audio.muted || !audio.ctx) { decision.why = 'off'; return decision; }
    if (audio.clips.entries && !entry) {
      if (!this.missing.has(plan.id)) { this.missing.add(plan.id); console.warn(`voices: no clip ${plan.id} in the manifest`); }
      decision.why = 'no clip';
      return decision;
    }
    let pan = 0; let gain = 1; let muffled = false; let distance = 0;
    if (!plan.own) {
      const slot = plan.slot;
      if (!slot.here || slot.dead || !slot.pos) { decision.why = 'not drawn'; return decision; }
      const heard = listen(diku, slot.pos, { near: 2, scale: plan.shout ? 12 : 5 });
      const reach = plan.shout ? REACH_SHOUT : REACH;
      if (heard.distance > reach || Math.abs(slot.pos.y - diku.camera.position.y) > 6) { decision.why = 'too far'; return decision; }
      muffled = slot.roomVnum !== diku.state.roomVnum && !!(audio.place && !audio.place.openAir);
      pan = heard.pan; distance = heard.distance;
      gain = heard.gain * (muffled ? 0.35 : 1) * clamp((reach - heard.distance) / 4, 0, 1);
    }
    gain *= LEVEL * (plan.shout ? 1.25 : 1);
    Object.assign(decision, { gain: +gain.toFixed(3), pan: +pan.toFixed(2), distance: +distance.toFixed(1), muffled });
    const key = plan.own ? 'player' : plan.slot;
    this.start(plan.id, key, { pan, gain, muffled }, decision);
    return decision;
  }

  async start(id, key, { pan, gain, muffled }, decision) {
    const { audio } = this;
    // One voice per speaker: the newer words cut the older off.
    const prior = this.active.find((a) => a.key === key);
    if (prior) this.stop(prior, 0.06);
    if (this.active.length >= MAX_VOICES) {
      const quietest = this.active.reduce((a, b) => (a.level <= b.level ? a : b));
      if (quietest.level >= gain) { decision.why = 'cap'; return; }
      this.stop(quietest, 0.06);
    }
    decision.played = true;
    const voice = { key, level: gain, source: null, env: null, end: 0, pending: true };
    this.active.push(voice);
    const buffer = await audio.clips.load(id);
    if (!buffer || !this.active.includes(voice)) { this.active = this.active.filter((a) => a !== voice); decision.played = false; decision.why = decision.why || 'not loaded'; return; }
    const ctx = audio.ctx;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = muffled ? 650 : 16000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(1, now);
    source.connect(filter).connect(env).connect(audio.out({ pan, gain }));
    source.start(now);
    voice.source = source; voice.env = env; voice.pending = false; voice.end = now + buffer.duration;
    source.onended = () => { this.active = this.active.filter((a) => a !== voice); this.duck(0.6); };
    this.duck(0.08);
  }

  stop(voice, fade = 0.06) {
    this.active = this.active.filter((a) => a !== voice);
    if (!voice.source) return;
    const now = this.audio.ctx.currentTime;
    voice.env.gain.cancelScheduledValues(now);
    voice.env.gain.setValueAtTime(voice.env.gain.value, now);
    voice.env.gain.linearRampToValueAtTime(0, now + fade);
    voice.source.stop(now + fade + 0.01);
  }

  /** The music and the beds sit down under speech, by how loud the loudest voice is; up again when it is done. */
  duck(timeConstant) {
    const { audio } = this;
    if (!audio.duckBus) return;
    const loudest = this.active.reduce((m, a) => (a.source ? Math.max(m, a.level) : m), 0);
    audio.duckBus.gain.setTargetAtTime(1 - DUCK_DEPTH * clamp(loudest / LEVEL, 0, 1), audio.ctx.currentTime, timeConstant);
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) for (const v of [...this.active]) this.stop(v, 0.1);
  }

  state() {
    return {
      enabled: this.enabled, speaking: this.active.filter((a) => a.source).length,
      duck: this.audio.duckBus ? +this.audio.duckBus.gain.value.toFixed(3) : null,
      log: this.log.slice(-12), missing: [...this.missing],
    };
  }
}

/** What the mud emits that is spoken. Returns the way to stop listening. */
export function listenToVoices(audio, diku) {
  return diku.game.listen((event) => {
    if (audio.voices) audio.voices.hear(event, diku);
  });
}
