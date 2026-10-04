// Film one promo shot frame by frame: the page's clock is replaced by a
// virtual one that only moves when a frame is asked for, so every frame is
// exactly 1/fps of world time apart however long the GPU takes to draw it.
//
//   node tools/promo/capture.mjs --port 8251 --shot tools/promo/shots/temple.json --out /path/dir
//        [--fps 30] [--size 1920x1080] [--scale 2] [--from 0 --to 30] [--still t]
//
// A shot is JSON (see tools/promo/shots/): the room to load, the hour, and
// camera keys `{ t, room, pos: [x, y, z], aim: [x, y, z] }`, both relative to
// the key room's centre on its floor (so y 1.72 is eye height), interpolated
// by a Catmull-Rom spline. `ease` (default true) slows the ends; `preroll`
// seconds are run at the first key before frame 0, so shadows, culling and the
// figures' walk cycles have settled. `setup` (JS run once after the load),
// `events` ({ t, js } run in the page when the shot clock passes t) and `hud`
// (keep the HUD) cover the rest. Frames are written as JPEG; `--still t`
// writes only the frame at t seconds.
//
// What is frozen and how (CLAUDE.md, "Pixel-diffing two page loads"):
// performance.now, Date.now and requestAnimationFrame are virtual, so every
// time uniform, the torch flicker and the walk cycles step by exactly one
// frame; Math.random is a seeded generator from the first script on.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { startBots } from './bots.mjs';

const args = process.argv.slice(2);
const opt = { port: 8251, shot: null, out: null, fps: 30, w: 1920, h: 1080, scale: 1, from: null, to: null, still: null, quality: 92 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--shot') { opt.shot = v; i++; }
  else if (a === '--out') { opt.out = v; i++; } else if (a === '--fps') { opt.fps = +v; i++; }
  else if (a === '--size') { [opt.w, opt.h] = v.split('x').map(Number); i++; }
  else if (a === '--scale') { opt.scale = +v; i++; }
  else if (a === '--from') { opt.from = +v; i++; } else if (a === '--to') { opt.to = +v; i++; }
  else if (a === '--still') { opt.still = v.split(',').map(Number); i++; }
}
if (!opt.shot || !opt.out) throw new Error('capture: --shot and --out are required');
const shot = JSON.parse(fs.readFileSync(opt.shot, 'utf8'));
// A take replaces the one before it: the directory is emptied here, and only
// ever under the promo's own folder outside the repo.
const TAKES = '/Users/yeb/Movies/diku3d-promo/';
const outDir = path.resolve(opt.out);
if (fs.existsSync(outDir) && !opt.still && opt.from === null) {
  if (!outDir.startsWith(TAKES) || outDir.length <= TAKES.length) throw new Error(`capture: refusing to empty ${outDir}`);
  for (const f of fs.readdirSync(outDir)) if (/^f\d{5}\.jpg$/.test(f)) fs.rmSync(path.join(outDir, f));
}
fs.mkdirSync(opt.out, { recursive: true });

// ------------------------------------------------------------ the path ---

const keys = shot.keys;
const duration = shot.seconds ?? keys[keys.length - 1].t;
const smooth = (u) => u * u * (3 - 2 * u);
/** Shot time to path time: the ends ease in and out over `easeIn`/`easeOut` seconds. */
function warp(t) {
  if (shot.ease === false) return t;
  const a = shot.easeIn ?? Math.min(1.2, duration / 3);
  const b = shot.easeOut ?? Math.min(1.2, duration / 3);
  // Constant speed in the middle, a quadratic ramp at each end; normalised so
  // the warped clock still runs from 0 to `duration`.
  const v = 1 / (duration - a / 2 - b / 2);
  let s;
  if (t < a) s = (v * t * t) / (2 * a);
  else if (t > duration - b) { const r = duration - t; s = 1 - (v * r * r) / (2 * b); }
  else s = v * (a / 2) + v * (t - a);
  return Math.max(0, Math.min(1, s)) * duration;
}
const cr = (p0, p1, p2, p3, u) => {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
};
function sample(field, t) {
  if (keys.length === 1) return keys[0][field];
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const k1 = keys[i], k2 = keys[i + 1];
  const k0 = keys[i - 1] || k1, k3 = keys[i + 2] || k2;
  const u = Math.max(0, Math.min(1, (t - k1.t) / (k2.t - k1.t)));
  return [0, 1, 2].map((c) => cr(k0[field][c], k1[field][c], k2[field][c], k3[field][c], u));
}

