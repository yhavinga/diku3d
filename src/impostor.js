/**
 * Far trees as impostors: a camera-facing card that shows the tree as it
 * looks from that side, baked at load from the tree's own model.
 *
 * A forest view drew about 1,100 trees at 2,300-2,500 triangles each, twice
 * (the main pass and the AO prepass): 5 M of Haon Dor's 13 M triangles, most
 * of them trees a hundred metres off and more, a few dozen pixels tall. Past
 * a distance a tree is drawn as one quad instead.
 *
 * Each model is photographed from 8 bearings at 2 elevations, into two
 * atlases: the albedo with its coverage, and the surface -- the normal, in the
 * model's own space, and the roughness. The card blends the four frames
 * nearest the direction it is seen from and is lit in the shader like
 * everything else, by the same material hooks (`decorate` in textures.js) the
 * tree itself wears. So one bake serves every hour and weather, and each tree
 * keeps its own turn about its trunk: the frames are picked in the tree's
 * space, the normals turned back into the world's.
 *
 * Between `start` and `end` metres the full tree and its card cross-dissolve
 * through the same screen-space dither, one discarding exactly the pixels the
 * other keeps; cull.js decides per instance which of the two a tree is drawn
 * as. The cards cast no shadow and take none: the sun's frustum is 38 m to a
 * side at `high`, so a tree past the crossfade is outside it at every hour
 * but a low sun's long axis, and there the full tree still casts -- cull.js
 * keeps it in the instance set on shadow frames, where the dither drops all
 * of it from the main pass.
 */

import * as THREE from 'three';

/** The models drawn as cards far off. */
export const IMPOSTOR_MODELS = ['tree_fir', 'tree_cedar', 'tree_pine', 'tree_oak', 'palm_a', 'palm_b'];

const COLS = 8;
/** Elevations of the rows, degrees. The eye is on the ground; trees past 80 m are seen nearly level. */
const ELEVATIONS = [0, 30];
/** Pixels per frame, split between width and height by the model's proportions. */
const FRAME_AREA = 176 * 384;
/** The bake is drawn this much finer and averaged down, so needles leave coverage rather than stipple. */
const SUPER = 2;
/** Coverage below this is sky. */
const CUT = 0.45;
const FOLIAGE = /needles|oakleaf|leaves|frond/;

const DITHER = /* glsl */`
  // The same pattern on both sides of the crossfade: a tree is drawn where
  // this is at or over its fade, its card where it is under.
  float dikuDither() {
    return fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  }
`;

const IMP_VERTEX_PARS = /* glsl */`
  attribute vec4 aImpostor;       // trunk foot xyz, scale
  attribute float aImpostorYaw;
  uniform vec3 impCentre;         // the model's middle, in its own space
  uniform vec2 impSize;           // a frame's width and height, metres
  uniform vec4 impGrid;           // columns, rows, first elevation, elevation step (radians)
  uniform vec2 lodFade;
  varying vec2 vImpUv;
  varying vec4 vImpCells;
  varying vec2 vImpMix;
  varying vec2 vImpYaw;
  varying float vLodFade;
`;

// In place of beginnormal_vertex, which comes first: everything the card
// needs, worked out once for its four corners alike.
const IMP_VERTEX_MAIN = /* glsl */`
  float impC = cos( aImpostorYaw );
  float impS = sin( aImpostorYaw );
  vec3 impMid = aImpostor.xyz + vec3( impC * impCentre.x + impS * impCentre.z, impCentre.y,
    - impS * impCentre.x + impC * impCentre.z ) * aImpostor.w;
  vec3 impV = cameraPosition - impMid;
  impV /= max( length( impV ), 1e-4 );
  // The eye's direction in the tree's own space picks the frames.
  vec3 impVo = vec3( impC * impV.x - impS * impV.z, impV.y, impS * impV.x + impC * impV.z );
  float impCol = mod( atan( impVo.x, impVo.z ) / 6.2831853 * impGrid.x, impGrid.x );
  float impCol0 = floor( impCol );
  float impRow = clamp( ( asin( clamp( impVo.y, -1.0, 1.0 ) ) - impGrid.z ) / impGrid.w, 0.0, impGrid.y - 1.0 );
  float impRow0 = floor( impRow );
  vImpCells = vec4( impCol0, mod( impCol0 + 1.0, impGrid.x ), impRow0, min( impRow0 + 1.0, impGrid.y - 1.0 ) );
  vImpMix = vec2( impCol - impCol0, impRow - impRow0 );
  vImpYaw = vec2( impC, impS );
  vImpUv = position.xy + 0.5;
  vLodFade = smoothstep( lodFade.x, lodFade.y, distance( cameraPosition, aImpostor.xyz ) );
  vec3 impRight = cross( vec3( 0.0, 1.0, 0.0 ), impV );
  impRight = dot( impRight, impRight ) > 1e-6 ? normalize( impRight ) : vec3( 1.0, 0.0, 0.0 );
  vec3 impUp = cross( impV, impRight );
  vec3 impPosition = impMid + ( impRight * position.x * impSize.x + impUp * position.y * impSize.y ) * aImpostor.w;
  vec3 objectNormal = impV;
`;

