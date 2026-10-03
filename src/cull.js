/**
 * What the camera can actually see, by measuring the built world rather than
 * trusting what the builders meant to build.
 *
 * Frustum culling does not know about walls. From inside the Fungus temple, a
 * closed cave with two doorways, 7.1 M triangles were drawn every frame --
 * 2.7 M of them trees out in the forest -- because everything in front of the
 * eye is "in view" until something says otherwise. Nothing did.
 *
 * The world is a grid of 13 m cells, and every place the eye can be is inside
 * one. For the cell the eye is in, this measures where sight can get out of it:
 * from a handful of points inside, it renders the world's opaque geometry as
 * distances into a cube, and every ray that leaves the cell's box without
 * hitting anything marks an aperture -- a doorway, a stair well, a window of
 * sky. From anywhere inside, the only things that can be seen outside the cell
 * are the ones seen through those apertures, so each frame each aperture is
 * projected to a rectangle on screen and anything outside the cell has to fall
 * in one of those rectangles to be drawn.
 *
 * Measuring rather than asking build.js is the point. Shells change (caves,
 * tombs, log houses, burrows), and a room declared "sealed" that has a gap in
 * it would lose whatever the gap shows. A gap here is only ever a bigger
 * aperture: the answer is conservative by construction, and the worst a wrong
 * guess about any shell can do is cull less.
 *
 * Big instanced meshes -- a region's trees, its rocks, its grass -- carry one
 * bounding sphere round the whole region, so three never culls them at all;
 * they are culled here instance by instance, against the frustum everywhere
 * and against the apertures when there are any, by compacting the instance
 * buffer. The order of what survives is kept, so what is drawn is drawn the
 * same.
 *
 * The sun's shadow map is only redrawn every six metres of walking and then
 * reused while you turn, so it must never lose a caster to this: on a frame
 * that redraws it the instance sets are widened to everything the shadow
 * camera can see, and the whole objects hidden here are put back for the
 * shadow pass and taken away again before the main pass draws.
 */

import * as THREE from 'three';
import { CELL, LEVEL_H } from './build.js';
import { cullHook } from './assets.js';
import { readPixelsAsync } from './occlusion.js';

const HALF = CELL / 2;
/** A floor slab is 0.45 m; the cell's box starts just under it. */
const BELOW = 0.6;
const FACE_AXIS = [0, 0, 1, 1, 2, 2]; // +x -x +y -y +z -z
const FACE_SIGN = [1, -1, 1, -1, 1, -1];
const FACE_DIR = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const FACE_UP = [
  new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -1, 0),
];

/** Texels per cube face. A 3.2 m doorway five metres off is ~25 of them. */
const RES = 64;
/** Far enough to see out of a cell and its neighbour from any corner; nothing hit by then is a leak. */
const REACH = 40;
/**
 * A hit this far outside the cell's box still counts as the cell's own wall:
 * the kit walls stand 5.35 m out with buttresses proud of them, and the rock
 * of a cave is lumpy.
 */
const SLACK = 0.35;
/** How deep an aperture's box reaches in from the cell's face, at least. */
const DEPTH_OF_APERTURE = 2.5;
/** Grown on every side of a measured aperture. */
const MARGIN = 0.3;
/** How far into the cell's measured inside the samples are spread. */
const SPREAD = 0.8;
/** How many cells deep sight is followed through sealed neighbours, and how many rectangles at most. */
const DEPTH = 4;
const MAX_WINDOWS = 32;
/**
 * Past this, a thing is not drawn into the AO prepass. The occlusion is six
 * metres of world wide and fogged over out there; the prepass was every draw
 * of the frame a second time.
 */
const AO_REACH = 120;
/** Screen radius, in drawn pixels, under which a lit object is not worth a draw. */
const DETAIL_PX = 0.75;
const _size = new THREE.Vector2();
/** Escaping rays kept per face to check the next cell against; past it, the face is not followed. */
const ESCAPES = 6000;
/** Past this share of its faces open, a cell is open ground and not worth the arithmetic. */
const OPEN_SHARE = 0.55;

/** Materials that never hide what is behind them, whatever their flags say. */
const SEE_THROUGH = /grass|leaves|leaf|needle|reed|fern|bush|foliage|ivy|hay|straw|nettle|flower|weed|cloud|mist|water|glass|pane|flame|smoke/i;

