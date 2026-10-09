// End to end on a lid: two pages on a local server stand over a trapdoor,
// one opens it with E, both pages' leaves must swing, and the opener walks
// down through it with nothing refused; it is shut with the `close` command
// from below, the body walking up the flight is stopped under it and nothing
// is refused; `up` is refused while it is shut; `open` opens it again and the
// body walks out at the top. Then the same in a page with no server.
//
//   cp <repo>/tools/judge/headless/mp-hatch.mjs /tmp/pw/
//   node /tmp/pw/mp-hatch.mjs --repo <repo> --port 8252 [--room 1317 --below 1321]
//
// The pages are served on --port (python3 serve.py <port>); the server is
// started here (server/mud.mjs `startMud`, port 0, a fresh data dir). Prints
// what each step measured and exits 1 if any check failed.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = { repo: null, port: 8252, room: 1317, below: 1321, data: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--repo') { opt.repo = v; i++; }
  else if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--room') { opt.room = +v; i++; }
  else if (a === '--below') { opt.below = +v; i++; }
  else if (a === '--data') { opt.data = v; i++; }
}
if (!opt.repo) throw new Error('mp-hatch: --repo <the diku3d checkout> is needed, for the server');
const { startMud } = await import(pathToFileURL(path.join(opt.repo, 'server/mud.mjs')).href);
const { EX_CLOSED } = await import(pathToFileURL(path.join(opt.repo, 'src/are.js')).href);
const data = opt.data || fs.mkdtempSync('/tmp/dk/w15-hatches-mud-');
const log = [];
const mud = await startMud({ root: opt.repo, dataDir: data, port: 0, seed: 7, log: (t) => log.push(t) });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
};
const exitShut = (vnum, dir) => !!(mud.game.world.rooms.get(vnum).exits[dir].locks & EX_CLOSED);

/** In the page: the lid over the way down from `room`, and where to stand by it. */
const LID = `(() => {
  const d = window.diku;
  const lid = [...d.actors.lids.values()].find((l) => l.faces.some((f) => f.spec.room === __ROOM__ && f.spec.dir === 5));
  if (!lid) return null;
  const face = lid.faces.find((f) => f.pivots.length) || lid.faces[0];
  const s = face.spec;
  const cell = d.layout.cells.get(__ROOM__);
  const cx = cell.x * 13, cz = cell.z * 13, top = cell.level * 7.6;
  // Down the flight: from the room's middle towards the lid (build.js lays it so).
  let ax = s.x - cx, az = s.z - cz; const n = Math.hypot(ax, az); ax /= n; az /= n;
  return { lid, face, s, cx, cz, top, ax, az, h: s.hatch };
})()`;

