/**
 * The implementor's god view: every zone of the mud from above, side by side,
 * with everyone in it live -- players named and coloured by what they are
 * doing, mobiles as dots, corpses -- and a free camera over all of it.
 *
 * The plan of each zone is the server's (dash.mjs `atlas`): the same layout
 * the game lays every zone out by, in grid cells. Rooms are low blocks
 * coloured by sector, a level higher for each storey; streets are thin
 * strips; an exit from one zone into another is a faint line between them.
 * Positions come in at 10 Hz in each zone's own frame and are drawn a tenth
 * of a second behind the server's clock, between two reports, as link.js
 * draws other players in the game.
 *
 * Nothing here touches the game's scene, camera or composer. The page's
 * frame loop hands its frame to `render` while the dashboard is up and
 * draws nothing of its own (main.js), so the view costs nothing when shut.
 *
 * Controls are written here (vendor/three ships only PointerLockControls):
 * drag to orbit, right-drag or shift-drag to pan, wheel to zoom towards the
 * cursor, WASD to fly, Q/E to turn, R/F to zoom; click to pick, double-click
 * to fly there.
 */

import * as THREE from 'three';
import { SECTOR, ROOM_INDOORS } from './are.js';

const CELL = 13;
const LEVEL_H = 7.6;
/** Metres between two zones on the atlas. */
const GAP = 150;
/** How far behind the server's clock positions are drawn, so there are two reports to blend. */
const BEHIND_MS = 100;
const ACT_AGGRESSIVE = 32;

const SECTOR_COLOUR = {
  [SECTOR.INSIDE]: 0x8c7f6a, [SECTOR.CITY]: 0xb3a68c, [SECTOR.FIELD]: 0x7d9a52, [SECTOR.FOREST]: 0x4f7240,
  [SECTOR.HILLS]: 0x8f8a52, [SECTOR.MOUNTAIN]: 0x8a7d70, [SECTOR.WATER_SWIM]: 0x4f86a8, [SECTOR.WATER_NOSWIM]: 0x2f5f8c,
  [SECTOR.UNUSED]: 0x666666, [SECTOR.AIR]: 0x9fb8cc, [SECTOR.DESERT]: 0xc9b07a,
};
const INDOOR_COLOUR = 0x6e6152;
const PLAYER = { normal: 0xe0bd77, fighting: 0xe2553f, linkdead: 0x8a8a8a, flagged: 0xd05bd0, self: 0x9fd0ff };
const MOB = { idle: 0xb9ad98, aggressive: 0xe08a3a, fighting: 0xff4a32, corpse: 0x5a2420 };

