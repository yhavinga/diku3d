// What is actually standing in every room, for tools/noun-check.mjs.
//
// Evaluate in the page once the world is built (the console, or any headless
// driver's evaluate) and save what it returns as JSON:
//
//   copy(JSON.stringify(await (<this file's text>)))     // devtools
//   node tools/noun-check.mjs --placed placed.json
//
// Every instanced model (the invisible `placements` records nav.js reads),
// every decor entry build.js left for actors.js (torches, tables, fittings,
// furniture pieces, banners, props), and the room each one stands in by
// nav.js's own lookup. Measured off the built world, not re-derived from the
// prose: a reader that says "altar" and a builder that never put one down is
// exactly the fault this is for.
(async () => {
  const { built, actors, assets } = window.diku;
  const nav = actors.nav;
  const byGeometry = new Map();
  for (const [name, asset] of assets.assets) {
    if (asset && asset.primitives && asset.primitives[0]) byGeometry.set(asset.primitives[0].geometry, name);
  }
  const rooms = {};
  // The room a thing stands in: nav.js's cell lookup, and failing that (a
  // ladder on the wall line, a sign on the far face of a wall) the nearest
  // built room on the same level within its own cell.
  const centres = [...built.rooms].filter(([, i]) => !i.unbuilt).map(([v, i]) => [v, i.center]);
  const at = (x, y, z) => {
    let v = nav.roomAt(x, y + 0.5, z);
    if (v === null || v === undefined) {
      let best = 7.2;
      for (const [vn, c] of centres) {
        if (Math.abs(c.y - y) > 3.5) continue;
        const d = Math.max(Math.abs(c.x - x), Math.abs(c.z - z));
        if (d < best) { best = d; v = vn; }
      }
    }
    if (v === null || v === undefined) return null;
    if (!rooms[v]) rooms[v] = { models: {}, decor: {} };
    return rooms[v];
  };
  const m = new window.diku.scene.position.constructor();
  window.diku.scene.traverse((o) => {
    if (o.name !== 'placements') return;
    for (const record of o.children) {
      const name = byGeometry.get(record.geometry);
      if (!name) continue;
      for (let i = 0; i < record.count; i++) {
        const e = record.instanceMatrix.array;
        m.set(e[i * 16 + 12], e[i * 16 + 13], e[i * 16 + 14]);
        const r = at(m.x, m.y, m.z);
        if (r) r.models[name] = (r.models[name] || 0) + 1;
      }
    }
  });
  for (const d of built.decor) {
    if (d.x === undefined) continue;
    const r = at(d.x, d.y ?? 0, d.z);
    if (!r) continue;
    const key = d.kind === 'fitting' ? `fitting:${d.fitting}` : d.kind === 'piece' ? `piece:${d.piece}`
      : d.kind === 'prop' ? `prop:${d.name}` : d.kind === 'torch' && d.bare ? (d.blaze ? 'fire' : 'flame') : d.kind;
    r.decor[key] = (r.decor[key] || 0) + 1;
  }
  const shells = {};
  for (const [vnum, info] of built.rooms) {
    if (info.unbuilt) continue;
    const mats = info.materials || {};
    shells[vnum] = {
      shell: mats.shell ? mats.shell.kind : null,
      floor: mats.floor || null, wall: mats.wallIn || null, outdoor: !!info.outdoor,
      level: info.cell.level,
    };
  }
  return { rooms, shells };
})()
