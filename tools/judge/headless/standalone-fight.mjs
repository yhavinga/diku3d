// Standalone, never connected: the page's own game, one fight to the death.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/ointer/.test(m.text())) logs.push(m.text()); });
await page.goto('http://localhost:8211/');
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
await page.waitForTimeout(8000);
await page.click('#enter');
await page.waitForTimeout(1500);
const r = await page.evaluate(async () => {
  const { game } = window.diku;
  window.diku.state.paused = false;
  const said = []; game.listen((e) => { if (e.text) said.push(e.text); });
  const slot = game.mobs.filter((s) => s.here && !s.dead && s.figure && s.proto.level <= 1 && !s.record.shop)[0];
  const stand = () => window.diku.look(slot.figure.at.x + 1.2, slot.figure.at.y + 1.72, slot.figure.at.z + 0.4, Math.atan2(1.2, 0.4), -0.1);
  stand(); await new Promise((res) => setTimeout(res, 800)); stand();
  game.attackSlot(slot);
  const until = performance.now() + 40000;
  while (performance.now() < until && !slot.dead) { await new Promise((res) => setTimeout(res, 250)); if (!slot.dead) stand(); }
  return { mode: game.mirror.puppet ? 'puppet' : 'local', link: !!window.diku.link, dead: slot.dead, name: slot.proto.short, said: said.slice(0, 8) };
});
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: '/tmp/mp/standalone-fight.png' });
console.log(logs.join('\n') || 'no page errors');
await browser.close();
