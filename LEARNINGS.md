# Learnings

What the rounds taught, round by round. CLAUDE.md keeps the curated traps —
the ones you must know before touching a file; this is the fuller log they
are promoted from, with the measurements that settled each one. Add to the
top, date the section, keep the numbers: a finding without its measurement
is an opinion.

## 2026-10-09 — north and west walls

- **A wall facing north or west had an inside-out collider.**
  `buildIndoorWall` wrote its box as `x - t*0.2 .. x + dx*t + t*0.2`, which
  for dx or dz = -1 gives x0 > x1, and player.js does not sort a box. So the
  wall was a strip 0.42 m wide that a body met 0.14 m past the plaster:
  5.14 m from the middle, against 4.44 m at a south or east wall, with the
  camera looking out through the wall at the street. A census of every
  collider in all 32 zones (addCollider instrumented in the page): 3,980 of
  50,999 inverted, every one from `addWall` -- 1,436 whole walls, 2,544
  halves beside a doorway -- and nothing from anywhere else. Fixed by
  sorting the two ends; in moria, hitower and chapel exactly the inverted
  boxes changed and every other collider is byte-identical.
- **At 20 fps a sprint went straight through.** main.js clamps dt at 0.05 s,
  so a sprint is a 0.475 m step, wider than the strip. player.js's own
  update, 40 frames at dt 0.05 into each wall of #3003, #3006, #3009 and
  #3010: through every north and west wall (6.6 to 20.8 m out), stopped at
  4.4 m by every south and east one. After the fix all of them stop at 4.4.
- **A thicker wall cut off no way.** A flood from every room's arrival
  point, 45 m and two levels round it, listing the rooms it walks to: after
  the fix 8 pairs fewer, none of them along an exit -- #1124 to #1121,
  #6134 to #6131 (the spider web, which has no exits), and hitower's #1382
  on level 2 to six rooms on level 0 -- and none gained. crossings.mjs and
  ways.mjs read the same before and after.
- **Ofcol's grass was reached by squeezing past a wall.** walkable's steps
  there fell from 3.75M to 0.44M. The grass round the zone (743k samples)
  met the rest at two places only, a 0.8 m gap between the outside of a west
  wall and the street beside it (cells 8,8 and 12,-2), which a 0.84 m body
  passed only by standing 0.4 m into the wall. With the fix ofcol is shut in,
  as every south and east wall already shut it. Elsewhere walkable lost
  2-10% of its steps, the strips along the walls; with every door open and
  every door shut it refuses nothing (84.1M and 83.4M steps).
- **Clutter had been placed against the broken walls.** clutter.js finds a
  wall by probing the colliders and never found an inverted one, so against
  a north or west wall it stood things at the plaster, and against a south
  or east one it refused any floor thing whose footprint reached the
  collider's 0.14 m strip in front of the plaster. A cage or a chest in a
  kit room (stone face 5.13 m out) stood only against north and west walls:
  cages N 6, W 3, S 0, E 0. With only the walls fixed, 4 things lost their
  place (the Watermill's millstones, the torture room's hanging skeletons)
  and 16 left their wall. Now the strip is no obstacle to what stands against
  the wall (`offWall`), a probe that hits it reads the plaster, and on the
  floor the room to walk round a thing is not wanted against a wall but the
  thing stops at the plaster. Of 528 placements 494 are where they were and
  none is missed that was placed before.

## 2026-10-09 — the server walks where the page walks

- **The page's ground is not the mud's graph, and the server believed only
  the graph.** Reported outside the West Gate: walking south from #3052 onto
  the grass, the server put the player back 50 times in a minute. The live
  log had `no open way from #3052 to #3043` (inside the gate, the gate's
  street touches Wall Road's) and `off the map` (on the grass). Measured by
  flooding every step player.js allows and putting each one through the
  server's own check: at street level in the home zone 3.7M half-metre
  samples are walkable, and 76% of them lie on no room's cell or street
  cell, nor next to one. The old rule (a room change only along an exit,
  nothing far from a room) refused at 5,093 places in 27 of the 32 zones
  with anything built: 2,268 off the map, 2,825 without an exit. The
  street-crossing exception of 96a19d9 covered a handful of them.
- **The rule now** (`server/world.mjs` `judge`): every step is believed,
  except a report inside the rock, a jump to a room no open exit leads to,
  a step through a walled room's wall or shut door, and anything too fast.
  With it, `tools/judge/headless/walkable.mjs` finds no refused step in any
  of the 32 zones with anything built: 87.7M steps, with every door open and
  again with every door shut. Split over five processes by `--zones`, that
  takes seven minutes, six of them the home zone.
- **Walls the server can know.** Which rooms are walled is `isOpenAir`,
  moved into shells.js with the style classifiers it reads. The move was
  checked by classifying all 2,568 rooms before and after: identical. A box
  wall's inner face is at 5.0 m and its outer face at 5.7 m; a body stops at
  4.46 m inside and 6.12 m outside, so the line the judge holds a step to,
  `WALL_LINE` 5.35, sits clear of both. The one exception walking found is
  the hollow tree #6153: a walker in the wood reached the corner of the box,
  outside the bark. Its wall is round (hollow to 4.2–4.9 m, bark from
  6.0 m), so the judge holds it to `TREE_LINE` 5.4.
- **North and west walls are thinner than south and east.** Found here,
  fixed in the next round (above). In `buildIndoorWall` the collider of a wall facing -x or -z is an
  inverted box (x0 > x1), so its collision band is 0.42 m wide instead of
  1.82 m. Measured with `resolvePoint` in #3002, #3003, #3006, #3009 and
  #3010: a body stops 5.16 m from the centre at a north or west wall, inside
  the wall's inner skin, against 4.46 m at a south or east one. A Haiku
  survey of build.js turned it up; it was then measured.
- **A lock number of 2 is a door no thief can pick.** are.js kept the D
  line's number raw, so a 2 read as `EX_CLOSED`. That made 96 exits wrong,
  and 18 of them, with no D reset, were shut for good without being doors:
  nothing could open them and build.js built no door there, so the page
  walked through where the rules refused. They are now read as db.c reads
  them: 472 doors, where 454 were.
- **A one-way stair is climbed both ways in the page.** #3002 down to
  #7026, #3029 down to #7043, and the pits #7022 and #7036 are one-way in
  the mud, but their flights are stairs. A step onto another level now
  takes an exit either way.
- **build.js builds no trapdoor.** There are 71 doors on ways up or down,
  and their resets shut 57 of them: the graveyard's tombs, hitower's
  trapdoors and vent. Over every one of them build.js stands a flight, a
  ladder or a shaft and nothing to shut it, so a body walks through while a
  typed `down` is refused. The old rule put a player on those stairs back.
  The judge now takes a stair whatever its door says (`stairBetween`), and
  the run with every door shut is how this showed up.
- **Falls are long, and fast at the end.** The deepest fall per zone:
  canyon 84.1 m (from the highest ledge down to the ground plane), olympus
  61.3 m, hitower and draconia 53.7 m. At player.js's 24 m/s² the last tenth
  of a second of 84 m is 6.4 m, past the 6 m that `MAX_CLIMB` allows in one
  report. A fall now has its own limit, `MAX_FALL` 70 m/s.
- **A flood with the judge in it needs the judge's room in its state, and
  that room must follow from the point.** Out in the open the judge first
  kept whichever room the walker came from. Every room that walked onto the
  grass then brought its own copy of the grass, and the flood ran out of
  memory. Now a point in the open counts as the nearest room, as game.js
  counts it: 4.3M states in the home zone.
- **Check the checker against the report.** With the old rule the flood
  refused in exactly the cell of the live log. On a local server, a page
  walking on the keys from #3052 south, east, north and west across the
  grass was put back 0 times, and the server's position stayed equal to the
  page's.

## 2026-10-09 — the title before the world

- **The title waited for everything.** It came up on the last line of
  `boot()`, after the bake, 283 models, the build, the mobiles and every
  shader. Measured on diku3d.com in headless Chromium on an M-series Mac:
  31.7 s to the title on a first visit, 17.7 s of it `precompile` (579
  programs: five light-pool levels times the materials), 9.0 s once the
  driver's shader cache is warm, 6.6 s on a repeat visit (3.5 s of it
  raising the town). A quit reloads the page, so it cost the 2.5 s verse
  plus the repeat visit. The title is now in the first paint (75 ms locally)
  and the world builds behind it; after a quit it is back as the page
  reloads.
