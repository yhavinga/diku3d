// Every way up and down in the world, and what the room shows for it.
//
// A Diku exit up or down is as real as one north, but the room has to show it:
// a flight, a ladder, a shaft or well, steps up to a door -- or the player
// learns of it only from the text. build.js records what it put down for each
// such exit (`built.stats.ways`); this visits every zone, compares that with
// the exits of every room the zone lays out, and counts by kind.
//
//   cp <repo>/tools/judge/headless/ways.mjs /tmp/pw/
//   node /tmp/pw/ways.mjs --port 8173 [--out /tmp/ways.json] [--zone 3001]
//
// Kinds: flight (a staircase between rooms the grid stacked), ladder, pit,
// well, climb (steps up to a door), arch (an archway: not up or down), gate
// (a barred archway: not up or down, and closed), none (nothing built).
// Exits that are not shown on purpose are counted apart: to a room in the
// air (scenery, never built), from a room in the air, and the stock files'
// exits to room -1. `vertical` is every exit shown by something that goes
// up or down; `unmarked` is arch + gate + none.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8173, out: null, zone: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') opt.port = +args[++i];
  else if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--zone') opt.zone = +args[++i];
}

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${opt.port}/`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 180000 });
await page.waitForTimeout(4000);
const res = await page.evaluate(async (only) => {
  const d = window.diku;
  const AIR = 9;
  const zones = only ? [d.plan.zoneOf(only)] : d.plan.zones;
  const rows = [];
  for (const zone of zones) {
    // The sky area is nothing but rooms in the air, and none of them is built.
    const stand = [zone.start, ...zone.rooms].find((v) => d.world.rooms.get(v)?.sector !== AIR);
    if (stand === undefined) continue;
    await d.goto(stand);
    const built = d.built; const layout = d.layout;
    const shown = new Map();
    for (const w of built.stats.ways || []) {
      const k = `${w.room}:${w.dir}`;
      // A room can be given two markers for one exit (a way out and the far
      // end of another's); the vertical one counts.
      const prev = shown.get(k);
      if (!prev || ['arch', 'gate'].includes(prev)) shown.set(k, w.how);
    }
    for (const [vnum] of layout.cells) {
      const room = d.world.rooms.get(vnum);
      if (!room || d.plan.zoneOf(vnum) !== zone) continue;
      for (const dir of [4, 5]) {
        const exit = room.exits[dir];
        if (!exit) continue;
        const target = d.world.rooms.get(exit.to);
        let how = shown.get(`${vnum}:${dir}`) || 'none';
        if (exit.to < 0) how = 'dead';
        else if (room.sector === AIR) how = 'airborne';
        else if (target && target.sector === AIR && how === 'none') how = 'sky';
        rows.push({ zone: zone.id, room: vnum, name: room.name, dir, to: exit.to, how, cross: !layout.cells.has(exit.to) });
      }
    }
  }
  return rows;
}, opt.zone);
const count = {};
for (const r of res) count[r.how] = (count[r.how] || 0) + 1;
const vertical = ['flight', 'ladder', 'pit', 'well', 'climb'].reduce((s, k) => s + (count[k] || 0), 0);
const unmarked = ['arch', 'gate', 'none'].reduce((s, k) => s + (count[k] || 0), 0);
console.log(`${res.length} ways up or down:`, JSON.stringify(count));
console.log(`vertical ${vertical}, unmarked ${unmarked} (arch ${count.arch || 0}, gate ${count.gate || 0}, none ${count.none || 0})`);
for (const r of res.filter((x) => ['arch', 'gate', 'none'].includes(x.how)).slice(0, 60)) {
  console.log(`  ${r.how.padEnd(5)} #${r.room} ${r.dir === 4 ? 'up  ' : 'down'} -> #${r.to}${r.cross ? ' (other zone)' : ''}  ${r.name}`);
}
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(res, null, 1));
await browser.close();
