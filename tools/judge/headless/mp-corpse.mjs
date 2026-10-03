// A player's corpse and a dropped link, on one diku3d server: the implementor
// slays Theoden in front of Eomer (the body lies where he fell, his gear in
// it), then Theoden's link is cut and taken up again from the page's
// "reconnect" button, without a reload.
//   node tools/judge/headless/mp-seed.mjs <server data dir>
//   node /tmp/pw/mp-corpse.mjs --port 8211 --mud localhost:4011 --out /tmp/mp
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8211, mud: 'localhost:4011', out: '/tmp/mp', wait: 12000 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--mud') { opt.mud = v; i++; } else if (a === '--out') { opt.out = v; i++; }
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
const stand = (page, dx, dz, yaw, pitch = -0.12) => page.evaluate(([dx, dz, yaw, pitch]) => {
  const { built, game } = window.diku;
  const info = built.rooms.get(game.state.roomVnum);
  window.diku.look(info.center.x + dx, info.center.y + 1.72, info.center.z + dz, yaw, pitch);
}, [dx, dz, yaw, pitch]);

const e = await enter('Eomer');
const t = await enter('Theoden');
const y = await enter('Yeb');
await stand(e, -2.5, 0, -Math.PI / 2, -0.35);
await stand(t, 0.5, 0, Math.PI / 2);
// Something for him to carry to his death: the implementor makes a weapon and hands it over.
const kw = await y.evaluate(() => {
  const proto = [...window.diku.world.objProtos.values()].find((o) => o.vnum >= 3000 && o.vnum < 3100 && o.itemType === 5);
  window.diku.game.interpret(`oload ${proto.vnum}`);
  return proto.keywords.split(' ')[0];
});
await y.waitForTimeout(400);
await y.evaluate((k) => window.diku.game.interpret(`at 3122 give ${k} theoden`), kw);
await t.waitForTimeout(600);
await t.evaluate((k) => window.diku.game.interpret(`wield ${k}`), kw);
await t.waitForTimeout(600);
await e.evaluate(() => window.diku.applyTime('noon'));
await e.waitForTimeout(1200);
const me = await mark(e);
await y.evaluate(() => window.diku.game.interpret('at 3122 slay theoden'));
await e.waitForTimeout(2500);
console.log('Eomer read:', JSON.stringify(await said(e, me)));
const seen = await e.evaluate(() => window.diku.game.ground.filter((o) => o.itemType === 24).map((o) => ({ name: o.name, owner: o.owner, contains: o.contains.map((c) => c.name), at: o.at })));
console.log('corpses on Eomer\'s ground:', JSON.stringify(seen));
await e.screenshot({ path: `${opt.out}/corpse.png` });
const mx = await mark(e);
await e.evaluate(() => window.diku.game.interpret('get all corpse'));
await e.waitForTimeout(800);
console.log('Eomer loots:', JSON.stringify(await said(e, mx)));

// ------------------------------------------------------------ reconnect
await t.evaluate(() => window.diku.link.link.ws.close());
await t.waitForTimeout(800);
await t.screenshot({ path: `${opt.out}/link-lost.png` });
console.log('overlay:', await t.textContent('#link-lost-text'), '| reconnect shown:', !(await t.isHidden('#link-lost-reconnect')));
await t.click('#link-lost-reconnect');
await t.waitForFunction(() => document.getElementById('link-lost').hidden, null, { timeout: 10000 }).catch(() => null);
await t.waitForTimeout(1200);
// He died, so he stands in the temple now: his own screen is what to read.
const mt = await mark(t);
await t.evaluate(() => window.diku.game.interpret('say I am back.'));
await t.waitForTimeout(900);
console.log('after reconnect: overlay hidden', await t.isHidden('#link-lost'), '| Theoden read:', JSON.stringify(await said(t, mt)));
await t.screenshot({ path: `${opt.out}/reconnected.png` });
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
