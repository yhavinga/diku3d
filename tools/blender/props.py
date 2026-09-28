"""props -- the small things a town is furnished with, each under 800 triangles
and each with its origin at the base centre so the viewer can drop it on the
ground at (0, 0, 0).

Some of these have no base to sit on: hanging_sign and torch_sconce go on a
wall, and the ladder, broom, cartwheel and nettles lean on one. They are all
modelled with the wall at y = 0 and everything reaching out into -Y, with the
origin on the ground at the wall line -- so the same "put it at the foot of the
wall, facing -Y" rule places every asset in the library.

The second batch -- crates, barrels, firewood, planks, pots, rope, nettles --
exists because a review counted the shadows in a square and found none between
0.1 and 2 m. Nothing that size means nothing to break up a big flat pavement,
and a big flat pavement is what makes a square read as a texture rather than a
place. These are deliberately clustered, leaning and stacked rather than single
tidy objects: one barrel is a prop, three barrels and a chock is a corner
somebody uses.

Everything is checked against a 1.75 m figure: the bench seat is at 450 mm, the
trough rim at 600, the well coping at 850, the market stall counter at 900, and
the lamp post's lantern is at 4.2 m so you walk under it, not into it.
"""

import math
import importlib
import random

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)


# --- shared shapes --------------------------------------------------------

def ring_of(n, radius, size, z, height, mat="stonewall", cham=0.03, name="block"):
    """A circle of blocks, each turned to face out. Hollow, unlike a cylinder,
    which matters for anything you can look down into."""
    objs = []
    for i in range(n):
        a = 2 * math.pi * (i + 0.5) / n
        objs.append(kit.timber((size, radius * 2 * math.pi / n * 1.06, height),
                               (radius * math.cos(a), radius * math.sin(a), z),
                               (0, 0, a), mat, cham, name))
    return objs


def wheel(x, y, z, r=0.42, thick=0.14, spokes=6, mat="oak"):
    """Rim, hub and spokes. The rim is a low-vertex cylinder rather than a torus
    because a cart wheel seen from 3 m does not need to be round, it needs to
    have a hole in the middle you can see the street through."""
    objs = [lib.cylinder(r, thick, (x, y, z), (0, math.pi / 2, 0), verts=14,
                         name="rim", mat="iron"),
            lib.cylinder(r * 0.88, thick * 1.15, (x, y, z), (0, math.pi / 2, 0), verts=14,
                         name="felloe", mat=mat),
            lib.cylinder(r * 0.2, thick * 1.9, (x, y, z), (0, math.pi / 2, 0), verts=8,
                         name="hub", mat=mat)]
    for i in range(spokes):
        a = 2 * math.pi * i / spokes
        # a - pi/2, not a: Rx(t) sends +Z to (0, -sin t, cos t), so plain `a`
        # lays every spoke across its own radius instead of along it. Invisible
        # behind the handcart's solid felloe, and unmissable on the cartwheel.
        objs.append(lib.box((thick * 0.55, 0.075, r * 0.82),
                            (x, y + r * 0.42 * math.cos(a), z + r * 0.42 * math.sin(a)),
                            (a - math.pi / 2, 0, 0), name="spoke", mat=mat))
    return objs


# --- the assets -----------------------------------------------------------

def build_barrel():
    """The one that already worked, written down. Coopered staves, three hoops,
    a bulge in the middle -- a straight cylinder reads as a bin."""
    lib.reset()
    p = []
    r, rb = 0.27, 0.32
    for (z0, h, ra, rz) in ((0.0, 0.30, r, rb), (0.30, 0.28, rb, rb), (0.58, 0.30, rb, r)):
        p.append(kit.fluted_shaft(ra, rz, h, z0, flutes=9, depth=0.012, mat="planks",
                                  name="staves"))
    for hz, hr in ((0.07, 0.283), (0.44, 0.328), (0.81, 0.283)):
        p.append(lib.cylinder(hr + 0.018, 0.07, (0, 0, hz), verts=18, name="hoop", mat="iron"))
    p.append(lib.cylinder(r * 0.96, 0.05, (0, 0, 0.885), verts=18, name="lid", mat="planks"))
    return kit.deliver(p, "barrel")


