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
 * plain PBR value for the things that should not be textured at all -- cloth
 * and skin are small on screen, get tinted per person anyway, and read better
 * flat than wearing a stone pattern.
 */
const TAG_ALIASES = { oak: 'planks', leaves: 'grass' };
const TAG_MATERIALS = {
  cloth: { color: 0x6b4a42, roughness: 0.95, metalness: 0 },
  skin: { color: 0xc79b76, roughness: 0.72, metalness: 0 },
  glass: {
    color: 0xd8c48a, roughness: 0.12, metalness: 0,
    transparent: true, opacity: 0.55, emissive: 0x000000,
  },
};

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
      this.extra.set(tag, material);
      return material;
    }
    this.unknownTags.add(tag);
    return this.materials.stonewall;
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

  /** Pick whichever of these variants exists, by a stable hash. */
  choose(names, seed) {
    const available = names.filter((n) => this.assets.has(n));
    if (!available.length) return null;
    return available[Math.floor(seed * available.length) % available.length];
  }

  /**
   * Flatten a loaded file into world-ready primitives: geometry baked into the
   * node's transform, UVs rescaled to the material they will actually wear, and
   * a white vertex colour so the shared vertexColors materials behave.
   */
  digest(name, gltf) {
    const primitives = [];
    const bounds = new THREE.Box3();
    let animations = gltf.animations || [];

    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      const materialName = tagOf(node.material);
      const material = this.materials[materialName] || this.materials.stonewall;

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
      const uvScale = material.userData.uvScale ?? 1;
      const uv = geometry.attributes.uv;
      if (uv) {
        for (let i = 0; i < uv.count; i++) {
          uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i) * uvScale);
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
  'temple', 'market_stall', 'well', 'fountain', 'lamp_post', 'hanging_sign',
  'signpost', 'stone_arch', 'portcullis', 'torch_sconce', 'chimney_pot',
  'barrel', 'crate', 'sack', 'hay_bale', 'handcart', 'bench', 'trough',
  'tree_oak', 'tree_pine', 'bush', 'grass_tuft', 'townsperson',
];
