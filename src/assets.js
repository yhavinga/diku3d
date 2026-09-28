/**
 * The bridge between the modelled assets and the world builder.
 *
 * Blender gives us geometry only: each object carries a material named
 * `MAT:timber`, `MAT:rooftile` and so on, and here that tag is swapped for the
 * baked procedural material of the same name. Blender owns silhouettes, bevels
 * and clean normals; textures.js keeps owning surfaces. Nothing in the viewer
 * depends on an asset existing -- anything missing falls back to the procedural
 * geometry that was there before, so a half-finished library still runs.
 *
 * Everything is placed as instances, batched per chunk so a town of a hundred
 * houses stays a handful of draw calls and still frustum-culls.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { interiorGlass, markPanes } from './windows.js';

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * The people's files carry their vertex colour as a custom attribute, `_COL`
 * (three lowercases it), because Blender's exporter writes the true colour
 * only into a mesh's first primitive and white into the rest -- see
 * people.py. Handed back to three under the name its materials read.
 */
function takeColour(geometry) {
  const colour = geometry.getAttribute('_col');
  if (!colour) return;
  geometry.setAttribute('color', colour);
  geometry.deleteAttribute('_col');
}

/**
 * Tags the models use that the texture baker has no recipe for. Two kinds here:
 * an alias, where an existing baked surface is genuinely the right one, and a
 * plain PBR value for the small things that read better flat.
 *
 * `cloth` and `skin` are NOT in this table's reach any more: both grew real
 * recipes in textures.js, and `materialFor` finds a baked surface first --
 * their entries below are dead the moment the recipes exist. They stay as the
 * fallback for a build without those recipes, nothing else.
 */
// `oak` used to alias to `planks`. That is floorboards on a 2.4 m tile, and the
// things tagged oak are a shoe, a sole, a belt and a head of hair -- 25 cm
// objects wearing a tenth of a floorboard, which is the wood grain that was
// reported smeared across every townsperson's feet. Solid oak at this size has
// no board and no seam: close grain and nothing else.
// `leaves` had an alias to `grass` here, and it put the lawn on every tree
// crown in the world -- confirmed by a judge with matching material uuids at
// 50 m and 3.7 m. It is a real recipe now, so materialFor finds it first and
// this table no longer needs an entry for it.
// cloth2 and linen are a second and a third garment on one person -- hose
// under a tunic, an apron over it -- in the same woven surface, so they are
// the cloth recipe under another name and take their own tint. Snake scales
// are the feather surface: rows of overlapping scallops is what both of them
// are, and at the size either is seen the two read the same.
// Wool is the cloth recipe under its own tint; plate is worked steel.
const TAG_ALIASES = { cloth2: 'cloth', linen: 'cloth', wool: 'cloth', plate: 'steel', scales: 'feather' };
// (linen and wool have recipes of their own now; the aliases are the fallback.)
const TAG_MATERIALS = {
  cloth: { color: 0x6b4a42, roughness: 0.95, metalness: 0 },
  skin: { color: 0xc79b76, roughness: 0.72, metalness: 0 },
  oak: { color: 0x5a4330, roughness: 0.78, metalness: 0 },
  leather: { color: 0x4a3524, roughness: 0.62, metalness: 0 },
  hair: { color: 0x3a2a1c, roughness: 0.86, metalness: 0 },
  // An iris is small, dark and wet: the glint off it is what reads as a
  // person looking at you. Not black -- nothing lit is.
  eye: { color: 0x1a1410, roughness: 0.22, metalness: 0 },
  // Off-white and not bright: a full white sclera at four pixels is a doll's.
  // The iris, pupil and limbus are in the eyeball's vertex colour now, on
  // rings round its pole; this is the wet surface over all of it, glossy
  // enough to hold a highlight.
  eyewhite: { color: 0xffffff, roughness: 0.14, metalness: 0 },
  bone: { color: 0xcfc4a6, roughness: 0.78, metalness: 0 },
  // A noblewoman's gown: dyed to whatever she is, and with the soft sheen
  // along the folds that tells velvet from the wool beside it.
  velvet: { color: 0xffffff, roughness: 0.52, metalness: 0 },
  // Gilt: a cleric's holy symbol. Bright on purpose -- it has to read at
  // twenty metres against a robe.
  gold: { color: 0xd4a64a, roughness: 0.32, metalness: 0.9 },
  // Keratin and wet tissue on the animals: eyes, noses, hooves, claws, beaks,
  // horns and the inside of a mouth. White, because every part carries its
  // own colour in the vertex colours; glossy, because that is the difference
  // between an eye and a painted dot.
  horn: { color: 0xffffff, roughness: 0.34, metalness: 0 },
  glass: {
    color: 0xd8c48a, roughness: 0.12, metalness: 0,
    transparent: true, opacity: 0.55, emissive: 0x000000,
  },
  // The glass in a house's windows, as against a lantern's: dark, because
  // what a window shows is the room behind it (windows.js) and the sky it
  // mirrors, and the pale lantern glass laid on a facade read by day as a
  // cream panel and by night as a flat lit one.
  windowpane: {
    color: 0x151a21, roughness: 0.08, metalness: 0.25, envMapIntensity: 1.1,
    emissive: 0x000000,
  },
};
/** Tags whose flat material wants the shared grain, at this strength. */
const GRAINED = { cloth: 0.5, skin: 0.22, oak: 0.35, leather: 0.45, hair: 0.6, bone: 0.5, velvet: 0.3 };

