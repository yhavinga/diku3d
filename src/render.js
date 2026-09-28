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
    //
    // And the same *floor*, which is not a nicety either. This setter used to
    // be thrown away here while the visible sky kept its own, so after dark the
    // sky you could see was deep blue and the sky everything was lit by was
    // black. Nothing outdoors had any ambient at all: measured, 10.8% of the
    // Temple Square at night came out at literally RGB 0.
    this.range = clampSkyHighlights(this.sky, 60);
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
    // The stock cloud layer, same dials and same defaults as the visible sky
    // -- this is a second Sky, and anything set on one has to be set on both.
    uniforms.cloudCoverage.value = options.stockCloud?.[0] ?? 0.4;
    uniforms.cloudDensity.value = options.stockCloud?.[1] ?? 0.4;
    this.range.setFloor(options.skyFloor ?? 0x000000, options.skyFloorGain ?? 0);
    // The same cloud the sky outside has, so what the town is lit by matches
    // what is over it.
    if (options.cloud) this.range.setCloud(...options.cloud);
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
/**
 * Cloud, in the sky shader rather than on geometry.
 *
 * A Preetham sky is a clean gradient and an empty one, and an empty sky is the
 * easiest tell there is in an outdoor frame -- no shape, no scale, nothing for
 * the eye to measure distance against. This is five octaves of value noise on
 * the plane the view direction cuts at cloud height, thresholded into cover.
 *
 * The cloud colour is derived from the sky it is drawn over rather than set as
 * a colour of its own, so it needs no tuning per hour: a cloud is the local sky
 * desaturated towards its own luminance and gained up. At noon that is white
 * against blue, at dusk it is orange against orange, and after dark it is a
 * slightly paler blue-violet, all for free.
 *
 * It is deliberately still. Drifting it would mean a uniform write per frame on
 * a material that is also used to bake the environment, and a sky that moves
 * while the light on the town does not is worse than a sky that does not move.
 */
const SKY_CLOUD = /* glsl */`
  float cloudHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float cloudNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(cloudHash(i), cloudHash(i + vec2(1.0, 0.0)), f.x),
               mix(cloudHash(i + vec2(0.0, 1.0)), cloudHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float cloudFbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * cloudNoise(p); p *= 2.07; a *= 0.5; }
    return v;
  }`;

