/**
 * Boot: read the area files, lay the rooms out, bake materials, build the
 * geometry, populate it, and hand the result to a first-person camera.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { parseArea, buildWorld, DIR_STEP } from './are.js';
import { layoutWorld } from './layout.js';
import { createMaterials } from './textures.js';
import { buildScene, CELL, LEVEL_H } from './build.js';
import { populate } from './actors.js';
import { Player } from './player.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { Quality, LightPool, PRESETS } from './quality.js';

const params = new URLSearchParams(location.search);
const AREA_FILES = (params.get('areas') || 'midgaard')
  .split(',').filter(Boolean).map((f) => (f.endsWith('.are') ? f : `${f}.are`));
const START_VNUM = Number(params.get('room') || 3001);
const MAX_ROOMS = Number(params.get('max') || 400);
const AREA_URL = params.get('areaDir') || 'merc21/area';

const TIMES = {
  dawn: {
    elevation: 8, azimuth: 95, exposure: 0.95, fog: 0xc2a184, density: 0.0055,
    sun: 0xffc48f, sunIntensity: 3.4, sky: 0xa8bcd4, ground: 0x6b5b48,
    ambient: 1.5, bloom: 0.3, stars: 0.2, turbidity: 6, rayleigh: 2.4,
  },
  noon: {
    elevation: 58, azimuth: 175, exposure: 0.48, fog: 0xc4d6e6, density: 0.0028,
    sun: 0xfff2dd, sunIntensity: 4.2, sky: 0xaacbe8, ground: 0x7a6d59,
    ambient: 2.1, bloom: 0.18, stars: 0, turbidity: 3.2, rayleigh: 1.4,
  },
  dusk: {
    elevation: 6.5, azimuth: 258, exposure: 1.02, fog: 0xb1764a, density: 0.0062,
    sun: 0xffa055, sunIntensity: 3.6, sky: 0x8496b4, ground: 0x5b4a38,
    ambient: 1.35, bloom: 0.34, stars: 0.3, turbidity: 7, rayleigh: 2.9,
  },
  night: {
    elevation: -8, azimuth: 300, exposure: 1.3, fog: 0x131a28, density: 0.0105,
    sun: 0x9fb6e0, sunIntensity: 0.9, sky: 0x33456a, ground: 0x1e222b,
    ambient: 0.62, bloom: 0.6, stars: 1, turbidity: 2, rayleigh: 0.6,
  },
};

const state = {
  time: params.get('time') || 'dusk',
  showStats: false,
  roomVnum: null,
  paused: true,
};

const dom = {
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loading-text'),
  loadingBar: document.getElementById('loading-bar'),
  title: document.getElementById('title'),
  titleStats: document.getElementById('title-stats'),
  enter: document.getElementById('enter'),
  fade: document.getElementById('fade'),
  hint: document.getElementById('hint'),
};

const progress = (fraction, text) => {
  dom.loadingBar.style.width = `${Math.round(fraction * 100)}%`;
  if (text) dom.loadingText.textContent = text;
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
};

async function boot() {
  await progress(0.02, 'reading area files');
  const areas = [];
  for (let i = 0; i < AREA_FILES.length; i++) {
    const file = AREA_FILES[i];
    const response = await fetch(`${AREA_URL}/${file}`);
    if (!response.ok) throw new Error(`cannot read ${file}: HTTP ${response.status}`);
    const text = await response.text();
    areas.push(parseArea(text, file));
    await progress(0.02 + 0.13 * ((i + 1) / AREA_FILES.length), `parsed ${file}`);
  }

  const world = buildWorld(areas);
  await progress(0.18, `${world.rooms.size} rooms, ${world.mobProtos.size} mobiles`);

  const layout = layoutWorld(world, { startVnum: START_VNUM, maxRooms: MAX_ROOMS });
  await progress(0.24, `laid out ${layout.stats.placed} rooms`);

  const materials = createMaterials(512, () => {});
  await progress(0.5, 'baked materials');

  const built = buildScene(world, layout, materials);
  await progress(0.72, `${built.stats.triangles.toLocaleString()} triangles`);

  const actors = populate(world, layout, built, { materials });
  await progress(0.86, 'populating rooms');

  // ---------------------------------------------------------------- scene --

  // 'low-power' asks macOS for the integrated GPU where there is a choice, and
  // costs nothing here: this scene is nowhere near needing a discrete part.
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // The composer renders several passes per frame; reset once so the counters
  // add up to the whole frame rather than just the last fullscreen quad.
  renderer.info.autoReset = false;
  document.getElementById('view').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(built.group);
  scene.add(actors.group);

  const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 900);

  const sky = new Sky();
  sky.scale.setScalar(6000);
  scene.add(sky);

  const stars = makeStars();
  scene.add(stars);

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);

  // Where the shadow map was last drawn from; reset it and it gets redrawn.
  const shadowAnchor = new THREE.Vector3(Infinity, Infinity, Infinity);

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(
    window.innerWidth, window.innerHeight,
    { samples: 0, type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace },
  ));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.7, 0.98,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const lightPool = new LightPool(scene, 14, built.lights);
  const quality = new Quality({
    renderer, composer, bloom, sun, lightPool, name: params.get('quality') || 'medium',
  });
  if (params.get('fps')) quality.preset.fps = Number(params.get('fps'));

  // --------------------------------------------------------------- player --

  const player = new Player(camera, renderer.domElement, built);
  const hud = new Hud(document.body, layout);
  const audio = new Audio();

  const startCell = layout.cells.get(START_VNUM) || layout.start;
  const startInfo = built.rooms.get(startCell.vnum);
  const firstExit = startCell.room.exits.findIndex((e, i) => e && i < 4);
  const yaw = firstExit >= 0
    ? Math.atan2(-DIR_STEP[firstExit][0], -DIR_STEP[firstExit][2])
    : 0;
  player.spawn(startInfo.center.x, startInfo.center.y, startInfo.center.z, yaw);
  player.onFootstep = (sprint) => {
    const info = built.rooms.get(state.roomVnum);
    audio.footstep(info ? info.materials.floor : 'flagstone', sprint);
  };

  applyTime(state.time);

  function applyTime(name) {
    const preset = TIMES[name] || TIMES.dusk;
    state.time = name;
    const phi = THREE.MathUtils.degToRad(90 - preset.elevation);
    const theta = THREE.MathUtils.degToRad(preset.azimuth);
    const sunPosition = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    sky.material.uniforms.sunPosition.value.copy(sunPosition);
    sky.material.uniforms.turbidity.value = preset.turbidity;
    sky.material.uniforms.rayleigh.value = preset.rayleigh;
    sky.material.uniforms.mieCoefficient.value = 0.006;
    sky.material.uniforms.mieDirectionalG.value = 0.86;
    sun.position.copy(sunPosition).multiplyScalar(120);
    sun.color.setHex(preset.sun);
    sun.intensity = preset.sunIntensity;
    hemi.color.setHex(preset.sky);
    hemi.groundColor.setHex(preset.ground);
    hemi.intensity = preset.ambient;
    scene.fog = new THREE.FogExp2(preset.fog, preset.density);
    renderer.toneMappingExposure = preset.exposure;
    bloom.strength = preset.bloom;
    stars.material.opacity = preset.stars;
    stars.visible = preset.stars > 0;
    shadowAnchor.set(Infinity, Infinity, Infinity); // the sun moved: redraw shadows
    hud.toast(`${name}`);
  }

  // ---------------------------------------------------------- interaction --

  const interactGrid = new Map();
  for (const item of actors.interactables) {
    const key = `${Math.floor(item.position.x / 16)},${Math.floor(item.position.z / 16)}`;
    if (!interactGrid.has(key)) interactGrid.set(key, []);
    interactGrid.get(key).push(item);
  }
  const forward = new THREE.Vector3();
  const toTarget = new THREE.Vector3();

  function findLookTarget() {
    camera.getWorldDirection(forward);
    let best = null;
    let bestScore = -Infinity;
    const cx = Math.floor(camera.position.x / 16);
    const cz = Math.floor(camera.position.z / 16);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = interactGrid.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const item of bucket) {
          toTarget.copy(item.position).sub(camera.position);
          const distance = toTarget.length();
          if (distance > 7) continue;
          toTarget.divideScalar(distance);
          const facing = toTarget.dot(forward);
          if (facing < 0.72) continue;
          const score = facing * 2 - distance * 0.12;
          if (score > bestScore) { bestScore = score; best = item; }
        }
      }
    }
    return best;
  }

  let lookTarget = null;
  let fadeTimer = 0;

  document.addEventListener('keydown', (event) => {
    if (event.code === 'KeyE' && lookTarget) {
      if (lookTarget.kind === 'door') {
        if (lookTarget.door.spec.locked && !lookTarget.door.forced) {
          hud.toast(`it is locked (${lookTarget.door.spec.keyword.split(/\s+/)[0]})`);
        } else {
          lookTarget.door.open = !lookTarget.door.open;
          audio.door(lookTarget.door.open);
        }
      } else {
        hud.showExamine(lookTarget);
      }
    }
    if (event.code === 'Escape') hud.hideExamine();
    if (event.code === 'Digit1') applyTime('dawn');
    if (event.code === 'Digit2') applyTime('noon');
    if (event.code === 'Digit3') applyTime('dusk');
    if (event.code === 'Digit4') applyTime('night');
    if (event.code === 'KeyF') state.showStats = !state.showStats;
    if (event.code === 'KeyP') {
      const names = Object.keys(PRESETS);
      const next = names[(names.indexOf(quality.name) + 1) % names.length];
      quality.apply(next);
      hud.toast(`${next} · ${quality.preset.fps || 'uncapped'} fps`);
    }
    if (event.code === 'KeyV') { player.noclip = !player.noclip; hud.toast(player.noclip ? 'noclip on' : 'noclip off'); }
    if (event.code === 'KeyM') hud.toast(audio.toggleMute() ? 'sound off' : 'sound on');
    if (event.code === 'KeyG') {
      for (const door of actors.doors) { door.spec.locked = false; door.forced = true; }
      hud.toast('every lock in the world just gave way');
    }
  });

  function teleport(portal) {
    const target = built.rooms.get(portal.target);
    if (!target) return;
    fadeTimer = 0.75;
    dom.fade.style.opacity = '1';
    audio.portal();
    setTimeout(() => {
      player.spawn(target.center.x, target.center.y, target.center.z, camera.rotation.y);
      dom.fade.style.opacity = '0';
    }, 260);
  }

  /**
   * Which room you are in. Standing in a room's own cell is unambiguous;
   * standing in a street belongs to whichever end of that street is nearer,
   * which is the closest thing the mud's own geography has to an answer.
   */
  function currentRoom() {
    const feet = player.position.y - 1.72;
    const level = Math.round(feet / LEVEL_H);
    const cx = Math.round(player.position.x / CELL);
    const cz = Math.round(player.position.z / CELL);

    const here = layout.at(level, cx, cz);
    if (here !== undefined) return here;

    const passage = layout.passageAt(level, cx, cz);
    if (passage) {
      const a = built.rooms.get(passage.from.vnum);
      const b = built.rooms.get(passage.to.vnum);
      return a.center.distanceToSquared(player.position) <= b.center.distanceToSquared(player.position)
        ? passage.from.vnum : passage.to.vnum;
    }

    let vnum;
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const candidate = layout.at(level, cx + dx, cz + dz);
        if (candidate === undefined) continue;
        const distance = built.rooms.get(candidate).center.distanceToSquared(player.position);
        if (distance < best) { best = distance; vnum = candidate; }
      }
    }
    return vnum;
  }

  // --------------------------------------------------------------- events --

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    quality.resize();
  });

  player.controls.addEventListener('lock', () => {
    state.paused = false;
    dom.hint.classList.remove('visible');
    dom.title.classList.add('hidden');
  });
  player.controls.addEventListener('unlock', () => {
    state.paused = true;
    dom.hint.classList.add('visible');
  });

  dom.enter.addEventListener('click', () => {
    audio.start();
    player.controls.lock();
  });
  dom.hint.addEventListener('click', () => player.controls.lock());

  // ----------------------------------------------------------- frame loop --

  let last = performance.now();
  let elapsed = 0;
  let fps = 60;

  function frame() {
    requestAnimationFrame(frame);
    if (state.benchmark) return; // measuring: nobody else draws
    const now = performance.now();
    // Nothing here needs to run faster than the frame cap, and when the mouse
    // is released or the tab is in the background it barely needs to run at all.
    if (!quality.shouldRender(now, state.paused)) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    elapsed += dt;
    fps += ((1 / Math.max(dt, 0.0001)) - fps) * 0.08;

    if (!state.paused) player.update(dt);
    camera.updateMatrixWorld();

    const vnum = currentRoom();
    if (vnum !== undefined && vnum !== state.roomVnum) {
      state.roomVnum = vnum;
      const info = built.rooms.get(vnum);
      hud.setRoom(info.room);
      audio.setOutdoor(info.outdoor);
    }

    // The sun follows so its shadow map always covers where you are, but it is
    // snapped to a grid: the map is only redrawn every few metres of walking
    // instead of every frame, which also stops the shadow edges crawling.
    const sunDirection = sky.material.uniforms.sunPosition.value;
    const snap = 6;
    const anchorX = Math.round(camera.position.x / snap) * snap;
    const anchorY = Math.round(camera.position.y / snap) * snap;
    const anchorZ = Math.round(camera.position.z / snap) * snap;
    if (anchorX !== shadowAnchor.x || anchorY !== shadowAnchor.y || anchorZ !== shadowAnchor.z) {
      shadowAnchor.set(anchorX, anchorY, anchorZ);
      sun.target.position.copy(shadowAnchor);
      sun.position.copy(shadowAnchor).addScaledVector(sunDirection, 120);
      sun.target.updateMatrixWorld();
      renderer.shadowMap.needsUpdate = true;
    }

    lightPool.update(camera.position, elapsed);
    actors.update(dt, elapsed, camera);
    audio.update(built.rooms.get(state.roomVnum)?.room.sector === 1);

    if (!state.paused) {
      lookTarget = findLookTarget();
      hud.setLook(lookTarget);
      for (const portal of built.portals) {
        if (fadeTimer > 0) break;
        const dx = portal.x - player.position.x;
        const dz = portal.z - player.position.z;
        const dy = portal.y - (player.position.y - 1.72);
        if (Math.abs(dy) > 3) continue;
        if (dx * dx + dz * dz < portal.radius * portal.radius) { teleport(portal); break; }
      }
    }
    if (fadeTimer > 0) fadeTimer -= dt;

    hud.update(dt, camera, state.roomVnum);
    if (state.showStats) {
      const info = renderer.info.render;
      hud.setStats(`${fps.toFixed(0)} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris`
        + ` · ${quality.describe()} · ${state.time}`);
    } else {
      hud.setStats('');
    }

    renderer.info.reset();
    quality.begin(now);
    composer.render();
    quality.end();
  }

  // Handy from the console, and how the screenshots for this were framed.
  window.diku = {
    scene, camera, renderer, composer, bloom, sun, lightPool, quality,
    player, hud, layout, built, actors, world, applyTime, state,
    look(x, y, z, yaw = 0, pitch = 0) {
      player.spawn(x, y, z, yaw);
      camera.rotation.set(pitch, yaw, 0);
      state.roomVnum = null;
    },
    goto(vnum, yaw = 0, pitch = 0) {
      const info = built.rooms.get(vnum);
      if (!info) return `room ${vnum} is not in the world`;
      this.look(info.center.x, info.center.y, info.center.z, yaw, pitch);
      return info.room.name;
    },
  };

  await progress(1, 'ready');
  dom.loading.classList.add('hidden');
  dom.titleStats.textContent = `${layout.stats.placed} rooms · ${layout.stats.alleys + layout.stats.stairs} passages · `
    + `${layout.stats.portals} archways · ${built.stats.triangles.toLocaleString()} triangles`;
  dom.title.classList.remove('hidden');
  frame();
}

function makeStars() {
  const count = 1400;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    positions[i * 3] = Math.cos(theta) * r * 3000;
    positions[i * 3 + 1] = Math.abs(u) * 3000 + 60;
    positions[i * 3 + 2] = Math.sin(theta) * r * 3000;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xdfe6ff, size: 3.2, sizeAttenuation: false, transparent: true, opacity: 0.35, fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

boot().catch((error) => {
  dom.loading.classList.remove('hidden');
  dom.loadingText.innerHTML = `<strong>failed to start</strong><br>${String(error.message || error)}`;
  dom.loadingBar.style.background = '#a33';
  console.error(error);
});
