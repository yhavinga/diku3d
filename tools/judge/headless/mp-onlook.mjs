// What a player who is neither the caster nor the victim sees: nothing that reads as "me".
// A server is started in this process; A (Anna) and B (Bob) are logged in over the wire, C (Cleo) is a real
// page that only watches. Three scenes -- A casts at a mobile; A casts at B in PvP; a mobile's gas breath hits
// A and B -- and on C's page no event may carry fromPlayer/toPlayer, no hit may be on "you" or on nobody, and
// none of the you-only effects may fire (screen shake, the hurt/flash wash, the "on the player" impact sound).
// A fourth thing is held in the first scene: a player in a fight turns to the foe on the watcher's page (within 30
// degrees, as the own body does) and plays a swing clip on her blows -- the others' facing is where their camera
// looks, which in a fight is anywhere.
//   node /tmp/pw/mp-onlook.mjs --page 8224 --out /tmp/onlook          (python3 serve.py 8224 beside it)
import { chromium } from 'playwright';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = { page: 8224, port: 4031, out: '/tmp/onlook', repo: process.env.REPO || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..') };
for (let i = 0; i < args.length; i += 2) { const k = args[i].slice(2); opt[k] = ['page', 'port'].includes(k) ? +args[i + 1] : args[i + 1]; }
fs.mkdirSync(opt.out, { recursive: true });
const R = (p) => pathToFileURL(path.join(opt.repo, p)).href;
const { startMud } = await import(R('server/mud.mjs'));
const { createAccounts, hashPassword } = await import(R('server/accounts.mjs'));
const { serialize } = await import(R('src/save.js'));
const { createCharacter, advanceLevel, Rng } = await import(R('src/game.js'));
const { titleFor } = await import(R('src/rules/actcomm.js'));
const { PLR } = await import(R('src/rules/handler.js'));
const WS = (await import(pathToFileURL(path.join(opt.repo, 'server/node_modules/ws/wrapper.mjs')).href)).default;

const data = fs.mkdtempSync('/tmp/onlook-data-');
const accounts = createAccounts(data);
const rng = new Rng(5);
async function seed(name, level) {
  const ch = createCharacter(0, { level: Math.min(level, 36), sex: 2, rng });
  while (ch.level < level) { ch.level += 1; advanceLevel(ch, rng); }
  ch.hit = ch.maxHit = 600; ch.mana = ch.maxMana = 900; ch.name = name; ch.displayName = name;
  for (const s of ['lightning bolt', 'fireball', 'armor']) ch.learned[s] = 100;
  accounts.store({ version: 1, name, created: 'seed', password: await hashPassword('password1'),
    char: { ...serialize(ch), room: 2362, title: titleFor(ch), played: 40000 } });
}
await seed('Anna', 25); await seed('Bob', 30); await seed('Cleo', 10);
const mud = await startMud({ root: opt.repo, dataDir: data, port: opt.port, tickMs: 50, log: (t) => { if (process.env.DEBUG && /refused|Cleo/.test(t)) console.log('  [mud]', t); } });
const { game } = mud;
const bots = {};
async function bot(name) {
  const ws = new WS(`ws://127.0.0.1:${opt.port}/ws`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const entered = new Promise((res) => ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'enter') res(m); }));
  ws.send(JSON.stringify({ t: 'login', name, password: 'password1' }));
  const en = await entered;
  const pc = game.players.find((p) => p.ch.name === name);
  ws.send(JSON.stringify({ t: 'pos', zone: 'mahntor', x: pc.position.x - 312000, y: pc.position.y, z: pc.position.z, yaw: 0, seq: en.seq }));
  bots[name] = ws;
}
await bot('Anna'); await bot('Bob');
const pcOf = (n) => game.players.find((p) => p.ch.name === n);
const run = (n, line) => game.withPlayer(pcOf(n), () => game.interpret(line));
const put = (n, x, z) => { const pc = pcOf(n); pc.position.x = 312000 + x; pc.position.z = z; };

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message} ${String(e.stack).split('\n').slice(1, 4).join(' | ')}`));
await page.goto(`http://localhost:${opt.page}/`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
await page.waitForTimeout(8000);
await page.click('#connect-open');
await page.fill('#connect-address', `localhost:${opt.port}`);
await page.fill('#connect-name', 'Cleo');
await page.fill('#connect-password', 'password1');
await page.click('#connect-go');
await page.waitForFunction(() => window.diku && window.diku.link, null, { timeout: 30000 });
await page.waitForFunction(() => window.diku.game.state.roomVnum === 2362 && window.diku.built.rooms.has(2362), null, { timeout: 240000 });
await page.waitForTimeout(6000);
// C: placed below
await page.evaluate(() => {
  const d = window.diku; d.state.paused = false; d.view.set(true);
  d.camera.position.set(31, 42, 328); d.camera.lookAt(26.8, 39.8, 336); d.view.pin(true);
  window.__seen = [];
  d.game.listen((e) => { if (['cast', 'spell', 'spell-fizzle', 'hit', 'miss', 'parry', 'dodge', 'death'].includes(e.kind)) window.__seen.push({ kind: e.kind, spell: e.spell, fromPlayer: e.fromPlayer, toPlayer: e.toPlayer, byPlayer: e.byPlayer, defended: e.defended, from: !!e.from, to: e.to === undefined ? 'undef' : !!e.to, hits: e.hits && e.hits.map((h) => ({ player: h.player, to: h.to ? (h.to.remote ? h.to.remote.info.name : 'mob') : null })) }); });
  window.__raw = []; d.link.link.on('ev', (m) => { for (const e of m.e) window.__raw.push(`${e.kind}:${e.spell || ''}:${e.from === null ? 'null' : JSON.stringify(e.from && e.from.p !== undefined ? e.from : typeof e.from)}>${e.to === null ? 'null' : JSON.stringify(e.to && e.to.p !== undefined ? e.to : typeof e.to)}`); });
  window.__you = { shake: 0, wash: 0, onPlayer: 0 };
  const sh = d.player.shake.bind(d.player); d.player.shake = (...a) => { window.__you.shake++; return sh(...a); };
  const an = Element.prototype.animate; // spellfx.js flashScreen: the 'screen'-blended wash laid over the frame, a three-keyframe fade
  Element.prototype.animate = function (...a) { if (this.style.mixBlendMode === 'screen' && Array.isArray(a[0]) && a[0].length === 3) window.__you.wash++; return an.apply(this, a); };
  const im = d.audio.impact.bind(d.audio); d.audio.impact = (kind, o = {}) => { if (o.onPlayer) window.__you.onPlayer++; return im(kind, o); };
});
// C goes where the room's reach does not (the server moves her; her next report is refused and the page follows)
// (blows are told to the room, so she watches the first two scenes from inside it; the gas must not reach her)
{ const pc = pcOf('Cleo'); pc.position.x = 312000 + 25.6; pc.position.z = 334.4; }
await page.waitForTimeout(2500);

