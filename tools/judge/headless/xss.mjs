// What a link can do to the page. `?areaDir=` and `?areas=` are whatever the
// link says, and a failed read reports its URL on the loading screen: that
// report was markup, so a link carrying an <img onerror> ran script on the
// page's origin (which can rewrite the remembered server address the connect
// form sends a name and password to). Now the directory must be on the page's
// own origin, the names must be area file names, the report is text, and the
// page is served under a Content-Security-Policy (serve.py, as nginx sends it).
//
// It loads the page with script in ?areaDir= and in ?areas=, and with an
// ?areaDir= on another origin, and checks that no script ran, nothing was
// fetched from elsewhere, and the refusal is on the screen as text. Then it
// boots the page as usual and checks that the policy came with it and that
// nothing broke it, and that a name from an area file (or a server) put on a
// game sheet is text there too.
//
//   python3 serve.py 8173 &
//   cp tools/judge/headless/xss.mjs /tmp/pw/
//   timeout 600 node /tmp/pw/xss.mjs --port 8173
//
// Prints one line per check and exits 1 if any failed.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = { port: 8173 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') opt.port = +args[++i];
}
const origin = `http://localhost:${opt.port}`;

const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });

let failed = false;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed = true;
}

/** A fresh context with every CSP violation and every request off the page's origin recorded. */
async function open() {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await context.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__violations.push(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  const page = await context.newPage();
  const record = { foreign: [], errors: [], csp: [] };
  page.on('request', (r) => { if (!r.url().startsWith(`${origin}/`) && !/^(data|blob):/.test(r.url())) record.foreign.push(r.url()); });
  page.on('pageerror', (e) => record.errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) record.csp.push(m.text().slice(0, 300)); });
  return { context, page, record };
}

/** Load `query`, wait for the boot to give up, and read what the loading screen says. */
async function refused(query) {
  const { context, page, record } = await open();
  await page.goto(`${origin}/${query}`);
  await page.waitForFunction(() => /failed to start/.test(document.getElementById('loading-text')?.textContent || ''), null, { timeout: 90000 })
    .catch(() => {});
  // Long enough for an <img src=x> to fail and its onerror to run.
  await page.waitForTimeout(1500);
  const seen = await page.evaluate(() => {
    const text = document.getElementById('loading-text');
    return {
      text: text.textContent,
      tags: [...text.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()),
      ran: window.__xss ?? null,
      images: document.querySelectorAll('#loading img').length,
    };
  });
  await context.close();
  return { ...seen, ...record };
}

const SCRIPT = (tag) => `<img src=x onerror="window.__xss='${tag}'">`;

// -- script in ?areaDir= --------------------------------------------------------
{
  const r = await refused(`?areaDir=${encodeURIComponent(SCRIPT('areaDir'))}`);
  check('?areaDir= with script: the boot fails', /failed to start/.test(r.text), r.text.slice(0, 200));
  check('?areaDir= with script: no script ran', r.ran === null, r.ran);
  check('?areaDir= with script: the report is text', r.tags.join() === 'strong,br' && r.images === 0, r.tags);
  check('?areaDir= with script: the URL is shown as it was read', r.text.includes('cannot read') && r.text.includes('onerror'), r.text.slice(0, 200));
}

// -- script in ?areas= ----------------------------------------------------------
{
  const r = await refused(`?areas=${encodeURIComponent(SCRIPT('areas'))}`);
  check('?areas= with script: no script ran', r.ran === null, r.ran);
  check('?areas= with script: the report is text', r.tags.join() === 'strong,br' && r.images === 0, r.tags);
  check('?areas= with script: refused as no file name', /\?areas= names area files/.test(r.text), r.text.slice(0, 200));
}
{
  const r = await refused(`?areas=${encodeURIComponent('midgaard,../server/main.mjs')}`);
  check('?areas= with a path: refused as no file name', /\?areas= names area files/.test(r.text), r.text.slice(0, 200));
}

// -- ?areaDir= on another origin -------------------------------------------------
for (const dir of ['http://127.0.0.1:9/area', '//127.0.0.1:9/area']) {
  const r = await refused(`?areaDir=${encodeURIComponent(dir)}`);
  check(`?areaDir=${dir}: refused, saying why`, /\?areaDir= must be a path on this site/.test(r.text), r.text.slice(0, 200));
  check(`?areaDir=${dir}: nothing fetched from it`, r.foreign.length === 0, r.foreign.slice(0, 3));
}

// -- a normal boot, under the policy ------------------------------------------------
{
  const { context, page, record } = await open();
  const response = await page.goto(`${origin}/?room=3001`);
  const policy = response.headers()['content-security-policy'] || '';
  const scriptSrc = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src ')) || '';
  check('the page comes with a Content-Security-Policy', scriptSrc !== '', policy.slice(0, 80));
  check('its script-src allows no inline script but the hashed, and no eval',
    scriptSrc !== '' && !scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"), scriptSrc.slice(0, 80));
  const booted = await page.waitForFunction(() => window.diku && window.diku.built && window.diku.title, null, { timeout: 180000 })
    .then(() => true, () => false);
  check('the page boots under it', booted, booted ? undefined : await page.evaluate(() => document.getElementById('loading-text')?.textContent));
  if (booted) {
    const bake = await page.evaluate(() => ({ workers: window.diku.bake.workers }));
    check('textures baked in workers', bake.workers > 0, bake);
    await page.click('#enter');
    await page.waitForTimeout(2500);
    const violations = await page.evaluate(() => window.__violations);
    check('no CSP violation on the way in', violations.length === 0 && record.csp.length === 0, [...violations, ...record.csp].slice(0, 5));
    check('no uncaught error on the way in', record.errors.length === 0, record.errors.slice(0, 3));

    // A container's name, as an area file or a server could have it, on the
    // sheet E opens: the sheet must show it, not build it.
    const shown = await page.evaluate(async () => {
      const d = window.diku;
      const box = d.game.ground.find((o) => o.itemType === 15 && o.inRoom !== null && d.built.rooms.get(o.inRoom));
      if (!box) return null;
      await d.goto(box.inRoom);
      box.name = '<img id="xss-sheet" src="x">a box';
      d.gameUi.openLoot(box);
      const sheet = document.getElementById('g-sheet');
      return { made: !!document.getElementById('xss-sheet'), title: sheet.querySelector('h2')?.textContent };
    });
    check('a name with markup on a game sheet is text', shown && !shown.made && shown.title === '<img id="xss-sheet" src="x">a box', shown);
  }
  check('the normal boot fetched nothing from elsewhere', record.foreign.length === 0, record.foreign.slice(0, 3));
  await context.close();
}

await browser.close();
process.exit(failed ? 1 : 0);
