// The connect form with a new character's fields open, at two sizes.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const [w, h] of [[1280, 720], [960, 540]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto('http://localhost:8211/');
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
  await page.waitForTimeout(6000);
  await page.click('#connect-open');
  await page.fill('#connect-address', 'localhost:4011');
  await page.fill('#connect-name', `Newone${w}`.replace(/\d/g, (d) => 'abcdefghij'[d]));
  await page.fill('#connect-password', 'secret1');
  await page.click('#connect-go');
  await page.waitForFunction(() => !document.getElementById('connect-new').hidden, null, { timeout: 10000 });
  await page.screenshot({ path: `/tmp/mp/connect-new-${w}.png` });
  const box = await page.evaluate(() => { const f = document.getElementById('connect').getBoundingClientRect(); const c = document.getElementById('credit').getBoundingClientRect(); return { formBottom: Math.round(f.bottom), creditTop: Math.round(c.top) }; });
  console.log(w, h, JSON.stringify(box));
  await page.close();
}
await browser.close();