// stage: the guard neither starts fights nor moves; Bob may be attacked (a KILLER), and stands near Anna
const slot = game.mobs.find((s) => s.proto.vnum === 2316 && s.roomVnum === 2362);
const inst = game.wakeSlot(slot);
inst.act &= ~32; inst.hit = inst.maxHit = 5000;
pcOf('Bob').ch.act |= PLR.KILLER;
put('Anna', 27.0, 336.0); put('Bob', 27.2, 334.8);
for (const n of ['Anna', 'Bob']) pcOf(n).ch.mana = 900;
await page.waitForTimeout(1200);

const results = [];
const sv = []; game.listen((e) => { if (process.env.DEBUG ? (e.text || e.kind === 'cast' || e.kind === 'spell') : (e.kind === 'cast' || e.kind === 'spell' || e.kind === 'note' || e.kind === 'out')) sv.push(`${e.kind} ${e.spell || ''} pc=${e.pc} fromCh=${!!e.fromCh} ${String(e.text || '').slice(0, 70)}`); });
async function scene(name, act) {
  sv.length = 0;
  await page.evaluate(() => {
    window.__clips = window.__clips || [];
    for (const r of window.diku.link.remotes.values()) if (!r.__w) { r.__w = true; const p = r.figure.perform; r.figure.perform = (clip, o) => { window.__clips.push([r.info.name, clip]); return p(clip, o); }; }
    window.__clips.length = 0;
  });
  await page.evaluate(() => { window.__raw.length = 0; window.__seen.length = 0; window.__you = { shake: 0, wash: 0, onPlayer: 0 }; });
  for (const n of ['Anna', 'Bob']) { const c = pcOf(n).ch; c.hit = c.maxHit; c.mana = 900; c.wait = 0; c.position = game.MERC.POS.STANDING; }
  act();
  await page.waitForTimeout(6500);
  const got = await page.evaluate(() => ({ seen: window.__seen.slice(), you: window.__you, raw: window.__raw.slice() }));
  if (process.env.DEBUG) console.log('  raw:', JSON.stringify(got.raw.map((r) => r.slice(0, 40))));
  const bad = [];
  for (const e of got.seen) {
    if (e.fromPlayer === true) bad.push(`${e.kind}: fromPlayer on an onlooker`);
    if (e.toPlayer === true) bad.push(`${e.kind}: toPlayer on an onlooker`);
    if (e.byPlayer === true) bad.push(`${e.kind}: byPlayer on an onlooker`);
    if (e.defended === true) bad.push(`${e.kind}: defended on an onlooker`);
    if (['hit', 'miss', 'parry', 'dodge'].includes(e.kind) && (e.from === false || e.to === false)) bad.push(`${e.kind}: a side that is nobody ("you")`);
    for (const h of e.hits || []) {
      if (h.player === true) bad.push(`${e.spell}: a hit on "you"`);
      if (h.to === null) bad.push(`${e.spell}: a hit on nobody (drawn at the camera)`);
    }
  }
  if (got.you.shake) bad.push(`player.shake fired ${got.you.shake}x`);
  if (got.you.wash) bad.push(`screen wash fired ${got.you.wash}x`);
  if (got.you.onPlayer) bad.push(`"on the player" impact sound ${got.you.onPlayer}x`);
  if (process.env.DEBUG) console.log('  fight', JSON.stringify({ mobHit: inst.hit, mobFightingAnna: inst.fighting === pcOf('Anna').ch, annaFightingMob: pcOf('Anna').ch.fighting === inst, annaPos: [pcOf('Anna').position.x - 312000, pcOf('Anna').position.z], mobPos: [slot.pos.x - 312000, slot.pos.z], pos: pcOf('Anna').ch.position, wait: pcOf('Anna').ch.wait }));
  if (process.env.DEBUG) console.log('  cleo', JSON.stringify([pcOf('Cleo').position.x - 312000, pcOf('Cleo').position.z]), 'mob', JSON.stringify([slot.pos.x - 312000, slot.pos.z]), 'remotes', JSON.stringify(await page.evaluate(() => [...window.diku.link.remotes.values()].map((r) => r.info.name))), JSON.stringify(got.seen.filter((e) => e.hits).map((e) => e.hits)));
  if (process.env.DEBUG) console.log('  server:', JSON.stringify(sv.slice(0, 40)), 'page:', JSON.stringify(got.seen.map((e) => e.kind + ':' + (e.spell || ''))));
  if (name.startsWith('A casts at a mobile')) {
    const f = await page.evaluate(() => {
      const d = window.diku; const r = [...d.link.remotes.values()].find((x) => x.info.name === 'Anna');
      const m = d.game.mobs.find((x) => x.proto.vnum === 2316); const at = m.figure && m.figure.at ? m.figure.at : m.pos;
      const want = Math.atan2(-(at.x - r.slot.pos.x), -(at.z - r.slot.pos.z));
      const have = r.figure.body.rotation.y - Math.PI;   // a figure faces +Z at yaw 0, the camera -Z
      const err = Math.abs(Math.atan2(Math.sin(want - have), Math.cos(want - have))) * 180 / Math.PI;
      return { fighting: !!r.info.fighting, err: +err.toFixed(1), clips: window.__clips.filter((c) => c[0] === 'Anna').map((c) => c[1]) };
    });
    console.log(`  Anna on Cleo's page: fighting ${f.fighting}, ${f.err} degrees off her foe, clips ${JSON.stringify([...new Set(f.clips)])}`);
    if (!f.fighting) bad.push('the fight the facing check needs was not on');
    else if (f.err > 30) bad.push(`a fighting player faces ${f.err} degrees off her foe on the watcher's page`);
    if (!f.clips.some((c) => /^attack/.test(c))) bad.push('no swing clip on her blows');
  }
  const spells = got.seen.filter((e) => e.kind === 'spell' || e.kind === 'cast').length;
  if (!spells) bad.push('the onlooker was told of no spell at all');
  results.push({ name, events: got.seen.length, spells, hits: got.seen.flatMap((e) => (e.hits || []).map((h) => h.to)), bad: [...new Set(bad)] });
}
await scene('A casts at a mobile, C watches', () => { run('Anna', "cast 'lightning bolt' minotaur"); setTimeout(() => run('Anna', 'kill minotaur'), 2200); });
// Merc refuses an offensive spell on a player ("You can't do that on a player."): PvP is a ward cast on B and blows
await scene('A casts at B and fights B (PvP), C watches', () => { inst.fighting = null; pcOf('Anna').ch.fighting = null; pcOf('Anna').ch.wait = 0; run('Anna', 'cast armor bob'); setTimeout(() => run('Anna', 'murder bob'), 2200); });
// the first two scenes may have put either of them down; the third needs both standing in sight of C
for (const n of ['Anna', 'Bob']) { const c = pcOf(n).ch; c.hit = c.maxHit; c.position = game.MERC.POS.STANDING; c.fighting = null; }
inst.fighting = null; put('Anna', 26.6, 335.5); put('Bob', 27.2, 334.8);
{ const pc = pcOf('Cleo'); pc.position.x = 312000 + 26.5; pc.position.z = 325.5; }
await page.waitForTimeout(1500);
await page.waitForFunction(() => window.diku.link.remotes.size === 2, null, { timeout: 15000 });
await page.waitForTimeout(1500);
await scene('a mobile breathes gas on A and B, C watches', () => { inst.fighting = pcOf('Anna').ch; inst.position = game.MERC.POS.FIGHTING; game.specFuns.spec_breath_gas(slot, inst); });
let fail = 0;
for (const r of results) {
  console.log(`${r.bad.length ? 'FAIL' : 'ok  '} ${r.name}: ${r.events} events, ${r.spells} spell events, hits on ${JSON.stringify(r.hits)}`);
  for (const b of r.bad) console.log(`       - ${b}`);
  fail += r.bad.length;
}
if (logs.length) console.log(logs.slice(0, 10).join('\n'));
await browser.close();
for (const ws of Object.values(bots)) ws.close();
mud.close();
console.log(fail ? 'FAILED' : 'all checks passed');
process.exit(fail ? 1 : 0);