export class AssetLibrary {
  constructor(materials, baseUrl = 'assets') {
    this.materials = materials;
    this.baseUrl = baseUrl;
    this.assets = new Map();
    this.missing = new Set();
    this.extra = new Map();
    this.unknownTags = new Set();
    this.loader = new GLTFLoader();
  }

  /**
   * The material a `MAT:` tag should wear: the baked surface of that name, an
   * alias where one stands in honestly, or a flat PBR material made here. An
   * unrecognised tag is recorded rather than silently dressed as stone.
   */
  materialFor(tag) {
    if (this.materials[tag]) return this.materials[tag];
    if (tag === 'glow') return this.glow();
    const alias = TAG_ALIASES[tag];
    if (alias && this.materials[alias]) return this.materials[alias];
    if (this.extra.has(tag)) return this.extra.get(tag);
    const recipe = TAG_MATERIALS[tag];
    if (recipe) {
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, ...recipe });
      material.name = tag;
      // After dark the panes on the models show a room behind them, and a
      // share of them an empty one: this glass has no per-house choice made.
      if (tag === 'windowpane') interiorGlass(material, { allowDark: true, day: 'hour', opaque: true });
      material.userData.uvScale = 1;
      // Flat does not have to mean featureless. Cloth and skin are tinted per
      // person and would look wrong wearing a stone pattern, but with no map
      // at all they are the only surfaces in the frame that catch the light
      // evenly everywhere, which is what makes a figure read as a mannequin
      // next to a wall that has real relief. The shared grain, weakly, is
      // enough to break that up: weave on cloth, pores on skin.
      const grain = this.materials.$grain;
      const strength = GRAINED[tag];
      if (grain && strength) {
        material.normalMap = grain;
        material.normalScale = new THREE.Vector2(strength, strength);
      }
      this.extra.set(tag, material);
      return material;
    }
    this.unknownTags.add(tag);
    return this.materials.stonewall;
  }

  /**
   * What burns on a creature: a basilisk's eyes, the sockets of a dracolich,
   * the ball of a will-o-wisp. Unlit, because a light source is not lit by
   * anything, and above 1 so the bloom picks it up -- the colour is the
   * vertices', which the viewer paints per mobile.
   */
  glow() {
    if (!this.extra.has('glow')) {
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(2.6, 2.6, 2.6) });
      material.name = 'glow';
      material.userData.uvScale = 1;
      this.extra.set('glow', material);
    }
    return this.extra.get('glow');
  }

  /**
   * The glass on the models is one material over every pane in town, so it
   * cannot be lit house by house the way the procedural windows are. It still
   * has to know what hour it is: by day a pane shows the sky, and after dark it
   * shows whatever is burning inside. Left at emissive 0x000000 -- which it was
   * -- eighty-five panes are a tan panel that never lights, and a town at night
   * has not one window on.
   */
  setWindowLight(colourHex, intensity) {
    for (const tag of ['glass', 'windowpane']) {
      const glass = this.extra.get(tag);
      if (!glass) continue;
      glass.emissive.setHex(colourHex);
      glass.emissiveIntensity = Math.max(0, intensity);
    }
  }

  /**
   * Load what exists and shrug at what doesn't: a missing asset is a fallback,
   * not an error, so the viewer runs against a library that is still being made.
   */
  async load(names, onProgress = () => {}) {
    let done = 0;
    await Promise.all(names.map(async (name) => {
      try {
        const gltf = await this.loader.loadAsync(`${this.baseUrl}/${name}.glb`);
        this.assets.set(name, this.digest(name, gltf));
      } catch {
        this.missing.add(name);
      }
      onProgress(++done / names.length, name);
    }));
    return this;
  }

  has(name) {
    return this.assets.has(name);
  }

  get(name) {
    return this.assets.get(name);
  }

  /**
   * Pick whichever of these variants exists, by a stable hash. The seed
   * defaults because callers asking "is there one of these at all?" pass no
   * seed, and `undefined * n` is NaN, which indexes nothing.
   */
  choose(names, seed = 0) {
    const available = names.filter((n) => this.assets.has(n));
    if (!available.length) return null;
    const index = Math.floor((Number.isFinite(seed) ? seed : 0) * available.length);
    return available[Math.min(available.length - 1, Math.max(0, index))];
  }

  /**
   * Flatten a loaded file into world-ready primitives: geometry baked into the
   * node's transform, UVs rescaled to the material they will actually wear, and
   * a white vertex colour so the shared vertexColors materials behave.
   */
  digest(name, gltf) {
    const primitives = [];
    const bounds = new THREE.Box3();
    const animations = gltf.animations || [];

    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      let materialName = tagOf(node.material);
      // Glass spanning more than a lantern is a window, and has a room
      // behind it; a lantern's four small panes keep the plain glow.
      if (materialName === 'glass') {
        node.geometry.computeBoundingBox();
        const size = node.geometry.boundingBox.getSize(new THREE.Vector3()).applyMatrix4(
          new THREE.Matrix4().extractRotation(node.matrixWorld));
        if (Math.max(Math.abs(size.x), Math.abs(size.z)) > 0.6) materialName = 'windowpane';
      }
      const material = this.materialFor(materialName);

      takeColour(node.geometry);
      const geometry = node.geometry.clone();
      geometry.applyMatrix4(node.matrixWorld);

      if (!geometry.attributes.color) {
        const count = geometry.attributes.position.count;
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3));
      }
      // Blender's cube projection is in metres. The baked materials want world
      // units over their tile size, and userData.uvScale is already 1/tile --
      // so this multiplies. Dividing tiles the texture tile-size-squared times
      // too often, which reads as a dark grid rather than as a wall.
      //
      // V is negated because glTF writes `v = 1 - v`, so out of Blender V runs
      // *down* a wall while build.js projects it *up*. The normal map's green
      // channel is a direction in that space, so leaving it flipped inverts the
      // relief on every model: mortar stands proud of its blocks, and a chamfer
      // that should fall into a joint climbs out of it instead. Negating rather
      // than taking 1-v keeps the tiling phase arbitrary, which it already is.
      const uvScale = material.userData.uvScale ?? 1;
      const uv = geometry.attributes.uv;
      if (uv) {
        for (let i = 0; i < uv.count; i++) {
          uv.setXY(i, uv.getX(i) * uvScale, -uv.getY(i) * uvScale);
        }
        uv.needsUpdate = true;
      } else {
        const count = geometry.attributes.position.count;
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      }
      // Glass samples no texture; its UVs carry where on its own pane each
      // vertex is, which is what the room behind it is laid out from.
      if (materialName === 'windowpane') markPanes(geometry);
      geometry.computeBoundingBox();
      bounds.union(geometry.boundingBox);
      primitives.push({ geometry, material, materialName, skinned: !!node.isSkinnedMesh });
    });

    // The skinned path never saw any of that. `buildModelledFigure` clones
    // `asset.scene` with SkeletonUtils, and a Mesh.clone *shares* geometry --
    // so every townsperson wore Blender's raw metre UVs (cloth tiling at
    // 1.00 m instead of 0.70, skin at 1.00 instead of 0.50) with V running
    // the wrong way, which inverts the relief on people relative to every
    // wall in town. Same treatment, in place, on the source scene; the
    // primitive clones above were taken first, so nothing is scaled twice.
    gltf.scene.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      const material = this.materialFor(tagOf(node.material));
      const uvScale = material.userData.uvScale ?? 1;
      const uv = node.geometry.attributes.uv;
      if (!uv) return;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * uvScale, -uv.getY(i) * uvScale);
      }
      uv.needsUpdate = true;
    });

    const size = new THREE.Vector3();
    bounds.getSize(size);
    return {
      name, primitives, bounds, size, animations,
      scene: gltf.scene,
      triangles: primitives.reduce((n, p) => n + p.geometry.attributes.position.count / 3, 0),
    };
  }

  /** How many world units tall the asset is, for fitting it to a cell. */
  height(name) {
    const asset = this.assets.get(name);
    return asset ? asset.size.y : 0;
  }

  footprint(name) {
    const asset = this.assets.get(name);
    return asset ? Math.max(asset.size.x, asset.size.z) : 0;
  }
}

