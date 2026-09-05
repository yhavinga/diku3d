# Learnings

What the rounds taught, round by round. CLAUDE.md keeps the curated traps —
the ones you must know before touching a file; this is the fuller log they
are promoted from, with the measurements that settled each one. Add to the
top, date the section, keep the numbers: a finding without its measurement
is an opinion.

## 2026-09-05 — the British Columbia rounds

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