def build_crate():
    lib.reset()
    w, h = 0.92, 0.86
    p = [kit.slab((w - 0.09, w - 0.09, h - 0.09), (0, 0, h / 2), mat="planks",
                  name="body", width=0.02)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(kit.timber((0.1, 0.1, h), (sx * (w / 2 - 0.05), sy * (w / 2 - 0.05), h / 2),
                                (0, 0, 0), "oak", 0.02, "post"))
    for z in (0.1, h - 0.1):
        for (sy, rot) in ((-1, 0.0), (1, 0.0)):
            p.append(kit.timber((w, 0.09, 0.11), (0, sy * (w / 2 - 0.04), z), (0, 0, rot),
                                "oak", 0.02, "rail"))
        for sx in (-1, 1):
            p.append(kit.timber((0.09, w - 0.2, 0.11), (sx * (w / 2 - 0.04), 0, z), (0, 0, 0),
                                "oak", 0.02, "rail"))
    # One diagonal on the front, which is what stops it reading as a cube.
    p.append(kit.timber((w * 1.25, 0.07, 0.1), (0, -w / 2 + 0.03, h / 2),
                        (0, math.radians(-42), 0), "oak", 0.02, "brace"))
    return kit.deliver(p, "crate")


def build_sack():
    lib.reset()
    p = []
    # Squat, not spherical: a full sack slumps under its own weight, and a
    # round one with a neck on top reads as a balloon.
    body = lib.sphere(0.33, (0, 0, 0.27), segments=12, rings=8, name="body", mat="cloth")
    body.scale = (1.0, 0.88, 0.8)
    lib.apply_modifiers(body)
    p.append(body)
    p.append(lib.cone(0.21, 0.12, 0.2, (0, 0, 0.5), verts=12, name="neck", mat="cloth"))
    p.append(lib.cylinder(0.125, 0.045, (0, 0, 0.585), verts=10, name="tie", mat="oak"))
    p.append(lib.cone(0.105, 0.03, 0.12, (0, 0, 0.65), verts=10, name="gather", mat="cloth"))
    for o in p:
        lib.shade_smooth(o)
    return kit.deliver(p, "sack")


def build_hay_bale():
    lib.reset()
    w, d, h = 1.15, 0.6, 0.55
    p = [kit.slab((w, d, h), (0, 0, h / 2), mat="thatch", name="bale", width=0.06)]
    for sx in (-0.28, 0.28):
        p.append(kit.timber((0.05, d + 0.06, h + 0.06), (sx * w, 0, h / 2), (0, 0, 0),
                            "oak", 0.012, "twine"))
        p.append(kit.timber((0.05, d + 0.06, 0.05), (sx * w, 0, h + 0.03), (0, 0, 0),
                            "oak", 0.012, "twine"))
    # Loose straw pushing out of the cut ends.
    for i in range(6):
        sx = -1 if i < 3 else 1
        p.append(kit.timber((0.22, 0.05, 0.05),
                            (sx * (w / 2 + 0.08), (i % 3 - 1) * 0.17, 0.12 + (i % 3) * 0.16),
                            (0, math.radians(12 * (i - 2)), math.radians(20 * (i % 3 - 1))),
                            "thatch", 0.01, "straw"))
    return kit.deliver(p, "hay_bale")


def build_handcart():
    lib.reset()
    p = []
    bed_z, bw, bl = 0.62, 0.95, 1.55
    p.append(kit.slab((bw, bl, 0.1), (0, 0, bed_z), mat="planks", name="bed", width=0.02))
    for sx in (-1, 1):
        p.append(kit.timber((0.08, bl, 0.42), (sx * (bw / 2 - 0.04), 0, bed_z + 0.24),
                            (0, 0, 0), "planks", 0.02, "side"))
    p.append(kit.timber((bw, 0.08, 0.42), (0, bl / 2 - 0.04, bed_z + 0.24), (0, 0, 0),
                        "planks", 0.02, "tail"))
    p.append(kit.timber((0.11, 0.11, bw + 0.34), (0, -0.12, bed_z - 0.09),
                        (0, math.pi / 2, 0), "iron", 0.02, "axle"))
    for sx in (-1, 1):
        p += wheel(sx * (bw / 2 + 0.1), -0.12, bed_z - 0.09, r=0.42, spokes=6)
        p.append(kit.timber((0.09, 1.5, 0.09), (sx * (bw / 2 - 0.12), -bl / 2 - 0.6, bed_z - 0.02),
                            (math.radians(7), 0, 0), "oak", 0.02, "shaft"))
    p.append(kit.timber((bw - 0.06, 0.08, 0.08), (0, -bl / 2 - 1.28, bed_z + 0.08),
                        (0, 0, 0), "oak", 0.02, "handle"))
    # The prop it stands on when nobody is pulling it.
    p.append(kit.timber((0.08, 0.08, 0.66), (0, -bl / 2 - 0.3, 0.33), (0, 0, 0),
                        "oak", 0.02, "leg"))
    return kit.deliver(p, "handcart")


def build_well():
    lib.reset()
    p = []
    r, h = 0.72, 0.82
    p += ring_of(12, r, 0.26, h / 2, h, mat="stonewall", cham=0.035, name="course")
    p.append(lib.cylinder(r + 0.16, 0.13, (0, 0, h + 0.06), verts=16, name="coping",
                          mat="stonewall"))
    p.append(lib.cylinder(r - 0.16, 0.05, (0, 0, 0.3), verts=14, name="water", mat="water"))
    for sx in (-1, 1):
        p.append(kit.timber((0.14, 0.14, 1.65), (sx * (r - 0.06), 0, h + 0.75), (0, 0, 0),
                            "oak", 0.025, "post"))
    p.append(kit.timber((2.0, 0.16, 0.16), (0, 0, h + 1.6), (0, 0, 0), "oak", 0.03, "beam"))
    p.append(lib.cylinder(0.11, 1.2, (0, 0, h + 1.24), (0, math.pi / 2, 0), verts=10,
                          name="windlass", mat="oak"))
    p.append(kit.timber((0.5, 0.07, 0.07), (r + 0.16, 0, h + 1.24), (0, 0, math.pi / 2),
                        "iron", 0.015, "crank"))
    p.append(kit.timber((0.07, 0.07, 0.3), (r + 0.38, 0, h + 1.1), (0, 0, 0), "iron", 0.015, "grip"))
    p.append(lib.cylinder(0.02, 0.62, (0, 0, h + 0.92), verts=6, name="rope", mat="cloth"))
    p.append(lib.cone(0.16, 0.19, 0.26, (0, 0, h + 0.72), verts=10, name="bucket", mat="planks"))
    # A pitched shingle roof on the two posts, so it has a silhouette.
    for sy in (-1, 1):
        p.append(kit.timber((2.1, 1.0, 0.08), (0, sy * 0.4, h + 1.86),
                            (-sy * math.radians(26), 0, 0), "planks", 0.02, "roof"))
    return kit.deliver(p, "well")


def build_market_stall():
    lib.reset()
    p = []
    w, d, ph = 2.6, 1.7, 2.15
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(kit.timber((0.1, 0.1, ph), (sx * (w / 2 - 0.05), sy * (d / 2 - 0.05), ph / 2),
                                (0, 0, 0), "oak", 0.02, "pole"))
    # Counter at 900, which is where a hand rests.
    p.append(kit.slab((w - 0.1, d * 0.62, 0.09), (0, -d * 0.16, 0.9), mat="planks",
                      name="counter", width=0.02))
    for sx in (-1, 1):
        p.append(kit.timber((0.09, d * 0.55, 0.86), (sx * (w / 2 - 0.28), -d * 0.16, 0.44),
                            (0, 0, 0), "oak", 0.02, "trestle"))
    p.append(kit.timber((w - 0.6, 0.08, 0.08), (0, -d * 0.16, 0.24), (0, 0, 0), "oak", 0.02, "stretcher"))
    # Canopy: a shallow ridge with a scalloped valance over the front.
    p.append(kit.timber((w + 0.5, 0.12, 0.12), (0, 0, ph + 0.42), (0, 0, 0), "oak", 0.025, "ridge"))
    for sy in (-1, 1):
        p.append(kit.timber((w + 0.5, d / 2 + 0.4, 0.06), (0, sy * (d / 4 + 0.16), ph + 0.24),
                            (-sy * math.radians(22), 0, 0), "cloth", 0.02, "canopy"))
    for i in range(7):
        px = -(w + 0.4) / 2 + (w + 0.4) * (i + 0.5) / 7
        p.append(kit.timber((0.28, 0.05, 0.2), (px, -d / 2 - 0.34, ph + 0.02),
                            (0, 0, 0), "cloth", 0.015, "valance"))
    # Something on the counter, or it reads as an empty table.
    for (gx, gr) in ((-0.75, 0.17), (0.05, 0.14), (0.78, 0.16)):
        p.append(lib.cone(gr, gr * 0.7, 0.24, (gx, -d * 0.16, 1.06), verts=8,
                          name="goods", mat="cloth"))
    return kit.deliver(p, "market_stall")


def build_lamp_post():
    lib.reset()
    p = []
    top = 4.2
    p.append(kit.slab((0.62, 0.62, 0.2), (0, 0, 0.1), mat="stonewall", name="base", width=0.03))
    p.append(kit.slab((0.46, 0.46, 0.16), (0, 0, 0.28), mat="stonewall", name="base2", width=0.03))
    p.append(lib.cone(0.13, 0.075, top - 0.9, (0, 0, 0.36 + (top - 0.9) / 2), verts=10,
                      name="shaft", mat="iron"))
    p.append(kit.timber((0.22, 0.22, 0.12), (0, 0, top - 0.52), (0, 0, 0), "iron", 0.02, "collar"))
    # Lantern: four corner bars, four panes, a capped roof and a finial.
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(kit.timber((0.045, 0.045, 0.56), (sx * 0.15, sy * 0.15, top - 0.18),
                                (0, 0, 0), "iron", 0.01, "bar"))
    for (dx, dy, rot) in ((0, -0.15, 0.0), (0, 0.15, 0.0), (-0.15, 0, math.pi / 2), (0.15, 0, math.pi / 2)):
        p.append(lib.box((0.3, 0.02, 0.52), (dx, dy, top - 0.18), (0, 0, rot),
                         name="pane", mat="glass"))
    p.append(lib.box((0.28, 0.28, 0.05), (0, 0, top - 0.48), name="floor", mat="iron"))
    p.append(lib.cone(0.28, 0.05, 0.26, (0, 0, top + 0.23), verts=8, name="cap", mat="iron"))
    p.append(kit.timber((0.05, 0.05, 0.2), (0, 0, top + 0.44), (0, 0, 0), "iron", 0.012, "finial"))
    # Bracket scrolls, so the shaft is not a bare pipe.
    for sx in (-1, 1):
        p.append(kit.timber((0.34, 0.05, 0.05), (sx * 0.19, 0, top - 0.72),
                            (0, math.radians(38), 0), "iron", 0.012, "scroll"))
    return kit.deliver(p, "lamp_post")


def build_hanging_sign():
    """Wall at y = 0, ironwork reaching out into -Y, origin on the ground under
    the fixing. Nothing here touches the floor."""
    lib.reset()
    p = []
    z = 3.4
    p.append(kit.timber((0.4, 0.14, 0.7), (0, 0.02, z + 0.05), (0, 0, 0), "iron", 0.02, "plate"))
    p.append(kit.timber((0.07, 1.35, 0.09), (0, -0.6, z + 0.3), (0, 0, 0), "iron", 0.02, "arm"))
    p.append(kit.timber((0.06, 0.9, 0.06), (0, -0.4, z - 0.02),
                        (math.radians(38), 0, 0), "iron", 0.015, "stay"))
    for i in range(3):
        p.append(kit.timber((0.04, 0.22, 0.04), (0, -0.22 - i * 0.16, z + 0.18 + i * 0.03),
                            (0, 0, math.radians(22 * (i + 1))), "iron", 0.01, "scroll"))
    for dy in (-0.32, -1.06):
        p.append(lib.cylinder(0.055, 0.03, (0, dy, z + 0.16), (math.pi / 2, 0, 0), verts=8,
                              name="ring", mat="iron"))
    p.append(kit.slab((0.06, 1.0, 0.72), (0, -0.69, z - 0.24), mat="planks",
                      name="board", width=0.02))
    for dy in (-0.21, -1.17):
        p.append(kit.timber((0.09, 0.06, 0.78), (0, dy, z - 0.24), (0, 0, 0), "oak", 0.015, "batten"))
    for dz in (-0.58, 0.1):
        p.append(kit.timber((0.09, 1.02, 0.06), (0, -0.69, z + dz), (0, 0, 0), "oak", 0.015, "batten"))
    return kit.deliver(p, "hanging_sign")


def build_bench():
    lib.reset()
    p = []
    L, seat = 1.85, 0.45
    p.append(kit.timber((L, 0.42, 0.07), (0, 0, seat), (0, 0, 0), "planks", 0.02, "seat"))
    for sx in (-1, 1):
        p.append(kit.timber((0.09, 0.4, seat), (sx * (L / 2 - 0.13), 0, seat / 2),
                            (0, 0, 0), "oak", 0.02, "leg"))
        p.append(kit.timber((0.08, 0.08, 0.56), (sx * (L / 2 - 0.13), 0.16, seat + 0.28),
                            (0, 0, 0), "oak", 0.02, "upright"))
    p.append(kit.timber((L - 0.1, 0.06, 0.14), (0, 0.17, seat + 0.5), (0, 0, 0),
                        "planks", 0.02, "back"))
    p.append(kit.timber((L - 0.1, 0.06, 0.12), (0, 0.16, seat + 0.28), (0, 0, 0),
                        "planks", 0.02, "back"))
    p.append(kit.timber((L - 0.4, 0.07, 0.07), (0, 0, 0.14), (0, 0, 0), "oak", 0.02, "stretcher"))
    return kit.deliver(p, "bench")


def build_trough():
    lib.reset()
    p = []
    L, W, H, t = 2.05, 0.82, 0.6, 0.13
    for sy in (-1, 1):
        p.append(kit.timber((L, t, H), (0, sy * (W / 2 - t / 2), H / 2), (0, 0, 0),
                            "stonewall", 0.035, "side"))
    for sx in (-1, 1):
        p.append(kit.timber((t, W - 2 * t, H), (sx * (L / 2 - t / 2), 0, H / 2), (0, 0, 0),
                            "stonewall", 0.035, "end"))
    p.append(kit.timber((L, W, 0.16), (0, 0, 0.08), (0, 0, 0), "stonewall", 0.04, "floor"))
    p.append(lib.box((L - 2 * t, W - 2 * t, 0.04), (0, 0, H - 0.11), name="water", mat="water"))
    # Feet, so it sits on the cobbles rather than sinking into them.
    for sx in (-1, 1):
        p.append(kit.timber((0.3, W + 0.08, 0.12), (sx * (L / 2 - 0.3), 0, 0.06), (0, 0, 0),
                            "stonewall", 0.03, "foot"))
    return kit.deliver(p, "trough")


def build_fountain():
    lib.reset()
    p = []
    r, wall = 1.2, 0.62
    p += ring_of(10, r - 0.14, 0.3, wall / 2, wall, mat="stonewall", cham=0.04, name="kerb")
    p.append(lib.cylinder(r + 0.05, 0.14, (0, 0, wall + 0.07), verts=14, name="coping",
                          mat="stonewall"))
    p.append(lib.cylinder(r - 0.3, 0.14, (0, 0, 0.07), verts=12, name="floor", mat="stonewall"))
    p.append(lib.cylinder(r - 0.29, 0.04, (0, 0, wall - 0.16), verts=12, name="water", mat="water"))
    # Pedestal and the upper bowl it spills from. Nothing at the exact centre of
    # a room -- but the fountain IS the centre of its own asset, so this one is
    # allowed to be, as long as the viewer keeps it off a room's midpoint.
    p.append(kit.timber((0.62, 0.62, 0.3), (0, 0, wall + 0.15), (0, 0, 0), "stonewall", 0.04, "plinth"))
    p.append(lib.cone(0.24, 0.17, 0.86, (0, 0, wall + 0.73), verts=12, name="stem", mat="stonewall"))
    p.append(lib.cone(0.56, 0.2, 0.26, (0, 0, wall + 1.29), verts=14, name="bowl", mat="stonewall"))
    p.append(lib.cylinder(0.5, 0.04, (0, 0, wall + 1.36), verts=14, name="water", mat="water"))
    p.append(lib.cone(0.14, 0.09, 0.34, (0, 0, wall + 1.6), verts=8, name="finial", mat="stonewall"))
    p.append(lib.sphere(0.11, (0, 0, wall + 1.83), segments=8, rings=5, name="ball",
                        mat="stonewall"))
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        p.append(lib.cylinder(0.045, 0.2, (0.5 * math.cos(a), 0.5 * math.sin(a), wall + 1.2),
                              (0, math.pi / 2, a), verts=6, name="spout", mat="iron"))
    return kit.deliver(p, "fountain")


def build_signpost():
    lib.reset()
    p = []
    top = 2.6
    p.append(kit.slab((0.5, 0.5, 0.22), (0, 0, 0.11), mat="stonewall", name="base", width=0.03))
    p.append(kit.timber((0.16, 0.16, top - 0.2), (0, 0, 0.2 + (top - 0.2) / 2), (0, 0, 0),
                        "oak", 0.025, "post"))
    for (z, rot, length) in ((top - 0.28, 0.0, 1.15), (top - 0.72, math.radians(105), 0.98),
                             (top - 1.12, math.radians(-118), 1.05)):
        # Pointed fingerboard: a plank plus a wedge for the tip. The wedge is
        # authored with its apex along +Z and its extrusion along Y, so laying
        # it flat wants Rx(-90) first and only then the board's own heading.
        px, py = math.cos(rot) * length / 2, math.sin(rot) * length / 2
        p.append(kit.timber((length, 0.06, 0.24), (px, py, z), (0, 0, rot), "planks", 0.02, "board"))
        p.append(lib.wedge(0.06, 0.22, 0.24, (px * 2, py * 2, z),
                           (-math.pi / 2, 0, rot - math.pi / 2), name="point", mat="planks"))
    p.append(lib.cone(0.15, 0.03, 0.24, (0, 0, top + 0.12), verts=8, name="cap", mat="oak"))
    return kit.deliver(p, "signpost")


def build_portcullis():
    """Sized to the world's 3.2 x 3.1 doorway, hanging with its spikes just
    clear of the ground so it reads as raised rather than shut."""
    lib.reset()
    p = []
    W, H, lift = 3.2, 3.1, 0.42
    bars = 7
    for i in range(bars):
        bx = -W / 2 + W * (i + 0.5) / bars
        p.append(kit.timber((0.11, 0.11, H - lift - 0.2), (bx, 0, lift + (H - lift - 0.2) / 2 + 0.2),
                            (0, 0, 0), "iron", 0.02, "bar"))
        p.append(lib.cone(0.09, 0.0, 0.3, (bx, 0, lift + 0.15), verts=6, rotation=(math.pi, 0, 0),
                          name="spike", mat="iron"))
    for z in (lift + 0.55, H * 0.55, H - 0.28):
        p.append(kit.timber((W, 0.14, 0.13), (0, 0, z), (0, 0, 0), "iron", 0.025, "rail"))
    for sx in (-1, 1):
        p.append(kit.timber((0.2, 0.32, H + 0.2), (sx * (W / 2 + 0.1), 0, (H + 0.2) / 2),
                            (0, 0, 0), "stonewall", 0.03, "channel"))
    return kit.deliver(p, "portcullis")


def build_door_leaf():
    """One leaf of a boarded door, hinge edge at x = 0 and the boards running
    to +X, so a pivot standing on the jamb swings it exactly the way the old
    flat panel swung. Reference size 1.35 wide by 2.85 tall -- half of the
    world's 2.7 m doorway -- and the viewer scales it to the opening it hangs
    in, so it is built lean and unornamented enough to survive stretching.

    It replaces a single untextured box the height of the whole opening, which
    a review metered at luminance 1.4 against a sky of 133 and called, fairly,
    a black rectangle: vertex colour on a bare material has nothing to catch
    the light with. Boards, ledges and straps are geometry, and MAT tags hand
    the surfaces to the viewer's baked planks and iron."""
    lib.reset()
    p = []
    W, H, boards, gap = 1.35, 2.85, 5, 0.012
    bw = (W - (boards - 1) * gap) / boards
    for i in range(boards):
        bx = bw / 2 + i * (bw + gap)
        # A few millimetres of face jitter, so the leaf is not one plane.
        jitter = ((i * 2654435761) % 7 - 3) * 0.002
        p.append(kit.timber((bw, 0.055, H), (bx, jitter, H / 2),
                            (0, 0, 0), "doorboard", 0.012, "board%d" % i))
    for z in (0.42, H / 2, H - 0.40):
        p.append(kit.timber((W - 0.06, 0.05, 0.17), (W / 2, 0.052, z),
                            (0, 0, 0), "oak", 0.012, "ledge"))
    # Strap hinges on the street side (-Y), running off the hinge edge, and a
    # knuckle over the pintle. Iron is what says this door is meant to hold.
    for z in (0.55, H - 0.55):
        p.append(kit.timber((0.98, 0.014, 0.085), (0.49, -0.04, z),
                            (0, 0, 0), "iron", 0.006, "strap"))
        p.append(lib.cylinder(0.034, 0.22, (0.015, -0.03, z), verts=10,
                              name="knuckle", mat="iron"))
    p.append(kit.timber((0.14, 0.012, 0.14), (W - 0.16, -0.037, H / 2 + 0.11),
                        (0, 0, 0), "iron", 0.005, "roseplate"))
    p.append(lib.torus(0.075, 0.013, (W - 0.16, -0.05, H / 2 - 0.01),
                       (math.pi / 2, 0, 0), major_seg=10, minor_seg=6,
                       name="ring", mat="iron"))
    return kit.deliver(p, "door_leaf")


def build_grate_leaf():
    """One leaf of an iron grate, hung exactly as `door_leaf` is: hinge edge at
    x = 0, running to +X, 1.35 by 2.85 reference, street side -Y. "Through the
    solid iron bars you see the Concourse" -- the graveyard's grate at #3600
    hung two boarded doors in the railing line, which read in the dark as a
    wooden wall standing on its own on the gravel. Bars you can see through
    are what the mud says, and they match the iron railing either side.

    Stiles and rails are flat bar, the bars are square and set diamond-wise so
    each catches a highlight down one arris, and they run through the top rail
    to spear points, the same finish as the railing's."""
    lib.reset()
    p = []
    W, H = 1.35, 2.85
    stile, rail = 0.07, 0.065
    for (sx, name) in ((stile / 2, "hinge_stile"), (W - stile / 2, "latch_stile")):
        p.append(kit.timber((stile, 0.045, H - 0.02), (sx, 0, (H - 0.02) / 2),
                            (0, 0, 0), "iron", 0.008, name))
    for z in (0.12, 1.05, H - 0.30):
        p.append(kit.timber((W - 2 * stile, 0.04, rail), (W / 2, 0, z),
                            (0, 0, 0), "iron", 0.008, "rail"))
    bars = 9
    span = W - 2 * stile
    for i in range(bars):
        bx = stile + span * (i + 0.5) / bars
        top = H - 0.12 + (0.06 if i % 2 else 0.0)
        p.append(lib.box((0.024, 0.024, top - 0.06), (bx, 0, 0.06 + (top - 0.06) / 2),
                         (0, 0, math.pi / 4), name="bar", mat="iron"))
        p.append(lib.cone(0.03, 0.0, 0.13, (bx, 0, top + 0.065), (0, 0, math.pi / 4),
                          verts=4, name="spear", mat="iron"))
    # Dog bars: short intermediate pickets at the foot, which every real
    # graveyard gate has so nothing small walks through.
    for i in range(bars - 1):
        bx = stile + span * (i + 1) / bars
        p.append(lib.box((0.018, 0.018, 0.5), (bx, 0, 0.36), (0, 0, math.pi / 4),
                         name="dogbar", mat="iron"))
    # Scrolls between the middle and top rails: a C each side, so the leaf
    # has one curve in it and is not a cage.
    for (cx, rot) in ((stile + 0.18, 0.0), (W - stile - 0.18, math.pi)):
        p.append(lib.torus(0.13, 0.012, (cx, 0, 1.4), (math.pi / 2, 0, rot),
                           major_seg=12, minor_seg=4, name="scroll", mat="iron"))
    # Lock box and ring on the street side of the latch stile.
    p.append(kit.timber((0.16, 0.06, 0.22), (W - 0.11, -0.05, 1.05),
                        (0, 0, 0), "iron", 0.01, "lockbox"))
    p.append(lib.torus(0.06, 0.011, (W - 0.11, -0.09, 0.93), (math.pi / 2, 0, 0),
                       major_seg=10, minor_seg=5, name="ring", mat="iron"))
    for z in (0.35, H - 0.55):
        p.append(lib.cylinder(0.03, 0.2, (0.0, 0, z), verts=10, name="knuckle", mat="iron"))
    return kit.deliver(p, "grate_leaf")


def build_stone_arch():
    """A 3.2 x 3.1 opening, which is the size of every doorway in the world, so
    this drops straight onto the archways layout.js leaves where an exit will
    not walk."""
    lib.reset()
    p = []
    W, H = 3.2, 3.1
    spring = 1.5
    r = W / 2
    depth = 0.85
    for sx in (-1, 1):
        px = sx * (W / 2 + 0.28)
        p.append(kit.timber((0.68, depth, 0.28), (px, 0, 0.14), (0, 0, 0), "stonewall", 0.04, "plinth"))
        p.append(kit.timber((0.56, depth - 0.12, spring - 0.44), (px, 0, 0.28 + (spring - 0.44) / 2),
                            (0, 0, 0), "stonewall", 0.045, "pier"))
        p.append(kit.timber((0.74, depth + 0.1, 0.22), (px, 0, spring - 0.05), (0, 0, 0),
                            "stonewall", 0.04, "impost"))
    # Voussoirs round the half-circle. The block's local X has to end up along
    # the radius, which is a rotation of a + pi about Y -- not pi/2 - a, which
    # is right at the springing and ninety degrees out at the crown, so the arch
    # comes out lumpy in a way that is hard to see until you look along it.
    n = 11
    ring_r = r + 0.21
    # The arc length has to be measured on the ring the blocks actually sit on,
    # not on the opening radius inside it. Using `r` made every voussoir 0.512 m
    # where the ring needs 0.517, and 11 blocks each 5 mm short leaves eleven
    # visible gaps with lit wall behind them -- which read, three times over, as
    # a fan of black plates floating in front of the gate rather than as an
    # arch. Measured on `ring_r` and lapped 8%, so they close under the chamfer.
    for i in range(n):
        a = math.pi * (i + 0.5) / n
        p.append(kit.timber((0.42, depth, ring_r * math.pi / n * 1.08),
                            (-math.cos(a) * ring_r, 0, spring + math.sin(a) * ring_r),
                            (0, a + math.pi, 0), "stonewall", 0.04, "voussoir"))
    p.append(kit.timber((0.5, depth + 0.14, 0.6), (0, 0, spring + r + 0.2), (0, 0, 0),
                        "stonewall", 0.05, "keystone"))
    return kit.deliver(p, "stone_arch")


def build_torch_sconce():
    """Wall at y = 0, reaching into -Y, origin on the ground below the fixing."""
    lib.reset()
    p = []
    z = 2.35
    p.append(kit.timber((0.24, 0.09, 0.42), (0, 0.01, z), (0, 0, 0), "iron", 0.015, "plate"))
    p.append(kit.timber((0.06, 0.34, 0.06), (0, -0.16, z + 0.1), (0, 0, 0), "iron", 0.015, "arm"))
    p.append(kit.timber((0.05, 0.26, 0.05), (0, -0.12, z - 0.06),
                        (math.radians(42), 0, 0), "iron", 0.012, "stay"))
    p.append(lib.cone(0.13, 0.09, 0.24, (0, -0.31, z + 0.24), verts=10, name="cup", mat="iron"))
    p.append(lib.cylinder(0.045, 0.62, (0, -0.31, z + 0.58), verts=8, name="haft", mat="oak"))
    # Pitch-dipped rags, not clean cloth: a review read the pale cream cone as
    # "the flame" and called the town fireless. Bark is the darkest organic
    # surface in the palette and reads as tarred wrapping at this size.
    p.append(lib.cone(0.11, 0.05, 0.26, (0, -0.31, z + 0.96), verts=10, name="head", mat="bark"))
    return kit.deliver(p, "torch_sconce")


def build_wall_lantern():
    """A shop's lantern: wall at y = 0, reaching into -Y, origin on the ground
    below the fixing, like the sconce. A glazed iron box on a short bracket,
    hung beside a shop sign so the painted board has something to be read by
    after dark -- a judge found every sign in town unreadable at night, with
    nothing lighting any of them. The panes are lantern glass, which the
    viewer lights after dark."""
    lib.reset()
    p = []
    z = 2.95
    p.append(kit.timber((0.16, 0.05, 0.30), (0, 0.0, z + 0.12), (0, 0, 0), "iron", 0.012, "plate"))
    p.append(kit.timber((0.035, 0.46, 0.035), (0, -0.23, z + 0.26), (0, 0, 0), "iron", 0.006, "arm"))
    p.append(kit.timber((0.03, 0.34, 0.03), (0, -0.14, z + 0.13),
                        (math.radians(-36), 0, 0), "iron", 0.006, "stay"))
    p.append(lib.torus(0.05, 0.008, (0, -0.1, z + 0.33), (0, math.pi / 2, 0),
                       major_seg=8, minor_seg=3, name="curl", mat="iron"))
    # The lantern hangs from the arm's end by a ring.
    ly, top = -0.40, z + 0.18
    p.append(lib.torus(0.028, 0.007, (0, ly, top + 0.06), (0, math.pi / 2, 0),
                       major_seg=6, minor_seg=3, name="ring", mat="iron"))
    p.append(lib.cone(0.14, 0.03, 0.10, (0, ly, top - 0.02), (0, 0, math.pi / 4),
                      verts=4, name="roof", mat="iron"))
    body = 0.30
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(lib.box((0.022, 0.022, body), (sx * 0.075, ly + sy * 0.075, top - 0.07 - body / 2),
                             name="post", mat="iron"))
    for (dx, dy, rot) in ((0, -0.075, 0.0), (0, 0.075, 0.0), (-0.075, 0, math.pi / 2), (0.075, 0, math.pi / 2)):
        p.append(lib.box((0.13, 0.01, body - 0.04), (dx, ly + dy, top - 0.07 - body / 2),
                         (0, 0, rot), name="pane", mat="glass"))
    p.append(lib.box((0.17, 0.17, 0.03), (0, ly, top - 0.085 - body), name="floor", mat="iron"))
    p.append(lib.cone(0.05, 0.0, 0.07, (0, ly, top - 0.135 - body), (math.pi, 0, 0),
                      verts=6, name="drop", mat="iron"))
    return kit.deliver(p, "wall_lantern")


def build_chimney_pot():
    lib.reset()
    p = [kit.timber((0.42, 0.42, 0.16), (0, 0, 0.08), (0, 0, 0), "rooftile", 0.03, "flange"),
         lib.cylinder(0.16, 0.56, (0, 0, 0.44), verts=14, name="body", mat="rooftile"),
         lib.cone(0.22, 0.17, 0.16, (0, 0, 0.78), verts=14, name="rim", mat="rooftile"),
         lib.cylinder(0.13, 0.05, (0, 0, 0.84), verts=12, name="throat", mat="iron")]
    for o in p[1:3]:
        lib.shade_smooth(o)
    return kit.deliver(p, "chimney_pot")


# --- street dressing, 0.1 to 2 m -----------------------------------------

def cask(r, h, cx=0.0, cy=0.0, cz=0.0, axis="z", sides=10, mat="planks",
         hoops=True, name="cask"):
    """A barrel as one lofted solid, with the hoops modelled as steps in the
    profile rather than as separate rings.

    Three rings of their own cost 200 triangles and buy a colour change nobody
    at three metres can see; a 20 mm step in the radius costs nothing extra and
    buys the same band of shadow, which is the part you actually read."""
    rb = r * 1.17
    prof = [(0.00, r), (0.06, r), (0.09, rb * 0.94), (0.32, rb),
            (0.68, rb), (0.91, rb * 0.94), (0.94, r), (1.00, r)]
    if not hoops:
        prof = [(0.0, r), (0.3, rb), (0.7, rb), (1.0, r)]
    sec = []
    for (t, rr) in prof:
        # the belly swells between the hoops; the ends are held down to r
        rad = rr + (rb - r) * 0.3 * math.sin(math.pi * t)
        # loft's cross-axes are (x, y) for a Z barrel and (x, z) for a Y one
        base, ca, cb = (cz, cx, cy) if axis == "z" else (cy, cx, cz)
        sec.append((base + t * h, rad, rad, ca, cb))
    return lib.loft(sec, sides=sides, axis=axis, name=name, mat=mat)


def build_stacked_crates():
    """Three crates, the top one turned and slid off centre. Square-on they are
    a wall; skewed they are a heap, and the gap between the top one and the two
    below is where the shadow gets in."""
    lib.reset()
    p = []
    for (cx, cy, cz, s, rot) in ((-0.26, 0.04, 0.0, 0.80, 0.06),
                                 (0.30, -0.08, 0.0, 0.72, -0.14),
                                 (-0.10, -0.02, 0.80, 0.66, 0.62)):
        p.append(kit.slab((s - 0.08, s - 0.08, s - 0.06), (cx, cy, cz + s / 2),
                          (0, 0, rot), mat="planks", name="crate", width=0.02))
        for sx in (-1, 1):
            for sy in (-1, 1):
                dx, dy = sx * (s / 2 - 0.05), sy * (s / 2 - 0.05)
                c, sn = math.cos(rot), math.sin(rot)
                p.append(kit.timber((0.09, 0.09, s), (cx + c * dx - sn * dy,
                                                      cy + sn * dx + c * dy, cz + s / 2),
                                    (0, 0, rot), "oak", 0.018, "post"))
        for hz in (0.12, s - 0.12):
            p.append(kit.timber((s, 0.08, 0.09),
                                (cx - math.sin(rot) * (s / 2 - 0.03),
                                 cy + math.cos(rot) * -(s / 2 - 0.03), cz + hz),
                                (0, 0, rot), "oak", 0.018, "rail"))
    return kit.deliver(p, "stacked_crates")


def build_barrel_stack():
    """Two standing, one on its side on chocks. The one lying down is the point:
    a horizontal cylinder at knee height is the only thing in the library that
    puts a curved shadow on the ground."""
    lib.reset()
    p = [cask(0.26, 0.86, -0.30, 0.30, 0.0),
         cask(0.26, 0.86, 0.30, 0.38, 0.0)]
    p.append(lib.loft([(0.86, 0.245, 0.245, -0.30, 0.30),
                       (0.91, 0.25, 0.25, -0.30, 0.30)], sides=10, name="lid", mat="oak"))
    # the one on its side lies in front of the pair, along Y and chocked. Behind
    # them it is invisible, and inside them it is a mess -- the point of it is
    # the curved shadow it puts on the ground where nothing else does.
    p.append(cask(0.235, 0.74, 0.0, -0.78, 0.40, axis="y", name="cask_down"))
    for cy in (-0.64, -0.18):
        p.append(kit.timber((0.44, 0.15, 0.17), (0.0, cy, 0.085), (0, 0, 0),
                            "oak", 0.03, "chock"))
    return kit.deliver(p, "barrel_stack")


def build_firewood_pile():
    """Split logs stacked between two stakes. Twenty-five end grains at 0.1 m
    each is exactly the frequency of detail a bare wall foot is missing."""
    lib.reset()
    p = []
    rows, per = 5, 4
    for r in range(rows):
        n = per - (1 if r == rows - 1 else 0)
        for i in range(n):
            rad = 0.075 + 0.022 * ((i * 7 + r * 3) % 4)
            p.append(lib.cylinder(rad, 0.95 + 0.06 * ((i + r) % 3),
                                  (0.0, -0.315 + 0.21 * i + 0.03 * (r % 2),
                                   0.09 + r * 0.175),
                                  (0, math.pi / 2, 0.04 * ((i * 5 + r) % 3 - 1)),
                                  verts=6, name="log", mat="bark"))
    for sx in (-1, 1):
        p.append(kit.timber((0.09, 0.09, 1.02), (sx * 0.54, 0.0, 0.51), (0, 0, 0),
                            "oak", 0.02, "stake"))
    return kit.deliver(p, "firewood_pile")


def build_water_butt():
    """A butt under a downpipe, on a stone pad, with a dipper hooked on the rim.
    The pad matters: standing water on a barrel end is what makes it read as
    used rather than delivered."""
    lib.reset()
    cy = -0.44                               # the wall is at y = 0, as ever
    p = [kit.slab((0.92, 0.92, 0.11), (0, cy, 0.055), mat="stonewall", name="pad", width=0.03),
         cask(0.31, 1.0, 0.0, cy, 0.11)]
    p.append(lib.loft([(1.06, 0.30, 0.30, 0, cy), (1.10, 0.315, 0.315, 0, cy)],
                      sides=10, name="water", mat="water"))
    p.append(kit.timber((0.13, 0.13, 1.62), (0.0, -0.09, 0.81), (0, 0, 0), "iron", 0.025, "downpipe"))
    p.append(kit.timber((0.1, 0.38, 0.1), (0.0, -0.24, 1.52),
                        (math.radians(52), 0, 0), "iron", 0.02, "swanneck"))
    # The dipper stands in the butt with its handle out over the rim, which is
    # where one is left. Floating it above the rim reads as a second bucket.
    p.append(lib.cone(0.11, 0.13, 0.2, (0.13, cy - 0.07, 1.0), verts=8, name="dipper",
                      mat="planks"))
    p.append(kit.timber((0.045, 0.42, 0.045), (0.13, cy - 0.17, 1.17),
                        (math.radians(-56), 0, 0), "oak", 0.01, "haft"))
    return kit.deliver(p, "water_butt")


def build_bucket():
    """250 mm across. It is the smallest thing in the library and it is here
    because a pavement needs something at the scale of a boot."""
    lib.reset()
    p = [lib.loft([(0.0, 0.105, 0.105, 0, 0), (0.02, 0.108, 0.108, 0, 0),
                   (0.20, 0.128, 0.128, 0, 0), (0.28, 0.134, 0.134, 0, 0),
                   (0.30, 0.126, 0.126, 0, 0)], sides=10, name="body", mat="planks")]
    p.append(lib.loft([(0.115, 0.132, 0.132, 0, 0), (0.155, 0.132, 0.132, 0, 0)],
                      sides=10, name="hoop", mat="iron"))
    p.append(lib.loft([(0.255, 0.121, 0.121, 0, 0), (0.275, 0.121, 0.121, 0, 0)],
                      sides=10, name="water", mat="water"))
    for sx in (-1, 1):
        p.append(kit.timber((0.03, 0.03, 0.26), (sx * 0.115, 0.0, 0.40),
                            (0, sx * math.radians(19), 0), "iron", 0.008, "bail"))
    p.append(kit.timber((0.2, 0.03, 0.03), (0, 0, 0.52), (0, 0, 0), "iron", 0.008, "bail"))
    return kit.deliver(p, "bucket")


def build_rope_coil():
    """Two turns of hawser dropped on the ground with a tail out of the middle.
    A torus is the one primitive with a hole in it, and the hole is the reason
    this reads as rope instead of a doughnut of mud."""
    lib.reset()
    p = [lib.torus(0.30, 0.048, (0, 0, 0.048), major_seg=14, minor_seg=5,
                   name="coil", mat="cloth"),
         lib.torus(0.26, 0.046, (0.03, -0.02, 0.132), major_seg=14, minor_seg=5,
                   name="coil", mat="cloth")]
    for (x, y, rot) in ((0.30, 0.09, 0.4), (0.46, 0.30, 1.1), (0.40, 0.56, 2.0)):
        p.append(lib.cylinder(0.046, 0.34, (x, y, 0.046), (math.pi / 2, 0, rot),
                              verts=6, name="tail", mat="cloth"))
    return kit.deliver(p, "rope_coil")


def build_ladder():
    """Leaning on the wall at y = 0 with its feet out at -0.93, following the
    same rule as the sconce and the sign. Nine rungs is nine isolated shadows
    down a blank wall, which is the cheapest relief in the library.

    The lean is -x about X, not +x: the other sign stands it on its head and
    drops the top into the street, which looks entirely reasonable in plan."""
    lib.reset()
    p = []
    lean = math.radians(15)                 # off vertical
    L, w = 3.6, 0.52
    foot = -math.sin(lean) * L
    for sx in (-1, 1):
        p.append(kit.timber((0.075, 0.11, L),
                            (sx * w / 2, foot / 2, math.cos(lean) * L / 2),
                            (-lean, 0, 0), "oak", 0.02, "stile"))
    for i in range(9):
        t = 0.16 + 0.42 * i
        p.append(lib.cylinder(0.028, w, (0, foot + math.sin(lean) * t, math.cos(lean) * t),
                              (0, math.pi / 2, 0), verts=6, name="rung", mat="oak"))
    return kit.deliver(p, "ladder")


def build_planks_pile():
    """Sawn boards on two bearers, the top three slid out of line. Stacked dead
    square they are a box; slid, the ends draw a little staircase of shadow."""
    lib.reset()
    p = []
    for sx in (-1, 1):
        p.append(kit.timber((0.16, 0.92, 0.12), (sx * 0.52, 0, 0.06), (0, 0, 0),
                            "oak", 0.02, "bearer"))
    for i in range(9):
        dx = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.09, -0.13, 0.16)[i]
        rot = (0, 0, 0, 0, 0, 0, 0.02, -0.03, 0.05)[i]
        p.append(kit.timber((1.34, 0.34, 0.055),
                            (dx, -0.19 + 0.38 * (i % 2), 0.15 + 0.062 * i),
                            (0, 0, rot), "planks", 0.012, "plank"))
    return kit.deliver(p, "planks_pile")


