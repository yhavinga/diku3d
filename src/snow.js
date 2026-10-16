/**
 * Snow, the cheap way and on the same terms as rain.js: one `Points` mesh in a
 * box that rides the camera, every flake moved by the vertex shader from a
 * hashed seed, nothing simulated, nothing allocated per frame.
 *
 * Two kinds share the mesh. Flakes fall -- slowly, swaying, leaning with the
 * wind -- and are a pixel or two across, which is what a flake is at the
 * distance you see one. Spindrift is the other: "a cold wind blows through
 * here, scattering fine clouds of snow all about" (#2363). It is a small
 * population of soft, faint motes blown flat along the ground that thickens
 * only while a gust is up, so the town has weather with a rhythm and not a
 * constant fall. A flake is a few pixels and a mote a dozen at the nearest;
 * the sprites that cost a scene (the chimney smoke) are metres across, and
 * these are neither big nor many.
 *
 * World-fixed, not camera-fixed: rain's streaks can ride the camera because a
 * streak is a line, but a flake that travels with you reads as a speck on the
 * lens. The box wraps round the camera instead, so walking through it moves
 * you past the snow.
 */

import * as THREE from 'three';

const FLAKES = 760;
const MOTES = 150;
const BOX = 30;       // the box's side, m, centred on the camera
const HEIGHT = 15;    // how far a flake falls before it wraps

