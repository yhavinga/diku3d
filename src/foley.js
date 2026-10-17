/**
 * The recorded one-shots and the things that sit in the world: blows, doors,
 * purses, spells, bells; the voices of creatures near you; a fountain, a hearth
 * or a forge panned from where it stands; thunder and the sound of rain on a
 * roof. Everything is data in soundmap.js and clips in assets/audio.
 *
 * Nothing here is allowed to be the only sound: `Foley.play` answers false while
 * its clip is still on its way and the caller in audio.js plays its synth instead.
 * The world is read from `window.diku` (the game, the camera, the drawn zone),
 * because audio.js is built before any of them and must not import them.
 */
import { SOUNDS, PRELOAD, creatureOf, PLACE_LOOPS, placeLoopOf } from './soundmap.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Where a point in the world is relative to the listener: pan, metres, and a gain that falls with distance. */
export function listen(diku, p, { near = 1, scale = 6 } = {}) {
  const camera = diku.camera;
  const m = camera.matrixWorld.elements;
  const dx = p.x - m[12];
  const dz = p.z - m[14];
  const d = Math.hypot(dx, dz);
  // m[0], m[2] are the camera's right vector in the world.
  const pan = d > 0.8 ? clamp((dx * m[0] + dz * m[2]) / d, -1, 1) * 0.7 : 0;
  return { pan, distance: d, gain: 1 / (1 + Math.max(0, d - near) / scale) };
}

export class Foley {
  constructor(audio) {
    this.audio = audio;
    this.last = new Map();
    this.log = [];
  }

  get clips() { return this.audio.clips; }

  /** Starts loading the clips of these sounds, one after another, so a boot is not made to wait. */
  async preload(names = PRELOAD) {
    for (const name of names) {
      for (const id of SOUNDS[name].clips) await this.clips.load(id);
    }
  }

  /**
   * A variant of `name`, through the usual output (`opts.pan`, `opts.gain` as
   * fx.js computes them). False if no clip of it has loaded yet.
   */
  play(name, { pan = 0, gain = 1, rate = 1, delay = 0, dest = null } = {}) {
    const def = SOUNDS[name];
    if (!def) throw new Error(`foley: no sound "${name}" in soundmap.js SOUNDS`);
    const ready = def.clips.filter((id) => this.clips.buffers.has(id));
    if (!ready.length) {
      for (const id of def.clips) this.clips.load(id);
      return false;
    }
    return this.playClip(pick(ready), { pan, gain: gain * def.gain, rate, delay, dest, name });
  }

  /** One sprite out of one clip (a sheet's variants, or the whole of a single sound). */
  playClip(id, { pan = 0, gain = 1, rate = 1, delay = 0, dest = null, name = id, spread = 0.05 } = {}) {
    const audio = this.audio;
    if (!audio.ctx || audio.muted) return true;
    const buffer = this.clips.buffers.get(id);
    if (!buffer) { this.clips.load(id); return false; }
    const entry = this.clips.entry(id);
    const sprites = entry && entry.steps && entry.steps.length ? entry.steps : [[0, buffer.duration]];
    let i;
    do { i = Math.floor(Math.random() * sprites.length); } while (sprites.length > 1 && i === this.last.get(id));
    this.last.set(id, i);
    const [offset, length] = sprites[i];
    const r = rate * rand(1 - spread, 1 + spread);
    const now = audio.ctx.currentTime + delay;
    const source = audio.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = r;
    const env = audio.ctx.createGain();
    const span = length / r;
    const release = Math.min(0.06, span * 0.4);
    env.gain.setValueAtTime(1, now);
    env.gain.setValueAtTime(1, now + span - release);
    env.gain.linearRampToValueAtTime(0, now + span);
    source.connect(env).connect(dest || audio.out({ pan, gain }));
    source.start(now, offset, length);
    this.log.push({ t: +now.toFixed(2), name, id, sprite: i, pan: +pan.toFixed(2), gain: +gain.toFixed(3), rate: +r.toFixed(3) });
    if (this.log.length > 300) this.log.shift();
    return true;
  }
}

// --------------------------------------------------------------- creatures --

/** Barks, hisses and growls from the mobiles near you, sparingly, from where they stand. */
export class Creatures {
  constructor(audio) {
    this.audio = audio;
    this.next = 0;
    this.growls = new Map();
    this.engaged = new Map();   // slot -> its strength when last seen fighting, for the roar on taking up a fight
    this.roared = new Map();
    this.hp = new Map();        // slot -> hit points when last seen fighting, for rules with a `hurt` sound
    this.hurtAt = new Map();
    this.tick = 0;
  }

