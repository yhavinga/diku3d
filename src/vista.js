/**
 * The neighbouring zones, seen from the drawn one (see vistaplan.js for
 * where and which rooms).
 *
 * A vista is built by build.js itself, over the neighbour's own layout cut
 * down to the rooms near the crossing: the same walls, roofs, frontage and
 * trees that zone gets when it is drawn, so walking through the gate arrives
 * in what was seen through it. What it does not get is everything that
 * makes a zone a place you are in: no ground plane (the drawn zone's runs
 * under it), no skyline, grass or mist, no lights, no figures, and nothing
 * that registers -- no rooms, colliders, portals, doors or minimap cells.
 * It is scenery hung in the scene beside the zone and taken down with it.
 *
 * Built after the zone is up, a slice at a time between frames, nearest
 * crossing first: a crossing's card does not wait for it. Every mesh is
 * named `horizon-vista ...`, which keeps it out of the GTAO prepass the way
 * the skyline is kept out (render.js): at 30 m and more the occlusion is a
 * few texels, and a far surface in that pass is the screen-fixed mottle the
 * hills used to swim under.
 */

import * as THREE from 'three';
import { DIR_STEP, SECTOR } from './are.js';
import { raise, hash3, CELL, LEVEL_H } from './build.js';
import { openAirIn, sectorOf } from './shells.js';
import { InstanceBatch, StaticBatches } from './assets.js';
import { plantTrees } from './actors.js';
import { vistaSites, planVista, cutLayout, vistaCells } from './vistaplan.js';

/** Milliseconds of building per frame, at most -- give or take one room. */
const BUDGET_MS = 6;

/**
 * Models a vista leaves out: what is too small to read from past a gate, or
 * stands inside a building nobody can look into from there. Trees, houses,
 * walls, hedges, rock and the gates themselves stay.
 */
const SMALL = new Set(['fern', 'salal_bush', 'grass_tuft', 'nettles', 'tall_weeds', 'tussock', 'bramble', 'herb_pots',
  'crate', 'barrel', 'barrel_stack', 'sack', 'bucket', 'broom', 'rope_coil', 'firewood_pile', 'planks_pile', 'debris',
  'cartwheel', 'cushions', 'rug', 'figurine_dragons', 'crow', 'torch_sconce', 'lantern', 'wall_lantern', 'stacked_crates',
  'water_butt', 'hitch_line', 'handcart', 'bone_pile', 'refuse_heap', 'fungus_cluster', 'reed_clump', 'shire_flowerbed',
  'shire_window_box', 'sewer_sconce', 'candle']);
/**
 * Rock that does not stand on the ground. A cave room's cap (build.js
 * `buildMassif`) sits on its ceiling and is held up by the blocks of
 * mountain round it; a vista drops the blocks that would stand on the drawn
 * zone's ground, and the cap was left hanging over Moria's hills with sky
 * under it. Nothing in a vista may float, so rock whose foot is above its
 * level's floor is not placed.
 */
const ROCK = /^(massif_|cave_|moss_rock|rubble|stalag|stalac)/;
const ALOFT = 0.5;
const dropModel = (name, at) => SMALL.has(name) || /^(furn_|clutter_|weapon_|shield_|beast_|person_)/.test(name)
  || (ROCK.test(name) && !!at && at.y - Math.floor((at.y + ALOFT) / LEVEL_H) * LEVEL_H > ALOFT);

const HOUSES = ['house_a', 'house_b', 'house_c', 'house_stone_a', 'house_stone_b'];
/** Models front -Z; the turn that fronts one towards direction d (build.js's FACE_ROT). */
const FACE = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

/**
 * UVs projected off the dominant axis and the attributes every world
 * material reads, as build.js's Batcher writes them: the textures meet the
 * vista's own built surfaces at the same scale.
 */
function worldUv(geometry, material) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  g.computeVertexNormals();
  const pos = g.attributes.position; const nor = g.attributes.normal;
  const scale = material.userData.uvScale ?? 1;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)); const ny = Math.abs(nor.getY(i)); const nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
    if (ny >= nx && ny >= nz) { uv[i * 2] = x * scale; uv[i * 2 + 1] = z * scale; }
    else if (nx >= nz) { uv[i * 2] = z * scale; uv[i * 2 + 1] = y * scale; }
    else { uv[i * 2] = x * scale; uv[i * 2 + 1] = y * scale; }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
  g.setAttribute('aIndoor', new THREE.BufferAttribute(new Float32Array(pos.count), 1));
  return g;
}

