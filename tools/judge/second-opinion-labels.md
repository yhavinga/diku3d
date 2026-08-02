# Black name-label rectangles — second opinion (tested)

three.js r185, WebGL2, CanvasTexture Sprite labels.
Tested in Chrome via WebGL2 + gl.generateMipmap + textureLod + full-UV
sprite minification (chrome-devtools MCP re-run confirmed numbers).

## Executive verdict

The diagnosis as written is **overstated / partly wrong**.

- Non-premultiplied mip averaging of RGB and A independently: **true**.
- “Two or three mips down the whole quad is ~uniform black at moderate alpha”
  and that is the solid black rectangle: **false** (measured).
- Disabling mipmaps is still a **reasonable** label default, but it is **not**
  the smoking-gun fix for a solid black card of that shape.
- The setup that *does* produce a solid black rectangle is a **semi-opaque dark
  plate** behind the text (and tone-mapping of near-black UI), which the code
  already removed.

---

## 1. Is the diagnosis correct?

**No, not in the strong form that explains the solid black rectangle.**

What is correct:
- Labels are CanvasTexture sprites, non-premultiplied upload.
- glGenerateMipmap averages R, G, B, A independently.
- A black halo injects black into filtered RGB.
- Close-ups sample level 0 and look fine; minification uses higher mips.

What is wrong:
- Independent averaging **preserves the global mean of each channel**. It
  cannot turn a mostly-transparent label atlas into a whole-quad ~40% opaque
  black matte.
- Measured for `"the baker"` on a tight PoT canvas like actors.js (256×128,
  ~20% ink with a>20):

    L0 mean RGBA ≈ (15.4, 14.5, 13.1, a30.2)
    L3 mean RGBA ≈ (15.4, 14.6, 13.1, a30.3)
    1×1 mean RGBA ≈ (16, 15, 14, a31)

  Whole-quad alpha stays ~12%, not ~40%. The 1×1 is a faint dark veil, not a
  solid black plate.
- WebGL full-UV sprite at small sizes: mips ON is only mildly darker than mips
  OFF (ΔR vs bg ~12 vs ~7 at 32×8), and **fewer** very-dark pixels (halo spikes
  get softened). That is a soft grey film, not a solid black bar.
- Claim “whole quad ~uniform black @ ~40% alpha at L2–4”: **REJECTED**.
- Claim “mips ON much darker than OFF → black card”: **WEAK/REJECTED**.

What actually matches “solid black rectangle above heads”:
- Old dark plate `rgba(12,10,8,0.72)` behind the text, same harness:
  at 64×16 with mips ON: mean RGB ≈ (141,126,97), dark% ≈ 27%, veryDark% ≈ 18%,
  ΔR vs warm ground ≈ 39. That shape holds with or without mips.
- ACES / tone mapping of near-black semi-opaque UI can make dark glass look
  like a hole (separate known bug class in this project).

So: the *mechanism sketch* (non-premul + black ink + mips) is real for
**muddying** text; it is **not** the proven cause of the solid black rectangle
reported four times.

---

## 2. Non-premultiplied mipmap averaging — detail

### Is the independent-channel argument right?

**Yes.** glGenerateMipmap (and a software 2×2 box filter) averages R, G, B, A
separately when data is non-premultiplied.

### Walk-through: (0,0,0,0) with (243,230,207,255)

Simple 50/50 (illustrative; real is 2×2):

  R = (0+243)/2 = 121.5
  G = (0+230)/2 = 115
  B = (0+207)/2 = 103.5
  A = (0+255)/2 = 127.5

→ muddy cream-grey at ~50% alpha locally — not pure black.

### After NormalBlending over a lit background

  out = src.rgb * src.a + dst * (1 - src.a)

A mid-mip local blotch of dark RGB + mid alpha darkens the background (smoky
smudge). A whole-quad mean of ~a30 and RGB~15 only darkens warm ground
(180,160,120) by a few percent → soft veil, not a card.

### Does the black halo make it materially worse than plain AA cream?

**Yes for local muddiness; no for “whole-quad black plate.”**

Measured textureLod composites (full UV, NormalBlending, warm bg):

  halo lod0 ΔR≈6.4   → lod6 ΔR≈19.2  (still soft)
  plain lod0 ΔR≈-2.9 → lod6 ΔR≈10.0  (cream stays brighter)

Halo is darker/muddier. Plain never hits “dark%” thresholds. Neither becomes a
solid black rectangle covering the sprite.

Also: because means are conserved, spreading ink via mips **lowers maxA** and
**does not raise whole-quad alpha**. “Black rect” texel fraction in the raw
mip chain for the baker label **falls** as mips go down (7% → ~0%), while a
“murky” mid-band can grow locally before maxA collapses.

---

## 3. Is disabling mipmaps the right fix? Premultiply?

**Disabling mipmaps is a good label default, not the fix for the solid bar.**

Recommended (and already in actors.js):

  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;

Why still do it:
- Labels hide past ~10 m and are at most a couple of hundred px wide.
- No real need for a mip ladder; saves VRAM/work.
- Avoids muddy high-LOD text (unreadability), even though that is not a solid
  black card.