- **A shader cache can outlive the browser profile.** A fresh Chromium
  profile compiled the same 579 programs in 0.9 s right after a cold run
  took 17.7 s: Metal keeps its own cache outside the profile. A first visit
  cannot be reproduced on a machine that has already compiled them once, so
  keep the cold number when you have it.
- **Hold the click, don't rebuild the wiring.** Everything that starts the
  game is wired late in `boot()`, against a game that does not exist while
  the title is up. `holdTitle` (title.js) puts capture listeners on those
  same elements first: before the world is ready they stop the event, bring
  the loading screen forward and replay the click on `release()`. Only the
  server form had to open early, so `createConnectUi` moved up and reads the
  game through `getGame()` when the form is sent.
- **Render a stand-in wide.** The still behind the early title is
  2560x1080 at the camera's own vertical fov, and `object-fit: cover` crops
  only its sides on any screen up to 2.37:1, which is exactly what the reel
  shows there, so the still and the first live frame match.
- **Input stays responsive behind the build.** Event Timing on clicks every
  200 ms while it ran: a median delay of 22 ms, worst 0.3 s, and 0.3–0.5 s
  in the switch from the still to the reel.

## 2026-10-04 — wave 14: hybrids, and streets that bend

- **Hybrids (wave14-hybrids):** a shared taur rig (centaurs ×14, lamias ×48),
  harpies ×37 (hopping gait; feathered to the collarbone — a bare female
  torso read as uncanny and was sent back), minotaurs ×30 as a fourth people
  file (`minotaur.glb`), golems ×16 with a BEASTS `surface` per prose
  material, goats, upright fire newts, centipedes. The bird `fly` clip beat
  fore and aft: spread wings need yaw-pitch-roll order. +11.3 MB. Extra clips
  in a people file need both `animalLife` and `buildPerson` to know them.
- **Curves (wave14-curves):** houses are prisms over four corners following
  a street-face function, party walls on the curve's normal (no sky wedges),
  UVs in each face's own plane, colliders as thin axis-aligned strips. Room
  middles stay pinned ±3.4 m (lamp, prose props, arrival). Lit windows take
  a `rot`. Turning cells: median sightline 4.7 → 3.6 m.
- **Rooms dressed by their own words:** `den` as a substring matched the
  area name "Miden'nir" (pickMaterials tests name + area) and gave 108 rooms
  the cave look; plains/tree-lined-lane prose now overrides a CITY sector,
  and a building's name builds a room. Cloud rooms and Miden'nir's mountain
  tunnels are still wrong.
- **Process:** a hung headless Chrome stalls an agent for 600 s; wrap every
  headless and Blender run in `timeout`. A git push of large assets once
  hung for 20 min and went through at once on retry.

## 2026-10-03 — wave 13: the town closes in, and the world beyond the gates

- **Layout (wave13-planar, Fable; wave13-reach):** `tools/planar-check.mjs`
  audits the embedding (fidelity 92.5% both walls, crossings from both
  sides, load-order identical). The street reach of 6 cells dated from the
  first commit and was never measured: at 12, Midgaard 93 → 97%, mean
  94.57 → 95.44%, wrong walls 177 → 73, no area drops, the squares and Main
  Street pixel-identical. Height does not close a horizontal residual (an
  up/down edge only adds y); it only buys free cells, and a longer street
  buys more. Miden'nir placed room by room moved 107 of Midgaard's rooms;
  laid whole (`LAID_WHOLE`) nothing moves, wrong walls 52.
- **Crossings (wave13-gates):** a gate stood free at the cell edge with a
  routed street behind it (non-Euclidean residual, not a layout bug), had no
  collider, and its portcullis grooves lay in the pier faces. Now an arch in
  a stone lodge between the street's houses, one collider, `crossingFrame()`
  and `built.crossings`; ghost bars 18 → 0, reachable backs 17 → 0. Read
  "which crossing am I at" from where the player stands, not `roomVnum`.
- **Vistas (wave13-vista):** 44 of 82 crossings show the neighbour's real
  rooms built by the same builder near the gate, outlines to 300 m;
  +0.15–0.55 ms. Every whole-area builder (frontage, sand, rock, grass) has
  to respect another zone's ground in both directions; rock must reach the
  ground or be dropped (92 floating pieces → 0).
- **#3001 (wave13-temple):** four faults made the steps unclimbable — no
  trigger at the doorway, no blocker at the landing's face, no step-down in
  player.js (43 airborne frames going down), PgUp skipping the steps.
  `tools/judge/headless/temple-walk.mjs` and `gate-walk.mjs` guard both.
- **Fauna:** pastimes and alarms per creature read from its own prose
  (`temperOf`); a location-keyed bone must be keyed in every clip.
- **Cozy Midgaard (wave13-cozy):** the "spacy" feel was the 194 routed cells
  between rooms, each 13 m of bare paving. Rows of narrow houses with jetties,
  steps and bends: median sightline in routed cells 19.0 → 9.5 m, open sky
  0.80 → 0.68; squares unchanged. `tools/judge/cozy.js` measures it. A piece
  sunk into a face draws a flicker line where they cross; one that only
  touches it cannot.
- **Sound:** a 200 Hz harmonic comb in four ambience beds was the "electric
  buzz" (temple 20 dB over its floor); `post.hum` notches it.

## 2026-10-03 — wave 12: other players, sound, and the last of build.js

### A server beside the page (wave12-server)

- `server/` (Node, `ws` 8.18.3 pinned with a lockfile) runs the same
  `game.js`, `src/rules/` and `magic.js` as the page. Merc's `char_list` is
  `game.players` plus `bind(pc)`: the bound player is Merc's `ch`, and the
  rules modules follow it through `k.onBind` because they capture `state`
  once at install. Standalone was proved unchanged by a seeded ten-minute
  trace (4 classes, fights, deaths, resets): byte-identical against main.
- Boot 0.22 s for 2,568 rooms / 1,856 mobiles / 34 zones; tick 1.2–1.5 ms
  with 3–4 players. Load (walking + talking): 1 player 0.88 KB/s and 3.9%
  of a core, 10 → 3.8 KB/s and 8.6%, 50 → 8.8 KB/s each (89% positions)
  and 18.3%.
- Clock-driven NPC strolls (`timedRand`) only partly agree across tabs:
  0.67 m apart after 15 s against 1.20 m for `Math.random`. Frame timing
  and local avoidance in `motion.js` cause the rest.
- Traps: events carry `fromCh`/`toCh` and are re-derived per reader, never
  null for someone else's blow; a string built inside `withPlayer` reads the
  new binding (the thief shouting "Boromir is a bloody thief!" was Boromir);
  removing the bound player mid-command breaks the command, so quit/deny are
  deferred; `serialize()` stamps `savedAt` and must be stripped before
  diffing; zones overlap in coordinates, the server offsets them by `SPAN`.
- PvP is Merc 2.1's `is_safe`/`check_killer`, except that ROOM_SAFE refuses
  it (2.1 only reads the flag for summon), marked DIVERGES.

### The server's second round (wave12-server2)

- Shops, gates and positions come from the server now (protocol 2: `shop`,
  `gates`, `at`). Position reports are judged against room cells, streets,
  open exits and speed (45 m/s, 30 m/s vertical, +3 m slack): 210 typed
  steps in a browser and 50 load-test walkers gave 0 refusals, after a fix —
  `layout.passageAt` keeps one street per cell, so two crossing streets read
  as an illegal jump (14 refusals in 60 steps). CPU for 50 walkers 21.3%
  against 20.8%.
- The temple mound's 1.2 m lift is replicated in `server/world.mjs` and must
  come off a report before its room is worked out.
- Notes, snoop, mset/oset/rset, ban/allow, wizlock, per-player resting,
  reconnect by token, player corpses, backstab on players. Left out: mload,
  switch/return (a mobile has no body of its own on the clients). Clicking
  a player twice within 4 s murders them: DIVERGES, pending the owner.

### Sound from ElevenLabs (wave12-audio, wave12-audio2)

