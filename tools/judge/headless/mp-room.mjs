// One page on a local diku3d server, counted in rooms twice -- by the page,
// every frame, on its own position, and by the server, every tick, on the last
// report it believed -- while it walks the three kinds of ground the count
// tells apart: a street, open ground and a stair. After every move, standing
// still, the page's room, the server's and the reference rule's at the
// server's position (roomcount.mjs `loadReference`) must be one room, on the
// body's level; over each leg the page and the server must list the same rooms
// in the same order; and the server must refuse and put back nothing. A leg
// must also have been where it says (on a street, on open ground, on level 1),
// or it checks nothing. Prints a line per check and exits 1 if any fails.
//   cp <repo>/tools/judge/headless/mp-room.mjs /tmp/pw/mp-room-<you>.mjs
//   node /tmp/pw/mp-room-<you>.mjs --repo <checkout> --port 8251
// The checkout is served on --port (`python3 serve.py 8251` in it); its
// server/mud.mjs is started here, on a port of its own, with a seed.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = { repo: null, port: 8173 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--repo') { opt.repo = v; i++; } else if (a === '--port') { opt.port = +v; i++; }
  else throw new Error(`mp-room: what is ${a}?`);
}
if (!opt.repo) throw new Error('mp-room: --repo <the diku3d checkout> is needed');
const repo = path.resolve(opt.repo);
const mod = (p) => import(pathToFileURL(path.join(repo, p)).href);
const { startMud } = await mod('server/mud.mjs');
const { LEVEL_H } = await mod('server/world.mjs');
const { loadReference } = await mod('tools/judge/headless/roomcount.mjs');

