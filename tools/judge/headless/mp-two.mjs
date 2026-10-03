// Two pages on one diku3d server: log both in through the title screen's
// connect form, stand them apart in the temple, and shoot each one's view.
//   node /tmp/pw/mp-two.mjs --port 8211 --mud localhost:4011 --out /tmp/mp
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8211, mud: 'localhost:4011', out: '/tmp/mp', wait: 14000, w: 1280, h: 720, names: ['Arwen', 'Boromir'] };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--mud') { opt.mud = v; i++; } else if (a === '--out') { opt.out = v; i++; } else if (a === '--names') { opt.names = v.split(','); i++; }
}
fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = [];

async function open(label) {
  const context = await browser.newContext({ viewport: { width: opt.w, height: opt.h } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${label} [${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`${label} [pageerror] ${e.message}\n${e.stack}`));
  await page.goto(`http://localhost:${opt.port}/`);
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
  await page.waitForTimeout(opt.wait);
  return page;
}

async function login(page, name, password, { shoot = null } = {}) {
  await page.click('#connect-open');
  await page.fill('#connect-address', opt.mud);
  await page.fill('#connect-name', name);
  await page.fill('#connect-password', password);
  await page.click('#connect-go');
  await page.waitForFunction(() => !document.getElementById('connect-new').hidden || !!(window.diku && window.diku.link)
    || (/\S/.test(document.getElementById('connect-status').textContent) && !/Connecting/.test(document.getElementById('connect-status').textContent)), null, { timeout: 10000 });
  if (!(await page.isHidden('#connect-new'))) {
    if (shoot) await page.screenshot({ path: shoot });
    await page.fill('#connect-password2', password);
    await page.click('#connect-class button:nth-child(1)');
    await page.click('#connect-go');
  }
  await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 10000 });
  await page.waitForTimeout(1500);
}

const a = await open('A');
// The title, with the server door open but nothing typed yet.
await a.click('#connect-open');
await a.waitForTimeout(300);
await a.screenshot({ path: `${opt.out}/title-connect.png` });
// A server that is not there: the failure, in words, and play-alone still beside it.
await a.fill('#connect-address', 'localhost:4999');
await a.fill('#connect-name', 'Nobody');
await a.fill('#connect-password', 'nothing');
await a.click('#connect-go');
await a.waitForFunction(() => /\S/.test(document.getElementById('connect-status').textContent) && !/Connecting/.test(document.getElementById('connect-status').textContent), null, { timeout: 15000 });
await a.screenshot({ path: `${opt.out}/connect-failed.png` });
console.log('failure text:', await a.textContent('#connect-status'));
await a.click('#connect-open');
await login(a, opt.names[0], 'elbereth', { shoot: `${opt.out}/connect-new.png` });

const b = await open('B');
await login(b, opt.names[1], 'gondor1');

// Stand them two metres apart in the temple, each turned to face the other.
const place = async (page, dx, yaw) => page.evaluate(([dx, yaw]) => {
  const info = window.diku.built.rooms.get(3001);
  window.diku.state.paused = false;
  window.diku.look(info.center.x + dx, info.center.y + 1.72, info.center.z + 1.5, yaw, -0.05);
  return { x: info.center.x + dx, z: info.center.z };
}, [dx, yaw]);
await place(a, -1.3, -Math.PI / 2);
await place(b, 1.3, Math.PI / 2);
await a.waitForTimeout(2500);
for (const [page, name] of [[a, 'A'], [b, 'B']]) {
  const seen = await page.evaluate(() => {
    const link = window.diku.link;
    return [...link.remotes.values()].map((r) => ({ name: r.info.name, visible: r.figure.group.visible, at: r.figure.group.position.toArray().map((v) => +v.toFixed(2)), samples: r.samples.length }));
  });
  console.log(name, 'sees', JSON.stringify(seen));
  await page.screenshot({ path: `${opt.out}/${name}-sees.png` });
}
// A says something; B's log should show it.
await a.evaluate(() => window.diku.game.interpret('say well met, son of Gondor'));
await b.waitForTimeout(800);
await b.screenshot({ path: `${opt.out}/B-hears.png` });
console.log('B log:', JSON.stringify(await b.evaluate(() => [...document.querySelectorAll('#g-log > *, #log > *')].slice(-6).map((n) => n.textContent))));
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
