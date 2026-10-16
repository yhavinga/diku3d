// Every ramp (a platform whose top is a plane, src/surface.js) held to the
// surface that is drawn over it, and to every reader of a platform's height.
//
// A ramp is walked on as the plane the page says (`topAt`) and drawn as a
// mesh build.js laid over the same rectangle. If those two are not the same
// surface a body floats above its own road or sinks into it, and neither
// walkable.mjs nor thirdperson.mjs can tell: both read the platform, not the
// picture. This reads the picture. Per ramp, on a grid of --res metres:
//
//  1. the drawn surface: a ray straight down from over the ramp, onto what
//     is built (the batched ground meshes, nothing that moves), takes the
//     nearest hit to the plane; it must lie within TOL of `topAt`;
//  2. the player: `player.groundAt` with the feet on the plane must be the
//     plane (no step up or down on a ramp), within TOL;
//  3. the mobiles' grid: `nav.moundY` must be the plane, within TOL;
//  4. the server: `liftAt` (server/world.mjs), which the judge and every
//     position sent back to a page use, must give the plane's height over its
//     level at each point, within TOL (needs --repo <the checkout>: the server
//     is booted here, in node, as walkable.mjs boots it);
//  5. the grade of the plane: at most MAX_GRADE degrees, which is what a
//     road is; and no jump where it meets a neighbouring platform's edge:
//     the plane's height at each edge midpoint against what the player
//     reads one radius beyond it, within JOIN.
//
// Same setup as drive.mjs, Playwright from a scratch directory:
//
//   cp <repo>/tools/judge/headless/ramps.mjs /tmp/pw/
//   timeout 900 node /tmp/pw/ramps.mjs --repo <repo> --port 8173 [--res 0.5] [--out /tmp/ramps.json]
//        [--fault float|steep|server]  (puts a deliberate fault in the first ramp,
//                                    to show that this fails: see below)
//
// Prints one line per ramp and exits 1 if any limit fails. `--fault float`
// lifts the first ramp's platform 0.2 m off its mesh; `--fault steep` makes
// its grade four times what it is; `--fault server` has the server read the
// first ramp 0.2 m too high. Each must fail.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOL = 0.02;
const JOIN = 0.05;
const MAX_GRADE = 6;

