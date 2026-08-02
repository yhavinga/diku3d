/**
 * Boot: read the area files, lay the rooms out, bake materials, build the
 * geometry, populate it, and hand the result to a first-person camera.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

import { createPipeline, SkyEnvironment, clampSkyHighlights } from './render.js';
import { parseArea, buildWorld, DIR_STEP, DIR_NAME, SECTOR_NAME } from './are.js';
import { layoutWorld } from './layout.js';
import { createMaterials } from './textures.js';
import { buildScene, CELL, LEVEL_H } from './build.js';
import { populate } from './actors.js';
import { Player } from './player.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { Quality, LightPool, PRESETS } from './quality.js';
import { createOptions } from './options.js';
import { AssetLibrary, ASSET_NAMES } from './assets.js';
import { createGame } from './game.js';
import { createGameUi } from './game-ui.js';

const params = new URLSearchParams(location.search);
const AREA_FILES = (params.get('areas') || 'midgaard')
  .split(',').filter(Boolean).map((f) => (f.endsWith('.are') ? f : `${f}.are`));
const START_VNUM = Number(params.get('room') || 3001);
const MAX_ROOMS = Number(params.get('max') || 400);
const AREA_URL = params.get('areaDir') || 'merc21/area';

/**
 * The sky is no longer only scenery: it is baked into an environment cube and
 * is what most surfaces are actually lit by. So the hemisphere light that used
 * to carry all the ambient is now a small floor under it (`ambient`), and the
 * dials that matter are `env` -- how much of the baked sky to believe -- and
 * `bounce`/`haze`, the colour of the ground and the horizon inside that bake.
 *
 * Exposures are set for ACES; see the note where the tone mapping is chosen.
 */
const TIMES = {
  dawn: {
    elevation: 8, azimuth: 95, exposure: 0.64, fog: 0xc9a586, density: 0.0050,
    sun: 0xffc089, sunIntensity: 5.6, sky: 0x9fb6d2, ground: 0x5f5142, ambient: 0.12,
    env: 0.45, bounce: 0x5e4f3d, haze: 0xc9a586,
    bloom: 0.16, bloomThreshold: 5.5, stars: 0.22, turbidity: 5.5, rayleigh: 2.6,
    shafts: 0.5, shaftTint: 0xffd2a0,
  },
  noon: {
    elevation: 58, azimuth: 175, exposure: 0.33, fog: 0xbcd2e6, density: 0.0042,
    sun: 0xfff4e2, sunIntensity: 5.4, sky: 0xa3c4e4, ground: 0x6f6455, ambient: 0.16,
    env: 0.55, bounce: 0x77694f, haze: 0xbcd2e6,
    bloom: 0.14, bloomThreshold: 7.0, stars: 0, turbidity: 3.0, rayleigh: 1.3,
    shafts: 0, shaftTint: 0xffffff,
  },
  dusk: {
    elevation: 9.5, azimuth: 258, exposure: 0.62, fog: 0xb87b4e, density: 0.0050,
    sun: 0xff9448, sunIntensity: 6.2, sky: 0x7b8ea8, ground: 0x50412f, ambient: 0.12,
    env: 0.45, bounce: 0x574433, haze: 0xb87b4e,
    bloom: 0.16, bloomThreshold: 5.5, stars: 0.32, turbidity: 6.5, rayleigh: 3.0,
    shafts: 0.55, shaftTint: 0xffb469,
  },
  night: {
    elevation: -8, azimuth: 300, exposure: 1.25, fog: 0x1a2340, density: 0.0068,
    sun: 0x8ea6d6, sunIntensity: 0.8, sky: 0x2b3a5c, ground: 0x171a22, ambient: 0.18,
    env: 1.0, bounce: 0x1a1e28, haze: 0x2c3c62,
    // Rayleigh does the work a black sky cannot: a night sky is deep
    // blue-violet with a brighter band at the horizon, and that band is the
    // only thing giving a roofline a silhouette to be cut against.
    bloom: 0.42, bloomThreshold: 1.1, stars: 1, turbidity: 2.4, rayleigh: 2.2,
    shafts: 0, shaftTint: 0xaabbff,
    // Read before the exposure of 1.25 and ACES, so it is well under what it
    // looks like: this lands at roughly #0d1226 at the zenith and half a stop
    // brighter along the horizon.
    skyFloor: 0x2a3a6b, skyFloorGain: 0.085,
  },
};