// Clips are used as they come out of the file. There used to be an
// `uprightSwing()` here that conjugated every keyed quaternion by a quarter
// turn about Y, because `townsperson.py` keyed the walk on an axis that turned
// out to be the sideways one -- the legs scissored across the figure, 0.247 m
// across against 0.012 m along. That was a bone-roll bug, and it is fixed in
// the rig now (0.045 across against 0.266 along, measured on the exported
// clip). The compensation could never have been more than half a fix anyway: a
// glTF rotation track carries the bone's *whole* local rotation, rest included,
// so conjugating it also swung both shoulders a quarter turn about the spine --
// one arm in front of the chest and one behind it, 0.16 m out of the socket --
// and turned each foot a quarter turn off its leg. Those were reported as an
// arm slot and a detached foot, and they were this.

function tagOf(material) {
  if (!material) return 'stonewall';
  const list = Array.isArray(material) ? material : [material];
  const named = list.find((m) => m && typeof m.name === 'string' && m.name.startsWith('MAT:'));
  return named ? named.name.slice(4) : 'stonewall';
}

/**
 * Collects placements. `finish` hands them to a `StaticBatches`, which draws
 * them by region rather than by chunk.
 *
 * It used to be one InstancedMesh per chunk per model per primitive, and a
 * model carries four to six materials: 2,784 meshes over the world, 962 of
 * them holding a single instance, each drawn in the main pass, again in the
 * AO prepass and again in the shadow pass. Measured at the Shire barn facing
 * south, 1,252 of the 2,111 main-pass draws were these.
 */