// ------------------------------------------------------------ the page ---

const clock = `(() => {
  let seed = ${shot.seed ?? 1993} >>> 0;
  Math.random = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const realNow = performance.now.bind(performance);
  const realDate = Date.now;
  const realRaf = window.requestAnimationFrame.bind(window);
  let virtual = false, vt = 0, base = 0;
  const queue = [];
  performance.now = () => (virtual ? vt : realNow());
  Date.now = () => (virtual ? base + vt : realDate());
  window.requestAnimationFrame = (cb) => { if (virtual) { queue.push(cb); return queue.length; } return realRaf(cb); };
  window.__promo = {
    start() { vt = realNow(); base = realDate() - vt; virtual = true; },
    step(ms) { vt += ms; const q = queue.splice(0); for (const cb of q) cb(vt); return q.length; },
    get time() { return vt; },
  };
})();`;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: opt.w, height: opt.h }, deviceScaleFactor: opt.scale });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(clock);
const query = new URLSearchParams({ room: String(shot.room), time: shot.time || 'dusk', quality: shot.quality || 'high', ...(shot.query || {}) });
const t0 = Date.now();
await page.goto(`http://localhost:${opt.port}/?${query}`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 240000 });
await page.waitForTimeout(shot.wait ?? 8000);
// A shot with `mud` is filmed on a running server: the page logs in as the
// camera's player and `bots` (tools/promo/bots.mjs) log in beside it.
let party = {};
if (shot.mud) {
  const m = shot.mud;
  await page.click('#connect-open');
  await page.fill('#connect-address', `localhost:${m.port}`);
  await page.fill('#connect-name', m.camera);
  await page.fill('#connect-password', m.password);
  await page.click('#connect-go');
  await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__heard = []; window.diku.game.listen((e) => { if (e.text) window.__heard.push(e.text); }); });
  party = await startBots(m.bots || [], { port: m.port, password: m.password });
  await page.waitForTimeout(1500);
}
await page.evaluate(({ hud }) => {
  const d = window.diku;
  for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden');
  const style = document.createElement('style');
  style.textContent = `#title,#loading,#toast,#title-veil,#help-hint{display:none!important}${hud ? '' : '#hud,#game-ui{display:none!important}'}`;
  document.head.appendChild(style);
  d.state.paused = false;
  d.quality.setScale(3); // full resolution, every frame: no adaptive scaler
  d.player.update = () => {};
  const fxUpdate = d.fx.update.bind(d.fx);
  d.fx.update = (dt) => { fxUpdate(dt); d.fx.viewModel.scene.visible = false; };
}, { hud: !!shot.hud });
for (const js of [].concat(shot.setup || [])) {
  const r = await page.evaluate(`(async () => { ${js} })()`);
  if (r !== undefined) console.log('setup:', JSON.stringify(r));
}
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