const DIST_VERT = `
  #include <common>
  #include <batching_pars_vertex>
  varying vec3 vWorld;
  void main() {
    #include <batching_vertex>
    #include <begin_vertex>
    vec4 world = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      world = batchingMatrix * world;
    #endif
    #ifdef USE_INSTANCING
      world = instanceMatrix * world;
    #endif
    world = modelMatrix * world;
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;
const DIST_FRAG = `
  uniform vec3 eye;
  varying vec3 vWorld;
  void main() { gl_FragColor = vec4(length(vWorld - eye), 0.0, 0.0, 1.0); }`;

const WAIT = 'wait';
const cellKey = (level, x, z) => `${level}:${x},${z}`;

export function createVisibility({ renderer, scene, camera, world, sun, zones = null, sky = [], impostors = null, occlusion = null }) {
  const cells = new Map();
  const queue = [];
  const target = new THREE.WebGLRenderTarget(RES * 6, RES, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
  });
  const readback = new Float32Array(RES * 6 * RES * 4);
  const distance = new THREE.ShaderMaterial({
    vertexShader: DIST_VERT, fragmentShader: DIST_FRAG,
    uniforms: { eye: { value: new THREE.Vector3() } },
    side: THREE.DoubleSide,
  });
  const probe = new THREE.PerspectiveCamera(90, 1, 0.05, REACH);
  const rays = [];
  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      rays.push(new THREE.Vector3(((i + 0.5) / RES) * 2 - 1, ((j + 0.5) / RES) * 2 - 1, -1).normalize());
    }
  }

  const state = {
    enabled: true, active: false, cell: null, windows: [], stamp: 0, shadowFrame: false,
    stats: { measured: 0, culled: 0, instances: 0, instancesKept: 0, reused: 0 },
    // Drawn, but nothing of it within AO_REACH: left out of the AO prepass.
    aoFar: [],
    aoReach: AO_REACH,
  };

  // ------------------------------------------------------------ measuring --

  function occluder(o) {
    if (!o.isMesh || o.isSprite || o.frustumCulled === false) return false;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (!m || m.transparent || m.alphaTest > 0 || m.depthWrite === false || m.alphaHash) return false;
      if (SEE_THROUGH.test(m.name || '') || SEE_THROUGH.test(o.name || '')) return false;
    }
    return true;
  }

  /**
   * What a cell is measured against: the world's opaque geometry in the cell
   * and its neighbours -- a hit further off is a leak either way -- as a small
   * scene of its own. Drawing the real world from a probe walked every object
   * in it six times a cube and drew every rock in the region and the sewer
   * three levels down; this is a few dozen stand-ins sharing the real
   * buffers. A region's batch becomes one plain mesh per piece, drawing its
   * own range of the batch's index.
   */
  const pieceGeometry = new WeakMap(); // batch -> geometryId -> geometry; kept, never disposed:
  // disposing a geometry frees its attributes, and these share the batch's.
  // Listed as well, for `dispose` -- when the zone goes, the batch goes too.
  const pieces = [];
  function proxiesFor(cell) {
    const region = cell.box.clone();
    region.min.x -= CELL; region.max.x += CELL; region.min.z -= CELL; region.max.z += CELL;
    region.min.y -= LEVEL_H; region.max.y += LEVEL_H;
    region.expandByScalar(SLACK);
    const within = (x, y, z, r) => x + r > region.min.x && x - r < region.max.x && y + r > region.min.y
      && y - r < region.max.y && z + r > region.min.z && z - r < region.max.z;
    const group = new THREE.Scene();
    group.matrixWorldAutoUpdate = false;
    const owned = [];
    const m = new THREE.Matrix4();
    const put = (mesh, matrix) => {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.matrixWorld.copy(matrix);
      group.add(mesh);
    };
    const walk = (o) => {
      // The zones hide half the world from wherever the eye happens to be; a
      // measurement must not depend on that, or a cell measured from
      // underground would be cached with its whole surface missing.
      const zone = o.parent === world || o.parent?.name === 'underground' || o.name === 'district';
      if (o.name === 'placements' || (!o.visible && !zone)) return;
      if (o.isMesh && occluder(o)) {
        if (o.isInstancedMesh) {
          const entry = instancedBy.get(o);
          const keep = [];
          if (entry) {
            for (const bucket of entry.buckets) {
              const c = bucket.sphere.center;
              if (!within(c.x, c.y, c.z, bucket.sphere.radius)) continue;
              for (const i of bucket.ids) {
                const q = i * 4;
                if (within(entry.spheres[q], entry.spheres[q + 1], entry.spheres[q + 2], entry.spheres[q + 3])) keep.push(i);
              }
            }
            keep.sort((x, y) => x - y);
          } else {
            if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
            for (let i = 0; i < o.count; i++) {
              o.getMatrixAt(i, m);
              _sphere.copy(o.geometry.boundingSphere).applyMatrix4(m.premultiply(o.matrixWorld));
              if (within(_sphere.center.x, _sphere.center.y, _sphere.center.z, _sphere.radius)) keep.push(i);
            }
          }
          if (keep.length) {
            const proxy = new THREE.InstancedMesh(o.geometry, distance, keep.length);
            const source = entry ? entry.source : o.instanceMatrix.array;
            for (let k = 0; k < keep.length; k++) proxy.instanceMatrix.array.set(source.subarray(keep[k] * 16, keep[k] * 16 + 16), k * 16);
            proxy.computeBoundingSphere();
            put(proxy, o.matrixWorld);
            owned.push(proxy);
          }
        } else if (o.isBatchedMesh) {
          const spheres = o.pieceSpheres();
          let byId = pieceGeometry.get(o);
          if (!byId) { byId = []; pieceGeometry.set(o, byId); }
          for (let i = 0; i < o._instanceInfo.length; i++) {
            const info = o._instanceInfo[i];
            const q = i * 4;
            if (!info.active || !info.visible || !within(spheres[q], spheres[q + 1], spheres[q + 2], spheres[q + 3])) continue;
            let geometry = byId[info.geometryIndex];
            if (!geometry) {
              const range = o._geometryInfo[info.geometryIndex];
              geometry = new THREE.BufferGeometry();
              geometry.setAttribute('position', o.geometry.attributes.position);
              geometry.setIndex(o.geometry.index);
              geometry.setDrawRange(range.start, range.count);
              geometry.boundingSphere = o.getBoundingSphereAt(info.geometryIndex, new THREE.Sphere());
              byId[info.geometryIndex] = geometry;
              pieces.push(geometry);
            }
            o.getMatrixAt(i, m);
            put(new THREE.Mesh(geometry, distance), m.premultiply(o.matrixWorld));
          }
        } else if (objectWithin(o, within)) {
          put(new THREE.Mesh(o.geometry, distance), o.matrixWorld);
        }
      }
      for (const child of o.children) walk(child);
    };
    walk(world);
    return { scene: group, owned };
  }

  /** Render one face of the cube round `eye` into its slot of the target. */
  function renderFace(scene, eye, f) {
    const previous = renderer.getRenderTarget();
    const clear = renderer.getClearColor(_clear); const alpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    const shadows = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;
    renderer.autoClear = false;
    renderer.setClearColor(FAR_AWAY, 1);
    distance.uniforms.eye.value.copy(eye);
    probe.position.copy(eye);
    probe.up.copy(FACE_UP[f]);
    probe.lookAt(eye.x + FACE_DIR[f].x, eye.y + FACE_DIR[f].y, eye.z + FACE_DIR[f].z);
    probe.updateMatrixWorld();
    target.scissorTest = true;
    target.viewport.set(f * RES, 0, RES, RES);
    target.scissor.set(f * RES, 0, RES, RES);
    renderer.setRenderTarget(target);
    renderer.clear(true, true, false);
    renderer.render(scene, probe);
    target.scissorTest = false;
    renderer.setRenderTarget(previous);
    renderer.setClearColor(clear, alpha);
    renderer.autoClear = autoClear;
    renderer.shadowMap.needsUpdate = shadows;
    return probe.matrixWorld.clone();
  }
  const _clear = new THREE.Color();
  // Written as-is into a float target: nothing hit means "further than REACH".
  const FAR_AWAY = new THREE.Color(1e4, 0, 0);

  const _d = new THREE.Vector3();
  const _p = new THREE.Vector3();

  /**
   * Texel `q` of the last cube: its direction into `_d`, its distance
   * returned (Infinity for nothing hit). Walked in a plain loop by each
   * caller -- a callback per ray boxed the distance of all 24,576 of them.
   */
  function rayAt(faces, q) {
    const f = Math.floor(q / (RES * RES)); const r = q - f * RES * RES;
    const j = Math.floor(r / RES); const i = r - j * RES;
    _d.copy(rays[j * RES + i]).transformDirection(faces[f]);
  }
  /** Texel `q`'s distance, Infinity for nothing hit. */
  function hitAt(q) {
    const f = Math.floor(q / (RES * RES)); const r = q - f * RES * RES;
    const j = Math.floor(r / RES); const i = r - j * RES;
    const raw = readback[(j * RES * 6 + f * RES + i) * 4];
    return raw >= REACH * 0.999 ? Infinity : raw;
  }
  const RAYS = 6 * RES * RES;

  /** Where a ray from `o` along `d` leaves `box` (o inside), as a distance. */
  function exitOf(o, d, box) {
    let t = Infinity;
    const dx = d.x; const dy = d.y; const dz = d.z;
    if (Math.abs(dx) >= 1e-9) t = Math.min(t, ((dx > 0 ? box.max.x : box.min.x) - o.x) / dx);
    if (Math.abs(dy) >= 1e-9) t = Math.min(t, ((dy > 0 ? box.max.y : box.min.y) - o.y) / dy);
    if (Math.abs(dz) >= 1e-9) t = Math.min(t, ((dz > 0 ? box.max.z : box.min.z) - o.z) / dz);
    return t;
  }

  function faceOf(o, d, box, t) {
    _p.copy(o).addScaledVector(d, t);
    let best = 0; let err = Infinity;
    for (let f = 0; f < 6; f++) {
      const a = FACE_AXIS[f];
      const bound = FACE_SIGN[f] > 0 ? box.max.getComponent(a) : box.min.getComponent(a);
      const e = Math.abs(_p.getComponent(a) - bound);
      if (e < err) { err = e; best = f; }
    }
    return best;
  }

  function newCell(level, x, z) {
    const cx = x * CELL; const cz = z * CELL; const base = level * LEVEL_H;
    return {
      key: cellKey(level, x, z), level, x, z, base,
      box: new THREE.Box3(new THREE.Vector3(cx - HALF, base - BELOW, cz - HALF),
        new THREE.Vector3(cx + HALF, base + LEVEL_H - BELOW, cz + HALF)),
      inside: null, apertures: null, open: false, samples: null, done: false, next: 0,
      // Rays that left through each face and got clear of the next cell too,
      // kept to check that cell's apertures against: see `sealedInto`.
      escapes: [null, null, null, null, null, null], links: [], overflow: [false, false, false, false, false, false],
    };
  }

  /**
   * The cell's own inside, from its centre: how far the walls stand on each
   * side, read off the rays that run close to each axis but clear of the
   * doorway on it. The eye has to be in here for the apertures to hold.
   */
  function measureInside(cell, faces, centre) {
    const reach = [[], [], [], [], [], []];
    const grown = cell.box.clone().expandByScalar(SLACK);
    // What the centre sees, kept: the eye counts as inside only where the
    // centre could see it, which a pillar or a partition can prevent.
    const seen = new Uint16Array(6 * RES * RES);
    const d = _d;
    for (let k = 0; k < RAYS; k++) {
      const t = hitAt(k);
      rayAt(faces, k);
      seen[k] = Math.min(65535, Math.round(t * 100));
      if (t >= exitOf(centre, d, grown)) continue;
      let f = 0; let best = 0;
      for (let q = 0; q < 6; q++) {
        const v = d.getComponent(FACE_AXIS[q]) * FACE_SIGN[q];
        if (v > best) { best = v; f = q; }
      }
      if (best < 0.9) continue;
      reach[f].push(t * best);
    }
    // Kept at half resolution, the nearest hit of each 2x2: a thousand cells
    // at full size is 50 MB, and the nearer hit only ever says "outside" more.
    const half = RES / 2;
    cell.seen = new Uint16Array(6 * half * half);
    for (let f = 0; f < 6; f++) {
      for (let j = 0; j < half; j++) {
        for (let i = 0; i < half; i++) {
          const at = f * RES * RES + j * 2 * RES + i * 2;
          cell.seen[f * half * half + j * half + i] = Math.min(seen[at], seen[at + 1], seen[at + RES], seen[at + RES + 1]);
        }
      }
    }
    // The walls, as the middle of what the rays near each axis hit: a low
    // percentile finds the bar counter instead, and the eye standing at the
    // bar would count as outside the inn.
    const extent = reach.map((list, f) => {
      // Never out to the cell's edge: between a room's wall and its cell edge
      // is outside the room, where none of its apertures hold.
      const limit = FACE_AXIS[f] === 1 ? (FACE_SIGN[f] > 0 ? LEVEL_H - BELOW - 1.72 : 1.72) : HALF - 0.7;
      if (list.length < 40) return limit;
      list.sort((a, b) => a - b);
      return Math.min(limit, list[Math.floor(list.length * 0.5)]);
    });
    const inside = new THREE.Box3(
      new THREE.Vector3(centre.x - extent[1], centre.y - extent[3], centre.z - extent[5]),
      new THREE.Vector3(centre.x + extent[0], centre.y + extent[2], centre.z + extent[4]),
    );
    cell.inside = inside;
    // The eye's own range inside it: never under the floor, and a little in
    // from every wall so a probe never stands in one.
    const floor = cell.base + 0.3;
    const samples = [centre.clone()];
    const sx = [inside.min.x + (centre.x - inside.min.x) * (1 - SPREAD), centre.x, inside.max.x - (inside.max.x - centre.x) * (1 - SPREAD)];
    const sz = [inside.min.z + (centre.z - inside.min.z) * (1 - SPREAD), centre.z, inside.max.z - (inside.max.z - centre.z) * (1 - SPREAD)];
    for (const x of sx) for (const z of sz) if (x !== centre.x || z !== centre.z) samples.push(new THREE.Vector3(x, centre.y, z));
    samples.push(new THREE.Vector3(centre.x, Math.max(floor, Math.min(inside.max.y - 0.4, cell.base + 3.6)), centre.z));
    cell.samples = samples;
    cell.apertures = [null, null, null, null, null, null];
  }

  /** Every ray from `eye` that leaves the cell unhit widens the aperture it leaves by. */
  function gatherLeaks(cell, faces, eye) {
    const grown = cell.box.clone().expandByScalar(SLACK);
    const d = _d;
    // No ray leaves the grown box short of its nearest face: a hit nearer
    // than that is a wall of the cell's own, whichever way the ray went.
    // (A hair less, for a direction component rounded a hair over 1.)
    const inner = 0.999999 * Math.min(eye.x - grown.min.x, grown.max.x - eye.x, eye.y - grown.min.y,
      grown.max.y - eye.y, eye.z - grown.min.z, grown.max.z - eye.z);
    for (let k = 0; k < RAYS; k++) {
      const t = hitAt(k);
      if (t < inner) continue;
      rayAt(faces, k);
      const out = exitOf(eye, d, grown);
      if (t < out) continue;
      const exit = exitOf(eye, d, cell.box);
      // From the inner face at the latest, and never less than a slab deep:
      // a cave's mouth is not a hole in a plane, and the box has to hold it.
      const from = Math.max(0, Math.min(exitOf(eye, d, cell.inside), exit - DEPTH_OF_APERTURE));
      const f = faceOf(eye, d, cell.box, exit);
      let box = cell.apertures[f];
      if (!box) { box = new THREE.Box3(); cell.apertures[f] = box; }
      box.expandByPoint(_p.copy(eye).addScaledVector(d, from));
      box.expandByPoint(_p.copy(eye).addScaledVector(d, exit));
      if (t < exitOf(eye, d, pairBox(cell, f).expandByScalar(SLACK))) continue;
      if (cell.overflow[f]) continue;
      let list = cell.escapes[f];
      if (!list || list.n * 6 >= list.data.length) {
        if (list && list.data.length >= ESCAPES * 6) { cell.overflow[f] = true; cell.escapes[f] = null; continue; }
        const data = new Float32Array(Math.min(ESCAPES, list ? list.data.length / 3 : 256) * 6);
        if (list) data.set(list.data);
        list = cell.escapes[f] = { data, n: list ? list.n : 0 };
      }
      const at = list.n * 6; const data = list.data;
      data[at] = eye.x; data[at + 1] = eye.y; data[at + 2] = eye.z; data[at + 3] = d.x; data[at + 4] = d.y; data[at + 5] = d.z;
      list.n++;
    }
  }

  /** The cell's box and its neighbour's across face `f`, as one box. */
  const _pair = new THREE.Box3();
  function pairBox(cell, f) {
    _pair.copy(cell.box);
    const a = FACE_AXIS[f];
    const span = a === 1 ? LEVEL_H : CELL;
    if (FACE_SIGN[f] > 0) _pair.max.setComponent(a, _pair.max.getComponent(a) + span);
    else _pair.min.setComponent(a, _pair.min.getComponent(a) - span);
    return _pair;
  }

  function neighbour(cell, f, enqueue = false) {
    const a = FACE_AXIS[f]; const s = FACE_SIGN[f];
    return cellAt(cell.level + (a === 1 ? s : 0), cell.x + (a === 0 ? s : 0), cell.z + (a === 2 ? s : 0), enqueue);
  }

  /**
   * May sight through face `f` be followed into the next cell and clipped by
   * that cell's apertures in turn? Only if everything that got into it from
   * here and out the other side went through one of them. The next cell's
   * apertures were measured from inside it; what this checks is that sight
   * from this side enters its inside at all, and does not slip past the
   * outside of a tunnel's walls, say, where none of them hold.
   */
  function sealedInto(cell, f) {
    if (cell.links[f] !== undefined) return cell.links[f];
    const next = neighbour(cell, f, true);
    if (!next.done) return false;
    let sealed = !next.open && !cell.overflow[f];
    const list = cell.escapes[f] || { data: null, n: 0 };
    for (let k = 0; k < list.n && sealed; k++) {
      const i = k * 6; const a = list.data;
      _o.set(a[i], a[i + 1], a[i + 2]);
      _ray.set(_o, _d.set(a[i + 3], a[i + 4], a[i + 5]));
      let through = false;
      for (let g = 0; g < 6 && !through; g++) {
        if (g === (f ^ 1) || !next.apertures[g]) continue;
        through = _ray.intersectsBox(next.apertures[g]);
      }
      sealed = through;
    }
    cell.links[f] = sealed;
    cell.escapes[f] = null;
    return sealed;
  }
  const _o = new THREE.Vector3();
  const _ray = new THREE.Ray();

  function finishCell(cell) {
    let open = 0;
    for (let f = 0; f < 6; f++) {
      const box = cell.apertures[f];
      if (!box) continue;
      box.expandByScalar(MARGIN);
      // How much of the face it covers, for deciding the cell is open ground.
      const a = FACE_AXIS[f];
      const u = (a + 1) % 3; const v = (a + 2) % 3;
      const size = cell.box.getSize(_p);
      const covered = (Math.min(box.max.getComponent(u), cell.box.max.getComponent(u)) - Math.max(box.min.getComponent(u), cell.box.min.getComponent(u)))
        * (Math.min(box.max.getComponent(v), cell.box.max.getComponent(v)) - Math.max(box.min.getComponent(v), cell.box.min.getComponent(v)));
      open += Math.max(0, covered) / (size.getComponent(u) * size.getComponent(v));
    }
    cell.open = open / 6 > OPEN_SHARE;
    cell.done = true;
    state.stats.measured++;
  }

  /**
   * One face's worth of measuring. Returns false when there is nothing left
   * to do, WAIT while a cube is on its way back from the GPU. A cell is 11
   * cubes of 6 faces, each face a small draw; spread over frames by `work`,
   * which keeps to a budget.
   *
   * The cube used to be read back at once, which made the CPU wait for the
   * GPU to finish everything queued before it -- the whole frame just drawn.
   * Walking into a new cell that was eleven stalls of several milliseconds,
   * and `work()` averaged 3.4-4.5 ms against its 1.5 ms budget. Read back
   * asynchronously it arrives a frame or two later and costs nothing. `sync`
   * is for `settle` and `measure`, which want the answer now.
   */
  function step(sync = false) {
    while (queue.length && queue[0].done) queue.shift();
    const cell = queue[0];
    if (!cell) return false;
    if (!cell.job) {
      if (!indexed) { indexInstances(); indexed = true; }
      cell.job = { ...proxiesFor(cell), sample: 0, face: 0, faces: [] };
      cell.centre = new THREE.Vector3(cell.x * CELL, cell.base + 1.72, cell.z * CELL);
      return true;
    }
    const job = cell.job;
    const eye = job.sample === 0 ? cell.centre : cell.samples[job.sample];
    // A read left pending is only good if nothing has drawn over it since;
    // asked for synchronously, draw the cube again rather than guess.
    if (sync && job.face === 6 && !job.ready) job.face = 0;
    if (job.face < 6) {
      job.faces[job.face] = renderFace(job.scene, eye, job.face);
      if (++job.face < 6) return true;
      if (sync) {
        renderer.readRenderTargetPixels(target, 0, 0, RES * 6, RES, readback);
        job.ready = 'now';
      } else {
        job.ready = false;
        job.buffer ||= new Float32Array(readback.length);
        const reading = job.reading = readPixelsAsync(renderer, target, RES * 6, RES, job.buffer)
          .then(() => { if (job.reading === reading) job.ready = 'later'; });
        return WAIT;
      }
    }
    if (!job.ready) return WAIT;
    if (job.ready === 'later') readback.set(job.buffer);
    job.ready = false; job.reading = null;
    if (job.sample === 0) measureInside(cell, job.faces, eye);
    gatherLeaks(cell, job.faces, eye);
    job.face = 0;
    if (++job.sample < cell.samples.length) return true;
    finishCell(cell);
    for (const proxy of job.owned) proxy.dispose();
    cell.job = null;
    return true;
  }

  function cellAt(level, x, z, enqueue) {
    const key = cellKey(level, x, z);
    let cell = cells.get(key);
    if (!cell) {
      cell = newCell(level, x, z);
      cells.set(key, cell);
    }
    if (enqueue && !cell.done && !queue.includes(cell)) queue.push(cell);
    return cell;
  }

  /** Rotation into each cube face's camera, for looking up what the centre saw. */
  const FACE_INV = FACE_DIR.map((dir, f) => {
    const c = new THREE.PerspectiveCamera(90, 1, 0.05, 1);
    c.up.copy(FACE_UP[f]);
    c.lookAt(dir);
    c.updateMatrixWorld();
    return c.matrixWorld.clone().invert();
  });

  /**
   * Is the eye in the part of the cell its apertures hold for: inside the
   * walls, not in a doorway, and in plain sight of the centre?
   */
  function eyeInside(cell, p) {
    // Open ground is not skipped: a street's walls are its houses, and what
    // stands behind them is seen only over the eaves or down the street.
    if (!cell.done || !cell.inside.containsPoint(p)) return false;
    for (const box of cell.apertures) if (box && box.containsPoint(p)) return false;
    const cx = cell.x * CELL; const cy = cell.base + 1.72; const cz = cell.z * CELL;
    _v.set(p.x - cx, p.y - cy, p.z - cz);
    const length = _v.length();
    if (length < 0.3) return true;
    let f = 0; let best = -1;
    for (let q = 0; q < 6; q++) {
      const v = _v.getComponent(FACE_AXIS[q]) * FACE_SIGN[q];
      if (v > best) { best = v; f = q; }
    }
    _v.transformDirection(FACE_INV[f]);
    const half = RES / 2;
    const i = Math.floor(((_v.x / -_v.z) + 1) / 2 * half);
    const j = Math.floor(((_v.y / -_v.z) + 1) / 2 * half);
    // The nearest texels round it too: one texel is 2.8 degrees.
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ii = Math.min(half - 1, Math.max(0, i + di)); const jj = Math.min(half - 1, Math.max(0, j + dj));
        if (cell.seen[f * half * half + jj * half + ii] / 100 < length + 0.3) return false;
      }
    }
    return true;
  }

  function locate(position) {
    const level = Math.floor((position.y + BELOW) / LEVEL_H);
    return { level, x: Math.round(position.x / CELL), z: Math.round(position.z / CELL) };
  }

  // ------------------------------------------------------------ the frame --

  const viewProj = new THREE.Matrix4();
  const view = new THREE.Matrix4();
  let proj = null;
  let near = 0.1;
  const _v = new THREE.Vector3();
  const FULL = [-1, -1, 1, 1];

  /**
   * Screen rectangle of a world box, [x0, y0, x1, y1] in NDC, or null. The
   * part behind the near plane is cut off first: an aperture behind you
   * shows nothing, and one you are walking through covers the screen only as
   * far as it actually does.
   */
  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  function boxRect(box) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const take = (vx, vy, depth) => {
      const px = (proj[0] * vx - proj[8] * depth) / depth;
      const py = (proj[5] * vy - proj[9] * depth) / depth;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    };
    for (let c = 0; c < 8; c++) {
      corners[c].set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z).applyMatrix4(view);
      if (-corners[c].z >= near) take(corners[c].x, corners[c].y, -corners[c].z);
    }
    for (const [a, b] of EDGES) {
      const da = -corners[a].z - near; const db = -corners[b].z - near;
      if ((da >= 0) === (db >= 0)) continue;
      const k = da / (da - db);
      take(corners[a].x + (corners[b].x - corners[a].x) * k, corners[a].y + (corners[b].y - corners[a].y) * k, near);
    }
    return x0 <= x1 ? [x0, y0, x1, y1] : null;
  }

  const clipRect = (a, b) => {
    const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    return r[0] < r[2] && r[1] < r[3] ? r : null;
  };

  /**
   * Can a sphere be seen? In the frustum, and -- with apertures -- in the
   * eye's own cell or through one of them. Projected as the view-space box
   * round the sphere, which is conservative and costs a handful of flops.
   */
  const e = new Float64Array(16);
  /**
   * The same test for a sphere stored at `a[o..o+3]`. Everything hot calls
   * this one: a double handed to a function that is not inlined is boxed on
   * the heap, and four of them per sphere -- tens of thousands of spheres a
   * frame -- was most of the frame's garbage.
   */
  const scratch = new Float64Array(4);
  function sphereVisible(x, y, z, r, bound = false) {
    scratch[0] = x; scratch[1] = y; scratch[2] = z; scratch[3] = r;
    return visibleAt(scratch, 0, bound);
  }
  const rect = new Float64Array(4);
  function visibleAt(a, o, bound) {
    const x = a[o]; const y = a[o + 1]; const z = a[o + 2]; const r = a[o + 3];
    // The zones' answer, for what is not under the zones: the actors' trees,
    // lamps and props stand in regions of their own that reach from the
    // street down into the sewer. A single thing goes by its centre; a volume
    // round many only once all of it is on the hidden side.
    if (surfaceHidden && (bound ? y - r : y) > zoneLine) return false;
    if (deepHidden && (bound ? y + r : y) < deepLine) return false;
    const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const depth = -vz;
    if (depth + r < near) return false;
    if (depth - r > farPlane) return false;
    if (sizeCull && r < depth * detail) return false;
    let x0 = -1; let y0 = -1; let x1 = 1; let y1 = 1;
    if (depth - r > near) {
      const dn = depth - r; const df = depth + r;
      x0 = proj[0] * Math.min((vx - r) / dn, (vx - r) / df);
      x1 = proj[0] * Math.max((vx + r) / dn, (vx + r) / df);
      y0 = proj[5] * Math.min((vy - r) / dn, (vy - r) / df);
      y1 = proj[5] * Math.max((vy + r) / dn, (vy + r) / df);
      if (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return false;
    }
    if (state.active) {
      rect[0] = x0; rect[1] = y0; rect[2] = x1; rect[3] = y1;
      if (!throughApertures(a, o)) return false;
    }
    return !(occluding && occlusion.hiddenAt(a, o));
  }

  function throughApertures(a, o) {
    const x = a[o]; const y = a[o + 1]; const z = a[o + 2]; const r = a[o + 3];
    const x0 = rect[0]; const y0 = rect[1]; const x1 = rect[2]; const y1 = rect[3];
    const own = state.cell.box;
    if (x + r > own.min.x && x - r < own.max.x && y + r > own.min.y && y - r < own.max.y
      && z + r > own.min.z && z - r < own.max.z) return true;
    for (const w of state.windows) {
      if (x1 < w.rect[0] || x0 > w.rect[2] || y1 < w.rect[1] || y0 > w.rect[3]) continue;
      if (w.box) {
        const b = w.box;
        if (x + r > b.min.x && x - r < b.max.x && y + r > b.min.y && y - r < b.max.y
          && z + r > b.min.z && z - r < b.max.z) return true;
        continue;
      }
      const c = w.axis === 0 ? x : w.axis === 1 ? y : z;
      if (w.sign > 0 ? c + r > w.plane : c - r < w.plane) return true;
    }
    return false;
  }

  /** Does the sun's camera see the sphere at `a[o]`? Frustum.intersectsSphere, unboxed. */
  function castAt(a, o) {
    const x = a[o]; const y = a[o + 1]; const z = a[o + 2]; const negRadius = -a[o + 3];
    const planes = shadowFrustum.planes;
    for (let i = 0; i < 6; i++) {
      const p = planes[i]; const n = p.normal;
      if (n.x * x + n.y * y + n.z * z + p.constant < negRadius) return false;
    }
    return true;
  }
  // Whether the depth of the last frames may hide what is tested: see
  // occlusion.js. Off for figures, which move on their own.
  let occluding = false;
  let farPlane = 900;
  // Anything lit whose sphere is under DETAIL_PX in radius on screen is not
  // drawn: a dropped dagger 300 m off, a sign bracket across the town. The
  // forest view drew ~150 of them a pass. `detail` is that radius per metre
  // of depth; `sizeCull` says whether what is being tested may go.
  let detail = 0;
  let sizeCull = false;
  const detailOk = new WeakMap();
  function mayShrink(material) {
    let ok = detailOk.get(material);
    if (ok === undefined) {
      const list = Array.isArray(material) ? material : [material];
      // Unlit and glowing things stay: a lamp is a point of light at any
      // distance, and the horizon is all far away.
      ok = list.every((m) => m && m.isMeshStandardMaterial && !m.emissiveMap
        && !(m.emissiveIntensity > 0 && (m.emissive.r + m.emissive.g + m.emissive.b) > 0));
      detailOk.set(material, ok);
    }
    return ok;
  }
  const selectOwner = (mesh) => { sizeCull = detail > 0 && mayShrink(mesh.material); };
  let surfaceHidden = false;
  let deepHidden = false;
  let zoneLine = 0;
  let deepLine = 0;

  const _sphere = new THREE.Sphere();
  function objectWithin(o, test) {
    const g = o.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    _sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    return test(_sphere.center.x, _sphere.center.y, _sphere.center.z, _sphere.radius);
  }

  /**
   * Is any copy of a small instanced mesh that moves -- the door leaves, a
   * handful of meshes of a dozen or two doors each, spread over the whole
   * town -- in view? One sphere round all of them is always in view; the
   * doors seldom are: 37 draws between the main pass and the AO prepass at
   * the graveyard. Each copy by its whole sphere and at any size, so that
   * one hidden is one that draws nothing.
   */
  const FEW = 64;
  function anyInstanceVisible(o) {
    const g = o.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const was = sizeCull;
    sizeCull = false;
    let seen = false;
    for (let i = 0; i < o.count && !seen; i++) {
      o.getMatrixAt(i, _m);
      _sphere.copy(g.boundingSphere).applyMatrix4(_m.premultiply(o.matrixWorld));
      scratch[0] = _sphere.center.x; scratch[1] = _sphere.center.y; scratch[2] = _sphere.center.z; scratch[3] = _sphere.radius;
      seen = visibleAt(scratch, 0, true);
    }
    sizeCull = was;
    return seen;
  }

  function objectVisible(o) {
    const g = o.geometry;
    if (o.isSkinnedMesh) {
      // A figure's bind-pose sphere, grown for arms and a weapon in the air.
      if (!g.boundingSphere) g.computeBoundingSphere();
      _sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
      const was = occluding;
      occluding = false;
      const seen = sphereVisible(_sphere.center.x, _sphere.center.y, _sphere.center.z, _sphere.radius * 1.5 + 0.5);
      occluding = was;
      return seen;
    }
    const bounds = o.isInstancedMesh || o.isBatchedMesh ? o.boundingSphere : null;
    if (bounds) _sphere.copy(bounds).applyMatrix4(o.matrixWorld);
    else {
      if (!g.boundingSphere) g.computeBoundingSphere();
      _sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    }
    return sphereVisible(_sphere.center.x, _sphere.center.y, _sphere.center.z, _sphere.radius, true);
  }

  /**
   * The rectangles sight can get out through. Through an aperture into a
   * sealed neighbour, what is in that neighbour is seen through the
   * rectangle, and what is past it only through the part of the rectangle its
   * own apertures cover -- a tunnel, then the cave at its end, not every tree
   * in the forest that lines up with the first doorway.
   */
  function windowsFor(cell) {
    const windows = [];
    const visit = (c, clip, depth, from) => {
      for (let f = 0; f < 6; f++) {
        const box = c.apertures[f];
        if (!box || f === (from ^ 1)) continue;
        const seen = boxRect(box);
        const rect = seen && clipRect(seen, clip);
        if (!rect) continue;
        if (depth < DEPTH && windows.length < MAX_WINDOWS && sealedInto(c, f)) {
          windows.push({ rect, box: neighbour(c, f).box });
          visit(neighbour(c, f), rect, depth + 1, f);
          continue;
        }
        // Anything seen through it is past the inner face of the aperture.
        const a = FACE_AXIS[f];
        windows.push({ rect, box: null, axis: a, sign: FACE_SIGN[f], plane: FACE_SIGN[f] > 0 ? box.min.getComponent(a) : box.max.getComponent(a) });
      }
    };
    visit(cell, FULL, 0, -2);
    return windows;
  }

  // ------------------------------------------------------------ instances --

  /** Static instanced meshes, indexed once: per-instance spheres in buckets of about a chunk. */
  const instanced = [];
  const instancedBy = new Map();
  const BUCKET = 26;
  function indexInstances() {
    scene.traverse((o) => {
      if (!o.isInstancedMesh || !o.userData.cullable) return;
      const n = o.count;
      if (n < 2) return;
      const g = o.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const local = g.boundingSphere;
      const m = new THREE.Matrix4();
      // Float32-rounded, as they always were, but held as doubles: every test
      // reads them as doubles anyway, and one array type keeps visibleAt
      // monomorphic.
      const spheres = new Float64Array(n * 4);
      const buckets = new Map();
      o.updateWorldMatrix(true, false);
      for (let i = 0; i < n; i++) {
        o.getMatrixAt(i, m);
        m.premultiply(o.matrixWorld);
        _sphere.copy(local).applyMatrix4(m);
        spheres[i * 4] = Math.fround(_sphere.center.x); spheres[i * 4 + 1] = Math.fround(_sphere.center.y);
        spheres[i * 4 + 2] = Math.fround(_sphere.center.z); spheres[i * 4 + 3] = Math.fround(_sphere.radius);
        const key = `${Math.floor(_sphere.center.x / BUCKET)},${Math.floor(_sphere.center.z / BUCKET)}`;
        let b = buckets.get(key);
        if (!b) { b = { list: [], sphere: null }; buckets.set(key, b); }
        b.list.push(i);
      }
      const list = [];
      for (const b of buckets.values()) {
        const box = new THREE.Box3();
        for (const i of b.list) {
          _sphere.set(_v.set(spheres[i * 4], spheres[i * 4 + 1], spheres[i * 4 + 2]), spheres[i * 4 + 3]);
          box.union(_sphere.getBoundingBox(new THREE.Box3()));
        }
        list.push({ ids: Int32Array.from(b.list), sphere: box.getBoundingSphere(new THREE.Sphere()) });
      }
      // The buckets' spheres side by side, for the same unboxed test.
      const bucketSpheres = new Float64Array(list.length * 4);
      list.forEach((b, k) => {
        bucketSpheres[k * 4] = b.sphere.center.x; bucketSpheres[k * 4 + 1] = b.sphere.center.y;
        bucketSpheres[k * 4 + 2] = b.sphere.center.z; bucketSpheres[k * 4 + 3] = b.sphere.radius;
      });
      const entry = {
        mesh: o, total: n, spheres, buckets: list, bucketSpheres,
        source: o.instanceMatrix.array.slice(),
        kept: new Int32Array(n), keptCount: n, full: true,
        lod: o.userData.lod || null, feet: null,
      };
      if (entry.lod) {
        // Where each copy stands, how big and which way it faces: what its
        // card is drawn from, and what the crossfade measures to.
        entry.feet = new Float32Array(n * 5);
        const e = m.elements;
        for (let i = 0; i < n; i++) {
          o.getMatrixAt(i, m);
          m.premultiply(o.matrixWorld);
          entry.feet.set([e[12], e[13], e[14], Math.hypot(e[0], e[2]), Math.atan2(-e[2], e[0])], i * 5);
        }
      }
      instanced.push(entry);
      instancedBy.set(o, entry);
    });
  }

  /**
   * One grid over every static instance and every batch piece in the world,
   * 26 m a cell, so that a cell out of view is one test for everything in it.
   * Per mesh, the buckets were ~2.5 instances each at the graveyard -- 7,700
   * bucket tests a frame for 21,000 instances -- and the batches had none.
   * A cell's sphere holds every sphere in it, so a cell that cannot be seen
   * has nothing in it that can: the answer per instance is unchanged.
   *
   * The far-drawn trees keep their own buckets (`compact`): the order their
   * cards are handed over in is the order they are drawn in.
   */
  const GRID = 26;
  let grid = null;
  function buildGrid() {
    const owners = [];
    for (const entry of instanced) {
      if (entry.lod) continue;
      owners.push({ entry, mesh: entry.mesh, spheres: entry.spheres, n: entry.total, batch: null, marks: new Int32Array(entry.total), lo: 0, hi: -1, count: 0, nearest: Infinity, shrink: false });
    }
    scene.traverse((o) => {
      if (!o.isBatchedMesh || !o.pieceSpheres || !o.nearestVisible) return;
      const owner = { entry: null, mesh: o, spheres: o.pieceSpheres(), n: o._instanceInfo.length, batch: o, marks: null, lo: 0, hi: -1, count: 0, nearest: Infinity, shrink: false, list: new Int32Array(o._instanceInfo.length) };
      o._gridOwner = owner;
      owners.push(owner);
    });
    for (const owner of owners) if (owner.entry) owner.entry.gridOwner = owner;
    const byCell = new Map();
    owners.forEach((owner, k) => {
      const a = owner.spheres;
      for (let i = 0; i < owner.n; i++) {
        if (owner.batch && !owner.batch._instanceInfo[i].active) continue;
        const key = `${Math.floor(a[i * 4] / GRID)},${Math.floor(a[i * 4 + 1] / GRID)},${Math.floor(a[i * 4 + 2] / GRID)}`;
        let list = byCell.get(key);
        if (!list) { list = []; byCell.set(key, list); }
        list.push(k, i);
      }
    });
    const cellCount = byCell.size;
    const spheres = new Float64Array(cellCount * 4);
    const starts = new Int32Array(cellCount + 1);
    let total = 0;
    for (const list of byCell.values()) total += list.length / 2;
    const owner = new Int32Array(total); const id = new Int32Array(total);
    let c = 0; let at = 0;
    const box = new THREE.Box3(); const one = new THREE.Box3();
    for (const list of byCell.values()) {
      // By owner, then id: a run per owner, tested in index order.
      const pairs = [];
      for (let q = 0; q < list.length; q += 2) pairs.push([list[q], list[q + 1]]);
      pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      box.makeEmpty();
      starts[c] = at;
      for (const [k, i] of pairs) {
        const a = owners[k].spheres;
        _sphere.set(_v.set(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]), a[i * 4 + 3]);
        box.union(_sphere.getBoundingBox(one));
        owner[at] = k; id[at] = i; at++;
      }
      box.getBoundingSphere(_sphere);
      spheres[c * 4] = _sphere.center.x; spheres[c * 4 + 1] = _sphere.center.y;
      spheres[c * 4 + 2] = _sphere.center.z; spheres[c * 4 + 3] = _sphere.radius;
      c++;
    }
    starts[c] = at;
    return { owners, spheres, starts, owner, id, cells: cellCount };
  }

  /**
   * Everything in the grid, tested: instances kept (or cast, on a shadow
   * frame) marked with this frame's stamp, batch pieces likewise, each
   * owner's nearest visible distance worked out on the way.
   */
  function sweepGrid(shadow) {
    const { owners, spheres: cellSpheres, starts, owner: ownerOf, id: idOf, cells } = grid;
    const stamp = state.stamp;
    const ex = camera.position.x; const ey = camera.position.y; const ez = camera.position.z;
    for (let k = 0; k < owners.length; k++) {
      const w = owners[k];
      w.lo = w.n; w.hi = -1; w.count = 0; w.nearest = Infinity;
      w.shrink = detail > 0 && mayShrink(w.mesh.material);
      if (w.batch) w.marks = w.batch.seenMarks();
    }
    for (let c = 0; c < cells; c++) {
      // Size is a property of each mesh's material, not of the cell: the cell
      // is tested without it, which only ever lets more through.
      sizeCull = false;
      if (!visibleAt(cellSpheres, c * 4, true) && !(shadow && castAt(cellSpheres, c * 4))) continue;
      let k = -1; let w = null; let skip = false; let info = null;
      for (let q = starts[c]; q < starts[c + 1]; q++) {
        if (ownerOf[q] !== k) {
          k = ownerOf[q]; w = owners[k];
          skip = !w.mesh.visible;
          sizeCull = w.shrink;
          info = w.batch ? w.batch._instanceInfo : null;
        }
        if (skip) continue;
        const i = idOf[q]; const o = i * 4; const a = w.spheres;
        let keep;
        if (info) keep = info[i].visible && info[i].active && visibleAt(a, o, false);
        else keep = visibleAt(a, o, false) || (shadow && castAt(a, o));
        if (!keep) continue;
        w.marks[i] = stamp;
        if (info) w.list[w.count] = i;
        w.count++;
        if (i < w.lo) w.lo = i;
        if (i > w.hi) w.hi = i;
        const dx = a[o] - ex; const dy = a[o + 1] - ey; const dz = a[o + 2] - ez;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - a[o + 3];
        if (d < w.nearest) w.nearest = d;
      }
    }
    sizeCull = false;
    for (let k = 0; k < owners.length; k++) {
      const w = owners[k];
      if (w.batch) { w.batch.seenStamp(stamp, w.list, w.count); continue; }
      const entry = w.entry;
      if (!w.mesh.visible) continue;
      if (state.debugNoCompact) { restoreInstances(entry); continue; }
      // Swept up in index order: the draw order is kept.
      const kept = entry.kept; const marks = w.marks;
      let n = 0;
      for (let i = w.lo; i <= w.hi; i++) if (marks[i] === stamp) kept[n++] = i;
      store(entry, n);
      entry.nearest = w.nearest;
    }
  }

  const shadowFrustum = new THREE.Frustum();
  const _m = new THREE.Matrix4();

  /**
   * Keep the instances that can be seen -- all of them with `all`, which is
   * culling switched off -- in their original order. A model drawn as a card
   * far off keeps its full copies only short of the crossfade's far end -- and
   * any the sun's camera needs, on a frame that redraws the shadows -- and
   * hands the ones past its near end to the cards.
   */
  function compact(entry, all, shadow = false) {
    const { spheres, kept, bucketSpheres, buckets } = entry;
    const lod = entry.lod && impostors?.enabled ? entry.lod : null;
    selectOwner(entry.mesh);
    const cards = lod && lod.primary && lod.model.mesh ? lod.model : null;
    const start = lod ? impostors.near : 0; const end = lod ? impostors.far : 0;
    const feet = entry.feet;
    const eye = camera.position;
    const ex = eye.x; const ey = eye.y; const ez = eye.z;
    let n = 0;
    let nearest = Infinity;
    for (let b = 0; b < buckets.length; b++) {
      if (!all && !visibleAt(bucketSpheres, b * 4, true) && !(shadow && castAt(bucketSpheres, b * 4))) continue;
      const ids = buckets[b].ids;
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k];
        const o = i * 4;
        if (!lod) {
          if (all || visibleAt(spheres, o, false) || (shadow && castAt(spheres, o))) {
            kept[n++] = i;
            const dx = spheres[o] - ex; const dy = spheres[o + 1] - ey; const dz = spheres[o + 2] - ez;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - spheres[o + 3];
            if (d < nearest) nearest = d;
          }
          continue;
        }
        const f = i * 5;
        const dx = feet[f] - ex; const dy = feet[f + 1] - ey; const dz = feet[f + 2] - ez;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const visible = all || visibleAt(spheres, o, false);
        if ((visible && d < end) || (shadow && castAt(spheres, o))) {
          kept[n++] = i;
          if (visible && d - spheres[o + 3] < nearest) nearest = d - spheres[o + 3];
        }
        if (cards && visible && d > start) impostors.pushFrom(cards, feet, f);
      }
    }
    // Draw order is kept: the ids went in bucket by bucket, so sort them back.
    kept.subarray(0, n).sort();
    store(entry, n);
    sizeCull = false;
    entry.nearest = nearest;
    return n;
  }

  /** Draw the first `n` of `entry.kept`, unless that is what is drawn already. */
  function store(entry, n) {
    const ids = entry.kept;
    const mesh = entry.mesh;
    let same = !entry.full && n === entry.keptCount;
    if (same && entry.last) for (let k = 0; k < n && same; k++) same = entry.last[k] === ids[k];
    if (!same) {
      const out = mesh.instanceMatrix.array;
      const source = entry.source;
      for (let k = 0; k < n; k++) out.set(source.subarray(ids[k] * 16, ids[k] * 16 + 16), k * 16);
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
      mesh.instanceMatrix.needsUpdate = true;
      entry.last ||= new Int32Array(entry.total);
      entry.last.set(ids.subarray(0, n));
      entry.keptCount = n;
      entry.full = false;
    }
    state.stats.instances += entry.total;
    state.stats.instancesKept += n;
  }

  function restoreInstances(entry) {
    if (entry.full) return;
    const mesh = entry.mesh;
    mesh.instanceMatrix.array.set(entry.source);
    mesh.count = entry.total;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.needsUpdate = true;
    entry.full = true;
  }

  // ------------------------------------------------------ hiding, per frame --

  const hiddenNow = [];
  let hiddenForMain = false;
  function hideAll() {
    for (const o of hiddenNow) o.visible = false;
    hiddenForMain = true;
  }
  function showAll() {
    for (const o of hiddenNow) o.visible = true;
    hiddenForMain = false;
  }

  // The shadow pass walks the scene before the main pass draws but after the
  // main pass has already listed what it will draw. This sensor, first in the
  // scene, puts every hidden object back for the shadow pass, and takes them
  // away again as the first thing the main pass draws -- in time for the AO
  // prepass, which lists the scene afresh.
  const sensor = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }),
  );
  sensor.name = 'visibility sensor';
  sensor.frustumCulled = false;
  sensor.castShadow = true;
  sensor.renderOrder = -1e9;
  sensor.onBeforeShadow = () => { if (hiddenForMain) showAll(); };
  sensor.onBeforeRender = (r, s, cam) => { if (cam === camera && !hiddenForMain && hiddenNow.length) hideAll(); };
  scene.children.unshift(sensor);
  sensor.parent = scene;

  function collectCullable(root, out) {
    root.traverseVisible((o) => {
      if (o === sensor || o.frustumCulled === false) return;
      if (!(o.isMesh || o.isPoints)) return;
      out.push(o);
    });
  }

  /**
   * Is everything the static instances and batch pieces were chosen by just
   * as it was last frame? The camera to the last bit, the depth map it was
   * tested against, the zones, the cell's apertures, the cards' range, which
   * meshes are shown and which pieces switched on. Standing still, that is
   * every frame -- and the whole sweep is skipped. A shadow frame widens the
   * sets for the sun's camera, so neither it nor the frame after it counts.
   */
  const was = new Float64Array(44);
  let wasValid = false;
  const kept = { instances: 0, instancesKept: 0 };
  function asBefore(shadow) {
    let same = wasValid && !shadow && !!grid && !state.debugNoCompact;
    const m = camera.matrixWorld.elements; const p = camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) {
      if (was[i] !== m[i]) { was[i] = m[i]; same = false; }
      if (was[16 + i] !== p[i]) { was[16 + i] = p[i]; same = false; }
    }
    const now = [
      occlusion ? occlusion.state.version : 0, occluding ? 1 : 0, surfaceHidden ? 1 : 0, deepHidden ? 1 : 0,
      state.active ? 1 : 0, state.stats.measured, impostors?.enabled ? 1 : 0, impostors ? impostors.near : 0,
      impostors ? impostors.far : 0, detail, state.aoReach, cullHook.edits,
    ];
    for (let i = 0; i < now.length; i++) if (was[32 + i] !== now[i]) { was[32 + i] = now[i]; same = false; }
    if (grid) {
      for (const w of grid.owners) {
        const on = w.mesh.visible;
        if (on !== w.wasOn) { w.wasOn = on; same = false; }
      }
    }
    wasValid = !shadow;
    return same;
  }

  let indexed = false;
  let moverAge = Infinity;
  const candidates = [];

  /** Before the frame is drawn: decide what can be seen and hide the rest. */
  function begin() {
    state.stats.instances = 0; state.stats.instancesKept = 0; state.stats.culled = 0;
    if (!indexed) { indexInstances(); indexed = true; }
    const shadow = renderer.shadowMap.needsUpdate;
    state.shadowFrame = shadow;
    hiddenNow.length = 0;
    // Underground, the sky is part of the surface the zones already hide: it
    // only ever showed through hairline cracks in the vaults, as bright dots
    // in a dark sewer. Not a cull -- the picture it changes is a defect -- so
    // it holds with culling off too.
    if (zones) {
      zones.update(camera.position);
      if (!zones.surface.visible) for (const o of sky) if (o.visible) hiddenNow.push(o);
    }
    // A cull, so off with the rest: `?cull=off` must still draw everything.
    surfaceHidden = state.enabled && !!zones && !zones.surface.visible;
    deepHidden = state.enabled && !!zones && !zones.deep.visible;
    if (zones) { zoneLine = zones.groundY - 1; deepLine = zones.groundY - LEVEL_H / 2; }
    if (!state.enabled) {
      wasValid = false;
      state.active = false;
      // Distance is not visibility: the cards stay on with culling off.
      if (impostors) for (const model of impostors.models.values()) if (model.mesh) impostors.begin(model);
      if (shadow) {
        sun.shadow.updateMatrices(sun);
        shadowFrustum.setFromProjectionMatrix(_m.multiplyMatrices(sun.shadow.camera.projectionMatrix, sun.shadow.camera.matrixWorldInverse));
      }
      for (const entry of instanced) {
        if (entry.lod && impostors?.enabled) compact(entry, true, shadow);
        else restoreInstances(entry);
      }
      if (impostors) for (const model of impostors.models.values()) if (model.mesh) impostors.finish(model);
      cullHook.test = null;
      if (hiddenNow.length) hideAll();
      return;
    }
    camera.updateMatrixWorld();
    view.copy(camera.matrixWorldInverse.copy(camera.matrixWorld).invert());
    e.set(view.elements);
    proj = camera.projectionMatrix.elements;
    near = camera.near; farPlane = camera.far;
    viewProj.multiplyMatrices(camera.projectionMatrix, view);
    detail = impostors?.enabled ? DETAIL_PX / (proj[5] * renderer.getDrawingBufferSize(_size).y / 2) : 0;
    occluding = !!occlusion?.state.ready && occlusion.state.enabled;
    if (occlusion && ++moverAge > 120) { moverAge = 0; occlusion.sortMovers(); }

    const at = locate(camera.position);
    const cell = cellAt(at.level, at.x, at.z, true);
    // The eye's own cell before anything left queued from where it was: after
    // a recall or a goto the queue still holds the last place's neighbours,
    // and the new cell went unmeasured -- and unculled -- behind them.
    if (!cell.done && queue[0] !== cell) {
      queue.splice(queue.indexOf(cell), 1);
      queue.unshift(cell);
    }
    state.cell = cell;
    state.active = eyeInside(cell, camera.position);
    state.windows = state.active ? windowsFor(cell) : [];
    if (asBefore(shadow)) {
      // Nothing the instances and pieces were chosen by has moved: what was
      // kept last frame is kept, and under the same stamp the batches keep
      // their draw lists too.
      state.stats.instances = kept.instances; state.stats.instancesKept = kept.instancesKept;
      state.stats.reused++;
    } else {
      state.stamp++;
      if (shadow) {
        sun.updateMatrixWorld();
        sun.target.updateMatrixWorld();
        sun.shadow.updateMatrices(sun);
        shadowFrustum.setFromProjectionMatrix(_m.multiplyMatrices(sun.shadow.camera.projectionMatrix, sun.shadow.camera.matrixWorldInverse));
      }
      grid ||= buildGrid();
      sweepGrid(shadow);
      if (impostors) for (const model of impostors.models.values()) if (model.mesh) impostors.begin(model);
      for (const entry of instanced) {
        if (!entry.lod || !entry.mesh.visible) continue;
        if (state.debugNoCompact) { restoreInstances(entry); continue; }
        compact(entry, false, shadow);
      }
      if (impostors) for (const model of impostors.models.values()) if (model.mesh) impostors.finish(model);
      kept.instances = state.stats.instances; kept.instancesKept = state.stats.instancesKept;
    }

    // Whole objects. A region's batch or instanced mesh with nothing left in
    // view is hidden whatever the walls, since three would still bind it and
    // issue an empty draw; anything else only where there are walls.
    candidates.length = 0;
    collectCullable(scene, candidates);
    const aoFar = state.aoFar;
    aoFar.length = 0;
    const eye = camera.position;
    for (const o of candidates) {
      if (o.isInstancedMesh && o.userData.cullable) {
        if (o.count === 0) hiddenNow.push(o);
        else if (instancedBy.get(o)?.nearest > state.aoReach) aoFar.push(o);
        continue;
      }
      selectOwner(o);
      if (o.isBatchedMesh && o.nearestVisible) {
        const d = o._gridOwner ? o._gridOwner.nearest : o.nearestVisible(visibleAt, eye, state.stamp);
        if (d === Infinity) hiddenNow.push(o);
        else if (d > state.aoReach) aoFar.push(o);
      } else if ((state.active || surfaceHidden || deepHidden || sizeCull || occluding) && !objectVisible(o)) {
        hiddenNow.push(o);
      } else if (o.isInstancedMesh && !o.userData.cullable && o.count <= FEW && !anyInstanceVisible(o)) {
        hiddenNow.push(o);
      } else if (!o.isSkinnedMesh && !o.isInstancedMesh && o.geometry) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        _sphere.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
        if (_sphere.distanceToPoint(eye) > state.aoReach) aoFar.push(o);
      }
    }
    sizeCull = false;
    state.stats.culled = hiddenNow.length;
    if (state.debugNoHide) hiddenNow.length = 0;
    if (hiddenNow.length) hideAll();

    cullHook.camera = camera;
    cullHook.stamp = state.stamp;
    cullHook.test = state.active || surfaceHidden || deepHidden || detail > 0 || occluding ? visibleAt : null;
    cullHook.select = selectOwner;
  }

  /** After the frame: put back what was hidden, so nothing else ever sees it. */
  function end() {
    if (state.enabled) occlusion?.capture();
    if (hiddenForMain) showAll();
    hiddenNow.length = 0;
    cullHook.test = null;
  }

  /**
   * Measure a little, between frames: faces until `budget` ms are spent. A
   * face costs about a millisecond, so a new cell is ready within a second or
   * so of walking into it, and until then it is simply not culled.
   */
  function work(budget = 1.5) {
    const start = performance.now();
    // The probe's draws are not the frame's: keep them off the stats overlay.
    const info = renderer.info.render;
    const counted = [info.calls, info.triangles, info.points, info.lines];
    try { measureFor(start, budget); } finally {
      [info.calls, info.triangles, info.points, info.lines] = counted;
    }
  }

  function measureFor(start, budget) {
    while (performance.now() - start < budget) {
      const r = step();
      if (r === WAIT) break;
      if (r) continue;
      // The neighbours next, so a cell is ready by the time the eye walks in.
      const c = state.cell;
      if (!c) break;
      let queued = false;
      for (let f = 0; f < 6 && !queued; f++) {
        if (!c.done || !c.apertures[f]) continue;
        const n = neighbour(c, f);
        if (!n.done) { queue.push(n); queued = true; }
      }
      if (!queued) break;
    }
  }

  /** Measure the eye's cell (and wait for it), for benchmarks and probes. */
  function settle() {
    const at = locate(camera.position);
    const cell = cellAt(at.level, at.x, at.z, true);
    for (let round = 0; round < 64; round++) {
      while (step(true));
      if (!eyeInside(cell, camera.position)) break;
      camera.updateMatrixWorld();
      view.copy(camera.matrixWorld).invert();
      proj = camera.projectionMatrix.elements;
      near = camera.near;
      windowsFor(cell);
      if (!queue.some((c) => !c.done)) break;
    }
    return cell;
  }

  /**
   * The zone this measured is going (main.js crossTo): the probe's target and
   * material, the sensor in the scene, and every stand-in built to measure
   * against. A measurement belongs to the walls it was taken against, so the
   * next zone gets a visibility of its own rather than this one emptied.
   */
  function dispose() {
    showAll();
    hiddenNow.length = 0;
    scene.remove(sensor);
    sensor.geometry.dispose();
    sensor.material.dispose();
    for (const cell of cells.values()) if (cell.job) for (const proxy of cell.job.owned) proxy.dispose();
    for (const geometry of pieces) geometry.dispose();
    pieces.length = 0;
    target.dispose();
    distance.dispose();
    cells.clear();
    queue.length = 0;
    instanced.length = 0;
    instancedBy.clear();
    grid = null;
  }

  return { begin, end, work, settle, state, cells, instanced, sensor, dispose, measure: (level, x, z) => {
    const cell = cellAt(level, x, z, true);
    while (!cell.done) step(true);
    return cell;
  } };
}