def build_herb_pots():
    """Three pots on the ground with something growing out of them. Not one pot:
    a single object on a pavement reads as placed, three read as kept."""
    lib.reset()
    p = []
    for (cx, cy, r, h) in ((-0.28, 0.06, 0.15, 0.26), (0.10, -0.14, 0.19, 0.32),
                           (0.34, 0.16, 0.13, 0.22)):
        p.append(lib.loft([(0.0, r * 0.68, r * 0.68, cx, cy),
                           (h * 0.82, r, r, cx, cy),
                           (h - 0.03, r * 1.1, r * 1.1, cx, cy),
                           (h, r * 1.1, r * 1.1, cx, cy)],
                          sides=8, name="pot", mat="rooftile"))
        p.append(lib.loft([(h - 0.05, r * 0.92, r * 0.92, cx, cy),
                           (h - 0.03, r * 0.92, r * 0.92, cx, cy)],
                          sides=8, name="soil", mat="bark"))
        for i in range(5):
            a = 2 * math.pi * i / 5 + cx
            p.append(kit.timber((0.045, 0.045, 0.3 + 0.06 * (i % 3)),
                                (cx + r * 0.45 * math.cos(a), cy + r * 0.45 * math.sin(a),
                                 h + 0.13),
                                (math.radians(20) * math.sin(a), math.radians(20) * math.cos(a), 0),
                                "leaves", 0.012, "stem"))
    return kit.deliver(p, "herb_pots")


