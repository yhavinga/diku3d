/**
 * Boot: read the area files, lay the rooms out, bake materials, build the
 * geometry, populate it, and hand the result to a first-person camera.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

import { createPipeline, SkyEnvironment, clampSkyHighlights, OVERLAY_LAYER } from './render.js';
import { parseArea, buildWorld, DIR_STEP, DIR_NAME, REVERSE_DIR, SECTOR, SECTOR_NAME, EX_CLOSED } from './are.js';
import { AFF } from './magic.js';
import { planZones, layoutZone, zoneWorld, arrivalYaw, HOME_AREAS, HOME_START, HOME_MAX_ROOMS } from './zones.js';
import { createZoneCard, levelsOf, firstLine } from './zonecard.js';
import { collectResources, disposeZoneGraph } from './teardown.js';
import { createMaterials, bakeJobs, runBake } from './textures.js';
import { bakeTextures } from './bakery.js';
import { buildScene, CELL, LEVEL_H } from './build.js';
import { populate } from './actors.js';
import { Player } from './player.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { Quality, LightPool, PRESETS, IDLE_SLEEP_MS } from './quality.js';
import { createOptions } from './options.js';
import { AssetLibrary, ASSET_NAMES } from './assets.js';
import { createGame, SKY } from './game.js';
import { createGameUi } from './game-ui.js';
import { createFx } from './fx.js';
import { createSpellFx } from './spellfx.js';
import { createRain } from './rain.js';
import { createItems } from './items.js';
import { installSave } from './save.js';
import { createKick } from './kick.js';
import { setPaneDaylight } from './windows.js';
import { createVisibility } from './cull.js';
import { createImpostors } from './impostor.js';
import { createOcclusion } from './occlusion.js';
import { createTitleReel } from './title.js';
import { attachSocketLink, SocketLink } from './link.js';
import { createConnectUi } from './link-ui.js';
import { OUTDOOR_FILL } from './dress.js';

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
// The sewer is the one that goes *under*: five of Midgaard's own rooms drop
// into it (the Dump's ladder and the guild wells), every anchor is vertical
// and downward, so it lays out a level below the town and cannot shove
// anything on the surface -- 460 rooms, 94% walkable, Midgaard still 93%.
// The Great Eastern Desert is the clean-branch shape again: one two-way
// anchor, the river through the east wall at #3205 -- 507 rooms, 94%.
// Raff's Dangerous Neighborhood hangs off the East Gate the same way, one
// two-way anchor #3041 <-> #2171 -- 579 rooms, 95%, Midgaard still 93%.
// It shares its side of town with the desert, so layout.js lays it down
// whole (see LAID_WHOLE) and Wall Road becomes the long street it says it is.
//
// That set is now the *home zone* (zones.js HOME_AREAS). Every other area in
// area.lst is loaded too -- the rules engine runs all of them -- and each is a
// zone of its own, laid out alone and built when you cross into it. `?areas=`
// names a different home zone; nothing else changes.
const HOME_FILES = params.get('areas')
  ? params.get('areas').split(',').filter(Boolean).map((f) => (f.endsWith('.are') ? f : `${f}.are`))
  : HOME_AREAS;
const START_VNUM = Number(params.get('room') || 3001);
// A live trap: the breadth-first placement stops mid-walk at the cap, and
// whole areas silently get zero rooms while their exits degrade to gates.
// The home zone is 579 rooms; anything bigger must raise ?max= with it.
// tools/world-check.mjs guards this number for the shipping set.
const MAX_ROOMS = Number(params.get('max') || HOME_MAX_ROOMS);
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
  //
  // **`density` is a visibility, and it can be read straight off.** `FogExp2`
  // squares it, so transmittance is `exp(-(d*density)^2)` and contrast is
  // halved at `0.8326 / density` metres. At 0.0088 that is 95 m: a judge
  // measured the far hills dissolving to bare sand and the skyline going
  // brown, because in clear air the same figure is 1-2 km. The clear day
  // hours now sit at 520 m (dawn, dusk) and 694 m (noon) -- still hazy
  // enough to give the town depth, and Pacific-Northwest rather than dust.
  // Night keeps its 35 m on purpose: it is what lifts a far wall off zero
  // and hides the edge of the world. Overcast keeps its own, below.
  dawn: {
    elevation: 8, azimuth: 95, exposure: 0.50, fog: 0xbaa089, density: 0.0016,
    sun: 0xffc089, sunIntensity: 23, sky: 0x9fb6d2, ground: 0x5f5142, ambient: 0.082,
    env: 0.35, bounce: 0x5e4f3d, haze: 0xc9a586, shadeLift: 2.8,
    bloom: 0.16, bloomThreshold: 22, stars: 0.22, turbidity: 5.5, rayleigh: 2.6,
    // Below the bloom threshold: the low sun's quarter of sky bloomed into a
    // veil over half the frame. See `broad` in render.js.
    skyBroad: 18,
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
    elevation: 58, azimuth: 355, exposure: 0.165, fog: 0xbcd2e6, density: 0.0012,
    // **The hemisphere light is the ground bounce, and only at noon.**
    //
    // With the sun high, no vertical face gets any direct light at all, so
    // every wall in the town falls to whatever the ambient is -- and a judge
    // metered the shaded side of a house against the sunlit paving at 24:1
    // where photographs of a sunny town square hold 4-6:1. The missing light
    // is not the sky, which the bake already delivers: it is the *sunlit
    // ground*, which under a high sun throws back about 70% of everything a
    // shaded wall receives. `env` cannot supply it -- raising the bake lifts
    // the shaded wall and the shadow lying on the paving by the same factor,
    // and measured, `env` 0.42 -> 1.35 fixed the wall (24:1 -> 5:1) while
    // flattening cast shadows on the ground from 8.4:1 to 2.2:1, which is a
    // sunny day with no shadows in it. The bake's own ground dome cannot
    // supply it either: it fades to alpha 0 at the rim, and the rim is
    // precisely the direction a vertical surface integrates most strongly
    // (bounce x3 moved the wall by one sRGB step).
    //
    // A hemisphere light with a *black* sky half and a bright ground half is
    // exactly that term, and nothing else: it gives a vertical face half the
    // bounce colour, an underside all of it, and an up-facing face -- the
    // paving in shadow -- nothing whatever. Measured at the Market Square at
    // noon: shaded wall 24.0:1 -> 5.6:1, cast shadow on the paving 8.6:1 ->
    // 8.4:1, sunlit cobble 183 -> 188 sRGB, frame under sRGB 8 2.05% -> 0.00%,
    // nothing over 250 either side. The intensity looks absurd next to dawn's
    // 0.082 because it is a different quantity: the sky's own bake is clamped
    // at 60, so anything measured against it lives on that scale.
    //
    // Black, not a dim blue: any sky colour here is counted twice -- once in
    // the bake and once on the hemisphere -- and it lands on the up-facing
    // surfaces, which is what flattens the shadows.
    // A hemisphere light has no occlusion term, so this one lit the inside of
    // the temple exactly as hard as it lit the shaded wall outside: the
    // interior's mean went 81 -> 140 the day it arrived and the torch pools
    // stopped reading. There is no sunlit ground inside a building, so
    // `hemiIndoor` is the fraction of it that reaches geometry built inside an
    // enclosed room -- see `indoorBounce` in textures.js. Dimming the light
    // itself instead was measured and trades straight against the thing it was
    // added for: at intensity 12 the temple comes back to 110 but the market's
    // sunlit-cobble:shaded-wall ratio goes 3.4:1 -> 6.2:1, against the 4-6 a
    // judge asks for. This costs the market nothing.
    sun: 0xfff4e2, sunIntensity: 22, sky: 0xa3c4e4, ground: 0xb0a894, ambient: 32,
    hemiSky: 0x000000, hemiIndoor: 0.22,
    // A shaded street at noon does not see a whole sky: half of what is over
    // it is sunlit wall and paving, warm and neutral. Taken straight from the
    // cube the shade was lit by pure sky, and a cast shadow on #2159's cobble
    // metered B/R 1.41 (46,55,65) where a skylit fill holds 1.05-1.15. This
    // takes that share of the sky's hue out of the diffuse term outdoors
    // (reflections keep their blue).
    skyBleach: 0.55, skyBleachTint: 0xfff5e3,
    env: 0.42, bounce: 0x77694f, haze: 0xbcd2e6,
    bloom: 0.14, bloomThreshold: 28, stars: 0, turbidity: 3.0, rayleigh: 1.3,
    shafts: 0, shaftTint: 0xffffff,
    cloud: [0.63, 0.85, 1.45, 4.7],
  },
  dusk: {
    // The fog colour is pulled a third of the way to the hour's own horizon
    // sky, measured away from the sun: dusk's sky reads (181,176,177) there
    // while the fog was (184,123,78), so every distant fir was tinted with a
    // sunset that only exists in one direction. It is still warm, because at
    // this elevation the haze genuinely is.
    elevation: 9.5, azimuth: 258, exposure: 0.55, fog: 0xb68c6b, density: 0.0016,
    sun: 0xff9448, sunIntensity: 26, sky: 0x7b8ea8, ground: 0x50412f, ambient: 0.082,
    env: 0.35, bounce: 0x574433, haze: 0xb87b4e, shadeLift: 2.8,
    bloom: 0.16, bloomThreshold: 22, stars: 0.32, turbidity: 6.5, rayleigh: 3.0,
    // Below the bloom threshold: the low sun's quarter of sky bloomed into a
    // veil over half the frame. See `broad` in render.js.
    skyBroad: 18,
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
    // The directional light is a moon, 34 degrees up in the south-south-east
    // (see applyTime): an open field has to be lit by *something* from above.
    // Measured at the graveyard, #3604: 55% of the frame under luma 8 with
    // the old light from under the world, 8% now. The ambient came up with it
    // and lost most of its blue -- a moonlit night reads blue because of the
    // eye, not because skylight is sapphire; at the old 1.2 of 0x2b3a5c the
    // shade on grass came out RGB 3,8,15, which is black with a tint.
    moon: [34, 330],
    sun: 0x8ea6d6, sunIntensity: 2.0, sky: 0x2b3a5c, ground: 0x171a22, ambient: 6,
    // Indoors keeps the old 1.2 of it: there is no open sky inside a room.
    hemiSky: 0x4a5468, hemiIndoor: 0.2, skyBleach: 0.5, skyBleachTint: 0xe4ecff,
    env: 1.0, bounce: 0x1a1e28, haze: 0x2c3c62, shadeLift: 3.5,
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
 *
 * `ambient` and `density` are here as absolute numbers rather than multipliers
 * on the hour, because the two axes have stopped agreeing about what those
 * numbers mean. Under a deck there is no sun, so there is no ground bounce and
 * no thin clear air: the hemisphere goes back to being a floor and the haze
 * goes back to melting the treeline within a couple of streets. Left as
 * `p.ambient * 1.8` and `p.density * 1.45` the clear day's repairs would have
 * arrived here too -- overcast noon would have inherited a bounce intensity of
 * 58 and a visibility of a kilometre, neither of which is weather.
 */