  /**
   * A dracolich lying in its heap or getting up (actors.js createAwaken) asks
   * for two sounds as its clip reaches them -- the rattle as it begins, the
   * roar as its jaws open -- so they are played the frame they are asked
   * for, from where it stands, and not on the half-second beat below. Its
   * clips are decoded while you are within earshot of a heap, or the first
   * rise would be silent.
   */
  awakenings(diku) {
    for (const slot of diku.game.mobs) {
      const aw = slot.figure && slot.figure.awaken;
      if (!aw || !slot.pos) continue;
      const heard = listen(diku, slot.pos, { near: 3, scale: 14 });
      if (aw.state === 'heap' && heard.distance < 70) {
        for (const id of [...SOUNDS.dracolich_rise.clips, ...SOUNDS.dracolich_roar.clips]) this.audio.clips.load(id);
      }
      while (aw.events.length) {
        const event = aw.events.shift();
        if (heard.distance > 90) continue;
        // The rattle is slowed to the clip's four seconds (it was cut at 3.4).
        this.audio.foley.play(event === 'rattle' ? 'dracolich_rise' : 'dracolich_roar',
          { pan: heard.pan, gain: heard.gain, rate: event === 'rattle' ? 0.87 : 1 });
      }
    }
  }

  update(now, diku) {
    this.awakenings(diku);
    if (now < this.tick) return;
    this.tick = now + 0.5;
    const game = diku.game;
    const player = diku.state.roomVnum;
    const sheltered = this.audio.place && !this.audio.place.openAir;
    const night = this.audio.hour === 'night';
    const fit = [];
    for (const slot of game.mobs) {
      if (!slot.here || slot.dead || !slot.pos) continue;
      // Getting up out of its bones it has no voice but the rise's own; lying in them it may only whisper.
      const aw = slot.figure && slot.figure.awaken;
      if (aw && aw.state !== 'up' && aw.state !== 'heap') continue;
      const rule = creatureOf(`${slot.proto.keywords} ${slot.proto.short || ''}`);
      if (!rule) continue;
      const heard = listen(diku, slot.pos, { near: 2, scale: 5 });
      if (heard.distance > rule.reach || Math.abs(slot.pos.y - diku.camera.position.y) > 6) continue;
      // A wall between: a muffled version of the same call.
      const walls = slot.roomVnum !== player && sheltered ? 0.35 : 1;
      fit.push({ slot, rule, heard, walls });
      // Within earshot: have its fight voice and death cry decoded before they are needed, or the first one is lost.
      for (const id of [...(rule.roar || []), ...(rule.fight || []), ...(rule.hurt || []), ...(rule.death ? SOUNDS[rule.death].clips : [])]) this.audio.clips.load(id);
    }
    if (!fit.length) return;
    for (const { slot, rule, heard, walls } of fit) {
      const mob = slot.instance;
      const aw = slot.figure && slot.figure.awaken;
      // Still in its heap, or getting up: the rise's own sounds are all it has.
      if (!mob || !mob.fighting || (aw && aw.state !== 'up')) { this.engaged.delete(slot); this.hp.delete(slot); continue; }
      if (rule.hurt) {
        // Its bones crack where a blow lands; the blow's own sound is the impact, this is the frame answering.
        const was = this.hp.get(slot);
        this.hp.set(slot, mob.hit);
        if (was !== undefined && mob.hit < was && now >= (this.hurtAt.get(slot) ?? 0)) {
          this.hurtAt.set(slot, now + 1.2);
          this.say(rule, pick(rule.hurt), heard, walls, true);
        }
      }
      if (rule.roar) {
        // A big creature bellows as it takes up a fight and when a blow takes a good part of its strength.
        const before = this.engaged.get(slot);
        const hurt = before !== undefined && before - mob.hit >= 0.12 * mob.maxHit;
        this.engaged.set(slot, mob.hit);
        if ((before === undefined || hurt) && now >= (this.roared.get(slot) ?? 0)) {
          this.roared.set(slot, now + 2.5);
          this.growls.set(slot, now + rand(3, 7));
          this.say(rule, pick(rule.roar), heard, walls, true);
          continue;
        }
      }
      if (!rule.fight) continue;
      const due = this.growls.get(slot) ?? 0;
      if (now < due) continue;
      this.growls.set(slot, now + rand(3, 7));
      this.say(rule, pick(rule.fight), heard, walls, true);
    }
    if (now < this.next) return;
    const callers = fit.filter(({ rule }) => rule.idle.length && (!rule.night || (night && this.audio.place && this.audio.place.openAir)));
    if (!callers.length) return;
    const who = pick(callers);
    this.next = now + rand(...who.rule.every) / Math.sqrt(callers.length);
    this.say(who.rule, pick(who.rule.idle), who.heard, who.walls);
  }

