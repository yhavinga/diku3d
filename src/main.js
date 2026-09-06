/**
 * Boot: read the area files, lay the rooms out, bake materials, build the
 * geometry, populate it, and hand the result to a first-person camera.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

import { createPipeline, SkyEnvironment, clampSkyHighlights, OVERLAY_LAYER } from './render.js';
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
import { createGame, SKY } from './game.js';
import { createGameUi } from './game-ui.js';
import { createRain } from './rain.js';

const params = new URLSearchParams(location.search);
// The default world is no longer one town. Midgaard plus the five areas
// around it -- Haon Dor's forest through the West Gate, the Shire, the
// marsh, the troll den and the graveyard off the Concourse -- lay out as ONE
// graph: layout.js runs a single breadth-first placement and every cross-area
// exit resolves to an ordinary routed street you walk (measured: 285 rooms,
// 96.7% walkable, better than Midgaard's own 92.5%). Chosen over the other
// neighbours by measurement, not taste: an area hanging off ONE horizontal
// exit pair grows as a clean branch; two anchors fold it back over the town
// (midennir interleaves forest through the streets, 88.1%), and vertical
// anchors shove open ground three levels up (dream 76.3%). grave is the same
// clean-branch shape -- one two-way anchor #3129 <-> #3600, no vertical one,
// and its 13 tombs hang below on DOWN exits, so nothing gets shoved skyward.
// It also *raises* Midgaard's own number to 93.5%: the dead gate at #3129
// south becomes a walk.
const AREA_FILES = (params.get('areas') || 'midgaard,haon,shire,marsh,trollden,grave')
  .split(',').filter(Boolean).map((f) => (f.endsWith('.are') ? f : `${f}.are`));
const START_VNUM = Number(params.get('room') || 3001);
// A live trap: the breadth-first placement stops mid-walk at the cap, and
// whole areas silently get zero rooms while their exits degrade to gates.
// The default set is 285 rooms; anything bigger must raise ?max= with it.
// tools/world-check.mjs guards this number for the shipping set.
const MAX_ROOMS = Number(params.get('max') || 400);
const AREA_URL = params.get('areaDir') || 'merc21/area';

/**
 * The sky is no longer only scenery: it is baked into an environment cube and
 * is what most surfaces are actually lit by. So the hemisphere light that used
 * to carry all the ambient is now a small floor under it (`ambient`), and the
 * dials that matter are `env` -- how much of the baked sky to believe -- and
 * `bounce`/`haze`, the colour of the ground and the horizon inside that bake.
 *
 * **How much of the light is the sun.** On a clear day the sun delivers roughly
 * eight times what the whole sky does onto a horizontal surface. Here it used
 * to deliver 0.4 times: measured on the composited frame by zeroing
 * `sun.intensity` and re-reading it, the sun was **29% of the ground's
 * luminance at noon** and 18% at dusk. That one number is most of why every
 * frame read flat, and it is why disabling every shadow in the town changed a
 * noon frame by a third of a percent -- there was hardly any direct light to
 * withhold. The fix is not a brighter picture but a differently *balanced* one:
 * the sun goes up about fourfold, `env` and `ambient` come down, and `exposure`
 * halves to put the overall level back where it was. Noon now reads 72%.
 *
 * Two things move with it. Bloom thresholds are read in linear HDR *before*
 * exposure, so quadrupling the sun without quadrupling them blooms every lit
 * wall in town. And the ambient falling means interiors, which have no sun at
 * all, go properly dim -- which is correct, and is why they need practical
 * lights of their own rather than a raised floor under everything.
 *
 * Exposures are set for ACES; see the note where the tone mapping is chosen.
 */
