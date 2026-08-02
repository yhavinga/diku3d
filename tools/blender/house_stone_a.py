"""house_stone_a -- a squat two-storey stone house, 8 m to the eaves, with the
corners quoined and a chimney stack climbing the outside of the gable wall.

The problem with a stone house at this budget is that the wall is a flat box and
the coursing is all in the viewer's texture, so the only things that make it
read as masonry are the silhouette details: a battered plinth, a moulded string
course, quoins standing proud at the corners, deep window reveals with heavy
lintels, and a stack on the outside of the wall. Those get the triangles;
everything else is the box.

The walls are 340 mm thick precisely so the reveals are worth having: with the
casement on the inside face and the dressing 100 mm proud, every window is a
320 mm deep pocket, and at a low sun half of each one is black.
"""

import math
import importlib

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

W = 11.9
GH, UH = 3.9, 3.4
H = GH + UH             # 7.3 to the eaves; 8.0 counting the parapet detail
T = 0.34                # thick walls, so the reveals are deep
DOOR_W, DOOR_H = 3.2, 3.1
ROOF_H = 3.1


def quoins(w, d, z0, h, size=0.5, courses=7, proud=0.11, mat="stonewall"):
    """Alternating blocks up each corner, each one standing `proud` of the wall.
    Alternating is the whole point: a stack of identical blocks reads as a
    pilaster, and it is the long-face/short-face flip that says masonry."""
    objs = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for i in range(courses):
                long_x = i % 2 == 0
                a, b = (size * 1.7, size) if long_x else (size, size * 1.7)
                objs.append(kit.timber(
                    (a, b, h / courses * 0.84),
                    (sx * (w / 2 - a / 2 + proud), sy * (d / 2 - b / 2 + proud),
                     z0 + h * (i + 0.5) / courses),
                    (0, 0, 0), mat, 0.05, "quoin"))
    return objs


def build():
    lib.reset()
    parts = []

    # Battered plinth: two courses, the lower one wider, so the wall grows out
    # of the ground instead of being set on it.
    parts += kit.plinth(W, W, 0.0, 0.44, proud=0.1)

    z0 = 0.6
    g_front = [(0, 0, DOOR_W, DOOR_H), (-3.9, 1.3, 1.6, 1.7), (3.9, 1.3, 1.6, 1.7)]
    g_side = [(0, 1.4, 1.7, 1.6)]
    u_front = [(-3.9, 0.9, 1.6, 1.7), (0, 0.9, 1.9, 1.7), (3.9, 0.9, 1.6, 1.7)]
    u_side = [(0, 1.0, 1.7, 1.6)]

    parts += kit.shell(W, W, GH, T, z0, {"front": g_front, "left": g_side, "right": g_side},
                       mat="stonewall", name="stone")
    parts += kit.shell(W, W, UH, T, z0 + GH, {"front": u_front, "left": u_side},
                       mat="stonewall", name="stone")

    gf = kit.faces_of(W, W, T, z0)
    uf = kit.faces_of(W, W, T, z0 + GH)
    parts += kit.door(0, DOOR_W, DOOR_H, gf["front"][1], 0.0, T, frame="stonewall",
                      boards=5, arch=True, z0=z0)
    for (cx, oz, ow, oh) in g_front[1:]:
        parts += kit.window(cx, oz, ow, oh, gf["front"][1], 0.0, T, mat="stonewall",
                            mullions=1, sill_out=0.28, proud=0.1, shutters=True)
    for key in ("left", "right"):
        parts += kit.window(0, 1.4, 1.7, 1.6, gf[key][1], gf[key][2], T, mat="stonewall",
                            mullions=0, sill_out=0.28, proud=0.1)
    for (cx, oz, ow, oh) in u_front:
        parts += kit.window(cx, oz, ow, oh, uf["front"][1], 0.0, T, mat="stonewall",
                            mullions=1, sill_out=0.28, proud=0.1, hood=(cx == 0))
    parts += kit.window(0, 1.0, 1.7, 1.6, uf["left"][1], uf["left"][2], T, mat="stonewall",
                        mullions=0, sill_out=0.28, proud=0.1)

    # String course marking the floor line, all the way round.
    parts += kit.string_course(W, W, z0 + GH - 0.2, proud=0.24, height=0.28)

    parts += quoins(W, W, z0, GH + UH, size=0.55, courses=9)

    rz = z0 + GH + UH
    # A corbelled eaves course under the roof: the stone equivalent of a fascia,
    # and the thing that gives the top of the wall a shadow of its own before
    # the roof's is added to it.
    for sy in (-1, 1):
        for i in range(9):
            parts.append(kit.timber((0.4, 0.34, 0.24),
                                    (-W / 2 + W * (i + 0.5) / 9, sy * (W / 2 + 0.11), rz - 0.3),
                                    (0, 0, 0), "stonewall", 0.045, "corbel"))
    parts += kit.gable_roof(W, W, ROOF_H, rz, eave=0.58, verge=0.5, tympanum="stonewall",
                            trim="oak", rafters=9, caps=8, gutter=True)

    # The stack climbs the outside of the +X gable, which is the one thing a
    # stone house can do that a timber-framed one cannot. It steps back at the
    # eaves; a full-height slab of the same section reads as a buttress.
    # Kept inside the 13 m cell: the flank wall is at 5.95 and the roof verge at
    # 6.45, so the stack has to stop by 6.65 or it stands in next door's plot.
    sx0 = W / 2 - 0.13
    parts.append(kit.timber((1.4, 2.4, z0 + GH), (sx0, 0, (z0 + GH) / 2),
                            (0, 0, 0), "stonewall", 0.07, "breast"))
    parts.append(kit.timber((1.55, 2.6, 0.26), (sx0, 0, z0 + GH + 0.13),
                            (0, 0, 0), "stonewall", 0.06, "breast_set_off"))
    parts.append(kit.timber((1.2, 1.75, rz + ROOF_H - 0.4 - z0 - GH),
                            (sx0, 0, (z0 + GH + rz + ROOF_H - 0.4) / 2),
                            (0, 0, 0), "stonewall", 0.07, "stack"))
    parts += kit.chimney(sx0, 0, rz + ROOF_H - 0.4, rz + ROOF_H + 1.25, w=1.15, pots=2)

    # Somebody lives here: a lantern iron beside the door and a putlog beam left
    # in the wall from whoever built it.
    parts += kit.bracket((-2.3, -W / 2, z0), 0.0, reach=0.72, z=2.9)
    parts += kit.beam_end((2.1, -W / 2, z0 + GH), 0.0, z=UH - 0.9, out=0.44, size=0.2)
    return kit.deliver(parts, "house_stone_a")
