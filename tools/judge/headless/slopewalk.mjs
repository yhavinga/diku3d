// Walking on rolling and ramped ground: the Shire's hills, the Dump's heaps and
// Midgaard's ramps, walked with the real player (src/player.js `step`) at 60 Hz
// and the over-the-shoulder figure (src/view.js `update`) following it.
//
// ramps.mjs holds the platforms to the drawn ground standing still; this holds
// the body to both while it moves, which is where it went wrong: a slope was
// refused as a wall at 5-15 degrees (the test compared one frame's rise, with
// the feet's own lag in it, over a millimetre of run), the feet sank into a
// hill going up and walked above it going down (the height was eased onto,
// as for a stair's tread), and the figure stood where the feet did.
//
// From seeded points, in each of four headings (up the slope, down it, and
// across it each way), the player walks 1.2 s with every collider taken away,
// so that only the ground can stop it. Per walk:
//
//  1. refusals -- HARD, must be 0: a frame that gains under half its stride is
//     a refusal, and the ground there, over a metre along the heading, must
//     be at least REFUSE_BELOW degrees or the body was stopped by a gentle
//     slope. (Only steeper than MAX_SLOPE, 40 degrees, may stop it.)
//  2. progress -- HARD: a walk with no refusal covers 97% of its stride.
//  3. the feet against the drawn ground -- HARD: with the feet on a platform
//     that holds the point (not one only in reach, whose edge is a step by
//     design), the feet's height against the platform (`lag`, the easing) and
//     against a ray down onto the built mesh, p99 within FEET_TOL and the
//     worst within FEET_MAX.
//  4. airborne -- HARD, must be 0: frames not on the ground, walking down a
//     slope on ground that holds the point.
//  5. the figure's sole -- the lowest vertex of the body against the mesh
//     (the stride lifts a foot and plants the other: it dips a little under
//     the player's own height): p99 within SOLE_TOL, the worst within SOLE_MAX.
//
// Same setup as drive.mjs, Playwright from a scratch directory:
//
//   cp <repo>/tools/judge/headless/slopewalk.mjs /tmp/pw/
//   timeout 1200 node /tmp/pw/slopewalk.mjs --port 8173 [--n 80] [--out /tmp/sw.json]
//        [--fault sunk|float|wall|lag]   (a deliberate fault: each must fail)
//
// `--fault sunk` lowers the rolling platforms 6 cm under the mesh, `float` raises
// them 6 cm, `wall` makes every hill steeper than the player will climb, and
// `lag` eases the feet onto the ground, which is what a stair's tread gets.
import { chromium } from 'playwright';
import fs from 'node:fs';

const REFUSE_BELOW = 30;
const FEET_TOL = 0.03;
const FEET_MAX = 0.05;
const SOLE_TOL = 0.04;
const SOLE_MAX = 0.06;

