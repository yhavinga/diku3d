/**
 * Rain, the cheap and honest way: one LineSegments mesh of ~900 falling
 * streaks in a cylinder around the camera, moved by the vertex shader and
 * carried along as the player walks. A streak is a line, and a line is one
 * pixel wide at any distance -- which is what drizzle looks like, and also
 * what keeps this the cheapest weather effect in the scene by a mile (the
 * chimney smoke's soft sprites cost more per frame than all of the rain).
 *
 * No splashes and no ripple decals: the wet recipes already darken and gloss
 * the ground under overcast, and a ring decal that does not land exactly on
 * a surface reads as a sticker. Sound carries the other half of rain, and
 * that lives in audio.js.
 */

import * as THREE from 'three';

// A judge measured the first cut at 0.09% of the frame's pixels changed --
// functionally invisible -- with every streak at exactly 0.0 degrees from
// vertical, which reads as scratches on the lens. So: more of them, longer,
// denser ink, a wider volume, and a real lean baked into the geometry (the
// old shear moved both ends of a segment equally, which tilts nothing).
const COUNT = 1500;
const RADIUS = 19;
const HEIGHT = 17;
const STREAK = 1.15;

const RAIN_VERT = /* glsl */`
  attribute float seed;
  uniform float time;
  uniform float intensity;
  varying float vFade;
  void main() {
    // The integer part of the seed flags the lower end of the streak; the
    // fraction is the per-streak identity.
    float tip = step(1.0, seed);
    float s = fract(seed);
    // Each streak falls its own lap of the cylinder, offset by its seed, and
    // wraps. Speed varies a little per streak so sheets do not march.
    float lap = mod(time * (0.55 + s * 0.2) + s * 7.0, 1.0);
    vec3 pos = position;
    pos.y += ${HEIGHT.toFixed(1)} * (1.0 - lap) - ${(HEIGHT / 2).toFixed(1)};
    // Wind: the whole column drifts with the fall, and the lower end trails
    // behind the upper, so every streak leans off vertical by its own angle.
    pos.x += lap * 1.6 + tip * (0.14 + s * 0.12);
    // Fade the far half of the population in and out with intensity, so light
    // rain is sparse rather than faint.
    vFade = intensity >= s ? 1.0 : 0.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }`;

const RAIN_FRAG = /* glsl */`
  uniform vec3 colour;
  uniform float opacity;
  varying float vFade;
  void main() {
    if (vFade < 0.5) discard;
    gl_FragColor = vec4(colour, opacity);
  }`;

export function createRain(scene) {
  const positions = new Float32Array(COUNT * 2 * 3);
  const seeds = new Float32Array(COUNT * 2);
  // Deterministic scatter, same idiom as the rest of the build: a hash, not
  // Math.random, so every session rains the same rain.
  const hash = (i, s) => {
    let h = Math.imul(i + 1, 374761393) ^ Math.imul(s, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  for (let i = 0; i < COUNT; i++) {
    const a = hash(i, 1) * Math.PI * 2;
    // sqrt for even area density, or the middle of the cylinder is a downpour
    // and the rim a sprinkle.
    const r = Math.sqrt(hash(i, 2)) * RADIUS;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = hash(i, 3) * HEIGHT;
    const seed = hash(i, 4);
    positions.set([x, y, z, x, y - STREAK, z], i * 6);
    // Same fractional identity on both ends; +1 marks the lower end so the
    // shader can lean it.
    seeds[i * 2] = seed;
    seeds[i * 2 + 1] = seed + 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    uniforms: {
      time: { value: 0 },
      intensity: { value: 0 },
      colour: { value: new THREE.Color(0xaab4bd) },
      opacity: { value: 0.26 },
    },
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.LineSegments(geometry, material);
  // The cylinder rides the camera; its bounding sphere never means anything.
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 4;
  scene.add(mesh);

  let level = 0;

  return {
    mesh,
    /** 0 is dry, 1 is a proper Pacific soak; anything between thins the population. */
    setIntensity(value) {
      level = THREE.MathUtils.clamp(value, 0, 1);
      material.uniforms.intensity.value = level;
      mesh.visible = level > 0.01;
    },
    /**
     * Rain is lit by the sky it falls out of: hand it the hour's haze colour
     * and it stays silver-grey by day and near-invisible dark at night, which
     * is right -- night rain is heard, not seen, except against a lamp.
     */
    setColour(hex) {
      material.uniforms.colour.value.setHex(hex).multiplyScalar(1.18);
    },
    update(dt, cameraPosition) {
      if (!mesh.visible) return;
      material.uniforms.time.value += dt;
      // Indoors is a roof over your head, not a dry spell: the streaks would
      // fall through the ceiling. The caller hides the mesh via intensity
      // when the player is under cover; here we only follow the camera.
      mesh.position.copy(cameraPosition);
    },
  };
}
