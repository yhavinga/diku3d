# Learnings

What the rounds taught, round by round. CLAUDE.md keeps the curated traps —
the ones you must know before touching a file; this is the fuller log they
are promoted from, with the measurements that settled each one. Add to the
top, date the section, keep the numbers: a finding without its measurement
is an opinion.

## 2026-09-27 — people, animals, and a town that walks

Five agents in parallel, each in its own worktree with its own port and a
headless GPU Chromium (`/tmp/pw/shot.mjs`, Playwright over Metal), because the
shared chrome-devtools and Blender MCP instances serialise everything. Blender
runs headless per agent: `Blender -b --factory-startup --python-expr …`.
`lib.py` had the main checkout's path hard-coded, so a worktree's models
landed in the wrong `assets/`; it derives it from `__file__` now.

### Motion (src/nav.js, src/motion.js)

- **Stride is the median backward speed of the foot that is low *and*
  moving back.** On the old clip the swinging foot passes lower than the
  planted one; a height-only test gave 0.16 m per cycle. The mean runs
  25–35% fast because of heel-off; a multiplier sweep put the minimum slip
  at the median.
- **Pace comes from the rig, not from a constant.** A duck at human pace
  needed its walk clip at 7× speed. Pace = stride / cycle length.
- **Two passages can share a street cell.** `passageAt` names one owner and
  build.js builds the cell twice. Before the room rule was fixed, 78 of 179
  room changes went through a third room.
- **Axis-aligned boxes round rotated props seal trails shut.** Use the
  rotated footprint.
- **`RenderPass.clearDepth` clears before `setRenderTarget`,** so it clears
  whatever target was bound last, not its own.
- **A swing in progress has to win.** A flinch laid over a swing cancelled
  the blow about to land, and the next beat's wind-up cut the first swing
  off before its hit frame.
- **Merc resolves a whole round on one pulse.** Every event needs its own
  presentation beat or four blows land on one frame.
- Measured: 60 s over six areas, 249 figures, zero frames inside a wall
  collider, sideways drift 0° at p99; 10 minutes of Midgaard headless: 161
  room changes by 23 of 71 mobiles, sentinels and shopkeepers never moved.

### Animals (tools/blender/beasts.py)

- **Blender 5.2's glTF exporter writes white vertex colours for every
  material after the first** in a multi-material mesh — the eyes came out
  as white marbles. One object per material.
- **Smooth-blending chain segments end to end makes a bead at every joint.**
  Join a chain with a plain minimum, then blend it into the body.
- **A distance field returning 1e3 outside a part's box breaks marching**
  unless every step is capped — one eye came back 269 m up.
- `export_force_sampling=False` and linear keys halved the files.
- 15 bodies, 2 draws each; Shire barn with 14 animals 5.0 → 4.9 ms.

### Monsters (tools/blender/monsters.py)

- **A leg that splays sideways must be rolled so its local X is the normal
  of the leg's own plane**, and the IK must build its frames the same way.
  The quadruped convention (X on world X) twists a spider's leg about
  itself as it swings.
- **A sideways yaw on a steep neck bone is a lean, not a turn** — that
  rotation applies before the pitch. Curl a neck by pitching it.
- **A coat's darkest mask has to stay above about 0x30**, or occlusion
  rounds a black coat to RGB 0: 1% of a morkoth frame was pure black,
  0.04% after.
- A light-pool candidate may carry getters for x/y/z, so a moving creature
  (the Will-O-Wisp) carries a real light; the pool buckets it by its load
  position.
- Vocabulary over all 45 areas: 105 → 158 creature matches, every earlier
  match unchanged. `wererat` came off the reject list because its own
  description says it looks like a rat "except that it is standing".

### The rest of Merc (src/rules/, save.js, console.js, items.js)

- **Anything that creates a mob or object at boot or reset shifts the fight
  rolls** unless it draws on its own generator; `wake(slot, rng)` takes
  one, and resets and the mayor use the wandering generator. Otherwise
  magic-check's sanctuary check broke on an unrelated change.
- **In first person a kick only enters the frame once the foot is above
  waist height.**