const TIMES = {
  // `ambient`/`env` on the day hours went up half a stop after a judge
  // metered the shade side of a house at 5.9 stops under its sunlit face
  // (linearised), where golden-hour photographs of Rothenburg and Colmar
  // hold 2.5-3.5. Lighter mortar took it to 3.9; this takes it to ~3.4.
  // The sun stays where it is -- days are still sun-dominated, just not
  // crushed in the shadows.
  dawn: {
    elevation: 8, azimuth: 95, exposure: 0.50, fog: 0xc9a586, density: 0.0088,
    sun: 0xffc089, sunIntensity: 23, sky: 0x9fb6d2, ground: 0x5f5142, ambient: 0.082,
    env: 0.35, bounce: 0x5e4f3d, haze: 0xc9a586,
    bloom: 0.16, bloomThreshold: 22, stars: 0.22, turbidity: 5.5, rayleigh: 2.6,
    shafts: 0.5, shaftTint: 0xffd2a0,
    // cover threshold, how much to believe, gain over the sky behind, drift
    cloud: [0.58, 0.9, 1.5, 11.3],
  },
  noon: {
    // 355, not 175: theta is measured from +z, which is *south* (north is -z,
    // the compass says so). 175 put the noon sun due north, so every
    // south-facing frontage sat in permanent shade -- the inverse of any
    // northern-hemisphere reference. Dawn 95 (east) and dusk 258 (west) were
    // already right; the arc now runs east, south, west.
    elevation: 58, azimuth: 355, exposure: 0.165, fog: 0xbcd2e6, density: 0.0060,
    sun: 0xfff4e2, sunIntensity: 22, sky: 0xa3c4e4, ground: 0x6f6455, ambient: 0.105,
    env: 0.42, bounce: 0x77694f, haze: 0xbcd2e6,
    bloom: 0.14, bloomThreshold: 28, stars: 0, turbidity: 3.0, rayleigh: 1.3,
    shafts: 0, shaftTint: 0xffffff,
    cloud: [0.63, 0.85, 1.45, 4.7],
  },
  dusk: {
    elevation: 9.5, azimuth: 258, exposure: 0.55, fog: 0xb87b4e, density: 0.0088,
    sun: 0xff9448, sunIntensity: 26, sky: 0x7b8ea8, ground: 0x50412f, ambient: 0.082,
    env: 0.35, bounce: 0x574433, haze: 0xb87b4e,
    bloom: 0.16, bloomThreshold: 22, stars: 0.32, turbidity: 6.5, rayleigh: 3.0,
    shafts: 0.55, shaftTint: 0xffb469,
    cloud: [0.55, 0.95, 1.6, 27.1],
  },
  night: {
    // Night was a black screen rather than a dark one: mean luma 1.7 of 255,
    // 5.6% of the frame at literally RGB 0 and 93% under luma 4, with the
    // modelled street lamps not lit at all. Four things were wrong. The bake
    // had no sky floor, so what you could see was deep blue and what you were
    // lit by was black. The moon was 0.8 against a daytime sun of 22. The
    // lamps were in the pool at their daylight strength. And there was no
    // haze, which is the one thing that lifts a far wall off zero without
    // lighting anything.
    elevation: -8, azimuth: 300, exposure: 0.62, fog: 0x1a2340, density: 0.024,
    sun: 0x8ea6d6, sunIntensity: 6.2, sky: 0x2b3a5c, ground: 0x171a22, ambient: 1.2,
    env: 1.0, bounce: 0x1a1e28, haze: 0x2c3c62,
    // Rayleigh does the work a black sky cannot: a night sky is deep
    // blue-violet with a brighter band at the horizon, and that band is the
    // only thing giving a roofline a silhouette to be cut against.
    bloom: 0.42, bloomThreshold: 4.0, stars: 1, turbidity: 2.4, rayleigh: 2.2,
    shafts: 0, shaftTint: 0xaabbff,
    cloud: [0.66, 0.8, 1.7, 19.4],
    // Read before exposure and ACES, so it is well under what it looks like.
    // This is now the town's whole ambient term after dark, not just a tint on
    // the visible sky, which is why it is an order of magnitude up.
    skyFloor: 0x2a3a6b, skyFloorGain: 1.2,
  },
};

/**
 * The colours overcast takes over from the hour. Keyed the same way TIMES is,
 * because they are the same four moments seen through a cloud deck: `haze`,
 * the horizon inside the bake, is the fog you are standing in, so it is not
 * listed twice.
 */
const OVERCAST = {
  dawn: { fog: 0xaab0b6, sky: 0xa9b2bc, ground: 0x565149, bounce: 0x53504a },
  noon: { fog: 0xb3bfc9, sky: 0xb6c2cc, ground: 0x635f55, bounce: 0x63625a },
  dusk: { fog: 0x9aa2ab, sky: 0x8f99a6, ground: 0x4a463f, bounce: 0x49473f },
  night: { fog: 0x141a24, sky: 0x232c3a, ground: 0x14161c, bounce: 0x171a20 },
};

