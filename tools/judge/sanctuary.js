// Sanctuary on a mobile, seen at 2 m and 10 m, with and without the affect.
//
// A new cleric has sanctuary at a practice level low enough that most casts
// end in "You lost your concentration", which is how a judge once could not
// see it at all. This makes the cast certain: a level 30 cleric who knows the
// spell perfectly casts it on the nearest mobile, and the frame is compared
// against the same camera with the affect's bit cleared -- so what is
// measured is the aura, not the scene.
//
//   node /tmp/pw/shot.mjs --port 8173 --query "areas=midgaard" \
//        --eval "window.SANCT = { room: 3014, time: 'night', out: '/tmp/sanct' }" \
//        --script tools/judge/sanctuary.js
//
// Needs the driver's `__shot(path)` to save frames; without it only the
// numbers come back. Returns, per distance, the mean and peak change in
// luma over the figure's screen box.
const opt = Object.assign({ room: 3014, time: 'noon', out: '/tmp/sanct', dists: [2, 10] }, window.SANCT || {});
const d = window.diku; const g = d.game;
const SANCTUARY = 128;  // AFF_SANCTUARY, merc.h
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
d.goto(opt.room, 0, 0);
d.applyTime(opt.time);
await wait(1500);
const p = d.player.position;
// A sentinel stands still for the camera; anyone else walks out of frame.
let slot = null; let best = 1e9;
for (const s of g.mobs) {
  if (s.dead || !s.figure || !s.figure.object || !s.figure.sentinel) continue;
  if (opt.who && !new RegExp(opt.who, 'i').test(s.record.proto.short)) continue;
  const k = Math.hypot(s.pos.x - p.x, s.pos.z - p.z);
  if (k < best) { best = k; slot = s; }
}
if (!slot) return 'no mobile with a figure near';
g.chooseClass(1, { level: 30 });
g.state.learned.sanctuary = 100;
g.state.mana = g.state.maxMana = 500;
const mob = slot.instance || (g.attackSlot && null) || slot.instance;
if (!mob) return 'mobile not awake';
const cast = g.cast('sanctuary', { target: mob });
await wait(2500);
const hold = { ...slot.pos };
const out = { mobile: slot.record.proto.short, cast: cast.text || cast.ok, affected: !!(mob.affectedBy & SANCTUARY), views: [] };
const gl = d.renderer.getContext();
function lumaBox(box) {
  d.composer.render();
  const [x0, y0, x1, y1] = box; const w = x1 - x0; const h = y1 - y0;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(x0, gl.drawingBufferHeight - y1, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const l = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) l[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  return l;
}
for (const dist of opt.dists) {
  Object.assign(slot.pos, hold);
  const f = slot.figure; const h = f.height || 1.8;
  // The first bearing from which the eye sees the chest unblocked.
  const nav = d.actors.nav;
  let dx = 0; let dz = 1;
  for (let b = 0; b < 16; b++) {
    const a = (b / 16) * Math.PI * 2 + (opt.bearing || 0);
    const ex = hold.x + Math.sin(a) * dist; const ez = hold.z + Math.cos(a) * dist;
    if (!nav || !nav.sightBlocked(ex, hold.y + 1.72, ez, hold.x, hold.y + h * 0.6, hold.z)) { dx = Math.sin(a); dz = Math.cos(a); break; }
  }
  d.look(hold.x + dx * dist, hold.y + 1.72, hold.z + dz * dist, Math.atan2(dx, dz), -Math.atan2(1.72 - h * 0.55, dist));
  await wait(900);
  // The figure's box on the drawing buffer, from its feet and head.
  const cam = d.camera; const W = gl.drawingBufferWidth; const H = gl.drawingBufferHeight;
  const proj = (y) => { const v = cam.position.clone(); v.set(hold.x, hold.y + y, hold.z).project(cam); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H]; };
  const [fx, fy] = proj(0); const [, hy] = proj(h);
  const half = (fy - hy) * 0.45;
  const box = [Math.max(0, Math.round(fx - half)), Math.max(0, Math.round(hy - half * 0.2)), Math.min(W, Math.round(fx + half)), Math.min(H, Math.round(fy + half * 0.1))];
  d.state.benchmark = true;
  const on = lumaBox(box);
  mob.affectedBy &= ~SANCTUARY;
  d.spellfx.update(0.016);
  const off = lumaBox(box);
  mob.affectedBy |= SANCTUARY;
  d.state.benchmark = false;
  let sum = 0; let peak = 0;
  for (let i = 0; i < on.length; i++) { const k = on[i] - off[i]; sum += k; peak = Math.max(peak, k); }
  const view = { dist, box, meanLumaGain: +(sum / on.length).toFixed(2), peakLumaGain: +peak.toFixed(1) };
  if (window.__shot) {
    await wait(400);
    view.shot = await window.__shot(`${opt.out}-${opt.time}-${dist}m.png`);
    // The same view without it, for a side-by-side.
    mob.affectedBy &= ~SANCTUARY;
    await wait(1800);
    view.without = await window.__shot(`${opt.out}-${opt.time}-${dist}m-without.png`);
    mob.affectedBy |= SANCTUARY;
  }
  out.views.push(view);
}
return out;
