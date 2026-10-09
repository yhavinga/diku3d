# diku3d

A browser viewer that builds Midgaard at load time out of the stock Merc 2.1
`.are` files. `README.md` explains what it is and how it works; this file is
the part that isn't visible from the code. `LEARNINGS.md` is the
round-by-round log the traps below are promoted from — fuller, dated, with
the measurement that settled each finding; add to it at the end of a round.

## Running and checking

    python3 serve.py            # http://localhost:8173/

There is no build step, no bundler, no test framework and no linter. So
"run the project's checks before calling it done" means, in order:

    for f in src/*.js src/rules/*.js; do node --check "$f" || echo "$f"; done
                                        # nothing else will catch a syntax slip; one
                                        # `node --check a.js b.js` checks only a.js
    node tools/import-check.mjs         # every module actually loads
    node tools/parse-check.mjs          # the .are reader, over all 45 areas
    node tools/layout-check.mjs         # layout quality per area
    node tools/world-check.mjs          # structural faults across stages
    node tools/game-check.mjs; node tools/magic-check.mjs; node tools/rules-check.mjs

`layout-check` prints a walkable percentage per area. That number is the
project's main quality metric — if a change drops it, the change is wrong.
Midgaard should read 97%, and the mean across the 43 areas 95.4% (streets
may run up to 12 cells since wave 13; at 6 they were 93% and 94%).
Two areas that leave town on the same side fight over the same cells; hood
is laid whole (`LAID_WHOLE` in `layout.js`) so it cannot land in the desert.

Anything touching `build.js`, `textures.js` or `actors.js` has to be looked at
in a browser. Screenshots are how nearly every real defect here was found, and
none of them would have shown up in a unit test.

`window.diku` is exposed for exactly that. `diku.places()` works out somewhere
worth standing from whatever areas are loaded — water, a square, a street, a lit
interior, a shop, a sealed gate, a crowd — and `diku.shoot('water')` stands
there and faces what makes it worth seeing. `diku.find('fountain')` searches
room names, prose, sector and contents. Also `goto(vnum, yaw, pitch)`,
`look(x, y, z, yaw, pitch)`, `applyTime('night')`, and the objects themselves:
`layout`, `built`, `world`, `game`, `quality`, `options`. Set
`diku.state.benchmark = true` to halt the render loop when measuring, and
`diku.state.paused = false` to move without grabbing the mouse.

`tools/judge/shots.md` is the judging protocol. The judge is an independent
agent that drives the world through that API, looks up real references, and
returns ranked faults. Its prompt is never softened to make a round pass.

## Understand this before touching the layout

A Diku world is a graph, not a plan. Midgaard is provably non-Euclidean: all 24
two-step routes off the Market Square that could commute disagree. `layout.js`
therefore does four things in order — **place** (breadth-first, scoring each
candidate cell by how many of the room's *other* exits it satisfies), **relax**
(sweep back, move rooms that would join up more exits than they break),
**spread** (rooms take only the even coordinates), **route** (walk each exit
through the free cells between).

**How much room is there to do better? Almost none, and this is measured.**
Label each direction with a vector (north = -z, east = +x, up = +y). A
direction-consistent embedding exists exactly when every cycle in the graph
sums to zero. Midgaard has 107 in-world edges over 100 reachable rooms, so a
cycle space of dimension 8 — and **7 of those cycles do not close**. The
residuals are small: (0,0,1), (1,0,0), (-2,0,1), (2,0,-1), (2,0,1), (1,0,6),
(0,0,6), on the exits #3042s, #3104s, #3107s, #3114e, #3115e, #3120e, #3120s.

Cut those 7 and every remaining cycle closes — verified by rebuilding the
spanning tree on the remainder and counting. With streets limited to six cells
`layout.js` portalled 8 edges (one off the floor); a street may bend round a
residual, so with the 12-cell reach Midgaard keeps only 3 archways. There is no
clever layout waiting to be found.

Two things that look like better answers and are not:

- **A smaller cut.** A greedy hitting set finds 3 edges touching all 7 broken
  cycles, which is *not* sufficient: two cycles sharing an edge have a sum that
  avoids it, and 4 cycles were still open afterwards. Measured, not assumed.
- **Unfolding into a covering space** — duplicating a room whenever a route
  reaches it at a new coordinate. Every cycle closes by construction, but it
  does not terminate here: the 7 bad cycles generate translations, so copies
  spiral. Capped at 2, 4, 8 and 20 copies per room the totals are exactly
  100×cap and the exits that still will not fit *grow* — 26, 48, 90, 212.

Rooms only ever sit on even grid coordinates. Everything between them is either
a routed street or gets built on. Collapsing that back to direct grid adjacency
is the obvious "simplification" and it was measured: Midgaard goes from 93%
walkable to 54%.

**A cell is not a street.** The grid pitch is 13 m, and an open-air room used to
pave every metre of its own cell, so a room, a routed street and another room
came to 39 m of continuous ground — measured by a 36-ray sweep, against 6–12 m
for a real town lane. Rooms cannot move, but a lane only needs a corridor: every
side of an open-air city cell with no way out of it now brings the frontage
behind it forward 3.2 m, and every corner between two ways out is built on too.
Facades finish 6.6 m apart and Main Street's nearest one went 14.5 m → 5.1 m.
Squares are exempt by the mud's own name for them (`SQUARE` in `build.js`),
because a market square six metres across is not a market square.

Wall sides are allocated once, in `layout.js` (`layout.sides`). `build.js` reads
them and never allocates its own — two doors in one wall is the failure mode.

**Rooms are furnished from their own prose.** Diku descriptions are formulaic
about fittings and usually name the wall too — "the bar is set against the
northern wall", "a fireplace is built into the western wall" — and that is a
placement instruction, not scenery. `readFittings()` in `build.js` reads it, the
same move `pickMaterials` already makes on the room name. Two things it has to
guard: "a small entrance to *the bar* is in the northern wall" is a doorway
(hence the lookbehind), and "to the east is the bar" is a direction, so a
taproom is recognised by its own *name* and not by a room that points at one.
Where the named wall is also the wall with the door in it — the Grunting Boar's
fireplace is in the western wall and west is its only way out — the fitting
slides along to clear the opening rather than moving to a wall the mud did not
choose.

## Traps that have already cost time

- `EffectComposer` applies its *own* pixel ratio to every pass. Hand it CSS
  pixels and the whole scene silently renders at half resolution and is upscaled
  on the way out. All sizing goes through `quality.js`; don't call
  `renderer.setPixelRatio` anywhere else.
- Normal maps in `textures.js` come from a Sobel over the height field scaled by
  `size / 22`. Raise that and every surface looks mouldy. Albedo also passes
  through a gamma lift, because it is consumed in linear space — palettes that
  look right as flat swatches come out nearly black without it.
- The sun's shadow map is manual: `shadowMap.autoUpdate = false`, redrawn when
  the player crosses a six-metre grid line. Anything that moves the sun must
  reset `shadowAnchor` or the shadows freeze pointing the old way.
- `Batcher.add` takes geometry already transformed into world space and derives
  UVs from position and normal. Geometry handed in unpositioned gets garbage UVs.
- Escape is the browser's own pointer-lock release and fires whatever you bind
  it to, so anything that closes on Escape also costs you the mouse. Every panel
  closes on the key that opened it -- `E` for examine, `I`/`B`/`K` for the game
  sheets, `O` for options, which re-locks on the way out. Escape still works, but
  nothing may depend on it.
- The camera looks down -Z at yaw 0, so its forward is `(-sin, 0, -cos)`. Facing
  a point needs `atan2` of the *negated* offset, and standing back from it means
  moving along `+(sin, cos)`. Getting that backwards points `diku.shoot()` at the
  wall behind you, which is how it shipped for an hour. The same sign shipped
  wrong in `hud.js` for far longer: forward is `(-e8, -e10)` out of the world
  matrix, but north is *-z*, so a bearing is `atan2(fx, -fz)` and not
  `atan2(fx, fz)`. The compass read the reciprocal — north said south — and the
  minimap wedge, fed the same value, came out mirrored and was right only facing
  north or south. Check it against the layout, not against the algebra: face
  yaw 0 at #3014 and the room the mud calls north of it must be at a smaller z.
- Never put anything at a room's exact centre. That is where the player arrives,
  and both a fountain and a mobile have been stood on top of already.
- A room placed directly above an open-air room turns that street into a tunnel.
  `layout.js` pushes anything reached by going *up* from open ground three levels
  clear; Midgaard's "In the air..." rooms are why. Those rooms are then
  unreachable, so `build.js` skips their geometry entirely — an archway and a
  signpost built for one hang over the town, which a review duly reported as a
  floating gate.
- `assets.js` `choose(names, seed)` defaults its seed. Callers asking only "does
  this model exist?" pass none, and `undefined * n` is `NaN`, which indexes
  nothing — so the temple kit silently never placed.
- **Blender's roll operators aim Z, not X.** `townsperson.py` meant to roll
  every bone so its local X swings forward and back;
  `calculate_roll(type="GLOBAL_POS_X")` aims the bone's **Z** axis there
  instead, so the keyed axis was the sideways one — not the exporter's doing.
  Measured then: the left shin travelled 0.247 m *across* the figure and
  0.012 m along it, and people walked with a shoulder leading. Do not patch it
  at load time: conjugating whole rotation tracks catches the rest pose too (a
  glTF track holds the bone's entire local rotation), and that put one arm
  0.16 m out of its socket and turned each foot a quarter turn off its leg. The "detached foot" and the arm slot a judge reported were
  the compensation, not the model. The rolls are set explicitly at the source
  now; after the regeneration the same measurement (force `actions.walk` to
  weight 1, sample a shin's world position into `figure.worldToLocal()` for a
  couple of seconds) reads 0.286 m along against 0.048 across. Nothing about
  this is visible in a still — and a still is also how a figure gets caught in
  bind pose: `state.benchmark` halts the loop before `actors.update`, so the
  mixer runs one `update(0)` at build time to pose the skeleton.
- **A text halo is ink too.** The name-label plate was replaced with three
  passes of `rgba(0,0,0,0.9)` at blur 10/6/3, which is a lot of black spread
  over a wide soft oval — so against a dim interior it still read as a dark
  blob over the figure's head, only with a rounder edge. Measured: hiding one
  label *lifted* the patch around a figure by 3.4 of luminance. A thin
  `strokeText` outline plus one soft shadow does the same job for legibility
  and now the label lifts that patch by 1.2 instead. Test it that way: hide the
  label and see which direction the local brightness moves.
- **Ambient occlusion with no floor annihilates interiors.** `GTAOPass` at
  `blendIntensity = 1` multiplies the whole ambient term by its visibility
  buffer. Out of doors that survives, because the sun is a separate direct term
  AO never touches. Indoors there is no sun — ambient is the only light there
  is — so an enclosed corner comes out at *literally RGB 0*, in hard-edged
  rectangles that follow the geometry. Measured at 6.5% of the frame in the
  temple. `blendIntensity` (set in `render.js`, with the measurement behind
  its current value) leaves part of the ambient standing so no enclosed corner
  reaches zero; `scale` is an exponent on the result and is tuned with it.
  **Switching the default preset from `medium` to `high` is what turned this on
  for everyone** — `medium` has `ao: false`. A change that only flips a setting
  can still be the change that ships a bug.
- **How much of the light is the sun is a number, and it was wrong by an order
  of magnitude.** On a clear day the sun delivers about eight times what the
  whole sky does onto a horizontal surface. Measure it by zeroing
  `sun.intensity` and re-reading the composited frame: it was 29% at noon, and
  that one figure is most of why every frame read flat. The proof it matters:
  with the sun that weak, switching off every shadow in town changed a noon
  frame by 0.33%. It reads 72% now. Two things move with it — bloom thresholds
  are read in linear HDR *before* exposure, so quadrupling the sun without
  quadrupling them blooms every lit wall; and the ambient coming down means the
  **GTAO floor no longer clears the toe of the tone curve**. `blendIntensity`
  is not a taste setting, it is tied to how much ambient there is to take away.
- **`SkyEnvironment` builds its own `Sky`.** It is a second material with a
  second set of injected uniforms, and anything set on the visible sky has to
  be set on it too or the town is lit by a different sky than the one over it.
  This is how night came to be a black screen: the floor setter was kept for the
  visible sky and thrown away for the bake, so the sky you could see was deep
  blue and the sky everything was lit by was black.
- **Order matters inside the sky shader injection.** Cloud added *after* the
  ceiling that holds the sky to 60 multiplies an already-capped value by its own
  gain, puts the whole sky over the bloom threshold and lifts half the frame.
- **A probe that leaves `state.benchmark` on poisons the next measurement.**
  The loop is what redraws the shadow map after `applyTime`, so with it halted
  the next frame is measured against the *previous* hour's shadows. That is how
  a dusk square that is entirely in shadow came out reading 53% sunlit.
- **Measuring a post-processing pass by disabling it measures a different
  picture.** `EffectComposer` ping-pongs buffers and a pass with `needsSwap`
  changes the parity when it is skipped. Set its strength to 0 instead.
- **Blender puts a model's origin on the floor.** A wall sconce's bracket is two
  metres up its own bounding box, so placing the model at the height of the
  flame hangs the bracket two metres above it — which is the floating flame that
  was reported. Read `library.get(name).bounds` and align to that.
- **Darkening a floor towards its perimeter belongs indoors only.** Out of doors
  the cell next door is painted flat, so the two meet at 0.55 against 1.0 and
  the join is a razor-straight rectangle on the ground, parallel to the world
  axes. That is the level editor showing through.
- **Measure the composited frame, not `renderer.render()`.** Five rounds of
  "black bar" hunting were done with a detector that rendered the scene to an
  offscreen target, bypassing `EffectComposer` — so it never saw GTAO, and GTAO
  was the bug. At one camera it reported 0.07% near-black where the real frame
  had 9.68%. The instrument said fixed five times while the user kept seeing it.
  Read the real back buffer instead: `composer.render()` then `gl.readPixels`
  in the *same task*, before the browser composites — that works without
  `preserveDrawingBuffer`. Anything measured any other way is measuring a
  different picture than the one being complained about.
- **A `CanvasTexture` of text on transparency should not have mipmaps** — but
  for legibility, not because it makes black rectangles. three uploads it
  non-premultiplied and `glGenerateMipmap` averages RGB and alpha separately, so
  black glyph ink bleeds into transparent background and distant labels go
  muddy. `generateMipmaps = false`, `minFilter = LinearFilter`.
  Mipmapping cannot produce a solid black plate: **a box filter conserves the
  mean of every channel.** A canvas that is a fifth ink stays a fifth ink at
  every level (mean alpha held at 30/255 from level 0 to the 1×1), so
  minification can only ever produce a faint veil. A solid dark card behind a
  label is a semi-opaque plate, tone-mapped to near-black.
- **"A bug of the right shape" is not "this bug".** One reported black rectangle
  turned up four different culprits — a corridor to an unbuilt room, unlit
  window panes at `0x14110e`, the arch's voussoirs, and the label plate. All
  four were real and all four are better fixed. Each time the fix was called
  done without reproducing the reported symptom first, and three times it came
  straight back. Reproduce, then fix, then reproduce again.
- **To find what a black shape is, hide things, don't reason about it.** Three
  rounds went into a "black bar" by theorising from screenshots. What settled it
  in two minutes: `actors.group.visible = false` to halve the search space, then
  hide meshes by bounding-box signature until the shape vanished. It was the
  `stone_arch` voussoirs. Raycasting was actively misleading — it reported the
  wall *behind* the thing.
- **An arc length has to be measured on the radius the blocks sit on.**
  `build_stone_arch()` sized its 11 voussoirs by the opening radius `r` while
  placing them on `ring_r = r + 0.21`: 0.512 m blocks on a ring wanting 0.517.
  Five millimetres each, eleven times, and the ring is a fan of separate plates
  with lit wall showing between them. Regenerate assets after touching
  `tools/blender/*.py` — running `props.build_stone_arch()` before the fix
  produced a byte-identical file, which is how it was confirmed the committed
  model matched the source and the source was at fault.
- **Anything at RGB 0 is a bug, not a shade.** Three separate black rectangles
  were reported as one: a corridor built to a room that was never built, the
  plate behind a name label (`rgba(12,10,8,0.72)` — sprites are tone mapped, and
  ACES takes an sRGB 12 to nearly zero, so a "dark glass panel" was 72% opaque
  black), and unlit window panes at `0x14110e`. Nothing outdoors under a sky is
  ever zero; when something reads as a hole, measure the pixel before looking
  for geometry.
- **V runs the other way out of Blender.** glTF writes `v = 1 - v`, so on every
  model `uv.v` correlates `-1` with world Y while everything out of `Batcher`
  correlates `+1`. The normal map's green channel is a direction in that space,
  so leaving it flipped inverts the relief on all fifty models — mortar stands
  proud of its blocks, chamfers climb out of joints instead of falling into
  them. `digest()` negates V for this reason. The check is three lines and worth
  re-running after any asset change: correlate `uv.getY(i)` against
  `position.getY(i)` over vertices whose normal is near-horizontal, on one
  procedural mesh and one `InstancedMesh`. They must agree in sign.
- A detail normal has to be **structureless**. It used to be the material's own
  normal map sampled 6.3x smaller, which is fine for plaster and dirt and wrong
  for anything with a bond: it stamps a miniature copy of the courses inside
  every block, so one wall reads as 90 cm ashlar and 14 cm brick at once. It is
  a separate isotropic grain map now, in world units, not a multiple of the tile.
- `wet` in a recipe is damp collecting in the low patches. That is right for a
  street and wrong for a floor, and `planks`, `marble` and `flagstone` are mostly
  indoors — it was putting rain puddles on the floorboards of the tavern.
  `planks` and `marble` are dry; `flagstone` keeps a trace at 0.16; `cobble` is
  not dry at all.
- **Calibrate a shader gate on what the shader samples, not on the source
  histogram.** Both wetness gates were set against the macro map's raw pixels;
  the mip/bilinear-filtered sample converges to the local mean (0.76–0.91,
  above the 0.58 gate edge), so the entire wet system — overcast's 1.9, rain,
  `setWetness` — had never changed a pixel and nobody had A/B-measured it.
  A/B every feature once at birth.
- **The sun's shadow map is drawn around the camera of the last rendered
  frame.** `goto()` *after* `applyTime` leaves the destination outside the
  shadow frustum and every shaded face measures lit. Camera first, then the
  hour, let a frame render, then freeze and measure.
- **A thin ledge near a wall's inner face leaks sunlight.** three renders
  a front-sided material's back faces into the shadow map, so anything
  within the shadow bias of that face is lit. Baked surfaces use
  `shadowSide = DoubleSide`; keep it on new ones.
- **`timber` is the half-timbered wall pattern, not a wood.** Posts,
  beams, frames and fences are `oak` or `wood`, or they come out as
  barber-pole stripes.
- **A vertex census lies about surfaces.** A log-cabin gable read "open" by
  vertex count (a log wall's vertices sit only at the ends) and a roof prism
  reported "0 cells affected" (six vertices, none mid-span). Sample triangle
  surfaces or raycast; never count corners.
- **Outdoor shade needs its blue taken out, and night needs a moon above
  the horizon.** The sky term is pure open sky, so shade read B/R 1.7 until
  `setSkyBleach` took part of the hue out; and the night light used to be
  the sun at −8°, lighting nothing. Both are time-preset keys now
  (`skyBleach`, `moon`) — keep them when adding a preset.
- **A HemisphereLight has no occlusion, and three.js filters lights by the
  *camera's* layers, not the object's.** The noon ground-bounce hemisphere lit
  the temple's inside like the street; a layers split needs a second render
  pass. `Batcher` writes an `aIndoor` vertex flag and the light loop mixes the
  hemisphere down indoors — new batched geometry must keep that flag right.
- **Underground rooms inherit nothing from the surface recipe.** Buried rooms
  were getting lit window panes, a floor gap open to the sky (room floors stop
  at ROOM/2 = 5 m, routed passages start at HALF = 6.5 m) and pitched roofs
  breaking up through the graveyard turf. Anything built per-room must be
  checked against buried rooms explicitly.
- **Underground has no sky, and three things forget it.** Hiding the town
  with `visible = false` also hides it from the shadow pass, so the noon sun
  shone into a lair three levels down; the night "sun" is the moon at -8°,
  a light from *below* that draws lines up buried corners; and a metal
  underground reflects nothing bright and renders at RGB 0. Anything built
  per-room has to be checked in the sewer as well as in the town.
- **Test a prose vocabulary over all 45 areas before shipping it.** `pond`
  took Midgaard's park pond into the bog set, `chapel` matched a street in
  hood.are, `den` as a substring matches "Gamgee Resi**den**ce". The
  reject-list is as load-bearing as the match-list.
- **`scene.fog.color` is an LDR display colour and the sky is HDR.** At noon
  the sky's linear radiance is ~3.1 against the fog colour's 0.64, so even a
  100% fog blend reads ~5× darker than the sky behind it — a distant object
  can never dissolve into the sky through fog colour alone. The horizon ring
  writes the fog *transmittance* into its alpha instead and lets the real sky
  supply the haze.
- **`kit.py` `timber()` used to build inside-out when the longest side ran
  along Y** — axis 1 placement is an odd permutation and reversed the chamfer
  ring's winding. Fixed, but the shape of the bug generalises: after any
  permutation-based placement, verify face orientation by sampling normals,
  not by eye; backface culling hides the error from every front-on look.
- **Everything underground uses `buriedTwin()`**, not only the sewer's
  recipes, and anything that takes no shadow needs `sunless: true` or the
  noon sun reaches it through the rock. Check any new material with a
  noon-vs-night diff of an underground room: it must be zero.
- **Cloning a material drops its `defines` and `onBeforeCompile`.** A
  clone of a buried surface loses `DIKU_BURIED` and reflects the sky
  underground. Copy defines, hooks and `defaultAttributeValues` explicitly.
- **`env` in a recipe scales what a surface mirrors, through its own
  uniform.** three r185 overwrites `envMapIntensity` with
  `scene.environmentIntensity` for any material without its own envMap, so
  `decorate()` and `honourEnv()` (textures.js) carry it as `dikuEnv` and
  apply it to `radiance` only: it composes with the hour's preset and fx.js's
  indoor cut, leaves the diffuse sky alone, and is skipped underground. A
  new world material with its own hook calls `honourEnv()` *last*; a clone
  loses it like every other hook. On dark rough surfaces the sky's sheen is
  most of what lights the shade, so their `env` decides how black a forest
  is at dusk. Figures take the same sky share as the walls (`SHARED_LIGHT`
  in dress.js); check a torso against the wall behind it after any material
  change.
- **"Indoor" for a placed model comes from the walls (`openAir`), not the
  mud's INDOORS flag**, and indoor reflections lose the sky's hue — or
  metal reads blue.
- Figures are kept out of the sun's shadow map, so their contact shadows are
  placed by hand in `actors.js` and have to be told where the sun is:
  `applyTime()` calls `actors.setSun()`. Miss that and every person in the town
  goes back to standing on nothing, which is exactly the fault that made a judge
  call the whole scene a stack of composited layers.
- UVs coming out of Blender are in metres and must be **multiplied** by
  `material.userData.uvScale`, which is already `1/tile`. Dividing tiles the
  texture tile-size-squared times too often and reads as a dark grid.
- **glTF out of Blender, three more ways.** The exporter writes a key at
  frame f to time f/fps, so a clip keyed from frame 1 holds its first frame
  and hitches every loop — bake from 0. It bakes a `.scale` track on every
  bone, which resets any scale you set on a bone at load. And in a
  multi-material mesh every material after the first gets white vertex
  colours; export one object per material. three also drops the dots from
  bone names: `grip.R` is `gripR`.
- **A walk clip's stride is measured, not assumed.** `motion.js` sets the
  walk playback rate from the rig's `stride` (m per cycle) and the clip
  length. Change a walk cycle and re-measure it as the median backward speed
  of the foot that is low *and* moving back, or every figure skates.
- **three r185 has a BatchedMesh program-cache bug** (`colorTexture` vs
  `_colorsTexture`), patched by a getter in `quality.js`. If the vendored
  three is ever updated, check whether the patch is still needed.
- **Never toggle a light's `visible` per frame.** The visible-light count
  is part of every shader's program key; the pool moves in precompiled
  steps (0/2/4/8/all) for that reason.
- **Visibility is measured per cell (`src/cull.js`)** and hidden objects are
  put back for the shadow pass. Anything new that renders must survive
  `?cull=off` vs on with a zero-pixel diff; a new mesh that should never be
  culled (sky, UI in world) has to opt out there, not be special-cased.
- **Zones (`src/zones.js`): the rules engine holds all 44 areas, the
  renderer one zone.** A mobile outside the drawn zone has a room and no
  body, the server/client split the multiplayer plan wants. Each zone lays
  out from a fixed root, so `?room=` never changes a layout. Three things
  bite on teardown: a long-lived module that captures `built` or figures
  (AO mesh lists, aura maps, decal pools, the title reel) keeps a whole zone
  alive — find it with a heap snapshot, not by guessing; a build that
  patches a *shared* baked material's shader must check it has not already
  (the second zone's shader would not compile); and never dispose shared
  materials, or the next zone recompiles every program.
- **Coincident surfaces flicker, and depth precision is never why** (near
  0.1 m gives ~0.1 mm at 10 m). Two boxes that both fill a corner always
  share two planes: one must own the corner. End a piece a few mm *inside*
  the one it meets, never exactly on its face. Measure with
  `tools/judge/zfight.js` (id colours, near plane nudged: coverage cannot
  move, so only depth ties change; a repeated identical render is the
  control for animation) and sweep a zone with
  `tools/judge/headless/zsweep.mjs`; `tools/coplanar-check.mjs` lists
  coplanar overlaps inside the `.glb` files. `instances.add` with an
  unknown model name places nothing and says nothing — the stone room kit's
  corner pillars were missing for that reason.
- **Textures bake in workers and are cached under a hash of the whole of
  `src/textures.js`** (`src/bakery.js`): any edit there invalidates every
  entry, deliberately, because recipes lean on shared helpers. A bake must
  stay deterministic — all 389 maps are byte-identical across bakes, worker
  vs main thread, cache vs fresh — and `?bake=fresh` bypasses the cache.
  A module worker has no import map: the worker imports the hashed text
  from a Blob URL with `'three'` rewritten through `import.meta.resolve`.
  Only ask IndexedDB for keys known to exist (a miss queues behind other
  workers' writes: 69 s of worker time once), and write only after the
  last bake. `buildScene`, grass and `populate` now run as generators in
  100 ms slices (`inSlices`) so the bar climbs; keep new build work inside
  them.
- **Pixel-diffing two page loads measures noise unless three things are
  frozen:** `Math.random`, the time uniforms injected through
  `onBeforeCompile` (reachable only via `renderer.properties.get(m).uniforms`)
  and the torch flicker in `quality.js` LightPool — 30–80% of pixels
  otherwise differ between two loads of the same code.
- **A ring around the world is never "far".** The camera is always inside
  the horizon's bounding sphere, so every distance-based exclusion (cull.js
  `AO_REACH`, culling) misses it. Its strips face the camera with normals
  straight up, GTAO called them occluded, and GTAO's screen-fixed noise
  slid over the hills when turning — the "flickering hills" were that, not
  depth precision (near 1.0 instead of 0.1 left 30% of it). `render.js`
  keeps `horizon-*` out of the AO pass. Measure turning flicker with
  `Z.swim()` (tools/judge/zfight.js), which corrects for the turn;
  `Z.measure({ all: true })` also counts alpha-cut and horizon surfaces.
- **Wall allocation is greedy and depends on order** (`layout.js`
  `allocate`): it tries five fixed orders and keeps the best by walkable
  passages, then doorless exits, then wrong walls — and the old order is
  always one of them, so walkability cannot drop. A one-way exit names a
  wall in the room it *arrives* in too; count it when a stair picks its
  wall. `tools/exit-check.mjs --strict` is the guard: 0 doorless exits,
  every one-way opening barred, ≤52 wrong walls, ≤8 corner arches.
- **The game has more than one player now (`game.players`, `bind(pc)`).**
  The bound player is Merc's `ch`; rules modules follow it through
  `k.onBind`, and a line built inside `withPlayer` reads the new binding.
  Standalone must stay byte-identical — check with a seeded trace, and run
  `node tools/server-check.mjs` (needs `cd server && npm ci`) after any
  change to `game.js` or `src/rules/`.
- **The room a body is counted in is game.js `createRoomCounter`**, read
  from the layout alone (cells, links, the world's exits, shells.js) so that
  a page and the server count alike: inside a walled room's walls or its
  doorway that room, on a street its nearer end, on open ground the nearest
  room the level's open ground reaches, else the last room. Never count from
  `built.rooms` centres: the page moves 182 of them off the grid. Against
  where a body can really walk it decides otherwise on 12.8% of samples, all
  open ground that build.js's geometry cuts off (`roomcount.mjs` measures
  it; `mp-room.mjs` holds page and server to each other). main.js
  `currentRoom()` (HUD, sound, arrow keys) is still a rule of its own.
- **What the rules do to the page's own objects does nothing on a server.**
  `k.actors` (the drawn zone's hinges, figures) is absent there, so a rule
  that changes something the page draws has to reach the page over the
  link: doors come in `doors`, gates in `gates`, mobiles in `mob`. A door
  opened on the server stood shut on every page, collider and all, until
  `doors` existed.
- **The server walks where the page walks** (`server/world.mjs` `judge`).
  The page's ground runs on where the mud joins nothing -- grass between
  and round the rooms, streets that cross or touch, ledges -- and the old
  rule, a room change only along an exit, put players back at 2,849 places
  in the home zone alone. A report is now refused only inside the rock, as
  a jump to a room no exit leads to, through a walled room's wall or shut
  door, or too fast. Which rooms are walled is `isOpenAir`, in shells.js so
  build.js and the server share it; where their walls stand is a model of
  build.js's (`WALL_LINE`, `TREE_LINE`, `DOOR_HALF`). Every way up or down
  with a door has a lid now, read from its words (shells.js `wayLid`: a
  slab, trapdoor, grate, stone, boards, forcefield or coffin lid), and the
  judge holds a body to it; only the four ways the words make plain passages
  (`passageBetween`) are taken whatever their door says, and in a lid's or a
  drop's shaft a body counts in the room below (shells.js `shaftAt`, which
  the judge, game.js's counter and main.js `currentRoom()` share). After changing
  how a room is walled, a doorway's width or a lid, run
  `tools/judge/headless/walkable.mjs`: it puts every step the page allows,
  in every zone, through the real `judge`, and none may be refused. It is
  only a test of what it reaches: with the lids left out of the page it must
  refuse at the lids, and at 0.5 m it cannot follow a flight steeper than
  about 51° or narrower than 1.34 m between its sides.
- **A flat material from assets.js's tag table is not a world surface.**
  `oak` there is a plain brown for shoes and belts, without the baked
  materials' hooks, and a kit model wearing it in a room without sun read
  RGB (13,12,15) beside boards at (78,59,38): the light it took was the
  sky's blue. A model placed as part of the world wears a baked recipe.
  Tell light from colour by setting the material white and reading the
  pixel.
- **Below the ground is a level, not a cave.** build.js's `buried` means a
  cave; actors.js's `isBuriedRoom` means level < 0 or in the rock. A cellar
  a level down (wyvern #1634) got a pitched roof that stood up through the
  floor above it. Code that means "under the ground" tests the level. A lid
  between a buried room and one that is not is lit per side: its underside,
  its shaft and its linings belong to the room below.
- **A light hidden inside a model only shows at night.** The "blue
  thresholds" were a cyan point light in every portal arch since the first
  commit; noon drowned it. Find a colour cast by switching lights off one
  at a time.
- **Modelled animals take a fill light (`beastlight.js`)** like people do
  (`dress.js`); without it they were RGB 0 indoors. A new creature module
  must go through `buildModelledBeast`.
- **Sound needs a gesture, and "enter" is the wrong one.** Headless and
  devtools Chrome autoplay, so a silent title is only reproducible in a
  normal browser.
- **A prose word is matched against name + area together** in
  `pickMaterials`: `den` hit "Miden'nir" and turned 108 rooms into caves.
  Whole words only, and run the vocabulary over all 45 areas.
- **Room house rows are built late** (`rowJobs`, built by `buildLanes`):
  anything reading a room cell's colliders before that will not see them.
- **The title is up before the world is built** (index.html, over
  `assets/title-still.webp`), and `boot()` wires most of the title late.
  A new control on it that starts or needs the game must go through
  `holdTitle` (title.js), or a click on it during the build reaches a game
  that does not exist yet. Re-render the still with
  `tools/judge/headless/title-still.js` if the reel's first shot changes.
- **Wrap every headless and Blender run in `timeout`** (GNU timeout in
  /opt/homebrew/bin); a hung headless Chrome never returns.
- Figures are skinned meshes: one draw each, no instancing, and a second pass if
  they cast shadows. They are kept out of the shadow map and culled past 46 m.
- Large soft sprites are the most expensive thing per pixel in the scene. The
  chimney smoke was 910 particles 3.2 m across; nothing else came close.

## merc21

A submodule pinned to the 1993 release, unmodified. Build output stays local
(`merc21/.git/info/exclude`), and `.gitmodules` sets `ignore = dirty` so the
rebuilt binary doesn't show up as a change in the parent. On macOS:

    make CC=cc NOCRYPT="-DNOCRYPT -Dunix" L_FLAGS="-O"

`-Dunix` because Apple clang defines `__unix__` but not bare `unix`, which is
what `merc.h` tests; `-DNOCRYPT` because macOS has no libcrypt.

## Assets

`assets/*.glb` are modelled, but not by hand: `tools/blender/*.py` generates
them and is the source. Regenerate the lot from inside Blender with

    import sys; sys.path.insert(0, ".../tools/blender")
    import build_all; build_all.run()

They carry **geometry only**. Every object is tagged with a material named
`MAT:timber`, `MAT:rooftile` and so on, and `src/assets.js` swaps in the baked
procedural material of that name at load. Blender owns silhouettes, bevels and
clean normals; `textures.js` still owns every surface. A tag with no recipe in
`textures.js` needs an alias or a flat material in `assets.js` — otherwise it
silently comes out dressed as stone, which is how the townspeople ended up with
skin made of masonry.

Everything is placed as instances batched per chunk, and every placement falls
back to the procedural geometry it replaces if the model is missing, so a
half-built library still runs. `?assets=off` forces the fallback everywhere.

## Constraints

- No dependencies beyond the vendored three.js in `vendor/`, which is committed
  on purpose so a clone runs offline. Nothing is fetched from outside the
  repo at runtime. Every texture is still generated at boot; sounds and music
  are not: footsteps, ambience and music are committed ElevenLabs clips in
  `assets/audio/` (Opus in OGG, listed with their prompts in `manifest.json`),
  loaded lazily after the game begins, and the synth in `audio.js` is what
  plays until a clip has loaded or if it is missing (one console warning names
  the file). Regenerate with `node tools/audio/generate.mjs [--force] [ids]`
  (key in the gitignored `.env.elevenlabs`; `--post` redoes only the ffmpeg
  stage from `tools/audio/raw/`, free); `tools/audio/analyze.mjs` and
  `map-check.mjs` are the checks, since nobody can listen in CI. Which clip
  plays where is the one table in `src/soundmap.js`.
- The DikuMUD and Merc licences (in `merc21/`) forbid commercial use and require
  the credits to stay. They are reproduced on the title screen and in the README.
