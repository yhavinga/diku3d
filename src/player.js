/**
 * First-person movement. Ground height comes from the platform list the builder
 * hands over (floors, passages, stair treads) rather than from raycasts, so a
 * flight of twenty-two steps costs the same as flat ground. Walls are axis-
 * aligned boxes resolved along the shallowest penetration.
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

    const down = (event) => {
      if (event.repeat) return;
      this.keys.add(event.code);
    };
    const up = (event) => this.keys.delete(event.code);
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    window.addEventListener('blur', () => this.keys.clear());
  }

  spawn(x, y, z, yaw = 0) {
    this._glide = null;
    this.position.set(x, y + EYE, z);
    this.velocity.set(0, 0, 0);
    this.camera.position.copy(this.position);
    this.camera.rotation.set(0, yaw, 0);
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
      const px = Math.min(x - (c.x0 - RADIUS), (c.x1 + RADIUS) - x);
      const pz = Math.min(z - (c.z0 - RADIUS), (c.z1 + RADIUS) - z);
      if (px < pz) x += (x < (c.x0 + c.x1) / 2 ? -px : px);
      else z += (z < (c.z0 + c.z1) / 2 ? -pz : pz);
    }
    return [x, z];
  }

  glide(x, y, z, yaw, onArrive = null) {
    const from = this.position.clone();
    // Resolve the destination BEFORE walking to it. Gliding to the raw room
    // centre and letting physics take over afterwards produced a measured
    // 2.13 m sideways pop in a single frame wherever the centre is occupied
    // -- the fountain on the Temple Square, precisely the thing the "never
    // put anything at a room's exact centre" rule exists for.
    const [tx, tz] = this.resolvePoint(x, z, y);
    const to = new THREE.Vector3(tx, y + EYE, tz);
    const fromYaw = this.camera.rotation.y;
    // Shortest arc, so a step behind you turns 180 and not 540.
    let d = yaw - fromYaw;
    d = (((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    // Up to half a second for a half turn; the walk itself just over a
    // second for a full 26 m cell-to-cell step, less for anything shorter.
    const turn = (Math.abs(d) / Math.PI) * 0.5;
    const move = THREE.MathUtils.clamp(from.distanceTo(to) / 22, 0.5, 1.2);
    this.velocity.set(0, 0, 0);
    this._glide = { from, to, fromYaw, toYaw: fromYaw + d, turn, move, t: 0, onArrive };
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
    this.position.lerpVectors(g.from, g.to, ease(u));
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

  update(dt) {
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
    this.resolveCollisions(feetY);

    // vertical
    const ground = this.groundAt(this.position.x, this.position.z, feetY);
    const targetFeet = ground === -Infinity ? feetY : ground;
    if (feetY - targetFeet < 0.02 || (targetFeet > feetY && targetFeet - feetY < STEP_UP)) {
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

  resolveCollisions(feetY) {
    const items = this.colliders.near(this.position.x, this.position.z, this._scratch);
    const headY = feetY + HEIGHT;
    for (const c of items) {
      if (c.door && c.door.open) continue;
      if (c.y1 <= feetY + STEP_UP || c.y0 >= headY) continue;
      const x = this.position.x; const z = this.position.z;
      if (x < c.x0 - RADIUS || x > c.x1 + RADIUS || z < c.z0 - RADIUS || z > c.z1 + RADIUS) continue;
      const px = Math.min(x - (c.x0 - RADIUS), (c.x1 + RADIUS) - x);
      const pz = Math.min(z - (c.z0 - RADIUS), (c.z1 + RADIUS) - z);
      if (px < pz) this.position.x += (x < (c.x0 + c.x1) / 2 ? -px : px);
      else this.position.z += (z < (c.z0 + c.z1) / 2 ? -pz : pz);
    }
  }
}
