/**
 * A person as one draw.
 *
 * A dressed person is a body, a face, hair, perhaps a beard and a hat, and
 * perhaps a sword and a shield -- a dozen primitives in eight or nine
 * materials. Drawn as they come out of the file that was seven or eight draw
 * calls a person, and a judge counted 1731 skinned meshes for 249 figures in
 * one barn. So everything a person wears is merged here into one skinned
 * geometry with one material: every surface a person can be made of -- skin,
 * wool, linen, leather, mail, steel, hair, the eye -- is a layer of a texture
 * array, each vertex says which layer it is (`aSlot`), and each person's own
 * colours are a small uniform array on their own material. The program is
 * shared by everyone; only the uniforms differ.
 *
 * The weapon and the shield go into the same geometry, weighted wholly to the
 * bone that holds them, so they cost nothing extra and follow the hand
 * through every clip -- including the death, where a separately parented
 * blade used to stand on end.
 *
 * Geometry is cached by what goes into it (file, archetype, face, pieces,
 * weapon, shield): the twenty cityguards of Midgaard share a handful.
 */

import * as THREE from 'three';

/** Every surface a person, or what a person carries, is made of. */
export const SLOTS = ['skin', 'cloth', 'cloth2', 'linen', 'leather', 'mail', 'steel', 'iron', 'hair',
  'eyewhite', 'eye', 'gold', 'bone', 'oak', 'paint', 'wool', 'plate', 'velvet', 'warthide'];
const MAX_SLOTS = 20;
/** Texels a side for each layer: 2.7 mm on a 0.7 m cloth tile. */
const LAYER = 256;

const slotIndex = new Map(SLOTS.map((tag, i) => [tag, i]));

// --- the surfaces -------------------------------------------------------------

/** An RGBA8 image resampled to LAYER x LAYER by box filter (or by nearest,
 * upwards), into `out` at `offset`. */
function resample(src, size, out, offset) {
  if (size === LAYER) { out.set(src.subarray(0, LAYER * LAYER * 4), offset); return; }
  const k = size / LAYER;
  for (let y = 0; y < LAYER; y++) {
    for (let x = 0; x < LAYER; x++) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      const y0 = Math.floor(y * k); const y1 = Math.max(y0 + 1, Math.floor((y + 1) * k));
      const x0 = Math.floor(x * k); const x1 = Math.max(x0 + 1, Math.floor((x + 1) * k));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = ((sy % size) * size + (sx % size)) * 4;
          acc[0] += src[i]; acc[1] += src[i + 1]; acc[2] += src[i + 2]; acc[3] += src[i + 3];
          n++;
        }
      }
      const o = offset + (y * LAYER + x) * 4;
      out[o] = acc[0] / n; out[o + 1] = acc[1] / n; out[o + 2] = acc[2] / n; out[o + 3] = acc[3] / n;
    }
  }
}

