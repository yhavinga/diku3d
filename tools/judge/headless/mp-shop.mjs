// Two pages at one shop on a diku3d server: the panel lists the server's
// keeper -- its stock, levels and prices, and what it would pay for each
// thing carried -- the same on both pages, and buying costs what it said.
//   node tools/judge/headless/mp-seed.mjs <server data dir>
//   node /tmp/pw/mp-shop.mjs --port 8211 --mud localhost:4011 --out /tmp/mp [--keeper weaponsmith]
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8211, mud: 'localhost:4011', out: '/tmp/mp', wait: 12000, keeper: 'weaponsmith' };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--mud') { opt.mud = v; i++; } else if (a === '--out') { opt.out = v; i++; }
  else if (a === '--keeper') { opt.keeper = v; i++; }
}
fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = [];

async function enter(name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/ointer/.test(m.text())) logs.push(`${name} [${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`${name} [pageerror] ${e.message}\n${e.stack}`));
  await page.goto(`http://localhost:${opt.port}/`);
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
  await page.waitForTimeout(opt.wait);
  await page.click('#connect-open');
  await page.fill('#connect-address', opt.mud);
  await page.fill('#connect-name', name);
  await page.fill('#connect-password', 'password1');
  await page.click('#connect-go');
  await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 15000 });
  await page.evaluate(() => { window.diku.state.paused = false; window.__said = []; window.diku.game.listen((e) => { if (e.text) window.__said.push(e.text); }); });
  await page.waitForTimeout(2000);
  return page;
}
const said = (page, from = 0) => page.evaluate((n) => window.__said.slice(n), from);
const mark = (page) => page.evaluate(() => window.__said.length);

const e = await enter('Eomer');
const t = await enter('Theoden');
const y = await enter('Yeb');
const keeper = await y.evaluate((word) => {
  const slot = window.diku.game.mobs.find((s) => s.record.shop && new RegExp(word, 'i').test(s.proto.short));
  return { room: slot.roomVnum, name: slot.proto.short, index: window.diku.game.mobs.indexOf(slot) };
}, opt.keeper);
console.log('keeper:', JSON.stringify(keeper));
for (const cmd of [`transfer eomer ${keeper.room}`, `transfer theoden ${keeper.room}`, 'mset eomer gold 3000']) {
  await y.evaluate((c) => window.diku.game.interpret(c), cmd);
  await y.waitForTimeout(300);
}
// Walk up to the counter: a step at a time, as a page walks.
for (const [page, side] of [[e, -1], [t, 1]]) {
  await page.waitForFunction((v) => window.diku.game.state.roomVnum === v, keeper.room, { timeout: 15000 });
  await page.waitForTimeout(800);
  for (let i = 0; i < 6; i++) {
    const near = await page.evaluate(([index, side]) => {
      const slot = window.diku.game.mobs[index];
      const eye = window.diku.player.position;
      const tx = slot.pos.x + side * 1.2; const tz = slot.pos.z + 1.8;
      const dx = tx - eye.x; const dz = tz - eye.z; const d = Math.hypot(dx, dz);
      const step = Math.min(1, 2.5 / Math.max(d, 1e-6));
      const x = eye.x + dx * step; const z = eye.z + dz * step;
      const yaw = Math.atan2(-(slot.pos.x - x), -(slot.pos.z - z));
      window.diku.look(x, eye.y, z, yaw, -0.1);
      return d;
    }, [keeper.index, side]);
    await page.waitForTimeout(250);
    if (near < 0.3) break;
  }
}
await e.waitForTimeout(1200);
for (const [page, name] of [[e, 'Eomer'], [t, 'Theoden']]) {
  await page.evaluate(() => window.diku.gameUi.openShop());
  await page.waitForTimeout(700);
  const shop = await page.evaluate(() => { const s = window.diku.game.shopHere(); return s && { name: s.name, open: s.open, stock: s.stock.map((x) => `${x.obj.name} L${x.obj.level} ${x.cost}g`) }; });
  console.log(`${name}'s panel:`, JSON.stringify(shop));
  await page.screenshot({ path: `${opt.out}/shop-${name}.png` });
}
const me = await mark(e);
const bought = await e.evaluate(() => {
  const s = window.diku.game.shopHere();
  const pick = s.stock.find((x) => x.obj.level <= window.diku.game.state.level && x.cost <= window.diku.game.state.gold);
  if (!pick) return null;
  window.diku.game.buy(s.keeper, pick.obj.vnum);
  return `${pick.obj.name} for ${pick.cost}`;
});
await e.waitForTimeout(1200);
console.log('Eomer buys', bought, '->', JSON.stringify(await said(e, me)));
await e.screenshot({ path: `${opt.out}/shop-Eomer-bought.png` });
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
