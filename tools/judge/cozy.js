/**
 * How "spacy" a street is, in numbers: a ray sweep from eye height.
 *
 *   const C = (await import('/tools/judge/cozy.js')).install();
 *   C.sweep(x, z)            // one standing point, world metres
 *   C.at(3014)               // a room's centre
 *   C.cell(-1, 4)            // a routed cell's centre (level 0)
 *   C.town('Midgaard')       // every open-air city cell of an area, summarised
 *
 * Load the page with `?cull=off`: culling compacts instance buffers and sets
 * draw ranges, and a raycast through a culled mesh sees only what the last
 * frame drew -- which is not the street, it is the camera's view of it.
 *
 * Per point: 36 level rays at 1.6 m over the ground under the point, out to
 * FAR. `nearest` is the closest facade, `lane` the narrowest opposite pair
 * (d(a) + d(a + 180 deg)), `median` the median sightline (a miss counts as
 * FAR), `open` the share of rays that reach FAR. `sky` is the share of the
 * upper hemisphere -- cosine-weighted, 24 azimuths x 9 elevations -- that
 * reaches SKY_FAR without hitting anything: the open sky fraction a person
 * standing there sees over them.
 *
 * What counts as a surface: everything under the built world and the vistas,
 * except grass blades, mist and the horizon ring (which is landscape seen past
 * the town, the same from every point, and would only add a constant).
 * Figures and items are not in the world group, so they never block.
 */
import * as THREE from 'three';

const RAYS = 36;
const EYE = 1.6;
const FAR = 120;
const SKY_FAR = 250;
const SKIP = /horizon|grass|mist|sky|veil|threshold/i;

