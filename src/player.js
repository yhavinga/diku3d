/**
 * First-person movement. Ground height comes from the platform list the builder
 * hands over (floors, passages, stair treads) rather than from raycasts, so a
 * flight of twenty-two steps costs the same as flat ground. Walls are axis-
 * aligned boxes resolved along the shallowest penetration; a collider with an
 * `r` is round (a fountain's drum) and pushes out along its radius instead.
 */

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const EYE = 1.72;
const RADIUS = 0.42;
const HEIGHT = 1.8;
const STEP_UP = 0.62;
const GRAVITY = 24;
const WALK = 4.8;
const SPRINT = 9.5;
const GRID = 8;

class SpatialGrid {
  constructor(items) {
    this.cells = new Map();
    for (const item of items) {
      const x0 = Math.floor(item.x0 / GRID); const x1 = Math.floor(item.x1 / GRID);
      const z0 = Math.floor(item.z0 / GRID); const z1 = Math.floor(item.z1 / GRID);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = `${x},${z}`;
          let bucket = this.cells.get(key);
          if (!bucket) { bucket = []; this.cells.set(key, bucket); }
          bucket.push(item);
        }
      }
    }
  }

  near(x, z, out) {
    out.length = 0;
    const cx = Math.floor(x / GRID); const cz = Math.floor(z / GRID);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this.cells.get(`${cx + dx},${cz + dz}`);
        if (bucket) for (const item of bucket) out.push(item);
      }
    }
    return out;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** Push a point out of a round collider (radius `r` about its box's centre), along the radius. */
function outOfCircle(c, x, z) {
  const cx = (c.x0 + c.x1) / 2; const cz = (c.z0 + c.z1) / 2;
  const dx = x - cx; const dz = z - cz;
  const d = Math.hypot(dx, dz);
  const R = c.r + RADIUS;
  if (d >= R) return [x, z];
  // At the exact centre there is no radius to follow; any way out will do.
  if (d < 1e-6) return [cx + R, cz];
  return [cx + (dx / d) * R, cz + (dz / d) * R];
}

// The camera looks down -Z at yaw 0, so facing along a segment is the atan2
// of the NEGATED offset -- the sign that has shipped wrong twice before.
const yawAlong = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z));

