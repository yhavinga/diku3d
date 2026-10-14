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

/**
 * Behind, up and to the right of the eye, in metres. At 2.6 m the figure was
 * cut off at the knees and stood under the room panel; at 3.4 m and 0.62 up,
 * with a short shoulder, it stands whole in the free middle between the two
 * panels at the foot of the screen, its feet clear of a mage's spell bar.
 */
const ARM = 3.4;
const RISE = 0.62;
const SHOULDER = 0.25;
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

const WIELD = 16;
const SHIELD = 11;

export function createView({ camera, player, scene, getBuilt, library, world, game, roomAt, spellfx }) {
  let third = false;
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

  const firstPerson = player.body;
  const body = {
    eye: (out) => out.copy(player.position),
    heading: () => heading,
    forward: (out) => out.set(-Math.sin(heading), 0, -Math.cos(heading)),
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
  function blocked(p) {
    if (p.y > ceiling.y - CAMERA_R) return true;
    for (const q of player.platforms.near(p.x, p.z, scratch)) {
      if (q.door && q.door.open) continue;
      if (p.x < q.x0 - CAMERA_R || p.x > q.x1 + CAMERA_R || p.z < q.z0 - CAMERA_R || p.z > q.z1 + CAMERA_R) continue;
      if (p.y - CAMERA_R < q.top && p.y + CAMERA_R > q.top - SLAB) return true;
    }
    for (const c of player.colliders.near(p.x, p.z, scratch)) {
      if (c.door && (c.whenOpen ? !c.door.open : c.door.open)) continue;
      if (p.y + CAMERA_R <= c.y0 || p.y - CAMERA_R >= c.y1) continue;
      if (c.r) {
        const cx = (c.x0 + c.x1) / 2; const cz = (c.z0 + c.z1) / 2;
        if (Math.hypot(p.x - cx, p.z - cz) < c.r + CAMERA_R) return true;
        continue;
      }
      if (p.x > c.x0 - CAMERA_R && p.x < c.x1 + CAMERA_R && p.z > c.z0 - CAMERA_R && p.z < c.z1 + CAMERA_R) return true;
    }
    return false;
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

    // How far the body went this frame, for its legs and its facing.
    if (lastValid) moved.subVectors(player.position, last).setY(0); else moved.set(0, 0, 0);
    last.copy(player.position);
    lastValid = true;
    turn(dt, moved, aiming);
    const pace = dt > 0 ? moved.length() / dt : 0;
    feet.set(player.position.x, player.position.y - EYE, player.position.z);
    figure.update(dt, feet, heading, pace);

    // The arm: from the eye, back along the view, up and over the shoulder.
    const yaw = camera.rotation.y; const pitch = camera.rotation.x;
    forward.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    pivot.copy(player.position);
    want.copy(pivot).addScaledVector(forward, -ARM).addScaledVector(right, SHOULDER).addScaledVector(up, RISE);
    // Never under the feet: looking up swings the camera down towards the floor.
    want.y = Math.max(want.y, feet.y + 0.4);
    if (ceiling.indoor) want.y = Math.min(want.y, feet.y + INDOOR_TOP);
    const span = want.distanceTo(pivot);
    let free = span;
    for (let s = STEP; s <= span; s += STEP) {
      at.lerpVectors(pivot, want, s / span);
      if (blocked(at)) { free = Math.max(0, s - STEP); break; }
    }
    arm = free < arm ? free : arm + (free - arm) * Math.min(1, dt * RELEASE);
    camera.position.lerpVectors(pivot, want, span > 0 ? Math.min(1, arm / span) : 0);
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
  };

  function set(on) {
    third = !!on;
    if (third) {
      heading = camera.rotation.y;
      arm = 0;
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
    set,
    update,
    dispose() {
      set(false);
      if (figure) figure.dispose();
      figure = null;
    },
  };
}
