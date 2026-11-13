// The two views and what the arrows do in each (src/view.js, main.js, player.js),
// played the way a new player meets them: a fresh browser, the title's own
// button. Over the shoulder the arrows walk as W, S, A and D do, relative to
// the camera, and turn nothing; through your own eyes they are the mud's
// compass, a step through the exit; PgUp and PgDn are the mud's in both. The
// browser keeps the view across a reload.
//
//   cp <repo>/tools/judge/headless/views.mjs /tmp/pw/
//   timeout 600 node /tmp/pw/views.mjs --port 8173
//
// Prints one line per check and exits 1 if any failed.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = { port: 8173 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') opt.port = +args[++i];
}

const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
// A context of its own: nothing kept from any other run, as for a new player.
const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const wait = (ms) => page.waitForTimeout(ms);

let failed = false;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed = true;
}

/** Load (or reload) the page and go in by the title's button, as a player does. */
async function enter(reload) {
  if (reload) await page.reload();
  else await page.goto(`http://localhost:${opt.port}/?room=3014`);
  await page.waitForFunction(() => window.diku && window.diku.built && window.diku.title, null, { timeout: 180000 });
  await wait(1500);
  await page.click('#enter');
  await wait(1200);
}

const here = () => page.evaluate(() => {
  const d = window.diku; const p = d.player.position;
  return { x: p.x, z: p.z, room: d.state.roomVnum ?? d.game.state.roomVnum, zone: d.zone.id, crossing: !!d.state.crossing, gliding: d.player.gliding, yaw: d.camera.rotation.y, third: d.view.third };
});
/** Stand in a room, `dx`, `dz` from its centre, facing `yaw`, without touching the view. */
const standIn = async (vnum, yaw, dx = 0, dz = 0) => {
  await page.evaluate(([v, y, ox, oz]) => {
    const d = window.diku; const c = d.built.rooms.get(v).center;
    d.player.spawn(c.x + ox, c.y, c.z + oz, y);
    d.state.roomVnum = null;
  }, [vnum, yaw, dx, dz]);
  await wait(400);
};
// East of the Market Square's statue (which fills x -5.3..-1.4, z -2.7..1.2
// from the centre), facing north-west: three metres every way is open paving.
const OPEN = [3014, Math.PI / 4, 2.5, -1];
/** Every frame from now: was the player ever carried by a glide (the compass's step)? */
const watchGlide = () => page.evaluate(() => {
  window.__glided = false;
  const tick = () => { if (window.diku.player.gliding) window.__glided = true; if (!window.__stopGlide) requestAnimationFrame(tick); };
  window.__stopGlide = false;
  requestAnimationFrame(tick);
});
const glided = () => page.evaluate(() => { window.__stopGlide = true; return window.__glided; });
/** Hold a key for `ms`, or until `until(here())` holds. */
async function hold(key, ms, until = null) {
  await page.keyboard.down(key);
  const t0 = Date.now();
  let h = await here();
  while (Date.now() - t0 < ms && !(until && until(h))) { await wait(100); h = await here(); }
  await page.keyboard.up(key);
  await wait(250);
  return here();
}
/** Movement from `a` to `b` against the camera's yaw: forward (-sin, -cos), right (cos, -sin). */
const against = (a, b) => {
  const dx = b.x - a.x; const dz = b.z - a.z;
  return {
    forward: +(-dx * Math.sin(a.yaw) - dz * Math.cos(a.yaw)).toFixed(2),
    right: +(dx * Math.cos(a.yaw) - dz * Math.sin(a.yaw)).toFixed(2),
    turned: +Math.abs(b.yaw - a.yaw).toFixed(4),
  };
};
/** Until the player is in `room` and nothing is carrying them, then a moment for the arrival's fade. */
async function waitRoom(room, ms = 60000) {
  const t0 = Date.now();
  let h = await here();
  while (Date.now() - t0 < ms && (h.room !== room || h.crossing || h.gliding)) { await wait(150); h = await here(); }
  await wait(1500);
  return here();
}

// 1. A fresh page starts over the shoulder.
await enter(false);
let h = await here();
check('a fresh page starts over the shoulder', h.third, { third: h.third });
// The arrows are put through their paces over the shoulder however it started.
if (!h.third) { await page.keyboard.press('KeyV'); await wait(300); }

// 2. Up walks along the camera's yaw and takes no exit by itself.
await standIn(...OPEN);
let a = await here();
await watchGlide();
let b = await hold('ArrowUp', 700);
let m = against(a, b);
check('over the shoulder, up walks forward along the camera and takes no exit',
  m.forward > 1.5 && Math.abs(m.right) < 0.25 * m.forward && m.turned < 1e-6 && !(await glided()) && b.room === a.room, { ...m, room: b.room });

// 3. Left walks sideways and does not turn the camera.
await standIn(...OPEN);
a = await here();
await watchGlide();
b = await hold('ArrowLeft', 700);
m = against(a, b);
check('over the shoulder, left walks sideways without turning',
  -m.right > 1.5 && Math.abs(m.forward) < 0.25 * -m.right && m.turned < 1e-6 && !(await glided()) && b.room === a.room, { ...m, room: b.room });

// 4. Down and right, the same.
await standIn(...OPEN);
a = await here();
b = await hold('ArrowDown', 700);
m = against(a, b);
const back = -m.forward > 1.5 && Math.abs(m.right) < 0.25 * -m.forward && m.turned < 1e-6;
await standIn(...OPEN);
a = await here();
b = await hold('ArrowRight', 700);
const mr = against(a, b);
check('over the shoulder, down walks back and right walks right',
  back && mr.right > 1.5 && Math.abs(mr.forward) < 0.25 * mr.right && mr.turned < 1e-6, { down: m, right: mr });

// 5. Walking through an exit with up takes it, as W does: from the temple
// south through its gate to the square (#3005), walked, not glided.
await standIn(3001, Math.PI);
await watchGlide();
h = await hold('ArrowUp', 9000, (s) => s.room === 3005);
check('over the shoulder, up walks through the temple gate into #3005', h.room === 3005 && !(await glided()), { room: h.room });

// 6. PgUp and PgDn are the mud's over the shoulder too: the temple's steps
// up to the Mud School and back.
await standIn(3001, Math.PI);
const homeZone = (await here()).zone;
await page.keyboard.press('PageUp');
h = await waitRoom(3700);
const upOk = h.room === 3700 && h.zone !== homeZone && h.third;
await page.keyboard.press('PageDown');
const down = await waitRoom(3001);
check('over the shoulder, PgUp and PgDn take the exits up and down', upOk && down.room === 3001 && down.third,
  { up: { room: h.room, zone: h.zone }, down: { room: down.room, zone: down.zone } });

// 7. After V, up is the compass again: a step through the north exit.
await page.keyboard.press('KeyV');
await wait(300);
await standIn(3014, 2.2);
const north = await page.evaluate(() => window.diku.world.rooms.get(3014).exits[0]?.to);
await page.keyboard.press('ArrowUp');
h = await waitRoom(north, 6000);
check('after V, first person: up steps through the north exit', !h.third && h.room === north,
  { third: h.third, room: h.room, north });

// 8. A reload starts in the view it was left in: first person now ...
await enter(true);
h = await here();
check('after a reload, first person is kept', h.third === false, { third: h.third });

// ... and over the shoulder after V again.
await page.keyboard.press('KeyV');
await wait(300);
await enter(true);
h = await here();
check('after a reload, over the shoulder is kept', h.third === true, { third: h.third });

if (errors.length) check('no page errors', false, errors.slice(0, 5));
await browser.close();
process.exit(failed ? 1 : 0);
