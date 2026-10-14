/**
 * The view over the shoulder (V): the camera stands back from the player's
 * own figure, which is the body other players already see (actors.js
 * `createPlayerFigure`), and the head the mouse turns is the pivot it stands
 * back from.
 *
 * Player still owns everything it owned: the eye point, collision, the mouse.
 * Each frame `update` takes the camera from where `player.step` left it (the
 * head) to a point 2.6 m behind it, a little up and to the right, and pulls
 * that point in along the arm wherever a body could not stand -- the same
 * colliders the player walks against, so the camera is never inside a wall a
 * body would have stopped at. Measured before choosing: a ray against the
 * built world is 3.5 ms (1.8 million triangles, in the temple, the market,
 * the Grunting Boar, the mages' lab), which is too much for every frame; the
 * walls' colliders reach 4.5 m and more, the furniture's stay under 2. The
 * ceiling is the one thing colliders do not hold, so it is read with one ray
 * straight up whenever the player is in a new half-cell.
 *
 * `player.body` is how everything that means the player's body reads it
 * (main.js, spellfx, items, hud, actors): here it is swapped for the
 * figure's eye and heading while the camera stands back, and handed back
 * when it does not.
 */

import * as THREE from 'three';
import { createPlayerFigure } from './actors.js';
import { POS } from './game.js';

/**
 * Behind, up and to the right of the eye, in metres. At 2.6 m the figure was
 * cut off at the knees and stood under the room panel; at 3.4 m and 0.62 up,
 * with a short shoulder, it stands whole in the free middle between the two
 * panels at the foot of the screen, its feet clear of a mage's spell bar.
 * The shoulder is all but gone: at 0.25 m, on a 960 px screen, the figure
 * stood behind the room's description panel and a spell came out of it.
 */
const ARM = 3.4;
const RISE = 0.62;
const SHOULDER = 0.1;
/** A floor or a tread is a slab this thick: under a stair, under the room upstairs. */
const SLAB = 0.45;
/** The camera's own size: how far it keeps off a wall. */
const CAMERA_R = 0.22;
/** Closer than this the figure would fill the view from inside its own head. */
const NEAR_HIDE = 0.75;
/** How far the arm may grow back each second once a wall is out of the way. */
const RELEASE = 4;
const EYE = 1.72;
const STEP = 0.08;
/**
 * Indoors the camera stays this far over the feet. Looking down swings it up,
 * and a room's beams and ledges are over a body's head but not over the
 * camera's: measured near the walls, 4 of 48 headings in the temple had its
 * marble at 2.5 m between the head and the camera, and the Grunting Boar's
 * chimney breast at 2.2 m. Out of doors it rises as far as the arm takes it.
 */
const INDOOR_TOP = 2.2;
/**
 * Whatever stops the arm and is lower than this over the feet, the camera
 * goes over rather than in: a 2 m fence behind you in the Shire pulled it to
 * 0.72 m and the figure vanished.
 */
const OVER_MAX = 3.0;

const WIELD = 16;
const SHIELD = 11;
/** The blows a body swings or takes (fx.js, link.js). */
const BLOWS = new Set(['hit', 'miss', 'parry', 'dodge']);
/** How long the body keeps facing your aim after the words of a spell. */
const CAST_FACE = 0.8;

