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
/**
 * Radians a second. No body comes round faster than TURN_CAP (150 deg/s):
 * a dog was measured at 174 and a horse at 196, spinning on the spot. A long
 * body turns slower again (`turnRate`).
 */
const TURN_CAP = 2.6;
const TURN_STANDING = TURN_CAP;
const TURN_WALKING = 2.0;
/** Personal space: people keep this much between their centres. */
const SPACE = 0.72;
const LOOK_AHEAD = 1.8;
/** Clearance from the player's eye column. */
const YOU = 0.9;
/** How close an opponent closes for melee, centre to centre. */
export const CLOSE = 1.55;

const LOOP = ['idle', 'idle2', 'walk', 'run', 'fight', 'talk'];
/**
 * What an animal does with itself standing about, when its rig carries a
 * clip for it (tools/blender/beasts.py and creatures.py): the deer grazes,
 * the lizard basks and does its push-ups, the rabbit nibbles, washes and sits
 * up to look round, the fox sits on its haunches and stares, the bear rears.
 * `odds` weighs the choice between a rig's pastimes; `hold` and `gap` are
 * seconds of doing it and of standing between; `rate` is how fast it comes
 * in and goes out, per second -- a head down to the grass over a second or
 * so, a push-up at once. A `once` pastime is a display with a start and an
 * end: it plays from its first frame, for exactly its own length.
 */
const PASTIMES = {
  graze: { odds: 3, hold: [5, 15], gap: [2.5, 6.5], rate: 1.6 },
  bask: { odds: 3, hold: [12, 30], gap: [2, 6], rate: 0.9 },
  display: { odds: 1, once: true, gap: [2, 6], rate: 6 },
  nibble: { odds: 3, hold: [4, 10], gap: [1.5, 4], rate: 3 },
  groom: { odds: 1, once: true, gap: [2, 6], rate: 5 },
  situp: { odds: 1, once: true, gap: [2, 6], rate: 5 },
  sniff: { odds: 2, hold: [2, 5], gap: [2, 6], rate: 2.5 },
  haunch: { odds: 2, hold: [8, 20], gap: [3, 8], rate: 1.8 },
  howl: { odds: 0.4, once: true, gap: [4, 10], rate: 4 },
  snarl: { odds: 1, once: true, gap: [2, 6], rate: 5 },
  rear: { odds: 1, once: true, gap: [4, 10], rate: 4 },
  root: { odds: 3, hold: [5, 14], gap: [2, 5], rate: 1.8 },
  feel: { odds: 3, hold: [4, 10], gap: [1, 4], rate: 2 },
  withdraw: { odds: 1, once: true, gap: [3, 9], rate: 4 },
  quiver: { odds: 2, once: true, gap: [2, 6], rate: 4 },
  // The cat lies down with its paws tucked and dozes, and stretches; the
  // snake lies coiled, raises its head to taste the air with its tongue, and
  // rears up and sways. A hiss is never chosen idly (odds 0): it is what the
  // alley cat and the snake do when you come close (ALARM, and the prose's
  // own `temper` in actors.js).
  loaf: { odds: 2, hold: [12, 40], gap: [3, 8], rate: 1.2 },
  stretch: { odds: 0.6, once: true, gap: [3, 8], rate: 4 },
  coil: { odds: 3, hold: [15, 45], gap: [3, 8], rate: 0.8 },
  taste: { odds: 2, hold: [4, 10], gap: [2, 6], rate: 2.5 },
  sway: { odds: 1, hold: [5, 12], gap: [3, 8], rate: 1.5 },
  hiss: { odds: 0, once: true, gap: [2, 5], rate: 6 },
  // Birds, between their pecks: the hen broods and scratches, every bird
  // preens and now and then beats its wings.
  brood: { odds: 0.6, hold: [20, 60], gap: [4, 10], rate: 0.9 },
  scratch: { odds: 2, hold: [3, 9], gap: [2, 6], rate: 3 },
  preen: { odds: 1, once: true, gap: [3, 8], rate: 4 },
  flap: { odds: 0.3, once: true, gap: [4, 10], rate: 6 },
  // A spider lies in wait more than it does anything else, and shows you
  // its fangs only when you come close.
  lurk: { odds: 3, hold: [8, 30], gap: [3, 8], rate: 1.2 },
  threat: { odds: 0, once: true, gap: [3, 8], rate: 6 },
  // The deer and the horse look up and stamp at someone coming; a horse at
  // rest stands on three legs and dozes. (A cow lies down: `loaf`.)
  alert: { odds: 0, once: true, gap: [3, 8], rate: 5 },
  doze: { odds: 2, hold: [15, 45], gap: [4, 10], rate: 0.8 },
  // The mudmonster 'slowly evolving from the mud': back down into it, and
  // up out of it again, slowly.
  wallow: { odds: 2, hold: [10, 30], gap: [6, 14], rate: 0.45 },
  // A gargoyle (and an imp) crouches still as the carving it might be.
  perch: { odds: 3, hold: [15, 40], gap: [4, 10], rate: 0.8 },
};
const PASTIME_NAMES = Object.keys(PASTIMES);
/**
 * What a rig does when you walk up to it, by archetype: [pastime, metres at
 * scale 1]. The snail "trying to get out of your way" draws itself in; the
 * rabbit sits up to see what you are; the lizard answers you with push-ups,
 * which is what a lizard does at anything that comes onto its ground.
 */
const ALARM = { snail: ['withdraw', 2.2], lagomorph: ['situp', 4.5], lizard: ['display', 3.2], serpent: ['hiss', 2.4],
  fowl: ['flap', 1.6], songbird: ['flap', 5], rodent: ['situp', 3], spider: ['threat', 2.2],
  cervid: ['alert', 7], equine: ['alert', 3] };
/**
 * people.py's sit, in seconds: the first REST_LOOP of it is at rest and
 * breathing and comes back to its first frame, and SIP is the stretch where
 * the right hand brings the cup up and puts it down again.
 */
const REST_LOOP = 1.8;
/** people.js's word for a child, on the mobile's short description. */
const CHILD = /\b(child|children|kids?|boys?|girls?|urchins?|lads?|lass(es)?|pupils?|youngsters?|orphans?|toddlers?)\b/i;
const SIP = [2.35, 4.0];
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

// -- bodies ---------------------------------------------------------------------

/**
 * How much ground a figure covers: a capsule along its heading. A horse is a
 * 2.7 m body on a 0.7 m width, and separating it as a 0.55 m circle is how
 * four horses and three cows came to stand inside one another in a barn.
 * People and anything without a measured footprint are a circle.
 */
function bodyOf(fig) {
  const foot = fig.object.userData.footprint;
  if (!foot) return { r: 0.28, h: 0, ahead: 0 };
  const r = Math.max(0.12, foot.width / 2);
  return { r, h: Math.max(0, foot.length / 2 - r), ahead: foot.ahead || 0 };
}

/**
 * How fast a body can come round, from the rate its gait allows: a horse is
 * 2.7 m of animal and turns on the spot by walking its hind legs round its
 * fore, so at the cap it swept its quarters into whatever stood beside it and
 * the separation slid both apart. Scaled down by the length of the body.
 */
function turnRate(fig, rate) {
  return Math.min(rate, TURN_CAP) / (1 + 1.4 * fig.body.h);
}

/**
 * One frame's turn towards an error of `err`, at most `rate` a second -- with
 * hysteresis: near a half turn either way is as short, and a target that
 * wobbles across the line flipped a horse's turn twelve times in twenty
 * seconds. Once coming round one way it keeps that way until it is there.
 */
function turnStep(m, err, rate, dt) {
  if (m.turnDir && Math.sign(err) !== m.turnDir && Math.abs(err) > 2.2) err += m.turnDir * Math.PI * 2;
  const step = clamp(err, -rate * dt, rate * dt);
  m.turnDir = Math.abs(err) > 0.05 ? Math.sign(step) : 0;
  return step;
}

/** Closest distance between two segments in the plane, and the closest points. */
function segSeg(ax, az, bx, bz, cx, cz, dx, dz, out) {
  const d1x = bx - ax; const d1z = bz - az;
  const d2x = dx - cx; const d2z = dz - cz;
  const rx = ax - cx; const rz = az - cz;
  const a = d1x * d1x + d1z * d1z; const e = d2x * d2x + d2z * d2z; const f = d2x * rx + d2z * rz;
  let s = 0; let t = 0;
  if (a <= 1e-9 && e <= 1e-9) { s = 0; t = 0; } else if (a <= 1e-9) { t = clamp(f / e, 0, 1); } else {
    const c = d1x * rx + d1z * rz;
    if (e <= 1e-9) { s = clamp(-c / a, 0, 1); } else {
      const b = d1x * d2x + d1z * d2z; const denom = a * e - b * b;
      s = denom > 1e-9 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  out.px = ax + d1x * s; out.pz = az + d1z * s;
  out.qx = cx + d2x * t; out.qz = cz + d2z * t;
  return Math.hypot(out.px - out.qx, out.pz - out.qz);
}

/**
 * The bones a procedural pose needs, found by name. Only the people's rig has
 * all of them; a beast or a boxed figure gets null and never sits.
 */
function findBones(fig) {
  const want = { hips: /^hips$/i, spine: /^spine$/i, thighL: /^thighL$/i, thighR: /^thighR$/i, shinL: /^shinL$/i, shinR: /^shinR$/i, footL: /^footL$/i };
  const extra = { footR: /^footR$/i, head: /^head$/i };
  const out = {};
  fig.object.traverse((n) => {
    if (!n.isBone) return;
    for (const [k, re] of Object.entries({ ...want, ...extra })) if (!out[k] && re.test(n.name)) out[k] = n;
  });
  return Object.keys(want).every((k) => out[k]) ? out : null;
}

// -- postures out of the rig's own clips ---------------------------------------

/**
 * Bones a layer may move. A clip played through a mask moves only these and
 * leaves the legs (and whatever the body is sitting or leaning on) to the
 * loops underneath: talking while seated, a cup raised at the bar.
 */
const UPPER = /^(spine|chest|neck|head|jaw|shoulder[LR]|upperarm[LR]|forearm[LR]|hand[LR]|grip[LR]|shield[LR])$/;
const CUP_ARM = /^(neck|head|jaw|shoulderR|upperarmR|forearmR|handR|gripR)$/;

const maskedCache = new WeakMap();
function maskedClip(clip, mask) {
  let byMask = maskedCache.get(clip);
  if (!byMask) { byMask = new Map(); maskedCache.set(clip, byMask); }
  let out = byMask.get(mask);
  if (!out) {
    out = clip.clone();
    out.name = `${clip.name}|${mask.source}`;
    out.tracks = out.tracks.filter((t) => mask.test(t.name.split('.')[0]));
    byMask.set(mask, out);
  }
  return out;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * Where a rig's own sit and lean put its hips, ankles and back, in the
 * figure's frame, measured once per figure by posing each clip alone (its
 * size is its own, so a halfling is not a scaled man). The back is the
 * rearmost skinned vertex of the trunk between the hips and the shoulders,
 * read after `skeleton.update()` -- a vertex read without it is skinned by
 * whatever bone matrices the last render left behind.
 */
function measurePoses(fig, bones, withBack = false) {
  const root = fig.object;
  const a = fig.actions;
  const saved = Object.values(a).map((x) => [x, x.getEffectiveWeight(), x.time, x.enabled]);
  const mesh = root.getObjectByProperty('isSkinnedMesh', true);
  const local = (bone) => root.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
  const pose = (name, time) => {
    for (const [x] of saved) x.setEffectiveWeight(0);
    const act = a[name];
    act.enabled = true;
    if (!act.isRunning()) act.play();
    act.setEffectiveWeight(1);
    act.time = time;
    fig.mixer.update(0);
    root.updateMatrixWorld(true);
    const out = {
      hips: local(bones.hips), thighL: local(bones.thighL), thighR: local(bones.thighR),
      ankleL: local(bones.footL), ankleR: local(bones.footR),
    };
    if (name === 'sit' && mesh) out.under = thighUnderside(fig, mesh, bones, root);
    if (name === 'lean' && mesh && withBack) {
      mesh.skeleton.update();
      const skin = mesh.geometry.attributes.skinIndex;
      const names = mesh.skeleton.bones.map((b) => b.name);
      let back = 0;
      const lo = out.hips.y + 0.25 * fig.scale; const hi = out.hips.y + 0.62 * fig.scale;
      for (let i = 0; i < skin.count; i += 2) {
        if (!/^(spine|chest|neck|shoulder[LR])$/.test(names[skin.getX(i)])) continue;
        mesh.getVertexPosition(i, _v1);
        root.worldToLocal(mesh.localToWorld(_v1));
        if (_v1.y > lo && _v1.y < hi && _v1.z < back) back = _v1.z;
      }
      out.back = back;
    }
    return out;
  };
  const poses = {};
  if (a.sit) poses.sit = pose('sit', 0);
  if (a.lean) poses.lean = pose('lean', 0);
  poses.idle = pose('idle', a.idle.time);
  for (const [x, w, t, en] of saved) { x.setEffectiveWeight(w); x.time = t; x.enabled = en; }
  fig.mixer.update(0);
  root.updateMatrixWorld(true);
  const leg = (p) => p.thighL.distanceTo(p.ankleL);
  poses.leg = Math.max(leg(poses.idle), poses.sit ? leg(poses.sit) : 0) * 1.005;
  if (bones.head) {
    // Which way a turn about the head's own X nods it forward.
    const tip = () => root.worldToLocal(bones.head.localToWorld(new THREE.Vector3(0, 0.12, 0)));
    const before = tip().z;
    const q = bones.head.quaternion.clone();
    bones.head.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3));
    root.updateMatrixWorld(true);
    poses.nodSign = tip().z > before ? 1 : -1;
    bones.head.quaternion.copy(q);
    root.updateMatrixWorld(true);
  }
  return poses;
}

/**
 * How low the seated thighs reach, in the figure's frame: the lowest skinned
 * vertex within a thigh's thickness of either thigh bone. That is what rests
 * on the bench. people.py seats the hip joint 0.05 m over it, but the dressed
 * thighs measured 0.11 m under the joint -- trousers 6 cm into the bench --
 * and a coat tail or a skirt hanging lower is cloth, not what is sat on.
 */
