"""props -- the small things a town is furnished with. Sixteen assets plus the
barrel, each under 800 triangles and each with its origin at the base centre so
the viewer can drop it on the ground at (0, 0, 0).

Two of these have no base to sit on: hanging_sign and torch_sconce go on a wall.
They are modelled with the wall at y = 0 and the ironwork reaching out into -Y,
with the origin on the ground directly below the fixing -- so the same "put it
at the foot of the wall, facing -Y" rule places every asset in the library.

Everything is checked against a 1.75 m figure: the bench seat is at 450 mm, the
trough rim at 600, the well coping at 850, the market stall counter at 900, and
the lamp post's lantern is at 4.2 m so you walk under it, not into it.
"""

import math
import importlib

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
        objs.append(lib.box((thick * 0.55, 0.075, r * 0.82),
                            (x, y + r * 0.42 * math.cos(a), z + r * 0.42 * math.sin(a)),
                            (a, 0, 0), name="spoke", mat=mat))
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
    for i in range(n):
        a = math.pi * (i + 0.5) / n
        p.append(kit.timber((0.42, depth, r * math.pi / n * 1.12),
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
    p.append(lib.cone(0.11, 0.05, 0.26, (0, -0.31, z + 0.96), verts=10, name="head", mat="cloth"))
    return kit.deliver(p, "torch_sconce")


def build_chimney_pot():
    lib.reset()
    p = [kit.timber((0.42, 0.42, 0.16), (0, 0, 0.08), (0, 0, 0), "rooftile", 0.03, "flange"),
         lib.cylinder(0.16, 0.56, (0, 0, 0.44), verts=14, name="body", mat="rooftile"),
         lib.cone(0.22, 0.17, 0.16, (0, 0, 0.78), verts=14, name="rim", mat="rooftile"),
         lib.cylinder(0.13, 0.05, (0, 0, 0.84), verts=12, name="throat", mat="iron")]
    for o in p[1:3]:
        lib.shade_smooth(o)
    return kit.deliver(p, "chimney_pot")


ASSETS = [
    build_barrel, build_crate, build_sack, build_hay_bale, build_handcart,
    build_well, build_market_stall, build_lamp_post, build_hanging_sign,
    build_bench, build_trough, build_fountain, build_signpost,
    build_portcullis, build_stone_arch, build_torch_sconce, build_chimney_pot,
]


def build():
    return "\n".join(fn() for fn in ASSETS)
