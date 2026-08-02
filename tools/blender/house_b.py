"""house_b -- the merchant's house. Three storeys, gable end to the street,
~9.9 m to the wall plate, and a jetty at every floor so the top oversails the
ground by a metre either side.

Read against house_a it is the same footprint turned ninety degrees: where a
has a long eaves line and a blank gable at the side, b puts the gable triangle
over the street, with a loading door and a hoist beam under the apex. That beam
sticking out over the pavement is the whole silhouette; everything else is
detail behind it.
"""

import math
import importlib

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

W = 11.9                        # top floor: the full cell frontage
J1, J2 = 0.55, 0.5              # the two oversails
F1W = W - 2 * J2                # first floor
GW = W - 2 * (J1 + J2)          # ground floor, set the furthest back
PLINTH = 0.3
GH, FH1, FH2 = 3.8, 2.8, 2.5
BAND = 0.28
T = 0.22
DOOR_W, DOOR_H = 3.2, 3.1
ROOF_H = 3.4                    # steeper than a; the gable is on show


def build():
    lib.reset()
    parts = []
    parts.append(kit.slab((GW + 0.4, GW + 0.4, PLINTH), (0, 0, PLINTH / 2),
                          mat="stonewall", name="plinth", width=0.05))

    # --- ground: a shop. Door to the left, counter opening to the right. ---
    gz = PLINTH
    shop = (2.5, 1.05, 3.0, 1.9)
    g_front = [(-2.6, 0, DOOR_W, DOOR_H), shop]
    parts += kit.shell(GW, GW, GH, T, gz, {"front": g_front})
    gf = kit.faces_of(GW, GW, T, gz)
    parts += kit.door(-2.6, DOOR_W, DOOR_H, gf["front"][1], 0.0, T, boards=4)
    parts += kit.window(*shop, gf["front"][1], 0.0, T, mullions=2)
    # The counter shutter, propped down over the street as an awning.
    parts.append(kit.timber((shop[2] + 0.3, 1.5, 0.1),
                            (shop[0], -GW / 2 - 0.66, gz + shop[1] - 0.06),
                            (math.radians(24), 0, 0), "planks", 0.03, "awning"))
    for sx in (-1, 1):
        parts.append(kit.timber((0.1, 0.1, gz + shop[1] - 0.06),
                                (shop[0] + sx * shop[2] * 0.44, -GW / 2 - 1.2,
                                 gz + shop[1] / 2 - 0.03), (0, 0, 0), "oak", 0.02, "prop"))

    door_gap = [(-DOOR_W / 2 - 2.85, DOOR_W / 2 - 2.35)]
    parts += kit.framing(GW, GH, T, gf["front"][1], 0.0, posts=4, rail=0.0,
                         skip=door_gap + [(0.9, 4.1)], sill_skip=door_gap)
    for key in ("left", "right"):
        parts += kit.framing(GW - 2 * T, GH, T, gf[key][1], gf[key][2], posts=2,
                             corner=False)
    parts += kit.framing(GW, GH, T, gf["back"][1], math.pi, posts=0, braces=False)

    # --- first floor ------------------------------------------------------
    parts += kit.jetty(GW, GW, gz + GH, J1, size=0.32, joists=3)
    f1z = gz + GH + BAND
    f1_front = [(-2.7, 0.7, 2.4, 1.7), (2.7, 0.7, 2.4, 1.7)]
    parts += kit.shell(F1W, F1W, FH1, T, f1z, {"front": f1_front})
    f1 = kit.faces_of(F1W, F1W, T, f1z)
    for (cx, oz, ow, oh) in f1_front:
        parts += kit.window(cx, oz, ow, oh, f1["front"][1], 0.0, T, mullions=1, shutters=True)
    parts += kit.framing(F1W, FH1, T, f1["front"][1], 0.0, posts=2, braces=False,
                         skip=[(-4.0, -1.4), (1.4, 4.0)])
    for key in ("left", "right"):
        parts += kit.framing(F1W - 2 * T, FH1, T, f1[key][1], f1[key][2], posts=2,
                             braces=False, corner=False)
    parts += kit.framing(F1W, FH1, T, f1["back"][1], math.pi, posts=0, braces=False)

    # --- second floor -----------------------------------------------------
    # No joists on this one: two full sets of them so close together turns the
    # whole flank into corduroy, and the bressumer alone reads as the oversail.
    parts += kit.jetty(F1W, F1W, f1z + FH1, J2, size=0.32, joists=0)
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
                         skip=[(-4.35, -1.65), (1.65, 4.35)])
    for key in ("left", "right"):
        parts += kit.framing(W - 2 * T, FH2, T, f2[key][1], f2[key][2], posts=1,
                             braces=False, corner=False, skip=[(-1.2, 1.2)])
    parts += kit.framing(W, FH2, T, f2["back"][1], math.pi, posts=0, braces=False)

    # --- roof, gable to the street ----------------------------------------
    rz = f2z + FH2
    parts += kit.gable_roof(W, W, ROOF_H, rz, eave=0.45, verge=0.45, along="y")
    parts += kit.gable_frame(W, ROOF_H, rz, -(W / 2 + 0.06), along="y")
    parts += kit.gable_frame(W, ROOF_H, rz, W / 2 + 0.06, along="y")

    # Loading door under the apex, and the hoist beam that hangs the block off.
    gable_face = (0, -W / 2 - 0.02, rz)
    parts += kit.window(0, 0.1, 1.7, 1.35, gable_face, 0.0, 0.2, glass=False,
                        mullions=0, shutters=True)
    parts.append(kit.timber((0.2, 2.3, 0.26), (0, -W / 2 - 0.75, rz + ROOF_H - 0.42),
                            (0, 0, 0), "oak", 0.03, "hoist"))
    parts.append(kit.timber((0.09, 0.09, 0.5), (0, -W / 2 - 1.65, rz + ROOF_H - 0.72),
                            (0, 0, 0), "iron", 0.02, "block"))

    parts += kit.chimney(-3.6, 2.4, rz - 1.8, rz + ROOF_H + 1.4, w=1.3, pots=2)
    return kit.deliver(parts, "house_b")
