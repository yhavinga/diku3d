// One page on a diku3d server walking the town by typed directions -- the
// glides and fades a page really makes -- while the server checks every
// report (server/mud.mjs `position`). Prints each step and how many reports
// the server refused; a page walking honestly should see none.
//   node /tmp/pw/mp-walk.mjs --port 8211 --mud localhost:4011 --steps 30 [--out /tmp/mp]
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8211, mud: 'localhost:4011', out: null, steps: 30, name: 'Walker', wait: 12000, seed: 7 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--mud') { opt.mud = v; i++; } else if (a === '--out') { opt.out = v; i++; }
  else if (a === '--steps') { opt.steps = +v; i++; } else if (a === '--name') { opt.name = v; i++; } else if (a === '--seed') { opt.seed = +v; i++; }
}
if (opt.out) fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
await page.goto(`http://localhost:${opt.port}/`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
await page.waitForTimeout(opt.wait);
await page.click('#connect-open');
await page.fill('#connect-address', opt.mud);
await page.fill('#connect-name', opt.name);
await page.fill('#connect-password', 'walking1');
await page.click('#connect-go');
await page.waitForFunction(() => !document.getElementById('connect-new').hidden || !!(window.diku && window.diku.link), null, { timeout: 10000 });
if (!(await page.isHidden('#connect-new'))) {
  await page.fill('#connect-password2', 'walking1');
  await page.click('#connect-go');
}
await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 10000 });
await page.evaluate(() => {
  window.diku.state.paused = false;
  window.__at = [];
  window.diku.link.link.on('at', (msg) => window.__at.push(msg));
});
await page.waitForTimeout(1500);

let r = opt.seed;
const rand = () => ((r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296);
for (let i = 0; i < opt.steps; i++) {
  const step = await page.evaluate((u) => {
    const { game, built, world } = window.diku;
    const here = game.state.roomVnum;
    const room = world.rooms.get(here);
    const ways = room.exits.map((e, d) => [e, d]).filter(([e]) => e && !e.offMap && built.rooms.has(e.to) && !built.rooms.get(e.to).unbuilt && !(e.locks & 2));
    if (!ways.length) return { here, none: true };
    const [exit, dir] = ways[Math.floor(u * ways.length)];
    game.interpret(['north', 'east', 'south', 'west', 'up', 'down'][dir]);
    return { here, dir, to: exit.to };
  }, rand());
  if (step.none) { console.log(`#${step.here}: nowhere to go`); break; }
  await page.waitForFunction((to) => window.diku.game.state.roomVnum === to, step.to, { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(600);
  const now = await page.evaluate(() => ({ room: window.diku.game.state.roomVnum, at: window.__at.length }));
  console.log(`#${step.here} ${'neswud'[step.dir]} -> #${step.to}: in #${now.room}, ${now.at} refused so far`);
}
const at = await page.evaluate(() => window.__at);
console.log(`refused: ${at.length}`, JSON.stringify(at.slice(0, 5)));
if (opt.out) await page.screenshot({ path: `${opt.out}/walk-end.png` });
if (logs.length) console.log(logs.slice(0, 20).join('\n'));
await browser.close();
