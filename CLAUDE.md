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

`window.diku` is exposed for exactly that: `diku.goto(3014, yaw, pitch)`,
`diku.look(x, y, z, yaw, pitch)`, `diku.applyTime('night')`, plus `layout`,
`built`, `world` and `quality`. Set `diku.state.benchmark = true` to halt the
render loop when measuring, and `diku.state.paused = false` to move without
grabbing the mouse.

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
- Never put anything at a room's exact centre. That is where the player arrives,
  and both a fountain and a mobile have been stood on top of already.
- A room placed directly above an open-air room turns that street into a tunnel.
  `layout.js` pushes anything reached by going *up* from open ground three levels
  clear; Midgaard's "In the air..." rooms are why.

## merc21

A submodule pinned to the 1993 release, unmodified. Build output stays local
(`merc21/.git/info/exclude`), and `.gitmodules` sets `ignore = dirty` so the
rebuilt binary doesn't show up as a change in the parent. On macOS:

    make CC=cc NOCRYPT="-DNOCRYPT -Dunix" L_FLAGS="-O"

`-Dunix` because Apple clang defines `__unix__` but not bare `unix`, which is
what `merc.h` tests; `-DNOCRYPT` because macOS has no libcrypt.

## Constraints

- No dependencies beyond the vendored three.js in `vendor/`, which is committed
  on purpose so a clone runs offline. Nothing is fetched at runtime and no
  assets exist: every texture, mesh and sound is generated.
- The DikuMUD and Merc licences (in `merc21/`) forbid commercial use and require
  the credits to stay. They are reproduced on the title screen and in the README.
