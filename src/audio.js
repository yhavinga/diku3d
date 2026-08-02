/**
 * Sound, synthesised on the spot: wind through a lowpass, footsteps as filtered
 * noise bursts, a creak for doors and a bell for the temple quarter. No files.
 */

export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  /** Browsers only allow this after a gesture, so it is called from the entry click. */
  start() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);

    this.noise = this.makeNoiseBuffer(4);

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

    this.nextBell = this.ctx.currentTime + 25;
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

  door(open) {
    if (!this.ctx || this.muted) return;
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
    osc.connect(filter).connect(envelope).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.55);
    this.burst({ frequency: 260, q: 0.9, gain: 0.1, decay: 0.2 });
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

  /** Outdoors the wind opens up; indoors it drops to a hush. */
  setOutdoor(outdoor) {
    if (!this.ctx) return;
    const target = outdoor ? 0.2 : 0.05;
    this.windGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.8);
  }

  update(outdoorCity) {
    if (!this.ctx || this.muted) return;
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
