// The implementor's dashboard, driven: one implementor page and two mortal
// pages on one server. The mortals walk, say, tell, chat, fight, die and
// quit; the implementor opens the dashboard (Backquote), uses its buttons
// and follows a player, and each stage is shot from the implementor's page.
// A mortal's Backquote is shot too: it must do nothing.
//
//   node tools/judge/headless/mp-seed.mjs /tmp/dash-data     (Eomer, Theoden, Yeb; password1)
//   (cd server && node main.mjs --port 4042 --data /tmp/dash-data) &
//   python3 serve.py 8242 &
//   cp tools/judge/headless/mp-dash.mjs /tmp/pw/ && node /tmp/pw/mp-dash.mjs --port 8242 --mud localhost:4042 --out /tmp/dash
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8242, mud: 'localhost:4042', out: '/tmp/dash', wait: 14000, w: 1600, h: 900 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--mud') { opt.mud = v; i++; } else if (a === '--out') { opt.out = v; i++; }
}
fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(label, size) {
  const context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${label} [${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`${label} [pageerror] ${e.message}\n${e.stack}`));
  await page.goto(`http://localhost:${opt.port}/?quality=low`);
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
  await page.waitForTimeout(opt.wait);
  return page;
}

async function login(page, name) {
  await page.click('#connect-open');
  await page.fill('#connect-address', opt.mud);
  await page.fill('#connect-name', name);
  await page.fill('#connect-password', 'password1');
  await page.click('#connect-go');
  await page.waitForFunction(() => !!(window.diku && window.diku.link), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.diku.state.paused = false; });
}
const say = (page, line) => page.evaluate((l) => window.diku.game.interpret(l), line);
const shot = async (page, name) => { await page.screenshot({ path: `${opt.out}/${name}.png` }); console.log('shot', `${opt.out}/${name}.png`); };
const dashState = (page) => page.evaluate(() => ({
  open: window.diku.dashboard.open, allowed: window.diku.dashboard.allowed(),
  rows: document.querySelectorAll('#dh-who tbody tr').length, events: document.querySelectorAll('#dh-log .dh-ev').length,
  did: document.getElementById('dh-did').textContent,
}));

const y = await open('Yeb', { width: opt.w, height: opt.h });
await login(y, 'Yeb');
const e = await open('Eomer', { width: 960, height: 540 });
await login(e, 'Eomer');
const t = await open('Theoden', { width: 960, height: 540 });
await login(t, 'Theoden');

// A mortal's backquote: nothing.
await e.keyboard.press('Backquote');
await e.waitForTimeout(500);
console.log('Eomer after `:', JSON.stringify(await dashState(e)));
await shot(e, 'mortal-backquote');

// The implementor opens it.
await y.keyboard.press('Backquote');
await y.waitForTimeout(2500);
console.log('Yeb after `:', JSON.stringify(await dashState(y)));
await shot(y, 'dash-open');

// Talk and walking.
await say(e, 'say hail, the dashboard');
await say(e, 'tell theoden a word for you alone');
await say(t, 'chat anyone for the sewers?');
await say(e, 'north');
await wait(2500);
await say(e, 'south');
await wait(1500);
await shot(y, 'dash-talk');

// A fight: a weak mobile of the home zone, Eomer put beside it by the implementor's console.
const prey = await y.evaluate(() => {
  const g = window.diku.game;
  const slot = g.mobs.find((s) => !s.dead && s.roomVnum && s.proto.level <= 3 && !/keeper|guard|master|mayor|cityguard/i.test(s.proto.short)
    && window.diku.built.rooms.has(s.roomVnum) && !(window.diku.world.rooms.get(s.roomVnum).flags & 1024));
  return slot ? { vnum: slot.roomVnum, kw: slot.proto.keywords.split(' ')[0], short: slot.proto.short } : null;
});
console.log('prey', JSON.stringify(prey));
await y.evaluate(() => window.diku.dashboard.hide());
await say(y, `transfer eomer ${prey.vnum}`);
await wait(2500);
await say(e, `kill ${prey.kw}`);
await say(y, 'dashboard');
await wait(1200);
console.log('Yeb after typed dashboard:', JSON.stringify(await dashState(y)));
await wait(5000);
await shot(y, 'dash-fight');
await shot(e, 'mortal-fighting');

// Follow Eomer: the map.
await y.evaluate(() => {
  const rows = [...document.querySelectorAll('#dh-who tbody tr')];
  const row = rows.find((r) => /Eomer/.test(r.textContent));
  row.querySelector('[data-act="follow"]').click();
});
await wait(2500);
await say(e, 'south');
await wait(3000);
await shot(y, 'dash-follow');

// A player's death, a restore, a snoop, the wizlock, and a quit.
await y.evaluate(() => window.diku.dashboard.hide());
await say(y, 'at theoden slay theoden');
await wait(1500);
await y.keyboard.press('Backquote');
await wait(2500);
await y.evaluate(() => {
  const row = [...document.querySelectorAll('#dh-who tbody tr')].find((r) => /Eomer/.test(r.textContent));
  row.querySelector('[data-act="restore"]').click();
  row.querySelector('[data-act="snoop"]').click();
});
await wait(1200);
await say(e, 'say does anyone read over my shoulder?');
await y.evaluate(() => document.querySelector('[data-act="wizlock"]').click());
await wait(1500);
await say(t, 'quit');
await wait(2500);
console.log('Yeb at the end:', JSON.stringify(await dashState(y)));
await shot(y, 'dash-death-quit');
// Filters: only talk.
await y.evaluate(() => {
  for (const b of document.querySelectorAll('[data-chip]')) if ((b.dataset.chip === 'talk') !== b.classList.contains('on')) b.click();
});
await wait(500);
await shot(y, 'dash-filter-talk');
await y.evaluate(() => document.querySelector('[data-act="wizlock"]').click());
await wait(800);
// Closed on the key that opened it.
await y.keyboard.press('Backquote');
await wait(800);
console.log('Yeb after closing:', JSON.stringify(await dashState(y)));
await shot(y, 'dash-closed');
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