const OVERCAST = {
  dawn: { fog: 0xaab0b6, sky: 0xa9b2bc, ground: 0x565149, bounce: 0x53504a, ambient: 0.1476, density: 0.01276 },
  noon: { fog: 0xb3bfc9, sky: 0xb6c2cc, ground: 0x635f55, bounce: 0x63625a, ambient: 0.189, density: 0.0087 },
  dusk: { fog: 0x9aa2ab, sky: 0x8f99a6, ground: 0x4a463f, bounce: 0x49473f, ambient: 0.1476, density: 0.01276 },
  night: { fog: 0x141a24, sky: 0x232c3a, ground: 0x14161c, bounce: 0x171a20, ambient: 1.2, density: 0.0312 },
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
      // No sun means no sunlit ground to bounce off it, so the hemisphere is a
      // floor again and its upper half is the deck rather than noon's black.
      // Which also means it is an honest ambient again and interiors want all
      // of it -- noon's `hemiIndoor` must not survive the spread above.
      hemiSky: c.sky, hemiIndoor: 1,
      // Aerial haze is most of the look, and it is the one dial that reads as
      // weather rather than as a filter over the same picture. 1.8 was the
      // first cut and it read as sea fog -- a frontage 40 m off dissolved
      // while real BC overcast keeps tens of kilometres of visibility. 1.45
      // keeps a building at 100 m legible and still melts the treeline. Both
      // it and the ambient below are absolute now; see the note on OVERCAST.
      density: c.density,
      // The sky is the source now. The first balance starved the walls: a
      // white plaster panel metered at half the brightness of the grey paving
      // under it, because vertical faces live entirely off the bake and the
      // hemisphere once the sun is gone. So the ambient terms come up, and
      // exposure gives a little back to keep the sky/ground ratio.
      ambient: c.ambient,
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
  // `null` means the mud's barometer decides, which is nearly always. Anything
  // else is `diku.forceRain` holding it there so rain can be looked at without
  // waiting for the weather to turn -- see the note on the hook itself.
  forcedRain: null,
  showStats: false,
  worldStats: null,
  roomVnum: null,
  paused: true,
};

const dom = {
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loading-text'),
  loadingBar: document.getElementById('loading-bar'),
  loadingDetail: document.getElementById('loading-detail'),
  title: document.getElementById('title'),
  enter: document.getElementById('enter'),
  fade: document.getElementById('fade'),
  hint: document.getElementById('hint'),
};

/**
 * Say what is about to happen, then let a frame paint before it starts: the
 * steps are synchronous, so a label set *after* one only ever showed during
 * the next -- "laying out the streets" (27 ms) sat on screen through the 6.6 s
 * texture bake. Fractions are where each step starts, weighted by measured
 * time; the shimmer on the bar is a compositor animation and keeps moving
 * while the main thread is busy.
 */
const progress = (fraction, text, detail = '') => {
  dom.loadingBar.style.width = `${(fraction * 100).toFixed(1)}%`;
  if (text) dom.loadingText.textContent = text;
  dom.loadingDetail.textContent = detail;
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
};

/** The bar alone, mid-step, without waiting for a frame: the step's own work is off this thread. */
const progressBar = (fraction, detail) => {
  dom.loadingBar.style.width = `${(fraction * 100).toFixed(1)}%`;
  dom.loadingDetail.textContent = detail;
};

/**
 * Where each boot step starts and ends on the bar, from what the steps took
 * (ms, headless Chromium on an M-series Mac, home zone, wave 10). Reading and
 * laying out come first and are fixed at 0-2%; the rest is shared out by
 * time once it is known how much of the bake the cache holds -- 1.15 s baked
 * on eight workers against 0.13 s read back -- so the bar runs at one speed
 * on a first visit and on a repeat one.
 */
const STEP_MS = { bake: 1150, bakeCached: 130, carve: 230, raise: 2980, people: 850, mud: 30, compile: 820 };
function bootPlan(cachedShare) {
  const ms = { ...STEP_MS, bake: STEP_MS.bakeCached * cachedShare + STEP_MS.bake * (1 - cachedShare) };
  const steps = ['bake', 'carve', 'raise', 'people', 'mud', 'compile'];
  const total = steps.reduce((sum, k) => sum + ms[k], 0);
  const plan = {};
  let at = 0.02;
  for (const k of steps) { plan[k] = [at, at + (ms[k] / total) * 0.98]; at = plan[k][1]; }
  return plan;
}
/**
 * The same for a crossing's card, from school -> home (the long way: build
 * 2.8 s, populate 0.47, compile 0.13-0.25, teardown and mount tens of ms).
 * The short way spends about the same shares.
 */
const CROSS_BAR = { teardown: 0.01, build: [0.02, 0.8], populate: [0.8, 0.93], compile: [0.94, 1] };
/** `fraction` of the way through a step `[start, end]`. */
const along = ([a, b], fraction) => a + (b - a) * fraction;

