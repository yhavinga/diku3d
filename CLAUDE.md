# diku3d

A browser viewer that builds Midgaard at load time out of the stock Merc 2.1
`.are` files. `README.md` explains what it is and how it works; this file is
the part that isn't visible from the code.

## Running and checking

    python3 serve.py            # http://localhost:8173/

There is no build step, no bundler, no test framework and no linter. So
"run the project's checks before calling it done" means, in order:

    node --check src/*.js               # nothing else will catch a syntax slip
    node tools/parse-check.mjs          # the .are reader, over all 45 areas
    node tools/layout-check.mjs         # layout quality per area

`layout-check` prints a walkable percentage per area. That number is the
project's main quality metric — if a change drops it, the change is wrong.
Midgaard should read 93%, and the mean across the 43 areas 94%.

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

Rooms only ever sit on even grid coordinates. Everything between them is either
a routed street or gets built on. Collapsing that back to direct grid adjacency
is the obvious "simplification" and it was measured: Midgaard goes from 93%
walkable to 54%.

Wall sides are allocated once, in `layout.js` (`layout.sides`). `build.js` reads
them and never allocates its own — two doors in one wall is the failure mode.

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
  wall behind you, which is how it shipped for an hour.
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
- **The walk cycle comes out of Blender a quarter turn off.** `townsperson.py`
  rolls every bone so that rotating about its local X swings forward and back,
  and keys the walk that way; the exporter lands the keyed axis on local Z, and
  measured on the running rig the left shin travelled 0.247 m *across* the
  figure and 0.012 m along it. People walked with a shoulder leading.
  `assets.js` `uprightSwing()` conjugates every keyed rotation by a quarter turn
  about Y — `(x, y, z, w)` → `(z, y, -x, w)`, a proper rotation, not a mirror,
  so the cycle keeps its handedness. **This belongs in the bone rolls**; it is
  done at load because the models are committed. Fix it at the source at the
  next regeneration and delete `uprightSwing`.
  The measurement that settles it: force `actions.walk` to weight 1, sample a
  shin bone's world position into `figure.worldToLocal()` over a couple of
  seconds, and compare the range along local X against local Z. Forward must
  win. Nothing about this is visible in a still.
- **Ambient occlusion with no floor annihilates interiors.** `GTAOPass` at
  `blendIntensity = 1` multiplies the whole ambient term by its visibility
  buffer. Out of doors that survives, because the sun is a separate direct term
  AO never touches. Indoors there is no sun — ambient is the only light there
  is — so an enclosed corner comes out at *literally RGB 0*, in hard-edged
  rectangles that follow the geometry. Measured at 6.5% of the frame in the
  temple. `blendIntensity = 0.78` leaves a fifth of the ambient standing and
  takes that to 0.03%; the `scale` exponent came down 4.5 → 2.6 with it, since
  4.5 was chosen when the blend could still hide the bottom end.
  **Switching the default preset from `medium` to `high` is what turned this on
  for everyone** — `medium` has `ao: false`. A change that only flips a setting
  can still be the change that ships a bug.
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
  A claim that used to sit here — that this mips down to a solid black plate —
  is **wrong**, and an independent second opinion killed it with a measurement
  worth remembering: **a box filter conserves the mean of every channel.** A
  canvas that is a fifth ink stays a fifth ink at every level (mean alpha held
  at 30/255 from level 0 to the 1×1), so minification can only ever produce a
  faint veil. The solid dark card was the semi-opaque plate the text used to sit
  on, tone-mapped to near-black.
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
  indoors — it was putting rain puddles on the floorboards of the tavern. They
  are dry; `cobble` is not.
- Figures are kept out of the sun's shadow map, so their contact shadows are
  placed by hand in `actors.js` and have to be told where the sun is:
  `applyTime()` calls `actors.setSun()`. Miss that and every person in the town
  goes back to standing on nothing, which is exactly the fault that made a judge
  call the whole scene a stack of composited layers.
- UVs coming out of Blender are in metres and must be **multiplied** by
  `material.userData.uvScale`, which is already `1/tile`. Dividing tiles the
  texture tile-size-squared times too often and reads as a dark grid.
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
  on purpose so a clone runs offline. Nothing is fetched at runtime, and every
  texture and sound is still generated at boot.
- The DikuMUD and Merc licences (in `merc21/`) forbid commercial use and require
  the credits to stay. They are reproduced on the title screen and in the README.
