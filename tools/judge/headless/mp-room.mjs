// One page on a local diku3d server, counted in rooms twice -- by the page,
// every frame, on its own position, and by the server, every tick, on the last
// report it believed -- while it walks the kinds of ground the count tells
// apart: a street, a street bent round a house, open ground and a stair. After
// every move, standing still, the page's room, the server's and the reference
// rule's at the server's position (roomcount.mjs `loadReference`) must be one
// room, on the body's level; over each leg the page and the server must list
// the same rooms in the same order, and the server the rooms the reference
// lists along the server's own track; and the server must refuse and put back
// nothing. A leg must also have been where it says (on a street, on open
// ground, on level 1), and the last three where the count before wave 17 (the
// room whose middle is nearest the eye) decides otherwise -- or they could not
// fail on what they guard. Prints a line per check and exits 1 if any fails.
//   cp <repo>/tools/judge/headless/mp-room.mjs /tmp/pw/mp-room-<you>.mjs
//   node /tmp/pw/mp-room-<you>.mjs --repo <checkout> --port 8251
// The checkout is served on --port (`python3 serve.py 8251` in it); its
// server/mud.mjs is started here, on a port of its own, with a seed. Against
// a checkout from before wave 17 (with this branch's roomcount.mjs copied in
// for the reference) the bent street, open ground and stair legs fail.
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
// The count before wave 17 (game.js nearestRoom): the room whose middle is
// nearest the eye, in 3D. Only to show that a leg goes where it was wrong.
const middles = [...mud.world.built.rooms].map(([vnum, info]) => [vnum, info.center]);
const oldAt = (eye) => {
  let best = null; let bd = Infinity;
  for (const [vnum, c] of middles) {
    const d = (c.x - eye.x) ** 2 + (c.y - eye.y) ** 2 + (c.z - eye.z) ** 2;
    if (d < bd) { bd = d; best = vnum; }
  }
  return best;
};
const OLD_WRONG = 'the count before wave 17 would have failed it';
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

  // The server's side: every change of the room it counts (a tick is 50 ms),
  // what the reference and the count before wave 17 count along the same
  // track, and what kind of ground the body stood on, by the reference rule's
  // own regions.
  let leg = null;
  const feetOf = () => ({ x: pc.position.x, y: pc.position.y - EYE, z: pc.position.z });
  const kindOf = (where) => (where.room !== undefined ? 'room' : where.streets ? 'street' : 'open');
  sampler = setInterval(() => {
    if (!leg) return;
    const room = pc.ch.roomVnum;
    if (room !== leg.last) { leg.last = room; leg.server.push([Date.now(), room]); }
    const feet = feetOf();
    const counted = ref.at(feet, leg.refLast);
    if (counted !== null && counted !== leg.refLast) { leg.refLast = counted; leg.ref.push([Date.now(), counted]); }
    const before = oldAt(pc.position);
    if (before !== leg.oldLast) { leg.oldLast = before; leg.old.push(before); }
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
    leg = {
      name, room: vnum, last: undefined, server: [], kinds: {}, levels: new Set(), pageT0, serverT0: Date.now(),
      refLast: vnum, ref: [[Date.now(), vnum]], oldLast: vnum, old: [vnum], oldRests: 0,
    };
    await sleep(200);
  }

  /**
   * Standing still: one room for the page, the server and the reference rule,
   * on the body's level. `short` says how the move fell short, if it did.
   */
  async function compare(what, expect, short = '') {
    const rested = await standStill();
    const there = await pageAt();
    const feet = feetOf();
    const server = pc.ch.roomVnum;
    const got = ref.at(feet, leg.room);
    const want = got === null ? leg.room : got;
    const before = oldAt(pc.position);
    if (before !== want) leg.oldRests++;
    leg.room = server;
    const info = mud.world.built.rooms.get(server);
    const level = Math.round(feet.y / LEVEL_H);
    const ok = !short && rested && there.room === server && server === want && !!info && info.cell.level === level
      && (expect === undefined || server === expect);
    check(ok, `${leg.name}: ${what}`,
      `page #${there.room}, server #${server}, reference #${want}${expect !== undefined ? `, expected #${expect}` : ''}`
      + `, before wave 17 #${before}, room's level ${info ? info.cell.level : '-'}, body's ${level}, on ${kindOf(ref.region(feet))}`
      + `, at ${feet.x.toFixed(1)} ${feet.y.toFixed(2)} ${feet.z.toFixed(1)}`
      + `${short ? `, ${short}` : ''}${rested ? '' : ', never came to rest'}`);
  }

  /** A typed direction (the glides and fades a page really makes), then standing still. */
  async function typed(dir, to) {
    const from = leg.room;
    const exit = mud.world.world.rooms.get(from).exits[DIRS.indexOf(dir)];
    if (!exit || exit.to !== to) throw new Error(`mp-room: #${from} has no ${dir} exit to #${to}; the world has changed under this leg`);
    await page.evaluate((word) => { window.diku.game.interpret(word); }, dir);
    const arrived = await page.waitForFunction((v) => window.diku.game.state.roomVnum === v, to, { timeout: 15000, polling: 50 })
      .then(() => true, () => false);
    await compare(`${dir} to #${to}`, to, arrived ? '' : 'the page never counted it');
  }

  /** Keys held down for `ms`, facing `yaw`, then standing still. */
  async function walked(what, yaw, ms, expect) {
    await page.evaluate((y) => { window.diku.player.camera.rotation.y = y; }, yaw);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(ms);
    await page.keyboard.up('KeyW');
    await compare(what, expect);
  }

  /**
   * Keys held down, facing `yaw`, until the feet are at `until.above` or
   * higher, or at `until.below` or lower -- a tread of a flight, which a time
   * would miss -- then standing still.
   */
  async function climbed(what, yaw, until, expect) {
    await page.evaluate((y) => { window.diku.player.camera.rotation.y = y; }, yaw);
    await page.keyboard.down('KeyW');
    const there = await page.waitForFunction((u) => {
      const feet = window.diku.player.position.y - 1.72;
      return u.above !== undefined ? feet >= u.above : feet <= u.below;
    }, until, { polling: 'raf', timeout: 8000 }).then(() => true, () => false);
    await page.keyboard.up('KeyW');
    await compare(what, expect, there ? '' : 'the feet never got there');
  }

  /** The leg is over: the page's list against the server's, and where the body has been. */
  async function endLeg(needs) {
    await sleep(300);
    const pageList = await page.evaluate(() => window.__rooms.slice());
    const rooms = (list) => list.map(([, room]) => room).join(' ');
    check(rooms(pageList) === rooms(leg.server), `${leg.name}: the page and the server list the same rooms`, rooms(leg.server));
    check(rooms(leg.ref) === rooms(leg.server), `${leg.name}: the server lists the rooms the reference does along its track`, rooms(leg.ref));
    console.log(`        page   ${listing(pageList, leg.pageT0)}`);
    console.log(`        server ${listing(leg.server, leg.serverT0)}`);
    console.log(`        ref    ${listing(leg.ref, leg.serverT0)}`);
    // Other rooms along the track, or another room at a rest, and this leg fails the old count.
    leg.oldWrong = leg.old.join(' ') !== rooms(leg.ref) || leg.oldRests > 0;
    const seen = `server samples: ${Object.entries(leg.kinds).map(([k, n]) => `${k} ${n}`).join(', ')}; levels ${[...leg.levels].join(' ')}`
      + `; before wave 17: ${leg.old.join(' ')}, another room at ${leg.oldRests} rests`;
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

  // 2. A bent street: from #3010 south to #3015 the street goes round the
  // Grunting Boar, and the count before wave 17 named the inn's entrance
  // (#3006) on the way, and on the page the room above it (#3008) as well.
  await startLeg('bent street', 3010);
  await typed('south', 3015);
  await typed('north', 3010);
  await endLeg((l) => [['the body was on a street', (l.kinds.street || 0) > 0], [OLD_WRONG, l.oldWrong]]);

  // 3. Open ground: from outside the West Gate west along the street, north on
  // to the grass over the sewer, then east. The nearest room on the body's
  // level is #1100 there and then #3052 again; the count before wave 17 named
  // the sewer room under the grass, #7008, a level down. (Due north of #3052
  // a house on its cell's north side stops the body 2.5 m out.)
  await startLeg('open ground', 3052);
  await page.evaluate(() => {
    const d = window.diku; const c = d.built.rooms.get(3052).center;
    d.player.spawn(c.x, c.y, c.z, Math.PI / 2);
  });
  await walked('west along the street', Math.PI / 2, 2000, 3052);
  await walked('north on to the grass', 0, 4000, 1100);
  await walked('east on the grass', -Math.PI / 2, 2000, 3052);
  await endLeg((l) => [['the body was on open ground', (l.kinds.open || 0) > 0], [OLD_WRONG, l.oldWrong]]);

  // 4. A stair. Typed, up and down are fades to the other room (the way has no
  // `route`, main.js step). Walked, the flight in the inn's entrance climbs a
  // level through its ceiling, and the count changes rooms where the feet pass
  // the half-level, 3.8 m up; before wave 17 it changed where the eye did,
  // with the feet 1.72 m lower, so standing on a tread between the two tells
  // them apart.
  await startLeg('stair', 3006);
  await typed('up', 3008);
  await typed('down', 3006);
  const flight = await page.evaluate((vnum) => {
    const d = window.diku; const c = d.built.rooms.get(vnum).center;
    // A tread is a platform a step deep and a doorway wide.
    const treads = d.built.platforms.filter((p) => p.top > c.y + 0.1 && p.top < c.y + 7.5
      && Math.min(p.x1 - p.x0, p.z1 - p.z0) < 0.5
      && Math.abs((p.x0 + p.x1) / 2 - c.x) < 6.5 && Math.abs((p.z0 + p.z1) / 2 - c.z) < 6.5)
      .sort((a, b) => a.top - b.top);
    const mid = (p) => ({ x: (p.x0 + p.x1) / 2, y: p.top, z: (p.z0 + p.z1) / 2 });
    return treads.length >= 10 ? { foot: mid(treads[0]), head: mid(treads[treads.length - 1]) } : null;
  }, 3006);
  if (!flight) throw new Error('mp-room: #3006 has no flight of treads; the inn has changed under this leg');
  const upward = Math.atan2(-(flight.head.x - flight.foot.x), -(flight.head.z - flight.foot.z));
  // The flight starts at a wall: the body is stood on its lowest tread, facing up it.
  await page.evaluate(({ foot, yaw }) => window.diku.player.spawn(foot.x, foot.y, foot.z, yaw), { foot: flight.foot, yaw: upward });
  await climbed('up the flight to a tread below the half-level', upward, { above: 2.9 }, 3006);
  await climbed('on up to the floor above', upward, { above: 7.55 }, 3008);
  await climbed('down again to a tread below the half-level', upward + Math.PI, { below: 3.5 }, 3006);
  await walked('down to the foot', upward + Math.PI, 1500, 3006);
  await endLeg((l) => [['the body was on level 1', l.levels.has(1)], [OLD_WRONG, l.oldWrong]]);

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
