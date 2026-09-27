/**
 * How the people in the world move: where they walk, how their feet meet the
 * ground, and what their bodies do in a fight.
 *
 * They used to orbit their spawn point on a fixed ellipse, 0.35-0.85 m across,
 * with the walk clip blended in by measured speed -- which is exactly what "they
 * float in little circles" describes. Now each one has somewhere to be:
 *
 *   - `game.js` decides *what* a mobile is doing, as an order on its figure:
 *     stroll about this room, walk this route to the next one, close on that
 *     opponent, go home, lie dead. It is Merc's `mobile_update` that sends
 *     them from room to room.
 *   - this file decides *how*: a path over the walkable grid (nav.js), a pace
 *     of its own, turning on the spot before setting off, easing in and out,
 *     stepping round each other and round you, and a walk clip turned over at
 *     exactly the rate the ground goes by -- the rig's own stride, measured.
 *
 * The body only ever moves the way it faces. Velocity is speed along the
 * heading, never a vector of its own, so nothing can drift sideways or walk
 * backwards; a sharp change of direction is a turn in place first.
 *
 * Figures follow the contract every rig here is built to:
 *   { group, height, scale, mixer, actions, clips, stride, hitFrame, legs, ... }
 * and use whatever clips a figure actually has. A figure with no `death` falls
 * procedurally, one with no `attack` lunges, and the boxed beasts (`legs`)
 * swing their legs off the same measured speed.
 */

import * as THREE from 'three';