function fill(out, offset, r, g, b, a = 255) {
  for (let i = 0; i < LAYER * LAYER; i++) {
    const o = offset + i * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
}

function arrayTexture(data, colorSpace) {
  const t = new THREE.DataArrayTexture(data, LAYER, LAYER, MAX_SLOTS);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = colorSpace;
  t.needsUpdate = true;
  return t;
}

const surfaceSets = new WeakMap();

/**
 * The layers, read off the library's own materials so a person's cloth is
 * the town's cloth: a baked recipe gives its albedo, normal and packed
 * roughness/metalness maps; a flat material gives white, its grain (if it
 * wears one) and its constants. Built once per library.
 */
function surfaces(library) {
  let set = surfaceSets.get(library);
  if (set) return set;
  const albedo = new Uint8Array(LAYER * LAYER * 4 * MAX_SLOTS);
  const normal = new Uint8Array(LAYER * LAYER * 4 * MAX_SLOTS);
  const orm = new Uint8Array(LAYER * LAYER * 4 * MAX_SLOTS);
  const params = new Float32Array(MAX_SLOTS * 2);
  const base = [];
  SLOTS.forEach((tag, i) => {
    const m = library.materialFor(tag);
    const off = i * LAYER * LAYER * 4;
    const img = (tex) => (tex && tex.image && tex.image.data ? tex.image : null);
    const a = img(m.map);
    if (a) resample(a.data, a.width, albedo, off); else fill(albedo, off, 255, 255, 255);
    const n = img(m.normalMap);
    if (n) resample(n.data, n.width, normal, off); else fill(normal, off, 128, 128, 255);
    const r = img(m.roughnessMap);
    if (r) resample(r.data, r.width, orm, off);
    else fill(orm, off, 255, Math.round(THREE.MathUtils.clamp(m.roughness, 0, 1) * 255),
      Math.round(THREE.MathUtils.clamp(m.metalness, 0, 1) * 255));
    params[i * 2] = n ? (m.normalScale ? m.normalScale.x : 1) : 0;
    params[i * 2 + 1] = m.envMapIntensity ?? 1;
    base.push(m.color ? m.color.clone() : new THREE.Color(1, 1, 1));
  });
  set = {
    albedo: arrayTexture(albedo, THREE.SRGBColorSpace),
    normal: arrayTexture(normal, THREE.NoColorSpace),
    orm: arrayTexture(orm, THREE.NoColorSpace),
    params,
    base,
  };
  surfaceSets.set(library, set);
  return set;
}

// --- the material -------------------------------------------------------------

/** Whose colour a surface takes when a person names none for it: a cloak in
 * wool is the second cloth's colour, a shield's paint the first's. */
const TINT_FROM = { wool: ['wool', 'cloth2', 'cloth'], velvet: ['velvet', 'cloth'], paint: ['cloth'], warthide: ['skin'] };

const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
dummy.needsUpdate = true;
const dummyColour = dummy.clone();
dummyColour.colorSpace = THREE.SRGBColorSpace;
dummyColour.needsUpdate = true;

const SLOT_OF = 'int( vSlot + 0.5 )';

const ENVMAP_BY_SLOT = THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
  /envMapColor\.rgb \* envMapIntensity;/g, `envMapColor.rgb * envMapIntensity * slotParams[ ${SLOT_OF} ].y;`);
if (ENVMAP_BY_SLOT === THREE.ShaderChunk.envmap_physical_pars_fragment) {
  throw new Error('dress: three\'s environment chunk moved; the per-surface sky injection missed');
}

function inject(shader, set, tints, show) {
  shader.uniforms.heldShow = { value: show };
  shader.uniforms.slotAlbedo = { value: set.albedo };
  shader.uniforms.slotNormal = { value: set.normal };
  shader.uniforms.slotOrm = { value: set.orm };
  shader.uniforms.slotParams = { value: set.params };
  shader.uniforms.slotTint = { value: tints };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aSlot;\nattribute float aHeld;'
      + '\nuniform vec2 heldShow;\nvarying float vSlot;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      vSlot = aSlot;
      // What is held can be let go of -- a mobile disarmed, a corpse looted
      // (items.js) -- without a second mesh: its vertices fold to a point.
      if ( ( aHeld > 0.5 && aHeld < 1.5 && heldShow.x < 0.5 ) || ( aHeld > 1.5 && heldShow.y < 0.5 ) ) {
        transformed = vec3( 0.0 );
      }`);
  const frag = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      varying float vSlot;
      uniform highp sampler2DArray slotAlbedo;
      uniform highp sampler2DArray slotNormal;
      uniform highp sampler2DArray slotOrm;
      uniform vec2 slotParams[ ${MAX_SLOTS} ];
      uniform vec3 slotTint[ ${MAX_SLOTS} ];`)
    .replace('#include <map_fragment>', `
      int dikuSlot = ${SLOT_OF};
      vec4 sampledDiffuseColor = texture( slotAlbedo, vec3( vMapUv, float( dikuSlot ) ) );
      diffuseColor *= sampledDiffuseColor;
      diffuseColor.rgb *= slotTint[ dikuSlot ];`)
    .replace('#include <roughnessmap_fragment>', `
      vec4 dikuOrm = texture( slotOrm, vec3( vRoughnessMapUv, float( dikuSlot ) ) );
      float roughnessFactor = roughness * dikuOrm.g;`)
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * dikuOrm.b;')
    .replace('#include <normal_fragment_maps>', `
      vec3 mapN = texture( slotNormal, vec3( vNormalMapUv, float( dikuSlot ) ) ).xyz * 2.0 - 1.0;
      mapN.xy *= normalScale * slotParams[ dikuSlot ].x;
      normal = normalize( tbn * mapN );`);
  // How much of the sky each surface believes, as the town's own materials
  // do through envMapIntensity: steel most, wool least.
  const envd = frag.replace('#include <envmap_physical_pars_fragment>', ENVMAP_BY_SLOT);
  for (const [before, after] of [[shader.fragmentShader, frag], [frag, envd]]) {
    if (before === after) throw new Error('dress: a shader chunk moved; the person material missed an injection');
  }
  shader.fragmentShader = envd;
}