export function install() {
  const d = window.diku;
  const C = {};
  const rc = new THREE.Raycaster();

  C.targets = () => {
    const out = [];
    const add = (root) => root && root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh || o.isBatchedMesh)) return;
      if (SKIP.test(o.name || '') || SKIP.test(o.material?.name || '')) return;
      out.push(o);
    });
    add(d.built.group);
    add(d.scene.getObjectByName('vistas'));
    return out;
  };

  let cached = null;
  const targets = () => (cached ||= C.targets());
  C.reset = () => { cached = null; };

  const hit = (origin, dir, far) => {
    rc.set(origin, dir);
    rc.far = far;
    const h = rc.intersectObjects(targets(), false);
    return h.length ? h[0].distance : Infinity;
  };

  /** The ground under (x, z): the highest surface below `top`. */
  C.ground = (x, z, top = 40) => {
    const g = hit(new THREE.Vector3(x, top, z), new THREE.Vector3(0, -1, 0), top + 20);
    return Number.isFinite(g) ? top - g : 0;
  };

  C.sweep = (x, z, feet = null) => {
    const y = (feet ?? C.ground(x, z)) + EYE;
    const o = new THREE.Vector3(x, y, z);
    const dist = [];
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      const h = hit(o, new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)), FAR);
      dist.push(Number.isFinite(h) ? h : FAR);
    }
    let lane = Infinity;
    for (let i = 0; i < RAYS / 2; i++) lane = Math.min(lane, dist[i] + dist[i + RAYS / 2]);
    const sorted = [...dist].sort((a, b) => a - b);
    let skyW = 0; let allW = 0;
    for (let e = 0; e < 9; e++) {
      const el = ((e + 0.5) / 9) * (Math.PI / 2);
      const w = Math.cos(el) * Math.sin(el); // cosine-weighted solid angle
      for (let k = 0; k < 24; k++) {
        const az = ((k + 0.5) / 24) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
        allW += w;
        if (!Number.isFinite(hit(o, dir, SKY_FAR))) skyW += w;
      }
    }
    const r = (v) => +v.toFixed(1);
    return {
      x: r(x), z: r(z), y: r(y - EYE),
      nearest: r(sorted[0]), lane: r(lane), median: r((sorted[17] + sorted[18]) / 2),
      open: +(dist.filter((v) => v >= FAR).length / RAYS).toFixed(2),
      sky: +(skyW / allW).toFixed(3),
    };
  };

  const CELLM = 13;
  C.at = (vnum) => {
    const c = d.layout.cells.get(vnum);
    return { vnum, name: c.room.name, ...C.sweep(c.x * CELLM, c.z * CELLM) };
  };
  C.cell = (x, z) => ({ cell: `${x},${z}`, ...C.sweep(x * CELLM, z * CELLM) });

  /** Every open-air city room and routed open-air city cell of one area. */
  C.town = (area, { level = 0 } = {}) => {
    const L = d.layout;
    const open = (room) => room.sector === 1 && !(room.flags & 8);
    const pts = [];
    for (const c of L.order) {
      if (c.level === level && c.room.area === area && open(c.room)) pts.push({ kind: 'room', x: c.x, z: c.z });
    }
    const seen = new Set();
    for (const link of L.links) {
      if (link.kind !== 'alley' || link.from.level !== level) continue;
      if (link.from.room.area !== area && link.to.room.area !== area) continue;
      if (!open(link.from.room) && !open(link.to.room)) continue;
      for (const p of link.path) {
        const k = `${p.x},${p.z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        pts.push({ kind: 'path', x: p.x, z: p.z });
      }
    }
    const rows = pts.map((p) => ({ kind: p.kind, ...C.sweep(p.x * CELLM, p.z * CELLM) }));
    const med = (a) => { const s = [...a].sort((u, v) => u - v); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const sum = (kind) => {
      const r = rows.filter((v) => !kind || v.kind === kind);
      return {
        n: r.length,
        nearest: med(r.map((v) => v.nearest)), lane: med(r.map((v) => v.lane)),
        median: med(r.map((v) => v.median)), sky: med(r.map((v) => v.sky)),
        open: +(r.reduce((s, v) => s + v.open, 0) / Math.max(1, r.length)).toFixed(3),
      };
    };
    return { all: sum(null), rooms: sum('room'), paths: sum('path'), rows };
  };
  /**
   * Can a mobile still walk every routed passage of the drawn zone? nav.js's
   * own path search, from one room's centre to the other's, inside the cells
   * the passage was given -- the grid it searches is the colliders plus every
   * placed prop, so a house or a market stall in the way shows up here.
   */
  C.walkable = () => {
    const nav = d.actors.nav;
    const fails = [];
    let n = 0;
    for (const link of d.layout.links) {
      if (link.kind !== 'alley' || !link.to) continue;
      const a = d.built.rooms.get(link.from.vnum); const b = d.built.rooms.get(link.to.vnum);
      if (!a || !b || a.unbuilt || b.unbuilt) continue;
      n++;
      const cells = [link.from, ...link.path, link.to];
      const path = nav.findPath(link.from.level, a.center, b.center, cells);
      if (!path) fails.push(`${link.from.vnum}->${link.to.vnum}`);
    }
    return { passages: n, fails };
  };
  /**
   * Culling against no culling, in this view, in one halted page: two
   * composited frames with culling on, two with it off. A pixel counts only
   * where each pair agrees with itself (stable), and `diff` is how many of
   * those differ between on and off -- anything culled that should have been
   * drawn. Leaves the render loop halted for the caller to release.
   */
  C.cullDiff = async () => {
    const v = d.visibility;
    const gl = d.renderer.getContext();
    d.state.benchmark = true;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const grab = () => {
      d.composer.render();
      const w = gl.drawingBufferWidth; const h = gl.drawingBufferHeight;
      const b = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      return b;
    };
    const was = v.state.enabled;
    v.state.enabled = true; grab(); const a1 = grab(); const a2 = grab();
    v.state.enabled = false; grab(); const b1 = grab(); const b2 = grab();
    v.state.enabled = was;
    let stable = 0; let diff = 0;
    for (let i = 0; i < a1.length; i += 4) {
      let same = true;
      for (let k = 0; k < 3; k++) if (a1[i + k] !== a2[i + k] || b1[i + k] !== b2[i + k]) same = false;
      if (!same) continue;
      stable++;
      if (a1[i] !== b1[i] || a1[i + 1] !== b1[i + 1] || a1[i + 2] !== b1[i + 2]) diff++;
    }
    return { stable, diff };
  };
  return C;
}
