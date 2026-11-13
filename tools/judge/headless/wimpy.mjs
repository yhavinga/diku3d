// A wimpy smurf at half health, in the smurf village, and a player who keeps
// swinging at it (src/game.js `flee`, `fled`; motion.js's travel order). A
// wimpy mobile that has fled ("A smurf has fled!") runs out through a door.
// The old game put it in the next room only once its body had got there, and
// kept it a target meanwhile: the next blow started a fight with it and
// cancelled the flight ("caught on the way: stand and fight"), so a smurf
// that had fled over and over stayed on the road. Now it is out of the fight
// and not there to be struck until it has gone.
//
//   cp <repo>/tools/judge/headless/wimpy.mjs /tmp/pw/
//   timeout 300 node /tmp/pw/wimpy.mjs --port 8173
//
// Prints what the log said, which room the rules had it in and where its body
// was, then one line per check; exits 1 if any failed. Run it against the
// previous game.js and it must fail.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = { port: 8173, seconds: 45 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') opt.port = +args[++i];
  else if (args[i] === '--seconds') opt.seconds = +args[++i];
}

const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${opt.port}/?room=104`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 180000 });
await page.waitForTimeout(8000);
await page.evaluate(() => {
  for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden');
  window.diku.state.paused = false;
});

const run = await page.evaluate(async (seconds) => {
  const g = window.diku.game;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ROAD = 105;                                // Smurfy Road, four ways out
  const slot = g.mobs.find((s) => (s.proto.act & 128) && s.figure && s.roomVnum === ROAD && s.proto.level <= 3);
  if (!slot) return { error: 'no wimpy smurf on the road' };
  g.grace(1e6);
  const p = slot.pos;
  window.diku.look(p.x + 2, p.y + 1.72, p.z, Math.PI / 2, 0);
  await sleep(800);
  const mob = slot.instance;
  mob.maxHit = 5000;
  mob.hit = 2400;                                   // below half: every blow that hurts is a coin flip
  const t0 = performance.now();
  const said = [];
  g.listen((e) => { if (e.kind === 'flee') said.push({ t: Math.round(performance.now() - t0), text: e.text }); });
  let refought = 0;
  let struck = 0;
  let left = null;
  const samples = [];
  // `seconds` to flee, and then `seconds` from the flight for the body to go:
  // when the coin flips fall late, a deadline from the start left the run too
  // little time (35 s in, 10 s to cross a road at a smurf's 1.3 m/s).
  const deadline = () => (said.length ? said[0].t : 0) + seconds * 1000;
  while (performance.now() - t0 < deadline() && left === null) {
    await sleep(100);
    const running = said.length > 0 && slot.roomVnum === ROAD;
    if (running && mob.fighting) refought += 1;
    if (!g.state.fighting && g.attack().ok && running) struck += 1;
    const body = slot.figure.at;
    const bodyRoom = g.nav.roomAt(body.x, body.y, body.z);
    if (said.length && slot.roomVnum !== ROAD && bodyRoom !== ROAD) left = Math.round(performance.now() - t0);
    if (samples.length < 400) samples.push({ t: Math.round(performance.now() - t0), rules: slot.roomVnum, body: bodyRoom, fighting: !!mob.fighting, order: slot.order && slot.order.kind });
  }
  return { said, refought, struck, left: left === null ? null : left - said[0].t, samples: samples.filter((s, i) => i % 15 === 0), end: { rules: slot.roomVnum, body: g.nav.roomAt(slot.figure.at.x, slot.figure.at.y, slot.figure.at.z), dead: slot.dead } };
}, opt.seconds);

let failed = false;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed = true;
}
if (run.error) { console.log(`FAIL ${run.error}`); process.exit(1); }
console.log('log:', run.said.map((s) => `${(s.t / 1000).toFixed(1)}s "${s.text}"`).join(', ') || '(nothing said)');
console.log('rules room / body room / fighting / order, every 1.5 s:');
for (const s of run.samples) console.log(`  ${(s.t / 1000).toFixed(1).padStart(5)}s  #${s.rules} / #${s.body}  ${s.fighting ? 'fighting' : '        '}  ${s.order}`);
console.log(`end: the rules have it in #${run.end.rules}, its body is in #${run.end.body}${run.end.dead ? ', dead' : ''}`);
check('it fled once, and said so', run.said.length === 1, run.said.length);
check('the next blow was not at it while it ran', run.struck === 0 && run.refought === 0, { struck: run.struck, refought: run.refought });
check(`its body left the road within ${opt.seconds} s of fleeing`, run.left !== null, run.left);
check('no script errors', errors.length === 0, errors.slice(0, 2));
await browser.close();
process.exit(failed ? 1 : 0);
