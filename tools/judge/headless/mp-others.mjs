// Two pages on one diku3d server, looking at each other: the other player's
// contact shadow at noon and dusk, a `say` over their head, and a click on
// them -- do_kill's refusal, then the second click that is do_murder.
//   node tools/judge/headless/mp-seed.mjs <server data dir>   (Eomer L5 aged 25, Theoden L9)
//   node /tmp/pw/mp-others.mjs --port 8211 --mud localhost:4011 --out /tmp/mp
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8211, mud: 'localhost:4011', out: '/tmp/mp', wait: 12000 };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; } else if (a === '--mud') { opt.mud = v; i++; } else if (a === '--out') { opt.out = v; i++; }
}
fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = [];

async function enter(name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/ointer/.test(m.text())) logs.push(`${name} [${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`${name} [pageerror] ${e.message}\n${e.stack}`));
  await page.goto(`http://localhost:${opt.port}/`);
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
  await page.waitForTimeout(opt.wait);
  await page.click('#connect-open');
  await page.fill('#connect-address', opt.mud);
  await page.fill('#connect-name', name);
  await page.fill('#connect-password', 'password1');
  await page.click('#connect-go');
  await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 15000 });
  await page.evaluate(() => { window.diku.state.paused = false; window.__said = []; window.diku.game.listen((e) => { if (e.text) window.__said.push(e.text); }); });
  await page.waitForTimeout(2000);
  return page;
}
const said = (page, from = 0) => page.evaluate((n) => window.__said.slice(n), from);
const mark = (page) => page.evaluate(() => window.__said.length);
/**
 * A short step within the room the player is in -- a report the server
 * believes (a jump across the map would be refused and put back).
 */
const stand = (page, dx, dz, yaw, pitch = -0.12) => page.evaluate(([dx, dz, yaw, pitch]) => {
  const { built, game } = window.diku;
  const info = built.rooms.get(game.state.roomVnum);
  window.diku.look(info.center.x + dx, info.center.y + 1.72, info.center.z + dz, yaw, pitch);
  return game.state.roomVnum;
}, [dx, dz, yaw, pitch]);
const hour = (page, name) => page.evaluate((n) => window.diku.applyTime(n), name);

const e = await enter('Eomer');
const t = await enter('Theoden');
console.log('rooms:', await e.evaluate(() => window.diku.game.state.roomVnum), await t.evaluate(() => window.diku.game.state.roomVnum));
// Theoden looks at Eomer from four metres, a little above so the ground shows.
await stand(e, -1.0, 0, -Math.PI / 2);
await stand(t, 3.0, 0.4, Math.PI / 2 + 0.1, -0.22);
await e.waitForTimeout(1500);
for (const when of ['noon', 'dusk']) {
  await hour(t, when);
  await t.waitForTimeout(1500);
  await t.screenshot({ path: `${opt.out}/shadow-${when}.png` });
}
await hour(t, 'noon');
const shadow = await t.evaluate(() => [...window.diku.link.remotes.values()].map((r) => {
  const meshes = r.figure.group.children.filter((c) => c.isMesh && c.material && c.material.alphaMap);
  return { name: r.info.name, shadows: meshes.map((m) => ({ visible: m.visible, opacity: +m.material.opacity.toFixed(2), scale: m.scale.toArray().map((v) => +v.toFixed(2)) })) };
}));
console.log('Theoden sees:', JSON.stringify(shadow));

// --------------------------------------------------------------- speech
await stand(t, 2.2, 0, Math.PI / 2, -0.05);
await e.evaluate(() => window.diku.game.interpret('say Well met, Theoden.'));
await t.waitForTimeout(900);
await t.screenshot({ path: `${opt.out}/speech.png` });
console.log('Theoden read:', JSON.stringify((await said(t)).slice(-3)));

// ------------------------------------------------------- click to attack
await stand(e, -0.8, 0, -Math.PI / 2, -0.05);
await stand(t, 0.8, 0, Math.PI / 2, -0.05);
await e.waitForTimeout(800);
let me = await mark(e);
let mt = await mark(t);
await e.evaluate(() => window.diku.game.attack());
await e.waitForTimeout(900);
console.log('first click, Eomer read:', JSON.stringify(await said(e, me)));
await e.screenshot({ path: `${opt.out}/click-refused.png` });
me = await mark(e);
await e.evaluate(() => window.diku.game.attack());
await e.waitForTimeout(3500);
console.log('second click, Eomer read:', JSON.stringify((await said(e, me)).slice(0, 8)));
console.log('Theoden read:', JSON.stringify((await said(t, mt)).slice(0, 8)));
await e.screenshot({ path: `${opt.out}/click-murder-attacker.png` });
await t.screenshot({ path: `${opt.out}/click-murder-victim.png` });
await t.evaluate(() => window.diku.game.interpret('flee'));
await t.waitForTimeout(600);
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