export class Player {
  constructor(camera, domElement, world) {
    this.camera = camera;
    // PointerLockControls works in YXZ; match it so the strafe roll below can
    // touch rotation.z without fighting the look direction.
    camera.rotation.order = 'YXZ';
    this.controls = new PointerLockControls(camera, domElement);
    this.platforms = new SpatialGrid(world.platforms);
    this.colliders = new SpatialGrid(world.colliders);
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.noclip = false;
    this.keys = new Set();
    this.bob = 0;
    this.bobPhase = 0;
    this.onFootstep = null;
    this._scratch = [];
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._fade = 0;
    this._glide = null;
    // A blow landing on you: `trauma` rises with each hit and bleeds off, and
    // the shake goes as its square so a scratch barely moves the view while a
    // mauling rocks it (the usual trauma model).
    this.trauma = 0;
    this._shakeTime = 0;
    this.lookAssist = null;
    this._shakeRoll = 0;
    this.lockRefused = false;

    const down = (event) => {
      if (event.repeat) return;
      this.keys.add(event.code);
    };
    const up = (event) => this.keys.delete(event.code);
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Another zone's floors and walls (main.js crossTo). */
  setWorld(world) {
    this.platforms = new SpatialGrid(world.platforms);
    this.colliders = new SpatialGrid(world.colliders);
  }

  /**
   * Ask for the mouse. Refusal is normal -- a headless browser never grants
   * it, and Chrome refuses for a second after Escape -- and the game plays on
   * without it, keys and all, so it is reported rather than thrown; the next
   * click on the view asks again. `lockRefused` lets a click that could not
   * take the mouse still count as a swing.
   */
  requestLock() {
    const element = this.controls.domElement;
    if (document.pointerLockElement === element) return;
    const onError = () => {
      this.lockRefused = true;
      console.warn('player.js: pointer lock refused -- keys still work; click the view to try again');
    };
    document.addEventListener('pointerlockerror', onError, { once: true });
    document.addEventListener('pointerlockchange', () => {
      document.removeEventListener('pointerlockerror', onError);
      this.lockRefused = false;
    }, { once: true });
    const pending = element.requestPointerLock();
    // Chrome also rejects the promise it returns; the event above has said so.
    if (pending && pending.catch) pending.catch(() => {});
  }

  spawn(x, y, z, yaw = 0) {
    this._glide = null;
    this.position.set(x, y + EYE, z);
    this.velocity.set(0, 0, 0);
    this.camera.position.copy(this.position);
    this.camera.rotation.set(0, yaw, 0);
    this._shakeRoll = 0; // the tilt that was on is gone with the old rotation
    this.camera.updateMatrixWorld(true);
  }

  get gliding() { return !!this._glide; }

  /**
   * Carry the player to a point the way a step would: face the exit first if
   * it is behind you, then walk, bob and footsteps running, and hand control
   * back on arrival. This is what the compass arrows use for an ordinary
   * next-room exit -- the old cut-to-black said you *had moved*; this says
   * you are *moving*, which is the difference between reading a map and
   * being somewhere. Portals, stairs and anything not a straight walk keep
   * the fade: a glide through a wall would say something false.
   */
  /** Push a point out of any closed collider, the same maths update() uses. */
  resolvePoint(x, z, feetY) {
    const items = this.colliders.near(x, z, this._scratch);
    const headY = feetY + HEIGHT;
    for (const c of items) {
      if (c.door && c.door.open) continue;
      if (c.y1 <= feetY + STEP_UP || c.y0 >= headY) continue;
      if (x < c.x0 - RADIUS || x > c.x1 + RADIUS || z < c.z0 - RADIUS || z > c.z1 + RADIUS) continue;
      if (c.r) {
        const [ox, oz] = outOfCircle(c, x, z);
        x = ox; z = oz;
        continue;
      }
      const px = Math.min(x - (c.x0 - RADIUS), (c.x1 + RADIUS) - x);
      const pz = Math.min(z - (c.z0 - RADIUS), (c.z1 + RADIUS) - z);
      if (px < pz) x += (x < (c.x0 + c.x1) / 2 ? -px : px);
      else z += (z < (c.z0 + c.z1) / 2 ? -pz : pz);
    }
    return [x, z];
  }

  glide(x, y, z, yaw, onArrive = null) {
    this.glidePath([new THREE.Vector3(x, y, z)], yaw, onArrive);
  }

  /**
   * Walk a polyline: face the first leg, then follow the legs at one pace,
   * turning smoothly at each corner. This is what a compass step uses when
   * the layout routed the exit round a bend -- the street exists, so the
   * step walks it, instead of cutting to black because the destination is
   * not on the axis the mud named. `finalYaw`, when given, is the facing to
   * settle on over the last leg (a straight step ends exactly on the mud's
   * compass direction); otherwise you end up looking the way you walked.
   */
  glidePath(groundPoints, finalYaw = null, onArrive = null) {
    groundPoints = this.roundObstacles(groundPoints);
    const pts = [this.position.clone()];
    for (const p of groundPoints) pts.push(new THREE.Vector3(p.x, p.y + EYE, p.z));
    // Resolve the destination BEFORE walking to it. Gliding to the raw room
    // centre and letting physics take over afterwards produced a measured
    // 2.13 m sideways pop in a single frame wherever the centre is occupied
    // -- the fountain on the Temple Square, precisely the thing the "never
    // put anything at a room's exact centre" rule exists for.
    const last = pts[pts.length - 1];
    const [tx, tz] = this.resolvePoint(last.x, last.z, last.y - EYE);
    last.x = tx; last.z = tz;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = cum[cum.length - 1];
    const fromYaw = this.camera.rotation.y;
    const firstYaw = yawAlong(pts[0], pts[1]);
    // Shortest arc, so a step behind you turns 180 and not 540.
    let d = firstYaw - fromYaw;
    d = (((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    // Up to half a second for a half turn; the walk itself just over a
    // second for a full 26 m cell-to-cell step, a touch more round a bend.
    const turn = (Math.abs(d) / Math.PI) * 0.5;
    // A single cell in just over a second; the long way round Poor Alley --
    // seven legs, four corners, ~90 m -- caps out near three, which is what
    // one press costing a detour should feel like.
    // Past that, 40 m/s: Wall Road's 250 m in six seconds, travelled rather
    // than flashed past.
    const move = THREE.MathUtils.clamp(total / 24, 0.55, Math.max(2.9, total / 40));
    this.velocity.set(0, 0, 0);
    this._glide = { pts, cum, total, fromYaw, toYaw: fromYaw + d, finalYaw, turn, move, t: 0, onArrive };
  }

  /**
   * The same polyline, bent round whatever stands on it. A glide is a straight
   * lerp with no collision, so a compass step across the Market Square walked
   * straight through the fountain. The mobiles already plan round furniture on
   * the nav grid (nav.js); the step asks it too, allowed only the cells the
   * original line crosses, so it still walks the street the layout routed.
   * Without a nav, or with no way through, the line is kept as it was.
   */
  roundObstacles(groundPoints) {
    const nav = this.nav;
    if (!nav || !groundPoints.length) return groundPoints;
    const feetY = this.position.y - EYE;
    const level = nav.levelOf(feetY);
    if (groundPoints.some((p) => nav.levelOf(p.y) !== level)) return groundPoints;
    const cells = new Map();
    let ax = this.position.x; let az = this.position.z;
    for (const p of groundPoints) {
      const n = Math.max(1, Math.ceil(Math.hypot(p.x - ax, p.z - az) / 2));
      for (let i = 0; i <= n; i++) {
        const x = Math.round((ax + (p.x - ax) * i / n) / nav.CELL);
        const z = Math.round((az + (p.z - az) * i / n) / nav.CELL);
        cells.set(`${x},${z}`, { x, z });
      }
      ax = p.x; az = p.z;
    }
    const goal = groundPoints[groundPoints.length - 1];
    const path = nav.findPath(level, { x: this.position.x, z: this.position.z }, goal, [...cells.values()]);
    if (!path || !path.length) return groundPoints;
    // findPath ends on the nearest open sample; land on the room's own point.
    const end = path[path.length - 1];
    if (Math.hypot(end.x - goal.x, end.z - goal.z) > 0.05) path.push({ x: goal.x, y: goal.y, z: goal.z });
    else path[path.length - 1] = { x: goal.x, y: goal.y, z: goal.z };
    return path;
  }

  updateGlide(dt) {
    const g = this._glide;
    const ease = (u) => u * u * (3 - 2 * u);
    g.t += dt;
    if (g.t < g.turn) {
      // Turning first, walking second: the mud's compass step is "face north,
      // go north", and overlapping the two reads as drifting sideways.
      this.camera.rotation.y = g.fromYaw + (g.toYaw - g.fromYaw) * ease(g.t / g.turn);
      this.camera.position.copy(this.position);
      return;
    }
    if (g.turn > 0 && !g.turned) { g.turned = true; this.camera.rotation.y = g.toYaw; }
    const u = Math.min(1, (g.t - g.turn) / g.move);
    // Walk the polyline by arc length, and steer: each leg pulls the yaw
    // toward its own direction (the last leg toward the mud's, if given), at
    // a rate that takes a right angle in about a quarter second.
    const s = ease(u) * g.total;
    let seg = 1;
    while (seg < g.cum.length - 1 && s > g.cum[seg]) seg++;
    const span = Math.max(1e-6, g.cum[seg] - g.cum[seg - 1]);
    this.position.lerpVectors(g.pts[seg - 1], g.pts[seg], (s - g.cum[seg - 1]) / span);
    const wantYaw = (seg === g.cum.length - 1 && g.finalYaw !== null)
      ? g.finalYaw : yawAlong(g.pts[seg - 1], g.pts[seg]);
    let dy = wantYaw - this.camera.rotation.y;
    dy = (((dy + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const rate = 7 * dt;
    this.camera.rotation.y += THREE.MathUtils.clamp(dy, -rate, rate);
    // The bob and footsteps at a brisk jog cadence -- the sound is half of
    // what makes the step read as moving rather than as a camera move, and a
    // judge measured a walking cadence under a much faster translation as
    // "an implied stride of 20 m per footfall". The cadence follows the pace.
    const previous = this.bobPhase;
    this.bobPhase += dt * 13;
    if (Math.floor(previous / Math.PI) !== Math.floor(this.bobPhase / Math.PI) && this.onFootstep) {
      this.onFootstep(false);
    }
    this.bob += (1 - this.bob) * Math.min(1, dt * 8);
    this.camera.getWorldDirection(this._forward);
    this._forward.y = 0;
    if (this._forward.lengthSq() < 1e-6) this._forward.set(0, 0, -1);
    this._forward.normalize();
    this._right.crossVectors(this._forward, UP).normalize();
    const bobY = Math.sin(this.bobPhase) * 0.055 * this.bob;
    const bobX = Math.cos(this.bobPhase * 0.5) * 0.035 * this.bob;
    this.camera.position.set(
      this.position.x + bobX * this._right.x,
      this.position.y + bobY,
      this.position.z + bobX * this._right.z,
    );
    if (u >= 1) {
      const done = g.onArrive;
      this._glide = null;
      this.velocity.set(0, 0, 0);
      this.camera.position.copy(this.position);
      if (done) done();
    }
  }

  /** Highest walkable surface under (x, z) that we could actually stand on. */
  groundAt(x, z, feetY) {
    const items = this.platforms.near(x, z, this._scratch);
    let best = -Infinity;
    for (const p of items) {
      if (x < p.x0 - RADIUS || x > p.x1 + RADIUS || z < p.z0 - RADIUS || z > p.z1 + RADIUS) continue;
      if (p.top > feetY + STEP_UP) continue;
      if (p.top > best) best = p.top;
    }
    return best;
  }

  /** Knock the view about: 0.2 is a scratch, 1 is a mauling. */
  shake(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt) {
    this.step(dt);
    this.assistPitch(dt);
    this.applyShake(dt);
  }

  /**
   * A foe close and low -- a dog at 1.8 m has its chest 36 degrees under
   * your eye, at the very bottom of a 72-degree frame, under the prompts --
   * draws the view down a little, until it sits a hand's width under the
   * crosshair. It only ever pulls down, only that far, and gently enough
   * that the mouse wins whenever it is moved. `lookAssist` is set by fx.js
   * from the fight, a world point or null.
   */
  assistPitch(dt) {
    const at = this.lookAssist;
    if (!at || this._glide) return;
    const cam = this.camera;
    const d = Math.hypot(at.x - cam.position.x, at.z - cam.position.z);
    if (d > 4.5 || d < 0.3) return;
    const below = Math.atan2(cam.position.y - at.y, d);
    // Anything grown is well inside the frame already.
    if (below < 0.35) return;
    // Where the view would have to point to put the target 11 degrees under
    // the centre; never above level, never further down than 45 degrees.
    const want = THREE.MathUtils.clamp(-(below - 0.19), -0.78, 0);
    if (cam.rotation.x > want + 0.02) cam.rotation.x += (want - cam.rotation.x) * Math.min(1, dt * 2.2);
  }

  /**
   * Applied on top of wherever `step` put the camera this frame. The roll is
   * taken back off before the next one is put on, because a glide never
   * resets rotation.z and would otherwise keep every frame's tilt.
   */
  applyShake(dt) {
    this.camera.rotation.z -= this._shakeRoll;
    this._shakeRoll = 0;
    if (this.trauma <= 0) return;
    this._shakeTime += dt;
    const k = this.trauma * this.trauma;
    const t = this._shakeTime;
    // Summed incommensurate sines: smooth, never repeating within a shake.
    const n = (a, b, c) => Math.sin(t * a) * 0.55 + Math.sin(t * b + 1.3) * 0.3 + Math.sin(t * c + 2.1) * 0.15;
    this._right.set(Math.cos(this.camera.rotation.y), 0, -Math.sin(this.camera.rotation.y));
    const side = n(41, 67, 97) * 0.035 * k;
    this.camera.position.x += this._right.x * side;
    this.camera.position.z += this._right.z * side;
    this.camera.position.y += n(53, 79, 113) * 0.03 * k;
    this._shakeRoll = n(37, 59, 89) * 0.028 * k;
    this.camera.rotation.z += this._shakeRoll;
    this.trauma = Math.max(0, this.trauma - dt * 1.9);
  }

  step(dt) {
    if (this._glide) { this.updateGlide(dt); return; }
    const object = this.camera;
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = sprint ? SPRINT : WALK;

    // WASD only. The arrows used to be aliases for these, and they are now the
    // mud's compass navigation in main.js -- so leaving them here meant one
    // press both stepped you into the next room *and* shoved you walking, which
    // is a change in velocity you never asked for.
    let inputX = 0; let inputZ = 0;
    if (this.keys.has('KeyW')) inputZ += 1;
    if (this.keys.has('KeyS')) inputZ -= 1;
    if (this.keys.has('KeyD')) inputX += 1;
    if (this.keys.has('KeyA')) inputX -= 1;
    const length = Math.hypot(inputX, inputZ) || 1;
    inputX /= length; inputZ /= length;

    this.camera.getWorldDirection(this._forward);
    this._forward.y = 0;
    if (this._forward.lengthSq() < 1e-6) this._forward.set(0, 0, -1);
    this._forward.normalize();
    this._right.crossVectors(this._forward, UP).normalize();

    const wishX = this._forward.x * inputZ + this._right.x * inputX;
    const wishZ = this._forward.z * inputZ + this._right.z * inputX;

    if (this.noclip) {
      const vertical = (this.keys.has('Space') ? 1 : 0) - (this.keys.has('ControlLeft') ? 1 : 0);
      this.position.x += wishX * speed * 2 * dt;
      this.position.z += wishZ * speed * 2 * dt;
      this.position.y += vertical * speed * 2 * dt;
      object.position.copy(this.position);
      return;
    }

    const feetY = this.position.y - EYE;

    // horizontal move, then push out of anything we ended up inside
    const stepX = wishX * speed * dt;
    const stepZ = wishZ * speed * dt;
    this.position.x += stepX;
    this.position.z += stepZ;
    this.skirt(stepX, stepZ, feetY);
    this.resolveCollisions(feetY);

    // vertical
    const ground = this.groundAt(this.position.x, this.position.z, feetY);
    const targetFeet = ground === -Infinity ? feetY : ground;
    // Rising is never "standing": a jump leaves the ground only on the next
    // frame, and judged by height alone that frame still reads as grounded --
    // which zeroed the velocity and kept every jump at 0 cm.
    if (this.velocity.y <= 0 && (feetY - targetFeet < 0.02 || (targetFeet > feetY && targetFeet - feetY < STEP_UP))) {
      // standing on, or stepping up onto, a surface
      this.onGround = true;
      this.velocity.y = 0;
      const smooth = targetFeet > feetY ? Math.min(1, dt * 18) : 1;
      this.position.y += (targetFeet + EYE - this.position.y) * smooth;
      if (this.keys.has('Space')) { this.velocity.y = 7.4; this.onGround = false; }
    } else {
      this.onGround = false;
      this.velocity.y -= GRAVITY * dt;
      this.position.y += this.velocity.y * dt;
      if (this.position.y - EYE < targetFeet) {
        this.position.y = targetFeet + EYE;
        this.velocity.y = 0;
        this.onGround = true;
      }
    }

    // head bob and a touch of roll when strafing
    const moving = (inputX || inputZ) && this.onGround;
    if (moving) {
      const previous = this.bobPhase;
      this.bobPhase += dt * (sprint ? 13 : 9);
      if (Math.floor(previous / Math.PI) !== Math.floor(this.bobPhase / Math.PI) && this.onFootstep) {
        this.onFootstep(sprint);
      }
      this.bob += (1 - this.bob) * Math.min(1, dt * 8);
    } else {
      this.bob += (0 - this.bob) * Math.min(1, dt * 6);
    }
    const bobY = Math.sin(this.bobPhase) * 0.055 * this.bob;
    const bobX = Math.cos(this.bobPhase * 0.5) * 0.035 * this.bob;

    object.position.set(this.position.x + bobX * this._right.x, this.position.y + bobY, this.position.z + bobX * this._right.z);
    this.camera.rotation.z = -inputX * 0.022 * this.bob;
  }

  /**
   * Walking into something round turns the part of the step that goes into
   * it into a step round it. Pushing out along the radius alone slides you
   * off at an angle, but straight at the centre the push is exactly
   * backwards: held W down the temple's axis stopped dead against the
   * fountain for as long as it was held. Only within 45 degrees of head-on,
   * so brushing past still feels like brushing past.
   */
  skirt(stepX, stepZ, feetY) {
    const items = this.colliders.near(this.position.x, this.position.z, this._scratch);
    const headY = feetY + HEIGHT;
    for (const c of items) {
      if (!c.r || c.y1 <= feetY + STEP_UP || c.y0 >= headY) continue;
      const cx = (c.x0 + c.x1) / 2; const cz = (c.z0 + c.z1) / 2;
      const dx = this.position.x - cx; const dz = this.position.z - cz;
      const d = Math.hypot(dx, dz);
      if (d >= c.r + RADIUS || d < 1e-6) continue;
      const nx = dx / d; const nz = dz / d;
      const into = -(stepX * nx + stepZ * nz);
      const along = stepX * -nz + stepZ * nx;
      if (into <= 0 || Math.abs(along) >= into) continue;
      // Dead centre has no side to prefer; take the right-hand one.
      const side = along < -1e-6 ? -1 : 1;
      this.position.x += -nz * side * (into - Math.abs(along));
      this.position.z += nx * side * (into - Math.abs(along));
    }
  }

  resolveCollisions(feetY) {
    const items = this.colliders.near(this.position.x, this.position.z, this._scratch);
    const headY = feetY + HEIGHT;
    for (const c of items) {
      if (c.door && c.door.open) continue;
      if (c.y1 <= feetY + STEP_UP || c.y0 >= headY) continue;
      const x = this.position.x; const z = this.position.z;
      if (x < c.x0 - RADIUS || x > c.x1 + RADIUS || z < c.z0 - RADIUS || z > c.z1 + RADIUS) continue;
      if (c.r) {
        const [ox, oz] = outOfCircle(c, x, z);
        this.position.x = ox; this.position.z = oz;
        continue;
      }
      const px = Math.min(x - (c.x0 - RADIUS), (c.x1 + RADIUS) - x);
      const pz = Math.min(z - (c.z0 - RADIUS), (c.z1 + RADIUS) - z);
      if (px < pz) this.position.x += (x < (c.x0 + c.x1) / 2 ? -px : px);
      else this.position.z += (z < (c.z0 + c.z1) / 2 ? -pz : pz);
    }
  }
}