async function page(name, server) {
  const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
  p.on('pageerror', (e) => console.log(name, 'pageerror', e.message));
  await p.goto(`http://localhost:${opt.port}/`);
  await p.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 240000 });
  await p.waitForTimeout(6000);
  if (server) {
    await p.click('#connect-open');
    await p.fill('#connect-address', `localhost:${mud.port}`);
    await p.fill('#connect-name', name);
    await p.fill('#connect-password', 'opening1');
    await p.click('#connect-go');
    await p.waitForFunction(() => !document.getElementById('connect-new').hidden || !!(window.diku && window.diku.link), null, { timeout: 10000 });
    if (!(await p.isHidden('#connect-new'))) { await p.fill('#connect-password2', 'opening1'); await p.click('#connect-go'); }
    await p.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 10000 });
  } else {
    await p.evaluate(() => { for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden'); });
  }
  await p.evaluate(() => {
    window.__ev = [];
    window.diku.game.listen((e) => window.__ev.push(e));
    window.diku.state.paused = false;
  });
  return p;
}

/** Into the room over the lid: by the server's `place`, or by goto alone. */
async function into(p, pc) {
  if (pc) {
    mud.place(pc.id, opt.room);
    await p.waitForFunction((r) => window.diku.game.state.roomVnum === r, opt.room, { timeout: 240000, polling: 500 });
  } else {
    await p.evaluate((r) => window.diku.goto(r), opt.room);
  }
  await p.waitForTimeout(2500);
}

const lidState = (p) => p.evaluate(`(() => { const L = ${LID.replace(/__ROOM__/g, opt.room)}; if (!L) return null;
  const hinge = L.face.pivots[0]?.node.children[0];
  return { open: L.lid.open, t: +L.face.t.toFixed(2), angle: hinge ? +hinge.rotation.z.toFixed(2) : null, flags: window.diku.game.exitFlags(${opt.room}, 5) }; })()`);
const body = (p) => p.evaluate(() => {
  const d = window.diku;
  return { room: d.game.state.roomVnum, x: +d.player.position.x.toFixed(2), feet: +(d.player.position.y - 1.72).toFixed(2), z: +d.player.position.z.toFixed(2) };
});
/** Face (dx, dz) and hold W for `ms`: the page's own player.js walks it. */
async function walk(p, dir, ms, pitch = 0) {
  await p.evaluate(([dx, dz, pt]) => {
    const c = window.diku.camera;
    c.rotation.set(pt, Math.atan2(-dx, -dz), 0);
  }, [...dir, pitch]);
  await p.keyboard.down('KeyW'); await p.waitForTimeout(ms); await p.keyboard.up('KeyW');
  await p.waitForTimeout(600);
}
/** Look at the lid's leaf from where the body stands, and press E. */
async function pressE(p) {
  await p.evaluate(`(() => { const L = ${LID.replace(/__ROOM__/g, opt.room)};
    const d = window.diku; const c = d.camera;
    const dx = L.s.x - c.position.x, dy = L.s.y - c.position.y, dz = L.s.z - c.position.z;
    c.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0); })()`);
  await p.waitForTimeout(400);
  await p.keyboard.press('KeyE');
  await p.waitForTimeout(1600);
}
const said = (p) => p.evaluate(() => window.__ev.filter((e) => e.text).map((e) => e.text).slice(-4));
const refused = () => mud.stats.refused;

async function run(label, A, B, pcA) {
  console.log(`\n${label}`);
  const L0 = await p0(A);
  check(L0 && L0.open === false && L0.t === 0, 'the lid is shut at boot on the opener\'s page', JSON.stringify(L0));
  if (B) check((await lidState(B))?.open === false, '...and on the other page');
  if (pcA) check(exitShut(opt.room, 5), '...and in the server\'s world');
  // From where a body arrives beside it: look at the leaf, E.
  const r0 = pcA ? refused() : 0;
  await pressE(A);
  await A.waitForTimeout(1200);
  const L1 = await lidState(A);
  check(L1.open === true && L1.t === 1, 'E opens it: the leaf on the opener\'s page has swung', JSON.stringify(L1));
  if (B) { const LB = await lidState(B); check(LB.open === true && LB.t === 1, '...and on the other page', JSON.stringify(LB)); }
  if (pcA) check(!exitShut(opt.room, 5), '...and the server has it open');
  // Down through it, on the keys: to the side of the opening the flight's
  // head is on, then down the flight.
  const geo = await A.evaluate(`(() => { const L = ${LID.replace(/__ROOM__/g, opt.room)};
    const low = L.lid.faces.find((f) => f.spec.room === ${opt.below});
    return { ax: L.ax, az: L.az, cx: L.cx, cz: L.cz, top: L.top, word: (low?.spec.keyword || '').split(/\s+/)[0] || 'up' }; })()`);
  const start = await body(A);
  // Back towards the room's middle along the flight's line, then forward into it.
  await A.evaluate(([cx, cz, ax, az]) => {
    const d = window.diku; const p = d.player;
    p._glide = null;
    // Walk, not jump: a glide is a lerp the page itself uses for a compass step.
    p.glidePath([{ x: cx - ax * 1.8, y: p.position.y - 1.72, z: cz - az * 1.8 }], null, null);
  }, [geo.cx, geo.cz, geo.ax, geo.az]);
  await A.waitForFunction(() => !window.diku.player.gliding, null, { timeout: 15000 });
  await A.waitForTimeout(400);
  await walk(A, [geo.ax, geo.az], 5000);
  const down = await body(A);
  check(down.feet < geo.top - 6, 'the body walks down through it to the floor below', `${JSON.stringify(start)} -> ${JSON.stringify(down)}`);
  if (pcA) {
    await A.waitForTimeout(1500);
    check(refused() === r0, '...with nothing refused', `refused ${r0} -> ${refused()}`);
    check(pcA.ch.roomVnum === opt.below, `...and the server has it in #${opt.below}`, `#${pcA.ch.roomVnum}`);
  }
  // Shut from below by the command.
  await A.evaluate((w) => { window.__ev = []; window.diku.game.interpret(`close ${w}`); }, geo.word);
  await A.waitForTimeout(1800);
  const L2 = await lidState(A);
  check(L2.open === false && L2.t === 0, `\`close ${geo.word}\` from below shuts it`, `${JSON.stringify(L2)} ${JSON.stringify(await said(A))}`);
  if (B) { const LB = await lidState(B); check(LB.open === false && LB.t === 0, '...on the other page too', JSON.stringify(LB)); }
  // Up the flight: stopped under it.
  const r1 = pcA ? refused() : 0;
  await walk(A, [-geo.ax, -geo.az], 6000);
  const stopped = await body(A);
  check(stopped.feet < geo.top - 1.5, 'walking up the flight, the body is stopped under the lid', JSON.stringify(stopped));
  if (pcA) {
    await A.waitForTimeout(1500);
    check(refused() === r1, '...with nothing refused', `refused ${r1} -> ${refused()}`);
    check(pcA.ch.roomVnum === opt.below, `...and the server still has it in #${opt.below}`, `#${pcA.ch.roomVnum}`);
  }
  await A.evaluate(() => { window.__ev = []; });
  const typedUp = await A.evaluate(() => window.diku.game.interpret('up'));
  await A.waitForTimeout(800);
  const upSaid = await said(A);
  check(upSaid.some((t) => /closed/i.test(t)), '`up` is refused while it is shut', JSON.stringify([typedUp, upSaid]));
  // Open it from below by the command, and walk out at the top.
  await A.evaluate((w) => { window.__ev = []; window.diku.game.interpret(`open ${w}`); }, geo.word);
  await A.waitForTimeout(1800);
  const L3 = await lidState(A);
  check(L3.open === true && L3.t === 1, `\`open ${geo.word}\` from below opens it`, `${JSON.stringify(L3)} ${JSON.stringify(await said(A))}`);
  if (B) { const LB = await lidState(B); check(LB.open === true && LB.t === 1, '...on the other page too', JSON.stringify(LB)); }
  const r2 = pcA ? refused() : 0;
  await walk(A, [-geo.ax, -geo.az], 6000);
  const out = await body(A);
  check(out.feet > geo.top - 0.1, 'the body walks up out of it onto the floor above', JSON.stringify(out));
  if (pcA) {
    await A.waitForTimeout(1500);
    check(refused() === r2, '...with nothing refused', `refused ${r2} -> ${refused()}`);
    check(pcA.ch.roomVnum === opt.room, `...and the server has it in #${opt.room}`, `#${pcA.ch.roomVnum}`);
  }
  // Leave it as the resets would find it: shut.
  await A.evaluate((w) => window.diku.game.interpret(`close ${w}`), geo.word);
  await A.waitForTimeout(800);
}
const p0 = (p) => lidState(p);

// --- on a server ---
const A = await page('Hatcher', true);
const B = await page('Watcher', true);
const pcA = mud.game.players.find((p) => p.ch.name === 'Hatcher');
const pcB = mud.game.players.find((p) => p.ch.name === 'Watcher');
await into(A, pcA);
await into(B, pcB);
await run(`on a server: #${opt.room} over #${opt.below}`, A, B, pcA);
await A.close(); await B.close();

// --- with no server ---
const S = await page('Alone', false);
await into(S, null);
await run(`standalone: #${opt.room} over #${opt.below}`, S, null, null);

for (const l of log.filter((t) => /refused|error/i.test(t)).slice(0, 8)) console.log('  log:', l);
await browser.close();
await mud.close?.();
console.log(failed ? `\n${failed} check(s) failed` : '\nevery check passed');
process.exit(failed ? 1 : 0);