export class InstanceBatch {
  constructor(library) {
    this.library = library;
    this.buckets = new Map();
  }

  /**
   * @param {string} name asset in the library
   * @param {object} transform {x,y,z, rotY, scale | scaleX/scaleY/scaleZ}
   * @param {string} chunk grouping key, usually the cell chunk
   * @param {object} swap tag -> tag, to wear another surface: the desert's
   *   sandstone crags stand over the troll den in grey rock
   */
  add(name, transform, chunk = '0', swap = null) {
    const asset = this.library.get(name);
    if (!asset) return false;
    const key = swap ? `${chunk}|${name}|${JSON.stringify(swap)}` : `${chunk}|${name}`;
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = { asset, chunk, swap, transforms: [] }; this.buckets.set(key, bucket); }
    bucket.transforms.push(transform);
    return true;
  }

  /**
   * `regionOf(chunk)` names the region a chunk is drawn in. Without one, a
   * placement's region is where it stands: a chunk like `trees` spans the
   * whole world, and one mesh for all of it is never off screen.
   */
  finish(parent, batches = null, regionOf = null) {
    const own = !batches;
    const target = batches || new StaticBatches();
    // What was placed where, as the InstancedMeshes `nav.addInstances` reads
    // to walk mobiles round the props. Never drawn: the group is invisible,
    // so the renderer does not even visit it.
    const placements = new THREE.Group();
    placements.name = 'placements';
    placements.visible = false;
    // Invisible still gets walked for its matrices every frame, and these are
    // never drawn: a record has nothing to update.
    placements.updateMatrixWorld = () => {};
    let triangles = 0;
    const placed = new Map(); // asset -> every matrix it was placed with
    for (const { asset, chunk, swap, transforms } of this.buckets.values()) {
      const byRegion = new Map();
      const matrices = transforms.map((t) => {
        _position.set(t.x, t.y, t.z);
        _quaternion.setFromAxisAngle(UP, t.rotY || 0);
        _scale.set(t.scaleX ?? t.scale ?? 1, t.scaleY ?? t.scale ?? 1, t.scaleZ ?? t.scale ?? 1);
        const matrix = new THREE.Matrix4().compose(_position, _quaternion, _scale);
        const region = regionOf ? regionOf(chunk)
          : `${chunk}@${Math.floor(t.x / REGION_METRES)},${Math.floor(t.z / REGION_METRES)}`;
        if (!byRegion.has(region)) byRegion.set(region, []);
        byRegion.get(region).push(matrix);
        return matrix;
      });
      const wear = (primitive) => (swap && swap[primitive.materialName]
        ? this.library.materialFor(swap[primitive.materialName]) : primitive.material);
      for (const [region, list] of byRegion) {
        for (const primitive of asset.primitives) target.add(region, wear(primitive), primitive.geometry, list);
      }
      for (const primitive of asset.primitives) {
        triangles += (primitive.geometry.attributes.position.count / 3) * matrices.length;
      }
      if (!placed.has(asset)) placed.set(asset, []);
      placed.get(asset).push(...matrices);
    }
    for (const [asset, matrices] of placed) {
      const record = new THREE.InstancedMesh(asset.primitives[0].geometry, asset.primitives[0].material, matrices.length);
      matrices.forEach((m, i) => record.setMatrixAt(i, m));
      placements.add(record);
    }
    parent.add(placements);
    const meshes = own ? target.finish(() => parent) : 0;
    return { meshes, triangles };
  }
}