const IMP_FRAG_PARS = /* glsl */`
  uniform sampler2D impAlbedo;
  uniform sampler2D impSurface;
  uniform vec4 impGrid;
  uniform vec2 impAtlas;
  uniform float impCut;
  varying vec2 vImpUv;
  varying vec4 vImpCells;
  varying vec2 vImpMix;
  varying vec2 vImpYaw;
  varying float vLodFade;
  ${DITHER}
`;

// At the top of main: the four nearest frames, blended; then the cut and the
// crossfade. Leaves impAlbedoC, impRough and impNormalV behind.
const IMP_FRAG_MAIN = /* glsl */`
  if ( dikuDither() >= vLodFade ) discard;
  vec2 impPx = vImpUv * impAtlas / impGrid.xy;
  // Capped: three levels down a frame's blur reaches its neighbour's.
  float impLod = clamp( 0.5 * log2( max( dot( dFdx( impPx ), dFdx( impPx ) ), dot( dFdy( impPx ), dFdy( impPx ) ) ) ), 0.0, 2.5 );
  vec4 impA = vec4( 0.0 );
  vec4 impSf = vec4( 0.0 );
  {
    vec2 w = vImpMix;
    vec4 weights = vec4( ( 1.0 - w.x ) * ( 1.0 - w.y ), w.x * ( 1.0 - w.y ), ( 1.0 - w.x ) * w.y, w.x * w.y );
    vec2 cells[ 4 ];
    cells[ 0 ] = vImpCells.xz; cells[ 1 ] = vImpCells.yz; cells[ 2 ] = vImpCells.xw; cells[ 3 ] = vImpCells.yw;
    for ( int i = 0; i < 4; i ++ ) {
      vec2 q = ( cells[ i ] + vImpUv ) / impGrid.xy;
      impA += weights[ i ] * textureLod( impAlbedo, q, impLod );
      impSf += weights[ i ] * textureLod( impSurface, q, impLod );
    }
  }
  if ( impA.a < impCut ) discard;
  vec3 impAlbedoC = impA.rgb / impA.a;
  float impRough = impSf.a / impA.a;
  // Not renormalised. A pixel of card is several needles averaged, and the
  // mean of their lighting is less than the lighting of their mean normal:
  // the shorter the mean, the more they disagreed, and the less sun the
  // pixel takes. Normalised, the cards came out 9% brighter than the trees
  // at noon (#8314, luma 126 against 120).
  vec3 impN = impSf.rgb / impA.a * 2.0 - 1.0;
  vec3 impNw = vec3( vImpYaw.x * impN.x + vImpYaw.y * impN.z, impN.y, - vImpYaw.y * impN.x + vImpYaw.x * impN.z );
  vec3 impNormalV = ( viewMatrix * vec4( impNw, 0.0 ) ).xyz;
`;

/** The full tree's side of the crossfade, for its twin materials. */
const FADE_VERTEX = /* glsl */`
  #ifdef USE_INSTANCING
    vLodFade = smoothstep( lodFade.x, lodFade.y, distance( cameraPosition, ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz ) );
  #else
    vLodFade = 0.0;
  #endif
`;