/**
 * One person's material: their colours per surface, `tint` by tag, over the
 * surfaces' own base colour. A ghost is see-through and lit from inside.
 */
export function personMaterial(library, tint, ghost, show = new THREE.Vector2(1, 1)) {
  const set = surfaces(library);
  const tints = new Float32Array(MAX_SLOTS * 3);
  const c = new THREE.Color();
  SLOTS.forEach((tag, i) => {
    const from = TINT_FROM[tag] || [tag];
    const hex = from.map((k) => tint[k]).find((h) => h !== undefined && h !== null);
    if (hex !== undefined && hex !== null) c.setHex(hex); else c.copy(set.base[i]);
    tints[i * 3] = c.r; tints[i * 3 + 1] = c.g; tints[i * 3 + 2] = c.b;
  });
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 1,
    map: dummyColour, normalMap: dummy, roughnessMap: dummy, metalnessMap: dummy,
  });
  m.name = 'person';
  // Captured, not kept on userData: a material clone (motion.js fades the
  // dying with one) deep-copies userData through JSON, which would turn the
  // array into an object; the closure goes with the function.
  m.onBeforeCompile = (shader) => inject(shader, set, tints, show);
  m.customProgramCacheKey = () => 'diku-person-2';
  if (ghost) {
    m.transparent = true;
    m.opacity = 0.34;
    m.depthWrite = false;
    m.emissive = new THREE.Color(0x7f98b2);
    m.emissiveIntensity = 0.55;
  }
  return m;
}

// --- the geometry -------------------------------------------------------------

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();

/** The skinned primitives under a node: a mesh, or a group of them. */
function primitivesOf(node) {
  const out = [];
  node.traverse((n) => { if (n.isSkinnedMesh) out.push(n); });
  return out;
}

const tagOf = (material) => (material && material.name ? material.name.replace(/^MAT:/, '') : '');

function slotOf(tag, where) {
  const i = slotIndex.get(tag);
  if (i === undefined) throw new Error(`dress: no surface slot for "${tag}" (${where}) -- add it to SLOTS`);
  return i;
}

const geometries = new Map();

/**
 * Everything a person wears, as one geometry in the skin's bind space.
 *
 * @param asset the person file, digested (its UVs already in each surface's tile)
 * @param names the nodes to take: archetype, face, head pieces
 * @param held [{asset, bone}] rigid models to fold in on a holding bone
 * @param key cache key
 */