const TAU = Math.PI * 2;
const wrap = (a) => {
  a = (a + Math.PI) % TAU;
  return (a < 0 ? a + TAU : a) - Math.PI;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (u) => u * u * (3 - 2 * u);

/** A person's walking pace: 1.2-1.5 m/s is how people cross a town (Bohannon 1997). */
const WALK = 1.28;
const ACCEL = 1.7;
const DECEL = 2.4;
/** A turn larger than this (radians) is made standing, before setting off. */
const TURN_FIRST = 0.95;
const TURN_STANDING = 3.0;
const TURN_WALKING = 2.6;
/** Personal space: people keep this much between their centres. */
const SPACE = 0.72;
const LOOK_AHEAD = 1.8;
/** Clearance from the player's eye column. */
const YOU = 0.9;
/** How close an opponent closes for melee, centre to centre. */
export const CLOSE = 1.55;

const LOOP = ['idle', 'idle2', 'walk', 'run', 'fight'];
const ONE_SHOT = new Set(['attack', 'attack2', 'hit', 'block', 'death']);

/** A per-person generator, so one figure's choices do not depend on another's. */
function mulberry(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -- rigs ---------------------------------------------------------------------

const strideCache = new Map();

/**
 * Metres of ground one cycle of a clip covers, measured off the rig itself.
 *
 * The planted foot is the one thing in a walk that does not move over the
 * ground, so in the body's own frame it slides backwards at exactly the speed
 * the body should be travelling. Sample the clip, find the frames where each
 * foot is within 3.5 cm of its lowest and moving back, and take the median
 * speed: that is the speed that minimises slip at timeScale 1, and times the clip's
 * length it is the stride. Cached per clip, in the rig's unscaled units.
 */
function measureStride(figure, name) {
  const action = figure.actions[name];
  if (!action) return null;
  const clip = action.getClip();
  const scale = figure.scale || 1;
  if (strideCache.has(clip)) {
    const cached = strideCache.get(clip);
    return cached === null ? null : cached * scale;
  }
  const feet = [];
  figure.object.traverse((n) => { if (n.isBone && /foot|ankle/i.test(n.name) && !/toe/i.test(n.name)) feet.push(n); });
  if (!feet.length) { strideCache.set(clip, null); return null; }

  const saved = Object.entries(figure.actions).map(([k, a]) => [a, a.getEffectiveWeight(), a.time, a.timeScale, a.enabled]);
  for (const [a] of saved) a.setEffectiveWeight(0);
  action.enabled = true;
  action.setEffectiveWeight(1);
  if (!action.isRunning()) action.play();
  const root = figure.object;
  const p = new THREE.Vector3();
  const N = 72;
  const tracks = feet.map(() => []);
  for (let i = 0; i <= N; i++) {
    action.time = (i / N) * clip.duration;
    figure.mixer.update(0);
    root.updateMatrixWorld(true);
    feet.forEach((foot, k) => {
      foot.getWorldPosition(p);
      root.worldToLocal(p);
      tracks[k].push({ y: p.y, z: p.z });
    });
  }
  const dt = clip.duration / N;
  const speeds = [];
  for (const track of tracks) {
    let low = Infinity;
    for (const s of track) low = Math.min(low, s.y);
    for (let i = 1; i < track.length; i++) {
      // Low *and* going back: a swinging foot passes low on its way forward
      // too, and counting that frame against the stance measured a stride of
      // 0.16 m.
      const back = track[i - 1].z - track[i].z;
      if (back <= 0 || track[i].y > low + 0.035 * scale || track[i - 1].y > low + 0.035 * scale) continue;
      speeds.push(back / dt);
    }
  }
  for (const [a, w, t, ts, en] of saved) { a.setEffectiveWeight(w); a.time = t; a.timeScale = ts; a.enabled = en; }
  figure.mixer.update(0);
  // The median, not the mean: it is the speed that minimises the summed slip
  // (L1), and it is not dragged up by the heel-off frames where the ankle
  // whips back as the foot rolls onto its toe. Against the measured slip of
  // the planted foot in the running town the mean came out 25-35% fast.
  speeds.sort((x, y) => x - y);
  const speed = speeds.length ? speeds[Math.floor(speeds.length / 2)] : 0;
  const stride = speed > 0.05 ? (speed * clip.duration) / scale : null;
  strideCache.set(clip, stride);
  return stride === null ? null : stride * scale;
}

/**
 * Normalise a figure's clips to one arrangement: the loops running from the
 * start at zero weight (idle at one), the one-shots armed only when used.
 *
 * Today's townsperson carries a single combat clip, `fight` -- a guard with an
 * overhand cut on frames 13-19 of 41. Until the new rigs land with a proper
 * `attack`, that clip is split in two here: a copy plays once as the attack
 * (contact at 16/41), and the original is held on its first frame as the guard.
 */
function prepareRig(figure) {
  const actions = {};
  if (figure.actions) {
    for (const [name, a] of Object.entries(figure.actions)) {
      if (a instanceof THREE.AnimationAction) actions[name] = a;
    }
  }
  figure.actions = actions;
  if (!figure.mixer) return;
  const hitFrame = { ...(figure.hitFrame || {}) };
  if (!actions.attack && actions.fight) {
    const clip = actions.fight.getClip().clone();
    clip.name = 'attack';
    actions.attack = figure.mixer.clipAction(clip);
    hitFrame.attack = hitFrame.attack ?? 16 / 40;
    figure.frozenGuard = true;
  }
  figure.hitFrame = hitFrame;
  const clips = {};
  for (const [name, a] of Object.entries(actions)) {
    clips[name] = a.getClip().duration;
    a.enabled = true;
    if (ONE_SHOT.has(name)) {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.stop();
      a.setEffectiveWeight(0);
    } else {
      a.setLoop(THREE.LoopRepeat, Infinity);
      if (!a.isRunning()) a.play();
      a.setEffectiveWeight(name === 'idle' ? 1 : 0);
    }
  }
  if (figure.frozenGuard) { actions.fight.timeScale = 0; actions.fight.time = 0.02; }
  figure.clips = clips;
  const stride = { ...(figure.stride || {}) };
  if (!stride.walk && actions.walk) stride.walk = measureStride(figure, 'walk');
  if (!stride.run && actions.run) stride.run = measureStride(figure, 'run');
  figure.stride = stride;
  figure.mixer.update(0);
}

// -- the controller -------------------------------------------------------------

/**
 * @param {object} deps
 *   figures  -- actors.js's figure records
 *   nav      -- nav.js
 *   onCull   -- called with a figure when it leaves or enters range
 */
export function createMotion({ figures, nav }) {
  for (const fig of figures) {
    prepareRig(fig);
    const seed = fig.seed || 1;
    fig.rand = mulberry(seed);
    // The pace the rig was made to walk at -- its stride over its cycle, so
    // the clip plays near its own speed -- and then per person somewhere
    // between an amble and a purposeful stride. A human rig comes out near
    // WALK anyway; a duck's 0.17 m stride at a human 1.28 m/s would have
    // needed its cycle at 7x.
    const natural = (name, fallback) => (fig.stride && fig.stride[name] && fig.clips && fig.clips[name]
      ? fig.stride[name] / fig.clips[name] : fallback);
    const walkNatural = natural('walk', WALK);
    fig.pace = walkNatural * (0.86 + fig.rand() * 0.3);
    fig.runPace = natural('run', Math.max(walkNatural * 2.4, fig.pace * 1.6));
    // Above this a figure is running rather than walking: halfway between the
    // brisk end of its walk and its run.
    fig.runFrom = (fig.pace * 1.25 + fig.runPace) / 2;
    fig.at = { x: fig.object.position.x, y: fig.object.position.y, z: fig.object.position.z };
    fig.level = nav.levelOf(fig.at.y);
    // The reset ring puts people 2-3.6 m from the centre whatever is standing
    // there; a table or a bench is no place to start. Onto the nearest open
    // ground, measured: 10 of Midgaard's 71 began on a blocked sample.
    if (!nav.sample(fig.at.x, fig.at.z, fig.level)) {
      const open = nav.nearestOpen(fig.level, fig.at.x, fig.at.z, 3);
      if (open) {
        fig.at.x = (open[0] + 0.5) * nav.NAV_RES;
        fig.at.z = (open[1] + 0.5) * nav.NAV_RES;
        fig.object.position.set(fig.at.x, fig.at.y, fig.at.z);
        if (fig.homeSpot) { fig.homeSpot.x = fig.at.x; fig.homeSpot.z = fig.at.z; }
        if (fig.interactable) fig.interactable.position.set(fig.at.x, fig.at.y + fig.height * 0.6, fig.at.z);
      }
    }
    fig.m = {
      path: null, pi: 0, speed: 0, wait: 0.5 + fig.rand() * 4, turnTo: null,
      idle: 'idle', stuck: 0, repath: 0, goal: null,
      fade: 1, fading: 0, offset: { x: 0, z: 0 }, lunge: null, recoil: null, sway: null,
      overlay: null, dead: null, gone: null, order: null, fighting: false,
    };
    fig.walking = false;
  }

  const _grid = new Map();
  const near = [];

  function neighbours(fig, out) {
    out.length = 0;
    const kx = Math.floor(fig.at.x / 3); const kz = Math.floor(fig.at.z / 3);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = _grid.get(`${kx + dx},${kz + dz}`);
        if (list) for (const other of list) if (other !== fig) out.push(other);
      }
    }
    return out;
  }

  // -- fading, for archways and for the dead ---------------------------------

  /**
   * Opacity on every material the figure wears. The skinned townsperson's are
   * its own clones already; the boxed beasts share one, so they get their own
   * the first time they fade.
   */
  function setOpacity(fig, alpha) {
    if (fig.m.fade === alpha) return;
    fig.m.fade = alpha;
    fig.object.traverse((node) => {
      if (!node.isMesh || node.isSprite) return;
      if (!node.userData.ownMaterial) {
        node.material = node.material.clone();
        node.userData.ownMaterial = true;
      }
      const m = node.material;
      m.transparent = alpha < 0.999;
      m.opacity = alpha;
      m.depthWrite = alpha >= 0.999;
    });
  }

  // -- orders ----------------------------------------------------------------

  const orderOf = (fig) => fig.order || { kind: 'stroll', room: fig.room };

  function planStroll(fig, order) {
    const m = fig.m;
    const leash = order.radius ?? (fig.sentinel ? 2.8 : Infinity);
    const around = order.home || fig.homeSpot;
    const others = near;
    neighbours(fig, others);
    const spot = nav.randomSpot(order.room, fig.rand, {
      allowWater: !!fig.swims,
      near: leash < Infinity ? around : null,
      radius: leash,
      // Not onto someone else's spot, and not onto anyone standing still.
      avoid: (x, z) => others.some((o) => {
        const g = o.m.goal || o.at;
        return (g.x - x) ** 2 + (g.z - z) ** 2 < 1.4 * 1.4;
      }),
    });
    if (!spot) { m.wait = 1.5 + fig.rand() * 2; return; }
    const path = nav.pathInRoom(order.room, fig.at, spot);
    if (!path || !path.length) { m.wait = 1 + fig.rand() * 2; return; }
    m.path = path; m.pi = 0; m.goal = spot; m.stuck = 0;
  }

  function arrive(fig) {
    const m = fig.m;
    m.path = null;
    m.goal = { x: fig.at.x, z: fig.at.z };
    // A while standing about, not a metronome: mostly a few seconds, now and
    // then a long stop -- someone looking in a window, waiting for a friend.
    const long = fig.rand() < 0.22;
    m.wait = long ? 8 + fig.rand() * 12 : 2.2 + fig.rand() * 5.5;
    m.idle = fig.actions && fig.actions.idle2 && fig.rand() < 0.4 ? 'idle2' : 'idle';
    m.turnTo = lookTarget(fig);
  }

  /** Something to turn and look at on stopping: whoever is nearest, or the view. */
  function lookTarget(fig) {
    neighbours(fig, near);
    let best = null; let bestD = 5.5 * 5.5;
    for (const o of near) {
      if (o.m.dead) continue;
      const d = (o.at.x - fig.at.x) ** 2 + (o.at.z - fig.at.z) ** 2;
      if (d < bestD && d > 0.5) { bestD = d; best = o.at; }
    }
    if (best && fig.rand() < 0.7) return Math.atan2(best.x - fig.at.x, best.z - fig.at.z);
    if (fig.rand() < 0.45) return fig.object.rotation.y + (fig.rand() - 0.5) * 2.4;
    return null;
  }

  function setPathTo(fig, level, target, cells) {
    const path = nav.findPath(level, fig.at, target, cells);
    fig.m.path = path && path.length ? path : null;
    fig.m.pi = 0;
    fig.m.stuck = 0;
  }

  /** The cells a chase may use: the ground of both rooms involved. */
  function chaseCells(fig, target) {
    const out = [];
    const seen = new Set();
    for (const vnum of [nav.roomAt(fig.at.x, fig.at.y, fig.at.z), nav.roomAt(target.x, fig.at.y, target.z)]) {
      const t = vnum !== undefined ? nav.territory(vnum) : null;
      if (!t) continue;
      for (const c of t.cells) {
        const k = `${c.x},${c.z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ x: c.x, z: c.z });
      }
      // ...and the far half of each passage, since a fight in a doorway spans it.
      const sides = t.cells.filter((c) => !c.own);
      for (const c of sides) {
        const k = `${c.other.x},${c.other.z}`;
        if (!seen.has(k)) { seen.add(k); out.push({ x: c.other.x, z: c.other.z }); }
      }
    }
    return out;
  }

  /**
   * Turn an order into a path and a pace. Called every frame; only does work
   * when there is a decision to make.
   */
  function think(fig, dt, player) {
    const m = fig.m;
    const order = orderOf(fig);
    if (order !== m.order) {
      m.order = order;
      m.path = null;
      m.turnTo = null;
      if (order.kind === 'travel') {
        // A flight waits for the blow that caused it to be seen landing.
        m.stage = order.wait > 0 ? 'wait' : 'walk';
        if (m.stage === 'walk') { m.path = order.route.points.slice(); m.pi = 0; }
      }
    }
    m.fighting = false;
    m.want = fig.pace;
    switch (order.kind) {
      case 'dead': case 'gone':
        m.path = null;
        m.want = 0;
        return;
      case 'travel': {
        m.want = order.run ? fig.runPace : fig.pace * 1.04;
        if (m.stage === 'wait') {
          order.wait -= dt;
          m.want = 0;
          if (order.wait <= 0) { m.stage = 'walk'; m.path = order.route.points.slice(); m.pi = 0; }
          return;
        }
        if (m.stage === 'walk' && !m.path) {
          if (order.route.portal) { m.stage = 'out'; m.fading = -1; } else { order.done = true; }
        }
        return;
      }
      case 'chase': case 'face': {
        const target = order.target;
        const dx = target.x - fig.at.x; const dz = target.z - fig.at.z;
        const d = Math.hypot(dx, dz);
        m.fighting = d < 4.5;
        m.faceYaw = Math.atan2(dx, dz);
        if (order.kind === 'face' || d <= (order.stop ?? CLOSE) + 0.15) { m.path = null; m.want = 0; return; }
        m.want = d > 4 ? fig.runPace : fig.pace * 1.25;
        m.repath -= dt;
        if (m.repath <= 0 || !m.path) {
          m.repath = 0.35;
          // Stop short of them, on the near side.
          const stop = order.stop ?? CLOSE;
          const goal = { x: target.x - (dx / d) * stop, z: target.z - (dz / d) * stop };
          if (nav.clearLine(fig.level, fig.at.x, fig.at.z, goal.x, goal.z)) {
            m.path = [{ x: goal.x, y: fig.at.y, z: goal.z }]; m.pi = 0;
          } else {
            setPathTo(fig, fig.level, goal, chaseCells(fig, target));
          }
        }
        return;
      }
      case 'go': {
        m.want = order.run ? fig.runPace : fig.pace * 1.1;
        const d = Math.hypot(order.to.x - fig.at.x, order.to.z - fig.at.z);
        if (d < 0.5) { m.path = null; m.want = 0; order.done = true; return; }
        if (!m.path) {
          m.repath -= dt;
          if (m.repath <= 0) {
            m.repath = 1;
            setPathTo(fig, fig.level, order.to, chaseCells(fig, order.to));
          }
        }
        return;
      }
      case 'hold': {
        // A shopkeeper minds the counter: back to it if pushed off, and turned
        // to face whoever walks up to it.
        const d = Math.hypot(order.at.x - fig.at.x, order.at.z - fig.at.z);
        if (d > 0.7 && !m.path) setPathTo(fig, fig.level, order.at, chaseCells(fig, order.at));
        if (!m.path && player) {
          const pd = Math.hypot(player.x - fig.at.x, player.z - fig.at.z);
          if (pd < 7) m.turnTo = Math.atan2(player.x - fig.at.x, player.z - fig.at.z);
          else if (order.yaw !== undefined) m.turnTo = order.yaw;
        }
        return;
      }
      default: {
        // stroll
        if (m.path) return;
        m.wait -= dt;
        // Someone aggressive keeps an eye on you while standing about.
        if (fig.aggressive && player) {
          const pd = Math.hypot(player.x - fig.at.x, player.z - fig.at.z);
          if (pd < 9) { m.turnTo = Math.atan2(player.x - fig.at.x, player.z - fig.at.z); return; }
        }
        if (m.wait <= 0) planStroll(fig, order);
      }
    }
  }

  // -- steering ----------------------------------------------------------------

  /**
   * One frame of walking the current path: turn toward the next point (in
   * place if it is far round), ease the speed toward the pace and down again
   * before the end, step round anyone in the way, and only then move -- along
   * the heading, never sideways -- onto ground the grid says is open.
   */
  function steer(fig, dt, player) {
    const m = fig.m;
    let yaw = fig.object.rotation.y;
    let wantYaw = null;
    let remaining = 0;

    if (m.path) {
      let target = m.path[m.pi];
      let d = Math.hypot(target.x - fig.at.x, target.z - fig.at.z);
      const lastIndex = m.path.length - 1;
      // Corners are taken on the way past, not touched.
      while (m.pi < lastIndex && d < 0.65) {
        m.pi++;
        target = m.path[m.pi];
        d = Math.hypot(target.x - fig.at.x, target.z - fig.at.z);
      }
      remaining = d;
      for (let i = m.pi; i < lastIndex; i++) {
        remaining += Math.hypot(m.path[i + 1].x - m.path[i].x, m.path[i + 1].z - m.path[i].z);
      }
      if (m.pi === lastIndex && d < 0.22 + m.speed * 0.12) {
        m.path = null;
        if (orderOf(fig).kind === 'stroll') arrive(fig);
      } else {
        wantYaw = Math.atan2(target.x - fig.at.x, target.z - fig.at.z);
      }
    }

    if (wantYaw === null) {
      // Standing: ease to a stop, and turn toward whatever there is to face.
      m.speed = Math.max(0, m.speed - DECEL * dt);
      const face = m.fighting && m.faceYaw !== undefined ? m.faceYaw : m.turnTo;
      if (face !== null && face !== undefined) {
        const err = wrap(face - yaw);
        const step = clamp(err, -TURN_STANDING * dt * (m.fighting ? 1.4 : 0.7), TURN_STANDING * dt * (m.fighting ? 1.4 : 0.7));
        yaw += step;
        m.turning = Math.abs(err) > 0.05 ? Math.sign(err) : 0;
        if (Math.abs(err) < 0.02 && !m.fighting) m.turnTo = null;
      } else m.turning = 0;
      fig.object.rotation.y = yaw;
      if (m.speed > 0) moveAlong(fig, yaw, dt, player);
      return;
    }

    // Stepping round people: anyone close ahead bends the wish to the side
    // they are not on, and slows us; the player counts, with more room.
    neighbours(fig, near);
    let bend = 0;
    let brake = 1;
    const fx = Math.sin(yaw); const fz = Math.cos(yaw);
    const consider = (ox, oz, space, yielding) => {
      const rx = ox - fig.at.x; const rz = oz - fig.at.z;
      const dist = Math.hypot(rx, rz);
      if (dist > LOOK_AHEAD + space || dist < 1e-3) return;
      const ahead = (rx * fx + rz * fz) / dist;
      if (ahead < 0.25) return;
      const side = rx * fz - rz * fx; // >0: they are to our left... of +z-forward frame
      const urgency = clamp((LOOK_AHEAD + space - dist) / LOOK_AHEAD, 0, 1) * ahead;
      bend += (side > 0 ? -1 : 1) * urgency * 0.9;
      if (dist < space + 0.35) brake = Math.min(brake, yielding ? 0 : 0.35);
    };
    for (const o of near) {
      if (o.m.dead || o.m.fade < 0.5) continue;
      consider(o.at.x, o.at.z, SPACE, false);
    }
    if (player) consider(player.x, player.z, YOU, true);
    // Don't swerve past the point itself when nearly there.
    if (remaining < 1.2) bend *= remaining / 1.2;
    wantYaw += clamp(bend, -1.1, 1.1);

    const err = wrap(wantYaw - yaw);
    if (Math.abs(err) > TURN_FIRST && m.speed < 0.3) {
      // Turn first, then walk: setting off while still swinging round reads
      // as sliding, which is the fault this whole file exists to remove.
      m.speed = Math.max(0, m.speed - DECEL * dt);
      const step = clamp(err, -TURN_STANDING * dt, TURN_STANDING * dt);
      fig.object.rotation.y = yaw + step;
      m.turning = Math.sign(err);
      return;
    }
    m.turning = 0;
    const rate = TURN_WALKING * (m.speed > fig.runFrom ? 0.75 : 1);
    yaw += clamp(err, -rate * dt, rate * dt);
    fig.object.rotation.y = yaw;

    // Slow for a sharp bend, and slow in time to stop at the end.
    const bendFactor = clamp(Math.cos(err), 0.15, 1);
    const stopping = Math.sqrt(2 * DECEL * Math.max(0, remaining - 0.1));
    const target = Math.min(m.want * bendFactor * brake, stopping);
    if (m.speed < target) m.speed = Math.min(target, m.speed + ACCEL * (m.want > fig.runFrom ? 1.8 : 1) * dt);
    else m.speed = Math.max(target, m.speed - DECEL * 1.4 * dt);
    moveAlong(fig, yaw, dt, player);
  }

  function moveAlong(fig, yaw, dt, player) {
    const m = fig.m;
    const step = m.speed * dt;
    if (step <= 0) return;
    const nx = fig.at.x + Math.sin(yaw) * step;
    const nz = fig.at.z + Math.cos(yaw) * step;
    if (nav.sample(nx, nz, fig.level)) {
      fig.at.x = nx; fig.at.z = nz; m.stuck = Math.max(0, m.stuck - dt);
    } else if (nav.sample(nx, fig.at.z, fig.level)) {
      fig.at.x = nx; m.speed *= 0.7; m.stuck += dt * 0.5;
    } else if (nav.sample(fig.at.x, nz, fig.level)) {
      fig.at.z = nz; m.speed *= 0.7; m.stuck += dt * 0.5;
    } else {
      m.speed = 0; m.stuck += dt;
    }
    if (m.stuck > 1.2) {
      // Boxed in (a crowd, a player in a doorway): give up on this walk.
      m.stuck = 0;
      m.path = null;
      const order = orderOf(fig);
      if (order.kind === 'stroll') arrive(fig);
      else if (order.kind === 'travel') order.failed = true;
    }
    void player;
  }

  /** People who overlap anyway (the player walking into one) are eased apart. */
  function separate(fig, player) {
    neighbours(fig, near);
    for (const o of near) {
      if (o.m.dead || o.m.gone) continue;
      const dx = fig.at.x - o.at.x; const dz = fig.at.z - o.at.z;
      const d = Math.hypot(dx, dz);
      if (d >= 0.55 || d < 1e-4) continue;
      const push = (0.55 - d) * 0.25;
      const px = fig.at.x + (dx / d) * push; const pz = fig.at.z + (dz / d) * push;
      if (nav.sample(px, pz, fig.level)) { fig.at.x = px; fig.at.z = pz; }
    }
    if (player) {
      const dx = fig.at.x - player.x; const dz = fig.at.z - player.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.7 && d > 1e-4) {
        const push = (0.7 - d) * 0.4;
        const px = fig.at.x + (dx / d) * push; const pz = fig.at.z + (dz / d) * push;
        if (nav.sample(px, pz, fig.level)) { fig.at.x = px; fig.at.z = pz; }
      }
    }
  }

  // -- travelling through archways and stairs ---------------------------------

  function portalStep(fig, dt) {
    const m = fig.m;
    const order = orderOf(fig);
    if (order.kind !== 'travel' || !order.route.portal) return;
    if (m.stage === 'out') {
      setOpacity(fig, Math.max(0, m.fade - dt / 0.5));
      if (m.fade <= 0) {
        const p = order.route.portal;
        fig.at.x = p.arrive.x; fig.at.y = p.arrive.y; fig.at.z = p.arrive.z;
        fig.level = p.level;
        fig.home.y = p.arrive.y;
        m.stage = 'in';
        m.path = p.after && p.after.length ? p.after.slice() : null;
        m.pi = 0;
        m.speed = 0;
        if (m.path) fig.object.rotation.y = Math.atan2(m.path[0].x - fig.at.x, m.path[0].z - fig.at.z);
      }
    } else if (m.stage === 'in') {
      setOpacity(fig, Math.min(1, m.fade + dt / 0.6));
      if (m.fade >= 1 && !m.path) { m.stage = 'done'; order.done = true; }
    }
  }

  // -- the body ------------------------------------------------------------------

  function weightTowards(action, want, rate) {
    if (!action) return;
    const w = action.getEffectiveWeight();
    action.setEffectiveWeight(w + (want - w) * rate);
  }

  /**
   * Blend the loops for what the figure is doing, then lay any one-shot over
   * them. Weights always add to one: three.js fills a shortfall with the bind
   * pose, which is how a figure gets caught half in T-pose.
   */
  function animate(fig, dt) {
    const m = fig.m;
    const a = fig.actions;
    if (!fig.mixer || !a) return;
    const speed = m.speed;
    const clips = fig.clips;

    // One-shot overlay envelope.
    let over = 0;
    const o = m.overlay;
    if (o) {
      o.t += dt * o.action.timeScale;
      const dur = o.duration;
      const fadeIn = Math.min(0.1, dur * 0.2);
      const fadeOut = o.hold ? 0 : Math.min(0.22, dur * 0.3);
      if (o.t < fadeIn) over = o.t / fadeIn;
      else if (o.hold || o.t < dur - fadeOut) over = 1;
      else over = Math.max(0, (dur - o.t) / fadeOut);
      if (!o.hold && o.t >= dur) {
        o.action.setEffectiveWeight(0);
        o.action.stop();
        m.overlay = null;
        over = 0;
      } else {
        o.action.setEffectiveWeight(over * o.gain);
        over *= o.gain;
      }
    }

    // The loops, blended by what the body is doing.
    const strideWalk = fig.stride.walk || 1.25 * (fig.scale || 1);
    const strideRun = fig.stride.run || strideWalk * 1.9;
    const walkRate = strideWalk / (clips.walk || 1);
    const runRate = strideRun / (clips.run || 1);
    let wWalk = 0; let wRun = 0; let wFight = 0; let wIdle = 0;
    const moving = clamp(speed / 0.35, 0, 1);
    if (a.run) {
      const r = clamp((speed - fig.runFrom + 0.35) / 0.7, 0, 1);
      wRun = moving * r;
      wWalk = moving * (1 - r);
    } else wWalk = moving;
    // A turn on the spot is taken in steps, not on a turntable: a little walk
    // at a slow cadence reads as shifting the feet round.
    if (!moving && m.turning && a.walk) wWalk = 0.35;
    const still = 1 - (wWalk + wRun);
    if (m.fighting && a.fight) wFight = still; else wIdle = still;

    const rate = Math.min(1, dt * 7);
    const want = { idle: 0, idle2: 0, walk: wWalk, run: wRun, fight: wFight };
    want[m.idle === 'idle2' && a.idle2 ? 'idle2' : 'idle'] = wIdle;
    let total = 0;
    const base = m.base || (m.base = { idle: 1 });
    for (const name of LOOP) {
      if (!a[name]) continue;
      const w = base[name] || 0;
      base[name] = w + ((want[name] || 0) - w) * rate;
      total += base[name];
    }
    // Anything that has no clip of its own falls back onto idle, so the sum holds.
    if (total < 1e-3) { base.idle = 1; total = 1; }
    for (const name of LOOP) {
      if (!a[name]) continue;
      a[name].setEffectiveWeight((base[name] / total) * (1 - over));
    }

    // Feet that match the ground. timeScale is ground speed over the speed
    // the clip was authored at, which is its stride over its length.
    if (a.walk) a.walk.timeScale = wWalk > 0 ? clamp((speed > 0.05 ? speed : 0.35) / walkRate, 0.25, 2.4) : 1;
    if (a.run) a.run.timeScale = clamp(speed / runRate, 0.5, 2);
    if (a.run && wRun > 0 && !m.runSynced) {
      // Enter the run on the same foot the walk is on.
      a.run.time = (a.walk.time / (clips.walk || 1)) * (clips.run || 1);
      m.runSynced = true;
    }
    if (wRun === 0) m.runSynced = false;
    m.slip = wWalk > 0.5 && speed > 0.1 ? speed - a.walk.timeScale * walkRate : 0;
  }

  /** The boxed beasts: legs swung off the same measured speed. */
  function animateLegs(fig, dt) {
    const m = fig.m;
    fig.gait = (fig.gait || 0) + m.speed * dt * 5;
    const swing = Math.min(0.7, m.speed * 1.6);
    fig.legs.forEach((leg, i) => {
      leg.rotation.x = Math.sin(fig.gait + (i % 2 ? Math.PI : 0) + (i > 1 ? Math.PI : 0)) * swing;
    });
  }

  function playOnce(fig, name, { timeScale = 1, hold = false, gain = 1, from = 0 } = {}) {
    const action = fig.actions && fig.actions[name];
    if (!action || !fig.mixer) return false;
    const m = fig.m;
    if (m.overlay && m.overlay.action !== action) {
      m.overlay.action.setEffectiveWeight(0);
      m.overlay.action.stop();
    }
    action.reset();
    action.timeScale = timeScale;
    action.time = from;
    action.setEffectiveWeight(0);
    action.play();
    m.overlay = { action, name, t: from, duration: fig.clips[name], hold, gain };
    return true;
  }

  // -- procedural stand-ins -----------------------------------------------------

  /** Offsets that ride on top of the logical position: lunges, recoils, sidesteps. */
  function tickOffsets(fig, dt) {
    const m = fig.m;
    let ox = 0; let oz = 0; let pitch = 0; let roll = 0;
    const yaw = fig.object.rotation.y;
    const fx = Math.sin(yaw); const fz = Math.cos(yaw);
    if (m.lunge) {
      m.lunge.t += dt;
      const u = m.lunge.t / m.lunge.dur;
      if (u >= 1) m.lunge = null;
      else {
        // Wind back, drive through contact, recover.
        const c = m.lunge.contact;
        const s = u < c ? -0.12 * Math.sin((u / c) * Math.PI * 0.5) + 0.42 * smooth(u / c) : 0.42 * (1 - smooth((u - c) / (1 - c)));
        ox += fx * s * m.lunge.reach; oz += fz * s * m.lunge.reach;
        pitch += s * 0.35;
      }
    }
    if (m.recoil) {
      m.recoil.t += dt;
      const u = m.recoil.t / 0.38;
      if (u >= 1) m.recoil = null;
      else {
        const s = Math.sin(u * Math.PI) * (1 - u * 0.4) * m.recoil.amount;
        ox -= fx * s * 0.16; oz -= fz * s * 0.16;
        pitch -= s * 0.16;
      }
    }
    if (m.sway) {
      m.sway.t += dt;
      const u = m.sway.t / 0.55;
      if (u >= 1) m.sway = null;
      else {
        const s = Math.sin(u * Math.PI) * m.sway.side;
        ox += fz * s * 0.38; oz -= fx * s * 0.38;
        roll += s * 0.14;
      }
    }
    m.offset.x = ox; m.offset.z = oz;
    fig.pitch = pitch; fig.roll = roll;
  }

  /** No death clip: go over backwards, as a weight does, and settle. */
  function tickDeath(fig, dt) {
    const d = fig.m.dead;
    if (!d || d.clip) return;
    d.t += dt;
    const u = clamp(d.t / 0.75, 0, 1);
    const fall = u * u; // gravity, not an ease
    if (fig.legs) {
      fig.object.rotation.z = fall * Math.PI / 2 * d.side;
      fig.lift = fall * (fig.height || 1) * 0.24;
    } else {
      fig.pitch = -fall * Math.PI / 2 * 0.97;
      fig.lift = fall * 0.13 * (fig.scale || 1);
      // A last settle: the body lands and rolls back a few degrees.
      if (u >= 1) fig.pitch += Math.sin(clamp((d.t - 0.75) / 0.25, 0, 1) * Math.PI) * 0.05;
    }
  }

  // -- the public side ------------------------------------------------------------

  /**
   * Swing, timed so the blow lands `contactIn` seconds from now -- the moment
   * the game says it lands. The clip's own `hitFrame` says where contact is in
   * it; if there is not time to play the wind-up at its own speed, it plays
   * faster, and a figure without an attack clip lunges instead.
   */
  /** Seconds until the swing now playing connects, or -1 if none is on its way. */
  function swingContactIn(fig) {
    const o = fig.m.overlay;
    if (!o || (o.name !== 'attack' && o.name !== 'attack2')) return -1;
    const hit = ((fig.hitFrame && fig.hitFrame[o.name]) ?? 0.4) * o.duration;
    return o.t < hit ? (hit - o.t) / Math.max(0.05, o.action.timeScale) : -1;
  }

  function strike(fig, name = 'attack', contactIn = 0.35) {
    if (!fig || fig.m.dead) return;
    const clip = fig.actions && (fig.actions[name] ? name : (fig.actions.attack ? 'attack' : null));
    if (clip) {
      const dur = fig.clips[clip];
      const hit = (fig.hitFrame && fig.hitFrame[clip]) ?? 0.4;
      const windup = hit * dur;
      // A swing already on its way keeps its contact: this one may not start
      // before that one has landed. Blows a beat apart overlap otherwise --
      // the second wind-up cut the first off short of its hit frame.
      const busy = swingContactIn(fig);
      let start = contactIn - windup;
      let speed = 1;
      if (busy >= 0 && start < busy + 0.03) start = busy + 0.03;
      if (start < 0) start = 0;
      const available = contactIn - start;
      if (available < windup) {
        if (available < 0.08) return; // no time to be seen swinging at all
        speed = clamp(windup / available, 1, 2.4);
      }
      const from = Math.max(0, windup - available * speed);
      if (start > 0) fig.m.pending = { name: clip, at: start, speed, from };
      else playOnce(fig, clip, { timeScale: speed, from });
      return;
    }
    fig.m.lunge = { t: 0, dur: Math.max(0.5, contactIn + 0.35), contact: clamp(contactIn / Math.max(0.5, contactIn + 0.35), 0.3, 0.8), reach: fig.legs ? 1 : 0.8 };
  }

  /** Taking a blow, catching one on the blade, or stepping out of its way. */
  function react(fig, kind, strength = 0.5) {
    if (!fig || fig.m.dead) return;
    // Mid-swing, the swing wins: a flinch clip laid over it would cancel the
    // blow the game is about to land. The body still gives a little.
    if (swingContactIn(fig) >= 0 || (fig.m.overlay && /^attack/.test(fig.m.overlay.name) && fig.m.overlay.t < fig.m.overlay.duration * 0.7)) {
      if (kind === 'dodge') fig.m.sway = { t: 0, side: fig.rand() < 0.5 ? -1 : 1 };
      else fig.m.recoil = { t: 0, amount: kind === 'hit' ? clamp(0.35 + strength * 0.5, 0.35, 0.9) : 0.3 };
      return;
    }
    if (kind === 'hit') {
      if (!playOnce(fig, 'hit', { gain: clamp(0.55 + strength, 0.6, 1) })) fig.m.recoil = { t: 0, amount: clamp(0.5 + strength, 0.5, 1.2) };
      else fig.m.recoil = { t: 0, amount: 0.35 };
    } else if (kind === 'block') {
      if (!playOnce(fig, 'block')) fig.m.recoil = { t: 0, amount: 0.45 };
    } else if (kind === 'dodge') {
      fig.m.sway = { t: 0, side: fig.rand() < 0.5 ? -1 : 1 };
    }
  }

  /**
   * Play any clip on a figure and hear back when it connects -- the hook for
   * whatever else wants a body to act: a mobile casting, breathing, biting.
   * `onContact` fires on the clip's contact frame (`hitFrame[name]`, else
   * halfway through), on the frame loop's clock, not a timer. `contactIn`,
   * given, times the clip so that frame lands then, as `strike` does. A
   * figure without the clip lunges instead. Returns the seconds until contact,
   * or null for a figure that cannot act (dead, gone).
   */
  function perform(fig, name, { onContact = null, contactIn = null } = {}) {
    if (!fig || !fig.m || fig.m.dead || fig.m.gone) {
      if (onContact) onContact();
      return null;
    }
    const has = fig.actions && fig.actions[name];
    const fraction = (fig.hitFrame && fig.hitFrame[name]) ?? 0.5;
    let at;
    if (has && (/^attack/.test(name) || contactIn !== null)) {
      const natural = fraction * fig.clips[name];
      at = contactIn ?? natural;
      if (/^attack/.test(name)) strike(fig, name, at);
      else {
        const speed = clamp(natural / Math.max(0.05, at), 0.5, 2.4);
        playOnce(fig, name, { timeScale: speed });
        at = natural / speed;
      }
    } else if (has) {
      playOnce(fig, name);
      at = fraction * fig.clips[name];
    } else {
      at = contactIn ?? 0.35;
      fig.m.lunge = { t: 0, dur: Math.max(0.5, at + 0.35), contact: clamp(at / Math.max(0.5, at + 0.35), 0.3, 0.8), reach: fig.legs ? 1 : 0.6 };
    }
    if (onContact) (fig.m.calls || (fig.m.calls = [])).push({ at, fn: onContact });
    return at;
  }

  function die(fig) {
    const m = fig.m;
    if (m.dead) return;
    m.overlay && m.overlay.action.stop();
    m.overlay = null;
    m.path = null; m.speed = 0; m.lunge = null; m.recoil = null; m.sway = null;
    const clip = playOnce(fig, 'death', { hold: true });
    m.dead = { t: 0, clip, side: fig.rand() < 0.5 ? -1 : 1 };
    if (fig.label) fig.label.visible = false;
  }

  // -- the frame --------------------------------------------------------------------

  const RANGE = 46;
  const _player = { x: 0, z: 0 };

  function update(dt, camera) {
    _player.x = camera.position.x; _player.z = camera.position.z;
    const player = _player;

    // Who is near whom, for the ones worth steering.
    _grid.clear();
    for (const fig of figures) {
      if (fig.m.gone && fig.m.gone.done) continue;
      const k = `${Math.floor(fig.at.x / 3)},${Math.floor(fig.at.z / 3)}`;
      let list = _grid.get(k);
      if (!list) { list = []; _grid.set(k, list); }
      list.push(fig);
    }

    for (const fig of figures) {
      const m = fig.m;
      const dx = fig.at.x - player.x; const dz = fig.at.z - player.z;
      const far = dx * dx + dz * dz > RANGE * RANGE;
      const order = orderOf(fig);

      if (order.kind === 'dead' && !m.dead) {
        order.delay = (order.delay ?? 0) - dt;
        if (order.delay <= 0) die(fig);
      }
      if (order.kind === 'gone' && !m.gone) m.gone = { t: 0 };
      if (m.gone) {
        m.gone.t += dt;
        const u = clamp(m.gone.t / 3.5, 0, 1);
        fig.sink = u * 0.5;
        if (!far) setOpacity(fig, 1 - u);
        if (u >= 1) { m.gone.done = true; fig.object.visible = false; continue; }
      }

      if (m.calls && m.calls.length) {
        for (let i = m.calls.length - 1; i >= 0; i--) {
          m.calls[i].at -= dt;
          if (m.calls[i].at <= 0) m.calls.splice(i, 1)[0].fn();
        }
      }

      if (m.pending) {
        m.pending.at -= dt;
        if (m.pending.at <= 0) {
        playOnce(fig, m.pending.name, { timeScale: m.pending.speed || 1, from: m.pending.from || 0 });
        m.pending = null;
      }
      }

      if (far) {
        // Out of sight a walk is only a position moving along a line: no
        // mixer, no steering, nobody to step round.
        fig.object.visible = false;
        coast(fig, dt);
        placeObject(fig);
        continue;
      }
      fig.object.visible = true;

      if (!m.dead) {
        think(fig, dt, player);
        portalStep(fig, dt);
        if (m.stage !== 'out') steer(fig, dt, player);
        separate(fig, player);
      }
      tickOffsets(fig, dt);
      tickDeath(fig, dt);
      if (fig.legs) animateLegs(fig, dt);
      else animate(fig, dt);
      if (fig.mixer) fig.mixer.update(dt);
      fig.walking = m.speed > 0.16;
      placeObject(fig);
    }
  }

  function placeObject(fig) {
    const m = fig.m;
    fig.object.position.set(
      fig.at.x + m.offset.x,
      fig.at.y + (fig.lift || 0) - (fig.sink || 0),
      fig.at.z + m.offset.z,
    );
    // Pitch and roll are about the figure's own axes, after its heading.
    fig.object.rotation.order = 'YXZ';
    if (!fig.legs || !m.dead) fig.object.rotation.x = fig.pitch || 0;
    if (!m.dead || !fig.legs) fig.object.rotation.z = fig.roll || 0;
  }

  /** The far-away version of a walk: along the path at the figure's pace. */
  function coast(fig, dt) {
    const m = fig.m;
    const order = orderOf(fig);
    if (m.dead) return;
    if (order !== m.order) think(fig, 0, null);
    if (order.kind === 'travel') {
      // No one is watching the archway: through it at once.
      if (m.stage === 'out') portalStep(fig, 1);
      if (m.stage === 'in') { setOpacity(fig, 1); portalStep(fig, 1); }
      if (!m.path) {
        if (m.stage === 'walk') think(fig, 0, null);
        return;
      }
      let step = fig.pace * dt;
      while (step > 0 && m.path) {
        const t = m.path[m.pi];
        const d = Math.hypot(t.x - fig.at.x, t.z - fig.at.z);
        if (d <= step) {
          fig.at.x = t.x; fig.at.z = t.z; step -= d;
          m.pi++;
          if (m.pi >= m.path.length) { m.path = null; }
        } else {
          fig.at.x += ((t.x - fig.at.x) / d) * step;
          fig.at.z += ((t.z - fig.at.z) / d) * step;
          fig.object.rotation.y = Math.atan2(t.x - fig.at.x, t.z - fig.at.z);
          step = 0;
        }
      }
      if (!m.path) think(fig, 0, null);
      m.speed = 0;
    }
  }

  /** Numbers for the harness: how much of the crowd is on its feet, and how honestly. */
  function stats() {
    let moving = 0; let idle = 0; let travelling = 0;
    for (const fig of figures) {
      if (fig.m.dead) continue;
      if (fig.m.speed > 0.16) moving++; else idle++;
      if (orderOf(fig).kind === 'travel') travelling++;
    }
    return { moving, idle, travelling, figures: figures.length };
  }

  return { update, strike, react, perform, die, setOpacity, stats, orderOf, CLOSE };
}