await page.evaluate(() => window.__promo.start());
const pose = (t) => {
  const k = warp(t);
  // Which room a point is relative to: the key at or before it.
  let i = 0;
  while (i < keys.length - 1 && k >= keys[i + 1].t) i++;
  return { pos: sample('pos', k), aim: sample('aim', k), room: keys[i].room ?? shot.room, keyRooms: keys.map((q) => q.room ?? shot.room), fov: shot.fov ?? null };
};
// Every key is placed in its own room's frame, so positions are converted to
// world space per key before interpolating: resolve the centres once.
const centres = await page.evaluate((rooms) => {
  const out = {};
  for (const v of rooms) {
    const info = window.diku.built.rooms.get(v);
    if (!info) throw new Error(`capture: room ${v} is not built in this zone`);
    out[v] = [info.center.x, info.center.y, info.center.z];
  }
  return out;
}, [...new Set(keys.filter((k) => !k.local).map((k) => k.room ?? shot.room))]);
// `base: { shoot: vnum, back, aimDist }` frames the shot the way diku.shoot()
// does (vantage() picks a clear stand facing the room's subject); keys then
// give `local: [right, up, forward]` offsets from that stand, in metres, and
// the camera keeps looking at the point `aimDist` ahead of it (`aimLocal`
// moves that point the same way).
let frame = null;
if (shot.base) {
  frame = await page.evaluate((b) => {
    const d = window.diku;
    let r;
    if (b.mob) {
      // Frame a mobile by keyword: stand where vantage() says, facing it.
      const slot = d.game.mobs.find((m) => m.here && !m.dead && m.figure && m.proto.keywords.includes(b.mob)
        && (b.shoot === undefined || m.roomVnum === b.shoot));
      if (!slot) throw new Error(`capture: no ${b.mob} here; here: ${d.game.mobs.filter((m) => m.here && !m.dead).filter((m) => b.shoot === undefined || Math.abs(m.roomVnum - b.shoot) < 20).map((m) => `${m.proto.keywords}@${m.roomVnum}`).slice(0, 40).join(", ")}`);
      const f = slot.figure.object.position;
      const aim = f.clone(); aim.y += (slot.figure.height || 1) * 0.6;
      let stand = d.vantage(slot.roomVnum, aim, slot.figure, b.back);
      if (b.sunSide !== undefined) {
        // Stand on the sun's side of the subject, turned `sunSide` degrees
        // off it, so what is filmed is lit and not a silhouette.
        const sx = d.sun.position.x - d.sun.target.position.x; const sz = d.sun.position.z - d.sun.target.position.z;
        const a = Math.atan2(sx, sz) + b.sunSide * Math.PI / 180;
        stand = { x: aim.x + Math.sin(a) * b.back, z: aim.z + Math.cos(a) * b.back };
      }
      const eye = d.built.rooms.get(slot.roomVnum).center.y + 1.72 + (b.lift || 0);
      d.look(stand.x, eye - 1.72, stand.z, Math.atan2(stand.x - aim.x, stand.z - aim.z), Math.atan2(aim.y - eye, Math.hypot(aim.x - stand.x, aim.z - stand.z)));
      r = { mob: slot.proto.short, room: slot.roomVnum };
    } else r = d.shoot(b.shoot, { back: b.back, pitch: b.pitch });
    const p = d.camera.position; const yaw = d.camera.rotation.y; const pitch = d.camera.rotation.x;
    return { r, p: [p.x, p.y, p.z], yaw, pitch };
  }, shot.base);
  console.log('base:', JSON.stringify(frame.r));
}
for (const k of keys) {
  if (k.local) {
    const { p, yaw } = frame;
    const pitch = shot.base.pitch ?? frame.pitch;
    const F = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const R = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const U = [0, 1, 0];
    const at = (o) => [0, 1, 2].map((i) => p[i] + R[i] * o[0] + U[i] * o[1] + F[i] * o[2]);
    const dist = shot.base.aimDist ?? 8;
    k.pos = at(k.local);
    k.aim = at([...(k.aimLocal || [0, 0, 0]).slice(0, 2), dist + (k.aimLocal?.[2] || 0)]);
    continue;
  }
  const c = centres[k.room ?? shot.room];
  k.pos = k.pos.map((v, i) => v + c[i]);
  k.aim = k.aim.map((v, i) => v + c[i]);
}

const place = (cam, settle) => page.evaluate(({ cam, settle }) => {
  const d = window.diku;
  const [x, y, z] = cam.pos; const [ax, ay, az] = cam.aim;
  const dx = ax - x, dy = ay - y, dz = az - z;
  d.player.position.set(x, y, z);
  d.camera.position.set(x, y, z);
  d.camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0);
  if (cam.fov && d.camera.fov !== cam.fov) { d.camera.fov = cam.fov; d.camera.updateProjectionMatrix(); }
  d.camera.updateMatrixWorld();
  if (settle) d.built.horizon?.settle(d.camera.position);
}, { cam, settle });

const step = async (ms) => {
  await page.evaluate((ms) => window.__promo.step(ms), ms);
  // Let the after-frame task (cell visibility) run before the next frame.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
};

const frameMs = 1000 / opt.fps;
/**
 * A bot event: `cmd` is typed; `stand: [x, y, z]` (relative to `room`, or
 * the shot's room) puts the bot there, facing `face: [x, z]` (a point in the
 * same frame) or `yaw`.
 */