// ------------------------------------------------------------ batching ----

/** A region's side, for placements that name no region of their own: 64 cells. */
const REGION_METRES = 832;

/**
 * How many copies of one primitive a region must hold before they are drawn
 * instanced. Below it they share a multi-draw with the region's other odd
 * pieces in that material.
 *
 * A multi-draw is one call from script but still one draw per piece
 * underneath, about half a microsecond apiece with this town's materials
 * (measured: 2,000 pieces cost 2.0 ms over two passes, the same 2,000 as one
 * instanced draw 0.5 ms). Every tree in the world as one batch cost 2.6 ms a
 * frame more than the same trees instanced, at the Shire barn facing south.
 * 4, 16 and 32 measured within noise of each other on frame time; 4 costs
 * about 300 more draws in a busy view and 32 puts up to 9,000 pieces under
 * the batches, so 16 is the middle of the three.
 */
const REPEAT = 16;

const BATCH_ATTRIBUTES = [['position', 3], ['normal', 3], ['uv', 2], ['color', 3], ['aIndoor', 1]];
const batchable = new WeakMap();
const _identity = new THREE.Matrix4();

/**
 * The one attribute set every geometry in a batch must share. The world's
 * materials read these five and nothing else; a model with no `aIndoor` is
 * out of doors, which is what WebGL's default attribute of 0 said before.
 */
function toBatchable(source) {
  const cached = batchable.get(source);
  if (cached) return cached;
  const count = source.attributes.position.count;
  const geometry = new THREE.BufferGeometry();
  for (const [name, size] of BATCH_ATTRIBUTES) {
    const from = source.getAttribute(name);
    const array = new Float32Array(count * size);
    if (from) {
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < size; c++) array[i * size + c] = from.getComponent(i, c);
      }
    } else if (name === 'normal') {
      throw new Error(`assets: a batched geometry has no normals (${count} vertices)`);
    } else if (name === 'color') {
      array.fill(1);
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  if (source.index) {
    geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(source.index.array), 1));
  } else {
    const index = new Uint32Array(count);
    for (let i = 0; i < count; i++) index[i] = i;
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }
  batchable.set(source, geometry);
  return geometry;
}

