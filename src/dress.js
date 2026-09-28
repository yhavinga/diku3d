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
import { SHARED_LIGHT } from './textures.js';

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

/** A layer's mean linear luminance. */
function meanAlbedo(data, offset) {
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  let sum = 0;
  let n = 0;
  for (let i = 0; i < LAYER * LAYER; i += 3) {
    const o = offset + i * 4;
    sum += 0.2126 * lin(data[o]) + 0.7152 * lin(data[o + 1]) + 0.0722 * lin(data[o + 2]);
    n++;
  }
  return sum / n;
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
  const mean = [];
  SLOTS.forEach((tag, i) => {
    const m = library.materialFor(tag);
    const off = i * LAYER * LAYER * 4;
    const img = (tex) => (tex && tex.image && tex.image.data ? tex.image : null);
    const a = img(m.map);
    if (a) resample(a.data, a.width, albedo, off); else fill(albedo, off, 255, 255, 255);
    mean.push(meanAlbedo(albedo, off));
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
    mean,
  };
  surfaceSets.set(library, set);
  return set;
}

// --- the material -------------------------------------------------------------

/**
 * What a dyed surface's colour means, and the darkest it may be.
 *
 * people.js's colours are the colour of the cloth -- 0x3f5a2f is a green
 * tunic -- but they were multiplied over the cloth texture, whose own mean is
 * 0.56, and linen's 0.67: every garment came out at half the albedo it was
 * given. A green tunic was 5% albedo in front of a limestone wall at 43%, and
 * indoors, where nothing but the sky and a torch lights either, a person was
 * a dark cut-out with a face. So for the surfaces in `DYED_MEAN` the tint is
 * divided by the texture's mean: the weave still varies about it, and the
 * garment averages the colour it was given.
 *
 * And the palettes went down to 0x1f1a2e robes and 0x1c1714 hair -- 1-2%
 * albedo, darker than soot, black in any light but the sun. Black wool is
 * 3-5%; `TINT_FLOOR` keeps a colour's hue and lifts it only where it is
 * below that, as linear luminance of the surface it ends up as.
 */
const DYED_MEAN = new Set(['cloth', 'cloth2', 'wool', 'velvet', 'linen', 'leather', 'paint']);
const TINT_FLOOR = { cloth: 0.05, cloth2: 0.05, wool: 0.05, velvet: 0.05, linen: 0.05, leather: 0.04, paint: 0.05, hair: 0.03 };

/** Whose colour a surface takes when a person names none for it: a cloak in
 * wool is the second cloth's colour, a shield's paint the first's. */
const TINT_FROM = { wool: ['wool', 'cloth2', 'cloth'], velvet: ['velvet', 'cloth'], paint: ['cloth'], warthide: ['skin'] };

const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
dummy.needsUpdate = true;
const dummyColour = dummy.clone();
dummyColour.colorSpace = THREE.SRGBColorSpace;
dummyColour.needsUpdate = true;

const SLOT_OF = 'int( vSlot + 0.5 )';

/**
 * How much of the sky each surface believes -- but only for what it
 * *reflects*. The per-surface `env` of a recipe (wool 0.22, cloth 0.35, skin
 * 0.5, steel 1.5) used to scale the diffuse sky light too, because three's
 * `envMapIntensity` scales both; a stone wall believes 0.72 of the same sky,
 * so a woollen coat standing in front of it took a third of the ambient the
 * wall did, and indoors -- where the sky is nearly all the light there is --
 * every figure came out a dark shape against a lit wall. Diffuse sky light
 * does not care what a surface is made of: every surface of a person takes
 * `DIFFUSE_ENV`, the town's walls' own share (stone 0.72, plaster 0.7,
 * timber 0.8, planks 0.85).
 */
const DIFFUSE_ENV = 0.75;
const IBL_IRRADIANCE = 'return PI * envMapColor.rgb * envMapIntensity;';
const IBL_RADIANCE = 'return envMapColor.rgb * envMapIntensity;';
const ENVMAP_BY_SLOT = THREE.ShaderChunk.envmap_physical_pars_fragment
  .replace(IBL_IRRADIANCE, `return PI * envMapColor.rgb * envMapIntensity * ${DIFFUSE_ENV.toFixed(3)};`)
  .replace(IBL_RADIANCE, `return envMapColor.rgb * envMapIntensity * slotParams[ ${SLOT_OF} ].y;`);
if (!ENVMAP_BY_SLOT.includes(DIFFUSE_ENV.toFixed(3)) || !ENVMAP_BY_SLOT.includes('slotParams')) {
  throw new Error('dress: three\'s environment chunk moved; the per-surface sky injection missed');
}

/**
 * The light loop, as the town's surfaces have it (textures.js): the noon
 * hemisphere is the sunlit ground's bounce and does not reach indoors. It
 * reached every figure indoors at full strength, lighting people from below
 * the floor they stood on.
 */
const HEMI_LINE = 'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );';
const POINT_LINE = 'getPointLightInfo( pointLight, geometryPosition, directLight );';
const LIGHTS_BEGIN = 'vec3 dikuTorch = vec3( 0.0 );\n' + THREE.ShaderChunk.lights_fragment_begin
  .replace(HEMI_LINE,
    'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * mix( 1.0, indoorBounce, dikuIndoor );')
  // What the torches deliver here whichever way the surface faces: the fill
  // below is a share of it.
  .replace(POINT_LINE, `${POINT_LINE}\n\t\tdikuTorch += directLight.visible ? directLight.color : vec3( 0.0 );`);
if (!LIGHTS_BEGIN.includes('dikuIndoor') || !LIGHTS_BEGIN.includes('dikuTorch +=')) {
  throw new Error('dress: three\'s light loop moved; the indoor hemisphere or torch injection missed');
}

/**
 * A fill that stands where you stand. Indoors a person against a lit wall is
 * lit by the same sky and torches as the wall, and nearly everything a person
 * wears is darker than limestone and plaster -- dyed wool is 5-10% albedo, a
 * wall 30-40% -- so they read as a cut-out, with their faces lost. Films and
 * games light the actor, not only the set; this is that fill, kept honest:
 *
 *  - it is a share of the light already there -- the sky and the hemisphere
 *    this fragment receives, and half of what the torches deliver to the
 *    spot, whichever way it faces -- so a figure in a dark cellar stays dark,
 *    one by a window or a hearth gets more, and at night, when the torches
 *    are all the light a room has, it still has something to be a share of;
 *  - it comes from just above the viewer's eye and wraps a little, so it
 *    models a face and fills the eye sockets instead of flattening it;
 *  - it is warm-neutral, as light off plaster and floorboards is;
 *  - and it is indoors only (`dikuIndoor`, eased per person as they walk in
 *    and out), because out of doors the sun and the open sky already do it.
 */
export const FIGURE_FILL = { value: 2.4 };

const LIGHTS_END = `
  {
    // The sky indoors has lost its hue by the time it reaches anyone, as the
    // walls' has; outdoors the hour's own bleach -- both as textures.js.
    float dikuIblL = dot( iblIrradiance, vec3( 0.2126, 0.7152, 0.0722 ) );
    iblIrradiance = mix( iblIrradiance, dikuIblL * mix( dikuSkyBleachTint, vec3( 1.06, 1.0, 0.90 ), dikuIndoor ),
      max( dikuIndoor * 0.8, dikuSkyBleach ) );
    float dikuRadL = dot( radiance, vec3( 0.2126, 0.7152, 0.0722 ) );
    radiance = mix( radiance, dikuRadL * vec3( 1.03, 1.0, 0.95 ), dikuIndoor * 0.5 );
    // The fill: view space, so +z is towards the camera and +y up.
    float dikuAmbient = dot( iblIrradiance + irradiance + 0.5 * dikuTorch, vec3( 0.2126, 0.7152, 0.0722 ) );
    float dikuWrap = clamp( ( dot( geometryNormal, normalize( vec3( 0.25, 0.45, 1.0 ) ) ) + 0.3 ) / 1.3, 0.0, 1.0 );
    irradiance += vec3( 1.04, 1.0, 0.94 ) * ( dikuFill * dikuIndoor * dikuAmbient * dikuWrap );
  }
  #include <lights_fragment_end>`;

function inject(shader, set, tints, show, indoor) {
  shader.uniforms.heldShow = { value: show };
  shader.uniforms.dikuIndoor = indoor;
  shader.uniforms.indoorBounce = SHARED_LIGHT.indoorBounce;
  shader.uniforms.dikuSkyBleach = SHARED_LIGHT.skyBleach;
  shader.uniforms.dikuSkyBleachTint = SHARED_LIGHT.skyBleachTint;
  shader.uniforms.dikuFill = FIGURE_FILL;
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
      uniform vec3 slotTint[ ${MAX_SLOTS} ];
      uniform float dikuIndoor;
      uniform float indoorBounce;
      uniform float dikuSkyBleach;
      uniform vec3 dikuSkyBleachTint;
      uniform float dikuFill;`)
    .replace('#include <lights_fragment_begin>', LIGHTS_BEGIN)
    .replace('#include <lights_fragment_end>', LIGHTS_END)
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
  // What each surface reflects of the sky: see ENVMAP_BY_SLOT.
  const envd = frag.replace('#include <envmap_physical_pars_fragment>', ENVMAP_BY_SLOT);
  if (!frag.includes('dikuWrap') || !frag.includes('indoorBounce, dikuIndoor')) {
    throw new Error('dress: the person material missed its light-loop injection');
  }
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
    const mean = DYED_MEAN.has(tag) ? set.mean[i] : 1;
    if (mean < 1) c.multiplyScalar(1 / Math.max(mean, 0.2));
    const floor = TINT_FLOOR[tag];
    const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * mean;
    if (floor && lum < floor) c.multiplyScalar(floor / Math.max(lum, 1e-4));
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
  // How far indoors this person is, 0..1, eased by actors.js as they walk in
  // and out; shared by the material's clones, which share this closure.
  const indoor = { value: 0 };
  m.onBeforeCompile = (shader) => inject(shader, set, tints, show, indoor);
  m.customProgramCacheKey = () => 'diku-person-3';
  m.dikuIndoor = indoor;
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
