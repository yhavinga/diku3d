"""house_stone_b -- three storeys, crow-stepped gable to the street, buttresses
down the flanks. 10.7 m to the eaves.

Against house_stone_a this is the whole point of having two: a turned so the
gable faces the street, plus a stepped coping carried up past the roof, changes
the silhouette against the sky completely. Nothing else needs to differ, and at
twenty metres nothing else is legible anyway. Quoins are deliberately absent --
stone_a has them, and buttresses do the same job of breaking up a flat wall.

A crow gable is the one roof in the library with no verge overhang, because a
real one has none: the wall is carried up *past* the tiles and the coping is
what oversails. The steps stand 0.49 m clear of the wall plane, which is the
same job an eave does and a better silhouette.
"""

import math
import importlib

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

W = 11.9
T = 0.34
BASE = 0.62
GH, FH1, FH2 = 4.0, 3.2, 2.9
DOOR_W, DOOR_H = 3.2, 3.1
ROOF_H = 3.4


def buttress(x, y, height, sx=1, w=1.0, out=0.7, mat="stonewall"):
    """Two stages with a weathered set-off between them, standing off the flank
    at x in direction sx. The slope is what says buttress; a plain pier against
    a wall just reads as a mistake."""
    low = height * 0.62
    return [
        kit.timber((out, w, low), (x + sx * out / 2, y, low / 2),
                   (0, 0, 0), mat, 0.06, "buttress"),
        kit.timber((out * 0.62, w * 0.96, 0.32), (x + sx * out * 0.7, y, low + 0.14),
                   (0, -sx * math.radians(28), 0), mat, 0.05, "setoff"),
        kit.timber((out * 0.5, w * 0.8, height - low - 0.2),
                   (x + sx * out * 0.25, y, low + (height - low) / 2),
                   (0, 0, 0), mat, 0.06, "buttress2"),
    ]


def build():
    lib.reset()
    parts = []
    parts += kit.plinth(W, W, 0.0, 0.48, proud=0.1)

    g_front = [(0, 0, DOOR_W, DOOR_H), (-3.9, 1.4, 1.6, 1.7), (3.9, 1.4, 1.6, 1.7)]
    g_side = [(0, 1.5, 1.7, 1.6)]
    f1_front = [(-3.8, 0.8, 1.8, 1.8), (0, 0.8, 2.0, 1.8), (3.8, 0.8, 1.8, 1.8)]
    f1_side = [(0, 0.9, 1.7, 1.6)]
    f2_front = [(-2.9, 0.7, 1.7, 1.5), (2.9, 0.7, 1.7, 1.5)]

    z0, z1, z2 = BASE, BASE + GH, BASE + GH + FH1
    parts += kit.shell(W, W, GH, T, z0, {"front": g_front, "left": g_side, "right": g_side},
                       mat="stonewall", name="stone")
    parts += kit.shell(W, W, FH1, T, z1, {"front": f1_front, "right": f1_side},
                       mat="stonewall", name="stone")
    parts += kit.shell(W, W, FH2, T, z2, {"front": f2_front},
                       mat="stonewall", name="stone")

    gf, f1, f2 = (kit.faces_of(W, W, T, z) for z in (z0, z1, z2))
    parts += kit.door(0, DOOR_W, DOOR_H, gf["front"][1], 0.0, T, frame="stonewall",
                      boards=5, arch=True, z0=z0)
    for (cx, oz, ow, oh) in g_front[1:]:
        parts += kit.window(cx, oz, ow, oh, gf["front"][1], 0.0, T, mat="stonewall",
                            mullions=0, sill_out=0.28, proud=0.1, shutters=True)
    for key in ("left", "right"):
        parts += kit.window(0, 1.5, 1.7, 1.6, gf[key][1], gf[key][2], T, mat="stonewall",
                            mullions=0, sill_out=0.28, proud=0.1)
    for (cx, oz, ow, oh) in f1_front:
        parts += kit.window(cx, oz, ow, oh, f1["front"][1], 0.0, T, mat="stonewall",
                            mullions=1, sill_out=0.28, proud=0.1, shutters=(cx != 0),
                            hood=(cx == 0))
    parts += kit.window(0, 0.9, 1.7, 1.6, f1["right"][1], f1["right"][2], T,
                        mat="stonewall", mullions=0, sill_out=0.28, proud=0.1)
    for (cx, oz, ow, oh) in f2_front:
        parts += kit.window(cx, oz, ow, oh, f2["front"][1], 0.0, T, mat="stonewall",
                            mullions=0, sill_out=0.28, proud=0.1)

    # String courses at both floor lines, right round.
    for z in (z1 - 0.2, z2 - 0.2):
        parts += kit.string_course(W, W, z, proud=0.22, height=0.26, mould=False)

    # Buttresses on the flanks only: the gable ends carry the crow steps.
    for sx in (-1, 1):
        for by in (-3.2, 3.2):
            parts += buttress(sx * (W / 2 - 0.02), by, z2 + FH2 - 1.2, sx=sx)

    # Corbel table under the eaves on the flanks.
    for sx in (-1, 1):
        for i in range(8):
            py = -W / 2 + W * (i + 0.5) / 8
            parts.append(kit.timber((0.46, 0.32, 0.28),
                                    (sx * (W / 2 + 0.14), py, z2 + FH2 - 0.26),
                                    (0, 0, 0), "stonewall", 0.045, "corbel"))

    rz = z2 + FH2
    parts += kit.gable_roof(W, W, ROOF_H, rz, eave=0.5, verge=0.0, along="y",
                            tympanum=None, barge=False, trim="oak", rafters=8, caps=7)
    for sy in (-1, 1):
        parts += kit.crow_gable(W, ROOF_H, rz, sy * (W / 2 + 0.24), steps=7,
                                thick=0.5, along="y")
    parts += kit.chimney(-3.4, 3.0, rz - 1.6, rz + ROOF_H + 1.1, w=1.25, pots=2)

    # Somebody lives here: a hoist iron under the gable apex and a lantern arm.
    parts += kit.bracket((0, -W / 2 - 0.24, rz), 0.0, reach=1.0, z=ROOF_H * 0.52)
    parts += kit.beam_end((-2.4, -W / 2, z1), 0.0, z=FH1 - 0.8, out=0.42, size=0.22,
                          mat="stonewall")
    return kit.deliver(parts, "house_stone_b")
