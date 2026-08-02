"""house_c -- the tall one. Four storeys, 12 m to the wall plate, and the only
one of the three that starts in stone: a masonry ground floor with a string
course, three timber floors jettied out over it, and a gable roof over four
storeys of banding.

What keeps it from reading as house_a stretched is the material break at the
string course -- stone below, timber above -- and the oriel: a bay hung off the
first floor on two corbels, projecting out over the street. A jerkinhead was
tried for the roof and thrown away; hipping the top of a gable properly means
cutting the main planes back, and faking it read as two flaps nailed on.
"""

import math
import importlib

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

W = 11.9
J1, J2 = 0.4, 0.35
F1W = W - 2 * J2
GW = F1W - 2 * J1
GH, FH1, FH2, FH3 = 4.0, 2.7, 2.6, 2.15
BAND = 0.28
T = 0.24
DOOR_W, DOOR_H = 3.2, 3.1
ROOF_H = 3.5


def oriel(z0, cx=0.0, w=3.0, h=2.0, out=0.72, wall_y=0.0):
    """A bay window hung off the wall face. Two corbels under it, a pent roof
    over it, and the only window on the house you can lean out of."""
    y = wall_y - out / 2
    objs = []
    # cheek walls and soffit
    for sx in (-1, 1):
        objs.append(lib.box((0.16, out, h), (cx + sx * (w / 2 - 0.08), y, z0 + h / 2),
                            name="oriel_cheek", mat="timber"))
    objs.append(lib.box((w, out, 0.18), (cx, y, z0 - 0.09), name="oriel_soffit", mat="timber"))
    front = (cx, wall_y - out, z0)
    objs += kit.panel(w, h, 0.16, [(0, 0.35, w - 0.7, h - 0.75)], "timber", front, 0.0, "oriel_face")
    objs += kit.window(0, 0.35, w - 0.7, h - 0.75, front, 0.0, 0.16, mullions=2, sill_out=0.2)
    # pent roof and the corbels that carry the whole thing
    objs.append(kit.timber((w + 0.4, out + 0.34, 0.16), (cx, y - 0.1, z0 + h + 0.14),
                           (math.radians(-22), 0, 0), "rooftile", 0.04, "oriel_roof"))
    for sx in (-1, 1):
        objs.append(kit.timber((0.22, out + 0.2, 0.72),
                               (cx + sx * (w / 2 - 0.16), y - 0.06, z0 - 0.5),
                               (math.radians(38), 0, 0), "oak", 0.03, "corbel"))
    return objs


