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
import { topAt } from './surface.js';
import { POS } from './game.js';
import { AFF } from './magic.js';
import { castClipOf } from './people.js';
import { staggers } from './motion.js';
import { SKILL_CONTACT, DISARM_FLICK } from './fx.js';

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
/** Under a boss's eye (presence 1) the lens closes this many degrees and the arm drops this many metres. */
const PRESENCE_FOV = 4;
const PRESENCE_DROP = 0.3;
/** A floor or a tread is a slab this thick: under a stair, under the room upstairs. */
const SLAB = 0.45;
/** The camera's own size: how far it keeps off a wall. */
const CAMERA_R = 0.22;
/**
 * Resting or asleep: on the ground itself, since nobody rests on a bench
 * that is not there (the 'sit' clip is for the mobiles' real ones). Shared
 * with link.js, which poses other players from the position the server sends.
 */
export function heldPoseOf(position) {
  if (position === POS.SLEEPING) return 'sleep';
  if (position === POS.RESTING) return 'rest_ground';
  return null;
}

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
/** Out of doors the camera goes over an obstacle by steps of OVER_STEP, up to this far over the feet. */
const OVER_LIFT = 3.5;
const OVER_STEP = 0.5;
/**
 * The colliders are the walls' footprints, not their faces: the Grunting
 * Boar's bar has a stone wall standing 0.38 m in front of its collider and the
 * sewer's iron bars 0.4 m, so a camera the colliders let right up to them is
 * inside. A ray from the eye settles it, and only where a collider is within
 * this of the camera (or the colliders already stopped the arm): in the open
 * middle of a room it is 3.5 ms for nothing.
 */
const FACE_REACH = 1.0;
/** A cast is good for a camera that has moved less than this since. */
const CAST_REUSE = 0.1;

const WIELD = 16;
const SHIELD = 11;
/** The blows a body swings or takes (fx.js, link.js). */
const BLOWS = new Set(['hit', 'miss', 'parry', 'dodge']);
/** How long the body keeps facing your aim after the words of a spell. */
const CAST_FACE = 0.8;
const REVERSE = (135 * Math.PI) / 180;
/**
 * Sprinting (player.js SPRINT 9.5 m/s against WALK 4.8) opens the lens a few
 * degrees, which is most of what makes a run read as fast. Only over the
 * shoulder: first person never touches the FOV.
 */
const SPRINT_PACE = 8;
const FOV_KICK = 6;
/** Time constant in seconds: the ease is 95% done in three of these, about 0.4 s. */
const FOV_TAU = 0.13;
/**
 * The pivot trails a change of pace by up to PIVOT_LAG m: the camera is hung
 * on the body, not welded to it. It is the pivot that moves, never the arm's
 * direction, so every check below still sees the point the arm starts from.
 */
const PACE_TAU = 0.2;
const PIVOT_GAIN = 0.008;
const PIVOT_LAG = 0.06;
const PIVOT_TAU = 0.07;
/** Landing: the pivot dips by up to LAND_DIP and is back in about 0.3 s. */
const LAND_DIP = 0.1;
const DIP_FROM = 4;
const PUFF_FROM = 6;
const RING_FROM = 9;
/**
 * Paving and earth throw dust; water, snow, peat, boards, marble and turf do
 * not. Out of doors only, read off the floor recipe build.js gave the room.
 */
const DUSTY = new Set(['cobble', 'flagstone', 'dirt', 'sand', 'rock', 'ash']);
/** Flying (the spell), the body rides this high over its feet, bobbing. */
const HOVER = 0.32;
/**
 * How far the pivot comes down while the body rests on the ground or sleeps:
 * at the standing eye a seated figure sat at the foot of the frame and a
 * sleeper was half under the panels.
 */
const SEATED = { rest_ground: 0.85, sleep: 1.25 };

