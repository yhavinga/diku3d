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