def build():
    lib.reset()
    parts = []

    # --- masonry ground floor --------------------------------------------
    g_front = [(0, 0, DOOR_W, DOOR_H), (-3.6, 1.3, 1.7, 1.6), (3.6, 1.3, 1.7, 1.6)]
    g_side = [(0, 1.4, 1.8, 1.5)]
    parts += kit.shell(GW, GW, GH, T, 0.0, {"front": g_front, "left": g_side},
                       mat="stonewall", name="stone")
    gf = kit.faces_of(GW, GW, T, 0.0)
    parts.append(kit.slab((GW + 0.42, GW + 0.42, 0.42), (0, 0, 0.21), mat="stonewall",
                          name="plinth", width=0.06))
    parts += kit.door(0, DOOR_W, DOOR_H, gf["front"][1], 0.0, T, frame="stonewall",
                      boards=4, arch=True)
    for (cx, oz, ow, oh) in g_front[1:]:
        parts += kit.window(cx, oz, ow, oh, gf["front"][1], 0.0, T, mat="stonewall",
                            mullions=0, sill_out=0.2)
    parts += kit.window(0, 1.4, 1.8, 1.5, gf["left"][1], gf["left"][2], T,
                        mat="stonewall", mullions=0, sill_out=0.2)
    # string course: the line the timber sits on, carried right round
    for (span, loc, rot) in ((GW + 0.5, (0, -GW / 2 - 0.13, GH - 0.16), 0.0),
                             (GW + 0.5, (-GW / 2 - 0.13, 0, GH - 0.16), math.pi / 2),
                             (GW + 0.5, (GW / 2 + 0.13, 0, GH - 0.16), math.pi / 2)):
        parts.append(kit.timber((span, 0.3, 0.28), loc, (0, 0, rot), "stonewall", 0.05, "course"))

    # --- first floor, with the oriel --------------------------------------
    parts += kit.jetty(GW, GW, GH, J1, size=0.32, joists=3)
    f1z = GH + BAND
    f1_front = [(-3.9, 0.65, 1.9, 1.6), (3.9, 0.65, 1.9, 1.6)]
    parts += kit.shell(F1W, F1W, FH1, T, f1z, {"front": f1_front})
    f1 = kit.faces_of(F1W, F1W, T, f1z)
    for (cx, oz, ow, oh) in f1_front:
        parts += kit.window(cx, oz, ow, oh, f1["front"][1], 0.0, T, mullions=1, shutters=True)
    parts += oriel(f1z + 0.55, 0.0, 3.2, 1.85, 0.72, -F1W / 2 + T / 2)
    parts += kit.framing(F1W, FH1, T, f1["front"][1], 0.0, posts=2, braces=False,
                         skip=[(-5.0, -2.8), (-1.9, 1.9), (2.8, 5.0)])
    for key in ("left", "right"):
        parts += kit.framing(F1W - 2 * T, FH1, T, f1[key][1], f1[key][2], posts=1,
                             braces=False, corner=False)

    # --- second floor ------------------------------------------------------
    parts += kit.jetty(F1W, F1W, f1z + FH1, J2, size=0.32, joists=0)
    f2z = f1z + FH1 + BAND
    f2_front = [(-3.9, 0.6, 2.1, 1.6), (0, 0.6, 2.1, 1.6), (3.9, 0.6, 2.1, 1.6)]
    f2_side = [(0, 0.65, 2.1, 1.5)]
    parts += kit.shell(W, W, FH2, T, f2z, {"front": f2_front})
    f2 = kit.faces_of(W, W, T, f2z)
    for (cx, oz, ow, oh) in f2_front:
        parts += kit.window(cx, oz, ow, oh, f2["front"][1], 0.0, T, mullions=1)
    parts += kit.framing(W, FH2, T, f2["front"][1], 0.0, posts=2, braces=False,
                         skip=[(-5.0, -2.8), (-1.1, 1.1), (2.8, 5.0)])
    for key in ("left", "right"):
        parts += kit.framing(W - 2 * T, FH2, T, f2[key][1], f2[key][2], posts=2,
                             braces=False, corner=False)

    # --- third floor, low and plain under the roof ------------------------
    f3z = f2z + FH2
    f3_front = [(-2.9, 0.5, 1.9, 1.3), (2.9, 0.5, 1.9, 1.3)]
    parts += kit.shell(W, W, FH3, T, f3z, {"front": f3_front})
    f3 = kit.faces_of(W, W, T, f3z)
    for (cx, oz, ow, oh) in f3_front:
        parts += kit.window(cx, oz, ow, oh, f3["front"][1], 0.0, T, mullions=0)
    parts += kit.framing(W, FH3, T, f3["front"][1], 0.0, posts=0, braces=False,
                         skip=[(-3.9, -1.9), (1.9, 3.9)])

    # --- roof ---------------------------------------------------
    rz = f3z + FH3
    parts += kit.gable_roof(W, W, ROOF_H, rz, eave=0.5, verge=0.4)
    for sx in (-1, 1):
        parts += kit.gable_frame(W, ROOF_H, rz, sx * (W / 2 + 0.06))
    parts += kit.chimney(0.0, -3.2, rz - 2.2, rz + ROOF_H + 1.3, w=1.35, pots=2)
    return kit.deliver(parts, "house_c")
