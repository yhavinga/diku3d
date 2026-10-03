// Three pages on one diku3d server: a duel by Merc 2.1's rules, following
// through an exit, and an implementor's transfer -- each page's view shot.
//   node /tmp/pw/mp-pvp.mjs --port 8211 --mud localhost:4011 --out /tmp/mp
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8211, mud: 'localhost:4011', out: '/tmp/mp' };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--mud') { opt.mud = v; i++; } else if (a === '--out') { opt.out = v; i++; }
}
fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = [];

async function enter(label, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/ointer/.test(m.text())) logs.push(`${label} [${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`${label} [pageerror] ${e.message}\n${e.stack}`));
  await page.goto(`http://localhost:${opt.port}/`);
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
  await page.waitForTimeout(10000);
  await page.click('#connect-open');
  await page.fill('#connect-address', opt.mud);
  await page.fill('#connect-name', name);
  await page.fill('#connect-password', 'password1');
  await page.click('#connect-go');
  await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 15000 });
  await page.evaluate(() => { window.diku.state.paused = false; window.__said = []; window.diku.game.listen((e) => { if (e.text) window.__said.push(e.text); }); });
  await page.waitForTimeout(2500);
  return page;
}
const said = (page, from = 0) => page.evaluate((n) => window.__said.slice(n), from);
const mark = (page) => page.evaluate(() => window.__said.length);
/** Stand at a room's middle plus (dx, dz), facing yaw. */
const stand = (page, vnum, dx, dz, yaw) => page.evaluate(([vnum, dx, dz, yaw]) => {
  const info = window.diku.built.rooms.get(vnum);
  window.diku.look(info.center.x + dx, info.center.y + 1.72, info.center.z + dz, yaw, -0.08);
}, [vnum, dx, dz, yaw]);

const e = await enter('Eomer', 'Eomer');
const t = await enter('Theoden', 'Theoden');
await stand(e, 3122, -1.0, 0, -Math.PI / 2);
await stand(t, 3122, 1.0, 0, Math.PI / 2);
await e.waitForTimeout(1500);

// ------------------------------------------------------------------ the duel
let me = await mark(e);
let mt = await mark(t);
await e.evaluate(() => window.diku.game.interpret('murder theoden'));
await e.waitForTimeout(3200);
await e.screenshot({ path: `${opt.out}/duel-attacker.png` });
await t.screenshot({ path: `${opt.out}/duel-victim.png` });
console.log('Eomer read:', JSON.stringify((await said(e, me)).slice(0, 8)));
console.log('Theoden read:', JSON.stringify((await said(t, mt)).slice(0, 8)));
console.log('Theoden plate:', JSON.stringify(await t.evaluate(() => { const x = window.diku.game.target(); return x && { name: x.name, player: x.player, percent: x.percent }; })));

// Part them: the victim flees out of the street.
await t.evaluate(() => window.diku.game.interpret('flee'));
await t.waitForTimeout(800);

// ------------------------------------------------------------- following
const y = await enter('Yeb', 'Yeb');
me = await mark(e);
mt = await mark(t);
await y.evaluate(() => window.diku.game.interpret('transfer eomer 3014'));
await y.evaluate(() => window.diku.game.interpret('transfer theoden 3014'));
await y.evaluate(() => window.diku.game.interpret('pardon eomer killer'));
await y.evaluate(() => window.diku.game.interpret('peace'));
await e.waitForTimeout(4000);
console.log('after transfer, Eomer room', await e.evaluate(() => window.diku.game.state.roomVnum), 'Theoden room', await t.evaluate(() => window.diku.game.state.roomVnum));
console.log('Eomer read:', JSON.stringify((await said(e, me)).slice(0, 6)));
await t.evaluate(() => window.diku.game.interpret('follow eomer'));
await t.waitForTimeout(600);
mt = await mark(t);
// Eomer takes the exit south, by the arrow key's way (main.js step).
await e.evaluate(() => window.diku.game.interpret('south'));
await e.waitForTimeout(7000);
console.log('followed: Theoden room', await t.evaluate(() => window.diku.game.state.roomVnum), 'Eomer room', await e.evaluate(() => window.diku.game.state.roomVnum));
console.log('Theoden read:', JSON.stringify((await said(t, mt)).slice(0, 8)));
await t.screenshot({ path: `${opt.out}/follow.png` });
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
