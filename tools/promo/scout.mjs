// Scout a zone for the promo: stand in every place diku.places() finds (and
// any extra rooms named), at each hour asked for, and save a still of each.
//   node tools/promo/scout.mjs --port 8251 --room 6000 --times dawn,dusk --out /tmp/scout [--rooms 6104,6152]
// Writes <out>/<room>-<key>-<time>.jpg and prints one line per still.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8251, room: 3001, times: ['dusk'], out: '/tmp/scout', rooms: [], size: [1280, 720], max: 8 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--room') { opt.room = +v; i++; }
  else if (a === '--times') { opt.times = v.split(','); i++; } else if (a === '--out') { opt.out = v; i++; }
  else if (a === '--rooms') { opt.rooms = v.split(',').filter(Boolean).map(Number); i++; }
  else if (a === '--max') { opt.max = +v; i++; }
}
fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: opt.size[0], height: opt.size[1] } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${opt.port}/?room=${opt.room}&time=${opt.times[0]}`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 180000 });
await page.waitForTimeout(6000);
await page.evaluate(() => {
  for (const id of ['title', 'loading', 'hud', 'game-ui']) document.getElementById(id)?.classList.add('hidden');
  const s = document.createElement('style');
  s.textContent = '#hud,#game-ui,#title,#loading,#toast,#help-hint{display:none!important}';
  document.head.appendChild(s);
  window.diku.state.paused = false;
  const d = window.diku; const fxUpdate = d.fx.update.bind(d.fx);
  d.fx.update = (dt) => { fxUpdate(dt); d.fx.viewModel.scene.visible = false; };
});
const places = await page.evaluate(() => window.diku.places().map((p) => ({ key: p.key, vnum: p.vnum, room: p.room })));
const zone = await page.evaluate(() => window.diku.zone.id);
const shots = places.slice(0, opt.max).map((p) => ({ ...p, how: 'shoot' }));
for (const vnum of opt.rooms) shots.push({ key: `r${vnum}`, vnum, how: 'goto' });
for (const time of opt.times) {
  await page.evaluate((t) => window.diku.applyTime(t), time);
  for (const s of shots) {
    const r = await page.evaluate(async (s) => {
      const d = window.diku;
      if (s.how === 'shoot') return d.shoot(s.key);
      const info = d.built.rooms.get(s.vnum);
      if (!info) return 'not built';
      return d.shoot(s.vnum);
    }, s);
    await page.waitForTimeout(1200);
    const file = `${opt.out}/${zone}-${s.vnum}-${s.key}-${time}.jpg`;
    await page.screenshot({ path: file, type: 'jpeg', quality: 80 });
    console.log(file, '|', s.room || '', '|', typeof r === 'object' ? r.room : r);
  }
}
if (errors.length) console.log('errors:', errors.slice(0, 5).join(' / '));
await browser.close();