const args = process.argv.slice(2);
const opt = { port: 8173, n: 80, out: null, fault: null, query: 'room=1128', wait: 15000, seconds: 1.2 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--n') { opt.n = +v; i++; }
  else if (a === '--out') { opt.out = v; i++; }
  else if (a === '--fault') { opt.fault = v; i++; }
  else if (a === '--query') { opt.query = v; i++; }
  else if (a === '--seconds') { opt.seconds = +v; i++; }
  else if (a === '--wait') { opt.wait = +v; i++; }
}

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${opt.port}/?${opt.query}`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: opt.wait * 4 });
await page.waitForTimeout(opt.wait);

const result = await page.evaluate(async ({ n, fault, seconds, limits }) => {
  const THREE = await import('three');
  const { topAt } = await import('/src/surface.js');
  const d = window.diku;
  const P = d.player;
  const RADIUS = 0.42; const EYE = 1.72;
  for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden');
  d.state.paused = true; // the loop leaves the player alone: it is stepped here
  d.applyTime('noon');
  d.view.set(true);
  const dt = 1 / 60;
  const rolling = d.built.platforms.filter((p) => p.field);
  if (fault === 'sunk') for (const p of rolling) p.rest -= 0.06;
  else if (fault === 'float') for (const p of rolling) p.rest += 0.06;
  else if (fault === 'wall') P.gradeAlong = () => 9;
  else if (fault === 'lag') {
    // The feet ease onto the ground at 18 per second, as for a tread: wrapped round step().
    const step = P.step.bind(P);
    P.step = (t) => {
      const before = P.position.y; step(t);
      if (P.onGround) P.position.y = before + (P.position.y - before) * Math.min(1, t * 18);
    };
  } else if (fault) throw new Error(`slopewalk: what is --fault ${fault}?`);

  const rc = new THREE.Raycaster(); rc.far = 12;
  const DOWN = new THREE.Vector3(0, -1, 0);
  const meshAt = (x, y, z) => {
    rc.set(new THREE.Vector3(x, y + 3, z), DOWN);
    const hs = rc.intersectObject(d.built.group, true).filter((h) => h.object.visible && !h.object.isSprite && !h.object.isInstancedMesh && /^batch/.test(h.object.name) && !(h.object.material && h.object.material.transparent) && Math.abs(h.point.y - y) < 1.2);
    if (!hs.length) return null;
    return hs.reduce((a, h) => (Math.abs(h.point.y - y) < Math.abs(a - y) ? h.point.y : a), hs[0].point.y);
  };
  // The platform that holds a point, as groundAt picks it, and whether the point is inside it.
  const holder = (x, z, feetY) => {
    let best = -Infinity; let who = null;
    for (const p of P.platforms.near(x, z, [])) {
      if (p.door && p.door.open) continue;
      if (x < p.x0 - RADIUS || x > p.x1 + RADIUS || z < p.z0 - RADIUS || z > p.z1 + RADIUS) continue;
      const top = topAt(p, x, z);
      if (top > feetY + 0.62) continue;
      if (top > best) { best = top; who = p; }
    }
    return who && x >= who.x0 && x <= who.x1 && z >= who.z0 && z <= who.z1 ? who : null;
  };
  // The land's own height (relief.js, the Dump's heaps), which the test reads
  // from the functions and not from the player, so as not to ask the code it is
  // holding what is steep. The floor under the feet at the start: the first one
  // a body standing a little over the land could be on.
  const land = (x, z) => (d.relief ? d.relief.at(x, z) : 0) + (d.lumps && d.lumps.inside(x, z) ? d.lumps.at(x, z) : 0);
  const startAt = (x, z) => P.groundAt(x, z, land(x, z) + 2.5);
  const landGrade = (x, z) => [land(x + 0.5, z) - land(x - 0.5, z), land(x, z + 0.5) - land(x, z - 0.5)];
  // The slope over a metre along (ux, uz), degrees: the land's, or a ramp's plane.
  const slopeAlong = (set, x, z, ux, uz, plane) => (plane
    ? Math.atan(plane.ax * ux + plane.az * uz) * 180 / Math.PI
    : Math.atan((land(x + ux * 0.5, z + uz * 0.5) - land(x - ux * 0.5, z - uz * 0.5)) / 1.0) * 180 / Math.PI);

  let seed = 20261017;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const sets = [];
  if (d.relief) {
    const picks = [];
    // Points on the hills with a grade worth walking: 3 degrees and over.
    for (let tries = 0; picks.length < n && tries < 20000; tries++) {
      const x = -340 + rnd() * 320; const z = -200 + rnd() * 240;
      const [gx, gz] = landGrade(x, z);
      if (Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI >= 3 && startAt(x, z) !== -Infinity) picks.push([x, z, gx, gz]);
    }
    sets.push({ name: 'shire', picks });
  }
  if (d.lumps) {
    const picks = [];
    for (let i = 0; i < n; i++) {
      const x = d.lumps.x0 + 1 + rnd() * 11; const z = d.lumps.z0 + 1 + rnd() * 11;
      picks.push([x, z, ...landGrade(x, z)]);
    }
    sets.push({ name: 'dump', picks });
  }
  const ramps = d.built.platforms.filter((p) => p.slope);
  if (ramps.length) {
    const picks = [];
    for (const p of ramps) picks.push([(p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2, p.slope.ax, p.slope.az, p.slope]);
    sets.push({ name: 'ramps', picks });
  }

  // Walk with nothing in the way but the ground.
  const walls = P.colliders.cells; P.colliders.cells = new Map();
  const out = [];
  const q = (a, f) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))]; };
  try {
    for (const set of sets) {
      const s = { name: set.name, walks: 0, frames: 0, refusals: 0, gentleRefusals: 0, short: 0, airborne: 0, lag: [], feet: [], sole: [], fails: [] };
      for (const [x, z, gx, gz, plane] of set.picks) {
        const g0 = plane ? P.groundAt(x, z, plane.top0 + 3) : startAt(x, z);
        if (g0 === -Infinity) continue;
        const up = Math.atan2(-gx, -gz); // forward is (-sin, -cos): up the slope
        const flat = Math.hypot(gx, gz) < 1e-6;
        const headings = flat ? [0, Math.PI / 2, Math.PI, -Math.PI / 2] : [up, up + Math.PI, up + Math.PI / 2, up - Math.PI / 2];
        for (let h = 0; h < headings.length; h++) {
          const yaw = headings[h];
          const ux = -Math.sin(yaw); const uz = -Math.cos(yaw);
          const downhill = h === 1 && !flat;
          P.spawn(x, g0, z, yaw);
          P.keys.add('KeyW');
          if (s.walks % 3 === 2) P.keys.add('ShiftLeft'); else P.keys.delete('ShiftLeft');
          const speed = P.keys.has('ShiftLeft') ? 9.5 : 4.8;
          for (let i = 0; i < 20; i++) { P.step(dt); d.view.update(dt, {}); }
          const sx = P.position.x; const sz = P.position.z;
          let refused = 0; let frames = 0; let gentle = false; let steady = 0; let lastFloor = null;
          for (let i = 0; i < Math.round(seconds * 60); i++) {
            const fx = P.position.x; const fz = P.position.z;
            P.step(dt); d.view.update(dt, {});
            frames++;
            const run = Math.hypot(P.position.x - fx, P.position.z - fz);
            const feet = P.position.y - EYE;
            const held = holder(P.position.x, P.position.z, feet);
            // Only ground on the same floor for a third of a second: where a tread or
            // a room's floor begins its height is a step on purpose, and the feet
            // ease onto it. (A hill's cells all share their floor's `rest`.)
            const floor = held ? (held.field ? held.rest : held.slope ? 'ramp' : null) : null;
            steady = floor !== null && floor === lastFloor ? steady + 1 : 0;
            lastFloor = floor;
            if (run < 0.5 * speed * dt) {
              refused++;
              // What the ground is where it was stopped.
              const slope = slopeAlong(set.name, fx, fz, ux, uz, plane);
              if (slope < limits.refuseBelow) { gentle = true; if (s.fails.length < 6) s.fails.push({ kind: 'refused', at: [+fx.toFixed(1), +fz.toFixed(1)], slope: +slope.toFixed(1), heading: h }); }
            }
            if (!P.onGround && downhill && steady >= 20) { s.airborne++; if (s.fails.length < 6) s.fails.push({ kind: 'airborne', at: [+P.position.x.toFixed(1), +P.position.z.toFixed(1)] }); }
            if (steady >= 20) {
              s.lag.push(Math.abs(feet - topAt(held, P.position.x, P.position.z)));
              if (frames % 3 === 0) {
                const m = meshAt(P.position.x, feet, P.position.z);
                if (m !== null) {
                  s.feet.push(Math.abs(feet - m));
                  if (Math.abs(feet - m) > limits.feetMax && s.fails.length < 6) s.fails.push({ kind: 'mesh', at: [+P.position.x.toFixed(1), +P.position.z.toFixed(1)], feet: +feet.toFixed(3), mesh: +m.toFixed(3) });
                  const fig = d.view.figure;
                  fig.group.updateMatrixWorld(true);
                  s.sole.push(Math.max(0, m - new THREE.Box3().setFromObject(fig.body, true).min.y));
                }
              }
            }
          }
          P.keys.delete('KeyW'); P.keys.delete('ShiftLeft');
          const covered = Math.hypot(P.position.x - sx, P.position.z - sz);
          s.walks++; s.frames += frames; s.refusals += refused; if (gentle) s.gentleRefusals++;
          if (!refused && covered < 0.97 * speed * frames * dt - 0.05) { s.short++; if (s.fails.length < 6) s.fails.push({ kind: 'short', at: [+x.toFixed(1), +z.toFixed(1)], covered: +covered.toFixed(2), heading: h }); }
        }
      }
      s.stats = {
        lag: [q(s.lag, 0.5), q(s.lag, 0.99), q(s.lag, 1)].map((v) => +v.toFixed(4)),
        feet: [q(s.feet, 0.5), q(s.feet, 0.99), q(s.feet, 1)].map((v) => +v.toFixed(4)),
        sole: [q(s.sole, 0.5), q(s.sole, 0.99), q(s.sole, 1)].map((v) => +v.toFixed(4)),
        samples: s.feet.length,
      };
      delete s.lag; delete s.feet; delete s.sole;
      out.push(s);
    }
  } finally { P.colliders.cells = walls; }
  return out;
}, { n: opt.n, fault: opt.fault, seconds: opt.seconds, limits: { refuseBelow: REFUSE_BELOW, feetMax: FEET_MAX } });

let bad = 0;
for (const s of result) {
  const [lag50, lag99, lagMax] = s.stats.lag; const [f50, f99, fMax] = s.stats.feet; const [so50, so99, soMax] = s.stats.sole;
  const fails = [];
  if (s.gentleRefusals) fails.push(`${s.gentleRefusals} walks refused under ${REFUSE_BELOW} deg`);
  if (s.short) fails.push(`${s.short} walks short of their stride`);
  if (s.airborne) fails.push(`${s.airborne} airborne frames downhill`);
  if (lag99 > FEET_TOL || lagMax > FEET_MAX) fails.push(`feet ${lag99}/${lagMax} m off the platform`);
  if (f99 > FEET_TOL || fMax > FEET_MAX) fails.push(`feet ${f99}/${fMax} m off the drawn ground`);
  if (so99 > SOLE_TOL || soMax > SOLE_MAX) fails.push(`sole ${so99}/${soMax} m into the ground`);
  if (!s.walks) fails.push('nothing walked');
  console.log(`${s.name.padEnd(6)} ${String(s.walks).padStart(4)} walks  refusals ${s.refusals} frames (${s.gentleRefusals} walks under ${REFUSE_BELOW} deg)  short ${s.short}  airborne ${s.airborne}  platform dev p50/p99/max ${lag50}/${lag99}/${lagMax}  mesh dev ${f50}/${f99}/${fMax}  sole depth ${so50}/${so99}/${soMax}  (${s.stats.samples} ray samples)  ${fails.length ? 'FAIL: ' + fails.join('; ') : 'ok'}`);
  for (const f of s.fails.slice(0, 3)) console.log('   ', JSON.stringify(f));
  if (fails.length) bad++;
}
console.log(`${result.length} sets, ${bad} failing${opt.fault ? ` (with --fault ${opt.fault})` : ''}`);
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(result, null, 1));
await browser.close();
process.exit(bad || !result.length ? 1 : 0);