const _sa0 = new THREE.Vector3(); const _sa1 = new THREE.Vector3();
function thighUnderside(fig, mesh, bones, root) {
  mesh.skeleton.update();
  const skin = mesh.geometry.attributes.skinIndex;
  const names = mesh.skeleton.bones.map((b) => b.name);
  const legs = [[bones.thighL, bones.shinL], [bones.thighR, bones.shinR]]
    .map(([a, b]) => [root.worldToLocal(a.getWorldPosition(new THREE.Vector3())), root.worldToLocal(b.getWorldPosition(new THREE.Vector3()))]);
  const reach = 0.14 * (fig.scale || 1);
  let low = Infinity;
  // Every vertex: armour plates are few and far between, and every other
  // one left a knight 4.6 cm down in the bench.
  for (let i = 0; i < skin.count; i++) {
    if (!/^thigh[LR]$/.test(names[skin.getX(i)])) continue;
    mesh.getVertexPosition(i, _v1);
    root.worldToLocal(mesh.localToWorld(_v1));
    for (const [a, b] of legs) {
      _sa0.subVectors(b, a); _sa1.subVectors(_v1, a);
      const t = clamp(_sa1.dot(_sa0) / _sa0.lengthSq(), 0, 1);
      if (_sa1.sub(_sa0.multiplyScalar(t)).length() < reach) { low = Math.min(low, _v1.y); break; }
    }
  }
  return low;
}

const _pq = new THREE.Quaternion();
const _pqi = new THREE.Quaternion();
const _fq = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _h = new THREE.Vector3();
const _k = new THREE.Vector3();
const _an = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Turn a bone by a rotation given in world space. */
function turnWorld(bone, q) {
  bone.parent.getWorldQuaternion(_pq);
  _pqi.copy(_pq).invert();
  bone.quaternion.premultiply(_pq).premultiply(q).premultiply(_pqi);
  bone.updateMatrixWorld(true);
}

/**
 * Two-bone IK on a leg: bend the knee to the length the hip-to-target
 * distance wants (law of cosines, about the leg's own plane, so it bends the
 * way the clip already bends it), then swing the thigh to point there. The
 * foot keeps the world orientation the clip gave it, so a sole stays flat,
 * or `footQ`'s: a planted foot does not swivel as the body turns over it.
 * `w` blends from the clip's ankle towards `target`.
 */
