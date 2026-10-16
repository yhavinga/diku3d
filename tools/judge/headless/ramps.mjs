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
//        [--fault float|steep|server|norelief|dump|rollfloat]  (puts a deliberate fault in the first ramp,
//                                    to show that this fails: see below)
//
// Rolling ground (src/relief.js: the Shire's hills, the Dump's heaps) is held
// the same way, at seeded random points in the village, the bowl and the dump:
// the picture against the platform (`field`), the player's reading, the
// mobiles' grid, and the server's `liftAt`, which must give the page's own
// height over the flat. `--fault norelief` has the server leave the hills out,
// and `--fault dump` has it leave the heaps out, and `--fault rollfloat` lifts the
// rolling platforms off their mesh; each must fail.
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

const pageResult = await page.evaluate(async ({ res, fault, tol, join, maxGrade }) => {
  const THREE = await import('three');
  const { topAt } = await import('/src/surface.js');
  const d = window.diku;
  const ramps = d.built.platforms.filter((p) => p.slope);
  if (['float', 'steep', 'server'].includes(fault) && ramps.length) {
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
  // --fault rollfloat: the rolling ground's platforms stand 0.3 m off the mesh drawn over them.
  if (fault === 'rollfloat') for (const p of d.built.platforms) if (p.field) p.rest += 0.3;
  // Rolling ground: seeded points, and what each reader says there.
  const rolling = [];
  if (d.relief || d.lumps) {
    let seed = 20261016;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const sets = [];
    if (d.relief) {
      for (let i = 0; i < 250; i++) sets.push(['village', -340 + rnd() * 320, -200 + rnd() * 240]);
      const b = d.relief.box;
      for (let i = 0; i < 150; i++) sets.push(['bowl', b.x0 + rnd() * (b.x1 - b.x0), b.z0 + rnd() * (b.z1 - b.z0)]);
    }
    if (d.lumps) for (let i = 0; i < 150; i++) sets.push(['dump', d.lumps.x0 + 0.5 + rnd() * 12, d.lumps.z0 + 0.5 + rnd() * 12]);
    for (const [set, x, z] of sets) {
      const hill = d.relief ? d.relief.at(x, z) : 0;
      const heap = d.lumps && d.lumps.inside(x, z) ? d.lumps.at(x, z) : 0;
      const g = d.player.groundAt(x, z, hill + heap + 2);
      const r = { set, x, z, hill, heap, g, mesh: null, nav: null, fails: [] };
      // Where the ground is flat this is not what is held here.
      if (hill + heap < 0.05) { r.flat = true; rolling.push(r); continue; }
      if (g === -Infinity) { r.fails.push('no ground'); rolling.push(r); continue; }
      rc.set(new THREE.Vector3(x, g + 3, z), down);
      const hits = rc.intersectObject(d.built.group, true).filter((h) => h.object.visible && !h.object.isSprite && !(h.object.material && h.object.material.transparent) && Math.abs(h.point.y - g) < 1.5);
      if (hits.length) r.mesh = Math.min(...hits.map((h) => Math.abs(h.point.y - g)));
      const m = d.actors.nav.moundY(x, z, 0);
      if (m !== null) r.nav = Math.abs(m - g);
      // The ground is at least as high as the hills and heaps say, over a floor at or under level.
      if (g < hill + heap - 0.6) r.fails.push('under the hill');
      if (r.mesh !== null && r.mesh > 0.15) r.fails.push(`mesh ${r.mesh.toFixed(3)}`);
      if (r.nav !== null && r.nav > tol) r.fails.push(`nav ${r.nav.toFixed(3)}`);
      rolling.push(r);
    }
  }
  return { out, rolling };
}, { res: opt.res, fault: opt.fault, tol: TOL, join: JOIN, maxGrade: MAX_GRADE });
const result = pageResult.out;

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

// Rolling ground, the server's side: its `liftAt` at each point, with the page's feet on the ground.
let rollingBad = 0;
if (opt.repo && pageResult.rolling.length) {
  const { bootWorld } = await import(pathToFileURL(path.join(opt.repo, 'server/world.mjs')).href);
  const w = bootWorld(opt.repo);
  const Z = w.byId.get('home');
  const stats = {};
  for (const r of pageResult.rolling) {
    if (r.flat) continue;
    if (r.g === -Infinity) { r.server = null; }
    else {
      // The flat height of the floor the feet are on: level 0's floor, or the ground plane under it.
      const near = w.nav.roomAt(r.x + Z.offset, r.g - r.hill - r.heap, r.z);
      if (near !== undefined && (w.lifts.get(near) || 0) !== 0) {
        // Open ground the layout leaves to the nearest room: where that is a sunk river's room the
        // server lifts by the river's own drop, as it does for the flat ground there, and that is
        // not what this holds to the hills.
        r.skipped = true; r.server = null; r.nav = null; r.fails = r.fails.filter((f) => !String(f).startsWith('nav'));
      } else {
        let lift = w.liftAt(r.x + Z.offset, r.g, r.z);
        if (opt.fault === 'norelief') lift -= r.hill;
        if (opt.fault === 'dump') lift -= r.heap;
        // Whatever the page lifted by, the server must lift by (the floor's own height is 0 or -0.47).
        const want = r.hill + r.heap;
        r.server = Math.abs(lift - want);
        if (r.server > TOL) r.fails.push(`server ${lift.toFixed(3)} want ${want.toFixed(3)}`);
      }
    }
    const s = (stats[r.set] ||= { skipped: 0, n: 0, bad: 0, maxServer: 0, maxMesh: 0, maxNav: 0, maxHill: 0 });
    s.n++; if (r.skipped) s.skipped++; if (r.fails.length) s.bad++;
    s.maxServer = Math.max(s.maxServer, r.server ?? 0); s.maxMesh = Math.max(s.maxMesh, r.mesh ?? 0); s.maxNav = Math.max(s.maxNav, r.nav ?? 0); s.maxHill = Math.max(s.maxHill, r.hill + r.heap);
    if (r.fails.length) { rollingBad++; if (rollingBad <= 6) console.log('   rolling', r.set, [r.x, r.z].map((v) => +v.toFixed(1)), r.fails.join('; ')); }
  }
  for (const [k, s] of Object.entries(stats)) console.log(`rolling ${k}: ${s.n} points (${s.skipped} by a sunk river's room, server and nav not asked), up to ${s.maxHill.toFixed(1)} m  mesh dev ${s.maxMesh.toFixed(3)}  nav ${s.maxNav.toFixed(3)}  server ${s.maxServer.toFixed(3)}  ${s.bad ? s.bad + ' FAIL' : 'ok'}`);
}

let bad = 0;
for (const r of result) {
  const failed = r.fails.length || r.noHit;
  if (failed) bad++;
  console.log(`ramp ${JSON.stringify(r.rect)} grade ${r.grade} deg  ${r.samples} samples  mesh dev ${r.maxMesh}  player ${r.maxPlayer}  nav ${r.maxNav}  join ${r.maxJoin}  server ${r.maxServer ?? 'n/a'}  no hit ${r.noHit}  ${failed ? 'FAIL' : 'ok'}`);
  for (const f of r.fails.slice(0, 3)) console.log('   ', JSON.stringify(f));
}
console.log(`${result.length} ramps, ${bad} failing; ${rollingBad} rolling-ground points failing${opt.fault ? ` (with --fault ${opt.fault})` : ''}`);
bad += rollingBad;
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(result, null, 1));
await browser.close();
process.exit(bad || !result.length ? 1 : 0);