function replaceOnce(source, find, replacement, what) {
  if (!source.includes(find)) throw new Error(`impostor: ${what}: '${find}' not found in shader`);
  return source.replace(find, replacement);
}

/**
 * Wrap a material's own onBeforeCompile. `decorate` in textures.js writes the
 * compiled wetness uniform onto the material it closes over, which for a
 * copy is the original: put that back, or the original stops getting wet.
 */
function chain(base, extra) {
  return (shader, renderer) => {
    if (base.onBeforeCompile) {
      const had = Object.prototype.hasOwnProperty.call(base.userData, 'wetnessUniform');
      const wet = base.userData.wetnessUniform;
      base.onBeforeCompile(shader, renderer);
      if (had) base.userData.wetnessUniform = wet;
      else delete base.userData.wetnessUniform;
    }
    extra(shader);
  };
}

export function createImpostors({ renderer, library, range = [80, 95] }) {
  const fade = { value: new THREE.Vector2(range[0], range[1]) };
  const models = new Map();
  const byGeometry = new Map();
  const twins = new Map();
  const group = new THREE.Group();
  group.name = 'impostors';
  let enabled = true;

  // ------------------------------------------------------------- bake ----

  const quad = new THREE.PlaneGeometry(2, 2);
  const pack = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { albedoT: { value: null }, surfaceT: { value: null }, origin: { value: new THREE.Vector2() }, mode: { value: 0 } },
    vertexShader: 'void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D albedoT;
      uniform sampler2D surfaceT;
      uniform vec2 origin;
      uniform int mode;
      out highp vec4 fragColor;
      void main() {
        ivec2 p = ( ivec2( gl_FragCoord.xy ) - ivec2( origin ) ) * ${SUPER};
        vec4 sum = vec4( 0.0 );
        float covered = 0.0;
        for ( int j = 0; j < ${SUPER}; j ++ ) for ( int i = 0; i < ${SUPER}; i ++ ) {
          ivec2 q = p + ivec2( i, j );
          vec4 a = texelFetch( albedoT, q, 0 );
          if ( a.a < 0.5 ) continue;
          sum += mode == 0 ? vec4( a.rgb, 1.0 ) : texelFetch( surfaceT, q, 0 );
          covered += 1.0;
        }
        float n = float( ${SUPER * SUPER} );
        // Premultiplied by coverage, so the mips average what is there.
        fragColor = mode == 0 ? vec4( sum.rgb / n, covered / n ) : sum / n;
      }`,
    depthTest: false, depthWrite: false,
  });
  const packMesh = new THREE.Mesh(quad, pack);
  packMesh.frustumCulled = false;
  const packScene = new THREE.Scene();
  packScene.add(packMesh);
  const packCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function bakeMaterial(source, mode) {
    return new THREE.ShaderMaterial({
      vertexColors: true,
      side: source.side,
      uniforms: {
        map: { value: source.map },
        rough: { value: source.roughnessMap },
        cut: { value: source.alphaTest || -1 },
        tint: { value: source.color.clone() },
        roughScale: { value: source.roughness },
        mode: { value: mode },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying vec3 vCol; varying vec3 vN;
        void main() {
          vUv = uv; vCol = color; vN = normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map; uniform sampler2D rough; uniform float cut; uniform vec3 tint;
        uniform float roughScale; uniform int mode;
        varying vec2 vUv; varying vec3 vCol; varying vec3 vN;
        void main() {
          vec4 t = texture2D( map, vUv );
          if ( t.a < cut ) discard;
          // Foliage normals are baked to point out of the crown on both faces
          // of a card (DIKU_FOLIAGE undoes the two-sided flip), so as stored.
          if ( mode == 0 ) gl_FragColor = vec4( tint * t.rgb * vCol, 1.0 );
          else gl_FragColor = vec4( normalize( vN ) * 0.5 + 0.5, roughScale * texture2D( rough, vUv ).g );
        }`,
    });
  }

  function frameBasis(col, row) {
    const yaw = (col / COLS) * Math.PI * 2;
    const e = THREE.MathUtils.degToRad(ELEVATIONS[row]);
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(e), Math.sin(e), Math.cos(yaw) * Math.cos(e));
    const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    const up = dir.clone().cross(right);
    return { dir, right, up };
  }

  function bake(name, asset) {
    const centre = asset.bounds.getCenter(new THREE.Vector3());
    const radius = asset.bounds.getBoundingSphere(new THREE.Sphere()).radius;
    // The frame is the widest and tallest the model gets from any of them.
    let halfW = 0; let halfH = 0;
    const p = new THREE.Vector3();
    for (let row = 0; row < ELEVATIONS.length; row++) {
      for (let col = 0; col < COLS; col++) {
        const { right, up } = frameBasis(col, row);
        for (const { geometry } of asset.primitives) {
          const pos = geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            p.fromBufferAttribute(pos, i).sub(centre);
            halfW = Math.max(halfW, Math.abs(p.dot(right)));
            halfH = Math.max(halfH, Math.abs(p.dot(up)));
          }
        }
      }
    }
    const W = halfW * 2 * 1.03; const H = halfH * 2 * 1.03;
    const fh = Math.max(64, Math.round(Math.sqrt(FRAME_AREA * H / W) / 8) * 8);
    const fw = Math.max(64, Math.round(FRAME_AREA / fh / 8) * 8);
    const atlasW = fw * COLS; const atlasH = fh * ELEVATIONS.length;
    const atlas = (colorSpace) => {
      const target = new THREE.WebGLRenderTarget(atlasW, atlasH, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
        generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
        colorSpace,
      });
      return target;
    };
    // Albedo in sRGB, for the dark greens' sake; the surface is data.
    const albedo = atlas(THREE.SRGBColorSpace);
    const surface = atlas(THREE.NoColorSpace);
    const temp = () => new THREE.WebGLRenderTarget(fw * SUPER, fh * SUPER, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    const tempA = temp(); const tempS = temp();

    const scene = new THREE.Scene();
    const meshes = asset.primitives.map(({ geometry, material }) => {
      const mesh = new THREE.Mesh(geometry, bakeMaterial(material, 0));
      mesh.userData.surface = bakeMaterial(material, 1);
      mesh.userData.albedo = mesh.material;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    });
    const camera = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 0.05, radius * 4);

    const previous = renderer.getRenderTarget();
    const clear = renderer.getClearColor(new THREE.Color()); const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    const shadows = renderer.shadowMap.needsUpdate;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    for (const target of [albedo, surface]) { renderer.setRenderTarget(target); renderer.clear(true, false, false); }
    for (let row = 0; row < ELEVATIONS.length; row++) {
      for (let col = 0; col < COLS; col++) {
        const { dir } = frameBasis(col, row);
        camera.position.copy(centre).addScaledVector(dir, radius * 2);
        camera.up.set(0, 1, 0);
        camera.lookAt(centre);
        camera.updateMatrixWorld();
        for (const m of meshes) m.material = m.userData.albedo;
        renderer.setRenderTarget(tempA);
        renderer.render(scene, camera);
        for (const m of meshes) m.material = m.userData.surface;
        renderer.setRenderTarget(tempS);
        renderer.render(scene, camera);
        pack.uniforms.albedoT.value = tempA.texture;
        pack.uniforms.surfaceT.value = tempS.texture;
        pack.uniforms.origin.value.set(col * fw, row * fh);
        renderer.autoClear = false;
        for (const [target, mode] of [[albedo, 0], [surface, 1]]) {
          pack.uniforms.mode.value = mode;
          target.viewport.set(col * fw, row * fh, fw, fh);
          target.scissor.set(col * fw, row * fh, fw, fh);
          target.scissorTest = true;
          renderer.setRenderTarget(target);
          renderer.render(packScene, packCamera);
          target.scissorTest = false;
          target.viewport.set(0, 0, atlasW, atlasH);
        }
        renderer.autoClear = true;
      }
    }
    renderer.setRenderTarget(previous);
    renderer.setClearColor(clear, clearAlpha);
    renderer.autoClear = autoClear;
    renderer.shadowMap.needsUpdate = shadows;
    tempA.dispose(); tempS.dispose();
    for (const m of meshes) { m.userData.albedo.dispose(); m.userData.surface.dispose(); }

    return { name, centre, W, H, fw, fh, atlasW, atlasH, albedo: albedo.texture, surface: surface.texture, targets: [albedo, surface] };
  }

  // ------------------------------------------------------ the materials ----

  /** How metallic a surface is on average: the cards have no map to read it from. */
  function meanMetalness(material) {
    const data = material.metalnessMap?.image?.data;
    if (!data) return material.metalness;
    let sum = 0;
    for (let i = 2; i < data.length; i += 4) sum += data[i];
    return material.metalness * (sum / (data.length / 4) / 255);
  }

  function cardUniforms(model) {
    return {
      impAlbedo: { value: model.albedo },
      impSurface: { value: model.surface },
      impCentre: { value: model.centre },
      impSize: { value: new THREE.Vector2(model.W, model.H) },
      impGrid: { value: new THREE.Vector4(COLS, ELEVATIONS.length, THREE.MathUtils.degToRad(ELEVATIONS[0]),
        THREE.MathUtils.degToRad(ELEVATIONS[1] - ELEVATIONS[0])) },
      impAtlas: { value: new THREE.Vector2(model.atlasW, model.atlasH) },
      impCut: { value: CUT },
      lodFade: fade,
    };
  }

  function injectCard(shader, uniforms, what) {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <common>', `#include <common>\n${IMP_VERTEX_PARS}`, what);
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <beginnormal_vertex>', IMP_VERTEX_MAIN, what);
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <begin_vertex>', 'vec3 transformed = impPosition;', what);
  }

  /** The card, lit: the tree's own foliage material with the atlas in place of its maps. */
  function cardMaterial(model, base) {
    const material = base.clone();
    material.name = `${base.name}-impostor`;
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap', 'emissiveMap', 'bumpMap']) material[slot] = null;
    material.alphaTest = 0;
    material.side = THREE.FrontSide;
    material.shadowSide = null;
    material.vertexColors = false;
    material.roughness = 1;
    material.metalness = meanMetalness(base);
    material.defines = { ...base.defines };
    delete material.defines.DIKU_DETAIL;
    material.defaultAttributeValues = base.defaultAttributeValues;
    material.userData = { foliage: true, aoMaterial: cardNormal(model) };
    const uniforms = cardUniforms(model);
    material.onBeforeCompile = chain(base, (shader) => {
      injectCard(shader, uniforms, 'card');
      let f = shader.fragmentShader;
      f = replaceOnce(f, '#include <common>', `#include <common>\n${IMP_FRAG_PARS}`, 'card');
      f = replaceOnce(f, '#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${IMP_FRAG_MAIN}`, 'card');
      f = replaceOnce(f, '#include <map_fragment>', 'diffuseColor.rgb *= impAlbedoC;', 'card');
      f = replaceOnce(f, '#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * impRough;', 'card');
      f = replaceOnce(f, '#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n\tnormal = impNormalV;', 'card');
      shader.fragmentShader = f;
    });
    const key = base.customProgramCacheKey.bind(base);
    material.customProgramCacheKey = () => `impostor|${key()}`;
    return material;
  }

  /** The card in the AO prepass: its own normals and cut, same dissolve. */
  function cardNormal(model) {
    const material = new THREE.MeshNormalMaterial();
    material.blending = THREE.NoBlending;
    material.allowOverride = false;
    const uniforms = cardUniforms(model);
    material.onBeforeCompile = (shader) => {
      injectCard(shader, uniforms, 'card prepass');
      let f = shader.fragmentShader;
      f = replaceOnce(f, 'uniform float opacity;', `uniform float opacity;\n${IMP_FRAG_PARS}`, 'card prepass');
      f = replaceOnce(f, '#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${IMP_FRAG_MAIN}`, 'card prepass');
      f = replaceOnce(f, '#include <normal_fragment_maps>', 'normal = impNormalV;', 'card prepass');
      shader.fragmentShader = f;
    };
    material.customProgramCacheKey = () => 'impostor-normal';
    return material;
  }

  function injectFade(shader, what) {
    shader.uniforms.lodFade = fade;
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <common>',
      '#include <common>\nuniform vec2 lodFade;\nvarying float vLodFade;', what);
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>\n${FADE_VERTEX}`, what);
  }

  /** The full tree's prepass material: cut by its alpha if it has any, and dissolved like it. */
  function fadeNormal(source) {
    const material = new THREE.MeshNormalMaterial({ side: source.side });
    material.blending = THREE.NoBlending;
    material.allowOverride = false;
    const cut = source.alphaTest > 0 && source.map;
    material.onBeforeCompile = (shader) => {
      injectFade(shader, 'tree prepass');
      if (cut) {
        shader.uniforms.foliageMap = { value: source.map };
        shader.uniforms.foliageCut = { value: source.alphaTest };
        shader.vertexShader = shader.vertexShader
          .replace('uniform vec2 lodFade;', 'uniform vec2 lodFade;\nvarying vec2 vFoliageUv;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvFoliageUv = uv;');
      }
      shader.fragmentShader = replaceOnce(shader.fragmentShader, 'uniform float opacity;',
        `uniform float opacity;\nvarying float vLodFade;\n${DITHER}${cut ? 'uniform sampler2D foliageMap;\nuniform float foliageCut;\nvarying vec2 vFoliageUv;' : ''}`, 'tree prepass');
      shader.fragmentShader = replaceOnce(shader.fragmentShader, '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n\tif ( vLodFade > dikuDither() ) discard;${cut ? '\n\tif ( texture2D( foliageMap, vFoliageUv ).a < foliageCut ) discard;' : ''}`, 'tree prepass');
    };
    material.customProgramCacheKey = () => `lod-normal|${cut ? 1 : 0}`;
    return material;
  }

  /** The material a far-drawn model's full meshes wear: its own, dissolving past `start`. */
  function twin(base) {
    let material = twins.get(base);
    if (material) return material;
    material = base.clone();
    material.name = `${base.name}-lod`;
    material.defines = { ...base.defines, DIKU_LOD_FADE: 1 };
    material.defaultAttributeValues = base.defaultAttributeValues;
    material.userData = { ...base.userData, foliage: true, aoMaterial: fadeNormal(base), lodBase: base };
    delete material.userData.wetnessUniform;
    material.onBeforeCompile = chain(base, (shader) => {
      injectFade(shader, 'tree');
      shader.fragmentShader = replaceOnce(shader.fragmentShader, '#include <common>',
        `#include <common>\nvarying float vLodFade;\n${DITHER}`, 'tree');
      shader.fragmentShader = replaceOnce(shader.fragmentShader, '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n\tif ( vLodFade > dikuDither() ) discard;', 'tree');
    });
    const key = base.customProgramCacheKey.bind(base);
    material.customProgramCacheKey = () => `${key()}|lod`;
    twins.set(base, material);
    return material;
  }

  // ------------------------------------------------------------ cards ----

  function cardMesh(model, capacity) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const at = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const yaw = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aImpostor', at);
    geometry.setAttribute('aImpostorYaw', yaw);
    geometry.instanceCount = 0;
    // Never used for culling -- the mesh is filled with visible cards only --
    // but three asks for one.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mesh = new THREE.Mesh(geometry, model.material);
    mesh.name = `impostors ${model.name}`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    return mesh;
  }

  // ------------------------------------------------------------- setup ----

  for (const name of IMPOSTOR_MODELS) {
    const asset = library.get(name);
    if (!asset) continue;
    const baked = bake(name, asset);
    const base = (asset.primitives.find((p) => FOLIAGE.test(p.materialName)) || asset.primitives[0]).material;
    const model = { ...baked, asset, sources: [], mesh: null, n: 0, changed: false };
    model.material = cardMaterial(model, base);
    models.set(name, model);
    asset.primitives.forEach((p, index) => byGeometry.set(p.geometry, { model, primary: index === 0 }));
  }

  /**
   * Put the far-drawn models' instanced meshes on their dissolving twins and
   * give each model its card mesh, sized for every copy in the world.
   */
  function adopt(root) {
    const capacity = new Map();
    root.traverse((o) => {
      if (!o.isInstancedMesh || !o.userData.cullable) return;
      const lod = byGeometry.get(o.geometry);
      if (!lod) return;
      // Adopted again when a vista joins the scene (vista.js): a twin's twin
      // would dissolve twice.
      if (!o.userData.lod) o.material = twin(o.material);
      o.userData.lod = lod;
      if (lod.primary) capacity.set(lod.model, (capacity.get(lod.model) || 0) + o.count);
    });
    for (const [model, n] of capacity) {
      model.mesh = cardMesh(model, n);
      group.add(model.mesh);
    }
    root.add(group);
  }

  /**
   * The zone whose trees these cards stood in for is going (main.js crossTo):
   * each card mesh, sized for that zone's copies, is dropped. `adopt` the
   * next zone's to make new ones; the baked atlases and twins are kept.
   */
  function release() {
    for (const model of models.values()) {
      if (!model.mesh) continue;
      group.remove(model.mesh);
      model.mesh.geometry.dispose();
      model.mesh = null;
      model.n = 0;
    }
  }

  /** Materials this owns and a zone's teardown must leave alone. */
  function owns(material) {
    for (const twin of twins.values()) if (twin === material) return true;
    for (const model of models.values()) if (model.material === material) return true;
    return false;
  }

  // Filled by cull.js each frame, one model at a time.
  function begin(model) { model.n = 0; model.changed = false; }
  function push(model, x, y, z, scale, yaw) {
    const at = model.mesh.geometry.attributes.aImpostor.array;
    const turn = model.mesh.geometry.attributes.aImpostorYaw.array;
    const i = model.n++;
    const o = i * 4;
    if (at[o] !== x || at[o + 1] !== y || at[o + 2] !== z || at[o + 3] !== scale || turn[i] !== yaw) {
      at[o] = x; at[o + 1] = y; at[o + 2] = z; at[o + 3] = scale; turn[i] = yaw;
      model.changed = true;
    }
  }
  /** `push` from `feet[f..f+4]`: no doubles boxed for the call. */
  function pushFrom(model, feet, f) {
    const at = model.mesh.geometry.attributes.aImpostor.array;
    const turn = model.mesh.geometry.attributes.aImpostorYaw.array;
    const i = model.n++;
    const o = i * 4;
    if (at[o] !== feet[f] || at[o + 1] !== feet[f + 1] || at[o + 2] !== feet[f + 2] || at[o + 3] !== feet[f + 3] || turn[i] !== feet[f + 4]) {
      at[o] = feet[f]; at[o + 1] = feet[f + 1]; at[o + 2] = feet[f + 2]; at[o + 3] = feet[f + 3]; turn[i] = feet[f + 4];
      model.changed = true;
    }
  }
  function finish(model) {
    const geometry = model.mesh.geometry;
    if (model.n !== geometry.instanceCount) model.changed = true;
    geometry.instanceCount = model.n;
    model.mesh.visible = model.n > 0;
    if (!model.changed || !model.n) return;
    for (const [name, size] of [['aImpostor', 4], ['aImpostorYaw', 1]]) {
      const attribute = geometry.attributes[name];
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, model.n * size);
      attribute.needsUpdate = true;
    }
  }

  return {
    models, group, fade, adopt, release, owns, begin, push, pushFrom, finish,
    get enabled() { return enabled; },
    /** `?lod=off`, or a range: where the cards take over, and where they have. */
    setEnabled(on) {
      enabled = on;
      // Off, the full trees must not dissolve either: push the fade out of the world.
      fade.value.set(on ? range[0] : 1e9, on ? range[1] : 2e9);
      if (!on) for (const m of models.values()) if (m.mesh) { m.mesh.geometry.instanceCount = 0; m.mesh.visible = false; }
    },
    setRange(start, end) { range = [start, end]; if (enabled) fade.value.set(start, end); },
    get near() { return enabled ? range[0] : Infinity; },
    get far() { return enabled ? range[1] : Infinity; },
    /** The twins follow their originals' close-range detail switch. */
    sync() {
      for (const [base, material] of twins) {
        const want = !!base.defines?.DIKU_DETAIL;
        if (!!material.defines.DIKU_DETAIL === want) continue;
        if (want) material.defines.DIKU_DETAIL = 1; else delete material.defines.DIKU_DETAIL;
        material.needsUpdate = true;
      }
    },
  };
}