def build_broom():
    """A besom stood against the wall at y = 0. A hundred triangles, and it is
    the single clearest signal in the library that a door belongs to somebody."""
    lib.reset()
    p = []
    lean = math.radians(12)
    L = 1.45
    foot = -0.34
    p.append(lib.cylinder(0.024, L, (0, foot + math.sin(lean) * L / 2, math.cos(lean) * L / 2),
                          (-lean, 0, 0), verts=6, name="haft", mat="oak"))
    p.append(lib.loft([(0.015, 0.05, 0.05, 0.0, foot - 0.01),
                       (0.15, 0.10, 0.10, 0.0, foot + 0.02),
                       (0.34, 0.078, 0.078, 0.0, foot + 0.06),
                       (0.44, 0.05, 0.05, 0.0, foot + 0.08)],
                      sides=8, name="head", mat="thatch"))
    p.append(lib.loft([(0.31, 0.085, 0.085, 0.0, foot + 0.055),
                       (0.35, 0.085, 0.085, 0.0, foot + 0.063)],
                      sides=8, name="binding", mat="cloth"))
    return kit.deliver(p, "broom")


def build_cartwheel():
    """A spare wheel leaning on the wall at y = 0. Same wheel as the handcart's,
    stood on edge and tipped nine degrees so it is resting rather than glued.

    kit.place() and not a loop over rotation_euler: the spokes are already
    turned, and reassigning their rotation lays every one of them flat."""
    lib.reset()
    r = 0.62
    p = [lib.torus(r - 0.035, 0.038, (0, 0, 0), (0, math.pi / 2, 0), 14, 4,
                   name="tyre", mat="iron"),
         lib.torus(r - 0.115, 0.08, (0, 0, 0), (0, math.pi / 2, 0), 14, 4,
                   name="felloe", mat="oak"),
         lib.cylinder(0.115, 0.26, (0, 0, 0), (0, math.pi / 2, 0), verts=8,
                      name="hub", mat="oak")]
    for i in range(8):
        a = 2 * math.pi * i / 8
        p.append(lib.box((0.09, 0.062, 0.40),
                         (0, 0.28 * math.cos(a), 0.28 * math.sin(a)),
                         (a - math.pi / 2, 0, 0), name="spoke", mat="oak"))
    kit.place(p, (0.0, -0.30, 0.63), (math.radians(-9), 0.0, math.pi / 2))
    p.append(kit.timber((0.34, 0.17, 0.1), (0.0, -0.38, 0.05), (0, 0, 0), "oak", 0.02, "chock"))
    return kit.deliver(p, "cartwheel")