- **The library's flat materials carry a colour of their own**, so vertex
  tints multiply down to near black.
- **The right-hand column overflows at 720p**; the log gives way while the
  target panel is up.
- Merc's command table is kept in its original order because the
  abbreviations resolve by order; the 90 socials are generated from
  `interp.c` by `tools/gen-socials.mjs`, not transcribed.
- A dead mob returns in its own body once its corpse is gone — the body is
  the corpse — and walks in from a street.
- 16 dropped items in view: +142 calls, +0.78 ms.

### Spells (src/magic.js, src/spellfx.js)

- **Additive effects over sunlit ground only bleach towards white.** Give
  emissive particles a share of cover — premultiplied colour, blend ONE /
  ONE_MINUS_SRC_ALPHA, alpha = a × occlusion. That is what made fire read
  orange at noon.
- **three's ACES does `color *= exposure / 0.6`.** Author effect colours in
  display units and multiply by `0.6 / exposure`; the bloom threshold in
  those units is about 12 at noon, 23 at dusk and 4 at night.
- **An effect light toggled by `visible` changes the light count and
  recompiles every lit material mid-fight.** Two pooled lights stay in the
  scene at intensity 0; ~0.12 ms each at 720p.
- **Aura shells on every mesh stack rims and turn a figure to glass.** Only
  skinned meshes over 150 vertices, lit on the silhouette.
- Aim things that fly at the player 0.8 m ahead of the face, burst them at
  2.6 m, or the frame blows out.
- Fireball at night 6.4 → 7.7 ms median; sanctuary on the target costs
  nothing measurable.

### Sewer and desert (tools/blender/sewer.py, desert.py)

- **`visible = false` also hides a group from the shadow pass.** With the
  town hidden, the noon sun lit a lair three levels down (luminance 111
  against 30). The world is split above/below ground and each half drawn
  only when the camera could see it — the sewer cost 985 draw calls in the
  Market Square without a visible pixel — but every half is shown for the
  shadow pass.
- **The night sun is the moon at -8°, a light from below the world.**
  Underground it drew blue lines down every corner; buried surfaces ignore
  any sun below the horizon.
- **Metal underground is RGB 0.** A metal only reflects its surroundings and
  there is nothing bright down there. Rust, not iron.
- **The gap between a room's wall and its cell edge beside every doorway**
  faces a neighbour in town and showed the sky underground; buried rooms
  close it.
- **The area flags lie.** 170 of 177 sewer rooms are DARK, 26 drains are
  sectored FOREST (and were planted with firs), exits to room -1 mean no
  exit, and "Strange Glowing Sand" is INDOORS but open desert.
- **Sand ripples as colour or strong relief read as zebra stripes** under a
  low dusk sun.
- 507 rooms (was 285), MAX_ROOMS 560; world build 146 → 255 ms; Market
  Square 748 → 863 calls before the split's remaining cost (the sewer's
  mobiles, still drawn under the street).

### People (tools/blender/people.py, src/people.js)

- **The exporter writes a key at frame f to time f/fps.** Clips keyed from
  frame 1 hold their first frame and hitch every loop; bake from 0.
- **It bakes a `.scale` track on every bone.** Strip them at load, or a
  child's bigger head is reset to 1 every frame.
- **three drops the dots from bone names** (`grip.R` → `gripR`).
- **`Box3.setFromObject` on an unposed skinned mesh is NaN**; use the
  geometry's bounding box.
- **Decimate's vertex-group weight is violently non-linear**: 0.97 against
  1.0 already keeps 70% of that side. Search for it.
- **Bone heat fails on tiny loose islands**: bind the trunk alone, weld the
  head rigidly.
- One skeleton shared by every mesh of a figure uploads its bone texture
  once; materials cached by surface and colour. Market Square people cost
  0.56 → 0.87 ms for 2.6× the triangles.

## 2026-09-07 — six areas, and the judge's third round

The graveyard joined, the marsh became a bog, the Shire became halfling,
Haon Dor got its cabin and its forest floor — and an independent judge
round found the two systemic faults nobody had measured: noon shade and
a wetness system that had never worked.

