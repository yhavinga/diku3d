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

const cellKey = (level, x, z) => `${level}:${x},${z}`;

export function createVisibility({ renderer, scene, camera, world, sun, zones = null, sky = [] }) {
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
    stats: { measured: 0, culled: 0, instances: 0, instancesKept: 0 },
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

  /** Every texel of the last cube as (direction, distance), handed to `each`. */
  function forEachRay(faces, each) {
    for (let f = 0; f < 6; f++) {
      const m = faces[f];
      for (let j = 0; j < RES; j++) {
        for (let i = 0; i < RES; i++) {
          const raw = readback[(j * RES * 6 + f * RES + i) * 4];
          const t = raw >= REACH * 0.999 ? Infinity : raw;
          _d.copy(rays[j * RES + i]).transformDirection(m);
          each(_d, t);
        }
      }
    }
  }

  /** Where a ray from `o` along `d` leaves `box` (o inside), as a distance. */
  function exitOf(o, d, box) {
    let t = Infinity;
    for (let a = 0; a < 3; a++) {
      const v = d.getComponent(a);
      if (Math.abs(v) < 1e-9) continue;
      const bound = v > 0 ? box.max.getComponent(a) : box.min.getComponent(a);
      t = Math.min(t, (bound - o.getComponent(a)) / v);
    }
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
    let k = 0;
    forEachRay(faces, (d, t) => {
      seen[k++] = Math.min(65535, Math.round(t * 100));
      if (t >= exitOf(centre, d, grown)) return;
      let f = 0; let best = 0;
      for (let q = 0; q < 6; q++) {
        const v = d.getComponent(FACE_AXIS[q]) * FACE_SIGN[q];
        if (v > best) { best = v; f = q; }
      }
      if (best < 0.9) return;
      reach[f].push(t * best);
    });
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
    forEachRay(faces, (d, t) => {
      const out = exitOf(eye, d, grown);
      if (t < out) return;
      const exit = exitOf(eye, d, cell.box);
      // From the inner face at the latest, and never less than a slab deep:
      // a cave's mouth is not a hole in a plane, and the box has to hold it.
      const from = Math.max(0, Math.min(exitOf(eye, d, cell.inside), exit - DEPTH_OF_APERTURE));
      const f = faceOf(eye, d, cell.box, exit);
      let box = cell.apertures[f];
      if (!box) { box = new THREE.Box3(); cell.apertures[f] = box; }
      box.expandByPoint(_p.copy(eye).addScaledVector(d, from));
      box.expandByPoint(_p.copy(eye).addScaledVector(d, exit));
      if (t < exitOf(eye, d, pairBox(cell, f).expandByScalar(SLACK))) return;
      if (cell.overflow[f]) return;
      let list = cell.escapes[f];
      if (!list || list.n * 6 >= list.data.length) {
        if (list && list.data.length >= ESCAPES * 6) { cell.overflow[f] = true; cell.escapes[f] = null; return; }
        const data = new Float32Array(Math.min(ESCAPES, list ? list.data.length / 3 : 256) * 6);
        if (list) data.set(list.data);
        list = cell.escapes[f] = { data, n: list ? list.n : 0 };
      }
      list.data.set([eye.x, eye.y, eye.z, d.x, d.y, d.z], list.n * 6);
      list.n++;
    });
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
   * to do. A cell is 11 cubes of 6 faces, each face a small draw; spread over
   * frames by `work`, which keeps to a budget.
   */
  function step() {
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
    job.faces[job.face] = renderFace(job.scene, eye, job.face);
    if (++job.face < 6) return true;
    renderer.readRenderTargetPixels(target, 0, 0, RES * 6, RES, readback);
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
  function sphereVisible(x, y, z, r) {
    const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const depth = -vz;
    if (depth + r < near) return false;
    if (depth - r > farPlane) return false;
    let x0 = -1; let y0 = -1; let x1 = 1; let y1 = 1;
    if (depth - r > near) {
      const dn = depth - r; const df = depth + r;
      x0 = proj[0] * Math.min((vx - r) / dn, (vx - r) / df);
      x1 = proj[0] * Math.max((vx + r) / dn, (vx + r) / df);
      y0 = proj[5] * Math.min((vy - r) / dn, (vy - r) / df);
      y1 = proj[5] * Math.max((vy + r) / dn, (vy + r) / df);
      if (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return false;
    }
    if (!state.active) return true;
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
  let farPlane = 900;

  const _sphere = new THREE.Sphere();
  function objectWithin(o, test) {
    const g = o.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    _sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    return test(_sphere.center.x, _sphere.center.y, _sphere.center.z, _sphere.radius);
  }

  function objectVisible(o) {
    const g = o.geometry;
    if (o.isSkinnedMesh) {
      // A figure's bind-pose sphere, grown for arms and a weapon in the air.
      if (!g.boundingSphere) g.computeBoundingSphere();
      _sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
      return sphereVisible(_sphere.center.x, _sphere.center.y, _sphere.center.z, _sphere.radius * 1.5 + 0.5);
    }
    const bounds = o.isInstancedMesh || o.isBatchedMesh ? o.boundingSphere : null;
    if (bounds) _sphere.copy(bounds).applyMatrix4(o.matrixWorld);
    else {
      if (!g.boundingSphere) g.computeBoundingSphere();
      _sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    }
    return sphereVisible(_sphere.center.x, _sphere.center.y, _sphere.center.z, _sphere.radius);
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
      const spheres = new Float32Array(n * 4);
      const buckets = new Map();
      o.updateWorldMatrix(true, false);
      for (let i = 0; i < n; i++) {
        o.getMatrixAt(i, m);
        m.premultiply(o.matrixWorld);
        _sphere.copy(local).applyMatrix4(m);
        spheres.set([_sphere.center.x, _sphere.center.y, _sphere.center.z, _sphere.radius], i * 4);
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
      const entry = {
        mesh: o, total: n, spheres, buckets: list,
        source: o.instanceMatrix.array.slice(),
        kept: new Int32Array(n), keptCount: n, full: true,
      };
      instanced.push(entry);
      instancedBy.set(o, entry);
    });
  }

  const shadowFrustum = new THREE.Frustum();
  const _m = new THREE.Matrix4();

  const seenOrCast = (x, y, z, r) => sphereVisible(x, y, z, r)
    || shadowFrustum.intersectsSphere(_sphere.set(_v.set(x, y, z), r));

  /** Keep the instances `keep(x, y, z, r)` accepts, in their original order. */
  function compact(entry, keep) {
    const { spheres, kept } = entry;
    let n = 0;
    for (const b of entry.buckets) {
      const s = b.sphere;
      if (!keep(s.center.x, s.center.y, s.center.z, s.radius)) continue;
      for (const i of b.ids) {
        const o = i * 4;
        if (keep(spheres[o], spheres[o + 1], spheres[o + 2], spheres[o + 3])) kept[n++] = i;
      }
    }
    // Draw order is kept: the ids went in bucket by bucket, so sort them back.
    const ids = kept.subarray(0, n);
    ids.sort();
    const mesh = entry.mesh;
    let same = !entry.full && n === entry.keptCount;
    if (same && entry.last) for (let k = 0; k < n && same; k++) same = entry.last[k] === ids[k];
    if (!same) {
      const out = mesh.instanceMatrix.array;
      for (let k = 0; k < n; k++) out.set(entry.source.subarray(ids[k] * 16, ids[k] * 16 + 16), k * 16);
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
      mesh.instanceMatrix.needsUpdate = true;
      entry.last = Int32Array.from(ids);
      entry.keptCount = n;
      entry.full = false;
    }
    state.stats.instances += entry.total;
    state.stats.instancesKept += n;
    return n;
  }

  function restoreInstances(entry) {
    if (entry.full) return;
    const mesh = entry.mesh;
    mesh.instanceMatrix.array.set(entry.source);
    mesh.count = entry.total;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.needsUpdate = true;
    entry.full = true;
    entry.last = null;
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

  let indexed = false;
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
    if (!state.enabled) {
      state.active = false;
      for (const entry of instanced) restoreInstances(entry);
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

    const at = locate(camera.position);
    const cell = cellAt(at.level, at.x, at.z, true);
    state.cell = cell;
    state.active = eyeInside(cell, camera.position);
    state.windows = state.active ? windowsFor(cell) : [];
    state.stamp++;

    if (shadow) {
      sun.updateMatrixWorld();
      sun.target.updateMatrixWorld();
      sun.shadow.updateMatrices(sun);
      shadowFrustum.setFromProjectionMatrix(_m.multiplyMatrices(sun.shadow.camera.projectionMatrix, sun.shadow.camera.matrixWorldInverse));
    }
    for (const entry of instanced) {
      if (!entry.mesh.visible) continue;
      if (state.debugNoCompact) { restoreInstances(entry); continue; }
      compact(entry, shadow ? seenOrCast : sphereVisible);
    }

    // Whole objects. A region's batch or instanced mesh with nothing left in
    // view is hidden whatever the walls, since three would still bind it and
    // issue an empty draw; anything else only where there are walls.
    candidates.length = 0;
    collectCullable(scene, candidates);
    for (const o of candidates) {
      if (o.isInstancedMesh && o.userData.cullable) {
        if (o.count === 0) hiddenNow.push(o);
      } else if (o.isBatchedMesh && o.anyVisible) {
        if (!o.anyVisible(sphereVisible)) hiddenNow.push(o);
      } else if (state.active && !objectVisible(o)) {
        hiddenNow.push(o);
      }
    }
    state.stats.culled = hiddenNow.length;
    if (state.debugNoHide) hiddenNow.length = 0;
    if (hiddenNow.length) hideAll();

    cullHook.camera = camera;
    cullHook.stamp = state.stamp;
    cullHook.test = state.active ? sphereVisible : null;
  }

  /** After the frame: put back what was hidden, so nothing else ever sees it. */
  function end() {
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
    while (performance.now() - start < budget) {
      if (step()) continue;
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
      while (step());
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

  return { begin, end, work, settle, state, cells, instanced, sensor, measure: (level, x, z) => {
    const cell = cellAt(level, x, z, true);
    while (!cell.done) step();
    return cell;
  } };
}
