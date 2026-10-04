// The implementor's dashboard (its god view), driven: one implementor page and two mortal
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
  rows: document.querySelectorAll('[data-player]').length, events: document.querySelectorAll('#dh-log .dh-ev').length,
  did: document.querySelector('#dh-card .did')?.textContent || '',
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

// The implementor opens it: the god view, his own zone first.
await y.keyboard.press('Backquote');
await y.waitForFunction(() => window.diku.dashboard.view && window.diku.dashboard.view.ready, null, { timeout: 15000 });
await y.waitForTimeout(2500);
console.log('Yeb after `:', JSON.stringify(await dashState(y)), JSON.stringify(await y.evaluate(() => window.diku.dashboard.view.census())));
await shot(y, 'god-open');
// The whole atlas, every zone.
await y.evaluate(() => { const v = window.diku.dashboard.view; v.look.dist = 9000; v.look.pitch = 1.2; });
await y.waitForTimeout(800);
await shot(y, 'god-atlas');
await y.evaluate(() => { const v = window.diku.dashboard.view; v.look.pitch = 0.95; });
// The camera by hand: wheel in towards a point, drag to turn, right-drag to pan, W to fly.
const lookNow = () => y.evaluate(() => { const l = window.diku.dashboard.view.look; return { d: +l.dist.toFixed(1), yaw: +l.yaw.toFixed(3), pitch: +l.pitch.toFixed(3), x: +l.target.x.toFixed(1), z: +l.target.z.toFixed(1) }; });
console.log('camera before:', JSON.stringify(await lookNow()));
await y.mouse.move(900, 500);
for (let i = 0; i < 5; i++) { await y.mouse.wheel(0, -300); await wait(60); }
console.log('after wheel in:', JSON.stringify(await lookNow()));
await y.mouse.down(); await y.mouse.move(980, 520, { steps: 6 }); await y.mouse.up();
console.log('after drag:', JSON.stringify(await lookNow()));
await y.mouse.down({ button: 'right' }); await y.mouse.move(860, 460, { steps: 6 }); await y.mouse.up({ button: 'right' });
console.log('after right-drag:', JSON.stringify(await lookNow()));
await y.keyboard.down('KeyW'); await wait(400); await y.keyboard.up('KeyW');
console.log('after W:', JSON.stringify(await lookNow()));
await shot(y, 'god-hand');

// Talk and walking.
await say(e, 'say hail, the dashboard');
await say(e, 'tell theoden a word for you alone');
await say(t, 'chat anyone for the sewers?');
await say(e, 'north');
await wait(2500);
await say(e, 'south');
await wait(1500);

// A fight: a weak mobile of the home zone, Eomer put beside it from the console.
const prey = await y.evaluate(() => {
  const g = window.diku.game;
  const slot = g.mobs.find((s) => !s.dead && s.roomVnum && s.proto.level <= 3 && !/keeper|guard|master|mayor|cityguard/i.test(s.proto.short)
    && window.diku.dashboard.view.roomAt(s.roomVnum) && window.diku.dashboard.view.roomAt(s.roomVnum).zone === 'home'
    && !(g.world.rooms.get(s.roomVnum).flags & 1024));
  return slot ? { vnum: slot.roomVnum, kw: slot.proto.keywords.split(' ')[0], short: slot.proto.short } : null;
});
console.log('prey', JSON.stringify(prey));
await y.keyboard.press('Backquote');
await say(y, `transfer eomer ${prey.vnum}`);
await wait(2500);
await say(e, `kill ${prey.kw}`);
await say(y, 'dashboard');
await y.waitForTimeout(1500);
console.log('Yeb after typed dashboard:', JSON.stringify(await dashState(y)));
// Pick Eomer in the list: the camera goes to him and his card comes up.
await y.evaluate(() => [...document.querySelectorAll('[data-player]')].find((r) => /Eomer/.test(r.textContent)).click());
await y.evaluate(() => { document.querySelector('#dh-card [data-act="look"]').click(); });
await wait(4000);
await shot(y, 'god-fight');
await shot(e, 'mortal-fighting');

// Follow-camera on Eomer while he walks.
await y.evaluate(() => document.querySelector('#dh-card [data-act="follow"]').click());
await wait(1500);
await say(e, 'south');
await wait(1200);
await shot(y, 'god-follow-1');
await wait(2000);
await shot(y, 'god-follow-2');
await y.evaluate(() => document.querySelector('#dh-card [data-act="follow"]').click());

// Search: a room by name, flown to.
await y.click('#dh-search');
await y.keyboard.type('market');
await wait(400);
await shot(y, 'god-search');
await y.click('[data-result="1"]');
await wait(1500);
console.log('search card:', await y.evaluate(() => document.querySelector('#dh-card .ttl')?.textContent), 'list open:', await y.evaluate(() => document.getElementById('dh-results').classList.contains('on')));
await shot(y, 'god-search-flown');

// Click in the view (what is under the middle of the screen), then a room's card, and goto from it.
const clicked = await y.evaluate(() => {
  const r = window.diku.renderer.domElement.getBoundingClientRect();
  return window.diku.dashboard.view.pick(r.left + r.width / 2, r.top + r.height / 2);
});
console.log('picked at the centre:', JSON.stringify(clicked));
await y.evaluate(() => window.diku.dashboard.select({ kind: 'room', vnum: 3014 }));
await y.evaluate(() => document.querySelector('#dh-card [data-act="look"]').click());
await wait(1200);
await y.evaluate(() => document.querySelector('#dh-card [data-act="goto"]').click());
await wait(1800);
console.log('goto from the card:', await y.evaluate(() => document.querySelector('#dh-card .did').textContent));
await shot(y, 'god-goto');

// A player's death, a restore, a snoop, the wizlock, and a quit.
await y.keyboard.press('Backquote');
await say(y, 'at theoden slay theoden');
await wait(1500);
await y.keyboard.press('Backquote');
await y.waitForTimeout(2000);
await y.evaluate(() => {
  [...document.querySelectorAll('[data-player]')].find((r) => /Eomer/.test(r.textContent)).click();
  document.querySelector('#dh-card [data-act="restore"]').click();
  document.querySelector('#dh-card [data-act="snoop"]').click();
});
await wait(1200);
await say(e, 'say does anyone read over my shoulder?');
await y.evaluate(() => document.querySelector('[data-act="wizlock"]').click());
await wait(1500);
await say(t, 'quit');
await wait(2500);
console.log('Yeb at the end:', JSON.stringify(await dashState(y)));
await shot(y, 'god-death-quit');
// Only talk, and the health strip folded away.
await y.evaluate(() => {
  for (const b of document.querySelectorAll('[data-chip]')) if ((b.dataset.chip === 'talk') !== b.classList.contains('on')) b.click();
  document.querySelector('[data-panel="health"]').click();
});
await wait(500);
await shot(y, 'god-filter-talk');
await y.evaluate(() => { document.querySelector('[data-panel="health"]').click(); document.querySelector('[data-act="wizlock"]').click(); });
await wait(800);
// Closed on the key that opened it: the world again.
await y.keyboard.press('Backquote');
await wait(1500);
console.log('Yeb after closing:', JSON.stringify(await dashState(y)));
await shot(y, 'god-closed');
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
