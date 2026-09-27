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

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

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
const TAG_ALIASES = {};
const TAG_MATERIALS = {
  cloth: { color: 0x6b4a42, roughness: 0.95, metalness: 0 },
  skin: { color: 0xc79b76, roughness: 0.72, metalness: 0 },
  oak: { color: 0x5a4330, roughness: 0.78, metalness: 0 },
  leather: { color: 0x4a3524, roughness: 0.62, metalness: 0 },
  hair: { color: 0x3a2a1c, roughness: 0.86, metalness: 0 },
  glass: {
    color: 0xd8c48a, roughness: 0.12, metalness: 0,
    transparent: true, opacity: 0.55, emissive: 0x000000,
  },
};
/** Tags whose flat material wants the shared grain, at this strength. */
const GRAINED = { cloth: 0.5, skin: 0.22, oak: 0.35, leather: 0.45, hair: 0.6 };

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
    const alias = TAG_ALIASES[tag];
    if (alias && this.materials[alias]) return this.materials[alias];
    if (this.extra.has(tag)) return this.extra.get(tag);
    const recipe = TAG_MATERIALS[tag];
    if (recipe) {
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, ...recipe });
      material.name = tag;
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
   * The glass on the models is one material over every pane in town, so it
   * cannot be lit house by house the way the procedural windows are. It still
   * has to know what hour it is: by day a pane shows the sky, and after dark it
   * shows whatever is burning inside. Left at emissive 0x000000 -- which it was
   * -- eighty-five panes are a tan panel that never lights, and a town at night
   * has not one window on.
   */
  setWindowLight(colourHex, intensity) {
    const glass = this.extra.get('glass');
    if (!glass) return;
    glass.emissive.setHex(colourHex);
    glass.emissiveIntensity = Math.max(0, intensity);
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
      const materialName = tagOf(node.material);
      const material = this.materialFor(materialName);

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
 * Collects placements and turns them into InstancedMeshes, one per chunk per
 * primitive. Chunking is what keeps culling useful: a single instanced mesh
 * spanning the whole town is one bounding sphere and is never off screen.
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
   */
  add(name, transform, chunk = '0') {
    const asset = this.library.get(name);
    if (!asset) return false;
    const key = `${chunk}|${name}`;
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = { asset, transforms: [] }; this.buckets.set(key, bucket); }
    bucket.transforms.push(transform);
    return true;
  }

  finish(parent) {
    let meshes = 0;
    let triangles = 0;
    for (const { asset, transforms } of this.buckets.values()) {
      for (const primitive of asset.primitives) {
        const mesh = new THREE.InstancedMesh(primitive.geometry, primitive.material, transforms.length);
        transforms.forEach((t, i) => {
          _position.set(t.x, t.y, t.z);
          _quaternion.setFromAxisAngle(UP, t.rotY || 0);
          _scale.set(
            t.scaleX ?? t.scale ?? 1,
            t.scaleY ?? t.scale ?? 1,
            t.scaleZ ?? t.scale ?? 1,
          );
          mesh.setMatrixAt(i, _matrix.compose(_position, _quaternion, _scale));
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        parent.add(mesh);
        meshes++;
        triangles += (primitive.geometry.attributes.position.count / 3) * transforms.length;
      }
    }
    return { meshes, triangles };
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
  'temple', 'market_stall', 'well', 'fountain', 'lamp_post', 'hanging_sign',
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
  'sewer_tunnel', 'sewer_arm', 'sewer_hub', 'sewer_hub_end', 'sewer_chamber', 'sewer_shaft',
  'sewer_wall_open', 'sewer_wall_solid', 'sewer_shaft_open', 'sewer_shaft_solid',
  'sewer_grate', 'sewer_door_end', 'sewer_pit', 'sewer_ladder', 'town_well',
  'cave_rock_a', 'cave_rock_b', 'stalagmites', 'stalactites', 'bone_pile', 'rubble',
  'townsperson',
];