export function clampSkyHighlights(sky, ceiling = 60) {
  // The other end of the same problem. With the sun below the horizon the
  // shader returns very nearly zero everywhere, so night was RGB 0,0,0 and
  // every roofline was a matte cut against void. A real night sky is deep
  // blue-violet with a brighter band low down, and that band is the only thing
  // a silhouette has to be read against. `skyFloor` is that band; it is a
  // floor, not an add, so it does nothing at all once the sun is up.
  const floor = new THREE.Vector3(0, 0, 0);
  // x: cover threshold (higher is less cloud), y: how much of it to believe,
  // z: gain over the sky behind it, w: drift, so the two skies are not identical
  const cloud = new THREE.Vector4(0.62, 0.85, 1.9, 0);
  // The cap for everything but the sun's disc and a hair round it. At a low
  // sun the whole quarter of sky around it sits at the ceiling, over the
  // bloom threshold, and the bloom spread it across half the frame: facing
  // the setting sun over the bog, the right half read 182 of luma, a flat
  // haze, and 121 with the bloom off. Past exposure and ACES that sky is
  // white either way, so capping it below the threshold changes the sky by
  // nothing you can see and takes the veil away; the disc keeps its glow.
  const broad = { value: ceiling };
  sky.material.onBeforeCompile = (shader) => {
    shader.uniforms.skyCeiling = { value: ceiling };
    shader.uniforms.skyBroad = broad;
    shader.uniforms.skyFloor = { value: floor };
    shader.uniforms.skyCloud = { value: cloud };
    sky.material.userData.skyFloor = shader.uniforms.skyFloor;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        `uniform float skyCeiling;\n\t\t\tuniform float skyBroad;\n\t\t\tuniform vec3 skyFloor;\n\t\t\tuniform vec4 skyCloud;\n${SKY_CLOUD}\n\t\t\tvoid main() {`)
      .replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        '\t\t\tvec3 skyDir = normalize( vWorldPosition - cameraPosition );\n'
        // Cloud first, so the ceiling below caps it too. Applied after the cap
        // it multiplied a value already at 60 by its own gain, put the whole
        // sky over the bloom threshold, and lifted 52% of the frame.
        + '\t\t\tfloat up = skyDir.y;\n'
        + '\t\t\tif ( up > 0.015 && skyCloud.y > 0.001 ) {\n'
        + '\t\t\t\tvec2 cp = skyDir.xz / up * 0.55 + vec2( skyCloud.w, skyCloud.w * 0.7 );\n'
        + '\t\t\t\tfloat n = cloudFbm( cp );\n'
        + '\t\t\t\tfloat cover = smoothstep( skyCloud.x, skyCloud.x + 0.20, n );\n'
        // The projection stretches without bound towards the horizon; fade it
        // out before it turns into streaks lying on the rooftops.
        + '\t\t\t\tcover *= smoothstep( 0.015, 0.20, up );\n'
        + '\t\t\t\tfloat lum = dot( texColor, vec3( 0.2126, 0.7152, 0.0722 ) );\n'
        + '\t\t\t\tvec3 cloudCol = mix( vec3( lum ), texColor, 0.35 ) * skyCloud.z * ( 0.62 + 0.7 * n );\n'
        // A full deck is brightest at the zenith -- CIE overcast puts it at
        // three times the horizon -- but this cloud borrows its colour from
        // the clear sky underneath, which runs the other way; measured, an
        // overcast noon came out at 0.64x. The height term restores the
        // shape, and only once the deck is fully believed (amount 1.0), so
        // fair-weather cloud is untouched.
        + '\t\t\t\tfloat deck = smoothstep( 0.97, 1.0, skyCloud.y );\n'
        + '\t\t\t\tcloudCol *= 1.0 + deck * ( 1.5 * up - 0.3 );\n'
        + '\t\t\t\ttexColor = mix( texColor, cloudCol, cover * skyCloud.y );\n'
        + '\t\t\t}\n'
        + '\t\t\tfloat skyPeak = max( max( texColor.r, texColor.g ), texColor.b );\n'
        + '\t\t\tfloat skyCap = mix( skyBroad, skyCeiling, smoothstep( 0.9990, 0.99995, dot( skyDir, vSunDirection ) ) );\n'
        + '\t\t\ttexColor *= skyCap / max( skyCap, skyPeak );\n'
        + '\t\t\tfloat skyHorizon = 1.0 - clamp( abs( skyDir.y ), 0.0, 1.0 );\n'
        + '\t\t\ttexColor = max( texColor, skyFloor * ( 0.42 + skyHorizon * skyHorizon * 1.35 ) );\n'
        + '\t\t\tgl_FragColor = vec4( texColor, 1.0 );',
      );
  };
  sky.material.needsUpdate = true;
  return {
    setFloor(hex, scale) {
      const c = new THREE.Color(hex);
      floor.set(c.r * scale, c.g * scale, c.b * scale);
    },
    setCloud(coverage, amount, gain, drift) {
      cloud.set(coverage, amount, gain, drift);
    },
    /** The cap away from the sun's disc; see `broad`. */
    setBroad(value) {
      broad.value = Math.min(ceiling, value);
    },
  };
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
 * The layer transparent overlay quads live on: name labels, the figures'
 * hand-placed contact shadows, chimney smoke.
 *
 * They must not exist for the AO prepass. That pass renders the whole scene
 * through `scene.overrideMaterial`, which ignores alpha entirely -- so a name
 * label is, to the depth and normal buffers, a solid wall floating a couple of
 * metres in front of the figure, and the AO shades whatever is genuinely
 * behind it. Measured on the composited frame at the Market Square at noon:
 * the sky around a close label came out 34 luma darker at blend 0.55 than at
 * blend 0, against 0.6 for a control patch of the same sky.
 *
 * Nothing else has to be told about the layer. None of these cast shadows, and
 * the environment bake renders a scene of its own; only the one camera that
 * draws the world needs it enabled, which `main.js` does, because `layers.set`
 * takes an object off layer 0.
 */
export const OVERLAY_LAYER = 2;


/**
 * GTAO with a resolution of its own. The pass re-renders the scene into a
 * normal/depth buffer, so its cost tracks the size it is asked for and not the
 * size of the frame; half resolution is indistinguishable after the denoise.
 */
class ScaledGTAOPass extends GTAOPass {
  constructor(scene, camera, width, height, scale) {
    super(scene, camera, Math.round(width * scale), Math.round(height * scale));
    this.scale = scale;
    this.unshaded = [];
    this.unshadedAge = Infinity;
    this.foliage = [];
    this.foliageNormals = new Map();
  }

  /**
   * The stock pass walks the whole scene every frame to find the points and
   * lines it must hide from the prepass -- eighteen thousand objects, ten
   * thousand of them bones, for eight that qualify: 2.2 ms of script a frame,
   * measured at the Shire barn. The eight are created once and toggled, so
   * the list is found again only now and then.
   */
  _overrideVisibility() {
    if (++this.unshadedAge > 90) {
      this.unshadedAge = 0;
      this.unshaded.length = 0;
      this.foliage.length = 0;
      this.scene.traverse((object) => {
        if (object.isPoints || object.isLine || object.isLine2) this.unshaded.push(object);
        else if (object.isMesh && object.material?.userData?.foliage) this.foliage.push(object);
      });
    }
    for (const object of this.unshaded) {
      if (!object.visible) continue;
      object.visible = false;
      this._visibilityCache.push(object);
    }
    // Alpha-cut foliage draws its own cut-out into the normal buffer. Under
    // the override material a needle card is the whole rectangle it is: the
    // sky between the sprays took the card's occlusion. Left out of the pass
    // altogether it was worse -- a near bough then wore the occlusion of
    // whatever stood behind it and read as a ghost.
    for (const mesh of this.foliage) {
      mesh.userData.aoSwap = mesh.material;
      mesh.material = this.foliageNormal(mesh.material);
    }
  }

