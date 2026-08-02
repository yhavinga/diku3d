"""house_a -- the low one. Two storeys, eaves to the street, ~7 m to the wall
plate. The plainest of the three: it is the house the other two are read
against, so it gets a wide unbroken front, a single deep jetty and a stone
plinth.

The back wall is deliberately blind. These stand in a row filling a street
frontage, so the back is either against the next house or facing nothing, and
sixteen windows was where the triangle budget went the first time round.

Everything here is now sized so that at a ten-degree sun there is a hard line
under the eaves, under every sill, beside every shutter and right across the
ground storey from the jetty. If you cannot see those four in a raking render,
the numbers below are wrong, not the lighting.
"""

import math
import importlib

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

W = 11.9                # upper floor: the full cell frontage
JUT = 0.85              # how far the upper floor oversails -- 0.62 cast nothing
GW = W - 2 * JUT        # ground floor sits back behind it
PLINTH = 0.55
GH = 3.5                # ground storey: 3.1 of door plus a lintel
BAND = 0.36             # the jetty zone between the storeys
UH = 2.9
T = 0.24
DOOR_W, DOOR_H = 3.2, 3.1
ROOF_H = 3.0             # the flattest of the three, and it is still 27 degrees
EAVE, VERGE = 0.62, 0.6


def build():
    lib.reset()
    parts = []

    # A stone plinth so the timber never touches the mud. Solid: nothing sees in.
    parts += kit.plinth(GW, GW, 0.0, PLINTH, proud=0.09)

    # --- ground storey ----------------------------------------------------
    gz = PLINTH
    g_front = [(0, 0, DOOR_W, DOOR_H), (-3.3, 1.25, 1.8, 1.5), (3.3, 1.25, 1.8, 1.5)]
    g_side = [(0, 1.3, 2.0, 1.5)]
    parts += kit.shell(GW, GW, GH, T, gz,
                       {"front": g_front, "left": g_side, "right": g_side})

    gf = kit.faces_of(GW, GW, T, gz)
    parts += kit.door(0, DOOR_W, DOOR_H, gf["front"][1], 0.0, T, boards=4, z0=0.0)
    for (cx, oz, ow, oh) in g_front[1:]:
        parts += kit.window(cx, oz, ow, oh, gf["front"][1], 0.0, T, mullions=0,
                            shutters=True)
    for key in ("left", "right"):
        parts += kit.window(0, 1.3, 2.0, 1.5, gf[key][1], gf[key][2], T, mullions=1)

    door_gap = [(-DOOR_W / 2 - 0.4, DOOR_W / 2 + 0.4)]
    parts += kit.framing(GW, GH, T, gf["front"][1], 0.0, posts=5, rail=2.85,
                         skip=door_gap + [(-4.5, -2.1), (2.1, 4.5)],
                         sill_skip=door_gap)
    for key in ("left", "right"):
        parts += kit.framing(GW - 2 * T, GH, T, gf[key][1], gf[key][2], posts=2, rail=2.85,
                             skip=[(-1.3, 1.3)], corner=False)
    parts += kit.framing(GW, GH, T, gf["back"][1], math.pi, posts=1, rail=0.0, braces=False)

    # --- the jetty --------------------------------------------------------
    # 0.85 m out, on braced corbels: the ground storey now stands in its shade
    # for most of the day, which is the single biggest tonal break on the house.
    parts += kit.jetty(GW, GW, gz + GH, JUT, size=0.34, joists=4, band=BAND, braces=3)

    # --- upper storey -----------------------------------------------------
    uz = gz + GH + BAND
    u_front = [(-3.6, 0.7, 2.3, 1.7), (0, 0.7, 2.3, 1.7), (3.6, 0.7, 2.3, 1.7)]
    u_side = [(0, 0.75, 2.2, 1.6)]
    parts += kit.shell(W, W, UH, T, uz,
                       {"front": u_front, "left": u_side, "right": u_side})
    uf = kit.faces_of(W, W, T, uz)
    for (cx, oz, ow, oh) in u_front:
        parts += kit.window(cx, oz, ow, oh, uf["front"][1], 0.0, T, mullions=1,
                            shutters=(cx != 0))
    for key in ("left", "right"):
        parts += kit.window(0, 0.75, 2.2, 1.6, uf[key][1], uf[key][2], T, mullions=1)

    parts += kit.framing(W, UH, T, uf["front"][1], 0.0, posts=4, rail=0.0, braces=False,
                         skip=[(-5.0, -2.2), (-1.4, 1.4), (2.2, 5.0)])
    for key in ("left", "right"):
        parts += kit.framing(W - 2 * T, UH, T, uf[key][1], uf[key][2], posts=2,
                             skip=[(-1.35, 1.35)], corner=False)
    parts += kit.framing(W, UH, T, uf["back"][1], math.pi, posts=1, braces=False)

    # Wall-plate moulding at the eaves line, so the top of the wall is a course
    # and not just where the boxes stop.
    parts += kit.string_course(W, W, uz + UH - 0.12, proud=0.075, height=0.2,
                               mat="oak", sides=("front", "left", "right"), mould=False)

    # --- roof -------------------------------------------------------------
    rz = uz + UH
    parts += kit.gable_roof(W, W, ROOF_H, rz, eave=EAVE, verge=VERGE, rafters=9,
                            caps=9, gutter=True)
    # Proud of the tympanum, which the roof puts at +/-(W/2 - 0.13) x 0.26 deep.
    for sx in (-1, 1):
        parts += kit.gable_frame(W, ROOF_H, rz, sx * (W / 2 + 0.06))
    parts += kit.chimney(-4.1, 0.0, rz - 1.6, rz + ROOF_H + 1.5, w=1.4, pots=2)

    # Somebody lives here: a lantern bracket by the door and a beam end left
    # sticking out of the jetty over it.
    parts += kit.bracket((0, -GW / 2 - T / 2, gz), 0.0, reach=0.78, z=3.15)
    parts += kit.beam_end((2.0, -W / 2 - T / 2, uz), 0.0, z=UH - 0.55, out=0.55)
    return kit.deliver(parts, "house_a")