/**
 * A BatchedMesh that culls once per camera, not once per pass.
 *
 * Culling and sorting the pieces runs on the CPU before every draw of the
 * mesh, and the AO prepass draws the whole frame a second time from the very
 * same camera. The answer cannot have changed, so the second time it is
 * reused. The shadow pass has a camera of its own and culls for itself.
 */
export class StaticBatch extends THREE.BatchedMesh {
  constructor(...args) {
    super(...args);
    this._cullCamera = null;
    this._cullState = new Float64Array(32);
  }

  onBeforeRender(renderer, scene, camera, geometry, material, group) {
    const view = camera.matrixWorldInverse.elements;
    const projection = camera.projectionMatrix.elements;
    const state = this._cullState;
    if (this._cullCamera === camera && !this._visibilityChanged) {
      let same = true;
      for (let i = 0; i < 16 && same; i++) same = state[i] === view[i] && state[16 + i] === projection[i];
      if (same) return;
    }
    super.onBeforeRender(renderer, scene, camera, geometry, material, group);
    this._cullCamera = camera;
    for (let i = 0; i < 16; i++) { state[i] = view[i]; state[16 + i] = projection[i]; }
  }
}

/**
 * Everything static in the world, drawn by region and material.
 *
 * Per region and material there is at most: one merged mesh of the built
 * geometry (paving, walls, roofs -- already in world space), one instanced
 * mesh per model primitive that repeats (see REPEAT), and one multi-draw
 * batch of the pieces that do not, culled piece by piece. A region is several
 * chunks, which is the whole of the saving: the old chunks cost a draw per
 * material per model per 52 m.
 */
export class StaticBatches {
  constructor(repeat = REPEAT) {
    this.entries = new Map();
    this.repeat = repeat;
  }