### Choosing and joining areas

- **Measure the seam's sector pairs, not just the anchor count.** grave.are
  joins on one horizontal anchor like the book says, but the decisive
  number was different: 18 boundary contact pairs, every one park/field/
  water, zero interiors — the only clean seam in the world (midgaard↔shire
  has 7 indoor contacts, marsh↔trollden 8). And a new area can *improve*
  the town it joins: the layout reshuffle in the park corner turned one
  portal into an alley and lifted Midgaard's own walkable 92.5% → 93.5%.
- **world-check now guards MAX_ROOMS out loud.** The guard was proven by
  lowering the cap in a scratch copy: at 260 it names haon 66/71, marsh
  1/18; at 200, marsh 0/18 and trollden 0/5 — exactly the silent-truncation
  failure it exists to catch, now an exit code instead of a mystery.

### Prose-driven predicates

- **Test the vocabulary over all 45 areas before shipping it.** `pond` and
  `murky` took Midgaard's park pond into the bog set; `chapel` matched a
  street in hood.are; `den` as a substring matches "Gamgee Resi**den**ce".
  The reject-list (`BOG_NOT`, name-only matching) is as load-bearing as
  the match-list, and each word earns its place by a 45-area count.
- **The sector code lies and the prose does not.** Bog rooms sectored
  MOUNTAIN, tombs that miss the `crypt` vocabulary, "A Gravel Road" with
  no gravel — the mud's authors wrote the truth in the name and
  description and mis-set the enum. Every treatment this round keyed on
  words, with the sector as a hint at most.

### Measurement

- **A vertex census lies about surfaces — twice in one day.** A log-cabin
  gable read "open" counted by vertices (a log wall's vertices sit only at
  the ends), and the roof-overhang probe said "0 cells affected" because a
  prism has six vertices and none in the middle. Sample triangle surfaces,
  or raycast; never count corners.
- **The sun's shadow map follows the last rendered camera.** `goto()`
  *after* `applyTime` leaves the new position outside the shadow frustum
  and every shaded face reads lit — one whole set of numbers was wrong
  this way. Camera first, then the hour, then let a frame render, then
  freeze and measure.
- **"Placed" is not "reads".** Wave 3 planted 146 headstones and the judge
  photographed an empty lawn: mown grass under them, street barrels on top,
  and an over-cautious edge clearance that left 7.7 stones per 169 m² cell.
  Density, ground and de-cluttering are one feature; the count alone proves
  nothing a viewer can see.

### Light

- **The missing term at noon was ground bounce, not more sky.** Raising
  `env` to 1.35 does fix the 24:1 shade crush — and flattens cast shadows
  from 8.4:1 to 2.2:1, a sunny day with no shadows in it. A
  `HemisphereLight` with a black sky half and a bright ground half is the
  bounce term by construction: walls get half, undersides all, shadowed
  paving nothing. Measured: shade ratio 24:1 → 5.2:1 with the cast ratio
  held at 6.1:1.
- **A HemisphereLight has no occlusion, and three.js filters lights by the
  *camera's* layers, not the object's.** So the bounce lit the temple's
  inside like the street (81 → 140 mean) and a layers split cannot fix it
  without a second render pass. The zero-cost fix: an `aIndoor` vertex
  flag written by the batcher, `mix(1.0, indoorBounce, vIndoor)` in the
  light loop — temple 139 → 99 with the market untouched.
- **Judge a sky gradient at several altitudes before "fixing" it.** The
  reported too-bright zenith reproduced only at 25–45° — that dip is the
  Rayleigh minimum 90° from the sun, correct physics. Horizon(2°)/zenith
  measured 3.64:1, already right; rayleigh tuning would have washed the
  whole sky to fix a non-fault.

### Fog and wet

- **FogExp2's half-contrast distance is 0.8326/density, and ours was 95 m.**
  What was meant as a BC haze was dense fog 44× past clear air; distant
  firs read as sand dunes through 130 m of tan. And fog colour belongs to
  the hour's *horizon sky* (dusk fog was (184,123,78) under a sky whose
  own horizon read (181,176,177)) — half-distance now 520–694 m by hour.
