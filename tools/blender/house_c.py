"""house_c -- the tall one. Four storeys, 12 m to the wall plate, and the only
one of the three that starts in stone: a masonry ground floor with a string
course, three timber floors jettied out over it, and a gable roof over four
storeys of banding.

What keeps it from reading as house_a stretched is the material break at the
string course -- stone below, timber above -- and the oriel: a bay hung off the
first floor on two corbels, projecting out over the street. A jerkinhead was
tried for the roof and thrown away; hipping the top of a gable properly means
cutting the main planes back, and faking it read as two flaps nailed on.

The oriel is also the one thing in the library that casts a shadow with a shape
to it. Everything else on a facade throws a straight line; this throws a box.
"""

import math
import importlib

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

W = 11.9
J1, J2 = 0.62, 0.55
F1W = W - 2 * J2
GW = F1W - 2 * J1
GH, FH1, FH2, FH3 = 4.0, 2.7, 2.6, 2.15
BAND = 0.34
T = 0.3
DOOR_W, DOOR_H = 3.2, 3.1
ROOF_H = 3.5


def oriel(z0, cx=0.0, w=3.0, h=2.0, out=0.95, wall_y=0.0):
    """A bay window hung off the wall face. Two corbels under it, a pent roof
    over it, and the only window on the house you can lean out of.

    It is worth the triangles because of what it does to the wall it is on: a
    metre of projection at a low sun lays a dark rectangle across two storeys,
    and no amount of texture will do that."""
    y = wall_y - out / 2
    objs = []
    # cheek walls, soffit and the sill band the whole box sits on
    for sx in (-1, 1):
        objs.append(kit.timber((0.18, out, h), (cx + sx * (w / 2 - 0.09), y, z0 + h / 2),
                               (0, 0, 0), "timber", 0.03, "oriel_cheek"))
    objs.append(kit.timber((w + 0.24, out + 0.16, 0.2), (cx, y - 0.05, z0 - 0.1),
                           (0, 0, 0), "oak", 0.04, "oriel_sill"))
    objs.append(lib.box((w, out, 0.14), (cx, y, z0 - 0.24), name="oriel_soffit", mat="timber"))
    front = (cx, wall_y - out, z0)
    objs += kit.panel(w, h, 0.18, [(0, 0.35, w - 0.8, h - 0.8)], "timber", front, 0.0, "oriel_face")
    objs += kit.window(0, 0.35, w - 0.8, h - 0.8, front, 0.0, 0.18, mullions=2,
                       sill_out=0.2, proud=0.07)
    # pent roof and the corbels that carry the whole thing
    objs.append(kit.timber((w + 0.5, out + 0.5, 0.16), (cx, y - 0.16, z0 + h + 0.16),
                           (math.radians(-22), 0, 0), "rooftile", 0.04, "oriel_roof"))
    objs.append(kit.timber((w + 0.5, 0.14, 0.22), (cx, wall_y - out - 0.34, z0 + h + 0.02),
                           (0, 0, 0), "oak", 0.03, "oriel_fascia"))
    for sx in (-1, 1):
        objs.append(kit.timber((0.24, out + 0.34, 0.86),
                               (cx + sx * (w / 2 - 0.16), y - 0.1, z0 - 0.66),
                               (math.radians(38), 0, 0), "oak", 0.035, "corbel"))
    return objs


