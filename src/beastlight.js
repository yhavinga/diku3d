/**
 * The light a person stands in, for an animal.
 *
 * A modelled beast wears the world's own baked materials (actors.js
 * `buildModelledBeast`): fur, hide, horn. Out of doors that is right -- the
 * sun and the sky light it as they light the grass -- but indoors a world
 * surface has nothing standing in for the sun, and a creature in the middle of
 * a torch-lit hall is out of reach of every torch: the Mud School's boar, fox,
 * bear and wolf metered RGB 0-5 on their flanks against walls at 80-140, black
 * cut-outs of animals. People had the same fault and dress.js fixed it with a
 * fill that is a share of the light already at the spot (FIGURE_FILL, see the
 * comment there). This is that fill, laid on a beast's materials: a per-figure
 * copy of each, its `indoor` uniform eased by actors.js as the animal walks in
 * and out (the same `easeIndoor` that eases a person's), and after dark out of
 * doors the same OUTDOOR_FILL.
 *
 * The copy runs the original material's hook first -- decorate(), honourEnv(),
 * a buried twin's -- and adds to what it produced, so a beast underground is
 * still lit as the sewer is and a wet hide still glistens. One program per
 * original (the cache key says so); the uniforms are the figure's own.
 */

import * as THREE from 'three';
import { FIGURE_FILL, OUTDOOR_FILL } from './dress.js';

const POINT_LINE = 'getPointLightInfo( pointLight, geometryPosition, directLight );';

const DECLS = `
uniform float dikuBeastIndoor;
uniform float dikuBeastFill;
uniform float dikuBeastOutdoor;
vec3 dikuBeastTorch;`;

// As dress.js's fill: a share of the sky, the hemisphere and half of what
// the torches deliver here, from just above the viewer's eye, wrapped a
// little, warm-neutral.
const FILL = `
  {
    float dikuBeastAmb = dot( iblIrradiance + irradiance + 0.5 * dikuBeastTorch, vec3( 0.2126, 0.7152, 0.0722 ) );
    float dikuBeastWrap = clamp( ( dot( geometryNormal, normalize( vec3( 0.25, 0.45, 1.0 ) ) ) + 0.3 ) / 1.3, 0.0, 1.0 );
    irradiance += vec3( 1.04, 1.0, 0.94 ) * ( dikuBeastFill * max( dikuBeastIndoor, dikuBeastOutdoor ) * dikuBeastAmb * dikuBeastWrap );
  }
  #include <lights_fragment_end>`;

/**
 * A copy of `material` that takes the figure fill, by `indoor` ({ value } in
 * 0..1). Anything that is not a standard material (the glowing eyes) is
 * returned as it is.
 */
export function litBeast(material, indoor) {
  if (!material || !material.isMeshStandardMaterial) return material;
  const base = material;
  const lit = base.clone();
  lit.name = base.name;
  // A clone keeps none of these (CLAUDE.md): the defines say buried and
  // sunless, the attribute defaults stand in for what a glTF lacks.
  lit.defines = { ...base.defines };
  lit.defaultAttributeValues = base.defaultAttributeValues;
  lit.onBeforeRender = base.onBeforeRender;
  const baseKey = base.customProgramCacheKey.bind(base);
  lit.onBeforeCompile = (shader, renderer) => {
    // decorate() files its wetness uniform on the material it closes over;
    // compiling the copy must not take the original's rain away (as
    // textures.js buriedTwin).
    const keep = base.userData.wetnessUniform;
    base.onBeforeCompile(shader, renderer);
    if (keep) base.userData.wetnessUniform = keep;
    shader.uniforms.dikuBeastIndoor = indoor;
    shader.uniforms.dikuBeastFill = FIGURE_FILL;
    shader.uniforms.dikuBeastOutdoor = OUTDOOR_FILL;
    let frag = shader.fragmentShader;
    if (frag.includes('#include <lights_fragment_begin>')) {
      frag = frag.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin);
    }
    frag = frag
      .replace('#include <common>', `#include <common>\n${DECLS}`)
      .replace('void main() {', 'void main() {\n\tdikuBeastTorch = vec3( 0.0 );')
      .replace(POINT_LINE, `${POINT_LINE}\n\t\tdikuBeastTorch += directLight.visible ? directLight.color : vec3( 0.0 );`)
      .replace('#include <lights_fragment_end>', FILL);
    if (!frag.includes('dikuBeastTorch +=') || !frag.includes('dikuBeastWrap') || !frag.includes('dikuBeastTorch = vec3')) {
      throw new Error(`beastlight: the figure fill missed on ${base.name || base.type}`);
    }
    shader.fragmentShader = frag;
  };
  lit.customProgramCacheKey = () => `${baseKey()}|beastfill`;
  return lit;
}