  say(rule, id, heard, walls, fighting = false) {
    const [lo, hi] = (fighting && rule.fightRate) || rule.rate || [0.95, 1.05];
    const gain = (fighting && rule.fightGain) || rule.gain;
    this.audio.foley.playClip(id, { pan: heard.pan, gain: heard.gain * gain * walls, rate: rand(lo, hi), name: `creature:${rule.id}${fighting ? ':fight' : ''}`, spread: 0 });
  }
}

// ---------------------------------------------------------- positional loops --

const REACH_OUT = 2.5; // metres beyond a source's reach before it is let go (no flutter at the edge)

/** Fountains, hearths and forges: a looped clip on a source, panned and fallen off by distance. */
export class Places {
  constructor(audio) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.sources = new Map();   // key -> { rule, at, node ... }
    this.scan = 0;
    this.zone = null;
    this.rooms = new Map();     // vnum -> placeLoopOf answer, for the drawn zone
    this.cands = [];
  }

  update(now, diku) {
    // A crossing replaces the zone: nothing here may hold the old one.
    if (diku.built !== this.zone) {
      this.stopAll();
      this.zone = diku.built;
      this.rooms.clear();
      this.cands = [];
      this.scan = 0;
    }
    if (now >= this.scan) {
      this.scan = now + 1;
      this.rescan(diku);
    }
    const inRoom = diku.state.roomVnum;
    const sheltered = this.audio.place && !this.audio.place.openAir;
    for (const [key, src] of this.sources) {
      if (src.pending) continue;
      const heard = listen(diku, src.at, { near: 1.5, scale: 2.5 });
      const reach = src.rule.reach;
      const out = heard.distance > reach + REACH_OUT || !this.cands.includes(key);
      const walled = src.room !== inRoom && (sheltered || !src.open);
      const target = out ? 0 : heard.gain * src.rule.gain * (walled ? 0.4 : 1) * clamp((reach + REACH_OUT - heard.distance) / REACH_OUT, 0, 1);
      src.gain.gain.setTargetAtTime(target, now, 0.2);
      src.pan.pan.setTargetAtTime(heard.pan, now, 0.1);
      src.filter.frequency.setTargetAtTime(walled ? 650 : 14000, now, 0.25);
      src.level = target;
      if (out && src.deadAt === undefined) src.deadAt = now + 1.5;
      else if (!out) src.deadAt = undefined;
      if (src.deadAt !== undefined && now > src.deadAt) { this.stop(key); }
    }
  }

  rescan(diku) {
    const found = [];
    const cam = diku.camera.position;
    for (const obj of diku.game.ground) {
      // `ground` holds the whole mud; only the drawn zone's rooms have a place to stand.
      if (obj.itemType !== 25 || !obj.at || !diku.built.rooms.has(obj.inRoom)) continue;
      found.push({ key: obj, rule: PLACE_LOOPS.fountain, at: obj.at, room: obj.inRoom, open: true });
    }
    for (const [vnum, info] of diku.built.rooms) {
      if (Math.hypot(info.center.x - cam.x, info.center.z - cam.z) > 40) continue;
      if (!this.rooms.has(vnum)) this.rooms.set(vnum, placeLoopOf(info.room, info.openAir ?? info.outdoor));
      const loop = this.rooms.get(vnum);
      if (!loop) continue;
      found.push({ key: info, rule: PLACE_LOOPS[loop.kind], at: { x: info.center.x + loop.dx, y: info.center.y + 1, z: info.center.z + loop.dz }, room: vnum, open: false });
    }
    // The three nearest that are close enough to be heard.
    const near = found
      .map((f) => ({ ...f, d: Math.hypot(f.at.x - cam.x, f.at.z - cam.z) }))
      .filter((f) => f.d < f.rule.reach)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    this.cands = near.map((f) => f.key);
    for (const f of near) if (!this.sources.has(f.key)) this.start(f);
  }

  async start(f) {
    // Marked at once so the next scan does not start it twice while the clip decodes.
    this.sources.set(f.key, { pending: true });
    const buffer = await this.audio.clips.load(f.rule.clip);
    if (!buffer || this.sources.get(f.key)?.pending !== true) { this.sources.delete(f.key); return; }
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 14000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    source.connect(filter).connect(gain).connect(pan).connect(this.audio.duckBus);
    source.start(0, Math.random() * buffer.duration);
    this.sources.set(f.key, { rule: f.rule, at: f.at, room: f.room, open: f.open, source, filter, gain, pan, level: 0 });
  }

  stop(key) {
    const src = this.sources.get(key);
    this.sources.delete(key);
    if (!src || src.pending) return;
    src.source.stop();
    src.source.disconnect();
    src.pan.disconnect();
  }

  stopAll() {
    for (const key of [...this.sources.keys()]) this.stop(key);
  }

  state() {
    return [...this.sources.values()].filter((s) => !s.pending).map((s) => ({ clip: s.rule.clip, at: [+s.at.x.toFixed(1), +s.at.z.toFixed(1)], level: +s.level.toFixed(3), room: s.room }));
  }
}