  entry(region, material) {
    const key = `${region}|${material.uuid}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { region, material, shared: new Map(), built: [] };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** A model's primitive, placed once per matrix. */
  add(region, material, geometry, matrices) {
    const entry = this.entry(region, material);
    let slot = entry.shared.get(geometry);
    if (!slot) { slot = { geometry, matrices: [] }; entry.shared.set(geometry, slot); }
    slot.matrices.push(...matrices);
  }

  /** Geometry already in world space, drawn where it is. */
  addStatic(region, material, geometry) {
    this.entry(region, material).built.push(geometry);
  }

  /** `route(region)` names the parent a region's meshes go under. */
  finish(route) {
    let meshes = 0;
    const shade = (mesh, region) => {
      // Placed in world space and never moved: no matrix to recompose.
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      route(region).add(mesh);
      meshes++;
    };
    for (const { region, material, shared, built } of this.entries.values()) {
      const pieces = built.map((geometry) => ({ geometry: toBatchable(geometry), matrices: [_identity], own: true }));
      for (const slot of shared.values()) {
        if (slot.matrices.length < this.repeat) {
          pieces.push({ geometry: toBatchable(slot.geometry), matrices: slot.matrices });
          continue;
        }
        const mesh = new THREE.InstancedMesh(slot.geometry, material, slot.matrices.length);
        mesh.name = `instances ${region} ${material.name}`;
        slot.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.computeBoundingSphere();
        shade(mesh, region);
      }
      if (!pieces.length) continue;
      let vertices = 0; let indices = 0; let instances = 0;
      for (const { geometry, matrices } of pieces) {
        vertices += geometry.attributes.position.count;
        indices += geometry.index.count;
        instances += matrices.length;
      }
      const batch = new StaticBatch(instances, vertices, indices, material);
      batch.name = `batch ${region} ${material.name}`;
      for (const { geometry, matrices } of pieces) {
        const id = batch.addGeometry(geometry);
        for (const m of matrices) batch.setMatrixAt(batch.addInstance(id), m);
      }
      for (const piece of pieces) if (piece.own) piece.geometry.dispose();
      batch.computeBoundingBox();
      batch.computeBoundingSphere();
      // three sorts a material's draws by variant -- instanced, skinned,
      // plain -- so that each needs its program bound once, but it has no
      // variant for a batch, which then shares the plain meshes' and swaps
      // program with them back and forth down the depth order. Drawing the
      // opaque batches first keeps them together.
      if (!material.transparent) batch.renderOrder = -1;
      shade(batch, region);
    }
    this.entries.clear();
    return meshes;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** Everything the world builder will ask for, so one call loads the lot. */
export const ASSET_NAMES = [
  'house_a', 'house_b', 'house_c', 'house_stone_a', 'house_stone_b',
  // room kits: panels span a full 11.4 m wall and are placed on the wall line
  'temple_wall_solid', 'temple_wall_door', 'temple_corner', 'temple_roof',
  'temple_steps', 'temple_column',
  'wall_solid', 'wall_door', 'wall_corner', 'wall_roof',
  'temple', 'market_stall', 'well', 'fountain', 'lamp_post', 'hanging_sign', 'grate_leaf', 'wall_lantern',
  'signpost', 'stone_arch', 'portcullis', 'torch_sconce', 'chimney_pot',
  'door_leaf', 'door_round', 'log_cabin',
  'barrel', 'crate', 'sack', 'hay_bale', 'handcart', 'bench', 'trough',
  'stacked_crates', 'barrel_stack', 'firewood_pile', 'water_butt', 'bucket',
  'rope_coil', 'ladder', 'planks_pile', 'herb_pots', 'broom', 'cartwheel', 'nettles',
  'tree_oak', 'tree_pine', 'bush', 'grass_tuft',
  'tree_fir', 'tree_snag', 'fern', 'salal_bush', 'moss_rock',
  'reed_clump', 'tussock', 'dead_log',
  'headstone', 'grave_slab', 'iron_fence',
  // the sewer: tools/blender/sewer.py
  'sewer_tunnel', 'sewer_arm', 'sewer_hub', 'sewer_hub_end', 'sewer_chamber', 'sewer_chamber_air', 'sewer_shaft',
  'sewer_wall_open', 'sewer_wall_solid', 'sewer_shaft_open', 'sewer_shaft_solid',
  'sewer_grate', 'sewer_door_end', 'sewer_pit', 'sewer_ladder', 'town_well',
  'cave_rock_a', 'cave_rock_b', 'stalagmites', 'stalactites', 'bone_pile', 'rubble',
  'cave_wall', 'cave_wall_door', 'cave_wall_long', 'cave_wall_long_door', 'cave_roof',
  'refuse_heap', 'sewer_sconce',
  // the Great Eastern Desert: tools/blender/desert.py
  'massif_a', 'massif_b', 'massif_mouth', 'dune_a', 'dune_b', 'palm_a', 'palm_b',
  'tent_roof', 'tent_wall', 'tent_wall_door', 'rug', 'cushions', 'hitch_line', 'fungus_cluster', 'lantern',
  // the Dangerous Neighborhood: tools/blender/hood.py
  'house_derelict', 'house_gutted', 'ruin_wall_solid', 'ruin_wall_door', 'ruin_wall_breach', 'ruin_corner',
  'rubble_heap', 'charred_beams', 'barricade', 'barricade_stakes', 'burnt_cart', 'brazier', 'crow',
  'dracolich_idol', 'training_pell', 'khan_memorial', 'bramble', 'tall_weeds', 'collapsed_shed', 'dead_planter',
  'broken_stair', 'crystal_stump', 'boarded_window', 'boarded_door', 'barred_window', 'shoring', 'debris', 'city_wall',
  'townsperson', 'person_male', 'person_female', 'troll',
  'weapon_sword', 'weapon_dagger', 'weapon_axe', 'weapon_mace', 'weapon_spear',
  'weapon_staff', 'shield_round', 'shield_kite',
  // Animals, rigged and animated. One base mesh per build of body; the
  // breeds and species are proportions and coats laid on in actors.js.
  'beast_canine', 'beast_feline', 'beast_rodent', 'beast_bear', 'beast_equine', 'beast_cervid',
  'beast_bovine', 'beast_pig', 'beast_duck', 'beast_swan', 'beast_hen', 'beast_songbird',
  'beast_snake', 'beast_worm', 'beast_dragon',
  // The monsters: tools/blender/monsters.py.
  'beast_spider', 'beast_beetle', 'beast_scorpion', 'beast_drider', 'beast_bat', 'beast_mud',
  'beast_myconoid', 'beast_ratman', 'beast_imp', 'beast_naga', 'beast_sandworm', 'beast_basilisk',
  'beast_dustdigger', 'beast_camel', 'beast_dracolich',
];