/** A name on a card, drawn once; `fixed` keeps it a constant size on screen. */
function label(text, { size = 28, colour = '#f0e3c8', fixed = true, scale = 1 } = {}) {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const font = `${size}px "Iowan Old Style", Palatino, Georgia, serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 16;
  const h = Math.ceil(size * 1.5);
  canvas.width = w; canvas.height = h;
  g.font = font;
  g.textBaseline = 'middle';
  // CLAUDE.md: a halo is ink too -- a thin stroke and one soft shadow, no plate.
  g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(text, 8, h / 2);
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 4;
  g.fillStyle = colour; g.fillText(text, 8, h / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Text on transparency: no mipmaps (CLAUDE.md), or distant names go muddy.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: !fixed, depthWrite: false, sizeAttenuation: !fixed, toneMapped: false });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0, 0.5);
  sprite.userData.aspect = w / h;
  if (fixed) sprite.scale.set((0.032 * w) / h * scale, 0.032 * scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function createGodView({ renderer, world, mobs, now }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0a09);
  scene.add(new THREE.HemisphereLight(0xfff2dc, 0x23211e, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-0.5, 1, 0.35);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(48, 1, 2, 60000);

  // -------------------------------------------------------------- the atlas --
  const zones = new Map();       // id -> { name, ox, oz, minX, maxX, minZ, maxZ }
  const rooms = new Map();       // vnum -> { zone, x, y, z } in god coordinates
  let roomMesh = null;
  let roomVnums = [];
  const built = new THREE.Group();
  scene.add(built);

  /** Where a point in zone `id`'s own frame stands on the atlas. */
  const god = (id, x, z) => { const zn = zones.get(id); return zn ? { x: x + zn.ox, z: z + zn.oz } : null; };

  function setAtlas(atlas) {
    if (roomMesh) return;
    // Shelf-pack the zones, biggest first, rows about as wide as the whole is deep.
    const boxes = atlas.zones.map((z) => {
      const xs = z.rooms.map((r) => r[1]); const zs = z.rooms.map((r) => r[2]);
      for (const st of z.streets) for (let i = 1; i < st.length; i += 2) { xs.push(st[i]); zs.push(st[i + 1]); }
      const minX = Math.min(...xs) * CELL - CELL; const maxX = Math.max(...xs) * CELL + CELL;
      const minZ = Math.min(...zs) * CELL - CELL; const maxZ = Math.max(...zs) * CELL + CELL;
      return { z, minX, maxX, minZ, maxZ, w: maxX - minX, d: maxZ - minZ };
    });
    const order = boxes.slice().sort((a, b) => (a.z.zone === 'home' ? -1 : b.z.zone === 'home' ? 1 : b.w * b.d - a.w * a.d));
    const total = boxes.reduce((s, b) => s + (b.w + GAP) * (b.d + GAP), 0);
    const rowWidth = Math.max(order[0].w, Math.sqrt(total) * 1.25);
    let cx = 0; let cz = 0; let rowDepth = 0;
    for (const b of order) {
      if (cx > 0 && cx + b.w > rowWidth) { cx = 0; cz += rowDepth + GAP; rowDepth = 0; }
      zones.set(b.z.zone, { name: b.z.name, ox: cx - b.minX, oz: cz - b.minZ, w: b.w, d: b.d, x0: cx, z0: cz });
      cx += b.w + GAP;
      rowDepth = Math.max(rowDepth, b.d);
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    const count = atlas.zones.reduce((n, z) => n + z.rooms.length, 0);
    roomMesh = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ toneMapped: false }), count);
    const m = new THREE.Matrix4();
    const colour = new THREE.Color();
    let i = 0;
    for (const z of atlas.zones) {
      for (const [vnum, rx, rz, level] of z.rooms) {
        const p = god(z.zone, rx * CELL, rz * CELL);
        const y = level * LEVEL_H;
        rooms.set(vnum, { zone: z.zone, x: p.x, y, z: p.z, level });
        roomVnums[i] = vnum;
        m.compose(new THREE.Vector3(p.x, y + 0.7, p.z), new THREE.Quaternion(), new THREE.Vector3(9, 1.4, 9));
        roomMesh.setMatrixAt(i, m);
        const room = world.rooms.get(vnum);
        const indoors = room && (room.sector === SECTOR.INSIDE || room.flags & ROOM_INDOORS);
        colour.setHex(indoors ? INDOOR_COLOUR : SECTOR_COLOUR[room ? room.sector : 0] ?? 0x777777);
        roomMesh.setColorAt(i, colour);
        i += 1;
      }
    }
    roomMesh.computeBoundingSphere();
    built.add(roomMesh);

    // Streets: one thin strip per step of every routed exit.
    const segments = [];
    for (const z of atlas.zones) {
      for (const [level, ...cells] of z.streets) {
        for (let k = 0; k + 3 < cells.length; k += 2) {
          const a = god(z.zone, cells[k] * CELL, cells[k + 1] * CELL);
          const b = god(z.zone, cells[k + 2] * CELL, cells[k + 3] * CELL);
          segments.push([a, b, level * LEVEL_H]);
        }
      }
    }
    const streetMesh = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0x7a6e5c, toneMapped: false }), segments.length);
    const q = new THREE.Quaternion();
    segments.forEach(([a, b, y], k) => {
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-(b.z - a.z), b.x - a.x));
      m.compose(new THREE.Vector3((a.x + b.x) / 2, y + 0.2, (a.z + b.z) / 2), q, new THREE.Vector3(len + 2.6, 0.4, 2.6));
      streetMesh.setMatrixAt(k, m);
    });
    streetMesh.computeBoundingSphere();
    built.add(streetMesh);

    // Each zone on a slab of its own, named.
    for (const [id, zn] of zones) {
      const slab = new THREE.Mesh(new THREE.PlaneGeometry(zn.w + 40, zn.d + 40), new THREE.MeshBasicMaterial({ color: 0x17140f, toneMapped: false }));
      slab.rotation.x = -Math.PI / 2;
      slab.position.set(zn.x0 + zn.w / 2, -0.4, zn.z0 + zn.d / 2);
      built.add(slab);
      const tag = label(zn.name, { size: 56, colour: '#e0bd77', fixed: false });
      const width = Math.min(420, Math.max(110, zn.w * 0.8));
      tag.scale.set(width, width / tag.userData.aspect, 1);
      tag.position.set(zn.x0, 26, zn.z0 - 14);
      tag.userData.zone = id;
      built.add(tag);
    }

    // Exits from one zone into another: faint lines, once per pair.
    const pairs = new Set();
    const pts = [];
    for (const [vnum, r] of rooms) {
      const room = world.rooms.get(vnum);
      if (!room) continue;
      for (const e of room.exits) {
        const to = e && !e.offMap && rooms.get(e.to);
        if (!to || to.zone === r.zone) continue;
        const key = vnum < e.to ? `${vnum}-${e.to}` : `${e.to}-${vnum}`;
        if (pairs.has(key)) continue;
        pairs.add(key);
        pts.push(r.x, r.y + 3, r.z, to.x, to.y + 3, to.z);
      }
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    built.add(new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: 0xe0bd77, transparent: true, opacity: 0.28, toneMapped: false })));

    buildMobs();
    const home = zones.get('home') || zones.values().next().value;
    look.target.set(home.x0 + home.w / 2, 0, home.z0 + home.d / 2);
    look.dist = Math.max(home.w, home.d) * 1.05;
  }

  // -------------------------------------------------------------- mobiles --
  let mobMesh = null;
  const mobState = [];   // per index: [room, body, fight]
  function buildMobs() {
    mobMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1.5, 0), new THREE.MeshLambertMaterial({ toneMapped: false }), mobs.length);
    mobMesh.frustumCulled = false;
    built.add(mobMesh);
    for (let i = 0; i < mobs.length; i++) placeMob(i);
    mobMesh.instanceMatrix.needsUpdate = true;
    if (mobMesh.instanceColor) mobMesh.instanceColor.needsUpdate = true;
  }
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);
  const mm = new THREE.Matrix4();
  const mc = new THREE.Color();
  /** A mobile at its room, a little off the middle by its own index, so a crowd is a crowd. */
  function placeMob(i) {
    const st = mobState[i];
    const r = st && rooms.get(st[0]);
    if (!mobMesh) return;
    if (!st || !r || st[1] === 2) { mobMesh.setMatrixAt(i, hide); return; }
    const a = (i * 2.399963) % (Math.PI * 2);
    const d = 1.5 + ((i * 7919) % 100) / 100 * 2.6;
    const corpse = st[1] === 1;
    mm.compose(new THREE.Vector3(r.x + Math.cos(a) * d, r.y + (corpse ? 1.6 : 3.2), r.z + Math.sin(a) * d), new THREE.Quaternion(),
      corpse ? new THREE.Vector3(1.1, 0.35, 1.1) : new THREE.Vector3(1, 1, 1));
    mobMesh.setMatrixAt(i, mm);
    const aggressive = mobs[i] && mobs[i].proto && (mobs[i].proto.act & ACT_AGGRESSIVE);
    mc.setHex(corpse ? MOB.corpse : st[2] ? MOB.fighting : aggressive ? MOB.aggressive : MOB.idle);
    mobMesh.setColorAt(i, mc);
  }
  function setMobs(list) {
    list.forEach((v, i) => { mobState[i] = v; placeMob(i); });
    if (mobMesh) { mobMesh.instanceMatrix.needsUpdate = true; if (mobMesh.instanceColor) mobMesh.instanceColor.needsUpdate = true; }
  }
  function updateMobs(diffs) {
    for (const [i, ...v] of diffs) { mobState[i] = v; placeMob(i); }
    if (mobMesh && diffs.length) { mobMesh.instanceMatrix.needsUpdate = true; if (mobMesh.instanceColor) mobMesh.instanceColor.needsUpdate = true; }
  }

  // -------------------------------------------------------------- players --
  const players = new Map();   // id -> { group, body, ring, tag, samples, info, key }
  // A pin: a stem standing clear of the crowd, a head that carries the colour.
  const stemGeo = new THREE.CylinderGeometry(0.35, 0.35, 10, 8);
  stemGeo.translate(0, 5, 0);
  const bodyGeo = new THREE.SphereGeometry(2.3, 16, 12);
  bodyGeo.translate(0, 11.5, 0);
  const ringGeo = new THREE.RingGeometry(3.2, 4.2, 28);
  ringGeo.rotateX(-Math.PI / 2);
  let selfName = null;

  function playerOf(id) {
    let p = players.get(id);
    if (p) return p;
    const group = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshLambertMaterial({ color: PLAYER.normal, emissive: 0x332611, toneMapped: false }));
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: PLAYER.normal, transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false }));
    ring.position.y = 0.3;
    const stem = new THREE.Mesh(stemGeo, new THREE.MeshLambertMaterial({ color: 0xd9cdb4, toneMapped: false }));
    group.add(stem, body, ring);
    body.userData.player = id; ring.userData.player = id; stem.userData.player = id;
    p = { stem };
    scene.add(group);
    p = { id, group, body, ring, stem: p.stem, tag: null, samples: [], info: null, key: '' };
    players.set(id, p);
    return p;
  }

  /** Reports [id, zone, x, y, z, yaw, room] at server time `at`. */
  function setPositions(rows, at) {
    for (const [id, zone, x, y, z, yaw, vnum] of rows) {
      const g = god(zone, x, z);
      if (!g) continue;
      const p = playerOf(id);
      const last = p.samples[p.samples.length - 1];
      // Crossed zones or jumped: no blending across the atlas.
      if (last && (last.zone !== zone || Math.hypot(last.x - g.x, last.z - g.z) > 60)) p.samples = [];
      p.samples.push({ at, x: g.x, y, z: g.z, yaw, zone, vnum });
      if (p.samples.length > 6) p.samples.shift();
    }
  }

  /** The roster (once a second): names, and what colour each one is. */
  function setWho(list, me) {
    selfName = me;
    const ids = new Set();
    for (const info of list) {
      ids.add(info.id);
      const p = playerOf(info.id);
      p.info = info;
      const flagged = info.flags.includes('KILLER') || info.flags.includes('THIEF');
      const key = `${info.name}|${flagged}|${info.fighting}|${info.linkdead !== null}`;
      if (key === p.key) continue;
      p.key = key;
      const colour = info.linkdead !== null ? PLAYER.linkdead : info.fighting ? PLAYER.fighting : info.name === me ? PLAYER.self : PLAYER.normal;
      p.body.material.color.setHex(colour);
      p.ring.material.color.setHex(flagged ? PLAYER.flagged : colour);
      if (p.tag) { p.group.remove(p.tag); p.tag.material.map.dispose(); p.tag.material.dispose(); }
      const words = `${info.name}${flagged ? ` (${info.flags.filter((f) => f === 'KILLER' || f === 'THIEF').join(' ')})` : ''}${info.linkdead !== null ? ' [link-dead]' : ''}`;
      p.tag = label(words, { colour: flagged ? '#f0a8f0' : info.linkdead !== null ? '#b8b8b8' : '#f0e3c8' });
      p.tag.position.set(3, 9, 0);
      p.group.add(p.tag);
    }
    for (const [id, p] of players) {
      if (ids.has(id)) continue;
      scene.remove(p.group);
      players.delete(id);
    }
  }

  /** Where player `id` is drawn now: between the two reports either side of now - BEHIND_MS. */
  function drawnAt(p, t) {
    const s = p.samples;
    if (!s.length) return null;
    let a = s[0]; let b = s[0];
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i].at <= t && s[i + 1].at >= t) { a = s[i]; b = s[i + 1]; break; }
      if (s[i + 1].at < t) { a = s[i + 1]; b = s[i + 1]; }
    }
    const span = b.at - a.at;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.at) / span)) : 1;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, yaw: b.yaw, vnum: b.vnum, zone: b.zone };
  }

  // --------------------------------------------------------------- camera --
  const look = { target: new THREE.Vector3(), dist: 900, yaw: 0, pitch: 0.95 };
  let fly = null;
  let follow = null;
  const keys = new Set();

  function placeCamera() {
    const cp = Math.cos(look.pitch);
    camera.position.set(look.target.x + Math.sin(look.yaw) * cp * look.dist, look.target.y + Math.sin(look.pitch) * look.dist,
      look.target.z + Math.cos(look.yaw) * cp * look.dist);
    camera.lookAt(look.target);
  }
  /** Ease the camera to `point`, `dist` away. */
  function flyTo(point, dist = look.dist) {
    fly = { from: look.target.clone(), to: new THREE.Vector3(point.x, point.y || 0, point.z), d0: look.dist, d1: dist, t: 0 };
  }

  function update(dt) {
    // WASD flies over the ground, in the camera's own heading; speed grows with height.
    const speed = look.dist * 0.9 * dt;
    const fx = -Math.sin(look.yaw); const fz = -Math.cos(look.yaw);
    let mx = 0; let mz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) { mx += fx; mz += fz; }
    if (keys.has('KeyS') || keys.has('ArrowDown')) { mx -= fx; mz -= fz; }
    if (keys.has('KeyA') || keys.has('ArrowLeft')) { mx += fz; mz -= fx; }
    if (keys.has('KeyD') || keys.has('ArrowRight')) { mx -= fz; mz += fx; }
    if (mx || mz) { look.target.x += mx * speed; look.target.z += mz * speed; follow = null; fly = null; }
    if (keys.has('KeyQ')) look.yaw += 1.4 * dt;
    if (keys.has('KeyE')) look.yaw -= 1.4 * dt;
    if (keys.has('KeyR')) look.dist = Math.max(12, look.dist * Math.exp(-1.6 * dt));
    if (keys.has('KeyF')) look.dist = Math.min(30000, look.dist * Math.exp(1.6 * dt));
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / 0.9);
      const e = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - (-2 * fly.t + 2) ** 2 / 2;
      look.target.lerpVectors(fly.from, fly.to, e);
      look.dist = fly.d0 + (fly.d1 - fly.d0) * e;
      if (fly.t >= 1) fly = null;
    }
  }

  function render(dt) {
    update(dt);
    const t = now() - BEHIND_MS;
    for (const p of players.values()) {
      const at = drawnAt(p, t);
      if (!at) { p.group.visible = false; continue; }
      p.group.visible = true;
      p.group.position.set(at.x, at.y, at.z);
      p.at = at;
      if (follow === p.id && !fly) look.target.lerp(new THREE.Vector3(at.x, at.y, at.z), Math.min(1, dt * 6));
      const pulse = follow === p.id ? 1 + 0.25 * Math.sin(performance.now() / 180) : 1;
      p.ring.scale.setScalar(pulse);
    }
    // Far out, a body is a speck: grow the markers with the distance so they stay findable.
    const grow = Math.max(1, look.dist / 260);
    // Two in one room would print one name over the other: stack them.
    const stacked = new Map();
    for (const p of players.values()) {
      if (!p.group.visible) continue;
      const k = p.at.vnum;
      const n = stacked.get(k) || 0;
      stacked.set(k, n + 1);
      p.body.scale.setScalar(grow); p.stem.scale.setScalar(grow); p.ring.scale.multiplyScalar(grow);
      if (p.tag) p.tag.position.y = (14 + n * 5) * grow;
    }
    placeCamera();
    const size = renderer.getSize(new THREE.Vector2());
    if (camera.aspect !== size.x / size.y) { camera.aspect = size.x / size.y; camera.updateProjectionMatrix(); }
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }

  // ---------------------------------------------------------------- input --
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function rayAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    placeCamera();
    raycaster.setFromCamera(ndc, camera);
    return raycaster;
  }
  /** What is under the cursor: a player first, then a mobile, then a room. */
  function pick(clientX, clientY) {
    const ray = rayAt(clientX, clientY);
    const bodies = [...players.values()].filter((p) => p.group.visible).flatMap((p) => [p.body, p.stem, p.ring]);
    const hitP = ray.intersectObjects(bodies, false)[0];
    if (hitP) return { kind: 'player', id: hitP.object.userData.player };
    if (mobMesh) {
      const hitM = ray.intersectObject(mobMesh, false)[0];
      if (hitM && hitM.instanceId !== undefined) return { kind: 'mob', index: hitM.instanceId, room: mobState[hitM.instanceId]?.[0] };
    }
    const hitR = roomMesh && ray.intersectObject(roomMesh, false)[0];
    if (hitR && hitR.instanceId !== undefined) return { kind: 'room', vnum: roomVnums[hitR.instanceId] };
    return null;
  }
  /** The ground under the cursor, on the target's level. */
  function groundAt(clientX, clientY) {
    const ray = rayAt(clientX, clientY);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -look.target.y);
    return ray.ray.intersectPlane(plane, new THREE.Vector3());
  }

  function bind(stage, { onPick, onFly }) {
    let drag = null;
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, moved: 0, pan: e.button === 2 || e.shiftKey, button: e.button };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved < 4) return;
      if (drag.pan) {
        const k = (look.dist * 1.6) / renderer.domElement.clientHeight;
        const cx = Math.cos(look.yaw); const sx = Math.sin(look.yaw);
        look.target.x -= (dx * cx + dy * sx) * k;
        look.target.z -= (-dx * sx + dy * cx) * k;
        follow = null; fly = null;
      } else {
        look.yaw -= dx * 0.005;
        look.pitch = Math.min(1.52, Math.max(0.12, look.pitch + dy * 0.005));
      }
    });
    stage.addEventListener('pointerup', (e) => {
      const d = drag;
      drag = null;
      if (d && d.moved < 4 && d.button === 0) onPick(pick(e.clientX, e.clientY), e);
    });
    stage.addEventListener('dblclick', (e) => {
      const hit = pick(e.clientX, e.clientY);
      const p = hit && hit.kind === 'room' ? rooms.get(hit.vnum) : groundAt(e.clientX, e.clientY);
      if (p) { follow = null; flyTo(p, Math.min(look.dist, 160)); }
      if (hit && onFly) onFly(hit);
    });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = groundAt(e.clientX, e.clientY);
      const d0 = look.dist;
      look.dist = Math.min(30000, Math.max(12, look.dist * Math.exp(e.deltaY * 0.0012)));
      fly = null;
      // Towards the cursor: the ground under it stays under it.
      if (before && follow === null) look.target.addScaledVector(before.sub(look.target), 1 - look.dist / d0);
    }, { passive: false });
  }

  return {
    scene, camera, setAtlas, setMobs, updateMobs, setPositions, setWho, render, bind, flyTo, pick,
    get ready() { return !!roomMesh; },
    keys,
    roomAt: (vnum) => rooms.get(vnum) || null,
    playerAt: (id) => players.get(id)?.at || null,
    zoneOf: (id) => zones.get(id) || null,
    zones,
    get follow() { return follow; },
    set follow(id) { follow = id; if (id !== null) { const at = players.get(id)?.at; if (at) flyTo(at, Math.min(look.dist, 140)); } },
    look,
    /** For a harness: how many mobiles are drawn, standing and as corpses. */
    census() {
      let standing = 0; let corpses = 0;
      for (const st of mobState) if (st && rooms.has(st[0])) { if (st[1] === 0) standing += 1; else if (st[1] === 1) corpses += 1; }
      return { rooms: rooms.size, zones: zones.size, players: players.size, standing, corpses };
    },
    selfName: () => selfName,
  };
}
