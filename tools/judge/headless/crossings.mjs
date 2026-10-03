// Every way north, east, south or west into another zone, and whether its
// gate behaves like one.
//
// A crossing is shown as a barred archway (build.js `buildCrossing`) and is
// taken by walking into it (main.js `walkIntoCrossing`). Three ways that goes
// wrong, all of which shipped at Midgaard's #3040 -> #101 (smurf.are):
//
//   ghost   the bars are not solid: you walk through the portcullis into
//           whatever the grid has behind it, and nothing crosses
//   behind  the space behind the bars can be reached on foot from the room
//           (round its posts, along a street routed past it) -- a gate you
//           can look at from the back, which leads nowhere from there. The
//           space is what build.js's record says is closed (`back`, the
//           lodge's pocket); standing behind a solid wall does not count
//   dead    walking into it from the front does not cross
//
// plus, with --zfight, the flicker pixels within 3 m of the gate seen from
// in front (tools/judge/zfight.js: surfaces tied in depth whose colour also
// changes), and `unmarked` for a crossing the room shows nothing for.
//
//   cp <repo>/tools/judge/headless/crossings.mjs /tmp/pw/
//   node /tmp/pw/crossings.mjs --port 8173 [--zones home,smurf | --all] [--zfight] [--out /tmp/x.json]
//
// Reachability is a flood fill on a 0.25 m grid over the room's cell and two
// cells round it, with the player's own radius, step and height against the
// built colliders and platforms (player.js), and the gate's own opening
// treated as shut -- going *through* it is the crossing, not a way round.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = { port: 8173, zones: 'home', all: false, zfight: false, out: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--port') { opt.port = +v; i++; }
  else if (a === '--zones') { opt.zones = v; i++; }
  else if (a === '--all') opt.all = true;
  else if (a === '--zfight') opt.zfight = true;
  else if (a === '--out') { opt.out = v; i++; }
}

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${opt.port}/`);
await page.waitForFunction(() => window.diku && window.diku.built, null, { timeout: 180000 });
await page.waitForTimeout(6000);
await page.evaluate(() => {
  for (const id of ['title', 'loading']) document.getElementById(id)?.classList.add('hidden');
});

const rows = await page.evaluate(async ({ zones: wanted, all, zfight }) => {
  const d = window.diku;
  const DIRS = ['north', 'east', 'south', 'west'];
  const AIR = 9;
  const RADIUS = 0.42, STEP_UP = 0.62, HEIGHT = 1.8, CELL = 13;
  const Z = zfight ? (await import('/tools/judge/zfight.js')).install() : null;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const zones = all ? d.plan.zones : wanted.split(',').map((id) => d.plan.byId.get(id)).filter(Boolean);
  const out = [];
  d.state.paused = true;
  for (const zone of zones) {
    const crossings = d.plan.crossings.filter((c) => c.fromZone === zone.id && c.dir < 4
      && d.world.rooms.get(c.to)?.sector !== AIR && d.world.rooms.get(c.from)?.sector !== AIR);
    if (!crossings.length) continue;
    const stand = [zone.start, ...zone.rooms].find((v) => d.world.rooms.get(v)?.sector !== AIR);
    if (d.zone !== zone) await d.goto(stand);
    const built = d.built, layout = d.layout, player = d.player;
    for (const c of crossings) {
      const row = { zone: zone.id, from: c.from, dir: DIRS[c.dir], to: c.to, toZone: c.toZone, name: d.world.rooms.get(c.from).name };
      out.push(row);
      const info = built.rooms.get(c.from);
      if (!info || info.unbuilt) { row.state = 'unbuilt'; continue; }
      row.outdoor = !!info.outdoor;
      const cell = layout.cells.get(c.from);
      const [sx, , sz] = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]][c.dir];
      const nb = layout.at(cell.level, cell.x + sx, cell.z + sz);
      row.beyond = nb !== undefined ? 'room' : layout.passageAt(cell.level, cell.x + sx, cell.z + sz) ? 'street' : 'filler';
      // The gate: build.js's record when it keeps one, else the old sign
      // (0.9 m inside the arch, facing out).
      let gate = (built.crossings || []).find((g) => g.room === c.from && g.dir === c.dir);
      if (!gate) {
        const sign = built.decor.find((s) => s.kind === 'gateSign' && s.text === DIRS[c.dir]
          && Math.hypot(s.x - info.center.x, s.z - info.center.z) < 9);
        if (sign) gate = { x: sign.x + sign.dx * 0.9, z: sign.z + sign.dz * 0.9, out: [sign.dx, sign.dz], legacy: true };
      }
      if (!gate) { row.state = 'unmarked'; continue; }
      // On the wall the exit names, on another (the layout's wall allocation;
      // see exit-check.mjs), or -- before build.js kept a record -- judged
      // from where the sign hangs.
      if (gate.legacy) row.side = Math.abs(gate.x - info.center.x - sx * 6.4) + Math.abs(gate.z - info.center.z - sz * 6.4) < 4 ? 'wall' : 'off-wall';
      else row.side = gate.wall === c.dir ? 'wall' : 'off-wall';
      const [ox, oz] = gate.out;
      const tx = -oz, tz = ox;
      const feetY = info.center.y;
      const near = [];
      const items = built.colliders.filter((k) => k.y1 > feetY + STEP_UP && k.y0 < feetY + HEIGHT
        && k.x1 > info.center.x - 3 * CELL && k.x0 < info.center.x + 3 * CELL
        && k.z1 > info.center.z - 3 * CELL && k.z0 < info.center.z + 3 * CELL);
      const blocked = (x, z) => items.some((k) => {
        if (k.door && k.door.open) return false;
        if (k.r) return Math.hypot(x - (k.x0 + k.x1) / 2, z - (k.z0 + k.z1) / 2) < k.r + RADIUS;
        return x > k.x0 - RADIUS && x < k.x1 + RADIUS && z > k.z0 - RADIUS && z < k.z1 + RADIUS;
      });
      const ground = (x, z) => Math.abs(player.groundAt(x, z, feetY) - feetY) <= STEP_UP;
      const rel = (x, z) => [(x - gate.x) * ox + (z - gate.z) * oz, (x - gate.x) * tx + (z - gate.z) * tz];
      // The opening, shut: a slab 1 m deep across it.
      const inOpening = (x, z) => { const [dep, al] = rel(x, z); return Math.abs(dep) < 0.5 && Math.abs(al) < 2.4; };
      const walkable = (x, z) => ground(x, z) && !blocked(x, z);
      row.ghost = walkable(gate.x, gate.z);
      // Flood from the room's middle.
      const R = 0.25, span = Math.round(2.5 * CELL / R);
      const x0 = info.center.x - span * R, z0 = info.center.z - span * R, n = span * 2 + 1;
      const seen = new Uint8Array(n * n);
      const [fx, fz] = player.resolvePoint(info.center.x, info.center.z, feetY);
      const queue = [[Math.round((fx - x0) / R), Math.round((fz - z0) / R)]];
      let behind = null;
      // What counts as behind the bars: the space build.js says is closed
      // there (to the lodge's back, or the wall's), or before it kept a
      // record, 0.6-2.5 m out and 2 m either side of the middle.
      const [b0, b1, bw] = gate.legacy ? [0.6, 2.5, 2.0] : [0.45, gate.back, gate.pocket ? gate.pocket.half : gate.half];
      // The nearest the player gets to the bars, in the middle of the opening.
      let front = null;
      seen[queue[0][1] * n + queue[0][0]] = 1;
      while (queue.length) {
        const [i, j] = queue.pop();
        const x = x0 + i * R, z = z0 + j * R;
        const [dep, al] = rel(x, z);
        if (dep > b0 && dep < b1 && Math.abs(al) < bw && !behind) behind = [+x.toFixed(2), +z.toFixed(2)];
        if (dep <= 0 && Math.abs(al) < 0.5 && (!front || dep > front[2])) front = [x, z, dep];
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= n || b >= n || seen[b * n + a]) continue;
          seen[b * n + a] = 1;
          const px = x0 + a * R, pz = z0 + b * R;
          if (inOpening(px, pz) || !walkable(px, pz)) continue;
          queue.push([a, b]);
        }
      }
      row.behind = behind;
      const yawOut = Math.atan2(-ox, -oz);
      row.reach = front ? +front[2].toFixed(2) : null;
      if (!front || front[2] < -3) row.trigger = 'no footing';
      else if (d.crossingAt) row.trigger = d.crossingAt(front[0], front[1], yawOut, feetY) === c.dir ? 'ok' : 'dead';
      else {
        // main.js before built.crossings: within 1.5 m of the sign, facing out.
        const sign = { x: gate.x - ox * 0.9, z: gate.z - oz * 0.9 };
        row.trigger = Math.hypot(front[0] - sign.x, front[1] - sign.z) <= 1.5 ? 'ok' : 'dead';
      }
      if (Z) {
        const view = async (dist, yaw) => {
          d.look(gate.x - ox * dist, feetY + 1.72, gate.z - oz * dist, yaw, 0.08);
          for (let k = 0; k < 3; k++) await frame();
          const m = Z.measure({ detail: true, scale: 0.5 });
          let px = 0;
          for (const p of m.pairs) {
            const at = [p.a.at, p.b.at].filter(Boolean);
            if (at.some((a) => Math.hypot(a[0] - gate.x, a[2] - gate.z) < 3)) px += p.n;
          }
          return px;
        };
        row.zFront = await view(4, yawOut);
        row.zBack = await view(-4, yawOut + Math.PI);
      }
    }
  }
  return out;
}, { zones: opt.zones, all: opt.all, zfight: opt.zfight });

const count = { crossings: rows.length, unbuilt: 0, unmarked: 0, offWall: 0, ghost: 0, behind: 0, dead: 0, zFront: 0, zBack: 0, zGates: 0 };
for (const r of rows) {
  if (r.state === 'unbuilt') { count.unbuilt++; continue; }
  if (r.state === 'unmarked') { count.unmarked++; continue; }
  if (r.side === 'off-wall') count.offWall++;
  if (r.ghost) count.ghost++;
  if (r.behind) count.behind++;
  if (r.trigger !== 'ok') count.dead++;
  count.zFront += r.zFront || 0; count.zBack += r.zBack || 0;
  if ((r.zFront || 0) + (r.zBack || 0) > 0) count.zGates++;
}
for (const r of rows) {
  const flags = r.state || [r.side, r.outdoor ? 'outdoor' : 'indoor', `beyond ${r.beyond}`,
    r.ghost ? 'GHOST' : '', r.behind ? `BEHIND@${r.behind}` : '', r.trigger !== 'ok' ? `TRIGGER ${r.trigger} (nearest ${r.reach} m)` : '',
    r.zFront !== undefined ? `z ${r.zFront}/${r.zBack}` : ''].filter(Boolean).join(' ');
  console.log(`${r.zone.padEnd(9)} #${r.from} ${r.dir.padEnd(5)} -> #${r.to} (${r.toZone})  ${flags}   ${r.name}`);
}
console.log(JSON.stringify(count));
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify({ count, rows }, null, 1));
await browser.close();
