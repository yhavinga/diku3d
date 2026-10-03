// Z-fighting sweep over every built room, headless. The measurement itself is
// tools/judge/zfight.js (see its header); this only drives it.
//
// Same setup as drive.mjs -- Playwright lives in a scratch directory:
//
//   cp <repo>/tools/judge/headless/zsweep.mjs /tmp/pw/
//   node /tmp/pw/zsweep.mjs --port 8173 --out /tmp/zf.json [--query "room=3700"] [--rooms 3014,1125]
//
// Prints the total of visible flicker pixels (pixels whose surface changes
// when only the depth range is nudged, and whose colour changes with it),
// the number of rooms with any, and the pairs of surfaces responsible, worst
// first, with the room, heading and pitch to go and look from. Eight views a
// room (four headings, level and looking up) at half resolution: about ten
// minutes for the default world.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8173, out: null, query: '', rooms: '' };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--out') { opt.out = v; i++; }
  else if (a === '--query') { opt.query = v; i++; }
  else if (a === '--rooms') { opt.rooms = v; i++; }
}

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${opt.port}/?${opt.query}`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 180000 });
await page.waitForTimeout(12000);
await page.evaluate(() => {
  for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden');
  window.diku.state.paused = false;
});
const res = await page.evaluate(async (rooms) => {
  const Z = (await import(`/tools/judge/zfight.js?${Date.now()}`)).install();
  const only = rooms ? new Set(rooms.split(',').map(Number)) : null;
  return Z.sweep({ filter: only ? (v) => only.has(v) : null });
}, opt.rooms);
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(res, null, 1));
console.log('rooms', res.rows.length, 'visible flicker px', res.total, 'id ties', res.ties, 'unstable (left out)', res.noise,
  'rooms with any', res.rows.filter((r) => r.total > 0).length);
for (const p of res.pairs.slice(0, 40)) console.log(p.n, p.rooms, JSON.stringify(p.at), p.pair);
await browser.close();