- 112 clips, 14 MB of Opus/OGG: footsteps per surface, 23 ambience beds,
  12 music pieces, combat, doors, spells, 18 creature voices, positional
  fountains/hearths/forges, rain on roofs. 27.4k of 121,850 monthly credits
  (SFX ~11 credits/s, a 75 s piece ~1,030). Boot time unchanged: clips load
  lazily after the context exists.
- A browser keeps the AudioContext suspended until a gesture, and the
  gesture on the title is "enter", which ended the title music unheard; a
  "♪ music" button now appears only while the context is suspended. Headless
  Chromium and the devtools Chrome both autoplay, so neither reproduces it.
- Composition plans refuse `force_instrumental` (422): leave out `lines`.
  Music returns its own length with silent tails. Ambience carries a lot
  under 50 Hz: high-pass at 80 Hz before levelling. Soft footsteps come back
  as swishes, so cut steps on prominence relative to the clip, and continuous
  one-shot sheets on silence (`findRuns`). Decoded audio is float32: 50
  preloaded one-shots are ~50 MB mono, so the one-shots are mono.

### The Mud School's creatures (wave12-beasts)

- Lizard, rabbit, snail, beast and blob are new bodies (`creatures.py`);
  boar, fox/wolf and bear gained pastimes (root, sniff, haunch, snarl, howl,
  rear). Strides declared vs measured agree to <2% except the rabbit's run.
  +2.76 MB of models; the deer rebuilds byte-identical.
- Modelled animals indoors read RGB 0–5 against walls at 80–140: no light
  reached them at all. `beastlight.js` gives them the share of local light
  `dress.js` gives people; zero outdoors by day.
- Don't name an animal clip `sit` or `lean` — motion.js drives those for
  seating. The lizard's spine wave direction was measured, not reasoned:
  the reasoned one slipped 2.7 cm on the run.

### The last of build.js (wave12-polish)

- Temple Square corner: corner posts of `closeCorners` ran to CEIL+SLAB and
  shared a plane with a corridor ceiling strip; 106 → 0 px. Horizon lanes
  per style: far ties 314 → 8 px over 16 seam views, `Z.swim` 1.56% → 0.20%.
- `wall_door`: the tie was the architrave's foot in the plinth's face, not
  the threshold (50 mm proud). Read the sweep's `at`, not the report.
- The blue night thresholds were a cyan point light inside every portal
  arch since the first commit; noon drowned it.
- Moria's tunnels are FOREST+INDOORS: 565 trees underground → 0 with burrow
  words and "a canopy room must lead to open ground or forest". Trees under
  anything built: 158 → 0.
- Ways up/down (`tools/judge/headless/ways.mjs`, 504 exits): shown
  vertically 390 → 490, nothing 6 → 0, barred 19 → 0. Ladders and steps
  claim their stretch of wall and take the torches down.
- Raised open-air towns stand on hills (`buildHills`): six zones, earth
  where gentle, rock past 44°; rooms up in the air by their own words keep
  hanging.

## 2026-10-03 — wave 11: the hills, and every exit a door

### Every exit a doorway (wave11-exits)

- exit-check over 34 zones: wrong wall 385 → 157, doorless 73 → 0 (plus
  15 arches standing free → 8 in corners, all in The Void), one-way
  openings 36 → 40, all now barred. Mud School: 0 of each. Midgaard 93%,
  mean 94.567 (was 94.534), home zone 579 rooms, layouts deterministic;
  laying out home 21 → 76 ms.
- Causes: a stair took the first free wall west/east/north/south even when
  an exit named it (#3702's stair took the west wall and #3704 looked
  sealed); archways claimed a wall only at the end they were walked from;
  `routePath` took the first shortest route and the greedy pass gave walls
  in link order; the far end of a one-way street got an open doorway.
- Fixes: `allocate()` over five orders; streets re-laid at a cost (length
  +1 for a wrong wall, +3 for a wall another exit needs); archways claim
  both ends; up/down links without a wall are ladders (`sewer_ladder`) or
  shafts (`sewer_pit`) indoors; arches sit in a wall or corner with a dark
  threshold that follows the half-circle, two front faces (one double-sided
  plane was invisible to AO from one side), exposure-corrected, drifting.
- One-way gates open only for the camera; mobiles still walk through them.
- First round's arches stood free mid-room and showed the outdoors through
  an indoor arena wall; the coordinator sent it back. Look at both sides.
- rules-check (approved by the user): the janitor test now waits until he
  has stopped travelling and drops the bottle at a free spot in his room.
- Open: `wall_door`'s oak threshold is coplanar with its stone (the largest
  school flicker); Void rooms have grass stair flights hanging through
  them; Moria has a conifer in a tunnel and a tree through a cave ceiling.

### The flickering hills were GTAO (wave11-depth)

- The user's still matched #3053 at dusk. Depth ties beyond 150 m over 40
  views: 173 px in all (near 0.2: 133; 0.3: 117) — precision was never the
  story. Frame-to-frame change of far pixels while turning 2 px/frame
  (`Z.swim`): 33–49% with GTAO, 0.08–1.9% with the horizon out of the AO
  pass; near 1.0 left it at 30%. Cause: the horizon ring always contains
  the camera, so `AO_REACH` never excluded it; its up-facing strips read as
  occluded and the screen-fixed noise swam over them.
- Fix in `ScaledGTAOPass`: `horizon-*` hidden for the AO pass only.
  Draw calls −2..−6, triangles −7k..−22k (the temple interior had been
  drawing the horizon into AO too); the hills come out lighter and clean.
- Reversed-Z was not built; reading r185 it would need float depth on the
  composer targets, occlusion.js's depth copy reworked, and the decals'
  `polygonOffsetUnits` (not flipped by three) fixed by hand.
- Left for build.js: all horizon styles share `ridgeR`, so raised styles
  tie at area seams. A lane per style (town 0, forest 4, hills 8, desert
  12, marsh 16 m) measured 151 → 58 far tie px over six views.
- A cross-load frame diff is invalid once a merge changes boot-time
  `Math.random` use, even with the seeded harness: compare against main
  with the change reverted.

## 2026-10-03 — wave 10: bake beside the page

### Workers and a cache for the texture bake (wave10-bake)

- Boot on this Mac, home zone: ready 11.7–12.6 s → 6.2 s first visit, 5.0 s
  repeat; the bake 6.9–7.7 s → 1.1 s (8 workers; 4 gave 2.05 s, 12 gave
  0.88 s) → 0.12 s from cache. Longest main-thread task during boot 7.7 s
  → ≤ 0.24 s. Crossing school → home still ~4 s, but its longest task went
  2.7 s → 0.3 s. Cache: 65 MB deflated per channel, constant channels
  dropped, against 290 MB raw RGBA.
- `createMaterials` split into `bakeJobs` (98 bakes) / `runBake` (pixels
  only, the old functions unchanged) / assembly; without baked input it
  still bakes synchronously, so node tools keep working.
- Proof of sameness: 389 maps byte-identical (fresh vs fresh, worker vs
  main, cache vs fresh); every material's properties, defines, hook source,
  program key and texture bytes equal to main; composited frame 0 px at
  #3014, #3001, #7009, #3700 with randomness, time uniforms and torch
  flicker frozen. #6128 differs even against itself within one load.
- Traps: an IndexedDB miss waits behind other workers' write transactions
  (69 s of worker time for 9 s of baking); compressing in the same worker
  slows its next bake (1.6 vs 1.1 s); module workers have no import map.
- Open: `writing_7400` (wall text drawn on a main-thread canvas) is not
  identical between loads; grass `stats.ms` is now wall time.

### Exits against doorways (coordinator)