- **The entire wetness system had never changed a pixel.** Both shader
  gates were calibrated against the macro map's raw histogram; what the
  shader samples is mip/bilinear-filtered and converges to the local mean
  (0.76–0.91, entirely above the 0.58 gate edge). So overcast's `wet: 1.9`,
  the rain coupling, `setWetness` — all dead since the day they shipped,
  and nobody had ever A/B-measured wet against dry. Calibrate a gate on
  what the shader *samples*, and A/B every feature once at birth.
- **Rain must be measured from the preset it falls out of.** The first
  coupling lerped from dry and produced 1.78 under an overcast base of
  1.9 — rain would have dried the street. `target = base + (peak−base)·r`.
  And state the frame loop re-derives cannot be pinned from the console —
  a force hook has to override the derivation itself (`diku.forceRain`).

### The judge's third round

- **The judge found two faults nobody's checklist held** (noon shade
  crush, dead wetness) and mis-diagnosed one: Main Street's "gaps between
  houses" are routed passage mouths — walling them would seal the town.
  The observation was right, the cause was not; the A/B with party walls
  on/off (low-sky 0.81% both ways) is what stopped a wrong fix. 87 real
  gaps elsewhere did get their party walls.
- **The fountain had no visible water at all.** Its coping was modelled as
  a solid lid; the square water plane sat *under* it and only the corners
  overhanging the drum ever rendered. "No glint" was the thread; pulling
  it found geometry nobody had looked at side-on since it shipped.

### The verify round, and the causes it overturned

A fresh judge re-measured all twelve assessable faults at the same
cameras: nine RESOLVED, two IMPROVED (marsh water still slab-edged,
mid-distance street still islands), interior scale still open — and seven
new finds. Fixing those five overturned two of the judge's own root
causes, which is the round's real lesson: **reproduce the mechanism, not
just the symptom, before editing.**

- **A fix that clears the air exposes what the murk was hiding.** Thinning
  noon fog 0.0060 → 0.0012 revealed the horizon ridge as a black cut-out
  at 95:1 against the sky — it had been fogged out of existence since the
  day it shipped. The judged cause ("fog disabled") was wrong: fog was on
  and blending. The real one: **`scene.fog.color` is an LDR display colour
  and the sky is HDR** — at noon the sky's linear radiance is 3.10 against
  the fog colour's 0.644, so a *full* fog blend still reads 4.8× darker
  than the sky behind it. The ridge now writes the fog transmittance into
  its alpha and lets the real sky supply the haze: sky:ridge 31:1 → 1.6:1.
  Every other distant fogged surface still blends toward the too-dim
  colour (invisible at street range) — open item, lives in TIMES.
- **`timber()` builds inside-out when the longest side runs along Y.** The
  chamfer ring is wound in (u,v) and placed by axis permutation; axes 0
  and 2 are cyclic, axis 1 is an odd permutation and reverses handedness.
  The fountain's kerb blocks (0.71 m tangential, 0.62 tall) had all 20
  outer faces pointing inward — backface-culled into a see-through drum —
  and it had shipped that way three rounds earlier; the water rebuild it
  was blamed on was innocent. 28 of 64 assets regenerate with the fix.
- **The "party wall through the swamp hill" was the HILLS filler**: a
  13×13×4 m rock box sheared flat at y+3.2 in every hills cell, so the
  mud's "you stand atop a hill" sat 3.2 m below its own surroundings. A
  grass prism ridge (2.8–4.4 m by hash, quarter turns only — a free angle
  overhangs the cell by 2.7 m) reads as terrain. MOUNTAIN's 11 m box has
  the same shape of fault, one cell taller, still open.
- **The "crates among the graves" were park benches.** Midgaard's park
  cells interleave the graveyard's (the gate opens into the park), and a
  routed park passage laid its bench on cell (−4,21). No object reset, no
  clutter-gate leak — content behaving correctly, left alone. Census the
  instances before blaming the gate.
