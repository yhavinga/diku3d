/**
 * Music, which here is rare. Three kinds, none of them constant:
 *  - the title: one quiet piece, a pause, once more;
 *  - room music: a tavern, a temple, a bard's table play while you stand in
 *    them -- a piece, then a few minutes' quiet, then another;
 *  - an area piece: every several minutes in play, one short piece chosen by
 *    the .are file, fading in under the ambience and out again.
 * What plays where is in soundmap.js; this is the player. Clock is the audio
 * clock, so a suspended context (title before the first click) does not run it.
 */
import { roomMusicFor, areaMusicFor, TITLE_MUSIC } from './soundmap.js';

const rand = (a, b) => a + Math.random() * (b - a);
const FIRST_AREA_PIECE = [150, 270];    // seconds of play before the first one
const BETWEEN_AREA_PIECES = [300, 540];

export class Music {
  constructor(audio) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 0.7;
    this.bus.connect(audio.master);
    this.enabled = true;
    this.current = null;        // { id, kind, gain, source }
    this.place = null;
    this.room = null;           // the room-music rule in force
    this.roomDue = 0;
    this.roomTurn = 0;
    this.areaDue = null;        // set when the game begins
    this.title = false;
    this.titleDue = 0;
    this.requested = 0;         // bumped by every play(), so a late decode can be dropped
  }

  // ---------------------------------------------------------------- play ----

  async play(id, kind, { fadeIn = 3, level = 1 } = {}) {
    if (!this.enabled || this.current) return false;
    const ticket = ++this.requested;
    const buffer = await this.audio.clips.load(id);
    if (!buffer || ticket !== this.requested || this.current || !this.enabled) return false;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(level, now + fadeIn);
    source.connect(gain).connect(this.bus);
    const cur = { id, kind, gain, source, level };
    source.onended = () => this.ended(cur);
    source.start(now);
    this.current = cur;
    if (this.audio.soundscape) this.audio.soundscape.duck(true);
    return true;
  }

  stop(fade = 3) {
    const cur = this.current;
    this.requested++;
    if (!cur) return;
    const now = this.ctx.currentTime;
    cur.gain.gain.cancelScheduledValues(now);
    cur.gain.gain.setValueAtTime(Math.max(cur.gain.gain.value, 0.0001), now);
    cur.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
    cur.source.stop(now + fade + 0.05);
    cur.stopping = true;
    // Freed straight away: the next piece may start while this one dies away.
    this.current = null;
    if (this.audio.soundscape) this.audio.soundscape.duck(false);
  }

  ended(cur) {
    if (this.current === cur) {
      this.current = null;
      if (this.audio.soundscape) this.audio.soundscape.duck(false);
      const now = this.ctx.currentTime;
      if (cur.kind === 'room' && this.room) this.roomDue = now + rand(...this.room.idle);
      if (cur.kind === 'area') this.areaDue = now + rand(...BETWEEN_AREA_PIECES);
      if (cur.kind === 'title') this.titleDue = now + rand(14, 24);
    }
  }

  // --------------------------------------------------------------- title ----

  startTitle() {
    this.title = true;
    this.titleDue = this.ctx.currentTime + 1.5;
  }

  endTitle(fade = 2.5) {
    this.title = false;
    if (this.current && this.current.kind === 'title') this.stop(fade);
  }

  // ----------------------------------------------------- places and clocks ----

  setPlace(place) {
    this.place = place;
    const rule = roomMusicFor(place);
    if (rule === this.room) return;
    if (this.current && this.current.kind === 'room') this.stop(3);
    // Standing in the same kind of room again right after leaving it: no new
    // wait, or walking in and out of a tavern would never play.
    this.room = rule;
    this.roomDue = this.ctx.currentTime + 4;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stop(1.5);
  }

  /** Called every frame with the audio clock; cheap unless something is due. */
  update() {
    if (!this.enabled) return;
    const now = this.ctx.currentTime;
    if (this.title) {
      if (!this.current && now >= this.titleDue) this.play(TITLE_MUSIC, 'title', { fadeIn: 4, level: 1.1 });
      return;
    }
    if (this.current && this.current.kind === 'area' && this.room) this.stop(4); // walked into a tavern
    if (this.current) return;
    if (this.room && now >= this.roomDue) {
      const clips = this.room.clips;
      const id = clips[this.roomTurn++ % clips.length];
      this.roomDue = now + 30; // until it ends and sets the real wait
      this.play(id, 'room', { fadeIn: 4 });
      return;
    }
    if (this.areaDue === null) this.areaDue = now + rand(...FIRST_AREA_PIECE);
    if (!this.room && this.place && now >= this.areaDue) {
      const id = areaMusicFor(this.place);
      this.areaDue = now + rand(60, 120); // retried later if nothing suits, or the clip is missing
      if (id) this.play(id, 'area', { fadeIn: 6 });
    }
  }

  state() {
    const now = this.ctx.currentTime;
    return {
      enabled: this.enabled,
      playing: this.current && { id: this.current.id, kind: this.current.kind, gain: +this.current.gain.gain.value.toFixed(3) },
      room: this.room && this.room.id,
      roomInSeconds: this.room ? Math.round(this.roomDue - now) : null,
      areaInSeconds: this.areaDue === null ? null : Math.round(this.areaDue - now),
      title: this.title,
    };
  }
}