def build_nettles():
    """A clump of weeds for the foot of a wall. Every one of these is a flat
    blade with a bend in it -- a wall that meets the ground on a clean line is
    the tell that nothing has ever grown there."""
    lib.reset()
    random.seed(4711)
    p = []
    for i in range(13):
        a = 2 * math.pi * i / 13 + 0.3
        d = 0.09 + 0.16 * random.random()
        h = 0.26 + 0.34 * random.random()
        p.append(kit.timber((0.075, 0.02, h),
                            (d * math.cos(a), -abs(d * math.sin(a)) * 0.7, h / 2),
                            (math.radians(26) * random.uniform(-1, 1),
                             math.radians(30) * random.uniform(-1, 1), a),
                            "leaves", 0.008, "blade"))
    for i in range(4):
        a = 1.1 * i
        p.append(kit.timber((0.03, 0.03, 0.5 + 0.1 * i),
                            (0.05 * math.cos(a), -0.05 * abs(math.sin(a)), 0.25 + 0.05 * i),
                            (0, math.radians(8) * (i - 1.5), 0), "grass", 0.008, "stem"))
    return kit.deliver(p, "nettles")


# --- the wet coast: a round door and a log cabin --------------------------

def chord_board(x0, x1, cx, cz, R, y0, y1, mat="planks", name="board"):
    """One vertical board of a round leaf, its top and bottom cut to the circle.

    Twelve triangles: a box whose four top corners and four bottom corners sit
    at the chord height of the circle at that board's own two edges. Nine of
    these inscribe an eighteen-sided polygon in the circle, which is 11 mm off
    a true 0.75 m radius at the worst edge midpoint and hides under the rim.

    The alternative -- rectangular boards trimmed at their centre x -- was tried
    on paper and is wrong both ways round: measured at the outer edge the two
    end boards come out zero high and vanish, and measured at the centre they
    stand 0.39 m proud of the circle and the leaf grows square shoulders. And a
    boolean is not available: openings here are the gaps between boxes."""
    h0 = max(0.02, math.sqrt(max(0.0, R * R - (x0 - cx) ** 2)))
    h1 = max(0.02, math.sqrt(max(0.0, R * R - (x1 - cx) ** 2)))
    verts = [(x0, y0, cz - h0), (x1, y0, cz - h1), (x1, y0, cz + h1), (x0, y0, cz + h0),
             (x0, y1, cz - h0), (x1, y1, cz - h1), (x1, y1, cz + h1), (x0, y1, cz + h0)]
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (3, 2, 6, 7),
             (0, 3, 7, 4), (1, 5, 6, 2)]
    mesh = lib.bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = lib.bpy.data.objects.new(name, mesh)
    lib.bpy.context.collection.objects.link(obj)
    return lib.assign(obj, mat)