- `tools/exit-check.mjs`: over 34 zones, 5,324 exits — 385 open in another
  wall than their direction, 88 have no doorway at all (an archway link
  drawn at neither end; the compass step cuts through the wall), 36
  openings lead where the mud has only a one-way exit. The Mud School:
  8 doorless exits in four facing west/east pairs (#3702/#3704, #3712/#3714,
  #3743/#3744, #3748/#3752), #3705's north door in its east wall.

## 2026-10-03 — wave 9: every area, one zone at a time

### The flicker the user saw from the start (wave9-zfight)

- Z-fighting, from 13 separate causes, none of them depth precision:
  half-timber corner posts ending in the side wall's infill plane
  (`kit.py`), window surround sides running through head and sill
  (`actors.js`), indoor walls all spanning full width, two street blocks
  both filling a corner, Shire corridor roofs ending on the room's wall
  (the user's "painted board" at #1125 was the walkway's thatch gable),
  vault linings, sewer mouths and floors, dune rims, gatehouse parts, the
  bakery oven, gravel and grass patches. Each fixed by 2–20 mm (one 0.11 m)
  or by letting one piece own the joint; no polygonOffset.
- Home zone sweep (578 rooms × 4 headings × level/up): 829,498 → 38,292
  flicker px; median per room 180 → 18. User's spots: 12,585 → 158 and
  15,378 → 7. School, Arachnos and High Tower down 43–91%.
- The plain stone room kit asked for `corner` instead of `wall_corner`, so
  its corner pillars had never been placed; they are now (a visible
  change), and it still asks for `roof` instead of `wall_roof` (left alone).
- Remaining: #5022 fungus on the cave wall (4.2k px), wood-on-wood in
  benches, sewer tunnel undersides, the High Tower door frame, and a
  fountain reading ~5k px only in a full sweep (23 px from the same camera
  directly). A chimney block floats inside #1125.
- Regenerating some Blender modules changes models outside the work
  (`statue_worm`, palms, cushions, refuse heap): their committed `.glb` is
  out of date against its source.

### Zones (wave9-zones)

- All 44 areas in `area.lst` load at boot; 1,856 mobiles, 1,440 of them
  outside the drawn zone with a room and no position, moving room to room.
  Engine cost 0.23 ms/pulse in node against 0.13 for nine areas; 0.33 vs
  0.31 ms/frame in the browser. 34 zones: home (nine areas), Ofcol + New
  Ofcol together, every other area alone; 86 crossings, all checked by
  world-check to land in a placed room.
- `layoutWorld` gained `roots`: arrival rooms the zone's start cannot walk
  to (High Tower, Miden'nir, Moria, Redferne). Home layout unchanged room
  for room, Midgaard 93%, mean 94.6%.
- Crossing: home → school 0.9–1.1 s ready, school → home 3.7–4.0 s (build.js
  2.7 s of it). Five round trips: geometries/textures/programs flat, heap
  242 → 246 MB levelling off — after six leaks were found that had grown it
  ~190 MB per trip (AO mesh lists, spell auras, sanctuary records, ground
  decals, the title reel, grass shaders patched twice).
- Open: the sky area (all sector AIR, never built); crossings still drawn as
  the old barred gate (build.js should draw an open arch with the area
  name); `actors.js` label canvases are never released (~256 KB per mobile
  name); most new areas are dressed generically — Arachnos is stone
  corridors, the Chapel open streets, Moria has floating rocks.

### Jump and compass steps (coordinator)

- Every jump peaked at 0 cm: the frame that set the velocity still read as
  grounded by height, and the next frame zeroed it. Rising now never counts
  as standing.
- A compass glide was a straight lerp with no collision — 1.63 m deep
  through the Market Square plinth. It now asks nav.js's grid (held to the
  cells the line crosses) and grazes edges by ≤0.18 m.

## 2026-10-03 — wave 8: a recipe's env, made to count

### Sanctuary you can see from across the square (wave8-sanct)

- The old aura was a soft rim on the body's own edge: a sticker-thin
  outline that vanished on white clothing. Now a backface-only shell
  pushed out along the normals makes a white-gold mantle just outside the
  silhouette, a soft breathing pool of light on the ground (decal mode 8,
  strength tied to exposure: ~0.12 at noon, ~0.42 at night), rising motes,
  a swell on cast, a flare on an absorbed blow, a 1.6 s fade on expiry,
  and a breathing screen-edge tint in your own view. RGB ≥ 250 inside the
  figure box: 0–1 new pixels in every scene.
- **A halo has to widen with distance.** A fixed 8 cm is two pixels at
  20 m; 7 cm up to 24 cm, scaled down for small figures, and its intensity
  falls up to 60% with distance × darkness, or a night figure becomes a
  black cut-out in a white blob.
- **A backface shell draws over the body's own folds** (bright scribbles
  through the Mudmonster). The render targets have no stencil, so the
  shell's vertex stage pushes it 0.35 m back along the view ray: any shell
  in front of the body fails the depth test. Signed `n·v` keeps folded
  pieces from lighting up.
- The first ground ring had ticks and a hard double edge and read as an
  RTS selection marker: light on the ground has to look like light.
- `decal()` may steal any slot ≥ mode 3, so the ring checks ownership
  every frame. A fade-out cannot be measured with one `update(0.016)`;
  step the clock.

### A help screen (wave8-help)

- `?` and `F1` open `src/help.js`, a self-contained module with its own
  capture-phase keydown listener (it swallows keys while open, holds
  `state.paused`, re-locks through `player.requestLock()`). It touched no
  existing module, which is what let it run beside two other agents.
- The skill-bar rows are read from `game.actions()` at open time — the bar
  is built per class, and the first version's hand-written "kick, backstab,
  … in order" was wrong for every class.

### env on world materials (wave8-env)

- **The bug.** Under r185 every material without its own envMap has its
  `envMapIntensity` overwritten by `scene.environmentIntensity`, so every
  `env` in `textures.js` had been decoration since the upgrade — only
  dress.js honoured it. Fixed with a `dikuEnv` uniform applied to
  `radiance` in `decorate()`, and `honourEnv()` for everything decorate()
  does not reach (decals, `TAG_MATERIALS`, fountain water, window glass,
  the cloned `fur-sleek`, the held-weapon clone — whose ×0.7 had never
  applied because the clone lost the hook). Assigning `scene.environment`
  per material was rejected: it replaces the hour's intensity instead of
  composing with it, scales the diffuse sky too, and needs updating on
  every sky rebake.
- **A/B at birth, same frozen frame** (separate page loads drift ±4 luma
  from animation — the instrument is: freeze, read with every
  `envMapIntensity` forced to 1, read again): cobble 0→1.15 changes 49% of
  the 3014 noon frame by +5.4 luma; iron 1→1.4 +4.6 where seen; plaster
  0.7 / thatch 0.55 −0.5 (matte); wet cobble in rain 45% of the frame.
  Sewer 7009/7110: 0 px.
- **Relight.** Foliage, bark and duff had been written at 0.3–0.45 while
  the number did nothing; with it biting, the forest went blacker (RGB 0 at
  6128 dusk up), so they rose to 0.55–0.85 and the Douglas-fir furrow
  `0x160e0a` (0.6% albedo, darker than soot) to `0x26180f`. Net: sun share
  at noon 72.6 → 72.3%, town frames within ±0.7 luma, 6128 dusk RGB 0
  1.74 → 1.44%, graveyard RGB 0 0.037 → 0.011%, torsos unchanged against
  walls (≤0.8 sRGB step), draw calls/triangles/programs identical.
- **Wrapping an `onBeforeCompile` needs its own program key.** three's
  default key is the hook's source; every wrapped material would share the
  wrapper's source and one program.
- **`buriedTwin` must treat an `honourEnv`-only material as plain**, or it
  takes it for someone else's shader and the sky shows underground.
- Still open: forest RGB 0 at dusk (1.4%) is GTAO on sRGB-1 needles —
  0.00% with AO off. And underground noon-vs-night is **not** zero on main
  either (~95k px at 7009, bloom at 0, same before and after this change):
  the hour still reaches buried rooms by some path not yet found.
- `probe.js` `H.classify` throws on sprites (raycaster without a camera).

## 2026-09-28 — wave 7: below and inside

### Outdoor script time (wave7-cpu2)

- **V8 boxes a double passed to a function it doesn't inline.** Every sphere
  test passing four numbers allocated; hot tests now take `(array, offset)`.
  Graveyard allocation at the cap 79 → 34 MB/s.
- **One 26 m grid over all static instances and batch pieces** (~1,470
  cells) replaced 7,700 per-mesh buckets of ~2.5 instances each; standing
  still skips the sweep when nothing it depends on changed.
