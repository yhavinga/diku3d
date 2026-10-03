// One page on a diku3d server: log in, walk up to a weak mobile, fight it
// to the death, loot the corpse; report what the page saw and shoot it.
//   node /tmp/pw/mp-fight.mjs --port 8211 --mud localhost:4011 --name Faramir --out /tmp/mp
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8211, mud: 'localhost:4011', out: '/tmp/mp', name: 'Faramir', vnum: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--mud') { opt.mud = v; i++; } else if (a === '--out') { opt.out = v; i++; } else if (a === '--name') { opt.name = v; i++; }
}
fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/ointer/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(`http://localhost:${opt.port}/`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
await page.waitForTimeout(12000);
await page.click('#connect-open');
await page.fill('#connect-address', opt.mud);
await page.fill('#connect-name', opt.name);
await page.fill('#connect-password', 'ithilien');
await page.click('#connect-go');
await page.waitForFunction(() => !document.getElementById('connect-new').hidden || !!(window.diku && window.diku.link), null, { timeout: 10000 });
if (!(await page.isHidden('#connect-new'))) {
  await page.fill('#connect-password2', 'ithilien');
  await page.click('#connect-go');
}
await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 10000 });
await page.waitForTimeout(2000);

// The weakest mobile standing in the drawn zone, and a step beside it.
const target = await page.evaluate(() => {
  const { game } = window.diku;
  const slots = game.mobs.map((s, i) => ({ s, i })).filter(({ s }) => s.here && !s.dead && s.figure && s.proto.level <= 1 && !s.record.shop);
  slots.sort((a, b) => a.s.proto.level - b.s.proto.level);
  const { s, i } = slots[0];
  return { i, name: s.proto.short, level: s.proto.level, room: s.roomVnum, at: { ...s.figure.at } };
});
console.log('target', JSON.stringify(target));
const result = await page.evaluate(async (t) => {
  const { game } = window.diku;
  const said = [];
  game.listen((e) => { if (e.text) said.push(`${e.kind}: ${e.text}`); });
  window.diku.state.paused = false;
  const slot = game.mobs[t.i];
  const stand = () => window.diku.look(slot.figure.at.x + 1.2, slot.figure.at.y + 1.72, slot.figure.at.z + 0.4, Math.atan2(1.2, 0.4), -0.1);
  stand();
  await new Promise((r) => setTimeout(r, 1500));
  stand();
  game.attackSlot(slot);
  const until = performance.now() + 40000;
  while (performance.now() < until && !slot.dead) {
    await new Promise((r) => setTimeout(r, 250));
    if (slot.figure && !slot.dead) stand();
  }
  await new Promise((r) => setTimeout(r, 1500));
  const corpse = game.ground.find((o) => o.slot === slot);
  return {
    dead: slot.dead, corpse: corpse ? { name: corpse.name, id: corpse.mirrorId, contains: corpse.contains.map((o) => o.name) } : null,
    exp: game.state.exp, hp: `${game.state.hit}/${game.state.maxHit}`, said: said.slice(0, 40),
  };
}, target);
console.log(JSON.stringify(result, null, 1));
await page.screenshot({ path: `${opt.out}/fight-after.png` });
if (result.corpse) {
  await page.evaluate(() => window.diku.game.interpret('get all corpse'));
  await page.waitForTimeout(1200);
  console.log('inventory', JSON.stringify(await page.evaluate(() => window.diku.game.state.inventory.map((o) => `${o.name} #${o.mirrorId}`))));
  console.log('gold', await page.evaluate(() => window.diku.game.state.gold));
}
if (logs.length) console.log(logs.slice(0, 30).join('\n'));
await browser.close();