def build_door_round():
    """A round door for the Shire, 1.5 m across, hung exactly the way
    `build_door_leaf` is hung.

    Everything the viewer relies on is shared with it deliberately: the hinge
    edge is x = 0, the leaf runs to +X, it stands from z = 0 with the boards in
    the y = 0 plane and every piece of iron on the street side at -Y. So the
    circle's centre is at (0.75, 0.75) and the hinge line is the tangent at its
    leftmost point -- which is also where a real round door's pintles go. The
    pivot that swings a boarded leaf swings this one.

    The one thing it does not share is proportion. `door_leaf` is 1.35 x 2.85
    and the viewer stretches it to whatever opening it finds; a circle stretched
    on two different scales is an ellipse, so this wants an opening as wide as
    it is tall."""
    lib.reset()
    p = []
    D = 1.5
    R, cx, cz = D / 2, D / 2, D / 2
    boards, gap = 9, 0.010
    bw = (D - (boards - 1) * gap) / boards
    for i in range(boards):
        x0 = i * (bw + gap)
        # The same few millimetres of face jitter the boarded leaf has, so the
        # planking is not one plane under a raking sun.
        jitter = ((i * 2654435761) % 7 - 3) * 0.002
        p.append(chord_board(x0, x0 + bw, cx, cz, R,
                             -0.028 + jitter, 0.028 + jitter,
                             mat="planks", name="board%d" % i))
    # Ledges on the inside face, cut short of the rim.
    for z in (cz - 0.33, cz + 0.33):
        p.append(kit.timber((1.24, 0.05, 0.16), (cx, 0.052, z), (0, 0, 0),
                            "oak", 0.012, "ledge"))
    # The rim. A torus with four minor segments is a bead standing 30 mm proud
    # of each face, and at twenty major segments it is the part of the leaf that
    # actually reads as round -- the boards behind it are an eighteen-gon.
    p.append(lib.torus(0.70, 0.058, (cx, 0.0, cz), (math.pi / 2, 0, 0),
                       major_seg=20, minor_seg=4, name="rim", mat="iron"))
    # Knob at the middle of the leaf, which is where Bag End's is. Lofted rather
    # than a UV sphere: 76 triangles against a sphere's hundred, and a sphere
    # spends its budget at the poles where nothing is looking.
    p.append(lib.loft([(-0.150, 0.022, 0.022, cx, cz), (-0.130, 0.052, 0.052, cx, cz),
                       (-0.100, 0.062, 0.062, cx, cz), (-0.070, 0.040, 0.040, cx, cz),
                       (-0.030, 0.030, 0.030, cx, cz)],
                      sides=8, axis="y", name="knob", mat="iron"))
    p.append(lib.cone(0.095, 0.08, 0.022, (cx, -0.038, cz), (math.pi / 2, 0, 0),
                      verts=10, name="rose", mat="iron"))
    # Straps and knuckles, on the street side and off the hinge edge. Set at
    # +-0.30 of centre rather than the boarded leaf's +-0.45: the leaf is only
    # 0.126 m short of the hinge line there, so barely a finger of strap hangs
    # in the air the way it does on every real round door.
    for z in (cz - 0.30, cz + 0.30):
        p.append(kit.timber((0.84, 0.014, 0.085), (0.44, -0.040, z),
                            (0, 0, 0), "iron", 0.006, "strap"))
        p.append(lib.cylinder(0.034, 0.20, (0.016, -0.030, z), verts=10,
                              name="knuckle", mat="iron"))
    return kit.deliver(p, "door_round")


