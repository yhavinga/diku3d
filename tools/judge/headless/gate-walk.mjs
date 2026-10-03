// Walk through Midgaard's West Gate crossing and back, on the keys, then try
// to get at the gate from behind.
//
// #3040 "Inside the West Gate of Midgaard" goes north to #101 "Dimly Lit
// Path" (smurf.are, a zone of its own) and #101 comes south again. The grid
// routes the street from #3012 to the Magic Shop past the far side of
// #3040's north edge, which is how the gate used to be walkable round, seen
// from the back, and walked through without crossing (crossings.mjs counts
// that for every crossing; this is the one it was reported at).
//
//   cp <repo>/tools/judge/headless/gate-walk.mjs /tmp/pw/
//   node /tmp/pw/gate-walk.mjs --port 8173 [--shots /tmp/gw]
//
// Prints each leg and `PASS` or `FAIL` with the reason; exits 1 on a fail.
// With --shots, the gate from in front and from the street behind at noon
// and dusk, and the minimap at both places, cropped and enlarged.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = { port: 8173, shots: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') opt.port = +args[++i];
  else if (args[i] === '--shots') opt.shots = args[++i];
}

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${opt.port}/`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 180000 });
await page.waitForTimeout(8000);
await page.evaluate(() => {
  for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden');
  window.diku.state.paused = false;
});

const fails = [];
const sleep = (ms) => page.waitForTimeout(ms);
const where = () => page.evaluate(() => {
  const d = window.diku; const p = d.player.position;
  return { zone: d.zone.id, room: d.state.roomVnum, x: +p.x.toFixed(2), z: +p.z.toFixed(2), crossing: !!d.state.crossing };
});
const settle = async () => {
  await page.waitForFunction(() => !window.diku.state.crossing, null, { timeout: 120000 });
  await sleep(1500);
};
const face = (yaw) => page.evaluate((y) => window.diku.camera.rotation.set(0, y, 0), yaw);
const hold = async (key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
// Stand `back` metres in front of a crossing's gate, facing through it.
const before = (room, dir, back) => page.evaluate(({ room, dir, back }) => {
  const d = window.diku;
  const g = d.built.crossings.find((c) => c.room === room && c.dir === dir);
  if (!g) return null;
  const yaw = Math.atan2(-g.out[0], -g.out[1]);
  d.look(g.x - g.out[0] * back, g.y + 1.72, g.z - g.out[1] * back, yaw, 0);
  return { x: g.x, z: g.z, out: g.out, back: g.back, yaw };
}, { room, dir, back });
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const shoot = async (name) => { if (opt.shots) await page.screenshot({ path: `${opt.shots}/${name}.png` }); };
const map = async (name) => {
  if (!opt.shots) return;
  const box = await page.evaluate(() => { const r = document.getElementById('minimap').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await page.screenshot({ path: `${opt.shots}/${name}.png`, clip: box, scale: 'device' });
};

// 1. Into the gate from #3040, walking.
await page.evaluate(() => window.diku.goto(3040, 0, 0));
await sleep(1500);
const gate = await before(3040, 0, 4);
check(!!gate, '#3040 has a crossing record for north');
await sleep(800);
await hold('KeyW', 2500);
await settle();
let at = await where();
check(at.zone === 'smurf', `walking north into the gate from #3040 crosses to smurf (now ${at.zone}, room ${at.room})`);

// 2. And back, walking into #101's gate south.
const back = await before(101, 2, 4);
check(!!back, '#101 has a crossing record for south');
await sleep(800);
await hold('KeyW', 2500);
await settle();
at = await where();
check(at.zone === 'home' && at.room === 3040, `walking south into #101's gate comes back to #3040 (now ${at.zone}, room ${at.room})`);

// 3. Round it: 5 m east out of the middle of #3040, clear of the gate's
// side, then north as far as it goes.
await page.evaluate(() => window.diku.goto(3040, 0, 0));
await sleep(1200);
await face(-Math.PI / 2); await hold('KeyW', 1050);
await face(0); await hold('KeyW', 2600);
at = await where();
const behindPlane = (p) => (p.x - gate.x) * gate.out[0] + (p.z - gate.z) * gate.out[1];
check(behindPlane(at) < 0, `walking north past the gate's side stops short of its plane (${behindPlane(at).toFixed(2)} m)`);

// 4. From the street behind it (put there: the street is the Magic Shop's),
// walking south at it: no crossing, and no way through.
await page.evaluate(({ x, z, out }) => {
  const d = window.diku; d.look(x + out[0] * 6.5, 1.72, z + out[1] * 6.5, Math.atan2(out[0], out[1]), 0);
}, gate);
await sleep(800);
const start = await where();
await hold('KeyW', 3000);
await sleep(600);
at = await where();
check(at.zone === 'home' && !at.crossing, `walking into the back of the gate does not cross (zone ${at.zone})`);
check(behindPlane(at) > gate.back, `...and stops at its back wall (${behindPlane(at).toFixed(2)} m out, back at ${gate.back.toFixed(2)}; started ${behindPlane(start).toFixed(2)})`);

// 5. Pictures, both sides, noon and dusk; the map at both places.
if (opt.shots) {
  for (const time of ['noon', 'dusk']) {
    await page.evaluate((t) => window.diku.applyTime(t), time);
    await before(3040, 0, 7);
    await sleep(2000);
    await shoot(`front-${time}`);
    if (time === 'noon') await map('map-front');
    await page.evaluate(({ x, z, out }) => {
      const d = window.diku; d.look(x + out[0] * 9 + 3, 1.72, z + out[1] * 9, Math.atan2(out[0], out[1]) - 0.3, 0.05);
    }, gate);
    await sleep(2000);
    await shoot(`back-${time}`);
    if (time === 'noon') await map('map-back');
  }
}
await browser.close();
console.log(fails.length ? `FAIL: ${fails.length}` : 'PASS');
process.exit(fails.length ? 1 : 0);
