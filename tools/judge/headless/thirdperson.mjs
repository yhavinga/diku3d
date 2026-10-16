// The over-the-shoulder camera (src/view.js, the V key) put through a sweep of
// places, standing points, headings and pitches, headless. The third-person
// counterpart of walkable.mjs and zsweep.mjs. Per pose it measures
//
//  1. camera inside geometry -- HARD, must be 0: a ray from the eye (the
//     pivot) to the camera meets opaque built geometry before the camera, or
//     the camera point is inside a collider, or under a platform's slab. The
//     arm is held off walls by colliders, not by rays (a ray every frame is
//     3.5 ms), so this is the check that the colliders cover what the eye
//     sees;
//  2. camera too close -- WARNING: an arm under 1.2 m, the figure then fills
//     the view or is hidden (NEAR_HIDE);
//  3. the figure in the frame -- HARD: the composited back buffer is read
//     (composer.render() then gl.readPixels in the same task, as CLAUDE.md
//     insists) twice, with the figure shown and hidden; the pixels that
//     differ are the figure's own, whatever stands behind it. The share of
//     them at max channel <= BLACK must stay under MAX_BLACK. Their mean
//     luminance against the frame's is reported as a note;
//  4. feet on the ground -- HARD: standing still, the lowest foot bone and the
//     lowest vertex of the body against the floor under the feet, within
//     FEET_TOL.
//
// Same setup as drive.mjs, Playwright from a scratch directory:
//
//   cp <repo>/tools/judge/headless/thirdperson.mjs /tmp/pw/
//   timeout 1500 node /tmp/pw/thirdperson.mjs --port 8173 [--out /tmp/tp.json]
//        [--places boar,temple | all] [--query "areas=midgaard"]
//        [--headings 8] [--pitches -0.1,-0.35,-0.6,0.4] [--no-frame]
//
// Prints one line per place and the worst offenders; exits 1 if a hard limit
// fails. The JSON has every pose that failed, with where to go and look from.
import { chromium } from 'playwright';
import fs from 'node:fs';

// Where to stand. `vnum` is a room; `key` a diku.places() key to resolve to
// one instead; `time` an hour to set first. `offsets` are standing points
// from the room's centre in metres: the walls are what the camera runs into,
// so most of them are near one. Add places here, nowhere else.
const PLACES = [
  { name: 'boar', vnum: 3006, offsets: [[3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5], [0, 0]] },
  { name: 'boarbar', vnum: 3007, offsets: [[3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5], [0, 0]] },
  { name: 'temple', vnum: 3001, offsets: [[3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5], [0, 0]] },
  { name: 'mage', vnum: 3019, offsets: [[3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5], [0, 0]] },
  { name: 'clerics', vnum: 3004, offsets: [[3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5], [0, 0]] },
  { name: 'sewer', vnum: 7001, offsets: [[2, 0], [-2, 0], [0, 2], [0, -2], [0, 0]] },
  { name: 'street', key: 'street', offsets: [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]] },
  // The street up to the Temple Square: a ramp, 2.6 degrees (surface.js).
  { name: 'ramp', vnum: 3014, offsets: [[0, -9], [0, -13], [0, -17], [0, -21], [3, -13]] },
  { name: 'market', vnum: 3014, offsets: [[3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5], [0, 0]] },
  { name: 'temple-night', vnum: 3001, time: 'night', offsets: [[3.5, 0], [-3.5, 0], [0, 0]] },
  { name: 'boarbar-night', vnum: 3007, time: 'night', offsets: [[3.5, 0], [-3.5, 0], [0, 0]] },
];
// Limits. BLACK is the max channel at or under which a pixel is "RGB 0".
const MIN_ARM = 1.2;
const BLACK = 2;
const MAX_BLACK = 0.02;
const FEET_TOL = 0.03;

