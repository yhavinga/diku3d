/**
 * How a frame is put together: the environment probe that lights everything,
 * the post-processing chain, and the two effects that are ours rather than
 * three's.
 *
 * `quality.js` decides which of these run and how big they are. This file is
 * what they *are*.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const TAU = Math.PI * 2;

// ------------------------------------------------------------ environment --

/**
 * The sky, baked into a prefiltered cube and hung on `scene.environment`.
 *
 * Without this every material is lit by a hemisphere light -- one colour from
 * above, one from below, no direction to it -- which is why untextured surfaces
 * read as plastic. A real sky has a bright band near the sun, a dark zenith and
 * a warm ground bounce, and a roughness-filtered cube of it gives every
 * material a specular response that changes as you walk round it.
 *
 * It costs nothing per frame; the cube is regenerated only when the sun moves.
 */
export class SkyEnvironment {
  constructor(renderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.scene = new THREE.Scene();

    // Its own sky, not the one in the world: baking must not depend on where
    // the visible sky happens to be in the frame it is called from.
    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    // Same cap as the visible sky: an unbounded sun disc in the cube becomes a
    // hot spot that double-counts with the directional light.
    clampSkyHighlights(this.sky, 60);
    this.scene.add(this.sky);

    // The sky shader has nothing to say below the horizon. Leave that black and
    // every overhang, arch and underside in the town is lit from above only --
    // which is most of the flat, floating look this exists to fix. So: a dome
    // of bounced ground light, fading out at the rim so the horizon has no seam
    // to show up in the low-roughness reflections.
    const R = 600;
    const dome = new THREE.SphereGeometry(R, 24, 10, 0, TAU, Math.PI / 2 - 0.14, Math.PI / 2 + 0.14);
    dome.setAttribute('color', new THREE.BufferAttribute(
      new Float32Array(dome.attributes.position.count * 4), 4,
    ));
    this.domeRadius = R;
    this.ground = new THREE.Mesh(dome, new THREE.MeshBasicMaterial({
      side: THREE.BackSide, vertexColors: true, transparent: true,
      depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    }));
    this.ground.renderOrder = 1; // over the sky, wherever it covers it
    this.scene.add(this.ground);

    this.target = null;
    this._c = new THREE.Color();
    this._ground = new THREE.Color();
    this._horizon = new THREE.Color();
  }

  /** Vertical gradient down the dome: horizon haze into lit ground. */
  paintGround(groundHex, horizonHex) {
    const position = this.ground.geometry.attributes.position;
    const colour = this.ground.geometry.attributes.color;
    this._ground.setHex(groundHex);
    this._horizon.setHex(horizonHex);
    for (let i = 0; i < position.count; i++) {
      const drop = -position.getY(i) / this.domeRadius; // 0 at the rim, 1 straight down
      const t = THREE.MathUtils.smoothstep(drop, 0.0, 0.5);
      this._c.copy(this._horizon).lerp(this._ground, t);
      colour.setXYZW(i, this._c.r, this._c.g, this._c.b, t);
    }
    colour.needsUpdate = true;
  }

  /**
   * Rebake and hang the result on the scene. Call this off the frame loop --
   * it renders six faces and a blur chain, which is a few milliseconds.
   */
  update(scene, options) {
    const uniforms = this.sky.material.uniforms;
    uniforms.sunPosition.value.copy(options.sunPosition);
    uniforms.turbidity.value = options.turbidity;
    uniforms.rayleigh.value = options.rayleigh;
    uniforms.mieCoefficient.value = options.mieCoefficient;
    uniforms.mieDirectionalG.value = options.mieDirectionalG;
    this.paintGround(options.ground, options.horizon);

    const next = this.pmrem.fromScene(this.scene, 0, 1, 20000);
    if (this.target) this.target.dispose();
    this.target = next;
    scene.environment = next.texture;
    scene.environmentIntensity = options.intensity;
    return next.texture;
  }

  dispose() {
    if (this.target) this.target.dispose();
    this.pmrem.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
  }
}

/**
 * Hold the sky to a sane maximum.
 *
 * The sun disc comes out of the sky shader at around 17,000 in linear HDR.
 * Nothing in the chain minds that except the bloom, whose bright pass has no
 * ceiling: one such pixel, spread through the mip chain and multiplied by the
 * bloom strength, whites out the entire street. The tone mapper clips anything
 * past about 3 to white regardless, so capping the sky costs nothing you can
 * see and gives the bloom a glow it can bound. Hue is preserved -- the whole
 * colour is scaled, not clipped per channel.
 */
