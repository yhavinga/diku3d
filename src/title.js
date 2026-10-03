/**
 * The title screen's reel: the built world behind the title card, a slow
 * camera move through a handful of places, cross-faded through black. The
 * world is finished before the title comes up, so a black card in front of
 * it was hiding the one thing worth showing.
 *
 * Each shot is a straight dolly between two points while the camera stays
 * on one aim point, which turns a short move into parallax -- the near
 * frontage slides past the far one, the thing a still cannot do. Points are
 * relative to the room's centre, so they follow the layout, and a shot whose
 * room is not built (`?areas=midgaard`) or whose line of sight a later
 * change has walled off is dropped rather than shown into a wall. If none
 * survives, the reel falls back to the viewer's own `places()` and
 * `vantage()` framings.
 */

import * as THREE from 'three';

const EYE = 1.72;

// Framed by eye in the headless browser at dusk, 1280x720.
const SHOTS = [
  // Market Square: across the paving, the frontage sliding past the statue.
  { vnum: 3014, from: [-7, 0.5, 10], to: [-3, 0.8, 8.5], aim: [5, 3, -10] },
  // The Temple Square: the fountain, the arch and the way up to the temple.
  { vnum: 3005, from: [-4, 0.4, 11], to: [1.5, 0.6, 10], aim: [0, 2.5, -12] },
  // Inside the West Gate: the street pushing in on the sealed gate.
  { vnum: 3040, from: [11, 0.3, 0], to: [6, 0.3, 0], aim: [-8, 3, 0] },
  // The oasis: palms, the pool and the nomads' tents under the cliffs.
  { vnum: 5056, from: [-6, 0.6, 1.5], to: [-6.5, 0.8, -3], aim: [12, 2, -2] },
  // The sewer's quadruple junction: down the brick vault.
  { vnum: 7030, from: [0, 0, 2.2], to: [0, 0, -0.8], aim: [0, 1.7, -24] },
  // The graveyard road: the gate and its towers over the headstones.
  { vnum: 3600, from: [-3, 0.2, 11], to: [3, 0.2, 10], aim: [0, 3, -8] },
];

const HOLD = 13;       // seconds per shot
const FADE_IN = 1.6;
const FADE_OUT = 1.1;

const ease = (u) => u * u * (3 - 2 * u);

/**
 * @param {object} deps
 *   camera, built (rooms, group, horizon),
 *   veil (an element whose opacity is the black between shots),
 *   viewer (window.diku: places/shoot, for the fallback).
 */
export function createTitleReel({ camera, built, veil, viewer }) {
  const shots = [];
  const ray = new THREE.Raycaster();
  const blocked = (p, q, far) => {
    ray.set(p, q.clone().sub(p).normalize());
    ray.far = far;
    return ray.intersectObject(built.group, true).length > 0;
  };
  const eyeOf = (p) => new THREE.Vector3(p.x, p.y + EYE, p.z);
  for (const shot of SHOTS) {
    const info = built.rooms.get(shot.vnum);
    if (!info || info.unbuilt) continue;
    const c = info.center;
    const at = (o) => new THREE.Vector3(c.x + o[0], c.y + o[1], c.z + o[2]);
    const from = at(shot.from); const to = at(shot.to); const aim = at(shot.aim);
    // Against what is drawn, not the colliders: the oasis's colliders stand
    // where nothing is visible and would have dropped the best shot, while
    // a column with no collider would fill the frame. Only the first few
    // metres -- a fountain or a palm further on is what the shot is of.
    const a = eyeOf(from); const b = eyeOf(to);
    if (blocked(a, b, a.distanceTo(b)) || blocked(a, aim, 4) || blocked(b, aim, 4)) continue;
    shots.push({ from, to, aim });
  }
  if (!shots.length && viewer && viewer.shoot) {
    // Whatever areas are loaded: the viewer's own framings (places() and
    // vantage(), by way of shoot()), with a short push toward the subject
    // standing in for the dolly.
    for (const place of viewer.places().slice(0, 5)) {
      if (typeof viewer.shoot(place.key) !== 'object') continue;
      const yaw = camera.rotation.y;
      const ahead = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const from = camera.position.clone().setY(camera.position.y - EYE);
      shots.push({
        from,
        to: from.clone().addScaledVector(ahead, 1.2),
        aim: camera.position.clone().addScaledVector(ahead, 20),
      });
    }
  }

  let index = -1;
  let t = 0;
  let active = shots.length > 0;
  const eye = new THREE.Vector3();

  function cut() {
    index = (index + 1) % shots.length;
    t = 0;
    const { from } = shots[index];
    camera.position.copy(eyeOf(from));
    // A jump is not a walk: the skyline should not be seen sinking.
    if (built.horizon && built.horizon.settle) built.horizon.settle(camera.position);
  }

  function update(dt) {
    if (!active) return;
    if (index < 0) cut();
    t += dt;
    if (t >= HOLD) cut();
    const shot = shots[index];
    const u = ease(Math.min(1, t / HOLD));
    eye.copy(eyeOf(shot.from)).lerp(eyeOf(shot.to), u);
    camera.position.copy(eye);
    // The camera looks down -Z at yaw 0: facing a point is atan2 of the
    // negated offset.
    const dx = shot.aim.x - eye.x; const dz = shot.aim.z - eye.z;
    camera.rotation.set(Math.atan2(shot.aim.y - eye.y, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0);
    camera.updateMatrixWorld();
    const black = t < FADE_IN ? 1 - t / FADE_IN : t > HOLD - FADE_OUT ? (t - (HOLD - FADE_OUT)) / FADE_OUT : 0;
    if (veil) veil.style.opacity = String(Math.max(0, Math.min(1, black)).toFixed(3));
  }

  function stop() {
    active = false;
    if (veil) veil.style.opacity = '0';
    // The reel is over for good: let go of the world it was filmed in, or a
    // crossing (main.js crossTo) could never free the zone it started in.
    built = null;
    shots.length = 0;
  }

  return {
    get active() { return active; },
    get shots() { return shots.length; },
    update,
    stop,
  };
}