- **Draw order decides which coplanar surface wins.** Merging regions per
  zone would have cut graveyard calls 521 → ~457 but moved 350–1,800 pixels,
  with every cull decision identical; rejected by the zero-pixel rule.
- **A cull-order A/B must restore full instance buffers first** and clear
  each batch's `_seenStamp`, `_cullCamera` and `_indirectMine`, or stale
  state hides real differences.
- **Headless rAF runs at 120 Hz**; script per frame at the 30 fps cap is
  ~1.4× the uncapped figure — always say which was measured.
- Script time −25 to −45% outdoors (graveyard 9.4 → 7.0 ms at the cap,
  Market 8.9 → 5.8), frame interval p90 33.5 ms at the 30 fps cap, 0 pixels
  changed over 27 cameras. Left: ~70 program switches a frame where one
  material is drawn by batched, instanced and plain meshes.

### The Shire, stairs and the district's blood (wave7-fittings)

- **`timber` is a wall pattern, not a wood.** On a beam or post it shows a
  random crop of plaster and braces — white-and-brown barber poles on every
  stone doorway in Midgaard. Anything smaller than a wall is `oak`/`wood`.
- **grass.js grows blades on every upward grass surface not marked indoor**,
  so turf running over a room grew through Bag End's ceiling (`addTurf`
  splits and marks those triangles). It treats a surface as covering the
  lawn only above 8 mm: lay floors 12 mm up.
- **An outdoor roof built inside a walled-room loop inherits the indoor
  flag**; clear it for roofs and hills.
- **Every single-cell corridor between rooms is a 13 m shed** with walls on
  the cell edges; hills and roofs can't cover it, so Shire passages are
  narrowed to tunnels under turf or thatched walks.
- Indoor rooms without a trade drew from the outdoor clutter list — the
  cartwheel in the Shiriff Post, nettles on floorboards. They get a
  household list now.
- The Shire: thatch-and-turf roofs, round painted doors, round windows with
  flower boxes, smials as hills with stone faces, fenced gardens, the mill's
  wheel. No Man's Land has its watch fires lit at night.

### Every named noun (wave7-nouns)

- Noun coverage in the nine areas 346/386 → 369/386 (`tools/noun-check.mjs`
  with a placement dump from `tools/noun-probe.js`). The temple altar has
  its seated Odin, the firedeath its bed of fire, the entrance its faces.
- **A statue face needs its own ~5 mm grid**; at 14–16 mm, surface-following
  cuts narrower than a cell turn a face into a mask.
- **Carved strips must be laid on everything under them**; a beard strand
  extended past the beard found no surface and hung off the chest.
- **White marble against the temple's white walls vanishes at the far end
  of the hall**; the statue needed a dark cloth behind it.
- **The flame shader reads one scale per flame** — hearth fires have been
  1.9× high, not the 1.15× asked for.
- **The room lookup covers the whole 13 m cell**, forest outside the great
  tree included; an indoor camera spot must be within 4.2 m of the room's
  middle and visible from it.
- Furniture switches off past 32 m, so a focal piece seen down an axis is
  placed with the walls (`put(…, { far: true })`).

### Metals, bark and stone (wave7-materials)

- **three r185 overwrites `envMapIntensity` with `scene.environmentIntensity`
  on every draw for any material without its own envMap.** Every recipe's
  `env` has had no effect on world materials; only dress.js, which reads it
  into its own uniform, honours it. (Correcting the earlier line in this
  log.) Making it work would relight the whole world — a decision, not a fix.
- **A glTF model has no `aIndoor` flag**, so a sconce on a tavern wall
  reflected the open sky. Indoor placements get a copy of the geometry with
  the flag; "indoor" comes from the walls (`openAir`), not the mud's INDOORS
  flag, which covers ~44 Haon Dor forest rooms. Indoors, reflections lose
  the sky's hue entirely — a metal has no diffuse to hide it.
- **A height step of ~0.005 per texel already tilts a normal 45°.** The
  pumice walls and blue joint lines were the normal map (confirm with
  normal strength 0). Still steep: rooftile 77°, thatch 73°, mail 85°, rope
  75°, dirt/gravel 66°.
- **A creature's coat multiplies its recipe texture**; ooze averaged 0.37,
  so the Mudmonster came out at 3% albedo. Make such textures near-white.
- Bark tiles halved, normals halved, oak ridges 3 × 27 cm, plate ends
  staggered so trunks don't read as thatch.

### Spell source, stalled melee, the fountain (wave7-combat)

- **`game.js`'s player position is the eye; a mobile's is its feet.** Any
  reach to a mobile must subtract 1.72 m, or MELEE 3.2 is 2.7 along the
  ground — the bartender fight that stalled for 9 s with no events.
- **A hand-relative offset is rotated by the hand's quaternion before the
  camera's.** Check by projecting both points to the screen; the cast point
  sat ~100 px above the fist.
- **A curve's first control point decides where it heads first**; a
  sideways bow 0.6 m from the lens leaves the frame and comes back as a
  beam from the sky.
- **Pushing out of a box or circle towards its centre has no sideways
  component**; a round obstacle needs an explicit sidestep (`skirt()`), or
  held W stops dead at the fountain.
- Deterministic 60 Hz sequences: override `requestAnimationFrame` and
  `performance.now` in the page and set `quality.preset.fps = 0`.
  Sanctuary test: `tools/judge/sanctuary.js`.

## 2026-09-28 — wave 6: what the rooms say they are

### Main-thread CPU (wave6-cpu)

- **three r185 checks `object.colorTexture` for BatchedMesh, which does not
  exist** (it is `_colorsTexture`), so every batched draw without instance
  colours counted as a program change: ~160 `getProgram` calls a frame,
  31 ms/s and ~20 MB/s of garbage at the Market Square. A getter on
  `BatchedMesh.prototype` fixes it. Count program changes before blaming
  draw calls. three's opaque sort also ignores "batched"; `opaqueSort`
  adds it.
- **three recomputes the matrices of hidden subtrees.** ~15k of 17k scene
  nodes are bones of figures hidden past range — 64 ms/s. A hidden figure
  now holds its descendants until it is shown (`holdWhileHidden`).
- **Measure CPU per second of wall time, not per frame**: at 10 fps a frame
  costs about twice what it does at 30, because the processor is barely
  kept busy.
- **Freeze `performance.now`, `Math.random` and `Date.now` for pixel A/B**;
  otherwise some cameras differ by 5–80 px between two renders of one frame.