export function createVistas({ world, plan, layoutOf, viewOf }) {
  // The baked surfaces and the model library: there once the boot has made
  // them, which is after the first zone's vistas are planned (`use`).
  let materials = null;
  let assets = null;
  let group = null;
  let generation = 0;
  const openAir = new Map();
  const openAirOf = (zone) => {
    if (!openAir.has(zone.id)) openAir.set(zone.id, openAirIn(viewOf(zone)));
    return openAir.get(zone.id);
  };
  const state = { sites: [], built: [], pending: 0, ms: 0, triangles: 0 };

  /**
   * The drawn zone's vistas, planned before it is built: each neighbour laid
   * out (cached by main.js, so the way back costs nothing) and cut to what
   * is seen. `vistaCells` of these is what `buildScene` must leave clear.
   */
  function planFor(zone, layout) {
    const taken = new Set();
    const plans = [];
    // The ones right past their gates first: a vista set out along a lane
    // takes what ground those leave, never the other way round.
    const sites = vistaSites(world, plan, layout, zone, openAirOf);
    sites.sort((a, b) => a.bridge.length - b.bridge.length);
    for (const site of sites) {
      // A site whose arrival room lands on an earlier vista's ground is left
      // to that one.
      if (taken.has(`${site.at.level}:${site.at.x},${site.at.z}`)) continue;
      const vista = planVista(site, layoutOf(plan.byId.get(site.zone)), taken);
      for (const k of vistaCells([vista])) taken.add(k);
      plans.push(vista);
    }
    return plans;
  }

  /**
   * One vista, as a generator of build.js's own progress: the neighbour laid
   * out (cached by main.js), cut to its near rooms, raised, its trees
   * planted, and the lot turned and moved to where the crossing leads.
   */
  function* buildOne(vista) {
    const t0 = performance.now();
    const site = vista;
    const cut = cutLayout(vista.layout, vista.near);
    // The arrival room's own gate back to the drawn zone opens at the back
    // too: through it lies the bridge, and the gate you are looking from.
    const [bx, , bz] = DIR_STEP[(vista.side - vista.turns + 6) % 4];
    const s0 = vista.start;
    const built = yield* raise(viewOf(plan.byId.get(site.zone)), cut, materials, assets, {
      vista: { keep: vista.keepFrontage, dropModel },
      clear: new Set([`${s0.level}:${s0.x + bx},${s0.z + bz}`]),
    });
    const root = built.group;
    root.name = `vista ${site.zone} #${site.arrive}`;
    // Trees are the actors' to plant in a drawn zone (actors.js); here they
    // are the vista's, the same species at the same spots.
    const trees = built.decor.filter((d) => d.kind === 'tree');
    yield 0.9;
    // Past the rooms built for real, the rest of the neighbour as far as
    // VISTA_FAR_M, in outline: see `farScenery`.
    const far = farScenery(vista, openAirOf(plan.byId.get(site.zone)));
    trees.push(...far.trees);
    const instances = assets ? new InstanceBatch(assets) : null;
    if (instances) {
      plantTrees(trees, instances, (names, seed = 0) => assets.choose(names, seed));
      for (const h of far.houses) instances.add(h.name, h, 'far');
    }
    if (instances) instances.finish(root);
    // The bridge's paving and the far mounds as the rest of the world is
    // drawn -- a batch, not a plain mesh, whose program would be a variant
    // nothing has compiled.
    const extra = new StaticBatches();
    for (const [name, geometry] of far.pieces) extra.addStatic('vista', materials[name], geometry);
    // The cell between the gate and the arrival room, paved as the arrival
    // room is: neither zone builds on it (`bridgeCells`).
    const arriveInfo = built.rooms.get(site.arrive);
    if (arriveInfo && arriveInfo.materials && materials[arriveInfo.materials.floor]) {
      for (const piece of bridge(vista, arriveInfo.materials.floor)) extra.addStatic('vista', materials[arriveInfo.materials.floor], piece);
    }
    extra.finish(() => root);
    // Where the neighbour's grid goes: its arrival cell onto the site, turned
    // so the way the crossing runs is the way the gate faces.
    const s = vista.start;
    const theta = -site.turns * Math.PI / 2;
    const local = new THREE.Vector3(s.x * CELL, s.level * LEVEL_H, s.z * CELL).applyAxisAngle(new THREE.Vector3(0, 1, 0), theta);
    root.rotation.y = theta;
    root.position.set(site.at.x * CELL - local.x, site.at.level * LEVEL_H - local.y, site.at.z * CELL - local.z);
    let triangles = 0;
    root.traverse((o) => {
      // Out of the AO prepass, like the skyline (render.js matches the name).
      if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh) o.name = `horizon-vista ${o.name}`;
      // Lights and the sun's frustum: nothing out here lights or is a light.
      if (o.isLight) o.visible = false;
      if (o.geometry?.attributes?.position && (o.isMesh || o.isInstancedMesh)) {
        triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * (o.count || 1);
      }
    });
    root.updateMatrixWorld(true);
    return { site, vista, root, rooms: vista.near.size, far: vista.far.length, ms: performance.now() - t0, triangles };
  }

  /**
   * The neighbour's further rooms as what they would look like from a few
   * hundred metres: a forest room is its trees (which the impostors draw as
   * cards out there), a street the houses either side of it, a hill a
   * grassed mound and a mountain a crag. The rooms' own words are not read --
   * at this range the sector is what shows. Placed by the room's cell in the
   * neighbour's grid, so they stand where that zone has them.
   */
  function farScenery(vista, openAir) {
    const trees = []; const houses = []; const pieces = [];
    for (const cell of vista.far) {
      const room = cell.room;
      const x = cell.x * CELL; const y = cell.level * LEVEL_H; const z = cell.z * CELL;
      const h = (k) => hash3(cell.x, cell.z, cell.level + k, 9137);
      const sector = sectorOf(room);
      if (sector === SECTOR.FOREST && openAir(room)) {
        for (let i = 0; i < 6; i++) {
          trees.push({ kind: 'tree', conifer: true, x: x + (h(i) - 0.5) * CELL * 0.85, y, z: z + (h(i + 8) - 0.5) * CELL * 0.85, scale: 0.8 + h(i + 16) * 0.7 });
        }
      } else if (sector === SECTOR.FIELD && openAir(room)) {
        if (h(1) < 0.5) trees.push({ kind: 'tree', x: x + (h(2) - 0.5) * CELL, y, z: z + (h(3) - 0.5) * CELL, scale: 0.8 + h(4) * 0.5 });
      } else if (sector === SECTOR.CITY && openAir(room)) {
        // A house on two of the street's four sides, its front to the street.
        for (let d = 0; d < 4; d++) {
          if (room.exits[d] || h(10 + d) < 0.45) continue;
          const [dx, , dz] = DIR_STEP[d];
          const name = HOUSES[Math.floor(h(20 + d) * HOUSES.length)];
          houses.push({ name, x: x + dx * CELL * 0.62, y, z: z + dz * CELL * 0.62, rotY: FACE[(d + 2) % 4] });
        }
      } else if (sector === SECTOR.HILLS || sector === SECTOR.MOUNTAIN) {
        const material = sector === SECTOR.MOUNTAIN ? 'crag' : 'grass';
        if (!materials[material]) continue;
        const r = CELL * (0.55 + h(5) * 0.25);
        const tall = sector === SECTOR.MOUNTAIN ? 9 + h(6) * 12 : 3 + h(6) * 4;
        const geometry = new THREE.SphereGeometry(r, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
        geometry.scale(1, tall / r, 1);
        geometry.translate(x + (h(7) - 0.5) * 3, y - 0.4, z + (h(8) - 0.5) * 3);
        pieces.push([material, worldUv(geometry, materials[material])]);
      }
    }
    return { trees, houses, pieces };
  }

  /**
   * The paving between the gate and the arrival room, in the neighbour's own
   * grid so it joins that room's floor: one plane per cell of the lane.
   */
  function bridge(vista, floor) {
    const material = materials[floor];
    // The gate's facing, in the neighbour's grid: back from the arrival room towards it.
    const back = (vista.side - vista.turns + 6) % 4;
    const [bx, , bz] = DIR_STEP[back];
    const s = vista.start;
    const y = s.level * LEVEL_H;
    return vista.bridge.map((b) => {
      const geometry = new THREE.PlaneGeometry(CELL, CELL, 4, 4);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate((s.x + bx * b.back) * CELL, y, (s.z + bz * b.back) * CELL);
      return worldUv(geometry, material);
    });
  }

  /**
   * Build the drawn zone's vistas, nearest `eye` first, `BUDGET_MS` a frame,
   * and hang them in `scene` together; `onReady` then has cull.js and the
   * impostors take them in. Resolves with them, or null if the zone went first.
   */
  async function mount(scene, sites, eye, { prepare = null, onReady = null } = {}) {
    const mine = ++generation;
    group = new THREE.Group();
    group.name = 'vistas';
    state.sites = sites;
    state.built = [];
    state.pending = sites.length;
    state.ms = 0;
    state.triangles = 0;
    const distance = (site) => Math.hypot(site.at.x * CELL - eye.x, site.at.z * CELL - eye.z);
    const order = [...sites].sort((a, b) => distance(a) - distance(b));
    const parent = group;
    for (const site of order) {
      const steps = buildOne(site);
      let result = null;
      for (;;) {
        const t = performance.now();
        let next;
        do next = steps.next(); while (!next.done && performance.now() - t < BUDGET_MS);
        if (next.done) { result = next.value; break; }
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        if (mine !== generation) return null;
      }
      if (mine !== generation) return null;
      parent.add(result.root);
      state.built.push(result);
      state.pending--;
      state.ms += result.ms;
      state.triangles += result.triangles;
    }
    // Their programs compiled off the frame, then all hung at once, so the
    // culling and the tree cards take them in in one go.
    if (prepare) await prepare(parent);
    if (mine !== generation) return null;
    scene.add(parent);
    onReady?.(state.built);
    return state.built;
  }

  /** Stop building, and hand back the group to be taken apart with the zone. */
  function release() {
    generation++;
    const old = group;
    group = null;
    state.built = [];
    state.sites = [];
    state.pending = 0;
    return old;
  }

  return {
    planFor, cellsOf: vistaCells, mount, release, state,
    use(library) { ({ materials, assets } = library); },
    get group() { return group; },
  };
}
