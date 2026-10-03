/**
 * Sound. The one-shots of play (doors, blows, coins, spells), the rain and the
 * wind are synthesised on the spot -- noise through filters, a few sine
 * partials. Footsteps, the ambience of each kind of place and the music are
 * committed clips (assets/audio, see soundscape.js and music.js); the synth
 * footstep and wind bed stay as what plays until a clip has loaded, or if it
 * never does.
 */
import { Clips, Steps, Soundscape } from './soundscape.js';
import { Music } from './music.js';
import { placeOf } from './soundmap.js';

export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicOn = true;
    this.place = null;       // what setPlace was last told, kept for when the context exists
    this.hour = null;
    this.windScale = 1;
    this._outdoor = true;
  }

  /**
   * The context and the master bus, once. The title music needs them before
   * the entry click, when a browser leaves the context suspended; the first
   * gesture of any kind wakes it.
   */
  init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(this.ctx.destination);
    this.noise = this.makeNoiseBuffer(4);
    this.clips = new Clips(this.ctx);
    this.steps = new Steps(this.clips);
    this.music = new Music(this);
    this.music.setEnabled(this.musicOn);
    const wake = () => {
      this.ctx.resume();
      for (const type of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(type, wake, true);
    };
    for (const type of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(type, wake, true);
  }

  /** The title screen's music; the context is made here and starts sounding on the first gesture. */
  startTitle() {
    this.init();
    this.music.startTitle();
    // A browser keeps the context silent until a gesture, and the gesture
    // most people make on the title is "enter", which ends the title music.
    // So offer one that only wakes the sound.
    const title = document.getElementById('title');
    if (this.ctx.state !== 'suspended' || this.muted || !this.musicOn || !title) return;
    const button = document.createElement('button');
    button.textContent = '♪ music';
    button.title = 'browsers stay silent until you click';
    button.style.cssText = 'position:absolute;top:26px;right:30px;pointer-events:auto;cursor:pointer;'
      + 'font-family:var(--mono);font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--gold);'
      + 'background:rgba(8,7,6,0.4);border:1px solid rgba(224,189,119,0.4);padding:6px 11px;border-radius:2px;';
    button.addEventListener('click', () => this.ctx.resume());
    title.appendChild(button);
    this.ctx.addEventListener('statechange', () => { if (this.ctx.state === 'running') button.remove(); });
  }

  /** Browsers only allow this after a gesture, so it is called from the entry click. */
  start() {
    this.init();
    this.ctx.resume();
    if (this.windGain) return;
    this.music.endTitle();
    this.soundscape = new Soundscape(this);
    this.steps.preload();
    if (this.place) {
      this.soundscape.setPlace(this.place);
      this.music.setPlace(this.place);
    }

    // wind bed
    const wind = this.ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const windFilter = this.ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 320;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.16;
    wind.connect(windFilter).connect(this.windGain).connect(this.master);
    wind.start();

    // a slow swell so the bed doesn't sit still
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.09;
    lfo.connect(lfoGain).connect(this.windGain.gain);
    lfo.start();

    // rain bed: the same noise through a higher shelf -- rain is hiss where
    // wind is rumble -- silent until setRain opens it. Under a roof the gain
    // halves rather than closes, which is what rain on someone else's roof
    // sounds like.
    const rain = this.ctx.createBufferSource();
    rain.buffer = this.noise;
    rain.loop = true;
    rain.playbackRate.value = 1.7;
    const rainFilter = this.ctx.createBiquadFilter();
    rainFilter.type = 'highpass';
    rainFilter.frequency.value = 1400;
    this.rainGain = this.ctx.createGain();
    this.rainGain.gain.value = 0;
    rain.connect(rainFilter).connect(this.rainGain).connect(this.master);
    rain.start();
    this._rainLevel = 0;
    this._rainOutdoor = 1;

    this.nextBell = this.ctx.currentTime + 25;
  }

  /** 0 dry to 1 soaking; ramped, because rain does not start on a frame. */
  setRain(level) {
    this._rainLevel = Math.max(0, Math.min(1, level));
    this.applyRain();
  }

  applyRain() {
    if (!this.rainGain) return;
    const shelter = this._rainOutdoor ? 1 : 0.4;
    const target = this._rainLevel * 0.34 * shelter;
    this.rainGain.gain.linearRampToValueAtTime(target, this.ctx.currentTime + 1.8);
  }

  makeNoiseBuffer(seconds) {
    const length = this.ctx.sampleRate * seconds;
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    return buffer;
  }

  burst({ frequency = 500, q = 1.2, gain = 0.3, decay = 0.12, type = 'bandpass' }) {
    if (!this.ctx || this.muted) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency * (0.85 + Math.random() * 0.3);
    filter.Q.value = q;
    const envelope = this.ctx.createGain();
    const now = this.ctx.currentTime;
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(gain, now + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0005, now + decay);
    source.connect(filter).connect(envelope).connect(this.master);
    source.start(now, Math.random() * 3);
    source.stop(now + decay + 0.05);
  }

  footstep(surface, sprint) {
    const step = this.steps && this.steps.pick(surface, sprint);
    if (step && this.ctx && !this.muted) {
      const now = this.ctx.currentTime;
      const source = this.ctx.createBufferSource();
      source.buffer = step.buffer;
      source.playbackRate.value = step.rate;
      const env = this.ctx.createGain();
      // The clips are cut on the step, so the only envelope needed is a short release.
      env.gain.setValueAtTime(sprint ? 0.8 : 0.55, now);
      env.gain.setValueAtTime(sprint ? 0.8 : 0.55, now + step.duration - 0.04);
      env.gain.linearRampToValueAtTime(0, now + step.duration);
      source.connect(env).connect(this.master);
      source.start(now, step.offset, step.duration * step.rate);
      return;
    }
    const table = {
      cobble: { frequency: 900, q: 1.6, decay: 0.1 },
      flagstone: { frequency: 750, q: 1.4, decay: 0.13 },
      marble: { frequency: 1400, q: 2.4, decay: 0.16 },
      planks: { frequency: 380, q: 1.1, decay: 0.15 },
      grass: { frequency: 2600, q: 0.7, decay: 0.09 },
      dirt: { frequency: 420, q: 0.8, decay: 0.09 },
      sand: { frequency: 3200, q: 0.6, decay: 0.1 },
      rock: { frequency: 640, q: 1.5, decay: 0.12 },
      water: { frequency: 1800, q: 0.9, decay: 0.2 },
    };
    const preset = table[surface] || table.flagstone;
    this.burst({ ...preset, gain: sprint ? 0.34 : 0.22 });
  }

  door(open, place = null) {
    if (!this.ctx || this.muted) return;
    const dest = place ? this.out(place) : this.master;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    const now = this.ctx.currentTime;
    osc.frequency.setValueAtTime(open ? 120 : 190, now);
    osc.frequency.exponentialRampToValueAtTime(open ? 190 : 110, now + 0.45);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 700;
    filter.Q.value = 6;
    const envelope = this.ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(0.13, now + 0.05);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    osc.connect(filter).connect(envelope).connect(dest);
    osc.start(now);
    osc.stop(now + 0.55);
    this.burst({ frequency: 260, q: 0.9, gain: 0.1, decay: 0.2 });
  }

  // -- the mud's small verbs ----------------------------------------------
  //
  // Each is a few hundred milliseconds of the same noise and sines the rest
  // of the file is made of, levelled against a footstep: a lock is two
  // clicks, a coin is a ring, a drink is three swallows.

  /** A key turning (two dry clicks and a clunk), or a pick at work. */
  lock({ pan, gain, pick = false, failed = false } = {}) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ pan, gain });
    const clicks = pick ? [0, 0.09, 0.16, 0.27, 0.34] : [0, 0.07];
    clicks.forEach((t, i) => this.noiseHit(dest, { frequency: 3600 + i * 300, q: 6, gain: 0.35, decay: 0.03, delay: t }));
    if (!failed) {
      this.noiseHit(dest, { frequency: 900, q: 2, gain: 0.45, decay: 0.07, delay: clicks[clicks.length - 1] + 0.1 });
      this.ring(dest, { base: 1400, ratios: [1, 2.3], gain: 0.02, decay: 0.2, delay: clicks[clicks.length - 1] + 0.1 });
    }
  }

  /** Coins into a purse: a few small rings, close together. */
  coins({ one = false } = {}) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ gain: 0.8 });
    const n = one ? 1 : 4;
    for (let i = 0; i < n; i++) {
      const delay = i * 0.045 + Math.random() * 0.02;
      this.ring(dest, { base: 2600 + Math.random() * 900, ratios: [1, 1.52, 2.33], gain: 0.03, decay: 0.28, delay });
      this.noiseHit(dest, { frequency: 5200, q: 3, gain: 0.12, decay: 0.02, delay });
    }
  }

  /** Something taken up: cloth and leather, a short rustle. */
  pickup() {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ gain: 0.7 });
    this.noiseHit(dest, { frequency: 2400, to: 1200, q: 0.8, gain: 0.3, attack: 0.02, decay: 0.12 });
    this.noiseHit(dest, { frequency: 700, q: 1, gain: 0.2, decay: 0.06, delay: 0.08 });
  }

  /** Something let fall at your feet; money rings as it lands. */
  drop(gold = false) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ gain: 0.8 });
    this.thump(dest, { from: 140, to: 60, gain: 0.08, decay: 0.12, delay: 0.18 });
    this.noiseHit(dest, { frequency: 600, type: 'lowpass', q: 0.7, gain: 0.3, decay: 0.08, delay: 0.18 });
    if (gold) this.coins();
  }

  /** Bites: three crisp, chewed bursts. */
  eat() {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ gain: 0.8 });
    for (let i = 0; i < 3; i++) {
      this.noiseHit(dest, { frequency: 1800 - i * 200, q: 1.3, gain: 0.35, attack: 0.008, decay: 0.07, delay: i * 0.32 });
      this.noiseHit(dest, { frequency: 450, q: 1, gain: 0.25, decay: 0.12, delay: i * 0.32 + 0.05 });
    }
  }

  /** Swallows -- a low glug, three times -- or water filling a skin. */
  drink({ fill = false } = {}) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ gain: 0.8 });
    if (fill) {
      this.noiseHit(dest, { frequency: 900, to: 2200, q: 1.2, gain: 0.3, attack: 0.1, decay: 0.9 });
      return;
    }
    for (let i = 0; i < 3; i++) {
      const now = this.ctx.currentTime + i * 0.38;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(210, now);
      osc.frequency.exponentialRampToValueAtTime(120, now + 0.14);
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0.0001, now);
      env.gain.linearRampToValueAtTime(0.14, now + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      osc.connect(env).connect(dest);
      osc.start(now);
      osc.stop(now + 0.2);
      this.noiseHit(dest, { frequency: 500, q: 2, gain: 0.15, decay: 0.08, delay: i * 0.38 + 0.03 });
    }
  }

  portal() {
    if (!this.ctx || this.muted) return;
    const osc = this.ctx.createOscillator();
    const now = this.ctx.currentTime;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.6);
    const envelope = this.ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(0.18, now + 0.12);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
    osc.connect(envelope).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.8);
  }

  bell() {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    for (const [ratio, gain] of [[1, 0.16], [2.01, 0.07], [2.98, 0.04], [4.2, 0.02]]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 196 * ratio;
      const envelope = this.ctx.createGain();
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.linearRampToValueAtTime(gain, now + 0.02);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + 4.5);
      osc.connect(envelope).connect(this.master);
      osc.start(now);
      osc.stop(now + 4.6);
    }
  }

  // -- combat ---------------------------------------------------------------
  //
  // Every sound here takes `{ pan, gain }` from fx.js, which places it where it
  // happened relative to the camera. All of it is noise through filters and a
  // handful of sine partials: a blade is air moving, a hit is a thud with a
  // little grit on it, and steel on steel is a few inharmonic modes ringing.

  /** The output end of a one-off sound: gain, then stereo placement. */
  out({ pan = 0, gain = 1 } = {}) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(this.master);
    return g;
  }

  /** Filtered noise with an envelope, into `dest`. `sweep` glides the filter. */
  noiseHit(dest, { frequency, to = null, q = 1, type = 'bandpass', gain, attack = 0.004, decay, rate = 1, delay = 0 }) {
    const now = this.ctx.currentTime + delay;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = rate * (0.9 + Math.random() * 0.2);
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, now);
    if (to) filter.frequency.exponentialRampToValueAtTime(to, now + attack + decay * 0.8);
    filter.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(gain, now + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    source.connect(filter).connect(env).connect(dest);
    source.start(now, Math.random() * 3);
    source.stop(now + attack + decay + 0.05);
  }

  /** A sine that drops in pitch: the body of a thud. */
  thump(dest, { from, to, gain, decay, delay = 0 }) {
    const now = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.exponentialRampToValueAtTime(to, now + decay);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(gain, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    osc.connect(env).connect(dest);
    osc.start(now);
    osc.stop(now + decay + 0.05);
  }

  /** Inharmonic partials, the ring of struck metal. */
  ring(dest, { base, ratios, gain, decay, delay = 0 }) {
    const now = this.ctx.currentTime + delay;
    ratios.forEach((ratio, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * ratio * (0.99 + Math.random() * 0.02);
      const env = this.ctx.createGain();
      const g = gain / (1 + i * 0.7);
      const d = decay / (1 + i * 0.35);
      env.gain.setValueAtTime(0.0001, now);
      env.gain.linearRampToValueAtTime(g, now + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, now + d);
      osc.connect(env).connect(dest);
      osc.start(now);
      osc.stop(now + d + 0.05);
    });
  }

  /** A blade or a fist through the air: a band of noise rising past you. */
  whoosh({ pan, gain, weight = 1, miss = false } = {}) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ pan, gain });
    this.noiseHit(dest, {
      frequency: 380 * weight + 200, to: 1900 + 900 * weight, q: 1.6, gain: (miss ? 0.75 : 0.5) * (0.6 + weight * 0.4),
      attack: 0.07, decay: 0.16 + weight * 0.05, rate: 1.4,
    });
  }

  /** A blow landing: `armour` clanks, `blunt` thuds, `flesh` is a dull cut. */
  impact(kind, { pan, gain, strength = 0.6 } = {}) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ pan, gain });
    const s = Math.max(0.3, Math.min(1.4, strength));
    // Levels are set against a footstep, metered offline: a blow lands about
    // 10 dB over one. The sine thump is most of that and needs very little.
    this.thump(dest, { from: 150, to: 52, gain: 0.1 * s, decay: 0.16 });
    if (kind === 'armour') {
      this.noiseHit(dest, { frequency: 2600, q: 2.2, gain: 0.5 * s, decay: 0.07 });
      this.ring(dest, { base: 610 + Math.random() * 90, ratios: [1, 2.37, 3.91, 5.63], gain: 0.025 * s, decay: 0.32 });
    } else if (kind === 'blunt') {
      this.noiseHit(dest, { frequency: 420, q: 0.8, type: 'lowpass', gain: 0.25 * s, decay: 0.12 });
    } else {
      this.noiseHit(dest, { frequency: 900, to: 380, q: 1.1, gain: 0.7 * s, decay: 0.1 });
      this.noiseHit(dest, { frequency: 3200, q: 1.5, gain: 0.2 * s, decay: 0.05 });
    }
  }

  /** Steel meeting steel: a sharp strike, a ring, and a little scrape after. */
  clang({ pan, gain } = {}) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ pan, gain });
    this.noiseHit(dest, { frequency: 3400, q: 3, gain: 1.0, decay: 0.05 });
    this.ring(dest, { base: 820 + Math.random() * 160, ratios: [1, 1.51, 2.76, 4.07, 5.41], gain: 0.08, decay: 0.9 });
    this.noiseHit(dest, { frequency: 5200, to: 2600, q: 4, gain: 0.15, attack: 0.02, decay: 0.22, delay: 0.04 });
  }

  /** Stepping out of the way: cloth and a scuff of the foot. */
  dodge({ pan, gain } = {}) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ pan, gain });
    this.noiseHit(dest, { frequency: 1500, to: 700, q: 0.9, gain: 0.4, attack: 0.03, decay: 0.16 });
    this.noiseHit(dest, { frequency: 700, q: 1.2, gain: 0.45, decay: 0.09, delay: 0.1 });
  }

  /**
   * A last breath: a falling, breathy tone through two formants. Quiet on
   * purpose -- the body hitting the ground (`bodyfall`) carries the moment.
   */
  death({ pan, gain } = {}) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ pan, gain });
    const now = this.ctx.currentTime;
    const voice = this.ctx.createOscillator();
    voice.type = 'sawtooth';
    voice.frequency.setValueAtTime(150 + Math.random() * 40, now);
    voice.frequency.exponentialRampToValueAtTime(78, now + 0.7);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.12, now + 0.06);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
    for (const [f, q] of [[620, 6], [1080, 7]]) {
      const formant = this.ctx.createBiquadFilter();
      formant.type = 'bandpass';
      formant.frequency.value = f;
      formant.Q.value = q;
      voice.connect(formant).connect(env);
    }
    env.connect(dest);
    voice.start(now);
    voice.stop(now + 0.8);
    this.noiseHit(dest, { frequency: 900, q: 0.8, gain: 0.2, attack: 0.05, decay: 0.55 });
  }

  /** A body meeting the ground, and what it was wearing a moment after. */
  bodyfall({ pan, gain } = {}) {
    if (!this.ctx || this.muted) return;
    const dest = this.out({ pan, gain });
    this.thump(dest, { from: 110, to: 38, gain: 0.14, decay: 0.3 });
    this.noiseHit(dest, { frequency: 300, type: 'lowpass', q: 0.7, gain: 0.5, decay: 0.2 });
    this.thump(dest, { from: 80, to: 40, gain: 0.06, decay: 0.18, delay: 0.16 });
    this.noiseHit(dest, { frequency: 2400, q: 2, gain: 0.15, decay: 0.12, delay: 0.14 });
  }

  /**
   * Where the player is: what the ambience and the music pick from. `info` is
   * build.js's record for the room, `hour` the mud's hour of day (state.time).
   */
  setPlace(info, hour) {
    this.hour = hour;
    this.place = placeOf(info, hour);
    if (!this.soundscape) return;
    this.soundscape.setPlace(this.place);
    this.music.setPlace(this.place);
  }

  /** A bed of clips is playing, so the synthesised wind drops to a trace under it. */
  clipsAmbient(on) {
    this.windScale = on ? 0.3 : 1;
    this.setOutdoor(this._outdoor);
  }

  setMusic(on) {
    this.musicOn = on;
    if (this.music) this.music.setEnabled(on);
  }

  /** For the console and the harness: what is selected and how loud it is. */
  debug() {
    return {
      time: this.ctx && +this.ctx.currentTime.toFixed(1),
      state: this.ctx && this.ctx.state,
      muted: this.muted,
      place: this.place && { vnum: this.place.vnum, name: this.place.name, areaFile: this.place.areaFile, floor: this.place.floor },
      ambience: this.soundscape && this.soundscape.state(),
      music: this.music && this.music.state(),
      loaded: this.clips ? [...this.clips.buffers.keys()] : [],
    };
  }

  /** Outdoors the wind opens up; indoors it drops to a hush. */
  setOutdoor(outdoor) {
    if (!this.ctx) return;
    this._outdoor = outdoor;
    if (!this.windGain) return; // the title has a context but not yet the beds
    const target = (outdoor ? 0.2 : 0.05) * this.windScale;
    this.windGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.8);
    this._rainOutdoor = outdoor ? 1 : 0;
    this.applyRain();
  }

  update(outdoorCity, hour) {
    if (!this.ctx) return;
    if (this.soundscape && hour !== this.hour && this.place) {
      this.hour = hour;
      this.place.hour = hour;
      this.soundscape.resolve();
    }
    this.music.update();
    if (this.muted) return;
    if (outdoorCity && this.ctx.currentTime > this.nextBell) {
      this.bell();
      this.nextBell = this.ctx.currentTime + 90 + Math.random() * 120;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }
}
