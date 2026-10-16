/**
 * Boss presence: how much of a strong mobile's attention you are under, 0..1.
 *
 * It is the page's own, read from what the page already knows -- which mobiles
 * are drawn in this zone and who the player is fighting -- so a page mirroring
 * a server feels it too and neither the rules nor the server hear of it. Who is
 * strong is `fightMusicFor`'s answer, not a second rule: whatever calls for the
 * boss piece in a fight calls for it when one has turned to look at you.
 *
 * The value is slew-limited, not smoothed: it climbs at 1/RISE per second and
 * falls at 1/FALL, so it reaches exactly 0 in finite time, and at 0 everything
 * that reads it (the grade, the fog, the lens) is exactly the unmoved frame.
 */

import { fightMusicFor } from './soundmap.js';
import { POS } from './game.js';
import { ACT_AGGRESSIVE } from './are.js';

/** Within this many metres, with nothing between, a boss that has seen you counts in full. */
export const NEAR = 15;
/** ...and by this many it no longer counts at all. */
export const FAR = 22;
/** Seconds to climb 0 to 1, and to fall 1 to 0. */
export const RISE = 1.5;
export const FALL = 3;
/** The mood has turned above this; it has passed once the value has all but eased out. */
export const THREAT_ON = 0.5;
export const THREAT_OFF = 0.02;
/** One impact at most this often, seconds. */
export const HIT_EVERY = 20;
/** A mobile on another storey is not in the room with you. */
const STOREY = 4;
const SCAN_EVERY = 0.12;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * @param game      the rules engine as the page has it (`mobs`, `state`)
 * @param nav       () => the drawn zone's nav, for `sightBlocked`
 * @param onTurn    called once when the mood turns, no oftener than HIT_EVERY
 */
export function createPresence({ game, nav, onTurn = null }) {
  let value = 0;
  let target = 0;
  let forced = null;
  let threat = false;
  let sinceScan = SCAN_EVERY;
  let clock = 0;
  let lastHit = -Infinity;
  let cause = null;

  /** How strong the pull of the strongest mobile that has noticed you is, with where it stands. */
  function scan(eye) {
    const me = game.state;
    const foe = me.fighting;
    if (foe && fightMusicFor(foe, me) === 'boss') return { weight: 1, why: 'fighting', who: foe };
    const sight = nav();
    let best = { weight: 0, why: null, who: null };
    for (const slot of game.mobs) {
      if (!slot.here || slot.dead || !slot.figure) continue;
      // A mobile nobody has met is not yet a character (game.js wake, which rolls the
      // dice): its prototype's level stands in, and waking it from here would not do.
      const mob = slot.instance || slot.proto;
      if ((slot.instance && mob.position <= POS.SLEEPING) || fightMusicFor(mob, me) !== 'boss') continue;
      const dx = slot.pos.x - eye.x; const dz = slot.pos.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d >= FAR || Math.abs(slot.pos.y - (eye.y - 1.72)) > STOREY) continue;
      if (!aware(slot, dx, dz, d)) continue;
      // Chest height, from the eye: a wall or a crate between is not "near".
      if (sight && sight.sightBlocked(eye.x, eye.y, eye.z, slot.pos.x, slot.pos.y + 1.4, slot.pos.z)) continue;
      // At the edge of its reach it only just counts; close up it is nearly all of you.
      const weight = smooth(FAR, NEAR, d) * (0.6 + 0.3 * smooth(NEAR, 4, d));
      if (weight > best.weight) best = { weight, why: 'near', who: mob };
    }
    return best;
  }

  /** Awake and looking your way, or the sort that does not need to look. */
  function aware(slot, dx, dz, d) {
    if (slot.notice || (slot.instance && slot.instance.fighting)) return true;
    if (slot.proto.act & ACT_AGGRESSIVE) return true;
    const yaw = slot.figure.object.rotation.y;
    // A figure faces +z at yaw 0 (game.js facingAway): -1 is straight at you.
    const away = d > 0 ? -(Math.sin(yaw) * dx + Math.cos(yaw) * dz) / d : 1;
    return away < 0.3;
  }

  /** Called every frame; `eye` is where the player's eyes are. */
  function update(dt, eye) {
    clock += dt;
    sinceScan += dt;
    if (forced !== null) {
      target = forced;
    } else if (sinceScan >= SCAN_EVERY) {
      sinceScan = 0;
      const found = scan(eye);
      target = found.weight;
      cause = found.who && { why: found.why, name: found.who.name || found.who.short, level: found.who.level };
    }
    const step = dt / (target > value ? RISE : FALL);
    value = target > value ? Math.min(target, value + step) : Math.max(target, value - step);
    if (!threat && value >= THREAT_ON) {
      threat = true;
      if (clock - lastHit >= HIT_EVERY) { lastHit = clock; if (onTurn) onTurn(); }
    } else if (threat && value <= THREAT_OFF) {
      threat = false;
    }
    return value;
  }

  return {
    update,
    get value() { return value; },
    get target() { return target; },
    /** True from the mood turning until it has all but eased out: what the music follows. */
    get threat() { return threat; },
    get cause() { return cause; },
    /** For a scripted shot or a test: hold the target at `v` (0..1); null gives it back to the game. It still eases. */
    force(v) { forced = v === null || v === undefined ? null : Math.min(1, Math.max(0, +v)); },
  };
}
