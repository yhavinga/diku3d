"""house_b -- the merchant's house. Three storeys, gable end to the street,
~10 m to the wall plate, and a jetty at every floor so the top oversails the
ground by well over a metre either side.

Read against house_a it is the same footprint turned ninety degrees: where a
has a long eaves line and a blank gable at the side, b puts the gable triangle
over the street, with a loading door and a hoist beam under the apex. That beam
sticking out over the pavement is the whole silhouette; everything else is
detail behind it.

Two jetties stacked is the reason this one is worth having: each throws its own
band of shade down the front, so at any sun angle the facade is cut into three
tonal strips before a single window is drawn.
"""

import math
import importlib

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

W = 11.9                        # top floor: the full cell frontage
J1, J2 = 0.72, 0.66             # the two oversails, both deep enough to cast
F1W = W - 2 * J2                # first floor
GW = W - 2 * (J1 + J2)          # ground floor, set the furthest back
PLINTH = 0.5
GH, FH1, FH2 = 3.6, 2.8, 2.5
BAND = 0.34
T = 0.24
DOOR_W, DOOR_H = 3.2, 3.1
ROOF_H = 3.4                    # steeper than a; the gable is on show


def build():
    lib.reset()
    parts = []
    parts += kit.plinth(GW, GW, 0.0, PLINTH, proud=0.09)

    # --- ground: a shop. Door to the left, counter opening to the right. ---
    gz = PLINTH
    shop = (2.2, 1.05, 3.0, 1.9)
    g_front = [(-2.4, 0, DOOR_W, DOOR_H), shop]
    parts += kit.shell(GW, GW, GH, T, gz, {"front": g_front})
    gf = kit.faces_of(GW, GW, T, gz)
    parts += kit.door(-2.4, DOOR_W, DOOR_H, gf["front"][1], 0.0, T, boards=4)
    parts += kit.window(*shop, gf["front"][1], 0.0, T, mullions=2, sill_out=0.24)
    # The counter shutter, propped down over the street as an awning. It is the
    # only thing on the ground storey that reaches out far enough to shade the
    # pavement, and the two props under it cast the pair of long thin shadows
    # that stop the shopfront reading as a printed rectangle.
    parts.append(kit.timber((shop[2] + 0.4, 1.6, 0.11),
                            (shop[0], -GW / 2 - 0.72, gz + shop[1] - 0.04),
                            (math.radians(24), 0, 0), "planks", 0.03, "awning"))
    for sx in (-1, 1):
        parts.append(kit.timber((0.11, 0.11, gz + shop[1] - 0.06),
                                (shop[0] + sx * shop[2] * 0.44, -GW / 2 - 1.3,
                                 gz + shop[1] / 2 - 0.03), (0, 0, 0), "oak", 0.02, "prop"))

    door_gap = [(-DOOR_W / 2 - 2.75, DOOR_W / 2 - 2.05)]
    parts += kit.framing(GW, GH, T, gf["front"][1], 0.0, posts=4, rail=0.0,
                         skip=door_gap + [(0.4, 4.0)], sill_skip=door_gap)
    for key in ("left", "right"):
        parts += kit.framing(GW - 2 * T, GH, T, gf[key][1], gf[key][2], posts=2,
                             corner=False)
    parts += kit.framing(GW, GH, T, gf["back"][1], math.pi, posts=0, braces=False)

    # --- first floor ------------------------------------------------------
    parts += kit.jetty(GW, GW, gz + GH, J1, size=0.32, joists=2, band=BAND,
                       braces=(-3.4, 0.0, 3.4))
    f1z = gz + GH + BAND
    f1_front = [(-2.7, 0.7, 2.4, 1.7), (2.7, 0.7, 2.4, 1.7)]
    parts += kit.shell(F1W, F1W, FH1, T, f1z, {"front": f1_front})
    f1 = kit.faces_of(F1W, F1W, T, f1z)
    for (cx, oz, ow, oh) in f1_front:
        parts += kit.window(cx, oz, ow, oh, f1["front"][1], 0.0, T, mullions=1, shutters=True)
    parts += kit.framing(F1W, FH1, T, f1["front"][1], 0.0, posts=2, braces=False,
                         skip=[(-4.2, -1.2), (1.2, 4.2)])
    for key in ("left", "right"):
        parts += kit.framing(F1W - 2 * T, FH1, T, f1[key][1], f1[key][2], posts=2,
                             braces=False, corner=False)
    parts += kit.framing(F1W, FH1, T, f1["back"][1], math.pi, posts=0, braces=False)

    # --- second floor -----------------------------------------------------
    parts += kit.jetty(F1W, F1W, f1z + FH1, J2, size=0.32, joists=2, band=BAND,
                       braces=(-4.0, 0.0, 4.0))
    f2z = f1z + FH1 + BAND
    f2_front = [(-3.0, 0.6, 2.5, 1.6), (3.0, 0.6, 2.5, 1.6)]
    f2_side = [(0, 0.65, 2.2, 1.5)]
    parts += kit.shell(W, W, FH2, T, f2z,
                       {"front": f2_front, "left": f2_side, "right": f2_side})
    f2 = kit.faces_of(W, W, T, f2z)
    for (cx, oz, ow, oh) in f2_front:
        parts += kit.window(cx, oz, ow, oh, f2["front"][1], 0.0, T, mullions=1)
    for key in ("left", "right"):
        parts += kit.window(0, 0.65, 2.2, 1.5, f2[key][1], f2[key][2], T, mullions=0)
    parts += kit.framing(W, FH2, T, f2["front"][1], 0.0, posts=3, braces=False,
                         skip=[(-4.55, -1.45), (1.45, 4.55)])
    for key in ("left", "right"):
        parts += kit.framing(W - 2 * T, FH2, T, f2[key][1], f2[key][2], posts=1,
                             braces=False, corner=False, skip=[(-1.35, 1.35)])
    parts += kit.framing(W, FH2, T, f2["back"][1], math.pi, posts=0, braces=False)

    # --- roof, gable to the street ----------------------------------------
    rz = f2z + FH2
    # Wall plate moulding at the gable spring: the third floor line, and the
    # thing that stops the gable triangle floating off the wall below it.
    parts += kit.string_course(W, W, rz - 0.14, proud=0.15, height=0.22, mat="oak",
                               sides=("front", "left", "right"), mould=False)
    parts += kit.gable_roof(W, W, ROOF_H, rz, eave=0.6, verge=0.62, along="y",
                            rafters=7, caps=6)
    parts += kit.gable_frame(W, ROOF_H, rz, -(W / 2 + 0.06), along="y")
    parts += kit.gable_frame(W, ROOF_H, rz, W / 2 + 0.06, along="y")

    # Loading door under the apex, and the hoist beam that hangs the block off.
    gable_face = (0, -W / 2 - 0.02, rz)
    parts += kit.window(0, 0.1, 1.7, 1.35, gable_face, 0.0, 0.24, glass=False,
                        mullions=0, shutters=True)
    parts.append(kit.timber((0.22, 2.6, 0.28), (0, -W / 2 - 0.95, rz + ROOF_H - 0.42),
                            (0, 0, 0), "oak", 0.03, "hoist"))
    parts.append(kit.timber((0.14, 0.7, 0.14), (0, -W / 2 - 0.5, rz + ROOF_H - 0.9),
                            (math.radians(-40), 0, 0), "oak", 0.025, "hoist_stay"))
    parts.append(kit.timber((0.09, 0.09, 0.5), (0, -W / 2 - 1.95, rz + ROOF_H - 0.72),
                            (0, 0, 0), "iron", 0.02, "block"))

    parts += kit.chimney(-3.6, 2.4, rz - 1.8, rz + ROOF_H + 1.4, w=1.3, pots=2)

    # Somebody works here: the shop's trade sign bracket, over the counter.
    parts += kit.bracket((3.0, -F1W / 2, f1z), 0.0, reach=0.9, z=2.05)
    return kit.deliver(parts, "house_b")
