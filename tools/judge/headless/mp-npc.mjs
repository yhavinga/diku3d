// Do two pages draw the same mobile in the same place? Two pages connected
// to one server stand in the market square; at the same moments each reports
// where it draws every strolling mobile of the zone. Run once with the
// clock-keyed stroll (link.js timedRand) and once with Math.random as control.
//   node /tmp/pw/mp-npc.mjs --port 8211 --mud localhost:4011
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = { port: 8211, mud: 'localhost:4011' };
for (let i = 0; i < args.length; i++) { if (args[i] === '--port') opt.port = +args[++i]; else if (args[i] === '--mud') opt.mud = args[++i]; }
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });

async function enter(name, control) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  await page.goto(`http://localhost:${opt.port}/`);
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
  await page.waitForTimeout(8000);
  await page.click('#connect-open');
  await page.fill('#connect-address', opt.mud);
  await page.fill('#connect-name', name);
  await page.fill('#connect-password', 'watcher1');
  await page.click('#connect-go');
  await page.waitForFunction(() => !document.getElementById('connect-new').hidden || !!(window.diku && window.diku.link), null, { timeout: 10000 });
  if (!(await page.isHidden('#connect-new'))) { await page.fill('#connect-password2', 'watcher1'); await page.click('#connect-go'); }
  await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 10000 });
  await page.evaluate((control) => {
    window.diku.state.paused = false;
    const info = window.diku.built.rooms.get(3014);
    window.diku.look(info.center.x, info.center.y + 1.72, info.center.z, 0, -0.1);
    if (control) {
      // The control: every body draws from its own Math.random, as if nothing were shared.
      setTimeout(() => { for (const s of window.diku.game.mobs) if (s.figure && s.figure.m) s.figure.rand = Math.random; }, 50);
    }
  }, control);
  return page;
}
const sample = (page) => page.evaluate(() => {
  const out = {};
  window.diku.game.mobs.forEach((s, i) => {
    if (!s.here || s.dead || !s.figure || !s.figure.at || s.travel || s.record.shop) return;
    const o = s.order;
    if (!o || o.kind !== 'stroll') return;
    out[i] = [s.figure.at.x, s.figure.at.z];
  });
  return out;
});

async function trial(control, label) {
  const a = await enter(`${label}a`, control);
  const b = await enter(`${label}b`, control);
  const results = [];
  for (const wait of [15000, 30000]) {
    await a.waitForTimeout(wait - (results.length ? 15000 : 0));
    const [sa, sb] = await Promise.all([sample(a), sample(b)]);
    const d = Object.keys(sa).filter((k) => sb[k]).map((k) => Math.hypot(sa[k][0] - sb[k][0], sa[k][1] - sb[k][1])).sort((x, y) => x - y);
    const mean = d.reduce((s, v) => s + v, 0) / d.length;
    const within = d.filter((v) => v < 1).length;
    results.push(`after ${wait / 1000}s: ${d.length} strolling mobiles, mean ${mean.toFixed(2)} m apart, median ${d[Math.floor(d.length / 2)].toFixed(2)} m, ${within} within a metre`);
  }
  console.log(`${control ? 'control (Math.random)' : 'clock-keyed (timedRand)'}:\n  ${results.join('\n  ')}`);
  await a.context().close();
  await b.context().close();
}
await trial(false, 'Seer');
await trial(true, 'Ctrl');
await browser.close();