function legIK(thigh, shin, foot, target, w, footQ = null, qw = w) {
  thigh.getWorldPosition(_h);
  shin.getWorldPosition(_k);
  foot.getWorldPosition(_an);
  foot.getWorldQuaternion(_fq);
  // A planted foot may keep its own heading rather than the clip's.
  if (footQ && qw > 0) _fq.slerp(footQ, qw);
  _t.copy(_an).lerp(target, w);
  const a = _h.distanceTo(_k); const b = _k.distanceTo(_an);
  const d = clamp(_h.distanceTo(_t), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  _v1.subVectors(_h, _k).normalize();
  _v2.subVectors(_an, _k).normalize();
  const now = Math.acos(clamp(_v1.dot(_v2), -1, 1));
  const want = Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
  _n.crossVectors(_v1, _v2);
  if (_n.lengthSq() > 1e-10 && Math.abs(want - now) > 1e-4) {
    _n.normalize();
    turnWorld(shin, _qw.setFromAxisAngle(_n, want - now));
  }
  foot.getWorldPosition(_an);
  _v1.subVectors(_an, _h).normalize();
  _v2.subVectors(_t, _h).normalize();
  turnWorld(thigh, _qw.setFromUnitVectors(_v1, _v2));
  shin.getWorldQuaternion(_pq);
  foot.quaternion.copy(_pq.invert().multiply(_fq));
  foot.updateMatrixWorld(true);
}

const _qa = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

/**
 * Which way a rotation about a bone's own X swings it, measured off the rig
 * once: the rigs are rolled so local X is the hinge (CLAUDE.md, Blender's roll
 * operators), but which sign is "forward" is the exporter's business, and a
 * sit built on a guessed sign kneels backwards. Also the lengths that decide
 * how far a body drops to meet a seat.
 */
function measureSit(fig, bones) {
  const root = fig.object;
  root.updateMatrixWorld(true);
  const local = (bone, out) => root.worldToLocal(bone.getWorldPosition(out));
  const hip = local(bones.thighL, new THREE.Vector3());
  const knee = local(bones.shinL, new THREE.Vector3());
  const ankle = local(bones.footL, new THREE.Vector3());
  const save = bones.thighL.quaternion.clone();
  bones.thighL.quaternion.multiply(_qa.setFromAxisAngle(_xAxis, 0.6));
  root.updateMatrixWorld(true);
  const thighSign = local(bones.shinL, _pa).z > knee.z ? 1 : -1;
  bones.thighL.quaternion.copy(save);
  const saveShin = bones.shinL.quaternion.clone();
  bones.shinL.quaternion.multiply(_qa.setFromAxisAngle(_xAxis, 0.6));
  root.updateMatrixWorld(true);
  // Knee flexion carries the foot backwards.
  const kneeSign = local(bones.footL, _pb).z < ankle.z ? 1 : -1;
  bones.shinL.quaternion.copy(saveShin);
  root.updateMatrixWorld(true);
  return {
    thighSign, kneeSign,
    hipY: hip.y, thigh: Math.hypot(knee.y - hip.y, knee.z - hip.z), shin: Math.hypot(ankle.y - knee.y, ankle.z - knee.z),
    ankleY: ankle.y,
  };
}

/**
 * @param {object} deps
 *   figures  -- actors.js's figure records
 *   nav      -- nav.js
 *   zones    -- build.js's above/below-ground split, or null: a figure in the
 *               half that is not being drawn is not animated either
 *   spots    -- places a person can settle: { x, y, z, yaw, kind: 'sit'|'stand',
 *               seat (height, for 'sit'), approach (0..1: 0 from in front) }
 */
export function createMotion({ figures, nav, zones = null, spots = [] }) {
  // Each spot knows its room and where to stand before settling into it.
  const spotsByRoom = new Map();
  // Behind a counter, for the room's keeper: not a place anyone settles.
  const keeperSpots = spots.filter((spot) => spot.kind === 'keeper');
  for (const spot of spots) {
    if (spot.kind === 'keeper') continue;
    const level = nav.levelOf(spot.y);
    spot.level = level;
    spot.room = nav.roomAt(spot.x, spot.y, spot.z);
    if (spot.room === undefined) continue;
    const fx = Math.sin(spot.yaw); const fz = Math.cos(spot.yaw);
    // A table bench is stepped over from behind; a bench against a wall is
    // sat down on from in front; a place at a bar is walked up to.
    const back = spot.kind === 'sit' ? (spot.from === 'behind' ? -0.5 : 0.45) : 0;
    const want = { x: spot.x + fx * back, z: spot.z + fz * back };
    const open = nav.nearestOpen(level, want.x, want.z, 1.1);
    if (!open) continue;
    spot.approach = { x: (open[0] + 0.5) * nav.NAV_RES, y: level * nav.LEVEL_H, z: (open[1] + 0.5) * nav.NAV_RES };
    // Nowhere to put your feet in front of a bench turned to face a wall.
    if (spot.kind === 'sit' && spot.from !== 'behind' && !nav.sample(spot.x + fx * 0.75, spot.z + fz * 0.75, level)) continue;
    spot.by = null;
    if (!spotsByRoom.has(spot.room)) spotsByRoom.set(spot.room, []);
    spotsByRoom.get(spot.room).push(spot);
  }

  for (const fig of figures) {
    prepareRig(fig);
    fig.pastimes = fig.actions ? PASTIME_NAMES.filter((n) => fig.actions[n]) : [];
    fig.body = bodyOf(fig);
    fig.bones = fig.mixer && !fig.legs ? findBones(fig) : null;
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
    // How often a stroll is a run: children mostly, halflings sometimes.
    const title = (fig.interactable && fig.interactable.title) || '';
    fig.young = !fig.bones ? 0 : (CHILD.test(title) ? 0.6 : (/\byouths?\b/i.test(title) ? 0.3
      : (fig.scale < 0.72 && !/dwarf|dwarves|gnome/i.test(title) ? 0.08 : 0)));
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
    // Out of the lake. A marsh room can be all lake -- "floating on this
    // boiling lake ... many a creature bumps the bottom of your boat" -- and
    // the marsh giant reset into it stood on the water. Whatever neither
    // swims nor flies starts on the nearest dry ground of its own room, if
    // the room has any; its strolls already keep out of the water.
    if (!fig.swims && !fig.flies && nav.sample(fig.at.x, fig.at.z, fig.level) === 2) {
      const dry = nearestDry(fig);
      if (dry) {
        fig.at.x = dry.x; fig.at.z = dry.z;
        fig.object.position.set(fig.at.x, fig.at.y, fig.at.z);
        if (fig.home) fig.home.copy(fig.object.position);
        if (fig.homeSpot) { fig.homeSpot.x = fig.at.x; fig.homeSpot.z = fig.at.z; }
        if (fig.interactable) fig.interactable.position.set(fig.at.x, fig.at.y + fig.height * 0.6, fig.at.z);
      }
    }
    fig.m = {
      path: null, pi: 0, speed: 0, wait: 0.5 + fig.rand() * 4, turnTo: null,
      idle: 'idle', stuck: 0, repath: 0, goal: null,
      fade: 1, fading: 0, offset: { x: 0, z: 0 }, lunge: null, recoil: null, sway: null,
      overlay: null, dead: null, gone: null, order: null, fighting: false,
      // Settling somewhere (a seat, a wall, a bar), talking to someone, and
      // the footwork of a fight between blows.
      settle: null, talk: null, sitW: 0, leanW: 0, barW: 0, step: null, nextFidget: 0.8, stance: 0, swingIn: 9,
      climb: null, drop: 0, lookAt: null,
    };
    fig.walking = false;
  }

  /** The nearest sample of dry ground, with room to stand, in fig's own room. */
  function nearestDry(fig) {
    const R = 12;
    const step = nav.NAV_RES;
    const dry = (x, z) => nav.sample(x, z, fig.level) === 1;
    let best = null;
    let bestD = Infinity;
    for (let dz = -R; dz <= R; dz += step) {
      for (let dx = -R; dx <= R; dx += step) {
        const d = dx * dx + dz * dz;
        if (d >= bestD || d > R * R) continue;
        const x = fig.at.x + dx; const z = fig.at.z + dz;
        if (!dry(x, z) || !dry(x + 0.6, z) || !dry(x - 0.6, z) || !dry(x, z + 0.6) || !dry(x, z - 0.6)) continue;
        if (nav.roomAt(x, fig.at.y, z) !== fig.room) continue;
        best = { x, z }; bestD = d;
      }
    }
    return best;
  }

  const _grid = new Map();
  const near = [];

  // Numeric keys and lists kept between frames: a string and an array per
  // figure per frame was ~1.4 MB/s of garbage for a table rebuilt every frame.
  const gridKey = (kx, kz) => (kx + 32768) * 65536 + (kz + 32768);
  const _filled = [];
  function rebuildGrid() {
    for (const list of _filled) list.length = 0;
    _filled.length = 0;
    for (const fig of figures) {
      if (fig.m.gone && fig.m.gone.done) continue;
      const k = gridKey(Math.floor(fig.at.x / 3), Math.floor(fig.at.z / 3));
      let list = _grid.get(k);
      if (!list) { list = []; _grid.set(k, list); }
      if (!list.length) _filled.push(list);
      list.push(fig);
    }
  }

  function neighbours(fig, out) {
    out.length = 0;
    const kx = Math.floor(fig.at.x / 3); const kz = Math.floor(fig.at.z / 3);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = _grid.get(gridKey(kx + dx, kz + dz));
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

  // -- settling: a seat, a wall, a place at the bar, someone to talk to ---------

  /**
   * People in a town are mostly *somewhere*: at a table, against a wall, in a
   * doorway talking. A stroll that only ever walked to a random spot and
   * stood there made a tavern of patrons pacing the floor -- one walked 70 of
   * 80 samples and ended 2.4 m from where it began. Merc still decides who
   * moves between rooms; this is only what a body does inside one.
   */
  const canSettle = (fig) => !!fig.bones && !fig.aggressive && !fig.shop;
  /**
   * On watch: a sentinel whose name says it is -- the cityguard at a gate.
   * Not every sentinel dressed as a guard: the Green Dragon's seasoned
   * adventurers wear mail and sit down to drink.
   */
  const WATCH = /\b(guard|guards|guardsman|cityguard|sentry|sentinel|soldier|watchman|captain|sergeant|knight|gatekeeper|warden|constable|shiriff|sheriff)\b/i;
  const onWatch = (fig) => fig.sentinel && WATCH.test((fig.interactable && fig.interactable.title) || '');

  function freeSpot(fig, room) {
    const list = spotsByRoom.get(room);
    if (!list) return null;
    const free = list.filter((s) => !s.by);
    if (!free.length) return null;
    return free[Math.floor(fig.rand() * free.length)];
  }

  /** The nearest tall wall within reach, to lean on. */
  function wallSpot(fig) {
    const w = nav.wallNear(fig.at.x, fig.at.z, fig.level, 2.2);
    if (!w) return null;
    // Stand clear of the wall by what a back and a pair of heels take up.
    const x = w.x + w.nx * 0.3; const z = w.z + w.nz * 0.3;
    // The whole back on the wall, not half of it in a doorway beside it...
    const c = w.box;
    const along = w.nx ? Math.min(w.z - c.z0, c.z1 - w.z) : Math.min(w.x - c.x0, c.x1 - w.x);
    if (along < 0.3) return null;
    // ...and nothing else where the body goes: not a counter, not a crate,
    // not somebody already leaning there.
    if (!nav.clearOf(x, z, fig.level, 0.22, c)) return null;
    neighbours(fig, near);
    if (near.some((o) => o.m.settle && Math.hypot(o.m.settle.spot.x - x, o.m.settle.spot.z - z) < 0.85)) return null;
    const open = nav.nearestOpen(fig.level, w.x + w.nx * 0.75, w.z + w.nz * 0.75, 0.6);
    if (!open) return null;
    const approach = { x: (open[0] + 0.5) * nav.NAV_RES, y: fig.at.y, z: (open[1] + 0.5) * nav.NAV_RES };
    return {
      kind: 'lean', x, y: fig.at.y, z, yaw: Math.atan2(w.nx, w.nz), approach, by: null,
      wall: { x: w.x, z: w.z, nx: w.nx, nz: w.nz },
    };
  }

  /** Someone standing about in reach, to walk over to and talk to. */
  function partnerFor(fig) {
    neighbours(fig, near);
    let best = null; let bestD = 7 * 7;
    for (const o of near) {
      if (!canSettle(o) || o.m.dead || o.m.gone || o.m.path || o.m.settle || o.m.talk || o.m.climb) continue;
      if (o.level !== fig.level || orderOf(o).kind !== 'stroll' || o.m.wait < 2) continue;
      const d = (o.at.x - fig.at.x) ** 2 + (o.at.z - fig.at.z) ** 2;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** Pick something to do rather than somewhere to stand. True if it planned a walk. */
  function planActivity(fig, order) {
    if (!canSettle(fig) || order.radius !== undefined) return false;
    const m = fig.m;
    const r = fig.rand();
    // A sentinel never leaves its room, which is all Merc asks of it; one
    // on watch -- a guard, a knight -- also keeps its post, and gets only a
    // wall to lean on beside it.
    const post = onWatch(fig);
    const seat = post ? null : freeSpot(fig, order.room);
    // A room with seats is a room people sit in: most of a tavern's patrons,
    // most of the time, not one in five.
    if (seat && r < 0.62) {
      const path = nav.pathInRoom(order.room, fig.at, seat.approach, 0.8);
      if (path && path.length) {
        seat.by = fig;
        m.settle = { spot: seat, phase: 'go', t: 0 };
        m.path = path; m.pi = 0; m.goal = seat.approach; m.stuck = 0;
        return true;
      }
    }
    if (r < 0.8 && !post) {
      const partner = partnerFor(fig);
      if (partner) {
        const dx = fig.at.x - partner.at.x; const dz = fig.at.z - partner.at.z;
        const d = Math.hypot(dx, dz) || 1;
        // Conversational distance: 1.2-1.5 m between centres.
        const gap = 1.25 + fig.rand() * 0.25;
        const goal = { x: partner.at.x + (dx / d) * gap, z: partner.at.z + (dz / d) * gap };
        const path = d > gap + 0.4 ? nav.pathInRoom(order.room, fig.at, goal, 0.6) : [];
        if (path) {
          m.talk = { with: partner, phase: 'go', t: 0 };
          partner.m.talk = { with: fig, phase: 'wait', t: 0 };
          partner.m.wait = Math.max(partner.m.wait, 8);
          partner.m.turnTo = Math.atan2(fig.at.x - partner.at.x, fig.at.z - partner.at.z);
          if (path.length) { m.path = path; m.pi = 0; m.goal = goal; m.stuck = 0; } else startTalk(fig);
          return true;
        }
      }
    }
    if (r < 0.95 && fig.rand() < 0.5) {
      const wall = wallSpot(fig);
      const home = fig.homeSpot;
      if (wall && (!post || !home || Math.hypot(wall.x - home.x, wall.z - home.z) < 2.8)) {
        const path = nav.pathInRoom(order.room, fig.at, wall.approach, 0.6);
        if (path && path.length) {
          m.settle = { spot: wall, phase: 'go', t: 0 };
          m.path = path; m.pi = 0; m.goal = wall.approach; m.stuck = 0;
          return true;
        }
      }
    }
    return false;
  }

  function startTalk(fig) {
    const t = fig.m.talk;
    const o = t.with;
    // The same length of conversation for both, and both turned to it; one
    // speaks at a time and the floor changes hands.
    const span = 12 + fig.rand() * 18;
    const conv = { speaker: fig.rand() < 0.5 ? fig : o, turn: 2 + fig.rand() * 4 };
    for (const [a, b] of [[fig, o], [o, fig]]) {
      a.m.talk = { with: b, phase: 'hold', t: 0, conv, gesture: 1 + a.rand() * 3, nod: 0.8 + a.rand() * 2 };
      a.m.wait = span;
      a.m.turnTo = Math.atan2(b.at.x - a.at.x, b.at.z - a.at.z);
      a.m.lookAt = b;
    }
  }

  /**
   * Standing and talking is not standing still. The one speaking talks --
   * the rig's `talk`, gesturing -- and the one listening nods now and then or
   * shifts their weight; every few seconds the other takes a turn.
   */
  function talking(fig, dt) {
    const t = fig.m.talk;
    t.t += dt;
    const o = t.with;
    const conv = t.conv;
    fig.m.turnTo = Math.atan2(o.at.x - fig.at.x, o.at.z - fig.at.z);
    if (conv.speaker === fig) {
      conv.turn -= dt;
      if (conv.turn <= 0) { conv.speaker = o; conv.turn = 2.5 + o.rand() * 5; }
    }
    if (conv.speaker !== fig) {
      t.nod -= dt;
      if (t.nod <= 0) {
        t.nod = 1.4 + fig.rand() * 3;
        if (fig.rand() < 0.65) nod(fig);
        else if (fig.actions.idle2) fig.m.idle = fig.m.idle === 'idle2' ? 'idle' : 'idle2';
      }
      return;
    }
    if (fig.actions.talk) return;
    // A rig without a talk clip makes its point with a raised hand.
    t.gesture -= dt;
    if (t.gesture > 0 || o.m.overlay) return;
    t.gesture = 2.2 + fig.rand() * 3.5;
    const r = fig.rand();
    if (r < 0.45 && fig.actions.cast) playOnce(fig, 'cast', { gain: 0.32 + fig.rand() * 0.12, timeScale: 0.8, until: 0.55 });
    else if (r < 0.7 && fig.actions.idle2) fig.m.idle = fig.m.idle === 'idle2' ? 'idle' : 'idle2';
  }

  function nod(fig) {
    if (!fig.bones || !fig.bones.head) return;
    fig.m.nod = { t: 0, dur: 0.5 + fig.rand() * 0.2, amp: 0.13 + fig.rand() * 0.08, twice: fig.rand() < 0.4 };
  }

  function endTalk(fig) {
    const t = fig.m.talk;
    fig.m.talk = null; fig.m.lookAt = null;
    if (t && t.with && t.with.m.talk && t.with.m.talk.with === fig) {
      t.with.m.talk = null; t.with.m.lookAt = null;
      t.with.m.wait = Math.min(t.with.m.wait, 0.6 + t.with.rand() * 1.5);
    }
  }

  /**
   * A clip on part of the body over whatever the loops are doing: talking
   * with the hands while seated, a cup raised at the bar. `mask` names the
   * bones; `from`..`to` is the stretch of the clip to play.
   */
  function playLayer(fig, name, mask, { from = 0, to = null, timeScale = 1, gain = 0.95, loop = false } = {}) {
    const src = fig.actions && fig.actions[name];
    if (!src || !fig.mixer) return false;
    const m = fig.m;
    const clip = maskedClip(src.getClip(), mask);
    const action = fig.mixer.clipAction(clip);
    if (m.layer && m.layer.action !== action) { m.layer.action.setEffectiveWeight(0); m.layer.action.stop(); }
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.reset();
    action.time = from;
    action.timeScale = timeScale;
    action.setEffectiveWeight(0);
    action.play();
    const end = to ?? clip.duration;
    m.layer = { action, name, t: 0, until: loop ? Infinity : (end - from) / timeScale, gain: Math.min(0.95, gain) };
    return true;
  }

  /**
   * What a settled body does while it stays: a drink at a table with mugs on
   * it (the sit clip's own cup, let through only now and then -- its loop
   * holds the rest of the time), a drink at the bar (the same arm on a
   * standing body), a look into the fire.
   */
  function pastime(fig, dt) {
    const m = fig.m;
    const s = m.settle;
    s.next = (s.next ?? 2 + fig.rand() * 6) - dt;
    if (s.next > 0 || m.speech > 0) return;
    s.next = 3.5 + fig.rand() * 7;
    const kind = s.spot.kind;
    const r = fig.rand();
    // Company settled close by is talked to: a few words with the hands,
    // turned to them, and they nod or answer on their own next turn.
    neighbours(fig, near);
    const company = near.filter((o) => o.m.settle && o.m.settle.phase === 'hold' && !(o.m.speech > 0)
      && (o.at.x - fig.at.x) ** 2 + (o.at.z - fig.at.z) ** 2 < 2.6 * 2.6);
    if (company.length && r < 0.5 && fig.actions.talk) {
      const o = company[Math.floor(fig.rand() * company.length)];
      m.speech = 2.2 + fig.rand() * 3.5;
      m.lookAt = o; o.m.lookAt = fig;
      if (fig.rand() < 0.7) nod(o);
      o.m.settle.next = Math.min(o.m.settle.next ?? 9, m.speech + 0.5 + fig.rand());
      return;
    }
    if (kind === 'sit' && s.clip) {
      if (s.spot.from === 'behind' && r < 0.55) m.sip = true;
    } else if (kind === 'bar' && fig.actions.sit && r < 0.75) {
      playLayer(fig, 'sit', CUP_ARM, { from: SIP[0], to: SIP[1], gain: 0.95 });
    } else if (fig.actions.idle2 && r < 0.5) {
      m.idle = m.idle === 'idle2' ? 'idle' : 'idle2';
    }
  }

  /**
   * The settling itself, once the approach is reached: turn to the seat's
   * facing, then sit (or step back to the wall) and hold; get up the same
   * way, backwards. Moves `at` directly -- the seat is inside the table's
   * collider, where the walking grid says nobody stands.
   *
   * A rig with its own `sit` and `lean` settles on them (`beginClip`): the
   * body is placed so the clip's hips land over the seat, the whole figure
   * rises or sinks by the difference between the seat and the one the clip
   * was written for, and the feet are held by IK -- planted where they stood,
   * or stepped one at a time, over the bench when it is a table bench -- so
   * nothing slides. Rigs without the clips fold their legs procedurally
   * (`posture`), as before.
   */
  function tickSettle(fig, dt) {
    const m = fig.m;
    const s = m.settle;
    const spot = s.spot;
    const sitting = spot.kind === 'sit';
    s.t += dt;
    if (s.phase === 'turn') {
      m.turnTo = spot.yaw;
      if (Math.abs(wrap(spot.yaw - fig.object.rotation.y)) < 0.12 || s.t > 2.5) {
        s.phase = 'down'; s.t = 0; s.from = { x: fig.at.x, z: fig.at.z };
        stow(fig, true);
        beginClip(fig);
      }
      return true;
    }
    if (s.phase === 'down' || s.phase === 'up') {
      if (s.clip) return tickClip(fig, dt);
      const dur = sitting ? 0.85 : 0.5;
      const u = clamp(s.t / dur, 0, 1);
      const k = smooth(s.phase === 'down' ? u : 1 - u);
      fig.at.x = s.from.x + (spot.x - s.from.x) * k;
      fig.at.z = s.from.z + (spot.z - s.from.z) * k;
      fig.object.rotation.y += clamp(wrap(spot.yaw - fig.object.rotation.y), -TURN_STANDING * dt, TURN_STANDING * dt);
      if (sitting) m.sitW = k; else if (spot.kind === 'lean') m.leanW = k; else m.barW = k;
      m.speed = 0;
      // Feet shuffle as the weight comes off them or back on.
      m.shuffle = Math.sin(u * Math.PI) * 0.5;
      if (u >= 1) {
        m.shuffle = 0;
        if (s.phase === 'down') settled(fig); else risen(fig);
      }
      return true;
    }
    if (s.phase === 'hold') {
      fig.object.rotation.y += clamp(wrap(spot.yaw - fig.object.rotation.y), -TURN_STANDING * dt, TURN_STANDING * dt);
      // Company at the table: now and then a look at whoever else is settled
      // close by, then back to the room.
      s.glance = (s.glance ?? 1 + fig.rand() * 3) - dt;
      if (s.glance <= 0) {
        s.glance = 3 + fig.rand() * 5;
        neighbours(fig, near);
        const company = near.filter((o) => o.m.settle && o.m.settle.phase === 'hold'
          && (o.at.x - fig.at.x) ** 2 + (o.at.z - fig.at.z) ** 2 < 2.4 * 2.4);
        m.lookAt = company.length && fig.rand() < 0.7 ? company[Math.floor(fig.rand() * company.length)] : null;
      }
      pastime(fig, dt);
      if (s.t > s.until) { m.lookAt = null; standUp(fig); }
      return true;
    }
    return false;
  }

  /**
   * Nobody sits down to a drink with an axe in their fist or a shield on
   * their arm: what a settled body holds is put by, and taken up again when
   * it stands. The markers keep what is held (items.js) apart from what is
   * put by, so a hand that loses its blade while seated stays empty.
   */
  function stow(fig, away) {
    for (const o of [fig.weapon, fig.shield]) if (o && 'stowed' in o) o.stowed = away;
  }

  function settled(fig) {
    const s = fig.m.settle;
    s.phase = 'hold'; s.t = 0;
    s.until = s.spot.kind === 'sit' ? 25 + fig.rand() * 50 : 12 + fig.rand() * 25;
    if (s.clip) fig.m.ik = s.hang ? null : { feet: s.seatFeet.map((f) => new THREE.Vector3(f.x, f.y, f.z)), w: 1 };
  }

  function risen(fig) {
    const m = fig.m;
    m.settle.spot.by = null;
    m.settle = null; m.sitW = 0; m.leanW = 0; m.barW = 0; m.ik = null; m.drop = 0;
    m.wait = 0.8 + fig.rand() * 2;
    stow(fig, false);
  }

  /** Where a spot's clip puts the body and its feet; null leaves it procedural. */
  function beginClip(fig) {
    const m = fig.m;
    const s = m.settle;
    const spot = s.spot;
    const clip = spot.kind === 'sit' ? 'sit' : (spot.kind === 'lean' ? 'lean' : null);
    s.clip = null;
    if (!clip || !fig.actions[clip] || !fig.bones.footR) return;
    // The back is a vertex scan, so it is only read for a body that leans.
    if (!fig.poses || (clip === 'lean' && fig.poses.lean.back === undefined)) fig.poses = measurePoses(fig, fig.bones, clip === 'lean');
    const g = fig.poses;
    const P = g[clip]; const I = g.idle;
    const c = Math.cos(spot.yaw); const sn = Math.sin(spot.yaw);
    const place = (p, rx, rz, y) => ({ x: rx + p.x * c + p.z * sn, y, z: rz - p.x * sn + p.z * c });
    let rx; let rz;
    if (clip === 'sit') {
      // The clip's hip joint over the seat point.
      rx = spot.x - (P.hips.x * c + P.hips.z * sn);
      rz = spot.z - (-P.hips.x * sn + P.hips.z * c);
    } else {
      // The clip's back, measured on this body, a centimetre off the wall.
      const off = -P.back + 0.012;
      rx = spot.wall.x + spot.wall.nx * off;
      rz = spot.wall.z + spot.wall.nz * off;
    }
    const floor = fig.at.y;
    s.clip = clip;
    s.root = { x: rx, z: rz };
    // The body goes up or down by the difference between the seat and the
    // one the clip sits on (people.py writes it for 0.46 m at a 0.51 m hip
    // joint, scaled by the legs).
    // The thighs down on the seat; without a mesh, the clip's own rule.
    const under = Number.isFinite(P.under) ? P.under : 0.902 * P.hips.y;
    s.dy = clip === 'sit' ? spot.y + spot.seat - floor - under : 0;
    // From where the feet are planted now, if footwork has them.
    s.stand = m.feet && m.feet.w > 0.99
      ? m.feet.P.map((p, i) => ({ x: p.x, y: floor + (i ? I.ankleR.y : I.ankleL.y), z: p.z }))
      : [place(I.ankleL, s.from.x, s.from.z, floor + I.ankleL.y), place(I.ankleR, s.from.x, s.from.z, floor + I.ankleR.y)];
    // ...and turned the way they stand, until each is stepped.
    const b = fig.bones;
    s.standQ = m.feet && m.feet.w > 0.99 ? m.feet.Q.map((q) => q.clone())
      : [b.footL.getWorldQuaternion(new THREE.Quaternion()), b.footR.getWorldQuaternion(new THREE.Quaternion())];
    m.feet = null;
    // Flat on the floor as they stand: the troll's sit plants its feet 4 cm
    // lower than its idle does, and a big troll's soles went into the floor.
    s.seatFeet = [place(P.ankleL, rx, rz, floor + I.ankleL.y), place(P.ankleR, rx, rz, floor + I.ankleR.y)];
    // A leg too short for the floor from this seat hangs, as a child's does
    // from a bench, rather than being stretched down to reach it -- which
    // slopes the thigh through the bench's front edge (a baby troll's by
    // 11 cm). Short, or lifted more than a hand's breadth, is hanging.
    const hip = place(P.thighL, rx, rz, floor + P.thighL.y + s.dy);
    const f0 = s.seatFeet[0];
    s.hang = Math.hypot(hip.x - f0.x, hip.y - f0.y, hip.z - f0.z) > g.leg * 0.96 || s.dy > 0.12;
    if (s.hang) for (const [i, f] of s.seatFeet.entries()) f.y = floor + (i ? P.ankleR.y : P.ankleL.y) + s.dy;
    const behind = spot.from === 'behind';
    s.dur = behind ? 1.9 : (clip === 'sit' ? 1.25 : 0.95);
    // Each foot its own step, the second starting before the first is down;
    // over a table's bench the step clears its top.
    s.win = behind ? [[0.04, 0.46], [0.34, 0.78]] : [[0.02, 0.55], [0.3, 0.85]];
    s.lift = [0, 1].map((i) => {
      const d = Math.hypot(s.stand[i].x - s.seatFeet[i].x, s.stand[i].z - s.seatFeet[i].z);
      // Anything more than a few centimetres is a step, lifted: a big
      // troll's 9 cm, slid, was 14 cm of skating over two feet.
      if (d < 0.03) return 0;
      return behind ? spot.seat + 0.07 : Math.min(0.12, 0.04 + d * 0.15);
    });
    // Starting where the feet stand: the turn that called this has already
    // run its frame, and targets left at the origin stretched both legs
    // towards it for one frame -- a metre-long flicker, measured.
    m.ik = { feet: s.stand.map((p) => new THREE.Vector3(p.x, p.y, p.z)), w: 1, q: s.standQ, qw: [1, 1] };
    // Into the clip from its first frame, which is its rest.
    fig.actions[clip].time = 0;
    m.sip = false;
  }

  /** One frame of sitting down or getting up on the clips; `u` runs 0 standing to 1 settled. */
  function tickClip(fig, dt) {
    const m = fig.m;
    const s = m.settle;
    const spot = s.spot;
    const u = clamp(s.phase === 'down' ? s.t / s.dur : 1 - s.t / s.dur, 0, 1);
    const k = smooth(u);
    fig.at.x = s.from.x + (s.root.x - s.from.x) * k;
    fig.at.z = s.from.z + (s.root.z - s.from.z) * k;
    fig.object.rotation.y += clamp(wrap(spot.yaw - fig.object.rotation.y), -TURN_STANDING * dt, TURN_STANDING * dt);
    // Over a bench the legs go first and the weight comes down after them.
    const w = spot.from === 'behind' ? smooth(clamp((u - 0.34) / 0.66, 0, 1)) : k;
    if (s.clip === 'sit') m.sitW = w; else m.leanW = w;
    m.drop = -s.dy * w;
    m.speed = 0;
    for (let i = 0; i < 2; i++) {
      const [a, b] = s.win[i];
      const e = clamp((u - a) / (b - a), 0, 1);
      const from = s.stand[i]; const to = s.seatFeet[i];
      const t = m.ik.feet[i];
      const f = smooth(e);
      t.set(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, from.z + (to.z - from.z) * f);
      t.y += s.lift[i] * Math.min(1, 1.7 * Math.sin(Math.PI * e));
      // Down, a foot keeps its standing heading until it is stepped; up,
      // it takes it back as it lands.
      if (m.ik.qw) m.ik.qw[i] = 1 - f;
    }
    m.ik.w = 1;
    const done = s.phase === 'down' ? u >= 1 : u <= 0;
    if (done) { if (s.phase === 'down') settled(fig); else risen(fig); }
    return true;
  }

  function standUp(fig) {
    const s = fig.m.settle;
    if (!s) return;
    if (s.phase === 'go' || s.phase === 'turn') {
      s.spot.by = null; fig.m.settle = null; return;
    }
    if (s.phase === 'up') return;
    if (fig.m.layer) fig.m.layer.until = 0;
    if (s.clip) {
      // From however far down it got, back the way it came.
      const u = s.phase === 'down' ? clamp(s.t / s.dur, 0, 1) : 1;
      s.phase = 'up'; s.t = (1 - u) * s.dur;
      const b = fig.bones;
      fig.m.ik = { feet: [b.footL.getWorldPosition(new THREE.Vector3()), b.footR.getWorldPosition(new THREE.Vector3())], w: 1, q: s.standQ, qw: [0, 0] };
      return;
    }
    const k = s.spot.kind === 'sit' ? fig.m.sitW : (s.spot.kind === 'lean' ? fig.m.leanW : fig.m.barW);
    // Up to where the sitting-down started, from however far down it got.
    s.phase = 'up';
    s.t = (1 - k) * (s.spot.kind === 'sit' ? 0.85 : 0.5);
    s.from = s.from || { x: s.spot.approach.x, z: s.spot.approach.z };
  }

  /**
   * Children at tag: one runs at another, and the one caught runs off in
   * turn. Only between children of the same room, and only when both are
   * free to play.
   */
  function planTag(fig, order) {
    if (!(fig.young >= 0.3) || fig.rand() > 0.55) return false;
    neighbours(fig, near);
    const others = near.filter((o) => o.young >= 0.3 && !o.m.dead && !o.m.settle && orderOf(o).kind === 'stroll'
      && (o.at.x - fig.at.x) ** 2 + (o.at.z - fig.at.z) ** 2 < 8 * 8);
    if (!others.length) return false;
    const it = others[Math.floor(fig.rand() * others.length)];
    const path = nav.pathInRoom(order.room, fig.at, it.at, 0.7);
    if (!path || !path.length) return false;
    const m = fig.m;
    m.path = path; m.pi = 0; m.goal = { x: it.at.x, z: it.at.z }; m.stuck = 0; m.play = true;
    // Caught, or nearly: it is off the moment the chaser gets there.
    it.m.wait = Math.min(it.m.wait, 0.3 + (path.length * 0.5) / fig.runPace);
    return true;
  }

  function planStroll(fig, order) {
    const m = fig.m;
    if (planActivity(fig, order)) return;
    if (planTag(fig, order)) return;
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
        const g = o.m.dead ? o.at : (o.m.goal || o.at);
        const room = 1.4 + fig.body.h + o.body.h + Math.max(0, fig.body.r + o.body.r - 0.56);
        return (g.x - x) ** 2 + (g.z - z) ** 2 < room * room;
      }),
    });
    if (!spot) { m.wait = 1.5 + fig.rand() * 2; return; }
    const path = nav.pathInRoom(order.room, fig.at, spot);
    if (!path || !path.length) { m.wait = 1 + fig.rand() * 2; return; }
    m.path = path; m.pi = 0; m.goal = spot; m.stuck = 0;
    // Children do not walk anywhere they can run.
    m.play = !!fig.young && fig.rand() < fig.young;
  }

  function arrive(fig) {
    const m = fig.m;
    m.path = null;
    m.play = false;
    if (m.settle && m.settle.phase === 'go') {
      // Boxed in short of the seat: give it up rather than slide through a table.
      const a = m.settle.spot.approach;
      if (Math.hypot(a.x - fig.at.x, a.z - fig.at.z) > 0.8) { m.settle.spot.by = null; m.settle = null; return arrive(fig); }
      m.settle.phase = 'turn'; m.settle.t = 0;
      m.goal = { x: fig.at.x, z: fig.at.z };
      return;
    }
    if (m.talk && m.talk.phase === 'go') {
      const o = m.talk.with;
      if (o.m.talk && o.m.talk.with === fig && Math.hypot(o.at.x - fig.at.x, o.at.z - fig.at.z) < 2.4) { startTalk(fig); m.goal = { x: fig.at.x, z: fig.at.z }; return; }
      m.talk = null;
    }
    m.goal = { x: fig.at.x, z: fig.at.z };
    // A while standing about, not a metronome: mostly a few seconds, now and
    // then a long stop -- someone looking in a window, waiting for a friend.
    const long = fig.rand() < 0.22;
    m.wait = long ? 8 + fig.rand() * 12 : 2.2 + fig.rand() * 5.5;
    // A child is off again almost at once.
    if (fig.young >= 0.3) m.wait = 0.4 + fig.rand() * (long ? 4 : 1.8);
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
    // Anything but a stroll -- Merc sending them on, a fight -- gets them up
    // off the bench first, and out of the conversation.
    // Being noticed (a hold on anyone but a shopkeeper) is only a look, and
    // the head turns for that: it used to get every patron up off the bench
    // the player walked past.
    const noticing = order.kind === 'hold' && !fig.shop && (m.settle || m.talk);
    if (noticing) return;
    if (order.kind !== 'stroll') {
      if (m.talk) endTalk(fig);
      if (m.settle) standUp(fig);
    }
    if (m.settle && (m.settle.phase === 'up' || (order.kind !== 'stroll' && m.settle.phase !== 'go'))) {
      m.want = 0; m.fighting = false;
      return;
    }
    if (order !== m.order) {
      m.order = order;
      m.path = null;
      m.turnTo = null;
      if (order.kind === 'travel') {
        // A flight waits for the blow that caused it to be seen landing.
        m.stage = order.wait > 0 ? 'wait' : 'walk';
        if (m.stage === 'walk') { m.path = order.route.points.slice(); m.pi = 0; }
      } else {
        // A journey interrupted half-way into an archway is over: 'out' is
        // the stage that skips steering, and a skeleton caught in it fought
        // a whole fight without once turning to face its opponent.
        m.stage = null;
      }
    }
    m.fighting = false;
    m.want = order.kind === 'stroll' && m.play ? fig.runPace * 0.8 : fig.pace;
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
          const portal = order.route.portal;
          if (portal && portal.climb) {
            m.stage = 'climb';
            m.climb = { pts: portal.climb, i: 0, portal, order };
          } else if (portal) { m.stage = 'out'; m.fading = -1; } else { order.done = true; }
        }
        return;
      }
      case 'chase': case 'face': {
        const target = order.target;
        const dx = target.x - fig.at.x; const dz = target.z - fig.at.z;
        const d = Math.hypot(dx, dz);
        m.fighting = d < 4.5;
        m.faceYaw = Math.atan2(dx, dz);
        // Crowded inside the standoff -- you walked up to them, or they were
        // already that close when it started -- a fighter gives ground, a
        // half step back at a time, still facing you. Without it a guard
        // stayed wherever the fight found him: 1.1 m from your eye, measured,
        // with his shield filling the frame.
        const stop = order.stop ?? CLOSE;
        if (m.fighting && order.kind === 'chase' && d < stop - 0.3 && !m.step && (fig.actions?.walk || fig.legs)) {
          m.path = null; m.want = 0;
          m.step = { t: 0, dur: 0.55, along: 0, side: 0, back: Math.min(0.55, stop - d), dx: -dx / d, dz: -dz / d };
          return;
        }
        if (order.kind === 'face' || d <= stop + 0.15) { m.path = null; m.want = 0; return; }
        m.want = d > 4 ? fig.runPace : fig.pace * 1.25;
        m.repath -= dt;
        if (m.repath <= 0 || !m.path) {
          m.repath = 0.35;
          // Stop short of them, on the near side.
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
          // Someone at the counter is served; otherwise there is work.
          if (pd < (fig.shop ? 3.6 : 7)) { m.turnTo = Math.atan2(player.x - fig.at.x, player.z - fig.at.z); if (m.work) endWork(fig); }
          else if (fig.shop) work(fig, dt, order);
          else if (order.yaw !== undefined) m.turnTo = order.yaw;
        }
        return;
      }
      default: {
        // stroll
        // A walk to a seat or a partner that ended while some other order
        // stood -- a notice, a hold -- never arrived, and the body stood
        // there 'going' for good: the temple's executioner, for a minute.
        if (!m.path && ((m.settle && m.settle.phase === 'go') || (m.talk && m.talk.phase === 'go'))) arrive(fig);
        if (m.path || m.settle) return;
        m.wait -= dt;
        if (m.talk) {
          if (m.talk.phase === 'hold') talking(fig, dt);
          if (m.wait > 0) return;
          endTalk(fig);
        }
        // Someone aggressive keeps an eye on you while standing about.
        if (fig.aggressive && player) {
          const pd = Math.hypot(player.x - fig.at.x, player.z - fig.at.z);
          if (pd < 9) { m.turnTo = Math.atan2(player.x - fig.at.x, player.z - fig.at.z); return; }
        }
        if (m.wait <= 0 && onWatch(fig) && order.radius === undefined && watch(fig)) return;
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
        // Still coming to a stop: the turn waits on the feet, or the body
        // swings round over a planted foot and drags it (0.3-0.9 m/s,
        // measured, on every guard that stopped to look at the player).
        const rate = turnRate(fig, TURN_STANDING * (m.fighting ? 1.4 : 0.7)) * (m.speed > 0.05 && !m.fighting ? clamp(m.speed / 1.0, 0.25, 1) * 0.4 : 1);
        const want = turnStep(m, err, rate, dt);
        // A turn the wall will not allow is given up: kept wanted, the feet
        // shuffled on the spot for good (the alley cat against its wall,
        // a third of a walk under every pastime it took up).
        const blocked = turnsInto(fig, yaw + want);
        yaw += blocked ? 0 : want;
        m.turning = !blocked && Math.abs(err) > 0.05 ? Math.sign(err) : 0;
        if ((Math.abs(err) < 0.02 || blocked) && !m.fighting) m.turnTo = null;
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
      if (o.m.gone || o.m.fade < 0.5 || o.level !== fig.level) continue;
      // A long body wants the room its length takes, and a body on the
      // ground is as much in the way as a standing one.
      consider(o.at.x, o.at.z, SPACE + (fig.body.r + o.body.r - 0.56) + o.body.h * 0.8 + fig.body.h * 0.5, false);
    }
    if (player) consider(player.x, player.z, YOU, true);
    // Waiting on you to get out of the way, for a stroll, is worth a second
    // and a half; then it is somewhere else to go. Five patrons of an inn
    // stood round a player at the centre of the room for forty seconds.
    if (brake === 0) {
      m.yielded = (m.yielded || 0) + dt;
      if (m.yielded > 1.5 && orderOf(fig).kind === 'stroll') { m.yielded = 0; arrive(fig); return; }
    } else m.yielded = 0;
    // Don't swerve past the point itself when nearly there.
    if (remaining < 1.2) bend *= remaining / 1.2;
    wantYaw += clamp(bend, -1.1, 1.1);

    const err = wrap(wantYaw - yaw);
    if (Math.abs(err) > TURN_FIRST && m.speed < 0.3) {
      // Turn first, then walk: setting off while still swinging round reads
      // as sliding, which is the fault this whole file exists to remove.
      m.speed = Math.max(0, m.speed - DECEL * dt);
      let step = turnStep(m, err, turnRate(fig, TURN_STANDING), dt);
      if (turnsInto(fig, yaw + step)) step = 0;
      fig.object.rotation.y = yaw + step;
      m.turning = Math.sign(step);
      return;
    }
    m.turning = 0;
    // A body only comes round as fast as its feet can carry it there: at a
    // shuffle a 2.6 rad/s turn swung the planted foot round the hips at
    // 0.3 m/s. Slow walking turns slowly; a turn wanted faster than that is
    // taken standing, on footwork.
    const rate = turnRate(fig, TURN_WALKING) * (m.speed > fig.runFrom ? 0.75 : 1) * clamp(m.speed / 1.0, 0.25, 1);
    yaw += turnStep(m, err, rate, dt);
    fig.object.rotation.y = yaw;

    // Slow for a sharp bend, and slow in time to stop at the end.
    const bendFactor = clamp(Math.cos(err), 0.15, 1);
    const stopping = Math.sqrt(2 * DECEL * Math.max(0, remaining - 0.1));
    // A grazer lifts its head before it walks on: setting off with the
    // graze still at full weight read as the whole animal sliding.
    const headUp = m.graze ? clamp(1 - m.graze.w * 1.6, 0, 1) : 1;
    const target = Math.min(m.want * bendFactor * brake * headUp, stopping);
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
    if (walksInto(fig, nx, nz)) {
      // Not into another body: stop short, and a walk that stays blocked is
      // given up below. Pushing apart afterwards is a slide.
      m.speed = Math.max(0, m.speed - DECEL * 2 * dt);
      m.stuck += dt;
    } else if (nav.sample(nx, nz, fig.level)) {
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

  /** Whether a step to (x, z) takes fig deeper into someone's body. */
  function walksInto(fig, x, z) {
    neighbours(fig, near);
    const ox = fig.at.x; const oz = fig.at.z;
    let hit = false;
    for (const o of near) {
      if (o.m.gone || o.level !== fig.level) continue;
      const before = gapBetween(fig, o);
      if (before > 0.3) continue;
      fig.at.x = x; fig.at.z = z;
      const after = gapBetween(fig, o);
      fig.at.x = ox; fig.at.z = oz;
      if (after < 0.02 && after < before) { hit = true; break; }
    }
    return hit;
  }

  /**
   * Whether coming round to `yaw` swings a long body deeper into someone:
   * a horse turning on the spot swept its quarters through the cow beside it.
   */
  function turnsInto(fig, yaw) {
    if (fig.body.h < 0.15) return false;
    neighbours(fig, near);
    const was = fig.object.rotation.y;
    let hit = false;
    for (const o of near) {
      if (o.m.gone || o.level !== fig.level) continue;
      const before = gapBetween(fig, o);
      if (before > 0.3) continue;
      fig.object.rotation.y = yaw;
      const after = gapBetween(fig, o);
      fig.object.rotation.y = was;
      if (after < 0.02 && after < before) { hit = true; break; }
    }
    return hit;
  }

  /** The two ends of a figure's body segment on the ground. */
  function spine(fig, out) {
    const h = fig.body.h;
    const yaw = fig.object.rotation.y;
    const fx = Math.sin(yaw); const fz = Math.cos(yaw);
    const cx = fig.at.x + fx * fig.body.ahead; const cz = fig.at.z + fz * fig.body.ahead;
    out.ax = cx - fx * h; out.az = cz - fz * h; out.bx = cx + fx * h; out.bz = cz + fz * h;
    return out;
  }
  const _sa = {}; const _sb = {}; const _cp = {};
  let separateDt = 1 / 60;

  /** How far apart two bodies are, surface to surface (negative: overlapping), and the way out. */
  function gapBetween(a, b) {
    spine(a, _sa); spine(b, _sb);
    const d = segSeg(_sa.ax, _sa.az, _sa.bx, _sa.bz, _sb.ax, _sb.az, _sb.bx, _sb.bz, _cp);
    let nx = _cp.px - _cp.qx; let nz = _cp.pz - _cp.qz;
    if (d < 1e-4) { nx = a.at.x - b.at.x || 1e-3; nz = a.at.z - b.at.z; }
    const n = Math.hypot(nx, nz) || 1;
    _cp.nx = nx / n; _cp.nz = nz / n;
    return d - a.body.r - b.body.r;
  }

  /**
   * Bodies that overlap anyway -- the player walking into one, a crowd at a
   * door, a barn with seven beasts reset into it -- are eased apart, each as
   * the capsule it is. The dead are solid too: a live pig walked through a
   * dead one, because a corpse used to be nothing to step round.
   *
   * Easing apart is a slide, since no clip is playing to account for it, so
   * it is spent where it shows least. Whoever is walking gives way, and
   * someone standing does not -- at 0.25 m a frame the barn's grazing horses
   * slid backwards at 0.3-0.8 m/s. Two standing bodies still overlapping
   * drift apart at 4 cm/s and never backwards, and the one of them that is
   * not busy grazing goes somewhere else on its own feet.
   */
  function separate(fig, player) {
    if (fig.m.settle && fig.m.settle.phase !== 'go' && fig.m.settle.phase !== 'turn') return;
    const m = fig.m;
    neighbours(fig, near);
    const standing = (f) => f.m.speed < 0.15 && !f.m.climb;
    const still = standing(fig);
    let sx = 0; let sz = 0;
    let crowded = false;
    for (const o of near) {
      if (o.m.gone || o.level !== fig.level) continue;
      const gap = gapBetween(fig, o);
      if (gap >= 0.04) continue;
      // Someone settled on a bench, the dead and the standing hold their
      // ground against anyone walking.
      const settled = o.m.settle && o.m.settle.phase !== 'go';
      const firm = o.m.dead || settled || (standing(o) && !still);
      const share = firm ? 1 : (still && !standing(o) ? 0 : 0.5);
      if (!share) continue;
      if (still) crowded = true;
      const push = Math.min(0.25, (0.04 - gap) * share * 0.5);
      sx += _cp.nx * push; sz += _cp.nz * push;
    }
    let d = Math.hypot(sx, sz);
    if (d > 1e-5) {
      // Sideways or forwards only: nothing walks backwards. Someone walking
      // into a body that holds its ground is pushed back instead into the
      // brake -- measured, cows walking at 0.36 m/s were carried backwards at
      // 0.5 -- and a walk that stays blocked is given up (moveAlong's stuck).
      const fx = Math.sin(fig.object.rotation.y); const fz = Math.cos(fig.object.rotation.y);
      const back = sx * fx + sz * fz;
      if (back < 0) {
        sx -= back * fx; sz -= back * fz;
        if (!still) { m.speed = Math.max(0, m.speed + back * 4); m.stuck += separateDt * 0.5; }
      }
      d = Math.hypot(sx, sz);
      // And at a shuffle's pace -- a walker's deflection a little more, but
      // not once it is being held up.
      const most = (still ? 0.04 : (back < 0 ? 0.1 : 0.3)) * separateDt;
      if (d > most) { sx *= most / d; sz *= most / d; }
      const px = fig.at.x + sx; const pz = fig.at.z + sz;
      if (nav.sample(px, pz, fig.level)) { fig.at.x = px; fig.at.z = pz; }
    }
    // Still pressed against someone after a moment: walk off, if strolling
    // is all this one was doing -- a grazer after a longer moment.
    m.pressed = crowded ? (m.pressed || 0) + separateDt : 0;
    if (m.pressed > 0.4 && !m.path && !m.fighting && !m.dead && orderOf(fig).kind === 'stroll'
      && (!(m.graze && m.graze.w > 0.2) || m.pressed > 1.0)) {
      m.pressed = 0;
      m.wait = Math.min(m.wait, 0);
    }
    if (player) {
      const dx = fig.at.x - player.x; const dz = fig.at.z - player.z;
      const d = Math.hypot(dx, dz);
      const room = 0.42 + fig.body.r + fig.body.h * 0.5;
      if (d < room && d > 1e-4) {
        const push = (room - d) * 0.4;
        const px = fig.at.x + (dx / d) * push; const pz = fig.at.z + (dz / d) * push;
        if (nav.sample(px, pz, fig.level)) { fig.at.x = px; fig.at.z = pz; }
      }
    }
  }

  // -- travelling through archways and stairs ---------------------------------

  /**
   * Up or down a flight, tread by tread, at a climbing pace: the body turns
   * to each leg first, the way it does on the flat, and its feet ride the
   * tread under it (nav.stairY), eased so a riser is a step and not a jolt.
   * Nothing can interrupt it: a fight that starts on the stairs is fought at
   * the top or the bottom, where there is ground to stand on.
   */
  function tickClimb(fig, dt) {
    const m = fig.m;
    const c = m.climb;
    const target = c.pts[c.i];
    const dx = target.x - fig.at.x; const dz = target.z - fig.at.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.14) {
      c.i++;
      if (c.i >= c.pts.length) { finishClimb(fig); return; }
      return;
    }
    let yaw = fig.object.rotation.y;
    const err = wrap(Math.atan2(dx, dz) - yaw);
    if (Math.abs(err) > TURN_FIRST && m.speed < 0.3) {
      m.speed = Math.max(0, m.speed - DECEL * dt);
      fig.object.rotation.y = yaw + clamp(err, -TURN_STANDING * dt, TURN_STANDING * dt);
      m.turning = Math.sign(err);
      return;
    }
    m.turning = 0;
    yaw += clamp(err, -TURN_WALKING * dt, TURN_WALKING * dt);
    fig.object.rotation.y = yaw;
    // A 45-degree flight is climbed at about two-thirds of a walk.
    const want = Math.min(fig.pace * 0.7, Math.sqrt(2 * DECEL * d) + 0.2);
    m.speed += clamp(want - m.speed, -DECEL * dt, ACCEL * dt);
    const step = Math.min(d, m.speed * dt * Math.max(0, Math.cos(err)));
    fig.at.x += Math.sin(yaw) * step;
    fig.at.z += Math.cos(yaw) * step;
    const ground = nav.stairY(c.portal.flight, fig.at.x, fig.at.z);
    fig.at.y += (ground - fig.at.y) * Math.min(1, dt * 12);
    fig.home.y = fig.at.y;
    fig.level = nav.levelOf(fig.at.y);
  }

  function finishClimb(fig) {
    const m = fig.m;
    const p = m.climb.portal;
    m.climb = null;
    fig.at.y = p.arrive.y;
    fig.level = p.level;
    fig.home.y = p.arrive.y;
    m.path = p.after && p.after.length ? p.after.slice() : null;
    m.pi = 0;
    // Whatever order is standing now -- the journey's, or a fight that began
    // on the stairs -- takes over from here.
    m.stage = 'in';
    if (orderOf(fig).kind !== 'travel') { m.path = null; m.stage = null; }
  }

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
    // The walk comes in whole as soon as the body is really moving, played
    // as slowly as it has to be: a walk at half weight over a moving body
    // slides the planted foot by the other half of the speed.
    const moving = clamp((speed - 0.01) / 0.06, 0, 1);
    if (a.run) {
      const r = clamp((speed - fig.runFrom + 0.35) / 0.7, 0, 1);
      wRun = moving * r;
      wWalk = moving * (1 - r);
    } else wWalk = moving;
    // A turn on the spot is taken in steps, not on a turntable: a little walk
    // at a slow cadence reads as shifting the feet round.
    // (A rig with legs to plant turns on footwork instead: `footwork`.)
    if (!moving && m.turning && a.walk && !fig.bones) wWalk = 0.35;
    // Feet moving under a body that is not going anywhere: footwork in a
    // fight, the shuffle of sitting down.
    if (m.shuffle > 0 && a.walk && !(fig.bones && !m.fighting)) wWalk = Math.max(wWalk, m.shuffle);
    const still = Math.max(0, 1 - (wWalk + wRun));
    // Talking: in a conversation when it is this one's turn, or saying
    // something the game has put in its mouth.
    const settle = m.settle && m.settle.clip && m.settle.phase !== 'go' && m.settle.phase !== 'turn' ? m.settle : null;
    const talks = !!a.talk && !m.fighting && !settle
      && (m.speech > 0 || (m.talk && m.talk.phase === 'hold' && m.talk.conv && m.talk.conv.speaker === fig));
    let wTalk = 0;
    if (m.fighting && a.fight) wFight = still; else if (talks) wTalk = still; else wIdle = still;

    // Walking and running follow the speed exactly -- the speed is already
    // eased, and a walk faded in behind it is a planted foot sliding by the
    // part of the speed it does not carry. What the body does standing
    // (idle, idle2, guard, talk) crossfades as shares of the rest.
    const want = { idle: 0, idle2: 0, fight: 0, talk: 0 };
    const pastimes = fig.pastimes || [];
    for (const name of pastimes) want[name] = 0;
    const doing = m.graze && m.graze.name;
    if (wFight > 0) want.fight = 1; else if (wTalk > 0) want.talk = 1;
    else if (doing && m.graze.want) want[doing] = 1;
    else want[m.idle === 'idle2' && a.idle2 ? 'idle2' : 'idle'] = 1;
    const base = m.base || (m.base = { idle: 1 });
    // A head goes down to the grass and comes up again over a second or so,
    // not in the snap that suits a change of stance: each pastime eases in
    // and out at its own rate.
    const easing = doing && (want[doing] || base[doing] > 0.01) ? PASTIMES[doing].rate : 7;
    const rate = Math.min(1, dt * easing);
    let shares = 0;
    for (const name of ['idle', 'idle2', 'fight', 'talk', ...pastimes]) {
      if (!a[name]) { base[name] = 0; continue; }
      const w = base[name] || 0;
      base[name] = w + (want[name] - w) * rate;
      shares += base[name];
    }
    // Anything that has no clip of its own falls back onto idle, so the sum holds.
    if (shares < 1e-3) { base.idle = 1; shares = 1; }
    const total = shares;
    // Seated or against a wall on the rig's own clip: that clip, at exactly
    // the weight the settling says, and the standing loops under the rest.
    const held = settle ? (settle.clip === 'sit' ? m.sitW : m.leanW) : 0;
    for (const name of [...LOOP, ...pastimes]) {
      if (!a[name]) continue;
      const w = name === 'walk' ? wWalk : name === 'run' ? wRun : ((base[name] || 0) / total) * still;
      a[name].setEffectiveWeight(w * (1 - over) * (1 - held));
    }
    for (const name of ['sit', 'lean']) {
      if (a[name]) a[name].setEffectiveWeight(settle && settle.clip === name ? held * (1 - over) : 0);
    }
    if (settle && settle.clip === 'sit' && a.sit) {
      // The sit loops on its rest unless a drink is due; then it runs on
      // through the cup and comes round to its first frame again.
      const t = a.sit.time;
      if (m.sip && t < (m.sitPrev ?? 0)) m.sip = false;
      if (!m.sip && t > REST_LOOP) a.sit.time = t - REST_LOOP;
      m.sitPrev = a.sit.time;
    }
    // A layer on part of the body: fade in, hold, fade out, as a share of
    // those bones. Its weight is share / (1 - share) because the loops under
    // it already sum to one on the same bones, and three normalises.
    const L = m.layer;
    if (L) {
      L.t += dt;
      if (L.until === Infinity && !(m.speech > 0)) L.until = L.t + 0.35;
      const env = Math.min(1, L.t / 0.3, Math.max(0, (L.until - L.t) / 0.35));
      const share = env * L.gain;
      L.action.setEffectiveWeight(share / (1 - share));
      if (L.t >= L.until) { L.action.setEffectiveWeight(0); L.action.stop(); m.layer = null; }
    } else if (settle && m.speech > 0 && a.talk) {
      playLayer(fig, 'talk', UPPER, { loop: true, gain: 0.85 });
    }

    // Feet that match the ground. timeScale is ground speed over the speed
    // the clip was authored at, which is its stride over its length.
    if (a.walk) a.walk.timeScale = wWalk > 0 ? clamp((speed > 0.02 ? speed : 0.35) / walkRate, 0.02, 2.4) : 1;
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

  /**
   * `until`, a fraction of the clip, cuts it short with its usual fade-out:
   * the first half of a swing, pulled back, is a feint; a third of a cast is
   * a hand raised to make a point.
   */
  function playOnce(fig, name, { timeScale = 1, hold = false, gain = 1, from = 0, until = 1 } = {}) {
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
    m.overlay = { action, name, t: from, duration: fig.clips[name] * until, hold, gain };
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
        if (m.sway.back) {
          const b = Math.sin(u * Math.PI) * m.sway.back;
          ox -= fx * b; oz -= fz * b; pitch -= b * 0.9;
        }
      }
    }
    if (m.step) {
      // Footwork: a half step in or out and back again, on the feet.
      m.step.t += dt;
      const u = m.step.t / m.step.dur;
      if (u >= 1) { m.step = null; m.shuffle = 0; } else {
        const s = Math.sin(u * Math.PI);
        ox += fx * s * m.step.along; oz += fz * s * m.step.along;
        pitch += s * m.step.along * 0.35;
        m.shuffle = s * 0.6;
      }
    }
    if (m.fighting && !m.dead) {
      // A fighter's weight is never still between blows: it rocks from foot
      // to foot and the guard bobs with it.
      m.stance += dt;
      const ph = m.stance + (fig.seed || 0) % 7;
      roll += Math.sin(ph * 2.3) * 0.035;
      pitch += Math.sin(ph * 1.7 + 1.1) * 0.025;
    }
    if (m.leanW > 0) pitch -= 0.1 * m.leanW;
    // Elbows on the bar; a little toward the fire.
    if (m.barW > 0) pitch += (m.settle && m.settle.spot.kind === 'bar' ? 0.09 : 0.04) * m.barW;
    m.offset.x = ox; m.offset.z = oz;
    fig.pitch = pitch; fig.roll = roll;
  }

  /**
   * Between blows. Merc swings once a round, every three seconds, and a body
   * that holds its guard pose for the two and a half seconds in between
   * reads as a statue waiting for its turn. So the time before the next
   * swing (`m.swingIn`, from fx.js's pulse clock) is filled: a feint -- the
   * wind-up of a swing, checked; the guard shifting; a half step in or out;
   * a step round to one side, which is a real move -- the body circles.
   * Nothing is started that would still be running when the real swing is due.
   */
  function fidget(fig, dt) {
    const m = fig.m;
    if (m.step && m.step.side) {
      // The sidestep carries the body round, a little each frame.
      const yaw = fig.object.rotation.y;
      const v = (m.step.side / m.step.dur) * dt;
      const nx = fig.at.x + Math.cos(yaw) * v; const nz = fig.at.z - Math.sin(yaw) * v;
      if (nav.sample(nx, nz, fig.level)) { fig.at.x = nx; fig.at.z = nz; }
    }
    if (m.step && m.step.back) {
      const v = (m.step.back / m.step.dur) * dt;
      const nx = fig.at.x + m.step.dx * v; const nz = fig.at.z + m.step.dz * v;
      if (nav.sample(nx, nz, fig.level)) { fig.at.x = nx; fig.at.z = nz; }
    }
    if (m.overlay || m.pending || m.lunge || m.step || m.sway || m.recoil || m.speed > 0.05) return;
    m.nextFidget -= dt;
    if (m.nextFidget > 0) return;
    m.nextFidget = 0.3 + fig.rand() * 0.5;
    const free = m.swingIn;
    const a = fig.actions || {};
    const r = fig.rand();
    if (free > 1.0 && r < 0.26 && a.attack) {
      const name = bareHanded(fig, a.attack2 && fig.rand() < 0.5 ? 'attack2' : 'attack');
      const dur = fig.clips[name];
      const hit = ((fig.hitFrame && fig.hitFrame[name]) ?? 0.4) * dur;
      playOnce(fig, name, { gain: 0.72, until: (hit * 0.5 + 0.22) / dur });
      return;
    }
    if (free > 0.8 && r < 0.45 && a.block) {
      playOnce(fig, 'block', { gain: 0.5, timeScale: 0.85 });
      return;
    }
    if (free > 0.75 && (a.walk || fig.legs)) {
      const sideways = r > 0.8;
      const dir = fig.rand() < 0.5 ? -1 : 1;
      m.step = sideways
        ? { t: 0, dur: 0.6 + fig.rand() * 0.2, along: 0, side: dir * (0.25 + fig.rand() * 0.15) }
        : { t: 0, dur: 0.5 + fig.rand() * 0.2, along: dir * (0.16 + fig.rand() * 0.1), side: 0 };
    }
  }

  /**
   * Sitting and leaning, laid over whatever the clips posed: the rigs carry
   * no sit clip, so the legs are folded here, after the mixer, about each
   * bone's own hinge (measured once per rig by `measureSit`), and the body
   * is lowered until the hips meet the seat. The idle underneath keeps
   * breathing; only the legs and the height are this.
   */
  function posture(fig) {
    const m = fig.m;
    const b = fig.bones;
    if (!fig.sitGeo) fig.sitGeo = measureSit(fig, b);
    const g = fig.sitGeo;
    if (m.sitW > 0.001) {
      const w = m.sitW;
      const spot = m.settle && m.settle.spot;
      const seat = spot && spot.seat ? spot.seat : 0.48;
      const hip = 1.42 * w;
      for (const [thigh, shin] of [[b.thighL, b.shinL], [b.thighR, b.shinR]]) {
        thigh.quaternion.multiply(_qa.setFromAxisAngle(_xAxis, g.thighSign * hip));
        shin.quaternion.multiply(_qa.setFromAxisAngle(_xAxis, g.kneeSign * hip * 1.02));
      }
      // Hips down onto the seat: from standing hip height to the seat and
      // the width of the pelvis above it.
      m.drop = Math.max(0, g.hipY - (seat + 0.09)) * w;
    } else m.drop = 0;
    if (m.leanW > 0.001) {
      // One heel back against the wall behind.
      const w = m.leanW;
      b.thighR.quaternion.multiply(_qa.setFromAxisAngle(_xAxis, g.thighSign * 0.42 * w));
      b.shinR.quaternion.multiply(_qa.setFromAxisAngle(_xAxis, g.kneeSign * 1.25 * w));
    }
  }

  /**
   * Feet that stay where they were put. A body turning on the spot used to
   * tread a slow walk under itself -- the planted foot slid back at 0.25-0.28
   * m/s, measured -- and one being nudged by a crowd slid bodily. Now each
   * foot is held where it last landed, and when the clip wants it more than
   * FOOT_STEP away it is picked up and put down there, one foot at a time.
   */
  const FOOT_STEP = 0.09;
  const _d0 = new THREE.Vector3();
  const _d1 = new THREE.Vector3();
  const _dq0 = new THREE.Quaternion();
  const _dq1 = new THREE.Quaternion();
  function footwork(fig, dt) {
    const m = fig.m;
    const b = fig.bones;
    // A gesture over the stance (a cast, a peck of the hand) leaves the feet
    // where they are; a blow, a flinch or a fall moves them itself.
    const busy = m.overlay && ONE_SHOT.has(m.overlay.name);
    const standing = !m.dead && !m.climb && !m.fighting && !busy && m.speed < 0.05
      && !(m.settle && m.settle.clip) && m.stage !== 'out' && m.stage !== 'in';
    let F = m.feet;
    if (!standing) {
      if (!F) return;
      F.w -= dt / 0.15;
      if (F.w <= 0) { m.feet = null; return; }
    }
    fig.object.updateMatrixWorld(true);
    const D = [b.footL.getWorldPosition(_d0), b.footR.getWorldPosition(_d1)];
    const DQ = [b.footL.getWorldQuaternion(_dq0), b.footR.getWorldQuaternion(_dq1)];
    if (!F) { m.feet = { P: [D[0].clone(), D[1].clone()], Q: [DQ[0].clone(), DQ[1].clone()], step: null, w: 1 }; return; }
    if (standing) {
      if (!F.step) {
        // Out of place by a step's length, or turned by a third of a right
        // angle: that foot is picked up.
        let worst = -1; let most = 1;
        for (let i = 0; i < 2; i++) {
          const e = Math.max(Math.hypot(F.P[i].x - D[i].x, F.P[i].z - D[i].z) / (FOOT_STEP * (fig.scale || 1)), F.Q[i].angleTo(DQ[i]) / 0.5);
          if (e > most) { most = e; worst = i; }
        }
        if (worst >= 0) F.step = { i: worst, from: F.P[worst].clone(), fromQ: F.Q[worst].clone(), t: 0, dur: 0.26 + fig.rand() * 0.06 };
      }
      if (F.step) {
        const st = F.step;
        st.t += dt;
        const u = clamp(st.t / st.dur, 0, 1);
        F.Q[st.i].slerpQuaternions(st.fromQ, DQ[st.i], smooth(u));
        F.P[st.i].lerpVectors(st.from, D[st.i], smooth(u));
        F.P[st.i].y += 0.07 * (fig.scale || 1) * Math.sin(Math.PI * u);
        if (u >= 1) F.step = null;
      }
    }
    // A planted foot keeps the clip's own height: heel lifts, weight shifts.
    let off = 0;
    for (let i = 0; i < 2; i++) {
      if (!F.step || F.step.i !== i) F.P[i].y = D[i].y;
      off = Math.max(off, F.P[i].distanceTo(D[i]), F.Q[i].angleTo(DQ[i]) * 0.1);
    }
    if (off < 0.004) return;
    legIK(b.thighL, b.shinL, b.footL, F.P[0], F.w, F.Q[0]);
    legIK(b.thighR, b.shinR, b.footR, F.P[1], F.w, F.Q[1]);
  }

  /**
   * After the figure is placed: the legs of a body settling on its clips
   * held to where the feet go (`legIK`), and a listener's nod on the head.
   */
  function finishPose(fig, dt, close) {
    const m = fig.m;
    const b = fig.bones;
    if (close && b.footR) footwork(fig, dt); else m.feet = null;
    if (m.ik && m.ik.w > 0 && m.settle && m.settle.clip) {
      fig.object.updateMatrixWorld(true);
      const q = m.ik.q; const qw = m.ik.qw;
      legIK(b.thighL, b.shinL, b.footL, m.ik.feet[0], m.ik.w, q && q[0], qw ? qw[0] : 0);
      legIK(b.thighR, b.shinR, b.footR, m.ik.feet[1], m.ik.w, q && q[1], qw ? qw[1] : 0);
    }
    // The head comes round to whoever it is attending to -- the one
    // speaking at the table, the partner in a conversation -- within what a
    // neck allows, and back to the front when there is no one.
    let want = 0;
    if (m.lookAt && m.lookAt.at && !m.dead) {
      want = clamp(wrap(Math.atan2(m.lookAt.at.x - fig.at.x, m.lookAt.at.z - fig.at.z) - fig.object.rotation.y), -1.1, 1.1);
    }
    m.headYaw = (m.headYaw || 0) + clamp(want - (m.headYaw || 0), -2.5 * dt, 2.5 * dt);
    if (Math.abs(m.headYaw) > 0.005 && b.head) {
      if (!b.neck) b.neck = b.head.parent;
      turnWorld(b.neck, _qw.setFromAxisAngle(_yAxis, m.headYaw * 0.4));
      turnWorld(b.head, _qw.setFromAxisAngle(_yAxis, m.headYaw * 0.6));
    }
    if (m.nod) {
      const n = m.nod;
      n.t += dt;
      const u = n.t / n.dur;
      if (u >= (n.twice ? 2 : 1)) m.nod = null;
      else {
        const g = fig.poses || (fig.poses = measurePoses(fig, b));
        b.head.quaternion.multiply(_qa.setFromAxisAngle(_xAxis, g.nodSign * n.amp * Math.sin(Math.PI * (u % 1)) * (u > 1 ? 0.6 : 1)));
      }
    }
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
    name = bareHanded(fig, name);
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

  /**
   * `attack` is an overhead chop, made round a weapon's haft. With nothing in
   * the hand it is a bare forearm raised straight up over the head, and on a
   * rotting zombie in a torn-off sleeve that thin raised arm read as a bow
   * being carried. Someone with nothing in their hand swings `attack2`, the
   * low driving blow, which reads as a fist or a claw.
   */
  function bareHanded(fig, name) {
    if (name !== 'attack' || !fig.castPoint || !fig.actions || !fig.actions.attack2) return name;
    return fig.weapon && fig.weapon.visible ? name : 'attack2';
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
    } else if (kind === 'evade') {
      // A blow that simply missed: not a dodge, just the body swaying back
      // off the line and a half step, so the whiff has something to miss.
      fig.m.sway = { t: 0, side: (fig.rand() < 0.5 ? -1 : 1) * 0.55, back: 0.12 };
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
    // Everything else stops, weights and all: a swing still pending when the
    // killing blow landed used to start on the corpse and cut the fall off,
    // and a stopped action kept reading 1.0 to anything that asked.
    if (m.overlay) { m.overlay.action.setEffectiveWeight(0); m.overlay.action.stop(); }
    m.overlay = null;
    m.pending = null;
    if (m.calls) { const calls = m.calls; m.calls = null; for (const c of calls) c.fn(); }
    if (m.settle) { m.settle.spot.by = null; m.settle = null; }
    stow(fig, false);
    if (m.talk) endTalk(fig);
    m.climb = null; m.step = null; m.shuffle = 0; m.sitW = 0; m.leanW = 0; m.barW = 0; m.drop = 0;
    m.ik = null; m.nod = null; m.speech = 0;
    if (m.layer) { m.layer.action.setEffectiveWeight(0); m.layer.action.stop(); m.layer = null; }
    m.path = null; m.speed = 0; m.lunge = null; m.recoil = null; m.sway = null;
    if (fig.actions) {
      for (const [name, action] of Object.entries(fig.actions)) {
        if (name !== 'death' && ONE_SHOT.has(name)) { action.setEffectiveWeight(0); action.stop(); }
      }
    }
    const clip = playOnce(fig, 'death', { hold: true });
    m.dead = { t: 0, clip, side: fig.rand() < 0.5 ? -1 : 1 };
  }

  // -- the frame --------------------------------------------------------------------

  const RANGE = 46;
  const _player = { x: 0, z: 0 };

  function update(dt, camera) {
    _player.x = camera.position.x; _player.z = camera.position.z;
    const player = _player;

    // Who is near whom, for the ones worth steering.
    rebuildGrid();

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

      if (m.pending && !m.dead) {
        m.pending.at -= dt;
        if (m.pending.at <= 0) {
          playOnce(fig, m.pending.name, { timeScale: m.pending.speed || 1, from: m.pending.from || 0 });
          m.pending = null;
        }
      }

      // The half of the world that is not being drawn (build.js's zones):
      // a figure in the sewer is not animated from the Market Square, which
      // is where 115 of its draw calls were going.
      const unseen = zones && (fig.level < 0 ? !zones.deep.visible : !zones.surface.visible);
      if (far || unseen) {
        // Out of sight a walk is only a position moving along a line: no
        // mixer, no steering, nobody to step round.
        fig.object.visible = false;
        coast(fig, dt);
        placeObject(fig);
        continue;
      }
      fig.object.visible = true;

      // Turning is this frame's news or none: steer (or the climb) sets it
      // when a body really is coming round. Left standing from the last
      // frame it steered, it held a 0.35 walk under figures that were
      // sitting, fading through an arch, or just standing -- feet treading
      // the spot.
      m.turning = 0;
      if (!m.dead) {
        if (m.climb) tickClimb(fig, dt);
        else {
          think(fig, dt, player);
          portalStep(fig, dt);
          const settling = m.settle && m.settle.phase !== 'go' && tickSettle(fig, dt);
          if (m.stage !== 'out' && (!settling || (m.settle && m.settle.phase === 'turn'))) steer(fig, dt, player);
          separateDt = dt;
          separate(fig, player);
        }
        // A figure that stopped fading half-way -- turned on while walking
        // into an archway, and a fight is not a journey -- comes back solid.
        // It used to stay at 0.54 opacity and fight as a ghost.
        const through = orderOf(fig).kind === 'travel' && (m.stage === 'out' || m.stage === 'in');
        if (!through && !m.gone && m.fade < 1) setOpacity(fig, Math.min(1, m.fade + dt / 0.3));
        if (m.fighting) fidget(fig, dt);
      }
      tickOffsets(fig, dt);
      tickDeath(fig, dt);
      if (fig.legs) animateLegs(fig, dt);
      else animate(fig, dt);
      if (!fig.bones && fig.mixer) animalLife(fig, dt);
      if (fig.mixer) fig.mixer.update(dt);
      if (!fig.bones && m.graze && !(fig.pastimes && fig.pastimes.length)) lowerHead(fig);
      const clipped = m.settle && m.settle.clip;
      if (!clipped) {
        if (fig.bones && (m.sitW > 0.001 || m.leanW > 0.001)) posture(fig); else m.drop = 0;
      }
      if (m.speech > 0) m.speech -= dt;
      fig.walking = m.speed > 0.16;
      // Up and down a temple's mound with the ground under it (nav.moundY).
      if (nav.moundY) {
        const g = nav.moundY(fig.at.x, fig.at.z, fig.level);
        if (g !== null) { fig.at.y = g; m.onMound = true; } else if (m.onMound) { fig.at.y = fig.level * nav.LEVEL_H; m.onMound = false; }
      }
      placeObject(fig);
      if (!fig.bones && fig.mixer) gaze(fig, dt, player);
      if (fig.bones) finishPose(fig, dt, dx * dx + dz * dz < 36 * 36);
    }
  }

  function placeObject(fig) {
    const m = fig.m;
    fig.object.position.set(
      fig.at.x + m.offset.x,
      fig.at.y + (fig.lift || 0) - (fig.sink || 0) - m.drop,
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
    if (m.climb) {
      // Nobody is watching the stairs either.
      fig.at.x = m.climb.portal.arrive.x; fig.at.z = m.climb.portal.arrive.z;
      finishClimb(fig);
    }
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

  // -- trades and habits ---------------------------------------------------------

  /**
   * A guard on watch keeps its post: facing out from the wall behind it, the
   * head and shoulders coming round to one side and the other and back, the
   * weight going from foot to foot -- and now and then a few paces and back,
   * or a lean on the wall beside the post. Returns false when it is time for
   * the pacing, which is planStroll's.
   */
  function watch(fig) {
    const m = fig.m;
    const home = fig.homeSpot || fig.at;
    if (m.post === undefined) {
      const w = nav.wallNear(home.x, home.z, fig.level, 3.5);
      m.post = w ? Math.atan2(w.nx, w.nz) : fig.object.rotation.y;
    }
    const r = fig.rand();
    if (Math.hypot(home.x - fig.at.x, home.z - fig.at.z) > 0.9 || r < 0.12) return false;
    if (r < 0.2 && canSettle(fig)) return planActivity(fig, orderOf(fig));
    m.turnTo = m.post + (fig.rand() < 0.4 ? 0 : (fig.rand() < 0.5 ? -1 : 1) * (0.45 + fig.rand() * 0.55));
    if (fig.actions && fig.actions.idle2 && fig.rand() < 0.35) m.idle = m.idle === 'idle2' ? 'idle' : 'idle2';
    m.wait = 2.5 + fig.rand() * 4.5;
    return true;
  }

  /**
   * A shopkeeper with nobody at the counter is not a statue behind it: turned
   * to the shelves reaching something down, busy with the hands at the
   * counter, and a smith at the hammer -- the upper body of the rig's own
   * swing, slowed to a smith's beat, laid over the stance.
   */
  const SMITH = /smith|armou?rer|farrier/i;
  function work(fig, dt, order) {
    const m = fig.m;
    if (m.holdYaw === undefined) m.holdYaw = order.yaw ?? fig.object.rotation.y;
    const w = m.work;
    if (w && (w.t += dt) < w.until) {
      m.turnTo = w.yaw;
      if (w.kind === 'hammer' && !m.layer && Math.abs(wrap(w.yaw - fig.object.rotation.y)) < 0.2) {
        playLayer(fig, 'attack', UPPER, { timeScale: 0.62, gain: 0.9, loop: true });
        if (m.layer) m.layer.until = w.until - w.t;
      }
      if (w.kind === 'shelf' && !w.reached && Math.abs(wrap(w.yaw - fig.object.rotation.y)) < 0.2) {
        w.reached = true;
        playLayer(fig, 'cast', UPPER, { from: 0, to: fig.clips.cast * 0.45, timeScale: 0.55, gain: 0.8 });
      }
      return;
    }
    const smith = SMITH.test((fig.interactable && fig.interactable.title) || '') || fig.archetype === 'smith';
    const r = fig.rand();
    const back = m.holdYaw + Math.PI;
    if (smith && r < 0.6 && fig.actions.attack) m.work = { kind: 'hammer', t: 0, until: 4 + fig.rand() * 5, yaw: m.holdYaw + (fig.rand() - 0.5) * 0.5 };
    else if (r < 0.4 && fig.actions.cast) m.work = { kind: 'shelf', t: 0, until: 3.5 + fig.rand() * 2, yaw: back + (fig.rand() - 0.5) * 0.8 };
    else if (r < 0.75 && fig.actions.talk) {
      m.work = { kind: 'hands', t: 0, until: 3 + fig.rand() * 3, yaw: m.holdYaw + (fig.rand() - 0.5) * 0.7 };
      playLayer(fig, 'talk', UPPER, { gain: 0.55, timeScale: 0.7, loop: true });
      if (m.layer) m.layer.until = m.work.until;
    } else {
      m.work = { kind: 'look', t: 0, until: 2.5 + fig.rand() * 4, yaw: m.holdYaw + (fig.rand() - 0.5) * 1.4 };
      if (fig.actions.idle2) m.idle = m.idle === 'idle2' ? 'idle' : 'idle2';
    }
  }

  function endWork(fig) {
    fig.m.work = null;
    if (fig.m.layer && fig.m.layer.until === Infinity) fig.m.layer.until = fig.m.layer.t + 0.35;
    else if (fig.m.layer) fig.m.layer.until = Math.min(fig.m.layer.until, fig.m.layer.t + 0.35);
  }

  /**
   * Animals at ease: a grazing beast's head goes down to the grass and comes
   * up to look round, a dog's to the ground to sniff; birds peck. The beasts
   * carry no graze clip, so the neck is bent here, after the mixer, about
   * each bone's own hinge (the sign measured once per rig). A cow's neck is
   * too short in the model to reach the grass -- its jaw comes down from
   * 1.02 m to 0.84 -- so on cattle this reads as a head lowered; a pig's
   * snout and a dog's nose reach the ground. A bird's `attack` is a peck.
   */
  // A rig with a `graze` clip of its own (beasts.py: the horse, the deer, the
  // cow, the pig, the camel) plays that instead, head on the grass, chewing;
  // the bend here is for the rest.
  const GRAZERS = /^(bovine|pig)$/;
  const SNIFFERS = /^(canine|rodent|bear)$/;
  const PECKERS = /^(fowl|songbird|waterfowl)$/;
  function measureGraze(fig, grazer) {
    const necks = []; let head = null;
    fig.object.traverse((n) => {
      if (!n.isBone) return;
      if (/^neck\d*$/.test(n.name)) necks.push(n);
      else if (n.name === 'head') head = n;
    });
    if (!head || !necks.length) return null;
    // Only the neck bones carry the head down (turning the head only aims
    // the muzzle), mostly at the base, and the chest is left alone: the
    // forelegs hang from it. Which way is down is measured once per rig.
    const root = fig.object;
    const saved = necks[0].quaternion.clone();
    const y0 = root.worldToLocal(head.getWorldPosition(new THREE.Vector3())).y;
    necks[0].quaternion.multiply(_qa.setFromAxisAngle(_xAxis, 0.3));
    root.updateMatrixWorld(true);
    const sign = root.worldToLocal(head.getWorldPosition(new THREE.Vector3())).y < y0 ? 1 : -1;
    necks[0].quaternion.copy(saved);
    root.updateMatrixWorld(true);
    const share = (i) => (necks.length === 1 ? 1 : (i === 0 ? 0.75 : 0.25 / (necks.length - 1)));
    return { necks, head, angle: sign * (grazer ? 1.0 : 0.8), tilt: sign * 0.25, share };
  }

  function animalLife(fig, dt) {
    const m = fig.m;
    const kind = fig.archetype || '';
    const still = !m.path && m.speed < 0.05 && !m.fighting && !m.dead && !m.overlay && orderOf(fig).kind === 'stroll';
    const own = fig.pastimes && fig.pastimes.length ? fig.pastimes : null;
    // Standing its ground and turned to you (game.js's notice is a 'hold'):
    // no time for a pastime, but exactly the moment for a display.
    const startled = still || (!m.path && m.speed < 0.05 && !m.fighting && !m.dead && !m.overlay && orderOf(fig).kind === 'hold');
    if (PECKERS.test(kind) && fig.actions && fig.actions.attack && !fig.afloat && !/swan|goose/i.test(fig.interactable ? fig.interactable.title : '')) {
      // A bird with pastimes of its own pecks in the gaps between them.
      if (own) {
        pastimeLife(fig, dt, still, own, startled);
        if (m.graze && (m.graze.want || m.graze.w > 0.05)) return;
      }
      if (!still) return;
      m.peck = (m.peck ?? 1 + fig.rand() * 3) - dt;
      if (m.peck <= 0) {
        playOnce(fig, 'attack', { gain: 0.85, timeScale: 1.15 });
        // Pecks come in runs, with a look round between.
        m.peck = fig.rand() < 0.6 ? 0.55 + fig.rand() * 0.4 : 2 + fig.rand() * 4;
      }
      return;
    }
    if (own) return pastimeLife(fig, dt, still, own, startled);
    const grazer = GRAZERS.test(kind); const sniffer = SNIFFERS.test(kind);
    if (!grazer && !sniffer) return;
    if (fig.graze === undefined) fig.graze = measureGraze(fig, grazer);
    if (!fig.graze) return;
    const g = m.graze || (m.graze = { w: 0, want: 0, next: fig.rand() * 3 });
    g.next -= dt;
    if (!still) g.want = 0;
    else if (g.next <= 0) {
      g.want = g.want ? 0 : (grazer ? 1 : 0.8);
      g.next = g.want ? (grazer ? 5 + fig.rand() * 10 : 1.5 + fig.rand() * 2.5) : (grazer ? 2.5 + fig.rand() * 4 : 3 + fig.rand() * 6);
    }
    g.w += clamp(g.want - g.w, -dt * 1.1, dt * 1.1);
  }

  /**
   * A rig with pastimes of its own: stand a while, take one up -- chosen by
   * its odds, never the same display twice running -- keep at it, stop. Its
   * clip is weighted in by animate() as a share of standing still; moving
   * off or a fight puts it down at once.
   */
  function pastimeLife(fig, dt, still, own, startled = still) {
    const m = fig.m;
    const g = m.graze || (m.graze = { w: 0, want: 0, next: 0.5 + fig.rand() * 3, name: null });
    g.next -= dt;
    // Startled: someone coming close sets it off at once -- see ALARM.
    // The mobile's own prose can say otherwise: an alley cat that 'hisses at
    // you' does, a cat in general does not.
    const temper = fig.temper;
    const alarm = temper && temper.alarm !== undefined ? temper.alarm : ALARM[fig.archetype];
    if (alarm && fig.actions[alarm[0]]) {
      const near = Math.hypot(_player.x - fig.at.x, _player.z - fig.at.z) < alarm[1] * (fig.scale || 1);
      m.alarmed = Math.max(0, (m.alarmed || 0) - dt);
      if (near && !m.wasNear && startled && m.alarmed <= 0 && g.name !== alarm[0]) {
        const action = fig.actions[alarm[0]];
        action.time = 0;
        g.name = alarm[0];
        g.want = 1;
        g.next = action.getClip().duration;
        m.alarmed = 8;
      }
      m.wasNear = near;
    }
    // A display already under way plays out while it stands its ground.
    const showing = g.want && PASTIMES[g.name] && PASTIMES[g.name].once && startled && g.name === (alarm && alarm[0]);
    if (!still && !showing) { if (g.want) g.next = Math.max(g.next, 0.6 + fig.rand()); g.want = 0; }
    else if (g.next <= 0) {
      if (g.want) {
        g.want = 0;
        const p = PASTIMES[g.name];
        g.next = p.gap[0] + fig.rand() * (p.gap[1] - p.gap[0]);
      } else {
        let total = 0;
        const odds = own.map((n) => {
          const o = PASTIMES[n].odds * (PASTIMES[n].once && n === g.name ? 0.25 : 1) * ((temper && temper.odds && temper.odds[n]) ?? 1);
          total += o;
          return o;
        });
        let r = fig.rand() * total;
        let pick = null;
        for (let i = 0; i < own.length; i++) { if (odds[i] <= 0) continue; pick = own[i]; r -= odds[i]; if (r <= 0) break; }
        if (!pick) { g.next = 2 + fig.rand() * 4; g.w += clamp(-g.w, -dt, dt); return; }
        const p = PASTIMES[pick];
        const action = fig.actions[pick];
        // A loop picks up wherever it is; a display starts at its beginning
        // and lasts exactly as long as it does.
        if (p.once) action.time = 0;
        else if (g.name !== pick) action.time = fig.rand() * action.getClip().duration;
        g.name = pick;
        g.want = 1;
        g.next = p.once ? action.getClip().duration : p.hold[0] + fig.rand() * (p.hold[1] - p.hold[0]);
      }
    }
    const rate = g.name ? PASTIMES[g.name].rate : 1.1;
    g.w += clamp(g.want - g.w, -dt * rate, dt * rate);
  }

  /**
   * An animal that has seen you keeps an eye on you: within a few metres and
   * not behind it, the head comes round towards you -- most of the turn in
   * the neck, the rest in the head -- and goes back when you leave. The fox
   * "is here staring at you", the wolf snarling at you and the bear growling
   * at you; so do the deer. Laid on after the mixer, about world up, so it
   * holds through whatever the clip is doing with the head.
   */
  const GAZE_RANGE = 7;
  const GAZE_MOST = 1.05;
  function gaze(fig, dt, player) {
    const m = fig.m;
    if (fig.gazeBones === undefined) {
      const necks = []; let head = null;
      fig.object.traverse((n) => {
        if (!n.isBone) return;
        if (/^neck\d*$/.test(n.name)) necks.push(n);
        else if (n.name === 'head') head = n;
      });
      fig.gazeBones = head ? { head, neck: necks[0] || null } : null;
    }
    if (!fig.gazeBones) return;
    const dx = player.x - fig.at.x; const dz = player.z - fig.at.z;
    const d = Math.hypot(dx, dz);
    const busy = m.dead || m.fighting || m.speed > 0.6 || (m.graze && m.graze.w > 0.3) || m.overlay;
    let want = 0;
    if (!busy && d < GAZE_RANGE && d > 0.4) {
      const off = wrap(Math.atan2(dx, dz) - fig.object.rotation.y);
      // Behind it, it has not seen you.
      if (Math.abs(off) < 2.0) want = clamp(off, -GAZE_MOST, GAZE_MOST);
    }
    const now = m.gaze || 0;
    m.gaze = now + clamp(want - now, -dt * 2.4, dt * 2.4);
    if (Math.abs(m.gaze) < 1e-3) return;
    const { head, neck } = fig.gazeBones;
    fig.object.updateMatrixWorld(true);
    if (neck) turnWorld(neck, _qa.setFromAxisAngle(_yAxis, m.gaze * 0.6));
    turnWorld(head, _qa.setFromAxisAngle(_yAxis, m.gaze * (neck ? 0.4 : 1)));
  }

  /** The bend `animalLife` asked for, on the neck the mixer has just posed. */
  function lowerHead(fig) {
    const g = fig.m.graze;
    if (!g || g.w < 0.001 || !fig.graze) return;
    const k = smooth(g.w);
    fig.graze.necks.forEach((b, i) => b.quaternion.multiply(_qa.setFromAxisAngle(_xAxis, fig.graze.angle * k * fig.graze.share(i))));
    fig.graze.head.quaternion.multiply(_qa.setFromAxisAngle(_xAxis, fig.graze.tilt * k));
  }

  // -- the room as you find it ---------------------------------------------------

  /**
   * Arriving in a tavern should find it already sat in, and a square with
   * people already talking in it -- not everyone standing where the reset
   * ring put them and only then walking to a bench. Most of those who can
   * settle start settled, part-way through their stay; of the rest, pairs
   * who are near each other start in conversation.
   */
  function openingScene() {
    // A shopkeeper whose room has a counter keeps it from behind. The game
    // reads its home off `at` after this, so that is where it holds.
    for (const spot of keeperSpots) {
      const room = nav.roomAt(spot.x, spot.y, spot.z);
      const keeper = figures.find((f) => f.shop && !spot.by && nav.roomAt(f.at.x, f.at.y, f.at.z) === room);
      if (!keeper) continue;
      spot.by = keeper;
      keeper.at.x = spot.x; keeper.at.z = spot.z;
      keeper.object.rotation.y = spot.yaw;
      keeper.m.holdYaw = spot.yaw;
      if (keeper.homeSpot) { keeper.homeSpot.x = spot.x; keeper.homeSpot.z = spot.z; }
    }
    for (const fig of figures) {
      if (!canSettle(fig) || onWatch(fig) || fig.rand() > 0.72) continue;
      const room = nav.roomAt(fig.at.x, fig.at.y, fig.at.z);
      const list = spotsByRoom.get(room);
      if (!list) continue;
      const free = list.filter((sp) => !sp.by && sp.kind !== 'stand');
      if (!free.length) continue;
      const spot = free[Math.floor(fig.rand() * free.length)];
      spot.by = fig;
      const m = fig.m;
      fig.at.x = spot.approach.x; fig.at.z = spot.approach.z;
      fig.object.rotation.y = spot.yaw;
      m.settle = { spot, phase: 'down', t: 0, from: { x: fig.at.x, z: fig.at.z } };
      stow(fig, true);
      beginClip(fig);
      if (m.settle.clip) {
        m.settle.t = m.settle.dur;
        tickClip(fig, 0);
      } else {
        fig.at.x = spot.x; fig.at.z = spot.z;
        if (spot.kind === 'sit') m.sitW = 1; else if (spot.kind === 'lean') m.leanW = 1; else m.barW = 1;
        settled(fig);
      }
      m.settle.t = fig.rand() * m.settle.until * 0.8;
      m.wait = 0;
    }
    rebuildGrid();
    for (const fig of figures) if (!fig.m.settle) fig.m.wait = Math.max(fig.m.wait, 2.5);
    for (const fig of figures) {
      const m = fig.m;
      if (!canSettle(fig) || m.settle || m.talk || onWatch(fig) || fig.rand() > 0.6) continue;
      const o = partnerFor(fig);
      if (!o || o === fig) continue;
      const room = nav.roomAt(fig.at.x, fig.at.y, fig.at.z);
      if (nav.roomAt(o.at.x, o.at.y, o.at.z) !== room) continue;
      // Stood at a talking distance from them, on open ground.
      const dx = fig.at.x - o.at.x; const dz = fig.at.z - o.at.z;
      const d = Math.hypot(dx, dz) || 1;
      const gap = 1.25 + fig.rand() * 0.25;
      const x = o.at.x + (dx / d) * gap; const z = o.at.z + (dz / d) * gap;
      if (!nav.sample(x, z, fig.level)) continue;
      fig.at.x = x; fig.at.z = z;
      m.talk = { with: o, phase: 'go', t: 0 };
      o.m.talk = { with: fig, phase: 'wait', t: 0 };
      startTalk(fig);
      fig.object.rotation.y = fig.m.turnTo;
      o.object.rotation.y = o.m.turnTo;
    }
    untangle();
    // Posed before anything draws: `state.benchmark` halts the loop before
    // the first update, and a seated body would otherwise be standing in
    // its idle half a metre over the bench.
    for (const fig of figures) {
      if (fig.m.settle && fig.mixer) {
        fig.m.base = { idle: 1 };
        animate(fig, 0);
        fig.mixer.update(0);
      }
      placeObject(fig);
      if (fig.m.settle && fig.bones) finishPose(fig, 0, false);
    }
  }
  /**
   * Bodies the resets put inside one another -- seven beasts on a barn's
   * reset ring -- are stood apart before anyone sees them, since doing it in
   * the frame loop is a slide: a few passes easing each overlapping pair
   * apart along the way out, onto open ground only. Settled bodies stay put.
   */
  function untangle() {
    rebuildGrid();
    for (let pass = 0; pass < 12; pass++) {
      let moved = false;
      for (const fig of figures) {
        if (fig.m.settle || fig.m.dead) continue;
        neighbours(fig, near);
        for (const o of near) {
          if (o.level !== fig.level) continue;
          const gap = gapBetween(fig, o);
          if (gap >= 0.08) continue;
          const share = o.m.settle ? 1 : 0.5;
          const push = (0.08 - gap) * share;
          const px = fig.at.x + _cp.nx * push; const pz = fig.at.z + _cp.nz * push;
          if (nav.sample(px, pz, fig.level) === 1) { fig.at.x = px; fig.at.z = pz; moved = true; }
        }
      }
      if (!moved) break;
      rebuildGrid();
    }
    for (const fig of figures) {
      if (fig.m.settle || fig.m.dead) continue;
      fig.object.position.set(fig.at.x, fig.at.y, fig.at.z);
      if (fig.homeSpot) { fig.homeSpot.x = fig.at.x; fig.homeSpot.z = fig.at.z; }
      if (fig.interactable) fig.interactable.position.set(fig.at.x, fig.at.y + fig.height * 0.6, fig.at.z);
    }
  }

  openingScene();

  /**
   * A mobile says something (rules' mobsay): the body says it too -- the
   * talk clip standing, the same on the upper body seated or against a wall,
   * for about as long as the words take.
   */
  function speak(fig, text = '') {
    if (!fig || !fig.m || fig.m.dead || fig.m.gone || !fig.actions || !fig.actions.talk) return;
    fig.m.speech = clamp(1.2 + text.length * 0.055, 1.6, 6);
  }

  return { update, strike, react, perform, die, speak, setOpacity, stats, orderOf, CLOSE, spotsByRoom };
}