/**
 * Weather as a second axis on the hour, not a second set of presets.
 *
 * `clear` is the identity; anything else takes the hour's preset and hands
 * back a modified copy, and `applyTime` reads that copy for everything it
 * touches. So there is still exactly one preset object and one place that
 * reads it, and the visible sky, the environment bake, the fog, the bloom, the
 * shadow map and the figures' hand-placed contact shadows cannot go out of
 * step with each other -- which is the failure mode a second set of presets
 * would have, and it would show up as people casting sunlit shadows under a
 * cloud deck.
 *
 * The reference is a British Columbia overcast: the light every Stargate
 * exterior was shot in, and the reason those hills read as depth rather than
 * as a backdrop. It is sky-dominated light. The direct sun falls to roughly a
 * tenth, the sky itself becomes the source and goes high and pale, shadows
 * lose their edge because the source is now the whole dome, and distance
 * dissolves within a couple of streets. The one number that matters is the
 * sun/sky ratio inverting; the colours here follow from it.
 */
const WEATHER = {
  clear: (p) => p,
  overcast: (p, name) => {
    const hour = OVERCAST[name] ? name : 'dusk'; // the fallback TIMES just took
    const c = OVERCAST[hour];
    const night = hour === 'night';
    return {
      ...p,
      // A fraction of the sun, and none of its colour: cloud is a grey
      // diffuser, so even a dusk sun arrives white rather than gold. 0.12 was
      // tried first and measured 29% of the ground's luminance at noon --
      // enough to still read as a directional day. At 0.07 it measures 23%
      // and no cast edge survives; the reference frames have none either.
      sunIntensity: p.sunIntensity * 0.07,
      sun: 0xe3e9ef,
      sunFraction: 0.15,
      turbidity: Math.max(p.turbidity, 8),
      rayleigh: 0.9,
      // No glare peak through a stratus deck: the Mie term is what puts a
      // bright halo round the sun, and under the cloud gain it blew 3.2% of
      // an overcast dusk frame past sRGB 250 -- more than the clear version
      // of the same shot. There is no disc to see, so there is no halo.
      mie: [0.0016, 0.35],
      // Total cover, fully believed, and a gain of 2. The first cut used a
      // gain just under 1 on the theory that a deck is grey; measured, that
      // put the sky at 1.25x the ground where the reference frames (Stargate's
      // Edora and Hanka exteriors) hold 2.5-2.8x, because the shader derives
      // the cloud's colour from the sky *behind* it -- so a deck that is the
      // light source has to sit well over that sky, not under it. Drift stays
      // whatever the hour asked for.
      cloud: [0.04, 1.0, 2.0, p.cloud[3]],
      // three's Sky carries a second, stock cloud layer; under weather it is
      // part of the same deck, so the weather owns its dials too.
      stockCloud: [0.85, 0.6],
      fog: c.fog, sky: c.sky, ground: c.ground, bounce: c.bounce, haze: c.fog,
      // Aerial haze is most of the look, and it is the one dial that reads as
      // weather rather than as a filter over the same picture. 1.8 was the
      // first cut and it read as sea fog -- a frontage 40 m off dissolved
      // while real BC overcast keeps tens of kilometres of visibility. 1.45
      // keeps a building at 100 m legible and still melts the treeline.
      density: p.density * (night ? 1.3 : 1.45),
      // The sky is the source now. The first balance starved the walls: a
      // white plaster panel metered at half the brightness of the grey paving
      // under it, because vertical faces live entirely off the bake and the
      // hemisphere once the sun is gone. So the ambient terms come up, and
      // exposure gives a little back to keep the sky/ground ratio.
      ambient: night ? p.ambient : p.ambient * 1.8,
      env: night ? p.env : Math.min(1, p.env * 1.4),
      exposure: p.exposure * ({ dawn: 1.45, noon: 1.5, dusk: 1.15, night: 1 })[hour],
      // Damp collecting in the low patches of everything outdoors that keeps
      // a `wet` recipe -- the single most identifiable feature of the look.
      wet: 1.9,
      // A cloud deck hides both. The tint stays, so nothing has to guess at a
      // colour if the shafts are ever switched back on by hand.
      stars: 0,
      shafts: 0,
      // Bloom is left at the hour's own. With the sun at a tenth nothing
      // crosses a daytime threshold, which is right -- overcast has no glare --
      // and night keeps the lamps it blooms.
    };
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

/**
 * Which way to be facing after stepping north, east, south or west. The camera
 * looks down -Z at yaw 0, so this is the same table build.js uses to turn a
 * model's -Z front toward a direction -- worth knowing, because getting it
 * wrong here would be invisible until you noticed you always arrive backwards.
 *
 * Turning you is what keeps the speed honest. Walking is camera-relative, so a
 * player holding W while stepping east carries the same pace into the new room
 * and simply changes course, instead of being spun round and sent back the way
 * they came. Up and down have no heading, so they leave you looking where you
 * were.
 */
const DIR_YAW = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

const TONE_MAPPING = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
};

const weatherParam = params.get('weather');

const state = {
  time: params.get('time') || 'dusk',
  // Two fields, because weather has an owner as well as a value. `weatherMode`
  // is who decides -- 'auto' is the mud's own weather_update in game.js, the
  // other two pin it by hand -- and `weather` is what is actually rendered,
  // always one of the keys in WEATHER. Everything downstream reads only the
  // second, so nothing but `applyWeather` has to know a mode exists.
  weatherMode: weatherParam === 'overcast' || weatherParam === 'auto' ? weatherParam : 'clear',
  weather: weatherParam === 'overcast' ? 'overcast' : 'clear',
  rainLevel: 0,
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
  await progress(0.72, `${Math.round(built.stats.triangles).toLocaleString()} triangles`);

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
  // The overlay quads take themselves off layer 0 to hide from the AO prepass,
  // so the one camera that draws the world has to be told to look there too.
  camera.layers.enable(OVERLAY_LAYER);

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
  const rain = createRain(scene);

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

  const options = createOptions({
    quality, applyTime: (n) => applyTime(n), applyWeather: (w) => applyWeather(w), audio, state,
  });
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

  // The wettest the ground may get, in a downpour. Two things fix it, and
  // neither is taste. Above, the damp term in textures.js takes
  // `1 - wetness * 0.42` off the albedo of the patches water collects in, so
  // anything past 2.38 multiplies a colour by a negative number; 2.25 leaves
  // the core of a puddle at 5% of its dry albedo, which is about what a puddle
  // is, with margin under the wall. Below, overcast already ships `wet: 1.9` --
  // the damp air of the look -- so rain has only the band between the two to
  // work in, and it is measured *from the hour's preset* rather than from dry.
  // Measured from dry it would be worse than useless: SKY_RAINING is 0.65, and
  // 1 + 1.25 * 0.65 comes to 1.78, which is drier than the overcast it rains
  // out of, so ordinary rain would have dried the streets.
  const WET_RAIN = 2.25;
  // Seconds to close 63% of the gap, so three times that is as good as arrived.
  // A mud hour is 40 seconds and a shower is a few of them: wet through inside
  // one, or the rain would stop before the street looked rained on. Drying is
  // nine times slower, which is the asymmetry anyone who has watched a pavement
  // after a shower already knows.
  const WET_RISE = 11;
  const WET_FALL = 95;
  // setWetness walks all 21 baked materials writing a uniform on each. Cheap --
  // no recompile, no upload -- but not free, and a step this small is not a
  // step anyone can see.
  const WET_EPSILON = 0.004;

  /**
   * How wet the ground is: one number, one owner.
   *
   * Two things want to set it, and left to themselves they write over each
   * other: the hour's weather preset (`wet: 1.9` under overcast, damp air) and
   * rain actually falling. So the preset is the baseline and rain is a fraction
   * of the way from it to a downpour, and this is the only caller of
   * `materials.setWetness` in the program.
   *
   * The easing lives here and not in a preset because rain never passes through
   * `applyTime`: the mud walks CLOUDY -> RAINING under one overcast sky, so
   * `mudSky()` reads the same on both sides and nothing rebakes. `state.rainLevel`
   * is the truthful source -- it is already zero unless the weather is on auto,
   * so a hand-pinned clear sky cannot wet the streets.
   */
  const wetness = {
    base: 1,      // what the hour's weather preset asks for
    value: 1,     // where the easing has got to
    applied: 1,   // what the materials were last told
    target() {
      // The max is the guard, not the model: a preset already wetter than a
      // downpour would otherwise be dried by its own rain.
      return Math.max(this.base, this.base + (WET_RAIN - this.base) * state.rainLevel);
    },
    /**
     * The preset's baseline, from `applyTime`. Under the mud's own weather it
     * may cut the ground wetter -- the sky, the fog, the bake and the exposure
     * all cut with it -- but never drier: a sky clearing after rain leaves
     * streets that are still wet, and they dry on the clock below. A sky pinned
     * by hand is not weather but an authoring control, and there `clear` has to
     * mean clear in this frame, not in five minutes.
     */
    setBase(value) {
      this.base = value;
      this.value = state.weatherMode === 'auto'
        ? Math.max(this.value, this.target())
        : this.target();
      this.push();
    },
    update(dt) {
      const target = this.target();
      const gap = target - this.value;
      if (gap !== 0) {
        this.value = Math.abs(gap) < WET_EPSILON ? target
          : this.value + gap * (1 - Math.exp(-dt / (gap > 0 ? WET_RISE : WET_FALL)));
      }
      this.push();
    },
    push() {
      if (Math.abs(this.value - this.applied) < WET_EPSILON) return;
      this.applied = this.value;
      materials.setWetness(this.value);
    },
  };

  applyTime(state.time);

  function applyTime(name) {
    const base = TIMES[name] || TIMES.dusk;
    // The single choke point, and the reason weather is a modifier rather than
    // a preset of its own: everything below reads `preset` and nothing below
    // reads `state.weather`, so there is no way for the sky, the bake and the
    // shadows to end up in different weather.
    const preset = (WEATHER[state.weather] || WEATHER.clear)(base, name);
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
    sky.material.uniforms.mieCoefficient.value = preset.mie?.[0] ?? 0.006;
    sky.material.uniforms.mieDirectionalG.value = preset.mie?.[1] ?? 0.86;
    // The stock cloud layer inside three's Sky, normally left at its shipped
    // defaults; weather may take it over. Set on the bake too, below.
    sky.material.uniforms.cloudCoverage.value = preset.stockCloud?.[0] ?? 0.4;
    sky.material.uniforms.cloudDensity.value = preset.stockCloud?.[1] ?? 0.4;
    skyRange.setFloor(preset.skyFloor ?? 0x000000, preset.skyFloorGain ?? 0);
    skyRange.setCloud(...preset.cloud);
    sun.position.copy(sunPosition).multiplyScalar(120);
    sun.color.setHex(preset.sun);
    sun.intensity = preset.sunIntensity;
    hemi.color.setHex(preset.sky);
    hemi.groundColor.setHex(preset.ground);
    hemi.intensity = preset.ambient;
    scene.fog = new THREE.FogExp2(preset.fog, preset.density);
    // Rain-damp on everything outdoors that keeps a wet recipe; identity for
    // clear weather. It is a material global and there is no per-room copy, so
    // it reaches interiors too -- but `planks` and `marble` are `wet: 0` and do
    // not even compile the damp branch, and the one wet recipe that gets indoors
    // is `flagstone` at 0.16, where the whole span from dry to a downpour moves
    // the darkest patch of an up-facing floor by 8% of its albedo.
    //
    // The preset is only the baseline -- rain falling adds to it, and `wetness`
    // owns the sum, so this path and the frame loop cannot disagree.
    wetness.setBase(preset.wet ?? 1);
    // Rain is lit by the hour's own haze, so it reads silver by day and all
    // but disappears at night, which is how night rain behaves.
    rain.setColour(preset.haze);
    // The bog's ground mist, lit by the same haze the rain is and thickest when
    // the ground is coldest. Only the marsh has any, so this is null elsewhere.
    built.mist?.setHour(preset.haze, preset.elevation);
    renderer.toneMappingExposure = preset.exposure;
    bloom.strength = preset.bloom;
    bloom.threshold = preset.bloomThreshold;
    stars.material.opacity = preset.stars;
    stars.visible = preset.stars > 0;
    shaftTint.setHex(preset.shaftTint);
    state.shaftGain = preset.shafts;
    // Figures are kept out of the shadow map, so their contact shadows are
    // placed by hand and have to be told where the light is coming from.
    actors.setSun(sunPosition, preset.elevation, preset.sunFraction ?? 1);
    // The water mirrors the hour's sky -- preset.sky, not haze: noon's sky is
    // within 4/255 of what the shader always assumed, so clear noon holds
    // still, while overcast pales it and night stops it glowing (the sheet
    // used to keep a daytime blue at night exposure and metered lum 185).
    actors.setSky(preset.sky, preset.sunFraction ?? 1);
    // And the windows have to be told there is daylight outside them, or from
    // inside a room they are black rectangles at head height.
    const daylight = THREE.MathUtils.clamp(preset.elevation / 22, 0, 1) * 0.75;
    actors.setDaylight(preset.haze, daylight);
    // Whether it is day, for things that are lit *because* it is dark. Fully
    // out above twelve degrees of sun, fully lit below two, so the lamps are a
    // faint glow at golden hour, gone at noon, and the whole light of the town
    // after dark.
    lightPool.setDaylight(THREE.MathUtils.clamp((preset.elevation - 2) / 10, 0, 1));
    // The panes on the modelled buildings are one material for the whole town,
    // so they cannot be lit house by house. They still light: sky by day, and
    // after dark the hearth behind them, or no window in Midgaard is ever on.
    if (assets) {
      assets.setWindowLight(daylight > 0.05 ? preset.haze : 0xff9c46,
        daylight > 0.05 ? daylight : 0.85);
    }

    // Rebake the environment from the sky we just set up. This is the whole
    // ambient term, so it has to happen before the next frame -- and it is a
    // cube render plus a blur chain, so it must not happen during one.
    environment.update(scene, {
      sunPosition,
      turbidity: preset.turbidity,
      rayleigh: preset.rayleigh,
      mieCoefficient: preset.mie?.[0] ?? 0.006,
      mieDirectionalG: preset.mie?.[1] ?? 0.86,
      ground: preset.bounce,
      horizon: preset.haze,
      intensity: preset.env,
      // The same floor the visible sky gets. Without it the bake goes black
      // after dark and the town has no ambient at all.
      skyFloor: preset.skyFloor ?? 0x000000,
      skyFloorGain: preset.skyFloorGain ?? 0,
      cloud: preset.cloud,
      stockCloud: preset.stockCloud,
    });

    shadowAnchor.set(Infinity, Infinity, Infinity); // the sun moved: redraw shadows
    hud.toast(state.weather === 'clear' ? `${name}` : `${name} · ${state.weather}`);
  }

  /**
   * The other axis. Same hour, different sky; `applyTime` does all the work.
   *
   * 'auto' is not a sky but an owner: it hands the choice to the mud's
   * barometer and takes whatever that reads now. The two named values pin it.
   */
  function applyWeather(name) {
    state.weatherMode = name === 'auto' || WEATHER[name] ? name : 'clear';
    const sky = state.weatherMode === 'auto' ? mudSky() : state.weatherMode;
    state.weather = WEATHER[sky] ? sky : 'clear';
    applyTime(state.time);
  }

  /**
   * The mud's four sky states over the viewer's two. SKY_CLOUDLESS is the clear
   * preset; cloudy, raining and lightning are all the same deck overhead until
   * something draws rain, which is why `game.weather()` keeps the raw value.
   */
  function mudSky() {
    return game.weather().sky === SKY.CLOUDLESS ? 'clear' : 'overcast';
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
  // One buffered press, so reading the map fast still works: a second arrow
  // during a glide queues and fires on arrival instead of being swallowed.
  let queuedStep = null;

  function step(dir) {
    if (player.gliding) { queuedStep = dir; return; }
    if (fadeTimer > 0) return;
    const here = currentRoom();
    const room = here && world.rooms.get(here);
    if (!room) return;
    const exit = room.exits[dir];
    const name = DIR_NAME[dir];
    if (!exit) { hud.toast(`no exit ${name}`); return; }
    // Worth naming the room number. "Outside the loaded world" sounds like a
    // dead end and is not one: the exit is real in the mud and leads into an
    // area file this session did not load, so the vnum is exactly what you need
    // to find it -- The Dump's south is #3504 in midennir.are. Load it with
    // ?areas=midgaard,midennir and the exit works.
    if (exit.offMap) { hud.toast(`${name}: #${exit.to} is in an area not loaded`); return; }
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
    // An ordinary next-room exit is walked, not cut to: the target sits where
    // the compass says it should, near ground level, within a couple of cells.
    // Anything else -- a portal, a stair, a layout that had to bend -- keeps
    // the fade, because gliding through a wall would say something false.
    const hereInfo = built.rooms.get(room.vnum);
    if (dir < 4 && hereInfo) {
      const ox = target.center.x - hereInfo.center.x;
      const oy = target.center.y - hereInfo.center.y;
      const oz = target.center.z - hereInfo.center.z;
      const flat = Math.hypot(ox, oz);
      const [sx, , sz] = DIR_STEP[dir];
      const along = ox * sx + oz * sz;
      const onArrive = () => {
        const queued = queuedStep;
        queuedStep = null;
        if (queued !== null) step(queued);
      };
      if (Math.abs(oy) < 3.2 && flat > 6 && flat < 46 && along > 0.82 * flat) {
        player.glide(target.center.x, target.center.y, target.center.z, DIR_YAW[dir], onArrive);
        return;
      }
      // Off-axis, but routed: a quarter of Midgaard's exits land somewhere
      // other than the direction the mud names, and those used to cut to
      // black -- "Poor Alley to the eastern end, instant, even with a 180".
      // The layout walked every such exit through the streets, and the link
      // remembers its path, so the step walks the same streets round the
      // bend -- Poor Alley's own detour is five cells and four corners, and
      // walking it is the honest answer to where "east" actually goes here.
      // Stairs and portals still cut.
      const link = Math.abs(oy) < 3.2 && layout.links.find((l) => l.kind === 'alley' && l.path && l.to
        && ((l.from.vnum === room.vnum && l.to.vnum === exit.to)
          || (l.to.vnum === room.vnum && l.from.vnum === exit.to)));
      if (link && link.path.length <= 6) {
        const cells = link.from.vnum === room.vnum ? link.path : [...link.path].reverse();
        const points = cells.map((c) => ({ x: c.x * CELL, y: target.center.y, z: c.z * CELL }));
        points.push(target.center);
        player.glidePath(points, null, onArrive);
        return;
      }
    }
    fadeTimer = 0.34;
    dom.fade.style.opacity = '1';
    setTimeout(() => {
      // `spawn` zeroes the velocity, which is right when you arrive through a
      // portal and wrong here: stepping to the next room should move you, not
      // stop you. Carry it across, so standing still stays standing still and
      // a fall keeps falling onto the new floor.
      const carried = player.velocity.clone();
      const yaw = DIR_YAW[dir] ?? camera.rotation.y;
      player.spawn(target.center.x, target.center.y, target.center.z, yaw);
      player.velocity.copy(carried);
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

    // The mud's barometer may have crossed a sky boundary in that update.
    // `applyWeather` rebakes the whole environment, so it is called only when
    // the value it would render actually changes -- never once a frame.
    if (state.weatherMode === 'auto' && mudSky() !== state.weather) applyWeather('auto');

    // Rain falls out of the mud's sky, not the options screen: it only ever
    // runs under auto, when the barometer says RAINING or worse. The streaks
    // need open sky overhead; the sound stays on indoors -- audio halves it
    // itself, and rain on the roof is half of what rain is for.
    {
      const sky = state.weatherMode === 'auto' ? game.weather().sky : SKY.CLOUDLESS;
      const level = sky === SKY.LIGHTNING ? 1 : sky === SKY.RAINING ? 0.65 : 0;
      if (level !== state.rainLevel) {
        state.rainLevel = level;
        audio.setRain(level);
      }
      const outdoorNow = state.roomVnum !== null && (built.rooms.get(state.roomVnum)?.outdoor ?? true);
      rain.setIntensity(outdoorNow ? level : 0);
      rain.update(dt, camera.position);
      // The ground remembers the rain after the streaks stop. Unlike the
      // streaks this is not gated on standing outdoors: it is raining on the
      // town, not on you, so a street seen from a doorway is still wet.
      wetness.update(dt);
    }

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
    // `wetness` is exposed because it is a slow-moving number nothing on screen
    // reports: reading .value against .target() is how you tell a street that is
    // drying from one that has dried.
    pipeline, environment, materials, wetness,
    player, hud, layout, built, actors, world, applyTime, applyWeather, state, times: TIMES,
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
      const taken = new Set();
      const add = (key, vnum, why, target = null, time = null) => {
        if (vnum === undefined || seen.has(key) || !built.rooms.has(vnum)) return;
        seen.add(key);
        taken.add(vnum);
        out.push({ key, vnum, room: built.rooms.get(vnum).room.name, why, target, time });
      };
      const rooms = [...built.rooms.entries()].filter(([, i]) => !i.unbuilt);
      /**
       * The best room a test admits, or nothing at all. A category that finds
       * no room is skipped rather than forced onto a bad one, which is what
       * keeps this total: `?areas=midgaard` has no forest, no bog and no
       * graveyard in it and still returns a usable list.
       *
       * With no score it is the first match, as it always was. A room already
       * spoken for is only taken again if nothing else fits, because every key
       * should be its own place -- `water` and `square` both used to land on
       * the fountain in the Temple Square, so a reviewer shot it twice.
       */
      const pick = (test, score = null) => {
        let chosen;
        let best = -Infinity;
        for (const [vnum] of rooms) {
          const room = world.rooms.get(vnum);
          if (!test(room)) continue;
          const value = (score ? score(room) : 0) - (taken.has(vnum) ? 1e6 : 0);
          if (value > best) { best = value; chosen = vnum; }
        }
        return chosen;
      };
      const ways = (r) => r.exits.filter(Boolean).length;
      // Something to point the camera at: `shoot` aims at the nearest prop or
      // mobile within the room, and finds a wall in an empty one.
      const stuff = (r) => r.items.length + r.mobs.length;

      add('water', pick((r) => r.items.some((o) => o.proto.itemType === 25
          || /fountain|well|water/.test(o.proto.keywords))),
        'a fountain: animated water, refraction, wet stone');
      add('watersector', pick((r) => r.sector === 6 || r.sector === 7), 'open water');
      add('square', pick((r) => ways(r) >= 4 && r.sector === 1),
        'the widest open space: pavement, frontage, silhouettes');
      add('street', pick((r) => r.sector === 1 && ways(r) === 2),
        'a street between two frontages, for receding perspective');
      add('interior', pick((r) => r.sector === 0 && /temple|hall|sanctum/i.test(r.name)),
        'a lit stone interior: light falloff, torches, shadowed material');
      add('shop', pick((r) => r.mobs.some((m) => m.shop)), 'a shopkeeper and their stock');
      // Haon Dor's heart, not the Shire's hedgerow -- which is where the first
      // forest room in walking order happens to be. The mud's own words for the
      // stand are "deep, dark" and "dense", and those are the rooms that got a
      // closed fir canopy: 44 of them carry ROOM_INDOORS, which there means no
      // sky rather than indoors.
      add('forest', pick((r) => r.sector === 3,
        (r) => (/deep, dark/i.test(r.name) ? 3 : 0) + (/dense/i.test(r.name) ? 2 : 0)
            + ways(r) + stuff(r)),
        'dense fir forest under a closed canopy: trunk scale, undergrowth');
      add('field', pick((r) => r.sector === 2), 'open ground and horizon');
      // Peat is build.js's own answer to "is this a bog": `isBog` picks the
      // floor, so asking the floor asks that question once instead of keeping a
      // second copy of its vocabulary here. Standing water in the name puts a
      // pool where the camera is already looking.
      add('bog', pick((r) => built.rooms.get(r.vnum).materials.floor === 'peat',
        (r) => ways(r) + stuff(r) * 0.5 + (/pool|water/i.test(r.name) ? 2 : 0)),
        'the marsh: peat, standing water, reeds and ground mist');
      // Match the name and not the area file, and stay above ground: the
      // thirteen tombs are cellars off these paths, and a room the mud itself
      // calls a Graveyard is the one carrying headstones however they were
      // placed. Prose alone is not enough -- Midgaard's Concourse describes the
      // graveyard it leads to, and it is a street.
      add('graveyard', pick((r) => built.rooms.get(r.vnum).outdoor
          && /\b(graveyard|graves?|tombs?|crypt)\b/i.test(r.name),
        (r) => (/graveyard/i.test(r.name) ? 3 : 0) + ways(r) + stuff(r)),
        'headstones on open ground, gravel underfoot, sky over a burial place');
      // A gate the world is walled off at, not a trapdoor: the Temple's `up` to
      // #3700 is off-map too, and used to win this outright -- an interior with
      // a bricked-up ceiling is not what the key means.
      add('gate', pick((r) => built.rooms.get(r.vnum).outdoor
          && r.exits.some((e, i) => e && e.offMap && i < 4),
        (r) => (/gate/i.test(r.name) ? 3 : 0) + ways(r) + stuff(r)),
        'a sealed gate out of the world');
      add('crowd', pick((r) => r.mobs.length >= 2), 'several mobiles together');
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
  // The triangle count is rounded because an indexed geometry's triangles are
  // index.count/3 and the sum is taken over position.count/3, so it comes out
  // fractional: the title used to read "1,454,852.667 triangles".
  dom.titleStats.textContent = `${layout.stats.placed} rooms · ${layout.stats.alleys + layout.stats.stairs} passages · `
    + `${layout.stats.portals} archways · ${Math.round(built.stats.triangles).toLocaleString()} triangles`;
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