// ----------------------------------------------------------------- weather --

/** Rain as a recorded bed (on ground, on a roof) under the synth's hiss, and thunder in a storm. */
export class Weather {
  constructor(audio) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.beds = {};
    this.nextThunder = 0;
    this.level = 0;
    this.outdoor = 1;
  }

  /** Called by audio.applyRain: `level` 0..1, `outdoor` 1 or 0. */
  rain(level, outdoor) {
    this.level = level;
    this.outdoor = outdoor;
    if (level > 0.02) { for (const id of ['wx_rain', 'wx_rain_roof']) this.ensure(id); }
    this.apply();
  }

  async ensure(id) {
    if (this.beds[id]) return;
    this.beds[id] = { pending: true };
    const buffer = await this.audio.clips.load(id);
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(this.audio.duckBus);
    source.start(0, Math.random() * buffer.duration);
    this.beds[id] = { source, gain };
    this.apply();
    this.audio.rainClips(true);
  }

  apply() {
    const now = this.ctx.currentTime;
    const set = (id, value) => {
      const bed = this.beds[id];
      if (bed && bed.gain) bed.gain.gain.setTargetAtTime(value, now, 1.2);
    };
    set('wx_rain', this.level * (this.outdoor ? 0.9 : 0));
    set('wx_rain_roof', this.level * (this.outdoor ? 0 : 0.8));
  }

  update(now, diku) {
    // SKY.LIGHTNING in game.js, which this file does not import.
    const lightning = diku.game.weather().sky === 3;
    if (!lightning) { this.nextThunder = 0; return; }
    if (!this.nextThunder) this.nextThunder = now + rand(4, 14);
    if (now < this.nextThunder) return;
    this.nextThunder = now + rand(18, 50);
    // Outside it is the sky; under a roof it is a muffled roll.
    const gain = this.outdoor ? 1 : 0.45;
    this.audio.foley.play('thunder', { pan: rand(-0.5, 0.5), gain, rate: rand(0.92, 1.05) });
  }

  state() {
    return { level: this.level, beds: Object.fromEntries(Object.entries(this.beds).map(([k, b]) => [k, b.gain ? +b.gain.gain.value.toFixed(3) : 'pending'])) };
  }
}

// ------------------------------------------------------------------ events --

/**
 * What the mud emits and nobody else made a sound for: a level gained, a
 * purchase, and the sheets (inventory, skills, ...) opening and closing, which
 * are keys on the keyboard -- a page turns on the same key that opened it.
 */
export function listenToGame(audio, diku) {
  const events = diku.game.listen((event) => {
    if (event.kind === 'level') audio.foley.play('levelup', {});
    else if (event.kind === 'buy' || event.kind === 'sell') {
      audio.foley.play('shopbell', {});
      audio.foley.play('coins', { delay: 0.25, gain: 0.8 });
    }
  });
  const onKey = (e) => {
    if (e.repeat || !['KeyI', 'KeyB', 'KeyK', 'KeyO'].includes(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    audio.foley.play('page', {});
  };
  window.addEventListener('keydown', onKey, { passive: true });
  return () => { events(); window.removeEventListener('keydown', onKey); };
}
