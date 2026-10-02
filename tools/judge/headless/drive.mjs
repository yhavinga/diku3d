// Headless GPU driver for diku3d, so several agents can look at the world at
// once without sharing one Chrome (or the chrome-devtools MCP).
//
// Playwright is not a dependency of the project (nothing here is fetched at
// runtime), so the driver runs from a scratch directory that has it:
//
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright@1.57
//   cp <repo>/tools/judge/headless/drive.mjs /tmp/pw/
//   node /tmp/pw/drive.mjs --port 8173 --eval "diku.goto(3014, 0, 0)" --out /tmp/a.png
//
// Options: --port, --query "class=mage&time=dusk", --eval (repeatable, awaited
// in the page, JSON result printed; a statement block needs `return`),
// --script file.js, --wait ms (world build, default 15000), --settle ms,
// --size 1600x900, --out file.png, --nohide (keep the title screen up and play
// it: evals may call __shot(path), __click(selector), __key(code, ms),
// __mouse(x, y)). Chromium runs with Metal-backed ANGLE, so the picture is
// the real composited GPU frame.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { nohide: false, port: 8173, query: '', evals: [], out: null, wait: 15000, settle: 1500, w: 1280, h: 720 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--query') { opt.query = v; i++; }
  else if (a === '--eval') { opt.evals.push(v); i++; }
  else if (a === '--script') { opt.evals.push(fs.readFileSync(v, 'utf8')); i++; }
  else if (a === '--nohide') { opt.nohide = true; }
  else if (a === '--out') { opt.out = v; i++; }
  else if (a === '--wait') { opt.wait = +v; i++; }
  else if (a === '--settle') { opt.settle = +v; i++; }
  else if (a === '--size') { [opt.w, opt.h] = v.split('x').map(Number); i++; }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({ viewport: { width: opt.w, height: opt.h } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.exposeFunction('__shot', async (p) => { await page.screenshot({ path: p }); return p; });
await page.exposeFunction('__click', async (sel) => { await page.click(sel); return sel; });
await page.exposeFunction('__mouse', async (x, y) => { await page.mouse.click(x, y); return 1; });
await page.exposeFunction('__key', async (k, ms) => { if (ms) { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); } else await page.keyboard.press(k); return k; });
await page.goto(`http://localhost:${opt.port}/?${opt.query}`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: opt.wait * 4 }).catch(() => {});
await page.waitForTimeout(opt.wait);
if (!opt.nohide) await page.evaluate(() => {
  for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden');
  if (window.diku) window.diku.state.paused = false;
});
for (const code of opt.evals) {
  try {
    const r = await page.evaluate(`(async () => { ${code.includes('return') ? code : 'return (' + code + ')'} })()`);
    if (r !== undefined) console.log(JSON.stringify(r, null, 1));
  } catch (e) { console.log('EVAL ERROR:', e.message); }
}
await page.waitForTimeout(opt.settle);
if (opt.out) { await page.screenshot({ path: opt.out }); console.log('saved', opt.out); }
if (logs.length) console.log(logs.slice(0, 30).join('\n'));
await browser.close();
