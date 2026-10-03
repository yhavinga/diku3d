// The first room, walked: from the spawn point in the Temple of Midgaard
// (#3001) up the steps to the Mud School's doorway and through it (#3700),
// back down, and every other way the same stair can be taken -- PgUp, and
// `up` typed at the command line -- plus the level ways out to the altar
// (#3054) and the temple square (#3005). Walked with the keys (W held,
// the view turned the way a mouse would), never with diku.goto, because
// "I cannot go completely up" was a fault of walking, not of the map.
//
//   cp <repo>/tools/judge/headless/temple-walk.mjs /tmp/pw/
//   node /tmp/pw/temple-walk.mjs --port 8173 [--log /tmp/walk.json]
//
// Exits 1 on the first failed assertion, printing the frame log of the leg.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8173, log: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') opt.port = +args[++i];
  else if (args[i] === '--log') opt.log = args[++i];
}

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${opt.port}/`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 180000 });
await page.waitForTimeout(4000);
await page.evaluate(() => {
  for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden');
  window.diku.state.paused = false;
  // Every frame: where the feet are, whether they are on the ground, and
  // which room and zone the game thinks this is.
  window.__trace = [];
  const d = window.diku;
  const tick = () => {
    const p = d.player.position;
    window.__trace.push([+p.x.toFixed(2), +(p.y - 1.72).toFixed(2), +p.z.toFixed(2), d.player.onGround ? 1 : 0, d.game.state.roomVnum, d.zone.id]);
    if (window.__trace.length > 4000) window.__trace.splice(0, 1000);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const results = [];
let failed = false;
const here = () => page.evaluate(() => {
  const d = window.diku; const p = d.player.position;
  return { x: p.x, feet: p.y - 1.72, z: p.z, room: d.state.roomVnum ?? d.game.state.roomVnum, zone: d.zone.id, crossing: !!d.state.crossing, gliding: d.player.gliding, yaw: d.camera.rotation.y };
});
const trace = async () => page.evaluate(() => window.__trace.splice(0));
async function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed = true;
}
/** Face a point on the ground, as the mouse would. */
const face = (x, z) => page.evaluate(([tx, tz]) => {
  const d = window.diku; const p = d.player.position;
  d.camera.rotation.set(0, Math.atan2(-(tx - p.x), -(tz - p.z)), 0);
}, [x, z]);
const faceYaw = (yaw) => page.evaluate((y) => window.diku.camera.rotation.set(0, y, 0), yaw);
/** Hold W towards (x, z) until within `near`, re-aiming every 100 ms. */
async function walkTo(x, z, near = 0.25, ms = 6000) {
  const t0 = Date.now();
  await face(x, z);
  await page.keyboard.down('KeyW');
  try {
    while (Date.now() - t0 < ms) {
      await page.waitForTimeout(100);
      const h = await here();
      if (Math.hypot(h.x - x, h.z - z) < near) break;
      await face(x, z);
    }
  } finally { await page.keyboard.up('KeyW'); }
  await page.waitForTimeout(200);
  return here();
}
/** Hold W for `ms`, or until `until(here)` holds. */
async function hold(ms, until = null) {
  const t0 = Date.now();
  await page.keyboard.down('KeyW');
  try {
    while (Date.now() - t0 < ms) {
      await page.waitForTimeout(80);
      if (until && until(await here())) break;
    }
  } finally { await page.keyboard.up('KeyW'); }
  return here();
}
/** Until a crossing has started and finished, or `ms`. */
async function settleCrossing(ms = 90000) {
  await page.waitForFunction(() => !window.diku.state.crossing && !window.diku.player.gliding, null, { timeout: ms }).catch(() => {});
  await page.waitForTimeout(1500);
  return here();
}
async function waitCross(fromZone, ms = 90000) {
  await page.waitForFunction((z) => window.diku.zone.id !== z || window.diku.state.crossing, fromZone, { timeout: 20000 }).catch(() => {});
  return settleCrossing(ms);
}
const top = (rows) => rows.reduce((m, r) => Math.max(m, r[1]), -Infinity);

// ------------------------------------------------------------------ legs --
const world = await page.evaluate(() => {
  const d = window.diku;
  const way = d.built.stats.ways.find((w) => w.room === 3001 && w.dir === 4);
  return { way, centre: d.built.rooms.get(3001).center, zone: d.zone.id };
});
const start = await here();
await check('spawns in #3001', start.room === 3001, { room: start.room });
await check('#3001 has steps up', !!(world.way && world.way.route), world.way);
const [foot, head, sill] = world.way.route;
const homeZone = world.zone;
const floor = world.centre.y;
const landing = floor + world.way.top;
// Out through the doorway, in the plan: north is -z.
const [ox, oz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][world.way.face];

// 1. Walked: to the foot of the flight, up the treads, into the doorway.
await trace();
let h = await walkTo(foot.x, foot.z, 0.3);
await check('walk: reach the foot of the steps', Math.hypot(h.x - foot.x, h.z - foot.z) < 0.5 && Math.abs(h.feet - floor) < 0.1, h);
await face(head.x, head.z);
h = await hold(4000, (s) => s.feet > landing - 0.05 && Math.hypot(s.x - head.x, s.z - head.z) < 0.5);
let rows = await trace();
await check('walk: climb every tread onto the landing', Math.abs(h.feet - landing) < 0.05, { feet: h.feet, landing, steps: rows.filter((_, i) => i % 5 === 0).map((r) => r[1]) });
await face(sill.x + ox * 2, sill.z + oz * 2);
h = await hold(3000, (s) => s.crossing);
h = await settleCrossing();
rows = await trace();
await check('walk: through the doorway into #3700', h.room === 3700 && h.zone !== homeZone, { room: h.room, zone: h.zone, highest: top(rows) });

// 2. Back down, walked: the Mud School's way down is a shaft in its floor;
// walking at it takes you down, and you arrive on the temple's landing at
// the head of the steps, facing down them.
const shaft = await page.evaluate(() => window.diku.built.decor.find((o) => o.kind === 'gateSign' && o.text === 'down'
  && Math.hypot(o.x - window.diku.built.rooms.get(3700).center.x, o.z - window.diku.built.rooms.get(3700).center.z) < 9));
await check('#3700 has a way down to walk into', !!shaft, shaft);
await face(shaft.x, shaft.z);
await hold(4000, (s) => s.crossing);
h = await settleCrossing();
await check('walk into #3700\'s shaft: arrive in #3001 on the landing', h.room === 3001 && Math.abs(h.feet - landing) < 0.05
  && Math.hypot(h.x - sill.x, h.z - sill.z) < 0.3, h);
await trace();
h = await hold(6000, (s) => Math.abs(s.feet - floor) < 0.02 && Math.hypot(s.x - foot.x, s.z - foot.z) < 0.6);
rows = await trace();
// Every tread trodden, not dropped past: grounded on each frame of the way down.
const airborne = rows.filter((r) => !r[3]).length;
await check('walk down the steps, facing the way you arrived, on every tread', Math.abs(h.feet - floor) < 0.05
  && Math.hypot(h.x - foot.x, h.z - foot.z) < 1.2 && airborne === 0,
  { feet: h.feet, airborne, steps: rows.filter((_, i) => i % 5 === 0).map((r) => r[1]) });

// 3. The foot of the landing, facing its sheer face and the doorway over it:
// no crossing from down here.
await walkTo(sill.x - ox * 1.6, sill.z - oz * 1.6, 0.3);
await face(sill.x + ox * 2, sill.z + oz * 2);
h = await hold(1500);
// The landing's face is 0.8 m in front of the doorway; a body is 0.42 m round.
const intoLanding = (h.x - sill.x) * ox + (h.z - sill.z) * oz;
await check('under the landing, pressing at the doorway above: stopped by its face, stays in #3001',
  h.room === 3001 && !h.crossing && h.zone === homeZone && intoLanding < -1.15, { ...h, intoLanding });

// 4. PgUp from the middle of the hall: the same steps, glided.
await page.evaluate(() => { const c = window.diku.built.rooms.get(3001).center; window.diku.player.spawn(c.x, c.y, c.z, Math.PI); });
await page.waitForTimeout(300);
await trace();
await page.keyboard.press('PageUp');
h = await waitCross(homeZone);
rows = await trace();
const climbed = rows.filter((r) => r[5] === homeZone);
await check('PgUp: up the steps (landing reached before the crossing) into #3700', h.room === 3700 && top(climbed) > landing - 0.05,
  { room: h.room, highest: top(climbed) });

// 5. Typed `up`, after coming back down with PgDn.
await page.keyboard.press('PageDown');
h = await waitCross(h.zone);
await check('PgDn from #3700: arrive in #3001 on the landing', h.room === 3001 && Math.abs(h.feet - landing) < 0.05
  && Math.hypot(h.x - sill.x, h.z - sill.z) < 0.3, h);
await page.evaluate(() => { const c = window.diku.built.rooms.get(3001).center; window.diku.player.spawn(c.x - 2, c.y, c.z + 2, 0); });
await page.waitForTimeout(300);
await trace();
await page.evaluate(() => window.diku.game.interpret('up'));
h = await waitCross(homeZone);
rows = await trace();
await check('typed up: the same steps into #3700', h.room === 3700 && top(rows.filter((r) => r[5] === homeZone)) > landing - 0.05,
  { room: h.room, highest: top(rows.filter((r) => r[5] === homeZone)) });
await page.keyboard.press('PageDown');
h = await waitCross(h.zone);

// 6. The level ways out: south down through the grand gate to the square,
// north to the altar, walked.
await page.evaluate(() => { const c = window.diku.built.rooms.get(3001).center; window.diku.player.spawn(c.x, c.y, c.z, Math.PI); });
await page.waitForTimeout(300);
await trace();
h = await hold(8000, (s) => s.room === 3005);
await page.waitForTimeout(200);
h = await here();
rows = await trace();
const sq = await page.evaluate(() => window.diku.built.rooms.get(3005).center.y);
await check('walk south: down the mound into #3005', h.room === 3005 && rows.every((r) => r[3] === 1 || r[1] > sq - 0.05),
  { room: h.room, feet: h.feet, square: sq, airborne: rows.filter((r) => !r[3]).length });
// North of the fountain: it stands in the square's middle.
await page.evaluate(() => { const c = window.diku.built.rooms.get(3005).center; window.diku.player.spawn(c.x, c.y, c.z - 3, 0); });
h = await hold(9000, (s) => s.room === 3001 && Math.abs(s.feet - floor) < 0.1 && Math.abs(s.z - world.centre.z) < 4);
await check('walk north: back up into #3001', h.room === 3001 && Math.abs(h.feet - floor) < 0.1, h);
await faceYaw(0);
h = await hold(6000, (s) => s.room === 3054);
await check('walk north: into #3054', h.room === 3054, h);
await faceYaw(Math.PI);
h = await hold(6000, (s) => s.room === 3001 && Math.abs(s.z - world.centre.z) < 2);
await check('walk south: back into #3001', h.room === 3001, h);

await check('no page errors', errors.length === 0, errors.slice(0, 5));
if (opt.log) fs.writeFileSync(opt.log, JSON.stringify({ results, errors }, null, 1));
await browser.close();
console.log(failed ? 'temple-walk: FAILED' : 'temple-walk: ok');
process.exit(failed ? 1 : 0);