def log_run(axis, a, b, across, z, r0, r1, verts=8, mat="bark", name="log"):
    """A round log lying along `axis` from `a` to `b`, at `across` on the other
    horizontal axis and `z` up.

    Logs are described by where they stop -- at the corner, at a jamb -- rather
    than by a length and a direction, because that is how a wall with an opening
    in it is written. `lib.cone` puts radius1 at its own -Z, and Rx(90) sends +Z
    to *-Y*, so the two radii swap over on the y runs."""
    length, mid = b - a, (a + b) / 2
    if axis == "x":
        return lib.cone(r0, r1, length, (mid, across, z), (0, math.pi / 2, 0),
                        verts=verts, name=name, mat=mat)
    return lib.cone(r1, r0, length, (across, mid, z), (math.pi / 2, 0, 0),
                    verts=verts, name=name, mat=mat)


def build_log_cabin():
    """A trapper's cabin for Haon Dor: 5.5 x 4.5 on the wall lines, stacked
    round logs crossing at the corners, a shake roof and two empty openings.

    Two decisions carry it.

    **The courses interleave, they do not alternate.** A wall where course 0 is
    the front pair and course 1 the side pair leaves a gap of a whole log
    between one front log and the next -- that is a chinked cabin, and the
    chinking is 150 mm of daylight we would then have to model. Scandinavian
    full-scribe instead: every wall gets a log every course, the two pairs offset
    half a course from each other, and the 25% they overlap at the corners is
    the saddle notch. Nothing has to be cut and nothing shows through.

    **The bottom course is hewn.** Offsetting the side walls half a course up
    leaves a 100 mm slot under them, which is a light leak the length of the
    building. Real cabins square their sills onto the foundation for exactly
    this reason, so four squared sills close it and give the whole thing a flat
    foot to stand on.

    The two openings are empty on purpose -- the viewer hangs its own leaf in
    the door -- and both are trimmed with jambs and a head, which is not
    decoration: a log cut off at an opening shows the viewer a cylinder's flat
    end cap on the reveal, and a wall of those reads as cardboard."""
    lib.reset()
    p = []
    W, D = 5.5, 4.5             # wall centrelines
    r, over = 0.15, 0.30        # log radius, and how far one runs past a corner
    sill_h, wall_top, rise = 0.20, 2.40, 1.70
    NX = NY = 9
    # The side walls have to finish level with the wall head (the roof lands on
    # them) and start half a course above the front and back, so the spacing
    # falls out of NY - 0.5 rather than NY - 1.
    course = (wall_top - 2 * r - sill_h) / (NY - 0.5)
    x_z = [sill_h + r + k * course for k in range(NX)]
    y_z = [sill_h + r + course / 2 + k * course for k in range(NY)]

    door_half, door_cut = 0.50, 0.60
    # The door and window heads are the *underside of the first whole log*, not
    # a round number: a course whose centre clears the opening still hangs its
    # bottom 150 mm into it, and trimming to 2.00 m exactly would have left a
    # log across the top of the doorway.
    door_top = x_z[8] - r                       # 1.988
    win_y, win_half, win_cut = 0.55, 0.30, 0.39
    win_z0, win_z1 = y_z[2] + r, y_z[6] - r     # 1.059 .. 1.653

    def wall(axis, across, half, zs, gap=None, band=None):
        """One face's worth of logs. `gap` is (lo, hi) along the wall's own
        axis and `band` the (z0, z1) it applies over: a course whose centre
        falls in that band comes out as two pieces with the opening between."""
        A, B = -half - over, half + over
        for i, z in enumerate(zs):
            # Butt to tip, course by course. A wall of logs all tapering the
            # same way leans; alternating them is why real ones do not.
            ra, rb = (r * 1.06, r * 0.94) if i % 2 else (r * 0.94, r * 1.06)
            spans = [(A, B)]
            if gap and band[0] <= z <= band[1]:
                spans = [(A, gap[0]), (gap[1], B)]
            for (a, b) in spans:
                fa, fb = (a - A) / (B - A), (b - A) / (B - A)
                p.append(log_run(axis, a, b, across, z,
                                 ra + (rb - ra) * fa, ra + (rb - ra) * fb))

    # Hewn sills. The front one is cut for the doorway like everything above it.
    for (sy, spans) in ((-1, [(-W / 2 - over, -door_cut), (door_cut, W / 2 + over)]),
                        (1, [(-W / 2 - over, W / 2 + over)])):
        for (a, b) in spans:
            p.append(kit.timber((b - a, 2 * r, sill_h), ((a + b) / 2, sy * D / 2, sill_h / 2),
                                (0, 0, 0), "bark", 0.03, "sill"))
    for sx in (-1, 1):
        p.append(kit.timber((2 * r, D - 2 * r, sill_h), (sx * W / 2, 0, sill_h / 2),
                            (0, 0, 0), "bark", 0.03, "sill"))

    # Walls. The door is in the front gable (-Y); the window in the +X flank.
    wall("x", -D / 2, W / 2, x_z, gap=(-door_cut, door_cut), band=(0.0, door_top))
    wall("x", D / 2, W / 2, x_z)
    wall("y", W / 2, D / 2, y_z, gap=(win_y - win_cut, win_y + win_cut),
         band=(win_z0, win_z1))
    wall("y", -W / 2, D / 2, y_z)

    # Gable logs: the front and back walls carried on up, each cut to the roof
    # line. Stop when one gets shorter than a notch is wide.
    k = NX
    while True:
        z = sill_h + r + k * course
        half_len = (W / 2 + r) * (1.0 - (z + r - wall_top) / rise)
        if half_len < 0.45:
            break
        for sy in (-1, 1):
            p.append(log_run("x", -half_len, half_len, sy * D / 2, z, r * 0.97, r * 0.97))
        k += 1

    # Roof. Ridge along Y over the gables, spanning X.
    apex = wall_top + rise
    run = W / 2 + r + 0.45                       # half span plus the eave
    eave_z = wall_top - rise * 0.45 / (W / 2 + r)
    slope = math.sqrt(run ** 2 + (apex - eave_z) ** 2)
    pitch = math.atan2(apex - eave_z, run)
    roof_len = D + 2 * 0.35
    cosp, sinp = math.cos(pitch), math.sin(pitch)
    for sx in (-1, 1):
        # Sheathing first. Shakes with gaps between them are a roof you can see
        # the sky through; laid over a continuous plane they are only relief.
        p.append(kit.timber((slope, roof_len, 0.06),
                            (sx * (slope / 2) * cosp, 0, apex - (slope / 2) * sinp),
                            (0, sx * pitch, 0), "planks", 0.02, "sheathing"))
        # Cedar shakes are long up the slope and narrow across -- 600 mm by 250
        # is the real article. The first cut was 5 courses of 4, which came out
        # 1.15 m by 1.30 and read as boards. Five by seven is 0.78 by 0.68, and
        # it is affordable only because a shake is a `lib.box` and not a
        # `kit.timber`: 12 triangles against 28, and the chamfer that buys the
        # difference would be 17 mm on something 50 mm thick. What reads on a
        # shake roof is the shadow under each lap, and that is the lap's doing.
        for i in range(5):
            s = slope * (i + 0.5) / 5
            # The upper course laps the one below it, so it stands further off
            # the sheathing -- which is the direction a shake roof is laid in.
            off = 0.045 + 0.012 * (4 - i)
            bx = sx * (s * cosp + off * sinp)
            bz = apex - s * sinp + off * cosp
            for j in range(7):
                by = -roof_len / 2 + roof_len * (j + 0.5) / 7 + (0.10 if i % 2 else -0.10)
                p.append(lib.box((slope / 5 + 0.16, roof_len / 7 - 0.06, 0.05),
                                 (bx, by, bz), (0, sx * pitch, 0),
                                 name="shake", mat="planks"))
        # Ridge cap.
        p.append(kit.timber((0.52, roof_len, 0.07),
                            (sx * (0.22 * cosp + 0.12 * sinp), 0,
                             apex - 0.22 * sinp + 0.12 * cosp),
                            (0, sx * pitch, 0), "planks", 0.02, "cap"))
    # Purlins, their ends out past the gables. A shake roof with nothing under
    # it at the verge is a lid; three pole ends say how it is held up.
    for px in (0.0, -1.45, 1.45):
        s = abs(px) / cosp
        p.append(log_run("y", -roof_len / 2 + 0.07, roof_len / 2 - 0.07, px,
                         apex - s * sinp - 0.14, 0.105, 0.105, name="purlin"))

    # Door and window linings. `planks` against the walls' `bark`, which is what
    # a sawn board next to a peeled log looks like.
    for sx in (-1, 1):
        # Off `door_half`, not off a number typed twice: the jamb's inner face
        # *is* the edge of the clear opening the viewer will hang a leaf in.
        p.append(kit.timber((0.10, 2 * r + 0.06, door_top),
                            (sx * (door_half + 0.05), -D / 2, door_top / 2),
                            (0, 0, 0), "planks", 0.02, "jamb"))
    p.append(kit.timber((1.40, 2 * r + 0.06, 0.14), (0, -D / 2, door_top + 0.07),
                        (0, 0, 0), "planks", 0.02, "lintel"))
    for sy in (-1, 1):
        p.append(kit.timber((2 * r + 0.06, 0.09, win_z1 - win_z0),
                            (W / 2, win_y + sy * (win_half + 0.045),
                             (win_z0 + win_z1) / 2),
                            (0, 0, 0), "planks", 0.02, "jamb"))
    for (z, h) in ((win_z0 - 0.05, 0.10), (win_z1 + 0.06, 0.12)):
        p.append(kit.timber((2 * r + 0.08, 0.78, h), (W / 2, win_y, z),
                            (0, 0, 0), "planks", 0.02, "winboard"))
    return kit.deliver(p, "log_cabin")