Why it is **not** “the” black-rectangle fix:
- Measured: mips ON vs OFF does not create the solid-card symptom.
- The plate (removed) does.

### Premultiply instead?

Correct general theory for filtered alpha textures, overkill for short-range
name sprites.

If you premultiply on the canvas (rgb *= a/255) after drawing:

  texture.premultiplyAlpha = true;

and for correct compositing typically:

  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  // transparent: true

In r185, SpriteMaterial defaults to NormalBlending / non-premul assumptions;
there is no “set premultiplyAlpha and walk away” that fixes filtering *and*
blending without matching the blend equation.

Trade-offs:

  Mips off + LinearFilter
    Correct enough for labels at your sizes; cheaper; almost no risk under 10 m.

  Premultiply + correct blend + keep mips
    Correct AA filtering of coverage; more moving parts; wrong blend → double-
    dark edges or fringes; not needed for name tags.

  Keep mips, no premultiply
    Muddy distant text; still not a solid black plate by measurement.

**Verdict:** ship mips-off for labels. Do not treat premultiply as required to
kill a black rectangle that the plate already explained.

---

## 4. Coloured transparent RGB (text colour at alpha 0)?

**Does not fix the halo case. Not better than disabling mips as the primary
label policy.**

Measured: `colourclear` (α=0 texels filled with cream RGB) produced **identical**
render stats to the normal halo path at small sizes. The black halo dominates
the dark content in the mip neighborhood; recolouring empty texels does not
remove black high-alpha ink.

It can help *plain* cream-on-transparent atlases that keep mips (avoids pulling
RGB toward zero from empty space). For this halo setup it is a no-op.

Worse as a primary fix than mips-off: partial, easy to forget on redraw, and
does not address black stroke ink.

---

## 5. Other footguns in this setup

### colorSpace = SRGBColorSpace on CanvasTexture
Not the black-rectangle cause. Canvas is authored sRGB. With toneMapped:false
UI cream, some pipelines leave NoColorSpace so painted values stay as-is;
sRGB linearization + no tonemap can make cream look slightly dull. Aesthetic,
not a black card.

### Anisotropy with mipmaps off
No-op for filtering intent. Harmless; set 1 or leave 4.

### toneMapped:false over ACES
Correct for nameplates so cream stays readable day/night. Labels can look
slightly “pasted on.” Do **not** put a dark translucent plate behind text if
that plate is tone-mapped — ACES turns low sRGB “dark glass” into near-black
(this project’s other black-rectangle story).

### NPOT vs POT (WebGL2)
WebGL2 handles NPOT. Tight PoT sizing in actors.js is fine; not a bug source.

### Other
- depthWrite:false: correct; watch transparent sort in crowds.
- sizeAttenuation + hide-at-10 m: no need for mips.
- Re-apply generateMipmaps/minFilter on every new CanvasTexture.
- Contact-shadow DataTexture still uses mips (unrelated; fine).

---

## Measured summary (chrome-devtools re-run)

Canvas `"the baker"` 256×128, ink(a>20)≈19.9%

  L0  mean RGBA (15.4, 14.5, 13.1, a30.2)
  L3  mean RGBA (15.4, 14.6, 13.1, a30.3)  blackRect%≈1.6%
  1×1 mean RGBA (16, 15, 14, a31)

WebGL full-UV NormalBlending over (180,160,120):

  64×16 mips ON:  mean≈(170,152,115) dark%≈1.1  ΔR≈10.3
  64×16 mips OFF: mean≈(175,156,120) dark%≈5.6  ΔR≈5.3
  32×8  mips ON:  mean≈(168,150,113) dark%≈0    ΔR≈12.3
  32×8  mips OFF: mean≈(173,155,118) dark%≈5.9  ΔR≈7.1

Old plate+halo 64×16 mips ON:

  mean≈(141,126,97) dark%≈27.4 veryDark%≈18.5 ΔR≈38.7  ← solid dark card

textureLod halo (full UV): lod0 ΔR≈6.4 … lod6 ΔR≈19.2 (veil, not plate)

---

## Direct answers (checklist)

1. Diagnosis of solid black rect from non-premul mips: **incorrect as stated**.
   Real solid-card cause in this stack: dark plate / near-black tone-mapped UI.
   Mips + black halo: muddy distant text only.

2. Independent-channel averaging: **yes**. Whole-quad means conserved. Halo
   worse than plain cream for muddiness; not a 40% black full-quad matte.

3. Mips off + LinearFilter: **right default for labels**, not the black-rect
   smoking gun. Premultiply is optional general correctness, not required here.

4. Coloured α=0 RGB: **does not fix halo labels**; worse primary strategy than
   mips-off.

5. colorSpace / anisotropy / toneMapped / NPOT: not this black-rect bug; watch
   tone-mapped dark plates and sRGB-vs-untonemapped cream for look.

## Bottom line

You were right that non-premul CanvasTexture mips are a footgun for alpha
text, and that mips-off is good hygiene for name labels. You were **wrong**
that that path produces the solid black rectangle over heads after a few mip
levels. Measurement rejects that claim. Keep mips off; do not overfit the
comment to a plate-shaped bug the plate already caused.