export function createView({ camera, player, scene, getBuilt, library, world, game, roomAt, spellfx }) {
  let third = false;
  // A camera put somewhere by hand (diku.look, a judge's shot): the figure
  // goes on living and the arm leaves the camera where it was put.
  let pinned = false;
  const pinAt = new THREE.Vector3();
  const pinTurn = new THREE.Euler();
  let figure = null;
  let bones = null;
  let looks = '';
  let heading = camera.rotation.y;
  let arm = ARM;
  const last = new THREE.Vector3();
  let lastValid = false;
  let ceiling = { key: '', y: Infinity, indoor: false };
  const ray = new THREE.Raycaster();
  const up = new THREE.Vector3(0, 1, 0);
  const scratch = [];
  const pivot = new THREE.Vector3();
  const want = new THREE.Vector3();
  const at = new THREE.Vector3();
  const feet = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const moved = new THREE.Vector3();
  const over = new THREE.Vector3();
  const wantOver = new THREE.Vector3();
  const reachA = new THREE.Vector3();
  const reachB = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const current = new THREE.Vector3();
  let clock = 0;
  let facingUntil = 0;
  let air = { up: false, since: 0 };
  const pending = [];

  const firstPerson = player.body;
  // What you aim at is where you look, through the crosshair (game.update's
  // facing picks what a swing or a spell goes at); which way you are going is
  // the body's (crossings, the yaw kept on a spawn).
  const body = {
    eye: (out) => out.copy(player.position),
    heading: () => heading,
    forward: (out) => camera.getWorldDirection(out),
  };

  /** The figure for the character as it is now, built again when its looks change. */
  function ensureFigure() {
    const ch = game.state;
    const weapon = ch.equipment[WIELD]?.vnum || 0;
    const shield = ch.equipment[SHIELD]?.vnum || 0;
    const key = [ch.name, ch.class, ch.sex, ch.level, weapon, shield].join('|');
    if (figure && key === looks) return;
    if (figure) figure.dispose();
    figure = createPlayerFigure({
      library, name: ch.displayName || ch.name || 'you', cls: ch.class, sex: ch.sex, level: ch.level,
      weapon, shield, objProtos: world.objProtos, roomAt,
    });
    // Your own name is not written over your own head.
    figure.group.traverse((o) => { if (o.isSprite) o.visible = false; });
    scene.add(figure.group);
    bones = { grip: figure.body.getObjectByName('gripR') || figure.body.getObjectByName('handR'), head: figure.body.getObjectByName('head') };
    looks = key;
  }

  /**
   * Could a camera of radius CAMERA_R stand at `p`? The player's colliders at
   * the camera's height, and its platforms as slabs: the camera stood just
   * under the Grunting Boar's stair, the planks of its underside filling half
   * the view.
   */
  let lastBlock = null;
  let lastTop = Infinity;
  function blocked(p) {
    if (p.y > ceiling.y - CAMERA_R) { lastBlock = 'ceiling'; lastTop = Infinity; return true; }
    for (const q of player.platforms.near(p.x, p.z, scratch)) {
      if (q.door && q.door.open) continue;
      if (p.x < q.x0 - CAMERA_R || p.x > q.x1 + CAMERA_R || p.z < q.z0 - CAMERA_R || p.z > q.z1 + CAMERA_R) continue;
      if (p.y - CAMERA_R < q.top && p.y + CAMERA_R > q.top - SLAB) { lastBlock = `platform top ${q.top.toFixed(2)}`; lastTop = q.top; return true; }
    }
    for (const c of player.colliders.near(p.x, p.z, scratch)) {
      if (c.door && (c.whenOpen ? !c.door.open : c.door.open)) continue;
      if (p.y + CAMERA_R <= c.y0 || p.y - CAMERA_R >= c.y1) continue;
      if (c.r) {
        const cx = (c.x0 + c.x1) / 2; const cz = (c.z0 + c.z1) / 2;
        if (Math.hypot(p.x - cx, p.z - cz) < c.r + CAMERA_R) { lastBlock = 'drum'; lastTop = c.y1; return true; }
        continue;
      }
      if (p.x > c.x0 - CAMERA_R && p.x < c.x1 + CAMERA_R && p.z > c.z0 - CAMERA_R && p.z < c.z1 + CAMERA_R) { lastBlock = `box y ${c.y0.toFixed(1)}-${c.y1.toFixed(1)}`; lastTop = c.y1; return true; }
    }
    return false;
  }

  /**
   * How far a camera gets along the path `points` (the first is the pivot),
   * into `out`: the last sample a step short of whatever blocks it. Returns
   * whether it got to the end; `lastTop` is the top of what stopped it.
   */
  function reach(points, out) {
    out.copy(points[0]);
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1]; const b = points[k];
      const len = a.distanceTo(b);
      for (let s = STEP; s < len + STEP; s += STEP) {
        at.lerpVectors(a, b, Math.min(1, s / len));
        if (blocked(at)) return false;
        out.copy(at);
      }
    }
    return true;
  }

  /** The ceiling over the player, read again in each new half-cell (one ray, 3.5 ms). */
  function readCeiling() {
    const key = `${Math.round(player.position.x / 6.5)},${Math.round(player.position.z / 6.5)},${Math.round(player.position.y / 2)}`;
    if (key === ceiling.key) return;
    ray.set(player.position, up);
    ray.near = 0; ray.far = 12;
    const hit = ray.intersectObject(getBuilt().group, true).find((h) => h.object.visible && !h.object.isSprite
      && !(h.object.material && h.object.material.transparent));
    const room = roomAt(player.position.x, player.position.y - EYE, player.position.z);
    ceiling = { key, y: hit ? hit.point.y : Infinity, indoor: !!room && !room.outdoor };
  }

  /**
   * What the game says you did, done by the body. In the page a blow's `from`
   * or `to` is null when it is you (game.js blow()); the first-person hands
   * (fx.js) read the same events, which is why the clip is timed the same way:
   * the swing lands on the blow's own delay, the spell leaves on the end of
   * its words.
   */
  function onEvent(e) {
    if (!third) return;
    const delay = e.delay || 0;
    if (e.kind === 'cast' && e.fromPlayer && !e.lost && !['quaff', 'eat'].includes(e.source)) {
      later(0, () => figure && figure.perform('cast', { contactIn: e.windup || 0.6 }));
      facingUntil = clock + (e.windup || 0.6) + CAST_FACE;
      return;
    }
    if (e.spell || !BLOWS.has(e.kind)) return;
    if (!e.from && e.to) {
      later(0, () => figure && figure.perform(e.beat % 2 ? 'attack2' : 'attack', { contactIn: delay }));
      facingUntil = clock + delay + 0.4;
    } else if (e.from && !e.to) {
      if (e.kind === 'hit') later(delay, () => figure && figure.perform('hit', { whole: true }));
      else if (e.kind === 'parry' || e.kind === 'dodge') later(Math.max(0, delay - 0.15), () => figure && figure.perform('block', { whole: true }));
    }
  }
  const later = (wait, fn) => pending.push({ at: clock + wait, fn });
  const unlisten = game.listen(onEvent);

  /** Resting, asleep or down: the body's held pose from the character's position. */
  function poseOf(position) {
    if (position <= POS.STUNNED) return 'death';
    if (position === POS.SLEEPING || position === POS.RESTING) return 'sit';
    return null;
  }

  /** Which way the body faces: where it is going, or where you look when it fights or casts. */
  function turn(dt, moved, aiming) {
    let target = heading;
    if (aiming) target = camera.rotation.y;
    else if (moved.lengthSq() > (0.3 * dt) ** 2) target = Math.atan2(-moved.x, -moved.z);
    const d = Math.atan2(Math.sin(target - heading), Math.cos(target - heading));
    heading += d * Math.min(1, dt * 12);
  }

  function update(dt, { active = true, aiming = false } = {}) {
    if (!third || !active) {
      if (figure) figure.group.visible = false;
      lastValid = false;
      return;
    }
    ensureFigure();
    readCeiling();
    clock += dt;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (clock < pending[i].at) continue;
      const { fn } = pending[i];
      pending.splice(i, 1);
      fn();
    }
    figure.pose(poseOf(game.state.position));
    // Off the ground: a jump at once, a step off an edge only once it is a fall.
    if (!player.onGround) {
      if (!air.up && (player.velocity.y > 0.5 || clock - air.since > 0.18)) { air.up = true; figure.air(true); }
    } else {
      air.since = clock;
      if (air.up) { air.up = false; figure.air(false); }
    }

    // How far the body went this frame, for its legs and its facing.
    if (lastValid) moved.subVectors(player.position, last).setY(0); else moved.set(0, 0, 0);
    last.copy(player.position);
    lastValid = true;
    turn(dt, moved, aiming || clock < facingUntil);
    const pace = dt > 0 ? moved.length() / dt : 0;
    feet.set(player.position.x, player.position.y - EYE, player.position.z);
    figure.update(dt, feet, heading, pace);

    // player.step puts the camera back on the head every frame; a pinned one
    // is put back where it was pinned.
    if (pinned) { camera.position.copy(pinAt); camera.rotation.copy(pinTurn); figure.group.visible = true; return; }
    // The arm: from the eye, back along the view, up and over the shoulder.
    const yaw = camera.rotation.y; const pitch = camera.rotation.x;
    forward.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    pivot.copy(player.position);
    want.copy(pivot).addScaledVector(forward, -ARM).addScaledVector(right, SHOULDER).addScaledVector(up, RISE);
    // Never under the feet: looking up swings the camera down towards the floor.
    want.y = Math.max(want.y, feet.y + 0.4);
    if (ceiling.indoor) want.y = Math.min(want.y, feet.y + INDOOR_TOP);
    let target = reachA;
    if (!reach([pivot, want], reachA) && lastTop < feet.y + OVER_MAX) {
      // Over it: straight up past its top, then back.
      const top = Math.min(lastTop + 0.35, ceiling.y - CAMERA_R - 0.05, ceiling.indoor ? feet.y + INDOOR_TOP : Infinity);
      if (top > pivot.y) {
        over.set(pivot.x, top, pivot.z);
        wantOver.copy(want).setY(Math.max(want.y, top));
        reach([pivot, over, wantOver], reachB);
        if (reachB.distanceTo(pivot) > reachA.distanceTo(pivot) + 0.3) target = reachB;
      }
    }
    // In at once, out again gently: a wall never shows through, a gap that
    // opens does not jerk the view.
    offset.subVectors(target, pivot);
    if (offset.lengthSq() < current.lengthSq()) current.copy(offset);
    else current.lerp(offset, Math.min(1, dt * RELEASE));
    arm = current.length();
    camera.position.copy(pivot).add(current);
    // The figure walks; the camera does not bob or roll with it.
    camera.rotation.z = 0;
    figure.group.visible = arm >= NEAR_HIDE;
  }

  /**
   * Where a spell leaves you and lands on you, read off the figure: its right
   * fist (where a staff is held), its head, its chest, its feet. spellfx falls
   * back to the camera's own when these are handed back.
   */
  const self = {
    hand: (out) => (bones && bones.grip ? bones.grip.getWorldPosition(out) : self.chest(out)),
    mouth: (out) => {
      if (bones && bones.head) return bones.head.getWorldPosition(out).addScaledVector(body.forward(at), 0.12);
      return out.set(player.position.x, player.position.y - 0.08, player.position.z);
    },
    chest: (out) => out.set(player.position.x, player.position.y - EYE + (figure ? figure.height : 1.75) * 0.62, player.position.z),
    feet: (out) => out.set(player.position.x, player.position.y - EYE, player.position.z),
    /** The staff's knot, when the figure carries one (spellfx glows it with your mana). */
    staff: (out) => (figure && figure.staff && figure.castPoint && figure.group.visible ? figure.castPoint.getWorldPosition(out) : null),
  };

  function set(on) {
    third = !!on;
    if (third) {
      heading = camera.rotation.y;
      arm = 0;
      current.set(0, 0, 0);
      lastValid = false;
      ceiling = { key: '', y: Infinity, indoor: false };
      player.body = body;
      if (spellfx) spellfx.setSelf(self);
    } else {
      player.body = firstPerson;
      if (spellfx) spellfx.setSelf(null);
      if (figure) figure.group.visible = false;
      camera.position.copy(player.position);
    }
  }

  return {
    get third() { return third; },
    get figure() { return figure; },
    toggle() { set(!third); return third; },
    pin(on) { pinned = !!on; if (pinned) { pinAt.copy(camera.position); pinTurn.copy(camera.rotation); } },
    /** What the arm is doing, for the headless checks: its length, the ceiling, indoors. */
    get state() { return { arm, ceiling: ceiling.y, indoor: ceiling.indoor, blockedAt: lastBlock }; },
    set,
    update,
    dispose() {
      unlisten();
      set(false);
      if (figure) figure.dispose();
      figure = null;
    },
  };
}