export function dressedGeometry(asset, names, held, key) {
  if (geometries.has(key)) return geometries.get(key);
  const parts = [];
  let skeleton = null;
  let bindMatrix = null;
  for (const name of names) {
    const node = asset.scene.getObjectByName(name);
    if (!node) throw new Error(`dress: ${asset.name}.glb has no ${name}`);
    for (const mesh of primitivesOf(node)) {
      if (!skeleton) { skeleton = mesh.skeleton; bindMatrix = mesh.bindMatrix; }
      else if (mesh.skeleton.bones.length !== skeleton.bones.length
        || !mesh.bindMatrix.equals(bindMatrix)) {
        throw new Error(`dress: ${name} in ${asset.name}.glb is bound to a different skin`);
      }
      parts.push({ geometry: mesh.geometry, slot: slotOf(tagOf(mesh.material), name), matrix: null });
    }
  }
  if (!skeleton) throw new Error(`dress: nothing to wear in ${asset.name}.glb for ${key}`);
  const bindInverse = bindMatrix.clone().invert();
  for (const { asset: model, bone } of held) {
    const index = skeleton.bones.findIndex((b) => b.name === bone);
    if (index < 0) throw new Error(`dress: ${asset.name}.glb has no bone ${bone}`);
    // A vertex at p in the bone's frame, in the skin's bind space: the
    // bone's bind-pose world matrix is the inverse of its bone inverse.
    const matrix = bindInverse.clone().multiply(skeleton.boneInverses[index].clone().invert());
    for (const p of model.primitives) {
      parts.push({ geometry: p.geometry, slot: slotOf(p.materialName, model.name), matrix, bone: index,
        held: bone === 'shieldL' ? 2 : 1 });
    }
  }

  let vertices = 0;
  let indices = 0;
  for (const p of parts) {
    vertices += p.geometry.attributes.position.count;
    indices += p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count;
  }
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2);
  const color = new Float32Array(vertices * 4);
  const skinIndex = new Uint16Array(vertices * 4);
  const skinWeight = new Float32Array(vertices * 4);
  const slot = new Float32Array(vertices);
  const heldBy = new Float32Array(vertices);
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let v0 = 0;
  let i0 = 0;
  for (const p of parts) {
    const g = p.geometry;
    const n = g.attributes.position.count;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const tex = g.attributes.uv;
    const col = g.attributes.color;
    if (p.matrix) _n.getNormalMatrix(p.matrix);
    for (let i = 0; i < n; i++) {
      const o = v0 + i;
      _v.fromBufferAttribute(pos, i);
      if (p.matrix) _v.applyMatrix4(p.matrix);
      position[o * 3] = _v.x; position[o * 3 + 1] = _v.y; position[o * 3 + 2] = _v.z;
      if (nor) {
        _v.fromBufferAttribute(nor, i);
        if (p.matrix) _v.applyMatrix3(_n).normalize();
        normal[o * 3] = _v.x; normal[o * 3 + 1] = _v.y; normal[o * 3 + 2] = _v.z;
      }
      if (tex) { uv[o * 2] = tex.getX(i); uv[o * 2 + 1] = tex.getY(i); }
      if (col) {
        color[o * 4] = col.getX(i); color[o * 4 + 1] = col.getY(i); color[o * 4 + 2] = col.getZ(i);
        color[o * 4 + 3] = col.itemSize > 3 ? col.getW(i) : 1;
      } else {
        color[o * 4] = 1; color[o * 4 + 1] = 1; color[o * 4 + 2] = 1; color[o * 4 + 3] = 1;
      }
      if (p.matrix) {
        skinIndex[o * 4] = p.bone;
        skinWeight[o * 4] = 1;
      } else {
        const si = g.attributes.skinIndex;
        const sw = g.attributes.skinWeight;
        for (let k = 0; k < 4; k++) {
          skinIndex[o * 4 + k] = si.getComponent(i, k);
          skinWeight[o * 4 + k] = sw.getComponent(i, k);
        }
      }
      slot[o] = p.slot;
      heldBy[o] = p.held || 0;
    }
    if (g.index) {
      for (let k = 0; k < g.index.count; k++) index[i0 + k] = g.index.getX(k) + v0;
      i0 += g.index.count;
    } else {
      for (let k = 0; k < n; k++) index[i0 + k] = v0 + k;
      i0 += n;
    }
    v0 += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(color, 4));
  out.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  out.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
  out.setAttribute('aHeld', new THREE.BufferAttribute(heldBy, 1));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  const record = { geometry: out, bindMatrix, triangles: indices / 3 };
  geometries.set(key, record);
  return record;
}