const args = process.argv.slice(2);
const opt = { repo: null, port: 8173, res: 0.5, out: null, fault: null, wait: 15000, query: '' };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--repo') { opt.repo = v; i++; }
  else if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--res') { opt.res = +v; i++; }
  else if (a === '--out') { opt.out = v; i++; }
  else if (a === '--fault') { opt.fault = v; i++; }
  else if (a === '--query') { opt.query = v; i++; }
  else if (a === '--wait') { opt.wait = +v; i++; }
}

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${opt.port}/?${opt.query}`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: opt.wait * 4 });
await page.waitForTimeout(opt.wait);

const result = await page.evaluate(async ({ res, fault, tol, join, maxGrade }) => {
  const THREE = await import('three');
  const { topAt } = await import('/src/surface.js');
  const d = window.diku;
  const ramps = d.built.platforms.filter((p) => p.slope);
  if (fault && ramps.length) {
    const p = ramps[0];
    // A fault in the platform only: the mesh stays as it was drawn.
    if (fault === 'float') { p.slope = { ...p.slope, top0: p.slope.top0 + 0.2 }; p.top += 0.2; }
    else if (fault === 'server') { /* the page is left alone: the fault is in node, below */ }
    else if (fault === 'steep') { p.slope = { ...p.slope, ax: p.slope.ax * 4, az: p.slope.az * 4 }; }
    else throw new Error(`ramps: what is --fault ${fault}?`);
  }
  const rc = new THREE.Raycaster();
  rc.far = 12;
  const down = new THREE.Vector3(0, -1, 0);
  const out = [];
  d.state.paused = true;
  for (const p of ramps) {
    const r = { rect: [p.x0, p.x1, p.z0, p.z1].map((v) => +v.toFixed(2)), base: p.base, samples: 0, maxMesh: 0, maxPlayer: 0, maxNav: 0, grade: 0, maxJoin: 0, noHit: 0, fails: [] };
    const gx = p.slope.ax; const gz = p.slope.az;
    r.grade = +(Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI).toFixed(2);
    if (r.grade > maxGrade) r.fails.push({ kind: 'grade', grade: r.grade });
    const level = Math.round(p.base / 7.6);
    for (let x = p.x0 + res / 2; x < p.x1; x += res) {
      for (let z = p.z0 + res / 2; z < p.z1; z += res) {
        const want = topAt(p, x, z);
        r.samples++;
        // 1. the picture.
        rc.set(new THREE.Vector3(x, want + 3, z), down);
        const hits = rc.intersectObject(d.built.group, true).filter((h) => h.object.visible && !h.object.isSprite && !(h.object.material && h.object.material.transparent) && Math.abs(h.point.y - want) < 1.5);
        if (!hits.length) { r.noHit++; if (r.fails.length < 5) r.fails.push({ kind: 'nohit', at: [+x.toFixed(1), +z.toFixed(1)] }); continue; }
        const dev = Math.min(...hits.map((h) => Math.abs(h.point.y - want)));
        r.maxMesh = Math.max(r.maxMesh, dev);
        if (dev > tol && r.fails.length < 5) r.fails.push({ kind: 'mesh', at: [+x.toFixed(1), +z.toFixed(1)], dev: +dev.toFixed(3) });
        // 2. the player's reading, feet on the plane.
        const g = d.player.groundAt(x, z, want);
        r.maxPlayer = Math.max(r.maxPlayer, Math.abs(g - want));
        if (Math.abs(g - want) > tol && r.fails.length < 5) r.fails.push({ kind: 'player', at: [+x.toFixed(1), +z.toFixed(1)], got: +g.toFixed(3), want: +want.toFixed(3) });
        // 3. the mobiles' grid.
        const m = d.actors.nav.moundY(x, z, level);
        r.maxNav = Math.max(r.maxNav, m === null ? 9 : Math.abs(m - want));
        if ((m === null || Math.abs(m - want) > tol) && r.fails.length < 5) r.fails.push({ kind: 'nav', at: [+x.toFixed(1), +z.toFixed(1)], got: m, want: +want.toFixed(3) });
      }
    }
    // 4. the edges, against what the player reads a radius out from them.
    for (const [ex, ez, ox, oz] of [[p.x0, (p.z0 + p.z1) / 2, -0.42, 0], [p.x1, (p.z0 + p.z1) / 2, 0.42, 0], [(p.x0 + p.x1) / 2, p.z0, 0, -0.42], [(p.x0 + p.x1) / 2, p.z1, 0, 0.42]]) {
      const here = topAt(p, ex, ez);
      const beyond = d.player.groundAt(ex + ox, ez + oz, here + 0.5);
      if (beyond === -Infinity) continue;
      const jump = Math.abs(beyond - here);
      r.maxJoin = Math.max(r.maxJoin, jump);
      if (jump > join && r.fails.length < 5) r.fails.push({ kind: 'join', at: [+ex.toFixed(1), +ez.toFixed(1)], here: +here.toFixed(3), beyond: +beyond.toFixed(3) });
    }
    for (const k of ['maxMesh', 'maxPlayer', 'maxNav', 'maxJoin']) r[k] = +r[k].toFixed(4);
    r.plane = { x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1, base: p.base, slope: p.slope, zone: d.zone.id };
    out.push(r);
  }
  return out;
}, { res: opt.res, fault: opt.fault, tol: TOL, join: JOIN, maxGrade: MAX_GRADE });

// 4. the server's floor, from its own boot of the same checkout.
if (opt.repo) {
  const { bootWorld } = await import(pathToFileURL(path.join(opt.repo, 'server/world.mjs')).href);
  const { topAt } = await import(pathToFileURL(path.join(opt.repo, 'src/surface.js')).href);
  const w = bootWorld(opt.repo);
  for (const r of result) {
    const Z = w.byId.get(r.plane.zone);
    const p = { x0: r.plane.x0, x1: r.plane.x1, z0: r.plane.z0, z1: r.plane.z1, top: r.plane.base, slope: r.plane.slope };
    let worst = 0;
    for (let x = p.x0 + 0.25; x < p.x1; x += 1) {
      for (let z = p.z0 + 0.25; z < p.z1; z += 1) {
        const want = topAt(p, x, z) - r.plane.base;
        // The page's feet are on the plane; the server is asked where they are.
        const lift = w.liftAt(x + Z.offset, r.plane.base + want, z) + (opt.fault === 'server' && r === result[0] ? 0.2 : 0);
        const dev = Math.abs(lift - want);
        worst = Math.max(worst, dev);
        if (dev > TOL && r.fails.length < 5) r.fails.push({ kind: 'server', at: [+x.toFixed(1), +z.toFixed(1)], lift: +lift.toFixed(3), want: +want.toFixed(3) });
      }
    }
    r.maxServer = +worst.toFixed(4);
  }
}

let bad = 0;
for (const r of result) {
  const failed = r.fails.length || r.noHit;
  if (failed) bad++;
  console.log(`ramp ${JSON.stringify(r.rect)} grade ${r.grade} deg  ${r.samples} samples  mesh dev ${r.maxMesh}  player ${r.maxPlayer}  nav ${r.maxNav}  join ${r.maxJoin}  server ${r.maxServer ?? 'n/a'}  no hit ${r.noHit}  ${failed ? 'FAIL' : 'ok'}`);
  for (const f of r.fails.slice(0, 3)) console.log('   ', JSON.stringify(f));
}
console.log(`${result.length} ramps, ${bad} failing${opt.fault ? ` (with --fault ${opt.fault})` : ''}`);
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(result, null, 1));
await browser.close();
process.exit(bad || !result.length ? 1 : 0);