const args = process.argv.slice(2);
const opt = { port: 8173, out: null, places: 'all', query: '', headings: 12, pitches: [-0.1, -0.35, -0.6, 0.4], frame: true, wait: 15000 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--out') { opt.out = v; i++; }
  else if (a === '--places') { opt.places = v; i++; }
  else if (a === '--query') { opt.query = v; i++; }
  else if (a === '--headings') { opt.headings = +v; i++; }
  else if (a === '--pitches') { opt.pitches = v.split(',').map(Number); i++; }
  else if (a === '--no-frame') opt.frame = false;
  else if (a === '--wait') { opt.wait = +v; i++; }
}
const only = opt.places === 'all' ? null : new Set(opt.places.split(','));
const list = PLACES.filter((p) => !only || only.has(p.name));

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${opt.port}/?${opt.query}`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: opt.wait * 4 });
await page.waitForTimeout(opt.wait);
await page.evaluate(() => {
  for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden');
  window.diku.state.paused = false;
});

// Everything below runs in the page, one place at a time.
const sweepPlace = async ({ place, headings, pitches, frame, limits }) => {
  const THREE = await import('three');
  // The page's own reading of a platform's height, ramps included.
  const { topAt } = await import('/src/surface.js');
  const d = window.diku;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n) => new Promise((r) => { let i = 0; const s = () => (++i >= n ? r() : requestAnimationFrame(s)); requestAnimationFrame(s); });
  const rc = new THREE.Raycaster();
  const res = { name: place.name, vnum: null, poses: 0, inside: 0, close: 0, black: 0, feet: 0, worstPast: 0, minArm: Infinity, worstBlack: 0, lumRatio: [], fails: [], notes: [] };

  let vnum = place.vnum;
  if (vnum === undefined) vnum = d.places().find((p) => p.key === place.key)?.vnum;
  if (vnum === undefined || !d.built.rooms.get(vnum) || d.built.rooms.get(vnum).unbuilt) { res.skipped = `room ${vnum ?? place.key} is not built`; return res; }
  res.vnum = vnum;
  d.applyTime(place.time || 'noon');
  d.view.set(true);
  d.goto(vnum, 0, -0.1);
  await wait(900);
  const c = d.built.rooms.get(vnum).center;
  const EYE = 1.72;

  const px = (w, h, gl) => { const b = new Uint8Array(w * h * 4); d.composer.render(); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };

  for (const [ox, oz] of place.offsets) {
    d.player.spawn(c.x + ox, c.y, c.z + oz, 0);
    d.player.resolveCollisions(c.y);
    // Where it really stands: resolveCollisions may have pushed it off a wall.
    await wait(500);
    const fig0 = d.view.figure;
    // Feet, idle: once per standing point, at the first heading.
    d.camera.rotation.set(pitches[0], 0, 0);
    await frames(6); await wait(300);
    if (fig0 || d.view.figure) {
      const fig = d.view.figure;
      fig.group.updateMatrixWorld(true);
      const foot = Math.min(...['footL', 'footR'].map((n) => { const b = fig.body.getObjectByName(n); return b ? b.getWorldPosition(new THREE.Vector3()).y : Infinity; }));
      const sole = new THREE.Box3().setFromObject(fig.body, true).min.y;
      const p = d.player.position;
      const floor = d.player.groundAt(p.x, p.z, p.y - EYE);
      const dFoot = foot - floor; const dSole = sole - floor;
      // The bone is the ankle, a few cm over the sole; the sole is what meets the floor.
      if (Math.abs(dSole) > limits.feetTol) { res.feet++; res.fails.push({ kind: 'feet', at: [+(p.x - c.x).toFixed(2), +(p.z - c.z).toFixed(2)], sole: +dSole.toFixed(3), bone: +dFoot.toFixed(3) }); }
      (res.feetRead = res.feetRead || []).push([+dSole.toFixed(3), +dFoot.toFixed(3)]);
    }
    for (const pitch of pitches) {
      for (let i = 0; i < headings; i++) {
        const yaw = (i * 2 * Math.PI) / headings;
        d.camera.rotation.set(pitch, yaw, 0);
        // The arm comes in at once but goes out gently: wait for it to settle.
        await frames(3); await wait(frame ? 450 : 350);
        res.poses++;
        const eye = d.player.position.clone();
        const cam = d.camera.position.clone();
        const dist = eye.distanceTo(cam);
        res.minArm = Math.min(res.minArm, dist);
        const at = { x: +(eye.x - c.x).toFixed(2), z: +(eye.z - c.z).toFixed(2), yaw: +yaw.toFixed(3), pitch };
        if (dist < limits.minArm) res.close++;
        // 1. Through a wall, or in one.
        const why = [];
        if (dist > 0.05) {
          rc.set(eye, cam.clone().sub(eye).normalize()); rc.near = 0.05; rc.far = dist;
          const hit = rc.intersectObject(d.built.group, true).find((h) => h.object.visible && !h.object.isSprite && !(h.object.material && h.object.material.transparent));
          if (hit) {
            const past = +(dist - hit.distance).toFixed(2);
            res.worstPast = Math.max(res.worstPast, past);
            why.push({ ray: [hit.object.name, hit.object.parent && hit.object.parent.name, hit.object.material && hit.object.material.name].join(' / '), past, hy: +(hit.point.y - c.y).toFixed(2), hx: +(hit.point.x - c.x).toFixed(2), hz: +(hit.point.z - c.z).toFixed(2) });
          }
        }
        for (const k of d.player.colliders.near(cam.x, cam.z, [])) {
          if (k.door && (k.whenOpen ? !k.door.open : k.door.open)) continue;
          if (cam.y <= k.y0 || cam.y >= k.y1) continue;
          const inside = k.r ? Math.hypot(cam.x - (k.x0 + k.x1) / 2, cam.z - (k.z0 + k.z1) / 2) < k.r
            : cam.x > k.x0 && cam.x < k.x1 && cam.z > k.z0 && cam.z < k.z1;
          if (inside) why.push({ collider: [+(k.x0 - c.x).toFixed(2), +(k.x1 - c.x).toFixed(2), +(k.z0 - c.z).toFixed(2), +(k.z1 - c.z).toFixed(2), +(k.y0 - c.y).toFixed(1), +(k.y1 - c.y).toFixed(1)] });
        }
        for (const q of d.player.platforms.near(cam.x, cam.z, [])) {
          if (q.door && q.door.open) continue;
          if (cam.x < q.x0 || cam.x > q.x1 || cam.z < q.z0 || cam.z > q.z1) continue;
          const top = topAt(q, cam.x, cam.z);
          if (cam.y < top && cam.y > top - 0.45) why.push({ platform: +(top - c.y).toFixed(2) });
        }
        if (why.length) { res.inside++; res.fails.push({ kind: 'inside', ...at, arm: +dist.toFixed(2), cam: [+(cam.x - c.x).toFixed(2), +(cam.y - c.y).toFixed(2), +(cam.z - c.z).toFixed(2)], blockedAt: d.view.state.blockedAt, why }); }
        // 3. The figure, in the composited frame.
        const fig = d.view.figure;
        if (frame && fig && fig.group.visible) {
          const gl = d.renderer.getContext();
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
          const on = px(w, h, gl);
          fig.group.visible = false;
          const off = px(w, h, gl);
          fig.group.visible = true;
          let n = 0, black = 0, ls = 0, fs = 0, fn = 0;
          for (let j = 0; j < on.length; j += 4) {
            const l = 0.2126 * on[j] + 0.7152 * on[j + 1] + 0.0722 * on[j + 2];
            fs += l; fn++;
            if (on[j] === off[j] && on[j + 1] === off[j + 1] && on[j + 2] === off[j + 2]) continue;
            n++; ls += l;
            if (Math.max(on[j], on[j + 1], on[j + 2]) <= limits.black) black++;
          }
          if (n > 200) {
            const share = black / n;
            res.worstBlack = Math.max(res.worstBlack, share);
            res.lumRatio.push((ls / n) / Math.max(1, fs / fn));
            if (share > limits.maxBlack) { res.black++; res.fails.push({ kind: 'black', ...at, arm: +dist.toFixed(2), share: +share.toFixed(3), figPx: n }); }
          } else res.hidden = (res.hidden || 0) + 1;
        }
      }
    }
  }
  const r = res.lumRatio;
  res.lumRatio = r.length ? +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(2) : null;
  res.minArm = +res.minArm.toFixed(2);
  res.worstBlack = +res.worstBlack.toFixed(3);
  res.fails = res.fails.slice(0, 40);
  return res;
};

const results = [];
for (const place of list) {
  const r = await page.evaluate(sweepPlace, { place, headings: opt.headings, pitches: opt.pitches, frame: opt.frame, limits: { minArm: MIN_ARM, black: BLACK, maxBlack: MAX_BLACK, feetTol: FEET_TOL } });
  results.push(r);
  if (r.skipped) console.log(`${r.name.padEnd(14)} skipped: ${r.skipped}`);
  else console.log(`${r.name.padEnd(14)} #${r.vnum} poses ${String(r.poses).padStart(4)}  inside ${String(r.inside).padStart(3)} (worst ${r.worstPast} m past)  close ${String(r.close).padStart(3)} (min arm ${r.minArm})  black ${r.black} (worst ${r.worstBlack})  feet ${r.feet}  figure/frame lum x${r.lumRatio}  hidden ${r.hidden || 0}`);
}
const sum = (k) => results.reduce((a, r) => a + (r[k] || 0), 0);
const hard = sum('inside') + sum('black') + sum('feet');
console.log(`TOTAL poses ${sum('poses')}  inside ${sum('inside')}  close(warning) ${sum('close')}  black ${sum('black')}  feet ${sum('feet')}  => ${hard ? 'FAIL' : 'ok'}`);
for (const r of results) for (const f of r.fails.slice(0, 5)) console.log(' ', r.name, JSON.stringify(f));
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify({ limits: { MIN_ARM, BLACK, MAX_BLACK, FEET_TOL }, results }, null, 1));
await browser.close();
process.exit(hard ? 1 : 0);