const NAME = 'Counter';
const EYE = 1.72;
const DIRS = ['north', 'east', 'south', 'west', 'up', 'down'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

const logs = [];
const mud = await startMud({ root: repo, dataDir: fs.mkdtempSync('/tmp/dk/mp-room-'), port: 0, seed: 7, log: (t) => logs.push(t) });
const ref = (await loadReference(repo))({
  world: mud.world.world, rooms: mud.world.built.rooms, links: mud.world.layout.links, zoneOf: (v) => mud.world.plan.zoneOf(v),
});
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

let sampler = null;
try {
  await page.goto(`http://localhost:${opt.port}/`);
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 180000 });
  await page.waitForTimeout(6000);
  await page.click('#connect-open');
  await page.fill('#connect-address', `localhost:${mud.port}`);
  await page.fill('#connect-name', NAME);
  await page.fill('#connect-password', 'counting1');
  await page.click('#connect-go');
  await page.waitForFunction(() => !document.getElementById('connect-new').hidden || !!(window.diku && window.diku.link), null, { timeout: 10000 });
  if (!(await page.isHidden('#connect-new'))) {
    await page.fill('#connect-password2', 'counting1');
    await page.click('#connect-class button:nth-child(1)');
    await page.click('#connect-go');
  }
  await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 10000 });
  // The page's side: every change of the room it counts, on the frame it counts it.
  await page.evaluate(() => {
    const d = window.diku;
    d.state.paused = false;
    window.__at = [];
    d.link.link.on('at', (m) => window.__at.push(m));
    window.__rooms = [];
    let last;
    const frame = () => {
      const room = d.game.state.roomVnum;
      if (room !== last) { last = room; window.__rooms.push([performance.now(), room]); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // A new leg lists the rooms from the one the body is in then.
    window.__mark = () => { window.__rooms.length = 0; last = undefined; return performance.now(); };
  });
  const pc = mud.game.players.find((p) => p.ch.name === NAME);
  if (!pc) throw new Error(`mp-room: the server has no player ${NAME}`);

  // The server's side: every change of the room it counts (a tick is 50 ms), and
  // what kind of ground the body stood on, by the reference rule's own regions.
  let leg = null;
  const feetOf = () => ({ x: pc.position.x, y: pc.position.y - EYE, z: pc.position.z });
  const kindOf = (where) => (where.room !== undefined ? 'room' : where.streets ? 'street' : 'open');
  sampler = setInterval(() => {
    if (!leg) return;
    const room = pc.ch.roomVnum;
    if (room !== leg.last) { leg.last = room; leg.server.push([Date.now(), room]); }
    const feet = feetOf();
    const kind = kindOf(ref.region(feet));
    leg.kinds[kind] = (leg.kinds[kind] || 0) + 1;
    leg.levels.add(Math.round(feet.y / LEVEL_H));
  }, 10);

  /** The page's eye, whether a glide is under way, and the room the page counts. */
  const pageAt = () => page.evaluate(() => {
    const d = window.diku; const p = d.player.position;
    return { x: p.x, y: p.y, z: p.z, gliding: d.player.gliding, room: d.game.state.roomVnum };
  });
  /** Until the body has not moved for `ms`: a glide, a fade and a portal are over. */
  async function standStill(ms = 800) {
    let from = await pageAt();
    let since = Date.now();
    const stop = Date.now() + 20000;
    while (Date.now() < stop) {
      await sleep(100);
      const now = await pageAt();
      if (now.gliding || Math.hypot(now.x - from.x, now.y - from.y, now.z - from.z) > 0.01) { from = now; since = Date.now(); }
      else if (Date.now() - since >= ms) return true;
    }
    return false;
  }
  const listing = (list, t0) => list.map(([t, room]) => `#${room}@${((t - t0) / 1000).toFixed(1)}`).join(' ');

  /** Put the body in `vnum` the way goto does, and start a leg's lists from there. */
  async function startLeg(name, vnum) {
    leg = null;
    if (!mud.place(pc.id, vnum)) throw new Error(`mp-room: place(#${vnum}) walked instead of jumping: the body is in or beside it already`);
    await page.waitForFunction((v) => window.diku.game.state.roomVnum === v, vnum, { timeout: 30000, polling: 100 });
    const stop = Date.now() + 30000;
    while (pc.ch.roomVnum !== vnum) {
      if (Date.now() > stop) throw new Error(`mp-room: the server never counted #${vnum} after place`);
      await sleep(50);
    }
    await page.waitForTimeout(1500);
    const pageT0 = await page.evaluate(() => window.__mark());
    leg = { name, room: vnum, last: undefined, server: [], kinds: {}, levels: new Set(), pageT0, serverT0: Date.now() };
    await sleep(200);
  }

  /** Standing still: one room for the page, the server and the reference rule, on the body's level. */
  async function compare(what, expect, arrived = true) {
    const rested = await standStill();
    const there = await pageAt();
    const feet = feetOf();
    const server = pc.ch.roomVnum;
    const got = ref.at(feet, leg.room);
    const want = got === null ? leg.room : got;
    leg.room = server;
    const info = mud.world.built.rooms.get(server);
    const level = Math.round(feet.y / LEVEL_H);
    const ok = arrived && rested && there.room === server && server === want && !!info && info.cell.level === level
      && (expect === undefined || server === expect);
    check(ok, `${leg.name}: ${what}`,
      `page #${there.room}, server #${server}, reference #${want}${expect !== undefined ? `, expected #${expect}` : ''}`
      + `, room's level ${info ? info.cell.level : '-'}, body's ${level}, on ${kindOf(ref.region(feet))}`
      + `, at ${feet.x.toFixed(1)} ${feet.y.toFixed(2)} ${feet.z.toFixed(1)}`
      + `${arrived ? '' : ', the page never counted it'}${rested ? '' : ', never came to rest'}`);
  }

  /** A typed direction (the glides and fades a page really makes), then standing still. */
  async function typed(dir, to) {
    const from = leg.room;
    const exit = mud.world.world.rooms.get(from).exits[DIRS.indexOf(dir)];
    if (!exit || exit.to !== to) throw new Error(`mp-room: #${from} has no ${dir} exit to #${to}; the world has changed under this leg`);
    await page.evaluate((word) => { window.diku.game.interpret(word); }, dir);
    const arrived = await page.waitForFunction((v) => window.diku.game.state.roomVnum === v, to, { timeout: 15000, polling: 50 })
      .then(() => true, () => false);
    await compare(`${dir} to #${to}`, to, arrived);
  }

  /** Keys held down for `ms`, facing `yaw`, then standing still. */
  async function walked(what, yaw, ms) {
    await page.evaluate((y) => { window.diku.player.camera.rotation.y = y; }, yaw);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(ms);
    await page.keyboard.up('KeyW');
    await compare(what);
  }

  /** The leg is over: the page's list against the server's, and where the body has been. */
  async function endLeg(needs) {
    await sleep(300);
    const pageList = await page.evaluate(() => window.__rooms.slice());
    const rooms = (list) => list.map(([, room]) => room).join(' ');
    check(rooms(pageList) === rooms(leg.server), `${leg.name}: the page and the server list the same rooms`, rooms(leg.server));
    console.log(`        page   ${listing(pageList, leg.pageT0)}`);
    console.log(`        server ${listing(leg.server, leg.serverT0)}`);
    const seen = `server samples: ${Object.entries(leg.kinds).map(([k, n]) => `${k} ${n}`).join(', ')}; levels ${[...leg.levels].join(' ')}`;
    for (const [label, ok] of needs(leg)) check(ok, `${leg.name}: ${label}`, seen);
    leg = null;
  }

  // 1. A street: the Market Square to the Main Street and on, and back. The room
  // changes at a street's middle, and the page and the server must see it alike.
  await startLeg('street', 3014);
  await typed('east', 3015);
  await typed('east', 3016);
  await typed('west', 3015);
  await typed('west', 3014);
  await endLeg((l) => [['the body was on a street', (l.kinds.street || 0) > 0]]);

  // 2. Open ground: south from outside the West Gate on to the grass, east, then
  // north -- what the old count got wrong and the server put the player back for.
  await startLeg('open ground', 3052);
  await page.evaluate(() => {
    const d = window.diku; const c = d.built.rooms.get(3052).center;
    d.player.spawn(c.x, c.y, c.z, Math.PI);
  });
  await walked('south on the grass', Math.PI, 4000);
  await walked('east', -Math.PI / 2, 3000);
  await walked('north', 0, 3000);
  await endLeg((l) => [['the body was on open ground', (l.kinds.open || 0) > 0]]);

  // 3. A stair: up from the inn's entrance to the room above it, and down again.
  // A typed up or down here is a fade to the other room, not a walk up the
  // flight (its way has no `route`, main.js step): a change of level is
  // checked, not the 3.8 m at which a walked flight changes rooms.
  await startLeg('stair', 3006);
  await typed('up', 3008);
  await typed('down', 3006);
  await endLeg((l) => [['the body was on level 1', l.levels.has(1)]]);

  check(mud.stats.refused === 0, 'the server refused no report', mud.stats.refused);
  const put = await page.evaluate(() => window.__at);
  check(put.length === 0, 'the page was put back nowhere', put.length ? JSON.stringify(put.slice(0, 3)) : '0');
  check(pageErrors.length === 0, 'the page raised no uncaught error', pageErrors.slice(0, 3).join(' | ') || '0');
} catch (e) {
  check(false, 'the run finished', e.stack || e.message);
} finally {
  if (sampler) clearInterval(sampler);
  for (const line of logs.filter((t) => /refused|error/i.test(t)).slice(0, 6)) console.log(`  log: ${line}`);
  await browser.close();
  await mud.close();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