const fetchText = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot read ${url}: HTTP ${response.status}`);
  return response.text();
};

async function boot() {
  // The texture bake needs nothing from the world, so it starts first and runs
  // in its workers while the area files are read and laid out. What it reports
  // before its own step comes up is held until then.
  let bakeShown = null;
  let bakesDone = 0;
  let lastBake = [0, ''];
  let cachedShare = 0;
  const baking = bakeTextures(bakeJobs(512), runBake, {
    fresh: params.get('bake') === 'fresh',
    onStart: ({ cached, jobs }) => { cachedShare = cached / jobs; },
    onProgress: (fraction, key) => { bakesDone++; lastBake = [fraction, key]; bakeShown?.(fraction, key); },
  });
  // Not a swallow: the same promise is awaited below, where a failure stops the boot.
  baking.catch(() => {});
  await progress(0, 'reading the area files');
  // The mud boots off area.lst, so does this: every area it lists, plus any
  // the home zone names that it does not.
  const listed = (await fetchText(`${AREA_URL}/area.lst`)).split(/\s+/).filter((f) => f.endsWith('.are'));
  const files = [...listed, ...HOME_FILES.filter((f) => !listed.includes(f))];
  const texts = await Promise.all(files.map((file) => fetchText(`${AREA_URL}/${file}`)));
  const areas = [];
  for (let i = 0; i < files.length; i++) {
    areas.push(parseArea(texts[i], files[i]));
    if (i % 8 === 7) await progress(0.01 * ((i + 1) / files.length), 'reading the area files', `${i + 1} of ${files.length} · ${files[i]}`);
  }

  const world = buildWorld(areas);
  // `?areas=` without the temple keeps its old meaning: lay out from ?room.
  const plan = planZones(world, {
    home: HOME_FILES,
    homeStart: HOME_FILES.includes('midgaard.are') ? HOME_START : START_VNUM,
    homeMax: MAX_ROOMS,
  });

  // Deterministic, so cached: the same zone is the same layout every time.
  const layouts = new Map();
  const views = new Map();
  const layoutOf = (z) => {
    if (!layouts.has(z.id)) layouts.set(z.id, layoutZone(world, plan, z));
    return layouts.get(z.id);
  };
  const viewOf = (z) => {
    if (!views.has(z.id)) views.set(z.id, zoneWorld(world, z));
    return views.get(z.id);
  };
  // The zone the start room is in -- the home zone unless `?room=` says
  // otherwise. A saved character elsewhere crosses there from the title.
  let zone = plan.zoneOf(START_VNUM) || plan.home;
  await progress(0.01, 'laying out the streets', `${world.rooms.size} rooms in ${files.length} areas`);
  let layout = layoutOf(zone);

  const bar = bootPlan(cachedShare);
  await progress(bar.bake[0], 'baking stone, timber and thatch', 'every surface is generated here, not downloaded');
  const jobCount = bakeJobs(512).length;
  bakeShown = (fraction, key) => progressBar(along(bar.bake, fraction),
    `${key.replace(/^\w+:|@\d+$/g, '')} · ${bakesDone} of ${jobCount}`);
  if (bakesDone) bakeShown(...lastBake);
  const { baked, stats: bakeStats } = await baking;
  console.info(`textures: ${bakeStats.jobs} bakes in ${bakeStats.ms.toFixed(0)} ms on ${bakeStats.workers} workers,`
    + ` ${bakeStats.cached} from this browser's cache, ${bakeStats.baked} baked`);
  bakeStats.stored.then((bytes) => console.info(`textures: cache holds ${(bytes / 1e6).toFixed(1)} MB`));
  const materials = createMaterials(512, () => {}, baked);

  // Modelled assets are optional: anything missing falls back to the
  // procedural geometry, so the viewer runs against a half-built library.
  if (params.get('assets') !== 'off') await progress(bar.carve[0], 'carving the furniture', `${ASSET_NAMES.length} models`);
  const assets = params.get('assets') === 'off' ? null
    : await new AssetLibrary(materials).load(ASSET_NAMES);
  if (assets) {
    if (assets.unknownTags.size) {
      console.warn('assets: no material for tag(s)', [...assets.unknownTags].join(', '));
    }
  }

  const raising = `${layout.cells.size} rooms of ${zone.name || 'the town'}`;
  await progress(bar.raise[0], 'raising the town', raising);
  let built = await buildScene(viewOf(zone), layout, materials, assets,
    (fraction) => progress(along(bar.raise, fraction), null, raising));

  const peopling = 'mobiles, their clothes and what they carry';
  await progress(bar.people[0], 'peopling the rooms', peopling);
  let actors = await populate(viewOf(zone), layout, built, { materials, assets },
    (fraction) => progress(along(bar.people, fraction), null, peopling));

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
  // Every draw of the frame goes through here, the console's and the probes'
  // included, so what is culled is decided in one place: see cull.js.
  // `?cull=off` draws everything, for A/B.
  // Far trees as cards, baked from their own models; `?lod=off` keeps every
  // tree whole, for A/B. cull.js decides which copies are which each frame.
  const impostors = assets ? createImpostors({ renderer, library: assets }) : null;
  if (impostors) {
    impostors.adopt(scene);
    impostors.setEnabled(params.get('lod') !== 'off');
  }
  // Out in the open, what the last frames' depth says is behind a hill.
  const occlusion = createOcclusion({ renderer, scene, camera, world: built.group });
  occlusion.state.enabled = params.get('occlusion') !== 'off';
  // Per zone: what each cell sees is measured against that zone's walls.
  const makeVisibility = () => {
    const v = createVisibility({
      renderer, scene, camera, world: built.group, sun, zones: built.zones, impostors, occlusion,
      sky: [sky, stars, ...built.group.children.filter((o) => o.name.startsWith('horizon-'))],
    });
    v.state.enabled = params.get('cull') !== 'off';
    return v;
  };
  let visibility = makeVisibility();
  pipeline.gtao.distant = () => (visibility.state.enabled ? visibility.state.aoFar : null);
  {
    const render = composer.render.bind(composer);
    composer.render = (...args) => {
      visibility.begin();
      try { render(...args); } finally { visibility.end(); }
    };
  }
  const environment = new SkyEnvironment(renderer);
  const rain = createRain(scene);

  // Torches and lamps from the builder, plus one behind every lit window.
  const lightPool = new LightPool(scene, 14, built.lights.concat(actors.lights));
  const quality = new Quality({
    renderer, pipeline, sun, lightPool, materials,
    // `high`, because that is what ships: `createOptions` runs `apply()` at
    // startup and writes `quality.apply(values.preset)` with the stored value or
    // DEFAULTS.preset, which is `high`. This fallback only ever held between
    // here and that call, and it said `medium` -- the preset with `ao: false` --
    // so anyone reading it would conclude ambient occlusion was off by default.
    // It has been on for everyone since the default moved, which is how GTAO
    // came to annihilate the interiors. (The URL parameter is overwritten by the
    // same call, so `?quality=` alone does not stick; the options screen is
    // where the preset is chosen.)
    name: params.get('quality') || 'high',
  });
  if (params.get('fps')) quality.preset.fps = Number(params.get('fps'));
  if (impostors) {
    quality.impostors = impostors;
    impostors.setRange(...quality.preset.trees);
  }

  // --------------------------------------------------------------- player --

  const player = new Player(camera, renderer.domElement, built);
  player.nav = actors.nav;   // so a compass step walks round furniture
  const hud = new Hud(document.body, layout);
  const audio = new Audio();

  const options = createOptions({
    quality, applyTime: (n) => applyTime(n), applyWeather: (w) => applyWeather(w), audio, state,
  });
  await progress(bar.mud[0], 'waking the mud', `resets and mobiles in all ${files.length} areas`);
  // The whole mud, and the zone being drawn (see enterZone in game.js).
  const game = createGame({ world, layout, built, actors, zoneOf: (vnum) => plan.zoneOf(vnum) });
  /**
   * The drawn zone's `built` and `actors` for the modules made once at boot
   * that only ever read them when they act -- the effects, the overlay -- so
   * a crossing does not have to rebuild them. Read through on every access.
   */
  const live = (get) => new Proxy({}, {
    get(_, key) {
      const target = get();
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has: (_, key) => key in get(),
  });
  const liveBuilt = live(() => built);
  const liveActors = live(() => actors);
  const gameUi = createGameUi(game, { built: liveBuilt });
  const fx = createFx({
    scene, camera, composer, actors: liveActors, game, audio, player, library: assets, sun, hemi, built: liveBuilt, lightPool,
  });
  const spellfx = createSpellFx({ scene, camera, renderer, composer, game, actors: liveActors, audio, player, quality, viewModel: fx.viewModel });
  {
    // Screen position of a world point, for the foe plate and damage numbers.
    const p = new THREE.Vector3();
    gameUi.setProjector((x, y, z) => {
      p.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      if (p.z > -0.2) return null;
      p.set(x, y, z).project(camera);
      if (Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) return null;
      return { x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight };
    });
  }
  // Recall and teleport: a room in the drawn zone is a jump, any other a crossing.
  game.onTeleport = (x, y, z, vnum) => {
    if (vnum !== undefined && plan.zoneOf(vnum) && plan.zoneOf(vnum) !== zone) {
      crossTo(vnum, { yaw: camera.rotation.y, why: 'recall' });
      return;
    }
    player.spawn(x, y, z, camera.rotation.y);
  };
  game.setTimeOfDay(state.time);

  // The rest of the mud (src/rules): what lies on the ground, the command
  // line's walking, the save file, and the sounds and the boot of it all.
  const items = createItems({ scene, game, library: assets, built });
  installSave(game, {
    world,
    storage: window.localStorage,
    // The room it was saved in, whichever zone that is: saved in the Mud
    // School, continued in the Mud School.
    onRestore: (vnum) => {
      if (plan.zoneOf(vnum) && plan.zoneOf(vnum) !== zone) {
        crossTo(vnum, { yaw: arrivalYaw(world, plan, vnum, null), why: 'continue' });
        return;
      }
      const info = built.rooms.get(vnum) || built.rooms.get(START_VNUM);
      if (info) player.spawn(info.center.x, info.center.y, info.center.z, camera.rotation.y);
    },
  });
  game.walk = (dir) => step(dir, true);
  gameUi.onConsole = () => player.keys.clear();
  gameUi.setCamera(() => camera.position);
  const kick = createKick({ fx, camera, game, audio });
  game.listen((event) => rulesSound(event));
  // A mobile that says something is seen to say it (motion.js `speak`).
  game.listen((event) => {
    // ...and so does a shopkeeper's reply, which comes as a `say` or a command's `out` with the keeper's slot.
    if (event.slot && event.slot.figure && event.slot.here && (event.kind === 'mobsay' || event.said)) actors.motion.speak(event.slot.figure, event.said || '');
  });
  // A light you hold lights the way: one more candidate for the light pool,
  // moved with you, so it costs a pooled light rather than a new one.
  const heldLight = { x: 0, y: 0, z: 0, color: 0xffa25a, intensity: 5.5, radius: 12, flicker: true, outdoor: false, key: null };
  const heldRight = new THREE.Vector3();
  function updateHeldLight() {
    const light = game.state.equipment[0];
    const lit = light && light.itemType === 1 && light.values[2] !== 0;
    const key = lit ? `${Math.floor(camera.position.x / 16)},${Math.floor(camera.position.z / 16)}` : null;
    if (key !== heldLight.key) {
      if (heldLight.key) {
        const old = lightPool.grid.get(heldLight.key);
        if (old) old.splice(old.indexOf(heldLight), 1);
      }
      if (key) {
        if (!lightPool.grid.has(key)) lightPool.grid.set(key, []);
        lightPool.grid.get(key).push(heldLight);
      }
      heldLight.key = key;
    }
    if (!lit) return;
    // Held low and a little ahead, on the side a torch is carried.
    const right = heldRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    heldLight.x = camera.position.x + right.x * 0.35;
    heldLight.y = camera.position.y - 0.25;
    heldLight.z = camera.position.z + right.z * 0.35;
    // The pool ranks by distance over intensity; ours is at the eye, so it wins a slot.
    heldLight.intensity = /lantern|lamp/.test(light.name) ? 4.2 : 5.5;
  }

  const startZone = zone;
  const startCell = layout.cells.get(START_VNUM) || layout.start;
  const startInfo = built.rooms.get(startCell.vnum);
  // Facing the way out into the open air if there is one: the temple's
  // first exit is north, into the inner hall, and a new player's first frame
  // was a grey room with the gate and the square behind them.
  const flatExits = startCell.room.exits.map((e, i) => (e && i < 4 ? i : -1)).filter((i) => i >= 0);
  const outward = flatExits.find((i) => {
    const to = built.rooms.get(startCell.room.exits[i].to);
    return to && to.outdoor;
  });
  const firstExit = outward ?? (flatExits.length ? flatExits[0] : -1);
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

  function applyTime(name, { quiet = false } = {}) {
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
    // After dark the directional light is the moon, which is *up*: at the
    // sun's own -8 degrees it came from under the world, no up-facing surface
    // got any of it, and an open field -- the graveyard at #3604 -- was 55% of
    // the frame under luma 8. The sky keeps the real sun, below the horizon.
    const moon = preset.moon;
    const lightPosition = moon
      ? new THREE.Vector3().setFromSphericalCoords(1,
        THREE.MathUtils.degToRad(90 - moon[0]), THREE.MathUtils.degToRad(moon[1]))
      : sunPosition;
    sunDirection.copy(lightPosition);
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
    skyRange.setBroad(preset.skyBroad ?? 60);
    sun.position.copy(lightPosition).multiplyScalar(120);
    sun.color.setHex(preset.sun);
    sun.intensity = preset.sunIntensity;
    // Not `preset.sky`: that colour is also the water's mirror, and at noon the
    // hemisphere has a job the water has not -- see the note on TIMES.noon.
    hemi.color.setHex(preset.hemiSky ?? preset.sky);
    hemi.groundColor.setHex(preset.ground);
    hemi.intensity = preset.ambient;
    // ...and how much of it reaches inside a building, which is not a taste
    // dial: it is 1 wherever the hemisphere is a sky floor and less only where
    // it stands in for the sunlit ground.
    materials.setIndoorBounce(preset.hemiIndoor ?? 1);
    materials.setShadeLift(preset.shadeLift ?? 1);
    materials.setSkyBleach(preset.skyBleach ?? 0, preset.skyBleachTint ?? 0xffffff);
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
    // The far slopes that have a colour of their own (sand, grass, red rock)
    // take the hour's light: full at noon's exposure, falling with the sun,
    // and divided by the exposure so a brighter-exposed hour does not lift
    // them. The haze colour tints them the way distance does.
    // What a lit Lambert face would give: the sun on a slope half-turned to
    // it, over pi, plus a little sky -- unlit materials go through the same
    // exposure as everything else, so they have to be given a radiance.
    {
      const up = Math.max(0, Math.sin(THREE.MathUtils.degToRad(preset.elevation + 12)));
      const light = new THREE.Color(preset.sun).lerp(new THREE.Color(preset.haze), 0.35);
      built.horizon?.setHour(light.getHex(),
        (preset.sunIntensity * up * 0.55 + 1.2 * preset.env) / Math.PI);
    }
    renderer.toneMappingExposure = preset.exposure;
    bloom.strength = preset.bloom;
    bloom.threshold = preset.bloomThreshold;
    stars.material.opacity = preset.stars;
    stars.visible = preset.stars > 0;
    shaftTint.setHex(preset.shaftTint);
    state.shaftGain = preset.shafts;
    // Figures are kept out of the shadow map, so their contact shadows are
    // placed by hand and have to be told where the light is coming from.
    // Moonlight casts a shadow too, only a faint one.
    actors.setSun(lightPosition, moon ? moon[0] : preset.elevation, (moon ? 0.35 : 1) * (preset.sunFraction ?? 1));
    // The water mirrors the hour's sky -- preset.sky, not haze: noon's sky is
    // within 4/255 of what the shader always assumed, so clear noon holds
    // still, while overcast pales it and night stops it glowing (the sheet
    // used to keep a daytime blue at night exposure and metered lum 185).
    actors.setSky(preset.sky, preset.sunFraction ?? 1);
    // And the windows have to be told there is daylight outside them, or from
    // inside a room they are black rectangles at head height.
    const daylight = THREE.MathUtils.clamp(preset.elevation / 22, 0, 1) * 0.75;
    actors.setDaylight(preset.haze, daylight);
    fx.setAmbient(daylight / 0.75);
    // Figures out of doors take the indoor fill as the sun goes (dress.js).
    OUTDOOR_FILL.value = 1 - daylight / 0.75;
    spellfx.setDaylight(daylight / 0.75);
    // Whether it is day, for things that are lit *because* it is dark. Fully
    // out above twelve degrees of sun, fully lit below two, so the lamps are a
    // faint glow at golden hour, gone at noon, and the whole light of the town
    // after dark.
    lightPool.setDaylight(THREE.MathUtils.clamp((preset.elevation - 2) / 10, 0, 1));
    // The panes on the modelled buildings are one material for the whole town,
    // so they cannot be lit house by house. They still light: sky by day, and
    // after dark the hearth behind them, or no window in Midgaard is ever on.
    // Lamps are lit by golden hour, so the rooms behind the model glass go
    // from daylit to lamplit over the same span the street lamps do; at dusk
    // the old switch at 0.05 left every pane a dark, unlit room.
    const paneDay = THREE.MathUtils.smoothstep(daylight, 0.2, 0.6);
    setPaneDaylight(paneDay);
    if (assets) {
      assets.setWindowLight(new THREE.Color(0xff9c46).lerp(new THREE.Color(preset.haze), paneDay).getHex(),
        0.85 * (1 - paneDay) + daylight * 1.6 * paneDay);
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
    if (!quiet) hud.toast(state.weather === 'clear' ? `${name}` : `${name} · ${state.weather}`);
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
  // Mobiles walk about, so they are looked up live rather than filed by where
  // they stood at boot.
  let walkers = [];
  /** The drawn zone's things to look at, filed by where they stand. */
  function fileInteractables() {
    interactGrid.clear();
    walkers = actors.interactables.filter((item) => item.figure);
    for (const item of actors.interactables) {
      if (item.figure) continue;
      const key = `${Math.floor(item.position.x / 16)},${Math.floor(item.position.z / 16)}`;
      if (!interactGrid.has(key)) interactGrid.set(key, []);
      interactGrid.get(key).push(item);
    }
  }
  fileInteractables();
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
        for (const item of bucket) consider(item);
      }
    }
    for (const item of walkers) {
      if (!item.figure.object.visible || item.figure.m.dead) continue;
      if (Math.abs(item.position.x - camera.position.x) > 7 || Math.abs(item.position.z - camera.position.z) > 7) continue;
      consider(item);
    }
    // Something on the ground right under your eye wins over the wall behind it.
    const lying = items.lookable(camera);
    if (lying) return groundTarget(lying);
    if (best && best.reset) {
      // Scenery the reset table put there (a fountain, a desk): the game's object.
      const obj = game.ground.find((o) => o.inRoom === best.reset.room && o.vnum === best.reset.vnum
        && o.resetIndex === best.reset.index);
      if (obj) return { ...best, obj, action: verbFor(obj) };
    }
    return best;

    function consider(item) {
      toTarget.copy(item.position).sub(camera.position);
      const distance = toTarget.length();
      if (distance > 7) return;
      toTarget.divideScalar(distance);
      const facing = toTarget.dot(forward);
      if (facing < 0.72) return;
      const score = facing * 2 - distance * 0.12;
      if (score > bestScore) { bestScore = score; best = item; }
    }
  }

  /** The one thing E does to an object, named the mud's way. */
  function verbFor(obj) {
    if (obj.itemType === 25) return 'E — drink';
    if (game.isContainer(obj)) return obj.itemType === 23 ? 'E — search the body' : 'E — look inside';
    if (obj.wearFlags & 1) return 'E — get';
    return 'E — examine';
  }

  function groundTarget(obj) {
    const inside = obj.contains && obj.contains.length;
    return {
      kind: 'ground', obj, title: obj.name,
      subtitle: obj.itemType === 23 ? (inside ? `${inside} thing${inside === 1 ? '' : 's'} on it` : 'nothing left on it')
        : (obj.itemType === 20 ? '' : ''),
      action: verbFor(obj),
      position: new THREE.Vector3(obj.at.x, obj.at.y, obj.at.z),
    };
  }

  /** E on an object: drink at a fountain, search a body or a chest, pick a thing up. */
  function useObject(obj, fallback) {
    const say = (r) => { if (r && !r.ok && r.text) gameUi.log(r.text, 'faint'); };
    if (obj.itemType === 25) return say(game.drink(obj));
    if (game.isContainer(obj)) return gameUi.openLoot(obj);
    if (obj.wearFlags & 1) return say(game.take(obj, null));
    if (fallback) hud.showExamine(fallback);
  }

  /** The mud's sounds for the mud's verbs, placed where they happened. */
  function rulesSound(event) {
    const place = (p) => {
      if (!p) return { pan: 0, gain: 1 };
      const dx = p.x - camera.position.x;
      const dz = p.z - camera.position.z;
      const d = Math.hypot(dx, dz);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      return { pan: d > 0.8 ? Math.max(-1, Math.min(1, (dx * right.x + dz * right.z) / d)) * 0.7 : 0, gain: Math.max(0.1, 1 / (1 + Math.max(0, d - 1) / 6)) };
    };
    switch (event.kind) {
      case 'door-sound':
        if (event.sound === 'open' || event.sound === 'close') audio.door(event.sound === 'open', place(event));
        else audio.lock(place(event));
        break;
      case 'eat': audio.eat(); break;
      case 'drink': audio.drink(); break;
      case 'fill': audio.drink({ fill: true }); break;
      case 'gold': audio.coins(); break;
      case 'pickup': audio.pickup(); break;
      case 'drop': audio.drop(event.gold); break;
      case 'put': case 'give': case 'container': audio.pickup(); break;
      case 'pick': audio.lock({ pick: true, failed: !event.ok }); break;
      case 'sacrifice': audio.coins({ one: true }); break;
      default: break;
    }
  }

  let lookTarget = null;
  let fadeTimer = 0;
  let titleReel = null;   // title.js, from the end of boot until the game begins

  document.addEventListener('keydown', (event) => {
    // The title's camera is not the player's: an arrow here would start a
    // walk from wherever the reel happens to be.
    if (titleReel && titleReel.active) return;
    // The same key closes it. Escape works too, but Escape is the browser's own
    // pointer-lock release, so relying on it costs you the mouse as well.
    if (event.code === 'KeyE' && hud.examineOpen) {
      hud.hideExamine();
      return;
    }
    if (event.code === 'KeyE' && gameUi.sheet === 'loot') {
      gameUi.close();
      return;
    }
    if (event.code === 'KeyE' && lookTarget) {
      if (lookTarget.kind === 'door') {
        // The mud's doors: open, close, and a lock that wants its key.
        game.useDoor(lookTarget.door.spec.room, lookTarget.door.spec.dir);
      } else if (lookTarget.obj) {
        useObject(lookTarget.obj, lookTarget.kind === 'ground' ? null : lookTarget);
      } else {
        hud.showExamine(lookTarget);
      }
    }
    if (event.code === 'Escape') hud.hideExamine();
    if (event.code === 'Tab' && !(event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName))) {
      event.preventDefault();
      hud.toggleProse();
    }
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
    if (event.code === 'KeyF') { state.showStats = !state.showStats; hud.setDebug(state.showStats); }
    if (event.code === 'KeyP') {
      const names = Object.keys(PRESETS);
      const next = names[(names.indexOf(quality.name) + 1) % names.length];
      quality.apply(next);
      hud.toast(`${next} · ${quality.preset.fps || 'uncapped'} fps`);
    }
    if (event.code === 'KeyV') { player.noclip = !player.noclip; hud.toast(player.noclip ? 'noclip on' : 'noclip off'); }
    if (event.code === 'KeyM') hud.toast(audio.toggleMute() ? 'sound off' : 'sound on');
    if (event.code === 'KeyG') {
      game.forceLocks();
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

  function step(dir, typed = false) {
    // Typed at the command line, a refusal is the mud's line in the console;
    // from the arrow keys it is a toast over the world.
    const refuse = (toast, mud) => { if (typed) return { ok: false, text: mud }; hud.toast(toast); return null; };
    if (player.gliding) { queuedStep = dir; return null; }
    if (fadeTimer > 0 || crossing) return null;
    const here = currentRoom();
    const room = here && world.rooms.get(here);
    if (!room) return null;
    const exit = room.exits[dir];
    const name = DIR_NAME[dir];
    if (!exit) return refuse(`no exit ${name}`, 'Alas, you cannot go that way.');
    // Worth naming the room number. "Outside the loaded world" sounds like a
    // dead end and is not one: the exit is real in the mud and leads into an
    // area file this session did not load, so the vnum is exactly what you need
    // to find it -- The Dump's south is #3504 in midennir.are. Load it with
    // ?areas=midgaard,midennir and the exit works.
    if (exit.offMap) return refuse(`${name}: #${exit.to} is in an area not loaded`, `That way (#${exit.to}) lies in an area this world did not load.`);
    // Into another zone: a crossing. The mud's refusals first -- a shut door,
    // and act_move.c's "No way!" to anyone fighting, which would otherwise be
    // a free way out of every fight.
    const beyond = plan.zoneOf(exit.to);
    if (beyond && beyond !== zone) {
      if (exit.locks & EX_CLOSED) {
        const word = (exit.keyword || 'door').split(/\s+/)[0] || 'door';
        return refuse(`the ${word} is closed`, `The ${word} is closed.`);
      }
      if (game.state.fighting) return refuse('you are fighting', 'No way!  You are still fighting!');
      // move_char's rule for the sky, and build.js does not build sky rooms
      // at all: flying or not, there is nothing up there to stand in yet.
      if (world.rooms.get(exit.to).sector === SECTOR.AIR) {
        return (game.state.affectedBy & AFF.FLYING)
          ? refuse(`${name}: nothing built that way`, 'Alas, you cannot go that way.')
          : refuse("you can't fly", "You can't fly.");
      }
      crossTo(exit.to, { from: room.vnum, dir });
      return { ok: true };
    }
    const target = built.rooms.get(exit.to);
    if (!target || target.unbuilt) return refuse(`${name}: nothing built that way`, 'Alas, you cannot go that way.');
    // A door in the way behaves as it looks: what you see shut, you cannot walk
    // through. `door.open` is the live hinge, not the .are file's opinion.
    const door = actors.doors.find((d) => d.spec.room === room.vnum && d.spec.dir === dir && !d.spec.oneWay);
    if (door && !door.open) {
      const word = door.spec.keyword.split(/\s+/)[0] || 'door';
      return refuse(door.spec.locked ? `the ${word} is locked` : `the ${word} is closed`, `The ${word} is closed.`);
    }
    // An ordinary next-room exit is walked, not cut to: the target sits where
    // the compass says it should, near ground level, within a couple of cells.
    // Anything else -- a portal, a stair, a layout that had to bend -- keeps
    // the fade, because gliding through a wall would say something false.
    const hereInfo = built.rooms.get(room.vnum);
    // A way up or down with a ladder or a shaft of its own (build.js
    // `fixture`): walk to its foot, and it carries you on.
    const shaft = dir >= 4 && hereInfo && built.portals.find((p) => p.from === room.vnum && p.target === exit.to);
    const toShaft = shaft && actors.nav.pathInRoom(room.vnum, player.position, { x: shaft.x, z: shaft.z }, 1);
    if (toShaft && toShaft.length) {
      player.glidePath(toShaft, null, () => {
        const queued = queuedStep;
        queuedStep = null;
        if (queued !== null) step(queued);
      });
      return { ok: true };
    }
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
      // An archway: walk to it and through, and the portal does the rest.
      // The far end of a two-way archway has its own arch now (layout.js
      // `backSide`), so this is never a glide through a solid wall.
      const arch = !layout.links.some((l) => l.kind === 'alley' && l.to
        && ((l.from.vnum === room.vnum && l.to.vnum === exit.to) || (l.to.vnum === room.vnum && l.from.vnum === exit.to)))
        && built.portals.find((p) => p.from === room.vnum && p.target === exit.to);
      const toArch = arch && actors.nav.pathInRoom(room.vnum, player.position, { x: arch.x, z: arch.z }, 1);
      if (toArch && toArch.length) {
        player.glidePath(toArch, null, onArrive);
        return { ok: true };
      }
      if (Math.abs(oy) < 3.2 && flat > 6 && flat < 46 && along > 0.82 * flat) {
        player.glide(target.center.x, target.center.y, target.center.z, DIR_YAW[dir], onArrive);
        return { ok: true };
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
      // Any length: Wall Road is nineteen cells from the East Gate to the
      // neighborhood, and a step south from #3041 used to cut to black
      // because of it -- the only route in the nine areas over six cells.
      if (link) {
        const cells = link.from.vnum === room.vnum ? link.path : [...link.path].reverse();
        const points = cells.map((c) => ({ x: c.x * CELL, y: target.center.y, z: c.z * CELL }));
        points.push(target.center);
        player.glidePath(points, null, onArrive);
        return { ok: true };
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
    return { ok: true };
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

  // ---------------------------------------------------------------- zones --

  const zoneCard = createZoneCard();
  let crossing = null;
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  /** The light pool's candidates from the drawn zone, filed as LightPool files them. */
  function fileLights() {
    lightPool.grid = new Map();
    for (const candidate of built.lights.concat(actors.lights)) {
      const key = `${Math.floor(candidate.x / 16)},${Math.floor(candidate.z / 16)}`;
      if (!lightPool.grid.has(key)) lightPool.grid.set(key, []);
      lightPool.grid.get(key).push(candidate);
    }
    heldLight.key = null;
  }

  /**
   * Take the drawn zone apart: its measurements, its tree cards, its scene
   * graph and everything on the GPU only it was using (teardown.js). The
   * baked surfaces, the model library and the impostor atlases stay -- they
   * are what makes the way back fast.
   */
  function unmountZone() {
    visibility.dispose();
    impostors?.release();
    occlusion.setWorld(null);
    spellfx.releaseZone();
    // The AO prepass's lists of what to hide from it are the old zone's
    // meshes until it next looks: forget them and have it look again.
    pipeline.gtao.foliage.length = 0;
    pipeline.gtao.unshaded.length = 0;
    pipeline.gtao.unshadedAge = Infinity;
    const keep = collectResources([materials, assets, impostors ? impostors.models : null]);
    const freed = disposeZoneGraph([built.group, actors.group], keep, (m) => !!impostors && impostors.owns(m));
    lightPool.grid = new Map();
    heldLight.key = null;
    lookTarget = null;
    hud.hideExamine();
    if (gameUi.sheet) gameUi.close();
    return freed;
  }

  /** Hang the zone just built in the scene and point everything at it. */
  function mountZone() {
    scene.add(built.group);
    scene.add(actors.group);
    occlusion.setWorld(built.group);
    if (impostors) impostors.adopt(scene);
    visibility = makeVisibility();
    fileLights();
    player.setWorld(built);
    player.nav = actors.nav;
    hud.setLayout(layout);
    gameUi.setBuilt(liveBuilt);
    items.setBuilt(built);
    game.enterZone({ layout, built, actors });
    fileInteractables();
    // The hour's light on this zone's mist, horizon and figures.
    applyTime(state.time, { quiet: true });
    state.worldStats = describeWorld();
  }

  /**
   * Stand in `vnum` as a jump rather than a walk. Come in through a wall
   * (`dir` the way you were going), you stand just inside the doorway you
   * came through, facing into the room -- at the middle of a small room,
   * facing on, the frame was the far wall. Out of doors, up or down, the
   * middle of the room facing `yaw`.
   */
  function arriveAt(vnum, yaw, dir = null) {
    const info = built.rooms.get(vnum);
    if (!info || info.unbuilt) throw new Error(`#${vnum} was not built in zone ${zone.id}`);
    let at = info.center;
    if (dir !== null && dir < 4 && !info.outdoor) {
      const back = world.rooms.get(vnum).exits[REVERSE_DIR[dir]];
      const sides = layout.sides.get(vnum) || [];
      const side = back ? sides.findIndex((entry) => entry && entry.exit === back) : -1;
      if (side >= 0) {
        const x = info.center.x + DIR_STEP[side][0] * 3;
        const z = info.center.z + DIR_STEP[side][2] * 3;
        if (actors.nav.sample(x, z, info.cell.level)) {
          at = { x, y: info.center.y, z };
          yaw = Math.atan2(DIR_STEP[side][0], DIR_STEP[side][2]);
        }
      }
    }
    // A room's middle can be inside something build.js stood there ("Inside
    // the Chapel": the timber round its stair), and the body is then shoved
    // out of it on the first frame -- facing a plank 0.4 m off.
    const nav = actors.nav;
    if (!nav.sample(at.x, at.z, info.cell.level)) {
      const open = nav.nearestOpen(info.cell.level, at.x, at.z, 8);
      if (open) at = { x: (open[0] + 0.5) * nav.NAV_RES, y: at.y, z: (open[1] + 0.5) * nav.NAV_RES };
    }
    yaw = openView(at, yaw, vnum);
    player.spawn(at.x, at.y, at.z, yaw);
    camera.rotation.set(0, yaw, 0);
    state.roomVnum = null;
    game.state.roomVnum = vnum;
    built.horizon?.settle(camera.position);
    shadowAnchor.set(Infinity, Infinity, Infinity);
  }

  /**
   * `yaw`, unless the first thing in front of the eye is a wall or a pillar
   * within a few metres -- "Inside the Chapel" faced on into the back of its
   * own stair -- when it is the first of the room's level ways out, and then
   * the eight points of the compass, that has room in front of it; failing
   * all of those, whichever sees furthest.
   */
  const viewRay = new THREE.Raycaster();
  function openView(at, yaw, vnum) {
    const room = world.rooms.get(vnum);
    const tries = [yaw,
      ...[0, 1, 2, 3].filter((d) => room.exits[d]).map((d) => Math.atan2(-DIR_STEP[d][0], -DIR_STEP[d][2])),
      ...Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4)];
    const eye = new THREE.Vector3(at.x, at.y + 1.72, at.z);
    let best = yaw;
    let furthest = -1;
    for (const t of tries) {
      viewRay.set(eye, new THREE.Vector3(-Math.sin(t), 0, -Math.cos(t)));
      viewRay.far = 30;
      const hit = viewRay.intersectObject(built.group, true)[0];
      const clear = hit ? hit.distance : 30;
      if (clear >= 4) return t;
      if (clear > furthest) { furthest = clear; best = t; }
    }
    return best;
  }

  /**
   * Cross into the zone `vnum` is in: the card goes up, this zone is taken
   * down, that one is built (its layout is cached -- the same files give the
   * same coordinates), the hour's light is put on it, its programs are
   * compiled, and you are stood in the arrival room facing on the way you
   * came -- or, up and down having no heading, out of the room. The rules
   * engine is not touched beyond telling it which zone is drawn: the mud ran
   * the whole time, and your hit points, gear and affects are its, not the
   * scene's.
   */
  async function crossTo(vnum, { from = null, dir = null, yaw = null, why = 'exit' } = {}) {
    const target = plan.zoneOf(vnum);
    if (!target) throw new Error(`crossTo: #${vnum} is in no zone`);
    // Refused before anything is taken down: build.js does not build the sky.
    if (world.rooms.get(vnum).sector === SECTOR.AIR) throw new Error(`crossTo: #${vnum} is in the air, and nothing is built there`);
    // One at a time: a recall typed while the last card is still lifting
    // goes once that one has finished, rather than being lost.
    if (crossing) return crossing.then(() => crossTo(vnum, { from, dir, yaw, why }));
    crossing = (async () => {
      const t0 = performance.now();
      // The title's camera is not the player's; the reel ends here at the latest.
      if (titleReel && titleReel.active) { titleReel.stop(); document.body.classList.remove('titling'); }
      const timing = { from: zone.id, to: target.id, vnum };
      state.crossing = true;
      queuedStep = null;
      player.keys.clear();
      player.velocity.set(0, 0, 0);
      const arrive = world.rooms.get(vnum);
      const area = world.areas.find((a) => a.file === arrive.areaFile);
      const leaving = from !== null ? world.rooms.get(from) : null;
      await zoneCard.show({
        name: area.name,
        levels: levelsOf(area.credits),
        way: leaving && dir !== null ? `${DIR_NAME[dir]} · from ${leaving.name}`
          : ({ recall: 'you pray for transportation', continue: 'where you left off' })[why] || '',
        room: arrive.name,
        prose: firstLine(arrive.description),
      });
      timing.fadeIn = performance.now() - t0;
      try {
        let t = performance.now();
        timing.freed = unmountZone();
        timing.teardown = performance.now() - t;
        await zoneCard.progress(CROSS_BAR.teardown);
        zone = target;
        t = performance.now();
        layout = layoutOf(zone);
        timing.layout = performance.now() - t;
        await zoneCard.progress(CROSS_BAR.build[0]);
        t = performance.now();
        built = await buildScene(viewOf(zone), layout, materials, assets,
          (fraction) => zoneCard.progress(along(CROSS_BAR.build, fraction)));
        timing.build = performance.now() - t;
        await zoneCard.progress(CROSS_BAR.populate[0]);
        t = performance.now();
        actors = await populate(viewOf(zone), layout, built, { materials, assets },
          (fraction) => zoneCard.progress(along(CROSS_BAR.populate, fraction)));
        timing.populate = performance.now() - t;
        await zoneCard.progress(CROSS_BAR.compile[0]);
        t = performance.now();
        mountZone();
        arriveAt(vnum, yaw ?? arrivalYaw(world, plan, vnum, dir), dir);
        timing.mount = performance.now() - t;
        t = performance.now();
        await precompile((fraction) => zoneCard.progress(along(CROSS_BAR.compile, fraction)));
        timing.compile = performance.now() - t;
        await zoneCard.progress(1);
      } catch (error) {
        zoneCard.fail(String(error.message || error));
        throw error;
      }
      state.crossing = false;
      // A couple of frames behind the card, so the first one seen has its
      // shadows and the cells round the eye measured.
      await nextFrame();
      await nextFrame();
      timing.ready = performance.now() - t0;
      await zoneCard.hide();
      timing.total = performance.now() - t0;
      state.lastCrossing = timing;
      console.info(`crossed ${timing.from} -> ${timing.to} (#${vnum}): ready in ${timing.ready.toFixed(0)} ms`
        + ` (teardown ${timing.teardown.toFixed(0)}, build ${timing.build.toFixed(0)}, populate ${timing.populate.toFixed(0)},`
        + ` mount ${timing.mount.toFixed(0)}, compile ${timing.compile.toFixed(0)})`);
      return timing;
    })();
    try { return await crossing; } finally { crossing = null; }
  }

  /**
   * Walking into a crossing's archway takes it, as walking into a portal
   * does: under its sign, facing out and pressing on. The arrow keys and the
   * command line take it from anywhere in the room.
   */
  // Seconds pressed into an archway; below zero, the pause after one try,
  // so a refusal (a shut gate, a fight) is said once and not every frame.
  let pressing = 0;
  function walkIntoCrossing(dt) {
    if (pressing < 0) { pressing = Math.min(0, pressing + dt); return; }
    const room = state.roomVnum !== null ? world.rooms.get(state.roomVnum) : null;
    const info = room && built.rooms.get(room.vnum);
    if (!info || !player.keys.has('KeyW')) { pressing = 0; return; }
    const fx = -Math.sin(camera.rotation.y);
    const fz = -Math.cos(camera.rotation.y);
    for (let dir = 0; dir < 4; dir++) {
      const exit = room.exits[dir];
      const beyond = exit && !exit.offMap ? plan.zoneOf(exit.to) : null;
      if (!beyond || beyond === zone) continue;
      const sign = built.decor.find((d) => d.kind === 'gateSign' && d.text === DIR_NAME[dir]
        && Math.hypot(d.x - info.center.x, d.z - info.center.z) < 9);
      if (!sign || Math.hypot(player.position.x - sign.x, player.position.z - sign.z) > 1.5) continue;
      if (fx * sign.dx + fz * sign.dz < 0.6) continue;
      pressing += dt;
      if (pressing > 0.25) { pressing = -1.5; step(dir); }
      return;
    }
    pressing = 0;
  }

  /** What the build came to, for the stats overlay (F). */
  function describeWorld() {
    return `${zone.id} · ${layout.stats.placed} rooms · ${layout.stats.alleys + layout.stats.stairs} passages · `
      + `${layout.stats.portals} archways · ${(built.stats.triangles / 1e6).toFixed(2)}M tris built`;
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
  });
  player.controls.addEventListener('unlock', () => {
    state.paused = true;
    dom.hint.classList.add('visible');
  });

  // The saved character back, from the title screen (the class question
  // itself is game-ui.js's #class-pick). Continuing replaces whatever was picked.
  const continueButton = document.getElementById('continue');
  let saved = null;
  try { saved = game.savedCharacter(); } catch (error) { console.error(error); }
  if (saved) {
    continueButton.hidden = false;
    continueButton.textContent = `continue — ${saved.className}, level ${saved.level}`;
  }
  let begun = false;
  /**
   * Out of the title and into the game, whether or not the mouse can be had.
   * Starting used to wait for the pointer-lock event, so a browser that never
   * grants it -- headless Chrome, which is how the judge drives this -- never
   * got past the title. Now the game starts on the click and asks for the
   * mouse alongside; without it the keys still walk, step and fight, and the
   * next click on the view asks again.
   */
  const begin = (fromSave) => {
    if (!begun) {
      begun = true;
      if (titleReel) titleReel.stop();
      document.body.classList.remove('titling');
      // Unless something has crossed into another zone already (a harness's
      // goto): then where the start room stood is somewhere else's floor.
      if (zone === startZone) player.spawn(startInfo.center.x, startInfo.center.y, startInfo.center.z, yaw);
      state.roomVnum = null;
      built.horizon?.settle(camera.position);
      if (fromSave) game.loadSave();
    }
    audio.start();
    dom.title.classList.add('hidden');
    state.paused = false;
    player.requestLock();
  };
  continueButton.addEventListener('click', () => begin(true));
  dom.enter.addEventListener('click', () => begin(false));

  // Or a server's world (src/link.js): this game becomes the server's copy,
  // and these are the hands it borrows from the page to move you about.
  let connected = null;
  const linkHost = {
    zoneId: () => zone.id,
    actors: () => actors,
    scene, library: assets, world,
    eye: () => player.position,
    yaw: () => camera.rotation.y,
    crossing: () => !!state.crossing,
    roomAt: (x, y, z) => built.rooms.get(actors.nav.roomAt(x, y, z)),
    /** Where the server put you: a jump in the drawn zone, a crossing to another. */
    teleport(vnum) {
      if (plan.zoneOf(vnum) && plan.zoneOf(vnum) !== zone) { crossTo(vnum, { yaw: camera.rotation.y, why: 'recall' }); return; }
      const info = built.rooms.get(vnum);
      if (!info) throw new Error(`link: the server put you in #${vnum}, which this zone did not build`);
      player.spawn(info.center.x, info.center.y, info.center.z, camera.rotation.y);
    },
    /** Put back where the server has you ({ zone, x, y, z, room }: y is the floor). */
    place({ zone: zoneId, x, y, z, room }) {
      if (zoneId !== zone.id || x === null) { linkHost.teleport(room); return; }
      player.spawn(x, y, z, camera.rotation.y);
    },
    walk: (dir) => step(dir, true),
    /** The link is gone. `resume` ({ url, name, token }) when the body can be taken up again. */
    disconnected(why, resume = null) {
      lostResume = resume;
      document.getElementById('link-lost-text').textContent = resume
        ? `${why}  Your body stands where you left it for a few minutes.`
        : `${why}  The world stays as it was; reload to play again.`;
      document.getElementById('link-lost-reconnect').hidden = !resume;
      document.getElementById('link-lost').hidden = false;
    },
  };
  let lostResume = null;
  document.getElementById('link-lost-reload').addEventListener('click', () => window.location.reload());
  // comm.c's check_reconnect, without a reload: a new socket, the same body.
  document.getElementById('link-lost-reconnect').addEventListener('click', async () => {
    const resume = lostResume;
    if (!resume) return;
    const text = document.getElementById('link-lost-text');
    text.textContent = `Reconnecting to ${resume.url} ...`;
    try {
      const next = new SocketLink(resume.url);
      await next.open();
      const reply = await next.resume(resume.name, resume.token);
      if (!reply.ok) { next.close(); throw new Error(reply.why); }
      if (connected) connected.close();
      connected = attachSocketLink(next, game, linkHost, reply.enter);
      window.diku.link = connected;
      lostResume = null;
      document.getElementById('link-lost').hidden = true;
    } catch (error) {
      text.textContent = `${error.message}  Reload to log in again.`;
      document.getElementById('link-lost-reconnect').hidden = true;
    }
  });
  createConnectUi({
    game,
    onAlone: () => begin(false),
    onEnter(link, enter) {
      begin(false);
      connected = attachSocketLink(link, game, linkHost, enter);
      window.diku.link = connected;
    },
  });
  dom.hint.addEventListener('click', () => player.requestLock());
  renderer.domElement.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || state.paused || state.crossing) return;
    // A click that is only taking the mouse back is not a swing -- unless
    // the mouse cannot be had at all, when a click is all there is.
    if (!document.pointerLockElement && begun && !options.open && !gameUi.sheet) {
      const refused = player.lockRefused;
      player.requestLock();
      if (!refused) return;
    }
    game.attack();
  });

  // ----------------------------------------------------------- frame loop --

  let last = performance.now();
  let elapsed = 0;
  let fps = 60;

  function frame() {
    if (state.benchmark) { requestAnimationFrame(frame); return; } // measuring: nobody else draws
    // Between two zones there is no world to draw or walk: the card is up.
    if (state.crossing) { last = performance.now(); requestAnimationFrame(frame); return; }
    const now = performance.now();
    // Nothing here needs to run faster than the frame cap, and when the mouse
    // is released or the tab is in the background it barely needs to run at all.
    // Whoever takes the title card down some other way -- the judge's harness
    // hides it and unpauses by hand -- ends the reel too, or it would keep
    // dragging the camera away from every goto().
    if (titleReel && titleReel.active && (!state.paused || dom.title.classList.contains('hidden'))) {
      titleReel.stop();
      document.body.classList.remove('titling');
    }
    const reeling = !!(titleReel && titleReel.active);
    // The title reel is for someone looking at it: left up in a window behind
    // other work, it drops to the same crawl as a released mouse.
    const idle = reeling ? !document.hasFocus() : state.paused;
    if (!quality.shouldRender(now, idle)) { requestAnimationFrame(frame); return; }
    // Idle, the next frame is a tenth of a second off. Asking for every vsync
    // in between only to decline it kept the page and the compositor awake at
    // the display's rate -- 120 times a second on a ProMotion screen -- so the
    // loop sleeps until just short of it instead.
    if (idle) setTimeout(() => requestAnimationFrame(frame), IDLE_SLEEP_MS);
    else requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    elapsed += dt;
    fps += ((1 / Math.max(dt, 0.0001)) - fps) * 0.08;

    if (!state.paused) player.update(dt);
    if (reeling) titleReel.update(dt);
    camera.updateMatrixWorld();
    if (!state.paused) game.update(dt, player.position, camera.getWorldDirection(forward));
    // Connected, the others and the sending go on with the mouse let go too.
    if (connected) connected.update(dt);
    gameUi.update();
    items.update();
    updateHeldLight();
    if (!state.paused) game.autosave(dt);

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
      // The override comes first, or the barometer would write over it every
      // frame -- which is exactly how a reviewer concluded rain did nothing.
      const level = state.forcedRain ?? (sky === SKY.LIGHTNING ? 1 : sky === SKY.RAINING ? 0.65 : 0);
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
      audio.setPlace(info, state.time);
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
    built.horizon?.update(camera.position, dt);
    built.thresholds?.shimmer(elapsed, renderer.toneMappingExposure);
    actors.update(dt, elapsed, camera);
    fx.update(dt);
    if (reeling) fx.viewModel.scene.visible = false; // no fists in the title's reel
    spellfx.update(state.paused ? 0 : dt);
    kick.update(dt);
    audio.update(built.rooms.get(state.roomVnum)?.room.sector === 1, state.time);

    if (!state.paused) {
      lookTarget = findLookTarget();
      game.focus(lookTarget && lookTarget.figure ? lookTarget.figure : null);
      hud.setLook(lookTarget);
      for (const portal of built.portals) {
        if (fadeTimer > 0) break;
        const dx = portal.x - player.position.x;
        const dz = portal.z - player.position.z;
        const dy = portal.y - (player.position.y - 1.72);
        if (Math.abs(dy) > 3) continue;
        if (dx * dx + dz * dz < portal.radius * portal.radius) { teleport(portal); break; }
      }
      if (!player.gliding && fadeTimer <= 0) walkIntoCrossing(dt);
    }
    if (fadeTimer > 0) fadeTimer -= dt;

    options.update(dt);
    hud.update(dt, camera, state.roomVnum);
    if (state.showStats) {
      const info = renderer.info.render;
      hud.setStats(`${fps.toFixed(0)} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris`
        + ` · ${quality.describe()} · ${state.time}${state.worldStats ? ` · ${state.worldStats}` : ''}`);
    } else {
      hud.setStats('');
    }

    renderer.info.reset();
    quality.begin(now);
    composer.render();
    quality.end();
    // Measuring the next cells is no part of this frame: it runs in a task of
    // its own straight after, so the frame goes to the screen first.
    afterFrame.port2.postMessage(0);
  }
  const afterFrame = new MessageChannel();
  afterFrame.port1.onmessage = () => visibility.work();

  // Handy from the console, and how the screenshots for this were framed.
  window.diku = {
    scene, camera, renderer, composer, bloom, sun, hemi, lightPool, quality, game, gameUi, options, fx, spellfx,
    // `wetness` is exposed because it is a slow-moving number nothing on screen
    // reports: reading .value against .target() is how you tell a street that is
    // drying from one that has dried.
    pipeline, environment, materials, wetness, assets, impostors, occlusion,
    /** What the texture bake did: bakes, cache hits, ms, workers; `stored` resolves to the cache's bytes. */
    bake: bakeStats,
    player, hud, world, applyTime, applyWeather, state, audio,
    // The drawn zone's, so read through: a crossing replaces all four.
    get layout() { return layout; },
    get built() { return built; },
    get actors() { return actors; },
    get visibility() { return visibility; },
    /** The zone being drawn, and every zone there is (zones.js). */
    get zone() { return zone; },
    plan,
    /** Cross into the zone room `vnum` is in, as a crossing does; resolves with its timings. */
    cross: (vnum, options) => crossTo(vnum, options),
    zoneCard,
    times: TIMES, overcast: OVERCAST, rain,
    /**
     * Make it rain now, whatever the mud's barometer says.
     *
     * Rain is not a switch anywhere else in the program, and deliberately so:
     * it falls out of `game.weather()` under `auto`, which means it arrives
     * when it arrives. That is right for playing and useless for looking, and
     * the two ways of forcing it by hand both fail silently. Setting
     * `state.rainLevel` is overwritten by the barometer on the very next frame.
     * Driving `wetness` directly is overwritten by `wetness.update`. A reviewer
     * did both, measured no change, and reported rain as broken.
     *
     * So this owns all four things rain actually is: the level the frame loop
     * reads, the sound, the deck overhead, and the wet ground. The easing is
     * skipped -- 11 seconds to 63% is honest weather and no use to anyone
     * taking a screenshot, so the streets arrive already wet.
     *
     * `forceRain(0)` hands the sky back to the barometer; it does not put the
     * weather back, because it does not know what you set it to. Follow it with
     * `applyWeather('clear')` if that is what you want.
     */
    forceRain(level = 0.65) {
      state.forcedRain = level > 0 ? Math.min(1, level) : null;
      if (state.forcedRain !== null && state.weather !== 'overcast') applyWeather('overcast');
      state.rainLevel = state.forcedRain ?? 0;
      audio.setRain(state.rainLevel);
      wetness.value = wetness.target();
      wetness.push();
      return {
        rainLevel: state.rainLevel, weather: state.weather,
        wetness: wetness.value, forced: state.forcedRain !== null,
      };
    },

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
          && r.exits.some((e, i) => e && i < 4 && (e.offMap || plan.zoneOf(e.to) !== zone)),
        (r) => (/gate/i.test(r.name) ? 3 : 0) + ways(r) + stuff(r)),
        'a gate out of the zone: a crossing into another');
      add('crowd', pick((r) => r.mobs.length >= 2), 'several mobiles together');
      // Under the town. The works are the sewer's brick-vaulted pipe rooms on
      // the first level down; the more ways out, the more tunnel mouths there
      // are to look down, and a room the mud says is lit has its own light.
      const sewer = (r) => r.areaFile === 'sewer.are';
      const level = (r) => built.rooms.get(r.vnum).cell.level;
      add('sewer', pick((r) => sewer(r) && level(r) === -1 && /\b(junction|sewer|pipe)\b/i.test(r.name),
        (r) => ways(r) * 2 + (/\b(torch|lit|light)/i.test(r.description) ? 4 : 0) + stuff(r)),
        'the sewer: brick vaults, tunnel mouths, a channel of standing sewage');
      // Where the street goes down into it: the room above a stair whose foot
      // is in the sewer, which is where the two worlds share a frame.
      // A stair, not a well: the room below has to be directly underneath,
      // so the frame has the parapet and the shaft in it.
      const below = (r, e) => {
        const a = built.rooms.get(r.vnum)?.cell; const b = built.rooms.get(e.to)?.cell;
        return !!a && !!b && b.level < a.level && a.x === b.x && a.z === b.z;
      };
      add('manhole', pick((r) => !sewer(r) && r.exits.some((e) => e && !e.offMap
          && built.rooms.has(e.to) && sewer(world.rooms.get(e.to)) && below(r, e)),
        (r) => (built.rooms.get(r.vnum).outdoor ? 3 : 0) + ways(r)),
        'a way down from the street into the sewer: parapet, shaft, daylight falling in');
      // The desert: sand to the horizon, dunes, the cliffs the river comes out
      // of; and the oasis in it, palms over water and the nomads' tents.
      add('desert', pick((r) => r.areaFile === 'eastern.are' && r.sector === 10,
        (r) => ways(r) + stuff(r)), 'open desert: dunes, sandstone cliffs, a cave mouth');
      add('oasis', pick((r) => r.areaFile === 'eastern.are' && /\b(oasis|camp|tent)\b/i.test(`${r.name} ${r.description}`),
        (r) => (/oasis/i.test(r.description) ? 3 : 0) + ways(r)), 'the oasis: palms, a pool, the nomads\' tents');
      // Raff's neighborhood: the burnt-out strip between the two gangs, and a
      // room with no roof left on it. Both are build.js's own answer, read
      // off the materials it chose, so the vocabulary lives in one place.
      const hood = (r) => built.rooms.get(r.vnum).materials.hood;
      add('nomansland', pick((r) => hood(r) === 'nml', (r) => ways(r) * 2 + stuff(r)),
        "No Man's Land: rubble, barricades at both ends, crows, the gangs' fires across it");
      add('ruin', pick((r) => hood(r) === 'ruin', (r) => (/blood/i.test(r.description) ? 3 : 0) + ways(r)),
        'a burnt-out shop: roofless walls, charred timbers, ash underfoot, the sky over it');
      add('cavern', pick((r) => sewer(r) && /\b(cave|stalag\w*)\b/i.test(r.name),
        (r) => (/stalag/i.test(r.name) ? 3 : 0) + ways(r) + stuff(r)),
        'a cave the sewer breaks into: rock, flowstone, torchless dark');
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
        if (info.cell.level < 0) { score += 2; why.push('underground'); }
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
      let subject = null;
      let best = Infinity;
      for (const item of actors.interactables) {
        const d2 = item.position.distanceToSquared(info.center);
        if (d2 < best && d2 < 60) { best = d2; aim = item.position; subject = item.figure || null; }
      }
      // A mobile walks: aim at where it is now, not where it was reset.
      if (subject) aim = subject.object.position.clone().setY(subject.object.position.y + subject.height * 0.6);
      // A set piece the room's prose names (clutter.js) is what the room is
      // for: the statue of Odin, not the healer standing in front of it.
      // With nothing else to look at, whatever the prose put there at all.
      const SHOWPIECE = {
        statue_odin: 2.6, altar_faces: 0.9, clutter_sign: 1.62, statue_imp: 1.0, figurine_dragons: 0.12, millstones: 1.4,
      };
      const here = (built.stats?.clutter?.where || []).filter((w) => w.vnum === place.vnum);
      const piece = here.find((w) => SHOWPIECE[w.name]) || (!aim && here[0]);
      if (piece) { aim = new THREE.Vector3(piece.x, piece.y + (SHOWPIECE[piece.name] ?? 0.9), piece.z); subject = null; }
      // The camera looks down -Z at yaw 0, so its forward is (-sin, 0, -cos).
      // Facing a point therefore needs atan2 of the *negated* offset, and
      // standing back from it means moving along +(sin, cos).
      let yaw = options.yaw;
      let at = { x: info.center.x, z: info.center.z };
      if (yaw === undefined && aim) {
        const stand = this.vantage(place.vnum, aim, subject, options.back);
        yaw = stand.yaw; at = stand;
      } else {
        if (yaw === undefined) {
          const dir = info.room.exits.findIndex((e, i) => e && i < 4);
          yaw = dir >= 0 ? Math.atan2(-DIR_STEP[dir][0], -DIR_STEP[dir][2]) : 0;
        }
        const back = options.back ?? (aim ? 4.2 : 0);
        at = { x: info.center.x + Math.sin(yaw) * back, z: info.center.z + Math.cos(yaw) * back };
      }
      this.look(at.x, info.center.y, at.z, yaw, options.pitch ?? -0.04);
      return { vnum: place.vnum, room: info.room.name, why: place.why, facing: aim ? 'a subject' : 'an exit' };
    },

    /**
     * Where to stand to look at `aim` in room `vnum`: on open floor in that
     * room, with nothing solid and nobody between the eye and the subject,
     * and not inside anyone. Backing a fixed 4.2 m away from the room's
     * centre put the camera through the wall of a small room (#3002, the
     * HUD then naming whatever was behind it) and inside the sand worm.
     * Tries a fan of bearings round the subject, nearest the old one first.
     */
    vantage(vnum, aim, subject = null, want = undefined) {
      const info = built.rooms.get(vnum);
      const nav = actors.nav;
      const level = info.cell.level;
      const eye = info.center.y + 1.72;
      const base = Math.atan2(info.center.x - aim.x, info.center.z - aim.z);
      const ideal = want ?? 4.2;
      const bodies = actors.figures.filter((f) => f !== subject && !(f.m && (f.m.gone || f.m.dead)))
        .map((f) => ({ x: f.object.position.x, z: f.object.position.z, r: (f.body ? f.body.r + f.body.h : 0.35) }))
        .filter((b) => Math.hypot(b.x - aim.x, b.z - aim.z) < 14);
      const reach = subject && subject.body ? subject.body.r + subject.body.h : 0.3;
      const stands = [];
      for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.9, -1.9, 2.4, -2.4, Math.PI]) {
        for (const d of [ideal, ideal - 0.8, ideal + 1, ideal - 1.4, ideal + 2]) {
          if (d < reach + 1.2) continue;
          const yaw = base + turn;
          const x = aim.x + Math.sin(yaw) * d; const z = aim.z + Math.cos(yaw) * d;
          if (!nav.sample(x, z, level)) continue;
          // A metre of floor all round, or the near wall fills half the frame.
          let cramped = false;
          for (let k = 0; k < 8 && !cramped; k++) {
            if (!nav.sample(x + Math.cos(k * Math.PI / 4) * 1.1, z + Math.sin(k * Math.PI / 4) * 1.1, level)) cramped = true;
          }
          if (cramped) continue;
          // Up to the near side of the subject: a fountain's own collider is
          // not in the way of looking at the fountain.
          const near = Math.max(0.1, (d - (subject ? reach : 2.2)) / d);
          if (nav.sightBlocked(x, eye, z, x + (aim.x - x) * near, eye + (aim.y - eye) * near, z + (aim.z - z) * near)) continue;
          // Nobody within arm's reach of the eye, nor standing in the line.
          let crowded = false;
          for (const b of bodies) {
            const dx = aim.x - x; const dz = aim.z - z;
            const t = Math.max(0, Math.min(1, ((b.x - x) * dx + (b.z - z) * dz) / (dx * dx + dz * dz)));
            const gap = Math.hypot(b.x - (x + dx * t), b.z - (z + dz * t));
            if (Math.hypot(b.x - x, b.z - z) < b.r + 0.9 || gap < b.r + 0.25) { crowded = true; break; }
          }
          if (crowded) continue;
          const score = Math.abs(turn) + Math.abs(d - ideal) * 0.6 + (nav.roomAt(x, info.center.y, z) === vnum ? 0 : 3);
          stands.push({ x, z, yaw, score, clear: d * near });
        }
      }
      // The colliders are the walls you walk into, not everything you see:
      // a temple column has none, and stood square in front of the
      // guildmaster. So the survivors are checked against the built world
      // itself, best first, and the first clear one wins.
      // Under a roof, a stand outside the room is outside its walls: the
      // camera stood in the forest facing the great tree's door (#6153) --
      // still inside the room's 13 m cell, outside its trunk -- because every
      // stand in the hollow was cramped by the stairwell. Indoors a stand has
      // to be one the room's own middle can see; failing all of them, the
      // farthest such floor from the subject, uncramped or not.
      // Neither the cell lookup nor the colliders' sight test knows a trunk
      // from a forest, so "inside" is also within the walls' own reach.
      const inside = (x, z) => Math.hypot(x - info.center.x, z - info.center.z) < 4.2
        && nav.roomAt(x, info.center.y, z) === vnum
        && !nav.sightBlocked(info.center.x, eye, info.center.z, x, eye, z);
      if (!info.outdoor) {
        for (let i = stands.length - 1; i >= 0; i--) if (!inside(stands[i].x, stands[i].z)) stands.splice(i, 1);
      }
      if (!info.outdoor && !stands.length) {
        let best = null;
        for (let gx = -4.5; gx <= 4.5; gx += 0.25) {
          for (let gz = -4.5; gz <= 4.5; gz += 0.25) {
            const x = info.center.x + gx; const z = info.center.z + gz;
            if (!nav.sample(x, z, level) || !inside(x, z)) continue;
            const d = Math.hypot(aim.x - x, aim.z - z);
            if (d < reach + 0.8) continue;
            const near = Math.max(0.1, (d - (subject ? reach : 1.0)) / d);
            if (nav.sightBlocked(x, eye, z, x + (aim.x - x) * near, eye + (aim.y - eye) * near, z + (aim.z - z) * near)) continue;
            const score = Math.abs(d - ideal) + Math.hypot(gx, gz) * 0.15;
            if (!best || score < best.score) best = { x, z, yaw: Math.atan2(x - aim.x, z - aim.z), score };
          }
        }
        if (best) return best;
      }
      stands.sort((a, b) => a.score - b.score);
      const ray = new THREE.Raycaster();
      const from = new THREE.Vector3();
      const to = new THREE.Vector3();
      for (const stand of stands.slice(0, 24)) {
        from.set(stand.x, eye, stand.z);
        to.copy(aim).sub(from);
        const length = to.length();
        ray.set(from, to.normalize());
        ray.far = Math.min(length, stand.clear + 0.3);
        if (!ray.intersectObject(built.group, true).length) return stand;
      }
      // Nowhere clear: the room's own centre, still facing the subject.
      return stands[0] || { x: info.center.x, z: info.center.z, yaw: base };
    },

    look(x, y, z, yaw = 0, pitch = 0) {
      player.spawn(x, y, z, yaw);
      camera.rotation.set(pitch, yaw, 0);
      state.roomVnum = null;
      // A jump is not a walk: the skyline should not be seen sinking.
      built.horizon?.settle(camera.position);
    },
    /**
     * Stand in room `vnum`. A room in another zone is crossed into first, so
     * this returns a promise there -- `await diku.goto(3700)`.
     */
    goto(vnum, yaw = 0, pitch = 0) {
      const target = plan.zoneOf(vnum);
      if (!target) return `room ${vnum} is not in the world`;
      if (target !== zone) {
        return crossTo(vnum, { yaw }).then(() => {
          camera.rotation.set(pitch, yaw, 0);
          return built.rooms.get(vnum)?.room.name ?? `room ${vnum} was not built`;
        });
      }
      const info = built.rooms.get(vnum);
      if (!info) return `room ${vnum} is not built in this zone`;
      this.look(info.center.x, info.center.y, info.center.z, yaw, pitch);
      return info.room.name;
    },
  };

  options.start();

  /**
   * Every material's program, now, behind the loading screen (or a
   * crossing's card). three compiles a program the first time something
   * wearing it is drawn, so walking into the desert or the sewer for the
   * first time stalled a frame for the sand, the rock and the vaults -- 517 ms
   * measured at #5028 -- and the far-tree cards stall the first time the
   * forest is far enough off. Hidden things too: the zone that is not in view,
   * the cards, the doors. Programs already made are found in three's cache,
   * so a zone seen before costs only the walk over its scene.
   */
  async function precompile(onProgress = () => {}) {
    const hidden = [];
    scene.traverse((o) => {
      // `placements` is a record for nav.js, never drawn.
      if (o.visible || o.name === 'placements' || o.parent?.name === 'placements') return;
      o.visible = true;
      hidden.push(o);
    });
    const started = performance.now();
    // Compiled for the composer's own target: a program's key carries the
    // output colour space and tone mapping of wherever it draws, and against
    // the canvas every one of these came out a variant nothing ever uses.
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(composer.renderTarget1);
    // Once for each step the light pool's count moves in (quality.js).
    try {
      for (const level of lightPool.levels) {
        lightPool.setLevel(level);
        // Again each time: frames drawn while this waits move the target.
        renderer.setRenderTarget(composer.renderTarget1);
        await renderer.compileAsync(scene, camera);
        await onProgress((lightPool.levels.indexOf(level) + 1) / lightPool.levels.length);
      }
    } finally {
      lightPool.level = -1;
      renderer.setRenderTarget(previous);
      for (const o of hidden) o.visible = false;
    }
    console.info(`precompiled in ${(performance.now() - started).toFixed(0)} ms`);
  }
  const compiling = 'every material, once, on your GPU';
  await progress(bar.compile[0], 'compiling shaders', compiling);
  await precompile((fraction) => progress(along(bar.compile, fraction), null, compiling));

  await progress(1, 'ready');
  dom.loading.classList.add('hidden');
  // What the build came to belongs with the frame rate on the stats overlay
  // (F), not on the title, where it read as a spec sheet. The triangle count is
  // rounded because an indexed geometry's triangles are index.count/3 and the
  // sum is taken over position.count/3, so it comes out fractional.
  state.worldStats = describeWorld();
  // The title card goes up over the world with a camera moving through it.
  titleReel = createTitleReel({
    camera, built, veil: document.getElementById('title-veil'), viewer: window.diku,
  });
  window.diku.title = titleReel;
  audio.startTitle();
  if (titleReel.active) document.body.classList.add('titling');
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