export function clampSkyHighlights(sky, ceiling = 60) {
  sky.material.onBeforeCompile = (shader) => {
    shader.uniforms.skyCeiling = { value: ceiling };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float skyCeiling;\n\t\t\tvoid main() {')
      .replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        'float skyPeak = max( max( texColor.r, texColor.g ), texColor.b );\n'
        + '\t\t\ttexColor *= skyCeiling / max( skyCeiling, skyPeak );\n'
        + '\t\t\tgl_FragColor = vec4( texColor, 1.0 );',
      );
  };
  sky.material.needsUpdate = true;
}

// ------------------------------------------------------------ light shafts --

const ShaftShader = {
  name: 'LightShaftShader',
  defines: { SAMPLES: 20 },
  uniforms: {
    tDiffuse: { value: null },
    sunUv: { value: new THREE.Vector2(0.5, 0.5) },
    density: { value: 0.8 },
    decay: { value: 0.94 },
    threshold: { value: 8.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec2 sunUv;
    uniform float density;
    uniform float decay;
    uniform float threshold;

    void main() {
      vec2 stride = (vUv - sunUv) * (density / float(SAMPLES));
      vec2 uv = vUv;
      float illumination = 1.0;
      vec3 sum = vec3(0.0);
      for (int i = 0; i < SAMPLES; i++) {
        uv -= stride;
        vec3 c = texture2D(tDiffuse, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
        // This runs before tone mapping, where nothing in the town gets near
        // the brightness of open sky. So a luminance cut *is* the sky mask,
        // and the roofline does the occluding for free.
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        sum += c * smoothstep(threshold, threshold * 2.4, lum) * illumination;
        illumination *= decay;
      }
      gl_FragColor = vec4(sum / float(SAMPLES), 1.0);
    }`,
};

const ShaftBlendShader = {
  name: 'LightShaftBlendShader',
  uniforms: {
    tShaft: { value: null },
    tint: { value: new THREE.Color(1, 1, 1) },
    intensity: { value: 0 },
    sunUv: { value: new THREE.Vector2(0.5, 0.5) },
    aspect: { value: 1 },
  },
  vertexShader: ShaftShader.vertexShader,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tShaft;
    uniform vec3 tint;
    uniform float intensity;
    uniform vec2 sunUv;
    uniform float aspect;
    void main() {
      // Shafts belong around the sun. Without this the radial blur happily
      // smears bright sky across the whole frame the moment the sun goes
      // off-screen, which reads as a dirty lens rather than as light.
      float reach = length((vUv - sunUv) * vec2(aspect, 1.0));
      float near = 1.0 - smoothstep(0.12, 0.85, reach);
      gl_FragColor = vec4(texture2D(tShaft, vUv).rgb * tint * (intensity * near), 1.0);
    }`,
};

/**
 * Radial-blur god rays from the sun: a couple of dozen taps at a third of the
 * render resolution, then added straight into the frame. Measured at 0.26 ms
 * on `high` -- and at a low sun in a narrow street it is the single most
 * atmospheric thing in the picture.
 *
 * It switches itself off above about 22 degrees of elevation, once the sun is
 * under the horizon, when you turn away from it, and when it drifts far enough
 * off screen. Shafts at noon look like a lens fault.
 */
export class LightShaftPass extends Pass {
  constructor(width, height, scale = 0.34) {
    super();
    this.scale = scale;
    this.allowed = false;
    this.enabled = false;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    this.shaft = new THREE.ShaderMaterial({
      defines: { ...ShaftShader.defines },
      uniforms: THREE.UniformsUtils.clone(ShaftShader.uniforms),
      vertexShader: ShaftShader.vertexShader,
      fragmentShader: ShaftShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    // Added straight into the frame that is already there, rather than copying
    // it through: at full resolution that copy cost more than the blur did.
    this.needsSwap = false;
    this.blend = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(ShaftBlendShader.uniforms),
      vertexShader: ShaftBlendShader.vertexShader,
      fragmentShader: ShaftBlendShader.fragmentShader,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });

    this.quad = new FullScreenQuad(null);
    this._sun = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this.setSize(width, height);
  }

  setSize(width, height) {
    this.target.setSize(
      Math.max(2, Math.round(width * this.scale)),
      Math.max(2, Math.round(height * this.scale)),
    );
    this.blend.uniforms.aspect.value = width / height;
  }

  setSamples(count) {
    if (this.shaft.defines.SAMPLES === count) return;
    this.shaft.defines.SAMPLES = count;
    this.shaft.needsUpdate = true;
  }

  /**
   * Point the rays at the sun and decide whether they are worth drawing:
   * fades out as the sun climbs, as it swings behind you, and once it has set.
   */
  aim(camera, sunDirection, elevationDegrees, tint, gain = 1) {
    let strength = gain;
    // Low sun only. Full below 8 degrees, gone by 22.
    strength *= 1 - THREE.MathUtils.smoothstep(elevationDegrees, 8, 22);
    // And nothing once it is under the horizon, where there is no disc to
    // stream off and the mask would just smear the afterglow.
    strength *= THREE.MathUtils.smoothstep(elevationDegrees, -3.5, 1.5);

    camera.getWorldDirection(this._forward);
    const facing = this._forward.dot(sunDirection);
    strength *= THREE.MathUtils.smoothstep(facing, -0.15, 0.35);

    this._sun.copy(sunDirection).multiplyScalar(500).add(camera.position).project(camera);
    const u = this._sun.x * 0.5 + 0.5;
    const v = this._sun.y * 0.5 + 0.5;
    // Off-screen sun still throws rays into the frame, but only just off.
    const outside = Math.max(0, Math.abs(u - 0.5) - 0.5, Math.abs(v - 0.5) - 0.5);
    strength *= 1 - THREE.MathUtils.smoothstep(outside, 0.05, 0.45);

    if (strength > 0.001) {
      this.shaft.uniforms.sunUv.value.set(u, v);
      this.blend.uniforms.sunUv.value.set(u, v);
      this.blend.uniforms.intensity.value = strength;
      this.blend.uniforms.tint.value.copy(tint);
    }
    this.enabled = this.allowed && strength > 0.001;
    return strength;
  }

  render(renderer, writeBuffer, readBuffer) {
    const previous = renderer.getRenderTarget();

    this.shaft.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.shaft;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);

    // Added on top of the frame already in the read buffer, so autoClear has to
    // be off -- a full-screen quad through `renderer.render` would otherwise
    // wipe the town and leave nothing but the rays.
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.blend.uniforms.tShaft.value = this.target.texture;
    this.quad.material = this.blend;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);
    renderer.autoClear = autoClear;

    renderer.setRenderTarget(previous);
  }

  dispose() {
    this.target.dispose();
    this.shaft.dispose();
    this.blend.dispose();
    this.quad.dispose();
  }
}

// -------------------------------------------------------------------- AO ----

/**
 * GTAO with a resolution of its own. The pass re-renders the scene into a
 * normal/depth buffer, so its cost tracks the size it is asked for and not the
 * size of the frame; half resolution is indistinguishable after the denoise.
 */
class ScaledGTAOPass extends GTAOPass {
  constructor(scene, camera, width, height, scale) {
    super(scene, camera, Math.round(width * scale), Math.round(height * scale));
    this.scale = scale;
  }

  setSize(width, height) {
    super.setSize(
      Math.max(2, Math.round(width * this.scale)),
      Math.max(2, Math.round(height * this.scale)),
    );
  }
}

// -------------------------------------------------------------- pipeline ----

/**
 * The chain, in order. Everything after the render pass can be switched off
 * without disturbing what is left, which is what `quality.js` does with them.
 *
 * AO goes before the bloom on purpose: a corner that the AO has just darkened
 * should not still be feeding the bloom as if it were lit.
 */
export function createPipeline({ renderer, scene, camera, width, height }) {
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(width, height, {
    samples: 0, type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace,
  }));

  const render = new RenderPass(scene, camera);

  const gtao = new ScaledGTAOPass(scene, camera, width, height, 0.5);
  gtao.enabled = false;
  gtao.blendIntensity = 1;
  // `radius` and `thickness` are world metres, and the town's grid pitch is
  // 13m with 5.2m ceilings -- so the interesting question here is "how much of
  // the sky can this doorway see", which is a six-metre question, not the
  // half-metre crease AO is usually asked for. `scale` is an exponent on the
  // result, not a gain: at 1.0 the buffer comes out very nearly white.
  gtao.updateGtaoMaterial({
    radius: 6, distanceExponent: 1, thickness: 12,
    distanceFallOff: 1, scale: 4.5, samples: 16, screenSpaceRadius: false,
  });
  gtao.updatePdMaterial({ lumaPhi: 6, depthPhi: 2.5, normalPhi: 3.5, radius: 5, rings: 2, samples: 8 });

  const shafts = new LightShaftPass(width, height);

  // The threshold is set per time of day in main.js, and it has to be well
  // above 1: this buffer is linear HDR, where open sky at dusk runs into the
  // tens and a threshold near 1 blooms the entire sky over the whole street.
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.25, 0.55, 2.8);

  // SMAA works in linear-srgb, so it has to sit ahead of the output pass.
  const smaa = new SMAAPass();
  smaa.enabled = false;

  const output = new OutputPass();

  composer.addPass(render);
  composer.addPass(gtao);
  composer.addPass(shafts);
  composer.addPass(bloom);
  composer.addPass(smaa);
  composer.addPass(output);

  return { composer, render, gtao, shafts, bloom, smaa, output };
}