- Main-thread CPU −18 to −33% in every playing state (standing still at
  #3014 284 → 222 ms/s, walking 359 → 286). Remaining largest non-render
  cost: cull.js (~22 ms/s standing, ~40 walking) and occlusion.js.

### Impostors, occlusion and the stutter (wave6-perf)

- **The number of visible lights is part of every shader's key.** Toggling
  a pooled lamp's `visible` recompiled everything in view — a 517 ms first
  step at #5028. The light count now moves in steps (0/2/4/8/all), each
  compiled at load; keeping all lights on costs ~5 ms on grass.
- **`compileAsync` must run with the composer's render target bound**, or
  every program comes out in the wrong colour space and none is reused.
- **three's `readRenderTargetPixelsAsync` leaves its pixel-pack buffer
  bound while waiting**, and every other `readPixels` in that window fails
  silently. Use `occlusion.js`'s `readPixelsAsync`.
- **Leave a card's averaged normal unnormalised**; renormalised it lit 9%
  too bright.
- **p90 right after an idle pause is the GPU clocking up**: the first frame
  after 100 ms idle ran 22–41 ms against 9 steady. Discard ~20 frames.
- The sewer drew the forest overhead because the actors' trees weren't
  under the zone groups; #7201 1,008 → 244 calls. Far trees are cards baked
  at load from 8 bearings × 2 elevations, dithered 80–95 m (`?lod=off`);
  whatever a depth pyramid of the static world hides is skipped
  (`?occlusion=off`). Market 751 → 420 calls, 6.44 → 1.84 M tris; Haon Dor
  1,119 → 348, 13.4 → 3.5 M.

### Rendering correctness (wave6-renderfix)

- **Anything below ground must be dressed as buried, not only the sewer's
  recipes.** Marble, door leaves, items, props, furniture and figures were
  lit by the sky underground; 40 underground rooms differed noon-vs-night
  by 3.70 mean luma, now 0.13. `buriedTwin(material, { sunless })`.
- **Things that take no shadow get the sun through the rock** — door leaves
  and skinned bodies were lit by the noon sun 7 m down. `sunless: true`.
- **A thin line on the sky may be real geometry far away.** The "smoke
  line" was the #3120 chain. Hiding children under `surface` does nothing,
  because zone routing turns them back on each render; go one level down.
- **A glowing shell brightest inside its own outline draws a ghost copy.**
  Sanctuary sits 1.2 cm off the skin and lights only the silhouette edge.
- **Covered corridors met above-ground rooms with an open 0.8 m slot each
  side of the doorway** — the sky through the temple wall. `closeCorners`.
- Outdoor figures and the first-person hands get a night fill
  (`OUTDOOR_FILL = 1 - daylight`); a night cityguard 53% → 7% of pixels
  under luma 12.
- In probes, re-render with everything visible before a screenshot: with
  the loop halted the shot is the last frame drawn, maybe with things hid.

### What the rooms say they are (wave6-proseshell)

- **A cloned material keeps its maps but not its `defines` or
  `onBeforeCompile`.** A tinted stone door lost `DIKU_BURIED`, reflected the
  sky and came out white underground. Copy defines, shader hooks and
  `defaultAttributeValues` onto every clone.
- **Anything on a raised floor needs `platform.base` set to the level it
  rises from**, or nav marks it blocked and figures stay at level height;
  `wallNear`/`clearOf` must measure from the raised ground or leaning breaks
  (the temple leaner went 62/80 → 0 until they did).
- **Cracks drawn from Worley cell edges read as crazy paving**; threshold a
  smooth field at its middle for wandering hairlines.
- **Clutter hung in a rock cave sits on the lining's crowns (5 − 0.86 m).**
- `readShell` is asked of rooms only; a passage takes
  `pickMaterials(room, area, true)` or it inherits its end room's walls.
- The temple stands on a 1.2 m podium and not higher because the cull's eye
  sample sits at the level's base + 1.72 m. Boot +1.2 s (murals 168 ms,
  faces and blood ~70 ms, three new bakes ~250 ms).

### The first minute and the melee (wave6-playfix)

- **Clouds and haze must be scaled to the sky's brightness.** The noon sky
  is ~3 in linear units before tone mapping, so a white of 1.0 is a grey
  smudge; lighting a cloud by the sun makes it black against the light at
  dusk.
- **Floating text must be clamped against the panels**, not only kept apart
  from itself — pushing numbers upward to avoid overlaps is what walked them
  onto the minimap. Samples on a panel: 18 → 0; foe plates 75/135 → 0.
- **An empty-handed overhead chop reads as a held object**: the zombie's
  "bow" was its raised bare forearm. Unarmed figures use the low blow.
- **Scale body parts with uniform bone scales only**; a non-uniform parent
  scale shears its children as they rotate. After shortening legs, lower
  the body and shorten the stride by the same factor (halflings 1.06–1.11 m
  with their own proportions).
- Two judge findings were timing, not bugs: the "misplaced" fireball was
  still in flight, and the "faint" spells were still in their 0.62 s
  wind-up. Check a frame's time against the event before chasing it.
- Melee standoff 2.0 m from the camera, the shield held 70% to the side
  outside `block`; you start facing the first exit that leads outdoors.

### Nature and terrain (wave6-nature)

- **The height-to-normal bake is steep**: a height step of 0.04 already
  tips a normal past 45°, so a recessed bed joint turns the top of every
  course into an upward strip that catches and reflects the sky — the blue
  lines in the burnt district. Confirm with `normalScale = 0`.
- **A shader projection must include the instance matrix**; the existing
  surface-position value leaves it out, which is fine for mottling and
  wrong for projecting onto instanced rocks (`triplanar`).
- **Moss or a cap built as a second mesh always shows an edge.** Grow it in
  the shader from facing and noise (`moss` 0–1).
- **Geometry that should shade smooth must compute normals while still
  indexed and go in with `normals: true`**; the batcher unrolls the mesh.
- Burned is cold char; only prose that says the floor is hot keeps glowing.

### Set pieces from the prose (tools/blender/setpiece.py)

- **Blender's front is three's +Z.** The glTF exporter maps Blender −Y to
  three +Z, so kit.py's old comment ("front at −Y becomes three's −Z") was
  wrong; `FACE_ROT[d]` turns Blender +Y toward d. `localBox()` in build.js
  converts Blender-frame boxes to world colliders.
- **Seen from a fortress's gate, east is the viewer's left** (Blender −X);
  the "northeast" tower first went up on the west.
- **A raised drawbridge must be shorter than its arch**, or it hides the
  lowered portcullis the prose also asks for.
- **The albedo lift takes a raw 0x2f to ~0x59**, so a "black" stone needs
  block colours of 0x12–0x1f. Cellular ridge lines in a glossy material's
  colour or relief tile into a crackle net; keep them in roughness only.
- **The underground `caverock` renders as a dark slab in daylight**; outdoor
  reuse of cave pieces swaps it for `crag`.
- The Market Square statue is what its own description says it is: the
  Midgaard Worm coiled round the Palace of Midgaard.

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

### Grass, bark and leaves (src/grass.js, wave5-ground)

- **Camouflage came from bump detail, not colour.** The grass colour varied
  4%; a strong fine bump made 28% of lit variation. The forest floor had the
  same fault. Measure the rendered frame's variation, not the texture's.
  Close turf at #1128: 24.7% → 7.9%.
- **Alpha-tested textures need coverage-preserving mips**, or a meadow or a
  fir crown thins to nothing with distance. Every `cutout` recipe now gets
  them automatically.
- **Cut-out foliage in the AO pre-pass darkens itself** — a field of cards
  occludes itself, and under overcast that is most of the light. Grass
  supplies its own pre-pass material (`userData.aoMaterial`) that stays out.
- **Chevron bark came from projecting each trunk facet on its own slant**
  and a bark texture that didn't repeat vertically; trunks are 16-sided now
  with bark wrapped up them.
- **Distance hiding must only undo what it hid itself**, or it re-shows
  blocks the visibility cull hid behind walls.
- Blender: re-read mesh data after switching edit mode; a reference taken
  before pointed at the UV data. When sampling a big triangle cell by cell,
  don't count coverage twice.
- 512k clumps as one mesh per 24 m block, 1.5 s to build, +0.3–0.6 ms and
  ~+15 calls a frame; `diku.built.grass.still = true` for pixel diffs.

### Measured visibility (src/cull.js)

- **Visibility is measured, not declared.** For the camera's cell the solid
  world is rendered as distance cubes from 11 points; every sight line that
  leaves the cell unobstructed marks an opening, and outside things draw
  only through those openings. A shell with a gap in it only ever culls
  less, so nothing else has to cooperate. ~38 ms per cell, spread 1.5 ms a
  frame. 408-view sweep: 766 → 373 calls, 10.7 → 3.6 M triangles, 90 → 0
  views over 1,200; 136 composited-frame diffs 0 pixels apart from 1–4
  pixels through hairline sewer cracks.
- **A view-dependent cull must never drop shadow casters**: the shadow map
  is reused while you turn. three builds the main draw list before the
  shadow pass, which is what lets hidden objects be put back for it alone.
- **An instanced mesh's bounding sphere spans a whole 832 m region**, so
  three never frustum-culls it and it draws every instance into the shadow
  map; cull per instance.
- **The GPU here waits on draw calls, not triangles**: hiding all foliage in
  the heaviest forest view saved 0–2 ms of 15–17. No foliage LOD yet.
- Measure cubes against the cell and its neighbours only (32 → 8.8 M tris);
  they must see 40 m or they cut rays short and invent leaks. Disposing a
  geometry that shares buffers with a batch frees the batch's too. three
  picks winding per object, so mirrored instances need their own mesh.
- The #3005 archway was the "up" exit to "In the air…", which is never
  built; it is gone. Dusk bloom veiled half the bog because the whole sky
  quarter round a low sun was over threshold; the visible sky is capped
  below it at dawn and dusk except the disc and a thin ring.

### Figures that read indoors (dress.js, motion.js)

