"""house_a -- the low one. Two storeys, eaves to the street, ~7 m to the wall
plate. The plainest of the three: it is the house the other two are read
against, so it gets a wide unbroken front, a single jetty and a stone plinth.

The back wall is deliberately blind. These stand in a row filling a street
frontage, so the back is either against the next house or facing nothing, and
sixteen windows was where the triangle budget went the first time round.
"""

import math
import importlib

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

W = 11.9                # upper floor: the full cell frontage
JUT = 0.62              # how far the upper floor oversails
GW = W - 2 * JUT        # ground floor sits back behind it
PLINTH = 0.4
GH = 3.7                # ground storey: 3.1 of door plus a lintel
BAND = 0.3              # the jetty beam between the storeys
UH = 2.9
T = 0.22
DOOR_W, DOOR_H = 3.2, 3.1
ROOF_H = 3.0             # the flattest of the three, and it is still 27 degrees


def build():
    lib.reset()
    parts = []

    # A stone plinth so the timber never touches the mud. Solid: nothing sees in.
    parts.append(kit.slab((GW + 0.34, GW + 0.34, PLINTH), (0, 0, PLINTH / 2),
                          mat="stonewall", name="plinth", width=0.05))

    # --- ground storey ----------------------------------------------------
    gz = PLINTH
    g_front = [(0, 0, DOOR_W, DOOR_H), (-3.3, 1.2, 1.8, 1.5), (3.3, 1.2, 1.8, 1.5)]
    g_side = [(0, 1.25, 2.0, 1.5)]
    parts += kit.shell(GW, GW, GH, T, gz,
                       {"front": g_front, "left": g_side, "right": g_side})

    gf = kit.faces_of(GW, GW, T, gz)
    parts += kit.door(0, DOOR_W, DOOR_H, (gf["front"][1][0], gf["front"][1][1], gz),
                      0.0, T, boards=4)
    for (cx, oz, ow, oh) in g_front[1:]:
        parts += kit.window(cx, oz, ow, oh, gf["front"][1], 0.0, T, mullions=0, shutters=True)
    for key in ("left", "right"):
        parts += kit.window(0, 1.25, 2.0, 1.5, gf[key][1], gf[key][2], T, mullions=1)

    door_gap = [(-DOOR_W / 2 - 0.25, DOOR_W / 2 + 0.25)]
    parts += kit.framing(GW, GH, T, gf["front"][1], 0.0, posts=5, rail=2.9,
                         skip=door_gap + [(-4.3, -2.3), (2.3, 4.3)],
                         sill_skip=door_gap)
    for key in ("left", "right"):
        parts += kit.framing(GW - 2 * T, GH, T, gf[key][1], gf[key][2], posts=2, rail=2.9,
                             skip=[(-1.1, 1.1)], corner=False)
    parts += kit.framing(GW, GH, T, gf["back"][1], math.pi, posts=1, rail=0.0, braces=False)

    # --- the jetty --------------------------------------------------------
    parts += kit.jetty(GW, GW, gz + GH, JUT, size=0.34, joists=4)

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
                         skip=[(-4.85, -2.35), (-1.25, 1.25), (2.35, 4.85)])
    for key in ("left", "right"):
        parts += kit.framing(W - 2 * T, UH, T, uf[key][1], uf[key][2], posts=2,
                             skip=[(-1.2, 1.2)], corner=False)
    parts += kit.framing(W, UH, T, uf["back"][1], math.pi, posts=1, braces=False)

    # --- roof -------------------------------------------------------------
    rz = uz + UH
    parts += kit.gable_roof(W, W, ROOF_H, rz, eave=0.5, verge=0.4)
    # Proud of the tympanum, which the roof puts at +/-(W/2 - 0.13) x 0.26 deep.
    for sx in (-1, 1):
        parts += kit.gable_frame(W, ROOF_H, rz, sx * (W / 2 + 0.06))
    parts += kit.chimney(-4.1, 0.0, rz - 1.6, rz + ROOF_H + 1.5, w=1.4, pots=2)

    return kit.deliver(parts, "house_a")
