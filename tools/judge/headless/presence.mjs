// Boss presence is about a threat, not about being looked at (src/presence.js).
// Copy to /tmp/pw (playwright lives there) and run against a served checkout:
//   node /tmp/pw/presence.mjs --port 8216
// (a) a level-1 player in Midgaard's Main Street and Market Square, with every
//     boss-class mobile (cityguards, the mayor) turned to face them, keeps
//     presence at exactly 0 and the music out of the threat state;
// (b) the Mahn-Tor gate guard, who is aggressive, takes presence above 0.5;
// (c) a Minotaur Citizen, who is not aggressive and stands facing the player
//     (the other mobiles' aggression switched off), does not raise it.
import { chromium } from 'playwright';

const port = Number((process.argv.indexOf('--port') > 0 && process.argv[process.argv.indexOf('--port') + 1]) || 8173);
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
let failed = false;
const verdict = (name, ok, detail) => { if (!ok) failed = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${JSON.stringify(detail)}`); };

async function open(room) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/?room=${room}`);
  await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 120000 });
  await page.waitForTimeout(10000);
  await page.evaluate(() => { for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden'); window.diku.state.paused = false; window.diku.audio.start(); window.diku.game.chooseClass(0, { level: 1 }); });
  return { page, errors };
}

{
  const { page } = await open(3014);
  const r = await page.evaluate(async () => {
    const d = window.diku; const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const rooms = [3014, ...Object.values(d.world.rooms.get(3014).exits || {}).filter(Boolean).map((e) => e.to)].filter((v) => d.built.rooms.has(v));
    const out = { rooms: rooms.length, bossesInRange: 0, maxPresence: 0, threat: false, fightMusic: null, bad: [] };
    for (const v of rooms) {
      d.goto(v, 0, 0); await wait(1200);
      for (let i = 0; i < 12; i++) {
        const p = d.player.position; let near = 0;
        for (const s of d.game.mobs) {
          if (!s.here || s.dead || !s.figure) continue;
          const dx = p.x - s.pos.x; const dz = p.z - s.pos.z;
          if (Math.hypot(dx, dz) > 22) continue;
          if ((s.instance || s.proto).level - d.game.state.level >= 6) { near++; s.figure.object.rotation.y = Math.atan2(dx, dz); } // turned to look at you
        }
        out.bossesInRange = Math.max(out.bossesInRange, near);
        const fight = d.audio.music.state().fight;
        out.maxPresence = Math.max(out.maxPresence, d.presence.value);
        if (d.presence.threat) out.threat = true;
        if (fight) out.fightMusic = fight;
        if (d.presence.value !== 0 || d.presence.threat || fight) out.bad.push([v, d.presence.value, d.presence.cause]);
        await wait(100);
      }
    }
    return out;
  });
  verdict('(a) Midgaard, level 1, guards facing: presence stays 0, no threat music', r.maxPresence === 0 && !r.threat && !r.fightMusic && r.bossesInRange > 0, { ...r, bad: r.bad.slice(0, 3) });
  await page.close();
}

{
  const { page } = await open(2364);
  const gate = await page.evaluate(async () => {
    const d = window.diku; const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    let max = 0;
    for (const z of [366, 358, 352]) { d.player.spawn(26, 38, z, 0); await wait(1800); max = Math.max(max, d.presence.value); }
    return { max, level: d.game.state.level, guard: d.game.mobs.find((s) => s.roomVnum === 2362 && /Minotaur Guard/.test(s.proto.short)).proto.act & 32 };
  });
  verdict('(b) Mahn-Tor gate guard (aggressive) raises presence above 0.5', gate.max > 0.5 && gate.guard === 32, gate);
  await page.close();
}

{
  const { page } = await open(2364);
  const citizen = await page.evaluate(async () => {
    const d = window.diku; const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const c = d.game.mobs.find((s) => s.here && s.roomVnum === 2364 && /Minotaur Citizen/.test(s.proto.short));
    // Mahn-Tor's guards and warriors are aggressive (act 102 and 100) and would be in range: leave the citizen alone in it.
    for (const s of d.game.mobs) if (s !== c) s.proto.act &= ~32;
    const aggressive = c.proto.act & 32; let max = 0;
    for (const dist of [10, 7, 5]) {
      d.player.spawn(c.pos.x, 38, c.pos.z + dist, Math.PI); await wait(800);
      for (let i = 0; i < 10; i++) { c.figure.object.rotation.y = Math.atan2(d.player.position.x - c.pos.x, d.player.position.z - c.pos.z); max = Math.max(max, d.presence.value); await wait(100); }
    }
    return { max, aggressive, level: c.proto.level, me: d.game.state.level, fighting: !!d.game.state.fighting };
  });
  verdict('(c) a non-aggressive boss-class minotaur facing you does not raise presence', citizen.max === 0 && !citizen.aggressive && !citizen.fighting, citizen);
  await page.close();
}

await browser.close();
process.exit(failed ? 1 : 0);