- **A one-word veto beats a wider guard.** #6142 "…cave…" is a canopy
  room the cave-word wrongly kept enclosed; `\boutside\b` frees exactly
  one room across all 45 areas. `entrance to` and `before` were tried and
  dropped — they take "Entrance to the Crypt" and "Standing before the
  throne" with them.

One long session: the compass step became a walk, the mud's own barometer
took over the sky, rain arrived, and the default world grew from one town
to five areas with Haon Dor's forest walkable through the West Gate.

### The world graph

- **Multi-area layout needed no new code, only measurement.** layout.js
  runs ONE breadth-first placement over whatever areas load; cross-area
  exits resolve to ordinary routed streets the moment both ends exist.
  The predictor for a good neighbour: an area hanging off **one horizontal
  exit pair grows as a clean branch** and raises the walkable percentage
  (five-area set: 96.3% against Midgaard's own 92.5%); two anchors fold
  the area back over the town (midennir: forest rooms one step from the
  Mage's Bar, 88.1%), and a vertical anchor shoves open ground three
  levels up (dream 76.3%). Curation IS the travel feature.
- **`MAX_ROOMS` truncates silently mid-walk.** At the cap, whole areas get
  zero rooms while their exits quietly degrade to gates. Any curated set
  must be counted against it (252 < 400 today) — and the shipping
  configuration was never exercised by any check until world-check grew a
  one-world pass.
- **A sector-driven feature must cover the routed cells too.** Water
  planes were emitted per water *room*; the routed cell between two water
  rooms showed the raw floor recipe as a boiling band mid-river. Same
  shape of bug as the clutter that then stacked barrels on the new water.
- **The mud's INDOORS flag means "no sky", not "a building".** 44 of Haon
  Dor's forest rooms carry ROOM_INDOORS — the deep dark forest — and were
  built as ashlar corridors with torches. They are hollows under knitted
  fir crowns now; rain and outdoor ambience stay correctly off. And six
  of the 44 are genuinely interiors — the NAME (cave, temple, inside,
  underground) wins over the sector code, the same move the park makes.

### Weather and water

- **Port the mud's systems dice-for-dice, on a separate RNG stream.**
  weather_update came over with its exact pressure bounds and messages,
  but rolling it on the game's own stream would have shifted every number
  game-check pins. Its own seeded stream keeps game-check byte-identical.
  And the options guard had to compare the *mode*, not the value — under
  'auto' the two legitimately differ, and the old comparison rebaked the
  environment every options apply.
- **Any material with hardcoded radiance breaks when exposure swings.**
  The water's colours were constants while toneMappingExposure runs 0.165
  to 0.62 — so the river read swimming-pool teal under overcast and, at
  night, a glowing white sheet (lum 185, 86% of pixels over 180; 34.5
  after feeding it the hour's sky). If a shader owns its colour, applyTime
  must own a setter for it.
- **Rain is a line, not a sprite.** ~900 one-pixel falling streaks in a
  camera-riding cylinder cost less than the chimney smoke; lit by the
  hour's haze they are silver by day and gone at night, which is right.
  The sound carries the other half, and *halving* it indoors reads as
  rain on the roof.

### Assets

- **glTF export is not byte-reproducible where UV-spheres meet join()** —
  rebuilding an identical tree shuffles only the index buffer (POSITION,
  NORMAL, UV byte-identical). Two committed .glbs will show as modified
  after any rebuild without anything having changed.
- **Measure before adding a flag: `shade_smooth` changes not one normal
  on an 8-sided hull** (45° facets against the 30° threshold) while it
  genuinely rounds a UV-sphere. A first render also beats counting: the
  fir shipped as a see-through bottlebrush and the moss cap clipped its
  own boulder, both invisible in the tri-count and obvious in one frame.

### The walked step

- **Turn first, then walk — and keep the cut where a walk would lie.**
  The compass glide eases up to a second cell-to-cell with bob and
  footsteps, half a second extra for a half turn, one buffered press so
  reading the map fast still works. Portals, stairs and bent layouts
  keep the fade: a glide through a wall would say something false.

### What the second judge round taught

- **An alias is a place a whole biome can hide in.** `leaves → grass`
  looked like a harmless fallback and put the lawn on every tree crown in
  the world; the judge's raycast pair (crown at 50 m, ground at 3.7 m,
  same material uuid) is the two-line probe that catches any such alias.
- **Check a tween's endpoint against the world, not just its curve.** The
  glide landed on the raw room centre and physics popped the player 2.13 m
  sideways in one frame — off the fountain the never-at-the-centre rule
  exists for. Resolve the destination before travelling to it.
- **A shear that moves both ends of a segment equally tilts nothing.**
  Twelve rain streaks sampled, twelve at 0.0° — the wind offset used the
  same per-streak value for both vertices. Flag one end in the seed
  (+1 on the lower vertex) and the lean is one shader line.
- **Scale errors read as material errors.** The forest's trunks measured
  right (0.81 m median — an old-growth stand at 199 stems/ha) while the
  trees were 12:1 height:diameter against a conifer's 50:1; the stand
  read as topiary. The judge's ruler pair — trunk width by horizon
  raycast sweep, canopy top by downcast — settles tree scale in numbers.

Three rounds in one day: a weather axis toward the Stargate SG-1 / Pacific
Northwest look, an independent judge round, and the repairs it demanded.

### Rendering and light

- **GTAO's prepass cannot see sprite alpha.** The pass re-renders the scene
  with an override material, so a name label — text on a transparent canvas —
  entered the depth/normal buffers as an opaque wall, and the AO shaded the
  sky behind it: measured 34 luma behind one label, 0.6 on a control patch.
  Anything transparent that must not occlude lives on `OVERLAY_LAYER` now,
  disabled on the camera inside `ScaledGTAOPass.render`. The default preset
  going `medium` → `high` is what shipped this to everyone — the second time
  a settings flip turned a latent bug on.
- **`FogExp2` squares its density.** Presence worked out as `exp(-d·x)` is
  wrong by the square: a ridge at +380 m kept 0.6% of itself, not the 10%
  the linear curve promised. Every distance-vs-fog plan has to use
  `exp(-(d·x)²)`.
- **The injected cloud borrows its colour from the sky behind it.** Making
  the overcast deck brighter by lowering rayleigh moved nothing — the deck's
  own base darkened in step. The gain has to put the deck *over* the sky
  (2.0, not 0.92), and a full deck is brightest at the zenith — CIE overcast
  runs ~3× the horizon where ours ran 0.64×; a height term gated on
  `skyCloud.y ≥ 0.97` restored the shape (1.28 after) without touching
  fair-weather cloud.
- **Overcast is not "clear with the sun turned down".** The first cut blew
  more of a dusk frame past sRGB 250 than the clear version of the same shot
  (3.23% vs 1.40%): the Mie glare peak survived under the cloud gain, and a
  raised exposure brought the sun straight back. Overcast owns its Mie
  (0.0016/0.35) and its per-hour exposure now; 0.00% blown after.
- **The sun's share is per-weather, and the metering rig carries over.**
  Zero `sun.intensity`, re-read the composited ground band: clear noon 72%,
  overcast 29% at the first guess, 23% at 0.07 — where no cast edge
  survives, which is what the reference frames show.
- **Azimuth θ=0 is +z, and +z is south.** Noon at azimuth 175 put the sun
  due north; every south frontage sat in permanent shade. Dawn 95 (east)
  and dusk 258 (west) were right, which is exactly why nobody noticed —
  the arc read plausibly until a judge checked a shadow against the compass.
- **Shade sides were 5.9 stops under sun; references hold 2.5–3.5.**
  Lighter mortar alone took it to 3.9 (albedo in the joints was half the
  gap); ambient/env up half a stop on the day hours finished it at 3.5 with
  the sun untouched.

### Actors and assets

- **Present in the buffers is not visible in the frame.** The figures'
  contact shadows were placed, scaled, opacity 0.68 — and metered 1.006×
  the paving beside a pair of feet, because a patch at 0.86× shoulder width
  hides entirely behind its own figure from any eye-level view. 1.32× wide
  reads 0.73×. And the cast-smear formula dimmed *short* shadows
  (`tan·14` → opacity 0.079 at noon) — backwards: the short noon shadow is
  the dark one.
- **Blender's roll operators aim Z, not X** — the full account is the trap
  bullet in CLAUDE.md. The half that generalises: `uprightSwing` conjugated
  whole glTF rotation tracks, and a track holds the bone's *entire* local
  rotation, rest pose included — so the load-time "fix" put an arm 0.16 m
  out of its socket and turned each foot a quarter turn off its leg. The
  judge's "detached foot" was the compensation, not the model. Never patch
  a rest pose through its animation tracks.
- **Clone paths are separate consumers of the same source.** `digest()`
  scaled UVs and negated V on clones for the instanced primitives; the
  skinned path clones the *scene* and shares geometry, so every townsperson
  wore raw metre UVs with the relief running backwards. When a fix lives in
  a copy, list everything that reads the original.
- **A judge photographing a halted loop can catch bind pose.** `play()`
  only arms an action; nothing reaches the skeleton until a mixer update,
  and `state.benchmark` returns before `actors.update`. One `update(0)` at
  build time closes the window.

### Procedural materials

- **Anisotropy in a normal map reads as material identity.** The "wood
  grain" on every tunic was the cloth recipe's slub: a 10×27 mm feature,
  2.7:1 elongated down V — two thirds of the way to bark's ridge ratio.
  Diagnose with mean|nx|/mean|ny| per baked map (cloth was 2.01 against
  1.02 for plaster; 1.02 after). Albedo was never the culprit (4.8% swing).
- **One joint constant, two axes, one reciprocal.** `stonewall`'s bed
  joints came out 16.5 mm and its perpends 66 mm from a single `joint`
  scaled through the aspect ratio the wrong way round. Convert per axis and
  write the mm-per-texel arithmetic in the comment.
- **The mortar was dark twice.** The crevice normal already shades a joint;
  darkening its albedo too is what makes a black net. Lime pointing is
  *lighter* than most stone: joint/face 0.84 → 1.12 and the wall stopped
  reading as loose tiles.

### Lights

- **A candidate that never gets pushed beats any tuning.** Lamp posts had
  light entries — gated on "city cell, north side, coin flip": 34 lamps in
  the world, 3.4% of practicals, and the Temple Square lost the flip.
  Coverage first, intensity second: one per outdoor cell → 105, nearest
  light 28.4 m → 7.4 m.
- **Rank a light pool by delivered light, not distance.** A frontage emits
  a dozen dim window candidates within metres; sorted on bare distance they
  filled every slot and starved the 26-intensity lamp on the kerb.
  `_d / intensity` is crude irradiance and crude is enough.
- **Every outdoor practical needs the daylight flag.** Window lights
  without `outdoor: true` burned a flat 3.4 around the clock — daylight
  included — while the lamp beside them earned its 2.6× night lift.

### UI

- **A wide soft glow is not legibility.** The combat log drowned over both
  sunlit paving and a night street. Same cure as the in-world name labels,
  ported to DOM: a thin dark edge (multi-offset text-shadow) at a fraction
  of the ink, plus a low plate per log line — the description panel's own
  trick. DOM is not tone mapped; a subtle rgba plate is safe here where the
  sprite plate famously was not.

### Process

- **Reproduce with the hide-things method before theorising.** The "dark
  wedge in the sky" took three static-analysis guesses and fell in two
  A/B toggles: actors off → gone; AO blend 0 → gone. Same lesson as the
  black-bar hunts, and it held again.
- **Two screenshots are two moments.** Mobs walk between frames, so a
  pixel-diff carries a motion tail — judge on the p99, not the max.
- **The judge protocol earns its keep.** An independent opus judge with the
  world in its hands returned seventeen ranked, measured faults, four of
  which survived `max` — including two regressions of the same day's work
  (the hidden contact patch, the label occluder). Never soften its prompt;
  re-measure after every fix.