const VERT = /* glsl */`
  attribute vec3 seed;           // x: identity, y: second roll, z: kind (0 flake, 1 mote)
  uniform vec3 uCam;
  uniform float uTime;
  uniform vec2 uDrift;           // how far the wind has carried the air since the start, m
  uniform float uGust;           // 0..1, the gust now blowing
  uniform float uLevel;          // 0..1, how much of the population falls
  uniform float uPx;             // pixels per metre at one metre: projection scale
  uniform float uGround;         // the floor under the camera, y
  varying float vAlpha;
  varying float vSoft;

  void main() {
    float s = seed.x; float r = seed.y;
    float mote = seed.z;
    vec3 p = position;                       // 0..BOX in x and z, 0..HEIGHT in y
    float fall = ${HEIGHT.toFixed(1)};

    // Wind carries the whole column; the nearer-the-ground motes ride it harder.
    vec2 carry = uDrift * mix(0.55 + 0.5 * r, 1.6 + r, mote);
    float lap = fract(uTime * (0.045 + 0.02 * r) + s);
    float x = p.x + carry.x + sin(uTime * (0.5 + r) + s * 40.0) * 0.4 * (1.0 - mote);
    float z = p.z + carry.y + cos(uTime * (0.4 + r) + s * 31.0) * 0.4 * (1.0 - mote);
    // Wrapped into the box round the camera, so the snow stays where it is.
    x = mod(x - uCam.x + ${(BOX / 2).toFixed(1)}, ${BOX.toFixed(1)}) - ${(BOX / 2).toFixed(1)};
    z = mod(z - uCam.z + ${(BOX / 2).toFixed(1)}, ${BOX.toFixed(1)}) - ${(BOX / 2).toFixed(1)};
    float y = uCam.y + ${(HEIGHT * 0.45).toFixed(2)} - lap * fall;
    // Motes lie along the ground instead, a hand to a man high, billowing.
    float billow = 0.35 + 0.65 * uGust;
    float ym = uGround + 0.15 + p.y * 0.16 * billow + sin(uTime * 0.9 + s * 20.0) * 0.12;
    y = mix(y, ym, mote);

    vec4 mv = viewMatrix * vec4( uCam.x + x, y, uCam.z + z, 1.0 );
    float d = max( 0.5, -mv.z );
    // Population thins with the level; a mote needs the gust to show at all.
    float shown = mix( step( s, uLevel ), step( r, 0.25 + 0.75 * uGust ) * step( s, uLevel + 0.3 ), mote );
    // Fade where the box wraps, or flakes pop at its walls.
    float edge = 1.0 - smoothstep( ${(BOX / 2 - 5).toFixed(1)}, ${(BOX / 2).toFixed(1)}, length( vec2( x, z ) ) );
    float top = smoothstep( 0.0, 0.08, lap ) * ( 1.0 - smoothstep( 0.9, 1.0, lap ) );
    float size = mix( 0.032 + 0.03 * r, 0.16 + 0.18 * r, mote );
    // A flake never goes finer than a pixel or it scintillates; a mote is
    // capped so the nearest cannot become a sheet.
    gl_PointSize = clamp( size * uPx / d, 1.3, mix( 4.5, 15.0, mote ) );
    vAlpha = shown * edge * mix( top, 0.16 * ( 0.25 + 0.75 * uGust ), mote );
    vSoft = mote;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */`
  uniform vec3 uColour;
  uniform float uOpacity;
  varying float vAlpha;
  varying float vSoft;
  void main() {
    if ( vAlpha < 0.01 ) discard;
    vec2 c = gl_PointCoord - 0.5;
    float d = length( c ) * 2.0;
    // A flake is a hard little disc; a mote is a puff with no edge.
    float a = mix( 1.0 - smoothstep( 0.55, 1.0, d ), 1.0 - smoothstep( 0.0, 1.0, d ), vSoft );
    gl_FragColor = vec4( uColour, a * vAlpha * uOpacity );
  }`;

export function createSnow(scene) {
  const n = FLAKES + MOTES;
  const positions = new Float32Array(n * 3);
  const seeds = new Float32Array(n * 3);
  // Deterministic, as rain's: a hash and not Math.random, so every session
  // snows the same snow.
  const hash = (i, k) => {
    let h = Math.imul(i + 1, 374761393) ^ Math.imul(k, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  for (let i = 0; i < n; i++) {
    const mote = i >= FLAKES ? 1 : 0;
    positions.set([hash(i, 1) * BOX, hash(i, 2) * HEIGHT, hash(i, 3) * BOX], i * 3);
    seeds.set([hash(i, 4), hash(i, 5), mote], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uDrift: { value: new THREE.Vector2() },
      uGust: { value: 0 },
      uLevel: { value: 0 },
      uPx: { value: 700 },
      uGround: { value: 0 },
      uColour: { value: new THREE.Color(0xdfe8f4) },
      uOpacity: { value: 0.8 },
    },
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Points(geometry, material);
  // The box rides the camera; its bounding sphere never means anything.
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 4;
  scene.add(mesh);

  let level = 0;
  let time = 0;
  const drift = new THREE.Vector2();

  // The wind, as a rhythm: a lull most of the time, then a gust every six to
  // fourteen seconds that comes up in a second and goes in three. Hashed on
  // the gust's number, so it is the same weather every time.
  const GUST_SPAN = 9;
  const gustAt = (t) => {
    const k = Math.floor(t / GUST_SPAN);
    const start = k * GUST_SPAN + hash(k, 9) * 4.5;
    const dt = t - start;
    if (dt < 0 || dt > 4.2) return 0;
    const up = Math.min(1, dt / 1.1);
    const down = 1 - Math.max(0, (dt - 1.1) / 3.1);
    return up * up * (3 - 2 * up) * down * down;
  };

  return {
    mesh,
    /** 0 is dry, 1 is falling all about you; anything between thins the flakes. */
    setIntensity(value) {
      level = THREE.MathUtils.clamp(value, 0, 1);
      material.uniforms.uLevel.value = level;
      mesh.visible = level > 0.01;
    },
    /** Lit by the sky it falls out of: the hour's haze, lifted so it reads as white. */
    setColour(hex) {
      material.uniforms.uColour.value.setHex(hex).multiplyScalar(1.5);
    },
    /** The gust blowing now, 0..1; the audio and anything else can ask. */
    gust: () => material.uniforms.uGust.value,
    /**
     * `pxPerMetre`: the projection's scale at one metre, in pixels of the
     * buffer the frame is drawn into (`quality.pixelRatio()` times the window
     * height, over twice the tangent of half the field of view).
     */
    update(dt, cameraPosition, pxPerMetre, groundY) {
      if (!mesh.visible) return;
      time += dt;
      const gust = gustAt(time);
      // A steady breeze from the north-west, and the gust on top of it: the
      // air's travel is the integral of the wind, so a gust moves the snow
      // and its dying away does not draw it back.
      drift.x += dt * (0.7 + 7 * gust);
      drift.y += dt * (0.35 + 3 * gust);
      const u = material.uniforms;
      u.uTime.value = time;
      u.uGust.value = gust;
      u.uDrift.value.copy(drift);
      u.uCam.value.copy(cameraPosition);
      u.uPx.value = pxPerMetre;
      u.uGround.value = groundY;
    },
  };
}