  _restoreVisibility() {
    super._restoreVisibility();
    for (const mesh of this.foliage) {
      if (mesh.userData.aoSwap) mesh.material = mesh.userData.aoSwap;
      mesh.userData.aoSwap = null;
    }
  }

  /** The override's own normal material, cut by the foliage's alpha. */
  foliageNormal(source) {
    // Grass brings its own prepass material (grass.js), which keeps it out.
    if (source.userData.aoMaterial) return source.userData.aoMaterial;
    let material = this.foliageNormals.get(source);
    if (material) return material;
    material = new THREE.MeshNormalMaterial({ side: source.side });
    material.blending = THREE.NoBlending;
    // Exempt from the scene's override, or the pass would swap it straight
    // back for the uncut one.
    material.allowOverride = false;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.foliageMap = { value: source.map };
      shader.uniforms.foliageCut = { value: source.alphaTest };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFoliageUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvFoliageUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float opacity;', 'uniform float opacity;\nuniform sampler2D foliageMap;\nuniform float foliageCut;\nvarying vec2 vFoliageUv;')
        .replace('#include <normal_fragment_begin>',
          'if ( texture2D( foliageMap, vFoliageUv ).a < foliageCut ) discard;\n\t#include <normal_fragment_begin>');
    };
    material.customProgramCacheKey = () => 'foliage-normal';
    this.foliageNormals.set(source, material);
    return material;
  }

  setSize(width, height) {
    super.setSize(
      Math.max(2, Math.round(width * this.scale)),
      Math.max(2, Math.round(height * this.scale)),
    );
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // The prepass re-renders the scene from this same camera, so switching the
    // overlay layer off around it is the whole of the fix -- no per-frame
    // traversal, and nothing to keep in step with what is in the scene.
    this.camera.layers.disable(OVERLAY_LAYER);
    // The render pass just before this one brought every matrix in the scene
    // up to date, and nothing moves between the two. Walking the whole graph
    // again -- every bone of every figure -- was 3.3 ms of script a frame at
    // the Shire barn, the largest single item in the profile.
    const autoUpdate = this.scene.matrixWorldAutoUpdate;
    this.scene.matrixWorldAutoUpdate = false;
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      this.scene.matrixWorldAutoUpdate = autoUpdate;
      this.camera.layers.enable(OVERLAY_LAYER);
    }
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
  // A floor under the occlusion, and it is not a nicety.
  //
  // At blendIntensity 1 the pass multiplies the whole ambient term by its
  // visibility buffer. Out of doors that is survivable, because the sun is a
  // separate direct term AO never touches. Indoors there is no sun: ambient is
  // the only light there is, so an enclosed corner multiplied by a visibility
  // of nearly zero comes out at *literally* RGB 0 -- measured at 6.5% of the
  // frame in the temple, in hard-edged rectangles that follow the geometry.
  // That is the black bar that was reported five times, and switching the
  // default preset from medium to high is what turned it on for everyone.
  //
  // 0.78 left a fifth of the ambient standing, which was enough that nothing
  // reached zero *at the ambient level of the time*. Then the light balance
  // changed -- the sun went up fourfold and `env` came down with it -- and a
  // fifth of the new, smaller ambient landed under the toe of the tone curve.
  // Measured at the Temple Square at dusk: 0.193% of the frame at literally
  // RGB 0, all of it on the shaded side of one half-timbered house, and gone
  // the instant the pass was switched off. So this number is not a taste
  // setting; it is tied to how much ambient there is to take away. At 0.55
  // nothing reaches zero at any hour and the pass still does 17% of the frame
  // in the temple, where it matters most.
  gtao.blendIntensity = 0.55;
  // `radius` and `thickness` are world metres, and the town's grid pitch is
  // 13m with 5.2m ceilings -- so the interesting question here is "how much of
  // the sky can this doorway see", which is a six-metre question, not the
  // half-metre crease AO is usually asked for. `scale` is an exponent on the
  // result, not a gain: at 1.0 the buffer comes out very nearly white.
  gtao.updateGtaoMaterial({
    radius: 6, distanceExponent: 1, thickness: 12,
    distanceFallOff: 1, scale: 3.2, samples: 16, screenSpaceRadius: false,
  });
  gtao.updatePdMaterial({ lumaPhi: 6, depthPhi: 2.5, normalPhi: 3.5, radius: 5, rings: 2, samples: 8 });

  const shafts = new LightShaftPass(width, height);

  // The threshold is set per time of day in main.js, and it has to be well
  // above 1: this buffer is linear HDR, where open sky at dusk runs into the
  // tens and a threshold near 1 blooms the entire sky over the whole street.
  // Radius was 0.55, which spread the sun over about 35 degrees of sky and ate
  // whole buildings. Real glare is a tiny, extremely hot core with a halo that
  // falls off fast; a wide gaussian just reads as a smeared lens. The threshold
  // that goes with it is set per time of day, high enough that only the disc
  // and genuine specular hits qualify.
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.25, 0.30, 2.8);

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