def build():
    lib.reset()
    parts = []

    # --- masonry ground floor --------------------------------------------
    g_front = [(0, 0, DOOR_W, DOOR_H), (-3.4, 1.3, 1.7, 1.6), (3.4, 1.3, 1.7, 1.6)]
    g_side = [(0, 1.4, 1.8, 1.5)]
    parts += kit.shell(GW, GW, GH, T, 0.0, {"front": g_front, "left": g_side},
                       mat="stonewall", name="stone")
    gf = kit.faces_of(GW, GW, T, 0.0)
    parts += kit.plinth(GW, GW, 0.0, 0.52, proud=0.095)
    parts += kit.door(0, DOOR_W, DOOR_H, gf["front"][1], 0.0, T, frame="stonewall",
                      boards=4, arch=True, z0=0.52)
    for (cx, oz, ow, oh) in g_front[1:]:
        parts += kit.window(cx, oz, ow, oh, gf["front"][1], 0.0, T, mat="stonewall",
                            mullions=0, sill_out=0.26, proud=0.1)
    parts += kit.window(0, 1.4, 1.8, 1.5, gf["left"][1], gf["left"][2], T,
                        mat="stonewall", mullions=0, sill_out=0.26, proud=0.1)
    # string course: the line the timber sits on, carried right round
    parts += kit.string_course(GW, GW, GH - 0.2, proud=0.24, height=0.3,
                               mat="stonewall", sides=("front", "left", "right"))

    # --- first floor, with the oriel --------------------------------------
    parts += kit.jetty(GW, GW, GH, J1, size=0.32, joists=2, band=BAND,
                       braces=(-3.9, 3.9))
    f1z = GH + BAND
    f1_front = [(-3.9, 0.65, 1.9, 1.6), (3.9, 0.65, 1.9, 1.6)]
    parts += kit.shell(F1W, F1W, FH1, T, f1z, {"front": f1_front})
    f1 = kit.faces_of(F1W, F1W, T, f1z)
    for (cx, oz, ow, oh) in f1_front:
        parts += kit.window(cx, oz, ow, oh, f1["front"][1], 0.0, T, mullions=1, shutters=True)
    parts += oriel(f1z + 0.62, 0.0, 3.2, 1.85, 0.95, -F1W / 2 + T / 2)
    parts += kit.framing(F1W, FH1, T, f1["front"][1], 0.0, posts=2, braces=False,
                         skip=[(-5.1, -2.7), (-2.0, 2.0), (2.7, 5.1)])
    for key in ("left", "right"):
        parts += kit.framing(F1W - 2 * T, FH1, T, f1[key][1], f1[key][2], posts=1,
                             braces=False, corner=False)

    # --- second floor ------------------------------------------------------
    parts += kit.jetty(F1W, F1W, f1z + FH1, J2, size=0.32, joists=2, band=BAND,
                       braces=(-4.2, 0.0, 4.2))
    f2z = f1z + FH1 + BAND
    f2_front = [(-3.5, 0.6, 2.2, 1.6), (3.5, 0.6, 2.2, 1.6)]
    parts += kit.shell(W, W, FH2, T, f2z, {"front": f2_front})
    f2 = kit.faces_of(W, W, T, f2z)
    for (cx, oz, ow, oh) in f2_front:
        parts += kit.window(cx, oz, ow, oh, f2["front"][1], 0.0, T, mullions=1)
    parts += kit.framing(W, FH2, T, f2["front"][1], 0.0, posts=2, braces=False,
                         skip=[(-4.9, -2.1), (2.1, 4.9)])
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
                         skip=[(-4.1, -1.7), (1.7, 4.1)])
    parts += kit.string_course(W, W, f3z - 0.13, proud=0.15, height=0.22, mat="oak",
                               sides=("front", "left", "right"), mould=False)

    # --- roof ---------------------------------------------------
    rz = f3z + FH3
    parts += kit.gable_roof(W, W, ROOF_H, rz, eave=0.6, verge=0.58, rafters=7, caps=6)
    for sx in (-1, 1):
        parts += kit.gable_frame(W, ROOF_H, rz, sx * (W / 2 + 0.06))
    parts += kit.chimney(0.0, -3.2, rz - 2.2, rz + ROOF_H + 1.3, w=1.35, pots=2)

    # Somebody lives here: an iron tie-plate arm on the stone, and a beam end.
    # Both sit in the only gaps the openings leave -- the ground floor is free
    # only between 1.85 (the door surround) and 2.33 (the window dressing), and
    # the third floor only between the two windows at +/-1.73.
    parts += kit.bracket((-2.1, -GW / 2, 0.0), 0.0, reach=0.68, z=3.2)
    parts += kit.beam_end((0.0, -W / 2, f3z), 0.0, z=FH3 - 0.6, out=0.5)
    return kit.deliver(parts, "house_c")
