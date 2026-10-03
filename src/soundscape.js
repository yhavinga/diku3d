/**
 * The committed clips (assets/audio, made by tools/audio/generate.mjs): the
 * library that fetches and decodes them on demand, the footstep sprites, and
 * the ambience beds that crossfade as the place under the player changes.
 *
 * Nothing here is fetched until the AudioContext exists, and nothing blocks:
 * every lookup answers "not yet" (null) and the caller keeps its synthesised
 * sound until the buffer arrives. A clip that cannot be loaded is warned about
 * once, by file name, and the game goes on with the synth.
 */
import { SURFACE, ambienceFor } from './soundmap.js';

const BASE = new URL('../assets/audio/', import.meta.url);
const rand = (a, b) => a + Math.random() * (b - a);

export class Clips {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffers = new Map();
    this.pending = new Map();
    this.warned = new Set();
    this.entries = null;
    this.manifest = null;
  }

  warn(what, err) {
    if (this.warned.has(what)) return;
    this.warned.add(what);
    console.warn(`audio: cannot load ${what}${err ? ` (${err.message || err})` : ''}; keeping the synthesised sound`);
  }

  /** The manifest, once. Resolves to a Map of id -> entry (empty if it is missing). */
  async index() {
    if (!this.manifest) {
      this.manifest = (async () => {
        try {
          const r = await fetch(new URL('manifest.json', BASE));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          this.entries = new Map((await r.json()).clips.map((c) => [c.id, c]));
        } catch (err) {
          this.warn('assets/audio/manifest.json', err);
          this.entries = new Map();
        }
        return this.entries;
      })();
    }
    return this.manifest;
  }

  entry(id) { return this.entries && this.entries.get(id); }

  /** The decoded buffer, or null while it is on its way (the first call starts it). */
  get(id) {
    const hit = this.buffers.get(id);
    if (hit) return hit;
    this.load(id);
    return null;
  }

  load(id) {
    if (this.buffers.has(id)) return Promise.resolve(this.buffers.get(id));
    if (this.pending.has(id)) return this.pending.get(id);
    const job = (async () => {
      const entries = await this.index();
      const entry = entries.get(id);
      if (!entry) { this.warn(`clip ${id} (not in the manifest)`); return null; }
      try {
        const r = await fetch(new URL(entry.file, BASE));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buffer = await this.ctx.decodeAudioData(await r.arrayBuffer());
        this.buffers.set(id, buffer);
        return buffer;
      } catch (err) {
        this.warn(`assets/audio/${entry.file}`, err);
        return null;
      } finally {
        this.pending.delete(id);
      }
    })();
    this.pending.set(id, job);
    return job;
  }
}

/** One step at a time out of the walking clips, never the same one twice running. */
export class Steps {
  constructor(clips) {
    this.clips = clips;
    this.last = new Map();
  }

  /** Loads every footstep clip; called once the game has begun. */
  async preload() {
    const entries = await this.clips.index();
    await Promise.all([...entries.values()].filter((c) => c.kind === 'footstep').map((c) => this.clips.load(c.id)));
  }

  pick(floor, sprint) {
    const surface = SURFACE[floor];
    if (!surface || !this.clips.entries) return null;
    let id = `step_${surface}_${sprint ? 'run' : 'walk'}`;
    let rate = 1;
    if (!this.clips.entries.has(id)) { id = `step_${surface}_walk`; rate = sprint ? 1.12 : 1; }
    const entry = this.clips.entry(id);
    const buffer = this.clips.buffers.get(id);
    if (!entry || !buffer) return null;
    const sprites = entry.steps.filter(([, d]) => d >= 0.15);
    if (!sprites.length) return null;
    let i;
    do { i = Math.floor(Math.random() * sprites.length); } while (sprites.length > 1 && i === this.last.get(id));
    this.last.set(id, i);
    return { buffer, offset: sprites[i][0], duration: sprites[i][1] / rate, rate: rate * rand(0.95, 1.05) };
  }
}

const FADE = 1.6;         // time constant of a bed's crossfade, seconds
const LINGER = 9;         // a faded bed is stopped after this long

/** Looped ambience: layers of clips, each at its own start offset, faded in and out. */
export class Soundscape {
  constructor(audio) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 1.4;
    this.bus.connect(audio.master);
    this.layers = new Map();
    this.wanted = null;
    this.place = null;
    this.rule = null;
    this.ducked = false;
  }

  setPlace(place) {
    this.place = place;
    this.resolve();
  }

  resolve() {
    if (!this.place) return;
    const { rule, beds, gain } = ambienceFor(this.place);
    const key = `${rule}|${beds.join()}`;
    if (key === this.wanted) return;
    this.wanted = key;
    this.rule = rule;
    const each = (beds.length > 1 ? 0.75 : 1) * gain;
    const now = this.ctx.currentTime;
    for (const [id, layer] of this.layers) {
      if (beds.includes(id)) continue;
      layer.target = 0;
      layer.gain.gain.setTargetAtTime(0, now, FADE);
      layer.source.stop(now + LINGER);
      this.layers.delete(id);
    }
    for (const id of beds) {
      const existing = this.layers.get(id);
      if (existing) {
        existing.target = each;
        existing.gain.gain.setTargetAtTime(each, now, FADE);
        continue;
      }
      this.start(id, each, key);
    }
  }

  async start(id, target, key) {
    const buffer = await this.audio.clips.load(id);
    // The player may have walked on while the file was decoding.
    if (!buffer || key !== this.wanted || this.layers.has(id)) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(this.bus);
    source.start(0, Math.random() * buffer.duration);
    gain.gain.setTargetAtTime(target, this.ctx.currentTime, FADE);
    this.layers.set(id, { source, gain, target });
    this.audio.clipsAmbient(true);
  }

  /** While a piece plays the ambience steps back to half, or the temple's room tone and its organ drone sound like two things at once. */
  duck(on) {
    if (on === this.ducked) return;
    this.ducked = on;
    this.bus.gain.setTargetAtTime(on ? 0.7 : 1.4, this.ctx.currentTime, 2);
  }

  state() {
    return {
      rule: this.rule,
      layers: [...this.layers].map(([id, l]) => ({ id, target: +l.target.toFixed(2), gain: +l.gain.gain.value.toFixed(3) })),
    };
  }
}