export function createView({ camera, player, scene, getBuilt, library, world, game, roomAt, spellfx }) {
  let third = false;
  let presence = 0;
  // A camera put somewhere by hand (diku.look, a judge's shot): the figure
  // goes on living and the arm leaves the camera where it was put.
  let pinned = false;
  const pinAt = new THREE.Vector3();
  const pinTurn = new THREE.Euler();
  let figure = null;
  let bones = null;
  // What spellfx's auras need of a figure (they key on this object).
  let own = null;
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
  const reachC = new THREE.Vector3();
  const reachD = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const current = new THREE.Vector3();
  let clock = 0;
  let hover = 0;
  let seated = 0;
  let facingUntil = 0;
  // What the body turns to while it holds its facing: the one it casts at or
  // strikes, which the crosshair need not be on (a spell at a name, a fight
  // beside you), or a fireball left the hand backwards over the shoulder.
  let faceSlot = null;
  let air = { up: false, since: 0 };
  const pending = [];
  // The lens, the pivot's weight and the dust asked of fx.js (which owns the particles).
  let fovBase = camera.fov;
  let fovSet = camera.fov;
  let fovKick = 0;
  const pacedVelocity = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const sway = new THREE.Vector3();
  const swayNow = new THREE.Vector3();
  let dipTarget = 0;
  let dip = 0;
  let prevVy = 0;
  let wasGround = true;
  let stepPhase = 0;
  let stepSide = 1;
  const dustQueue = [];

  /**
   * The lens, eased towards the sprint's. The base is whatever the FOV was
   * when this last left it alone, so a change made by someone else in
   * between (a resize, an options slider) is the new base and not undone.
   */
  function lens(dt, want) {
    if (camera.fov !== fovSet) fovBase = camera.fov;
    fovKick += (want - fovKick) * (1 - Math.exp(-dt / FOV_TAU));
    if (Math.abs(fovKick - want) < 0.01) fovKick = want;
    const fov = fovKick === 0 ? fovBase : fovBase + fovKick;
    if (fov !== camera.fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    fovSet = fov;
  }
  function lensOff() {
    if (camera.fov !== fovSet) fovBase = camera.fov;
    fovKick = 0;
    if (camera.fov !== fovBase) { camera.fov = fovBase; camera.updateProjectionMatrix(); }
    fovSet = fovBase;
  }

  /** Is the ground under the feet dust, out of doors? */
  function dusty() {
    if (game.state.affectedBy & AFF.FLYING) return false;
    const room = roomAt(player.position.x, player.position.y - EYE, player.position.z);
    return !!room && !!room.outdoor && !!room.materials && DUSTY.has(room.materials.floor);
  }

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
    const worn = [];
    ch.equipment.forEach((o, wearLoc) => { if (o && wearLoc !== WIELD && wearLoc !== SHIELD) worn.push({ vnum: o.vnum, wearLoc }); });
    const key = [ch.name, ch.class, ch.sex, ch.level, weapon, shield, worn.map((w) => `${w.wearLoc}:${w.vnum}`).join(',')].join('|');
    if (figure && key === looks) return;
    if (figure) figure.dispose();
    figure = createPlayerFigure({
      library, name: ch.displayName || ch.name || 'you', cls: ch.class, sex: ch.sex, level: ch.level,
      weapon, shield, worn, objProtos: world.objProtos, roomAt,
    });
    // Your own name is not written over your own head.
    figure.group.traverse((o) => { if (o.isSprite) o.visible = false; });
    scene.add(figure.group);
    bones = { grip: figure.body.getObjectByName('gripR') || figure.body.getObjectByName('handR'), head: figure.body.getObjectByName('head') };
    own = { object: figure.body, at: new THREE.Vector3(), height: figure.height };
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
      // The highest the platform gets within the camera's reach: on a ramp the
      // slab rises towards the uphill side, and a sphere there touches it first.
      const top = q.field
        ? Math.max(topAt(q, p.x, p.z), topAt(q, p.x + CAMERA_R, p.z), topAt(q, p.x - CAMERA_R, p.z), topAt(q, p.x, p.z + CAMERA_R), topAt(q, p.x, p.z - CAMERA_R))
        : q.slope ? Math.max(topAt(q, p.x, p.z), topAt(q, p.x + CAMERA_R * Math.sign(q.slope.ax), p.z + CAMERA_R * Math.sign(q.slope.az))) : q.top;
      if (p.y - CAMERA_R < top && p.y + CAMERA_R > top - SLAB) { lastBlock = `platform top ${top.toFixed(2)}`; lastTop = top; return true; }
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

  /** Is a collider within FACE_REACH of `p`, at about its height? */
  function nearCollider(p) {
    for (const c of player.colliders.near(p.x, p.z, scratch)) {
      if (c.door && (c.whenOpen ? !c.door.open : c.door.open)) continue;
      if (p.y + FACE_REACH <= c.y0 || p.y - FACE_REACH >= c.y1) continue;
      if (p.x > c.x0 - FACE_REACH && p.x < c.x1 + FACE_REACH && p.z > c.z0 - FACE_REACH && p.z < c.z1 + FACE_REACH) return true;
    }
    return false;
  }

  /**
   * Cut the arm to `end` short of the first opaque face on the way from the
   * pivot, in place. The same cast serves while neither end has moved by
   * CAST_REUSE, so turning against a wall casts a few times a second, not
   * every frame.
   */
  const castPivot = new THREE.Vector3();
  const castEnd = new THREE.Vector3();
  let castLen = Infinity;
  let castValid = false;
  function clipToFaces(end) {
    const len = pivot.distanceTo(end);
    if (len < 0.05) return;
    if (!castValid || castPivot.distanceTo(pivot) > CAST_REUSE || castEnd.distanceTo(end) > CAST_REUSE) {
      ray.set(pivot, offset.subVectors(end, pivot).normalize());
      ray.near = 0.05; ray.far = len;
      const hit = ray.intersectObject(getBuilt().group, true).find((h) => h.object.visible && !h.object.isSprite
        && !(h.object.material && h.object.material.transparent));
      castLen = hit ? Math.max(0, hit.distance - CAMERA_R) : Infinity;
      castPivot.copy(pivot); castEnd.copy(end); castValid = true;
    }
    if (castLen < len) end.lerpVectors(pivot, end, castLen / len);
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
      // The gesture of the spell's family; a rig without it makes the plain cast.
      const clip = castClipOf(e.family);
      later(0, () => figure && figure.perform(figure.has(clip) ? clip : 'cast', { contactIn: e.windup || 0.6 }));
      // A spell at something faces it; one on yourself leaves you as you stand.
      if (!e.self) { facingUntil = clock + (e.windup || 0.6) + CAST_FACE; faceSlot = e.to || null; }
      return;
    }
    // The skills carry their own events (rules/skills.js): the body does the
    // clip, timed so its contact is the blow's landing. Until the rig has the
    // clip the plain swing stands in, so the body is never still.
    if (!figure) return;
    const skill = (name, contactIn) => {
      later(0, () => figure && figure.perform(figure.has(name) ? name : 'attack', { contactIn }));
      facingUntil = clock + contactIn + 0.4;
      faceSlot = e.to || null;
    };
    if ((e.kind === 'kick' || e.kind === 'backstab') && !e.from) { skill(e.kind, SKILL_CONTACT); return; }
    if (e.kind === 'disarm' && (e.from !== undefined || e.to !== undefined)) {
      if (!e.from && e.to) skill('disarm', DISARM_FLICK);
      else if (e.from && !e.to) later(0, () => figure && figure.perform('hit', { whole: true }));
      return;
    }
    if (e.spell || !BLOWS.has(e.kind)) return;
    if (!e.from && e.to) {
      later(0, () => figure && figure.perform(e.beat % 2 ? 'attack2' : 'attack', { contactIn: delay }));
      facingUntil = clock + delay + 0.4;
      faceSlot = e.to;
    } else if (e.from && !e.to) {
      if (e.kind === 'hit') {
        // fx.js land's measure of a heavy blow, so the body reels when the screen does.
        const striker = e.from && (e.from.figure || (e.from.remote && e.from.remote.figure));
        const clip = figure && figure.has('stagger') && staggers(e.dam / Math.max(8, e.maxHp || 20) * 2.2, striker, figure) ? 'stagger' : 'hit';
        later(delay, () => figure && figure.perform(clip, { whole: true }));
      }
      else if (e.kind === 'parry' || e.kind === 'dodge') later(Math.max(0, delay - 0.15), () => figure && figure.perform('block', { whole: true }));
    }
  }
  const later = (wait, fn) => pending.push({ at: clock + wait, fn });
  const unlisten = game.listen(onEvent);

  /**
   * Hidden (AFF.HIDE): the figure goes shadowy so you can see you are. Each
   * mesh gets a copy of its material -- the originals are shared with every
   * other body -- and the copy keeps the original's shader hooks, which a
   * plain clone() drops. fx.js adds the smoke at its edge.
   */
  let ghost = { amount: 0, figure: null, parts: [] };
  const DIM = 0.7;
  const SEE_THROUGH = 0.45;
  function ghostOf(material) {
    const g = material.clone();
    g.defines = { ...material.defines };
    g.onBeforeCompile = material.onBeforeCompile;
    g.customProgramCacheKey = material.customProgramCacheKey;
    g.defaultAttributeValues = material.defaultAttributeValues;
    g.userData = material.userData;
    g.transparent = true;
    return g;
  }
  function unghost() {
    for (const part of ghost.parts) {
      part.mesh.material = part.orig;
      for (const g of part.ghosts) g.dispose();
    }
    ghost = { amount: 0, figure: null, parts: [] };
  }
  function updateGhost(dt) {
    const want = (game.state.affectedBy & AFF.HIDE) && game.state.position > POS.SLEEPING ? 1 : 0;
    if (ghost.figure && ghost.figure !== figure) unghost();
    if (!want && ghost.amount < 0.01) { if (ghost.parts.length) unghost(); return; }
    if (!ghost.parts.length) {
      ghost.figure = figure;
      figure.body.traverse((n) => {
        if (!n.isMesh) return;
        const orig = n.material;
        const ghosts = (Array.isArray(orig) ? orig : [orig]).map(ghostOf);
        n.material = Array.isArray(orig) ? ghosts : ghosts[0];
        ghost.parts.push({ mesh: n, orig, ghosts, base: ghosts.map((g, i) => (Array.isArray(orig) ? orig[i] : orig).color?.clone()) });
      });
    }
    ghost.amount += (want - ghost.amount) * Math.min(1, dt * 5);
    for (const part of ghost.parts) {
      part.ghosts.forEach((g, i) => {
        g.opacity = 1 - SEE_THROUGH * ghost.amount;
        if (part.base[i] && g.color) g.color.copy(part.base[i]).multiplyScalar(1 - DIM * ghost.amount);
      });
    }
  }

  /** Resting, asleep or down: the body's held pose from the character's position. */
  function poseOf(position) {
    if (position <= POS.STUNNED) return 'death';
    return heldPoseOf(position);
  }

  // Held facing one way (fighting, casting) the body slides and backpedals;
  // from a sprint on it is let go and turns to run, since a sideways 9.5 m/s
  // is not a thing a body does. Back under the pace it takes the hold again.
  const LET_GO = 7.5;
  const TAKE_BACK = 6.5;
  let released = false;

  /** Which way the body faces: where it is going, or where you look when it fights or casts. */
  /** The yaw that faces the one being cast at or struck, while the facing is held; else null. */
  function faceYaw() {
    if (clock >= facingUntil || !faceSlot || typeof faceSlot !== 'object') return null;
    const at = faceSlot.figure && faceSlot.figure.at;
    if (!at) return null;
    const dx = at.x - player.position.x; const dz = at.z - player.position.z;
    if (dx * dx + dz * dz < 0.09) return null;
    // The camera looks down -Z at yaw 0: facing a point is atan2 of the negated offset.
    return Math.atan2(-dx, -dz);
  }

  function turn(dt, moved, aiming, aimAt = null) {
    let target = heading;
    if (aiming) target = aimAt ?? camera.rotation.y;
    else if (moved.lengthSq() > (0.3 * dt) ** 2) target = Math.atan2(-moved.x, -moved.z);
    const d = Math.atan2(Math.sin(target - heading), Math.cos(target - heading));
    // Going back on yourself, the body pivots at twice the rate it swings round.
    const rate = !aiming && moved.lengthSq() > (0.3 * dt) ** 2 && Math.abs(d) > REVERSE ? 24 : 12;
    heading += d * Math.min(1, dt * rate);
  }

  function update(dt, { active = true, aiming = false } = {}) {
    if (!third || !active) {
      if (figure) figure.group.visible = false;
      lastValid = false;
      lensOff();
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
    updateGhost(dt);
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
    // A pinned camera is somewhere else's view: the body keeps its own facing.
    const pace = dt > 0 ? moved.length() / dt : 0;
    if (pace > LET_GO) released = true; else if (pace < TAKE_BACK) released = false;
    // A target turns the body even under a pinned camera: it is the body's own business.
    const aimAt = faceYaw();
    const locked = ((!pinned && (aiming || clock < facingUntil)) || aimAt !== null) && !released;
    turn(dt, moved, locked, aimAt);
    feet.set(player.position.x, player.position.y - EYE, player.position.z);
    // The movement in the body's own frame, for the legs: forward and to the
    // left, against the yaw it is held to (the camera's, not the lagging heading).
    const held = aimAt ?? camera.rotation.y;
    figure.update(dt, feet, heading, pace, {
      locked, face: held,
      fwd: dt > 0 ? (-moved.x * Math.sin(held) - moved.z * Math.cos(held)) / dt : 0,
      side: dt > 0 ? (-moved.x * Math.cos(held) + moved.z * Math.sin(held)) / dt : 0,
    });
    own.at.copy(feet);

    // The sprint opens the lens. A pinned camera is a judge's, and is left alone.
    lens(dt, (!pinned && pace > SPRINT_PACE && player.onGround ? FOV_KICK : 0) - presence * PRESENCE_FOV);

    // The pivot's weight: pace is followed lazily and the gap between the
    // two is what the camera lags (speeding up) or leads (stopping) by.
    // A teleport is not a pace.
    if (dt > 0 && pace < 20) velocity.copy(moved).divideScalar(dt); else velocity.set(0, 0, 0);
    pacedVelocity.lerp(velocity, 1 - Math.exp(-dt / PACE_TAU));
    sway.subVectors(pacedVelocity, velocity).multiplyScalar(PIVOT_GAIN);
    if (sway.length() > PIVOT_LAG) sway.setLength(PIVOT_LAG);
    swayNow.lerp(sway, 1 - Math.exp(-dt / PIVOT_TAU));
    // Landing: the impact is read from last frame's fall (player.step has
    // already zeroed it on the frame it lands). The dip rises and recovers.
    if (player.onGround && !wasGround && prevVy < -DIP_FROM) {
      dipTarget = Math.min(LAND_DIP * 1.3, (-prevVy - DIP_FROM) * 0.018);
      if (dusty() && -prevVy > PUFF_FROM) {
        dustQueue.push({ kind: -prevVy > RING_FROM ? 'ring' : 'puff', x: feet.x, y: feet.y, z: feet.z, power: Math.min(1, (-prevVy - PUFF_FROM) / 8) });
      }
    }
    wasGround = player.onGround;
    prevVy = player.velocity.y;
    dipTarget *= Math.exp(-dt / 0.09);
    dip += (dipTarget - dip) * (1 - Math.exp(-dt / 0.04));
    // A foot comes down on each half-turn of the stride (player.js bobPhase):
    // the one that lands under a sprint on paving or earth kicks up a puff.
    const phase = Math.floor(player.bobPhase / Math.PI);
    if (phase !== stepPhase) {
      stepPhase = phase;
      stepSide = -stepSide;
      if (pace > SPRINT_PACE && player.onGround && dusty()) {
        dustQueue.push({ kind: 'step', x: feet.x + Math.cos(heading) * 0.12 * stepSide, y: feet.y, z: feet.z - Math.sin(heading) * 0.12 * stepSide });
      }
    }
    // Under fly the body rides the air and its shadow stays on the ground,
    // which is what says it is off it. The game's own feet do not move.
    const flying = (game.state.affectedBy & AFF.FLYING) && game.state.position > POS.SLEEPING;
    hover += ((flying ? HOVER : 0) - hover) * Math.min(1, dt * 2.5);
    figure.body.position.y = hover > 0.002 ? hover + Math.sin(clock * 1.9) * 0.04 * (hover / HOVER) : 0;

    // player.step puts the camera back on the head every frame; a pinned one
    // is put back where it was pinned.
    if (pinned) { camera.position.copy(pinAt); camera.rotation.copy(pinTurn); figure.group.visible = true; return; }
    // The arm: from the eye, back along the view, up and over the shoulder.
    const yaw = camera.rotation.y; const pitch = camera.rotation.x;
    forward.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    pivot.copy(player.position);
    seated += ((SEATED[poseOf(game.state.position)] || 0) - seated) * Math.min(1, dt * 3);
    // The weight moves the pivot only where a camera could stand: a lag
    // into a wall is dropped, since the arm's checks begin at the pivot.
    offset.copy(swayNow).setY(-dip - seated);
    if (offset.lengthSq() > 1e-8) {
      pivot.add(offset);
      if (blocked(pivot)) pivot.copy(player.position);
    }
    want.copy(pivot).addScaledVector(forward, -ARM).addScaledVector(right, SHOULDER).addScaledVector(up, RISE - presence * PRESENCE_DROP);
    // Never under the feet: looking up swings the camera down towards the floor.
    want.y = Math.max(want.y, feet.y + 0.4);
    if (ceiling.indoor) want.y = Math.min(want.y, feet.y + INDOOR_TOP);
    let target = reachA;
    const stopped = !reach([pivot, want], reachA);
    if (stopped && lastTop < feet.y + OVER_MAX) {
      // Over it: straight up past its top, then back. The eye still has to see
      // the camera in a straight line, so a camera that is over a low altar
      // but whose line from the eye clips the altar's edge goes higher, and
      // failing that comes in to where the line is clear (the fountain, the
      // temple's altar steps: 1.7 m of view through marble).
      const from = lastTop + 0.35;
      const limit = Math.min(ceiling.y - CAMERA_R - 0.05, ceiling.indoor ? feet.y + INDOOR_TOP : feet.y + OVER_LIFT);
      let best = reachA.distanceTo(pivot) + 0.3;
      for (let top = from; ; top += OVER_STEP) {
        const t = Math.min(top, limit);
        if (t > pivot.y) {
          over.set(pivot.x, t, pivot.z);
          wantOver.copy(want).setY(Math.max(want.y, t));
          reach([pivot, over, wantOver], reachB);
          const seen = reach([pivot, reachB], reachC);
          const got = seen ? reachB : reachC;
          if (got.distanceTo(pivot) > best) { best = got.distanceTo(pivot); reachD.copy(got); target = reachD; }
          if (seen) break;
        }
        if (t >= limit) break;
      }
    }
    if (stopped || nearCollider(target)) clipToFaces(target); else castValid = false;
    // In at once, out again gently: a wall never shows through, a gap that
    // opens does not jerk the view. Only the length is eased: the direction
    // is always the one just checked, because easing the vector itself swings
    // the camera along the chord between two safe places, and that chord went
    // through a wall or an altar in 10 of 1440 measured poses.
    offset.subVectors(target, pivot);
    const goal = offset.length();
    let length = current.length();
    length = goal < length ? goal : length + (goal - length) * Math.min(1, dt * RELEASE);
    current.copy(offset).setLength(length);
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
    /** The figure as spellfx's auras see a mobile's: its body, where it stands, how tall. */
    figure: () => (figure && figure.group.visible ? own : null),
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
      castValid = false;
      ceiling = { key: '', y: Infinity, indoor: false };
      pacedVelocity.set(0, 0, 0); swayNow.set(0, 0, 0); dip = 0; dipTarget = 0;
      prevVy = 0; wasGround = true; dustQueue.length = 0;
      player.body = body;
      if (spellfx) spellfx.setSelf(self);
    } else {
      player.body = firstPerson;
      lensOff();
      dustQueue.length = 0;
      if (spellfx) spellfx.setSelf(null);
      if (figure) figure.group.visible = false;
      camera.position.copy(player.position);
    }
  }

  const api = {
    get third() { return third; },
    /** 0..1, set each frame by main.js from presence.js; only the lens and the arm read it. */
    get presence() { return presence; },
    set presence(v) { presence = v; },
    get figure() { return figure; },
    toggle() { set(!third); return third; },
    pin(on) { pinned = !!on; if (pinned) { pinAt.copy(camera.position); pinTurn.copy(camera.rotation); } },
    /** What the arm is doing, for the headless checks: its length, the ceiling, indoors. */
    get state() { return { arm, ceiling: ceiling.y, indoor: ceiling.indoor, blockedAt: lastBlock }; },
    set,
    update,
    /** The dust the feet have kicked up since last asked, for fx.js to throw. */
    takeDust() { return dustQueue.splice(0); },
    dispose() {
      unlisten();
      set(false);
      unghost();
      if (camera.userData.view === api) delete camera.userData.view;
      if (figure) figure.dispose();
      figure = null;
    },
  };
  // fx.js reads this to tell the view over the shoulder from first person, and
  // to find your figure: nothing else in the page is shared between the two.
  camera.userData.view = api;
  return api;
}