# --- the graveyard --------------------------------------------------------

# Stone here is `rock` and not `stonewall`, which is not a matter of taste:
# `stonewall` is a *coursed masonry* recipe -- dressed faces against mortar,
# with bed joints and perpends -- on a 3.6 m tile, so a 0.45 m headstone samples
# a fifth of one course and comes out with a mortar joint ruled across a stone
# that is supposed to have been carved out of one block. `rock` is
# structureless (cellular cracking over fbm), weathers grey-brown from 0x3f3d3a
# to 0x726d64 on a 5 m tile, and carries wet 0.25 -- damp collecting in the low
# patches, which is what stone standing out in the rain does.


def sunk_panel(outline, thick, recess, shrink=0.80, lift=0.075, mat="rock",
               name="stone"):
    """An outline in the XZ plane extruded along Y, with a shallow panel sunk
    into its front face.

    A recess cannot be booleaned -- openings here are the gaps between boxes --
    and building the panel's border out of four boxes costs 170 triangles and
    comes out crude wherever the border follows a curve. Stepping the extrusion
    instead is one closed solid and 8n-4: the front face is a ring between the
    outline and a copy of it scaled toward the middle, the ring's inner edge
    steps back by `recess`, and the panel floor caps it off.

    `shrink` and `lift` are one scale and one offset rather than a true polygon
    offset, chosen together so the margin comes out even: at 0.80 and 0.075 on
    a 0.45 x 0.75 stone it is 45 mm at the sides and 75 mm top and bottom.

    Winding is handed to bmesh. The solid is closed and manifold, so
    recalc_face_normals gets all five families of face right at once -- five
    chances not to have to reason about which way round a quad reads from -Y,
    and the arch's voussoirs are on record as what that costs when it is got
    wrong."""
    n = len(outline)
    fy, by = -thick / 2, thick / 2
    ry = fy + recess
    inner = [(x * shrink, lift + z * shrink) for (x, z) in outline]
    verts = ([(x, fy, z) for (x, z) in outline] +      # a: outline, front
             [(x, by, z) for (x, z) in outline] +      # b: outline, back
             [(x, fy, z) for (x, z) in inner] +        # c: panel edge, front
             [(x, ry, z) for (x, z) in inner])         # d: panel edge, sunk
    a, b, c, d = 0, n, 2 * n, 3 * n
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((a + i, a + j, b + j, b + i))     # the sides of the stone
        faces.append((a + i, c + i, c + j, a + j))     # the margin round it
        faces.append((c + i, d + i, d + j, c + j))     # the wall of the recess
    faces.append(tuple(range(b, b + n)))               # back
    faces.append(tuple(range(d, d + n)))               # panel floor
    mesh = lib.bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    bm = lib.bmesh.new()
    bm.from_mesh(mesh)
    lib.bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = lib.bpy.data.objects.new(name, mesh)
    lib.bpy.context.collection.objects.link(obj)
    return lib.assign(obj, mat)


def build_headstone():
    """One upright gravestone, 0.45 x 0.75 x 0.12, standing true.

    Modelled dead straight on purpose -- a leaning headstone is what makes a
    graveyard read, but a lean baked into the asset repeats identically across
    thirty of them, so the placement code owns it and this owns the stone."""
    lib.reset()
    W, H, T = 0.45, 0.75, 0.12
    # Shoulder low and the crown shallow: a segmental head, 150 mm of rise over
    # a 207 mm half-width. Carry the arc up from a half-height shoulder instead
    # and it is a round-topped Victorian marker rather than a gentle one.
    shoulder, base_half, head_half = 0.60, W / 2, 0.207
    outline = [(-base_half, 0.0), (base_half, 0.0), (head_half, shoulder)]
    arcs = 10
    for i in range(1, arcs):
        t = math.pi * i / arcs
        outline.append((head_half * math.cos(t),
                        shoulder + (H - shoulder) * math.sin(t)))
    outline.append((-head_half, shoulder))
    stone = sunk_panel(outline, T, 0.015, mat="rock", name="headstone")
    return kit.deliver([stone], "headstone")


def build_grave_slab():
    """A ledger stone, 1.8 x 0.7, lying 0.18 m off the ground on its own plinth.

    The plinth is inside the 0.18, not under it: a ledger stone is something you
    could trip over, and stacking a slab on top of a separate base takes it to
    knee height, which is a table tomb and a different thing entirely."""
    lib.reset()
    plinth = 0.06
    L, W, H = 1.80, 0.70, 0.18
    p = [kit.timber((L + 0.14, W + 0.14, plinth), (0, 0, plinth / 2), (0, 0, 0),
                    "rock", 0.02, "plinth"),
         # All twelve arrises taken off rather than the four `timber` would do:
         # this one is seen from above, where the short ends are in view.
         kit.slab((L, W, H - plinth), (0, 0, plinth + (H - plinth) / 2), (0, 0, 0),
                  mat="rock", name="ledger", width=0.035)]
    return kit.deliver(p, "grave_slab")


def build_iron_fence():
    """One railing panel, running +X from x = 0 to exactly x = 2.6.

    The chaining rule is the whole point of the numbers: both posts are set in
    by half their own width, so their *outer faces* land on x = 0 and x = 2.6
    and the rails finish flush with them. Repeat at a 2.600 m pitch and two
    panels meet post-face to post-face -- no gap, and no pair of coincident
    posts z-fighting the way they would if the posts were centred on the ends."""
    lib.reset()
    p = []
    RUN, H = 2.60, 1.10
    post, cap = 0.10, 0.10
    for px in (post / 2, RUN - post / 2):
        p.append(kit.timber((post, post, H - cap), (px, 0, (H - cap) / 2),
                            (0, 0, 0), "iron", 0.015, "post"))
        # A four-sided cone is a pyramid, but its base sits corner-on to the
        # axes, so it needs the eighth turn to square up with the post under it
        # -- and then its radius is a half-*diagonal*, so it has to be the
        # post's half-width times root two to come out flush. At a flat 0.75 of
        # the post it stood 3 mm proud at each end, which measured as a run of
        # 2.606 and chained with the finials lapping 6 mm into each other.
        p.append(lib.cone(post * math.sqrt(2) / 2, 0.0, cap, (px, 0, H - cap / 2),
                          (0, 0, math.pi / 4), verts=4, name="finial", mat="iron"))
    for z in (0.16, 0.86):
        p.append(kit.timber((RUN, 0.05, 0.07), (RUN / 2, 0, z), (0, 0, 0),
                            "iron", 0.012, "rail"))
    # Bars are plain boxes: 12 triangles against a chamfered timber's 28, and
    # the chamfer that buys the difference would be 9 mm on a 26 mm bar.
    bars = 11
    span = RUN - 2 * post
    for i in range(bars):
        bx = post + span * (i + 1) / (bars + 1)
        p.append(lib.box((0.026, 0.026, 0.95), (bx, 0, 0.525), name="bar", mat="iron"))
        p.append(lib.cone(0.024, 0.0, 0.10, (bx, 0, 1.05), (0, 0, math.pi / 4),
                          verts=4, name="spear", mat="iron"))
    return kit.deliver(p, "iron_fence")


ASSETS = [
    build_barrel, build_crate, build_sack, build_hay_bale, build_handcart,
    build_well, build_market_stall, build_lamp_post, build_hanging_sign,
    build_bench, build_trough, build_fountain, build_signpost, build_door_leaf,
    build_portcullis, build_stone_arch, build_torch_sconce, build_chimney_pot,
    build_stacked_crates, build_barrel_stack, build_firewood_pile,
    build_water_butt, build_bucket, build_rope_coil, build_ladder,
    build_planks_pile, build_herb_pots, build_broom, build_cartwheel,
    build_nettles, build_door_round, build_log_cabin,
    build_headstone, build_grave_slab, build_iron_fence, build_grate_leaf,
    build_wall_lantern,
]


def build():
    return "\n".join(fn() for fn in ASSETS)