- **(Wrong on world materials under r185 — see wave 7.) A recipe's `env` scales the diffuse sky light as well as reflections**
  (three's `envMapIntensity` does both). Wool at 0.22 against the wall's
  0.72 gave a coat a third of the wall's light — indoors nearly all the
  light there is. People now take 0.75 of the sky like the walls; `env`
  only affects shine.
- **A colour multiplied over a texture averaging 0.56 comes out at half the
  albedo it was given.** Garments now average to the colour they're given.
- **A material without the indoor/underground treatment is lit by the sky
  wherever it stands** — underground at night, black. Figures share the
  walls' treatment through `SHARED_LIGHT`.
- **Separation pushes read as sliding.** Spend them on the body that is
  walking, never push backwards, stop a step before overlap. Barn: backward
  speed 0.6 → ≤0.08 m/s, turn rate capped at 150°/s.
- **An upward ray does not reliably find the roof it is under**: 525 of
  2,800 went through a sewer vault. Cap anything placed from one.
- Secretary torso vs wall 19/34 → 46/28; torsos under luma 8 at dusk
  54–99% → 0–10%. The "black band across the eyes" was a dark fringe
  hairstyle level all round at eye height.

### Props from the prose (src/clutter.js, tools/blender/clutter.py)

- **A doorway wall has no collider beyond its jambs**, so measuring outward
  from the room centre found the "wall" at 6.2 m. Clamp walled rooms to
  ROOM/2; the stone and temple kits' inner face raycasts at 5.13 m.
- **Gold at metalness 0.9 renders black in a dark lair**; a heap needs the
  less metallic `coin` material and a light of its own.
- **Props placed through build.js's `instances` above ground draw behind
  walls from the street** (+22 calls in the Market Square); route indoor
  props through the furniture batch, which switches off past 32 m.
- The vocabulary reads prose, extra descriptions and fixed objects, and its
  reject list is as long as its match list ("no …", "has been stolen",
  "entrance to the tomb", "well-paved", "chain mail", "your chest").
  `tools/clutter-check.mjs [--all | --kind X]`; `diku.built.stats.clutter`.
- Blender's vertex-colour trap struck again (every painting blank); colours
  go out as the `_col` attribute, as people.py does.

### Room shells by kind (src/shells.js)

- **three puts only a front-sided material's back faces in the shadow map**,
  so a 3 cm ledge on the inside of a stone-kit wall was "shaded" by the
  wall's own inner face — inside the shadow bias — and came out lit: the
  judge's white streaks along the mortar, and at dusk whole courses of the
  Park Cafe lit by the sun through a closed room. `shadowSide = DoubleSide`
  on every baked surface. Find such leaks by setting `sun.intensity = 0`.
- **A forest fir's crown reaches 3.6 m × its scale** (up to 2.6×), so a tree
  a whole cell away grew through the cabin's logs. Check planted trees
  against walled rooms' boxes, not cell edges.
- The shell is chosen from name and prose, never the sector (the sector
  lies — LEARNINGS' sewer round); rooms off Bag End inherit the smial shell
  through the door they share. `tools/shell-check.mjs [--table]`.
- New hooks: a surface generator may set `s.emit` and a recipe `glow` for
  an emissive map (the lair's glowing floor cracks); `Batcher.add(…,
  { keepUv: true })` for curved surfaces with their own UVs;
  `ceilingOf(room, cell, layout)`.

### Text that is never cut, and a title that shows the world (hud3)

- **Text typed out over time is laid out over time**, so every still and
  every layout measurement caught the room description half-written — the
  judge's "cut mid-word". Lay text out whole; animate only how it is shown
  (a CSS mask sweep that runs even with the render loop halted).
- **Combat events wait for their beat**, so after a teleport they appear in
  the wrong room. Clear the queue on a jump, and end a fight when the foe is
  beyond 14 m and neither in your room nor the next (`loseTouch`, Merc's
  stop_fighting without the penalty).
- **`nav.sightBlocked` tests collision boxes, not what is drawn**; to judge
  a framing, raycast `built.group`.
- **The judge's harness hides `#title` and unpauses by hand**; anything that
  runs during the title must stop itself then, or it pulls the camera away
  from every `goto()`.
- Floating combat text: 54 of 81 overlapping pairs over a 15 s fight → 0 of
  80, by moving each new number up until it touches nothing on screen.

### Rigs: grazing, skirts, giants, faces (wave4-rigs)

- **The beast rigs face −Y.** Face angles need `atan2(y.z, -y.y)`, and a
  positive turn about X tips the front down.
- **Neck skinning has to cover every joint.** A neck graded straight from
  chest to top bone folds at the joint it skips — that was why horses could
  not graze. `("chain", …)` weights in `beasts.Solid`.
- **A thigh-twin skirt bone must take over from the hips within ~12 cm below
  the hip joint**; lower, sitting drags cloth half into the seat.
- **Reposing a parent bone moves everything below it.** The troll's hunch
  tipped its feet 3.6 cm × scale into the floor; check foot flatness after
  any repose.
- **`_loft_scale` now refuses a descending table.** The female, wererat,
  mind-flayer and skull tables were top-down and built with one width all
  the way up — the female face had the chin's width to the crown.
- **Cloned textures start at version 0**, which three treats as nothing to
  upload; set `needsUpdate` on the clone.
- Where a planted foot cannot reach, the body dips to meet it rather than
  the foot sliding: every one of the 30 beasts now reports zero walk and run
  slip.

### Furniture by trade (tools/blender/furniture.py)

- **`bmesh … uv.verify()` names a new UV layer `Float2`, and `join()` keeps
  only layers matching the active part's names.** Every timber, prism and
  loft joined onto a box exported with its UVs at (0,0) — flat paint.
  `unwrap()` forces `UVMap`; check any new Blender module for UVs stuck at 0.
- **Frustum culling is not occlusion culling.** Indoor batches drew behind
  walls from the street (+116 calls in the Market Square) until pieces past
  32 m were switched off; instanced repeats of 16+ are never culled at all,
  one bounding sphere covering the whole town.
- **Stone-kit rooms' inner face is at 5.10 m, with buttresses 0.62 m proud
  at ±2.32–3.38 m along every wall** — the Boar's old hearth had one inside
  its fire. Raycast the walls before placing anything against them. The
  fitting frame's "along" axis runs against the world axis on the south and
  west walls.
- The trade comes from the shopkeeper first, the room name second; only
  taverns get tables, and the smithy gets a forge and anvil, not bottles.
  All 197 bench seats raycast at 45.5 cm, so life's seat fit is unchanged.

### Atmosphere: shade, conifers, moon, windows, horizons (wave4-atmos)

- **Outdoor shade was blue because nothing took the sky's colour out of it
  outdoors** — the diffuse sky term was pure open sky with no warm share
  from sunlit walls. Bleaching part of the hue (`setSkyBleach`, 0.55 at
  noon) is enough; lowering its strength is not. #2159 shade B/R 1.71 →
  1.15, reflections keep their blue.
- **A sun below the horizon is not a moon.** At −8° the night light came
  from under the world and no field got any of it. A moon 34° up: graveyard
  #3604 under-8 55% → 8.8%, forest 94.5% → 38.6%.
- **An unlit horizon colour still passes through exposure**; far slopes
  with a colour of their own need a radiance per hour or they are four
  times too bright at night.
- **The AO pre-pass override ignores alpha.** Hiding foliage from it is
  worse (a near bough takes the occlusion of what stands behind); give it
  an alpha-cut normal material with `allowOverride = false`. Text injected
  at `#include <common>` in MeshNormalMaterial's fragment shader is silently
  lost — inject after `uniform float opacity;`.
- **Glass on a solid wall must be opaque**, or the masonry shows through
  the "room behind it". A pane's own offset travels in its UVs, which
  survives batching and instancing; the shader recovers pane centre and a
  per-window seed from it. The day-to-lamp crossover must be gradual or
  every pane is a black room at dusk.
- Conifers: whorls of drooping boughs with folded alpha-cut needle cards
  whose normals point out of the crown, so the tree lights as one volume.
  +1.4–2.4 M triangles in forest and town views, +0.2–0.4 ms.

### Life: sitting, leaning, talking (motion.js)

- **Skinned vertices from `getVertexPosition` are wrong unless
  `skeleton.update()` runs first**; otherwise they use the last render's
  bone matrices.
- **A clip's intended seat height is not the dressed mesh's contact
  height.** The hip joint sits 5 cm above the seat but dressed thighs reach
  11 cm below it; measure the thighs. Sampling every other vertex misses
  armour plates (a knight 4.6 cm into the bench).
- **IK targets must start at the real feet** — the frame that sets up the
  transition is already running; otherwise both legs reach a metre towards
  the world origin on the first frame of sitting.
- **A walk weight that fades in behind the speed slides the planted foot by
  the missing share.** Drive walk/run weights directly from the speed.
- **`items.js` rewrites weapon visibility every frame**; anything else that
  hides a weapon needs its own flag (`stowed`).
- Measured: turning-in-place foot slide 0.35 → 0.00 m/s; seat error −1.9 to
  +0.7 cm over 26 body/seat combinations; figures doing something: Boar
  47% → 97%, Market Square 9% → 50%, 116 of 377 Green Dragon samples
  talking.

### Creatures, second pass (worm, troll, drider, fur)

- **Head shape tables must run in ascending height.** `heads._loft_scale`
  feeds them to `np.interp`, and a top-down table silently returns the last
  factor everywhere: the old troll head was 50% wider than intended. The
  female, wererat and mind-flayer tables are still top-down and were left
  alone so their faces don't move — fix them deliberately, not in passing.
- **Joining meshes fills a missing colour attribute with black.**
- **Bone heat on the troll is fragile**: moving its neck joint 1 cm left
  1,348 vertices unweighted; remesh specks break it too
  (`people.drop_islands`).
- **Transparent effect meshes need `layers.set(OVERLAY_LAYER)`** or the AO
  pass draws them as hard squares.
- **Unlit particles in the ground's own colour are dark smudges on sunlit
  sand**; light them with an upward normal.
- **`fbm` and `cellular` take one period for both axes**, so stretched
  noise that tiles needs separate wrapping per axis.
- Fur UVs now follow the lie of the hair; that, not more relief, is what
  stopped the wolves reading as grey clay.

### Draw calls, interiors and the district finished (wave3-polish)

- **Where the calls went:** one InstancedMesh per chunk per model per
  material — 2,784 world-wide, 962 holding a single copy. Regions of 64
  cells now get one multi-draw batch per material; anything repeated 16+
  times in a region stays instanced, because a batched multi-draw is still
  one GPU draw per piece (~0.5 µs each) and every tree batched cost 2.6 ms
  more than instanced. 16- and 32-cell regions were measured and slower.
- **three gives batched meshes no program variant of their own**, so they
  swap programs with plain meshes of the same material; opaque batches go
  first (`renderOrder = -1`).
- **The AO pass re-walked and re-searched the whole scene graph every
  frame** (3.3 + 2.2 ms of script at the barn). Both skipped now.
- **The shader's world-space mottling ignores instance and batch matrices**,
  so props shade in local space — merging props into world-space geometry
  changes their look.
- **Nothing lights shaded faces at dusk but a very weak sky**; a
  per-material ambient multiplier did nothing. Dark albedos take a per-hour
  lift (`materials.setShadeLift`, `lift: true`, `shadeLift` per time).
- **The blue marble indoors was the sky light's blue**, not the texture;
  indoors it keeps its strength and loses most of its blue.
- Measure with `diku.quality.setScale(3)` so the auto-scaler holds still.
- Results: barn 4,217 → 1,379 calls, 23.7 → 13.2 ms; Hector St 4,765 →
  1,511; graveyard 5,097 → 1,205; Market Square 14–18.6 → 9–11.3 ms. The
  rest is ~300 figure draws per pass and ~50 dropped items.

### HUD and melee feedback (game-ui.js, fx.js, main.js vantage)

- **The ways-out panel listed every gate seen all game**, which is how the
  West Gate showed at the East Gate. A gate counts only in its own room or
  its warden's; the old 18 m radius fired the executioner's line from the
  room next door.
- **Collision boxes do not cover everything you can see** — a temple column
  has none — so a camera's line of sight is ray-tested against the built
  world, and a sight line to a prop stops short of it (the fountain's box
  ends 1.7 m from its centre).
- **Headless timing tests can slow the game** by patching
  `performance.now` in the page; the render loop reads it.
- The shop signs were already modelled beside every shop door, blank; they
  carry the shop's own room name now, 21 signs on one texture, +3 calls.

### Faces and one draw per person (heads.py, hair.py, src/dress.js)

- **Blender 5.2's glTF vertex colour survives only in a mesh's first
  primitive.** Colours travel as the custom attribute `_COL` instead.
- **An offset of a loft or superellipse "distance" is not a real offset** —
  it put a wedge off the chin until the loft's outside distance was fixed.
- **Stepping along a tangent drifts off a convex surface**; hair locks are
  pulled back onto the head after every step.
- **`Material.clone` round-trips `userData` through JSON**, so arrays live
  in a closure, not on `userData`.
- **Skin normal strength 0.28 → 0.07, no world grain**: that alone ended the
  "clay head" read. Eyewhite roughness 0.14 so eyes catch a highlight.
- The build now fails if an arm enters the head in any clip
  (`rig.head_clearance`); the attack wind-up and the neck-rub idle were
  re-keyed against it.
- A person is one skinned mesh, one material: surfaces are layers of a
  texture array and colours a small uniform array. Market Square 454 → 380
  calls; 21 people in the barn cost 49 calls. A decimated copy past 15 m.

### Combat and crowds, second pass (motion.js, fx.js, game-ui.js)

- **A stopped animation action still reports its old weight.** Zero the
  weight before stopping it, or every probe sees ghost weights — which is
  how a corpse kept swinging (attack 1.0 beside death 1.0).
- **Space one attacker's blows at the source (`oneHit`)**, so the text,
  the death and the fall move with the blow. A click followed by a pulse
  put two blows 0.11 s apart and the second landed first.
- **Misses at level 1 are Merc's real numbers**: a level-1 warrior hits
  the cityguard 5.2% of the time. The rules stay; a miss now reads as one
  (the foe leans out, the blade follows through, "miss" on screen).
- **The sit pose's rotation signs are measured off each rig at runtime,**
  not assumed.
- **A board with six materials is six draw calls**; one material with the
  edge UVs pointed at a dark corner of the texture is one.
- Measured: barn overlap frames 61/120 → 5/120; standing still between
  blows 68% → 44%; Green Dragon patrons 0% → 34% seated.

### No Man's Land (hood.are, tools/blender/hood.py)

- **Two areas anchored off the same side of town fight over the same cells
  in a breadth-first layout.** Hood and the desert both leave eastward: 38
  of hood's 72 rooms had a desert room within two cells, and the desert's
  river caves ran through the district. Count other-area rooms within two
  cells of each area's rooms; `LAID_WHOLE` in layout.js lays such an area
  on its own and sets it down whole on free ground along its anchor. Wall
  Road becomes a 250 m street, which its prose supports.
- **A dark albedo must be checked after dusk.** Soot at 0.10 went to pure
  black in shade; find what is black by raycasting the pixels that read 0.
- **Distance culling needs an A/B by hiding and diffing pixels.** Hood
  cost 2,116 draw calls in the Market Square with nothing on screen; drawn
  within 180 m in 8×8-cell chunks it changes 0 pixels there.
- Gang territory comes from the prose, not the resets: the prose puts the
  Trolls north of No Man's Land and the resets put the ogres there.

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
- **A ribbon has to be capped in angle, not only in metres.** A 1 m glow
  half a metre from the lens covers the frame and reads as a flat pasted
  strip — the second judge's "flat camera-facing ribbon".
- **One broad soft glow sprite over a volumetric shape erases its surface.**
  The fireball read as a peach-coloured egg, and hid its target at night,
  until that sprite went; the point light does the lighting.
- **The runtime fbm noise is mostly mid-grey.** Stretch it around 0.5
  (×2.4–2.6) or every flame edge comes out as cotton wool.
- **A particle stream needs a hold phase, and spawns spread along one
  frame's travel**, or it dies before crossing the room and reads as beads.
- **Measure frame time with base and branch alternated, each against its
  own idle.** With other agents on the GPU idle moved from 7.4 to 12 ms.
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