async function botEvent(e) {
  const bot = party[e.bot];
  if (!bot) throw new Error(`capture: no bot ${e.bot}`);
  let spot = null; let x; let y; let z;
  if (e.stand) {
    // Relative to the room's centre, or with `near: keyword` to a mobile.
    const place = await page.evaluate(({ room, near }) => {
      const d = window.diku;
      const info = d.built.rooms.get(room);
      if (near) {
        const slot = d.game.mobs.find((m) => m.here && !m.dead && m.figure && m.proto.keywords.includes(near) && m.roomVnum === room);
        if (!slot) throw new Error(`capture: no ${near} to stand near`);
        const p = slot.figure.object.position;
        return { zone: d.zone.id, c: [p.x, d.built.rooms.get(slot.roomVnum).center.y, p.z] };
      }
      return { zone: d.zone.id, c: [info.center.x, info.center.y, info.center.z] };
    }, { room: e.room ?? shot.room, near: e.near || null });
    [x, y, z] = e.stand.map((v, i) => v + place.c[i]);
    spot = place;
    if (e.orbit && frame) {
      // [degrees, metres] round the subject, 0 being straight at the camera.
      const a = Math.atan2(frame.p[0] - place.c[0], frame.p[2] - place.c[2]) + e.orbit[0] * Math.PI / 180;
      x = place.c[0] + Math.sin(a) * e.orbit[1]; z = place.c[2] + Math.cos(a) * e.orbit[1];
    }
    const yaw = e.face ? Math.atan2(-(e.face[0] + place.c[0] - x), -(e.face[1] + place.c[2] - z)) : (e.yaw ?? 0);
    bot.stand(place.zone, x, y, z, yaw);
  }
  if (e.walk) {
    const place = spot;
    // Walk from `stand` to `walk` (same frame) over `seconds` of wall time,
    // reporting ten times a second as a page would.
    const to = e.walk.map((v, i) => v + place.c[i]);
    const from = [x, y, z];
    const yaw = Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
    const t0 = Date.now(); const ms = (e.seconds || 4) * 1000;
    const timer = setInterval(() => {
      const u = Math.min(1, (Date.now() - t0) / ms);
      bot.stand(place.zone, ...from.map((v, i) => v + (to[i] - v) * u), yaw);
      if (u >= 1) clearInterval(timer);
    }, 100);
  }
  if (e.cmd) bot.cmd(e.cmd);
}
const events = (shot.events || []).map((e) => ({ ...e, done: false }));
const fire = async (t) => {
  for (const e of events) {
    if (e.done || e.t > t + 1e-6) continue;
    e.done = true;
    if (e.bot) { await botEvent(e); continue; }
    const r = await page.evaluate(`(async () => { ${e.js} })()`);
    if (r !== undefined) console.log(`event @${e.t}:`, JSON.stringify(r));
  }
};

// Pre-roll at the first pose: shadows, culling, AO history, animations.
// Camera first, then the hour (CLAUDE.md): the sun's shadow map is drawn
// round the camera of the last frame.
await place(pose(0), true);
await page.evaluate((t) => window.diku.applyTime(t), shot.time || 'dusk');
const preroll = Math.round((shot.preroll ?? 2) * opt.fps);
for (let i = 0; i < preroll; i++) {
  await fire((i - preroll) / opt.fps); // an event with a negative t happens in the pre-roll
  if (shot.mud) await new Promise((r) => setTimeout(r, frameMs));
  await step(frameMs);
}

const total = Math.round(duration * opt.fps);
const first = opt.from !== null ? Math.round(opt.from * opt.fps) : 0;
const last = opt.to !== null ? Math.min(total, Math.round(opt.to * opt.fps)) : total;
const stills = opt.still ? new Set(opt.still.map((s) => Math.round(s * opt.fps))) : null;
const started = Date.now();
let written = 0;
for (let f = 0; f < last; f++) {
  const t = f / opt.fps;
  // On a server the world runs on the wall clock: hold every frame to it.
  if (shot.mud) {
    const due = started + (f - Math.min(f, first)) * frameMs;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await fire(t);
  await place(pose(t), false);
  await step(frameMs);
  if (f < first || (stills && !stills.has(f))) continue;
  const file = path.join(opt.out, `f${String(f).padStart(5, '0')}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: opt.quality, scale: 'css' });
  written++;
  if (written % 30 === 0) console.log(`frame ${f}/${last} (${((Date.now() - started) / written).toFixed(0)} ms/frame)`);
}
console.log(`${written} frames in ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (errors.length) console.log('page errors:', errors.slice(0, 8).join('\n'));
for (const bot of Object.values(party)) bot.cmd('quit');
await new Promise((r) => setTimeout(r, 800));
for (const bot of Object.values(party)) { if (shot.mudLog) console.log(`${bot.name} heard:\n  ${bot.heard.slice(-40).join('\n  ')}`); bot.close(); }
if (shot.mud) {
  const heard = await page.evaluate(() => (window.__heard || []).slice(-60));
  if (shot.mudLog) console.log(`camera heard:\n  ${heard.join('\n  ')}`);
}
await browser.close();