/**
 * Diku's own direction order -- north, east, south, west, up, down -- on the
 * arrow keys, with the two vertical ones where a keyboard already puts "further
 * up" and "further down". WASD is taken by the body and every letter that would
 * read as a compass point is spoken for: E examines, W walks, S walks back.
 */
const ARROW_DIR = {
  ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
  PageUp: 4, PageDown: 5,
};

const TONE_MAPPING = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
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
  await progress(0.44, 'baked materials');

  // Modelled assets are optional: anything missing falls back to the
  // procedural geometry, so the viewer runs against a half-built library.
  const assets = params.get('assets') === 'off' ? null
    : await new AssetLibrary(materials).load(ASSET_NAMES);
  if (assets) {
    await progress(0.54, `${assets.assets.size} models, ${assets.missing.size} still procedural`);
    if (assets.unknownTags.size) {
      console.warn('assets: no material for tag(s)', [...assets.unknownTags].join(', '));
    }
  }

  const built = buildScene(world, layout, materials, assets);
  await progress(0.72, `${built.stats.triangles.toLocaleString()} triangles`);

  const actors = populate(world, layout, built, { materials, assets });
  await progress(0.86, 'populating rooms');

  // ---------------------------------------------------------------- scene --

  // 'low-power' asks macOS for the integrated GPU where there is a choice, and
  // costs nothing here: this scene is nowhere near needing a discrete part.
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  // ACES, kept after measuring it against AgX at matched mid-grey. AgX holds a
  // clipping sky better, but it desaturates on the way there, and at golden
  // hour that costs the whole look: warm stone and cool shadow collapse into
  // one beige. ACES keeps them apart. The clipping it was supposed to fix
  // turned out to be the bloom threshold sitting below 1 on an HDR buffer.
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
  const skyRange = clampSkyHighlights(sky, 60);
  scene.add(sky);

  const stars = makeStars();
  scene.add(stars);

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  // The frustum's half-width belongs to the quality preset: it, not the map
  // size, is what decides how many centimetres a shadow texel covers.
  sun.shadow.bias = -0.00022;
  sun.shadow.normalBias = 0.022;
  scene.add(sun, sun.target);

  // Almost all of the ambient now comes from the environment cube. What is
  // left of the hemisphere light is a floor, so nothing sealed away from the
  // sky goes completely black.
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);

  // Where the shadow map was last drawn from; reset it and it gets redrawn.
  const shadowAnchor = new THREE.Vector3(Infinity, Infinity, Infinity);

  const pipeline = createPipeline({
    renderer, scene, camera, width: window.innerWidth, height: window.innerHeight,
  });
  const { composer, bloom, shafts } = pipeline;
  const environment = new SkyEnvironment(renderer);

  // Torches and lamps from the builder, plus one behind every lit window.
  const lightPool = new LightPool(scene, 14, built.lights.concat(actors.lights));
  const quality = new Quality({
    renderer, pipeline, sun, lightPool, materials,
    name: params.get('quality') || 'medium',
  });
  if (params.get('fps')) quality.preset.fps = Number(params.get('fps'));

  // --------------------------------------------------------------- player --

  const player = new Player(camera, renderer.domElement, built);
  const hud = new Hud(document.body, layout);
  const audio = new Audio();

  const options = createOptions({ quality, applyTime: (n) => applyTime(n), audio, state });
  const game = createGame({ world, layout, built, actors });
  const gameUi = createGameUi(game);
  game.onTeleport = (x, y, z) => player.spawn(x, y, z, camera.rotation.y);
  game.setTimeOfDay(state.time);

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

  const sunDirection = new THREE.Vector3(0, 1, 0);
  const shaftTint = new THREE.Color(1, 1, 1);
  let sunElevation = 0;

  applyTime(state.time);

  function applyTime(name) {
    const preset = TIMES[name] || TIMES.dusk;
    state.time = name;
    game.setTimeOfDay(name);
    const phi = THREE.MathUtils.degToRad(90 - preset.elevation);
    const theta = THREE.MathUtils.degToRad(preset.azimuth);
    const sunPosition = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    sunDirection.copy(sunPosition);
    sunElevation = preset.elevation;
    sky.material.uniforms.sunPosition.value.copy(sunPosition);
    sky.material.uniforms.turbidity.value = preset.turbidity;
    sky.material.uniforms.rayleigh.value = preset.rayleigh;
    sky.material.uniforms.mieCoefficient.value = 0.006;
    sky.material.uniforms.mieDirectionalG.value = 0.86;
    skyRange.setFloor(preset.skyFloor ?? 0x000000, preset.skyFloorGain ?? 0);
    sun.position.copy(sunPosition).multiplyScalar(120);
    sun.color.setHex(preset.sun);
    sun.intensity = preset.sunIntensity;
    hemi.color.setHex(preset.sky);
    hemi.groundColor.setHex(preset.ground);
    hemi.intensity = preset.ambient;
    scene.fog = new THREE.FogExp2(preset.fog, preset.density);
    renderer.toneMappingExposure = preset.exposure;
    bloom.strength = preset.bloom;
    bloom.threshold = preset.bloomThreshold;
    stars.material.opacity = preset.stars;
    stars.visible = preset.stars > 0;
    shaftTint.setHex(preset.shaftTint);
    state.shaftGain = preset.shafts;
    // Figures are kept out of the shadow map, so their contact shadows are
    // placed by hand and have to be told where the light is coming from.
    actors.setSun(sunPosition, preset.elevation);
    // And the windows have to be told there is daylight outside them, or from
    // inside a room they are black rectangles at head height.
    actors.setDaylight(preset.haze, THREE.MathUtils.clamp(preset.elevation / 22, 0, 1) * 0.75);

    // Rebake the environment from the sky we just set up. This is the whole
    // ambient term, so it has to happen before the next frame -- and it is a
    // cube render plus a blur chain, so it must not happen during one.
    environment.update(scene, {
      sunPosition,
      turbidity: preset.turbidity,
      rayleigh: preset.rayleigh,
      mieCoefficient: 0.006,
      mieDirectionalG: 0.86,
      ground: preset.bounce,
      horizon: preset.haze,
      intensity: preset.env,
    });

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
    // The same key closes it. Escape works too, but Escape is the browser's own
    // pointer-lock release, so relying on it costs you the mouse as well.
    if (event.code === 'KeyE' && hud.examineOpen) {
      hud.hideExamine();
      return;
    }
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
    if (event.code === 'KeyO') {
      // The options screen needs the mouse, so it gives it back on the way out.
      if (options.toggle()) player.controls.unlock();
      else player.controls.lock();
    }
    if (event.code === 'Escape' && options.open) options.close();
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
    const dir = ARROW_DIR[event.code];
    if (dir !== undefined && !options.open) {
      event.preventDefault();
      step(dir);
    }
  });

  /**
   * Walk an exit the way you would in the mud: north is north, not whichever
   * way you happen to be facing. WASD is the body and this is the map -- the
   * arrows take the exit itself, so a stair, an archway and a routed street all
   * behave the same, and you can cross the town as fast as you can read.
   *
   * The refusals are the mud's own, because they carry information the geometry
   * does not: an exit that leads off the loaded set is a real exit in Midgaard
   * and a wall here, and that is worth saying out loud rather than pretending
   * there is nothing there.
   */
  function step(dir) {
    if (fadeTimer > 0) return;
    const here = currentRoom();
    const room = here && world.rooms.get(here);
    if (!room) return;
    const exit = room.exits[dir];
    const name = DIR_NAME[dir];
    if (!exit) { hud.toast(`no exit ${name}`); return; }
    if (exit.offMap) { hud.toast(`${name}: outside the loaded world`); return; }
    const target = built.rooms.get(exit.to);
    if (!target || target.unbuilt) { hud.toast(`${name}: nothing built that way`); return; }
    // A door in the way behaves as it looks: what you see shut, you cannot walk
    // through. `door.open` is the live hinge, not the .are file's opinion.
    const door = actors.doors.find((d) => d.spec.room === room.vnum && d.spec.dir === dir);
    if (door && !door.open) {
      const word = door.spec.keyword.split(/\s+/)[0] || 'door';
      hud.toast(door.spec.locked && !door.forced ? `the ${word} is locked` : `the ${word} is closed`);
      return;
    }
    fadeTimer = 0.34;
    dom.fade.style.opacity = '1';
    setTimeout(() => {
      player.spawn(target.center.x, target.center.y, target.center.z, camera.rotation.y);
      dom.fade.style.opacity = '0';
    }, 120);
  }

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
  renderer.domElement.addEventListener('mousedown', (event) => {
    if (event.button === 0 && !state.paused) game.attack();
  });

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
    if (!state.paused) game.update(dt, player.position, camera.getWorldDirection(forward));
    gameUi.update();

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

    // God rays are aimed from where the sun ends up on screen, so this has to
    // be after the camera has moved and before anything draws.
    shafts.aim(camera, sunDirection, sunElevation, shaftTint, state.shaftGain);

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

    options.update(dt);
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
    scene, camera, renderer, composer, bloom, sun, hemi, lightPool, quality, game, gameUi, options,
    pipeline, environment, materials,
    player, hud, layout, built, actors, world, applyTime, state, times: TIMES,
    /** Console A/B for the tone curve: 'agx', 'aces' or 'neutral'. */
    setTone(name) {
      renderer.toneMapping = TONE_MAPPING[name] ?? THREE.AgXToneMapping;
      scene.traverse((o) => {
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material])
          .forEach((m) => { m.needsUpdate = true; });
      });
      return name;
    },
    /**
     * Somewhere worth standing, worked out from the world rather than listed by
     * hand, so this keeps working whichever areas are loaded. Each entry says
     * where to stand, which way to face, and why it is interesting.
     */
    places() {
      const out = [];
      const seen = new Set();
      const add = (key, vnum, why, target = null, time = null) => {
        if (vnum === undefined || seen.has(key) || !built.rooms.has(vnum)) return;
        seen.add(key);
        out.push({ key, vnum, room: built.rooms.get(vnum).room.name, why, target, time });
      };
      const rooms = [...built.rooms.entries()].filter(([, i]) => !i.unbuilt);
      const find = (test) => (rooms.find(([vnum]) => test(world.rooms.get(vnum))) || [])[0];

      for (const [vnum] of rooms) {
        const room = world.rooms.get(vnum);
        const fountain = room.items.find((o) => o.proto.itemType === 25
          || /fountain|well|water/.test(o.proto.keywords));
        if (fountain) { add('water', vnum, 'a fountain: animated water, refraction, wet stone'); break; }
      }
      add('watersector', find((r) => r.sector === 6 || r.sector === 7), 'open water');
      add('square', find((r) => r.exits.filter(Boolean).length >= 4 && r.sector === 1),
        'the widest open space: pavement, frontage, silhouettes');
      add('street', find((r) => r.sector === 1 && r.exits.filter(Boolean).length === 2),
        'a street between two frontages, for receding perspective');
      add('interior', find((r) => r.sector === 0 && /temple|hall|sanctum/i.test(r.name)),
        'a lit stone interior: light falloff, torches, shadowed material');
      add('shop', find((r) => r.mobs.some((m) => m.shop)), 'a shopkeeper and their stock');
      add('forest', find((r) => r.sector === 3), 'trees and undergrowth');
      add('field', find((r) => r.sector === 2), 'open ground and horizon');
      add('gate', find((r) => r.exits.some((e) => e && e.offMap)), 'a sealed gate out of the world');
      const beast = actors.interactables.find((i) => i.kind === 'mob' && i.subtitle);
      for (const [vnum] of rooms) {
        if (world.rooms.get(vnum).mobs.length >= 2) { add('crowd', vnum, 'several mobiles together'); break; }
      }
      void beast;
      return out;
    },

    /**
     * Informed-random vantage points: `count` rooms drawn at random from the
     * ones actually worth standing in, with a camera already aimed at whatever
     * makes each one worth a look.
     *
     * `places()` returns the same handful of exemplars every time, which is
     * exactly wrong for a reviewer -- it means the same ten frames get looked
     * at round after round and everything else in the town is never seen. This
     * draws from the whole world instead, but not uniformly: a room scores for
     * having mobiles, items, several exits, water, height, or prose suggesting
     * something is there, and rooms that score nothing are not offered. Pass a
     * seed to get the same walk twice.
     */
    roam(count = 8, seed = 1) {
      const scored = [];
      for (const [vnum, info] of built.rooms) {
        if (info.unbuilt) continue;
        const room = world.rooms.get(vnum);
        let score = 1;
        const why = [];
        if (room.mobs.length) { score += 2 + room.mobs.length; why.push(`${room.mobs.length} mobile(s)`); }
        if (room.items.length) { score += 1 + room.items.length; why.push(`${room.items.length} object(s)`); }
        const exits = room.exits.filter(Boolean).length;
        if (exits >= 4) { score += 2; why.push(`${exits} ways out`); }
        if (room.sector === 6 || room.sector === 7) { score += 3; why.push('water'); }
        if (room.sector === 3 || room.sector === 2) { score += 1; why.push(SECTOR_NAME[room.sector]); }
        if (info.cell.level > 0) { score += 2; why.push(`level ${info.cell.level}`); }
        if (/fountain|statue|altar|fire|forge|tree|pool|bridge|stair|gate/i.test(
          `${room.name} ${room.description}`)) { score += 2; why.push('something named in the prose'); }
        if (score <= 1) continue;
        scored.push({ vnum, score, why, name: room.name, sector: SECTOR_NAME[room.sector] || '?' });
      }
      // Deterministic shuffle weighted by score: a hash per room, divided by its
      // score, so a richer room sorts earlier more often without ever being
      // certain to. Same seed, same order.
      const roll = (n) => {
        let h = Math.imul(n ^ seed, 2654435761);
        h ^= h >>> 15;
        return ((h >>> 0) % 100000) / 100000;
      };
      scored.sort((a, b) => roll(a.vnum) / a.score - roll(b.vnum) / b.score);
      return scored.slice(0, count).map((s) => ({
        ...s, why: s.why.join(', '),
        go: `diku.goto(${s.vnum})`,
      }));
    },

    /** Rooms whose name, description, sector or contents match a word. */
    find(query) {
      const q = String(query).toLowerCase();
      const hits = [];
      for (const [vnum, info] of built.rooms) {
        if (info.unbuilt) continue;
        const room = world.rooms.get(vnum);
        const hay = [
          room.name, room.description, SECTOR_NAME[room.sector] || '',
          ...room.items.map((o) => o.proto.short), ...room.mobs.map((m) => m.proto.short),
        ].join(' ').toLowerCase();
        if (hay.includes(q)) hits.push({ vnum, name: room.name, sector: SECTOR_NAME[room.sector] });
        if (hits.length >= 40) break;
      }
      return hits;
    },

    /**
     * Stand in a place from places() and face what makes it worth seeing. Pass
     * a vnum instead to frame that room the same way.
     */
    shoot(keyOrVnum, options = {}) {
      const place = typeof keyOrVnum === 'string'
        ? this.places().find((p) => p.key === keyOrVnum) : { vnum: keyOrVnum };
      if (!place) return `no such place: ${keyOrVnum}`;
      const info = built.rooms.get(place.vnum);
      if (!info) return `room ${place.vnum} is not built`;
      if (options.time) applyTime(options.time);

      // Face whatever is worth looking at: a prop or mobile in the room if
      // there is one, otherwise down the room's first exit.
      let aim = null;
      let best = Infinity;
      for (const item of actors.interactables) {
        const d2 = item.position.distanceToSquared(info.center);
        if (d2 < best && d2 < 60) { best = d2; aim = item.position; }
      }
      const back = options.back ?? (aim ? 4.2 : 0);
      // The camera looks down -Z at yaw 0, so its forward is (-sin, 0, -cos).
      // Facing a point therefore needs atan2 of the *negated* offset, and
      // standing back from it means moving along +(sin, cos).
      let yaw = options.yaw;
      if (yaw === undefined) {
        if (aim) yaw = Math.atan2(info.center.x - aim.x, info.center.z - aim.z);
        else {
          const dir = info.room.exits.findIndex((e, i) => e && i < 4);
          yaw = dir >= 0 ? Math.atan2(-DIR_STEP[dir][0], -DIR_STEP[dir][2]) : 0;
        }
      }
      this.look(
        info.center.x + Math.sin(yaw) * back,
        info.center.y,
        info.center.z + Math.cos(yaw) * back,
        yaw, options.pitch ?? -0.04,
      );
      return { vnum: place.vnum, room: info.room.name, why: place.why, facing: aim ? 'a subject' : 'an exit' };
    },

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

  options.start();

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
